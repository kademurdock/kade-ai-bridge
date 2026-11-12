/* web-voice-ring-only.test.js -- Nov 12 2026 (platform audit SEC-7). The fork will mint a
 * `ringOnly` web-voice ticket for answering one ring of a character the person cannot open
 * (behind its KADE_WEB_VOICE_RING_TICKETS switch). Such a ticket must never start an ordinary
 * call: a hello carrying it without a callRingId is refused with 4403. Runs the real hello
 * checks from voice-stream.js in a sandbox (same style as desktop-calls.test.js). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require.resolve('./voice-stream'), 'utf8');
const start = source.indexOf('/* SEC-7 (Nov 12 2026): a ringOnly ticket');
const end = source.indexOf('const user = {', start);

function rig(msg, t, canAnswer = () => true) {
  const calls = [];
  const context = { msg, t, cfg: { canAnswerCallRing: canAnswer },
    ws: { send: (v) => calls.push(JSON.parse(v)), close: (code) => calls.push(code) } };
  vm.createContext(context);
  const check = vm.runInContext(`(function() { ${source.slice(start, end)} return 'session permitted'; })`, context);
  return { calls, check };
}

test('the guard sits in the hello, before the ring check', () => {
  assert.ok(start > 0 && end > start);
  assert.ok(source.indexOf("Object.prototype.hasOwnProperty.call(msg, 'callRingId')", start) < end);
});

test('a ringOnly ticket with no callRingId is refused with one error, then 4403', () => {
  const { calls, check } = rig({ type: 'hello' }, { uid: 'u1', agentId: 'private-one', ringOnly: true });
  assert.strictEqual(check(), undefined);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].type, 'error');
  assert.strictEqual(calls[1], 4403);
});

test('a ringOnly ticket answering its ring goes on to the ring check', () => {
  const ok = rig({ type: 'hello', callPlanId: 'p', callRingId: 'r' }, { uid: 'u1', agentId: 'private-one', ringOnly: true }, () => true);
  assert.strictEqual(ok.check(), 'session permitted');
  const stale = rig({ type: 'hello', callPlanId: 'p', callRingId: 'r' }, { uid: 'u1', agentId: 'private-one', ringOnly: true }, () => false);
  assert.strictEqual(stale.check(), undefined);
  assert.strictEqual(stale.calls[1], 4409, 'a ring that is not this character\'s is still refused by the ring check');
});

test('an ordinary ticket is untouched', () => {
  const { calls, check } = rig({ type: 'hello' }, { uid: 'u1', agentId: 'public-one' });
  assert.strictEqual(check(), 'session permitted');
  assert.strictEqual(calls.length, 0);
});
