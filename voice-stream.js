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
 *   - Voice/agent switching still works via transcript detection
 *   - All Inworld voices preserved (nothing moves to ElevenLabs/Google)
 *   - Existing /voice Gather path untouched — still works as instant fallback
 *
 * Requires env vars:
 *   DEEPGRAM_API_KEY  — free tier: sign up at deepgram.com (45,000 min/month free)
 *   LIBRECHAT_PROXY_URL / LIBRECHAT_PROXY_SECRET  — already set (same as /librechat/ask)
 *   TTS_PROXY_URL     — Inworld TTS proxy URL (already used by main server.js)
 *   DEFAULT_PHONE_VOICE / PHONE_TTS_MODEL — already used by main server.js
 *
 * Called from server.js:
 *   const { attachMediaStreams } = require('./voice-stream');
 *   attachMediaStreams(httpServer, users, config);
 */

const WebSocket = require('ws');
const EventEmitter = require('events');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ── Helpers shared with server.js ─────────────────────────────────────────────
function fixPronunciation(t) {
  return t.replace(/\bKade\b/g, 'Kadie').replace(/\bkade\b/g, 'kadie');
}

const PHONE_SUFFIX =
  '\n\n[PHONE CALL — you are literally on the phone with this person right now. ' +
  'Talk the way you would on a real call: natural, warm, conversational. ' +
  'Long or short, whatever fits — if you are in the middle of something good, keep going. ' +
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

// ── SentenceStreamer ──────────────────────────────────────────────────────────
// Buffers LLM token stream and emits complete, speakable sentences the instant
// they're safely done (peek at the char after the terminator to decide).
class SentenceStreamer extends EventEmitter {
  constructor() {
    super();
    this._buf = '';
    this._abbrevs = new Set([
      'dr','mr','mrs','ms','prof','vs','etc','e.g','i.e','a.m','p.m','st','ave',
      'jr','sr','no','vol','fig','dept','inc','ltd','corp',
    ]);
  }

  push(token) {
    this._buf += token;
    this._flush(false);
  }

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

      // Number: "3.50", "2.5s"
      if (term === '.' && next && /\d/.test(next)) { pos = abs + 1; continue; }
      // Abbreviation
      const pre = this._buf.slice(0, abs).split(/\s+/).pop();
      if (term === '.' && this._isAbbrev(pre)) { pos = abs + 1; continue; }

      if (!next || /[\s.!?]/.test(next)) {
        let end = abs;
        while (end < this._buf.length && /[.!?]/.test(this._buf[end])) end++;
        const sentence = this._buf.slice(0, end).trim();
        if (sentence.length > 4) this.emit('sentence', sentence);
        this._buf = this._buf.slice(end).trimStart();
        pos = 0;
        // Safety flush if buffer grows huge
        if (this._buf.length > 1400) {
          this.emit('sentence', this._buf.trim());
          this._buf = '';
          break;
        }
        continue;
      }
      pos = abs + 1;
    }
  }
}

// ── μ-law decode (for Deepgram echo-check, not needed for output) ─────────────
// (Deepgram accepts raw μ-law bytes directly, no decode needed.)

// ── HTTP(S) helper — simple streaming fetch without axios ────────────────────
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
    this.speakStartedAt = 0;          // epoch ms when we started speaking (echo gate)
    this.lastSpokAt     = 0;          // epoch ms when Kiana STOPPED speaking (echo drain gate)
    this.bargedIn       = false;      // true once we barge-in this turn (prevent double)
    this.llmAbort       = null;       // set to true to cancel in-flight LLM
    this.dgWs           = null;       // Deepgram WebSocket
    this.partialBuf     = '';         // accumulate partial transcripts
    this.finalBuf       = '';         // confirmed final words this turn
    this.busy           = false;      // prevent overlapping turns
  }

  twSend(obj) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  sendMedia(mulawBuf) {
    this.twSend({
      event: 'media',
      streamSid: this.streamSid,
      media: { payload: mulawBuf.toString('base64') },
    });
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
  session.llmAbort = true;      // signal in-flight LLM loop to stop
  session.isSpeaking = false;
}

