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
/* THE FLOOR (Part 122, Sep 3 2026). A job whose worker never gets placed used
 * to sit IN_QUEUE forever: RunPod does not fail it, and executionTimeoutMs only
 * starts counting once a card PICKS THE JOB UP, so on a job nothing picks up it
 * never fires. Her render on Sep 3 sat 98 minutes and said nothing -- the whole
 * time the endpoint read `throttled: 1`, meaning no GPU was free in US-KS-2,
 * where the weights volume pins every worker. Nothing anywhere in this system
 * ever gave up. This is that missing floor. Her number: ten minutes. */
const QUEUE_TIMEOUT_MS = parseInt(process.env.SCENEMA_QUEUE_TIMEOUT_MS || String(10 * 60 * 1000), 10);
/* Measured Sep 3: cold wake 6-6.5 min, and re-measured the same night at 406 s
 * (image pull + load; weights already on the volume). The old estimate allowed
 * a flat 90 s for it and so quoted three minutes against a real eight and a
 * half -- which is what made a working render look broken to someone
 * listening. 420 is an UPPER bound and the line that speaks it says "up to". */
const COLD_WAKE_S = parseInt(process.env.SCENEMA_COLD_WAKE_S || '420', 10);
/* THE FROZEN CARD (Part 123, Sep 4 2026). Her "hear this voice" sat 19½ minutes
 * at 01:39Z while RunPod's /health said `running: 1` the whole time -- so the
 * floor above doubled its grace ("a card is coming") and nothing gave up. The
 * card was not coming. RunPod kept RESUMING the same 4090 pod (850ilos9nijpmp)
 * that never came up: desiredStatus RUNNING, the job IN_QUEUE, inProgress 0,
 * and it BILLED -- 31 minutes on the Sep 4 statement for two renders that took
 * 30 s between them. Reproduced at 02:14Z with a fresh job; terminating that
 * pod by hand put a 5090 on the job inside a minute. A worker that is running
 * with a job in the queue and nothing in progress for this long is frozen:
 * terminate it (RunPod places a fresh one), once per job, then the floor. */
const ZOMBIE_MS = parseInt(process.env.SCENEMA_ZOMBIE_MS || String(4 * 60 * 1000), 10);
const RUNPOD_GQL = 'https://api.runpod.io/graphql';
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

/* ---------- what the endpoint is actually doing ----------
 * The difference between "the card is waking up" and "there is no card" is the
 * whole difference between waiting and wasting your evening, and until now
 * nothing asked. RunPod answers it on /health: `throttled` means it wants a
 * worker and cannot place one. Cached 15 s so a poll loop cannot hammer it. */
let capacity = { at: 0, ok: false, throttled: 0, idle: 0, initializing: 0, ready: 0, running: 0, unhealthy: 0, inQueue: 0, inProgress: 0 };
async function readCapacity() {
  if (Date.now() - capacity.at < 15000) return capacity;
  try {
    const r = await rp.get('/health');
    const w = r.data?.workers || {};
    const j = r.data?.jobs || {};
    capacity = {
      at: Date.now(), ok: true,
      throttled: w.throttled | 0, idle: w.idle | 0, initializing: w.initializing | 0,
      ready: w.ready | 0, running: w.running | 0, unhealthy: w.unhealthy | 0, inQueue: j.inQueue | 0, inProgress: j.inProgress | 0,
    };
  } catch (e) {
    capacity = { ...capacity, at: Date.now(), ok: false };
  }
  return capacity;
}

/* A frozen card: the endpoint says a worker is RUNNING, nothing is in
 * progress, and the job has sat in the queue past ZOMBIE_MS. A healthy worker
 * with the image cached takes a job in 70-160 s (measured Sep 3-4); a fresh
 * machine pulling the image shows as `initializing`, not `running`. */
