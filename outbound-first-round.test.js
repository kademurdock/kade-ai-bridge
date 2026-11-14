'use strict';
/* outbound-first-round.test.js — Nov 14 2026. The FIRST EXCHANGE of an outbound call, through the
 * REAL voice-stream.js on a local socket.
 *
 * Kade's test call (bridge f196437): she answered "Hello?", her hello was handed over just after
 * the fixed 2.5 s start had begun the greeting, it was held and replayed as her first turn when the
 * greeting ended, the typing sound came on as Kiana stopped, and she was asked the question again.
 *
 * Fake, all on 127.0.0.1: Twilio's media stream (a ws client), Deepgram Flux (a ws server this file
 * makes "hear" turns), the voice proxy (silence of a chosen length, and a note of every line it was
 * asked to say), the model proxy (one reply after a short think, and a note of every request).
 * Nothing paid, nothing dialed, nothing leaves the PC. Times are shortened through the env switches
 * (KADE_OUTBOUND_GREETING_WAIT_MS and friends); the order of events is the live one. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');
const RealWebSocket = require('ws');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'first-round-'));
process.env.DEEPGRAM_API_KEY = 'offline-test';
process.env.PHONE_LLM_GREETING = '0';
process.env.KADE_SPEECH_SECRET = 'offline';
process.env.FLUX_POST_TURN_GRACE_MS = '900'; // the live hold that pushed her hello past the start
delete process.env.FLUX_ADAPTIVE_GRACE;
delete process.env.KADE_USAGE_EVENT_SECRET;
delete process.env.KADE_CALL_INGEST_SECRET;
delete process.env.KADE_OUTBOUND_FIRST_ROUND;
delete process.env.KADE_OUTBOUND_QUIET_WATCH;
// Shortened clock: the greeting starts 1 s after pickup (live: 2.5 s), waits for a talker up to 2.5 s
// (live: 5 s). The quiet watch is pushed out of the way except in its own tests.
const BASE_ENV = {
  KADE_OUTBOUND_GREETING_WAIT_MS: '1000',
  KADE_OUTBOUND_GREETING_MAX_WAIT_MS: '2500',
  KADE_OUTBOUND_QUIET_ASK_MS: '60000',
  KADE_OUTBOUND_QUIET_END_MS: '60000',
  KADE_OUTBOUND_HELD_WAIT_MS: '4000',
};
const setEnv = (extra = {}) => {
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...extra })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};
setEnv();

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
const T = vs._test;

const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.map(String).join(' ')); };
console.warn = (...a) => { logs.push(a.map(String).join(' ')); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(15); }
  throw new Error(`not within ${ms} ms: ${what}`);
}

const SID = (n) => 'CA' + String(n).padStart(32, '0');
const HER = '+14175550142'; // a made-up registered number standing in for "her number"
const HOLLY = '+14175550177'; // a made-up registered family number (the check-in tests)
const SEC = 8000; // mu-law 8 kHz: one byte per sample
// A greeting rendered from this byte tells its frames apart from the voice proxy's lines (0xff).
const GREET_BYTE = 0x7e;
function frameKind(buf) {
  let greet = false;
  for (const b of buf) { if (b === GREET_BYTE) greet = true; else if (b !== 0xff) return 'typing'; }
  return greet ? 'greet' : 'voice';
}
const world = { said: [], asks: [], ended: [], callEnds: [], memoryFetches: 0, llmDelay: 400, reply: 'Thanks, that helps.', ttsSec: 1, ttsDelayFor: null };
const ctxBySid = new Map();

let httpServer, ttsServer, llmServer, port;
const cfg = {
  defaultVoice: 'TestVoice', defaultAgent: 'agent_kiana_test', defaultAgentName: 'Kiana', ttsModel: 'tts-test', proxySecret: 'offline',
  endCall: async (sid) => { world.ended.push(sid); },
  getAgents: async () => [], saveUsers: () => {}, seenCallNumbers: new Set(), saveSeenCall: () => {},
  getOutboundCtx: (sid) => ctxBySid.get(sid) || null,
  fetchCallMemories: async () => { world.memoryFetches += 1; return 'Kade likes long walks.'; },
  // What server.js onCallEnd receives at hang-up (the call record's transcript, and the report's).
  onCallEnd: (sid, history) => { world.callEnds.push({ sid, history: JSON.parse(JSON.stringify(history || [])) }); },
};

test.before(async () => {
  dg.server = new RealWebSocket.Server({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => dg.server.on('listening', r));
  dg.port = dg.server.address().port;
  dg.server.on('connection', (sock) => { dg.conns.push({ sock }); });
  ttsServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let input = '?';
      try { input = JSON.parse(raw).input; } catch {}
      world.said.push(input);
      const wait = world.ttsDelayFor ? world.ttsDelayFor(input) : 0; // a voice that takes a while to make one line
      if (wait) await sleep(wait);
      res.writeHead(200, { 'Content-Type': 'audio/basic' });
      res.end(Buffer.alloc(Math.round(world.ttsSec * SEC), 0xff));
    });
  });
  llmServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      world.asks.push({ at: Date.now(), raw });
      await sleep(world.llmDelay);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ token: world.reply })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => ttsServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => llmServer.listen(0, '127.0.0.1', r));
  cfg.ttsProxyUrl = `http://127.0.0.1:${ttsServer.address().port}`;
  cfg.proxyUrl = `http://127.0.0.1:${llmServer.address().port}`;
  httpServer = http.createServer();
  const users = new Map([
    [HER, { name: 'Kade', agentId: 'agent_kiana_test', agentName: 'Kiana', lcEmail: 'her@example.invalid' }],
    [HOLLY, { name: 'Holly', agentId: 'agent_harley_test', agentName: 'Harley', lcEmail: 'holly@example.invalid' }],
  ]);
  vs.attachMediaStreams(httpServer, users, cfg);
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  port = httpServer.address().port;
});

test.after(async () => {
  setTimeout(() => process.exit(), 3000);
  for (const s of [httpServer, ttsServer, llmServer]) { try { s.closeAllConnections(); } catch {} await new Promise((r) => s.close(r)); }
  for (const c of dg.conns) { try { c.sock.terminate(); } catch {} }
  await new Promise((r) => dg.server.close(r));
  setTimeout(() => process.exit(), 300);
});

const GREETING = "Hi, this is Kiana, an A I assistant calling on behalf of a customer, Kade Murdock. This call may be recorded. I'm calling to ask if you have any deals on hemp products right now.";
const ASK_AT = GREETING.indexOf("I'm calling") / GREETING.length;

/** An outbound call as Twilio's stream presents it, with the greeting already rendered. */
async function outboundCall(n, over = {}) {
  const sid = SID(n);
  const greetingSec = over.greetingSec || 3;
  const ctx = {
    callSid: sid, userId: '6a3cba4d0b0afa92194e42f7', userName: 'Kade Murdock',
    purpose: 'Kade wants to know if they have any deals on hemp products',
    calleeName: null, business: true, tier: 'stranger', disclosed: true, to: HER,
    agentId: 'agent_kiana_test', agentName: 'Kiana', voice: 'TestVoice', rate: null,
    greeting: GREETING, greetingAskAt: ASK_AT, greetingBuf: Buffer.alloc(greetingSec * SEC, 0xff),
    greeting2: null, greeting2Buf: null, greeting2AskAt: null, context: null,
    ...over.ctx,
  };
  ctxBySid.set(sid, ctx);
  const dgBefore = dg.conns.length;
  const ws = new RealWebSocket(`ws://127.0.0.1:${port}/ws/media`);
  const call = { sid, ws, ctx, media: [], frames: [], clears: 0 };
  ws.on('message', (m) => {
    try {
      const j = JSON.parse(m);
      if (j.event === 'media') {
        call.media.push(Date.now());
        call.frames.push({ at: Date.now(), kind: frameKind(Buffer.from(j.media.payload, 'base64')) });
      }
      if (j.event === 'clear') call.clears += 1;
    } catch {}
  });
  ws.on('error', () => {});
  await new Promise((r, rej) => { ws.on('open', r); ws.on('error', rej); });
  ws.send(JSON.stringify({ event: 'connected' }));
  call.t0 = Date.now();
  ws.send(JSON.stringify({ event: 'start', start: { streamSid: `MZ${sid.slice(-6)}`, callSid: sid, customParameters: { from: over.from || HER, callSid: sid, outbound: '1' } } }));
  await until(() => T.sessionsByCallSid.has(sid) && dg.conns.length > dgBefore, 2000, 'session + listening socket');
  call.session = T.sessionsByCallSid.get(sid);
  const sock = dg.conns[dg.conns.length - 1].sock;
  call.turn = (event, transcript = '') => sock.send(JSON.stringify({ type: 'TurnInfo', event, transcript, words: [] }));
  /** They say something: the turn opens, words come, and Flux closes it endMs later. */
  call.say = async (text, endMs = 300) => { call.turn('StartOfTurn'); call.turn('Update', text); await sleep(endMs); call.turn('EndOfTurn', text); };
  /** Words arriving one by one (an Update every gapMs), then Flux closes the turn eotMs after the last. */
  call.words = async (text, { gapMs = 200, eotMs = 300, close = true } = {}) => {
    const w = text.split(' ');
    call.turn('StartOfTurn');
    for (let i = 1; i <= w.length; i += 1) { await sleep(gapMs); call.turn('Update', w.slice(0, i).join(' ')); }
    if (close) { await sleep(eotMs); call.turn('EndOfTurn', text); }
  };
  call.at = (ms) => sleep(Math.max(0, ms - (Date.now() - call.t0)));
  call.hangUp = async () => { try { ws.send(JSON.stringify({ event: 'stop' })); } catch {} try { ws.close(); } catch {} await sleep(150); };
  /** Frames of one kind sent after a moment (ms after pickup). */
  call.framesAfter = (kind, fromMs) => call.frames.filter((f) => f.kind === kind && f.at - call.t0 > fromMs).length;
  /** Turns THIS call ran (its own timing lines), so a late request from another call cannot be counted here. */
  call.turnsRun = () => logs.filter((l) => l.includes(`[timing ${call.session.streamSid}] turn-start`)).length;
  return call;
}

/** The last user message the bridge sent the model on request i (its suffix cut off). */
function lastUser(i) {
  const body = JSON.parse(world.asks[i].raw);
  const u = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
  return u ? String(u.content).split('\n\n[')[0].split('\n[')[0] : '';
}
function messagesOf(i) { return JSON.parse(world.asks[i].raw).messages || []; }
const asksSince = (from) => world.asks.slice(from).map((_, k) => lastUser(from + k));
const greetingDone = (c) => !c.session._greetingLock && c.session._greetingStarted && !c.session._confirmPhase;

test('KADE\'S CALL, the live order: her "Hello?" is still being heard when the start timer fires. The greeting waits for it, it is never a turn, and her answer is the first and only turn', async () => {
  setEnv();
  const asks0 = world.asks.length;
  const logs0 = logs.length;
  const c = await outboundCall(1);
  await c.at(800);
  c.turn('StartOfTurn');
  await sleep(100);
  c.turn('Update', 'Hello?');
  await c.at(1400); // the start timer (1 s here, 2.5 s live) fired while her turn was open
  c.turn('EndOfTurn', 'Hello?');
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  const startedAfter = c.session._greetingStartedAt - c.t0;
  assert.ok(startedAfter >= 1300, `the greeting waited for her hello to finish (started at +${startedAfter} ms)`);
  assert.ok(startedAfter < 2000, `and started at once when it did, without the 0.9 s hold (+${startedAfter} ms)`);
  await until(() => greetingDone(c), 6000, 'greeting over');
  assert.equal(world.asks.length, asks0, 'no model turn when the greeting ended: no typing sound, no second ask');
  await sleep(300);
  await c.say("It's none of your business, they closed down last week.");
  await until(() => world.asks.length > asks0, 5000, 'her answer reaches the model');
  await sleep(1500);
  assert.deepEqual(asksSince(asks0), ["It's none of your business, they closed down last week."], 'exactly one turn, her answer');
  assert.ok(logs.slice(logs0).some((l) => /pickup words, not an answer \(a hello\)/.test(l)));
  assert.equal(c.session.history.filter((m) => m.role === 'user' && /^Hello/.test(m.content)).length, 0, 'the hello is not in the history');
  await c.hangUp();
});

