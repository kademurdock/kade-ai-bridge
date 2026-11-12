/* turn-grace.test.js: the rules for the post-turn grace. Run: node --test turn-grace.test.js */
const test = require('node:test');
const assert = require('node:assert');
const tg = require('./turn-grace.js');

const ON = { FLUX_ADAPTIVE_GRACE: '1' };

test('a thought that trails off waits longer than today', () => {
  const r = tg.pick({ text: 'I went to the store and', eotConfidence: 0.99, base: 900, env: ON });
  assert.strictEqual(r.cls, 'open');
  assert.strictEqual(r.ms, 1300);
});

test('a confident finished thought waits less', () => {
  const r = tg.pick({ text: 'What time does the pharmacy close', eotConfidence: 0.96, base: 900, env: ON });
  assert.strictEqual(r.cls, 'complete');
  assert.strictEqual(r.ms, 350);
});

test('no confidence figure means no shortening', () => {
  const r = tg.pick({ text: 'What time does the pharmacy close', base: 900, env: ON });
  assert.strictEqual(r.cls, 'unsure');
  assert.strictEqual(r.ms, 900);
});

test('a caller who resumed twice is never shortened again, but still gets the longer wait', () => {
  const done = tg.pick({ text: 'What time does the pharmacy close', eotConfidence: 0.99, base: 900, stitches: 2, env: ON });
  assert.strictEqual(done.ms, 900);
  const open = tg.pick({ text: 'and then my', eotConfidence: 0.99, base: 900, stitches: 2, env: ON });
  assert.strictEqual(open.ms, 1300);
});

test('one or two words get the short grace', () => {
  assert.strictEqual(tg.pick({ text: 'Yes please', eotConfidence: 0.99, base: 900, env: ON }).ms, 600);
});

test('shadow (the default) uses today\'s grace and reports the pick', () => {
  const r = tg.pick({ text: 'What time does the pharmacy close', eotConfidence: 0.96, base: 900, env: {} });
  assert.strictEqual(r.mode, 'shadow');
  assert.strictEqual(r.ms, 900);
  assert.strictEqual(r.wouldBe, 350);
});

test('a grace of 0 set by env stays 0, and the open wait stays under the carry cap', () => {
  assert.strictEqual(tg.pick({ text: 'and', base: 0, env: ON }).ms, 0);
  assert.strictEqual(tg.pick({ text: 'and', base: 900, capMs: 1200, env: ON }).ms, 1000);
});

test('shadow never changes the wait, whatever the class (FLUX_ADAPTIVE_GRACE unset)', () => {
  for (const text of ['I went to the store and', 'Yes please', 'What time does the pharmacy close', '']) {
    assert.strictEqual(tg.pick({ text, eotConfidence: 0.99, base: 900, env: {} }).ms, 900);
  }
  assert.strictEqual(tg.pick({ text: 'and', base: 900, env: { FLUX_ADAPTIVE_GRACE: '0' } }).mode, 'off');
});
