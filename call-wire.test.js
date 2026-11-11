'use strict';
/* call-wire.test.js — Nov 10 2026. The call socket gate, the call limits and the listening keeper,
 * through the REAL voice-stream.js on a real local socket.
 *
 * What is real: the bridge's own /ws/media handler, CallSession, the greeting, synthesize,
 * playBuffer, handleUtterance, the turn loop, and every line this lane added to them.
 * What is fake, all on 127.0.0.1: the phone company (a ws client that speaks Twilio's stream
 * messages), the voice proxy (returns a short clip and writes down what it was asked to say), the
 * model proxy (answers one sentence), Deepgram (a ws server this file can make "hear" words or
 * drop), and Twilio's REST lookup and hang-up (functions). Nothing paid, nothing leaves the PC.
 *
 * Limits are set in milliseconds here through cfg.callLimits; in production they come from the
 * environment in minutes (call-limits.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');
const RealWebSocket = require('ws');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'call-wire-'));
process.env.DEEPGRAM_API_KEY = 'offline-test';
process.env.PHONE_LLM_GREETING = '0';
process.env.PHONE_BARGE_RECOVERY_MS = '500'; // the "go ahead, I'm listening" line, sooner than its 6 s
process.env.KADE_SPEECH_SECRET = 'offline';
delete process.env.KADE_USAGE_EVENT_SECRET;
delete process.env.KADE_CALL_INGEST_SECRET;

// ── fake Deepgram: voice-stream opens wss://api.deepgram.com/...; send that to a local server ──
const dg = { port: 0, conns: [], server: null };
class RedirectedWebSocket extends RealWebSocket {
  constructor(url, ...rest) {
    super(String(url).startsWith('wss://api.deepgram.com') ? String(url).replace('wss://api.deepgram.com', `ws://127.0.0.1:${dg.port}`) : url, ...rest);
  }
}
const realLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'ws' ? RedirectedWebSocket : realLoad.call(this, request, ...rest); };
const vs = require('./voice-stream');
Module._load = realLoad;
const { createCallSocketGate } = require('./call-socket-gate');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(25); }
  throw new Error(`not within ${ms} ms: ${what}`);
}

const SID = (n) => 'CA' + String(n).padStart(32, '0');
const FROM = '+14175550101';
const world = { said: [], asks: [], ended: [], lookups: [], calls: {}, logs: [] };

let httpServer, ttsServer, llmServer, port;
const cfg = {
  defaultVoice: 'TestVoice', defaultAgent: 'agent_test', defaultAgentName: 'Kiana', ttsModel: 'tts-test', proxySecret: 'offline',
  endCall: async (sid) => { world.ended.push(sid); },
  getAgents: async () => [], saveUsers: () => {}, seenCallNumbers: new Set(), saveSeenCall: () => {},
  callLimitTickMs: 40, callLimitCloseMs: 400,
};

test.before(async () => {
  dg.server = new RealWebSocket.Server({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => dg.server.on('listening', r));
  dg.port = dg.server.address().port;
  dg.server.on('connection', (sock) => {
    const c = { sock, frames: 0, closed: false };
    dg.conns.push(c);
    sock.on('message', (m, isBinary) => { if (isBinary) c.frames += 1; });
    sock.on('close', () => { c.closed = true; });
  });
  // The voice proxy: 0.3 s of mu-law silence per line, and a note of what was asked.
  ttsServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let input = '?';
      try { input = JSON.parse(raw).input; } catch {}
      world.said.push(input);
      // A test may make the voice proxy fail on the check-in line a number of times.
      if (world.failCheckIn > 0 && /Checking in/.test(input)) { world.failCheckIn -= 1; res.writeHead(500); res.end('speech is down'); return; }
      res.writeHead(200, { 'Content-Type': 'audio/basic' });
      // 0.3 s of silence per line; a test may ask for a longer check-in line to talk over.
      const long = (world.longCheckIn && /Checking in/.test(input)) || (world.longBye && /That is all the time/.test(input));
      res.end(Buffer.alloc(long ? 16000 : 2400, 0xff));
    });
  });
  // The model proxy: one short sentence per turn.
  llmServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      world.asks.push(raw);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ token: 'Glad you are here.' })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => ttsServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => llmServer.listen(0, '127.0.0.1', r));
  cfg.ttsProxyUrl = `http://127.0.0.1:${ttsServer.address().port}`;
  cfg.proxyUrl = `http://127.0.0.1:${llmServer.address().port}`;
  httpServer = http.createServer();
  const users = new Map([[FROM, { name: 'Pat', agentId: 'agent_test', agentName: 'Kiana' }]]);
  vs.attachMediaStreams(httpServer, users, cfg);
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  port = httpServer.address().port;
});

test.after(async () => {
  // Review: a test that failed with its call still up used to leave this hook waiting for ever
  // (a hung run instead of a red one). Whatever happens below, the file ends.
  setTimeout(() => process.exit(), 5000);
  for (const s of [httpServer, ttsServer, llmServer]) { try { s.closeAllConnections(); } catch {} await new Promise((r) => s.close(r)); }
  for (const c of dg.conns) { try { c.sock.terminate(); } catch {} }
  await new Promise((r) => dg.server.close(r));
  // voice-stream's own modules keep timers alive (it is a server); this file is done.
  setTimeout(() => process.exit(), 300);
});

/* A phone call as Twilio's stream presents it. */
async function phone(start) {
  const ws = new RealWebSocket(`ws://127.0.0.1:${port}/ws/media`);
  const call = { ws, media: 0, closed: null, clears: 0 };
  ws.on('message', (m) => {
    try { const j = JSON.parse(m); if (j.event === 'media') call.media += 1; if (j.event === 'clear') call.clears += 1; } catch {}
  });
  ws.on('close', (code) => { call.closed = code; });
  ws.on('error', () => {});
  await new Promise((r, rej) => { ws.on('open', r); ws.on('error', rej); });
  ws.send(JSON.stringify({ event: 'connected' }));
  call.start = () => ws.send(JSON.stringify({ event: 'start', start: { streamSid: `MZ${start.callSid.slice(-6)}`, callSid: start.callSid, customParameters: start.params } }));
  call.audio = () => ws.send(JSON.stringify({ event: 'media', media: { payload: Buffer.alloc(160, 0xff).toString('base64') } }));
  call.stop = () => ws.send(JSON.stringify({ event: 'stop' }));
  call.hangUp = async () => { if (call.closed === null) { try { call.stop(); } catch {} ws.close(); await until(() => call.closed !== null, 2000, 'client close'); } };
  return call;
}
const lastDg = () => dg.conns[dg.conns.length - 1];
/** Deepgram "hears" a finished sentence from the caller on the newest listening socket. */
function hear(text) {
  lastDg().sock.send(JSON.stringify({ type: 'TurnInfo', event: 'EndOfTurn', transcript: text, words: [] }));
}
function gateWith(mode, extra = {}) {
  world.logs = [];
  world.lookups = [];
  cfg.callSocketGate = createCallSocketGate({
    secret: 'wire-secret', mode,
    log: { log: (s) => world.logs.push(s), warn: (s) => world.logs.push(s) },
    fetchCall: async (sid) => {
      world.lookups.push(sid);
      if (extra.lookupMs) await sleep(extra.lookupMs);
      if (!world.calls[sid]) throw Object.assign(new Error('not found'), { status: 404 });
      return world.calls[sid];
    },
  });
  global._vsConfig.callSocketGate = cfg.callSocketGate;
  return cfg.callSocketGate;
}
function limits(over) {
  global._vsConfig.callLimits = over ? { enabled: true, idleMs: 0, idleGraceMs: 600, maxMs: 0, maxWarnMs: 600, ...over } : { enabled: false };
}
const sessions = vs._test.sessionsByCallSid;

