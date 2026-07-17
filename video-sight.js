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
// ADMIN CAP EXEMPTION (July 17 2026, mirrors video-live.js): listed accounts
// ignore the daily video-minutes cap; metering still records for the dashboard.
const exemptEmails = () => String(process.env.VIDEO_CAP_EXEMPT_EMAILS || 'kademurdock@gmail.com')
  .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const capExempt = (session) => {
  try { return !!session && exemptEmails().includes(String(session.lcEmail || '').toLowerCase()); }
  catch { return false; }
};
const modelFor = (mode) =>
  mode === 'hq'
    ? (process.env.KADE_VIDEO_MODEL_HQ || 'google/gemini-3.1-pro-preview')
    : (process.env.KADE_VIDEO_MODEL_STANDARD || 'google/gemini-3.1-flash-lite');
const ambientMsFor = (mode) =>
  mode === 'hq'
    ? parseInt(process.env.VIDEO_AMBIENT_MS_HQ || '20000', 10)
    : parseInt(process.env.VIDEO_AMBIENT_MS_STANDARD || '15000', 10);
const MAX_FRAME_B64 = parseInt(process.env.VIDEO_MAX_FRAME_B64 || String(400 * 1024), 10);
const TURN_LOOK_TIMEOUT_MS = parseInt(process.env.VIDEO_TURN_LOOK_TIMEOUT_MS || '6500', 10);
// (July 16 2026, gap-coverage): a short rolling log of DETECTED CHANGES, not
// every raw snapshot -- covers "did anything happen while I wasn't looking"
// without breaking turn-taking (still only surfaced when asked) and without
// any new API calls (the diff below is a cheap local heuristic).
const SCENE_LOG_MAX_ENTRIES = parseInt(process.env.VIDEO_SCENE_LOG_MAX_ENTRIES || '6', 10);
const SCENE_LOG_MAX_AGE_MS = parseInt(process.env.VIDEO_SCENE_LOG_MAX_AGE_MS || String(5 * 60 * 1000), 10);
// (July 16 2026, watch-and-alert -- Kade's yes, character-voice alerts): the
// caller can say "watch for my cat and tell me when it shows up." The agent
// arms a watch via an invisible [watch: ...] tag; a CHEAP dedicated checker
// (flash-lite, one word back) looks at a frame every few seconds; the moment
// the condition is visibly true the engine hands the character an automatic
// alert turn -- the ONLY deliberate exception to strict turn-taking, and it
// exists because the caller explicitly asked to be interrupted. Costs:
// ~$0.00003 per check (under a nickel per hour armed), one normal LLM turn
// per fired alert. One watch at a time; one-shot (disarms after firing);
// auto-expires; dies with video off. Kill switch: VIDEO_WATCH_ENABLED=false.
const watchEnabled = () => process.env.VIDEO_WATCH_ENABLED !== 'false';
const WATCH_INTERVAL_MS = parseInt(process.env.VIDEO_WATCH_INTERVAL_MS || '5000', 10);
const watchModel = () => process.env.KADE_VIDEO_WATCH_MODEL || 'google/gemini-3.1-flash-lite';
const WATCH_MAX_AGE_MS = parseInt(process.env.VIDEO_WATCH_MAX_AGE_MS || String(30 * 60 * 1000), 10);

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
    `Quick heads-up, first time only: video uses more of the site's resources than voice, so it gets a daily allowance of ${capMinutes()} minutes — voice calls themselves stay unlimited, and you can turn the camera off anytime without hanging up to stop the clock. ` +
    'Standard video uses your front camera for everyday presence. HQ video uses your rear camera and looks much harder — best when you need my eyes on labels, text, or small details. ' +
    "Either way: point the camera at what you want me to see and hold it steady a moment, especially in good light. I'll check in on my own as we talk, and the moment you ask me anything, I always take a brand-new look first. " +
    'Confirm to turn the camera on.'
  );
}

