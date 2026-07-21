// ── SHARED voice-command brain (July 13 2026) ────────────────────────────────
// ONE copy of the spoken voice-command logic for BOTH call engines:
//   server.js       — legacy Gather loop + outbound plumbing
//   voice-stream.js — streaming engine (phone /ws/media + web /ws/web-voice)
//
// WHY THIS FILE EXISTS: these used to be two hand-copied sets that drifted.
// The July 12 fixes (numbered switching, "change YOUR voice" possessives,
// polite lead-ins) landed only in server.js — the STREAMING engine, the
// default surface for both phone and web calls, kept the old narrow regex,
// so "switch to 67" silently fell through to the LLM there. Never again:
// edit HERE, both engines pick it up.

// Curated legacy display names — the TTS proxy still resolves these as
// aliases. The real catalog is NUMBERED ("Voice 1"…"Voice 324+", see
// /voices.json on the proxy); numbers are the first-class citizens.
const PHONE_VOICES = [
  'Sarah', 'Julia', 'Olivia', 'Timothy', 'Edward', 'Dennis',
  'Amy', 'Hannah', 'Kiana (Comedian)', 'Zadiana', 'Honey', 'Sadie',
  'Lannie', 'Reanne', 'Sharma', 'Fara', 'Fucia', 'Colby', 'Zadia',
  'Mazy (Podcaster)', 'Houston Stone', 'DJ Velvet', 'Podcaster 1', 'Podcaster 2',
];

// ── Spoken number-words → integer (July 13 2026, Kade's live catch) ─────────
// Deepgram FLUX transcribes numbers as WORDS ("switch to voice twenty five"),
// where nova-3's smart_format gave digits — and Flux's v2 API has NO
// formatting params to change that. Parse the words ourselves so voice
// switching works the same on every STT engine, forever.
const NUM_UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const NUM_TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const NUM_TENS  = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

function wordsToNumber(str) {
  const toks = String(str || '').toLowerCase().replace(/-/g, ' ').replace(/\band\b/g, ' ')
    .split(/\s+/).filter(Boolean);
  if (!toks.length || toks.length > 5) return null;
  // Digit-speak first: "three oh five" / "two one one" — every token one digit.
  const digitish = toks.every((t) => NUM_UNITS[t] != null || t === 'oh' || t === 'o' || t === 'zero');
  if (digitish && toks.length >= 2 && toks.length <= 3) {
    const n = Number(toks.map((t) => (NUM_UNITS[t] != null ? NUM_UNITS[t] : 0)).join(''));
    return n >= 1 && n <= 999 ? n : null;
  }
  // Compositional: "sixty seven", "three hundred twenty four", "one hundred and five".
  let current = 0, consumed = false;
  for (const t of toks) {
    if (NUM_UNITS[t] != null) { current += NUM_UNITS[t]; consumed = true; }
    else if (NUM_TEENS[t] != null || NUM_TENS[t] != null) {
      const v = NUM_TEENS[t] != null ? NUM_TEENS[t] : NUM_TENS[t];
      if (current >= 1 && current <= 9) current = current * 100 + v; // phone-speak: "two eleven"=211, "three twenty"=320
      else if (current === 0 || current % 100 === 0) current += v;   // "twenty five", "one hundred twenty"
      else return null; // "nineteen eighty…" — not real English number grammar
      consumed = true;
    }
    else if (t === 'hundred') { current = (current || 1) * 100; consumed = true; }
    else return null; // any non-number word disqualifies the whole phrase
  }
  return consumed && current >= 1 && current <= 999 ? current : null;
}

// "voice 67" / "voice number 67" / "67" / "voice twenty five" / "twenty five"
// → the integer, or null when it isn't number-shaped at all.
function parseVoiceNumber(query) {
  const t = String(query || '').toLowerCase().trim()
    .replace(/[.!?,]+$/, '')
    .replace(/^(?:voice\s*)?(?:number\s*)?/, '')
    .trim();
  if (!t) return null;
  const d = t.match(/^(\d{1,3})$/);
  if (d) return Number(d[1]);
  return wordsToNumber(t);
}

