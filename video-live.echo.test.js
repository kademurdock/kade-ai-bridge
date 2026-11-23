/* video-live.echo.test.js — Nov 22 2026, the Spotter echo guard. Kade: "spotter is talking over
 * itself upon first call answer, it's hearing itself talk through the speaker". Her call (01:45Z):
 * she asked "What flavor is this?", Whittney began "That flavor is Watermelon Slice…", our
 * transcriber logged "That flavor?" as her next turn 2.4 s in, and Google, hearing the same mic,
 * cut the answer off and gave another. Fake Google socket, mocked clock, no network. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'vlive-echo-'));
delete process.env.KADE_USAGE_EVENT_SECRET; // nothing reaches the network here
delete process.env.DEEPGRAM_API_KEY;
delete process.env.LIVE_ECHO_GUARD;
delete process.env.LIVE_ECHO_TAIL_MS;
delete process.env.LIVE_GREETING_GRACE_MS;

const vl = require('./video-live');
const vs = require('./voice-stream.js');
const { handleGoogleMessage, spotterAudible } = vl._test;
const { liveEchoOfSpotter, liveCallerOverSpotter, handleUtterance } = vs._test;

class FakeGoogle {
  constructor() { this.readyState = 1; this.sent = []; }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() {}
  on() {}
  // What Google heard: each audio chunk as 'mic' (real) or 'quiet' (all zeros).
  heard() {
    return this.sent.filter((m) => m.realtimeInput && m.realtimeInput.audio).map((m) => {
      const b = Buffer.from(m.realtimeInput.audio.data, 'base64');
      return b.every((x) => x === 0) ? 'quiet' : 'mic';
    });
  }
}
let clock = 1e12;
test.beforeEach((t) => { t.mock.method(Date, 'now', () => clock); });

function mk() {
  const gws = new FakeGoogle();
  const s = { userId: 'u1', liveOn: true, _liveWs: gws, history: [], clears: 0, _liveStartedAt: clock,
    ws: { readyState: 1, send() {} }, sendClear() { s.clears++; }, jsonSend() {} };
  return { s, gws };
}
const msg = (o) => Buffer.from(JSON.stringify(o));
// `ms` of the Spotter's 24 kHz PCM16 voice (48 bytes a millisecond).
const spotter = (ms) => msg({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(ms * 48, 1).toString('base64') } }] } } });
const said = (t) => msg({ serverContent: { outputTranscription: { text: t } } });
const end = (k) => msg({ serverContent: { [k]: true } });
// 100 ms of her mic (16 kHz PCM16), loud enough to be a voice.
function mic(s) {
  const pcm = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) pcm.writeInt16LE(i % 2 ? 3000 : -3000, i * 2);
  vl.forwardAudio(s, pcm.toString('base64'), pcm);
}

test('HER CALL: while the Spotter answers, Google hears silence, not its own voice coming back', () => {
  const { s, gws } = mk();
  mic(s); // her question, before any answer: Google hears her
  clock += 100;
  handleGoogleMessage(s, said('That flavor is Watermelon Slice. '), gws);
  handleGoogleMessage(s, spotter(3000), gws); // three seconds of answer queued on the phone
  for (let i = 0; i < 20; i++) { mic(s); clock += 100; } // two seconds of the answer in the mic
  assert.deepStrictEqual(gws.heard(), ['mic', ...Array(20).fill('quiet')]);
  assert.ok(spotterAudible(s), 'still a second of answer left');
});

test('the guard covers the end of the answer plus the tail, then the mic is raw again', () => {
  const { s, gws } = mk();
  handleGoogleMessage(s, spotter(1000), gws);
  clock += 1000 + 600; // the answer is done; inside the 700 ms tail
  mic(s);
  clock += 200; // past the tail
  mic(s);
  assert.deepStrictEqual(gws.heard(), ['quiet', 'mic']);
});

test('chunks queue back to back: a second chunk extends the answer, it does not restart it', () => {
  const { s, gws } = mk();
  handleGoogleMessage(s, spotter(1000), gws);
  clock += 200;
  handleGoogleMessage(s, spotter(1000), gws); // plays from 1000 to 2000, not 200 to 1200
  clock += 1700; // 1900 ms in: the second chunk is still playing
  mic(s);
  assert.deepStrictEqual(gws.heard(), ['quiet']);
});

test('BARGE-IN STILL WORKS: her own words open the mic, and the kept second and a half is replayed first', () => {
  const { s, gws } = mk();
  handleGoogleMessage(s, said('That flavor is Watermelon Slice.'), gws);
  handleGoogleMessage(s, spotter(4000), gws);
  for (let i = 0; i < 20; i++) { mic(s); clock += 100; } // 2 s guarded; only the last 1.5 s is kept
  liveCallerOverSpotter(s, 'wait what about this one'); // the transcriber hears her
  assert.strictEqual(s._liveEchoOpen, true);
  mic(s);
  const heard = gws.heard();
  assert.deepStrictEqual(heard.slice(0, 20), Array(20).fill('quiet'));
  const replayed = heard.slice(20, -1);
  assert.ok(replayed.length >= 14 && replayed.length <= 16, `about 1.5 s replayed (got ${replayed.length} chunks)`);
  assert.ok(replayed.every((h) => h === 'mic'));
  assert.strictEqual(heard[heard.length - 1], 'mic', 'and the mic stays open for the rest of this answer');
});

test('a lone "stop" opens it too; a lone word that is not a barge word does not', () => {
  const a = mk();
  handleGoogleMessage(a.s, spotter(3000), a.gws);
  liveCallerOverSpotter(a.s, 'okay');
  assert.ok(!a.s._liveEchoOpen, '"okay" alone is not a barge-in');
  liveCallerOverSpotter(a.s, 'Stop.');
  assert.strictEqual(a.s._liveEchoOpen, true);
});

test('HER ECHO: "That flavor?" while it says "That flavor is Watermelon Slice" keeps the mic shut and stays out of her transcript', async () => {
  const { s, gws } = mk();
  handleGoogleMessage(s, said("That flavor is Watermelon Slice. It looks like it's an Indica strain, too."), gws);
  handleGoogleMessage(s, spotter(4000), gws);
  clock += 2400;
  assert.strictEqual(liveEchoOfSpotter(s, 'That flavor?'), true);
  liveCallerOverSpotter(s, 'That flavor?');
  assert.ok(!s._liveEchoOpen, 'its own words never open the mic');
  liveCallerOverSpotter(s, 'Watermelon'); // a lone word it is saying, even one that could be a barge word
  assert.ok(!s._liveEchoOpen);
  await handleUtterance(s, 'That flavor?');
  assert.deepStrictEqual(s.history, [], 'an echo is not a caller turn');
  await handleUtterance(s, 'Okay. Thank you.');
  assert.deepStrictEqual(s.history.map((h) => h.content), ['Okay. Thank you.'], 'her own words still land');
  assert.strictEqual(s._liveEcho.echoTurns, 1);
});

test('an echo heard just after the turn closed is still recognised (the last turns are kept)', async () => {
  const { s, gws } = mk();
  handleGoogleMessage(s, said('That one is Watermelon Ice.'), gws);
  handleGoogleMessage(s, spotter(1500), gws);
  handleGoogleMessage(s, end('turnComplete'), gws);
  clock += 1500 + 1200; // the transcriber closes its turn about a second later
  assert.strictEqual(liveEchoOfSpotter(s, 'Watermelon Ice'), true);
  clock += 2000; // long after: words are only words
  assert.strictEqual(liveEchoOfSpotter(s, 'Watermelon Ice'), false);
});

test('Google cutting the Spotter off flushes the phone, and the guard ends with the flushed audio', () => {
  const { s, gws } = mk();
  clock += 6000; // past the greeting grace
  handleGoogleMessage(s, spotter(5000), gws);
  clock += 1000;
  handleGoogleMessage(s, end('interrupted'), gws);
  assert.strictEqual(s.clears, 1);
  clock += 800; // past the tail of what had actually played
  mic(s);
  assert.deepStrictEqual(gws.heard(), ['mic']);
});

test('Stop pressed: the flushed answer is not guarded past its tail', () => {
  const { s, gws } = mk();
  handleGoogleMessage(s, spotter(5000), gws);
  clock += 500;
  assert.strictEqual(vl.muteLiveTurn(s), true);
  clock += 800;
  mic(s);
  assert.deepStrictEqual(gws.heard(), ['mic']);
});

test('a new answer guards again after the caller opened the mic on the last one', () => {
  const { s, gws } = mk();
  handleGoogleMessage(s, spotter(1000), gws);
  liveCallerOverSpotter(s, 'hold on a second');
  assert.strictEqual(s._liveEchoOpen, true);
  clock += 3000;
  handleGoogleMessage(s, spotter(1000), gws);
  assert.strictEqual(s._liveEchoOpen, false);
  mic(s);
  assert.deepStrictEqual(gws.heard().slice(-1), ['quiet']);
});

test('LIVE_ECHO_GUARD=0 sends the raw mic as before', (t) => {
  process.env.LIVE_ECHO_GUARD = '0';
  t.after(() => { delete process.env.LIVE_ECHO_GUARD; });
  const { s, gws } = mk();
  handleGoogleMessage(s, spotter(3000), gws);
  mic(s);
  assert.deepStrictEqual(gws.heard(), ['mic']);
  assert.strictEqual(vl.openEchoGate(s), false);
});

test('hang-up logs one summary line with how loud the Spotter came back, then starts clean', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (l) => lines.push(String(l)));
  const { s, gws } = mk();
  handleGoogleMessage(s, spotter(2000), gws);
  for (let i = 0; i < 10; i++) { mic(s); clock += 100; }
  vl.stopLive(s, 'hangup');
  const line = lines.find((l) => l.includes('echo guard:') && l.includes('held'));
  assert.ok(line, 'summary logged');
  assert.match(line, /1\.0s of mic held/);
  assert.match(line, /1\.0s of it voice-loud \(peak RMS 3000\)/);
  assert.strictEqual(s._livePlayUntil, 0);
  assert.strictEqual(s._liveEcho, null);
});
