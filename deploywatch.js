/**
 * deploywatch.js — Part 85 (Aug 22 2026): two new reflexes for the estate.
 *
 * 1) THE DEPLOY SELF-VERIFIER (§3.2 of the Part-85 brief). The stale-hash
 *    scar bit repeatedly (Part 72 onward): a repo's branch tip moves, the
 *    Railway deploy silently fails or never triggers, and sessions read a
 *    hash line that lies. This converts the scar into reflex: every
 *    DEPLOYWATCH_INTERVAL_MIN (default 15) compare each watched repo's
 *    branch tip against the service's live deployment. A FAILED/CRASHED
 *    latest deploy, or a tip that has sat undeployed past the grace window,
 *    pages the Admin hub with both hashes. Dedup per (tip,deployed,status)
 *    pair — one alert per distinct condition, cleared on recovery.
 *
 * 2) THE TTS-SYNTH PROBE (§3.1). The voice lane had no tripwire — every
 *    other sense (site, canary, backups, memory, balances, crash ring) could
 *    speak, but a dead TTS would only be discovered by a family member's
 *    silent phone. Every TTS_PROBE_HOURS (default 6) synthesize a two-second
 *    phrase through the real inworld lane and alert on two consecutive
 *    failures. Cost: a few dozen characters of TTS a day — fractions of a cent.
 *
 * Kill switches: DEPLOYWATCH=0, TTS_PROBE=0. State survives redeploys on the
 * volume (deploywatch.json). Requires RAILWAY_API_TOKEN + GITHUB_PAT on the
 * service; absent either, the verifier logs once and stays quiet.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(), 'deploywatch.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const WATCH = [
  { key: 'fork',    name: 'LibreChat fork', repo: 'kademurdock/LibreChat',         branch: 'kade', serviceId: 'b218ff8a-a86e-4ce7-8cb9-00d8cf971f78', environmentId: '3bf75b03-d24f-4bdf-9a82-380d94b03797' },
  { key: 'inworld', name: 'inworld proxy',  repo: 'kademurdock/inworld-tts-proxy', branch: 'main', serviceId: 'c5492e31-cd83-47a6-a37c-a6a16fe4ea31', environmentId: 'c3d3d4c9-7428-4cda-bf70-b0ee45a84673' },
  { key: 'reframe', name: 'reframe proxy',  repo: 'kademurdock/reframe-proxy',     branch: 'main', serviceId: 'd528d4ab-d029-44b2-953c-57c36ac0d586', environmentId: 'c3d3d4c9-7428-4cda-bf70-b0ee45a84673' },
  { key: 'bridge',  name: 'bridge',         repo: 'kademurdock/kade-ai-bridge',    branch: 'main', serviceId: '6ff8f959-9156-4ea0-8774-e16f81a5b14f', environmentId: '25adaf26-3f9e-4cf1-a84a-0f827064349c' },
  /* Part 89: the two services nothing was watching. The harness can commit and
   * deploy on its own now, and the page checker is what tells her a page is
   * broken — a stale-hash lie about either is worse than about the rest. */
  { key: 'harness', name: 'the harness',    repo: 'kademurdock/kade-harness-svc',  branch: 'main', serviceId: '6b680944-421e-4aba-be7b-06220bdfdef9', environmentId: '5a3e1d32-a52f-45ca-ab9d-7f374366b2b1' },
  { key: 'pages',   name: 'the page checker', repo: 'kademurdock/kade-page-truth', branch: 'main', serviceId: '7ab454b7-c619-4041-b364-cf4494b2f0d8', environmentId: '5a3e1d32-a52f-45ca-ab9d-7f374366b2b1' },
];

