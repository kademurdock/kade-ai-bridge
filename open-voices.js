'use strict';
/* open-voices.js — VoxCPM2, Ming, Chatterbox and DramaBox voices on RunPod serverless (Nov 15-16 2026).
 *
 * Two open voice engines for the Sound Booth, with one job shape (worker voxcpm_contract.py and
 * ming_contract.py in F:/KadeAI-work/{voxcpm,ming}-20261115/worker):
 *   design: description + text, no clip. A new voice from words; every try is a new seed.
 *   clone:  reference_voice_url (our own B2 storage only) + text, optional style and prompt_text
 *           (the clip's exact words, clip at most 30 s).
 *   seed, text up to 5000 characters. Output { url, wav_url, duration_seconds, sample_rate, mode,
 *   seed, engine, key, wav_key, ... } or { error }.
 * The two workers name the two quality knobs differently (VoxCPM2 cfg_value / inference_timesteps,
 * Ming cfg_scale / flow_steps); the fork sends neither today, and `cfg` / `steps` map to each.
 *
 * Same pattern as scenema.js: RunPod /run, the bridge polls /status, the finished take lands in the
 * user's My Creations through the fork's asset lane (which mirrors it to our storage for good) and
 * its GPU time through the usage lane. Jobs and receipts live on the volume.
 *
 * Nov 16 2026: Chatterbox (worker chatterbox_contract.py: turbo / original / multilingual, built-in
 * voice or a clip at reference_url) and DramaBox (dramabox_contract.py: one prose scene as `prompt`,
 * words in double quotes spoken, the rest acted; optional clip). See CHATTERBOX / DRAMABOX below.
 *
 * Env: RUNPOD_API_KEY · VOXCPM_ENDPOINT_ID (default dewjq1ibxkp2c3) · MING_ENDPOINT_ID,
 * CHATTERBOX_ENDPOINT_ID, DRAMABOX_ENDPOINT_ID (no defaults; unset = that engine is hidden and
 * refused) · VOXCPM_RATE_PER_HR / MING_RATE_PER_HR / CHATTERBOX_RATE_PER_HR / DRAMABOX_RATE_PER_HR
 * (defaults 1.34 / 1.89 / 1.34 / 1.89) ·
 * OPEN_VOICES_DAILY_CAP_USD (1.00) / OPEN_VOICES_MONTHLY_CAP_USD (20) · OPEN_VOICES_QUEUE_TIMEOUT_MS
 * (15 min; Ming gets twice that) · OPEN_VOICES_RUN_CEILING_MS (20 min more, past which any job is given up) ·
 * OPEN_VOICES_AUDIO_HOSTS (extra storage hosts, comma list) ·
 * OPEN_VOICES_ENABLED=0 switches the lane off.
 *
 * Routes (bridge secret): POST /audio/open-voices/start, GET /audio/open-voices/status,
 * POST /audio/open-voices/cancel, GET /audio/open-voices/health. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SEED_MAX = 2147483647;
const MAX_TEXT = 5000;
const MAX_PROMPT_TEXT = 1000;
const RING = 200;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ENGINES = {
  voxcpm: {
    id: 'voxcpm', label: 'VoxCPM2', model: 'openbmb/VoxCPM2', service: 'voxcpm_audio',
    endpointEnv: 'VOXCPM_ENDPOINT_ID', defaultEndpoint: 'dewjq1ibxkp2c3', rateEnv: 'VOXCPM_RATE_PER_HR',
    maxPrefix: 400, cfg: { name: 'cfg_value', min: 0.5, max: 5 }, steps: { name: 'inference_timesteps', min: 4, max: 50 },
    queueFactor: 1, maxText: 5000, rate: '1.34', // top of its 16/24 GB pools (4090)
  },
  ming: {
    id: 'ming', label: 'Ming', model: 'inclusionAI/Ming-3.0-tts', service: 'ming_audio',
    endpointEnv: 'MING_ENDPOINT_ID', defaultEndpoint: '', rateEnv: 'MING_RATE_PER_HR',
    maxPrefix: 600, cfg: { name: 'cfg_scale', min: 1, max: 5 }, steps: { name: 'flow_steps', min: 4, max: 50 },
    queueFactor: 2, maxText: 2500, rate: '1.89', // top of its 48 GB pools (L40S) // Ming runs ~1.5 s per audio second; longer text passes the 600 s job limit
  },
  /* Nov 16 2026. Both off until their endpoint env is set (no default endpoint). Neither takes a
   * description or a style: Chatterbox's design is its own built-in voice; DramaBox's design is the
   * speaker the scene itself describes. */
  chatterbox: {
    id: 'chatterbox', label: 'Chatterbox', model: 'ResembleAI/chatterbox', service: 'chatterbox_audio',
    endpointEnv: 'CHATTERBOX_ENDPOINT_ID', defaultEndpoint: '', rateEnv: 'CHATTERBOX_RATE_PER_HR',
    queueFactor: 1, maxText: 5000, rate: '1.34', // top of its 24 GB pools (4090); worker chatterbox_contract.MAX_TEXT_CHARS
  },
  dramabox: {
    id: 'dramabox', label: 'DramaBox', model: 'ResembleAI/Dramabox', service: 'dramabox_audio',
    endpointEnv: 'DRAMABOX_ENDPOINT_ID', defaultEndpoint: '', rateEnv: 'DRAMABOX_RATE_PER_HR',
    queueFactor: 2, maxText: 4000, rate: '1.89', // 48 GB pools; a cold start loads ~16 GB of weights; dramabox_contract.MAX_PROMPT_CHARS
  },
};

/* Chatterbox (worker chatterbox_contract.py). One worker, three versions ("model"):
 *   turbo:        English, sound tags inline, temperature 0.05-2. Its clip must be over 5 s.
 *   original:     English, exaggeration 0.25-2, cfg_weight above 0 up to 1, temperature 0.05-5.
 *   multilingual: language_id (23 codes, required), exaggeration, cfg_weight 0-1, temperature 0.05-5.
 * The worker reads ANY [bracketed words] as a tag for Turbo and refuses an unknown one, so the bridge
 * does the same, in a plain sentence, before GPU time. */