function isZombie(cap, waitedMs) {
  return !!(cap && cap.ok && cap.running > 0 && !cap.initializing && !(cap.inProgress > 0) && waitedMs > ZOMBIE_MS);
}
async function listRunningPods() {
  const r = await axios.post(RUNPOD_GQL, { query: '{ myself { endpoints { id pods { id desiredStatus lastStatusChange machine { gpuDisplayName location } } } } }' },
    { headers: { Authorization: `Bearer ${RUNPOD_KEY}`, 'Content-Type': 'application/json', 'User-Agent': UA }, timeout: 20000 });
  const eps = r.data?.data?.myself?.endpoints || [];
  const ep = eps.find((e) => e.id === ENDPOINT_ID);
  return (ep?.pods || []).filter((p) => p.desiredStatus === 'RUNNING');
}
async function terminatePod(podId) {
  const r = await axios.post(RUNPOD_GQL, { query: `mutation { podTerminate(input:{podId:"${String(podId).replace(/[^A-Za-z0-9]/g, '')}"}) }` },
    { headers: { Authorization: `Bearer ${RUNPOD_KEY}`, 'Content-Type': 'application/json', 'User-Agent': UA }, timeout: 20000 });
  if (r.data?.errors?.length) throw new Error(r.data.errors[0].message);
}
/* Kick the frozen worker(s) off this endpoint. Returns the pods it killed. */
async function kickZombies() {
  const pods = await listRunningPods();
  const killed = [];
  for (const p of pods) {
    try { await terminatePod(p.id); killed.push({ id: p.id, gpu: p.machine?.gpuDisplayName, location: p.machine?.location, since: p.lastStatusChange }); }
    catch (e) { console.warn(`[scenema] terminate ${p.id} failed:`, e.message); }
  }
  capacity.at = 0; // force a fresh /health read on the next poll
  return killed;
}

function saySeconds(n) {
  n = Math.max(0, Math.round(n));
  const m = Math.floor(n / 60), s = n % 60;
  if (!m) return `${s} second${s === 1 ? '' : 's'}`;
  if (!s) return `${m} minute${m === 1 ? '' : 's'}`;
  return `${m} minute${m === 1 ? '' : 's'} ${s} seconds`;
}

/* The spoken line for a job that has not finished. Said on every poll, because
 * silence is what a screen reader turns into "this app is broken". */
