'use strict';
/**
 * NVDA Agent, folded into the bridge (Kade's choice, Aug 14 2026).
 *
 * Starts her own relay inside the bridge process, manages driver runs, and
 * exposes secret-gated control endpoints. ADDITIVE and FAIL-SOFT by design: the
 * relay start and every handler are wrapped so a fault here can never touch the
 * phone / notify paths that share this process. Kill switch NVDA_AGENT_ENABLED=0.
 *
 * Flow: an agent (Forge/Kiana) or a caller POSTs /nvda/start with a goal. We
 * mint a channel key and connect the driver (master) to the relay. Kade points
 * her PC's classic NVDA Remote add-on at the relay (Client -> allow this machine
 * to be controlled) with that key. When her PC joins, the driver loop begins,
 * narrating through the character, gating destructive steps to /nvda/confirm,
 * and saving a transcript on the volume.
 *
 * Endpoints (all require BRIDGE_SECRET via deps.bridgeSecretOk):
 *   POST /nvda/start     { goal, userId } -> { runId, channelKey, connect }
 *   POST /nvda/confirm   { runId, approve }
 *   POST /nvda/stop      { runId }
 *   GET  /nvda/status    ?runId=   -> live status + last spoken lines
 *   GET  /nvda/transcript?runId=   -> the receipt
 */

const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { NvdaRelay } = require('./relay/relay');
const { NvdaRemoteClient } = require('./client');
const { Observer } = require('./agent/observer');
const { Recorder } = require('./agent/recorder');
const { Safety } = require('./agent/safety');
const { Actions } = require('./agent/actions');
const { runAgentLoop } = require('./agent/brain');
const { ModelRouter } = require('./agent/models');
const { makeModelBrain } = require('./agent/model_adapter');
const { Memory } = require('./agent/memory');
const { chordToKeyEvents } = require('./agent/keymap');

const VOL = process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir();
const RELAY_PORT = parseInt(process.env.NVDA_RELAY_PORT, 10) || 6837;
const RELAY_HOST = process.env.NVDA_RELAY_HOST || '0.0.0.0';
// Set after the Railway TCP proxy exists so the connect words are exact:
const PUBLIC_HOST = process.env.NVDA_RELAY_PUBLIC_HOST || '(your relay host — set NVDA_RELAY_PUBLIC_HOST)';
const PUBLIC_PORT = process.env.NVDA_RELAY_PUBLIC_PORT || RELAY_PORT;
// Railway ties a service's web PORT to its TCP-proxy port, so a raw-TCP relay
// can't live in the bridge service. The relay runs as its OWN service; the
// bridge does NOT start one in-process, and the driver dials the external relay.
const IN_PROCESS = process.env.NVDA_RELAY_IN_PROCESS !== '0';
const CONNECT_HOST = process.env.NVDA_RELAY_CONNECT_HOST || '127.0.0.1';
const CONNECT_PORT = parseInt(process.env.NVDA_RELAY_CONNECT_PORT, 10) || RELAY_PORT;
const MAX_STEPS = parseInt(process.env.NVDA_MAX_STEPS, 10) || 60;
const enabled = () => process.env.NVDA_AGENT_ENABLED !== '0';

function tryRequire(m) { try { return require(m); } catch { return null; } }

