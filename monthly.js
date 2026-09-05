'use strict';
/**
 * monthly.js — THE MONTHLY BOOKS (Sep 5 2026, Part 131). Her rule: no scheduling
 * on her computer or Cowork — it lives on the platform, beside the battery.
 *
 * On the 1st of every month (09:00 Central) it compares what the family was
 * CHARGED (the fork's meter: real stickers x KADE_BILLING_MULTIPLIER, summed
 * from `/librechat/usage?days=N`) with what the models REALLY cost (the daily
 * balance snapshots the bridge already keeps: Moonshot + OpenRouter deltas),
 * adds the metered extras, and pushes her ONE line: charged, real, the
 * multiplier in force, and the multiplier the month actually needed. A row
 * lands in /data/monthly.jsonl. GET /monthly reports the month so far on
 * demand; POST /monthly/fire runs it now (both BRIDGE_SECRET).
 *
 * Honest gaps it names in its own line: the Z.AI pot (the background fleet's
 * pot since Aug 21) has no balance watch, so its spend is not in "real"; and
 * the fixed bills (Inworld founder $25, Railway ~$32, Codemagic) are an env
 * number, MONTHLY_FIXED_USD, default 70, not a live read.
 */
const fs = require('fs');
const path = require('path');

const FIXED_USD = Number(process.env.MONTHLY_FIXED_USD || 70);
const FIRE_HOUR_UTC = parseInt(process.env.MONTHLY_HOUR_UTC || '14', 10); // 9 a.m. Central (CDT)
const LEDGER = process.env.MONTHLY_LEDGER || '/data/monthly.jsonl';