// ── the socket gate ───────────────────────────────────────────────────────────

test('ENFORCE, a forged socket: no ticket and a call id Twilio does not know gets no session, no speech, no listening socket', async () => {
  gateWith('enforce'); limits(null);
  const saidBefore = world.said.length; const dgBefore = dg.conns.length;
  const call = await phone({ callSid: SID(1), params: { from: FROM, callSid: SID(1) } });
  call.start();
  await until(() => call.closed !== null, 3000, 'the bridge closes the forged socket');
  assert.equal(call.closed, 1008);
  assert.equal(call.media, 0, 'not one frame of audio');
  assert.equal(world.said.length, saidBefore, 'no paid speech');
  assert.equal(dg.conns.length, dgBefore, 'no Deepgram connection');
  assert.equal(sessions.has(SID(1)), false);
  assert.match(world.logs.join('\n'), /refused: no ticket; Twilio does not know that call/);
});

test('ENFORCE, a real call with its signed ticket: starts at once, greeting and all, and Twilio is never asked', async () => {
  const gate = gateWith('enforce'); limits(null);
  const saidBefore = world.said.length;
  const ticket = gate.mint({ callSid: SID(2), from: FROM, signed: true });
  const call = await phone({ callSid: SID(2), params: { from: FROM, callSid: SID(2), ticket } });
  call.start();
  await until(() => sessions.has(SID(2)), 1000, 'a session for the call');
  await until(() => world.said.length > saidBefore, 3000, 'the greeting was asked of the voice proxy');
  assert.match(world.said[world.said.length - 1], /Pat/, 'the greeting knows the registered caller');
  await until(() => call.media > 0, 3000, 'audio reached the phone');
  assert.equal(world.lookups.length, 0);
  assert.match(world.logs.join('\n'), /pass \(ticket\)/);
  await call.hangUp();
  await until(() => !sessions.has(SID(2)), 2000, 'the session is gone after the hang-up');
});

