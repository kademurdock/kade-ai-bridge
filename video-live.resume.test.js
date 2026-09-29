/* video-live.resume.test.js — Sep 29 2026.
 *
 * Google ends every Live connection after about ten minutes and says so first
 * with goAway. Amber A's Spotter call on Sep 27 was cut there ("the client
 * failed to close the connection after receiving a GoAway signal"). With
 * session resumption the call moves to a new connection that carries the
 * conversation on. A fake socket stands in for Google; nothing here opens a
 * network connection.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'vlive-resume-'));
delete process.env.KADE_USAGE_EVENT_SECRET; // flush must never reach the network here

class FakeGoogle extends EventEmitter {
  constructor(url) { super(); this.url = url; this.readyState = 1; this.sent = []; FakeGoogle.sockets.push(this); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.closedByUs = true; setImmediate(() => this.emit('close', 1000, Buffer.from(''))); }
}
FakeGoogle.sockets = [];
const realLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'ws' ? FakeGoogle : realLoad.call(this, request, ...rest); };
const vl = require('./video-live');
Module._load = realLoad;
const { buildSetupMessage, startLive } = vl._test;

const tick = () => new Promise((r) => setImmediate(r));
const quiet = async (fn) => {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
};
const say = (g, obj) => g.emit('message', Buffer.from(JSON.stringify(obj)));

function caller() {
  const out = { states: [], speaks: [] };
  const session = {
    userId: 'u-amber', lcEmail: 'amber@example.invalid', agentName: 'Kiana', voice: 'v', callerName: 'Amber',
    streamSid: 'web-test', history: [], ws: null,
    jsonSend: (m) => out.states.push(m), sendClear() {},
  };
  const speak = (s, text) => { out.speaks.push(text); return Promise.resolve(); };
  return { session, speak, out };
}
function withLive(fn, extra = {}) {
  return async () => {
    process.env.LIVE_ENABLED = 'true';
    process.env.GOOGLE_LIVE_API_KEY = 'offline-test-key';
    process.env.LIVE_CAP_EXEMPT_EMAILS = 'amber@example.invalid';
    for (const [k, v] of Object.entries(extra)) process.env[k] = v;
    try { await fn(); } finally {
      delete process.env.LIVE_ENABLED; delete process.env.GOOGLE_LIVE_API_KEY; delete process.env.LIVE_CAP_EXEMPT_EMAILS;
      for (const k of Object.keys(extra)) delete process.env[k];
    }
  };
}
/** Start a live call and bring it up; returns the first Google socket. */
async function upCall(session, speak) {
  startLive(session, speak);
  const g = FakeGoogle.sockets.at(-1);
  g.emit('open');
  say(g, { setupComplete: {} });
  return g;
}

test('the first setup asks for resumption handles; LIVE_RESUME=0 sends no such field', () => {
  assert.deepEqual(buildSetupMessage({ callerName: 'Amber', agentName: 'Kiana' }).setup.sessionResumption, {});
  assert.deepEqual(buildSetupMessage({ callerName: 'Amber', agentName: 'Kiana', _liveResumeHandle: 'h-7' }).setup.sessionResumption, { handle: 'h-7' });
  process.env.LIVE_RESUME = '0';
  try {
    assert.equal('sessionResumption' in buildSetupMessage({ callerName: 'Amber', agentName: 'Kiana' }).setup, false);
  } finally { delete process.env.LIVE_RESUME; }
});

test('HER CALL: goAway moves the call to a resumed connection; no handback, no second greeting, one live-on', withLive(async () => {
  const { session, speak, out } = caller();
  await quiet(async () => {
    const g1 = await upCall(session, speak);
    say(g1, { sessionResumptionUpdate: { newHandle: 'h-1', resumable: true } });
    say(g1, { sessionResumptionUpdate: { newHandle: 'h-not-resumable', resumable: false } });
    assert.equal(session._liveResumeHandle, 'h-1', 'only a resumable handle is kept');
    say(g1, { goAway: { timeLeft: '10s' } });
    const g2 = FakeGoogle.sockets.at(-1);
    assert.notEqual(g2, g1, 'a new connection was opened');
    assert.equal(session._liveWs, g1, 'the call stays on the old connection until the new one is up');
    g2.emit('open');
    assert.deepEqual(g2.sent[0].setup.sessionResumption, { handle: 'h-1' }, 'the new setup carries the handle');
    say(g2, { sessionResumptionUpdate: { newHandle: 'h-2', resumable: true } });
    say(g2, { setupComplete: {} });
    assert.equal(session._liveWs, g2, 'the call moved over');
    assert.equal(session.liveOn, true);
    assert.equal(session._liveResumeHandle, 'h-2');
    assert.equal(g1.closedByUs, true, 'the old connection is closed by us');
    await tick(); await tick();
    // Audio now goes to the new connection.
    vl.forwardAudio(session, 'AAAA');
    assert.equal(g2.sent.at(-1).realtimeInput.audio.data, 'AAAA');
    vl.stopLive(session, 'hangup');
    await tick();
  });
  assert.deepEqual(out.speaks, [], 'no handback line, no silence notice');
  assert.equal(out.states.filter((m) => m.type === 'live-state' && m.on === true).length, 1, 'the client saw live come on once');
  assert.equal(session._liveResumeHandle, null, 'the handle ends with the call');
}));

