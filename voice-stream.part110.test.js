/* voice-stream.part110.test.js — Aug 31 2026, Part 110.
 *
 * Three things shipped tonight on this file and each gets covered here:
 *   1. the room gate (auto barge-in on the app surface without the July-24 bug)
 *   2. the two-level piece floor (the phone lane's speech gaps)
 *   3. the surface line (an app call is not a phone call)
 *
 * Same extraction pattern as voice-stream.carry.test.js: the SHIPPED source is
 * pulled out of the real file and run, never transcribed. A transcription test
 * passes against code that was never deployed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const { EventEmitter } = require('node:events');

const SRC = fs.readFileSync(require.resolve('./voice-stream.js'), 'utf8');

function grab(anchor, endAnchor) {
  const a = SRC.indexOf(anchor);
  assert.ok(a > -1, `anchor not found: ${anchor.slice(0, 50)}`);
  const b = SRC.indexOf(endAnchor, a);
  assert.ok(b > -1, `end anchor not found: ${endAnchor.slice(0, 50)}`);
  return SRC.slice(a, b + endAnchor.length);
}

const ctx = {
  String, Set, Boolean, parseInt, parseFloat, Array, Date, Math, Number,
  EventEmitter, console,
  process: { env: {} },
};
vm.createContext(ctx);

// ── the barge-in stack, from normalizeWords through shouldBargeIn ─────────────
vm.runInContext(
  grab('function normalizeWords(s) {', '// ── SentenceStreamer') +
    '\nthis.looksLikeEcho = looksLikeEcho;' +
    '\nthis.isPlausibleBargeIn = isPlausibleBargeIn;' +
    '\nthis.looksLikeScreenReader = looksLikeScreenReader;' +
    '\nthis.meanWordConfidence = meanWordConfidence;' +
    '\nthis.passesRoomGate = passesRoomGate;' +
    '\nthis.shouldBargeIn = shouldBargeIn;',
  ctx,
);
// ── the sentence streamer ────────────────────────────────────────────────────
vm.runInContext(
  grab('const PHONE_FIRST_PIECE_CHARS', '\n// ── μ-law helpers') +
    '\nthis.SentenceStreamer = SentenceStreamer;' +
    '\nthis.PHONE_FIRST_PIECE_CHARS = PHONE_FIRST_PIECE_CHARS;' +
    '\nthis.PHONE_MIN_PIECE_CHARS = PHONE_MIN_PIECE_CHARS;',
  ctx,
);
// ── the surface line ─────────────────────────────────────────────────────────
vm.runInContext(
  grab('function surfaceLine(session) {', '\n}') + '\nthis.surfaceLine = surfaceLine;',
  ctx,
);

const {
  looksLikeScreenReader, meanWordConfidence, passesRoomGate, shouldBargeIn,
  SentenceStreamer, PHONE_FIRST_PIECE_CHARS, PHONE_MIN_PIECE_CHARS, surfaceLine,
} = ctx;

/** A session that is mid-reply and past the grace window — the only state in
 *  which barge-in is even considered. */
function speakingSession(over = {}) {
  return {
    bargeMode: 'auto',
    isSpeaking: true,
    bargedIn: false,
    speakStartedAt: Date.now() - 5000,
    _currentSpokenText: 'so the way the permit test works in Missouri is',
    surface: 'web',
    ...over,
  };
}
const conf = (n, c) => Array.from({ length: n }, () => ({ confidence: c }));

// ═══ 1. THE ROOM GATE ════════════════════════════════════════════════════════

test('a real interruption still cuts her off on the app surface', () => {
  assert.equal(shouldBargeIn(speakingSession(), 'wait hold on', conf(3, 0.95)), true);
});

test('the first confident word alone is enough — her ask was "the first word"', () => {
  assert.equal(shouldBargeIn(speakingSession(), 'wait', conf(1, 0.95)), true);
});

