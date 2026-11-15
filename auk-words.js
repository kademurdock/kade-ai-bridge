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
/* The worker refuses a crop over 30 s, and the crop is the range plus 1 s each side. */
const MAX_RANGE_S = 28;
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

/* ---------- free text that asks for a word change ---------- */
/* A word change written as free text (Nov 14 2026). Quoted pairs ("Replace 'a' with 'b'",
 * 'Sing "x" instead of "y"', '"a" -> "b"'), the same forms as the worker's _WORD_CHANGE; and the
 * unquoted forms the worker lets through: "Replace Tuesday with Thursday", "Swap Tuesday for
 * Thursday", "Make it say Thursday instead of Tuesday", "Change the word(s)/lyric(s) ...".
 * A clause about the sound (noise, voice, timbre, mood, pace ...) is a style edit and passes, so
 * "Change the mood to cheerful" and AuK's timbre template still go through. The fork, the bridge
 * and the tests in both keep this rule word for word the same. */
const WC_Q = '(?:(?<![A-Za-z])\'(?:[^\'\\n]|(?<=[A-Za-z])\'(?=[A-Za-z]))+\'(?![A-Za-z])|"[^"\\n]+"|\u2018[^\u2019\\n]+\u2019|\u201c[^\u201d\\n]+\u201d)';
const WC_QUOTED = [
  new RegExp(`\\b(?:replace|change|swap|switch|substitute)\\b[^.\\n]{0,40}?${WC_Q}[^.\\n]{0,20}?\\b(?:with|to|into|for|by)\\b\\s*${WC_Q}`, 'i'),
  new RegExp(`\\b(?:say|says|saying|sing|sings|singing)\\b[^.\\n]{0,40}?${WC_Q}\\s*,?\\s*instead\\s+of\\s+${WC_Q}`, 'i'),
  new RegExp(`${WC_Q}\\s*(?:->|\u2192|=>)\\s*${WC_Q}`),
];
const WC_NAMED = /\b(?:change|edit|fix|rewrite|alter|replace|swap)\s+(?:the\s+|a\s+|these\s+|this\s+|that\s+|some\s+|her\s+|his\s+|my\s+|one\s+)?(?:words?|lyrics?|lines?|phrase)\b/i;
const WC_STYLE = /\b(?:noise|music|background|reverb\w*|echo|hum|hiss|room|voice|timbre|accent|tone|emotion|mood|style|pitch|speed|pace|tempo|volume|soft\w*|loud\w*|quiet\w*|whisper\w*|breath\w*)\b/i;
const WC_PLAIN = [
  /\b(?:replace|swap|switch|substitute)\s+\S.{0,60}?\s(?:with|for|by)\s+\S/i,
  /\b(?:say|says|saying|sing|sings|singing)\s+\S.{0,60}?\binstead\s+of\s+\S/i,
];

function looksLikeWordChange(instruction) {
  const text = String(instruction || '');
  if (WC_QUOTED.some((r) => r.test(text)) || WC_NAMED.test(text)) return true;
  return text.split(/[.;!?\n]+/).some((clause) => !WC_STYLE.test(clause) && WC_PLAIN.some((r) => r.test(clause)));
}
const REFUSE_FREE_WORDS = 'To change words, use Change words: type the words it says now, the new words, and where they are. AuK only follows its trained wording, so free text cannot change words.';

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

/* ---------- WAV: the edited stretch, cut here ----------
 * The worker returns crop_start and each take's edited_seconds. The edited stretch of a take is
 * crop_start .. crop_start + edited_seconds of its WAV. The bridge has no ffmpeg, so the stretch is
 * cut from the PCM directly, with HTTP Range when the store honours it, and sent to MiMo as 16-bit
 * mono. That keeps long recordings short to listen to and lets the old words be checked too. */

/** Format, layout and data offset of a WAV, from its first bytes. Null when it is not a PCM WAV. */
function wavInfo(buffer) {
  if (buffer.length < 12 || buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString('latin1', pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      let format = buffer.readUInt16LE(body);
      if (format === 0xfffe && size >= 26 && body + 26 <= buffer.length) format = buffer.readUInt16LE(body + 24);
      fmt = { format, channels: buffer.readUInt16LE(body + 2), rate: buffer.readUInt32LE(body + 4), blockAlign: buffer.readUInt16LE(body + 12), bits: buffer.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt || !fmt.channels || !fmt.rate || !fmt.blockAlign) return null;
      const okPcm = (fmt.format === 1 && [16, 24, 32].includes(fmt.bits)) || (fmt.format === 3 && [32, 64].includes(fmt.bits));
      if (!okPcm || fmt.blockAlign !== fmt.channels * fmt.bits / 8) return null;
      return { ...fmt, dataOffset: body, dataBytes: size };
    }
    pos = body + size + (size % 2);
  }
  return null;
}

