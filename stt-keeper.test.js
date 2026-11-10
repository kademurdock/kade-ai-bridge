'use strict';
/* stt-keeper.test.js — Nov 10 2026. A Deepgram socket that drops mid-call is opened again when the
 * caller's next audio arrives, paced, and the caller is told when it will not hold. Fake sockets
 * and a fake clock; nothing here opens a connection. */
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { createSttKeeper, sttKeeperConfig, TROUBLE_LINE, BACK_LINE } = require('./stt-keeper');

class FakeSocket extends EventEmitter {}
const quiet = { log() {}, warn() {} };

function rig(over = {}) {
  const r = { t: 1000, opened: [], trouble: 0, back: 0, callOpen: true, canOpen: true };
  r.keeper = createSttKeeper({
    openSocket: () => { if (!r.canOpen) return null; const s = new FakeSocket(); r.opened.push(s); return s; },
    isCallOpen: () => r.callOpen,
    onTrouble: () => { r.trouble += 1; },
    onBack: () => { r.back += 1; },
    now: () => r.t, log: quiet,
    cfg: { ...sttKeeperConfig({}), ...over },
  });
  r.first = new FakeSocket();
  r.keeper.watch(r.first);
  return r;
}

test('on by default; STT_RECONNECT=0 is the off switch', () => {
  assert.equal(sttKeeperConfig({}).enabled, true);
  assert.equal(sttKeeperConfig({ STT_RECONNECT: '0' }).enabled, false);
});

test('a healthy socket is left alone: audio arriving never opens a second one', () => {
  const r = rig();
  r.first.emit('open');
  for (let i = 0; i < 50; i++) { r.t += 20; assert.equal(r.keeper.frame(), null); }
  assert.equal(r.opened.length, 0);
});

test('a socket still connecting at the start of the call is not replaced', () => {
  const r = rig();
  assert.equal(r.keeper.frame(), null);
  assert.equal(r.opened.length, 0);
});

test('THE DROP: the socket closes mid-call and the very next piece of audio opens a new one', () => {
  const r = rig();
  r.first.emit('open');
  r.t += 5 * 60 * 1000;
  r.first.emit('close');
  r.t += 20;
  const fresh = r.keeper.frame();
  assert.ok(fresh, 'a new socket');
  assert.equal(r.opened.length, 1);
  assert.equal(r.keeper.frame(), null, 'and only one: the next frame finds it connecting');
  fresh.emit('open');
  assert.equal(r.keeper.frame(), null);
  assert.equal(r.trouble, 0, 'one clean drop is not worth a word to the caller');
});

test('no audio flowing means no reconnecting: a closed socket by itself opens nothing', () => {
  const r = rig();
  r.first.emit('open');
  r.first.emit('close');
  r.t += 10 * 60 * 1000;
  assert.equal(r.opened.length, 0);
});

test('tries are paced: at once, then 0.7 s, 2 s and 5 s apart', () => {
  const r = rig();
  r.first.emit('close'); // never even opened
  const tryAt = [];
  const t0 = r.t;
  for (let ms = 0; ms <= 9000; ms += 20) {
    r.t = t0 + ms;
    const s = r.keeper.frame();
    if (s) { tryAt.push(ms); s.emit('close'); } // each one fails at once
  }
  assert.deepEqual(tryAt, [0, 700, 2700, 7700]);
});

test('WHEN IT WILL NOT HOLD: after four failed tries the caller is told once, and tries go on every 15 s without another word', () => {
  const r = rig();
  r.first.emit('close');
  const t0 = r.t;
  for (let ms = 0; ms <= 70000; ms += 20) {
    r.t = t0 + ms;
    const s = r.keeper.frame();
    if (s) s.emit('close');
  }
  assert.equal(r.trouble, 1, 'told once');
  assert.equal(r.back, 0);
  assert.ok(r.opened.length >= 7 && r.opened.length <= 9, `kept trying slowly (${r.opened.length} tries in 70 s)`);
});

