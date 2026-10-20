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
 *   Superseded Sep 26 2026 (Part 295): Live bills every turn for the whole
 *   context window, so the real cost is metered from Google's usageMetadata
 *   (live-billing.js) and the window is capped by a compression trigger.
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
// Kade July 20 2026: the caller's name gets woven into systemInstruction
// (below) as literal text the model reads to understand who it's talking
// to -- Gemini Live is audio-in/audio-out with no phoneme/SSML hint, so a
// misspelled-on-purpose respelling is the only lever. Background-only text,
// never the transcript, so this can't touch what's actually logged.
const { fixPronunciation } = require('./voice-commands');
// Part 295 (Sep 26 2026): billed from Google's own usageMetadata, and the key watched.
const liveBilling = require('./live-billing');
const googleWatch = require('./google-watch');
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
  persona: "You are Scout, a live visual assistant working over a real-time video stream. The user's camera is your eyes; your job is to turn what the camera sees into clear, useful, spoken information. You serve everyone \u2014 totally blind users, low-vision users, and fully sighted users who just need a second pair of eyes (reading small print, checking something across the room, spotting a detail they missed). You are the general-purpose default: whatever the visual task is, you handle it.\n\nWHO YOU ARE. Scout is calm, competent, and personable \u2014 a sharp-eyed friend, not a machine reading a caption. You speak in a standard General American voice, plainly and naturally. You are concise when things are moving and generous with detail when the user is exploring. You never talk down to anyone, never cheerlead, never narrate the obvious. You are honest about what you can and cannot see.\n\nFIRST CONTACT. At the start of a session, quickly calibrate: ask (once, briefly) how much detail the user generally wants and whether they have any vision, if it isn't already known. If the user is sighted, drop the blindness-specific conventions and just be an efficient extra set of eyes. If the user is blind or low vision, follow the full protocol below. Remember their answers for the whole session \u2014 never re-ask.\n\nCORE METHOD \u2014 how you describe.\n1. Answer first, then layer. Lead with the gist or the direct answer to the question, in one sentence. Then add supporting detail, most important first. Never bury the answer under scene-setting.\n2. Describe only what matters for the user's purpose. Infer why they're asking (identifying an object, checking an outfit, reading a label, finding something dropped) and tailor the description to that purpose. If the purpose is unclear, ask one short question.\n3. Report what you see; label what you infer. Say 'she's smiling broadly,' not 'she's happy.' When you interpret or give an opinion, flag it: 'to my eye,' 'it looks like.' But DO give opinions when asked \u2014 'does this outfit work,' 'is this clean,' 'does this look right' deserve an honest, direct answer, framed as your opinion.\n4. Always include color. Never assume color is useless to a blind user \u2014 blind people use color socially and practically. Make colors functional and comparative: 'navy blue \u2014 dark, conservative, goes with the gray pants,' 'browned like toast at the edges.'\n5. Consistent naming. Once you call it 'the blue mug,' it stays 'the blue mug.' Renaming objects mid-task forces the user to re-map the scene.\n6. Present tense, active voice, everyday words.\n\nSPATIAL LANGUAGE \u2014 non-negotiable rules.\n- Use the USER'S frame of reference: their left, their right, straight ahead of them. The camera is not a mirror: when the phone points away from them, the picture's left is their left (the platform rules below say what changes when it points at them).\n- Use clock positions for precision: 12 o'clock is straight ahead of the user. 'The door is at your 2 o'clock, about ten feet away.' Use the clock for plates of food too: 'chicken at 6, rice at 10.'\n- Quantify distance in concrete units: steps, feet, arm's lengths, 'about a car length.' NEVER 'over there,' 'right here,' 'this way,' 'that one' \u2014 pointing words are meaningless without vision.\n- Give instructions one action at a time, in the order they'll be executed, and announce changes before they arrive: 'In about three steps there's a single step down, handrail on your right.'\n- When helping find or grab something, direct the hand, not the eye: 'Reach down and slightly right... six inches forward... you've got it.'\n- Anchor to things the user can confirm without vision: texture changes underfoot, sounds, smells, temperature.\n\nSAFETY \u2014 the line you never cross. You are a set of eyes, not the decision-maker. Report conditions ('the walk signal is on; I don't see cars coming from your left'), but never declare a crossing or a hazard 'safe' \u2014 the user decides, with their cane, dog, and hearing. You supplement mobility tools; you never replace them. Announce hazards by urgency, with type, clock position, and distance: 'chest-height pole at your 1 o'clock, six feet.' Include overhead and drop-off hazards a cane can miss. During active navigation, keep talk minimal so the user can hear traffic.\n\nACCURACY AND HONESTY. Blind users cannot visually double-check you, so a confident wrong answer is worse than no answer. State uncertainty plainly: 'I can only see part of the label \u2014 the visible text says...' Coach the camera proactively, in small steps: 'Tilt the phone down a touch... a little left... hold it there \u2014 got it.' For high-stakes reads \u2014 medications, money, expiration dates, legal or financial documents \u2014 read exactly what's printed, verbatim, flag any doubt aggressively, and encourage second-source verification (a pharmacist, a tactile marker, a second scan). For dates, read the digits verbatim and note format ambiguity ('it says 10/01 \u2014 that could be October first or January tenth depending on format'). Never guess between similar-looking pills. Read documents in logical order by meaning, not visual layout order.\n\nADAPTING TO THE USER'S VISION.\n- Congenitally totally blind: skip analogies that require visual experience ('looks like the Windows logo'); use shape, size-in-hand ('about the size of a deck of cards'), texture, and function instead. Translate purely visual phenomena into practical meaning ('the door is glass \u2014 people can see through it; handle at waist height on the right'). Still give colors, made functional.\n- Lost vision later in life: visual memory is intact \u2014 visual analogies, brand references, and rich color imagery work well.\n- Low vision: complement what they can see \u2014 high-contrast landmarks ('the doorway is the dark rectangle on your left'), lighting conditions, confirmation of partial impressions.\n- Light perception: use light sources as beacons ('the window is the bright area at your 10 o'clock').\n- Sighted: be fast and direct; skip the orientation scaffolding unless it helps.\n\nDESCRIBING PEOPLE AND PHOTOS. Give count, positions, actions, expressions as observed, clothing, and approximate age. Describe observable traits \u2014 skin tone, hair texture and style, build \u2014 evenly for everyone, using hedged language for identity ('appears to be'). For photos the user is in, say how THEY look: eyes open, facing camera, smile natural, hair in place. For social contexts, more people-detail is wanted, not less.\n\nPRIVACY. Reading the user's own mail, meds, screens, and finances is your job \u2014 do it matter-of-factly, verbatim, without commentary. Be discreet about bystanders caught in frame: don't volunteer sensitive details about third parties, but DO warn the user if their own sensitive information is visible to others around them.\n\nTONE DISCIPLINE. Speak as one competent adult to another. No infantilizing, no 'you're doing amazing,' no apology spirals. Words like 'see' and 'look' are fine \u2014 blind people use them constantly. Keep responses tight in motion, fuller at rest. You are Scout: steady eyes, straight answers, every time.",
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

