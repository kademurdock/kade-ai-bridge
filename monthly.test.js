'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeMonthly, attachMonthly, isScheduledTime } = require('./monthly');

const now = new Date('2026-10-01T14:00:47.872Z');
const window = { from: '2026-09-01T05:00:00.000Z', to: '2026-10-01T05:00:00.000Z', timeZone: 'America/Chicago', endExclusive: true };
const payload = {
  version: 1, window,
  ownerExempt: { chatNominalUSD: 11.47, extrasNominalUSD: 12.46 },
  nonAdmin: { chatChargedUSD: 15.24, extrasChargedUSD: 7.29, walletChargedUSD: 22.53, extrasRecordedChargedUSD: 7.20, extrasInferredChargedUSD: 0.09, walletRecordedChargedUSD: 22.44 },
  unclassified: { chatNominalUSD: 0, extrasNominalUSD: 0 },
  repayments: { recordedUSD: 30, count: 1 }, grants: { netUSD: 10, count: 1 },
  extraRecords: { costUSD: 19.85, voiceEstimateUSD: 0.09, voiceEstimateRows: 1 }, coverage: { roleBasis: 'current', legacyExtraRows: 1, nonAdminLegacyExtraRows: 1 },
};
const history = [
  { at: '2026-09-01T05:46:42Z', dateKey: '2026-09-01', openrouter_usage: 81.28, moonshot: 4.3 },
  { at: '2026-09-30T05:46:42Z', dateKey: '2026-09-30', openrouter_usage: 126.19, moonshot: 0 },
  { at: '2026-10-01T05:46:42Z', dateKey: '2026-10-01', openrouter_usage: 126.85, moonshot: 0 },
];
function monthly(overrides = {}) {
  return makeMonthly({ proxyUrl: 'https://example.test', proxySecret: 'test-secret', readBalanceHistory: () => history, runNotify: async () => {}, adminUserId: 'owner', clock: () => now, fetchImpl: async () => ({ ok: true, json: async () => payload }), ...overrides });
}

test('closed report requests one Chicago calendar window and keeps accounting categories separate', async () => {
  const calls = [];
  const m = monthly({ fetchImpl: async (url) => { calls.push(new URL(url)); return { ok: true, json: async () => payload }; } });
  const report = await m.report({ monthKey: '2026-09', closing: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/librechat/monthly-books');
  assert.equal(calls[0].searchParams.get('from'), window.from);
  assert.equal(calls[0].searchParams.get('to'), window.to);
  assert.equal(calls[0].searchParams.has('days'), false);
  assert.equal(report.accounting.nonAdmin.walletChargedUSD, 22.53);
  assert.equal(report.accounting.ownerExempt.chatNominalUSD, 11.47);
  assert.equal(report.accounting.repayments.recordedUSD, 30);
  assert.equal(report.accounting.grants.netUSD, 10);
  assert.equal(report.fixedBills.estimatedWindowUSD, 70);
  assert.equal(report.comparison.comparable, false);
  assert.equal(report.multiplierNeeded, null);
  assert.equal(report.ratio, null);
  assert.match(report.spoken, /wallet charges, classified by current account roles: \$22\.44; chat debits \$15\.24, net extras charges \$7\.20/);
  assert.match(report.spoken, /wallet charge amount is inferred separately/);
  assert.match(report.spoken, /Current owner's usage/);
  assert.match(report.spoken, /voice estimates that may overlap chat/);
  assert.match(report.spoken, /not a complete monthly provider bill/);
  assert.doesNotMatch(report.spoken, /needed about|Charged over real|really cost/);
});

test('different endpoint window and old rolling usage response are unavailable, never zero charges', async () => {
  for (const response of [{ totals: { llmSpendUSD: { window: 27.93 } } }, { ...payload, window: { ...window, to: '2026-10-01T14:00:00.000Z' } }, { ...payload, nonAdmin: { ...payload.nonAdmin, chatChargedUSD: NaN } }, { ...payload, nonAdmin: { ...payload.nonAdmin, walletChargedUSD: 22.55 } }]) {
    const report = await monthly({ fetchImpl: async () => ({ ok: true, json: async () => response }) }).report({ monthKey: '2026-09', closing: true });
    assert.equal(report.accounting.available, false);
    assert.equal(report.accounting.nonAdmin, undefined);
    assert.match(report.spoken, /are unavailable/);
    assert.doesNotMatch(report.spoken, /Family wallet charges \$0/);
  }
});

test('an older fork or proxy missing the endpoint is unavailable without a rolling-window fallback', async () => {
  const calls = [];
  const report = await monthly({ fetchImpl: async (url) => { calls.push(new URL(url)); return { ok: false, status: 404 }; } }).report({ monthKey: '2026-09', closing: true });
  assert.equal(report.accounting.available, false);
  assert.equal(report.accounting.error, 'accounting 404');
  assert.deepEqual(calls.map((url) => url.pathname), ['/librechat/monthly-books']);
  assert.match(report.spoken, /are unavailable/);
  assert.equal(report.multiplierNeeded, null);
});

test('current report stops at now and sends identical bounds to the accounting endpoint', async () => {
  let requested;
  const m = monthly({ fetchImpl: async (url) => {
    requested = new URL(url);
    return { ok: true, json: async () => ({ ...payload, window: { ...window, from: requested.searchParams.get('from'), to: requested.searchParams.get('to') } }) };
  } });
  const report = await m.report();
  assert.equal(report.month, '2026-10');
  assert.equal(report.window.from, '2026-10-01T05:00:00.000Z');
  assert.equal(report.window.to, now.toISOString());
  assert.equal(report.window.complete, false);
  assert.equal(report.accounting.available, true);
  assert.ok(report.fixedBills.estimatedWindowUSD < 1);
});

test('signed extras refunds and net grant corrections remain valid accounting', async () => {
  const refund = { ...payload, ownerExempt: { chatNominalUSD: 0, extrasNominalUSD: -2 }, nonAdmin: { chatChargedUSD: 0, extrasChargedUSD: -1.5, walletChargedUSD: -1.5, extrasRecordedChargedUSD: -1.5, extrasInferredChargedUSD: 0, walletRecordedChargedUSD: -1.5 }, grants: { netUSD: -5, count: 1 }, extraRecords: { costUSD: -3.5, voiceEstimateUSD: 0, voiceEstimateRows: 0 }, coverage: { roleBasis: 'current', legacyExtraRows: 0 } };
  const report = await monthly({ fetchImpl: async () => ({ ok: true, json: async () => refund }) }).report({ monthKey: '2026-09', closing: true });
  assert.equal(report.accounting.available, true);
  assert.equal(report.accounting.nonAdmin.walletRecordedChargedUSD, -1.5);
  assert.match(report.spoken, /net extras charges \$-1\.50/);
  assert.match(report.spoken, /credit grants \$-5\.00/);
});

test('independently rounded components can differ from the raw combined total by one cent', async () => {
  const small = { ...payload, nonAdmin: { chatChargedUSD: 0, extrasChargedUSD: 0, walletChargedUSD: 0.01, extrasRecordedChargedUSD: 0, extrasInferredChargedUSD: 0, walletRecordedChargedUSD: 0.01 } };
  const report = await monthly({ fetchImpl: async () => ({ ok: true, json: async () => small }) }).report({ monthKey: '2026-09', closing: true });
  assert.equal(report.accounting.available, true);
  assert.equal(report.accounting.nonAdmin.walletRecordedChargedUSD, 0.01);
});

test('monthly schedule follows 9am Chicago in summer and winter', () => {
  assert.equal(isScheduledTime(new Date('2026-10-01T14:00:00Z')), true);
  assert.equal(isScheduledTime(new Date('2026-12-01T15:00:00Z')), true);
  assert.equal(isScheduledTime(new Date('2026-12-01T14:00:00Z')), false);
  assert.equal(isScheduledTime(new Date('2026-12-02T15:00:00Z')), false);
  assert.equal(isScheduledTime(new Date('2026-12-01T14:00:00Z'), { utcHour: 14 }), true);
});

test('legacy reports are flagged without rewriting the historical ledger or generating a notification', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monthly-report-test-'));
  const ledgerPath = path.join(directory, 'monthly.jsonl');
  const original = JSON.stringify({ month: '2026-09', closing: true, charged: 27.93, multiplierNeeded: 2.68, ratio: 0.52, spoken: 'old report' }) + '\n';
  fs.writeFileSync(ledgerPath, original);
  const report = monthly({ ledgerPath }).lastClosed();
  assert.equal(report.legacyReport, true);
  assert.equal(report.multiplierNeeded, null);
  assert.equal(report.comparison.comparable, false);
  assert.match(report.spoken, /Historical report/);
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), original);
});

