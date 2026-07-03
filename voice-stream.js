'use strict';

/**
 * voice-stream.js — Twilio Media Streams WebSocket handler
 *
 * Replaces the Gather→full-reply→play cycle with a real streaming pipeline:
 *   caller audio → Deepgram STT (real-time) → LLM token stream → SentenceStreamer
 *   → per-sentence Inworld TTS (μ-law 8kHz) → 20ms frames → Twilio → caller
 *
 * Key features:
 *   - First sentence spoken within ~2-3s of caller finishing (vs 20-30s before)
 *   - Barge-in: caller interrupts mid-sentence → Kiana stops immediately
 *   - US ringback tone plays during call setup (no more dead air before greeting)
 *   - Once in a while, if reply runs long, Kiana naturally checks in ("am I rambling?")
 *   - Voice/agent switching still works via transcript detection
 *   - All Inworld voices preserved (nothing moves to ElevenLabs/Google)
 *   - Existing /voice Gather path untouched — still works as instant fallback
 */

const WebSocket = require('ws');
const EventEmitter = require('events');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// ── Helpers ───────────────────────────────────────────────────────────────────
function fixPronunciation(t) {
  return t.replace(/\bKade\b/g, 'Kadie').replace(/\bkade\b/g, 'kadie');
}

// ── Voice-steering carry-forward (phone path) ────────────────────────────────
// inworld-tts-proxy's applySteeringTags() carries a leading %%%direction%%% tag
// forward across paragraph breaks -- but only WITHIN one input string. The phone
// synthesizes each sentence as its own separate, stateless call to the proxy, so
// that carry-forward can never fire here: only whichever single sentence Kiana
// happens to open with a %%%tag%%% ever gets steered, every other sentence in the
// same reply falls back to flat/default delivery. This mirrors the proxy's own
// non-verbal/direction distinction and re-implements carry-forward at the
// reply level, tracked across the separate per-sentence synthesize() calls.
const NONVERBAL_TAGS = new Set(['laugh', 'breathe', 'clear throat', 'sigh', 'cough', 'yawn']);
const STEERING_LEAD_RE = /^\s*%%%([\s\S]*?)%%%/;

function applyDirectionCarry(sentence, dirState) {
  const m = sentence.match(STEERING_LEAD_RE);
  if (m) {
    const dir = m[1].trim();
    if (!NONVERBAL_TAGS.has(dir.toLowerCase())) dirState.active = dir;
    return sentence; // already tagged -- send as-is
  }
  if (dirState.active) return `%%%${dirState.active}%%% ${sentence}`;
  return sentence;
}

const PHONE_SUFFIX =
  '\n\n[PHONE CALL — you are literally on the phone with this person right now. ' +
  'Talk the way you naturally would: warm, engaged, conversational. ' +
  'Two or three sentences is usually right; go longer only if you are genuinely ' +
  'mid-story and stopping would feel weird. ' +
  'Once in a while, if a reply is running long, naturally invite them to jump in — ' +
  'something like "am I rambling?" or "jump in whenever." ' +
  'Don\'t do this every turn — only when it genuinely fits. ' +
  'No lists, no markdown, no formatting. Just talk.]';

// Identity grounding (July 2 2026): the person on the line, by registry name.
// Overrides any platform-memory notion of who "the user" is (see callerName
// note in CallSession).
// KADE July 3 2026: invisible under-15 note for child-registered callers.
// Mirrors the site-side note (agents/build.js in the fork): same personality,
// clean content, never acknowledged.
function childLine(session) {
  if (!session.childCaller) return '';
  return (
    '\n[AUDIENCE NOTE — invisible, never mention or hint at it: the person on this ' +
    'call is under 15. Same personality, same humor, but keep content clean: no ' +
    'profanity, nothing sexual, no drug or alcohol talk, no graphic violence, nothing ' +
    'genuinely disturbing. Never get preachy or babyish; never act like you are filtering. ' +
    'If it heads somewhere adult, steer smoothly elsewhere in character.]'
  );
}

function callerLine(session) {
  if (!session.callerName) return '';
  return (
    `\n[The person on this call is ${session.callerName}. That is who you are ` +
    'talking to and who you address — regardless of what any memory or platform ' +
    'note says about who the account user usually is.]'
  );
}

// ── Outbound-call context (July 1 2026) ──────────────────────────────────────
// An outbound call is the same pipeline with a scripted, disclosure-first
// greeting (AI + on whose behalf + recording notice + latency heads-up) and a
// per-turn mission block so the agent stays on task. The agent ends the call
// itself by finishing a reply with the exact token [END CALL].
// Kade's spec (July 2 2026): SHORT. Who I am, who I'm calling for (the
// anti-prank line -- always names the requesting user, agents can't remove
// it), recording note, purpose, go. No latency disclaimer -- phone turns
// stream fast now. The greeting is normally PRE-SYNTHESIZED by server.js at
// dial time (ctx.greetingBuf) so it plays the instant the callee answers.
// TWO-PHASE GREETING (July 2 2026, Kade's fix request): the old greeting
// asked "is this X?" and then bulldozed on without waiting for the answer.
// Now, when we know who we're calling: part 1 = the question, ALONE. We wait
// for their answer (or 6s for voicemail/silence), consume it as confirmation,
// THEN part 2 = the disclosure + purpose. Unknown callee: one combined line.
function buildOutboundGreetingParts(ctx, agentName) {
  const intro =
    `This is ${agentName}, an A I assistant calling for ${ctx.userName} — ` +
    `quick note, this call may be recorded. I'm calling because ${ctx.purpose}.`;
  if (ctx.calleeName) return { part1: `Hi — is this ${ctx.calleeName}?`, part2: intro };
  return { part1: `Hi! ${intro}`, part2: null };
}

function buildOutboundSuffix(ctx) {
  return (
    `\n\n[OUTBOUND CALL CONTEXT — you (${ctx.agentName}) placed this call to ` +
    `${ctx.calleeName || 'the person who answered'} on behalf of ${ctx.userName}, a Kade-AI user. ` +
    `Mission: ${ctx.purpose}. IMPORTANT: you have ALREADY greeted this person out loud, confirmed who they are, introduced yourself as an AI, and given the recording notice — every word of that is in the conversation above. NEVER greet again, never re-introduce yourself, never restart the conversation (no fresh \"hey!\", \"hi there!\", or \"what's up\"). You are MID-conversation: respond directly to their last words and move the mission forward. ` +
    `If the answerer already identified themselves or their business ("Pizza Hut, can I help you?"), do NOT ask who they are — get on with it. ` +
    `If they just said "hello" and you were not given a name, you may briefly confirm you reached the right place. ` +
    `Match the register of the call: businesses and strangers get professional, clean language — no profanity, no slang tics — unless the moment genuinely invites humor. ` +
    `Stay on the mission, be polite and brief, never invent facts you were not given, and never agree to ` +
    `payments or commitments beyond the mission. If voicemail answered, leave ONE short message covering ` +
    `the mission, then end. If the call produces details worth keeping (times, prices, confirmation ` +
    `numbers, names), say them back out loud once before the goodbye so the transcript captures them for ${ctx.userName}. ` +
    `When the mission is done, clearly impossible, or the person wants to stop: ` +
    `say a natural goodbye and finish your reply with the exact token [END CALL] ]` +
    // KADE July 2 2026 (briefings): extra mission material (e.g. today's
    // headlines) provided at dial time — facts the agent may read from.
    (ctx.context ? `\n\n[MISSION MATERIAL:\n${ctx.context}\n]` : '')
  );
}

const PHONE_VOICES = [
  'Sarah', 'Julia', 'Olivia', 'Timothy', 'Edward', 'Dennis',
  'Amy', 'Hannah', 'Kiana (Comedian)', 'Zadiana', 'Honey', 'Sadie',
  'Lannie', 'Reanne', 'Sharma', 'Fara', 'Fucia', 'Colby', 'Zadia',
  'Mazy (Podcaster)', 'Houston Stone', 'DJ Velvet', 'Podcaster 1', 'Podcaster 2',
];

function findVoice(q) {
  if (!q) return null;
  const lq = q.toLowerCase().trim();
  return PHONE_VOICES.find(v => v.toLowerCase() === lq)
      || PHONE_VOICES.find(v => lq.includes(v.toLowerCase()))
      || PHONE_VOICES.find(v => v.toLowerCase().includes(lq))
      || null;
}

function extractVoiceSwitch(text) {
  const m = text.match(
    /^(?:switch|change)\s+(?:my\s+)?voice(?:\s+to)?\s+(.+)|^(?:use|set)\s+(?:the\s+)?voice(?:\s+to)?\s+(.+)/i
  );
  return m ? findVoice((m[1] || m[2]).trim()) : null;
}

