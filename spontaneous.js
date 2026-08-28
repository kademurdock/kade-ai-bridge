/* KADE — SPONTANEOUS FRIEND-TEXTS (Aug 28 2026, Part 93. Her ask, her words:
 * "based on memories and logs and stuff, just sending a message when someone
 * hasn't engaged with the platform in a while, like a friend texting you. Not
 * motivational stuff like pi.ai but actual stuff a texting friend would talk
 * about... of course you would be able to turn it off and on.")
 *
 * What it is: once a day, at a civilized texting hour, the tick asks the fork
 * who has gone quiet. For each eligible quiet person it has Kiana write ONE
 * short text — composed ON THEIR SEAT (kadeOnBehalfOf), so her memory of
 * them, their cards and their logbook ride the ask exactly like a phone call
 * — and delivers it through runNotify, which means every existing guardrail
 * applies unbypassed: quiet hours, cooldown, per-agent and global daily caps,
 * mutes. This lane adds its own on top:
 *
 *   - ADULTS ONLY (SPONTANEOUS_USERS env, defaults to ERRAND_USERS + owner;
 *     the child-seat rule is the errands rule).
 *   - Per-user toggle, ON by default for eligible seats, flippable by admin
 *     route or by the person themselves in chat (KadeNotify's
 *     spontaneous_on / spontaneous_off actions).
 *   - Idle floor (SPONTANEOUS_IDLE_DAYS, default 3) + per-user minimum gap
 *     between texts (SPONTANEOUS_GAP_DAYS, default 6, jittered +0-2 so it
 *     never becomes a metronome) + platform cap per tick
 *     (SPONTANEOUS_MAX_PER_TICK, default 2).
 *   - The prompt bans the Pi register by name: no wellness-checking, no
 *     motivation, no guilt about the gap. A callback to something real, or
 *     an honest "just seeing what's up" when nothing is live.
 *
 * State on the volume (bridge-spontaneous.json) so gaps survive redeploys.
 * Kill switch: SPONTANEOUS=0. Fail-soft everywhere: a tick that cannot read
 * the fork, compose, or send, logs loudly and tries again tomorrow. */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

const FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(), 'bridge-spontaneous.json');

