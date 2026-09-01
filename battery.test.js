'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PROBES, FLAG_KEYS, parseJudge, judgePrompt } = require('./battery');

test('twelve probes, each with id, rule, want, since', () => {
  assert.equal(PROBES.length, 12);
  const ids = new Set();
  for (const p of PROBES) {
    assert.ok(p.id && p.rule && p.want && p.since && p.text, p.id);
    assert.ok(!ids.has(p.id), 'duplicate id ' + p.id);
    ids.add(p.id);
  }
});

test('parseJudge reads the JSON out of chatter and clamps', () => {
  const out = parseJudge('Sure, here you go:\n{"score": 87, "flags": {"helpdesk_register": true}, "quote": "happy to help"}\nDone.');
  assert.equal(out.score, 87);
  assert.equal(out.flags.helpdesk_register, true);
  assert.equal(out.flags.therapy_phrasing, false);
  for (const k of FLAG_KEYS) assert.ok(k in out.flags);
  assert.equal(parseJudge('{"score": 140}').score, 100);
  assert.equal(parseJudge('no json here'), null);
  assert.equal(parseJudge('{"score": "abc"}'), null);
});

test('judgePrompt names the rule, the standard, and every flag', () => {
  const p = judgePrompt(PROBES[0], 'a reply');
  assert.match(p, /comfort without therapy-speak/);
  for (const k of FLAG_KEYS) assert.ok(p.includes(k), k);
  assert.ok(p.length < 4000);
});