const CHATTERBOX = {
  versions: ['turbo', 'original', 'multilingual'],
  versionLabels: { turbo: 'Turbo', original: 'Original', multilingual: 'Multilingual' },
  eventTags: ['[clear throat]', '[sigh]', '[shush]', '[cough]', '[groan]', '[sniff]', '[gasp]', '[chuckle]', '[laugh]'],
  styleTags: ['[angry]', '[fear]', '[surprised]', '[whispering]', '[advertisement]', '[dramatic]', '[narration]', '[crying]', '[happy]', '[sarcastic]'],
  aliases: ['laughs', 'laughing', 'laughter', 'chuckles', 'giggle', 'giggles', 'sighs', 'sighing', 'coughs', 'coughing', 'gasps', 'groans',
    'sniffs', 'sniffle', 'throat clear', 'clears throat', 'clearing throat', 'shh', 'whisper', 'whispers', 'cries', 'crying', 'sarcasm', 'surprise', 'scared'],
  languages: ['ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh'],
  temperature: { turbo: [0.05, 2], original: [0.05, 5], multilingual: [0.05, 5] },
  exaggeration: [0.25, 2],
  turboClipMinS: 5,
};
const CB_TAG_RE = /\[([^\[\]]{1,40})\]/g; // the worker's own pattern
const CB_KNOWN = new Set([...CHATTERBOX.eventTags, ...CHATTERBOX.styleTags].map((t) => t.slice(1, -1)).concat(CHATTERBOX.aliases));
const cbTagName = (raw) => raw.replace(/\s+/g, ' ').trim().toLowerCase();

/* DramaBox (worker dramabox_contract.py): one prose scene. Words inside straight double quotes are
 * spoken; the rest is performed. Curly quotes count as straight ones (the worker swaps them). */
const DRAMABOX = { maxDuration: 45, minDuration: 3, referenceSeconds: [3, 30] };
const CURLY_QUOTES = /[“”„‟«»]/g;
/* The spoken lines of a scene, in order (what a saved voice's clip actually says). */
function spokenLines(scene) {
  return [...String(scene || '').replace(CURLY_QUOTES, '"').matchAll(/"([^"]+)"/g)].map((m) => m[1].trim()).filter(Boolean).join(' ');
}

const numberOf = (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : v);
const isSet = (v) => v !== undefined && v !== null && v !== '';

/* Chatterbox's fields on a booth request -> worker fields, or { error }. */
function chatterboxFields(b, input) {
  const version = isSet(b.version) ? String(b.version).trim().toLowerCase() : 'turbo';
  if (!CHATTERBOX.versions.includes(version)) return { error: 'Pick Turbo, Original or Multilingual for the version.' };
  const name = CHATTERBOX.versionLabels[version];
  const fields = { model: version };
  let unknown = '';
  let tagged = false;
  for (const m of input.text.matchAll(CB_TAG_RE)) {
    if (CB_KNOWN.has(cbTagName(m[1]))) tagged = true;
    else if (!unknown) unknown = m[0];
  }
  if (version === 'turbo') {
    if (unknown) return { error: `Chatterbox Turbo does not know the sound tag ${unknown}. Pick one from Sound tags, or take it out.` };
    if (!input.text.replace(CB_TAG_RE, '').replace(/[\s.,!?]/g, '')) return { error: 'Type some words to say, not only sound tags.' };
  } else if (tagged) return { error: 'Sound tags work only with Chatterbox Turbo. Take them out, or set the version to Turbo.' };
  const temperature = numberOf(b.temperature);
  if (isSet(temperature)) {
    const [lo, hi] = CHATTERBOX.temperature[version];
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < lo || temperature > hi) return { error: `Variety must be a number from ${lo} to ${hi} for ${name}.` };
    fields.temperature = temperature;
  }
  const exaggeration = numberOf(b.exaggeration);
  const cfg = numberOf(b.cfg_weight);
  if (version === 'turbo') {
    if (isSet(exaggeration) || isSet(cfg)) return { error: 'Expressiveness and steadiness are for Original and Multilingual. Turbo does not use them.' };
  } else {
    if (isSet(exaggeration)) {
      const [lo, hi] = CHATTERBOX.exaggeration;
      if (typeof exaggeration !== 'number' || !Number.isFinite(exaggeration) || exaggeration < lo || exaggeration > hi) return { error: `Expressiveness must be a number from ${lo} to ${hi}.` };
      fields.exaggeration = exaggeration;
    }
    if (isSet(cfg)) {
      const zeroOk = version === 'multilingual';
      if (typeof cfg !== 'number' || !Number.isFinite(cfg) || cfg > 1 || cfg < 0 || (cfg === 0 && !zeroOk)) {
        return { error: zeroOk ? 'Steadiness must be a number from 0 to 1.' : 'Steadiness must be above 0 and at most 1 for Original.' };
      }
      fields.cfg_weight = cfg;
    }
  }
  const lang = isSet(b.language_id) ? String(b.language_id).trim().toLowerCase() : '';
  if (version === 'multilingual') {
    if (!CHATTERBOX.languages.includes(lang)) return { error: 'Pick a language for Multilingual.' };
    fields.language_id = lang;
  } else if (lang && lang !== 'en') return { error: `${name} speaks English only. Set the version to Multilingual for other languages.` };
  return { fields };
}

