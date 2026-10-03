'use strict';

// The keeper alarm observes successful persisted chat writes, not new entry
// creation alone. Historical/unspecified origins are never promoted to live chat.
const KEEPER_SCOPE = 'successful_non_temporary_chat_creates_and_amendments';
const MAX_OBSERVATION_AGE_MS = 10 * 60 * 1000; // twice the health cache's lifetime
const HOUR_MS = 3600 * 1000;

function thresholdHours(value) {
  return Number.isFinite(value) && value > 0 ? value : 30;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const ms = Date.parse(value);
  // Date.parse normalizes impossible calendar dates; those are not evidence.
  return Number.isFinite(ms) && new Date(ms).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z') ? ms : NaN;
}

function unknownKeeper(reason, deadHours = 30) {
  return { coverage: 'unknown', state: 'unknown', reason, scope: KEEPER_SCOPE, deadHours: thresholdHours(deadHours) };
}

function keeperMonitor(data, { now = Date.now(), deadHours = 30 } = {}) {
  const unknown = (reason) => unknownKeeper(reason, deadHours);
  if (!data || data.ok !== true) return unknown('unavailable');
  const diary = data.diary;
  const activity = diary && diary.activity;
  if (!activity) return unknown('no_scoped_activity');
  if (activity.schemaVersion !== 1 || activity.evidence !== 'persisted-successful-writes'
      || diary.keeperMetricScope !== KEEPER_SCOPE) return unknown('unsupported_activity');
  const observedMs = timestamp(activity.generatedAt);
  if (!Number.isFinite(now) || !Number.isFinite(observedMs) || observedMs > now) return unknown('invalid_observation');
  if (now - observedMs > MAX_OBSERVATION_AGE_MS) return unknown('stale_observation');
  const live = activity.byOrigin && activity.byOrigin.live_chat;
  if (!live || typeof live !== 'object') return unknown('no_live_baseline');
  const dates = [live.lastCreatedAt, live.lastAmendedAt, live.lastWriteAt];
  if (dates.every((date) => date === null)) return unknown('no_live_baseline');
  const times = dates.map((date) => date === null ? null : timestamp(date));
  if (!Number.isInteger(live.entries) || live.entries <= 0
      || times.some((ms) => ms !== null && (!Number.isFinite(ms) || ms > observedMs || ms > now))) return unknown('invalid_live_activity');
  const writes = times.slice(0, 2).filter((ms) => ms !== null);
  if (!writes.length || times[2] !== Math.max(...writes)) return unknown('invalid_live_activity');
  const newestMs = Math.max(...writes);
  const ageHours = (now - newestMs) / HOUR_MS;
  const floor = thresholdHours(deadHours);
  return {
    coverage: 'known', state: ageHours >= floor ? 'stale' : 'recent',
    scope: KEEPER_SCOPE, observedAt: activity.generatedAt,
    lastWriteAt: new Date(newestMs).toISOString(), ageHours, deadHours: floor,
  };
}

function keeperSpeech(monitor) {
  if (monitor.coverage !== 'known') {
    const details = {
      unavailable: 'the diagnostic is unavailable',
      disabled: 'the diagnostic is disabled',
      stale_observation: 'the diagnostic observation is out of date',
      no_live_baseline: 'there is no confirmed non-temporary chat create or amendment baseline',
      no_scoped_activity: 'confirmed non-temporary chat create and amendment evidence is unavailable',
    };
    return `Memory keeper coverage unknown: ${details[monitor.reason] || 'the diagnostic evidence could not be validated'}.`;
  }
  return `Live memory keeper: last confirmed non-temporary chat create or amendment ${Math.round(monitor.ageHours)} hours ago${monitor.state === 'stale' ? ', beyond the silence threshold' : ''}.`;
}

// Every audience receives its own object. Redaction must never poison the shared
// admin/alarm cache, and response consumers must not be able to mutate it.
function healthForAudience(data, admin = false) {
  if (!data) return data;
  const copy = JSON.parse(JSON.stringify(data));
  delete copy.keeperMonitor;
  if (copy.diary) {
    delete copy.diary.keeperMonitor;
    if (!admin) delete copy.diary.activity;
  }
  return copy;
}

module.exports = { KEEPER_SCOPE, MAX_OBSERVATION_AGE_MS, keeperMonitor, unknownKeeper, keeperSpeech, healthForAudience };
