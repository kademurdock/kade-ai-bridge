'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('an FCM registration token is recognised and an APNs hex token is not', () => {
  const { looksLikeFcmToken } = require('./fcm');
  assert.ok(looksLikeFcmToken('dXk3QmVhY2hHb2F0VG9rZW4:APA91bH' + 'x'.repeat(120)));
  assert.ok(!looksLikeFcmToken('a'.repeat(64)));
  assert.ok(!looksLikeFcmToken('no-colon-here-' + 'y'.repeat(100)));
});

test('unconfigured FCM answers status 0 and never throws (never prunes)', async () => {
  delete process.env.FCM_SERVICE_ACCOUNT_JSON;
  delete require.cache[require.resolve('./fcm')];
  const { sendFcmPush, fcmConfigured } = require('./fcm');
  assert.strictEqual(fcmConfigured(), false);
  const r = await sendFcmPush('abc:def', 'T', 'B');
  assert.strictEqual(r.status, 0);
  assert.match(r.error, /FCM_SERVICE_ACCOUNT_JSON/);
});

test('data map flattens nested APNs-style payloads to strings and carries the category', () => {
  const { dataMapFrom } = require('./fcm');
  const m = dataMapFrom({ category: 'KADE_CALL', data: { kadeCall: { planId: 'p1' }, kadeRoute: 'brief', skip: null } });
  assert.deepStrictEqual(m, { kadeCall: '{"planId":"p1"}', kadeRoute: 'brief', category: 'KADE_CALL' });
});
