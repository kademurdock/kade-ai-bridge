'use strict';
/* call-report.test.js — Nov 14 2026. The character messages the person when a call it made for
 * them ends (call-report.js; Kade: "they message you when they're done with the call"). Fakes
 * stand in for the website's speak door and the push; nothing leaves the PC. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cr = require('./call-report');

const USER = '6a3cba4d0b0afa92194e42f7';
const CONVO = '5fc62783-1111-4222-8333-944445555666';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function callMeta(over = {}) {
  const fields = cr.reportFields({
    reportBack: true, userId: USER, agentId: 'agent_kiana01', agentName: 'Kiana', conversationId: CONVO,
  }, { defaultAgentId: 'agent_default1' });
  return {
    callSid: 'CA1', userId: USER, userName: 'Kade Murdock', agentId: 'agent_kiana01', agentName: 'Kiana',
    calleeName: null, purpose: 'Kade wants to know if they have any deals on hemp products',
    transcript: null, finalStatus: null, durationSec: 0, ...fields, ...over,
  };
}
function reporter(over = {}) {
  const posts = [];
  const pushes = [];
  const logs = [];
  const r = cr.createCallReporter({
    speak: over.speak || (async (body) => { posts.push(body); return { ok: true, conversationId: CONVO }; }),
    notify: async (p) => { pushes.push(p); return { ok: true }; },
    log: (m) => logs.push(m),
    transcriptWaitMs: over.transcriptWaitMs ?? 1500,
    pollMs: 20,
  });
  return { r, posts, pushes, logs };
}
const TALK = [
  { role: 'assistant', content: "Hi, this is Kiana, an A I assistant calling for Kade, one of our users. This call may be recorded. I'm calling to ask if you have any deals on hemp products right now." },
  { role: 'user', content: "It's none of your business, they closed down last week." },
  { role: 'assistant', content: "%%%friendly%%% Oh, I'm sorry to hear that. Thanks for letting me know, and take care. [END CALL]" },
];

test('reportFields: only a chat call that asked for it, with a real account and character', () => {
  assert.equal(cr.reportFields({ userId: USER, agentId: 'agent_kiana01' }), null, 'not asked');
  assert.equal(cr.reportFields({ reportBack: true, userId: 'u-kade', agentId: 'agent_kiana01' }), null, 'not an account id');
  assert.equal(cr.reportFields({ reportBack: true, userId: USER, agentId: 'agent_kiana01', wellness: { scheduleId: 'x' } }), null, 'check-ins report for themselves');
  assert.equal(cr.reportFields({ reportBack: true, userId: USER, agentId: 'agent_kiana01' }, { env: { KADE_CALL_REPORT_BACK: '0' } }), null, 'switched off');
  const f = cr.reportFields({ reportBack: true, userId: USER, agentId: 'agent_lilly001', reportAgentId: 'agent_kiana01', reportAgentName: 'Kiana', conversationId: CONVO });
  assert.equal(f.reportAgentId, 'agent_kiana01', 'the character she asked writes it, not the one Kiana handed the call to');
  assert.equal(f.conversationId, CONVO);
  assert.equal(f.report.state, 'waiting');
  assert.equal(cr.reportFields({ reportBack: true, userId: USER, agentId: 'agent_kiana01', conversationId: 'new' }).conversationId, null);
  assert.equal(cr.reportFields({ reportBack: true, userId: USER }, { defaultAgentId: 'agent_default1' }).reportAgentId, 'agent_default1');
});

test('HER CALL: when it ends the character writes ONE message into her conversation, with the push, from the transcript', async () => {
  const { r, posts } = reporter();
  const meta = callMeta({ finalStatus: 'completed', durationSec: 74 });
  const done = r.onFinal(meta);
  await sleep(100);
  assert.equal(posts.length, 0, 'it waits for the transcript the stream hands over at hang-up');
  meta.transcript = TALK;
  assert.equal(await done, true);
  assert.equal(posts.length, 1);
  const b = posts[0];
  assert.equal(b.userId, USER);
  assert.equal(b.agentId, 'agent_kiana01');
  assert.equal(b.conversationId, CONVO);
  assert.equal(b.kind, 'call');
  assert.equal(b.requested, true);
  assert.equal(b.push, true);
  assert.match(b.note, /They picked up and you talked with them\./);
  assert.match(b.note, /Them: It's none of your business, they closed down last week\./);
  assert.match(b.note, /Kiana: Oh, I'm sorry to hear that\./);
  assert.equal(/%%%|\[END CALL\]/.test(b.note), false, 'voice directions and control tokens are not in the note');
  assert.match(b.note, /never ask them to message you back or to check in/);
  assert.match(b.note, /Do not place another call/);
  assert.equal(meta.report.state, 'posted');
  assert.equal(await r.onFinal(meta), false, 'never twice');
  assert.equal(posts.length, 1);
});

test('NOBODY ANSWERED: busy, no answer, failed and cancelled are reported at once, in plain words', async () => {
  const cases = { busy: 'The line was busy, so nobody answered.', 'no-answer': 'Nobody picked up.', failed: 'The call did not go through', canceled: 'The call was cancelled before anyone answered.' };
  for (const [status, words] of Object.entries(cases)) {
    const { r, posts } = reporter();
    const meta = callMeta({ finalStatus: status, durationSec: 0 });
    const t0 = Date.now();
    assert.equal(await r.onFinal(meta), true, status);
    assert.ok(Date.now() - t0 < 500, 'no wait for a transcript that will never come');
    assert.ok(posts[0].note.includes(words), status);
    assert.match(posts[0].note, /There is no transcript of anyone speaking/);
  }
});

test('voicemail and a silent line are told as what they were, not as a talk', () => {
  assert.equal(cr.outcomeLine(callMeta({ finalStatus: 'completed', voicemail: true })), 'It went to voicemail, and you left a short message.');
  assert.match(cr.outcomeLine(callMeta({ finalStatus: 'completed', quietHangUp: true })), /never heard anyone say anything/);
  assert.match(cr.outcomeLine(callMeta({ finalStatus: 'completed', transcript: [TALK[0]] })), /never heard the other side/);
  assert.match(cr.transcriptText({ transcript: [{ role: 'assistant', content: '[VOICEMAIL LEFT] Hi, this is Kiana.' }] }, { agentName: 'Kiana' }), /^Kiana: \(voicemail message\) Hi, this is Kiana\.$/);
});

test('ASKED FIRST: when check_result hands her the finished call, the character\'s own report is not sent too', async () => {
  const { r, posts, logs } = reporter();
  const meta = callMeta({ transcript: TALK });
  assert.equal(r.claim(meta), 'claimed');
  meta.finalStatus = 'completed';
  meta.durationSec = 74;
  assert.equal(await r.onFinal(meta), false);
  assert.equal(posts.length, 0);
  assert.ok(logs.some((l) => /already heard it/.test(l)) || meta.report.state === 'claimed');
});

test('ALREADY TOLD: check_result after the report went says so (the website tells the character not to repeat it)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { r } = reporter({ speak: async () => { await gate; return { ok: true, conversationId: CONVO }; } });
  const meta = callMeta({ finalStatus: 'completed', durationSec: 30, transcript: TALK });
  const done = r.onFinal(meta);
  await sleep(50);
  assert.equal(r.claim(meta), 'posting');
  release();
  await done;
  assert.equal(r.claim(meta), 'posted');
  assert.equal(r.claim(callMeta({ reportBack: false, report: null })), 'off');
});

test('THE WEBSITE COULD NOT WRITE IT: a plain tap goes instead, and check_result still has the transcript', async () => {
  const { r, pushes } = reporter({ speak: async () => ({ ok: false, error: 'busy, try again in a minute' }) });
  const meta = callMeta({ finalStatus: 'completed', durationSec: 30, transcript: TALK, calleeName: 'Shell' });
  assert.equal(await r.onFinal(meta), false);
  assert.equal(meta.report.state, 'failed');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].requested, true);
  assert.equal(pushes[0].userId, USER);
  assert.equal(pushes[0].body, 'The call to Shell is done. Ask me what they said.');
  assert.equal(pushes[0].conversationId, CONVO);
  const { r: r2, pushes: p2 } = reporter({ speak: async () => { throw new Error('socket hang up'); } });
  await r2.onFinal(callMeta({ finalStatus: 'no-answer' }));
  assert.equal(p2[0].body, 'Your call is done. Nobody picked up.');
});

test('a call that did not ask for a report (errands, check-ins, briefings) never posts', async () => {
  const { r, posts } = reporter();
  assert.equal(await r.onFinal({ callSid: 'CA2', reportBack: false, finalStatus: 'completed', transcript: TALK }), false);
  assert.equal(await r.onFinal({ callSid: 'CA3', finalStatus: 'busy' }), false);
  assert.equal(posts.length, 0);
});

test('the transcript never came: it still reports after a short wait, saying what it knows', async () => {
  const { r, posts } = reporter({ transcriptWaitMs: 200 });
  const meta = callMeta({ finalStatus: 'completed', durationSec: 12 });
  assert.equal(await r.onFinal(meta), true);
  assert.match(posts[0].note, /There is no transcript of anyone speaking/);
});

test('a call Kiana handed to another character is reported by Kiana, who says who made it', () => {
  const meta = callMeta({ agentId: 'agent_lilly001', agentName: 'Lilly', reportAgentId: 'agent_kiana01', reportAgentName: 'Kiana', transcript: TALK, finalStatus: 'completed' });
  const note = cr.buildNote(meta);
  assert.match(note, /You had Lilly make it in their own voice\./);
  assert.match(note, /Lilly: Oh, I'm sorry/);
});

/* server.js cannot be loaded in a test (it starts the whole bridge), so the wiring is read from
 * its source: the place that would silently undo this work if it ever drifted. */
