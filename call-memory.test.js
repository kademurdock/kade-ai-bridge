/* call-memory.test.js -- Nov 10 2026.
 *
 * The call memory bundle: how long the bridge waits for it, that nothing on
 * a call waits on it, and that a bundle arriving after the greeting still
 * reaches the next turn. Runs the SHIPPED functions (extracted from
 * server.js and voice-stream.js, never a transcription). No network, no
 * model, no real people.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');

const cm = require('./call-memory');

const SERVER = fs.readFileSync(require.resolve('./server.js'), 'utf8').replace(/\r\n/g, '\n');
const VOICE = fs.readFileSync(require.resolve('./voice-stream.js'), 'utf8').replace(/\r\n/g, '\n');

function grab(src, anchor, endAnchor) {
  const a = src.indexOf(anchor);
  assert.ok(a > -1, `anchor not found: ${anchor.slice(0, 40)}`);
  const b = src.indexOf(endAnchor, a);
  assert.ok(b > -1, `end anchor not found: ${endAnchor.slice(0, 40)}`);
  return src.slice(a, b + endAnchor.length);
}

/* ---- 1. how long the bridge waits ---------------------------------- */

test('a call waits 6 s by default; everything else keeps 2.5 s', () => {
  assert.strictEqual(cm.callMemoryTimeoutMs({ call: true }, {}), 6000);
  assert.strictEqual(cm.callMemoryTimeoutMs({ call: true, nudges: true }, {}), 6000);
  assert.strictEqual(cm.callMemoryTimeoutMs({}, {}), 2500);
  assert.strictEqual(cm.callMemoryTimeoutMs(undefined, {}), 2500);
  assert.strictEqual(cm.callMemoryTimeoutMs({ nudges: true }, {}), 2500);
});

test('KADE_CALL_MEMORY_LONG_WAIT=0 puts calls back on 2.5 s', () => {
  assert.strictEqual(cm.callMemoryTimeoutMs({ call: true }, { KADE_CALL_MEMORY_LONG_WAIT: '0' }), 2500);
  assert.strictEqual(
    cm.callMemoryTimeoutMs({ call: true }, { KADE_CALL_MEMORY_LONG_WAIT: '0', KADE_CALL_MEMORY_WAIT_MS: '9000' }),
    2500,
  );
  // anything other than "0" leaves it on
  assert.strictEqual(cm.callMemoryTimeoutMs({ call: true }, { KADE_CALL_MEMORY_LONG_WAIT: '1' }), 6000);
  assert.strictEqual(cm.callMemoryTimeoutMs({ call: true }, { KADE_CALL_MEMORY_LONG_WAIT: '' }), 6000);
});

test('KADE_CALL_MEMORY_WAIT_MS sets the call wait, clamped, and never touches awaited callers', () => {
  assert.strictEqual(cm.callMemoryTimeoutMs({ call: true }, { KADE_CALL_MEMORY_WAIT_MS: '8000' }), 8000);
  assert.strictEqual(cm.callMemoryTimeoutMs({ call: true }, { KADE_CALL_MEMORY_WAIT_MS: '50' }), 1000);
  assert.strictEqual(cm.callMemoryTimeoutMs({ call: true }, { KADE_CALL_MEMORY_WAIT_MS: '999999' }), 15000);
  assert.strictEqual(cm.callMemoryTimeoutMs({ call: true }, { KADE_CALL_MEMORY_WAIT_MS: 'soon' }), 6000);
  assert.strictEqual(cm.callMemoryTimeoutMs({}, { KADE_CALL_MEMORY_WAIT_MS: '8000' }), 2500);
});

test('the shipped fetchCallMemories hands axios the call wait only when opts.call is set', async () => {
  const seen = [];
  const ctx = {
    URLSearchParams,
    USAGE_EVENT_SECRET: 'test-secret',
    FORK_USAGE_URL: 'http://fork.invalid',
    BROWSER_UA: 'test-agent',
    callMemoryTimeoutMs: (opts) => cm.callMemoryTimeoutMs(opts, {}),
    axios: { get: async (url, cfg) => { seen.push({ url, timeout: cfg.timeout }); return { data: { text: 'bundle' } }; } },
  };
  vm.createContext(ctx);
  vm.runInContext(
    grab(SERVER, 'async function fetchCallMemories(identity, agentId, opts = {}) {', '\n}\n') +
      '\nthis.fetchCallMemories = fetchCallMemories;',
    ctx,
  );
  assert.strictEqual(await ctx.fetchCallMemories({ userId: 'u1' }, 'agent_a'), 'bundle');
  assert.strictEqual(await ctx.fetchCallMemories({ userId: 'u1' }, 'agent_a', { nudges: true, call: true }), 'bundle');
  assert.strictEqual(seen[0].timeout, 2500, 'brief / research lane keeps the old wait');
  assert.strictEqual(seen[1].timeout, 6000, 'call lane waits longer');
  assert.ok(!/nudges=1/.test(seen[0].url) && /nudges=1/.test(seen[1].url));
  /* review fix: the site is told how long a fetch that takes waiting messages waits */
  assert.ok(/[?&]wait=6000(&|$)/.test(seen[1].url), 'a live call says it waits 6 s');
  assert.ok(!/[?&]wait=/.test(seen[0].url), 'a fetch that takes no waiting messages says nothing');
  assert.strictEqual(await ctx.fetchCallMemories({ userId: 'u1' }, 'agent_a', { nudges: true }), 'bundle');
  assert.ok(/[?&]wait=2500(&|$)/.test(seen[2].url) && seen[2].timeout === 2500, 'an awaited fetch that takes them says 2.5 s');
});

