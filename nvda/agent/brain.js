'use strict';
/**
 * Brain — the observe → decide → act loop.
 *
 * Observation is the rolling transcript (what NVDA just spoke). A decision is
 * one small plan: { action, ... }. Actions are executed through the safety
 * rails, then the loop LISTENS for the spoken outcome before deciding again
 * (wait_for_speech, settle timer). `decide` and `confirm` are injected so the
 * same loop runs a scripted test brain, a co-listener, or a real model.
 *
 * A plan is one of:
 *   { action:'send_keys', keys:['h','h','enter'], intent:'jump to App Privacy' }
 *   { action:'type_text', text:'appstoreconnect.apple.com', intent:'open ASC' }
 *   { action:'wait', ms:800 }
 *   { action:'say', text:'You are on the App Privacy heading.' }
 *   { action:'done', summary:'Privacy published.' }
 */

async function runAgentLoop(opts) {
  const {
    goal,
    observer,
    actions,
    safety,
    recorder,
    decide,
    confirm = async () => false, // default: deny destructive-shaped actions
    maxSteps = 40,
    settleMs = 400,
    timeoutMs = 6000,
  } = opts;

  recorder.note('goal', { goal });
  let lastOutcome = observer.recent(6);

  let step = 0;
  for (; step < maxSteps; step++) {
    const context = { goal, transcript: observer.recent(25), lastOutcome, step };

    let plan;
    try {
      plan = await decide(context);
    } catch (e) {
      recorder.note('decide-error', { error: e.message });
      break;
    }
    if (!plan || !plan.action) { recorder.note('no-plan-stop'); break; }
    recorder.decision(plan);

    if (plan.action === 'done') { await actions.perform(plan); break; }
    if (plan.action === 'say' || plan.action === 'wait') {
      await actions.perform(plan);
      lastOutcome = plan.action === 'wait'
        ? observer.recent(6)
        : [plan.text || plan.intent || ''];
      continue;
    }

    // Confirm-before-act for destructive-shaped plans.
    if (safety.needsConfirm(plan)) {
      let approved = false;
      try { approved = await confirm(plan, context); } catch { approved = false; }
      recorder.log('confirm', { plan, approved: !!approved });
      if (!approved) {
        recorder.blocked('confirm-denied', { plan });
        lastOutcome = ['[the user did not approve that action]'];
        continue;
      }
    }

    const since = observer.now();
    try {
      const r = await actions.perform(plan);
      if (r && r.done) break;
    } catch (e) {
      recorder.note('action-stopped', { code: e.code || null, error: e.message });
      if (e.code === 'RUNAWAY') break; // hard ceiling — abort the whole loop
      lastOutcome = [`[action blocked: ${e.message}]`];
      continue;
    }

    lastOutcome = await observer.waitForSpeech({ since, settleMs, timeoutMs });
  }

  recorder.note('loop-end', { steps: step });
  return { steps: step, recorder };
}

/** Co-listener brain: never acts. Summarizes and finishes. v0.1 behavior,
 *  now expressed as a decider so the same loop can run it. */
function coListenerBrain() {
  let asked = false;
  return async ({ transcript }) => {
    if (asked) return { action: 'done', summary: transcript.slice(-3).join(' | ') };
    asked = true;
    return { action: 'say', text: `Heard: ${transcript.slice(-3).join(' | ')}` };
  };
}

/** Scripted brain: a fixed list of plans, optionally guarded by a predicate on
 *  the transcript so a step waits for the right screen. For tests and demos. */
function scriptedBrain(steps) {
  let i = 0;
  return async ({ transcript, lastOutcome }) => {
    if (i >= steps.length) return { action: 'done', summary: 'script complete' };
    const s = steps[i];
    if (typeof s === 'function') { const p = s({ transcript, lastOutcome }); i++; return p; }
    if (s.when && !s.when(transcript.concat(lastOutcome).join(' '))) {
      return { action: 'wait', ms: 150 }; // hold until the screen matches
    }
    i++;
    return s.plan || s;
  };
}

module.exports = { runAgentLoop, coListenerBrain, scriptedBrain };
