'use strict';
/**
 * or-cost.js — what an OpenRouter call REALLY cost (Sep 26 2026, Part 295).
 *
 * Kade's decision, Sep 26: her Google AI Studio key goes into OpenRouter as BYOK, so
 * Gemini bills her Google balance. OpenRouter's usage-accounting docs: with BYOK,
 * usage.cost is only what OpenRouter itself charges (its fee, often 0 inside the free
 * allowance) and usage.cost_details.upstream_inference_cost is "the actual cost charged
 * by the upstream AI provider". Reading usage.cost alone would bill a BYOK call at $0
 * and show her $0 as real, so every reader of usage.cost goes through here.
 *
 * DO NOT JUST ADD THE TWO. The docs' "0 or null for everyone else" holds for the
 * /generation lookup, not the inline usage: on an ordinary (non-BYOK) reply
 * upstream_inference_cost EQUALS cost. Measured on our own saved replies (the Sep 25
 * A/B runs, 296 of them, and the Pluto blind gate: google/gemini-2.5-flash-lite,
 * cost 0.0125646, is_byok false, upstream 0.0125646). So the real cost is
 *   is_byok === true ? cost + upstream_inference_cost : cost
 * and only a BYOK reply's upstream share is Google's money (the gateway does the
 * same, reframe usage-cost.js). A BYOK request OpenRouter served from its own
 * capacity comes back is_byok false and is OpenRouter's money, not Google's.
 */

const finite = (v) => (v == null || v === '' ? NaN : Number(v));

/** Fee + BYOK upstream, in dollars; null when the reply carried neither number. */
function openRouterCost(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const fee = finite(u.cost);
  const up = upstreamCost(u);
  if (!Number.isFinite(fee) && !(up > 0)) return null;
  return (Number.isFinite(fee) ? Math.max(0, fee) : 0) + up;
}

/** The part the upstream provider billed directly: only on a BYOK reply, else 0. */
function upstreamCost(usage) {
  if (!usage || typeof usage !== 'object' || usage.is_byok !== true) return 0;
  const d = usage.cost_details;
  const up = finite(d && typeof d === 'object' ? d.upstream_inference_cost : null);
  return Number.isFinite(up) && up > 0 ? up : 0;
}

module.exports = { openRouterCost, upstreamCost };
