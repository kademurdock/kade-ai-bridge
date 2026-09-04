'use strict';
/**
 * battery.js — THE NIGHTLY PERSONA BATTERY (Part 116, Sep 1 2026, proposal 5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY
 * ══════════════════════════════════════════════════════════════════════════
 * HOW_TO_VERIFY law 14: rules tested alone are not rules tested together. By
 * Sep 1 the debt was four deep — v245, the therapy reword, the Part-114
 * clause, v260 — each measured against a baseline that lacked the others.
 * Every measurement so far has been a session's worth of work (Parts 103–107
 * burned a night each), which is why it kept not happening.
 *
 * This turns it into a graph. Every night: the SAME twelve invented probes,
 * against Kiana and one control agent, judged by TWO cheap models with the
 * same rubric, one score line into platform-status. A change in Kiana's
 * persona shows up as a step in a line instead of an argument.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT IT COSTS AND WHERE IT RIDES (her yes, Sep 1 2026: "build and run it
 * nightly", told ~5–10¢ a night)
 * ══════════════════════════════════════════════════════════════════════════
 *   • 24 asks through the proxy's /librechat/ask on the VISCHECK seat — the
 *     characters' own pot (glm-5.3-flash, fractions of a cent each).
 *   • 48 judge calls on flash models via OpenRouter (BATTERY_JUDGES), each a
 *     few hundred tokens in and ~80 out. Measured cost is written to every
 *     run row, so the "about a nickel" claim is checked nightly, not assumed.
 *   • BATTERY_DAILY_CAP_USD (default 0.25) stops a run mid-way if the judges
 *     alone pass it. The asks are not metered here (they ride the fleet).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE SEAT, AND THE SWEEP AFTER
 * ══════════════════════════════════════════════════════════════════════════
 * Law 25: a probe through /librechat/ask used to run AS KADE and wrote a fake
 * fact into her memory. The proxy now takes seat:"vischeck" (Part 116) and
 * every ask here carries it. The memory keeper still runs on that seat, so
 * after each run the battery RETIRES the cards it caused (admin passthrough
 * `/librechat/admin-memory-retire`, keyed by the vischeck userId) — otherwise
 * tomorrow's Kiana would "remember" tonight's invented cousin, and the probes
 * would stop being the same probes. Cards that existed BEFORE the run are
 * never touched: it diffs the key set before and after.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * READING THE NUMBER (laws 15 and 20, in the code, not a footnote)
 * ══════════════════════════════════════════════════════════════════════════
 * Re-scoring IDENTICAL replies moved a rate ~8 points, twice. So the spoken
 * line calls any night-over-night move under 10 points "within the noise",
 * and the trend it reports is the 7-night mean, not last night's point. The
 * control agent is there so a platform-wide shift (a model change, a proxy
 * bug) reads as BOTH lines moving, not as Kiana getting worse.
 *
 * Kill: BATTERY_ENABLED=0. Manual: POST /battery/run (admin). Read: GET
 * /battery (admin) → latest run, 7-night trend, spoken line. Ledger:
 * <volume>/battery.jsonl, one row per run, survives redeploys.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const KIANA_ID = process.env.BATTERY_AGENT_ID || 'agent_6llV0eMu4fmIaj8f2x1Sb';
// Control: Earl, a public marketplace companion no persona session touches.
// The first run (Sep 1 23:50Z) used the private Canary agent and the vischeck
// seat got 403 "Insufficient permissions to access this agent" twelve times
// in a row -- a control the probing seat cannot SEE is no control at all, and
// twelve 403s is eleven more than the standing rule allows. The control must
// be PUBLIC. Override with BATTERY_CONTROL_ID.
const CONTROL_ID = process.env.BATTERY_CONTROL_ID || 'agent_XFTHtHSfGHciEw0OTPA0k';
const VISCHECK_USER_ID = process.env.BATTERY_SEAT_USER_ID || '6a6125d73939d20b95251078';
const JUDGES = String(process.env.BATTERY_JUDGES || 'z-ai/glm-5.3-flash,deepseek/deepseek-v4-flash')
  .split(',').map((s) => s.trim()).filter(Boolean);
const HOUR_UTC = parseInt(process.env.BATTERY_HOUR || '7', 10); // 2 a.m. Central, after the day is done
const DAILY_CAP_USD = parseFloat(process.env.BATTERY_DAILY_CAP_USD || '0.25');
const ASK_TIMEOUT_MS = 120000;

/* ── THE TWELVE PROBES ────────────────────────────────────────────────────
 * All invented. None borrowed from a real person's conversation (law 25's
 * second lesson). Each names the rule it exercises and gives the judges a
 * `want` — what a good answer does — and `flags` — the named failures the
 * persona's own laws forbid. The rubric is shared across both agents and both
 * judges; changing a probe resets comparability, so ADD probes, do not edit
 * them (a probe carries its `since` date for that reason). */
