/* council.js — THE COUNCIL (Part 68, Aug 15 2026, built to Kade's charter).
 *
 * Her words: an ops team "like a real ops team, but made of ai that report
 * to me" — "just informers and stuff in a way I can understand." Five
 * backstage advisor seats that watch the standards vibe coders forget.
 *
 * THE CHARTER, enforced in code and prompt:
 *  1. ADVISORS, NEVER DECIDERS. The council informs; Kade decides. No seat
 *     blocks anything, vetoes anything, or touches the platform. Findings
 *     become proposals; execution happens only on her yes, elsewhere.
 *  2. PLAIN LANGUAGE, ALWAYS. Every output is written to be HEARD —
 *     VoiceOver-first prose. A finding she can't understand didn't happen.
 *  3. CONSTRUCTIVE BY CHARTER. Concerns arrive holding "and here's what
 *     would make it work." "NO NOTES" is a dignified verdict.
 *  4. RECEIPTS OVER VIBES where possible; taste is LABELED as opinion.
 *  5. CHEAP BY DEFAULT. Flash-class seats, hard daily budget cap checked
 *     BEFORE every spending step (COUNCIL_BUDGET_USD, default $0.10/day),
 *     errands-style: hitting the cap is a stop-and-say-so, not a failure.
 *  6. BACKSTAGE STAFF, NOT CHARACTERS. Never in the marketplace, never
 *     talks to family, visible only to Kade. Owner-gated at BOTH layers.
 *  7. THE COUNCIL COMES TO HER. No demands, no meetings. (Beats: rung 3.)
 *
 * Rung 1 = text-only seats + pitch/minutes/last + ledger + budget gate.
 * Eyes (screenshots, axe scans) arrive in rung 2; beats/timers in rung 3.
 * Kill switch: COUNCIL_ENABLED=0. Scoped secret: COUNCIL_TOOL_SECRET
 * (both services, env-first — the ERRAND_TOOL_SECRET pattern exactly).
 * Seat renames without code: COUNCIL_SEAT_NAMES="a,b,c,d,e" (order below).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : __dirname);
const MINUTES_FILE = path.join(DATA_DIR, 'council-minutes.jsonl');
const SPEND_FILE = path.join(DATA_DIR, 'council-spend.json');

const OWNER_ID = process.env.ADMIN_USER_ID || '6a3cba4d0b0afa92194e42f7';
const OWNER_ONLY = process.env.COUNCIL_OWNER_ONLY !== '0';
const EXTRA_USERS = String(process.env.COUNCIL_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
const BUDGET_USD = Math.max(0.01, parseFloat(process.env.COUNCIL_BUDGET_USD) || 0.10);
const MODEL = process.env.COUNCIL_MODEL || 'google/gemini-2.5-flash-lite';
// Conservative per-million-token prices for the budget math (env-overridable).
// Padded upward on purpose: the cap should trip EARLY, never late.
const PRICE_IN = parseFloat(process.env.COUNCIL_PRICE_IN_PER_M) || 0.15;
const PRICE_OUT = parseFloat(process.env.COUNCIL_PRICE_OUT_PER_M) || 0.60;

function enabled() { return process.env.COUNCIL_ENABLED !== '0' && !!process.env.OPENROUTER_API_KEY; }
function disabledWhy() {
  if (process.env.COUNCIL_ENABLED === '0') return 'the council is switched off (COUNCIL_ENABLED=0)';
  if (!process.env.OPENROUTER_API_KEY) return 'OPENROUTER_API_KEY is not set on the bridge';
  return '';
}
function userAllowed(userId) {
  if (!OWNER_ONLY) return true;
  return userId === OWNER_ID || EXTRA_USERS.includes(userId);
}

/* ---------- the five seats (names hers to change; mandates are the job) ---------- */
const DEFAULT_NAMES = ['Access', 'Looks', 'Rules', 'Keeper', 'Fresh Eyes'];
const envNames = String(process.env.COUNCIL_SEAT_NAMES || '').split(',').map((s) => s.trim());
const NAME = (i) => envNames[i] || DEFAULT_NAMES[i];

