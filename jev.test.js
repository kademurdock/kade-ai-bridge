/* jev.test.js — Part 236 (Sep 20 2026).
 *
 * Jev is a second opinion on a LIVE phone line, so what is tested here is the
 * contract, three ways for every switch:
 *   1. key unset (or killed)  -> exactly the old behaviour, and no network
 *   2. Jev fails / times out  -> exactly the old behaviour
 *   3. a Jev verdict moves things ONLY in the allowed direction — it can spare
 *      a strike, keep a line open, ask again, drop a question; it cannot add a
 *      hangup route, dial, page, or lose a caller's words.
 *
 * Nothing here touches the network: jev.js's own functions take the ask
 * function as a parameter, and the callers in errands / battery / research /
 * voice-stream take `jev` as a parameter. Those four files need express/axios/
 * ws to load, which this machine does not have, so their SHIPPED functions are
 * lifted out of the source by anchor (the voice-stream.carry.test.js way —
 * never a transcription) and run in a vm with stubs.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const jev = require('./jev');
const vc = require('./voice-commands');

function src(file) { return fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/\r\n/g, '\n'); }
function grab(SRC, anchor, endAnchor) {
  const a = SRC.indexOf(anchor);
  assert.ok(a > -1, `anchor not found: ${anchor.slice(0, 50)}`);
  const b = SRC.indexOf(endAnchor, a);
  assert.ok(b > -1, `end anchor not found: ${endAnchor.slice(0, 50)}`);
  return SRC.slice(a, b + endAnchor.length);
}
const quiet = { log() {}, warn() {}, error() {}, info() {} };

function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(old)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore(); return out;
}
const ON = { TYPESAFE_API_KEY: 'test-key', KADE_JEV: null, KADE_JEV_GATE: null, KADE_JEV_CANARY: null, KADE_JEV_CONSENT: null, KADE_JEV_BATTERY: null, KADE_JEV_RESEARCH: null, KADE_JEV_SWITCH: null };
const OFF = { ...ON, TYPESAFE_API_KEY: null };

/* A fake jev module: real deciders and thresholds, scripted answers. */
function fakeJev(script) {
  const calls = [];
  const wrap = (name) => async (...args) => { calls.push([name, ...args]); const v = script[name]; if (v instanceof Error) throw v; if (v === undefined) throw new Error('unscripted ' + name); return typeof v === 'function' ? v(...args) : v; };
  return { ...jev, enabled: jev.enabled, calls,
    gateIntent: wrap('gateIntent'), consentRead: wrap('consentRead'), batteryJudge: wrap('batteryJudge'),
    researchEnough: wrap('researchEnough'), namingSomeone: wrap('namingSomeone'), canaryOpinion: wrap('canaryOpinion') };
}

/* ── the helper itself ─────────────────────────────────────────────────── */

test('enabled(): no key = off; KADE_JEV=0 = off; a feature flag kills only its feature', () => {
  withEnv(OFF, () => { assert.equal(jev.enabled(), false); assert.equal(jev.enabled('KADE_JEV_GATE'), false); });
  withEnv(ON, () => { assert.equal(jev.enabled(), true); assert.equal(jev.enabled('KADE_JEV_GATE'), true); });
  withEnv({ ...ON, KADE_JEV: '0' }, () => assert.equal(jev.enabled('KADE_JEV_GATE'), false));
  withEnv({ ...ON, KADE_JEV_GATE: '0' }, () => { assert.equal(jev.enabled('KADE_JEV_GATE'), false); assert.equal(jev.enabled('KADE_JEV_CANARY'), true); });
});

test('ask(): with no key it throws before any network call', async () => {
  const realFetch = global.fetch; let fetched = 0;
  global.fetch = async () => { fetched++; throw new Error('should not be called'); };
  try { await withEnv(OFF, () => assert.rejects(jev.ask({ a: 1 }, { q: { type: 'noul', instructions: 'x?' } }), /disabled/)); }
  finally { global.fetch = realFetch; }
  assert.equal(fetched, 0);
});