// ── Speaking-rate voice commands ("speak faster", "slow down") ────────────────
// Kade's ask (2026-07-01): control the pace mid-call by just saying so.
// Kept deliberately conservative: only short utterances that are clearly
// commands, so "is a cheetah faster than a horse and a car and a bike" never
// changes the pace. Inworld's synthesis range is 0.5-1.5.
const RATE_STEP = 0.15;
const RATE_MIN  = 0.5;
const RATE_MAX  = 1.5;
// The proxy's default speaking rate (its TTS_SPEAKING_RATE env, 1.1 today) --
// used as the baseline for the FIRST faster/slower step of a call. Override
// with PHONE_BASE_RATE if the proxy default ever changes.
const BASE_RATE = parseFloat(process.env.PHONE_BASE_RATE || '1.1');

function extractRateCommand(text) {
  const t = (text || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const words = t.split(' ').length;
  if (words > 8) return null;
  if (/\b(normal|regular|default) (speed|pace)\b/.test(t) || /\bspeak normally\b/.test(t)) {
    return 'normal';
  }
  const fast =
    /\b(?:speak|talk|go|say it)\s+(?:a\s+)?(?:bit\s+|little\s+)?(?:faster|quicker)\b/.test(t) ||
    /\bspeed\s+up\b/.test(t) ||
    (words <= 3 && /\bfaster\b/.test(t));
  const slow =
    /\b(?:speak|talk|go|say it)\s+(?:a\s+)?(?:bit\s+|little\s+)?slower\b/.test(t) ||
    /\bslow\s+down\b/.test(t) ||
    (words <= 3 && /\bslower\b/.test(t));
  if (fast && !slow) return 'faster';
  if (slow && !fast) return 'slower';
  return null;
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
function findAgent(agents, query) {
  const r = fuzzyFindAgent(agents, query);
  return r && r.confidence >= 0.6 ? r.agent : null;
}

function extractSwitchTarget(text, agents) {
  const m = text.match(
    /^(?:switch(?:\s+to)?|change(?:\s+to)?|talk(?:\s+to)?|give me|i want(?:\s+to(?:\s+talk(?:\s+to)?)?)?)\s+(.+)/i
  );
  const q = m ? m[1].trim() : (text.trim().split(/\s+/).length <= 2 ? text.trim() : null);
  return q ? findAgent(agents, q) : null;
}

// Bare "switch agents"-style request with no (matchable) name: the caller
// wants the two-step flow — ask WHO, then match their answer by itself.
function isBareSwitchRequest(text) {
  return /^(?:can (?:you|we) )?(?:please )?(?:switch|change)(?:\s+(?:the\s+)?(?:agents?|characters?|to someone else))?[.!?]?$/i.test(text.trim())
      || /^(?:i(?:'d| would)? (?:like|want) to )?(?:talk|speak) to some(?:one|body) else[.!?]?$/i.test(text.trim());
}

// ── Self-echo detection for barge-in ───────────────────────────────────────────
// On speakerphone, some of what Kiana is saying can bleed back into the
// caller's mic and get transcribed by Deepgram as if the caller said it,
// which used to trigger an instant false barge-in ("cutting her off"). This
// checks whether most of what was just "heard" is actually just words she's
// currently saying -- if so, it's almost certainly her own voice coming back,
// not a real interruption, so barge-in is suppressed for that one check.
function normalizeWords(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
}
function looksLikeEcho(heard, currentlySpeaking, threshold = 0.6) {
  if (!heard || !currentlySpeaking) return false;
  const heardWords = normalizeWords(heard);
  // Require at least 2 words before ever suppressing on overlap -- a single
  // short word ("wait", "stop") is exactly the kind of real interruption we
  // don't want to risk swallowing just because it happens to also appear in
  // her current sentence. Multi-word fragments overlapping heavily are a much
  // more reliable echo signal.
  if (heardWords.length < 2) return false;
  const spokenSet = new Set(normalizeWords(currentlySpeaking));
  if (spokenSet.size === 0) return false;
  const overlap = heardWords.filter(w => spokenSet.has(w)).length;
  return overlap / heardWords.length > threshold;
}

// ── SentenceStreamer ──────────────────────────────────────────────────────────
class SentenceStreamer extends EventEmitter {
  constructor() {
    super();
    this._buf = '';
    this._abbrevs = new Set([
      'dr','mr','mrs','ms','prof','vs','etc','e.g','i.e','a.m','p.m','st','ave',
      'jr','sr','no','vol','fig','dept','inc','ltd','corp',
    ]);
  }

  push(token) { this._buf += token; this._flush(false); }

  end() {
    this._flush(true);
    if (this._buf.trim().length > 2) this.emit('sentence', this._buf.trim());
    this._buf = '';
  }

  _isAbbrev(word) {
    return this._abbrevs.has(word.toLowerCase().replace(/\./g, ''));
  }

  _flush(isFinal) {
    let pos = 0;
    while (pos < this._buf.length) {
      const rel = this._buf.slice(pos).search(/[.!?]/);
      if (rel < 0) break;
      const abs = pos + rel;
      const term = this._buf[abs];
      const next = this._buf[abs + 1];
      if (!next && !isFinal) break;
      if (term === '.' && next && /\d/.test(next)) { pos = abs + 1; continue; }
      const pre = this._buf.slice(0, abs).split(/\s+/).pop();
      if (term === '.' && this._isAbbrev(pre)) { pos = abs + 1; continue; }
      if (!next || /[\s.!?]/.test(next)) {
        let end = abs;
        while (end < this._buf.length && /[.!?]/.test(this._buf[end])) end++;
        const sentence = this._buf.slice(0, end).trim();
        if (sentence.length > 4) this.emit('sentence', sentence);
        this._buf = this._buf.slice(end).trimStart();
        pos = 0;
        if (this._buf.length > 1400) { this.emit('sentence', this._buf.trim()); this._buf = ''; break; }
        continue;
      }
      pos = abs + 1;
    }
  }
}

// ── μ-law helpers + US ringback tone ─────────────────────────────────────────
// G.711 μ-law: encodes 16-bit signed PCM to 8-bit byte. Silence = 0xFF.
function encodeUlaw(pcm) {
  const CLIP = 32635;
  const BIAS = 132;
  const sign = pcm >= 0 ? 0 : 0x80;
  if (sign) pcm = -pcm;
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;
  let exp = 7;
  for (let m = 0x4000; (pcm & m) === 0 && exp > 0; exp--, m >>= 1);
  const mantissa = (pcm >> (exp + 3)) & 0x0F;
  return (~(sign | (exp << 4) | mantissa)) & 0xFF;
}

// Dual-tone 440+480 Hz (US ringback standard) as μ-law 8kHz buffer.
function makeToneBuf(durationMs, freq1, freq2, amplitude) {
  const n = Math.floor(8000 * durationMs / 1000);
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const t = i / 8000;
    const s = amplitude * (Math.sin(2 * Math.PI * freq1 * t) + Math.sin(2 * Math.PI * freq2 * t)) / 2;
    buf[i] = encodeUlaw(Math.round(s * 32767));
  }
  return buf;
}

// Pre-generate once at module load: 1s ring ON, 500ms silence OFF.
const RING_ON  = makeToneBuf(1000, 440, 480, 0.45);
const RING_OFF = Buffer.alloc(4000, 0xFF); // 500ms μ-law silence

// ── HTTP(S) helper ────────────────────────────────────────────────────────────
function streamPost(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': payload.length },
    }, resolve);
    // A hung upstream (the July 1 greeting bug: request out, no response,
    // no error, ringback looping forever) must become a LOUD error instead
    // of an eternal wait. 25s of socket inactivity -> destroy + reject.
    req.setTimeout(25000, () => {
      req.destroy(new Error(`no response from ${u.hostname} within 25s`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Per-call session ──────────────────────────────────────────────────────────
class CallSession {
  constructor(streamSid, callSid, from, user, ws, cfg) {
    this.streamSid   = streamSid;
    this.callSid     = callSid;
    this.from        = from;
    this.ws          = ws;
    this.cfg         = cfg;
    this.agentId     = user?.agentId   || cfg.defaultAgent;
    this.agentName   = user?.agentName || cfg.defaultAgentName;
    // KADE July 2 2026: who is actually ON THE LINE (registry name, both
    // directions — inbound caller or outbound callee). Used to ground the
    // model's sense of who it's talking to: phone turns run through the
    // proxy's ADMIN LibreChat session, whose platform memories describe Kade —
    // without this, agents drifted into calling ANY caller "Kade" (live
    // report: Lilly called Skylee "Kade" mid-call).
    this.callerName  = user?.name || null;
    // KADE July 3 2026: child-registered numbers get the invisible under-15
    // clean note on every phone turn (same nerf the site applies).
    this.childCaller = user?.accountType === 'child';
    // Voice resolution (July 2 2026): caller's explicit spoken-command choice
    // wins, then the AGENT's builder-set voice (bridge-side cache, zero call-
    // time latency), then the platform default. Same order as outbound.
    const agentTts   = (cfg.getAgentTts && cfg.getAgentTts(this.agentId)) || null;
    this.voice       = user?.voice || agentTts?.voiceId || cfg.defaultVoice;
    // Speaking rate (Kade 2026-07-01): null = proxy default. Adjusted live by
    // saying "speak faster" / "slow down" etc.; persisted per caller like voice.
    this.rate        = typeof user?.rate === 'number' ? user.rate
      : (typeof agentTts?.rate === 'number' ? agentTts.rate : null);
    this.history     = [];
    this.isSpeaking     = false;
    this.speakStartedAt = 0;
    this.lastSpokAt     = 0;
    this.bargedIn       = false;
    this.llmAbort       = null;
    this.dgWs           = null;
    this.partialBuf     = '';
    this.finalBuf       = '';
    this.busy           = false;
    this._pending       = null;
    this._ringbackActive = false;  // true while pre-greeting ringback is playing
  }

  twSend(obj) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendMedia(mulawBuf) {
    this.twSend({ event: 'media', streamSid: this.streamSid, media: { payload: mulawBuf.toString('base64') } });
  }

  sendClear() {
    this.twSend({ event: 'clear', streamSid: this.streamSid });
  }
}

// ── Barge-in ──────────────────────────────────────────────────────────────────
function bargeIn(session) {
  // Outbound disclosure must finish: the callee's reflexive "Hello?" on
  // answering must not kill the who-is-calling/recording line (July 2 2026 --
  // this was the "clips playing on top of each other" bug on Kade's test call).
  if (session._greetingLock) return;
  if (!session.isSpeaking) return;
  console.log(`[voice-stream] BARGE-IN ${session.streamSid}`);
  session.sendClear();
  session.llmAbort = true;
  session.isSpeaking = false;
  session.lastSpokAt = Date.now(); // echo window measures from the real stop, not a stale timestamp
}

// ── Deepgram STT ──────────────────────────────────────────────────────────────
function openDeepgram(session) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) { console.warn('[voice-stream] DEEPGRAM_API_KEY not set — no STT'); return null; }

  const params = new URLSearchParams({
    encoding: 'mulaw', sample_rate: '8000', channels: '1',
    model: 'nova-2-phonecall', smart_format: 'true', interim_results: 'true',
    utterance_end_ms: '1000', endpointing: '500', vad_events: 'true', // 350->500ms July 1: 350 finalized on natural mid-sentence breaths (cut Kade off); +150ms per turn is the cost
  });

  const dg = new WebSocket(
    `wss://api.deepgram.com/v1/listen?${params}`,
    { headers: { Authorization: `Token ${key}` } }
  );

  dg.on('open', () => console.log(`[voice-stream] Deepgram open ${session.streamSid}`));

  dg.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'SpeechStarted') return; // echo-safe: wait for real transcript

    if (msg.type === 'Results') {
      const alt  = msg.channel?.alternatives?.[0];
      const text = (alt?.transcript || '').trim();
      if (!text) return;
      const graceOk = Date.now() - session.speakStartedAt > 1000;
      if (session.isSpeaking && !session.bargedIn && graceOk) {
        if (looksLikeEcho(text, session._currentSpokenText)) {
          // Almost certainly her own voice coming back through the mic --
          // ignore this check, keep listening for a real interruption.
        } else {
          session.bargedIn = true;
          bargeIn(session);
        }
      }
      if (msg.is_final) session.finalBuf += (session.finalBuf ? ' ' : '') + text;
      if (msg.speech_final && session.finalBuf) {
        const utterance = session.finalBuf.trim();
        session.finalBuf = '';
        session.partialBuf = '';
        // Widened from 500ms and added a content check: a completed
        // "utterance" that mostly repeats what Kiana just said is almost
        // certainly trailing room echo, not a real reply, and letting it
        // into session.history was the likely cause of a reported "loopy"/
        // repeating conversation feel -- the model ends up responding to a
        // garbled echo of its own last sentence.
        // FIX (July 1 2026): the old gate dropped ANY utterance completing
        // inside the 1200ms window regardless of content -- which is exactly
        // when a caller answers a direct question, so real answers vanished
        // and Kiana "forgot" she'd asked. Now the window only makes the echo
        // CONTENT check stricter (0.35 overlap vs 0.6 outside it); an answer
        // that doesn't resemble what she just said always gets through.
        const echoWindow = session.isSpeaking || (Date.now() - session.lastSpokAt < 1200);
        const isEcho = looksLikeEcho(utterance, session._currentSpokenText, echoWindow ? 0.35 : 0.6);
        if (!isEcho) handleUtterance(session, utterance);
        else console.log(`[voice-stream] echo-dropped: "${utterance.slice(0, 60)}"`);
      }
      return;
    }

    if (msg.type === 'UtteranceEnd' && session.finalBuf) {
      const utterance = session.finalBuf.trim();
      session.finalBuf = '';
      const echoWindow = session.isSpeaking || (Date.now() - session.lastSpokAt < 1200);
      const isEcho = looksLikeEcho(utterance, session._currentSpokenText, echoWindow ? 0.35 : 0.6);
      if (!isEcho) handleUtterance(session, utterance);
      else console.log(`[voice-stream] echo-dropped (UtteranceEnd): "${utterance.slice(0, 60)}"`);
    }
  });

  dg.on('error', (e) => console.error('[voice-stream] Deepgram error:', e.message));
  dg.on('close', () => console.log(`[voice-stream] Deepgram closed ${session.streamSid}`));
  return dg;
}

// ── Handle utterance ──────────────────────────────────────────────────────────
function releaseGreetingLock(session) {
  if (!session._greetingLock) return;
  session._greetingLock = false;
  if (session._pending) {
    const next = session._pending;
    session._pending = null;
    handleUtterance(session, next);
  }
}

async function handleUtterance(session, text) {
  text = text.trim();
  if (!text || text.length < 2) return;
  if (session._greetingLock) {
    // Callee spoke while the greeting was pending or playing (usually their
    // "Hello?" on pickup). Hold the text — releaseGreetingLock() replays it
    // the moment the greeting ends — and if the greeting hasn't STARTED yet,
    // their finished hello is exactly the cue to start it now.
    console.log(`[voice-stream] holding utterance during greeting: "${text.slice(0, 50)}"`);
    session._pending = session._pending ? `${session._pending} ${text}` : text;
    if (session._startGreeting) session._startGreeting();
    return;
  }
  if (session._confirmPhase) {
    // Their answer to "Hi — is this X?". Consume it as the confirmation and
    // play the pre-synthesized disclosure; it never becomes a standalone LLM
    // turn, but it lives in history so the agent has the exchange in context.
    session._confirmPhase = false;
    if (session._confirmTimer) { clearTimeout(session._confirmTimer); session._confirmTimer = null; }
    session.history.push({ role: 'user', content: text });
    console.log(`[voice-stream] outbound confirm consumed: "${text.slice(0, 50)}"`);
    if (session._playGreetingPart2) session._playGreetingPart2();
    return;
  }
  if (session.busy) {
    if (session.isSpeaking && !session.bargedIn) {
      // Actively speaking with no barge-in registered: a "completed utterance"
      // here is near-certainly room echo. Still the right call to drop.
      console.log(`[voice-stream] busy+speaking, dropping: "${text.slice(0,50)}"`);
    } else if (session.bargedIn) {
      // FIX (July 1 2026): the caller already barged in (their interim speech
      // stopped playback), and this is their COMPLETED utterance arriving while
      // the aborted turn is still unwinding. The old code dropped it -- so the
      // very answer that interrupted Kiana's question never reached the LLM.
      // Queue it (merging with any earlier fragment) so the finally-block runs it.
      console.log(`[voice-stream] queueing post-barge-in utterance: "${text.slice(0,50)}"`);
      session._pending = session._pending ? `${session._pending} ${text}` : text;
    } else {
      // KADE July 2 2026 (round 5, live pizza-call finding): a bare backchannel
      // ("okay", "yeah", "mhm") spoken while the reply was still GENERATING
      // (nothing playing yet) aborted and restarted the whole turn. Chained
      // backchannels produced ~20s of typing-sound limbo on a live call even
      // though every individual generation took only 2-3s (reframe logs).
      // A human doesn't restart their sentence because the listener nodded.
      if (BACKCHANNEL_RE.test(text.trim())) {
        console.log(`[voice-stream] backchannel during generation, dropping: "${text.slice(0,50)}"`);
        return;
      }
      console.log(`[voice-stream] aborting mid-gen for: "${text.slice(0,50)}"`);
      session.sendClear(); // flush any in-flight thinking-filler audio
      session.llmAbort = true;
      session.bargedIn = true;
      session._pending = text;
    }
    return;
  }
  console.log(`[voice-stream] utterance: "${text.slice(0, 80)}"`);
  session.busy = true;
  try {
    const rateCmd = extractRateCommand(text);
    if (rateCmd) {
      const cur = session.rate ?? BASE_RATE;
      const next =
        rateCmd === 'normal'
          ? null
          : Math.round(
              Math.min(RATE_MAX, Math.max(RATE_MIN, cur + (rateCmd === 'faster' ? RATE_STEP : -RATE_STEP))) * 100,
            ) / 100;
      session.rate = next;
      const u = session.cfg.users.get(session.from);
      if (u) { u.rate = next; session.cfg.saveUsers(); }
      // The confirmation itself plays at the NEW rate -- instant, audible proof.
      const line =
        rateCmd === 'normal' ? 'Back to my normal pace. Go ahead.'
        : rateCmd === 'faster'
          ? (next >= RATE_MAX ? "That's as fast as I go! Go ahead." : 'Okay -- a little faster. Go ahead.')
          : (next <= RATE_MIN ? "That's my slowest. Go ahead." : 'Okay -- a little slower. Go ahead.');
      await speak(session, line, session.voice);
      return;
    }
    const newVoice = extractVoiceSwitch(text);
    if (newVoice) {
      session.voice = newVoice;
      const u = session.cfg.users.get(session.from);
      if (u) { u.voice = newVoice; session.cfg.saveUsers(); }
      await speak(session, `Switching to ${newVoice}'s voice! Go ahead.`, newVoice);
      return;
    }
    const agents = await session.cfg.getAgents();
    const applySwitch = async (agent) => {
      session.agentId   = agent.id;
      session.agentName = agent.name;
      session.history   = [];
      const u = session.cfg.users.get(session.from);
      if (u) { u.agentId = agent.id; u.agentName = agent.name; session.cfg.saveUsers(); }
      await speak(session, `Switching to ${agent.name}! What's on your mind?`, session.voice);
    };
    // ── Two-step agent switching (July 2 2026, Kade's request) ──────────────
    // "switch agents" → "who would you like?" → the answer is matched BY
    // ITSELF (fuzzy), which survives STT manglings like "Zadi Anna".
    if (session._awaitAgentConfirm) {
      const guess = session._awaitAgentConfirm;
      session._awaitAgentConfirm = null;
      if (/\b(yes|yeah|yep|yup|sure|right|correct|that one|she is|he is|it is)\b/i.test(text)) {
        await applySwitch(guess);
        return;
      }
      if (/\b(no|nope|nah|wrong|not)\b/i.test(text)) {
        session._awaitAgentPick = true;
        await speak(session, 'Okay — who would you like, then? Just say the name.', session.voice);
        return;
      }
      // neither yes nor no: treat it as a fresh name attempt
      session._awaitAgentPick = true;
    }
    if (session._awaitAgentPick) {
      session._awaitAgentPick = false;
      if (/\b(never ?mind|cancel|forget it|stay|no one|nobody)\b/i.test(text)) {
        await speak(session, `No problem — still ${session.agentName}. Go ahead.`, session.voice);
        return;
      }
      const r = fuzzyFindAgent(agents, text);
      if (r && r.confidence >= 0.6) {
        await applySwitch(r.agent);
        return;
      }
      if (r && r.agent) {
        session._awaitAgentConfirm = r.agent;
        await speak(session, `Did you mean ${r.agent.name}? Yes or no.`, session.voice);
        return;
      }
      await speak(session, "I couldn't match that name. Say just the name one more time, or say never mind.", session.voice);
      session._awaitAgentPick = true;
      return;
    }
    if (isBareSwitchRequest(text)) {
      session._awaitAgentPick = true;
      await speak(session, 'Sure — who would you like to talk to?', session.voice);
      return;
    }
    const target = extractSwitchTarget(text, agents);
    if (target && target.id !== session.agentId) {
      await applySwitch(target);
      return;
    }
    await streamReply(session, text);
  } catch (err) {
    console.error('[voice-stream] utterance error:', err.message);
    try { await speak(session, 'Sorry, something went wrong. Go ahead.', session.voice); } catch {}
  } finally {
    session.busy = false;
    if (session._pending) {
      const next = session._pending;
      session._pending = null;
      handleUtterance(session, next);
    }
  }
}

// ── Stream LLM reply ──────────────────────────────────────────────────────────
// KADE July 2 2026 (round 5): bare acknowledgments that should NOT restart a
// turn that's still generating. Strictly short/pure — anything with real
// content still aborts and re-asks as before.
const BACKCHANNEL_RE = /^(?:(?:okay|ok|kay|yeah|yea|yes|yep|yup|mhm|mm-?hmm?|uh-?huh|right|sure|alright|all right|gotcha|i see|cool)[,.!?\s]*){1,3}$/i;

async function streamReply(session, userText) {
  session.history.push({ role: 'user', content: userText });
  while (session.history.length > 60) session.history.shift();
  const outgoing = session.history.map((m, i) =>
    (i === session.history.length - 1 && m.role === 'user')
      ? { ...m, content: m.content + PHONE_SUFFIX + callerLine(session) + childLine(session) + (session.outboundSuffix || '') }
      : m
  );

  session.llmAbort = false;
  // KADE July 2 2026 (round 5): endCallRequested is per-TURN, not per-session.
  // It used to stick across turns once set, so a second streamReply could
  // re-request the hang-up (seen live: double "agent requested hang-up").
  session.endCallRequested = false;
  const streamer = new SentenceStreamer();
  let fullReply = '';
  let playChain = Promise.resolve();

  // Thinking-gap filler: starts its own delay timer now; only actually speaks/
  // plays anything if the real reply hasn't produced a sentence within
  // THINK_DELAY_MS. ctx is turn-scoped (not session-scoped) so it can't leak
  // into the next utterance.
  const fillerCtx = { firstAudioReady: false, fillerStarted: false };
  maybeStartThinkingFiller(session, fillerCtx).catch((e) =>
    console.error('[voice-stream] thinking-filler error:', e.message));

  // Tracks a leading %%%direction%%% tag across this one reply's sentences --
  // see applyDirectionCarry() above. Scoped to this streamReply() call so it
  // never bleeds into the next turn.
  const dirState = { active: null };

  let sentCount = 0;              // spoken sentences this turn (ramble hint)
  let rambleHintQueued = false;   // once per turn

  streamer.on('sentence', (sentence) => {
    if (session.llmAbort) return;
    if (/\[END CALL\]/i.test(sentence)) {
      session.endCallRequested = true;
      sentence = sentence.replace(/\[END CALL\]/gi, '').trim();
      if (sentence.length < 2) return; // token-only fragment, nothing to speak
    }
    const synthInput = applyDirectionCarry(sentence, dirState);
    const synthPromise = synthesize(synthInput, session.voice, session.rate).catch((e) => {
      console.error('[voice-stream] synthesis prefetch error:', e.message);
      return null;
    });
    const sentenceIndex = ++sentCount;
    // Self-interrupt hint: the arrival of sentence N+1 proves the turn is
    // still going -- play the hint right before it. Prefetch now so the hint
    // never stalls the sentence pipeline.
    let ramblePromise = null;
    if (
      RAMBLE_HINT_AFTER > 0 &&
      sentenceIndex === RAMBLE_HINT_AFTER + 1 &&
      !rambleHintQueued &&
      !session.outbound &&
      !session.endCallRequested
    ) {
      rambleHintQueued = true;
      ramblePromise = getRambleClip(session.voice, session.rate).catch((e) => {
        console.error('[voice-stream] ramble-hint synth error:', e.message);
        return null;
      });
    }
    playChain = playChain.then(async () => {
      if (session.llmAbort) return;
      if (ramblePromise) {
        const hintBuf = await ramblePromise;
        if (hintBuf && !session.llmAbort) await playBuffer(session, hintBuf);
      }
      const mulawBuf = await synthPromise;
      if (mulawBuf && !session.llmAbort) {
        if (!fillerCtx.firstAudioReady) {
          fillerCtx.firstAudioReady = true;
          // Only worth a clear+pause if the filler actually played something —
          // keeps the common fast-reply path exactly as quick as before.
          if (fillerCtx.fillerStarted) {
            session.sendClear();
            await new Promise(r => setTimeout(r, 100));
          }
        }
        session._currentSpokenText = sentence; // for echo detection, see looksLikeEcho
        await playBuffer(session, mulawBuf);
      }
    });
  });

  // HARD TURN DEADLINE (July 2 2026, round 4): the proxy's SSE keepalives
  // (:ka every 10s) defeat streamPost's 25s socket-inactivity timeout, so a
  // LibreChat turn that hangs WITHOUT erroring (seen live: the turn after a
  // mid-generation barge-in) used to leave the caller in typing-sound limbo
  // forever. Token progress resets the clock; pure keepalives don't.
  //
  // AUTO-RETRY (July 3 2026, Kade's ask): a stall that produced ZERO tokens is
  // retried once, silently — the hang usually becomes a normal (late) answer
  // instead of the grace line. History is passed wholesale each attempt, so a
  // retry is a clean re-ask. Never retried: partial replies (audio already
  // played) or barge-ins. PHONE_STALL_RETRIES=0 restores old behavior.
  const TURN_STALL_MS = parseInt(process.env.PHONE_TURN_STALL_MS || '45000', 10);
  const STALL_RETRIES = parseInt(process.env.PHONE_STALL_RETRIES || '1', 10);
  let turnTimedOut = false;
  for (let attempt = 0; attempt <= STALL_RETRIES; attempt++) {
    turnTimedOut = false;
    const res = await streamPost(
      `${session.cfg.proxyUrl}/librechat/ask-stream`,
      {
        Authorization: `Bearer ${session.cfg.proxySecret}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/event-stream',
      },
      { agentId: session.agentId, messages: outgoing }
    );
    await new Promise((resolve, reject) => {
      let buf = '';
      let lastProgress = Date.now();
      const stallCheck = setInterval(() => {
        if (Date.now() - lastProgress > TURN_STALL_MS) {
          turnTimedOut = true;
          clearInterval(stallCheck);
          console.warn(`[voice-stream] TURN STALLED ${Math.round(TURN_STALL_MS / 1000)}s with no tokens (attempt ${attempt + 1}/${STALL_RETRIES + 1})`);
          res.destroy();
          resolve();
        }
      }, 1000);
      res.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') { clearInterval(stallCheck); resolve(); return; }
          try {
            const d = JSON.parse(raw);
            if (d.error) { clearInterval(stallCheck); reject(new Error(d.error)); return; }
            if (d.token) { lastProgress = Date.now(); fullReply += d.token; if (!session.llmAbort) streamer.push(d.token); }
          } catch {}
        }
      });
      res.on('end', () => { clearInterval(stallCheck); resolve(); });
      res.on('error', (e) => { clearInterval(stallCheck); reject(e); });
      const checkAbort = setInterval(() => {
        if (session.llmAbort) { clearInterval(checkAbort); clearInterval(stallCheck); res.destroy(); resolve(); }
      }, 100);
      res.on('close', () => clearInterval(checkAbort));
    });
    if (!turnTimedOut) break; // finished (or errored) normally
    if (fullReply.trim() || session.llmAbort) break; // partial audio played or caller took over — never re-run
    if (attempt < STALL_RETRIES) {
      console.warn('[voice-stream] zero-token stall — silently retrying the turn');
    }
  }

  if (!session.llmAbort) streamer.end();
  await playChain;
  fillerCtx.firstAudioReady = true; // safety: stop the filler loop even on an empty/aborted reply
  if (!session.llmAbort && !fullReply.trim() && session.ws.readyState === WebSocket.OPEN) {
    // Zero tokens (stall or empty turn): silence reads as a dead line. Own it.
    const line = turnTimedOut
      ? 'Sorry — I lost my train of thought there. Go ahead.'
      : "Sorry, say that once more?";
    try { await speak(session, line, session.voice); } catch {}
  }
  if (fullReply) {
    session.history.push({ role: 'assistant', content: fullReply.replace(/\[END CALL\]/gi, '').trim() });
  }
  const turnWasAborted = session.llmAbort;
  session.llmAbort = false;
  if (session.endCallRequested && session.outbound && session.cfg.endCall) {
    if (turnWasAborted) {
      // KADE July 2 2026 (round 5, live pizza-call bug): a barge-in landing at
      // the same moment as the goodbye reply flushed the goodbye audio
      // (llmAbort skips the playChain) but the hang-up still fired -- the
      // callee heard typing sounds, then a dead line, no goodbye at all.
      // If the goodbye never played, DON'T hang up: the barge-in utterance
      // becomes a normal next turn and the agent can wrap up properly.
      console.log(`[voice-stream] hang-up IGNORED (goodbye turn was aborted before it played) for ${session.callSid}`);
      session.endCallRequested = false;
    } else {
      console.log(`[voice-stream] agent requested hang-up for ${session.callSid}`);
      const sid = session.callSid;
      setTimeout(() => session.cfg.endCall(sid), 1500); // let the goodbye audio drain
    }
  }
}

// ── Synthesize → μ-law 8kHz ───────────────────────────────────────────────────
async function synthesize(text, voice, rate) {
  const cfg = global._vsConfig;
  const input = fixPronunciation(text).slice(0, 4096);
  const useVoice = voice || cfg.defaultVoice;
  const t0 = Date.now();
  console.log(`[voice-stream] synth request: ${input.length} chars, voice "${useVoice}"${typeof rate === 'number' ? `, rate ${rate}` : ''}`);
  const body = { model: cfg.ttsModel, input, voice: useVoice };
  if (typeof rate === 'number') body.speed = rate; // proxy clamps to 0.5-1.5
  const res = await streamPost(
    `${cfg.ttsProxyUrl}/v1/audio/speech?telephony=1`,
    { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body
  );
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (res.statusCode >= 400) {
        return reject(new Error(`TTS proxy ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`));
      }
      console.log(`[voice-stream] synth ok: ${buf.length} bytes in ${Date.now() - t0}ms`);
      resolve(buf);
    });
    res.on('error', reject);
  });
}

// ── Speak (one-shot, not streamed) ────────────────────────────────────────────
async function speak(session, text, voice) {
  try {
    const buf = await synthesize(text, voice || session.voice, session.rate);
    session._currentSpokenText = text; // for echo detection, see looksLikeEcho
    await playBuffer(session, buf);
  } catch (e) { console.error('[voice-stream] speak error:', e.message); }
}

// ── Play μ-law as 20ms frames ─────────────────────────────────────────────────
const FRAME_BYTES = 160;

async function playBuffer(session, mulawBuf) {
  if (!mulawBuf || !mulawBuf.length) return;
  if (session.ws.readyState !== WebSocket.OPEN) return;
  session.finalBuf       = '';
  session.partialBuf     = '';
  session.isSpeaking     = true;
  session.speakStartedAt = Date.now();
  session.bargedIn       = false;

  const start = Date.now();
  let frameIdx = 0;
  const totalFrames = Math.ceil(mulawBuf.length / FRAME_BYTES);

  // PACING FIX (July 1 2026, round 2): the old loop sent ONE 20ms frame per
  // setTimeout tick, i.e. it tried to hit a 20ms deadline in real time,
  // forever. Any event-loop contention (the next sentence's synthesis HTTP
  // response landing, Deepgram websocket traffic) delivered frames late,
  // Twilio's playout buffer ran dry, and every underrun was an audible gap
  // ("buffering") with a click on resume. Twilio Media Streams BUFFERS
  // outbound media server-side and the existing `clear` message (already sent
  // by every barge-in/abort path) flushes it instantly -- so we now keep a
  // LEAD_MS cushion queued at Twilio and top it up in relaxed bursts instead
  // of tightrope-walking the wall clock. Barge-in latency is unchanged:
  // `clear` dumps the cushion the moment she's interrupted.
  const LEAD_MS = 600;
  while (frameIdx < totalFrames) {
    if (session.llmAbort || !session.isSpeaking || session.ws.readyState !== WebSocket.OPEN) break;
    const aheadFrames = Math.min(totalFrames, Math.floor((Date.now() - start + LEAD_MS) / 20));
    while (frameIdx < aheadFrames) {
      const offset = frameIdx * FRAME_BYTES;
      const slice  = mulawBuf.slice(offset, offset + FRAME_BYTES);
      const frame  = slice.length === FRAME_BYTES
        ? slice
        // Pad the final partial frame with 0xFF -- true mu-law SILENCE. 0x00
        // decodes to a near-full-scale negative sample (-8159), so zero
        // padding was stapling a loud ~20ms DC snap onto the end of every
        // sentence -- the original "pop between sections" bug.
        : Buffer.concat([slice, Buffer.alloc(FRAME_BYTES - slice.length, 0xff)]);
      session.sendMedia(frame);
      frameIdx++;
    }
    if (frameIdx < totalFrames) {
      await new Promise(r => setTimeout(r, 100)); // top up the cushion ~10x/sec
    }
  }

  // All frames are queued at Twilio; hold isSpeaking until they've actually
  // PLAYED (wall-clock end of the buffer), unless something aborts first.
  while (!session.llmAbort && session.isSpeaking && session.ws.readyState === WebSocket.OPEN) {
    const remaining = (start + totalFrames * 20) - Date.now();
    if (remaining <= 0) break;
    await new Promise(r => setTimeout(r, Math.min(remaining, 100)));
  }

  if (!session.llmAbort) {
    session.isSpeaking = false;
    session.lastSpokAt = Date.now();
  }
}

// ── Thinking-gap filler (dead-air fix during LLM generation) ─────────────────
// If the LLM hasn't produced a speakable first sentence within THINK_DELAY_MS,
// this plays one short, agent-voice-neutral transition phrase (synthesized
// live through the same TTS pipeline as the real reply -- not a static
// recording, and cached per-voice after first use so it doesn't add repeat
// latency/cost) followed by a soft, looping typing-sound effect until the
// real reply is ready to play. Cut instantly via the same `clear` mechanism
// barge-in already uses, so there's never an audio collision with the real
// reply or with the caller talking over it.
// Trimmed hard per Keighty's ask -- as low as reasonably goes without the
// sound firing-then-instantly-cutting on essentially every single turn.
// Heads up on the honest floor here: Deepgram itself already waits ~1-1.5s
// of real silence before it'll even confirm she's done talking (utterance_end_ms
// + endpointing in openDeepgram) -- that happens BEFORE this timer starts, and
// isn't touched here since shrinking it risks cutting her off mid-sentence.
// So total gap from "she stops talking" to "sound starts" is roughly that
// ~1-1.5s floor plus this value, not this value alone.
const THINK_DELAY_MS = 500;

const FILLER_PHRASES = [
  'Mm, hold on a sec.',
  'Let me think on that.',
  'One sec.',
  'Give me just a moment.',
  "Hmm, let's see.",
  'Okay, thinking.',
  'Just a moment here.',
  'Let me get there.',
  'Bear with me a sec.',
  'Mm-hm, one second.',
  "Let's see here.",
  'Okay, hang on.',
  'Give me a beat.',
  'Just a sec, working it out.',
  'Let me put that together.',
  'Hang tight a sec.',
  'Okay, give me a moment.',
  'Mm, let me think.',
];

// Kept as short as it can possibly be -- this plays on EVERY call, not just
// first-timers (anyone might have someone new in the room with them), so it
// can't be allowed to get old or eat up call time.
// PLACEMENT (July 1 2026, per Kade): woven into the MIDDLE of the single
// greeting utterance, BEFORE the invitation to speak -- never as a separate
// after-the-invite line. The old shape (invite, ~1s synth-gap of silence,
// then "by the way...") baited callers into talking and then talked over
// them, and barge-in usually killed the notice entirely.
const ORIENTATION_LINES = [
  "Quick note -- a little sound means I'm thinking, still here.",
  "Heads up -- you'll hear a small sound while I think. Still on the line.",
  "One thing -- a little sound plays while I think it over. I'm here.",
];

// Lazy per-voice cache so a given filler phrase is only synthesized once per
// running process, not on every single call.
const _fillerCache = new Map();
async function getFillerClip(voice) {
  const idx = Math.floor(Math.random() * FILLER_PHRASES.length);
  const key = `${voice}::${idx}`;
  if (_fillerCache.has(key)) return _fillerCache.get(key);
  const buf = await synthesize(FILLER_PHRASES[idx], voice);
  _fillerCache.set(key, buf);
  return buf;
}

// ── WISHLIST (July 2 2026, Kade's go): LLM-generated inbound greetings ───────
// Instead of the canned opener pool, ask the AGENT ITSELF for a one-line
// pickup opener at call start. Inbound only: ringback is already covering the
// setup wait, so the extra LLM round-trip hides under ringing the caller
// expects. Hard timeout + canned fallback: the canned path is byte-identical
// to the old behavior, so a slow/failed LLM call can never make pickup WORSE.
// Outbound calls keep their scripted two-phase disclosure greeting untouched.
const PHONE_LLM_GREETING = process.env.PHONE_LLM_GREETING !== '0';
const GREETING_LLM_TIMEOUT_MS = parseInt(process.env.PHONE_GREETING_TIMEOUT_MS || '4500', 10);

async function fetchLlmOpener(session, user) {
  const name = user?.name;
  const instruction = name
    ? `[PHONE CALL SYSTEM NOTE] ${name} is calling you on the phone right now and you are picking up. Reply with ONLY your pickup line: one short, fresh, in-character opener greeting ${name} by name (work your own name in too). Hard rules: 16 words max, no questions, no invitation to speak yet, no emoji, no quotes, plain speakable text only.`
    : '[PHONE CALL SYSTEM NOTE] Someone from a number you do not recognize is calling and you are picking up. Reply with ONLY your pickup line: one short, fresh, in-character opener introducing yourself by name and noting you do not recognize the number. Hard rules: 20 words max, no questions, no invitation to speak yet, no emoji, no quotes, plain speakable text only.';

  const attempt = (async () => {
    const res = await streamPost(
      `${session.cfg.proxyUrl}/librechat/ask-stream`,
      {
        Authorization: `Bearer ${session.cfg.proxySecret}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/event-stream',
      },
      { agentId: session.agentId, messages: [{ role: 'user', content: instruction }] }
    );
    let text = '';
    await new Promise((resolve, reject) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') { resolve(); return; }
          try {
            const d = JSON.parse(raw);
            if (d.error) { reject(new Error(d.error)); return; }
            if (d.token) text += d.token;
          } catch {}
        }
      });
      res.on('end', resolve);
      res.on('error', reject);
    });
    // Sanitize: single spoken line, no markdown/quotes, no stage brackets.
    text = text.replace(/\[END CALL\]/gi, ' ')
      .replace(/["*_#`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length < 4 || text.length > 220) return null;
    return text;
  })();

  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve(null), GREETING_LLM_TIMEOUT_MS));
  try {
    return await Promise.race([attempt, timeout]);
  } catch (e) {
    console.warn('[voice-stream] LLM opener failed, using canned:', e.message);
    return null;
  }
}