test('awaited users of the bundle (brief, research) do not ask for the call wait', () => {
  const RESEARCH = fs.readFileSync(require.resolve('./research.js'), 'utf8');
  const awaited = [...SERVER.matchAll(/await fetchCallMemories\(([^\n]*)/g)].map((m) => m[1])
    .concat([...RESEARCH.matchAll(/await deps\.fetchCallMemories\(([^\n]*)/g)].map((m) => m[1]));
  assert.ok(awaited.length >= 2, 'expected the brief and research call sites');
  for (const args of awaited) assert.ok(!/call:\s*true/.test(args), `awaited caller must keep 2.5 s: ${args}`);
});

/* ---- 2. nothing on a call waits for the bundle ----------------------- */

test('every call-lane fetch is fire-and-forget and asks for the call wait', () => {
  const lines = VOICE.split('\n');
  const sites = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /fetchCallMemories\(\{/.test(line));
  assert.strictEqual(sites.length, 3, 'phone pickup, mid-call switch, web call');
  for (const { line, i } of sites) {
    assert.ok(!/\bawait\b/.test(line), `call fetch must not be awaited (line ${i + 1})`);
    assert.ok(!/=\s*(session\.cfg|global\._vsConfig|cfg)\.fetchCallMemories/.test(line), `call fetch result must not be kept to await later (line ${i + 1})`);
    assert.ok(/call:\s*true/.test(line), `call fetch must ask for the call wait (line ${i + 1})`);
    assert.ok(/^\s*\.then\(/.test(lines[i + 1]), `call fetch continues in .then (line ${i + 2})`);
    assert.ok(/beginCallMemoryFetch\(session\)/.test(lines[i - 1]), `call fetch takes a ticket (line ${i})`);
  }
  // The bundle is only ever READ synchronously off the session.
  assert.ok(!/await[^\n]*callerMemories/.test(VOICE), 'nothing awaits callerMemories');
});

/* ---- 3. a late bundle still lands ------------------------------------ */

function shippedMemoryLine() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    grab(VOICE, 'function memoryLine(session) {', '\n}\n') + '\nthis.memoryLine = memoryLine;',
    ctx,
  );
  return ctx.memoryLine;
}

test('a bundle that arrives after the greeting is on the next turn', async () => {
  const memoryLine = shippedMemoryLine();
  const session = { callerName: 'Tester', callerMemories: null };
  let release;
  const slowFetch = new Promise((r) => { release = r; });

  // pickup: fetch starts, nobody waits
  const ticket = cm.beginCallMemoryFetch(session, 1000);
  const landed = slowFetch.then((text) => cm.applyCallMemories(session, ticket, text, {}, {}, 5200));

  // greeting and first turn go out with no bundle
  const greetingSaid = true;
  assert.strictEqual(memoryLine(session), '', 'first turn has no memory yet');

  // 4.2 s after pickup the site answers (past the old 2.5 s give-up)
  release('- likes gardening\n- uses a screen reader');
  const got = await landed;
  assert.ok(greetingSaid);
  assert.deepStrictEqual(got, { applied: true, reason: 'attached', ms: 4200 });
  assert.match(memoryLine(session), /WHAT YOU REMEMBER ABOUT Tester/);
  assert.match(memoryLine(session), /uses a screen reader/);
});

test('an empty answer leaves the call alone at pickup and clears at a switch', () => {
  const s = { callerMemories: 'old bundle' };
  let t = cm.beginCallMemoryFetch(s);
  assert.strictEqual(cm.applyCallMemories(s, t, null, {}, {}).applied, false);
  assert.strictEqual(s.callerMemories, 'old bundle');
  t = cm.beginCallMemoryFetch(s);
  assert.strictEqual(cm.applyCallMemories(s, t, null, { clearOnEmpty: true }, {}).reason, 'cleared');
  assert.strictEqual(s.callerMemories, null);
});

test('a bundle for a call that has ended is dropped without a throw', () => {
  assert.deepStrictEqual(
    cm.applyCallMemories(null, { seq: 1, at: 10 }, 'bundle', {}, {}, 30),
    { applied: false, reason: 'call-ended', ms: 20 },
  );
  assert.strictEqual(cm.beginCallMemoryFetch(null), null);
});

test('the pickup bundle cannot land on top of the bundle for a character switched to', () => {
  const s = { callerMemories: null };
  const pickup = cm.beginCallMemoryFetch(s, 0);      // first character, slow
  const switched = cm.beginCallMemoryFetch(s, 2000); // caller switches character
  assert.strictEqual(cm.applyCallMemories(s, switched, 'second character bundle', { clearOnEmpty: true }, {}, 2400).applied, true);
  const late = cm.applyCallMemories(s, pickup, 'first character bundle', {}, {}, 5000);
  assert.deepStrictEqual(late, { applied: false, reason: 'superseded', ms: 5000 });
  assert.strictEqual(s.callerMemories, 'second character bundle');
});

test('KADE_CALL_MEMORY_LATE_ATTACH=0 restores "whatever lands last wins"', () => {
  const off = { KADE_CALL_MEMORY_LATE_ATTACH: '0' };
  const s = { callerMemories: null };
  const pickup = cm.beginCallMemoryFetch(s, 0);
  const switched = cm.beginCallMemoryFetch(s, 2000);
  cm.applyCallMemories(s, switched, 'second character bundle', { clearOnEmpty: true }, off, 2400);
  assert.strictEqual(cm.applyCallMemories(s, pickup, 'first character bundle', {}, off, 5000).applied, true);
  assert.strictEqual(s.callerMemories, 'first character bundle');
});
