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
 * Nov 10 2026 (independent review), three things the first version left unclear:
 *   - A request with NO X-Twilio-Signature header is not Twilio at all (a scanner, a bot). It used to
 *     log the same `mismatch` line as a real Twilio request whose URL was rebuilt wrongly, so one
 *     stray probe during the watch read as "do not enforce". It now logs `[twilio-gate] unsigned`
 *     and is counted apart. ONLY a `mismatch` line (a signature WAS sent and did not check out) is a
 *     reason to hold off on enforce. Each kind has its own log budget, so a flood of unsigned probes
 *     cannot use up the lines a real mismatch needs.
 *   - `enforce` with no token still lets everything through (failing closed would cut every real
 *     call if the variable were lost in a rotation; that trade is the owner's to make). What changed
 *     is that it no longer claims to be enforcing: the startup line and the stand-down line say
 *     NOT CHECKING in plain words. Look for that after any token change.
 *   - The signed address is PUBLIC_URL (https:// + RAILWAY_PUBLIC_DOMAIN) + the request path.
 *     Forwarded host headers are deliberately NOT read (a caller could then pick the signed host).
 *     So `enforce` is only right while every webhook address in the Twilio console (the number's
 *     SMS and Voice URLs) uses that Railway host. Most TwiML action addresses in server.js are
 *     relative, so Twilio resolves them against the console's host: point the console at a custom
 *     domain and every mid-call step would mismatch. The log-mode watch shows that case as
 *     `mismatch` lines.
 *
 * The log line names the route, the mode and whether a signature header came. Never the body, the
 * number or the signature itself.
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
  const seen = { ok: 0, mismatch: 0, unsigned: 0, refused: 0, unchecked: 0, windowStart: now(), logged: { mismatch: 0, unsigned: 0 }, saidNoToken: false };
  // `kind` is 'mismatch' or 'unsigned': each has its own budget of lines per window.
  function say(kind, line) {
    if (now() - seen.windowStart > LOG_WINDOW_MS) {
      seen.windowStart = now();
      seen.logged = { mismatch: 0, unsigned: 0 };
    }
    if (seen.logged[kind] < LOG_PER_WINDOW) {
      seen.logged[kind] += 1;
      log.warn(line);
    }
  }
  function middleware(req, res, next) {
    if (mode === 'off') return next();
    if (!token || typeof validateRequest !== 'function') {
      seen.unchecked += 1;
      if (!seen.saidNoToken) {
        seen.saidNoToken = true;
        log.warn('[twilio-gate] no TWILIO_AUTH_TOKEN: webhook signatures cannot be checked, every request passes'
          + (mode === 'enforce' ? ' (mode is enforce but it is NOT CHECKING and refuses nothing)' : ''));
      }
      return next();
    }
    let ok = false;
    let hasSignature = false;
    try {
      const signature = (req.get && req.get('X-Twilio-Signature')) || '';
      hasSignature = !!signature;
      ok = hasSignature && validateRequest(token, signature, base + req.originalUrl, req.body || {}) === true;
    } catch (e) {
      ok = false;
    }
    if (ok) {
      seen.ok += 1;
      // Nov 10 2026: a later handler may need to know this request is proven Twilio's (the call
      // socket ticket in /voice-ws is only self-sufficient when it is). Set on success only.
      req.twilioSignatureOk = true;
      return next();
    }
    // The pass / refuse decision is the same for both; only the count and the words differ.
    const kind = hasSignature ? 'mismatch' : 'unsigned';
    seen[kind] += 1;
    const route = routeLabel(req.originalUrl);
    if (mode === 'enforce') {
      seen.refused += 1;
      say(kind, hasSignature
        ? `[twilio-gate] refused ${req.method} ${route}: signature mismatch, signature header: yes (mode enforce)`
        : `[twilio-gate] refused unsigned ${req.method} ${route}: signature header: no (mode enforce)`);
      return res.status(403).type('text/plain').send('Forbidden');
    }
    say(kind, hasSignature
      ? `[twilio-gate] mismatch on ${req.method} ${route}, signature header: yes (mode log: let through). A signature was sent and did not check out: on a real Twilio call this means the public URL is rebuilt wrongly; fix that before enforce.`
      : `[twilio-gate] unsigned ${req.method} ${route}, signature header: no (mode log: let through). Not a Twilio request (Twilio always signs); this is what enforce would refuse, and it is no reason to hold off.`);
    return next();
  }
  middleware.stats = () => ({ mode, ok: seen.ok, mismatch: seen.mismatch, unsigned: seen.unsigned, refused: seen.refused, unchecked: seen.unchecked });
  return middleware;
}

/** Every path Twilio posts to. `/voice` covers /voice/continue/<sid> and the rest under it. */
const TWILIO_PATHS = ['/sms', '/voice', '/voice-ws', '/voice-ws-outbound', '/voice-status', '/recording-status'];

/** The one startup line. It must never say `enforce` as if it were protecting when there is no token. */
function gateStartupLine({ mode = gateMode(), token, paths = TWILIO_PATHS } = {}) {
  const where = ` on ${paths.join(', ')}`;
  if (mode === 'off') return `[twilio-gate] mode off${where}`;
  if (!token) return `[twilio-gate] mode ${mode} but NO TWILIO_AUTH_TOKEN: NOT CHECKING, every request passes${where}`;
  return `[twilio-gate] mode ${mode}${where}`;
}

module.exports = { createTwilioGate, gateMode, gateStartupLine, routeLabel, TWILIO_PATHS };
