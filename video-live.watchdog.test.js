/* video-live.watchdog.test.js — Aug 28 2026.
 *
 * The live-silence watchdog, born from a real call: "Can you see how much is
 * left in this?" / "Are you there?" / "Hello?" — 31 seconds, zero words back,
 * because Google's Live endpoint completed setup and then generated nothing.
 * The brownout was Google's; the unexplained dead air was ours. The pure
 * verdict is exported so its fence posts can be held still and tested.
 */
const test = require('node:test');
const assert = require('node:assert');
const { shouldWarnLiveSilence, LIVE_SILENT_LINE } = require('./video-live');

const base = { liveOn: true, armedAt: 1000, firstAudioAt: 0, warned: false, ms: 12000 };

test('HER CALL: live, armed, deadline passed, zero audio ever -> warn', () => {
  assert.ok(shouldWarnLiveSilence({ ...base, now: 1000 + 12000 }));
});

test('a healthy session that spoke is never warned about', () => {
  assert.ok(!shouldWarnLiveSilence({ ...base, firstAudioAt: 3000, now: 99999 }));
});

test('one warning per call, never nagging', () => {
  assert.ok(!shouldWarnLiveSilence({ ...base, warned: true, now: 99999 }));
});

test('a call that already ended stays quiet', () => {
  assert.ok(!shouldWarnLiveSilence({ ...base, liveOn: false, now: 99999 }));
});

test('before the deadline the model still has the floor', () => {
  assert.ok(!shouldWarnLiveSilence({ ...base, now: 1000 + 11999 }));
});

test('LIVE_SILENCE_MS=0 disables it entirely', () => {
  assert.ok(!shouldWarnLiveSilence({ ...base, ms: 0, now: 99999 }));
});

test('the spoken line blames the right party and offers the way out', () => {
  assert.match(LIVE_SILENT_LINE, /not you/i, 'a blind caller must hear immediately that they did nothing wrong');
  assert.match(LIVE_SILENT_LINE, /call back|hang up|few seconds/i, 'it must offer an action, not just a diagnosis');
  assert.ok(!/error|fail|broke/i.test(LIVE_SILENT_LINE), 'no alarm words — this is a weather report, not a crash');
});