test('VoiceOver reading our own buttons never counts as the caller talking', () => {
  for (const chrome of [
    'Mute microphone, button',
    'Stop talking button',
    'Hang up, button',
    'Deep Think, button',
    'double tap to activate',
  ]) {
    assert.equal(looksLikeScreenReader(chrome), true, chrome);
    assert.equal(shouldBargeIn(speakingSession(), chrome, conf(3, 0.99)), false, chrome);
  }
});

test('a person actually TALKING about a button is not screen-reader chrome', () => {
  const heard = 'okay so which button do I press to send you the picture';
  assert.equal(looksLikeScreenReader(heard), false);
  assert.equal(shouldBargeIn(speakingSession(), heard, conf(11, 0.9)), true);
});

test('low-confidence mush from a TV across the room is refused', () => {
  assert.equal(shouldBargeIn(speakingSession(), 'the other thing', conf(3, 0.30)), false);
});

test('a LONE low-confidence word is refused even when it is on the allow-list', () => {
  // A lone word off a TV is the classic false positive, so it carries the
  // higher bar. The same word said clearly by the caller still gets through.
  assert.equal(shouldBargeIn(speakingSession(), 'stop', conf(1, 0.60)), false);
  assert.equal(shouldBargeIn(speakingSession(), 'stop', conf(1, 0.90)), true);
});

test('MISSING confidence data passes — a gate must never fail closed', () => {
  // This is the whole bug being fixed: a barge-in that silently never fires.
  assert.equal(meanWordConfidence(undefined), null);
  assert.equal(meanWordConfidence([]), null);
  assert.equal(meanWordConfidence([{ word: 'hi' }]), null);
  assert.equal(passesRoomGate('wait hold on', undefined), true);
  assert.equal(shouldBargeIn(speakingSession(), 'wait hold on', undefined), true);
});

test('the PHONE surface never pays the room gate — a handset is not a living room', () => {
  const phone = speakingSession({ surface: 'phone' });
  assert.equal(shouldBargeIn(phone, 'the other thing', conf(3, 0.30)), true);
});

test('push mode still means the Stop button and nothing else', () => {
  assert.equal(shouldBargeIn(speakingSession({ bargeMode: 'push' }), 'wait hold on', conf(3, 0.99)), false);
});

test('her own voice coming back through the speaker is still not an interruption', () => {
  const heard = 'the way the permit test works in Missouri';
  assert.equal(shouldBargeIn(speakingSession(), heard, conf(7, 0.99)), false);
});

test('the grace window and the once-per-reply flag both still hold', () => {
  assert.equal(shouldBargeIn(speakingSession({ speakStartedAt: Date.now() }), 'wait', conf(1, 0.99)), false);
  assert.equal(shouldBargeIn(speakingSession({ bargedIn: true }), 'wait', conf(1, 0.99)), false);
  assert.equal(shouldBargeIn(speakingSession({ isSpeaking: false }), 'wait', conf(1, 0.99)), false);
});

// ═══ 2. THE TWO-LEVEL PIECE FLOOR ════════════════════════════════════════════

function pieces(text, { chunk = 12 } = {}) {
  const st = new SentenceStreamer();
  const out = [];
  st.on('sentence', (s) => out.push(s));
  for (let i = 0; i < text.length; i += chunk) st.push(text.slice(i, i + chunk));
  st.end();
  return out;
}

test('the floors are the measured numbers, not invented ones', () => {
  assert.equal(PHONE_FIRST_PIECE_CHARS, 60);
  assert.equal(PHONE_MIN_PIECE_CHARS, 160);
});

test('THE BUG: consecutive short sentences no longer each become their own synth', () => {
  // Six short sentences. Before Part 110 every one over 24 chars shipped alone,
  // and each was a network round trip the listener waited out.
  const reply =
    'Round one is done. You got that one right. Nice work there. ' +
    'Next up is the helmet rule. That one trips people up. Take your time.';
  const out = pieces(reply);
  assert.ok(out.length <= 3, `expected merging, got ${out.length}: ${JSON.stringify(out)}`);
  for (const p of out.slice(1, -1)) {
    assert.ok(p.length >= PHONE_MIN_PIECE_CHARS, `piece under the floor: ${JSON.stringify(p)}`);
  }
});

