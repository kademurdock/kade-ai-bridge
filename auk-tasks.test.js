'use strict';
/* Clean up or change on AuK (Nov 15 2026): a task id and fixed choices in, AuK's own template out.
 * The templates are pinned here byte for byte as they appear in pe.config.yaml `tasks:` (upstream
 * src/auk/infer/pe.config.yaml), rendered the way pe.py renders them.
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

test('restoration tasks send Tencent\'s templates exactly, Chinese where there is no English one', () => {
  assert.equal(say('clean_up'), '请清理这段输入语音，不做说话人删除，并去除房间混响，输出干净的人声结果。');
  assert.equal(say('restore_muffled'), '请对这段语音做超分辨率/带宽扩展处理，恢复被削掉的高频成分，输出宽带纯净人声。');
  /* effect_aliases: telephone [电话 ...], megaphone [扩音器 ...], underwater [水下 ...] */
  assert.equal(say('remove_effect', { effect: 'phone' }), '请消除这段音频的电话音色，这段音频带有混响，请恢复成无混响的干声，输出自然清晰的人声。');
  assert.equal(say('remove_effect', { effect: 'megaphone' }), '请消除这段音频的扩音器音色，这段音频带有混响，请恢复成无混响的干声，输出自然清晰的人声。');
  assert.equal(say('remove_effect', { effect: 'underwater' }), '请消除这段音频的水下音色，这段音频带有混响，请恢复成无混响的干声，输出自然清晰的人声。');
  assert.equal(say('keep_singing'), 'Keep only the singing voice, drop everything else.');
  assert.equal(say('keep_voices'), 'Keep all human voices, speech and singing alike, drop everything else.');
  /* n_zh is pe.py _integer_to_zh */
  assert.equal(say('keep_speaker', { speaker: 1 }), '这段音频中只保留第一个开始说话的人对应的语音，去掉其余说话人。');
  assert.equal(say('keep_speaker', { speaker: '2' }), '这段音频中只保留第二个开始说话的人对应的语音，去掉其余说话人。');
  assert.equal(say('keep_speaker', { speaker: 3 }), '这段音频中只保留第三个开始说话的人对应的语音，去掉其余说话人。');
});

test('editing tasks send the English templates, filled the way pe.py fills them', () => {
  /* speed_multiplier is a float in pe.py, so 2 is "2.0" */
  assert.deepEqual([0.5, 0.75, 1.25, 1.5, 2].map((speed) => say('speed', { speed })), [
    'Adjust the speech speed to 0.5x.', 'Adjust the speech speed to 0.75x.', 'Adjust the speech speed to 1.25x.',
    'Adjust the speech speed to 1.5x.', 'Adjust the speech speed to 2.0x.']);
  assert.equal(say('speed', { speed: '0.75' }), 'Adjust the speech speed to 0.75x.');
  assert.equal(say('pitch', { direction: 'up', semitones: 2 }), 'Raise the pitch by 2 semitones.');
  assert.equal(say('pitch', { direction: 'down', semitones: 1 }), 'Lower the pitch by 1 semitones.');
  assert.equal(say('volume', { direction: 'up', db: 5 }), 'Increase the volume by 5 dB.');
  assert.equal(say('volume', { direction: 'down', db: '15' }), 'Decrease the volume by 15 dB.');
  for (const emotion of ['happy', 'angry', 'sad', 'fearful', 'surprised', 'disgusted', 'calm', 'excited']) {
    assert.equal(say('emotion', { emotion }), `Change the emotion to ${emotion}.`);
  }
  assert.equal(say('whisper_to_normal'), '把这段耳语转换成正常说话的声音。');
  assert.equal(say('remove_accent'), '请去掉这段语音里的方言口音，保持说话人音色一致。');
  /* nonverbal_events: English names for English audio; uhm has none, so it falls back to Chinese, template and all */
  assert.equal(say('remove_sound', { sound: 'breaths' }), 'Remove all the breath from the audio.');
  assert.equal(say('remove_sound', { sound: 'laughs' }), 'Remove all the laugh from the audio.');
  assert.equal(say('remove_sound', { sound: 'sighs' }), 'Remove all the sigh from the audio.');
  assert.equal(say('remove_sound', { sound: 'coughs' }), 'Remove all the cough from the audio.');
  assert.equal(say('remove_sound', { sound: 'ums' }), '删除音频中所有的"呃"的语气词。');
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
  assert.equal(sent[0].instruction, '请清理这段输入语音，不做说话人删除，并去除房间混响，输出干净的人声结果。');
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
  assert.equal(sent[1].instruction, 'Lower the pitch by 3 semitones.');
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
  assert.equal(sent[1].instruction, 'Adjust the speech speed to 1.25x.');
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