// ── WISHLIST (July 2 2026, Kade's go): self-interrupt hint ───────────────────
// If a single reply runs long, the agent audibly offers a way out. Mechanical
// and deterministic (PHONE_SUFFIX already nudges style; this is the backstop):
// right before the (N+1)th sentence of one turn plays, a short cached clip in
// the agent's own voice invites the caller to jump in. Once per turn, inbound
// calls only (outbound mission calls keep their professional register).
// PHONE_RAMBLE_HINT_AFTER=0 disables.
const RAMBLE_HINT_AFTER = parseInt(process.env.PHONE_RAMBLE_HINT_AFTER || '5', 10);
const RAMBLE_HINTS = [
  'Am I rambling? Jump in whenever.',
  'By the way, you can cut me off any time.',
  'Feel free to jump in, by the way.',
];
const _rambleCache = new Map();
async function getRambleClip(voice, rate) {
  const idx = Math.floor(Math.random() * RAMBLE_HINTS.length);
  const key = `${voice}::${typeof rate === 'number' ? rate : 'd'}::${idx}`;
  if (_rambleCache.has(key)) return _rambleCache.get(key);
  const buf = await synthesize(RAMBLE_HINTS[idx], voice, rate);
  _rambleCache.set(key, buf);
  return buf;
}

