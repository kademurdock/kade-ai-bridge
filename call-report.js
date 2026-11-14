'use strict';
/* call-report.js — a character tells the person what happened on the call it made for them.
 *
 * Nov 14 2026, Kade's test call: Kiana placed the call, then said something like "message me back
 * later and I'll tell you what they said". Her words: "I don't think I like how it's like, message
 * me back later and I'll tell you what they said. It should be like, they message you when they're
 * done with the call."
 *
 * Why it worked that way: after dialing, the chat's phone tool told the character to say "you'll
 * have the answer when they next check in" and to run check_result on the person's NEXT message.
 * Nothing posted a result by itself. The bridge reported back only for wellness check-ins; for any
 * other call it saved the transcript and billed it, and it did not even know which conversation
 * the call came from.
 *
 * Now: the chat's phone tool (website, KadePhoneCall.js) sends reportBack:true and the chat's
 * conversationId with the call. When Twilio says the call is over (/voice-status: completed, busy,
 * no-answer, failed or canceled), this module waits a few seconds for the transcript (the stream
 * hands it over at hang-up, voice-stream.js onCallEnd) and asks the website to have the character
 * write ONE message into that conversation, with the push the platform already sends for character
 * messages: POST /api/kade/soul/speak, kind 'call', requested:true, push:true. The same door the
 * research and errands desks use (research.js and errands.js postBack). A call nobody answered is
 * reported too, in plain words.
 *
 * No double report: when the person asks first (check_result, POST /outbound/result) and gets the
 * finished transcript, the report is CLAIMED and this module stays quiet; when this module has
 * already posted or is posting, check_result says so, and the character does not repeat it.
 *
 * Errands (they post their own write-up), wellness check-ins (their own report) and briefings never
 * ask for this, so they are unchanged.
 *
 * Review fixes, Nov 14 2026 (same day):
 *   - A check_result that is already waiting on the call wins. /outbound/result marks the report
 *     awaited while it waits (report.awaitedAt), and run() gives it up to 4 s to claim the result
 *     before writing (yieldMs). Before, the report usually started writing first, so the person
 *     got the answer twice: once in the reply, once as the message.
 *   - The backup tap (when the website cannot write the message) is in the character's own words
 *     and says what happened ("I called Shell. They said: ..."), never "Ask me what they said".
 *     A 429 ("busy, try again in a minute") is tried again twice, a 5xx once, 60 s apart, before
 *     it falls back. A request that got no answer at all is NOT tried again: the website may still
 *     be writing it, and a second try could post it twice.
 *   - The push is urgent: the person asked for this call minutes ago and is waiting, so quiet
 *     hours do not hold it until 8 a.m. (the reminders' rule).
 *   - The note says what really happened: someone who answered and then went quiet, a call cut off
 *     by the 15 minute limit, a call cut off by a phone system restart.
 *   - A restart no longer loses the report. Each call that will report back is written to a small
 *     file on the volume when it is dialed (store), with its transcript once the call ends, and
 *     taken off once the report is settled. After a restart, a call still on that list is reported
 *     honestly from what was saved (recover, finishUnknown).
 *   - When a report settles after the call record was saved, the record is told (onSettled).
 *
 * Verification round, Nov 14 2026 (an independent review):
 *   - A check_result answered from the SAVED call record (server.js, 45 s or more after the call) while
 *     the report waits to try again after a 429 or 5xx now claims it too, so the retry does not post it.
 *   - The list on the volume is swept hourly (sweep): a call whose final status never came is settled
 *     from Twilio's status, through the same path as the status callback, and its message says it is
 *     late. An entry older than 2 hours is dropped, at boot too, whatever its status, so nobody gets a
 *     message about a call from days ago "cut off by a restart". At most 200 entries are kept.
 *   - The message asks the website for a new chat named for the call ("Call to Shell") when the chat it
 *     was placed from is temporary or gone, instead of an unrelated older chat (body.title).
 *
 * Cost: each report is one character-written message on the person's seat. The website keeps
 * these on MiMo (about 1 to 2 cents) unless KADE_CLAUDE_CALL_REPORTS=1 there; see
 * services/kadeCharacterTurn.js. Off switch: KADE_CALL_REPORT_BACK=0 (the call still works; the
 * old "ask me" flow comes back on the website side because the bridge then answers
 * reportBack:false). */

