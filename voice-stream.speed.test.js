/* voice-stream.speed.test.js — Oct 30 2026.
 *
 * Kade: "Inworld originally just had a speed, 1x 1.2x whatever, up and down ...
 * so people can hear it how you intended, or they can slow or speed it to how
 * they like." One list, the character's number as the start point, and the
 * listener's number kept apart from it so it survives a character switch.
 *
 * Runs the REAL module against a pretend voice proxy, so what each test checks
 * is the number that actually left the bridge, not a field on a session.
 * Two small blocks that only run deep inside a call's start are extracted from
 * the shipped source, the same pattern as voice-stream.carry.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const vm = require('vm');
const WebSocket = require('ws');

delete process.env.DEEPGRAM_API_KEY; // no STT: nothing here may reach out
delete process.env.PHONE_BASE_RATE;
process.env.KADE_CALL_INGEST_SECRET = 'speed-test-secret';

const vs = require('./voice-stream.js');
const {
  CallSession, WebCallSession, handleUtterance, nextRateStop, rateLine, helloListenerRate, RATE_LADDER, BASE_RATE,
} = vs._test;

const SRC = fs.readFileSync(require.resolve('./voice-stream.js'), 'utf8').replace(/\r\n/g, '\n');

// A WAV with an empty data chunk: real enough for wavDurationMs, plays in 0 ms.
const EMPTY_WAV = (() => {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(0, 40);
  return b;
})();

let spoken = []; // every request the pretend proxy heard, oldest first
let saves = 0;
let agentTts = new Map();
let users = new Map();
let plans = new Map();
const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    spoken.push({ url: req.url, caller: req.headers['x-kade-caller'], body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.end(req.url.includes('telephony=1') ? Buffer.alloc(160, 0xff) : EMPTY_WAV);
  });
});

const AGENTS = [
  { id: 'a-kiana', name: 'Kiana' },
  { id: 'a-harley', name: 'Harley' },
  { id: 'a-della', name: 'Della' },
];
const openWs = () => ({ readyState: WebSocket.OPEN, send() {}, close() {}, on() {} });
const webUser = (extra = {}) => ({ agentId: 'a-kiana', agentName: 'Kiana', lcEmail: 'x@example.test', ...extra });
const webCall = (extra) => new WebCallSession('web:x@example.test', webUser(extra), openWs(), global._vsConfig);
const lastSaid = () => spoken[spoken.length - 1];

test.before(async () => {
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  global._vsConfig = {
    ttsProxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    ttsModel: 'tts-1-mini',
    defaultVoice: 'Default',
    defaultAgent: 'a-kiana',
    defaultAgentName: 'Kiana',
    get users() { return users; },
    saveUsers() { saves += 1; },
    getAgentTts: (id) => agentTts.get(id) || null,
    getAgents: async () => AGENTS,
    findVoice: () => null,
    getCallPlan: (id) => plans.get(id) || null,
    markCallAnswered() {},
  };
});
test.after(async () => { await new Promise((r) => proxy.close(r)); });
test.beforeEach(() => {
  spoken = []; saves = 0; agentTts = new Map(); users = new Map(); plans = new Map();
});

// ── the list ──────────────────────────────────────────────────────────────────
test('the ladder is exactly the list people see', () => {
  assert.deepStrictEqual(RATE_LADDER, [0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5]);
  assert.strictEqual(BASE_RATE, 1);
});

test('faster walks every stop from the bottom to the top, slower walks back', () => {
  let r = 0.75;
  const up = [r];
  while (r < 1.5) { r = nextRateStop(r, 'faster'); up.push(r); }
  assert.deepStrictEqual(up, RATE_LADDER);
  const down = [r];
  while (r > 0.75) { r = nextRateStop(r, 'slower'); down.push(r); }
  assert.deepStrictEqual(down, [...RATE_LADDER].reverse());
});

test('a saved number off the list goes to the nearest stop in that direction', () => {
  assert.strictEqual(nextRateStop(1.25, 'faster'), 1.3);
  assert.strictEqual(nextRateStop(1.25, 'slower'), 1.2);
  assert.strictEqual(nextRateStop(0.95, 'faster'), 1);
  assert.strictEqual(nextRateStop(0.95, 'slower'), 0.9);
  assert.strictEqual(nextRateStop(0.65, 'faster'), 0.75);
  assert.strictEqual(nextRateStop(1.35, 'slower'), 1.3);
});

test('past either end the speed stays put, and a saved 0.5 is not pushed up by "slower"', () => {
  assert.strictEqual(nextRateStop(1.5, 'faster'), 1.5);
  assert.strictEqual(nextRateStop(0.75, 'slower'), 0.75);
  assert.strictEqual(nextRateStop(0.5, 'slower'), 0.5);
  assert.strictEqual(nextRateStop(0.65, 'slower'), 0.65);
});

test('the confirmation says the number; the top and bottom keep their lines', () => {
  assert.strictEqual(rateLine('faster', 1.2, true), 'Okay, 1.2 times. Go ahead.');
  assert.strictEqual(rateLine('slower', 0.9, true), 'Okay, 0.9 times. Go ahead.');
  assert.strictEqual(rateLine('faster', 1.5, true), "Okay, 1.5 times. That's as fast as I go! Go ahead.");
  assert.strictEqual(rateLine('faster', 1.5, false), "That's as fast as I go! Go ahead.");
  assert.strictEqual(rateLine('slower', 0.75, true), "Okay, 0.75 times. That's my slowest. Go ahead.");
  assert.strictEqual(rateLine('slower', 0.5, false), "That's my slowest. Go ahead.");
  assert.strictEqual(rateLine('normal', 1.2, true), 'Back to my normal pace, 1.2 times. Go ahead.');
  // Coming back up from below the bottom of the list is an ordinary step.
  assert.strictEqual(rateLine('faster', 0.75, true), 'Okay, 0.75 times. Go ahead.');
});

test('the hello speed is a number clamped to 0.5-1.5, and anything else is no choice', () => {
  assert.strictEqual(helloListenerRate(1.3), 1.3);
  assert.strictEqual(helloListenerRate(9), 1.5);
  assert.strictEqual(helloListenerRate(0.1), 0.5);
  for (const junk of [undefined, null, '1.3', true, NaN, Infinity]) {
    assert.strictEqual(helloListenerRate(junk), undefined, String(junk));
  }
});

// ── spoken commands, heard at the proxy ───────────────────────────────────────
test('with no numbers anywhere the first step starts from 1x, not the old 1.1', async () => {
  let s = webCall();
  await handleUtterance(s, 'speak faster');
  assert.strictEqual(lastSaid().body.speed, 1.1);
  assert.strictEqual(lastSaid().body.input, 'Okay, 1.1 times. Go ahead.');
  s = webCall();
  await handleUtterance(s, 'slow down');
  assert.strictEqual(lastSaid().body.speed, 0.9);
});

test("the first step starts from the character's own number", async () => {
  const s = webCall({ characterRate: 1.2 });
  await handleUtterance(s, 'speak faster');
  assert.strictEqual(lastSaid().body.speed, 1.3);
  assert.strictEqual(s.characterRate, 1.2, 'the character keeps its number');
  assert.strictEqual(s.listenerRate, 1.3);
});

test("normal clears the listener's number and returns to the character's, saying it", async () => {
  const s = webCall({ characterRate: 1.2, rate: 0.8 });
  await handleUtterance(s, 'normal speed');
  assert.strictEqual(s.listenerRate, null);
  assert.strictEqual(lastSaid().body.speed, 1.2);
  assert.strictEqual(lastSaid().body.input, 'Back to my normal pace, 1.2 times. Go ahead.');
});

test('normal with no character number sends no speed at all and says 1 times', async () => {
  const s = webCall({ rate: 1.4 });
  await handleUtterance(s, 'normal speed');
  assert.ok(!('speed' in lastSaid().body));
  assert.strictEqual(lastSaid().body.input, 'Back to my normal pace, 1 times. Go ahead.');
});

test('saying faster at the top stays at the top with the old line', async () => {
  const s = webCall({ rate: 1.5 });
  await handleUtterance(s, 'faster');
  assert.strictEqual(lastSaid().body.speed, 1.5);
  assert.strictEqual(lastSaid().body.input, "That's as fast as I go! Go ahead.");
});

// ── the character switch ──────────────────────────────────────────────────────
test("a web listener's number survives a mid-call character switch", async () => {
  agentTts.set('a-harley', { voiceId: 'Harley', rate: 1.4, at: Date.now() });
  const s = webCall({ rate: 0.9, characterRate: 1.2 });
  await handleUtterance(s, 'switch to Harley');
  assert.strictEqual(s.agentId, 'a-harley');
  assert.strictEqual(s.rate, 0.9);
  assert.strictEqual(lastSaid().body.speed, 0.9);
  // ...and "normal" afterwards means the NEW character's number.
  await handleUtterance(s, 'normal speed');
  assert.strictEqual(lastSaid().body.speed, 1.4);
});

test('a number said on this call survives a switch too', async () => {
  agentTts.set('a-harley', { voiceId: 'Harley', rate: 1.4, at: Date.now() });
  const s = webCall({ characterRate: 1.2 });
  await handleUtterance(s, 'speak faster');
  await handleUtterance(s, 'switch to Harley');
  assert.strictEqual(lastSaid().body.speed, 1.3);
});

test('with no listener number the new character brings its own, or none', async () => {
  agentTts.set('a-harley', { voiceId: 'Harley', rate: 1.4, at: Date.now() });
  agentTts.set('a-della', { voiceId: 'Della', rate: null, at: Date.now() });
  const s = webCall({ characterRate: 1.2 });
  await handleUtterance(s, 'switch to Harley');
  assert.strictEqual(lastSaid().body.speed, 1.4);
  await handleUtterance(s, 'switch to Della');
  assert.ok(!('speed' in lastSaid().body));
  assert.strictEqual(s.characterRate, null);
});

// ── a phone caller's saved rule ───────────────────────────────────────────────
function phoneCall(row) {
  users.set('+15550100', row);
  return new CallSession('MZ1', 'CA1', '+15550100', row, openWs(), global._vsConfig);
}

test("a phone caller's saved number beats the character's and stays per caller", async () => {
  agentTts.set('a-kiana', { voiceId: 'Kiana', rate: 1.4, at: Date.now() });
  agentTts.set('a-harley', { voiceId: 'Harley', rate: 0.9, at: Date.now() });
  const row = { name: 'Holly', agentId: 'a-kiana', agentName: 'Kiana', rate: 1.25 };
  const s = phoneCall(row);
  assert.strictEqual(s.rate, 1.25, 'an off-list saved number keeps working');
  await handleUtterance(s, 'speak faster');
  assert.strictEqual(lastSaid().body.speed, 1.3);
  assert.ok(lastSaid().url.includes('telephony=1'));
  assert.strictEqual(lastSaid().caller, 'bridge-phone');
  assert.strictEqual(row.rate, 1.3, 'saved on the row');
  assert.strictEqual(saves, 1);
  await handleUtterance(s, 'switch to Harley');
  assert.strictEqual(lastSaid().body.speed, 1.3);
  assert.strictEqual(row.rate, 1.3);
});

test('normal clears the phone row and returns to the character, also after a switch', async () => {
  agentTts.set('a-kiana', { voiceId: 'Kiana', rate: 1.4, at: Date.now() });
  agentTts.set('a-harley', { voiceId: 'Harley', rate: 0.9, at: Date.now() });
  const row = { name: 'Holly', agentId: 'a-kiana', agentName: 'Kiana', rate: 1.2 };
  const s = phoneCall(row);
  await handleUtterance(s, 'normal speed');
  assert.strictEqual(row.rate, null);
  assert.strictEqual(lastSaid().body.speed, 1.4);
  await handleUtterance(s, 'switch to Harley');
  assert.strictEqual(lastSaid().body.speed, 0.9);
});

test('a phone caller with no saved number hears the character and starts from it', async () => {
  agentTts.set('a-kiana', { voiceId: 'Kiana', rate: 1.2, at: Date.now() });
  const row = { name: 'Holly', agentId: 'a-kiana', agentName: 'Kiana' };
  const s = phoneCall(row);
  assert.strictEqual(s.rate, 1.2);
  assert.strictEqual(s.listenerRate, null);
  await handleUtterance(s, 'slow down');
  assert.strictEqual(lastSaid().body.speed, 1.1);
  assert.strictEqual(row.rate, 1.1);
});

// ── the two blocks that only run deep inside a call's start ───────────────────
function grabBlock(anchor, endAnchor) {
  const a = SRC.indexOf(anchor);
  assert.ok(a > -1, `anchor not found: ${anchor}`);
  const b = SRC.indexOf(endAnchor, a);
  assert.ok(b > -1, `end anchor not found: ${endAnchor}`);
  return SRC.slice(a, b + endAnchor.length);
}

test('outbound keeps its rule: an agent with a number beats the callee, and normal returns to it', async () => {
  const block = grabBlock('session.characterRate = typeof outboundCtx.rate', 'session.rate = outboundCtx.rate;\n            }');
  const row = { name: 'Holly', agentId: 'a-kiana', agentName: 'Kiana', rate: 0.9 };
  const s = phoneCall(row);
  vm.runInNewContext(block, { session: s, outboundCtx: { rate: 1.3 } });
  assert.strictEqual(s.rate, 1.3);
  await handleUtterance(s, 'normal speed');
  assert.strictEqual(lastSaid().body.speed, 1.3);
});

test('outbound with no agent number leaves the callee where they were', () => {
  const block = grabBlock('session.characterRate = typeof outboundCtx.rate', 'session.rate = outboundCtx.rate;\n            }');
  const s = phoneCall({ name: 'Holly', agentId: 'a-kiana', agentName: 'Kiana', rate: 0.9 });
  vm.runInNewContext(block, { session: s, outboundCtx: { rate: null } });
  assert.strictEqual(s.rate, 0.9);
  assert.strictEqual(s.listenerRate, 0.9);
});

test('the late builder lookup fills the character number and never beats the listener', () => {
  const block = grabBlock('if (session.characterRate == null && typeof tts.rate', 'session.listenerRate ?? session.characterRate;\n              }');
  const plain = webCall();
  vm.runInNewContext(block, { session: plain, tts: { rate: 1.2 } });
  assert.strictEqual(plain.rate, 1.2);
  const chose = webCall({ rate: 0.9 });
  vm.runInNewContext(block, { session: chose, tts: { rate: 1.2 } });
  assert.strictEqual(chose.rate, 0.9);
  assert.strictEqual(chose.characterRate, 1.2);
});

// ── the real hello, over a real socket ────────────────────────────────────────
function ticket(fields) {
  const body = Buffer.from(JSON.stringify({
    email: 'x@example.test', uid: 'u1', name: 'Kade', agentId: 'a-kiana', agentName: 'Kiana',
    exp: Date.now() + 60000, ...fields,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.KADE_CALL_INGEST_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// An agent-initiated call is the one web lane that speaks first, so its greeting
// shows what the hello did to the number without needing a microphone.
async function greetingSpeed(ticketFields, helloFields) {
  plans.set('plan1', { userId: 'u1', agentName: 'Kiana', userName: 'Kade', purpose: 'a test' });
  const server = http.createServer();
  const wss = vs.attachWebVoice(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/web-voice`);
  try {
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.send(JSON.stringify({ type: 'hello', ticket: ticket(ticketFields), callPlanId: 'plan1', ...helloFields }));
    for (let i = 0; i < 200 && !spoken.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(spoken.length, 1, 'the greeting reached the proxy');
    return spoken[0];
  } finally {
    ws.close();
    wss.close();
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
  }
}

test("hello speed is the listener's number over the ticket's character number", async () => {
  const said = await greetingSpeed({ voiceId: 'Kiana', rate: 1.2 }, { speed: 1.3 });
  assert.strictEqual(said.body.speed, 1.3);
  assert.strictEqual(said.caller, 'bridge-voice');
});

test("no hello speed plays the character's number", async () => {
  const said = await greetingSpeed({ voiceId: 'Kiana', rate: 1.2 }, {});
  assert.strictEqual(said.body.speed, 1.2);
});

test('hello speed is clamped, and junk counts as no choice', async () => {
  assert.strictEqual((await greetingSpeed({ voiceId: 'Kiana', rate: 1.2 }, { speed: 9 })).body.speed, 1.5);
  spoken = [];
  assert.strictEqual((await greetingSpeed({ voiceId: 'Kiana', rate: 1.2 }, { speed: 'fast' })).body.speed, 1.2);
});

test('a ticket that named a voice and no rate stays at no rate, whatever the builder cache says', async () => {
  // The fork's resolver decided (a listener's own voice, say). The bridge must not undo it.
  agentTts.set('a-kiana', { voiceId: 'Kiana', rate: 1.4, at: Date.now() });
  const said = await greetingSpeed({ voiceId: 'Their Own Voice', rate: null }, {});
  assert.ok(!('speed' in said.body));
  assert.strictEqual(said.body.voice, 'Their Own Voice');
});

test('a ticket with no voice at all still falls back to the builder cache', async () => {
  agentTts.set('a-kiana', { voiceId: 'Kiana', rate: 1.4, at: Date.now() });
  const said = await greetingSpeed({}, {});
  assert.strictEqual(said.body.speed, 1.4);
  assert.strictEqual(said.body.voice, 'Kiana');
});
