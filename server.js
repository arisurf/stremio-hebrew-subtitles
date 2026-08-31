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
 *   GEMINI_API_KEY        - your free key from https://aistudio.google.com (recommended)
 *   GEMINI_MODEL          - optional, default "gemini-flash-latest"
 *   TRANSLATE_PROVIDER    - optional: "gemini" (default) or "anthropic"
 *   ANTHROPIC_API_KEY     - optional, enables Claude as the translation engine
 *   ANTHROPIC_MODEL       - optional, default "claude-haiku-4-5"
 *   TRANSLATE_CONCURRENCY - optional, parallel translation requests (default 4)
 *   PORT                  - set automatically by Render
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 7000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
// Optional persistent cache: completed translations are committed to a GitHub
// repo so they survive server restarts/redeploys (Render free disk is wiped).
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const CACHE_REPO = process.env.CACHE_REPO || 'arisurf/stremio-hebrew-subtitles';
const OPENSUBS_BASE = 'https://opensubtitles-v3.strem.io';
const CACHE_DIR = process.env.CACHE_DIR || '/tmp/hebsub-cache';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 80); // subtitle cues per AI request
const CONCURRENCY = Number(process.env.TRANSLATE_CONCURRENCY || 4); // parallel AI requests
const SUBFILE_HOLD_MS = Number(process.env.SUBFILE_HOLD_MS || 55000); // hold subtitle request open while translating (Render proxy limit ~100s)
const CONTEXT_LINES = 3; // English context lines shared across batch borders

fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
const MANIFEST = {
  id: 'org.ari.hebrew.ai.subtitles',
  version: '1.3.0',
  name: 'Ari4KD Hebrew AI Subtitles',
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
// Translation: provider-agnostic AI layer (Gemini default, Anthropic optional),
// Google Translate as last-resort fallback
// ---------------------------------------------------------------------------
const TRANSLATE_PROVIDER = (process.env.TRANSLATE_PROVIDER ||
  (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'gemini')).toLowerCase();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

function hasAiKey() {
  return TRANSLATE_PROVIDER === 'anthropic' ? !!ANTHROPIC_API_KEY : !!GEMINI_API_KEY;
}
function providerLabel() {
  return TRANSLATE_PROVIDER === 'anthropic' ? `Anthropic (${ANTHROPIC_MODEL})` : `Gemini (${GEMINI_MODEL})`;
}

// Single completion call, dispatched by provider. Retries rate limits.
async function llmComplete(prompt, maxTokens, attempt = 0) {
  if (TRANSLATE_PROVIDER === 'anthropic' && ANTHROPIC_API_KEY) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if ((res.status === 429 || res.status === 529) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 15000 * (attempt + 1)));
      return llmComplete(prompt, maxTokens, attempt + 1);
    }
    if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return (data.content || []).map((b) => b.text || '').join('').trim();
  }

  // Default: Gemini
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
    }),
  });
  if ((res.status === 429 || res.status === 503) && attempt < 2) {
    await new Promise((r) => setTimeout(r, 15000 * (attempt + 1)));
    return llmComplete(prompt, maxTokens, attempt + 1);
  }
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  // Ignore "thought" parts emitted by thinking models — only keep real output.
  const parts = (data?.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought);
  return parts.map((p) => p.text || '').join('').trim();
}

// Pre-pass: build a character guide (names, genders, relationships) from the
// full dialogue so every batch can translate Hebrew gender correctly even for
// characters who only appear elsewhere in the episode.
async function buildCharacterSheet(cues, log) {
  try {
    const sample = cues.map((c) => c.text.replace(/\n/g, ' ')).join('\n').slice(0, 9000);
    const sheet = await llmComplete(
      'Read this movie/series dialogue (subtitle lines in order). Identify the characters who speak or are addressed.\n' +
        'For each: name, gender (male/female/unknown), the natural Hebrew transliteration of the name, and a few words on who they are / how they relate to the others.\n' +
        'Also note the overall register (formal, slang, military, period drama, etc.).\n' +
        'Max 15 characters. Be concise. Plain text list only, no preamble.\n\n' +
        'Dialogue:\n' + sample,
      1024
    );
    if (sheet) log('character sheet ready');
    return sheet || '';
  } catch (e) {
    log(`character sheet failed (${e.message}) — translating without it`);
    return '';
  }
}

