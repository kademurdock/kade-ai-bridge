'use strict';
/* lane-pass.test.js — Nov 11 2026, home agent card 2.
 *
 * Signed-in app voice and phone calls tell the site how they arrived, with a short-lived pass
 * signed by the secret the bridge and the site already share. These tests use made-up secrets,
 * numbers and addresses only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');
const lp = require('./lane-pass');

const ENV = { KADE_CALL_INGEST_SECRET: 'offline-test-secret' };
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

/* The site's check, written out here from the same rule (fork kadeVoiceLane.js): prefix + body. */
function siteVerify(token, secret, now) {
  const dot = token.lastIndexOf('.');
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', secret).update(lp.PREFIX + body).digest('base64url');
  if (sig !== expect) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return now <= p.exp ? p : null;
}

test('an app voice pass names the signed-in email, the character, and lives two minutes', () => {
  const t = lp.mintLanePass({ lane: 'app-voice', email: ' Someone@Example.INVALID ', agentId: 'agent_x' }, ENV, NOW);
  const p = siteVerify(t, 'offline-test-secret', NOW);
  assert.deepEqual(p, { v: 1, lane: 'app-voice', iat: NOW, exp: NOW + 120000, email: 'someone@example.invalid', agentId: 'agent_x' });
  assert.equal(siteVerify(t, 'offline-test-secret', NOW + 120001), null, 'expired');
  assert.equal(siteVerify(t, 'another-secret', NOW), null, 'wrong secret');
});

/* The same two strings are checked by the site's test (fork api/server/services/kadeVoiceLane.nodetest.js),
 * so a change on either side that would make them disagree fails a test on both. */
const VECTOR_APP =
  'eyJ2IjoxLCJsYW5lIjoiYXBwLXZvaWNlIiwiaWF0IjoxNzk0Mzk4NDAwMDAwLCJleHAiOjE3OTQzOTg1MjAwMDAsImVtYWlsIjoic29tZW9uZUBleGFtcGxlLmludmFsaWQiLCJhZ2VudElkIjoiYWdlbnRfeCJ9.7HuKj-RW4K3HhuFWGYYQf6OkRGwGT6jkqQM8SU6ljG4';
const VECTOR_PHONE =
  'eyJ2IjoxLCJsYW5lIjoicGhvbmUiLCJpYXQiOjE3OTQzOTg0MDAwMDAsImV4cCI6MTc5NDM5ODUyMDAwMCwibnVtIjoiKzE1NTUwMTAwMTIzIiwiYWdlbnRJZCI6ImFnZW50X3gifQ.hRHaTLELdr5csUf8toz5oKoyfcWIcSgviP9rCxnjWQM';
test('the same vectors the site test checks', () => {
  assert.equal(lp.mintLanePass({ lane: 'app-voice', email: 'someone@example.invalid', agentId: 'agent_x' }, ENV, NOW), VECTOR_APP);
  assert.equal(lp.mintLanePass({ lane: 'phone', num: '+15550100123', agentId: 'agent_x' }, ENV, NOW), VECTOR_PHONE);
});

test('a phone pass carries the number for an inbound call only, and never says signed in', () => {
  const inbound = siteVerify(lp.mintLanePass(lp.claimFor({ surface: 'phone', from: '+15550100123', agentId: 'a' }), ENV, NOW), 'offline-test-secret', NOW);
  assert.equal(inbound.lane, 'phone');
  assert.equal(inbound.num, '+15550100123');
  assert.equal(inbound.email, undefined, 'an unregistered number names nobody');
  for (const s of [
    { surface: 'phone', from: '+15550100123', outbound: true },
    { surface: 'phone', from: '+15550100123', twilioOutbound: true },
  ]) {
    const p = siteVerify(lp.mintLanePass(lp.claimFor(s), ENV, NOW), 'offline-test-secret', NOW);
    assert.equal(p.lane, 'phone');
    assert.equal(p.num, undefined, 'a call the platform placed has no caller number to pair');
  }
  const odd = siteVerify(lp.mintLanePass(lp.claimFor({ surface: 'phone', from: 'unknown' }), ENV, NOW), 'offline-test-secret', NOW);
  assert.equal(odd.num, undefined, 'only a real E.164 number is sent');
});

test('web: a ticket-verified session is app voice (a direct Spotter session opened with the same ticket too)', () => {
  assert.deepEqual(lp.claimFor({ surface: 'web', lcEmail: 'a@example.invalid', agentId: 'k' }), { lane: 'app-voice', email: 'a@example.invalid', agentId: 'k' });
  assert.equal(lp.claimFor({ surface: 'web', lcEmail: 'a@example.invalid', _spotterDirect: true }).lane, 'app-voice');
  assert.equal(lp.claimFor({ surface: 'web', lcEmail: null }), null);
  assert.equal(lp.claimFor(null), null);
});

