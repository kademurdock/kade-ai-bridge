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
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Helpers ───────────────────────────────────────────────────────────────────
// fixPronunciation: shared — see voice-commands.js

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

// SHARED voice-command brain (July 13 2026): one copy for both engines.
const { PHONE_VOICES, findVoice, extractVoiceSwitch, VOICE_IDENTIFY_REGEX, PHONE_SUFFIX,
        fixPronunciation, editDistance, phoneticFold, stripSwitchPadding, extractSwitchTarget, findAgent, fuzzyFindAgent, BROWSER_UA, scrubTranscriptText, stripAiTells,
        parseSpokenEmailV2, spellOutEmail, parseSpokenPassword, friendlyPassword,
        REG_INTENT_RE, REG_CANCEL_RE, REG_YES_RE, REG_NO_RE, REG_PICK_RE,
        REG_OK_RE, REG_ANOTHER_RE, friendlyPasswordParts } = require('./voice-commands');
const videoSight = require('./video-sight'); // caller camera -> agent vision (July 16 2026)
// Watch-and-alert delivery (July 16 2026, Kade's yes -- character-voice
// alerts): when an armed watch fires (or expires), video-sight hands the
// engine a system-authored alert message and the engine runs it as a REAL
// character turn the moment the line is quiet. This is the one sanctioned
// exception to "only speaks when spoken to" -- the caller armed it on purpose.
// It never talks over anyone: it waits for busy/isSpeaking to clear first.
videoSight.onAlert((session, alertText) => { watchAlertTurn(session, alertText).catch(() => {}); });
const videoLive = require('./video-live'); // EXPERIMENTAL Gemini Live lane (July 16 2026) — hard-inert unless LIVE_ENABLED=true + GOOGLE_LIVE_API_KEY set

// KADE July 4 2026 ("debug that last conversation"): live call 17:16 — Wild
// Blanks dealt fine (tool call), then "Five" got THREE consecutive turns with
// toolMode=false: the model adjudicated the game itself instead of passing
// the move to the engine (reasoning:none + an UNO-flavored platform memory
// primed it to ask "five what?"). The engine is the referee — remind the
// model of that on every turn while a table is live. Detection: any [table:]
// or [sound:] token seen in this call within the last 10 minutes.
const GAME_SUFFIX =
  '\n[GAME MODE on this call. The game tool is the ONLY referee. If they name ' +
  'a game or ask to play, START it through the game tool NOW — the engine ' +
  'handles decks, rules, and settings; do not interview them about setup. ' +
  "Once a game is live, pass the caller's move to the game tool VERBATIM " +
  'every time — a bare number like "one" or "five" IS their move (card/slot ' +
  'in THIS game, not a card from any other game). Never guess, adjudicate, ' +
  'or restate game state from memory; call the tool and speak from what it ' +
  'returns. When relaying a round, the short-reply phone rule is SUSPENDED: ' +
  'tell the WHOLE round from the tool result — the prompt, every card ' +
  'played and by whom, who won the round, and the score — and read hands ' +
  'with their numbers. Skipping the reveal or the winner ruins the game. ' +
  'Round numbers and scores come ONLY from the NEWEST tool result, never ' +
  'from earlier conversation — earlier rounds are history, not the score.]';
const GAME_ACTIVE_MS = 10 * 60 * 1000;
// Bigger synth units = better prosody (context batching, July 4 2026).
const TTS_CHUNK_TARGET = parseInt(process.env.PHONE_TTS_CHUNK || '320', 10);
/* KADE July 19 2026 (session 14, first confirmed-good native call): "it is
 * still doing that weird, one sentence, big pause, more sentences, the
 * sentence chunking thing. I feel like it could be a little speedier."
 *
 * That pause is this file's own design, working exactly as written: sentence
 * one ships alone for fast first audio, and then EVERYTHING after it waits to
 * accumulate TTS_CHUNK_TARGET (320) characters before a single synth call.
 * So the caller hears one quick sentence, then a silence that lasts as long
 * as it takes to generate ~320 characters of speech, then a long run.
 *
 * The 320 target itself was HER earlier call and is still right for the
 * problem it solved (July 4: "make the chunks bigger; it can't remember it
 * sounds like it's listing games" -- per-sentence synth gives the voice zero
 * prosodic context, so lists lose their rhythm). Dropping it globally would
 * just trade her old complaint back for her new one.
 *
 * So: RAMP instead of choosing. Sentence 1 alone (unchanged), then ONE short
 * chunk, then the full target from the third chunk on. The short second chunk
 * lands while she's still hearing sentence one, which is what actually closes
 * the audible gap; by the time chunks matter for list rhythm, they're back at
 * full size. Her pick when asked directly, over "small chunks everywhere."
 */
const TTS_CHUNK_RAMP = parseInt(process.env.PHONE_TTS_CHUNK_RAMP || '140', 10);
// July 4 2026 round 2 ("Still having problems", 17:24 call): arming only on
// [table:]/[sound:] tokens misses the game REQUEST itself — "let's play
// cards against reality" got a setup interview instead of a deal, and the
// first bare "One." after the deal still went un-refereed. The ask-to-play
// utterance now arms game mode BEFORE the turn goes to the model.
const GAME_START_RE = new RegExp(
  "\\b(let'?s play|deal me|play (?:a |some )?(?:game|cards)|game parlor|" +
  'cards against|wild blanks|crab apples|blackjack|battleship|farkle|' +
  "liar'?s dice|hangman|word scramble|tic[- ]?tac[- ]?toe|rock paper scissors|" +
  'go fish|uno|in[- ]between|acey[- ]deucey|guess the sound|fill[- ]in stories|trivia)\\b', 'i');
function armGameMode(session, why) {
  const wasActive = typeof session.lastGameTokenAt === 'number'
    && Date.now() - session.lastGameTokenAt < GAME_ACTIVE_MS;
  session.lastGameTokenAt = Date.now();
  if (!wasActive) console.log(`[voice-stream] game mode ARMED (${why}) ${session.streamSid}`);
}

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

/** July 12 2026: the caller's own memory cards (fetched from the fork at call
 * start / agent switch). Same knowledge the web injects — fixes phone-side
 * "cluelessness" where agents knew nothing the caller ever told them. */