test('the OPENER keeps its head start — it is never measured against the big floor', () => {
  const reply =
    'Hey, good to hear from you this morning. ' +   // 40 chars: under 60, absorbs
    'I was just thinking about that permit test of yours and how it went. ' +
    'So tell me everything, start to finish, because I want the whole story.';
  const out = pieces(reply);
  assert.ok(out.length >= 2, 'the opener must not swallow the whole reply');
  // The first piece clears the SMALL floor and stops there — Forge's catch in
  // 92.12: if the opener were measured against 160 it would absorb sentence two
  // and the fast start would be silently gone.
  assert.ok(out[0].length < PHONE_MIN_PIECE_CHARS,
    `the opener took the big floor: ${JSON.stringify(out[0])}`);
  assert.ok(out[0].length >= 40, `the opener is too small to be worth a call: ${JSON.stringify(out[0])}`);
});

test('a long first sentence still goes out immediately — no added latency', () => {
  const long = 'Okay so the thing about the Missouri motorcycle permit is that it pulls from a pretty predictable pool of questions. ';
  const out = pieces(long + 'Here comes the next part of it now.');
  assert.equal(out[0], long.trim());
});

test('nothing is ever LOST — the tail flushes even when it is under the floor', () => {
  const reply = 'This is a long enough opening sentence to clear the small opener floor easily. Bye.';
  const out = pieces(reply);
  assert.equal(out.join(' ').replace(/\s+/g, ' '), reply.replace(/\s+/g, ' '));
});

test('the July-4 lessons are all still taught', () => {
  // numbered list markers do not split
  const list = 'Here are the ones you missed on the practice run just now:\n  1. Getting the helmet age wrong every time.\n  2. Forgetting the two second rule.';
  assert.ok(!pieces(list).some((p) => /^\d+\.$/.test(p.trim())), 'a list marker split off alone');
  // abbreviations do not split
  assert.ok(!pieces('You want to talk to Dr. Reyes about that before the test on Monday morning, okay?')
    .some((p) => p.trim().endsWith('Dr.')), 'split on an abbreviation');
  // decimals do not split
  assert.ok(!pieces('The fee is 12.50 for the permit and you pay it when you show up at the office.')
    .some((p) => p.trim().endsWith('12.')), 'split on a decimal');
});

// ═══ 3. THE SURFACE LINE ═════════════════════════════════════════════════════

test('an app call is told it is an app call; a phone call is told nothing new', () => {
  const web = surfaceLine({ surface: 'web' });
  assert.match(web, /inside the Kade-AI app, not a telephone/);
  assert.match(web, /VoiceOver/);
  assert.equal(surfaceLine({ surface: 'phone' }), '');
});

test('the [PHONE CALL marker reframe greps for is still intact in the shipped file', () => {
  // reframe-proxy's isPhoneTurn() and the Deep Think override both hang off
  // this literal string. If a future edit "fixes" the wording, both die quietly.
  const vc = fs.readFileSync(require.resolve('./voice-commands.js'), 'utf8');
  assert.ok(vc.includes('[PHONE CALL'), 'PHONE_SUFFIX lost the marker reframe greps for');
  assert.ok(!surfaceLine({ surface: 'web' }).includes('[PHONE CALL'),
    'the surface line must not add a second marker');
});

// ═══ 4. THE GOODBYE BUG (found by the test above, live before tonight) ═══════

test('a four-character goodbye is no longer swallowed', () => {
  // Watched fail against the SHIPPED file first: "…easily. Bye." emitted only
  // "…easily.", and "…for real. Yes." only "…for real." The boundary was
  // exactly `length > 4`, so it ate Bye./Yes./Yep./OK! and spared Nice.
  for (const tail of ['Bye.', 'Yes.', 'Yep.', 'OK!']) {
    const reply = `This is a long enough opening sentence to clear the small opener floor easily. ${tail}`;
    const out = pieces(reply);
    assert.ok(out.join(' ').includes(tail), `lost the tail ${JSON.stringify(tail)}: ${JSON.stringify(out)}`);
  }
});