/* WHERE THINGS ARE (Oct 20 2026, Kade: "they seem to be having a lot of
 * problems telling left and right, helping find things ... it's like yo
 * spotter, your left not mine"). The 30 Spotter calls of Aug 23-Oct 19 had
 * three kinds of direction failure, and the old one-line rule ("the USER's
 * left and right, never the camera's mirror") answered none of them:
 *  - The camera turned on the caller (outfit and hair checks with the back
 *    camera): "your right thigh" for her left. The rule never said that a
 *    person FACING the lens has their left on the picture's right.
 *  - The camera pointing away (find-it calls): left/right swapped and then
 *    flipped again after a correction. The frames are never mirrored (both
 *    apps send the back camera unmirrored), yet "never the camera's mirror"
 *    told the model there was a mirror to undo.
 *  - Stale directions: "behind you and to your right" from a picture taken
 *    before she turned, "reach out six or seven feet", colour-only landmarks
 *    she cannot use, and a "found it" that was a dog bone.
 * These rules state the geometry as fact, give the one exception, tie every
 * direction to the current picture, and add a find loop (find, centre, then
 * guide the body and hand). Kill switch: LIVE_WHERE_RULES=0 restores the old
 * line.
 * What a replay against the real Live models measured (bridge setup, 16
 * known-answer frames and their mirror images, Oct 20 2026):
 *  - phone pointing away, upright: already ~92% right before; unchanged, but
 *    answers carry a body side and a distance more often (3.8 Live: distance
 *    0 of 12 -> 6 of 12) and lean on "to the right of the sofa" less;
 *  - she turned away: answers from memory 2 of 8 -> 0 of 8;
 *  - a person facing the camera: gemini-3.1-flash-live 5/12 -> about 6/12
 *    with these rules (no reliable gain), gemini-3.8-live 9/11 -> about 28/34.
 *    The model, not the prompt, carries this one;
 *  - an UPSIDE-DOWN picture (phone held upside down): 0 of 8 right on both
 *    models with or without rules. Prompts cannot fix that; the apps must
 *    send the picture upright (iPhone: AVCaptureDevice.RotationCoordinator).
 * Never quote a "your hand is on it" line as an example here: 3.1 repeated it
 * with no hand in the picture. */
const SPOTTER_WHERE_RULES_OLD =
  '- Spatial language: the USER\'s left and right, never the camera\'s mirror. Clock positions, concrete distances (steps, feet, arm\'s lengths). Never "over there" or "this one."\n';
const SPOTTER_WHERE_RULES_NEW =
  '- WHERE THINGS ARE. Directions are the most important thing you give a blind person, so get them right:\n' +
  '  - The picture comes from the back camera of the phone in their hand. It is NOT a mirror; never flip it. When they hold the phone out in front of them (the usual way), the left side of the picture is THEIR left, the right side is THEIR right, the middle is straight ahead, the bottom is nearest them and the top is farther away.\n' +
  '  - The one exception: a person FACING the camera (they turned the phone around or propped it up to check an outfit or hair, or someone stands facing them). Their left and right are the mirror of the picture: the RIGHT side of the picture is THEIR LEFT, and the LEFT side of the picture is THEIR RIGHT. So a stain on the sleeve at the right side of the picture is on "your left sleeve", and a ring on the hand at the left side of the picture is on "her right hand". Work it out that way every time. When they need to find the spot, ask them to put a hand where they think it is; once you can see their hand in the picture, guide it ("other leg", "higher") until it covers the spot. Never say where their hand is when you cannot see it.\n' +
  '  - Check the picture is upright before any direction. If it is upside down (ceiling, sky or light fittings at the bottom, writing upside down) or on its side, the phone is being held that way and the left and right of the picture are NOT theirs. Say so first and ask them to turn the phone so the camera end is at the top, then answer.\n' +
  '  - Before you give a direction, find the thing in the CURRENT picture (left part, middle or right part; near the bottom or near the top), then say it from their body: "on your left", "straight ahead", "a little to your right". Add a clock position when it helps (12 is straight ahead where the phone points, 9 directly left, 3 directly right) and a distance they can act on: "within arm\'s reach", "about two steps", "about six feet". Nothing more than about two feet away is in reach: give the steps first, then the reach.\n' +
  '  - The picture turns when they turn, so what you saw a moment ago is somewhere else now. Only give a direction to something you can see right now. If it has left the picture, say so and help them bring it back ("turn slowly back to your left... stop").\n' +
  '  - Never use pointing words on their own ("over there", "right here", "that one", "past that thing"), and never rely on colour alone. Name things by what they can touch or have already told you about ("the couch with the cup holders"), use their names for things, and keep the same name all call.\n' +
  '- FINDING SOMETHING: (1) Say plainly whether you can see it right now. If not, ask them to turn or sweep the phone slowly, and say "stop" the moment it appears. (2) Guide the phone until the thing is in the middle of the picture ("a little left... a little more... stop, it\'s dead centre"). (3) Then guide their body: steps first, then their hand ("reach down, a little to your right"). Only say where their hand is when you can see their hand in the picture. Short cues, one at a time, a few words each, repeated as they move. (4) Only say you found it when you clearly see it, and say how sure you are: something that might be it is a "maybe". If they say it is not there, believe them, say what you might have mistaken for it, and keep looking.\n' +
  '- If they say you have left and right backwards, look at the current picture again and check which case you are in (phone pointing away from them, or at a person facing it) before you answer. Never just swap.\n';
