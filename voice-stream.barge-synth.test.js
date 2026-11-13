/* voice-stream.barge-synth.test.js — Nov 12 2026 (platform audit GW-11, GW-10, GW-5).
 *
 * GW-11: a turn abandoned while a speech clip is still being made used to wait for that clip
 * (up to the 25 s socket bound) before the correction could start. Now the clip's request is
 * closed and the turn ends at once.
 * GW-10: the first piece of a phone turn is played as it arrives (synthesizeStream +
 * playMulawStream), and a buffered answer from a proxy without the stream lane still plays.
 * GW-5: a greeting the timeout gave up on closes its request instead of running on.
 *
 * Same fakes as voice-stream.heardcut.test.js: a pretend proxy on a local port, no network.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');

delete process.env.DEEPGRAM_API_KEY;
delete process.env.BRIDGE_HEARD_ONLY;
delete process.env.PHONE_STREAM_FIRST;
process.env.PHONE_LLM_GREETING = '0';
process.env.PHONE_GREETING_TIMEOUT_MS = '300'; // the GW-5 greeting case gives up fast
process.env.KADE_CALL_INGEST_SECRET = 'barge-synth-test-secret';

const vs = require('./voice-stream.js');
const { CallSession, WebCallSession, streamReply, streamPost, synthesizeStream, playMulawStream, fetchLlmOpener } = vs._test;
const { CUT_NONE } = require('./heard-cut.js');

const S1 = 'Okay, here is the first thing I wanted to tell you about today.';
const S2 = 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey.';
const S3 = 'Xray yankee zulu and then some more words so the second piece is long enough to ship on its own today.';
const REPLY = `${S1} ${S2} ${S3}`;
const CLIP_MS = 300;

function wavMs(ms) {
  const dataLen = 48 * ms;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(dataLen, 40);
  return b;
}

// What the pretend proxy does with each TTS request, in order: 'now' answers at once,
// 'hold' answers after 3 s (and records when its socket closed).
let ttsPlan = [];
let ttsSeen = [];
let askMode = 'reply'; // 'reply' | 'hang' (never answers: a greeting that is too slow)
let askSeen = [];
const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url.startsWith('/librechat/ask-stream')) {
      const rec = { at: Date.now(), closedAt: 0 };
      askSeen.push(rec);
      res.on('close', () => { rec.closedAt = Date.now(); });
      if (askMode === 'hang') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const word of REPLY.split(/(?<= )/)) res.write(`data: ${JSON.stringify({ token: word })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    const phone = req.url.includes('telephony=1');
    const rec = { at: Date.now(), closedAt: 0, streamHeader: req.headers['x-kade-tts-stream'] === '1', phone };
    ttsSeen.push(rec);
    res.on('close', () => { rec.closedAt = Date.now(); });
    const how = ttsPlan.shift() || 'now';
    const body = phone ? Buffer.alloc(8 * CLIP_MS, 0xff) : wavMs(CLIP_MS);
    if (how === 'hold') { setTimeout(() => { try { res.end(body); } catch {} }, 3000); return; }
    res.end(body);
  });
});

const sent = [];
const openWs = () => ({ readyState: WebSocket.OPEN, send(x) { sent.push(x); }, close() {}, on() {} });
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); }
};
let errors = [];
const realError = console.error;

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
  console.error = (...a) => { errors.push(a.join(' ')); realError(...a); };
});
test.after(async () => { console.error = realError; proxy.closeAllConnections(); await new Promise((r) => proxy.close(r)); });
test.beforeEach(() => { sent.length = 0; ttsPlan = []; ttsSeen = []; askSeen = []; askMode = 'reply'; errors = []; });

const webSession = () => new WebCallSession('web:x@example.test', { agentId: 'a-one', agentName: 'One', lcEmail: 'x@example.test' }, openWs(), global._vsConfig);

test('GW-11: an abort while a clip is still being made ends the turn at once and closes that request', async () => {
  const s = webSession();
  ttsPlan = ['now', 'hold', 'hold'];
  const turn = streamReply(s, 'Tell me three things.');
  await until(() => ttsSeen.length >= 2);
  const t0 = Date.now();
  s.llmAbort = true; // what a correction while busy (or the keypad, or Stop) sets
  await turn;
  const took = Date.now() - t0;
  assert.ok(took < 400, `the turn waited ${took} ms for an abandoned clip`);
  await until(() => ttsSeen[1].closedAt > 0, 1000);
  assert.ok(ttsSeen[1].closedAt - t0 < 400, 'the held request saw its socket close');
  assert.ok(!errors.some((e) => e.includes('synthesis prefetch error')), 'an abandoned piece is not an error: ' + errors.join(' | '));
  assert.strictEqual(s.llmAbort, false, 'the next turn starts clean');
  const a = [...s.history].reverse().find((m) => m.role === 'assistant');
  assert.ok(a && (a.heardCut === true || a.content === CUT_NONE), 'the turn is stored as a heard-cut entry: ' + (a && a.content));
});

test('GW-11: with no abort, every clip plays in order, as before', async () => {
  const s = webSession();
  await streamReply(s, 'Tell me three things.');
  const clips = sent.filter((x) => Buffer.isBuffer(x));
  assert.strictEqual(clips.length, ttsSeen.length);
  assert.ok(ttsSeen.length >= 2);
  assert.ok(!errors.some((e) => e.includes('synthesis prefetch error')));
  const a = [...s.history].reverse().find((m) => m.role === 'assistant');
  assert.strictEqual(a.content, REPLY);
});

test('GW-11: streamPost with an aborted signal never sends, and a late abort of a finished request touches nothing', async () => {
  const url = global._vsConfig.ttsProxyUrl;
  const ac = new AbortController(); ac.abort();
  await assert.rejects(streamPost(`${url}/v1/audio/speech`, {}, { input: 'x' }, ac.signal), { name: 'AbortError' });
  const ac2 = new AbortController();
  const res = await streamPost(`${url}/v1/audio/speech`, {}, { input: 'x' }, ac2.signal);
  await new Promise((r) => { res.resume(); res.on('end', r); });
  ac2.abort(); // nothing left to cut
  assert.strictEqual(res.complete, true);
});

test('GW-10: the phone opener asks for the stream lane; a buffered answer (proxy without it) still plays whole', async () => {
  const s = new CallSession('CAs', 'MZs', '+15550100', { agentId: 'a-one', agentName: 'One' }, openWs(), global._vsConfig);
  await streamReply(s, 'Tell me three things.');
  const phoneReqs = ttsSeen.filter((r) => r.phone);
  assert.ok(phoneReqs.length >= 2);
  assert.strictEqual(phoneReqs[0].streamHeader, true, 'the first piece asks to stream');
  assert.ok(phoneReqs.slice(1).every((r) => !r.streamHeader), 'later pieces stay buffered');
  const media = sent.filter((x) => typeof x === 'string').map((x) => JSON.parse(x)).filter((m) => m.event === 'media');
  const bytes = media.reduce((n, m) => n + Buffer.from(m.media.payload, 'base64').length, 0);
  assert.strictEqual(bytes, phoneReqs.length * 8 * CLIP_MS, 'every byte of every piece went to Twilio');
});

test('GW-10: PHONE_STREAM_FIRST=0 is read at load; the switch is documented in the code', () => {
  const src = require('fs').readFileSync(require.resolve('./voice-stream.js'), 'utf8');
  assert.ok(src.includes("const PHONE_STREAM_FIRST = process.env.PHONE_STREAM_FIRST !== '0';"));
  assert.ok(src.includes("const streamIt = how.first === true && PHONE_STREAM_FIRST && session.media === 'mulaw';"));
});

/* playMulawStream with a fake session and feed (the audit's verify step 4). */
function fakePhone() {
  const s = { ws: { readyState: WebSocket.OPEN }, media: 'mulaw', streamSid: 'MZf', frames: [], marks: [],
    sendMedia(b) { s.frames.push(Buffer.from(b)); }, twSend(m) { s.marks.push(m); } };
  return s;
}
function fakeFeed() {
  const f = { queue: [], ended: false, failed: null, wake: null, destroyed: false,
    destroy() { f.destroyed = true; f.ended = true; f.queue.length = 0; } };
  f.push = (b) => { f.queue.push(b); const w = f.wake; f.wake = null; if (w) w(); };
  f.end = (err) => { if (err) f.failed = err; f.ended = true; const w = f.wake; f.wake = null; if (w) w(); };
  return f;
}

