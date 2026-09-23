'use strict';
/* The crash ring's rules, pulled out of server.js so they can be tested
 * (Sep 23 2026, from the phone-app audit). Four problems it fixes:
 *
 *  1. A restart cut the ring to 20 entries (the boot load sliced -20 while
 *     the live cap was 40), by position, so it could throw away crash stacks.
 *     The Sep 22 redeploy took it from 27 to 20.
 *  2. Only 'crash' counted as precious. An Android freeze report ('anr')
 *     would neither alert nor survive eviction.
 *  3. Nothing said which phone a report came from. Android sends platform;
 *     iPhone rows are recognised from their device string with no app change.
 *  4. The spoken cause only understood Apple's MetricKit reports, so an
 *     Android crash would have been "Cause unknown".
 *
 * And one addition: SEATS. Check-ins were the first thing evicted, so a
 * friend who opens the app every few days aged out of the ring and looked
 * like nobody. A small durable table keeps one row per person per platform. */

const ALERT_KINDS = new Set(['crash', 'anr']);
const RING_MAX = 40;
const SEATS_MAX = 300;
const SEAT_DAYS = 180;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function platformOf(b) {
  const p = String((b && b.platform) || '').toLowerCase();
  if (p === 'ios' || p === 'android') return p;
  const device = String((b && b.device) || '');
  if (/android/i.test(device)) return 'android';
  if (/iphone|ipad|\bios\b/i.test(device)) return 'ios';
  return 'unknown';
}

/** Request body → the ring entry. Pure; the caller stamps `at`. */
function normalizeEntry(b, at) {
  b = b || {};
  const entry = {
    at,
    platform: platformOf(b),
    build: String(b.build || '?').slice(0, 24),
    device: String(b.device || '?').slice(0, 64),
    kind: String(b.kind || 'crash').slice(0, 24),
    who: String(b.who || '').slice(0, 80),
    payload: b.payload,
    breadcrumbs: String(b.breadcrumbs || '').slice(0, 4000),
  };
  if (b.appVersion) entry.appVersion = String(b.appVersion).slice(0, 24);
  if (typeof b.install === 'string' && UUID.test(b.install)) entry.install = b.install.toLowerCase();
  return entry;
}

/** Which entry to drop when the ring is over its cap: the oldest that is not a crash or a freeze. */
function evictIndex(ring) {
  const i = ring.findIndex((e) => !ALERT_KINDS.has(e.kind));
  return i >= 0 ? i : 0;
}

function trimRing(ring, max = RING_MAX) {
  while (ring.length > max) ring.splice(evictIndex(ring), 1);
  return ring;
}

/** Boot: keep the whole saved ring up to the live cap, dropping the same way the live path does. */
function loadRing(saved) {
  return Array.isArray(saved) ? trimRing(saved.slice()) : [];
}

function seatKey(entry) {
  return `${entry.platform}|${entry.who || (entry.install ? 'install:' + entry.install : '')}`;
}

/** Check-ins keep a row per person per platform. Returns true when the table changed. */
function updateSeats(seats, entry, nowMs = Date.now()) {
  if (!seats || entry.kind !== 'checkin' || (!entry.who && !entry.install)) return false;
  const key = seatKey(entry);
  const row = seats[key] || { who: entry.who, platform: entry.platform, firstAt: entry.at, launches: 0 };
  Object.assign(row, { who: entry.who || row.who, build: entry.build, device: entry.device, lastAt: entry.at });
  if (entry.appVersion) row.appVersion = entry.appVersion;
  row.launches = (row.launches || 0) + 1;
  seats[key] = row;
  const cutoff = nowMs - SEAT_DAYS * 86400000;
  for (const [k, r] of Object.entries(seats)) if (Date.parse(r.lastAt) < cutoff) delete seats[k];
  const keys = Object.keys(seats);
  if (keys.length > SEATS_MAX) {
    keys.sort((a, b) => Date.parse(seats[a].lastAt) - Date.parse(seats[b].lastAt));
    for (const k of keys.slice(0, keys.length - SEATS_MAX)) delete seats[k];
  }
  return true;
}

function parsed(payload) {
  try { return typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (_) { return null; }
}

/* Kade hears these pushes rather than reads them, so the cause is spoken in
 * plain words. The Apple codes are from Apple's own docs; the fall-through
 * still carries the raw numbers so nothing is lost. */
function crashCausePlain(rawPayload, platform) {
  const p = parsed(rawPayload);
  if (platform === 'android' || (p && p.platform === 'android')) {
    if (!p) return 'Cause unknown';
    if (p.source === 'uncaught') {
      const ex = p.exception || {};
      const cls = String(ex.class || '').split('.').pop();
      const where = String(ex.at || p.lastScreen || '').split('.').pop();
      return `An error in the app's code${cls ? ` (${cls}${where ? ` in ${where}` : ''})` : ''}`;
    }
    if (p.reason === 'anr' || p.source === 'anr') return 'Android said the app stopped responding';
    if (p.reason === 'native' || p.source === 'native') return "A crash in the phone's native code";
    if (p.reason === 'abnormal' || p.source === 'abnormal') return 'Android closed it while it was on screen';
    return 'Cause unknown';
  }
  try {
    const d = p && p.crashDiagnostics && p.crashDiagnostics[0];
    const meta = d && d.diagnosticMetaData;
    if (!meta) return 'Cause unknown';
    const reason = String(meta.terminationReason || '');
    if (/8BADF00D/i.test(reason)) return 'The watchdog killed it — the app stopped answering';
    if (/c00010ff/i.test(reason)) return 'Killed for running too hot';
    if (/dead10cc/i.test(reason)) return 'Killed for holding a file open in the background';
    if (/baddcafe/i.test(reason)) return 'A background task ran out of time';
    if (meta.signal === 6) return 'The app tripped its own assertion and aborted';
    if (meta.signal === 11) return 'A memory fault';
    if (meta.signal === 9) return 'The system force-quit it';
    return `Exception type ${meta.exceptionType ?? '?'}, signal ${meta.signal ?? '?'}`;
  } catch (_) { return 'Cause unknown'; }
}

/** "on Android 2.15" / "" — so a spoken alert says which app without reciting a build number twice. */
function platformPhrase(entry) {
  if (entry.platform === 'android') return `The Android app${entry.appVersion ? ' ' + entry.appVersion : ''}`;
  return '';
}

module.exports = {
  ALERT_KINDS, RING_MAX, platformOf, normalizeEntry, evictIndex, trimRing, loadRing, updateSeats, seatKey,
  crashCausePlain, platformPhrase,
};