/** Central-time day key — "today" means her today, not UTC's. */
function centralDay(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The deploy state, said out loud. PART 89 — this is the "what shipped today,
 * is anything stale" half of her ops question, and every word of it is
 * MEASURED: the branch tip from GitHub, the running hash from Railway.
 *
 * Silent (returns null) when the watcher has never run or has no rows: a
 * guessed deploy line is exactly the stale-hash lie this watcher exists to
 * kill.
 */
function speakDeploys(last) {
  const rows = (last && Array.isArray(last.rows)) ? last.rows : [];
  if (!rows.length) return null;
  const today = centralDay();
  const shipped = rows.filter((r) => r.deployedAt && centralDay(new Date(r.deployedAt)) === today);
  const broken = rows.filter((r) => r.failed);
  const stale = rows.filter((r) => r.drifted);
  const unreadable = rows.filter((r) => r.error);

  const bits = [];
  bits.push(shipped.length
    ? `Shipped today: ${shipped.map((r) => `${r.name} at ${r.deployed}`).join(', ')}.`
    : 'Nothing has deployed today.');
  if (broken.length) bits.push(`Broken deploy: ${broken.map((r) => `${r.name} is ${r.status} at ${r.deployed}`).join('; ')}.`);
  if (stale.length) bits.push(`Stale: ${stale.map((r) => `${r.name}'s branch tip ${r.tip} never deployed — it is running ${r.deployed}`).join('; ')}.`);
  if (unreadable.length) bits.push(`I could not read ${unreadable.map((r) => r.name).join(' or ')} this pass.`);
  if (!broken.length && !stale.length && !unreadable.length) {
    bits.push(`All ${rows.length} services are running their branch tips.`);
  }
  const age = last.at ? Math.round((Date.now() - Date.parse(last.at)) / 60000) : null;
  if (age != null && age > 45) bits.push(`That deploy check is ${age} minutes old.`);
  return bits.join(' ');
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { deploy: {}, tts: { fails: 0 }, last: null }; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { console.warn('[deploywatch] state save failed:', e.message); }
}

async function githubTip(repo, branch, pat) {
  const r = await fetch(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`, {
    headers: { Authorization: `Bearer ${pat}`, 'User-Agent': UA, Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error(`github ${repo}@${branch}: HTTP ${r.status}`);
  const j = await r.json();
  return { sha: j?.commit?.sha || null, at: j?.commit?.commit?.committer?.date || null };
}

async function railwayLatest(serviceId, environmentId, token) {
  const q = `query($s:String!,$e:String!){ deployments(first:1, input:{serviceId:$s, environmentId:$e}){ edges{ node{ status createdAt meta } } } }`;
  const r = await fetch('https://backboard.railway.app/graphql/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': UA },
    body: JSON.stringify({ query: q, variables: { s: serviceId, e: environmentId } }),
  });
  if (!r.ok) throw new Error(`railway HTTP ${r.status}`);
  const j = await r.json();
  const n = j?.data?.deployments?.edges?.[0]?.node;
  if (!n) throw new Error('railway: no deployments');
  return { status: n.status, sha: n.meta?.commitHash || null, at: n.createdAt };
}

function attachDeployWatch(app, { bridgeSecretOk, runNotify, adminUser }, reader = {}) {
  const ENABLED = process.env.DEPLOYWATCH !== '0';
  const INTERVAL_MIN = Math.max(5, parseInt(process.env.DEPLOYWATCH_INTERVAL_MIN || '15', 10));
  const GRACE_MIN = Math.max(3, parseInt(process.env.DEPLOYWATCH_GRACE_MIN || '10', 10));
  const RAILWAY_TOKEN = process.env.RAILWAY_API_TOKEN || '';
  const GITHUB_PAT = process.env.GITHUB_PAT || '';
  const state = loadState();
  if (!state.deploy) state.deploy = {};
  if (!state.tts) state.tts = { fails: 0 };

  async function tick(trigger = 'tick') {
    if (!RAILWAY_TOKEN || !GITHUB_PAT) {
      if (!state.warnedMissing) { console.warn('[deploywatch] missing RAILWAY_API_TOKEN or GITHUB_PAT — verifier idle'); state.warnedMissing = true; }
      return { ok: false, note: 'missing creds' };
    }
    const rows = [];
    const problems = [];
    for (const w of WATCH) {
      try {
        const [tip, dep] = await Promise.all([
          githubTip(w.repo, w.branch, GITHUB_PAT),
          railwayLatest(w.serviceId, w.environmentId, RAILWAY_TOKEN),
        ]);
        const drifted = tip.sha && dep.sha && tip.sha !== dep.sha
          && tip.at && (Date.now() - Date.parse(tip.at)) > GRACE_MIN * 60 * 1000;
        const failed = ['FAILED', 'CRASHED'].includes(dep.status);
        /* Deploys in flight (BUILDING/DEPLOYING) are neither drift nor
         * failure — the next tick sees how they landed. */
        const busy = ['BUILDING', 'DEPLOYING', 'INITIALIZING', 'QUEUED', 'WAITING'].includes(dep.status);
        const row = {
          key: w.key, name: w.name, tip: (tip.sha || '').slice(0, 8), deployed: (dep.sha || '').slice(0, 8),
          status: dep.status, drifted: !!drifted && !busy, failed,
          // Part 89: WHEN it deployed, so "what shipped today" is a fact and
          // not an inference from a hash that has been sitting there for a week.
          deployedAt: dep.at || null, tipAt: tip.at || null,
        };
        rows.push(row);
        const condition = failed ? `failed:${dep.sha}` : (row.drifted ? `drift:${tip.sha}:${dep.sha}` : null);
        const prev = state.deploy[w.key];
        if (condition && prev !== condition) {
          state.deploy[w.key] = condition;
          problems.push(failed
            ? `${w.name} latest deploy is ${dep.status} at ${row.deployed}`
            : `${w.name} branch tip ${row.tip} has not deployed (live: ${row.deployed}, status ${dep.status})`);
        } else if (!condition && prev) {
          delete state.deploy[w.key];
          console.log(`[deploywatch] ${w.name} recovered (${row.deployed} ${dep.status})`);
        }
      } catch (e) {
        rows.push({ key: w.key, name: w.name, error: e.message });
        console.warn(`[deploywatch] ${w.key} check failed: ${e.message}`);
      }
    }
    state.last = { at: new Date().toISOString(), trigger, rows };
    saveState(state);
    if (problems.length) {
      console.warn(`[deploywatch] ALERT: ${problems.join('; ')}`);
      runNotify({
        agentId: 'kade-deploy-watch', agentName: 'Estate watch', title: 'Deploys',
        body: `${problems.join('. ')}. The record and the live code disagree — worth a look before trusting any hash line.`,
        urgent: false, userId: adminUser, adminAlert: true,
      }).catch(() => {});
    }
    return { ok: true, rows };
  }

  /* Part 89 — the same state, read instead of alerted on. /platform-status
   * calls this, so Kiana can answer "what shipped, is anything stale" without
   * anyone opening Admin or switching characters. */
  reader.snapshot = () => state.last || null;
  reader.speak = () => speakDeploys(state.last);
  reader.refresh = () => tick('platform-status');

  app.get('/deploywatch', (req, res) => {
    if (!bridgeSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'forbidden' });
    res.json({ enabled: ENABLED, intervalMin: INTERVAL_MIN, graceMin: GRACE_MIN, last: state.last, open: state.deploy });
  });
  app.post('/deploywatch/run', async (req, res) => {
    if (!bridgeSecretOk(req, req.query.secret || (req.body && req.body.secret))) return res.status(403).json({ error: 'forbidden' });
    res.json(await tick('manual'));
  });

  if (ENABLED) {
    setTimeout(() => { tick('boot').catch(() => {}); }, 4 * 60 * 1000);
    setInterval(() => { tick('tick').catch(() => {}); }, INTERVAL_MIN * 60 * 1000);
    console.log(`[deploywatch] armed: every ${INTERVAL_MIN}m, grace ${GRACE_MIN}m, ${WATCH.length} services`);
  } else {
    console.log('[deploywatch] off (DEPLOYWATCH=0)');
  }

  // ── The TTS-synth probe (§3.1) ──────────────────────────────────────────
  const TTS_ENABLED = process.env.TTS_PROBE !== '0';
  const TTS_HOURS = Math.max(1, parseInt(process.env.TTS_PROBE_HOURS || '6', 10));
  const TTS_URL = (process.env.TTS_PROBE_URL || 'https://inworld-tts-proxy-production.up.railway.app/v1/audio/speech').trim();
  const TTS_VOICE = (process.env.TTS_PROBE_VOICE || 'alloy').trim();
  const TTS_MIN_BYTES = Math.max(1000, parseInt(process.env.TTS_PROBE_MIN_BYTES || '4000', 10));

  async function ttsProbe(trigger = 'tick') {
    const t0 = Date.now();
    const result = { at: new Date().toISOString(), trigger, ok: false, ms: 0, bytes: 0, note: '' };
    try {
      const r = await fetch(TTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ input: 'Voice check. All good.', voice: TTS_VOICE, model: 'tts-1' }),
      });
      const buf = Buffer.from(await r.arrayBuffer());
      result.ms = Date.now() - t0; result.bytes = buf.length;
      const ctype = String(r.headers.get('content-type') || '');
      if (!r.ok) result.note = `HTTP ${r.status}`;
      else if (/json|text\/html/.test(ctype)) result.note = `non-audio content-type ${ctype}`;
      else if (buf.length < TTS_MIN_BYTES) result.note = `audio too small (${buf.length}B < ${TTS_MIN_BYTES})`;
      else result.ok = true;
    } catch (e) {
      result.ms = Date.now() - t0; result.note = e.message;
    }
    state.ttsLast = result;
    if (result.ok) {
      const wasFailing = state.tts.fails >= 2;
      state.tts.fails = 0;
      if (wasFailing) {
        runNotify({
          agentId: 'kade-tts-probe', agentName: 'Estate watch', title: 'Voices',
          body: 'The voice lane is answering again — TTS synth probe back to green.',
          urgent: false, userId: adminUser, adminAlert: true,
        }).catch(() => {});
      }
    } else {
      state.tts.fails += 1;
      console.warn(`[tts-probe] FAIL #${state.tts.fails}: ${result.note} (${result.ms}ms, ${result.bytes}B)`);
      if (state.tts.fails === 2) {
        runNotify({
          agentId: 'kade-tts-probe', agentName: 'Estate watch', title: 'Voices',
          body: `The voice lane failed its synth check twice running (${result.note}). Characters may be answering in silence — the inworld proxy is the place to look.`,
          urgent: false, userId: adminUser, adminAlert: true,
        }).catch(() => {});
      }
    }
    saveState(state);
    return result;
  }

  app.post('/tts-probe/run', async (req, res) => {
    if (!bridgeSecretOk(req, req.query.secret || (req.body && req.body.secret))) return res.status(403).json({ error: 'forbidden' });
    res.json(await ttsProbe('manual'));
  });
  app.get('/tts-probe', (req, res) => {
    if (!bridgeSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'forbidden' });
    res.json({ enabled: TTS_ENABLED, everyHours: TTS_HOURS, last: state.ttsLast || null, consecutiveFails: state.tts.fails });
  });

  if (TTS_ENABLED) {
    setTimeout(() => { ttsProbe('boot').catch(() => {}); }, 7 * 60 * 1000);
    setInterval(() => { ttsProbe('tick').catch(() => {}); }, TTS_HOURS * 60 * 60 * 1000);
    console.log(`[tts-probe] armed: every ${TTS_HOURS}h via ${TTS_URL.split('/')[2]}`);
  } else {
    console.log('[tts-probe] off (TTS_PROBE=0)');
  }

  return { tick, ttsProbe };
}

module.exports = { attachDeployWatch, speakDeploys };
