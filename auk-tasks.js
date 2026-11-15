'use strict';
/* auk-tasks.js — Clean up or change a recording on AuK: one trained task per job (Nov 15 2026).
 *
 * AuK follows only its own trained instruction phrases, one task per request
 * (AUK_EDIT_DIAGNOSIS.md, Nov 14). So, as with Change words (auk-words.js), the fork never sends
 * an instruction for these. It sends a task id and a few fixed choices (slots); the instruction is
 * built here, and it is what Tencent's own prompt builder (upstream src/auk/infer/pe.py
 * _render_instruction) sends for an English request:
 *   1. a phrase from pe.config.yaml `template_pools` (editing pools for speed, pitch, volume, mood
 *      and removed sounds; restoration pools for clean-up, muffled audio, effects, singing, voices
 *      and speakers), in English when the pool has English;
 *   2. only when the pool has nothing for the language, the `tasks:` template (whisper to normal and
 *      remove accent, Chinese only), or the Chinese pool when the sound has no English name (ums).
 * Upstream picks a pool phrase (and a value wording) at random, seeded by the request. Here it is
 * always the FIRST entry, so the instruction is fixed and testable; only the seed varies between
 * tries. The voice change keeps its `tasks:` template, which is also in the English pool.
 * auk-tasks.test.js pins every string; the work folder's check script renders them with pe.py itself.
 * Nothing she types becomes an instruction, except the voice description, which only ever fills the
 * one slot inside AuK's own timbre template.
 *
 * Fork -> bridge: `edit_task` (an id below) and `edit_slots` (an object), with auk_task 'edit'.
 * Bridge -> worker: the usual edit input, `instruction` = the phrase, one fresh `seed`.
 * The worker (eb93b87) passes a non-word instruction through unchanged and gives every window of a
 * long recording the same instruction, which suits these whole-recording tasks.
 * Contract: F:/KadeAI-work/auk-20261114/CONTRACT.md. */

const crypto = require('crypto');

const MAX_DESCRIPTION = 300;
const freshSeed = () => crypto.randomInt(1, 2147483647);

/* restoration.improve_quality.remove_effect.<bucket>.en[0]; the buckets are runtime.effect_aliases
 * (phone -> telephone). */
const EFFECT_PHRASES = {
  phone: 'This speech carries telephone-band coloration. Please restore it to a natural wideband voice.',
  megaphone: 'This audio has a megaphone-like coloration. Please restore it to a natural-sounding voice.',
  underwater: 'This audio sounds underwater / muffled. Please restore it to a normal, clear-sounding voice.',
};
/* pe.py _ordinal_en for 1-3: the {n_ord} slot of restoration.separate_speech.by_order.en[0]. */
const ORDER_EN = { 1: 'first', 2: 'second', 3: 'third' };
/* editing.speed_edit.values.<x.xx>x.en[0]: the {value} of editing.speed_edit.templates.en[0]. */
const SPEED_VALUES = { 0.5: 'slow down to 0.5x', 0.75: 'slow down to 0.75x', 1.25: 'speed up to 1.25x', 1.5: 'speed up to 1.5x', 2: 'speed up to 2x' };
/* pe.config.yaml nonverbal_events: an English request uses the event's English name (the first one);
 * an event with no English name falls back to its Chinese name and the Chinese pool (uhm). */
const SOUND_EVENTS = {
  breaths: { lang: 'en', name: 'breath' },
  laughs: { lang: 'en', name: 'laugh' },
  sighs: { lang: 'en', name: 'sigh' },
  coughs: { lang: 'en', name: 'cough' },
  ums: { lang: 'zh', name: '"呃"的语气词' },
};
/* pe.config.yaml tasks.emotion_edit.duration.emotion_multipliers. */
const EMOTION_LENGTH = { sad: 1.22, fearful: 1.16, happy: 1.06, angry: 1.06, surprised: 1.06, disgusted: 1.06, calm: 1.06, excited: 1.06 };
/* pe.config.yaml tasks.nonverbal_edit.duration.nonverbal_adjustments, delete side. */
const SOUND_DELTA = { breaths: -0.6, laughs: -1.05, sighs: -1.05, coughs: -1.05, ums: -0.9 };

