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
  const m = ov.buildInput('ming', { mode: 'clone', reference_voice_url: CLIP, text: 'Words', cfg: 0.7, steps: 12 });
  assert.equal(m.input.flow_steps, 12);
  assert.equal(m.input.cfg_scale, undefined, 'Ming takes cfg_scale from 1');
  assert.match(ov.buildInput('ming', { mode: 'clone', text: 'Words' }).error, /saved voice or a clip/);
  assert.match(ov.buildInput('ming', { mode: 'clone', reference_voice_url: 'https://evil.example/a.wav', text: 'Words' }).error, /not stored/);
  assert.match(ov.buildInput('ming', { mode: 'clone', reference_voice_url: CLIP, text: 'x'.repeat(5001) }).error, /5000/);
  assert.match(ov.buildInput('nope', { mode: 'design' }).error, /VoxCPM2 or Ming/);
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
  for (const m of ['RuntimeError', 'reference_voice_url', 'prompt_text']) {
    assert.equal(/RuntimeError|reference_voice_url|prompt_text/.test(ov.plainError({ error: m })), false, m);
  }
});
