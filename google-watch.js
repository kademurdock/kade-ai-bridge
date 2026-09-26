'use strict';
/**
 * google-watch.js — the bridge's eyes on its Google key (Sep 26 2026, Part 295).
 *
 * GOOGLE_LIVE_API_KEY feeds the Spotter (Gemini Live) and the media listener's
 * Google-native fallback. It is a PREPAID AI Studio key: when the credit runs out
 * Google answers 429 RESOURCE_EXHAUSTED, and nothing told her. On Aug 28 the same
 * kind of empty balance silently broke memory recall platform-wide. Two jobs here:
 *
 *  1. THE ALARM. A Google error that reads as out of credit, or as a quota/429,
 *     pushes her once through the same Estate watch lane the low-balance watch
 *     uses (server.js registers runNotify with setNotifier). At most one push per
 *     GOOGLE_ALARM_HOURS (default 4), state on the volume so a redeploy does not
 *     re-page. The key has no balance API, so this is the only early warning.
 *     Kill: GOOGLE_ALARM=0.
 *
 *  2. THE SPEND LEDGER. What the bridge itself knows it spent at Google, per
 *     Central day, in /data/google-days.json {date: usd}: the Spotter's metered
 *     cost (live-billing.js) and the BYOK share of OpenRouter calls it makes
 *     (usage.cost_details.upstream_inference_cost). monthly.js adds it to "real".
 *     It is NOT the whole Google bill: the fork's direct Google calls (memory
 *     embeddings, Lyria, the lyric transcriber, its own BYOK describe lanes) never
 *     pass through the bridge.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir();
const STATE_FILE = path.join(DATA_DIR, 'google-watch.json');
const DAYS_FILE = path.join(DATA_DIR, 'google-days.json');

/* ---------- 1. the alarm */

/** 'credit' = the prepaid balance is out; 'quota' = a 429 / RESOURCE_EXHAUSTED that may
 * be the balance or a rate limit; null = some other failure (not ours to page about). */
function classifyGoogleTrouble(text) {
  const s = String(text || '');
  if (!s) return null;
  if (/prepay|prepaid|credits?\s+(?:are|is|have been|has been)?\s*(?:depleted|exhausted|used up)|billing (?:account )?(?:is )?(?:disabled|not enabled|closed|suspended)|payment required|insufficient (?:funds|balance|credit)/i.test(s)) return 'credit';
  // "You exceeded your current quota, please check your plan and billing details" lands here:
  // it can be an empty balance or a spend/rate limit, and the push says both.
  if (/RESOURCE_EXHAUSTED|resource has been exhausted|quota|\b429\b|rate.?limit/i.test(s)) return 'quota';
  return null;
}

let notifier = null;
/** server.js hands in a function(body) that pushes the admin (runNotify, Estate watch). */
function setNotifier(fn) { notifier = typeof fn === 'function' ? fn : null; }

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch { /* an alarm that cannot save still fired */ }
}
const alarmHours = () => {
  const h = Number(process.env.GOOGLE_ALARM_HOURS || '4');
  return Number.isFinite(h) && h > 0 ? h : 4;
};

function alarmBody({ where, kind, detail }) {
  const said = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  return kind === 'credit'
    ? `Google's AI Studio key is out of credit: ${where} just got "${said}". Spotter calls and the media listener stay down until it's topped up in AI Studio.`
    : `Google's AI Studio key hit a limit: ${where} just got "${said}". If the prepaid balance is empty, top it up in AI Studio; if it keeps happening with money on it, it's the rate limit.`;
}

/** Page her about Google key trouble, at most once per GOOGLE_ALARM_HOURS. Never throws.
 * Returns true when a push was sent. `now` and `state` are for the tests. */
function alarmGoogleKey({ where, kind, detail }, { now = Date.now(), load = loadState, save = saveState } = {}) {
  try {
    if (!kind || process.env.GOOGLE_ALARM === '0') return false;
    const s = load();
    s.lastTrouble = { at: new Date(now).toISOString(), where, kind, detail: String(detail || '').slice(0, 200) };
    const quiet = s.lastAlarmAt && now - Date.parse(s.lastAlarmAt) < alarmHours() * 3600 * 1000;
    if (quiet || !notifier) { save(s); return false; }
    s.lastAlarmAt = new Date(now).toISOString();
    save(s);
    console.warn(`[google-watch] ALARM (${kind}) from ${where}: ${String(detail || '').slice(0, 160)}`);
    Promise.resolve().then(() => notifier(alarmBody({ where, kind, detail }))).catch(() => {});
    return true;
  } catch { return false; }
}

/* ---------- 2. the spend ledger */

function centralDateKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function readGoogleDays() {
  try { return JSON.parse(fs.readFileSync(DAYS_FILE, 'utf8')) || {}; } catch { return {}; }
}
let pending = 0;
let flushTimer = null;
function flushGoogleSpend() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!(pending > 0)) return;
  const add = pending;
  pending = 0;
  try {
    const days = readGoogleDays();
    const k = centralDateKey();
    days[k] = Math.round(((Number(days[k]) || 0) + add) * 1e6) / 1e6;
    const keys = Object.keys(days).sort();
    while (keys.length > 400) delete days[keys.shift()];
    fs.writeFileSync(DAYS_FILE, JSON.stringify(days));
  } catch (e) { console.warn('[google-watch] spend ledger write failed:', e.message); }
}
/** Add dollars the bridge spent at Google. Batched: written within 30 s. */
function addGoogleSpend(usd) {
  const v = Number(usd);
  if (!Number.isFinite(v) || v <= 0) return;
  pending += v;
  if (!flushTimer) {
    flushTimer = setTimeout(flushGoogleSpend, 30000);
    if (flushTimer.unref) flushTimer.unref();
  }
}

module.exports = {
  classifyGoogleTrouble, setNotifier, alarmGoogleKey, alarmBody,
  addGoogleSpend, flushGoogleSpend, readGoogleDays, centralDateKey,
};
