'use strict';
/**
 * Vision describer — turns a screenshot into a short textual reading the driver
 * can treat like one more spoken line ("VISION: a Publish button, centered,
 * focused"). Uses the router's 'vision' tier (k2.6 — verified: DeepSeek's chat
 * API rejects images, k2.6 reads them). Only called when the cheap accessible
 * layers (speech, UIA) came up empty, so the per-look cost is paid rarely.
 *
 * Honest cost note: a tiny test image was ~90 tokens, but a real full-screen
 * capture is thousands — 10–30x a speech step. That's why it's the last rung.
 */

const DEFAULT_Q = 'You are the eyes for a blind user\'s screen-reader agent. Look at this screenshot of the foreground window and describe it concisely for someone who navigates by keyboard: name the key controls and their labels, and say which one appears focused or selected. Under 60 words, no preamble.';

function makeVisionDescriber(router, opts = {}) {
  const question = opts.question || DEFAULT_Q;
  const maxTokens = opts.maxTokens || 120;
  return async function describe(image, extra) {
    const url = String(image).startsWith('data:') ? String(image) : 'data:image/png;base64,' + image;
    const content = [
      { type: 'text', text: extra ? `${question}\nContext: ${extra}` : question },
      { type: 'image_url', image_url: { url } },
    ];
    const out = await router.chat('vision', [{ role: 'user', content }], { maxTokens });
    return (out.text || '').trim();
  };
}

module.exports = { makeVisionDescriber, DEFAULT_Q };
