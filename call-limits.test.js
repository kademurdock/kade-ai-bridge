'use strict';
/* call-limits.test.js — Nov 10 2026. The rules of the watch that ends a quiet or very long inbound
 * call, held still with a fake clock. Nothing here opens a socket or speaks; `say` and `hangUp`
 * are recorded. The one rule every test leans on: NOBODY IS CUT OFF BY SURPRISE. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { limitsConfig, createCallWatch, spokenSpan, limitsStartupLine, LINES, ANSWER_WORDS, WARN_WAIT_MS, END_WAIT_MS, WARN_RETRY_MS, WARN_TRIES } = require('./call-limits');

const MIN = 60000;
const quiet = { log() {}, warn() {} };

/* A call on a fake clock. `sayMs` is how long a spoken line takes to play. */
function rig(cfgOver = {}, { sayMs = 6000 } = {}) {
  const cfg = { enabled: true, idleMs: 10 * MIN, idleGraceMs: 60000, maxMs: 120 * MIN, maxWarnMs: 120000, ...cfgOver };
  const r = { t: 1_000_000, busy: false, open: true, said: [], hung: [], pending: [] };
  r.watch = createCallWatch({
    cfg, now: () => r.t, log: quiet,
    isOpen: () => r.open,
    isBusy: () => r.busy || r.pending.length > 0, // while a line plays the character IS speaking
    say: (line, opts) => new Promise((resolve) => {
      r.said.push({ line, at: r.t, final: !!(opts && opts.final) });
      r.pending.push({ doneAt: r.t + sayMs, resolve });
    }),
    hangUp: (reason) => r.hung.push({ reason, at: r.t }),
  });
  /* Move the clock forward in 5 s ticks, finishing spoken lines when their time comes. */
  r.run = async (ms, step = 5000) => {
    const until = r.t + ms;
    while (r.t < until) {
      r.t = Math.min(until, r.t + step);
      for (const p of r.pending.filter((x) => x.doneAt <= r.t)) { r.pending.splice(r.pending.indexOf(p), 1); p.resolve(); }
      await new Promise((res) => setImmediate(res)); // let the say() continuation run
      r.watch.tick();
      await new Promise((res) => setImmediate(res));
    }
  };
  r.start = r.t;
  r.cfg = cfg;
  return r;
}

// ── defaults and config ───────────────────────────────────────────────────────

const ON = { CALL_LIMITS: '1' };