test('but pure punctuation is still never handed to the synthesiser', () => {
  assert.deepEqual(pieces('...'), []);
  assert.deepEqual(pieces('?!'), []);
});

// ═══ 5. THE CARRY SAYS STOP OUT LOUD ON THE PHONE LANE TOO (Part 110 addendum) ═

const carryCtx = { String, Set, Boolean, parseInt, parseFloat, Array, process: { env: {} } };
vm.createContext(carryCtx);
vm.runInContext(
  grab('const CANONICAL_SOUNDS = [', 'return sentence;\n}') +
    '\nthis.applyDirectionCarry = applyDirectionCarry;',
  carryCtx,
);
const { applyDirectionCarry } = carryCtx;

/** Run a reply's sentences through the carry the way streamReply does. */
function carried(sentences) {
  const dirState = { active: null };
  return sentences.map((s) => applyDirectionCarry(s, dirState));
}

test('THE BUG: an expired carry now emits reset instead of going quietly', () => {
  // Watched fail against the shipped file: the fourth sentence came back BARE.
  // Bare is not neutral on Inworld — the sentence rides in the same ~320-char
  // batched request as the tagged one ahead of it and inherits its tempo,
  // which is the "holds the fast a long time" she reported.
  const out = carried([
    '%%%unhurried and low%%% First one, tagged by the author.',
    'Second one, carried.',
    'Third one, carried.',
    'Fourth one, past the cap.',
  ]);
  assert.match(out[0], /^%%%unhurried and low%%%/);
  assert.match(out[1], /^%%%unhurried and low%%%/);
  assert.match(out[2], /^%%%unhurried and low%%%/);
  assert.match(out[3], /^%%%reset%%% /, `the cap went quiet instead of saying stop: ${out[3]}`);
});

test('reset fires once, not on every sentence after the cap', () => {
  // The Aug-29 fish scar in reverse: "[reset] Anyway. [reset] Text me…" is a
  // cue repeated, and on Inworld it would be a stutter of stops.
  const out = carried([
    '%%%bright and quick%%% One.',
    'Two.', 'Three.', 'Four.', 'Five.',
  ]);
  assert.equal(out.filter((p) => p.startsWith('%%%reset%%%')).length, 1);
});

test('a reply with no direction at all never emits a reset', () => {
  const out = carried(['Plain one.', 'Plain two.', 'Plain three.', 'Plain four.']);
  assert.deepEqual(out, ['Plain one.', 'Plain two.', 'Plain three.', 'Plain four.']);
});

test("the author's own reset still ends the carry, and is not doubled", () => {
  const out = carried([
    '%%%warm and slow%%% One.',
    '%%%reset%%% Two.',
    'Three.',
  ]);
  assert.equal(out[1], '%%%reset%%% Two.');
  assert.ok(!out[2].startsWith('%%%reset%%%'), 'reset re-fired with nothing active');
  assert.equal(out[2], 'Three.');
});

test('a fresh authored direction supersedes without a stray reset', () => {
  const out = carried([
    '%%%unhurried%%% One.',
    'Two.', 'Three.',
    '%%%bright and quick%%% Four.',
    'Five.',
  ]);
  assert.equal(out[3], '%%%bright and quick%%% Four.');
  assert.match(out[4], /^%%%bright and quick%%%/, 'the new direction did not start carrying');
});

test('a sound tag never becomes a carried direction', () => {
  const out = carried(['%%%laugh%%% One.', 'Two.', 'Three.', 'Four.']);
  assert.equal(out[1], 'Two.');
  assert.ok(!out.some((p) => p.startsWith('%%%reset%%%')), 'reset fired for a sound tag');
});
