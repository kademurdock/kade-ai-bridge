'use strict';
/* push-auth.test.js -- Nov 12 2026 (platform audit IOS-19). A device links only to the user its
 * access token proves. Ships in log mode; enforce comes by PUSH_REGISTER_AUTH or by date. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const pushAuth = require('./push-auth');
const { pushAuthMode, verifyUserJwt, decidePushLink } = pushAuth;

const SECRET = 'test-secret';
const X = 'a'.repeat(24), Y = 'b'.repeat(24);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mint(payload, { secret = SECRET, alg = 'HS256' } = {}) {
  const head = `${b64({ alg, typ: 'JWT' })}.${b64(payload)}`;
  return `${head}.${crypto.createHmac('sha256', secret).update(head).digest('base64url')}`;
}
const NOW = 1_800_000_000_000;
const good = (id) => `Bearer ${mint({ id, exp: NOW / 1000 + 900 })}`;

test('mode defaults to log and takes only known words', () => {
  assert.equal(pushAuthMode({}), 'log');
  assert.equal(pushAuthMode({ PUSH_REGISTER_AUTH: 'ENFORCE' }), 'enforce');
  assert.equal(pushAuthMode({ PUSH_REGISTER_AUTH: 'nope' }), 'log');
});

test('the enforce date flips log to enforce once it has passed; a set mode always wins', () => {
  const env = { PUSH_REGISTER_ENFORCE_FROM: '2027-01-15T06:00:00Z' };
  const at = Date.parse('2027-01-15T06:00:00Z');
  assert.equal(pushAuthMode(env, at - 1), 'log');
  assert.equal(pushAuthMode(env, at), 'enforce');
  assert.equal(pushAuthMode({ ...env, PUSH_REGISTER_AUTH: 'log' }, at + 1), 'log');
  assert.equal(pushAuthMode({ ...env, PUSH_REGISTER_AUTH: 'off' }, at + 1), 'off');
  assert.equal(pushAuthMode({ PUSH_REGISTER_ENFORCE_FROM: 'someday' }, at + 1), 'log', 'an unreadable date never enforces');
  assert.equal(pushAuthMode({ PUSH_REGISTER_ENFORCE_FROM: '2027-01-15' }, Date.parse('2027-01-15T00:00:00Z')), 'enforce');
});

test('a fork token verifies and names its user', () => {
  assert.deepEqual(verifyUserJwt(good(Y), { secret: SECRET, now: NOW }), { ok: true, userId: Y });
});

test('forged, expired, unsigned and wrong-secret tokens are refused', () => {
  const r = (b) => verifyUserJwt(b, { secret: SECRET, now: NOW }).reason;
  assert.equal(r(''), 'missing');
  assert.equal(r('Bearer abc'), 'malformed');
  assert.equal(r(`Bearer ${mint({ id: Y, exp: NOW / 1000 - 1 })}`), 'expired');
  assert.equal(r(`Bearer ${mint({ id: Y })}`), 'expired');
  assert.equal(r(`Bearer ${mint({ id: Y, exp: NOW / 1000 + 9 }, { secret: 'other' })}`), 'bad-signature');
  assert.equal(r(`Bearer ${mint({ id: Y, exp: NOW / 1000 + 9 }, { alg: 'none' })}`), 'bad-alg');
  assert.equal(r(`Bearer ${mint({ id: 'not-an-id', exp: NOW / 1000 + 9 })}`), 'no-user');
  assert.equal(verifyUserJwt(good(Y), { secret: '', now: NOW }).reason, 'no-secret');
});

test('enforce: userId X with no bearer is refused', () => {
  const d = decidePushLink({ bearer: '', bodyUserId: X, mode: 'enforce', secret: SECRET, now: NOW });
  assert.equal(d.refuse, true);
  assert.equal(d.userId, '');
});

test('a bearer for Y with userId X links to Y, in log and in enforce', () => {
  for (const mode of ['log', 'enforce']) {
    const d = decidePushLink({ bearer: good(Y), bodyUserId: X, mode, secret: SECRET, now: NOW });
    assert.equal(d.refuse, false);
    assert.equal(d.userId, Y);
    assert.equal(d.mismatch, true);
  }
});

test('log: an unproven claim still links, and says it would be refused', () => {
  const d = decidePushLink({ bearer: '', bodyUserId: X, mode: 'log', secret: SECRET, now: NOW });
  assert.deepEqual([d.userId, d.refuse, d.how, d.reason], [X, false, 'would-refuse', 'missing']);
});

test('no userId and no bearer is never refused (sign-out, legacy token-only callers)', () => {
  const d = decidePushLink({ bearer: '', bodyUserId: '', mode: 'enforce', secret: SECRET, now: NOW });
  assert.deepEqual([d.userId, d.refuse], ['', false]);
});

test('with no secret set nothing is refused, even in enforce', () => {
  const d = decidePushLink({ bearer: good(Y), bodyUserId: X, mode: 'enforce', secret: '', now: NOW });
  assert.deepEqual([d.userId, d.refuse, d.how], [X, false, 'unverified']);
});

test('off: the body is taken as before', () => {
  const d = decidePushLink({ bearer: '', bodyUserId: X, mode: 'off', secret: SECRET, now: NOW });
  assert.deepEqual([d.userId, d.refuse], [X, false]);
});

/* The real /push-register handler from server.js, run in a sandbox (same style as
 * test-seat-policy.test.js). */
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const mintNow = (id) => {
  const h = `${b64({ alg: 'HS256' })}.${b64({ id, exp: Date.now() / 1000 + 900 })}`;
  return `${h}.${crypto.createHmac('sha256', 's3').update(h).digest('base64url')}`;
};
function rig(env) {
  const saved = { a: process.env.PUSH_REGISTER_AUTH, f: process.env.PUSH_REGISTER_ENFORCE_FROM };
  delete process.env.PUSH_REGISTER_AUTH; delete process.env.PUSH_REGISTER_ENFORCE_FROM;
  Object.assign(process.env, env);
  const handlers = new Map();
  const token = 'a'.repeat(64);
  const warnings = [];
  const ctx = { app: { post: (r, f) => handlers.set(r, f) }, pushTokens: new Map(), fcm: { looksLikeFcmToken: () => false },
    savePushTokens() {}, CALL_RINGTONES: {}, console: { log() {}, warn(m) { warnings.push(m); } }, pushAuth, PUSH_JWT_SECRET: 's3',
    pushAuthTally: pushAuth.createPushAuthTally() }; // Nov 13 2026 (sweep 8.7): every registration is counted
  vm.createContext(ctx);
  const start = src.indexOf("app.post('/push-register'");
  vm.runInContext(src.slice(start, src.indexOf('// Admin: send a push', start)), ctx);
  let out, code = 200;
  const res = { set() {}, json(v) { out = v; return this; }, status(c) { code = c; return this; } };
  return {
    ctx, token, warnings,
    call: (body, headers) => { code = 200; handlers.get('/push-register')({ body, headers }, res); return { code, out }; },
    done: () => {
      if (saved.a === undefined) delete process.env.PUSH_REGISTER_AUTH; else process.env.PUSH_REGISTER_AUTH = saved.a;
      if (saved.f === undefined) delete process.env.PUSH_REGISTER_ENFORCE_FROM; else process.env.PUSH_REGISTER_ENFORCE_FROM = saved.f;
    },
  };
}

