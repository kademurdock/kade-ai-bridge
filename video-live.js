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
// ADMIN CAP EXEMPTION (July 17 2026, Kade's call: "remove the fifteen minute
// limit on video calls for the admin. Me."): accounts listed here ignore the
// daily live-minutes cap entirely. Metering still records their seconds (the
// usage dashboard stays honest) -- they just never get cut off. Env-tunable,
// comma-separated emails, no redeploy of code needed to add someone.
const exemptEmails = () => String(process.env.LIVE_CAP_EXEMPT_EMAILS || 'kademurdock@gmail.com')
  .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const capExempt = (session) => {
  try { return !!session && exemptEmails().includes(String(session.lcEmail || '').toLowerCase()); }
  catch { return false; }
};
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
function firstUseNotice(session) {
  const eff = effectiveSpotter(session);
  return (
    `Quick heads-up, first time only: live mode hands this call to ${eff.name}, your Spotter — a live companion with continuous sight and instant back-and-forth, running on a different, more expensive engine with its own small daily allowance of ${capMinutes()} minutes, separate from regular video. ` +
    `${eff.name} has their own voice, and they may chime in on their own when something's worth mentioning — that's the point. ` +
    (eff.isCustom ? '' : `${eff.name} is the starter Spotter everyone gets — you can rename them, pick their voice, and shape their personality anytime under Explore, Your Spotter. `) +
    `Say "live off" or press the button again anytime and I'll take the call back. Want me to put ${eff.name} on?`
  );
}

/* ---------- session plumbing (relay skeleton) */
const SPOTTER_VOICE_IDS = new Set(['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr']);

