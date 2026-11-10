'use strict';
/* Nov 10 2026: the Twilio webhook gate (twilio-gate.js). Real express, real twilio signature maths,
 * a listener on 127.0.0.1 only. Nothing leaves the machine. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');
const twilio = require('twilio');
const { createTwilioGate, gateMode, routeLabel, TWILIO_PATHS } = require('./twilio-gate');

const TOKEN = 'test-auth-token-0123456789abcdef';
const PUBLIC = 'https://bridge.example.test';

async function withApp(mode, run, { token = TOKEN } = {}) {
  const logs = [];
  const handled = [];
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  const gate = createTwilioGate({ token, publicUrl: PUBLIC, validateRequest: twilio.validateRequest, mode, log: { warn: (l) => logs.push(l) } });
  app.use(TWILIO_PATHS, gate);
  for (const route of ['/sms', '/voice', '/voice/continue/:callSid', '/voice-ws', '/voice-status', '/recording-status', '/signup', '/voicemail-list']) {
    app.post(route, (req, res) => { handled.push(req.path); res.type('text/xml').send('<Response/>'); });
  }
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const post = (path, form, headers = {}) => new Promise((resolve, reject) => {
    const data = new URLSearchParams(form).toString();
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(data);
  });
  const signed = (path, form) => post(path, form, { 'X-Twilio-Signature': twilio.getExpectedTwilioSignature(TOKEN, PUBLIC + path, form) });
  try {
    return await run({ post, signed, logs, handled, gate });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const SMS = { From: '+14175550142', To: '+14175550100', Body: 'hello there', MessageSid: 'SM0123456789abcdef0123456789abcdef' };

test('enforce: a forged text is refused 403 and never reaches the handler; Twilio\'s own signed request passes', async () => {
  await withApp('enforce', async ({ post, signed, logs, handled, gate }) => {
    const forged = await post('/sms', SMS);
    assert.equal(forged.status, 403);
    assert.equal(forged.text, 'Forbidden');
    assert.deepEqual(handled, [], 'the paid handler did not run');
    const wrong = await post('/sms', SMS, { 'X-Twilio-Signature': 'bm90IGEgcmVhbCBzaWduYXR1cmU=' });
    assert.equal(wrong.status, 403);
    const real = await signed('/sms', SMS);
    assert.equal(real.status, 200);
    assert.deepEqual(handled, ['/sms']);
    // a signature is for one body: the same header on a changed text is refused
    const replay = await post('/sms', { ...SMS, Body: 'something else' }, { 'X-Twilio-Signature': twilio.getExpectedTwilioSignature(TOKEN, PUBLIC + '/sms', SMS) });
    assert.equal(replay.status, 403);
    assert.deepEqual(gate.stats(), { mode: 'enforce', ok: 1, mismatch: 3, refused: 3 });
    assert.ok(logs.every((l) => !l.includes('4175550142') && !l.includes('hello there')), 'no number and no text in the log');
  });
});

test('enforce covers every Twilio path, the call id path and a query string; other routes are untouched', async () => {
  await withApp('enforce', async ({ post, signed, handled }) => {
    const call = { CallSid: 'CA0123456789abcdef0123456789abcdef', From: '+14175550142', SpeechResult: 'hi' };
    for (const path of ['/voice', '/voice/continue/CA0123456789abcdef0123456789abcdef', '/voice-ws', '/voice-status', '/recording-status']) {
      assert.equal((await post(path, call)).status, 403, `${path} refuses a forged post`);
      assert.equal((await signed(path, call)).status, 200, `${path} takes a signed one`);
    }
    assert.equal((await signed('/voice-status?attempt=2', call)).status, 200, 'the query string is part of what Twilio signs');
    assert.equal((await post('/signup', { name: 'Pat', phone: '4175550199' })).status, 200, 'the signup form is not a Twilio route');
    assert.equal((await post('/voicemail-list', {})).status, 200, 'a path that merely starts with the same letters is not gated');
    assert.equal(handled.length, 8);
  });
});

test('log (the default): nothing is refused, a mismatch is logged without the caller\'s number, and the log is capped', async () => {
  await withApp('log', async ({ post, signed, logs, handled, gate }) => {
    assert.equal((await post('/sms', SMS)).status, 200);
    assert.equal((await signed('/sms', SMS)).status, 200);
    assert.equal(handled.length, 2);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[twilio-gate\] mismatch on POST \/sms \(mode log: let through\)/);
    for (let i = 0; i < 40; i++) await post('/voice/continue/CA0123456789abcdef0123456789abcdef', SMS);
    assert.equal(logs.length, 20, 'at most 20 lines in ten minutes');
    assert.ok(logs.some((l) => l.includes('/voice/continue/<sid>')), 'the call id is not printed');
    assert.equal(gate.stats().refused, 0);
  });
});

test('off checks nothing; no auth token stands the gate down in every mode and says so once', async () => {
  await withApp('off', async ({ post, logs }) => {
    assert.equal((await post('/sms', SMS)).status, 200);
    assert.deepEqual(logs, []);
  });
  await withApp('enforce', async ({ post, logs }) => {
    assert.equal((await post('/sms', SMS)).status, 200);
    assert.equal((await post('/sms', SMS)).status, 200);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /no TWILIO_AUTH_TOKEN/);
  }, { token: '' });
});

test('the mode switch: only off, log and enforce are modes; anything else is log', () => {
  assert.equal(gateMode({}), 'log');
  assert.equal(gateMode({ TWILIO_WEBHOOK_GATE: 'ENFORCE ' }), 'enforce');
  assert.equal(gateMode({ TWILIO_WEBHOOK_GATE: 'off' }), 'off');
  assert.equal(gateMode({ TWILIO_WEBHOOK_GATE: 'yes' }), 'log');
  assert.equal(routeLabel('/voice/heard/CAabcdef0123456789?x=1'), '/voice/heard/<sid>');
});

test('server.js mounts the gate on the Twilio paths before any route', () => {
  const source = fs.readFileSync(require.resolve('./server.js'), 'utf8');
  const mount = source.indexOf('app.use(twilioGate.TWILIO_PATHS, twilioWebhookGate);');
  assert.ok(mount > 0, 'mounted');
  assert.ok(mount > source.indexOf('app.use(express.urlencoded'), 'after the form parser (the signature covers the form fields)');
  assert.ok(mount < source.indexOf("app.post('/sms'"), 'before the routes');
  for (const m of source.matchAll(/app\.post\('(\/(?:sms|voice|voice-ws|voice-ws-outbound|voice-status|recording-status)(?:\/[^']*)?)'/g)) {
    assert.ok(TWILIO_PATHS.some((p) => m[1] === p || m[1].startsWith(p + '/')), `${m[1]} is covered`);
  }
});
