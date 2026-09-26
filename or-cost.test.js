/* or-cost.test.js — Sep 26 2026, Part 295.
 *
 * Her Google key goes into OpenRouter as BYOK. OpenRouter's usage accounting then
 * puts only its own fee in usage.cost and Google's charge in
 * usage.cost_details.upstream_inference_cost, so a BYOK reply costs the sum, or it
 * bills the family $0 and shows her $0 as real. But a normal reply restates its cost
 * in that same field, so only is_byok === true adds it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openRouterCost, upstreamCost } = require('./or-cost');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test('a normal OpenRouter call: usage.cost is the whole cost, upstream is 0 or null', () => {
  close(openRouterCost({ cost: 0.0042 }), 0.0042);
  close(openRouterCost({ cost: 0.0042, cost_details: { upstream_inference_cost: null } }), 0.0042);
  close(openRouterCost({ cost: 0.0042, cost_details: { upstream_inference_cost: 0 } }), 0.0042);
  assert.equal(upstreamCost({ cost: 0.0042 }), 0);
});

test('THE REAL NON-BYOK SHAPE: upstream restates cost and is never added', () => {
  // Trimmed from a saved live reply (Pluto blind gate, google/gemini-2.5-flash-lite,
  // provider Google); all 296 saved A/B replies have the same shape.
  const real = {
    prompt_tokens: 89760, completion_tokens: 5009, cost: 0.0125646, is_byok: false,
    cost_details: { upstream_inference_cost: 0.0125646, upstream_inference_prompt_cost: 0.010561, upstream_inference_completions_cost: 0.0020036 },
  };
  close(openRouterCost(real), 0.0125646);
  assert.equal(upstreamCost(real), 0, 'OpenRouter paid Google here, not her key');
  const { is_byok, ...noFlag } = real;
  close(openRouterCost(noFlag), 0.0125646);
  assert.equal(upstreamCost(noFlag), 0, 'a reply without is_byok is not BYOK');
});

test('HER BYOK CALL: a $0 fee plus Google\'s charge is the real cost, never $0', () => {
  const byok = { cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.0187 } };
  close(openRouterCost(byok), 0.0187);
  close(upstreamCost(byok), 0.0187);
});

test('past the free BYOK allowance the fee and the upstream charge both count', () => {
  close(openRouterCost({ cost: 0.00094, is_byok: true, cost_details: { upstream_inference_cost: 0.0187 } }), 0.01964);
});

test('no cost numbers at all is null, so callers can fall back to their own estimate', () => {
  for (const u of [undefined, null, {}, { prompt_tokens: 10 }, { cost: null }, { cost: 'n/a' }, { cost_details: {} },
    { cost_details: { upstream_inference_cost: 0.01 } }]) {
    assert.equal(openRouterCost(u), null, JSON.stringify(u));
  }
});

test('numeric strings are read; a negative fee never subtracts from the bill', () => {
  close(openRouterCost({ cost: '0.001', is_byok: true, cost_details: { upstream_inference_cost: '0.002' } }), 0.003);
  close(openRouterCost({ cost: -0.5, is_byok: true, cost_details: { upstream_inference_cost: 0.01 } }), 0.01);
});
