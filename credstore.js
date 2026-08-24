/* ── credstore.js — stop keeping site passwords in the clear ─────────────────
 * Part 92.10 (Aug 24 2026). Her words, on being shown her own password coming
 * back from GET /users: "I don't understand why it's showing mine and my mom's
 * pass, but yeah that needs fixed."
 *
 * WHY IT WAS ONLY THOSE TWO, since that was the confusing part: `lcPass` is
 * written only when an account is LINKED THROUGH THE BRIDGE — a /register POST
 * that carried a password, or the spoken phone-registration flow's
 * linkAccount(). Most seats were added with an email and nothing else. The
 * comment at hasAccount() has said so since July 21: "4 of 6 registry rows are
 * email-only." It was never everybody's password; it was two rows from one
 * registration path.
 *
 * ⚠️ AND IT CANNOT SIMPLY BE DELETED, WHICH IS WHY THIS IS ENCRYPTION AND NOT A
 * HASH. getTokenForCall() uses it to log in AS THAT PERSON, so their phone call
 * rides their OWN seat — their conversations, their memory, their history.
 * Email-only rows fall back to the admin token. Dropping the password would
 * silently move Kade's and Holly's calls off their own accounts, which is a
 * worse outcome than the one being fixed. A login needs the real secret back,
 * so it must be reversible.
 *
 * WHAT CHANGES, AND THE BLAST RADIUS IS DELIBERATELY TINY: only the disk
 * boundary and the wire. In memory the row still carries `lcPass`, so all six
 * existing read sites are untouched and no call path changes.
 *   · ON DISK: `lcPass` → `lcPassEnc`, aes-256-gcm.
 *   · ON THE WIRE: /users reports `hasPass: true` instead of the value.
 *
 * FAIL-SAFE BY DESIGN: with no key configured, nothing changes at all — legacy
 * plaintext is still read and still written, and it says so loudly on boot. A
 * half-applied encryption that silently dropped the password would break the
 * phone lane for the two people who use it most, so the failure mode is
 * "unchanged and noisy", never "quietly lost".
 */
const crypto = require('crypto');

const KEY_ENV = 'KADE_CREDS_KEY';

function getKey() {
  const raw = process.env[KEY_ENV];
  if (!raw) return null;
  /* Accept hex or base64 or a passphrase; normalise to 32 bytes. */
  let buf;
  if (/^[0-9a-f]{64}$/i.test(raw)) buf = Buffer.from(raw, 'hex');
  else {
    const b = Buffer.from(raw, 'base64');
    buf = b.length === 32 ? b : crypto.createHash('sha256').update(raw).digest();
  }
  return buf.length === 32 ? buf : null;
}

function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), out.toString('base64')].join(':');
}

function decrypt(blob, key) {
  const parts = String(blob).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('bad ciphertext');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
  d.setAuthTag(Buffer.from(parts[2], 'base64'));
  return Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8');
}

/** Disk shape -> memory shape. Never throws; a bad row loses its password
 *  rather than taking the whole registry down with it. */
function decodeRow(row, key = getKey()) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  if (out.lcPassEnc) {
    if (key) {
      try {
        out.lcPass = decrypt(out.lcPassEnc, key);
      } catch (e) {
        console.error('[credstore] could not decrypt a stored password — leaving it unset');
      }
    } else {
      console.error(`[credstore] ${KEY_ENV} is not set but an encrypted password exists — that call will ride the admin token`);
    }
    delete out.lcPassEnc;
  }
  return out;
}

/** Memory shape -> disk shape. With no key, returns the row unchanged (legacy
 *  plaintext) rather than silently dropping the secret. */
function encodeRow(row, key = getKey()) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  if (out.lcPass && key) {
    out.lcPassEnc = encrypt(out.lcPass, key);
    delete out.lcPass;
  }
  return out;
}

/** What /users is allowed to say: whether a row HAS a password, never what. */
function redactRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  const had = Boolean(out.lcPass || out.lcPassEnc);
  delete out.lcPass;
  delete out.lcPassEnc;
  if (had) out.hasPass = true;
  return out;
}

const mapRows = (obj, fn) =>
  Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, fn(v)]));

module.exports = { getKey, encodeRow, decodeRow, redactRow, mapRows, KEY_ENV, _encrypt: encrypt, _decrypt: decrypt };
