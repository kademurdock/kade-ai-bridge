/* call-memory.js -- Nov 10 2026.
 *
 * Two small rules for the memory bundle a call fetches from the site
 * (/api/kade/call-memories), kept here so they can be tested without
 * booting the bridge or a call.
 *
 * 1. HOW LONG THE BRIDGE WAITS. The fetch gave up at 2.5 s and returned
 *    nothing. Nothing on a call ever awaits that fetch (the greeting and
 *    every turn go out without it and read whatever has landed), so giving
 *    up early bought no speed -- it only threw the bundle away. Worse, when
 *    the call is live the site marks waiting reminders and family messages
 *    as delivered BEFORE it answers, so a bundle dropped at 2.5 s took those
 *    with it. Calls now wait about 6 s. Awaited users of the same fetch (the
 *    morning brief, research reports) keep the old 2.5 s: they do wait on it.
 *
 * 2. WHICH ANSWER MAY LAND. A longer wait widens one race: the bundle asked
 *    for at pickup can now arrive after the caller has switched to another
 *    character, and it would overwrite that character's bundle with the old
 *    one's. Each fetch takes a ticket; only the newest ticket may write.
 *
 * Off switches (default ON, "=0" turns it off, no redeploy needed beyond the
 * variable):
 *   KADE_CALL_MEMORY_LONG_WAIT=0    back to the 2.5 s give-up on calls
 *   KADE_CALL_MEMORY_LATE_ATTACH=0  back to "whatever lands last wins"
 * Setting:
 *   KADE_CALL_MEMORY_WAIT_MS        the call wait, default 6000 (1000-15000)
 */

const LEGACY_WAIT_MS = 2500;
const DEFAULT_CALL_WAIT_MS = 6000;
const MIN_CALL_WAIT_MS = 1000;
const MAX_CALL_WAIT_MS = 15000;

function longWaitOn(env = process.env) {
  return String(env.KADE_CALL_MEMORY_LONG_WAIT || '').trim() !== '0';
}

function lateAttachOn(env = process.env) {
  return String(env.KADE_CALL_MEMORY_LATE_ATTACH || '').trim() !== '0';
}

/** How long fetchCallMemories waits for the site, in ms.
 *  `opts.call` is true only at the three call sites in voice-stream.js,
 *  none of which is awaited. Everything else keeps the old 2.5 s. */
function callMemoryTimeoutMs(opts = {}, env = process.env) {
  if (!opts || !opts.call) return LEGACY_WAIT_MS;
  if (!longWaitOn(env)) return LEGACY_WAIT_MS;
  const raw = String(env.KADE_CALL_MEMORY_WAIT_MS || '').trim();
  if (!raw) return DEFAULT_CALL_WAIT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CALL_WAIT_MS;
  return Math.min(MAX_CALL_WAIT_MS, Math.max(MIN_CALL_WAIT_MS, Math.round(n)));
}

/** Take a ticket for a bundle fetch on this call. Synchronous, no I/O. */
function beginCallMemoryFetch(session, now = Date.now()) {
  if (!session) return null;
  session._callMemorySeq = (session._callMemorySeq || 0) + 1;
  return { seq: session._callMemorySeq, at: now };
}

/** Put a bundle that has just arrived onto the call, however late it is.
 *  The turn builder reads session.callerMemories fresh on every turn, so
 *  the next thing the caller says is answered with it.
 *
 *  session        the call, or null once the call has ended
 *  ticket         what beginCallMemoryFetch returned for this fetch
 *  text           the bundle, or null/'' when the site had nothing
 *  opts.clearOnEmpty  true at a character switch: an empty answer clears the
 *                     previous character's bundle instead of keeping it
 *
 *  Returns { applied, reason, ms }. Never throws. */
function applyCallMemories(session, ticket, text, opts = {}, env = process.env, now = Date.now()) {
  const ms = ticket && typeof ticket.at === 'number' ? Math.max(0, now - ticket.at) : null;
  if (!session) return { applied: false, reason: 'call-ended', ms };
  if (lateAttachOn(env) && ticket && session._callMemorySeq !== ticket.seq) {
    return { applied: false, reason: 'superseded', ms };
  }
  if (!text) {
    if (opts.clearOnEmpty) {
      session.callerMemories = null;
      return { applied: true, reason: 'cleared', ms };
    }
    return { applied: false, reason: 'empty', ms };
  }
  session.callerMemories = text;
  session.callerMemoriesAt = now;
  return { applied: true, reason: 'attached', ms };
}

module.exports = {
  LEGACY_WAIT_MS, DEFAULT_CALL_WAIT_MS, MIN_CALL_WAIT_MS, MAX_CALL_WAIT_MS,
  longWaitOn, lateAttachOn, callMemoryTimeoutMs, beginCallMemoryFetch, applyCallMemories,
};
