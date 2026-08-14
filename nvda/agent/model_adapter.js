'use strict';
/**
 * Model adapter — turns a real LLM into a `decide` function for the brain loop,
 * routed through the ModelRouter so routine steps ride the cheap tier and hard
 * moments get the strong one.
 *
 * OFF BY DEFAULT. Inert until a provider key is in the environment
 * (MOONSHOT_KEY for k3/k2.6) AND the caller opts in. No model is called, and no
 * money moves, in the co-listener default or in any offline test.
 *
 * The system prompt teaches the one thing that makes this agent different: it
 * perceives only what the screen reader speaks and acts only by keys, so it
 * navigates with screen-reader idioms and answers in a tiny JSON action.
 */

const { ModelRouter } = require('./models');

const SYSTEM_PROMPT = `You operate a Windows computer THROUGH a blind user's screen reader (NVDA), not around it.
You do NOT see pixels. Your ENTIRE perception is the text NVDA speaks aloud, given to you as a running transcript.
You act ONLY by sending keystrokes and typed text, exactly as the user themself would.

Navigate with screen-reader idioms in the browser's browse mode:
- h = next heading, b = next button, e = edit field, k = link, f = form field, t = table; add shift for previous.
- tab / shift+tab move focus; arrows read line by line; enter or space activates.
- control+l focuses the address bar; control+f finds text on the page.
- Read the transcript to know where you are before you act. If unsure, do a small read (down arrow) and look again.

Key syntax: combine a modifier WITH its key using + in ONE string — "control+l", "shift+b", "alt+f4". A list like ["h","h"] is a SEQUENCE of separate presses; ["shift+b"] is one chord. Never split a modifier into its own list item.

Confirmation: when a step is destructive (publish, send, delete, buy, pay), just propose that ONE action directly. The SYSTEM automatically asks the user to confirm before it fires — you do NOT need to ask, narrate a warning, or wait for a reply first. Propose it and it will be gated for you.

Reply with ONE JSON object and nothing else. Allowed shapes:
{"action":"send_keys","keys":["h","h"],"intent":"go to the App Privacy heading"}
{"action":"type_text","text":"appstoreconnect.apple.com","intent":"open App Store Connect"}
{"action":"wait","ms":800}
{"action":"say","text":"You're on the Publish button now."}
{"action":"done","summary":"Privacy details published."}

Rules you cannot break:
- Never propose NVDA+Q or anything that quits the screen reader.
- Never type into a field the transcript announced as a password or secure field; stop and say so.
- Anything destructive (send, submit, publish, delete, buy, pay) will be confirmed with the user first — propose it, don't fear it, but keep those to a single clear step.
- One small step at a time. Prefer reading over guessing.`;

function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch { /* */ } }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
  return null;
}

/** Choose a tier from the task state: the first move and any recovery-from-
 *  trouble move get the strong planner; everything else takes the cheap step
 *  tier. This is the model cycling, driven by what's happening on screen. */
function tierFor(ctx) {
  if (ctx.step === 0) return 'plan';
  const last = (ctx.lastOutcome || []).join(' ');
  if (!last.trim() || /\[action (blocked|failed)|did not approve|could not/i.test(last)) return 'plan';
  return 'step';
}

/**
 * makeModelBrain({ router?, tierFor?, maxTokens? })
 *   router: a ModelRouter (built from env if omitted). Requires MOONSHOT_KEY.
 * Returns an async decide(ctx) => plan, and exposes .router for usage stats.
 */
function makeModelBrain(opts = {}) {
  const router = opts.router || new ModelRouter(opts.routerOpts || {});
  // Fail fast if nothing can answer, so the co-listener default never silently
  // becomes a paid path.
  const probeKey = router.getKey('MOONSHOT_KEY');
  if (!probeKey && !opts.allowUnkeyed) {
    throw new Error('model brain not configured: set MOONSHOT_KEY (k3/k2.6) or pass a configured router. Off by design until Kade says go.');
  }
  const chooseTier = opts.tierFor || tierFor;
  const maxTokens = opts.maxTokens || 400;

  const decide = async function decide(ctx) {
    const userMsg = [
      `GOAL: ${ctx.goal}`,
      '',
      'TRANSCRIPT (most recent last):',
      ...ctx.transcript.map((l) => '  ' + l),
      '',
      ctx.lastOutcome && ctx.lastOutcome.length ? `SINCE YOUR LAST ACTION: ${ctx.lastOutcome.join(' | ')}` : 'SINCE YOUR LAST ACTION: (nothing new)',
      '',
      'Your one JSON action:',
    ].join('\n');

    const tier = chooseTier(ctx);
    let out;
    try {
      out = await router.chat(tier, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ], { maxTokens });
    } catch (e) {
      if (e.code === 'BUDGET') return { action: 'done', summary: `stopped on budget: ${e.message}` };
      throw e;
    }
    const plan = extractJson(out.text);
    if (!plan || !plan.action) return { action: 'say', text: 'I could not read a clear next step; stopping.' };
    plan._tier = tier;
    plan._usage = out.usage;
    return plan;
  };
  decide.router = router;
  return decide;
}

module.exports = { makeModelBrain, SYSTEM_PROMPT, extractJson, tierFor };