function wavSeconds(buffer) {
  const info = wavInfo(buffer);
  if (!info) return null;
  return Math.min(info.dataBytes, buffer.length - info.dataOffset) / info.blockAlign / info.rate;
}

/** Whole frames of PCM -> a 16-bit mono WAV. */
function monoWav(frames, info) {
  const width = info.bits / 8;
  const count = Math.floor(frames.length / info.blockAlign);
  const out = Buffer.alloc(44 + count * 2);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let c = 0; c < info.channels; c++) {
      const at = i * info.blockAlign + c * width;
      let v;
      if (info.format === 3) v = width === 4 ? frames.readFloatLE(at) : frames.readDoubleLE(at);
      else if (width === 2) v = frames.readInt16LE(at) / 32768;
      else if (width === 3) v = frames.readIntLE(at, 3) / 8388608;
      else v = frames.readInt32LE(at) / 2147483648;
      sum += v;
    }
    const v = Math.max(-1, Math.min(1, sum / info.channels));
    out.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  out.write('RIFF', 0, 'latin1'); out.writeUInt32LE(36 + count * 2, 4); out.write('WAVE', 8, 'latin1');
  out.write('fmt ', 12, 'latin1'); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(info.rate, 24); out.writeUInt32LE(info.rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36, 'latin1'); out.writeUInt32LE(count * 2, 40);
  return out;
}

const HEAD_BYTES = 131072;
const MAX_WAV_BYTES = 256 * 1024 * 1024;

/** startS..endS of the WAV at `url`, as a small mono WAV. Uses Range requests; a store that
 * ignores Range sends the whole file, which is then cut in memory. */
async function wavStretch(axios, url, startS, endS) {
  const get = (range) => axios.get(url, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: MAX_WAV_BYTES,
    headers: { 'User-Agent': UA, Range: range }, validateStatus: (code) => code === 200 || code === 206 });
  const head = await get(`bytes=0-${HEAD_BYTES - 1}`);
  const headBuf = Buffer.from(head.data);
  const info = wavInfo(headBuf);
  if (!info) throw new Error('the take is not a WAV the bridge can cut');
  const first = Math.max(0, Math.floor(startS * info.rate));
  const last = Math.ceil(endS * info.rate);
  if (last <= first) throw new Error('the edited stretch is empty');
  const from = info.dataOffset + first * info.blockAlign;
  let to = info.dataOffset + last * info.blockAlign;
  if (info.dataBytes > 0 && info.dataBytes < 0xffffffff) to = Math.min(to, info.dataOffset + info.dataBytes);
  let frames;
  if (head.status !== 206 || headBuf.length >= to) {
    frames = headBuf.subarray(from, Math.min(to, headBuf.length));
  } else {
    const body = await get(`bytes=${from}-${to - 1}`);
    const buf = Buffer.from(body.data);
    frames = body.status === 206 ? buf : buf.subarray(from, Math.min(to, buf.length));
  }
  if (frames.length < info.blockAlign) throw new Error('the edited stretch is past the end of the take');
  return monoWav(frames.subarray(0, frames.length - (frames.length % info.blockAlign)), info);
}

function listenHosts(env) {
  return String(env.AUK_WORDS_HOSTS || 'Makora,Novita').split(',').map((h) => h.trim()).filter(Boolean);
}

/** Enough reply room for every word: about 8 tokens a second of audio, 400 to 4000. */
function listenTokens(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 400;
  return Math.max(400, Math.min(4000, Math.ceil(seconds * 8) + 64));
}

/** MiMo Flash hears one take. Her recording is a user's audio, so zero-retention hosts only. */
async function mimoHear(axios, buffer, env = process.env, { seconds } = {}) {
  const key = env.OPENROUTER_KEY || env.OPENROUTER_API_KEY || '';
  if (!key) throw new Error('no OpenRouter key on the bridge');
  const hosts = listenHosts(env);
  const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: env.AUK_WORDS_LISTENER_MODEL || 'xiaomi/mimo-v2.6-flash',
    messages: [{ role: 'user', content: [
      { type: 'text', text: LISTEN_PROMPT },
      { type: 'input_audio', input_audio: { data: buffer.toString('base64'), format: audioFormat(buffer) } },
    ] }],
    max_tokens: listenTokens(Number.isFinite(seconds) ? seconds : wavSeconds(buffer)),
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

const isHttps = (u) => typeof u === 'string' && /^https:\/\/\S+$/i.test(u);

async function wholeFile(axios, url) {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: MAX_AUDIO_BYTES, headers: { 'User-Agent': UA } });
  return Buffer.from(r.data);
}

