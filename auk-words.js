'use strict';
/* auk-words.js — Change words on AuK: what the worker is sent, and which take is kept (Nov 14 2026).
 *
 * Why this exists (AUK_EDIT_DIAGNOSIS.md, Nov 14): AuK only follows its trained edit templates,
 * one change per instruction, and the booth used to send whatever she typed, over the whole
 * recording, on the project's one fixed seed. Words never changed. The fix:
 *   - the fork sends ONE change at a time as data: kind, oldText, newText, rangeStart, rangeEnd,
 *     seeds. Free-form text never reaches the worker on a word edit; the template is built here.
 *   - the worker renders one take per seed and returns them all as `candidates`.
 *   - this file listens to each take (MiMo Flash on OpenRouter, her rule for transcription) and
 *     keeps the one that says the new words. If none does, the job ends without a new take and
 *     says so plainly; her original recording is untouched.
 * Contract: F:/KadeAI-work/auk-20261114/CONTRACT.md. */

const crypto = require('crypto');

const MAX_TEXT = 200;
const MAX_SEEDS = 4;
const DEFAULT_SEEDS = 3;
const MIN_RANGE_S = 0.5;
const MAX_RANGE_S = 30;
const MAX_AUDIO_BYTES = 14 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const LISTEN_PROMPT = 'Transcribe every word spoken or sung in this audio exactly as heard, in order. If a word is said more than once, write it each time. Reply with the words only.';

const freshSeed = () => crypto.randomInt(1, 2147483647);

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** AuK's own templates (pe.config.yaml): sung is the vocal_edit template, spoken the speech one. */
function wordTemplate(kind, oldText, newText) {
  if (kind === 'vocal') {
    const q = (s) => s.replace(/"/g, '');
    return `Change "${q(oldText)}" to "${q(newText)}" in the vocal recording.`;
  }
  return `Replace '${oldText}' with '${newText}'.`;
}

/** Seeds: a list of whole numbers (kept, deduped, at most four) or a count (fresh ones drawn). */
function seedList(value) {
  if (Array.isArray(value)) {
    const list = [...new Set(value.filter((n) => Number.isInteger(n) && n >= 0 && n <= 2147483647))].slice(0, MAX_SEEDS);
    return list.length ? list : null;
  }
  const count = value == null ? DEFAULT_SEEDS : value;
  if (!Number.isInteger(count) || count < 1 || count > MAX_SEEDS) return null;
  const list = new Set();
  while (list.size < count) list.add(freshSeed());
  return [...list];
}

/** A word edit asked for by the fork, checked. Returns { edit } or { error }. */
function wordEditInput(options = {}) {
  const kind = options.kind === 'vocal' ? 'vocal' : options.kind === 'speech' ? 'speech' : null;
  if (!kind) return { error: 'Say whether the words are spoken or sung.' };
  const oldText = cleanText(options.oldText);
  const newText = cleanText(options.newText);
  if (!oldText || !newText) return { error: 'Type the words it says now and the new words.' };
  if (oldText.length > MAX_TEXT || newText.length > MAX_TEXT) return { error: `Keep each side of a word change under ${MAX_TEXT} characters.` };
  if (normalWords(oldText).join(' ') === normalWords(newText).join(' ')) return { error: 'The new words are the same as the old ones.' };
  const { rangeStart, rangeEnd } = options;
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeStart < 0 || rangeEnd <= rangeStart) {
    return { error: 'Give the change a start and an end in seconds, with the end after the start.' };
  }
  if (rangeEnd - rangeStart < MIN_RANGE_S || rangeEnd - rangeStart > MAX_RANGE_S) {
    return { error: `Choose between ${MIN_RANGE_S} and ${MAX_RANGE_S} seconds around the words.` };
  }
  const seeds = seedList(options.seeds);
  if (!seeds) return { error: `Ask for between 1 and ${MAX_SEEDS} takes.` };
  return { edit: { kind, oldText, newText, rangeStart, rangeEnd, seeds } };
}

/* ---------- hearing the words ---------- */

/** Lower case, accents off, punctuation off: "Don't stop!" and "dont stop" compare equal. */
function normalWords(text) {
  return String(text || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim().split(/\s+/).filter(Boolean);
}

function containsRun(words, phrase) {
  if (!phrase.length || phrase.length > words.length) return false;
  outer: for (let i = 0; i + phrase.length <= words.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (words[i + j] !== phrase[j]) continue outer;
    return true;
  }
  return false;
}

/** Longest common subsequence length, for a partial-credit score. */
function lcs(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1]);
      prev = keep;
    }
  }
  return row[b.length];
}

