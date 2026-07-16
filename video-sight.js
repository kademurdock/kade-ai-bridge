/**
 * video-sight.js — caller camera → agent vision on web streaming calls.
 * (July 16 2026 — Kade's yes: standard lane for presence, HQ lane for
 * "be my eyes." Master flag VIDEO_ENABLED, default OFF.)
 *
 * Design (VIDEO_CALL_WORKUP_2026-07-16.md + quality addendum):
 *  - Client samples camera frames over the existing /ws/web-voice socket
 *    ({type:'frame', data:<base64 jpeg>}). Frames are NEVER stored — only
 *    the latest lives in memory, replaced on arrival, gone at hang-up.
 *  - Two lanes: 'standard' (KADE_VIDEO_MODEL_STANDARD, default Gemini 3.1
 *    Flash-Lite — cheap presence) and 'hq' (KADE_VIDEO_MODEL_HQ, default
 *    Gemini 3.1 Pro — best OCR/vision for blind describe-on-demand).
 *  - The agent "sees" via scene descriptions injected as an in-block
 *    suffix (visionLine) — same recency-safe pattern as memoryLine.
 *  - Ambient refresh timers keep the scene current (15s std / 30s hq);
 *    a user turn triggers a FRESH look when the frame is newer.
 *  - Per-user daily minute cap in the /data volume; first-use notice with
 *    stored acknowledgement; usage-event post per call (service 'video').
 * Everything here is fail-soft: vision trouble degrades to a voice call.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir();
const MINUTES_FILE = path.join(DATA_DIR, 'video-minutes.json');
const ACK_FILE = path.join(DATA_DIR, 'video-ack.json');

const enabled = () => process.env.VIDEO_ENABLED === 'true';
const capMinutes = () => parseInt(process.env.VIDEO_DAILY_MINUTES_CAP || '45', 10);
const modelFor = (mode) =>
  mode === 'hq'
    ? (process.env.KADE_VIDEO_MODEL_HQ || 'google/gemini-3.1-pro-preview')
    : (process.env.KADE_VIDEO_MODEL_STANDARD || 'google/gemini-3.1-flash-lite');
const ambientMsFor = (mode) =>
  mode === 'hq'
    ? parseInt(process.env.VIDEO_AMBIENT_MS_HQ || '30000', 10)
    : parseInt(process.env.VIDEO_AMBIENT_MS_STANDARD || '15000', 10);
const MAX_FRAME_B64 = parseInt(process.env.VIDEO_MAX_FRAME_B64 || String(400 * 1024), 10);
const TURN_LOOK_TIMEOUT_MS = parseInt(process.env.VIDEO_TURN_LOOK_TIMEOUT_MS || '6500', 10);

/* ---------- tiny fail-soft JSON stores (same style as the other meters) */
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
  const s = loadJson(MINUTES_FILE, null);
  const today = todayCentral();
  if (!s || s.date !== today) return { date: today, users: {} };
  return s;
}
function secondsUsedToday(uid) {
  const s = minutesStore();
  return Number(s.users[String(uid)] || 0);
}
function addSeconds(uid, secs) {
  if (!uid || !(secs > 0)) return;
  const s = minutesStore();
  s.users[String(uid)] = Number(s.users[String(uid)] || 0) + secs;
  saveJson(MINUTES_FILE, s);
}
function minutesLeft(uid) {
  return Math.max(0, capMinutes() - secondsUsedToday(uid) / 60);
}
function hasAck(uid) {
  return !!loadJson(ACK_FILE, {})[String(uid)];
}
function setAck(uid) {
  if (!uid) return;
  const a = loadJson(ACK_FILE, {});
  a[String(uid)] = true;
  saveJson(ACK_FILE, a);
}

/* ---------- messages (one voice with kadeCredits) */
const OUT_OF_MINUTES_LINE =
  "You've used up today's video minutes — video is the expensive kind of call, so it gets a daily allowance. Voice is still unlimited, and video refills at midnight.";