/* editing.{speed,pitch,volume}_edit.templates.en[0] is 'Please {value} for this speech.' */
const pleaseFor = (value) => `Please ${value} for this speech.`;

/* Each task: its slots (allowed values) and its instruction. `seconds` is the output length for an
 * input of `s` seconds (pe.py duration strategies); absent means the same length. */
const TASKS = {
  /* enhance_speech: restoration.enhance_speech.en[0] */
  clean_up: {
    slots: {},
    instruction: () => 'Please clean up this input speech and keep all speakers intact, while removing the background noise and room reverberation. Output the restored clean speech with the same length as the input.',
  },
  /* improve_quality, bandwidth_extension: restoration.improve_quality.bandwidth_extension.en[0] */
  restore_muffled: {
    slots: {},
    instruction: () => 'This audio suffers from limited bandwidth. Please restore it to a wideband, clear-sounding speech.',
  },
  /* improve_quality, remove_effect */
  remove_effect: {
    slots: { effect: ['phone', 'megaphone', 'underwater'] },
    instruction: ({ effect }) => EFFECT_PHRASES[effect],
  },
  /* extract_vocals, singing_only: restoration pool en[0], the same as the tasks: template */
  keep_singing: {
    slots: {},
    instruction: () => 'Keep only the singing voice, drop everything else.',
  },
  /* extract_vocals, all_human_voices: restoration pool en[0], the same as the tasks: template */
  keep_voices: {
    slots: {},
    instruction: () => 'Keep all human voices, speech and singing alike, drop everything else.',
  },
  /* separate_speech, by_order: restoration.separate_speech.by_order.en[0] */
  keep_speaker: {
    slots: { speaker: [1, 2, 3] },
    instruction: ({ speaker }) => `Please keep the ${ORDER_EN[speaker]} speaker to start talking and remove the other speakers, outputting a single clean speech track.`,
  },
  /* speed_edit */
  speed: {
    slots: { speed: [0.5, 0.75, 1.25, 1.5, 2] },
    instruction: ({ speed }) => pleaseFor(SPEED_VALUES[speed]),
    seconds: (s, { speed }) => s / speed,
  },
  /* pitch_edit: editing.pitch_edit.values.{p,n}0N.en[0] */
  pitch: {
    slots: { direction: ['up', 'down'], semitones: [1, 2, 3] },
    instruction: ({ direction, semitones }) => pleaseFor(`${direction === 'up' ? 'raise' : 'lower'} by ${semitones} semitone${semitones === 1 ? '' : 's'}`),
  },
  /* volume_edit: editing.volume_edit.values.{p,m}NNdB.en[0] */
  volume: {
    slots: { direction: ['up', 'down'], db: [5, 10, 15] },
    instruction: ({ direction, db }) => pleaseFor(`${direction === 'up' ? 'increase' : 'decrease'} by ${db} dB`),
  },
  /* emotion_edit: editing.emotion_edit.templates.en[0], {emo} = values.<emotion>.en[0] */
  emotion: {
    slots: { emotion: ['happy', 'angry', 'sad', 'fearful', 'surprised', 'disgusted', 'calm', 'excited'] },
    instruction: ({ emotion }) => `Switch the emotion to ${emotion}.`,
    seconds: (s, { emotion }) => s * EMOTION_LENGTH[emotion],
  },
  /* whisper_edit, to_normal: no pool, so the tasks: template (Chinese only) */
  whisper_to_normal: {
    slots: {},
    instruction: () => '把这段耳语转换成正常说话的声音。',
  },
  /* accent_edit: the pool has no English, so pe.py falls back to the tasks: template (Chinese only) */
  remove_accent: {
    slots: {},
    instruction: () => '请去掉这段语音里的方言口音，保持说话人音色一致。',
  },
  /* nonverbal_edit, delete: editing.nonverbal_edit.templates.<lang>.delete.global[0] */
  remove_sound: {
    slots: { sound: ['breaths', 'laughs', 'sighs', 'coughs', 'ums'] },
    instruction: ({ sound }) => SOUND_EVENTS[sound].lang === 'en'
      ? `Remove all the ${SOUND_EVENTS[sound].name} from the audio.`
      : `删除音频中所有的${SOUND_EVENTS[sound].name}。`,
    seconds: (s, { sound }) => Math.max(0.1, s + SOUND_DELTA[sound]),
  },
  /* voice_edit: the tasks: English template, which is also in editing.voice_edit.templates.en;
   * the one typed slot */
  voice: {
    slots: { description: 'text' },
    instruction: ({ description }) => `Keep the spoken content unchanged and change the timbre to: "${description}".`,
  },
};
const TASK_IDS = Object.keys(TASKS);
/* How a missing choice is named when she is asked for it. */
const SLOT_WORDS = { effect: 'a sound', speaker: 'a speaker', speed: 'a speed', direction: 'up or down', semitones: 'how many semitones', db: 'how many decibels', emotion: 'an emotion', sound: 'a sound' };

