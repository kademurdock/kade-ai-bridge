'use strict';
/* Nov 26 2026: the fake-row cleanup script, run only against a made-up file in a temp folder. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, plan, safeText } = require('./remove-fake-users-20261126');

const ROWS = {
  '+14175550142': { name: 'Kade', agentId: 'a', agentName: 'Della', lcEmail: 'k@example.test', lcPassEnc: 'v1:x:y:z' },
  '+14155551234': { name: 'AuditProbe', agentId: 'a', agentName: 'Kiana' },
  '+14155557777': { name: 'AuditProbe2', agentId: 'a', agentName: 'Kiana' },
  '+15550001111': { name: 'Mallory Probe7979', agentId: 'a', agentName: 'Kiana' },
  '+15550002222': { name: 'pentest-i6575', agentId: 'a', agentName: 'Kiana', lcEmail: 'p@example.test' },
  '+14175550134': { name: 'Destiny', agentId: 'a', agentName: 'Kiana' },
  '+14175550101': { name: 'Destiny', agentId: 'a', agentName: 'Kiana' },
  '+15550003333': { name: 'probe-other', agentId: 'a', agentName: 'Kiana' },
};

function withFile(rows, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-users-test-'));
  const file = path.join(dir, 'bridge-users.json');
  fs.writeFileSync(file, JSON.stringify(rows));
  try { return fn({ dir, file }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('the plan removes exactly the four fake rows and leaves the Destiny rows and everyone else', () => {
  const p = plan(ROWS);
  assert.deepEqual(p.remove.map((r) => r.phone).sort(), ['+14155551234', '+14155557777', '+15550001111', '+15550002222']);
  assert.deepEqual(p.leftAlone.map((r) => r.phone), ['+14175550134', '+14175550101']);
  assert.deepEqual(p.lookAt.map((r) => r.phone), ['+15550003333'], 'other test-looking rows are only reported');
});

test('a fixed number whose row has a real name is kept', () => {
  const p = plan({ '+14155551234': { name: 'Aunt May' } });
  assert.equal(p.remove.length, 0);
  assert.match(p.skipped[0].why, /kept/);
});

test('the look-only run changes nothing and prints numbers and names only', () => {
  withFile(ROWS, ({ dir, file }) => {
    const lines = [];
    assert.equal(run(['--file', file], {}, (l) => lines.push(l)), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ROWS);
    assert.deepEqual(fs.readdirSync(dir), ['bridge-users.json'], 'no backup files on a look-only run');
    const text = lines.join('\n');
    assert.match(text, /\+15550001111 {2}"Mallory Probe7979"/);
    assert.doesNotMatch(text, /example\.test|v1:x/, 'no emails or passwords printed');
  });
});

test('--apply backs up first, then removes exactly those rows', () => {
  withFile(ROWS, ({ dir, file }) => {
    assert.equal(run(['--file', file, '--apply'], {}, () => {}), 0);
    const left = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(left).sort(), ['+14175550101', '+14175550134', '+14175550142', '+15550003333']);
    assert.deepEqual(left['+14175550142'], ROWS['+14175550142'], 'a real row is byte for byte the same');
    const files = fs.readdirSync(dir);
    const removed = files.find((f) => f.startsWith('bridge-users.removed-'));
    const full = files.find((f) => f.startsWith('bridge-users.before-removal-'));
    assert.ok(removed && full);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, removed), 'utf8'))).length, 4);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, full), 'utf8')), ROWS);
    assert.equal(run(['--file', file], {}, () => {}), 0, 'a second look finds nothing to remove');
    assert.equal(plan(left).remove.length, 0);
  });
});

test('with no file and no volume it refuses', () => {
  assert.equal(run([], {}, () => {}), 2);
});

test('odd characters in a stranger\'s name never reach the terminal', () => {
  assert.equal(safeText('a\u001b[2Jb\n'), 'a?[2Jb?');
});
