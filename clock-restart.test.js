'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { restartTick, restartWindow, runningFrom } = require('./clock-restart');

const at = (iso) => new Date(iso);
function rig({ stats, answer = { ok: true, restarted: true }, statsThrow = false } = {}) {
  const calls = { stats: 0, poke: 0, saves: 0, logs: [] };
  return {
    calls,
    args: {
      env: {},
      fetchStats: async () => {
        calls.stats += 1;
        if (statsThrow) throw new Error('fork asleep');
        return stats;
      },
      poke: async () => {
        calls.poke += 1;
        return typeof answer === 'function' ? answer(calls.poke) : answer;
      },
      save: () => {
        calls.saves += 1;
      },
      log: (...a) => calls.logs.push(a.join(' ')),
    },
  };
}

test('restarts at 10 UTC when nothing is running, once a day', async () => {
  const state = {};
  const { calls, args } = rig({ stats: { tasksRunningNow: 0 } });
  const r = await restartTick({ ...args, now: at('2026-10-18T10:00:30Z'), state });
  assert.equal(r.action, 'restarted');
  assert.equal(calls.poke, 1);
  assert.equal(state.restart, '2026-10-18');
  assert.equal((await restartTick({ ...args, now: at('2026-10-18T10:01:30Z'), state })).action, 'settled');
  assert.equal(calls.poke, 1);
});

test('waits while a background task runs, never poking, then restarts once it is done', async () => {
  const state = {};
  const stats = { tasksRunningNow: 1 };
  const { calls, args } = rig({ stats });
  const first = await restartTick({ ...args, now: at('2026-10-18T10:00:10Z'), state });
  assert.deepEqual(first, { action: 'wait', running: 1 });
  assert.equal(calls.poke, 0);
  assert.equal(state.restart, undefined);
  assert.equal(state.restartNextTry, '2026-10-18T10:05:10.000Z');
  assert.equal((await restartTick({ ...args, now: at('2026-10-18T10:02:00Z'), state })).action, 'waiting');
  assert.equal(calls.stats, 1);
  stats.tasksRunningNow = 0;
  const later = await restartTick({ ...args, now: at('2026-10-18T10:05:20Z'), state });
  assert.equal(later.action, 'restarted');
  assert.equal(calls.poke, 1);
  assert.equal(state.restartNextTry, undefined);
});

test('a task still running as the window closes means no restart today', async () => {
  const state = {};
  const { calls, args } = rig({ stats: { tasksRunningNow: 2 } });
  const r = await restartTick({ ...args, now: at('2026-10-18T10:56:00Z'), state });
  assert.deepEqual(r, { action: 'skipped', running: 2 });
  assert.equal(state.restart, '2026-10-18');
  assert.equal(state.restartSkipped, '2026-10-18');
  assert.equal(calls.poke, 0);
  assert.equal((await restartTick({ ...args, now: at('2026-10-18T10:58:00Z'), state })).action, 'settled');
  /* The next morning starts fresh. */
  assert.equal((await restartTick({ ...args, now: at('2026-10-19T09:59:00Z'), state })).action, 'outside');
});

test('the fork declining because a task started counts as busy and is tried again', async () => {
  const state = {};
  const { calls, args } = rig({
    stats: { tasksRunningNow: 0 },
    answer: (n) => (n === 1 ? { ok: true, restarted: false, busy: true, running: 1 } : { ok: true, restarted: true }),
  });
  const r = await restartTick({ ...args, now: at('2026-10-18T10:00:00Z'), state });
  assert.deepEqual(r, { action: 'wait', running: 1 });
  assert.equal(state.restart, undefined);
  const again = await restartTick({ ...args, now: at('2026-10-18T10:05:00Z'), state });
  assert.equal(again.action, 'restarted');
  assert.equal(calls.poke, 2);
});

test('unreadable soul-stats leaves the decision to the fork, whose guard still holds', async () => {
  const state = {};
  const { calls, args } = rig({ statsThrow: true, answer: { ok: true, restarted: false, busy: true, running: 1 } });
  const r = await restartTick({ ...args, now: at('2026-10-18T10:00:00Z'), state });
  assert.equal(r.action, 'wait');
  assert.equal(calls.poke, 1);
  assert.ok(calls.logs.some((l) => /unreadable/.test(l)));
});

test('outside the window nothing is read or poked; the window can be widened', async () => {
  const state = {};
  const { calls, args } = rig({ stats: { tasksRunningNow: 1 } });
  assert.equal((await restartTick({ ...args, now: at('2026-10-18T11:00:00Z'), state })).action, 'outside');
  assert.equal(calls.stats, 0);
  args.env = { CLOCK_RESTART_HOUR: '10', CLOCK_RESTART_LAST_HOUR: '11' };
  assert.deepEqual(restartWindow(args.env), { startHour: 10, lastHour: 11 });
  assert.equal((await restartTick({ ...args, now: at('2026-10-18T11:00:00Z'), state })).action, 'wait');
});

test('a booted-under-two-hours refusal settles the day, as before', async () => {
  const state = {};
  const { args } = rig({ stats: { tasksRunningNow: 0 }, answer: { ok: true, restarted: false, reason: 'booted <2h ago' } });
  const r = await restartTick({ ...args, now: at('2026-10-18T10:00:00Z'), state });
  assert.equal(r.action, 'declined');
  assert.equal(state.restart, '2026-10-18');
});

test('an older fork without tasksRunningNow falls back to the running rows', () => {
  assert.equal(runningFrom({ tasks: { done: 4, running: 1 } }), 1);
  assert.equal(runningFrom({ tasks: { done: 4 } }), 0);
  assert.equal(runningFrom({ tasksRunningNow: 0, tasks: { running: 3 } }), 0);
  assert.equal(runningFrom(null), null);
});