function waitInfo(job, cap) {
  const submitted = Date.parse(job.submittedAt || job.createdAt) || Date.now();
  const waitedS = Math.max(0, Math.round((Date.now() - submitted) / 1000));
  const clockFrom = job.kickedAt ? Date.parse(job.kickedAt) : submitted;
  const leftS = Math.max(0, Math.round(QUEUE_TIMEOUT_MS / 1000 - (Date.now() - clockFrom) / 1000));
  if (job.state === 'running' || job.startedAt) {
    return { phase: 'rendering', waitedS, spoken: `Rendering now. ${saySeconds(waitedS)} in.` };
  }
  const giveUp = leftS > 0
    ? ` I give up in ${saySeconds(leftS)} if nothing comes free.`
    : ' Giving up now.';
  if (job.kickedAt) {
    const sinceKickS = Math.max(0, Math.round((Date.now() - Date.parse(job.kickedAt)) / 1000));
    return { phase: 'restarted-card', waitedS, spoken: `The graphics card froze without taking the job, so I restarted it. Waiting for a fresh one. ${saySeconds(sinceKickS)} since the restart, ${saySeconds(waitedS)} in all.${giveUp}` };
  }
  if (isZombie(cap, waitedS * 1000)) {
    return { phase: 'stuck-card', waitedS, spoken: `A graphics card is up but has not taken the job. That is not normal. ${saySeconds(waitedS)} so far. Restarting it now.` };
  }
  if (cap.ok && cap.running > 0 && !cap.initializing && !(cap.inProgress > 0)) {
    return { phase: 'loading', waitedS, spoken: `Got a card. It is loading the voice models, which takes a minute or two. ${saySeconds(waitedS)} so far.${giveUp}` };
  }
  if (cap.ok && cap.throttled > 0 && !cap.initializing && !cap.ready && !cap.idle && !cap.running) {
    return { phase: 'no-card', waitedS, spoken: `Still waiting for a graphics card. None are free right now, so nothing has started. ${saySeconds(waitedS)} so far.${giveUp}` };
  }
  if (cap.ok && cap.initializing > 0) {
    return { phase: 'waking', waitedS, spoken: `Got a card. It is waking up, which takes about six minutes. ${saySeconds(waitedS)} so far.${giveUp}` };
  }
  return { phase: 'queued', waitedS, spoken: `Queued, waiting for a card. ${saySeconds(waitedS)} so far.${giveUp}` };
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
    /* Part 122. A long script is rendered in PARTS and joined by the fork into
     * one recording. A part is not a thing she made -- it is a slice of one --
     * so it must not land in My Creations on its own, or a four-part story
     * fills her gallery with five files and only one of them is the story.
     * Spend is still logged; only the gallery row is skipped. */
    suppressAsset: options.suppressAsset === true,
  };
  jobs.push(job); saveJobs();
  // words → a rough length estimate for the caller: ~2.6 words/s spoken, render ≈ 1.4× that at bf16
  const words = prompt.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  const estAudioS = Math.round(words / 2.6);
  /* TWO numbers, not one. The old single figure buried a 6-minute cold wake in
   * a flat 90-second allowance, so a warm render came back early and a cold one
   * ran three times past its own promise with nothing said. Quote both and let
   * the caller say which is which. */
  const estWarmS = Math.round(estAudioS * 1.4) + 15;
  const estColdS = estWarmS + COLD_WAKE_S;
  /* Part 123: the caller may hand us what the endpoint looked like a moment
   * ago, so the promise names WHICH case she is in instead of both. "Minutes
   * and minutes" of a preview that was quoted as a penny is what made her
   * press Stop; a true sentence up front is the cheapest fix there is. */
  const cap = options.capacity && options.capacity.ok ? options.capacity : null;
  const cardAwake = !!(cap && (cap.idle > 0 || cap.ready > 0 || (cap.running > 0 && cap.inProgress > 0)));
  const cardLoading = !!(cap && !cardAwake && (cap.initializing > 0 || cap.running > 0));
  const spokenWait = cardAwake
    ? `A card is awake, so about ${saySeconds(estWarmS)}.`
    : cardLoading
      ? `A card is waking up. About ${saySeconds(estWarmS + 120)}, up to ${saySeconds(estColdS)} if it is a slow boot.`
      : cap && cap.throttled > 0
        ? `No card is free right now, so this will wait for one. Up to ${saySeconds(estColdS)} once one comes free, and I give up after ${saySeconds(QUEUE_TIMEOUT_MS / 1000)} if none does.`
        : `About ${saySeconds(estWarmS)} if a card is already awake, or up to ${saySeconds(estColdS)} if one has to wake up first.`;
  job.estimate = {
    words, audioSeconds: estAudioS,
    renderSeconds: cardAwake ? estWarmS : estColdS, renderSecondsWarm: estWarmS, renderSecondsCold: estColdS,
    cardAwake, cardLoading,
    costUSD: Math.round((estWarmS / 3600 * RATE_PER_HR + (cardAwake ? 0 : WAKE_USD)) * 1000) / 1000,
    spokenWait,
  };
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
      /* THE FLOOR. Still queued, no card has picked it up, and the clock has
       * run out: stop waiting and SAY SO. Nothing was charged, because RunPod
       * bills worker seconds and this job never got a worker. Giving up also
       * releases the one-render-at-a-time lock, which a stuck job used to hold
       * for as long as it sat there — so a dead queue used to lock her out of
       * starting a fresh one, on top of saying nothing. */
      if (!job.startedAt && (job.state === 'queued' || s.status === 'IN_QUEUE')) {
        const submitted = Date.parse(job.submittedAt || job.createdAt) || Date.now();
        const waitedMs = Date.now() - submitted;
        /* A card that is BOOTING is not a dead queue. Measured Sep 3: submit to
         * first byte of work was 6 m 52 s on a cold wake, which leaves barely
         * three minutes under a ten-minute timer — so the floor would sometimes
         * shoot a render that was about to work. While the endpoint reports a
         * worker initializing, ready or running, the wait is EARNED and the
         * grace doubles; the timer only bites when nothing is coming. */
        const capNow = await readCapacity();
        /* THE FROZEN CARD. Running, nothing in progress, job still queued past
         * ZOMBIE_MS: terminate the worker so RunPod places a fresh one. Once
         * per job; the give-up clock restarts at the kick. */
        if (!job.kickedAt && isZombie(capNow, waitedMs)) {
          let killed = [];
          try { killed = await kickZombies(); } catch (e) { console.warn('[scenema] kick failed:', e.message); }
          job.kickedAt = new Date().toISOString();
          job.kicked = killed;
          saveJobs();
          receipt({ jobId: job.id, userId: job.userId, state: 'kicked-frozen-worker', waitedS: Math.round(waitedMs / 1000), killed, costUSD: 0 });
          console.warn(`[scenema] ${job.id} frozen worker after ${Math.round(waitedMs / 1000)}s queued (running=${capNow.running} inProgress=${capNow.inProgress}); terminated ${killed.map((k) => `${k.id} ${k.gpu || ''}`).join(', ') || 'nothing (no RUNNING pod found)'}`);
          continue;
        }
        const sinceKickMs = job.kickedAt ? Date.now() - Date.parse(job.kickedAt) : null;
        /* A worker that is `running` only counts as "coming" while it is doing
         * something -- a frozen one is exactly what the old rule waited 20
         * minutes for. */
        const cardComing = capNow.ok && (capNow.initializing > 0 || capNow.ready > 0 || capNow.idle > 0 || (capNow.running > 0 && capNow.inProgress > 0));
        const limitMs = cardComing ? QUEUE_TIMEOUT_MS * 2 : QUEUE_TIMEOUT_MS;
        const clockMs = sinceKickMs !== null ? sinceKickMs : waitedMs;
        if (clockMs > limitMs || (job.kickedAt && isZombie(capNow, sinceKickMs))) {
          const cap = capNow;
          await cancel(job.runpodId);
          const mins = Math.round(waitedMs / 60000);
          job.state = 'failed';
          job.gaveUp = true;
          job.error = job.kickedAt
            ? `A graphics card took the job and froze, twice. I stopped after ${mins} minutes. Nothing was charged for the render itself. Try again in a few minutes; if it happens again, the card provider is having a bad night.`
            : cap.ok && cap.throttled > 0
              ? `No graphics card came free in ${mins} minutes — the datacentre is full right now. Nothing was charged. Try again in a few minutes.`
              : `This render waited ${mins} minutes and no graphics card picked it up. Nothing was charged. Try again.`;
          job.finishedAt = new Date().toISOString();
          saveJobs();
          receipt({ jobId: job.id, userId: job.userId, state: 'gave-up', error: job.error, waitedS: Math.round(waitedMs / 1000), throttled: cap.throttled, kicked: !!job.kickedAt, costUSD: 0 });
          console.warn(`[scenema] ${job.id} gave up after ${mins}m unplaced (throttled=${cap.throttled})`);
          await notifyFail(job);
          continue;
        }
      }
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
        if (!job.suppressAsset) {
          await postAsset({ userId: job.userId, url: out.url, prompt: job.prompt, costUSD, metadata: { jobId: job.id, durationS: out.duration_s, seed: out.seed, hasReference: job.hasReference, b2Key: out.key, agent: job.agentName, engine: 'scenema-audio' } });
        }
        /* A part does not buzz her phone -- the fork does that once, after the
         * parts are joined. Five pushes for one story is not five times the
         * good news. */
        try {
          if (job.suppressAsset) { continue; }
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
  app.post('/audio/scenema/start', express.json({ limit: '64kb' }), async (req, res) => {
    if (!authOk(req, req.body?.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const b = req.body || {};
    let capacity = null;
    try { capacity = await readCapacity(); } catch (_) {}
    const r = makeJob({ userId: b.userId, agentId: b.agentId, agentName: b.agentName, prompt: b.prompt, options: { ...b, capacity } });
    return res.status(r.error ? 400 : 200).json(r);
  });

  /* GET /audio/scenema/status?jobId=… (or ?userId=… for that user's latest) */
  app.get('/audio/scenema/status', async (req, res) => {
    if (!authOk(req, req.query?.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const { jobId, userId } = req.query || {};
    let job = jobId ? jobs.find((j) => j.id === String(jobId)) : null;
    if (!job && userId) job = [...jobs].reverse().find((j) => j.userId === String(userId));
    if (!job) return res.status(404).json({ error: 'no such job' });
    const { prompt, ...rest } = job;
    /* An unfinished job now carries WHY it is unfinished and how long it has
     * been that way, so the caller has a true sentence to speak on every poll
     * instead of one line at the start and then silence. */
    let wait = null;
    if (job.state === 'queued' || job.state === 'running') {
      const cap = await readCapacity();
      wait = waitInfo(job, cap);
      wait.capacity = { throttled: cap.throttled, initializing: cap.initializing, ready: cap.ready, running: cap.running, inProgress: cap.inProgress, ok: cap.ok };
      wait.giveUpAfterS = Math.round(QUEUE_TIMEOUT_MS / 1000);
    }
    return res.json({ ...rest, wait, promptPreview: prompt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) });
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
      queueTimeoutS: Math.round(QUEUE_TIMEOUT_MS / 1000), coldWakeS: COLD_WAKE_S, zombieS: Math.round(ZOMBIE_MS / 1000),
      capacity: { ...capacity, ageS: capacity.at ? Math.round((now - capacity.at) / 1000) : null },
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

module.exports = { attachScenema, makeJob, _internals: { capsExceeded, spendSince, waitInfo, saySeconds, isZombie, QUEUE_TIMEOUT_MS, COLD_WAKE_S, ZOMBIE_MS } };
