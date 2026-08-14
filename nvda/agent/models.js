'use strict';
/**
 * Model router — pick the right model for the job, shape the request per each
 * provider's quirks, and never 400 on Moonshot's temperature/reasoning gate.
 *
 * WHY A ROUTER
 *   Most driving steps ("next heading", "read this line") are easy — a cheap,
 *   fast model is plenty. A few are hard ("I'm lost, where am I, what now?") —
 *   worth the strong model with reasoning on. Paying k3-with-reasoning rates for
 *   every keystroke is money set on fire; this routes by task tier instead.
 *
 * MONEY NOTE (from the creds + architecture): k3 AND k2.6 are the SAME Moonshot
 *   billing pot you already fund — so the cheap tier can be k2.6, no new account.
 *   Both are multimodal (image in), so the vision tier rides the same pot too.
 *   DeepSeek is wired as an even-cheaper option but stays OFF until you say go.
 *
 * MOONSHOT VALIDATION (hard-won, in the creds): reasoning OFF wants
 *   temperature 0.6 exactly; reasoning ON wants temperature 1 exactly and
 *   max_tokens >= 3000 or the content comes back empty. Wrong combo = 400.
 *   This file encodes those rules so a caller can't trip them.
 */

const PROVIDERS = {
  moonshot: {
    url: 'https://api.moonshot.ai/v1/chat/completions',
    keyEnv: 'MOONSHOT_KEY',
    shape(body, effort) {
      if (!effort || effort === 'none') {
        return { ...body, reasoning_effort: 'none', temperature: 0.6 };
      }
      return { ...body, reasoning_effort: effort, temperature: 1, max_tokens: Math.max(body.max_tokens || 0, 3000) };
    },
  },
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
    keyEnv: 'DEEPSEEK_API_KEY',
    shape(body) { return { ...body, temperature: body.temperature != null ? body.temperature : 0.3 }; },
  },
  // Generic OpenAI-compatible (e.g. the reframe-proxy) — pass a url explicitly.
  openai: {
    url: null,
    keyEnv: null,
    shape(body) { return body; },
  },
};

// Task tiers → which model + how much reasoning, plus a fallback tier used if
// the primary errors (auth/quota/network). Override any of these at
// construction time or via env KADE_NVDA_TIERS (JSON); this is policy, not law.
//
// Chosen with Kade Aug 14: k3 plans, DeepSeek runs the cheap text steps, k2.6
// handles vision — verified live (DeepSeek's chat API rejects image input, so
// vision must be k2.6). k2.6 is the always-funded fallback for every tier.
const DEFAULT_TIERS = {
  plan: { provider: 'moonshot', model: 'kimi-k3', effort: 'medium', fallback: 'step_fb' },
  step: { provider: 'deepseek', model: 'deepseek-v4-pro', fallback: 'step_fb' },
  vision: { provider: 'moonshot', model: 'kimi-k2.6', effort: 'none' },
  step_fb: { provider: 'moonshot', model: 'kimi-k2.6', effort: 'none' }, // funded pot
};

function loadTierOverrides() {
  if (!process.env.KADE_NVDA_TIERS) return {};
  try { return JSON.parse(process.env.KADE_NVDA_TIERS); } catch { return {}; }
}

class BudgetError extends Error { constructor(m) { super(m); this.code = 'BUDGET'; } }

class ModelRouter {
  constructor(opts = {}) {
    this.tiers = { ...DEFAULT_TIERS, ...loadTierOverrides(), ...(opts.tiers || {}) };
    this.providers = { ...PROVIDERS, ...(opts.providers || {}) };
    this.fetch = opts.fetchImpl || globalThis.fetch;
    this.getKey = opts.getKey || ((env) => (env ? process.env[env] : null));
    this.onUsage = opts.onUsage || (() => {});
    this.budget = opts.budget || null; // { maxCalls, maxTokens } per run
    this._calls = 0;
    this._tokens = 0;
  }

  pick(tierName) { return this.tiers[tierName] || this.tiers.step; }

  /** Run one chat completion for a tier. messages is OpenAI-shaped; for a
   *  vision step, a message's content is the array form with an image_url part
   *  (k2.6 accepts it; DeepSeek does not — the vision tier is k2.6). On a
   *  provider error the tier's fallback (if any) is tried ONCE. Returns {text}. */
  async chat(tierName, messages, opts = {}) {
    if (this.budget) {
      if (this.budget.maxCalls && this._calls >= this.budget.maxCalls) throw new BudgetError(`run hit maxCalls=${this.budget.maxCalls}`);
      if (this.budget.maxTokens && this._tokens >= this.budget.maxTokens) throw new BudgetError(`run hit maxTokens=${this.budget.maxTokens}`);
    }
    const tier = this.pick(tierName);
    const prov = this.providers[tier.provider];
    if (!prov) throw new Error(`unknown provider ${tier.provider}`);
    const url = opts.url || prov.url;
    if (!url) throw new Error(`no url for provider ${tier.provider}`);
    const key = this.getKey(prov.keyEnv);
    if (!key && prov.keyEnv) throw new Error(`no key for ${tier.provider} (env ${prov.keyEnv})`);

    let body = { model: tier.model, messages, max_tokens: opts.maxTokens || 400 };
    body = prov.shape(body, tier.effort);

    let res;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return this._fallbackOr(tier, tierName, messages, opts, `network: ${e.message}`);
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return this._fallbackOr(tier, tierName, messages, opts, `${tier.provider}/${tier.model} ${res.status}: ${String(t).slice(0, 160)}`);
    }
    const data = await res.json();
    const usage = data.usage || {};
    this._calls++;
    this._tokens += usage.total_tokens || 0;
    this.onUsage({ tier: tierName, model: tier.model, usage });
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
    return { text, usage, model: tier.model, tier: tierName };
  }

  async _fallbackOr(tier, tierName, messages, opts, why) {
    if (tier.fallback && !opts._isFallback && this.tiers[tier.fallback]) {
      this.onUsage({ tier: tierName, fallback: tier.fallback, note: 'primary failed: ' + why });
      return this.chat(tier.fallback, messages, { ...opts, _isFallback: true });
    }
    throw new Error(why);
  }

  stats() { return { calls: this._calls, tokens: this._tokens }; }
}

module.exports = { ModelRouter, PROVIDERS, DEFAULT_TIERS, BudgetError };