test('ask(): ok counts ok; HTTP error, malformed body and timeout all THROW and count failed', async () => {
  const realFetch = global.fetch;
  const before = { ...jev.counts };
  try {
    await withEnv(ON, async () => {
      let sent = null;
      global.fetch = async (url, init) => { sent = { url, init }; return { ok: true, json: async () => ({ model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.9 } } }) }; };
      const r = await jev.ask({ a: 1 }, { q: { type: 'noul', instructions: 'x?' } });
      assert.equal(r.answers.q.noul, 0.9);
      assert.equal(sent.init.headers.Authorization, 'Bearer test-key');
      assert.equal(JSON.parse(sent.init.body).model, jev.MODEL);

      global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
      await assert.rejects(jev.ask({}, {}), /HTTP 500/);
      global.fetch = async () => ({ ok: true, json: async () => ({ nope: true }) });
      await assert.rejects(jev.ask({}, {}), /no answers/);
      global.fetch = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
      await assert.rejects(jev.ask({}, {}, 20), /timeout 20ms/);
    });
  } finally { global.fetch = realFetch; }
  assert.equal(jev.counts.ok - before.ok, 1);
  assert.equal(jev.counts.failed - before.failed, 3);
});

test('a malformed answer is a throw, never a guess', async () => {
  await assert.rejects(jev.canaryOpinion('q', 'r', async () => ({ answers: { correct: { noul: 'high' }, attempt: { noul: 0.5 } } })), /bad correct/);
  await assert.rejects(jev.gateIntent('purpose', 'a', 'b', async () => ({ answers: { intent: { choice: 'hangup', confidence: 1 } } })), /bad intent/);
  await assert.rejects(jev.gateIntent('msg_done', 'a', 'b', async () => ({ answers: { intent: { choice: 'callback', confidence: 1 } } })), /bad intent/);
  await assert.rejects(jev.consentRead('a', 'b', async () => ({ answers: { consents: { noul: 0.9 } } })), /bad refuses/);
  await assert.rejects(jev.namingSomeone('x', async () => ({ answers: {} })), /bad naming/);
  await assert.rejects(jev.batteryJudge({ text: 't', rule: 'r', want: 'w' }, 'reply', async () => ({ answers: { score: { score: 9 } } })), /bad score/);
});

/* ── B1 canary ─────────────────────────────────────────────────────────── */

test('canaryDecide: overrules a failed fact check only when sure, and NEVER on the tool probe', () => {
  const fact = { q: 'season?', expect: /fall/i };
  assert.equal(jev.canaryDecide(fact, true, { correct: 0.97, attempt: 0.9 }), 'overrule');
  assert.equal(jev.canaryDecide(fact, true, { correct: 0.89, attempt: 0.99 }), null);
  assert.equal(jev.canaryDecide({ ...fact, tool: true }, true, { correct: 0.99, attempt: 0.99 }), null);
  assert.equal(jev.canaryDecide(fact, true, null), null);
});

test('canaryDecide: doubt only for a probe with no fact regex, only when both reads are near zero; a PASSED fact check is never doubted', () => {
  const open = { q: 'porch?' };
  assert.equal(jev.canaryDecide(open, false, { correct: 0.01, attempt: 0.01 }), 'doubt');
  assert.equal(jev.canaryDecide(open, false, { correct: 0.01, attempt: 0.24 }), null);
  assert.equal(jev.canaryDecide(open, false, { correct: 0.30, attempt: 0.02 }), null);
  assert.equal(jev.canaryDecide({ q: 'x', expect: /y/ }, false, { correct: 0.0, attempt: 0.0 }), null);
});