/* DramaBox's fields on a booth request -> worker fields, or { error }. The scene goes as `prompt`. */
function dramaboxFields(b, input) {
  const scene = input.text.replace(CURLY_QUOTES, '"');
  if ((scene.match(/"/g) || []).length % 2) return { error: 'A quote mark in the scene is not closed. Put every spoken line inside double quotes.' };
  if (!spokenLines(scene)) return { error: 'The scene needs at least one spoken line inside double quotes. Words outside the quotes are acted, not spoken.' };
  const fields = { watermark: false }; // full quality; the LTX-2 licence does not ask for a watermark
  const duration = numberOf(b.duration);
  if (isSet(duration) && duration !== 0) {
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < DRAMABOX.minDuration || duration > DRAMABOX.maxDuration) {
      return { error: `Scene length must be from ${DRAMABOX.minDuration} to ${DRAMABOX.maxDuration} seconds, or empty to let DramaBox decide.` };
    }
    fields.duration = duration;
  }
  const refS = numberOf(b.reference_seconds);
  if (isSet(refS)) {
    const [lo, hi] = DRAMABOX.referenceSeconds;
    if (input.mode !== 'clone') return { error: 'How much of the clip to use is for Speak with a voice.' };
    if (typeof refS !== 'number' || !Number.isFinite(refS) || refS < lo || refS > hi) return { error: `Use from ${lo} to ${hi} seconds of the clip.` };
    fields.reference_seconds = refS;
  }
  return { fields };
}

/* Ming's extra controls (worker ming_contract.py). Ming runs one task per take and refuses a mix,
 * so the bridge checks the same rules first and says them plainly:
 *   design: `voice` (a built-in voice) instead of a description -> ip.
 *   clone:  `emotion` -> emotion; `speed` / `pitch` / `volume` -> basic; `style` -> freeform; one of
 *           the three per take. prompt_text -> seed, or paralinguistic when the words carry sound
 *           tags, or multilingual for de es fr ko ja (`language`). Tags and those languages need
 *           prompt_text and no style or controls.
 * Built-in voices: upstream tts_tasks.EN_IP_VOICES at a39b806 (inclusionAI/Ming-3.0-tts), plus the
 * two Chinese voices its README recommends. Never sent to VoxCPM2. */
const MING = {
  voices: ['US_Emma', 'UK_George', 'UK_Charlotte', '灵小柔', '灵楷'],
  emotions: ['happy', 'sad', 'angry', 'neutral', 'surprised', 'fearful', 'disgusted'],
  speeds: ['slow', 'medium', 'fast'],
  levels: ['low', 'medium', 'high'],
  languages: ['en', 'zh', 'de', 'es', 'fr', 'ko', 'ja'],
  /* ming_tiny.task_protocol.PARALINGUISTIC_TAGS, and the other spellings the worker rewrites. */
  tags: ['[Breathing]', '[Cough]', '[Sigh]', '[Laughter]', '[Surprise-ah]', '[Surprise-oh]', '[Dissatisfaction-hnn]', '[Uhm]',
    '[Confirmation-en]', '[Question-ei]', '[Question-ah]', '[Question-en]', '[Question-oh]', '[Question-huh]'],
  aliases: ['laugh', 'laughs', 'laughing', 'chuckle', 'chuckles', 'giggle', 'giggles', 'sighs', 'sighing', 'coughs', 'coughing',
    'breath', 'breathes', 'breathe', 'inhale', 'inhales', 'exhale', 'exhales', 'um', 'uh', 'umm', 'hmm', 'huh'],
};
/* Spoken names for the built-in voices (the fork's MING_CONTROLS labels), so My Creations reads
 * "Built-in voice: Ling Xiaorou, Chinese, young woman", not raw ids a screen reader stumbles on.
 * The raw id stays in metadata.openVoice.controls. */
const VOICE_LABELS = {
  US_Emma: 'Emma, American English, woman', UK_George: 'George, British English, man', UK_Charlotte: 'Charlotte, British English, woman',
  '\u7075\u5c0f\u67d4': 'Ling Xiaorou, Chinese, young woman', '\u7075\u6977': 'Ling Kai, Chinese, young man',
};
const LANGUAGE_NAMES = { en: 'English', zh: 'Chinese', de: 'German', es: 'Spanish', fr: 'French', ko: 'Korean', ja: 'Japanese' };
const MING_FIELDS = ['voice', 'emotion', 'speed', 'pitch', 'volume', 'language'];
/* The controls each newer engine files in metadata.openVoice.controls (Ming files MING_FIELDS). */
const OWN_FIELDS = { chatterbox: ['model', 'temperature', 'exaggeration', 'cfg_weight', 'language_id'], dramabox: ['duration', 'reference_seconds'] };
const TAG_RE = /\[([A-Za-z][A-Za-z -]{0,30})\]/g; // the worker's own pattern; anything else is read as words
const KNOWN_TAG = new Set([...MING.tags.map((t) => t.slice(1, -1).toLowerCase()), ...MING.aliases]);
const NO_MIX = 'no style, emotion, speed, pitch or volume';
const WORDS_CLIP = 'a clip of thirty seconds or less whose words are typed in';

/* Sound tags in the words: { tags, unknown } (unknown = the first bracketed word Ming does not know). */
function soundTags(text) {
  const tags = [];
  let unknown = '';
  for (const m of String(text || '').matchAll(TAG_RE)) {
    if (KNOWN_TAG.has(m[1].trim().toLowerCase())) tags.push(m[0]);
    else if (!unknown) unknown = m[0];
  }
  return { tags, unknown };
}

/* The Ming controls of a booth request -> fields for the worker input, or { error }. `input` already
 * holds mode, description or style and prompt_text. Empty values mean "not set". */
function mingControls(engine, b, input) {
  const set = {};
  for (const k of MING_FIELDS) {
    const v = typeof b[k] === 'string' ? b[k].trim() : b[k];
    if (v !== undefined && v !== null && v !== '') set[k] = v;
  }
  const { tags, unknown } = engine === 'ming' ? soundTags(input.text) : { tags: [] };
  if (engine !== 'ming') return Object.keys(set).length ? { error: 'Built-in voices, emotion, speed, pitch, volume and language work only with Ming.' } : { fields: {} };
  if (unknown) return { error: `Ming does not know the sound tag ${unknown}. Pick one from Sound tags, or take it out.` };
  const lower = (k) => (typeof set[k] === 'string' ? set[k].toLowerCase() : set[k]);
  const checks = [['voice', MING.voices, 'Pick a built-in voice from the list.'], ['emotion', MING.emotions, 'Pick an emotion from the list.'],
    ['speed', MING.speeds, 'Pick slow, medium or fast for the speed.'], ['pitch', MING.levels, 'Pick low, medium or high for the pitch.'],
    ['volume', MING.levels, 'Pick low, medium or high for the volume.'], ['language', MING.languages, 'Pick a language from the list.']];
  const fields = {};
  for (const [k, allowed, said] of checks) {
    if (!(k in set)) continue;
    const v = k === 'voice' ? set[k] : lower(k);
    if (typeof v !== 'string' || !allowed.includes(v)) return { error: said };
    fields[k] = v;
  }
  const level = !!(fields.speed || fields.pitch || fields.volume);
  const controls = !!(fields.emotion || level);
  if (input.mode === 'design') {
    if (controls || fields.language) return { error: 'Emotion, speed, pitch, volume and language are for Speak with a voice.' };
    if (tags.length) return { error: `Sound tags need Speak with a voice, with ${WORDS_CLIP}.` };
    if (fields.voice && input.description) return { error: 'Use a built-in voice or a description, not both. Clear one of them.' };
    return { fields };
  }
  if (fields.voice) return { error: 'Built-in voices are for Design a voice.' };
  if ([fields.emotion, level, input.style].filter(Boolean).length > 1) {
    return { error: 'Ming takes one of these per take: a style, an emotion, or speed, pitch and volume. Clear the others.' };
  }
  if (tags.length && (controls || input.style)) return { error: `Sound tags work only with ${NO_MIX}. Clear those, or take the tags out.` };
  if (tags.length && !input.prompt_text) return { error: `Sound tags need ${WORDS_CLIP}. Take the tags out, or use such a clip.` };
  if (fields.language && !['en', 'zh'].includes(fields.language)) {
    const name = LANGUAGE_NAMES[fields.language];
    if (controls || input.style) return { error: `${name} works only with ${NO_MIX}. Clear those, or set the language back.` };
    if (!input.prompt_text) return { error: `${name} needs ${WORDS_CLIP}. Use such a clip, or set the language back.` };
  }
  return { fields };
}

/* "Chatterbox Turbo", "DramaBox", "Ming": what My Creations and the take title say. */
function engineLabel(job) {
  const e = ENGINES[job.engine];
  const v = job.version && CHATTERBOX.versionLabels[job.version];
  return v ? `${e.label} ${v}` : e.label;
}

const LIVE = ['queued', 'running', 'filing'];
const isLive = (j) => LIVE.includes(j.state);

/* The worker's error text names code fields and exception classes; she hears a plain sentence.
 * The handlers' own clip sentences ("The reference clip is ...") are already plain and pass through. */
function plainError(out = {}) {
  const raw = String((out && out.error) || '');
  if (out && out.error_code === 'missing_dependency') return 'The voice engine is missing a part right now. Nothing was made. Try again later.';
  if (/^With prompt_text/i.test(raw)) return 'The exact words only work for a clip of thirty seconds or less. Leave the words out, or use a shorter clip.';
  if (/model cache is not ready/i.test(raw)) return 'The voice engine is still getting ready. Nothing was made. Try again in a few minutes.';
  if (/^The reference clip (must be stored|host is not public)/i.test(raw)) return 'That clip is not stored with the platform. Import it again.';
  /* Chatterbox and DramaBox's own clip and scene sentences, said plainly. */
  if (/^The reference clip must be longer than 5 seconds for model turbo/i.test(raw)) return 'Chatterbox Turbo needs a clip longer than 5 seconds. Use a longer clip, or set the version to Original.';
  if (/^The reference clip must be (at least|longer than) \d+ seconds?/i.test(raw)) return 'That clip is too short. Use a clip of at least 5 seconds of clear speech.';
  if (/^The reference clip is mostly silent/i.test(raw)) return 'That clip is mostly silent. It needs at least 3 seconds of clear voice.';
  if (/^The scene is too long: about \d+ s of audio, at most \d+ s\.$/.test(raw)) return raw.replace(/ s of audio, at most (\d+) s\./, ' seconds of audio. The most is $1 seconds.');
  if (/^One sentence is too long to say in one take/.test(raw)) return 'One spoken sentence is too long for one take. Break it into shorter sentences.';
  if (/^The reference clip [a-z ,]+\.$/i.test(raw) && raw.length <= 80) return raw;
  return 'The voice engine could not make this take. Nothing was made. Try again, or try a different clip.';
}

const freshSeed = () => crypto.randomInt(1, SEED_MAX);
const oneLine = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/* Our own storage only: https, no user info, the default port, and a Backblaze B2 host (or one
 * named in OPEN_VOICES_AUDIO_HOSTS). The workers check the same thing against their own bucket. */
function ourClip(url, env = process.env) {
  if (typeof url !== 'string' || url.length > 4096) return false;
  let u;
  try { u = new URL(url.trim()); } catch (_) { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  const extra = String(env.OPEN_VOICES_AUDIO_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return extra.includes(host) || /^([a-z0-9-]+\.)*s3\.[a-z0-9-]+\.backblazeb2\.com$/.test(host);
}

function endpointOf(engine, env = process.env) {
  const e = ENGINES[engine];
  if (!e) return '';
  const raw = String(env[e.endpointEnv] || e.defaultEndpoint || '').trim();
  return /^[a-z0-9]{6,40}$/i.test(raw) ? raw : '';
}

/* Every try is a new take: a fresh seed, unless she typed one. */
function seedOf(b) {
  const typed = b.seed;
  const seed = typeof typed === 'string' && /^\d+$/.test(typed.trim()) ? Number(typed.trim()) : typed;
  if (seed !== undefined && seed !== null && seed !== '') {
    if (!Number.isInteger(seed) || seed < 0 || seed > SEED_MAX) return { error: `The voice number must be a whole number from 0 to ${SEED_MAX}.` };
    return { seed };
  }
  return { seed: freshSeed() };
}

/* A booth request -> the worker's input, or { error } in a plain sentence. */
function buildInput(engine, b = {}, env = process.env) {
  const e = ENGINES[engine];
  if (!e) return { error: 'Pick a voice engine from the list.' };
  const mode = b.mode === 'speak' ? 'clone' : b.mode;
  if (mode !== 'design' && mode !== 'clone') return { error: 'Choose Design a voice or Speak with a voice.' };
  const scene = engine === 'dramabox';
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) return { error: scene ? 'Write the scene first.' : 'Type the words to say.' };
  const maxText = e.maxText || MAX_TEXT;
  if (text.length > maxText) return { error: `The ${scene ? 'scene is' : 'words are'} too long for ${e.label}. The most is ${maxText} characters.` };
  const input = { mode, text };
  if (engine === 'chatterbox' || scene) {
    /* No description and no style: the worker would refuse them (Chatterbox) or never read them (DramaBox). */
    if (oneLine(b.description)) {
      return { error: scene ? 'DramaBox takes no description. Describe the speaker in the scene, outside the quotes.'
        : 'Chatterbox uses its own built-in voice here. To use your own voice, choose Speak with a voice.' };
    }
    if (oneLine(b.style)) return { error: `${e.label} takes no style. ${scene ? 'Write how it is said in the scene, outside the quotes.' : 'Clear the style.'}` };
    if (mode === 'clone') {
      const url = typeof b.reference_voice_url === 'string' ? b.reference_voice_url.trim() : '';
      if (!url) return { error: 'Pick a saved voice or a clip first.' };
      if (!ourClip(url, env)) return { error: 'That clip is not stored with the platform. Import it again.' };
      input.reference_url = url; // both workers' own name (they read reference_voice_url too)
    }
    const ming = mingControls(engine, b, input);
    if (ming.error) return { error: ming.error };
    const own = scene ? dramaboxFields(b, input) : chatterboxFields(b, input);
    if (own.error) return { error: own.error };
    if (scene) { input.prompt = input.text; delete input.text; }
    Object.assign(input, own.fields);
    const seeded = seedOf(b);
    if (seeded.error) return seeded;
    input.seed = seeded.seed;
    return { input };
  }
  if (mode === 'design') {
    const description = oneLine(b.description);
    const builtIn = engine === 'ming' && typeof b.voice === 'string' && b.voice.trim();
    if (!description && !builtIn) return { error: engine === 'ming' ? 'Describe the voice first, or pick a built-in voice.' : 'Describe the voice first.' };
    if (description.length > e.maxPrefix) return { error: `The description is too long. The most is ${e.maxPrefix} characters.` };
    if (description) input.description = description;
  } else {
    const url = typeof b.reference_voice_url === 'string' ? b.reference_voice_url.trim() : '';
    if (!url) return { error: 'Pick a saved voice or a clip first.' };
    if (!ourClip(url, env)) return { error: 'That clip is not stored with the platform. Import it again.' };
    input.reference_voice_url = url;
    const style = oneLine(b.style);
    if (style.length > e.maxPrefix) return { error: `The style is too long. The most is ${e.maxPrefix} characters.` };
    if (style) input.style = style;
    const promptText = oneLine(b.prompt_text);
    if (promptText.length > MAX_PROMPT_TEXT) return { error: `The clip's words are too long. The most is ${MAX_PROMPT_TEXT} characters.` };
    if (promptText) input.prompt_text = promptText;
  }
  const ming = mingControls(engine, b, input);
  if (ming.error) return { error: ming.error };
  Object.assign(input, ming.fields);
  const seeded = seedOf(b);
  if (seeded.error) return seeded;
  input.seed = seeded.seed;
  if (typeof b.cfg === 'number' && b.cfg >= e.cfg.min && b.cfg <= e.cfg.max) input[e.cfg.name] = b.cfg;
  if (Number.isInteger(b.steps) && b.steps >= e.steps.min && b.steps <= e.steps.max) input[e.steps.name] = b.steps;
  if (typeof b.normalize === 'boolean') input.normalize = b.normalize;
  return { input };
}

function saySeconds(n) {
  n = Math.max(0, Math.round(n));
  const m = Math.floor(n / 60), s = n % 60;
  if (!m) return `${s} second${s === 1 ? '' : 's'}`;
  if (!s) return `${m} minute${m === 1 ? '' : 's'}`;
  return `${m} minute${m === 1 ? '' : 's'} ${s} seconds`;
}

/* A worker that is idle, ready or busy answers in seconds; anything else may mean a cold start. */
function coldLikely(cap) {
  if (!cap || !cap.ok) return true;
  return !(cap.idle > 0 || cap.ready > 0 || cap.running > 0);
}

function createOpenVoices({ env = process.env, http, dataDir, now = () => Date.now() } = {}) {
  if (!http) http = require('axios');
  const DATA_DIR = dataDir || env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir();
  const JOBS_FILE = path.join(DATA_DIR, 'open-voices-jobs.json');
  const RECEIPTS_FILE = path.join(DATA_DIR, 'open-voices-receipts.jsonl');
  const ENABLED = env.OPEN_VOICES_ENABLED !== '0';
  const KEY = env.RUNPOD_API_KEY || '';
  const DAILY_CAP = parseFloat(env.OPEN_VOICES_DAILY_CAP_USD || '1.00');
  const MONTHLY_CAP = parseFloat(env.OPEN_VOICES_MONTHLY_CAP_USD || '20');
  const QUEUE_TIMEOUT_MS = parseInt(env.OPEN_VOICES_QUEUE_TIMEOUT_MS || String(15 * 60 * 1000), 10);
  /* Past the queue wait plus this, a job is given up whatever /status says (a lost record, odd answers, a stuck run). */
  const RUN_CEILING_MS = parseInt(env.OPEN_VOICES_RUN_CEILING_MS || String(20 * 60 * 1000), 10);
  const FORK_URL = (env.FORK_USAGE_URL || env.LIBRECHAT_URL || 'https://kademurdock.com').replace(/\/$/, '');
  const USAGE_SECRET = env.KADE_USAGE_EVENT_SECRET || '';
  const rate = (engine) => parseFloat(env[ENGINES[engine].rateEnv] || ENGINES[engine].rate);
  const headers = () => ({ Authorization: `Bearer ${KEY}`, 'User-Agent': UA });
  const base = (engine) => `https://api.runpod.ai/v2/${endpointOf(engine, env)}`;
  const ready = (engine) => !!(ENABLED && KEY && endpointOf(engine, env));

  let jobs = [];
  try { jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); if (!Array.isArray(jobs)) jobs = []; } catch (_) { jobs = []; }
  const save = () => {
    try { if (jobs.length > RING) jobs = jobs.slice(-RING); fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs)); } catch (e) { console.warn('[open-voices] jobs save failed:', e.message); }
  };
  const receipt = (line) => { try { fs.appendFileSync(RECEIPTS_FILE, JSON.stringify({ at: new Date(now()).toISOString(), ...line }) + '\n'); } catch (_) {} };
  function spendSince(sinceMs) {
    let total = 0;
    try {
      for (const l of fs.readFileSync(RECEIPTS_FILE, 'utf8').split('\n').filter(Boolean)) {
        try { const r = JSON.parse(l); if (Date.parse(r.at) >= sinceMs && typeof r.costUSD === 'number') total += r.costUSD; } catch (_) {}
      }
    } catch (_) {}
    return total;
  }
  function capsExceeded() {
    const t = now();
    if (spendSince(t - 86400000) >= DAILY_CAP) return `Today's open voice budget ($${DAILY_CAP.toFixed(2)}) is used up.`;
    if (spendSince(t - 30 * 86400000) >= MONTHLY_CAP) return `This month's open voice budget ($${MONTHLY_CAP.toFixed(2)}) is used up.`;
    return null;
  }

  const capacity = {};
  async function readCapacity(engine) {
    const c = capacity[engine];
    if (c && now() - c.at < 15000) return c;
    let next;
    try {
      const r = await http.get(`${base(engine)}/health`, { headers: headers(), timeout: 10000 });
      const w = (r.data && r.data.workers) || {};
      const j = (r.data && r.data.jobs) || {};
      next = { at: now(), ok: true, idle: w.idle | 0, ready: w.ready | 0, running: w.running | 0, initializing: w.initializing | 0,
        throttled: w.throttled | 0, inQueue: j.inQueue | 0, inProgress: j.inProgress | 0 };
    } catch (_) { next = { at: now(), ok: false }; }
    capacity[engine] = next;
    return next;
  }

  async function postUsage(job, seconds, costUSD) {
    if (!USAGE_SECRET) return;
    try {
      await http.post(`${FORK_URL}/api/kade/usage-event`, { secret: USAGE_SECRET, userId: job.userId, service: ENGINES[job.engine].service,
        quantity: Math.max(1, Math.round(seconds)), unit: 'seconds', costUSD, metadata: { jobId: job.id, engine: job.engine, mode: job.mode } },
      { headers: { 'User-Agent': UA }, timeout: 10000 });
    } catch (e) { console.warn('[open-voices] usage post failed:', e.message); }
  }
  async function postAsset(job, out, costUSD) {
    if (!USAGE_SECRET) return;
    const e = ENGINES[job.engine];
    const voice = job.controls && job.controls.voice;
    const label = engineLabel(job);
    const prompt = job.engine === 'dramabox' || job.mode !== 'design' ? job.text
      : job.engine === 'chatterbox' ? `${label} built-in voice\n\n${job.text}`
        : `${job.description || `Built-in voice: ${VOICE_LABELS[voice] || voice}`}\n\n${job.text}`;
    /* `words` is what the take says (a saved voice's clip words): a scene's spoken lines only, and
     * no Chatterbox sound tags. */
    const words = job.engine === 'dramabox' ? spokenLines(job.text)
      : job.engine === 'chatterbox' ? job.text.replace(CB_TAG_RE, ' ').replace(/\s+/g, ' ').trim() : job.text;
    try {
      await http.post(`${FORK_URL}/api/kade/asset-event`, { secret: USAGE_SECRET, userId: job.userId, kind: 'audio', service: e.service,
        url: out.url, prompt, model: e.model, costUSD,
        metadata: { jobId: job.id, openVoice: { engine: job.engine, mode: job.mode, seed: out.seed, description: job.description || undefined,
          style: job.style || undefined, words: words.slice(0, 1000), seconds: out.duration_seconds, ...(job.version ? { version: job.version } : {}),
          ...(job.controls ? { controls: job.controls } : {}) },
        durationS: out.duration_seconds, seed: out.seed, b2Key: out.key, wavUrl: out.wav_url, wavKey: out.wav_key, engine: label, agent: 'Sound Booth' } },
      { headers: { 'User-Agent': UA }, timeout: 15000 });
    } catch (err) { console.warn('[open-voices] asset post failed:', err.message); }
  }

  async function start(b = {}) {
    const engine = String(b.engine || '');
    if (!ENGINES[engine]) return { error: 'Pick a voice engine from the list.' };
    if (!ENABLED) return { error: 'The open voices are switched off right now.' };
    if (!KEY || !endpointOf(engine, env)) return { error: `${ENGINES[engine].label} is not set up yet.` };
    const userId = String(b.userId || '').trim();
    if (!userId) return { error: 'userId required' };
    const built = buildInput(engine, b, env);
    if (built.error) return built;
    const capMsg = capsExceeded();
    if (capMsg) return { error: capMsg };
    const open = jobs.find((j) => j.userId === userId && isLive(j));
    if (open) return { error: 'One take at a time. The last one is still being made.', jobId: open.id };
    const cap = await readCapacity(engine);
    const input = { ...built.input }; // exactly the worker contract's fields; the user id stays here
    const own = OWN_FIELDS[engine] || MING_FIELDS;
    const job = { id: `ov_${now().toString(36)}${crypto.randomBytes(3).toString('hex')}`, userId, engine, mode: input.mode,
      text: input.text || input.prompt, description: input.description || '', style: input.style || '', seed: input.seed,
      ...(engine === 'chatterbox' ? { version: input.model } : {}),
      ...(own.some((k) => isSet(input[k])) ? { controls: Object.fromEntries(own.filter((k) => isSet(input[k])).map((k) => [k, input[k]])) } : {}),
      hasPromptText: !!input.prompt_text, state: 'queued', createdAt: new Date(now()).toISOString(), runpodId: null,
      coldLikely: coldLikely(cap), result: null, error: null, costUSD: null };
    try {
      const r = await http.post(`${base(engine)}/run`, { input }, { headers: headers(), timeout: 30000 });
      job.runpodId = r.data && r.data.id;
      if (!job.runpodId) throw new Error('no job id');
      job.submittedAt = new Date(now()).toISOString();
      if (r.data.status === 'IN_PROGRESS') { job.state = 'running'; job.startedAt = job.submittedAt; }
    } catch (e) {
      console.warn(`[open-voices] ${engine} submit failed:`, e.message);
      return { error: `${ENGINES[engine].label} did not take the job. Nothing was made. Try again.` };
    }
    jobs.push(job); save();
    console.log(`[open-voices] ${job.id} ${engine} ${job.mode} submitted -> runpod ${job.runpodId} (${job.text.length} chars, cold=${job.coldLikely})`);
    return { ok: true, jobId: job.id, engine, mode: job.mode, seed: job.seed, coldLikely: job.coldLikely };
  }

  function giveUp(job, error, state = 'gave-up') {
    job.state = 'failed'; job.finishedAt = new Date(now()).toISOString(); job.error = error; job.costUSD = 0;
    receipt({ jobId: job.id, userId: job.userId, engine: job.engine, state, costUSD: 0 }); save();
  }
  async function cancelAtRunPod(job) {
    try { await http.post(`${base(job.engine)}/cancel/${job.runpodId}`, {}, { headers: headers(), timeout: 20000 }); } catch (_) {}
  }
  /* The overall deadline, counted from submission: the queue wait plus the run ceiling. */
  async function pastDeadline(job) {
    const waited = now() - Date.parse(job.submittedAt || job.createdAt);
    if (!(waited > QUEUE_TIMEOUT_MS * ENGINES[job.engine].queueFactor + RUN_CEILING_MS)) return false;
    await cancelAtRunPod(job);
    giveUp(job, `The voice engine did not finish in ${saySeconds(waited / 1000)}. Nothing was made. Try again later.`);
    return true;
  }

  /* Files a finished take once. Each step is flagged and saved as soon as it is done, so a restart
   * mid-way finishes from the saved output and never files a second My Creations row or receipt. */
  async function file(job) {
    const out = job.out || {};
    const cost = job.costUSD || 0;
    if (!job.receipted) {
      receipt({ jobId: job.id, userId: job.userId, engine: job.engine, state: 'done', seconds: out.duration_seconds, costUSD: cost });
      job.receipted = true; save();
    }
    if (!job.usagePosted) { await postUsage(job, out.duration_seconds || 1, cost); job.usagePosted = true; save(); }
    if (!job.assetPosted) { await postAsset(job, out, cost); job.assetPosted = true; save(); }
    job.state = 'done'; job.finishedAt = new Date(now()).toISOString();
    job.result = { url: out.url, wavUrl: out.wav_url, seconds: out.duration_seconds, seed: out.seed, sampleRate: out.sample_rate,
      mode: out.mode, engine: out.engine, ...(job.version ? { version: job.version } : {}), cold: (job.delayMs || 0) > 45000, executionS: Math.round((job.executionMs || 0) / 100) / 10 };
    delete job.out;
    save();
  }

  async function pollOne(job) {
    if (job.state === 'filing') {
      if (job.out) return file(job);
      /* An older 'filing' record without its output: nothing safe to file twice, so stop it plainly. */
      return giveUp(job, 'The take was made but could not be saved. Look in My Creations, or try again.', 'lost');
    }
    let s;
    try {
      const r = await http.get(`${base(job.engine)}/status/${job.runpodId}`, { headers: headers(), timeout: 20000 });
      s = (r && r.data) || {};
    } catch (e) {
      if (job.state === 'cancelled') return;
      if (e && e.response && e.response.status === 404) {
        console.warn(`[open-voices] ${job.id}: RunPod no longer knows job ${job.runpodId}`);
        return giveUp(job, 'The voice engine lost this take. Nothing was made. Try again.', 'lost');
      }
      console.warn(`[open-voices] status ${job.id}:`, e.message);
      await pastDeadline(job);
      return;
    }
    if (job.state === 'cancelled') return;
    if (s.status === 'IN_PROGRESS' && job.state !== 'running') { job.state = 'running'; job.startedAt = new Date(now()).toISOString(); save(); }
    if (s.status === 'IN_QUEUE' && !job.startedAt) {
      const waited = now() - Date.parse(job.submittedAt || job.createdAt);
      if (waited > QUEUE_TIMEOUT_MS * ENGINES[job.engine].queueFactor) {
        await cancelAtRunPod(job);
        giveUp(job, `The voice engine did not start in ${saySeconds(waited / 1000)}. Nothing was made. Try again later.`);
      }
      return;
    }
    const cost = Math.round(((s.executionTime || 0) / 3600000 * rate(job.engine)) * 10000) / 10000;
    if (s.status === 'COMPLETED') {
      const out = s.output || {};
      if (out.error || !out.url) {
        if (out.error) console.warn(`[open-voices] ${job.id} worker error:`, String(out.error).slice(0, 300), out.error_code || '');
        job.state = 'failed';
        job.error = out.error ? plainError(out) : 'The voice engine sent back no recording. Nothing was made. Try again.';
        job.finishedAt = new Date(now()).toISOString(); job.costUSD = cost;
        receipt({ jobId: job.id, userId: job.userId, engine: job.engine, state: 'failed', costUSD: cost }); save();
        return;
      }
      /* Filed first, then marked done: the booth's Keep finds the take in My Creations by job id.
       * The output is saved on the job first, so a restart finishes filing without asking RunPod. */
      job.state = 'filing'; job.costUSD = cost; job.delayMs = s.delayTime || 0; job.executionMs = s.executionTime || 0;
      job.out = { url: out.url, wav_url: out.wav_url, key: out.key, wav_key: out.wav_key, duration_seconds: out.duration_seconds,
        seed: out.seed, sample_rate: out.sample_rate, mode: out.mode, engine: out.engine };
      save();
      await file(job);
    } else if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(s.status)) {
      job.state = 'failed'; job.finishedAt = new Date(now()).toISOString(); job.costUSD = cost;
      job.error = s.status === 'TIMED_OUT' ? 'The voice engine ran out of time. Nothing was made.' : 'The voice engine stopped. Nothing was made.';
      receipt({ jobId: job.id, userId: job.userId, engine: job.engine, state: 'failed', costUSD: cost }); save();
    } else {
      /* Running, queued after a start, or an answer we do not know: the overall deadline still holds. */
      await pastDeadline(job);
    }
  }

  let pumping = false;
  async function pump() {
    if (pumping) return; pumping = true;
    try { for (const job of jobs) if (isLive(job) && job.runpodId) await pollOne(job); }
    finally { pumping = false; }
  }

  function view(job) {
    const { text, runpodId, out, ...rest } = job;
    let wait = null;
    if (isLive(job)) {
      const waitedS = Math.max(0, Math.round((now() - Date.parse(job.submittedAt || job.createdAt)) / 1000));
      wait = { waitedS, spoken: job.state === 'filing' ? 'Saving the take.' : job.state === 'running' ? `Speaking now. ${saySeconds(waitedS)} in.` : `Waiting for the voice engine. ${saySeconds(waitedS)} so far.` };
    }
    return { ...rest, words: text.slice(0, 160), wait };
  }

  async function cancelJob(jobId, userId) {
    const job = jobs.find((j) => j.id === String(jobId || '') && (!userId || j.userId === String(userId)));
    if (!job) return { status: 404, body: { error: 'no such job' } };
    if (!['queued', 'running'].includes(job.state)) return { status: 200, body: { ok: true, state: job.state } };
    try { await http.post(`${base(job.engine)}/cancel/${job.runpodId}`, {}, { headers: headers(), timeout: 20000 }); }
    catch (e) { return { status: 502, body: { error: 'The voice engine did not confirm Stop. Try Stop again.' } }; }
    job.state = 'cancelled'; job.finishedAt = new Date(now()).toISOString(); save();
    return { status: 200, body: { ok: true, state: 'cancelled' } };
  }

  function health() {
    return {
      enabled: ENABLED,
      /* `controls: true` tells the fork this bridge reads Ming's extra controls (mingControls), so
       * the fork offers them only once this code is live. */
      engines: Object.fromEntries(Object.keys(ENGINES).map((k) => [k, { label: ENGINES[k].label, configured: ready(k), endpointId: endpointOf(k, env) || null,
        ...(k === 'ming' ? { controls: true } : {}), maxText: ENGINES[k].maxText }])),
      caps: { dailyUSD: DAILY_CAP, monthlyUSD: MONTHLY_CAP },
      spend: { dayUSD: spendSince(now() - 86400000), monthUSD: spendSince(now() - 30 * 86400000) },
      open: jobs.filter(isLive).length,
    };
  }

  return { start, pump, view, cancelJob, health, ready, readCapacity, find: (id) => jobs.find((j) => j.id === String(id)),
    latest: (userId) => [...jobs].reverse().find((j) => j.userId === String(userId)), _jobs: () => jobs };
}

