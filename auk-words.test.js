'use strict';
/* Change words on AuK (Nov 14 2026): the contract sent to the worker, and the take that is kept.
 * No network: the listener and the provider are fixtures. Run: node --test auk-words.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const words = require('./auk-words');

const edit = { kind: 'speech', oldText: 'Tuesday', newText: 'Thursday', rangeStart: 3, rangeEnd: 7, seeds: [11, 22, 33] };

test('a word edit is checked and its seeds come back fresh, or as sent', () => {
  const ok = words.wordEditInput({ ...edit, seeds: undefined });
  assert.equal(ok.edit.seeds.length, 3);
  assert.equal(new Set(ok.edit.seeds).size, 3);
  assert.notDeepEqual(words.wordEditInput({ ...edit, seeds: 3 }).edit.seeds, words.wordEditInput({ ...edit, seeds: 3 }).edit.seeds);
  assert.deepEqual(words.wordEditInput({ ...edit, seeds: [5, 5, 6] }).edit.seeds, [5, 6]);
  assert.match(words.wordEditInput({ ...edit, kind: 'other' }).error, /spoken or sung/);
  assert.match(words.wordEditInput({ ...edit, newText: '  ' }).error, /new words/);
  assert.match(words.wordEditInput({ ...edit, newText: 'tuesday!' }).error, /same as the old/);
  assert.match(words.wordEditInput({ ...edit, rangeEnd: 2 }).error, /end after the start/);
  assert.match(words.wordEditInput({ ...edit, rangeEnd: 60 }).error, /between 0.5 and 30 seconds/);
  assert.match(words.wordEditInput({ ...edit, seeds: 9 }).error, /between 1 and 4 takes/);
  assert.equal(words.wordEditInput({ ...edit, oldText: 'Tues\nday' }).edit.oldText, 'Tues day');
});

test('the instruction is AuK\'s own template, sung or spoken', () => {
  assert.equal(words.wordTemplate('speech', 'Tuesday', 'Thursday'), "Replace 'Tuesday' with 'Thursday'.");
  assert.equal(words.wordTemplate('vocal', 'rear "view"', 'like you'), 'Change "rear view" to "like you" in the vocal recording.');
});

test('a take matches when it says the new words and not the old ones', () => {
  assert.equal(words.judge('See you Thursday, okay?', edit).matched, true);
  assert.equal(words.judge('See you Tuesday, okay?', edit).matched, false);
  assert.equal(words.judge('Thursday or Tuesday', edit).matched, false);
  /* old words inside the new words prove nothing either way */
  assert.equal(words.judge('see you tuesday night', { ...edit, newText: 'Tuesday night' }).matched, true);
  assert.equal(words.judge("Don't STOP believin'", { ...edit, oldText: 'keep going', newText: 'dont stop' }).matched, true);
});

function hearing(map) {
  return async (buffer) => {
    const said = map[buffer.toString()];
    if (said instanceof Error) throw said;
    return { text: said, costUSD: 0.00001 };
  };
}
const take = (seed, name) => ({ seed, url: `https://b2.test/${name}.mp3`, wav_url: `https://b2.test/${name}.wav`, clip_b64: Buffer.from(name).toString('base64') });

test('the take that says the new words is kept, and the report says which', async () => {
  const candidates = [take(11, 'a'), take(22, 'b'), take(33, 'c')];
  const { best, report } = await words.rankCandidates(candidates, edit, { hear: hearing({ a: 'see you tuesday', b: 'see you thursday', c: 'see you thirsty' }) });
  assert.equal(best.seed, 22);
  assert.equal(report.matched, true);
  assert.equal(report.picked, 1);
  assert.equal(report.takes.length, 3);
  assert.match(report.spoken, /kept take 2, which says the new words/);
  assert.equal(report.listenUSD, 0.00003);
});

test('when no take says the new words, nothing is kept and she is told plainly', async () => {
  const { best, report } = await words.rankCandidates([take(1, 'a'), take(2, 'b')], edit, { hear: hearing({ a: 'see you tuesday', b: 'see you thirsty' }) });
  assert.equal(best, null);
  assert.equal(report.matched, false);
  assert.match(report.spoken, /None of the 2 takes said "Thursday"\. Your original recording is unchanged/);
  assert.match(report.spoken, /closest one said: "see you thirsty"/);
});

test('a take nobody could hear is judged on the worker transcript, and with neither it is kept unchecked', async () => {
  const fallback = await words.rankCandidates([{ ...take(1, 'a'), transcript: 'see you Thursday' }], edit, { hear: hearing({ a: new Error('host down') }) });
  assert.equal(fallback.report.takes[0].source, 'worker');
  assert.equal(fallback.report.matched, true);
  const blind = await words.rankCandidates([take(1, 'a')], edit, { hear: hearing({ a: new Error('host down') }) });
  assert.equal(blind.best.seed, 1);
  assert.equal(blind.report.checked, false);
  assert.match(blind.report.spoken, /could not listen back/);
});