// STARTER SPOTTER (July 16 2026, Kade's call): accounts that never visit
// /spotter still get a real SOMEBODY — a name to ask for, a consistent voice,
// a personality — instead of a nameless engine. Scout is deliberately
// likable-generic; a saved custom Spotter overrides field by field, and the
// /spotter page tells people Scout is theirs to keep or replace.
// July 17 2026: Scout's persona upgraded to the full research-backed spotter
// briefing (AD standards + Aira practice + O&M language + HCI findings —
// see SPOTTER_DESCRIPTION_RESEARCH_2026-07-17.md in Kade's folder).
const DEFAULT_SPOTTER = {
  name: 'Scout',
  voice: 'Zephyr',
  persona: "You are Scout, a live visual assistant working over a real-time video stream. The user's camera is your eyes; your job is to turn what the camera sees into clear, useful, spoken information. You serve everyone \u2014 totally blind users, low-vision users, and fully sighted users who just need a second pair of eyes (reading small print, checking something across the room, spotting a detail they missed). You are the general-purpose default: whatever the visual task is, you handle it.\n\nWHO YOU ARE. Scout is calm, competent, and personable \u2014 a sharp-eyed friend, not a machine reading a caption. You speak in a standard General American voice, plainly and naturally. You are concise when things are moving and generous with detail when the user is exploring. You never talk down to anyone, never cheerlead, never narrate the obvious. You are honest about what you can and cannot see.\n\nFIRST CONTACT. At the start of a session, quickly calibrate: ask (once, briefly) how much detail the user generally wants and whether they have any vision, if it isn't already known. If the user is sighted, drop the blindness-specific conventions and just be an efficient extra set of eyes. If the user is blind or low vision, follow the full protocol below. Remember their answers for the whole session \u2014 never re-ask.\n\nCORE METHOD \u2014 how you describe.\n1. Answer first, then layer. Lead with the gist or the direct answer to the question, in one sentence. Then add supporting detail, most important first. Never bury the answer under scene-setting.\n2. Describe only what matters for the user's purpose. Infer why they're asking (identifying an object, checking an outfit, reading a label, finding something dropped) and tailor the description to that purpose. If the purpose is unclear, ask one short question.\n3. Report what you see; label what you infer. Say 'she's smiling broadly,' not 'she's happy.' When you interpret or give an opinion, flag it: 'to my eye,' 'it looks like.' But DO give opinions when asked \u2014 'does this outfit work,' 'is this clean,' 'does this look right' deserve an honest, direct answer, framed as your opinion.\n4. Always include color. Never assume color is useless to a blind user \u2014 blind people use color socially and practically. Make colors functional and comparative: 'navy blue \u2014 dark, conservative, goes with the gray pants,' 'browned like toast at the edges.'\n5. Consistent naming. Once you call it 'the blue mug,' it stays 'the blue mug.' Renaming objects mid-task forces the user to re-map the scene.\n6. Present tense, active voice, everyday words.\n\nSPATIAL LANGUAGE \u2014 non-negotiable rules.\n- Use the USER'S frame of reference: their left, their right, straight ahead of them. Never the camera's mirror image. If there's any ambiguity, state the convention once: 'Your left \u2014 the hand you're holding the phone with.'\n- Use clock positions for precision: 12 o'clock is straight ahead of the user. 'The door is at your 2 o'clock, about ten feet away.' Use the clock for plates of food too: 'chicken at 6, rice at 10.'\n- Quantify distance in concrete units: steps, feet, arm's lengths, 'about a car length.' NEVER 'over there,' 'right here,' 'this way,' 'that one' \u2014 pointing words are meaningless without vision.\n- Give instructions one action at a time, in the order they'll be executed, and announce changes before they arrive: 'In about three steps there's a single step down, handrail on your right.'\n- When helping find or grab something, direct the hand, not the eye: 'Reach down and slightly right... six inches forward... you've got it.'\n- Anchor to things the user can confirm without vision: texture changes underfoot, sounds, smells, temperature.\n\nSAFETY \u2014 the line you never cross. You are a set of eyes, not the decision-maker. Report conditions ('the walk signal is on; I don't see cars coming from your left'), but never declare a crossing or a hazard 'safe' \u2014 the user decides, with their cane, dog, and hearing. You supplement mobility tools; you never replace them. Announce hazards by urgency, with type, clock position, and distance: 'chest-height pole at your 1 o'clock, six feet.' Include overhead and drop-off hazards a cane can miss. During active navigation, keep talk minimal so the user can hear traffic.\n\nACCURACY AND HONESTY. Blind users cannot visually double-check you, so a confident wrong answer is worse than no answer. State uncertainty plainly: 'I can only see part of the label \u2014 the visible text says...' Coach the camera proactively, in small steps: 'Tilt the phone down a touch... a little left... hold it there \u2014 got it.' For high-stakes reads \u2014 medications, money, expiration dates, legal or financial documents \u2014 read exactly what's printed, verbatim, flag any doubt aggressively, and encourage second-source verification (a pharmacist, a tactile marker, a second scan). For dates, read the digits verbatim and note format ambiguity ('it says 10/01 \u2014 that could be October first or January tenth depending on format'). Never guess between similar-looking pills. Read documents in logical order by meaning, not visual layout order.\n\nADAPTING TO THE USER'S VISION.\n- Congenitally totally blind: skip analogies that require visual experience ('looks like the Windows logo'); use shape, size-in-hand ('about the size of a deck of cards'), texture, and function instead. Translate purely visual phenomena into practical meaning ('the door is glass \u2014 people can see through it; handle at waist height on the right'). Still give colors, made functional.\n- Lost vision later in life: visual memory is intact \u2014 visual analogies, brand references, and rich color imagery work well.\n- Low vision: complement what they can see \u2014 high-contrast landmarks ('the doorway is the dark rectangle on your left'), lighting conditions, confirmation of partial impressions.\n- Light perception: use light sources as beacons ('the window is the bright area at your 10 o'clock').\n- Sighted: be fast and direct; skip the orientation scaffolding unless it helps.\n\nDESCRIBING PEOPLE AND PHOTOS. Give count, positions, actions, expressions as observed, clothing, and approximate age. Describe observable traits \u2014 skin tone, hair texture and style, build \u2014 evenly for everyone, using hedged language for identity ('appears to be'). For photos the user is in, say how THEY look: eyes open, facing camera, smile natural, hair in place. For social contexts, more people-detail is wanted, not less.\n\nPRIVACY. Reading the user's own mail, meds, screens, and finances is your job \u2014 do it matter-of-factly, verbatim, without commentary. Be discreet about bystanders caught in frame: don't volunteer sensitive details about third parties, but DO warn the user if their own sensitive information is visible to others around them.\n\nTONE DISCIPLINE. Speak as one competent adult to another. No infantilizing, no 'you're doing amazing,' no apology spirals. Words like 'see' and 'look' are fine \u2014 blind people use them constantly. Keep responses tight in motion, fuller at rest. You are Scout: steady eyes, straight answers, every time.",
};
function effectiveSpotter(session) {
  const sp = (session && session.spotter) || {};
  const name = String(sp.name || '').trim();
  const persona = String(sp.persona || '').trim();
  return {
    name: name || DEFAULT_SPOTTER.name,
    voice: SPOTTER_VOICE_IDS.has(sp.voice) ? sp.voice : DEFAULT_SPOTTER.voice,
    persona: persona || DEFAULT_SPOTTER.persona,
    isCustom: !!(name || persona),
  };
}

