'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

function fixture(t, response, notification = { ok: true, sent: 1 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-completion-'));
  const file = path.join(dir, 'scenema-jobs.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'test-job', userId: 'owner', agentId: 'soundbooth',
    state: 'running', runpodId: 'provider-job', createdAt: new Date(Date.now() - 300000).toISOString() }]));
  const pushes = [];
  const mod = { exports: {} };
  const provider = { create: () => ({ get: async () => ({ data: await response() }) }),
    post: async () => ({ data: {} }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'scenema.js'), 'utf8'), {
    module: mod, require: name => name === 'axios' ? provider : require(name), console,
    process: { env: { SCENEMA_ENABLED: '0', RAILWAY_VOLUME_MOUNT_PATH: dir } },
    Buffer, URL, setTimeout, clearTimeout,
  });
  mod.exports.attachScenema(express(), { runNotify: async payload => { pushes.push(payload); return notification; } });
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return { pump: mod.exports._internals.pump, read: () => JSON.parse(fs.readFileSync(file))[0], pushes };
}

test('worker errors end the job and request one targeted, routed failure notification', async t => {
  const f = fixture(t, () => ({ status: 'COMPLETED', output: { error: 'Missing worker dependency' } }));
  await f.pump(); await f.pump();
  assert.equal(f.read().state, 'failed');
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0].userId, 'owner');
  assert.equal(f.pushes[0].requested, true);
  assert.equal(f.pushes[0].route, 'sound-booth');
  assert.equal(f.pushes[0].broadcast, undefined);
  assert.equal(f.read().notification.accepted, 1);
});

test('provider success produces one completion notification and persistent result', async t => {
  const f = fixture(t, () => ({ status: 'COMPLETED', output: { url: 'https://example.invalid/audio', duration_s: 12 } }));
  await f.pump(); await f.pump();
  assert.equal(f.read().state, 'done');
  assert.equal(f.pushes.length, 1);
  assert.match(f.pushes[0].title, /ready/);
  assert.equal(f.pushes[0].requested, true);
});

test('repeated missing provider records terminate waiting, transient misses do not', async t => {
  let missing = true;
  const f = fixture(t, () => {
    if (missing) throw Object.assign(Error('Not found'), { response: { status: 404 } });
    return { status: 'IN_PROGRESS' };
  });
  await f.pump(); await f.pump();
  assert.equal(f.read().state, 'running');
  missing = false; await f.pump(); missing = true;
  await f.pump(); await f.pump();
  assert.equal(f.read().state, 'running');
  await f.pump(); await f.pump();
  assert.equal(f.read().state, 'failed');
  assert.match(f.read().error, /no longer has this job record/);
  assert.equal(f.pushes.length, 1);
});

test('blocked and deferred notifications are recorded without claiming delivery', async t => {
  for (const result of [{ ok: false, blocked: 'muted' }, { ok: true, sent: 0, deferred: true }]) {
    const f = fixture(t, () => ({ status: 'FAILED', error: 'Worker stopped' }), result);
    await f.pump();
    assert.equal(f.read().state, 'failed');
    assert.equal(f.read().notification.accepted, 0);
    assert.equal(f.read().notification.deferred, !!result.deferred);
    if (result.blocked) assert.equal(f.read().notification.blocked, 'muted');
  }
});
