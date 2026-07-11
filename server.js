/**
 * Stremio Add-on: Hebrew AI Subtitles
 * ------------------------------------
 * Fetches English subtitles for any movie/episode (via Stremio's public
 * OpenSubtitles v3 service), translates them to Hebrew using Google Gemini
 * (with free Google Translate as automatic fallback), and serves them back
 * to Stremio. All subtitle timings are preserved exactly — only the text
 * lines are translated.
 *
 * Environment variables:
 *   GEMINI_API_KEY  - your free key from https://aistudio.google.com (recommended)
 *   GEMINI_MODEL    - optional, default "gemini-2.5-flash"
 *   PORT            - set automatically by Render
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 7000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const OPENSUBS_BASE = 'https://opensubtitles-v3.strem.io';
const CACHE_DIR = process.env.CACHE_DIR || '/tmp/hebsub-cache';
const BATCH_SIZE = 50; // subtitle cues per Gemini request

fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
const MANIFEST = {
  id: 'org.ari.hebrew.ai.subtitles',
  version: '1.0.0',
  name: 'Hebrew AI Subtitles',
  description:
    'כתוביות בעברית לכל סרט וסדרה: מוריד כתוביות באנגלית ומתרגם אותן לעברית עם AI, כולל שמירה מדויקת על התזמון. ' +
    'Fetches English subtitles and translates them to Hebrew with AI, preserving exact timing.',
  logo: 'https://em-content.zobj.net/source/twitter/376/israel_1f1ee-1f1f1.png',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: false, configurationRequired: false },
};

// ---------------------------------------------------------------------------
// SRT parsing / building (timings are never modified)
// ---------------------------------------------------------------------------
function parseSrt(raw) {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 2) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0].trim()) && lines.length > 1 && lines[1].includes('-->')) i = 1;
    if (!lines[i] || !lines[i].includes('-->')) continue;
    const timing = lines[i].trim();
    const textLines = lines.slice(i + 1);
    if (textLines.length === 0) continue;
    // Strip ASS/SSA formatting tags like {\an8} — players show them as literal text.
    const text = textLines.join('\n').replace(/\{\\[^}]*\}/g, '').trim();
    if (!text) continue;
    cues.push({ timing, text });
  }
  return cues;
}

// Wrap each line in an RTL embedding (U+202B ... U+202C) so punctuation at
// BOTH ends of the line renders on the correct side in Hebrew, even in
// players that lay subtitles out left-to-right.
const RLE = '‫';
const PDF = '‬';

function buildSrt(cues, texts) {
  const out = [];
  for (let i = 0; i < cues.length; i++) {
    const text = (texts[i] || cues[i].text).trim();
    out.push(String(i + 1));
    out.push(cues[i].timing);
    out.push(text.split('\n').map((l) => RLE + l.trim() + PDF).join('\n'));
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Translation: Gemini primary, Google Translate fallback
// ---------------------------------------------------------------------------
async function geminiTranslateBatch(lines, attempt = 0) {
  const prompt =
    'You are a professional subtitle translator. Translate the following English subtitle lines to natural, ' +
    'fluent Hebrew as spoken in Israel. Rules:\n' +
    '- Keep the SAME number of items, in the SAME order.\n' +
    '- Preserve any HTML-like tags (e.g. <i>, </i>) and line breaks (\\n) inside each item.\n' +
    "- Do NOT translate proper names; transliterate them naturally to Hebrew if appropriate.\n" +
    '- Match gender and register from context (this is dialogue from a movie/series).\n' +
    '- Keep translations concise enough to read as subtitles.\n' +
    'Return ONLY a JSON array of the translated strings, nothing else.\n\n' +
    'Input JSON array:\n' +
    JSON.stringify(lines);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 32768 },
    }),
  });

  if (res.status === 429 || res.status === 503) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 20000 * (attempt + 1)));
      return geminiTranslateBatch(lines, attempt + 1);
    }
    throw new Error(`Gemini rate-limited (${res.status})`);
  }
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  // Ignore "thought" parts emitted by thinking models — only keep real output.
  const parts = (data?.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought);
  let textOut = parts.map((p) => p.text || '').join('').trim();
  // Strip markdown code fences if present.
  textOut = textOut.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let arr;
  try {
    arr = JSON.parse(textOut);
  } catch {
    const m = textOut.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('Gemini returned non-JSON output');
    arr = JSON.parse(m[0]);
  }
  if (!Array.isArray(arr) || arr.length !== lines.length) {
    throw new Error(`Gemini returned ${Array.isArray(arr) ? arr.length : 'invalid'} items, expected ${lines.length}`);
  }
  const out = arr.map((s) => String(s));
  // Sanity check: the output must actually be Hebrew. If the model echoed the
  // English input (or answered in another language), treat it as a failure so
  // the caller falls back to Google Translate for this batch.
  const hebrewCount = out.filter((s) => /[֐-׿]/.test(s)).length;
  if (hebrewCount < out.length * 0.4) {
    throw new Error(`Gemini output not in Hebrew (${hebrewCount}/${out.length} lines contain Hebrew)`);
  }
  return out;
}

async function googleTranslateLine(line) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=iw&dt=t&q=' +
    encodeURIComponent(line);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Translate error ${res.status}`);
  const data = await res.json();
  return (data[0] || []).map((seg) => seg[0]).join('');
}

async function googleTranslateBatch(lines) {
  const out = [];
  for (const line of lines) {
    try {
      out.push(await googleTranslateLine(line));
    } catch {
      out.push(line); // worst case: keep English for this cue
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}

async function translateAll(cues, log) {
  const texts = cues.map((c) => c.text);
  const results = new Array(texts.length);
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    let translated;
    if (GEMINI_API_KEY) {
      try {
        translated = await geminiTranslateBatch(batch);
      } catch (e1) {
        log(`Gemini failed for batch at ${start} (${e1.message}); retrying once`);
        try {
          translated = await geminiTranslateBatch(batch);
        } catch (e2) {
          log(`Gemini retry failed for batch at ${start} (${e2.message}); falling back to Google Translate`);
          translated = await googleTranslateBatch(batch);
        }
      }
    } else {
      translated = await googleTranslateBatch(batch);
    }
    for (let i = 0; i < translated.length; i++) results[start + i] = translated[i];
    log(`translated ${Math.min(start + BATCH_SIZE, texts.length)}/${texts.length} cues`);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Fetch English subtitles from Stremio's public OpenSubtitles service
// ---------------------------------------------------------------------------
const candidatesCache = new Map(); // key -> { list, at }

async function fetchCandidateList(type, videoId, extra) {
  const url = `${OPENSUBS_BASE}/subtitles/${type}/${encodeURIComponent(videoId)}${extra ? '/' + extra : ''}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenSubtitles lookup failed (${res.status})`);
  const data = await res.json();
  return (data.subtitles || []).filter((s) => s.lang === 'eng');
}

async function getEnglishCandidates(type, videoId, extra = '') {
  const key = `${type}-${videoId}-${extra}`;
  const hit = candidatesCache.get(key);
  if (hit && Date.now() - hit.at < 3600000) return hit.list;

  // If Stremio told us the exact video file (videoHash), ask for subtitles
  // matched to that precise file first — those are perfectly in sync.
  let hashMatched = [];
  if (extra && extra.includes('videoHash=')) {
    try {
      hashMatched = await fetchCandidateList(type, videoId, extra);
    } catch {
      /* fall through to the general list */
    }
  }

  const general = await fetchCandidateList(type, videoId, '');
  // Prefer UTF-8 encoded entries in the general list
  general.sort((a, b) => (b.SubEncoding === 'UTF-8') - (a.SubEncoding === 'UTF-8'));

  // Hash-matched files first, then the rest (deduplicated).
  const seen = new Set(hashMatched.map((s) => s.id));
  const candidates = hashMatched.concat(general.filter((s) => !seen.has(s.id)));
  candidatesCache.set(key, { list: candidates, at: Date.now() });
  return candidates;
}