async function aiTranslateBatch(lines, sheet, contextBefore, contextAfter) {
  const prompt =
    'You are a professional subtitle translator. Translate the following English subtitle lines to natural, ' +
    'fluent Hebrew as spoken in Israel. Rules:\n' +
    '- Keep the SAME number of items, in the SAME order.\n' +
    '- Preserve any HTML-like tags (e.g. <i>, </i>) and line breaks (\\n) inside each item.\n' +
    '- Do NOT translate proper names; transliterate them naturally to Hebrew.\n' +
    '- Hebrew is a gendered language: use the character guide to inflect verbs, adjectives and pronouns for the correct gender of the SPEAKER, and when a line addresses someone, for the ADDRESSEE.\n' +
    '- Match register from context. Keep translations concise enough to read as subtitles.\n' +
    'Return ONLY a JSON array of the translated strings, nothing else.\n\n' +
    (sheet ? 'Character guide:\n' + sheet + '\n\n' : '') +
    (contextBefore.length ? 'Preceding dialogue (context only — do NOT include in output):\n' + JSON.stringify(contextBefore) + '\n\n' : '') +
    (contextAfter.length ? 'Following dialogue (context only — do NOT include in output):\n' + JSON.stringify(contextAfter) + '\n\n' : '') +
    'Input JSON array:\n' +
    JSON.stringify(lines);

  let textOut = await llmComplete(prompt, 32768);
  // Strip markdown code fences if present.
  textOut = textOut.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let arr;
  try {
    arr = JSON.parse(textOut);
  } catch {
    const m = textOut.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('model returned non-JSON output');
    arr = JSON.parse(m[0]);
  }
  if (!Array.isArray(arr) || arr.length !== lines.length) {
    throw new Error(`model returned ${Array.isArray(arr) ? arr.length : 'invalid'} items, expected ${lines.length}`);
  }
  const out = arr.map((s) => String(s));
  // Sanity check: the output must actually be Hebrew. If the model echoed the
  // English input (or answered in another language), treat it as a failure so
  // the batch is retried instead of shipping English lines.
  const hebrewCount = out.filter((s) => /[֐-׿]/.test(s)).length;
  if (hebrewCount < out.length * 0.4) {
    throw new Error(`output not in Hebrew (${hebrewCount}/${out.length} lines contain Hebrew)`);
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

// Run fn over items with at most `limit` in flight at once.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function translateAll(cues, log, onProgress) {
  const texts = cues.map((c) => c.text);
  const results = new Array(texts.length);

  if (!hasAiKey()) {
    log('no AI API key set — using Google Translate');
    const out = await googleTranslateBatch(texts);
    for (let i = 0; i < out.length; i++) results[i] = out[i];
    return results;
  }

  const sheet = await buildCharacterSheet(cues, log);

  // Split into batches, each carrying a few surrounding English lines so the
  // conversation doesn't get cut mid-exchange at batch borders.
  const batches = [];
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    batches.push({
      start,
      lines: texts.slice(start, start + BATCH_SIZE),
      before: texts.slice(Math.max(0, start - CONTEXT_LINES), start),
      after: texts.slice(start + BATCH_SIZE, start + BATCH_SIZE + CONTEXT_LINES),
    });
  }

  // Pass 1: all batches in parallel (bounded).
  let done = 0;
  const failed = [];
  await mapLimit(batches, CONCURRENCY, async (b) => {
    try {
      const out = await aiTranslateBatch(b.lines, sheet, b.before, b.after);
      for (let i = 0; i < out.length; i++) results[b.start + i] = out[i];
    } catch (e) {
      log(`batch at ${b.start} failed (${e.message}) — deferred for retry`);
      failed.push(b);
    }
    done++;
    log(`progress: ${done}/${batches.length} batches`);
    if (onProgress) onProgress(done, batches.length);
  });

  // Pass 2: deferred retry — rate-limit pressure is lower after the main wave.
  for (const b of failed.splice(0)) {
    try {
      await new Promise((r) => setTimeout(r, 5000));
      const out = await aiTranslateBatch(b.lines, sheet, b.before, b.after);
      for (let i = 0; i < out.length; i++) results[b.start + i] = out[i];
      log(`batch at ${b.start} recovered on retry`);
    } catch (e) {
      log(`batch at ${b.start} failed again (${e.message}) — Google Translate fallback`);
      const out = await googleTranslateBatch(b.lines);
      for (let i = 0; i < out.length; i++) results[b.start + i] = out[i];
    }
  }

  // Pass 3: sweep any line that still ended up non-Hebrew (e.g. Google
  // Translate per-line failures) and give them one more AI attempt together.
  const missing = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i] && !/[֐-׿]/.test(results[i]) && /[a-zA-Z]/.test(results[i])) missing.push(i);
  }
  if (missing.length > 0 && missing.length <= 150) {
    log(`re-translating ${missing.length} lines that stayed in English`);
    try {
      const out = await aiTranslateBatch(missing.map((i) => texts[i]), sheet, [], []);
      for (let j = 0; j < missing.length; j++) results[missing[j]] = out[j];
    } catch {
      /* keep whatever we have */
    }
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
  if (hit && Date.now() - hit.at < 3600000) return applySticky(type, videoId, hit.list);

  // If Stremio told us the exact video file (videoHash), ask for subtitles
  // matched to that precise file first — those are perfectly in sync.
  let hashMatched = [];
  if (extra && extra.includes('videoHash=')) {
    try {
      hashMatched = await fetchCandidateList(type, videoId, extra);
      hashMatched.forEach((s) => { s.hashMatch = true; });
    } catch {
      /* fall through to the general list */
    }
  }

  // Keep the upstream order — the service already ranks the best-matched
  // release first, and re-sorting was overriding that ranking.
  const general = await fetchCandidateList(type, videoId, '');

  // Hash-matched files first, then the rest (deduplicated).
  const seen = new Set(hashMatched.map((s) => s.id));
  const candidates = hashMatched.concat(general.filter((s) => !seen.has(s.id)));
  candidatesCache.set(key, { list: candidates, at: Date.now() });
  return applySticky(type, videoId, candidates);
}

