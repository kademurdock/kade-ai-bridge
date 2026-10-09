'use strict';

// A new, explicitly admin-only door. Legacy /notify and /broadcasts keep their
// semantics. An operation ID is one publication and at most one attempt per
// channel; unknown outcomes are reconciled with GET, never sent again by POST.
const crypto = require('node:crypto');
const fs = require('node:fs');

const AGENT_ID = /^agent_[A-Za-z0-9_-]{21}$/;
const OPERATION_ID = /^[a-z][a-z0-9-]{7,95}$/;
const SITE = 'https://kademurdock.com';

class AnnouncementError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function validatePayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AnnouncementError(400, 'invalid input');
  if (Object.keys(input).some(k => !['id', 'title', 'body', 'agentId', 'channels'].includes(k))) throw new AnnouncementError(400, 'unexpected field');
  const { id, agentId } = input;
  if (typeof id !== 'string' || !OPERATION_ID.test(id)) throw new AnnouncementError(400, 'invalid announcement id');
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) throw new AnnouncementError(400, 'invalid agent id');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 40) throw new AnnouncementError(400, 'title must be 1 to 40 characters');
  if (typeof input.body !== 'string' || !input.body.trim() || input.body.trim().length > 1000) throw new AnnouncementError(400, 'body must be 1 to 1000 characters');
  const channels = input.channels ?? { native: true, web: true };
  if (!channels || typeof channels !== 'object' || Array.isArray(channels) ||
      Object.keys(channels).some(k => !['native', 'web'].includes(k)) ||
      typeof channels.native !== 'boolean' || typeof channels.web !== 'boolean' ||
      (!channels.native && !channels.web)) throw new AnnouncementError(400, 'invalid channels');
  const core = { id, title: input.title.trim(), body: input.body.trim(), agentId, url: `${SITE}/c/new?agent_id=${encodeURIComponent(agentId)}` };
  if (Buffer.byteLength(JSON.stringify({ aps: { alert: { title: core.title, body: core.body }, sound: 'Notify.wav', category: 'KADE_ROUTE' },
      kadeRoute: 'agent-chat', kadeAgentId: agentId, kadeAnnouncementId: id })) > 4096) throw new AnnouncementError(400, 'native push payload exceeds 4096 bytes');
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { ...core, channels: { native: channels.native, web: channels.web }, payloadHash: hash(core), requestHash: hash({ ...core, channels: { native: channels.native, web: channels.web } }) };
}

function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }

function atomicSave(filename, value) {
  const temp = filename + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'w', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, filename);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function createAnnouncementService(deps) {
  const { storePath } = deps;
  if (deps.persistentStorage !== true || typeof storePath !== 'string') throw new Error('Persistent announcement storage is required');
  let operations = {};
  try {
    if (fs.existsSync(storePath)) {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid operation store');
      operations = parsed;
    }
  } catch { throw new Error('Announcement operation store is unreadable; refusing to replace it'); }
  const inflight = new Map();
  const now = () => new Date(deps.now ? deps.now() : Date.now()).toISOString();
  const persist = () => atomicSave(storePath, operations);

  function nativeMetrics(channel) {
    const results = channel.results || [];
    const accepted = results.filter(s => s === 200).length;
    const failed = results.filter(s => Number.isInteger(s) && s > 0 && s !== 200).length;
    return { attempted: results.length, accepted, failed, unknown: results.length - accepted - failed };
  }

  function publicChannel(channel, active) {
    const { results, ...clean } = channel;
    if (results) Object.assign(clean, nativeMetrics(channel));
    if (!active && clean.state === 'sending') clean.state = 'unknown';
    return clean;
  }

  function overall(native, web, active) {
    if (native.unknown || web.unknown || native.state === 'unknown' || web.state === 'unknown') return 'unknown';
    if ([native, web].some(c => ['pending', 'sending'].includes(c.state))) return active ? 'sending' : 'incomplete';
    if (native.failed || web.failed || native.state === 'failed' || web.state === 'failed') return native.accepted + web.accepted > 0 ? 'partial' : 'failed';
    return 'complete';
  }

  function summary(op, webOverride) {
    const active = inflight.has(op.id);
    const native = publicChannel(op.native, active);
    const web = publicChannel(webOverride || op.web, active);
    return { ok: true, id: op.id, payloadHash: op.payloadHash, requestHash: op.requestHash,
      state: op.error ? 'failed' : overall(native, web, active), persistent: op.published === true,
      durableStorage: true,
      title: op.title, body: op.body, agentId: op.agentId, agentName: op.agentName,
      kadeRoute: 'agent-chat', kadeAgentId: op.agentId, url: op.url,
      createdAt: op.createdAt, updatedAt: op.updatedAt, audience: op.audience,
      native, web, ...(op.error ? { error: op.error } : {}) };
  }

  async function audience(agentId) {
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) throw new AnnouncementError(400, 'invalid agent id');
    const registry = deps.nativeRegistry();
    const rows = registry.rows || [];
    const userIds = [...new Set(rows.map(r => r.userId))];
    const remote = await deps.readAudience(agentId, userIds);
    if (!remote || remote.ok !== true || remote.publicAgent?.id !== agentId || remote.publicAgent?.isPublic !== true ||
        typeof remote.publicAgent?.name !== 'string' || !remote.publicAgent.name.trim()) throw new AnnouncementError(409, 'target must be a verified public agent');
    if (!Number.isSafeInteger(remote.accounts?.eligible) || remote.accounts.eligible < 0 ||
        typeof remote.web?.configured !== 'boolean' || !Number.isSafeInteger(remote.web.subscriptions) || remote.web.subscriptions < 0 ||
        !Number.isSafeInteger(remote.web.users) || remote.web.users < 0) throw new AnnouncementError(503, 'audience metrics are unavailable');
    const indexes = remote.nativeEligibleIndexes;
    if (!Array.isArray(indexes) || indexes.some(i => !Number.isInteger(i) || i < 0 || i >= userIds.length) || new Set(indexes).size !== indexes.length)
      throw new AnnouncementError(503, 'native account eligibility is unavailable');
    const eligibleIds = new Set(indexes.map(i => userIds[i]));
    const targets = rows.filter(r => eligibleIds.has(r.userId));
    const native = {
      registered: count(registry.registered), eligibleTargets: targets.length,
      eligibleUsers: new Set(targets.map(t => t.userId)).size,
      ios: targets.filter(t => t.platform === 'ios').length, android: targets.filter(t => t.platform === 'android').length,
      excludedTest: count(registry.excludedTest), excludedUnlinked: count(registry.excludedUnlinked),
      excludedUnconfigured: count(registry.excludedUnconfigured), excludedInactive: rows.length - targets.length,
      iosConfigured: registry.iosConfigured === true, androidConfigured: registry.androidConfigured === true,
    };
    return { public: { publicAgent: { id: agentId, name: remote.publicAgent.name },
      accounts: { eligible: remote.accounts.eligible, total: Number.isSafeInteger(remote.accounts.total) ? remote.accounts.total : null,
        excludedTest: Number.isSafeInteger(remote.accounts.excludedTest) ? remote.accounts.excludedTest : null },
      native, web: { configured: remote.web?.configured === true, subscriptions: count(remote.web?.subscriptions), users: count(remote.web?.users) },
      gate: deps.notificationGate(agentId) }, targets };
  }

  function checkedWeb(result, op) {
    if (!result || result.id !== op.id || result.payloadHash !== op.payloadHash ||
        !['sending', 'complete', 'failed', 'unknown', 'skipped'].includes(result.state)) throw new Error('web delivery binding differs');
    for (const key of ['eligibleUsers', 'subscriptions', 'attempted', 'accepted', 'failed', 'unknown']) {
      if (!Number.isSafeInteger(result[key]) || result[key] < 0) throw new Error('web delivery metrics differ');
    }
    if (result.accepted + result.failed + result.unknown !== result.attempted || result.attempted > result.subscriptions) throw new Error('web delivery totals differ');
    return { state: result.state, configured: result.configured === true,
      eligibleUsers: result.eligibleUsers, subscriptions: result.subscriptions, attempted: result.attempted,
      accepted: result.accepted, failed: result.failed, unknown: result.unknown,
      ...(typeof result.reason === 'string' ? { reason: result.reason.slice(0, 120) } : {}) };
  }

  function saveProgress(op) {
    op.updatedAt = now();
    persist();
    if (op.published) deps.updateHistory(op.id, {
      sent: nativeMetrics(op.native).accepted, delivery: { native: publicChannel(op.native, inflight.has(op.id)), web: publicChannel(op.web, inflight.has(op.id)) },
    });
  }

  function chargeAccepted(op) {
    if (!op.budgetCharged && (nativeMetrics(op.native).accepted + op.web.accepted > 0)) {
      op.budgetCharged = true;
      persist();
      deps.chargeBudget(op.agentId);
    }
  }

  async function nativeFanout(op, targets) {
    if (!op.channels.native) { op.native.state = 'skipped'; op.native.reason = 'disabled'; saveProgress(op); return; }
    if (!targets.length) { op.native.state = 'skipped'; op.native.reason = 'no eligible registered devices'; saveProgress(op); return; }
    op.native.state = 'sending';
    op.native.results = targets.map(() => null);
    saveProgress(op); // all recipient attempts are claimed before any send
    const options = { category: 'KADE_ROUTE', data: { kadeRoute: 'agent-chat', kadeAgentId: op.agentId, kadeAnnouncementId: op.id } };
    const tasks = targets.map((target, index) => Promise.resolve()
      .then(() => deps.sendNative(target.token, op.title, op.body, options))
      .then(result => {
        const status = Number.isInteger(result?.status) && result.status >= 0 ? result.status : 0;
        op.native.results[index] = status;
        if (status === 410) deps.pruneNative(target.token);
      }, () => { op.native.results[index] = 0; })
      .then(() => {
        const metrics = nativeMetrics(op.native);
        op.native.state = metrics.unknown ? 'unknown' : 'complete';
        chargeAccepted(op);
        saveProgress(op);
      }));
    let timeout;
    try {
      await Promise.race([
        Promise.all(tasks),
        new Promise(resolve => { timeout = setTimeout(resolve, deps.nativeTimeoutMs ?? 30000); }),
      ]);
    } finally { clearTimeout(timeout); }
    op.native.state = nativeMetrics(op.native).unknown ? 'unknown' : 'complete';
    saveProgress(op);
    // Late provider results update counts, but never produce another attempt.
    Promise.allSettled(tasks).catch(() => {});
  }

  async function execute(payload) {
    const prepared = await audience(payload.agentId);
    if (prepared.public.gate?.allowed !== true) throw new AnnouncementError(409, prepared.public.gate?.reason || 'notification guard blocked');
    const op = { ...payload, agentName: prepared.public.publicAgent.name, createdAt: now(), updatedAt: now(),
      audience: prepared.public, published: false,
      native: { state: payload.channels.native ? 'pending' : 'skipped', results: [] },
      web: { state: payload.channels.web ? 'pending' : 'skipped', configured: prepared.public.web.configured,
        eligibleUsers: prepared.public.web.users, subscriptions: prepared.public.web.subscriptions, attempted: 0, accepted: 0, failed: 0, unknown: 0 } };
    operations[op.id] = op;
    try {
      persist();
      deps.publishHistory({ id: op.id, ts: op.createdAt, title: op.title, body: op.body,
        agentId: op.agentId, agentName: op.agentName, sent: 0,
        kadeRoute: 'agent-chat', kadeAgentId: op.agentId, url: op.url, payloadHash: op.payloadHash });
      op.published = true;
      saveProgress(op); // history is durable before either native or web fanout
      await nativeFanout(op, prepared.targets);
      if (op.channels.web) {
        op.web.state = 'sending';
        saveProgress(op); // claiming the web call also precedes its external POST
        try {
          op.web = checkedWeb(await deps.sendWeb({ id: op.id, payloadHash: op.payloadHash, title: op.title, body: op.body, agentId: op.agentId, url: op.url }), op);
        } catch {
          op.web.state = 'unknown';
          op.web.reason = 'web operation outcome unavailable; reconcile with GET';
        }
      }
      saveProgress(op);
      chargeAccepted(op);
    } catch {
      op.error = op.published ? 'delivery bookkeeping failed; do not retry' : 'persistent publication failed; no pushes were started';
      try { saveProgress(op); } catch { /* original claimed state stays on disk */ }
    }
    return summary(op);
  }

  async function start(input) {
    const payload = validatePayload(input);
    const existing = operations[payload.id];
    if (existing) {
      if (existing.requestHash !== payload.requestHash) throw new AnnouncementError(409, 'announcement id already binds a different payload');
      return { ...summary(existing), deduplicated: true };
    }
    const running = inflight.get(payload.id);
    if (running) {
      if (running.requestHash !== payload.requestHash) throw new AnnouncementError(409, 'announcement id already binds a different payload');
      await running.promise;
      return { ...summary(operations[payload.id]), deduplicated: true };
    }
    const promise = execute(payload);
    inflight.set(payload.id, { requestHash: payload.requestHash, promise });
    try { return await promise; }
    finally { inflight.delete(payload.id); }
  }

  async function status(id) {
    if (typeof id !== 'string' || !OPERATION_ID.test(id)) throw new AnnouncementError(400, 'invalid announcement id');
    const op = operations[id];
    if (!op) throw new AnnouncementError(404, 'announcement not found');
    let web;
    if (op.channels.web && ['sending', 'unknown'].includes(op.web.state)) {
      try { web = checkedWeb(await deps.readWeb(id), op); } catch { /* counts remain explicitly unknown */ }
    }
    return summary(op, web); // GET does not send, charge budgets, or mutate stores
  }

  return { start, status, audience: async id => (await audience(id)).public };
}

