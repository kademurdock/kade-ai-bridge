'use strict';
/* Nov 10 2026 (call limits lane). THE CALL SOCKET GATE.
 *
 * The phone call socket (/ws/media) accepted any client. Whoever opened it and sent a `start`
 * message naming a registered number got a full call as that person: Deepgram, the model and paid
 * speech all running, their memories attached, with no phone call anywhere. Only Twilio's own
 * stream, for a call this bridge itself answered or placed, should be able to do that.
 *
 * Two proofs, either one is enough:
 *
 *   1. A TICKET. When Twilio asks this bridge what to do with a call (/voice-ws, /voice-ws-outbound)
 *      the bridge mints a short-lived signed ticket for that call id and number and hands it to
 *      Twilio as a stream parameter. Twilio passes it back in the socket's `start` message. A ticket
 *      counts by itself only when the webhook that minted it carried Twilio's own valid signature
 *      (twilio-gate.js): otherwise anyone could ask /voice-ws for a ticket.
 *   2. TWILIO'S WORD. With no usable ticket, the bridge asks Twilio's REST API about the call id
 *      (a free lookup): it must exist, be ringing or in progress, and belong to the number the
 *      socket claims. A forger cannot know the id of a live call from that number.
 *
 * So a real call passes even if the ticket is lost (a bridge restart between the webhook and the
 * socket, a webhook address that makes signatures mismatch, a TwiML Bin that never asked this
 * bridge): Twilio still vouches for it. And when Twilio cannot be asked at all (its API is down,
 * the lookup times out, no credentials are set) the call is LET THROUGH in every mode, with a loud
 * line: a family call is never refused because a lookup failed.
 *
 *   CALL_SOCKET_GATE=off      no check at all
 *   CALL_SOCKET_GATE=log      (default) check, let everything through, log what enforce would refuse
 *   CALL_SOCKET_GATE=enforce  a socket that is proven not to be a real call is closed before any
 *                             session, speech or model call exists
 *
 * Shipped in `log`: nothing about a call changes, and nothing waits (the lookup runs beside the
 * call). Read the bridge log after real calls: `[call-socket] pass (ticket)` on every real call and
 * no `[call-socket] would refuse` on a real one means `enforce` is safe to set. In `enforce` a call
 * with a signed ticket still starts at once; only a socket with no signed ticket waits for
 * Twilio's answer (a few hundred milliseconds, 4 s at most) before its session is made.
 *
 * The log names the reason and the last four digits of the call id. Never the number, never the
 * ticket.
 */
const crypto = require('crypto');

const MODES = new Set(['off', 'log', 'enforce']);
const TICKET_TTL_MS = 2 * 60 * 1000;   // Twilio opens the stream within a second or two of the webhook
const LOOKUP_TIMEOUT_MS = 4000;
const LIVE_STATUSES = new Set(['queued', 'initiated', 'ringing', 'in-progress']);
const CALL_SID_RE = /^CA[0-9a-f]{32}$/i;
const LOG_WINDOW_MS = 10 * 60 * 1000;
const LOG_PER_WINDOW = 20;

function socketGateMode(env = process.env) {
  const asked = String(env.CALL_SOCKET_GATE || '').trim().toLowerCase();
  return MODES.has(asked) ? asked : 'log';
}

/** Two phone numbers name the same line: last ten digits equal, or neither has digits (a withheld number). */
function sameNumber(a, b) {
  const da = String(a || '').replace(/\D/g, '');
  const db = String(b || '').replace(/\D/g, '');
  if (!da && !db) return true;
  if (!da || !db) return false;
  return da.slice(-10) === db.slice(-10);
}

const tail = (sid) => String(sid || '').slice(-4) || '????';

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }

/**
 *   secret     any stable secret of this service (never sent anywhere; a derived key signs tickets).
 *              With none, a random key is made at boot: tickets then die with a restart and such a
 *              call is vouched for by Twilio instead.
 *   fetchCall  async (callSid) => { status, from, to } from Twilio's REST API; throws with
 *              `.status === 404` when Twilio has no such call. null when there are no credentials.
 */