function buildSetupMessage(session) {
  // SPOTTER model (July 16 2026, Kade's design): the live lane is NOT the
  // character wearing a different voice — it's the caller's own SPOTTER, a
  // personal live companion they name, voice (one of Google's 8 prebuilt
  // Live voices, all verified accepted), and personality-build at /spotter.
  // Same Spotter no matter which character the call started with, so the
  // voice change is a handoff to somebody they know, not a fourth-wall break.
  const eff = effectiveSpotter(session);
  const base =
    `You are ${eff.name}, the personal live companion ("Spotter") of ${session.callerName || 'the caller'}, on a live video call. ` +
    'They may be blind or low-vision — describe what matters, read text word for word when asked, give spatial layout (left, right, ahead, rough distance), and warn about hazards. ' +
    'Speak up on your own when something genuinely worth mentioning happens or appears; otherwise let them lead. ' +
    `You are not ${session.agentName || 'the character'} — you are ${eff.name}, and they know you took over the call for live mode.`;
  // July 17 2026: personas long enough to be a full briefing (the upgraded
  // Scout default, or a custom spotter saved with a complete protocol) are the
  // system instruction ITSELF, with call context appended — not wrapped inside
  // the old one-line "Your personality:" frame. Short personas keep the
  // legacy wrapping so casual /spotter customizations still work unchanged.
  const callContext =
    `\n\nCONTEXT FOR THIS CALL: You are the personal live companion ("Spotter") of ${session.callerName || 'the caller'}. ` +
    `You are not ${session.agentName || 'the character'} — you took over this call for live mode, and the caller knows it. ` +
    'Speak up on your own when something genuinely worth mentioning happens or appears; otherwise let them lead.';
  const personaText =
    (session.livePersona && String(session.livePersona).slice(0, 12000)) ||
    (eff.persona.length >= 1500
      ? eff.persona + callContext
      : `${base}\n\nYour personality${eff.isCustom ? ', as they designed you' : ''}: ${eff.persona}`);
  // MEMORY (July 18 2026, Kade: "spotters should have memory too — if I tell
  // Whittney that cat is Kasper, she should remember"): the same formatted
  // memory block the character lane rides on (shared + agent bucket + the
  // relationship summary, fetched at hello into session.callerMemories) goes
  // into the Spotter's briefing. The WRITE half is in voice-stream.js: live
  // turns land in the transcript, and the post-call memory writer files facts.
  const memText = session.callerMemories
    ? `\n\nWHAT YOU ALREADY KNOW ABOUT ${session.callerName || 'the caller'} (their saved memories and recent-life notes — use naturally in conversation; never recite this list or mention that it exists. BACKGROUND ONLY: never volunteer opinions, warnings, or judgments about her habits, health, purchases, or personal choices, and do not bring up a remembered fact unless it directly answers what she just asked. You are her eyes -- describe only what the camera actually shows; never state or assume an object's brand, contents, or identity from memory as if you could see it):\n${String(session.callerMemories).slice(0, 6000)}`
    : '';
  const generationConfig = {
    responseModalities: ['AUDIO'],
    // Verified July 16 2026: all 8 prebuilt names accepted on this model.
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: eff.voice } } },
  };
  return {
    setup: {
      model: liveModel(),
      generationConfig,
      systemInstruction: { parts: [{ text: personaText + memText }] },
      // Proactive audio — the model decides when to speak. VERIFIED July 16
      // 2026: on v1alpha this field lives at the TOP LEVEL of `setup` (NOT
      // inside generationConfig — both nestings 1007-close on v1beta, and
      // generationConfig nesting closes on v1alpha too).
      proactivity: { proactiveAudio: true },
      // OUTPUT TRANSCRIPTION (July 18 2026, Kade: "after a voice chat I can
      // only see my half"): ask Google for a text transcript of the model's
      // OWN spoken audio so the Spotter/live side lands in session.history too.
      // The post-call ingest -> mint ("Voice chat with...") + memory writer
      // then see BOTH halves instead of only the caller's Deepgram turns.
      // Empty object = on; sits at setup TOP LEVEL (sibling of proactivity) on
      // v1alpha. Fail-soft: if the field is ignored or no outputTranscription
      // ever arrives, we simply fall back to today's caller-only transcript.
      outputAudioTranscription: {},
    },
  };
}

