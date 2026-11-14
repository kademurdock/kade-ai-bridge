'use strict';
/* call-report.server.test.js — Nov 14 2026, verification round. The report-back path through the REAL
 * server.js handlers: the callReporter wiring, /voice-status (and finishOutboundStatus), the call
 * record (finalizeOutboundCall), /outbound/result and onCallEnd. server.js cannot be loaded whole in a
 * test (it starts the bridge), so those pieces are cut from its source text and run with fakes around
 * them: the website's speak door, the push, Twilio and the volume are all stand-ins. Nothing leaves the
 * PC. Times are scaled: retry 60 s -> 0.9 s, transcript wait 10 s -> 1 s, finalize 45 s -> 0.3 s. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const callReport = require('./call-report');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
function cut(start, end) {
  const a = SRC.indexOf(start);
  if (a < 0) throw new Error(`server.js changed: "${start}" not found`);
  const b = SRC.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`server.js changed: "${end}" not found after "${start}"`);
  return SRC.slice(a, b);
}

/** One bridge process. `disk` stands in for the volume and may be shared by two processes (a restart). */
function boot({ disk = new Map(), speak, finalizeMs = 300, reporter = {}, twilioFetch } = {}) {
  const handlers = {};
  const app = { post: (p, h) => { handlers[`POST ${p}`] = h; }, get: (p, h) => { handlers[`GET ${p}`] = h; } };
  const logs = [];
  const quiet = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
  const speakCalls = [];
  const pushes = [];
  const axios = {
    post: async (url, body) => {
      if (/\/api\/kade\/soul\/speak$/.test(url)) {
        speakCalls.push({ body, at: Date.now() });
        return speak(body, speakCalls.length);
      }
      return { status: 200, data: {} }; // usage events
    },
  };
  const outboundMeta = new Map();
  const outboundLog = [];
  const loadJsonFile = (file, fallback) => (disk.has(file) ? JSON.parse(disk.get(file)) : fallback);
  const saveJsonFile = (file, data) => { disk.set(file, JSON.stringify(data)); };
  const twilioClient = { calls: (sid) => ({ fetch: twilioFetch ? () => twilioFetch(sid) : async () => ({ duration: '60', price: '-0.0200' }) }) };

  let reporterBlock = cut('const OUTBOUND_REPORTS_FILE', 'const lastDialed');
  const scale = Object.entries(reporter).map(([k, v]) => `${k}: ${JSON.stringify(v)},`).join(' ');
  reporterBlock = reporterBlock.replace('callReport.createCallReporter({', `callReport.createCallReporter({ ${scale}`);
  let statusBlock = cut("app.post('/voice-status'", '// Recording status callback');
  if (!statusBlock.includes(', 45000);')) throw new Error('server.js changed: the 45 s finalize delay is gone');
  statusBlock = statusBlock.replace(', 45000);', `, ${finalizeMs});`);
  const finalizeBlock = cut('async function finalizeOutboundCall(callSid) {', '// Agent-facing (July 2 2026')
    .replace(/setTimeout\(r, 30000\)/g, 'setTimeout(r, 30)').replace(/setTimeout\(r, 15000\)/g, 'setTimeout(r, 15)');
  const resultBlock = cut("app.post('/outbound/result'", "app.get('/outbound/calls'");
  const endBlock = cut('function onCallEnd(callSid, history) {', 'async function endCall(');
  const exportsLine = `return { callReporter, onCallEnd, finalizeOutboundCall, OUTBOUND_REPORTS_FILE,
    finishOutboundStatus: typeof finishOutboundStatus === 'function' ? finishOutboundStatus : null };`;
  const names = ['app', 'axios', 'path', 'os', 'callReport', 'outboundMeta', 'outboundLog', 'loadJsonFile', 'saveJsonFile',
    'twilioClient', 'BRIDGE_SECRET', 'FORK_USAGE_URL', 'BROWSER_UA', 'runNotify', 'bridgeSecretOk', 'RECORDING_USD_PER_MIN',
    'USAGE_EVENT_SECRET', 'wellnessReportBack', 'console', 'process', 'OUTBOUND_LOG_FILE'];
  const values = [app, axios, path.posix, os, callReport, outboundMeta, outboundLog, loadJsonFile, saveJsonFile,
    twilioClient, 'test-secret', 'http://site.invalid', 'ua', async (p) => { pushes.push(p); return { ok: true, sent: 1 }; },
    () => true, 0.0025, '', async () => {}, quiet, { env: { RAILWAY_VOLUME_MOUNT_PATH: '/vol' } }, '/vol/outbound-calls.json'];
  // eslint-disable-next-line no-new-func
  const made = new Function(...names, [reporterBlock, statusBlock, finalizeBlock, resultBlock, endBlock, exportsLine].join('\n'))(...values);

  function call(route, reqBody) {
    return new Promise((resolve, reject) => {
      const res = {
        code: 200,
        status(c) { this.code = c; return this; },
        json(o) { resolve({ code: this.code, body: o }); },
        end() { resolve({ code: this.code, body: null }); },
      };
      Promise.resolve(handlers[route]({ body: reqBody, get: () => '' }, res)).catch(reject);
    });
  }

  /** What /outbound-call keeps for a chat call that reports back (the fields this path reads). */
  function place({ sid, userId, conversationId, startedAt = Date.now(), calleeName = 'Shell' }) {
    const reqBody = { userId, agentId: 'agent_kiana0001', agentName: 'Kiana', reportBack: true, conversationId };
    const report = callReport.reportFields(reqBody, { defaultAgentId: 'agent_default001' });
    outboundMeta.set(sid, {
      callSid: sid, userId, userName: 'Test Person', to: '+15555550100', calleeName, purpose: 'ask if you have any deals on hemp products',
      agentId: 'agent_kiana0001', agentName: 'Kiana', startedAt, business: true, tier: 'stranger',
      ...(report || { reportBack: false }), timeLimitSec: 900,
    });
    if (report) made.callReporter.track(outboundMeta.get(sid));
    return outboundMeta.get(sid);
  }

  return { ...made, call, place, outboundMeta, outboundLog, disk, speakCalls, pushes, logs };
}