test('ENFORCE, a real call that lost its ticket: Twilio vouches for it and the call goes on', async () => {
  gateWith('enforce'); limits(null);
  world.calls[SID(3)] = { status: 'in-progress', from: FROM, to: '+18335550100' };
  const call = await phone({ callSid: SID(3), params: { from: FROM, callSid: SID(3) } });
  call.start();
  await until(() => sessions.has(SID(3)), 3000, 'a session after the lookup');
  assert.deepEqual(world.lookups, [SID(3)]);
  assert.match(world.logs.join('\n'), /pass \(twilio vouched; no ticket\)/);
  await call.hangUp();
});

test('ENFORCE, a live call id with somebody else\'s number is refused', async () => {
  gateWith('enforce'); limits(null);
  world.calls[SID(4)] = { status: 'in-progress', from: '+14175550202', to: '+18335550100' };
  const call = await phone({ callSid: SID(4), params: { from: FROM, callSid: SID(4) } });
  call.start();
  await until(() => call.closed !== null, 3000, 'closed');
  assert.equal(call.closed, 1008);
  assert.equal(sessions.has(SID(4)), false);
});

test('ENFORCE, the caller hangs up while Twilio is being asked: no session is made for a call that is gone', async () => {
  gateWith('enforce', { lookupMs: 400 }); limits(null);
  world.calls[SID(5)] = { status: 'in-progress', from: FROM };
  const saidBefore = world.said.length;
  const call = await phone({ callSid: SID(5), params: { from: FROM, callSid: SID(5) } });
  call.start();
  await sleep(100);
  call.stop();
  await sleep(700);
  assert.equal(sessions.has(SID(5)), false);
  assert.equal(world.said.length, saidBefore);
  call.ws.close();
});

test('LOG (the default): the same forged socket is let through exactly as today, and the log says what enforce would do', async () => {
  gateWith('log'); limits(null);
  const call = await phone({ callSid: SID(6), params: { from: FROM, callSid: SID(6) } });
  call.start();
  await until(() => sessions.has(SID(6)), 500, 'the session is made at once, without waiting for the lookup');
  await until(() => /would refuse: no ticket; Twilio does not know that call/.test(world.logs.join('\n')), 2000, 'the would-refuse line');
  assert.equal(call.closed, null);
  await call.hangUp();
});

test('NO GATE CONFIGURED (an older server.js): calls start as they always did', async () => {
  delete global._vsConfig.callSocketGate; limits(null);
  const call = await phone({ callSid: SID(7), params: { from: FROM, callSid: SID(7) } });
  call.start();
  await until(() => sessions.has(SID(7)), 500, 'session');
  await call.hangUp();
});

