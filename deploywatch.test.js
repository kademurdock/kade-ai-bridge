'use strict';
/**
 * The bridge's first test file (Part 89). The deploy line is the one thing on
 * /platform-status that Kade cannot check by ear against anything else — if it
 * lies about what shipped, nothing catches it. So it gets a test, and the
 * bridge's harness gate now runs it.
 */
const test = require('node:test');
const assert = require('node:assert');
const { speakDeploys } = require('./deploywatch.js');

const NOW = new Date().toISOString();
const YESTERDAY = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();

test('it says what shipped today, by name and hash', () => {
  const said = speakDeploys({ at: NOW, rows: [
    { name: 'bridge', tip: '61dc6d7a', deployed: '61dc6d7a', status: 'SUCCESS', deployedAt: NOW },
    { name: 'reframe proxy', tip: '79daa96a', deployed: '79daa96a', status: 'SUCCESS', deployedAt: YESTERDAY },
  ] });
  assert.match(said, /Shipped today: bridge at 61dc6d7a\./u);
  assert.doesNotMatch(said, /reframe proxy at/u, "yesterday's deploy is not today's news");
  assert.match(said, /All 2 services are running their branch tips/u);
});

test('a quiet day says so plainly', () => {
  const said = speakDeploys({ at: NOW, rows: [{ name: 'bridge', tip: 'a', deployed: 'a', status: 'SUCCESS', deployedAt: YESTERDAY }] });
  assert.match(said, /Nothing has deployed today/u);
});

test('THE STALE-HASH SCAR: a tip that never deployed is named out loud', () => {
  const said = speakDeploys({ at: NOW, rows: [
    { name: 'LibreChat fork', tip: 'aaaa1111', deployed: 'bbbb2222', status: 'SUCCESS', drifted: true, deployedAt: YESTERDAY },
  ] });
  assert.match(said, /Stale: LibreChat fork's branch tip aaaa1111 never deployed — it is running bbbb2222/u);
  assert.doesNotMatch(said, /running their branch tips/u, 'never claim in sync while something is not');
});

test('a failed deploy outranks the good news', () => {
  const said = speakDeploys({ at: NOW, rows: [{ name: 'bridge', tip: 'c', deployed: 'c', status: 'FAILED', failed: true, deployedAt: NOW }] });
  assert.match(said, /Broken deploy: bridge is FAILED at c/u);
});

test('a service it could not read is admitted, not skipped', () => {
  const said = speakDeploys({ at: NOW, rows: [{ name: 'the harness', error: 'railway HTTP 500' }] });
  assert.match(said, /could not read the harness/u);
});

test('a stale check confesses its own age', () => {
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  assert.match(speakDeploys({ at: old, rows: [{ name: 'bridge', tip: 'a', deployed: 'a', status: 'SUCCESS', deployedAt: old }] }), /180 minutes old/u);
});

test('with nothing measured it says NOTHING — a guessed deploy line is the lie this kills', () => {
  assert.strictEqual(speakDeploys({}), null);
  assert.strictEqual(speakDeploys({ at: NOW, rows: [] }), null);
});

/* ── Part 97: the probe's ears, tested on synthetic WAVs ──────────────────
 * Red-proof: remove the duration floor, the baseline check, or the silence
 * scan from judgeTts/inspectWav and the matching test below fails. */
const { inspectWav, judgeTts } = require('./deploywatch.js');

function makeWav({ seconds, silentFrom = null, silentTo = null, rate = 24000 }) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const silent = silentFrom !== null && t >= silentFrom && t < silentTo;
    // speech-ish: loud enough to clear the 400 peak threshold in every 20ms window
    const v = silent ? 0 : Math.round(6000 * Math.sin(2 * Math.PI * 180 * t) + 1500 * Math.sin(2 * Math.PI * 47 * t));
    data.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii'); header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('inspectWav measures duration and finds a dead-air gap', () => {
  const wav = inspectWav(makeWav({ seconds: 8, silentFrom: 3, silentTo: 7 }));
  assert.ok(Math.abs(wav.durationMs - 8000) < 60, `duration ${wav.durationMs}`);
  assert.ok(wav.longestSilenceMs > 3500 && wav.longestSilenceMs < 4500, `gap ${wav.longestSilenceMs}`);
});

test('inspectWav refuses what it cannot measure', () => {
  assert.strictEqual(inspectWav(Buffer.from('ID3 not a wav at all, some mp3-shaped bytes')), null);
});

test('THE MISSING-MIDDLE EAR: a clip too short for its text fails the floor', () => {
  const v = judgeTts({ durationMs: 2000, longestSilenceMs: 0 }, 180, null);
  assert.strictEqual(v.ok, false);
  assert.match(v.note, /too short for the text/);
});

test('a clip far under its own lane baseline fails even past the floor', () => {
  const v = judgeTts({ durationMs: 5000, longestSilenceMs: 0 }, 180, 10000);
  assert.strictEqual(v.ok, false);
  assert.match(v.note, /under this lane's own baseline/);
});

test('a long dead-air gap fails on its own', () => {
  const v = judgeTts({ durationMs: 12000, longestSilenceMs: 4200 }, 180, 11500);
  assert.strictEqual(v.ok, false);
  assert.match(v.note, /dead-air gap/);
});

test('a healthy clip passes all three ears', () => {
  const v = judgeTts({ durationMs: 11000, longestSilenceMs: 900 }, 180, 11500);
  assert.strictEqual(v.ok, true);
});
