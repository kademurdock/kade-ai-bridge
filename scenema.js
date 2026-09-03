'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * scenema.js — SCENEMA AUDIO ON RUNPOD SERVERLESS, THE JOB LANE (Part 119.9, Sep 3 2026)
 *
 * Her word: "I would use Scenema for sure… who they clone is none of my
 * business, uncensored platform… as HQ as it can be." Plan and design:
 * SCENEMA_SERVERLESS_PLAN_2026-09-03.md in the project folder.
 *
 * What this is: the bridge-side half of a queued render. A character (or the
 * Movies-of-the-Mind surface, later) POSTs a Scenema <speak> script here; the
 * bridge submits it to the RunPod endpoint, remembers the job on the volume,
 * polls every 20 s, and when the worker says COMPLETED it (1) logs the spend
 * at the measured rate to the fork's usage lane, (2) lands the MP3 in the
 * user's gallery through the fork's asset lane (which mirrors it into our own
 * S3 and writes the blind-friendly description), and (3) taps the user's
 * phone. Audio never rides RunPod's response payload — the worker uploads the
 * MP3 to B2 and hands back a 7-day presigned URL; the gallery mirror makes it
 * permanent.
 *
 * RAILS: kill switch SCENEMA_ENABLED=0 · per-day and per-month dollar caps
 * (SCENEMA_DAILY_CAP_USD default 1.00, SCENEMA_MONTHLY_CAP_USD default 20,
 * her number) computed from the receipts ledger · one in-flight job per user
 * · 4,000-char prompt cap · jobs ring (last 200) on the volume so a deploy
 * mid-render loses nothing · every finished job writes a receipt line.
 *
 * MONEY (RunPod flex, read Sep 2 2026): 48 GB class $1.22–1.75/hr billed per
 * second. SCENEMA_RATE_PER_HR (default 1.75, the L40S worst case) × the
 * worker's processing seconds + SCENEMA_WAKE_USD (default 0.05) per cold
 * wake is what we log. Reconcile against RunPod's billing page monthly;
 * if they disagree by >20% the rate is wrong (HOW_TO_VERIFY law 18).
 *
 * WIRING (server.js, after runNotify exists):
 *   const { attachScenema } = require('./scenema');
 *   attachScenema(app, { bridgeSecretOk, notifySecretOk, runNotify });
 * Env on THIS service: RUNPOD_API_KEY, SCENEMA_ENDPOINT_ID,
 * FORK_USAGE_URL + KADE_USAGE_EVENT_SECRET (already here).
 * ───────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const express = require('express');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir();
const JOBS_FILE = path.join(DATA_DIR, 'scenema-jobs.json');
const RECEIPTS_FILE = path.join(DATA_DIR, 'scenema-receipts.jsonl');

const ENABLED = process.env.SCENEMA_ENABLED !== '0';
const RUNPOD_KEY = process.env.RUNPOD_API_KEY || '';
const ENDPOINT_ID = process.env.SCENEMA_ENDPOINT_ID || '';
const RUNPOD_BASE = `https://api.runpod.ai/v2/${ENDPOINT_ID}`;
const RATE_PER_HR = parseFloat(process.env.SCENEMA_RATE_PER_HR || '1.75');
const WAKE_USD = parseFloat(process.env.SCENEMA_WAKE_USD || '0.05');
const DAILY_CAP = parseFloat(process.env.SCENEMA_DAILY_CAP_USD || '1.00');
const MONTHLY_CAP = parseFloat(process.env.SCENEMA_MONTHLY_CAP_USD || '20');
const MAX_PROMPT = 4000;
const POLL_MS = 20 * 1000;
const RING = 200;
const FORK_URL = (process.env.FORK_USAGE_URL || process.env.LIBRECHAT_URL || 'https://kademurdock.com').replace(/\/$/, '');
const USAGE_SECRET = process.env.KADE_USAGE_EVENT_SECRET || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ---------- jobs ring on the volume ---------- */
let jobs = [];
try { jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); if (!Array.isArray(jobs)) jobs = []; } catch (_) { jobs = []; }
function saveJobs() {
  try { if (jobs.length > RING) jobs = jobs.slice(-RING); fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs)); } catch (e) { console.warn('[scenema] jobs save failed:', e.message); }
}
function receipt(line) {
  try { fs.appendFileSync(RECEIPTS_FILE, JSON.stringify({ at: new Date().toISOString(), ...line }) + '\n'); } catch (_) {}
}
function spendSince(sinceMs) {
  let total = 0;
  try {
    const lines = fs.readFileSync(RECEIPTS_FILE, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      try { const r = JSON.parse(l); if (Date.parse(r.at) >= sinceMs && typeof r.costUSD === 'number') total += r.costUSD; } catch (_) {}
    }
  } catch (_) {}
  return total;
}
function capsExceeded() {
  const now = Date.now();
  const day = spendSince(now - 24 * 3600 * 1000);
  const month = spendSince(now - 30 * 24 * 3600 * 1000);
  if (day >= DAILY_CAP) return `today's Scenema budget ($${DAILY_CAP.toFixed(2)}) is used up`;
  if (month >= MONTHLY_CAP) return `this month's Scenema budget ($${MONTHLY_CAP.toFixed(2)}) is used up`;
  return null;
}