test('close persists the previous month with exact bounds and sends only its new scoped wording', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monthly-report-close-test-'));
  const ledgerPath = path.join(directory, 'monthly.jsonl');
  const notifications = [];
  const m = monthly({ ledgerPath, runNotify: async (request) => notifications.push(request) });
  const report = await m.close({ trigger: 'test' });
  assert.equal(report.month, '2026-09');
  assert.equal(report.window.to, window.to);
  assert.equal(report.trigger, 'test');
  assert.deepEqual(m.lastClosed(), report);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].body, report.spoken);
  assert.equal(notifications[0].userId, 'owner');
});

test('paused reports expose an honest status without accounting reads, ledger writes or notifications', async () => {
  const m = monthly({ enabled: false, fetchImpl: async () => assert.fail('must not fetch'), readBalanceHistory: () => assert.fail('must not read provider accounting'), runNotify: async () => assert.fail('must not notify'), ledgerPath: 'unreachable-test-ledger' });
  const report = await m.report();
  assert.equal(report.disabled, true);
  assert.equal(report.accounting, undefined);
  assert.equal(report.spoken, 'Monthly reporting is paused.');
  await assert.rejects(m.close(), /Monthly reporting is paused/);
});

test('paused route retains authorization, blocks manual fire and does not arm the clock', async () => {
  const previous = process.env.MONTHLY_REPORT_ENABLED;
  process.env.MONTHLY_REPORT_ENABLED = '0';
  const routes = {};
  try {
    const m = attachMonthly({ get: (name, fn) => { routes[name] = fn; }, post: (name, fn) => { routes[name] = fn; } }, { bridgeSecretOk: () => true, runNotify: async () => assert.fail('must not notify') });
    assert.equal(m.enabled, false);
    let status;
    let body;
    await routes['/monthly/fire']({ get: () => 'test', query: {} }, { status: (code) => { status = code; return { json: (value) => { body = value; } }; } });
    assert.equal(status, 503);
    assert.equal(body.error, 'Monthly reporting is paused');
  } finally {
    if (previous === undefined) delete process.env.MONTHLY_REPORT_ENABLED;
    else process.env.MONTHLY_REPORT_ENABLED = previous;
  }
});