const AGENT_ID = /^agent_[A-Za-z0-9_-]{6,64}$/;
const CONVO_ID = /^[0-9a-f-]{36}$/i;
const USER_ID = /^[a-f0-9]{24}$/i;
const FINAL_STATUSES = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];
const MAX_PENDING = 200; // calls waiting to report back, kept on the volume (a call's entry is lean)

function enabled(env = process.env) {
  return String((env && env.KADE_CALL_REPORT_BACK) ?? '') !== '0';
}

/** The report fields /outbound-call stores on a call, or null when it will not report. */
function reportFields(body, { defaultAgentId, env = process.env } = {}) {
  const b = body || {};
  if (!enabled(env) || b.reportBack !== true) return null;
  if (b.wellness) return null; // check-ins have their own report
  const userId = String(b.userId || '');
  if (!USER_ID.test(userId)) return null; // the website needs a real account to post into
  const agentId = AGENT_ID.test(String(b.reportAgentId || '')) ? String(b.reportAgentId)
    : AGENT_ID.test(String(b.agentId || '')) ? String(b.agentId)
      : AGENT_ID.test(String(defaultAgentId || '')) ? String(defaultAgentId) : null;
  if (!agentId) return null;
  return {
    reportBack: true,
    reportAgentId: agentId,
    reportAgentName: String(b.reportAgentName || b.agentName || '').slice(0, 60) || null,
    conversationId: CONVO_ID.test(String(b.conversationId || '')) ? String(b.conversationId) : null,
    report: { state: 'waiting', at: Date.now() },
  };
}

const plain = (s) => String(s || '')
  .replace(/%%%[\s\S]*?%%%/g, ' ')
  .replace(/\[(?:END CALL|SAY NOTHING|PRESS[^\]]*|sound:[^\]]*|table:[^\]]*)\]/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const turnsOf = (meta) => (Array.isArray(meta.transcript) ? meta.transcript : []);
const theySpokeIn = (meta) => turnsOf(meta).some((t) => t && t.role === 'user' && plain(t.content));
const answeredCall = (meta) => String(meta.finalStatus || 'completed') === 'completed' && (meta.durationSec || 0) > 0;
/** Twilio's time limit ended it (the duration reached the limit the call was placed with). */
const hitTimeLimit = (meta) => {
  const limit = Number(meta.timeLimitSec) || 0;
  return limit > 0 && String(meta.finalStatus || 'completed') === 'completed' && (meta.durationSec || 0) >= limit - 5;
};
const minutesWord = (sec) => {
  const m = Math.round((Number(sec) || 0) / 60);
  return m > 0 ? `${m}-minute` : 'time';
};

/** What happened, in one plain sentence (or two) the character can build from. */
function outcomeLine(meta) {
  const status = String(meta.finalStatus || 'completed');
  const theySpoke = theySpokeIn(meta);
  if (status === 'busy') return 'The line was busy, so nobody answered.';
  if (status === 'no-answer') return 'Nobody picked up.';
  if (status === 'failed') return 'The call did not go through (the phone company could not connect it).';
  if (status === 'canceled') return 'The call was cancelled before anyone answered.';
  if (meta.restarted && answeredCall(meta)) {
    return theySpoke || turnsOf(meta).length
      ? 'The phone system restarted on our side around the time this call ended, so the end of the call may be missing from what is below.'
      : 'The phone system restarted on our side during this call, so it was cut off and what they said was lost.';
  }
  if (meta.voicemail) return 'It went to voicemail, and you left a short message.';
  if (meta.quietHangUp) {
    if (theySpoke) return 'Someone answered (their words are below), then the line went quiet. You asked if they could hear you, waited, and hung up.';
    if (meta.quietAfterWords) return 'Someone picked up and said hello, then the line went quiet. You asked if they could hear you, waited a few minutes, and hung up.';
    return 'Someone picked up, but you never heard anyone say anything, so you hung up after asking if they could hear you.';
  }
  if (hitTimeLimit(meta)) return `The call reached its ${minutesWord(meta.timeLimitSec)} limit and was cut off before it finished.`;
  if (!theySpoke) return 'The call connected, but you never heard the other side say anything.';
  return 'They picked up and you talked with them.';
}

