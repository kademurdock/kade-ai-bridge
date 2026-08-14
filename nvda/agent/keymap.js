'use strict';
/**
 * Windows virtual-key map + chord parser for the NVDA Remote `key` message.
 *
 * A `key` message on the wire is:
 *   {type:'key', vk_code:N, extended:bool, pressed:bool, scan_code:null}
 * A keypress is TWO messages (pressed:true then pressed:false). A chord such
 * as "control+l" is: ctrl down, L down, L up, ctrl up. The `extended` flag is
 * true for the nav cluster and arrows (the right-hand duplicates on a 101-key
 * layout) — NVDA/Windows cares, so we bake it into the table, read from the
 * documented USB HID / Win32 VK constants, not guessed per key.
 */

// Virtual-key codes (Win32 VK_*). extended:true where the physical key is the
// "grey" nav-cluster / arrow / right-modifier variant.
const NAMED = {
  enter: { vk: 0x0d }, return: { vk: 0x0d },
  tab: { vk: 0x09 },
  escape: { vk: 0x1b }, esc: { vk: 0x1b },
  space: { vk: 0x20 }, spacebar: { vk: 0x20 },
  backspace: { vk: 0x08 },
  delete: { vk: 0x2e, extended: true }, del: { vk: 0x2e, extended: true },
  insert: { vk: 0x2d, extended: true }, ins: { vk: 0x2d, extended: true },
  home: { vk: 0x24, extended: true },
  end: { vk: 0x23, extended: true },
  pageup: { vk: 0x21, extended: true }, pgup: { vk: 0x21, extended: true },
  pagedown: { vk: 0x22, extended: true }, pgdn: { vk: 0x22, extended: true },
  left: { vk: 0x25, extended: true }, leftarrow: { vk: 0x25, extended: true },
  up: { vk: 0x26, extended: true }, uparrow: { vk: 0x26, extended: true },
  right: { vk: 0x27, extended: true }, rightarrow: { vk: 0x27, extended: true },
  down: { vk: 0x28, extended: true }, downarrow: { vk: 0x28, extended: true },
  // modifiers
  shift: { vk: 0x10 },
  ctrl: { vk: 0x11 }, control: { vk: 0x11 },
  alt: { vk: 0x12 }, menu: { vk: 0x12 },
  win: { vk: 0x5b }, windows: { vk: 0x5b }, lwin: { vk: 0x5b },
  rwin: { vk: 0x5c, extended: true },
  applications: { vk: 0x5d, extended: true }, apps: { vk: 0x5d, extended: true },
  capslock: { vk: 0x14 },
  // NVDA modifier: laptop layout is CapsLock, desktop is Insert. Default to the
  // Insert form because that is what the desktop keymap and most guides assume;
  // override with agent option nvdaKey:'capslock' for laptop layout.
  nvda: { vk: 0x2d, extended: true },
  printscreen: { vk: 0x2c, extended: true },
};

for (let i = 1; i <= 12; i++) NAMED['f' + i] = { vk: 0x6f + i }; // F1..F12 = 0x70..0x7B

const MODIFIER_VKS = new Set([0x10, 0x11, 0x12, 0x5b, 0x5c, 0x14]);

/** Resolve one token ("a", "5", "enter", "left") to {vk, extended}. */
function resolveKey(tokenRaw, opts = {}) {
  const token = String(tokenRaw).trim().toLowerCase();
  if (token.length === 1) {
    const c = token.charCodeAt(0);
    if (c >= 97 && c <= 122) return { vk: c - 32 }; // a-z -> 0x41-0x5A
    if (c >= 48 && c <= 57) return { vk: c }; // 0-9 -> 0x30-0x39
  }
  if (token === 'nvda' && opts.nvdaKey === 'capslock') return { vk: 0x14 };
  if (NAMED[token]) return { ...NAMED[token] };
  return null;
}

/**
 * Parse "control+shift+t" into ordered modifiers + a main key.
 * Returns {modifiers:[{vk,extended}], main:{vk,extended}, raw} or null.
 */
function parseChord(chord, opts = {}) {
  const parts = String(chord).split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const modifiers = [];
  let main = null;
  for (const p of parts) {
    const k = resolveKey(p, opts);
    if (!k) return null;
    if (MODIFIER_VKS.has(k.vk) && parts.length > 1 && p !== parts[parts.length - 1]) {
      modifiers.push(k);
    } else if (!main) {
      main = k;
    } else {
      // second non-modifier — treat the earlier one as a modifier-ish hold
      modifiers.push(main);
      main = k;
    }
  }
  if (!main) return null;
  return { modifiers, main, raw: String(chord) };
}

/** Expand a chord to the ordered list of key messages (down…down, up…up). */
function chordToKeyEvents(chord, opts = {}) {
  const parsed = parseChord(chord, opts);
  if (!parsed) return null;
  const seq = [];
  for (const m of parsed.modifiers) seq.push({ vk_code: m.vk, extended: !!m.extended, pressed: true, scan_code: null });
  seq.push({ vk_code: parsed.main.vk, extended: !!parsed.main.extended, pressed: true, scan_code: null });
  seq.push({ vk_code: parsed.main.vk, extended: !!parsed.main.extended, pressed: false, scan_code: null });
  for (let i = parsed.modifiers.length - 1; i >= 0; i--) {
    const m = parsed.modifiers[i];
    seq.push({ vk_code: m.vk, extended: !!m.extended, pressed: false, scan_code: null });
  }
  return seq;
}

module.exports = { NAMED, MODIFIER_VKS, resolveKey, parseChord, chordToKeyEvents };
