'use strict';
/* Nov 26 2026 (lockdown): the lock on POST /signup (signup-gate.js). The first part tests the gate
 * on its own. The second part cuts the real /signup routes out of server.js, mounts them on a real
 * express app listening on 127.0.0.1 only, and posts to them. Nothing leaves the machine. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const vm = require('node:vm');
const express = require('express');
const gateLib = require('./signup-gate');
const { signupRecord } = require('./signup-record');

const { createSignupGate, signupGateConfig, sameCode, requestAddress, signupStartupLine } = gateLib;
const SOURCE = fs.readFileSync(require.resolve('./server.js'), 'utf8').replace(/\r\n/g, '\n');
const SECRET = 'test-bridge-secret-0123456789';
const CODE = 'test-signup-code-4242';

const fakeReq = (body = {}, headers = {}, addr = '203.0.113.9') => ({
  body, headers, socket: { remoteAddress: addr },
  get: (h) => headers[String(h).toLowerCase()],
});
const secretOk = (req, provided) => (req.get && req.get('x-bridge-secret')) === SECRET || provided === SECRET;

test('the config reads the code and the kill switch, and nothing else', () => {
  assert.deepEqual(signupGateConfig({}), { open: false, code: '' });
  assert.deepEqual(signupGateConfig({ BRIDGE_SIGNUP_CODE: '  abc  ' }), { open: false, code: 'abc' });
  for (const on of ['1', 'on', 'TRUE', ' yes ']) assert.equal(signupGateConfig({ BRIDGE_SIGNUP_OPEN: on }).open, true, on);
  for (const off of ['', '0', 'off', 'no', 'maybe']) assert.equal(signupGateConfig({ BRIDGE_SIGNUP_OPEN: off }).open, false, off);
});

test('sameCode matches only the exact code, and never an empty one', () => {
  assert.equal(sameCode(CODE, CODE), true);
  assert.equal(sameCode(' ' + CODE + ' ', CODE), true, 'spaces typed around it are fine');
  assert.equal(sameCode(CODE + 'x', CODE), false);
  assert.equal(sameCode('', CODE), false);
  assert.equal(sameCode(undefined, CODE), false);
  assert.equal(sameCode('', ''), false, 'an unset code never matches an empty answer');
  assert.equal(sameCode(undefined, ''), false);
});

test('with no code set, only the bridge secret gets in; everyone else gets the plain closed message', () => {
  const gate = createSignupGate({ config: { open: false, code: '' }, secretOk });
  assert.deepEqual(gate.check(fakeReq({ name: 'Pat', phone: '4175550199' })),
    { ok: false, status: 403, error: gateLib.CLOSED_MESSAGE });
  assert.equal(gate.check(fakeReq({ code: '' })).ok, false, 'an empty code does not open it');
  assert.deepEqual(gate.check(fakeReq({}, { 'x-bridge-secret': SECRET })), { ok: true, via: 'secret' });
  assert.deepEqual(gate.check(fakeReq({ secret: SECRET })), { ok: true, via: 'secret' }, 'the body secret works like on /register');
  assert.equal(gate.check(fakeReq({}, { 'x-bridge-secret': 'wrong' })).ok, false);
  assert.equal(gate.formOpen(), false);
});

test('with a code set, the right code gets in and a wrong or missing one is refused', () => {
  const gate = createSignupGate({ config: { open: false, code: CODE }, secretOk });
  assert.deepEqual(gate.check(fakeReq({ code: CODE })), { ok: true, via: 'code' });
  assert.deepEqual(gate.check(fakeReq({ code: 'nope' }, {}, '198.51.100.1')), { ok: false, status: 403, error: gateLib.WRONG_CODE_MESSAGE });
  assert.deepEqual(gate.check(fakeReq({}, {}, '198.51.100.2')), { ok: false, status: 403, error: gateLib.NO_CODE_MESSAGE });
  assert.equal(gate.formOpen(), true);
});

test('the kill switch opens the form to anyone, as before', () => {
  const gate = createSignupGate({ config: { open: true, code: '' }, secretOk });
  assert.deepEqual(gate.check(fakeReq({ name: 'Pat' })), { ok: true, via: 'open' });
  assert.equal(gate.formOpen(), true);
  assert.match(signupStartupLine({ open: true, code: '' }), /OPEN to anyone/);
  assert.match(signupStartupLine({ open: false, code: '' }), /bridge secret only/);
  assert.doesNotMatch(signupStartupLine({ open: false, code: CODE }), new RegExp(CODE), 'the startup line never prints the code');
});

test('one address gets 5 code tries in 15 minutes; the secret is never slowed down', () => {
  let t = 1_000_000;
  const gate = createSignupGate({ config: { open: false, code: CODE }, secretOk, now: () => t });
  for (let i = 0; i < 5; i++) assert.equal(gate.check(fakeReq({ code: 'guess' + i })).status, 403);
  const sixth = gate.check(fakeReq({ code: CODE }));
  assert.deepEqual(sixth, { ok: false, status: 429, error: gateLib.SLOW_DOWN_MESSAGE }, 'even the right code waits');
  assert.equal(gate.check(fakeReq({ code: CODE }, {}, '198.51.100.7')).ok, true, 'another address is not blocked');
  assert.equal(gate.check(fakeReq({}, { 'x-bridge-secret': SECRET })).ok, true, 'the site is never slowed down');
  t += 15 * 60 * 1000;
  assert.equal(gate.check(fakeReq({ code: CODE })).ok, true, 'the address is let in again after 15 minutes');
});

test('30 wrong codes from many made-up addresses close the code for the hour', () => {
  let t = 5_000_000;
  const gate = createSignupGate({ config: { open: false, code: CODE }, secretOk, now: () => t });
  for (let i = 0; i < 30; i++) {
    assert.equal(gate.check(fakeReq({ code: 'guess' }, { 'x-forwarded-for': `10.0.${i}.1` })).status, 403);
  }
  assert.equal(gate.check(fakeReq({ code: CODE }, { 'x-forwarded-for': '10.9.9.9' })).status, 429, 'a fresh address waits too');
  assert.equal(gate.check(fakeReq({ secret: SECRET })).ok, true, 'the secret still works');
  t += 60 * 60 * 1000;
  assert.equal(gate.check(fakeReq({ code: CODE }, { 'x-forwarded-for': '10.9.9.9' })).ok, true, 'open again the next hour');
  assert.equal(gate.stats().wrongCode, 30);
});

test('once the code is closed for the hour, a flood from made-up addresses adds nothing to the address list', () => {
  const t = 7_000_000;
  const gate = createSignupGate({ config: { open: false, code: CODE }, secretOk, now: () => t });
  for (let i = 0; i < 30; i++) gate.check(fakeReq({ code: 'guess' }, { 'x-forwarded-for': `10.1.${i}.1` }));
  assert.equal(gate.addressCount(), 30);
  for (let i = 0; i < 500; i++) {
    assert.equal(gate.check(fakeReq({ code: 'guess' }, { 'x-forwarded-for': `10.2.${i % 250}.${i}` })).status, 429);
  }
  assert.equal(gate.addressCount(), 30, 'no new entries while the shared cap is closed');
});

test('the address list never grows past its limit, even with new addresses inside 15 minutes', () => {
  let t = 9_000_000;
  const gate = createSignupGate({
    config: { open: false, code: CODE }, secretOk, now: () => t, maxAddresses: 50, wrongCodeCap: 1_000_000,
  });
  for (let i = 0; i < 400; i++) {
    t += 1000;
    gate.check(fakeReq({ code: 'guess' }, { 'x-forwarded-for': `10.3.${i % 250}.${i}` }));
    assert.ok(gate.addressCount() <= 50, `at most 50 addresses (had ${gate.addressCount()})`);
  }
  assert.equal(gate.check(fakeReq({ code: CODE }, { 'x-forwarded-for': '10.4.4.4' })).ok, true, 'the right code still works');
});

test('the address is the last X-Forwarded-For entry, which Railway adds, not the first one the caller writes', () => {
  assert.equal(requestAddress(fakeReq({}, { 'x-forwarded-for': '1.2.3.4, 203.0.113.50' })), '203.0.113.50');
  assert.equal(requestAddress(fakeReq({}, {}, '127.0.0.1')), '127.0.0.1');
});

/* ── The real routes from server.js ────────────────────────────────────────────────────────── */

