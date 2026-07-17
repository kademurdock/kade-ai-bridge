/**
 * video-live.js — EXPERIMENTAL Gemini Live lane for web calls (July 16 2026).
 *
 * What this is: the true-streaming path (the "glasses dream") — continuous
 * audio+video into Google's Live API over a stateful WebSocket, spoken audio
 * back, with the model itself deciding when to speak (proactive audio). This
 * is a DIFFERENT technology than video-sight.js's snapshot lane: it is a
 * direct Google integration (OpenRouter does NOT proxy the Live API — confirmed
 * July 16 2026), so it needs its own key and its own metering.
 *
 * Status: SCAFFOLD, shipped OFF. Hard-inert unless BOTH are set on Railway:
 *   LIVE_ENABLED=true
 *   GOOGLE_LIVE_API_KEY=<AI Studio key — free tier exists>
 * Until then every entry point returns immediately and the module is dead
 * weight by design. First activation is expected to need a tuning session
 * (audio formats and protocol field names verified against live docs then) —
 * this file exists so that session starts at 80% instead of 0%.
 *
 * Cost reality (checked July 16 2026, ai.google.dev pricing):
 *   audio in ~32 tok/s + video in ~258 tok/s @1fps at ~$3/M input tokens,
 *   audio out ~25 tok/s at ~$12/M output tokens
 *   ≈ $0.05–0.06/min continuous ≈ $3.30/hour — roughly 8× the HQ snapshot
 *   lane. Hence its own SMALL daily cap, separate from video minutes.
 *
 * Design decisions already made (so the tuning session doesn't relitigate):
 *  - The Live session BECOMES the voice for that call segment (Google's TTS,
 *    not Inworld) — the character's personality carries via systemInstruction,
 *    but the VOICE will differ. This is disclosed to the caller in the
 *    first-use notice. A later hybrid (Live with TEXT responses piped into
 *    Inworld TTS to keep the character's voice, trading latency) is sketched
 *    in NEXT steps but NOT built here.
 *  - Frames ride the same {type:'frame'} client message the snapshot lane
 *    uses; when live mode is on they're forwarded instead of described.
 *  - Metering mirrors video-sight.js exactly (own /data file, own cap).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
let WebSocketClient = null;
try { WebSocketClient = require('ws'); } catch { /* ws is a bridge dep already */ }

// Binary WS frame prefix for raw Live PCM shipped to the browser ("RIFF" = WAV
// clip, "LIVE" = raw 24kHz PCM16 chunk). Keep in sync with useStreamingCall.ts.
const LIVE_AUDIO_MAGIC = Buffer.from('LIVE');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir();
const LIVE_MINUTES_FILE = path.join(DATA_DIR, 'live-minutes.json');
const LIVE_ACK_FILE = path.join(DATA_DIR, 'live-ack.json');

const enabled = () => process.env.LIVE_ENABLED === 'true' && !!process.env.GOOGLE_LIVE_API_KEY;
const capMinutes = () => parseInt(process.env.LIVE_DAILY_MINUTES_CAP || '15', 10);
const liveModel = () => process.env.LIVE_MODEL || 'models/gemini-3.1-flash-live-preview';
const LIVE_HOST = process.env.LIVE_WS_HOST || 'generativelanguage.googleapis.com';
// Live API bidi endpoint. VERIFIED LIVE July 16 2026 (sandbox WS round-trip,
// real audio back): v1alpha accepts `proactivity` at setup top level and
// returned audio/pcm;rate=24000; v1beta REJECTS the proactivity field
// entirely (1007 close). Stay on v1alpha until proactivity graduates.
const LIVE_API_VERSION = process.env.LIVE_API_VERSION || 'v1alpha';
const liveUrl = () =>
  `wss://${LIVE_HOST}/ws/google.ai.generativelanguage.${LIVE_API_VERSION}.GenerativeService.BidiGenerateContent?key=${process.env.GOOGLE_LIVE_API_KEY}`;

