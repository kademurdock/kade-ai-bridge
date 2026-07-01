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

function findAgent(agents, query) {
  if (!query || !agents.length) return null;
  const lq = query.toLowerCase().trim();
  return agents.find(a => a.name.toLowerCase() === lq)
      || agents.find(a => lq.includes(a.name.toLowerCase()))
      || agents.find(a => a.name.toLowerCase().includes(lq))
      || null;
}

function extractSwitchTarget(text, agents) {
  const m = text.match(
    /^(?:switch(?:\s+to)?|change(?:\s+to)?|talk(?:\s+to)?|give me|i want(?:\s+to(?:\s+talk(?:\s+to)?)?)?)\s+(.+)/i
  );
  const q = m ? m[1].trim() : (text.trim().split(/\s+/).length <= 2 ? text.trim() : null);
  return q ? findAgent(agents, q) : null;
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
    this.voice       = user?.voice     || cfg.defaultVoice;
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
    utterance_end_ms: '1000', endpointing: '350', vad_events: 'true',
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
async function handleUtterance(session, text) {
  text = text.trim();
  if (!text || text.length < 2) return;
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
    const newVoice = extractVoiceSwitch(text);
    if (newVoice) {
      session.voice = newVoice;
      const u = session.cfg.users.get(session.from);
      if (u) { u.voice = newVoice; session.cfg.saveUsers(); }
      await speak(session, `Switching to ${newVoice}'s voice! Go ahead.`, newVoice);
      return;
    }
    const agents = await session.cfg.getAgents();
    const target = extractSwitchTarget(text, agents);
    if (target && target.id !== session.agentId) {
      session.agentId   = target.id;
      session.agentName = target.name;
      session.history   = [];
      const u = session.cfg.users.get(session.from);
      if (u) { u.agentId = target.id; u.agentName = target.name; session.cfg.saveUsers(); }
      await speak(session, `Switching to ${target.name}! What's on your mind?`, session.voice);
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
async function streamReply(session, userText) {
  session.history.push({ role: 'user', content: userText });
  while (session.history.length > 60) session.history.shift();
  const outgoing = session.history.map((m, i) =>
    (i === session.history.length - 1 && m.role === 'user')
      ? { ...m, content: m.content + PHONE_SUFFIX }
      : m
  );

  session.llmAbort = false;
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

  streamer.on('sentence', (sentence) => {
    if (session.llmAbort) return;
    const synthInput = applyDirectionCarry(sentence, dirState);
    const synthPromise = synthesize(synthInput, session.voice).catch((e) => {
      console.error('[voice-stream] synthesis prefetch error:', e.message);
      return null;
    });
    playChain = playChain.then(async () => {
      if (session.llmAbort) return;
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
          if (d.token) { fullReply += d.token; if (!session.llmAbort) streamer.push(d.token); }
        } catch {}
      }
    });
    res.on('end', resolve);
    res.on('error', reject);
    const checkAbort = setInterval(() => {
      if (session.llmAbort) { clearInterval(checkAbort); res.destroy(); resolve(); }
    }, 100);
    res.on('close', () => clearInterval(checkAbort));
  });

  if (!session.llmAbort) streamer.end();
  await playChain;
  fillerCtx.firstAudioReady = true; // safety: stop the filler loop even on an empty/aborted reply
  if (fullReply) session.history.push({ role: 'assistant', content: fullReply });
  session.llmAbort = false;
}

// ── Synthesize → μ-law 8kHz ───────────────────────────────────────────────────
async function synthesize(text, voice) {
  const cfg = global._vsConfig;
  const input = fixPronunciation(text).slice(0, 4096);
  const useVoice = voice || cfg.defaultVoice;
  const res = await streamPost(
    `${cfg.ttsProxyUrl}/v1/audio/speech?telephony=1`,
    { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    { model: cfg.ttsModel, input, voice: useVoice }
  );
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

// ── Speak (one-shot, not streamed) ────────────────────────────────────────────
async function speak(session, text, voice) {
  try {
    const buf = await synthesize(text, voice || session.voice);
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
  while (!ctx.firstAudioReady && !session.llmAbort && session.ws.readyState === WebSocket.OPEN) {
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
          console.log(`[voice-stream] START sid=${streamSid} from=${from} user=${user?.name || 'unknown'}`);

          session.dgWs = openDeepgram(session);

          const name      = user?.name || 'there';
          const agentName = session.agentName;
          const knownGreetings = [
            `Hey ${name}! It's ${agentName}. What's going on?`,
            `${name}! Good to hear from you. What's up?`,
            `Hey, ${name}! ${agentName} here. Talk to me.`,
            `Oh it's ${name}! ${agentName} is in. What do you need?`,
            `${name}! What's the move? I'm listening.`,
            `Hey ${name}, ${agentName} picked up. Go ahead.`,
            `It's ${agentName} — hey ${name}! What's good?`,
            `${name}! Caught me at a good time. What's on your mind?`,
            `Hey ${name}! What can I do for you today?`,
            `${name}, hey! Go ahead, I'm all ears.`,
            `There you are, ${name}! What's up?`,
            `Hey ${name} — ${agentName} speaking. What's happening?`,
            `Hi ${name}! What's on the agenda?`,
            `${name}! Glad you called. What's going on?`,
            `Hey ${name}, it's ${agentName}. Talk to me, what's up?`,
            `Oh hey, ${name}! Perfect timing. What do you need?`,
            `${name}! ${agentName} here, ready when you are.`,
            `Hey there, ${name}! What's the word?`,
            `${name}, hey! I'm here, go ahead.`,
            `Hi ${name} — ${agentName} picking up. What's up?`,
            `Hey ${name}! Good timing — what's going on?`,
            `${name}! What can I help with?`,
          ];
          const unknownGreetings = [
            `Hey! I don't think we've met — I'm ${agentName}. Go ahead and talk, I'm listening.`,
            `Hey there! New number, not sure who this is — I'm ${agentName}. What's up?`,
            `Oh hey! You can register at kademurdock dot com slash signup so I know who you are. But go ahead, I'm ${agentName}.`,
            `Hey! Didn't recognize the number — I'm ${agentName}. What can I do for you?`,
            `Hi! Don't think we've talked before — I'm ${agentName}. What's on your mind?`,
            `Hey, new caller! I'm ${agentName}. Go ahead, I'm listening.`,
            `Hi there! I'm ${agentName} — haven't met you yet. What's up?`,
            `Hey! I'm ${agentName}. Go ahead and tell me what's up — you can register later at kademurdock dot com slash signup if you want me to remember you.`,
            `Hello! I'm ${agentName}, and this is a new number to me. What can I help with?`,
            `Hey there! I'm ${agentName} — go ahead, I'm listening.`,
          ];
          const pool        = user ? knownGreetings : unknownGreetings;
          const greeting    = pool[Math.floor(Math.random() * pool.length)];

          // ── Dead-air fix: ringback tone while greeting synthesizes ─────────
          // The ~8-12s between call connect and first Kiana word used to be
          // total silence. Now: play US ring tone (440+480 Hz) immediately,
          // then the instant greeting audio is ready, clear it and speak.
          session._ringbackActive = true;
          playRingback(session).catch(console.error);

          synthesize(greeting, session.voice)
            .then(async (greetingBuf) => {
              session._ringbackActive = false; // stop ring loop
              session.sendClear();             // flush queued ring frames from Twilio buffer
              await new Promise(r => setTimeout(r, 120)); // brief gap after clear
              if (session.ws.readyState === WebSocket.OPEN) {
                await playBuffer(session, greetingBuf);
              }
              // Every call, not just first-timers -- Keighty's call: whoever's
              // in the room with the caller this time needs to hear it too,
              // so it has to stay short rather than gated to a one-time thing.
              if (session.ws.readyState === WebSocket.OPEN) {
                const orientation = ORIENTATION_LINES[Math.floor(Math.random() * ORIENTATION_LINES.length)];
                await speak(session, orientation, session.voice);
              }
            })
            .catch((err) => {
              session._ringbackActive = false;
              console.error('[voice-stream] greeting synthesis error:', err.message);
              speak(session, 'Hey, give me just a second.', session.voice).catch(() => {});
            });

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

module.exports = { attachMediaStreams };