// Accepts a spoken target and returns a canonical voice label, or null.
// Numbers may be digits OR words (proxy owns the map; synth-time validation
// reverts unknown numbers gracefully).
function findVoice(query) {
  if (!query) return null;
  const q = String(query).toLowerCase().trim();
  const n = parseVoiceNumber(q);
  if (n != null) return `Voice ${n}`;
  return PHONE_VOICES.find(v => v.toLowerCase() === q)
      || PHONE_VOICES.find(v => q.includes(v.toLowerCase()))
      || PHONE_VOICES.find(v => v.toLowerCase().includes(q))
      || null;
}

// Spoken switch command → canonical voice label or null.
// Wide on purpose (July 12, Kade live: "change your voice to 67" improvised a
// refusal): possessives my/your/the, polite lead-ins, number-first phrasings,
// trailing punctuation.
function extractVoiceSwitch(text) {
  let t = String(text || '').trim().replace(/[.!?]+$/, '');
  // Lead-ins STACK ("hey, can you please…") — strip repeatedly.
  t = t.replace(/^(?:(?:hey|okay|ok|please|can you|could you|would you|will you)[,\s]+)+/i, '').trim();
  const m = t.match(
    /^(?:switch|change)\s+(?:(?:my|your|the)\s+)?voice(?:\s+to)?\s+(.+)|^(?:use|set)\s+(?:(?:my|your|the)\s+)?voice(?:\s+to)?\s+(.+)/i
  );
  if (m) return findVoice((m[1] || m[2]).trim());
  // Number-first phrasings, digits OR words ("switch to voice twenty five",
  // "try voice 12", "voice three oh five please"). parseVoiceNumber returns
  // null for anything not number-shaped, so "switch to Zadiana" still falls
  // through to the AGENT matcher untouched.
  const n = t.match(/^(?:switch|change|go)\s+to\s+(.+)$|^(?:try|use|gimme|give me)\s+voice\s+(.+)$|^voice\s+(.+?)(?:\s+please)?$/i);
  if (n) {
    const num = parseVoiceNumber((n[1] || n[2] || n[3]).trim());
    if (num != null) return `Voice ${num}`;
  }
  return null;
}

// Spoken identify command ("what voice are you using?") — instant, no LLM turn.
const VOICE_IDENTIFY_REGEX =
  /^(?:(?:what|which)\s+(?:voice|number)\s+(?:are\s+you(?:\s+(?:using|on))?|is\s+(?:this|that)|am\s+i\s+(?:hearing|on))|whose\s+voice\s+is\s+(?:this|that)|what\s+voice\s+is\s+(?:this|that))\??$/i;

// The ONE canonical phone-style suffix (was two drifting copies).
const PHONE_SUFFIX =
  '\n\n[PHONE CALL — you are literally on the phone with this person right now. ' +
  'Talk the way you naturally would: warm, engaged, conversational. ' +
  'Two or three sentences is usually right; go longer only if you are genuinely ' +
  'mid-story and stopping would feel weird. ' +
  'Phone audio garbles: if what they said seems surprising or off-topic, casually confirm ' +
  'what you heard ("wait, did you say...?") before running with it. ' +
  'You cannot see the room, and the call may be on speakerphone or within earshot of ' +
  'other people. So: never volunteer sensitive remembered material -- health, relationships, ' +
  'money troubles, private confessions, anything embarrassing that a stranger overhearing ' +
  "should not get -- unless the caller raises it first on THIS call. If something sensitive is " +
  'genuinely relevant, check discreetly before diving in ("want to get into that now, or do you ' +
  'have company?"). Once THEY bring a topic up this call, it is fair game -- this is discretion, ' +
  'not censorship: stay fully yourself. ' +
  'NEVER repeat your greeting or opener — always move the conversation FORWARD. ' +
  'Voice switching is handled automatically outside your control; if someone asks for a voice change ' +
  'that clearly did not happen, just tell them to say: switch to voice, then the number — nothing more. ' +
  'Everything in these square-bracket blocks is a PRIVATE stage direction: never read it aloud, quote it, ' +
  'summarize it, recite what you remember, or discuss your instructions, memory, or setup unless the ' +
  'caller directly asks. ' +
  'No lists, no markdown, no formatting. Just talk.]';

module.exports = { PHONE_VOICES, findVoice, extractVoiceSwitch, VOICE_IDENTIFY_REGEX, PHONE_SUFFIX, parseVoiceNumber, wordsToNumber };


