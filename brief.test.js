'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./server'), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end + 2);
}

test('brief composition requests restricted tools and scheduler delivers exactly once', async () => {
  const requests = [], deliveries = [];
  const context = vm.createContext({
    process: { env: {} }, console,
    DEFAULT_AGENT: 'test-agent', PROXY_URL: 'https://offline.invalid', PROXY_SECRET: 'offline', BROWSER_UA: 'offline',
    briefPrefsFor: () => ({ items: { dayAhead: false }, lastRun: '2026-09-18' }),
    composeBriefPrompt: () => 'Compose the morning brief.',
    sanitizePushBody: (text) => text,
    axios: { post: async (url, body) => { requests.push({ url, body }); return { data: { text: 'Your brief.' } }; } },
    runNotify: async (payload) => { deliveries.push(payload); return { ok: true, sent: 1 }; },
    centralClock: () => ({ day: '2026-09-18' }),
    briefStore: { users: {} }, saveBriefStore: () => {},
  });
  vm.runInContext(functionSource('askAgentRich') + '\n' + functionSource('fireBrief'), context);
  const result = await context.fireBrief('test-user');
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.toolPolicy, 'morning-brief');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].userId, 'test-user');
  assert.equal(deliveries[0].category, 'KADE_BRIEF');
  assert.equal(deliveries[0].requested, true);
  assert.equal(context.briefStore.users['test-user'].lastRun, '2026-09-18');
  await context.askAgentRich('test-agent', 'An ordinary conversation.');
  assert.equal(Object.hasOwn(requests[1].body, 'toolPolicy'), false);
  context.axios.post = async () => ({ data: { text: '' } });
  const empty = await context.fireBrief('test-user');
  assert.equal(empty.ok, false);
  assert.equal(deliveries.length, 1, 'an empty composition must not send a notification');
  context.axios.post = async () => { throw new Error('offline failure'); };
  await assert.rejects(() => context.fireBrief('test-user'), /offline failure/);
  assert.equal(deliveries.length, 1, 'a failed composition must not send a notification');
});
