/* voice-stream.carry.test.js — Aug 28 2026.
 *
 * The phone lane's copy of the direction carry, which had all three faults
 * the other two lanes were cured of: carry-forever, the six-sound list, and
 * no reset. Extracts the SHIPPED functions (never a transcription) and covers
 * each fault with a test that was watched fail against the old code.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync(require.resolve('./voice-stream.js'), 'utf8');

function grab(anchor, endAnchor) {
  const a = SRC.indexOf(anchor);
  assert.ok(a > -1, `anchor not found: ${anchor.slice(0, 40)}`);
  const b = SRC.indexOf(endAnchor, a);
  assert.ok(b > -1, `end anchor not found: ${endAnchor.slice(0, 40)}`);
  return SRC.slice(a, b + endAnchor.length);
}

const ctx = { String, Set, Boolean, parseInt, process: { env: {} }, Array };
vm.createContext(ctx);
vm.runInContext(
  grab('const CANONICAL_SOUNDS = [', 'return sentence;\n}') +
    '\nthis.applyDirectionCarry = applyDirectionCarry; this.isSoundTag = isSoundTag;',
  ctx,
);
const { applyDirectionCarry, isSoundTag } = ctx;

/* ⚠️ PART 110 (Aug 31 2026) — THREE ASSERTIONS IN THIS FILE WERE SHARPENED, NOT
 * LOOSENED, AND THE DISTINCTION IS THE WHOLE POINT.
 *
 * They asked "does the tail start with %%%?" as a proxy for "has the direction
 * stopped carrying?" That proxy was exact until tonight. Part 110 made an
 * expired carry emit `%%%reset%%%` — because Part 109 measured that on Inworld
 * a tag applies UNTIL YOU CHANGE IT, so merely ceasing to stamp does not stop
 * anything when sentences ride batched in one request. The tail now starts with
 * %%% and IS unstamped: `%%%reset%%%` is the direction ending, out loud.
 *
 * So the old assertions began failing on the correct behaviour — HOW_TO_VERIFY
 * law 21 in miniature: a ruler with no category for the right answer. They now
 * ask the question they always meant: is THE DIRECTION still riding this
 * sentence? Every original intent is preserved and each is strictly stricter,
 * because "no direction" alone would pass on a bare tail and these also demand
 * the reset that makes it true at the synthesiser. */
const carriesDirection = (line, dir) => line.startsWith(`%%%${dir}%%%`);

function runReply(sentences) {
  const dirState = { active: null };
  return sentences.map((s) => applyDirectionCarry(s, dirState));
}

test('HER BUG ON THE PHONE: one opening tag no longer steers the whole call', () => {
  const out = runReply([
    '%%%slow and soothing like you are talking somebody down%%% First.',
    'Second sentence of the reply.',
    'Third sentence of the reply.',
    'Fourth sentence of the reply.',
    'Fifth sentence of the reply.',
  ]);
  const dir = 'slow and soothing like you are talking somebody down';
  const stamped = out.filter((s) => carriesDirection(s, dir)).length;
  assert.strictEqual(stamped, 3, `authored + 2 carried expected, got ${stamped} of ${out.length}`);
  assert.ok(!out[4].includes(dir), 'the tail of the reply must return to her own voice');
  assert.ok(!out[3].includes(dir), 'the direction rode past its cap');
  // Part 110: and the tail must SAY so, or Inworld carries the tempo anyway.
  assert.match(out[3], /^%%%reset%%% /, 'the cap went quiet instead of saying stop');
});

test('a sound is a one-shot: gasp does not haunt the call', () => {
  const out = runReply(['%%%gasp%%% No she did not.', 'Tell me everything.', 'Start from the top.']);
  assert.strictEqual(out.filter((s) => s.includes('gasp')).length, 1,
    'gasp was carried — the six-sound list is back');
});

test('the widened vocabulary matches inflections like the proxy does', () => {
  for (const t of ['chuckle', 'chuckles', 'scoff', 'sniffling', 'clears throat', 'throat clearing', 'lip smack']) {
    assert.ok(isSoundTag(t), `${t} should be a sound`);
  }
  for (const t of ['shout', 'sing', 'mumble', 'slow and soothing', 'reset']) {
    assert.ok(!isSoundTag(t), `${t} must stay on the direction side`);
  }
});

test('reset ends the carry instead of becoming it', () => {
  const out = runReply([
    '%%%cracking up barely able to get it out%%% Girl.',
    '%%%reset%%% Anyway, the real part.',
    'And this one, clean.',
  ]);
  assert.ok(!out[2].startsWith('%%%'), `after reset the lane stamped: ${out[2].slice(0, 40)}`);
  assert.strictEqual(out.filter((s) => s.includes('%%%reset%%%')).length, 1,
    'reset must appear only where the author wrote it');
});

test('a new authored tag re-arms the carry (the decay cannot flatten the back half)', () => {
  const out = runReply([
    '%%%dry as hell%%% One.', 'Two.', 'Three.', 'Four, spent by now.',
    '%%%warmer now%%% Five.', 'Six.',
  ]);
  assert.ok(out[5].startsWith('%%%warmer now%%%'), 'the second direction must carry');
  assert.ok(!out[3].includes('dry as hell'), 'the first direction must have expired before it');
  assert.match(out[3], /^%%%reset%%% /, 'the expiry must be spoken, not silent');
  // And the fresh authored tag supersedes cleanly — no reset stacked in front.
  assert.ok(!out[4].includes('reset'), 'a new direction should not need a reset first');
});

test('a whole business-length reply under one direction stops at ~600 chars', () => {
  const long = 'This sentence is deliberately padded out to be quite long indeed for the character budget test. ';
  const out = runReply(['%%%measured and calm%%% Opening.', long.repeat(4), long.repeat(4), 'Tail.']);
  assert.ok(!out[3].includes('measured and calm'), 'the char bound did not fire');
  assert.match(out[3], /^%%%reset%%% /, 'the char bound fired silently');
});