function createCallSocketGate({ secret, fetchCall = null, mode = socketGateMode(), now = () => Date.now(), log = console, lookupTimeoutMs = LOOKUP_TIMEOUT_MS, ttlMs = TICKET_TTL_MS } = {}) {
  const key = crypto.createHmac('sha256', secret ? String(secret) : crypto.randomBytes(32)).update('kade-call-socket-ticket-v1').digest();
  const used = new Map(); // ticket signature -> expiry; a ticket opens one socket
  const seen = { passTicket: 0, passTwilio: 0, unverified: 0, wouldRefuse: 0, refused: 0, windowStart: now(), logged: 0 };

  function say(level, line) {
    if (now() - seen.windowStart > LOG_WINDOW_MS) { seen.windowStart = now(); seen.logged = 0; }
    if (seen.logged < LOG_PER_WINDOW) { seen.logged += 1; (log[level] || log.log).call(log, line); }
  }

  function sign(exp, flags, callSid, from) {
    return b64u(crypto.createHmac('sha256', key).update(`${exp}|${flags}|${callSid}|${from}`).digest());
  }

  /** flags: 's' = the minting webhook carried a valid Twilio signature, 'o' = outbound. */
  function mint({ callSid, from, outbound = false, signed = false }) {
    const exp = now() + ttlMs;
    const flags = `${signed ? 's' : ''}${outbound ? 'o' : ''}` || '-';
    return `v1.${exp.toString(36)}.${flags}.${sign(exp, flags, String(callSid || ''), String(from || ''))}`;
  }

  /** null when the ticket is good for this call; otherwise why not. */
  function ticketProblem(ticket, { callSid, from, outbound }) {
    if (!ticket) return 'no ticket';
    const parts = String(ticket).split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return 'ticket malformed';
    const exp = parseInt(parts[1], 36);
    const flags = parts[2];
    if (!Number.isFinite(exp) || !/^(-|s?o?)$/.test(flags)) return 'ticket malformed';
    const want = sign(exp, flags, String(callSid || ''), String(from || ''));
    const a = Buffer.from(parts[3]);
    const b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'ticket is not for this call';
    if (now() > exp) return 'ticket expired';
    if (flags.includes('o') !== !!outbound) return 'ticket is for the other direction';
    if (used.has(parts[3])) return 'ticket already used';
    if (!flags.includes('s')) return 'ticket was minted for an unsigned webhook';
    return null;
  }

  function spend(ticket) {
    const sig = String(ticket).split('.')[3];
    const t = now();
    for (const [k, exp] of used) if (exp < t) used.delete(k);
    used.set(sig, t + ttlMs);
  }

  /** Ask Twilio. Resolves { ok:true } | { ok:false, definite:true|false, reason }. Never rejects. */
  async function askTwilio({ callSid, from, outbound }) {
    if (typeof fetchCall !== 'function') return { ok: false, definite: false, reason: 'no Twilio credentials to check with' };
    let timer = null;
    try {
      const call = await Promise.race([
        fetchCall(callSid),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('lookup timed out'), { lookupTimeout: true })), lookupTimeoutMs); }),
      ]);
      if (!call) return { ok: false, definite: false, reason: 'Twilio gave no answer' };
      const status = String(call.status || '').toLowerCase();
      if (!LIVE_STATUSES.has(status)) return { ok: false, definite: true, reason: `Twilio says that call is ${status || 'not live'}` };
      const theirs = outbound ? call.to : call.from;
      if (!sameNumber(theirs, from)) return { ok: false, definite: true, reason: 'the number does not match the call' };
      return { ok: true };
    } catch (e) {
      if (e && (e.status === 404 || e.code === 20404)) return { ok: false, definite: true, reason: 'Twilio does not know that call' };
      return { ok: false, definite: false, reason: `Twilio could not be asked (${e && e.lookupTimeout ? 'timed out' : (e && e.status) || 'error'})` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The fast half, no waiting. Returns
   *   { verdict: 'pass', how: 'ticket' }    start the call now
   *   { verdict: 'refuse', reason }         proven forged without asking anyone
   *   { verdict: 'ask', why }               only Twilio can say; call settle()
   */
  function quick({ ticket, callSid, from, outbound = false, alreadyLive = false }) {
    if (mode === 'off') return { verdict: 'pass', how: 'off' };
    if (!CALL_SID_RE.test(String(callSid || ''))) return { verdict: 'refuse', reason: 'no real call id' };
    if (alreadyLive) return { verdict: 'refuse', reason: 'that call is already connected' };
    const problem = ticketProblem(ticket, { callSid, from, outbound });
    if (!problem) { spend(ticket); return { verdict: 'pass', how: 'ticket' }; }
    return { verdict: 'ask', why: problem };
  }

  /** The slow half: Twilio's word. Resolves { verdict: 'pass', how } | { verdict: 'refuse', reason }. */
  async function settle({ callSid, from, outbound = false }, why) {
    const r = await askTwilio({ callSid, from, outbound });
    if (r.ok) return { verdict: 'pass', how: 'twilio', why };
    if (!r.definite) return { verdict: 'pass', how: 'unverified', why: `${why}; ${r.reason}` };
    return { verdict: 'refuse', reason: `${why}; ${r.reason}` };
  }

  /** Count and log a final verdict. Returns true when the socket may go on. */
  function record(v, callSid) {
    const id = `call ..${tail(callSid)}`;
    if (v.verdict === 'pass') {
      if (v.how === 'off') return true;
      if (v.how === 'ticket') { seen.passTicket += 1; say('log', `[call-socket] pass (ticket) ${id}`); return true; }
      if (v.how === 'twilio') { seen.passTwilio += 1; say('log', `[call-socket] pass (twilio vouched; ${v.why}) ${id}`); return true; }
      seen.unverified += 1;
      say('warn', `[call-socket] UNVERIFIED and let through (${v.why}) ${id}. A real call is never refused because a check could not be made.`);
      return true;
    }
    if (mode === 'enforce') {
      seen.refused += 1;
      say('warn', `[call-socket] refused: ${v.reason} (${id}, mode enforce)`);
      return false;
    }
    seen.wouldRefuse += 1;
    say('warn', `[call-socket] would refuse: ${v.reason} (${id}, mode log: let through). On a real call this line means do not set enforce yet.`);
    return true;
  }

  return {
    mode, mint, quick, settle, record,
    stats: () => ({ mode, passTicket: seen.passTicket, passTwilio: seen.passTwilio, unverified: seen.unverified, wouldRefuse: seen.wouldRefuse, refused: seen.refused }),
    _ticketProblem: ticketProblem,
  };
}

function socketGateStartupLine({ mode = socketGateMode(), canAskTwilio } = {}) {
  if (mode === 'off') return '[call-socket] mode off: /ws/media accepts any client';
  return `[call-socket] mode ${mode} on /ws/media${canAskTwilio ? '' : ' (NO Twilio credentials: a socket without a signed ticket cannot be checked and is let through)'}`;
}

module.exports = { createCallSocketGate, socketGateMode, socketGateStartupLine, sameNumber, CALL_SID_RE, TICKET_TTL_MS };
