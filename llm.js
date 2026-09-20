'use strict';
/* llm.js — where deep research and errands send their model calls.
 *
 * Sep 20 2026. Both desks called Moonshot's API directly (kimi-k2.6 / kimi-k3)
 * on the same pot as the old fleet. The fleet left for DeepSeek on Sep 19, the
 * Moonshot balance ran to zero the next night, and both desks died with a 429
 * nobody saw. Kade: "switch everything that used moonshot to deepseek 4.1 flash."
 *
 * A model name now decides its own lane:
 *   kimi-*      -> Moonshot direct, with the two load-bearing Moonshot facts
 *                  (no temperature at all; reasoning_effort 'none' or the
 *                  reasoning eats the budget and content comes back empty).
 *   anything else -> OpenRouter with the bridge's own key. deepseek/* is held
 *                  to hosts that keep no copy of her data, fast ones first: the
 *                  same rule and the same order the chat gateway uses
 *                  (reframe-proxy deepseek.js). These calls do NOT ride the
 *                  gateway on purpose: its chat guards rewrite prose, and a
 *                  research report is not a chat reply.
 * So going back to Kimi is an env var (RESEARCH_*_MODEL / ERRAND_*_MODEL), not
 * a code change. */

const MOONSHOT_URL = (process.env.MOONSHOT_URL || 'https://api.moonshot.ai/v1').replace(/\/$/, '');
const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';

const list = (value, fallback) => (value === undefined ? fallback : String(value).split(',').map((s) => s.trim()).filter(Boolean));
const FAST_ORDER = ['together', 'parasail', 'modal', 'makora'];
const SLOW_IGNORE = ['morph', 'relace', 'deepinfra', 'digitalocean'];

function isMoonshot(model) { return /^kimi-/i.test(String(model || '')); }

function keyFor(model, env = process.env) {
  return isMoonshot(model) ? (env.MOONSHOT_KEY || '') : (env.OPENROUTER_KEY || env.OPENROUTER_API_KEY || '');
}

/** Why a desk whose models are `models` cannot run, or '' when it can. */
function missingKey(models, env = process.env) {
  for (const model of models) {
    if (!keyFor(model, env)) return isMoonshot(model) ? 'MOONSHOT_KEY is not set on the bridge' : 'OPENROUTER_KEY is not set on the bridge';
  }
  return '';
}

/** effort: 'none' | 'low' | 'medium' | 'high'. Returns { url, headers, body }. */
function request(model, messages, { maxTokens, json = false, effort = 'none' } = {}, env = process.env) {
  if (isMoonshot(model)) {
    const body = { model, messages, max_tokens: maxTokens, reasoning_effort: effort };
    if (json) body.response_format = { type: 'json_object' };
    return { url: `${MOONSHOT_URL}/chat/completions`, headers: { Authorization: `Bearer ${keyFor(model, env)}`, 'Content-Type': 'application/json' }, body };
  }
  const body = {
    model, messages, max_tokens: maxTokens,
    reasoning: effort === 'none' ? { enabled: false } : { enabled: true, effort, exclude: true },
    usage: { include: true },
  };
  /* No response_format here: not every zero-retention host honours it, and a
   * host that does not is silently dropped from routing. Both desks already
   * ask for JSON in words and parse leniently (jsonFrom). */
  if (/^deepseek\//i.test(model)) {
    const order = list(env.KADE_DEEPSEEK_ORDER, FAST_ORDER), ignore = list(env.KADE_DEEPSEEK_IGNORE, SLOW_IGNORE);
    body.provider = order.length
      ? { zdr: true, data_collection: 'deny', order, ...(ignore.length ? { ignore } : {}), allow_fallbacks: true }
      : { zdr: true, data_collection: 'deny', sort: 'price', allow_fallbacks: true };
  }
  return {
    url: `${OPENROUTER_URL}/chat/completions`,
    headers: { Authorization: `Bearer ${keyFor(model, env)}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://kademurdock.com', 'X-Title': 'Kade-AI bridge' },
    body,
  };
}

/* $ per million tokens, for the desks' own estimates. deepseek flash is what the
 * fast zero-retention hosts billed on Sep 20 2026. */
const PRICES = { 'kimi-k3': { in: 3, out: 15 }, 'kimi-k2.6': { in: 0.95, out: 4 }, 'deepseek/deepseek-v4.1-flash': { in: 0.3, out: 1.2 } };

module.exports = { DEFAULT_MODEL, PRICES, isMoonshot, keyFor, missingKey, request };
