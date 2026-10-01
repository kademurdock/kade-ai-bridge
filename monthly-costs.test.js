'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { monthKeyOf, centralParts, calendarWindow, providerCosts } = require('./monthly-costs');

const september = () => calendarWindow('2026-09', new Date('2026-10-01T14:00:00Z'), true);
const row = (at, values = {}) => ({ at, ...values });

test('month selection and local hour follow Chicago across year and DST boundaries', () => {
  assert.equal(monthKeyOf(new Date('2026-10-01T04:59:59Z')), '2026-09');
  assert.equal(monthKeyOf(new Date('2026-10-01T05:00:00Z')), '2026-10');
  assert.equal(monthKeyOf(new Date('2026-01-01T06:00:00Z'), 1), '2025-12');
  assert.equal(centralParts(new Date('2026-11-01T15:00:00Z')).h, 9);
  assert.equal(centralParts(new Date('2026-10-01T14:00:00Z')).h, 9);
});

test('September is an exact exclusive Chicago calendar window', () => {
  assert.deepEqual(september(), {
    month: '2026-09', timeZone: 'America/Chicago', from: '2026-09-01T05:00:00.000Z',
    to: '2026-10-01T05:00:00.000Z', endExclusive: true, complete: true,
  });
});

test('spring and autumn month edges preserve the DST hour', () => {
  const march = calendarWindow('2026-03', new Date('2026-04-02T00:00:00Z'), true);
  assert.equal(march.from, '2026-03-01T06:00:00.000Z');
  assert.equal(march.to, '2026-04-01T05:00:00.000Z');
  assert.equal((Date.parse(march.to) - Date.parse(march.from)) / 3600000, 743);
  const november = calendarWindow('2026-11', new Date('2026-12-02T00:00:00Z'), true);
  assert.equal(november.from, '2026-11-01T05:00:00.000Z');
  assert.equal(november.to, '2026-12-01T06:00:00.000Z');
  assert.equal((Date.parse(november.to) - Date.parse(november.from)) / 3600000, 721);
});

test('current month ends at now while a historical month ends at its own boundary', () => {
  const now = new Date('2026-10-01T14:00:00Z');
  const current = calendarWindow('2026-10', now);
  assert.equal(current.from, '2026-10-01T05:00:00.000Z');
  assert.equal(current.to, now.toISOString());
  assert.equal(current.complete, false);
  assert.equal(calendarWindow('2026-09', now).to, september().to);
  assert.equal(calendarWindow('2026-11', now).from, calendarWindow('2026-11', now).to);
  assert.throws(() => calendarWindow('2026-10', now, true), /unfinished/);
  assert.throws(() => calendarWindow('2026-13', now), /YYYY-MM/);
});

test('an October 1 boundary snapshot completes September counter coverage', () => {
  const window = september();
  const result = providerCosts([
    row('2026-08-31T05:00:00Z', { openrouter_usage: 1 }),
    row(window.from, { dateKey: 'wrong-date-key', openrouter_usage: 100 }),
    row('2026-09-30T05:00:00Z', { openrouter_usage: 124 }),
    row(window.to, { dateKey: '2026-10-01', openrouter_usage: 125 }),
    row('2026-10-01T06:00:00Z', { openrouter_usage: 999 }),
  ], window);
  assert.equal(result.providers.openrouter.recordedUSD, 25);
  assert.deepEqual(result.providers.openrouter.coverage, {
    status: 'complete', from: window.from, to: window.to,
    reason: 'Timestamped usage-counter observations match both requested boundaries.',
  });
  assert.equal(result.recordedUSD, 25);
  assert.equal(result.complete, false, 'other provider costs are still unknown');
  assert.equal(result.coverage.status, 'partial');
});

test('inner snapshots report their observed interval rather than the full month', () => {
  const result = providerCosts([
    row('2026-09-01T06:12:00Z', { openrouter_usage: 10 }),
    row('2026-09-30T05:33:00Z', { openrouter_usage: 20 }),
  ], september());
  const provider = result.providers.openrouter;
  assert.equal(provider.recordedUSD, 10);
  assert.equal(provider.coverage.status, 'partial');
  assert.equal(provider.coverage.from, '2026-09-01T06:12:00.000Z');
  assert.equal(provider.coverage.to, '2026-09-30T05:33:00.000Z');
  assert.match(provider.coverage.reason, /boundary observations are missing/);
});

