/* voice-stream.billcaller.test.js — Sep 25 2026, Part 291 review F11 / F12 / F40.
 *
 * Behind the fork's KADE_VOICE_BILL_REAL switch, a call's model turns are billed
 * to the person on the line only when a turn says billCaller: true. Only a call
 * the caller started sets it (inbound phone, app/web voice); outbound calls and
 * direct Spotter (Gemini Live) sessions never do. The voice_chat estimate says
 * metadata.viaFork = true for exactly those calls, so the fork zeroes only them.
 *
 * Same extraction pattern as voice-stream.carry.test.js: the SHIPPED source is
 * pulled out of the real file and run, never transcribed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync(require.resolve('./voice-stream.js'), 'utf8').replace(/\r\n/g, '\n');

function grab(anchor, endAnchor, { inclusive = true } = {}) {
  const a = SRC.indexOf(anchor);
  assert.ok(a > -1, `anchor not found: ${anchor.slice(0, 50)}`);
  const b = SRC.indexOf(endAnchor, a);
  assert.ok(b > -1, `end anchor not found: ${endAnchor.slice(0, 50)}`);
  return SRC.slice(a, inclusive ? b + endAnchor.length : b);
}

const ASK_STREAM_BODY = grab('function askStreamBody(session, fields) {', '\n}\n');

function context(extra = {}) {
  const ctx = { String, Boolean, Array, Object, Math, Date, Number, JSON, console: { log() {}, warn() {} }, process: { env: {} }, ...extra };
  vm.createContext(ctx);
  vm.runInContext(ASK_STREAM_BODY + '\nthis.askStreamBody = askStreamBody;', ctx);
  return ctx;
}

test('askStreamBody adds billCaller only for a session that is the caller\'s own call', () => {
  const { askStreamBody } = context();
  const fields = { agentId: 'a', messages: [], userEmail: 'amber@example.invalid' };
  assert.deepStrictEqual({ ...askStreamBody({ billCaller: true }, fields) }, { ...fields, billCaller: true });
  for (const session of [{ billCaller: false }, {}, { billCaller: 'true' }, { billCaller: 1 }, null]) {
    const out = askStreamBody(session, fields);
    assert.strictEqual(Object.hasOwn(out, 'billCaller'), false, JSON.stringify(session));
    assert.strictEqual(out.userEmail, 'amber@example.invalid', 'tools still act as the person');
  }
});

test('every ask-stream request goes through askStreamBody (so viaFork is exact)', () => {
  const posts = [...SRC.matchAll(/\/librechat\/ask-stream`/g)].map((m) => m.index);
  assert.strictEqual(posts.length, 2, 'the turn and the inbound pickup line');
  for (const at of posts) {
    const call = SRC.slice(at, SRC.indexOf('\n    );', at));
    assert.match(call, /askStreamBody\(session, \{ agentId: session\.agentId, messages: /);
  }
});

test('a new session is never billed until the start handler says so', () => {
  const ctx = context({ WebSocket: { OPEN: 1 }, captionSafe: (s) => s });
  vm.runInContext(
    grab('class CallSession {', '// ── Barge-in', { inclusive: false }) +
      grab('class WebCallSession extends CallSession {', 'function verifyWebTicket', { inclusive: false }) +
      '\nthis.CallSession = CallSession; this.WebCallSession = WebCallSession;',
    ctx,
  );
  const cfg = { defaultAgent: 'k', defaultAgentName: 'Kiana', defaultVoice: 'v' };
  assert.strictEqual(new ctx.CallSession('s', 'c', '+1', { lcEmail: 'a@example.invalid' }, {}, cfg).billCaller, false);
  assert.strictEqual(new ctx.WebCallSession('web:a', { lcEmail: 'a@example.invalid' }, {}, cfg).billCaller, false);
});

test('phone: an inbound call is billed to the caller; an outbound call never is (F12)', () => {
  const start = grab(
    'session = new CallSession(streamSid, callSid, from, user, ws, global._vsConfig);',
    'session.billCaller = params.outbound !== \'1\' && !outboundCtx;',
  );
  const run = (params, outboundCtx) => {
    const ctx = context({
      CallSession: class {
        constructor() {
          this.billCaller = false;
        }
      },
      buildOutboundSuffix: () => '',
      global: { _vsConfig: { getOutboundCtx: () => outboundCtx } },
      streamSid: 's',
      callSid: 'c',
      from: '+15550100',
      user: { lcEmail: 'amber@example.invalid' },
      ws: {},
      params,
    });
    vm.runInContext(`let session;\n${start}\nthis.session = session;`, ctx);
    return ctx.session.billCaller;
  };
  assert.strictEqual(run({ from: '+15550100' }, null), true, 'inbound');
  // A call someone asked a character to place, a wellness check-in, a phone agent call.
  assert.strictEqual(run({ from: '+15550100', outbound: '1' }, { agentId: 'k', agentName: 'Kiana' }), false);
  // Twilio says outbound but the context has expired: still never the callee's bill.
  assert.strictEqual(run({ from: '+15550100', outbound: '1' }, null), false);
});

test('app/web: a voice session is billed to the caller; a direct Spotter session is not (F12)', () => {
  const hello = grab('session._spotterDirect = msg.spotterDirect === true;', 'session.billCaller = !session._spotterDirect;');
  const run = (msg) => {
    const ctx = context({ session: { billCaller: false }, msg });
    vm.runInContext(hello, ctx);
    return ctx.session.billCaller;
  };
  assert.strictEqual(run({ type: 'hello' }), true);
  assert.strictEqual(run({ type: 'hello', spotterDirect: false }), true);
  assert.strictEqual(run({ type: 'hello', spotterDirect: true }), false);
});

test('the voice_chat estimate says viaFork exactly for a billed call (F40)', async () => {
  const posted = [];
  const ctx = context({
    BROWSER_UA: 'ua',
    process: { env: { KADE_USAGE_EVENT_SECRET: 'offline' } },
    require: (name) => {
      assert.strictEqual(name, 'axios');
      return { post: async (url, body) => posted.push({ url, body }) };
    },
  });
  vm.runInContext(grab('async function postVoiceChatUsage(session) {', '\nasync function postWebVoiceUsage', { inclusive: false }) + '\nthis.post = postVoiceChatUsage;', ctx);
  const call = (billCaller) => ({
    billCaller,
    lcEmail: 'amber@example.invalid',
    agentName: 'Kiana',
    surface: 'phone',
    history: [
      { role: 'user', content: 'Hi Kiana.' },
      { role: 'assistant', content: 'Hey Amber, good to hear you.' },
    ],
  });
  await ctx.post(call(true));
  await ctx.post(call(false));
  await ctx.post({ ...call(undefined) });
  assert.strictEqual(posted.length, 3);
  assert.strictEqual(posted[0].body.service, 'voice_chat');
  assert.strictEqual(posted[0].body.metadata.viaFork, true);
  assert.ok(posted[0].body.costUSD > 0, 'the estimate is still sent; the fork decides what it costs');
  for (const p of posted.slice(1)) {
    assert.strictEqual(Object.hasOwn(p.body.metadata, 'viaFork'), false);
    assert.strictEqual(p.body.metadata.estimated, true);
  }
});
