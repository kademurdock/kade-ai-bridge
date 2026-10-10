'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const testSeatPolicy = require('./test-seat-policy');

function integration(overrides = {}) {
  const source = fs.readFileSync(require.resolve('./server'), 'utf8');
  const start = source.indexOf("require('./announcements').attachAnnouncements");
  const end = source.indexOf('// View / change notification preferences', start);
  const files = [];
  let deps;
  const context = {
    require: name => { assert.equal(name, './announcements'); return {
      attachAnnouncements: (_app, value) => { deps = value; },
      atomicSave: (filename, rows) => files.push({ filename, rows }),
    }; },
    app: {}, path, os: { tmpdir: () => '/test-volume' },
    fs: { existsSync: () => true, statSync: () => ({ isDirectory: () => true }) },
    process: { env: { APNS_KEY: 'test-only', APNS_KEY_ID: 'test-only', APNS_TEAM_ID: 'test-only' } },
    bridgeSecretOk: () => false, testSeatPolicy,
    pushTokens: new Map(), fcm: { fcmConfigured: () => true, looksLikeFcmToken: () => false },
    axios: {}, LIBRECHAT_URL: 'https://kademurdock.com', BRIDGE_SECRET: 'test-only', BROWSER_UA: 'test-browser',
    notifyPrefs: { enabled: true, mutedAgents: [], cooldownMin: 30, globalDailyCap: 12, perAgentDailyCap: 4 },
    notifyCounts: { day: '2026-10-09', global: 0, perAgent: {}, lastSentMs: 0 },
    centralClock: () => ({ day: '2026-10-09', hhmm: '12:00' }), notifyInQuietHours: () => false,
    sendPush: async () => ({ status: 200 }), savePushTokens: () => {},
    broadcastLog: [{ id: 'bc-old-1', title: 'Existing', body: 'Preserve this', sent: 2 }], BROADCASTS_FILE: '/test-volume/broadcasts.json',
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { deps, context, files };
}

test('new native audience excludes review, unlinked, and unconfigured devices without changing legacy registrations', () => {
  const user = '6a3cba4d0b0afa92194e42f7';
  const tokens = new Map([
    ['review', { userId: '6a6125d73939d20b95251078', platform: 'ios' }],
    ['unlinked', { userId: null, platform: 'ios' }],
    ['ios', { userId: user, platform: 'ios' }],
    ['android', { userId: user, platform: 'android' }],
  ]);
  const f = integration({ pushTokens: tokens, fcm: { fcmConfigured: () => false, looksLikeFcmToken: () => false } });
  const result = f.deps.nativeRegistry();
  assert.equal(result.registered, 4); assert.equal(result.excludedTest, 1); assert.equal(result.excludedUnlinked, 1);
  assert.equal(result.excludedUnconfigured, 1); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].token, 'ios');
  assert.equal(tokens.size, 4, 'audience read never unregisters or mutates legacy devices');
});

test('all fork operation calls use the existing secret header and fixed owned endpoints', async () => {
  const calls = [];
  const f = integration({ axios: {
    post: async (...args) => { calls.push(args); return { data: { ok: true } }; },
    get: async (...args) => { calls.push(args); return { data: { ok: true } }; },
  } });
  await f.deps.readAudience('agent_123456789012345678901', ['test-user-id']);
  await f.deps.sendWeb({ id: 'test-announcement' });
  await f.deps.readWeb('test-announcement');
  assert.equal(calls[0][0], 'https://kademurdock.com/api/kade/admin/announcement-audience');
  assert.equal(calls[1][0], 'https://kademurdock.com/api/kade/admin/announcement-web-push');
  assert.equal(calls[2][0], 'https://kademurdock.com/api/kade/admin/announcement-web-push/test-announcement');
  for (const call of calls) {
    const options = call[call.length - 1];
    assert.equal(options.headers['x-bridge-secret'], 'test-only');
    assert.ok(!call[0].includes('secret='));
  }
});

test('new history publication and delivery update preserve all pre-existing broadcast rows', () => {
  const f = integration();
  const existing = JSON.stringify(f.context.broadcastLog[0]);
  f.deps.publishHistory({ id: 'angel-intro-one', title: 'Angel', body: 'Hello', kadeRoute: 'agent-chat' });
  f.deps.updateHistory('angel-intro-one', { sent: 3 });
  assert.equal(f.context.broadcastLog.length, 2);
  assert.equal(JSON.stringify(f.context.broadcastLog[0]), existing);
  assert.equal(f.context.broadcastLog[1].sent, 3); assert.equal(f.context.broadcastLog[1].kadeRoute, 'agent-chat');
  assert.throws(() => f.deps.publishHistory({ id: 'angel-intro-one' }));
});

test('new operation respects quiet hours and the existing global/caller budget without changing preferences', () => {
  const f = integration({ notifyInQuietHours: () => true });
  assert.equal(f.deps.notificationGate('angel').allowed, false);
  assert.equal(f.deps.notificationGate('angel').reason, 'quiet hours (Central)');
  const g = integration();
  assert.equal(g.deps.notificationGate('angel').allowed, true);
  g.deps.chargeBudget('angel');
  assert.equal(g.context.notifyCounts.global, 1); assert.equal(g.context.notifyCounts.perAgent.angel, 1);
  assert.equal(g.deps.notificationGate('angel').reason, 'cooldown active');
  assert.equal(g.context.notifyPrefs.enabled, true); assert.equal(g.context.notifyPrefs.cooldownMin, 30);
});