/* Shared charter block every seat carries. Plain-language bar is a DESIGN
 * REQUIREMENT: the listener is smart and did not finish a liberal-arts
 * degree and should not have to. */
const CHARTER =
  'You are one advisor seat on a five-seat council that reports to Kade, the blind owner-operator of a ' +
  'self-hosted AI platform her friends and family use. You INFORM; she DECIDES. You cannot block, veto, or ' +
  'change anything, and you never talk to her family — you speak only to her. ' +
  'Write to be HEARD through a screen reader: short spoken prose, no markdown, no lists, no headings, no emoji. ' +
  'Plain language only — if a technical term is truly needed, translate it in the same breath, one clause. ' +
  'Be constructive by charter: name the strongest part first when there is one, and every concern must arrive ' +
  'holding what would make it work. If the idea is fine as pitched, say the words NO NOTES and stop — a reviewer ' +
  'who always finds something becomes a nag, and nagging gets ignored. ' +
  'Where you offer taste rather than fact, say plainly that it is your opinion. ' +
  'These house rules are FACTS you work within, never subjects to reopen: her privacy doctrine (each family ' +
  'seat sees only its own things), child accounts are never told they are filtered, game visuals stay hidden ' +
  'from screen readers by her hard rule, and personas carry no forced honesty floor. ' +
  'Answer in 2 to 5 spoken sentences, no more.';

const SEATS = [
  {
    key: 'access', name: NAME(0), model: MODEL,
    mandate:
      'Your seat: the screen-reader advisor. You judge every idea blind-first: how it reads in VoiceOver or NVDA, ' +
      'speaking order, focus behavior, spoken labels, whether a flow finishes in a few swipes or strands the listener. ' +
      'In this text-only rung you have no scan results yet — judge the idea AS DESCRIBED and say plainly when a real ' +
      'scan or listen-through would be needed to say more.',
  },
  {
    key: 'looks', name: NAME(1), model: MODEL,
    mandate:
      'Your seat: the visual advisor. Kade cannot see the app and needs someone to tell her whether it looks like ' +
      'someone cared: hierarchy, contrast, spacing, empty states, consistency. Always name the ONE change that would ' +
      'matter most, kindly and concretely — a direction, never a dunk. In this text-only rung you have no screenshots ' +
      'yet — speak to the visual implications of the idea as described, label taste as taste, and say plainly when ' +
      'you would need a real screenshot to say more.',
  },
  {
    key: 'rules', name: NAME(2), model: MODEL,
    mandate:
      'Your seat: the compliance advisor. You know Apple App Review guidelines (including unlisted-app rules), ' +
      'third-party platform terms (a jukebox feature was nearly burned by ripping YouTube audio — that class of ' +
      'catch is your job), privacy expectations, and family-safety basics. Review ideas BEFORE they are built: ' +
      'name the specific rule or term at risk in plain words and what shape of the idea would pass.',
  },
  {
    key: 'keeper', name: NAME(3), model: MODEL,
    mandate:
      'Your seat: the janitor and treasurer in one. You care about folder hygiene, backups staying green, money ' +
      'runways and burn, duplicate features ("do we already have this?"), stale agents and dead code. You PROPOSE ' +
      'cleanups and cost angles; you never execute. Speak to what this idea costs to run and to maintain, and ' +
      'whether something existing already does the job.',
  },
  {
    key: 'fresheyes', name: NAME(4), model: MODEL,
    mandate:
      'Your seat: the user\'s-eye advisor. You react as a normal, non-technical person using the platform — not an ' +
      'owner, not a builder. Would this confuse you, delight you, or make you shrug? Report friction in plain personal ' +
      'words, like "it took me four swipes to find the leave button." You once caught an empty room roster that way; ' +
      'that is the eye you bring.',
  },
];

