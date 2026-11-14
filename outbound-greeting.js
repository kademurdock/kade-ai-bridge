'use strict';
/* outbound-greeting.js — what the person who answers hears first when a character calls out.
 *
 * Nov 14 2026, Kade's test call with Kiana. She gave Kiana her own number and said "call this
 * gas station and ask if they have any deals on hemp products". The greeting she heard was
 * "Hi! It's Kiana! I've got a quick question — kade wants to know if ...". Her words: "likely
 * the people aren't going to know who Kade is, so it should probably somehow identify that it's
 * an ai assistant calling on someone's behalf."
 *
 * Why that greeting played: the greeting was chosen ONLY by the number dialed. Her number is in
 * the family registry with Kiana as its own character, so the call took the friend greeting, with
 * no "A I assistant" and no recording notice. The chat's phone tool never said the call was to a
 * business (only the errands desk sent disclose:true).
 *
 * The rules now (server.js /outbound-call uses composeOutboundGreeting):
 *   - A STRANGER greeting plays whenever the call is to a business or to anyone who does not know
 *     the user: disclose:true (errands), business:true (the chat's phone tool, set by the model),
 *     or a number that is not in the registry. Plain words, short, and in this order:
 *       who is talking (an A I assistant), who for (first name, "one of our users", so nobody has
 *       to know who that is), the recording notice the code always gave, then the question.
 *     "Hi, this is Kiana, an A I assistant calling for Kade, one of our users. This call may be
 *      recorded. I'm calling to ask if you're running any deals on hemp products right now."
 *   - The question in a stranger greeting is the FIRST thing asked, never "Kade wants to know":
 *     "<her name> wants to know if X" becomes "ask if X", and a long purpose is cut to its first
 *     question (the rest of the purpose is still the mission the character carries on the call).
 *   - Registered family who know the character keep their greetings word for word (Kade's own
 *     design, July 12 2026): own character "Hi! It's Kiana! ...", other family "Hi! It's Kiana —
 *     Kade's A I. ...", and "Hi — is this Holly?" first when a name was given.
 *   - business (the stricter rules: stranger, no voice steering, no personal details, end the
 *     call once answered) is on for disclose/business:true. For a number not in the registry it
 *     is also on when the caller says unregistered numbers are businesses (the chat's phone tool
 *     does: a call a person asks for from a chat, to a number nobody registered, is a store or a
 *     stranger unless the character said business:false). The bridge's own scheduled calls
 *     (briefings) and the website's nudge calls ring the person themselves, so they keep the
 *     ordinary rules on an unregistered number, as before.
 *
 * askAt / ask2At: how far into each spoken part the question starts (0..1 of its characters).
 * voice-stream.js uses it to tell a "yeah" said while the question was being asked (an answer)
 * from one said during "this is Kiana, an A I assistant" (a nod). */