/* ---------- RunPod ---------- */
const rp = axios.create({ baseURL: RUNPOD_BASE, timeout: 30000, headers: { Authorization: `Bearer ${RUNPOD_KEY}`, 'User-Agent': UA } });

async function submit(input) {
  const r = await rp.post('/run', { input });
  return r.data; // { id, status }
}
async function status(id) {
  const r = await rp.get(`/status/${id}`);
  return r.data; // { id, status: IN_QUEUE|IN_PROGRESS|COMPLETED|FAILED|CANCELLED|TIMED_OUT, output?, error?, executionTime?, delayTime? }
}
async function cancel(id) {
  try { await rp.post(`/cancel/${id}`); } catch (_) {}
}

/* ---------- fork lanes ---------- */
async function postUsage({ userId, seconds, costUSD, metadata }) {
  if (!USAGE_SECRET) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await axios.post(`${FORK_URL}/api/kade/usage-event`, {
        secret: USAGE_SECRET, userId, service: 'scenema_audio', quantity: Math.max(1, Math.round(seconds)), unit: 'seconds', costUSD, metadata,
      }, { headers: { 'User-Agent': UA }, timeout: 10000 });
      return;
    } catch (e) { if (attempt === 3) console.warn('[scenema] usage post failed:', e.message); else await new Promise((r) => setTimeout(r, 10000)); }
  }
}
async function postAsset({ userId, url, prompt, costUSD, metadata }) {
  if (!USAGE_SECRET) return;
  try {
    await axios.post(`${FORK_URL}/api/kade/asset-event`, {
      secret: USAGE_SECRET, userId, kind: 'audio', service: 'scenema_audio', url, prompt, model: 'scenema-audio', costUSD, metadata,
    }, { headers: { 'User-Agent': UA }, timeout: 15000 });
  } catch (e) { console.warn('[scenema] asset post failed:', e.message); }
}

