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

/* ---------- the five seats — NAMED BY KADE, Aug 15 2026, her reasoning kept:
 * ARIA (screen reader) — "it's literally the accessibility standard (WAI-ARIA)
 *   AND a solo vocal performance. She's listening to the song your interface
 *   sings when nobody's looking at it."
 * PRISM (visual) — "takes the whole picture and breaks it into what actually
 *   matters — color, contrast, composition. One screen, refracted into the
 *   parts worth fixing."
 * SENTINEL (compliance) — "rules are passive. A sentinel is actively watching.
 *   Has that weight to it without sounding like a buzzkill."
 * VAULT (janitor-treasurer) — "it's where you store things AND where you keep
 *   the money. Organized, secure, nothing gets lost."
 * PILGRIM (user's-eye) — "walks through your flows like someone arriving for
 *   the first time... not a tourist — a pilgrim has purpose, they're paying
 *   attention to the journey itself."
 * Internal keys (access/looks/rules/keeper/fresheyes) stay stable for rung-2
 * wiring; COUNCIL_SEAT_NAMES env can still override display names. ---------- */
const DEFAULT_NAMES = ['Aria', 'Prism', 'Sentinel', 'Vault', 'Pilgrim'];
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

/* ---------- the council's memory (HER ask, Aug 15 evening) ----------
 * Three organs, all tiny JSON on the volume, zero idle cost:
 *  1. FINDINGS LEDGER — every finding fingerprinted and statused
 *     (new / known / fixed / parked-by-her-word). Sweeps then speak only
 *     CHANGES. This is the anti-nag engine the charter demands: without
 *     it, the second weekly beat re-announces week one's findings as
 *     news, and "a nagging council gets ignored, and then it's theater."
 *  2. HER VERDICTS — park/unpark/note via /council/decision. Parked
 *     findings stay tracked but unspoken unless they worsen. Advisors
 *     never deciders; memory records HER decisions, enforces only quiet.
 *  3. SEAT NOTEBOOKS — each seat sees its own last few notes before
 *     answering, so Aria remembers being Aria. Capped at 8 lines. */
const FINDINGS_FILE = path.join(DATA_DIR, 'council-findings.json');
const NOTEBOOKS_FILE = path.join(DATA_DIR, 'council-notebooks.json');
function readJsonFile(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }
function writeJsonFile(f, v) { try { fs.writeFileSync(f, JSON.stringify(v)); } catch (e) { console.error(`[council] save ${path.basename(f)}:`, e.message); } }

function diffSweepFindings(pages) {
  const store = readJsonFile(FINDINGS_FILE, { findings: {} });
  const now = new Date().toISOString();
  const seen = new Set();
  const fresh = []; const known = []; const parked = [];
  for (const p of pages) {
    if (p.error) continue;
    for (const v of p.axe || []) {
      const fid = `axe:${p.name}:${v.id}`;
      seen.add(fid);
      const f = store.findings[fid];
      if (!f) {
        store.findings[fid] = { id: fid, kind: 'axe', page: p.name, rule: v.id, impact: v.impact || 'minor', desc: v.help, nodes: v.nodes, status: 'new', firstSeen: now, lastSeen: now, timesSeen: 1 };
        fresh.push(store.findings[fid]);
      } else {
        f.lastSeen = now; f.timesSeen += 1; f.desc = v.help;
        const worse = v.nodes > (f.nodes || 0);
        f.nodes = v.nodes;
        if (f.status === 'fixed') { f.status = 'new'; delete f.fixedAt; fresh.push(f); } // regression IS news
        else if (f.status === 'parked') { if (worse) fresh.push(f); else parked.push(f); } // parked stays quiet unless worse
        else { f.status = 'known'; known.push(f); }
      }
    }
  }
  const fixed = [];
  const capturedPages = new Set(pages.filter((p) => !p.error).map((p) => p.name));
  for (const f of Object.values(store.findings)) {
    if (f.kind === 'axe' && !seen.has(f.id) && capturedPages.has(f.page) && f.status !== 'fixed') {
      f.status = 'fixed'; f.fixedAt = now; fixed.push(f);
    }
  }
  writeJsonFile(FINDINGS_FILE, store);
  return { fresh, known, fixed, parked };
}

