/* video-live.stop.test.js — Nov 2026 (platform audit DESC-2). The Stop button during a Spotter
 * turn: the rest of the turn is dropped, the next turn is never swallowed. Fake Google socket,
 * mocked clock, no network. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'vlive-stop-'));
delete process.env.KADE_USAGE_EVENT_SECRET; // flush must never reach the network here
delete process.env.LIVE_STOP_MUTE;

class FakeGoogle extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(d) { this.sent.push(d); }
  close() { this.closedByUs = true; }
}
const realLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'ws' ? FakeGoogle : realLoad.call(this, request, ...rest); };
const vl = require('./video-live');
Module._load = realLoad;
const { handleGoogleMessage } = vl._test;

function mk() {
  const gws = new FakeGoogle();
  const s = { userId: 'u1', liveOn: true, _liveWs: gws, history: [], sends: 0, clears: 0,
    ws: { readyState: 1, send() { s.sends++; } }, sendClear() { s.clears++; }, jsonSend() {} };
  return { s, gws };
}
const msg = (o) => Buffer.from(JSON.stringify(o));
const audio = () => msg({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(480).toString('base64') } }] } } });
const said = (t) => msg({ serverContent: { outputTranscription: { text: t } } });
const end = (k) => msg({ serverContent: { [k]: true } });
const setup = () => msg({ setupComplete: {} });

let clock = 1e12;
test.beforeEach((t) => { t.mock.method(Date, 'now', () => clock); });

test('Stop mid-turn: the rest of the turn is dropped, the transcript stops, the next turn plays', () => {
  const { s, gws } = mk();
  assert.strictEqual(vl.muteLiveTurn(s), false, 'no open turn: nothing to mute');
  assert.strictEqual(s.clears, 0);
  handleGoogleMessage(s, said('Heard part. '), gws);
  handleGoogleMessage(s, audio(), gws);
  assert.strictEqual(s.sends, 1);
  assert.strictEqual(vl.muteLiveTurn(s), true);
  assert.strictEqual(s.clears, 1);
  clock += 100;
  handleGoogleMessage(s, audio(), gws);
  handleGoogleMessage(s, said('Unheard part.'), gws);
  assert.strictEqual(s.sends, 1, 'muted audio is not forwarded');
  handleGoogleMessage(s, end('generationComplete'), gws);
  handleGoogleMessage(s, end('turnComplete'), gws);
  assert.deepStrictEqual(s.history.map((h) => h.content), ['Heard part.']);
  clock += 100;
  handleGoogleMessage(s, audio(), gws);
  assert.strictEqual(s.sends, 2, 'the next turn plays');
  handleGoogleMessage(s, end('turnComplete'), gws);
  assert.strictEqual(vl.muteLiveTurn(s), false, 'Stop between turns arms nothing');
});

test('interrupted lifts the mute', () => {
  const { s, gws } = mk();
  s._liveStartedAt = clock - 60000;
  handleGoogleMessage(s, audio(), gws);
  vl.muteLiveTurn(s);
  handleGoogleMessage(s, end('interrupted'), gws);
  clock += 50;
  handleGoogleMessage(s, audio(), gws);
  assert.strictEqual(s.sends, 2);
});

test('Stop, then a goAway resume mid-turn: the next answer on the new connection plays', () => {
  const { s, gws } = mk();
  handleGoogleMessage(s, audio(), gws);
  vl.muteLiveTurn(s);
  const ngws = new FakeGoogle();
  s._livePendingWs = ngws;
  handleGoogleMessage(s, setup(), ngws);
  assert.strictEqual(s._liveWs, ngws);
  clock += 1500;
  handleGoogleMessage(s, audio(), ngws);
  assert.strictEqual(s.sends, 2);
});

test('a turn cut by a resume leaves nothing open: Stop between turns does not swallow the next answer', () => {
  const { s, gws } = mk();
  handleGoogleMessage(s, audio(), gws);
  const ngws = new FakeGoogle();
  s._livePendingWs = ngws;
  handleGoogleMessage(s, setup(), ngws);
  clock += 1000;
  assert.strictEqual(vl.muteLiveTurn(s), false);
  clock += 1000;
  handleGoogleMessage(s, audio(), ngws);
  assert.strictEqual(s.sends, 2);
});

test('a lost turn end: the mute lifts at the next audio after a long gap', () => {
  const { s, gws } = mk();
  handleGoogleMessage(s, audio(), gws);
  vl.muteLiveTurn(s);
  clock += 200;
  handleGoogleMessage(s, audio(), gws);
  assert.strictEqual(s.sends, 1);
  clock += 20000;
  handleGoogleMessage(s, audio(), gws);
  assert.strictEqual(s.sends, 2);
});

test('stopLive leaves nothing muted or open', () => {
  const { s, gws } = mk();
  handleGoogleMessage(s, audio(), gws);
  vl.muteLiveTurn(s);
  vl.stopLive(s, 'hangup');
  assert.ok(!s._liveMuted && !s._liveTurnOpen);
});

test('LIVE_STOP_MUTE=0: Stop mutes nothing (the client flush alone, as before)', () => {
  process.env.LIVE_STOP_MUTE = '0';
  try {
    const { s, gws } = mk();
    handleGoogleMessage(s, audio(), gws);
    assert.strictEqual(vl.muteLiveTurn(s), false);
    clock += 100;
    handleGoogleMessage(s, audio(), gws);
    assert.strictEqual(s.sends, 2);
  } finally { delete process.env.LIVE_STOP_MUTE; }
});

test('the call socket\'s barge handler asks the Spotter lane to mute', () => {
  const src = fs.readFileSync(require.resolve('./voice-stream.js'), 'utf8').replace(/\r\n/g, '\n');
  const at = src.indexOf("if (msg.type === 'barge') {");
  const block = src.slice(at, src.indexOf('return;', at));
  assert.ok(block.includes('if (session.liveOn) { try { videoLive.muteLiveTurn(session); } catch {} }'));
});

/* Nov 13 2026 (sweep 1.4): with LIVE_STOP_NOTE=1 Google is told, once per muted turn, that the rest
 * was not heard. Off by default: nothing is sent. */
