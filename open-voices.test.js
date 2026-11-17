'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const ov = require('./open-voices');

const CLIP = 'https://s3.us-east-005.backblazeb2.com/bucket/audios/u1/soundbooth-ref-abc.wav?X-Amz-Signature=deadbeef';

function fakeHttp(script = {}) {
  const calls = [];
  return {
    calls,
    async get(url, o) { calls.push({ verb: 'get', url, o }); const f = script.get && script.get(url); if (f instanceof Error) throw f; return { data: f || {} }; },
    async post(url, body, o) { calls.push({ verb: 'post', url, body, o }); const f = script.post && script.post(url, body); if (f instanceof Error) throw f; return { data: f || {} }; },
  };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'open-voices-'));

test('only our own B2 storage passes as a clip', () => {
  assert.equal(ov.ourClip(CLIP), true);
  assert.equal(ov.ourClip('https://bucket.s3.us-east-005.backblazeb2.com/a.wav'), true);
  for (const bad of ['http://s3.us-east-005.backblazeb2.com/a.wav', 'https://evil.example/a.wav', 'https://169.254.169.254/a',
    'https://s3.us-east-005.backblazeb2.com:8443/a', 'https://u:p@s3.us-east-005.backblazeb2.com/a', 'https://backblazeb2.com.evil.example/a', 'not a url', null]) {
    assert.equal(ov.ourClip(bad), false, String(bad));
  }
  assert.equal(ov.ourClip('https://media.example.org/a.wav', { OPEN_VOICES_AUDIO_HOSTS: 'media.example.org' }), true);
});

test('endpoint ids: VoxCPM2 has its default, Ming only from env', () => {
  assert.equal(ov.endpointOf('voxcpm', {}), 'dewjq1ibxkp2c3');
  assert.equal(ov.endpointOf('voxcpm', { VOXCPM_ENDPOINT_ID: 'abc123xyz' }), 'abc123xyz');
  assert.equal(ov.endpointOf('ming', {}), '');
  assert.equal(ov.endpointOf('ming', { MING_ENDPOINT_ID: 'ming0001' }), 'ming0001');
  assert.equal(ov.endpointOf('ming', { MING_ENDPOINT_ID: 'bad/../id' }), '');
});

test('design input: description and words, a fresh seed every try', () => {
  const a = ov.buildInput('voxcpm', { mode: 'design', description: '  A warm   low voice ', text: ' Hello there. ' });
  const b = ov.buildInput('voxcpm', { mode: 'design', description: 'A warm low voice', text: 'Hello there.' });
  assert.equal(a.input.mode, 'design');
  assert.equal(a.input.description, 'A warm low voice');
  assert.equal(a.input.text, 'Hello there.');
  assert.ok(Number.isInteger(a.input.seed) && a.input.seed > 0);
  assert.notEqual(a.input.seed, b.input.seed);
  assert.equal(a.input.reference_voice_url, undefined);
  assert.match(ov.buildInput('voxcpm', { mode: 'design', text: 'Hi' }).error, /Describe the voice/);
  assert.match(ov.buildInput('voxcpm', { mode: 'design', description: 'x'.repeat(401), text: 'Hi' }).error, /400/);
  assert.equal(ov.buildInput('ming', { mode: 'design', description: 'x'.repeat(500), text: 'Hi' }).error, undefined);
});

test('a typed seed is kept; a bad one is refused plainly', () => {
  assert.equal(ov.buildInput('ming', { mode: 'design', description: 'd', text: 't', seed: 42 }).input.seed, 42);
  assert.equal(ov.buildInput('ming', { mode: 'design', description: 'd', text: 't', seed: '7' }).input.seed, 7);
  assert.equal(ov.buildInput('ming', { mode: 'design', description: 'd', text: 't', seed: 0 }).input.seed, 0);
  assert.match(ov.buildInput('ming', { mode: 'design', description: 'd', text: 't', seed: -1 }).error, /whole number/);
  assert.match(ov.buildInput('ming', { mode: 'design', description: 'd', text: 't', seed: 1.5 }).error, /whole number/);
});

test('speak input: our clip, style and the clip words; knobs map to each worker', () => {
  const v = ov.buildInput('voxcpm', { mode: 'speak', reference_voice_url: CLIP, text: 'Words', style: 'slightly faster, cheerful', prompt_text: 'what the clip says', cfg: 2.5, steps: 12 });
  assert.deepEqual({ ...v.input, seed: 0 }, { mode: 'clone', text: 'Words', reference_voice_url: CLIP, style: 'slightly faster, cheerful', prompt_text: 'what the clip says', seed: 0, cfg_value: 2.5, inference_timesteps: 12 });
  const m = ov.buildInput('ming', { mode: 'clone', reference_voice_url: CLIP, text: 'Words', steps: 12 });
  assert.equal(m.input.flow_steps, 12);
  assert.match(ov.buildInput('ming', { mode: 'clone', reference_voice_url: CLIP, text: 'Words', cfg: 0.7 }).error, /How closely it follows must be a number from 1 to 5/,
    'out of range is said, not dropped');
  assert.match(ov.buildInput('ming', { mode: 'clone', text: 'Words' }).error, /saved voice or a clip/);
  assert.match(ov.buildInput('ming', { mode: 'clone', reference_voice_url: 'https://evil.example/a.wav', text: 'Words' }).error, /not stored/);
  assert.match(ov.buildInput('ming', { mode: 'clone', reference_voice_url: CLIP, text: 'x'.repeat(2501) }).error, /2500/);
  assert.match(ov.buildInput('voxcpm', { mode: 'design', description: 'd', text: 'x'.repeat(5001) }).error, /5000/);
  assert.ok(!ov.buildInput('voxcpm', { mode: 'design', description: 'd', text: 'x'.repeat(2501) }).error);
  assert.match(ov.buildInput('nope', { mode: 'design' }).error, /Pick a voice engine/);
  assert.match(ov.buildInput('voxcpm', { mode: 'sing', text: 'x' }).error, /Design a voice or Speak/);
});

