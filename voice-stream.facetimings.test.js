/* voice-stream.facetimings.test.js — Nov 11 2026.
 *
 * The website shows a character's face on a call and says so in its hello (`faces: true`).
 * The bridge then asks the voice proxy for Inworld's mouth shapes (x-kade-tts-timing: 1),
 * which come back inside the WAV as a `kdtm` chunk between fmt and data. Runs the REAL
 * module against a pretend voice proxy, so each test checks the header that actually left
 * the bridge. A phone call, a call with no face, and BRIDGE_FACE_TIMINGS=0 never ask.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');

delete process.env.DEEPGRAM_API_KEY; // no STT: nothing here may reach out
delete process.env.BRIDGE_FACE_TIMINGS;
process.env.PHONE_LLM_GREETING = '0';
process.env.KADE_CALL_INGEST_SECRET = 'face-test-secret';

const vs = require('./voice-stream.js');
const { CallSession, WebCallSession, handleUtterance, helloFaceTimings, wavDurationMs } = vs._test;
const { synthesize } = vs;

// fmt + an odd-sized kdtm chunk (padded to even, as RIFF wants) + 4800 bytes of data = 100 ms.
function wavWithTrack(trackJson) {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii'); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(24000, 12); fmt.writeUInt32LE(48000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  const body = Buffer.from(trackJson, 'utf8');
  const kdtm = Buffer.alloc(8 + body.length + (body.length % 2));
  kdtm.write('kdtm', 0, 'ascii'); kdtm.writeUInt32LE(body.length, 4); body.copy(kdtm, 8);
  const data = Buffer.alloc(8 + 4800);
  data.write('data', 0, 'ascii'); data.writeUInt32LE(4800, 4);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(4 + fmt.length + kdtm.length + data.length, 4); head.write('WAVE', 8, 'ascii');
  return Buffer.concat([head, fmt, kdtm, data]);
}
const TRACK_WAV = wavWithTrack('{"v":1,"set":"oxr","dur":100,"vis":[[0,100,"aa"]],"cov":[[0,100]]}x');

let heard = [];
const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    heard.push({ url: req.url, timing: req.headers['x-kade-tts-timing'], body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.end(req.url.includes('telephony=1') ? Buffer.alloc(160, 0xff) : TRACK_WAV);
  });
});

const sent = [];
const openWs = () => ({ readyState: WebSocket.OPEN, send(x) { sent.push(x); }, close() {}, on() {} });
const webUser = () => ({ agentId: 'a-one', agentName: 'One', lcEmail: 'x@example.test' });
const webCall = (faces) => {
  const s = new WebCallSession('web:x@example.test', webUser(), openWs(), global._vsConfig);
  s.faceTimings = helloFaceTimings(faces ? { type: 'hello', faces: true } : { type: 'hello' });
  return s;
};

test.before(async () => {
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  global._vsConfig = {
    ttsProxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    ttsModel: 'tts-1-mini',
    defaultVoice: 'Default',
    defaultAgent: 'a-one',
    defaultAgentName: 'One',
    users: new Map(),
    saveUsers() {},
    getAgentTts: () => null,
    getAgents: async () => [{ id: 'a-one', name: 'One' }],
    findVoice: () => null,
    getCallPlan: () => null,
    lookupVoicePref: async () => null,
    markCallAnswered() {},
  };
});
test.after(async () => { await new Promise((r) => proxy.close(r)); });
test.beforeEach(() => { heard = []; sent.length = 0; delete process.env.BRIDGE_FACE_TIMINGS; });

test('the hello asks only with faces: true, and the switch turns it off', () => {
  assert.strictEqual(helloFaceTimings({ faces: true }), true);
  for (const junk of [{}, { faces: 'true' }, { faces: 1 }, { faces: false }, null, undefined]) {
    assert.strictEqual(helloFaceTimings(junk), false, JSON.stringify(junk));
  }
  process.env.BRIDGE_FACE_TIMINGS = '0';
  assert.strictEqual(helloFaceTimings({ faces: true }), false);
});

test('synthesize sends the ask only for a WAV that wants it, never for the phone', async () => {
  await synthesize('Hello there.', 'Default', undefined, 'wav', undefined, { timing: true });
  await synthesize('Hello there.', 'Default', undefined, 'wav', undefined, { timing: false });
  await synthesize('Hello there.', 'Default', undefined, 'wav');
  await synthesize('Hello there.', 'Default', undefined, 'mulaw', undefined, { timing: true });
  assert.deepStrictEqual(heard.map((h) => h.timing), ['1', undefined, undefined, undefined]);
  assert.ok(heard[3].url.includes('telephony=1'));
  for (const h of heard) assert.ok(!('timing' in h.body), 'the ask is a header, the body is unchanged');
});

test('a web call with a face asks on what it says; without a face it does not', async () => {
  await handleUtterance(webCall(true), 'speak faster');
  assert.ok(heard.length >= 1);
  assert.ok(heard.every((h) => h.timing === '1'), JSON.stringify(heard.map((h) => h.timing)));
  heard = [];
  await handleUtterance(webCall(false), 'speak faster');
  assert.ok(heard.length >= 1);
  assert.ok(heard.every((h) => h.timing === undefined));
});

test('a phone call never asks, even if the flag were set', async () => {
  const s = new CallSession('CAx', 'MZx', '+15550100', { agentId: 'a-one', agentName: 'One' }, openWs(), global._vsConfig);
  s.faceTimings = true;
  await handleUtterance(s, 'speak faster');
  assert.ok(heard.length >= 1);
  assert.ok(heard.every((h) => h.timing === undefined && h.url.includes('telephony=1')));
});

test('a WAV carrying a kdtm chunk keeps its true length, and the client gets the bytes unchanged', async () => {
  assert.strictEqual(wavDurationMs(TRACK_WAV), 100);
  await handleUtterance(webCall(true), 'speak faster');
  const clips = sent.filter((x) => Buffer.isBuffer(x));
  assert.ok(clips.length >= 1);
  assert.ok(clips[0].equals(TRACK_WAV));
});

test('the web hello handler stores the ask on the session', () => {
  const src = require('fs').readFileSync(require.resolve('./voice-stream.js'), 'utf8');
  const hello = src.slice(src.indexOf("if (msg.type === 'hello' && !session)"), src.indexOf("session.targetConversationId ="));
  assert.ok(hello.includes('session.faceTimings = helloFaceTimings(msg);'), 'the hello reads faces');
});
