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
 * Cost: each report is one character-written message on the person's seat, the speak-first lane,
 * which since Nov 14 2026 is written by Claude for verified adults (about 20 cents measured).
 * Off switch: KADE_CALL_REPORT_BACK=0 (the call still works; the old "ask me" flow comes back on
 * the website side because the bridge then answers reportBack:false). */

const AGENT_ID = /^agent_[A-Za-z0-9_-]{6,64}$/;
const CONVO_ID = /^[0-9a-f-]{36}$/i;
const USER_ID = /^[a-f0-9]{24}$/i;

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

/** What happened, in one plain sentence the character can build from. */
function outcomeLine(meta) {
  const status = String(meta.finalStatus || 'completed');
  const turns = Array.isArray(meta.transcript) ? meta.transcript : [];
  const theySpoke = turns.some((t) => t && t.role === 'user' && plain(t.content));
  if (status === 'busy') return 'The line was busy, so nobody answered.';
  if (status === 'no-answer') return 'Nobody picked up.';
  if (status === 'failed') return 'The call did not go through (the phone company could not connect it).';
  if (status === 'canceled') return 'The call was cancelled before anyone answered.';
  if (meta.voicemail) return 'It went to voicemail, and you left a short message.';
  if (meta.quietHangUp) return 'Someone picked up, but you never heard anyone say anything, so you hung up after asking if they could hear you.';
  if (!theySpoke) return 'The call connected, but you never heard the other side say anything.';
  return 'They picked up and you talked with them.';
}

/** The transcript as lines the character can read, newest last, capped. */
function transcriptText(meta, { agentName, maxChars = 3500 } = {}) {
  const me = agentName || 'You';
  const lines = (Array.isArray(meta.transcript) ? meta.transcript : [])
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

/** The platform note the character writes its one message from (never shown to the person). */
function buildNote(meta) {
  const caller = meta.agentName || 'the character';
  const reporter = meta.reportAgentName || caller;
  const delegated = meta.reportAgentId && meta.agentId && meta.reportAgentId !== meta.agentId;
  const who = meta.calleeName ? meta.calleeName : 'the number they gave you';
  const transcript = transcriptText(meta, { agentName: delegated ? caller : reporter });
  return [
    `The phone call you placed for them just ended. ${delegated ? `You had ${caller} make it in their own voice. ` : ''}`.trim(),
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

/**
 * The reporter. All outside effects come in as functions, so tests run it with fakes.
 * @param {object} deps
 * @param {(body: object) => Promise<{ok:boolean, conversationId?:string}>} deps.speak  POST /api/kade/soul/speak
 * @param {(push: object) => Promise<any>} [deps.notify]  the plain push used when the speak door fails
 * @param {(msg: string) => void} [deps.log]
 * @param {number} [deps.transcriptWaitMs]  how long an answered call waits for its transcript
 * @param {number} [deps.pollMs]
 */
function createCallReporter(deps) {
  const speak = deps.speak;
  const notify = deps.notify || (async () => null);
  const log = deps.log || ((m) => console.log(m));
  const transcriptWaitMs = deps.transcriptWaitMs ?? 10000;
  const pollMs = deps.pollMs ?? 250;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** check_result read a finished call: the person is hearing it in the chat right now. */
  function claim(meta) {
    if (!meta || meta.reportBack !== true || !meta.report) return 'off';
    const s = meta.report.state;
    if (s === 'posting' || s === 'posted') return s;
    if (s === 'failed') return 'failed';
    meta.report.state = 'claimed';
    meta.report.at = Date.now();
    return 'claimed';
  }

  /** Twilio said the call is over. Fire and forget; never throws. */
  function onFinal(meta) {
    if (!meta || meta.reportBack !== true || !meta.report || meta.report.state !== 'waiting') return Promise.resolve(false);
    return run(meta).catch((e) => { log(`[call-report] ${meta.callSid} failed: ${e && e.message}`); return false; });
  }

  async function run(meta) {
    // An answered call: the stream hands over its transcript at hang-up; wait for it a little.
    const answered = String(meta.finalStatus || '') === 'completed' && (meta.durationSec || 0) > 0;
    const until = Date.now() + transcriptWaitMs;
    while (answered && !(Array.isArray(meta.transcript) && meta.transcript.length) && Date.now() < until) {
      if (meta.report.state !== 'waiting') return false;
      await sleep(pollMs);
    }
    if (meta.report.state !== 'waiting') {
      log(`[call-report] ${meta.callSid}: not sent, the person already heard it (${meta.report.state})`);
      return false;
    }
    meta.report.state = 'posting';
    meta.report.at = Date.now();
    const body = {
      userId: meta.userId,
      agentId: meta.reportAgentId,
      note: buildNote(meta).slice(0, 5900),
      conversationId: meta.conversationId || undefined,
      kind: 'call',
      requested: true,
      push: true,
    };
    try {
      const r = await speak(body);
      if (r && r.ok) {
        meta.report.state = 'posted';
        meta.report.at = Date.now();
        meta.report.conversationId = r.conversationId || null;
        log(`[call-report] ${meta.callSid}: told them in their conversation (${String(meta.finalStatus || 'completed')})`);
        return true;
      }
      throw new Error((r && r.error) || 'the site did not post it');
    } catch (e) {
      meta.report.state = 'failed';
      meta.report.at = Date.now();
      meta.report.error = String((e && e.message) || e).slice(0, 200);
      log(`[call-report] ${meta.callSid}: the message could not be written (${meta.report.error}); sending a plain tap instead`);
      try {
        const talked = /you talked with them/.test(outcomeLine(meta));
        const callTo = meta.calleeName ? `The call to ${meta.calleeName} is done.` : 'Your call is done.';
        await notify({
          userId: meta.userId,
          agentId: meta.reportAgentId,
          agentName: meta.reportAgentName || meta.agentName,
          title: String(meta.reportAgentName || meta.agentName || 'Your call').slice(0, 40),
          body: talked ? `${callTo} Ask me what they said.` : `${callTo} ${outcomeLine(meta)}`,
          requested: true,
          route: meta.conversationId ? 'conversation' : undefined,
          conversationId: meta.conversationId || undefined,
        });
      } catch (_) { /* the transcript is still there for check_result */ }
      return false;
    }
  }

  return { onFinal, claim };
}

module.exports = { enabled, reportFields, outcomeLine, transcriptText, buildNote, createCallReporter };
