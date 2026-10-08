'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { dataMapFrom } = require('./fcm');

test('a scheduled call carries its account ID through the Android push data', async () => {
  const source = fs.readFileSync(require.resolve('./server'), 'utf8');
  const start = source.indexOf('async function fireCallPlan(');
  const end = source.indexOf('// The web-voice hello calls', start);
  assert.ok(start >= 0 && end > start);

  const sent = [];
  const context = {
    callsEnabled: () => true,
    centralClock: () => ({ day: '2026-10-08', hhmm: '12:00' }),
    callCounts: { day: '2026-10-08', perUser: {} },
    notifyInQuietHours: () => false,
    callPrefs: { perUserDailyCap: 6 },
    tokensForUser: userId => userId === 'account-one' ? ['device-one'] : [],
    ringtoneFileFor: () => 'KadeRingClassic.caf',
    sendPush: async (...args) => { sent.push(args); return { status: 200 }; },
    pushTokens: new Map(),
    savePushTokens: () => {},
    saveCallPlans: () => {},
    console: { log() {}, warn() {} },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  const plan = { id: 'plan-one', userId: 'account-one', agentId: 'della', agentName: 'Della', purpose: 'Check in' };
  const result = await context.fireCallPlan(plan);
  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'device-one');
  const data = dataMapFrom(sent[0][3]);
  assert.equal(data.category, 'KADE_CALL');
  assert.deepEqual(JSON.parse(data.kadeCall), {
    planId: 'plan-one', userId: 'account-one', agentId: 'della', agentName: 'Della', purpose: 'Check in',
  });
});