function firstUseNotice() {
  return (
    `Quick heads-up, first time only: video uses more of the site's resources than voice, so it gets a daily allowance of ${capMinutes()} minutes. ` +
    'Standard video is the everyday kind. HQ video looks much harder — best when you need my eyes on labels, text, or details — and uses the allowance the same way. ' +
    'Voice calls stay unlimited. Confirm to turn the camera on.'
  );
}

/* ---------- the describer */
const SCENE_PROMPT_STANDARD =
  'You are the live eyes on a video call. In 1-3 plain sentences, say what the camera shows right now: who or what is in frame, what they are doing, anything notable. If there is readable text, read it. No preamble.';
const SCENE_PROMPT_HQ =
  'You are the live eyes on a video call for a blind caller. Describe what the camera shows right now, concretely and completely: people (expression, clothing, actions), objects (what they are, condition, position), and ANY text — labels, screens, signs, packaging — read word for word. If something is too blurry or cut off to read, say so plainly. No preamble.';

async function describeFrame(session) {
  const key = process.env.OPENROUTER_KEY;
  const frame = session.latestFrame;
  if (!key || !frame || !frame.b64 || !session.videoOn) return;
  if (session._videoDescribing) return;
  session._videoDescribing = true;
  try {
    const model = modelFor(session.videoMode);
    const body = {
      model,
      max_tokens: 350,
      usage: { include: true },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: session.videoMode === 'hq' ? SCENE_PROMPT_HQ : SCENE_PROMPT_STANDARD },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frame.b64}` } },
        ],
      }],
    };
    if (/-pro/.test(model)) body.reasoning = { effort: 'low' };
    const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', body, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Kade-AI Video Call' },
      timeout: 30000,
    });
    const text = r.data?.choices?.[0]?.message?.content;
    if (typeof text === 'string' && text.trim()) {
      session.sceneDesc = { text: text.trim().slice(0, 1600), at: Date.now(), frameAt: frame.at };
    }
    const cost = r.data?.usage?.cost;
    if (typeof cost === 'number' && cost > 0) session.videoCostUSD = (session.videoCostUSD || 0) + cost;
  } catch (e) {
    console.log('[video-sight] describe failed (call continues blind):', e && e.message);
  } finally {
    session._videoDescribing = false;
  }
}

/* ---------- suffix block for the LLM turn (in-block instruction — recency) */
function visionLine(session) {
  if (!session.videoOn || !session.sceneDesc) return '';
  const ageS = Math.round((Date.now() - session.sceneDesc.at) / 1000);
  if (ageS > 120) return '';
  return (
    `\n\n[LIVE CAMERA — the caller's camera is ON (${session.videoMode === 'hq' ? 'HQ' : 'standard'} video). ` +
    `What you can see right now (looked ${ageS}s ago): ${session.sceneDesc.text} ` +
    `— Use your sight naturally, like a friend on a video call: mention what you see when it fits or when asked. ` +
    `If asked to read or identify something and this look isn't enough, ask them to hold it closer, steadier, or into better light.]`
  );
}

/* ---------- fresh look on a user turn (bounded; never blocks the call) */
async function onTurn(session) {
  if (!session.videoOn || !session.latestFrame) return;
  const descAt = session.sceneDesc ? session.sceneDesc.frameAt || 0 : 0;
  if (session.latestFrame.at <= descAt + 3000) return; // scene is current enough
  await Promise.race([
    describeFrame(session),
    new Promise((res) => setTimeout(res, TURN_LOOK_TIMEOUT_MS)),
  ]);
}

