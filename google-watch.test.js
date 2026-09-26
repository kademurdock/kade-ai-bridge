/* google-watch.test.js — Sep 26 2026, Part 295.
 *
 * GOOGLE_LIVE_API_KEY is a prepaid AI Studio key with no balance API. When it runs
 * dry Google answers RESOURCE_EXHAUSTED and, until now, nobody told her. These hold
 * the classifier, the once-every-few-hours alarm, and the spend ledger still.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gwatch-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = DIR;
const gw = require('./google-watch');

test('Google\'s prepayment wording is out of credit; a bare 429 / quota is a limit', () => {
  assert.equal(gw.classifyGoogleTrouble('Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.'), 'credit');
  assert.equal(gw.classifyGoogleTrouble('Billing account is disabled for this project'), 'credit');
  assert.equal(gw.classifyGoogleTrouble('429 RESOURCE_EXHAUSTED Resource has been exhausted (e.g. check quota).'), 'quota');
  assert.equal(gw.classifyGoogleTrouble('You exceeded your current quota, please check your plan and billing details.'), 'quota');
  assert.equal(gw.classifyGoogleTrouble('Unexpected server response: 429'), 'quota');
});

test('ordinary failures are not key trouble and never page her', () => {
  for (const s of ['', null, 'The model is overloaded. Please try again later.', 'socket hang up', 'Request contains an invalid argument.', '1000']) {
    assert.equal(gw.classifyGoogleTrouble(s), null, String(s));
  }
});

test('one push per GOOGLE_ALARM_HOURS, however many calls fail', () => {
  const sent = [];
  gw.setNotifier((body) => { sent.push(body); });
  let state = {};
  const io = { load: () => ({ ...state }), save: (s) => { state = s; } };
  const t0 = Date.parse('2026-09-26T15:00:00Z');
  assert.equal(gw.alarmGoogleKey({ where: 'a Spotter call', kind: 'credit', detail: 'Your prepayment credits are depleted.' }, { now: t0, ...io }), true);
  assert.equal(gw.alarmGoogleKey({ where: 'the media listener', kind: 'quota', detail: '429' }, { now: t0 + 60 * 60 * 1000, ...io }), false, 'an hour later: quiet');
  assert.equal(state.lastTrouble.where, 'the media listener', 'the latest trouble is still on record');
  assert.equal(gw.alarmGoogleKey({ where: 'a Spotter call', kind: 'credit', detail: 'depleted' }, { now: t0 + 4 * 60 * 60 * 1000 + 1, ...io }), true, 'past four hours it may page again');
  return new Promise((r) => setImmediate(r)).then(() => {
    assert.equal(sent.length, 2);
    assert.match(sent[0], /out of credit/);
    assert.match(sent[0], /AI Studio/);
    assert.ok(sent[0].length <= 300, 'fits the per-user push cap');
  });
});

test('GOOGLE_ALARM=0 silences it; no kind means no page', () => {
  let state = {};
  const io = { load: () => ({ ...state }), save: (s) => { state = s; } };
  process.env.GOOGLE_ALARM = '0';
  try {
    assert.equal(gw.alarmGoogleKey({ where: 'x', kind: 'credit', detail: 'd' }, { now: 1, ...io }), false);
  } finally { delete process.env.GOOGLE_ALARM; }
  assert.equal(gw.alarmGoogleKey({ where: 'x', kind: null, detail: 'd' }, { now: 1, ...io }), false);
});

test('the quota push says it may be the balance or the rate limit', () => {
  const body = gw.alarmBody({ where: 'a Spotter call', kind: 'quota', detail: 'Resource has been exhausted' });
  assert.match(body, /limit/);
  assert.match(body, /top it up/);
});

test('the spend ledger adds up per Central day and survives a re-read', () => {
  gw.addGoogleSpend(0.25);
  gw.addGoogleSpend(0.125);
  gw.addGoogleSpend(-3);
  gw.addGoogleSpend(NaN);
  gw.flushGoogleSpend();
  gw.addGoogleSpend(0.5);
  gw.flushGoogleSpend();
  const days = gw.readGoogleDays();
  assert.equal(days[gw.centralDateKey()], 0.875);
  assert.ok(fs.existsSync(path.join(DIR, 'google-days.json')));
});
