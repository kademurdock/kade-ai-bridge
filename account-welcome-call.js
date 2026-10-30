/* Welcome call for phone-only accounts (Oct 29 2026).
 *
 * Kade: "my friend David registered with just his phone ... his phone can't
 * get a temp password from resend email so he prob hasn't ever been able to
 * log in." An account approved from a phone number alone has a placeholder
 * address that can never receive mail, so until now the temporary password
 * reached only Kade's screen. The website (fork admin/accessRequests.js) now
 * calls POST /account-welcome-call with the BRIDGE_SECRET right after it makes
 * such an account, or when Kade asks to call someone again. This places one
 * call from the platform's number that reads, slowly and twice: what to type
 * to sign in (their phone number), the temporary password word by word with
 * every letter spelled, where to sign in, and that they can change it later.
 *
 * Voicemail never hears the password (decided Oct 29). Twilio listens for an
 * answering machine before the call speaks, then asks
 * POST /account-welcome-call/twiml/:token what to say. A person hears the
 * whole call; a machine gets only a short "your account is ready, we'll call
 * you back" with no number or password, and the lookup reports
 * played:'voicemail' so Kade's page offers to call again.
 * WELCOME_CALL_VOICEMAIL_PASSWORD=1 (off by default) lets the whole message be
 * left on voicemail instead. The password waits in memory only until Twilio
 * asks for it (once, at most 5 minutes), and is never logged.
 *
 * {dryRun:true} checks everything (secret, number, password, spacing and caps,
 * Twilio configured) and places nothing, so the website can make sure a call
 * will go out BEFORE it replaces an account's password.
 *
 * Nothing here logs the password, the name or the full number (last two
 * digits only). GET /account-welcome-call/:sid reports how the call went
 * (answered, voicemail, no answer) so Kade's page can say so.
 */
const crypto = require('crypto');

const GAP_MS = 90 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PER_NUMBER_PER_DAY = 3;
const PLATFORM_PER_DAY = 30;
const TWIML_MAX = 4000;
/** Ringing, voicemail detection and a long greeting all fit inside this. */
const SCRIPT_TTL_MS = 5 * 60 * 1000;

/** Only the shapes the website mints: words and numbers joined by dashes. */
const PASSWORD_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+){0,7}$/;

/** What a voicemail hears: no number, no password (Kade's call, Oct 29). */
const VOICEMAIL_TEXT =
  "Hi, this is Kade A I. Your account is ready. We'll call you back to read your sign-in, or ask Kade.";
/** A person answered but the bridge restarted and lost the script. */
const LOST_TEXT =
  "Hi, this is Kade A I. Your account is ready, but I couldn't read your sign-in just now. We'll call you back, or ask Kade.";

