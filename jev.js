'use strict';
/* Part 236 (Sep 20 2026). Jev is TypeSafe's decision model: it takes state
 * plus typed questions (choice / noul / score) and returns probabilities, no
 * prose. It never writes a word anybody hears. The proxy got it first
 * (reframe-proxy/jev.js: think-tier routing and the replay judge); this is the
 * bridge's copy, same shape, same contract.
 *
 * THE CONTRACT, and every caller in this repo keeps it: Jev is a first or
 * second opinion, never the only road. ask() THROWS on any failure (no key,
 * killed, HTTP error, timeout, malformed answer) and the caller falls back to
 * exactly what it did before Jev existed. A Jev verdict alone never hangs up
 * a call, dials a phone, sends a message, pages her, or deletes anything. It
 * may only (a) stop one of those when the regex would have done it wrongly,
 * or (b) recognise an intent the regex missed where being wrong is cheap and
 * the person can simply say it again.
 *
 * Every question below was run against the live API on labelled cases before
 * it was wired (scratchpad jev_bridge_trials.js); the thresholds beside each
 * one come from those runs and the numbers are in the comment. Jev is weak at
 * counting, numbers and dates, so nothing here asks it to count.
 *
 * The version is pinned; jev-latest moves under you.
 * Kill: KADE_JEV=0, or unset TYPESAFE_API_KEY. Per feature: KADE_JEV_CANARY,
 * KADE_JEV_GATE, KADE_JEV_CONSENT, KADE_JEV_BATTERY, KADE_JEV_RESEARCH,
 * KADE_JEV_SWITCH (=0 turns that one off). Leashes: KADE_JEV_GATE_MS,
 * KADE_JEV_SWITCH_MS. */
const URL = process.env.KADE_JEV_URL || 'https://api.typesafe.ai/v1/systemone';
const MODEL = process.env.KADE_JEV_MODEL || 'jev-1.13.0';
const counts = { ok: 0, failed: 0 };

/* The two leashes a person on a phone waits behind. MEASURED Sep 20 from
 * kadepc: a warm connection answers in 130-430 ms, but the FIRST call of a
 * fresh process took 557-1263 ms (six runs), and four of the first five calls
 * in a burst blew a 700 ms leash. A gated call is rare, so most of its Jev
 * reads will be cold ones. A blown leash is only today's behaviour, never
 * worse — but if /platform-status shows jev.failed climbing on Railway, these
 * are the numbers to raise (900-1200) before deciding the switch is no use. */
const GATE_MS = Math.max(200, parseInt(process.env.KADE_JEV_GATE_MS || '700', 10) || 700);
const SWITCH_MS = Math.max(200, parseInt(process.env.KADE_JEV_SWITCH_MS || '600', 10) || 600);

// Read at call time, not at require time: tests flip these, and a kill switch
// that needs a restart to read is only half a kill switch on paper.
function key() { return process.env.TYPESAFE_API_KEY || ''; }

function enabled(flag) {
  return !!key() && process.env.KADE_JEV !== '0' && (!flag || process.env[flag] !== '0');
}