test('SHIPPED OFF: with no CALL_LIMITS variable nothing is armed; only CALL_LIMITS=1 (or on, true, yes) turns the watch on', () => {
  for (const env of [{}, { CALL_LIMITS: '' }, { CALL_LIMITS: '0' }, { CALL_LIMITS: 'off' }, { CALL_LIMITS: 'maybe' }, { CALL_IDLE_MINUTES: '5' }]) {
    const c = limitsConfig(env);
    assert.equal(c.enabled, false, JSON.stringify(env));
    assert.equal(c.idleMs, 0);
    assert.equal(c.maxMs, 0);
  }
  for (const v of ['1', ' 1 ', 'on', 'TRUE', 'yes']) assert.equal(limitsConfig({ CALL_LIMITS: v }).enabled, true, v);
  assert.match(limitsStartupLine(limitsConfig({})), /off \(set CALL_LIMITS=1 to turn on/);
});

test('the defaults are generous: ten quiet minutes then a minute of grace, two hours with two minutes of warning', () => {
  const c = limitsConfig(ON);
  assert.deepEqual(c, { enabled: true, idleMs: 10 * MIN, idleGraceMs: 60000, maxMs: 120 * MIN, maxWarnMs: 120000 });
});

test('every limit is an environment variable; CALL_LIMITS=0 and a limit of 0 switch things off', () => {
  const c = limitsConfig({ ...ON, CALL_IDLE_MINUTES: '4', CALL_IDLE_GRACE_SECONDS: '45', CALL_MAX_MINUTES: '90', CALL_MAX_WARN_SECONDS: '180' });
  assert.deepEqual(c, { enabled: true, idleMs: 4 * MIN, idleGraceMs: 45000, maxMs: 90 * MIN, maxWarnMs: 180000 });
  assert.equal(limitsConfig({ CALL_LIMITS: '0' }).enabled, false);
  assert.equal(limitsConfig({ CALL_LIMITS: '0' }).idleMs, 0);
  assert.equal(limitsConfig({ CALL_LIMITS: '0' }).maxMs, 0);
  const onlyMax = limitsConfig({ ...ON, CALL_IDLE_MINUTES: '0' });
  assert.equal(onlyMax.enabled, true);
  assert.equal(onlyMax.idleMs, 0);
  assert.equal(limitsConfig({ ...ON, CALL_IDLE_MINUTES: '0', CALL_MAX_MINUTES: '0' }).enabled, false);
});

test('a bad value never becomes a tiny limit: junk and negatives fall back to the defaults, and the warnings keep a floor', () => {
  const c = limitsConfig({ ...ON, CALL_IDLE_MINUTES: 'soon', CALL_MAX_MINUTES: '-5', CALL_IDLE_GRACE_SECONDS: '1', CALL_MAX_WARN_SECONDS: '0' });
  assert.equal(c.idleMs, 10 * MIN);
  assert.equal(c.maxMs, 120 * MIN);
  assert.equal(c.idleGraceMs, 15000, 'never less than 15 s to answer the check-in');
  assert.equal(c.maxWarnMs, 15000, 'never less than 15 s of warning before the end');
  // Review: a tiny positive number is not a tiny limit either.
  const tiny = limitsConfig({ ...ON, CALL_IDLE_MINUTES: '0.01', CALL_MAX_MINUTES: '0.5' });
  assert.equal(tiny.idleMs, MIN, 'never less than one quiet minute');
  assert.equal(tiny.maxMs, 2 * MIN, 'never a call shorter than two minutes');
  // The warning can never be longer than half the call.
  assert.equal(limitsConfig({ ...ON, CALL_MAX_MINUTES: '2', CALL_MAX_WARN_SECONDS: '600' }).maxWarnMs, 60000);
});

test('spoken lengths sound like a person', () => {
  assert.equal(spokenSpan(120000), 'about two minutes');
  assert.equal(spokenSpan(60000), 'about a minute');
  assert.equal(spokenSpan(30000), 'about 30 seconds');
  assert.equal(spokenSpan(180000), 'about three minutes');
  assert.match(LINES.idleWarn({ idleGraceMs: 60000 }), /end in about a minute/);
  assert.match(LINES.maxWarn({ maxWarnMs: 120000 }), /end in about two minutes/);
  assert.match(LINES.maxWarn({ maxWarnMs: 120000 }), /call right back/);
});

test('THE WORDING RULE: no spoken line uses a word a caller would answer with, so an answer is never taken for the line\'s own echo', () => {
  const cfg = { idleGraceMs: 60000, maxWarnMs: 120000 };
  for (const [name, make] of Object.entries(LINES)) {
    const words = make(cfg).toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean);
    for (const w of ANSWER_WORDS) assert.ok(!words.includes(w), `${name} says "${w}"`);
  }
});

test('the startup line says what the limits are, or that there are none', () => {
  assert.match(limitsStartupLine(limitsConfig(ON)), /asks after 10 min, hangs up 60 s later.*longest call: 120 min, warned 120 s before/);
  assert.match(limitsStartupLine(limitsConfig({ CALL_LIMITS: '0' })), /off/);
  assert.match(limitsStartupLine(limitsConfig({ ...ON, CALL_MAX_MINUTES: '0' })), /longest call: off/);
});

// ── the quiet line ────────────────────────────────────────────────────────────

test('THE PHONE LEFT OFF THE HOOK: ten quiet minutes, a spoken question, a minute of grace, then the goodbye and the hang-up', async () => {
  const r = rig();
  await r.run(10 * MIN - 5000);
  assert.equal(r.said.length, 0, 'nothing is said before the ten minutes are up');
  await r.run(5000);
  assert.equal(r.said.length, 1);
  assert.match(r.said[0].line, /Checking in/);
  assert.equal(r.said[0].final, false);
  assert.equal(r.hung.length, 0);
  // The grace runs from when the question FINISHED playing (6 s), not from when it started.
  await r.run(60000);
  assert.equal(r.said.length, 1, 'not yet: the question took 6 s to say');
  assert.equal(r.hung.length, 0);
  await r.run(10000);
  assert.equal(r.said.length, 2);
  assert.match(r.said[1].line, /ending now/);
  assert.equal(r.said[1].final, true);
  assert.equal(r.hung.length, 0, 'the hang-up waits for the goodbye to be heard');
  await r.run(10000);
  assert.deepEqual(r.hung.map((h) => h.reason), ['idle']);
  assert.ok(r.hung[0].at - r.start >= 11 * MIN, 'never sooner than the quiet time plus the grace');
});