async function fetchEnglishSrt(type, videoId, variant = 0, extra = '') {
  const candidates = await getEnglishCandidates(type, videoId, extra);
  if (candidates.length === 0) throw new Error('No English subtitles found for this video');
  // Start from the requested variant, then rotate through the rest as fallback.
  const ordered = candidates.slice(variant % candidates.length).concat(candidates.slice(0, variant % candidates.length));
  let lastErr;
  for (const cand of ordered.slice(0, 3)) {
    try {
      const r = await fetch(cand.url);
      if (!r.ok) throw new Error(`download ${r.status}`);
      const srt = await r.text();
      const cues = parseSrt(srt);
      if (cues.length < 5) throw new Error('subtitle file looks empty/corrupt');
      return cues;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Could not download English subtitles: ${lastErr && lastErr.message}`);
}

// ---------------------------------------------------------------------------
// Translation jobs + cache
// ---------------------------------------------------------------------------
const jobs = new Map(); // cacheKey -> { status: 'working'|'error', error?, startedAt }

function hashTag(extra) {
  const m = /videoHash=([^&]+)/.exec(extra || '');
  return m ? `-h${m[1].slice(0, 12)}` : '';
}
function cacheKeyFor(type, videoId, variant = 0, extra = '') {
  return `${type}-${videoId}-v${variant}${hashTag(extra)}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}
function cachePathFor(key) {
  return path.join(CACHE_DIR, `${key}.he.srt`);
}

function ensureTranslation(type, videoId, variant = 0, extra = '') {
  const key = cacheKeyFor(type, videoId, variant, extra);
  if (fs.existsSync(cachePathFor(key))) return;
  const existing = jobs.get(key);
  if (existing && existing.status === 'working') return;
  // Re-attempt errored jobs after 2 minutes
  if (existing && existing.status === 'error' && Date.now() - existing.startedAt < 120000) return;

  jobs.set(key, { status: 'working', startedAt: Date.now() });
  const log = (msg) => console.log(`[${key}] ${msg}`);
  (async () => {
    log('starting translation job');
    const cues = await fetchEnglishSrt(type, videoId, variant, extra);
    log(`fetched English subtitles: ${cues.length} cues`);
    const translated = await translateAll(cues, log);
    const srt = buildSrt(cues, translated);
    fs.writeFileSync(cachePathFor(key), srt, 'utf8');
    jobs.delete(key);
    log('done — Hebrew subtitles cached');
  })().catch((e) => {
    console.error(`[${key}] FAILED: ${e.message}`);
    jobs.set(key, { status: 'error', error: e.message, startedAt: Date.now() });
  });
}

function placeholderSrt(message) {
  const lines = [];
  let n = 1;
  const fmt = (totalSec) => {
    const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    return `${h}:${m}:${s},000`;
  };
  for (let t = 0; t < 600; t += 15) {
    lines.push(String(n++));
    lines.push(`${fmt(t)} --> ${fmt(t + 8)}`);
    lines.push(message);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.headers.host}`;
}

app.get('/manifest.json', (req, res) => {
  res.json(MANIFEST);
});

async function handleSubtitlesRequest(req, res) {
  const { type, id } = req.params;
  if (!['movie', 'series'].includes(type) || !id.startsWith('tt')) {
    return res.json({ subtitles: [] });
  }
  // Stremio sends the exact video file's fingerprint (videoHash) — use it so
  // the first Hebrew option is translated from a perfectly-synced English file.
  const extra = req.params.extra && req.params.extra.includes('videoHash=') ? req.params.extra : '';
  ensureTranslation(type, id, 0, extra); // eagerly translate the first variant
  // Offer up to 3 Hebrew variants (each from a different English source file)
  // so the user can pick the one that matches their video's timing.
  let variants = 1;
  try {
    variants = Math.min(3, Math.max(1, (await getEnglishCandidates(type, id, extra)).length));
  } catch {
    /* fall back to a single entry */
  }
  const xq = extra ? `&x=${encodeURIComponent(extra)}` : '';
  const subtitles = [];
  for (let v = 0; v < variants; v++) {
    subtitles.push({
      id: `heb-ai-${cacheKeyFor(type, id, v, extra)}`,
      url: `${baseUrl(req)}/subfile/${type}/${encodeURIComponent(id)}/v${v}.srt?b=2${xq}`,
      lang: 'heb',
    });
  }
  res.json({ subtitles, cacheMaxAge: 3600 });
}

app.get('/subtitles/:type/:id.json', handleSubtitlesRequest);
app.get('/subtitles/:type/:id/:extra.json', handleSubtitlesRequest);

function handleSubfileRequest(req, res) {
  const { type, id } = req.params;
  const variant = parseInt(String(req.params.variant || '0').replace(/\D/g, ''), 10) || 0;
  const extra = typeof req.query.x === 'string' && req.query.x.includes('videoHash=') ? req.query.x : '';
  const key = cacheKeyFor(type, id, variant, extra);
  const file = cachePathFor(key);
  res.setHeader('Content-Type', 'text/srt; charset=utf-8');

  if (fs.existsSync(file)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(fs.readFileSync(file, 'utf8'));
  }

  ensureTranslation(type, id, variant, extra);
  const job = jobs.get(key);
  res.setHeader('Cache-Control', 'no-store');
  if (job && job.status === 'error') {
    return res.send(placeholderSrt(`שגיאה בתרגום: ${job.error} | Translation error`));
  }
  return res.send(
    placeholderSrt('התרגום לעברית בהכנה... בחרו שוב את הכתוביות בעוד כדקה | Translating to Hebrew, re-select subtitles in ~1 minute')
  );
}

app.get('/subfile/:type/:id/:variant.srt', handleSubfileRequest);
app.get('/subfile/:type/:id.srt', handleSubfileRequest);

app.get('/health', (req, res) => res.send('ok'));

app.get('/', (req, res) => {
  const manifestUrl = `${baseUrl(req)}/manifest.json`;
  const stremioLink = `stremio://${req.headers.host}/manifest.json`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hebrew AI Subtitles — Stremio Add-on</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;background:#0f0f23;color:#eee;line-height:1.6}
 h1{color:#7b5bf5} code{background:#1e1e3f;padding:2px 8px;border-radius:6px;direction:ltr;display:inline-block}
 a.btn{display:inline-block;background:#7b5bf5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin:8px 0}
 .en{direction:ltr;text-align:left;color:#aaa;font-size:.9em}
</style></head><body>
<h1>🇮🇱 כתוביות AI בעברית</h1>
<p>תוסף Stremio שמוריד כתוביות באנגלית ומתרגם אותן לעברית עם בינה מלאכותית, כולל שמירה מלאה על התזמון.</p>
<p><a class="btn" href="${stremioLink}">התקנה ב-Stremio</a></p>
<p>או הדביקו את הכתובת הזו בחיפוש התוספים של Stremio:</p>
<p><code>${manifestUrl}</code></p>
<p>רוצים לשתף עם חברים? פשוט שלחו להם את הקישור לעמוד הזה.</p>
<p class="en">Status: ${GEMINI_API_KEY ? 'Gemini AI translation enabled' : 'No GEMINI_API_KEY set — using Google Translate fallback'} · Model: ${GEMINI_MODEL}</p>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Hebrew AI Subtitles add-on running on port ${PORT}`);
  console.log(GEMINI_API_KEY ? `Gemini enabled (${GEMINI_MODEL})` : 'WARNING: GEMINI_API_KEY not set — Google Translate fallback only');
});