test('server.js: a jev-only red never touches the fail streak or the pager', () => {
  const S = src('server.js');
  const branch = grab(S, '} else if (result.jevOnly) {', '} else {');
  assert.ok(!/consecutiveFails\s*\+=/.test(branch), 'jevOnly branch must not count a fail');
  assert.ok(!/runNotify/.test(branch), 'jevOnly branch must not notify');
  assert.ok(!/alerted\s*=/.test(branch), 'jevOnly branch must not touch the alert flag');
  // and the opinion helper swallows every failure into null
  assert.match(grab(S, 'async function canaryJevOpinion(', '\n}'), /catch \(e\) \{[^}]*return null;/);
});

/* ── B2 front-desk gate ────────────────────────────────────────────────── */

test('gateDecide: thresholds, and each step can only act on its own options', () => {
  assert.equal(jev.gateDecide('purpose', { choice: 'callback', confidence: 0.94 }), 'callback');
  assert.equal(jev.gateDecide('purpose', { choice: 'message', confidence: 0.79 }), null);
  assert.equal(jev.gateDecide('purpose', { choice: 'unclear', confidence: 1 }), null);
  assert.equal(jev.gateDecide('purpose', { choice: 'done', confidence: 1 }), null);
  assert.equal(jev.gateDecide('msg_done', { choice: 'done', confidence: 1 }), null, 'by default Jev alone never ends a call');
  withEnv({ KADE_JEV_GATE_DONE: '1' }, () => {
    assert.equal(jev.gateDecide('msg_done', { choice: 'done', confidence: 0.94 }), null, 'done ends a call: 0.95 or nothing');
    assert.equal(jev.gateDecide('msg_done', { choice: 'done', confidence: 0.96 }), 'done');
  });
  assert.equal(jev.gateDecide('msg_done', { choice: 'more', confidence: 0.85 }), 'more');
  assert.equal(jev.gateDecide('msg_done', { choice: 'account', confidence: 1 }), null);
  assert.equal(jev.gateDecide('msg_done', null), null);
});

function gateRig(jevObj) {
  const VS = src('voice-stream.js');
  const code = grab(VS, 'async function gateJevRead(', '\n}') + '\n' +
    grab(VS, 'async function handleGateTurn(', "    default:\n      await gateHangup(session, `Take care now!`);\n      return;\n  }\n}") +
    '\nthis.handleGateTurn = handleGateTurn;';
  const events = [];
  const ctx = { String, console: quiet, JEV: jevObj,
    GATE_CALLBACK_RE: vc.GATE_CALLBACK_RE, GATE_MESSAGE_RE: vc.GATE_MESSAGE_RE, GATE_ACCOUNT_RE: vc.GATE_ACCOUNT_RE,
    GATE_DONE_RE: vc.GATE_DONE_RE, GATE_MORE_RE: vc.GATE_MORE_RE, REG_YES_RE: vc.REG_YES_RE, REG_INTENT_RE: vc.REG_INTENT_RE,
    speak: async (s, line) => { events.push(['speak', line]); },
    gateHangup: async (s, line) => { events.push(['HANGUP', line]); },
    gateDeliver: async (s) => { events.push(['deliver', s.gate.message]); return true; } };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  const session = (gate) => ({ from: '+15550000000', voice: 'v', gate, cfg: {} });
  return { turn: async (gate, text) => { const s = session(gate); await ctx.handleGateTurn(s, text); return { gate: s.gate, events: events.splice(0) }; } };
}
const hung = (r) => r.events.some((e) => e[0] === 'HANGUP');

