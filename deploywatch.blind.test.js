'use strict';
/* deploywatch.blind.test.js -- Nov 13 2026 (post-release sweep 8.0). The deploy watcher was blind for three
 * weeks: a stale Railway token came back as HTTP 200 with an `errors` list, which was read as "no
 * deployments" and only ever logged. Railway's own error now rides in the message, and when every service
 * has been unreadable for DEPLOYWATCH_BLIND_PASSES passes in a row the admin gets ONE alert.
 * Fake fetch, a temp state file, no timers, no network. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploywatch-blind-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = dir;
process.env.DEPLOYWATCH = '0'; // no timers: the test calls tick() itself
process.env.TTS_PROBE = '0';
process.env.RAILWAY_API_TOKEN = 'stale-token-for-test';
process.env.GITHUB_PAT = 'pat-for-test';
delete process.env.DEPLOYWATCH_BLIND_PASSES;

const { attachDeployWatch } = require('./deploywatch.js');

const realFetch = global.fetch;
const realWarn = console.warn;
const realLog = console.log;
test.after(() => { global.fetch = realFetch; console.warn = realWarn; console.log = realLog; fs.rmSync(dir, { recursive: true, force: true }); });

/* mode: 'auth' (HTTP 200 + errors, what a stale token gets), 'empty' (no deployments, no errors), 'ok'. */
function fakeFetch(mode) {
  return async (url) => {
    const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (String(url).startsWith('https://api.github.com/')) return json({ commit: { sha: 'a'.repeat(40), commit: { committer: { date: new Date().toISOString() } } } });
    if (mode === 'auth') return json({ errors: [{ message: 'Not Authorized' }], data: null });
    if (mode === 'empty') return json({ data: { deployments: { edges: [] } } });
    return json({ data: { deployments: { edges: [{ node: { status: 'SUCCESS', createdAt: new Date().toISOString(), meta: { commitHash: 'a'.repeat(40) } } }] } } });
  };
}
function rig(env = {}) {
  try { fs.rmSync(path.join(dir, 'deploywatch.json'), { force: true }); } catch { /* none yet */ }
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const alerts = [];
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  console.log = (...a) => lines.push(a.join(' '));
  const app = { get() {}, post() {} };
  const w = attachDeployWatch(app, { bridgeSecretOk: () => true, runNotify: async (n) => { alerts.push(n); return { ok: true }; }, adminUser: 'admin-user' });
  return { ...w, alerts, lines, done: () => { for (const k of Object.keys(env)) delete process.env[k]; } };
}

test("Railway's own error is in the message, not 'no deployments'", async () => {
  const r = rig();
  try {
    global.fetch = fakeFetch('auth');
    const out = await r.tick('tick');
    assert.equal(out.rows.length > 0 && out.rows.every((row) => row.error === 'railway: Not Authorized'), true, JSON.stringify(out.rows));
    assert.ok(r.lines.some((l) => /check failed: railway: Not Authorized/.test(l)));
    assert.ok(r.lines.every((l) => !l.includes('stale-token-for-test')), 'the token is never logged');
    global.fetch = fakeFetch('empty');
    const empty = await r.tick('tick');
    assert.ok(empty.rows.every((row) => row.error === 'railway: no deployments'), 'a service with no deployments still says so');
  } finally { r.done(); }
});

test('every service unreadable for four passes in a row: ONE admin alert with the reason, and no more while it stays blind', async () => {
  const r = rig();
  try {
    global.fetch = fakeFetch('auth');
    for (let i = 0; i < 3; i++) await r.tick('tick');
    assert.equal(r.alerts.length, 0, 'three blind passes: not yet');
    await r.tick('tick');
    assert.equal(r.alerts.length, 1);
    const a = r.alerts[0];
    assert.equal(a.adminAlert, true);
    assert.equal(a.userId, 'admin-user');
    assert.equal(a.urgent, false);
    assert.match(a.body, /4 checks in a row/);
    assert.match(a.body, /Not Authorized/);
    assert.ok(!a.body.includes('stale-token-for-test'));
    for (let i = 0; i < 10; i++) await r.tick('tick');
    assert.equal(r.alerts.length, 1, 'said once');

    // It can see again: the streak is over, and a NEW blind spell is announced once more.
    global.fetch = fakeFetch('ok');
    await r.tick('tick');
    assert.ok(r.lines.some((l) => /can see again after 14 blind passes/.test(l)));
    global.fetch = fakeFetch('auth');
    for (let i = 0; i < 4; i++) await r.tick('tick');
    assert.equal(r.alerts.length, 2);
  } finally { r.done(); }
});

test('the streak survives a restart, and an alert already sent is not sent again by the new process', async () => {
  const r = rig();
  let again;
  try {
    global.fetch = fakeFetch('auth');
    for (let i = 0; i < 4; i++) await r.tick('tick');
    assert.equal(r.alerts.length, 1);
    // A new process reads the same state file.
    const alerts2 = [];
    again = attachDeployWatch({ get() {}, post() {} }, { bridgeSecretOk: () => true, runNotify: async (n) => { alerts2.push(n); }, adminUser: 'admin-user' });
    for (let i = 0; i < 6; i++) await again.tick('tick');
    assert.equal(alerts2.length, 0);
  } finally { r.done(); }
});

test('one readable service is not blindness; DEPLOYWATCH_BLIND_PASSES=0 never alerts', async () => {
  const r = rig();
  try {
    let n = 0;
    const auth = fakeFetch('auth'), ok = fakeFetch('ok');
    // The first Railway call of every pass answers; the rest are refused.
    global.fetch = async (url, o) => (String(url).startsWith('https://api.github.com/') ? ok(url, o) : (n++ % 100 === 0 ? ok(url, o) : auth(url, o)));
    for (let i = 0; i < 8; i++) { n = 0; await r.tick('tick'); }
    assert.equal(r.alerts.length, 0);
  } finally { r.done(); }
  const off = rig({ DEPLOYWATCH_BLIND_PASSES: '0' });
  try {
    global.fetch = fakeFetch('auth');
    for (let i = 0; i < 8; i++) await off.tick('tick');
    assert.equal(off.alerts.length, 0);
  } finally { off.done(); }
});

test('only scheduled passes count: status reads and manual runs during an outage never reach the limit, and a good read still ends the streak', async () => {
  const r = rig();
  try {
    global.fetch = fakeFetch('auth');
    for (let i = 0; i < 20; i++) await r.tick(i % 2 ? 'manual' : 'platform-status');
    assert.equal(r.alerts.length, 0, 'twenty unscheduled blind reads: no alert');
    await r.tick('boot');
    for (let i = 0; i < 2; i++) await r.tick('tick');
    assert.equal(r.alerts.length, 0, 'three scheduled passes: not yet');
    for (let i = 0; i < 5; i++) await r.tick('manual');
    assert.equal(r.alerts.length, 0);
    await r.tick('tick');
    assert.equal(r.alerts.length, 1, 'the fourth scheduled pass');
    assert.match(r.alerts[0].body, /4 checks in a row/);
    // A manual run that can read ends the streak, so the next blind spell is announced again.
    global.fetch = fakeFetch('ok');
    await r.tick('manual');
    global.fetch = fakeFetch('auth');
    for (let i = 0; i < 4; i++) await r.tick('tick');
    assert.equal(r.alerts.length, 2);
  } finally { r.done(); }
});
