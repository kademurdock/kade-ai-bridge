/**
 * kade-ai-bridge — SMS + voice call bridge for Kade-AI
 *
 * Env vars (set in Railway):
 *   TWILIO_ACCOUNT_SID    — twilio.com/console
 *   TWILIO_AUTH_TOKEN     — twilio.com/console
 *   TWILIO_PHONE_NUMBER   — your Twilio number e.g. +14178923268
 *   LIBRECHAT_URL         — https://kademurdock.com
 *   LIBRECHAT_EMAIL       — login email
 *   LIBRECHAT_PASSWORD    — login password (Railway secret)
 *   DEFAULT_AGENT_ID      — fallback agent when caller has no preference
 *   BRIDGE_SECRET         — random string protecting /register & /users
 *   PORT                  — set automatically by Railway
 *   PUBLIC_URL            — set automatically via RAILWAY_PUBLIC_DOMAIN
 */

'use strict';

const express  = require('express');
const twilio   = require('twilio');
const axios    = require('axios');
const FormData = require('form-data');
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
const DEFAULT_AGENT   = process.env.DEFAULT_AGENT_ID || 'agent_6llV0eMu4fmIaj8f2x1Sb';
const DEFAULT_AGENT_NAME = 'Kiana';
const BRIDGE_SECRET   = process.env.BRIDGE_SECRET || 'change-me';
const PUBLIC_URL      = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.PUBLIC_URL || 'http://localhost:3000');

function getTwilioClient() {
  if (!TWILIO_SID || !TWILIO_TOKEN || TWILIO_SID === 'FILL_IN') return null;
  try { return twilio(TWILIO_SID, TWILIO_TOKEN); }
  catch (e) { console.warn('[bridge] Twilio init failed:', e.message); return null; }
}
const twilioClient = getTwilioClient();

// ── Persistent user store ─────────────────────────────────────────────────────
// users: phone (E.164) → { name, agentId, agentName }
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

const users       = loadUsers();
const convHistory = new Map(); // phone → [{role,content}] (last 10 SMS turns)
const voiceStates = new Map(); // callSid → {from, agentId, agentName, history}
const tempMedia   = new Map(); // id → {filePath, expires}

// ── Agent cache ───────────────────────────────────────────────────────────────
let _agentCache = null, _agentCacheExp = 0;

async function getAgents() {
  if (_agentCache && Date.now() < _agentCacheExp) return _agentCache;
  try {
    const token = await getLCToken();
    const r = await axios.get(`${LIBRECHAT_URL}/api/agents?limit=100`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });
    _agentCache    = (r.data.data || []).filter(a => a.isPublic);
    _agentCacheExp = Date.now() + 60 * 60 * 1000; // refresh hourly
    console.log(`[bridge] Agent cache refreshed: ${_agentCache.length} public agents`);
  } catch (e) {
    console.error('[bridge] Failed to fetch agents:', e.message);
    _agentCache = _agentCache || [];
  }
  return _agentCache;
}

// Three-level fuzzy match: exact → query contains name → name contains query
function findAgent(agents, query) {
  if (!query || !agents.length) return null;
  const q = query.toLowerCase().trim();
  return agents.find(a => a.name.toLowerCase() === q)
      || agents.find(a => q.includes(a.name.toLowerCase()))
      || agents.find(a => a.name.toLowerCase().includes(q))
      || null;
}

// Detect "switch to X" command or a bare agent name (≤2 words) in an utterance.
// Returns the matched agent object or null.
function extractSwitchTarget(text, agents) {
  const m = text.match(
    /^(?:switch(?:\s+to)?|change(?:\s+to)?|talk(?:\s+to)?|give me|i want(?:\s+to(?:\s+talk(?:\s+to)?)?)?)\s+(.+)/i
  );
  const query = m ? m[1].trim() : (text.trim().split(/\s+/).length <= 2 ? text.trim() : null);
  return query ? findAgent(agents, query) : null;
}

// ── LibreChat auth ─────────────────────────────────────────────────────────────
let _lcToken = null, _lcTokenExp = 0;
async function getLCToken() {
  if (_lcToken && Date.now() < _lcTokenExp) return _lcToken;
  const r = await axios.post(
    `${LIBRECHAT_URL}/api/auth/login`,
    { email: LIBRECHAT_EMAIL, password: LIBRECHAT_PASS },
    { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }
  );
  _lcToken    = r.data.token;
  _lcTokenExp = Date.now() + 20 * 60 * 1000;
  return _lcToken;
}