/* ---------- the describer */
const SCENE_PROMPT_STANDARD =
  'You are the live eyes on a video call. In 1-3 plain sentences, say what the camera shows right now: who or what is in frame, what they are doing, anything notable, and roughly where it is (left, right, center, near, far) if that is not obvious. If there is readable text, read it. No preamble.';
const SCENE_PROMPT_HQ =
  'You are the live eyes on a video call for a blind caller who may be using this to get oriented in a space. Describe what the camera shows right now, concretely and completely: people (expression, clothing, actions), objects (what they are, condition, position), and ANY text — labels, screens, signs, packaging — read word for word. Always include plain spatial layout: what is to the left, right, and straight ahead, and roughly how far away (arm\'s reach, across the room, etc.); call out anything that matters for moving safely (steps, drop-offs, obstacles, doorways, furniture edges) if visible. If something is too blurry, too close, cut off, or badly lit to read or place confidently, say so plainly and suggest what would help (hold steadier, back up, more light). No preamble.';

/* ---------- cheap local change-detector (no API call, pure text compare) */
function sceneChanged(prevText, newText) {
  if (!prevText) return true;
  const words = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const a = new Set(words(prevText));
  const b = new Set(words(newText));
  if (!a.size || !b.size) return true;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const overlap = shared / Math.max(a.size, b.size);
  return overlap < 0.6; // under 60% word overlap counts as a real change
}

/* ---------- prune the rolling change-log by age + count */
function pruneSceneLog(session) {
  if (!session.sceneLog) { session.sceneLog = []; return; }
  const cutoff = Date.now() - SCENE_LOG_MAX_AGE_MS;
  session.sceneLog = session.sceneLog.filter((e) => e.at >= cutoff).slice(-SCENE_LOG_MAX_ENTRIES);
}

function describeFrame(session) {
  // One describe at a time per session; callers can AWAIT the in-flight one
  // (fixes the first-turn race: frame arrival kicks off the first look, and
  // the user's first utterance must wait for THAT, not skip seeing at all).
  if (session._videoDescribePromise) return session._videoDescribePromise;
  session._videoDescribePromise = _describeFrame(session).finally(() => {
    session._videoDescribePromise = null;
  });
  return session._videoDescribePromise;
}

async function _describeFrame(session) {
  const key = process.env.OPENROUTER_KEY;
  const frame = session.latestFrame;
  if (!key || !frame || !frame.b64 || !session.videoOn) return;
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
      const prev = session.sceneDesc;
      session.sceneDesc = { text: text.trim().slice(0, 1600), at: Date.now(), frameAt: frame.at };
      // (July 16 2026, gap-coverage) only log a NEW entry when the scene
      // actually changed -- keeps the log from filling up with repeat
      // "empty room" looks while still catching "a car pulled up".
      if (sceneChanged(prev && prev.text, session.sceneDesc.text)) {
        if (!session.sceneLog) session.sceneLog = [];
        session.sceneLog.push({ text: session.sceneDesc.text, at: session.sceneDesc.at });
      }
      pruneSceneLog(session);
    }
    const cost = r.data?.usage?.cost;
    if (typeof cost === 'number' && cost > 0) session.videoCostUSD = (session.videoCostUSD || 0) + cost;
  } catch (e) {
    console.log('[video-sight] describe failed (call continues blind):', e && e.message);
  }
}

/* ---------- watch-and-alert (July 16 2026) ------------------------------- */
// The engine (voice-stream.js) registers HOW an alert gets delivered -- a
// callback that runs a real character turn when the line is quiet. Kept as a
// registration to avoid a circular require (voice-stream requires this file).
let _deliverAlert = null;
function onAlert(fn) { _deliverAlert = fn; }

function disarmWatch(session, reason) {
  if (session._videoWatchTimer) { clearInterval(session._videoWatchTimer); session._videoWatchTimer = null; }
  if (session.watch) {
    console.log(`[video-sight] watch disarmed (${reason || 'off'}): "${session.watch.condition}" user=${session.userId}`);
    session.watch = null;
  }
}

