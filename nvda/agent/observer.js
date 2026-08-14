'use strict';
/**
 * Observer — the agent's entire perception. A rolling transcript of what the
 * controlled NVDA has spoken, plus wait_for_speech: act, then listen for the
 * outcome to SETTLE before acting again. The spec's hard-won note: speech
 * events can arrive a beat late through a hosted relay, so this is a settle
 * timer, not a race.
 */

const { EventEmitter } = require('events');

class Observer extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.keep = opts.keep || 300;
    this.lines = []; // {t, text}
  }

  /** Feed a spoken line in (called from the client's onSpeak). */
  push(text) {
    if (!text) return;
    const entry = { t: Date.now(), text };
    this.lines.push(entry);
    if (this.lines.length > this.keep) this.lines.shift();
    this.emit('speak', text, entry);
  }

  /** Last n spoken lines as plain strings. */
  recent(n = 15) {
    return this.lines.slice(-n).map((l) => l.text);
  }

  /** Everything since a timestamp marker (Observer.now() before an action). */
  since(marker) {
    return this.lines.filter((l) => l.t > marker).map((l) => l.text);
  }

  now() { return Date.now(); }

  /**
   * Resolve after new speech arrives and then goes quiet for settleMs.
   *  - settleMs: quiet window that means "NVDA finished reacting"
   *  - timeoutMs: give up (resolve with whatever we have) after this long
   *  - match: optional predicate(text) — resolve early once satisfied+settled
   *  - since: only count speech after this marker (default: now)
   * Returns the array of lines heard during the wait.
   */
  waitForSpeech(opts = {}) {
    const settleMs = opts.settleMs != null ? opts.settleMs : 400;
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 6000;
    const match = opts.match || null;
    const since = opts.since != null ? opts.since : this.now();

    return new Promise((resolve) => {
      const heard = [];
      let settleTimer = null;
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(hardTimeout);
        if (settleTimer) clearTimeout(settleTimer);
        this.off('speak', onSpeak);
        resolve(heard);
      };

      const armSettle = () => {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(finish, settleMs);
      };

      const onSpeak = (text, entry) => {
        if (entry.t <= since) return;
        heard.push(text);
        if (match && match(text, heard)) { finish(); return; }
        armSettle();
      };

      // Include anything already spoken since the marker (fast path).
      const preexisting = this.since(since);
      for (const t of preexisting) {
        heard.push(t);
        if (match && match(t, heard)) { resolve(heard); return; }
      }

      const hardTimeout = setTimeout(finish, timeoutMs);
      this.on('speak', onSpeak);
      if (heard.length) armSettle();
    });
  }
}

module.exports = { Observer };
