'use strict';

/* Synthetic fixed text only. These checks exercise completed replies and literal
 * finished sentences, not model generation or live call handlers. The saved
 * transcript sequence is stripAiTells(scrubTranscriptText(content)). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripAiTells, scrubTranscriptText } = require('./voice-commands');

const weather = "You're right about Friday cooling off. Today is cloudy at 90, feeling like 88. Thursday is 85 with a 50% chance of rain and wind up to 18. Friday is 70, low 59, with a 71% chance of drizzle. Saturday is cloudy at 75, low 56, with little rain expected. Sunday is cloudy at 83. Monday is mostly clear at 77. Tuesday is partly cloudy at 75, low 48. Some relief from this shit, finally.";

const positive = [
  ['plain warmth', 'Hey, you made it. Come sit with me for a minute.'],
  ['casual banter and profanity', 'That bass line is filthy. I want it louder, damn it.'],
  ['specific reaction with how', 'I love how the bass comes in late. It makes the chorus hit harder.'],
  ['specific taste with that', 'I love that song. The bass line is filthy.'],
  ['correction with colon', "You're right: the appointment is Friday at six. I had Thursday written down."],
  ['correction with comma and semicolon', "You're right, it's Friday at six; Thursday was my mistake. I'll change the note."],
  ['amplified correction with substantive answer', "You're absolutely right: 84 divided by 2 is 42. I used the wrong divisor."],
  ['question does not become an agreement', "You're right? Wait, I had it down for Thursday."],
  ['ordinary uncertainty', 'I might be wrong about the start time. The timetable I have says 6:40.'],
  ['correction retaining uncertainty', "You're right: I can't confirm today's delays from this timetable. Check the departure board before you leave."],
  ['full fictional weather coverage and profanity', weather],
  ['diplomatic disagreement', "You're right about the upfront price, but I don't think it's the cheaper choice. Ink is $30 a refill, and the other printer includes two refills."],
  ['warmth tied to specific context', 'I love that you gave me the long version. The deadline changes my answer.'],
  ['sole finished sentence with curly apostrophe', 'You\u2019re right: the meeting is Tuesday at 2:15.'],
  ['sole finished sentence with specific taste', 'I love that song.'],
  ['sole finished sentence with specific reaction', 'I love how the bass comes in late.'],
  ['sole finished sentence with right-handed adjective', 'You’re right-handed, so put the lamp on your left.'],
  ['location answer rather than generic agreement', "You're right next to the exit on this seating map: row B, seat 4. The aisle is on your left."],
  ['complete practical directions', "You're right about needing the longer explanation. Save a copy first, change one setting, then reopen the file. If it fails, restore the copy before trying anything else."],
  ['specific taste followed by dimensions', "I love that 'midnight blue' finish. The small case is 18 inches wide; the large one is 24."],
];

for (const [name, text] of positive) {
  test(`preserves ${name} in speech text and the saved transcript sequence`, () => {
    assert.equal(stripAiTells(text), text);
    assert.equal(stripAiTells(scrubTranscriptText(text)), text);
  });
}

const stock = [
  ['bare acknowledgment', "You're right.", ''],
  ['bare amplified acknowledgment', "You're absolutely right!", ''],
  ['bare praise', 'I love that!', ''],
  ['standalone label', "That's the trap.", ''],
  ['standalone whole-design label', "That's the whole design.", ''],
  ['standalone same/opposite fragment', 'Same doll, opposite complaints.', ''],
  ['existing praise, connective and closer removals', 'Great question! In summary, use the second switch. Hope this helps!', 'Use the second switch.'],
];

for (const [name, text, expected] of stock) {
  test(`retains the bridge removal of ${name}`, () => {
    assert.equal(stripAiTells(text), expected);
  });
}

test('null and undefined remain unchanged', () => {
  assert.equal(stripAiTells(null), null);
  assert.equal(stripAiTells(undefined), undefined);
});

test('empty and other falsy inputs retain the existing contract', () => {
  assert.equal(stripAiTells(''), '');
  assert.equal(stripAiTells(0), 0);
  assert.equal(stripAiTells(false), false);
});

test('truthy nonstrings retain bridge string coercion', () => {
  assert.equal(stripAiTells(42), '42');
  assert.equal(stripAiTells(true), 'True');
  assert.equal(stripAiTells({ toString: () => 'The bus leaves at six.' }), 'The bus leaves at six.');
});

test('the two narrowed leading rules leave a selected fenced example untouched', () => {
  const text = "Example:\n```text\nI love that song.\nYou're right: the number is 42.\n```";
  assert.equal(stripAiTells(text), text);
});

test('existing global bans still affect fences; general fence protection is not added', () => {
  const text = 'Example:\n```text\nAs an AI, I can help.\nKeep the second switch.\n```';
  assert.equal(stripAiTells(text), 'Example:\n```text\n\nKeep the second switch.\n```');
});

test('unused options cannot insert borrowed decoy facts into the completed answer', () => {
  const text = "You're right: the train leaves from platform four at 6:40.";
  const decoy = 'Decoy only: platform nine at 11:25 and a purple whale.';
  const opts = { companion: true, reference: decoy, facts: { borrowed: decoy } };
  const before = JSON.stringify(opts);
  const result = stripAiTells(text, opts);
  assert.equal(result, text);
  assert.equal(result.includes(decoy), false);
  assert.equal(result.includes('purple whale'), false);
  assert.equal(JSON.stringify(opts), before);
  // This establishes deterministic noninsertion, not a model-copying safeguard.
});

test('saved transcript tag and citation cleanup retains the sole corrected answer', () => {
  const text = "%%%neutral%%%You're right: the bus leaves at six. \uE200turn3search0\uE201";
  assert.equal(stripAiTells(scrubTranscriptText(text)), "You're right: the bus leaves at six.");
});
