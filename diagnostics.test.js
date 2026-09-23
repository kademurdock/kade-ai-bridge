'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('./diagnostics');

const at = (i) => new Date(Date.UTC(2026, 8, 1) + i * 60000).toISOString();

test('platform comes from the body, else from the device string', () => {
  assert.equal(d.platformOf({ device: 'iPhone iOS 27.0' }), 'ios');
  assert.equal(d.platformOf({ device: 'Samsung SM-S918U Android 14' }), 'android');
  assert.equal(d.platformOf({ platform: 'android', device: '?' }), 'android');
  assert.equal(d.platformOf({ platform: 'windows', device: 'iPad iOS 26' }), 'ios');
  assert.equal(d.platformOf({}), 'unknown');
});

test('entries keep the old fields and add the new ones only when valid', () => {
  const e = d.normalizeEntry({ build: '312', device: 'iPhone iOS 27.0', kind: 'crash', who: 'Kade <k@x>' }, at(0));
  assert.deepEqual(Object.keys(e).sort(), ['at', 'breadcrumbs', 'build', 'device', 'kind', 'payload', 'platform', 'who']);
  assert.equal(e.platform, 'ios');
  const a = d.normalizeEntry({ platform: 'android', appVersion: '2.16 (119)', install: 'ABCDEF01-2345-4678-9abc-def012345678', kind: 'checkin' }, at(1));
  assert.equal(a.appVersion, '2.16 (119)');
  assert.equal(a.install, 'abcdef01-2345-4678-9abc-def012345678');
  assert.equal(d.normalizeEntry({ install: 'not-a-uuid' }, at(2)).install, undefined);
});

test('eviction keeps crashes and freezes', () => {
  const ring = [];
  ring.push({ kind: 'crash' }, { kind: 'anr' });
  for (let i = 0; i < 50; i++) ring.push({ kind: i % 2 ? 'abnormal' : 'checkin' });
  d.trimRing(ring);
  assert.equal(ring.length, 40);
  assert.equal(ring[0].kind, 'crash');
  assert.equal(ring[1].kind, 'anr');
});

test('a restart keeps 40 entries, not 20', () => {
  const saved = Array.from({ length: 40 }, (_, i) => ({ kind: i === 3 ? 'crash' : 'abnormal', at: at(i) }));
  const ring = d.loadRing(saved);
  assert.equal(ring.length, 40);
  assert.equal(d.loadRing(null).length, 0);
  const over = d.loadRing(Array.from({ length: 45 }, (_, i) => ({ kind: i === 0 ? 'crash' : 'checkin' })));
  assert.equal(over.length, 40);
  assert.equal(over[0].kind, 'crash');
});

test('seats remember a quiet friend long after the ring forgets', () => {
  const seats = {};
  const now = Date.UTC(2026, 8, 23);
  const old = d.normalizeEntry({ platform: 'android', kind: 'checkin', who: 'Amber <a@x>', build: '118' }, new Date(now - 10 * 86400000).toISOString());
  assert.ok(d.updateSeats(seats, old, now));
  const ring = [old];
  for (let i = 0; i < 50; i++) {
    const e = d.normalizeEntry({ device: 'iPhone iOS 27.0', kind: 'checkin', who: 'Kade <k@x>' }, at(i));
    ring.push(e);
    d.updateSeats(seats, e, now);
    d.trimRing(ring);
  }
  assert.ok(!ring.includes(old));
  assert.equal(seats['android|Amber <a@x>'].build, '118');
  assert.equal(seats['ios|Kade <k@x>'].launches, 50);
  assert.equal(d.updateSeats(seats, d.normalizeEntry({ kind: 'crash', who: 'x' }, at(0)), now), false);
});

test('seats older than 180 days are dropped', () => {
  const now = Date.UTC(2026, 8, 23);
  const seats = { 'ios|Gone': { who: 'Gone', platform: 'ios', lastAt: new Date(now - 200 * 86400000).toISOString(), launches: 1 } };
  d.updateSeats(seats, d.normalizeEntry({ platform: 'android', kind: 'checkin', who: 'New' }, new Date(now).toISOString()), now);
  assert.deepEqual(Object.keys(seats), ['android|New']);
});

test('Android causes are spoken plainly; Apple ones are unchanged', () => {
  const ex = JSON.stringify({ platform: 'android', source: 'uncaught', exception: { class: 'java.lang.IllegalStateException', at: 'com.x.ChatViewModel' } });
  assert.equal(d.crashCausePlain(ex, 'android'), "An error in the app's code (IllegalStateException in ChatViewModel)");
  assert.equal(d.crashCausePlain({ platform: 'android', reason: 'anr' }, 'android'), 'Android said the app stopped responding');
  assert.equal(d.crashCausePlain({ reason: 'native' }, 'android'), "A crash in the phone's native code");
  assert.equal(d.crashCausePlain('not json', 'android'), 'Cause unknown');
  const apple = { crashDiagnostics: [{ diagnosticMetaData: { terminationReason: 'Namespace RUNNINGBOARD, Code 0x8BADF00D' } }] };
  assert.equal(d.crashCausePlain(apple, 'ios'), 'The watchdog killed it — the app stopped answering');
  assert.equal(d.crashCausePlain(JSON.stringify(apple)), 'The watchdog killed it — the app stopped answering');
  assert.equal(d.platformPhrase({ platform: 'android', appVersion: '2.16' }), 'The Android app 2.16');
  assert.equal(d.platformPhrase({ platform: 'ios' }), '');
});
