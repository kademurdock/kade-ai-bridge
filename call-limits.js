'use strict';
/* Nov 10 2026 (call limits lane). CALLS END BY THEMSELVES.
 *
 * An inbound phone call had no maximum length and no idle hang-up. A phone left off the hook kept
 * Twilio, Deepgram, the model and speech running until Twilio's own four-hour limit. This is the
 * watch that ends such a call, and it is built around one rule: NOBODY IS EVER CUT OFF BY SURPRISE.
 * Every hang-up is announced first, in the character's voice, with time left to answer or finish.
 *
 * Two limits, both set by environment variables, both generous by default:
 *
 *   CALL_IDLE_MINUTES        (default 10)  the line has been quiet this long: nothing heard from
 *                                          the caller AND the character neither speaking nor
 *                                          working. The character checks in out loud.
 *   CALL_IDLE_GRACE_SECONDS  (default 60)  how long after that question ends before the call is
 *                                          ended. ANYTHING heard from the caller in between (a
 *                                          word, a key press) cancels it and the count starts over.
 *   CALL_MAX_MINUTES         (default 120) the longest one call may run.
 *   CALL_MAX_WARN_SECONDS    (default 120) how long before that the character says the call is
 *                                          about to end and that calling right back is fine. The
 *                                          hang-up comes this long after the warning was SPOKEN,
 *                                          never sooner, even if the warning had to wait its turn.
 *   CALL_LIMITS=0                          switches the whole watch off. A limit set to 0 is off.
 *
 * What counts as the caller being there: a finished utterance (always), words Deepgram hears while
 * the character is not talking (so the character's own voice on a speakerphone does not count), or
 * a key press. While the character is speaking, thinking or reading something long, the line is in
 * use and the quiet count does not run.
 *
 * What this cannot see: a television next to a phone that is off the hook sounds like a caller.
 * The quiet limit never fires on such a call; the maximum length is what ends it.
 *
 * Scope: inbound phone calls only (voice-stream.js arms it there). Outbound calls already carry
 * Twilio's own timeLimit (OUTBOUND_TIME_LIMIT_SEC), and a business putting the character on hold is
 * quiet on purpose. App and web calls are not armed: their camera and watch modes are quiet on
 * purpose too, and that needs its own design.
 *
 * This module has no timers of its own beyond one interval and knows nothing about sockets. It is
 * handed four things (is the line open, is the character busy, say a line, hang up) and a clock,
 * so every rule here is tested with a fake clock in call-limits.test.js.
 */

const MIN = 60 * 1000;