test('cold start is guessed from the endpoint health', () => {
  assert.equal(ov.coldLikely({ ok: true, idle: 1 }), false);
  assert.equal(ov.coldLikely({ ok: true, running: 1 }), false);
  assert.equal(ov.coldLikely({ ok: true, idle: 0, ready: 0, running: 0, initializing: 1 }), true);
  assert.equal(ov.coldLikely({ ok: false }), true);
});

test('lane: Ming is refused while its endpoint is unset; VoxCPM2 runs, polls, files the take', async () => {
  const dir = tmp();
  let state = 'IN_QUEUE';
  const http = fakeHttp({
    get: (url) => url.endsWith('/health') ? { workers: { idle: 0, ready: 0, running: 0 } }
      : url.includes('/status/') ? (state === 'COMPLETED'
        ? { status: 'COMPLETED', executionTime: 7200, delayTime: 90000, output: { url: 'https://s3.us-east-005.backblazeb2.com/b/voxcpm/x.mp3?sig', wav_url: 'https://s3.us-east-005.backblazeb2.com/b/voxcpm/x.wav?sig', key: 'voxcpm/x.mp3', wav_key: 'voxcpm/x.wav', duration_seconds: 3.2, sample_rate: 48000, mode: 'design', seed: 99, engine: 'voxcpm2' } }
        : { status: state }) : {},
    post: (url) => url.endsWith('/run') ? { id: 'rp-1', status: 'IN_QUEUE' } : { ok: true },
  });
  const lane = ov.createOpenVoices({ env: { RUNPOD_API_KEY: 'test-only', KADE_USAGE_EVENT_SECRET: 'usage-test', FORK_USAGE_URL: 'https://fork.test' }, http, dataDir: dir });
  t_after(dir);
  assert.match((await lane.start({ engine: 'ming', userId: 'u1', mode: 'design', description: 'd', text: 't' })).error, /Ming is not set up/);
  assert.equal(lane.ready('ming'), false);
  assert.equal(lane.ready('voxcpm'), true);
  const r = await lane.start({ engine: 'voxcpm', userId: 'u1', mode: 'design', description: 'A bright voice', text: 'Hello there.', seed: 99 });
  assert.equal(r.ok, true);
  assert.equal(r.coldLikely, true);
  const run = http.calls.find((c) => c.url.endsWith('/run'));
  assert.equal(run.url, 'https://api.runpod.ai/v2/dewjq1ibxkp2c3/run');
  assert.deepEqual(run.body.input, { mode: 'design', text: 'Hello there.', description: 'A bright voice', seed: 99 });
  assert.equal('out_prefix' in run.body.input, false, 'no user id goes to the GPU worker');
  assert.match((await lane.start({ engine: 'voxcpm', userId: 'u1', mode: 'design', description: 'd', text: 't' })).error, /One take at a time/);
  await lane.pump();
  assert.equal(lane.find(r.jobId).state, 'queued');
  assert.match(lane.view(lane.find(r.jobId)).wait.spoken, /Waiting for the voice engine/);
  state = 'COMPLETED';
  await lane.pump();
  const job = lane.find(r.jobId);
  assert.equal(job.state, 'done');
  assert.equal(job.result.seconds, 3.2);
  assert.equal(job.result.cold, true);
  const asset = http.calls.find((c) => c.url === 'https://fork.test/api/kade/asset-event');
  assert.equal(asset.body.service, 'voxcpm_audio');
  assert.equal(asset.body.metadata.jobId, r.jobId);
  assert.deepEqual(asset.body.metadata.openVoice, { engine: 'voxcpm', mode: 'design', seed: 99, description: 'A bright voice', style: undefined, words: 'Hello there.', seconds: 3.2 });
  assert.ok(http.calls.some((c) => c.url === 'https://fork.test/api/kade/usage-event'));
  const v = lane.view(job);
  assert.equal(v.runpodId, undefined);
  assert.equal(v.wait, null);
  assert.equal(JSON.stringify(v).includes('test-only'), false);
});

test('lane: a worker error becomes the take error; a stuck queue gives up and cancels', async () => {
  const dir = tmp();
  t_after(dir);
  let clock = Date.parse('2026-11-15T00:00:00Z');
  const http = fakeHttp({
    get: (url) => url.endsWith('/health') ? { workers: { idle: 1 } }
      : url.includes('rp-err') ? { status: 'COMPLETED', executionTime: 1000, output: { error: 'The reference clip is silent or damaged.' } }
      : { status: 'IN_QUEUE' },
    post: (url, body) => url.endsWith('/run') ? { id: body.input.mode === 'clone' ? 'rp-err' : 'rp-stuck', status: 'IN_QUEUE' } : {},
  });
  const lane = ov.createOpenVoices({ env: { RUNPOD_API_KEY: 'k', MING_ENDPOINT_ID: 'ming0001' }, http, dataDir: dir, now: () => clock });
  const a = await lane.start({ engine: 'ming', userId: 'u1', mode: 'speak', reference_voice_url: CLIP, text: 'Words' });
  assert.equal(a.coldLikely, false);
  await lane.pump();
  assert.equal(lane.find(a.jobId).state, 'failed');
  assert.equal(lane.find(a.jobId).error, 'The reference clip is silent or damaged.');
  const b = await lane.start({ engine: 'ming', userId: 'u1', mode: 'design', description: 'd', text: 'Words' });
  clock += 31 * 60 * 1000; // Ming waits twice the 15-minute floor
  await lane.pump();
  assert.equal(lane.find(b.jobId).state, 'failed');
  assert.match(lane.find(b.jobId).error, /did not start/);
  assert.ok(http.calls.some((c) => c.url === 'https://api.runpod.ai/v2/ming0001/cancel/rp-stuck'));
});