test('NO SURPRISE: the hang-up never comes without the question having been spoken first', async () => {
  const r = rig();
  await r.run(30 * MIN);
  const question = r.said.findIndex((s) => /Checking in/.test(s.line));
  const bye = r.said.findIndex((s) => s.final);
  assert.ok(question > -1 && bye > question);
  assert.ok(r.hung[0].at > r.said[bye].at);
  assert.ok(r.said[bye].at - r.said[question].at >= 60000, 'a full grace between the question and the goodbye');
});

test('anything heard after the question cancels the hang-up, and the count starts over from there', async () => {
  const r = rig();
  await r.run(10 * MIN + 10000);
  assert.equal(r.said.length, 1);
  await r.run(30000);
  r.watch.noteHeard(); // "yes, I'm here"
  const heardAt = r.t;
  await r.run(9 * MIN);
  assert.equal(r.hung.length, 0);
  assert.equal(r.said.length, 1, 'no second question until a whole new ten quiet minutes');
  await r.run(2 * MIN);
  assert.equal(r.said.length, 2);
  assert.match(r.said[1].line, /Checking in/);
  assert.ok(r.said[1].at - heardAt >= 10 * MIN);
});

test('the caller speaks DURING the quiet-line goodbye: the call is not ended', async () => {
  const r = rig();
  await r.run(10 * MIN + 6000 + 60000 + 5000);
  assert.equal(r.said.filter((s) => s.final).length, 1, 'the goodbye has started');
  r.watch.noteHeard(); // "wait, I'm here!"
  await r.run(30000);
  assert.equal(r.hung.length, 0, 'they answered: stay');
  assert.equal(r.watch.state.ending, null);
  // And the watch is whole again: a new quiet spell is handled from the top.
  await r.run(10 * MIN + 5000);
  assert.match(r.said[r.said.length - 1].line, /Checking in/);
});

test('a talking call is never quiet: caller words every few minutes for an hour, no question ever', async () => {
  const r = rig();
  for (let i = 0; i < 20; i++) { await r.run(3 * MIN); r.watch.noteHeard(); }
  assert.equal(r.said.length, 0);
  assert.equal(r.hung.length, 0);
});

test('a character reading something long is the line in use: the quiet count does not run while it speaks or thinks', async () => {
  const r = rig();
  r.busy = true; // a fifteen-minute story
  await r.run(15 * MIN);
  assert.equal(r.said.length, 0);
  r.busy = false;
  await r.run(10 * MIN - 10000);
  assert.equal(r.said.length, 0, 'the ten minutes count from when the story ended');
  await r.run(15000);
  assert.equal(r.said.length, 1);
});

test('the question itself (the character speaking it) does not count as the line being in use', async () => {
  const r = rig({}, { sayMs: 8000 });
  await r.run(10 * MIN + 5000);
  assert.equal(r.said.length, 1);
  await r.run(8000 + 60000 + 5000);
  assert.equal(r.said.filter((s) => s.final).length, 1, 'the goodbye came a grace after the question, not ten minutes later');
});

test('a quiet limit of 0 never asks and never hangs up for quiet', async () => {
  const r = rig({ idleMs: 0, maxMs: 0 });
  await r.run(6 * 60 * MIN, 30000);
  assert.equal(r.said.length, 0);
  assert.equal(r.hung.length, 0);
});

// ── the maximum length ────────────────────────────────────────────────────────

