'use strict';
/* Part 292 (Sep 25 2026): the call lane scrubs each finished sentence before
 * it is spoken, with the same rules as the fork's chat scrubber. A label
 * sentence scrubs to nothing and is simply not said; the rest stands.
 * Run: node --test scrub-labels.test.js */
const test = require('node:test');
const assert = require('node:assert');
const { stripAiTells } = require('./voice-commands');

test('labels, fragments and lead-ins are not spoken on a call', () => {
  assert.strictEqual(stripAiTells("That's the trap."), '');
  assert.strictEqual(stripAiTells("That's the whole design."), '');
  assert.strictEqual(stripAiTells('Same doll, opposite complaints.'), '');
  assert.strictEqual(stripAiTells("Here's the thing: it doesn't matter who paid."), "It doesn't matter who paid.");
  assert.strictEqual(stripAiTells('Okay, so the whole trick is this: salt first.'), 'Okay, salt first.');
  assert.strictEqual(stripAiTells('Certainly! The bus leaves at six.'), 'The bus leaves at six.');
});

test('people talking are left alone', () => {
  for (const line of [
    "That's the one!",
    "That's the trap they set for tourists, and we walked right into it.",
    "That's the whole reason I called you.",
    "Here's the thing I was telling you about, the lamp.",
    'Of course she did.',
    'Sure, go ahead.',
  ]) {
    assert.strictEqual(stripAiTells(line), line, line);
  }
});
