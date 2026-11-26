'use strict';
/* Nov 26 2026 (lockdown). POST /signup used to be open: anyone on the internet could save any phone
 * number with any name, and the bridge then greeted that number by name. That is how the fake
 * "AuditProbe" rows got in. This file decides who may use it now.
 *
 * Who really uses /signup (checked Nov 26 2026):
 *   - The LibreChat site, server to server, after a new site account is made (AuthController.js)
 *     and after Kade approves an access request (admin/accessRequests.js). The site already holds
 *     BRIDGE_SECRET, so it sends that in the x-bridge-secret header.
 *   - Nobody else. The iPhone and Android apps never call it, and no text, email or page links to
 *     the browser form. Phone callers are registered by the spoken setup on the call itself, and
 *     Kade can add anyone with the admin /register route.
 *
 * So a post is let in when any one of these holds:
 *   1. It carries the bridge secret (header x-bridge-secret, or "secret" in the body), the same
 *      check every admin route uses.
 *   2. BRIDGE_SIGNUP_CODE is set and the post carries that code in "code". The browser form shows
 *      a code box for this. The code is compared in constant time. Without the variable the form
 *      is closed and says so in plain words.
 *   3. BRIDGE_SIGNUP_OPEN is 1, on, true or yes. That is the kill switch: it brings back the old
 *      open form exactly as it was. Use it only if the lock breaks something real.
 *
 * Guessing the code is slowed down two ways: 5 code tries per address every 15 minutes, and 30
 * wrong codes from everyone together in an hour, after which the code is refused for the rest of
 * that hour. The address is a best guess (the last X-Forwarded-For entry, which Railway's edge adds),
 * so the shared cap is what really stops guessing from many made-up addresses. Posts that carry the
 * bridge secret are never slowed down.
 *
 * Nothing here logs the code, the secret or a phone number.
 */
const crypto = require('crypto');

const TRUE_WORDS = ['1', 'on', 'true', 'yes'];

function signupGateConfig(env = process.env) {
  return {
    open: TRUE_WORDS.includes(String(env.BRIDGE_SIGNUP_OPEN || '').trim().toLowerCase()),
    code: String(env.BRIDGE_SIGNUP_CODE || '').trim(),
  };
}

/* Constant-time compare. Both sides are hashed first so their lengths always match, which
 * timingSafeEqual needs. An empty expected value never matches anything. */
function sameCode(given, expected) {
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(given == null ? '' : given).trim()).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function requestAddress(req) {
  const fwd = String((req.headers && req.headers['x-forwarded-for']) || '');
  const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length) return parts[parts.length - 1];
  return String((req.socket && req.socket.remoteAddress) || req.ip || 'unknown');
}

const CLOSED_MESSAGE = 'This form is closed. Your phone is added when you make your account on the Kade AI site, or Kade can add it for you.';
const NO_CODE_MESSAGE = 'Enter the signup code. Ask Kade for it.';
const WRONG_CODE_MESSAGE = 'That signup code is not right. Ask Kade for the current code.';
const SLOW_DOWN_MESSAGE = 'Too many tries. Wait a while, then try again.';

function createSignupGate({
  config = signupGateConfig(),
  secretOk,
  now = Date.now,
  perAddressTries = 5,
  perAddressWindowMs = 15 * 60 * 1000,
  wrongCodeCap = 30,
  wrongCodeWindowMs = 60 * 60 * 1000,
} = {}) {
  if (typeof secretOk !== 'function') throw new Error('createSignupGate needs secretOk');
  const tries = new Map(); // address -> { since, count }
  let wrong = { since: 0, count: 0 };
  const counts = { secret: 0, code: 0, open: 0, closed: 0, noCode: 0, wrongCode: 0, slowed: 0 };

  function prune(t) {
    if (tries.size < 1000) return;
    for (const [addr, e] of tries) if (t - e.since >= perAddressWindowMs) tries.delete(addr);
  }

  function check(req) {
    const body = (req && req.body) || {};
    if (secretOk(req, body.secret)) { counts.secret++; return { ok: true, via: 'secret' }; }
    if (config.open) { counts.open++; return { ok: true, via: 'open' }; }
    if (!config.code) { counts.closed++; return { ok: false, status: 403, error: CLOSED_MESSAGE }; }

    const t = now();
    if (t - wrong.since >= wrongCodeWindowMs) wrong = { since: t, count: 0 };
    prune(t);
    const addr = requestAddress(req);
    let e = tries.get(addr);
    if (!e || t - e.since >= perAddressWindowMs) { e = { since: t, count: 0 }; tries.set(addr, e); }
    if (e.count >= perAddressTries || wrong.count >= wrongCodeCap) {
      counts.slowed++;
      return { ok: false, status: 429, error: SLOW_DOWN_MESSAGE };
    }
    e.count++;
    const given = String(body.code == null ? '' : body.code).trim();
    if (!given) { counts.noCode++; return { ok: false, status: 403, error: NO_CODE_MESSAGE }; }
    if (sameCode(given, config.code)) { counts.code++; return { ok: true, via: 'code' }; }
    wrong.count++;
    counts.wrongCode++;
    return { ok: false, status: 403, error: WRONG_CODE_MESSAGE };
  }

  /* How many posts were turned away, for capping the log line in server.js. */
  const refused = () => counts.closed + counts.noCode + counts.wrongCode + counts.slowed;
  return { check, stats: () => ({ ...counts }), refused, formOpen: () => config.open || !!config.code };
}

function signupStartupLine(config = signupGateConfig()) {
  if (config.open) return '[signup] BRIDGE_SIGNUP_OPEN is on: the /signup form is OPEN to anyone, as before Nov 26 2026. Turn it off once the problem is fixed.';
  if (config.code) return '[signup] /signup takes the bridge secret, or the signup code from BRIDGE_SIGNUP_CODE';
  return '[signup] /signup takes the bridge secret only; the browser form is closed';
}

module.exports = {
  signupGateConfig, sameCode, requestAddress, createSignupGate, signupStartupLine,
  CLOSED_MESSAGE, NO_CODE_MESSAGE, WRONG_CODE_MESSAGE, SLOW_DOWN_MESSAGE,
};
