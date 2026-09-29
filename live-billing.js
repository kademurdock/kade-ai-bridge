'use strict';
/**
 * live-billing.js — the Spotter billed from Google's own meter (Sep 26 2026, Part 295).
 *
 * Kade's call, Sep 26: "Spotter: fix both." Until now a Spotter call cost the
 * caller a flat LIVE_COST_PER_MIN_USD ($0.055) per wall-clock minute, a July 16
 * guess. Google's Live best-practices page (updated 2026-09-15) says the Live
 * API bills EVERY TURN for every token in the session's context window, audio
 * history at the audio input rate, so a long call costs more per minute than a
 * short one and the flat rate undercharged exactly the calls that cost most.
 *
 * The Live server already says what it billed: server messages may carry a
 * `usageMetadata` (promptTokenCount, responseTokenCount, thoughtsTokenCount,
 * toolUsePromptTokenCount, and per-modality promptTokensDetails /
 * responseTokensDetails, each {modality, tokenCount}; ai.google.dev/api/live,
 * updated 2026-09-04). Each report is one billed turn. This file prices every
 * report with the checked table below, adds them up per call, and posts the
 * REAL cost to the fork's usage-event as service 'video_live'. The fork applies
 * the user price (KADE_BILLING_MULTIPLIER) and keeps the admin free; nothing
 * here doubles anything.
 *
 * Posting is progressive, so a bridge restart mid-call loses at most about a
 * minute instead of the whole call: the 15 s live tick posts once the unposted
 * cost reaches LIVE_BILL_EVERY_USD (default $0.10), or LIVE_BILL_EVERY_MS
 * (default 60 s) has passed with at least LIVE_BILL_MIN_USD (default half a
 * cent) waiting; every Live stop (hang-up, "live off", Google's ~10-minute
 * reconnect, an error) posts whatever is left. No double posting: each post
 * takes the unposted amount and marks it posted BEFORE the request goes out, and
 * only a failure that proves nothing landed (a refused connection, a 5xx) puts
 * it back for the next post. A timeout is logged and never re-sent.
 *
 * The per-minute estimate survives only as the fallback for a Live connection
 * that ended without a single usageMetadata (a model this table does not know,
 * or a Google change): that connection's minutes x LIVE_COST_PER_MIN_USD.
 */
const { BROWSER_UA } = require('./voice-commands');
const googleWatch = require('./google-watch');

/* $ per 1M tokens, paid tier, from https://ai.google.dev/gemini-api/docs/pricing
 * (page "Last updated 2026-09-24 UTC", read 2026-09-26). One row there covers
 * "Gemini 3.8 Live, Gemini 3.8 Live Extended Thinking, and Gemini 3.1 Flash Live
 * Preview": input $0.75 text, $3.00 audio, $1.00 image/video; output (including
 * thinking tokens) $4.50 text, $12.00 audio. No context-caching price is listed
 * for these models, so cached prompt tokens are billed at the full rate.
 * Re-check this row when Google changes Live pricing or LIVE_MODEL moves. */
