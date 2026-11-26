'use strict';
/* site-caps.test.js -- Nov 26 2026 (Part 461 review fix). The bridge's own limits on phone
 * sign-up tries and doorbell knocks. No network. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSiteCaps, phoneKey, emailKey, unprovenSignupAllowed, webhookProvenForSignup, callerProvenForSignup } = require('./site-caps');

const HOUR = 60 * 60 * 1000;
function clock() {
  let t = 1_800_000_000_000;
  return { now: () => t, pass: (ms) => { t += ms; } };
}

test('caller numbers and emails are counted the same however they are written', () => {
  assert.equal(phoneKey('+14175550100'), '4175550100');
  assert.equal(phoneKey('(417) 555-0100'), '4175550100');
  assert.equal(phoneKey(''), 'unknown');
  assert.equal(emailKey('  Kade@Example.COM '), 'kade@example.com');
});

test('sign-ups: 3 a day per caller number', () => {
  const c = clock();
  const caps = makeSiteCaps({}, c.now);
  const from = '+14175550100';
  const tries = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'].map((email) => caps.allowSignup({ phone: from, email }));
  assert.deepEqual(tries, [true, true, true, false]);
  c.pass(25 * HOUR);
  assert.equal(caps.allowSignup({ phone: from, email: 'e@x.com' }), true);
});

test('sign-ups: 3 a day per email, even from many numbers', () => {
  const caps = makeSiteCaps({}, clock().now);
  const tries = ['+14175550101', '+14175550102', '+14175550103', '+14175550104'].map((phone) =>
    caps.allowSignup({ phone, email: 'Kade@Example.com' }));
  assert.deepEqual(tries, [true, true, true, false]);
  // A refused try does not use up the caller's own allowance.
  assert.equal(caps.allowSignup({ phone: '+14175550104', email: 'other@example.com' }), true);
});

test('sign-ups: 10 an hour for the whole bridge', () => {
  const c = clock();
  const caps = makeSiteCaps({}, c.now);
  const tries = Array.from({ length: 11 }, (_, i) => caps.allowSignup({ phone: `+1417555${String(1000 + i)}`, email: `p${i}@x.com` }));
  assert.deepEqual(tries, [...Array(10).fill(true), false]);
  c.pass(HOUR + 1);
  assert.equal(caps.allowSignup({ phone: '+14175559999', email: 'late@x.com' }), true);
});

test('knocks: 2 a day per caller number and 6 an hour in all', () => {
  const caps = makeSiteCaps({}, clock().now);
  const same = [1, 2, 3].map(() => caps.allowKnock({ phone: 'phone +14175550100' }));
  assert.deepEqual(same, [true, true, false]);
  const others = Array.from({ length: 5 }, (_, i) => caps.allowKnock({ phone: `+1417555${2000 + i}` }));
  assert.deepEqual(others, [true, true, true, true, false]);
});

test('every limit can be changed with a variable', () => {
  const caps = makeSiteCaps({ BRIDGE_KNOCKS_PER_NUMBER_PER_DAY: '0', BRIDGE_SIGNUPS_PER_EMAIL_PER_DAY: '1' }, clock().now);
  assert.equal(caps.allowKnock({ phone: '+14175550100' }), false);
  assert.equal(caps.allowSignup({ phone: '+14175550100', email: 'a@x.com' }), true);
  assert.equal(caps.allowSignup({ phone: '+14175550101', email: 'a@x.com' }), false);
});

test('a phone sign-up needs proof the call is real, unless the kill switch is on', async () => {
  assert.equal(unprovenSignupAllowed({}), false);
  assert.equal(unprovenSignupAllowed({ BRIDGE_PHONE_SIGNUP_UNPROVEN: 'yes' }), true);
  // The webhook lane: only Twilio's valid signature on this very request.
  assert.equal(webhookProvenForSignup({ twilioSignatureOk: true }, {}), true);
  assert.equal(webhookProvenForSignup({}, {}), false);
  assert.equal(webhookProvenForSignup(null, {}), false);
  assert.equal(webhookProvenForSignup({}, { BRIDGE_PHONE_SIGNUP_UNPROVEN: '1' }), true);
  // The call socket lane.
  assert.equal(await callerProvenForSignup({ callerVerified: true }, { env: {} }), true);
  assert.equal(await callerProvenForSignup({ callerVerified: false, callerCheck: Promise.resolve(true) }, { env: {} }), false);
  assert.equal(await callerProvenForSignup(null, { env: {} }), false);
  assert.equal(await callerProvenForSignup({ callerVerified: false }, { env: { BRIDGE_PHONE_SIGNUP_UNPROVEN: 'on' } }), true);
  // A lookup still running is waited for, and its answer counts.
  const late = { callerVerified: false };
  late.callerCheck = new Promise((resolve) => setTimeout(() => { late.callerVerified = true; resolve(true); }, 20));
  assert.equal(await callerProvenForSignup(late, { env: {} }), true);
  // One that never answers is not waited for past the limit.
  const stuck = { callerVerified: false, callerCheck: new Promise(() => {}) };
  const t0 = Date.now();
  assert.equal(await callerProvenForSignup(stuck, { env: {}, waitMs: 30 }), false);
  assert.ok(Date.now() - t0 < 1000);
});