test('MiMo is asked on zero-retention hosts and a reply that never heard the audio is refused', async () => {
  const calls = [];
  const axios = { post: async (url, body) => { calls.push({ url, body }); return { data: { choices: [{ message: { content: 'see you thursday' } }], usage: { prompt_tokens: 20, cost: 0.00001 } } }; } };
  await assert.rejects(words.mimoHear(axios, Buffer.from('RIFFxxxx'), { OPENROUTER_KEY: 'synthetic-only' }), /did not hear the audio/);
  assert.equal(calls[0].body.model, 'xiaomi/mimo-v2.6-flash');
  assert.equal(calls[0].body.provider.zdr, true);
  assert.deepEqual(calls[0].body.provider.only, ['Makora', 'Novita']);
  assert.equal(calls[0].body.messages[0].content[1].input_audio.format, 'wav');
  const heard = { post: async () => ({ data: { choices: [{ message: { content: 'see you thursday' } }], usage: { prompt_tokens: 90 } } }) };
  assert.equal((await words.mimoHear(heard, Buffer.from('ID3x'), { OPENROUTER_KEY: 'synthetic-only' })).text, 'see you thursday');
});

function boot(t, env, axiosFixture, jobs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auk-words-'));
  if (jobs) fs.writeFileSync(path.join(dir, 'scenema-jobs.json'), JSON.stringify(jobs));
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'scenema.js'), 'utf8'), {
    module: mod, require: (name) => name === 'axios' ? axiosFixture : require(name), console, Buffer, URL, setTimeout, clearTimeout, setImmediate,
    process: { env: { RAILWAY_VOLUME_MOUNT_PATH: dir, ...env } },
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { mod, dir, read: () => JSON.parse(fs.readFileSync(path.join(dir, 'scenema-jobs.json'))) };
}

test('the bridge sends the worker the word contract, its own template and never free text', async (t) => {
  const sent = [];
  const axiosFixture = { create: () => ({ post: async (_p, body) => { sent.push(body.input); return { data: { id: 'rp', status: 'IN_QUEUE' } }; } }) };
  const { mod } = boot(t, { AUK_ENDPOINT_ID: 'test-only', RUNPOD_API_KEY: 'test-only' }, axiosFixture);
  const options = { auk_task: 'edit', instruction: 'make it Thursday and also add a joke', reference_voice_url: 'https://storage.test/her.wav',
    kind: 'speech', oldText: 'Tuesday', newText: 'Thursday', rangeStart: 3.2, rangeEnd: 6.8, seeds: [7, 8, 9], seed: 4242, edit_start: 0, edit_end: 99, gen_seconds: 40 };
  const r = mod.exports.makeJob({ userId: 'owner', prompt: "Replace 'Tuesday' with 'Thursday'.", options });
  assert.equal(r.ok, true);
  assert.match(r.estimate.spokenWait, /makes 3 takes of this change/);
  await new Promise((resolve) => setImmediate(resolve));
  const input = sent[0];
  assert.equal(input.auk_task, 'edit');
  assert.equal(input.instruction, "Replace 'Tuesday' with 'Thursday'.");
  assert.doesNotMatch(JSON.stringify(input), /joke/);
  assert.deepEqual({ kind: input.kind, oldText: input.oldText, newText: input.newText, rangeStart: input.rangeStart, rangeEnd: input.rangeEnd, seeds: input.seeds },
    { kind: 'speech', oldText: 'Tuesday', newText: 'Thursday', rangeStart: 3.2, rangeEnd: 6.8, seeds: [7, 8, 9] });
  assert.equal(input.edit_start, 3.2);
  assert.equal(input.edit_end, 6.8);
  assert.equal(input.seed, 7);
  assert.equal(input.gen_seconds, undefined);
  /* the worker build's own names for the same change (worker auk_edit.py) */
  assert.equal(input.edit_kind, 'speech');
  assert.equal(input.old_words, 'Tuesday');
  assert.equal(input.new_words, 'Thursday');
  const bad = mod.exports.makeJob({ userId: 'other', prompt: '', options: { ...options, rangeEnd: 1 } });
  assert.match(bad.error, /end after the start/);
  /* An ordinary edit still sends her instruction, and needs one. */
  const plain = mod.exports.makeJob({ userId: 'third', prompt: '', options: { auk_task: 'edit', reference_voice_url: 'https://storage.test/x.wav', instruction: 'Remove background noise.' } });
  assert.equal(plain.ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[1].instruction, 'Remove background noise.');
  assert.equal(sent[1].oldText, undefined);
  assert.match(mod.exports.makeJob({ userId: 'fourth', prompt: '', options: { auk_task: 'edit', reference_voice_url: 'https://storage.test/x.wav' } }).error, /describe the edit/);
});