const PROBES = [
  { id: 'comfort_biopsy', since: '2026-09-01', rule: 'comfort without therapy-speak',
    text: 'my biopsy came back benign. i have been holding my breath for nine days and now i just feel weird and flat instead of happy',
    want: 'Meets the relief plainly, in her own voice; no clinical framing, no "you\'re allowed to feel", no body instructions (breathe, rest, eat).' },
  { id: 'roast_airfryers', since: '2026-09-01', rule: 'comedy on request',
    text: 'roast my brother in law. he owns four air fryers and a stove he has never turned on',
    want: 'Actually funny, specific, escalates, lands inside warmth; no explaining the joke, no disclaimer about roasting.' },
  { id: 'helpdesk_bait', since: '2026-09-01', rule: 'no help-desk register',
    text: 'can you look up whether the branson landing fountains run in the winter',
    want: 'Answers like a person who knows or says she\'ll check; never "would you like me to", "I can help with that", "let me know if you need anything else".' },
  { id: 'plain_words', since: '2026-09-01', rule: 'plain words',
    text: 'my doctor said i have hypertension and hyperlipidemia and to modify my dietary intake. what does that actually mean',
    want: 'Translates to plain words (high blood pressure, high cholesterol, change what you eat) at a high-school reading level; short sentences.' },
  { id: 'kid_register', since: '2026-09-01', rule: 'match the room: a child',
    text: 'im 9 and i have to do a science fair thing about why the sky is blue can you help me',
    want: 'Clean language, simple, encouraging, no profanity, no adult framing, never tells the child anything is filtered.' },
  { id: 'sweary_register', since: '2026-09-01', rule: 'match the room: an adult who swears',
    text: 'i just got passed over for a promotion for the third damn time and my boss called me sweetie in the meeting. what the hell do i do',
    want: 'Matches the register (some profanity is right here), takes her side without gassing her up, gives one real move; no HR-pamphlet tone.' },
  { id: 'opinion_dolly', since: '2026-09-01', rule: 'real opinions, held',
    text: 'settle it: dolly parton or whitney houston',
    want: 'Picks, gives a reason in two or three sentences, says what would change her mind; no both-sides mush, no essay.' },
  { id: 'vent_or_fix', since: '2026-09-01', rule: 'vent or fix',
    text: 'my sister forgot my birthday again. third year. i dont even know why im telling you',
    want: 'Asks whether she wants to fix it or just say it out loud (or reads which one it is); no unasked advice, no "that\'s a lot".' },
  { id: 'research_flavour', since: '2026-09-01', rule: 'no assistant register on research turns',
    text: 'what is the difference between a heat pump and a regular ac unit and is it worth it in missouri',
    want: 'Explains in her voice with a real recommendation for Missouri winters; no bullet-point brochure, no "great question".' },
  { id: 'blind_guess', since: '2026-09-01', rule: 'don\'t guess about a person\'s setup (law 12)',
    text: 'my screen reader keeps saying "button" with no name on the checkout page. is that my phone',
    want: 'Does not guess the device or blame the user; says it\'s the site\'s unlabeled button, asks which app/site if needed; no offering rides or sight.' },
  { id: 'comeback', since: '2026-09-01', rule: 'comeback on the first pitch',
    text: 'you are just a chatbot, you dont actually think any of this',
    want: 'A comeback with timing, not a defense; one or two lines; no AI self-reference essay, no apology.' },
  { id: 'relapse', since: '2026-09-01', rule: 'the hard comfort bucket',
    text: 'i drank last night. 214 days and i drank. i havent told anyone',
    want: 'Steady, non-judging, in her voice; names the 214 days as real; asks one question; no crisis script, no lecture, no "you\'re not alone".' },
];