/** The transcript as lines the character can read, newest last, capped. */
function transcriptText(meta, { agentName, maxChars = 3500 } = {}) {
  const me = agentName || 'You';
  const lines = turnsOf(meta)
    .map((t) => {
      const text = plain(t && t.content).replace(/^\[VOICEMAIL LEFT\]\s*/i, '(voicemail message) ');
      if (!text) return null;
      return `${t.role === 'user' ? 'Them' : me}: ${text}`;
    })
    .filter(Boolean);
  let out = lines.join('\n');
  if (out.length > maxChars) out = `(start of the call left out)\n${out.slice(out.length - maxChars)}`;
  return out;
}

/** Minutes since the call ended (it began at startedAt and ran durationSec), or 0 when unknown. */
function minutesSinceEnd(meta, now = Date.now()) {
  const began = Number(meta.startedAt) || 0;
  if (!began) return 0;
  return Math.max(0, Math.round((now - began - (Number(meta.durationSec) || 0) * 1000) / 60000));
}
const LATE_MIN = 10;

/** The platform note the character writes its one message from (never shown to the person). */
function buildNote(meta) {
  const caller = meta.agentName || 'the character';
  const reporter = meta.reportAgentName || caller;
  const delegated = meta.reportAgentId && meta.agentId && meta.reportAgentId !== meta.agentId;
  const who = meta.calleeName ? meta.calleeName : 'the number they gave you';
  const transcript = transcriptText(meta, { agentName: delegated ? caller : reporter });
  /* Verification round, Nov 14 2026: a report that comes long after the call (its end was only found by
   * the hourly sweep, or after a restart) says so, so it is not read as a call that just ended. */
  const lateMin = minutesSinceEnd(meta);
  const opening = lateMin >= LATE_MIN
    ? `The phone call you placed for them ended about ${lateMin} minutes ago. This message is late, so say when the call was.`
    : 'The phone call you placed for them just ended.';
  return [
    `${opening} ${delegated ? `You had ${caller} make it in their own voice. ` : ''}`.trim(),
    `Who was called: ${who}.`,
    `What the call was for: ${plain(meta.purpose).slice(0, 500)}`,
    `What happened: ${outcomeLine(meta)}`,
    transcript ? `The call, word for word ("Them" is whoever answered):\n${transcript}` : 'There is no transcript of anyone speaking.',
    'Tell them how it went, in your own voice: the answer first, then anything worth keeping (prices, times, names). ' +
      'Keep it short enough to listen to. Say only what the call above shows; if they did not answer the question, or nobody picked up, say that plainly. ' +
      'This is your report, so never ask them to message you back or to check in for it. ' +
      'Do not place another call or use any tools for this; everything you need is above.',
  ].join('\n');
}

/** Cut to at most n characters at a word, with an ellipsis when cut. */
function clip(s, n) {
  const t = String(s || '').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n).replace(/\s+\S*$/, '')}...`;
}

/**
 * The backup tap, in the character's own first person, when the website could not write the
 * message (review, Nov 14 2026: it used to say "Ask me what they said", the very check-back Kade
 * did not want, and lines meant for the character, "you left a short message", which VoiceOver
 * reads to her as if she had). Built from the call itself; at most about 300 characters.
 */
function tapText(meta) {
  const who = meta.calleeName || 'the number you gave me';
  const status = String(meta.finalStatus || 'completed');
  const said = turnsOf(meta).filter((t) => t && t.role === 'user').map((t) => plain(t.content)).filter(Boolean);
  if (status === 'busy') return `I called ${who}, but the line was busy.`;
  if (status === 'no-answer') return `I called ${who}, but nobody picked up.`;
  if (status === 'failed') return `I tried to call ${who}, but the call did not go through.`;
  if (status === 'canceled') return `The call to ${who} was cancelled before anyone answered.`;
  if (meta.restarted && answeredCall(meta) && !said.length) return `I called ${who}, but our phone system restarted during the call and cut it off, so I don't know what they said.`;
  if (meta.voicemail) return `I called ${who} and got voicemail, so I left a short message.`;
  if (!said.length) {
    if (meta.quietHangUp) return `I called ${who}. Someone picked up but never said anything, so I hung up.`;
    return `I called ${who}. The call connected, but I never heard anyone say anything.`;
  }
  const lead = hitTimeLimit(meta) ? `I called ${who}; the call hit its time limit. They said: ` : `I called ${who}. They said: `;
  return `${lead}"${clip(said.slice(-2).join(' '), 290 - lead.length)}"`;
}