// ── AI call ────────────────────────────────────────────────────────────────────
async function askAgent(agentId, history, userMessage) {
  const token = await getLCToken();
  history.push({ role: 'user', content: userMessage });
  while (history.length > 10) history.shift();

  const r = await axios.post(
    `${LIBRECHAT_URL}/api/ask/agents`,
    { agentId, messages: history, conversationId: null, parentMessageId: null },
    {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Mozilla/5.0' },
      responseType: 'stream',
      timeout: 30000,
    }
  );

  let reply = '';
  await new Promise((resolve, reject) => {
    r.data.on('data', chunk => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try { const d = JSON.parse(line.slice(6)); if (d.text) reply = d.text; } catch {}
      }
    });
    r.data.on('end', resolve);
    r.data.on('error', reject);
  });

  if (!reply) throw new Error('Empty reply from agent');
  history.push({ role: 'assistant', content: reply });
  return reply;
}

// ── TTS + audio hosting ────────────────────────────────────────────────────────
async function synthesizeVoice(text) {
  const fd = new FormData();
  fd.append('input', text.slice(0, 4096));
  const r = await axios.post(
    `${LIBRECHAT_URL}/api/files/speech/tts/manual`,
    fd,
    { headers: { ...fd.getHeaders(), 'User-Agent': 'Mozilla/5.0' }, responseType: 'arraybuffer', timeout: 30000 }
  );
  return Buffer.from(r.data);
}

function storeAudio(buffer) {
  const id  = crypto.randomBytes(12).toString('hex');
  const fp  = path.join(os.tmpdir(), `bridge-${id}.wav`);
  fs.writeFileSync(fp, buffer);
  tempMedia.set(id, { filePath: fp, expires: Date.now() + 5 * 60 * 1000 });
  setTimeout(() => { try { fs.unlinkSync(fp); } catch {} tempMedia.delete(id); }, 5 * 60 * 1000);
  return `${PUBLIC_URL}/media/${id}`;
}

// Play synthesized audio; fall back to Twilio alice if TTS fails
async function playOrSay(twiml, text) {
  try {
    const wav = await synthesizeVoice(text);
    twiml.play(storeAudio(wav));
  } catch {
    twiml.say({ voice: 'alice' }, text);
  }
}

// Build a TwiML string that plays a message then kicks off a fresh Record.
// Used by the transcription callback when it needs to update a live call
// (e.g. after an agent switch).
async function buildReRecordTwiml(message) {
  const vr = new twilio.twiml.VoiceResponse();
  await playOrSay(vr, message);
  vr.record({
    action:             '/voice/reply',
    method:             'POST',
    timeout:            5,
    maxLength:          120,
    playBeep:           true,
    transcribe:         true,
    transcribeCallback: '/voice/transcribed',
  });
  return vr.toString();
}

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, users: users.size }));

// ── Serve temp audio ──────────────────────────────────────────────────────────
app.get('/media/:id', (req, res) => {
  const e = tempMedia.get(req.params.id);
  if (!e || Date.now() > e.expires) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/wav');
  res.sendFile(path.resolve(e.filePath));
});

// ── Admin: register / list users ───────────────────────────────────────────────
app.post('/register', (req, res) => {
  const { phone, name, agentId, agentName, secret } = req.body;
  if (secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const digits = phone.replace(/\D/g, '');
  const e164   = digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
  users.set(e164, {
    name:      name      || 'Friend',
    agentId:   agentId   || DEFAULT_AGENT,
    agentName: agentName || DEFAULT_AGENT_NAME,
  });
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
      const url = storeAudio(wav);
      const msg = twiml.message();
      msg.body(reply);
      msg.media(url);
    } catch {
      twiml.message(reply);
    }
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
    // ── NEW CALLER: capture name, then register and jump into chat ──
    voiceStates.set(callSid, { from, agentId: DEFAULT_AGENT, agentName: DEFAULT_AGENT_NAME, history: [] });
    await playOrSay(twiml, "Hey! I don't have you on file yet. What's your name?");
    twiml.gather({
      input:         'speech',
      speechTimeout: 'auto',
      timeout:       8,
      action:        `/voice/setup/${callSid}`,
      method:        'POST',
    });
    twiml.say({ voice: 'alice' }, "I didn't catch that. Call back anytime!");
    twiml.hangup();
  } else {
    // ── EXISTING CALLER: short greeting, straight to recording ──
    voiceStates.set(callSid, { from, agentId: user.agentId, agentName: user.agentName || DEFAULT_AGENT_NAME, history: [] });
    await playOrSay(twiml,
      `Hey ${user.name}! You're with ${user.agentName || DEFAULT_AGENT_NAME}. ` +
      `Go ahead — say "switch to" and an agent name anytime to change.`
    );
    twiml.record({
      action:             '/voice/reply',
      method:             'POST',
      timeout:            5,
      maxLength:          120,
      playBeep:           true,
      transcribe:         true,
      transcribeCallback: '/voice/transcribed',
    });
  }

  res.type('text/xml').send(twiml.toString());
});