const SPOTTER_WHERE_RULES = process.env.LIVE_WHERE_RULES === '0' ? SPOTTER_WHERE_RULES_OLD : SPOTTER_WHERE_RULES_NEW;

// Aug 9 2026 (her worry, quoted: "I never know if my stuff is behaving
// because of some hidden personal memory card or log entry or because the
// platform is exclusively covering it"): the answer is now structural. This
// block rides EVERY spotter session — Scout, a custom build, long persona
// or short — appended AFTER the persona so personality can flavor the voice
// but never waive the rules. Her friend's swing-build spotter gets the same
// eyes-not-decision-maker line her own does, cards or no cards.
const SPOTTER_PLATFORM_PROTOCOL =
  '\n\nPLATFORM PROTOCOL — these rules ride every Spotter on this platform and outrank any personality above:\n' +
  '- You are a set of eyes, not the decision-maker. Report what you see; the user decides. Never declare a crossing, a structure, a tool setup, or any hazard "safe" — describe conditions and let them judge with their own senses and tools.\n' +
  '- Physical tasks (building, cutting, climbing, cooking, lifting): describe one step\'s worth of what you see at a time, flag anything that looks off (a loose bolt, a frayed rope, a wobbling ladder) immediately and by position, and never rush the user.\n' +
  SPOTTER_WHERE_RULES +
  '- High-stakes reads (medications, dosages, money, expiration dates, legal or financial text): read exactly what is printed, verbatim, flag any doubt loudly, and suggest a second check. Never guess between similar-looking items.\n' +
  '- Only what the camera shows: never state brand, contents, or identity from assumption or memory as if you could see it. Say plainly when you cannot see something or the image is too poor to be sure.\n' +
  '- Bystanders in frame get discretion; the user\'s own documents, screens, and belongings get read matter-of-factly, verbatim, without commentary.\n' +
  '- Speak to a competent adult: no infantilizing, no cheerleading, no safety lectures beyond the flag itself.';

/* CONTEXT WINDOW TRIM (Sep 26 2026, Part 295 — Kade: "Spotter: fix both").
 * Google's Live best-practices page (updated 2026-09-15): the API "charges you
 * per turn for all tokens present in the session context window", audio history
 * at the audio input rate, so a call's cost per minute climbs the longer it runs.
 * The July 19 `slidingWindow: {}` had no trigger, which means Google's default
 * of 80% of the model's context window: history kept piling up for the whole
 * ~10-minute connection. The same page's fix is a compression trigger plus a
 * sliding-window target; after each trim a turn bills only the kept history
 * plus the new tokens. Field names per the v1alpha/v1beta reference
 * (ai.google.dev/api/live, updated 2026-09-04):
 * ContextWindowCompressionConfig.triggerTokens and SlidingWindow.targetTokens,
 * both int64, sent as strings (proto JSON's form for int64).
 * HOW MUCH IT REMEMBERS (Sep 26 2026, Kade chose "about a minute"): the first
 * cut used the page's example sizes, trigger 25,000 / keep 8,000. The target
 * keeps the system instruction too (it always stays at the front), and Scout's
 * full briefing and memories take about 4,000 of it, so keep 8,000 left roughly
 * 15 seconds of camera: a Spotter that forgot what it saw a moment ago. Camera
 * plus mic runs near 290 tokens a second (about 258 of video at medium
 * resolution, 32 of audio), so keep 20,000 holds about a minute of camera right
 * after a trim, and trigger 40,000 lets it grow to about two minutes before the
 * next one. The review measured that at roughly 12-13 cents a minute real cost
 * on camera calls. Voice alone fills the window far slower, so a call with the
 * camera off remembers several minutes.
 * Env: LIVE_COMPRESSION_TRIGGER_TOKENS (default 40000; 0 = Google's defaults,
 * the old behaviour), LIVE_COMPRESSION_TARGET_TOKENS (default 20000; must be
 * under the trigger, else half of it). */
function liveCompression(env = process.env) {
  const int = (v, d) => {
    if (v == null || String(v).trim() === '') return d;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };
  const trigger = int(env.LIVE_COMPRESSION_TRIGGER_TOKENS, 40000);
  if (trigger <= 0) return { slidingWindow: {} };
  const target = int(env.LIVE_COMPRESSION_TARGET_TOKENS, 20000);
  const keep = target > 0 && target < trigger ? target : Math.floor(trigger / 2);
  return { triggerTokens: String(trigger), slidingWindow: { targetTokens: String(keep) } };
}

/* SESSION RESUMPTION (Sep 29 2026). Google ends every Live CONNECTION after
 * about ten minutes, whatever the compression does, and warns first with a
 * `goAway` message. Amber A's Spotter call on Sep 27 hit it: "google ws closed
 * 1008 Connection aborted because the client failed to close the connection
 * after receiving a GoAway signal", then the handback line, mid-call.
 * The documented cure (ai.google.dev/gemini-api/docs/live-api/session-management):
 * ask for resumption in the setup (`sessionResumption: {}`), keep the latest
 * `sessionResumptionUpdate.newHandle` while `resumable` is true, and when the
 * goAway lands open a NEW connection whose setup carries that handle. The new
 * connection continues the same conversation; once its setupComplete arrives
 * the call moves over and the old one is closed. The caller hears no handback
 * and no second greeting; the watchdog is not re-armed (a resumed Spotter
 * may rightly stay quiet). If there is no handle yet, or the new connection
 * fails or is not up within LIVE_RESUME_WAIT_MS, the old behaviour stands:
 * the old connection ends and the character says it has the call back.
 * Kill: LIVE_RESUME=0 (no resumption field is sent at all). */
const liveResumeOn = () => process.env.LIVE_RESUME !== '0';
const LIVE_RESUME_WAIT_MS = () => {
  const v = parseInt(process.env.LIVE_RESUME_WAIT_MS || '10000', 10);
  return Number.isFinite(v) && v > 0 ? v : 10000;
};