/* ---------- meters (same fail-soft style as video-sight) */
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj)); } catch { /* meter loss ≠ call loss */ }
}
function todayCentral() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date());
}
function minutesStore() {
  const s = loadJson(LIVE_MINUTES_FILE, null);
  const today = todayCentral();
  if (!s || s.date !== today) return { date: today, users: {} };
  return s;
}
function addSeconds(uid, secs) {
  if (!uid || !(secs > 0)) return;
  const s = minutesStore();
  s.users[String(uid)] = Number(s.users[String(uid)] || 0) + secs;
  saveJson(LIVE_MINUTES_FILE, s);
}
function minutesLeft(uid) {
  const s = minutesStore();
  return Math.max(0, capMinutes() - Number(s.users[String(uid)] || 0) / 60);
}
function hasAck(uid) { return !!loadJson(LIVE_ACK_FILE, {})[String(uid)]; }
function setAck(uid) { if (!uid) return; const a = loadJson(LIVE_ACK_FILE, {}); a[String(uid)] = true; saveJson(LIVE_ACK_FILE, a); }

const OUT_OF_LIVE_LINE =
  "You've used today's live-mode minutes — live mode is the most expensive thing on the site, so it gets a small daily allowance. Regular video and voice still work, and live mode refills at midnight.";
function firstUseNotice() {
  return (
    `Quick heads-up, first time only: live mode streams continuous video and audio to a different, more expensive engine — it gets its own small daily allowance of ${capMinutes()} minutes, separate from regular video. ` +
    'Two honest differences while live mode is on: my voice will sound different (the live engine speaks for itself), and I may occasionally chime in on my own when I see something worth mentioning — that is the point of live mode. ' +
    'Say "live off" or press the button again to go back to normal anytime. Confirm to start.'
  );
}

/* ---------- session plumbing (relay skeleton) */
function buildSetupMessage(session) {
  // The character's persona carries into the Live session via systemInstruction.
  // session.persona is not currently threaded into web sessions — the tuning
  // session should pull the agent's instructions the same way the greeting
  // path does, or accept a generic live-eyes persona for v1.
  const personaText =
    (session.livePersona && String(session.livePersona).slice(0, 8000)) ||
    `You are ${session.agentName || 'the caller\'s AI companion'} on a live video call with ${session.callerName || 'the caller'}, who may be blind or low-vision. ` +
    'Describe what matters, read text word for word when asked, give spatial layout (left/right/ahead, rough distance), and warn about hazards. ' +
    'Speak up on your own only when something genuinely worth mentioning happens or appears; otherwise let the caller lead.';
  return {
    setup: {
      model: liveModel(),
      generationConfig: {
        responseModalities: ['AUDIO'],
        // speechConfig / voice selection: pick at tuning time.
      },
      systemInstruction: { parts: [{ text: personaText }] },
      // Proactive audio — the model decides when to speak. VERIFIED July 16
      // 2026: on v1alpha this field lives at the TOP LEVEL of `setup` (NOT
      // inside generationConfig — both nestings 1007-close on v1beta, and
      // generationConfig nesting closes on v1alpha too).
      proactivity: { proactiveAudio: true },
    },
  };
}

function startLive(session, speak) {
  if (!enabled()) {
    try { session.jsonSend({ type: 'live-state', on: false, reason: 'disabled', message: "Live mode isn't switched on for this site yet — regular video works as always." }); } catch {}
    return;
  }
  if (minutesLeft(session.userId) <= 0) {
    try { session.jsonSend({ type: 'live-state', on: false, reason: 'cap', message: OUT_OF_LIVE_LINE }); } catch {}
    if (speak) speak(session, OUT_OF_LIVE_LINE, session.voice).catch(() => {});
    return;
  }
  if (!WebSocketClient) { console.log('[video-live] ws module missing'); return; }
  try {
    const gws = new WebSocketClient(liveUrl());
    session._liveWs = gws;
    session.liveOn = false; // true after setupComplete
    gws.on('open', () => {
      try { gws.send(JSON.stringify(buildSetupMessage(session))); } catch (e) { console.log('[video-live] setup send failed:', e.message); }
    });
    gws.on('message', (raw) => handleGoogleMessage(session, raw));
    gws.on('close', (code) => { console.log('[video-live] google ws closed', code); stopLive(session, 'closed'); });
    gws.on('error', (e) => { console.log('[video-live] google ws error:', e && e.message); stopLive(session, 'error'); });
  } catch (e) {
    console.log('[video-live] start failed (call continues normally):', e && e.message);
  }
}

