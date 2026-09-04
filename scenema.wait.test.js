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

/* Part 123 (Sep 4 2026) — the frozen card. RunPod kept resuming a 4090 pod
 * that never came up; /health said running:1 with the job IN_QUEUE and
 * inProgress 0 for 19½ minutes on her preview, and billed the whole time. */
const { isZombie, ZOMBIE_MS } = _internals;

test('a running worker with nothing in progress and the job still queued past the window is a frozen card', () => {
  assert.equal(isZombie(CAP({ running: 1, inProgress: 0 }), ZOMBIE_MS + 1000), true);
  assert.equal(isZombie(CAP({ running: 1, inProgress: 0 }), ZOMBIE_MS - 1000), false, 'still inside the loading window');
  assert.equal(isZombie(CAP({ running: 1, inProgress: 1 }), ZOMBIE_MS + 1000), false, 'a worker doing a job is not frozen');
  assert.equal(isZombie(CAP({ running: 1, initializing: 1 }), ZOMBIE_MS + 1000), false, 'a booting card is not frozen');
  assert.equal(isZombie(CAP({ running: 0 }), ZOMBIE_MS + 1000), false, 'no worker is a queue problem, not a frozen card');
  assert.equal(isZombie({ ...CAP({ running: 1 }), ok: false }, ZOMBIE_MS + 1000), false, 'an unreadable endpoint is never called frozen');
});

test('a card that is up but loading is named as loading, with the give-up promise', () => {
  const w = waitInfo({ state: 'queued', submittedAt: agoS(60) }, CAP({ running: 1 }));
  assert.equal(w.phase, 'loading');
  assert.match(w.spoken, /loading the voice models/);
  assert.match(w.spoken, /I give up in/);
});

test('past the window the same picture is called stuck and says a restart is coming', () => {
  const w = waitInfo({ state: 'queued', submittedAt: agoS(ZOMBIE_MS / 1000 + 30) }, CAP({ running: 1 }));
  assert.equal(w.phase, 'stuck-card');
  assert.match(w.spoken, /has not taken the job/);
  assert.match(w.spoken, /Restarting it now/);
});

test('after a kick the line says so, counts from the restart, and the give-up clock restarts too', () => {
  const w = waitInfo({ state: 'queued', submittedAt: agoS(400), kickedAt: agoS(20) }, CAP({ running: 1 }));
  assert.equal(w.phase, 'restarted-card');
  assert.match(w.spoken, /froze without taking the job, so I restarted it/);
  assert.match(w.spoken, /20 seconds since the restart/);
  assert.match(w.spoken, /I give up in 9 minutes 40 seconds/, w.spoken);
});