test('THE VERY LONG CALL: warned two minutes before two hours, ended a full two minutes after the warning was heard', async () => {
  const r = rig({ idleMs: 0 });
  await r.run(118 * MIN - 5000);
  assert.equal(r.said.length, 0);
  await r.run(5000);
  assert.equal(r.said.length, 1);
  assert.match(r.said[0].line, /this call has to end in about two minutes/);
  assert.match(r.said[0].line, /call right back/);
  const warnedDone = r.said[0].at + 6000;
  await r.run(120000);
  assert.equal(r.hung.length, 0, 'not before two full minutes after the warning finished');
  await r.run(10000);
  assert.equal(r.said.length, 2);
  assert.equal(r.said[1].final, true);
  assert.ok(r.said[1].at >= warnedDone + 120000);
  await r.run(10000);
  assert.deepEqual(r.hung.map((h) => h.reason), ['max']);
});

test('the warning waits for a gap in the talk, and the two minutes run from when it was actually said', async () => {
  const r = rig({ idleMs: 0 });
  await r.run(118 * MIN - 5000);
  r.busy = true; // the character is mid-reply when the warning comes due
  await r.run(20000);
  assert.equal(r.said.length, 0, 'it does not talk over the reply');
  r.busy = false;
  await r.run(5000);
  assert.equal(r.said.length, 1);
  const saidAt = r.said[0].at;
  assert.ok(saidAt - r.start > 118 * MIN);
  await r.run(125000);
  assert.equal(r.hung.length, 0);
  assert.ok(r.said.filter((s) => s.final).length <= 1);
  await r.run(20000);
  assert.equal(r.hung.length, 1);
  assert.ok(r.hung[0].at >= saidAt + 6000 + 120000, 'a full warning period after the warning');
});

test('a character that never stops talking still gets the warning said, after a bounded wait', async () => {
  const r = rig({ idleMs: 0 });
  r.busy = true;
  await r.run(118 * MIN + WARN_WAIT_MS - 5000);
  assert.equal(r.said.length, 0);
  await r.run(10000);
  assert.equal(r.said.length, 1, 'said anyway after the wait');
  await r.run(6000 + 120000 + END_WAIT_MS + 10000);
  assert.equal(r.said.filter((s) => s.final).length, 1);
});

test('talking does not move the maximum: a lively call is still warned and ended', async () => {
  const r = rig();
  for (let i = 0; i < 61; i++) { await r.run(2 * MIN); r.watch.noteHeard(); }
  assert.ok(r.said.some((s) => /has to end/.test(s.line)));
  assert.deepEqual(r.hung.map((h) => h.reason), ['max']);
  assert.ok(!r.said.some((s) => /Checking in/.test(s.line)), 'and it was never asked if it was still there');
});

test('words during the maximum-length goodbye do not cancel it', async () => {
  const r = rig({ idleMs: 0 });
  await r.run(118 * MIN + 6000 + 120000 + 5000);
  assert.equal(r.said.filter((s) => s.final).length, 1);
  r.watch.noteHeard();
  await r.run(15000);
  assert.deepEqual(r.hung.map((h) => h.reason), ['max']);
});

test('the quiet question is not stacked on top of the length warning', async () => {
  const r = rig({ idleMs: 2 * MIN, maxMs: 10 * MIN, maxWarnMs: 120000 });
  for (let i = 0; i < 8; i++) { await r.run(57000); r.watch.noteHeard(); } // talking until just before the warning
  await r.run(30000);
  const lines = r.said.map((s) => s.line);
  assert.equal(lines.filter((l) => /has to end/.test(l)).length, 1);
  assert.equal(lines.filter((l) => /Checking in/.test(l)).length, 0, 'the caller was heard under two minutes ago');
});

// ── failure and teardown ──────────────────────────────────────────────────────

test('speech that fails outright does not hold the line for ever: the call still ends, later', async () => {
  const cfg = { enabled: true, idleMs: 10 * MIN, idleGraceMs: 60000, maxMs: 0, maxWarnMs: 120000 };
  const r = { t: 0, hung: [], said: 0 };
  const watch = createCallWatch({ cfg, now: () => r.t, log: quiet, isOpen: () => true, isBusy: () => false,
    say: async () => { r.said += 1; throw new Error('speech is down'); }, hangUp: (why) => r.hung.push(why) });
  for (let i = 0; i < 200 && !r.hung.length; i++) { r.t += 5000; watch.tick(); await new Promise((res) => setImmediate(res)); }
  assert.deepEqual(r.hung, ['idle']);
  assert.ok(r.t >= 11 * MIN);
  assert.equal(r.said, WARN_TRIES + 1, 'the check-in was tried three times before the goodbye');
});