test('gate: key unset = the old behaviour on every road, and Jev is never asked', async () => {
  const fj = fakeJev({ gateIntent: { choice: 'callback', confidence: 1 } });
  const rig = gateRig(fj);
  await withEnv(OFF, async () => {
    let r = await rig.turn({ step: 'purpose' }, 'I got a voicemail from this number yesterday');
    assert.equal(r.gate.strikes, 1); assert.equal(r.gate.step, 'purpose'); assert.ok(!hung(r));
    r = await rig.turn({ step: 'purpose', strikes: 1 }, 'I got a voicemail from this number yesterday');
    assert.ok(hung(r), 'second strike hangs up, as it always has');
    r = await rig.turn({ step: 'msg_done', message: 'hi' }, 'um one more');
    assert.ok(hung(r), 'short unknown = done, as it always has');
    r = await rig.turn({ step: 'msg_done', message: 'hi' }, 'I think that covers everything, thank you so much');
    assert.ok(!hung(r)); assert.match(r.gate.message, /covers everything/);
  });
  assert.equal(fj.calls.length, 0);
});

test('gate: KADE_JEV_GATE=0 and a null module are the old behaviour too', async () => {
  const fj = fakeJev({ gateIntent: { choice: 'message', confidence: 1 } });
  await withEnv({ ...ON, KADE_JEV_GATE: '0' }, async () => {
    const r = await gateRig(fj).turn({ step: 'purpose' }, 'can you have her ring me when she gets a chance');
    assert.equal(r.gate.strikes, 1);
  });
  assert.equal(fj.calls.length, 0);
  await withEnv(ON, async () => {
    const r = await gateRig(null).turn({ step: 'purpose' }, 'can you have her ring me when she gets a chance');
    assert.equal(r.gate.strikes, 1);
  });
});

test('gate: a Jev failure (timeout) is the old behaviour', async () => {
  const rig = gateRig(fakeJev({ gateIntent: new Error('timeout 700ms') }));
  await withEnv(ON, async () => {
    let r = await rig.turn({ step: 'purpose' }, 'can you have her ring me when she gets a chance');
    assert.equal(r.gate.strikes, 1); assert.equal(r.gate.step, 'purpose');
    r = await rig.turn({ step: 'msg_done', message: 'hi' }, 'um one more');
    assert.ok(hung(r));
  });
});

test('gate: when a regex matched, Jev is not asked at all', async () => {
  const fj = fakeJev({ gateIntent: { choice: 'account', confidence: 1 } });
  const rig = gateRig(fj);
  await withEnv(ON, async () => {
    let r = await rig.turn({ step: 'purpose' }, 'I want to leave a message for Kade');
    assert.equal(r.gate.step, 'msg_body');
    r = await rig.turn({ step: 'msg_done', message: 'hi' }, 'no that\'s all');
    assert.ok(hung(r));
    r = await rig.turn({ step: 'msg_done', message: 'hi' }, 'wait');
    assert.ok(!hung(r));
  });
  assert.equal(fj.calls.length, 0);
});