test('server.js wiring: the report rides /outbound-call, fires on Twilio\'s final status, and check_result claims it', () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(src, /const report = callReport\.reportFields\(req\.body, \{ defaultAgentId: DEFAULT_AGENT \}\);/);
  assert.match(src, /\.\.\.\(report \|\| \{ reportBack: false \}\),/);
  assert.match(src, /reportBack: !!report,/);
  const status = src.slice(src.indexOf("app.post('/voice-status'"), src.indexOf("app.post('/recording-status'"));
  assert.match(status, /callReporter\.onFinal\(meta\);/);
  const result = src.slice(src.indexOf("app.post('/outbound/result'"), src.indexOf("app.get('/outbound/calls'"));
  assert.match(result, /const told = callReporter\.claim\(live\);/);
  assert.match(result, /reportedToChat: told === 'posting' \|\| told === 'posted'/);
  assert.match(result, /reportedToChat: done\.reportState === 'posting' \|\| done\.reportState === 'posted'/);
  // The greeting: one composer, with the chat's business flag and the errands' disclose.
  assert.match(src, /outboundGreeting\.composeOutboundGreeting\(\{[\s\S]{0,400}disclose: disclose === true,\s*business: businessFlag,\s*unregisteredIsBusiness: unregisteredIsBusiness === true,/);
  assert.match(src, /business: composed\.business,/);
  assert.match(src, /api\/kade\/soul\/speak/);
});