test('IT COMES BACK: after the caller was told, a socket that opens and holds is announced', async () => {
  const r = rig();
  r.first.emit('close');
  const t0 = r.t;
  // Every try fails at once until the caller has been told; the try after that is `last`.
  let last = null;
  for (let ms = 0; ms <= 60000 && !last; ms += 20) {
    r.t = t0 + ms;
    const s = r.keeper.frame();
    if (!s) continue;
    if (r.trouble === 0) s.emit('close');
    else last = s;
  }
  assert.ok(last, 'a try was made after the caller was told');
  assert.equal(r.trouble, 1);
  last.emit('open'); // this one works
  await new Promise((res) => setTimeout(res, 1700));
  assert.equal(r.back, 1);
  assert.equal(r.keeper.state.tries, 0, 'and the count is clean for the next bad spell');
});

test('a socket that opens and falls straight over again is not announced as back', async () => {
  const r = rig();
  r.first.emit('close');
  const t0 = r.t;
  // Every try fails at once until the caller has been told; the try after that is `last`.
  let last = null;
  for (let ms = 0; ms <= 60000 && !last; ms += 20) {
    r.t = t0 + ms;
    const s = r.keeper.frame();
    if (!s) continue;
    if (r.trouble === 0) s.emit('close');
    else last = s;
  }
  assert.ok(last, 'a try was made after the caller was told');
  last.emit('open');
  last.emit('close');
  await new Promise((res) => setTimeout(res, 1700));
  assert.equal(r.back, 0);
});

test('a socket that held ten seconds resets the count: three drops an hour apart never tell the caller anything', () => {
  const r = rig();
  r.first.emit('open');
  let cur = r.first;
  for (let i = 0; i < 6; i++) {
    r.t += 60 * 60 * 1000;
    cur.emit('close');
    r.t += 20;
    cur = r.keeper.frame();
    assert.ok(cur, `drop ${i + 1} reconnected at once`);
    cur.emit('open');
  }
  assert.equal(r.trouble, 0);
});

test('the call ending is not a drop: after end() a close opens nothing', () => {
  const r = rig();
  r.first.emit('open');
  r.keeper.end();
  r.first.emit('close');
  assert.equal(r.keeper.frame(), null);
  assert.equal(r.opened.length, 0);
});

test('a call whose own socket is gone opens nothing', () => {
  const r = rig();
  r.first.emit('close');
  r.callOpen = false;
  assert.equal(r.keeper.frame(), null);
});

test('STT_RECONNECT=0: a drop is logged and nothing else happens', () => {
  const r = rig({ enabled: false });
  r.first.emit('open');
  r.first.emit('close');
  r.t += 5000;
  assert.equal(r.keeper.frame(), null);
  assert.equal(r.opened.length, 0);
});

test('no socket at all at the start (no key): tries are still paced and the caller is told', () => {
  const r = { t: 1000, trouble: 0, opens: 0 };
  const keeper = createSttKeeper({ openSocket: () => { r.opens += 1; return null; }, isCallOpen: () => true,
    onTrouble: () => { r.trouble += 1; }, now: () => r.t, log: quiet, cfg: sttKeeperConfig({}) });
  keeper.watch(null);
  for (let ms = 0; ms <= 40000; ms += 20) { r.t = 1000 + ms; keeper.frame(); }
  assert.equal(r.trouble, 1);
  assert.ok(r.opens >= 5 && r.opens <= 7, `paced (${r.opens} tries in 40 s)`);
});

test('an old socket closing late does not disturb the new one', () => {
  const r = rig();
  r.first.emit('open');
  r.t += 20000;
  r.first.emit('close');
  const fresh = r.keeper.frame();
  fresh.emit('open');
  r.first.emit('close'); // a stray second close from the old one
  assert.equal(r.keeper.state.down, false);
  assert.equal(r.keeper.frame(), null);
});

test('the two lines the caller can hear are plain', () => {
  assert.match(TROUBLE_LINE, /trouble hearing you/);
  assert.match(TROUBLE_LINE, /hang up and call back/);
  assert.match(BACK_LINE, /hear you again/);
});