function num(v, dflt) {
  if (v === undefined || v === null || String(v).trim() === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** The limits in milliseconds, from the environment. Bad or negative values fall back to defaults. */
function limitsConfig(env = process.env) {
  const off = String(env.CALL_LIMITS || '').trim() === '0';
  const idleMs = Math.round(num(env.CALL_IDLE_MINUTES, 10) * MIN);
  const maxMs = Math.round(num(env.CALL_MAX_MINUTES, 120) * MIN);
  let maxWarnMs = Math.round(num(env.CALL_MAX_WARN_SECONDS, 120) * 1000);
  // A warning needs room to be heard and acted on, and cannot be longer than the call.
  if (maxMs > 0) maxWarnMs = Math.max(15000, Math.min(maxWarnMs, Math.floor(maxMs / 2)));
  const idleGraceMs = Math.max(15000, Math.round(num(env.CALL_IDLE_GRACE_SECONDS, 60) * 1000));
  return { enabled: !off && (idleMs > 0 || maxMs > 0), idleMs: off ? 0 : idleMs, idleGraceMs, maxMs: off ? 0 : maxMs, maxWarnMs };
}

/** "about two minutes", "about a minute", "about thirty seconds": a length said the way a person would. */
function spokenSpan(ms) {
  const s = Math.round(ms / 1000);
  if (s < 50) return `about ${Math.max(10, Math.round(s / 10) * 10)} seconds`;
  const m = Math.round(s / 60);
  if (m <= 1) return 'about a minute';
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  return `about ${words[m] || m} minutes`;
}

/* THE WORDING IS LOAD-BEARING. The bridge drops what it hears when it looks like the character's own
 * voice coming back through a speakerphone (most of the heard words are words it just said). The
 * natural answers to "are you there?" are "yes", "I'm here", "I'm still here", "hello", "wait",
 * "don't hang up". So these lines use NONE of those words: no "still", "here", "there", "I'm",
 * "yes", "hello", "wait", "hang up". An answer can then never be mistaken for the question's echo.
 * call-limits.test.js holds this as a rule. */
const LINES = {
  idleWarn: (c) => `Checking in: it has been quiet for a while. Say anything and we will keep going. Otherwise this call will end in ${spokenSpan(c.idleGraceMs)}.`,
  idleEnd: () => `Nobody answered, so this call is ending now. Call back any time. Bye!`,
  maxWarn: (c) => `Quick heads up: we have been on the phone a long while, and this call has to end in ${spokenSpan(c.maxWarnMs)}. You can call right back and we will pick up where we left off.`,
  maxEnd: () => `That is all the time this call gets, so it is ending now. Call right back any time. Bye for now!`,
};
const ANSWER_WORDS = ['still', 'here', 'there', "i'm", 'im', 'yes', 'yeah', 'hello', 'wait', 'hang', "don't", 'dont', 'hey', 'no'];

/* How long a warning may wait for a gap in the conversation before it is said anyway. */
const WARN_WAIT_MS = 30000;
/* How long the goodbye may wait for the character to finish a sentence. */
const END_WAIT_MS = 15000;

/**
 * One watch for one call.
 *   cfg     limitsConfig() output (milliseconds)
 *   now     () => ms
 *   isOpen  () => the call's socket is still open
 *   isBusy  () => the character is speaking, thinking, or the greeting is still playing
 *   say     async (line, { final }) => speak it to the caller; resolves when it has been heard.
 *           `final` means the goodbye: the implementation may stop whatever is playing first.
 *   hangUp  (reason) => end the call ('idle' | 'max')
 *   log     console-like
 * The owner calls tick() on a timer (a few seconds apart), noteHeard() when the caller is heard,
 * and stop() when the call ends.
 */
function createCallWatch({ cfg, now = () => Date.now(), isOpen, isBusy, say, hangUp, log = console, label = '' }) {
  const startedAt = now();
  const st = {
    startedAt,
    lastHeardAt: startedAt,   // the caller: a word, an utterance, a key
    lastActiveAt: startedAt,  // the line in use: the caller heard, or the character busy
    idleWarnedAt: 0,          // when the spoken check-in was started
    idleWarnDoneAt: 0,        // when it finished playing
    maxDueSince: 0,           // when the max warning first came due (it may wait for a gap)
    maxWarnedAt: 0,           // when the max warning was started
    maxWarnDoneAt: 0,
    endDueSince: 0,
    ending: null,             // 'idle' | 'max' once the goodbye has started
    heardDuringEnd: false,    // the caller spoke while the quiet-line goodbye was playing
    stopped: false,
    saying: false,
  };
  const tag = `[call-limits]${label ? ' ' + label : ''}`;

  function noteHeard() {
    if (st.stopped || st.ending === 'max') return;
    if (st.ending === 'idle') {
      // They answered while the quiet-line goodbye was playing: the call must not be ended.
      st.heardDuringEnd = true;
      return;
    }
    const t = now();
    st.lastHeardAt = t;
    st.lastActiveAt = t;
    if (st.idleWarnedAt) {
      st.idleWarnedAt = 0;
      st.idleWarnDoneAt = 0;
      log.log(`${tag} the caller is there: quiet hang-up cancelled, the count starts over`);
    }
  }

  async function speak(line, opts, onDone) {
    st.saying = true;
    try { await say(line, opts || {}); } catch (e) { log.warn(`${tag} could not speak a line: ${e && e.message}`); }
    st.saying = false;
    if (onDone) onDone(now());
  }

  function end(reason) {
    if (st.ending || st.stopped) return;
    st.ending = reason;
    const mins = Math.round((now() - startedAt) / MIN);
    log.log(`${tag} ending the call: ${reason === 'idle' ? 'the line stayed quiet after the warning' : 'the maximum call length was reached'} (${mins} min in)`);
    speak(LINES[reason === 'idle' ? 'idleEnd' : 'maxEnd'](cfg), { final: true }, (doneAt) => {
      if (st.stopped) return;
      if (reason === 'idle' && st.heardDuringEnd) {
        st.heardDuringEnd = false;
        st.ending = null;
        st.idleWarnedAt = 0;
        st.idleWarnDoneAt = 0;
        st.lastHeardAt = doneAt;
        st.lastActiveAt = doneAt;
        log.log(`${tag} the caller spoke during the goodbye: staying on the line, the count starts over`);
        return;
      }
      try { hangUp(reason); } catch (e) { log.warn(`${tag} hang-up failed: ${e && e.message}`); }
    });
  }

  function tick() {
    if (st.stopped || st.ending) return;
    if (!isOpen()) { stop(); return; }
    const t = now();
    const busy = !!isBusy();
    if (busy && !st.saying) st.lastActiveAt = t;

    // ── The maximum length ────────────────────────────────────────────────
    if (cfg.maxMs > 0) {
      if (!st.maxWarnedAt && t >= startedAt + cfg.maxMs - cfg.maxWarnMs) {
        if (!st.maxDueSince) st.maxDueSince = t;
        // Wait for a gap so the warning does not talk over a reply; after WARN_WAIT_MS say it anyway.
        if (!st.saying && (!busy || t - st.maxDueSince >= WARN_WAIT_MS)) {
          st.maxWarnedAt = t;
          log.log(`${tag} max length warning (${spokenSpan(cfg.maxWarnMs)} left)`);
          speak(LINES.maxWarn(cfg), {}, (doneAt) => { st.maxWarnDoneAt = doneAt; });
        }
      }
      // The hang-up is a full warning period after the warning was SPOKEN, never sooner.
      if (st.maxWarnedAt && st.maxWarnDoneAt && t >= st.maxWarnDoneAt + cfg.maxWarnMs) {
        if (!st.endDueSince) st.endDueSince = t;
        if (!busy || t - st.endDueSince >= END_WAIT_MS) { end('max'); return; }
      }
      // A warning that could not be spoken at all (speech is down) must not hold the line for ever.
      if (st.maxWarnedAt && !st.maxWarnDoneAt && !st.saying && t >= st.maxWarnedAt + cfg.maxWarnMs + WARN_WAIT_MS) { end('max'); return; }
    }

    // ── The quiet line ────────────────────────────────────────────────────
    if (cfg.idleMs > 0) {
      if (!st.idleWarnedAt) {
        // Not while the max warning is being said or was just said: one thing at a time.
        const justWarned = st.maxWarnedAt && (!st.maxWarnDoneAt || t - st.maxWarnDoneAt < 5000);
        if (!busy && !st.saying && !justWarned && t - st.lastActiveAt >= cfg.idleMs) {
          st.idleWarnedAt = t;
          st.idleWarnDoneAt = 0;
          const warnedAt = t;
          log.log(`${tag} quiet for ${Math.round((t - st.lastActiveAt) / 1000)} s: asking if the caller is still there`);
          speak(LINES.idleWarn(cfg), {}, (doneAt) => { if (st.idleWarnedAt === warnedAt) st.idleWarnDoneAt = doneAt; });
        }
      } else if (st.idleWarnDoneAt && t >= st.idleWarnDoneAt + cfg.idleGraceMs) {
        // noteHeard() clears idleWarnedAt, so reaching here means nothing was heard since the question.
        end('idle');
      } else if (!st.idleWarnDoneAt && !st.saying && t >= st.idleWarnedAt + cfg.idleGraceMs + WARN_WAIT_MS) {
        end('idle'); // the question could not be spoken at all
      }
    }
  }

  function stop() { st.stopped = true; }

  return { tick, noteHeard, stop, state: st };
}

/** The one startup line: what the limits are, in words a log reader can check. */
function limitsStartupLine(cfg = limitsConfig()) {
  if (!cfg.enabled) return '[call-limits] off (CALL_LIMITS=0 or both limits 0): inbound calls have no time limit';
  const idle = cfg.idleMs > 0 ? `quiet line: asks after ${cfg.idleMs / MIN} min, hangs up ${cfg.idleGraceMs / 1000} s later` : 'quiet line: off';
  const max = cfg.maxMs > 0 ? `longest call: ${cfg.maxMs / MIN} min, warned ${cfg.maxWarnMs / 1000} s before` : 'longest call: off';
  return `[call-limits] inbound phone calls. ${idle}. ${max}.`;
}

module.exports = { limitsConfig, createCallWatch, spokenSpan, limitsStartupLine, LINES, ANSWER_WORDS, WARN_WAIT_MS, END_WAIT_MS };
