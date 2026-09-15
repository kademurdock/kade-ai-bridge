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