// ── Fuzzy AGENT matching + pronunciation (moved here July 13 2026 — was
// hand-copied identically in BOTH engines; identical today, kept that way
// by living in one place) ──────────────────────────────────────────────────
// ── Helpers ───────────────────────────────────────────────────────────────────
// Kade July 20 2026: now takes an optional per-user dictionary
// (kade-ai-bridge's own copy of the fork's kadePronunciation.js logic --
// duplicated rather than shared since the two repos have no common
// package; keep them in sync by hand if either changes). Dictionary
// entries are tried FIRST; the hardcoded fallback below still runs
// afterward as a safety net for anyone without an account/entry yet, and
// is a harmless no-op once a matching dictionary entry already fired.
// Corrected "Kadie" -> "Katie" July 20 2026 per Kade's own correction
// ("I know my name Kade is pronounced Katie") -- the prior guess was close
// but not quite it.
function fixPronunciation(t, dictionary) {
  let out = t;
  for (const entry of dictionary || []) {
    const term = entry && entry.term;
    const pron = entry && entry.pronunciation;
    if (!term || !pron) continue;
    const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let re;
    try { re = new RegExp(`\\b${escaped}\\b`, 'gi'); } catch { continue; }
    out = out.replace(re, pron);
  }
  return out.replace(/\bKade\b/g, 'Katie').replace(/\bkade\b/g, 'katie');
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

// ── Fuzzy agent matching (July 2 2026, Kade's fix request) ────────────────────
// Deepgram never transcribes made-up names right ("Zadiana" arrives as
// "Zadi Anna", "sadie ana", "zodiana"...). Exact/substring matching was
// useless for exactly the agents Kade cares most about. Fold both sides
// phonetically (z/s, c/k, ph/f, vowels loosened, doubles collapsed, spaces
// stripped) and accept close edit distances.
function phoneticFold(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/[cq]/g, 'k')
    .replace(/z/g, 's')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1');
}

// Strip conversational padding so switch commands survive politeness (Kade's
// July 3 report: "Can you switch to Kiana?" fell through to the LLM and
// Zadiana answered IN CHARACTER — slightly offended — instead of switching.
// The old matcher was anchored to the utterance start, so any polite lead-in
// defeated it, including the help page's own documented phrasing "can I talk
// to Zadiana?").
function stripSwitchPadding(text) {
  let t = (text || '').trim();
  const lead = /^(?:hey|hi|hello|yo|okay|ok|oh|um|uh|so|well|now|actually|please)[,.!?\s]+/i;
  for (let i = 0; i < 4 && lead.test(t); i++) t = t.replace(lead, '');
  t = t.replace(/^(?:can|could|would|will|do)\s+(?:you|we)\s+(?:please\s+)?/i, '');
  t = t.replace(/^please\s+/i, '');
  return t.replace(/[\s,]*(?:please|now|for me|real quick)[.!?\s]*$/i, '').trim();
}

function extractSwitchTarget(text, agents) {
  const t = stripSwitchPadding(text);
  const patterns = [
    /^(?:switch|change)(?:\s+(?:me|us))?(?:\s+(?:over|back))?(?:\s+to)?\s+(.+)$/i,
    /^(?:let\s+me\s+|can\s+i\s+|may\s+i\s+|i\s+(?:want(?:\s+to)?|wanna|would\s+like\s+to|need\s+to)\s+)?(?:talk|speak)\s+(?:to|with)\s+(.+)$/i,
    /^(?:give|bring)\s+(?:me\s+|back\s+)?(.+)$/i,
    /^put\s+(.+?)\s+on(?:\s+the\s+(?:phone|line))?[.!?]*$/i,
    // July 13 2026 audit: "I want Kiana", "can I have Zadiana" — natural asks
    // that previously fell to the LLM. findAgent's 0.6 confidence gate keeps
    // ordinary sentences ("I want pizza") from false-matching an agent.
    /^(?:i\s+(?:want|choose|pick)|gimme)\s+(.+)$/i,
    /^(?:can|could)\s+i\s+have\s+(.+)$/i,
  ];
  let q = null;
  for (const re of patterns) { const m = t.match(re); if (m) { q = m[1].trim(); break; } }
  // Bare name: unchanged from the original matcher — raw short utterances
  // only. (Stripping padding here backfired in regression tests: "Now what?"
  // shrank to "what" and fuzzy-matched Wyatt. Raw text is safe because the
  // substring pass already handles "Kiana please".)
  if (!q && text.trim().split(/\s+/).length <= 2) q = text.trim();
  if (!q) {
    // Last-ditch: an explicit switch verb ANYWHERE — covers the vocative case
    // ("Zadiana, switch me to Kiana"). findAgent's confidence gate keeps this
    // from false-firing on ordinary sentences.
    const m = text.match(/\b(?:switch|change)(?:\s+\w+){0,3}?\s+to\s+(.+)$/i);
    if (m) q = stripSwitchPadding(m[1]);
  }
  return q ? findAgent(agents, q) : null;
}