test('routes: secret required, status is per owner, health names both engines', async (t) => {
  const dir = tmp();
  t_after(dir);
  const app = express();
  const http = fakeHttp({ get: () => ({ workers: { idle: 1 } }), post: () => ({ id: 'rp-9', status: 'IN_QUEUE' }) });
  ov.attachOpenVoices(app, { bridgeSecretOk: (_req, v) => v === 'test-only' }, { env: { RUNPOD_API_KEY: 'k', OPEN_VOICES_POLL_MS: '600000' }, http, dataDir: dir });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/audio/open-voices/start', { secret: 'no', engine: 'voxcpm' })).status, 403);
  const started = await (await post('/audio/open-voices/start', { secret: 'test-only', engine: 'voxcpm', userId: 'u1', mode: 'design', description: 'd', text: 'Hello' })).json();
  assert.equal(started.ok, true);
  assert.equal((await fetch(`${url}/audio/open-voices/status?secret=test-only&jobId=${started.jobId}&userId=u2`)).status, 404);
  const mine = await (await fetch(`${url}/audio/open-voices/status?secret=test-only&jobId=${started.jobId}&userId=u1`)).json();
  assert.equal(mine.state, 'queued');
  const health = await (await fetch(`${url}/audio/open-voices/health?secret=test-only`)).json();
  assert.equal(health.engines.voxcpm.configured, true);
  assert.equal(health.engines.ming.configured, false);
  assert.equal(health.engines.ming.controls, true, 'the fork offers Ming controls only when the bridge says it reads them');
  assert.equal(health.engines.voxcpm.controls, undefined);
  assert.deepEqual(Object.keys(health.engines), ['voxcpm', 'ming', 'chatterbox', 'dramabox']);
  assert.equal(health.engines.chatterbox.configured, false, 'off until CHATTERBOX_ENDPOINT_ID is set');
  assert.equal(health.engines.dramabox.configured, false, 'off until DRAMABOX_ENDPOINT_ID is set');
  assert.equal(health.engines.dramabox.maxText, 4000);
  const stop = await (await post('/audio/open-voices/cancel', { secret: 'test-only', jobId: started.jobId, userId: 'u1' })).json();
  assert.equal(stop.state, 'cancelled');
});

function t_after(dir) { process.on('exit', () => { try { fs.rmSync(dir, { recursive: true }); } catch (_) {} }); }

test('lane: a status 404 (RunPod forgot the job) fails the take, and her next take is accepted', async () => {
  const dir = tmp();
  t_after(dir);
  let lost = true;
  const http = fakeHttp({
    get: (url) => {
      if (url.endsWith('/health')) return { workers: { idle: 1 } };
      if (url.includes('/status/') && lost) { const e = new Error('Request failed with status code 404'); e.response = { status: 404 }; return e; }
      return { status: 'IN_QUEUE' };
    },
    post: (url) => url.endsWith('/run') ? { id: 'rp-gone', status: 'IN_QUEUE' } : {},
  });
  const lane = ov.createOpenVoices({ env: { RUNPOD_API_KEY: 'k' }, http, dataDir: dir });
  const a = await lane.start({ engine: 'voxcpm', userId: 'u1', mode: 'design', description: 'd', text: 'Words' });
  await lane.pump();
  assert.equal(lane.find(a.jobId).state, 'failed');
  assert.match(lane.find(a.jobId).error, /lost this take/);
  lost = false;
  const b = await lane.start({ engine: 'voxcpm', userId: 'u1', mode: 'design', description: 'd', text: 'Words' });
  assert.equal(b.ok, true);
});

test('lane: an overall deadline holds whatever /status answers', async () => {
  const dir = tmp();
  t_after(dir);
  let clock = Date.parse('2026-11-15T00:00:00Z');
  let answer = 'blip';
  const http = fakeHttp({
    get: (url) => url.endsWith('/health') ? { workers: { idle: 1 } }
      : answer === 'blip' ? new Error('socket hang up') : { error: 'something odd' },
    post: (url) => url.endsWith('/run') ? { id: 'rp-odd', status: 'IN_PROGRESS' } : {},
  });
  const lane = ov.createOpenVoices({ env: { RUNPOD_API_KEY: 'k' }, http, dataDir: dir, now: () => clock });
  const a = await lane.start({ engine: 'voxcpm', userId: 'u1', mode: 'design', description: 'd', text: 'Words' });
  clock += 30 * 60 * 1000;
  await lane.pump();
  assert.equal(lane.find(a.jobId).state, 'running', 'a blip inside the deadline keeps waiting');
  answer = 'odd';
  await lane.pump();
  assert.equal(lane.find(a.jobId).state, 'running', 'an unknown answer inside the deadline keeps waiting');
  clock += 6 * 60 * 1000; // past 15 min queue + 20 min run ceiling
  await lane.pump();
  assert.equal(lane.find(a.jobId).state, 'failed');
  assert.match(lane.find(a.jobId).error, /did not finish/);
  assert.ok(http.calls.some((c) => c.url.endsWith('/cancel/rp-odd')));
  assert.equal((await lane.start({ engine: 'voxcpm', userId: 'u1', mode: 'design', description: 'd', text: 'Again' })).ok, true);
});

