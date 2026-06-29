/**
 * kade-ai-bridge — SMS + voice call bridge for Kade-AI
 *
 * Environment variables (set in Railway):
 *   TWILIO_ACCOUNT_SID    — twilio.com/console
 *   TWILIO_AUTH_TOKEN     — twilio.com/console
 *   TWILIO_PHONE_NUMBER   — your Twilio number e.g. +15551234567
 *   LIBRECHAT_URL         — https://kademurdock.com
 *   LIBRECHAT_EMAIL       — login email
 *   LIBRECHAT_PASSWORD    — login password (Railway secret)
 *   DEFAULT_AGENT_ID      — fallback agent when caller isn't registered
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
const TWILIO_SID    = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const LIBRECHAT_URL = (process.env.LIBRECHAT_URL || 'https://kademurdock.com').replace(/\/$/, '');
const LIBRECHAT_EMAIL = process.env.LIBRECHAT_EMAIL;
const LIBRECHAT_PASS  = process.env.LIBRECHAT_PASSWORD;
const DEFAULT_AGENT = process.env.DEFAULT_AGENT_ID || 'agent_6llV0eMu4fmIaj8f2x1Sb';
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'change-me';
const PUBLIC_URL    = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.PUBLIC_URL || 'http://localhost:3000');

function getTwilioClient() {
  if (!TWILIO_SID || !TWILIO_TOKEN || TWILIO_SID === 'FILL_IN') return null;
  try { return twilio(TWILIO_SID, TWILIO_TOKEN); }
  catch (e) { console.warn('[bridge] Twilio init failed:', e.message); return null; }
}
const twilioClient = getTwilioClient();

// ── Stores ────────────────────────────────────────────────────────────────────
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
const convHistory = new Map(); // phone → [{role,content}] (last 10 turns)
const voiceStates = new Map(); // callSid → {from, agentId, history}
const tempMedia   = new Map(); // id → {filePath, expires}

// ── LibreChat auth ─────────────────────────────────────────────────────────────
let _lcToken = null, _lcTokenExp = 0;
async function getLCToken() {
  if (_lcToken && Date.now() < _lcTokenExp) return _lcToken;
  const r = await axios.post(`${LIBRECHAT_URL}/api/auth/login`,
    { email: LIBRECHAT_EMAIL, password: LIBRECHAT_PASS },
    { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }
  );
  _lcToken   = r.data.token;
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

// ── TTS ────────────────────────────────────────────────────────────────────────
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

// ── Temp audio hosting ─────────────────────────────────────────────────────────
function storeAudio(buffer) {
  const id  = crypto.randomBytes(12).toString('hex');
  const fp  = path.join(os.tmpdir(), `bridge-${id}.wav`);
  fs.writeFileSync(fp, buffer);
  tempMedia.set(id, { filePath: fp, expires: Date.now() + 5 * 60 * 1000 });
  setTimeout(() => { try { fs.unlinkSync(fp); } catch {} tempMedia.delete(id); }, 5 * 60 * 1000);
  return `${PUBLIC_URL}/media/${id}`;
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

// ── Registration ───────────────────────────────────────────────────────────────
// POST /register  { phone, name, agentId, secret }
app.post('/register', (req, res) => {
  const { phone, name, agentId, secret } = req.body;
  if (secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const digits = phone.replace(/\D/g, '');
  const e164   = digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
  users.set(e164, { agentId: agentId || DEFAULT_AGENT, name: name || 'Friend' });
  saveUsers();
  console.log(`[bridge] Registered ${e164} → ${agentId || DEFAULT_AGENT} (${name})`);
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

  const user    = users.get(from) || { agentId: DEFAULT_AGENT, name: 'there' };
  const history = convHistory.get(from) || [];
  convHistory.set(from, history);

  try {
    const reply = await askAgent(user.agentId, history, body);

    // Try to send audio via MMS first; fall back to text-only
    try {
      const wav = await synthesizeVoice(reply);
      const url = storeAudio(wav);
      const msg = twiml.message();
      msg.body(reply);
      msg.media(url);
    } catch (ttsErr) {
      console.error('[sms] TTS failed, text only:', ttsErr.message);
      twiml.message(reply);
    }
  } catch (err) {
    console.error('[sms] Error:', err.message);
    twiml.message("Sorry, I'm having trouble right now. Try again in a moment.");
  }

  res.type('text/xml').send(twiml.toString());
});

// ── Voice: inbound call ───────────────────────────────────────────────────────
app.post('/voice', async (req, res) => {
  const twiml   = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const from    = req.body.From;
  const user    = users.get(from) || { agentId: DEFAULT_AGENT, name: 'there' };
  voiceStates.set(callSid, { from, agentId: user.agentId, history: [] });
  console.log(`[voice] inbound from=${from} callSid=${callSid}`);

  try {
    const greeting = `Hi ${user.name}! You've reached Kade-AI. Go ahead and speak after the tone — pause when you're done.`;
    const wav = await synthesizeVoice(greeting);
    twiml.play(storeAudio(wav));
  } catch {
    twiml.say({ voice: 'alice' }, "Hi! You've reached Kade-AI. Speak your message after the tone.");
  }

  twiml.record({
    action: '/voice/reply',
    method: 'POST',
    timeout: 5,
    maxLength: 120,
    playBeep: true,
    transcribe: true,
    transcribeCallback: '/voice/transcribed',
  });

  res.type('text/xml').send(twiml.toString());
});

// Holding response while transcription processes
app.post('/voice/reply', (_req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.pause({ length: 12 });
  res.type('text/xml').send(twiml.toString());
});

// Transcription + AI reply → update live call
app.post('/voice/transcribed', async (req, res) => {
  const callSid = req.body.CallSid;
  const text    = req.body.TranscriptionText || '';
  const state   = voiceStates.get(callSid);

  res.status(200).end(); // Twilio doesn't need a response here

  if (!state || !text || !twilioClient) return;
  console.log(`[voice] transcribed callSid=${callSid}: "${text}"`);

  try {
    const reply = await askAgent(state.agentId, state.history, text);
    const wav   = await synthesizeVoice(reply);
    const url   = storeAudio(wav);

    // Replace the paused call with the AI reply + next gather
    await twilioClient.calls(callSid).update({
      twiml: `<Response>
  <Play>${url}</Play>
  <Gather input="speech" action="/voice/continue/${callSid}" method="POST" timeout="6" speechTimeout="auto">
    <Say voice="alice">Anything else?</Say>
  </Gather>
  <Say voice="alice">Alright, goodbye!</Say>
  <Hangup/>
</Response>`,
    });
  } catch (err) {
    console.error('[voice] transcribed handler error:', err.message);
    try {
      await twilioClient.calls(callSid).update({
        twiml: '<Response><Say voice="alice">Sorry, something went wrong. Goodbye!</Say><Hangup/></Response>',
      });
    } catch {}
  }
});

// Continued conversation turns
app.post('/voice/continue/:callSid', async (req, res) => {
  const twiml   = new twilio.twiml.VoiceResponse();
  const callSid = req.params.callSid;
  const speech  = req.body.SpeechResult || '';
  const state   = voiceStates.get(callSid);

  if (!speech || !state) {
    twiml.say({ voice: 'alice' }, 'Alright, goodbye!');
    twiml.hangup();
    voiceStates.delete(callSid);
    return res.type('text/xml').send(twiml.toString());
  }

  console.log(`[voice] continue callSid=${callSid}: "${speech}"`);

  try {
    const reply = await askAgent(state.agentId, state.history, speech);
    const wav   = await synthesizeVoice(reply);
    const url   = storeAudio(wav);

    twiml.play(url);
    const g = twiml.gather({
      input: 'speech',
      action: `/voice/continue/${callSid}`,
      method: 'POST',
      timeout: 6,
      speechTimeout: 'auto',
    });
    g.say({ voice: 'alice' }, 'Anything else?');
    twiml.say({ voice: 'alice' }, 'Alright, goodbye!');
    twiml.hangup();
  } catch (err) {
    console.error('[voice] continue error:', err.message);
    twiml.say({ voice: 'alice' }, 'Sorry, something went wrong. Goodbye!');
    twiml.hangup();
  }

  res.type('text/xml').send(twiml.toString());
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`[bridge] Port ${port} | Public: ${PUBLIC_URL}`);
  console.log(`[bridge] Default agent: ${DEFAULT_AGENT}`);
  if (!twilioClient) console.warn('[bridge] Twilio not configured yet — set env vars');
});
