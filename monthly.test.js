'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { realSpend, monthKeyOf, makeMonthly } = require('./monthly');

test('real spend: balance pots count down, usage pots count up, other months ignored', () => {
  const hist = [
    { dateKey: '2026-08-31', moonshot: 10, openrouter_usage: 50 },
    { dateKey: '2026-09-01', moonshot: 9, openrouter_usage: 52 },
    { dateKey: '2026-09-05', moonshot: 4.12, openrouter_usage: 81.42 },
  ];
  const r = realSpend(hist, '2026-09');
  assert.equal(r.moonshot, 4.88);
  assert.equal(r.openrouter, 29.42);
  assert.equal(r.models, 34.3);
  assert.equal(r.days, 2);
  assert.equal(realSpend(hist, '2026-07').models, 0);
});

test('month keys roll in Central time', () => {
  assert.equal(monthKeyOf(new Date('2026-09-01T04:30:00Z')), '2026-08'); // still Aug 31 in Chicago
  assert.equal(monthKeyOf(new Date('2026-09-01T05:30:00Z')), '2026-09');
  assert.equal(monthKeyOf(new Date('2026-09-05T05:00:00Z'), 1), '2026-08');
});

test('report reads charged from the fork and names the multiplier the month needed', async () => {
  const fetchImpl = async (url) => String(url).includes('/my-cost')
    ? ({ ok: true, json: async () => ({ multiplier: 2 }) })
    : ({ ok: true, json: async () => ({ totals: { llmSpendUSD: { window: 68.6 }, extraSpendUSD: { window: 2.93 } }, users: [1, 2, 3] }) });
  const hist = [{ dateKey: '2026-09-01', moonshot: 9, openrouter_usage: 52 }, { dateKey: '2026-09-05', moonshot: 4.12, openrouter_usage: 81.42 }];
  const m = makeMonthly({ proxyUrl: 'x', proxySecret: 'y', readBalanceHistory: () => hist, runNotify: async () => ({}), adminUserId: 'u', fetchImpl, log: { warn() {} } });
  const r = await m.report({ monthKey: '2026-09', days: 5 });
  assert.equal(r.charged, 68.6);
  assert.equal(r.real.models, 34.3);
  assert.equal(r.multiplier, 2);
  assert.equal(r.ratio, 2);
  assert.ok(r.multiplierNeeded > 1);
  assert.equal(r.fixedSoFar, 11.67); // 5 of 30 September days of $70
  const c = await m.report({ monthKey: '2026-09', days: 30, closing: true });
  assert.equal(c.fixedSoFar, 70);
  assert.match(r.spoken, /Z\.AI pot is not watched/);
  delete process.env.KADE_BILLING_MULTIPLIER;
});
