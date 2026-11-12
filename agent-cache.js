'use strict';
/* agent-cache.js (Nov 12 2026, gateway audit GW-7). Every inbound call turn reads the agent list (the
 * spoken agent switch), so reading it must never make a caller wait. A stale list is returned at once and
 * refreshed behind the call; a failed refresh waits before the next try instead of re-asking on every
 * turn (each ask rides the voice proxy's paced line). Only the first fetch after a boot is awaited.
 * Until one fetch has succeeded the wait is coldRetryMs (short), so a boot-time miss does not leave
 * the spoken agent switch dead for minutes; after that it is retryMs. A failed or malformed answer
 * never replaces a good list. */
function createAgentCache({
  fetchList, ttlMs = 60 * 60 * 1000, retryMs = 2 * 60 * 1000, coldRetryMs = 15 * 1000,
  now = () => Date.now(), log = console,
} = {}) {
  let list = null, loaded = false, freshUntil = 0, retryAt = 0, inFlight = null;
  function refresh() {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(fetchList)
      .then((agents) => {
        if (!Array.isArray(agents)) throw new Error('agent list was not an array');
        list = agents;
        loaded = true;
        freshUntil = now() + ttlMs;
        retryAt = 0;
        try { log.log(`[bridge] Agent cache: ${list.length} public agents`); } catch {}
        return list;
      })
      .catch((e) => {
        retryAt = now() + (loaded ? retryMs : coldRetryMs);
        try { log.error('[bridge] Failed to fetch agents:', e && e.message); } catch {}
        list = list || [];
        return list;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }
  async function get() {
    if (list && now() < freshUntil) return list;
    if (list) {
      if (now() >= retryAt) refresh();   // never rejects (see the catch above)
      return list;                        // stale beats a wait
    }
    return refresh();
  }
  return { get, refresh };
}
module.exports = { createAgentCache };
