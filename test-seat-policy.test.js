'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const policy = require('./test-seat-policy');
const src = fs.readFileSync(require.resolve('./server'), 'utf8');
const testUser = '6a6125d73939d20b95251078';

test('review and configured test accounts are isolated; family accounts are not', () => {
  assert.equal(policy.isTestUser(testUser), true);
  assert.equal(policy.isTestUser('6a3cba4d0b0afa92194e42f7'), false);
  assert.equal(policy.isTestUser(null), false);
});

test('final dispatcher prevents test pushes for both platforms and direct tokens', async () => {
  let realSends = 0;
  const ctx = { testSeatPolicy: policy,
    pushTokens: new Map([['review-ios', { userId: testUser, platform: 'ios' }],
      ['test-android', { userId: testUser, platform: 'android' }],
      ['family', { userId: 'family', platform: 'ios' }]]),
    fcm: { looksLikeFcmToken: () => false, sendFcmPush: () => { realSends++; } },
    sendApnsPush: async () => { realSends++; return {status: 200}; },
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(src.indexOf('function sendPush('), src.indexOf('// App posts its device token')), ctx);
  for (const token of ['review-ios', 'test-android']) {
    const result = await ctx.sendPush(token, 'Test', 'never deliver');
    assert.equal(result.sent, 0);
    assert.equal(result.testAccount, true);
    assert.notEqual(result.status, 200);
  }
  assert.equal(realSends, 0);
  assert.equal((await ctx.sendPush('family','Normal','Requested')).status, 200);
  assert.equal(realSends, 1);
});

test('urgent and deferred test sends stop before any delivery state is accessed', async () => {
  const ctx = { testSeatPolicy: policy };
  vm.createContext(ctx);
  const start = src.indexOf('async function runNotify(');
  const end = src.indexOf("app.post('/notify'", start);
  vm.runInContext(src.slice(start, end), ctx);
  for (const opts of [{urgent:true}, {requested:true}, {adminAlert:true}, {broadcast:true}]) {
    const result = await ctx.runNotify({ userId: testUser, ...opts });
    assert.equal(result.sent, 0);
    assert.equal(result.ok, false);
  }
});
