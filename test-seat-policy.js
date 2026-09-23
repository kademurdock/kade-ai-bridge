'use strict';

// Review/demo accounts are also used by automated tests. Device registration
// must never turn a synthetic conversation into a real push or ringing phone.
const TEST_USER_IDS = new Set([
  '6a6125d73939d20b95251078', // Visibility Test / App Review
  '6a69074cc74d975de21f5b2a', // Party Test
  '6a572e3be680dcdaadca0f04', // tester
  ...String(process.env.NOTIFY_TEST_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
]);
function isTestUser(userId) { return TEST_USER_IDS.has(String(userId || '')); }
function blockedResult() {
  return { ok: false, sent: 0, blocked: 'Notifications are disabled for this test account', testAccount: true };
}
module.exports = { isTestUser, blockedResult };