test('gate purpose: Jev spares the strike and takes the SAME branch the regex would', async () => {
  await withEnv(ON, async () => {
    let r = await gateRig(fakeJev({ gateIntent: { choice: 'callback', confidence: 0.94 } })).turn({ step: 'purpose' }, 'I got a voicemail from this number yesterday');
    assert.equal(r.gate.step, 'msg_body'); assert.equal(r.gate.strikes, undefined); assert.ok(!hung(r));
    assert.match(r.events[0][1], /don't show an outgoing call/);
    r = await gateRig(fakeJev({ gateIntent: { choice: 'callback', confidence: 0.94 } })).turn({ step: 'purpose', cb: { userName: 'Holly' } }, 'I got a voicemail from this number yesterday');
    assert.match(r.events[0][1], /straight to Holly/);
    r = await gateRig(fakeJev({ gateIntent: { choice: 'account', confidence: 0.99 } })).turn({ step: 'purpose' }, 'how much does it cost to get on here');
    assert.equal(r.gate.step, 'door_name');
    r = await gateRig(fakeJev({ gateIntent: { choice: 'message', confidence: 0.98 } })).turn({ step: 'purpose', strikes: 1 }, 'can you have her ring me when she gets a chance');
    assert.equal(r.gate.step, 'msg_body'); assert.ok(!hung(r), 'a real reason on the second try is not hung up on');
  });
});

test('gate purpose: unclear or low confidence = the strike, exactly as before; Jev cannot ADD a strike or a hangup', async () => {
  await withEnv(ON, async () => {
    let r = await gateRig(fakeJev({ gateIntent: { choice: 'unclear', confidence: 1 } })).turn({ step: 'purpose' }, 'who is this');
    assert.equal(r.gate.strikes, 1); assert.ok(!hung(r));
    r = await gateRig(fakeJev({ gateIntent: { choice: 'message', confidence: 0.6 } })).turn({ step: 'purpose' }, 'well I was hoping maybe');
    assert.equal(r.gate.strikes, 1);
  });
});

test('gate msg_done: `more` keeps the line open where the under-twelve rule would have hung up, and keeps the words', async () => {
  await withEnv(ON, async () => {
    const r = await gateRig(fakeJev({ gateIntent: { choice: 'more', confidence: 1 } })).turn({ step: 'msg_done', message: 'call me' }, 'um one more');
    assert.ok(!hung(r)); assert.equal(r.gate.step, 'msg_done'); assert.equal(r.gate.message, 'call me um one more');
  });
});

test('gate msg_done: `done` runs the regex\'s own deliver-and-goodbye, and appends the words FIRST so nothing is lost (opt-in only)', async () => {
  await withEnv({ ...ON, KADE_JEV_GATE_DONE: '1' }, async () => {
    let r = await gateRig(fakeJev({ gateIntent: { choice: 'done', confidence: 0.99 } })).turn({ step: 'msg_done', message: 'call me' }, 'I think that covers everything, thank you so much');
    assert.deepEqual(r.events.map((e) => e[0]), ['deliver', 'HANGUP']);
    assert.match(r.events[0][1], /^call me I think that covers everything/);
    // under the bar: the old road (append, ask again), no hangup
    r = await gateRig(fakeJev({ gateIntent: { choice: 'done', confidence: 0.91 } })).turn({ step: 'msg_done', message: 'call me' }, 'she is all done with chemo and that is everything the doctor said');
    assert.ok(!hung(r)); assert.match(r.gate.message, /chemo/);
  });
});

test('gate source: Part 236 added no new hangup call', () => {
  const VS = src('voice-stream.js');
  const body = grab(VS, 'async function handleGateTurn(', "    default:\n      await gateHangup(session, `Take care now!`);");
  assert.equal((body.match(/gateHangup\(/g) || []).length, 5, 'strike-out, msg_done, door_name strikes, door_who, default — and no sixth');
});

/* ── B5 errand consent ─────────────────────────────────────────────────── */

test('consentShouldReask: both directions are "ask again"; ordinary answers change nothing', () => {
  assert.equal(jev.consentShouldReask(false, { consents: 0.98, refuses: 0.01 }), true, '"absolutely" — regex no');
  assert.equal(jev.consentShouldReask(false, { consents: 0.76, refuses: 0.03 }), false, '"alright" stays a no, as today');
  assert.equal(jev.consentShouldReask(false, { consents: 0.9, refuses: 0.5 }), false);
  assert.equal(jev.consentShouldReask(false, { consents: 0.01, refuses: 0.98 }), false, 'a no is a no');
  assert.equal(jev.consentShouldReask(true, { consents: 0.02, refuses: 0.98 }), true, '"okay no don\'t call" — regex YES');
  assert.equal(jev.consentShouldReask(true, { consents: 0.10, refuses: 0.84 }), true);
  assert.equal(jev.consentShouldReask(true, { consents: 0.98, refuses: 0.01 }), false, 'a plain yes is never blocked');
  assert.equal(jev.consentShouldReask(true, { consents: 0.71, refuses: 0.03 }), false, '"okay"');
  assert.equal(jev.consentShouldReask(true, null), false);
  assert.equal(typeof jev.consentShouldReask(false, { consents: 1, refuses: 0 }), 'boolean', 'there is no return value that means "dial"');
});

function errandsRig(jevObj) {
  const E = src('errands.js');
  const code = grab(E, 'async function consentNeedsReask(', '\n}') + '\nthis.consentNeedsReask = consentNeedsReask;';
  const ctx = { String, console: quiet, JEV: jevObj };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  return ctx.consentNeedsReask;
}
const pendingErrand = () => ({ id: 'e1', pending: { kind: 'call_confirm', ask: 'Want me to call Ozark Dental? Yes or no.' } });

test('errands: key unset, killed, Jev failing, empty answer, already re-asked -> false (the regex alone)', async () => {
  const yesRead = { consents: 0.98, refuses: 0.01 };
  const fj = fakeJev({ consentRead: yesRead });
  await withEnv(OFF, async () => assert.equal(await errandsRig(fj)(pendingErrand(), false, 'absolutely'), false));
  await withEnv({ ...ON, KADE_JEV_CONSENT: '0' }, async () => assert.equal(await errandsRig(fj)(pendingErrand(), false, 'absolutely'), false));
  assert.equal(fj.calls.length, 0);
  await withEnv(ON, async () => {
    assert.equal(await errandsRig(null)(pendingErrand(), false, 'absolutely'), false);
    assert.equal(await errandsRig(fakeJev({ consentRead: new Error('timeout') }))(pendingErrand(), false, 'absolutely'), false);
    assert.equal(await errandsRig(fj)(pendingErrand(), false, '   '), false);
    const again = pendingErrand(); again.pending.reasked = true;
    assert.equal(await errandsRig(fj)(again, false, 'absolutely'), false, 'once per question');
    assert.equal(await errandsRig(fj)({ id: 'e2', pending: null }, false, 'absolutely'), false);
  });
});

test('errands: a hard disagreement asks again, in both directions, and Jev sees the question that was asked', async () => {
  await withEnv(ON, async () => {
    const fj = fakeJev({ consentRead: { consents: 0.98, refuses: 0.01 } });
    assert.equal(await errandsRig(fj)(pendingErrand(), false, 'absolutely'), true);
    assert.equal(fj.calls[0][1], 'Want me to call Ozark Dental? Yes or no.');
    assert.equal(await errandsRig(fakeJev({ consentRead: { consents: 0.02, refuses: 0.98 } }))(pendingErrand(), true, 'okay no don\'t call'), true);
    assert.equal(await errandsRig(fakeJev({ consentRead: { consents: 0.98, refuses: 0.01 } }))(pendingErrand(), true, 'yes'), false);
  });
});

test('errands source: the re-ask returns BEFORE pending is cleared or anything is armed, and after the stale check', () => {
  const E = src('errands.js');
  const h = grab(E, "app.post('/errand/:id/confirm'", '})().catch(next); });');
  const iStale = h.indexOf('age > CONFIRM_TTL_MS'); const iReask = h.indexOf('await consentNeedsReask('); const iClear = h.indexOf('e.pending = null;', iReask); const iArm = h.indexOf('step.approvedNumber = step.pendingNumber');
  assert.ok(iStale > -1 && iReask > iStale, 'stale check first');
  assert.ok(iClear > iReask && iArm > iReask, 're-ask sits before pending is cleared and before a number is approved');
  const block = h.slice(iReask, iClear);
  assert.match(block, /return res\.json\(\{ ok: true, reask: true/);
  assert.ok(!/approvedNumber|cursor|setStatus|pump\(/.test(block), 'the re-ask block changes no errand state beyond pending.reasked');
  assert.match(block, /e\.status !== 'awaiting_confirm'/, 'state is re-checked after the await');
  // the dial still needs the REGEX yes: `yes` is assigned once, from the regex
  assert.equal((h.match(/\byes\s*=[^=]/g) || []).length, 1);
});

/* ── B3 battery ────────────────────────────────────────────────────────── */

function batteryRig(jevObj) {
  const B = src('battery.js');
  const code = grab(B, 'async function jevChair(', '\n}') + '\nthis.jevChair = jevChair;';
  const ctx = { Object, Date, console: quiet, JEV: jevObj };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  return ctx.jevChair;
}
const PROBE = { id: 'helpdesk_bait', text: 't', rule: 'r', want: 'w' };

test('battery: no key / killed / failure -> null, and the two judges stand', async () => {
  const fj = fakeJev({ batteryJudge: { score: 84, confidence: 0.5, flags: { off_persona: true, big_words: false }, cost: 0.00003 } });
  await withEnv(OFF, async () => assert.equal(await batteryRig(fj)(PROBE, 'reply', fj, quiet), null));
  await withEnv({ ...ON, KADE_JEV_BATTERY: '0' }, async () => assert.equal(await batteryRig(fj)(PROBE, 'reply', fj, quiet), null));
  assert.equal(fj.calls.length, 0);
  await withEnv(ON, async () => {
    const bad = fakeJev({ batteryJudge: new Error('HTTP 500') });
    assert.equal(await batteryRig(bad)(PROBE, 'reply', bad, quiet), null);
    const r = await batteryRig(fj)(PROBE, 'reply', fj, quiet);
    assert.equal(r.score, 84); assert.deepEqual(Array.from(r.flags), ['off_persona']); assert.equal(r.cost, 0.00003);
  });
});

test('battery: batteryJudge maps the five-step rubric to 0-100 and thresholds the seven flags', async () => {
  const answers = { score: { score: 3, confidence: 0.7 } };
  for (const k of ['helpdesk_register', 'therapy_phrasing', 'big_words', 'reframe_tic', 'ai_self_reference', 'off_persona', 'unsafe_for_room']) answers[k] = { noul: 0.1 };
  answers.helpdesk_register = { noul: 0.99 }; answers.off_persona = { noul: 0.79 };
  let asked = null;
  const r = await jev.batteryJudge(PROBE, 'x'.repeat(5000), async (state, questions) => { asked = { state, questions }; return { answers, usage: { input_tokens: 800 } }; });
  assert.equal(r.score, 75);
  assert.equal(r.flags.helpdesk_register, true); assert.equal(r.flags.off_persona, false);
  assert.equal(Object.keys(asked.questions).length, 8, 'one score + seven nouls, one request');
  assert.equal(asked.questions.score.criteria.length, 5);
  assert.equal(asked.state.reply.length, 2500);
});

test('battery source: Jev stays out of scores/mean unless BATTERY_JEV_COUNTS=1, agreement is the LLM pair\'s, and the cap still gates it', () => {
  const B = src('battery.js');
  const blk = grab(B, 'const agreement = scores.length === 2', 'per.push(perRow);');
  assert.ok(blk.indexOf('const agreement') < blk.indexOf('jevChair('), 'agreement is computed before Jev can join scores');
  assert.match(blk, /if \(JEV_COUNTS\(\)\) scores\.push\(jv\.score\)/);
  assert.match(blk, /state\.spentTodayUsd >= DAILY_CAP_USD \? null : await jevChair/);
  assert.match(B, /if \(state\.spentTodayUsd >= DAILY_CAP_USD\) throw new Error\(`daily judge cap/, 'the original cap stop is intact');
});

/* ── B4 research shadow ────────────────────────────────────────────────── */

function researchRig(jevObj, con) {
  const R = src('research.js');
  const code = grab(R, 'function jevShadowEnough(', '\n}') + '\nthis.jevShadowEnough = jevShadowEnough;';
  const ctx = { Boolean, console: con || quiet, JEV: jevObj };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  return ctx.jevShadowEnough;
}
const JOB = { id: 'r1', question: 'q', plan: { sub_questions: ['a'] }, sources: [{ n: 1, site: 's.com', note: 'n'.repeat(30000) }, { n: 2, site: 't.com', note: null }] };

test('research shadow: off = null and no call; on = one log line; failure = swallowed; never throws synchronously', async () => {
  const fj = fakeJev({ researchEnough: 0.85 });
  withEnv(OFF, () => assert.equal(researchRig(fj)(JOB, { enough: true }, 0), null));
  assert.equal(fj.calls.length, 0);
  const lines = [];
  await withEnv(ON, async () => {
    const p = researchRig(fj, { ...quiet, log: (l) => lines.push(l) })(JOB, { enough: false }, 1);
    assert.equal(await p, 0.85);
    assert.equal(await researchRig(fakeJev({ researchEnough: new Error('timeout') }))(JOB, {}, 0), null);
    assert.equal(researchRig(fj)({ id: 'broken' }, {}, 0), null, 'a malformed job is a null, not a throw');
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /jev shadow r1 round=1 reflect\.enough=false jev=0\.85/);
});

test('research: notes are cut to 24K before they leave, and the run loop does not await the shadow', async () => {
  let sent = null;
  await jev.researchEnough('q', [], 'n'.repeat(40000), async (state) => { sent = state; return { answers: { enough: { noul: 0.5 } } }; });
  assert.equal(sent.notes.length, jev.RESEARCH_NOTES_MAX);
  const R = src('research.js');
  assert.match(R, /\n\s+jevShadowEnough\(job, ref, round\);/);
  assert.ok(!/await jevShadowEnough/.test(R));
  assert.match(R, /const followups = \(ref\.enough \? \[\] : \(ref\.new_queries \|\| \[\]\)\)/, 'the decision line is untouched');
});

/* ── B6 agent pick ─────────────────────────────────────────────────────── */

function pickRig(jevObj) {
  const VS = src('voice-stream.js');
  const code = grab(VS, 'async function jevSaysNotAName(', '\n}') + '\nthis.jevSaysNotAName = jevSaysNotAName;';
  const ctx = { console: quiet, JEV: jevObj };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  return ctx.jevSaysNotAName;
}

test('agent pick: only a confident not-a-name drops the question; off, failure and a maybe all ask "did you mean" as before', async () => {
  await withEnv(OFF, async () => assert.equal(await pickRig(fakeJev({ namingSomeone: 0.01 }))('what time is it'), false));
  await withEnv({ ...ON, KADE_JEV_SWITCH: '0' }, async () => assert.equal(await pickRig(fakeJev({ namingSomeone: 0.01 }))('what time is it'), false));
  await withEnv(ON, async () => {
    assert.equal(await pickRig(null)('what time is it'), false);
    assert.equal(await pickRig(fakeJev({ namingSomeone: new Error('timeout 600ms') }))('what time is it'), false);
    assert.equal(await pickRig(fakeJev({ namingSomeone: 0.02 }))('what time is it'), true);
    assert.equal(await pickRig(fakeJev({ namingSomeone: 0.26 }))('why it'), false, 'a mangled name keeps its "did you mean"');
    assert.equal(await pickRig(fakeJev({ namingSomeone: 0.08 }))('honey turn that down'), false, 'the threshold is strict');
  });
});

test('agent pick source: Jev sits only in the did-you-mean band and can never reach applySwitch', () => {
  const VS = src('voice-stream.js');
  const blk = grab(VS, 'if (r && r.agent && await jevSaysNotAName(text)) {', 'return;\n      }');
  assert.ok(!/applySwitch/.test(blk));
  const before = VS.slice(0, VS.indexOf('if (r && r.agent && await jevSaysNotAName(text)) {'));
  assert.ok(before.lastIndexOf('if (r && r.confidence >= 0.6) {') > before.lastIndexOf('const r = fuzzyFindAgent(agents, text);'), 'the 0.6 switch is decided before Jev is asked');
  assert.equal((VS.match(/jevSaysNotAName\(/g) || []).length, 2, 'one definition, one call site');
});
