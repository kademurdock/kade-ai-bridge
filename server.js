/**
 * kade-ai-bridge — voice call bridge for Kade-AI
 *
 * Env vars (Railway):
 *   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER
 *   LIBRECHAT_URL / LIBRECHAT_EMAIL / LIBRECHAT_PASSWORD
 *   DEFAULT_AGENT_ID  — fallback agent (Kiana)
 *   BRIDGE_SECRET     — protects /register & /users
 *   PORT / PUBLIC_URL — set automatically by Railway
 */

'use strict';

const express  = require('express');
const http     = require('http');
const http2    = require('http2');
const { attachMediaStreams, attachWebVoice, synthesize: vsSynthesize, handleAmdResult: vsHandleAmd } = require('./voice-stream');
const twilio   = require('twilio');
const axios    = require('axios');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');

const app  = express();
const port = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const TWILIO_SID      = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const LIBRECHAT_URL   = (process.env.LIBRECHAT_URL || 'https://kademurdock.com').replace(/\/$/, '');
const LIBRECHAT_EMAIL = process.env.LIBRECHAT_EMAIL;
const LIBRECHAT_PASS  = process.env.LIBRECHAT_PASSWORD;
const PROXY_URL    = (process.env.LIBRECHAT_PROXY_URL || 'https://inworld-tts-proxy-production.up.railway.app').replace(/\/$/, '');
const PROXY_SECRET = process.env.LIBRECHAT_PROXY_SECRET || '';
const DEFAULT_AGENT      = process.env.DEFAULT_AGENT_ID || 'agent_6llV0eMu4fmIaj8f2x1Sb';
const DEFAULT_AGENT_NAME = 'Kiana';
// July 13 2026 security sweep: NO default secret — with the env unset every
// admin route must refuse, not open under a publicly-known fallback value.
const BRIDGE_SECRET   = process.env.BRIDGE_SECRET || '';
// Header-first secret check (query strings land in edge logs); query/body
// still accepted so existing callers keep working.
function bridgeSecretOk(req, provided) {
  if (!BRIDGE_SECRET) return false;
  const h = req.get && req.get('x-bridge-secret');
  return h === BRIDGE_SECRET || provided === BRIDGE_SECRET;
}

// July 15 2026: SCOPED secret for the agent /notify primitive only. Agents send
// this (never BRIDGE_SECRET); a leak of it can at most fire rate-capped, guard-
// railed notifications and can NOT reach any admin route. /notify accepts either.
const NOTIFY_AGENT_SECRET = process.env.NOTIFY_AGENT_SECRET || '';
function notifySecretOk(req, provided) {
  if (bridgeSecretOk(req, provided)) return true;
  if (!NOTIFY_AGENT_SECRET) return false;
  const h = req.get && req.get('x-notify-secret');
  return h === NOTIFY_AGENT_SECRET || provided === NOTIFY_AGENT_SECRET;
}
const PUBLIC_URL      = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.PUBLIC_URL || 'http://localhost:3000');
// A phone bridge must not die because one async callback raced a hang-up.
// Unhandled rejections get logged loudly and the process stays up; genuinely
// unknown exceptions still exit(1) so Railway restarts us into a clean state.
process.on('unhandledRejection', (err) => {
  console.error('[bridge] UNHANDLED REJECTION (process kept alive):', err);
});
process.on('uncaughtException', (err) => {
  console.error('[bridge] UNCAUGHT EXCEPTION (exiting for clean restart):', err);
  process.exit(1);
});

const TTS_PROXY_URL      = 'https://inworld-tts-proxy-production.up.railway.app';
const DEFAULT_PHONE_VOICE = process.env.DEFAULT_PHONE_VOICE || 'Kiana (Comedian)';
const PHONE_BRIEF = 'SYSTEM NOTE (not from the caller): You are on a live phone call. ' +
  'Keep every response under two sentences. No markdown, no lists, no asterisks — ' +
  'plain spoken words only. Be warm and natural.';

// ── Pronunciation fixes ───────────────────────────────────────────────────────
// "Kade" (the person) is pronounced "Kadie" — fix it before sending to TTS.
// fixPronunciation: shared — see voice-commands.js

// ── Phone voice list — SHARED (voice-commands.js) since July 13 2026 ────────
const { PHONE_VOICES, findVoice, extractVoiceSwitch, VOICE_IDENTIFY_REGEX, PHONE_SUFFIX,
        fixPronunciation, editDistance, phoneticFold, stripSwitchPadding, extractSwitchTarget, findAgent, fuzzyFindAgent, BROWSER_UA, scrubTranscriptText } = require('./voice-commands');


const SIGNUP_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>Register your phone — Kade AI</title>\n  <style>\n    * { box-sizing: border-box; margin: 0; padding: 0; }\n    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e8e8e8; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 1rem; }\n    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 2rem; width: 100%; max-width: 400px; }\n    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }\n    p { color: #999; font-size: 0.9rem; margin-bottom: 1.5rem; line-height: 1.5; }\n    label { display: block; font-size: 0.85rem; color: #ccc; margin-bottom: 0.35rem; }\n    input { width: 100%; padding: 0.65rem 0.85rem; background: #111; border: 1px solid #333; border-radius: 8px; color: #e8e8e8; font-size: 1rem; margin-bottom: 1rem; }\n    input:focus { outline: none; border-color: #555; }\n    button { width: 100%; padding: 0.75rem; background: #7c3aed; border: none; border-radius: 8px; color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer; }\n    button:hover { background: #6d28d9; }\n    .msg { margin-top: 1rem; padding: 0.75rem; border-radius: 8px; font-size: 0.9rem; text-align: center; display: none; }\n    .msg.ok { background: #14532d; color: #86efac; display: block; }\n    .msg.err { background: #450a0a; color: #fca5a5; display: block; }\n  </style>\n</head>\n<body>\n  <div class=\"card\">\n    <h1>Register your phone</h1>\n    <p>So the AI knows who you are when you call in to the Kade AI line.</p>\n    <form id=\"f\">\n      <label for=\"name\">Your name</label>\n      <input id=\"name\" name=\"name\" type=\"text\" placeholder=\"Mom\" required autocomplete=\"name\">\n      <label for=\"phone\">Phone number</label>\n      <input id=\"phone\" name=\"phone\" type=\"tel\" placeholder=\"417-555-1234\" required autocomplete=\"tel\">\n      <button type=\"submit\">Register</button>\n    </form>\n    <div id=\"msg\" class=\"msg\"></div>\n  </div>\n  <script>\n    document.getElementById('f').addEventListener('submit', async e => {\n      e.preventDefault();\n      const btn = e.target.querySelector('button');\n      btn.disabled = true; btn.textContent = 'Registering...';\n      const msg = document.getElementById('msg');\n      msg.className = 'msg'; msg.textContent = '';\n      try {\n        const r = await fetch('/signup', {\n          method: 'POST',\n          headers: { 'Content-Type': 'application/json' },\n          body: JSON.stringify({ name: document.getElementById('name').value.trim(), phone: document.getElementById('phone').value.trim() })\n        });\n        const d = await r.json();\n        if (d.ok) { msg.className = 'msg ok'; msg.textContent = \"You're registered! Next time you call, the AI will know your name.\"; e.target.reset(); }\n        else { msg.className = 'msg err'; msg.textContent = d.error || 'Something went wrong. Try again.'; }\n      } catch { msg.className = 'msg err'; msg.textContent = 'Network error. Try again.'; }\n      btn.disabled = false; btn.textContent = 'Register';\n    });\n  </script>\n</body>\n</html>";

// findVoice: shared — see voice-commands.js

// extractVoiceSwitch: shared — see voice-commands.js

function getTwilioClient() {
  if (!TWILIO_SID || !TWILIO_TOKEN || TWILIO_SID === 'FILL_IN') return null;
  try { return twilio(TWILIO_SID, TWILIO_TOKEN); }
  catch (e) { console.warn('[bridge] Twilio init failed:', e.message); return null; }
}
const twilioClient = getTwilioClient();

// ── Persistent user store ─────────────────────────────────────────────────────
// users: phone (E.164) → { name, agentId, agentName, lcEmail?, lcPass? }
// lcEmail/lcPass = real LibreChat account creds. Guests omit these and use admin token.
const USERS_FILE = path.join(
  process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(),
  'bridge-users.json'
);
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE))
      return new Map(Object.entries(JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))));
  } catch {}
  return new Map();
}
function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(Object.fromEntries(users))); }
  catch (e) { console.error('[bridge] Could not save users:', e.message); }
}
const users = loadUsers();