/** The bytes a take is judged on, in this order: the clip the worker sent (clip_b64/clip_url); the
 * edited stretch cut from its WAV (crop_start + edited_seconds); the whole take.
 * Returns { buffer, whole, seconds }. */
async function takeAudio(axios, candidate, geometry = {}) {
  if (typeof candidate.clip_b64 === 'string' && candidate.clip_b64.length) {
    const buffer = Buffer.from(candidate.clip_b64, 'base64');
    if (buffer.length > MAX_AUDIO_BYTES) throw new Error('clip too large to listen to');
    return { buffer, whole: false };
  }
  if (isHttps(candidate.clip_url)) return { buffer: await wholeFile(axios, candidate.clip_url), whole: false };
  const cropStart = Number(geometry.cropStart);
  const edited = Number(candidate.edited_seconds);
  if (geometry.cropStart != null && Number.isFinite(cropStart) && cropStart >= 0 && Number.isFinite(edited) && edited > 0 && isHttps(candidate.wav_url)) {
    try {
      const buffer = await wavStretch(axios, candidate.wav_url, cropStart, cropStart + edited);
      return { buffer, whole: false, seconds: edited };
    } catch (e) { /* fall through to the whole take */ }
  }
  if (typeof candidate.b64 === 'string' && candidate.b64.length) {
    const buffer = Buffer.from(candidate.b64, 'base64');
    if (buffer.length > MAX_AUDIO_BYTES) throw new Error('take too large to listen to');
    return { buffer, whole: true, seconds: candidate.duration_s };
  }
  const url = [candidate.url, candidate.audio_url].find(isHttps);
  if (!url) throw new Error('take has no audio to listen to');
  return { buffer: await wholeFile(axios, url), whole: true, seconds: candidate.duration_s };
}

/** Times a phrase is said, without overlaps. */
function countRuns(words, phrase) {
  if (!phrase.length) return 0;
  let n = 0;
  for (let i = 0; i + phrase.length <= words.length;) {
    let hit = true;
    for (let j = 0; j < phrase.length; j++) if (words[i + j] !== phrase[j]) { hit = false; break; }
    if (hit) { n++; i += phrase.length; } else i++;
  }
  return n;
}

/** Ask twice before giving up: a 429 or a timeout is often gone a moment later. */
async function hearTwice(listen, buffer, extra, pauseMs = 1500) {
  try { return await listen(buffer, extra); }
  catch (e) {
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
    return listen(buffer, extra);
  }
}

const saveable = (c) => typeof (c.url || c.audio_url) === 'string' && /^https?:\/\//i.test(c.url || c.audio_url);
const quote = (s) => `"${String(s).slice(0, 80)}"`;

/**
 * Listen to every take and pick one. Returns { best, report }. `best` is null when no take said
 * the new words (or none can be saved). Never throws.
 * - A take is heard over its edited stretch when it can be, else whole.
 * - A whole take is compared with her original, heard once: the take must say the new words one
 *   more time than the original does. Without the original, a whole take cannot be judged.
 * - A take nobody could hear (MiMo failed twice, no worker transcript) is never counted as a miss.
 *   When no heard take matched and one could not be heard, that one is kept, marked unchecked.
 * Options: geometry { cropStart }, sourceUrl, asked (takes asked for), legacy (older worker).
 */
