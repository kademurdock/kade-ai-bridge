'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAnnouncementService, attachAnnouncements, validatePayload } = require('./announcements');

const AGENT = 'agent_NkG_Fb8_xLz8HFJyx4gNv';
const input = () => ({ id: 'angel-intro-20261009-01', title: 'Meet Angel 👼✨', body: 'Tap for a fresh chat with Angel.', agentId: AGENT, channels: { native: true, web: true } });

function fixture(t, overrides = {}) {
  const parent = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, 'kade-announcement-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), parent);
    assert.ok(path.basename(dir).startsWith('kade-announcement-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const events = [], history = new Map();
  const counts = { native: 0, web: 0, budget: 0, publication: 0, audience: 0, pruned: 0 };
  const deps = {
    storePath: path.join(dir, 'operations.json'), persistentStorage: true, nativeTimeoutMs: 15,
    bridgeSecretOk: req => req.get('x-bridge-secret') === 'test-admin',
    nativeRegistry: () => ({ registered: 2, iosConfigured: true, androidConfigured: true, rows: [
      { token: 'test-device-a', userId: '111111111111111111111111', platform: 'ios' },
      { token: 'test-device-b', userId: '222222222222222222222222', platform: 'android' },
    ] }),
    readAudience: async (agentId, userIds) => {
      counts.audience++;
      assert.deepEqual(userIds, ['111111111111111111111111', '222222222222222222222222']);
      return { ok: true, publicAgent: { id: agentId, name: 'Angel', isPublic: true },
        accounts: { total: 3, eligible: 3, excludedTest: 0 }, nativeEligibleIndexes: [0, 1],
        web: { configured: true, subscriptions: 1, users: 1 } };
    },
    notificationGate: () => ({ allowed: true }),
    publishHistory: entry => { counts.publication++; events.push('published'); history.set(entry.id, entry); },
    updateHistory: (id, update) => { assert.ok(history.has(id)); history.set(id, { ...history.get(id), ...update }); },
    sendNative: async (_token, title, body, opts) => {
      counts.native++;
      const persisted = JSON.parse(fs.readFileSync(deps.storePath));
      assert.equal(persisted[input().id].published, true);
      assert.equal(persisted[input().id].native.results.length, 2);
      assert.ok(history.has(input().id));
      assert.deepEqual(opts, { category: 'KADE_ROUTE', data: { kadeRoute: 'agent-chat', kadeAgentId: AGENT, kadeAnnouncementId: input().id } });
      assert.equal(title, input().title); assert.equal(body, input().body);
      events.push('native'); return { status: 200 };
    },
    sendWeb: async payload => {
      counts.web++; events.push('web');
      assert.ok(history.has(payload.id));
      assert.equal(payload.url, 'https://kademurdock.com/c/new?agent_id=' + AGENT);
      assert.equal(JSON.parse(fs.readFileSync(deps.storePath))[payload.id].web.state, 'sending');
      return { ok: true, id: payload.id, payloadHash: payload.payloadHash, state: 'complete', configured: true,
        eligibleUsers: 1, subscriptions: 1, attempted: 1, accepted: 1, failed: 0, unknown: 0 };
    },
    readWeb: async () => { throw new Error('not available'); },
    pruneNative: () => { counts.pruned++; }, chargeBudget: () => { counts.budget++; },
    ...overrides,
  };
  return { deps, service: createAnnouncementService(deps), counts, events, history, dir };
}

test('persists one announcement before either fanout and carries the exact fresh-chat target', async t => {
  const f = fixture(t);
  const result = await f.service.start(input());
  assert.equal(result.state, 'complete'); assert.equal(result.persistent, true);
  assert.equal(result.native.accepted, 2); assert.equal(result.web.accepted, 1);
  assert.deepEqual(f.events, ['published', 'native', 'native', 'web']);
  assert.equal(f.counts.budget, 1); assert.equal(f.counts.publication, 1);
  assert.equal(f.history.get(input().id).kadeAgentId, AGENT);
  assert.ok(!JSON.stringify(result).includes('test-device'));
  assert.ok(!JSON.stringify(result).includes('111111111111111111111111'));
});

test('same operation on repeated POST or after restart never repeats any send', async t => {
  const f = fixture(t);
  await f.service.start(input());
  const second = await f.service.start(input());
  const restored = createAnnouncementService(f.deps);
  const third = await restored.start(input());
  assert.equal(second.deduplicated, true); assert.equal(third.deduplicated, true);
  assert.equal(f.counts.native, 2); assert.equal(f.counts.web, 1); assert.equal(f.counts.publication, 1);
});

test('an operation ID cannot be reused for changed content, target or channels', async t => {
  const f = fixture(t);
  await f.service.start(input());
  for (const change of [{ body: 'Different' }, { agentId: 'agent_123456789012345678901' }, { channels: { native: true, web: false } }]) {
    await assert.rejects(f.service.start({ ...input(), ...change }), e => e.status === 409);
  }
  assert.equal(f.counts.native, 2); assert.equal(f.counts.web, 1);
});

test('concurrent duplicate requests wait for the same preflight and claim', async t => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = fixture(t);
  const ordinaryRead = f.deps.readAudience;
  f.deps.readAudience = async (...args) => { await barrier; return ordinaryRead(...args); };
  const first = f.service.start(input());
  const second = f.service.start(input());
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results[1].deduplicated, true);
  assert.equal(f.counts.audience, 1); assert.equal(f.counts.native, 2); assert.equal(f.counts.web, 1);
});