// ---------------------------------------------------------------------------
// Timing signatures: probe each English source to learn when its subtitles
// end, so the user can match a variant against the episode's runtime, and so
// variants that agree with each other can be marked as cross-validated.
// ---------------------------------------------------------------------------
const sigCache = new Map(); // candidate id -> { sig: {first,last}|null, at }

function timeToSeconds(t) {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(t);
  if (!m) return null;
  return +m[1] * 3600 + +m[2] * 60 + +m[3];
}

function formatSeconds(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

async function timingSignature(cand) {
  const hit = sigCache.get(cand.id);
  if (hit && Date.now() - hit.at < 3600000) return hit.sig;
  let sig = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(cand.url, { signal: controller.signal });
    clearTimeout(timer);
    if (r.ok) {
      const cues = parseSrt(await r.text());
      if (cues.length >= 5) {
        const first = timeToSeconds(cues[0].timing.split('-->')[0]);
        const last = timeToSeconds(cues[cues.length - 1].timing.split('-->')[1] || cues[cues.length - 1].timing);
        if (first != null && last != null) sig = { first, last };
      }
    }
  } catch {
    /* signature unavailable — label will omit the time */
  }
  sigCache.set(cand.id, { sig, at: Date.now() });
  return sig;
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
      return { cues, cand };
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
// Stremio often asks for subtitles BEFORE it knows the video's fingerprint,
// then again WITH it seconds later — but the player may keep using the first
// response's URLs. Remember the latest fingerprint per video so every request
// is served the exact-matched (perfectly synced) file regardless of ordering.
const lastExtra = new Map(); // `${type}-${videoId}` -> { extra, at }
const LAST_EXTRA_TTL = 6 * 3600000;

function rememberedExtra(type, videoId) {
  const stored = lastExtra.get(`${type}-${videoId}`);
  return stored && Date.now() - stored.at < LAST_EXTRA_TTL ? stored.extra : '';
}

// Fingerprints must survive instance restarts (Render free churns instances
// constantly, and the player's request often lands on a freshly-woken server
// whose memory is empty — which served generic, unsynced files).
let extrasLoaded = false;
async function loadExtrasFromRemote() {
  if (!GITHUB_TOKEN || extrasLoaded) return;
  extrasLoaded = true;
  try {
    const r = await fetch(`https://api.github.com/repos/${CACHE_REPO}/contents/cache/extras.json`, {
      headers: { ...ghHeaders(), Accept: 'application/vnd.github.raw' },
    });
    if (!r.ok) return;
    const obj = JSON.parse(await r.text());
    for (const [k, v] of Object.entries(obj)) if (!lastExtra.has(k)) lastExtra.set(k, v);
    console.log(`[cache] loaded ${Object.keys(obj).length} fingerprints from GitHub`);
  } catch {
    /* non-fatal */
  }
}

let extrasSaveTimer = null;
function saveExtrasSoon() {
  if (!GITHUB_TOKEN) return;
  clearTimeout(extrasSaveTimer);
  extrasSaveTimer = setTimeout(async () => {
    try {
      const fresh = {};
      for (const [k, v] of lastExtra) if (Date.now() - v.at < LAST_EXTRA_TTL) fresh[k] = v;
      const apiUrl = `https://api.github.com/repos/${CACHE_REPO}/contents/cache/extras.json`;
      let sha;
      const g = await fetch(apiUrl, { headers: ghHeaders() });
      if (g.ok) sha = (await g.json()).sha;
      await fetch(apiUrl, {
        method: 'PUT',
        headers: ghHeaders(),
        body: JSON.stringify({
          message: 'cache: fingerprints',
          content: Buffer.from(JSON.stringify(fresh), 'utf8').toString('base64'),
          ...(sha ? { sha } : {}),
        }),
      });
      console.log('[cache] fingerprints saved to GitHub');
    } catch (e) {
      console.log(`[cache] fingerprints save error: ${e.message}`);
    }
  }, 3000);
}

// Let a hash-less subtitles request briefly wait for the fingerprint request
// that usually arrives a few seconds later, so its URLs are already correct.
const extraWaiters = new Map(); // key -> array of resolve callbacks
function waitForExtra(key, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const arr = extraWaiters.get(key) || [];
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
      resolve('');
    }, ms);
    const cb = (extra) => {
      clearTimeout(timer);
      resolve(extra);
    };
    const arr = extraWaiters.get(key) || [];
    arr.push(cb);
    extraWaiters.set(key, arr);
  });
}
function notifyExtra(key, extra) {
  (extraWaiters.get(key) || []).forEach((cb) => cb(extra));
  extraWaiters.delete(key);
}

