/* voice-stream.heardcut.test.js — Nov 11 2026. "Keep only what was heard", end to end.
 *
 * Runs the REAL streamReply against a pretend proxy (the model's reply as SSE tokens, and the
 * voice as WAV for app/web or mu-law for the phone), barges in part-way through, and checks what
 * the turn left in session.history (which is what memory, the next turn and the Call History
 * transcript are built from).
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');

delete process.env.DEEPGRAM_API_KEY;
delete process.env.BRIDGE_HEARD_ONLY;
process.env.PHONE_LLM_GREETING = '0';
process.env.KADE_CALL_INGEST_SECRET = 'heard-test-secret';

const vs = require('./voice-stream.js');
const { CallSession, WebCallSession, streamReply, bargeIn, amendHeardCut, noteTwilioMark } = vs._test;
const { CUT_MARK, CUT_NONE } = require('./heard-cut.js');

const S1 = 'Okay, here is the first thing I wanted to tell you about today.';
const S2 = 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima.';
const S3 = 'Mike november oscar papa quebec romeo sierra tango uniform victor.';
let REPLY = `${S1} ${S2} ${S3}`;
const CLIP_MS = 800;

function wavMs(ms) {
  const dataLen = 48 * ms; // 24 kHz, 16-bit mono = 48 bytes per ms
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(dataLen, 40);
  return b;
}

const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url.startsWith('/librechat/ask-stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const word of REPLY.split(/(?<= )/)) res.write(`data: ${JSON.stringify({ token: word })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    if (req.url.includes('telephony=1')) { res.end(Buffer.alloc(8 * CLIP_MS, 0xff)); return; } // 8 bytes per ms
    res.end(wavMs(CLIP_MS));
  });
});

const sent = [];
const openWs = (onSend) => ({ readyState: WebSocket.OPEN, send(x) { sent.push(x); if (onSend) onSend(x); }, close() {}, on() {} });
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); }
};
const lastAssistant = (s) => [...s.history].reverse().find((m) => m.role === 'assistant');

test.before(async () => {
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${proxy.address().port}`;
  global._vsConfig = {
    proxyUrl: url, proxySecret: 'x', ttsProxyUrl: url, ttsModel: 'tts-1-mini',
    defaultVoice: 'Default', defaultAgent: 'a-one', defaultAgentName: 'One',
    users: new Map(), saveUsers() {}, getAgentTts: () => null,
    getAgents: async () => [{ id: 'a-one', name: 'One' }], findVoice: () => null,
    getCallPlan: () => null, lookupVoicePref: async () => null, markCallAnswered() {},
  };
});
test.after(async () => { await new Promise((r) => proxy.close(r)); });
test.beforeEach(() => { sent.length = 0; delete process.env.BRIDGE_HEARD_ONLY; REPLY = `${S1} ${S2} ${S3}`; });

const webSession = () => new WebCallSession('web:x@example.test', { agentId: 'a-one', agentName: 'One', lcEmail: 'x@example.test' }, openWs(), global._vsConfig);

async function bargeWebAt(s, pieceIndex, msInto) {
  await until(() => s._turnUnits && s._turnUnits[pieceIndex] && s._turnUnits[pieceIndex].startEst);
  const u = s._turnUnits[pieceIndex];
  await until(() => Date.now() >= u.startEst + msInto);
  s.bargedIn = true;
  bargeIn(s);
  return u;
}

test('app/web: a barge-in mid-piece keeps the pieces heard, trims the cut one, drops the rest', async () => {
  const s = webSession();
  const turn = streamReply(s, 'Tell me two things.');
  await bargeWebAt(s, 1, 300);
  await turn;
  const a = lastAssistant(s);
  assert.ok(a.content.startsWith(S1), a.content);
  assert.ok(a.content.endsWith(CUT_MARK), a.content);
  assert.ok(a.content.includes('Alpha'), 'some of the cut piece was heard');
  assert.ok(!a.content.includes('lima'), 'the end of the cut piece was not');
  assert.ok(!a.content.includes('victor'), 'a piece that never started is dropped');
  assert.strictEqual(a.heardCut, true);
  assert.strictEqual(a.generatedChars, REPLY.trim().length, 'billing still sees what was written');
});

test('app/web: a barge-in while the turn is still running (the abort path) trims the first piece', async () => {
  const s = webSession();
  const turn = streamReply(s, 'Tell me two things.');
  await bargeWebAt(s, 0, 150); // the next piece ships only 600 ms before this one ends, at +200
  await turn;
  const a = lastAssistant(s);
  assert.ok(a.content.startsWith('Okay,'), a.content);
  assert.ok(!a.content.includes('today'), a.content);
  assert.ok(a.content.endsWith(CUT_MARK), a.content);
  assert.strictEqual(s._lastCut.units.length, 1, 'the second piece never went out');
});

test('app/web: the client report corrects the stored turn, even when it lands after the turn', async () => {
  const s = webSession();
  const turn = streamReply(s, 'Tell me two things.');
  const u2 = await bargeWebAt(s, 1, 300);
  await turn;
  const u1 = s._lastCut.units[0];
  // The client says it was only 40% into the FIRST clip when it stopped (its audio ran late).
  s._heardReport = { seq: u1.seq, ms: Math.round(CLIP_MS * 0.4), at: Date.now() };
  amendHeardCut(s);
  const a = lastAssistant(s);
  assert.ok(!a.content.includes('Alpha'), a.content);
  assert.ok(a.content.startsWith('Okay, here is'), a.content);
  assert.ok(!a.content.includes('today'), a.content);
  assert.ok(a.content.endsWith(CUT_MARK));
  // And a report that the second clip had played whole while the model was done: nothing cut.
  s._heardReport = { seq: u2.seq + 1, ms: 0, at: Date.now() + 1 };
  amendHeardCut(s);
  assert.strictEqual(lastAssistant(s).content, REPLY.trim());
  assert.strictEqual(lastAssistant(s).heardCut, undefined);
});

test('app/web: a turn nobody interrupted is stored exactly as before', async () => {
  const s = webSession();
  await streamReply(s, 'Tell me two things.');
  const a = lastAssistant(s);
  assert.strictEqual(a.content, REPLY.trim());
  assert.strictEqual(a.heardCut, undefined);
});

test('BRIDGE_HEARD_ONLY=0 stores the whole reply on a barge-in (the old behaviour)', async () => {
  process.env.BRIDGE_HEARD_ONLY = '0';
  const s = webSession();
  const turn = streamReply(s, 'Tell me two things.');
  await bargeWebAt(s, 1, 300);
  await turn;
  assert.strictEqual(lastAssistant(s).content, REPLY.trim());
});

test('a copied "(cut off ...)" in the model\'s reply is never sent to the voice', async () => {
  REPLY = `${S1} ${CUT_MARK} ${S2}`;
  const s = webSession();
  await streamReply(s, 'Go on.');
  assert.ok(!sent.filter((x) => typeof x === 'string').some((x) => x.includes('cut off')), 'not in captions');
});

test('phone: Twilio marks follow each piece; the cut piece is timed from the mark before it', async () => {
  let s;
  const ws = openWs((x) => {
    if (typeof x !== 'string') return;
    const m = JSON.parse(x);
    // Pretend Twilio: echo each mark once the audio before it would have played.
    if (m.event === 'mark') setTimeout(() => { if (!s._lastClearAt) noteTwilioMark(s, m.mark.name); }, CLIP_MS);
  });
  s = new CallSession('CAx', 'MZx', '+15550100', { agentId: 'a-one', agentName: 'One' }, ws, global._vsConfig);
  const turn = streamReply(s, 'Tell me two things.');
  await until(() => s._turnUnits && s._turnUnits[1] && s._turnUnits[1].sendAt);
  await until(() => Date.now() >= s._turnUnits[1].sendAt + 300);
  s.bargedIn = true;
  bargeIn(s);
  await turn;
  const marks = sent.filter((x) => typeof x === 'string').map((x) => JSON.parse(x)).filter((m) => m.event === 'mark');
  assert.ok(marks.length >= 1 && marks.every((m) => /^kh-\d+$/.test(m.mark.name) && m.streamSid === s.streamSid), JSON.stringify(marks));
  const a = lastAssistant(s);
  assert.ok(a.content.startsWith(S1), a.content);
  assert.ok(a.content.includes('Alpha'), a.content);
  assert.ok(!a.content.includes('lima'), a.content);
  assert.ok(a.content.endsWith(CUT_MARK));
  assert.strictEqual(s._lastCut.units[0].heard, 'whole', 'the first piece is whole by its mark');
});

test('phone: a barge before any piece played stores the marker alone', async () => {
  const s = new CallSession('CAy', 'MZy', '+15550100', { agentId: 'a-one', agentName: 'One' }, openWs(), global._vsConfig);
  const turn = streamReply(s, 'Hello?');
  await until(() => s._turnUnits && s._turnUnits[0] && s._turnUnits[0].sendAt);
  s.bargedIn = true;
  bargeIn(s); // the instant the first piece went out: nothing has played yet
  await turn;
  assert.strictEqual(lastAssistant(s).content, CUT_NONE);
});

test('the voice_chat estimate bills the written length of a cut turn', () => {
  const src = require('fs').readFileSync(require.resolve('./voice-stream.js'), 'utf8');
  const body = src.slice(src.indexOf('async function postVoiceChatUsage(session) {'), src.indexOf('async function postWebVoiceUsage'));
  assert.ok(body.includes('Math.max(len, Number(m.generatedChars) || 0)'));
});

test('the web socket accepts the heard report', () => {
  const src = require('fs').readFileSync(require.resolve('./voice-stream.js'), 'utf8').replace(/\r\n/g, '\n');
  const at = src.indexOf("if (msg.type === 'heard') {");
  assert.ok(at > src.indexOf('function attachWebVoice'), 'in the web voice handler');
  const block = src.slice(at, src.indexOf("if (msg.type === 'barge') {", at));
  assert.ok(block.includes('session._heardReport = { seq, ms:'));
  assert.ok(block.includes('amendHeardCut(session);'));
});