function memoryLine(session) {
  if (!session.callerMemories) return '';
  return (
    `\n\n[WHAT YOU REMEMBER ABOUT ${session.callerName || 'this caller'} — their own saved memory ` +
    `cards from the app. Use them naturally like a friend who remembers; never recite or list them. ` +
    `DISCRETION: this is a live call that may be on speaker with others listening -- do NOT bring up ` +
    `the private or sensitive cards (health, relationships, money, confessions, anything embarrassing ` +
    `overheard) until the caller mentions the topic themselves this call; until then stick to the ` +
    `everyday ones. NEVER volunteer opinions, warnings, or judgments about the caller's habits, health, purchases, or personal choices, and only bring up a remembered fact when it directly answers what they asked:\n` +
    session.callerMemories + ']'
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

// PHONE_VOICES: shared — see voice-commands.js

// findVoice: shared — see voice-commands.js (now understands numbers here too)

// extractVoiceSwitch: shared — see voice-commands.js (possessives + numbers now work on streaming calls)

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
  // July 13 2026 audit: complaints are commands too — "you're talking too
  // fast" means slow down. Short utterances only (a 5-word cap keeps
  // "that song is way too fast" conversations from misfiring mid-story).
  if (words <= 5) {
    if (/\btoo\s+(?:fast|quick(?:ly)?)\b/.test(t)) return 'slower';
    if (/\btoo\s+slow(?:ly)?\b/.test(t)) return 'faster';
    if (/\bquicker\b/.test(t) && words <= 3) return 'faster';
  }
  return null;
}

// ── Fuzzy agent matching (July 2 2026, Kade's fix request) ────────────────────
// Deepgram never transcribes made-up names right ("Zadiana" arrives as
// "Zadi Anna", "sadie ana", "zodiana"...). Exact/substring matching was
// useless for exactly the agents Kade cares most about. Fold both sides
// phonetically (z/s, c/k, ph/f, vowels loosened, doubles collapsed, spaces
// stripped) and accept close edit distances.
// phoneticFold: shared — see voice-commands.js
// editDistance: shared — see voice-commands.js
// fuzzyFindAgent: shared — see voice-commands.js
// findAgent: shared — see voice-commands.js

// Strip conversational padding so switch commands survive politeness (Kade's
// July 3 report: "Can you switch to Kiana?" fell through to the LLM and
// Zadiana answered IN CHARACTER — slightly offended — instead of switching.
// The old matcher was anchored to the utterance start, so any polite lead-in
// defeated it, including the help page's own documented phrasing "can I talk
// to Zadiana?").
// stripSwitchPadding: shared — see voice-commands.js

// extractSwitchTarget: shared — see voice-commands.js

// ── Deep-think voice command (July 4 2026, Kade's reasoning-switch plan) ─────
// Phone turns run reasoning effort:'none' by default (reframe-proxy's
// [PHONE CALL marker branch). Saying "think hard" / "deep think on" flips a
// per-CALL mode: while on, every turn carries a fresh timestamped
// "[DEEP THINK <ms>]" marker, which reframe-proxy honors over the phone
// none-override (effort high for that turn). "Back to quick answers" turns
// it off. Command-only utterances get a one-line spoken confirm; a "think
// hard..." embedded in a real question flips the mode on SILENTLY and that
// same turn already runs deep.
function deepThinkCommandOf(text) {
  const t = stripSwitchPadding(text).replace(/[.!?]+$/, '').trim();
  const on = [
    /^(?:turn|switch|enable|start|activate|use)?\s*(?:on\s+)?deep\s*think(?:ing)?(?:\s*mode)?(?:\s+on)?$/i,
    /^(?:really\s+)?think\s+(?:hard(?:er)?|deeply|carefully)(?:\s+(?:about|on)\s+(?:this|that|it|things|everything))?(?:\s+from\s+now\s+on)?$/i,
    /^put\s+(?:on\s+)?your\s+thinking\s+cap(?:\s+on)?$/i,
    /^take\s+your\s+time\s+and\s+think$/i,
  ];
  const off = [
    /^(?:(?:turn|switch)\s+)?(?:off\s+deep\s*think(?:ing)?(?:\s*mode)?|deep\s*think(?:ing)?(?:\s*mode)?\s+off)$/i,
    /^(?:disable|stop|end|kill)\s+deep\s*think(?:ing)?(?:\s*mode)?$/i,
    /^(?:go\s+)?back\s+to\s+(?:quick|fast|normal)\s+(?:answers|replies|mode|thinking)$/i,
    /^quick\s+answers$/i,
    /^stop\s+thinking\s+so\s+hard$/i,
    /^no\s+more\s+deep\s+think(?:ing)?$/i,
  ];
  // "off" first: "deep thinking off" also matches the permissive ON pattern's
  // shape if checked first.
  for (const re of off) if (re.test(t)) return 'off';
  for (const re of on) if (re.test(t)) return 'on';
  return null;
}
// Embedded ask ("think hard about whether I should move") — mode on, no
// confirm, the question itself proceeds as the turn.
function mentionsDeepThink(text) {
  return /\b(?:think\s+(?:really\s+)?(?:hard|deeply|carefully)|deep\s*think(?:ing)?(?:\s+mode)?\s+on|put\s+(?:on\s+)?your\s+thinking\s+cap)\b/i.test(text || '');
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

// ── Single-word barge-in allow-list ────────────────────────────────────────────
// (July 16 2026, Kade: "I slide my finger over the mic and she stops like she
// thinks I'm about to talk"). looksLikeEcho above NEVER suppresses a single-word
// hit by design (a real "wait"/"stop" must always get through) -- but that also
// means a single word Deepgram mis-transcribes from mic-bump/scratch noise (a
// known ASR failure mode for non-speech transients) always passed through as a
// real interruption too. Now a lone recognized word only counts as a real
// barge-in if it's actually on this list; multi-word hits are untouched (they
// already go through the word-overlap echo check above, which is a much more
// reliable signal than length alone). Plain lowercase words, tune freely.
const BARGE_IN_SINGLE_WORDS = new Set([
  'wait', 'stop', 'hold', 'no', 'wow', 'actually', 'sorry', 'hey', 'wrong',
]);
function isPlausibleBargeIn(heard) {
  const words = normalizeWords(heard);
  if (words.length !== 1) return true; // 2+ words: the echo-overlap check above already covers this
  return BARGE_IN_SINGLE_WORDS.has(words[0]);
}

// ── SentenceStreamer ──────────────────────────────────────────────────────────
class SentenceStreamer extends EventEmitter {
  constructor() {
    super();
    this._buf = '';
    this._held = '';
    this._abbrevs = new Set([
      'dr','mr','mrs','ms','prof','vs','etc','e.g','i.e','a.m','p.m','st','ave',
      'jr','sr','no','vol','fig','dept','inc','ltd','corp',
    ]);
  }

  push(token) { this._buf += token; this._flush(false); }

  end() {
    this._flush(true);
    let rem = this._buf.trim();
    if (this._held) { rem = rem ? `${this._held} ${rem}` : this._held; this._held = ''; }
    if (rem.length > 2) this.emit('sentence', rem);
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
      // KADE July 4 2026 ("speech is still choppy... round, 1. You get to
      // choose"): a numbered LIST item's period is not a sentence break.
      // "\n  1. Getting caught at the buffet" used to split right after
      // "1." — every card in a hand became two tiny TTS clips with a
      // network-fetch gap between them. A number at line start (or buffer
      // start) followed by a period is a list marker; a number mid-line
      // ("the score is 21.") still ends a sentence normally.
      if (term === '.' && /(^|\n)[ \t]*\d{1,3}$/.test(this._buf.slice(0, abs))) { pos = abs + 1; continue; }
      const pre = this._buf.slice(0, abs).split(/\s+/).pop();
      if (term === '.' && this._isAbbrev(pre)) { pos = abs + 1; continue; }
      if (!next || /[\s.!?]/.test(next)) {
        let end = abs;
        while (end < this._buf.length && /[.!?]/.test(this._buf[end])) end++;
        let sentence = this._buf.slice(0, end).trim();
        // Short-fragment merging (same report): "Round one." as its own
        // synth = a stop-to-think pause mid-speech. Hold anything under
        // 24 chars and let it ride in the same breath as what follows.
        if (this._held) { sentence = `${this._held} ${sentence}`; this._held = ''; }
        if (sentence.length > 4) {
          if (sentence.length < 24 && !isFinal) this._held = sentence;
          else this.emit('sentence', sentence);
        } else if (sentence.length > 0 && !isFinal) {
          this._held = this._held ? `${this._held} ${sentence}` : sentence;
        }
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

// Pre-generate once at module load. REAL US ringback cadence (Kade's catch,
// July 3 2026): 2s of tone, 4s of silence. The old 1s-on/0.5s-off loop
// sounded like a fast "boop, boop" — nothing like an actual phone ringing.
const RING_ON  = makeToneBuf(2000, 440, 480, 0.45);
const RING_OFF = Buffer.alloc(32000, 0xFF); // 4s μ-law silence (8000 samples/s)

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
    // time latency), then (July 4 2026, outbound parity) an Inworld voice
    // matching the agent's NAME, then the platform default.
    const agentTts   = (cfg.getAgentTts && cfg.getAgentTts(this.agentId)) || null;
    const nameVoice  = (cfg.findVoice && cfg.findVoice(this.agentName)) || null;
    this.voice       = user?.voice || agentTts?.voiceId || nameVoice || cfg.defaultVoice;
    // Speaking rate (Kade 2026-07-01): null = proxy default. Adjusted live by
    // saying "speak faster" / "slow down" etc.; persisted per caller like voice.
    this.rate        = typeof user?.rate === 'number' ? user.rate
      : (typeof agentTts?.rate === 'number' ? agentTts.rate : null);
    this.history     = [];
    this.lcEmail     = user?.lcEmail || null;   // KADE Jul5: for Calls-history attribution
    this.startedAt   = new Date().toISOString(); // KADE Jul5: call start for duration
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
    // WEB VOICE (July 9 2026): transport format. 'mulaw' = Twilio 8k frames
    // (every existing phone path, byte-identical); 'wav' = browser client
    // (whole WAV clips over the socket, client schedules playback).
    this.media   = 'mulaw';
    this.surface = 'phone';
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
  armBargeRecovery(session);
}

// ── False-barge-in recovery (KADE July 3 2026 night, "she died mid-blackjack") ──
// Live failure: a barge-in fired during a blackjack reply (probably a table-
// sound clip or breath bleeding into the mic — Deepgram produced an interim
// but never a FINAL), playback was killed, and since no utterance ever
// arrived, no new turn started. Dead air until Kade gave up and hung up.
// Net: if a barge-in is not followed by real words within a few seconds,
// the agent speaks up instead of waiting forever. If the caller IS mid-
// sentence (finalBuf accumulating), re-check later rather than talk over her.
const BARGE_RECOVERY_MS = parseInt(process.env.PHONE_BARGE_RECOVERY_MS || '6000', 10);
const BARGE_RECOVERY_LINES = [
  'Sorry -- go ahead. I\'m listening.',
  'You cut out on me -- what was that?',
  'I stopped for you -- go ahead.',
];
function armBargeRecovery(session) {
  if (BARGE_RECOVERY_MS <= 0) return;
  if (session._bargeRecoveryTimer) clearTimeout(session._bargeRecoveryTimer);
  const armedAt = Date.now();
  session._bargeAt = armedAt;
  const check = () => {
    session._bargeRecoveryTimer = null;
    if (session.ws.readyState !== WebSocket.OPEN) return;
    // A real utterance landed (handleUtterance clears the timer, but belt+
    // suspenders) or a new turn is running/speaking: nothing to recover.
    if (session.busy || session.isSpeaking) return;
    if ((session._lastUtteranceAt || 0) >= armedAt) return;
    if (session.finalBuf || session._fluxTurnText || session._fluxCarry) {
      // She IS talking, the final/turn just hasn't closed yet -- check again.
      // (_fluxTurnText is the Flux engine's mid-turn signal; finalBuf is nova's.)
      session._bargeRecoveryTimer = setTimeout(check, 3000);
      return;
    }
    console.log('[voice-stream] barge-in got no follow-up utterance -- recovering');
    const line = BARGE_RECOVERY_LINES[Math.floor(Math.random() * BARGE_RECOVERY_LINES.length)];
    speak(session, line, session.voice).catch(() => {});
  };
  session._bargeRecoveryTimer = setTimeout(check, BARGE_RECOVERY_MS);
}

// ── Deepgram STT ──────────────────────────────────────────────────────────────
// ── Keyterm prompting (Deepgram nova-3 + Flux, GA feature; wired 2026-07-20) ──
// Biases STT toward the family's OWN proper nouns -- the companion names a
// generic model routinely mangles (Kiana -> "Kiona", Deuce -> "juice",
// Zadiana -> anything). Verified live 2026-07-20 that BOTH the v1 (nova-3) and
// v2 (flux) listen endpoints accept `keyterm` as a repeated query param
// without rejecting the socket. Deepgram requires ONE `keyterm` param per term
// (commas/semicolons are invalid); URLSearchParams.append encodes each. Tunable
// WITHOUT a deploy, matching this file's whole env-hatch philosophy:
//   STT_KEYTERMS unset            -> the baked flagship-name defaults below
//   STT_KEYTERMS="Ana,Bo,Cy"      -> exactly those (add family FIRST names here)
//   STT_KEYTERMS="off"/"none"/""  -> disabled entirely
// keyterm only *biases word choice* -- it cannot disconnect or silence STT, so
// the blast radius is transcription accuracy, which is the thing being fixed.
// Capped well under Deepgram's 500-token limit. (keyterm is a nova-3/Flux
// feature; nova-2 uses the older `keywords` param, so an env step-back to
// nova-2 would just have Deepgram ignore these -- harmless.)
const DEFAULT_KEYTERMS = ['Kiana', 'Zadiana', 'Deuce', 'Torch', 'Forge', 'Rio', 'Lux', 'Indie', 'Lilly', 'Scout', 'Kade-AI'];
function keytermList() {
  const raw = process.env.STT_KEYTERMS;
  if (raw === undefined) return DEFAULT_KEYTERMS;
  const trimmed = raw.trim();
  if (trimmed === '' || /^(off|none)$/i.test(trimmed)) return [];
  return trimmed.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 100);
}
function appendKeyterms(params, extraTerms) {
  for (const term of keytermList()) params.append('keyterm', term);
  for (const term of extraTerms || []) {
    const t = String(term || '').trim();
    if (t) params.append('keyterm', t);
  }
}

/** Just the `term` half of a session's dictionary, for Deepgram keyterms. */
function sessionKeyterms(session) {
  return (session && session.pronunciationDictionary || [])
    .map((e) => e && e.term)
    .filter(Boolean);
}

// ── Per-user pronunciation dictionary (Kade, July 20 2026: "what if
// everyone had a dictionary they can put their own names in") ──────────────
// Two-tier cache, same shape as agentTtsCache elsewhere in this file: a
// SYNCHRONOUS in-memory read (pronunciationCache) so STT socket-open below
// -- which cannot await a network fetch without adding latency to every
// single call, phone or web -- gets whatever's already warm, plus a
// fire-and-forget refresh that both updates the cache for NEXT time and
// upgrades the CURRENT session's copy the moment it lands (so TTS
// respelling on a later turn this same call still benefits, exactly like
// callerMemories a few lines above each call site below). Net effect: a
// caller's first-ever call gets STT keyterms from the STT_KEYTERMS globals
// only (cache miss) with TTS respelling attaching mid-call once the fetch
// resolves; their second call onward gets personalized keyterms from the
// start too, since the cache is already warm.
const pronunciationCache = new Map(); // identity key -> entries[]

function pronunciationCacheKey({ userId, email, phone } = {}) {
  if (userId) return `u:${userId}`;
  if (email) return `e:${String(email).toLowerCase()}`;
  if (phone) {
    const last10 = String(phone).replace(/\D/g, '').slice(-10);
    if (last10.length === 10) return `p:${last10}`;
  }
  return null;
}

function getCachedDictionary(identity) {
  const key = pronunciationCacheKey(identity);
  return (key && pronunciationCache.get(key)) || [];
}

function refreshPronunciationDictionary(session, identity, cfg) {
  if (!cfg || !cfg.fetchPronunciationDictionary) return;
  const key = pronunciationCacheKey(identity);
  if (!key) return;
  cfg.fetchPronunciationDictionary(identity)
    .then((entries) => {
      if (entries && entries.length) {
        pronunciationCache.set(key, entries);
        if (session) session.pronunciationDictionary = entries;
      }
    })
    .catch(() => {});
}

function openDeepgramFlux(session, key) {
  const web = session.media === 'wav';
  const params = new URLSearchParams({
    model: process.env.FLUX_STT_MODEL || 'flux-general-en',
    encoding: web ? 'linear16' : 'mulaw',
    sample_rate: web ? '16000' : '8000',
    // KADE July 12 2026 ('wait and listen a second so stoners can swallow
    // spit'): a notch more end-of-turn patience at the model level too.
    eot_threshold: process.env.FLUX_EOT_THRESHOLD || '0.85',
  });
  appendKeyterms(params, sessionKeyterms(session));   // family + this caller's own names
  const dg = new WebSocket(
    `wss://api.deepgram.com/v2/listen?${params}`,
    { headers: { Authorization: `Token ${key}` } }
  );
  dg.on('open', () => console.log(`[voice-stream] Deepgram FLUX open ${session.streamSid} (${web ? 'web/linear16-16k' : 'phone/mulaw-8k'})`));

  session._fluxTurnText = '';

  dg.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== 'TurnInfo') return;

    const text = String(msg.transcript || '').trim();

    if (msg.event === 'StartOfTurn') {
      // Deliberately NOT barging on StartOfTurn alone: on speakerphone her own
      // voice opens turns too. Same posture as the old SpeechStarted skip —
      // words first, then the content-based echo gate decides.
      session._fluxTurnText = '';
      // KADE July 22 2026 (speed bug): an aged-out carry dispatches NOW
      // instead of waiting on whatever just opened this turn -- see the
      // EndOfTurn deadline comment.
      const maxHold = parseInt(process.env.FLUX_CARRY_MAX_MS || '2500', 10);
      if (session._fluxCarry && session._fluxCarryAt && Date.now() - session._fluxCarryAt >= maxHold && session._fluxDispatch) {
        console.log(`[timing ${session.streamSid}] flux carry aged out at StartOfTurn -- dispatching held thought`);
        session._fluxDispatch();
        return;
      }
      // Grace window: they started talking again — hold the carried text and
      // wait for this new turn to finish (the two get stitched together).
      if (session._fluxGraceTimer) { clearTimeout(session._fluxGraceTimer); session._fluxGraceTimer = null; }
      return;
    }

    if (msg.event === 'Update' || msg.event === 'TurnResumed' || msg.event === 'EagerEndOfTurn') {
      if (text) session._fluxTurnText = text;
      // Real words while a grace timer runs = they kept going; wait for the
      // new EndOfTurn instead of firing the held one.
      if (text && session._fluxGraceTimer) { clearTimeout(session._fluxGraceTimer); session._fluxGraceTimer = null; }
      if (!text) return;
      // Barge-in: identical guards to the nova path (grace window + echo gate
      // + once-per-reply flag). All the July 1-4 lessons live in these checks.
      const graceOk = Date.now() - session.speakStartedAt > 1000;
      if (session.isSpeaking && !session.bargedIn && graceOk) {
        if (!looksLikeEcho(text, session._currentSpokenText) && isPlausibleBargeIn(text)) {
          session.bargedIn = true;
          console.log(`[voice-stream] barge-in trigger (flux): "${text.slice(0, 50)}"`);
          bargeIn(session);
        }
      }
      return;
    }

    if (msg.event === 'EndOfTurn') {
      const turnText = (text || session._fluxTurnText || '').trim();
      session._fluxTurnText = '';
      if (!turnText && !session._fluxCarry) return;
      // KADE July 12 2026 ("wait and listen a second so stoners can swallow
      // spit"): don't grab the mic the instant Flux calls end-of-turn. Hold
      // the utterance for a grace beat; if they start talking again inside
      // it (StartOfTurn/Update below), cancel and STITCH the turns together
      // so the model hears one complete thought. Env FLUX_POST_TURN_GRACE_MS
      // (default 900, 0 = old instant behavior).
      const carry = session._fluxCarry ? session._fluxCarry + ' ' : '';
      const full = (carry + turnText).trim();
      if (!full) return;
      const dispatch = () => {
        // KADE July 22 2026 (the speed bug, from her own test call's logs):
        // receipts show how long the finished thought sat held.
        const heldMs = session._fluxCarryAt ? Date.now() - session._fluxCarryAt : 0;
        if (heldMs > 0) console.log(`[timing ${session.streamSid}] flux dispatch after ${heldMs}ms total hold`);
        // Session 22: stamp the moment the thought left STT-land, so the
        // turn-start receipt downstream can print a REAL number (the old
        // one read _bufStartedAt, a CLASSIC-path stamp flux never sets --
        // which is why production logs said "+?ms". Receipts that print
        // question marks answer no questions.)
        session._dispatchAt = Date.now();
        if (session._fluxCapTimer) { clearTimeout(session._fluxCapTimer); session._fluxCapTimer = null; }
        session._fluxCarryAt = null;
        session._fluxDispatch = null;
        session._fluxCarry = null;
        session._fluxGraceTimer = null;
        const sinceSpoke = Date.now() - session.lastSpokAt;
        const echoPossible = session.isSpeaking || sinceSpoke < 3000;
        const echoWindow = session.isSpeaking || sinceSpoke < 1200;
        const isEcho = echoPossible && looksLikeEcho(full, session._currentSpokenText, echoWindow ? 0.35 : 0.6);
        if (!isEcho) handleUtterance(session, full);
        else console.log(`[voice-stream] echo-dropped (flux EndOfTurn): "${full.slice(0, 60)}"`);
      };
      const grace = parseInt(process.env.FLUX_POST_TURN_GRACE_MS || '900', 10);
      if (grace > 0) {
        // KADE July 22 2026 — THE SPEED BUG. The 900ms stitch-grace was
        // UNBOUNDED: any noise that opened a turn (speakerphone, the
        // agent's own echo, a breath) canceled this timer, and the held
        // thought waited for the NEXT EndOfTurn -- which re-armed another
        // 900ms, and so on. Quiet room = 0.9s fixed cost; noisy room =
        // "upwards of ten seconds sometimes," her exact report. The stitch
        // stays (real mid-thought resumes still merge), but a finished
        // thought now has a HARD deadline: FLUX_CARRY_MAX_MS (default
        // 2500) after it FIRST completed, it dispatches no matter what.
        session._fluxCarry = full;
        if (!session._fluxCarryAt) session._fluxCarryAt = Date.now();
        session._fluxDispatch = dispatch;
        const maxHold = parseInt(process.env.FLUX_CARRY_MAX_MS || '2500', 10);
        // Session 22, the RESIDUAL from a235e60, caught by a real receipt
        // (an 11421ms hold on Amber's noisy Spotter call, cap message
        // attached): the commit message promised "dispatch at cap from
        // timer OR StartOfTurn" -- but no cap timer ever existed. The only
        // timer was the 900ms grace, which any Update-with-text CANCELS
        // without re-arming, so on a noisy line a finished thought waited
        // for the NEXT EndOfTurn/StartOfTurn EVENT to notice the cap had
        // long passed. This deadline timer is that missing half: armed
        // once at first completion, canceled only by dispatch itself,
        // never by noise. Everything it fires through already existed.
        if (!session._fluxCapTimer) {
          const remain = Math.max(0, maxHold - (Date.now() - session._fluxCarryAt));
          session._fluxCapTimer = setTimeout(() => {
            session._fluxCapTimer = null;
            if (session._fluxCarry && session._fluxDispatch) {
              console.log(`[timing ${session.streamSid}] flux carry hit the ${maxHold}ms cap (deadline timer) -- dispatching now`);
              session._fluxDispatch();
            }
          }, remain);
        }
        if (Date.now() - session._fluxCarryAt >= maxHold) {
          console.log(`[timing ${session.streamSid}] flux carry hit the ${maxHold}ms cap -- dispatching now`);
          dispatch();
        } else {
          if (session._fluxGraceTimer) clearTimeout(session._fluxGraceTimer);
          session._fluxGraceTimer = setTimeout(dispatch, grace);
        }
      } else {
        dispatch();
      }
      return;
    }
  });

  dg.on('error', (e) => console.error('[voice-stream] Deepgram FLUX error:', e.message));
  dg.on('close', (code) => {
    if (session._fluxGraceTimer) { clearTimeout(session._fluxGraceTimer); session._fluxGraceTimer = null; }
    if (session._fluxCapTimer) { clearTimeout(session._fluxCapTimer); session._fluxCapTimer = null; }
    console.log(`[voice-stream] Deepgram FLUX closed ${session.streamSid} (${code})`);
  });
  return dg;
}

