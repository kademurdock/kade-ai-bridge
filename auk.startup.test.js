'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('AuK startup never restarts workers based on queue age and speaks the enforced deadline', () => {
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'scenema.js'), 'utf8'), {
    module: mod, require, console, Buffer, URL, setTimeout, clearTimeout,
    process: { env: { AUK_ENDPOINT_ID: 'test-only', SCENEMA_ENABLED: '0' } },
  });
  const { isZombie, queueLimitMs, waitInfo, QUEUE_TIMEOUT_MS } = mod.exports._internals;
  for (const extra of [{ running: 1 }, { initializing: 2 }, { throttled: 3 }, { ready: 1 }]) {
    const cap = { ok: true, running: 0, initializing: 0, inProgress: 0, ...extra };
    assert.equal(isZombie(cap, QUEUE_TIMEOUT_MS * 3), false);
    assert.equal(queueLimitMs(cap), QUEUE_TIMEOUT_MS);
    const job = { state: 'queued', submittedAt: new Date(Date.now() - QUEUE_TIMEOUT_MS + 60000).toISOString() };
    const wait = waitInfo(job, cap);
    assert.match(wait.spoken, /I give up in 1 minute/);
    assert.doesNotMatch(wait.spoken, /Restarting|Rendering now|datacentre is full|None are free/);
  }
});

test('AuK forwards edit ranges and edge preservation, rejecting invalid numbers before submission', async () => {
  const sent = [];
  const mod = { exports: {} };
  const provider = { create: () => ({ post: async (_path, body) => { sent.push(body.input); return { data: { id: 'fixture-job', status: 'IN_QUEUE' } }; } }) };
  const storage = { readFileSync: () => { throw Error('empty fixture'); }, writeFileSync() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'scenema.js'), 'utf8'), {
    module: mod, require: name => name === 'axios' ? provider : name === 'fs' ? storage : require(name), console, Buffer, URL, setTimeout, clearTimeout,
    process: { env: { AUK_ENDPOINT_ID: 'test-only', RUNPOD_API_KEY: 'test-only' } },
  });
  const options = { auk_task: 'edit', instruction: 'Replace Tuesday with Thursday.', reference_voice_url: 'https://storage.test/recording.wav', edit_start: 12.5, edit_end: 15, gen_seconds: 3, preserve_before: false, preserve_after: true };
  for (const edit_start of [-1, Infinity, NaN, '12']) {
    const result = mod.exports.makeJob({ userId: 'invalid', prompt: '', options: { ...options, edit_start } });
    assert.match(result.error, /valid seconds/);
  }
  assert.equal(sent.length, 0);
  const result = mod.exports.makeJob({ userId: 'owner', prompt: '', options });
  assert.equal(result.ok, true);
  assert.match(result.estimate.spokenWait, /\$1\.75/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  for (const key of Object.keys(options)) assert.equal(sent[0][key], options[key], key);
});