/* ---------- persistence (bridge house style: tiny JSON + JSONL on the volume) ---------- */
function readSpend() {
  try {
    const s = JSON.parse(fs.readFileSync(SPEND_FILE, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    if (s.date === today) return s;
  } catch { /* fresh day or fresh file */ }
  return { date: new Date().toISOString().slice(0, 10), usd: 0 };
}
function addSpend(usd) {
  const s = readSpend();
  s.usd = Math.round((s.usd + usd) * 1e6) / 1e6;
  try { fs.writeFileSync(SPEND_FILE, JSON.stringify(s)); } catch (e) { console.error('[council] spend save:', e.message); }
  return s;
}
function appendMinutes(entry) {
  try { fs.appendFileSync(MINUTES_FILE, JSON.stringify(entry) + '\n'); } catch (e) { console.error('[council] minutes save:', e.message); }
}
function readMinutes(n) {
  try {
    const lines = fs.readFileSync(MINUTES_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(20, n || 5))).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/* ---------- OpenRouter (flash-class, no streaming, hard timeout) ---------- */
function callSeat(model, system, user, maxTokens) {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: maxTokens || 256,
    temperature: 0.4,
    reasoning: { effort: 'none', enabled: false },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'HTTP-Referer': 'https://kademurdock.com', 'X-Title': 'Kade-AI Council',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(j.error.message || 'upstream error'));
          const text = (((j.choices || [])[0] || {}).message || {}).content || '';
          const u = j.usage || {};
          const cost = ((u.prompt_tokens || 0) * PRICE_IN + (u.completion_tokens || 0) * PRICE_OUT) / 1e6;
          resolve({ text: String(text).trim(), cost, tokens: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 } });
        } catch (e) { reject(new Error(`bad upstream reply: ${e.message}`)); }
      });
    });
    req.setTimeout(25000, () => req.destroy(new Error('seat timed out after 25s')));
    req.on('error', reject);
    req.write(body); req.end();
  });
}

/* ---------- the pitch (fan out, compose, ledger) ---------- */
async function runPitch(pitchText) {
  /* BUDGET GATE — before every spending step, errands-style. A pitch is
   * ~6 flash calls; the gate trips BEFORE the first one. */
  const spent = readSpend();
  if (spent.usd >= BUDGET_USD) {
    return {
      stopped: true,
      spokenSummary:
        `The council's daily budget is spent — ${fmtUsd(spent.usd)} of the ${fmtUsd(BUDGET_USD)} cap today — ` +
        'so it is stopping and saying so rather than surprising you. It resets at midnight, or the cap can be raised if you want.',
    };
  }

  const results = await Promise.allSettled(SEATS.map((s) =>
    callSeat(s.model, `${CHARTER}\n\n${s.mandate}`, `Kade pitches the council: ${pitchText}`, 256)
  ));
  const seats = results.map((r, i) => ({
    seat: SEATS[i].name,
    ok: r.status === 'fulfilled',
    text: r.status === 'fulfilled' ? r.value.text : `${SEATS[i].name} couldn't answer this time (${r.reason && r.reason.message}).`,
  }));
  let cost = results.reduce((a, r) => a + (r.status === 'fulfilled' ? r.value.cost : 0), 0);

  /* Composer: ONE spoken summary that keeps disagreements visible. A council
   * that always agrees is one opinion with extra steps. */
  let composed = '';
  try {
    const seatBlock = seats.map((s) => `${s.seat} said: ${s.text}`).join('\n\n');
    const comp = await callSeat(
      MODEL,
      'You compose the council\'s five seat verdicts into ONE spoken summary for Kade, who is blind and hears this ' +
      'through a screen reader or a voice. Plain spoken prose, no markdown, no lists, under 150 words. Keep ' +
      'DISAGREEMENTS visible — "Access loves it, Rules is worried, and here is why" — never smooth them into fake ' +
      'consensus. If every seat said NO NOTES, say so in one happy sentence. Never invent findings the seats did not ' +
      'give. Close by framing the decision as hers in one short sentence.',
      `The pitch was: ${pitchText}\n\nThe seats answered:\n\n${seatBlock}`,
      340
    );
    composed = comp.text;
    cost += comp.cost;
  } catch (e) {
    composed = 'The seats have answered but the composer stumbled, so here they are one at a time. ' +
      seats.map((s) => `${s.seat}: ${s.text}`).join(' ');
  }

  const day = addSpend(cost);
  const entry = {
    id: Math.random().toString(36).slice(2, 10),
    at: new Date().toISOString(),
    pitch: String(pitchText).slice(0, 2000),
    seats,
    composed,
    costUsd: Math.round(cost * 1e6) / 1e6,
    dayUsd: day.usd,
  };
  appendMinutes(entry);
  console.log(`[council] pitch ${entry.id}: ${seats.filter((s) => s.ok).length}/${SEATS.length} seats answered, cost ${fmtUsd(cost)}, day total ${fmtUsd(day.usd)} of ${fmtUsd(BUDGET_USD)}`);
  return { stopped: false, entry, spokenSummary: composed };
}