// ── Voice: name capture for new callers ───────────────────────────────────────
app.post('/voice/setup/:callSid', async (req, res) => {
  const twiml   = new twilio.twiml.VoiceResponse();
  const callSid = req.params.callSid;
  const state   = voiceStates.get(callSid);
  const name    = (req.body.SpeechResult || '').trim() || 'Friend';

  if (state) {
    users.set(state.from, { name, agentId: DEFAULT_AGENT, agentName: DEFAULT_AGENT_NAME });
    saveUsers();
    console.log(`[voice] self-registered ${state.from} as "${name}"`);
  }

  await playOrSay(twiml,
    `Nice to meet you, ${name}! You're talking to ${DEFAULT_AGENT_NAME} by default. ` +
    `Go ahead and speak — say "switch to" and a name anytime to change agents.`
  );
  twiml.record({
    action:             '/voice/reply',
    method:             'POST',
    timeout:            5,
    maxLength:          120,
    playBeep:           true,
    transcribe:         true,
    transcribeCallback: '/voice/transcribed',
  });

  res.type('text/xml').send(twiml.toString());
});

// ── Voice: reply placeholder (holds the call while transcription processes) ────
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

  res.status(200).end(); // Twilio doesn't need a response here
  if (!state || !text || !twilioClient) return;
  console.log(`[voice] transcribed callSid=${callSid}: "${text}"`);

  try {
    const agents = await getAgents();
    const target = extractSwitchTarget(text, agents);

    if (target && target.id !== state.agentId) {
      // ── Agent switch ──
      console.log(`[voice] switching ${state.agentId} → ${target.name} (${target.id})`);
      state.agentId   = target.id;
      state.agentName = target.name;
      state.history   = []; // fresh context with the new agent
      const user = users.get(state.from);
      if (user) { user.agentId = target.id; user.agentName = target.name; saveUsers(); }
      const twimlStr = await buildReRecordTwiml(`Switching to ${target.name}! What do you want to say?`);
      await twilioClient.calls(callSid).update({ twiml: twimlStr });
    } else {
      // ── Normal conversation turn ──
      const reply    = await askAgent(state.agentId, state.history, text);
      const wav      = await synthesizeVoice(reply);
      const audioUrl = storeAudio(wav);

      const vr = new twilio.twiml.VoiceResponse();
      vr.play(audioUrl);
      vr.gather({
        input:         'speech',
        speechTimeout: 'auto',
        timeout:       8,
        action:        `/voice/continue/${callSid}`,
        method:        'POST',
      });
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

// ── Voice: continued conversation turns ───────────────────────────────────────
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
    const agents = await getAgents();
    const target = extractSwitchTarget(speech, agents);

    if (target && target.id !== state.agentId) {
      // ── Mid-call agent switch ──
      console.log(`[voice] mid-call switch → ${target.name}`);
      state.agentId   = target.id;
      state.agentName = target.name;
      state.history   = [];
      const user = users.get(state.from);
      if (user) { user.agentId = target.id; user.agentName = target.name; saveUsers(); }
      await playOrSay(twiml, `Switching to ${target.name}! What's on your mind?`);
    } else {
      // ── Regular turn ──
      const reply = await askAgent(state.agentId, state.history, speech);
      const wav   = await synthesizeVoice(reply);
      twiml.play(storeAudio(wav));
    }
  } catch (err) {
    console.error('[voice] continue error:', err.message);
    twiml.say({ voice: 'alice' }, 'Sorry, something went wrong. Try again.');
  }

  // Re-gather for next turn
  twiml.gather({
    input:         'speech',
    speechTimeout: 'auto',
    timeout:       8,
    action:        `/voice/continue/${callSid}`,
    method:        'POST',
  });
  twiml.say({ voice: 'alice' }, 'Talk to you later!');
  twiml.hangup();

  res.type('text/xml').send(twiml.toString());
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`[bridge] Port ${port} | Public: ${PUBLIC_URL}`);
  console.log(`[bridge] Default agent: ${DEFAULT_AGENT} (${DEFAULT_AGENT_NAME})`);
  if (!twilioClient) console.warn('[bridge] Twilio not configured — set env vars');
});