function attachAnnouncements(app, deps) {
  let service;
  try { service = createAnnouncementService(deps); }
  catch {
    // A damaged announcement store must not take calls or legacy notifications
    // offline. Only this new operation is unavailable until the store is repaired.
    const unavailable = async () => { throw new Error('Announcement store unavailable'); };
    service = { start: unavailable, status: unavailable, audience: unavailable };
  }
  const admin = (req, res) => {
    if (deps.bridgeSecretOk(req, undefined)) return true;
    res.status(403).json({ error: 'Unauthorized' }); return false;
  };
  const fail = (res, error) => res.status(error instanceof AnnouncementError ? error.status : 503)
    .json({ error: error instanceof AnnouncementError ? error.code : 'Announcement service unavailable' });
  app.get('/announcements/audience', async (req, res) => {
    if (!admin(req, res)) return;
    try { res.json(await service.audience(req.query.agentId)); } catch (error) { fail(res, error); }
  });
  app.get('/announcements/:id', async (req, res) => {
    if (!admin(req, res)) return;
    try { res.json(await service.status(req.params.id)); } catch (error) { fail(res, error); }
  });
  app.post('/announcements', async (req, res) => {
    if (!admin(req, res)) return;
    try { res.json(await service.start(req.body)); } catch (error) { fail(res, error); }
  });
  return service;
}

module.exports = { attachAnnouncements, createAnnouncementService, validatePayload, AnnouncementError, atomicSave };
