/**
 * Subtitle timing analysis for the Hebrew AI Subtitles add-on.
 * -------------------------------------------------------------
 * Pure functions only (no network, no disk) so they can be tested in isolation.
 *
 *  - parse / serialize SRT in a canonical form every Stremio player accepts
 *  - measure how well a subtitle file's timing matches a reference timing
 *    (a subtitle OpenSubtitles matched to the user's exact video file)
 *  - re-time a file onto the reference (fixed shift, frame-rate change, or
 *    piecewise shifts for versions with different cuts)
 *  - rank candidate English sources and pick up to N genuinely different ones
 */
'use strict';

// ---------------------------------------------------------------------------
// SRT
// ---------------------------------------------------------------------------
const TIMING_RE = /(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

function toMs(h, m, s, frac) {
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(String(frac).padEnd(3, '0'));
}

// Returns [{ start, end, text }] with times in milliseconds.
function parseSrt(raw) {
  const text = String(raw).replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 2) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0].trim()) && lines[1].includes('-->')) i = 1;
    const m = lines[i] && lines[i].includes('-->') ? TIMING_RE.exec(lines[i]) : null;
    if (!m) continue;
    // Strip ASS/SSA override tags like {\an8} — players show them as literal text.
    const body = lines.slice(i + 1).join('\n').replace(/\{\\[^}]*\}/g, '').trim();
    if (!body) continue;
    const start = toMs(m[1], m[2], m[3], m[4]);
    let end = toMs(m[5], m[6], m[7], m[8]);
    if (end <= start) end = start + 1500;
    cues.push({ start, end, text: body });
  }
  return cues;
}

