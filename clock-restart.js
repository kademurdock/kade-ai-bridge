/* KADE — THE NIGHTLY RESTART WAITS FOR BACKGROUND TASKS (Oct 17 2026).
 *
 * A character can take a paid job into the background (fork services/kadeTasks.js).
 * The clock's memory-hygiene restart is a plain process exit on the fork, so a job
 * running at 10 UTC used to die and the character posted "I lost my place" twenty
 * minutes later. Now the restart job reads the fork's soul-stats first
 * (tasksRunningNow: fresh running jobs, not stale rows) and, while anything runs,
 * waits RETRY_MIN minutes and looks again, inside the restart window only
 * (CLOCK_RESTART_HOUR through CLOCK_RESTART_LAST_HOUR, both UTC, default 10 to 10,
 * so a late restart never lands on the 11:00 files sweep). Still busy when the
 * window closes = no restart today; memory hygiene can miss a night, a job cannot
 * be redone for free. The fork's restart route refuses while busy too, and that
 * answer counts the same as a busy count here (it is the backstop when soul-stats
 * cannot be read).
 *
 * State lives in the clock's own persisted object: clockState.restart = the day
 * it is settled (done, refused for uptime, or skipped), restartNextTry = the
 * earliest next look, restartSkipped = the last day it gave up.
 */
'use strict';

const RETRY_MIN = 5;

function hourEnv(env, name, fallback) {
  const n = parseInt(env[name] ?? '', 10);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

function restartWindow(env = process.env) {
  const startHour = hourEnv(env, 'CLOCK_RESTART_HOUR', 10);
  const lastHour = Math.max(startHour, hourEnv(env, 'CLOCK_RESTART_LAST_HOUR', startHour));
  return { startHour, lastHour };
}

/** Running jobs from a soul-stats answer; null when it does not say. */
function runningFrom(stats) {
  if (!stats || typeof stats !== 'object') return null;
  if (Number.isFinite(stats.tasksRunningNow)) return stats.tasksRunningNow;
  /* An older fork: every running row, stale ones included (the sweep closes those within 25 min). */
  const t = stats.tasks;
  if (t && typeof t === 'object') return (Number(t.running) || 0) + (Number(t['cancel-requested']) || 0);
  return null;
}

/**
 * One clock tick for the restart job. Everything outside is passed in so the rule can be tested.
 * @returns {Promise<{ action: string, running?: number, data?: object }>}
 */
async function restartTick({ now, state, env = process.env, fetchStats, poke, save, log = console.log }) {
  const { startHour, lastHour } = restartWindow(env);
  const day = now.toISOString().slice(0, 10);
  if (state.restart === day) return { action: 'settled' };
  const hour = now.getUTCHours();
  if (hour < startHour || hour > lastHour) return { action: 'outside' };
  if (state.restartNextTry && now.getTime() < Date.parse(state.restartNextTry)) return { action: 'waiting' };

  const windowEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), lastHour + 1);
  const wait = (running, why) => {
    const next = now.getTime() + RETRY_MIN * 60000;
    if (next >= windowEnd) {
      state.restart = day;
      state.restartSkipped = day;
      delete state.restartNextTry;
      save();
      log(`[clock] restart skipped today: ${running} background task(s) still running as the window closes (${why})`);
      return { action: 'skipped', running };
    }
    state.restartNextTry = new Date(next).toISOString();
    save();
    log(`[clock] restart waiting: ${running} background task(s) running (${why}); next look ${state.restartNextTry}`);
    return { action: 'wait', running };
  };

  let running = null;
  try {
    running = runningFrom(await fetchStats());
  } catch (e) {
    log(`[clock] restart: soul-stats unreadable (${e.message}); the fork's own guard decides`);
  }
  if (running > 0) return wait(running, 'soul-stats');

  /* Settled first so a slow answer cannot double-fire; a busy answer un-settles it. */
  state.restart = day;
  delete state.restartNextTry;
  save();
  const data = await poke();
  if (data && data.busy) {
    delete state.restart;
    return wait(Number(data.running) || 1, 'the fork declined');
  }
  log('[clock] restart fired:', JSON.stringify(data).slice(0, 300));
  return { action: data && data.restarted ? 'restarted' : 'declined', data };
}

module.exports = { restartTick, restartWindow, runningFrom, RETRY_MIN };
