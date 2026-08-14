'use strict';
/**
 * Actions — the agent's hands. Turns high-level verbs into the NVDA Remote
 * `key` / `set_clipboard_text` wire messages, gated by the safety rails.
 *
 * Verbs (the world's verbs are screen-reader idioms):
 *   send_keys(chords)  — navigation & commands: tab, arrows, "h" for next
 *                        heading, "b" for next button, control+l for the URL bar.
 *   type_text(text)    — robust text entry via set_clipboard_text + Ctrl+V, so
 *                        arbitrary characters land without per-key vk juggling;
 *                        refused outright over a password/secure field.
 *   wait(ms) / say(text)
 *
 * Every hand-movement is rate-limited to human pace and written to the recorder
 * before the outcome is heard back through the observer.
 */

const { chordToKeyEvents } = require('./keymap');

class NoGoError extends Error { constructor(m) { super(m); this.code = 'NOGO'; } }
class SecureFieldError extends Error { constructor(m) { super(m); this.code = 'SECURE'; } }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class Actions {
  constructor(opts) {
    this.client = opts.client;         // has .send({...})
    this.observer = opts.observer;
    this.safety = opts.safety;
    this.recorder = opts.recorder;
    this.nvdaKey = opts.nvdaKey || 'insert';
    this.clipboardSettleMs = opts.clipboardSettleMs != null ? opts.clipboardSettleMs : 120;
  }

  async sendChord(chord, meta = {}) {
    const nogo = this.safety.checkNoGo(chord);
    if (nogo.blocked) {
      this.recorder.blocked(nogo.reason, { chord });
      throw new NoGoError(nogo.reason);
    }
    const events = chordToKeyEvents(chord, { nvdaKey: this.nvdaKey });
    if (!events) throw new Error(`unknown chord: ${chord}`);
    for (const e of events) {
      await this.safety.gateKey();              // human-pace throttle + runaway ceiling
      this.client.send({ type: 'key', ...e });
    }
    this.recorder.action('send_keys', { chord, intent: meta.intent || '' });
  }

  async typeText(text, meta = {}) {
    const gate = this.safety.canType(this.observer.recent());
    if (!gate.ok) {
      this.recorder.blocked(gate.reason, { chars: String(text).length });
      throw new SecureFieldError(gate.reason);
    }
    // Robust arbitrary-text entry: put it on the controlled machine's clipboard,
    // then paste. (NVDA Remote carries set_clipboard_text for exactly this.)
    this.client.send({ type: 'set_clipboard_text', text: String(text) });
    await sleep(this.clipboardSettleMs);
    await this.sendChord('control+v', { intent: meta.intent || 'paste text' });
    this.recorder.action('type_text', { text: String(text), intent: meta.intent || '' });
  }

  /** Execute a validated plan. Confirm gating happens in the brain BEFORE this. */
  async perform(plan) {
    switch (plan.action) {
      case 'send_keys': {
        const chords = plan.keys || (plan.chord ? [plan.chord] : []);
        for (const chord of chords) await this.sendChord(chord, { intent: plan.intent });
        return {};
      }
      case 'type_text':
        await this.typeText(plan.text, { intent: plan.intent });
        return {};
      case 'wait':
        await sleep(plan.ms || 500);
        return {};
      case 'say':
        this.recorder.note(plan.text || plan.intent || '', { spoken: true });
        return {};
      case 'done':
        this.recorder.note(plan.summary || plan.intent || 'done', { done: true });
        return { done: true };
      default:
        this.recorder.note('unknown action', { plan });
        return {};
    }
  }
}

module.exports = { Actions, NoGoError, SecureFieldError };