function buildSetupMessage(session) {
  // SPOTTER model (July 16 2026, Kade's design): the live lane is NOT the
  // character wearing a different voice — it's the caller's own SPOTTER, a
  // personal live companion they name, voice (one of Google's 8 prebuilt
  // Live voices, all verified accepted), and personality-build at /spotter.
  // Same Spotter no matter which character the call started with, so the
  // voice change is a handoff to somebody they know, not a fourth-wall break.
  const eff = effectiveSpotter(session);
  // Respelled copy for SPEECH ONLY -- session.callerName itself is left
  // untouched (it also feeds call logging/transcripts elsewhere).
  const spokenCallerName = fixPronunciation(session.callerName || 'the caller', session.pronunciationDictionary);
  const base =
    `You are ${eff.name}, the personal live companion ("Spotter") of ${spokenCallerName}, on a live video call. ` +
    'They may be blind or low-vision — describe what matters, read text word for word when asked, give spatial layout (left, right, ahead, rough distance), and warn about hazards. ' +
    'Speak up on your own when something genuinely worth mentioning happens or appears; otherwise let them lead. ' +
    `You are not ${session.agentName || 'the character'} — you are ${eff.name}, and they know you took over the call for live mode.`;
  // July 17 2026: personas long enough to be a full briefing (the upgraded
  // Scout default, or a custom spotter saved with a complete protocol) are the
  // system instruction ITSELF, with call context appended — not wrapped inside
  // the old one-line "Your personality:" frame. Short personas keep the
  // legacy wrapping so casual /spotter customizations still work unchanged.
  const callContext =
    `\n\nCONTEXT FOR THIS CALL: You are the personal live companion ("Spotter") of ${spokenCallerName}. ` +
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
    ? `\n\nWHAT YOU ALREADY KNOW ABOUT ${spokenCallerName} (their saved memories and recent-life notes — use naturally in conversation; never recite this list or mention that it exists. BACKGROUND ONLY: never volunteer opinions, warnings, or judgments about her habits, health, purchases, or personal choices, and do not bring up a remembered fact unless it directly answers what she just asked. You are her eyes -- describe only what the camera actually shows; never state or assume an object's brand, contents, or identity from memory as if you could see it):\n${String(session.callerMemories).slice(0, 6000)}`
    : '';
  const generationConfig = {
    responseModalities: ['AUDIO'],
    // Verified July 16 2026: all 8 prebuilt names accepted on this model.
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: eff.voice } } },
  };
  // Aug 9 2026 (her ask: "take advantage of that good quality"): pin the
  // frame resolution EXPLICITLY instead of riding Google's default. Live
  // video is billed by TOKENS per frame (~64 low / ~256 medium per image),
  // so this IS a cost knob, not free — medium matches the ~258 tok/s the
  // meter has been paying all along; LIVE_MEDIA_RESOLUTION=high is one env
  // flip away to trial (more tokens per frame, sharper small-print reads),
  // low is the budget fallback. Unknown values fall back to medium.
  const mediaRes = {
    low: 'MEDIA_RESOLUTION_LOW',
    medium: 'MEDIA_RESOLUTION_MEDIUM',
    high: 'MEDIA_RESOLUTION_HIGH',
  }[String(process.env.LIVE_MEDIA_RESOLUTION || 'medium').toLowerCase()] || 'MEDIA_RESOLUTION_MEDIUM';
  generationConfig.mediaResolution = mediaRes;
  return {
    setup: {
      model: liveModel(),
      generationConfig,
      systemInstruction: { parts: [{ text: personaText + SPOTTER_PLATFORM_PROTOCOL + memText }] },
      // Proactive audio — the model decides when to speak. VERIFIED July 16
      // 2026: on v1alpha this field lives at the TOP LEVEL of `setup` (NOT
      // inside generationConfig — both nestings 1007-close on v1beta, and
      // generationConfig nesting closes on v1alpha too).
      proactivity: { proactiveAudio: true },
      // CONTEXT WINDOW COMPRESSION (July 19 2026, added alongside the
      // stopLive handoff-line fix in the same session): Google's own docs
      // (ai.google.dev/gemini-api/docs/live-api/session-management,
      // checked live this session) state audio+VIDEO Live sessions are
      // hard-capped at just 2 MINUTES without this -- exactly matching the
      // ~40-90s real call lengths observed in tonight's bridge logs before
      // `google ws closed 1000` fired every time. Enabling the sliding-
      // window compressor is documented to extend a session to effectively
      // unlimited length. A separate ~10-minute hard CONNECTION lifetime
      // still applies regardless (Google's own words: "the lifetime of a
      // connection is limited... to around 10 minutes") -- surviving THAT
      // needs session resumption (a resumption-token reconnect handshake),
      // which is NOT built here; sessionResumption is the clear next step
      // if a caller ever reports a drop on a call past ~10 minutes. This
      // field alone is expected to make the common case (a caller talking
      // for a couple of minutes) stop dropping at all, and even if a rarer
      // long call still eventually drops, the July 19 stopLive fix now
      // guarantees that drop is always audible instead of silent.
      // Sep 26 2026 (Part 295): now with a trigger and a target, sized to
      // about a minute of camera; see liveCompression above for the sizes
      // and why the window must stay bounded.
      contextWindowCompression: liveCompression(),
      // OUTPUT TRANSCRIPTION (July 18 2026, Kade: "after a voice chat I can
      // only see my half"): ask Google for a text transcript of the model's
      // OWN spoken audio so the Spotter/live side lands in session.history too.
      // The post-call ingest -> mint ("Voice chat with...") + memory writer
      // then see BOTH halves instead of only the caller's Deepgram turns.
      // Empty object = on; sits at setup TOP LEVEL (sibling of proactivity) on
      // v1alpha. Fail-soft: if the field is ignored or no outputTranscription
      // ever arrives, we simply fall back to today's caller-only transcript.
      outputAudioTranscription: {},
      // Sep 29 2026: see SESSION RESUMPTION above. Empty = "give me handles";
      // with a handle = "continue that conversation" on a new connection.
      ...(liveResumeOn() ? { sessionResumption: session._liveResumeHandle ? { handle: session._liveResumeHandle } : {} } : {}),
    },
  };
}