test('dateKey-only, invalid and date-only at observations do not fabricate zero costs', () => {
  const result = providerCosts([
    { dateKey: '2026-09-01', openrouter_usage: 1 },
    { dateKey: '2026-09-30', openrouter_usage: 9 },
    row('2026-09-01', { moonshot: 10 }),
    row('not-a-time', { moonshot: 5 }),
    row('2026-09-01T05:00:00', { openrouter_usage: 1 }),
    row('2026-09-31T05:00:00Z', { openrouter_usage: 9 }),
    row(Number.MAX_VALUE, { openrouter_usage: 9 }),
  ], september());
  assert.equal(result.recordedUSD, null);
  assert.equal(result.coverage.status, 'unavailable');
  for (const provider of Object.values(result.providers)) {
    assert.equal(provider.recordedUSD, null);
    assert.equal(provider.coverage.status, 'unavailable');
    assert.equal(provider.coverage.from, null);
  }
});

test('a counter reset keeps the cost unknown even with matching boundaries', () => {
  const window = september();
  const result = providerCosts([
    row(window.from, { openrouter_usage: 100 }),
    row('2026-09-15T05:00:00Z', { openrouter_usage: 10 }),
    row(window.to, { openrouter_usage: 150 }),
  ], window);
  assert.equal(result.providers.openrouter.recordedUSD, null);
  assert.equal(result.providers.openrouter.coverage.status, 'partial');
  assert.match(result.providers.openrouter.coverage.reason, /reset/);
  assert.equal(result.recordedUSD, null);
});

test('one observation or conflicting same-time values cannot determine spend', () => {
  const window = september();
  const single = providerCosts([row(window.from, { openrouter_usage: 1 })], window);
  assert.equal(single.providers.openrouter.recordedUSD, null);
  assert.equal(single.providers.openrouter.coverage.status, 'partial');
  const conflict = providerCosts([
    row(window.from, { openrouter_usage: 1 }), row(window.from, { openrouter_usage: 2 }),
    row(window.to, { openrouter_usage: 3 }),
  ], window);
  assert.equal(conflict.providers.openrouter.recordedUSD, null);
  assert.match(conflict.providers.openrouter.coverage.reason, /Conflicting/);
});

test('a balance decrease is separate evidence and never contributes unsupported cost', () => {
  const window = september();
  const result = providerCosts([
    row(window.from, { moonshot: 10, openrouter_usage: 10 }),
    row(window.to, { moonshot: 5, openrouter_usage: 18 }),
  ], window);
  assert.equal(result.providers.moonshot.recordedUSD, null);
  assert.equal(result.providers.moonshot.observedBalanceDecreaseUSD, 5);
  assert.equal(result.providers.moonshot.coverage.status, 'partial');
  assert.match(result.providers.moonshot.coverage.reason, /top-ups/);
  assert.equal(result.recordedUSD, 8);
});

test('a balance increase leaves spending unknown rather than clamping it to zero', () => {
  const window = september();
  const result = providerCosts([
    row(window.from, { moonshot: 10, openrouter: 10 }),
    row(window.to, { moonshot: 20, openrouter: 20 }),
  ], window);
  assert.equal(result.providers.moonshot.recordedUSD, null);
  assert.equal(result.providers.openrouter.recordedUSD, null);
  assert.equal(result.recordedUSD, null);
  assert.match(result.providers.openrouter.coverage.reason, /Balance increased/);
});

test('OpenRouter balance fallback remains unsupported and a counter is preferred', () => {
  const window = september();
  const fallback = providerCosts([
    row(window.from, { openrouter: 10 }), row(window.to, { openrouter: 7 }),
  ], window);
  assert.equal(fallback.providers.openrouter.recordedUSD, null);
  assert.equal(fallback.providers.openrouter.observedBalanceDecreaseUSD, 3);
  const result = providerCosts([
    row(window.from, { openrouter: 10, openrouter_usage: 1 }),
    row(window.to, { openrouter: 7, openrouter_usage: 2 }),
  ], window);
  assert.equal(result.providers.openrouter.recordedUSD, 1);
  assert.equal(result.providers.openrouter.coverage.status, 'complete');
});

test('an authoritative counter delta of zero is distinct from an unavailable meter', () => {
  const window = september();
  const result = providerCosts([
    row(window.from, { openrouter_usage: 0 }), row(window.to, { openrouter_usage: 0 }),
  ], window);
  assert.equal(result.providers.openrouter.recordedUSD, 0);
  assert.equal(result.providers.openrouter.coverage.status, 'complete');
  assert.equal(result.providers.moonshot.recordedUSD, null);
  assert.equal(result.recordedUSD, 0);
  assert.equal(result.complete, false);
});

