'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { pendingRing, canAnswerRing, DesktopPresence } = require('./desktop-calls');

const now = Date.now();
const lease = '11111111-1111-4111-8111-111111111111';
const otherLease = '22222222-2222-4222-8222-222222222222';
const plan = () => ({ id: 'one', userId: 'owner', agentId: 'kiana', agentName: 'Kiana', purpose: 'Check in', enabled: true, pendingAnswer: { firedAt: new Date(now - 1000).toISOString() }, privateField: 'never return' });

test('pending rings expose only current owned enabled attempts and whitelisted fields', () => {
  const row = plan();
  const ring = pendingRing(row, 'owner', now);
  assert.deepEqual(Object.keys(ring).sort(), ['agentId', 'agentName', 'expiresAt', 'firedAt', 'planId', 'purpose', 'ringId']);
  assert.equal(pendingRing(row, 'other', now), null);
  assert.equal(pendingRing({ ...row, enabled: false }, 'owner', now), null);
  assert.equal(pendingRing({ ...row, pendingAnswer: null }, 'owner', now), null);
  assert.equal(pendingRing({ ...row, pendingAnswer: { firedAt: 'invalid' } }, 'owner', now), null);
  assert.equal(pendingRing({ ...row, pendingAnswer: { firedAt: new Date(now + 1).toISOString() } }, 'owner', now), null);
  assert.equal(pendingRing({ ...row, pendingAnswer: { firedAt: new Date(now - 180000).toISOString() } }, 'owner', now), null);
});

test('ring proof binds owner, character, firing identity and expiry, and cannot replay after answer', () => {
  const row = plan();
  const ring = pendingRing(row, 'owner', now);
  assert.equal(canAnswerRing(row, 'owner', 'kiana', ring.ringId, now), true);
  for (const args of [['other', 'kiana', ring.ringId], ['owner', 'della', ring.ringId], ['owner', 'kiana', 'old-ring']]) {
    assert.equal(canAnswerRing(row, ...args, now), false);
  }
  row.pendingAnswer = null;
  assert.equal(canAnswerRing(row, 'owner', 'kiana', ring.ringId, now), false);
});

test('desktop leases are account and instance owned, expire, and renew without accumulating', () => {
  const presence = new DesktopPresence();
  presence.set('owner', lease, true, now);
  assert.equal(presence.has('owner', now + 89999), true);
  assert.equal(presence.has('other', now), false);
  presence.set('owner', otherLease, true, now + 1000);
  presence.set('owner', lease, false, now + 2000);
  assert.equal(presence.has('owner', now + 2000), true);
  presence.set('other', otherLease, false, now + 2000);
  assert.equal(presence.has('owner', now + 2000), true);
  presence.set('owner', otherLease, true, now + 3000);
  assert.equal(presence.leases.size, 1);
  assert.equal(presence.has('owner', now + 93000), false);
  assert.equal(presence.leases.size, 0);
});

test('invalid presence requests cannot register a target', () => {
  const presence = new DesktopPresence();
  for (const args of [['', lease, true], ['owner', 'bad', true], ['owner', lease, 'yes']]) {
    assert.throws(() => presence.set(...args, now), TypeError);
  }
  assert.equal(presence.leases.size, 0);
});

