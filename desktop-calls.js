'use strict';

const ANSWER_WINDOW_MS = 180000;
const PRESENCE_MS = 90000;
const leasePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function pendingRing(plan, userId, now = Date.now()) {
  if (!plan || !userId || String(plan.userId) !== String(userId) || plan.enabled === false) return null;
  const firedAt = plan.pendingAnswer?.firedAt;
  const fired = typeof firedAt === 'string' ? Date.parse(firedAt) : NaN;
  if (!Number.isFinite(fired) || fired > now || now - fired >= ANSWER_WINDOW_MS) return null;
  return {
    planId: String(plan.id), ringId: `${plan.id}:${firedAt}`,
    agentId: String(plan.agentId || ''), agentName: String(plan.agentName || '').slice(0, 40),
    purpose: String(plan.purpose || '').slice(0, 300), firedAt,
    expiresAt: new Date(fired + ANSWER_WINDOW_MS).toISOString(),
  };
}

function canAnswerRing(plan, userId, agentId, ringId, now = Date.now()) {
  const ring = pendingRing(plan, userId, now);
  return Boolean(ring && ring.agentId && ring.agentId === agentId && ring.ringId === ringId);
}

class DesktopPresence {
  constructor() { this.leases = new Map(); }
  prune(now) {
    for (const [key, lease] of this.leases) {
      if (lease.expires <= now) this.leases.delete(key);
    }
  }
  set(userId, leaseId, enabled, now = Date.now()) {
    if (typeof userId !== 'string' || !userId || userId.length > 64 || !leasePattern.test(leaseId) || typeof enabled !== 'boolean') {
      throw new TypeError('A user, UUID leaseId and boolean enabled are required.');
    }
    this.prune(now);
    const key = `${userId}:${leaseId}`;
    if (!enabled) {
      this.leases.delete(key);
      return { ok: true, expiresAt: null };
    }
    if (!this.leases.has(key)) {
      let count = 0;
      for (const lease of this.leases.values()) if (lease.userId === userId) count++;
      if (count >= 16) throw new RangeError('Too many active desktop instances for this account.');
      if (this.leases.size >= 10000) throw new RangeError('Desktop presence is temporarily full.');
    }
    const expires = now + PRESENCE_MS;
    this.leases.set(key, { userId, expires });
    return { ok: true, expiresAt: new Date(expires).toISOString() };
  }
  has(userId, now = Date.now()) {
    this.prune(now);
    for (const lease of this.leases.values()) {
      if (lease.userId === userId) return true;
    }
    return false;
  }
}

module.exports = { pendingRing, canAnswerRing, DesktopPresence };
