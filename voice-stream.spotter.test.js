/* voice-stream.spotter.test.js — Sep 26 2026, Part 295 (Kade: "Spotter: fix both").
 *
 * A direct Spotter call (Gemini Live) used to post a 'voice_chat' estimate from its
 * transcript, as if the text model had written the Spotter's replies. No text model
 * ran for those turns. Live-lane turns now carry lane: 'live' and are never billed
 * as model replies; real character turns on the same call still are.
 *
 * Same extraction pattern as voice-stream.billcaller.test.js: the SHIPPED source is
 * pulled out of the real file and run, never transcribed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync(require.resolve('./voice-stream.js'), 'utf8').replace(/\r\n/g, '\n');

function grab(anchor, endAnchor) {
  const a = SRC.indexOf(anchor);
  assert.ok(a > -1, `anchor not found: ${anchor.slice(0, 50)}`);
  const b = SRC.indexOf(endAnchor, a);
  assert.ok(b > -1, `end anchor not found: ${endAnchor.slice(0, 50)}`);
  return SRC.slice(a, b);
}

function estimator() {
  const posted = [];
  const ctx = {
    String, Math, Number, JSON, console: { log() {}, warn() {} },
    BROWSER_UA: 'ua',
    process: { env: { KADE_USAGE_EVENT_SECRET: 'offline' } },
    require: () => ({ post: async (url, body) => posted.push(body) }),
  };
  vm.createContext(ctx);
  vm.runInContext(grab('async function postVoiceChatUsage(session) {', '\nasync function postWebVoiceUsage') + '\nthis.post = postVoiceChatUsage;', ctx);
  return { post: ctx.post, posted };
}

test('HER SPOTTER CALL: every turn on the live lane, no text model ran, no voice_chat charge', async () => {
  const { post, posted } = estimator();
  await post({
    billCaller: false, _spotterDirect: true, userId: 'u-amber', lcEmail: 'amber@example.invalid', agentName: 'Kiana', surface: 'web',
    history: [
      { role: 'user', content: 'Can you read this label for me?', lane: 'live' },
      { role: 'assistant', content: 'It says two tablets every six hours.', agentName: 'Scout', lane: 'live' },
      { role: 'user', content: 'Thanks.', lane: 'live' },
      { role: 'assistant', content: 'Any time.', lane: 'live' },
    ],
  });
  assert.strictEqual(posted.length, 0);
});

test('a Spotter call that handed back to the character bills only the character\'s turns', async () => {
  const { post, posted } = estimator();
  const live = [
    { role: 'user', content: 'Is the stove off?', lane: 'live' },
    { role: 'assistant', content: 'All four knobs point to off.', agentName: 'Scout', lane: 'live' },
  ];
  const mine = [
    { role: 'user', content: 'Kiana, what should I make for dinner?' },
    { role: 'assistant', content: 'How about tacos tonight?' },
  ];
  await post({ billCaller: false, userId: 'u-amber', lcEmail: 'amber@example.invalid', agentName: 'Kiana', surface: 'web', history: [...live, ...mine] });
  assert.strictEqual(posted.length, 1);
  const m = posted[0].metadata;
  // The character's one turn was sent the whole history as its prompt, live turns included.
  const prior = [...live, mine[0]].reduce((n, t) => n + t.content.length, 0);
  assert.strictEqual(m.inTok, Math.ceil((4000 + prior) / 4));
  assert.strictEqual(m.outTok, Math.ceil(mine[1].content.length / 4));
  assert.strictEqual(posted[0].service, 'voice_chat');
});

test('an ordinary voice call is estimated exactly as before', async () => {
  const { post, posted } = estimator();
  const history = [
    { role: 'user', content: 'Hi Kiana.' },
    { role: 'assistant', content: 'Hey Amber, good to hear you.' },
  ];
  await post({ billCaller: false, lcEmail: 'amber@example.invalid', agentName: 'Kiana', surface: 'phone', history });
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].metadata.inTok, Math.ceil((4000 + 'Hi Kiana.'.length) / 4));
  assert.strictEqual(posted[0].metadata.outTok, Math.ceil('Hey Amber, good to hear you.'.length / 4));
});

test('the caller\'s words while the Spotter has the call are pushed with lane: live', () => {
  const gate = grab('  if (session.liveOn) {\n    // July 18 2026', '    if (/\\b(?:live');
  assert.match(gate, /session\.history\.push\(\{ role: 'user', content: text, lane: 'live' \}\)/);
});

test('hang-up settles the Spotter through live-billing, not minutes x a flat rate', async () => {
  const calls = [];
  const ctx = { liveBilling: { flush: async (s, why) => { calls.push(why); return true; } } };
  vm.createContext(ctx);
  vm.runInContext(grab('async function postLiveUsage(session) {', '\nfunction attachWebVoice') + '\nthis.post = postLiveUsage;', ctx);
  await ctx.post({ userId: 'u' });
  assert.deepStrictEqual(calls, ['final']);
  assert.doesNotMatch(grab('async function postLiveUsage(session) {', '\nfunction attachWebVoice'), /LIVE_COST_PER_MIN_USD \|\|/);
});