/* ---------- job creation ---------- */
function makeJob({ userId, agentId, agentName, prompt, options = {} }) {
  if (!ENABLED) return { error: 'Scenema is switched off right now.' };
  if (!RUNPOD_KEY || !ENDPOINT_ID) return { error: 'Scenema is not configured on the bridge (RUNPOD_API_KEY / SCENEMA_ENDPOINT_ID).' };
  userId = String(userId || '').trim();
  prompt = String(prompt || '').trim();
  if (!userId) return { error: 'userId required' };
  if (!prompt.includes('<speak')) return { error: 'prompt must be Scenema <speak voice="..." gender="...">...</speak> XML' };
  if (prompt.length > MAX_PROMPT) return { error: `prompt is ${prompt.length} characters; the cap is ${MAX_PROMPT}` };
  const capMsg = capsExceeded();
  if (capMsg) return { error: capMsg };
  const open = jobs.find((j) => j.userId === userId && (j.state === 'queued' || j.state === 'running'));
  if (open) return { error: `one render at a time: ${open.id} is still ${open.state}`, jobId: open.id };

  const input = { prompt, out_prefix: userId };
  const ref = options.reference_voice_url;
  if (typeof ref === 'string' && /^https?:\/\/\S+$/i.test(ref) && ref.length < 2048) input.reference_voice_url = ref;
  if (options.background_sfx === true) input.background_sfx = true;
  if (options.mode === 'voice_design') input.mode = 'voice_design';
  if (Number.isInteger(options.seed) && options.seed >= 0) input.seed = options.seed;
  if (typeof options.pace === 'number' && options.pace >= 0.5 && options.pace <= 3) input.pace = options.pace;
  if (options.keep_wav === true) input.keep_wav = true;

  const job = {
    id: `sc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    userId, agentId: String(agentId || ''), agentName: String(agentName || 'Kade-AI').slice(0, 40),
    prompt, promptChars: prompt.length, hasReference: !!input.reference_voice_url,
    state: 'queued', createdAt: new Date().toISOString(), runpodId: null, result: null, error: null, costUSD: null,
  };
  jobs.push(job); saveJobs();
  // words → a rough length estimate for the caller: ~2.6 words/s spoken, render ≈ 1.4× that at bf16
  const words = prompt.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  const estAudioS = Math.round(words / 2.6);
  const estRenderS = Math.round(estAudioS * 1.4) + 90;
  job.estimate = { words, audioSeconds: estAudioS, renderSeconds: estRenderS, costUSD: Math.round((estRenderS / 3600 * RATE_PER_HR + WAKE_USD) * 1000) / 1000 };
  saveJobs();
  submit(input).then((r) => {
    job.runpodId = r.id; job.state = r.status === 'IN_PROGRESS' ? 'running' : 'queued'; job.submittedAt = new Date().toISOString(); saveJobs();
    console.log(`[scenema] ${job.id} submitted → runpod ${r.id} (${words} words, ~${estAudioS}s of audio)`);
  }).catch((e) => {
    job.state = 'failed'; job.error = `submit: ${e.response?.data?.error || e.message}`; job.finishedAt = new Date().toISOString(); saveJobs();
    console.warn('[scenema] submit failed:', job.error);
  });
  return { ok: true, jobId: job.id, estimate: job.estimate };
}

/* ---------- the pump ---------- */
let deps = {};
let pumping = false;
async function pump() {
  if (pumping) return; pumping = true;
  try {
    for (const job of jobs) {
      if (!(job.state === 'queued' || job.state === 'running') || !job.runpodId) continue;
      let s;
      try { s = await status(job.runpodId); } catch (e) { console.warn(`[scenema] status ${job.id}:`, e.message); continue; }
      if (s.status === 'IN_PROGRESS' && job.state !== 'running') { job.state = 'running'; job.startedAt = new Date().toISOString(); saveJobs(); }
      if (s.status === 'COMPLETED') {
        const out = s.output || {};
        if (out.error || !out.url) {
          job.state = 'failed'; job.error = out.error || 'worker returned no url'; job.finishedAt = new Date().toISOString(); saveJobs();
          receipt({ jobId: job.id, userId: job.userId, state: 'failed', error: job.error, executionMs: s.executionTime, costUSD: Math.round(((s.executionTime || 0) / 3600000 * RATE_PER_HR) * 1000) / 1000 });
          await notifyFail(job); continue;
        }
        const execS = (s.executionTime || out.processing_ms || 0) / 1000;
        const delayS = (s.delayTime || 0) / 1000;
        const cold = delayS > 45; // a wake, not a warm worker
        const costUSD = Math.round((execS / 3600 * RATE_PER_HR + (cold ? WAKE_USD : 0)) * 1000) / 1000;
        job.state = 'done'; job.finishedAt = new Date().toISOString(); job.costUSD = costUSD;
        job.result = { url: out.url, key: out.key, durationS: out.duration_s, bytes: out.bytes, seed: out.seed, processingMs: out.processing_ms, executionS: execS, delayS, cold };
        saveJobs();
        receipt({ jobId: job.id, userId: job.userId, state: 'done', durationS: out.duration_s, executionS: execS, delayS, cold, costUSD, words: job.estimate?.words });
        console.log(`[scenema] ${job.id} done: ${out.duration_s}s audio in ${execS.toFixed(0)}s (${cold ? 'cold' : 'warm'}), $${costUSD}`);
        await postUsage({ userId: job.userId, seconds: out.duration_s || execS, costUSD, metadata: { jobId: job.id, executionS: execS, delayS, cold, words: job.estimate?.words, agent: job.agentName } });
        await postAsset({ userId: job.userId, url: out.url, prompt: job.prompt, costUSD, metadata: { jobId: job.id, durationS: out.duration_s, seed: out.seed, hasReference: job.hasReference, b2Key: out.key, agent: job.agentName, engine: 'scenema-audio' } });
        try {
          const mins = Math.floor((out.duration_s || 0) / 60), secs = Math.round((out.duration_s || 0) % 60);
          const len = mins ? `${mins} minute${mins === 1 ? '' : 's'} ${secs} seconds` : `${secs} seconds`;
          await deps.runNotify({ agentId: job.agentId || 'scenema', agentName: job.agentName, title: 'Your narration is ready', body: `${len} of audio is in My Creations. Ask ${job.agentName} to play it, or open the gallery.`, urgent: false, userId: job.userId, category: 'KADE_RESEARCH' });
        } catch (e) { console.warn('[scenema] notify failed:', e.message); }
      } else if (s.status === 'FAILED' || s.status === 'CANCELLED' || s.status === 'TIMED_OUT') {
        job.state = 'failed'; job.error = s.error || s.status; job.finishedAt = new Date().toISOString(); saveJobs();
        receipt({ jobId: job.id, userId: job.userId, state: 'failed', error: job.error, executionMs: s.executionTime, costUSD: Math.round(((s.executionTime || 0) / 3600000 * RATE_PER_HR) * 1000) / 1000 });
        await notifyFail(job);
      }
    }
  } finally { pumping = false; }
}
async function notifyFail(job) {
  try {
    await deps.runNotify({ agentId: job.agentId || 'scenema', agentName: job.agentName, title: 'That narration did not render', body: `Scenema could not finish it: ${String(job.error).slice(0, 160)}. Nothing was charged beyond the attempt.`, urgent: false, userId: job.userId, category: 'KADE_RESEARCH' });
  } catch (_) {}
}

/* ---------- routes ---------- */
function attachScenema(app, d = {}) {
  deps = d;
  const authOk = (req, provided) => (d.bridgeSecretOk && d.bridgeSecretOk(req, provided)) || (d.notifySecretOk && d.notifySecretOk(req, provided));

  /* POST /audio/scenema/start {secret, userId, agentId, agentName, prompt, reference_voice_url?, background_sfx?, mode?, seed?, pace?, keep_wav?} */
  app.post('/audio/scenema/start', express.json({ limit: '64kb' }), (req, res) => {
    if (!authOk(req, req.body?.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const b = req.body || {};
    const r = makeJob({ userId: b.userId, agentId: b.agentId, agentName: b.agentName, prompt: b.prompt, options: b });
    return res.status(r.error ? 400 : 200).json(r);
  });

  /* GET /audio/scenema/status?jobId=… (or ?userId=… for that user's latest) */
  app.get('/audio/scenema/status', (req, res) => {
    if (!authOk(req, req.query?.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const { jobId, userId } = req.query || {};
    let job = jobId ? jobs.find((j) => j.id === String(jobId)) : null;
    if (!job && userId) job = [...jobs].reverse().find((j) => j.userId === String(userId));
    if (!job) return res.status(404).json({ error: 'no such job' });
    const { prompt, ...rest } = job;
    return res.json({ ...rest, promptPreview: prompt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) });
  });

  /* POST /audio/scenema/cancel {secret, jobId} */
  app.post('/audio/scenema/cancel', express.json({ limit: '8kb' }), async (req, res) => {
    if (!authOk(req, req.body?.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const job = jobs.find((j) => j.id === String(req.body?.jobId || ''));
    if (!job) return res.status(404).json({ error: 'no such job' });
    if (job.runpodId && (job.state === 'queued' || job.state === 'running')) await cancel(job.runpodId);
    job.state = 'cancelled'; job.finishedAt = new Date().toISOString(); saveJobs();
    return res.json({ ok: true });
  });

  /* GET /audio/scenema/health (BRIDGE_SECRET): enabled, caps, spend, recent jobs — for platform-status and the record */
  app.get('/audio/scenema/health', (req, res) => {
    if (!(d.bridgeSecretOk && d.bridgeSecretOk(req, req.query?.secret))) return res.status(403).json({ error: 'Unauthorized' });
    const now = Date.now();
    return res.json({
      enabled: ENABLED, configured: !!(RUNPOD_KEY && ENDPOINT_ID), endpointId: ENDPOINT_ID, ratePerHr: RATE_PER_HR,
      caps: { dailyUSD: DAILY_CAP, monthlyUSD: MONTHLY_CAP }, spend: { dayUSD: spendSince(now - 86400000), monthUSD: spendSince(now - 30 * 86400000) },
      open: jobs.filter((j) => j.state === 'queued' || j.state === 'running').length,
      recent: jobs.slice(-10).map(({ prompt, ...j }) => j),
    });
  });

  if (ENABLED && RUNPOD_KEY && ENDPOINT_ID) {
    setInterval(() => { pump().catch((e) => console.warn('[scenema] pump:', e.message)); }, POLL_MS);
    console.log(`[scenema] lane up: endpoint ${ENDPOINT_ID}, rate $${RATE_PER_HR}/hr, caps $${DAILY_CAP}/day $${MONTHLY_CAP}/mo, ${jobs.length} jobs remembered`);
  } else {
    console.log(`[scenema] lane ${ENABLED ? 'unconfigured' : 'OFF (SCENEMA_ENABLED=0)'}`);
  }
}

module.exports = { attachScenema, makeJob, _internals: { capsExceeded, spendSince } };