/** A typed voice description, made safe for the one slot it fills: one line, no double quotes. */
function cleanDescription(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/["\u201c\u201d]/g, "'").replace(/\s+/g, ' ').trim();
}

/** Numbers may come as numbers or as the text of a choice ("0.75"). */
function slotValue(allowed, value) {
  if (allowed.every((v) => typeof v === 'number')) {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    return allowed.includes(n) ? n : undefined;
  }
  return allowed.includes(value) ? value : undefined;
}

/** A task asked for by the fork, checked. Returns { task: { id, slots, instruction } } or { error }. */
function taskInput(options = {}, { looksLikeWordChange } = {}) {
  const id = options.edit_task;
  const spec = typeof id === 'string' && Object.prototype.hasOwnProperty.call(TASKS, id) ? TASKS[id] : null;
  if (!spec) return { error: 'Pick what to do with the recording.' };
  const given = options.edit_slots && typeof options.edit_slots === 'object' && !Array.isArray(options.edit_slots) ? options.edit_slots : {};
  const slots = {};
  for (const [name, allowed] of Object.entries(spec.slots)) {
    if (allowed === 'text') {
      const text = cleanDescription(given[name]);
      if (!text) return { error: 'Describe the new voice first.' };
      if (text.length > MAX_DESCRIPTION) return { error: `Keep the voice description under ${MAX_DESCRIPTION} characters.` };
      if (looksLikeWordChange && looksLikeWordChange(text)) return { error: 'Describe only the voice. To change words, use Change words.' };
      slots[name] = text;
      continue;
    }
    const value = slotValue(allowed, given[name]);
    if (value === undefined) return { error: `Choose ${SLOT_WORDS[name] || 'a choice'} from the list.` };
    slots[name] = value;
  }
  return { task: { id, slots, instruction: spec.instruction(slots) } };
}

/** The output length for `seconds` of input, as pe.py sizes it; null when the task keeps the length. */
function targetSeconds(id, slots, seconds) {
  const spec = TASKS[id];
  if (!spec || !spec.seconds || !(seconds > 0)) return null;
  return Math.round(spec.seconds(seconds, slots) * 1000) / 1000;
}

/** Whether the task changes the length (speed must; emotion and sound removal a little). */
const changesLength = (id) => !!(TASKS[id] && TASKS[id].seconds);

module.exports = { TASKS, TASK_IDS, taskInput, targetSeconds, changesLength, freshSeed, cleanDescription, EFFECT_PHRASES, SOUND_EVENTS, EMOTION_LENGTH, SOUND_DELTA, MAX_DESCRIPTION };
