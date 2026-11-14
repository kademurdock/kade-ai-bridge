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
const SEC = 8000; // mu-law 8 kHz: one byte per sample
const world = { said: [], asks: [], ended: [], memoryFetches: 0, llmDelay: 400, reply: 'Thanks, that helps.', ttsSec: 1 };
const ctxBySid = new Map();

let httpServer, ttsServer, llmServer, port;
const cfg = {
  defaultVoice: 'TestVoice', defaultAgent: 'agent_kiana_test', defaultAgentName: 'Kiana', ttsModel: 'tts-test', proxySecret: 'offline',
  endCall: async (sid) => { world.ended.push(sid); },
  getAgents: async () => [], saveUsers: () => {}, seenCallNumbers: new Set(), saveSeenCall: () => {},
  getOutboundCtx: (sid) => ctxBySid.get(sid) || null,
  fetchCallMemories: async () => { world.memoryFetches += 1; return 'Kade likes long walks.'; },
};

test.before(async () => {
  dg.server = new RealWebSocket.Server({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => dg.server.on('listening', r));
  dg.port = dg.server.address().port;
  dg.server.on('connection', (sock) => { dg.conns.push({ sock }); });
  ttsServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let input = '?';
      try { input = JSON.parse(raw).input; } catch {}
      world.said.push(input);
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
  const users = new Map([[HER, { name: 'Kade', agentId: 'agent_kiana_test', agentName: 'Kiana', lcEmail: 'her@example.invalid' }]]);
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

const GREETING = "Hi, this is Kiana, an A I assistant calling for Kade, one of our users. This call may be recorded. I'm calling to ask if you have any deals on hemp products right now.";
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
  const call = { sid, ws, ctx, media: [], clears: 0 };
  ws.on('message', (m) => {
    try { const j = JSON.parse(m); if (j.event === 'media') call.media.push(Date.now()); if (j.event === 'clear') call.clears += 1; } catch {}
  });
  ws.on('error', () => {});
  await new Promise((r, rej) => { ws.on('open', r); ws.on('error', rej); });
  ws.send(JSON.stringify({ event: 'connected' }));
  call.t0 = Date.now();
  ws.send(JSON.stringify({ event: 'start', start: { streamSid: `MZ${sid.slice(-6)}`, callSid: sid, customParameters: { from: HER, callSid: sid, outbound: '1' } } }));
  await until(() => T.sessionsByCallSid.has(sid) && dg.conns.length > dgBefore, 2000, 'session + listening socket');
  call.session = T.sessionsByCallSid.get(sid);
  const sock = dg.conns[dg.conns.length - 1].sock;
  call.turn = (event, transcript = '') => sock.send(JSON.stringify({ type: 'TurnInfo', event, transcript, words: [] }));
  /** They say something: the turn opens, words come, and Flux closes it endMs later. */
  call.say = async (text, endMs = 300) => { call.turn('StartOfTurn'); call.turn('Update', text); await sleep(endMs); call.turn('EndOfTurn', text); };
  call.at = (ms) => sleep(Math.max(0, ms - (Date.now() - call.t0)));
  call.hangUp = async () => { try { ws.send(JSON.stringify({ event: 'stop' })); } catch {} try { ws.close(); } catch {} await sleep(150); };
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
  await sleep(400);
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
  setEnv();
  const asks0 = world.asks.length;
  const c = await outboundCall(9, { greetingSec: 6 });
  await until(() => c.session._greetingStarted, 2000, 'greeting started');
  const g0 = c.session._greetingPart.audioAt;
  await sleep(Math.max(0, g0 + 500 - Date.now()));
  await c.say('Okay.', 200);  // a nod during the disclosure
  await sleep(Math.max(0, g0 + 4200 - Date.now()));
  await c.say('Yeah.', 200);  // said to the question
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
  const part1 = "Hi, this is Kiana, an A I assistant calling for Kade, one of our users. Is this Tony's Pizza?";
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
  assert.match(content, /you have ALREADY greeted this person out loud —/, 'it is not told it gave an A I notice it never gave');
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
  assert.match(msg, /^Hi, this is Kiana, an A I assistant calling for (?:Kade|Katie), one of our users\. I was calling to ask if they have any deals on hemp products\. Sorry I missed you\. Bye!$/);
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

test('greetingWordKind sorts what people say over a greeting', () => {
  const k = T.greetingWordKind;
  for (const t of ['Hello?', 'hello hello', 'Hi.', 'Good morning', 'How can I help you?', 'um', 'Speaking.']) assert.equal(k(t), 'hello', t);
  for (const t of ['Who is this?', "Who's calling?", 'Hi, who is this?', 'What is this about?']) assert.equal(k(t), 'who', t);
  for (const t of ['Yeah.', 'Okay', 'Uh-huh', 'mm-hmm', 'Sure.', 'all right', 'Yes?']) assert.equal(k(t), 'nod', t);
  for (const t of ['No.', 'Shell, this is Mike.', 'We closed down last week.', 'Yeah, we do.']) assert.equal(k(t), 'words', t);
});