/** Kade's own July 2 2026 framing of a purpose by its shape (moved here unchanged from server.js). */
function framePurpose(p) {
  let t = String(p || '').slice(0, 300).trim().replace(/^["']+|["']+$/g, '');
  t = t.replace(/^(?:i'?m calling (?:because|about|to)\s*)/i, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return "I'm calling on their behalf";
  const endPunct = /[.?!]$/.test(t) ? '' : '.';
  if (/^(?:to\s+)?(?:ask|find out|check|catch up|catch|check in|see|confirm|verify|make sure|place|order|book|schedule|cancel|request|remind|tell|invite|wish|set up|pick up|drop off|let)\b/i.test(t)) {
    t = t.replace(/^to\s+/i, '');
    return `I'm calling to ${t.charAt(0).toLowerCase()}${t.slice(1)}${endPunct}`;
  }
  if (/\?$/.test(t) || /^(?:is|are|was|were|do|does|did|can|could|will|would|should|has|have|what|when|where|who|why|how)\b/i.test(t)) {
    return `I've got a quick question — ${t.charAt(0).toLowerCase()}${t.slice(1)}${endPunct}`;
  }
  // KADE July 2 2026 (round 5): a NOUN-PHRASE purpose glued onto "because" reads broken. If none
  // of the first few words is a verb-ish token, the text has no clause; frame with "about".
  const firstWords = t.split(/\s+/).slice(0, 3);
  const VERBISH = /^(?:is|are|was|were|am|be|has|have|had|do|does|did|want|wants|wanted|need|needs|needed|ask|asks|asked|say|says|said|told|tell|tells|think|thinks|thought|hope|hopes|hoped|wonder|wonders|wondered|would|will|should|can|could|may|might|must|let|lets|got|get|gets|there's|it's|she's|he's|i'm|we're|they're|you're)$/i;
  const hasEarlyVerb = firstWords.some((w) => VERBISH.test(w.replace(/[^a-z']/gi, '')));
  if (!hasEarlyVerb) {
    return `I'm calling about ${t.charAt(0).toLowerCase()}${t.slice(1)}${endPunct}`;
  }
  return `I'm calling because ${t.charAt(0).toLowerCase()}${t.slice(1)}${endPunct}`;
}

/** A first name to say out loud, or null when the record holds a placeholder ("a Kade-AI user"). */
function firstNameOf(userName) {
  const t = String(userName || '').trim();
  if (!t || /kade[- ]?a\.?i\.? user/i.test(t)) return null;
  const first = t.split(/\s+/)[0].replace(/[^A-Za-z'-]/g, '');
  if (!first || first.length < 2 || /^(?:a|an|the|someone|somebody|user|unknown|customer|client)$/i.test(first)) return null;
  return first;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Short words that end with a period without ending a sentence. */
const ABBREV = new Set(['dr', 'mr', 'mrs', 'ms', 'st', 'ave', 'rd', 'blvd', 'jr', 'sr', 'no', 'vs', 'etc', 'inc', 'co', 'ltd', 'mt', 'ft', 'dept', 'approx', 'apt', 'hwy', 'e.g', 'i.e', 'a.m', 'p.m', 'u.s']);

/** Where the first sentence ends (index just past its punctuation), or -1. */
function firstSentenceEnd(t, minAt = 25) {
  const re = /[.?!]+(?=\s+["'(]?[A-Z0-9])/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const at = m.index;
    if (at < minAt) continue;
    const before = t.slice(0, at).split(/\s+/).pop().toLowerCase().replace(/^[("']+/, '');
    if (m[0] === '.' && (ABBREV.has(before) || /^[a-z]$/.test(before) || /\d$/.test(before) && /^\d/.test(t.slice(at + 1).trim()))) continue;
    return at + m[0].length;
  }
  return -1;
}

const ASK_LONG = 110;  // characters; above this the greeting keeps only the first question
const ASK_FORM = /^(?:to\s+)?(?:ask|find out|check|see|confirm|verify|make sure)\b/i;

/**
 * The question a stranger hears, framed to follow "This call may be recorded.".
 *   "Kade wants to know if X. If so, Y?"  ->  "I'm calling to ask if X."
 * Who wants to know was already said ("calling for Kade, one of our users"), so the name is not
 * repeated in front of the question; a long purpose keeps only its first question, cut before an
 * "especially ..." tail when it is still long. Everything else goes through framePurpose as before.
 */
function strangerAsk(purpose, firstName) {
  let t = String(purpose || '').slice(0, 300).trim().replace(/^["']+|["']+$/g, '').replace(/\s+/g, ' ');
  t = t.replace(/^(?:i'?m calling (?:because|about|to)\s*)/i, '');
  const who = ['my user', 'the user', 'my client', 'the client', 'my customer', 'the customer', 'she', 'he', 'they'];
  if (firstName) who.unshift(escapeRe(firstName));
  const alts = who.join('|');
  // "<name> wants to know if/whether X", "<name> would like to find out X", "<name> needs to ask about X"
  const wants = new RegExp(`^(?:${alts})\\s+(?:wants|would like|wanted|needs|is hoping|was hoping|is trying|asked me)\\s+to\\s+(?:know|find out|ask|check|see)\\s+(?:(if|whether)\\s+)?`, 'i');
  // "<name> is wondering if X", "<name> wonders whether X"
  const wonders = new RegExp(`^(?:${alts})\\s+(?:is wondering|was wondering|wonders|wondered)\\s+(?:(if|whether)\\s+)?`, 'i');
  const m = t.match(wants) || t.match(wonders);
  if (m) {
    const rest = t.slice(m[0].length);
    if (m[1]) t = `ask ${m[1]} ${rest}`;
    // "what time you close", "about the order" read on after "ask"; a bare thing needs "about".
    else if (/^(?:about|what|when|where|who|whom|whose|why|how|which|for|is|are|do|does|did|can|could|will|would)\b/i.test(rest)) t = `ask ${rest}`;
    else t = `ask about ${rest}`;
  }
  if (t.length > ASK_LONG) {
    const end = firstSentenceEnd(t);
    const first = end > 0 ? t.slice(0, end).trim() : t;
    // Only a first sentence that is itself the question is kept alone; a first sentence that is
    // only background ("Kade is planning a party.") keeps the question that follows it.
    if (end > 0 && (/\?$/.test(first) || ASK_FORM.test(first))) t = first;
  }
  if (t.length > ASK_LONG) {
    const tail = t.slice(40).search(/,\s+(?:especially|particularly|like|such as|including|for example|e\.g\.)\s|\s+—\s/i);
    if (tail >= 0) t = t.slice(0, 40 + tail).trim();
  }
  return framePurpose(t);
}

/** "Kade, one of our users" or "one of our users". */
function forWhom(firstName) {
  return firstName ? `${firstName}, one of our users` : 'one of our users';
}

/** The disclosure sentence that opens every stranger greeting. */
function disclosureLine(agentName, firstName) {
  return `this is ${agentName}, an A I assistant calling for ${forWhom(firstName)}.`;
}

const RECORDING_NOTICE = 'This call may be recorded.';

/**
 * Pick the tier and compose both parts.
 * @param {object} o
 * @param {string} o.agentName        the character placing the call
 * @param {string} o.userName         the person the call is for (records keep the full name)
 * @param {string} o.purpose
 * @param {string|null} o.calleeName  a vetted name, or null
 * @param {object|null} o.calleeRec   the registry row for the dialed number, or null
 * @param {string} o.agentId          the calling character's id
 * @param {boolean} [o.disclose]      errands: always the stranger greeting
 * @param {boolean} [o.business]      the chat tool: true = a business or a stranger; false = a person
 * @param {boolean} [o.unregisteredIsBusiness]  the chat tool: a number not in the registry is a
 *                                    business or a stranger unless business:false
 */
function composeOutboundGreeting(o) {
  const agentName = String(o.agentName || 'Kiana');
  const purpose = o.purpose;
  const calleeName = o.calleeName || null;
  const rec = o.calleeRec || null;
  const forced = o.disclose === true || o.business === true;
  const ownAgent = !forced && !!(rec && o.agentId && rec.agentId === o.agentId);
  const tier = forced || !rec ? 'stranger' : ownAgent ? 'own' : 'family';
  const business = forced || (!rec && o.unregisteredIsBusiness === true && o.business !== false);

  if (tier !== 'stranger') {
    // Word for word what family heard before (server.js, July 12 2026).
    const spokenUserName = String(o.userName || '').trim().split(/\s+/)[0] || 'a Kade-AI user';
    const framed = framePurpose(purpose);
    const lead = tier === 'own' ? `It's ${agentName}! ` : `It's ${agentName} — ${spokenUserName}'s A I. `;
    const intro = `${lead}${framed}`;
    if (calleeName) {
      const part1 = `Hi — is this ${calleeName}?`;
      return { tier, business, disclosed: false, greeting: part1, askAt: part1.indexOf('is this') / part1.length, greeting2: intro, ask2At: lead.length / intro.length, ask: framed };
    }
    const greeting = `Hi! ${intro}`;
    return { tier, business, disclosed: false, greeting, askAt: (4 + lead.length) / greeting.length, greeting2: null, ask2At: null, ask: framed };
  }

  const first = firstNameOf(o.userName);
  const ask = strangerAsk(purpose, first);
  const disclose = disclosureLine(agentName, first);
  if (calleeName) {
    // The first thing they hear still says who is calling and for whom; the recording notice and
    // the question follow their answer to "is this ...?".
    const lead = `Hi, ${disclose} `;
    const part1 = `${lead}Is this ${calleeName}?`;
    const lead2 = `Thanks! ${RECORDING_NOTICE} `;
    const part2 = `${lead2}${ask}`;
    return { tier, business, disclosed: true, greeting: part1, askAt: lead.length / part1.length, greeting2: part2, ask2At: lead2.length / part2.length, ask };
  }
  const lead = `Hi, ${disclose} ${RECORDING_NOTICE} `;
  const greeting = `${lead}${ask}`;
  return { tier, business, disclosed: true, greeting, askAt: lead.length / greeting.length, greeting2: null, ask2At: null, ask };
}

/** The voicemail a stranger's machine gets (voice-stream.js handleAmdResult). */
function strangerVoicemail({ agentName, userName, purpose }) {
  const first = firstNameOf(userName);
  const ask = strangerAsk(purpose, first)
    .replace(/^I'm calling /, 'I was calling ')
    .replace(/^I've got a quick question — /, 'I had a quick question: ');
  return `Hi, ${disclosureLine(agentName || 'Kiana', first)} ${ask} Sorry I missed you. Bye!`;
}

module.exports = {
  framePurpose,
  firstNameOf,
  strangerAsk,
  firstSentenceEnd,
  forWhom,
  disclosureLine,
  composeOutboundGreeting,
  strangerVoicemail,
  RECORDING_NOTICE,
};
