'use strict';
/* site-caps.js -- Nov 26 2026 (Part 461 review fix). The bridge's own limits on
 * phone sign-ups and doorbell knocks.
 *
 * With the service seat on, the site no longer counts the bridge's sign-ins by
 * address. Two phone paths could then be leaned on:
 *
 * 1. Spoken sign-up. A caller can speak an email and their own password. The
 *    bridge registers, then signs in with exactly those details, and on success
 *    links the caller's phone to that account. Without a limit, that is a way
 *    to guess passwords. So each caller number, each email, and the bridge as a
 *    whole get a small number of sign-up tries.
 * 2. Doorbell knocks. Every stranger who dials can file an access request,
 *    which pings Kade. So each caller number and the bridge as a whole get a
 *    small number of knocks.
 *
 * The site has its own limits behind these (failed sign-ins per email, and one
 * shared hourly count of service knocks). These counts live in memory, so a
 * restart starts them fresh. Every limit can be changed with a variable.
 */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function envInt(env, name, fallback) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Ten bare digits for a US number, or the trimmed text when it is not one. */
function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length >= 7) return digits;
  return String(value || '').trim().toLowerCase() || 'unknown';
}

function emailKey(value) {
  return String(value || '').trim().toLowerCase() || 'unknown';
}

/** A count of events in a rolling window, per key. */
function windowCount({ max, windowMs, now }) {
  const hits = new Map();
  const fresh = (key) => {
    const t = now();
    const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  };
  return {
    /** Would one more fit? Does not count it. */
    roomFor(key) { return fresh(key).length < max; },
    /** Count one. */
    add(key) {
      const list = fresh(key);
      list.push(now());
      hits.set(key, list);
      if (hits.size > 5000) { // never let the map grow without end
        for (const k of hits.keys()) { fresh(k); if (hits.size <= 4000) break; }
      }
    },
  };
}

/** Takes one from every counter, or from none of them when any one is full. */
function takeAll(pairs) {
  if (!pairs.every(([count, key]) => count.roomFor(key))) return false;
  for (const [count, key] of pairs) count.add(key);
  return true;
}

function makeSiteCaps(env = process.env, now = () => Date.now()) {
  const signupPerNumber = windowCount({ max: envInt(env, 'BRIDGE_SIGNUPS_PER_NUMBER_PER_DAY', 3), windowMs: DAY, now });
  const signupPerEmail = windowCount({ max: envInt(env, 'BRIDGE_SIGNUPS_PER_EMAIL_PER_DAY', 3), windowMs: DAY, now });
  const signupAll = windowCount({ max: envInt(env, 'BRIDGE_SIGNUPS_PER_HOUR', 10), windowMs: HOUR, now });
  const knockPerNumber = windowCount({ max: envInt(env, 'BRIDGE_KNOCKS_PER_NUMBER_PER_DAY', 2), windowMs: DAY, now });
  const knockAll = windowCount({ max: envInt(env, 'BRIDGE_KNOCKS_PER_HOUR', 6), windowMs: HOUR, now });
  return {
    /** One sign-up try (a register plus a sign-in check) for this caller and email. */
    allowSignup({ phone, email } = {}) {
      return takeAll([[signupPerNumber, phoneKey(phone)], [signupPerEmail, emailKey(email)], [signupAll, 'all']]);
    },
    /** One doorbell knock from this caller. */
    allowKnock({ phone } = {}) {
      return takeAll([[knockPerNumber, phoneKey(phone)], [knockAll, 'all']]);
    },
  };
}

/* The bridge's one shared set, made when first asked for. */
let shared = null;
function siteCaps() {
  if (!shared) shared = makeSiteCaps();
  return shared;
}

module.exports = { makeSiteCaps, siteCaps, phoneKey, emailKey };