test('THE SAME ORDER WITH THE SWITCH OFF (KADE_OUTBOUND_FIRST_ROUND=0) brings the old bug back: proof the test sees it', async () => {
  setEnv({ KADE_OUTBOUND_FIRST_ROUND: '0' });
  try {
    const asks0 = world.asks.length;
    const c = await outboundCall(2);
    await c.at(800);
    c.turn('StartOfTurn');
    await sleep(100);
    c.turn('Update', 'Hello?');
    await c.at(1400);
    c.turn('EndOfTurn', 'Hello?');
    await until(() => world.asks.length > asks0, 8000, 'the replayed hello became a turn');
    assert.equal(lastUser(asks0), 'Hello?', 'her pickup hello was answered as if it were her reply');
    await c.hangUp();
  } finally { setEnv({ KADE_OUTBOUND_FIRST_ROUND: undefined }); }
});

test('A HELLO BEFORE THE START: it starts the greeting at once and is never a turn', async () => {
  setEnv();
  const asks0 = world.asks.length;
  const c = await outboundCall(3);
  await c.at(250);
  await c.say('Hello?', 250);
  await until(() => c.session._greetingStarted, 1000, 'greeting started on her hello');
  assert.ok(c.session._greetingStartedAt - c.t0 < 900, 'before the 1 s start timer');
  await until(() => greetingDone(c), 6000, 'greeting over');
  await sleep(200);
  await c.say('Yeah, we have a few.');
  await until(() => world.asks.length > asks0, 5000, 'answer');
  await sleep(800);
  assert.deepEqual(asksSince(asks0), ['Yeah, we have a few.']);
  await c.hangUp();
});

test('THE BACKSTOP: a hello begun before the greeting but handed over during it is pickup words, never held', async () => {
  setEnv({ KADE_OUTBOUND_GREETING_MAX_WAIT_MS: '1150' }); // the greeting gives up waiting while she is still talking
  const asks0 = world.asks.length;
  const logs0 = logs.length;
  const c = await outboundCall(4);
  await c.at(900);
  c.turn('StartOfTurn');
  c.turn('Update', 'Hello? Hello?');
  await until(() => c.session._greetingStarted, 2000, 'greeting started at the cap');
  await c.at(1700);
  c.turn('EndOfTurn', 'Hello? Hello?');
  await until(() => logs.slice(logs0).some((l) => /pickup words, not an answer/.test(l)), 3000, 'dropped as pickup words');
  await until(() => greetingDone(c), 6000, 'greeting over');
  await sleep(600);
  assert.equal(world.asks.length, asks0, 'no turn for it');
  await c.hangUp();
});

test('A HELLO SAID OVER THE GREETING (silent pickup) is dropped; the answer after it is the only turn', async () => {
  setEnv();
  const asks0 = world.asks.length;
  const logs0 = logs.length;
  const c = await outboundCall(5, { greetingSec: 4 });
  await until(() => c.session._greetingStarted, 2000, 'greeting started by the timer');
  await sleep(1000); // past the first 0.7 s, where words are still their pickup
  await c.say('Hello?', 200);
  await until(() => logs.slice(logs0).some((l) => /said over the greeting/.test(l)), 3000, 'dropped');
  await until(() => greetingDone(c), 6000, 'greeting over');
  await sleep(200);
  await c.say('No deals right now, sorry.');
  await until(() => world.asks.length > asks0, 5000, 'answer');
  await sleep(800);
  assert.deepEqual(asksSince(asks0), ['No deals right now, sorry.']);
  await c.hangUp();
});

test('A NAME AT PICKUP ("Shell, this is Mike.") is kept as what they said first, before the greeting, and is not a turn', async () => {
  setEnv();
  const asks0 = world.asks.length;
  const c = await outboundCall(6);
  await c.at(200);
  await c.say('Shell, this is Mike.', 300);
  await until(() => greetingDone(c), 6000, 'greeting over');
  await sleep(200);
  assert.equal(world.asks.length, asks0, 'no turn for the pickup line');
  await c.say('Yep, two for one on vapes.');
  await until(() => world.asks.length > asks0, 5000, 'answer');
  const msgs = messagesOf(asks0).filter((m) => m.role === 'user' || m.role === 'assistant');
  const iName = msgs.findIndex((m) => m.role === 'user' && /^Shell, this is Mike\./.test(m.content));
  const iGreet = msgs.findIndex((m) => m.role === 'assistant' && m.content === GREETING);
  assert.ok(iName >= 0 && iGreet > iName, 'the model sees their pickup line, then the greeting');
  assert.equal(lastUser(asks0), 'Yep, two for one on vapes.');
  await sleep(800);
  assert.equal(world.asks.length - asks0, 1);
  await c.hangUp();
});

test('TALKING OVER THE END OF THE GREETING: an answer finished during the question is held and answered once, when the greeting ends', async () => {
  setEnv();
  const asks0 = world.asks.length;
  const c = await outboundCall(7, { greetingSec: 5 });
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  const g0 = c.session._greetingPart.audioAt;
  await sleep(Math.max(0, g0 + 3000 - Date.now())); // inside the question
  await c.say('No, they closed down last week.', 300); // handed over at about +4.2 s, still inside the greeting
  await until(() => greetingDone(c), 6000, 'greeting over');
  await until(() => world.asks.length > asks0, 3000, 'the held answer is the first turn');
  await sleep(1000);
  assert.deepEqual(asksSince(asks0), ['No, they closed down last week.']);
  await c.hangUp();
});

test('AN ANSWER THAT REPEATS THE QUESTION\'S WORDS, said over the question, is answered, not taken for an echo', async () => {
  setEnv();
  const asks0 = world.asks.length;
  const c = await outboundCall(20, { greetingSec: 5 });
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  const g0 = c.session._greetingPart.audioAt;
  await sleep(Math.max(0, g0 + 3000 - Date.now()));
  await c.say('Deals on hemp products right now? No.', 300);
  await until(() => greetingDone(c), 6000, 'greeting over');
  await until(() => world.asks.length > asks0, 3000, 'answered');
  await sleep(800);
  assert.deepEqual(asksSince(asks0), ['Deals on hemp products right now? No.']);
  await c.hangUp();
});

test('STILL TALKING WHEN THE GREETING ENDS: what they said over it waits for the rest, and both are answered as one turn', async () => {
  setEnv();
  const asks0 = world.asks.length;
  const c = await outboundCall(8, { greetingSec: 5 });
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  const g0 = c.session._greetingPart.audioAt;
  await sleep(Math.max(0, g0 + 3000 - Date.now()));
  await c.say('No, we', 300);              // held during the greeting
  await sleep(Math.max(0, g0 + 4600 - Date.now()));
  c.turn('StartOfTurn');
  c.turn('Update', 'closed down last week');  // still talking as the greeting ends
  await until(() => greetingDone(c), 4000, 'greeting over');
  await sleep(400);
  assert.equal(world.asks.length, asks0, 'no turn while they are still talking');
  c.turn('EndOfTurn', 'closed down last week');
  await until(() => world.asks.length > asks0, 4000, 'one turn');
  await sleep(800);
  assert.deepEqual(asksSince(asks0), ['No, we closed down last week']);
  await c.hangUp();
});

test('A NOD DURING "this is Kiana, an A I assistant" is dropped; a "yeah" while the question is asked is the answer', async () => {
  setEnv({ KADE_OUTBOUND_NOD_WAIT_MS: '600' });
  const asks0 = world.asks.length;
  const c = await outboundCall(9, { greetingSec: 6 });
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  const g0 = c.session._greetingPart.audioAt;
  await sleep(Math.max(0, g0 + 1200 - Date.now()));
  await c.say('Okay.', 200);  // a nod during the disclosure
  await sleep(Math.max(0, g0 + Math.round(6000 * ASK_AT) + 1500 - Date.now()));
  await c.say('Yeah.', 200);  // said to the question (1.5 s into it on our clock)
  await until(() => greetingDone(c), 6000, 'greeting over');
  await until(() => world.asks.length > asks0, 3000, 'the answer');
  await sleep(800);
  assert.deepEqual(asksSince(asks0), ['Yeah.']);
  await c.hangUp();
});

test('SILENCE: nothing said after the greeting -> "Hello? Can you hear me?" with no model turn, then a goodbye and the hang-up', async () => {
  setEnv({ KADE_OUTBOUND_QUIET_ASK_MS: '600', KADE_OUTBOUND_QUIET_END_MS: '900' });
  const asks0 = world.asks.length;
  const said0 = world.said.length;
  const c = await outboundCall(10, { greetingSec: 1 });
  await until(() => world.said.slice(said0).includes(T.QUIET_ASK_LINE), 6000, 'the check line');
  await until(() => world.ended.includes(c.sid), 6000, 'hung up');
  assert.ok(world.said.slice(said0).includes(T.QUIET_BYE_LINE), 'a goodbye before hanging up');
  assert.equal(world.asks.length, asks0, 'no model turn, so no typing sound');
  assert.equal(c.ctx.quietHangUp, true, 'the report will say nobody spoke');
  await c.hangUp();
});

test('SILENCE, THEN AN ANSWER after the check line: their words are the first turn, no goodbye, no hang-up', async () => {
  setEnv({ KADE_OUTBOUND_QUIET_ASK_MS: '500', KADE_OUTBOUND_QUIET_END_MS: '2500' });
  const asks0 = world.asks.length;
  const said0 = world.said.length;
  const c = await outboundCall(11, { greetingSec: 1 });
  await until(() => world.said.slice(said0).includes(T.QUIET_ASK_LINE), 6000, 'the check line');
  await sleep(1300);
  await c.say('Sorry, yes, I can hear you. No deals today.');
  await until(() => world.asks.length > asks0, 5000, 'their answer');
  await sleep(2600);
  assert.equal(world.ended.includes(c.sid), false, 'not hung up');
  assert.equal(world.said.slice(said0).includes(T.QUIET_BYE_LINE), false);
  assert.deepEqual(asksSince(asks0), ['Sorry, yes, I can hear you. No deals today.']);
  await c.hangUp();
});

