'use strict';
/* /push-register used to link a device to whatever userId the body named. User ids are not
 * secret, so anyone with the app could link their own phone to someone else's account and get
 * that person's check-ins, call alerts and message previews. (Nov 12 2026, platform audit IOS-19.)
 *
 * Now a link needs the fork's own access token (Authorization: Bearer, HS256, signed with the
 * fork's JWT_SECRET, given to this service as LIBRECHAT_JWT_SECRET). The user id comes from the
 * token's `id` claim; the body's userId is only a claim to compare against.
 *
 *   PUSH_REGISTER_AUTH=off      the body is believed, as before
 *   PUSH_REGISTER_AUTH=log      a valid token wins; an unproven claim still links, with
 *                               a `[push-auth] would-refuse` line
 *   PUSH_REGISTER_AUTH=enforce  an unproven claim gets 401 and links nothing
 *
 * With PUSH_REGISTER_AUTH unset the mode is `log`, until the date in PUSH_REGISTER_ENFORCE_FROM
 * (an ISO date or time, e.g. 2027-01-15 or 2027-01-15T06:00:00Z) has passed; from then on it is
 * `enforce` with no redeploy. Kade's rule (Nov 12 2026): enforce 30 days after the new iPhone and
 * Android builds are out. A set PUSH_REGISTER_AUTH always wins over the date (off or log is the undo).
 *
 * Never refused in any mode: sign-out (userId null/empty), and a token-only register with no
 * userId (it can link nobody). With no secret set nothing is refused either, with a loud line.
 * The log never carries the token or a user id.
 */
const crypto = require('crypto');

const MODES = new Set(['off', 'log', 'enforce']);
const USER_ID_RE = /^[0-9a-f]{24}$/;

/** The enforce date as ms since the epoch, or null when unset or unreadable. */
function enforceFromMs(env = process.env) {
  const raw = String(env.PUSH_REGISTER_ENFORCE_FROM || '').trim();
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function pushAuthMode(env = process.env, now = Date.now()) {
  const asked = String(env.PUSH_REGISTER_AUTH || '').trim().toLowerCase();
  if (MODES.has(asked)) return asked;
  const from = enforceFromMs(env);
  return from !== null && now >= from ? 'enforce' : 'log';
}

function verifyUserJwt(bearer, { secret, now = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: 'no-secret' };
  const m = /^Bearer\s+(\S+)$/i.exec(String(bearer || '').trim());
  if (!m) return { ok: false, reason: 'missing' };
  const jwt = m[1];
  if (jwt.length > 4096) return { ok: false, reason: 'malformed' };
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return { ok: false, reason: 'malformed' };
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return { ok: false, reason: 'malformed' }; }
  if (!header || header.alg !== 'HS256') return { ok: false, reason: 'bad-alg' };
  const expect = crypto.createHmac('sha256', String(secret)).update(`${parts[0]}.${parts[1]}`).digest();
  let got;
  try { got = Buffer.from(parts[2], 'base64url'); } catch { return { ok: false, reason: 'malformed' }; }
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return { ok: false, reason: 'bad-signature' };
  if (!payload || typeof payload.exp !== 'number' || now >= payload.exp * 1000) return { ok: false, reason: 'expired' };
  const userId = String(payload.id || '').toLowerCase();
  if (!USER_ID_RE.test(userId)) return { ok: false, reason: 'no-user' };
  return { ok: true, userId };
}

function decidePushLink({ bearer, bodyUserId, mode, secret, now = Date.now() } = {}) {
  if (!mode) mode = pushAuthMode(process.env, now);
  const claimed = String(bodyUserId || '').trim().slice(0, 64);
  if (mode === 'off') return { userId: claimed, refuse: false, how: 'off' };
  const v = verifyUserJwt(bearer, { secret, now });
  if (v.ok) return { userId: v.userId, refuse: false, how: 'jwt', mismatch: !!claimed && claimed.toLowerCase() !== v.userId };
  if (!claimed) return { userId: '', refuse: false, how: 'unlinked', reason: v.reason };
  if (v.reason === 'no-secret') return { userId: claimed, refuse: false, how: 'unverified', reason: v.reason };
  if (mode === 'enforce') return { userId: '', refuse: true, how: 'refused', reason: v.reason };
  return { userId: claimed, refuse: false, how: 'would-refuse', reason: v.reason };
}

/* Nov 13 2026 (sweep 8.7): log mode wrote a line only for a registration that WOULD be refused, so
 * "how many would fail on the enforce date" had no answer: a clean registration left no trace, and
 * zero would-refuse lines could mean everyone proved themselves or nobody registered at all. Every
 * registration is now counted, by platform and by outcome, since boot:
 *   proved     the bearer proved the user (how 'jwt')
 *   mismatch   proved, but the body named somebody else (also counted in proved)
 *   unproven   linked on the body's word alone; this is what enforce would refuse ('would-refuse')
 *   noSecret   nothing could be checked, no secret on this service ('unverified')
 *   refused    enforce refused it
 *   unlinked   a token with no user at all (links nobody)
 *   signedOut  an explicit sign-out
 *   off        PUSH_REGISTER_AUTH=off
 * Numbers only: no token, no user id. */
const OUTCOME = { jwt: 'proved', 'would-refuse': 'unproven', unverified: 'noSecret', refused: 'refused', unlinked: 'unlinked', signout: 'signedOut', off: 'off' };
function createPushAuthTally(now = Date.now()) {
  const since = now;
  const by = new Map(); // platform -> { outcome: n }
  let total = 0;
  function note(how, platform, { mismatch = false } = {}) {
    const outcome = OUTCOME[how];
    if (!outcome) return;
    const p = String(platform || 'ios').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20) || 'ios';
    const row = by.get(p) || {};
    row[outcome] = (row[outcome] || 0) + 1;
    if (mismatch) row.mismatch = (row.mismatch || 0) + 1;
    by.set(p, row);
    total++;
  }
  const snapshot = () => ({ since: new Date(since).toISOString(), total, platforms: Object.fromEntries([...by].map(([p, row]) => [p, { ...row }])) });
  /** One log line, e.g. "ios proved 12, unproven 3; android unproven 5". */
  function line() {
    if (!total) return 'no registrations since boot';
    return [...by].sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([p, row]) => `${p} ${Object.keys(row).sort().map((k) => `${k} ${row[k]}`).join(', ')}`).join('; ');
  }
  return { note, snapshot, line, get total() { return total; } };
}

module.exports = { pushAuthMode, enforceFromMs, verifyUserJwt, decidePushLink, createPushAuthTally };
