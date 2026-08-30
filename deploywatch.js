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

/* ── Part 97 (Aug 29 2026): THE PROBE GROWS EARS. The old §3.1 probe asserted
 * "is audio, bigger than 4KB" about one short sentence on one voice — it could
 * hear a dead lane, but not a missing middle chunk (her actual Aug-28 morning
 * bug), never touched the fish lane, and had no sense of how long a clip
 * SHOULD be. These two pure functions are the ears; the lane runner below
 * feeds them. Not listening, but counting — the smallest honest start the
 * white-whale note kept asking for. */

/** Parse a 16-bit PCM WAV: duration + the longest run of near-silence.
 *  Returns null for anything it cannot honestly measure (not RIFF, not
 *  16-bit) — callers fall back to the old byte check rather than guess. */
function inspectWav(buf) {
  if (!buf || buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 24 <= buf.length) {
      fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    }
    if (id === 'data') data = { start: off + 8, size: Math.min(size, buf.length - off - 8) };
    off += 8 + size + (size % 2);
    if (fmt && data) break;
  }
  if (!fmt || !data || fmt.bits !== 16 || !fmt.rate || !fmt.channels) return null;
  const bytesPerSec = fmt.rate * fmt.channels * 2;
  const durationMs = Math.round((data.size / bytesPerSec) * 1000);
  /* Silence scan: 20ms windows, peak under ~-38 dBFS counts as dead air.
   * Stitched seams are digital near-zero; clone room tone sits above 400. */
  const win = Math.max(1, Math.round(fmt.rate * fmt.channels * 0.02));
  let longest = 0, run = 0;
  const end = data.start + data.size;
  for (let i = data.start; i + 2 * win <= end; i += 2 * win) {
    let peak = 0;
    for (let j = 0; j < win; j++) {
      const v = Math.abs(buf.readInt16LE(i + 2 * j));
      if (v > peak) peak = v;
    }
    if (peak < 400) { run += 20; if (run > longest) longest = run; } else { run = 0; }
  }
  return { durationMs, longestSilenceMs: longest };
}

/** The verdict, separated from the plumbing so it can be tested bare.
 *  floorMsPerChar is the bootstrap check (before a lane has a baseline);
 *  baselineMs, once a lane has one, is the sharper judge: a clip under
 *  baselineFrac of the lane's own running average means a piece went missing. */
function judgeTts(wav, textLen, baselineMs, { floorMsPerChar = 25, baselineFrac = 0.6, maxSilenceMs = 3000 } = {}) {
  const floorMs = Math.round(textLen * floorMsPerChar);
  if (wav.durationMs < floorMs) {
    return { ok: false, note: `audio too short for the text (${wav.durationMs}ms < ${floorMs}ms floor) — a chunk may be missing` };
  }
  if (baselineMs && wav.durationMs < baselineMs * baselineFrac) {
    return { ok: false, note: `audio far under this lane's own baseline (${wav.durationMs}ms vs ~${Math.round(baselineMs)}ms) — a chunk may be missing` };
  }
  if (wav.longestSilenceMs > maxSilenceMs) {
    return { ok: false, note: `a ${wav.longestSilenceMs}ms dead-air gap inside the clip` };
  }
  return { ok: true, note: '' };
}

/** Part 99 (Aug 30 2026) — DID THE STREAMED LANE ACTUALLY STREAM?
 *
 * Pure, and exported, because this is the one judge on that lane whose
 * failure looks like success. The proxy streams a single-chunk Inworld
 * request and quietly falls through to the buffered path for everything else
 * (fish, telephony, scenes, multi-chunk). The audio that comes back from a
 * fallback is PERFECT — it passes the duration floor, the baseline and the
 * silence scan — so without this the probe reports the streamed lane healthy
 * on a run where the streamed lane never executed. `x-kade-tts-streamed` is
 * the proxy's own marker; its absence on a flagged request is a failure and
 * says so in those words. */