test('GW-10: 1,000 bytes in three pieces -> 7 frames, 0xFF padding, 140 ms, one mark; nothing lost before playback starts', async () => {
  const s = fakePhone();
  const feed = fakeFeed();
  const unit = { raw: 'x' };
  feed.push(Buffer.alloc(400, 1));             // the first piece lands...
  await new Promise((r) => setTimeout(r, 120)); // ...and playback starts 120 ms later (the filler's clear)
  const play = playMulawStream(s, feed, { unit });
  setTimeout(() => feed.push(Buffer.alloc(300, 2)), 30);
  setTimeout(() => { feed.push(Buffer.alloc(300, 3)); feed.end(); }, 60);
  await play;
  assert.strictEqual(s.frames.length, 7);
  const all = Buffer.concat(s.frames);
  assert.strictEqual(all.subarray(0, 1000).filter((b) => b === 0).length, 0, 'no byte missing');
  assert.ok(all.subarray(1000).every((b) => b === 0xff), 'the last frame is padded with true silence');
  assert.strictEqual(unit.durMs, 140);
  assert.strictEqual(s.marks.length, 1);
  assert.strictEqual(s.isSpeaking, false);
  assert.strictEqual(feed.destroyed, false);
});

test('GW-10: a barge-in mid-opener stops at once, sends no mark, releases the stream and keeps the whole length', async () => {
  const s = fakePhone();
  const feed = fakeFeed();
  const unit = { raw: 'x' };
  feed.push(Buffer.alloc(16000, 1)); // a 2 s clip, all arrived
  feed.end();
  const play = playMulawStream(s, feed, { unit });
  setTimeout(() => { s.llmAbort = true; }, 250);
  await play;
  assert.strictEqual(s.marks.length, 0);
  assert.strictEqual(feed.destroyed, true);
  assert.strictEqual(unit.durMs, 2000);
  assert.ok(s.frames.length < 100);
});

