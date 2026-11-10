'use strict';
/* Nov 10 2026 (bug sweep). POST /signup is the public self-registration form: no secret, by design.
 * It built a FRESH row and wrote it over whatever was there, so anyone who posted a registered
 * number wiped that person's row: their site sign-in (lcEmail / lcPass), their voice, their speed and
 * their agent. Their next call was answered as a guest on the default agent, on the admin seat.
 * /register (the admin route) has merged since July 21 2026; this is the same rule for the open door,
 * but tighter, because the form has no secret and anyone can type anyone's number into it.
 *
 * Nov 10 2026 (independent review). On an EXISTING row the form now does only two things:
 *   - it fills in what is missing (no name, no agent);
 *   - it replaces the placeholder name 'Friend' on a row that has no site sign-in. That is the row
 *     the phone setup stores when it heard no name, and before this fix a later site signup with the
 *     real name was thrown away, so every call kept saying "Hey Friend!". Same placeholder rule as
 *     linkAccount in server.js.
 * It never adds the child flag to an existing row. The first version did, calling it "safer", but
 * a stranger (or a child typing a parent's number at site signup) could then turn an adult's row
 * into a child row, and nothing on the bridge takes that flag off again. The flag is set only when
 * the form CREATES the row; the admin /register route can still add it to an existing one.
 * It never renames a row that has a real name (a misheard name on a guest row is still only fixed
 * by /register: letting the open form rename any guest row is the owner's call, not made here),
 * never touches a row's agent, voice, speed or sign-in, and never takes the child flag off.
 *
 * signupRecord(existing, asked, defaults) -> { record, created }
 *   existing  the row already stored for the number, or undefined
 *   asked     { name, accountType } from the form
 *   defaults  { agentId, agentName }
 */
const PLACEHOLDER_NAME = 'Friend';

function signupRecord(existing, asked, defaults) {
  const name = String((asked && asked.name) || '').trim();
  const child = !!asked && asked.accountType === 'child';
  if (existing && typeof existing === 'object') {
    const record = { ...existing };
    const signedIn = !!(record.lcEmail || record.lcPass);
    if (!record.name) record.name = name;
    else if (name && record.name === PLACEHOLDER_NAME && !signedIn) record.name = name;
    if (!record.agentId) {
      record.agentId = defaults.agentId;
      record.agentName = defaults.agentName;
    }
    return { record, created: false };
  }
  const record = { name, agentId: defaults.agentId, agentName: defaults.agentName };
  if (child) record.accountType = 'child';
  return { record, created: true };
}

module.exports = { signupRecord };