function centralParts(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).reduce((o, x) => ((o[x.type] = x.value), o), {});
  return { y: +p.year, m: +p.month, d: +p.day };
}
function monthKeyOf(now = new Date(), back = 0) {
  const { y, m } = centralParts(now);
  const t = new Date(Date.UTC(y, m - 1 - back, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}
function daysInto(now = new Date()) { return centralParts(now).d; }

/* Real provider spend across a month from the bridge's daily snapshots.
 * A snapshot row: {dateKey:'YYYY-MM-DD', moonshot, openrouter_usage, openrouter, fish, twilio, ...}.
 * balance-kind pots go DOWN as they are spent; usage-kind go UP. */
function realSpend(history, monthKey, zaiDays = {}) {
  const rows = history.filter((h) => h && typeof h.dateKey === 'string' && h.dateKey.startsWith(monthKey)).sort((a, b) => a.dateKey < b.dateKey ? -1 : 1);
  const zai = round(Object.entries(zaiDays || {}).filter(([k]) => k.startsWith(monthKey)).reduce((s, [, v]) => s + (Number(v) || 0), 0));
  if (rows.length < 2) return { models: zai, zai, days: rows.length, note: 'fewer than two snapshots this month' };
  const first = rows[0], last = rows[rows.length - 1];
  const delta = (key, kind) => (first[key] == null || last[key] == null) ? 0 : Math.max(0, kind === 'usage' ? last[key] - first[key] : first[key] - last[key]);
  const moonshot = delta('moonshot', 'balance');
  const openrouter = last.openrouter_usage != null ? delta('openrouter_usage', 'usage') : delta('openrouter', 'balance');
  return { models: round(moonshot + openrouter + zai), moonshot: round(moonshot), openrouter: round(openrouter), zai, days: rows.length, from: first.dateKey, to: last.dateKey };
}
function round(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function makeMonthly({ proxyUrl, proxySecret, readBalanceHistory, readZaiDays = () => ({}), runNotify, adminUserId, log = console, fetchImpl = global.fetch }) {
  async function chargedFromFork(days) {
    const r = await fetchImpl(`${proxyUrl}/librechat/usage?days=${Math.max(1, days)}`, {
      headers: { Authorization: `Bearer ${proxySecret}`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
    });
    if (!r.ok) throw new Error(`usage ${r.status}`);
    const u = await r.json();
    const t = u.totals || {};
    return { charged: round((t.llmSpendUSD || {}).window || 0), extras: round((t.extraSpendUSD || {}).window || 0), users: Array.isArray(u.users) ? u.users.length : null };
  }
  /* The multiplier LIVES on the fork (KADE_BILLING_MULTIPLIER on the LibreChat
   * service). Read it back through the fork's own my-cost route so the books
   * can never disagree with the meter; the env here is only a fallback. */
  async function multiplierInForce() {
    try {
      const r = await fetchImpl(`${proxyUrl}/librechat/my-cost?userId=${encodeURIComponent(adminUserId)}`, {
        headers: { Authorization: `Bearer ${proxySecret}`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
      });
      if (r.ok) { const j = await r.json(); if (Number.isFinite(j.multiplier) && j.multiplier > 0) return j.multiplier; }
    } catch {}
    const raw = Number(process.env.KADE_BILLING_MULTIPLIER);
    return Number.isFinite(raw) && raw > 0 ? raw : 1;
  }
  async function report({ monthKey, days, closing } = {}) {
    const now = new Date();
    const mk = monthKey || monthKeyOf(now);
    const nDays = days != null ? days : daysInto(now);
    const [forkRes, hist] = await Promise.all([chargedFromFork(nDays).catch((e) => ({ error: e.message })), Promise.resolve(readBalanceHistory())]);
    const real = realSpend(hist, mk, readZaiDays());
    const charged = forkRes.charged || 0;
    const mult = await multiplierInForce();
    const realModels = real.models || 0;
    /* Fixed bills are a MONTH's worth; a mid-month read compares them against
     * only nDays of model spend, which made a 5-day read say "needed 38" the
     * night this shipped. Prorate: days elapsed over days in the month. */
    const [my, mm] = mk.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(my, mm, 0)).getUTCDate();
    const fixedSoFar = closing ? FIXED_USD : round(FIXED_USD * Math.min(1, nDays / daysInMonth));
    const needed = realModels > 0 ? round((realModels + (forkRes.extras || 0) + fixedSoFar) / realModels) : null;
    const ratio = realModels > 0 ? round(charged / realModels) : null;
    const spoken =
      `${closing ? 'Books for ' : 'So far in '}${mk}: the family was charged $${charged.toFixed(2)} for models; the models really cost $${realModels.toFixed(2)}` +
      ` (Moonshot $${(real.moonshot || 0).toFixed(2)}, OpenRouter $${(real.openrouter || 0).toFixed(2)}, Z.AI $${(real.zai || 0).toFixed(2)} metered by the proxy)` +
      `; metered extras $${(forkRes.extras || 0).toFixed(2)}; fixed bills about $${FIXED_USD} a month${closing ? '' : ` ($${fixedSoFar.toFixed(2)} so far)`}. The multiplier is ${mult}` +
      (needed != null ? `; this month needed about ${needed}.` : '.') +
      (ratio != null ? ` Charged over real: ${ratio}x.` : '') + (forkRes.error ? ` (fork usage read failed: ${forkRes.error})` : '');
    return { month: mk, days: nDays, closing: !!closing, charged, extras: forkRes.extras || 0, real, fixedUSD: FIXED_USD, fixedSoFar, multiplier: mult, multiplierNeeded: needed, ratio, users: forkRes.users, spoken, at: now.toISOString() };
  }
  function appendLedger(row) { try { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n'); } catch (e) { log.warn('[monthly] ledger write failed:', e.message); } }
  function lastClosed() {
    try { const lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean); for (let i = lines.length - 1; i >= 0; i--) { const r = JSON.parse(lines[i]); if (r.closing) return r; } } catch {} return null;
  }
  async function close({ trigger = 'clock' } = {}) {
    // Closing the PREVIOUS month: snapshots and the fork window both cover it.
    const now = new Date();
    const prev = monthKeyOf(now, 1);
    const [y, m] = prev.split('-').map(Number);
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const row = await report({ monthKey: prev, days: dim + daysInto(now), closing: true });
    row.trigger = trigger;
    appendLedger(row);
    try {
      await runNotify({ agentId: 'monthly-books', agentName: 'Books', title: 'The monthly books', body: row.spoken, urgent: false, userId: adminUserId, adminAlert: true, category: 'admin' });
    } catch (e) { log.warn('[monthly] notify failed:', e.message); }
    return row;
  }
  return { report, close, lastClosed, monthKeyOf, realSpend };
}

function attachMonthly(app, { bridgeSecretOk, proxyUrl, proxySecret, readBalanceHistory, readZaiDays, runNotify, adminUserId }) {
  const monthly = makeMonthly({ proxyUrl, proxySecret, readBalanceHistory, readZaiDays, runNotify, adminUserId });
  const adminOk = (req) => bridgeSecretOk(req, req.get('x-kade-secret') || req.get('x-bridge-secret') || req.query.secret || (req.body && req.body.secret));
  app.get('/monthly', async (req, res) => {
    if (!adminOk(req)) return res.status(403).json({ error: 'Unauthorized' });
    try { res.json({ now: await monthly.report(), lastClosed: monthly.lastClosed() }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/monthly/fire', async (req, res) => {
    if (!adminOk(req)) return res.status(403).json({ error: 'Unauthorized' });
    try { res.json(await monthly.close({ trigger: 'manual' })); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  const guard = { month: null };
  setInterval(() => {
    const now = new Date();
    if (daysInto(now) !== 1 || now.getUTCHours() !== FIRE_HOUR_UTC) return;
    const mk = monthly.monthKeyOf(now);
    if (guard.month === mk) return;
    const last = monthly.lastClosed();
    if (last && last.month === monthly.monthKeyOf(now, 1)) { guard.month = mk; return; }
    guard.month = mk;
    monthly.close({ trigger: 'clock' }).catch((e) => console.warn('[monthly] close failed:', e.message));
  }, 60 * 1000);
  console.log(`[monthly] armed: the 1st at ${FIRE_HOUR_UTC}h UTC · fixed bills $${FIXED_USD} · ledger ${LEDGER}`);
  return monthly;
}

module.exports = { attachMonthly, makeMonthly, realSpend, monthKeyOf, centralParts };