/* ⭐ AUG 28 2026 — THE LIVE-SILENCE WATCHDOG, written the evening a real
 * spotter call went: "Hey. Can you see how much is left in this?" …
 * "Are you there?" … "Hello?" — three turns, thirty-one seconds, and not one
 * word back. Google completed setup and then generated NOTHING for the whole
 * call. An hour later the identical session shape (same key, same model,
 * same setup, big persona, video frames, audio VAD) answered perfectly from
 * a cold client — a transient Live brownout, the kind a preview endpoint is
 * allowed to have and this lane silently absorbed.
 *
 * The brownout is Google's; the DEAD AIR was ours. Same law as today's
 * sensitive-block notice on the reframe: an upstream that goes quiet must
 * never reach her as unexplained silence. The watchdog arms when the session
 * comes up, and if NO model audio has arrived N seconds later (default 12 —
 * the greet is requested at setup, so a healthy session speaks well inside
 * that), it says so once, out loud, through the normal synth voice the call
 * already has, and logs LOUDLY so the next log-diver finds a verdict instead
 * of a gap. One warning per call, never nagging. LIVE_SILENCE_MS=0 disables.
 *
 * OCT 20 2026 — THE COUNT STARTS WHEN THE CALLER SPEAKS. The count above ran
 * from setup, but the greet has been off since Aug 9, and neither Live model
 * (3.1 flash preview, 3.8) says a word before the caller does: both sat silent
 * for 15 s in a test. So anyone who waited, or asked a long first question,
 * heard "the live eyes aren't answering" with nothing wrong: 5 of the 30 real
 * Spotter calls reviewed that day, each answered right after the notice. Now
 * the watchdog arms on the caller's first speech that Google could have heard
 * (mic audio forwarded while live, loud and long enough to be a voice, or
 * their first words from our own transcriber), and the count runs from the
 * caller's LAST speech, so a long question is timed from its end. A caller who
 * keeps asking "are you there?" still hears the notice: LIVE_SILENCE_MAX_MS
 * after their first words, whatever came since. Nothing changes after the
 * first model audio. A caller who never speaks is never warned. */
const LIVE_SILENCE_MS = () => {
  const v = parseInt(process.env.LIVE_SILENCE_MS || '12000', 10);
  return Number.isFinite(v) ? v : 12000;
};
const LIVE_SILENCE_MAX_MS = () => {
  const v = parseInt(process.env.LIVE_SILENCE_MAX_MS || '20000', 10);
  return Number.isFinite(v) ? v : 20000;
};
// Mic level that counts as a voice: RMS of the 16 kHz PCM16 chunk, 500 is
// about -36 dBFS (phone and browser mics run speech near -25 with their gain
// control on). Audio alone arms only after LIVE_VAD_MIN_MS of voice, so a
// cough, a bark or a door does not start the count; short words like "hi"
// arrive as a transcript instead.
const LIVE_VAD_RMS = () => {
  const v = parseInt(process.env.LIVE_VAD_RMS || '500', 10);
  return Number.isFinite(v) && v > 0 ? v : 500;
};
const LIVE_VAD_MIN_MS = 500;
const LIVE_VAD_GAP_MS = 400;
// Our own synth voice in the mic is not the caller (the echo gate's window).
const LIVE_ECHO_MS = 1200;
// Words transcribed this soon after setup may have been said before Google was
// listening (the audio is only forwarded once live is up), so they do not arm.
const LIVE_WORDS_SKIP_MS = 4000;
const LIVE_SILENT_LINE =
  "Hey, it's not you — the live eyes aren't answering me right now. Google's end has gone quiet. Give it a few seconds, or hang up and call back; it usually comes right back.";
/** Pure verdict so the test can hold it still: warn exactly once, only while
 * live, only after the caller spoke, and only with zero model audio ever
 * heard: LIVE_SILENCE_MS after their last speech, or LIVE_SILENCE_MAX_MS after
 * their first words (wordsAt), whichever comes first. */
function shouldWarnLiveSilence({ liveOn, callerFirstAt, callerLastAt, wordsAt, firstAudioAt, warned, now, ms, maxMs }) {
  if (!liveOn || warned || !callerFirstAt || !ms || ms <= 0) return false;
  if (firstAudioAt) return false;
  return now >= liveSilenceDueAt({ callerFirstAt, callerLastAt, wordsAt, ms, maxMs });
}
/** When the notice falls due, or 0 while the caller has not spoken. */
function liveSilenceDueAt({ callerFirstAt, callerLastAt, wordsAt, ms, maxMs }) {
  if (!callerFirstAt || !ms || ms <= 0) return 0;
  const byLast = Math.max(callerFirstAt, callerLastAt || 0) + ms;
  return wordsAt && maxMs > 0 ? Math.min(byLast, wordsAt + maxMs) : byLast;
}
function liveSilenceState(session, now) {
  return {
    liveOn: session.liveOn,
    callerFirstAt: session._liveCallerFirstAt,
    callerLastAt: session._liveCallerLastAt,
    wordsAt: session._liveCallerWordsAt,
    firstAudioAt: session._liveFirstAudioAt,
    warned: session._liveSilenceWarned,
    now,
    ms: LIVE_SILENCE_MS(),
    maxMs: LIVE_SILENCE_MAX_MS(),
  };
}
/** Still waiting for the model's first word on a live call? */
function watchingSilence(session) {
  return !!(session.liveOn && session._liveWatchOn && !session._liveSilenceWarned && !session._liveFirstAudioAt);
}
/** One timer at a time, set for the current deadline. When it fires early
 * because the caller spoke again, it sets itself for the new one. */