test('lane: a take left filing by a restart is filed once, from its saved output', async () => {
  const dir = tmp();
  t_after(dir);
  const out = { url: 'https://s3.us-east-005.backblazeb2.com/b/voxcpm/y.mp3?sig', wav_url: 'https://s3.us-east-005.backblazeb2.com/b/voxcpm/y.wav?sig', key: 'voxcpm/y.mp3', wav_key: 'voxcpm/y.wav', duration_seconds: 2.5, sample_rate: 48000, mode: 'design', seed: 5, engine: 'voxcpm2' };
  fs.writeFileSync(path.join(dir, 'open-voices-jobs.json'), JSON.stringify([{ id: 'ov_filing1', userId: 'u1', engine: 'voxcpm', mode: 'design', text: 'Hi', description: 'd', style: '', seed: 5,
    state: 'filing', createdAt: '2026-11-15T00:00:00Z', submittedAt: '2026-11-15T00:00:00Z', runpodId: 'rp-f', costUSD: 0.01, out, receipted: true, usagePosted: true, result: null, error: null }]));
  const http = fakeHttp({ get: () => ({ status: 'COMPLETED', output: out, executionTime: 1000 }), post: () => ({ ok: true }) });
  const app = express();
  const lane = ov.attachOpenVoices(app, { bridgeSecretOk: () => true }, { env: { RUNPOD_API_KEY: 'k', KADE_USAGE_EVENT_SECRET: 's', FORK_USAGE_URL: 'https://fork.test', OPEN_VOICES_POLL_MS: '600000' }, http, dataDir: dir });
  assert.equal(lane.view(lane.find('ov_filing1')).wait.spoken, 'Saving the take.');
  await lane.pump();
  await lane.pump();
  const job = lane.find('ov_filing1');
  assert.equal(job.state, 'done');
  assert.equal(job.result.url, out.url);
  assert.equal(job.out, undefined);
  assert.equal(http.calls.filter((c) => c.url.endsWith('/asset-event')).length, 1, 'the asset is filed once');
  assert.equal(http.calls.filter((c) => c.url.endsWith('/usage-event')).length, 0, 'usage was already posted before the restart');
  assert.equal(http.calls.filter((c) => c.url.includes('/status/')).length, 0, 'no need to ask RunPod again');
  const receipts = fs.existsSync(path.join(dir, 'open-voices-receipts.jsonl')) ? fs.readFileSync(path.join(dir, 'open-voices-receipts.jsonl'), 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.equal(receipts.length, 0, 'the done receipt was already written');
  assert.equal(lane.health().open, 0);
});

test('worker errors reach her as plain sentences', () => {
  assert.equal(ov.plainError({ error: 'The reference clip is silent or damaged.' }), 'The reference clip is silent or damaged.');
  assert.match(ov.plainError({ error: 'VoxCPM2 could not finish (RuntimeError). No audio was generated.' }), /^The voice engine could not make this take/);
  assert.match(ov.plainError({ error: 'clone mode needs reference_voice_url.' }), /^The voice engine could not make this take/);
  assert.match(ov.plainError({ error: 'The VoxCPM2 worker is missing a required component.', error_code: 'missing_dependency' }), /missing a part/);
  assert.match(ov.plainError({ error: 'With prompt_text the clip must be at most 30 s and the transcript must cover all of it.' }), /thirty seconds or less/);
  assert.equal(ov.plainError({ error: 'The reference clip must be at least 3 seconds long.' }), 'That clip is too short. Use a clip of at least 3 seconds of clear speech.');
  assert.equal(ov.plainError({ error: 'The reference clip must be longer than 1 seconds for model original.' }), 'That clip is too short. Use a clip longer than 1 second of clear speech.');
  assert.match(ov.plainError({ error: 'The reference clip must be longer than 5 seconds for model turbo.' }), /^Chatterbox Turbo needs a clip longer than 5 seconds/);
  for (const m of ['RuntimeError', 'reference_voice_url', 'prompt_text']) {
    assert.equal(/RuntimeError|reference_voice_url|prompt_text/.test(ov.plainError({ error: m })), false, m);
  }
});

/* ---------- Ming's own controls (worker ming_contract.py) ---------- */

test('Ming design: a built-in voice instead of a description; never both', () => {
  const r = ov.buildInput('ming', { mode: 'design', voice: 'US_Emma', text: 'Hello.', seed: 3 });
  assert.deepEqual(r.input, { mode: 'design', text: 'Hello.', voice: 'US_Emma', seed: 3 });
  for (const v of ['UK_George', 'UK_Charlotte', '灵小柔', '灵楷']) assert.equal(ov.buildInput('ming', { mode: 'design', voice: v, text: 'Hi' }).input.voice, v);
  assert.match(ov.buildInput('ming', { mode: 'design', voice: 'US_Emma', description: 'warm', text: 'Hi' }).error, /built-in voice or a description, not both/);
  assert.match(ov.buildInput('ming', { mode: 'design', voice: 'Somebody', text: 'Hi' }).error, /Pick a built-in voice/);
  assert.match(ov.buildInput('ming', { mode: 'design', text: 'Hi' }).error, /or pick a built-in voice/);
  assert.match(ov.buildInput('ming', { mode: 'design', description: 'd', text: 'Hi', emotion: 'happy' }).error, /are for Speak with a voice/);
  assert.match(ov.buildInput('ming', { mode: 'design', description: 'd', text: 'Hi', language: 'de' }).error, /are for Speak with a voice/);
  assert.match(ov.buildInput('ming', { mode: 'design', description: 'd', text: 'Hi [Laughter]' }).error, /Sound tags need Speak with a voice/);
  assert.match(ov.buildInput('ming', { mode: 'clone', reference_voice_url: CLIP, voice: 'US_Emma', text: 'Hi' }).error, /for Design a voice/);
});

test('Ming speak: one of style, emotion, or speed/pitch/volume, passed as the worker names them', () => {
  const base = { mode: 'speak', reference_voice_url: CLIP, text: 'Words', seed: 1 };
  assert.deepEqual(ov.buildInput('ming', { ...base, emotion: 'Happy' }).input, { mode: 'clone', text: 'Words', reference_voice_url: CLIP, emotion: 'happy', seed: 1 });
  assert.deepEqual(ov.buildInput('ming', { ...base, speed: 'fast', pitch: 'low', volume: '' }).input,
    { mode: 'clone', text: 'Words', reference_voice_url: CLIP, speed: 'fast', pitch: 'low', seed: 1 });
  assert.equal(ov.buildInput('ming', { ...base, style: 'cheerful', emotion: '', speed: null }).input.style, 'cheerful');
  for (const mix of [{ emotion: 'sad', speed: 'slow' }, { emotion: 'sad', style: 'calm' }, { volume: 'high', style: 'calm' }]) {
    assert.match(ov.buildInput('ming', { ...base, ...mix }).error, /one of these per take/, JSON.stringify(mix));
  }
  assert.match(ov.buildInput('ming', { ...base, emotion: 'bored' }).error, /Pick an emotion/);
  assert.match(ov.buildInput('ming', { ...base, speed: 'very fast' }).error, /slow, medium or fast/);
  assert.match(ov.buildInput('ming', { ...base, pitch: 'loud' }).error, /low, medium or high for the pitch/);
  assert.match(ov.buildInput('ming', { ...base, language: 'it' }).error, /Pick a language/);
});

test('Ming sound tags need the clip words and nothing else; an unknown tag is refused plainly', () => {
  const base = { mode: 'speak', reference_voice_url: CLIP, seed: 1 };
  const ok = ov.buildInput('ming', { ...base, text: 'Well [Sigh] fine. [laughs]', prompt_text: 'what the clip says' });
  assert.equal(ok.error, undefined);
  assert.equal(ok.input.prompt_text, 'what the clip says');
  assert.deepEqual(ov.soundTags('Hi [Uhm] there [Question-huh] [chuckles]').tags, ['[Uhm]', '[Question-huh]', '[chuckles]']);
  assert.equal(ov.MING.tags.length, 14);
  assert.match(ov.buildInput('ming', { ...base, text: 'Well [Sigh] fine.' }).error, /Sound tags need a clip of thirty seconds or less whose words are typed in/);
  assert.match(ov.buildInput('ming', { ...base, text: 'Well [Sigh] fine.', prompt_text: 'p', style: 'calm' }).error, /Sound tags work only with no style/);
  assert.match(ov.buildInput('ming', { ...base, text: 'Well [Sigh] fine.', prompt_text: 'p', emotion: 'sad' }).error, /Sound tags work only with no style/);
  assert.match(ov.buildInput('ming', { ...base, text: 'Well [Yawn] fine.', prompt_text: 'p' }).error, /does not know the sound tag \[Yawn\]/);
  assert.match(ov.buildInput('ming', { mode: 'design', description: 'd', text: 'A [Yawn]' }).error, /\[Yawn\]/);
  assert.equal(ov.buildInput('ming', { ...base, text: 'Chapter [3] and [x1]' }).error, undefined, 'only the worker pattern counts as a tag');
});

test('Ming languages: German and the rest need the clip words and no other control; English and Chinese pass', () => {
  const base = { mode: 'speak', reference_voice_url: CLIP, text: 'Guten Tag.', seed: 1 };
  assert.deepEqual(ov.buildInput('ming', { ...base, language: 'DE', prompt_text: 'Hello there.' }).input,
    { mode: 'clone', text: 'Guten Tag.', reference_voice_url: CLIP, prompt_text: 'Hello there.', language: 'de', seed: 1 });
  assert.match(ov.buildInput('ming', { ...base, language: 'de' }).error, /^German needs a clip of thirty seconds or less/);
  assert.match(ov.buildInput('ming', { ...base, language: 'ja', prompt_text: 'p', speed: 'slow' }).error, /^Japanese works only with no style/);
  assert.equal(ov.buildInput('ming', { ...base, language: 'en', emotion: 'happy' }).input.language, 'en');
});

test('VoxCPM2 is unchanged and refuses Ming controls plainly', () => {
  const v = ov.buildInput('voxcpm', { mode: 'speak', reference_voice_url: CLIP, text: 'Words [Laughter] [Yawn]', seed: 2 });
  assert.deepEqual(v.input, { mode: 'clone', text: 'Words [Laughter] [Yawn]', reference_voice_url: CLIP, seed: 2 });
  for (const k of ['voice', 'emotion', 'speed', 'pitch', 'volume', 'language']) {
    assert.match(ov.buildInput('voxcpm', { mode: 'speak', reference_voice_url: CLIP, text: 'W', [k]: 'x' }).error, /work only with Ming/, k);
  }
  assert.equal(ov.buildInput('voxcpm', { mode: 'design', description: 'd', text: 'W', emotion: '' }).error, undefined, 'an empty control is not set');
});

test('lane: a Ming take sends exactly the worker fields and files its controls', async () => {
  const dir = tmp();
  t_after(dir);
  let done = false;
  const out = { url: 'https://s3.us-east-005.backblazeb2.com/b/ming/x.mp3?sig', wav_url: 'https://s3.us-east-005.backblazeb2.com/b/ming/x.wav?sig', key: 'ming/x.mp3', wav_key: 'ming/x.wav', duration_seconds: 2, sample_rate: 44100, mode: 'design', seed: 8, engine: 'ming-3.0-tts-tiny' };
  const http = fakeHttp({
    get: (url) => url.endsWith('/health') ? { workers: { idle: 1 } } : done ? { status: 'COMPLETED', executionTime: 2000, output: out } : { status: 'IN_PROGRESS' },
    post: (url) => url.endsWith('/run') ? { id: 'rp-m', status: 'IN_QUEUE' } : { ok: true },
  });
  const lane = ov.createOpenVoices({ env: { RUNPOD_API_KEY: 'k', MING_ENDPOINT_ID: 'ming0001', KADE_USAGE_EVENT_SECRET: 's', FORK_USAGE_URL: 'https://fork.test' }, http, dataDir: dir });
  const r = await lane.start({ engine: 'ming', userId: 'u1', mode: 'design', voice: 'UK_George', text: 'Good evening.', seed: 8, emotion: '' });
  assert.equal(r.ok, true);
  assert.deepEqual(http.calls.find((c) => c.url.endsWith('/run')).body.input, { mode: 'design', text: 'Good evening.', voice: 'UK_George', seed: 8 });
  done = true;
  await lane.pump();
  const asset = http.calls.find((c) => c.url.endsWith('/asset-event'));
  assert.deepEqual(asset.body.metadata.openVoice.controls, { voice: 'UK_George' });
  assert.equal(asset.body.prompt, 'Built-in voice: George, British English, man\n\nGood evening.');
});

test('every built-in voice has a spoken name for My Creations', () => {
  for (const v of ov.MING.voices) assert.ok(ov.VOICE_LABELS[v], v);
  assert.equal(ov.VOICE_LABELS['\u7075\u5c0f\u67d4'], 'Ling Xiaorou, Chinese, young woman');
});

/* ---------- Chatterbox and DramaBox (Nov 16 2026; workers chatterbox_contract.py, dramabox_contract.py) ---------- */

test('Chatterbox and DramaBox are off until their endpoint env is set', () => {
  assert.equal(ov.endpointOf('chatterbox', {}), '');
  assert.equal(ov.endpointOf('dramabox', {}), '');
  assert.equal(ov.endpointOf('chatterbox', { CHATTERBOX_ENDPOINT_ID: 'cbox0001' }), 'cbox0001');
  assert.equal(ov.endpointOf('dramabox', { DRAMABOX_ENDPOINT_ID: 'dbox0001' }), 'dbox0001');
  const lane = ov.createOpenVoices({ env: { RUNPOD_API_KEY: 'k' }, http: fakeHttp(), dataDir: tmp() });
  assert.equal(lane.ready('chatterbox'), false);
  assert.equal(lane.ready('dramabox'), false);
  assert.equal(ov.ENGINES.chatterbox.maxText, 5000);
  assert.equal(ov.ENGINES.dramabox.maxText, 4000);
});

test('Chatterbox design: its own built-in voice, the version as model; a description or style is refused', () => {
  assert.deepEqual(ov.buildInput('chatterbox', { mode: 'design', text: ' Hello there. ', seed: 4 }).input, { mode: 'design', text: 'Hello there.', model: 'turbo', seed: 4 });
  assert.deepEqual(ov.buildInput('chatterbox', { mode: 'design', text: 'Hi', version: 'Original', exaggeration: '0.7', cfg_weight: 0.3, temperature: 1.2, seed: 1 }).input,
    { mode: 'design', text: 'Hi', model: 'original', temperature: 1.2, exaggeration: 0.7, cfg_weight: 0.3, seed: 1 });
  assert.match(ov.buildInput('chatterbox', { mode: 'design', text: 'Hi', description: 'warm' }).error, /own built-in voice here\. To use your own voice, choose Speak with a voice/);
  assert.match(ov.buildInput('chatterbox', { mode: 'speak', reference_voice_url: CLIP, text: 'Hi', style: 'calm' }).error, /takes no style/);
  assert.match(ov.buildInput('chatterbox', { mode: 'design', text: 'Hi', version: 'mega' }).error, /Turbo, Original or Multilingual/);
  assert.match(ov.buildInput('chatterbox', { mode: 'design', text: 'x'.repeat(5001) }).error, /too long for Chatterbox. The most is 5000/);
  for (const k of ['voice', 'emotion', 'language']) assert.match(ov.buildInput('chatterbox', { mode: 'design', text: 'Hi', [k]: 'x' }).error, /work only with Ming/, k);
});

test('Chatterbox speak: our clip as reference_url, no prompt_text, no description', () => {
  const r = ov.buildInput('chatterbox', { mode: 'speak', reference_voice_url: CLIP, text: 'Words', prompt_text: 'clip words', seed: 2 });
  assert.deepEqual(r.input, { mode: 'clone', text: 'Words', reference_url: CLIP, model: 'turbo', seed: 2 });
  assert.match(ov.buildInput('chatterbox', { mode: 'speak', text: 'Words' }).error, /saved voice or a clip/);
  assert.match(ov.buildInput('chatterbox', { mode: 'speak', reference_voice_url: 'https://evil.example/a.wav', text: 'Words' }).error, /not stored/);
});

test('Chatterbox sound tags: Turbo knows its own list and the other spellings; the others refuse them', () => {
  const ok = ov.buildInput('chatterbox', { mode: 'design', text: 'Well [sigh] fine. [Laughs] [clear throat] [whispering] ok', seed: 1 });
  assert.equal(ok.error, undefined);
  assert.equal(ok.input.text, 'Well [sigh] fine. [Laughs] [clear throat] [whispering] ok', 'the worker rewrites spellings itself');
  assert.equal(ov.CHATTERBOX.eventTags.length + ov.CHATTERBOX.styleTags.length, 19);
  assert.match(ov.buildInput('chatterbox', { mode: 'design', text: 'Well [yawn] fine.' }).error, /Turbo does not know the sound tag \[yawn\]/);
  assert.match(ov.buildInput('chatterbox', { mode: 'design', text: 'Chapter [3]' }).error, /\[3\]/, 'Turbo reads any brackets as a tag');
  assert.match(ov.buildInput('chatterbox', { mode: 'design', text: '[laugh] [sigh]' }).error, /not only sound tags/);
  assert.match(ov.buildInput('chatterbox', { mode: 'design', text: 'Well [sigh] fine.', version: 'original' }).error, /work only with Chatterbox Turbo/);
  assert.equal(ov.buildInput('chatterbox', { mode: 'design', text: 'Chapter [3]', version: 'original' }).error, undefined, 'other brackets are words for Original');
});

test('Chatterbox knobs: ranges per version, as the worker checks them', () => {
  const d = (b) => ov.buildInput('chatterbox', { mode: 'design', text: 'Hi', ...b });
  assert.match(d({ temperature: 3 }).error, /Variety must be a number from 0.05 to 2 for Turbo/);
  assert.equal(d({ version: 'original', temperature: 3 }).input.temperature, 3);
  assert.match(d({ version: 'original', temperature: 6 }).error, /0.05 to 5/);
  assert.match(d({ exaggeration: 1 }).error, /for Original and Multilingual/);
  assert.match(d({ cfg_weight: 0.5 }).error, /for Original and Multilingual/);
  assert.equal(d({ exaggeration: '', cfg_weight: null }).error, undefined, 'empty knobs are not set');
  assert.match(d({ version: 'original', exaggeration: 0.2 }).error, /Expressiveness must be a number from 0.25 to 2/);
  assert.match(d({ version: 'original', cfg_weight: 0 }).error, /above 0 and at most 1 for Original/);
  assert.match(d({ version: 'original', cfg_weight: 1.5 }).error, /above 0/);
  assert.equal(d({ version: 'multilingual', language_id: 'de', cfg_weight: 0 }).input.cfg_weight, 0);
  assert.match(d({ version: 'multilingual' }).error, /Pick a language for Multilingual/);
  assert.match(d({ version: 'multilingual', language_id: 'xx' }).error, /Pick a language/);
  assert.deepEqual(d({ version: 'multilingual', language_id: 'DE', seed: 3 }).input, { mode: 'design', text: 'Hi', model: 'multilingual', language_id: 'de', seed: 3 });
  assert.match(d({ version: 'original', language_id: 'fr' }).error, /English only/);
  assert.equal(d({ version: 'turbo', language_id: 'en' }).input.language_id, undefined, 'English is the default and is not sent');
  assert.equal(ov.CHATTERBOX.languages.length, 23);
  assert.match(d({ temperature: 'warm' }).error, /Variety/);
});

test('DramaBox: the scene goes as prompt, watermark off, quotes checked, optional length and clip seconds', () => {
  const scene = 'An old sailor leans on the rail. "Storm\'s coming." He laughs softly. "Always is."';
  assert.deepEqual(ov.buildInput('dramabox', { mode: 'design', text: scene, seed: 9 }).input, { mode: 'design', prompt: scene, watermark: false, seed: 9 });
  const clone = ov.buildInput('dramabox', { mode: 'speak', reference_voice_url: CLIP, text: scene, duration: '12', reference_seconds: 15, seed: 1 }).input;
  assert.deepEqual(clone, { mode: 'clone', prompt: scene, reference_url: CLIP, watermark: false, duration: 12, reference_seconds: 15, seed: 1 });
  assert.equal(ov.buildInput('dramabox', { mode: 'design', text: 'She smiles. “Hello.”' }).error, undefined, 'curly quotes count');
  assert.match(ov.buildInput('dramabox', { mode: 'design', text: 'She smiles. "Hello.' }).error, /not closed/);
  assert.match(ov.buildInput('dramabox', { mode: 'design', text: 'She smiles and waves.' }).error, /at least one spoken line inside double quotes/);
  assert.match(ov.buildInput('dramabox', { mode: 'design', text: '' }).error, /Write the scene first/);
  assert.match(ov.buildInput('dramabox', { mode: 'design', text: '"' + 'x'.repeat(4000) + '"' }).error, /scene is too long for DramaBox. The most is 4000/);
  assert.match(ov.buildInput('dramabox', { mode: 'design', text: scene, description: 'a sailor' }).error, /takes no description/);
  assert.match(ov.buildInput('dramabox', { mode: 'speak', reference_voice_url: CLIP, text: scene, style: 'calm' }).error, /DramaBox takes no style/);
  for (const bad of [2, 46, 'long']) assert.match(ov.buildInput('dramabox', { mode: 'design', text: scene, duration: bad }).error, /Scene length must be from 3 to 45 seconds/, String(bad));
  assert.equal(ov.buildInput('dramabox', { mode: 'design', text: scene, duration: 0 }).input.duration, undefined, '0 is automatic');
  assert.equal(ov.buildInput('dramabox', { mode: 'design', text: scene, duration: '' }).input.duration, undefined);
  assert.match(ov.buildInput('dramabox', { mode: 'design', text: scene, reference_seconds: 10 }).error, /for Speak with a voice/);
  assert.match(ov.buildInput('dramabox', { mode: 'speak', reference_voice_url: CLIP, text: scene, reference_seconds: 40 }).error, /from 3 to 30 seconds/);
  assert.equal(ov.spokenLines(scene), "Storm's coming. Always is.");
});

test('lane: a Chatterbox take sends exactly the worker fields; its title, words and version are filed', async () => {
  const dir = tmp();
  t_after(dir);
  let done = false;
  const out = { url: 'https://s3.us-east-005.backblazeb2.com/b/chatterbox/x.mp3?sig', wav_url: 'https://s3.us-east-005.backblazeb2.com/b/chatterbox/x.wav?sig', key: 'chatterbox/x.mp3', wav_key: 'chatterbox/x.wav', duration_seconds: 2.4, sample_rate: 24000, mode: 'clone', seed: 6, engine: 'chatterbox', model: 'turbo' };
  const http = fakeHttp({
    get: (url) => url.endsWith('/health') ? { workers: { idle: 1 } } : done ? { status: 'COMPLETED', executionTime: 3600000, output: out } : { status: 'IN_PROGRESS' },
    post: (url) => url.endsWith('/run') ? { id: 'rp-c', status: 'IN_QUEUE' } : { ok: true },
  });
  const lane = ov.createOpenVoices({ env: { RUNPOD_API_KEY: 'k', CHATTERBOX_ENDPOINT_ID: 'cbox0001', KADE_USAGE_EVENT_SECRET: 's', FORK_USAGE_URL: 'https://fork.test' }, http, dataDir: dir });
  assert.match((await lane.start({ engine: 'dramabox', userId: 'u1', mode: 'design', text: '"Hi."' })).error, /DramaBox is not set up/);
  const r = await lane.start({ engine: 'chatterbox', userId: 'u1', mode: 'speak', reference_voice_url: CLIP, text: 'Oh [laugh] that is good.', version: 'turbo', temperature: 0.9, seed: 6 });
  assert.equal(r.ok, true);
  const run = http.calls.find((c) => c.url.endsWith('/run'));
  assert.equal(run.url, 'https://api.runpod.ai/v2/cbox0001/run');
  assert.deepEqual(run.body.input, { mode: 'clone', text: 'Oh [laugh] that is good.', reference_url: CLIP, model: 'turbo', temperature: 0.9, seed: 6 });
  assert.equal(lane.view(lane.find(r.jobId)).version, 'turbo');
  done = true;
  await lane.pump();
  const job = lane.find(r.jobId);
  assert.equal(job.state, 'done');
  assert.equal(job.result.version, 'turbo');
  assert.equal(job.costUSD, 1.34, 'the 24 GB rate');
  const asset = http.calls.find((c) => c.url.endsWith('/asset-event'));
  assert.equal(asset.body.service, 'chatterbox_audio');
  assert.equal(asset.body.metadata.engine, 'Chatterbox Turbo');
  assert.equal(asset.body.metadata.openVoice.version, 'turbo');
  assert.equal(asset.body.metadata.openVoice.words, 'Oh that is good.', 'the clip words carry no tags');
  assert.deepEqual(asset.body.metadata.openVoice.controls, { model: 'turbo', temperature: 0.9 });
});

test('lane: a DramaBox design take files the scene as the prompt and only the spoken lines as words; it waits twice as long to start', async () => {
  const dir = tmp();
  t_after(dir);
  let clock = Date.parse('2026-11-16T00:00:00Z');
  let state = 'IN_QUEUE';
  const out = { url: 'https://s3.us-east-005.backblazeb2.com/b/dramabox/x.mp3?sig', key: 'dramabox/x.mp3', duration_seconds: 4, sample_rate: 48000, mode: 'design', seed: 2, engine: 'dramabox' };
  const http = fakeHttp({
    get: (url) => url.endsWith('/health') ? { workers: { idle: 0 } } : state === 'COMPLETED' ? { status: 'COMPLETED', executionTime: 1800000, output: out } : { status: state },
    post: (url) => url.endsWith('/run') ? { id: 'rp-d', status: 'IN_QUEUE' } : { ok: true },
  });
  const lane = ov.createOpenVoices({ env: { RUNPOD_API_KEY: 'k', DRAMABOX_ENDPOINT_ID: 'dbox0001', KADE_USAGE_EVENT_SECRET: 's', FORK_USAGE_URL: 'https://fork.test' }, http, dataDir: dir, now: () => clock });
  const scene = 'A tired nurse, gentle. "You did well." She sighs. "Rest now."';
  const r = await lane.start({ engine: 'dramabox', userId: 'u1', mode: 'design', text: scene, duration: 8, seed: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.coldLikely, true);
  assert.deepEqual(http.calls.find((c) => c.url.endsWith('/run')).body.input, { mode: 'design', prompt: scene, watermark: false, duration: 8, seed: 2 });
  clock += 20 * 60 * 1000; // past VoxCPM2's 15 minutes, inside DramaBox's 30
  await lane.pump();
  assert.equal(lane.find(r.jobId).state, 'queued');
  state = 'COMPLETED';
  await lane.pump();
  assert.equal(lane.find(r.jobId).state, 'done');
  assert.equal(lane.find(r.jobId).costUSD, 0.945, 'the 48 GB rate');
  const asset = http.calls.find((c) => c.url.endsWith('/asset-event'));
  assert.equal(asset.body.service, 'dramabox_audio');
  assert.equal(asset.body.prompt, scene);
  assert.equal(asset.body.metadata.engine, 'DramaBox');
  assert.equal(asset.body.metadata.openVoice.words, 'You did well. Rest now.');
  assert.deepEqual(asset.body.metadata.openVoice.controls, { duration: 8 });
  assert.equal('version' in asset.body.metadata.openVoice, false);
});

test('Chatterbox and DramaBox worker sentences reach her plainly', () => {
  assert.match(ov.plainError({ error: 'The reference clip must be longer than 5 seconds for model turbo (5 to 10 seconds of clear speech is best).' }), /^Chatterbox Turbo needs a clip longer than 5 seconds/);
  assert.match(ov.plainError({ error: 'The reference clip must be at least 3 seconds long.' }), /too short/);
  assert.match(ov.plainError({ error: 'The reference clip is mostly silent. It needs at least 3 seconds of clear voice (half the clip, if it is shorter than 6 seconds).' }), /mostly silent/);
  assert.equal(ov.plainError({ error: 'The scene is too long: about 320 s of audio, at most 300 s.' }), 'The scene is too long: about 320 seconds of audio. The most is 300 seconds.');
  assert.match(ov.plainError({ error: 'One sentence is too long to say in one take (about 50 s, at most 45 s). Break it into shorter sentences.' }), /^One spoken sentence is too long/);
  assert.match(ov.plainError({ error: 'Chatterbox could not finish (RuntimeError). No audio was generated.' }), /^The voice engine could not make this take/);
  assert.match(ov.plainError({ error: 'The DramaBox worker is missing a required component.', error_code: 'missing_dependency' }), /missing a part/);
});

test('every engine keeps one shape for Ming, VoxCPM2 and the labels', () => {
  assert.equal(ov.engineLabel({ engine: 'chatterbox', version: 'multilingual' }), 'Chatterbox Multilingual');
  assert.equal(ov.engineLabel({ engine: 'ming' }), 'Ming');
  assert.deepEqual(ov.buildInput('voxcpm', { mode: 'design', description: 'd', text: 'W', version: 'turbo', duration: 9, seed: 1 }).input, { mode: 'design', text: 'W', description: 'd', seed: 1 }, 'the new fields never reach VoxCPM2');
});

test('Quality and How closely it follows: strings from the page, each worker own names, plain refusals', () => {
  const v = ov.buildInput('voxcpm', { mode: 'design', description: 'A warm voice', text: 'Hi', steps: '30', cfg: '2.5', seed: 1 });
  assert.deepEqual(v.input, { mode: 'design', text: 'Hi', description: 'A warm voice', seed: 1, cfg_value: 2.5, inference_timesteps: 30 });
  assert.match(ov.buildInput('voxcpm', { mode: 'design', description: 'd', text: 'Hi', steps: '12.5' }).error, /Quality must be a whole number from 4 to 50/);
  assert.match(ov.buildInput('voxcpm', { mode: 'design', description: 'd', text: 'Hi', steps: 51 }).error, /from 4 to 50/);
  assert.match(ov.buildInput('voxcpm', { mode: 'design', description: 'd', text: 'Hi', cfg: 'lots' }).error, /from 0.5 to 5/);
  assert.equal(ov.buildInput('voxcpm', { mode: 'design', description: 'd', text: 'Hi', steps: '', cfg: null }).error, undefined, 'empty is the usual');
  const scene = 'An old sailor. "Storm is coming."';
  const d = ov.buildInput('dramabox', { mode: 'design', text: scene, cfg: '3.5', seed: 2 });
  assert.equal(d.input.cfg_scale, 3.5);
  assert.equal(d.input.prompt, scene);
  assert.match(ov.buildInput('dramabox', { mode: 'design', text: scene, cfg: 11 }).error, /from 1 to 10/);
  assert.match(ov.buildInput('dramabox', { mode: 'design', text: scene, steps: 20 }).error, /Quality is not a setting DramaBox has/);
  assert.match(ov.buildInput('chatterbox', { mode: 'design', text: 'Hi', cfg: 2 }).error, /not a setting Chatterbox has/);
});

test('the chosen settings are filed with the take', async () => {
  const http = fakeHttp({ post: (url) => (url.endsWith('/run') ? { id: 'rp1', status: 'IN_QUEUE' } : {}), get: () => ({ workers: { idle: 1, ready: 1, running: 0 } }) });
  const lane = ov.createOpenVoices({ env: { RUNPOD_API_KEY: 'k', DRAMABOX_ENDPOINT_ID: 'dramaboxend1' }, http, dataDir: tmp() });
  const r = await lane.start({ engine: 'dramabox', userId: 'u1', mode: 'design', text: 'A man. "Hello."', cfg: 3.5 });
  assert.ok(!r.error, r.error);
  const run = http.calls.find((c) => c.url.endsWith('/run'));
  assert.equal(run.body.input.cfg_scale, 3.5);
  assert.equal(lane.find(r.jobId).controls.cfg_scale, 3.5);
});