function cut(startMarker, endMarker) {
  const start = SOURCE.indexOf(startMarker);
  const end = SOURCE.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, `${startMarker} is where it was`);
  return SOURCE.slice(start, end);
}

async function withBridge(env, run) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  const users = new Map();
  const saved = [];
  const logs = [];
  const context = vm.createContext({
    app, users, saveUsers: () => saved.push(1), signupRecord,
    BRIDGE_SECRET: env.BRIDGE_SECRET || '',
    createSignupGate, signupStartupLine: () => signupStartupLine(signupGateConfig(env)),
    signupGateConfig: () => signupGateConfig(env), SIGNUP_CLOSED_MESSAGE: gateLib.CLOSED_MESSAGE,
    DEFAULT_AGENT: 'agent_default', DEFAULT_AGENT_NAME: 'Kiana',
    console: { log: (l) => logs.push(String(l)) }, String, JSON, crypto: require('node:crypto'),
  });
  /* The real secret check: the constant-time compare and bridgeSecretOk. */
  vm.runInContext(cut('const BRIDGE_SECRET_HASH = ', '\n// July 15 2026: SCOPED secret'), context);
  vm.runInContext(cut('const SIGNUP_HTML = ', '\n'), context);
  vm.runInContext(cut('const signupGate = createSignupGate(', '// ── Voice: heard'), context);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const request = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
  try {
    return await run({ post: (b, h) => request('POST', '/signup', b, h), get: () => request('GET', '/signup'), users, saved, logs });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test('live routes, default setup: a stranger posting a number is refused and nothing is saved (how AuditProbe got in)', async () => {
  await withBridge({ BRIDGE_SECRET: SECRET }, async ({ post, get, users, saved, logs }) => {
    const r = await post({ name: 'AuditProbe', phone: '4155551234' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, gateLib.CLOSED_MESSAGE);
    assert.equal(users.size, 0);
    assert.equal(saved.length, 0);
    assert.ok(logs.every((l) => !l.includes('4155551234')), 'a refusal never logs the number');
    const page = await get();
    assert.equal(page.status, 200);
    assert.match(page.text, /This form is closed/);
    assert.doesNotMatch(page.text, /<form/, 'no form is shown while it is closed');
  });
});

test('live routes: a flood of refused posts logs only the first 20 lines', async () => {
  await withBridge({ BRIDGE_SECRET: SECRET }, async ({ post, logs }) => {
    for (let i = 0; i < 25; i++) assert.equal((await post({ name: 'Probe', phone: '4155550000' })).status, 403);
    assert.equal(logs.filter((l) => l.startsWith('[signup] refused')).length, 20);
  });
});

test('live routes: the LibreChat site, sending the bridge secret header, still registers a new phone', async () => {
  await withBridge({ BRIDGE_SECRET: SECRET }, async ({ post, users, saved, logs }) => {
    const r = await post({ name: 'Pat', phone: '417-555-0199', accountType: 'child' }, { 'x-bridge-secret': SECRET });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, phone: '+14175550199' });
    assert.deepEqual(users.get('+14175550199'), { name: 'Pat', agentId: 'agent_default', agentName: 'Kiana', accountType: 'child' });
    assert.equal(saved.length, 1);
    assert.ok(logs.some((l) => l.includes('via secret')));
  });
});

