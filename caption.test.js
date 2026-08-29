/* caption.test.js — Aug 28 2026.
 *
 * Her report: "it prints the tags on the subtitles when she's talking, even
 * if it doesn't say them reading out in her voice." The synth path stripped
 * steering tags; the caption path shipped the raw sentence. For a screen
 * reader user that is not cosmetic — VoiceOver reads the caption, so she
 * heard the stage direction spoken over the delivery it described.
 *
 * Extracts captionSafe from the shipped source. node --test caption.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync(require.resolve('./voice-stream.js'), 'utf8');
const start = SRC.indexOf('function captionSafe(');
assert.ok(start > -1, 'captionSafe not found in voice-stream.js');
let i = SRC.indexOf('{', SRC.indexOf(')', start)), depth = 0, end = -1;
for (; i < SRC.length; i++) {
  if (SRC[i] === '{') depth++;
  else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const ctx = { String };
vm.createContext(ctx);
vm.runInContext(SRC.slice(start, end) + '\nthis.fn = captionSafe;', ctx);
const captionSafe = ctx.fn;

test('HER REPORT: a leading steering tag never reaches the subtitle', () => {
  assert.strictEqual(
    captionSafe('%%%warm and a little amused%%% Girl, no. Absolutely not.'),
    'Girl, no. Absolutely not.',
  );
});

test('a mid-sentence tag goes too, and the words close up cleanly', () => {
  assert.strictEqual(
    captionSafe('He opens the door and I just %%%cackle%%% lost it right there.'),
    'He opens the door and I just lost it right there.',
  );
});

test('multiple tags, reset included', () => {
  assert.strictEqual(
    captionSafe('%%%low and even%%% The test was clean. %%%reset%%% Anyway, dinner?'),
    'The test was clean. Anyway, dinner?',
  );
});

test('sound cues and stray percent runs are cleaned as well', () => {
  assert.strictEqual(captionSafe('[sound:cards] Your turn.'), 'Your turn.');
  assert.ok(!captionSafe('%%half a tag%% words').includes('%'));
});

test('plain speech is untouched — and a real percentage survives', () => {
  const t = 'That is 40% off, which is the best price all year.';
  assert.strictEqual(captionSafe(t), t);
});

test('a caption that would strip to nothing keeps the original, never blank', () => {
  assert.strictEqual(captionSafe('%%%settling in%%%'), '%%%settling in%%%');
});

test('idempotent — captioning a clean caption is a no-op', () => {
  const once = captionSafe('%%%dry%%% One. Two.');
  assert.strictEqual(captionSafe(once), once);
});

test('the class method strips at the door too, not only at the call site', () => {
  const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.match(stripped, /sendCaption\(role, text\) \{[^}]*captionSafe\(text\)/,
    'a future caller that forgets must still be covered');
});
