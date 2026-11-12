/* agent-cache.test.js — Nov 12 2026 (GW-7). A call turn must never wait on the agent list. */
const test = require('node:test');
const assert = require('node:assert');
const { createAgentCache } = require('./agent-cache.js');

const quiet = { log() {}, error() {} };
const tick = () => new Promise((r) => setImmediate(r));
function rig(opts = {}) {
  const s = { t: 1000, calls: 0, next: [] };
  const cache = createAgentCache({
    fetchList: () => { s.calls++; const f = s.next.shift(); return f ? f() : Promise.resolve([{ id: 'a', name: 'A' }]); },
    ttlMs: 1000, retryMs: 100, coldRetryMs: 10, now: () => s.t, log: quiet, ...opts,
  });
  return { s, cache };
}

test('first get awaits the fetch; a fresh list makes no call', async () => {
  const { s, cache } = rig();
  assert.deepStrictEqual(await cache.get(), [{ id: 'a', name: 'A' }]);
  await cache.get(); await cache.get();
  assert.strictEqual(s.calls, 1);
});

test('concurrent first gets share one fetch', async () => {
  const { s, cache } = rig();
  await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.strictEqual(s.calls, 1);
});

test('stale list comes back at once and exactly one refresh starts', async () => {
  const { s, cache } = rig();
  const old = await cache.get();
  s.t += 1001;
  let release;
  s.next.push(() => new Promise((r) => { release = () => r([{ id: 'b', name: 'B' }]); }));
  const raced = await Promise.race([cache.get(), tick().then(() => 'waited')]);
  assert.strictEqual(raced, old);
  assert.strictEqual(await cache.get(), old);
  await tick();
  assert.strictEqual(s.calls, 2);
  release(); await tick(); await tick();
  assert.deepStrictEqual(await cache.get(), [{ id: 'b', name: 'B' }]);
  assert.strictEqual(s.calls, 2);
});

test('a failed refresh keeps the old list and waits retryMs', async () => {
  const { s, cache } = rig();
  const old = await cache.get();
  s.t += 1001;
  s.next.push(() => Promise.reject(new Error('429')));
  assert.strictEqual(await cache.get(), old);
  await tick(); await tick();
  for (let i = 0; i < 3; i++) assert.strictEqual(await cache.get(), old);
  assert.strictEqual(s.calls, 2);
  s.t += 101;
  await cache.get(); await tick(); await tick();
  assert.strictEqual(s.calls, 3);
  assert.strictEqual(await cache.get() === old, false);
});

test('a malformed answer never replaces a good list', async () => {
  const { s, cache } = rig();
  const old = await cache.get();
  s.t += 1001;
  s.next.push(() => Promise.resolve(undefined));
  await cache.get(); await tick(); await tick();
  assert.strictEqual(await cache.get(), old);
});

test('boot failure: empty list, no wait, short cold retry then recovery', async () => {
  const { s, cache } = rig();
  s.next.push(() => { throw new Error('ECONNREFUSED'); });
  assert.deepStrictEqual(await cache.get(), []);
  assert.deepStrictEqual(await cache.get(), []);
  assert.strictEqual(s.calls, 1);
  s.t += 11;                                   // coldRetryMs, not retryMs
  assert.deepStrictEqual(await cache.get(), []);
  await tick(); await tick();
  assert.strictEqual(s.calls, 2);
  assert.deepStrictEqual(await cache.get(), [{ id: 'a', name: 'A' }]);
});
