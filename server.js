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
const { attachMediaStreams, synthesize: vsSynthesize } = require('./voice-stream');
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
const BRIDGE_SECRET   = process.env.BRIDGE_SECRET || 'change-me';
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
function fixPronunciation(text) {
  return text.replace(/\bKade\b/g, 'Kadie').replace(/\bkade\b/g, 'kadie');
}

// ── Phone voice list ──────────────────────────────────────────────────────────
// Curated subset of available Inworld voices, friendly for phone conversations.
// Full list at kademurdock.com/voices — these are just the ones worth switching to by name.
const PHONE_VOICES = [
  'Sarah', 'Julia', 'Olivia', 'Timothy', 'Edward', 'Dennis',
  'Amy', 'Hannah', 'Kiana (Comedian)', 'Zadiana', 'Honey', 'Sadie',
  'Lannie', 'Reanne', 'Sharma', 'Fara', 'Fucia', 'Colby', 'Zadia',
  'Mazy (Podcaster)', 'Houston Stone', 'DJ Velvet', 'Podcaster 1', 'Podcaster 2',
];


const SIGNUP_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>Register your phone — Kade AI</title>\n  <style>\n    * { box-sizing: border-box; margin: 0; padding: 0; }\n    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e8e8e8; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 1rem; }\n    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 2rem; width: 100%; max-width: 400px; }\n    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }\n    p { color: #999; font-size: 0.9rem; margin-bottom: 1.5rem; line-height: 1.5; }\n    label { display: block; font-size: 0.85rem; color: #ccc; margin-bottom: 0.35rem; }\n    input { width: 100%; padding: 0.65rem 0.85rem; background: #111; border: 1px solid #333; border-radius: 8px; color: #e8e8e8; font-size: 1rem; margin-bottom: 1rem; }\n    input:focus { outline: none; border-color: #555; }\n    button { width: 100%; padding: 0.75rem; background: #7c3aed; border: none; border-radius: 8px; color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer; }\n    button:hover { background: #6d28d9; }\n    .msg { margin-top: 1rem; padding: 0.75rem; border-radius: 8px; font-size: 0.9rem; text-align: center; display: none; }\n    .msg.ok { background: #14532d; color: #86efac; display: block; }\n    .msg.err { background: #450a0a; color: #fca5a5; display: block; }\n  </style>\n</head>\n<body>\n  <div class=\"card\">\n    <h1>Register your phone</h1>\n    <p>So the AI knows who you are when you call in to the Kade AI line.</p>\n    <form id=\"f\">\n      <label for=\"name\">Your name</label>\n      <input id=\"name\" name=\"name\" type=\"text\" placeholder=\"Mom\" required autocomplete=\"name\">\n      <label for=\"phone\">Phone number</label>\n      <input id=\"phone\" name=\"phone\" type=\"tel\" placeholder=\"417-555-1234\" required autocomplete=\"tel\">\n      <button type=\"submit\">Register</button>\n    </form>\n    <div id=\"msg\" class=\"msg\"></div>\n  </div>\n  <script>\n    document.getElementById('f').addEventListener('submit', async e => {\n      e.preventDefault();\n      const btn = e.target.querySelector('button');\n      btn.disabled = true; btn.textContent = 'Registering...';\n      const msg = document.getElementById('msg');\n      msg.className = 'msg'; msg.textContent = '';\n      try {\n        const r = await fetch('/signup', {\n          method: 'POST',\n          headers: { 'Content-Type': 'application/json' },\n          body: JSON.stringify({ name: document.getElementById('name').value.trim(), phone: document.getElementById('phone').value.trim() })\n        });\n        const d = await r.json();\n        if (d.ok) { msg.className = 'msg ok'; msg.textContent = \"You're registered! Next time you call, the AI will know your name.\"; e.target.reset(); }\n        else { msg.className = 'msg err'; msg.textContent = d.error || 'Something went wrong. Try again.'; }\n      } catch { msg.className = 'msg err'; msg.textContent = 'Network error. Try again.'; }\n      btn.disabled = false; btn.textContent = 'Register';\n    });\n  </script>\n</body>\n</html>";

function findVoice(query) {
  if (!query) return null;
  const q = query.toLowerCase().trim();
  return PHONE_VOICES.find(v => v.toLowerCase() === q)
      || PHONE_VOICES.find(v => q.includes(v.toLowerCase()))
      || PHONE_VOICES.find(v => v.toLowerCase().includes(q))
      || null;
}

function extractVoiceSwitch(text) {
  const m = text.match(
    /^(?:switch|change)\s+(?:my\s+)?voice(?:\s+to)?\s+(.+)|^(?:use|set)\s+(?:the\s+)?voice(?:\s+to)?\s+(.+)/i
  );
  if (!m) return null;
  return findVoice((m[1] || m[2]).trim());
}

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
    { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }
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
    { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }
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
    { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }
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
      headers: { Authorization: `Bearer ${PROXY_SECRET}`, 'User-Agent': 'Mozilla/5.0' },
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
      headers: { Authorization: `Bearer ${PROXY_SECRET}`, 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000,
    });
    const tts = r.data?.tts || {};
    agentTtsCache.set(agentId, {
      voiceId: tts.voiceId || null,
      rate: typeof tts.speakingRate === 'number' ? tts.speakingRate : null,
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
setTimeout(refreshAllAgentTts, 5000);          // boot (give users load a beat)
setInterval(refreshAllAgentTts, 15 * 60 * 1000); // builder voice changes land within 15 min

// Fuzzy matching (July 2 2026): same code as voice-stream.js — STT/typos
// mangle invented names, so exact matching alone fails on the names that
// matter most.
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
  const query = m ? m[1].trim() : (text.trim().split(/\s+/).length <= 2 ? text.trim() : null);
  return query ? findAgent(agents, query) : null;
}

// ── AI call ────────────────────────────────────────────────────────────────────
// Appended to the LAST user turn on every call. A brevity note placed at the
// START of history (the old PHONE_BRIEF seed) was flatly ignored — Kiana wrote
// 2000+ char essays, which on the phone meant ~20-30s generation + minutes of
// TTS playback + wasted phone/TTS cost. Appending a forceful instruction right
// after the caller's words (recency) makes the model actually obey: replies drop
// to ~1-2 sentences and latency to ~3-8s. Kept out of stored history so it never
// accumulates.
const PHONE_SUFFIX =
  '\n\n[PHONE CALL — you are literally on the phone with this person right now. ' +
  'Talk the way you naturally would: warm, engaged, conversational. ' +
  'Do NOT monologue — two or three sentences is usually right, go longer only if you are ' +
  'genuinely mid-story and it would feel weird to stop. ' +
  'If you have been going for a while, throw in a natural check-in: ' +
  '\"am I rambling?\" or \"jump in whenever\" — whatever fits your voice. ' +
  'No lists, no markdown, no formatting. Just talk.]';

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
      headers: { Authorization: `Bearer ${PROXY_SECRET}`, 'User-Agent': 'Mozilla/5.0' },
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
  if (secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
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
  if (req.query.secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  res.json(Object.fromEntries(users));
});

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
    let outText = reply.replace(/\[sound:[a-z0-9_]+\]/gi, '').replace(/[ \t]{2,}/g, ' ').trim();
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
  const { to, secret, userId, userName, purpose, calleeName: rawCalleeName, agentId, agentName, voice, context } = req.body || {};
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
  if (secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
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
      { headers: { Authorization: `Bearer ${PROXY_SECRET}`, 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 },
    );
    outVoice = ar.data?.tts?.voiceId || null;
    outRate = typeof ar.data?.tts?.speakingRate === 'number' ? ar.data.tts.speakingRate : null;
  } catch (e) {
    console.warn('[outbound] agent voice lookup failed (using fallbacks):', e.message);
  }
  if (!outVoice) outVoice = findVoice(agentName || DEFAULT_AGENT_NAME);
  if (!outVoice) outVoice = voice || DEFAULT_PHONE_VOICE;
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
    if (/^(?:to\s+)?(?:ask|find out|check|see|confirm|verify|make sure|place|order|book|schedule|cancel|request|remind|tell|invite|wish|set up|pick up|drop off|let)\b/i.test(t)) {
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
  const introText =
    `This is ${agentName || DEFAULT_AGENT_NAME}, an A I assistant calling for ` +
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
    transcript: meta.transcript || null,
  };
  outboundLog.push(record);
  while (outboundLog.length > 500) outboundLog.shift();
  saveJsonFile(OUTBOUND_LOG_FILE, outboundLog);
  outboundMeta.delete(callSid);
  console.log(`[outbound] finalized ${callSid}: status=${record.status} ${duration}s $${costUSD}`);

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
          headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000,
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
  if (secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
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
  if (req.query.secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  const full = req.query.full === '1';
  const rows = [...outboundLog].reverse().slice(0, 50).map((r) =>
    full ? r : { ...r, transcript: r.transcript ? `${r.transcript.length} turns (add &full=1)` : null });
  res.json({ count: outboundLog.length, calls: rows });
});

// Admin: stream a call recording as mp3 (proxies Twilio auth so a plain
// browser link works — needed for QA listening).
app.get('/outbound/recording/:callSid', async (req, res) => {
  if (req.query.secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
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
  if (secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
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
  if (req.query.secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  res.json(Object.fromEntries(briefings));
});

app.delete('/briefing', (req, res) => {
  const secret = req.query.secret || (req.body && req.body.secret);
  if (secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
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
  saveUsers,
  seenCallNumbers,
  saveSeenCall: () => saveSeenSet(SEEN_CALL_FILE, seenCallNumbers),
  getOutboundCtx,
  onCallEnd,
  endCall,
});

server.listen(port, () => {
  console.log(`[bridge] Port ${port} | Public: ${PUBLIC_URL}`);
  console.log(`[bridge] Default agent: ${DEFAULT_AGENT} (${DEFAULT_AGENT_NAME})`);
  if (!twilioClient) console.warn('[bridge] Twilio not configured -- set env vars');
});

