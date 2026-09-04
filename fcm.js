'use strict';
/* fcm.js — Android push through Firebase Cloud Messaging, HTTP v1 (Part 129,
 * Sep 4 2026). Her word: "I have a firebase account, and I have a new project
 * in it. What's next?" — the two files, then this.
 *
 * Built-ins only (crypto + https), the same discipline as the APNs sender:
 * the service-account JSON (FCM_SERVICE_ACCOUNT_JSON, the whole file as one
 * env value) signs an RS256 JWT, Google trades it for a bearer that lasts an
 * hour, and every send is one POST to
 *   https://fcm.googleapis.com/v1/projects/<project_id>/messages:send
 *
 * The result shape matches sendApnsPush so the call sites can stay dumb:
 *   { token, status, data|error }   status 200 = delivered to FCM,
 *   410 = the token is dead (UNREGISTERED / bad registration) — prune it,
 *   0   = transport/auth failure (never prune on these).
 *
 * Kill: unset FCM_SERVICE_ACCOUNT_JSON — fcmConfigured() goes false and every
 * Android target is skipped with a status-0 row, iOS untouched.
 */
const crypto = require('crypto');
const https = require('https');

let _sa = null;
let _saErr = null;
function serviceAccount() {
  if (_sa || _saErr) return _sa;
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) { _saErr = 'FCM_SERVICE_ACCOUNT_JSON unset'; return null; }
  try {
    const j = JSON.parse(raw);
    if (!j.client_email || !j.private_key || !j.project_id) throw new Error('missing client_email / private_key / project_id');
    _sa = j;
  } catch (e) {
    _saErr = 'FCM_SERVICE_ACCOUNT_JSON unreadable: ' + e.message;
    console.error('[fcm] ' + _saErr);
  }
  return _sa;
}
function fcmConfigured() { return !!serviceAccount(); }
function fcmProjectId() { const sa = serviceAccount(); return sa ? sa.project_id : null; }

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function postJson(url, body, headers, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode || 0, data }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

/* OAuth2 bearer for the service account — cached ~50 min of its 60. */
let _access = { token: null, exp: 0 };
async function fcmAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_access.token && _access.exp - now > 600) return _access.token;
  const sa = serviceAccount();
  if (!sa) throw new Error(_saErr || 'FCM not configured');
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), sa.private_key);
  const assertion = `${signingInput}.${b64url(sig)}`;
  const form = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`;
  const r = await new Promise((resolve) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) },
    }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode || 0, data }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    req.write(form); req.end();
  });
  if (r.status !== 200) throw new Error(`FCM token exchange ${r.status}: ${(r.data || r.error || '').slice(0, 200)}`);
  const j = JSON.parse(r.data);
  _access = { token: j.access_token, exp: now + (Number(j.expires_in) || 3600) };
  return _access.token;
}

/* Flatten opts.data (nested objects allowed by APNs) into FCM's string map. */
function dataMapFrom(opts) {
  const out = {};
  const d = opts && opts.data && typeof opts.data === 'object' ? opts.data : {};
  for (const [k, v] of Object.entries(d)) {
    if (v == null) continue;
    out[String(k)] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  if (opts && opts.category) out.category = String(opts.category);
  return out;
}

/* Same signature as sendApnsPush. */
async function sendFcmPush(deviceToken, title, body, opts = {}) {
  if (!fcmConfigured()) return { token: deviceToken, status: 0, error: _saErr || 'FCM not configured' };
  let bearer;
  try { bearer = await fcmAccessToken(); }
  catch (e) { return { token: deviceToken, status: 0, error: e.message }; }
  const isCall = opts && opts.category === 'KADE_CALL';
  const message = {
    token: deviceToken,
    notification: { title: String(title || 'Kade-AI').slice(0, 100), body: String(body || '').slice(0, 1000) },
    data: dataMapFrom(opts),
    android: {
      priority: 'high',
      notification: {
        channel_id: isCall ? 'kade_calls' : 'kade',
        sound: 'default',
        default_vibrate_timings: true,
        ...(isCall ? { notification_priority: 'PRIORITY_MAX' } : {}),
      },
    },
  };
  const r = await postJson(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(fcmProjectId())}/messages:send`,
    { message },
    { authorization: `Bearer ${bearer}` },
  );
  if (r.status === 200) return { token: deviceToken, status: 200, data: r.data };
  // A dead registration answers 404 with error.details[].errorCode UNREGISTERED,
  // or 400 INVALID_ARGUMENT on a malformed token. Both mean "stop sending here".
  const text = String(r.data || r.error || '');
  const dead = r.status === 404 || /UNREGISTERED|INVALID_ARGUMENT.*(token|registration)/i.test(text);
  if (dead) return { token: deviceToken, status: 410, data: text.slice(0, 300) };
  if (r.status === 401) _access = { token: null, exp: 0 }; // force a fresh bearer next time
  return { token: deviceToken, status: r.status, error: text.slice(0, 300) };
}

/* An FCM registration token: base64url-ish with one colon, ~140-200 chars. */
const FCM_TOKEN_RE = /^[A-Za-z0-9_\-]{20,}:[A-Za-z0-9_\-]{40,}$/;
function looksLikeFcmToken(t) { return FCM_TOKEN_RE.test(String(t || '')); }

module.exports = { fcmConfigured, fcmProjectId, fcmAccessToken, sendFcmPush, looksLikeFcmToken, dataMapFrom, FCM_TOKEN_RE };