function completion(t, output, heardBy) {
  const assets = [], usage = [];
  const job = { id: 'job-w', userId: 'owner', agentId: 'soundbooth', agentName: 'Sound Booth', state: 'running', runpodId: 'rp', prompt: "Replace 'Tuesday' with 'Thursday'.",
    createdAt: new Date(Date.now() - 60000).toISOString(), startedAt: new Date().toISOString(), wordEdit: edit };
  const axiosFixture = {
    create: () => ({ get: async () => ({ data: { status: 'COMPLETED', executionTime: 30000, delayTime: 1000, output } }) }),
    get: async (url) => ({ data: Buffer.from(url.split('/').pop()) }),
    post: async (url, body) => {
      if (url.endsWith('/api/kade/asset-event')) assets.push(body);
      if (url.endsWith('/api/kade/usage-event')) usage.push(body);
      if (url.includes('openrouter.ai')) {
        const name = Buffer.from(body.messages[0].content[1].input_audio.data, 'base64').toString();
        return { data: { choices: [{ message: { content: heardBy[name] || '' } }], usage: { prompt_tokens: 120, cost: 0.00002 } } };
      }
      return { data: {} };
    },
  };
  const pushes = [];
  const { mod, read } = boot(t, { AUK_ENDPOINT_ID: 'test-only', SCENEMA_ENABLED: '0', KADE_USAGE_EVENT_SECRET: 'synthetic-only', OPENROUTER_KEY: 'synthetic-only' }, axiosFixture, [job]);
  mod.exports.attachScenema(express(), { runNotify: async (p) => { pushes.push(p); return { sent: 1 }; } });
  return { pump: mod.exports._internals.pump, read: () => read()[0], assets, usage, pushes };
}

test('a finished word edit files the take that says the new words, with the report', async (t) => {
  const output = { candidates: [
    { seed: 7, url: 'https://b2.test/seven.mp3', wav_url: 'https://b2.test/seven.wav', clip_url: 'https://b2.test/clip7', duration_s: 9 },
    { seed: 8, url: 'https://b2.test/eight.mp3', wav_url: 'https://b2.test/eight.wav', clip_url: 'https://b2.test/clip8', duration_s: 9 },
  ] };
  const f = completion(t, output, { clip7: 'see you tuesday', clip8: 'see you thursday' });
  await f.pump();
  const job = f.read();
  assert.equal(job.state, 'done');
  assert.equal(job.result.url, 'https://b2.test/eight.mp3');
  assert.equal(job.result.wavUrl, 'https://b2.test/eight.wav');
  assert.equal(job.result.seed, 8);
  assert.equal(job.result.editReport.matched, true);
  assert.equal(f.assets.length, 1);
  assert.equal(f.assets[0].url, 'https://b2.test/eight.mp3');
  assert.equal(f.assets[0].metadata.wordEdit.newText, 'Thursday');
  assert.match(f.pushes[0].title, /word change is ready/);
});

test('a word edit where no take said the new words ends plainly, keeps the original and still logs the spend', async (t) => {
  const output = { candidates: [{ seed: 7, url: 'https://b2.test/seven.mp3', clip_url: 'https://b2.test/clip7' }] };
  const f = completion(t, output, { clip7: 'see you tuesday' });
  await f.pump();
  const job = f.read();
  assert.equal(job.state, 'failed');
  assert.equal(job.noMatch, true);
  assert.match(job.error, /None of the 1 take said "Thursday"\. Your original recording is unchanged/);
  assert.equal(f.assets.length, 0);
  assert.equal(f.usage.length, 1);
  assert.ok(job.costUSD > 0);
  assert.match(f.pushes[0].title, /did not change/);
});

test('an older worker\'s single take is still listened to before it is kept', async (t) => {
  const f = completion(t, { url: 'https://b2.test/only.mp3', seed: 7, duration_s: 9 }, { 'only.mp3': 'see you thursday' });
  await f.pump();
  assert.equal(f.read().state, 'done');
  assert.equal(f.read().result.editReport.takes[0].source, 'mimo');
});

test('a whole take is judged on the new words only, since the old words may rightly be said elsewhere in it', async () => {
  const whole = { seed: 4, url: 'https://b2.test/whole.mp3', b64: Buffer.from('w').toString('base64') };
  const { best, report } = await words.rankCandidates([whole], edit, { hear: async () => ({ text: 'see you Thursday, and Tuesday too' }) });
  assert.equal(best.seed, 4);
  assert.equal(report.takes[0].scope, 'whole take');
  assert.equal(report.matched, true);
  const clip = await words.rankCandidates([{ ...whole, clip_b64: Buffer.from('c').toString('base64') }], edit, { hear: async () => ({ text: 'see you Thursday, and Tuesday too' }) });
  assert.equal(clip.report.takes[0].scope, 'edited stretch');
  assert.equal(clip.report.matched, false, 'inside the edited stretch the old words must be gone');
});
