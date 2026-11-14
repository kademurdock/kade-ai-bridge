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
    transcript: null, finalStatus: null, durationSec: 0, timeLimitSec: 900, startedAt: Date.now(), ...fields, ...over,
  };
}
function memStore(initial = {}) {
  let saved = JSON.parse(JSON.stringify(initial));
  return { load: () => JSON.parse(JSON.stringify(saved)), save: (all) => { saved = JSON.parse(JSON.stringify(all)); }, read: () => saved };
}
function reporter(over = {}) {
  const posts = [];
  const pushes = [];
  const logs = [];
  const settled = [];
  const r = cr.createCallReporter({
    speak: over.speak || (async (body) => { posts.push(body); return { ok: true, conversationId: CONVO }; }),
    notify: async (p) => { pushes.push(p); return { ok: true }; },
    log: (m) => logs.push(m),
    transcriptWaitMs: over.transcriptWaitMs ?? 1500,
    pollMs: 20,
    yieldMs: over.yieldMs ?? 400,
    retryMs: over.retryMs ?? 30,
    store: over.store,
    onSettled: (m) => settled.push(m.report.state),
  });
  return { r, posts, pushes, logs, settled };
}
const TALK = [
  { role: 'assistant', content: "Hi, this is Kiana, an A I assistant calling on behalf of a customer, Kade Murdock. This call may be recorded. I'm calling to ask if you have any deals on hemp products right now." },
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

test('HER CALL: when it ends the character writes ONE message into her conversation, with an urgent push, from the transcript', async () => {
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
  assert.equal(b.urgent, true, 'review: quiet hours must not hold a report she is waiting for until 8 a.m.');
  assert.equal(b.outsideText, true, 'review: the other person\'s words are outside text to the website');
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

test('REVIEW: a quiet hang-up after someone DID speak says so, never "you never heard anyone"', () => {
  const pickup = [{ role: 'user', content: 'Shell, this is Mike.' }, TALK[0], { role: 'assistant', content: 'Hello? Can you hear me?' }];
  const spoke = cr.outcomeLine(callMeta({ finalStatus: 'completed', durationSec: 40, quietHangUp: true, transcript: pickup }));
  assert.match(spoke, /^Someone answered \(their words are below\), then the line went quiet\./);
  assert.equal(/never heard anyone/.test(spoke), false);
  const hello = cr.outcomeLine(callMeta({ finalStatus: 'completed', durationSec: 200, quietHangUp: true, quietAfterWords: true, transcript: [TALK[0]] }));
  assert.match(hello, /^Someone picked up and said hello, then the line went quiet\./);
});

test('REVIEW: a call the 15 minute limit cut off is reported as that, not as a normal talk', () => {
  const held = [TALK[0], { role: 'user', content: 'Can you hold one moment?' }, { role: 'assistant', content: 'Sure.' }];
  assert.equal(cr.outcomeLine(callMeta({ finalStatus: 'completed', durationSec: 900, timeLimitSec: 900, transcript: held })),
    'The call reached its 15-minute limit and was cut off before it finished.');
  assert.equal(cr.outcomeLine(callMeta({ finalStatus: 'completed', durationSec: 897, timeLimitSec: 900, transcript: held })),
    'The call reached its 15-minute limit and was cut off before it finished.', 'Twilio counts a little short');
  assert.equal(cr.outcomeLine(callMeta({ finalStatus: 'completed', durationSec: 300, timeLimitSec: 900, transcript: held })), 'They picked up and you talked with them.');
  assert.equal(cr.outcomeLine(callMeta({ finalStatus: 'completed', durationSec: 900, timeLimitSec: null, transcript: held })), 'They picked up and you talked with them.', 'an older record without the limit');
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

/* Finding 12 of the review: she asks "did they answer yet?" while the call is running. check_result
 * waits on the bridge (/outbound/result), the call ends, and the report used to start writing
 * before the wait noticed, so she got the answer in the reply AND as a message (47 of 60 runs). The
 * loop below is server.js's: it marks the report awaited and looks every 250 ms (scaled to 20 ms),
 * and claims once the transcript is in. Twilio's status lands at a random moment around hang-up. */
test('REVIEW: a check_result already waiting on the call wins; the report is not sent too (60 runs, random timing)', async () => {
  let doubles = 0;
  let reports = 0;
  for (let run = 0; run < 60; run += 1) {
    const { r, posts } = reporter({ yieldMs: 400 });
    const meta = callMeta();
    let claimed = null;
    const over = (m) => !!(m.transcript && m.transcript.length) || (m.finalized && m.finalStatus !== 'completed');
    const check = (async () => {
      const deadline = Date.now() + 3000;
      while (!over(meta) && Date.now() < deadline) { r.awaited(meta); await sleep(20); }
      if (over(meta)) claimed = r.claim(meta);
    })();
    await sleep(30 + Math.random() * 60);
    // The call ends: the stream hands over the transcript and Twilio's status comes, in either order.
    const statusFirst = Math.random() < 0.5;
    const hangUp = () => { meta.transcript = TALK; };
    let finalP = null;
    const status = () => { meta.finalized = true; meta.finalStatus = 'completed'; meta.durationSec = 50; finalP = r.onFinal(meta); };
    if (statusFirst) { status(); await sleep(Math.random() * 30); hangUp(); } else { hangUp(); await sleep(Math.random() * 30); status(); }
    await check;
    await finalP;
    if (posts.length) reports += 1;
    if (posts.length && claimed === 'claimed') doubles += 1;
    assert.ok(claimed === 'claimed' || claimed === 'posting' || claimed === 'posted', `run ${run}: ${claimed}`);
    if (claimed === 'posting' || claimed === 'posted') doubles += 1; // the reply would say "already messaged" and answer too
  }
  assert.equal(doubles, 0, 'the person got it twice');
  assert.equal(reports, 0, 'the waiting answer took every one');
});

test('REVIEW: a check_result that stopped waiting long ago does not hold the report back', async () => {
  const { r, posts } = reporter({ yieldMs: 2000 });
  const meta = callMeta({ finalStatus: 'completed', durationSec: 30, transcript: TALK });
  meta.report.awaitedAt = Date.now() - 60000; // its wait ended a minute ago ("still in progress")
  const t0 = Date.now();
  assert.equal(await r.onFinal(meta), true);
  assert.ok(Date.now() - t0 < 600, 'no yield for a wait that is over');
  assert.equal(posts.length, 1);
});

test('THE WEBSITE COULD NOT WRITE IT: the backup tap is in Kiana\'s own words, says what happened, and never asks her to ask', async () => {
  const { r, pushes } = reporter({ speak: async () => ({ ok: false, status: 400, error: 'note must be 10 to 6000 characters' }) });
  const meta = callMeta({ finalStatus: 'completed', durationSec: 30, transcript: TALK, calleeName: 'Shell' });
  assert.equal(await r.onFinal(meta), false);
  assert.equal(meta.report.state, 'failed');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].requested, true);
  assert.equal(pushes[0].urgent, true);
  assert.equal(pushes[0].userId, USER);
  assert.equal(pushes[0].body, 'I called Shell. They said: "It\'s none of your business, they closed down last week."');
  assert.equal(pushes[0].conversationId, CONVO);
  const { r: r2, pushes: p2 } = reporter({ speak: async () => { throw new Error('socket hang up'); } });
  await r2.onFinal(callMeta({ finalStatus: 'no-answer' }));
  assert.equal(p2[0].body, 'I called the number you gave me, but nobody picked up.');
});

test('tapText: every ending, first person, never "Ask me", never "you" for what Kiana did', () => {
  const t = (over) => cr.tapText(callMeta({ calleeName: 'Shell', finalStatus: 'completed', durationSec: 30, ...over }));
  const all = [
    t({ finalStatus: 'busy', durationSec: 0 }),
    t({ finalStatus: 'no-answer', durationSec: 0 }),
    t({ finalStatus: 'failed', durationSec: 0 }),
    t({ finalStatus: 'canceled', durationSec: 0 }),
    t({ voicemail: true, transcript: [{ role: 'assistant', content: '[VOICEMAIL LEFT] Hi.' }] }),
    t({ quietHangUp: true, transcript: [TALK[0]] }),
    t({ transcript: [TALK[0]] }),
    t({ transcript: TALK }),
    t({ transcript: TALK, durationSec: 900 }),
    t({ restarted: true, transcript: null }),
  ];
  assert.deepEqual(all.slice(0, 7), [
    'I called Shell, but the line was busy.',
    'I called Shell, but nobody picked up.',
    'I tried to call Shell, but the call did not go through.',
    'The call to Shell was cancelled before anyone answered.',
    'I called Shell and got voicemail, so I left a short message.',
    'I called Shell. Someone picked up but never said anything, so I hung up.',
    'I called Shell. The call connected, but I never heard anyone say anything.',
  ]);
  assert.match(all[8], /^I called Shell; the call hit its time limit\. They said: "/);
  assert.match(all[9], /our phone system restarted during the call/);
  for (const line of all) {
    assert.equal(/ask me|check in|message me|you left|you hung up|you talked/i.test(line), false, line);
    assert.ok(line.length <= 300, `fits a push: ${line.length}`);
  }
  const long = t({ transcript: [{ role: 'user', content: 'word '.repeat(200) }] });
  assert.ok(long.length <= 300 && /\.\.\."$/.test(long), 'a long answer is cut to fit, at a word');
});

test('REVIEW: "busy, try again in a minute" (429) is tried again twice, a 5xx once, then the tap; no answer at all is never tried again', async () => {
  const seq = (statuses) => {
    const calls = [];
    const speak = async () => {
      const s = statuses[calls.length];
      calls.push(s);
      if (s === 200) return { ok: true, conversationId: CONVO };
      if (s === 'timeout') return { ok: false, error: 'timeout of 480000ms exceeded' };
      return { ok: false, status: s, error: s === 429 ? 'busy, try again in a minute' : 'bad gateway' };
    };
    return { calls, speak };
  };
  const a = seq([429, 429, 200]);
  const ra = reporter({ speak: a.speak });
  assert.equal(await ra.r.onFinal(callMeta({ finalStatus: 'completed', durationSec: 30, transcript: TALK })), true);
  assert.deepEqual(a.calls, [429, 429, 200]);
  assert.equal(ra.pushes.length, 0, 'no backup tap when a retry wrote it');
  const b = seq([429, 429, 429]);
  const rb = reporter({ speak: b.speak });
  assert.equal(await rb.r.onFinal(callMeta({ finalStatus: 'completed', durationSec: 30, transcript: TALK })), false);
  assert.deepEqual(b.calls, [429, 429, 429]);
  assert.equal(rb.pushes.length, 1, 'the tap after the last try');
  const c = seq([502, 200]);
  const rc = reporter({ speak: c.speak });
  assert.equal(await rc.r.onFinal(callMeta({ finalStatus: 'completed', durationSec: 30, transcript: TALK })), true);
  assert.deepEqual(c.calls, [502, 200]);
  const d = seq([502, 503]);
  const rd = reporter({ speak: d.speak });
  assert.equal(await rd.r.onFinal(callMeta({ finalStatus: 'completed', durationSec: 30, transcript: TALK })), false);
  assert.deepEqual(d.calls, [502, 503]);
  const e = seq(['timeout']);
  const re = reporter({ speak: e.speak });
  assert.equal(await re.r.onFinal(callMeta({ finalStatus: 'completed', durationSec: 30, transcript: TALK })), false);
  assert.deepEqual(e.calls, ['timeout'], 'the website may still be writing it: never a second try');
});

test('REVIEW: while a retry waits, a check_result can still take the result, and then nothing more is sent', async () => {
  const calls = [];
  const { r, pushes } = reporter({ retryMs: 300, speak: async () => { calls.push(1); return { ok: false, status: 429, error: 'busy' }; } });
  const meta = callMeta({ finalStatus: 'completed', durationSec: 30, transcript: TALK });
  const done = r.onFinal(meta);
  await sleep(100);
  assert.equal(r.claim(meta), 'claimed');
  assert.equal(await done, false);
  assert.equal(calls.length, 1);
  assert.equal(pushes.length, 0);
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

/* Finding 14 of the review: everything about a live call lived only in memory, so a bridge restart
 * during a call (5 to 9 deploys a day) lost the report Kiana had promised. */
test('REVIEW: a call that will report back is kept on disk from dialing until its report settles', async () => {
  const store = memStore();
  const { r, settled } = reporter({ store });
  const meta = callMeta({ callSid: 'CA10', calleeName: 'Shell' });
  r.track(meta);
  assert.deepEqual(Object.keys(store.read()), ['CA10']);
  assert.equal(store.read().CA10.state, 'waiting');
  assert.equal(store.read().CA10.purpose, meta.purpose);
  meta.transcript = TALK;
  r.noteTranscript(meta);
  assert.equal(store.read().CA10.transcript.length, 3, 'what was said is kept as soon as the stream hands it over');
  meta.finalStatus = 'completed';
  meta.durationSec = 40;
  assert.equal(await r.onFinal(meta), true);
  assert.deepEqual(store.read(), {}, 'off the list once posted');
  assert.deepEqual(settled, ['posted']);
  // Claimed by check_result: off the list too, and never reported after a restart.
  const m2 = callMeta({ callSid: 'CA11', transcript: TALK });
  r.track(m2);
  assert.equal(r.claim(m2), 'claimed');
  assert.deepEqual(store.read(), {});
});

test('REVIEW: after a restart, a call still on the list is reported honestly from what was saved', async () => {
  // The old process saved the transcript at hang-up, then stopped before Twilio's final status.
  const base = cr.pendingEntry(callMeta({ callSid: 'CA20', calleeName: 'Shell' }));
  const store = memStore({
    CA20: { ...base, transcript: TALK },
    CA21: { ...cr.pendingEntry(callMeta({ callSid: 'CA21' })) },                     // cut off, nothing saved
    CA22: { ...cr.pendingEntry(callMeta({ callSid: 'CA22' })), state: 'posting' },   // the website had it in hand
    CA23: { ...cr.pendingEntry(callMeta({ callSid: 'CA23' })) },                     // still ringing
    CA24: { ...cr.pendingEntry(callMeta({ callSid: 'CA24' })), startedAt: Date.now() - 3 * 3600 * 1000 }, // ancient, no status
  });
  const { r, posts } = reporter({ store, transcriptWaitMs: 50 });
  const statuses = { CA20: { status: 'completed', duration: '61' }, CA21: { status: 'completed', duration: '35' }, CA23: { status: 'ringing' } };
  const n = await r.recover({ fetchStatus: async (sid) => { if (!statuses[sid]) throw new Error('not found'); return statuses[sid]; } });
  assert.equal(n, 2);
  assert.equal(posts.length, 2);
  const by = Object.fromEntries(posts.map((p) => [p.note.includes('Shell') ? 'CA20' : 'CA21', p.note]));
  assert.match(by.CA20, /restarted on our side around the time this call ended, so the end of the call may be missing/);
  assert.match(by.CA20, /Them: It's none of your business, they closed down last week\./);
  assert.match(by.CA21, /restarted on our side during this call, so it was cut off and what they said was lost/);
  assert.deepEqual(Object.keys(store.read()).sort(), ['CA23'], 'posted ones off; the website keeps CA22; CA23 waits for its status; CA24 dropped');
  // CA23's status callback reaches the new process later.
  assert.equal(await r.finishUnknown('CA23', 'no-answer', 0), true);
  assert.match(posts[2].note, /Nobody picked up\./);
  assert.equal(/restarted/.test(posts[2].note), false, 'a call nobody answered was not cut off by anything');
  assert.deepEqual(store.read(), {});
  assert.equal(await r.finishUnknown('CA99', 'completed', 10), false, 'not ours: nothing');
});

test('REVIEW: a call whose end the old process saw only lost its report: no restart notice in it', async () => {
  const store = memStore({ CA30: { ...cr.pendingEntry(callMeta({ callSid: 'CA30' })), transcript: TALK, finalStatus: 'completed', durationSec: 50 } });
  const { r, posts } = reporter({ store });
  assert.equal(await r.recover({}), 1);
  assert.match(posts[0].note, /They picked up and you talked with them\./);
});

test('REVIEW: check_result after a restart finds the cut-off call on the list (claimEntry), so no report comes on top', async () => {
  const store = memStore({ CA40: { ...cr.pendingEntry(callMeta({ callSid: 'CA40' })), transcript: TALK } });
  const { r, posts } = reporter({ store });
  assert.equal(r.newestPendingFor(USER).callSid, 'CA40');
  assert.equal(r.newestPendingFor('ffffffffffffffffffffffff'), null);
  const e = r.claimEntry('CA40');
  assert.equal(e.transcript.length, 3);
  assert.equal(await r.finishUnknown('CA40', 'completed', 30), false);
  assert.equal(posts.length, 0);
});

test('REVIEW: after a restart, a check_result that comes while the recovered report is running takes it over, or is told it went', async () => {
  // Waiting for a transcript that will never come (the old process saved none): claimEntry stops it.
  const store = memStore({ CA50: { ...cr.pendingEntry(callMeta({ callSid: 'CA50' })) } });
  const { r, posts } = reporter({ store, transcriptWaitMs: 600 });
  const running = r.finishUnknown('CA50', 'completed', 30);
  await sleep(100);
  const got = r.claimEntry('CA50');
  assert.equal(got.told, 'claimed');
  assert.equal(await running, false);
  assert.equal(posts.length, 0, 'the person heard it from check_result; no message on top');
  assert.deepEqual(store.read(), {});
  // Already being written: the person is told it was sent, not given a second copy.
  let release;
  const gate = new Promise((res) => { release = res; });
  const store2 = memStore({ CA51: { ...cr.pendingEntry(callMeta({ callSid: 'CA51' })), transcript: TALK } });
  const two = reporter({ store: store2, speak: async () => { await gate; return { ok: true, conversationId: CONVO }; } });
  const writing = two.r.finishUnknown('CA51', 'completed', 30);
  await sleep(100);
  assert.equal(two.r.claimEntry('CA51').told, 'posting');
  release();
  assert.equal(await writing, true);
});

/* Verification round, Nov 14 2026. The server-level races (the saved call record, the hourly sweep through
 * the status path) are in call-report.server.test.js; these are the reporter's own parts. */
test('VERIFY 15: the hourly sweep settles a stuck call from Twilio\'s status, leaves young and live ones, and drops old ones', async () => {
  const now = Date.now();
  const entry = (sid, minutesAgo, over = {}) => ({ ...cr.pendingEntry(callMeta({ callSid: sid })), startedAt: now - minutesAgo * 60000, ...over });
  const store = memStore({
    CA60: entry('CA60', 25, { transcript: TALK }), // its status callback was lost
    CA61: entry('CA61', 5),                        // still young: may be ringing or talking
    CA62: entry('CA62', 30),                       // Twilio says it is still going
    CA63: entry('CA63', 3 * 60),                   // three hours old
  });
  const { r } = reporter({ store });
  const finished = [];
  const fetched = [];
  const statuses = { CA60: { status: 'completed', duration: '61' }, CA62: { status: 'in-progress' } };
  const n = await r.sweep({
    fetchStatus: async (sid) => { fetched.push(sid); return statuses[sid]; },
    onFinalStatus: async (sid, status, dur) => { finished.push([sid, status, dur]); },
  });
  assert.equal(n, 1);
  assert.deepEqual(finished, [['CA60', 'completed', 61]], 'settled through the same path as the status callback');
  assert.deepEqual(fetched.sort(), ['CA60', 'CA62'], 'Twilio is read only for entries older than 20 minutes');
  assert.deepEqual(Object.keys(store.read()).sort(), ['CA60', 'CA61', 'CA62'], 'the three-hour-old one is dropped (CA60 leaves when its report settles)');
  // Without a status path of its own, the sweep reports the entry itself.
  const store2 = memStore({ CA64: entry('CA64', 25, { transcript: TALK }) });
  const two = reporter({ store: store2, transcriptWaitMs: 50 });
  assert.equal(await two.r.sweep({ fetchStatus: async () => ({ status: 'completed', duration: '40' }) }), 1);
  await sleep(100);
  assert.equal(two.posts.length, 1);
  assert.deepEqual(store2.read(), {});
});

test('VERIFY 15: the list keeps at most 200 calls, dropping the oldest', () => {
  const store = memStore();
  const { r } = reporter({ store });
  for (let i = 0; i < 205; i += 1) r.track(callMeta({ callSid: `CA${String(i).padStart(4, '0')}`, startedAt: 1000 + i }));
  const kept = Object.keys(store.read());
  assert.equal(kept.length, 200);
  assert.equal(kept.includes('CA0000'), false);
  assert.equal(kept.includes('CA0204'), true);
});

test('VERIFY 15: a report long after the call says it is late; one minutes after it does not', () => {
  const late = cr.buildNote(callMeta({ finalStatus: 'completed', durationSec: 60, transcript: TALK, startedAt: Date.now() - 41 * 60000 }));
  assert.match(late, /^The phone call you placed for them ended about 40 minutes ago\. This message is late/);
  const fresh = cr.buildNote(callMeta({ finalStatus: 'completed', durationSec: 60, transcript: TALK, startedAt: Date.now() - 90000 }));
  assert.match(fresh, /^The phone call you placed for them just ended\./);
});

test('VERIFY 16: the message names a chat for the call, used when the chat it came from is temporary or gone', async () => {
  const { r, posts } = reporter();
  await r.onFinal(callMeta({ finalStatus: 'no-answer', calleeName: 'Shell' }));
  assert.equal(posts[0].title, 'Call to Shell');
  const two = reporter();
  await two.r.onFinal(callMeta({ finalStatus: 'busy' }));
  assert.equal(two.posts[0].title, 'Phone call');
});

test('VERIFY 12: claimEntry for a call a stopped process was still posting says it went (the website finishes it)', () => {
  const store = memStore({ CA70: { ...cr.pendingEntry(callMeta({ callSid: 'CA70' })), transcript: TALK, state: 'posting' } });
  const { r } = reporter({ store });
  assert.equal(r.claimEntry('CA70').told, 'posting');
  assert.deepEqual(store.read(), {});
});

/* server.js cannot be loaded in a test (it starts the whole bridge), so the wiring is read from
 * its source: the place that would silently undo this work if it ever drifted. */
test('server.js wiring: the report rides /outbound-call, fires on Twilio\'s final status, and check_result claims it', () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(src, /const report = callReport\.reportFields\(req\.body, \{ defaultAgentId: DEFAULT_AGENT \}\);/);
  assert.match(src, /\.\.\.\(report \|\| \{ reportBack: false \}\),/);
  assert.match(src, /timeLimitSec: OUTBOUND_TIME_LIMIT_SEC,/);
  assert.match(src, /reportBack: !!report,/);
  assert.match(src, /if \(report\) callReporter\.track\(outboundMeta\.get\(call\.sid\)\);/);
  const status = src.slice(src.indexOf("app.post('/voice-status'"), src.indexOf("app.post('/recording-status'"));
  assert.match(status, /callReporter\.onFinal\(meta\);/);
  assert.match(status, /meta\.finalizedAt = Date\.now\(\);/);
  assert.match(status, /callReporter\.finishUnknown\(CallSid, CallStatus/);
  const result = src.slice(src.indexOf("app.post('/outbound/result'"), src.indexOf("app.get('/outbound/calls'"));
  assert.match(result, /const told = callReporter\.claim\(live\);/);
  assert.match(result, /callReporter\.awaited\(live\);/);
  assert.match(result, /setTimeout\(r, 250\)/, 'the wait looks every 250 ms');
  assert.equal(/setTimeout\(r, 2500\)/.test(result), false);
  assert.match(result, /Date\.now\(\) - \(m\.finalizedAt \|\| 0\) >= 10000/, 'an answered call waits for its transcript before it is claimed');
  assert.match(result, /callReporter\.claimEntry\(cut\.callSid\)/);
  assert.match(result, /status: 'interrupted'/);
  assert.match(result, /reportedToChat: toldCut === 'posting' \|\| toldCut === 'posted'/);
  assert.match(result, /reportedToChat: told === 'posting' \|\| told === 'posted'/);
  // Verification round: the answer from the saved record claims a report still on the list too.
  assert.match(result, /const toldDone = callReporter\.entryFor\(done\.callSid\) \? \(callReporter\.claimEntry\(done\.callSid\) \|\| \{\}\)\.told : null;/);
  assert.match(result, /: done\.reportState === 'posting' \|\| done\.reportState === 'posted',/);
  const end = src.slice(src.indexOf('function onCallEnd('), src.indexOf('async function endCall('));
  assert.match(end, /callReporter\.noteTranscript\(meta\)/);
  assert.match(src, /callReporter\.recover\(\{/);
  assert.match(src, /onSettled: \(meta\) => \{/);
  assert.match(src, /KADE_CALL_REPORT_TIMEOUT_MS \|\| '480000'/);
  assert.match(src, /return \{ ok: false, status: r\.status,/);
  // The greeting: one composer, with the chat's business flag and the errands' disclose.
  assert.match(src, /outboundGreeting\.composeOutboundGreeting\(\{[\s\S]{0,400}disclose: disclose === true,\s*business: businessFlag,\s*unregisteredIsBusiness: unregisteredIsBusiness === true,/);
  assert.match(src, /business: composed\.business,/);
  assert.match(src, /api\/kade\/soul\/speak/);
});