function attachSpontaneous(app, { bridgeSecretOk, notifySecretOk, runNotify, proxyUrl, proxySecret, browserUA, siteBase, kianaAgentId, kianaName }) {
  const enabled = () => process.env.SPONTANEOUS !== '0';
  const IDLE_DAYS = Math.max(1, parseInt(process.env.SPONTANEOUS_IDLE_DAYS, 10) || 3);
  const GAP_DAYS = Math.max(2, parseInt(process.env.SPONTANEOUS_GAP_DAYS, 10) || 6);
  const MAX_PER_TICK = Math.max(1, parseInt(process.env.SPONTANEOUS_MAX_PER_TICK, 10) || 2);
  const HOUR_CENTRAL = Math.min(20, Math.max(9, parseInt(process.env.SPONTANEOUS_HOUR, 10) || 11));

  function eligibleIds() {
    const raw = process.env.SPONTANEOUS_USERS || [process.env.ERRAND_USERS || '', process.env.KADE_OWNER_USER_ID || ''].filter(Boolean).join(',');
    return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  }

  let state = { users: {}, lastTickDay: null };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (_) {}
  const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(state)); } catch (e) { console.error('[spontaneous] save:', e.message); } };
  const userState = (id) => state.users[id] || (state.users[id] = { enabled: true, lastSentAt: null, nextGapDays: null });

  function centralNow() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: parseInt(get('hour'), 10) };
  }

  async function lastActivity() {
    const r = await axios.get(`${siteBase}/api/kade/clock/last-activity`, {
      headers: { 'x-kade-secret': process.env.BRIDGE_SECRET, 'User-Agent': browserUA },
      timeout: 30000,
    });
    return (r.data && r.data.users) || [];
  }

  function composePrompt(name, daysQuiet) {
    return (
      `[SPONTANEOUS TEXT — you are texting ${name} first. Nobody asked you to; that's the point. ` +
      `It has been about ${daysQuiet} days since y'all last talked on here. ` +
      `Check your memory of them first, then write ONE short text (2-3 sentences max, under 280 characters) the way a real friend texts first: ` +
      `a callback to something y'all actually had going ("did that thing with X ever pan out"), or something you ran into that THEY specifically would care about, ` +
      `or — only if nothing real is live in your memory — a plain "hey, what's up with you" in your own voice. ` +
      `HARD RULES: no wellness-check energy, no motivational-poster lines, no guilt about the gap ("haven't heard from you in a while..." is banned), ` +
      `no questions about their feelings, no signature, no emoji unless that's how y'all text. It should read like the first gray bubble of a normal conversation. ` +
      `Output ONLY the text itself.]`
    );
  }

  async function composeAndSend(u, daysQuiet, dry) {
    const r = await axios.post(
      `${proxyUrl}/librechat/ask`,
      { agentId: kianaAgentId, messages: [{ role: 'user', content: composePrompt(u.name || 'them', daysQuiet) }], userEmail: u.email || undefined, deleteAfter: true },
      { headers: { Authorization: `Bearer ${proxySecret}`, 'User-Agent': browserUA }, timeout: 150000 },
    );
    let text = (r.data && r.data.text) || '';
    text = text.replace(/%%%[^%]{0,120}%%%/g, '').replace(/\s+/g, ' ').trim().slice(0, 290);
    if (text.length < 8) throw new Error('compose came back empty');
    if (dry) return { text, sent: false };
    const out = await runNotify({
      agentId: kianaAgentId, agentName: kianaName, title: kianaName,
      body: text, userId: u.userId, category: null, route: null,
    });
    return { text, sent: !!(out && out.ok), notify: out };
  }

  async function tick(force = false, onlyUserId = null) {
    if (!enabled()) return { ok: false, disabled: true };
    const { day, hour } = centralNow();
    if (!force) {
      if (state.lastTickDay === day) return { ok: true, skipped: 'already ran today' };
      if (hour !== HOUR_CENTRAL) return { ok: true, skipped: `waiting for ${HOUR_CENTRAL}:00 Central` };
    }
    state.lastTickDay = day; save();
    const results = [];
    try {
      const allowed = eligibleIds();
      const acts = await lastActivity();
      const now = Date.now();
      let sentCount = 0;
      for (const a of acts) {
        if (onlyUserId && a.userId !== onlyUserId) continue;
        if (!allowed.has(a.userId)) continue;
        const st = userState(a.userId);
        if (!st.enabled) continue;
        const daysQuiet = a.lastMessageAt ? Math.floor((now - new Date(a.lastMessageAt).getTime()) / 864e5) : null;
        if (daysQuiet === null || daysQuiet < IDLE_DAYS) continue;
        const gap = st.nextGapDays || GAP_DAYS;
        if (st.lastSentAt && (now - new Date(st.lastSentAt).getTime()) / 864e5 < gap) continue;
        if (!onlyUserId && sentCount >= MAX_PER_TICK) break;
        try {
          const out = await composeAndSend(a, daysQuiet, false);
          results.push({ userId: a.userId, name: a.name, daysQuiet, ...out });
          if (out.sent) {
            sentCount += 1;
            st.lastSentAt = new Date().toISOString();
            st.nextGapDays = GAP_DAYS + Math.floor(Math.random() * 3); // jitter: never a metronome
            save();
          }
        } catch (e) {
          console.warn(`[spontaneous] compose/send failed for ${a.userId}: ${e.message}`);
          results.push({ userId: a.userId, error: e.message });
        }
      }
      console.log(`[spontaneous] tick ${day}: ${sentCount} sent, ${results.length} considered`);
      return { ok: true, sent: sentCount, results };
    } catch (e) {
      console.error('[spontaneous] tick failed:', e.message);
      return { ok: false, error: e.message, results };
    }
  }

  /* Hourly heartbeat; the tick itself decides whether it's time. */
  setInterval(() => { tick().catch(() => {}); }, 60 * 60 * 1000).unref?.();

  /* ── Routes ── */
  // Admin: state + config.
  app.get('/spontaneous', (req, res) => {
    if (!bridgeSecretOk(req, req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
    res.json({
      enabled: enabled(), idleDays: IDLE_DAYS, gapDays: GAP_DAYS, maxPerTick: MAX_PER_TICK,
      hourCentral: HOUR_CENTRAL, eligible: [...eligibleIds()], users: state.users, lastTickDay: state.lastTickDay,
    });
  });
  // Admin: flip a user, or fire a real/dry run. {userId, enabled} | {fire:true, userId?, dry?}
  app.post('/spontaneous', async (req, res) => {
    const b = req.body || {};
    if (!bridgeSecretOk(req, b.secret)) return res.status(403).json({ error: 'Unauthorized' });
    if (typeof b.enabled === 'boolean' && b.userId) {
      userState(String(b.userId)).enabled = b.enabled; save();
      return res.json({ ok: true, userId: b.userId, enabled: b.enabled });
    }
    if (b.fire === true) {
      if (b.dry === true && b.userId) {
        try {
          const acts = await lastActivity();
          const a = acts.find((x) => x.userId === String(b.userId));
          if (!a) return res.status(404).json({ error: 'no activity row for that user' });
          const days = a.lastMessageAt ? Math.floor((Date.now() - new Date(a.lastMessageAt).getTime()) / 864e5) : 999;
          const out = await composeAndSend(a, Math.max(days, IDLE_DAYS), true);
          return res.json({ ok: true, dry: true, wouldSend: out.text });
        } catch (e) { return res.status(500).json({ error: e.message }); }
      }
      return res.json(await tick(true, b.userId ? String(b.userId) : null));
    }
    res.status(400).json({ error: 'expected {userId, enabled} or {fire:true, userId?, dry?}' });
  });
  // The person's own switch — scoped notify secret (KadeNotify tool sends the
  // AUTHED user's id from tool context; the secret can at most flip texts,
  // never reach an admin surface).
  app.post('/spontaneous/user', (req, res) => {
    const b = req.body || {};
    if (!notifySecretOk(req, b.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const userId = String(b.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (typeof b.enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) required' });
    userState(userId).enabled = b.enabled; save();
    console.log(`[spontaneous] user ${userId} turned friend-texts ${b.enabled ? 'ON' : 'OFF'} (self-serve)`);
    res.json({ ok: true, enabled: b.enabled });
  });

  console.log(`[spontaneous] attached — ${enabled() ? 'ON' : 'OFF'}, idle>=${IDLE_DAYS}d, gap ${GAP_DAYS}d+jitter, ${MAX_PER_TICK}/tick, hour ${HOUR_CENTRAL} Central`);
}

module.exports = { attachSpontaneous };