function fmtTime(ms) {
  const t = Math.max(0, Math.round(ms));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(t / 3600000))}:${p(Math.floor(t / 60000) % 60)}:${p(Math.floor(t / 1000) % 60)},${p(t % 1000, 3)}`;
}

// Canonical SRT: "HH:MM:SS,mmm" times and exactly one blank line between cues.
// Stremio's web converter splits cues on "\n\n" literally and chokes on
// anything else, so text never contains empty lines either.
function serializeSrt(cues) {
  return cues
    .map((c, i) => {
      const text = String(c.text).split('\n').filter((l) => l.trim() !== '').join('\n') || ' ';
      return `${i + 1}\n${fmtTime(c.start)} --> ${fmtTime(c.end)}\n${text}\n`;
    })
    .join('\n');
}

// Wrap each line in an RTL embedding (U+202B ... U+202C) so punctuation at
// BOTH ends of the line renders on the correct side in Hebrew, even in
// players that lay subtitles out left-to-right.
function rtl(text) {
  return String(text)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => '‫' + l.trim() + '‬')
    .join('\n');
}

// Move cues onto the reference timeline. retime = { scale, offset } (ms) or
// { scale, offsets: [ms per cue] } for piecewise shifts.
function applyRetime(cues, retime) {
  if (!retime) return cues;
  return cues
    .map((c, i) => {
      const off = retime.offsets ? retime.offsets[i] || 0 : retime.offset || 0;
      return { start: c.start * retime.scale + off, end: c.end * retime.scale + off, text: c.text };
    })
    .filter((c) => c.end > 0)
    .map((c) => ({ start: Math.max(0, c.start), end: c.end, text: c.text }))
    .sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Timing analysis (times in seconds)
// ---------------------------------------------------------------------------
const FIT_SCALES = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24]; // frame-rate conversions
const MAX_SHIFT = 120; // largest offset searched, seconds
const MATCH_TOL = 0.35; // a cue "matches" if its start is within this many seconds
const BIN = 0.1;

function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Push every (ref - t) difference within ±MAX_SHIFT into out.
function diffsNear(ref, t, out) {
  for (let j = lowerBound(ref, t - MAX_SHIFT); j < ref.length && ref[j] <= t + MAX_SHIFT; j++) out.push(ref[j] - t);
  return out;
}

// The shift most cue pairs agree on (histogram peak), refined to the mean of
// the differences in the winning bin and its neighbours.
function dominantOffset(diffs) {
  if (!diffs.length) return null;
  const counts = new Map();
  let bestK = 0;
  let bestN = 0;
  for (const d of diffs) {
    const k = Math.round(d / BIN);
    const n = (counts.get(k) || 0) + 1;
    counts.set(k, n);
    if (n > bestN) {
      bestN = n;
      bestK = k;
    }
  }
  let sum = 0;
  let cnt = 0;
  for (const d of diffs) {
    if (Math.abs(d / BIN - bestK) <= 1) {
      sum += d;
      cnt++;
    }
  }
  return { offset: sum / cnt, support: bestN };
}

// Fraction of reference cues that have a candidate cue starting within
// MATCH_TOL once the candidate is shifted by `offset`. candSorted must be sorted.
function matchRate(ref, candSorted, offset) {
  if (!ref.length || !candSorted.length) return 0;
  let hits = 0;
  for (const r of ref) {
    const i = lowerBound(candSorted, r - offset - MATCH_TOL);
    if (i < candSorted.length && Math.abs(candSorted[i] + offset - r) <= MATCH_TOL) hits++;
  }
  return hits / ref.length;
}

function globalFit(ref, candSorted, scales) {
  let best = { rate: 0, scale: 1, offset: 0 };
  for (const scale of scales) {
    const sc = scale === 1 ? candSorted : candSorted.map((t) => t * scale);
    const diffs = [];
    for (const t of sc) diffsNear(ref, t, diffs);
    const dom = dominantOffset(diffs);
    if (!dom) continue;
    const rate = matchRate(ref, sc, dom.offset);
    if (rate > best.rate + 0.01) best = { rate, scale, offset: dom.offset };
  }
  return best;
}

// Plain speed first; try frame-rate conversions only when that doesn't fit.
function globalFitAuto(ref, candSorted) {
  const plain = globalFit(ref, candSorted, [1]);
  if (plain.rate >= 0.8) return plain;
  const any = globalFit(ref, candSorted, FIT_SCALES);
  return any.rate > plain.rate ? any : plain;
}

// Per-cue shift for versions whose cuts differ (e.g. a longer recap or an
// extra scene): each cue takes the shift its ±WIN neighbours agree on, and
// only when a clear majority of them agree. Returns seconds per cue, in the
// candidate's own cue order.
function localOffsets(ref, candRaw, scale) {
  const WIN = 8;
  const sc = candRaw.map((t) => t * scale);
  const per = sc.map((t) => diffsNear(ref, t, []));
  const n = sc.length;
  const offs = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - WIN);
    const hi = Math.min(n, i + WIN + 1);
    const diffs = [];
    for (let j = lo; j < hi; j++) for (const d of per[j]) diffs.push(d);
    const dom = dominantOffset(diffs);
    if (dom && dom.support >= Math.max(6, 0.5 * (hi - lo))) offs[i] = dom.offset;
  }
  const known = [];
  for (let i = 0; i < n; i++) if (offs[i] != null) known.push(i);
  if (!known.length) return null;
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (offs[i] != null) continue;
    while (k + 1 < known.length && Math.abs(known[k + 1] - i) <= Math.abs(known[k] - i)) k++;
    offs[i] = offs[known[k]];
  }
  return offs;
}

// Two sources share the same timing (same video release) when they line up
// at (almost) zero shift in both directions.
function sameTiming(a, b) {
  const g = globalFit(a, b, [1]);
  if (Math.abs(g.offset) > 0.5 || g.rate < 0.75) return false;
  return matchRate(b, a, -g.offset) >= 0.75;
}

// ---------------------------------------------------------------------------
// Source heuristics (from OpenSubtitles metadata)
// ---------------------------------------------------------------------------
function describe(sub) {
  return `${sub.movieReleaseName || ''} ${sub.subtitleFileName || ''}`;
}

// Transcripts of an English dub — their lines follow the dub, not the
// original dialogue, and their timing usually comes from a TV broadcast.
function isDub(sub) {
  return /(^|[^a-z])(dub|dubbed|dubtitles?)([^a-z]|$)/i.test(describe(sub));
}

// Hearing-impaired versions carry [sound] notes that clutter a translation.
function isHI(sub, cues) {
  if (/(^|[^a-z])(hi|sdh|cc)([^a-z]|$)|hearing.?impaired/i.test(sub.subtitleFileName || '')) return true;
  if (!cues || !cues.length) return false;
  const marked = cues.filter((c) => /\[[^\]]{2,}\]|^[A-Z][A-Z .'-]{2,}:/m.test(c.text)).length;
  return marked / cues.length > 0.1;
}

function releaseKey(sub) {
  return (sub.movieReleaseName || sub.subtitleFileName || String(sub.id)).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Words that say nothing about WHICH release a file was timed to. Source
// types are included on purpose: three different BluRay rips of the same
// episode can have three different timings.
const GENERIC_TOKENS = new Set([
  'the', 'and', 'of', 'srt', 'ass', 'ssa', 'eng', 'english', 'en', 'subs', 'sub', 'subbed', 'subtitles', 'mkv', 'mp4', 'avi',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'aac', 'ac3', 'dts', 'ddp', 'dd', 'flac', 'opus', '10bit', '8bit',
  '480p', '720p', '1080p', '2160p', '4k', 'hdr', 'proper', 'repack', 'complete', 'season', 'episode',
  'bluray', 'blu', 'ray', 'bdrip', 'brrip', 'bd', 'web', 'webrip', 'webdl', 'dl', 'hdtv', 'hdrip', 'tvrip', 'dvdrip', 'dvd',
  'netflix', 'nf', 'amzn', 'dubbed', 'dub', 'dual', 'audio', 'multi', 'hi', 'sdh', 'cc', 'orig', 'addic7ed', 'com', 'org', 'net',
  'www', 'uncut', 'uncensored', 'extended', 'remastered', 'internal', 'limited', 'raw', 'raws',
]);
const MULTI_PART_RE = /(^|[^a-z0-9])(cd|disc)[ ._-]?[1-9]([^0-9]|$)/i;

function nameTokens(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/\.(srt|mkv|mp4|avi|m4v|webm)\b/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2 && !GENERIC_TOKENS.has(t) && !/^\d+$/.test(t) && !/^s\d+e\d+$/.test(t) && !/^\d+x\d+$/.test(t) && !/^[se]\d+$/.test(t))
  );
}

const SOURCE_TAGS = {
  bluray: 'BluRay', 'blu-ray': 'BluRay', bdrip: 'BluRay', brrip: 'BluRay', bd: 'BluRay',
  'web-dl': 'WEB', webdl: 'WEB', webrip: 'WEB', web: 'WEB', hdtv: 'TV', dvdrip: 'DVD', dvd: 'DVD',
  netflix: 'Netflix', nf: 'Netflix', amzn: 'Amazon', crunchyroll: 'Crunchyroll', funimation: 'Funimation',
  hidive: 'HIDIVE', dsnp: 'Disney+', hulu: 'Hulu', horriblesubs: 'Crunchyroll', subsplease: 'Crunchyroll',
};

// Short human hint about where a subtitle's timing comes from.
function sourceTag(sub) {
  const re = /(^|[^a-z])(blu-?ray|bdrip|brrip|bd|web-?dl|webrip|web|hdtv|dvdrip|dvd|netflix|nf|amzn|crunchyroll|funimation|hidive|dsnp|hulu|horriblesubs|subsplease)(?=[^a-z]|$)/i;
  const m = re.exec(describe(sub));
  return m ? SOURCE_TAGS[m[2].toLowerCase()] || '' : '';
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------
// A source belongs to the timing "family" verified on another episode of the
// same series when it was uploaded in the same batch (neighbouring ids) or
// carries the same release-group name (e.g. "horriblesubs", "kirion").
function familyMatch(c, family) {
  if (!family || !family.length) return false;
  const id = Number(c.sub.id);
  return family.some(
    (f) =>
      (Number.isFinite(id) && Math.abs(id - Number(f.id)) <= 40) ||
      (f.tokens || []).some((t) => t.length >= 3 && c.tokens.includes(t))
  );
}

/**
 * Rank English subtitle sources for one video.
 *   loadedCands: [{ sub, cues, order }]   English candidates (cues in ms)
 *   loadedRefs:  [{ sub, cues }]          subtitles (any language) matched to
 *                                         the user's exact file by OpenSubtitles
 *   opts: { userFilename, family, isReady(sub), maxVariants }
 *     family: [{ id, tokens }] sources verified on another episode of the series
 * Returns { mode, refNote, variants, all, family, excluded } where each variant is
 *   { sub, rate, verified, retime, dub, hi, family, group, support, tokens, cueCount }.
 *
 * mode "reference": a hash-matched subtitle gives the true timing of the
 *   user's file; sources are ranked by how well they match it and re-timed.
 * mode "consensus": no usable reference; a source from the family verified
 *   on another episode wins, otherwise the timing shared by the most
 *   independent releases (dub transcripts count half).
 * Alternatives always come from different timing groups, so each option
 * offered is genuinely different from the others.
 */
function rankSources(loadedCands, loadedRefs, opts = {}) {
  const maxVariants = opts.maxVariants || 3;
  const userName = opts.userFilename || '';
  const userDub = /(^|[^a-z])dub/i.test(userName);
  const isReady = opts.isReady || (() => false);
  const plan = { mode: 'consensus', refNote: '', variants: [], all: [], family: null, excluded: 0 };

  let valid = loadedCands.filter((c) => c && c.cues && c.cues.length >= 5);
  // Drop fragments (a few dozen lines of a full episode) and single parts of
  // multi-CD releases: their timing can't match a complete video file.
  if (valid.length) {
    const counts = valid.map((c) => c.cues.length).sort((a, b) => a - b);
    const median = counts[Math.floor(counts.length / 2)];
    const userPart = MULTI_PART_RE.test(userName);
    const full = valid.filter((c) => c.cues.length >= 0.5 * median && (userPart || !MULTI_PART_RE.test(describe(c.sub))));
    if (full.length) {
      plan.excluded = valid.length - full.length;
      valid = full;
    }
  }

  const cands = valid
    .map((c) => {
      const raw = c.cues.map((q) => q.start / 1000);
      return {
        sub: c.sub,
        order: c.order,
        cues: c.cues,
        raw,
        sorted: raw.slice().sort((a, b) => a - b),
        dub: isDub(c.sub) && !userDub,
        hi: isHI(c.sub, c.cues),
      };
    });
  if (!cands.length) return plan;

  // 1. Group sources that share the same timing.
  const groups = [];
  for (const c of cands) {
    let g = groups.find((grp) => sameTiming(grp.members[0].sorted, c.sorted));
    if (!g) {
      g = { members: [], support: 0, keys: new Set() };
      groups.push(g);
    }
    g.members.push(c);
    c.group = g;
    const rk = releaseKey(c.sub);
    if (!g.keys.has(rk)) {
      g.keys.add(rk);
      g.support += c.dub ? 0.5 : 1;
    }
  }

  // 2. Measure every source against the user's exact-file reference timing.
  const refs = (loadedRefs || [])
    .filter((r) => r && r.cues && r.cues.length >= 20)
    .map((r) => ({ sub: r.sub, sorted: r.cues.map((q) => q.start / 1000).sort((a, b) => a - b) }));
  if (refs.length) {
    for (const c of cands) {
      c.fit = null;
      for (const r of refs) {
        const f = globalFitAuto(r.sorted, c.sorted);
        if (!c.fit || f.rate > c.fit.rate) {
          c.fit = f;
          c.ref = r;
        }
      }
    }
    // Piecewise re-timing only for the most promising partial matches, and
    // only kept when it clearly beats a single shift.
    const partial = cands
      .filter((c) => c.fit.rate >= 0.35 && c.fit.rate < 0.9)
      .sort((a, b) => b.fit.rate - a.fit.rate)
      .slice(0, 3);
    for (const c of partial) {
      const offs = localOffsets(c.ref.sorted, c.raw, c.fit.scale);
      if (!offs) continue;
      const retimed = c.raw.map((t, i) => t * c.fit.scale + offs[i]).sort((a, b) => a - b);
      const rate = matchRate(c.ref.sorted, retimed, 0);
      if (rate >= c.fit.rate + 0.1) c.fit = { rate, scale: c.fit.scale, offset: 0, offsets: offs };
    }
    const bestC = cands.reduce((a, b) => (b.fit.rate > a.fit.rate ? b : a));
    if (bestC.fit.rate >= 0.6) {
      plan.mode = 'reference';
      plan.refNote = `${bestC.ref.sub.lang || '?'}:${bestC.ref.sub.id}`;
    } else {
      // The reference agrees with none of the English files — don't trust it.
      plan.refNote = `ignored (best match ${Math.round(bestC.fit.rate * 100)}%)`;
    }
  }

  // 3. Score.
  const docs = cands.map((c) => nameTokens(describe(c.sub)));
  const df = new Map();
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) || 0) + 1);
  const limit = Math.max(1, Math.floor(cands.length * 0.4));
  const distinctive = (t) => (df.get(t) || 0) > 0 && (df.get(t) || 0) <= limit;
  const userTok = [...nameTokens(userName)].filter(distinctive);
  const maxSupport = Math.max(...groups.map((g) => g.support));
  cands.forEach((c, i) => {
    const mine = docs[i];
    c.tokens = [...mine].filter(distinctive);
    c.family = familyMatch(c, opts.family);
    const overlap = userTok.filter((t) => mine.has(t)).length;
    const penalty = (c.dub ? 0.2 : 0) + (c.hi ? 0.03 : 0) - (isReady(c.sub) ? 0.02 : 0);
    c.score =
      plan.mode === 'reference'
        ? c.fit.rate - penalty + (c.family ? 0.01 : 0)
        : (c.group.support + 0.5 * Math.min(2, overlap)) / (maxSupport + 1) + (c.family ? 1 : 0) - penalty;
  });

  // 4. Best first, then the best of each other timing group.
  const toVariant = (c) => {
    const f = plan.mode === 'reference' ? c.fit : null;
    let retime = null;
    if (f && f.rate >= 0.6) {
      if (f.offsets) retime = { scale: f.scale, offsets: f.offsets.map((o) => Math.round(o * 1000)) };
      else if (Math.abs(f.offset) >= 0.1 || f.scale !== 1) retime = { scale: f.scale, offset: Math.round(f.offset * 1000) };
    }
    return {
      sub: c.sub,
      rate: f ? f.rate : null,
      verified: !!(f && f.rate >= 0.9),
      retime,
      dub: c.dub,
      hi: c.hi,
      family: c.family,
      group: groups.indexOf(c.group) + 1,
      support: c.group.support,
      tokens: c.tokens,
      cueCount: c.cues.length,
    };
  };
  const ordered = cands.slice().sort((a, b) => b.score - a.score || a.order - b.order);
  const used = new Set();
  for (const c of ordered) {
    if (used.has(c.group)) continue;
    used.add(c.group);
    plan.variants.push(toVariant(c));
    if (plan.variants.length >= maxVariants) break;
  }
  plan.all = ordered.map(toVariant);
  // Verified on the user's own file: remember the whole timing group so other
  // episodes of the series can find the same release without a reference.
  // Tokens that also appear in the user's own filename are title words (e.g.
  // "shingeki", "kyojin"), not release names, so they are left out.
  const top = ordered[0];
  if (plan.mode === 'reference' && top.fit.rate >= 0.9) {
    const titleWords = nameTokens(userName);
    plan.family = top.group.members
      .filter((m) => m.fit && m.fit.rate >= 0.9 && !m.dub)
      .map((m) => ({ id: String(m.sub.id), tokens: m.tokens.filter((t) => t.length >= 3 && !titleWords.has(t)) }));
  }
  return plan;
}

module.exports = {
  parseSrt,
  serializeSrt,
  fmtTime,
  rtl,
  applyRetime,
  matchRate,
  globalFit,
  globalFitAuto,
  localOffsets,
  sameTiming,
  isDub,
  isHI,
  nameTokens,
  sourceTag,
  rankSources,
};
