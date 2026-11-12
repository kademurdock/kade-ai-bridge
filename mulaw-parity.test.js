/* mulaw-parity.test.js -- Nov 12 2026 (platform audit GW-3, design review). The voice proxy and
 * this bridge each carry a G.711 mu-law encoder and are separate deployments with no shared
 * package. The proxy's used the 14-bit bias on 16-bit samples; GW-3 gives it this bridge's
 * constants (bias 132, clip 32635). This pins the bridge's encoder to a fixture table, and to a
 * digest of its whole 65,536-input table, so the proxy's telephony-codec test can pin the same
 * numbers and the two can never drift apart unnoticed. */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

delete process.env.DEEPGRAM_API_KEY;
const { encodeUlaw } = require('./voice-stream.js')._test;

// [16-bit sample, mu-law byte]. Silence is 0xFF; the ends of the scale are 0x80 and 0x00.
const FIXTURE = [[0, 255], [1, 255], [-1, 127], [4, 254], [-4, 126], [31, 251], [32, 251], [95, 243], [100, 242],
  [150, 238], [-150, 110], [255, 231], [256, 231], [1000, 206], [-1000, 78], [4095, 175], [8159, 159], [-8159, 31],
  [16000, 144], [-16000, 16], [32635, 128], [32636, 128], [32767, 128], [-32767, 0], [-32768, 0]];
// sha256 over encodeUlaw(v) for v = -32768 .. 32767, one byte each, in order.
const TABLE_SHA256 = '5ee7cf5f273f842d2234121e4cb0c98d6b20a99ac29026f94e05b36955b195be';

test('the fixture table', () => {
  for (const [v, want] of FIXTURE) assert.strictEqual(encodeUlaw(v), want, `encodeUlaw(${v})`);
});

test('the whole 65,536-input table matches its pinned digest', () => {
  const h = crypto.createHash('sha256');
  for (let v = -32768; v <= 32767; v++) h.update(Buffer.from([encodeUlaw(v)]));
  assert.strictEqual(h.digest('hex'), TABLE_SHA256);
});

test('monotonic: a louder sample never encodes to a quieter step', () => {
  const level = (u) => { const x = ~u & 0xff; return ((x >> 4) & 7) * 16 + (x & 0x0f); };
  let prev = -1;
  for (let v = 0; v <= 32767; v++) {
    const l = level(encodeUlaw(v));
    assert.ok(l >= prev, `step fell at ${v}`);
    prev = l;
  }
});