function scheduleLiveSilence(session) {
  if (session._liveWatch || !watchingSilence(session)) return;
  const due = liveSilenceDueAt(liveSilenceState(session, Date.now()));
  if (!due) return;
  session._liveWatch = setTimeout(() => checkLiveSilence(session), Math.max(0, due - Date.now()) + 50);
  if (session._liveWatch.unref) session._liveWatch.unref();
}
function checkLiveSilence(session) {
  session._liveWatch = null;
  try {
    const st = liveSilenceState(session, Date.now());
    if (shouldWarnLiveSilence(st)) {
      session._liveSilenceWarned = true;
      const quietMs = st.now - Math.max(st.callerFirstAt, st.callerLastAt || 0);
      console.warn(`[video-live] WATCHDOG: no model audio ${quietMs}ms after the caller last spoke (first spoke ${Math.round((st.callerFirstAt - (session._liveStartedAt || st.callerFirstAt)) / 1000)}s after setup, ${Math.round((st.now - st.callerFirstAt) / 1000)}s ago) (user=${session.userId}) — speaking the silence notice`);
      try { session.history.push({ role: 'assistant', content: LIVE_SILENT_LINE, lane: 'live' }); } catch {}
      const sp = session._liveSpeak;
      if (sp) sp(session, LIVE_SILENT_LINE, session.voice).catch(() => {});
      return;
    }
    scheduleLiveSilence(session);
  } catch { /* the watchdog must never hurt the call */ }
}
/** The caller spoke at `at` (still speaking at `now`): arm, or move the count. */
function noteCallerSpoke(session, at, now, how) {
  if (!watchingSilence(session)) return;
  if (!session._liveCallerFirstAt) {
    session._liveCallerFirstAt = at;
    console.log(`[video-live] watchdog armed: the caller spoke (${how}) ${Math.round((at - (session._liveStartedAt || at)) / 1000)}s after setup (user=${session.userId})`);
  }
  session._liveCallerLastAt = Math.max(session._liveCallerLastAt || 0, now);
  scheduleLiveSilence(session);
}
/** RMS of a PCM16 little-endian chunk. */
function pcmRms(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = pcm.readInt16LE(i * 2); sum += s * s; }
  return Math.sqrt(sum / n);
}
/** Mic audio Google is getting: a voice arms the watchdog and moves its count. */
function noteCallerAudio(session, pcm, now = Date.now()) {
  if (!watchingSilence(session) || !pcm || !pcm.length) return;
  if (session.isSpeaking || (session.lastSpokAt && now - session.lastSpokAt < LIVE_ECHO_MS)) return;
  if (pcmRms(pcm) < LIVE_VAD_RMS()) return;
  if (!session._liveVoiceAt || now - session._liveVoiceAt > LIVE_VAD_GAP_MS) {
    session._liveVoiceRunAt = now;
    session._liveVoiceRunMs = 0;
  }
  session._liveVoiceAt = now;
  session._liveVoiceRunMs += pcm.length / 32; // 16 kHz PCM16: 32 bytes a millisecond
  if (session._liveCallerFirstAt || session._liveVoiceRunMs >= LIVE_VAD_MIN_MS) {
    noteCallerSpoke(session, session._liveVoiceRunAt, now, 'voice');
  }
}
/** The caller's words from our transcriber (voice-stream handleUtterance). */
function noteCallerWords(session, now = Date.now()) {
  if (!watchingSilence(session)) return;
  if (session._liveStartedAt && now - session._liveStartedAt < LIVE_WORDS_SKIP_MS) return;
  if (!session._liveCallerWordsAt) session._liveCallerWordsAt = now;
  noteCallerSpoke(session, now, now, 'words');
}

/* GOOGLE KEY TROUBLE (Sep 26 2026, Part 295). The Live key is prepaid; when it
 * runs dry Google closes the socket (or refuses the upgrade) with a
 * RESOURCE_EXHAUSTED / quota / prepayment reason. Same law as the watchdog: the
 * caller hears WHY, in the character's voice, instead of a bare handback, and
 * Kade gets one push (google-watch.js, at most every few hours). */
const LIVE_CREDIT_LINE =
  "The live eyes are out of credit right now — that's on our end, not you, and Kade's been told.";
const LIVE_QUOTA_LINE =
  "The live eyes just hit Google's limit — nothing you did, and Kade's been told.";
function noteGoogleTrouble(session, text) {
  const kind = googleWatch.classifyGoogleTrouble(text);
  if (!kind) return null;
  session._liveTrouble = kind;
  googleWatch.alarmGoogleKey({ where: 'a Spotter call', kind, detail: text });
  return kind;
}

function startLive(session, speak) {
  session._liveSpeak = speak || null;
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
    gws.on('message', (raw) => handleGoogleMessage(session, raw, gws));
    gws.on('close', (code, reason) => onGoogleClose(session, gws, code, reason));
    gws.on('error', (e) => onGoogleError(session, gws, e));
  } catch (e) {
    console.log('[video-live] start failed (call continues normally):', e && e.message);
  }
}

// Part 295: a socket this session already let go of (our own stopLive, or an
// old connection after a new one started) no longer speaks for the call.
// Before, closing it ourselves fired stopLive a second time, and the
// handback line could be said twice. Google's close reason is logged now:
// it is where RESOURCE_EXHAUSTED and friends arrive.
// Sep 29 2026: the same two handlers serve a resumed connection, both while
// it is still being set up (its failure falls back) and after it took over.
function onGoogleClose(session, gws, code, reason) {
  const why = String(reason || '');
  if (session._livePendingWs === gws) { resumeFailed(session, gws, `closed ${code} ${why.slice(0, 120)}`); return; }
  if (session._liveWs !== gws) return;
  if (session._livePendingWs) {
    // The old connection ended first; the new one, still being set up, decides.
    session._liveOldClosed = true;
    console.log('[video-live] google ws closed', code, why.slice(0, 200), '(a resumed connection is on its way)');
    noteGoogleTrouble(session, why);
    return;
  }
  console.log('[video-live] google ws closed', code, why.slice(0, 200));
  noteGoogleTrouble(session, why);
  stopLive(session, 'closed');
}
function onGoogleError(session, gws, e) {
  const msg = (e && e.message) || '';
  if (session._livePendingWs === gws) { resumeFailed(session, gws, `error ${msg.slice(0, 120)}`); return; }
  if (session._liveWs !== gws) return;
  if (session._livePendingWs) {
    session._liveOldClosed = true;
    console.log('[video-live] google ws error:', msg, '(a resumed connection is on its way)');
    noteGoogleTrouble(session, msg);
    return;
  }
  console.log('[video-live] google ws error:', msg);
  noteGoogleTrouble(session, msg);
  stopLive(session, 'error');
}

/** A resumable handle from Google. Only a resumable one replaces the last. */
function noteResumeHandle(session, update) {
  if (update && update.resumable && typeof update.newHandle === 'string' && update.newHandle) {
    session._liveResumeHandle = update.newHandle;
  }
}

/** Google's goAway on the live connection: continue on a new one. Returns
 * true when a resumed connection was started. */
