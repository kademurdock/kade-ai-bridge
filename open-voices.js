'use strict';
/* open-voices.js — VoxCPM2 and Ming voices on RunPod serverless (Nov 15 2026).
 *
 * Two open voice engines for the Sound Booth, with one job shape (worker voxcpm_contract.py and
 * ming_contract.py in F:/KadeAI-work/{voxcpm,ming}-20261115/worker):
 *   design: description + text, no clip. A new voice from words; every try is a new seed.
 *   clone:  reference_voice_url (our own B2 storage only) + text, optional style and prompt_text
 *           (the clip's exact words, clip at most 30 s).
 *   seed, text up to 5000 characters. Output { url, wav_url, duration_seconds, sample_rate, mode,
 *   seed, engine, key, wav_key, ... } or { error }.
 * The two workers name the two quality knobs differently (VoxCPM2 cfg_value / inference_timesteps,
 * Ming cfg_scale / flow_steps); the fork sends neither today, and `cfg` / `steps` map to each.
 *
 * Same pattern as scenema.js: RunPod /run, the bridge polls /status, the finished take lands in the
 * user's My Creations through the fork's asset lane (which mirrors it to our storage for good) and
 * its GPU time through the usage lane. Jobs and receipts live on the volume.
 *
 * Env: RUNPOD_API_KEY · VOXCPM_ENDPOINT_ID (default dewjq1ibxkp2c3) · MING_ENDPOINT_ID (no default;
 * unset = Ming is hidden and refused) · VOXCPM_RATE_PER_HR / MING_RATE_PER_HR (default 1.75) ·
 * OPEN_VOICES_DAILY_CAP_USD (1.00) / OPEN_VOICES_MONTHLY_CAP_USD (20) · OPEN_VOICES_QUEUE_TIMEOUT_MS
 * (15 min; Ming gets twice that) · OPEN_VOICES_AUDIO_HOSTS (extra storage hosts, comma list) ·
 * OPEN_VOICES_ENABLED=0 switches the lane off.
 *
 * Routes (bridge secret): POST /audio/open-voices/start, GET /audio/open-voices/status,
 * POST /audio/open-voices/cancel, GET /audio/open-voices/health. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SEED_MAX = 2147483647;
const MAX_TEXT = 5000;
const MAX_PROMPT_TEXT = 1000;
const RING = 200;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ENGINES = {
  voxcpm: {
    id: 'voxcpm', label: 'VoxCPM2', model: 'openbmb/VoxCPM2', service: 'voxcpm_audio',
    endpointEnv: 'VOXCPM_ENDPOINT_ID', defaultEndpoint: 'dewjq1ibxkp2c3', rateEnv: 'VOXCPM_RATE_PER_HR',
    maxPrefix: 400, cfg: { name: 'cfg_value', min: 0.5, max: 5 }, steps: { name: 'inference_timesteps', min: 4, max: 50 },
    queueFactor: 1,
  },
  ming: {
    id: 'ming', label: 'Ming', model: 'inclusionAI/Ming-3.0-tts', service: 'ming_audio',
    endpointEnv: 'MING_ENDPOINT_ID', defaultEndpoint: '', rateEnv: 'MING_RATE_PER_HR',
    maxPrefix: 600, cfg: { name: 'cfg_scale', min: 1, max: 5 }, steps: { name: 'flow_steps', min: 4, max: 50 },
    queueFactor: 2,
  },
};

const freshSeed = () => crypto.randomInt(1, SEED_MAX);
const oneLine = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/* Our own storage only: https, no user info, the default port, and a Backblaze B2 host (or one
 * named in OPEN_VOICES_AUDIO_HOSTS). The workers check the same thing against their own bucket. */
