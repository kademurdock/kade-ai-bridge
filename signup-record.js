'use strict';
/* Nov 10 2026 (bug sweep). POST /signup is the public self-registration form: no secret, by design.
 * It built a FRESH row and wrote it over whatever was there, so anyone who posted a registered
 * number wiped that person's row: their site sign-in (lcEmail / lcPass), their voice, their speed and
 * their agent. Their next call was answered as a guest on the default agent, on the admin seat.
 * /register (the admin route) has merged since July 21 2026; this is the same rule for the open door,
 * with one difference: a stranger may ADD to an existing row only what makes it safer (the child
 * flag), never rename it or point it at another agent.
 *
 * signupRecord(existing, asked, defaults) -> { record, created }
 *   existing  the row already stored for the number, or undefined
 *   asked     { name, accountType } from the form
 *   defaults  { agentId, agentName }
 */
function signupRecord(existing, asked, defaults) {
  const name = String((asked && asked.name) || '').trim();
  const child = !!asked && asked.accountType === 'child';
  if (existing && typeof existing === 'object') {
    const record = { ...existing };
    if (!record.name) record.name = name;
    if (!record.agentId) {
      record.agentId = defaults.agentId;
      record.agentName = defaults.agentName;
    }
    if (child) record.accountType = 'child';
    return { record, created: false };
  }
  const record = { name, agentId: defaults.agentId, agentName: defaults.agentName };
  if (child) record.accountType = 'child';
  return { record, created: true };
}

module.exports = { signupRecord };
