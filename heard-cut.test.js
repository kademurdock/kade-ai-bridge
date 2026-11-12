/* heard-cut.test.js — Nov 11 2026. The text rules for "keep only what was heard". */
const test = require('node:test');
const assert = require('node:assert');
const hc = require('./heard-cut.js');

test('spoken words skip direction tags and stage tokens, keep voiced sounds', () => {
  const w = hc.spokenWords('%%%warm%%% Well [laugh] I dealt you a [sound:card_flip] king [table:ab12] there.');
  assert.deepStrictEqual(w.map((x) => x.text), ['Well', '[laugh]', 'I', 'dealt', 'you', 'a', 'king', 'there.']);
  assert.deepStrictEqual(hc.spokenWords('[END CALL] [PRESS 2] [SAY NOTHING]').length, 0);
});

test('cutAtWords keeps the leading tag and the first n words, nothing after', () => {
  const raw = '%%%warm%%% Hey there friend. How are you doing today?';
  assert.strictEqual(hc.cutAtWords(raw, 0), '');
  assert.strictEqual(hc.cutAtWords(raw, 2), '%%%warm%%% Hey there');
  assert.strictEqual(hc.cutAtWords(raw, 3), '%%%warm%%% Hey there friend.');
  assert.strictEqual(hc.cutAtWords(raw, 99), raw);
});

test('by share of the audio: a word counts only once all of it fits', () => {
  const words = hc.spokenWords('one two three four'); // spoken string "one two three four" = 18 chars
  assert.strictEqual(hc.wordsByShare(words, 0), 0);
  assert.strictEqual(hc.wordsByShare(words, 0.2), 1); // 3.6 chars: "one" ends at 3
  assert.strictEqual(hc.wordsByShare(words, 0.5), 2); // 9 chars: "two" ends at 7, "three" at 13
  assert.strictEqual(hc.wordsByShare(words, 1), 4);
});

test('heardWordCount: word timings first, then audio share, then whole', () => {
  const raw = 'Alpha beta gamma delta.';
  const timed = { raw, durMs: 2000, timedWords: [[0, 400, 'Alpha'], [450, 800, 'beta'], [850, 1300, 'gamma'], [1350, 1900, 'delta']] };
  assert.strictEqual(hc.heardWordCount(timed, 820), 2, 'beta ended at 800');
  assert.strictEqual(hc.heardWordCount(timed, 1000), 2, 'gamma not finished');
  assert.strictEqual(hc.heardWordCount(timed, 1950), 4, 'close to the end = whole');
  assert.strictEqual(hc.heardWordCount({ raw, durMs: 2000 }, 1000), 2, 'half the audio by characters');
  assert.strictEqual(hc.heardWordCount({ raw, durMs: 2000 }, null), 4, 'no position = whole');
  assert.strictEqual(hc.heardWordCount({ raw }, 1000), 4, 'no duration = whole');
  assert.strictEqual(hc.heardWordCount({ raw, durMs: 2000 }, 0), 0);
  // A pronunciation fix changed the word count: scaled, rounded down.
  const scaled = { raw: 'one two three four five six', durMs: 3000, timedWords: [[0, 500, 'a'], [600, 1000, 'b'], [1100, 1500, 'c']] };
  assert.strictEqual(hc.heardWordCount(scaled, 1050), 4);
});

test('buildHeardText: whole pieces, the cut piece trimmed, then the marker', () => {
  const units = [
    { raw: '%%%warm%%% Hi there.', heard: 'whole' },
    { raw: 'I found three places nearby. The first is open late.', heard: { ms: 1500 }, durMs: 4000 },
    { raw: 'Never started.', heard: 'none' },
  ];
  const r = hc.buildHeardText(units);
  assert.strictEqual(r.cut, true);
  assert.ok(r.text.startsWith('%%%warm%%% Hi there. I found three'), r.text);
  assert.ok(!r.text.includes('open late'));
  assert.ok(!r.text.includes('Never started'));
  assert.ok(r.text.endsWith(hc.CUT_MARK));
});

test('buildHeardText: everything heard is not a cut; nothing heard is the marker alone', () => {
  assert.deepStrictEqual(hc.buildHeardText([{ raw: 'Done. [END CALL]', heard: 'whole' }]), { text: 'Done.', cut: false });
  assert.strictEqual(hc.buildHeardText([{ raw: 'Done.', heard: 'whole' }], { lostText: true }).text, `Done. ${hc.CUT_MARK}`);
  assert.deepStrictEqual(hc.buildHeardText([{ raw: 'Hello.', heard: 'none' }]), { text: hc.CUT_NONE, cut: true });
  assert.deepStrictEqual(hc.buildHeardText([], { lostText: true }), { text: hc.CUT_NONE, cut: true });
  // Cut before the first whole word of the first piece.
  assert.strictEqual(hc.buildHeardText([{ raw: 'Absolutely wonderful.', heard: { ms: 50 }, durMs: 3000 }]).text, hc.CUT_NONE);
});