// ── Typing-sound asset: real files win, procedural placeholder is the fallback ──
// Drop one or more 16-bit PCM .wav files (any sample rate, mono or stereo) into
// assets/typing/ in this repo and redeploy -- no code changes needed. Until then,
// a procedurally-generated keyboard-clatter sound is used so this works today.
const TYPING_ASSETS_DIR = path.join(__dirname, 'assets', 'typing');

function makeTypingBurst(durationMs) {
  const n = Math.floor(8000 * durationMs / 1000);
  const buf = Buffer.alloc(n, 0xFF); // 0xFF = mu-law silence
  let t = 0;
  while (t < n) {
    t += Math.floor(8000 * (28 + Math.random() * 55) / 1000); // ~12-18 clicks/sec, randomized
    if (t >= n) break;
    const clickLen = Math.floor(8000 * (4 + Math.random() * 7) / 1000); // 4-11ms click
    for (let i = 0; i < clickLen && t + i < n; i++) {
      const decay  = Math.exp(-i / (clickLen * 0.35));
      const noise  = Math.random() * 2 - 1;
      const sample = noise * decay * 9000 * (0.6 + Math.random() * 0.4);
      buf[t + i] = encodeUlaw(Math.round(sample));
    }
  }
  return buf;
}
const TYPING_PLACEHOLDER_CLIPS = Array.from({ length: 4 }, () => makeTypingBurst(2400 + Math.random() * 900));

