'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
test('Scenema cancellation preserves state until the provider confirms', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenema-cancel-'));
  const jobs = [{ id: 'active', userId: 'tester', prompt: 'test line', state: 'queued', runpodId: 'rp-active' },
    { id: 'finished', userId: 'tester', prompt: 'test line', state: 'done', runpodId: 'rp-finished' }];
  fs.writeFileSync(path.join(dir, 'scenema-jobs.json'), JSON.stringify(jobs));
  let failed = true, calls = 0;
  const mod = { exports: {} };
  const provider = { create: () => ({ post: async () => { calls++; if (failed) throw Error('provider offline'); return { data: {} }; } }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'scenema.js'), 'utf8'), {
    module: mod, require: (name) => name === 'axios' ? provider : require(name), console,
    process: { env: { SCENEMA_ENABLED: '0', RAILWAY_VOLUME_MOUNT_PATH: dir } }, Buffer, URL, setTimeout, clearTimeout,
  });
  const app = express(); mod.exports.attachScenema(app, { bridgeSecretOk: (_req, value) => value === 'test-only' });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.on('listening', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true }); });
  const cancel = async (jobId) => { const r = await fetch('http://127.0.0.1:' + server.address().port + '/audio/scenema/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: 'test-only', jobId }) }); return { status: r.status, data: await r.json() }; };
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'scenema-jobs.json')));
  const rejected = await cancel('active'); assert.equal(rejected.status, 502); assert.equal(read()[0].state, 'queued');
  failed = false; const stopped = await cancel('active'); assert.equal(stopped.data.state, 'cancelled'); assert.equal(read()[0].state, 'cancelled');
  const before = calls; assert.equal((await cancel('active')).data.state, 'cancelled'); assert.equal(calls, before);
  assert.equal((await cancel('finished')).data.state, 'done'); assert.equal(calls, before);
});