function cleanName(raw) {
  /* A first name only, letters and a few marks, so nothing odd reaches the
   * speech engine. Empty is fine: the call then just says "hi". */
  const first = String(raw || '').trim().split(/\s+/)[0] || '';
  return first.replace(/[^A-Za-zÀ-ɏ'.-]/g, '').slice(0, 30);
}

function validWelcomeCall(body) {
  const to = String((body && body.to) || '');
  const password = String((body && body.password) || '');
  if (!/^\+1\d{10}$/.test(to)) return null;
  if (password.length < 8 || password.length > 64 || !PASSWORD_RE.test(password)) return null;
  return { to, password, name: cleanName(body && body.name) };
}

/** "4, 1, 7. 7, 7, 0. 4, 7, 2, 2" -- a US number in its three spoken groups. */
function spokenPhone(to) {
  const d = String(to).replace(/\D/g, '').slice(-10);
  const group = (s) => s.split('').join(', ');
  return `${group(d.slice(0, 3))}. ${group(d.slice(3, 6))}. ${group(d.slice(6))}`;
}

/**
 * SSML that makes Polly say each letter's name. A lone "A" written as plain
 * text is often read as the word "uh"; spell-out never is. Only ever given a
 * validated [a-z]+ string, so it is safe inside the markup.
 */
function spellOut(word) {
  if (!/^[a-z]+$/.test(String(word))) throw new Error('spellOut takes lower-case letters only');
  return `<say-as interpret-as="spell-out">${word}</say-as>`;
}

/**
 * The password as spoken pieces (SSML fragments, one <Say> each), one per
 * dash-separated part: a word is said plainly, then spelled with spell-out;
 * digits are read one at a time. Every part matched PASSWORD_RE, so the only
 * characters here are letters, digits and our own markup.
 */
function passwordPieces(password) {
  const parts = String(password).split('-');
  return parts.map((part, i) => {
    const last = i === parts.length - 1;
    const tail = last ? '' : ' Then a dash.';
    if (/^\d+$/.test(part)) {
      return `The number ${part.split('').join(', ')}.${tail}`;
    }
    if (/^[a-z]+$/.test(part)) {
      return `${part}. Spelled ${spellOut(part)}.${tail}`;
    }
    /* Mixed letters and digits: every character on its own, with case said. */
    const chars = part
      .split('')
      .map((c) => (/\d/.test(c) ? c : /[A-Z]/.test(c) ? `capital ${spellOut(c.toLowerCase())}` : spellOut(c)))
      .join(', ');
    return `${chars}.${tail}`;
  });
}

function wordCount(password) {
  const parts = String(password).split('-');
  const words = parts.filter((p) => /^[a-z]+$/.test(p)).length;
  const numbers = parts.filter((p) => /^\d+$/.test(p)).length;
  if (words && numbers && words + numbers === parts.length) {
    return `It is ${words} ${words === 1 ? 'word' : 'words'} and a number, with dashes between them, all lower case.`;
  }
  return `It has ${String(password).length} characters.`;
}

/** Twilio errors can quote the number they refused; never let one reach the log. */
function scrub(message) {
  return String(message || '').replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]').slice(0, 200);
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const say = (text) => `<Say voice="Polly.Joanna">${escapeXml(text)}</Say>`;
/** For our own SSML only (passwordPieces, spellOut); never for outside text. */
const saySsml = (ssml) => `<Say voice="Polly.Joanna">${ssml}</Say>`;
const pause = (s = 1) => `<Pause length="${s}"/>`;

/** The whole call. Every <Say> is short and followed by a pause, so it is slow. */
function welcomeCallTwiml({ to, password, name }) {
  const reading = () => {
    let x = say('To sign in, type your phone number:') +
      pause(1) + say(`${spokenPhone(to)}.`) + pause(2) +
      say(`Your temporary password. ${wordCount(password)}`) + pause(1);
    for (const piece of passwordPieces(password)) x += saySsml(piece) + pause(2);
    return x;
  };
  return '<Response>' + pause(1) +
    say(`Hi${name ? ` ${name}` : ''}, this is Kade A I. Kade made your account, and this call has your sign in. You may want something to write with. I will say it all twice.`) +
    pause(2) + reading() +
    say('Let me say that again.') + pause(2) + reading() +
    saySsml(`Sign in at kademurdock dot com, that is ${spellOut('kademurdock')}, dot com, or in the Kade A I app.`) + pause(1) +
    say('Once you are in, you can change your password whenever you like, in your account settings.') + pause(1) +
    say('If you ever lose it, choose Forgot your password on the sign in page, and we will call you with a code. Welcome! Goodbye.') +
    '<Hangup/></Response>';
}

/** The short message for a machine, or for a script that is gone. */
function shortTwiml(text) {
  return '<Response>' + pause(1) + say(text) + pause(1) + '<Hangup/></Response>';
}

/**
 * Shared between the three handlers: the waiting scripts (token -> entry) and
 * what each call ended up playing (sid -> 'full' | 'voicemail' | 'lost').
 */
function createWelcomeStore() {
  return { scripts: new Map(), played: new Map() };
}

function sweep(store, t) {
  for (const [k, v] of store.scripts) if (t - v.at > SCRIPT_TTL_MS) store.scripts.delete(k);
  if (store.played.size > 2000) store.played.clear();
}

/**
 * Express handler factory; the call itself is injected so tests need no Twilio.
 * placeCall(to, url) dials and, once something answers, asks `url` what to
 * say; it returns the call sid.
 */
function accountWelcomeCallHandler({
  secretOk,
  placeCall,
  publicUrl = '',
  ready = () => true,
  store = createWelcomeStore(),
  now = () => Date.now(),
}) {
  const last = new Map(); // number -> [times]
  let platform = [];
  return async (req, res) => {
    const body = req.body || {};
    if (!secretOk(req, body.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const valid = validWelcomeCall(body);
    if (!valid) return res.status(400).json({ error: 'bad request' });
    /* Kept from the inline-TwiML days: a script this long means a wrong password. */
    const twiml = welcomeCallTwiml(valid);
    if (twiml.length > TWIML_MAX) return res.status(400).json({ error: 'password too long to read' });
    const t = now();
    const mine = (last.get(valid.to) || []).filter((x) => t - x < DAY_MS);
    platform = platform.filter((x) => t - x < DAY_MS);
    if (mine.length && t - mine[mine.length - 1] < GAP_MS) {
      return res.status(429).json({
        error: 'too soon',
        reason: 'gap',
        retryAfterSec: Math.ceil((GAP_MS - (t - mine[mine.length - 1])) / 1000),
      });
    }
    if (mine.length >= PER_NUMBER_PER_DAY) {
      return res.status(429).json({ error: 'too many today for this number', reason: 'number-day' });
    }
    if (platform.length >= PLATFORM_PER_DAY) {
      return res.status(429).json({ error: 'too many today', reason: 'platform-day' });
    }
    if (!ready()) return res.status(503).json({ error: 'calls are not set up', reason: 'not-configured' });
    /* The website asks this first, before it touches anyone's password. */
    if (body.dryRun === true) return res.json({ ok: true, dryRun: true });
    mine.push(t);
    last.set(valid.to, mine);
    platform.push(t);
    if (last.size > 5000) last.clear();
    sweep(store, t);
    const token = crypto.randomBytes(16).toString('hex');
    store.scripts.set(token, { at: t, twiml });
    try {
      const sid = await placeCall(valid.to, `${publicUrl}/account-welcome-call/twiml/${token}`);
      console.log(`[account-welcome-call] placed to ...${valid.to.slice(-2)} sid=${sid || '?'}`);
      return res.json({ ok: true, sid: sid || null });
    } catch (e) {
      store.scripts.delete(token);
      console.error(`[account-welcome-call] failed to ...${valid.to.slice(-2)}: ${scrub(e && e.message)}`);
      return res.status(502).json({ error: 'call failed' });
    }
  };
}

/**
 * POST /account-welcome-call/twiml/:token -- Twilio asks what to say once the
 * call is answered, with AnsweredBy from answering-machine detection. The
 * token is 128 random bits known only to Twilio and us, and works once.
 * checkSignature is log-only, like /amd-status: a URL mismatch must never
 * silence a real call.
 */
function accountWelcomeTwimlHandler({
  store,
  allowVoicemailPassword = () => process.env.WELCOME_CALL_VOICEMAIL_PASSWORD === '1',
  checkSignature = () => true,
  now = () => Date.now(),
}) {
  return (req, res) => {
    const body = req.body || {};
    const token = String((req.params && req.params.token) || '');
    const sid = /^CA[0-9a-f]{32}$/i.test(String(body.CallSid || '')) ? String(body.CallSid) : '';
    try {
      if (!checkSignature(req)) console.warn(`[account-welcome-call] signature mismatch on script fetch ${sid || '?'}`);
    } catch {}
    const answeredBy = String(body.AnsweredBy || '');
    // 'unknown' means detection could not tell (a silent person, or a machine with an odd greeting).
    // Treated as a machine, so a password never lands on a voicemail; the card asks for a call back.
    const machine = /^(machine|fax|unknown)/.test(answeredBy);
    const entry = /^[0-9a-f]{32}$/.test(token) ? store.scripts.get(token) : null;
    if (entry) store.scripts.delete(token);
    const fresh = Boolean(entry) && now() - entry.at <= SCRIPT_TTL_MS;
    let played;
    let xml;
    if (machine && !allowVoicemailPassword()) {
      played = 'voicemail';
      xml = shortTwiml(VOICEMAIL_TEXT);
    } else if (fresh) {
      played = 'full';
      xml = entry.twiml;
    } else {
      played = machine ? 'voicemail' : 'lost';
      xml = shortTwiml(machine ? VOICEMAIL_TEXT : LOST_TEXT);
    }
    if (sid) store.played.set(sid, played);
    console.log(`[account-welcome-call] ${sid || '?'} answeredBy=${answeredBy || 'none'} played=${played}`);
    res.type('text/xml').send(xml);
  };
}

/** GET /account-welcome-call/:sid -- how the call went, in Twilio's words. */
function accountWelcomeStatusHandler({ secretOk, fetchCall, store = createWelcomeStore() }) {
  return async (req, res) => {
    if (!secretOk(req, req.query && req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const sid = String((req.params && req.params.sid) || '');
    if (!/^CA[0-9a-f]{32}$/i.test(sid)) return res.status(400).json({ error: 'bad sid' });
    try {
      const c = await fetchCall(sid);
      return res.json({
        ok: true,
        status: String((c && c.status) || 'unknown'),
        duration: Number((c && c.duration) || 0),
        answeredBy: (c && c.answeredBy) || null,
        /* what the call actually said: 'full', 'voicemail' (the short
         * message, no password), 'lost', or null when this bridge does not
         * know (it restarted, or nothing has answered yet) */
        played: store.played.get(sid) || null,
      });
    } catch (e) {
      console.error(`[account-welcome-call] status lookup failed: ${scrub(e && e.message)}`);
      return res.status(502).json({ error: 'lookup failed' });
    }
  };
}

module.exports = {
  validWelcomeCall,
  welcomeCallTwiml,
  spokenPhone,
  passwordPieces,
  spellOut,
  createWelcomeStore,
  accountWelcomeCallHandler,
  accountWelcomeTwimlHandler,
  accountWelcomeStatusHandler,
  VOICEMAIL_TEXT,
  GAP_MS,
  PER_NUMBER_PER_DAY,
  PLATFORM_PER_DAY,
  SCRIPT_TTL_MS,
};
