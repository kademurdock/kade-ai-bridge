'use strict';
/* Nov 10 2026: the public /signup form must never wipe a registered caller's row, and the three
 * wellness routes must refuse when BRIDGE_SECRET is not set. No network, no listener: the handlers are
 * cut out of server.js and run against fakes. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { signupRecord } = require('./signup-record');

const SOURCE = fs.readFileSync(require.resolve('./server.js'), 'utf8');
const DEFAULTS = { agentId: 'agent_default', agentName: 'Kiana' };

test('a new number gets a fresh row, with the child flag when asked', () => {
  assert.deepEqual(signupRecord(undefined, { name: '  Pat ' }, DEFAULTS),
    { record: { name: 'Pat', agentId: 'agent_default', agentName: 'Kiana' }, created: true });
  assert.equal(signupRecord(undefined, { name: 'Sky', accountType: 'child' }, DEFAULTS).record.accountType, 'child');
});

test('a registered number keeps its sign-in, voice, rate, agent and name', () => {
  const existing = { name: 'Kade', agentId: 'agent_own', agentName: 'Della', lcEmail: 'k@example.test', lcPass: 'secret', voice: 'fish:own', rate: 1.2 };
  const { record, created } = signupRecord(existing, { name: 'Stranger' }, DEFAULTS);
  assert.equal(created, false);
  assert.deepEqual(record, existing);
  assert.notEqual(record, existing, 'a copy, so the caller decides when to store it');
});

test('the child flag is never added to an existing row by the open form, and never taken off', () => {
  // Review, Nov 10: the first version added it, so a stranger could make an adult's row a child row for good.
  const adult = { name: 'Sky', agentId: 'a', agentName: 'A' };
  const asked = signupRecord(adult, { name: 'Sky', accountType: 'child' }, DEFAULTS).record;
  assert.equal('accountType' in asked, false);
  assert.deepEqual(asked, adult);
  const guest = signupRecord({ name: 'Friend', agentId: 'a', agentName: 'A' }, { name: 'Sky', accountType: 'child' }, DEFAULTS).record;
  assert.equal('accountType' in guest, false, 'not on a guest row either');
  assert.equal(signupRecord({ name: 'Sky', agentId: 'a', agentName: 'A', accountType: 'child' }, { name: 'Sky' }, DEFAULTS).record.accountType, 'child');
  assert.equal(signupRecord({ name: 'Sky', agentId: 'a', agentName: 'A', accountType: 'child' }, { name: 'Sky', accountType: 'adult' }, DEFAULTS).record.accountType, 'child');
});

test('a guest row the phone setup named "Friend" takes the real name from a later signup; nothing else moves', () => {
  const guest = { name: 'Friend', agentId: 'agent_picked', agentName: 'Della', voice: 'fish:own', rate: 1.1 };
  assert.deepEqual(signupRecord(guest, { name: ' Marian Smith ' }, DEFAULTS),
    { record: { ...guest, name: 'Marian Smith' }, created: false });
  // a real (even misheard) name is kept: renaming any guest row from the open form is not decided here
  assert.equal(signupRecord({ name: 'Mary Ann', agentId: 'a', agentName: 'A' }, { name: 'Marian' }, DEFAULTS).record.name, 'Mary Ann');
  // a row with a site sign-in keeps even the placeholder (linkAccount and /register own that row)
  assert.equal(signupRecord({ name: 'Friend', agentId: 'a', agentName: 'A', lcEmail: 'f@example.test' }, { name: 'Marian' }, DEFAULTS).record.name, 'Friend');
  assert.equal(signupRecord({ name: 'Friend', agentId: 'a', agentName: 'A', lcPass: 'p' }, { name: 'Marian' }, DEFAULTS).record.name, 'Friend');
});

test('a half-made row is completed, not replaced', () => {
  assert.deepEqual(signupRecord({ lcEmail: 'x@example.test' }, { name: 'Pat' }, DEFAULTS).record,
    { lcEmail: 'x@example.test', name: 'Pat', agentId: 'agent_default', agentName: 'Kiana' });
});

/* The real /signup handler, cut out of server.js. */
function signupHandler(users) {
  const start = SOURCE.indexOf("app.post('/signup'");
  const end = SOURCE.indexOf('// ── Voice: heard', start);
  assert.ok(start > 0 && end > start, 'the /signup handler is where it was');
  let handler;
  const saved = [];
  const context = vm.createContext({
    app: { post: (_path, fn) => { handler = fn; } },
    users, saveUsers: () => saved.push(JSON.stringify([...users])), signupRecord,
    DEFAULT_AGENT: DEFAULTS.agentId, DEFAULT_AGENT_NAME: DEFAULTS.agentName,
    console: { log() {} }, String,
  });
  vm.runInContext(SOURCE.slice(start, end), context);
  return { saved, post: (body) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(v) { this.body = JSON.parse(JSON.stringify(v)); return this; } };
    handler({ body }, res);
    return res;
  } };
}