test('GW-10: an error mid-clip ends playback without a hang', async () => {
  const s = fakePhone();
  const feed = fakeFeed();
  feed.push(Buffer.alloc(800, 1));
  const play = playMulawStream(s, feed, { unit: { raw: 'hello there' } });
  setTimeout(() => feed.end(new Error('reset')), 50);
  await Promise.race([play, new Promise((_, rej) => setTimeout(() => rej(new Error('hung')), 3000))]);
  assert.strictEqual(s.frames.length, 5);
});

test('GW-10: synthesizeStream resolves a feed on the first chunk, null on an empty body, rejects on 500 and on a reset', async () => {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const mode = global.__mode;
      if (mode === 'chunked') { res.writeHead(200, { 'Content-Type': 'audio/basic' }); res.write(Buffer.alloc(160, 1)); setTimeout(() => res.end(Buffer.alloc(160, 2)), 100); }
      else if (mode === 'empty') { res.writeHead(200, { 'Content-Length': 0 }); res.end(); }
      else if (mode === '500') { res.writeHead(500); res.end('boom'); }
      else if (mode === 'reset') { req.socket.destroy(); }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const saved = global._vsConfig.ttsProxyUrl;
  global._vsConfig.ttsProxyUrl = `http://127.0.0.1:${srv.address().port}`;
  try {
    global.__mode = 'chunked';
    const feed = await synthesizeStream('Hello there.', 'V', 1, null);
    assert.ok(feed && feed.queue.length === 1 && !feed.ended);
    await until(() => feed.ended, 2000);
    assert.strictEqual(feed.bytes, 320);
    assert.strictEqual(feed.failed, null);
    global.__mode = 'empty';
    assert.strictEqual(await synthesizeStream('Hi.', 'V', 1, null), null);
    global.__mode = '500';
    await assert.rejects(synthesizeStream('Hi.', 'V', 1, null), /TTS proxy 500/);
    global.__mode = 'reset';
    await assert.rejects(synthesizeStream('Hi.', 'V', 1, null));
  } finally {
    global._vsConfig.ttsProxyUrl = saved;
    delete global.__mode;
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});

test('GW-5: a greeting the timeout gave up on closes its request (the proxy then stops the site job)', async () => {
  askMode = 'hang';
  const s = new CallSession('CAg', 'MZg', '+15550100', { agentId: 'a-one', agentName: 'One' }, openWs(), global._vsConfig);
  const t0 = Date.now();
  const line = await fetchLlmOpener(s, { name: 'Pat' });
  assert.strictEqual(line, null);
  await until(() => askSeen.length === 1 && askSeen[0].closedAt > 0, 2000);
  assert.ok(askSeen[0].closedAt - t0 < 1500, 'closed when the timeout fired, not left running');
});

/* Nov 13 2026 (sweep 1.3): a streamed opener that stops arriving mid-sentence is given up after
 * PHONE_STREAM_STALL_MS (2500) instead of holding the line silent until a 20 s clock, and a piece that was
 * cut short is no longer recorded as fully heard. */
test('sweep 1.3: a feed that stalls mid-piece is cut after the stall limit: no mark, the stream released, not counted as whole', async () => {
  const s = fakePhone();
  const feed = fakeFeed();
  const unit = { raw: 'So the thing about your fence is that it leans.' };
  feed.push(Buffer.alloc(800, 1)); // 100 ms of audio, then nothing, and the feed never ends
  const t0 = Date.now();
  await Promise.race([playMulawStream(s, feed, { unit }), new Promise((_, rej) => setTimeout(() => rej(new Error('still waiting after 6 s')), 6000))]);
  const took = Date.now() - t0;
  assert.ok(took >= 2400 && took < 4500, `gave up after ${took} ms`);
  assert.strictEqual(s.frames.length, 5, 'what arrived was played');
  assert.strictEqual(s.marks.length, 0, 'no heard mark for a piece that was cut');
  assert.strictEqual(feed.destroyed, true, 'the proxy is let go');
  assert.strictEqual(s.isSpeaking, false, 'the line is free for the next sentence');
  assert.ok(unit.durMs >= unit.raw.length * 60, 'the piece keeps its whole estimated length, so it is never taken as fully heard');
});

test('sweep 1.3: a slow feed that keeps arriving is never cut, and audio still buffered is never cut', async () => {
  const s = fakePhone();
  const feed = fakeFeed();
  const unit = { raw: 'x' };
  feed.push(Buffer.alloc(160, 1));
  const play = playMulawStream(s, feed, { unit });
  // A piece every 900 ms for 3.6 s: each gap is under the limit, the total is well over it.
  for (let i = 1; i <= 4; i++) setTimeout(() => { feed.push(Buffer.alloc(160, 1)); if (i === 4) feed.end(); }, i * 900);
  await play;
  assert.strictEqual(s.frames.length, 5);
  assert.strictEqual(s.marks.length, 1, 'played whole');
  assert.strictEqual(feed.destroyed, false);
});

test('sweep 1.3: a feed that ends on an error is recorded as cut short, not as heard', async () => {
  const s = fakePhone();
  const feed = fakeFeed();
  const unit = { raw: 'hello there, this was going to be a longer sentence' };
  feed.push(Buffer.alloc(800, 1));
  const play = playMulawStream(s, feed, { unit });
  setTimeout(() => feed.end(new Error('cut off before its end')), 50);
  await play;
  assert.strictEqual(s.frames.length, 5, 'what arrived still plays, padded');
  assert.strictEqual(s.marks.length, 0);
  assert.ok(unit.durMs >= unit.raw.length * 60);
});

test('sweep 1.3: the switch is read at load and documented in the code', () => {
  const src = require('fs').readFileSync(require.resolve('./voice-stream.js'), 'utf8');
  assert.ok(src.includes("parseInt(process.env.PHONE_STREAM_STALL_MS ?? '', 10)"));
  assert.ok(src.includes('complete = !(PHONE_STREAM_STALL_MS > 0 && feed.failed);'));
});