test('private or unverifiable agent never creates history or starts a push', async t => {
  const f = fixture(t, { readAudience: async () => ({ ok: true, publicAgent: { id: AGENT, name: 'Angel', isPublic: false } }) });
  await assert.rejects(f.service.start(input()), e => e.status === 409);
  assert.equal(f.counts.publication, 0); assert.equal(f.counts.native, 0); assert.equal(f.counts.web, 0);
  assert.equal(fs.existsSync(f.deps.storePath), false);
});

test('quiet hours or a muted/capped gate causes no publication and no push', async t => {
  const f = fixture(t, { notificationGate: () => ({ allowed: false, reason: 'quiet hours (Central)' }) });
  await assert.rejects(f.service.start(input()), e => e.status === 409);
  assert.equal(f.counts.publication, 0); assert.equal(f.counts.native, 0); assert.equal(f.counts.web, 0);
});

test('accounts excluded by the fork never receive native pushes', async t => {
  const f = fixture(t);
  const original = f.deps.readAudience;
  f.deps.readAudience = async (...args) => ({ ...(await original(...args)), nativeEligibleIndexes: [0] });
  f.deps.sendNative = async () => { f.counts.native++; return { status: 200 }; };
  const result = await f.service.start(input());
  assert.equal(f.counts.native, 1); assert.equal(result.audience.native.excludedInactive, 1);
});

test('persistent publication failure never starts either external channel', async t => {
  const f = fixture(t, { publishHistory: () => { throw new Error('disk unavailable'); } });
  const result = await f.service.start(input());
  assert.equal(result.state, 'failed'); assert.equal(result.persistent, false);
  assert.equal(f.counts.native, 0); assert.equal(f.counts.web, 0);
  await f.service.start(input());
  assert.equal(f.counts.native, 0); assert.equal(f.counts.web, 0);
});

test('unknown web POST outcome is reconciled only with GET and is never retried', async t => {
  let attemptedPayload;
  const f = fixture(t, { sendWeb: async payload => { attemptedPayload = payload; throw new Error('https://private.example/?secret=never-log'); } });
  const first = await f.service.start(input());
  assert.equal(first.state, 'unknown'); assert.equal(first.web.state, 'unknown');
  assert.ok(!JSON.stringify(first).includes('never-log'));
  f.deps.readWeb = async () => ({ id: attemptedPayload.id, payloadHash: attemptedPayload.payloadHash, state: 'complete', configured: true,
    eligibleUsers: 1, subscriptions: 1, attempted: 1, accepted: 1, failed: 0, unknown: 0 });
  const beforeFile = fs.readFileSync(f.deps.storePath);
  assert.equal((await f.service.status(input().id)).state, 'complete');
  assert.deepEqual(fs.readFileSync(f.deps.storePath), beforeFile, 'GET never mutates the operation store');
  await f.service.start(input());
  assert.equal(f.counts.native, 2); assert.equal(f.counts.budget, 1);
});

test('native timeout remains unknown across restart without a second attempt', async t => {
  const f = fixture(t, { sendNative: () => new Promise(() => {}) });
  const first = await f.service.start(input());
  assert.equal(first.native.attempted, 2); assert.equal(first.native.unknown, 2); assert.equal(first.state, 'unknown');
  const restored = createAnnouncementService(f.deps);
  assert.equal((await restored.start(input())).deduplicated, true);
  assert.equal((await restored.status(input().id)).native.unknown, 2);
});