function armWatch(session, condition) {
  if (!watchEnabled() || !session.videoOn || !condition) return;
  const cond = String(condition).trim().slice(0, 160);
  if (!cond) return;
  disarmWatch(session, 'replaced'); // one watch at a time -- new one wins
  session.watch = { condition: cond, armedAt: Date.now(), firing: false };
  session._videoWatchTimer = setInterval(() => { checkWatch(session).catch(() => {}); }, WATCH_INTERVAL_MS);
  console.log(`[video-sight] watch ARMED: "${cond}" user=${session.userId} every ${WATCH_INTERVAL_MS}ms`);
}

async function checkWatch(session) {
  const w = session.watch;
  const key = process.env.OPENROUTER_KEY;
  if (!w || w.firing || !session.videoOn || !key) return;
  if (Date.now() - w.armedAt > WATCH_MAX_AGE_MS) {
    const cond = w.condition;
    disarmWatch(session, 'expired');
    // Say so -- a watch the caller is counting on must never die silently.
    if (_deliverAlert) {
      _deliverAlert(session,
        `[AUTOMATIC WATCH NOTICE — system message, not the caller speaking. The watch for "${cond}" has been running ${Math.round(WATCH_MAX_AGE_MS / 60000)} minutes without seeing it, so it just switched itself off to save resources. Briefly let them know in your own voice, and that they can just ask again to re-arm it.]`);
    }
    return;
  }
  const frame = session.latestFrame;
  if (!frame || Date.now() - frame.at > 20000) return; // stale camera -- skip this tick
  try {
    const body = {
      model: watchModel(),
      max_tokens: 4,
      usage: { include: true },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `Watch condition: "${w.condition}". Look at the image. Answer with exactly one word — YES if the condition is clearly and visibly true in this image right now, otherwise NO. If unsure, answer NO.` },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frame.b64}` } },
        ],
      }],
    };
    const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', body, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Kade-AI Video Watch' },
      timeout: 15000,
    });
    const cost = r.data?.usage?.cost;
    if (typeof cost === 'number' && cost > 0) session.videoCostUSD = (session.videoCostUSD || 0) + cost;
    const answer = String(r.data?.choices?.[0]?.message?.content || '').trim();
    if (!/^YES\b/i.test(answer)) return;
    // Condition is TRUE. Take one fresh, full look (best available detail for
    // the alert itself), then hand the character an automatic alert turn.
    w.firing = true;
    console.log(`[video-sight] watch HIT: "${w.condition}" user=${session.userId}`);
    try { await describeFrame(session); } catch { /* alert still fires without a fresh look */ }
    const desc = session.sceneDesc && session.sceneDesc.text ? session.sceneDesc.text : 'no fresh description available';
    const cond = w.condition;
    disarmWatch(session, 'fired');
    if (_deliverAlert) {
      _deliverAlert(session,
        `[AUTOMATIC WATCH ALERT — system message, not the caller speaking. The thing they asked you to watch for — "${cond}" — just became visible on camera. Fresh look: ${desc} — Speak up right now and tell them, briefly and naturally, in your own voice; they asked for exactly this interruption. The watch is now off — mention in passing that they can say "keep watching" or ask again if they want you to keep looking.]`);
    }
  } catch (e) {
    console.log('[video-sight] watch check failed (will retry next tick):', e && e.message);
  }
}

/* ---------- suffix block for the LLM turn (in-block instruction — recency) */
function visionLine(session) {
  if (!session.videoOn || !session.sceneDesc) return '';
  const ageS = Math.round((Date.now() - session.sceneDesc.at) / 1000);
  if (ageS > 120) return '';
  // (July 16 2026, gap-coverage) anything logged BEFORE the current look --
  // lets a turn answer "did anything happen" even though a snapshot used to
  // just overwrite the last one with nothing kept. Capped small on purpose:
  // this is for answering a direct question, not a transcript, and the
  // instruction below is explicit that it's not a cue to narrate on its own.
  const recent = (session.sceneLog || [])
    .filter((e) => e.at < session.sceneDesc.at)
    .slice(-3);
  const recentBlock = recent.length
    ? ` Earlier changes noticed since the camera came on (only mention these if asked something like "did anything happen" or "what changed" -- do not volunteer this list on your own): ${recent
        .map((e) => `${Math.round((Date.now() - e.at) / 1000)}s ago, ${e.text}`)
        .join(' | ')}.`
    : '';
  // (July 16 2026, watch-and-alert) the model needs to know it CAN watch,
  // how to arm/disarm (invisible tags, stripped before speech/captions), and
  // what is currently armed so it never re-arms or denies an active watch.
  const watchBlock = watchEnabled()
    ? (session.watch
        ? ` A WATCH IS ARMED: you are watching for "${session.watch.condition}" (armed ${Math.round((Date.now() - session.watch.armedAt) / 60000)}m ago; an automatic checker looks every few seconds and will hand you an alert the moment it's seen — trust it, don't keep bringing it up). If they ask you to stop watching, include the tag [watch off] in your reply.`
        : ` If the caller asks you to WATCH for something and let them know when it appears or happens (like "tell me when the dryer light goes off" or "watch for a car in the driveway"), acknowledge briefly and include the exact tag [watch: what to look for, a few plain words] in your reply — the tag is invisible to them and arms an automatic checker that looks every few seconds, then prompts you to speak up the moment it's seen, even mid-quiet. One watch at a time; a new [watch: ...] replaces the old.`)
    : '';
  return (
    `\n\n[LIVE CAMERA — the caller's camera is ON (${session.videoMode === 'hq' ? 'HQ' : 'standard'} video). ` +
    `What you can see right now (looked ${ageS}s ago): ${session.sceneDesc.text}` +
    `${recentBlock} ` +
    `— Use your sight naturally, like a friend on a video call: mention what you see when it fits or when asked. ` +
    `If asked to read or identify something and this look isn't enough, ask them to hold it closer, steadier, or into better light.` +
    `${watchBlock}]`
  );
}