/** Did this transcript say the new words, and not the old ones?
 * `whole`: the transcript is of the whole recording, not the edited stretch. The old words may
 * rightly be said somewhere else in it (her Oct 5 clip held the phrase twice), so then only the
 * new words are looked for. */
function judge(transcript, edit, { whole = false } = {}) {
  const heard = normalWords(transcript);
  const fresh = normalWords(edit.newText);
  const stale = normalWords(edit.oldText);
  const saysNew = containsRun(heard, fresh);
  /* "Tuesday" -> "Tuesday night": the old words live inside the new ones, so hearing them proves nothing. */
  const oldInsideNew = containsRun(fresh, stale);
  const saysOld = !whole && !oldInsideNew && containsRun(heard, stale);
  const score = fresh.length ? lcs(heard, fresh) / fresh.length : 0;
  return { matched: saysNew && !saysOld, saysNew, saysOld, score: Math.round((score - (saysOld ? 0.5 : 0)) * 1000) / 1000 };
}

function audioFormat(buffer) {
  const head = buffer.subarray(0, 4).toString('latin1');
  if (head === 'RIFF') return 'wav';
  if (head === 'fLaC') return 'flac';
  if (head === 'OggS') return 'ogg';
  return 'mp3';
}

function listenHosts(env) {
  return String(env.AUK_WORDS_HOSTS || 'Makora,Novita').split(',').map((h) => h.trim()).filter(Boolean);
}

/** MiMo Flash hears one take. Her recording is a user's audio, so zero-retention hosts only. */
async function mimoHear(axios, buffer, env = process.env) {
  const key = env.OPENROUTER_KEY || env.OPENROUTER_API_KEY || '';
  if (!key) throw new Error('no OpenRouter key on the bridge');
  const hosts = listenHosts(env);
  const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: env.AUK_WORDS_LISTENER_MODEL || 'xiaomi/mimo-v2.6-flash',
    messages: [{ role: 'user', content: [
      { type: 'text', text: LISTEN_PROMPT },
      { type: 'input_audio', input_audio: { data: buffer.toString('base64'), format: audioFormat(buffer) } },
    ] }],
    max_tokens: 400,
    temperature: 0,
    reasoning: { enabled: false },
    usage: { include: true },
    provider: { order: hosts, only: hosts, allow_fallbacks: false, zdr: true, data_collection: 'deny' },
  }, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': UA, 'HTTP-Referer': 'https://kademurdock.com', 'X-Title': 'Kade-AI bridge' },
    timeout: 45000,
  });
  const data = r.data || {};
  const text = cleanText(data.choices?.[0]?.message?.content || '');
  const promptTokens = data.usage?.prompt_tokens;
  /* A host that drops the audio still answers, from the prompt alone (DeepInfra, Oct 2026). The
   * prompt is about 40 tokens; anything not past it heard no audio. */
  if (Number.isFinite(promptTokens) && promptTokens < Math.ceil(LISTEN_PROMPT.length / 4) + 8) throw new Error(`the listener did not hear the audio (prompt tokens ${promptTokens})`);
  return { text, costUSD: typeof data.usage?.cost === 'number' ? data.usage.cost : 0 };
}

/** The bytes a take is judged on: the edited stretch when the worker sent it (clip_url/clip_b64),
 * else the whole take. Returns { buffer, whole }. */
async function takeAudio(axios, candidate) {
  const clip = typeof candidate.clip_b64 === 'string' && candidate.clip_b64.length ? candidate.clip_b64 : null;
  const b64 = clip || candidate.b64;
  if (typeof b64 === 'string' && b64.length) {
    const buffer = Buffer.from(b64, 'base64');
    if (buffer.length > MAX_AUDIO_BYTES) throw new Error('take too large to listen to');
    return { buffer, whole: !clip };
  }
  const isUrl = (u) => typeof u === 'string' && /^https:\/\/\S+$/i.test(u);
  const url = [candidate.clip_url, candidate.url, candidate.audio_url].find(isUrl);
  if (!url) throw new Error('take has no audio to listen to');
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: MAX_AUDIO_BYTES, headers: { 'User-Agent': UA } });
  return { buffer: Buffer.from(r.data), whole: url !== candidate.clip_url };
}

