'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PROBES, FLAG_KEYS, parseJudge, judgePrompt } = require('./battery');

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