/** What is kept on disk for a call that will report back (enough to report it after a restart). */
function pendingEntry(meta) {
  return {
    callSid: meta.callSid,
    userId: meta.userId,
    agentId: meta.agentId || null,
    agentName: meta.agentName || null,
    reportAgentId: meta.reportAgentId,
    reportAgentName: meta.reportAgentName || null,
    conversationId: meta.conversationId || null,
    calleeName: meta.calleeName || null,
    purpose: String(meta.purpose || '').slice(0, 500),
    startedAt: meta.startedAt || Date.now(),
    timeLimitSec: meta.timeLimitSec || null,
    state: 'waiting',
  };
}

/** A call record rebuilt from what was kept on disk, after a restart. */
function metaFromEntry(e, finalStatus, durationSec) {
  return {
    callSid: e.callSid,
    userId: e.userId,
    agentId: e.agentId,
    agentName: e.agentName,
    reportAgentId: e.reportAgentId,
    reportAgentName: e.reportAgentName,
    conversationId: e.conversationId,
    calleeName: e.calleeName,
    purpose: e.purpose,
    startedAt: e.startedAt,
    timeLimitSec: e.timeLimitSec,
    transcript: Array.isArray(e.transcript) ? e.transcript : null,
    voicemail: e.voicemail === true,
    quietHangUp: e.quietHangUp === true,
    quietAfterWords: e.quietAfterWords === true,
    finalStatus: String(finalStatus || e.finalStatus || 'completed'),
    durationSec: Number.isFinite(Number(durationSec)) ? Number(durationSec) : (e.durationSec || 0),
    reportBack: true,
    report: { state: 'waiting', at: Date.now() },
    // The old process never saw the call end (no final status on the list), so the restart is what
    // ended it, or happened as it ended. A call whose end WAS seen only lost its report: no notice.
    restarted: !e.finalStatus,
  };
}

/**
 * The reporter. All outside effects come in as functions, so tests run it with fakes.
 * @param {object} deps
 * @param {(body: object) => Promise<{ok:boolean, conversationId?:string, status?:number, error?:string}>} deps.speak
 *        POST /api/kade/soul/speak. `status` is the HTTP status when the website answered; none means
 *        no answer came (a timeout or a dropped connection).
 * @param {(push: object) => Promise<any>} [deps.notify]  the plain push used when the speak door fails
 * @param {(msg: string) => void} [deps.log]
 * @param {number} [deps.transcriptWaitMs]  how long an answered call waits for its transcript
 * @param {number} [deps.pollMs]
 * @param {number} [deps.yieldMs]   how long a waiting check_result is given to claim the result
 * @param {number} [deps.retryMs]   the wait before trying the website again after a 429 or 5xx
 * @param {{ load: () => object, save: (all: object) => void }} [deps.store]  the on-disk list
 * @param {(meta: object) => void} [deps.onSettled]  the report is done (posted, failed or claimed)
 */