// --- Sticky source per series -----------------------------------------------
// When the user manually picks a variant other than the first, remember WHICH
// source file worked for this series and put it first from then on. The
// fingerprint associations on OpenSubtitles are unreliable for anime releases,
// but the user's own choice is ground truth.
const stickyChoice = new Map(); // `${type}-${imdbBase}` -> { id, at }
const STICKY_TTL = 90 * 24 * 3600000;

function stickyKeyFor(type, videoId) {
  return `${type}-${String(videoId).split(':')[0]}`;
}
function stickyIdFor(type, videoId) {
  const s = stickyChoice.get(stickyKeyFor(type, videoId));
  return s && Date.now() - s.at < STICKY_TTL ? s.id : '';
}
function applySticky(type, videoId, list) {
  const sid = stickyIdFor(type, videoId);
  if (!sid) return list;
  const i = list.findIndex((c) => c.id === sid);
  if (i <= 0) return list;
  const out = list.slice();
  const [pick] = out.splice(i, 1);
  out.unshift(pick);
  return out;
}

let stickyLoaded = false;
async function loadStickyFromRemote() {
  if (!GITHUB_TOKEN || stickyLoaded) return;
  stickyLoaded = true;
  try {
    const r = await fetch(`https://api.github.com/repos/${CACHE_REPO}/contents/cache/sticky.json`, {
      headers: { ...ghHeaders(), Accept: 'application/vnd.github.raw' },
    });
    if (!r.ok) return;
    const obj = JSON.parse(await r.text());
    for (const [k, v] of Object.entries(obj)) if (!stickyChoice.has(k)) stickyChoice.set(k, v);
    console.log(`[cache] loaded ${Object.keys(obj).length} sticky choices from GitHub`);
  } catch {
    /* non-fatal */
  }
}