test('one account cannot consume global lease capacity and existing instances can renew at the cap', () => {
  const presence = new DesktopPresence();
  const id = i => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`;
  for (let i = 0; i < 16; i++) presence.set('owner', id(i), true, now);
  assert.throws(() => presence.set('owner', id(16), true, now), /Too many/);
  presence.set('owner', id(0), true, now + 1000);
  presence.set('other', id(16), true, now + 1000);
  assert.equal(presence.leases.size, 17);
  presence.set('owner', id(17), true, now + 90000);
  assert.equal(presence.leases.size, 3);
});

test('actual firing function supports desktop-only presence and retains daily cap', async () => {
  const source = fs.readFileSync(require.resolve('./server'), 'utf8');
  const start = source.indexOf('async function fireCallPlan(');
  const end = source.indexOf('// The web-voice hello calls', start);
  let enabled = true;
  const context = {
    callsEnabled: () => true, centralClock: () => ({ day: 'today', hhmm: '12:00' }),
    callCounts: { day: 'today', perUser: {} }, notifyInQuietHours: () => false,
    callPrefs: { perUserDailyCap: 1 }, tokensForUser: () => [],
    desktopPresence: { has: () => enabled }, ringtoneFileFor: () => 'tone.caf',
    sendPush: () => { throw Error('No mobile target may be invented'); },
    pushTokens: new Map(), savePushTokens() {}, saveCallPlans() {}, console: { log() {}, warn() {} },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const row = { ...plan(), pendingAnswer: null };
  assert.equal((await context.fireCallPlan(row)).desktopAvailable, true);
  assert.ok(row.pendingAnswer.firedAt);
  assert.equal(context.callCounts.perUser.owner, 1);
  assert.match((await context.fireCallPlan(plan())).blocked, /cap/);
  enabled = false;
  const without = { ...plan(), userId: 'new', pendingAnswer: null };
  assert.equal((await context.fireCallPlan(without)).sent, 0);
  assert.equal(without.pendingAnswer, null);
});

test('actual hello rejects a stale ring before constructing voice session and keeps legacy hello', () => {
  const source = fs.readFileSync(require.resolve('./voice-stream'), 'utf8');
  const start = source.indexOf("if (Object.prototype.hasOwnProperty.call(msg, 'callRingId')");
  const end = source.indexOf('const user = {', start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  const context = { msg: { callPlanId: 'one', callRingId: 'stale' }, t: { uid: 'owner', agentId: 'kiana' }, cfg: { canAnswerCallRing: () => false }, ws: { send: value => calls.push(JSON.parse(value)), close: code => calls.push(code) } };
  vm.createContext(context);
  const check = vm.runInContext(`(function() { ${source.slice(start, end)} return 'session permitted'; })`, context);
  assert.equal(check(), undefined);
  assert.equal(calls[0].type, 'error');
  assert.equal(calls[1], 4409);
  delete context.msg.callRingId;
  assert.equal(check(), 'session permitted');
  context.msg.callRingId = 'fresh'; context.cfg.canAnswerCallRing = () => true;
  assert.equal(check(), 'session permitted');
  context.msg.spotterDirect = true;
  assert.equal(check(), undefined);
});

test('actual pending and presence routes require headers and enforce owner projection and kill switch', () => {
  const source = fs.readFileSync(require.resolve('./server'), 'utf8');
  const start = source.indexOf("app.get('/call-plans/pending'");
  const end = source.indexOf("app.get('/call-plans',", start);
  const handlers = {};
  let enabled = true;
  const context = { app: { get: (path, fn) => handlers[path] = fn, post: (path, fn) => handlers[path] = fn },
    notifySecretOk: req => req.header === 'secret', bridgeSecretOk: () => false,
    callPlans: new Map([['one', plan()]]), callsEnabled: () => enabled, pendingRing,
    desktopPresence: new DesktopPresence() };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  const response = () => ({ code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } });
  let res = response(); handlers['/call-plans/pending']({ query: { userId: 'owner' } }, res); assert.equal(res.code, 403);
  res = response(); handlers['/call-plans/pending']({ header: 'secret', query: {} }, res); assert.equal(res.code, 400);
  res = response(); handlers['/call-plans/pending']({ header: 'secret', query: { userId: 'other' } }, res); assert.equal(res.value.rings.length, 0);
  res = response(); handlers['/call-plans/pending']({ header: 'secret', query: { userId: 'owner' } }, res); assert.equal(res.value.rings.length, 1); assert.equal(res.headers['Cache-Control'], 'no-store');
  enabled = false;
  res = response(); handlers['/call-plans/pending']({ header: 'secret', query: { userId: 'owner' } }, res); assert.equal(res.value.rings.length, 0);
  res = response(); handlers['/call-presence']({ header: 'secret', body: { userId: 'owner', leaseId: lease, enabled: true } }, res); assert.equal(res.value.ok, true);
});