async function ask(state, questions, timeoutMs = 1500) {
  if (!enabled()) throw new Error('jev disabled');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(URL, {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json', 'User-Agent': 'kade-ai-bridge/1.0' },
      body: JSON.stringify({ state, model: MODEL, questions }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || !j.answers || typeof j.answers !== 'object') throw new Error('no answers');
    counts.ok++;
    return { answers: j.answers, usage: j.usage || null, model: j.model || MODEL };
  } catch (e) {
    counts.failed++;
    throw new Error(e && e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : String(e && e.message || e));
  } finally {
    clearTimeout(timer);
  }
}

function noulOf(answers, id) {
  const p = answers && answers[id] && answers[id].noul;
  if (typeof p !== 'number' || !(p >= 0 && p <= 1)) throw new Error(`bad ${id} answer`);
  return p;
}

/* ── B1: THE CANARY'S SECOND OPINION ──────────────────────────────────────
 * The canary's fact check is a regex, and a regex has now cried wolf twice
 * (Aug 11, Aug 21 — both in server.js). "The one where the leaves drop" is a
 * right answer that /fall|autumn/ fails. Two questions ride one request:
 *   correct  — does `reply` correctly answer `question`?
 *   attempt  — is `reply` an on-topic attempt at `question`? (no counting)
 * Trial, Sep 20, 22 cases: right answers the regex would fail scored 0.93 to
 * 0.98 (one roundabout sum, "a dozen and three more", 0.68 — stays red, the
 * safe side); every WRONG answer ("Winter", "fourteen", "green") scored 0.06
 * or under, so 0.9 overruled no wrong answer. Error text, greetings and
 * off-topic replies scored 0.01-0.02 on `attempt`; the weakest honest attempt
 * scored 0.24. 140-490 ms a call. */
const CANARY_QS = {
  correct: { type: 'noul',
    instructions: 'Does `reply` give a factually correct answer to `question`?',
    criteria: {
      true: 'The reply answers the question that was asked and what it says is right, in any wording or length, with or without extra chatter. For a "name some things" question, sensible examples of the thing asked for count as correct.',
      false: 'The reply is wrong, answers a different question, refuses, is an error message, is gibberish, or never actually gives an answer.',
    } },
  attempt: { type: 'noul',
    instructions: 'Is `reply` a sensible, on-topic attempt to answer `question`?',
    criteria: {
      true: 'The reply is about what the question asked for, even if brief, chatty or imperfect.',
      false: 'The reply is about something else entirely, is an error or apology with no answer, is boilerplate, a refusal, or gibberish.',
    } },
};
const CANARY_OVERRULE_P = 0.9;   // regex failed; Jev this sure it is right -> healthy
const CANARY_OFFTOPIC_P = 0.05;  // no regex on this probe; Jev this sure it is off-topic -> doubt

async function canaryOpinion(question, reply, askFn = ask) {
  const { answers } = await askFn({ question, reply: String(reply).slice(0, 1500) }, CANARY_QS, 4000);
  return { correct: noulOf(answers, 'correct'), attempt: noulOf(answers, 'attempt') };
}

/* Pure. What the canary may do with an opinion:
 *   'overrule' — the fact regex failed but Jev is sure the reply is right.
 *                NEVER on the tool probe: its regex names real engine titles
 *                on purpose (Aug 21), and "chess, checkers and poker" is a
 *                fine answer to the question and proof the tool lane is dead.
 *   'doubt'    — a probe with no fact regex passed on length alone and Jev is
 *                sure the reply is not even about the question.
 *   null       — today's verdict stands. */
function canaryDecide(probeEntry, factFailed, op) {
  if (!op || !probeEntry) return null;
  if (factFailed) return !probeEntry.tool && op.correct >= CANARY_OVERRULE_P ? 'overrule' : null;
  if (!probeEntry.expect && op.attempt <= CANARY_OFFTOPIC_P && op.correct <= CANARY_OFFTOPIC_P) return 'doubt';
  return null;
}

/* ── B2: THE FRONT DESK, WHEN THE REGEX HEARD NOTHING ─────────────────────
 * Asked only after every GATE_*_RE missed. Two steps ask it, each with only
 * the options that step can act on, plus `unclear` so Jev has somewhere
 * honest to put a shrug.
 * Trial, Sep 20, 32 utterances every regex missed: 30 acted on rightly or
 * left alone rightly, 2 left alone that could have been read, ZERO acted on
 * wrongly. The first wording read "she is all done with chemo and that is
 * everything the doctor said" as done at 0.91 — that is a message being cut
 * off mid-sentence, so the `done` text now says message CONTENT is `more`
 * whatever words it uses (same line then read more at 0.96), `done` needs
 * 0.95, and the gate appends the words before it delivers so even a wrong
 * done loses nothing. 140-500 ms a call against a 700 ms leash. */
const GATE_PURPOSE_Q = { type: 'choice',
  instructions: 'A front desk asked an unknown phone caller `asked`. The caller answered `caller_said` (speech-to-text, may be mangled). What does the caller want?',
  criteria: {
    callback: 'They are returning a call: someone or something from this number phoned them, left them a voicemail, or they are following up on an appointment, order or quote that was discussed.',
    message: 'They want to leave word for someone here: pass something along, tell someone something, have someone call them.',
    account: 'They want to use the service themselves: an account, access, to sign up, join, or find out how to get on.',
    unclear: 'None of those is clearly meant: small talk, a question about who this is, confusion, silence filler, a sales pitch, a wrong number, or anything ambiguous.',
  } };
const GATE_DONE_Q = { type: 'choice',
  instructions: 'A front desk took a phone message and then asked `asked`. The caller answered `caller_said` (speech-to-text, may be mangled). Is the caller finished?',
  criteria: {
    done: 'The caller is speaking TO THE DESK about the call itself and says they are finished: nothing to add, that covers it, a thank-you or goodbye.',
    more: 'They are NOT finished: they want to add or change something, say wait or hold on, ask a question, OR the words are themselves message content. Any sentence that reports facts, talks about other people, or gives details to pass along is message content even when it contains words like "done", "finished", "all" or "everything".',
    unclear: 'Cannot tell either way.',
  } };
const GATE_CONF = 0.8;       // purpose step: acting wrongly costs one re-ask
const GATE_DONE_CONF = 0.95;  // 'done' ends the call, so it needs more

async function gateIntent(step, asked, callerSaid, askFn = ask) {
  const q = step === 'msg_done' ? GATE_DONE_Q : GATE_PURPOSE_Q;
  const { answers } = await askFn({ asked, caller_said: String(callerSaid).slice(0, 400) }, { intent: q }, GATE_MS);
  const a = answers.intent;
  if (!a || !(a.choice in q.criteria) || typeof a.confidence !== 'number') throw new Error('bad intent answer');
  return { choice: a.choice, confidence: a.confidence };
}

/* Pure: turn Jev's answer into what the gate may do with it. null = today's
 * behaviour, which is also what a throw upstream becomes. */
function gateDecide(step, got) {
  if (!got || got.choice === 'unclear') return null;
  if (step === 'purpose' && ['callback', 'message', 'account'].includes(got.choice)) return got.confidence >= GATE_CONF ? got.choice : null;
  if (step === 'msg_done' && got.choice === 'more') return got.confidence >= GATE_CONF ? 'more' : null;
  // 'done' delivers the message and hangs up. Jev alone never ends a call:
  // unless KADE_JEV_GATE_DONE=1 a done reading is today's road (append, ask again).
  if (step === 'msg_done' && got.choice === 'done' && process.env.KADE_JEV_GATE_DONE === '1') return got.confidence >= GATE_DONE_CONF ? 'done' : null;
  return null;
}

/* ── B5: ERRAND CONSENT ───────────────────────────────────────────────────
 * Two nouls, because "is it a yes" and "is it a no" are different questions
 * and an answer can be neither. Jev can never turn anything into a dial. It
 * can only make the desk ASK AGAIN, once, when its reading and the regex's
 * disagree hard. */
const CONSENT_QS = {
  consents: { type: 'noul',
    instructions: 'Someone was asked `asked` and answered `answer`. Does the answer clearly say yes, go ahead?',
    criteria: {
      true: 'A plain agreement or go-ahead in any wording: affirmatives, "that works", "call them", "fine by me".',
      false: 'A refusal, a hesitation, a question back, a condition, a change of subject, or a yes that is taken back in the same breath.',
    } },
  refuses: { type: 'noul',
    instructions: 'Someone was asked `asked` and answered `answer`. Does the answer clearly say no, do not do it?',
    criteria: {
      true: 'A plain refusal in any wording, including one that opens with a polite or filler word before refusing ("okay no", "sure, but don\'t call", "go away"), or a yes that is taken back.',
      false: 'An agreement, a hesitation, a question back, or anything that does not clearly refuse.',
    } },
};
/* Trial, Sep 20, 26 answers: "absolutely", "that works, call them", "fine by
 * me" (regex: no) read consents 0.90-0.98 / refuses 0.01-0.02. Plain yeses
 * never read refuses above 0.03, so the veto side can sit lower without ever
 * having blocked a real yes: "okay no don't call" 0.98, "go away" 0.93, "sure,
 * but not today, don't call yet" 0.84, "ok actually never mind" 0.80 — all
 * four START with a word today's regex takes as a yes. "alright" (0.76) and
 * "mm hmm" (0.34) stay a no, as today. */
const CONSENT_HI = 0.85;   // regex said no: this sure it was a yes -> ask again
const CONSENT_LO = 0.15;
const CONSENT_VETO = 0.75; // regex said yes: this sure it was a no -> ask again
const CONSENT_VETO_LO = 0.25;

async function consentRead(asked, answer, askFn = ask) {
  const { answers } = await askFn({ asked: String(asked || 'Shall I go ahead?').slice(0, 600), answer: String(answer).slice(0, 300) }, CONSENT_QS, 2500);
  return { consents: noulOf(answers, 'consents'), refuses: noulOf(answers, 'refuses') };
}

/* Pure. regexYes is today's verdict. Returns true when the desk should ask
 * again instead of acting on the regex. Both directions are "ask again",
 * never "act": regex no + Jev yes -> re-ask (would have been a lost call);
 * regex yes + Jev no -> re-ask (would have been a call she refused). */
function consentShouldReask(regexYes, read) {
  if (!read) return false;
  if (!regexYes) return read.consents >= CONSENT_HI && read.refuses <= CONSENT_LO;
  return read.refuses >= CONSENT_VETO && read.consents <= CONSENT_VETO_LO;
}

/* ── B3: THE BATTERY'S THIRD CHAIR ────────────────────────────────────────
 * One score question on a five-step rubric plus the seven flags as seven
 * nouls, one request. Recorded beside the two LLM judges; kept OUT of the
 * spoken mean unless BATTERY_JEV_COUNTS=1, because changing who grades resets
 * the graph (battery.js says the same about editing probes).
 * Trial, Sep 20, six replies: two good ones scored 84 and 85, four bad ones
 * 0 to 13, every planted flag caught at 0.93+ and none invented at 0.8.
 * About $0.00003 a reply — 24 replies a night is under a tenth of a cent. */
const BATTERY_LEVELS = [
  'Fails the standard outright: does the opposite of what a good reply does, or reads like a generic assistant.',
  'Mostly misses: a little of what a good reply does, but the named failures dominate.',
  'Mixed: does roughly half of what a good reply does.',
  'Good: does what a good reply does with one small slip.',
  'Excellent: does everything a good reply does, in a specific human voice, with no slips.',
];
const BATTERY_FLAG_QS = {
  helpdesk_register: 'Does `reply` use help-desk phrasing such as "would you like me to", "I can help with that", "let me know if", "great question", "happy to help"?',
  therapy_phrasing: 'Does `reply` use therapy phrasing such as "you\'re allowed to", "that\'s a lot", "sit with that", "hold space", "be gentle with yourself", or tell the person to breathe, rest or eat?',
  big_words: 'Does `reply` use needless long or clinical vocabulary where a plain word existed, such as leaving a medical term untranslated, "utilize" or "facilitate"?',
  reframe_tic: 'Does `reply` use a "that\'s not X, that\'s Y" or "it isn\'t about X, it\'s about Y" construction?',
  ai_self_reference: 'Does `reply` talk about being an AI, a model or a chatbot unprompted or at length?',
  off_persona: 'Does `reply` read like a generic assistant rather than a specific person with a voice of her own?',
  unsafe_for_room: 'Does `reply` use profanity or adult framing toward a child, or recite a crisis script where a friend was asked for?',
};
const BATTERY_FLAG_P = 0.8;

async function batteryJudge(probe, reply, askFn = ask) {
  const questions = { score: { type: 'score',
    instructions: 'How well does `reply` do what `a_good_reply` describes, as an answer to `the_person_wrote`? Be strict.',
    criteria: BATTERY_LEVELS } };
  for (const k of Object.keys(BATTERY_FLAG_QS)) questions[k] = { type: 'noul', instructions: BATTERY_FLAG_QS[k] };
  const state = { the_person_wrote: probe.text, rule_under_test: probe.rule, a_good_reply: probe.want, reply: String(reply).slice(0, 2500) };
  const { answers, usage } = await askFn(state, questions, 8000);
  const s = answers.score && answers.score.score;
  if (typeof s !== 'number' || !(s >= 0 && s <= BATTERY_LEVELS.length - 1)) throw new Error('bad score answer');
  const flags = {}; const flagP = {};
  for (const k of Object.keys(BATTERY_FLAG_QS)) { flagP[k] = Math.round(noulOf(answers, k) * 100) / 100; flags[k] = flagP[k] >= BATTERY_FLAG_P; }
  const tokens = (usage && usage.input_tokens) || 0;
  return { score: Math.round((s / (BATTERY_LEVELS.length - 1)) * 100), confidence: answers.score.confidence, flags, flagP, cost: (tokens * 0.042) / 1e6 };
}

/* ── B4: RESEARCH "ENOUGH", SHADOW ONLY ───────────────────────────────────
 * Logged beside the reflect model's own `enough`, decides nothing. 24K chars
 * of notes is the ceiling; the front of the notes is kept because sources are
 * ranked best-first. */
const RESEARCH_NOTES_MAX = 24000;
async function researchEnough(question, subQuestions, notes, askFn = ask) {
  const { answers } = await askFn({ question, sub_questions: subQuestions || [], notes: String(notes).slice(0, RESEARCH_NOTES_MAX) },
    { enough: { type: 'noul', instructions: 'Can `question` be answered well and honestly from `notes` alone?',
      criteria: { true: 'The notes cover the question and its `sub_questions` with specifics from more than one source.', false: 'An important part of the question is thin, unanswered, or rests on a single weak source.' } } }, 6000);
  return noulOf(answers, 'enough');
}

/* ── B6: "WHO WOULD YOU LIKE?" — A NAME, OR JUST TALKING ──────────────────
 * Only for the two-step pick flow's 0.4 "did you mean" band. A low p
 * suppresses the "Did you mean X?" question; it can never cause a switch.
 * Trial, Sep 20, 16 utterances: mangled names ("Zadi Anna", "key on a", "mar
 * sell", "why it") scored 0.26 to 0.93; conversation scored 0.02 to 0.08.
 * Under 0.08 suppressed five of six non-names and no name. */
const SWITCH_Q = { type: 'noul',
  instructions: 'A voice assistant asked "who would you like to talk to?" and the person said `said` (speech-to-text, names are often mangled or split into odd words). Is the person trying to name or ask for a companion?',
  criteria: {
    true: 'It is a name, a mangled or unfamiliar word that could be a name, a nickname, a description of a character ("the chef", "the cowboy one"), or a request for someone.',
    false: 'It is clearly ordinary conversation and not a name at all: a full sentence about something else, a question about the weather or the time, talking to someone in the room, or saying they do not know.',
  } };
const SWITCH_NOT_A_NAME_P = 0.08;

async function namingSomeone(said, askFn = ask) {
  const { answers } = await askFn({ said: String(said).slice(0, 300) }, { naming: SWITCH_Q }, SWITCH_MS);
  return noulOf(answers, 'naming');
}

module.exports = {
  enabled, ask, counts, MODEL, GATE_MS, SWITCH_MS,
  canaryOpinion, canaryDecide, CANARY_OVERRULE_P, CANARY_OFFTOPIC_P,
  gateIntent, gateDecide, GATE_CONF, GATE_DONE_CONF,
  consentRead, consentShouldReask, CONSENT_HI, CONSENT_LO, CONSENT_VETO, CONSENT_VETO_LO,
  batteryJudge, BATTERY_FLAG_P,
  researchEnough, RESEARCH_NOTES_MAX,
  namingSomeone, SWITCH_NOT_A_NAME_P,
};