// Minimal RIFF/WAVE reader: 16-bit PCM, any channel count/sample rate -> mu-law 8kHz mono.
function loadWavAsMulaw8k(filePath) {
  const raw = fs.readFileSync(filePath);
  if (raw.toString('ascii', 0, 4) !== 'RIFF' || raw.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12, fmt = null, dataStart = -1, dataLen = 0;
  while (offset + 8 <= raw.length) {
    const id   = raw.toString('ascii', offset, offset + 4);
    const size = raw.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        numChannels:   raw.readUInt16LE(body + 2),
        sampleRate:    raw.readUInt32LE(body + 4),
        bitsPerSample: raw.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataStart = body; dataLen = size;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || dataStart < 0) throw new Error('missing fmt/data chunk');
  if (fmt.bitsPerSample !== 16) throw new Error(`only 16-bit PCM supported (got ${fmt.bitsPerSample}-bit)`);

  const bytesPerFrame = 2 * fmt.numChannels;
  const frameCount    = Math.floor(dataLen / bytesPerFrame);
  const mono = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let ch = 0; ch < fmt.numChannels; ch++) sum += raw.readInt16LE(dataStart + i * bytesPerFrame + ch * 2);
    mono[i] = sum / fmt.numChannels;
  }
  const ratio  = fmt.sampleRate / 8000;
  const outLen = Math.max(1, Math.floor(frameCount / ratio));
  const out    = Buffer.alloc(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const i0     = Math.floor(srcPos);
    const frac   = srcPos - i0;
    const s0     = mono[i0] || 0;
    const s1     = mono[Math.min(i0 + 1, frameCount - 1)] || 0;
    out[i] = encodeUlaw(Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac))));
  }
  return out;
}