test('no shared secret, no pass; the older secret name still works; KADE_LANE_PASS=0 sends nothing', () => {
  const web = { surface: 'web', lcEmail: 'a@example.invalid', agentId: 'k' };
  assert.equal(lp.lanePassEntry(web, {}, NOW), null);
  const fallback = lp.lanePassEntry(web, { KADE_USAGE_EVENT_SECRET: 'older-name' }, NOW);
  assert.ok(siteVerify(fallback.kadeLanePass, 'older-name', NOW));
  assert.equal(lp.lanePassEntry(web, { ...ENV, KADE_LANE_PASS: '0' }, NOW), null);
  const e = lp.lanePassEntry(web, ENV, NOW);
  assert.deepEqual(Object.keys(e).sort(), ['kadeLanePass', 'role']);
  assert.equal(e.role, 'kade-lane');
  assert.equal(Object.hasOwn(e, 'content'), false, 'no content, so the proxy never puts it in the text');
});

test('a pass is never a web voice ticket, and a ticket is never a pass', () => {
  const SRC = fs.readFileSync(require.resolve('./voice-stream.js'), 'utf8').replace(/\r\n/g, '\n');
  const a = SRC.indexOf('function verifyWebTicket(ticket) {');
  const b = SRC.indexOf('\n}\n', a);
  const ctx = { crypto, Buffer, JSON, Date, process: { env: ENV } };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(a, b + 3) + '\nthis.verifyWebTicket = verifyWebTicket;', ctx);
  const pass = lp.mintLanePass({ lane: 'app-voice', email: 'a@example.invalid' }, ENV, Date.now());
  assert.equal(ctx.verifyWebTicket(pass), null);
  /* A ticket the site would mint: HMAC over the body alone. */
  const body = Buffer.from(JSON.stringify({ email: 'a@example.invalid', lane: 'app-voice', exp: Date.now() + 60000 })).toString('base64url');
  const ticket = `${body}.${crypto.createHmac('sha256', ENV.KADE_CALL_INGEST_SECRET).update(body).digest('base64url')}`;
  assert.ok(ctx.verifyWebTicket(ticket), 'the ticket itself is good');
  assert.equal(siteVerify(ticket, ENV.KADE_CALL_INGEST_SECRET, Date.now()), null);
});

test('askStreamBody puts the pass first and leaves the words the proxy builds unchanged', () => {
  const SRC = fs.readFileSync(require.resolve('./voice-stream.js'), 'utf8').replace(/\r\n/g, '\n');
  const grab = (anchor) => {
    const a = SRC.indexOf(anchor);
    assert.ok(a > -1, anchor);
    return SRC.slice(a, SRC.indexOf('\n}\n', a) + 3);
  };
  const run = (lanePass) => {
    const ctx = { Array, lanePass };
    vm.createContext(ctx);
    vm.runInContext(grab('function askStreamBody(session, fields) {') + grab('function withLanePass(session, fields) {') + '\nthis.f = askStreamBody;', ctx);
    return ctx.f;
  };
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'pair my phone' },
  ];
  const session = { surface: 'web', lcEmail: 'a@example.invalid', agentId: 'k', billCaller: true };
  const out = run({ lanePassEntry: (s) => lp.lanePassEntry(s, ENV, NOW) })(session, { agentId: 'k', messages, userEmail: 'a@example.invalid' });
  assert.equal(out.billCaller, true);
  assert.equal(out.messages.length, 4);
  assert.equal(out.messages[0].role, 'kade-lane');
  assert.deepEqual([...out.messages.slice(1)], messages);
  assert.equal(messages.length, 3, 'the caller\'s own array is not changed');

  /* The proxy's text builder (inworld-tts-proxy librechat.js composeTextWithHistory, Nov 8 2026),
   * reduced to the part that decides which entries count: the last entry, and earlier entries
   * with content. The pass has no content, so the text is the same with or without it. */
  const compose = (ms) => {
    const last = ms[ms.length - 1] || {};
    const prior = ms.slice(0, -1).filter((m) => m && m.content);
    if (!prior.length) return last.content || '';
    return prior.map((m) => `${m.role === 'assistant' ? 'YOU' : 'THEM'}: ${m.content}`).join('\n') + '\n\n' + (last.content || '');
  };
  assert.equal(compose(out.messages), compose(messages));
  const pickup = run({ lanePassEntry: (s) => lp.lanePassEntry(s, ENV, NOW) })(session, { agentId: 'k', messages: [{ role: 'user', content: 'say hello' }] });
  assert.equal(compose(pickup.messages), 'say hello');

  /* A pass that cannot be made, or a throw, sends the turn exactly as before. */
  const none = run({ lanePassEntry: () => null })({}, { agentId: 'k', messages });
  assert.equal(none.messages, messages);
  const boom = run({ lanePassEntry: () => { throw new Error('x'); } })({}, { agentId: 'k', messages });
  assert.equal(boom.messages, messages);
});
