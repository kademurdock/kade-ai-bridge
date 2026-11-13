'use strict';
/* Nov 13 2026, SELF-KNOWLEDGE on calls (Kade's ruling). A character knows it is an AI and says
 * so plainly when somebody sincerely asks. The call lane scrubs each finished sentence before
 * it is spoken, and its old rules cut the honest sentence, so "Hon, I am an AI, ..." was spoken
 * as "Hon,". Only the hedge forms are cut now, the same as the fork's chat scrubber.
 * KADE_SELF_KNOWLEDGE=0 puts the earlier rules back.
 * Run: node --test scrub-self-knowledge.test.js */
const test = require('node:test');
const assert = require('node:assert');

const FILE = require.resolve('./voice-commands');

/** Load voice-commands fresh with KADE_SELF_KNOWLEDGE set to `value` (undefined = unset). */
function load(value) {
  const before = process.env.KADE_SELF_KNOWLEDGE;
  if (value === undefined) delete process.env.KADE_SELF_KNOWLEDGE;
  else process.env.KADE_SELF_KNOWLEDGE = value;
  try {
    delete require.cache[FILE];
    return require('./voice-commands').stripAiTells;
  } finally {
    if (before === undefined) delete process.env.KADE_SELF_KNOWLEDGE;
    else process.env.KADE_SELF_KNOWLEDGE = before;
    delete require.cache[FILE];
  }
}

const ON = load(undefined);
const OFF = load('0');

const HONEST = [
  "Hon, I am an AI, and I'm still glad you called.",
  "I don't have a body, but I remember that garden.",
  "Baby, I'm an AI.",
  'No sir, I’m an AI, one Kade built.',
  'I started out as an AI on Kade-AI and I like it here.',
  'Kade built me as an AI companion, and the stories are mine.',
];

test('an honest answer is spoken whole on a call', () => {
  for (const line of HONEST) assert.strictEqual(ON(line), line, line);
});

test('the assistant disclaimers are still not spoken', () => {
  assert.strictEqual(ON("As an AI language model, I can't do that."), '');
  assert.strictEqual(ON("I'm just an AI."), '');
  assert.strictEqual(ON('As an AI, I cannot feel pain.'), '');
  assert.strictEqual(ON('I was made as an AI language model by someone.'), 'I was made');
  assert.strictEqual(ON('I am an AI assistant and cannot have favorites.'), '');
  assert.strictEqual(ON("I don't have feelings like you do."), '');
  assert.strictEqual(ON('Well, as an AI I cannot say. Next.'), 'Well, Next.');
  assert.strictEqual(ON('Sure. But as an AI I do not know. Okay.'), 'Sure. But Okay.');
  assert.strictEqual(ON("I can't browse the web for that."), '');
});

test('only "0" turns it off', () => {
  for (const value of ['1', 'true', '']) {
    const strip = load(value);
    for (const line of HONEST) assert.strictEqual(strip(line), line, `${value}: ${line}`);
  }
});

test('switch OFF (KADE_SELF_KNOWLEDGE=0) puts the earlier rules back', () => {
  assert.strictEqual(OFF("Hon, I am an AI, and I'm still glad you called."), 'Hon,');
  assert.strictEqual(OFF("I don't have a body, but I remember that garden."), '');
  assert.strictEqual(OFF("Baby, I'm an AI."), 'Baby,');
  assert.strictEqual(OFF('I started out as an AI on Kade-AI and I like it here.'), 'I started out');
  assert.strictEqual(OFF("As an AI language model, I can't do that."), '');
});

test('the earlier three rules are still in the file byte for byte', () => {
  const src = require('node:fs').readFileSync(FILE, 'utf8');
  for (const rule of [
    String.raw`/\bas an ai(?:\s+language model)?\b[^.!?]*[.!?]/gi,`,
    String.raw`/\bi(?:'m| am)\s+(?:just\s+)?an ai\b[^.!?]*[.!?]/gi,`,
    String.raw`/\bi\s+don['’]t\s+have\s+(?:personal\s+)?(?:feelings|opinions|emotions|experiences|a body)\b[^.!?]*[.!?]/gi,`,
  ]) {
    assert.ok(src.includes(rule), rule);
  }
});