function attachNvdaAgent(app, deps = {}) {
  if (!enabled()) { console.log('[nvda] disabled (NVDA_AGENT_ENABLED=0)'); return { enabled: false }; }
  const bridgeSecretOk = deps.bridgeSecretOk || (() => false);
  /* Aug 14 2026 — SCOPED TOOL SECRET. The fork's kade_drive_pc tool (Kiana +
   * Forge, hard-gated to Kade's own seat) needs these routes without holding
   * the admin BRIDGE_SECRET — same pattern as NOTIFY_AGENT_SECRET on /notify.
   * NVDA_TOOL_SECRET unlocks ONLY the /nvda lane: start/see/confirm/stop and
   * supervised keys, all of which still ride the driver's own safety rails
   * (NVDA+Q block, password guard, pacing caps, confirm-before-commit).
   * Unset = the scoped path is off and BRIDGE_SECRET remains the only door. */
  const nvdaSecretOk = (req, provided) => {
    if (bridgeSecretOk(req, provided)) return true;
    const scoped = process.env.NVDA_TOOL_SECRET;
    if (!scoped) return false;
    return provided === scoped || (req.get && req.get('x-nvda-secret') === scoped);
  };
  const runNotify = deps.runNotify || null;
  const express = tryRequire('express');
  const jsonMw = deps.json || (express ? express.json({ limit: '16kb' }) : (req, _res, next) => next());

  let relay = null;
  if (IN_PROCESS) {
    try {
      relay = new NvdaRelay({ port: RELAY_PORT, host: RELAY_HOST, log: (...a) => console.log('[nvda-relay]', ...a) });
      relay.start().catch((e) => console.warn('[nvda] relay start failed (agent lane down, bridge unaffected):', e.message));
    } catch (e) { console.warn('[nvda] relay init failed:', e.message); }
  } else {
    console.log(`[nvda] external relay mode — driver dials ${CONNECT_HOST}:${CONNECT_PORT} (no in-process relay)`);
  }

  const runs = new Map();

  function newRun(goal, userId, mode, wantKey) {
    const runId = 'run_' + crypto.randomBytes(5).toString('hex');
    // Allow a caller-supplied, easy-to-type key (sanitized); else random.
    const clean = String(wantKey || '').trim();
    const channelKey = /^[a-zA-Z0-9_-]{4,60}$/.test(clean) ? clean : 'kade-' + crypto.randomBytes(12).toString('hex');
    const observer = new Observer();
    const recorder = new Recorder({ file: path.join(VOL, `nvda_transcript_${runId}.jsonl`), goal });
    const safety = new Safety();
    const memory = new Memory({ userId: userId || 'kade', dir: VOL, onRemember: deps.remember || null });
    // mode 'listen' = co-listener (v0.1): connect, hear the screen, send NO keys,
    // no model. The safe first rung. mode 'drive' = the full agent loop.
    const run = { runId, channelKey, goal, userId: userId || 'kade', mode: mode === 'listen' ? 'listen' : 'drive', observer, recorder, safety, memory, status: 'connecting', pendingConfirm: null, master: null, startedAt: Date.now(), latestTree: '', latestTitle: '', sayQueue: [] };
    runs.set(runId, run);
    return run;
  }

  function connectInstructions(run) {
    return {
      words: `In NVDA: Tools > Remote > Connect. Choose Client, then "Allow this machine to be controlled". Host ${PUBLIC_HOST}, port ${PUBLIC_PORT}, key ${run.channelKey}. Connect.`,
      host: PUBLIC_HOST, port: PUBLIC_PORT, key: run.channelKey, role: 'controlled (slave)',
    };
  }

  function describePlan(plan) {
    if (!plan) return 'an action';
    if (plan.action === 'type_text') return `type "${String(plan.text).slice(0, 40)}"`;
    if (plan.action === 'send_keys') return `press ${(plan.keys || []).join(' then ')}${plan.intent ? ' — ' + plan.intent : ''}`;
    return plan.intent || plan.action;
  }

  function makeConfirm(run) {
    return (plan) => new Promise((resolve) => {
      run.pendingConfirm = { plan, resolve, at: Date.now() };
      run.status = 'awaiting_confirm';
      run.recorder.note('confirm-requested', { intent: plan.intent, plan: describePlan(plan) });
      run.sayQueue.push('I need your okay to ' + describePlan(plan) + '. Tell Kade AI yes or no.');
      if (runNotify) {
        runNotify({ userId: run.userId, adminAlert: true, agentName: 'Kade-AI PC', title: 'Approve action?', body: `About to ${describePlan(plan)}. Reply in chat or approve on your screen.`, urgent: false }).catch(() => {});
      }
    });
  }

  async function connectMaster(run) {
    let kicked = false;
    const master = new NvdaRemoteClient({
      host: CONNECT_HOST, port: CONNECT_PORT, key: run.channelKey, role: 'master',
      onSpeak: (t) => { run.observer.push(t); run.recorder.speak(t); },
      onEvent: (m) => {
        // Kick off when a PC is present — whether it joins AFTER us
        // (client_joined) or was ALREADY in the channel when we joined
        // (channel_joined lists existing members).
        if (!kicked && (m.type === 'client_joined' || m.type === 'channel_joined')) {
          const peers = m.type === 'client_joined' ? 1
            : ((m.clients && m.clients.length) || (m.user_ids && m.user_ids.length) || 0);
          if (peers > 0) {
            kicked = true;
            run.recorder.note('pc-present', { via: m.type, mode: run.mode });
            if (run.mode === 'listen') { run.status = 'listening'; } // co-listener: no keys, no model
            else startLoop(run).catch((e) => run.recorder.note('loop-throw', { error: e.message }));
          }
        }
        else if (m.type === 'client_left') { run.recorder.note('pc-left'); }
      },
    });
    run.master = master;
    await master.connect();
    run.status = 'awaiting_pc';
  }

  async function startLoop(run) {
    run.status = 'driving';
    const actions = new Actions({ client: run.master, observer: run.observer, safety: run.safety, recorder: run.recorder });
    const router = new ModelRouter({ budget: { maxCalls: MAX_STEPS + 20 }, onUsage: (u) => run.recorder.log('usage', u) });
    run.router = router;
    // Inject the whole-screen accessibility tree (from the NVDA add-on, if
    // it's running) into every decision, so the model sees the entire window,
    // not just the one item NVDA spoke.
    const baseDecide = makeModelBrain({ router });
    const decide = (ctx) => baseDecide({ ...ctx, screen: run.latestTree || null });
    run.sayQueue.push('Okay, I am on it. Working now.');
    const hint = run.memory.hint(run.goal);
    const goal = hint ? `${run.goal}\n${hint}` : run.goal;
    try {
      await runAgentLoop({ goal, observer: run.observer, actions, safety: run.safety, recorder: run.recorder, decide, confirm: makeConfirm(run), maxSteps: MAX_STEPS });
      run.status = 'done';
    } catch (e) {
      run.status = 'error';
      run.recorder.note('run-error', { error: e.message });
    }
    finalize(run);
  }

  function finalize(run) {
    try { if (run.master) run.master.close(); } catch { /* */ }
    const chords = run.recorder.find('action').filter((a) => a.action === 'send_keys').map((a) => a.chord).filter(Boolean);
    if (chords.length) { try { run.memory.learn(run.goal, { steps: chords }); } catch { /* */ } }
    const stats = run.router ? run.router.stats() : null;
    run.sayQueue.push('Finished. ' + run.goal.slice(0, 60) + '. Status: ' + run.status + '.');
    if (runNotify) runNotify({ userId: run.userId, adminAlert: true, agentName: 'Kade-AI PC', title: 'Errand finished', body: `${run.goal.slice(0, 80)} — ${run.status}.`, urgent: false }).catch(() => {});
    run.recorder.note('finalized', { status: run.status, stats });
  }

  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); } };

  app.post('/nvda/start', jsonMw, wrap(async (req, res) => {
    if (!nvdaSecretOk(req, req.body && req.body.secret)) return res.status(403).json({ error: 'forbidden' });
    const mode = (req.body && req.body.mode) === 'listen' ? 'listen' : 'drive';
    const goal = String((req.body && req.body.goal) || (mode === 'listen' ? 'listen and read the screen' : '')).slice(0, 500);
    const userId = (req.body && req.body.userId) || 'kade';
    if (mode === 'drive' && !goal) return res.status(400).json({ error: 'goal required' });
    const run = newRun(goal, userId, mode, req.body && req.body.key);
    await connectMaster(run);
    res.json({ runId: run.runId, status: run.status, mode: run.mode, channelKey: run.channelKey, connect: connectInstructions(run) });
  }));

  app.post('/nvda/confirm', jsonMw, wrap(async (req, res) => {
    if (!nvdaSecretOk(req, req.body && req.body.secret)) return res.status(403).json({ error: 'forbidden' });
    const run = runs.get(req.body && req.body.runId);
    if (!run) return res.status(404).json({ error: 'no such run' });
    if (!run.pendingConfirm) return res.json({ ok: true, note: 'nothing pending' });
    const approve = !!(req.body && req.body.approve);
    const { resolve } = run.pendingConfirm;
    run.pendingConfirm = null;
    run.status = 'driving';
    resolve(approve);
    res.json({ ok: true, approved: approve });
  }));

  app.post('/nvda/stop', jsonMw, wrap(async (req, res) => {
    if (!nvdaSecretOk(req, req.body && req.body.secret)) return res.status(403).json({ error: 'forbidden' });
    const run = runs.get(req.body && req.body.runId);
    if (!run) return res.status(404).json({ error: 'no such run' });
    if (run.pendingConfirm) { run.pendingConfirm.resolve(false); run.pendingConfirm = null; }
    try { if (run.master) run.master.close(); } catch { /* */ }
    run.status = 'stopped';
    run.recorder.note('stopped-by-user');
    res.json({ ok: true, status: 'stopped' });
  }));

  app.get('/nvda/status', wrap(async (req, res) => {
    if (!nvdaSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'forbidden' });
    const run = runs.get(req.query.runId);
    if (!run) return res.status(404).json({ error: 'no such run' });
    res.json({
      runId: run.runId, status: run.status, goal: run.goal,
      lastLines: run.observer.recent(8),
      pendingConfirm: run.pendingConfirm ? describePlan(run.pendingConfirm.plan) : null,
      stats: run.router ? run.router.stats() : null,
      treeTitle: run.latestTitle || null,
      treeChars: (run.latestTree || '').length,
      sayPending: run.sayQueue.length,
    });
  }));

  app.get('/nvda/transcript', wrap(async (req, res) => {
    if (!nvdaSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'forbidden' });
    const run = runs.get(req.query.runId);
    if (!run) return res.status(404).json({ error: 'no such run' });
    res.json({ runId: run.runId, status: run.status, transcript: run.recorder.transcript() });
  }));

  // The NVDA add-on posts the whole foreground tree here and polls /nvda/say
  // for the agent's voice. Both are keyed by the user's active run.
  function activeRunFor(userId) {
    let best = null;
    for (const r of runs.values()) {
      if (r.userId === userId && ['awaiting_pc', 'listening', 'driving', 'awaiting_confirm'].includes(r.status)) {
        if (!best || r.startedAt > best.startedAt) best = r;
      }
    }
    return best;
  }

  app.post('/nvda/tree', jsonMw, wrap(async (req, res) => {
    if (!nvdaSecretOk(req, req.body && req.body.secret)) return res.status(403).json({ error: 'forbidden' });
    const run = activeRunFor((req.body && req.body.userId) || 'kade');
    if (!run) return res.json({ ok: true, note: 'no active run' });
    run.latestTree = String((req.body && req.body.tree) || '').slice(0, 12000);
    run.latestTitle = String((req.body && req.body.title) || '');
    res.json({ ok: true, runId: run.runId, chars: run.latestTree.length });
  }));

  app.get('/nvda/say', wrap(async (req, res) => {
    if (!nvdaSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'forbidden' });
    const run = activeRunFor(req.query.userId || 'kade');
    if (!run) return res.json({ say: [] });
    const say = run.sayQueue.splice(0, run.sayQueue.length);
    res.json({ say });
  }));

  // Send keystrokes through the active run's already-connected controller (no
  // reconnect churn) — for supervised hand-driving. chords: array like
  // ["control+home","h","tab","enter"]; or text: string (clipboard+paste).
  app.post('/nvda/key', jsonMw, wrap(async (req, res) => {
    if (!nvdaSecretOk(req, req.body && req.body.secret)) return res.status(403).json({ error: 'forbidden' });
    const run = activeRunFor((req.body && req.body.userId) || 'kade');
    if (!run || !run.master) return res.status(404).json({ error: 'no active run with a connected controller' });
    const body = req.body || {};
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    if (body.text) {
      run.master.send({ type: 'set_clipboard_text', text: String(body.text) });
      await nap(150);
      for (const e of (chordToKeyEvents('control+v') || [])) { run.master.send({ type: 'key', ...e }); await nap(45); }
      return res.json({ ok: true, typed: String(body.text).length });
    }
    const chords = body.chords || (body.chord ? [body.chord] : []);
    for (const chord of chords) {
      const events = chordToKeyEvents(String(chord), { nvdaKey: 'insert' });
      if (!events) return res.status(400).json({ error: 'bad chord: ' + chord });
      for (const e of events) { run.master.send({ type: 'key', ...e }); await nap(50); }
      await nap(220);
    }
    res.json({ ok: true, sent: chords });
  }));

  // The active run at a glance, NO run id needed — so a chat that lost the id
  // (or a fresh conversation) can still ask "what's my PC doing?" (Aug 14 2026,
  // shipped with the fork's kade_drive_pc tool.)
  app.get('/nvda/active', wrap(async (req, res) => {
    if (!nvdaSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'forbidden' });
    const run = activeRunFor(req.query.userId || 'kade');
    if (!run) return res.json({ active: false });
    res.json({
      active: true,
      runId: run.runId, status: run.status, mode: run.mode, goal: run.goal,
      lastLines: run.observer.recent(5),
      pendingConfirm: run.pendingConfirm ? describePlan(run.pendingConfirm.plan) : null,
      treeTitle: run.latestTitle || null,
      treeChars: (run.latestTree || '').length,
      connect: run.status === 'awaiting_pc' ? connectInstructions(run) : undefined,
    });
  }));

  // Read back the latest whole-page tree (for supervising a run).
  app.get('/nvda/tree', wrap(async (req, res) => {
    if (!nvdaSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'forbidden' });
    const run = activeRunFor(req.query.userId || 'kade');
    if (!run) return res.json({ tree: '', title: '', chars: 0 });
    res.json({ title: run.latestTitle, chars: (run.latestTree || '').length, tree: run.latestTree });
  }));

  // Inject a phrase for the add-on to speak (testing + manual narration).
  app.post('/nvda/say', jsonMw, wrap(async (req, res) => {
    if (!nvdaSecretOk(req, req.body && req.body.secret)) return res.status(403).json({ error: 'forbidden' });
    const run = activeRunFor((req.body && req.body.userId) || 'kade');
    if (!run) return res.status(404).json({ error: 'no active run' });
    run.sayQueue.push(String((req.body && req.body.text) || '').slice(0, 300));
    res.json({ ok: true });
  }));

  console.log(`[nvda] agent lane attached — relay :${RELAY_PORT}, endpoints /nvda/{start,confirm,stop,status,transcript,tree,say}`);
  return { enabled: true, relay, runs };
}

module.exports = { attachNvdaAgent };