let stickySaveTimer = null;
function saveStickySoon() {
  if (!GITHUB_TOKEN) return;
  clearTimeout(stickySaveTimer);
  stickySaveTimer = setTimeout(async () => {
    try {
      const apiUrl = `https://api.github.com/repos/${CACHE_REPO}/contents/cache/sticky.json`;
      let sha;
      const g = await fetch(apiUrl, { headers: ghHeaders() });
      if (g.ok) sha = (await g.json()).sha;
      await fetch(apiUrl, {
        method: 'PUT',
        headers: ghHeaders(),
        body: JSON.stringify({
          message: 'cache: sticky choices',
          content: Buffer.from(JSON.stringify(Object.fromEntries(stickyChoice)), 'utf8').toString('base64'),
          ...(sha ? { sha } : {}),
        }),
      });
      console.log('[cache] sticky choices saved to GitHub');
    } catch (e) {
      console.log(`[cache] sticky save error: ${e.message}`);
    }
  }, 3000);
}

function hashTag(extra) {
  const m = /videoHash=([^&]+)/.exec(extra || '');
  return m ? `-h${m[1].slice(0, 12)}` : '';
}
function cacheKeyFor(type, videoId, variant = 0, extra = '') {
  const sid = stickyIdFor(type, videoId);
  return `${type}-${videoId}-v${variant}${hashTag(extra)}${sid ? '-p' + String(sid).slice(0, 8) : ''}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}
function cachePathFor(key) {
  return path.join(CACHE_DIR, `${key}.he.srt`);
}

// --- Persistent cache on GitHub (survives restarts and redeploys) ---------
function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    'User-Agent': 'ari4kd-hebrew-subs',
    Accept: 'application/vnd.github+json',
  };
}

async function loadFromRemoteCache(key) {
  if (!GITHUB_TOKEN) return null;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${CACHE_REPO}/contents/cache/${key}.he.srt`,
      { headers: { ...ghHeaders(), Accept: 'application/vnd.github.raw' } }
    );
    if (!r.ok) return null;
    const text = await r.text();
    if (text.length < 100) return null;
    fs.writeFileSync(cachePathFor(key), text, 'utf8');
    console.log(`[cache] loaded ${key} from GitHub`);
    return text;
  } catch {
    return null;
  }
}

async function saveToRemoteCache(key, content) {
  if (!GITHUB_TOKEN) return;
  try {
    const apiUrl = `https://api.github.com/repos/${CACHE_REPO}/contents/cache/${key}.he.srt`;
    let sha;
    const g = await fetch(apiUrl, { headers: ghHeaders() });
    if (g.ok) sha = (await g.json()).sha;
    const res = await fetch(apiUrl, {
      method: 'PUT',
      headers: ghHeaders(),
      body: JSON.stringify({
        message: `cache: ${key}`,
        content: Buffer.from(content, 'utf8').toString('base64'),
        ...(sha ? { sha } : {}),
      }),
    });
    console.log(res.ok ? `[cache] saved ${key} to GitHub` : `[cache] GitHub save failed (${res.status})`);
  } catch (e) {
    console.log(`[cache] GitHub save error: ${e.message}`);
  }
}

