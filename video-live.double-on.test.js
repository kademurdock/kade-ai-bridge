/* video-live.double-on.test.js — Nov 10 2026 (call limits lane).
 *
 * A second "live on" for a call that already had a Google Live connection (a double tap on the
 * button, or "get my Spotter" said again while the first connection was still coming up) opened a
 * second Google socket and dropped its hold on the first, which then stayed open with nobody
 * reading it until Google timed it out. One connection per call now. A fake socket stands in for
 * Google; nothing here opens a network connection.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'vlive-double-'));
delete process.env.KADE_USAGE_EVENT_SECRET;

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

const tick = () => new Promise((r) => setImmediate(r));
const quiet = async (fn) => {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
};
function caller() {
  const out = { states: [], speaks: [] };
  const session = {
    userId: 'u-double', lcEmail: 'double@example.invalid', agentName: 'Kiana', voice: 'v', callerName: 'Pat',
    streamSid: 'web-test', history: [], ws: null,
    jsonSend: (m) => out.states.push(m), sendClear() {},
  };
  const speak = (s, text) => { out.speaks.push(text); return Promise.resolve(); };
  return { session, speak, out };
}
function withLive(fn) {
  return async () => {
    process.env.LIVE_ENABLED = 'true';
    process.env.GOOGLE_LIVE_API_KEY = 'offline-test-key';
    process.env.LIVE_CAP_EXEMPT_EMAILS = 'double@example.invalid';
    FakeGoogle.sockets.length = 0;
    try { await quiet(fn); } finally {
      delete process.env.LIVE_ENABLED; delete process.env.GOOGLE_LIVE_API_KEY; delete process.env.LIVE_CAP_EXEMPT_EMAILS;
    }
  };
}

test('a second "live on" while the first connection is still coming up opens no second Google socket and says no second handoff line', withLive(async () => {
  const { session, speak, out } = caller();
  vl.handleLiveMsg(session, { on: true, ack: true }, speak);
  assert.equal(FakeGoogle.sockets.length, 1);
  const first = FakeGoogle.sockets[0];
  const linesAfterFirst = out.speaks.length;
  vl.handleLiveMsg(session, { on: true }, speak); // the double tap
  vl.handleLiveMsg(session, { on: true }, speak);
  assert.equal(FakeGoogle.sockets.length, 1, 'still one socket');
  assert.equal(session._liveWs, first, 'and the call still holds the first one');
  assert.equal(out.speaks.length, linesAfterFirst, 'the handoff line is not repeated');
  assert.equal(first.closedByUs, undefined);
}));

test('a second "live on" while live is up keeps the one connection', withLive(async () => {
  const { session, speak } = caller();
  vl.handleLiveMsg(session, { on: true, ack: true }, speak);
  const first = FakeGoogle.sockets[0];
  first.emit('open');
  first.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
  assert.equal(session.liveOn, true);
  vl.handleLiveMsg(session, { on: true }, speak);
  assert.equal(FakeGoogle.sockets.length, 1);
  assert.equal(session.liveOn, true, 'and live was not knocked back to "starting"');
  vl.stopLive(session, 'hangup');
  await tick();
}));

test('"live off" then "live on" still restarts: the old socket is closed and a new one is opened', withLive(async () => {
  const { session, speak } = caller();
  vl.handleLiveMsg(session, { on: true, ack: true }, speak);
  const first = FakeGoogle.sockets[0];
  first.emit('open');
  first.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
  vl.handleLiveMsg(session, { on: false }, speak);
  assert.equal(first.closedByUs, true);
  assert.equal(session._liveWs, null);
  await tick();
  vl.handleLiveMsg(session, { on: true }, speak);
  assert.equal(FakeGoogle.sockets.length, 2);
  assert.equal(session._liveWs, FakeGoogle.sockets[1]);
  vl.stopLive(session, 'hangup');
  await tick();
}));

test('after Google itself closes the connection, "live on" opens a fresh one', withLive(async () => {
  const { session, speak } = caller();
  vl.handleLiveMsg(session, { on: true, ack: true }, speak);
  const first = FakeGoogle.sockets[0];
  first.emit('open');
  first.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
  first.emit('close', 1011, Buffer.from('gone'));
  assert.equal(session._liveWs, null);
  vl.handleLiveMsg(session, { on: true }, speak);
  assert.equal(FakeGoogle.sockets.length, 2);
  vl.stopLive(session, 'hangup');
  await tick();
}));

test('a connection that never came up is not kept for ever: asking again after 15 s replaces it and closes the stuck one', withLive(async () => {
  const { session, speak } = caller();
  vl.handleLiveMsg(session, { on: true, ack: true }, speak);
  const stuck = FakeGoogle.sockets[0]; // never opens, never completes setup, never closes
  session._liveStartAt = Date.now() - 16000;
  vl.handleLiveMsg(session, { on: true }, speak);
  assert.equal(FakeGoogle.sockets.length, 2);
  assert.equal(session._liveWs, FakeGoogle.sockets[1]);
  assert.equal(stuck.closedByUs, true, 'the stuck socket is closed, not left open');
  await tick();
  assert.equal(session._liveWs, FakeGoogle.sockets[1], 'its late close does not take the new connection down');
  vl.stopLive(session, 'hangup');
  await tick();
}));
