'use strict';
/* Clean up or change on AuK (Nov 15 2026): a task id and fixed choices in, AuK's own phrase out.
 * Every phrase is pinned here byte for byte as upstream pe.py _render_instruction sends it for an
 * English request, with the FIRST pool entry where upstream picks one at random (upstream
 * src/auk/infer/pe.config.yaml `template_pools`, else `tasks:`).
 * No network: the provider is a fixture. Run: node --test auk-tasks.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const tasks = require('./auk-tasks');
const words = require('./auk-words');

const say = (id, slots = {}) => {
  const r = tasks.taskInput({ edit_task: id, edit_slots: slots }, { looksLikeWordChange: words.looksLikeWordChange });
  assert.equal(r.error, undefined, `${id} ${JSON.stringify(slots)}: ${r.error}`);
  return r.task.instruction;
};

test('the task ids and their choices are the ones the fork offers', () => {
  assert.deepEqual(tasks.TASK_IDS, ['clean_up', 'restore_muffled', 'remove_effect', 'keep_singing', 'keep_voices', 'keep_speaker', 'speed', 'pitch', 'volume', 'emotion', 'whisper_to_normal', 'remove_accent', 'remove_sound', 'voice']);
  assert.deepEqual(Object.fromEntries(tasks.TASK_IDS.map((id) => [id, tasks.TASKS[id].slots])), {
    clean_up: {}, restore_muffled: {}, remove_effect: { effect: ['phone', 'megaphone', 'underwater'] },
    keep_singing: {}, keep_voices: {}, keep_speaker: { speaker: [1, 2, 3] },
    speed: { speed: [0.5, 0.75, 1.25, 1.5, 2] }, pitch: { direction: ['up', 'down'], semitones: [1, 2, 3] },
    volume: { direction: ['up', 'down'], db: [5, 10, 15] },
    emotion: { emotion: ['happy', 'angry', 'sad', 'fearful', 'surprised', 'disgusted', 'calm', 'excited'] },
    whisper_to_normal: {}, remove_accent: {}, remove_sound: { sound: ['breaths', 'laughs', 'sighs', 'coughs', 'ums'] },
    voice: { description: 'text' },
  });
});

test('restoration tasks send upstream\'s first English pool phrase (template_pools.restoration)', () => {
  assert.equal(say('clean_up'), 'Please clean up this input speech and keep all speakers intact, while removing the background noise and room reverberation. Output the restored clean speech with the same length as the input.');
  assert.equal(say('restore_muffled'), 'This audio suffers from limited bandwidth. Please restore it to a wideband, clear-sounding speech.');
  /* remove_effect buckets from runtime.effect_aliases: phone -> telephone */
  assert.equal(say('remove_effect', { effect: 'phone' }), 'This speech carries telephone-band coloration. Please restore it to a natural wideband voice.');
  assert.equal(say('remove_effect', { effect: 'megaphone' }), 'This audio has a megaphone-like coloration. Please restore it to a natural-sounding voice.');
  assert.equal(say('remove_effect', { effect: 'underwater' }), 'This audio sounds underwater / muffled. Please restore it to a normal, clear-sounding voice.');
  /* the first English pool phrase is also the tasks: template here */
  assert.equal(say('keep_singing'), 'Keep only the singing voice, drop everything else.');
  assert.equal(say('keep_voices'), 'Keep all human voices, speech and singing alike, drop everything else.');
  /* {n_ord} is pe.py _ordinal_en */
  assert.equal(say('keep_speaker', { speaker: 1 }), 'Please keep the first speaker to start talking and remove the other speakers, outputting a single clean speech track.');
  assert.equal(say('keep_speaker', { speaker: '2' }), 'Please keep the second speaker to start talking and remove the other speakers, outputting a single clean speech track.');
  assert.equal(say('keep_speaker', { speaker: 3 }), 'Please keep the third speaker to start talking and remove the other speakers, outputting a single clean speech track.');
});

