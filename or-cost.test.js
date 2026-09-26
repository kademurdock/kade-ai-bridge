/* or-cost.test.js — Sep 26 2026, Part 295.
 *
 * Her Google key goes into OpenRouter as BYOK. OpenRouter's usage accounting then
 * puts only its own fee in usage.cost and Google's charge in
 * usage.cost_details.upstream_inference_cost. Every cost reader must add the two,
 * or a BYOK call bills the family $0 and shows her $0 as real.
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

test('HER BYOK CALL: a $0 fee plus Google\'s charge is the real cost, never $0', () => {
  const byok = { cost: 0, cost_details: { upstream_inference_cost: 0.0187 } };
  close(openRouterCost(byok), 0.0187);
  close(upstreamCost(byok), 0.0187);
});

test('past the free BYOK allowance the fee and the upstream charge both count', () => {
  close(openRouterCost({ cost: 0.00094, cost_details: { upstream_inference_cost: 0.0187 } }), 0.01964);
});

test('no cost numbers at all is null, so callers can fall back to their own estimate', () => {
  for (const u of [undefined, null, {}, { prompt_tokens: 10 }, { cost: null }, { cost: 'n/a' }, { cost_details: {} }]) {
    assert.equal(openRouterCost(u), null, JSON.stringify(u));
  }
});

test('numeric strings are read; a negative fee never subtracts from the bill', () => {
  close(openRouterCost({ cost: '0.001', cost_details: { upstream_inference_cost: '0.002' } }), 0.003);
  close(openRouterCost({ cost: -0.5, cost_details: { upstream_inference_cost: 0.01 } }), 0.01);
});