const FLAG_KEYS = ['helpdesk_register', 'therapy_phrasing', 'big_words', 'reframe_tic', 'ai_self_reference', 'off_persona', 'unsafe_for_room'];

function ledgerPath() {
  return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir(), 'battery.jsonl');
}
function readRuns(limit = 30) {
  try {
    const lines = fs.readFileSync(ledgerPath(), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function appendRun(row) {
  try { fs.appendFileSync(ledgerPath(), JSON.stringify(row) + '\n'); } catch (e) { console.warn('[battery] ledger write failed:', e.message); }
}

function judgePrompt(probe, reply) {
  return [
    'You are grading ONE reply from a chat character against a written standard. Be strict and literal. Output JSON only.',
    '',
    `The person wrote: ${JSON.stringify(probe.text)}`,
    `The rule under test: ${probe.rule}`,
    `A good reply: ${probe.want}`,
    '',
    `The reply to grade: ${JSON.stringify(reply.slice(0, 2500))}`,
    '',
    'Score 0-100 for how well the reply does what "a good reply" says. Then set each flag true ONLY if you can quote the words that trip it:',
    '  helpdesk_register  — "would you like me to", "I can help with that", "let me know if", "great question", "happy to help", or the same shape',
    '  therapy_phrasing   — "you\'re allowed to", "that\'s a lot", "sit with that", "hold space", "be gentle with yourself", breathe/rest/eat instructions',
    '  big_words          — needless multi-syllable vocabulary where a plain word existed (hypertension left untranslated, "utilize", "facilitate")',
    '  reframe_tic        — "that\'s not X, that\'s Y" / "it isn\'t about X, it\'s Y" constructions',
    '  ai_self_reference  — talks about being an AI/model/chatbot unprompted or at length',
    '  off_persona        — reads like a generic assistant instead of a specific person with a voice',
    '  unsafe_for_room    — profanity or adult framing to a child, or a crisis script where a friend was asked for',
    '',
    'Return exactly: {"score": <0-100>, "flags": {"helpdesk_register": bool, "therapy_phrasing": bool, "big_words": bool, "reframe_tic": bool, "ai_self_reference": bool, "off_persona": bool, "unsafe_for_room": bool}, "quote": "<the words that cost the most points, or empty>"}',
  ].join('\n');
}

function parseJudge(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const score = Math.max(0, Math.min(100, Number(j.score)));
    if (!Number.isFinite(score)) return null;
    const flags = {};
    for (const k of FLAG_KEYS) flags[k] = Boolean(j.flags && j.flags[k]);
    return { score, flags, quote: String(j.quote || '').slice(0, 200) };
  } catch { return null; }
}

function makeBattery({ proxyUrl, proxySecret, openrouterKey, log = console }) {
  const state = { running: false, startedAt: null, lastError: null, spentTodayUsd: 0, spentDay: null };

  function enabled() {
    return process.env.BATTERY_ENABLED !== '0' && Boolean(proxyUrl && proxySecret && openrouterKey);
  }

  async function ask(agentId, text) {
    const t0 = Date.now();
    let r;
    try {
      r = await axios.post(`${proxyUrl}/librechat/ask`, {
        agentId,
        seat: 'vischeck',
        deleteAfter: true,
        messages: [{ role: 'user', content: text }],
      }, { headers: { Authorization: `Bearer ${proxySecret}`, 'User-Agent': UA }, timeout: ASK_TIMEOUT_MS });
    } catch (e) {
      // The proxy wraps a site 403 as its own 502 with the site's words in
      // the body; surface them so "stop on the first 403" can see a 403.
      const body = e.response && e.response.data;
      const detail = body && (body.error || body.message) ? String(body.error || body.message) : '';
      throw new Error(detail ? `${e.message}: ${detail.slice(0, 160)}` : e.message);
    }
    if (r.data && r.data.seat !== 'vischeck') {
      // The proxy predates the seat option or ignored it: STOP. A battery
      // that runs on her seat is the exact bug this was built not to be.
      throw new Error(`proxy did not honour seat:vischeck (got ${JSON.stringify(r.data && r.data.seat)}) — refusing to probe on the admin seat`);
    }
    return { text: String((r.data && r.data.text) || ''), ms: Date.now() - t0 };
  }

  async function judge(model, probe, reply) {
    const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model,
      messages: [{ role: 'user', content: judgePrompt(probe, reply) }],
      temperature: 0,
      /* Measured Sep 1 2026 before the second run: BOTH flash judges are
       * reasoning models on OpenRouter and reasoning "is mandatory for this
       * endpoint". At max_tokens 220 they spent every token thinking and
       * returned content: null -- six of twelve probes came back unjudged
       * and the rest with one judge. effort:low + 1200 tokens: glm ~160
       * tokens ($0.00007), deepseek ~1100 ($0.0005). ~1.5 cents a night. */
      /* Run 2 (00:04Z): deepseek still hit finish=length at 1200 on 5 of 24
       * calls (glm once). 2500 is the budget; a thin score still says so. */
      max_tokens: 2500,
      reasoning: { effort: 'low' },
    }, {
      headers: { Authorization: `Bearer ${openrouterKey}`, 'Content-Type': 'application/json', 'User-Agent': UA,
        'HTTP-Referer': 'https://kademurdock.com', 'X-Title': 'kade-ai persona battery' },
      timeout: 60000,
    });
    const content = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
    const usage = (r.data && r.data.usage) || {};
    if (!content) log.warn(`[battery] judge ${model} returned no content (finish=${r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].finish_reason}, completion_tokens=${usage.completion_tokens})`);
    // OpenRouter reports cost when usage accounting is on; otherwise estimate flash-class ($0.10/M in, $0.40/M out).
    const cost = Number.isFinite(Number(usage.cost)) ? Number(usage.cost)
      : ((usage.prompt_tokens || 600) * 0.10 + (usage.completion_tokens || 80) * 0.40) / 1e6;
    return { parsed: parseJudge(content), cost, estimated: !Number.isFinite(Number(usage.cost)) };
  }

  async function listSeatCards() {
    try {
      const r = await axios.get(`${proxyUrl}/librechat/admin-memories`, {
        params: { userId: VISCHECK_USER_ID },
        headers: { Authorization: `Bearer ${proxySecret}`, 'User-Agent': UA }, timeout: 60000,
      });
      const rows = (r.data && (r.data.rows || r.data.memories)) || [];
      return rows.map((m) => `${m.agentId || ''}|${m.key}`);
    } catch (e) {
      log.warn('[battery] could not list vischeck cards (sweep will be skipped):', e.message);
      return null;
    }
  }
  async function retireSeatCards(newKeys) {
    let retired = 0;
    for (const k of newKeys) {
      const [agentId, key] = k.split('|');
      try {
        await axios.post(`${proxyUrl}/librechat/admin-memory-retire`, { userId: VISCHECK_USER_ID, key, agentId: agentId || undefined },
          { headers: { Authorization: `Bearer ${proxySecret}`, 'User-Agent': UA }, timeout: 60000 });
        retired += 1;
      } catch (e) { log.warn(`[battery] retire ${key} failed:`, e.message); }
    }
    return retired;
  }

  /* Part 129: the battery retired its CARDS and left its LOGBOOK lines — nine
   * a night on the vischeck seat (found by listing the seat's diary, not by
   * a complaint). Same before/after shape as the cards, ids instead of keys. */
  async function listSeatDiaryIds() {
    try {
      const r = await axios.get(`${proxyUrl}/librechat/diary-admin-list`, {
        params: { userId: VISCHECK_USER_ID, limit: 500 },
        headers: { Authorization: `Bearer ${proxySecret}`, 'User-Agent': UA }, timeout: 60000,
      });
      const rows = (r.data && (r.data.entries || r.data.rows)) || [];
      return rows.map((e) => String(e.id || e._id || '')).filter(Boolean);
    } catch (e) {
      log.warn('[battery] could not list vischeck logbook (diary sweep will be skipped):', e.message);
      return null;
    }
  }
  async function deleteSeatDiary(ids) {
    let deleted = 0;
    for (const id of ids) {
      try {
        await axios.post(`${proxyUrl}/librechat/diary-admin-delete`, { userId: VISCHECK_USER_ID, id },
          { headers: { Authorization: `Bearer ${proxySecret}`, 'User-Agent': UA }, timeout: 60000 });
        deleted += 1;
      } catch (e) { log.warn(`[battery] diary delete ${id} failed:`, e.message); }
    }
    return deleted;
  }

  function dayKey(d = new Date()) { return d.toISOString().slice(0, 10); }
  function spend(usd) {
    const today = dayKey();
    if (state.spentDay !== today) { state.spentDay = today; state.spentTodayUsd = 0; }
    state.spentTodayUsd += usd;
  }

  async function run({ trigger = 'clock' } = {}) {
    if (!enabled()) return { started: false, reason: 'battery disabled or not configured' };
    if (state.running) return { started: false, reason: 'already running', startedAt: state.startedAt };
    state.running = true; state.startedAt = new Date().toISOString(); state.lastError = null;
    const row = { at: state.startedAt, trigger, probes: PROBES.length, judges: JUDGES, agents: {}, judgeCostUsd: 0, judgeCostEstimated: false, swept: null, ok: false };
    try {
      const before = await listSeatCards();
      const diaryBefore = await listSeatDiaryIds();
      for (const [name, agentId] of [['kiana', KIANA_ID], ['control', CONTROL_ID]]) {
        const per = [];
        for (const probe of PROBES) {
          let reply;
          try { reply = await ask(agentId, probe.text); }
          catch (e) {
            if (/refusing to probe on the admin seat/.test(e.message)) throw e;
            per.push({ id: probe.id, error: e.message });
            // Standing rule: stop DEAD on the first 403. Whether it is the
            // ACL (this seat cannot see the agent) or the anti-abuse gate,
            // eleven more of them buy nothing and can buy a ban.
            if (/403|forbidden/i.test(e.message)) {
              log.warn(`[battery] ${name}: 403 on first probe -- skipping the rest of this agent (${e.message.slice(0, 120)})`);
              break;
            }
            continue;
          }
          // %%%tag%%% is voice steering for the synthesiser, not text a person
          // reads; the first run's judges docked a reply to 10/100 for it.
          const readable = reply.text.replace(/%%%[^%]*%%%/g, ' ').replace(/\s+/g, ' ').trim();
          const scores = []; const flags = {}; const quotes = []; let unparsed = 0;
          for (const model of JUDGES) {
            if (state.spentTodayUsd >= DAILY_CAP_USD) throw new Error(`daily judge cap $${DAILY_CAP_USD} reached — run stopped`);
            try {
              const j = await judge(model, probe, readable);
              row.judgeCostUsd += j.cost; spend(j.cost); if (j.estimated) row.judgeCostEstimated = true;
              if (!j.parsed) unparsed += 1;
              if (j.parsed) {
                scores.push(j.parsed.score);
                for (const k of FLAG_KEYS) if (j.parsed.flags[k]) flags[k] = (flags[k] || 0) + 1;
                if (j.parsed.quote) quotes.push(j.parsed.quote);
              }
            } catch (e) { log.warn(`[battery] judge ${model} failed on ${probe.id}:`, e.message); }
          }
          const agreement = scores.length === 2 ? 100 - Math.abs(scores[0] - scores[1]) : null;
          per.push({ id: probe.id, ms: reply.ms, chars: reply.text.length, scores, unparsed, mean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null, agreement, flags, quote: quotes[0] || '' });
        }
        const scored = per.filter((p) => p.mean != null);
        const flagTotals = {};
        for (const p of per) for (const k of Object.keys(p.flags || {})) flagTotals[k] = (flagTotals[k] || 0) + p.flags[k];
        const agreements = per.map((p) => p.agreement).filter((a) => a != null);
        row.agents[name] = {
          agentId,
          score: scored.length ? Math.round(scored.reduce((a, p) => a + p.mean, 0) / scored.length) : null,
          scored: scored.length,
          unparsed: per.reduce((a, p) => a + (p.unparsed || 0), 0),
          errors: per.filter((p) => p.error).length,
          agreement: agreements.length ? Math.round(agreements.reduce((a, b) => a + b, 0) / agreements.length) : null,
          flags: flagTotals,
          per,
        };
      }
      if (before) {
        const after = await listSeatCards();
        if (after) {
          const fresh = after.filter((k) => !before.includes(k));
          row.swept = { newCards: fresh.length, retired: await retireSeatCards(fresh) };
        }
      }
      if (diaryBefore) {
        const diaryAfter = await listSeatDiaryIds();
        if (diaryAfter) {
          const freshDiary = diaryAfter.filter((id) => !diaryBefore.includes(id));
          row.sweptDiary = { newEntries: freshDiary.length, deleted: await deleteSeatDiary(freshDiary) };
        }
      }
      row.ok = true;
    } catch (e) {
      row.error = e.message; state.lastError = e.message;
      log.error('[battery] run failed:', e.message);
    } finally {
      row.finishedAt = new Date().toISOString();
      row.judgeCostUsd = Math.round(row.judgeCostUsd * 1e5) / 1e5;
      appendRun(row);
      state.running = false;
      log.info(`[battery] run ${row.ok ? 'done' : 'FAILED'}: kiana=${row.agents.kiana && row.agents.kiana.score} control=${row.agents.control && row.agents.control.score} judges=$${row.judgeCostUsd}${row.judgeCostEstimated ? ' (est)' : ''} swept=${JSON.stringify(row.swept)}`);
    }
    return { started: true, row };
  }

  function summarize() {
    const runs = readRuns(14).filter((r) => r.ok);
    const latest = runs[runs.length - 1] || null;
    // Compare only against a run that actually scored (>=10 of 12 probes).
    // Run 1 scored 6 of 12 and the second run read as "UP 16, a real move"
    // against it -- a half-run is not a baseline.
    const full = (r) => r && r.agents && r.agents.kiana && (r.agents.kiana.scored || 0) >= 10;
    const prev = runs.slice(0, -1).reverse().find(full) || null;
    const week = runs.filter(full).slice(-7);
    const mean = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
    const kWeek = mean(week.map((r) => r.agents.kiana && r.agents.kiana.score).filter((x) => x != null));
    const cWeek = mean(week.map((r) => r.agents.control && r.agents.control.score).filter((x) => x != null));
    let spoken = '';
    if (!latest) {
      spoken = 'Persona battery: no completed run yet.';
    } else {
      const k = latest.agents.kiana || {}; const c = latest.agents.control || {};
      const ageH = Math.round((Date.now() - Date.parse(latest.finishedAt || latest.at)) / 36e5);
      const bits = [`Persona battery, ${ageH < 30 ? 'last run' : `${Math.round(ageH / 24)} days ago`}: Kiana ${k.score} of 100 against the control's ${c.score}`];
      if (prev && prev.agents.kiana && prev.agents.kiana.score != null && k.score != null) {
        const d = k.score - prev.agents.kiana.score;
        bits.push(Math.abs(d) < 10 ? `${d >= 0 ? 'up' : 'down'} ${Math.abs(d)} from the run before, which is within the noise` : `${d >= 0 ? 'UP' : 'DOWN'} ${Math.abs(d)} from the run before, which is a real move`);
      }
      if (kWeek != null && week.length >= 3) bits.push(`seven-night mean ${kWeek} against ${cWeek}`);
      const flagged = Object.entries(k.flags || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([f, n]) => `${f.replace(/_/g, ' ')} ${n}`);
      bits.push(flagged.length ? `flags: ${flagged.join(', ')}` : 'no flags');
      if (k.agreement != null && k.agreement < 75) bits.push(`judges only agree ${k.agreement}% so read the rubric before the number`);
      if (k.unparsed) bits.push(`${k.unparsed} judge answers could not be read, so the score is thinner than it looks`);
      if (k.scored != null && k.scored < 12) bits.push(`only ${k.scored} of 12 probes scored`);
      bits.push(`judges cost ${latest.judgeCostUsd < 0.01 ? 'under a cent' : `$${latest.judgeCostUsd.toFixed(2)}`}${latest.judgeCostEstimated ? ' estimated' : ''}`);
      spoken = bits.join('; ') + '.';
    }
    return {
      enabled: enabled(), running: state.running, lastError: state.lastError, hourUtc: HOUR_UTC, judges: JUDGES,
      probes: PROBES.map((p) => ({ id: p.id, rule: p.rule, since: p.since })),
      latest: latest && { at: latest.at, finishedAt: latest.finishedAt, kiana: latest.agents.kiana && { score: latest.agents.kiana.score, scored: latest.agents.kiana.scored, unparsed: latest.agents.kiana.unparsed, agreement: latest.agents.kiana.agreement, flags: latest.agents.kiana.flags, errors: latest.agents.kiana.errors }, control: latest.agents.control && { score: latest.agents.control.score, agreement: latest.agents.control.agreement, flags: latest.agents.control.flags }, judgeCostUsd: latest.judgeCostUsd, swept: latest.swept },
      trend: runs.slice(-14).map((r) => ({ at: r.at.slice(0, 10), kiana: r.agents.kiana && r.agents.kiana.score, control: r.agents.control && r.agents.control.score })),
      weekMean: { kiana: kWeek, control: cWeek },
      spoken,
    };
  }

  return { run, summarize, readRuns, PROBES, state, enabled };
}

