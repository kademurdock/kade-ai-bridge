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