// ── the call limits ───────────────────────────────────────────────────────────

test('A QUIET LINE on a real socket: the question is spoken, then the goodbye, then Twilio is told to hang up, then the stream is closed', async () => {
  gateWith('off'); limits({ idleMs: 700, idleGraceMs: 600 });
  const from = world.said.length;
  const call = await phone({ callSid: SID(10), params: { from: FROM, callSid: SID(10) } });
  call.start();
  const since = () => world.said.slice(from);
  await until(() => since().some((l) => /Checking in/.test(l)), 6000, 'the question');
  assert.equal(world.ended.includes(SID(10)), false, 'no hang-up before the goodbye');
  await until(() => since().some((l) => /ending now/.test(l)), 4000, 'the goodbye');
  const lines = since();
  assert.ok(lines.findIndex((l) => /Checking in/.test(l)) < lines.findIndex((l) => /ending now/.test(l)), 'question first');
  await until(() => world.ended.includes(SID(10)), 4000, 'Twilio asked to end the call');
  await until(() => call.closed !== null, 3000, 'the stream is closed when the call is somehow still up');
  assert.equal(sessions.has(SID(10)), false);
});

test('THE CALLER ANSWERS the question: no hang-up, the character replies, and the call goes on', async () => {
  gateWith('off'); limits({ idleMs: 700, idleGraceMs: 900 });
  const from = world.said.length; const asksBefore = world.asks.length;
  const call = await phone({ callSid: SID(11), params: { from: FROM, callSid: SID(11) } });
  call.start();
  const since = () => world.said.slice(from);
  await until(() => since().some((l) => /Checking in/.test(l)), 6000, 'the question');
  await sleep(450); // let it play
  hear("Yes, I'm still here.");
  await until(() => world.asks.length > asksBefore, 3000, 'their answer became a real turn');
  await until(() => since().some((l) => /Glad you are here/.test(l)), 3000, 'the reply was spoken');
  assert.match(world.asks[world.asks.length - 1], /Checking in: it has been quiet/, 'the model can see what the caller was answering');
  await sleep(700);
  assert.equal(world.ended.includes(SID(11)), false, 'not hung up');
  assert.equal(since().some((l) => /ending now/.test(l)), false);
  assert.equal(call.closed, null);
  await call.hangUp();
});

test('THE CALLER SPEAKS OVER THE GOODBYE ("Wait, I am still here!"): the call is not ended', async () => {
  gateWith('off'); limits({ idleMs: 700, idleGraceMs: 600 });
  const from = world.said.length;
  const call = await phone({ callSid: SID(17), params: { from: FROM, callSid: SID(17) } });
  call.start();
  const since = () => world.said.slice(from);
  await until(() => since().some((l) => /ending now/.test(l)), 8000, 'the goodbye has started');
  hear("Wait, I'm still here!"); // while the goodbye is still playing
  await sleep(1800);
  assert.equal(world.ended.includes(SID(17)), false, 'no hang-up request');
  assert.equal(call.closed, null, 'the stream is still up');
  assert.ok(sessions.has(SID(17)));
  await call.hangUp();
});

test('A KEY PRESS counts as the caller being there', async () => {
  gateWith('off'); limits({ idleMs: 700, idleGraceMs: 900 });
  const from = world.said.length;
  const call = await phone({ callSid: SID(12), params: { from: FROM, callSid: SID(12) } });
  call.start();
  await until(() => world.said.slice(from).some((l) => /Checking in/.test(l)), 6000, 'the question');
  await sleep(450);
  call.ws.send(JSON.stringify({ event: 'dtmf', dtmf: { digit: '5' } }));
  // Review: the goodbye itself is looked for. Without the key press it is asked for 0.75 s from
  // now (the grace runs out); the old test only looked for the hang-up request, which comes later
  // than its 1.2 s wait, so it proved nothing. (Not longer: a whole new quiet count ends at 1.9 s.)
  await sleep(1200);
  assert.equal(world.said.slice(from).some((l) => /ending now/.test(l)), false, 'no goodbye was ever asked for');
  assert.equal(world.ended.includes(SID(12)), false);
  assert.equal(call.closed, null);
  await call.hangUp();
});

