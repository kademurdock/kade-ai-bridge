'use strict';
/**
 * lane-pass.js — the bridge tells the site how a voice turn reached it (Nov 11 2026, home agent card 2).
 *
 * Why: every voice turn reaches the site through the voice proxy, which signs in as the platform's
 * service seat and names the person on the line by email. The site could not tell signed-in app
 * voice (a person in the app or on the website, holding a ticket the site itself minted for their
 * sign-in) from a phone call (caller ID only, which can be borrowed or faked). So app voice was
 * treated as a phone call and a blind person in the app was told to "open the app".
 *
 * What: each voice turn carries a short-lived pass signed with the secret the bridge and the site
 * ALREADY share for web voice tickets and call transcripts (KADE_CALL_INGEST_SECRET, falling back to
 * KADE_USAGE_EVENT_SECRET). No new variable. The pass says one of two things:
 *   app-voice  this session opened with a valid web voice ticket for this email (verifyWebTicket).
 *   phone      a Twilio call; for an inbound call, the number Twilio says it came from, so the site
 *              can pair that number with a spoken code. A phone pass never says "signed in".
 *              Review fix (Nov 11 2026): the number rides only when the call socket gate PROVED the
 *              socket is Twilio's stream for that call (a ticket minted for a signed webhook, or
 *              Twilio's own word): session.callerVerified. With the gate in log mode a forged
 *              socket still gets through, so its claimed `from` must never become a pairing.
 * The signature is over a fixed prefix plus the body, so a pass can never be passed off as a web
 * voice ticket, nor a ticket as a pass. It lives two minutes.
 *
 * How it travels: the proxy forwards only named fields, so the pass rides as one extra entry at the
 * START of `messages`, an entry with no `content`. The proxy builds the model's text only from
 * entries that have content and from the last entry, so the words the model reads are unchanged,
 * and the proxy hands `messages` to the site as it is. The site looks for this entry only on the
 * service seat. A site that does not know the pass ignores it: nothing changes there.
 *
 * Off switch: KADE_LANE_PASS=0 sends no pass (the site then treats app voice as a phone call again).
 * The pass never holds the secret, the conversation, or any words.
 */
const crypto = require('crypto');

const PREFIX = 'kade-lane.v1.';
const LIFE_MS = 2 * 60 * 1000;
const ROLE = 'kade-lane';

function secretOf(env = process.env) {
  return String((env && (env.KADE_CALL_INGEST_SECRET || env.KADE_USAGE_EVENT_SECRET)) || '');
}

function on(env = process.env) {
  return String((env && env.KADE_LANE_PASS) ?? '') !== '0';
}

/** A number the way Twilio gives it (+ and 8 to 15 digits), or null. */
function e164(v) {
  const s = String(v || '').trim();
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

/**
 * Sign a pass. Returns null when there is no shared secret or nothing true to say.
 * @param {{ lane: 'app-voice' | 'phone', email?: string, num?: string, agentId?: string }} claim
 */
function mintLanePass(claim, env = process.env, now = Date.now()) {
  const secret = secretOf(env);
  if (!secret || !claim) return null;
  const payload = { v: 1, lane: null, iat: now, exp: now + LIFE_MS };
  if (claim.lane === 'app-voice') {
    const email = String(claim.email || '').trim().toLowerCase();
    if (!email) return null;
    payload.lane = 'app-voice';
    payload.email = email;
  } else if (claim.lane === 'phone') {
    payload.lane = 'phone';
    const num = e164(claim.num);
    if (num) payload.num = num;
    const email = String(claim.email || '').trim().toLowerCase();
    if (email) payload.email = email;
  } else {
    return null;
  }
  if (claim.agentId) payload.agentId = String(claim.agentId).slice(0, 64);
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(PREFIX + body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * What this session may truthfully say about its lane.
 *   web session (opened with a verified ticket, which set lcEmail): app-voice with that email.
 *     A direct Spotter session opened with the same ticket, so it is signed in too.
 *   Twilio session: phone, with the caller's number only on an inbound call.
 */
function claimFor(session) {
  if (!session) return null;
  const agentId = session.agentId || undefined;
  if (session.surface === 'web') {
    if (!session.lcEmail) return null;
    return { lane: 'app-voice', email: session.lcEmail, agentId };
  }
  const inbound = session.outbound !== true && session.twilioOutbound !== true;
  const proven = session.callerVerified === true;
  return { lane: 'phone', num: inbound && proven ? session.from : undefined, email: session.lcEmail || undefined, agentId };
}

/** The `messages` entry that carries the pass, or null (switch off, no secret, nothing to say). */
function lanePassEntry(session, env = process.env, now = Date.now()) {
  if (!on(env)) return null;
  const token = mintLanePass(claimFor(session), env, now);
  return token ? { role: ROLE, kadeLanePass: token } : null;
}

module.exports = { mintLanePass, claimFor, lanePassEntry, PREFIX, ROLE, LIFE_MS };
