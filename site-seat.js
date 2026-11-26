'use strict';
/* site-seat.js -- Nov 26 2026 (Part 461). The service seat for calls to the site.
 *
 * Once the site runs with TRUST_PROXY=2 it counts sign-ins and turns by the
 * real caller's address. Every call this bridge makes to the site comes from
 * one Railway address, so the bridge would trip the site's per-address limits
 * and break phone calls. The site lets a request skip only those per-address
 * limits (never sign-in, never per-account limits) when it carries the header
 * X-Kade-Service with the value of KADE_SERVICE_LIMIT_SECRET.
 *
 * installAxiosSeat() adds that header to every axios request whose address is
 * the site (LIBRECHAT_URL, FORK_USAGE_URL, or kademurdock.com), and to nothing
 * else. If the site ever redirected one of these requests to another host, the
 * header is taken off before the request follows. The value is never logged.
 * Unset KADE_SERVICE_LIMIT_SECRET = no header is sent. The site ignores a
 * value shorter than 24 characters or holding a comma, so this file follows
 * the same rule: such a value is never sent, and one warning says so.
 *
 * Nov 26 2026 (review fix): site calls also carry X-Kade-Service-Name: bridge.
 * It is not a secret. The site reads it only on a request whose seat matched,
 * to keep the bridge's failed sign-ins in a count of its own, apart from the
 * inworld proxy's, so one service holding a stale password cannot lock the
 * other out. It is taken off a redirect to another host with the seat.
 */
const HEADER = 'X-Kade-Service';
const NAME_HEADER = 'X-Kade-Service-Name';
const SERVICE_NAME = 'bridge';
const DEFAULT_SITE = 'https://kademurdock.com';

function originOf(value) {
  try { return new URL(String(value)).origin; } catch (_) { return ''; }
}

/** The site's origins, read fresh each time so a test or a redeploy sees the current values. */
function siteOrigins(env = process.env) {
  const out = new Set([originOf(DEFAULT_SITE)]);
  for (const v of [env.LIBRECHAT_URL, env.FORK_USAGE_URL]) {
    const o = v ? originOf(v) : '';
    if (o) out.add(o);
  }
  out.delete('');
  return out;
}

const MIN_SECRET_LENGTH = 24; // the same rule the site uses

/** Why the secret will not be used, or '' when it is fine or unset. Never includes the value. */
function seatSecretProblem(env = process.env) {
  const s = typeof env.KADE_SERVICE_LIMIT_SECRET === 'string' ? env.KADE_SERVICE_LIMIT_SECRET.trim() : '';
  if (!s) return '';
  if (s.length < MIN_SECRET_LENGTH || s.includes(',')) {
    return `KADE_SERVICE_LIMIT_SECRET must be at least ${MIN_SECRET_LENGTH} characters with no comma, so the service seat header is not sent`;
  }
  return '';
}

function seatSecret(env = process.env) {
  const s = typeof env.KADE_SERVICE_LIMIT_SECRET === 'string' ? env.KADE_SERVICE_LIMIT_SECRET.trim() : '';
  if (!s || seatSecretProblem(env)) return '';
  return s;
}

/** True when this full address is the site. */
function isSiteUrl(url, env = process.env) {
  const o = originOf(url);
  return !!o && siteOrigins(env).has(o);
}

/** The full address an axios config will ask for. '' when it cannot be worked out. */
function axiosUrl(config) {
  try {
    const url = String(config.url || '');
    return config.baseURL ? new URL(url, String(config.baseURL).replace(/\/?$/, '/')).href : new URL(url).href;
  } catch (_) {
    return '';
  }
}

function deleteHeader(headers) {
  if (!headers) return;
  for (const name of [HEADER, NAME_HEADER]) {
    if (typeof headers.delete === 'function') headers.delete(name);
    for (const k of Object.keys(headers)) if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
  }
}

/** follow-redirects calls this before following a redirect: keep the header only on the site. */
function redirectGuard(previous, env) {
  return function kadeSeatBeforeRedirect(options, ...rest) {
    let target = '';
    try {
      const port = options.port ? `:${options.port}` : '';
      target = options.href || `${options.protocol}//${options.hostname || options.host}${port}`;
    } catch (_) { target = ''; }
    if (!isSiteUrl(target, env)) deleteHeader(options.headers);
    if (typeof previous === 'function') return previous(options, ...rest);
  };
}

/** The axios request hook. Exported for tests. */
function seatRequest(config, env = process.env) {
  const secret = seatSecret(env);
  if (!secret || !config) return config;
  if (!isSiteUrl(axiosUrl(config), env)) return config;
  if (config.headers && typeof config.headers.set === 'function') {
    config.headers.set(HEADER, secret);
    config.headers.set(NAME_HEADER, SERVICE_NAME);
  } else {
    config.headers = { ...(config.headers || {}), [HEADER]: secret, [NAME_HEADER]: SERVICE_NAME };
  }
  config.beforeRedirect = redirectGuard(config.beforeRedirect, env);
  return config;
}

/* A failed axios call carries its config and the raw request on the error, and some code prints
 * whole errors. So the header is taken off the error's config, and the raw request objects (which
 * hold a copy of every header) are hidden from printing. They can still be read by name. */
function hide(obj, key) {
  if (obj && Object.prototype.hasOwnProperty.call(obj, key)) {
    Object.defineProperty(obj, key, { value: obj[key], enumerable: false, writable: true, configurable: true });
  }
}
function scrubError(err) {
  try {
    if (err && err.config) deleteHeader(err.config.headers);
    if (err && err.response && err.response.config) deleteHeader(err.response.config.headers);
    hide(err, 'request');
    if (err && err.response) hide(err.response, 'request');
  } catch (_) { /* never let scrubbing change the error */ }
  return err;
}

let installed = false;
/** Add the hook to the shared axios instance once. Every module that requires 'axios' shares it. */
function installAxiosSeat(axios, env = process.env) {
  if (installed || !axios || !axios.interceptors) return false;
  const problem = seatSecretProblem(env);
  if (problem) console.warn(`[site-seat] ${problem}`); // the rule only, never the value
  // One line at boot, so the logs show whether site calls carry the seat. Never the value.
  else console.log(seatSecret(env) ? '[site-seat] site calls carry the service seat (as "bridge")' : '[site-seat] KADE_SERVICE_LIMIT_SECRET unset: site calls carry no service seat');
  axios.interceptors.request.use((config) => seatRequest(config, env));
  if (axios.interceptors.response) axios.interceptors.response.use((r) => r, (err) => Promise.reject(scrubError(err)));
  installed = true;
  return true;
}

module.exports = { HEADER, NAME_HEADER, SERVICE_NAME, MIN_SECRET_LENGTH, seatSecret, seatSecretProblem, siteOrigins, isSiteUrl, axiosUrl, seatRequest, redirectGuard, scrubError, installAxiosSeat };