// ── review, Nov 10 2026 ───────────────────────────────────────────────────────

test('REVIEW, THE ANSWER RULE: a short answer is never the line\'s echo, even when every word of it is a word of the line; a long stretch of the line is', () => {
  const { LINES } = require('./call-limits');
  const { utteranceIsEcho, limitLineEcho, noteCallerHeard } = vs._test;
  const c = { idleGraceMs: 60000, maxWarnMs: 120000 };
  const answers = [
    'Keep going', 'We will keep going', 'It has been quiet, keep going', // what the first wording invited
    'Any word', 'Any key', 'Say any word', 'Press any key', 'Word', 'This call', // made of the new line's words
    'Do not end this call', 'Please do not end this call', 'Call back', 'Right back', 'Bye',
    "I'm still here", 'Yes', 'Hello?', "Wait, don't hang up", 'Stay on', 'Sure, go on', 'Okay',
  ];
  for (const [name, make] of Object.entries(LINES)) {
    const line = make(c);
    const session = { _limitLine: line, _limitLineUntil: Infinity, _currentSpokenText: line, isSpeaking: true, lastSpokAt: Date.now() };
    let heard = 0;
    session._limits = { noteHeard: () => { heard += 1; } };
    for (const a of answers) {
      assert.equal(utteranceIsEcho(session, a, true), false, `${name}: "${a}" was dropped as echo`);
      const before = heard;
      noteCallerHeard(session, 'words', a);
      assert.equal(heard, before + 1, `${name}: "${a}" did not count as the caller`);
    }
    // The line itself, and any long piece of it, coming back off a speakerphone.
    const words = line.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/);
    for (const piece of [line, words.slice(0, 6).join(' '), words.slice(-7).join(' ')]) {
      assert.equal(limitLineEcho(piece, line), true, `${name}: "${piece}" should be echo`);
      const before = heard;
      noteCallerHeard(session, 'words', piece);
      assert.equal(heard, before, `${name}: the line's own words counted as the caller`);
    }
    // A reply has started since: the ordinary echo rule is back.
    session._currentSpokenText = 'Glad you are here.';
    assert.equal(utteranceIsEcho(session, 'you are here', true), true);
  }
  // Outside a limit line, words heard while the character is talking do not count (its own voice).
  let n = 0;
  const talking = { _limits: { noteHeard: () => { n += 1; } }, isSpeaking: true, lastSpokAt: Date.now() };
  noteCallerHeard(talking, 'words', 'some words off the speaker');
  assert.equal(n, 0);
  noteCallerHeard({ ...talking, isSpeaking: false, lastSpokAt: Date.now() - 5000 }, 'words', 'hello');
  assert.equal(n, 1);
});

test('REVIEW: the caller answers the check-in at once with words of the check-in itself ("Any word."): a real turn, no hang-up', async () => {
  gateWith('off'); limits({ idleMs: 700, idleGraceMs: 900 });
  const from = world.said.length; const asksBefore = world.asks.length;
  const call = await phone({ callSid: SID(30), params: { from: FROM, callSid: SID(30) } });
  call.start();
  const since = () => world.said.slice(from);
  await until(() => since().some((l) => /Checking in/.test(l)), 6000, 'the check-in');
  const session = sessions.get(SID(30));
  await until(() => session._limitLine && session._limitLineUntil !== Infinity, 3000, 'the check-in finished playing');
  hear('Any word.'); // straight away, inside the echo window
  await until(() => world.asks.length > asksBefore, 3000, 'the answer became a real turn');
  await sleep(1800);
  assert.equal(since().some((l) => /ending now/.test(l)), false, 'no goodbye');
  assert.equal(world.ended.includes(SID(30)), false, 'not hung up');
  assert.equal(call.closed, null);
  await call.hangUp();
});

