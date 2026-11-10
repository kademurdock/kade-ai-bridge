'use strict';
/* call-socket-webhook.test.js — Nov 10 2026. The other end of the call socket gate: the two
 * webhooks that hand Twilio a stream address (/voice-ws, /voice-ws-outbound) and now a ticket with
 * it. The SHIPPED handlers are cut out of server.js and mounted on a real express app behind the
 * real Twilio signature gate, with real twilio signature maths and real TwiML. 127.0.0.1 only. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const twilio = require('twilio');
const { createTwilioGate, TWILIO_PATHS } = require('./twilio-gate');
const { createCallSocketGate } = require('./call-socket-gate');

const SOURCE = fs.readFileSync(require.resolve('./server.js'), 'utf8').replace(/\r\n/g, '\n');
const TOKEN = 'test-auth-token-0123456789abcdef';
const PUBLIC = 'https://bridge.example.test';
const SID = 'CA0123456789abcdef0123456789abcdef';
const FROM = '+14175550101';

function handlerSource(route) {
  const start = SOURCE.indexOf(`app.post('${route}', (req, res) => {`);
  assert.ok(start > -1, `${route} handler found in server.js`);
  const end = SOURCE.indexOf('\n});\n', start);
  assert.ok(end > start);
  return SOURCE.slice(start, end + 5);
}

async function withBridge(run, { lookup } = {}) {
  const lookups = [];
  const socketGate = createCallSocketGate({
    secret: 'webhook-test', mode: 'enforce', log: { log() {}, warn() {} },
    fetchCall: async (sid) => { lookups.push(sid); if (lookup) return lookup(sid); throw Object.assign(new Error('nf'), { status: 404 }); },
  });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(TWILIO_PATHS, createTwilioGate({ token: TOKEN, publicUrl: PUBLIC, validateRequest: twilio.validateRequest, mode: 'log', log: { warn() {} } }));
  const ctx = vm.createContext({ app, twilio, process: { env: { RAILWAY_PUBLIC_DOMAIN: 'bridge.example.test' } }, callSocketGate: socketGate, encodeURIComponent });
  vm.runInContext(handlerSource('/voice-ws'), ctx);
  vm.runInContext(handlerSource('/voice-ws-outbound'), ctx);
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
  try { return await run({ post, signed, socketGate, lookups }); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}

/** The <Parameter> values of the <Stream>, the way Twilio hands them to the socket's start message. */
function streamParams(twiml) {
  const out = {};
  for (const m of twiml.matchAll(/<Parameter name="([^"]+)" value="([^"]*)"\/>/g)) out[m[1]] = m[2].replace(/&amp;/g, '&');
  return out;
}

test('a call Twilio really sent: the stream carries a ticket, and that ticket alone opens the socket', async () => {
  await withBridge(async ({ signed, socketGate, lookups }) => {
    const r = await signed('/voice-ws', { CallSid: SID, From: FROM, To: '+18335550100' });
    assert.equal(r.status, 200);
    assert.match(r.text, /<Stream url="wss:\/\/bridge\.example\.test\/ws\/media">/);
    const p = streamParams(r.text);
    assert.equal(p.from, FROM);
    assert.equal(p.callSid, SID);
    assert.ok(p.ticket && p.ticket.startsWith('v1.'), 'a ticket rides the stream');
    assert.ok(!p.ticket.includes(FROM.slice(1)) && !p.ticket.includes(SID), 'the ticket shows neither the number nor the call id');
    assert.deepEqual(socketGate.quick({ ticket: p.ticket, callSid: p.callSid, from: p.from }), { verdict: 'pass', how: 'ticket' });
    assert.equal(lookups.length, 0);
  });
});

test('ANYONE can post to /voice-ws while the Twilio gate only logs: the ticket they get back opens nothing', async () => {
  await withBridge(async ({ post, socketGate }) => {
    const r = await post('/voice-ws', { CallSid: SID, From: FROM });
    assert.equal(r.status, 200, 'log mode: still answered, as before');
    const p = streamParams(r.text);
    assert.ok(p.ticket);
    const q = socketGate.quick({ ticket: p.ticket, callSid: p.callSid, from: p.from });
    assert.equal(q.verdict, 'ask');
    assert.equal(q.why, 'ticket was minted for an unsigned webhook');
    const final = await socketGate.settle({ callSid: p.callSid, from: p.from }, q.why);
    assert.equal(final.verdict, 'refuse', 'Twilio knows no such call');
    assert.equal(socketGate.record(final, p.callSid), false);
  });
});

test('a wrong signature gets the same unsigned ticket as no signature', async () => {
  await withBridge(async ({ post, socketGate }) => {
    const r = await post('/voice-ws', { CallSid: SID, From: FROM }, { 'X-Twilio-Signature': 'bm90IGEgcmVhbCBzaWduYXR1cmU=' });
    const p = streamParams(r.text);
    assert.equal(socketGate.quick({ ticket: p.ticket, callSid: p.callSid, from: p.from }).verdict, 'ask');
  });
});

test('a ticket cannot be moved to another number or another call', async () => {
  await withBridge(async ({ signed, socketGate }) => {
    const p = streamParams((await signed('/voice-ws', { CallSid: SID, From: FROM })).text);
    assert.equal(socketGate.quick({ ticket: p.ticket, callSid: SID, from: '+14175550999' }).why, 'ticket is not for this call');
    assert.equal(socketGate.quick({ ticket: p.ticket, callSid: 'CAffffffffffffffffffffffffffffffff', from: FROM }).why, 'ticket is not for this call');
    assert.equal(socketGate.quick({ ticket: p.ticket, callSid: SID, from: FROM, outbound: true }).why, 'ticket is for the other direction');
  });
});

test('an outbound call: the ticket is for the dialled number and the outbound direction', async () => {
  await withBridge(async ({ signed, socketGate }) => {
    const path = `/voice-ws-outbound?userPhone=${encodeURIComponent(FROM)}`;
    const r = await signed(path, { CallSid: SID, To: FROM, From: '+18335550100' });
    const p = streamParams(r.text);
    assert.equal(p.outbound, '1');
    assert.equal(p.from, FROM);
    assert.deepEqual(socketGate.quick({ ticket: p.ticket, callSid: p.callSid, from: p.from, outbound: p.outbound === '1' }), { verdict: 'pass', how: 'ticket' });
  });
});

test('server.js hands the gate to the call socket and makes it from a secret it already holds', () => {
  assert.match(SOURCE, /callSocketGate, \/\/ Nov 10 2026: \/ws\/media asks this before a call gets a session/);
  assert.match(SOURCE, /secret: BRIDGE_SECRET \|\| TWILIO_TOKEN \|\| ''/);
  assert.match(SOURCE, /fetchCall: twilioClient \? \(sid\) => twilioClient\.calls\(sid\)\.fetch\(\) : null/);
  assert.equal((SOURCE.match(/callSocketGate\.mint\(/g) || []).length, 2, 'both stream webhooks mint a ticket');
  assert.equal((SOURCE.match(/url: `wss:\/\/\$\{wsHost\}\/ws\/media`/g) || []).length, 2, 'and there is no third way to the call socket');
});
