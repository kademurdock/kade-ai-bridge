'use strict';

// These observations are accounting evidence, not a provider invoice. Never
// infer a timestamp from dateKey or treat a missing meter as zero dollars.
const TIME_ZONE = 'America/Chicago';
const DAY_MS = 86400000;
const centralFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid report time');
  return date;
}

function centralParts(now = new Date()) {
  const parts = centralFormatter.formatToParts(asDate(now))
    .reduce((result, part) => ((result[part.type] = part.value), result), {});
  return { y: +parts.year, m: +parts.month, d: +parts.day,
    h: +parts.hour, minute: +parts.minute, second: +parts.second };
}

function monthKeyOf(now = new Date(), back = 0) {
  if (!Number.isInteger(back)) throw new RangeError('Month offset must be an integer');
  const { y, m } = centralParts(now);
  const month = new Date(Date.UTC(y, m - 1 - back, 1));
  return `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
}

function parseMonth(key) {
  if (typeof key !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) {
    throw new RangeError('Month must be YYYY-MM');
  }
  const [y, m] = key.split('-').map(Number);
  if (y < 1000) throw new RangeError('Unsupported report year');
  return { y, m };
}

function parseDay(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const [y, m, d] = key.split('-').map(Number);
  const time = Date.UTC(y, m - 1, d);
  return new Date(time).toISOString().slice(0, 10) === key ? { y, m, d, time } : null;
}

// Resolve local midnight by comparing the requested civil time with Chicago
// time. Unlike a fixed offset, this also handles November 1 before fallback.
function centralMidnight(y, m, d) {
  const target = Date.UTC(y, m - 1, d);
  let guess = target + 6 * 3600000;
  for (let attempt = 0; attempt < 4; attempt++) {
    const p = centralParts(new Date(guess));
    const local = Date.UTC(p.y, p.m - 1, p.d, p.h, p.minute, p.second);
    const next = guess + target - local;
    if (next === guess) return guess;
    guess = next;
  }
  throw new RangeError('Could not resolve Chicago midnight');
}

function calendarWindow(monthKey, now = new Date(), closing = false) {
  const { y, m } = parseMonth(monthKey);
  const from = centralMidnight(y, m, 1);
  const toFull = centralMidnight(y, m + 1, 1);
  const current = asDate(now).getTime();
  if (closing && current < toFull) throw new RangeError('Cannot close an unfinished month');
  const to = Math.max(from, Math.min(current, toFull));
  return { month: monthKey, timeZone: TIME_ZONE, from: new Date(from).toISOString(),
    to: new Date(to).toISOString(), endExclusive: true, complete: current >= toFull };
}

function numeric(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function timestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(new Date(value).getTime()) ? value : null;
  // Date-only strings and strings without an offset are not exact instants.
  if (typeof value !== 'string' || !parseDay(value.slice(0, 10)) || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function round(amount) {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function coverage(status, from, to, reason) {
  return { status, from: from == null ? null : new Date(from).toISOString(),
    to: to == null ? null : new Date(to).toISOString(), reason };
}

function counterCost(history, bounds, key, balance = false) {
  const measurement = balance
    ? 'Observed prepaid balance change; top-ups and adjustments are not reconciled.'
    : 'Difference in the cumulative OpenRouter usage counter; not an invoice.';
  const points = (Array.isArray(history) ? history : []).map((row) => {
    if (!row || typeof row !== 'object') return null;
    const at = timestamp(row.at), amount = numeric(row[key]);
    return at != null && amount != null && at >= bounds.from && at <= bounds.to
      ? { at, amount } : null;
  }).filter(Boolean).sort((a, b) => a.at - b.at);
  if (!points.length) return { rawUSD: null, recordedUSD: null, measurement,
    coverage: coverage('unavailable', null, null, 'No usable timestamped meter observations in this window.') };
  const first = points[0], last = points[points.length - 1];
  const unknown = (reason) => ({ rawUSD: null, recordedUSD: null, measurement,
    coverage: coverage('partial', first.at, last.at, reason) });
  if (first.at === last.at) return unknown('Fewer than two distinct observation times; spending is unknown.');
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1], point = points[i];
    if (point.at === previous.at && point.amount !== previous.amount) {
      return unknown('Conflicting values at the same observation time; spending is unknown.');
    }
    if (!balance && (point.amount < previous.amount || point.amount < 0 || previous.amount < 0)) {
      return unknown('Usage counter decreased or reset; spending across the interval is unknown.');
    }
    if (balance && point.amount > previous.amount) {
      return unknown('Balance increased; top-ups or adjustments make spending unknown.');
    }
  }
  const amount = balance ? first.amount - last.amount : last.amount - first.amount;
  const exact = first.at === bounds.from && last.at === bounds.to;
  const reason = balance
    ? 'This is a net balance decrease, not verified spend; unrecorded top-ups and adjustments remain unknown.'
    : exact ? 'Timestamped usage-counter observations match both requested boundaries.'
      : 'Only the observed interval is measured; requested boundary observations are missing.';
  return { rawUSD: balance ? null : amount, recordedUSD: balance ? null : round(amount), measurement,
    ...(balance ? { observedBalanceDecreaseUSD: round(amount) } : {}),
    coverage: coverage(!balance && exact ? 'complete' : 'partial', first.at, last.at, reason) };
}

function dailyCost(days, bounds, window, central) {
  const measurement = central
    ? 'Bridge Google cost estimates in America/Chicago day buckets; partial provider scope, not an invoice.'
    : 'Proxy Z.AI cost estimates in UTC day buckets; not an invoice.';
  const source = days && typeof days === 'object' && !Array.isArray(days)
    ? (days.days && typeof days.days === 'object' ? days.days : days) : {};
  const accepted = [], omitted = [];
  let partialDay = false;
  for (const [key, value] of Object.entries(source)) {
    const day = parseDay(key);
    const amount = numeric(value && typeof value === 'object' ? value.usd : value);
    if (!day || amount == null || amount < 0) continue;
    const from = central ? centralMidnight(day.y, day.m, day.d) : day.time;
    const nextDay = new Date(day.time + DAY_MS);
    const to = central
      ? centralMidnight(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate())
      : from + DAY_MS;
    if (from >= bounds.to || to <= bounds.from) continue;
    if (from >= bounds.from && to <= bounds.to) accepted.push({ from, to, amount });
    else if (central && !window.complete && from >= bounds.from && from < bounds.to && to > bounds.to) {
      accepted.push({ from, to: bounds.to, amount });
      partialDay = true;
    } else omitted.push(key);
  }
  if (!accepted.length) return { rawUSD: null, recordedUSD: null, measurement,
    coverage: coverage('unavailable', null, null,
      omitted.length ? 'Only partially overlapping day buckets exist; they cannot be allocated to this window.'
        : 'No recorded day buckets usable in this window; missing days are unknown, not zero.') };
  accepted.sort((a, b) => a.from - b.from);
  const rawUSD = accepted.reduce((sum, day) => sum + day.amount, 0);
  let reason = central
    ? 'Only bridge-metered Google activity is recorded; other Google usage and missing days remain unknown.'
    : 'Only wholly contained UTC days are recorded; partial UTC days at the Chicago boundaries and missing days are omitted.';
  if (partialDay) reason += ' Includes the current partial Chicago day as an observed ledger amount.';
  if (omitted.length) reason += ` Omitted ${omitted.length} overlapping day bucket(s).`;
  return { rawUSD, recordedUSD: round(rawUSD), measurement,
    coverage: coverage('partial', accepted[0].from, accepted[accepted.length - 1].to, reason) };
}

function providerCosts(history, window, zaiDays = {}, googleDays = {}) {
  if (!window || window.timeZone !== TIME_ZONE || window.endExclusive !== true) {
    throw new RangeError('An exclusive America/Chicago calendar window is required');
  }
  const bounds = { from: timestamp(window.from), to: timestamp(window.to) };
  if (bounds.from == null || bounds.to == null || bounds.to < bounds.from) {
    throw new RangeError('Invalid provider accounting window');
  }
  const usagePresent = (Array.isArray(history) ? history : []).some((row) => {
    const at = row && timestamp(row.at);
    return at != null && at >= bounds.from && at <= bounds.to && numeric(row.openrouter_usage) != null;
  });
  const observed = {
    moonshot: counterCost(history, bounds, 'moonshot', true),
    openrouter: counterCost(history, bounds, usagePresent ? 'openrouter_usage' : 'openrouter', !usagePresent),
    zai: dailyCost(zaiDays, bounds, window, false),
    google: dailyCost(googleDays, bounds, window, true),
  };
  const available = Object.values(observed).filter((provider) => provider.rawUSD != null);
  const complete = Object.values(observed).every((provider) => provider.coverage.status === 'complete');
  const recordedUSD = available.length ? round(available.reduce((sum, provider) => sum + provider.rawUSD, 0)) : null;
  const providers = Object.fromEntries(Object.entries(observed).map(([key, provider]) => {
    const { rawUSD, ...publicProvider } = provider;
    return [key, publicProvider];
  }));
  const ranges = Object.values(providers).map((provider) => provider.coverage).filter((entry) => entry.from != null);
  return { providers, recordedUSD, complete,
    coverage: coverage(complete ? 'complete' : available.length || ranges.length ? 'partial' : 'unavailable',
      ranges.length ? Math.min(...ranges.map((entry) => Date.parse(entry.from))) : null,
      ranges.length ? Math.max(...ranges.map((entry) => Date.parse(entry.to))) : null,
      complete ? 'All provider categories cover the requested window.'
        : 'Observed provider subtotal only; incomplete scopes and intervals cannot establish the full provider cost.') };
}

module.exports = { monthKeyOf, centralParts, calendarWindow, providerCosts };