test('ZAI counts only whole UTC days contained within the Chicago month', () => {
  const result = providerCosts([], september(), {
    '2026-09-01': 100, '2026-09-02': 0.1, '2026-09-30': { usd: 0.2 }, '2026-10-01': 50,
  });
  const provider = result.providers.zai;
  assert.equal(provider.recordedUSD, 0.3);
  assert.equal(provider.coverage.status, 'partial');
  assert.equal(provider.coverage.from, '2026-09-02T00:00:00.000Z');
  assert.equal(provider.coverage.to, '2026-10-01T00:00:00.000Z');
  assert.match(provider.coverage.reason, /partial UTC days/);
  assert.match(provider.coverage.reason, /Omitted 2/);
  assert.equal(provider.measurement.includes('UTC'), true);
});

test('partially overlapping UTC buckets alone do not supply an amount', () => {
  const result = providerCosts([], september(), { '2026-09-01': 1, '2026-10-01': 2 });
  assert.equal(result.providers.zai.recordedUSD, null);
  assert.equal(result.providers.zai.coverage.status, 'unavailable');
  assert.match(result.providers.zai.coverage.reason, /cannot be allocated/);
});

test('Google day buckets follow Chicago calendar boundaries and name their partial scope', () => {
  const result = providerCosts([], september(), {}, {
    '2026-08-31': 10, '2026-09-01': 0.1, '2026-09-30': 0.2, '2026-10-01': 20,
  });
  const provider = result.providers.google;
  assert.equal(provider.recordedUSD, 0.3);
  assert.equal(provider.coverage.from, september().from);
  assert.equal(provider.coverage.to, september().to);
  assert.equal(provider.coverage.status, 'partial', 'a full time range does not establish full provider scope');
  assert.match(provider.measurement, /partial provider scope/);
});

test('Google current partial day is observed without pretending it is a full day', () => {
  const window = calendarWindow('2026-11', new Date('2026-11-01T07:00:00Z'));
  const result = providerCosts([], window, {}, { '2026-10-31': 50, '2026-11-01': 0.15 });
  const provider = result.providers.google;
  assert.equal(provider.recordedUSD, 0.15);
  assert.equal(provider.coverage.from, '2026-11-01T05:00:00.000Z');
  assert.equal(provider.coverage.to, '2026-11-01T07:00:00.000Z');
  assert.match(provider.coverage.reason, /current partial Chicago day/);
  assert.equal(provider.coverage.status, 'partial');
});

test('Google whole day boundaries account for the 23 and 25 hour DST days', () => {
  const march = providerCosts([], calendarWindow('2026-03', new Date('2026-04-02T00:00:00Z')), {}, { '2026-03-08': 1 });
  const november = providerCosts([], calendarWindow('2026-11', new Date('2026-12-02T00:00:00Z')), {}, { '2026-11-01': 1 });
  const hours = (entry) => (Date.parse(entry.coverage.to) - Date.parse(entry.coverage.from)) / 3600000;
  assert.equal(hours(march.providers.google), 23);
  assert.equal(hours(november.providers.google), 25);
});

test('invalid day amounts remain unknown and observed fractions are rounded once for the subtotal', () => {
  const window = september();
  const result = providerCosts([
    row(window.from, { openrouter_usage: 0.1 }), row(window.to, { openrouter_usage: 0.3 }),
  ], window, { '2026-09-02': 0.1, '2026-09-03': null, '2026-09-04': 'NaN', '2026-09-05': -1 },
  { '2026-09-31': 99, '2026-09-02': Infinity });
  assert.equal(result.providers.openrouter.recordedUSD, 0.2);
  assert.equal(result.providers.zai.recordedUSD, 0.1);
  assert.equal(result.providers.google.recordedUSD, null);
  assert.equal(result.recordedUSD, 0.3);
  const tiny = providerCosts([
    row(window.from, { openrouter_usage: 0 }), row(window.to, { openrouter_usage: 0.004 }),
  ], window, { '2026-09-02': 0.004 });
  assert.equal(tiny.recordedUSD, 0.01, 'sum source observations before rounding the subtotal');
});

test('provider accounting is pure and refuses an ambiguous window', () => {
  const window = september();
  const history = [row(window.from, { openrouter_usage: 1 }), row(window.to, { openrouter_usage: 2 })];
  const days = { '2026-09-02': 0.1 };
  const before = JSON.stringify({ history, days, window });
  providerCosts(history, window, days, days);
  assert.equal(JSON.stringify({ history, days, window }), before);
  assert.throws(() => providerCosts(history, { ...window, endExclusive: false }), /exclusive/);
});
