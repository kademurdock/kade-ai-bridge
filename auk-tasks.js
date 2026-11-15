'use strict';
/* auk-tasks.js — Clean up or change a recording on AuK: one trained task per job (Nov 15 2026).
 *
 * AuK follows only its own trained instruction phrases, one task per request
 * (AUK_EDIT_DIAGNOSIS.md, Nov 14). So, as with Change words (auk-words.js), the fork never sends
 * an instruction for these. It sends a task id and a few fixed choices (slots); the instruction is
 * built here from Tencent's templates, copied byte for byte from the `tasks:` section of
 * upstream src/auk/infer/pe.config.yaml. A task with no English template there uses the Chinese one,
 * as upstream does. Nothing she types becomes an instruction, except the voice description, which
 * only ever fills the one slot inside AuK's own timbre template.
 *
 * Fork -> bridge: `edit_task` (an id below) and `edit_slots` (an object), with auk_task 'edit'.
 * Bridge -> worker: the usual edit input, `instruction` = the template, one fresh `seed`.
 * The worker (eb93b87) passes a non-word instruction through unchanged and gives every window of a
 * long recording the same instruction, which suits these whole-recording tasks.
 * Contract: F:/KadeAI-work/auk-20261114/CONTRACT.md. */

const crypto = require('crypto');

const MAX_DESCRIPTION = 300;
const freshSeed = () => crypto.randomInt(1, 2147483647);

/* pe.config.yaml runtime.effect_aliases: the first (Chinese) name of each effect, since the
 * remove_effect template has only a Chinese form. */
const EFFECT_WORDS = { phone: '电话', megaphone: '扩音器', underwater: '水下' };
/* pe.py _integer_to_zh for 1-3: the speaker's place in Chinese. */
const ORDER_ZH = { 1: '一', 2: '二', 3: '三' };
/* pe.config.yaml nonverbal_events: English audio uses the event's English name (the first one);
 * an event with no English name falls back to its Chinese name and the Chinese template (uhm). */
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

/** Python's str() of the speed choices, since upstream formats the float: 2 -> "2.0". */
const pyFloat = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/* Each task: its slots (allowed values) and its instruction. `seconds` is the output length for an
 * input of `s` seconds (pe.py duration strategies); absent means the same length. */
const TASKS = {
  /* enhance_speech */
  clean_up: {
    slots: {},
    instruction: () => '请清理这段输入语音，不做说话人删除，并去除房间混响，输出干净的人声结果。',
  },
  /* improve_quality, bandwidth_extension */
  restore_muffled: {
    slots: {},
    instruction: () => '请对这段语音做超分辨率/带宽扩展处理，恢复被削掉的高频成分，输出宽带纯净人声。',
  },
  /* improve_quality, remove_effect */
  remove_effect: {
    slots: { effect: ['phone', 'megaphone', 'underwater'] },
    instruction: ({ effect }) => `请消除这段音频的${EFFECT_WORDS[effect]}音色，这段音频带有混响，请恢复成无混响的干声，输出自然清晰的人声。`,
  },
  /* extract_vocals, singing_only */
  keep_singing: {
    slots: {},
    instruction: () => 'Keep only the singing voice, drop everything else.',
  },
  /* extract_vocals, all_human_voices */
  keep_voices: {
    slots: {},
    instruction: () => 'Keep all human voices, speech and singing alike, drop everything else.',
  },
  /* separate_speech, by_order */
  keep_speaker: {
    slots: { speaker: [1, 2, 3] },
    instruction: ({ speaker }) => `这段音频中只保留第${ORDER_ZH[speaker]}个开始说话的人对应的语音，去掉其余说话人。`,
  },
  /* speed_edit */
  speed: {
    slots: { speed: [0.5, 0.75, 1.25, 1.5, 2] },
    instruction: ({ speed }) => `Adjust the speech speed to ${pyFloat(speed)}x.`,
    seconds: (s, { speed }) => s / speed,
  },
  /* pitch_edit */
  pitch: {
    slots: { direction: ['up', 'down'], semitones: [1, 2, 3] },
    instruction: ({ direction, semitones }) => direction === 'up'
      ? `Raise the pitch by ${semitones} semitones.`
      : `Lower the pitch by ${semitones} semitones.`,
  },
  /* volume_edit */
  volume: {
    slots: { direction: ['up', 'down'], db: [5, 10, 15] },
    instruction: ({ direction, db }) => direction === 'up'
      ? `Increase the volume by ${db} dB.`
      : `Decrease the volume by ${db} dB.`,
  },
  /* emotion_edit */
  emotion: {
    slots: { emotion: ['happy', 'angry', 'sad', 'fearful', 'surprised', 'disgusted', 'calm', 'excited'] },
    instruction: ({ emotion }) => `Change the emotion to ${emotion}.`,
    seconds: (s, { emotion }) => s * EMOTION_LENGTH[emotion],
  },
  /* whisper_edit, to_normal */
  whisper_to_normal: {
    slots: {},
    instruction: () => '把这段耳语转换成正常说话的声音。',
  },
  /* accent_edit */
  remove_accent: {
    slots: {},
    instruction: () => '请去掉这段语音里的方言口音，保持说话人音色一致。',
  },
  /* nonverbal_edit, delete */
  remove_sound: {
    slots: { sound: ['breaths', 'laughs', 'sighs', 'coughs', 'ums'] },
    instruction: ({ sound }) => SOUND_EVENTS[sound].lang === 'en'
      ? `Remove all the ${SOUND_EVENTS[sound].name} from the audio.`
      : `删除音频中所有的${SOUND_EVENTS[sound].name}。`,
    seconds: (s, { sound }) => Math.max(0.1, s + SOUND_DELTA[sound]),
  },
  /* voice_edit, English template; the one typed slot */
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

module.exports = { TASKS, TASK_IDS, taskInput, targetSeconds, changesLength, freshSeed, cleanDescription, EFFECT_WORDS, SOUND_EVENTS, EMOTION_LENGTH, SOUND_DELTA, MAX_DESCRIPTION };