/* ---------- fresh look on a user turn (bounded; never blocks the call) */
async function onTurn(session) {
  if (!session.videoOn || !session.latestFrame) return;
  const descAt = session.sceneDesc ? session.sceneDesc.frameAt || 0 : 0;
  const inFlight = session._videoDescribePromise;
  if (!inFlight && session.latestFrame.at <= descAt + 3000) return; // scene is current enough
  await Promise.race([
    inFlight || describeFrame(session),
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
    if (!capExempt(session) && minutesLeft(session.userId) <= 0) {
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
  session.sceneLog = []; // (July 16 2026, gap-coverage) clean slate per on/off cycle
  disarmWatch(session, reason || 'video off'); // (watch-and-alert) watches die with video
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
    if (!capExempt(session) && minutesLeft(session.userId) <= 0) {
      session.jsonSend({ type: 'video-state', on: false, reason: 'cap', message: OUT_OF_MINUTES_LINE });
      if (speak) speak(session, OUT_OF_MINUTES_LINE, session.voice).catch(() => {});
      return;
    }
    // KADE July 16 2026 (late night): ONE video quality — HQ for EVERYONE,
    // kids included (her explicit call, cost stated: ~$0.007/min vs standard's
    // ~$0.001, worst case ~$0.32/user/day under the existing 45-min cap).
    // Three modes (standard/HQ/live) confused people; now it's Video and your
    // Spotter, that's it. The standard lane's code stays (env-controlled
    // models/cadence), it just can't be reached from a toggle anymore.
    const mode = 'hq';
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
    {
      const st = { type: 'video-state', on: true, mode };
      if (!capExempt(session)) st.minutesLeft = Math.round(minutesLeft(session.userId));
      session.jsonSend(st);
    }
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

module.exports = { handleVideoMsg, handleFrameMsg, visionLine, onTurn, stopVideo, usageSummary, enabled, armWatch, disarmWatch, onAlert };
