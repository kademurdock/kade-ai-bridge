'use strict';
/* turn-grace.js: how long to wait after Flux says a caller's turn ended.
 *
 * The fixed 900 ms grace (voice-stream.js, EndOfTurn) is paid on every turn. This picks a
 * grace from the words and from Flux's own confidence: longer when the thought trails off,
 * shorter when it is plainly finished, and never shorter for a caller who has already
 * resumed inside the grace twice on this call.
 *
 * FLUX_ADAPTIVE_GRACE: unset or "shadow" = log only, "1" = use it, "0" = off.
 * Pure text and arithmetic; tested in turn-grace.test.js.
 * (Nov 12 2026, platform audit phase 4, pick 1. Ships in shadow mode.)
 */

const OPEN_TAIL = new Set([
  // joining words
  'and', 'but', 'so', 'or', 'because', 'cause', 'if', 'when', 'then', 'while', 'although', 'plus',
  // articles and possessives
  'the', 'a', 'an', 'my', 'your', 'his', 'their', 'our',
  // prepositions that rarely end a thought
  'to', 'of', 'for', 'with', 'from', 'into', 'at', 'by',
  // helpers that need a verb after them
  'is', 'was', 'are', 'were', 'am', 'can', 'could', 'would', 'should', 'will',
  // subject pronouns
  'i', 'we', 'he', 'she', 'they',
  // fillers
  'um', 'uh', 'er', 'hmm', 'like', 'well',
]);

function modeOf(env = process.env) {
  const v = String(env.FLUX_ADAPTIVE_GRACE || '').trim().toLowerCase();
  if (v === '1' || v === 'on') return 'on';
  if (v === '0' || v === 'off') return 'off';
  return 'shadow';
}

function num(env, name, fallback) {
  const n = parseInt(env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 'open' | 'complete' | 'short' | 'unsure' */
function classify({ text, eotConfidence, minConfidence = 0.93 }) {
  const raw = String(text || '').trim();
  if (!raw) return 'unsure';
  if (/(?:[,;:]|\.\.\.|…|-|–|—)$/.test(raw)) return 'open';
  const words = raw.split(/\s+/);
  const tail = words[words.length - 1].toLowerCase().replace(/[^a-z']/g, '');
  if (OPEN_TAIL.has(tail)) return 'open';
  if (words.length <= 2) return 'short';
  const conf = Number(eotConfidence);
  if (Number.isFinite(conf) && conf >= minConfidence) return 'complete';
  return 'unsure';
}

/**
 * @param {{ text: string, eotConfidence?: number, base: number, stitches?: number, capMs?: number, env?: object }} o
 * @returns {{ ms: number, wouldBe: number, cls: string, mode: string }}
 *   ms = the grace to use now; wouldBe = what the adaptive rule picks (for the shadow log).
 */
function pick(o) {
  const env = (o && o.env) || process.env;
  const base = Number.isFinite(o && o.base) ? o.base : 900;
  const mode = modeOf(env);
  try {
    if (base <= 0) return { ms: base, wouldBe: base, cls: 'off', mode }; // grace disabled by env
    const cls = classify({
      text: o.text,
      eotConfidence: o.eotConfidence,
      minConfidence: Number(env.FLUX_GRACE_MIN_CONF) || 0.93,
    });
    const cap = Math.max(base, (Number.isFinite(o.capMs) ? o.capMs : 2500) - 200);
    let wouldBe = base;
    if (cls === 'open') wouldBe = Math.min(cap, Math.max(base, num(env, 'FLUX_GRACE_OPEN_MS', 1300)));
    else if ((o.stitches || 0) >= 2) wouldBe = base; // this caller pauses mid-thought: never shorten
    else if (cls === 'complete') wouldBe = Math.min(base, num(env, 'FLUX_GRACE_COMPLETE_MS', 350));
    else if (cls === 'short') wouldBe = Math.min(base, num(env, 'FLUX_GRACE_SHORT_MS', 600));
    return { ms: mode === 'on' ? wouldBe : base, wouldBe, cls, mode };
  } catch (_) {
    return { ms: base, wouldBe: base, cls: 'error', mode };
  }
}

module.exports = { OPEN_TAIL, modeOf, classify, pick };
