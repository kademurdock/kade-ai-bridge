'use strict';
/* Nov 10 2026 (bug sweep). THE TWILIO WEBHOOK GATE.
 *
 * The routes Twilio calls (/sms, /voice and everything under it, /voice-ws, /voice-ws-outbound,
 * /voice-status, /recording-status) answered anyone who knew the address. A forged POST /sms with any
 * From and Body ran a paid model turn and paid speech each time, with no limit; a forged /voice made
 * call state and /voice/continue looped model and speech on it. Only /amd-status (log only, July 13)
 * and the welcome-call TwiML checked Twilio's signature.
 *
 * Twilio signs every webhook (X-Twilio-Signature: HMAC of the full URL plus the sorted form fields,
 * keyed with the account's auth token). This checks it in one place, with a switch, because a URL
 * that is rebuilt wrongly would refuse every real call and text:
 *
 *   TWILIO_WEBHOOK_GATE=off      no check at all
 *   TWILIO_WEBHOOK_GATE=log      (default) check, let everything through, log each mismatch
 *   TWILIO_WEBHOOK_GATE=enforce  a request whose signature does not match is answered 403
 *
 * Shipped in `log`: behaviour does not change. Read the bridge log for `[twilio-gate]` lines over a
 * few days of real calls and texts. No `mismatch` line on real traffic means the URL is rebuilt right,
 * and `enforce` is then one Railway variable. With no TWILIO_AUTH_TOKEN the gate stands down in every
 * mode (nothing to check against), and says so once.
 *
 * The log line names the route and the mode. Never the body, the number or the signature.
 */
const MODES = new Set(['off', 'log', 'enforce']);
const LOG_WINDOW_MS = 10 * 60 * 1000;
const LOG_PER_WINDOW = 20;

function gateMode(env = process.env) {
  const asked = String(env.TWILIO_WEBHOOK_GATE || '').trim().toLowerCase();
  return MODES.has(asked) ? asked : 'log';
}

/** The route as a log may show it: no query string, and the call id in the path replaced. */
function routeLabel(originalUrl) {
  return String(originalUrl || '').split('?')[0].replace(/\/(CA|MG|SM)[0-9a-fA-F]{8,}/g, '/<sid>').slice(0, 80);
}

function createTwilioGate({ token, publicUrl, validateRequest, mode = gateMode(), log = console, now = () => Date.now() }) {
  const base = String(publicUrl || '').replace(/\/$/, '');
  const seen = { ok: 0, mismatch: 0, refused: 0, windowStart: now(), logged: 0, saidNoToken: false };
  function say(line) {
    if (now() - seen.windowStart > LOG_WINDOW_MS) {
      seen.windowStart = now();
      seen.logged = 0;
    }
    if (seen.logged < LOG_PER_WINDOW) {
      seen.logged += 1;
      log.warn(line);
    }
  }
  function middleware(req, res, next) {
    if (mode === 'off') return next();
    if (!token || typeof validateRequest !== 'function') {
      if (!seen.saidNoToken) {
        seen.saidNoToken = true;
        log.warn('[twilio-gate] no TWILIO_AUTH_TOKEN: webhook signatures cannot be checked, every request passes');
      }
      return next();
    }
    let ok = false;
    try {
      const signature = (req.get && req.get('X-Twilio-Signature')) || '';
      ok = !!signature && validateRequest(token, signature, base + req.originalUrl, req.body || {}) === true;
    } catch (e) {
      ok = false;
    }
    if (ok) {
      seen.ok += 1;
      return next();
    }
    seen.mismatch += 1;
    const route = routeLabel(req.originalUrl);
    if (mode === 'enforce') {
      seen.refused += 1;
      say(`[twilio-gate] refused ${req.method} ${route}: signature mismatch (mode enforce)`);
      return res.status(403).type('text/plain').send('Forbidden');
    }
    say(`[twilio-gate] mismatch on ${req.method} ${route} (mode log: let through). On a real Twilio call this means the public URL is rebuilt wrongly; fix that before enforce.`);
    return next();
  }
  middleware.stats = () => ({ mode, ok: seen.ok, mismatch: seen.mismatch, refused: seen.refused });
  return middleware;
}

/** Every path Twilio posts to. `/voice` covers /voice/continue/<sid> and the rest under it. */
const TWILIO_PATHS = ['/sms', '/voice', '/voice-ws', '/voice-ws-outbound', '/voice-status', '/recording-status'];

module.exports = { createTwilioGate, gateMode, routeLabel, TWILIO_PATHS };