function attachOpenVoices(app, d = {}, opts = {}) {
  const express = require('express');
  const lane = createOpenVoices(opts);
  const authOk = (req, provided) => !!((d.bridgeSecretOk && d.bridgeSecretOk(req, provided)) || (d.notifySecretOk && d.notifySecretOk(req, provided)));
  let timer = null;
  const kick = () => {
    if (timer) return;
    timer = setInterval(() => {
      lane.pump().catch((e) => console.warn('[open-voices] pump:', e.message)).then(() => {
        if (!lane._jobs().some(isLive)) { clearInterval(timer); timer = null; }
      });
    }, parseInt((opts.env || process.env).OPEN_VOICES_POLL_MS || '4000', 10));
    if (timer.unref) timer.unref();
  };

  app.post('/audio/open-voices/start', express.json({ limit: '64kb' }), async (req, res) => {
    if (!authOk(req, req.body && req.body.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const r = await lane.start(req.body || {});
    if (r.ok) kick();
    return res.status(r.error ? 400 : 200).json(r);
  });
  app.get('/audio/open-voices/status', (req, res) => {
    if (!authOk(req, req.query && req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const { jobId, userId } = req.query || {};
    const job = jobId ? lane.find(jobId) : userId ? lane.latest(userId) : null;
    if (!job || (userId && job.userId !== String(userId))) return res.status(404).json({ error: 'no such job' });
    if (isLive(job)) kick();
    res.setHeader('Cache-Control', 'no-store');
    return res.json(lane.view(job));
  });
  app.post('/audio/open-voices/cancel', express.json({ limit: '8kb' }), async (req, res) => {
    if (!authOk(req, req.body && req.body.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const r = await lane.cancelJob(req.body && req.body.jobId, req.body && req.body.userId);
    return res.status(r.status).json(r.body);
  });
  app.get('/audio/open-voices/health', (req, res) => {
    if (!(d.bridgeSecretOk && d.bridgeSecretOk(req, req.query && req.query.secret))) return res.status(403).json({ error: 'Unauthorized' });
    return res.json(lane.health());
  });
  if (lane._jobs().some(isLive)) kick();
  const h = lane.health();
  console.log(`[open-voices] lane ${h.enabled ? 'on' : 'OFF'}: ${Object.entries(h.engines).map(([k, v]) => `${k}=${v.configured ? v.endpointId : 'unset'}`).join(' ')}`);
  return lane;
}

module.exports = { attachOpenVoices, createOpenVoices, buildInput, mingControls, soundTags, chatterboxFields, dramaboxFields, spokenLines, engineLabel,
  ourClip, endpointOf, coldLikely, saySeconds, plainError, ENGINES, MING, CHATTERBOX, DRAMABOX, VOICE_LABELS, SEED_MAX };