test('POST /signup with a registered number answers the same and changes nothing', () => {
  const kade = { name: 'Kade', agentId: 'agent_own', agentName: 'Della', lcEmail: 'k@example.test', lcPass: 'secret', voice: 'fish:own' };
  const users = new Map([['+14175550142', { ...kade }]]);
  const h = signupHandler(users);
  const res = h.post({ name: 'Somebody Else', phone: '(417) 555-0142' });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { ok: true, phone: '+14175550142' }, 'the form reveals nothing about who is registered');
  assert.deepEqual(users.get('+14175550142'), kade, 'before the fix: { name: "Somebody Else", agentId, agentName } and the sign-in was gone');
});

test('POST /signup asking for a child account at a registered number changes nothing and saves nothing', () => {
  const kade = { name: 'Kade', agentId: 'agent_own', agentName: 'Della', lcEmail: 'k@example.test', lcPass: 'secret', voice: 'fish:own' };
  const users = new Map([['+14175550142', { ...kade }]]);
  const h = signupHandler(users);
  const res = h.post({ name: 'Stranger', phone: '417 555 0142', accountType: 'child' });
  assert.deepEqual(res.body, { ok: true, phone: '+14175550142' });
  assert.deepEqual(users.get('+14175550142'), kade, 'before the review fix the row gained accountType: "child" for good');
  assert.equal(h.saved.length, 0);
});

test('POST /signup at a guest "Friend" row stores the typed name once, keeps the agent, adds no child flag', () => {
  const users = new Map([['+14175550177', { name: 'Friend', agentId: 'agent_picked', agentName: 'Della' }]]);
  const h = signupHandler(users);
  assert.equal(h.post({ name: 'Marian Smith', phone: '4175550177', accountType: 'child' }).code, 200);
  assert.deepEqual(users.get('+14175550177'), { name: 'Marian Smith', agentId: 'agent_picked', agentName: 'Della' });
  assert.equal(h.saved.length, 1);
  h.post({ name: 'Somebody Else', phone: '4175550177' });
  assert.equal(users.get('+14175550177').name, 'Marian Smith', 'a real name is not replaced');
  assert.equal(h.saved.length, 1);
});

test('POST /signup with a new number still registers it', () => {
  const users = new Map();
  const h = signupHandler(users);
  assert.equal(h.post({ name: 'Pat', phone: '417-555-0199', accountType: 'child' }).code, 200);
  assert.deepEqual(users.get('+14175550199'), { name: 'Pat', agentId: 'agent_default', agentName: 'Kiana', accountType: 'child' });
  assert.equal(h.saved.length, 1);
  assert.equal(h.post({ phone: '417-555-0199' }).code, 400);
  assert.equal(h.post({ name: 'Pat', phone: '555' }).code, 400);
});

test('no route compares a body secret to BRIDGE_SECRET bare (an unset secret would match an empty one)', () => {
  assert.doesNotMatch(SOURCE, /b\.secret !== BRIDGE_SECRET/);
  assert.equal((SOURCE.match(/if \(!bridgeSecretOk\(req, b\.secret\)\) return res\.status\(403\)/g) || []).length >= 3, true);
});

test('bridgeSecretOk refuses everything while the secret is unset', () => {
  const start = SOURCE.indexOf('function bridgeSecretOk(req, provided)');
  const end = SOURCE.indexOf('\n}\n', start) + 3;
  const run = (secret) => {
    const context = vm.createContext({ BRIDGE_SECRET: secret });
    vm.runInContext(SOURCE.slice(start, end) + '\nthis.ok = bridgeSecretOk;', context);
    return context.ok;
  };
  const req = (h) => ({ get: () => h });
  assert.equal(run('')(req(undefined), ''), false, 'empty secret, empty answer: refused');
  assert.equal(run('')(req(''), undefined), false);
  assert.equal(run('s3cret')(req(undefined), 's3cret'), true);
  assert.equal(run('s3cret')(req('s3cret'), undefined), true);
  assert.equal(run('s3cret')(req(undefined), ''), false);
});