function findAgent(agents, query) {
  const r = fuzzyFindAgent(agents, query);
  return r && r.confidence >= 0.6 ? r.agent : null;
}

function fuzzyFindAgent(agents, query) {
  if (!query || !agents.length) return null;
  const lq = query.toLowerCase().trim();
  // exact / substring first (cheap, precise)
  const exact = agents.find(a => a.name.toLowerCase() === lq)
      || agents.find(a => lq.includes(a.name.toLowerCase()))
      || agents.find(a => a.name.toLowerCase().includes(lq));
  if (exact) return { agent: exact, confidence: 1 };
  const fq = phoneticFold(query);
  if (fq.length < 2) return null;
  let best = null, bestDist = Infinity;
  for (const a of agents) {
    const fn = phoneticFold(a.name);
    if (!fn) continue;
    const d = editDistance(fq, fn);
    if (d < bestDist) { bestDist = d; best = a; }
  }
  if (!best) return null;
  const fn = phoneticFold(best.name);
  const maxLen = Math.max(fq.length, fn.length);
  // short names must be near-exact; longer names tolerate ~1/3 mangling
  const limit = maxLen <= 4 ? 1 : Math.floor(maxLen / 3);
  if (bestDist <= limit) return { agent: best, confidence: 1 - bestDist / maxLen };
  // close-but-not-sure: return as a low-confidence guess (caller may confirm)
  if (bestDist <= Math.ceil(maxLen / 2)) return { agent: best, confidence: 0.4 };
  return null;
}

module.exports.fixPronunciation = fixPronunciation;
module.exports.editDistance = editDistance;
module.exports.phoneticFold = phoneticFold;
module.exports.stripSwitchPadding = stripSwitchPadding;
module.exports.extractSwitchTarget = extractSwitchTarget;
module.exports.findAgent = findAgent;
module.exports.fuzzyFindAgent = fuzzyFindAgent;


