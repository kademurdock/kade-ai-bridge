'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PROBES, FLAG_KEYS, parseJudge, judgePrompt, judgeWithRetry } = require('./battery');

/* ── Sep 22 2026: a judge that thinks past its budget gets one bigger try ── */
const quiet = { warn() {} };
test('a judge that ran out of budget thinking is retried once with a bigger budget', async () => {
  const budgets = [];
  const replies = [
    { choices: [{ message: { content: null }, finish_reason: 'length' }], usage: { completion_tokens: 2500, cost: 0.0006 } },
    { choices: [{ message: { content: '{"score": 80, "flags": {}}' }, finish_reason: 'stop' }], usage: { completion_tokens: 3100, cost: 0.0008 } },
  ];
  const out = await judgeWithRetry(async (b) => { budgets.push(b); return replies.shift(); }, 'm', quiet);
  assert.deepEqual(budgets, [2500, 6000]);
  assert.equal(out.attempts, 2);
  assert.equal(parseJudge(out.content).score, 80);
  assert.ok(Math.abs(out.cost - 0.0014) < 1e-9, 'both calls count against the cap');
});
test('an answer on the first try, or an empty answer for any other reason, is not retried', async () => {
  let calls = 0;
  const ok = await judgeWithRetry(async () => { calls++; return { choices: [{ message: { content: '{"score": 90}' }, finish_reason: 'stop' }], usage: {} }; }, 'm', quiet);
  assert.equal(calls, 1); assert.equal(ok.attempts, 1); assert.equal(ok.estimated, true);
  calls = 0;
  const filtered = await judgeWithRetry(async () => { calls++; return { choices: [{ message: { content: null }, finish_reason: 'content_filter' }], usage: {} }; }, 'm', quiet);
  assert.equal(calls, 1); assert.equal(filtered.content, null);
  calls = 0;
  const twice = await judgeWithRetry(async () => { calls++; return { choices: [{ message: { content: null }, finish_reason: 'length' }], usage: {} }; }, 'm', quiet);
  assert.equal(calls, 2, 'never more than one retry'); assert.equal(twice.content, null);
});

test('twelve probes, each with id, rule, want, since', () => {
  assert.equal(PROBES.length, 12);
  const ids = new Set();
  for (const p of PROBES) {
    assert.ok(p.id && p.rule && p.want && p.since && p.text, p.id);
    assert.ok(!ids.has(p.id), 'duplicate id ' + p.id);
    ids.add(p.id);
  }
});

test('parseJudge reads the JSON out of chatter and clamps', () => {
  const out = parseJudge('Sure, here you go:\n{"score": 87, "flags": {"helpdesk_register": true}, "quote": "happy to help"}\nDone.');
  assert.equal(out.score, 87);
  assert.equal(out.flags.helpdesk_register, true);
  assert.equal(out.flags.therapy_phrasing, false);
  for (const k of FLAG_KEYS) assert.ok(k in out.flags);
  assert.equal(parseJudge('{"score": 140}').score, 100);
  assert.equal(parseJudge('no json here'), null);
  assert.equal(parseJudge('{"score": "abc"}'), null);
});

test('judgePrompt names the rule, the standard, and every flag', () => {
  const p = judgePrompt(PROBES[0], 'a reply');
  assert.match(p, /comfort without therapy-speak/);
  for (const k of FLAG_KEYS) assert.ok(p.includes(k), k);
  assert.ok(p.length < 4000);
});

/* ── Part 239: Jev covers a judge that could not be read ───────────────── */
test('an unreadable judge loses its flags, and Jev stands in for exactly those', () => {
  /* The shape the run builds per probe, reproduced here so the rule can be
   * held still without a network or a model. */
  const FLAG_KEYS = ['reframe_tic', 'therapy_phrasing', 'ai_self_reference'];
  function tally(judgeResults, jevFlags) {
    const scores = []; const flags = {}; let unparsed = 0;
    for (const j of judgeResults) {
      if (!j.parsed) { unparsed += 1; continue; }
      scores.push(j.parsed.score);
      for (const k of FLAG_KEYS) if (j.parsed.flags[k]) flags[k] = (flags[k] || 0) + 1;
    }
    let jevFilled = 0;
    if (jevFlags && unparsed > 0) {
      for (const k of jevFlags) flags[k] = (flags[k] || 0) + 1;
      jevFilled = unparsed;
    }
    return { scores, flags, unparsed, jevFilled };
  }
  const bothRead = tally(
    [{ parsed: { score: 80, flags: { reframe_tic: true } } }, { parsed: { score: 76, flags: { reframe_tic: true } } }],
    ['therapy_phrasing'],
  );
  assert.equal(bothRead.jevFilled, 0, 'Jev does not join in when both judges spoke');
  assert.deepEqual(bothRead.flags, { reframe_tic: 2 });
  assert.equal(bothRead.scores.length, 2);

  const oneLost = tally(
    [{ parsed: { score: 80, flags: { reframe_tic: true } } }, { parsed: null }],
    ['reframe_tic'],
  );
  assert.equal(oneLost.unparsed, 1);
  assert.equal(oneLost.jevFilled, 1, 'and it is recorded, never hidden');
  assert.deepEqual(oneLost.flags, { reframe_tic: 2 }, 'the count is out of two again');
  assert.equal(oneLost.scores.length, 1, 'the SCORE stays the LLM pair\'s — Jev never joins the mean here');

  const noJev = tally([{ parsed: { score: 80, flags: {} } }, { parsed: null }], null);
  assert.equal(noJev.jevFilled, 0, 'Jev failing too leaves it exactly as it was');
  assert.deepEqual(noJev.flags, {});
});