test('REVIEW: words heard OVER the check-in, never a finished sentence ("keep going"), still keep the call', async () => {
  gateWith('off'); limits({ idleMs: 700, idleGraceMs: 900 });
  world.longCheckIn = true;
  try {
    const from = world.said.length;
    const call = await phone({ callSid: SID(31), params: { from: FROM, callSid: SID(31) } });
    call.start();
    const since = () => world.said.slice(from);
    await until(() => since().some((l) => /Checking in/.test(l)), 6000, 'the check-in');
    const session = sessions.get(SID(31));
    await until(() => session.isSpeaking && session._limitLineUntil === Infinity, 2000, 'the check-in is playing');
    lastDg().sock.send(JSON.stringify({ type: 'TurnInfo', event: 'Update', transcript: 'this call', words: [] }));
    await sleep(2000 + 900 + 1500); // the rest of the line, the grace, and room for a goodbye
    assert.equal(since().some((l) => /ending now/.test(l)), false, 'no goodbye');
    assert.equal(world.ended.includes(SID(31)), false);
    await call.hangUp();
  } finally { world.longCheckIn = false; }
});

test('REVIEW: the check-in coming back off a speakerphone is not a caller: no turn, and the quiet call is still ended', async () => {
  gateWith('off'); limits({ idleMs: 700, idleGraceMs: 1500 }); // the echo is over before the goodbye, as on a real call
  world.longCheckIn = true;
  try {
    const from = world.said.length;
    const call = await phone({ callSid: SID(32), params: { from: FROM, callSid: SID(32) } });
    call.start();
    const since = () => world.said.slice(from);
    await until(() => since().some((l) => /Checking in/.test(l)), 6000, 'the check-in');
    const session = sessions.get(SID(32));
    await until(() => session.isSpeaking && session._limitLineUntil === Infinity, 2000, 'the check-in is playing');
    const line = session._limitLine;
    const asksBefore = world.asks.length;
    const heardSoFar = line.split(' ').slice(0, 9).join(' ');
    lastDg().sock.send(JSON.stringify({ type: 'TurnInfo', event: 'Update', transcript: heardSoFar, words: [] }));
    await until(() => session._limitLineUntil !== Infinity, 4000, 'the check-in finished');
    hear(line); // the whole line as a finished "sentence", just after it ended
    await until(() => since().some((l) => /ending now/.test(l)), 4000, 'the goodbye still came');
    await until(() => world.ended.includes(SID(32)), 4000, 'and the hang-up');
    assert.equal(world.asks.length, asksBefore, 'the echo never became a model turn');
    await until(() => call.closed !== null, 3000, 'closed');
  } finally { world.longCheckIn = false; }
});

test('REVIEW: the voice proxy fails on the check-in: it is asked again, and no goodbye comes until a check-in was really played', async () => {
  gateWith('off'); limits({ idleMs: 700, idleGraceMs: 600, warnRetryMs: 300 });
  world.failCheckIn = 1;
  try {
    const from = world.said.length;
    const call = await phone({ callSid: SID(33), params: { from: FROM, callSid: SID(33) } });
    call.start();
    const since = () => world.said.slice(from);
    const checkIns = () => since().filter((l) => /Checking in/.test(l)).length;
    await until(() => checkIns() >= 1, 6000, 'the first check-in, which fails');
    await until(() => checkIns() >= 2, 4000, 'the check-in is asked again');
    const secondAt = Date.now();
    assert.equal(since().some((l) => /ending now/.test(l)), false, 'no goodbye before a check-in was heard');
    assert.equal(world.ended.includes(SID(33)), false);
    await until(() => since().some((l) => /ending now/.test(l)), 4000, 'the goodbye, after the spoken check-in');
    assert.ok(Date.now() - secondAt >= 600, 'a full grace after the check-in that played');
    await until(() => world.ended.includes(SID(33)), 4000, 'hang-up');
    await until(() => call.closed !== null, 3000, 'closed');
  } finally { world.failCheckIn = 0; }
});

test('REVIEW: a call-limit line is really played even when an old interruption left the stop flag set', async () => {
  gateWith('off'); limits(null);
  const call = await phone({ callSid: SID(34), params: { from: FROM, callSid: SID(34) } });
  call.start();
  await until(() => sessions.has(SID(34)), 500, 'session');
  const session = sessions.get(SID(34));
  await until(() => call.media > 0 && !session.isSpeaking && !session.busy && !session._greetingLock, 5000, 'the greeting is over');
  await sleep(200);
  session.llmAbort = true; // what a barge-in outside a model turn leaves behind
  const mediaBefore = call.media;
  const ok = await vs._test.limitSay(session, 'Quick heads up: a line for the test.');
  assert.equal(ok, true, 'limitSay reports the line as spoken');
  assert.ok(call.media > mediaBefore, 'and its audio reached the phone');
  await call.hangUp();
});

