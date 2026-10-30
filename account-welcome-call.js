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
 * Nothing here logs the password, the name or the full number (last two
 * digits only). GET /account-welcome-call/:sid reports how the call went
 * (answered, voicemail, no answer) so Kade's page can say so.
 */
const GAP_MS = 90 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PER_NUMBER_PER_DAY = 3;
const PLATFORM_PER_DAY = 30;
const TWIML_MAX = 4000;

/** Only the shapes the website mints: words and numbers joined by dashes. */
const PASSWORD_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+){0,7}$/;

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
 * The password as spoken pieces, one per dash-separated part: a word is said,
 * then spelled letter by letter in capitals (Polly reads a lone capital as the
 * letter's name); digits are read one at a time.
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
      return `${part}. Spelled ${part.toUpperCase().split('').join(', ')}.${tail}`;
    }
    /* Mixed letters and digits: every character on its own, with case said. */
    const chars = part
      .split('')
      .map((c) => (/\d/.test(c) ? c : /[A-Z]/.test(c) ? `capital ${c}` : c.toUpperCase()))
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

/** The whole call. Every <Say> is short and followed by a pause, so it is slow. */
function welcomeCallTwiml({ to, password, name }) {
  const say = (text) => `<Say voice="Polly.Joanna">${escapeXml(text)}</Say>`;
  const pause = (s = 1) => `<Pause length="${s}"/>`;
  const reading = () => {
    let x = say('To sign in, type your phone number:') +
      pause(1) + say(`${spokenPhone(to)}.`) + pause(2) +
      say(`Your temporary password. ${wordCount(password)}`) + pause(1);
    for (const piece of passwordPieces(password)) x += say(piece) + pause(2);
    return x;
  };
  return '<Response>' + pause(1) +
    say(`Hi${name ? ` ${name}` : ''}, this is Kade A I. Kade made your account, and this call has your sign in. You may want something to write with. I will say it all twice.`) +
    pause(2) + reading() +
    say('Let me say that again.') + pause(2) + reading() +
    say('Sign in at kademurdock dot com, that is K, A, D, E, M, U, R, D, O, C, K, dot com, or in the Kade A I app.') + pause(1) +
    say('Once you are in, you can change your password whenever you like, in your account settings.') + pause(1) +
    say('If you ever lose it, choose Forgot your password on the sign in page, and we will call you with a code. Welcome! Goodbye.') +
    '<Hangup/></Response>';
}

/** Express handler factory; the call itself is injected so tests need no Twilio. */
function accountWelcomeCallHandler({ secretOk, placeCall, now = () => Date.now() }) {
  const last = new Map(); // number -> [times]
  let platform = [];
  return async (req, res) => {
    const body = req.body || {};
    if (!secretOk(req, body.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const valid = validWelcomeCall(body);
    if (!valid) return res.status(400).json({ error: 'bad request' });
    /* Twilio refuses inline TwiML over 4,000 characters. */
    const twiml = welcomeCallTwiml(valid);
    if (twiml.length > TWIML_MAX) return res.status(400).json({ error: 'password too long to read' });
    const t = now();
    const mine = (last.get(valid.to) || []).filter((x) => t - x < DAY_MS);
    platform = platform.filter((x) => t - x < DAY_MS);
    if (mine.length && t - mine[mine.length - 1] < GAP_MS) {
      return res.status(429).json({ error: 'too soon', reason: 'gap' });
    }
    if (mine.length >= PER_NUMBER_PER_DAY) {
      return res.status(429).json({ error: 'too many today for this number', reason: 'number-day' });
    }
    if (platform.length >= PLATFORM_PER_DAY) {
      return res.status(429).json({ error: 'too many today', reason: 'platform-day' });
    }
    mine.push(t);
    last.set(valid.to, mine);
    platform.push(t);
    if (last.size > 5000) last.clear();
    try {
      const sid = await placeCall(valid.to, twiml);
      console.log(`[account-welcome-call] placed to ...${valid.to.slice(-2)} sid=${sid || '?'}`);
      return res.json({ ok: true, sid: sid || null });
    } catch (e) {
      console.error(`[account-welcome-call] failed to ...${valid.to.slice(-2)}: ${scrub(e && e.message)}`);
      return res.status(502).json({ error: 'call failed' });
    }
  };
}

/** GET /account-welcome-call/:sid -- how the call went, in Twilio's words. */
function accountWelcomeStatusHandler({ secretOk, fetchCall }) {
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
  accountWelcomeCallHandler,
  accountWelcomeStatusHandler,
  GAP_MS,
  PER_NUMBER_PER_DAY,
  PLATFORM_PER_DAY,
};
