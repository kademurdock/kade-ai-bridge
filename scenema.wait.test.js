'use strict';
/* Part 122 (Sep 3 2026) — the wait is now spoken, so the WORDS are the feature
 * and the words get a test. Bought with a real 98-minute silent hang: her
 * render sat unplaced, the booth said "may need a minute" exactly once, and
 * then said nothing at all until she gave up and pressed Stop. */
const test = require('node:test');
const assert = require('node:assert');
const { _internals } = require('./scenema');
const { waitInfo, saySeconds, QUEUE_TIMEOUT_MS } = _internals;

const agoS = (s) => new Date(Date.now() - s * 1000).toISOString();
const CAP = (o = {}) => ({ ok: true, throttled: 0, idle: 0, initializing: 0, ready: 0, running: 0, ...o });

test('saySeconds speaks, never prints a raw number of seconds past a minute', () => {
  assert.equal(saySeconds(9), '9 seconds');
  assert.equal(saySeconds(60), '1 minute');
  assert.equal(saySeconds(90), '1 minute 30 seconds');
  assert.equal(saySeconds(600), '10 minutes');
  assert.equal(saySeconds(-5), '0 seconds');
});

test('no card free is named as no card free, not as waking up', () => {
  const w = waitInfo({ state: 'queued', submittedAt: agoS(120) }, CAP({ throttled: 1 }));
  assert.equal(w.phase, 'no-card');
  assert.match(w.spoken, /None are free right now/);
  assert.match(w.spoken, /nothing has started/);
});

test('a booting card says six minutes, because that is the measured number', () => {
  const w = waitInfo({ state: 'queued', submittedAt: agoS(60) }, CAP({ initializing: 1 }));
  assert.equal(w.phase, 'waking');
  assert.match(w.spoken, /waking up/);
  assert.match(w.spoken, /about six minutes/);
});

test('every unfinished line carries elapsed time and a give-up promise', () => {
  for (const cap of [CAP({ throttled: 1 }), CAP({ initializing: 1 }), CAP()]) {
    const w = waitInfo({ state: 'queued', submittedAt: agoS(45) }, cap);
    assert.match(w.spoken, /45 seconds so far/, w.spoken);
    assert.match(w.spoken, /I give up in/, w.spoken);
    assert.equal(w.waitedS, 45);
  }
});

test('the give-up countdown counts DOWN and never goes negative', () => {
  const early = waitInfo({ state: 'queued', submittedAt: agoS(60) }, CAP());
  const late = waitInfo({ state: 'queued', submittedAt: agoS(QUEUE_TIMEOUT_MS / 1000 - 60) }, CAP());
  const over = waitInfo({ state: 'queued', submittedAt: agoS(QUEUE_TIMEOUT_MS / 1000 + 300) }, CAP());
  assert.match(early.spoken, /I give up in 9 minutes/);
  assert.match(late.spoken, /I give up in 1 minute/);
  assert.match(over.spoken, /Giving up now/);
  assert.doesNotMatch(over.spoken, /-/);
});

test('a running job stops talking about cards and reports progress', () => {
  const w = waitInfo({ state: 'running', submittedAt: agoS(200), startedAt: agoS(30) }, CAP({ running: 1 }));
  assert.equal(w.phase, 'rendering');
  assert.match(w.spoken, /^Rendering now\./);
  assert.doesNotMatch(w.spoken, /give up/);
});

test('a started job is rendering even if state lags behind startedAt', () => {
  const w = waitInfo({ state: 'queued', submittedAt: agoS(400), startedAt: agoS(5) }, CAP());
  assert.equal(w.phase, 'rendering');
});

test('an unreadable endpoint falls back to plain queued, never to a guess', () => {
  const w = waitInfo({ state: 'queued', submittedAt: agoS(30) }, { ok: false, throttled: 0, idle: 0, initializing: 0, ready: 0, running: 0 });
  assert.equal(w.phase, 'queued');
  assert.doesNotMatch(w.spoken, /None are free/);
  assert.doesNotMatch(w.spoken, /waking up/);
});