// Cache is keyed by the SOURCE English subtitle id whenever possible: the
// translated content depends only on the source file, so every path that
// resolves to the same source (any variant, fingerprint, or preference)
// reuses the same translation instead of re-translating.
function srcKeyFor(candId) {
  return `src-${candId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function resolveKey(type, videoId, variant, extra) {
  try {
    const list = await getEnglishCandidates(type, videoId, extra);
    if (list[variant]) return srcKeyFor(list[variant].id);
  } catch {
    /* fall back to the positional key */
  }
  return cacheKeyFor(type, videoId, variant, extra);
}

function ensureTranslation(type, videoId, variant = 0, extra = '', key = '') {
  if (!key) key = cacheKeyFor(type, videoId, variant, extra);
  if (fs.existsSync(cachePathFor(key))) return;
  const existing = jobs.get(key);
  if (existing && existing.status === 'working') return;
  // Re-attempt errored jobs after 2 minutes
  if (existing && existing.status === 'error' && Date.now() - existing.startedAt < 120000) return;

  jobs.set(key, { status: 'working', startedAt: Date.now() });
  const log = (msg) => console.log(`[${key}] ${msg}`);
  (async () => {
    // If a previous instance already translated this, reuse it from GitHub.
    if (await loadFromRemoteCache(key)) {
      jobs.delete(key);
      return;
    }
    log('starting translation job');
    const { cues, cand } = await fetchEnglishSrt(type, videoId, variant, extra);
    log(`fetched English subtitles: ${cues.length} cues`);
    const translated = await translateAll(cues, log, (done, total) => {
      const j = jobs.get(key);
      if (j && j.status === 'working') j.progress = { done, total, at: Date.now() };
    });
    // Identification cue: shown during the first seconds of playback so the
    // user knows which variant they picked and whether it is file-verified.
    const idLabel = `Ari4KD · גרסה ${variant + 1}${cand && cand.hashMatch ? ' · ✓ מסונכרן לקובץ' : ''}`;
    cues.unshift({ timing: '00:00:00,500 --> 00:00:05,000', text: idLabel });
    translated.unshift(idLabel);
    const srt = buildSrt(cues, translated);
    fs.writeFileSync(cachePathFor(key), srt, 'utf8');
    jobs.delete(key);
    log('done — Hebrew subtitles cached');
    await saveToRemoteCache(key, srt); // persist across restarts/redeploys
  })().catch((e) => {
    console.error(`[${key}] FAILED: ${e.message}`);
    jobs.set(key, { status: 'error', error: e.message, startedAt: Date.now() });
  });
}

// Hold a subtitle request open until the translation job finishes (or maxMs
// elapses). Stremio downloads the .srt exactly once per selection, so serving
// the real file inside that first response removes the "re-select" dance.
async function waitForTranslation(key, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(cachePathFor(key))) return 'done';
    const job = jobs.get(key);
    if (job && job.status === 'error') return 'error';
    await new Promise((r) => setTimeout(r, 1500));
  }
  return 'timeout';
}

// Human-readable ETA for the fallback placeholder, based on batch progress.
function etaText(job) {
  const p = job && job.progress;
  if (!p || !p.done) return '';
  const elapsed = (Date.now() - job.startedAt) / 1000;
  const remaining = Math.max(5, Math.round((elapsed / p.done) * (p.total - p.done)));
  return ` | ${p.done}/${p.total} הושלמו, עוד ~${remaining} שניות | ${p.done}/${p.total} done, ~${remaining}s left`;
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
  // Diagnostic: log every subtitle request so we can see exactly what
  // Stremio sends (videoHash / videoSize / filename presence).
  if (req.path.startsWith('/subtitles/') || req.path.startsWith('/subfile/')) {
    console.log(`[request] ${req.originalUrl}`);
  }
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
  await loadExtrasFromRemote();
  await loadStickyFromRemote();
  let extra = req.params.extra && req.params.extra.includes('videoHash=') ? req.params.extra : '';
  const exKey = `${type}-${id}`;
  if (extra) {
    lastExtra.set(exKey, { extra, at: Date.now() });
    saveExtrasSoon();
    notifyExtra(exKey, extra);
  } else {
    extra = rememberedExtra(type, id); // hash arrived on an earlier request
    if (!extra) extra = await waitForExtra(exKey, 8000); // it usually arrives seconds later
    if (!extra) extra = rememberedExtra(type, id);
  }
  // Only translate eagerly once the fingerprint is known — translating the
  // hash-less request that arrives first produced unsynced "variant 1" files.
  // Without a fingerprint, translation starts when the user selects the sub.
  if (extra) {
    resolveKey(type, id, 0, extra).then((k) => ensureTranslation(type, id, 0, extra, k));
  }

  // Offer up to 3 Hebrew variants (each from a different English source file),
  // labeled with a timing validation so the user can pick the right one:
  //  - "מסונכרן" = matched to the exact video file by fingerprint (certain)
  //  - the end-time (e.g. 23:20) = compare with the episode length in the player
  //  - "✓" = at least two independent sources agree on this timing
  let cands = [];
  try {
    cands = (await getEnglishCandidates(type, id, extra)).slice(0, 3);
  } catch {
    /* fall back to a single entry */
  }
  const variants = Math.max(1, cands.length);

  // All entries use lang "heb" so they group under the Hebrew language
  // category in Stremio (per-variant custom labels are not supported by the
  // subtitles object — only id/url/lang). Each file identifies itself with an
  // "Ari4KD · גרסה N" cue during the first seconds of playback, including a
  // "✓ מסונכרן לקובץ" marker when it was matched to the exact video file.
  const xq = extra ? `&x=${encodeURIComponent(extra)}` : '';
  const subtitles = [];
  for (let v = 0; v < variants; v++) {
    subtitles.push({
      id: `heb-ai-${cacheKeyFor(type, id, v, extra)}`,
      url: `${baseUrl(req)}/subfile/${type}/${encodeURIComponent(id)}/v${v}.srt?b=5${xq}`,
      lang: 'heb',
    });
  }
  res.json({ subtitles, cacheMaxAge: 3600 });
}

app.get('/subtitles/:type/:id.json', handleSubtitlesRequest);
app.get('/subtitles/:type/:id/:extra.json', handleSubtitlesRequest);

async function handleSubfileRequest(req, res) {
  const { type, id } = req.params;
  const variant = parseInt(String(req.params.variant || '0').replace(/\D/g, ''), 10) || 0;
  await loadExtrasFromRemote();
  await loadStickyFromRemote();
  let extra = typeof req.query.x === 'string' && req.query.x.includes('videoHash=') ? req.query.x : '';
  if (!extra) extra = rememberedExtra(type, id); // fall back to the remembered fingerprint
  if (!extra) extra = await waitForExtra(`${type}-${id}`, 5000); // fingerprint may arrive any second

  // Picking a non-first variant is a deliberate user choice: remember which
  // SOURCE that is and put it first for every future episode of this series.
  if (variant > 0) {
    getEnglishCandidates(type, id, extra)
      .then((list) => {
        const cand = list[variant];
        if (cand && stickyIdFor(type, id) !== cand.id) {
          stickyChoice.set(stickyKeyFor(type, id), { id: cand.id, at: Date.now() });
          saveStickySoon();
          console.log(`[sticky] ${stickyKeyFor(type, id)} -> source ${cand.id} (was variant ${variant + 1})`);
        }
      })
      .catch(() => {});
  }
  const key = await resolveKey(type, id, variant, extra);
  const file = cachePathFor(key);
  res.setHeader('Content-Type', 'text/srt; charset=utf-8');

  // Short client cache so a re-selected variant picks up corrected files
  // (e.g. right after the fingerprint registers) instead of a stale copy.
  if (fs.existsSync(file)) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(fs.readFileSync(file, 'utf8'));
  }

  // Not on local disk — maybe a previous server instance translated it.
  const remote = await loadFromRemoteCache(key);
  if (remote) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(remote);
  }

  ensureTranslation(type, id, variant, extra, key);

  // Hold the request open so the player receives the real Hebrew file in this
  // same response — no re-select needed. Render's proxy allows ~100s, so a
  // 55s hold is safe; most jobs finish well within it.
  const outcome = await waitForTranslation(key, SUBFILE_HOLD_MS);
  if (outcome === 'done') {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(fs.readFileSync(cachePathFor(key), 'utf8'));
  }

  const job = jobs.get(key);
  res.setHeader('Cache-Control', 'no-store');
  if (outcome === 'error' || (job && job.status === 'error')) {
    return res.send(placeholderSrt(`שגיאה בתרגום: ${job && job.error} | Translation error`));
  }
  return res.send(
    placeholderSrt(
      `התרגום לעברית עדיין בהכנה — בחרו שוב את הכתוביות${etaText(job)} | Still translating — re-select subtitles`
    )
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
<p class="en">Status: ${hasAiKey() ? 'AI translation enabled' : 'No AI API key set — using Google Translate fallback'} · Engine: ${providerLabel()}</p>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Hebrew AI Subtitles add-on running on port ${PORT}`);
  console.log(hasAiKey() ? `AI translation enabled: ${providerLabel()}` : 'WARNING: no AI API key set — Google Translate fallback only');
});

// Keep-alive: Render's free tier spins the instance down after ~15 min idle,
// causing 50s+ cold starts right when subtitles are requested. Ping ourselves
// so the instance stays warm (one always-on free service fits Render's 750
// free instance-hours per month).
const SELF_URL = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
if (SELF_URL) {
  setInterval(() => {
    fetch(`${SELF_URL}/health`).catch(() => {});
  }, 10 * 60 * 1000);
  console.log(`[keepalive] pinging ${SELF_URL}/health every 10 minutes`);
}