function createCallReporter(deps) {
  const speak = deps.speak;
  const notify = deps.notify || (async () => null);
  const log = deps.log || ((m) => console.log(m));
  const transcriptWaitMs = deps.transcriptWaitMs ?? 10000;
  const pollMs = deps.pollMs ?? 250;
  const yieldMs = deps.yieldMs ?? 4000;
  const retryMs = deps.retryMs ?? 60000;
  const store = deps.store || null;
  const onSettled = deps.onSettled || (() => {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ── the on-disk list of calls that will report back ── */
  let pending = null;
  function pend() {
    if (pending) return pending;
    try { pending = (store && store.load()) || {}; } catch (_) { pending = {}; }
    if (!pending || typeof pending !== 'object' || Array.isArray(pending)) pending = {};
    return pending;
  }
  function persist() {
    if (!store) return;
    try { store.save(pend()); } catch (e) { log(`[call-report] could not save the pending list: ${e && e.message}`); }
  }
  /** A call that will report back was just dialed. */
  function track(meta) {
    if (!meta || meta.reportBack !== true || !meta.callSid) return;
    const all = pend();
    all[meta.callSid] = pendingEntry(meta);
    // Verification round: a cap, on top of the hourly sweep. The oldest go first.
    const ids = Object.keys(all);
    if (ids.length > MAX_PENDING) {
      ids.sort((a, b) => ((all[a] && all[a].startedAt) || 0) - ((all[b] && all[b].startedAt) || 0))
        .slice(0, ids.length - MAX_PENDING)
        .forEach((id) => { log(`[call-report] ${id}: dropped, the list is full`); delete all[id]; });
    }
    persist();
  }
  /** Keep what a restart would need: the transcript at hang-up, the final status, the state. */
  function note(meta, fields) {
    const e = meta && pend()[meta.callSid];
    if (!e) return;
    Object.assign(e, fields);
    persist();
  }
  function untrack(callSid) {
    if (callSid && pend()[callSid]) { delete pend()[callSid]; persist(); }
  }
  /** The stream handed over the transcript (server.js onCallEnd). */
  function noteTranscript(meta) {
    if (!meta || meta.reportBack !== true) return;
    note(meta, {
      transcript: turnsOf(meta).slice(-40),
      voicemail: meta.voicemail === true,
      quietHangUp: meta.quietHangUp === true,
      quietAfterWords: meta.quietAfterWords === true,
    });
  }
  function settle(meta) {
    untrack(meta.callSid);
    try { onSettled(meta); } catch (_) { /* the record is a convenience */ }
  }

  /** check_result read a finished call: the person is hearing it in the chat right now. */
  function claim(meta) {
    if (!meta || meta.reportBack !== true || !meta.report) return 'off';
    const s = meta.report.state;
    if (s === 'posting' || s === 'posted') return s;
    if (s === 'failed') return 'failed';
    meta.report.state = 'claimed';
    meta.report.at = Date.now();
    settle(meta);
    return 'claimed';
  }

  /** check_result is waiting on this call right now (it should get the result, not a second report). */
  function awaited(meta) {
    if (meta && meta.reportBack === true && meta.report) meta.report.awaitedAt = Date.now();
  }

  /** Twilio said the call is over. Fire and forget; never throws. */
  const active = new Map(); // callSid -> the call this process is reporting right now (never two runs for one call)
  function onFinal(meta) {
    if (!meta || meta.reportBack !== true || !meta.report) return Promise.resolve(false);
    if (meta.callSid && active.has(meta.callSid)) return Promise.resolve(false);
    note(meta, { finalStatus: meta.finalStatus || null, durationSec: meta.durationSec || 0 });
    if (meta.report.state !== 'waiting') {
      if (meta.report.state === 'claimed') settle(meta);
      return Promise.resolve(false);
    }
    if (meta.callSid) active.set(meta.callSid, meta);
    return run(meta)
      .catch((e) => { log(`[call-report] ${meta.callSid} failed: ${e && e.message}`); return false; })
      .finally(() => { if (meta.callSid) active.delete(meta.callSid); });
  }

  async function run(meta) {
    // An answered call: the stream hands over its transcript at hang-up; wait for it a little.
    const answered = answeredCall(meta);
    const until = Date.now() + transcriptWaitMs;
    while (answered && !turnsOf(meta).length && Date.now() < until) {
      if (meta.report.state !== 'waiting') break;
      await sleep(pollMs);
    }
    // A check_result waiting on this call gets the result first (it claims it), and no report is sent.
    const yieldUntil = Date.now() + yieldMs;
    while (meta.report.state === 'waiting' && meta.report.awaitedAt && Date.now() - meta.report.awaitedAt < pollMs * 4 + 1000 && Date.now() < yieldUntil) {
      await sleep(pollMs);
    }
    if (meta.report.state !== 'waiting') {
      log(`[call-report] ${meta.callSid}: not sent, the person already heard it (${meta.report.state})`);
      if (meta.report.state === 'claimed') settle(meta);
      return false;
    }
    const body = {
      userId: meta.userId,
      agentId: meta.reportAgentId,
      note: buildNote(meta).slice(0, 5900),
      conversationId: meta.conversationId || undefined,
      kind: 'call',
      requested: true,
      push: true,
      // The person asked for this call minutes ago and is waiting for it: quiet hours do not hold it.
      urgent: true,
      // What the other person said is in the note: the website treats it like text from outside.
      outsideText: true,
      /* Verification round: the name of the new chat the website starts when the chat the call was
       * placed from is temporary or gone (it never posts into an unrelated older chat). */
      title: meta.calleeName ? `Call to ${String(meta.calleeName).slice(0, 40)}` : 'Phone call',
    };
    // 429 = the site is writing other messages right now; 5xx = it failed or was restarting.
    let tries429 = 0;
    let tries5xx = 0;
    let lastError = '';
    for (;;) {
      if (meta.report.state !== 'waiting') {
        log(`[call-report] ${meta.callSid}: not sent, the person already heard it (${meta.report.state})`);
        if (meta.report.state === 'claimed') settle(meta);
        return false;
      }
      meta.report.state = 'posting';
      meta.report.at = Date.now();
      note(meta, { state: 'posting', postingAt: Date.now() });
      let r;
      try {
        r = await speak(body);
      } catch (e) {
        r = { ok: false, error: String((e && e.message) || e) };
      }
      if (r && r.ok) {
        meta.report.state = 'posted';
        meta.report.at = Date.now();
        meta.report.conversationId = r.conversationId || null;
        log(`[call-report] ${meta.callSid}: told them in their conversation (${String(meta.finalStatus || 'completed')})`);
        settle(meta);
        return true;
      }
      lastError = String((r && r.error) || 'the site did not post it').slice(0, 200);
      const status = Number(r && r.status) || 0;
      const again = (status === 429 && tries429 < 2) || (status >= 500 && tries5xx < 1);
      if (!again) break;
      if (status === 429) tries429 += 1; else tries5xx += 1;
      // While it waits, a check_result can still take it (claim sees 'waiting').
      meta.report.state = 'waiting';
      note(meta, { state: 'waiting' });
      log(`[call-report] ${meta.callSid}: the site said ${status} (${lastError}); trying again in ${Math.round(retryMs / 1000)} s`);
      await sleep(retryMs);
    }
    meta.report.state = 'failed';
    meta.report.at = Date.now();
    meta.report.error = lastError;
    log(`[call-report] ${meta.callSid}: the message could not be written (${lastError}); sending a plain tap instead`);
    try {
      await notify({
        userId: meta.userId,
        agentId: meta.reportAgentId,
        agentName: meta.reportAgentName || meta.agentName,
        title: String(meta.reportAgentName || meta.agentName || 'Your call').slice(0, 40),
        body: tapText(meta),
        requested: true,
        urgent: true,
        route: meta.conversationId ? 'conversation' : undefined,
        conversationId: meta.conversationId || undefined,
      });
    } catch (_) { /* the transcript is still there for check_result */ }
    settle(meta);
    return false;
  }

  /* ── after a restart ── */
  function entryFor(callSid) {
    return (callSid && pend()[callSid]) || null;
  }
  /** The newest call of this person's that is still on the list (an older website sends no call id). */
  function newestPendingFor(userId) {
    return Object.values(pend())
      .filter((e) => e && e.userId === userId)
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] || null;
  }
  /** check_result found the call only on the list: the person hears about it now, so no report too.
   *  If this process is already reporting it (after a restart), that report is claimed the same way
   *  claim() does it; `told` says what the person has already been sent. */
  function claimEntry(callSid) {
    const e = entryFor(callSid);
    if (!e) return null;
    const running = active.get(callSid);
    if (running) return { ...e, told: claim(running) };
    untrack(callSid);
    // Verification round: a process that stopped while the website was writing it left 'posting'
    // behind; the website finishes that on its own, so the person was (or is being) sent it.
    return { ...e, told: e.state === 'posting' ? 'posting' : 'claimed' };
  }
  /** Report a call this process did not place (it was placed before a restart), from the list. */
  function reportRecovered(e, finalStatus, durationSec) {
    if (active.has(e.callSid)) return Promise.resolve(false); // already being reported here
    if (e.state === 'posting') {
      // The website had it in hand when the bridge stopped; it finishes on its own. Never twice.
      log(`[call-report] ${e.callSid}: was being written when the bridge restarted; left to the website`);
      untrack(e.callSid);
      return Promise.resolve(false);
    }
    log(`[call-report] ${e.callSid}: reporting a call from before a restart (${finalStatus})`);
    return onFinal(metaFromEntry(e, finalStatus, durationSec));
  }
  /** /voice-status for a call this process does not know. Resolves false when it is not ours. */
  function finishUnknown(callSid, finalStatus, durationSec) {
    const e = entryFor(callSid);
    if (!e || !FINAL_STATUSES.includes(String(finalStatus))) return Promise.resolve(false);
    return reportRecovered(e, finalStatus, durationSec);
  }
  /** Verification round, Nov 14 2026: an entry older than maxAgeMs is dropped, whatever its status. A
   *  report hours or days after the call, told as cut off by a restart, would only confuse. */
  function dropIfOld(e, maxAgeMs) {
    if (Date.now() - (e.startedAt || 0) <= maxAgeMs) return false;
    log(`[call-report] ${e.callSid}: dropped, the call was more than ${Math.round(maxAgeMs / 60000)} minutes ago`);
    untrack(e.callSid);
    return true;
  }
  /**
   * At boot: every call still on the list. Its final status from Twilio when the list does not
   * have one; a call still going is left for its status callback; one older than maxAgeMs is dropped
   * (verification round: with a status too, not only without one).
   * @param {{ fetchStatus?: (sid: string) => Promise<{status: string, duration?: string|number}>, isLive?: (sid: string) => boolean, maxAgeMs?: number }} o
   */
  async function recover(o = {}) {
    const isLive = o.isLive || (() => false);
    const maxAgeMs = o.maxAgeMs ?? 2 * 3600 * 1000;
    let done = 0;
    for (const e of Object.values(pend())) {
      if (!e || !e.callSid || isLive(e.callSid) || active.has(e.callSid)) continue;
      if (e.state === 'posting') { await reportRecovered(e); continue; } // the website has it: off the list
      if (dropIfOld(e, maxAgeMs)) continue;
      let status = e.finalStatus || null;
      let duration = e.durationSec || 0;
      if (!status && o.fetchStatus) {
        try {
          const c = await o.fetchStatus(e.callSid);
          status = c && c.status ? String(c.status) : null;
          duration = parseInt(c && c.duration, 10) || 0;
        } catch (err) {
          log(`[call-report] ${e.callSid}: could not read its status after a restart: ${err && err.message}`);
        }
      }
      if (!status || !FINAL_STATUSES.includes(status)) continue;
      await reportRecovered(e, status, duration);
      done += 1;
    }
    return done;
  }

  /**
   * Verification round, Nov 14 2026: hourly while the bridge runs (server.js). A call's final status can
   * be lost (refused by the Twilio gate, a network fault), and its entry and words then sat on the volume
   * until the next boot, which reported it however old. Each entry older than olderThanMs (20 min: no call
   * runs longer than its 15 minute limit plus ringing) is settled from Twilio's own status, through
   * onFinalStatus (server.js finishOutboundStatus: the same path as Twilio's callback); one older than
   * maxAgeMs is dropped. A call still going, or one this process is reporting, is left alone.
   * @param {{ fetchStatus?: (sid: string) => Promise<{status: string, duration?: string|number}>,
   *   onFinalStatus?: (sid: string, status: string, durationSec: number) => any, olderThanMs?: number, maxAgeMs?: number }} o
   * @returns {Promise<number>} how many were settled
   */
  async function sweep(o = {}) {
    const olderThanMs = o.olderThanMs ?? 20 * 60 * 1000;
    const maxAgeMs = o.maxAgeMs ?? 2 * 3600 * 1000;
    let settled = 0;
    for (const e of Object.values(pend())) {
      if (!e || !e.callSid || active.has(e.callSid)) continue;
      if (dropIfOld(e, maxAgeMs)) continue;
      if (Date.now() - (e.startedAt || 0) < olderThanMs || !o.fetchStatus) continue;
      let c = null;
      try {
        c = await o.fetchStatus(e.callSid);
      } catch (err) {
        log(`[call-report] ${e.callSid}: the sweep could not read its status: ${err && err.message}`);
        continue;
      }
      const status = c && c.status ? String(c.status) : null;
      if (!status || !FINAL_STATUSES.includes(status)) continue;
      const duration = parseInt(c && c.duration, 10) || 0;
      log(`[call-report] ${e.callSid}: its final status never came; settling it from Twilio's (${status})`);
      try {
        if (o.onFinalStatus) await o.onFinalStatus(e.callSid, status, duration);
        else await reportRecovered(e, status, duration);
        settled += 1;
      } catch (err) {
        log(`[call-report] ${e.callSid}: the sweep could not settle it: ${err && err.message}`);
      }
    }
    return settled;
  }

  return { onFinal, claim, awaited, track, noteTranscript, entryFor, newestPendingFor, claimEntry, finishUnknown, recover, sweep, pendingList: () => ({ ...pend() }) };
}

module.exports = {
  enabled, reportFields, outcomeLine, transcriptText, buildNote, tapText, pendingEntry, metaFromEntry,
  createCallReporter, FINAL_STATUSES,
};