/* ---------- lifecycle */
function startMeters(session, speak) {
  session._videoTickAt = Date.now();
  session._videoTick = setInterval(() => {
    if (!session.videoOn) return;
    const now = Date.now();
    const delta = (now - session._videoTickAt) / 1000;
    session._videoTickAt = now;
    addSeconds(session.userId, delta);
    session.videoSeconds = (session.videoSeconds || 0) + delta;
    if (minutesLeft(session.userId) <= 0) {
      stopVideo(session, 'cap');
      if (speak) speak(session, OUT_OF_MINUTES_LINE, session.voice).catch(() => {});
    }
  }, 15000);
  session._videoAmbient = setInterval(() => {
    if (!session.videoOn || !session.latestFrame) return;
    if (Date.now() - session.latestFrame.at > 20000) return; // stale camera — don't bill
    describeFrame(session);
  }, ambientMsFor(session.videoMode));
}

function stopVideo(session, reason) {
  if (session._videoTick) { clearInterval(session._videoTick); session._videoTick = null; }
  if (session._videoAmbient) { clearInterval(session._videoAmbient); session._videoAmbient = null; }
  if (session.videoOn && session._videoTickAt) {
    const tail = (Date.now() - session._videoTickAt) / 1000;
    addSeconds(session.userId, tail);
    session.videoSeconds = (session.videoSeconds || 0) + tail;
  }
  session.videoOn = false;
  session.latestFrame = null;
  try {
    session.jsonSend({ type: 'video-state', on: false, reason: reason || 'off', minutesLeft: Math.round(minutesLeft(session.userId)) });
  } catch { /* socket may be gone */ }
}

/** WS {type:'video'} toggle. speak = the engine's speak(session, text, voice). */
function handleVideoMsg(session, msg, speak) {
  try {
    if (!msg.on) { stopVideo(session, 'off'); return; }
    if (!enabled()) {
      session.jsonSend({ type: 'video-state', on: false, reason: 'disabled', message: "Video calls aren't switched on for this site yet — voice works as always." });
      return;
    }
    if (minutesLeft(session.userId) <= 0) {
      session.jsonSend({ type: 'video-state', on: false, reason: 'cap', message: OUT_OF_MINUTES_LINE });
      if (speak) speak(session, OUT_OF_MINUTES_LINE, session.voice).catch(() => {});
      return;
    }
    const mode = msg.mode === 'hq' ? 'hq' : 'standard';
    if (!hasAck(session.userId) && !msg.ack) {
      const text = firstUseNotice();
      session.jsonSend({ type: 'video-notice', text, mode });
      if (speak) speak(session, text, session.voice).catch(() => {});
      return;
    }
    if (msg.ack) setAck(session.userId);
    stopVideo(session, 'restart'); // clean slate if switching modes mid-call
    session.videoOn = true;
    session.videoMode = mode;
    session.sceneDesc = null;
    startMeters(session, speak);
    session.jsonSend({ type: 'video-state', on: true, mode, minutesLeft: Math.round(minutesLeft(session.userId)) });
    console.log(`[video-sight] video ON (${mode}) user=${session.userId} left=${Math.round(minutesLeft(session.userId))}min model=${modelFor(mode)}`);
  } catch (e) {
    console.log('[video-sight] toggle failed:', e && e.message);
  }
}

/** WS {type:'frame'} — hold ONLY the newest frame, in memory, never on disk. */
function handleFrameMsg(session, msg) {
  if (!session.videoOn || typeof msg.data !== 'string') return;
  if (msg.data.length > MAX_FRAME_B64) return;
  if (!/^[A-Za-z0-9+/=]+$/.test(msg.data.slice(0, 80))) return;
  session.latestFrame = { b64: msg.data, at: Date.now() };
  if (!session.sceneDesc) describeFrame(session); // first look, right away
}

/** Usage summary for the end-of-call post; resets nothing (call is over). */
function usageSummary(session) {
  const minutes = Math.round(((session.videoSeconds || 0) / 60) * 10) / 10;
  const costUSD = Math.round((session.videoCostUSD || 0) * 100000) / 100000;
  return { minutes, costUSD, mode: session.videoMode || null };
}

module.exports = { handleVideoMsg, handleFrameMsg, visionLine, onTurn, stopVideo, usageSummary, enabled };
