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

/* Nov 13 2026 (sweep 8.3): reports from CI simulators and other test builds are told apart, so they can
 * be kept off the cap real phones share. */
test('a test build carries the simulator mark; a build number alone is not proof unless the list names it', () => {
  const { isTestBuild } = require('./diagnostics');
  assert.equal(isTestBuild({ platform: 'ios', build: '100', device: 'iPhone iOS 26.5', kind: 'abnormal' }, {}), false, 'build 100 on what may be a real phone: kept');
  assert.equal(isTestBuild({ platform: 'ios', build: '100', device: 'iPhone iOS 26.5', simulator: true }, {}), true, 'the mark');
  assert.equal(isTestBuild({ platform: 'ios', build: '348', simulator: true }, {}), true);
  assert.equal(isTestBuild({ platform: 'ios', build: '348', simulator: 'true' }, {}), true);
  assert.equal(isTestBuild({ platform: 'ios', build: '348', simulator: false }, {}), false);
  assert.equal(isTestBuild({ platform: 'android', build: '126', device: 'Android Simulator x86' }, {}), true, 'a device that names itself');
  assert.equal(isTestBuild({ platform: 'ios', build: '348', device: 'iPhone iOS 27.2.1', kind: 'hang' }, {}), false, 'a released build');
  // The build-number rule is opt-in, iPhone only.
  assert.equal(isTestBuild({ platform: 'ios', build: '100' }, { DIAG_TEST_BUILDS: '100, 777' }), true);
  assert.equal(isTestBuild({ build: 777, device: 'iPhone iOS 26.5' }, { DIAG_TEST_BUILDS: '100, 777' }), true, 'a number, and no platform field (read from the device)');
  assert.equal(isTestBuild({ platform: 'ios', build: '1000' }, { DIAG_TEST_BUILDS: '100' }), false);
  assert.equal(isTestBuild({ platform: 'android', build: '100', device: 'Pixel 9' }, { DIAG_TEST_BUILDS: '100' }), false, 'Android build 100 was a real release number');
  // The whole rule has an off switch.
  assert.equal(isTestBuild({ platform: 'ios', build: '100', simulator: true, device: 'iPhone Simulator' }, { DIAG_TEST_RULE: '0', DIAG_TEST_BUILDS: '100' }), false);
  assert.equal(isTestBuild(null, {}), false);
  assert.equal(isTestBuild({}, {}), false);
});

test('the /diagnostics route: test-build reports never touch the real cap, the ring, the seats or the alert', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const diag = require('./diagnostics');
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const start = src.indexOf('const DIAG_MAX_PER_DAY =');
  const end = src.indexOf('diagRing.push(entry);', start);
  assert.ok(start > 0 && end > start);
  // The head of the handler, up to the point where a real report is kept; closed off so it can run alone.
  const head = src.slice(start, end) + 'kept.push(entry); res.json({ ok: true, kept: true }); } catch (e) { res.status(500).json({ error: e.message }); } });';
  const handlers = new Map();
  const logs = [];
  const ctx = { process: { env: { DIAG_MAX_PER_DAY: '3', DIAG_TEST_MAX_PER_DAY: '2' } }, express: { json: () => null },
    app: { post: (r, _mw, f) => handlers.set(r, f) }, diag, diagDayStamp: '', diagDayCount: 0, diagTestDayCount: 0, kept: [],
    console: { log: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) }, Date, Number, String, Math };
  vm.createContext(ctx);
  vm.runInContext(head, ctx);
  const post = (body) => { let code = 200, out; handlers.get('/diagnostics')({ body }, { status(c) { code = c; return this; }, json(v) { out = v; return this; } }); return { code, out }; };
  const sim = { platform: 'ios', build: '100', device: 'iPhone iOS 26.5', simulator: true, kind: 'abnormal', breadcrumbs: 'private breadcrumb words' };
  const real = { platform: 'ios', build: '348', device: 'iPhone iOS 27.2.1', kind: 'hang' };
  for (let i = 0; i < 50; i++) assert.equal(JSON.stringify(post(sim)), JSON.stringify({ code: 200, out: { ok: true, kept: false, reason: 'test build' } }));
  assert.equal(ctx.kept.length, 0, 'nothing from a test build is kept');
  assert.equal(logs.filter((l) => l.includes('test build, not kept')).length, 2, 'two log lines a day, then silence');
  assert.ok(logs.every((l) => !l.includes('private breadcrumb words')));
  // Fifty simulator reports later, the real cap is untouched: three real reports are kept, the fourth is the cap.
  for (let i = 0; i < 3; i++) assert.equal(post(real).out.kept, true);
  assert.equal(post(real).code, 429);
  assert.equal(ctx.kept.length, 3);

  // DIAG_TEST_MAX_PER_DAY=0 is a real answer (no log line at all), not "use the default".
  const logs0 = [];
  const ctx0 = { process: { env: { DIAG_TEST_MAX_PER_DAY: '0' } }, express: { json: () => null },
    app: { post: (r, _mw, f) => handlers.set(r, f) }, diag, diagDayStamp: '', diagDayCount: 0, diagTestDayCount: 0, kept: [],
    console: { log: (m) => logs0.push(String(m)), warn: (m) => logs0.push(String(m)) }, Date, Number, String, Math };
  vm.createContext(ctx0);
  vm.runInContext(head, ctx0);
  for (let i = 0; i < 5; i++) assert.equal(post(sim).out.kept, false);
  assert.equal(logs0.length, 0);
  assert.equal(ctx0.kept.length, 0);
  // A build-100 report with no simulator mark is a real report: kept, and counted on the real cap.
  assert.equal(post({ platform: 'ios', build: '100', device: 'iPhone iOS 26.5', kind: 'crash' }).out.kept, true);
  assert.equal(ctx0.kept.length, 1);
});