test('editing tasks send upstream\'s first English pool frame with its first value wording (template_pools.editing)', () => {
  assert.deepEqual([0.5, 0.75, 1.25, 1.5, 2].map((speed) => say('speed', { speed })), [
    'Please slow down to 0.5x for this speech.', 'Please slow down to 0.75x for this speech.', 'Please speed up to 1.25x for this speech.',
    'Please speed up to 1.5x for this speech.', 'Please speed up to 2x for this speech.']);
  assert.equal(say('speed', { speed: '0.75' }), 'Please slow down to 0.75x for this speech.');
  assert.equal(say('pitch', { direction: 'up', semitones: 1 }), 'Please raise by 1 semitone for this speech.');
  assert.equal(say('pitch', { direction: 'up', semitones: 2 }), 'Please raise by 2 semitones for this speech.');
  assert.equal(say('pitch', { direction: 'down', semitones: 3 }), 'Please lower by 3 semitones for this speech.');
  assert.equal(say('volume', { direction: 'up', db: 5 }), 'Please increase by 5 dB for this speech.');
  assert.equal(say('volume', { direction: 'down', db: '15' }), 'Please decrease by 15 dB for this speech.');
  for (const emotion of ['happy', 'angry', 'sad', 'fearful', 'surprised', 'disgusted', 'calm', 'excited']) {
    assert.equal(say('emotion', { emotion }), `Switch the emotion to ${emotion}.`);
  }
  /* no English pool: pe.py falls back to the tasks: template, Chinese only */
  assert.equal(say('whisper_to_normal'), '把这段耳语转换成正常说话的声音。');
  assert.equal(say('remove_accent'), '请去掉这段语音里的方言口音，保持说话人音色一致。');
  /* nonverbal_events: English names for an English request; uhm has none, so the Chinese name and pool */
  assert.equal(say('remove_sound', { sound: 'breaths' }), 'Remove all the breath from the audio.');
  assert.equal(say('remove_sound', { sound: 'laughs' }), 'Remove all the laugh from the audio.');
  assert.equal(say('remove_sound', { sound: 'sighs' }), 'Remove all the sigh from the audio.');
  assert.equal(say('remove_sound', { sound: 'coughs' }), 'Remove all the cough from the audio.');
  assert.equal(say('remove_sound', { sound: 'ums' }), '删除音频中所有的"呃"的语气词。');
  /* the tasks: template, which is also in the English voice_edit pool */
  assert.equal(say('voice', { description: 'a deep, warm older man' }), 'Keep the spoken content unchanged and change the timbre to: "a deep, warm older man".');
});

test('anything off the lists is refused in a plain sentence, and a description cannot break out of its slot', () => {
  const err = (id, slots) => tasks.taskInput({ edit_task: id, edit_slots: slots }, { looksLikeWordChange: words.looksLikeWordChange }).error;
  assert.equal(err('make_it_better', {}), 'Pick what to do with the recording.');
  assert.equal(err(undefined, {}), 'Pick what to do with the recording.');
  assert.equal(err('toString', {}), 'Pick what to do with the recording.');
  assert.equal(err('speed', { speed: 1.8 }), 'Choose a speed from the list.');
  assert.equal(err('speed', {}), 'Choose a speed from the list.');
  assert.equal(err('pitch', { direction: 'sideways', semitones: 2 }), 'Choose up or down from the list.');
  assert.equal(err('pitch', { direction: 'up', semitones: 4 }), 'Choose how many semitones from the list.');
  assert.equal(err('volume', { direction: 'up', db: 20 }), 'Choose how many decibels from the list.');
  assert.equal(err('emotion', { emotion: 'smug' }), 'Choose an emotion from the list.');
  assert.equal(err('remove_effect', { effect: 'radio' }), 'Choose a sound from the list.');
  assert.equal(err('keep_speaker', { speaker: 4 }), 'Choose a speaker from the list.');
  assert.equal(err('voice', { description: '   ' }), 'Describe the new voice first.');
  assert.match(err('voice', { description: 'x'.repeat(301) }), /under 300 characters/);
  assert.equal(err('voice', { description: "a voice that says 'hi' instead of 'hello'" }), 'Describe only the voice. To change words, use Change words.');
  /* quotes and new lines never leave the slot */
  assert.equal(say('voice', { description: 'a "bright"\nyoung woman' }), 'Keep the spoken content unchanged and change the timbre to: "a \'bright\' young woman".');
});

test('a speed change sets the output length; emotion and removed sounds follow pe.py, the rest keep it', () => {
  assert.equal(tasks.targetSeconds('speed', { speed: 2 }, 10), 5);
  assert.equal(tasks.targetSeconds('speed', { speed: 0.75 }, 9), 12);
  assert.equal(tasks.targetSeconds('emotion', { emotion: 'sad' }, 10), 12.2);
  assert.equal(tasks.targetSeconds('emotion', { emotion: 'happy' }, 10), 10.6);
  assert.equal(tasks.targetSeconds('remove_sound', { sound: 'breaths' }, 10), 9.4);
  assert.equal(tasks.targetSeconds('remove_sound', { sound: 'coughs' }, 0.5), 0.1);
  assert.equal(tasks.targetSeconds('clean_up', {}, 10), null);
  assert.equal(tasks.changesLength('pitch'), false);
  assert.equal(tasks.changesLength('speed'), true);
});

function boot(t, env, axiosFixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auk-tasks-'));
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'scenema.js'), 'utf8'), {
    module: mod, require: (name) => name === 'axios' ? axiosFixture : require(name), console, Buffer, URL, setTimeout, clearTimeout, setImmediate,
    process: { env: { RAILWAY_VOLUME_MOUNT_PATH: dir, ...env } },
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { mod, dir, read: () => JSON.parse(fs.readFileSync(path.join(dir, 'scenema-jobs.json'))) };
}