const LIVE_PRICES_CHECKED = '2026-09-26 from https://ai.google.dev/gemini-api/docs/pricing (last updated 2026-09-24)';
const LIVE_ROW = Object.freeze({
  in: Object.freeze({ TEXT: 0.75, DOCUMENT: 0.75, AUDIO: 3.0, IMAGE: 1.0, VIDEO: 1.0 }),
  out: Object.freeze({ TEXT: 4.5, AUDIO: 12.0 }),
});
const LIVE_PRICES = Object.freeze({
  'gemini-3.1-flash-live-preview': LIVE_ROW,
  'gemini-3.8-live': LIVE_ROW,
  'gemini-3.8-live-extended-thinking': LIVE_ROW,
});
function priceRow(model) {
  return LIVE_PRICES[String(model || '').replace(/^models\//, '').trim().toLowerCase()] || null;
}

const num = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; };
const env = (k, d) => { const x = Number(process.env[k]); return process.env[k] != null && process.env[k] !== '' && Number.isFinite(x) && x >= 0 ? x : d; };
const everyUsd = () => env('LIVE_BILL_EVERY_USD', 0.10);
const everyMs = () => env('LIVE_BILL_EVERY_MS', 60000);
const minUsd = () => env('LIVE_BILL_MIN_USD', 0.005);
const perMinuteFallback = () => env('LIVE_COST_PER_MIN_USD', 0.055);

/** Price one usageMetadata report. Returns {usd, tokens} or null for a model with no row.
 * Tokens the per-modality breakdown does not name are billed at that side's AUDIO rate:
 * the dearest input (Live keeps history as raw audio) and the only thing a Spotter says.
 * Thinking is billed at the text output rate, the page's "including thinking tokens". */
function priceLiveUsage(usage, model) {
  const row = priceRow(model);
  if (!row || !usage || typeof usage !== 'object') return null;
  const tokens = { in: {}, out: {}, thoughts: 0 };
  let usd = 0;
  const put = (side, label, count, rateKey) => {
    if (!(count > 0)) return;
    const rates = row[side];
    const rate = rates[rateKey] != null ? rates[rateKey] : rates.AUDIO;
    tokens[side][label] = (tokens[side][label] || 0) + count;
    usd += (count / 1e6) * rate;
  };
  const walk = (side, details, total, restKey) => {
    let named = 0;
    for (const d of Array.isArray(details) ? details : []) {
      const c = num(d && d.tokenCount);
      if (!c) continue;
      const mod = String((d && d.modality) || '').toUpperCase() || 'UNSPECIFIED';
      put(side, mod, c, mod);
      named += c;
    }
    if (total > named) put(side, 'UNSPLIT', total - named, restKey);
  };
  const prompt = num(usage.promptTokenCount);
  const response = num(usage.responseTokenCount);
  const toolUse = num(usage.toolUsePromptTokenCount);
  const thoughts = num(usage.thoughtsTokenCount);
  const total = num(usage.totalTokenCount);
  walk('in', usage.promptTokensDetails, prompt, 'AUDIO');
  walk('in', usage.toolUsePromptTokensDetails, toolUse, 'TEXT');
  // generateContent counts thoughts beside the response; if a report's total says
  // they sit INSIDE responseTokenCount, take them out so they are billed once.
  const thoughtsInside = thoughts > 0 && total > 0 && total === prompt + toolUse + response;
  walk('out', usage.responseTokensDetails, thoughtsInside ? Math.max(0, response - thoughts) : response, 'AUDIO');
  if (thoughts) { tokens.thoughts = thoughts; usd += (thoughts / 1e6) * row.out.TEXT; }
  return { usd, tokens };
}

/* ---------- the per-call meter (session._liveBill) */
const emptyPend = () => ({ metered: 0, est: 0, reports: 0, tok: { in: {}, out: {}, thoughts: 0 } });
function mergeTok(into, add) {
  for (const side of ['in', 'out']) {
    for (const [k, v] of Object.entries((add && add[side]) || {})) into[side][k] = (into[side][k] || 0) + v;
  }
  into.thoughts += num(add && add.thoughts);
}
function bill(session) {
  if (!session._liveBill) {
    session._liveBill = {
      pend: emptyPend(), postedSecs: 0, lastPostAt: Date.now(), seq: 0,
      segStartSecs: Number(session.liveSecondsTotal || 0), segMetered: false,
      model: null, totals: { metered: 0, est: 0, reports: 0 },
      inflight: new Set(), ended: false,
    };
  }
  return session._liveBill;
}

/** A Live connection came up (setupComplete): its minutes start counting toward the fallback. */
function startSegment(session) {
  const b = bill(session);
  b.segStartSecs = Number(session.liveSecondsTotal || 0);
  b.segMetered = false;
}

/** One usageMetadata report from Google. Returns the priced report, or null (unknown model). */
function addUsage(session, usage, model) {
  const priced = priceLiveUsage(usage, model);
  if (!priced) return null;
  const b = bill(session);
  b.model = String(model || '').replace(/^models\//, '');
  b.segMetered = true;
  b.pend.metered += priced.usd;
  b.pend.reports += 1;
  mergeTok(b.pend.tok, priced.tokens);
  b.totals.metered += priced.usd;
  b.totals.reports += 1;
  googleWatch.addGoogleSpend(priced.usd);
  return priced;
}

/** A Live connection ended. If Google never sent a usageMetadata on it, its minutes are
 * charged at the old per-minute estimate so the call is not free. Safe to call twice. */
function endSegment(session) {
  const b = bill(session);
  const secs = Number(session.liveSecondsTotal || 0) - b.segStartSecs;
  if (!b.segMetered && secs > 0) {
    const est = (secs / 60) * perMinuteFallback();
    b.pend.est += est;
    b.totals.est += est;
    googleWatch.addGoogleSpend(est);
    console.warn(`[video-live] no usageMetadata on this Live connection (user=${session.userId}, ${Math.round(secs)}s) — billed at the per-minute estimate`);
  }
  b.segStartSecs = Number(session.liveSecondsTotal || 0);
  b.segMetered = false;
}

/** Is a progressive post due? Pure, for the tick. */
function due(b, now = Date.now()) {
  const usd = b.pend.metered + b.pend.est;
  if (usd >= everyUsd() && usd > 0) return true;
  return now - b.lastPostAt >= everyMs() && usd >= minUsd() && usd > 0;
}

function take(session) {
  const b = bill(session);
  const secsTotal = Number(session.liveSecondsTotal || 0);
  const t = { ...b.pend, secs: Math.max(0, secsTotal - b.postedSecs), seq: ++b.seq };
  b.pend = emptyPend();
  b.postedSecs = Math.max(b.postedSecs, secsTotal);
  b.lastPostAt = Date.now();
  return t;
}
function giveBack(session, t) {
  const b = bill(session);
  b.pend.metered += t.metered;
  b.pend.est += t.est;
  b.pend.reports += t.reports;
  mergeTok(b.pend.tok, t.tok);
  b.postedSecs = Math.max(0, b.postedSecs - t.secs);
}

/** True only when the error proves the fork never recorded the event. */
function nothingLanded(e) {
  if (e && e.response) return e.response.status >= 500;
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(e && e.code);
}

function usageBody(session, t, why, secret) {
  const b = bill(session);
  const usd = t.metered + t.est;
  return {
    secret,
    userId: session.userId,
    service: 'video_live',
    quantity: Math.max(0.0001, Math.round((t.secs / 60) * 10000) / 10000),
    unit: 'minutes',
    costUSD: Math.round(usd * 1e6) / 1e6,
    metadata: {
      agent: session.agentName,
      surface: 'web',
      mode: 'live',
      model: b.model || undefined,
      source: t.est > 0 ? (t.metered > 0 ? 'mixed' : 'per-minute estimate') : 'google usage',
      ...(t.est > 0 ? { estimatedUSD: Math.round(t.est * 1e6) / 1e6 } : {}),
      ...(t.reports ? { reports: t.reports, tokens: t.tok } : {}),
      part: t.seq,
      why,
      call: session.streamSid,
    },
  };
}

async function postUsageEvent(body) {
  const base = (process.env.LIBRECHAT_URL || 'https://kademurdock.com').replace(/\/$/, '');
  const axios = require('axios');
  await axios.post(`${base}/api/kade/usage-event`, body, { timeout: 8000, headers: { 'User-Agent': BROWSER_UA } });
}

/** Post the unposted cost. why: 'tick' | 'stop' | 'late' | 'final'. A 'final' post also
 * carries leftover minutes with no cost, so the dashboard's minutes stay whole. */
async function flush(session, why = 'tick', { post = postUsageEvent, attempts, sleep } = {}) {
  try {
    if (!session) return false;
    const b = bill(session);
    // Sep 29 2026: a hang-up runs stopLive's 'stop' post and this 'final' back to
    // back, so the 'stop' is still in the air here. With the fork down it gave
    // its cost back AFTER 'final' had found nothing to send, and nothing posted
    // again: the call went unbilled. 'final' now waits for every post in flight
    // to settle, then sends whatever is left.
    if (why === 'final') {
      if (b.inflight && b.inflight.size) await Promise.allSettled([...b.inflight]);
      b.ended = true;
    }
    const usd = b.pend.metered + b.pend.est;
    const secs = Number(session.liveSecondsTotal || 0) - b.postedSecs;
    if (why === 'final' && (b.totals.metered > 0 || b.totals.est > 0)) {
      const flat = (Number(session.liveSecondsTotal || 0) / 60) * perMinuteFallback();
      console.log(`[video-live] call cost user=${session.userId}: $${(b.totals.metered + b.totals.est).toFixed(4)} ` +
        `(metered $${b.totals.metered.toFixed(4)} over ${b.totals.reports} Google reports, estimated $${b.totals.est.toFixed(4)}) ` +
        `for ${(Number(session.liveSecondsTotal || 0) / 60).toFixed(2)} min; the old flat rate would have said $${flat.toFixed(4)}`);
    }
    if (!(usd > 0) && !(why === 'final' && secs > 0.5)) return false;
    const t = take(session);
    const secret = process.env.KADE_USAGE_EVENT_SECRET;
    // Nobody to bill (no secret, or an unlinked caller): dropped, as before. The
    // spend ledger already has it.
    if (!secret || !session.userId) return false;
    const body = usageBody(session, t, why, secret);
    const tries = Math.max(1, attempts || (why === 'final' || why === 'stop' ? 3 : 1));
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const sending = (async () => {
      for (let i = 1; i <= tries; i++) {
        try {
          await post(body);
          return true;
        } catch (e) {
          if (!nothingLanded(e)) {
            console.warn(`[video-live] usage post ${why} #${t.seq} failed and may have landed, so it is not re-sent: ${e && e.message}`);
            return false;
          }
          if (i < tries) { await wait(i * 5000); continue; }
          giveBack(session, t);
          console.warn(`[video-live] usage post ${why} #${t.seq} failed (${e && e.message}); ${why === 'final' || b.ended ? 'the call is over, so this part is lost' : 'kept for the next post'}`);
          return false;
        }
      }
      return false;
    })();
    b.inflight.add(sending);
    try { return await sending; } finally { b.inflight.delete(sending); }
  } catch (e) {
    console.log('[video-live] usage post failed:', e && e.message);
    return false;
  }
}

/** The live tick's hook: post when due. Fire-and-forget. */
function maybeFlush(session, now = Date.now()) {
  try { if (session && session._liveBill && due(session._liveBill, now)) flush(session, 'tick').catch(() => {}); } catch {}
}

module.exports = {
  LIVE_PRICES, LIVE_PRICES_CHECKED, priceRow, priceLiveUsage,
  startSegment, addUsage, endSegment, due, flush, maybeFlush,
  _test: { bill, take, giveBack, nothingLanded, usageBody },
};
