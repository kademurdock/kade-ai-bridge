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

function findAgent(agents, query) {
  if (!query || !agents.length) return null;
  const q = query.toLowerCase().trim();
  return agents.find(a => a.name.toLowerCase() === q)
      || agents.find(a => q.includes(a.name.toLowerCase()))
      || agents.find(a => a.name.toLowerCase().includes(q))
      || null;
}

function extractSwitchTarget(text, agents) {
  const m = text.match(
    /^(?:switch(?:\s+to)?|change(?:\s+to)?|talk(?:\s+to)?|give me|i want(?:\s+to(?:\s+talk(?:\s+to)?)?)?)\s+(.+)/i
  );
  const query = m ? m[1].trim() : (text.trim().split(/\s+/).length <= 2 ? text.trim() : null);
  return query ? findAgent(agents, query) : null;
}

// ── AI call ────────────────────────────────────────────────────────────────────
async function askAgent(agentId, history, userMessage) {
  if (history.length === 0) {
    history.push({ role: 'user', content: PHONE_BRIEF });
    history.push({ role: 'assistant', content: 'Understood.' });
  }
  history.push({ role: 'user', content: userMessage });
  while (history.length > 14) history.shift();
  const r = await axios.post(
    `${PROXY_URL}/librechat/ask`,
    { agentId, messages: history },
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
  vr.gather({ input: 'speech', speechTimeout: 'auto', timeout: 10,
    action: `/voice/heard/${callSid}`, method: 'POST' });
  vr.say({ voice: 'alice' }, 'Still there? Call back anytime!');
  vr.hangup();
  return vr.toString();
}

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, users: users.size }));

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
  const { phone, name, agentId, agentName, lcEmail, lcPass, secret } = req.body;
  if (secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const digits = phone.replace(/\D/g, '');
  const e164   = digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
  const record = { name: name || 'Friend', agentId: agentId || DEFAULT_AGENT, agentName: agentName || DEFAULT_AGENT_NAME };
  if (lcEmail) record.lcEmail = lcEmail;
  if (lcPass)  record.lcPass  = lcPass;
  users.set(e164, record);
  saveUsers();
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
  try {
    const reply = await askAgent(user.agentId, history, body);
    try {
      const wav = await synthesizeVoice(reply);
      const msg = twiml.message();
      msg.body(reply);
      msg.media(storeAudio(wav));
    } catch { twiml.message(reply); }
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
  users.set(e164, record);
  saveUsers();
  console.log('[bridge] Self-registered ' + e164 + ' as "' + name.trim() + '"');
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

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`[bridge] Port ${port} | Public: ${PUBLIC_URL}`);
  console.log(`[bridge] Default agent: ${DEFAULT_AGENT} (${DEFAULT_AGENT_NAME})`);
  if (!twilioClient) console.warn('[bridge] Twilio not configured -- set env vars');
});

