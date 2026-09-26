/**
 * Stremio Add-on: Hebrew AI Subtitles
 * ------------------------------------
 * Finds English subtitles for any movie/episode (via Stremio's public
 * OpenSubtitles v3 service), picks the ones whose timing matches the user's
 * exact video file (see sync.js), translates them to Hebrew using Google
 * Gemini (with free Google Translate as automatic fallback), and serves them
 * back to Stremio.
 *
 * Environment variables:
 *   GEMINI_API_KEY        - your free key from https://aistudio.google.com (recommended)
 *   GEMINI_MODEL          - optional, default "gemini-flash-latest"
 *   TRANSLATE_PROVIDER    - optional: "gemini" (default) or "anthropic"
 *   ANTHROPIC_API_KEY     - optional, enables Claude as the translation engine
 *   ANTHROPIC_MODEL       - optional, default "claude-haiku-4-5"
 *   TRANSLATE_CONCURRENCY - optional, parallel translation requests (default 4)
 *   SUBFILE_HOLD_MS       - optional, how long a subtitle request waits for a
 *                           running translation before answering (default 180000)
 *   PREFETCH_NEXT         - optional, "0" disables translating the next episode ahead
 *   PORT                  - set automatically by Render
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const sync = require('./sync');

const PORT = process.env.PORT || 7000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
// Optional persistent cache: completed translations are committed to a GitHub
// repo so they survive server restarts/redeploys (Render free disk is wiped).
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const CACHE_REPO = process.env.CACHE_REPO || 'arisurf/stremio-hebrew-subtitles';
const OPENSUBS_BASE = process.env.OPENSUBS_BASE || 'https://opensubtitles-v3.strem.io';
const CACHE_DIR = process.env.CACHE_DIR || '/tmp/hebsub-cache';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 80); // subtitle cues per AI request
const CONCURRENCY = Number(process.env.TRANSLATE_CONCURRENCY || 4); // parallel AI requests
// Hold a subtitle request open while translating. Render was measured to keep
// requests open for 300s (2026-09-26), so 3 minutes covers full-length movies.
const SUBFILE_HOLD_MS = Number(process.env.SUBFILE_HOLD_MS || 180000);
const ANALYZE_LIMIT = Number(process.env.ANALYZE_LIMIT || 10); // English sources compared per video
const PREFETCH_NEXT = process.env.PREFETCH_NEXT !== '0';
const MAX_VARIANTS = 3;
const CONTEXT_LINES = 3; // English context lines shared across batch borders

fs.mkdirSync(CACHE_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pruneMap(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

function fetchWithTimeout(url, ms, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
const MANIFEST = {
  id: 'org.ari.hebrew.ai.subtitles',
  version: '1.4.0',
  name: 'Ari4KD Hebrew AI Subtitles',
  description:
    'כתוביות בעברית לכל סרט וסדרה: בוחר אוטומטית את הכתוביות באנגלית שמסונכרנות לקובץ שלכם ומתרגם אותן לעברית עם AI. ' +
    'Picks the English subtitles that match your exact video file and translates them to Hebrew with AI.',
  logo: 'https://em-content.zobj.net/source/twitter/376/israel_1f1ee-1f1f1.png',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: false, configurationRequired: false },
};

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

async function googleTranslateBatch(lines, onLine) {
  const out = [];
  for (const line of lines) {
    try {
      out.push(await googleTranslateLine(line));
    } catch {
      out.push(line); // worst case: keep English for this cue
    }
    if (onLine) onLine(out.length, lines.length);
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
    const out = await googleTranslateBatch(texts, (done, total) => {
      if (onProgress && (done % 20 === 0 || done === total)) onProgress(done, total);
    });
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
// English sources from Stremio's public OpenSubtitles service
// ---------------------------------------------------------------------------
// Stremio's fingerprint extra ("filename=…&videoSize=…&videoHash=…"),
// already URL-decoded by Express.
function parseExtra(extra) {
  const out = {};
  for (const part of String(extra || '').split('&')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const val = part.slice(i + 1);
    try {
      out[part.slice(0, i)] = decodeURIComponent(val);
    } catch {
      out[part.slice(0, i)] = val;
    }
  }
  return out;
}
function extraPath(extra) {
  return Object.entries(parseExtra(extra))
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

const listCache = new Map(); // url -> { subs, at }
async function fetchSubsList(type, videoId, extra) {
  const url = `${OPENSUBS_BASE}/subtitles/${type}/${encodeURIComponent(videoId)}${extra ? '/' + extraPath(extra) : ''}.json`;
  const hit = listCache.get(url);
  if (hit && Date.now() - hit.at < 3600000) return hit.subs;
  const res = await fetchWithTimeout(url, 15000);
  if (!res.ok) throw new Error(`OpenSubtitles lookup failed (${res.status})`);
  const subs = (await res.json()).subtitles || [];
  listCache.set(url, { subs, at: Date.now() });
  pruneMap(listCache, 500);
  return subs;
}

// English candidates (upstream order) plus "references": subtitles in ANY
// language that OpenSubtitles matched to the user's exact file by its hash.
// A reference's timing is the true timing of that file.
async function getSources(type, videoId, extra) {
  const [general, hashed] = await Promise.all([
    fetchSubsList(type, videoId, ''),
    extra
      ? fetchSubsList(type, videoId, extra).catch((e) => {
          console.log(`[sources] fingerprint lookup failed: ${e.message}`);
          return [];
        })
      : [],
  ]);
  const refs = hashed.filter((s) => s.m === 'h' && s.url).slice(0, 2);
  const seen = new Set();
  const english = [];
  for (const s of hashed.concat(general)) {
    if (s.lang !== 'eng' || !s.url || seen.has(String(s.id))) continue;
    seen.add(String(s.id));
    english.push(s);
  }
  return { english, refs };
}

// Downloads go through a small queue: bursts of parallel requests to the
// subtitle CDN intermittently fail, which silently shrank the analysis.
const DOWNLOAD_CONCURRENCY = 4;
let downloadsActive = 0;
const downloadQueue = [];
async function withDownloadSlot(fn) {
  if (downloadsActive >= DOWNLOAD_CONCURRENCY) await new Promise((r) => downloadQueue.push(r));
  downloadsActive++;
  try {
    return await fn();
  } finally {
    downloadsActive--;
    const next = downloadQueue.shift();
    if (next) next();
  }
}

async function downloadSubtitle(sub) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(800 * attempt);
    try {
      const r = await withDownloadSlot(() => fetchWithTimeout(sub.url, 15000).then(async (res) => ({ res, text: await res.text() })));
      if (!r.res.ok) throw new Error(`HTTP ${r.res.status}`);
      const cues = sync.parseSrt(r.text);
      if (cues.length < 5) throw new Error(`only ${cues.length} cues in ${r.text.length} bytes`);
      return cues;
    } catch (e) {
      lastErr = e;
    }
  }
  console.log(`[source] ${sub.id} "${sub.subtitleFileName || ''}" unusable: ${lastErr.message}`);
  throw lastErr;
}

// Downloaded + parsed source subtitles, shared by analysis and translation so
// every file is fetched once. Entries are { promise } while downloading.
const srcCache = new Map(); // subtitle id -> { cues, at } | { promise }
function loadSourceCues(sub) {
  const id = String(sub.id);
  const hit = srcCache.get(id);
  if (hit && hit.promise) return hit.promise;
  if (hit && Date.now() - hit.at < 6 * 3600000) return Promise.resolve(hit.cues);
  const promise = downloadSubtitle(sub);
  srcCache.set(id, { promise });
  promise.then(
    (cues) => {
      srcCache.set(id, { cues, at: Date.now() });
      pruneMap(srcCache, 150);
    },
    () => srcCache.delete(id)
  );
  return promise;
}

// ---------------------------------------------------------------------------
// Plans: which sources to offer for one video, best first (see sync.js)
// ---------------------------------------------------------------------------
const planCache = new Map(); // `${type}|${videoId}|${extra}` -> { plan, at, ttl } | { promise }
// Per series: the sources that were VERIFIED against the user's own file on
// some episode (a timing "family"). Episodes without a hash-matched reference
// — including the next episode, translated ahead of time — pick from the same
// family. Persisted in the cache repo so it survives restarts.
const seriesFamily = new Map(); // imdb id -> { members: [{ id, tokens }], at, episode }
const FAMILY_TTL = 180 * 24 * 3600000;

function getPlan(type, videoId, extra) {
  const key = `${type}|${videoId}|${extra || ''}`;
  const hit = planCache.get(key);
  if (hit && hit.promise) return hit.promise;
  if (hit && Date.now() - hit.at < hit.ttl) return Promise.resolve(hit.plan);
  const promise = computePlan(type, videoId, extra || '');
  planCache.set(key, { promise });
  promise.then(
    (plan) => {
      // A plan built from incomplete downloads is only kept briefly.
      planCache.set(key, { plan, at: Date.now(), ttl: plan.coverage >= 0.8 ? 3600000 : 120000 });
      pruneMap(planCache, 300);
    },
    () => planCache.delete(key)
  );
  return promise;
}

function familyFor(type, videoId) {
  if (type !== 'series') return [];
  const f = seriesFamily.get(String(videoId).split(':')[0]);
  return f && Date.now() - f.at < FAMILY_TTL ? f.members : [];
}

async function computePlan(type, videoId, extra) {
  const t0 = Date.now();
  const { english, refs } = await getSources(type, videoId, extra);
  if (!english.length) {
    console.log(`[plan] ${videoId}: no English subtitles on OpenSubtitles`);
    return { mode: 'none', refNote: '', variants: [], all: [], english, coverage: 1 };
  }
  const family = familyFor(type, videoId);
  // Analyze the top of the list, plus any lower-ranked file from the series'
  // verified family (same upload batch or release-group name).
  const pool = english.slice(0, ANALYZE_LIMIT);
  const famTokens = family.flatMap((f) => f.tokens || []);
  for (const s of english.slice(ANALYZE_LIMIT)) {
    const name = `${s.movieReleaseName || ''} ${s.subtitleFileName || ''}`.toLowerCase();
    const near = family.some((f) => Math.abs(Number(s.id) - Number(f.id)) <= 40);
    if ((near || famTokens.some((t) => name.includes(t))) && pool.length < ANALYZE_LIMIT + 3) pool.push(s);
  }
  const [cands, refLoaded] = await Promise.all([
    Promise.all(pool.map((sub, order) => loadSourceCues(sub).then((cues) => ({ sub, cues, order }), () => null))),
    Promise.all(refs.map((sub) => loadSourceCues(sub).then((cues) => ({ sub, cues }), () => null))),
  ]);
  const analyzed = cands.filter(Boolean).length;
  const plan = sync.rankSources(cands.filter(Boolean), refLoaded.filter(Boolean), {
    userFilename: parseExtra(extra).filename || '',
    family,
    isReady,
    maxVariants: MAX_VARIANTS,
  });
  plan.english = english;
  plan.coverage = analyzed / pool.length;
  if (!plan.variants.length) {
    // Nothing could be downloaded for analysis: offer the upstream order, unverified.
    plan.mode = 'unverified';
    plan.variants = pool.slice(0, MAX_VARIANTS).map((sub) => ({
      sub, rate: null, verified: false, retime: null, dub: sync.isDub(sub), hi: false, family: false, group: 0, support: 1, tokens: [], cueCount: 0,
    }));
    plan.all = plan.variants;
  }
  if (type === 'series' && plan.family && plan.family.length) rememberFamily(String(videoId).split(':')[0], plan.family, videoId);
  console.log(
    `[plan] ${videoId} mode=${plan.mode}${plan.refNote ? ' ref=' + plan.refNote : ''}${family.length ? ' family=' + family.length : ''} ` +
      `(${Date.now() - t0}ms, ${analyzed}/${pool.length} analyzed${plan.excluded ? ', ' + plan.excluded + ' fragments dropped' : ''}): ` +
      plan.variants
        .map((v, i) => `#${i + 1} ${v.sub.id}${v.rate != null ? ' ' + Math.round(v.rate * 100) + '%' : ''}${v.retime ? ' retimed' : ''}${v.family ? ' family' : ''}${v.dub ? ' dub' : ''} "${v.sub.subtitleFileName || ''}"`)
        .join(' | ')
  );
  return plan;
}

// ---------------------------------------------------------------------------
// Translation jobs + cache (keyed by the English SOURCE file: the Hebrew
// content depends only on it, so every path to that source reuses it)
// ---------------------------------------------------------------------------
const jobs = new Map(); // key -> { status: 'remote'|'working'|'error', why, startedAt, cueCount?, progress?, error? }

function srcKeyFor(candId) {
  return `src-${candId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}
function cachePathFor(key) {
  return path.join(CACHE_DIR, `${key}.he.srt`);
}
function isReady(sub) {
  return fs.existsSync(cachePathFor(srcKeyFor(sub.id)));
}

// Older cache files carry a baked-in "Ari4KD · …" first cue; it is now added
// when serving instead, so it can reflect the current ranking.
function stripHeader(cues) {
  return cues.length && /Ari4KD/.test(cues[0].text) ? cues.slice(1) : cues;
}
// A translation is only valid for the source it was made from: same number
// of cues, same start times. Catches files saved under the wrong source.
function matchesSource(heb, src) {
  return heb.length === src.length && heb.every((c, i) => Math.abs(c.start - src[i].start) <= 5);
}

function readValidCache(key, srcCues) {
  const file = cachePathFor(key);
  if (!fs.existsSync(file)) return null;
  const cues = stripHeader(sync.parseSrt(fs.readFileSync(file, 'utf8')));
  if (matchesSource(cues, srcCues)) return cues;
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
  console.log(`[${key}] cached translation does not match its English source — discarded`);
  return null;
}

// --- Persistent cache on GitHub (survives restarts and redeploys) ---------
function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    'User-Agent': 'ari4kd-hebrew-subs',
    Accept: 'application/vnd.github+json',
  };
}

async function fetchRemoteCache(key) {
  if (!GITHUB_TOKEN) return null;
  try {
    const r = await fetchWithTimeout(`https://api.github.com/repos/${CACHE_REPO}/contents/cache/${key}.he.srt`, 15000, {
      headers: { ...ghHeaders(), Accept: 'application/vnd.github.raw' },
    });
    if (!r.ok) return null;
    const text = await r.text();
    return text.length < 100 ? null : text;
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

// Start (or join) the translation of exactly this source. Never substitutes a
// different source: if this one can't be downloaded the job fails visibly.
function ensureTranslation(sub, why) {
  const key = srcKeyFor(sub.id);
  if (fs.existsSync(cachePathFor(key))) return key;
  const existing = jobs.get(key);
  if (existing && existing.status !== 'error') return key;
  if (existing && Date.now() - existing.startedAt < 120000) return key; // recent failure: back off

  const job = { status: 'remote', why, startedAt: Date.now() };
  jobs.set(key, job);
  const log = (msg) => console.log(`[${key}] ${msg}`);
  (async () => {
    const srcCues = await loadSourceCues(sub);
    job.cueCount = srcCues.length;
    // A previous server instance may already have translated this source.
    const remote = await fetchRemoteCache(key);
    if (remote) {
      const cues = stripHeader(sync.parseSrt(remote));
      if (matchesSource(cues, srcCues)) {
        fs.writeFileSync(cachePathFor(key), sync.serializeSrt(cues), 'utf8');
        jobs.delete(key);
        log('loaded from GitHub cache');
        return;
      }
      log('GitHub cache entry does not match its English source — re-translating');
    }
    job.status = 'working';
    job.startedAt = Date.now();
    log(`translating ${srcCues.length} cues (${why}) from "${sub.subtitleFileName || sub.id}"`);
    const texts = await translateAll(srcCues, log, (done, total) => {
      job.progress = { done, total, at: Date.now() };
    });
    const srt = sync.serializeSrt(
      srcCues.map((c, i) => ({ start: c.start, end: c.end, text: sync.rtl((texts[i] || c.text).trim()) }))
    );
    fs.writeFileSync(cachePathFor(key), srt, 'utf8');
    jobs.delete(key);
    log(`done in ${Math.round((Date.now() - job.startedAt) / 1000)}s — Hebrew subtitles cached`);
    await saveToRemoteCache(key, srt); // persist across restarts/redeploys
  })().catch((e) => {
    console.error(`[${key}] FAILED: ${e.message}`);
    jobs.set(key, { status: 'error', error: e.message, why, startedAt: Date.now() });
  });
  return key;
}

// Hold a subtitle request open until the translation job finishes (or maxMs
// elapses). Stremio's streaming server waits for add-on subtitles without a
// response timeout, so serving the real file inside the first response means
// no re-selecting is needed.
async function waitForTranslation(key, maxMs, isGone = () => false) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(cachePathFor(key))) return 'done';
    const job = jobs.get(key);
    if (job && job.status === 'error') return 'error';
    if (isGone()) return 'gone';
    await sleep(1000);
  }
  return 'timeout';
}

// Brief wait while a job only checks the GitHub cache (~1s), so the menu can
// already say "ready" for anything translated before.
async function waitWhileCheckingCache(key, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline && jobs.get(key) && jobs.get(key).status === 'remote') await sleep(250);
}

function estimateSeconds(cueCount) {
  const batches = Math.max(1, Math.ceil((cueCount || 350) / BATCH_SIZE));
  return 10 + Math.ceil(batches / Math.max(1, CONCURRENCY)) * 20;
}
function remainingSeconds(key, cueCount) {
  const job = jobs.get(key);
  if (!job) return estimateSeconds(cueCount);
  const elapsed = (Date.now() - job.startedAt) / 1000;
  const p = job.progress;
  if (p && p.done) return Math.round((elapsed / p.done) * (p.total - p.done));
  const est = estimateSeconds(job.cueCount || cueCount);
  return elapsed < est ? est - elapsed : 15; // slower than usual: "a little longer"
}
const roundUp5 = (s) => Math.max(5, Math.ceil(s / 5) * 5);

// ---------------------------------------------------------------------------
// What the user sees: menu labels, first-seconds banner, placeholders
// ---------------------------------------------------------------------------
function statusText(v) {
  if (isReady(v.sub)) return '✓ מוכן';
  const key = srcKeyFor(v.sub.id);
  const job = jobs.get(key);
  if (job && job.status === 'error') return '⚠️ שגיאה בתרגום';
  const secs = roundUp5(remainingSeconds(key, v.cueCount));
  return job ? `⏳ בתרגום, מוכן בעוד ~${secs} שנ׳` : `⏳ ~${secs} שנ׳ לתרגום`;
}

// Shown as the option's name in Stremio's subtitle menu.
function variantLabel(v, i) {
  const parts = [i === 0 ? '⭐ מומלץ' : `חלופה ${i + 1}`];
  if (v.verified) parts.push('מסונכרן לקובץ שלך');
  else if (i === 0 && v.rate != null) parts.push('הכי קרוב לקובץ שלך');
  else if (i > 0) parts.push('תזמון שונה');
  const tag = sync.sourceTag(v.sub);
  if (i > 0 && tag) parts.push(tag);
  if (v.dub) parts.push('תמלול דיבוב');
  parts.push(statusText(v));
  return parts.join(' · ');
}

// Shown on screen during the first seconds of playback.
function bannerText(v, slot) {
  const parts = ['Ari4KD', slot === 0 ? '⭐ מומלץ' : slot > 0 ? `חלופה ${slot + 1}` : ''];
  if (v.verified) parts.push('מסונכרן לקובץ שלך');
  else if (v.retime) parts.push('תוזמן מחדש');
  return parts.filter(Boolean).join(' · ');
}

function renderForPlayer(cues, v, slot) {
  const out = sync.applyRetime(cues, v.retime).slice();
  const first = out.length ? out[0].start : Infinity;
  if (first >= 1500) out.unshift({ start: 500, end: Math.min(5000, first - 100), text: sync.rtl(bannerText(v, slot)) });
  return sync.serializeSrt(out);
}

function placeholderSrt(...lines) {
  const text = lines.map((l) => (/[֐-׿]/.test(l) ? sync.rtl(l) : l)).join('\n');
  const cues = [];
  for (let t = 0; t < 600; t += 15) cues.push({ start: t * 1000, end: (t + 8) * 1000, text });
  return sync.serializeSrt(cues);
}

// ---------------------------------------------------------------------------
// Fingerprint memory
// ---------------------------------------------------------------------------
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

// Small JSON state files in the cache repo. Fingerprints and verified
// families must survive instance restarts (Render free churns instances, and
// the player's request often lands on a freshly-woken server).
async function loadRepoJson(file) {
  if (!GITHUB_TOKEN) return null;
  try {
    const r = await fetchWithTimeout(`https://api.github.com/repos/${CACHE_REPO}/contents/cache/${file}`, 10000, {
      headers: { ...ghHeaders(), Accept: 'application/vnd.github.raw' },
    });
    return r.ok ? JSON.parse(await r.text()) : null;
  } catch {
    return null;
  }
}

const repoSaveTimers = new Map();
function saveRepoJsonSoon(file, build, message) {
  if (!GITHUB_TOKEN) return;
  clearTimeout(repoSaveTimers.get(file));
  repoSaveTimers.set(
    file,
    setTimeout(async () => {
      try {
        const apiUrl = `https://api.github.com/repos/${CACHE_REPO}/contents/cache/${file}`;
        let sha;
        const g = await fetch(apiUrl, { headers: ghHeaders() });
        if (g.ok) sha = (await g.json()).sha;
        const res = await fetch(apiUrl, {
          method: 'PUT',
          headers: ghHeaders(),
          body: JSON.stringify({
            message,
            content: Buffer.from(JSON.stringify(build()), 'utf8').toString('base64'),
            ...(sha ? { sha } : {}),
          }),
        });
        console.log(res.ok ? `[cache] ${file} saved to GitHub` : `[cache] ${file} save failed (${res.status})`);
      } catch (e) {
        console.log(`[cache] ${file} save error: ${e.message}`);
      }
    }, 3000)
  );
}

let stateLoading = null;
function loadStateFromRemote() {
  if (!stateLoading) {
    stateLoading = (async () => {
      const [extras, series] = await Promise.all([loadRepoJson('extras.json'), loadRepoJson('series.json')]);
      if (extras) {
        for (const [k, v] of Object.entries(extras)) if (!lastExtra.has(k)) lastExtra.set(k, v);
        console.log(`[cache] loaded ${Object.keys(extras).length} fingerprints from GitHub`);
      }
      if (series) {
        for (const [k, v] of Object.entries(series)) if (!seriesFamily.has(k)) seriesFamily.set(k, v);
        console.log(`[cache] loaded ${Object.keys(series).length} series timing families from GitHub`);
      }
    })();
  }
  return stateLoading;
}

function saveExtrasSoon() {
  saveRepoJsonSoon(
    'extras.json',
    () => {
      const fresh = {};
      for (const [k, v] of lastExtra) if (Date.now() - v.at < LAST_EXTRA_TTL) fresh[k] = v;
      return fresh;
    },
    'cache: fingerprints'
  );
}

// Families from several verified episodes accumulate (newest first), so a
// release name seen on one episode keeps helping on the others.
function rememberFamily(imdb, members, episode) {
  const prev = seriesFamily.get(imdb);
  const merged = members.slice();
  const older = prev && Date.now() - prev.at < FAMILY_TTL ? prev.members : [];
  for (const m of older) if (!merged.some((x) => x.id === m.id)) merged.push(m);
  merged.splice(12);
  const ids = (list) => list.map((m) => m.id).sort().join();
  const same = prev && ids(prev.members) === ids(merged);
  seriesFamily.set(imdb, { members: merged, at: Date.now(), episode });
  if (same) return;
  console.log(`[family] ${imdb}: verified on ${episode} -> ${members.map((m) => m.id + (m.tokens.length ? ' (' + m.tokens.join(',') + ')' : '')).join(', ')} (${merged.length} known)`);
  saveRepoJsonSoon(
    'series.json',
    () => {
      const fresh = {};
      for (const [k, v] of seriesFamily) if (Date.now() - v.at < FAMILY_TTL) fresh[k] = v;
      return fresh;
    },
    'cache: series timing families'
  );
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

// ---------------------------------------------------------------------------
// Next episode, translated ahead of time
// ---------------------------------------------------------------------------
const prefetched = new Map(); // videoId -> at

function schedulePrefetch(type, videoId) {
  if (!PREFETCH_NEXT || type !== 'series') return;
  const m = /^(tt\d+):(\d+):(\d+)$/.exec(videoId);
  if (!m) return;
  const next = `${m[1]}:${m[2]}:${Number(m[3]) + 1}`;
  const nextSeason = `${m[1]}:${Number(m[2]) + 1}:1`;
  const seen = prefetched.get(next);
  if (seen && Date.now() - seen < 6 * 3600000) return;
  prefetched.set(next, Date.now());
  pruneMap(prefetched, 200);

  let tries = 0;
  const attempt = async () => {
    // Let the episode being watched translate first.
    const busy = [...jobs.values()].some((j) => j.status !== 'error' && j.why !== 'prefetch');
    if (busy && ++tries < 40) return void setTimeout(attempt, 15000);
    for (const nid of [next, nextSeason]) {
      try {
        const plan = await getPlan(type, nid, '');
        const v = plan.variants[0];
        if (!v) continue;
        if (isReady(v.sub)) return void console.log(`[prefetch] ${nid} already translated`);
        console.log(`[prefetch] ${nid} -> ${v.sub.id} "${v.sub.subtitleFileName || ''}"`);
        ensureTranslation(v.sub, 'prefetch');
        return;
      } catch (e) {
        console.log(`[prefetch] ${nid} skipped: ${e.message}`);
      }
    }
  };
  setTimeout(attempt, 5000);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  // Diagnostic: log every subtitle request so we can see exactly what
  // Stremio sends (videoHash / videoSize / filename presence) and from where.
  if (req.path.startsWith('/subtitles/') || req.path.startsWith('/subfile/')) {
    console.log(`[request] ${req.originalUrl} ua="${String(req.headers['user-agent'] || '').slice(0, 60)}"`);
  }
  next();
});

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.headers.host}`;
}
const safeId = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

app.get('/manifest.json', (req, res) => {
  res.json(MANIFEST);
});

async function handleSubtitlesRequest(req, res) {
  const { type, id } = req.params;
  if (!['movie', 'series'].includes(type) || !id.startsWith('tt')) {
    return res.json({ subtitles: [] });
  }
  await loadStateFromRemote();
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
  const xq = extra ? `&x=${encodeURIComponent(extra)}` : '';

  let plan;
  try {
    plan = await getPlan(type, id, extra);
  } catch (e) {
    console.log(`[plan] ${id} failed: ${e.message}`);
    return res.json({
      subtitles: [{
        id: `heb-ai-${safeId(id)}-retry`,
        url: `${baseUrl(req)}/subfile/${type}/${encodeURIComponent(id)}/v0.srt?b=6${xq}`,
        lang: 'heb',
        label: '⚠️ שגיאה זמנית בחיפוש כתוביות',
      }],
      cacheMaxAge: 0,
    });
  }
  if (!plan.variants.length) return res.json({ subtitles: [], cacheMaxAge: 600 });

  // Start translating the recommended option right away, so it is ready (or
  // nearly) by the time it's selected; then the next episode in the background.
  const key = ensureTranslation(plan.variants[0].sub, 'eager');
  await waitWhileCheckingCache(key, 3000);
  schedulePrefetch(type, id);

  // Each option addresses its source file directly (".../s<sourceId>.srt"), so
  // the file served always matches the label, even if the ranking changes.
  const subtitles = plan.variants.map((v, i) => ({
    id: `heb-ai-${safeId(id)}-${safeId(v.sub.id)}`,
    url: `${baseUrl(req)}/subfile/${type}/${encodeURIComponent(id)}/s${encodeURIComponent(v.sub.id)}.srt?b=6${xq}${isReady(v.sub) ? '&r=1' : ''}`,
    lang: 'heb',
    label: variantLabel(v, i),
  }));
  res.json({ subtitles, cacheMaxAge: 60 });
}

app.get('/subtitles/:type/:id.json', handleSubtitlesRequest);
app.get('/subtitles/:type/:id/:extra.json', handleSubtitlesRequest);

async function handleSubfileRequest(req, res) {
  const { type, id } = req.params;
  const sel = String(req.params.variant || 'v0');
  await loadStateFromRemote();
  let extra = typeof req.query.x === 'string' && req.query.x.includes('videoHash=') ? req.query.x : '';
  if (!extra) extra = rememberedExtra(type, id); // fall back to the remembered fingerprint
  if (!extra) extra = await waitForExtra(`${type}-${id}`, 5000); // fingerprint may arrive any second
  res.setHeader('Content-Type', 'text/srt; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  let plan;
  try {
    plan = await getPlan(type, id, extra);
  } catch (e) {
    return res.send(placeholderSrt('⚠️ שגיאה זמנית בחיפוש כתוביות — נסו שוב בעוד רגע', `Subtitle search failed: ${e.message}`));
  }

  // "s<sourceId>" = a specific source; "v<n>" = the n-th option (older URLs).
  let slot = -1;
  let v = null;
  if (sel.startsWith('s')) {
    const sid = sel.slice(1);
    slot = plan.variants.findIndex((x) => String(x.sub.id) === sid);
    v = slot >= 0 ? plan.variants[slot] : plan.all.find((x) => String(x.sub.id) === sid);
    if (!v) {
      const sub = (plan.english || []).find((s) => String(s.id) === sid);
      if (sub) v = { sub, rate: null, verified: false, retime: null, dub: sync.isDub(sub), cueCount: 0 };
    }
  } else {
    slot = Math.min(parseInt(sel.replace(/\D/g, ''), 10) || 0, Math.max(0, plan.variants.length - 1));
    v = plan.variants[slot];
  }
  if (!v) return res.send(placeholderSrt('לא נמצאו כתוביות באנגלית לתרגום עבור הקובץ הזה', 'No English subtitles found for this video'));

  const key = srcKeyFor(v.sub.id);
  let srcCues;
  try {
    srcCues = await loadSourceCues(v.sub);
  } catch (e) {
    return res.send(placeholderSrt('⚠️ לא ניתן להוריד את כתוביות המקור — בחרו חלופה אחרת', `Source download failed: ${e.message}`));
  }

  let cues = readValidCache(key, srcCues);
  if (!cues) {
    ensureTranslation(v.sub, 'selected');
    // Hold the request open so the player receives the real Hebrew file in
    // this same response — the subtitles simply appear when ready.
    const started = Date.now();
    let gone = false;
    res.on('close', () => {
      if (!res.writableFinished) gone = true;
    });
    const outcome = await waitForTranslation(key, SUBFILE_HOLD_MS, () => gone);
    const waited = Math.round((Date.now() - started) / 1000);
    if (gone) return void console.log(`[hold] ${key}: player stopped waiting after ${waited}s`);
    console.log(`[hold] ${key}: ${outcome} after ${waited}s`);
    if (outcome === 'done') cues = readValidCache(key, srcCues);
  }
  if (cues) return res.send(renderForPlayer(cues, v, slot));

  const job = jobs.get(key);
  if (job && job.status === 'error') {
    return res.send(placeholderSrt('⚠️ שגיאה בתרגום — בחרו חלופה אחרת או נסו שוב בעוד 2 דקות', `Translation error: ${job.error}`));
  }
  const secs = roundUp5(remainingSeconds(key, srcCues.length));
  const p = job && job.progress;
  return res.send(
    placeholderSrt(
      `⏳ התרגום עדיין בהכנה${p ? ` (${p.done}/${p.total})` : ''} — מוכן בעוד ~${secs} שנ׳`,
      `סגרו את הנגן ופתחו שוב בעוד ~${secs} שנ׳ והכתוביות ייטענו מיד`
    )
  );
}

app.get('/subfile/:type/:id/:variant.srt', handleSubfileRequest);
app.get('/subfile/:type/:id.srt', handleSubfileRequest);

// Diagnostics: which sources would be offered for a video, and why.
// /debug/plan/series/tt2560140:2:5.json?x=<fingerprint extra>
app.get('/debug/plan/:type/:id.json', async (req, res) => {
  const extra = typeof req.query.x === 'string' ? req.query.x : '';
  try {
    await loadStateFromRemote();
    const plan = await getPlan(req.params.type, req.params.id, extra);
    const view = (v, i) => ({
      id: v.sub.id,
      file: v.sub.subtitleFileName,
      group: v.group,
      match: v.rate == null ? null : Math.round(v.rate * 1000) / 10,
      verified: v.verified,
      family: v.family,
      retime: v.retime ? (v.retime.offsets ? 'piecewise' : { scale: v.retime.scale, offsetMs: v.retime.offset }) : null,
      dub: v.dub,
      hi: v.hi,
      ready: isReady(v.sub),
      ...(i != null ? { label: variantLabel(v, i) } : {}),
    });
    res.json({
      mode: plan.mode,
      reference: plan.refNote,
      coverage: plan.coverage,
      fragmentsDropped: plan.excluded || 0,
      variants: plan.variants.map((v, i) => view(v, i)),
      analyzed: plan.all.map((v) => view(v)),
      seriesFamily: seriesFamily.get(String(req.params.id).split(':')[0]) || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