// ── Deepgram STT connection ────────────────────────────────────────────────────
function openDeepgram(session) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    console.warn('[voice-stream] DEEPGRAM_API_KEY not set — no STT');
    return null;
  }

  const params = new URLSearchParams({
    encoding: 'mulaw',
    sample_rate: '8000',
    channels: '1',
    model: 'nova-2-phonecall',
    smart_format: 'true',
    interim_results: 'true',
    utterance_end_ms: '1000',
    endpointing: '350',
    vad_events: 'true',
  });

  const dg = new WebSocket(
    `wss://api.deepgram.com/v1/listen?${params}`,
    { headers: { Authorization: `Token ${key}` } }
  );

  dg.on('open', () => console.log(`[voice-stream] Deepgram open ${session.streamSid}`));

  dg.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // SpeechStarted — do NOT barge-in here.
    // Deepgram fires SpeechStarted on acoustic echo of our own TTS audio leaking
    // back through the phone mic.  We wait for a real transcript instead.
    if (msg.type === 'SpeechStarted') return;

    // Results: collect transcript + echo-safe barge-in
    if (msg.type === 'Results') {
      const alt  = msg.channel?.alternatives?.[0];
      const text = (alt?.transcript || '').trim();
      if (!text) return;

      // Barge-in: user produced real text while we're speaking.
      // Guard: ignore the first 800ms of echo (Kiana's own voice looping back).
      if (session.isSpeaking && !session.bargedIn &&
          Date.now() - session.speakStartedAt > 800) {
        session.bargedIn = true;
        bargeIn(session);
      }

      if (msg.is_final) {
        session.finalBuf += (session.finalBuf ? ' ' : '') + text;
      }
      if (msg.speech_final && session.finalBuf) {
        const utterance = session.finalBuf.trim();
        session.finalBuf = '';
        session.partialBuf = '';
        // Ignore if Kiana is speaking (echo) or within 500ms of stopping (echo drain)
        const echoWindow = session.isSpeaking || (Date.now() - session.lastSpokAt < 500);
        if (!echoWindow) handleUtterance(session, utterance);
      }
      return;
    }

    // UtteranceEnd fallback
    if (msg.type === 'UtteranceEnd' && session.finalBuf) {
      const utterance = session.finalBuf.trim();
      session.finalBuf = '';
      const echoWindow = session.isSpeaking || (Date.now() - session.lastSpokAt < 500);
      if (!echoWindow) handleUtterance(session, utterance);
    }
  });

  dg.on('error', (e) => console.error('[voice-stream] Deepgram error:', e.message));
  dg.on('close', () => console.log(`[voice-stream] Deepgram closed ${session.streamSid}`));

  return dg;
}

// ── Handle a completed utterance ──────────────────────────────────────────────
async function handleUtterance(session, text) {
  text = text.trim();
  if (!text || text.length < 2) return;
  if (session.busy) {
    console.log(`[voice-stream] busy, dropping utterance: "${text}"`);
    return;
  }
  console.log(`[voice-stream] utterance: "${text.slice(0, 80)}"`);
  session.busy = true;
  try {
    // Voice switch?
    const newVoice = extractVoiceSwitch(text);
    if (newVoice) {
      session.voice = newVoice;
      const u = session.cfg.users.get(session.from);
      if (u) { u.voice = newVoice; session.cfg.saveUsers(); }
      await speak(session, `Switching to ${newVoice}'s voice! Go ahead.`, newVoice);
      return;
    }

    // Agent switch?
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

    // Normal turn — stream the reply
    await streamReply(session, text);
  } catch (err) {
    console.error('[voice-stream] utterance error:', err.message);
    try { await speak(session, 'Sorry, something went wrong. Go ahead.', session.voice); } catch {}
  } finally {
    session.busy = false;
  }
}

// ── Stream LLM reply sentence-by-sentence ─────────────────────────────────────
async function streamReply(session, userText) {
  // Build message list
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
  // Pipeline: sentences complete asynchronously; we synthesize + play each in order.
  // Use an ordered promise chain so audio is always sequential.
  let playChain = Promise.resolve();

  streamer.on('sentence', (sentence) => {
    if (session.llmAbort) return;
    // Fire synthesis immediately (concurrent with playback of previous sentence).
    // .catch(() => null) ensures the promise ALWAYS resolves so it can never
    // cause an unhandled rejection if llmAbort causes us to return before awaiting it.
    const synthPromise = synthesize(sentence, session.voice).catch((e) => {
      console.error('[voice-stream] synthesis prefetch error:', e.message);
      return null;
    });
    // Chain playback in order — await the already-started promise
    playChain = playChain.then(async () => {
      if (session.llmAbort) return;
      const mulawBuf = await synthPromise;
      if (mulawBuf && !session.llmAbort) await playBuffer(session, mulawBuf);
    });
  });

  // Open SSE stream to the TTS proxy
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
          if (d.token) {
            fullReply += d.token;
            if (!session.llmAbort) streamer.push(d.token);
          }
        } catch {}
      }
    });
    res.on('end', resolve);
    res.on('error', reject);
    // If barge-in happens mid-stream, destroy the response to stop network traffic
    const checkAbort = setInterval(() => {
      if (session.llmAbort) { clearInterval(checkAbort); res.destroy(); resolve(); }
    }, 100);
    res.on('close', () => clearInterval(checkAbort));
  });

  if (!session.llmAbort) streamer.end();

  // Wait for any in-flight sentence to finish playing
  await playChain;

  if (fullReply && !session.llmAbort) {
    session.history.push({ role: 'assistant', content: fullReply });
  }
  session.llmAbort = false;
}

