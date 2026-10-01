'use strict';

const fs = require('fs');
const path = require('path');
const { calendarWindow, providerCosts, monthKeyOf, centralParts } = require('./monthly-costs');

const configuredFixed = Number(process.env.MONTHLY_FIXED_USD || 70);
const FIXED_USD = Number.isFinite(configuredFixed) && configuredFixed >= 0 ? configuredFixed : 70;
const LEDGER = process.env.MONTHLY_LEDGER || '/data/monthly.jsonl';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const money = (value) => `$${value.toFixed(2)}`;

function isScheduledTime(now, { centralHour = 9, utcHour = null } = {}) {
  const parts = centralParts(now);
  return parts.d === 1 && (utcHour == null ? parts.h === centralHour : now.getUTCHours() === utcHour);
}

function makeMonthly({ proxyUrl, proxySecret, readBalanceHistory, readZaiDays = () => ({}), readGoogleDays = () => ({}), runNotify, adminUserId, log = console, fetchImpl = global.fetch, clock = () => new Date(), ledgerPath = LEDGER, enabled = process.env.MONTHLY_REPORT_ENABLED !== '0' }) {
  async function accountingFromFork(window) {
    const params = new URLSearchParams({ from: window.from, to: window.to });
    const response = await fetchImpl(`${proxyUrl}/librechat/monthly-books?${params}`, {
      headers: { Authorization: `Bearer ${proxySecret}`, 'User-Agent': UA },
    });
    if (!response.ok) throw new Error(`accounting ${response.status}`);
    const data = await response.json();
    if (data.version !== 1 || data.window?.from !== window.from || data.window?.to !== window.to || data.window?.timeZone !== window.timeZone || data.window?.endExclusive !== true) {
      throw new Error('accounting window does not match');
    }
    const fields = {
      ownerExempt: ['chatNominalUSD', 'extrasNominalUSD'],
      nonAdmin: ['chatChargedUSD', 'extrasChargedUSD', 'walletChargedUSD', 'extrasRecordedChargedUSD', 'extrasInferredChargedUSD', 'walletRecordedChargedUSD'],
      unclassified: ['chatNominalUSD', 'extrasNominalUSD'],
      repayments: ['recordedUSD', 'count'],
      grants: ['netUSD', 'count'],
    };
    const accounting = { available: true, window: data.window, coverage: data.coverage || {}, ...(data.extraRecords ? { extraRecords: data.extraRecords } : {}) };
    for (const [category, names] of Object.entries(fields)) {
      accounting[category] = {};
      for (const name of names) {
        const value = data[category]?.[name];
        const nonnegative = ['chatNominalUSD', 'chatChargedUSD', 'recordedUSD', 'count'].includes(name);
        if (!Number.isFinite(value) || (nonnegative && value < 0) || (name === 'count' && !Number.isInteger(value))) throw new Error('invalid accounting totals');
        accounting[category][name] = name === 'count' ? value : round(value);
      }
    }
    const charges = accounting.nonAdmin;
    const matchesRoundedSum = (left, right, total) => Math.abs(round(left + right) - total) <= 0.010001;
    if (!matchesRoundedSum(charges.chatChargedUSD, charges.extrasChargedUSD, charges.walletChargedUSD) || !matchesRoundedSum(charges.extrasRecordedChargedUSD, charges.extrasInferredChargedUSD, charges.extrasChargedUSD) || !matchesRoundedSum(charges.chatChargedUSD, charges.extrasRecordedChargedUSD, charges.walletRecordedChargedUSD)) throw new Error('inconsistent wallet accounting totals');
    return accounting;
  }

  async function report({ monthKey, closing = false } = {}) {
    const now = clock();
    if (!enabled) return { version: 2, disabled: true, spoken: 'Monthly reporting is paused.', at: now.toISOString() };
    const month = monthKey || monthKeyOf(now);
    const window = calendarWindow(month, now, closing);
    const [accounting, history, zai, google] = await Promise.all([
      accountingFromFork(window).catch((error) => ({ available: false, window, error: error.message })),
      Promise.resolve().then(readBalanceHistory),
      Promise.resolve().then(readZaiDays),
      Promise.resolve().then(readGoogleDays),
    ]);
    const costs = providerCosts(history, window, zai, google);
    const fullWindow = calendarWindow(month, new Date(Date.parse(window.from) + 32 * 86400000), true);
    const fraction = Math.max(0, Math.min(1, (Date.parse(window.to) - Date.parse(window.from)) / (Date.parse(fullWindow.to) - Date.parse(fullWindow.from))));
    const fixedBills = { source: 'configuration estimate, not an invoice', estimatedMonthlyUSD: FIXED_USD, estimatedWindowUSD: round(FIXED_USD * fraction) };
    const lines = [`${closing ? 'Books for' : 'So far in'} ${month} (Chicago calendar month).`];
    if (accounting.available) {
      const { nonAdmin, ownerExempt, repayments, grants, unclassified } = accounting;
      lines.push(`Recorded family net wallet charges, classified by current account roles: ${money(nonAdmin.walletRecordedChargedUSD)}; chat debits ${money(nonAdmin.chatChargedUSD)}, net extras charges ${money(nonAdmin.extrasRecordedChargedUSD)}.`);
      if (accounting.coverage.nonAdminLegacyExtraRows > 0 || nonAdmin.extrasInferredChargedUSD !== 0) lines.push(`Older family extras without a saved charge field have recorded cost ${money(nonAdmin.extrasInferredChargedUSD)}; their wallet charge amount is inferred separately.`);
      lines.push(`Current owner's usage: nominal chat ${money(ownerExempt.chatNominalUSD)}, recorded extras cost ${money(ownerExempt.extrasNominalUSD)}; excluded from family charges by current roles.`);
      if (accounting.extraRecords?.voiceEstimateRows > 0) lines.push('Recorded extras include voice estimates that may overlap chat; they are not added to provider observations.');
      lines.push(`Recorded repayments ${money(repayments.recordedUSD)}; credit grants ${money(grants.netUSD)} separately.`);
      if (unclassified.chatNominalUSD || unclassified.extrasNominalUSD) lines.push(`Unclassified-account usage: nominal chat ${money(unclassified.chatNominalUSD)}, recorded extras cost ${money(unclassified.extrasNominalUSD)}; kept separate.`);
    } else {
      lines.push('Wallet charges, owner usage, repayments and grants are unavailable for this window.');
    }
    const labels = { moonshot: 'Moonshot', openrouter: 'OpenRouter', zai: 'Z.AI proxy meter', google: 'Google bridge meter' };
    const observations = Object.entries(costs.providers).map(([key, value]) => `${labels[key] || key}: ${value.recordedUSD == null ? 'unavailable' : money(value.recordedUSD)} (${value.coverage.status})`);
    lines.push(`Provider observations: ${observations.join('; ')}. These include owner and platform work; metered categories cover only their instrumented calls.`);
    if (!costs.complete) lines.push('Provider coverage is incomplete; this is not a complete monthly provider bill.');
    lines.push(`Fixed bills are a separate estimate: ${money(fixedBills.estimatedWindowUSD)} for this window.`);
    return {
      version: 2, month, closing, window, accounting, providerCosts: costs, fixedBills,
      comparison: { comparable: false, reason: 'Provider-account costs and family wallet charges have different scopes; provider and historical ledger coverage may also be incomplete.' },
      multiplierNeeded: null, ratio: null, spoken: lines.join(' '), at: now.toISOString(),
    };
  }

  function appendLedger(row) {
    try {
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      fs.appendFileSync(ledgerPath, JSON.stringify(row) + '\n');
    } catch (error) { log.warn('[monthly] ledger write failed:', error.message); }
  }

  function lastClosed() {
    try {
      const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        const row = JSON.parse(lines[i]);
        if (!row.closing) continue;
        if (row.version === 2) return row;
        return { ...row, legacyReport: true, multiplierNeeded: null, ratio: null, comparison: { comparable: false, reason: 'Historical report used different accounting scopes and date windows.' }, spoken: `Historical report for ${row.month} used different accounting scopes and date windows; it is not reconciled calendar-month books.` };
      }
    } catch {}
    return null;
  }

  async function close({ trigger = 'clock' } = {}) {
    if (!enabled) throw new Error('Monthly reporting is paused');
    const row = await report({ monthKey: monthKeyOf(clock(), 1), closing: true });
    row.trigger = trigger;
    appendLedger(row);
    try {
      await runNotify({ agentId: 'monthly-books', agentName: 'Books', title: 'The monthly books', body: row.spoken, urgent: false, userId: adminUserId, adminAlert: true, category: 'admin' });
    } catch (error) { log.warn('[monthly] notify failed:', error.message); }
    return row;
  }

  return { report, close, lastClosed, monthKeyOf, enabled };
}

