'use strict';
/**
 * Perception — how the agent knows what's on screen. The honest answer to
 * "NVDA or screenshots?" is: BOTH, in a cheap-to-expensive ladder, NVDA first.
 *
 *   SOURCE 1 — NVDA SPEECH (live now). What she actually hears: the ground
 *     truth of the accessible experience, compact text, near-free. The catch is
 *     it's a KEYHOLE — it speaks what's focused/navigated, not the whole screen
 *     at once. Great for "what am I on"; weak for "what else is here".
 *
 *   SOURCE 2 — UIA TREE (stub; the keyhole-breaker). Windows UI Automation
 *     exposes the WHOLE accessibility tree — every control, label, and state —
 *     not just focus, and still as cheap text, no pixels. This is the "see the
 *     whole page" win without paying for vision. Runs on the PC side
 *     (pc-companion), returns a flattened tree.
 *
 *   SOURCE 3 — SCREENSHOT + VISION (stub; last resort). For apps with no
 *     accessibility at all (canvas, unlabeled images, some games/installers), a
 *     screenshot read by a multimodal model. Most capable, most expensive, and
 *     NOT the accessible path — so it's the fallback, gated behind the cheaper
 *     two. Both k2.6 and deepseek-v4-pro can read images, so it rides a pot you
 *     already fund.
 *
 * The escalation rule keeps money sane: try speech; if speech is uninformative
 * (blank/unlabeled/repeating), climb to UIA; only if that's unavailable or also
 * blank, climb to vision. Each higher rung is opt-in and wired separately.
 */

const UNINFORMATIVE = /\b(blank|unknown|unlabel|no name|not named|graphic|image|clickable|button)\b/i;

class Perception {
  constructor(opts = {}) {
    this.observer = opts.observer;         // NVDA speech source (required)
    this.uiaSource = opts.uiaSource || null;   // async () => flattened tree text
    this.visionSource = opts.visionSource || null; // async () => { image | b64 }
    this.describeImage = opts.describeImage || null; // async (image) => text (vision.js)
    this.recorder = opts.recorder || null;
  }

  /** The cheap default: what NVDA just said. */
  speech(n = 15) { return this.observer ? this.observer.recent(n) : []; }

  /** Does the recent speech look too thin to act on confidently? */
  isThin(lines) {
    const tail = (lines || this.speech(4)).slice(-3);
    if (!tail.length) return true;
    const joined = tail.join(' ').trim();
    if (joined.length < 4) return true;
    // repeated identical lines, or a label-less control announcement
    if (tail.length >= 2 && tail[tail.length - 1] === tail[tail.length - 2]) return true;
    if (UNINFORMATIVE.test(joined) && joined.split(' ').length <= 3) return true;
    return false;
  }

  /**
   * Get the best available reading, climbing the ladder only as needed.
   * opts.allowUia / opts.allowVision gate the paid/experimental rungs.
   */
  async read(opts = {}) {
    const speech = this.speech(opts.n || 15);
    if (!this.isThin(speech) || (!opts.allowUia && !opts.allowVision)) {
      return { source: 'nvda', lines: speech };
    }
    if (opts.allowUia && this.uiaSource) {
      try {
        const tree = await this.uiaSource();
        if (tree && tree.trim()) { this._log('uia'); return { source: 'uia', lines: speech, tree }; }
      } catch (e) { this._log('uia-error', e.message); }
    }
    if (opts.allowVision && this.visionSource) {
      try {
        const shot = await this.visionSource();
        const img = shot && (shot.image || shot.b64);
        if (img) {
          let visionText = shot.hint || null;
          if (this.describeImage) visionText = await this.describeImage(img);
          this._log('vision');
          const lines = visionText ? [...speech, 'VISION: ' + visionText] : speech;
          return { source: 'vision', lines, image: img, visionText };
        }
      } catch (e) { this._log('vision-error', e.message); }
    }
    return { source: 'nvda', lines: speech };
  }

  _log(kind, detail) { if (this.recorder) this.recorder.note('perception:' + kind, detail ? { detail } : {}); }
}

/** Placeholder UIA source. Real one lives on the PC side (pc-companion): walk
 *  the UI Automation tree of the foreground window, flatten to labeled lines. */
function stubUiaSource() {
  return async () => { throw new Error('UIA source not wired — build on pc-companion (UI Automation tree walk)'); };
}

/** Placeholder vision source. Real one captures the foreground window and hands
 *  the bytes to a multimodal tier (k2.6 / deepseek-v4-pro). */
function stubVisionSource() {
  return async () => { throw new Error('vision source not wired — capture screenshot on pc-companion, read via vision tier'); };
}

module.exports = { Perception, stubUiaSource, stubVisionSource };