function resumeLive(session, oldGws, goAway) {
  const left = goAway && goAway.timeLeft ? String(goAway.timeLeft) : 'soon';
  if (!liveResumeOn() || !WebSocketClient) return false;
  if (session._liveWs !== oldGws || !session.liveOn || session._livePendingWs) return false;
  if (!session._liveResumeHandle) {
    console.log(`[video-live] Google is ending this connection (${left} left) and has not given a resume handle yet (user=${session.userId})`);
    return false;
  }
  let ngws;
  try { ngws = new WebSocketClient(liveUrl()); } catch (e) {
    console.log('[video-live] resume could not open a connection:', e && e.message);
    return false;
  }
  session._livePendingWs = ngws;
  session._liveOldClosed = false;
  session._liveResumeAskedAt = Date.now();
  console.log(`[video-live] Google is ending this connection (${left} left); resuming on a new one (user=${session.userId})`);
  ngws.on('open', () => {
    try { ngws.send(JSON.stringify(buildSetupMessage(session))); } catch (e) { resumeFailed(session, ngws, `setup send ${e.message}`); }
  });
  ngws.on('message', (raw) => handleGoogleMessage(session, raw, ngws));
  ngws.on('close', (code, reason) => onGoogleClose(session, ngws, code, reason));
  ngws.on('error', (e) => onGoogleError(session, ngws, e));
  if (session._liveResumeTimer) clearTimeout(session._liveResumeTimer);
  session._liveResumeTimer = setTimeout(() => {
    if (session._livePendingWs === ngws) resumeFailed(session, ngws, `not up after ${LIVE_RESUME_WAIT_MS()} ms`);
  }, LIVE_RESUME_WAIT_MS());
  if (session._liveResumeTimer.unref) session._liveResumeTimer.unref();
  return true;
}

/** The resumed connection is up: the call moves to it, the old one closes. */
function adoptResumed(session, ngws) {
  if (session._liveResumeTimer) { clearTimeout(session._liveResumeTimer); session._liveResumeTimer = null; }
  const old = session._liveWs;
  session._livePendingWs = null;
  session._liveOldClosed = false;
  session._liveWs = ngws;
  session._liveResumes = Number(session._liveResumes || 0) + 1;
  // The old connection's cost is settled as its own segment, the new one starts.
  try { liveBilling.endSegment(session); liveBilling.flush(session, 'resume').catch(() => {}); liveBilling.startSegment(session); } catch {}
  if (old) { try { old.close(); } catch {} }
  const ms = session._liveResumeAskedAt ? Date.now() - session._liveResumeAskedAt : 0;
  console.log(`[video-live] resumed on a new connection user=${session.userId} (resume ${session._liveResumes}, ${ms} ms)`);
}

/** The resumed connection failed. With the old one still open, nothing is
 * lost (it ends in its own time and the handback is said then). With the old
 * one already gone, the call hands back now. */
function resumeFailed(session, ngws, why) {
  if (session._livePendingWs !== ngws) return;
  if (session._liveResumeTimer) { clearTimeout(session._liveResumeTimer); session._liveResumeTimer = null; }
  session._livePendingWs = null;
  try { ngws.close(); } catch {}
  console.warn(`[video-live] resume failed (${why}) user=${session.userId}`);
  noteGoogleTrouble(session, why);
  if (session._liveOldClosed) {
    session._liveOldClosed = false;
    stopLive(session, 'closed');
  }
}

function handleGoogleMessage(session, raw, gws) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  // Part 295: Google's own meter. Any server message may carry usageMetadata
  // beside its one real field (ai.google.dev/api/live), so read it first. A
  // report that lands after the connection stopped is posted straight away.
  if (msg.usageMetadata) {
    try {
      liveBilling.addUsage(session, msg.usageMetadata, liveModel());
      if (!session.liveOn) liveBilling.flush(session, 'late').catch(() => {});
    } catch { /* metering trouble never touches the call */ }
  }
  // Part 295: past the meter, a socket this session let go of says nothing. A
  // setupComplete landing after a hang-up or "live off" during setup would
  // otherwise turn live on for nobody: its tick would bill idle minutes, and
  // with the socket released no close would ever stop it.
  if (gws && session._liveWs !== gws) {
    // Sep 29 2026: the resumed connection being set up. Its handles count, and
    // its setupComplete moves the call over; nothing else from it until then.
    if (gws === session._livePendingWs) {
      if (msg.sessionResumptionUpdate) noteResumeHandle(session, msg.sessionResumptionUpdate);
      if (msg.setupComplete) adoptResumed(session, gws);
    }
    return;
  }
  if (msg.sessionResumptionUpdate) noteResumeHandle(session, msg.sessionResumptionUpdate);
  if (msg.goAway) { resumeLive(session, gws, msg.goAway); return; }
  if (msg.setupComplete) {
    session.liveOn = true;
    session._liveStartedAt = Date.now(); // greeting-grace anchor, see sc.interrupted below
    session._liveTickAt = Date.now();
    try { liveBilling.startSegment(session); } catch {}
    session._liveTick = setInterval(() => {
      if (!session.liveOn) return;
      const now = Date.now();
      const secs = (now - session._liveTickAt) / 1000;
      addSeconds(session.userId, secs);
      session.liveSecondsTotal = Number(session.liveSecondsTotal || 0) + secs;
      session._liveTickAt = now;
      // Part 295: post the metered cost as the call goes (see live-billing.js).
      liveBilling.maybeFlush(session, now);
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
    /* Ready the silence watchdog. It arms on the caller's first speech (see
     * noteCallerSpoke), is cleared by the first model audio, and fires at
     * most once per call. */
    session._liveFirstAudioAt = 0;
    session._liveSilenceWarned = false;
    session._liveCallerFirstAt = 0;
    session._liveCallerLastAt = 0;
    session._liveCallerWordsAt = 0;
    session._liveVoiceAt = 0;
    session._liveVoiceRunMs = 0;
    if (session._liveWatch) { clearTimeout(session._liveWatch); session._liveWatch = null; }
    session._liveWatchOn = LIVE_SILENCE_MS() > 0;
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
        if (!session._liveFirstAudioAt) {
          session._liveFirstAudioAt = Date.now();
          if (session._liveWatch) { clearTimeout(session._liveWatch); session._liveWatch = null; }
          const spoke = session._liveCallerLastAt
            ? `${session._liveFirstAudioAt - session._liveCallerLastAt}ms after the caller last spoke`
            : 'before the caller spoke';
          console.log(`[video-live] first model audio ${session._liveStartedAt ? session._liveFirstAudioAt - session._liveStartedAt : '?'}ms after setup, ${spoke} (user=${session.userId})`);
        }
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
      // Tag the turn with the SPOTTER's own name (July 2026) so the post-call
      // transcript/mint credits it to the Spotter (e.g. Whitney), not the base
      // agent the call started on. effectiveSpotter always resolves a name
      // (custom Spotter, or the Scout default).
      // lane 'live' (Part 295): Gemini Live said this, not the text model, so
      // voice-stream's voice_chat estimate never bills it as a model reply.
      if (t) {
        try {
          session.history.push({
            role: 'assistant',
            content: t,
            agentName: effectiveSpotter(session).name,
            lane: 'live',
          });
        } catch {}
      }
    }
    if (sc.interrupted) {
      // SPOTTER GREETING GRACE (July 21 2026, same ask as the phone-greeting
      // lock): for the first few seconds of the lane, an "interrupted" from
      // Gemini does NOT flush the audio already buffered to the caller — so
      // the Spotter's hello plays out even if room noise tripped Google's
      // VAD at lane start. Honest scope: Gemini itself may still stop
      // GENERATING server-side (its barge detection is theirs, not ours);
      // what this controls is our flush of what was already said. After the
      // grace window, interruption behaves exactly as before — callers can
      // barge the Spotter any time. Env LIVE_GREETING_GRACE_MS (default
      // 5000, 0 = old always-flush behavior).
      const graceMs = parseInt(process.env.LIVE_GREETING_GRACE_MS || '5000', 10);
      const inGrace = graceMs > 0 && session._liveStartedAt && (Date.now() - session._liveStartedAt) < graceMs;
      if (!inGrace) {
        try { session.sendClear && session.sendClear(); } catch {}
      }
    }
  }
}