function attachMonthly(app, { bridgeSecretOk, proxyUrl, proxySecret, readBalanceHistory, readZaiDays, readGoogleDays, runNotify, adminUserId }) {
  const monthly = makeMonthly({ proxyUrl, proxySecret, readBalanceHistory, readZaiDays, readGoogleDays, runNotify, adminUserId });
  const adminOk = (req) => bridgeSecretOk(req, req.get('x-kade-secret') || req.get('x-bridge-secret') || req.query.secret || (req.body && req.body.secret));
  app.get('/monthly', async (req, res) => {
    if (!adminOk(req)) return res.status(403).json({ error: 'Unauthorized' });
    try { res.json({ now: await monthly.report(), lastClosed: monthly.lastClosed() }); } catch (error) { res.status(500).json({ error: error.message }); }
  });
  app.post('/monthly/fire', async (req, res) => {
    if (!adminOk(req)) return res.status(403).json({ error: 'Unauthorized' });
    if (!monthly.enabled) return res.status(503).json({ error: 'Monthly reporting is paused' });
    try { res.json(await monthly.close({ trigger: 'manual' })); } catch (error) { res.status(500).json({ error: error.message }); }
  });
  if (!monthly.enabled) {
    console.log('[monthly] paused by MONTHLY_REPORT_ENABLED=0');
    return monthly;
  }
  const centralHour = Number(process.env.MONTHLY_HOUR_CENTRAL || 9);
  const utcHour = process.env.MONTHLY_HOUR_UTC == null ? null : Number(process.env.MONTHLY_HOUR_UTC);
  const guard = { month: null };
  setInterval(() => {
    const now = new Date();
    if (!isScheduledTime(now, { centralHour, utcHour })) return;
    const month = monthKeyOf(now);
    if (guard.month === month) return;
    const last = monthly.lastClosed();
    if (last && last.month === monthKeyOf(now, 1)) { guard.month = month; return; }
    guard.month = month;
    monthly.close({ trigger: 'clock' }).catch((error) => console.warn('[monthly] close failed:', error.message));
  }, 60 * 1000);
  console.log(`[monthly] armed: the 1st at ${utcHour == null ? `${centralHour}h Chicago` : `${utcHour}h UTC (configured override)`} · fixed estimate ${money(FIXED_USD)} · ledger ${LEDGER}`);
  return monthly;
}

module.exports = { attachMonthly, makeMonthly, monthKeyOf, centralParts, isScheduledTime };