test('A SENTENCE FINISHED WHILE THE CHARACTER IS TALKING waits for the reply and is answered, not dropped as echo', async () => {
  setEnv();
  world.ttsSec = 3;
  try {
    const asks0 = world.asks.length;
    const logs0 = logs.length;
    const c = await outboundCall(12, { greetingSec: 1 });
    await until(() => greetingDone(c), 4000, 'greeting over');
    await sleep(200);
    await c.say('Sorry, what was that?', 200);
    await until(() => world.asks.length > asks0, 4000, 'first turn');
    await until(() => c.session.isSpeaking && c.session.busy, 4000, 'the reply is playing');
    c.turn('StartOfTurn');
    c.turn('EndOfTurn', 'We closed down last week.'); // no words while it played, so no barge-in
    await until(() => world.asks.length > asks0 + 1, 9000, 'their sentence is answered after the reply');
    assert.equal(lastUser(asks0 + 1), 'We closed down last week.');
    assert.ok(logs.slice(logs0).some((l) => /the callee's words wait for this reply/.test(l)));
    await c.hangUp();
  } finally { world.ttsSec = 1; }
});

test('NO TYPING OVER THEM: while the person who answered is talking, the thinking sound stays quiet', async () => {
  setEnv();
  world.llmDelay = 3000;
  try {
    const asks0 = world.asks.length;
    const c = await outboundCall(13, { greetingSec: 1 });
    await until(() => greetingDone(c), 4000, 'greeting over');
    await sleep(200);
    await c.say('Do you mean the vapes?', 200);
    await until(() => world.asks.length > asks0, 4000, 'the turn is thinking');
    const askAt = world.asks[asks0].at;
    await sleep(900); // the typing sound has started (it waits 0.5 s)
    // They keep talking (a new turn, words every 200 ms for 1.2 s).
    c.turn('StartOfTurn');
    const talkFrom = Date.now();
    assert.ok(c.media.filter((t) => t > askAt + 550 && t < talkFrom).length > 0, 'the typing sound was playing before they spoke');
    for (let i = 0; i < 6; i += 1) { c.turn('Update', `we have some vapes ${i}`); await sleep(200); }
    const talkTo = Date.now();
    const framesWhileTalking = c.media.filter((t) => t > talkFrom + 300 && t < talkTo).length;
    assert.equal(framesWhileTalking, 0, `no typing frames while they talked (${framesWhileTalking})`);
    c.turn('EndOfTurn', 'we have some vapes');
    await sleep(500);
    await c.hangUp();
  } finally { world.llmDelay = 400; }
});

test('THE TWO-PART GREETING: a late pickup hello is not taken as the answer to "is this ...?"; their real answer is', async () => {
  setEnv();
  const asks0 = world.asks.length;
  const part1 = "Hi, this is Kiana, an A I assistant calling on behalf of a customer, Kade Murdock. Is this Tony's Pizza?";
  const part2 = "Thanks! This call may be recorded. I'm calling to ask whether you are open on Sunday.";
  const c = await outboundCall(14, { greetingSec: 2, ctx: {
    calleeName: "Tony's Pizza", greeting: part1, greetingAskAt: part1.indexOf('Is this') / part1.length,
    greeting2: part2, greeting2Buf: Buffer.alloc(2 * SEC, 0xff), greeting2AskAt: part2.indexOf("I'm calling") / part2.length,
  } });
  await c.at(800);
  c.turn('StartOfTurn');
  c.turn('Update', 'Hello?');
  await c.at(1400);
  c.turn('EndOfTurn', 'Hello?');
  await until(() => c.session._confirmPhase, 5000, 'waiting for the answer to part 1');
  await sleep(150);
  await c.say("Yes, this is Tony's.", 200);
  await until(() => c.session.history.some((m) => m.role === 'assistant' && m.content === part2), 4000, 'part 2 started');
  const confirm = c.session.history.filter((m) => m.role === 'user').map((m) => m.content);
  assert.deepEqual(confirm, ["Yes, this is Tony's."], 'only her real answer was taken as the confirmation');
  await until(() => greetingDone(c), 5000, 'greeting over');
  await sleep(200);
  await c.say('Yeah, eleven to nine.');
  await until(() => world.asks.length > asks0, 5000, 'answer');
  await sleep(600);
  assert.deepEqual(asksSince(asks0), ['Yeah, eleven to nine.']);
  await c.hangUp();
});

test('THE GREETING CANNOT BE BARGED, AND LEAVES NO STALE BARGE FLAG behind it', async () => {
  setEnv();
  const c = await outboundCall(15, { greetingSec: 3 });
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  await sleep(1300); // past the first second, where a real barge-in would count
  c.turn('StartOfTurn');
  c.turn('Update', 'wait wait who is this');
  await sleep(150);
  assert.equal(c.session.bargedIn, false, 'no barge flag set under the greeting');
  assert.equal(c.session.isSpeaking, true, 'the greeting is still playing');
  c.turn('EndOfTurn', 'wait wait who is this');
  await until(() => greetingDone(c), 5000, 'greeting over');
  await c.hangUp();
});

test('A BUSINESS CALL TO A REGISTERED NUMBER: no "the person on this call is Kade", none of her memories, the business rules on, not filed under her', async () => {
  setEnv();
  const asks0 = world.asks.length;
  const mem0 = world.memoryFetches;
  const logs0 = logs.length;
  const c = await outboundCall(16, { greetingSec: 1 });
  await until(() => greetingDone(c), 4000, 'greeting over');
  await c.say('We have a sale on gummies.');
  await until(() => world.asks.length > asks0, 4000, 'turn');
  const content = String([...messagesOf(asks0)].reverse().find((m) => m.role === 'user').content);
  assert.equal(/\[The person on this call is Kade/.test(content), false, 'no caller line');
  assert.equal(/WHAT YOU REMEMBER ABOUT/.test(content), false, 'no memory cards');
  assert.match(content, /STRANGER AT A BUSINESS/);
  assert.match(content, /introduced yourself as an A I assistant, and given the recording notice/);
  assert.equal(world.memoryFetches, mem0, 'her memories were never fetched');
  await sleep(600);
  await c.hangUp();
  await until(() => logs.slice(logs0).some((l) => /transcript not filed under the number's registry owner/.test(l)), 2000, 'not filed');
});

test('A FAMILY CALL to the same number keeps the caller line and memories (unchanged)', async () => {
  setEnv();
  const asks0 = world.asks.length;
  const mem0 = world.memoryFetches;
  const c = await outboundCall(17, { greetingSec: 1, ctx: {
    business: false, tier: 'own', disclosed: false,
    greeting: "Hi! It's Kiana! I'm calling to ask if you're coming Sunday.", greetingAskAt: 0.3,
  } });
  await until(() => world.memoryFetches > mem0, 3000, 'memories fetched as before');
  await until(() => greetingDone(c), 4000, 'greeting over');
  await c.say('Yes I am, see you then.');
  await until(() => world.asks.length > asks0, 4000, 'turn');
  const content = String([...messagesOf(asks0)].reverse().find((m) => m.role === 'user').content);
  assert.match(content, /\[The person on this call is Kade/);
  assert.equal(/STRANGER AT A BUSINESS/.test(content), false);
  // Verification round: a family call is told exactly what it was told before this branch.
  assert.ok(content.includes('you have ALREADY greeted this person out loud, confirmed who they are, introduced yourself as an AI, and given the recording notice —'), 'the old words, unchanged');
  await sleep(600);
  await c.hangUp();
});

test('VOICEMAIL ON A BUSINESS CALL leaves the stranger message, not "Hey Kade, it\'s Kiana"', async () => {
  setEnv();
  const said0 = world.said.length;
  const c = await outboundCall(18, { greetingSec: 1 });
  await until(() => greetingDone(c), 4000, 'greeting over');
  await vs.handleAmdResult(c.sid, 'machine');
  const msg = world.said.slice(said0).find((l) => /Sorry I missed you/.test(l)) || '';
  // The voice proxy is handed "Katie" (fixPronunciation: her name is said Katie).
  assert.match(msg, /^Hi, this is Kiana, an A I assistant calling on behalf of a customer, (?:Kade|Katie) Murdock\. I was calling to ask if they have any deals on hemp products\. Sorry I missed you\. Bye!$/);
  assert.equal(c.ctx.voicemail, true);
  await c.hangUp();
});

test('INBOUND IS UNCHANGED: a hello said over an inbound greeting is still held and answered after it', async () => {
  setEnv();
  world.ttsSec = 3; // a greeting long enough to say something over
  const asks0 = world.asks.length;
  const logs0 = logs.length;
  const ws = new RealWebSocket(`ws://127.0.0.1:${port}/ws/media`);
  ws.on('error', () => {});
  await new Promise((r, rej) => { ws.on('open', r); ws.on('error', rej); });
  const dgBefore = dg.conns.length;
  const sid = SID(19);
  ws.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZin19', callSid: sid, customParameters: { from: HER, callSid: sid } } }));
  await until(() => T.sessionsByCallSid.has(sid) && dg.conns.length > dgBefore, 2000, 'session');
  const s = T.sessionsByCallSid.get(sid);
  const sock = dg.conns[dg.conns.length - 1].sock;
  await until(() => s.isSpeaking, 4000, 'the inbound greeting is playing');
  sock.send(JSON.stringify({ type: 'TurnInfo', event: 'StartOfTurn', transcript: '', words: [] }));
  sock.send(JSON.stringify({ type: 'TurnInfo', event: 'Update', transcript: 'Hey', words: [] }));
  await sleep(100);
  sock.send(JSON.stringify({ type: 'TurnInfo', event: 'EndOfTurn', transcript: 'Hey', words: [] }));
  await until(() => world.asks.length > asks0, 8000, 'the held hello is replayed as before');
  world.ttsSec = 1;
  assert.equal(lastUser(asks0), 'Hey');
  assert.ok(logs.slice(logs0).some((l) => /holding utterance during greeting/.test(l)), 'held during the greeting, as before');
  try { ws.send(JSON.stringify({ event: 'stop' })); } catch {}
  ws.close();
  await sleep(150);
});

/* ── Review fixes, Nov 14 2026 (same day). Each test below failed on the branch as first built. ── */

test('REVIEW D: a nod to "This call may be recorded." reaches us after the question has started on our clock; it is dropped, and her answer is the only turn', async () => {
  setEnv();
  const asks0 = world.asks.length;
  const c = await outboundCall(30, { greetingSec: 8 });
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  const qAt = c.session._greetingPart.audioAt + Math.round(8000 * ASK_AT); // the question starts here (our clock)
  // They nod at the end of the recording notice; the line and Flux put its start 0.5 s after the question began.
  await sleep(Math.max(0, qAt + 500 - Date.now()));
  await c.say('Okay.', 200);
  await until(() => greetingDone(c), 9000, 'greeting over');
  await sleep(400);
  assert.equal(world.asks.length, asks0, 'the nod is never a turn (before: it was the first turn, and the model answered "Okay.")');
  await c.say('No, we closed down last week.');
  await until(() => world.asks.length > asks0, 5000, 'her answer');
  await sleep(800);
  assert.deepEqual(asksSince(asks0), ['No, we closed down last week.']);
  await c.hangUp();
});

/* Verification round: D2, D3 and J failed when the PC was busy with other test runs (808 pass, 3 fail).
 * D2 now gives the nod a wait no busy PC outlasts, D3 measures from the bridge's own end-of-greeting
 * stamp instead of when this test noticed it, and all three count only the turns their own call ran
 * (a late request from an earlier call can no longer land in their count). */
const userTurns = (c) => c.session.history.filter((m) => m.role === 'user').map((m) => m.content);

test('REVIEW D2: a nod held over the question does not start a turn by itself; it waits and goes with the real answer', async () => {
  setEnv({ KADE_OUTBOUND_NOD_WAIT_MS: '6000', KADE_OUTBOUND_HELD_WAIT_MS: '8000' });
  const c = await outboundCall(31, { greetingSec: 6 });
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  const part = c.session._greetingPart;
  await sleep(Math.max(0, part.askAt + 300 - Date.now()));
  await c.say('Uh-huh.', 200); // a listening noise during the question: held
  await until(() => greetingDone(c), 6000, 'greeting over');
  await sleep(700);
  assert.equal(c.turnsRun(), 0, 'no turn on "Uh-huh." alone (no typing sound as she stops)');
  await c.say('We have two for one on vapes.');
  await until(() => c.turnsRun() > 0, 5000, 'the answer');
  await sleep(800);
  assert.equal(c.turnsRun(), 1, 'one turn');
  assert.deepEqual(userTurns(c), ['Uh-huh. We have two for one on vapes.'], 'the nod and the answer together');
  await c.hangUp();
});

test('REVIEW D3: a held nod with nothing after it is answered alone, once the short wait is over', async () => {
  setEnv({ KADE_OUTBOUND_NOD_WAIT_MS: '900' });
  const c = await outboundCall(32, { greetingSec: 6 });
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  await sleep(Math.max(0, c.session._greetingPart.askAt + 300 - Date.now()));
  await c.say('Yeah.', 200);
  await until(() => greetingDone(c), 6000, 'greeting over');
  const over = c.session._greetingOverAt; // the bridge's own stamp, not when this test noticed
  await until(() => c.turnsRun() > 0, 4000, 'the nod, alone');
  const turnAt = c.session._turnT0;
  assert.ok(turnAt - over >= 700, `it waited for more first (${turnAt - over} ms)`);
  await sleep(600);
  assert.equal(c.turnsRun(), 1);
  assert.deepEqual(userTurns(c), ['Yeah.']);
  await c.hangUp();
});

test('REVIEW J: "Is anybody there?" begun before our audio could reach them, or said over the greeting, is never a turn', async () => {
  setEnv();
  const logs0 = logs.length;
  const c = await outboundCall(33, { greetingSec: 4 });
  await c.at(250);
  await c.say('Hello?', 250); // starts the greeting
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  const a0 = c.session._greetingPart.audioAt;
  await sleep(Math.max(0, a0 + 300 - Date.now()));
  await c.say('Is anybody there?', 300); // begun 0.3 s after our first sound left: they cannot have heard it yet
  await sleep(Math.max(0, a0 + 1800 - Date.now()));
  await c.say('Hello? Anyone there?', 300); // over the greeting: the greeting itself answers it
  await until(() => greetingDone(c), 6000, 'greeting over');
  await sleep(400);
  assert.equal(c.turnsRun(), 0, 'neither became a turn');
  assert.ok(logs.slice(logs0).some((l) => /pickup words, not an answer/.test(l)));
  await c.say('Oh, sorry. No, no deals right now.');
  await until(() => c.turnsRun() > 0, 5000, 'answer');
  await sleep(800);
  assert.equal(c.turnsRun(), 1);
  assert.deepEqual(userTurns(c), ['Oh, sorry. No, no deals right now.']);
  await c.hangUp();
});

test('REVIEW A: "Shell, can you hold on one second?" at pickup: no "can you hear me?", no goodbye, no hang-up; the clerk coming back is a turn', async () => {
  setEnv({ KADE_OUTBOUND_QUIET_ASK_MS: '500', KADE_OUTBOUND_QUIET_END_MS: '700' });
  const asks0 = world.asks.length;
  const said0 = world.said.length;
  const c = await outboundCall(34, { greetingSec: 1 });
  await c.at(200);
  await c.say('Shell, can you hold on one second?', 300);
  await until(() => greetingDone(c), 4000, 'greeting over');
  await sleep(2600); // well past both quiet timers
  assert.equal(world.ended.includes(c.sid), false, 'not hung up on a hold');
  assert.equal(world.said.slice(said0).includes(T.QUIET_ASK_LINE), false, 'no "can you hear me?" into a hold');
  assert.equal(world.said.slice(said0).includes(T.QUIET_BYE_LINE), false);
  assert.equal(c.ctx.quietHangUp, undefined);
  const users = c.session.history.filter((m) => m.role === 'user').map((m) => m.content);
  assert.deepEqual(users, ['Shell, can you hold on one second?'], 'their pickup words are kept, before the greeting');
  await c.say('Thanks for holding, what can I do for you?');
  await until(() => world.asks.length > asks0, 5000, 'the clerk is back');
  assert.equal(lastUser(asks0), 'Thanks for holding, what can I do for you?');
  await sleep(600);
  await c.hangUp();
});

test('REVIEW A2: someone said "Hello?" at pickup and then nothing: one "can you hear me?", then minutes, not seconds, before the goodbye', async () => {
  setEnv({ KADE_OUTBOUND_QUIET_ASK_MS: '400', KADE_OUTBOUND_QUIET_END_MS: '300', KADE_OUTBOUND_QUIET_SPOKE_END_MS: '2500' });
  const said0 = world.said.length;
  const c = await outboundCall(35, { greetingSec: 1 });
  await c.at(200);
  await c.say('Hello?', 250);
  await until(() => world.said.slice(said0).includes(T.QUIET_ASK_LINE), 6000, 'the check line');
  await until(() => !c.session.isSpeaking, 3000, 'the check line played');
  await sleep(1300);
  assert.equal(world.ended.includes(c.sid), false, 'the 0.3 s goodbye timer is only for a line where nobody ever spoke');
  await until(() => world.ended.includes(c.sid), 6000, 'the goodbye, after the long wait');
  assert.equal(c.ctx.quietHangUp, true);
  assert.equal(c.ctx.quietAfterWords, true, 'the report says someone answered and then went quiet');
  await c.hangUp();
});

test('REVIEW C: "I can hear you." just after "Hello? Can you hear me?" is the person, not the line\'s echo; it is answered and the call stays up', async () => {
  setEnv({ KADE_OUTBOUND_QUIET_ASK_MS: '400', KADE_OUTBOUND_QUIET_END_MS: '1500' });
  const asks0 = world.asks.length;
  const said0 = world.said.length;
  const logs0 = logs.length;
  const c = await outboundCall(36, { greetingSec: 1 });
  await until(() => world.said.slice(said0).includes(T.QUIET_ASK_LINE), 6000, 'the check line');
  await until(() => c.session.isSpeaking, 3000, 'the check line playing');
  await until(() => !c.session.isSpeaking, 3000, 'the check line played');
  await sleep(150);
  c.turn('StartOfTurn');
  c.turn('Update', 'I can hear you.'); // within 1.5 s of the line, inside its 3 s echo window
  await sleep(250);
  c.turn('EndOfTurn', 'I can hear you.');
  await until(() => world.asks.length > asks0, 4000, 'their answer reaches the model');
  assert.equal(lastUser(asks0), 'I can hear you.');
  assert.equal(logs.slice(logs0).some((l) => /echo-dropped/.test(l)), false, 'not dropped as echo');
  await sleep(2000);
  assert.equal(world.ended.includes(c.sid), false, 'not hung up on a person who answered');
  assert.equal(world.said.slice(said0).includes(T.QUIET_BYE_LINE), false);
  await c.hangUp();
});

test('REVIEW F: an answer that comes while the check line is still being made: the line is never played, and is not in what the model sees', async () => {
  setEnv({ KADE_OUTBOUND_QUIET_ASK_MS: '400', KADE_OUTBOUND_QUIET_END_MS: '60000' });
  world.ttsDelayFor = (input) => (input === T.QUIET_ASK_LINE ? 1200 : 0);
  try {
    const asks0 = world.asks.length;
    const said0 = world.said.length;
    const c = await outboundCall(37, { greetingSec: 1 });
    await until(() => world.said.slice(said0).includes(T.QUIET_ASK_LINE), 6000, 'the check line is being made');
    await c.say('Hi, sorry, I was on the other line. What do you need?', 200);
    await until(() => world.asks.length > asks0, 4000, 'their words are a turn');
    await sleep(1800); // the line has been made by now
    assert.equal(c.session.history.some((m) => m.content === T.QUIET_ASK_LINE), false, 'the check line never went into the history');
    assert.equal(messagesOf(asks0).some((m) => m.content === T.QUIET_ASK_LINE), false, 'the model never saw it');
    await c.hangUp();
  } finally { world.ttsDelayFor = null; }
});

test('REVIEW B: they come back in the middle of the goodbye: no hang-up, and their words are a turn', async () => {
  setEnv({ KADE_OUTBOUND_QUIET_ASK_MS: '400', KADE_OUTBOUND_QUIET_END_MS: '500' });
  world.ttsSec = 3; // the lines take 3 s to say
  try {
    const asks0 = world.asks.length;
    const said0 = world.said.length;
    const c = await outboundCall(38, { greetingSec: 1 });
    await until(() => world.said.slice(said0).includes(T.QUIET_BYE_LINE), 12000, 'the goodbye');
    await until(() => c.session.isSpeaking, 3000, 'the goodbye is playing');
    await sleep(1300);
    c.turn('StartOfTurn');
    c.turn('Update', "Sorry, I'm back! What did you need?");
    await sleep(300);
    c.turn('EndOfTurn', "Sorry, I'm back! What did you need?");
    await until(() => world.asks.length > asks0, 5000, 'their words reach the model');
    await sleep(2500);
    assert.equal(world.ended.includes(c.sid), false, 'the goodbye did not hang up on them');
    assert.notEqual(c.ctx.quietHangUp, true);
    await c.hangUp();
  } finally { world.ttsSec = 1; }
});

test('REVIEW E: "Okay, thanks, bye" said over the start of the goodbye goes into the transcript and starts no second turn', async () => {
  setEnv();
  world.reply = 'Thanks so much, have a great day! [END CALL]';
  world.ttsSec = 2;
  try {
    const asks0 = world.asks.length;
    const c = await outboundCall(39, { greetingSec: 1 });
    await until(() => greetingDone(c), 4000, 'greeting over');
    await sleep(200);
    await c.say('No deals, sorry.');
    await until(() => world.asks.length > asks0, 4000, 'the answer');
    await until(() => c.session.isSpeaking && c.session.busy, 4000, 'the goodbye is playing');
    await sleep(200);
    c.turn('StartOfTurn');
    c.turn('Update', 'Okay, thanks, bye.'); // inside its first second: no barge-in
    await sleep(200);
    c.turn('EndOfTurn', 'Okay, thanks, bye.');
    await until(() => world.ended.includes(c.sid), 8000, 'the hang-up the goodbye asked for');
    await sleep(500);
    assert.equal(world.asks.length - asks0, 1, 'one model turn, not a second one right before the hang-up');
    const last = c.session.history[c.session.history.length - 1];
    assert.deepEqual([last.role, last.content], ['user', 'Okay, thanks, bye.'], 'their words are in the transcript, after the goodbye');
    await c.hangUp();
  } finally { world.reply = 'Thanks, that helps.'; world.ttsSec = 1; }
});

test('REVIEW G: an answer said over the greeting by someone who then hangs up is in the transcript the report reads', async () => {
  setEnv();
  // Held under the greeting lock, then they hang up.
  const c = await outboundCall(40, { greetingSec: 5 });
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  await sleep(Math.max(0, c.session._greetingPart.audioAt + 3500 - Date.now()));
  await c.say('No thanks, we closed down last week.', 200);
  await until(() => c.session._pending, 3000, 'held under the greeting lock');
  await c.hangUp();
  await until(() => world.callEnds.some((e) => e.sid === c.sid), 3000, 'the transcript is handed over');
  const h = world.callEnds.find((e) => e.sid === c.sid).history;
  assert.deepEqual(h.filter((m) => m.role === 'user').map((m) => m.content), ['No thanks, we closed down last week.']);
  // Still in the stitch hold (Flux's 0.9 s) when they hang up.
  const c2 = await outboundCall(41, { greetingSec: 5 });
  await until(() => c2.session._greetingStarted, 2000, 'greeting started');
  await sleep(Math.max(0, c2.session._greetingPart.audioAt + 3500 - Date.now()));
  await c2.say('Not interested.', 150);
  await sleep(200);
  await c2.hangUp();
  await until(() => world.callEnds.some((e) => e.sid === c2.sid), 3000, 'handed over');
  const h2 = world.callEnds.find((e) => e.sid === c2.sid).history;
  assert.deepEqual(h2.filter((m) => m.role === 'user').map((m) => m.content), ['Not interested.']);
});

// Family calls round (Nov 14, evening): family calls run the new first exchange again, and both are answered.
// The FAMILY CALLS tests at the end add Kade's pickup timing to both (a real check-in, "Hello?" first).
test('REVIEW H: "Good!" over a check-in greeting is an answer, and "Speaking." over "is this Holly?" is a yes', async () => {
  setEnv();
  const asks0 = world.asks.length;
  const greeting = "Hi! It's Kiana — Kade's A I. I'm calling to check in and see how you're doing — kade set up these companion calls for you.";
  const c = await outboundCall(42, { greetingSec: 5, ctx: {
    business: false, tier: 'family', disclosed: false, greeting,
    greetingAskAt: (4 + "It's Kiana — Kade's A I. ".length) / greeting.length,
  } });
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  await sleep(Math.max(0, c.session._greetingPart.audioAt + 4300 - Date.now()));
  await c.say('Good!', 200);
  await until(() => greetingDone(c), 6000, 'greeting over');
  await until(() => world.asks.length > asks0, 5000, 'her answer');
  assert.equal(lastUser(asks0), 'Good!');
  await sleep(600);
  await c.hangUp();

  const part1 = 'Hi — is this Holly?';
  const part2 = "It's Kiana — Kade's A I. I'm calling because Kade wants to know if you're coming Sunday.";
  const d = await outboundCall(43, { greetingSec: 2, ctx: {
    business: false, tier: 'family', disclosed: false, calleeName: 'Holly',
    greeting: part1, greetingAskAt: part1.indexOf('is this') / part1.length,
    greeting2: part2, greeting2Buf: Buffer.alloc(2 * SEC, 0xff), greeting2AskAt: 0.3,
  } });
  await until(() => d.session._greetingStarted, 2000, 'greeting started');
  await sleep(Math.max(0, d.session._greetingPart.audioAt + 1300 - Date.now()));
  await d.say('Speaking.', 200); // over the end of "is this Holly?"
  await until(() => d.session._confirmPhase || d.session.history.some((m) => m.content === part2), 4000, 'part 1 over');
  const part1Over = Date.now();
  await until(() => d.session.history.some((m) => m.role === 'assistant' && m.content === part2), 4000, 'part 2 started');
  assert.ok(Date.now() - part1Over < 2500, `part 2 followed her yes (${Date.now() - part1Over} ms), not the 6 s silence timer`);
  assert.deepEqual(d.session.history.filter((m) => m.role === 'user').map((m) => m.content), ['Speaking.']);
  await d.hangUp();
});

test('REVIEW I: an answer held over the greeting does not wait 4 s behind a noise that opened a turn and closed with no words', async () => {
  setEnv();
  const asks0 = world.asks.length;
  const c = await outboundCall(44, { greetingSec: 5 });
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  const g0 = c.session._greetingPart.audioAt;
  await sleep(Math.max(0, g0 + 3000 - Date.now()));
  await c.say('No, they closed down last week.', 200); // held
  await sleep(Math.max(0, g0 + 4700 - Date.now()));
  c.turn('StartOfTurn'); // a breath or line noise opens a turn just before the greeting ends
  await until(() => greetingDone(c), 4000, 'greeting over');
  const over = Date.now();
  await sleep(300);
  c.turn('EndOfTurn', ''); // ...and closes with no words
  await until(() => world.asks.length > asks0, 5000, 'the held answer');
  const waited = world.asks[asks0].at - over;
  assert.ok(waited < 1500, `the answer went as soon as the noise closed (${waited} ms; before: about 4000)`);
  await sleep(600);
  assert.deepEqual(asksSince(asks0), ['No, they closed down last week.']);
  await c.hangUp();
});

test('flushHeldWords: what was still waiting at hang-up becomes their last turn; inbound calls are untouched', async () => {
  let lateDispatch = 0;
  const s = { outbound: true, _strangerGreeting: true, history: [{ role: 'assistant', content: 'Hi.' }], _heldForNext: 'No thanks,', _pending: 'we closed.', _fluxCarry: 'Bye.', _spokenWindow: [] };
  s._fluxGraceTimer = setTimeout(() => { lateDispatch += 1; }, 50); // the stitch hold would hand "Bye." over again
  s._fluxDispatch = () => { lateDispatch += 1; };
  T.flushHeldWords(s);
  assert.deepEqual(s.history[1], { role: 'user', content: 'No thanks, we closed. Bye.' });
  assert.equal(s._pending, null);
  await sleep(120);
  assert.equal(lateDispatch, 0, 'the flushed words are not handed over a second time into the ended call');
  assert.equal(s._fluxDispatch, null);
  T.flushHeldWords(s);
  assert.equal(s.history.length, 2, 'only once (stop and close both fire)');
  const inbound = { outbound: false, history: [], _pending: 'Hey' };
  T.flushHeldWords(inbound);
  assert.equal(inbound.history.length, 0);
});

/* Family calls round (Nov 14, evening): the flush is on for every outbound call again (a check-in's last
 * words reach its report too). The switch still gives the old path exactly. On 422e758 the family part
 * fails (it was off for family calls there). */
test('VERIFY 11: the hang-up flush is part of the new first exchange: on a family call too, and never with KADE_OUTBOUND_FIRST_ROUND=0', () => {
  const family = { outbound: true, _strangerGreeting: false, history: [], _pending: 'See you Sunday.', _spokenWindow: [] };
  T.flushHeldWords(family);
  assert.deepEqual(family.history, [{ role: 'user', content: 'See you Sunday.' }], 'a family call keeps their last words (on 422e758: dropped)');
  setEnv({ KADE_OUTBOUND_FIRST_ROUND: '0' });
  try {
    for (const greeted of [true, false]) {
      const s = { outbound: true, _strangerGreeting: greeted, history: [], _pending: 'We closed.', _spokenWindow: [] };
      T.flushHeldWords(s);
      assert.equal(s.history.length, 0, `the switch gives the old path exactly (${greeted ? 'business' : 'family'})`);
    }
  } finally { setEnv({ KADE_OUTBOUND_FIRST_ROUND: undefined }); }
});

test('greetingWordKind sorts what people say over a greeting', () => {
  const k = T.greetingWordKind;
  for (const t of ['Hello?', 'hello hello', 'Hi.', 'Good morning', 'Good afternoon!', 'How can I help you?', 'Is anybody there?', 'Hello, anyone there?', 'You there?', 'Hello? Can you hear me?']) assert.equal(k(t), 'hello', t);
  for (const t of ['Who is this?', "Who's calling?", 'Hi, who is this?', 'What is this about?']) assert.equal(k(t), 'who', t);
  for (const t of ['Yeah.', 'Okay', 'Uh-huh', 'mm-hmm', 'Sure.', 'all right', 'Yes?', 'Speaking.', 'It is.', 'Yes, this is.']) assert.equal(k(t), 'nod', t);
  for (const t of ['No.', 'Nope.', 'Nine.', 'Shell, this is Mike.', 'We closed down last week.', 'Yeah, we do.', 'Good!', 'Good, good.', 'Pretty good.', 'Hey, you.']) assert.equal(k(t), 'words', t);
  // Verification round: nothing to answer (only fillers, or stray words line noise turns into).
  for (const t of ['um', 'Mm.', 'You.', 'The.', 'Mm. You.', 'Mm. You. The.', 'Uh, the.']) assert.equal(k(t), 'noise', t);
  for (const t of ['Shell, can you hold on one second?', 'One moment please.', 'Please hold.', 'Hang on, let me get the manager.']) assert.ok(T.HOLD_RE.test(t), t);
  for (const t of ['We closed down last week.', 'Hello?', 'Who is this?']) assert.equal(T.HOLD_RE.test(t), false, t);
});

/* ── Verification round, Nov 14 2026 (an independent review of the branch with its own simulated calls).
 * Each test below failed on the branch head f2b5c48. ── */

const PART1 = "Hi, this is Kiana, an A I assistant calling on behalf of a customer, Kade Murdock. Is this Tony's Pizza?";
const PART2 = "Thanks! This call may be recorded. I'm calling to ask whether you are open on Sunday.";
const VM_RE = /Sorry I missed you/;

test('VERIFY 1a: voicemail found while the machine is still talking, before the greeting started: no greeting plays over the message', async () => {
  setEnv({ KADE_OUTBOUND_GREETING_MAX_WAIT_MS: '5000' }); // the live cap
  world.ttsSec = 3;
  world.ttsDelayFor = (input) => (VM_RE.test(input) ? 800 : 0); // the voice takes a moment to make the message
  try {
    const c = await outboundCall(60, { greetingSec: 3, ctx: { greetingBuf: Buffer.alloc(3 * SEC, GREET_BYTE) } });
    await c.at(300);
    await c.words("Hi, it's Mike, leave a message.", { gapMs: 200, close: false }); // a machine: Flux keeps the turn open
    await c.at(1800);
    const amdAt = Date.now() - c.t0;
    vs.handleAmdResult(c.sid, 'machine'); // Twilio: machine_end_beep (not awaited: it waits for the whole message)
    await c.at(3100); // Flux closes the machine's turn after the message has started
    c.turn('EndOfTurn', "Hi, it's Mike, leave a message.");
    await sleep(3000);
    assert.equal(c.framesAfter('greet', amdAt + 100), 0, 'no greeting audio once voicemail was found (before: it started over the message)');
    assert.ok(c.framesAfter('voice', amdAt) > 0, 'the voicemail message itself played');
    await c.hangUp();
  } finally { world.ttsSec = 1; world.ttsDelayFor = null; }
});

test('VERIFY 1b: a two-part greeting answered by a machine: part 2 never plays into the voicemail', async () => {
  setEnv();
  world.ttsSec = 3;
  world.ttsDelayFor = (input) => (VM_RE.test(input) ? 800 : 0);
  try {
    const c = await outboundCall(61, { greetingSec: 2, ctx: {
      calleeName: "Tony's Pizza", greeting: PART1, greetingAskAt: PART1.indexOf('Is this') / PART1.length,
      greetingBuf: Buffer.alloc(2 * SEC, GREET_BYTE),
      greeting2: PART2, greeting2Buf: Buffer.alloc(2 * SEC, GREET_BYTE), greeting2AskAt: PART2.indexOf("I'm calling") / PART2.length,
    } });
    await c.at(300);
    /* Family calls round: "..., please leave a message." now holds the greeting for the machine verdict
     * (FAMILY CALLS 7), so part 1 would never start and this test would not reach part 2. A first sentence
     * with no voicemail words still starts part 1, which is what this test needs. */
    await c.words("Hi, you've reached Tony's Pizza on Main Street.", { gapMs: 150, eotMs: 300 }); // part 1 starts on it
    await until(() => c.framesAfter('greet', 0) > 0, 3000, 'part 1 started');
    await sleep(800);
    const amdAt = Date.now() - c.t0;
    vs.handleAmdResult(c.sid, 'machine');
    await sleep(7600); // past the 6 s wait after part 1, which used to play part 2 anyway
    assert.equal(c.framesAfter('greet', amdAt + 700), 0, 'no greeting part after voicemail was found (before: part 2 played 6 s later)');
    assert.equal(c.session.history.some((m) => m.content === PART2), false, 'part 2 never went into the history');
    await c.hangUp();
  } finally { world.ttsSec = 1; world.ttsDelayFor = null; }
});

const NONSTOP = 'hello yeah this is Mike at the Shell on Main sorry I am with a customer right now what is this about we have gas and snacks and some CBD stuff and the vapes are on sale this week';

test('VERIFY 2a: someone who talks from pickup through the whole greeting gets an answer when they stop (before: filed as pickup words, and silence)', async () => {
  setEnv({ KADE_OUTBOUND_QUIET_ASK_MS: '1500', KADE_OUTBOUND_QUIET_END_MS: '60000' });
  const asks0 = world.asks.length;
  const c = await outboundCall(62, { greetingSec: 3 });
  await c.at(300);
  await c.words(NONSTOP, { gapMs: 220, eotMs: 300 }); // one Flux turn, about 7 s, past the cap and the 3 s greeting
  await until(() => asksSince(asks0).includes(NONSTOP), 4000, 'their words are answered');
  assert.ok(c.session._greetingStartedAt && greetingDone(c), 'the greeting played (it started at the cap)');
  assert.equal(c.turnsRun(), 1);
  await sleep(500);
  await c.hangUp();
});

test('VERIFY 2b: someone who starts talking as the greeting starts and keeps going past its end gets an answer', async () => {
  setEnv({ KADE_OUTBOUND_QUIET_ASK_MS: '1500', KADE_OUTBOUND_QUIET_END_MS: '60000' });
  const asks0 = world.asks.length;
  const c = await outboundCall(63, { greetingSec: 3 });
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  await sleep(Math.max(0, c.session._greetingPart.audioAt + 300 - Date.now())); // inside the 0.7 s pickup window
  const talk = 'yeah hi sorry we are super busy today we have a line out the door what do you need I can maybe help you real quick';
  await c.words(talk, { gapMs: 220, eotMs: 300 });
  await until(() => asksSince(asks0).includes(talk), 4000, 'their words are answered');
  await sleep(500);
  await c.hangUp();
});

test('VERIFY 3a: a "Hello?" begun in the last second of the greeting, handed over after it, is a turn (they did not hear it)', async () => {
  setEnv();
  const asks0 = world.asks.length;
  const c = await outboundCall(64, { greetingSec: 4 });
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  await sleep(Math.max(0, c.session._greetingPart.endAt - 700 - Date.now()));
  c.turn('StartOfTurn');
  c.turn('Update', 'Hello?');
  await until(() => greetingDone(c), 4000, 'greeting over');
  await sleep(250);
  c.turn('EndOfTurn', 'Hello?'); // Flux closes it after the greeting; the 0.9 s hold follows
  await until(() => asksSince(asks0).includes('Hello?'), 4000, 'answered (before: dropped, and the call went silent)');
  await sleep(500);
  await c.hangUp();
});

test('VERIFY 3b: a hello dropped as said over the greeting, but handed over after it, still leaves the quiet watch on', async () => {
  setEnv({ KADE_OUTBOUND_QUIET_ASK_MS: '1200', KADE_OUTBOUND_QUIET_END_MS: '60000', KADE_OUTBOUND_QUIET_SPOKE_END_MS: '60000' });
  const said0 = world.said.length;
  const logs0 = logs.length;
  const c = await outboundCall(65, { greetingSec: 4 });
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  await sleep(Math.max(0, c.session._greetingPart.audioAt + 1200 - Date.now())); // mid-greeting: not their pickup, not the end
  c.turn('StartOfTurn');
  c.turn('Update', 'Hello?');
  await until(() => greetingDone(c), 5000, 'greeting over');
  await sleep(200);
  c.turn('EndOfTurn', 'Hello?');
  await until(() => logs.slice(logs0).some((l) => /said over the greeting \(handed over after it\)/.test(l)), 3000, 'dropped');
  await until(() => world.said.slice(said0).includes(T.QUIET_ASK_LINE), 4000, 'the check line still comes (before: never)');
  await c.hangUp();
});

test('VERIFY 4: a business pickup that Flux splits in two ("Thank you for calling Shell on Main." / "This is Mike, how can I help you?") is never a turn', async () => {
  setEnv();
  for (const [n, gap] of [[66, 800], [67, 1500]]) {
    const asks0 = world.asks.length;
    const c = await outboundCall(n, { greetingSec: 4 });
    await c.at(200);
    await c.words('Thank you for calling Shell on Main.', { gapMs: 120, eotMs: 250 });
    await until(() => c.session._greetingStarted, 2000, 'the greeting starts on the first part');
    await sleep(gap); // a natural pause, then Flux opens the second part
    await c.words('This is Mike, how can I help you?', { gapMs: 120, eotMs: 250 });
    await until(() => greetingDone(c), 6000, 'greeting over');
    await sleep(700);
    assert.equal(c.turnsRun(), 0, `gap ${gap} ms: no turn as the greeting ends (before: "This is Mike, how can I help you?" was answered)`);
    await c.say("Uh, no, we don't do deals on that.");
    await until(() => world.asks.length > asks0, 5000, 'the answer');
    await sleep(600);
    assert.deepEqual(asksSince(asks0), ["Uh, no, we don't do deals on that."], `gap ${gap} ms`);
    const kept = c.session.history.filter((m) => m.role === 'user').map((m) => m.content);
    assert.ok(kept.includes('This is Mike, how can I help you?'), 'the second part is kept as what they said first');
    await c.hangUp();
  }
});

test('VERIFY 4 guard: a phone menu after the pickup line still reaches the model after the greeting, once', async () => {
  setEnv();
  const asks0 = world.asks.length;
  const c = await outboundCall(68, { greetingSec: 6 });
  await c.at(200);
  await c.words('Thank you for calling Shell on Main.', { gapMs: 120, eotMs: 250 });
  await sleep(900);
  await c.words('For store hours, press 1.', { gapMs: 120, eotMs: 250 });
  await sleep(900);
  await c.words('For the manager, press 2.', { gapMs: 120, eotMs: 250 });
  await until(() => greetingDone(c), 6000, 'greeting over');
  await until(() => world.asks.length > asks0, 6000, 'a turn for the menu');
  await sleep(1500);
  const users = asksSince(asks0);
  assert.equal(users.length, 1, 'one turn');
  assert.match(users[0], /press 1\. For the manager, press 2\.$/, 'the menu options reach the model, once each');
  await c.hangUp();
});

const FAMILY_GREETING = "Hi! It's Kiana! I'm calling to ask if you're coming Sunday.";
const OLD_CLAIM = 'you have ALREADY greeted this person out loud, confirmed who they are, introduced yourself as an AI, and given the recording notice —';
const OLD_HELLO_LINE = 'If they just said "hello" and you were not given a name, you may briefly confirm you reached the right place. ';

/* Family calls round (Nov 14, evening): a family call runs the NEW first exchange again (the FAMILY CALLS
 * tests at the end). This test keeps the old path's proof, now under KADE_OUTBOUND_FIRST_ROUND=0: the
 * switch puts a family call back exactly where it was. */
test('VERIFY 5a: with KADE_OUTBOUND_FIRST_ROUND=0 a family call runs the old first exchange: the 0.9 s hold before the greeting, the hello held and answered after it, the old prompt lines', async () => {
  setEnv({ KADE_OUTBOUND_FIRST_ROUND: '0' });
  try {
    const logs0 = logs.length;
    const c = await outboundCall(69, { greetingSec: 2, ctx: { business: false, tier: 'own', disclosed: false, greeting: FAMILY_GREETING, greetingAskAt: 0.3 } });
    await c.at(200);
    await c.say('Hello?', 200); // closed at about 0.4 s
    await until(() => c.session._greetingStarted, 3000, 'greeting started');
    const startedAfter = c.session._greetingStartedAt - c.t0;
    assert.ok(startedAfter >= 900, `the start timer, as before (+${startedAfter} ms; the new path starts it at once on the hello)`);
    await until(() => c.turnsRun() > 0, 6000, 'the held hello is answered after the greeting, as before');
    assert.deepEqual(userTurns(c), ['Hello?']);
    assert.ok(logs.slice(logs0).some((l) => /holding utterance during greeting/.test(l)), 'held the old way');
    assert.ok(c.session.outboundSuffix.includes(OLD_CLAIM), 'the claim it was told before');
    assert.ok(c.session.outboundSuffix.includes(OLD_HELLO_LINE), 'the hello line it was told before');
    assert.equal(c.session.outboundSuffix.includes('Your greeting already asked your question'), false);
    await sleep(600);
    await c.hangUp();
  } finally { setEnv({ KADE_OUTBOUND_FIRST_ROUND: undefined }); }
});

test('VERIFY 5b: a wellness check-in where nobody speaks: no "Can you hear me?" and no hang-up, as before (registered or not)', async () => {
  setEnv({ KADE_OUTBOUND_QUIET_ASK_MS: '400', KADE_OUTBOUND_QUIET_END_MS: '300' });
  const said0 = world.said.length;
  const wellness = { scheduleId: 'w1', notifyUserId: '6a3cba4d0b0afa92194e42f7', targetName: 'Holly', topics: null };
  const checkin = "Hi! It's Kiana — Kade's A I. I'm calling to check in and see how you're doing — kade set up these companion calls for you.";
  const family = await outboundCall(70, { greetingSec: 1, ctx: { business: false, tier: 'family', disclosed: false, greeting: checkin, greetingAskAt: 0.3, wellness } });
  // A check-in to a number nobody registered plays the stranger greeting, and is still a check-in.
  const unregistered = await outboundCall(71, { greetingSec: 1, ctx: { business: false, tier: 'stranger', disclosed: true, wellness } });
  await until(() => greetingDone(family) && greetingDone(unregistered), 4000, 'greetings over');
  await sleep(2200);
  assert.equal(world.said.slice(said0).includes(T.QUIET_ASK_LINE), false, 'no check line (before: "Hello? Can you hear me?")');
  assert.equal(world.said.slice(said0).includes(T.QUIET_BYE_LINE), false);
  assert.equal(world.ended.includes(family.sid) || world.ended.includes(unregistered.sid), false, 'never hung up on (before: hung up)');
  assert.equal(family.ctx.quietHangUp, undefined);
  await family.hangUp();
  await unregistered.hangUp();
});

/* Family calls round (Nov 14, evening): the goodbye rule is part of the new first exchange, so a family
 * call has it now: "Okay, love you, bye!" said over the character's goodbye goes into the transcript and starts
 * no second turn. On 422e758 a family call dropped those words (busy+speaking) and the first half fails
 * there. The switch still gives the old rule. */
test('VERIFY 5c: a family call has the goodbye rule now (words over the goodbye go into the transcript, no second turn); KADE_OUTBOUND_FIRST_ROUND=0 gives the old rule', async () => {
  world.reply = 'See you Sunday! [END CALL]';
  world.ttsSec = 2;
  try {
    setEnv();
    const c = await outboundCall(72, { greetingSec: 1, ctx: { business: false, tier: 'own', disclosed: false, greeting: FAMILY_GREETING, greetingAskAt: 0.3 } });
    await until(() => greetingDone(c), 4000, 'greeting over');
    await sleep(200);
    await c.say('Yes, I am coming.');
    await until(() => c.turnsRun() > 0, 4000, 'turn');
    await until(() => c.session.isSpeaking && c.session.busy, 4000, 'the goodbye is playing');
    await sleep(200);
    c.turn('StartOfTurn');
    c.turn('Update', 'Okay, love you, bye!'); // inside its first second: no barge-in
    await sleep(200);
    c.turn('EndOfTurn', 'Okay, love you, bye!');
    await until(() => world.ended.includes(c.sid), 8000, 'the goodbye hung up');
    await sleep(500);
    assert.equal(c.turnsRun(), 1, 'one model turn, not a second one right before the hang-up');
    const last = c.session.history[c.session.history.length - 1];
    assert.deepEqual([last.role, last.content], ['user', 'Okay, love you, bye!'], 'her words are in the transcript, after the goodbye (on 422e758: dropped)');
    await c.hangUp();

    setEnv({ KADE_OUTBOUND_FIRST_ROUND: '0' });
    world.ttsSec = 1;
    const d = await outboundCall(76, { greetingSec: 1, ctx: { business: false, tier: 'own', disclosed: false, greeting: FAMILY_GREETING, greetingAskAt: 0.3 } });
    await until(() => greetingDone(d), 4000, 'greeting over');
    await sleep(200);
    await d.say('Yes, I am coming.');
    await until(() => d.turnsRun() > 0, 4000, 'turn');
    await until(() => world.ended.includes(d.sid), 6000, 'the goodbye hung up, as before');
    assert.equal(d.session._hangingUpAt == null, true, 'with the switch off the goodbye rule is off');
    await d.hangUp();
  } finally { world.reply = 'Thanks, that helps.'; world.ttsSec = 1; setEnv({ KADE_OUTBOUND_FIRST_ROUND: undefined }); }
});

test('VERIFY 6: one thought handed over once when its second part ends 1.6 to 2.5 s after the first (before: twice, the first request thrown away)', async () => {
  setEnv();
  world.llmDelay = 1500;
  try {
    const asks0 = world.asks.length;
    const logs0 = logs.length;
    const c = await outboundCall(73, { greetingSec: 1 });
    await until(() => greetingDone(c), 4000, 'greeting over');
    await sleep(600);
    await c.say('No.', 250);              // EndOfTurn 1: the 2.5 s cap timer and the 0.9 s hold start
    await sleep(500);
    await c.say('We closed down.', 1150); // EndOfTurn 2 about 1.65 s later: hold due at +2.55 s, cap at +2.5 s
    await sleep(4500);
    assert.deepEqual(asksSince(asks0), ['No. We closed down.'], 'one model request');
    const seen = messagesOf(world.asks.length - 1).filter((m) => m.role === 'user').map((m) => String(m.content).split('\n\n[')[0].split('\n[')[0]);
    assert.equal(seen.filter((t) => t === 'No. We closed down.').length, 1, 'their words once');
    assert.equal(logs.slice(logs0).some((l) => /aborting mid-gen/.test(l)), false, 'no request thrown away');
    await c.hangUp();
  } finally { world.llmDelay = 400; }
});

test('VERIFY 7: line noise that opens wordless turns does not hold the greeting past the start timer', async () => {
  setEnv();
  const c = await outboundCall(74, { greetingSec: 1 });
  for (const t of [400, 1300, 2200]) { await c.at(t); c.turn('StartOfTurn'); } // no words, never closed
  await until(() => c.session._greetingStarted, 4000, 'greeting started');
  const at = c.session._greetingStartedAt - c.t0;
  assert.ok(at < 1500, `the greeting starts at the 1 s timer (+${at} ms; before: at the 2.5 s cap)`);
  await c.hangUp();
});

test('VERIFY 8: stray words that line noise turns into ("Mm.", "You.", "The.") over the greeting start no turn', async () => {
  setEnv();
  const c = await outboundCall(75, { greetingSec: 5 });
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  const a0 = c.session._greetingPart.audioAt;
  await sleep(Math.max(0, a0 + 1200 - Date.now()));
  await c.say('Mm.', 200);
  await sleep(600);
  await c.say('You.', 200);
  await sleep(600);
  c.turn('StartOfTurn');
  await sleep(300);
  c.turn('EndOfTurn', '');
  await sleep(500);
  await c.say('The.', 200);
  await until(() => greetingDone(c), 6000, 'greeting over');
  await sleep(1500);
  assert.equal(c.turnsRun(), 0, 'no turn on noise (before: a turn on "Mm. You. Mm. You. The.")');
  await c.hangUp();
});

/* ── Family calls, Nov 14 2026 (evening). Kade: the first exchange must work on EVERY outbound call, and
 * the greeting words for family and check-ins stay exactly as they are. Family calls, a character calling
 * its own person, and wellness check-ins run the new first exchange; the quiet watch stays off for them.
 * A business greeting waits for a long pickup line (up to 10 s), and a pickup that sounds like a voicemail
 * machine waits for Twilio's verdict. These run on the LIVE clock (the 2.5 s start, the 10 s cap, the
 * 0.9 s Flux hold), not the shortened one. Every test here that changes behaviour fails on main 422e758;
 * the ones that pin behaviour that did not change (4, 8) say so. ── */

const og = require('./outbound-greeting');
const LIVE = { KADE_OUTBOUND_GREETING_WAIT_MS: undefined, KADE_OUTBOUND_GREETING_MAX_WAIT_MS: undefined };
// Kade's test purpose, word for word from the Nov 14 logs (outbound-greeting.test.js uses the same).
const HEMP = "Kade wants to know if you're running any sales or clearance deals on hemp products right now, especially THCP vapes and disposables. If so, what do you have in stock and what are the prices?";
const NEW_HELLO_LINE = 'Your greeting already asked your question.';
const CHECKIN_PURPOSE = "check in and see how you're doing — Kade set up these companion calls for you"; // server.js fireWellnessCall
const WELLNESS = { scheduleId: 'w-test', notifyUserId: '6a3cba4d0b0afa92194e42f7', targetName: 'Holly', topics: null };
const CLERK_7S = 'Thank you for calling Shell on Main Street this is Mike we have a special on coffee and donuts all week long and the car wash is half off what can I do for you today';
const CLERK_12S = `${CLERK_7S} we also have propane exchange and lottery and the hot food case has pizza and chicken and the restroom is around the back by the ice machine`;

/** The call context server.js /outbound-call builds, with the words outbound-greeting.js composes. */
function composedCtx(o) {
  const g = og.composeOutboundGreeting({ agentName: 'Kiana', userName: 'Kade Murdock', agentId: 'agent_kiana_test', calleeName: null, ...o });
  return {
    business: g.business, tier: g.tier, disclosed: g.disclosed, purpose: o.purpose, calleeName: o.calleeName || null,
    greeting: g.greeting, greetingAskAt: g.askAt, greeting2: g.greeting2, greeting2AskAt: g.ask2At, ask: g.ask,
  };
}
/** Kade's test: her own number, Kiana as its own character, no business flag (the "own" greeting). */
const herOwnCtx = () => composedCtx({ purpose: HEMP, calleeRec: { name: 'Kade', agentId: 'agent_kiana_test' } });
/** A wellness check-in to registered family (fireWellnessCall always names her: the two-part greeting). */
const checkinCtx = () => ({ ...composedCtx({ purpose: CHECKIN_PURPOSE, calleeName: 'Holly', calleeRec: { name: 'Holly', agentId: 'agent_harley_test' } }), wellness: WELLNESS, to: HOLLY });
/** Her "Hello?" exactly as on Kade's call: words at 1.5 s, Flux closed the turn at 1.8 s, and the old path
 *  held it 0.9 s more (handed over at 2.7 s, just after the 2.5 s start had begun the greeting). */
async function kadesHello(c) {
  await c.at(1300); c.turn('StartOfTurn');
  await c.at(1500); c.turn('Update', 'Hello?');
  await c.at(1800); c.turn('EndOfTurn', 'Hello?');
}
const saidPart2 = (c) => c.session.history.some((m) => m.role === 'assistant' && m.content === c.ctx.greeting2);
const typingFrom = (c, at) => c.frames.filter((f) => f.kind === 'typing' && f.at >= at).length;

test("FAMILY CALLS 1: KADE'S OWN-NUMBER CALL (Kiana as its own character), her exact timing: the greeting starts on her hello, the hello is never replayed as her answer, no typing sound as the greeting ends, her answer is the one turn, and the prompt line that invited the repeated question is gone", async () => {
  setEnv(LIVE);
  const ctx = herOwnCtx();
  assert.equal(ctx.tier, 'own');
  assert.equal(ctx.greeting, "Hi! It's Kiana! I've got a quick question — kade wants to know if you're running any sales or clearance deals on hemp products right now, especially THCP vapes and disposables. If so, what do you have in stock and what are the prices?", 'the own-number greeting, word for word as before');
  const c = await outboundCall(80, { ctx: { ...ctx, greetingBuf: Buffer.alloc(4 * SEC, GREET_BYTE) } });
  await kadesHello(c);
  await until(() => c.session._greetingStarted, 3000, 'greeting started');
  const startedAt = c.session._greetingStartedAt - c.t0;
  assert.ok(startedAt < 2300, `the greeting starts on her finished hello (+${startedAt} ms; on 422e758 the 2.5 s timer started it and her hello was held)`);
  await until(() => greetingDone(c), 8000, 'greeting over');
  const overAt = Date.now();
  await sleep(1500);
  assert.equal(c.turnsRun(), 0, 'no turn as the greeting ends (on 422e758 her "Hello?" was replayed as her answer)');
  assert.equal(typingFrom(c, overAt), 0, 'no typing sound as Kiana stops talking');
  await c.say('No, they closed down last week.');
  await until(() => c.turnsRun() > 0, 5000, 'her answer');
  await sleep(1500);
  assert.equal(c.turnsRun(), 1, 'one turn');
  assert.deepEqual(userTurns(c), ['No, they closed down last week.'], 'her answer, once; the hello is not in the history');
  assert.equal(c.session.history.find((m) => m.role === 'assistant').content, ctx.greeting, 'the greeting in the history is the one she heard');
  assert.ok(c.session.outboundSuffix.includes(NEW_HELLO_LINE), 'Kiana is told her greeting already asked the question');
  assert.equal(c.session.outboundSuffix.includes(OLD_HELLO_LINE), false, 'no "you may briefly confirm you reached the right place" (it invited the repeat)');
  assert.ok(c.session.outboundSuffix.includes(OLD_CLAIM), 'what a family call is told it already said is unchanged');
  await c.hangUp();
});

test('FAMILY CALLS 2: A WELLNESS CHECK-IN with Kade\'s pickup timing: her "Hello?" is not the answer to "Hi — is this Holly?", her "Yes." is; "Good!" said over "how you\'re doing" is answered once, after the greeting', async () => {
  setEnv(LIVE);
  const ctx = checkinCtx();
  assert.equal(ctx.tier, 'family');
  assert.equal(ctx.greeting, 'Hi — is this Holly?', 'the check-in greeting, word for word as before');
  assert.equal(ctx.greeting2, "It's Kiana — Kade's A I. I'm calling to check in and see how you're doing — Kade set up these companion calls for you.");
  const c = await outboundCall(81, { from: HOLLY, ctx: { ...ctx, greetingBuf: Buffer.alloc(Math.round(1.5 * SEC), GREET_BYTE), greeting2Buf: Buffer.alloc(5 * SEC, GREET_BYTE) } });
  await kadesHello(c);
  await until(() => c.session._confirmPhase || saidPart2(c), 6000, 'part 1 over');
  await sleep(300);
  await c.say('Yes.', 250);
  await until(() => saidPart2(c), 5000, 'part 2 started');
  const p2 = c.session._greetingPart;
  await sleep(Math.max(0, p2.audioAt + 3600 - Date.now())); // just after "... see how you're doing"
  await c.say('Good!', 200);
  await until(() => greetingDone(c), 6000, 'greeting over');
  await until(() => c.turnsRun() > 0, 5000, 'her answer');
  await sleep(1500);
  assert.equal(c.turnsRun(), 1, 'one turn');
  assert.deepEqual(userTurns(c), ['Yes.', 'Good!'], 'her "Yes." confirmed it and "Good!" is the one turn (on 422e758 her pickup "Hello?" was the confirmation, then "Yes. Good!" one turn)');
  assert.equal(c.session.history.filter((m) => m.role === 'assistant').slice(0, 2).map((m) => m.content).join(' | '), `${ctx.greeting} | ${ctx.greeting2}`, 'both parts, word for word');
  await c.hangUp();
});

test('FAMILY CALLS 3: "Hi — is this Holly?" answered "Speaking." right after it, Kade\'s pickup timing: "Speaking." is the yes (even within 1.6 s of her hello), part 2 follows at once, and "Speaking." is never answered as a turn', async () => {
  setEnv(LIVE);
  const c = await outboundCall(82, { from: HOLLY, ctx: { ...checkinCtx(), greetingBuf: Buffer.alloc(Math.round(1.2 * SEC), GREET_BYTE), greeting2Buf: Buffer.alloc(4 * SEC, GREET_BYTE) } });
  await kadesHello(c);
  await until(() => c.session._greetingStarted, 3000, 'part 1 started');
  const p1 = c.session._greetingPart;
  await sleep(Math.max(0, p1.audioAt + 1400 - Date.now())); // 0.2 s after part 1 (1.2 s) ended
  const saidAt = Date.now();
  await c.say('Speaking.', 250);
  await until(() => saidPart2(c), 8000, 'part 2 started');
  const waited = Date.now() - saidAt;
  assert.ok(waited < 2500, `part 2 followed her yes (${waited} ms; dropped as more of her pickup, it waited about 5 s for the 6 s timer)`);
  assert.deepEqual(userTurns(c), ['Speaking.'], 'her "Speaking." is the confirmation (on 422e758 her pickup "Hello?" was)');
  await until(() => greetingDone(c), 6000, 'greeting over');
  await sleep(1500);
  assert.equal(c.turnsRun(), 0, 'no turn on "Speaking." (on 422e758 it was held under part 2 and answered after it)');
  await c.say("I'm doing all right, thanks.");
  await until(() => c.turnsRun() > 0, 5000, 'her answer');
  await sleep(1200);
  assert.equal(c.turnsRun(), 1);
  assert.deepEqual(userTurns(c), ['Speaking.', "I'm doing all right, thanks."]);
  await c.hangUp();
});

test('FAMILY CALLS 4: A CHECK-IN PICKUP WITH 30 SECONDS OF SILENCE, live timers: no "Can you hear me?", no goodbye, no hang-up, for a family check-in and one to a number nobody registered. A silent business call in the same 30 s is asked and hung up on, so the watch was live. (Unchanged: passes on 422e758 too.)', async () => {
  setEnv({ ...LIVE, KADE_OUTBOUND_QUIET_ASK_MS: undefined, KADE_OUTBOUND_QUIET_END_MS: undefined, KADE_OUTBOUND_QUIET_SPOKE_END_MS: undefined });
  const business = await outboundCall(83, { greetingSec: 1 });
  const family = await outboundCall(84, { from: HOLLY, ctx: { ...checkinCtx(), greetingBuf: Buffer.alloc(Math.round(1.5 * SEC), 0xff), greeting2Buf: Buffer.alloc(3 * SEC, 0xff) } });
  const strangerCheckin = composedCtx({ purpose: CHECKIN_PURPOSE, calleeName: 'Holly', calleeRec: null });
  assert.equal(strangerCheckin.tier, 'stranger', 'a check-in to an unregistered number opens with the A I greeting, as before');
  const unregistered = await outboundCall(85, { from: '+14175550188', ctx: { ...strangerCheckin, wellness: WELLNESS, to: '+14175550188', greetingBuf: Buffer.alloc(3 * SEC, 0xff), greeting2Buf: Buffer.alloc(3 * SEC, 0xff) } });
  await sleep(Math.max(0, unregistered.t0 + 30000 - Date.now()));
  for (const c of [family, unregistered]) {
    assert.ok(saidPart2(c), 'both parts of the greeting played');
    assert.equal(c.session.history.some((m) => m.content === T.QUIET_ASK_LINE || m.content === T.QUIET_BYE_LINE), false, 'no "Can you hear me?", no goodbye');
    assert.equal(world.ended.includes(c.sid), false, 'never hung up on');
    assert.equal(c.ctx.quietHangUp, undefined);
    assert.equal(c.turnsRun(), 0);
  }
  await until(() => world.ended.includes(business.sid), 5000, 'the control: a silent business call is hung up on by the same live watch');
  assert.ok(business.session.history.some((m) => m.content === T.QUIET_ASK_LINE), 'and asked "Can you hear me?" first');
  for (const c of [business, family, unregistered]) await c.hangUp();
});

test('FAMILY CALLS 5: A 7 SECOND BUSINESS PICKUP LINE: the greeting waits for it and starts as it ends (on 422e758: at 5 s, over the clerk); the line is kept as what they said first, and their answer is the one turn', async () => {
  setEnv(LIVE);
  const c = await outboundCall(86, { ctx: { greetingBuf: Buffer.alloc(3 * SEC, GREET_BYTE) } });
  await c.at(300);
  await c.words(CLERK_7S, { gapMs: 190, eotMs: 300 }); // one Flux turn, about 7 s of words
  const closedAt = Date.now();
  await until(() => c.session._greetingStarted, 3000, 'greeting started');
  const startedAt = c.session._greetingStartedAt - c.t0;
  assert.ok(startedAt >= 7000, `the greeting waited for the whole line (+${startedAt} ms; on 422e758 it started at +5000, over the clerk)`);
  assert.ok(c.session._greetingStartedAt - closedAt < 800, 'and started as soon as the line ended');
  assert.equal(c.frames.filter((f) => f.kind === 'greet' && f.at < closedAt - 300).length, 0, 'no greeting audio while the clerk was talking');
  await until(() => greetingDone(c), 6000, 'greeting over');
  await sleep(800);
  assert.equal(c.turnsRun(), 0, 'the pickup line is not a turn');
  await c.say("Uh, no, we don't do deals on that.");
  await until(() => c.turnsRun() > 0, 5000, 'their answer');
  await sleep(1000);
  assert.equal(c.turnsRun(), 1);
  assert.deepEqual(userTurns(c), [CLERK_7S, "Uh, no, we don't do deals on that."], 'the pickup line first (before the greeting), then the answer');
  assert.equal(c.session.history.find((m) => m.role === 'assistant').content, GREETING, 'the business greeting, word for word');
  await c.hangUp();
});

test('FAMILY CALLS 6: A 12 SECOND BUSINESS PICKUP LINE: the greeting starts at the 10 s cap, over them (on 422e758: at 5 s); the line stays what they said first, and their answer after the greeting is the one turn', async () => {
  setEnv(LIVE);
  const c = await outboundCall(87, { greetingSec: 4 });
  await c.at(300);
  await c.words(CLERK_12S, { gapMs: 190, eotMs: 300 }); // one Flux turn, about 12 s of words
  const startedAt = c.session._greetingStartedAt - c.t0;
  assert.ok(startedAt >= 9900 && startedAt < 11000, `started at the cap while they were still talking (+${startedAt} ms; on 422e758: +5000)`);
  await until(() => greetingDone(c), 8000, 'greeting over');
  await sleep(800);
  assert.equal(c.turnsRun(), 0, 'the pickup line is not a turn');
  await c.say('Sorry, what was that about hemp?');
  await until(() => c.turnsRun() > 0, 5000, 'their answer');
  await sleep(1000);
  assert.equal(c.turnsRun(), 1);
  assert.deepEqual(userTurns(c), [CLERK_12S, 'Sorry, what was that about hemp?']);
  await c.hangUp();
});

test('FAMILY CALLS 7: VOICEMAIL ON A FAMILY CALL, the live order: the machine talks, Flux closes its message, and Twilio\'s verdict comes 0.7 s later (the beep). No greeting at all, so none into the recording; the family voicemail message plays; no model turn, no typing. A business call in the same order too', async () => {
  setEnv(LIVE);
  const famCtx = composedCtx({ purpose: 'Kade wants to know if you are coming Sunday', calleeRec: { name: 'Holly', agentId: 'agent_harley_test' } });
  assert.equal(famCtx.greeting, "Hi! It's Kiana — Kade's A I. I'm calling because kade wants to know if you are coming Sunday.", 'the family greeting, word for word as before');
  const fam = await outboundCall(88, { from: HOLLY, ctx: { ...famCtx, to: HOLLY, greetingBuf: Buffer.alloc(5 * SEC, GREET_BYTE) } });
  const biz = await outboundCall(89, { ctx: { greetingBuf: Buffer.alloc(5 * SEC, GREET_BYTE) } });
  const machine = async (c, words) => {
    await c.at(400);
    await c.words(words, { gapMs: 250, eotMs: 300 });
    c.machineDoneAt = Date.now() - 300 - c.t0; // its last words; the beep and the recording follow
    await sleep(700);
    c.amdAt = Date.now() - c.t0;
    vs.handleAmdResult(c.sid, 'machine'); // not awaited: it waits for the whole message
  };
  await Promise.all([
    machine(fam, "Hi, you've reached Holly. I can't come to the phone right now, so please leave a message after the tone."),
    machine(biz, 'Thank you for calling Shell on Main. Our hours are six to eleven every day. Please leave a message after the tone.'),
  ]);
  await sleep(2500);
  const famVm = world.said.find((l) => /it's Kiana — (?:Kade|Katie)'s A I\. I was calling to/.test(l));
  assert.ok(famVm, 'the family voicemail message was made');
  for (const c of [fam, biz]) {
    const who = c === fam ? 'family' : 'business';
    assert.equal(c.framesAfter('greet', c.machineDoneAt), 0, `${who}: no greeting into the recording (on 422e758 it played on past the machine's message until the verdict cut it)`);
    assert.equal(c.framesAfter('greet', 0), 0, `${who}: no greeting at all, not even over the machine's message`);
    assert.ok(c.framesAfter('voice', c.amdAt) > 0, `${who}: the voicemail message played`);
    assert.equal(c.turnsRun(), 0, `${who}: no model turn`);
    assert.equal(c.frames.filter((f) => f.kind === 'typing').length, 0, `${who}: no typing sound`);
    assert.equal(c.ctx.voicemail, true);
  }
  for (const c of [fam, biz]) await c.hangUp();
});

test('FAMILY CALLS 8: KADE_OUTBOUND_FIRST_ROUND=0 puts every outbound call back on the old path: her own-number call answers the replayed "Hello?" again, a check-in takes it as the answer to "is this Holly?", and a clerk\'s long pickup gets the greeting at the 2.5 s start. (The old path itself is unchanged: passes on 422e758 too.)', async () => {
  setEnv({ ...LIVE, KADE_OUTBOUND_FIRST_ROUND: '0' });
  try {
    const own = await outboundCall(90, { ctx: { ...herOwnCtx(), greetingBuf: Buffer.alloc(2 * SEC, 0xff) } });
    const checkin = await outboundCall(91, { from: HOLLY, ctx: { ...checkinCtx(), greetingBuf: Buffer.alloc(Math.round(1.5 * SEC), 0xff), greeting2Buf: Buffer.alloc(2 * SEC, 0xff) } });
    const clerk = await outboundCall(92, { greetingSec: 2 });
    await Promise.all([kadesHello(own), kadesHello(checkin), clerk.at(300).then(() => clerk.words(CLERK_7S, { gapMs: 190, eotMs: 300 }))]);
    await until(() => own.turnsRun() > 0, 8000, 'her pickup hello answered as her reply, the old way');
    assert.deepEqual(userTurns(own), ['Hello?']);
    assert.ok(own.session.outboundSuffix.includes(OLD_HELLO_LINE), 'the old prompt line');
    await until(() => saidPart2(checkin), 8000, 'part 2');
    assert.equal(userTurns(checkin)[0], 'Hello?', 'the old path takes the pickup hello as the answer to "is this Holly?"');
    const at = clerk.session._greetingStartedAt - clerk.t0;
    assert.ok(at >= 2400 && at < 3200, `the old start, over the clerk (+${at} ms)`);
    await sleep(500);
    for (const c of [own, checkin, clerk]) await c.hangUp();
  } finally { setEnv({ KADE_OUTBOUND_FIRST_ROUND: undefined }); }
});

test('FAMILY CALLS 9: who runs what. The new first exchange: every outbound call (business, stranger, own person, family, check-in), never inbound, never with the switch off. The quiet watch: only calls that open with the A I greeting, never a check-in. And what a voicemail machine says', () => {
  const s = (ctx) => ({ outbound: true, _strangerGreeting: T.strangerGreetingCall(ctx) });
  const business = { tier: 'stranger', business: true };
  const stranger = { tier: 'stranger', business: false };
  const own = { tier: 'own', business: false };
  const family = { tier: 'family', business: false };
  const checkin = { tier: 'family', business: false, wellness: WELLNESS };
  const strangerCheckin = { tier: 'stranger', business: false, wellness: WELLNESS };
  for (const ctx of [business, stranger, own, family, checkin, strangerCheckin]) assert.equal(T.firstRoundOn(s(ctx)), true, JSON.stringify(ctx));
  assert.equal(T.firstRoundOn({ outbound: false }), false, 'inbound');
  assert.deepEqual([business, stranger, own, family, checkin, strangerCheckin].map(T.strangerGreetingCall), [true, true, false, false, false, false], 'the quiet watch');
  setEnv({ KADE_OUTBOUND_FIRST_ROUND: '0' });
  try {
    for (const ctx of [business, own, checkin]) assert.equal(T.firstRoundOn(s(ctx)), false, 'switch off');
  } finally { setEnv({ KADE_OUTBOUND_FIRST_ROUND: undefined }); }
  setEnv({ KADE_OUTBOUND_FIRST_ROUND: 'business' });
  try {
    assert.deepEqual([business, stranger, own, family, checkin, strangerCheckin].map((ctx) => T.firstRoundOn(s(ctx))), [true, true, false, false, false, false], '"business": the split main 422e758 had');
  } finally { setEnv({ KADE_OUTBOUND_FIRST_ROUND: undefined }); }
  for (const t of ["Hi, you've reached Holly. Please leave a message after the tone.", 'The person you are trying to reach is not available.',
    'Your call has been forwarded to an automated voice messaging system.', 'At the tone, please record your message.',
    "Hey it's Holly, leave me a message!", 'Hi, this is Holly, sorry I missed your call.', "I can't come to the phone right now",
    'I’m not available right now', 'You have reached the voicemail of Shell on Main', 'The mailbox is full']) assert.equal(T.voicemailCue(t), true, t);
  for (const t of ['Hello?', 'Shell, this is Mike.', CLERK_12S, 'Speaking.', 'Good!', 'Who is this?', 'Shell, can you hold on one second?',
    'Sorry, the manager stepped out, can I take a message?', 'Yes, this is Holly.', NONSTOP, 'Hello? Hello? Who is this? I can barely hear you.']) assert.equal(T.voicemailCue(t), false, t);
});

test('FAMILY CALLS 10: a pickup that sounds like a voicemail machine, and no machine verdict ever comes: the greeting still starts, once the hold after its last words is over (shortened here to 1.5 s), and the person is answered as usual', async () => {
  setEnv({ KADE_OUTBOUND_VOICEMAIL_HOLD_MS: '1500' });
  const logs0 = logs.length;
  const famCtx = composedCtx({ purpose: 'Kade wants to know if you are coming Sunday', calleeRec: { name: 'Holly', agentId: 'agent_harley_test' } });
  const c = await outboundCall(93, { from: HOLLY, ctx: { ...famCtx, to: HOLLY, greetingBuf: Buffer.alloc(2 * SEC, GREET_BYTE) } });
  await c.at(200);
  await c.words("Holly's phone, she can't come to the phone right now.", { gapMs: 120, eotMs: 250 });
  const closedAt = Date.now();
  await until(() => c.session._greetingStarted, 5000, 'the greeting starts after all');
  const after = c.session._greetingStartedAt - closedAt;
  assert.ok(after >= 1200 && after < 2600, `it waited for a verdict first, then started (${after} ms after the line; on 422e758 it started at once, or at the 1 s timer)`);
  assert.ok(logs.slice(logs0).some((l) => /sounds like a voicemail machine/.test(l)) && logs.slice(logs0).some((l) => /no voicemail verdict came, so the greeting starts/.test(l)));
  await until(() => greetingDone(c), 5000, 'greeting over');
  await sleep(300);
  await c.say("Sorry, it's Holly, I grabbed it. What's up?");
  await until(() => c.turnsRun() > 0, 5000, 'answered');
  await sleep(800);
  assert.equal(c.turnsRun(), 1);
  assert.deepEqual(userTurns(c), ["Holly's phone, she can't come to the phone right now.", "Sorry, it's Holly, I grabbed it. What's up?"]);
  await c.hangUp();
});

test('FAMILY CALLS 11: KADE_OUTBOUND_FIRST_ROUND=business rolls back only the family calls part: her own-number call takes the replayed "Hello?" as her answer again (main 422e758), while a business call in the same order keeps the new first exchange', async () => {
  setEnv({ KADE_OUTBOUND_FIRST_ROUND: 'business' });
  try {
    const own = await outboundCall(94, { ctx: { ...herOwnCtx(), greetingBuf: Buffer.alloc(2 * SEC, 0xff) } });
    const biz = await outboundCall(95, { greetingSec: 2 });
    // KADE'S CALL order on the shortened clock: the turn opens at 0.8 s, the start timer fires at 1 s, Flux closes it at 1.4 s.
    const hello = async (c) => { await c.at(800); c.turn('StartOfTurn'); await sleep(100); c.turn('Update', 'Hello?'); await c.at(1400); c.turn('EndOfTurn', 'Hello?'); };
    await Promise.all([hello(own), hello(biz)]);
    await until(() => own.turnsRun() > 0, 8000, 'the family call answers the replayed hello, as on 422e758');
    assert.deepEqual(userTurns(own), ['Hello?']);
    assert.ok(own.session.outboundSuffix.includes(OLD_HELLO_LINE));
    await until(() => greetingDone(biz), 6000, 'the business greeting is over');
    await sleep(1500);
    assert.equal(biz.turnsRun(), 0, 'the business call never answers the pickup hello');
    assert.ok(biz.session.outboundSuffix.includes(NEW_HELLO_LINE));
    for (const c of [own, biz]) await c.hangUp();
  } finally { setEnv({ KADE_OUTBOUND_FIRST_ROUND: undefined }); }
});