test('REVIEW: the hearing-trouble line is never spoken over a Spotter, and is spoken without one', async () => {
  gateWith('off'); limits(null);
  const call = await phone({ callSid: SID(35), params: { from: FROM, callSid: SID(35) } });
  call.start();
  await until(() => sessions.has(SID(35)), 500, 'session');
  const session = sessions.get(SID(35));
  await until(() => call.media > 0 && !session.isSpeaking && !session.busy && !session._greetingLock, 5000, 'the greeting is over');
  const from = world.said.length;
  session._liveWs = { readyState: 3, close() {}, terminate() {}, send() {}, on() {}, removeAllListeners() {} };
  await vs._test.sttSay(session, 'A trouble line for the test.');
  assert.equal(world.said.slice(from).some((l) => /trouble line/.test(l)), false, 'not over a Spotter');
  session._liveWs = null;
  await vs._test.sttSay(session, 'A trouble line for the test.');
  assert.equal(world.said.slice(from).some((l) => /trouble line/.test(l)), true, 'spoken on an ordinary call');
  await call.hangUp();
});

test('THE LONGEST CALL on a real socket: warned first, ended a full warning later, and words during the goodbye start no new turn', async () => {
  gateWith('off'); limits({ maxMs: 1500, maxWarnMs: 700 });
  // Review: the goodbye is 2 s long here. The bridge holds a finished sentence 0.9 s before acting
  // on it; with the old 0.3 s goodbye the call was already closed by then, so the test passed with
  // the guard in handleUtterance taken out.
  world.longBye = true;
  try {
    const from = world.said.length;
    const t0 = Date.now();
    const call = await phone({ callSid: SID(13), params: { from: FROM, callSid: SID(13) } });
    call.start();
    const since = () => world.said.slice(from);
    await until(() => since().some((l) => /this call has to end/.test(l)), 6000, 'the warning');
    const warnedAt = Date.now();
    await until(() => since().some((l) => /That is all the time this call gets/.test(l)), 6000, 'the goodbye');
    assert.ok(Date.now() - warnedAt >= 700, 'never sooner than a full warning period after the warning');
    const asksBefore = world.asks.length;
    hear('Wait, one more thing.');
    await sleep(1400); // past the 0.9 s hold, the goodbye still playing
    assert.equal(call.closed, null, 'the goodbye is still playing');
    assert.equal(world.asks.length, asksBefore, 'no model turn was started over the goodbye');
    await until(() => world.ended.includes(SID(13)), 5000, 'hang-up');
    assert.equal(world.asks.length, asksBefore);
    assert.ok(Date.now() - t0 >= 1500);
    await until(() => call.closed !== null, 3000, 'closed');
  } finally { world.longBye = false; }
});

test('AN OUTBOUND CALL is not armed: a quiet callee (a business hold) is never asked and never cut by this watch', async () => {
  gateWith('off'); limits({ idleMs: 300, idleGraceMs: 300, maxMs: 900, maxWarnMs: 300 });
  const from = world.said.length;
  const call = await phone({ callSid: SID(14), params: { from: FROM, callSid: SID(14), outbound: '1' } });
  call.start();
  await sleep(2500);
  const lines = world.said.slice(from);
  assert.equal(lines.some((l) => /Checking in|has to end|ending now/.test(l)), false, lines.join(' | '));
  assert.equal(world.ended.includes(SID(14)), false);
  assert.equal(call.closed, null);
  await call.hangUp();
});

test('LIMITS OFF (CALL_LIMITS=0): a quiet inbound call is left alone', async () => {
  gateWith('off'); limits(null);
  const from = world.said.length;
  const call = await phone({ callSid: SID(15), params: { from: FROM, callSid: SID(15) } });
  call.start();
  await sleep(1500);
  assert.equal(world.said.slice(from).some((l) => /Checking in|ending now/.test(l)), false);
  assert.equal(call.closed, null);
  await call.hangUp();
});