test('a goAway before any handle keeps the old behaviour: the connection ends and the call is handed back', withLive(async () => {
  const { session, speak, out } = caller();
  await quiet(async () => {
    const g1 = await upCall(session, speak);
    const before = FakeGoogle.sockets.length;
    say(g1, { goAway: { timeLeft: '5s' } });
    assert.equal(FakeGoogle.sockets.length, before, 'no new connection without a handle');
    g1.emit('close', 1008, Buffer.from('GoAway'));
    await tick(); await tick();
  });
  assert.deepEqual(out.speaks, ["It's Kiana again — I've got you."]);
}));

test('the old connection closes first: the resumed one decides, and a success hands nothing back', withLive(async () => {
  const { session, speak, out } = caller();
  await quiet(async () => {
    const g1 = await upCall(session, speak);
    say(g1, { sessionResumptionUpdate: { newHandle: 'h-1', resumable: true } });
    say(g1, { goAway: { timeLeft: '1s' } });
    const g2 = FakeGoogle.sockets.at(-1);
    g1.emit('close', 1008, Buffer.from('GoAway'));
    await tick();
    assert.equal(session.liveOn, true, 'not stopped while the resume is on its way');
    g2.emit('open');
    say(g2, { setupComplete: {} });
    assert.equal(session._liveWs, g2);
    vl.stopLive(session, 'hangup');
    await tick();
  });
  assert.deepEqual(out.speaks, []);
}));

test('the old connection closed and the resume fails: the call is handed back once', withLive(async () => {
  const { session, speak, out } = caller();
  await quiet(async () => {
    const g1 = await upCall(session, speak);
    say(g1, { sessionResumptionUpdate: { newHandle: 'h-1', resumable: true } });
    say(g1, { goAway: { timeLeft: '1s' } });
    const g2 = FakeGoogle.sockets.at(-1);
    g1.emit('close', 1008, Buffer.from('GoAway'));
    g2.emit('error', new Error('Unexpected server response: 503'));
    await tick(); await tick();
    assert.equal(session.liveOn, false);
  });
  assert.deepEqual(out.speaks, ["It's Kiana again — I've got you."]);
  assert.equal(out.states.filter((m) => m.type === 'live-state' && m.on === false).length, 1);
}));

test('a resume that fails while the old connection is still open changes nothing yet', withLive(async () => {
  const { session, speak, out } = caller();
  await quiet(async () => {
    const g1 = await upCall(session, speak);
    say(g1, { sessionResumptionUpdate: { newHandle: 'h-1', resumable: true } });
    say(g1, { goAway: { timeLeft: '20s' } });
    const g2 = FakeGoogle.sockets.at(-1);
    g2.emit('close', 1011, Buffer.from('internal'));
    await tick();
    assert.equal(session._liveWs, g1, 'still on the old connection');
    assert.equal(session.liveOn, true);
    assert.equal(session._livePendingWs, null);
    // A setupComplete that still lands on the failed socket turns nothing on.
    say(g2, { setupComplete: {} });
    assert.equal(session._liveWs, g1);
    vl.stopLive(session, 'hangup');
    await tick();
  });
  assert.deepEqual(out.speaks, []);
}));

test('a resume that is not up in time is given up (the old connection is still there)', withLive(async () => {
  const { session, speak } = caller();
  await quiet(async () => {
    const g1 = await upCall(session, speak);
    say(g1, { sessionResumptionUpdate: { newHandle: 'h-1', resumable: true } });
    say(g1, { goAway: { timeLeft: '20s' } });
    const g2 = FakeGoogle.sockets.at(-1);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(session._livePendingWs, null, 'given up');
    assert.equal(g2.closedByUs, true);
    assert.equal(session._liveWs, g1);
    vl.stopLive(session, 'hangup');
    await tick();
  });
}, { LIVE_RESUME_WAIT_MS: '30' }));

test('hanging up while a resume is being set up closes it and forgets the handle', withLive(async () => {
  const { session, speak, out } = caller();
  await quiet(async () => {
    const g1 = await upCall(session, speak);
    say(g1, { sessionResumptionUpdate: { newHandle: 'h-1', resumable: true } });
    say(g1, { goAway: { timeLeft: '20s' } });
    const g2 = FakeGoogle.sockets.at(-1);
    vl.stopLive(session, 'hangup');
    assert.equal(g2.closedByUs, true);
    assert.equal(session._livePendingWs, null);
    assert.equal(session._liveResumeHandle, null);
    say(g2, { setupComplete: {} });
    assert.equal(session.liveOn, false, 'a late setupComplete on the dropped resume turns nothing on');
    await tick(); await tick();
  });
  assert.deepEqual(out.speaks, []);
}));

test('a second goAway while a resume is already on its way opens nothing more', withLive(async () => {
  const { session, speak } = caller();
  await quiet(async () => {
    const g1 = await upCall(session, speak);
    say(g1, { sessionResumptionUpdate: { newHandle: 'h-1', resumable: true } });
    say(g1, { goAway: { timeLeft: '9s' } });
    const n = FakeGoogle.sockets.length;
    say(g1, { goAway: { timeLeft: '5s' } });
    assert.equal(FakeGoogle.sockets.length, n);
    vl.stopLive(session, 'hangup');
    await tick();
  });
}));