test('live routes: the secret still keeps an existing row untouched (no overwrite)', async () => {
  await withBridge({ BRIDGE_SECRET: SECRET }, async ({ post, users, saved }) => {
    const kade = { name: 'Kade', agentId: 'agent_own', agentName: 'Della', lcEmail: 'k@example.test', voice: 'fish:own' };
    users.set('+14175550142', { ...kade });
    const r = await post({ name: 'Somebody Else', phone: '4175550142' }, { 'x-bridge-secret': SECRET });
    assert.deepEqual(r.json, { ok: true, phone: '+14175550142' });
    assert.deepEqual(users.get('+14175550142'), kade);
    assert.equal(saved.length, 0);
  });
});

test('live routes: with BRIDGE_SECRET unset, no secret, empty or not, gets in', async () => {
  await withBridge({}, async ({ post, users }) => {
    assert.equal((await post({ name: 'Pat', phone: '4175550199', secret: '' })).status, 403);
    assert.equal((await post({ name: 'Pat', phone: '4175550199' }, { 'x-bridge-secret': '' })).status, 403);
    assert.equal(users.size, 0);
  });
});

test('live routes with a signup code: the form shows a code box, the right code registers, a wrong one does not', async () => {
  await withBridge({ BRIDGE_SECRET: SECRET, BRIDGE_SIGNUP_CODE: CODE }, async ({ post, get, users }) => {
    const page = await get();
    assert.match(page.text, /<form/);
    assert.match(page.text, /id="code"/, 'the form has a code box');
    assert.match(page.text, /code: document\.getElementById\('code'\)\.value\.trim\(\)/, 'and sends it');
    assert.doesNotMatch(page.text, new RegExp(CODE), 'the page never carries the code itself');
    assert.equal((await post({ name: 'Mallory', phone: '4155557777', code: 'guess' })).status, 403);
    assert.equal(users.size, 0);
    const ok = await post({ name: 'Grandma', phone: '4175550111', code: CODE });
    assert.equal(ok.status, 200);
    assert.equal(users.get('+14175550111').name, 'Grandma');
    assert.equal('code' in users.get('+14175550111'), false, 'the code is not stored on the row');
  });
});

test('live routes with the kill switch on: the old open form works for anyone', async () => {
  await withBridge({ BRIDGE_SECRET: SECRET, BRIDGE_SIGNUP_OPEN: '1' }, async ({ post, get, users }) => {
    assert.match((await get()).text, /<form/);
    assert.equal((await post({ name: 'Pat', phone: '4175550199' })).status, 200);
    assert.equal(users.get('+14175550199').name, 'Pat');
  });
});
