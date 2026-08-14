'use strict';
/**
 * Fake NVDA — a scriptable stand-in for the controlled machine, so the whole
 * pipe can be proven with NO real PC involved (roadmap: "her PC not involved
 * yet"). It joins the relay in the SLAVE role, reconstructs chords from the
 * incoming key up/down stream, handles set_clipboard_text + paste, and SPEAKS
 * scripted lines back the way a real screen reader would after each action.
 *
 * The scenario logic is injected as react(event, api) so this file stays a
 * generic simulator; the App-Store-rescue script lives in loopback.js.
 */

const { NvdaRemoteClient } = require('./client.js');

const MOD_NAME = { 0x10: 'shift', 0x11: 'control', 0x12: 'alt', 0x5b: 'win', 0x5c: 'win', 0x14: 'capslock', 0x2d: 'nvda' };
const MODIFIER_VKS = new Set([0x10, 0x11, 0x12, 0x5b, 0x5c, 0x14, 0x2d]);

const NAMED_REV = {
  0x0d: 'enter', 0x09: 'tab', 0x1b: 'escape', 0x20: 'space', 0x08: 'backspace',
  0x2e: 'delete', 0x24: 'home', 0x23: 'end', 0x21: 'pageup', 0x22: 'pagedown',
  0x25: 'left', 0x26: 'up', 0x27: 'right', 0x28: 'down',
};
for (let i = 1; i <= 12; i++) NAMED_REV[0x6f + i] = 'f' + i;

function vkName(vk) {
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk + 32); // A-Z -> a-z
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);      // 0-9
  if (NAMED_REV[vk]) return NAMED_REV[vk];
  if (MOD_NAME[vk]) return MOD_NAME[vk];
  return 'vk_' + vk.toString(16);
}

class FakeNvda {
  constructor(opts) {
    this.opts = opts;
    this.react = opts.react || (() => {});
    this.speakDelayMs = opts.speakDelayMs != null ? opts.speakDelayMs : 50;
    this.held = new Set();
    this.clipboard = '';
    this.client = null;
    this.log = opts.log || (() => {});
  }

  async start() {
    this.client = new NvdaRemoteClient({
      host: this.opts.host, port: this.opts.port, key: this.opts.key, role: 'slave',
      onSpeak: () => {},                         // slave ignores its own kind
      onEvent: (m) => this._onEvent(m),
    });
    await this.client.connect();
    // Announce the starting screen once the channel is up.
    setTimeout(() => this._dispatch({ type: 'connect' }), 200);
  }

  _onEvent(m) {
    if (m.type === 'key') return this._onKey(m);
    if (m.type === 'set_clipboard_text') { this.clipboard = m.text || ''; this.log('clipboard set:', this.clipboard); return; }
    // channel_joined / client_joined / etc. — ignore
  }

  _onKey(m) {
    const vk = m.vk_code;
    if (m.pressed) {
      if (MODIFIER_VKS.has(vk)) { this.held.add(vk); return; }
      // a main key with the currently-held modifiers = one chord
      const mods = [...this.held].map((v) => MOD_NAME[v]).filter(Boolean);
      const chord = [...new Set(mods), vkName(vk)].join('+');
      this._onChord(chord);
    } else {
      this.held.delete(vk);
    }
  }

  _onChord(chord) {
    this.log('chord:', chord);
    if (chord === 'control+v') { this._dispatch({ type: 'paste', text: this.clipboard }); return; }
    this._dispatch({ type: 'key', chord });
  }

  _dispatch(event) {
    const api = {
      speak: (text) => this._speak(text),
      speakAll: (arr) => arr.forEach((t, i) => setTimeout(() => this._speak(t), this.speakDelayMs * (i + 1))),
    };
    Promise.resolve(this.react(event, api)).catch(() => {});
  }

  _speak(text) {
    if (!text) return;
    this.log('SPEAK ->', text);
    this.client.sendSpeak(text);
  }

  close() { if (this.client) this.client.close(); }
}

module.exports = { FakeNvda, vkName };