const U1 = '6a3cba4d0b0afa92194e42f7';
const C1 = '5fc62783-1111-4222-8333-944445555666';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TALK = [
  { role: 'assistant', content: "Hi, this is Kiana, an A I assistant calling on behalf of a customer. This call may be recorded. I'm calling to ask if you have any deals on hemp products." },
  { role: 'user', content: 'We closed down last week.' },
  { role: 'assistant', content: 'Thanks for letting me know. Take care. [END CALL]' },
];
const SCALE = { retryMs: 900, transcriptWaitMs: 1000, pollMs: 25, yieldMs: 400 };
const PENDING = '/vol/outbound-report-pending.json';

for (const [label, first, byId] of [
  ['429, asked by call id', { status: 429, data: { error: 'busy, try again in a minute' } }, true],
  ['502, asked with no call id (an older website)', { status: 502, data: { error: 'the site would not start the turn' } }, false],
]) {
  test(`VERIFY 12 (${label}): check_result after the call record was saved, while the report waits to try again, claims it: the person hears it once`, async () => {
    let n = 0;
    const b = boot({ speak: async () => (++n === 1 ? first : { status: 200, data: { ok: true, conversationId: C1 } }), reporter: SCALE });
    b.place({ sid: 'CA1', userId: U1, conversationId: C1 });
    b.onCallEnd('CA1', TALK);
    await b.call('POST /voice-status', { CallSid: 'CA1', CallStatus: 'completed', CallDuration: '60' });
    await sleep(500); // the record is saved (0.3 s, Twilio had the price at once); the retry is due at about 0.9 s
    assert.equal(b.outboundMeta.has('CA1'), false, 'the live record is gone: the answer comes from the saved one');
    assert.equal(b.outboundLog[0].reportState, 'waiting');
    const r = await b.call('POST /outbound/result', { secret: 'x', userId: U1, ...(byId ? { callSid: 'CA1' } : {}), waitSec: 0 });
    assert.equal(r.body.found, true);
    assert.equal(r.body.transcript.length, 3, 'the model gets the whole call');
    assert.equal(r.body.reportedToChat, false, 'nothing was sent yet, so it tells them in full');
    await sleep(1100);
    assert.equal(b.speakCalls.length, 1, 'only the first try: the retry did not write the message on top (before: 2)');
    assert.equal(b.pushes.length, 0, 'and no backup tap');
    assert.deepEqual(JSON.parse(b.disk.get(PENDING)), {}, 'off the list');
    assert.equal(b.outboundLog[0].reportState, 'claimed', 'the saved record says she heard it from check_result');
  });
}