test('handler, enforce: no bearer is refused; a bearer links to its own user; token-only and sign-out still work', () => {
  const r = rig({ PUSH_REGISTER_AUTH: 'enforce' });
  try {
    assert.equal(r.call({ token: r.token, platform: 'ios', userId: X }, {}).code, 401);
    assert.equal(r.ctx.pushTokens.has(r.token), false);
    assert.equal(r.call({ token: r.token, platform: 'ios', userId: X }, { authorization: 'Bearer ' + mintNow(Y) }).code, 200);
    assert.equal(r.ctx.pushTokens.get(r.token).userId, Y);
    assert.equal(r.call({ token: r.token, platform: 'ios' }).code, 200);
    assert.equal(r.ctx.pushTokens.get(r.token).userId, Y);
    assert.equal(r.call({ token: r.token, platform: 'ios', userId: null }).out.unregistered, true);
    assert.ok(r.warnings.every((w) => !w.includes(X) && !w.includes(Y) && !w.includes(r.token)), 'no ids or tokens in the log');
  } finally { r.done(); }
});

test('handler, default (log): an unproven claim links as before and logs would-refuse', () => {
  const r = rig({});
  try {
    assert.equal(r.call({ token: r.token, userId: X }, {}).code, 200);
    assert.equal(r.ctx.pushTokens.get(r.token).userId, X);
    assert.ok(r.warnings.some((w) => /\[push-auth\] would-refuse \(missing\) platform=ios/.test(w)));
  } finally { r.done(); }
});