test('a caller who hangs up during the quiet count leaves nothing behind: no late question, no hang-up request', async () => {
  gateWith('off'); limits({ idleMs: 900, idleGraceMs: 600 });
  const call = await phone({ callSid: SID(16), params: { from: FROM, callSid: SID(16) } });
  call.start();
  await until(() => sessions.has(SID(16)), 500, 'session');
  await sleep(300);
  await call.hangUp();
  const from = world.said.length;
  await sleep(1800);
  assert.equal(world.said.slice(from).some((l) => /Checking in|ending now/.test(l)), false);
  assert.equal(world.ended.includes(SID(16)), false);
});

test('A BARGE-IN ON THE CHECK-IN LINE: the recovery line after it is really played, and the speaking flag is not left stuck on', async () => {
  gateWith('off'); limits({ idleMs: 700, idleGraceMs: 5000 });
  world.longCheckIn = true; // a 2 s check-in line, so there is something to talk over
  try {
    const from = world.said.length;
    const call = await phone({ callSid: SID(18), params: { from: FROM, callSid: SID(18) } });
    call.start();
    const since = () => world.said.slice(from);
    await until(() => since().some((l) => /Checking in/.test(l)), 6000, 'the check-in');
    const session = sessions.get(SID(18));
    await until(() => session.isSpeaking, 2000, 'the check-in is playing');
    await sleep(1150); // the bridge ignores an interruption in a line's first second
    assert.equal(session.isSpeaking, true, 'still playing');
    const clearsBefore = call.clears;
    // The caller starts to say something over it (words, but never a finished sentence).
    lastDg().sock.send(JSON.stringify({ type: 'TurnInfo', event: 'Update', transcript: 'hold on a second', words: [] }));
    await until(() => call.clears > clearsBefore, 2000, 'the line was cut for the caller');
    assert.equal(session.llmAbort, true, 'the barge-in left its abort flag (no model turn was running to clear it)');
    // They trail off: a new turn opens with no words, and no finished sentence ever arrives.
    lastDg().sock.send(JSON.stringify({ type: 'TurnInfo', event: 'StartOfTurn', transcript: '' }));
    const mediaAtBarge = call.media;
    await until(() => since().some((l) => /go ahead|what was that/i.test(l)), 4000, 'the recovery line was asked of the voice proxy');
    await until(() => call.media > mediaAtBarge, 2000, 'and its audio really reached the phone');
    await until(() => !session.isSpeaking, 3000, 'and when it finished, the speaking flag came back off');
    assert.equal(world.ended.includes(SID(18)), false, 'the caller made a sound: no hang-up');
    await call.hangUp();
  } finally {
    world.longCheckIn = false;
  }
});

// ── the listening keeper ──────────────────────────────────────────────────────

test('DEEPGRAM DROPS MID-CALL: the next audio opens a new listening socket and the caller is heard again', async () => {
  gateWith('off'); limits(null);
  const call = await phone({ callSid: SID(20), params: { from: FROM, callSid: SID(20) } });
  const dgBefore = dg.conns.length;
  call.start();
  await until(() => dg.conns.length === dgBefore + 1, 2000, 'the first listening socket');
  const first = lastDg();
  await until(() => { call.audio(); return first.frames > 0; }, 2000, 'audio reaches Deepgram');
  first.sock.close(); // Deepgram goes away
  await until(() => first.closed, 2000, 'closed');
  await until(() => { call.audio(); return dg.conns.length === dgBefore + 2; }, 3000, 'a second listening socket');
  const second = lastDg();
  await until(() => { call.audio(); return second.frames > 0; }, 2000, 'audio reaches the new socket');
  const asksBefore = world.asks.length;
  hear('Can you still hear me?');
  await until(() => world.asks.length > asksBefore, 3000, 'words on the new socket become a turn');
  await call.hangUp();
  await until(() => second.closed, 2000, 'the listening socket is closed with the call');
  const after = dg.conns.length;
  await sleep(300);
  assert.equal(dg.conns.length, after, 'and nothing reopens it once the call is over');
});