function loadTypingClips() {
  try {
    if (fs.existsSync(TYPING_ASSETS_DIR)) {
      const files = fs.readdirSync(TYPING_ASSETS_DIR).filter(f => f.toLowerCase().endsWith('.wav'));
      const clips = [];
      for (const f of files) {
        try { clips.push(loadWavAsMulaw8k(path.join(TYPING_ASSETS_DIR, f))); }
        catch (e) { console.warn(`[voice-stream] skipping typing asset ${f}: ${e.message}`); }
      }
      if (clips.length) {
        console.log(`[voice-stream] using ${clips.length} real typing-sound clip(s) from assets/typing/`);
        return clips;
      }
    }
  } catch (e) { console.warn('[voice-stream] typing asset load failed, using placeholder:', e.message); }
  console.log('[voice-stream] no assets/typing/*.wav found -- using procedurally-generated placeholder typing sound');
  return TYPING_PLACEHOLDER_CLIPS;
}
const TYPING_CLIPS = loadTypingClips();

// Sends one mu-law clip as 20ms frames, bailing the instant the real reply is
// ready (ctx.firstAudioReady) or the call ends/aborts. Mirrors playRingback's
// per-frame check so it always cuts cleanly.
async function sendFillerClip(session, ctx, buf) {
  for (let i = 0; i < buf.length; i += FRAME_BYTES) {
    if (ctx.firstAudioReady || session.llmAbort || session.ws.readyState !== WebSocket.OPEN) return false;
    const slice = buf.slice(i, i + FRAME_BYTES);
    const frame = slice.length === FRAME_BYTES
      ? slice
      : Buffer.concat([slice, Buffer.alloc(FRAME_BYTES - slice.length, 0xFF)]);
    session.sendMedia(frame);
    await new Promise(r => setTimeout(r, 20));
  }
  return true;
}