function handleGoogleMessage(session, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.setupComplete) {
    session.liveOn = true;
    session._liveTickAt = Date.now();
    session._liveTick = setInterval(() => {
      if (!session.liveOn) return;
      const now = Date.now();
      const secs = (now - session._liveTickAt) / 1000;
      addSeconds(session.userId, secs);
      session.liveSecondsTotal = Number(session.liveSecondsTotal || 0) + secs;
      session._liveTickAt = now;
      if (minutesLeft(session.userId) <= 0) stopLive(session, 'cap');
    }, 15000);
    try { session.jsonSend({ type: 'live-state', on: true, minutesLeft: Math.round(minutesLeft(session.userId)) }); } catch {}
    // Hand-off hook (set by voice-stream): stands the snapshot video lane
    // down so its wall-clock meter stops while live owns the camera. Fired
    // AFTER the live-state send so the client flips its live flag first and
    // knows to keep the camera rolling through the video-state off event.
    try { session.onLiveUp && session.onLiveUp(); } catch {}
    console.log(`[video-live] LIVE session up user=${session.userId} model=${liveModel()}`);
    return;
  }
  // Spoken audio back from Google: 24kHz PCM16 chunks (verified live:
  // mime audio/pcm;rate=24000). Ship each chunk to the browser as a binary
  // WS frame prefixed with the 4-byte magic "LIVE" — WAV clips start with
  // "RIFF", so the client can route unambiguously and schedule raw PCM via
  // Web Audio (fork useStreamingCall.ts, same gapless chain as WAV clips).
  const parts = msg.serverContent && msg.serverContent.modelTurn && msg.serverContent.modelTurn.parts;
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (p.inlineData && p.inlineData.data) {
        try {
          const pcm = Buffer.from(p.inlineData.data, 'base64');
          if (pcm.length && session.ws && session.ws.readyState === 1) {
            session.ws.send(Buffer.concat([LIVE_AUDIO_MAGIC, pcm]), { binary: true });
          }
        } catch { /* one dropped chunk ≠ dead lane */ }
      }
    }
  }
  if (msg.serverContent && msg.serverContent.interrupted) {
    try { session.sendClear && session.sendClear(); } catch {}
  }
}

/** Browser mic audio while live: forward as 16kHz PCM chunks. */
function forwardAudio(session, b64pcm16k) {
  const gws = session._liveWs;
  if (!session.liveOn || !gws || gws.readyState !== 1) return;
  try {
    // realtimeInput.mediaChunks is DEPRECATED-REJECTED (verified July 16 2026:
    // server 1007-closes with "Use audio, video, or text instead").
    gws.send(JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: b64pcm16k } } }));
  } catch { /* fail-soft */ }
}

/** Camera frames while live: reuse the existing {type:'frame'} messages. */
function forwardFrame(session, b64jpeg) {
  const gws = session._liveWs;
  if (!session.liveOn || !gws || gws.readyState !== 1) return;
  try {
    gws.send(JSON.stringify({ realtimeInput: { video: { mimeType: 'image/jpeg', data: b64jpeg } } }));
  } catch { /* fail-soft */ }
}

function stopLive(session, reason) {
  if (session._liveTick) { clearInterval(session._liveTick); session._liveTick = null; }
  if (session.liveOn && session._liveTickAt) {
    const secs = (Date.now() - session._liveTickAt) / 1000;
    addSeconds(session.userId, secs);
    session.liveSecondsTotal = Number(session.liveSecondsTotal || 0) + secs;
  }
  session.liveOn = false;
  // Flush any Live audio still queued in the browser so "live off" is instant.
  try { session.sendClear && session.sendClear(); } catch {}
  const gws = session._liveWs;
  session._liveWs = null;
  if (gws) { try { gws.close(); } catch {} }
  try { session.jsonSend({ type: 'live-state', on: false, reason: reason || 'off', minutesLeft: Math.round(minutesLeft(session.userId)) }); } catch {}
}

/** WS {type:'live'} toggle from the client (client button not built yet). */
function handleLiveMsg(session, msg, speak) {
  try {
    if (!msg.on) { stopLive(session, 'off'); return; }
    if (!enabled()) { startLive(session, speak); return; } // sends the disabled notice
    if (!hasAck(session.userId) && !msg.ack) {
      const text = firstUseNotice();
      try { session.jsonSend({ type: 'live-notice', text }); } catch {}
      if (speak) speak(session, text, session.voice).catch(() => {});
      return;
    }
    if (msg.ack) setAck(session.userId);
    startLive(session, speak);
  } catch (e) {
    console.log('[video-live] toggle failed:', e && e.message);
  }
}

module.exports = { enabled, handleLiveMsg, forwardAudio, forwardFrame, stopLive, minutesLeft };
// Exported for the pre-push test harness only — not called across modules.
module.exports._test = { buildSetupMessage, handleGoogleMessage, liveUrl };