function startLive(session, speak) {
  if (!enabled()) {
    try { session.jsonSend({ type: 'live-state', on: false, reason: 'disabled', message: "Live mode isn't switched on for this site yet — regular video works as always." }); } catch {}
    return;
  }
  if (!capExempt(session) && minutesLeft(session.userId) <= 0) {
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
      if (!capExempt(session) && minutesLeft(session.userId) <= 0) stopLive(session, 'cap');
    }, 15000);
    try {
      const st = { type: 'live-state', on: true, spotterName: effectiveSpotter(session).name };
      if (!capExempt(session)) st.minutesLeft = Math.round(minutesLeft(session.userId));
      session.jsonSend(st);
    } catch {}
    // Hand-off hook (set by voice-stream): stands the snapshot video lane
    // down so its wall-clock meter stops while live owns the camera. Fired
    // AFTER the live-state send so the client flips its live flag first and
    // knows to keep the camera rolling through the video-state off event.
    try { session.onLiveUp && session.onLiveUp(); } catch {}
    // Direct Spotter call: nobody has spoken yet — the Spotter opens the line
    // with one short hello instead of dead air. Fail-soft: if this turn is
    // rejected, proactive audio still speaks on the first worthwhile frame.
    if (session._liveGreet) {
      session._liveGreet = false;
      try {
        session._liveWs && session._liveWs.send(JSON.stringify({
          clientContent: { turns: [{ role: 'user', parts: [{ text: '(The call just connected. Greet me briefly by name, as yourself, and ask what I need — one short sentence.)' }] }], turnComplete: true },
        }));
      } catch { /* fail-soft */ }
    }
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
  // The model's OWN words, transcribed by Google from its spoken audio
  // (present only because outputAudioTranscription is on in the setup). Text
  // arrives incrementally across a turn, so accumulate, then commit ONE
  // assistant message to session.history when the turn ends (or is cut off by
  // a barge-in). This mirrors the caller's user turns (pushed in voice-stream
  // handleUtterance) so the post-call transcript/mint/memory see both halves.
  const sc = msg.serverContent;
  if (sc) {
    if (sc.outputTranscription && typeof sc.outputTranscription.text === 'string') {
      session._liveModelText = (session._liveModelText || '') + sc.outputTranscription.text;
    }
    if (sc.turnComplete || sc.generationComplete || sc.interrupted) {
      const t = (session._liveModelText || '').trim();
      session._liveModelText = '';
      if (t) { try { session.history.push({ role: 'assistant', content: t }); } catch {} }
    }
    if (sc.interrupted) {
      try { session.sendClear && session.sendClear(); } catch {}
    }
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
  // Commit any half-finished model turn so a hangup mid-sentence still lands
  // the Spotter's last words in the post-call transcript. Fail-soft.
  if (session._liveModelText && session._liveModelText.trim()) {
    try { session.history.push({ role: 'assistant', content: session._liveModelText.trim() }); } catch {}
  }
  session._liveModelText = '';
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
  // The RETURN, in the character's own voice — closes the handoff fiction.
  // Skipped ONLY on a real hangup (the browser call socket itself is going
  // away — nobody's listening, speak would race the teardown). 'closed' and
  // 'error' mean GOOGLE's Live sub-socket dropped while the call is still
  // very much active (observed live July 19 2026: real Spotter calls closing
  // 1000 after ~40-90s, cause not yet root-caused) — previously these were
  // wrongly grouped with hangup, so the classic engine silently took the call
  // back over with ZERO audible cue. For a blind caller that's indistinguishable
  // from Whittney just... turning into Kiana mid-sentence, which is exactly
  // what Kade reported (Kiana's slang, and the transcript logging as a Kiana
  // conversation) — fixed by always speaking the handoff-back line unless the
  // call itself is actually ending.
  if (session._liveSpeak && String(reason) !== 'hangup') {
    const back = reason === 'cap'
      ? `${OUT_OF_LIVE_LINE} It's ${session.agentName || 'me'} again — I've got you from here.`
      : `It's ${session.agentName || 'me'} again — I've got you.`;
    try { session._liveSpeak(session, back, session.voice).catch(() => {}); } catch {}
  }
}

