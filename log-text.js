'use strict';
/* Nov 13 2026 (sweep 8.6): chat words stay out of the logs.
 *
 * Several log lines quoted the person's message or the reply (the last 90 characters of what she
 * typed, the excerpt the think router read, the phrase the parrot guard matched). The platform asks
 * its model hosts for zero retention of those words, and the same words were sitting in the log
 * store. A log line now carries a receipt instead: the length and a short hash, which is enough to
 * tell two turns apart or to match a line to a known message.
 *
 * KADE_LOG_TEXT=1 puts the words back, for the hours spent chasing one bug. Read on every call, so
 * a redeploy with the variable set is all it takes. */
const crypto = require('node:crypto');

const logTextOn = (env = process.env) => String(env.KADE_LOG_TEXT ?? '0') === '1';

/* `text` is what the line used to print. `whole` (optional) is the full string it was cut from, so
 * the hash names the message and not the cut. */
function textReceipt(text, whole, env = process.env) {
  const shown = String(text ?? '');
  if (logTextOn(env)) return JSON.stringify(shown);
  const full = String(whole ?? shown);
  return `(${full.length} chars, sha ${crypto.createHash('sha1').update(full).digest('hex').slice(0, 8)})`;
}

module.exports = { logTextOn, textReceipt };