test('handler: a past enforce date refuses with no other setting', () => {
  const r = rig({ PUSH_REGISTER_ENFORCE_FROM: '2020-01-01' });
  try {
    assert.equal(r.call({ token: r.token, platform: 'ios', userId: X }, {}).code, 401);
  } finally { r.done(); }
});

/* Nov 13 2026 (sweep 8.7): log mode counts successes too, per platform, so "how many would fail on the
 * enforce date" can be answered. Numbers only. */
test('tally: outcomes are counted per platform, a mismatch is counted inside proved, and unknown words are ignored', () => {
  const t = pushAuth.createPushAuthTally(NOW);
  assert.equal(t.line(), 'no registrations since boot');
  t.note('jwt', 'ios'); t.note('jwt', 'ios', { mismatch: true }); t.note('would-refuse', 'ios');
  t.note('would-refuse', 'android'); t.note('would-refuse', 'android'); t.note('signout', 'android');
  t.note('unlinked', 'IOS'); t.note('nonsense', 'ios'); t.note('jwt', 'we b!');
  const snap = t.snapshot();
  assert.equal(snap.total, 8);
  assert.equal(snap.since, new Date(NOW).toISOString());
  assert.deepEqual(snap.platforms.ios, { proved: 2, mismatch: 1, unproven: 1, unlinked: 1 });
  assert.deepEqual(snap.platforms.android, { unproven: 2, signedOut: 1 });
  assert.deepEqual(snap.platforms.web, { proved: 1 });
  assert.equal(t.line(), 'android signedOut 1, unproven 2; ios mismatch 1, proved 2, unlinked 1, unproven 1; web proved 1');
});

test('handler, log mode: proved, unproven, token-only and sign-out registrations are all counted, with no id or token', () => {
  const r = rig({});
  try {
    r.call({ token: r.token, platform: 'ios', userId: X }, { authorization: 'Bearer ' + mintNow(X) }); // proved
    r.call({ token: r.token, platform: 'ios', userId: X }, { authorization: 'Bearer ' + mintNow(Y) }); // proved, body names someone else
    r.call({ token: r.token, platform: 'ios', userId: X }, {});                                        // would fail on the enforce date
    r.call({ token: r.token, platform: 'ios' }, {});                                                   // links nobody
    r.call({ token: r.token, platform: 'ios', userId: null }, {});                                     // sign-out
    r.call({ token: 'not a token', platform: 'ios', userId: X }, {});                                  // refused as a bad token: not a registration
    const snap = r.ctx.pushAuthTally.snapshot();
    assert.equal(snap.total, 5);
    assert.deepEqual(snap.platforms, { ios: { proved: 2, mismatch: 1, unproven: 1, unlinked: 1, signedOut: 1 } });
    const text = JSON.stringify(snap) + r.ctx.pushAuthTally.line();
    assert.ok(!text.includes(X) && !text.includes(Y) && !text.includes(r.token));
  } finally { r.done(); }
});

test('handler, enforce: a refusal is counted as refused', () => {
  const r = rig({ PUSH_REGISTER_AUTH: 'enforce' });
  try {
    assert.equal(r.call({ token: r.token, platform: 'ios', userId: X }, {}).code, 401);
    assert.deepEqual(r.ctx.pushAuthTally.snapshot().platforms, { ios: { refused: 1 } });
  } finally { r.done(); }
});