function noteSeat(key, text) {
  const nb = readJsonFile(NOTEBOOKS_FILE, {});
  nb[key] = [{ at: new Date().toISOString().slice(0, 10), note: String(text).replace(/\s+/g, ' ').slice(0, 220) }, ...(nb[key] || [])].slice(0, 8);
  writeJsonFile(NOTEBOOKS_FILE, nb);
}
function seatMemory(key) {
  const notes = (readJsonFile(NOTEBOOKS_FILE, {})[key]) || [];
  if (!notes.length) return '';
  return '\n\nYOUR OWN RECENT NOTES, newest first — remember what you already said, and never re-announce an old finding as news:\n' +
    notes.map((n) => `${n.at}: ${n.note}`).join('\n');
}

/* ---------- vision calls (rung 2: Prism gets real eyes) ---------- */
function callVision(model, system, userText, imagesB64) {
  const content = [{ type: 'text', text: userText }];
  for (const b64 of imagesB64.slice(0, 6)) {
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
  }
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content }],
    max_tokens: 400,
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
          resolve({ text: String(text).trim(), cost });
        } catch (e) { reject(new Error(`bad upstream reply: ${e.message}`)); }
      });
    });
    req.setTimeout(60000, () => req.destroy(new Error('vision call timed out after 60s')));
    req.on('error', reject);
    req.write(body); req.end();
  });
}