test('Stop tells the Spotter nothing by default; with LIVE_STOP_NOTE=1 it is told once per muted turn', () => {
  const texts = (gws) => gws.sent.map((d) => JSON.parse(d)).filter((m) => m.realtimeInput && typeof m.realtimeInput.text === 'string');
  {
    const { s, gws } = mk();
    handleGoogleMessage(s, audio(), gws);
    assert.strictEqual(vl.muteLiveTurn(s), true);
    assert.strictEqual(texts(gws).length, 0, 'default: nothing is written to Google');
  }
  process.env.LIVE_STOP_NOTE = '1';
  try {
    const { s, gws } = mk();
    handleGoogleMessage(s, audio(), gws);
    assert.strictEqual(vl.muteLiveTurn(s), true);
    assert.strictEqual(vl.muteLiveTurn(s), true, 'a second Stop in the same turn');
    assert.strictEqual(texts(gws).length, 1, 'told once');
    assert.strictEqual(texts(gws)[0].realtimeInput.text, vl.LIVE_STOP_NOTE);
    handleGoogleMessage(s, end('turnComplete'), gws);
    assert.strictEqual(vl.muteLiveTurn(s), false, 'no open turn: nothing muted, nothing told');
    assert.strictEqual(texts(gws).length, 1);
    handleGoogleMessage(s, audio(), gws);
    assert.strictEqual(vl.muteLiveTurn(s), true);
    assert.strictEqual(texts(gws).length, 2, 'the next muted turn is told again');
  } finally {
    delete process.env.LIVE_STOP_NOTE;
  }
});