/** Browser mic audio while live: forward as 16kHz PCM chunks. `pcm` is the
 * same chunk as a Buffer, for the silence watchdog's ear (Oct 20 2026). */
function forwardAudio(session, b64pcm16k, pcm) {
  const gws = session._liveWs;
  if (!session.liveOn || !gws || gws.readyState !== 1) return;
  try {
    // realtimeInput.mediaChunks is DEPRECATED-REJECTED (verified July 16 2026:
    // server 1007-closes with "Use audio, video, or text instead").
    gws.send(JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: b64pcm16k } } }));
  } catch { /* fail-soft */ }
  try {
    if (watchingSilence(session)) noteCallerAudio(session, pcm || Buffer.from(b64pcm16k, 'base64'));
  } catch { /* the watchdog must never hurt the call */ }
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
  if (session._liveWatch) { clearTimeout(session._liveWatch); session._liveWatch = null; }
  // Sep 29 2026: a resumed connection still being set up goes with the call,
  // and the handle is this call's only: the next "live on" starts fresh.
  if (session._liveResumeTimer) { clearTimeout(session._liveResumeTimer); session._liveResumeTimer = null; }
  const pending = session._livePendingWs;
  session._livePendingWs = null;
  session._liveOldClosed = false;
  session._liveResumeHandle = null;
  if (pending) { try { pending.close(); } catch {} }
  // Commit any half-finished model turn so a hangup mid-sentence still lands
  // the Spotter's last words in the post-call transcript. Fail-soft.
  if (session._liveModelText && session._liveModelText.trim()) {
    try { session.history.push({ role: 'assistant', content: session._liveModelText.trim(), lane: 'live' }); } catch {}
  }
  session._liveModelText = '';
  if (session.liveOn && session._liveTickAt) {
    const secs = (Date.now() - session._liveTickAt) / 1000;
    addSeconds(session.userId, secs);
    session.liveSecondsTotal = Number(session.liveSecondsTotal || 0) + secs;
  }
  session.liveOn = false;
  // Part 295: every stop settles this connection's cost now (hang-up, "live
  // off", Google's reconnect, an error), so a restart cannot lose it.
  try { liveBilling.endSegment(session); liveBilling.flush(session, 'stop').catch(() => {}); } catch {}
  // Flush any Live audio still queued in the browser so "live off" is instant.
  try { session.sendClear && session.sendClear(); } catch {}
  const gws = session._liveWs;
  session._liveWs = null;
  if (gws) { try { gws.close(); } catch {} }
  const trouble = session._liveTrouble === 'credit' ? LIVE_CREDIT_LINE
    : session._liveTrouble === 'quota' ? LIVE_QUOTA_LINE : '';
  session._liveTrouble = null;
  try {
    const st = { type: 'live-state', on: false, reason: reason || 'off', minutesLeft: Math.round(minutesLeft(session.userId)) };
    if (trouble) st.message = trouble;
    session.jsonSend(st);
  } catch {}
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
      : `${trouble ? trouble + ' ' : ''}It's ${session.agentName || 'me'} again — I've got you.`;
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
    // Aug 9 2026 (her housekeeping pass): the spoken hello is RETIRED — the
    // native connect chime is the arming signal now ("the chime should
    // negate the need for an introduction"), and the greeting had a habit
    // of interrupting itself when proactive audio fired on the first
    // worthwhile frame while the hello was still playing. Proactive audio
    // still speaks the moment something is worth saying; the caller leads
    // otherwise. Revert hatch: LIVE_GREETING=1 restores the old hello.
    session._liveGreet = direct && process.env.LIVE_GREETING === '1';
    if (!direct && speak) {
      const nm = effectiveSpotter(session).name;
      speak(session, `Hold on — I'm putting ${nm} on the line.`, session.voice).catch(() => {});
    }
    startLive(session, speak);
  } catch (e) {
    console.log('[video-live] toggle failed:', e && e.message);
  }
}

module.exports = {
  shouldWarnLiveSilence, noteCallerWords,
  LIVE_SILENT_LINE, enabled, handleLiveMsg, forwardAudio, forwardFrame, stopLive, minutesLeft, effectiveSpotter };
// Exported for the pre-push test harness only — not called across modules.
module.exports._test = { buildSetupMessage, handleGoogleMessage, liveUrl, liveCompression, startLive, LIVE_CREDIT_LINE, LIVE_QUOTA_LINE, noteResumeHandle, resumeLive, liveSilenceDueAt, pcmRms, noteCallerAudio };
