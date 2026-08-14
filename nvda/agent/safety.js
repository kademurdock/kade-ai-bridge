'use strict';
/**
 * Safety rails — day one, non-negotiable (from the spec).
 *
 *   1. Hard no-go list the agent cannot cross: never NVDA+Q (quitting her
 *      screen reader is taking her eyes). Configurable, never empty.
 *   2. Never type into a field NVDA announced as a password / secure field —
 *      stop and hand back.
 *   3. Rate-limit keystrokes to human pace so a runaway loop can't outrun her
 *      ability to say "stop"; a hard ceiling aborts a true runaway.
 *   4. Confirm-before-act for anything destructive-shaped (delete, send,
 *      purchase, submit, publish…).
 *   5. (Recording lives in recorder.js — the fifth rail.)
 *
 * The pure predicates here are unit-tested with no network in safety.test.js.
 */

const { parseChord } = require('./keymap');

const VK_Q = 0x51;
const VK_INSERT = 0x2d;
const VK_CAPSLOCK = 0x14;

// Destructive-shaped intent — matched against the plan's human-readable
// `intent`/`why`, NOT the keys, because the same Enter can confirm a search or
// a purchase. Word boundaries; present + imperative shapes.
const DESTRUCTIVE = /\b(delete|deleting|remove|removing|erase|erasing|send|sending|submit|submitting|publish|publishing|purchase|buy|buying|pay|paying|order|checkout|confirm|uninstall|format|wipe|overwrite|discard|unsubscribe|deactivate|close account|delete account)\b/i;

// Speech that means "you are in a secret field, do not type."
const SECURE_FIELD = /\b(password|passcode|\bpin\b|secure field|protected|protected edit|security code|passphrase)\b/i;

// Keys that ACTIVATE/commit something (vs. keys that only move focus). A
// destructive-shaped intent only needs a confirm when the step actually
// commits — so moving focus TO a button named "Publish" is free, pressing
// Enter ON it is gated.
const ACTIVATION = new Set(['enter', 'return', 'space', 'spacebar']);

class Safety {
  constructor(opts = {}) {
    // Hard no-go chords (normalized). NVDA+Q is mandatory and cannot be removed.
    this.noGo = new Set(['nvda+q', 'insert+q', 'capslock+q']);
    for (const c of opts.extraNoGo || []) this.noGo.add(String(c).toLowerCase());
    // Chords that always require confirmation regardless of stated intent.
    this.confirmChords = new Set(['alt+f4', 'control+w', 'control+shift+w', 'alt+f4 ']);
    for (const c of opts.extraConfirmChords || []) this.confirmChords.add(String(c).toLowerCase());

    this.minKeyIntervalMs = opts.minKeyIntervalMs != null ? opts.minKeyIntervalMs : 45;
    this.maxActionsPerMinute = opts.maxActionsPerMinute != null ? opts.maxActionsPerMinute : 90;
    this.nvdaKey = opts.nvdaKey || 'insert';

    this._lastKeyAt = 0;
    this._actionTimes = [];
  }

  /** Is this chord on the hard no-go list? Checks both the normalized string
   *  and the resolved vk codes (so "insert+q" and "nvda+q" both trip even if
   *  spelled differently). Returns {blocked, reason}. */
  checkNoGo(chord) {
    const norm = normalizeChord(chord);
    if (this.noGo.has(norm)) return { blocked: true, reason: `no-go chord: ${norm}` };
    const parsed = parseChord(chord, { nvdaKey: this.nvdaKey });
    if (parsed && parsed.main.vk === VK_Q) {
      const heldVks = parsed.modifiers.map((m) => m.vk);
      if (heldVks.includes(VK_INSERT) || heldVks.includes(VK_CAPSLOCK)) {
        return { blocked: true, reason: 'no-go: quitting the screen reader (NVDA+Q)' };
      }
    }
    return { blocked: false };
  }

  /** Does this chord need explicit confirmation before it fires? */
  chordNeedsConfirm(chord) {
    return this.confirmChords.has(normalizeChord(chord));
  }

  /** Does this plan's stated intent look destructive? */
  intentNeedsConfirm(plan) {
    const text = [plan && plan.intent, plan && plan.why, plan && plan.text].filter(Boolean).join(' ');
    return DESTRUCTIVE.test(text);
  }

  /** Combined confirm gate for a plan. A chord on the confirm list (alt+f4…)
   *  always gates. A destructive-shaped INTENT gates only when the step
   *  actually commits: any type_text, or send_keys that include an activating
   *  key (Enter/Space). Pure navigation never gates on intent alone, so moving
   *  focus to a "Publish" button is free while pressing it is not. */
  needsConfirm(plan) {
    if (!plan) return false;
    const chords = plan.action === 'send_keys' ? (plan.keys || (plan.chord ? [plan.chord] : [])) : [];
    if (chords.some((c) => this.chordNeedsConfirm(c))) return true;
    if (!this.intentNeedsConfirm(plan)) return false;
    if (plan.action === 'type_text') return true;
    if (plan.action === 'send_keys') return chords.some((c) => ACTIVATION.has(normalizeChord(c)));
    return false;
  }

  /** Is it safe to type right now? Reads the recent speech for a secure field.
   *  recentLines: array of the last spoken strings (from observer.recent()). */
  canType(recentLines) {
    const tail = (recentLines || []).slice(-4).join(' ');
    if (SECURE_FIELD.test(tail)) {
      return { ok: false, reason: 'secure/password field announced — refusing to type' };
    }
    return { ok: true };
  }

  /** Throttle to human pace. Resolves after enforcing min spacing; throws a
   *  RunawayError if the per-minute ceiling is exceeded (a true runaway must
   *  abort, not merely slow). */
  async gateKey() {
    const now = Date.now();
    // Per-minute ceiling
    this._actionTimes = this._actionTimes.filter((t) => now - t < 60000);
    if (this._actionTimes.length >= this.maxActionsPerMinute) {
      const err = new Error(`runaway: >${this.maxActionsPerMinute} key events/min — aborting`);
      err.code = 'RUNAWAY';
      throw err;
    }
    // Min spacing
    const wait = this._lastKeyAt + this.minKeyIntervalMs - now;
    if (wait > 0) await sleep(wait);
    this._lastKeyAt = Date.now();
    this._actionTimes.push(this._lastKeyAt);
  }
}

function normalizeChord(chord) {
  return String(chord)
    .toLowerCase()
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('+');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { Safety, DESTRUCTIVE, SECURE_FIELD, normalizeChord };