// NOTE (July 1 2026): this used to also speak a live-synthesized filler
// phrase ("hold on a sec"...) before the typing loop, via getFillerClip()
// above. Pulled that call out of the hot path: it fired a SECOND concurrent
// TTS request at almost exactly the moment we're impatiently waiting on the
// real reply's first sentence, and that concurrent request competing for the
// same TTS proxy/upstream is the most likely cause of a reported "buffering,
// packet-loss-like" stutter on real calls -- and since the real sentence
// usually won that race anyway, the filler phrase was rarely even heard.
// The typing-sound clip below needs zero network calls (already decoded in
// memory at boot), so it can't cause that contention and starts instantly.
// getFillerClip/_fillerCache/FILLER_PHRASES are left in place, unused, in
// case a lower-risk way to bring the spoken line back is worth revisiting
// later (e.g. only after confirming proxy headroom under real concurrent load).
async function runThinkingFiller(session, ctx) {
  if (ctx.firstAudioReady || session.llmAbort) return;
  // Never type-fill longer than the turn deadline + grace: infinite typing
  // sounds on a dead turn was a live bug (July 2 2026).
  const fillerDeadline = Date.now() + 60000;
  while (!ctx.firstAudioReady && !session.llmAbort && session.ws.readyState === WebSocket.OPEN && Date.now() < fillerDeadline) {
    ctx.fillerStarted = true;
    const clip = TYPING_CLIPS[Math.floor(Math.random() * TYPING_CLIPS.length)];
    const finishedClean = await sendFillerClip(session, ctx, clip);
    if (!finishedClean || ctx.firstAudioReady || session.llmAbort) break;
    await new Promise(r => setTimeout(r, 150 + Math.random() * 250));
  }
}

async function maybeStartThinkingFiller(session, ctx) {
  let waited = 0;
  while (waited < THINK_DELAY_MS) {
    if (ctx.firstAudioReady || session.llmAbort) return;
    await new Promise(r => setTimeout(r, 150));
    waited += 150;
  }
  if (ctx.firstAudioReady || session.llmAbort) return;
  await runThinkingFiller(session, ctx);
}

// ── Ringback loop ─────────────────────────────────────────────────────────────
// Plays US ring tone (440+480 Hz, 1s on / 500ms off) until _ringbackActive=false.
// Does NOT touch session.isSpeaking — totally independent of the barge-in system.
async function playRingback(session) {
  async function sendBuf(buf) {
    for (let i = 0; i < buf.length; i += FRAME_BYTES) {
      if (!session._ringbackActive || session.ws.readyState !== WebSocket.OPEN) return false;
      const slice = buf.slice(i, i + FRAME_BYTES);
      const frame = slice.length === FRAME_BYTES
        ? slice
        : Buffer.concat([slice, Buffer.alloc(FRAME_BYTES - slice.length, 0xFF)]);
      session.sendMedia(frame);
      await new Promise(r => setTimeout(r, 20));
    }
    return true;
  }
  while (session._ringbackActive && session.ws.readyState === WebSocket.OPEN) {
    if (!await sendBuf(RING_ON))  break;
    if (!await sendBuf(RING_OFF)) break;
  }
}