function ourClip(url, env = process.env) {
  if (typeof url !== 'string' || url.length > 4096) return false;
  let u;
  try { u = new URL(url.trim()); } catch (_) { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  const extra = String(env.OPEN_VOICES_AUDIO_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return extra.includes(host) || /^([a-z0-9-]+\.)*s3\.[a-z0-9-]+\.backblazeb2\.com$/.test(host);
}

function endpointOf(engine, env = process.env) {
  const e = ENGINES[engine];
  if (!e) return '';
  const raw = String(env[e.endpointEnv] || e.defaultEndpoint || '').trim();
  return /^[a-z0-9]{6,40}$/i.test(raw) ? raw : '';
}

/* A booth request -> the worker's input, or { error } in a plain sentence. */
function buildInput(engine, b = {}, env = process.env) {
  const e = ENGINES[engine];
  if (!e) return { error: 'Pick VoxCPM2 or Ming.' };
  const mode = b.mode === 'speak' ? 'clone' : b.mode;
  if (mode !== 'design' && mode !== 'clone') return { error: 'Choose Design a voice or Speak with a voice.' };
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) return { error: 'Type the words to say.' };
  if (text.length > MAX_TEXT) return { error: `The words are too long. The most is ${MAX_TEXT} characters.` };
  const input = { mode, text };
  if (mode === 'design') {
    const description = oneLine(b.description);
    if (!description) return { error: 'Describe the voice first.' };
    if (description.length > e.maxPrefix) return { error: `The description is too long. The most is ${e.maxPrefix} characters.` };
    input.description = description;
  } else {
    const url = typeof b.reference_voice_url === 'string' ? b.reference_voice_url.trim() : '';
    if (!url) return { error: 'Pick a saved voice or a clip first.' };
    if (!ourClip(url, env)) return { error: 'That clip is not stored with the platform. Import it again.' };
    input.reference_voice_url = url;
    const style = oneLine(b.style);
    if (style.length > e.maxPrefix) return { error: `The style is too long. The most is ${e.maxPrefix} characters.` };
    if (style) input.style = style;
    const promptText = oneLine(b.prompt_text);
    if (promptText.length > MAX_PROMPT_TEXT) return { error: `The clip's words are too long. The most is ${MAX_PROMPT_TEXT} characters.` };
    if (promptText) input.prompt_text = promptText;
  }
  /* Every try is a new take: a fresh seed, unless she typed one. */
  const typed = b.seed;
  const seed = typeof typed === 'string' && /^\d+$/.test(typed.trim()) ? Number(typed.trim()) : typed;
  if (seed !== undefined && seed !== null && seed !== '') {
    if (!Number.isInteger(seed) || seed < 0 || seed > SEED_MAX) return { error: `The voice number must be a whole number from 0 to ${SEED_MAX}.` };
    input.seed = seed;
  } else input.seed = freshSeed();
  if (typeof b.cfg === 'number' && b.cfg >= e.cfg.min && b.cfg <= e.cfg.max) input[e.cfg.name] = b.cfg;
  if (Number.isInteger(b.steps) && b.steps >= e.steps.min && b.steps <= e.steps.max) input[e.steps.name] = b.steps;
  if (typeof b.normalize === 'boolean') input.normalize = b.normalize;
  return { input };
}

function saySeconds(n) {
  n = Math.max(0, Math.round(n));
  const m = Math.floor(n / 60), s = n % 60;
  if (!m) return `${s} second${s === 1 ? '' : 's'}`;
  if (!s) return `${m} minute${m === 1 ? '' : 's'}`;
  return `${m} minute${m === 1 ? '' : 's'} ${s} seconds`;
}

/* A worker that is idle, ready or busy answers in seconds; anything else may mean a cold start. */
function coldLikely(cap) {
  if (!cap || !cap.ok) return true;
  return !(cap.idle > 0 || cap.ready > 0 || cap.running > 0);
}

function createOpenVoices({ env = process.env, http, dataDir, now = () => Date.now() } = {}) {
  if (!http) http = require('axios');
  const DATA_DIR = dataDir || env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir();
  const JOBS_FILE = path.join(DATA_DIR, 'open-voices-jobs.json');
  const RECEIPTS_FILE = path.join(DATA_DIR, 'open-voices-receipts.jsonl');
  const ENABLED = env.OPEN_VOICES_ENABLED !== '0';
  const KEY = env.RUNPOD_API_KEY || '';
  const DAILY_CAP = parseFloat(env.OPEN_VOICES_DAILY_CAP_USD || '1.00');
  const MONTHLY_CAP = parseFloat(env.OPEN_VOICES_MONTHLY_CAP_USD || '20');
  const QUEUE_TIMEOUT_MS = parseInt(env.OPEN_VOICES_QUEUE_TIMEOUT_MS || String(15 * 60 * 1000), 10);
  const FORK_URL = (env.FORK_USAGE_URL || env.LIBRECHAT_URL || 'https://kademurdock.com').replace(/\/$/, '');
  const USAGE_SECRET = env.KADE_USAGE_EVENT_SECRET || '';
  const rate = (engine) => parseFloat(env[ENGINES[engine].rateEnv] || '1.75');
  const headers = () => ({ Authorization: `Bearer ${KEY}`, 'User-Agent': UA });
  const base = (engine) => `https://api.runpod.ai/v2/${endpointOf(engine, env)}`;
  const ready = (engine) => !!(ENABLED && KEY && endpointOf(engine, env));

  let jobs = [];
  try { jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); if (!Array.isArray(jobs)) jobs = []; } catch (_) { jobs = []; }
  const save = () => {
    try { if (jobs.length > RING) jobs = jobs.slice(-RING); fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs)); } catch (e) { console.warn('[open-voices] jobs save failed:', e.message); }
  };
  const receipt = (line) => { try { fs.appendFileSync(RECEIPTS_FILE, JSON.stringify({ at: new Date(now()).toISOString(), ...line }) + '\n'); } catch (_) {} };
  function spendSince(sinceMs) {
    let total = 0;
    try {
      for (const l of fs.readFileSync(RECEIPTS_FILE, 'utf8').split('\n').filter(Boolean)) {
        try { const r = JSON.parse(l); if (Date.parse(r.at) >= sinceMs && typeof r.costUSD === 'number') total += r.costUSD; } catch (_) {}
      }
    } catch (_) {}
    return total;
  }
  function capsExceeded() {
    const t = now();
    if (spendSince(t - 86400000) >= DAILY_CAP) return `Today's open voice budget ($${DAILY_CAP.toFixed(2)}) is used up.`;
    if (spendSince(t - 30 * 86400000) >= MONTHLY_CAP) return `This month's open voice budget ($${MONTHLY_CAP.toFixed(2)}) is used up.`;
    return null;
  }

  const capacity = {};
  async function readCapacity(engine) {
    const c = capacity[engine];
    if (c && now() - c.at < 15000) return c;
    let next;
    try {
      const r = await http.get(`${base(engine)}/health`, { headers: headers(), timeout: 10000 });
      const w = (r.data && r.data.workers) || {};
      const j = (r.data && r.data.jobs) || {};
      next = { at: now(), ok: true, idle: w.idle | 0, ready: w.ready | 0, running: w.running | 0, initializing: w.initializing | 0,
        throttled: w.throttled | 0, inQueue: j.inQueue | 0, inProgress: j.inProgress | 0 };
    } catch (_) { next = { at: now(), ok: false }; }
    capacity[engine] = next;
    return next;
  }

  async function postUsage(job, seconds, costUSD) {
    if (!USAGE_SECRET) return;
    try {
      await http.post(`${FORK_URL}/api/kade/usage-event`, { secret: USAGE_SECRET, userId: job.userId, service: ENGINES[job.engine].service,
        quantity: Math.max(1, Math.round(seconds)), unit: 'seconds', costUSD, metadata: { jobId: job.id, engine: job.engine, mode: job.mode } },
      { headers: { 'User-Agent': UA }, timeout: 10000 });
    } catch (e) { console.warn('[open-voices] usage post failed:', e.message); }
  }
  async function postAsset(job, out, costUSD) {
    if (!USAGE_SECRET) return;
    const e = ENGINES[job.engine];
    const prompt = job.mode === 'design' ? `${job.description}\n\n${job.text}` : job.text;
    try {
      await http.post(`${FORK_URL}/api/kade/asset-event`, { secret: USAGE_SECRET, userId: job.userId, kind: 'audio', service: e.service,
        url: out.url, prompt, model: e.model, costUSD,
        metadata: { jobId: job.id, openVoice: { engine: job.engine, mode: job.mode, seed: out.seed, description: job.description || undefined,
          style: job.style || undefined, words: job.text.slice(0, 1000), seconds: out.duration_seconds },
        durationS: out.duration_seconds, seed: out.seed, b2Key: out.key, wavUrl: out.wav_url, wavKey: out.wav_key, engine: e.label, agent: 'Sound Booth' } },
      { headers: { 'User-Agent': UA }, timeout: 15000 });
    } catch (err) { console.warn('[open-voices] asset post failed:', err.message); }
  }

  async function start(b = {}) {
    const engine = String(b.engine || '');
    if (!ENGINES[engine]) return { error: 'Pick VoxCPM2 or Ming.' };
    if (!ENABLED) return { error: 'The open voices are switched off right now.' };
    if (!KEY || !endpointOf(engine, env)) return { error: `${ENGINES[engine].label} is not set up yet.` };
    const userId = String(b.userId || '').trim();
    if (!userId) return { error: 'userId required' };
    const built = buildInput(engine, b, env);
    if (built.error) return built;
    const capMsg = capsExceeded();
    if (capMsg) return { error: capMsg };
    const open = jobs.find((j) => j.userId === userId && (j.state === 'queued' || j.state === 'running'));
    if (open) return { error: 'One take at a time. The last one is still being made.', jobId: open.id };
    const cap = await readCapacity(engine);
    const input = { ...built.input, out_prefix: userId };
    const job = { id: `ov_${now().toString(36)}${crypto.randomBytes(3).toString('hex')}`, userId, engine, mode: input.mode,
      text: input.text, description: input.description || '', style: input.style || '', seed: input.seed,
      hasPromptText: !!input.prompt_text, state: 'queued', createdAt: new Date(now()).toISOString(), runpodId: null,
      coldLikely: coldLikely(cap), result: null, error: null, costUSD: null };
    try {
      const r = await http.post(`${base(engine)}/run`, { input }, { headers: headers(), timeout: 30000 });
      job.runpodId = r.data && r.data.id;
      if (!job.runpodId) throw new Error('no job id');
      job.submittedAt = new Date(now()).toISOString();
      if (r.data.status === 'IN_PROGRESS') { job.state = 'running'; job.startedAt = job.submittedAt; }
    } catch (e) {
      console.warn(`[open-voices] ${engine} submit failed:`, e.message);
      return { error: `${ENGINES[engine].label} did not take the job. Nothing was made. Try again.` };
    }
    jobs.push(job); save();
    console.log(`[open-voices] ${job.id} ${engine} ${job.mode} submitted -> runpod ${job.runpodId} (${job.text.length} chars, cold=${job.coldLikely})`);
    return { ok: true, jobId: job.id, engine, mode: job.mode, seed: job.seed, coldLikely: job.coldLikely };
  }

  async function pollOne(job) {
    let s;
    try {
      const r = await http.get(`${base(job.engine)}/status/${job.runpodId}`, { headers: headers(), timeout: 20000 });
      s = r.data || {};
    } catch (e) { console.warn(`[open-voices] status ${job.id}:`, e.message); return; }
    if (job.state === 'cancelled') return;
    if (s.status === 'IN_PROGRESS' && job.state !== 'running') { job.state = 'running'; job.startedAt = new Date(now()).toISOString(); save(); }
    if (s.status === 'IN_QUEUE' && !job.startedAt) {
      const waited = now() - Date.parse(job.submittedAt || job.createdAt);
      if (waited > QUEUE_TIMEOUT_MS * ENGINES[job.engine].queueFactor) {
        try { await http.post(`${base(job.engine)}/cancel/${job.runpodId}`, {}, { headers: headers(), timeout: 20000 }); } catch (_) {}
        job.state = 'failed'; job.finishedAt = new Date(now()).toISOString();
        job.error = `The voice engine did not start in ${saySeconds(waited / 1000)}. Nothing was made. Try again later.`;
        receipt({ jobId: job.id, userId: job.userId, engine: job.engine, state: 'gave-up', costUSD: 0 }); save();
      }
      return;
    }
    const cost = Math.round(((s.executionTime || 0) / 3600000 * rate(job.engine)) * 10000) / 10000;
    if (s.status === 'COMPLETED') {
      const out = s.output || {};
      if (out.error || !out.url) {
        job.state = 'failed'; job.error = String(out.error || 'The voice engine sent back no recording.').slice(0, 300);
        job.finishedAt = new Date(now()).toISOString(); job.costUSD = cost;
        receipt({ jobId: job.id, userId: job.userId, engine: job.engine, state: 'failed', costUSD: cost }); save();
        return;
      }
      job.state = 'done'; job.finishedAt = new Date(now()).toISOString(); job.costUSD = cost;
      job.result = { url: out.url, wavUrl: out.wav_url, seconds: out.duration_seconds, seed: out.seed, sampleRate: out.sample_rate,
        mode: out.mode, engine: out.engine, cold: (s.delayTime || 0) > 45000, executionS: Math.round((s.executionTime || 0) / 100) / 10 };
      receipt({ jobId: job.id, userId: job.userId, engine: job.engine, state: 'done', seconds: out.duration_seconds, costUSD: cost }); save();
      await postUsage(job, out.duration_seconds || 1, cost);
      await postAsset(job, out, cost);
    } else if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(s.status)) {
      job.state = 'failed'; job.finishedAt = new Date(now()).toISOString(); job.costUSD = cost;
      job.error = s.status === 'TIMED_OUT' ? 'The voice engine ran out of time. Nothing was made.' : 'The voice engine stopped. Nothing was made.';
      receipt({ jobId: job.id, userId: job.userId, engine: job.engine, state: 'failed', costUSD: cost }); save();
    }
  }

  let pumping = false;
  async function pump() {
    if (pumping) return; pumping = true;
    try { for (const job of jobs) if ((job.state === 'queued' || job.state === 'running') && job.runpodId) await pollOne(job); }
    finally { pumping = false; }
  }

  function view(job) {
    const { text, runpodId, ...rest } = job;
    let wait = null;
    if (job.state === 'queued' || job.state === 'running') {
      const waitedS = Math.max(0, Math.round((now() - Date.parse(job.submittedAt || job.createdAt)) / 1000));
      wait = { waitedS, spoken: job.state === 'running' ? `Speaking now. ${saySeconds(waitedS)} in.` : `Waiting for the voice engine. ${saySeconds(waitedS)} so far.` };
    }
    return { ...rest, words: text.slice(0, 160), wait };
  }

  async function cancelJob(jobId, userId) {
    const job = jobs.find((j) => j.id === String(jobId || '') && (!userId || j.userId === String(userId)));
    if (!job) return { status: 404, body: { error: 'no such job' } };
    if (!['queued', 'running'].includes(job.state)) return { status: 200, body: { ok: true, state: job.state } };
    try { await http.post(`${base(job.engine)}/cancel/${job.runpodId}`, {}, { headers: headers(), timeout: 20000 }); }
    catch (e) { return { status: 502, body: { error: 'The voice engine did not confirm Stop. Try Stop again.' } }; }
    job.state = 'cancelled'; job.finishedAt = new Date(now()).toISOString(); save();
    return { status: 200, body: { ok: true, state: 'cancelled' } };
  }

  function health() {
    return {
      enabled: ENABLED,
      engines: Object.fromEntries(Object.keys(ENGINES).map((k) => [k, { label: ENGINES[k].label, configured: ready(k), endpointId: endpointOf(k, env) || null }])),
      caps: { dailyUSD: DAILY_CAP, monthlyUSD: MONTHLY_CAP },
      spend: { dayUSD: spendSince(now() - 86400000), monthUSD: spendSince(now() - 30 * 86400000) },
      open: jobs.filter((j) => j.state === 'queued' || j.state === 'running').length,
    };
  }

  return { start, pump, view, cancelJob, health, ready, readCapacity, find: (id) => jobs.find((j) => j.id === String(id)),
    latest: (userId) => [...jobs].reverse().find((j) => j.userId === String(userId)), _jobs: () => jobs };
}