test('VERIFY 12 control: a report that already went is still said to have gone', async () => {
  const b = boot({ speak: async () => ({ status: 200, data: { ok: true, conversationId: C1 } }), reporter: SCALE });
  b.place({ sid: 'CA2', userId: U1, conversationId: C1 });
  b.onCallEnd('CA2', TALK);
  await b.call('POST /voice-status', { CallSid: 'CA2', CallStatus: 'completed', CallDuration: '60' });
  await sleep(700);
  const r = await b.call('POST /outbound/result', { secret: 'x', userId: U1, callSid: 'CA2', waitSec: 0 });
  assert.equal(r.body.reportedToChat, true);
  assert.equal(b.speakCalls.length, 1);
});

test('VERIFY 15a: a call whose final status never came is settled by the hourly sweep from Twilio\'s status, and says it is late', async () => {
  const twenty5 = 25 * 60 * 1000;
  const b = boot({ speak: async () => ({ status: 200, data: { ok: true, conversationId: C1 } }), reporter: SCALE,
    twilioFetch: async () => ({ status: 'completed', duration: '60', price: '-0.0200' }) });
  b.place({ sid: 'CA3', userId: U1, conversationId: C1, startedAt: Date.now() - twenty5 });
  b.onCallEnd('CA3', TALK); // the stream handed its transcript over; Twilio's status callback was lost
  assert.equal(typeof b.finishOutboundStatus, 'function', 'server.js finishes a status in one place (before: only inside /voice-status)');
  const n = await b.callReporter.sweep({
    fetchStatus: async () => ({ status: 'completed', duration: '60' }),
    onFinalStatus: (sid, status, dur) => b.finishOutboundStatus(sid, status, String(dur)),
  });
  assert.equal(n, 1);
  await sleep(800);
  assert.equal(b.speakCalls.length, 1, 'reported once');
  const note = b.speakCalls[0].body.note;
  assert.match(note, /Them: We closed down last week\./);
  assert.equal(/restarted/.test(note), false, 'nothing restarted');
  assert.match(note, /^The phone call you placed for them ended about 2\d minutes ago\. This message is late/);
  assert.deepEqual(JSON.parse(b.disk.get(PENDING)), {});
  assert.equal(b.outboundLog.length, 1, 'and the call record is saved, as /voice-status would have');
});

test('VERIFY 15b: an entry days old is dropped at boot, never reported as cut off by a restart', async () => {
  const disk = new Map();
  const one = boot({ disk, speak: async () => ({ status: 200, data: { ok: true } }), reporter: SCALE });
  one.place({ sid: 'CA4', userId: U1, conversationId: C1, startedAt: Date.now() - 3 * 86400000 });
  one.onCallEnd('CA4', TALK);
  const later = boot({ disk, speak: async () => ({ status: 200, data: { ok: true } }), reporter: SCALE });
  const n = await later.callReporter.recover({ fetchStatus: async () => ({ status: 'completed', duration: '60' }), isLive: () => false });
  await sleep(100);
  assert.equal(n, 0, 'not reported (before: reported three days late as a call a restart cut off)');
  assert.equal(later.speakCalls.length, 0);
  assert.deepEqual(JSON.parse(disk.get(PENDING)), {}, 'off the volume');
});

test('VERIFY wiring: the hourly sweep runs while the bridge runs, through the same status path as Twilio\'s callback', () => {
  assert.match(SRC, /callReporter\.sweep\(\{[\s\S]{0,400}onFinalStatus: \(sid, status, duration\) => finishOutboundStatus\(sid, status, duration\)/);
  assert.match(SRC, /setInterval\(sweepReports, REPORT_SWEEP_MS\)/);
  const status = SRC.slice(SRC.indexOf("app.post('/voice-status'"), SRC.indexOf('// Recording status callback'));
  assert.match(status, /finishOutboundStatus\(CallSid, CallStatus, CallDuration\);/);
});