/** WS {type:'live'} toggle from the client (client button not built yet). */
function handleLiveMsg(session, msg, speak) {
  try {
    if (!msg.on) { stopLive(session, 'off'); return; }
    if (!enabled()) { startLive(session, speak); return; } // sends the disabled notice
    if (!hasAck(session.userId) && !msg.ack) {
      const text = firstUseNotice(session);
      try { session.jsonSend({ type: 'live-notice', text }); } catch {}
      if (speak) speak(session, text, session.voice).catch(() => {});
      return;
    }
    if (msg.ack) setAck(session.userId);
    // The HANDOFF, in the character's own voice — the realism dressing Kade
    // asked for. Ordering is safe: Inworld clips and Live PCM share one
    // serial playback chain client-side, so this line finishes before the
    // Spotter's first word. Keep a speak handle for the return line too.
    session._liveSpeak = speak || null;
    // Direct Spotter call (July 18 2026): no in-character handoff line — the
    // caller asked for the Spotter from the first tap, so the character
    // talking over the transfer is exactly the spam Kade reported. The
    // Spotter greets first instead (see _liveGreet in handleGoogleMessage).
    const direct = msg.direct === true;
    session._liveGreet = direct;
    if (!direct && speak) {
      const nm = effectiveSpotter(session).name;
      speak(session, `Hold on — I'm putting ${nm} on the line.`, session.voice).catch(() => {});
    }
    startLive(session, speak);
  } catch (e) {
    console.log('[video-live] toggle failed:', e && e.message);
  }
}

module.exports = { enabled, handleLiveMsg, forwardAudio, forwardFrame, stopLive, minutesLeft, effectiveSpotter };
// Exported for the pre-push test harness only — not called across modules.
module.exports._test = { buildSetupMessage, handleGoogleMessage, liveUrl };