/* ---------- the devbox eyes (rung 2) ---------- */
function devboxSweep(pages, login) {
  const body = JSON.stringify({ pages, login });
  const u = new URL(`${process.env.DEVBOX_URL || 'https://forge-devbox-production.up.railway.app'}/sweep`);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DEVBOX_SECRET || ''}`,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode !== 200) return reject(new Error(j.error || `devbox HTTP ${res.statusCode}`));
          resolve(j);
        } catch (e) { reject(new Error(`devbox reply unreadable: ${e.message}`)); }
      });
    });
    req.setTimeout(300000, () => req.destroy(new Error('the devbox sweep ran past 5 minutes')));
    req.on('error', reject);
    req.write(body); req.end();
  });
}

/* ---------- the full-platform sweep (rung 2: real receipts, her ask) ---------- */
const SWEEP_PAGES = [
  { name: 'login page', url: 'https://kademurdock.com/login' },
  { name: 'chat home', url: 'https://kademurdock.com/' },
  { name: 'tools hub', url: 'https://kademurdock.com/tools' },
  { name: 'help site', url: 'https://kademurdock.com/help' },
];
const PLATFORM_BRIEF =
  'The platform: kademurdock.com, a self-hosted AI chat home a blind owner (Kade) runs for family and friends — ' +
  'about ten real people. Blind-first is the house law: screen-reader flow is sacred, game visuals are hidden from ' +
  'screen readers on purpose. Surfaces: web chat with ~223 AI characters, voice calls in and out over a real phone ' +
  'number, a native iOS app (TestFlight, App Store review in progress), voice rooms (Clubhouse), a game parlor, a ' +
  'help site, and admin dashboards only Kade sees. Money is tight by design: model spend rides prepaid pots with ' +
  'runway watchers. The family is non-technical.';

async function runSweep(trigger, deps) {
  const spent = readSpend();
  if (spent.usd >= BUDGET_USD) {
    return { stopped: true, spokenSummary: `The council's daily budget is spent — ${fmtUsd(spent.usd)} of ${fmtUsd(BUDGET_USD)} — so the sweep is stopping before it starts.` };
  }
  const login = { url: 'https://kademurdock.com/login', email: process.env.VISCHECK_EMAIL || '', password: process.env.VISCHECK_PASS || '', afterIndex: 0 };
  const cap = await devboxSweep(SWEEP_PAGES, login.email ? login : null);
  const pages = cap.pages || [];
  const shots = pages.filter((p) => p.shot).map((p) => p.shot);
  const axeLines = pages.map((p) => {
    if (p.error) return `${p.name}: capture failed (${p.error})`;
    if (!p.axe || !p.axe.length) return `${p.name}: no violations found`;
    return `${p.name}: ` + p.axe.map((v) => `${v.id} (${v.impact || 'minor'}, ${v.nodes} spot${v.nodes === 1 ? '' : 's'}) — ${v.help}`).join('; ');
  }).join('\n');
  const axeTotal = pages.reduce((a, p) => a + ((p.axe || []).reduce((b, v) => b + v.nodes, 0)), 0);

  /* MEMORY PASS: the ledger decides what counts as news. */
  const mem = diffSweepFindings(pages);
  const describe = (f) => `${f.rule} on the ${f.page} (${f.impact}, ${f.nodes} spot${f.nodes === 1 ? '' : 's'}) — ${f.desc}`;
  const memLines = [
    mem.fresh.length ? `NEW this sweep (this is the news): ${mem.fresh.map(describe).join('; ')}` : 'NEW this sweep: none.',
    mem.fixed.length ? `FIXED since last sweep (worth celebrating out loud): ${mem.fixed.map((f) => `${f.rule} on the ${f.page}`).join('; ')}` : '',
    mem.known.length ? `ALREADY KNOWN and previously reported (${mem.known.length}) — do NOT re-announce these as news; at most one counting sentence.` : '',
    mem.parked.length ? `PARKED BY KADE'S OWN WORD (${mem.parked.length}) — stay silent about these; they only come back if they worsen.` : '',
  ].filter(Boolean).join('\n');

  let cost = 0;
  const seatOut = [];
  /* Aria reads the REAL scan. */
  try {
    const aria = await callSeat(SEATS[0].model, `${CHARTER}\n\n${SEATS[0].mandate}${seatMemory(SEATS[0].key)}`,
      `A real automated accessibility scan (axe-core) just ran on the platform's key web pages. Raw findings, one line per page:\n${axeLines}\n\nTHE COUNCIL'S LEDGER has already sorted these against past sweeps:\n${memLines}\n\nTranslate what matters into plain speech for Kade: lead with what's NEW, celebrate what's FIXED, give knowns one counting sentence at most, keep parked items silent. If nothing is new and nothing broke, say so happily — that is a win, not a failure to find something.`, 300);
    seatOut.push({ seat: SEATS[0].name, ok: true, text: aria.text }); cost += aria.cost;
  } catch (e) { seatOut.push({ seat: SEATS[0].name, ok: false, text: `${SEATS[0].name} couldn't read the scan (${e.message}).` }); }
  /* Prism sees the REAL screens. */
  try {
    const prism = await callVision(process.env.COUNCIL_VISION_MODEL || MODEL, `${CHARTER}\n\n${SEATS[1].mandate}${seatMemory(SEATS[1].key)}`,
      `These are real screenshots of the platform's web pages, in order: ${pages.map((p) => p.name).join(', ')}. Kade cannot see them — be her eyes. Judge hierarchy, contrast, spacing, empty states, consistency, and whether it looks like someone cared. Name the ONE change that would matter most overall.`, shots);
    seatOut.push({ seat: SEATS[1].name, ok: true, text: prism.text }); cost += prism.cost;
  } catch (e) { seatOut.push({ seat: SEATS[1].name, ok: false, text: `${SEATS[1].name} couldn't see the screenshots (${e.message}).` }); }
  /* Sentinel, Vault, Pilgrim get the brief + both specialists' takes. */
  const material = `${PLATFORM_BRIEF}\n\nThe accessibility scan said:\n${axeLines}\n\n${SEATS[0].name} (screen reader seat) says: ${seatOut[0].text}\n\n${SEATS[1].name} (visual seat) says: ${seatOut[1] ? seatOut[1].text : 'no visual read this time'}`;
  const rest = await Promise.allSettled([2, 3, 4].map((i) =>
    callSeat(SEATS[i].model, `${CHARTER}\n\n${SEATS[i].mandate}${seatMemory(SEATS[i].key)}`,
      `The council is running a whole-platform check-in for Kade — her ask: what should change, improve, or get fixed? Material gathered this sweep:\n\n${material}\n\nGive your seat's take on the platform as it stands.`, 280)
  ));
  rest.forEach((r, idx) => {
    const i = idx + 2;
    seatOut.push({ seat: SEATS[i].name, ok: r.status === 'fulfilled', text: r.status === 'fulfilled' ? r.value.text : `${SEATS[i].name} couldn't answer (${r.reason && r.reason.message}).` });
    if (r.status === 'fulfilled') cost += r.value.cost;
  });
  /* Compose. */
  let composed = '';
  try {
    const comp = await callSeat(MODEL,
      'You compose the council\'s five seat verdicts into ONE spoken summary for Kade, who is blind. Plain spoken prose, no markdown, under 170 words. This was a whole-platform SWEEP with real receipts (a real accessibility scan, real screenshots) run against the council\'s own ledger. Lead with what is NEW, celebrate what got FIXED, give already-known findings one counting sentence at most, never mention parked items, never invent findings, keep disagreements visible, and close framing the decision as hers. If the sweep found nothing new, say so with satisfaction.',
      `The seats answered:\n\n${seatOut.map((s) => `${s.seat} said: ${s.text}`).join('\n\n')}`, 380);
    composed = comp.text; cost += comp.cost;
  } catch (e) {
    composed = 'The sweep ran but the composer stumbled; the seat verdicts are on the ledger one by one.';
  }
  const day = addSpend(cost);
  const entry = {
    id: Math.random().toString(36).slice(2, 10), at: new Date().toISOString(), kind: 'sweep', trigger,
    pitch: `PLATFORM SWEEP (${trigger}) — real axe scan of ${pages.length} pages (${axeTotal} violation spots total) + screenshot review`,
    pages: pages.map((p) => ({ name: p.name, ok: !p.error, violations: (p.axe || []).reduce((a, v) => a + v.nodes, 0) })),
    memory: { new: mem.fresh.length, fixed: mem.fixed.length, known: mem.known.length, parked: mem.parked.length,
      newIds: mem.fresh.map((f) => f.id), fixedIds: mem.fixed.map((f) => f.id) },
    loggedIn: cap.loggedIn !== false, seats: seatOut, composed, costUsd: Math.round(cost * 1e6) / 1e6, dayUsd: day.usd,
  };
  appendMinutes(entry);
  seatOut.forEach((s, i) => { if (s.ok) noteSeat(SEATS[i].key, `sweep: ${s.text}`); });
  console.log(`[council] sweep ${entry.id} (${trigger}): ${pages.length} pages, ${axeTotal} axe spots (${mem.fresh.length} new, ${mem.fixed.length} fixed, ${mem.known.length} known, ${mem.parked.length} parked), cost ${fmtUsd(cost)}`);
  if (deps && deps.runNotify) {
    try {
      await deps.runNotify({
        agentId: 'kade-council', agentName: 'The Council', urgent: false, userId: OWNER_ID, category: 'KADE_COUNCIL',
        title: 'Council sweep done',
        body: `The council swept the platform (${pages.length} pages, real scan). Ask Kiana for the council's last minutes to hear it.`,
      });
    } catch (e) { console.warn('[council] sweep digest push failed:', e.message); }
  }
  return { stopped: false, entry, spokenSummary: composed };
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
    callSeat(s.model, `${CHARTER}\n\n${s.mandate}${seatMemory(s.key)}`, `Kade pitches the council: ${pitchText}`, 256)
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
  seats.forEach((s, i) => { if (s.ok) noteSeat(SEATS[i].key, `pitch "${String(pitchText).slice(0, 60)}": ${s.text}`); });
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

  app.post('/council/sweep', require('express').json({ limit: '8kb' }), async (req, res) => {
    if (gate(req, res) === null) return;
    /* The sweep takes ~2 minutes; answer NOW, run behind, land in minutes,
     * tap her phone when done. Nobody sits on a hanging request. */
    res.json({ started: true, note: 'The council is sweeping — a couple of minutes. The verdict lands in the minutes and taps her phone when done.' });
    runSweep(String((req.body && req.body.trigger) || 'her ask'), deps)
      .catch((e) => console.error('[council] sweep failed:', e.message));
  });

  /* HER VERDICTS (the memory system's decision lane). Park = the council
   * goes quiet about it unless it worsens. Unpark = it counts as known
   * again. Note = her word rides the finding. Every decision lands in the
   * minutes, because the ledger records what she decided — that was the
   * design from day one. */
  app.post('/council/decision', require('express').json({ limit: '8kb' }), (req, res) => {
    if (gate(req, res) === null) return;
    const { id, verdict, word } = req.body || {};
    const store = readJsonFile(FINDINGS_FILE, { findings: {} });
    const f = store.findings[String(id || '')];
    if (!f) return res.status(404).json({ error: 'No finding on the ledger by that id. The minutes carry finding ids.' });
    if (verdict === 'park') { f.status = 'parked'; if (word) f.herWord = String(word).slice(0, 300); }
    else if (verdict === 'unpark') { f.status = 'known'; delete f.herWord; }
    else if (verdict === 'note') { f.herWord = String(word || '').slice(0, 300); }
    else return res.status(400).json({ error: 'verdict must be park, unpark, or note' });
    f.decidedAt = new Date().toISOString();
    writeJsonFile(FINDINGS_FILE, store);
    appendMinutes({ id: Math.random().toString(36).slice(2, 10), at: new Date().toISOString(), kind: 'decision',
      pitch: `HER DECISION: ${verdict} — ${f.id}${word ? ` ("${String(word).slice(0, 120)}")` : ''}`,
      seats: [], composed: `Recorded. ${f.desc || f.id} is now ${f.status}.`, costUsd: 0, dayUsd: readSpend().usd });
    const spoken = verdict === 'park'
      ? `Recorded — ${f.desc || f.id} is parked by your word. The council stays quiet about it unless it gets worse.`
      : verdict === 'unpark' ? `Recorded — ${f.desc || f.id} counts as an open known finding again.`
      : `Recorded — your note now rides that finding.`;
    res.json({ ok: true, finding: f, spokenSummary: spoken });
  });

  app.get('/council/findings', (req, res) => {
    if (gate(req, res) === null) return;
    const store = readJsonFile(FINDINGS_FILE, { findings: {} });
    const all = Object.values(store.findings);
    const by = (s) => all.filter((f) => f.status === s);
    const open = [...by('new'), ...by('known')];
    const spoken = all.length
      ? `The ledger holds ${all.length} finding${all.length === 1 ? '' : 's'}: ${by('new').length} new, ${by('known').length} known, ${by('parked').length} parked by your word, ${by('fixed').length} fixed. ` +
        (open.length ? 'Open items: ' + open.map((f) => `${f.desc} on the ${f.page} (id ${f.id})`).join('; ') + '.' : 'Nothing open — the board is clean.')
      : 'The ledger is empty — no sweep has filed findings yet.';
    res.json({ spokenSummary: spoken, findings: all });
  });

  /* WEEKLY BEAT (her word, Aug 15: live now, Sunday mornings, on HER
   * platform). Central-time Sunday after 9am, once per week, persisted on
   * the volume so restarts can't double-fire. Kill: COUNCIL_BEAT_WEEKLY=0. */
  const BEATS_FILE = path.join(DATA_DIR, 'council-beats.json');
  const readBeats = () => { try { return JSON.parse(fs.readFileSync(BEATS_FILE, 'utf8')); } catch { return {}; } };
  setInterval(() => {
    if (process.env.COUNCIL_BEAT_WEEKLY === '0' || !enabled()) return;
    const c = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    if (c.getDay() !== 0 || c.getHours() < 9) return;
    const weekKey = `${c.getFullYear()}-w${Math.floor(c.getTime() / (7 * 86400000))}`;
    const beats = readBeats();
    if (beats.lastWeekly === weekKey) return;
    beats.lastWeekly = weekKey;
    try { fs.writeFileSync(BEATS_FILE, JSON.stringify(beats)); } catch (e) { console.error('[council] beats save:', e.message); return; }
    console.log('[council] weekly beat firing');
    runSweep('weekly beat', deps).catch((e) => console.error('[council] weekly beat failed:', e.message));
  }, 30 * 60 * 1000);

  const names = SEATS.map((s) => s.name).join(', ');
  console.log(`[council] attached — ${enabled() ? 'ENABLED' : `DISABLED (${disabledWhy()})`} (5 seats: ${names}; budget $${BUDGET_USD.toFixed(2)}/day; ${OWNER_ONLY ? 'owner-only' : 'OPEN'}; weekly beat ${process.env.COUNCIL_BEAT_WEEKLY === '0' ? 'OFF' : 'ON (Sun 9am Central)'})`);
}

module.exports = { attachCouncil, _internals: { SEATS, CHARTER, readSpend, readMinutes, fmtUsd } };