/* Review, Nov 10 2026. A warning the voice service failed to make used to count as spoken: the
 * minute of grace started and the caller, who heard nothing, got only the goodbye. */
function failRig(cfgOver, failFirst) {
  const cfg = { enabled: true, idleMs: 10 * MIN, idleGraceMs: 60000, maxMs: 0, maxWarnMs: 120000, ...cfgOver };
  const r = { t: 0, hung: [], said: [], fails: failFirst };
  r.watch = createCallWatch({ cfg, now: () => r.t, log: quiet, isOpen: () => true, isBusy: () => false,
    say: async (line, opts) => {
      const final = !!(opts && opts.final);
      r.said.push({ line, at: r.t, final });
      if (!final && r.fails > 0) { r.fails -= 1; return false; } // what limitSay reports for a line it could not make
    },
    hangUp: (why) => r.hung.push({ why, at: r.t }) });
  r.run = async (ms) => { const end = r.t + ms; while (r.t < end) { r.t += 5000; r.watch.tick(); await new Promise((res) => setImmediate(res)); } };
  return r;
}

test('REVIEW: a check-in that could not be spoken is not a check-in given: it is tried again, and the grace runs from the one that was heard', async () => {
  const r = failRig({}, 1);
  await r.run(10 * MIN);
  assert.equal(r.said.length, 1, 'the first try, which fails');
  await r.run(5 * MIN);
  const asks = r.said.filter((s) => /Checking in/.test(s.line));
  const bye = r.said.find((s) => s.final);
  assert.equal(asks.length, 2, 'asked again after the failure');
  assert.ok(asks[1].at - asks[0].at >= WARN_RETRY_MS, 'not hammered: a pause before the second try');
  assert.ok(bye, 'the call does end');
  assert.ok(bye.at - asks[1].at >= 60000, 'a full grace after the check-in that was really spoken');
  assert.deepEqual(r.hung.map((h) => h.why), ['idle']);
});

test('REVIEW: the caller being heard between two failed check-ins starts the whole count over', async () => {
  const r = failRig({}, 1);
  await r.run(10 * MIN);
  r.watch.noteHeard();
  await r.run(9 * MIN);
  assert.equal(r.said.length, 1, 'no second check-in inside the next ten minutes');
  assert.equal(r.hung.length, 0);
});

test('REVIEW: a check-in that fails every time is tried three times, then the slow speech-is-down path ends the call', async () => {
  const r = failRig({}, 99);
  await r.run(20 * MIN);
  assert.equal(r.said.filter((s) => /Checking in/.test(s.line)).length, WARN_TRIES);
  assert.deepEqual(r.hung.map((h) => h.why), ['idle']);
  assert.ok(r.hung[0].at >= 10 * MIN + 2 * WARN_RETRY_MS + 60000 + WARN_WAIT_MS, 'later than a spoken check-in would have ended it');
});

test('REVIEW: a length warning that could not be spoken is tried again, and the full warning period runs from the one that was heard', async () => {
  const r = failRig({ idleMs: 0, maxMs: 10 * MIN, maxWarnMs: 120000 }, 1);
  await r.run(15 * MIN);
  const warns = r.said.filter((s) => /has to end/.test(s.line));
  const bye = r.said.find((s) => s.final);
  assert.equal(warns.length, 2);
  assert.ok(warns[1].at - warns[0].at >= WARN_RETRY_MS);
  assert.ok(bye.at - warns[1].at >= 120000, 'never sooner than a full warning after the warning that was spoken');
  assert.deepEqual(r.hung.map((h) => h.why), ['max']);
});

test('a call that hung up by itself stops the watch: nothing is said or done afterwards', async () => {
  const r = rig();
  await r.run(5 * MIN);
  r.open = false;
  await r.run(60 * MIN, 30000);
  assert.equal(r.said.length, 0);
  assert.equal(r.hung.length, 0);
  assert.equal(r.watch.state.stopped, true);
});

test('stop() during the goodbye means no hang-up call is made for a call that is already gone', async () => {
  const r = rig();
  await r.run(10 * MIN + 6000 + 60000 + 5000);
  assert.equal(r.said.filter((s) => s.final).length, 1);
  r.watch.stop();
  await r.run(30000);
  assert.equal(r.hung.length, 0);
});