function judgeStreamMarker({ requested, marker }) {
  if (!requested || marker) return { ok: true, note: '' };
  return {
    ok: false,
    note: 'the request did NOT stream — no x-kade-tts-streamed marker, so the proxy fell back to the buffered lane (single-chunk Inworld only)',
  };
}

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

  // ── The TTS-synth probe (§3.1, ears grown Part 97) ──────────────────────
  const TTS_ENABLED = process.env.TTS_PROBE !== '0';
  const TTS_HOURS = Math.max(1, parseInt(process.env.TTS_PROBE_HOURS || '6', 10));
  const TTS_URL = (process.env.TTS_PROBE_URL || 'https://inworld-tts-proxy-production.up.railway.app/v1/audio/speech').trim();
  const TTS_VOICE = (process.env.TTS_PROBE_VOICE || 'alloy').trim();
  /* Part 97: the fish lane gets probed too — the whole clone library rode on
   * "it worked in July" until now. '' disables. Cost per probe: ~200 UTF-8
   * bytes at $15/M = three ten-thousandths of a cent. */
  const TTS_FISH_VOICE = (process.env.TTS_PROBE_FISH_VOICE || 'Voice 327').trim();
  const TTS_MIN_BYTES = Math.max(1000, parseInt(process.env.TTS_PROBE_MIN_BYTES || '4000', 10));
  /* Three sentences on purpose: the proxy chunks and stitches them, so a
   * dropped middle chunk shortens the clip in a way duration can hear. */
  const TTS_PROBE_TEXT = (process.env.TTS_PROBE_TEXT
    || 'Voice check, sentence one is short. This is the second sentence, a touch longer, sitting in the middle of the message. And a third sentence closes it out so the whole shape can be measured.').trim();
  const TTS_MS_PER_CHAR = Math.max(5, parseInt(process.env.TTS_PROBE_MS_PER_CHAR || '25', 10));
  const TTS_BASELINE_FRAC = Math.min(0.95, Math.max(0.1, parseFloat(process.env.TTS_PROBE_BASELINE_FRAC || '0.6')));
  const TTS_MAX_SILENCE_MS = Math.max(500, parseInt(process.env.TTS_PROBE_MAX_SILENCE_MS || '3000', 10));
  /* ── Part 99 (Aug 30 2026): THE STREAMED LANE GETS THE SAME EARS ─────────
   * The three judges above have only ever tested the BUFFERED lane, because
   * this probe sends no stream flag. Part 98 measured 235ms to first word on
   * her own phone and the default flip is next — which would leave the ONE
   * thing watching for dead air and missing middles pointed at the lane
   * nobody is listening to any more. So the same request goes out a second
   * time with the flag on, and the same three judges read the result.
   *
   * THE JUDGE THIS LANE NEEDS THAT THE OTHERS DO NOT, and it is the whole
   * reason this is not two lines: the proxy streams ONLY a single-chunk
   * Inworld request — fish, telephony, scenes and any multi-chunk text fall
   * through to the buffered path, deliberately and silently. A probe that
   * accepts that fallback is a probe that reports the streamed lane green
   * while testing the old one, which is the same disease as the canary that
   * only ever tested the Canary agent. The proxy sets `x-kade-tts-streamed`
   * on a response it actually streamed, so ITS ABSENCE IS A FAILURE HERE,
   * stated in those words, even when the audio that came back is perfect.
   *
   * Its own baseline key, never shared with `default`: the streamed lane
   * rides the voice's REMEMBERED gain and has no tail fade, so its duration
   * and silence profile are its own and folding them into one EMA would
   * blunt both. TTS_PROBE_STREAM='' disables the lane. */
  const TTS_STREAM_VOICE = (process.env.TTS_PROBE_STREAM_VOICE || TTS_VOICE).trim();
  const TTS_STREAM_ON = process.env.TTS_PROBE_STREAM !== '0' && TTS_STREAM_VOICE !== '';

  if (!state.tts || typeof state.tts.fails === 'number') state.tts = { fails: {} }; // migrate the old single-lane shape
  if (!state.ttsBase) state.ttsBase = {};

  async function probeLane(lane, voice, trigger, opts = {}) {
    const t0 = Date.now();
    const result = { lane, voice, at: new Date().toISOString(), trigger, ok: false, ms: 0, bytes: 0, durationMs: null, longestSilenceMs: null, note: '' };
    try {
      const headers = { 'Content-Type': 'application/json', 'User-Agent': UA };
      if (opts.stream) headers['x-kade-tts-stream'] = '1';
      const r = await fetch(TTS_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input: TTS_PROBE_TEXT, voice, model: 'tts-1', response_format: 'wav' }),
      });
      const buf = Buffer.from(await r.arrayBuffer());
      result.bytes = buf.length;
      const ctype = String(r.headers.get('content-type') || '');
      const streamed = String(r.headers.get('x-kade-tts-streamed') || '') === '1';
      if (opts.stream) result.streamed = streamed;
      if (!r.ok) result.note = `HTTP ${r.status}`;
      else if (/json|text\/html/.test(ctype)) result.note = `non-audio content-type ${ctype}`;
      /* Checked BEFORE the audio judges on purpose: good audio off the wrong
       * lane is the failure this exists to catch, and letting the judges pass
       * first would bury it under a green note. */
      else if (!judgeStreamMarker({ requested: Boolean(opts.stream), marker: streamed }).ok) result.note = judgeStreamMarker({ requested: true, marker: false }).note;
      else if (buf.length < TTS_MIN_BYTES) result.note = `audio too small (${buf.length}B < ${TTS_MIN_BYTES})`;
      else {
        const wav = inspectWav(buf);
        if (!wav) {
          /* Unparseable (format change, future codec): the old byte check
           * already passed, so stay green rather than false-alarm — but say so. */
          result.ok = true;
          result.note = 'unparsed audio format — size check only';
        } else {
          result.durationMs = wav.durationMs;
          result.longestSilenceMs = wav.longestSilenceMs;
          const base = state.ttsBase[lane];
          const baselineMs = base && base.text === TTS_PROBE_TEXT ? base.ms : null;
          const verdict = judgeTts(wav, TTS_PROBE_TEXT.length, baselineMs, {
            floorMsPerChar: TTS_MS_PER_CHAR, baselineFrac: TTS_BASELINE_FRAC, maxSilenceMs: TTS_MAX_SILENCE_MS,
          });
          result.ok = verdict.ok;
          result.note = verdict.note;
          if (verdict.ok) {
            /* The lane's own baseline, EMA over GREEN runs only, keyed to the
             * exact probe text so a text change restarts calibration. */
            state.ttsBase[lane] = {
              text: TTS_PROBE_TEXT,
              ms: baselineMs ? Math.round(baselineMs * 0.7 + wav.durationMs * 0.3) : wav.durationMs,
              runs: ((base && base.runs) || 0) + 1,
            };
          }
        }
      }
    } catch (e) {
      result.note = e.message;
    }
    result.ms = Date.now() - t0;
    const fails = state.tts.fails;
    if (result.ok) {
      const wasFailing = (fails[lane] || 0) >= 2;
      fails[lane] = 0;
      if (wasFailing) {
        runNotify({
          agentId: 'kade-tts-probe', agentName: 'Estate watch', title: 'Voices',
          body: `The ${lane} voice lane is answering again — synth probe back to green.`,
          urgent: false, userId: adminUser, adminAlert: true,
        }).catch(() => {});
      }
    } else {
      fails[lane] = (fails[lane] || 0) + 1;
      console.warn(`[tts-probe] ${lane} FAIL #${fails[lane]}: ${result.note} (${result.ms}ms, ${result.bytes}B)`);
      if (fails[lane] === 2) {
        runNotify({
          agentId: 'kade-tts-probe', agentName: 'Estate watch', title: 'Voices',
          body: lane === 'stream'
            ? `The STREAMED voice lane failed its synth check twice running (${result.note}). The buffered lane is the fallback, so nobody should be hearing silence — but "Faster voice (streaming)" is the lane to leave off until this clears, and the inworld proxy is the place to look.`
            : `The ${lane} voice lane failed its synth check twice running (${result.note}). ${lane === 'fish' ? 'Clone voices' : 'Characters'} may be answering wrong or in silence — the inworld proxy is the place to look.`,
          urgent: false, userId: adminUser, adminAlert: true,
        }).catch(() => {});
      }
    }
    return result;
  }

  async function ttsProbe(trigger = 'tick') {
    const results = [await probeLane('default', TTS_VOICE, trigger)];
    if (TTS_FISH_VOICE) results.push(await probeLane('fish', TTS_FISH_VOICE, trigger));
    if (TTS_STREAM_ON) results.push(await probeLane('stream', TTS_STREAM_VOICE, trigger, { stream: true }));
    const combined = { at: new Date().toISOString(), trigger, ok: results.every((r) => r.ok), results };
    state.ttsLast = combined;
    saveState(state);
    return combined;
  }

  app.post('/tts-probe/run', async (req, res) => {
    if (!bridgeSecretOk(req, req.query.secret || (req.body && req.body.secret))) return res.status(403).json({ error: 'forbidden' });
    res.json(await ttsProbe('manual'));
  });
  app.get('/tts-probe', (req, res) => {
    if (!bridgeSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'forbidden' });
    const failMax = Math.max(0, ...Object.values(state.tts.fails || {}));
    res.json({ enabled: TTS_ENABLED, everyHours: TTS_HOURS, last: state.ttsLast || null, consecutiveFails: failMax, perLaneFails: state.tts.fails || {}, baselines: state.ttsBase || {} });
  });

  if (TTS_ENABLED) {
    setTimeout(() => { ttsProbe('boot').catch(() => {}); }, 7 * 60 * 1000);
    setInterval(() => { ttsProbe('tick').catch(() => {}); }, TTS_HOURS * 60 * 60 * 1000);
    console.log(`[tts-probe] armed: every ${TTS_HOURS}h via ${TTS_URL.split('/')[2]} (lanes: default${TTS_FISH_VOICE ? '+fish' : ''}${TTS_STREAM_ON ? '+stream' : ''})`);
  } else {
    console.log('[tts-probe] off (TTS_PROBE=0)');
  }

  return { tick, ttsProbe };
}

module.exports = { attachDeployWatch, speakDeploys, inspectWav, judgeTts, judgeStreamMarker };