const saveable = (c) => typeof (c.url || c.audio_url) === 'string' && /^https?:\/\//i.test(c.url || c.audio_url);
const quote = (s) => `"${String(s).slice(0, 80)}"`;

/**
 * Listen to every take and pick one. Returns { best, report }. `best` is null when no take said
 * the new words (or none can be saved). Never throws: a take nobody could hear is judged on the
 * worker's own transcript, and failing that is left unchecked.
 */
async function rankCandidates(candidates, edit, { axios, env = process.env, hear } = {}) {
  const listen = hear || ((buffer) => mimoHear(axios, buffer, env));
  const takes = [];
  let listenUSD = 0;
  for (const [i, c] of (candidates || []).entries()) {
    if (!c || typeof c !== 'object') continue;
    const take = { index: i, seed: Number.isInteger(c.seed) ? c.seed : null, heard: '', source: null, matched: false, score: 0, saveable: saveable(c) };
    let whole = false;
    try {
      const audio = await takeAudio(axios, c);
      whole = audio.whole;
      const heard = await listen(audio.buffer);
      listenUSD += heard.costUSD || 0;
      take.heard = heard.text; take.source = 'mimo';
    } catch (e) {
      take.listenError = String(e.message || e).slice(0, 160);
      /* The worker's own transcript is of the generated stretch, not the whole take. */
      if (typeof c.transcript === 'string' && c.transcript.trim()) { take.heard = cleanText(c.transcript); take.source = 'worker'; whole = false; }
    }
    if (take.source) Object.assign(take, judge(take.heard, edit, { whole }), { scope: whole ? 'whole take' : 'edited stretch' });
    takes.push(take);
  }
  const usable = takes.filter((t) => t.saveable);
  const checked = usable.some((t) => t.source);
  const ranked = [...usable].sort((a, b) => (b.matched - a.matched) || (b.score - a.score) || (a.index - b.index));
  const n = takes.length;
  let best = null;
  let spoken;
  if (!usable.length) {
    spoken = 'The worker sent no take that could be saved. Your original recording is unchanged.';
  } else if (!checked) {
    best = ranked[0];
    spoken = `Changed ${quote(edit.oldText)} to ${quote(edit.newText)}, but I could not listen back to check the words this time. I kept take ${best.index + 1} of ${n}. Listen before you use it.`;
  } else if (ranked[0].matched) {
    best = ranked[0];
    const others = takes.filter((t) => t.matched).length - 1;
    spoken = `Changed ${quote(edit.oldText)} to ${quote(edit.newText)}. I made ${n} take${n === 1 ? '' : 's'} and kept take ${best.index + 1}, which says the new words${others > 0 ? ` (${others} other${others === 1 ? '' : 's'} did too)` : ''}. It heard: ${quote(best.heard)}.`;
  } else {
    const nearest = ranked[0];
    spoken = `None of the ${n} take${n === 1 ? '' : 's'} said ${quote(edit.newText)}. Your original recording is unchanged and no new take was saved.` +
      (nearest.heard ? ` The closest one said: ${quote(nearest.heard)}.` : '') +
      ' Try a range a second wider around the words, or render again for fresh takes.';
  }
  const report = {
    matched: !!(best && best.matched), checked, picked: best ? best.index : null, pickedSeed: best ? best.seed : null,
    takes: takes.map(({ saveable: _s, ...t }) => t), listenUSD: Math.round(listenUSD * 1e6) / 1e6, spoken,
  };
  return { best: best ? candidates[best.index] : null, report };
}

/** The worker's answer as a candidate list; an older worker's single take becomes one candidate. */
function candidatesOf(out) {
  if (Array.isArray(out?.candidates) && out.candidates.length) return out.candidates;
  if (out?.url) return [{ seed: out.seed, url: out.url, wav_url: out.wav_url, key: out.key, wav_key: out.wav_key, duration_s: out.duration_s, bytes: out.bytes, transcript: out.transcript }];
  return [];
}

module.exports = { wordTemplate, wordEditInput, seedList, normalWords, judge, rankCandidates, candidatesOf, mimoHear, audioFormat, MAX_SEEDS, DEFAULT_SEEDS, MAX_RANGE_S, MIN_RANGE_S };