async function rankCandidates(candidates, edit, { axios, env = process.env, hear, geometry = {}, sourceUrl = null, asked = null, legacy = false, retryPauseMs = 1500 } = {}) {
  const listen = hear || ((buffer, extra) => mimoHear(axios, buffer, env, extra));
  const takes = [];
  let listenUSD = 0;
  const fresh = normalWords(edit.newText);
  const stale = normalWords(edit.oldText);
  let baseline;
  const original = async () => {
    if (baseline !== undefined) return baseline;
    baseline = null;
    if (!isHttps(sourceUrl)) return baseline;
    try {
      const buffer = await wholeFile(axios, sourceUrl);
      const heard = await hearTwice(listen, buffer, {}, retryPauseMs);
      listenUSD += heard.costUSD || 0;
      const words = normalWords(heard.text);
      baseline = { newCount: countRuns(words, fresh), oldCount: countRuns(words, stale) };
    } catch (e) { baseline = null; }
    return baseline;
  };
  for (const [i, c] of (candidates || []).entries()) {
    if (!c || typeof c !== 'object') continue;
    const take = { index: i, seed: Number.isInteger(c.seed) ? c.seed : null, heard: '', source: null, matched: false, score: 0, saveable: saveable(c) };
    let whole = false;
    try {
      const audio = await takeAudio(axios, c, geometry);
      whole = audio.whole;
      const heard = await hearTwice(listen, audio.buffer, { seconds: audio.seconds }, retryPauseMs);
      listenUSD += heard.costUSD || 0;
      take.heard = heard.text; take.source = 'mimo';
    } catch (e) {
      take.listenError = String(e.message || e).slice(0, 160);
      /* The worker's own transcript is of the generated stretch, not the whole take. */
      if (typeof c.transcript === 'string' && c.transcript.trim()) { take.heard = cleanText(c.transcript); take.source = 'worker'; whole = false; }
    }
    if (take.source) {
      Object.assign(take, judge(take.heard, edit, { whole }), { scope: whole ? 'whole take' : 'edited stretch' });
      if (whole) {
        /* The original may already say the new words somewhere ("Tuesday" -> "Thursday" when
         * "Thursday" comes later). A whole take only counts when it says them once more. */
        const base = await original();
        if (!base) { take.unsure = true; take.matched = false; }
        else {
          take.matched = countRuns(normalWords(take.heard), fresh) > base.newCount;
          take.originalSaysNew = base.newCount;
        }
      }
    }
    takes.push(take);
  }
  const usable = takes.filter((t) => t.saveable);
  const heardUsable = usable.filter((t) => t.source && !t.unsure);
  const unheard = usable.filter((t) => !t.source || t.unsure);
  const ranked = [...usable].sort((a, b) => (b.matched - a.matched) || (b.score - a.score) || (a.index - b.index));
  const n = takes.length;
  let best = null;
  let checked = false;
  let spoken;
  const why = (t) => t.unsure ? 'could not compare' : 'could not listen back to';
  if (!usable.length) {
    spoken = 'The worker sent no take that could be saved. Your original recording is unchanged.';
  } else if (ranked[0].matched) {
    best = ranked[0]; checked = true;
    const others = takes.filter((t) => t.matched).length - 1;
    spoken = `Changed ${quote(edit.oldText)} to ${quote(edit.newText)}. I made ${n} take${n === 1 ? '' : 's'} and kept take ${best.index + 1}, which says the new words${others > 0 ? ` (${others} other${others === 1 ? '' : 's'} did too)` : ''}. It heard: ${quote(best.heard)}.`;
  } else if (unheard.length) {
    best = unheard[0];
    spoken = heardUsable.length
      ? `None of the takes I could hear said ${quote(edit.newText)}. I ${why(best)} take ${best.index + 1} of ${n}${best.unsure ? ' with your original' : ''}, so I kept that one. Listen before you use it.`
      : `Changed ${quote(edit.oldText)} to ${quote(edit.newText)}, but I ${best.unsure ? 'could not compare the take with your original' : 'could not listen back'} to check the words this time. I kept take ${best.index + 1} of ${n}. Listen before you use it.`;
  } else {
    checked = true;
    const nearest = ranked[0];
    spoken = `None of the ${n} take${n === 1 ? '' : 's'} said ${quote(edit.newText)}. Your original recording is unchanged and no new take was saved.` +
      (nearest.heard ? ` The closest one said: ${quote(nearest.heard)}.` : '') +
      ' Try a range a second wider around the words, or render again for fresh takes.';
  }
  if (legacy && Number.isInteger(asked) && asked > 1) spoken += ` The worker running now makes one take per change, not ${asked}.`;
  else if (Number.isInteger(asked) && n > 0 && n < asked) spoken += ` ${asked - n} of the ${asked} takes failed on the worker.`;
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

module.exports = { wordTemplate, wordEditInput, seedList, normalWords, judge, rankCandidates, candidatesOf, mimoHear, audioFormat, wavInfo, wavStretch, monoWav, listenTokens, countRuns, looksLikeWordChange, REFUSE_FREE_WORDS, MAX_SEEDS, DEFAULT_SEEDS, MAX_RANGE_S, MIN_RANGE_S };