test('the marker the model copies is never spoken', () => {
  assert.strictEqual(hc.stripCutMarks(`Right, as I said ${hc.CUT_MARK} so anyway.`), 'Right, as I said so anyway.');
  assert.strictEqual(hc.stripCutMarks('(Cut off) Okay.'), 'Okay.');
  assert.strictEqual(hc.stripCutMarks('A plain (aside) stays.'), 'A plain (aside) stays.');
  assert.strictEqual(hc.hasCutMark('nothing here'), false);
});

test('phone: marks before the clear are playback; the cut piece runs from the mark before it', () => {
  const units = [
    { raw: 'One two.', hasSpeech: true, sendAt: 1000, durMs: 800, markAt: 1850 },
    { raw: 'Three four five six.', hasSpeech: true, sendAt: 1800, durMs: 2000, markAt: 2600 /* returned by the clear */ },
    { raw: 'Seven.', hasSpeech: true },
  ];
  hc.placePhone(units, 2350);
  assert.strictEqual(units[0].heard, 'whole');
  assert.deepStrictEqual(units[1].heard, { ms: 500 }, 'from the first mark (1850), not the send (1800)');
  assert.strictEqual(units[2].heard, 'none');
});

test('phone: with no marks back, the clock from the send', () => {
  const units = [{ raw: 'a b', hasSpeech: true, sendAt: 1000, durMs: 900 }, { raw: 'c', hasSpeech: true, sendAt: 1900, durMs: 500 }];
  hc.placePhone(units, 1400);
  assert.deepStrictEqual(units[0].heard, { ms: 400 });
  assert.strictEqual(units[1].heard, 'none');
});

test('web: a client report after the stop wins; a stale one is ignored for the playhead guess', () => {
  const mk = () => [
    { raw: 'a', hasSpeech: true, seq: 4, startEst: 1000, durMs: 1000 },
    { raw: 'b c d', hasSpeech: true, seq: 6, startEst: 2000, durMs: 1500 },
    { raw: 'e', hasSpeech: true, seq: 7, startEst: 3500, durMs: 900 },
  ];
  let u = hc.placeWeb(mk(), { seq: 6, ms: 700, at: 2600 }, 2500);
  assert.deepStrictEqual(u.map((x) => x.heard), ['whole', { ms: 700 }, 'none']);
  u = hc.placeWeb(mk(), { seq: 2, ms: 300, at: 900 }, 2500); // from an earlier clear: stale
  assert.deepStrictEqual(u.map((x) => x.heard), [{ ms: 1500 }, { ms: 500 }, 'none']);
  u = hc.placeWeb(mk(), null, 2500);
  assert.deepStrictEqual(u.map((x) => x.heard), [{ ms: 1500 }, { ms: 500 }, 'none']);
  u = hc.placeWeb(mk(), { seq: 3, ms: 0, at: 2600 }, 2500); // nothing of this turn had started
  assert.deepStrictEqual(u.map((x) => x.heard), ['none', 'none', 'none']);
});

test('kdtmWords reads the word list from a WAV, and nothing from a plain one', () => {
  const wav = (chunks) => {
    const parts = chunks.map(([id, body]) => {
      const head = Buffer.alloc(8); head.write(id, 0, 'ascii'); head.writeUInt32LE(body.length, 4);
      return Buffer.concat([head, body, Buffer.alloc(body.length % 2)]);
    });
    const riff = Buffer.alloc(12); riff.write('RIFF', 0, 'ascii'); riff.write('WAVE', 8, 'ascii');
    return Buffer.concat([riff, ...parts]);
  };
  const fmt = Buffer.alloc(16);
  const track = Buffer.from(JSON.stringify({ v: 1, dur: 100, w: [[0, 50, 'Hi']] }));
  assert.deepStrictEqual(hc.kdtmWords(wav([['fmt ', fmt], ['kdtm', track], ['data', Buffer.alloc(10)]])), [[0, 50, 'Hi']]);
  assert.strictEqual(hc.kdtmWords(wav([['fmt ', fmt], ['data', Buffer.alloc(10)]])), null);
  assert.strictEqual(hc.kdtmWords(wav([['fmt ', fmt], ['kdtm', Buffer.from('{bad')], ['data', Buffer.alloc(2)]])), null);
  assert.strictEqual(hc.kdtmWords(Buffer.alloc(160, 0xff)), null);
});

test('the switch', () => {
  assert.strictEqual(hc.heardOnlyOn({}), true);
  assert.strictEqual(hc.heardOnlyOn({ BRIDGE_HEARD_ONLY: '1' }), true);
  assert.strictEqual(hc.heardOnlyOn({ BRIDGE_HEARD_ONLY: '0' }), false);
});

test('the marker survives the transcript scrub, so Call History and the merged chat keep it', () => {
  const { stripAiTells, scrubTranscriptText } = require('./voice-commands');
  const keep = (t) => stripAiTells(scrubTranscriptText(t));
  assert.ok(keep(`%%%warm%%% Okay, here is the first ${hc.CUT_MARK}`).endsWith(hc.CUT_MARK));
  assert.strictEqual(keep(hc.CUT_NONE), hc.CUT_NONE);
});