test('the bridge builds the instruction from the task, ignores any free text, and gives each try a fresh seed', async (t) => {
  const sent = [];
  const axiosFixture = { create: () => ({ post: async (_p, body) => { sent.push(body.input); return { data: { id: 'rp', status: 'IN_QUEUE' } }; } }) };
  const { mod, read } = boot(t, { AUK_ENDPOINT_ID: 'test-only', RUNPOD_API_KEY: 'test-only' }, axiosFixture);
  const job = (userId, options) => mod.exports.makeJob({ userId, prompt: 'Clean up noise and echo.', options: { auk_task: 'edit', reference_voice_url: 'https://storage.test/her.wav', ...options } });
  const r = job('one', { edit_task: 'clean_up', edit_slots: {}, instruction: 'Replace Tuesday with Thursday and add a joke', seed: 31337, edit_start: 2, edit_end: 9 });
  assert.equal(r.ok, true, JSON.stringify(r));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[0].auk_task, 'edit');
  assert.equal(sent[0].instruction, 'Please clean up this input speech and keep all speakers intact, while removing the background noise and room reverberation. Output the restored clean speech with the same length as the input.');
  assert.doesNotMatch(JSON.stringify(sent[0]), /joke|Tuesday/);
  assert.equal(sent[0].seed, 31337, 'the fork\'s fresh seed is used');
  assert.equal(sent[0].edit_start, 2);
  assert.equal(sent[0].edit_end, 9);
  assert.equal(sent[0].gen_seconds, undefined, 'a clean-up keeps the length');
  /* no word-change fields reach the worker, so it never takes this for a word change */
  for (const key of ['edit_kind', 'old_words', 'new_words', 'oldText', 'newText', 'seeds', 'edit_task', 'edit_slots']) assert.equal(sent[0][key], undefined, key);
  assert.deepEqual(read().find((j) => j.userId === 'one').editTask, { id: 'clean_up', slots: {} });
  /* no seed from the fork: a fresh one is drawn, never the worker's fixed default */
  job('two', { edit_task: 'pitch', edit_slots: { direction: 'down', semitones: 3 } });
  job('three', { edit_task: 'pitch', edit_slots: { direction: 'down', semitones: 3 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[1].instruction, 'Please lower by 3 semitones for this speech.');
  assert.ok(Number.isInteger(sent[1].seed) && sent[1].seed > 0);
  assert.notEqual(sent[1].seed, sent[2].seed);
  assert.notEqual(sent[1].seed, 42);
});

test('a speed change gets its output length from the fork, or from the range, and is refused with neither', async (t) => {
  const sent = [];
  const axiosFixture = { create: () => ({ post: async (_p, body) => { sent.push(body.input); return { data: { id: 'rp', status: 'IN_QUEUE' } }; } }) };
  const { mod } = boot(t, { AUK_ENDPOINT_ID: 'test-only', RUNPOD_API_KEY: 'test-only' }, axiosFixture);
  const job = (userId, options) => mod.exports.makeJob({ userId, prompt: 'Speed it up.', options: { auk_task: 'edit', reference_voice_url: 'https://storage.test/her.wav', edit_task: 'speed', edit_slots: { speed: 1.25 }, ...options } });
  assert.equal(job('one', { gen_seconds: 8 }).ok, true);
  assert.equal(job('two', { edit_start: 0, edit_end: 10 }).ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[0].gen_seconds, 8);
  assert.equal(sent[1].gen_seconds, 8);
  assert.equal(sent[1].instruction, 'Please speed up to 1.25x for this speech.');
  assert.match(job('three', {}).error, /^A speed change needs the recording length\./);
  /* a bad choice is refused before anything is sent */
  assert.equal(job('four', { edit_slots: { speed: 3 } }).error, 'Choose a speed from the list.');
  assert.equal(sent.length, 2);
});

test('a task without the AuK worker, or without a recording, is refused plainly', (t) => {
  const { mod } = boot(t, { SCENEMA_ENDPOINT_ID: 'test-only', RUNPOD_API_KEY: 'test-only' }, { create: () => ({ post: async () => ({ data: {} }) }) });
  assert.equal(mod.exports.makeJob({ userId: 'one', prompt: 'x', options: { auk_task: 'edit', reference_voice_url: 'https://storage.test/her.wav', edit_task: 'clean_up' } }).error, 'This change needs the AuK worker.');
  const auk = boot(t, { AUK_ENDPOINT_ID: 'test-only', RUNPOD_API_KEY: 'test-only' }, { create: () => ({ post: async () => ({ data: { id: 'rp' } }) }) });
  assert.match(auk.mod.exports.makeJob({ userId: 'two', prompt: 'x', options: { auk_task: 'edit', edit_task: 'clean_up' } }).error, /Import a recording/);
});
