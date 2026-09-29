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
/* ── Part 295: a BYOK judge call costs its fee PLUS the upstream charge ── */
test('a BYOK judge reply is costed at fee + upstream, not the $0 fee alone', async () => {
  const out = await judgeWithRetry(async () => ({
    choices: [{ message: { content: '{"score": 70}' }, finish_reason: 'stop' }],
    usage: { cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.0009 } },
  }), 'm', quiet);
  assert.ok(Math.abs(out.cost - 0.0009) < 1e-12, String(out.cost));
  assert.equal(out.estimated, false, 'a reported upstream cost is a real number, not an estimate');
});
test('a normal judge reply restates cost as upstream and is costed once, so the cap trips at real spend', async () => {
  const out = await judgeWithRetry(async () => ({
    choices: [{ message: { content: '{"score": 70}' }, finish_reason: 'stop' }],
    usage: { cost: 0.0009, is_byok: false, cost_details: { upstream_inference_cost: 0.0009 } },
  }), 'm', quiet);
  assert.ok(Math.abs(out.cost - 0.0009) < 1e-12, String(out.cost));
  assert.equal(out.estimated, false);
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

/* ── Sep 29 2026: a dry test seat is topped up once, then said plainly ── */
test('runFailureReason names a dry seat, a 403, or the first error in plain words', () => {
  const { runFailureReason, SEAT_DRY_RE } = require('./battery');
  const dry = 'Request failed with status code 500: empty reply from agent (site said: Your prepaid credit has run dry, so this turn could not run.)';
  assert.ok(SEAT_DRY_RE.test(dry));
  assert.equal(runFailureReason({ ok: true, agents: { kiana: { per: [{ id: 'x', error: dry }] } } }), 'the vischeck test seat was out of site credit');
  assert.equal(runFailureReason({ ok: false, error: 'the vischeck seat is out of site credit (dry again after one top-up) — run stopped', agents: {} }), 'the vischeck test seat was out of site credit');
  assert.match(runFailureReason({ ok: false, error: 'anti-abuse/forbidden 403: nope', agents: {} }), /403/);
  assert.equal(runFailureReason({ ok: true, agents: { kiana: { per: [] } } }), '');
});

test('a dry seat is topped up once and the probe retried; dry again stops the run with a plain reason', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'battery-'));
  const oldMount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  process.env.RAILWAY_VOLUME_MOUNT_PATH = dir;
  const axios = require('axios');
  const saved = { get: axios.get, post: axios.post };
  const calls = { topUps: 0, asks: 0 };
  let dryAfterTopUp = false;
  const dryErr = () => { const e = new Error('Request failed with status code 500'); e.response = { data: { error: 'empty reply from agent (site said: Your prepaid credit has run dry, so this turn could not run.)' } }; return e; };
  axios.get = async (url) => {
    if (/admin-memories/.test(url)) return { data: { rows: [] } };
    if (/diary-admin-list/.test(url)) return { data: { entries: [] } };
    throw new Error('unexpected GET ' + url);
  };
  axios.post = async (url, body) => {
    if (/add-credits/.test(url)) { calls.topUps++; return { data: { ok: true, balanceUSD: 5 } }; }
    if (/librechat\/ask/.test(url)) {
      calls.asks++;
      if (calls.asks === 1 || dryAfterTopUp) throw dryErr();
      return { data: { seat: 'vischeck', text: 'hey there' } };
    }
    if (/openrouter/.test(url)) return { data: { choices: [{ message: { content: '{"score": 80, "flags": {}}' }, finish_reason: 'stop' }], usage: { cost: 0.0001 } } };
    throw new Error('unexpected POST ' + url);
  };
  try {
    const { makeBattery } = require('./battery');
    const quietLog = { warn() {}, info() {}, error() {} };
    const b = makeBattery({ proxyUrl: 'http://proxy', proxySecret: 's', openrouterKey: 'k', log: quietLog, jev: null });
    const first = await b.run({ trigger: 'test' });
    assert.equal(calls.topUps, 1, 'one top-up');
    assert.equal(first.row.ok, true, 'the run went on after the top-up');
    assert.equal(first.row.seatTopUp.ok, true);
    assert.equal(first.row.agents.kiana.errors, 0, 'the refused probe was retried and answered');

    calls.asks = 0; calls.topUps = 0; dryAfterTopUp = true;
    const second = await b.run({ trigger: 'test' });
    assert.equal(second.row.ok, false, 'a seat dry again after its top-up stops the run');
    assert.match(second.row.error, /out of site credit/);
    assert.equal(calls.topUps, 1, 'still only one top-up in that run');
    assert.ok(calls.asks <= 2, 'it did not burn the remaining probes');
    assert.match(b.summarize().spoken, /could not score, because the vischeck test seat was out of site credit/);
  } finally {
    axios.get = saved.get; axios.post = saved.post;
    if (oldMount === undefined) delete process.env.RAILWAY_VOLUME_MOUNT_PATH; else process.env.RAILWAY_VOLUME_MOUNT_PATH = oldMount;
  }
});