function attachOpenVoices(app, d = {}, opts = {}) {
  const express = require('express');
  const lane = createOpenVoices(opts);
  const authOk = (req, provided) => !!((d.bridgeSecretOk && d.bridgeSecretOk(req, provided)) || (d.notifySecretOk && d.notifySecretOk(req, provided)));
  let timer = null;
  const kick = () => {
    if (timer) return;
    timer = setInterval(() => {
      lane.pump().catch((e) => console.warn('[open-voices] pump:', e.message)).then(() => {
        if (!lane._jobs().some((j) => j.state === 'queued' || j.state === 'running')) { clearInterval(timer); timer = null; }
      });
    }, parseInt((opts.env || process.env).OPEN_VOICES_POLL_MS || '4000', 10));
    if (timer.unref) timer.unref();
  };

  app.post('/audio/open-voices/start', express.json({ limit: '64kb' }), async (req, res) => {
    if (!authOk(req, req.body && req.body.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const r = await lane.start(req.body || {});
    if (r.ok) kick();
    return res.status(r.error ? 400 : 200).json(r);
  });
  app.get('/audio/open-voices/status', (req, res) => {
    if (!authOk(req, req.query && req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const { jobId, userId } = req.query || {};
    const job = jobId ? lane.find(jobId) : userId ? lane.latest(userId) : null;
    if (!job || (userId && job.userId !== String(userId))) return res.status(404).json({ error: 'no such job' });
    if (job.state === 'queued' || job.state === 'running') kick();
    res.setHeader('Cache-Control', 'no-store');
    return res.json(lane.view(job));
  });
  app.post('/audio/open-voices/cancel', express.json({ limit: '8kb' }), async (req, res) => {
    if (!authOk(req, req.body && req.body.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const r = await lane.cancelJob(req.body && req.body.jobId, req.body && req.body.userId);
    return res.status(r.status).json(r.body);
  });
  app.get('/audio/open-voices/health', (req, res) => {
    if (!(d.bridgeSecretOk && d.bridgeSecretOk(req, req.query && req.query.secret))) return res.status(403).json({ error: 'Unauthorized' });
    return res.json(lane.health());
  });
  if (lane._jobs().some((j) => j.state === 'queued' || j.state === 'running')) kick();
  const h = lane.health();
  console.log(`[open-voices] lane ${h.enabled ? 'on' : 'OFF'}: ${Object.entries(h.engines).map(([k, v]) => `${k}=${v.configured ? v.endpointId : 'unset'}`).join(' ')}`);
  return lane;
}

module.exports = { attachOpenVoices, createOpenVoices, buildInput, ourClip, endpointOf, coldLikely, saySeconds, ENGINES, SEED_MAX };