function openDeepgram(session) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) { console.warn('[voice-stream] DEEPGRAM_API_KEY not set — no STT'); return null; }

  // ── FLUX (July 12 2026 late, Kade: "switch to Deepgram Flux now for sure") ──
  // Deepgram's conversational model (listen v2): the model itself decides when
  // a TURN is over (StartOfTurn/Update/EndOfTurn events) instead of our
  // endpointing+utterance_end guesswork. Same Nova-3 transcription quality.
  // ENV STEP-BACK WITHOUT DEPLOY: PHONE_STT_ENGINE=nova / WEB_VOICE_STT_ENGINE=nova
  // returns that surface to the exact prior nova-3 path (which still honors
  // PHONE_STT_MODEL/WEB_VOICE_STT_MODEL). FLUX_EOT_THRESHOLD tunes end-of-turn
  // confidence (0.5-0.9, default 0.8).
  {
    const webSurface = session.media === 'wav';
    const engine = webSurface
      ? (process.env.WEB_VOICE_STT_ENGINE || 'flux')
      : (process.env.PHONE_STT_ENGINE || 'flux');
    if (engine === 'flux') return openDeepgramFlux(session, key);
  }

  // WEB VOICE (July 9 2026): browser mic arrives as linear16 @ 16kHz (the
  // client downsamples); phone stays mulaw 8k + the phonecall model. Same
  // endpointing/utterance tuning on both — those lessons were transport-
  // agnostic (they're about how PEOPLE pause, not about codecs).
  const web = session.media === 'wav';
  const params = new URLSearchParams({
    encoding: web ? 'linear16' : 'mulaw',
    sample_rate: web ? '16000' : '8000',
    channels: '1',
    // July 12 2026 (Kade: "flip it, I always wanna be on the latest"):
    // nova-3 — better on noisy rooms + fast kid speech. Env hatches to step
    // back without a deploy if anything sounds off.
    model: web ? (process.env.WEB_VOICE_STT_MODEL || 'nova-3') : (process.env.PHONE_STT_MODEL || 'nova-3'),
    smart_format: 'true', interim_results: 'true',
    utterance_end_ms: '1000', endpointing: '500', vad_events: 'true', // 350->500ms July 1: 350 finalized on natural mid-sentence breaths (cut Kade off); +150ms per turn is the cost
  });
  appendKeyterms(params, sessionKeyterms(session));   // family + this caller's own names

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
        } else if (!isPlausibleBargeIn(text)) {
          // Single recognized word that isn't a real interruption word -- most
          // likely mic-bump/scratch noise Deepgram mis-transcribed as one short
          // word, not an actual attempt to talk. Keep listening.
        } else {
          session.bargedIn = true;
          console.log(`[voice-stream] barge-in trigger: "${text.slice(0, 50)}" (final=${!!msg.is_final})`);
          bargeIn(session);
        }
      }
      if (msg.is_final) {
        // KADE July 22 2026 (speed-bug instrumentation): stamp the FIRST
        // is_final of this buffer -- [timing] lines below decompose her
        // reported speaking->beep gap into STT-finalize vs turn-fire.
        if (!session.finalBuf) session._bufStartedAt = Date.now();
        session.finalBuf += (session.finalBuf ? ' ' : '') + text;
      }
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
        // KADE July 3 2026 (the "call went dead" bug): echo is PHYSICALLY
        // IMPOSSIBLE once the speaker has been silent a few seconds, but this
        // check used to run forever -- "I'm testing the line", spoken ~10s
        // after playback ended, overlapped Kiana's last (testing-themed)
        // sentence 4/4 words and was silently eaten TWICE; the call looked
        // dead and ended. Outside a hard 3s window, NOTHING is echo.
        const sinceSpoke = Date.now() - session.lastSpokAt;
        const echoPossible = session.isSpeaking || sinceSpoke < 3000;
        const echoWindow = session.isSpeaking || sinceSpoke < 1200;
        const isEcho = echoPossible && looksLikeEcho(utterance, session._currentSpokenText, echoWindow ? 0.35 : 0.6);
        console.log(`[timing] speech_final +${session._bufStartedAt ? Date.now() - session._bufStartedAt : '?'}ms after first is_final (sinceSpoke=${sinceSpoke}ms speaking=${!!session.isSpeaking})`);
        if (!isEcho) handleUtterance(session, utterance);
        else console.log(`[voice-stream] echo-dropped (overlap, sinceSpoke=${sinceSpoke}ms): "${utterance.slice(0, 60)}"`);
      }
      return;
    }

    if (msg.type === 'UtteranceEnd' && session.finalBuf) {
      const utterance = session.finalBuf.trim();
      session.finalBuf = '';
      const sinceSpoke = Date.now() - session.lastSpokAt;
      const echoPossible = session.isSpeaking || sinceSpoke < 3000; // see speech_final note
      const echoWindow = session.isSpeaking || sinceSpoke < 1200;
      const isEcho = echoPossible && looksLikeEcho(utterance, session._currentSpokenText, echoWindow ? 0.35 : 0.6);
      console.log(`[timing] UtteranceEnd +${session._bufStartedAt ? Date.now() - session._bufStartedAt : '?'}ms after first is_final (sinceSpoke=${sinceSpoke}ms) -- speech_final never came`);
      if (!isEcho) handleUtterance(session, utterance);
      else console.log(`[voice-stream] echo-dropped (UtteranceEnd, sinceSpoke=${sinceSpoke}ms): "${utterance.slice(0, 60)}"`);
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

// ── Spoken registration flow (July 21 2026) ─────────────────────────────────
// A deterministic, LLM-free state machine for signing up by voice — the LLM
// never sees or invents any part of it. Steps: confirmStart -> askName (only
// for callers the registry doesn't know) -> askEmail -> confirmEmail (read
// back SPELLED) -> offerPassword (a friendly password is generated and
// OFFERED first -- okay keeps it, another re-rolls, saying one of your own
// still works and goes through confirmPassword's spelled read-back) ->
// creating. Cancel words exit cleanly at any step; 3 failed attempts on
// one step exits gracefully. Design + receipts:
// PHONE_REGISTRATION_REBUILD_2026-07-21.md in the project folder.
/// Picks (or re-picks) a friendly password and offers it. The words are
/// spoken naturally ("maple creek 42") — the final success line spells the
/// whole thing character by character once, so the exact spelling is heard
/// exactly when it matters and the offer stays short.
async function offerPassword(session, mode) {
  const reg = session.reg;
  const p = friendlyPasswordParts();
  reg.password = p.joined;
  reg.passwordParts = p;
  reg.step = 'offerPassword';
  const spokenPwd = `${p.a} ${p.b} ${p.n}`;
  if (mode === 'first') {
    await speak(session, `Last thing — a password. I picked one for you: ${spokenPwd} — all one word, all lowercase. Say okay to keep it, another for a different one, or just say a password you'd rather have.`, session.voice);
  } else {
    await speak(session, `How about: ${spokenPwd} — all one word, all lowercase. Okay, another, or say your own.`, session.voice);
  }
}

async function handleRegistrationTurn(session, text) {
  const reg = session.reg;
  const t = String(text || '').trim();
  if (REG_CANCEL_RE.test(t)) { session.reg = null; await speak(session, 'No problem — cancelled. What else is on your mind?', session.voice); return; }
  const strike = async (msg) => {
    reg.attempts++;
    if (reg.attempts >= 3) { session.reg = null; await speak(session, "No worries — we can try again another time, or Kade can set you up on the website. Let's just talk.", session.voice); }
    else await speak(session, msg, session.voice);
  };
  switch (reg.step) {
    case 'confirmStart':
      if (/\balready\b/i.test(t) && !REG_YES_RE.test(t)) {
        session.reg = null;
        await speak(session, "You might — if you signed up on the website, your phone just isn't linked to it yet. You can link it yourself: say sign me up, then give the SAME email and password you use on the website. Or ask Kade to link it. Want to keep chatting instead? Go ahead.", session.voice);
        return;
      }
      if (REG_YES_RE.test(t)) {
        reg.attempts = 0;
        if (reg.name) { reg.step = 'askEmail'; await speak(session, `Alright ${reg.name}! What's your email address? Say it like: john at gmail dot com. You can spell it out letter by letter — numbers are fine too.`, session.voice); }
        else { reg.step = 'askName'; await speak(session, "Let's do it. First — what's your name?", session.voice); }
      } else if (REG_NO_RE.test(t)) { session.reg = null; await speak(session, 'All good. What else is up?', session.voice); }
      else await strike('Just say yes to set up your account, or no to skip.');
      return;
    case 'askName': {
      const name = t.replace(/^(?:my name is|i'm|i am|it's|its|this is)\s+/i, '').replace(/[.,!?]+$/g, '').trim();
      if (!name || name.split(/\s+/).length > 4) { await strike("I didn't catch that — just tell me your first name."); return; }
      reg.name = name.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      reg.step = 'askEmail'; reg.attempts = 0;
      await speak(session, `Nice to meet you, ${reg.name}! What's your email address? Say it like: john at gmail dot com. Spelling it out letter by letter works too.`, session.voice);
      return;
    }
    case 'askEmail': {
      const email = parseSpokenEmailV2(t);
      if (!email) { await strike("I couldn't make an email out of that. Try again slow — like: m, i, s, s, at gmail dot com. Or say cancel."); return; }
      reg.email = email; reg.step = 'confirmEmail'; reg.attempts = 0;
      await speak(session, `Let me read that back: ${spellOutEmail(email)}. Did I get it right — yes or no?`, session.voice);
      return;
    }
    case 'confirmEmail':
      if (REG_YES_RE.test(t)) { reg.attempts = 0; await offerPassword(session, 'first'); }
      else if (REG_NO_RE.test(t)) { reg.step = 'askEmail'; await speak(session, 'Okay, scratch that. Say your email again, nice and slow.', session.voice); }
      else await strike('Yes if I got the email right, no to try again.');
      return;
    case 'offerPassword': {
      // Generated-first (Kade's call, July 21: "Seems complex to make them
      // say a password"). A friendly password is already picked and spoken;
      // okay keeps it, another/no re-rolls, PICK re-rolls too, and anything
      // long enough to BE a password is treated as them saying their own.
      if (REG_ANOTHER_RE.test(t) || REG_PICK_RE.test(t) || REG_NO_RE.test(t)) { await offerPassword(session, 'again'); return; }
      if (REG_OK_RE.test(t) || REG_YES_RE.test(t)) { reg.step = 'creating'; await finishRegistration(session); return; }
      const own = parseSpokenPassword(t);
      if (own) {
        reg.password = own; reg.passwordParts = null; reg.step = 'confirmPassword'; reg.attempts = 0;
        await speak(session, `Your password would be: ${own.split('').join(', ')}. All lowercase, no spaces. Good — yes or no?`, session.voice);
        return;
      }
      await strike(`Say okay to keep ${reg.password}, say another for a new one, or say your own password — at least 8 characters.`);
      return;
    }
    case 'confirmPassword':
      if (REG_YES_RE.test(t)) { reg.step = 'creating'; await finishRegistration(session); }
      else if (REG_NO_RE.test(t)) { await offerPassword(session, 'again'); }
      else await strike('Yes to lock that password in, no to pick a different one.');
      return;
    default: session.reg = null; return;
  }
}

async function finishRegistration(session) {
  const reg = session.reg;
  const res = await session.cfg.createAccount({
    name: reg.name || session.callerName || 'Friend',
    email: reg.email, password: reg.password, child: !!session.childCaller,
  });
  session.reg = null;
  if (res && res.ok) {
    try { session.cfg.linkAccount(session.from, reg.email, reg.password, reg.name); } catch (e) { console.error('[reg] link failed:', e.message); }
    session.lcEmail = reg.email; // same-call attribution where the pipeline reads it
    const spelledPwd = reg.password.split('').join(', ');
    await speak(session, `You're all set${reg.name ? ', ' + reg.name : ''}! Your account is live at kademurdock dot com. Your password, spelled out: ${spelledPwd} — all lowercase, one word. You can change it on the website anytime. From your next call on, I'll know you by your own account. Now — where were we?`, session.voice);
  } else if (res && res.exists) {
    await speak(session, `Looks like ${spellOutEmail(reg.email)} already has an account. If that's yours, you're already good on the website — let's just keep talking.`, session.voice);
  } else if (res && res.passcode) {
    await speak(session, "Hm — signups are code-locked right now and my code isn't working. Kade will fix that; let's keep chatting and try later.", session.voice);
  } else {
    await speak(session, 'Something went wrong on my end setting that up. Not your fault — Kade will check the logs. We can still talk!', session.voice);
  }
}

async function handleUtterance(session, text) {
  text = text.trim();
  if (!text || text.length < 2) return;
  // LIVE MODE GATE: while the Gemini Live session is on, IT owns the
  // conversation (it hears the same mic audio directly). The normal
  // Deepgram→LLM→Inworld turn pipeline stays parked, except for the spoken
  // escape hatch promised in the first-use notice ("say live off").
  if (session.liveOn) {
    // July 18 2026 (Kade: "spotters should have memory too"): what the caller
    // says while the Spotter has the call still lands in session.history, so
    // the post-call transcript ingest + memory writer see it — telling the
    // Spotter "that cat is Kasper" is remembered exactly like telling the
    // character. (The Spotter's own replies are audio-only; the caller's words
    // are where the durable facts live.)
    try { session.history.push({ role: 'user', content: text }); } catch {}
    if (/\b(?:live\s*(?:mode\s*)?(?:off|stop|end|quit|done)|(?:stop|end|turn\s+off|kill)\s+live(?:\s+mode)?)\b/i.test(text)) {
      try { videoLive.stopLive(session, 'voice-off'); } catch {}
    }
    return;
  }
  // SPOTTER voice invocation (July 16 2026): "get/talk to/call my Spotter" —
  // or their custom name — hands the call to the live lane, same path as the
  // client's radio button. First use still walks through the spoken cost
  // notice; the caller confirms BY VOICE (below) or with the on-screen button.
  if (session._awaitLiveConfirm && session.media === 'wav') {
    session._awaitLiveConfirm = false;
    if (/\b(?:yes|yeah|yep|sure|confirm|do it|go ahead|start it|okay|ok)\b/i.test(text) && text.length < 60) {
      try { videoLive.handleLiveMsg(session, { on: true, ack: true }, speak); } catch {}
      return;
    }
    // Anything else falls through as a normal turn — treat it as "not now."
  }
  if (session.media === 'wav') { // WEB calls only — the live lane's audio path is browser-shaped, never Twilio's
    // effectiveSpotter always has a name (Scout, the starter, when the
    // account never built one) — so "get Scout" works for everybody.
    const spotEsc = videoLive.effectiveSpotter(session).name.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
    const liveAsk = new RegExp(
      `\\b(?:talk to|get|call|put on|bring(?: on)?|switch(?: me)? to)\\s+(?:my\\s+)?(?:spotter|${spotEsc})\\b`,
      'i',
    );
    if (liveAsk.test(text)) {
      session._awaitLiveConfirm = true; // harmless if the lane starts immediately (already acked)
      try { videoLive.handleLiveMsg(session, { on: true }, speak); } catch {}
      return;
    }
  }
  // July 12 2026: voicemail mode — the "person" is a recording. No turns,
  // no thinking sounds; handleAmdResult speaks one message and hangs up.
  if (session.voicemailMode) return;
  session._lastUtteranceAt = Date.now();
  if (session._bargeRecoveryTimer) { clearTimeout(session._bargeRecoveryTimer); session._bargeRecoveryTimer = null; }
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
  // WEB VOICE: live caption of what was heard + a 'thinking' state so the
  // client UI mirrors the turn. Both are undefined on phone sessions.
  if (session.sendCaption) session.sendCaption('user', text);
  if (session.sendState) session.sendState('thinking');
  session._turnT0 = Date.now();
  // Session 22: measure from the flux dispatch stamp (the classic-path
  // _bufStartedAt never exists on flux -- production printed "+?ms").
  {
    const t0 = session._dispatchAt || session._bufStartedAt;
    console.log(`[timing ${session.streamSid}] turn-start +${t0 ? session._turnT0 - t0 : 0}ms after dispatch (state 'thinking' sent = her thinking sound starts NOW)`);
  }
  session._bufStartedAt = null;
  session._dispatchAt = null;
  session.busy = true;
  try {
    // ── Spoken registration (July 21 2026) — deterministic, never the LLM. ──
    // Phone lane only (media !== 'wav'): web callers are signed in by
    // construction, and the registry gate below is keyed by phone number.
    // Placed BEFORE every other spoken command so a mid-registration "switch
    // to voice two" is treated as registration input, and the cancel words
    // are the one documented exit. See PHONE_REGISTRATION_REBUILD doc.
    if (session.reg) { await handleRegistrationTurn(session, text); return; }
    if (session.media !== 'wav' && REG_INTENT_RE.test(text)
        && session.cfg && session.cfg.hasAccount && session.cfg.createAccount) {
      if (session.cfg.hasAccount(session.from)) {
        await speak(session, "You're already set up with your own account — you're good.", session.voice);
      } else {
        session.reg = { step: 'confirmStart', attempts: 0, name: session.callerName || null };
        await speak(session, 'Want me to set up your own kademurdock account right here on the call? Say yes to start, or no to skip.', session.voice);
      }
      return;
    }
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
    // July 12 2026 (Kade: "unable to identify which voice is being used"):
    // spoken identify command — answers instantly, no LLM turn.
    if (VOICE_IDENTIFY_REGEX.test(text.trim())) {
      await speak(session, `I'm speaking as ${session.voice} right now. Say switch to voice, and a number, any time.`, session.voice);
      return;
    }
    const newVoice = extractVoiceSwitch(text);
    if (newVoice) {
      const prevVoice = session.voice;
      session.voice = newVoice;
      session.spokenVoiceChoice = true; // explicit — nothing may stomp it this call
      try {
        // The confirmation speaks IN the new voice — instant audible proof,
        // and it doubles as validation: an unknown voice number fails synth,
        // so we revert instead of leaving the call voiceless.
        await speak(session, `Switching to ${newVoice}'s voice! Go ahead.`, newVoice);
      } catch (e) {
        console.warn(`[voice-stream] voice switch to "${newVoice}" failed synth — reverting: ${e.message}`);
        session.voice = prevVoice;
        session.spokenVoiceChoice = false;
        await speak(session, `Hmm, I don't seem to have ${newVoice}. The app's voice picker lists everything I've got. Go ahead.`, prevVoice).catch(() => {});
        return;
      }
      const u = session.cfg.users.get(session.from);
      if (u) { u.voice = newVoice; session.cfg.saveUsers(); }
      // July 12 2026: a spoken pick is a REAL preference — save it to the
      // fork per (account, current agent) so the app + web calls follow suit.
      if (session.cfg.ingestVoicePref) {
        session.cfg.ingestVoicePref(
          { email: session.lcEmail || (u && u.lcEmail), phone: session.from },
          session.agentId,
          newVoice,
        );
      }
      return;
    }
    const agents = await session.cfg.getAgents();
    const applySwitch = async (agent) => {
      session.agentId   = agent.id;
      session.agentName = agent.name;
      session.history   = [];
      const u = session.cfg.users.get(session.from);
      if (u) { u.agentId = agent.id; u.agentName = agent.name; session.cfg.saveUsers(); }
      // KADE July 3 2026 bug report: the VOICE must follow the agent. This
      // used to keep the OLD agent's voice until hang-up-and-call-back
      // (Zadiana -> Kiana switch kept speaking in Zadiana's voice).
      //
      // KADE July 4 2026 ("agents STILL don't switch voices"): the July 3 fix
      // raced the live lookup against a 4s timer -- but the librechat proxy
      // paces its LibreChat calls 4s apart (LIBRECHAT_MIN_GAP_MS), and the
      // getAgents() list fetch earlier in THIS SAME TURN often burns a call,
      // so the lookup queued behind a 4s gap and could never win. Live-caught
      // 16:51 July 4: Zadiana's Voice 14 lookup completed AFTER the race
      // timed out -- she spoke in Fucia. Now: kick the lookup off, cover the
      // wait with a spoken line in the OLD voice (its playback eats most of
      // the pacing gap), then allow 12s total. Also re-look-up when a cached
      // entry has NO voice and is stale (>10 min), and fall back to a voice
      // matching the agent's NAME before the default (outbound parity).
      let agentTts = (session.cfg.getAgentTts && session.cfg.getAgentTts(agent.id)) || null;
      const staleNoVoice = agentTts && !agentTts.voiceId
        && !(typeof agentTts.at === 'number' && Date.now() - agentTts.at < 10 * 60 * 1000);
      if ((!agentTts || staleNoVoice) && session.cfg.refreshAgentTts) {
        // The TTS cache only pre-warms agents someone has as a DEFAULT; a
        // mid-call switch target can miss.
        const lookup = session.cfg.refreshAgentTts(agent.id).catch(() => {});
        try { await speak(session, `One sec -- getting ${agent.name} on the line.`, session.voice); } catch {}
        try {
          await Promise.race([
            lookup,
            new Promise((r) => setTimeout(r, 12000)),
          ]);
        } catch {}
        agentTts = (session.cfg.getAgentTts && session.cfg.getAgentTts(agent.id)) || null;
      }
      const nameVoice = (session.cfg.findVoice && session.cfg.findVoice(agent.name)) || null;
      // July 12 2026: refresh the caller's memory cards for the NEW agent's
      // bucket (async; attaches when it lands).
      if (session.cfg.fetchCallMemories) {
        const su = session.cfg.users.get(session.from);
        session.cfg.fetchCallMemories({ email: session.lcEmail || (su && su.lcEmail), phone: session.from }, agent.id, { nudges: true })
          .then((text) => { if (session) session.callerMemories = text || null; })
          .catch(() => {});
      }
      // July 12 2026: their own pick for the NEW agent leads the chain.
      let prefVoice = null;
      if (session.cfg.lookupVoicePref && !session.spokenVoiceChoice) {
        prefVoice = await Promise.race([
          session.cfg.lookupVoicePref({ email: session.lcEmail || (u && u.lcEmail), phone: session.from }, agent.id),
          new Promise((r) => setTimeout(() => r(null), 1200)),
        ]).catch(() => null);
      }
      session.voice = prefVoice || (u && u.voice) || (agentTts && agentTts.voiceId) || nameVoice || session.cfg.defaultVoice;
      session.rate  = (u && typeof u.rate === 'number') ? u.rate
        : (agentTts && typeof agentTts.rate === 'number' ? agentTts.rate : null);
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
    const dtCmd = deepThinkCommandOf(text);
    if (dtCmd === 'on') {
      session.deepThink = true;
      await speak(session, "Okay — I'll really think things through from here on. Answers will take a little longer. Go ahead.", session.voice);
      return;
    }
    if (dtCmd === 'off') {
      session.deepThink = false;
      await speak(session, 'Okay — back to quick answers. Go ahead.', session.voice);
      return;
    }
    if (!session.deepThink && mentionsDeepThink(text)) {
      // e.g. "think hard about whether we should move" — run THIS and later
      // turns deep, no spoken confirm (the question is the turn).
      session.deepThink = true;
    }
    if (isBareSwitchRequest(stripSwitchPadding(text))) {
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

// ── Watch-and-alert turn (July 16 2026) ──────────────────────────────────────
// Delivers an automatic alert as a real character turn once the line is quiet.
// Mirrors handleUtterance's busy bookkeeping exactly (busy gate, pending
// drain) so a caller who starts talking mid-alert gets the normal barge-in /
// queue behavior -- the alert turn is interruptible like any other turn.
const WATCH_ALERT_MAX_WAIT_MS = parseInt(process.env.VIDEO_WATCH_ALERT_MAX_WAIT_MS || '60000', 10);
async function watchAlertTurn(session, alertText) {
  const started = Date.now();
  const attempt = async () => {
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) return; // call ended
    if (!session.videoOn) return; // video stopped while waiting -- alert is stale, drop it
    if (session.busy || session.isSpeaking) {
      if (Date.now() - started < WATCH_ALERT_MAX_WAIT_MS) {
        setTimeout(() => { attempt().catch(() => {}); }, 1200);
      } else {
        console.log('[voice-stream] watch alert dropped -- line never went quiet within the wait window');
      }
      return;
    }
    console.log(`[voice-stream] delivering watch alert on ${session.streamSid || session.callSid || 'web session'}`);
    session.busy = true;
    if (session.sendState) session.sendState('thinking');
    try {
      await streamReply(session, alertText);
    } catch (err) {
      console.error('[voice-stream] watch alert turn error:', err.message);
    } finally {
      session.busy = false;
      if (session._pending) {
        const next = session._pending;
        session._pending = null;
        handleUtterance(session, next);
      }
    }
  };
  await attempt();
}

// ── Stream LLM reply ──────────────────────────────────────────────────────────
// KADE July 2 2026 (round 5): bare acknowledgments that should NOT restart a
// turn that's still generating. Strictly short/pure — anything with real
// content still aborts and re-asks as before.
const BACKCHANNEL_RE = /^(?:(?:okay|ok|kay|yeah|yea|yes|yep|yup|mhm|mm-?hmm?|uh-?huh|right|sure|alright|all right|gotcha|i see|cool)[,.!?\s]*){1,3}$/i;

async function streamReply(session, userText) {
  if (GAME_START_RE.test(userText)) armGameMode(session, 'game request');
  session.history.push({ role: 'user', content: userText });
  while (session.history.length > 60) session.history.shift();
  // Deep-think mode: stamp THIS turn with a FRESH timestamped marker —
  // reframe-proxy only honors a fresh one (≤10 min), and it strips every
  // copy before the model sees it. Suffix-only, like PHONE_SUFFIX: the clean
  // text stays in session.history.
  const deepSuffix = session.deepThink ? ` [DEEP THINK ${Date.now()}]` : '';
  const gameSuffix = (typeof session.lastGameTokenAt === 'number'
    && Date.now() - session.lastGameTokenAt < GAME_ACTIVE_MS) ? GAME_SUFFIX : '';
  // LIVE CAMERA (web video calls): take a fresh look if the camera has a
  // newer frame than the last scene description — bounded, fail-soft.
  if (session.videoOn) { try { await videoSight.onTurn(session); } catch { /* a blind turn is still a turn */ } }
  const outgoing = session.history.map((m, i) =>
    (i === session.history.length - 1 && m.role === 'user')
      ? { ...m, content: m.content + PHONE_SUFFIX + gameSuffix + callerLine(session) + childLine(session) + memoryLine(session) + videoSight.visionLine(session) + (session.outboundSuffix || '') + deepSuffix }
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
  session._turnCapLogged = false;
  maybeStartThinkingFiller(session, fillerCtx).catch((e) =>
    console.error('[voice-stream] thinking-filler error:', e.message));

  // Tracks a leading %%%direction%%% tag across this one reply's sentences --
  // see applyDirectionCarry() above. Scoped to this streamReply() call so it
  // never bleeds into the next turn.
  const dirState = { active: null };

  let sentCount = 0;              // spoken sentences this turn (ramble hint)
  let rambleHintQueued = false;   // once per turn
  let spokenChars = 0;            // runaway-turn breaker (July 13 2026)
  let echoDropped = 0;

  // KADE July 13 2026 (her live report: "it's reading its coaching and
  // thoughts and memories" — one turn streamed ~9.7K chars of recited
  // context): DEFENSE IN DEPTH on the spoken stream.
  //  (a) any sentence carrying one of OUR injection-block fingerprints is
  //      never synthesized — those blocks are stage directions, not lines;
  //  (b) a hard per-turn spoken cap (env PHONE_TURN_SPOKEN_CAP chars,
  //      default 2800 ≈ over a minute of speech, 0 disables) stops a
  //      recitation spiral even when it carries no fingerprint. Normal
  //      turns are 2-3 sentences; only pathology hits this.
  const INJECTION_ECHO_RE = /\[PHONE CALL|\[WHAT YOU REMEMBER|\[WAITING FOR THIS CALLER|\[MISSION MATERIAL|\[AUDIENCE NOTE|\[The person on this call|\[DEEP THINK|<think|PRIVATE stage direction/i;
  // KADE July 12 2026: she WANTS five-minute-plus rambles — cap is a loose
  // pathology backstop only (10K chars ≈ 4-5 min of speech), not a leash.
  const TURN_SPOKEN_CAP = parseInt(process.env.PHONE_TURN_SPOKEN_CAP || '10000', 10);

  const processUnit = (sentence) => {
    if (session.llmAbort) return;
    if (INJECTION_ECHO_RE.test(sentence)) {
      echoDropped++;
      console.warn(`[voice-stream] INJECTION-ECHO suppressed (#${echoDropped}) for ${session.streamSid}: "${String(sentence).slice(0, 80)}"`);
      return;
    }
    if (TURN_SPOKEN_CAP > 0 && spokenChars >= TURN_SPOKEN_CAP) {
      if (!session._turnCapLogged) {
        session._turnCapLogged = true;
        console.warn(`[voice-stream] TURN CAP hit (${spokenChars}/${TURN_SPOKEN_CAP} chars) for ${session.streamSid} — muting the rest of this turn`);
      }
      return;
    }
    if (/\[END CALL\]/i.test(sentence)) {
      session.endCallRequested = true;
      sentence = sentence.replace(/\[END CALL\]/gi, '').trim();
    }
    // Game Parlor phase 3: pull [sound:x] cues out of the sentence. The cue
    // clips play IN the sentence chain (before this sentence's speech) so
    // card sounds land where the action happens; the token itself is never
    // sent to TTS. A sentence that was ONLY cue tokens still plays its
    // sounds — it just has nothing to say.
    // Game Parlor visuals (July 3 2026): [table:id] tokens are for the chat
    // client's table widget only — on the phone they must simply vanish.
    if (sentence.indexOf('[table:') !== -1) {
      armGameMode(session, 'table token');
      // WEB VOICE (July 9 2026): hand the table id to the client so the call
      // screen can draw the same aria-hidden GameTable widget chat gets. One
      // event per token = one refetch per move. Phone sessions have no
      // sendTable — token just vanishes, as before.
      if (session.sendTable) {
        const tblRe = /\[table:([a-z0-9]{1,12})\]/gi;
        let tm;
        while ((tm = tblRe.exec(sentence)) !== null) session.sendTable(tm[1].toLowerCase());
      }
      sentence = sentence.replace(/\[table:[a-z0-9]{1,12}\]/gi, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    }
    const gameCues = [];
    if (sentence.indexOf('[sound:') !== -1) {
      armGameMode(session, 'sound cue');
      GAME_SOUND_RE.lastIndex = 0;
      sentence = sentence
        .replace(GAME_SOUND_RE, (_m, c) => {
          if (gameCues.length < MAX_CUES_PER_SENTENCE) gameCues.push(c.toLowerCase());
          return ' ';
        })
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
    }
    // Watch-and-alert (July 16 2026): pull [watch: ...] / [watch off] tags out
    // of the sentence -- they arm/disarm the video watcher and are never spoken,
    // captioned, or sent to TTS (same treatment as [sound:] cues).
    if (/\[watch\b/i.test(sentence)) {
      let armCond = null;
      let watchOff = false;
      sentence = sentence
        .replace(/\[watch\s*:\s*([^\]]{1,160})\]/gi, (_m, c) => {
          const cond = String(c || '').trim();
          if (/^off$/i.test(cond)) watchOff = true;
          else if (cond) armCond = cond;
          return ' ';
        })
        .replace(/\[watch\s+off\]/gi, () => { watchOff = true; return ' '; })
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
      if (watchOff) { try { videoSight.disarmWatch(session, 'agent tag'); } catch { /* fail-soft */ } }
      if (armCond) { try { videoSight.armWatch(session, armCond); } catch { /* fail-soft */ } }
    }
    const hasSpeech = sentence.length >= 2;
    if (!hasSpeech && !gameCues.length) return; // token-only fragment, nothing to speak
    if (hasSpeech) spokenChars += sentence.length;
    const synthInput = hasSpeech ? applyDirectionCarry(sentence, dirState) : '';
    const synthPromise = hasSpeech
      ? synthesize(synthInput, session.voice, session.rate, session.media, session.pronunciationDictionary).catch((e) => {
          console.error('[voice-stream] synthesis prefetch error:', e.message);
          return null;
        })
      : Promise.resolve(null);
    const sentenceIndex = hasSpeech ? ++sentCount : sentCount;
    // Self-interrupt hint: the arrival of sentence N+1 proves the turn is
    // still going -- play the hint right before it. Prefetch now so the hint
    // never stalls the sentence pipeline.
    let ramblePromise = null;
    if (
      RAMBLE_HINT_AFTER > 0 &&
      sentenceIndex === RAMBLE_HINT_AFTER + 1 &&
      !rambleHintQueued &&
      !session._rambleHintPlayed && // KADE July 3: once per CALL -- it fired
                                    // every long turn (each blackjack deal!)
                                    // and drove her nuts; greeting covers it
      !session.outbound &&
      !session.endCallRequested
    ) {
      rambleHintQueued = true;
      session._rambleHintPlayed = true;
      ramblePromise = getRambleClip(session.voice, session.rate, session.media).catch((e) => {
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
      for (const cue of gameCues) {
        if (session.llmAbort) break;
        if (session.media !== 'mulaw') {
          // KADE July 9 2026 ("wire up the game stuff if you wanna"): web
          // calls now play the REAL game sound files — raw WAVs down the
          // same ordered chain as speech, gain-matched to the phone bank.
          // Cards/dice/chips land exactly where the action happens; a sound
          // effect never re-sends the previous sentence's caption.
          const webClip = pickGameClipWeb(cue);
          if (webClip) {
            if (!fillerCtx.firstAudioReady) {
              fillerCtx.firstAudioReady = true;
              if (session._turnT0) console.log(`[timing ${session.streamSid}] first-audio +${Date.now() - session._turnT0}ms after turn-start (web clip)`);
            }
            await playBufferWav(session, webClip, { noCaption: true });
          }
          continue;
        }
        const clip = pickGameClip(cue);
        if (!clip) continue;
        if (!fillerCtx.firstAudioReady) {
          fillerCtx.firstAudioReady = true; // a table sound counts as first audio — stop the typing filler
          if (session._turnT0) console.log(`[timing ${session.streamSid}] first-audio +${Date.now() - session._turnT0}ms after turn-start (phone clip)`);
          if (fillerCtx.fillerStarted) {
            session.sendClear();
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        await playBuffer(session, clip);
      }
      const mulawBuf = await synthPromise;
      if (mulawBuf && !session.llmAbort) {
        if (!fillerCtx.firstAudioReady) {
          fillerCtx.firstAudioReady = true;
          // Session 22: THE first-audio receipt that actually fires on a
          // normal spoken reply (the web-clip one above only fires on game
          // sounds -- which is why production showed no first-audio lines).
          if (session._turnT0) console.log(`[timing ${session.streamSid}] first-audio +${Date.now() - session._turnT0}ms after turn-start (speech)`);
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
  };

  // TTS context batching (July 4 2026 — Kade: "make the chunks bigger; it
  // can't remember it sounds like it's listing games"). Per-sentence synth
  // gives the voice ZERO prosodic context: every clip is a cold start, so
  // lists lose their listing rhythm. Sentence 1 still ships alone (fast
  // first audio); after that, sentences accumulate to ~PHONE_TTS_CHUNK
  // chars (default 320) and synth as ONE passage. Sentences carrying
  // [sound:]/[table:] tokens flush the batch and pass through solo so cue
  // timing survives; a sentence opening with a %%%direction%%% tag starts
  // its own chunk so the tag stays in leading position for the TTS proxy.
  let _chunkBuf = '';
  let _firstShipped = false;
  // How many chunks have been shipped after the solo first sentence. Drives
  // the ramp: the first one uses the short target, everything after uses the
  // full one. Reset per turn (this whole block is per-turn scope), so every
  // reply gets its own fast opening rather than only the first of a call.
  let _chunksAfterFirst = 0;
  const chunkTarget = () => (_chunksAfterFirst === 0 ? TTS_CHUNK_RAMP : TTS_CHUNK_TARGET);
  const flushChunk = () => {
    if (_chunkBuf) { const c = _chunkBuf; _chunkBuf = ''; _chunksAfterFirst++; processUnit(c); }
  };
  // LIVE ANTI-TELL SCRUB (July 21 2026): run each finished sentence through
  // the deterministic stripAiTells engine BEFORE it reaches TTS, so universal
  // BANs (sycophancy openers, empty signposts, canned closers...) are never
  // SPOKEN, not just cleaned from the saved transcript afterward. Per-sentence
  // scope means zero added latency (the streamer already works per sentence).
  // A leading %%%direction%%% tag is held aside so the TTS steering stays in
  // lead position; a sentence that scrubs down to NOTHING was pure tell and is
  // dropped whole. Fail-soft: any error passes the original sentence through.
  const scrubSentence = (raw) => {
    try {
      const m = raw.match(/^(\s*%%%[^%]+%%%\s*)([\s\S]*)$/);
      const head = m ? m[1] : '';
      const body = m ? m[2] : raw;
      const cleaned = stripAiTells(body);
      if (!cleaned) return '';
      return head + cleaned;
    } catch (e) { return raw; }
  };
  streamer.on('sentence', (sentence) => {
    if (session.llmAbort) return;
    // Sound cues / tables / END CALL units are control payloads -- never scrub.
    if (sentence.indexOf('[sound:') === -1 && sentence.indexOf('[table:') === -1 && !/\[END CALL\]/i.test(sentence)) {
      sentence = scrubSentence(sentence);
      if (!sentence) return; // whole sentence was tell -- skip it, keep _firstShipped state
    }
    if (!_firstShipped) { _firstShipped = true; processUnit(sentence); return; }
    if (sentence.indexOf('[sound:') !== -1 || sentence.indexOf('[table:') !== -1 || /\[END CALL\]/i.test(sentence)) {
      flushChunk();
      processUnit(sentence);
      return;
    }
    if (/^\s*%%%/.test(sentence)) {
      flushChunk();
      _chunkBuf = sentence;
      return;
    }
    _chunkBuf = _chunkBuf ? `${_chunkBuf} ${sentence}` : sentence;
    if (_chunkBuf.length >= chunkTarget()) flushChunk();
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
  // Session 22 receipts: the leg between turn-start and the first LLM
  // token was INVISIBLE (Kade: "answers were taking like ten seconds...
  // the other things not so much"). Two stamps bracket the whole
  // ask-stream leg: request-sent (everything before it = prep: memories,
  // context, outgoing build) and first-token (everything between =
  // proxy login + LibreChat agents pipeline + model first token).
  let _llmFirstTokenLogged = false;
  if (session._turnT0) console.log(`[timing ${session.streamSid}] llm-request sent +${Date.now() - session._turnT0}ms after turn-start`);
  for (let attempt = 0; attempt <= STALL_RETRIES; attempt++) {
    turnTimedOut = false;
    const res = await streamPost(
      `${session.cfg.proxyUrl}/librechat/ask-stream`,
      {
        Authorization: `Bearer ${session.cfg.proxySecret}`,
        'Content-Type': 'application/json',
        'User-Agent': BROWSER_UA,
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
            if (d.token) {
              if (!_llmFirstTokenLogged) {
                _llmFirstTokenLogged = true;
                if (session._turnT0) console.log(`[timing ${session.streamSid}] llm-first-token +${Date.now() - session._turnT0}ms after turn-start`);
              }
              lastProgress = Date.now(); fullReply += d.token; if (!session.llmAbort) streamer.push(d.token);
            }
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

  if (!session.llmAbort) { streamer.end(); flushChunk(); }
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
async function synthesize(text, voice, rate, format = 'mulaw', dictionary) {
  const cfg = global._vsConfig;
  const input = fixPronunciation(text, dictionary).slice(0, 4096);
  const useVoice = voice || cfg.defaultVoice;
  const t0 = Date.now();
  console.log(`[voice-stream] synth request: ${input.length} chars, voice "${useVoice}"${typeof rate === 'number' ? `, rate ${rate}` : ''}`);
  const body = { model: cfg.ttsModel, input, voice: useVoice };
  if (typeof rate === 'number') body.speed = rate; // proxy clamps to 0.5-1.5
  const res = await streamPost(
    `${cfg.ttsProxyUrl}/v1/audio/speech${format === 'mulaw' ? '?telephony=1' : ''}`,
    { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA },
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
    const buf = await synthesize(text, voice || session.voice, session.rate, session.media, session.pronunciationDictionary);
    session._currentSpokenText = text; // for echo detection, see looksLikeEcho
    await playBuffer(session, buf);
  } catch (e) { console.error('[voice-stream] speak error:', e.message); }
}

// ── WEB VOICE (July 9 2026): WAV playback to a browser client ────────────────
// The whole clip ships as ONE binary WS frame; the client decodes + schedules
// gaplessly via Web Audio. Server keeps the same isSpeaking/lastSpokAt
// bookkeeping as the phone path (via the WAV header's real duration) so every
// echo gate, barge-in rule, and busy-drop works UNCHANGED on web.
const WEB_LEAD_MS = 600; // ship the next clip this early so client seams are sample-accurate

function wavDurationMs(buf) {
  try {
    if (!buf || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    const byteRate = buf.readUInt32LE(28);
    let off = 12; // walk chunks: some encoders put LIST/fact before data
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'data') return byteRate > 0 ? Math.round((size / byteRate) * 1000) : null;
      off += 8 + size + (size % 2);
    }
  } catch {}
  return null;
}

async function playBufferWav(session, wavBuf, opts = {}) {
  if (!wavBuf || !wavBuf.length) return;
  if (session.ws.readyState !== WebSocket.OPEN) return;
  const durMs = wavDurationMs(wavBuf) ?? Math.round(wavBuf.length / 48); // fallback: 24kHz 16-bit mono
  session.finalBuf       = '';
  session.partialBuf     = '';
  session.isSpeaking     = true;
  session.speakStartedAt = Date.now();
  session.bargedIn       = false;
  if (!opts.noCaption && session.sendCaption && session._currentSpokenText) session.sendCaption('assistant', session._currentSpokenText);
  if (session.sendState) session.sendState('speaking');
  try { session.ws.send(wavBuf, { binary: true }); } catch { return; }
  session._webPlayheadEnd = Math.max(session._webPlayheadEnd || 0, Date.now()) + durMs;
  // Return WEB_LEAD_MS early so the playChain synthesizes/ships the NEXT clip
  // while this one is still sounding (the client queues it seamlessly)...
  while (!session.llmAbort && session.isSpeaking && session.ws.readyState === WebSocket.OPEN) {
    const remaining = session._webPlayheadEnd - WEB_LEAD_MS - Date.now();
    if (remaining <= 0) break;
    await new Promise(r => setTimeout(r, Math.min(remaining, 100)));
  }
  if (session.llmAbort || !session.isSpeaking) return; // barged: sendClear already flushed the client
  // ...and let a tail timer own the TRUE end. If a later clip extends the
  // playhead, its own timer supersedes this one (the guard below no-ops).
  if (session._webTailTimer) clearTimeout(session._webTailTimer);
  const tailMs = Math.max(0, session._webPlayheadEnd - Date.now());
  session._webTailTimer = setTimeout(() => {
    if (session.llmAbort || session.ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() < (session._webPlayheadEnd || 0) - 20) return; // a newer clip took over
    session.isSpeaking = false;
    session.lastSpokAt = Date.now();
    if (session.sendState) session.sendState('listening');
  }, tailMs + 30);
}

// ── Play μ-law as 20ms frames ─────────────────────────────────────────────────
const FRAME_BYTES = 160;

async function playBuffer(session, mulawBuf) {
  if (!mulawBuf || !mulawBuf.length) return;
  if (session.ws.readyState !== WebSocket.OPEN) return;
  if (session.media === 'wav') return playBufferWav(session, mulawBuf);
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
// KADE July 3 2026: per her ask, the greeting now ALSO covers interrupting,
// so the recurring in-turn "you can cut me off" hint could be demoted to
// once per call (see RAMBLE_HINT section).
// KADE July 12 2026: interrupt-invites retired ("you don't have to put that
// feel free to interrupt thing in there anymore") — typing-sound heads-up stays.
// KADE July 22 2026 ("the thinking sound warning could be shortened too"):
// one short clause each, same promise.
const ORIENTATION_LINES = [
  "Typing sound just means I'm thinking.",
  "If you hear typing, I'm just thinking.",
  "A little typing means I'm thinking.",
];

// Lazy per-voice cache so a given filler phrase is only synthesized once per
// running process, not on every single call.
const _fillerCache = new Map();
async function getFillerClip(voice, format = 'mulaw') {
  const idx = Math.floor(Math.random() * FILLER_PHRASES.length);
  const key = `${format}::${voice}::${idx}`;
  if (_fillerCache.has(key)) return _fillerCache.get(key);
  const buf = await synthesize(FILLER_PHRASES[idx], voice, undefined, format);
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
    ? `[PHONE CALL SYSTEM NOTE] ${name} is calling you on the phone right now and you are picking up. Reply with ONLY your pickup line: one short, fresh, NATURAL in-character hello greeting ${name} by name (work your own name in too) — like a real friend answering the phone. Hard rules: 16 words max, NO catchphrases or signature slogans, no questions, no invitation to speak yet, no emoji, no quotes, plain speakable text only.`
    : '[PHONE CALL SYSTEM NOTE] Someone from a number you do not recognize is calling and you are picking up. Reply with ONLY your pickup line: one short, fresh, NATURAL in-character hello introducing yourself by name and noting you do not recognize the number, working in naturally that they can say sign me up any time to get their own account. Hard rules: 30 words max, NO catchphrases or signature slogans, no questions, no invitation to speak yet, no emoji, no quotes, plain speakable text only.';

  const attempt = (async () => {
    const res = await streamPost(
      `${session.cfg.proxyUrl}/librechat/ask-stream`,
      {
        Authorization: `Bearer ${session.cfg.proxySecret}`,
        'Content-Type': 'application/json',
        'User-Agent': BROWSER_UA,
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
// KADE July 12 2026: "am I rambling? Nah." — hint OFF by default (env re-enables).
const RAMBLE_HINT_AFTER = parseInt(process.env.PHONE_RAMBLE_HINT_AFTER || '0', 10);
const RAMBLE_HINTS = [
  'Am I rambling? Jump in whenever.',
  'By the way, you can cut me off any time.',
  'Feel free to jump in, by the way.',
];
const _rambleCache = new Map();
async function getRambleClip(voice, rate, format = 'mulaw') {
  const idx = Math.floor(Math.random() * RAMBLE_HINTS.length);
  const key = `${format}::${voice}::${typeof rate === 'number' ? rate : 'd'}::${idx}`;
  if (_rambleCache.has(key)) return _rambleCache.get(key);
  const buf = await synthesize(RAMBLE_HINTS[idx], voice, rate, format);
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
function loadWavAsMulaw8k(filePath, gain = 1) {
  const raw = fs.readFileSync(filePath);
  if (raw.toString('ascii', 0, 4) !== 'RIFF' || raw.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12, fmt = null, dataStart = -1, dataLen = 0;
  while (offset + 8 <= raw.length) {
    const id   = raw.toString('ascii', offset, offset + 4);
    // Some generators write a chunk size that overruns the actual file
    // (seen live: one ElevenLabs clip). Clamp to what's really there.
    const size = Math.min(raw.readUInt32LE(offset + 4), raw.length - offset - 8);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= raw.length) {
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
    out[i] = encodeUlaw(Math.max(-32768, Math.min(32767, Math.round((s0 + (s1 - s0) * frac) * gain))));
  }
  return out;
}

// ── Game Parlor sound cues on the phone line (phase 3, July 3 2026) ──────────
// The game engine emits [sound:x] tokens in tool results; the agent carries
// them inline in its reply. On the web the chat client plays mp3s; here the
// same cue names map to the master WAVs in assets/sounds/, pre-converted to
// 8kHz mu-law at boot (exact same machinery as the typing-filler clips).
// Files named name.wav / name_2.wav / name_3.wav are takes of one cue; a
// take is picked at random per play. Cue clips are mastered near 0 dBFS
// while speech sits at -20 dBFS RMS, so they load with a gain duck
// (PHONE_SOUND_GAIN, default 0.4) to sit under the voice, not over it.
const GAME_SOUND_RE = /\[sound:([a-z0-9_]+)\]/gi;
const SOUND_ASSETS_DIR = path.join(__dirname, 'assets', 'sounds');
const SOUND_GAIN = Math.max(0.05, Math.min(1, parseFloat(process.env.PHONE_SOUND_GAIN || '0.4')));
const MAX_CUES_PER_SENTENCE = 4;

// WEB VOICE (July 9 2026, "wire up the game stuff"): scale a 16-bit PCM WAV's
// samples by `gain` and return the whole file buffer untouched otherwise —
// browsers decode it natively, so game clips ride the same binary pipe as
// speech. Gain-matched to the phone bank so levels feel identical.
function loadWavScaled(filePath, gain = 1) {
  const raw = fs.readFileSync(filePath);
  if (raw.toString('ascii', 0, 4) !== 'RIFF' || raw.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12, bits = 16, dataStart = -1, dataLen = 0;
  while (offset + 8 <= raw.length) {
    const id   = raw.toString('ascii', offset, offset + 4);
    const size = Math.min(raw.readUInt32LE(offset + 4), raw.length - offset - 8);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= raw.length) bits = raw.readUInt16LE(body + 14);
    else if (id === 'data') { dataStart = body; dataLen = size; }
    offset = body + size + (size % 2);
  }
  if (dataStart < 0) throw new Error('missing data chunk');
  if (bits !== 16) throw new Error(`only 16-bit PCM supported (got ${bits}-bit)`);
  if (gain !== 1) {
    const end = dataStart + dataLen - 1;
    for (let i = dataStart; i < end; i += 2) {
      raw.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(raw.readInt16LE(i) * gain))), i);
    }
  }
  return raw;
}

const GAME_SOUND_BANK_WEB = new Map(); // cue -> [wavBuf, ...] (filled by loadGameSoundClips)

function loadGameSoundClips() {
  const bank = new Map(); // cue -> [mulawBuf, ...] (takes)
  try {
    if (!fs.existsSync(SOUND_ASSETS_DIR)) {
      console.log('[voice-stream] no assets/sounds/ dir — game sound cues disabled on the phone');
      return bank;
    }
    const files = fs.readdirSync(SOUND_ASSETS_DIR).filter((f) => f.toLowerCase().endsWith('.wav'));
    for (const f of files) {
      const cue = f.replace(/\.wav$/i, '').replace(/_\d+$/, '').toLowerCase();
      try {
        const buf = loadWavAsMulaw8k(path.join(SOUND_ASSETS_DIR, f), SOUND_GAIN);
        if (!bank.has(cue)) bank.set(cue, []);
        bank.get(cue).push(buf);
      } catch (e) {
        console.warn(`[voice-stream] skipping sound asset ${f}: ${e.message}`);
      }
      try {
        const webBuf = loadWavScaled(path.join(SOUND_ASSETS_DIR, f), SOUND_GAIN);
        if (!GAME_SOUND_BANK_WEB.has(cue)) GAME_SOUND_BANK_WEB.set(cue, []);
        GAME_SOUND_BANK_WEB.get(cue).push(webBuf);
      } catch (e) {
        console.warn(`[voice-stream] skipping web sound asset ${f}: ${e.message}`);
      }
    }
    console.log(`[voice-stream] game sound bank: ${bank.size} cues from ${files.length} wav files (gain ${SOUND_GAIN})`);
    console.log(`[voice-stream] web game sound bank: ${GAME_SOUND_BANK_WEB.size} cues (raw WAV, same gain)`);
  } catch (e) {
    console.warn('[voice-stream] game sound bank load failed:', e.message);
  }
  return bank;
}
const GAME_SOUND_BANK = loadGameSoundClips();

function pickGameClip(cue) {
  const takes = GAME_SOUND_BANK.get(cue);
  if (!takes || !takes.length) return null; // unknown cue — stay silent, never break the call
  return takes[Math.floor(Math.random() * takes.length)];
}

function pickGameClipWeb(cue) {
  const takes = GAME_SOUND_BANK_WEB.get(cue);
  if (!takes || !takes.length) return null;
  return takes[Math.floor(Math.random() * takes.length)];
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
  if (session.media !== 'mulaw') {
    // KADE July 9 2026 (her first live test of streaming web calls): the
    // spoken filler phrase here ("Let me think on that", "hold on a sec")
    // read as forced/robotic — cut on her word. Web dead-air is already
    // covered CLIENT-side: ConversationMode plays its own quiet thinking-
    // loop sound whenever status is 'thinking' (the same texture idea as
    // the phone's typing clips, minus a voice pretending to stall). So the
    // server stays completely silent while generating on web. Phone keeps
    // its typing-clip loop — different transport, different answer.
    return;
  }
  await runThinkingFiller(session, ctx);
}

// ── Ringback loop ─────────────────────────────────────────────────────────────
// Plays US ring tone (440+480 Hz, 2s on / 4s off) until _ringbackActive=false.
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
// ── Shared WS upgrade router (July 9 2026) ───────────────────────────────────
// ws v8 in server+path mode 400-aborts EVERY non-matching upgrade (verified in
// node_modules/ws/lib/websocket-server.js: shouldHandle -> abortHandshake 400).
// Two path-ed servers on one HTTP server therefore fight: whichever attached
// first kills the other's handshakes. noServer mode + one router fixes it.
function installUpgradeRouter(server) {
  if (server._kadeUpgradeRoutes) return server._kadeUpgradeRoutes;
  const routes = new Map();
  server._kadeUpgradeRoutes = routes;
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'ws://x').pathname; } catch {}
    const wss = routes.get(pathname);
    if (!wss) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  return routes;
}

const sessionsByCallSid = new Map();

/** July 12 2026 — async AMD verdict from Twilio (via server.js /amd-status).
 * 'machine' arrives at the voicemail greeting's END (the beep): switch the
 * session to voicemail mode, speak ONE clean composed message, hang up.
 * Fail-soft: no session found (already ended) — do nothing. */
async function handleAmdResult(callSid, result) {
  const session = sessionsByCallSid.get(callSid);
  if (!session || session.voicemailMode || result !== 'machine') return;
  session.voicemailMode = true;
  try { session.llmAbort = true; } catch {}
  try { if (session.sendClear) session.sendClear(); } catch {}
  const cfg = global._vsConfig || {};
  const ctx = (cfg.getOutboundCtx && cfg.getOutboundCtx(callSid)) || {};
  const first = String(ctx.calleeName || '').trim().split(/\s+/)[0] || 'there';
  const who = String(ctx.userName || 'a Kade-AI user').trim().split(/\s+/)[0];
  let mission = String(ctx.purpose || '').replace(/^(?:i'?m calling (?:because|about|to)\s*)/i, '').trim();
  if (mission.length > 160) mission = mission.slice(0, 157) + '...';
  // July 12 2026 (Kade): voicemail matches the greeting tiers — your OWN
  // companion sounds like your own companion, family gets a natural
  // possessive, strangers get the honest formal version.
  const agentName = ctx.agentName || session.agentName;
  const rec = cfg.users && cfg.users.get(ctx.to || session.from);
  const ownAgent = !!(rec && ctx.agentId && rec.agentId === ctx.agentId);
  const msg = ownAgent
    ? `Hey ${first}, it's ${agentName}! ` +
      (mission ? `I called to ${mission} ` : 'Just calling to say hi. ') +
      `Sorry I missed you — catch me in the app any time, or call me back on the Kade A I line. Talk soon. Bye!`
    : rec
      ? `Hey ${first}, it's ${agentName} — ${who}'s A I. ` +
        (mission ? `I was calling to ${mission} ` : '') +
        `Catch me in the app any time, or call the Kade A I line back. Bye!`
      : `Hi, this is ${agentName}, an A I assistant calling for ${who} from Kade A I. ` +
        (mission ? `I was calling to ${mission} ` : '') +
        `Sorry I missed you — I may try again another time. Bye!`;
  console.log(`[voice-stream] VOICEMAIL MODE for ${callSid} — leaving one message`);
  // Record what we left: the message rides the transcript + flags the meta so
  // the report-back says "left a voicemail" instead of summarizing a non-chat.
  try { ctx.voicemail = true; } catch {}
  try { session.history.push({ role: 'assistant', content: `[VOICEMAIL LEFT] ${msg}` }); } catch {}
  try {
    await speak(session, msg, session.voice);
    setTimeout(() => { try { cfg.endCall && cfg.endCall(callSid); } catch {} }, 1200);
  } catch (e) {
    console.warn('[voice-stream] voicemail message failed:', e.message);
    try { cfg.endCall && cfg.endCall(callSid); } catch {}
  }
}

function attachMediaStreams(server, users, cfg) {
  global._vsConfig = { ...cfg, users };

  const wss = new WebSocket.Server({ noServer: true });
  installUpgradeRouter(server).set('/ws/media', wss);

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

          // July 12 2026: register by callSid so async callbacks (AMD) can
          // reach the live session.
          if (callSid) {
            sessionsByCallSid.set(callSid, session);
            ws.on('close', () => sessionsByCallSid.delete(callSid));
          }

          // July 12 2026: fetch the caller/callee's own memory cards (fork)
          // so this agent actually REMEMBERS them on the phone. Async — first
          // turn may go out without them; they attach the moment they land.
          if (global._vsConfig.fetchCallMemories) {
            global._vsConfig.fetchCallMemories({ email: user?.lcEmail, phone: from }, session.agentId, { nudges: !session.outbound })
              .then((text) => {
                if (text && session) {
                  session.callerMemories = text;
                  console.log(`[voice-stream] caller memories attached for ${from} (${text.length} chars)`);
                }
              })
              .catch(() => {});
          }

          // July 12 2026: apply the caller's own per-agent voice pick (fork
          // store). Async so the greeting never waits — when it lands (sub-
          // second typical) the session upgrades unless they've since spoken
          // an explicit switch. Outbound callee picks are applied in
          // /outbound-call before greeting synth, so skip those here.
          if (!outboundCtx && global._vsConfig.lookupVoicePref) {
            const startAgentId = session.agentId;
            global._vsConfig.lookupVoicePref({ email: user?.lcEmail, phone: from }, startAgentId)
              .then((pref) => {
                if (pref && session && session.agentId === startAgentId && !session.spokenVoiceChoice) {
                  session.voice = pref;
                  console.log(`[voice-stream] personal voice applied for ${from}: "${pref}"`);
                }
              })
              .catch(() => {});
          }

          // Kade July 20 2026: personal pronunciation dictionary. Cache read
          // is SYNCHRONOUS (unlike the two async fetches above) so it can
          // inform the STT keyterms set at socket-open just below -- see
          // pronunciationCache's own comment for the two-tier cache/refresh
          // reasoning (first-ever call = defaults only; warm from then on).
          const pronIdentity = { email: user?.lcEmail, phone: from };
          session.pronunciationDictionary = getCachedDictionary(pronIdentity);
          refreshPronunciationDictionary(session, pronIdentity, global._vsConfig);

          session.dgWs = openDeepgram(session);

          const name      = user?.name || 'there';
          const agentName = session.agentName;
          // GREETING RESTRUCTURE (July 1 2026, Kade's fix request): ONE
          // synthesized utterance ordered opener -> typing-sound orientation
          // -> invitation-to-speak LAST. Openers deliberately contain NO
          // invitation so the caller is never invited to talk and then
          // talked over. Single synth also removes the second TTS round-trip
          // (the old post-greeting orientation gap WAS that synth latency).
          // KADE July 22 2026 ("they should all say something with their
          // name in it. Like, Hey it's Kiana"): pruned to ONLY openers that
          // carry the agent's name — a caller must never have to guess who
          // picked up. The LLM character opener (fetchLlmOpener) already
          // enforces the same rule in its instruction.
          const knownOpeners = [
            `Hey ${name}! It's ${agentName}.`,
            `Hey, ${name}! ${agentName} here.`,
            `It's ${agentName} — hey ${name}!`,
            `Hey ${name} — ${agentName} speaking.`,
            `Hi ${name} — it's ${agentName}.`,
            `${name}! It's ${agentName}.`,
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
          // KADE July 22 2026 ("the go ahead I'm listening thing is a bit
          // much"): a couple of words at most. These play on the PHONE only,
          // where there is no screen saying the line is live — the app
          // greeting dropped its invite entirely (screen + VoiceOver already
          // say the call state).
          const INVITES = [
            `What's up?`,
            `Go ahead.`,
            `What's going on?`,
            `Talk to me.`,
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
          }
          // GREETING LOCK, BOTH DIRECTIONS (July 21 2026 — Kade: "the hey
          // keighty shit won't get interrupted by noise"): this lock was
          // born July 2 for OUTBOUND disclosures only, and inbound greetings
          // never got it — her own inbound test call tonight shows the
          // opener barged at t=0 by her reflexive pickup "Hey." The caller's
          // words are still HELD (handleUtterance's greeting-lock branch)
          // and replayed by releaseGreetingLock the moment the greeting
          // ends, so nothing they say is lost — the greeting just finishes.
          // Every inbound exit already releases: playGreeting's else branch,
          // greetingFailed, and the 35s safety valve below. Normal turns
          // stay interruptible any time — this covers ONLY the greeting.
          session._greetingLock = true;

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
                || await synthesize(outboundCtx.greeting2, sess.voice, sess.rate, undefined, sess.pronunciationDictionary);
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
                : synthesize(greeting, sess.voice, sess.rate, sess.media, sess.pronunciationDictionary).then(playGreeting);
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
              const buf = await synthesize(text, sess.voice, sess.rate, sess.media, sess.pronunciationDictionary);
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
            try { logCallTranscript(session); } catch (e) {}
            try { postVoiceChatUsage(session); } catch (e) {}
            if (session.outbound && global._vsConfig.onCallEnd) {
              try { global._vsConfig.onCallEnd(session.callSid, session.history); } catch {}
            }
            session._ringbackActive = false;
            session.llmAbort = true;
            session.isSpeaking = false;
            if (session._bargeRecoveryTimer) { clearTimeout(session._bargeRecoveryTimer); session._bargeRecoveryTimer = null; }
        if (session.dgWs) { try { session.dgWs.close(); } catch {} }
          }
          session = null;
          break;
        }
      }
    });

    ws.on('close', () => {
      if (session) {
        try { logCallTranscript(session); } catch (e) {}
        try { postVoiceChatUsage(session); } catch (e) {}
        if (session.outbound && global._vsConfig.onCallEnd) {
          try { global._vsConfig.onCallEnd(session.callSid, session.history); } catch {}
        }
        session._ringbackActive = false;
        session.llmAbort = true;
        session.isSpeaking = false;
        if (session._bargeRecoveryTimer) { clearTimeout(session._bargeRecoveryTimer); session._bargeRecoveryTimer = null; }
        if (session.dgWs) { try { session.dgWs.close(); } catch {} }
        session = null;
      }
    });

    ws.on('error', (e) => console.error('[voice-stream] WS error:', e.message));
  });

  console.log('[voice-stream] WebSocket handler ready at /ws/media');
  return wss;
}

// KADE July 5 2026: persist the finished call transcript to the fork's Calls
// history (POST /api/kade/calls/ingest). Text only, no audio. Idempotent (stop
// + close can both fire). Fire-and-forget: never blocks or breaks a live call.
async function logCallTranscript(session) {
  try {
    if (!session || session._loggedTranscript) return;
    session._loggedTranscript = true;
    const axios = require('axios');
    const turns = (session.history || [])
      .filter((m) => m && m.content && String(m.content).trim())
      .map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        // Session 21j: assistant turns also get the deterministic anti-tell
        // scrub (sycophancy openers, apology/mask-slip boilerplate, empty
        // signposts, canned closers). User turns are left verbatim.
        text: m.role === 'user'
          ? scrubTranscriptText(String(m.content))
          : stripAiTells(scrubTranscriptText(String(m.content))),
        // July 2026: rides per-turn Spotter attribution through to the fork's
        // mint (kadeCallMerge). Null on ordinary turns -> base agentName.
        agentName: m.agentName || null,
      }));
    if (!turns.length) return;
    const secret = process.env.KADE_CALL_INGEST_SECRET || process.env.KADE_USAGE_EVENT_SECRET;
    if (!secret) return;
    const base = (process.env.LIBRECHAT_URL || 'https://kademurdock.com').replace(/\/$/, '');
    // Session 21i: a DIRECT Spotter call is entirely the Spotter, so mint it
    // under the Spotter's OWN agent (carried on the ticket as session.spotter.
    // agentId) instead of the base agent. That lands the caller in the
    // Spotter's conversation on hangup AND shares the Spotter's per-agent
    // memory between calls and text. Falls back to the base agent if this
    // wasn't a direct Spotter call or the Spotter agent isn't linked yet.
    const _sp = (session.spotter && typeof session.spotter === 'object') ? session.spotter : {};
    const _useSpotter = !!session._spotterDirect && !!_sp.agentId;
    const ingestAgentId = _useSpotter ? _sp.agentId : (session.agentId || null);
    const ingestAgentName = _useSpotter ? (_sp.name || session.agentName || null) : (session.agentName || null);
    await axios.post(`${base}/api/kade/calls/ingest`, {
      secret,
      userEmail: session.lcEmail || null,
      // KADE July 22 2026 (call continuity): non-null tells the fork's mint
      // to APPEND into this existing conversation instead of creating one.
      targetConversationId: session.targetConversationId || null,
      surface: session.surface || 'phone',
      agentId: ingestAgentId,
      agentName: ingestAgentName,
      callerName: session.callerName || null,
      from: session.from || null,
      startedAt: session.startedAt || null,
      endedAt: new Date().toISOString(),
      turns,
      metadata: { callSid: session.callSid, outbound: !!session.outbound },
    }, { timeout: 8000, headers: { 'User-Agent': BROWSER_UA } });
    console.log(`[voice-stream] logged transcript for ${session.callSid} (${turns.length} turns)`);
  } catch (e) {
    console.log(`[voice-stream] transcript log failed: ${e && e.message}`);
  }
}

// ═══ WEB VOICE (July 9 2026) — browser streaming calls, same engine ══════════
// Everything above (echo gates, barge-in, backchannel drops, agent/voice
// switching, deep-think, filler, ramble hint, TTS chunk batching) runs
// UNCHANGED for web sessions. Only the transport differs:
//   browser mic (PCM16 16k, binary WS frames) -> Deepgram linear16
//   Inworld WAV clips + JSON control events   -> browser Web Audio queue
// Auth: short-lived HMAC ticket minted by the fork (JWT-authed route) using
// the SAME secret as calls/ingest (KADE_CALL_INGEST_SECRET falling back to
// KADE_USAGE_EVENT_SECRET) — zero new env vars on either service.

class WebCallSession extends CallSession {
  constructor(from, user, ws, cfg) {
    const sid = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    super(sid, sid, from, user, ws, cfg);
    this.media    = 'wav';
    this.surface  = 'web';
    this.userId   = user?.userId || null; // LibreChat user id, for usage events
    this._webPlayheadEnd = 0;
  }
  jsonSend(obj) {
    if (this.ws.readyState === WebSocket.OPEN) { try { this.ws.send(JSON.stringify(obj)); } catch {} }
  }
  // Twilio protocol frames are meaningless to a browser — swallow them so any
  // shared code path that emits them is harmless here.
  twSend() {}
  sendMedia() {}
  sendClear() {
    this._webPlayheadEnd = 0;
    if (this._webTailTimer) { clearTimeout(this._webTailTimer); this._webTailTimer = null; }
    this.jsonSend({ type: 'clear' });
    this.jsonSend({ type: 'state', state: 'listening' });
  }
  sendCaption(role, text) { this.jsonSend({ type: 'caption', role, text }); }
  sendState(state)        { this.jsonSend({ type: 'state', state }); }
  sendCue(name)           { this.jsonSend({ type: 'cue', name }); }
  sendTable(id)           { this.jsonSend({ type: 'table', id }); }
}

function verifyWebTicket(ticket) {
  const secret = process.env.KADE_CALL_INGEST_SECRET || process.env.KADE_USAGE_EVENT_SECRET;
  // July 18 2026: guard raised 4096 -> 20480. The ticket carries the caller's
  // Spotter persona (cap 12,000 chars since July 17), and base64url inflates
  // the payload by 4/3 — a full-length persona makes a ~17KB ticket. The old
  // 4096 guard silently 4401'd every streaming call from any account with a
  // long custom Spotter (Kade's, since the Whittney upgrade), dropping the app
  // to the classic engine (no barge-in) with the Spotter ask never sent.
  if (!secret || !ticket || typeof ticket !== 'string' || ticket.length > 20480) return null;
  const dot = ticket.lastIndexOf('.');
  if (dot < 1) return null;
  const body = ticket.slice(0, dot);
  const sig  = ticket.slice(dot + 1);
  let expect;
  try { expect = crypto.createHmac('sha256', secret).update(body).digest('base64url'); } catch { return null; }
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  if (!payload.email) return null;
  return payload;
}

// Spend visibility on Feed the Server. costUSD deliberately 0 for v1: STT is
// inside Deepgram's free tier and TTS chars already flow through the same
// Inworld proxy as everything else — posting a guessed char-price here risks
// DOUBLE-counting. Open item: confirm where phone/web TTS chars get billed.
// Session 22 (Kade: "Hell yes charge for the chats. It doesn't matter where
// they're happening, if they happen and they make my bill go up, users need
// to at least know about it"). Voice-lane LLM turns ride the proxy's OWN
// LibreChat login (admin, balance-exempt), so LibreChat's balance system
// never bills the caller for them -- web/app TEXT chat pays, voice chat
// didn't. This posts an ESTIMATE per call so voice thinking lands on the
// caller's wallet and dashboard like everything else.
//
// Estimate shape, stated honestly: each assistant turn's prompt is about
// (system-prompt overhead + all prior turns), because that IS the rolling
// history each ask actually sends; the completion is the turn's own text;
// chars/4 approximates tokens; per-million rates are env-tunable
// (VOICE_CHAT_IN_USD_PER_MTOK / VOICE_CHAT_OUT_USD_PER_MTOK, defaults 0.60 /
// 2.50 -- Kimi K2-class). Deterministic state-machine lines (registration)
// ride session.history too, so this slightly OVER-estimates on signup calls;
// metadata.estimated = true says so. Unlinked callers (no lcEmail, no
// userId) have no wallet to bill -- skipped, same boundary as transcripts.
// Kade's own calls post normally: the fork's deductKadeCredits is
// ADMIN-exempt, so hers are logged (visible) but never docked.
async function postVoiceChatUsage(session) {
  try {
    if (!session || session._voiceChatPosted) return;
    session._voiceChatPosted = true;
    const secret = process.env.KADE_USAGE_EVENT_SECRET;
    if (!secret) return;
    const userId = session.userId || null;
    const userEmail = session.lcEmail || null;
    if (!userId && !userEmail) return;
    const hist = (session.history || []).filter((m) => m && m.content && String(m.content).trim());
    if (!hist.length) return;
    const OVERHEAD = parseInt(process.env.VOICE_CHAT_PROMPT_OVERHEAD_CHARS || '4000', 10);
    let inChars = 0;
    let outChars = 0;
    let prior = 0;
    for (const m of hist) {
      const len = String(m.content).length;
      if (m.role !== 'user') { inChars += OVERHEAD + prior; outChars += len; }
      prior += len;
    }
    const inTok = Math.ceil(inChars / 4);
    const outTok = Math.ceil(outChars / 4);
    const IN = Number(process.env.VOICE_CHAT_IN_USD_PER_MTOK || '0.60');
    const OUT = Number(process.env.VOICE_CHAT_OUT_USD_PER_MTOK || '2.50');
    const costUSD = Math.round(((inTok / 1e6) * IN + (outTok / 1e6) * OUT) * 10000) / 10000;
    const quantity = inTok + outTok;
    if (!(quantity > 0)) return;
    const base = (process.env.LIBRECHAT_URL || 'https://kademurdock.com').replace(/\/$/, '');
    const axios = require('axios');
    await axios.post(`${base}/api/kade/usage-event`, {
      secret,
      userId: userId || undefined,
      userEmail: userEmail || undefined,
      service: 'voice_chat',
      quantity,
      unit: 'tokens',
      costUSD,
      metadata: {
        surface: session.surface || (session.media === 'wav' ? 'web' : 'phone'),
        agent: session.agentName,
        estimated: true,
        inTok,
        outTok,
        turns: hist.length,
      },
    }, { timeout: 8000, headers: { 'User-Agent': BROWSER_UA } });
  } catch (e) { console.log('[voice-chat] usage post failed:', e && e.message); }
}

async function postWebVoiceUsage(session) {
  try {
    if (session._usagePosted || !session.userId) return;
    session._usagePosted = true;
    const secret = process.env.KADE_USAGE_EVENT_SECRET;
    if (!secret) return;
    const secs = Math.max(1, Math.round((Date.now() - new Date(session.startedAt).getTime()) / 1000));
    const minutes = Math.round((secs / 60) * 10) / 10;
    const base = (process.env.LIBRECHAT_URL || 'https://kademurdock.com').replace(/\/$/, '');
    const axios = require('axios');
    await axios.post(`${base}/api/kade/usage-event`, {
      secret,
      userId: session.userId,
      service: 'web_voice',
      quantity: minutes,
      unit: 'minutes',
      costUSD: 0,
      metadata: { agent: session.agentName, surface: 'web', seconds: secs },
    }, { timeout: 8000, headers: { 'User-Agent': BROWSER_UA } });
  } catch (e) { console.log('[web-voice] usage post failed:', e && e.message); }
}

async function postVideoUsage(session) {
  try {
    const { minutes, costUSD, mode } = videoSight.usageSummary(session);
    if (!(minutes > 0) && !(costUSD > 0)) return;
    const secret = process.env.KADE_USAGE_EVENT_SECRET;
    if (!secret || !session.userId) return;
    const base = (process.env.LIBRECHAT_URL || 'https://kademurdock.com').replace(/\/$/, '');
    const axios = require('axios');
    await axios.post(`${base}/api/kade/usage-event`, {
      secret,
      userId: session.userId,
      service: 'video',
      quantity: minutes,
      unit: 'minutes',
      costUSD,
      metadata: { agent: session.agentName, surface: 'web', mode },
    }, { timeout: 8000, headers: { 'User-Agent': BROWSER_UA } });
  } catch (e) { console.log('[video-sight] usage post failed:', e && e.message); }
}

async function postLiveUsage(session) {
  try {
    const secs = Number(session.liveSecondsTotal || 0);
    if (!(secs > 0)) return;
    const minutes = Math.round((secs / 60) * 100) / 100;
    const costUSD = Math.round(minutes * Number(process.env.LIVE_COST_PER_MIN_USD || '0.055') * 10000) / 10000;
    const secret = process.env.KADE_USAGE_EVENT_SECRET;
    if (!secret || !session.userId) return;
    const base = (process.env.LIBRECHAT_URL || 'https://kademurdock.com').replace(/\/$/, '');
    const axios = require('axios');
    await axios.post(`${base}/api/kade/usage-event`, {
      secret,
      userId: session.userId,
      service: 'video_live',
      quantity: minutes,
      unit: 'minutes',
      costUSD,
      metadata: { agent: session.agentName, surface: 'web', mode: 'live' },
    }, { timeout: 8000, headers: { 'User-Agent': BROWSER_UA } });
  } catch (e) { console.log('[video-live] usage post failed:', e && e.message); }
}

function attachWebVoice(server) {
  const wss = new WebSocket.Server({ noServer: true });
  installUpgradeRouter(server).set('/ws/web-voice', wss);

  wss.on('connection', (ws, req) => {
    const cfg = global._vsConfig;
    if (!cfg) { try { ws.close(1011, 'not ready'); } catch {} return; }
    // Browsers always send Origin. The HMAC ticket is the real lock; this
    // just shuts out casual cross-site noise.
    const origin = req.headers.origin || '';
    const allowed = (process.env.WEB_VOICE_ORIGINS || 'https://kademurdock.com,https://www.kademurdock.com')
      .split(',').map(x => x.trim()).filter(Boolean);
    if (origin && !allowed.includes(origin)) { try { ws.close(4403, 'origin'); } catch {} return; }

    let session = null;
    const helloTimer = setTimeout(() => {
      if (!session) { try { ws.close(4408, 'no hello'); } catch {} }
    }, 8000);

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        // Raw PCM16 mic frames -> straight to Deepgram, exactly like the
        // Twilio media case (which is what makes listening continuous:
        // the mic NEVER stops, even while the agent is talking).
        if (session && session.dgWs?.readyState === WebSocket.OPEN) session.dgWs.send(raw);
        // LIVE lane: same 16k PCM16 chunks the mic already ships for Deepgram
        // get forwarded to Google (Deepgram stays open for captions + the
        // "live off" voice escape hatch — its turns are gated in handleUtterance).
        if (session && session.liveOn) { try { videoLive.forwardAudio(session, Buffer.from(raw).toString('base64')); } catch {} }
        return;
      }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'hello' && !session) {
        clearTimeout(helloTimer);
        const t = verifyWebTicket(msg.ticket);
        if (!t) {
          try {
            ws.send(JSON.stringify({ type: 'error', message: 'Call ticket expired or invalid. Hang up and try again.' }));
            ws.close(4401, 'bad ticket');
          } catch {}
          return;
        }
        const user = {
          name:        t.name || null,
          agentId:     t.agentId || cfg.defaultAgent,
          agentName:   t.agentName || cfg.defaultAgentName,
          accountType: t.accountType || null,
          voice:       t.voiceId || null, // fork resolves the builder voice; CallSession fallback chain covers the rest
          rate:        (typeof t.rate === 'number' ? t.rate : undefined),
          lcEmail:     t.email,
          userId:      t.uid || null,
        };
        session = new WebCallSession(`web:${t.email}`, user, ws, cfg);
        // SPOTTER (July 16 2026): the account's personal live companion rides
        // in on the ticket (name + one of the 8 Google Live voices + persona,
        // designed at kademurdock.com/spotter). Missing/null = generic Spotter.
        session.spotter = (t.spotter && typeof t.spotter === 'object')
          ? {
              name: String(t.spotter.name || '').slice(0, 40),
              voice: String(t.spotter.voice || '').slice(0, 24),
              persona: String(t.spotter.persona || '').slice(0, 12000),
              // July 21 2026: the ticket has carried the Spotter's OWN agent id
              // since session 21i built spotter-attributed transcripts — but
              // this copy never picked the field up, so _useSpotter in
              // logCallTranscript could never be true and every Spotter call
              // minted under the BASE agent (Kade's report: "Whitney says"
              // turns living in a Kiana conversation). One field, whole fix.
              agentId: typeof t.spotter.agentId === 'string' && t.spotter.agentId
                ? String(t.spotter.agentId).slice(0, 64)
                : null,
            }
          : null;
        // Direct Spotter call (July 18 2026): the client asked for the Spotter
        // from the first tap — the character never speaks on this call.
        session._spotterDirect = msg.spotterDirect === true;
        // KADE July 22 2026 (call continuity): when the app starts a call
        // FROM an open conversation it sends that conversation's id; the
        // post-call ingest then APPENDS the transcript into it instead of
        // minting a fresh conversation per call ("they should have to go to
        // a new conversation to get a fresh call"), and the history seeding
        // below hands the agent what was already said there.
        session.targetConversationId =
          (typeof msg.conversationId === 'string' && /^[0-9a-f-]{8,64}$/i.test(msg.conversationId))
            ? msg.conversationId
            : null;
        if (session.targetConversationId && cfg.fetchConversationContext) {
          cfg.fetchConversationContext({ email: t.email, conversationId: session.targetConversationId })
            .then((turns) => {
              if (session && Array.isArray(turns) && turns.length) {
                // Seed BEFORE the greeting's own history entry if possible;
                // order within history is what matters, and unshift keeps
                // prior conversation turns ahead of anything this call adds.
                const seeded = turns.map((tn) => ({
                  role: tn.role === 'user' ? 'user' : 'assistant',
                  content: String(tn.text || '').slice(0, 2000),
                }));
                session.history.unshift(...seeded);
                console.log(`[web-voice] seeded ${seeded.length} prior turns from convo ${session.targetConversationId}`);
              }
            })
            .catch(() => {});
        }
        console.log(`[web-voice] START ${session.streamSid} user=${t.email} agent=${user.agentName} voice=${session.voice} spotter=${session.spotter ? session.spotter.name + '/' + session.spotter.voice : 'none'}${session._spotterDirect ? ' DIRECT' : ''}`);
        // July 13 2026 drift audit: web streaming calls never got the July 12
        // caller-memories fix — the phone had it, the sibling engine surface
        // didn't. Same fetch, and a web caller is live by definition, so
        // waiting family messages/reminders deliver here too (nudges: 1).
        if (cfg.fetchCallMemories) {
          cfg.fetchCallMemories({ email: t.email, userId: t.uid }, user.agentId, { nudges: true })
            .then((text) => {
              if (text && session) {
                session.callerMemories = text;
                console.log(`[web-voice] caller memories attached for ${t.email} (${text.length} chars)`);
              }
            })
            .catch(() => {});
        }
        // Ticket usually carries the builder voice (fork reads agent.tts).
        // If it didn't, warm the bridge cache and upgrade the session voice
        // as soon as it lands — same trick as mid-call agent switches.
        if (!t.voiceId && cfg.refreshAgentTts) {
          cfg.refreshAgentTts(user.agentId).then(() => {
            const tts = cfg.getAgentTts && cfg.getAgentTts(user.agentId);
            if (session && tts && tts.voiceId) {
              session.voice = tts.voiceId;
              if (session.rate == null && typeof tts.rate === 'number') session.rate = tts.rate;
            }
          }).catch(() => {});
        }
        // Kade July 20 2026: personal pronunciation dictionary, same
        // two-tier cache/refresh as the phone path above -- see
        // pronunciationCache's own comment.
        const pronIdentity = { email: t.email, userId: t.uid };
        session.pronunciationDictionary = getCachedDictionary(pronIdentity);
        refreshPronunciationDictionary(session, pronIdentity, cfg);

        session.dgWs = openDeepgram(session);
        session.jsonSend({ type: 'ready', agentName: session.agentName, voice: session.voice });
        session.sendState('listening');
        // Short spoken greeting: a blind caller needs to HEAR the line is
        // live. One line, invitation LAST (the July 1 greeting lesson), and
        // it doubles as the interrupt orientation.
        if (session._spotterDirect) {
          // July 18 2026 (Kade: "do we have to have Ki answer and transfer?"):
          // on a direct Spotter call the character stays SILENT — the client
          // fires the live ask the moment the line opens and the Spotter says
          // hello themselves. If live can't start (cap/disabled), those
          // notices still speak in the character's voice, so no dead air.
        } else {
          const first = (t.name || '').trim().split(/\s+/)[0] || null;
          // KADE July 22 2026 ("too long and wordy... the go ahead I'm
          // listening thing is a bit much since the screen and vo says the
          // same thing"): app greeting is now JUST the name line. The app's
          // own screen + VoiceOver announce the listening state, and the
          // NEW client-side thinking sound (this same session) covers the
          // typing orientation the phone greeting still carries. Shorter
          // greeting also shrinks the echo window that sometimes let the
          // agent hear its own greeting tail.
          const line = first
            ? `Hey ${first}! It's ${session.agentName}.`
            : `Hey! It's ${session.agentName}.`;
          speak(session, line, session.voice).catch(() => {});
        }
        return;
      }

      if (!session) return;
      if (msg.type === 'barge') {
        // Manual Stop button: same path as a voice barge-in. The client
        // already flushed its local queue; this kills generation + marks
        // the turn so the next utterance is a clean new turn.
        if (session.isSpeaking || session.busy) {
          session.bargedIn = true;
          bargeIn(session);
          if (session.busy && !session.isSpeaking) { session.sendClear(); session.llmAbort = true; }
        }
        return;
      }
      if (msg.type === 'video') { videoSight.handleVideoMsg(session, msg, speak); return; }
      if (msg.type === 'live') {
        // Live owns sight AND speech. If the snapshot video lane is armed it
        // bills wall-clock minutes underneath live — stand it down the moment
        // live actually comes up (hook fires on setupComplete, not on the
        // notice), and settle its usage right then so nothing is lost if the
        // socket later dies uncleanly.
        session.onLiveUp = () => {
          try { if (session.videoOn) { videoSight.stopVideo(session, 'live-handoff'); postVideoUsage(session); session.videoSeconds = 0; session.videoCostUSD = 0; } } catch {}
        };
        videoLive.handleLiveMsg(session, msg, speak);
        return;
      }
      if (msg.type === 'frame') {
        // While the Live lane is on it OWNS vision — forwarding the frame to
        // the snapshot lane too would pay for the same second of sight twice.
        if (session.liveOn) { videoLive.forwardFrame(session, msg.data); return; }
        videoSight.handleFrameMsg(session, msg);
        return;
      }
      if (msg.type === 'bye') { try { ws.close(1000, 'bye'); } catch {} return; }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (session) {
        try { if (session.videoOn || session.videoSeconds) { videoSight.stopVideo(session, 'hangup'); postVideoUsage(session); } } catch {}
        try { if (session.liveOn) videoLive.stopLive(session, 'hangup'); } catch {}
        try { postLiveUsage(session); } catch {}
        try { logCallTranscript(session); } catch {}
        try { postWebVoiceUsage(session); } catch {}
        try { postVoiceChatUsage(session); } catch {}
        session.llmAbort = true;
        session.isSpeaking = false;
        if (session._bargeRecoveryTimer) { clearTimeout(session._bargeRecoveryTimer); session._bargeRecoveryTimer = null; }
        if (session._webTailTimer) { clearTimeout(session._webTailTimer); session._webTailTimer = null; }
        if (session.dgWs) { try { session.dgWs.close(); } catch {} }
        session = null;
      }
    });

    ws.on('error', (e) => console.error('[web-voice] WS error:', e.message));
  });

  console.log('[voice-stream] Web voice WebSocket handler ready at /ws/web-voice');
  return wss;
}

module.exports = { attachMediaStreams, attachWebVoice, synthesize, handleAmdResult };
