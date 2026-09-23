/* Password reset codes read aloud by a phone call (Sep 22 2026).
 *
 * The website (fork kadePhoneReset.js) calls POST /account-code-call with the
 * BRIDGE_SECRET when somebody who signs in with a phone number asks to reset a
 * forgotten password. This places one short call from the platform's number
 * that reads the six-digit code twice, slowly, then hangs up. The code is
 * never logged; the number is logged by its last two digits only.
 */
const GAP_MS = 90 * 1000;

function validCodeCall(body) {
  const to = String((body && body.to) || '');
  const code = String((body && body.code) || '');
  if (!/^\+1\d{10}$/.test(to) || !/^\d{6}$/.test(code)) return null;
  return { to, code };
}

/** Digits read one at a time with pauses ("4, 8, 2, ..."), twice, then goodbye. */
function codeCallTwiml(code) {
  const spoken = String(code).split('').join(', ');
  const say = (text) => `<Say voice="Polly.Joanna">${text}</Say>`;
  return '<Response><Pause length="1"/>' +
    say(`Hi, this is Kade A I. Here is your password reset code: ${spoken}.`) +
    '<Pause length="1"/>' +
    say(`Again, your code is: ${spoken}. It works for ten minutes.`) +
    '<Pause length="1"/>' +
    say("If you didn't ask for this, you can ignore it. Goodbye.") +
    '<Hangup/></Response>';
}

/** Express handler factory; the call itself is injected so tests need no Twilio. */
function accountCodeCallHandler({ secretOk, placeCall, now = () => Date.now() }) {
  const last = new Map();
  return async (req, res) => {
    const body = req.body || {};
    if (!secretOk(req, body.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const valid = validCodeCall(body);
    if (!valid) return res.status(400).json({ error: 'bad request' });
    if (now() - (last.get(valid.to) || 0) < GAP_MS) return res.status(429).json({ error: 'too soon' });
    last.set(valid.to, now());
    try {
      const sid = await placeCall(valid.to, codeCallTwiml(valid.code));
      console.log(`[account-code-call] placed to ...${valid.to.slice(-2)} sid=${sid || '?'}`);
      return res.json({ ok: true });
    } catch (e) {
      console.error(`[account-code-call] failed to ...${valid.to.slice(-2)}: ${e && e.message}`);
      return res.status(502).json({ error: 'call failed' });
    }
  };
}

module.exports = { validCodeCall, codeCallTwiml, accountCodeCallHandler, GAP_MS };