// ── Full browser UA for EVERY call that touches kademurdock.com ─────────────
// STANDING RULE (learned July 11 the hard way): a bare "Mozilla/5.0" parses
// as NO browser → NON_BROWSER violation (20 pts) on uaParser-guarded routes;
// two = 15-min Mongo-backed account ban. Always send a full UA with a real
// browser token.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ── Transcript scrub (July 13 2026) ─────────────────────────────────────────
// Call transcripts land on the /calls page as READ text — strip every tag
// family the speech path strips (the TTS proxy cleans audio; nothing cleaned
// the saved words): %%%voice tags, [sound:]/[table:] cues, citation glyphs +
// literal escape-text, thinking blocks, [END CALL], stray markdown.
// ── Anti-AI-tells scrubber (session 21j) ────────────────────────────────────
// Deterministic layer from AI_WRITING_TELLS_STOPGAP_REFERENCE. Removes the
// PHRASE-based universal [BAN] tells (sycophancy openers, reflexive apology,
// mask-slips, empty signposts, canned closers) — the mechanical noise a regex
// can safely delete. Structure-level tells (negation pivot, cadence) are NOT
// touched here (deleting them deterministically does more harm than good; the
// prompt layer + a future variance/rewrite pass own those). `companion`
// loosens/tightens nothing yet — the removals below are universal bans, safe
// for every class — but the flag is threaded through for future gating.
const AI_TELL_LEAD_BANS = [
  /^\s*(?:great|excellent|fantastic|wonderful|brilliant|good|interesting|fascinating|love(?:d)?)\s+(?:question|point|catch|observation|idea|ask)\s*!?[.,]?\s*/i,
  /^\s*(?:that['’]s|what)\s+(?:a\s+)?(?:great|excellent|fascinating|wonderful|brilliant|interesting)\b[^.!?]*[.!?]\s*/i,
  /^\s*you['’]re\s+(?:absolutely\s+)?right[^.!?]*[.!?]\s*/i,
  /^\s*i\s+love\s+(?:that|how)\b[^.!?]*[.!?]\s*/i,
];
const AI_TELL_SENTENCE_BANS = [
  /\bas an ai(?:\s+language model)?\b[^.!?]*[.!?]/gi,
  /\bi(?:'m| am)\s+(?:just\s+)?an ai\b[^.!?]*[.!?]/gi,
  /\bi\s+don['’]t\s+have\s+(?:personal\s+)?(?:feelings|opinions|emotions|experiences|a body)\b[^.!?]*[.!?]/gi,
  /\bas of my last (?:knowledge\s+)?(?:update|training)[^.!?]*[.!?]/gi,
  /\bi\s+don['’]t\s+have\s+access\s+to\s+real-?time[^.!?]*[.!?]/gi,
  /\bi\s+(?:can(?:'|no)?t|am unable to)\s+browse[^.!?]*[.!?]/gi,
  /\bi\s+(?:sincerely\s+|deeply\s+)?apologize(?:\s+for[^.!?]*)?[.!?]/gi,
  /\b(?:my\s+apologies|i'?m\s+(?:so\s+|really\s+)?sorry\s+for\s+(?:the\s+)?(?:confusion|any confusion|the mix-?up))[^.!?]*[.!?]/gi,
];
const AI_TELL_PHRASE_BANS = [
  /\bit['’]s\s+(?:worth\s+noting|important\s+to\s+(?:note|remember|mention|consider))\s+that\s+/gi,
  /\bplease\s+note\s+that\s+/gi,
  /\bkeep\s+in\s+mind\s+that\s+/gi,
  /\bneedless\s+to\s+say,?\s+/gi,
  /\bit\s+goes\s+without\s+saying\s+that\s+/gi,
  /\bat\s+the\s+end\s+of\s+the\s+day,?\s+/gi,
];
const AI_TELL_TRAIL_BANS = [
  /\s*(?:i\s+)?hope\s+(?:this|that)\s+helps?!?\s*$/i,
  /\s*(?:please\s+)?(?:feel\s+free\s+to|don['’]t\s+hesitate\s+to)\s+reach\s+out[^.!?]*[.!?]?\s*$/i,
  /\s*let\s+me\s+know\s+if\s+(?:you\s+)?(?:have\s+any\s+questions|(?:you\s+)?need\s+anything(?:\s+else)?)[^.!?]*[.!?]?\s*$/i,
  /\s*is\s+there\s+anything\s+else\s+i\s+can\s+(?:help|assist)[^.!?]*\??\s*$/i,
];
function stripAiTells(text, opts) {
  if (!text) return text;
  var t = String(text);
  for (var i = 0; i < AI_TELL_LEAD_BANS.length; i++) t = t.replace(AI_TELL_LEAD_BANS[i], '');
  for (var j = 0; j < AI_TELL_SENTENCE_BANS.length; j++) t = t.replace(AI_TELL_SENTENCE_BANS[j], '');
  for (var k = 0; k < AI_TELL_PHRASE_BANS.length; k++) t = t.replace(AI_TELL_PHRASE_BANS[k], '');
  for (var m = 0; m < AI_TELL_TRAIL_BANS.length; m++) t = t.replace(AI_TELL_TRAIL_BANS[m], '');
  // A signpost removal can leave a lowercased sentence start; recapitalize.
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, function (_all, pre, ch) { return pre + ch.toUpperCase(); });
  return t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
module.exports.stripAiTells = stripAiTells;

function scrubTranscriptText(text) {
  if (!text) return text;
  return String(text)
    .replace(/:::thinking[\s\S]*?:::\n?/g, '')
    .replace(/<think>[\s\S]*?<\/think>\n?/g, '')
    .replace(/%{2,4}[a-zA-Z][^%\n]{0,80}%{2,4}/g, '')
    .replace(/\[(?:sound:[a-z0-9_]+|table:[a-z0-9]{1,12})\]/gi, '')
    .replace(/\[END CALL\]/gi, '')
    .replace(/[\uE200-\uE20F]turn\d+[a-z]+\d+/gi, '')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/\\?u[eE]20[0-9a-fA-F]turn\d+[a-zA-Z]+\d+/g, '')
    .replace(/\\?u[eE]20[0-9a-fA-F]/g, '')
    .replace(/turn\d+(?:search|image|news|video|ref|file)\d+/g, '')
    .replace(/\\u00a0/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

module.exports.BROWSER_UA = BROWSER_UA;
module.exports.scrubTranscriptText = scrubTranscriptText;
