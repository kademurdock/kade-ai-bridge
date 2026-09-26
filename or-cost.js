'use strict';
/**
 * or-cost.js — what an OpenRouter call REALLY cost (Sep 26 2026, Part 295).
 *
 * Kade's decision, Sep 26: her Google AI Studio key goes into OpenRouter as BYOK, so
 * Gemini bills her Google balance. OpenRouter's usage-accounting docs: with BYOK,
 * usage.cost is only what OpenRouter itself charges (its fee, often 0 inside the free
 * allowance) and usage.cost_details.upstream_inference_cost is "the actual cost charged
 * by the upstream AI provider"; on a normal (non-BYOK) request that field is 0 or null.
 * So the real cost of any call is the SUM, and every reader of usage.cost goes through
 * here. Reading usage.cost alone would bill a BYOK call at $0 and show her $0 as real.
 */

const finite = (v) => (v == null || v === '' ? NaN : Number(v));

/** Fee + upstream, in dollars; null when the reply carried neither number. */
function openRouterCost(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const fee = finite(u.cost);
  const up = upstreamCost(u);
  if (!Number.isFinite(fee) && !(up > 0)) return null;
  return (Number.isFinite(fee) ? Math.max(0, fee) : 0) + up;
}

/** The part the upstream provider billed directly (BYOK); 0 on a normal request. */
function upstreamCost(usage) {
  const d = usage && typeof usage === 'object' ? usage.cost_details : null;
  const up = finite(d && typeof d === 'object' ? d.upstream_inference_cost : null);
  return Number.isFinite(up) && up > 0 ? up : 0;
}

module.exports = { openRouterCost, upstreamCost };