// ── Synthesize a sentence to μ-law 8kHz raw bytes ────────────────────────────
async function synthesize(text, voice) {
  const cfg = global._vsConfig; // set in attachMediaStreams
  const input = fixPronunciation(text).slice(0, 4096);
  const useVoice = voice || cfg.defaultVoice;

  const res = await streamPost(
    `${cfg.ttsProxyUrl}/v1/audio/speech?telephony=1`,
    {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
    { model: cfg.ttsModel, input, voice: useVoice }
  );

  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

// ── Speak a one-shot message (not streamed) ───────────────────────────────────
async function speak(session, text, voice) {
  try {
    const buf = await synthesize(text, voice || session.voice);
    await playBuffer(session, buf);
  } catch (e) {
    console.error('[voice-stream] speak error:', e.message);
  }
}

// ── Play μ-law bytes as 20ms Twilio media frames ─────────────────────────────
const FRAME_BYTES = 160; // 8kHz × 20ms × 1 byte/sample = 160 bytes

async function playBuffer(session, mulawBuf) {
  if (!mulawBuf || !mulawBuf.length) return;
  if (session.ws.readyState !== WebSocket.OPEN) return;
  // Clear any accumulated echo transcripts from before this playback slot
  session.finalBuf       = '';
  session.partialBuf     = '';
  session.isSpeaking     = true;
  session.speakStartedAt = Date.now();
  session.bargedIn       = false;

  // Pace: send one 20ms frame every 20ms.
  // We target wall-clock time rather than just sleeping 20ms after each frame
  // so timer jitter doesn't accumulate over long utterances.
  const start = Date.now();
  let frameIdx = 0;
  const totalFrames = Math.ceil(mulawBuf.length / FRAME_BYTES);

  while (frameIdx < totalFrames) {
    if (session.llmAbort || !session.isSpeaking || session.ws.readyState !== WebSocket.OPEN) break;
    const offset = frameIdx * FRAME_BYTES;
    const slice  = mulawBuf.slice(offset, offset + FRAME_BYTES);
    // Pad last frame
    const frame  = slice.length === FRAME_BYTES
      ? slice
      : Buffer.concat([slice, Buffer.alloc(FRAME_BYTES - slice.length)]);
    session.sendMedia(frame);
    frameIdx++;
    // Sleep until the next frame's wall-clock deadline
    const nextDeadline = start + frameIdx * 20;
    const wait = nextDeadline - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }

  if (!session.llmAbort) {
    session.isSpeaking = false;
    session.lastSpokAt = Date.now(); // echo drain gate starts now
  }
}

// ── Attach WebSocket Media Streams handler to an HTTP server ──────────────────
function attachMediaStreams(server, users, cfg) {
  // cfg: { proxyUrl, proxySecret, ttsProxyUrl, ttsModel, defaultVoice,
  //        defaultAgent, defaultAgentName, getAgents, saveUsers }
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

          // Open Deepgram connection
          session.dgWs = openDeepgram(session);

          // Play greeting — pick a fresh one each call so it never sounds canned
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
          ];
          const unknownGreetings = [
            `Hey! I don't think we've met — I'm Kiana. Go ahead and talk, I'm listening.`,
            `Hey there! New number, not sure who this is — I'm Kiana. What's up?`,
            `Oh hey! You can register at kademurdock dot com slash signup so I know who you are. But go ahead, I'm Kiana.`,
            `Hey! Didn't recognize the number — I'm Kiana. What can I do for you?`,
          ];
          const pool    = user ? knownGreetings : unknownGreetings;
          const greeting = pool[Math.floor(Math.random() * pool.length)];
          // Fire and forget — don't await so we don't block the WS message loop
          speak(session, greeting, session.voice).catch(console.error);
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