// -- "Seen before" tracking -- separate from the users map on purpose --------
// Used only to fire the one-time "translating your voice + thinking takes a
// sec" heads-up exactly once per number, per channel (call vs text), without
// touching the registration/name/agent data above.
const SEEN_CALL_FILE = path.join(
  process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(),
  'bridge-seen-call.json'
);
const SEEN_SMS_FILE = path.join(
  process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(),
  'bridge-seen-sms.json'
);
function loadSeenSet(file) {
  try { if (fs.existsSync(file)) return new Set(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch {}
  return new Set();
}
function saveSeenSet(file, set) {
  try { fs.writeFileSync(file, JSON.stringify([...set])); }
  catch (e) { console.error(`[bridge] Could not save ${path.basename(file)}:`, e.message); }
}
const seenCallNumbers = loadSeenSet(SEEN_CALL_FILE);
const seenSmsNumbers  = loadSeenSet(SEEN_SMS_FILE);

// In-memory state maps
const voiceStates = new Map(); // callSid → { from, agentId, agentName, history, step?, pendingName?, pendingEmail?, lcEmail?, lcPass? }
const convHistory = new Map(); // phone → [{role,content}] for SMS
const tempMedia   = new Map(); // id → { filePath, expires }

// ── LibreChat auth — admin token ───────────────────────────────────────────────
let _adminToken = null, _adminTokenExp = 0;
async function getLCToken() {
  if (_adminToken && Date.now() < _adminTokenExp) return _adminToken;
  const r = await axios.post(
    `${LIBRECHAT_URL}/api/auth/login`,
    { email: LIBRECHAT_EMAIL, password: LIBRECHAT_PASS },
    { headers: { 'User-Agent': BROWSER_UA }, timeout: 10000 }
  );
  _adminToken    = r.data.token;
  _adminTokenExp = Date.now() + 20 * 60 * 1000;
  return _adminToken;
}

// ── LibreChat auth — per-user token ────────────────────────────────────────────
const _userTokens = new Map(); // email → { token, expires }
async function getUserToken(email, password) {
  const cached = _userTokens.get(email);
  if (cached && Date.now() < cached.expires) return cached.token;
  const r = await axios.post(
    `${LIBRECHAT_URL}/api/auth/login`,
    { email, password },
    { headers: { 'User-Agent': BROWSER_UA }, timeout: 10000 }
  );
  _userTokens.set(email, { token: r.data.token, expires: Date.now() + 20 * 60 * 1000 });
  return r.data.token;
}

// Returns the right token for a call state — user's own if they have an account, admin otherwise
async function getTokenForCall(state) {
  if (state.lcEmail && state.lcPass) return getUserToken(state.lcEmail, state.lcPass);
  return getLCToken();
}

// ── LibreChat account creation ────────────────────────────────────────────────
async function createLCAccount(name, email, password) {
  await axios.post(
    `${LIBRECHAT_URL}/api/auth/register`,
    { name, email, password, confirm_password: password },
    { headers: { 'User-Agent': BROWSER_UA }, timeout: 15000 }
  );
}

// ── Spoken email parser ───────────────────────────────────────────────────────
// Handles "john at gmail dot com", "my email is jane underscore doe at outlook dot com", etc.
function parseSpokenEmail(text) {
  let s = text.toLowerCase().trim();
  s = s.replace(/^(?:my email(?: address)? is|email is|it's|its)\s+/i, '');
  s = s.replace(/\s+at\s+/g, '@');
  s = s.replace(/\s+dot\s+/g, '.');
  s = s.replace(/\s+underscore\s+/g, '_');
  s = s.replace(/\s+(?:dash|hyphen|minus)\s+/g, '-');
  s = s.replace(/\s+/g, '');
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : null;
}

// ── Agent cache ───────────────────────────────────────────────────────────────
let _agentCache = null, _agentCacheExp = 0;
async function getAgents() {
  if (_agentCache && Date.now() < _agentCacheExp) return _agentCache;
  try {
    const r = await axios.get(`${PROXY_URL}/librechat/agents`, {
      headers: { Authorization: `Bearer ${PROXY_SECRET}`, 'User-Agent': BROWSER_UA },
      timeout: 15000,
    });
    _agentCache    = (r.data.agents || []);
    _agentCacheExp = Date.now() + 60 * 60 * 1000;
    console.log(`[bridge] Agent cache: ${_agentCache.length} public agents`);
  } catch (e) {
    console.error('[bridge] Failed to fetch agents:', e.message);
    _agentCache = _agentCache || [];
  }
  return _agentCache;
}

// ── Agent TTS cache (July 2 2026) ────────────────────────────────────────────
// INBOUND calls used to ignore the agent's builder-set voice entirely
// (CallSession fell back to the platform default — Skylee heard "Kiana's"
// voice when calling Lilly). Outbound got the agent-record lookup in the
// July 2 rework; this cache gives inbound the same data with ZERO latency at
// call time. Refreshed at boot, on /register, and every 15 minutes for every
// distinct agentId in the registry. Works for PRIVATE agents too (the proxy's
// admin session can read them — verified live with Lilly).
const agentTtsCache = new Map(); // agentId -> { voiceId, rate }
async function refreshAgentTts(agentId) {
  if (!agentId) return;
  try {
    const r = await axios.get(`${PROXY_URL}/librechat/agent?id=${encodeURIComponent(agentId)}`, {
      headers: { Authorization: `Bearer ${PROXY_SECRET}`, 'User-Agent': BROWSER_UA },
      timeout: 15000,
    });
    const tts = r.data?.tts || {};
    agentTtsCache.set(agentId, {
      voiceId: tts.voiceId || null,
      rate: typeof tts.speakingRate === 'number' ? tts.speakingRate : null,
      at: Date.now(), // July 4 2026: lets voice-stream retry stale no-voice entries
    });
    console.log(`[bridge] Agent TTS cached: ${agentId} -> voice ${tts.voiceId || '(none)'} rate ${tts.speakingRate ?? '(default)'}`);
  } catch (e) {
    console.error(`[bridge] Agent TTS lookup failed for ${agentId}:`, e.message);
  }
}
function refreshAllAgentTts() {
  const ids = new Set([...users.values()].map((u) => u.agentId).filter(Boolean));
  for (const id of ids) refreshAgentTts(id);
}
setInterval(refreshAllAgentTts, 15 * 60 * 1000); // builder voice changes land within 15 min
// July 12 2026 (Kade's live catch: fresh deploys served the WRONG voice —
// "Kiana (Comedian)" name-match fallback — until the first 15-min tick):
// warm the cache IMMEDIATELY at boot. (July 13: the old duplicate 5s timer is
// gone — it double-fired every lookup through the proxy's paced queue.)
setTimeout(refreshAllAgentTts, 3000);
// July 13 2026 cache-race audit: the AGENTS LIST cache was lazy too — the
// first caller after every deploy paid the fetch (plus proxy pacing) MID-CALL
// during fuzzy agent switching. Warm it right after the TTS warm.
setTimeout(() => { getAgents().catch(() => {}); }, 6000);

// Fuzzy matching (July 2 2026): same code as voice-stream.js — STT/typos
// mangle invented names, so exact matching alone fails on the names that
// matter most.
// phoneticFold: shared — see voice-commands.js
// editDistance: shared — see voice-commands.js
// fuzzyFindAgent: shared — see voice-commands.js
// findAgent: shared — see voice-commands.js


// Padding stripper + widened patterns, mirrored from voice-stream.js (July 3
// 2026): polite phrasings ("Can you switch to Kiana?") must switch, not fall
// through to the LLM.
// stripSwitchPadding: shared — see voice-commands.js

// extractSwitchTarget: shared — see voice-commands.js

// ── AI call ────────────────────────────────────────────────────────────────────
// Appended to the LAST user turn on every call. A brevity note placed at the
// START of history (the old PHONE_BRIEF seed) was flatly ignored — Kiana wrote
// 2000+ char essays, which on the phone meant ~20-30s generation + minutes of
// TTS playback + wasted phone/TTS cost. Appending a forceful instruction right
// after the caller's words (recency) makes the model actually obey: replies drop
// to ~1-2 sentences and latency to ~3-8s. Kept out of stored history so it never
// accumulates.
// PHONE_SUFFIX: shared — see voice-commands.js

async function askAgent(agentId, history, userMessage) {
  history.push({ role: 'user', content: userMessage });
  while (history.length > 14) history.shift();
  // Send a copy with the brevity instruction glued onto the final user turn.
  const outgoing = history.map((m, i) =>
    (i === history.length - 1 && m.role === 'user')
      ? { ...m, content: m.content + PHONE_SUFFIX }
      : m
  );
  const r = await axios.post(
    `${PROXY_URL}/librechat/ask`,
    { agentId, messages: outgoing },
    {
      headers: { Authorization: `Bearer ${PROXY_SECRET}`, 'User-Agent': BROWSER_UA },
      timeout: 150000,
    }
  );
  const reply = r.data.text;
  if (!reply) throw new Error('Empty reply from agent');
  history.push({ role: 'assistant', content: reply });
  return reply;
}

// ── TTS + audio hosting ────────────────────────────────────────────────────────
// voice = null → use LibreChat's configured default (Kiana's voice)
// voice = "Sarah" etc → call the Inworld proxy directly with that voice name
async function synthesizeVoice(text, voice = null) {
  const input    = fixPronunciation(text).slice(0, 4096);
  const useVoice = voice || DEFAULT_PHONE_VOICE;
  const r = await axios.post(
    `${TTS_PROXY_URL}/v1/audio/speech`,
    { model: process.env.PHONE_TTS_MODEL || 'tts-1-mini', input, voice: useVoice },
    { responseType: 'arraybuffer', timeout: 30000 }
  );
  return Buffer.from(r.data);
}

function storeAudio(buffer) {
  const id = crypto.randomBytes(12).toString('hex');
  const fp = path.join(os.tmpdir(), `bridge-${id}.wav`);
  fs.writeFileSync(fp, buffer);
  tempMedia.set(id, { filePath: fp, expires: Date.now() + 5 * 60 * 1000 });
  setTimeout(() => { try { fs.unlinkSync(fp); } catch {} tempMedia.delete(id); }, 5 * 60 * 1000);
  return `${PUBLIC_URL}/media/${id}`;
}

async function playOrSay(twiml, text, voice = null) {
  try { twiml.play(storeAudio(await synthesizeVoice(text, voice))); }
  catch { twiml.say({ voice: 'alice' }, text); }
}

// Build TwiML that plays a message then re-records (used in async call updates)
async function buildReRecordTwiml(message, voice = null) {
  const vr = new twilio.twiml.VoiceResponse();
  await playOrSay(vr, message, voice);
  vr.record({
    action: '/voice/reply', method: 'POST',
    timeout: 5, maxLength: 120, playBeep: true,
    transcribe: true, transcribeCallback: '/voice/transcribed',
  });
  return vr.toString();
}

// Gather-based listen loop (replaces old Record+transcribeCallback).
async function buildListenTwiml(message, voice, callSid) {
  const vr = new twilio.twiml.VoiceResponse();
  if (message) await playOrSay(vr, message, voice);
  // A <Gather> embedded in TwiML injected via call.update does NOT reliably arm
  // speech recognition, and relative action URLs have no base to resolve against
  // when delivered over the REST API (that was the round-2 "no reply -> robot
  // hangs up" bug). Redirect (absolute URL) to a fresh webhook that serves the
  // Gather as a normal TwiML response -- the exact delivery path that works on
  // round 1 -- so every turn listens reliably.
  vr.redirect({ method: 'POST' }, `${PUBLIC_URL}/voice/listen/${callSid}`);
  return vr.toString();
}

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, users: users.size, rev: (process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown').slice(0, 7) }));

// Static opt-in / SMS consent disclosure image — used for Twilio toll-free verification.
app.get('/optin.png', (_req, res) => {
  res.sendFile(path.join(__dirname, 'optin.png'), (err) => {
    if (err) { res.status(404).send('not found'); }
  });
});

// ── Serve temp audio ──────────────────────────────────────────────────────────
app.get('/media/:id', (req, res) => {
  const e = tempMedia.get(req.params.id);
  if (!e || Date.now() > e.expires) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/wav');
  res.sendFile(path.resolve(e.filePath));
});

// ── Admin: register / list users ───────────────────────────────────────────────
app.post('/register', (req, res) => {
  const { phone, name, agentId, agentName, lcEmail, lcPass, secret, accountType } = req.body;
  if (!bridgeSecretOk(req, secret)) return res.status(403).json({ error: 'Unauthorized' });
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const digits = phone.replace(/\D/g, '');
  const e164   = digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
  const record = { name: name || 'Friend', agentId: agentId || DEFAULT_AGENT, agentName: agentName || DEFAULT_AGENT_NAME };
  if (lcEmail) record.lcEmail = lcEmail;
  if (lcPass)  record.lcPass  = lcPass;
  if (accountType === 'child') record.accountType = 'child'; // KADE July 3 2026
  users.set(e164, record);
  saveUsers();
  refreshAgentTts(record.agentId); // pick up the agent's builder voice for inbound calls
  console.log(`[bridge] Admin registered ${e164} → ${agentId || DEFAULT_AGENT} (${name})`);
  res.json({ ok: true, phone: e164 });
});

app.get('/users', (req, res) => {
  if (!bridgeSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
  res.json(Object.fromEntries(users));
});

// ── Push notifications (APNs) ───────────────────────────────────────────────────
// Device tokens come from the native iOS app (POST /push-register, no secret —
// a device token carries no privileges). Sending is admin-only (BRIDGE_SECRET),
// except the guardrailed agent path (see runNotify below).
// APNs auth is an ES256 JWT signed with the .p8 key; built-ins only (http2+crypto).
//
// pushTokens: Map<token, { userId: string|null, platform, registeredAt }>.
// userId links a device to a LibreChat user id (added July 2026 for multi-user
// check-ins — see /outreach). A token with userId===null is "unlinked": it still
// receives admin (/push-send) and global (/reachout) broadcasts for back-compat,
// but is invisible to per-user targeting (runNotify with a userId won't hit it).
const PUSH_FILE = path.join(
  process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(),
  'bridge-push-tokens.json'
);
function loadPushTokens() {
  try {
    if (fs.existsSync(PUSH_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(PUSH_FILE, 'utf8'));
      // Back-compat: the old file format was a plain array of tokens (no userId).
      if (Array.isArray(parsed)) return new Map(parsed.map((t) => [t, { userId: null, platform: 'ios', registeredAt: null }]));
      return new Map(Object.entries(parsed));
    }
  } catch {}
  return new Map();
}
const pushTokens = loadPushTokens();
function savePushTokens() {
  try { fs.writeFileSync(PUSH_FILE, JSON.stringify(Object.fromEntries(pushTokens))); }
  catch (e) { console.error('[push] Could not save tokens:', e.message); }
}
// All registered tokens belonging to one LibreChat user (for per-user targeting).
function tokensForUser(userId) {
  return [...pushTokens.entries()].filter(([, meta]) => meta && meta.userId === userId).map(([t]) => t);
}

const APNS_HOST      = process.env.APNS_HOST || 'https://api.push.apple.com';
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.kademurdock.kadeai';
const _toB64Url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let _apnsJwt = { token: null, iat: 0 };
function apnsAuthToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_apnsJwt.token && (now - _apnsJwt.iat) < 2400) return _apnsJwt.token; // reuse ~40 min
  const key = (process.env.APNS_KEY || '').replace(/\\n/g, '\n');
  const seg = (o) => _toB64Url(Buffer.from(JSON.stringify(o)));
  const signingInput = `${seg({ alg: 'ES256', kid: process.env.APNS_KEY_ID })}.${seg({ iss: process.env.APNS_TEAM_ID, iat: now })}`;
  const sig = _toB64Url(crypto.sign('SHA256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' }));
  _apnsJwt = { token: `${signingInput}.${sig}`, iat: now };
  return _apnsJwt.token;
}

function sendApnsPush(deviceToken, title, body) {
  return new Promise((resolve) => {
    let client;
    try { client = http2.connect(APNS_HOST); }
    catch (e) { return resolve({ token: deviceToken, status: 0, error: e.message }); }
    client.on('error', (e) => resolve({ token: deviceToken, status: 0, error: e.message }));
    const payload = JSON.stringify({ aps: { alert: { title, body }, sound: 'default' } });
    const r = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${apnsAuthToken()}`,
      'apns-topic': APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload)
    });
    let status = 0, data = '';
    r.on('response', (h) => { status = h[':status']; });
    r.setEncoding('utf8');
    r.on('data', (d) => { data += d; });
    r.on('end', () => { try { client.close(); } catch (e) {} resolve({ token: deviceToken, status, data }); });
    r.on('error', (e) => { try { client.close(); } catch (e2) {} resolve({ token: deviceToken, status: 0, error: e.message }); });
    r.write(payload);
    r.end();
  });
}

// App posts its device token here on launch. Public + validated (hex only).
// Optional `userId` (LibreChat user id) links the device to a person so agent
// check-ins can target them specifically; omit it and the token stays "unlinked"
// (back-compat: still reachable by admin/global broadcasts, not by per-user ones).
// CORS is scoped open here (and only here) because the web app itself calls this
// from inside the Capacitor webview at https://kademurdock.com, to attach the
// userId the native layer doesn't know (see PushTokenRegistrar in the fork).
app.options('/push-register', (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://kademurdock.com');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});
app.post('/push-register', (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://kademurdock.com');
  const token = String((req.body && req.body.token) || '').trim().toLowerCase();
  if (!/^[0-9a-f]{16,256}$/.test(token)) return res.status(400).json({ error: 'invalid token' });
  const userId = req.body && req.body.userId ? String(req.body.userId).trim().slice(0, 64) : '';
  const platform = (req.body && req.body.platform ? String(req.body.platform) : 'ios').slice(0, 20);
  const existing = pushTokens.get(token);
  pushTokens.set(token, {
    userId: userId || (existing && existing.userId) || null,
    platform: platform || (existing && existing.platform) || 'ios',
    registeredAt: (existing && existing.registeredAt) || new Date().toISOString(),
  });
  savePushTokens();
  const linked = pushTokens.get(token).userId;
  console.log(`[push] Registered a device token${linked ? ' (linked to a user)' : ' (unlinked)'} (total ${pushTokens.size})`);
  res.json({ ok: true, count: pushTokens.size, linked: !!linked });
});

// Admin: send a push to all devices (or one via `token`). Body: { secret, title?, body?, token? }
app.post('/push-send', async (req, res) => {
  const b = req.body || {};
  if (!bridgeSecretOk(req, b.secret)) return res.status(403).json({ error: 'Unauthorized' });
  if (!process.env.APNS_KEY || !process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID) {
    return res.status(500).json({ error: 'APNs not configured (APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID)' });
  }
  const title   = b.title || 'Kade-AI';
  const message = b.body;
  if (!message) return res.status(400).json({ error: 'body required' });
  // July 21 2026: no more silent everyone-blast (and no baked-in persona copy).
  // token = one device, userId = that user's linked devices, all:true = explicit broadcast.
  const targets = b.token ? [String(b.token).toLowerCase()]
    : b.userId ? tokensForUser(String(b.userId))
    : b.all === true ? [...pushTokens.keys()]
    : null;
  if (targets === null) return res.status(400).json({ error: 'target required: token, userId, or all:true (explicit broadcast)' });
  if (!targets.length) return res.json({ ok: true, sent: 0, note: 'no matching device tokens' });
  const results = await Promise.all(targets.map((t) => sendApnsPush(t, title, message)));
  let pruned = 0;
  results.forEach((r) => { if (r.status === 410 && pushTokens.delete(r.token)) pruned++; }); // 410 = dead token
  if (pruned) savePushTokens();
  const sent = results.filter((r) => r.status === 200).length;
  console.log(`[push] Sent ${sent}/${targets.length} (pruned ${pruned})`);
  res.json({ ok: true, sent, total: targets.length, pruned, statuses: results.map((r) => r.status) });
});

// Admin: list registered device tokens + which user (if any) each is linked to.
// Mirrors the /users pattern above. Useful for confirming a device linked after
// the app posts {token, userId}, or for manually linking one (re-POST /push-register
// with the same token + a userId — it upserts).
app.get('/push-tokens', (req, res) => {
  if (!bridgeSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
  res.json({ count: pushTokens.size, tokens: Object.fromEntries(pushTokens) });
});

// ── Agent notification primitive (guardrailed) ─────────────────────────────────
// Any agent calls POST /notify with who it is + a message. The BRIDGE enforces the
// anti-spam rules here, server-side, where no agent can bypass them: quiet hours,
// per-agent + global daily caps, a cooldown, and mute controls (see /notify-prefs).
const NOTIFY_PREFS_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(), 'bridge-notify-prefs.json');
function loadNotifyPrefs() {
  try { if (fs.existsSync(NOTIFY_PREFS_FILE)) return JSON.parse(fs.readFileSync(NOTIFY_PREFS_FILE, 'utf8')); } catch {}
  return { enabled: true, mutedAgents: [], perAgentDailyCap: 3, globalDailyCap: 6, cooldownMin: 30, quietStart: '21:00', quietEnd: '08:00' };
}
let notifyPrefs = loadNotifyPrefs();
function saveNotifyPrefs() { try { fs.writeFileSync(NOTIFY_PREFS_FILE, JSON.stringify(notifyPrefs)); } catch (e) { console.error('[notify] prefs save:', e.message); } }
let notifyCounts = { day: '', global: 0, perAgent: {}, lastSentMs: 0 };
function centralClock() {
  const s = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{2}):(\d{2})/);
  return m ? { day: `${m[3]}-${m[1]}-${m[2]}`, hhmm: `${m[4]}:${m[5]}` } : { day: 'x', hhmm: '12:00' };
}
function notifyInQuietHours(hhmm) { return hhmm >= notifyPrefs.quietStart || hhmm < notifyPrefs.quietEnd; }

// Core notify logic (guardrails + APNs send), shared by the /notify route AND the
// scheduled "Ki reaches out" job so caps / quiet-hours / cooldown apply to both.
async function runNotify({ agentId, agentName, title, body, urgent, userId, broadcast }) {
  agentId = String(agentId || 'unknown');
  agentName = String(agentName || 'Kade-AI').slice(0, 40);
  const message = String(body || '').trim().slice(0, 300);
  if (!message) return { ok: false, error: 'body required' };
  title = String(title || agentName).slice(0, 40);
  const { day, hhmm } = centralClock();
  if (notifyCounts.day !== day) notifyCounts = { day, global: 0, perAgent: {}, lastSentMs: notifyCounts.lastSentMs };
  // guardrails (server-side, unbypassable)
  if (!notifyPrefs.enabled) return { ok: false, blocked: 'notifications are globally muted' };
  if (notifyPrefs.mutedAgents.includes(agentId)) return { ok: false, blocked: 'this agent is muted' };
  if (!urgent && notifyInQuietHours(hhmm)) return { ok: false, blocked: 'quiet hours (Central)' };
  if (Date.now() - notifyCounts.lastSentMs < notifyPrefs.cooldownMin * 60000) return { ok: false, blocked: 'cooldown active' };
  if (notifyCounts.global >= notifyPrefs.globalDailyCap) return { ok: false, blocked: 'daily total cap reached' };
  if ((notifyCounts.perAgent[agentId] || 0) >= notifyPrefs.perAgentDailyCap) return { ok: false, blocked: 'per-agent daily cap reached' };
  // Per-user targeting: a userId restricts delivery to THAT person's linked
  // device(s) only — it never falls back to the full pool, so an unlinked or
  // not-yet-registered user gets zero targets, never someone else's phone.
  // July 21 2026: the old "no userId = broadcast to every registered device"
  // fallback is GONE — it delivered one person's private check-in to every
  // family phone (confirmed live: sent=3). Broadcast now requires the ADMIN
  // secret plus an explicit broadcast:true, and is never reachable by agents.
  const targets = userId ? tokensForUser(userId) : (broadcast === true ? [...pushTokens.keys()] : []);
  if (!targets.length) {
    if (!userId && broadcast !== true) return { ok: false, blocked: 'no target user (per-user sends need a userId; broadcast needs admin broadcast:true)' };
    return { ok: true, sent: 0, note: userId ? 'no device linked to this user yet' : 'no device tokens registered yet' };
  }
  const results = await Promise.all(targets.map((t) => sendApnsPush(t, title, message)));
  let pruned = 0; results.forEach((r) => { if (r.status === 410 && pushTokens.delete(r.token)) pruned++; }); if (pruned) savePushTokens();
  const sent = results.filter((r) => r.status === 200).length;
  if (sent > 0) { notifyCounts.global++; notifyCounts.perAgent[agentId] = (notifyCounts.perAgent[agentId] || 0) + 1; notifyCounts.lastSentMs = Date.now(); }
  console.log(`[notify] ${agentName} (${agentId}) sent=${sent} global=${notifyCounts.global}/${notifyPrefs.globalDailyCap}`);
  return { ok: true, sent, from: agentName, remainingToday: Math.max(0, notifyPrefs.globalDailyCap - notifyCounts.global) };
}

// Any agent -> user push. Body: { secret, agentId, agentName, title?, body, urgent? }
app.post('/notify', async (req, res) => {
  const b = req.body || {};
  if (!notifySecretOk(req, b.secret)) return res.status(403).json({ error: 'Unauthorized' });
  // Caller forensics (July 21 2026): one line per request so "who sent this"
  // never needs to be reconstructed from circumstantial evidence again.
  console.log(
    `[notify] caller=${bridgeSecretOk(req, b.secret) ? 'ADMIN' : 'agent-scoped'} agent=${String(b.agentId || '?').slice(0, 40)} userId=${b.userId ? String(b.userId).slice(0, 8) + '...' : 'NONE'} broadcast=${b.broadcast === true}`,
  );
  const out = await runNotify({ agentId: b.agentId, agentName: b.agentName, title: b.title, body: b.body, urgent: b.urgent, userId: b.userId, broadcast: bridgeSecretOk(req, b.secret) && b.broadcast === true });
  if (out.error) return res.status(400).json({ error: out.error });
  res.json(out);
});

// View / change notification preferences (admin). Body/query: secret; POST body may set
// enabled, perAgentDailyCap, globalDailyCap, cooldownMin, quietStart, quietEnd, muteAgent, unmuteAgent.
app.get('/notify-prefs', (req, res) => {
  if (!bridgeSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
  res.json({ prefs: notifyPrefs, today: notifyCounts });
});
app.post('/notify-prefs', (req, res) => {
  const b = req.body || {};
  if (!bridgeSecretOk(req, b.secret)) return res.status(403).json({ error: 'Unauthorized' });
  ['enabled', 'perAgentDailyCap', 'globalDailyCap', 'cooldownMin', 'quietStart', 'quietEnd'].forEach((k) => { if (b[k] !== undefined) notifyPrefs[k] = b[k]; });
  if (b.muteAgent) notifyPrefs.mutedAgents = [...new Set([...notifyPrefs.mutedAgents, String(b.muteAgent)])];
  if (b.unmuteAgent) notifyPrefs.mutedAgents = notifyPrefs.mutedAgents.filter((a) => a !== String(b.unmuteAgent));
  saveNotifyPrefs();
  res.json({ ok: true, prefs: notifyPrefs });
});

// ── Scheduled "Ki reaches out" (July 15 2026) ─────────────────────────────────
// On a schedule, ask Ki (headless) for a short warm check-in and deliver it
// through the SAME guardrailed notify path (quiet hours + caps + cooldown apply).
// Admin-tunable via /reachout; DEFAULT OFF until switched on.
const REACHOUT_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(), 'bridge-reachout.json');
const REACHOUT_AGENT_ID = DEFAULT_AGENT;
const REACHOUT_AGENT_NAME = DEFAULT_AGENT_NAME;
const REACHOUT_DEFAULT_PROMPT =
  "You are reaching out to Kade on your own initiative — you two haven't talked in a little while. " +
  "Write ONE short, warm check-in text (1 to 2 sentences, under 200 characters, easy to hear read aloud, " +
  "no emoji, in your natural voice) that gently checks in or shares a small thought to brighten her day. " +
  "Reply with ONLY the message text, nothing else.";
function loadReachout() {
  const base = { enabled: false, time: '18:00', days: 'daily', title: 'Ki', prompt: REACHOUT_DEFAULT_PROMPT, lastRun: '' };
  try { if (fs.existsSync(REACHOUT_FILE)) return { ...base, ...JSON.parse(fs.readFileSync(REACHOUT_FILE, 'utf8')) }; } catch {}
  return base;
}
let reachout = loadReachout();
function saveReachout() { try { fs.writeFileSync(REACHOUT_FILE, JSON.stringify(reachout)); } catch (e) { console.error('[reachout] save:', e.message); } }

async function fireReachout(urgent) {
  const text = await askAgentRich(REACHOUT_AGENT_ID, reachout.prompt);
  if (!text || !String(text).trim()) return { ok: false, error: 'agent returned no text' };
  const body = String(text).trim().replace(/^["']+|["']+$/g, '').slice(0, 280);
  // "Ki reaches out" is Kade's own personal check-in — deliver ONLY to her
  // linked devices (ADMIN_USER_ID env can override the baked-in default).
  const delivery = await runNotify({ agentId: REACHOUT_AGENT_ID, agentName: REACHOUT_AGENT_NAME, title: reachout.title || 'Ki', body, urgent: urgent === true, userId: process.env.ADMIN_USER_ID || '6a3cba4d0b0afa92194e42f7' });
  return { ok: true, generated: body, delivery };
}

// GET /reachout (admin) view · POST /reachout (admin) set enabled/time/days/prompt/title
app.get('/reachout', (req, res) => {
  if (!bridgeSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
  res.json({ reachout });
});
app.post('/reachout', (req, res) => {
  const b = req.body || {};
  if (!bridgeSecretOk(req, b.secret)) return res.status(403).json({ error: 'Unauthorized' });
  ['enabled', 'time', 'days', 'prompt', 'title'].forEach((k) => { if (b[k] !== undefined) reachout[k] = b[k]; });
  saveReachout();
  res.json({ ok: true, reachout });
});
// POST /reachout/fire (admin) — generate + send one NOW (testing). urgent:true skips quiet hours.
app.post('/reachout/fire', async (req, res) => {
  const b = req.body || {};
  if (!bridgeSecretOk(req, b.secret)) return res.status(403).json({ error: 'Unauthorized' });
  try { res.json(await fireReachout(b.urgent === true)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Minute tick: fire when the Central time matches and it hasn't already run today.
setInterval(async () => {
  try {
    if (!reachout.enabled) return;
    const { day, hhmm } = centralClock();
    if (reachout.time !== hhmm || reachout.lastRun === day) return;
    if (reachout.days && reachout.days !== 'daily') {
      const dow = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).toLowerCase().slice(0, 3);
      if (!String(reachout.days).toLowerCase().includes(dow)) return;
    }
    reachout.lastRun = day; saveReachout(); // set first so a slow generate can't double-fire
    const r = await fireReachout(false);
    console.log(`[reachout] fired: ${r.ok ? ('sent=' + (r.delivery && r.delivery.sent) + ' blocked=' + ((r.delivery && r.delivery.blocked) || '-')) : ('error=' + r.error)}`);
  } catch (e) {
    console.error('[reachout] tick error:', e.message);
  }
}, 60 * 1000);



// ── SMS webhook ────────────────────────────────────────────────────────────────
app.post('/sms', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const from  = req.body.From;
  const body  = (req.body.Body || '').trim();
  if (!body) { res.type('text/xml').send(twiml.toString()); return; }
  console.log(`[sms] from=${from} body="${body}"`);
  const user    = users.get(from) || { agentId: DEFAULT_AGENT, agentName: DEFAULT_AGENT_NAME, name: 'there' };
  const history = convHistory.get(from) || [];
  convHistory.set(from, history);
  const isFirstText = !seenSmsNumbers.has(from);
  try {
    const reply = await askAgent(user.agentId, history, body);
    // Game Parlor cue tokens are for audio surfaces; never show them in a text
    let outText = reply.replace(/\[(?:sound:[a-z0-9_]+|table:[a-z0-9]{1,12})\]/gi, '').replace(/[ \t]{2,}/g, ' ').trim();
    if (isFirstText) {
      outText += "\n\n(Quick heads up: replies can take a few seconds -- reading your message and thinking it through, not stuck.)";
      seenSmsNumbers.add(from);
      saveSeenSet(SEEN_SMS_FILE, seenSmsNumbers);
    }
    try {
      const wav = await synthesizeVoice(reply);
      const msg = twiml.message();
      msg.body(outText);
      msg.media(storeAudio(wav));
    } catch { twiml.message(outText); }
  } catch (err) {
    console.error('[sms] Error:', err.message);
    twiml.message("Sorry, I'm having trouble right now. Try again in a moment.");
  }
  res.type('text/xml').send(twiml.toString());
});

// ── Voice: inbound call ────────────────────────────────────────────────────────
app.post('/voice', async (req, res) => {
  const twiml   = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const from    = req.body.From;
  const user    = users.get(from);
  console.log(`[voice] inbound from=${from} callSid=${callSid} known=${!!user}`);

  if (!user) {
    // New caller — ask for name
    voiceStates.set(callSid, { from, agentId: DEFAULT_AGENT, agentName: DEFAULT_AGENT_NAME, history: [] });
    await playOrSay(twiml, "Hey! I don't have you on file yet. What's your name?");
    twiml.gather({ input: 'speech', speechTimeout: 'auto', timeout: 8,
      action: `/voice/setup-name/${callSid}`, method: 'POST' });
    twiml.say({ voice: 'alice' }, "I didn't catch that. Call back anytime!");
    twiml.hangup();
  } else {
    // Returning caller — short greeting, straight to record
    voiceStates.set(callSid, {
      from, agentId: user.agentId, agentName: user.agentName || DEFAULT_AGENT_NAME,
      history: [], lcEmail: user.lcEmail, lcPass: user.lcPass, voice: user.voice || null,
    });
    await playOrSay(twiml,
      `Hey ${user.name}! You're with ${user.agentName || DEFAULT_AGENT_NAME}. ` +
      `Go ahead — say "switch to" and a name anytime to change agents, or "switch voice to" a voice name to change how I sound.`,
      user.voice || null
    );
    twiml.gather({ input: 'speech', speechTimeout: 'auto', timeout: 10,
      action: `/voice/heard/${callSid}`, method: 'POST' });
    twiml.say({ voice: 'alice' }, 'Still there? Call back anytime!');
    twiml.hangup();
  }
  res.type('text/xml').send(twiml.toString());
});

// ── Voice setup step 1: name ──────────────────────────────────────────────────
app.post('/voice/setup-name/:callSid', async (req, res) => {
  const twiml   = new twilio.twiml.VoiceResponse();
  const callSid = req.params.callSid;
  const state   = voiceStates.get(callSid);
  const name    = (req.body.SpeechResult || '').trim() || 'Friend';

  if (state) state.pendingName = name;

  await playOrSay(twiml,
    `Nice to meet you, ${name}! To set up your own account so the AI remembers you between calls, ` +
    `what's your email address? Say it like "john at gmail dot com", or say skip to chat as a guest.`
  );
  twiml.gather({ input: 'speech', speechTimeout: 'auto', timeout: 12,
    action: `/voice/setup-email/${callSid}`, method: 'POST' });
  // If they don't say anything, register as guest
  twiml.redirect({ method: 'POST' }, `/voice/setup-guest/${callSid}`);

  res.type('text/xml').send(twiml.toString());
});

// ── Voice setup step 2: email ─────────────────────────────────────────────────
app.post('/voice/setup-email/:callSid', async (req, res) => {
  const twiml   = new twilio.twiml.VoiceResponse();
  const callSid = req.params.callSid;
  const state   = voiceStates.get(callSid);
  const speech  = (req.body.SpeechResult || '').trim().toLowerCase();

  // "skip" → guest
  if (/^skip/.test(speech) || !speech) {
    return res.type('text/xml').send(await buildGuestRegistration(twiml, callSid));
  }

  const email = parseSpokenEmail(speech);
  if (!email) {
    await playOrSay(twiml,
      `I couldn't make that out as an email address. Try again — say it like "john at gmail dot com", or say skip.`
    );
    twiml.gather({ input: 'speech', speechTimeout: 'auto', timeout: 12,
      action: `/voice/setup-email/${callSid}`, method: 'POST' });
    twiml.redirect({ method: 'POST' }, `/voice/setup-guest/${callSid}`);
    return res.type('text/xml').send(twiml.toString());
  }

  if (state) state.pendingEmail = email;

  await playOrSay(twiml, `I heard ${email.replace('@', ' at ').replace(/\./g, ' dot ')}. Say yes to confirm, or no to try again.`);
  twiml.gather({ input: 'speech', speechTimeout: 'auto', timeout: 8,
    action: `/voice/setup-confirm/${callSid}`, method: 'POST' });
  twiml.redirect({ method: 'POST' }, `/voice/setup-guest/${callSid}`);

  res.type('text/xml').send(twiml.toString());
});

// ── Voice setup step 3: confirm email ────────────────────────────────────────
app.post('/voice/setup-confirm/:callSid', async (req, res) => {
  const twiml   = new twilio.twiml.VoiceResponse();
  const callSid = req.params.callSid;
  const state   = voiceStates.get(callSid);
  const speech  = (req.body.SpeechResult || '').trim().toLowerCase();

  if (/^y(es|ep|eah)?/.test(speech) && state?.pendingEmail) {
    // Confirmed — create the account
    const name     = state.pendingName || 'Friend';
    const email    = state.pendingEmail;
    const password = crypto.randomBytes(10).toString('base64url');

    try {
      await createLCAccount(name, email, password);
      console.log(`[voice] created LibreChat account for ${state.from}: ${email}`);

      // Update state + persist user
      state.lcEmail = email;
      state.lcPass  = password;
      users.set(state.from, {
        name, agentId: DEFAULT_AGENT, agentName: DEFAULT_AGENT_NAME,
        lcEmail: email, lcPass: password,
      });
      saveUsers();

      const spokenPwd = password.replace(/[^a-zA-Z0-9]/g, ' ');
      await playOrSay(twiml,
        `You're all set, ${name}! Your account is live at kademurdock.com. ` +
        `Log in with ${email.replace('@', ' at ')} and the temporary password: ${spokenPwd}. ` +
        `Go ahead and talk — the AI will remember you from now on.`
      );
    } catch (err) {
      const alreadyExists = err.response?.status === 400 || err.response?.status === 409
        || (err.response?.data?.message || '').toLowerCase().includes('exist');
      if (alreadyExists) {
        console.log(`[voice] ${email} already registered — saving as guest for now`);
        await playOrSay(twiml,
          `Looks like ${email.replace('@', ' at ')} already has an account at kademurdock.com. ` +
          `You're good to chat — log in on the website to see your history.`
        );
        // Register with name only, no creds (we don't have their password)
        users.set(state.from, { name, agentId: DEFAULT_AGENT, agentName: DEFAULT_AGENT_NAME });
        saveUsers();
      } else {
        console.error('[voice] account creation failed:', err.message);
        await playOrSay(twiml, `Something went wrong setting up your account, but you can still chat as a guest.`);
        users.set(state.from, { name, agentId: DEFAULT_AGENT, agentName: DEFAULT_AGENT_NAME });
        saveUsers();
      }
    }
  } else {
    // No / try again
    await playOrSay(twiml, `No problem. What's your email? Say it like "john at gmail dot com", or say skip.`);
    twiml.gather({ input: 'speech', speechTimeout: 'auto', timeout: 12,
      action: `/voice/setup-email/${callSid}`, method: 'POST' });
    twiml.redirect({ method: 'POST' }, `/voice/setup-guest/${callSid}`);
    return res.type('text/xml').send(twiml.toString());
  }

  // Start conversation
  twiml.gather({ input: 'speech', speechTimeout: 'auto', timeout: 10,
    action: `/voice/heard/${callSid}`, method: 'POST' });
  twiml.say({ voice: 'alice' }, 'Still there?');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// ── Voice setup: guest fallback ────────────────────────────────────────────────
app.post('/voice/setup-guest/:callSid', async (req, res) => {
  const twiml   = new twilio.twiml.VoiceResponse();
  const callSid = req.params.callSid;
  const state   = voiceStates.get(callSid);
  const name    = state?.pendingName || 'Friend';

  if (state?.from) {
    users.set(state.from, { name, agentId: DEFAULT_AGENT, agentName: DEFAULT_AGENT_NAME });
    saveUsers();
    console.log(`[voice] registered ${state.from} as guest "${name}"`);
  }

  await playOrSay(twiml, `No problem, ${name}! Go ahead and start talking.`);
  twiml.gather({ input: 'speech', speechTimeout: 'auto', timeout: 10,
    action: `/voice/heard/${callSid}`, method: 'POST' });
  twiml.say({ voice: 'alice' }, 'Still there?');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// ── Voice: reply placeholder ──────────────────────────────────────────────────
app.post('/voice/reply', (_req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.pause({ length: 12 });
  res.type('text/xml').send(twiml.toString());
});

// ── Voice: transcription → agent → update live call ───────────────────────────
app.post('/voice/transcribed', async (req, res) => {
  const callSid = req.body.CallSid;
  const text    = (req.body.TranscriptionText || '').trim();
  const state   = voiceStates.get(callSid);

  res.status(200).end();
  if (!state || !text || !twilioClient) return;
  console.log(`[voice] transcribed callSid=${callSid}: "${text}"`);

  try {
    // Voice switch check first ("switch voice to Sarah")
    const voiceTarget = extractVoiceSwitch(text);
    if (voiceTarget) {
      console.log(`[voice] voice switch -> ${voiceTarget}`);
      state.voice = voiceTarget;
      const user = users.get(state.from);
      if (user) { user.voice = voiceTarget; saveUsers(); }
      await twilioClient.calls(callSid).update({
        twiml: await buildListenTwiml(`Switching to ${voiceTarget}'s voice! Go ahead.`, voiceTarget, callSid),
      });
      return;
    }

    // Agent switch check
    const agents = await getAgents();
    const target = extractSwitchTarget(text, agents);

    if (target && target.id !== state.agentId) {
      console.log(`[voice] switching -> ${target.name}`);
      state.agentId   = target.id;
      state.agentName = target.name;
      state.history   = [];
      const user = users.get(state.from);
      if (user) { user.agentId = target.id; user.agentName = target.name; saveUsers(); }
      await twilioClient.calls(callSid).update({
        twiml: await buildListenTwiml(`Switching to ${target.name}! What do you want to say?`, state.voice, callSid),
      });
    } else {
      const reply    = await askAgent(state.agentId, state.history, text);
      const audioUrl = storeAudio(await synthesizeVoice(reply, state.voice));
      const vr = new twilio.twiml.VoiceResponse();
      vr.gather({ input: 'speech', speechTimeout: 'auto', timeout: 8,
        action: `/voice/continue/${callSid}`, method: 'POST' });
      vr.say({ voice: 'alice' }, 'Talk to you later!');
      vr.hangup();
      await twilioClient.calls(callSid).update({ twiml: vr.toString() });
    }
  } catch (err) {
    console.error('[voice] transcribed error:', err.message);
    try {
      await twilioClient.calls(callSid).update({
        twiml: '<Response><Say voice="alice">Sorry, something went wrong. Goodbye!</Say><Hangup/></Response>',
      });
    } catch {}
  }
});

// ── Voice: continued turns ────────────────────────────────────────────────────
app.post('/voice/continue/:callSid', async (req, res) => {
  const twiml   = new twilio.twiml.VoiceResponse();
  const callSid = req.params.callSid;
  const speech  = (req.body.SpeechResult || '').trim();
  const state   = voiceStates.get(callSid);

  if (!speech || !state) {
    twiml.say({ voice: 'alice' }, 'Talk to you later!');
    twiml.hangup();
    voiceStates.delete(callSid);
    return res.type('text/xml').send(twiml.toString());
  }

  console.log(`[voice] continue callSid=${callSid}: "${speech}"`);

  try {
    // Voice switch check first
    const voiceTarget = extractVoiceSwitch(speech);
    if (voiceTarget) {
      state.voice = voiceTarget;
      const user = users.get(state.from);
      if (user) { user.voice = voiceTarget; saveUsers(); }
      await playOrSay(twiml, `Switching to ${voiceTarget}'s voice!`, voiceTarget);
    } else {
      // Agent switch check
      const agents = await getAgents();
      const target = extractSwitchTarget(speech, agents);

      if (target && target.id !== state.agentId) {
        state.agentId   = target.id;
        state.agentName = target.name;
        state.history   = [];
        const user = users.get(state.from);
        if (user) { user.agentId = target.id; user.agentName = target.name; saveUsers(); }
        await playOrSay(twiml, `Switching to ${target.name}! What's on your mind?`, state.voice);
      } else {
        const reply = await askAgent(state.agentId, state.history, speech);
        twiml.play(storeAudio(await synthesizeVoice(reply, state.voice)));
      }
    }
  } catch (err) {
    console.error('[voice] continue error:', err.message);
    twiml.say({ voice: 'alice' }, 'Sorry, something went wrong. Try again.');
  }

  twiml.gather({ input: 'speech', speechTimeout: 'auto', timeout: 8,
    action: `/voice/continue/${callSid}`, method: 'POST' });
  twiml.say({ voice: 'alice' }, 'Talk to you later!');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});


// ── Self-registration web form ────────────────────────────────────────────────
app.get('/signup', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(SIGNUP_HTML);
});

app.post('/signup', (req, res) => {
  const { name, phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required.' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) return res.status(400).json({ error: 'Enter a valid 10-digit US phone number.' });
  const e164 = digits.startsWith('1') ? '+' + digits : '+1' + digits;
  const record = { name: name.trim(), agentId: DEFAULT_AGENT, agentName: DEFAULT_AGENT_NAME };
  // KADE July 3 2026: child accounts (711 signup code) carry the flag onto their
  // phone registration so calls get the same invisible clean note as the site.
  if (req.body.accountType === 'child') record.accountType = 'child';
  users.set(e164, record);
  saveUsers();
  console.log('[bridge] Self-registered ' + e164 + ' as "' + name.trim() + '"' + (record.accountType === 'child' ? ' (child account)' : ''));
  res.json({ ok: true, phone: e164 });
});

// ── Voice: heard (Gather fires here) ─────────────────────────────────────────
// Acks immediately so caller hears something, then processes AI async.
app.post('/voice/heard/:callSid', async (req, res) => {
  const twiml   = new twilio.twiml.VoiceResponse();
  const callSid = req.params.callSid;
  const speech  = (req.body.SpeechResult || '').trim();
  const state   = voiceStates.get(callSid);

  twiml.play({ digits: '0' }); // short beep: received signal without verbal ack
  twiml.pause({ length: 150 });
  res.type('text/xml').send(twiml.toString());

  if (!state || !speech || !twilioClient) return;
  console.log(`[voice] heard callSid=${callSid}: "${speech}"`);

  try {
    const voiceTarget = extractVoiceSwitch(speech);
    if (voiceTarget) {
      state.voice = voiceTarget;
      const user = users.get(state.from);
      if (user) { user.voice = voiceTarget; saveUsers(); }
      await twilioClient.calls(callSid).update({
        twiml: await buildListenTwiml(`Switching to ${voiceTarget}'s voice! Go ahead.`, voiceTarget, callSid),
      });
      return;
    }
    const agents = await getAgents();
    const target = extractSwitchTarget(speech, agents);
    if (target && target.id !== state.agentId) {
      state.agentId = target.id; state.agentName = target.name; state.history = [];
      const user = users.get(state.from);
      if (user) { user.agentId = target.id; user.agentName = target.name; saveUsers(); }
      await twilioClient.calls(callSid).update({
        twiml: await buildListenTwiml(`Switching to ${target.name}! What's on your mind?`, state.voice, callSid),
      });
      return;
    }
    const reply = await askAgent(state.agentId, state.history, speech);
    await twilioClient.calls(callSid).update({
      twiml: await buildListenTwiml(reply, state.voice, callSid),
    });
  } catch (err) {
    console.error('[voice] heard error:', err.message);
    try {
      await twilioClient.calls(callSid).update({
        twiml: await buildListenTwiml('Sorry, something went wrong. Go ahead and try again.', state.voice, callSid),
      });
    } catch {}
  }
});

// ── Voice: serve a fresh listening Gather (direct webhook response) ───────────
// Gathers delivered via call.update don't reliably listen; this route serves the
// Gather as a normal webhook response so every turn listens like round 1 does.
app.post('/voice/listen/:callSid', (req, res) => {
  const twiml   = new twilio.twiml.VoiceResponse();
  const callSid = req.params.callSid;
  twiml.gather({ input: 'speech', speechTimeout: 'auto', timeout: 10,
    action: `${PUBLIC_URL}/voice/heard/${callSid}`, method: 'POST' });
  twiml.say({ voice: 'alice' }, 'Still there? Call back anytime!');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// ── Voice: Media Streams (streaming path) ────────────────────────────────────
// Returns <Connect><Stream> TwiML.  Point a TEST number's webhook here while
// keeping /voice as the Gather fallback.
app.post('/voice-ws', (req, res) => {
  const from    = req.body.From    || req.body.from    || 'unknown';
  const callSid = req.body.CallSid || req.body.callSid || '';
  const twiml   = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  const wsHost  = process.env.RAILWAY_PUBLIC_DOMAIN || 'kade-ai-bridge-production.up.railway.app';
  const stream  = connect.stream({ url: `wss://${wsHost}/ws/media` });
  stream.parameter({ name: 'from',    value: from });
  stream.parameter({ name: 'callSid', value: callSid });
  res.type('text/xml').send(twiml.toString());
});


// ── Outbound calling v2 (July 1 2026 — per-user spend, recording, caps) ──────
//
// Trigger path: a user asks an agent in chat -> the fork's kade_phone_call tool
// POSTs here with that user's LibreChat identity -> we dial out, run the normal
// Media-Streams pipeline, cap duration server-side, record for QA, and once the
// call completes we fetch Twilio's actual price and post a usage event to the
// fork so the cost lands on THAT user's Feed-the-Server page.
//
// Money/safety rails, all env-tunable:
//   ENABLE_OUTBOUND=true            master switch (503 otherwise)
//   OUTBOUND_TIME_LIMIT_SEC=900     Twilio hard-kills the call at this age
//   OUTBOUND_DAILY_LIMIT=4          calls per platform user per UTC day
//   OUTBOUND_GLOBAL_DAILY_LIMIT=20  everyone combined per UTC day
//   OUTBOUND_DEST_COOLDOWN_MIN=10   same destination can't be redialed sooner
//   OUTBOUND_RECORD=1               dual-channel recording (0 = off)
// US/Canada 10-digit numbers only; premium (900/976) and our own number blocked.
// The scripted greeting always discloses: AI + on whose behalf + may be recorded.

const ENABLE_OUTBOUND = !!process.env.ENABLE_OUTBOUND;
const OUTBOUND_TIME_LIMIT_SEC     = parseInt(process.env.OUTBOUND_TIME_LIMIT_SEC || '900', 10);
const OUTBOUND_DAILY_LIMIT        = parseInt(process.env.OUTBOUND_DAILY_LIMIT || '4', 10);
const OUTBOUND_GLOBAL_DAILY_LIMIT = parseInt(process.env.OUTBOUND_GLOBAL_DAILY_LIMIT || '20', 10);
const OUTBOUND_DEST_COOLDOWN_MS   = parseInt(process.env.OUTBOUND_DEST_COOLDOWN_MIN || '10', 10) * 60 * 1000;
// KADE July 2 2026: per-user outbound DESTINATION allowlist (kid/family accounts).
// OUTBOUND_USER_ALLOWLIST is JSON: { "<librechat userId>": "registry" | ["+14175551234", "registry"] }
// "registry" = any phone number currently registered on this bridge (i.e. family).
// Users absent from the map keep the existing unrestricted behavior.
const OUTBOUND_USER_ALLOWLIST = (() => {
  try { return JSON.parse(process.env.OUTBOUND_USER_ALLOWLIST || '{}'); }
  catch (e) { console.error('[outbound] OUTBOUND_USER_ALLOWLIST is not valid JSON — treating as empty:', e.message); return {}; }
})();
const OUTBOUND_RECORD    = process.env.OUTBOUND_RECORD !== '0';
const FORK_USAGE_URL     = (process.env.FORK_USAGE_URL || LIBRECHAT_URL).replace(/\/$/, '');
const USAGE_EVENT_SECRET = process.env.KADE_USAGE_EVENT_SECRET || '';

// ── PHONE-LINE PERSONAL VOICES (July 12 2026) ────────────────────────────────
// The fork stores each user's per-agent voice picks (kadeVoicePref). These two
// helpers let the phone engine APPLY them (lookup) and SAVE spoken mid-call
// switches back (ingest) so a pick made anywhere follows the person everywhere.
// Fail-soft by design: any error/timeout -> null -> existing voice chain rules.
async function lookupVoicePref(identity, agentId) {
  if (!USAGE_EVENT_SECRET || !agentId || !identity) return null;
  // July 17 2026 (proposal A): route through the fork's UNIFIED RESOLVER
  // (/api/kade/resolve-voice) — same contract as before (the caller's
  // PERSONAL pick or null; the bridge's own local chain stays in charge of
  // builder/name/default), but the personal pick is now validated against
  // the LIVE voice catalog fork-side, so a stale row pointing at a dead
  // label can't hijack a call anymore. Fail-soft: any resolver trouble
  // falls back to the legacy /voice-pref-lookup endpoint (kept for compat).
  const params = new URLSearchParams({ agentId });
  if (identity.email) params.set('email', identity.email);
  if (identity.phone) params.set('phone', identity.phone);
  if (identity.userId) params.set('userId', identity.userId);
  try {
    const p2 = new URLSearchParams(params);
    p2.set('surface', identity.surface || 'phone');
    const r = await axios.get(`${FORK_USAGE_URL}/api/kade/resolve-voice?${p2}`, {
      headers: { 'User-Agent': BROWSER_UA, 'X-Kade-Secret': USAGE_EVENT_SECRET }, timeout: 1500,
    });
    if (r.data && r.data.source) {
      return r.data.source === 'personal' && r.data.voice ? r.data.voice : null;
    }
  } catch { /* fall through to legacy endpoint */ }
  try {
    // Legacy path (pre-July-17 fork, or resolver error).
    const r = await axios.get(`${FORK_USAGE_URL}/api/kade/voice-pref-lookup?${params}`, {
      headers: { 'User-Agent': BROWSER_UA, 'X-Kade-Secret': USAGE_EVENT_SECRET }, timeout: 1500,
    });
    return (r.data && r.data.voice) || null;
  } catch { return null; }
}
async function fetchCallMemories(identity, agentId, opts = {}) {
  if (!USAGE_EVENT_SECRET || !identity) return null;
  try {
    // July 13 2026: secret rides a HEADER now (query strings land in edge logs).
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    // Family messages / nudges: consume-on-fetch ONLY when a human is
    // definitely live on the line (inbound caller, or mid-call switch).
    if (opts.nudges) params.set('nudges', '1');
    if (identity.email) params.set('email', identity.email);
    if (identity.phone) params.set('phone', identity.phone);
    if (identity.userId) params.set('userId', identity.userId);
    const r = await axios.get(`${FORK_USAGE_URL}/api/kade/call-memories?${params}`, {
      headers: { 'User-Agent': BROWSER_UA, 'X-Kade-Secret': USAGE_EVENT_SECRET }, timeout: 2500,
    });
    return (r.data && r.data.text) || null;
  } catch { return null; }
}
// Kade July 20 2026: per-user pronunciation dictionary (Kade: "I know my
// name Kade is pronounced Katie... what if everyone had a dictionary").
// Mirrors fetchCallMemories exactly -- same secret, same identity shape,
// same fail-soft (a lookup miss just means no respelling/keyterms this
// call, never a broken one). Returns [] (never null) so every call site can
// treat the result as a plain array with no extra null-check.
async function fetchPronunciationDictionary(identity) {
  if (!USAGE_EVENT_SECRET || !identity) return [];
  try {
    const params = new URLSearchParams();
    if (identity.email) params.set('email', identity.email);
    if (identity.phone) params.set('phone', identity.phone);
    if (identity.userId) params.set('userId', identity.userId);
    const r = await axios.get(`${FORK_USAGE_URL}/api/kade/pronunciation-lookup?${params}`, {
      headers: { 'User-Agent': BROWSER_UA, 'X-Kade-Secret': USAGE_EVENT_SECRET }, timeout: 1500,
    });
    return (r.data && r.data.entries) || [];
  } catch { return []; }
}
function ingestVoicePref(identity, agentId, voice) {
  if (!USAGE_EVENT_SECRET || !agentId || !identity) return;
  axios.post(`${FORK_USAGE_URL}/api/kade/voice-pref-ingest`, {
    secret: USAGE_EVENT_SECRET,
    email: identity.email || undefined,
    phone: identity.phone || undefined,
    userId: identity.userId || undefined,
    agentId, voice,
  }, { headers: { 'User-Agent': BROWSER_UA }, timeout: 4000 }).catch(() => {});
}
const OUR_NUMBER         = process.env.TWILIO_PHONE_NUMBER || '+18335300313';
const RECORDING_USD_PER_MIN = 0.0025; // Twilio recording rate; call-leg price comes from Twilio itself

const OUTBOUND_LOG_FILE   = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(), 'outbound-calls.json');
const OUTBOUND_DAILY_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(), 'outbound-daily.json');

function loadJsonFile(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return fallback;
}
function saveJsonFile(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); }
  catch (e) { console.error(`[outbound] could not save ${path.basename(file)}:`, e.message); }
}

const outboundLog  = loadJsonFile(OUTBOUND_LOG_FILE, []); // finalized call records (capped at 500)
const outboundMeta = new Map();                           // callSid -> live call context
const lastDialed   = new Map();                           // e164 -> ts of last outbound dial

function todayUTC() { return new Date().toISOString().slice(0, 10); }
function getDaily() {
  const d = loadJsonFile(OUTBOUND_DAILY_FILE, {});
  if (d.date !== todayUTC()) return { date: todayUTC(), byUser: {}, total: 0 };
  return d;
}

function normalizeUsPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length !== 10) return null;
  if (/^(900|976)/.test(ten)) return null;              // premium-rate
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null; // NANP shape (also rejects x11 area codes)
  const e164 = `+1${ten}`;
  if (e164 === OUR_NUMBER) return null;
  return e164;
}

// POST /outbound-call
// Body: { to, secret, userId, userName, purpose, calleeName?, agentId?, agentName?, voice? }
app.post('/outbound-call', async (req, res) => {
  if (!ENABLE_OUTBOUND) return res.status(503).json({ error: 'Outbound calling is not enabled on the bridge.' });
  const { to, secret, userId, userName, purpose, calleeName: rawCalleeName, agentId, agentName, voice, context, wellness: rawWellness } = req.body || {};
  // KADE July 2 2026: the model sometimes fills calleeName with junk like
  // "whoever it is" or "the person" — which produced the live gem
  // "Hi, is this whoever it is?". A name is only a name if it looks like one.
  const JUNK_NAME = /\b(whoever|whomever|someone|somebody|anyone|anybody|unknown|the (?:person|people|business|store|restaurant|place|company|owner|manager|front desk)|them|they|it is|n\/a|none|no name|not sure|idk)\b/i;
  const calleeName = (() => {
    const n = String(rawCalleeName || '').trim();
    if (!n) return null;
    if (n.length > 40) return null;
    if (JUNK_NAME.test(n)) return null;
    if (!/^[a-z][a-z .,'-]*$/i.test(n)) return null;
    return n;
  })();
  if (!bridgeSecretOk(req, secret)) return res.status(403).json({ error: 'Unauthorized' });
  if (!twilioClient) return res.status(500).json({ error: 'Twilio not configured' });
  if (!userId) return res.status(400).json({ error: 'userId required — whose spend page does this call bill to?' });
  if (!purpose || String(purpose).trim().length < 3) {
    return res.status(400).json({ error: 'purpose required — a short plain-language reason for the call' });
  }
  const e164 = normalizeUsPhone(to);
  if (!e164) return res.status(400).json({ error: 'to must be a valid, non-premium US/Canada 10-digit number' });

  // Per-user destination allowlist (see OUTBOUND_USER_ALLOWLIST above).
  const allowRule = OUTBOUND_USER_ALLOWLIST[String(userId)];
  if (allowRule) {
    const rules = Array.isArray(allowRule) ? allowRule : [allowRule];
    const allowed = new Set();
    for (const r of rules) {
      if (r === 'registry') { for (const num of users.keys()) allowed.add(num); }
      else { const n = normalizeUsPhone(r); if (n) allowed.add(n); }
    }
    if (!allowed.has(e164)) {
      console.log(`[outbound] BLOCKED by allowlist: user ${userId} tried ${e164}`);
      return res.status(403).json({
        error: 'This account can only call approved family numbers. That number is not on the approved list.',
      });
    }
  }

  const last = lastDialed.get(e164);
  if (last && Date.now() - last < OUTBOUND_DEST_COOLDOWN_MS) {
    const waitMin = Math.ceil((OUTBOUND_DEST_COOLDOWN_MS - (Date.now() - last)) / 60000);
    return res.status(429).json({ error: `That number was called very recently. Try again in about ${waitMin} minute(s).` });
  }
  const daily = getDaily();
  if ((daily.byUser[userId] || 0) >= OUTBOUND_DAILY_LIMIT) {
    return res.status(429).json({ error: `Daily outbound limit reached (${OUTBOUND_DAILY_LIMIT} calls per person per day).` });
  }
  if (daily.total >= OUTBOUND_GLOBAL_DAILY_LIMIT) {
    return res.status(429).json({ error: 'Platform-wide daily outbound limit reached. Try again tomorrow.' });
  }

  // Compose + PRE-SYNTHESIZE the greeting while we still have time: Twilio
  // takes several seconds to dial anyway, and having the audio ready means
  // the callee hears the disclosure the instant they answer — no ringback,
  // no dead air, no synth race with their "Hello?" (July 2 2026 rework).
  //
  // Voice belongs to the AGENT placing the call, never the callee's saved
  // inbound preference (Kade's round-2 catch: Zadiana called in Kiana's
  // voice). Priority: the agent record's builder-set tts.voiceId ->
  // an Inworld voice matching the agent's name (e.g. the "Zadiana" voice) ->
  // explicit voice param -> platform default. Same for speaking rate.
  let outVoice = null;
  let outRate = null;
  try {
    const ar = await axios.get(
      `${PROXY_URL}/librechat/agent?id=${encodeURIComponent(agentId || DEFAULT_AGENT)}`,
      { headers: { Authorization: `Bearer ${PROXY_SECRET}`, 'User-Agent': BROWSER_UA }, timeout: 15000 },
    );
    outVoice = ar.data?.tts?.voiceId || null;
    outRate = typeof ar.data?.tts?.speakingRate === 'number' ? ar.data.tts.speakingRate : null;
  } catch (e) {
    console.warn('[outbound] agent voice lookup failed (using fallbacks):', e.message);
  }
  if (!outVoice) outVoice = findVoice(agentName || DEFAULT_AGENT_NAME);
  if (!outVoice) outVoice = voice || DEFAULT_PHONE_VOICE;
  // July 12 2026: the CALLEE's own voice pick for this agent beats the
  // builder default — they're the one listening. Fail-soft, ~1.5s max.
  try {
    const callee = users.get(e164);
    const personal = await lookupVoicePref({ email: callee && callee.lcEmail, phone: e164 }, agentId || DEFAULT_AGENT);
    if (personal) {
      outVoice = personal;
      console.log(`[outbound] callee personal voice applied: "${personal}"`);
    }
  } catch { /* agent default stands */ }
  console.log(`[outbound] voice resolved: "${outVoice}"${outRate ? ` rate ${outRate}` : ''} for agent ${agentName || DEFAULT_AGENT_NAME}`);
  // TWO-PHASE greeting (July 2 2026): when we know the callee's name, part 1
  // is JUST "Hi — is this X?" — the stream layer waits for their answer before
  // part 2 (disclosure + purpose). Unknown callee: one combined line.
  //
  // Purpose framing (July 2 round 3, Kade's catch): the model fills `purpose`
  // in whatever shape it likes — "is your refrigerator running?" produced
  // "I'm calling because is your refrigerator running?". Frame by shape
  // instead of blindly gluing onto "because".
  const framePurpose = (p) => {
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
    // KADE July 2 2026 (round 5): a NOUN-PHRASE purpose ("fun test call from her
    // big sister...") glued onto "because" reads broken. If none of the first
    // few words is a verb-ish token, the text has no clause — frame with
    // "about" instead. Clauses ("she wants...", "Skylee asked...") still get
    // "because".
    const firstWords = t.split(/\s+/).slice(0, 3);
    const VERBISH = /^(?:is|are|was|were|am|be|has|have|had|do|does|did|want|wants|wanted|need|needs|needed|ask|asks|asked|say|says|said|told|tell|tells|think|thinks|thought|hope|hopes|hoped|wonder|wonders|wondered|would|will|should|can|could|may|might|must|let|lets|got|get|gets|there's|it's|she's|he's|i'm|we're|they're|you're)$/i;
    const hasEarlyVerb = firstWords.some((w) => VERBISH.test(w.replace(/[^a-z']/gi, '')));
    if (!hasEarlyVerb) {
      return `I'm calling about ${t.charAt(0).toLowerCase()}${t.slice(1)}${endPunct}`;
    }
    return `I'm calling because ${t.charAt(0).toLowerCase()}${t.slice(1)}${endPunct}`;
  };
  // First name only when speaking (Kade's ask: "calling for Kade", not
  // "calling for Kade Murdock"). Full name stays in records/transcripts.
  const spokenUserName = String(userName || '').trim().split(/\s+/)[0] || 'a Kade-AI user';
  // GREETING TIERS (July 12 2026, Kade: "none of this weird fourth-wall
  // stuff"). Registered family who KNOW the agent get greeted like a friend;
  // the full formal AI-disclosure + recording notice stays for strangers and
  // businesses (that's the anti-prank armor — unchanged where it matters).
  //   own agent  -> "Hey! It's Lilly. <mission>"          (their OWN companion)
  //   family     -> "Hey — it's Kiana, Kade's A I. <mission>"
  //   stranger   -> full disclosure, exactly as before
  const calleeRec = users.get(e164);
  // July 17 2026 (Kade caught this live: a real call went out to a registered
  // family number while the greeting/purpose were built around a DIFFERENT
  // name -- the model wanted to reach someone it called "Iris" but the number
  // it dialed actually belongs to a different registered contact). Cheap,
  // fail-soft sanity check, runs BEFORE any TTS synth or Twilio dialing: if
  // this number belongs to someone in the registry, the name the model
  // thinks it is calling has to actually match that record.
  if (calleeRec && calleeName) {
    const norm = (s) => String(s || '').toLowerCase().trim();
    const registeredFirst = norm(calleeRec.name).split(/\s+/)[0];
    const saidFirst = norm(calleeName).split(/\s+/)[0];
    const matches = registeredFirst && saidFirst && (
      registeredFirst === saidFirst ||
      norm(calleeRec.name).includes(saidFirst) ||
      norm(calleeName).includes(registeredFirst)
    );
    if (!matches) {
      console.warn(`[outbound] BLOCKED name mismatch: ${e164} belongs to "${calleeRec.name}" in the registry, call was built for "${calleeName}"`);
      return res.status(409).json({
        error: `That number belongs to ${calleeRec.name} in your registry, not ${calleeName}. Double-check who you mean to call -- if you do not have a real number for ${calleeName}, say so instead of guessing.`,
      });
    }
  }

  const ownAgent = !!(calleeRec && calleeRec.agentId === (agentId || DEFAULT_AGENT));
  const introText = ownAgent
    ? `It's ${agentName || DEFAULT_AGENT_NAME}! ${framePurpose(purpose)}`
    : calleeRec
      ? `It's ${agentName || DEFAULT_AGENT_NAME} — ${spokenUserName}'s A I. ${framePurpose(purpose)}`
      : `This is ${agentName || DEFAULT_AGENT_NAME}, an A I assistant calling for ` +
        `${spokenUserName}. This call may be recorded. ` +
        framePurpose(purpose);
  const greetingText  = calleeName ? `Hi — is this ${calleeName}?` : `Hi! ${introText}`;
  const greeting2Text = calleeName ? introText : null;
  let greetingBuf = null;
  let greeting2Buf = null;
  try {
    [greetingBuf, greeting2Buf] = await Promise.all([
      vsSynthesize(greetingText, outVoice, outRate ?? undefined),
      greeting2Text ? vsSynthesize(greeting2Text, outVoice, outRate ?? undefined) : Promise.resolve(null),
    ]);
    console.log(`[outbound] greeting pre-synthesized: part1 ${greetingBuf.length} bytes${greeting2Buf ? `, part2 ${greeting2Buf.length} bytes` : ''}`);
  } catch (e) {
    console.warn('[outbound] greeting pre-synth failed (will synth live):', e.message);
  }

  try {
    const call = await twilioClient.calls.create({
      to: e164,
      from: OUR_NUMBER,
      url: `${PUBLIC_URL}/voice-ws-outbound?userPhone=${encodeURIComponent(e164)}`,
      method: 'POST',
      // July 12 2026 (Kade, after Lilly serenaded Skylee's voicemail with
      // typing sounds): ASYNC answering-machine detection. The call proceeds
      // normally for humans; when Twilio hears a machine it posts to
      // /amd-status at message-end (the beep) and the session switches to
      // voicemail mode: one clean message, no turn loop, graceful hangup.
      machineDetection: 'DetectMessageEnd',
      asyncAmd: 'true',
      asyncAmdStatusCallback: `${PUBLIC_URL}/amd-status`,
      asyncAmdStatusCallbackMethod: 'POST',
      machineDetectionTimeout: 45,
      timeLimit: OUTBOUND_TIME_LIMIT_SEC,
      record: OUTBOUND_RECORD,
      ...(OUTBOUND_RECORD ? {
        recordingChannels: 'dual',
        recordingStatusCallback: `${PUBLIC_URL}/recording-status`,
        recordingStatusCallbackMethod: 'POST',
      } : {}),
      statusCallback: `${PUBLIC_URL}/voice-status`,
      statusCallbackMethod: 'POST',
    });
    outboundMeta.set(call.sid, {
      callSid: call.sid,
      userId,
      userName: userName || 'a Kade-AI user',
      purpose: String(purpose).slice(0, 500),
      // KADE July 2 2026 (briefings): optional extra mission material (e.g.
      // today's headlines) — too big for `purpose`, rides its own field and
      // voice-stream appends it to the mission context.
      context: String(context || '').slice(0, 4000) || null,
      calleeName: calleeName || null,
      to: e164,
      agentId: agentId || DEFAULT_AGENT,
      agentName: agentName || DEFAULT_AGENT_NAME,
      voice: outVoice,
      rate: outRate,
      greeting: greetingText,
      greetingBuf,
      greeting2: greeting2Text,
      greeting2Buf,
      startedAt: Date.now(),
      transcript: null,
      recordingSid: null,
      recordingUrl: null,
      finalized: false,
      // FAMILY WELLNESS CALLS (July 11 2026): when set, finalize writes a rich
      // LLM summary of the call and nudges it back to the person who set the
      // schedule up (fork /api/kade/nudges/ingest -> their chosen channel).
      wellness: rawWellness && typeof rawWellness === 'object' ? {
        scheduleId: String(rawWellness.scheduleId || '').slice(0, 64) || null,
        notifyUserId: String(rawWellness.notifyUserId || '').slice(0, 64) || null,
        targetName: String(rawWellness.targetName || '').slice(0, 80) || null,
        topics: String(rawWellness.topics || '').slice(0, 600) || null,
      } : null,
    });
    lastDialed.set(e164, Date.now());
    daily.byUser[userId] = (daily.byUser[userId] || 0) + 1;
    daily.total += 1;
    saveJsonFile(OUTBOUND_DAILY_FILE, daily);
    console.log(`[outbound] call ${call.sid} -> ${e164} for user ${userId} (${daily.byUser[userId]}/${OUTBOUND_DAILY_LIMIT} today)`);
    res.json({
      ok: true, callSid: call.sid, to: e164,
      timeLimitMin: Math.round(OUTBOUND_TIME_LIMIT_SEC / 60),
      callsLeftToday: OUTBOUND_DAILY_LIMIT - daily.byUser[userId],
    });
  } catch (err) {
    console.error('[outbound] call create failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// TwiML for outbound Media Streams calls. The callee's number rides a query
// param (our To becomes their From in the WS session); outbound=1 tells
// voice-stream.js to run the outbound greeting + mission context.
app.post('/voice-ws-outbound', (req, res) => {
  const userPhone = req.query.userPhone || req.body.To || 'unknown';
  const callSid   = req.body.CallSid || '';
  const twiml     = new twilio.twiml.VoiceResponse();
  const connect   = twiml.connect();
  const wsHost    = process.env.RAILWAY_PUBLIC_DOMAIN || 'kade-ai-bridge-production.up.railway.app';
  const stream    = connect.stream({ url: `wss://${wsHost}/ws/media` });
  stream.parameter({ name: 'from',     value: userPhone });
  stream.parameter({ name: 'callSid',  value: callSid });
  stream.parameter({ name: 'outbound', value: '1' });
  res.type('text/xml').send(twiml.toString());
});

// Call status callback — finalizes outbound calls once they end.
app.post('/amd-status', (req, res) => {
  const { CallSid, AnsweredBy } = req.body || {};
  // July 13 2026 security sweep: LOG-ONLY Twilio signature check. Deliberately
  // non-blocking — a URL-reconstruction mismatch must never silently kill
  // voicemail detection (phone quality is sacred); a forged POST still needs a
  // live CallSid to do anything (unknown sids no-op in the handler).
  try {
    if (TWILIO_TOKEN && twilio.validateRequest) {
      const ok = twilio.validateRequest(TWILIO_TOKEN, req.get('X-Twilio-Signature') || '', `${PUBLIC_URL}/amd-status`, req.body || {});
      if (!ok) console.warn(`[amd] SIGNATURE MISMATCH for ${CallSid} — investigate if this ever fires on a real Twilio callback`);
    }
  } catch {}
  console.log(`[amd] ${CallSid}: AnsweredBy=${AnsweredBy}`);
  if (CallSid && /^machine_end/.test(String(AnsweredBy || ''))) {
    try { vsHandleAmd(CallSid, 'machine'); } catch (e) { console.warn('[amd] handler failed:', e.message); }
  }
  res.status(200).end();
});

app.post('/voice-status', (req, res) => {
  const { CallSid, CallStatus, To, From, CallDuration } = req.body;
  console.log(`[bridge] Call status: sid=${CallSid} ${From}->${To} status=${CallStatus}${CallDuration ? ` dur=${CallDuration}s` : ''}`);
  const meta = outboundMeta.get(CallSid);
  if (meta && !meta.finalized && ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(CallStatus)) {
    meta.finalized = true;
    meta.finalStatus = CallStatus;
    meta.durationSec = parseInt(CallDuration || '0', 10);
    // Give Twilio ~45s to compute price and land recording callbacks first.
    setTimeout(() => finalizeOutboundCall(CallSid).catch((e) =>
      console.error('[outbound] finalize error:', e.message)), 45000);
  }
  res.status(200).end();
});

// Recording status callback — stashes the recording pointer for QA review.
app.post('/recording-status', (req, res) => {
  const { CallSid, RecordingSid, RecordingUrl, RecordingDuration } = req.body;
  const meta = outboundMeta.get(CallSid);
  if (meta) {
    meta.recordingSid = RecordingSid || meta.recordingSid;
    meta.recordingUrl = RecordingUrl || meta.recordingUrl;
    meta.recordingDurationSec = parseInt(RecordingDuration || '0', 10) || meta.recordingDurationSec;
  } else {
    // Finalize may have already run — patch the saved record instead.
    const rec = outboundLog.find((r) => r.callSid === CallSid);
    if (rec) {
      rec.recordingSid = RecordingSid;
      rec.recordingUrl = RecordingUrl;
      saveJsonFile(OUTBOUND_LOG_FILE, outboundLog);
    }
  }
  console.log(`[outbound] recording for ${CallSid}: ${RecordingSid || 'n/a'}`);
  res.status(200).end();
});

async function finalizeOutboundCall(callSid) {
  const meta = outboundMeta.get(callSid);
  if (!meta) return;
  let price = null;
  let duration = meta.durationSec || 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const call = await twilioClient.calls(callSid).fetch();
      duration = parseInt(call.duration, 10) || duration;
      if (call.price != null) { price = Math.abs(parseFloat(call.price)); break; }
    } catch (e) { console.warn(`[outbound] price fetch ${attempt}/3 failed:`, e.message); }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 30000));
  }
  const minutes = duration > 0 ? duration / 60 : 0;
  // Fallback estimate if Twilio hasn't priced the call yet (~1.4 cents/min).
  const callUSD = price != null ? price : Math.ceil(minutes) * 0.014;
  const recUSD  = meta.recordingSid ? minutes * RECORDING_USD_PER_MIN : 0;
  const costUSD = Math.round((callUSD + recUSD) * 10000) / 10000;

  const record = {
    callSid,
    at: new Date(meta.startedAt).toISOString(),
    userId: meta.userId,
    userName: meta.userName,
    to: meta.to,
    calleeName: meta.calleeName,
    purpose: meta.purpose,
    agentId: meta.agentId,
    agentName: meta.agentName,
    status: meta.finalStatus || 'completed',
    durationSec: duration,
    twilioPriceUSD: price,
    costUSD,
    recordingSid: meta.recordingSid,
    recordingUrl: meta.recordingUrl,
    voicemail: meta.voicemail || false,
    transcript: meta.transcript || null,
  };
  outboundLog.push(record);
  while (outboundLog.length > 500) outboundLog.shift();
  saveJsonFile(OUTBOUND_LOG_FILE, outboundLog);
  outboundMeta.delete(callSid);
  console.log(`[outbound] finalized ${callSid}: status=${record.status} ${duration}s $${costUSD}`);

  // FAMILY WELLNESS CALLS: rich summary back to whoever set the schedule up.
  if (meta.wellness && meta.wellness.notifyUserId) {
    wellnessReportBack(record, meta.wellness).catch((e) =>
      console.error('[wellness] report-back failed:', e.message));
  }

  // Land the spend on the user's Feed-the-Server page via the fork.
  if (USAGE_EVENT_SECRET && meta.userId && duration > 0) {
    const body = {
      secret: USAGE_EVENT_SECRET,
      userId: meta.userId,
      service: 'phone',
      quantity: Math.round(minutes * 10) / 10,
      unit: 'minutes',
      costUSD,
      metadata: {
        callSid,
        to: meta.to.replace(/\d(?=\d{4})/g, '*'),
        direction: 'outbound',
        agent: meta.agentName,
        purpose: meta.purpose.slice(0, 120),
      },
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await axios.post(`${FORK_USAGE_URL}/api/kade/usage-event`, body, {
          headers: { 'User-Agent': BROWSER_UA }, timeout: 10000,
        });
        console.log(`[outbound] usage event posted for user ${meta.userId}: $${costUSD}`);
        break;
      } catch (e) {
        console.warn(`[outbound] usage post ${attempt}/3 failed:`, e.message);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 15000));
      }
    }
  }
}

// Agent-facing (July 2 2026, Kade: "she stopped instead of reporting back"):
// result of a USER'S OWN outbound call — latest by default, or by callSid.
// Scoped to the requesting user's id so nobody can read anyone else's calls.
app.post('/outbound/result', async (req, res) => {
  const { secret, userId, callSid, waitSec } = req.body || {};
  if (!bridgeSecretOk(req, secret)) return res.status(403).json({ error: 'Unauthorized' });
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const findState = () => {
    const live = [...outboundMeta.values()]
      .filter((m) => m.userId === userId && (!callSid || m.callSid === callSid))
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    const done = [...outboundLog]
      .reverse()
      .find((r) => r.userId === userId && (!callSid || r.callSid === callSid));
    return { live, done };
  };

  // waitSec (July 2 round 3): the agent-side polling loop hit langgraph's
  // recursion limit. Instead of making the MODEL poll, the bridge waits here
  // (up to 55s) for the call to wrap. The transcript exists on the live meta
  // from the moment the stream stops — finalization (Twilio pricing, 30-90s)
  // doesn't have to block the report-back.
  const deadline = Date.now() + Math.min(55, Math.max(0, parseInt(waitSec, 10) || 0)) * 1000;
  let { live, done } = findState();
  while (
    live && (!done || live.startedAt > Date.parse(done.at)) &&
    !live.finalized && !(live.transcript && live.transcript.length) &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 2500));
    ({ live, done } = findState());
  }

  if (live && (!done || live.startedAt > Date.parse(done.at))) {
    // Call ended but finalize is still pricing it: the transcript is already
    // on the meta — return it now, that's what report-back needs.
    if (live.finalized || (live.transcript && live.transcript.length)) {
      return res.json({
        found: true,
        status: live.finalStatus || 'completed',
        callSid: live.callSid,
        to: live.to,
        calleeName: live.calleeName,
        purpose: live.purpose,
        durationSec: Math.round((Date.now() - live.startedAt) / 1000),
        transcript: (live.transcript || []).slice(-40),
      });
    }
    return res.json({
      found: true,
      status: 'in-progress',
      callSid: live.callSid,
      to: live.to,
      calleeName: live.calleeName,
      purpose: live.purpose,
      startedSecondsAgo: Math.round((Date.now() - live.startedAt) / 1000),
      note: 'Call is still going.',
    });
  }
  if (!done) return res.json({ found: false, note: 'No outbound calls found for this user.' });
  res.json({
    found: true,
    status: done.status,
    callSid: done.callSid,
    at: done.at,
    to: done.to,
    calleeName: done.calleeName,
    purpose: done.purpose,
    durationSec: done.durationSec,
    transcript: (done.transcript || []).slice(-40),
  });
});

// Admin: list outbound calls. ?full=1 includes transcripts.
app.get('/outbound/calls', (req, res) => {
  if (!bridgeSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
  const full = req.query.full === '1';
  const rows = [...outboundLog].reverse().slice(0, 50).map((r) =>
    full ? r : { ...r, transcript: r.transcript ? `${r.transcript.length} turns (add &full=1)` : null });
  res.json({ count: outboundLog.length, calls: rows });
});

// Admin: stream a call recording as mp3 (proxies Twilio auth so a plain
// browser link works — needed for QA listening).
app.get('/outbound/recording/:callSid', async (req, res) => {
  if (!bridgeSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
  const rec = outboundLog.find((r) => r.callSid === req.params.callSid) || outboundMeta.get(req.params.callSid);
  if (!rec || !rec.recordingUrl) return res.status(404).json({ error: 'No recording for that call (yet?)' });
  try {
    const r = await axios.get(`${rec.recordingUrl}.mp3`, {
      responseType: 'stream',
      auth: { username: TWILIO_SID, password: TWILIO_TOKEN },
      timeout: 20000,
    });
    res.set('Content-Type', 'audio/mpeg');
    r.data.pipe(res);
  } catch (e) {
    res.status(502).json({ error: `Could not fetch recording: ${e.message}` });
  }
});

// ── Scheduled morning news briefings (July 2 2026, Kade's ask) ───────────────
// Opt-in daily briefing CALL: at the subscriber's chosen Central time, the
// bridge pulls free RSS headlines for their chosen categories and places an
// outbound call through the normal machinery (same disclosure greeting, caps,
// recording, and per-user billing to Feed the Server).
//
// Registry lives on the volume: briefings.json
//   phone(E.164) -> { name, userId, userName, agentId, agentName,
//                     time "HH:MM" (America/Chicago), categories [...],
//                     enabled, lastRun "YYYY-MM-DD" }
const BRIEFINGS_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(), 'briefings.json');
const briefings = new Map(Object.entries(loadJsonFile(BRIEFINGS_FILE, {})));
function saveBriefings() { saveJsonFile(BRIEFINGS_FILE, Object.fromEntries(briefings)); }

const BRIEFING_FEEDS = {
  national: ['https://feeds.npr.org/1001/rss.xml'],
  world: ['https://feeds.bbci.co.uk/news/world/rss.xml', 'https://feeds.npr.org/1004/rss.xml'],
  local: ['https://www.ozarksfirst.com/feed/', 'https://www.ky3.com/arc/outboundfeeds/rss/'],
  tech: ['https://feeds.arstechnica.com/arstechnica/index'],
  entertainment: ['https://variety.com/feed/'],
  music: ['https://www.rollingstone.com/music/feed/', 'https://www.billboard.com/feed/'],
  sports: ['https://www.espn.com/espn/rss/news'],
};

function briefingDecode(x) {
  return String(x || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

async function fetchBriefingHeadlines(categories) {
  const cats = (Array.isArray(categories) && categories.length ? categories : ['national', 'local'])
    .map((c) => String(c).toLowerCase())
    .filter((c) => BRIEFING_FEEDS[c]);
  const out = [];
  for (const cat of cats.length ? cats : ['national', 'local']) {
    for (const url of BRIEFING_FEEDS[cat]) {
      try {
        const r = await axios.get(url, {
          timeout: 12000, responseType: 'text',
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KadeAI-NewsReader/1.0)' },
          maxContentLength: 3 * 1024 * 1024,
        });
        const blocks = String(r.data).match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
        const titles = [];
        for (const b of blocks) {
          const m = b.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          const t = m && briefingDecode(m[1]);
          if (t) titles.push(t);
          if (titles.length >= 4) break;
        }
        if (titles.length) {
          out.push(`${cat.toUpperCase()}: ${titles.join(' • ')}`);
          break; // next category — this feed worked
        }
      } catch (e) {
        console.warn(`[briefing] feed failed (${url}): ${e.message}`);
      }
    }
  }
  return out.join('\n');
}

// POST /briefing — create/update a subscription (admin, BRIDGE_SECRET).
// Body: { secret, phone, time "HH:MM" CT, userId, categories?, name?,
//         userName?, agentId?, agentName?, enabled? }
app.post('/briefing', (req, res) => {
  const { secret, phone, time, categories, name, userId, userName, agentId, agentName, enabled } = req.body || {};
  if (!bridgeSecretOk(req, secret)) return res.status(403).json({ error: 'Unauthorized' });
  const e164 = normalizeUsPhone(phone);
  if (!e164) return res.status(400).json({ error: 'phone must be a valid US/Canada number' });
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(time || ''))) {
    return res.status(400).json({ error: 'time must be "HH:MM" (24h, America/Chicago)' });
  }
  if (!userId) return res.status(400).json({ error: 'userId required — whose Feed the Server page do the calls bill to?' });
  const reg = users.get(e164) || {};
  const prev = briefings.get(e164) || {};
  const sub = {
    name: name || reg.name || prev.name || 'there',
    userId: String(userId),
    userName: userName || name || reg.name || prev.userName || 'a Kade-AI user',
    agentId: agentId || reg.agentId || prev.agentId || DEFAULT_AGENT,
    agentName: agentName || reg.agentName || prev.agentName || DEFAULT_AGENT_NAME,
    time: String(time),
    categories: Array.isArray(categories) && categories.length ? categories : prev.categories || ['national', 'local'],
    enabled: enabled !== false,
    lastRun: prev.lastRun || null,
  };
  briefings.set(e164, sub);
  saveBriefings();
  console.log(`[briefing] subscription saved: ${e164} at ${sub.time} CT (${sub.categories.join(',')}) via ${sub.agentName}`);
  res.json({ ok: true, phone: e164, ...sub });
});

app.get('/briefings', (req, res) => {
  if (!bridgeSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
  res.json(Object.fromEntries(briefings));
});

app.delete('/briefing', (req, res) => {
  const secret = req.query.secret || (req.body && req.body.secret);
  if (!bridgeSecretOk(req, secret)) return res.status(403).json({ error: 'Unauthorized' });
  const e164 = normalizeUsPhone(req.query.phone || (req.body && req.body.phone));
  if (!e164 || !briefings.has(e164)) return res.status(404).json({ error: 'No subscription for that phone' });
  briefings.delete(e164);
  saveBriefings();
  res.json({ ok: true, removed: e164 });
});

async function fireBriefing(e164, sub, today) {
  sub.lastRun = today;
  saveBriefings();
  try {
    const headlines = await fetchBriefingHeadlines(sub.categories);
    if (!headlines) {
      console.warn(`[briefing] no headlines available for ${e164} — skipping today`);
      return;
    }
    const firstName = String(sub.name).trim().split(/\s+/)[0];
    const resp = await axios.post(`${PUBLIC_URL}/outbound-call`, {
      secret: BRIDGE_SECRET,
      to: e164,
      userId: sub.userId,
      userName: sub.userName,
      calleeName: firstName,
      agentId: sub.agentId,
      agentName: sub.agentName,
      purpose: `tell you today's news — the morning briefing you signed up for`,
      context:
        `THIS IS A SCHEDULED MORNING NEWS BRIEFING the callee subscribed to. ` +
        `Deliver today's headlines conversationally, morning-radio style, in your own voice — short and lively, not a list recital. ` +
        `They can ask you to expand on any story (only elaborate from what's below; never invent details). ` +
        `When they're done (or after the rundown if they're quiet), say a warm goodbye and end with [END CALL].\n\n` +
        `TODAY'S HEADLINES:\n${headlines}`,
    }, { timeout: 30000 });
    console.log(`[briefing] fired for ${e164}: call ${resp.data && resp.data.callSid}`);
  } catch (e) {
    console.error(`[briefing] failed for ${e164}: ${(e.response && JSON.stringify(e.response.data)) || e.message}`);
  }
}

setInterval(() => {
  if (!ENABLE_OUTBOUND || !twilioClient || briefings.size === 0) return;
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now).reduce((o, p) => ((o[p.type] = p.value), o), {});
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const hhmm = `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
    for (const [e164, sub] of briefings) {
      if (sub.enabled && sub.time === hhmm && sub.lastRun !== today) {
        fireBriefing(e164, sub, today);
      }
    }
  } catch (e) {
    console.error('[briefing] scheduler tick error:', e.message);
  }
}, 60 * 1000);


// ── FAMILY WELLNESS CALLS (July 11 2026, Kade's ask) ─────────────────────────
// Opt-in scheduled companion check-in calls to REGISTRY numbers only (family
// Kade has registered), riding the existing /outbound-call machinery — AI
// disclosure, caps, cooldowns, allowlists and recording all apply unchanged.
// After each call, an LLM writes a rich summary and the fork nudges it to the
// person who set the schedule up. Store: wellness.json on the volume.
//
//   POST   /wellness        create/update (BRIDGE_SECRET)
//   GET    /wellness        list — ?userId= scopes to one enroller
//   POST   /wellness/toggle pause/resume
//   POST   /wellness/fire   run one NOW (the "test with me listening" path)
//   DELETE /wellness?id=    remove
const WELLNESS_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(), 'wellness.json');
const wellness = new Map(Object.entries(loadJsonFile(WELLNESS_FILE, {})));
function saveWellness() { saveJsonFile(WELLNESS_FILE, Object.fromEntries(wellness)); }
const WELLNESS_MAX_PER_USER = Number(process.env.WELLNESS_MAX_PER_USER || 5);
const WELLNESS_MAX_TOTAL = Number(process.env.WELLNESS_MAX_TOTAL || 20);
const WELLNESS_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function centralNowParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(new Date()).reduce((o, p2) => ((o[p2.type] = p2.value), o), {});
  return {
    today: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
    day: String(parts.weekday || '').toLowerCase().slice(0, 3),
  };
}

/** Find a registered family member by name (or already-normalized number). */
function resolveRegistryPerson(who) {
  const asPhone = normalizeUsPhone(who);
  if (asPhone && users.has(asPhone)) {
    const u = users.get(asPhone) || {};
    return { e164: asPhone, name: u.name || 'there' };
  }
  const q = String(who || '').trim().toLowerCase();
  if (!q) return null;
  const entries = [...users.entries()].map(([e164, u]) => ({ e164, name: String((u || {}).name || '') }));
  let hit = entries.find((e) => e.name.toLowerCase() === q);
  if (!hit) hit = entries.find((e) => e.name.toLowerCase().split(/\s+/)[0] === q);
  if (!hit) hit = entries.find((e) => e.name.toLowerCase().startsWith(q));
  if (!hit) hit = entries.find((e) => e.name.toLowerCase().includes(q));
  return hit ? { e164: hit.e164, name: hit.name } : null;
}

function quietHoursBlocked(hhmm) {
  // No scheduled family calls between 9pm and 8am Central. Hard rule for v1.
  return hhmm >= '21:01' || hhmm < '08:00';
}

app.post('/wellness', (req, res) => {
  const b = req.body || {};
  if (b.secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  const existing = b.id ? wellness.get(String(b.id)) : null;
  if (b.id && !existing) return res.status(404).json({ error: 'No schedule with that id' });

  const person = b.who || b.to ? resolveRegistryPerson(b.who || b.to) : (existing ? { e164: existing.to, name: existing.targetName } : null);
  if (!person) {
    const names = [...users.values()].map((u) => (u || {}).name).filter(Boolean).join(', ');
    return res.status(400).json({ error: `I can only schedule check-ins for registered family. Registered people: ${names || '(nobody registered yet)'}` });
  }

  const time = String(b.time || (existing && existing.time) || '').trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return res.status(400).json({ error: 'time must be HH:mm, 24-hour, US Central' });
  if (quietHoursBlocked(time)) return res.status(400).json({ error: 'Scheduled check-ins run between 8:00 and 21:00 Central only — pick a daytime or evening time.' });

  let days = b.days !== undefined ? b.days : (existing ? existing.days : 'daily');
  if (typeof days === 'string' && days.toLowerCase() !== 'daily') days = days.split(/[,\s]+/).filter(Boolean);
  if (Array.isArray(days)) {
    days = days.map((d) => String(d).toLowerCase().slice(0, 3)).filter((d) => WELLNESS_DAYS.includes(d));
    if (!days.length) return res.status(400).json({ error: "days must be 'daily' or day names like ['mon','thu']" });
  } else {
    days = 'daily';
  }

  const enrolledBy = b.enrolledBy && b.enrolledBy.userId ? {
    userId: String(b.enrolledBy.userId).slice(0, 64),
    userName: String(b.enrolledBy.userName || 'a Kade-AI user').slice(0, 80),
  } : (existing ? existing.enrolledBy : null);
  if (!enrolledBy) return res.status(400).json({ error: 'enrolledBy.userId required — whose schedule (and whose spend) is this?' });

  if (!existing) {
    const mine = [...wellness.values()].filter((w) => w.enrolledBy.userId === enrolledBy.userId).length;
    if (mine >= WELLNESS_MAX_PER_USER) return res.status(429).json({ error: `Limit reached: ${WELLNESS_MAX_PER_USER} check-in schedules per person.` });
    if (wellness.size >= WELLNESS_MAX_TOTAL) return res.status(429).json({ error: 'Platform-wide wellness schedule limit reached.' });
  }

  const id = existing ? existing.id : crypto.randomBytes(6).toString('hex');
  const sub = {
    id,
    to: person.e164,
    targetName: person.name,
    days,
    time,
    agentId: b.agentId !== undefined ? String(b.agentId || DEFAULT_AGENT) : (existing ? existing.agentId : DEFAULT_AGENT),
    agentName: b.agentName !== undefined ? String(b.agentName || DEFAULT_AGENT_NAME).slice(0, 60) : (existing ? existing.agentName : DEFAULT_AGENT_NAME),
    topics: b.topics !== undefined ? String(b.topics || '').slice(0, 600) : (existing ? existing.topics : ''),
    enrolledBy,
    enabled: b.enabled !== undefined ? !!b.enabled : (existing ? existing.enabled : true),
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    lastRun: existing ? existing.lastRun : null,
  };
  wellness.set(id, sub);
  saveWellness();
  console.log(`[wellness] schedule ${existing ? 'updated' : 'created'}: ${id} -> ${person.name} (${sub.days === 'daily' ? 'daily' : sub.days.join(',')}) at ${sub.time} CT by ${enrolledBy.userName}`);
  res.json({ ok: true, schedule: sub });
});

app.get('/wellness', (req, res) => {
  if (!bridgeSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
  let rows = [...wellness.values()];
  if (req.query.userId) rows = rows.filter((w) => w.enrolledBy.userId === String(req.query.userId));
  res.json({ count: rows.length, schedules: rows });
});

app.post('/wellness/toggle', (req, res) => {
  const b = req.body || {};
  if (b.secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  const sub = wellness.get(String(b.id || ''));
  if (!sub) return res.status(404).json({ error: 'No schedule with that id' });
  sub.enabled = b.enabled !== undefined ? !!b.enabled : !sub.enabled;
  saveWellness();
  res.json({ ok: true, schedule: sub });
});

app.delete('/wellness', (req, res) => {
  const id = String((req.query.id || (req.body || {}).id) || '');
  const secret = req.query.secret || (req.body || {}).secret;
  if (!bridgeSecretOk(req, secret)) return res.status(403).json({ error: 'Unauthorized' });
  if (!wellness.has(id)) return res.status(404).json({ error: 'No schedule with that id' });
  const sub = wellness.get(id);
  wellness.delete(id);
  saveWellness();
  console.log(`[wellness] schedule deleted: ${id} (${sub.targetName})`);
  res.json({ ok: true, deleted: id });
});

app.post('/wellness/fire', async (req, res) => {
  const b = req.body || {};
  if (b.secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  const sub = wellness.get(String(b.id || ''));
  if (!sub) return res.status(404).json({ error: 'No schedule with that id' });
  try {
    const out = await fireWellnessCall(sub, { test: true });
    res.json({ ok: true, callSid: out && out.callSid, note: 'Test call dialing now. The summary will arrive after it ends.' });
  } catch (e) {
    const msg = (e.response && e.response.data && e.response.data.error) || e.message;
    res.status(500).json({ error: msg });
  }
});

async function fireWellnessCall(sub, { test = false } = {}) {
  const firstName = String(sub.enrolledBy.userName || '').trim().split(/\s+/)[0] || 'your family';
  const targetFirst = String(sub.targetName || '').trim().split(/\s+/)[0] || 'there';
  const topicsLine = sub.topics
    ? `\n\nTHINGS ${firstName.toUpperCase()} WANTED WOVEN IN (naturally, not as an interview): ${sub.topics}`
    : '';
  const resp = await axios.post(`${PUBLIC_URL}/outbound-call`, {
    secret: BRIDGE_SECRET,
    to: sub.to,
    userId: sub.enrolledBy.userId,
    userName: sub.enrolledBy.userName,
    calleeName: targetFirst,
    agentId: sub.agentId,
    agentName: sub.agentName,
    purpose: `check in and see how you're doing — ${firstName} set up these companion calls for you`,
    context:
      `THIS IS A SCHEDULED COMPANION CHECK-IN CALL that ${firstName} set up for ${targetFirst}. ` +
      `Your job: be warm, unhurried company. Ask how they're doing today and how they've been feeling; let THEM steer — follow whatever they bring up (memories, family, aches, weather, TV) and keep them talking rather than talking at them. ` +
      `Listen for anything worth passing along: how their mood seems, anything they need, health mentions, plans, and things they're looking forward to — you'll summarize this for ${firstName} afterward, so gently gather without interrogating. ` +
      `If they say they don't want these calls anymore, take it graciously, promise to pass that along, and keep the rest of the call kind. ` +
      `If they seem to be in real distress or an emergency, tell them clearly to hang up and call 911 (you cannot call for them), and make sure that lands in the conversation. ` +
      `Wrap up naturally when the conversation winds down — warm goodbye, then [END CALL].${topicsLine}` +
      (test ? `\n\nNOTE: this first one is a TEST RUN — ${firstName} is likely the person answering. Run it exactly like the real thing.` : ''),
    wellness: {
      scheduleId: sub.id,
      notifyUserId: sub.enrolledBy.userId,
      targetName: sub.targetName,
      topics: sub.topics || '',
    },
  }, { timeout: 30000 });
  console.log(`[wellness] ${test ? 'TEST ' : ''}call fired for ${sub.targetName}: ${resp.data && resp.data.callSid}`);
  return resp.data;
}

setInterval(() => {
  if (!ENABLE_OUTBOUND || !twilioClient || wellness.size === 0) return;
  try {
    const { today, hhmm, day } = centralNowParts();
    for (const sub of wellness.values()) {
      const dayOk = sub.days === 'daily' || (Array.isArray(sub.days) && sub.days.includes(day));
      if (sub.enabled && dayOk && sub.time === hhmm && sub.lastRun !== today) {
        sub.lastRun = today;
        saveWellness();
        fireWellnessCall(sub).catch((e) =>
          console.error(`[wellness] fire failed for ${sub.targetName}: ${(e.response && JSON.stringify(e.response.data)) || e.message}`));
      }
    }
  } catch (e) {
    console.error('[wellness] scheduler tick error:', e.message);
  }
}, 60 * 1000);

// ── Per-agent SCHEDULED OUTREACH ("your agent checks in on you") ───────────────
// Any agent can be told to reach out to the user on a recurring schedule. The
// bridge asks that agent (headless) for a short warm line and delivers it via the
// shared guardrailed runNotify (quiet hours + caps + cooldown apply). Schedules
// carry the requesting user; delivery targets ONLY that user's linked device(s)
// (see tokensForUser / runNotify above) — wired up July 2026 once /push-register
// started accepting userId, so this is safe to open to every user, not just admin.
// Auth: scoped NOTIFY_AGENT_SECRET or admin BRIDGE_SECRET.
const OUTREACH_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(), 'outreach.json');
const outreach = new Map(Object.entries(loadJsonFile(OUTREACH_FILE, {})));
function saveOutreach() { saveJsonFile(OUTREACH_FILE, Object.fromEntries(outreach)); }
const OUTREACH_MAX_PER_USER = Number(process.env.OUTREACH_MAX_PER_USER || 5);
const OUTREACH_MAX_TOTAL = Number(process.env.OUTREACH_MAX_TOTAL || 30);
const OUTREACH_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function buildOutreachPrompt(sub) {
  const topic = String(sub.topic || '').trim();
  return (
    'You are reaching out to the user on your own initiative — a scheduled check-in they asked you to send. ' +
    'Write ONE short, warm message (1 to 2 sentences, under 200 characters, easy to hear read aloud, no emoji, in your natural voice) ' +
    'that gently checks in or shares a small thought to brighten their day.' +
    (topic ? ` Weave in this, naturally, not as a checklist: ${topic}.` : '') +
    ' Reply with ONLY the message text, nothing else.'
  );
}

async function fireOutreach(sub, { urgent = false } = {}) {
  const text = await askAgentRich(sub.agentId, buildOutreachPrompt(sub));
  if (!text || !String(text).trim()) return { ok: false, error: 'agent returned no text' };
  const body = String(text).trim().replace(/^["']+|["']+$/g, '').slice(0, 280);
  const delivery = await runNotify({ agentId: sub.agentId, agentName: sub.agentName, title: sub.title || sub.agentName || 'Kade-AI', body, urgent, userId: sub.userId });
  return { ok: true, generated: body, delivery };
}

// POST /outreach — create/update. Body: {secret, id?, agentId, agentName, userId, userName,
//   time 'HH:mm' CT, days? ('daily' or ['mon',..]), topic?, title?, enabled?}
app.post('/outreach', (req, res) => {
  const b = req.body || {};
  if (!notifySecretOk(req, b.secret)) return res.status(403).json({ error: 'Unauthorized' });
  const existing = b.id ? outreach.get(String(b.id)) : null;
  if (b.id && !existing) return res.status(404).json({ error: 'No schedule with that id' });
  const userId = String(b.userId || (existing && existing.userId) || '').slice(0, 64);
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const userName = String(b.userName || (existing && existing.userName) || 'the user').slice(0, 80);
  const time = String(b.time || (existing && existing.time) || '').trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return res.status(400).json({ error: 'time must be HH:mm, 24-hour, US Central' });
  if (notifyInQuietHours(time)) return res.status(400).json({ error: `That time is inside quiet hours (${notifyPrefs.quietStart}-${notifyPrefs.quietEnd} Central) — pick a time when notifications are allowed.` });
  let days = b.days !== undefined ? b.days : (existing ? existing.days : 'daily');
  if (typeof days === 'string' && days.toLowerCase() !== 'daily') days = days.split(/[,\s]+/).filter(Boolean);
  if (Array.isArray(days)) {
    days = days.map((d) => String(d).toLowerCase().slice(0, 3)).filter((d) => OUTREACH_DAYS.includes(d));
    if (!days.length) return res.status(400).json({ error: "days must be 'daily' or day names like ['mon','thu']" });
  } else { days = 'daily'; }
  if (!existing) {
    const mine = [...outreach.values()].filter((o) => o.userId === userId).length;
    if (mine >= OUTREACH_MAX_PER_USER) return res.status(429).json({ error: `Limit reached: ${OUTREACH_MAX_PER_USER} check-in schedules per person.` });
    if (outreach.size >= OUTREACH_MAX_TOTAL) return res.status(429).json({ error: 'Platform-wide check-in schedule limit reached.' });
  }
  const id = existing ? existing.id : crypto.randomBytes(6).toString('hex');
  const sub = {
    id,
    agentId: b.agentId !== undefined ? String(b.agentId || DEFAULT_AGENT) : (existing ? existing.agentId : DEFAULT_AGENT),
    agentName: b.agentName !== undefined ? String(b.agentName || DEFAULT_AGENT_NAME).slice(0, 60) : (existing ? existing.agentName : DEFAULT_AGENT_NAME),
    userId, userName, time, days,
    topic: b.topic !== undefined ? String(b.topic || '').slice(0, 400) : (existing ? existing.topic : ''),
    title: b.title !== undefined ? String(b.title || '').slice(0, 40) : (existing ? existing.title : ''),
    enabled: b.enabled !== undefined ? !!b.enabled : (existing ? existing.enabled : true),
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    lastRun: existing ? existing.lastRun : null,
  };
  outreach.set(id, sub);
  saveOutreach();
  console.log(`[outreach] ${existing ? 'updated' : 'created'} ${id}: ${sub.agentName} -> user ${userId} ${sub.days === 'daily' ? 'daily' : sub.days.join(',')} at ${sub.time} CT`);
  res.json({ ok: true, schedule: sub });
});

app.get('/outreach', (req, res) => {
  if (!notifySecretOk(req, req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
  let rows = [...outreach.values()];
  if (req.query.userId) rows = rows.filter((o) => o.userId === String(req.query.userId));
  res.json({ count: rows.length, schedules: rows });
});

app.post('/outreach/toggle', (req, res) => {
  const b = req.body || {};
  if (!notifySecretOk(req, b.secret)) return res.status(403).json({ error: 'Unauthorized' });
  const sub = outreach.get(String(b.id || ''));
  if (!sub) return res.status(404).json({ error: 'No schedule with that id' });
  sub.enabled = b.enabled !== undefined ? !!b.enabled : !sub.enabled;
  saveOutreach();
  res.json({ ok: true, schedule: sub });
});

app.delete('/outreach', (req, res) => {
  const id = String((req.query.id || (req.body || {}).id) || '');
  const secret = req.query.secret || (req.body || {}).secret;
  if (!notifySecretOk(req, secret)) return res.status(403).json({ error: 'Unauthorized' });
  if (!outreach.has(id)) return res.status(404).json({ error: 'No schedule with that id' });
  outreach.delete(id);
  saveOutreach();
  console.log(`[outreach] deleted ${id}`);
  res.json({ ok: true, deleted: id });
});

app.post('/outreach/fire', async (req, res) => {
  const b = req.body || {};
  if (!notifySecretOk(req, b.secret)) return res.status(403).json({ error: 'Unauthorized' });
  const sub = outreach.get(String(b.id || ''));
  if (!sub) return res.status(404).json({ error: 'No schedule with that id' });
  try { res.json(await fireOutreach(sub, { urgent: b.urgent === true })); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Minute tick — fire each due schedule through the guardrailed notify path.
setInterval(() => {
  if (outreach.size === 0) return;
  try {
    const { today, hhmm, day } = centralNowParts();
    for (const sub of outreach.values()) {
      const dayOk = sub.days === 'daily' || (Array.isArray(sub.days) && sub.days.includes(day));
      if (sub.enabled && dayOk && sub.time === hhmm && sub.lastRun !== today) {
        sub.lastRun = today;
        saveOutreach();
        fireOutreach(sub)
          .then((r) => console.log(`[outreach] fired ${sub.id}: ${r.ok ? ('sent=' + (r.delivery && r.delivery.sent) + ' blocked=' + ((r.delivery && r.delivery.blocked) || '-')) : ('err=' + r.error)}`))
          .catch((e) => console.error(`[outreach] fire failed ${sub.id}: ${e.message}`));
      }
    }
  } catch (e) {
    console.error('[outreach] scheduler tick error:', e.message);
  }
}, 60 * 1000);


// ── One-off reminders (Notify Phase 3a) ─────────────────────────────────────
// Different shape from /outreach on purpose: outreach is RECURRING (daily/
// weekly) and the agent improvises fresh wording each time it fires; a
// reminder is a SINGLE future moment with TEXT THE AGENT ALREADY WROTE at
// creation time (e.g. "take your meds"). Reliability matters more than
// in-the-moment personality here, so firing just delivers the stored text
// verbatim instead of calling the agent again — no live LLM call on the
// delivery path at all. Fires once, then is deleted (no reason to keep a
// fired one-off around the way a recurring outreach schedule is kept).
const REMINDERS_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(), 'reminders.json');
const reminders = new Map(Object.entries(loadJsonFile(REMINDERS_FILE, {})));
function saveReminders() { saveJsonFile(REMINDERS_FILE, Object.fromEntries(reminders)); }
const REMINDER_MAX_PER_USER = Number(process.env.REMINDER_MAX_PER_USER || 10);
const REMINDER_MAX_TOTAL = Number(process.env.REMINDER_MAX_TOTAL || 300);
const REMINDER_MAX_MINUTES_OUT = Number(process.env.REMINDER_MAX_MINUTES_OUT || 129600); // 90 days

// Convert a Central-time wall clock (date 'YYYY-MM-DD', time 'HH:mm') to a real
// UTC Date, correct across the DST boundary, with no timezone library: guess,
// then measure how the guess reads back in America/Chicago vs the target and
// correct the difference — converges in 1-2 passes for any date, tested against
// both CST (UTC-6) and CDT (UTC-5) before shipping.
function centralWallTimeToUtc(dateStr, hhmm) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(hhmm || ''))) {
    return null;
  }
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const [h, mi] = String(hhmm).split(':').map(Number);
  let guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(guess).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    const hh = parts.hour === '24' ? '00' : parts.hour;
    const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(hh), Number(parts.minute));
    const target = Date.UTC(y, mo - 1, d, h, mi);
    guess = new Date(guess.getTime() + (target - asIfUtc));
  }
  return guess;
}

// Friendly Central-time display string for a Date, for confirmations back to
// the agent/user (e.g. "Jul 16, 2026, 3:00 PM Central") -- fireAt itself stays
// ISO/UTC as the source of truth for the firing tick.
function formatCentralDisplay(date) {
  const s = date.toLocaleString('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return `${s} Central`;
}

// POST /reminders — create. Body: {secret, agentId, agentName, userId, userName,
//   text (required, the literal reminder message), title?,
//   in_minutes? (simplest — relative, no timezone math) OR fire_date+fire_time
//   ('YYYY-MM-DD' + 'HH:mm', 24-hour Central, for a specific calendar moment)}
app.post('/reminders', (req, res) => {
  const b = req.body || {};
  if (!notifySecretOk(req, b.secret)) return res.status(403).json({ error: 'Unauthorized' });
  const userId = String(b.userId || '').slice(0, 64);
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const text = String(b.text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'text required -- the reminder message itself' });

  let fireAt;
  if (b.in_minutes !== undefined && b.in_minutes !== null && String(b.in_minutes) !== '') {
    const mins = Number(b.in_minutes);
    if (!Number.isFinite(mins) || mins < 1) return res.status(400).json({ error: 'in_minutes must be a positive number' });
    fireAt = new Date(Date.now() + mins * 60000);
  } else if (b.fire_date && b.fire_time) {
    fireAt = centralWallTimeToUtc(b.fire_date, b.fire_time);
    if (!fireAt) return res.status(400).json({ error: "fire_date must be 'YYYY-MM-DD' and fire_time 'HH:mm' (24-hour, Central)" });
  } else {
    return res.status(400).json({ error: "Provide either in_minutes, or both fire_date ('YYYY-MM-DD') and fire_time ('HH:mm' Central)" });
  }

  const minMs = Date.now() + 30 * 1000; // at least 30s out -- if it's "now", just use action=send
  const maxMs = Date.now() + REMINDER_MAX_MINUTES_OUT * 60000;
  if (fireAt.getTime() < minMs) return res.status(400).json({ error: 'That time has already passed (or is only seconds away) -- pick a moment at least a minute out, or use action=send for right now.' });
  if (fireAt.getTime() > maxMs) return res.status(400).json({ error: `Too far out -- reminders can be scheduled up to ${Math.floor(REMINDER_MAX_MINUTES_OUT / 1440)} days ahead.` });

  const mine = [...reminders.values()].filter((r) => r.userId === userId).length;
  if (mine >= REMINDER_MAX_PER_USER) return res.status(429).json({ error: `Limit reached: ${REMINDER_MAX_PER_USER} pending reminders per person. Cancel one first.` });
  if (reminders.size >= REMINDER_MAX_TOTAL) return res.status(429).json({ error: 'Platform-wide pending reminder limit reached.' });

  const id = crypto.randomBytes(6).toString('hex');
  const sub = {
    id,
    agentId: String(b.agentId || 'unknown'),
    agentName: String(b.agentName || 'Kade-AI').slice(0, 60),
    userId,
    userName: String(b.userName || 'the user').slice(0, 80),
    text,
    title: String(b.title || '').slice(0, 40),
    fireAt: fireAt.toISOString(),
    createdAt: new Date().toISOString(),
  };
  reminders.set(id, sub);
  saveReminders();
  console.log(`[reminders] created ${id}: ${sub.agentName} -> user ${userId} at ${sub.fireAt} ("${text.slice(0, 60)}")`);
  res.json({ ok: true, reminder: { ...sub, fireAtCentral: formatCentralDisplay(fireAt) } });
});

app.get('/reminders', (req, res) => {
  if (!notifySecretOk(req, req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
  let rows = [...reminders.values()];
  if (req.query.userId) rows = rows.filter((r) => r.userId === String(req.query.userId));
  rows.sort((a, b) => new Date(a.fireAt) - new Date(b.fireAt));
  rows = rows.map((r) => ({ ...r, fireAtCentral: formatCentralDisplay(new Date(r.fireAt)) }));
  res.json({ count: rows.length, reminders: rows });
});

app.delete('/reminders', (req, res) => {
  const id = String((req.query.id || (req.body || {}).id) || '');
  const secret = req.query.secret || (req.body || {}).secret;
  if (!notifySecretOk(req, secret)) return res.status(403).json({ error: 'Unauthorized' });
  if (!reminders.has(id)) return res.status(404).json({ error: 'No reminder with that id' });
  reminders.delete(id);
  saveReminders();
  console.log(`[reminders] cancelled ${id}`);
  res.json({ ok: true, deleted: id });
});

// Minute tick -- fire each due reminder through the guardrailed notify path,
// then delete it. urgent:true so a reminder actually fires at the moment the
// user picked even inside quiet hours -- unlike outreach check-ins
// (agent-initiated, optional timing), a reminder is a specific ask for a
// specific moment, so quiet hours shouldn't silently eat it. Cooldown and
// daily caps still apply (shared runNotify) -- only the quiet-hours window is
// bypassed.
setInterval(() => {
  if (reminders.size === 0) return;
  try {
    const now = Date.now();
    for (const sub of reminders.values()) {
      if (new Date(sub.fireAt).getTime() <= now) {
        reminders.delete(sub.id);
        saveReminders();
        runNotify({ agentId: sub.agentId, agentName: sub.agentName, title: sub.title || sub.agentName, body: sub.text, urgent: true, userId: sub.userId })
          .then((r) => console.log(`[reminders] fired ${sub.id}: ${r.ok ? ('sent=' + r.sent) : ('err=' + r.error)}`))
          .catch((e) => console.error(`[reminders] fire failed ${sub.id}: ${e.message}`));
      }
    }
  } catch (e) {
    console.error('[reminders] scheduler tick error:', e.message);
  }
}, 60 * 1000);


/** Plain proxy chat call (NO phone-brevity suffix — summaries should be rich). */
async function askAgentRich(agentId, userMessage) {
  const r = await axios.post(
    `${PROXY_URL}/librechat/ask`,
    { agentId, messages: [{ role: 'user', content: userMessage }] },
    { headers: { Authorization: `Bearer ${PROXY_SECRET}`, 'User-Agent': BROWSER_UA }, timeout: 150000 },
  );
  return (r.data && r.data.text) || null;
}

async function wellnessReportBack(record, w) {
  const enrolledFirst = 'the person who set this up';
  let summary = null;
  const transcript = (record.transcript || [])
    .map((t) => `${t.role === 'assistant' ? record.agentName : (w.targetName || 'Them')}: ${t.content}`)
    .join('\n');
  if (record.voicemail) {
    const vmLine = (record.transcript || []).map((t) => t.content).find((c) => String(c).startsWith('[VOICEMAIL LEFT]'));
    summary =
      `${w.targetName} didn't pick up — it went to voicemail, so ${record.agentName} left a short message` +
      (vmLine ? `: "${String(vmLine).replace('[VOICEMAIL LEFT] ', '')}"` : '.') +
      ' No conversation happened, so nothing to report on how they seemed.';
  } else if (record.status === 'completed' && transcript.trim()) {
    try {
      summary = await askAgentRich(
        record.agentId,
        `You just finished a scheduled companion check-in phone call with ${w.targetName}. Below is the transcript. ` +
        `Write a warm, detailed report (5-8 sentences of plain speakable prose, no lists, no headings) for the family member who set these calls up: ` +
        `how ${w.targetName} seemed (mood, energy), what you talked about, anything they need or mentioned needing, any health or worry mentions, ` +
        `plans or things they're looking forward to, and anything worth following up on. If they asked for the calls to stop, say so PROMINENTLY. ` +
        `Only report what the transcript actually supports.\n\nTRANSCRIPT:\n${transcript.slice(0, 12000)}`,
      );
    } catch (e) {
      console.warn('[wellness] summary generation failed:', e.message);
    }
  }
  if (!summary) {
    summary =
      record.status === 'completed'
        ? `The check-in call to ${w.targetName} connected (${Math.round((record.durationSec || 0) / 60)} min), but I couldn't write up a summary — the transcript is in Call History.`
        : `The scheduled check-in call to ${w.targetName} didn't connect (status: ${record.status}). I'll try again next scheduled time.`;
  }
  record.summary = String(summary).slice(0, 4000);
  saveJsonFile(OUTBOUND_LOG_FILE, outboundLog);

  if (!USAGE_EVENT_SECRET) return;
  const costLine = record.costUSD ? ` (call cost about $${record.costUSD.toFixed(2)})` : '';
  const text = `Check-in report — ${w.targetName}: ${record.summary}${costLine}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await axios.post(`${FORK_USAGE_URL}/api/kade/nudges/ingest`, {
        secret: USAGE_EVENT_SECRET,
        userId: w.notifyUserId,
        text: text.slice(0, 3000),
        type: 'wellness',
      }, { headers: { 'User-Agent': BROWSER_UA }, timeout: 10000 });
      console.log(`[wellness] report nudged to ${w.notifyUserId} for ${w.targetName}`);
      return;
    } catch (e) {
      console.warn(`[wellness] report nudge ${attempt}/3 failed:`, e.message);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 15000));
    }
  }
}

// Hooks for voice-stream.js

function getOutboundCtx(callSid) { return outboundMeta.get(callSid) || null; }
function onCallEnd(callSid, history) {
  const meta = outboundMeta.get(callSid);
  if (meta) {
    meta.transcript = (history || []).map((m) => ({
      role: m.role,
      content: String(m.content || '').slice(0, 2000),
    }));
  }
}
async function endCall(callSid) {
  try {
    await twilioClient.calls(callSid).update({ status: 'completed' });
    console.log(`[outbound] agent ended call ${callSid}`);
  } catch (e) { console.warn('[outbound] endCall failed:', e.message); }
}

// ── Start ──────────────────────────────────────────────────────────────────────
const server = http.createServer(app);

attachMediaStreams(server, users, {
  proxyUrl:         PROXY_URL,
  proxySecret:      PROXY_SECRET,
  ttsProxyUrl:      TTS_PROXY_URL,
  ttsModel:         process.env.PHONE_TTS_MODEL || 'tts-1-mini',
  defaultVoice:     DEFAULT_PHONE_VOICE,
  defaultAgent:     DEFAULT_AGENT,
  defaultAgentName: DEFAULT_AGENT_NAME,
  getAgents,
  getAgentTts: (id) => agentTtsCache.get(id) || null,
  refreshAgentTts,            // July 3 2026: mid-call switch targets may not be cached
  findVoice,                  // July 4 2026: name-match fallback (outbound parity) for switches
  saveUsers,
  seenCallNumbers,
  saveSeenCall: () => saveSeenSet(SEEN_CALL_FILE, seenCallNumbers),
  getOutboundCtx,
  onCallEnd,
  endCall,
  lookupVoicePref,   // July 12 2026: per-caller per-agent voice picks (fork)
  ingestVoicePref,
  fetchCallMemories, // July 12 2026: caller's own memory cards on calls
  fetchPronunciationDictionary, // July 20 2026: per-user name/word respellings
});

// WEB VOICE (July 9 2026): browser streaming calls on /ws/web-voice — the
// same engine as /ws/media with a browser transport. Ticket-authed (HMAC,
// minted by the fork); shares global._vsConfig set by attachMediaStreams
// above, so this call must stay AFTER it.
attachWebVoice(server);

// ── WEEKLY MEMORY CONSOLIDATION (July 18 2026) ────────────────────────────────
// The "weekly Sunday consolidation" existed in docs and memories but NOTHING
// ever scheduled it — the fork's /api/memories/consolidate is on-demand only,
// which is why duplicate memories accumulated unchecked (the July 12 wave sat
// in Cadence's per-agent bucket). This timer makes the myth real: Sundays at
// 04:00 Central it consolidates the shared bucket plus the agent buckets that
// demonstrably accumulate copies. Fail-soft everywhere: a failed pass logs and
// waits for next Sunday; it can never touch a call. Env overrides:
//   MEMCONSOLIDATE_ENABLED=false          — kill switch (default on)
//   MEMCONSOLIDATE_HOUR=4                 — Central hour to run
//   MEMCONSOLIDATE_AGENT_IDS=id1,id2,...  — extra buckets (replaces default list)
const MEMCONSOLIDATE_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(), 'memconsolidate.json');
const MEMCONSOLIDATE_DEFAULT_AGENTS = [
  'agent_6llV0eMu4fmIaj8f2x1Sb', // Kiana (default agent — most sessions)
  'agent_CTNCCJTVgl8XZnI1TTvNu', // Cadence (carried the July-12 dupe wave)
  'agent_9YHpms0vJoApICwshh0mR', // Lyric (audio sessions)
  'agent_fvTgx_UX145npdwfcP5e7', // Rio (video/animation sessions)
  'agent_FFecOqZ6hHCVpY507-VAD', // Forge (ops memories must stay clean)
];
setInterval(async () => {
  try {
    if (process.env.MEMCONSOLIDATE_ENABLED === 'false') return;
    const now = new Date();
    const dow = now.toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).toLowerCase().slice(0, 3);
    const hour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hour12: false }), 10);
    if (dow !== 'sun' || hour !== parseInt(process.env.MEMCONSOLIDATE_HOUR || '4', 10)) return;
    const day = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    let state = {};
    try { state = JSON.parse(fs.readFileSync(MEMCONSOLIDATE_FILE, 'utf8')); } catch { /* first run */ }
    if (state.lastRun === day) return;
    state.lastRun = day; // set first so a slow pass can't double-fire
    try { fs.writeFileSync(MEMCONSOLIDATE_FILE, JSON.stringify(state)); } catch { /* meter loss ≠ job loss */ }
    const token = await getLCToken();
    const buckets = [null].concat(
      (process.env.MEMCONSOLIDATE_AGENT_IDS
        ? process.env.MEMCONSOLIDATE_AGENT_IDS.split(',').map((s) => s.trim()).filter(Boolean)
        : MEMCONSOLIDATE_DEFAULT_AGENTS),
    );
    let ran = 0, skipped = 0, failed = 0;
    for (const agentId of buckets) {
      try {
        const r = await axios.post(
          `${LIBRECHAT_URL}/api/memories/consolidate`,
          agentId ? { agentId } : {},
          { headers: { Authorization: `Bearer ${token}`, 'User-Agent': BROWSER_UA }, timeout: 60000 },
        );
        if (r.data && r.data.ran) ran++; else skipped++;
      } catch (e) {
        failed++;
        console.error(`[memconsolidate] bucket ${agentId || 'shared'} failed: ${e.message}`);
      }
      await new Promise((res) => setTimeout(res, 5000)); // pace like everything else on this site
    }
    console.log(`[memconsolidate] weekly pass done: ran=${ran} empty=${skipped} failed=${failed}`);
  } catch (e) {
    console.error('[memconsolidate] tick error:', e.message);
  }
}, 10 * 60 * 1000); // check every 10 min; the lastRun guard makes it fire once per Sunday

// ── KADE CLOCK (July 18 2026) — the bridge is now the platform's alarm clock ──
// Phase 1 of pulling every recurring timer out of the LibreChat app: the app
// exposes on-demand sweep endpoints under /api/kade/clock/* (authed with the
// shared BRIDGE_SECRET), and THIS block owns when they fire. The app's own
// schedulers stand down once KADE_CLOCK_EXTERNAL=1 is set on the LibreChat
// service; deleting that env is the instant fork-side revert, CLOCK_ENABLED
// (unset/false) is the instant bridge-side one.
//
// Schedule (all UTC, matching what the fork ran in-process):
//   nudges         every 60s      (reminders/birthdays/phone prompts — exact-time delivery)
//   summary        daily  08:00   (KADE DREAMING relationship summaries + decay)
//   restart        daily  10:00   (memory-hygiene exit; fork refuses if booted <2h)
//   files          daily  11:00   (expired-file sweep)
//   consolidation  weekly Sun 09:00 (platform-wide memory consolidation — NOTE:
//                  this replaces BOTH the fork's sweep and the bucket-list
//                  MEMCONSOLIDATE timer above; keep MEMCONSOLIDATE_ENABLED=false)
//
// Env: CLOCK_ENABLED=true to run; CLOCK_SUMMARY_HOUR / CLOCK_RESTART_HOUR /
// CLOCK_FILES_HOUR / CLOCK_CONSOLIDATE_HOUR retune (UTC). lastRun state is
// volume-persisted so redeploys can't double-fire dailies. Fail-soft: a failed
// poke logs and retries next tick — never touches calls/SMS.
const CLOCK_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(), 'kadeclock.json');
const CLOCK_JOBS = [
  { name: 'summary', hourEnv: 'CLOCK_SUMMARY_HOUR', defHour: 8 },
  { name: 'restart', hourEnv: 'CLOCK_RESTART_HOUR', defHour: 10 },
  { name: 'files', hourEnv: 'CLOCK_FILES_HOUR', defHour: 11 },
  { name: 'consolidation', hourEnv: 'CLOCK_CONSOLIDATE_HOUR', defHour: 9, weeklyDowUTC: 0 },
];
let clockState = {};
try { clockState = JSON.parse(fs.readFileSync(CLOCK_FILE, 'utf8')); } catch { /* first run */ }
const clockLastPoke = { nudges: null, ok: null };

async function clockPoke(job) {
  const r = await axios.post(`${LIBRECHAT_URL}/api/kade/clock/${job}`, {}, {
    headers: { 'x-kade-secret': BRIDGE_SECRET, 'User-Agent': BROWSER_UA },
    timeout: 120000,
  });
  return r.data;
}

setInterval(async () => {
  if (process.env.CLOCK_ENABLED !== 'true' || !BRIDGE_SECRET) return;
  // 1) Nudge sweep. Default: every tick (exact-minute delivery, app stays
  // awake). CLOCK_NUDGE_SMART=true (Phase 2, App Sleeping): only poke when
  // (a) a reported reminder due-time has arrived, (b) the daily Central-time
  // windows open (birthdays 9am / phone prompts 10am — the app's own
  // once-per-day guards do the rest), or (c) the safety net says it's been
  // CLOCK_SAFETY_HOURS (default 6) since the last sweep. A pre-wake /health
  // ping fires ~2 min before a due reminder so a cold boot can't make it late.
  try {
    let poke = true;
    let why = 'everyTick';
    if (process.env.CLOCK_NUDGE_SMART === 'true') {
      poke = false;
      why = '';
      const nowMs = Date.now();
      const dueMs = clockState.nextDueAt ? Date.parse(clockState.nextDueAt) : NaN;
      if (!Number.isNaN(dueMs) && dueMs - nowMs > 0 && dueMs - nowMs <= 120000) {
        // pre-wake: any HTTP request un-sleeps the Railway app; don't await
        axios.get(`${LIBRECHAT_URL}/health`, { headers: { 'User-Agent': BROWSER_UA }, timeout: 110000 }).catch(() => {});
      }
      if (!Number.isNaN(dueMs) && nowMs >= dueMs) { poke = true; why = 'due'; }
      const cp = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
      }).formatToParts(new Date()).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
      const cDay = `${cp.year}-${cp.month}-${cp.day}`;
      const cHour = Number(cp.hour === '24' ? 0 : cp.hour);
      const wantAM = cHour >= 9 && clockState.nudgesDailyAM !== cDay;
      const wantPhone = cHour >= 10 && clockState.nudgesDailyPhone !== cDay;
      if (wantAM || wantPhone) { poke = true; why = why || (wantAM ? 'dailyAM' : 'dailyPhone'); }
      const safetyMs = (Number(process.env.CLOCK_SAFETY_HOURS) > 0 ? Number(process.env.CLOCK_SAFETY_HOURS) : 6) * 3600000;
      const lastMs = clockLastPoke.nudges ? Date.parse(clockLastPoke.nudges) : 0;
      if (nowMs - lastMs >= safetyMs) { poke = true; why = why || 'safety'; }
      if (poke) {
        // mark the daily windows served only once the poke SUCCEEDS (below);
        // stash which ones this attempt covers
        clockLastPoke.pendingAM = wantAM ? cDay : null;
        clockLastPoke.pendingPhone = wantPhone ? cDay : null;
      }
    }
    if (poke) {
      const data = await clockPoke('nudges');
      clockLastPoke.nudges = new Date().toISOString();
      clockLastPoke.ok = true;
      clockLastPoke.why = why;
      let dirty = false;
      if (clockLastPoke.pendingAM) { clockState.nudgesDailyAM = clockLastPoke.pendingAM; clockLastPoke.pendingAM = null; dirty = true; }
      if (clockLastPoke.pendingPhone) { clockState.nudgesDailyPhone = clockLastPoke.pendingPhone; clockLastPoke.pendingPhone = null; dirty = true; }
      if (data && Object.prototype.hasOwnProperty.call(data, 'nextDueAt')) {
        const v = data.nextDueAt || null;
        if (v !== clockState.nextDueAt) { clockState.nextDueAt = v; dirty = true; }
      }
      if (dirty) { try { fs.writeFileSync(CLOCK_FILE, JSON.stringify(clockState)); } catch { /* non-fatal */ } }
    }
  } catch (e) {
    clockLastPoke.ok = false;
    console.error('[clock] nudges poke failed:', e.message);
  }
  // 2) Dailies/weekly — wall-clock + persisted lastRun guard.
  const now = new Date();
  for (const job of CLOCK_JOBS) {
    try {
      if (now.getUTCHours() !== parseInt(process.env[job.hourEnv] || String(job.defHour), 10)) continue;
      if (job.weeklyDowUTC !== undefined && now.getUTCDay() !== job.weeklyDowUTC) continue;
      const dayKey = now.toISOString().slice(0, 10);
      if (clockState[job.name] === dayKey) continue;
      clockState[job.name] = dayKey; // set first so a slow pass can't double-fire
      try { fs.writeFileSync(CLOCK_FILE, JSON.stringify(clockState)); } catch { /* state loss ≠ job loss */ }
      const data = await clockPoke(job.name);
      console.log(`[clock] ${job.name} fired:`, JSON.stringify(data).slice(0, 300));
    } catch (e) {
      console.error(`[clock] ${job.name} failed:`, e.message);
    }
  }
}, 60 * 1000);

// Phase 2 (App Sleeping): the fork's due-time reporter posts here whenever
// the earliest pending reminder changes. null/absent = nothing scheduled.
app.post('/clock/next-due', (req, res) => {
  const h = req.get('x-kade-secret') || (req.body && req.body.secret);
  if (!BRIDGE_SECRET || h !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  const v = req.body ? req.body.nextDueAt : undefined;
  if (v !== null && v !== undefined && Number.isNaN(Date.parse(v))) {
    return res.status(400).json({ error: 'Bad nextDueAt' });
  }
  clockState.nextDueAt = v || null;
  try { fs.writeFileSync(CLOCK_FILE, JSON.stringify(clockState)); } catch { /* non-fatal */ }
  res.json({ ok: true, nextDueAt: clockState.nextDueAt });
});

// Observability: GET /clock/status?secret=... (or x-kade-secret header)
app.get('/clock/status', (req, res) => {
  const h = req.get('x-kade-secret') || req.query.secret;
  if (!BRIDGE_SECRET || h !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  res.json({
    enabled: process.env.CLOCK_ENABLED === 'true',
    smartNudges: process.env.CLOCK_NUDGE_SMART === 'true',
    nextDueAt: clockState.nextDueAt || null,
    lastNudgePoke: clockLastPoke.nudges,
    lastNudgeOk: clockLastPoke.ok,
    lastNudgeWhy: clockLastPoke.why || null,
    lastRuns: clockState,
  });
});

server.listen(port, () => {
  console.log(`[bridge] Port ${port} | Public: ${PUBLIC_URL}`);
  console.log(`[bridge] Default agent: ${DEFAULT_AGENT} (${DEFAULT_AGENT_NAME})`);
  if (!twilioClient) console.warn('[bridge] Twilio not configured -- set env vars');
});