test('a late native provider acceptance changes counts without issuing another push', async t => {
  const resolvers = [];
  const f = fixture(t, { sendNative: () => new Promise(resolve => resolvers.push(resolve)) });
  const first = await f.service.start(input());
  assert.equal(first.native.unknown, 2);
  resolvers.forEach(resolve => resolve({ status: 200 }));
  await new Promise(resolve => setImmediate(resolve));
  const status = await f.service.status(input().id);
  assert.equal(status.native.unknown, 0); assert.equal(status.native.accepted, 2); assert.equal(status.state, 'complete');
  assert.equal(f.counts.budget, 1);
});

test('provider rejection is counted separately and dead tokens are pruned', async t => {
  const f = fixture(t, { sendNative: async () => ({ status: 410 }) });
  const result = await f.service.start(input());
  assert.equal(result.native.accepted, 0); assert.equal(result.native.failed, 2); assert.equal(result.native.unknown, 0);
  assert.equal(f.counts.pruned, 2); assert.equal(result.state, 'partial');
});

test('no eligible devices and unconfigured web still leave one durable announcement for all accounts', async t => {
  const f = fixture(t, {
    nativeRegistry: () => ({ registered: 0, rows: [], iosConfigured: true, androidConfigured: false }),
    readAudience: async () => ({ ok: true, publicAgent: { id: AGENT, name: 'Angel', isPublic: true }, accounts: { total: 3, eligible: 3, excludedTest: 0 },
      nativeEligibleIndexes: [], web: { configured: false, users: 0, subscriptions: 0 } }),
    sendWeb: async payload => ({ id: payload.id, payloadHash: payload.payloadHash, state: 'skipped', reason: 'unconfigured', configured: false,
      eligibleUsers: 0, subscriptions: 0, attempted: 0, accepted: 0, failed: 0, unknown: 0 }),
  });
  const result = await f.service.start(input());
  assert.equal(result.persistent, true); assert.equal(result.native.attempted, 0); assert.equal(result.web.attempted, 0);
  assert.equal(result.web.reason, 'unconfigured'); assert.equal(f.counts.budget, 0); assert.equal(f.counts.publication, 1);
});

test('invalid targets, external URL injection, oversized payload and unauthorized route do not reach delivery', async t => {
  for (const change of [{ agentId: ['bad'] }, { agentId: '../admin' }, { url: 'https://evil.example' }, { body: '\u0000'.repeat(1000) }, { urgent: true }]) {
    assert.throws(() => validatePayload({ ...input(), ...change }), e => e.status === 400);
  }
  const f = fixture(t);
  const routes = new Map();
  const app = { get: (route, handler) => routes.set('GET ' + route, handler), post: (route, handler) => routes.set('POST ' + route, handler) };
  attachAnnouncements(app, f.deps);
  let status, result;
  const res = { status: value => { status = value; return res; }, json: value => { result = value; } };
  await routes.get('POST /announcements')({ get: () => 'test-agent-only', body: input() }, res);
  assert.equal(status, 403); assert.deepEqual(result, { error: 'Unauthorized' });
  assert.equal(f.counts.audience, 0); assert.equal(f.counts.native, 0); assert.equal(f.counts.web, 0);
});

test('a corrupt new store fails closed without overwriting it or disabling legacy route attachment', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.deps.storePath, '{broken');
  const routes = new Map();
  const app = { get: (route, handler) => routes.set('GET ' + route, handler), post: (route, handler) => routes.set('POST ' + route, handler) };
  assert.doesNotThrow(() => attachAnnouncements(app, f.deps));
  let status;
  const res = { status: value => { status = value; return res; }, json: () => {} };
  await routes.get('POST /announcements')({ get: () => 'test-admin', body: input() }, res);
  assert.equal(status, 503); assert.equal(fs.readFileSync(f.deps.storePath, 'utf8'), '{broken');
  assert.equal(f.counts.native, 0); assert.equal(f.counts.web, 0);
});

test('a missing persistent mount disables the new door without attempting delivery', async t => {
  const f = fixture(t);
  f.deps.persistentStorage = false;
  const routes = new Map();
  const app = { get: (route, handler) => routes.set('GET ' + route, handler), post: (route, handler) => routes.set('POST ' + route, handler) };
  assert.doesNotThrow(() => attachAnnouncements(app, f.deps));
  let status;
  const res = { status: value => { status = value; return res; }, json: () => {} };
  await routes.get('POST /announcements')({ get: () => 'test-admin', body: input() }, res);
  assert.equal(status, 503); assert.equal(f.counts.native, 0); assert.equal(f.counts.web, 0);
});
