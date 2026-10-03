'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const alarm = require('./memory-alarm');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-10-03T05:00:00Z');
const at = (hoursAgo, now = NOW) => new Date(now - hoursAgo * HOUR).toISOString();
function origin(createdHoursAgo = null, amendedHoursAgo = null, now = NOW) {
  const created = createdHoursAgo === null ? null : at(createdHoursAgo, now);
  const amended = amendedHoursAgo === null ? null : at(amendedHoursAgo, now);
  const times = [created, amended].filter(Boolean).map(Date.parse);
  return {
    entries: times.length ? 1 : 0,
    createdEntries24h: createdHoursAgo !== null && createdHoursAgo <= 24 ? 1 : 0,
    amendedEntries24h: amendedHoursAgo !== null && amendedHoursAgo <= 24 ? 1 : 0,
    lastCreatedAt: created, lastAmendedAt: amended,
    lastWriteAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}
function health(live = origin(100, 1), now = NOW) {
  return {
    ok: true,
    cards: { active: 1, wrote24h: 0 },
    summaries: { newestRefreshAgeHours: 1 },
    consolidation: { ageHours: 1 },
    diary: {
      entries: 1, wrote24h: 0, keeperNewestAgeHours: 100,
      keeperMetricScope: alarm.KEEPER_SCOPE,
      activity: {
        schemaVersion: 1, evidence: 'persisted-successful-writes', generatedAt: at(0, now),
        byOrigin: { live_chat: live, temporary_unknown: origin(), canary: origin(), brief: origin(), consolidation: origin(), manual: origin(), backfill: origin(), unknown: origin() },
        legacy: { entries: 0 }, sourceHistory: {},
      },
    },
  };
}
const check = (data, opts = {}) => alarm.keeperMonitor(data, { now: NOW, ...opts });

test('a persisted amendment resets silence even when entry creation is old', () => {
  const state = check(health());
  assert.equal(state.coverage, 'known');
  assert.equal(state.state, 'recent');
  assert.equal(state.ageHours, 1);
  assert.equal(state.lastWriteAt, at(1));
  assert.match(alarm.keeperSpeech(state), /create or amendment 1 hours ago/);
});

test('the max of create and amendment is used in either order', () => {
  assert.equal(check(health(origin(1, 100))).ageHours, 1);
  assert.equal(check(health(origin(null, 2))).ageHours, 2);
  assert.equal(check(health(origin(3, null))).ageHours, 3);
  assert.equal(check(health(origin(30))).state, 'stale');
  assert.equal(check(health(origin(29.999))).state, 'recent');
});

test('synthetic, manual, backfill and unclassified writes cannot reset a stale live baseline', () => {
  const data = health(origin(100, 40));
  for (const name of Object.keys(data.diary.activity.byOrigin)) {
    if (name !== 'live_chat') data.diary.activity.byOrigin[name] = origin(0, 0);
  }
  data.diary.keeperNewestAgeHours = 0;
  data.diary.activity.legacy = { entries: 9, newestCreatedAt: at(0) };
  const state = check(data);
  assert.equal(state.state, 'stale');
  assert.equal(state.ageHours, 40);
});

test('unverified temporary and legacy activity never become a live baseline or recovery', () => {
  const data = health(origin());
  data.diary.activity.byOrigin.temporary_unknown = origin(0, 0);
  data.diary.activity.legacy = { entries: 10, newestCreatedAt: at(0) };
  const state = check(data);
  assert.equal(state.state, 'unknown');
  assert.equal(state.coverage, 'unknown');
  assert.equal(state.reason, 'no_live_baseline');
  assert.match(alarm.keeperSpeech(state), /coverage unknown/);
  assert.doesNotMatch(alarm.keeperSpeech(state), /recovered|healthy/);
});

test('old createdAt-only data and missing/failed diagnostics remain unknown', () => {
  for (const data of [null, { ok: false }, { ok: true, diary: { keeperNewestAgeHours: 100 } }, { ok: true, diary: { activity: null } }]) {
    assert.equal(check(data).state, 'unknown');
  }
  const data = health();
  data.diary.activity.schemaVersion = 2;
  assert.equal(check(data).reason, 'unsupported_activity');
  data.diary.activity.schemaVersion = 1;
  data.diary.activity.evidence = 'attempts';
  assert.equal(check(data).state, 'unknown');
  data.diary.activity.evidence = 'persisted-successful-writes';
  delete data.diary.keeperMetricScope;
  assert.equal(check(data).state, 'unknown');
});

test('stale observations never page or falsely establish recovery', () => {
  for (const live of [origin(100), origin(1)]) {
    const data = health(live);
    data.diary.activity.generatedAt = new Date(NOW - alarm.MAX_OBSERVATION_AGE_MS - 1).toISOString();
    const state = check(data);
    assert.equal(state.reason, 'stale_observation');
    assert.equal(state.state, 'unknown');
    assert.match(alarm.keeperSpeech(state), /coverage unknown/);
  }
});

test('future, malformed, inconsistent and impossible timestamps are unknown', () => {
  const edits = [
    (d) => { d.diary.activity.generatedAt = at(-1); },
    (d) => { d.diary.activity.generatedAt = '2026-02-30T00:00:00Z'; },
    (d) => { d.diary.activity.generatedAt = '2026'; },
    (d) => { d.diary.activity.generatedAt = Infinity; },
    (d) => { d.diary.activity.byOrigin.live_chat = origin(-1); },
    (d) => { d.diary.activity.byOrigin.live_chat.lastAmendedAt = at(-1); },
    (d) => { d.diary.activity.byOrigin.live_chat.lastWriteAt = at(-1); },
    (d) => { d.diary.activity.byOrigin.live_chat.lastCreatedAt = 'bad-date'; },
    (d) => { d.diary.activity.byOrigin.live_chat.lastCreatedAt = '2026-02-30T00:00:00Z'; },
    (d) => { d.diary.activity.byOrigin.live_chat.lastWriteAt = at(100); },
    (d) => { delete d.diary.activity.byOrigin.live_chat.lastAmendedAt; },
    (d) => { d.diary.activity.byOrigin.live_chat.entries = 0; },
    (d) => { d.diary.activity.byOrigin.live_chat.entries = Infinity; },
  ];
  for (const edit of edits) {
    const data = health();
    edit(data);
    assert.equal(check(data).state, 'unknown');
  }
  const data = health(origin(0));
  data.diary.activity.generatedAt = at(0.01);
  assert.equal(check(data).reason, 'invalid_live_activity', 'write after snapshot is invalid');
  assert.equal(check(health(), { now: NaN }).state, 'unknown');
});

test('invalid threshold configuration uses the existing 30-hour default', () => {
  for (const deadHours of [NaN, Infinity, -1, 0]) {
    assert.equal(check(health(origin(31)), { deadHours }).state, 'stale');
    assert.equal(check(health(origin(29)), { deadHours }).state, 'recent');
  }
});

test('audience projection hides private diagnostics without mutating the shared cache', () => {
  const data = health();
  data.keeperMonitor = { coverage: 'known' };
  data.diary.keeperMonitor = { coverage: 'known' };
  const before = JSON.stringify(data);
  const scoped = alarm.healthForAudience(data, false);
  assert.equal(scoped.diary.activity, undefined);
  assert.equal(scoped.keeperMonitor, undefined);
  assert.equal(scoped.diary.keeperMonitor, undefined);
  const admin = alarm.healthForAudience(data, true);
  assert.ok(admin.diary.activity);
  assert.equal(admin.keeperMonitor, undefined, 'monitor is recomputed, never taken from payload');
  admin.diary.activity.byOrigin.live_chat.lastWriteAt = null;
  scoped.cards.active = 200;
  assert.equal(JSON.stringify(data), before);
});

// Execute the shipped wrappers/route with inert dependencies. This never starts
// the bridge, calls a provider, sends a push or writes an on-disk state file.
const SOURCE = fs.readFileSync(require.resolve('./server.js'), 'utf8');
function sourceBetween(start, end) {
  const a = SOURCE.indexOf(start);
  const b = SOURCE.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'server source anchors exist');
  return SOURCE.slice(a, b);
}
function serverHarness(initial = health(), env = {}) {
  let data = initial;
  let clock = NOW;
  let requests = 0;
  let route;
  const sent = [];
  const intervals = [], timeouts = [];
  const context = {
    process: { env }, BRIDGE_SECRET: 'offline-admin', NOTIFY_AGENT_SECRET: 'offline-scoped',
    CANARY_ADMIN_USER: Symbol('offline recipient'),
    Date: class extends Date { static now() { return clock; } },
    memoryAlarm: { ...alarm, keeperMonitor: (d, options) => alarm.keeperMonitor(d, { ...options, now: clock }) },
    console: { warn() {} },
    fetchMemoryHealth: async () => { requests++; return { data, err: null }; },
    runNotify: async (notification) => { sent.push(notification); },
    setInterval: (fn, delay) => intervals.push(delay), setTimeout: (fn, delay) => timeouts.push(delay),
    app: { get: (path, handler) => { assert.equal(path, '/platform-status'); route = handler; } },
    checkPlatformServices: async () => [], computeSpend: () => ({ lines: [] }),
    canaryState: { results: [], consecutiveFails: 0 }, CANARY_ENABLED: false,
    DEPLOY_READER: {}, backupStatusForSpeech: () => ({ section: {} }),
    balanceStatusForSpeech: () => ({ section: {} }), crashStatusForSpeech: () => ({ section: {}, okToday: true }),
    voiceReportForSpeech: async () => ({ section: {} }), slopStatsForSpeech: async () => ({ section: {} }),
    BATTERY: null, JEV: null,
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween('const MEMORY_KEEPER_DEAD_H =', '/* ── VOICE REPORT') + '\nthis.tick = memoryKeeperAlarmTick; this.speech = memoryHealthForSpeech;', context);
  vm.runInContext(sourceBetween("app.get('/platform-status',", '// Deep research engine'), context);
  return {
    sent, intervals, timeouts, context,
    tick: () => context.tick(), speech: (opts) => context.speech(opts),
    setData: (next) => { data = next; }, setNow: (next) => { clock = next; },
    requests: () => requests,
    status: async (provided, header = 'x-kade-secret') => {
      const reply = { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
      await route({ get: (name) => name === header ? provided : undefined, query: {} }, reply);
      return reply;
    },
  };
}

test('server alarm observes amendments and preserves its 6-hour cadence, 5-minute boot and 24-hour cooldown', async () => {
  const bridge = serverHarness();
  assert.deepEqual(bridge.intervals, [6 * HOUR]);
  assert.deepEqual(bridge.timeouts, [5 * 60 * 1000]);
  await bridge.tick();
  assert.equal(bridge.sent.length, 0, 'recent amendment prevents false alarm');
  bridge.setData(health(origin(100, 40)));
  await bridge.tick();
  assert.equal(bridge.sent.length, 1);
  assert.match(bridge.sent[0].body, /create or amendment/);
  assert.equal(bridge.sent[0].adminAlert, true);
  const priorRequests = bridge.requests();
  bridge.setNow(NOW + 23 * HOUR);
  await bridge.tick();
  assert.equal(bridge.requests(), priorRequests, 'cooldown skips fetch');
  bridge.setNow(NOW + 24 * HOUR);
  bridge.setData(health(origin(100, 40, NOW + 24 * HOUR), NOW + 24 * HOUR));
  await bridge.tick();
  assert.equal(bridge.sent.length, 2);
});

test('server alarm never pages missing, legacy, unknown, stale or future evidence', async () => {
  const cases = [null, { ok: false }, { ok: true, diary: { keeperNewestAgeHours: 100 } }, health(origin())];
  const stale = health(origin(100)); stale.diary.activity.generatedAt = at(1); cases.push(stale);
  const future = health(origin(-1)); cases.push(future);
  for (const data of cases) {
    const bridge = serverHarness(data);
    await bridge.tick();
    assert.equal(bridge.sent.length, 0);
    // Unknown did not consume the cooldown or invent a successful write.
    bridge.setData(health(origin(100)));
    await bridge.tick();
    assert.equal(bridge.sent.length, 1);
  }
});

test('server alarm keeps the existing secret gate and kill switch', async () => {
  const noSecret = serverHarness(health(origin(100)));
  noSecret.context.BRIDGE_SECRET = '';
  await noSecret.tick();
  assert.equal(noSecret.requests(), 0);
  const disabled = serverHarness(health(origin(100)), { MEMORY_KEEPER_ALARM: '0' });
  await disabled.tick();
  assert.equal(disabled.requests(), 0);
});

test('owner status and speech explicitly expose unknown coverage for unavailable, legacy and unverified activity', async () => {
  for (const data of [null, health(origin()), { ...health(), diary: { entries: 1, keeperNewestAgeHours: 100 } }]) {
    const bridge = serverHarness(data);
    const reply = await bridge.status('offline-admin');
    assert.equal(reply.code, 200);
    assert.equal(reply.body.memory.keeperMonitor.coverage, 'unknown');
    assert.match(reply.body.spokenSummary, /Memory keeper coverage unknown/);
    assert.doesNotMatch(reply.body.spokenSummary, /recovered/);
    assert.equal(reply.body.ok, true, 'unknown keeper coverage is not an invented outage');
  }
  const disabled = serverHarness(health(), { MEMORY_HEALTH_STATUS: '0' });
  const reply = await disabled.status('offline-admin');
  assert.equal(reply.body.memory.enabled, false);
  assert.match(reply.body.spokenSummary, /coverage unknown.*disabled/);
});

test('actual platform route restricts exact diagnostic and keeper speech to admin; scoped fetch cannot alter admin/alarm cache', async () => {
  const data = health();
  const before = JSON.stringify(data);
  const bridge = serverHarness(data);
  assert.equal((await bridge.status('invalid')).code, 403);
  assert.equal(bridge.requests(), 0);
  const scoped = await bridge.status('offline-scoped', 'x-notify-secret');
  assert.equal(scoped.code, 200);
  assert.equal(scoped.body.memory.diary.activity, undefined);
  assert.equal(scoped.body.memory.keeperMonitor, undefined);
  assert.doesNotMatch(scoped.body.spokenSummary, /Live memory keeper|Memory keeper coverage/);
  scoped.body.memory.cards.active = 500;
  const admin = await bridge.status('offline-admin');
  assert.equal(admin.code, 200);
  assert.equal(admin.body.memory.keeperMonitor.state, 'recent');
  assert.equal(admin.body.memory.diary.activity.byOrigin.live_chat.lastAmendedAt, at(1));
  assert.match(admin.body.spokenSummary, /last confirmed non-temporary chat create or amendment/);
  admin.body.memory.diary.activity.byOrigin.live_chat.lastWriteAt = null;
  assert.equal(JSON.stringify(data), before);
  await bridge.tick();
  assert.equal(bridge.sent.length, 0);
});