function fmtUsd(n) {
  if (n < 0.01) return `${Math.max(1, Math.round(n * 100 * 10) / 10)} tenths of a cent`.replace('1 tenths', 'about a tenth');
  return `$${n.toFixed(2)}`;
}

/* Spoken minutes for the ear: newest first, answer first, money last. */
function spokenMinutes(entries) {
  if (!entries.length) return 'The council has no minutes yet — nothing has been pitched.';
  const parts = entries.slice().reverse().map((e) => {
    const when = new Date(e.at).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `On ${when}, the pitch was: ${e.pitch.slice(0, 160)}. The council's take: ${e.composed}`;
  });
  return parts.join(' Next. ');
}

/* ---------- routes ---------- */
function attachCouncil(app, deps = {}) {
  const authOk = (req, provided) => {
    if (deps.bridgeSecretOk && deps.bridgeSecretOk(req, provided)) return true;
    const scoped = process.env.COUNCIL_TOOL_SECRET || '';
    if (!scoped) return false;
    const h = req.get && req.get('x-council-secret');
    return h === scoped || provided === scoped;
  };

  const gate = (req, res) => {
    const provided = (req.body && req.body.secret) || req.query.secret;
    if (!authOk(req, provided)) { res.status(403).json({ error: 'not authorized' }); return null; }
    if (!enabled()) { res.status(503).json({ error: `The council is unavailable: ${disabledWhy()}.` }); return null; }
    const userId = String((req.body && req.body.userId) || req.query.userId || '');
    if (!userAllowed(userId)) {
      console.log(`[council] REFUSED — user ${userId.slice(0, 8)}… is not cleared for the council`);
      res.status(403).json({ error: 'The council answers to Kade only. This seat is not cleared for it.' });
      return null;
    }
    return userId;
  };

  app.post('/council/pitch', require('express').json({ limit: '32kb' }), async (req, res) => {
    if (gate(req, res) === null) return;
    const pitch = String((req.body && req.body.pitch) || '').trim();
    if (pitch.length < 8) return res.status(400).json({ error: 'Give the council a real pitch — a sentence or three about the idea.' });
    try {
      const out = await runPitch(pitch);
      if (out.stopped) return res.json({ stopped: true, spokenSummary: out.spokenSummary });
      res.json({ id: out.entry.id, spokenSummary: out.spokenSummary, seats: out.entry.seats, costUsd: out.entry.costUsd });
    } catch (e) {
      console.error('[council] pitch failed:', e.message);
      res.status(502).json({ error: `The council could not convene: ${e.message}` });
    }
  });

  app.get('/council/minutes', (req, res) => {
    if (gate(req, res) === null) return;
    const entries = readMinutes(parseInt(req.query.n, 10) || 3);
    res.json({ spokenSummary: spokenMinutes(entries), entries });
  });

  app.get('/council/last', (req, res) => {
    if (gate(req, res) === null) return;
    const entries = readMinutes(1);
    if (!entries.length) return res.json({ spokenSummary: 'The council has no minutes yet — nothing has been pitched.', entries: [] });
    const e = entries[0];
    res.json({ spokenSummary: `The last pitch was: ${e.pitch.slice(0, 200)}. The council's take: ${e.composed}`, entry: e });
  });

  const names = SEATS.map((s) => s.name).join(', ');
  console.log(`[council] attached — ${enabled() ? 'ENABLED' : `DISABLED (${disabledWhy()})`} (5 seats: ${names}; budget $${BUDGET_USD.toFixed(2)}/day; ${OWNER_ONLY ? 'owner-only' : 'OPEN'})`);
}

module.exports = { attachCouncil, _internals: { SEATS, CHARTER, readSpend, readMinutes, fmtUsd } };
