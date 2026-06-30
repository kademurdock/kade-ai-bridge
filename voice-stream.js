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

// ── Helpers ───────────────────────────────────────────────────────────────────
function fixPronunciation(t) {
  return t.replace(/\bKade\b/g, 'Kadie').replace(/\bkade\b/g, 'kadie');
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
      if (session.isSpeaking && !session.bargedIn && Date.now() - session.speakStartedAt > 800) {
        session.bargedIn = true;
        bargeIn(session);
      }
      if (msg.is_final) session.finalBuf += (session.finalBuf ? ' ' : '') + text;
      if (msg.speech_final && session.finalBuf) {
        const utterance = session.finalBuf.trim();
        session.finalBuf = '';
        session.partialBuf = '';
        const echoWindow = session.isSpeaking || (Date.now() - session.lastSpokAt < 500);
        if (!echoWindow) handleUtterance(session, utterance);
      }
      return;
    }

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

// ── Handle utterance ──────────────────────────────────────────────────────────
async function handleUtterance(session, text) {
  text = text.trim();
  if (!text || text.length < 2) return;
  if (session.busy) {
    if (!session.isSpeaking && !session.bargedIn) {
      console.log(`[voice-stream] aborting mid-gen for: "${text.slice(0,50)}"`);
      session.llmAbort = true;
      session.bargedIn = true;
      session._pending = text;
    } else {
      console.log(`[voice-stream] busy+speaking, dropping: "${text.slice(0,50)}"`);
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

  streamer.on('sentence', (sentence) => {
    if (session.llmAbort) return;
    const synthPromise = synthesize(sentence, session.voice).catch((e) => {
      console.error('[voice-stream] synthesis prefetch error:', e.message);
      return null;
    });
    playChain = playChain.then(async () => {
      if (session.llmAbort) return;
      const mulawBuf = await synthPromise;
      if (mulawBuf && !session.llmAbort) await playBuffer(session, mulawBuf);
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
  while (frameIdx < totalFrames) {
    if (session.llmAbort || !session.isSpeaking || session.ws.readyState !== WebSocket.OPEN) break;
    const offset = frameIdx * FRAME_BYTES;
    const slice  = mulawBuf.slice(offset, offset + FRAME_BYTES);
    const frame  = slice.length === FRAME_BYTES
      ? slice
      : Buffer.concat([slice, Buffer.alloc(FRAME_BYTES - slice.length)]);
    session.sendMedia(frame);
    frameIdx++;
    const wait = (start + frameIdx * 20) - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }

  if (!session.llmAbort) {
    session.isSpeaking = false;
    session.lastSpokAt = Date.now();
  }
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
          ];
          const unknownGreetings = [
            `Hey! I don't think we've met — I'm Kiana. Go ahead and talk, I'm listening.`,
            `Hey there! New number, not sure who this is — I'm Kiana. What's up?`,
            `Oh hey! You can register at kademurdock dot com slash signup so I know who you are. But go ahead, I'm Kiana.`,
            `Hey! Didn't recognize the number — I'm Kiana. What can I do for you?`,
          ];
          const pool     = user ? knownGreetings : unknownGreetings;
          const greeting = pool[Math.floor(Math.random() * pool.length)];

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
