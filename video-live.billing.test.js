/* video-live.billing.test.js — Sep 26 2026, Part 295 (Kade: "Spotter: fix both").
 *
 * The Live lane itself: the context-window trim Google's best-practices page asks
 * for, Google's usageMetadata feeding the meter, the key-trouble line a caller
 * hears, and the handback said once. A fake socket stands in for Google; nothing
 * here opens a network connection.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'vlive-'));
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
const { liveCompression, buildSetupMessage, handleGoogleMessage, startLive, LIVE_CREDIT_LINE, LIVE_QUOTA_LINE } = vl._test;

const tick = () => new Promise((r) => setImmediate(r));
const quiet = async (fn) => {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
};

test('the trim Google asks for: trigger 25,000 tokens, keep 8,000, int64 sent as strings', () => {
  assert.deepEqual(liveCompression({}), { triggerTokens: '25000', slidingWindow: { targetTokens: '8000' } });
  const setup = buildSetupMessage({ callerName: 'Amber', agentName: 'Kiana' }).setup;
  assert.deepEqual(setup.contextWindowCompression, { triggerTokens: '25000', slidingWindow: { targetTokens: '8000' } });
  assert.deepEqual(setup.proactivity, { proactiveAudio: true }, 'the rest of the setup is untouched');
  assert.deepEqual(setup.outputAudioTranscription, {});
});

test('env overrides; 0 restores Google\'s defaults; a target at or over the trigger becomes half', () => {
  assert.deepEqual(liveCompression({ LIVE_COMPRESSION_TRIGGER_TOKENS: '40000', LIVE_COMPRESSION_TARGET_TOKENS: '12000' }),
    { triggerTokens: '40000', slidingWindow: { targetTokens: '12000' } });
  assert.deepEqual(liveCompression({ LIVE_COMPRESSION_TRIGGER_TOKENS: '0' }), { slidingWindow: {} });
  assert.deepEqual(liveCompression({ LIVE_COMPRESSION_TRIGGER_TOKENS: '20000', LIVE_COMPRESSION_TARGET_TOKENS: '20000' }),
    { triggerTokens: '20000', slidingWindow: { targetTokens: '10000' } });
  assert.deepEqual(liveCompression({ LIVE_COMPRESSION_TRIGGER_TOKENS: 'lots' }), { triggerTokens: '25000', slidingWindow: { targetTokens: '8000' } });
});

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
function withLive(fn) {
  return async () => {
    process.env.LIVE_ENABLED = 'true';
    process.env.GOOGLE_LIVE_API_KEY = 'offline-test-key';
    process.env.LIVE_CAP_EXEMPT_EMAILS = 'amber@example.invalid';
    try { await fn(); } finally {
      delete process.env.LIVE_ENABLED; delete process.env.GOOGLE_LIVE_API_KEY; delete process.env.LIVE_CAP_EXEMPT_EMAILS;
    }
  };
}
const USAGE = {
  promptTokenCount: 12000,
  promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 3000 }, { modality: 'VIDEO', tokenCount: 8000 }, { modality: 'TEXT', tokenCount: 1000 }],
  responseTokenCount: 500, responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 500 }],
};

test('Google\'s usageMetadata lands in the meter, even riding on a turn message', withLive(async () => {
  const { session, speak, out } = caller();
  await quiet(async () => {
    startLive(session, speak);
    const g = FakeGoogle.sockets.at(-1);
    g.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
    assert.equal(session.liveOn, true);
    g.emit('message', Buffer.from(JSON.stringify({
      serverContent: { outputTranscription: { text: 'The stove knobs all point to off.' }, turnComplete: true },
      usageMetadata: USAGE,
    })));
    const bill = session._liveBill;
    assert.ok(Math.abs(bill.totals.metered - 0.02375) < 1e-9);
    assert.equal(bill.totals.reports, 1);
    const said = session.history.at(-1);
    assert.equal(said.content, 'The stove knobs all point to off.');
    assert.equal(said.lane, 'live', 'a Spotter turn is marked so the voice_chat estimate skips it');
    vl.stopLive(session, 'hangup');
    await tick();
    assert.equal(bill.totals.est, 0, 'a metered connection never also pays the per-minute estimate');
    assert.equal(bill.pend.metered, 0, 'the stop took the cost for posting');
  });
  assert.equal(out.speaks.length, 0, 'a hang-up says nothing');
}));

test('HER EMPTY KEY: a prepayment close is heard as out of credit, once, and pages Kade', withLive(async () => {
  const { session, speak, out } = caller();
  await quiet(async () => {
    startLive(session, speak);
    const g = FakeGoogle.sockets.at(-1);
    g.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
    g.emit('close', 1011, Buffer.from('Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.'));
    await tick(); await tick();
  });
  assert.equal(out.speaks.length, 1, 'the handback is said once, not again when our own close echoes');
  assert.ok(out.speaks[0].startsWith(LIVE_CREDIT_LINE), out.speaks[0]);
  assert.match(out.speaks[0], /It's Kiana again/);
  const off = out.states.filter((m) => m.type === 'live-state' && m.on === false);
  assert.equal(off.length, 1);
  assert.equal(off[0].message, LIVE_CREDIT_LINE);
  const watch = JSON.parse(fs.readFileSync(path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'google-watch.json'), 'utf8'));
  assert.equal(watch.lastTrouble.kind, 'credit');
  assert.equal(watch.lastTrouble.where, 'a Spotter call');
  assert.equal(session._liveTrouble, null, 'the trouble is spoken once, not carried into the next stop');
}));

test('a 429 on the upgrade is a limit, not a generic drop', withLive(async () => {
  const { session, speak, out } = caller();
  await quiet(async () => {
    startLive(session, speak);
    FakeGoogle.sockets.at(-1).emit('error', new Error('Unexpected server response: 429'));
    await tick(); await tick();
  });
  assert.equal(out.speaks.length, 1);
  assert.ok(out.speaks[0].startsWith(LIVE_QUOTA_LINE), out.speaks[0]);
}));

test('an ordinary "live off" speaks the handback once (our own close no longer echoes)', withLive(async () => {
  const { session, speak, out } = caller();
  await quiet(async () => {
    startLive(session, speak);
    const g = FakeGoogle.sockets.at(-1);
    g.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
    vl.stopLive(session, 'off');
    await tick(); await tick();
    assert.equal(g.closedByUs, true);
  });
  assert.deepEqual(out.speaks, ["It's Kiana again — I've got you."]);
  assert.equal(out.states.filter((m) => m.type === 'live-state' && m.on === false).length, 1);
}));

test('a report that arrives after the stop is still metered (and posted on its own)', withLive(async () => {
  const { session, speak } = caller();
  await quiet(async () => {
    startLive(session, speak);
    const g = FakeGoogle.sockets.at(-1);
    g.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
    vl.stopLive(session, 'off');
    handleGoogleMessage(session, Buffer.from(JSON.stringify({ usageMetadata: USAGE })));
    await tick();
  });
  assert.ok(Math.abs(session._liveBill.totals.metered - 0.02375) < 1e-9);
  assert.equal(session._liveBill.pend.metered, 0, 'taken for posting straight away');
}));