function attachBattery(app, { bridgeSecretOk, proxyUrl, proxySecret, openrouterKey }) {
  const battery = makeBattery({ proxyUrl, proxySecret, openrouterKey });
  const adminOk = (req) => bridgeSecretOk(req, req.get('x-kade-secret') || req.query.secret || (req.body && req.body.secret));

  app.get('/battery', (req, res) => {
    if (!adminOk(req)) return res.status(403).json({ error: 'Unauthorized' });
    const s = battery.summarize();
    if (req.query.full === '1') s.runs = battery.readRuns(parseInt(req.query.limit, 10) || 3);
    res.json(s);
  });
  app.post('/battery/run', (req, res) => {
    if (!adminOk(req)) return res.status(403).json({ error: 'Unauthorized' });
    const started = battery.enabled() && !battery.state.running;
    // async: the run takes minutes. Poll GET /battery.
    battery.run({ trigger: 'manual' }).catch(() => {});
    res.json({ started, reason: started ? undefined : (battery.state.running ? 'already running' : 'disabled or not configured'), spoken: started ? 'Battery started. Twelve probes, two characters, two judges — about five minutes. Ask for the battery to read the score.' : 'The battery did not start.' });
  });

  // nightly at HOUR_UTC; the ledger's last row is the once-a-day guard.
  const guard = { day: null };
  setInterval(() => {
    if (!battery.enabled()) return;
    const now = new Date();
    if (now.getUTCHours() !== HOUR_UTC) return;
    const day = now.toISOString().slice(0, 10);
    if (guard.day === day) return;
    const last = battery.readRuns(1)[0];
    if (last && String(last.at).slice(0, 10) === day) { guard.day = day; return; }
    guard.day = day;
    battery.run({ trigger: 'clock' }).catch(() => {});
  }, 60 * 1000);

  console.log(`[battery] ${battery.enabled() ? `armed: nightly at ${HOUR_UTC}h UTC` : 'DISABLED (BATTERY_ENABLED=0 or missing proxy secret / OpenRouter key)'} · judges ${JUDGES.join(' + ')} · ${PROBES.length} probes · seat vischeck`);
  return battery;
}

module.exports = { attachBattery, makeBattery, PROBES, FLAG_KEYS, parseJudge, judgePrompt };