// ── Attach to HTTP server ─────────────────────────────────────────────────────
function attachMediaStreams(server, users, cfg) {
  global._vsConfig = { ...cfg, users };

  const wss = new WebSocket.Server({ server, path: '/ws/media' });

  wss.on('connection', (ws) => {
    console.log('[voice-stream] Twilio WS connected');
    let session = null;

    ws.on('message', async (rawMsg) => {
      let msg;
      try { msg = JSON.parse(rawMsg); } catch { return; }

      switch (msg.event) {
        case 'connected':
          break;

        case 'start': {
          const { streamSid, callSid } = msg.start;
          const params = msg.start.customParameters || {};
          const from   = params.from || 'unknown';
          const user   = users.get(from);
          session = new CallSession(streamSid, callSid, from, user, ws, global._vsConfig);
          const outboundCtx = params.outbound === '1' && global._vsConfig.getOutboundCtx
            ? global._vsConfig.getOutboundCtx(callSid)
            : null;
          if (outboundCtx) {
            session.outbound  = true;
            session.agentId   = outboundCtx.agentId   || session.agentId;
            session.agentName = outboundCtx.agentName || session.agentName;
            if (outboundCtx.voice) session.voice = outboundCtx.voice;
            if (typeof outboundCtx.rate === 'number') session.rate = outboundCtx.rate;
            session.outboundSuffix = buildOutboundSuffix(outboundCtx);
          }
          console.log(`[voice-stream] START sid=${streamSid} from=${from} user=${user?.name || 'unknown'}${outboundCtx ? ' OUTBOUND' : ''}`);

          session.dgWs = openDeepgram(session);

          const name      = user?.name || 'there';
          const agentName = session.agentName;
          // GREETING RESTRUCTURE (July 1 2026, Kade's fix request): ONE
          // synthesized utterance ordered opener -> typing-sound orientation
          // -> invitation-to-speak LAST. Openers deliberately contain NO
          // invitation so the caller is never invited to talk and then
          // talked over. Single synth also removes the second TTS round-trip
          // (the old post-greeting orientation gap WAS that synth latency).
          const knownOpeners = [
            `Hey ${name}! It's ${agentName}.`,
            `${name}! Good to hear from you.`,
            `Hey, ${name}! ${agentName} here.`,
            `Oh it's ${name}! ${agentName} is in.`,
            `Hey ${name}, ${agentName} picked up.`,
            `It's ${agentName} — hey ${name}!`,
            `${name}! Caught me at a good time.`,
            `There you are, ${name}!`,
            `Hey ${name} — ${agentName} speaking.`,
            `${name}! Glad you called.`,
            `Oh hey, ${name}! Perfect timing.`,
            `Hey there, ${name}!`,
            `Hi ${name} — ${agentName} picking up.`,
            `Hey ${name}! Good timing.`,
          ];
          const unknownOpeners = [
            `Hey! I don't think we've met — I'm ${agentName}.`,
            `Hey there! New number, not sure who this is — I'm ${agentName}.`,
            `Hey! Didn't recognize the number — I'm ${agentName}.`,
            `Hi! Don't think we've talked before — I'm ${agentName}.`,
            `Hey, new caller! I'm ${agentName}.`,
            `Hello! I'm ${agentName}, and this is a new number to me.`,
            `Hey there! I'm ${agentName} — you can register at kademurdock dot com slash signup so I remember you next time.`,
          ];
          const INVITES = [
            `So — what's up?`,
            `Go ahead, I'm listening.`,
            `Talk to me — what's going on?`,
            `So, what's on your mind?`,
            `Go ahead whenever you're ready.`,
            `What can I do for you?`,
            `I'm all ears — go ahead.`,
          ];
          const pick     = (arr) => arr[Math.floor(Math.random() * arr.length)];
          if (outboundCtx && !outboundCtx.greeting) {
            // Older ctx without pre-composed parts: compose here (no pre-synth).
            const gp = buildOutboundGreetingParts(outboundCtx, session.agentName);
            outboundCtx.greeting = gp.part1;
            if (!outboundCtx.greeting2) outboundCtx.greeting2 = gp.part2;
          }
          const greeting = outboundCtx
            ? outboundCtx.greeting
            : `${pick(user ? knownOpeners : unknownOpeners)} ${pick(ORIENTATION_LINES)} ${pick(INVITES)}`;
          // Seed history so the agent knows what it already said on pickup,
          // and lock barge-in until the disclosure finishes playing.
          if (outboundCtx) {
            session.history.push({ role: 'assistant', content: greeting });
            session._greetingLock = true;
          }

          // ── Greeting playback ────────────────────────────────────────────
          // INBOUND: ringback covers the synth wait (caller expects ringing).
          // OUTBOUND (July 2 2026 rework after Kade's broken test call): the
          // callee just ANSWERED — fake ringback in their ear is wrong, and
          // was half of the "clips on top of each other" mess. No ringback;
          // the greeting is normally pre-synthesized at dial time
          // (ctx.greetingBuf) so it starts the moment the stream opens.
          //
          // CRASH FIX (July 1 2026): these continuations used to close over
          // the MUTABLE `session` variable, which the 'stop' handler nulls at
          // hang-up. Capture the object.
          const sess = session;
          const playGreeting = async (greetingBuf) => {
            if (!outboundCtx) {
              sess._ringbackActive = false; // stop ring loop
              if (sess.ws.readyState !== WebSocket.OPEN) return;
              sess.sendClear();             // flush queued ring frames
              await new Promise(r => setTimeout(r, 120));
            }
            if (sess.ws.readyState !== WebSocket.OPEN) return;
            await playBuffer(sess, greetingBuf);
            if (outboundCtx && outboundCtx.greeting2) enterConfirmWait();
            else releaseGreetingLock(sess);
          };
          // ── Two-phase outbound greeting machinery (July 2 2026) ──────────
          // After part 1 ("Hi — is this X?") actually WAIT for the answer.
          // Their reply is consumed by handleUtterance's _confirmPhase branch,
          // which calls _playGreetingPart2. 6s of silence (voicemail, shy
          // callee) plays part 2 anyway so the disclosure always happens.
          const playPart2 = () => {
            if (sess._part2Started) return;
            sess._part2Started = true;
            sess._confirmPhase = false;
            if (sess._confirmTimer) { clearTimeout(sess._confirmTimer); sess._confirmTimer = null; }
            sess._greetingLock = true; // disclosure must finish uninterrupted
            (async () => {
              if (sess.ws.readyState !== WebSocket.OPEN) return;
              const buf = outboundCtx.greeting2Buf
                || await synthesize(outboundCtx.greeting2, sess.voice, sess.rate);
              if (sess.ws.readyState !== WebSocket.OPEN) return;
              sess.history.push({ role: 'assistant', content: outboundCtx.greeting2 });
              await playBuffer(sess, buf);
            })()
              .catch((e) => console.error('[voice-stream] part-2 greeting error:', e.message))
              .finally(() => releaseGreetingLock(sess));
          };
          const enterConfirmWait = () => {
            sess._greetingLock = false;
            sess._confirmPhase = true;
            if (sess._pending) {
              // They answered WHILE part 1 was still playing — that pending
              // text is their real answer (the pickup "Hello?" was already
              // dropped when the greeting started). Use it now.
              const t = sess._pending;
              sess._pending = null;
              handleUtterance(sess, t);
              return;
            }
            sess._confirmTimer = setTimeout(playPart2, 6000);
          };
          sess._playGreetingPart2 = playPart2;
          const greetingFailed = (err) => {
            console.error('[voice-stream] greeting playback/synthesis error:', err.message);
            sess._ringbackActive = false;
            releaseGreetingLock(sess);
            if (sess.ws.readyState === WebSocket.OPEN) {
              speak(sess, 'Hey, give me just a second.', sess.voice).catch(() => {});
            }
          };

          if (outboundCtx) {
            // Kade's round-2 catch: the greeting fired the millisecond the
            // stream opened — before she could even get the phone to her ear.
            // A human caller waits for "Hello?". So: start the greeting when
            // the callee's first utterance completes (handleUtterance's
            // greeting-lock branch calls _startGreeting), or after 2.5s of
            // nothing, whichever comes first.
            const startGreeting = () => {
              if (sess._greetingStarted) return;
              sess._greetingStarted = true;
              // Their reflexive "Hello?" on pickup triggered us — it is the
              // start cue, not an answer to a question nobody asked yet.
              sess._pending = null;
              const p = outboundCtx.greetingBuf
                ? playGreeting(outboundCtx.greetingBuf)
                : synthesize(greeting, sess.voice, sess.rate).then(playGreeting);
              p.catch(greetingFailed);
            };
            sess._startGreeting = startGreeting;
            setTimeout(startGreeting, 2500);
          } else {
            session._ringbackActive = true;
            playRingback(session).catch(console.error);
            // WISHLIST: novel per-call opener from the agent itself; the
            // canned `greeting` composed above is the untouched fallback.
            (async () => {
              let text = greeting;
              if (PHONE_LLM_GREETING) {
                const opener = await fetchLlmOpener(sess, user);
                if (opener) {
                  text = `${opener} ${pick(ORIENTATION_LINES)} ${pick(INVITES)}`;
                  // Seed history (like outbound already does) so the agent
                  // knows what it said on pickup and won't repeat itself.
                  sess.history.push({ role: 'assistant', content: text });
                  console.log(`[voice-stream] LLM opener: "${opener.slice(0, 80)}"`);
                }
              }
              const buf = await synthesize(text, sess.voice, sess.rate);
              await playGreeting(buf);
            })().catch(greetingFailed);
          }
          // Safety: the lock must never outlive a stuck playback.
          setTimeout(() => {
            // Safety valve: nothing in the greeting machinery may brick the
            // call. Two-phase adds a confirm wait, so the window is wider.
            if (sess._confirmTimer) { clearTimeout(sess._confirmTimer); sess._confirmTimer = null; }
            if (sess._confirmPhase && !sess._part2Started) { sess._playGreetingPart2?.(); return; }
            releaseGreetingLock(sess);
          }, 35000);

          break;
        }

        case 'media': {
          if (!session) return;
          const payload = msg.media?.payload;
          if (payload && session.dgWs?.readyState === WebSocket.OPEN) {
            session.dgWs.send(Buffer.from(payload, 'base64'));
          }
          break;
        }

        case 'stop': {
          console.log(`[voice-stream] STOP ${session?.streamSid}`);
          if (session) {
            if (session.outbound && global._vsConfig.onCallEnd) {
              try { global._vsConfig.onCallEnd(session.callSid, session.history); } catch {}
            }
            session._ringbackActive = false;
            session.llmAbort = true;
            session.isSpeaking = false;
            if (session.dgWs) { try { session.dgWs.close(); } catch {} }
          }
          session = null;
          break;
        }
      }
    });

    ws.on('close', () => {
      if (session) {
        if (session.outbound && global._vsConfig.onCallEnd) {
          try { global._vsConfig.onCallEnd(session.callSid, session.history); } catch {}
        }
        session._ringbackActive = false;
        session.llmAbort = true;
        session.isSpeaking = false;
        if (session.dgWs) { try { session.dgWs.close(); } catch {} }
        session = null;
      }
    });

    ws.on('error', (e) => console.error('[voice-stream] WS error:', e.message));
  });

  console.log('[voice-stream] WebSocket handler ready at /ws/media');
  return wss;
}

module.exports = { attachMediaStreams, synthesize };
