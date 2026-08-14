'use strict';
/**
 * Recorder — the auditable receipt. Every observation (speak), every action
 * (keys/text), every decision and safety event lands in one time-ordered
 * transcript. This is the promise guard's natural sibling: the claim and the
 * receipt live in the same file, so "did the agent actually do it" is a grep,
 * not a guess.
 */

const fs = require('fs');
const path = require('path');

class Recorder {
  constructor(opts = {}) {
    this.events = [];
    this.file = opts.file || '';
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Fresh session header
      this._write({ kind: 'session_start', t: Date.now(), goal: opts.goal || null });
    }
  }

  _write(ev) {
    if (this.file) {
      try { fs.appendFileSync(this.file, JSON.stringify(ev) + '\n'); } catch { /* non-fatal */ }
    }
  }

  log(kind, data = {}) {
    const ev = { kind, t: Date.now(), ...data };
    this.events.push(ev);
    this._write(ev);
    return ev;
  }

  speak(text) { return this.log('speak', { text }); }
  decision(plan) { return this.log('decision', { plan }); }
  action(action, detail) { return this.log('action', { action, ...detail }); }
  blocked(reason, detail) { return this.log('blocked', { reason, ...detail }); }
  note(text, detail = {}) { return this.log('note', { text, ...detail }); }

  /** Full transcript, human-readable, for a spoken or logged audit. */
  transcript() {
    return this.events.map((e) => {
      const ts = new Date(e.t).toISOString().slice(11, 19);
      if (e.kind === 'speak') return `[${ts}] NVDA: ${e.text}`;
      if (e.kind === 'action') return `[${ts}] DID: ${e.action}${e.chord ? ' ' + e.chord : ''}${e.text ? ' "' + e.text + '"' : ''}`;
      if (e.kind === 'decision') return `[${ts}] PLAN: ${JSON.stringify(e.plan)}`;
      if (e.kind === 'blocked') return `[${ts}] BLOCKED: ${e.reason}`;
      if (e.kind === 'note') return `[${ts}] NOTE: ${e.text}`;
      return `[${ts}] ${e.kind}: ${JSON.stringify(e)}`;
    }).join('\n');
  }

  find(kind) { return this.events.filter((e) => e.kind === kind); }
}

module.exports = { Recorder };
