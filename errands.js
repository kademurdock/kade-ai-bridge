/* errands.js — ERRANDS WITH RECEIPTS (Part 66, Aug 15 2026).
 * ──────────────────────────────────────────────────────────────────────────
 * HER FRAME, which is the whole design: she tells Kiana "run me an errand:
 * find the cheapest chest freezer between Springfield stores and tell me who
 * has it," walks away, and later Kiana comes back with WHAT SHE DID AND HOW
 * SHE KNOWS. Not a wall of links — a step-by-step ledger she can HEAR.
 *
 * So the receipts ARE the product. Every read of an errand returns a
 * `spokenSummary`: one plain paragraph, newest news first, no bullet soup, no
 * markdown, no "see below." A sighted user can skim a table; she cannot, so
 * the summary has to carry the answer in its first sentence and the proof in
 * its last. If you ever find yourself formatting an errand for the eye,
 * you have taken the feature away from the person it was built for.
 *
 * AN ERRAND = a tracked, resumable, multi-step job with an audit trail.
 *   queued -> running -> (awaiting_confirm -> running)* -> done | failed | cancelled
 * Steps are append-only. Nothing is ever rewritten, because a receipt you can
 * edit after the fact is not a receipt.
 *
 * RUNG 1 (this file, shipped complete): plan / research / confirm / notify.
 * The research step does NOT reimplement research — it calls the existing
 * deep-research engine (research.js, Aug 10) through its internal desk, and
 * the research job id goes IN the errand ledger so the two audit trails
 * stitch together. Rung 2 (call_business) and rung 3 (make_document) bolt on
 * as new step kinds; the runner's switch is the seam they land in.
 *
 * MONEY, because a background job that can spend is a job that can run away:
 *   - per-errand cap ERRAND_BUDGET_USD (default $0.25). Checked BEFORE every
 *     spending step, not after. Hitting it is not a failure — the errand
 *     stops, says "budget reached, here's what I have so far," and keeps its
 *     receipts. A partial errand you can hear beats a silent overrun.
 *   - research costs are pulled off the research job's own tally, so the
 *     ledger's number is the real number and not an estimate of an estimate.
 *   - daily + concurrency caps mirror research.js's.
 *
 * WHO CAN RUN ONE (v1): Kade's seat only. The fork tool carries the four-way
 * owner gate (authed id + ADMIN role + acting identity + no kadeOnBehalfOf),
 * and THIS FILE re-checks the userId server-side anyway — ERRAND_OWNER_ONLY
 * defaults to true. Defense in depth: a tool gate protects against a confused
 * agent, a server gate protects against a leaked secret. Widen later with
 * ERRAND_USERS (comma-separated ids) when she says so, not before.
 *
 * Secrets: BRIDGE_SECRET (admin), or the scoped ERRAND_TOOL_SECRET (upserted
 * on the bridge AND LibreChat Aug 15; value only in Railway — same pattern as
 * NOTIFY_AGENT_SECRET / NVDA_TOOL_SECRET / MEMORY_TOOL_SECRET).
 *
 * WIRING (server.js, after runNotify exists and AFTER attachResearch, because
 * the research desk must be constructed before an errand can borrow it):
 *   const { attachErrands } = require('./errands');
 *   attachErrands(app, { bridgeSecretOk, notifySecretOk, runNotify });
 * Env needed here: MOONSHOT_KEY (planner/writer), ERRAND_TOOL_SECRET.
 * Kill switch: ERRANDS_ENABLED=0.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const express = require('express');

const { researchDesk } = require('./research');

/* ---------- config ---------- */
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir();
const ERRANDS_FILE = path.join(DATA_DIR, 'errands.json');
const RECEIPTS_FILE = path.join(DATA_DIR, 'errand-receipts.jsonl');

const MOONSHOT_URL = (process.env.MOONSHOT_URL || 'https://api.moonshot.ai/v1').replace(/\/$/, '');
const MOONSHOT_KEY = process.env.MOONSHOT_KEY || '';
const MODEL_PLAN = process.env.ERRAND_PLAN_MODEL || 'kimi-k2.6';
const MODEL_WRITE = process.env.ERRAND_WRITE_MODEL || 'kimi-k2.6';

/* $/M tokens. Same table research.js carries; override with ERRAND_PRICES. */
let PRICES = { 'kimi-k3': { in: 3, out: 15 }, 'kimi-k2.6': { in: 0.95, out: 4 } };
try { if (process.env.ERRAND_PRICES) PRICES = { ...PRICES, ...JSON.parse(process.env.ERRAND_PRICES) }; } catch { /* keep defaults */ }

const BUDGET_USD = Math.max(0.02, parseFloat(process.env.ERRAND_BUDGET_USD) || 0.25);
const DAILY_CAP = Math.max(1, parseInt(process.env.ERRAND_DAILY_CAP, 10) || 6);
const ACTIVE_CAP = Math.max(1, parseInt(process.env.ERRAND_ACTIVE_CAP, 10) || 3);
const MAX_STEPS = Math.max(2, parseInt(process.env.ERRAND_MAX_STEPS, 10) || 6);
const CONFIRM_TTL_MS = Math.max(600000, parseInt(process.env.ERRAND_CONFIRM_TTL_MS, 10) || 12 * 60 * 60 * 1000);
const ERRANDS_KEPT = 60;
/* RUNG 2 — CALLING A BUSINESS. Every number here is a rail, and every rail
 * lives in CODE rather than in a prompt, because a prompt is a suggestion and
 * this feature dials real strangers on her behalf.
 *   - the window: no business gets called before 9am or after 8pm Central.
 *     Configurable so a session can widen it for a supervised test, never so
 *     an agent can. The check runs at dial time, not at plan time.
 *   - the confirm: a call step CANNOT be reached without her spoken yes on
 *     that exact who/why/number. Enforced by the runner, not by wording.
 *   - the ceiling: at most CALLS_PER_ERRAND calls in one errand, so a runaway
 *     plan cannot dial a phone tree. */
const CALL_START_HHMM = String(process.env.ERRAND_CALL_START || '09:00');
const CALL_END_HHMM = String(process.env.ERRAND_CALL_END || '20:00');
const CALLS_PER_ERRAND = Math.max(1, parseInt(process.env.ERRAND_CALLS_PER_ERRAND, 10) || 2);
const CALL_WAIT_MS = Math.max(60000, parseInt(process.env.ERRAND_CALL_WAIT_MS, 10) || 8 * 60 * 1000);
const SELF_URL = `http://127.0.0.1:${process.env.PORT || 8080}`;

const OWNER_ID = process.env.ADMIN_USER_ID || '6a3cba4d0b0afa92194e42f7';
const OWNER_ONLY = process.env.ERRAND_OWNER_ONLY !== '0';
const EXTRA_USERS = String(process.env.ERRAND_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);

/* The statuses that mean "this errand is still someone's problem." */
const ACTIVE = ['queued', 'running', 'awaiting_confirm'];

function enabled() { return process.env.ERRANDS_ENABLED !== '0' && !!MOONSHOT_KEY; }
function disabledWhy() {
  if (process.env.ERRANDS_ENABLED === '0') return 'errands are switched off (ERRANDS_ENABLED=0)';
  if (!MOONSHOT_KEY) return 'MOONSHOT_KEY is not set on the bridge';
  return '';
}
function userAllowed(userId) {
  if (!OWNER_ONLY) return true;
  return userId === OWNER_ID || EXTRA_USERS.includes(userId);
}

/* ---------- persistence (bridge house style: tiny JSON on the volume) ---------- */
const store = (() => {
  try { if (fs.existsSync(ERRANDS_FILE)) return JSON.parse(fs.readFileSync(ERRANDS_FILE, 'utf8')); } catch { /* fresh */ }
  return { errands: [] };
})();
function saveStore() {
  try { fs.writeFileSync(ERRANDS_FILE, JSON.stringify(store)); } catch (e) { console.error('[errand] store save:', e.message); }
}
function receipt(line) {
  try { fs.appendFileSync(RECEIPTS_FILE, JSON.stringify(line) + '\n'); } catch { /* receipts never break the run */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function centralDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function centralClockHHMM() {
  const s = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour12: false, hour: '2-digit', minute: '2-digit' });
  const m = s.match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '12:00';
}

/* ---------- the ledger ---------- */
/* Append-only, and every step carries what it cost. `detail` is for the eye
 * (a session reading logs); `summary` is for the ear (Kiana reading it out).
 * Keep summary a whole sentence — it gets spoken verbatim. */
function addStep(errand, kind, summary, detail = null, costUsd = 0) {
  errand.steps.push({
    ts: new Date().toISOString(),
    kind,
    summary: String(summary || '').slice(0, 400),
    detail: detail == null ? null : (typeof detail === 'string' ? detail.slice(0, 4000) : detail),
    costUsd: Math.round((costUsd || 0) * 1e5) / 1e5,
  });
  errand.costUsd = Math.round((errand.costUsd + (costUsd || 0)) * 1e5) / 1e5;
  saveStore();
  return errand.steps[errand.steps.length - 1];
}

function setStatus(errand, status, note) {
  errand.status = status;
  if (note != null) errand.stageNote = note;
  if (['done', 'failed', 'cancelled'].includes(status) && !errand.finishedAt) {
    errand.finishedAt = new Date().toISOString();
  }
  saveStore();
}

/* ---------- money ---------- */
function tally(errand, model, tin, tout) {
  const p = PRICES[model] || { in: 1, out: 5 };
  return Math.round(((tin * p.in + tout * p.out) / 1e6) * 1e5) / 1e5;
}
function budgetLeft(errand) { return Math.round((errand.budgetUsd - errand.costUsd) * 1e5) / 1e5; }
function overBudget(errand) { return errand.costUsd >= errand.budgetUsd; }

/* ---------- the model call ----------
 * Same two Moonshot traps research.js documents and pays for: (1) k2.6/k3
 * refuse any temperature but 1, so NO temperature rides these requests at
 * all; (2) without reasoning_effort:'none' the reasoning eats the whole
 * token budget and content comes back EMPTY with finish_reason 'length'.
 * Both are load-bearing — do not "tidy" them away. */
async function askModel(errand, model, messages, { maxTokens = 900, json = false } = {}) {
  const mk = (budget) => {
    const body = { model, messages, max_tokens: budget, reasoning_effort: 'none' };
    if (json) body.response_format = { type: 'json_object' };
    return body;
  };
  let budget = maxTokens;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep([2000, 8000][attempt - 1] || 8000);
    try {
      const r = await axios.post(`${MOONSHOT_URL}/chat/completions`, mk(budget), {
        timeout: 120000,
        headers: { Authorization: `Bearer ${MOONSHOT_KEY}`, 'Content-Type': 'application/json' },
      });
      const usage = r.data?.usage || {};
      const cost = tally(errand, model, usage.prompt_tokens || 0, usage.completion_tokens || 0);
      const choice = r.data?.choices?.[0] || {};
      const content = String(choice.message?.content || '');
      if (!content.trim() && choice.finish_reason === 'length') { budget *= 2; continue; }
      return { content, cost };
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      if (status && status !== 429 && status < 500) break;
    }
  }
  throw new Error(`model ${model}: ${lastErr?.response?.status || ''} ${lastErr?.message || 'empty reply'}`.trim());
}

function jsonFrom(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  for (let end = s.length; end > start; end--) {
    try { return JSON.parse(s.slice(start, end)); } catch { /* walk back */ }
  }
  return null;
}

/* ---------- the planner ----------
 * RUNG 1 KNOWS TWO VERBS. The prompt says so plainly rather than offering a
 * menu the runner can't cook: a planner told it may "call" or "write" will
 * plan calls and letters, and the runner would have to refuse them one by
 * one in front of her. When rung 2 and 3 land, this list grows and the
 * runner's switch grows with it — in the same commit, or not at all. */
function planPrompt(goal) {
  return [
    'You are the planning brain for an errand desk. Somebody asked for an errand to be run.',
    'Break it into the SMALLEST number of steps that actually answers them. Fewer steps is better.',
    '',
    `TODAY: ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date())} (US Central).`,
    '',
    'You may ONLY use these two step kinds:',
    '  {"kind":"research","question":"<a single self-contained question>","depth":"quick"|"standard"}',
    '      Looks things up on the live web and comes back with cited findings.',
    '      Use "quick" unless the question genuinely needs breadth; quick costs a fifth as much.',
    '  {"kind":"confirm","ask":"<a yes/no question for the person, written to be HEARD>"}',
    '      Stops the errand and waits for the person to say yes or no.',
    '      Use ONLY when a real decision is needed that you should not make for them.',
    '  {"kind":"call","who":"<the business by name>","why":"<the ONE thing to ask them, in a sentence>","number":"<10 digits, ONLY if the errand itself gave you the number>"}',
    '      Phones a business and asks. Use ONLY when the answer genuinely is not on the web —',
    '      today\'s stock, today\'s hours after a holiday, whether they still do a thing.',
    '      Include "number" ONLY when the errand text above literally contains the phone number.',
    '      Otherwise leave it out and put a research step BEFORE the call so the number can be',
    '      looked up. NEVER write a number you were not given — a made-up number dials a stranger.',
    '      The person is asked to approve every single call before it is placed, by name and',
    '      number, so plan a call only when it is worth interrupting them for.',
    '',
    `Hard limits: at most ${MAX_STEPS} steps, at most 3 research steps, at most ${CALLS_PER_ERRAND} call steps.`,
    'Do not invent facts, phone numbers, or prices. Do not plan emails, purchases, or documents — you cannot do those.',
    '',
    'Answer with JSON only:',
    '{"steps":[...],"say":"<one short plain sentence telling the person what you are about to go do, written to be heard out loud>"}',
    '',
    `THE ERRAND: ${goal}`,
  ].join('\n');
}

/* The closing word. This is the sentence she actually hears, so it is written
 * for the ear on purpose: answer first, proof last, no markdown, no lists. */
function wrapPrompt(errand, findings) {
  return [
    'You are reporting back on an errand you just ran for someone. They are blind and will HEAR this, not read it.',
    '',
    'Rules, all of them load-bearing:',
    '  - Lead with the ANSWER. First sentence. Not a preamble, not "I looked into this."',
    '  - Then the specifics that matter: names, prices, numbers, who has what.',
    '  - Then one short sentence on how you know it (how many sources, how solid).',
    '  - If the answer is uncertain or you came up short, SAY SO plainly. Do not pad.',
    '  - Plain spoken English. No markdown, no bullet points, no headings, no asterisks,',
    '    no URLs read aloud, no "click here." Numbers written the way a person says them.',
    '  - Four sentences or fewer. Under 120 words. This is the summary, not the report.',
    '',
    `THE ERRAND THEY ASKED FOR: ${errand.goal}`,
    '',
    'WHAT YOU FOUND:',
    findings.slice(0, 14000),
  ].join('\n');
}

/* ---------- the spoken composer ----------
 * Every read returns this. Newest news FIRST, because the first thing out of
 * Kiana's mouth should be the thing that changed. Then the ledger in plain
 * past tense, then the money. Built from the steps, never from a cached
 * string, so it can never drift from what actually happened. */
/* Free text from a model, an error string or her own words gets spoken
 * verbatim, so it has to arrive as a SENTENCE. Screen readers run one clause
 * straight into the next when the punctuation is missing — "the research desk
 * was full Every step is in the receipts" is what that sounds like. */
function sentence(t, mark = '.') {
  const x = String(t || '').replace(/\s+/g, ' ').trim();
  if (!x) return '';
  const capped = x[0].toUpperCase() + x.slice(1);
  return /[.!?…]$/.test(capped) ? capped : `${capped}${mark}`;
}

function spokenSummary(errand) {
  const s = errand.steps || [];
  const research = s.filter((x) => x.kind === 'research');
  const done = research.filter((x) => x.detail && x.detail.ok);
  const parts = [];

  if (errand.status === 'done') {
    parts.push(errand.answer ? sentence(errand.answer) : 'Done.');
  } else if (errand.status === 'awaiting_confirm') {
    parts.push(`I need a yes or no from you before I go on. ${sentence(errand.pending?.ask || 'Should I keep going', '?')}`);
  } else if (errand.status === 'failed') {
    parts.push(`This one didn't work out. ${sentence(errand.error || 'It hit a wall')}`);
  } else if (errand.status === 'cancelled') {
    parts.push('You called this one off.');
  } else if (errand.status === 'queued') {
    parts.push('Not started yet — it is waiting its turn.');
  } else {
    parts.push(`Still working. Right now: ${String(errand.stageNote || 'thinking it through').replace(/\.$/, '')}.`);
  }

  /* The ledger, spoken. Deliberately counts rather than lists: "three lookups"
   * is hearable, six run-on step names are not. The full list is one more
   * question away (action=receipts) and Kiana knows to offer it. */
  const ledger = [];
  if (research.length === 1) {
    ledger.push(done.length ? 'the lookup finished' : 'the lookup is still going');
  } else if (research.length > 1) {
    ledger.push(`${done.length} of ${research.length} lookups finished`);
  }
  const sources = research.reduce((n, x) => n + (x.detail?.sources || 0), 0);
  if (sources) ledger.push(`${sources} ${sources === 1 ? 'source' : 'sources'} read`);
  const calls = s.filter((x) => x.kind === 'call_business' && x.detail?.ok).length;
  if (calls) ledger.push(`${calls} ${calls === 1 ? 'call' : 'calls'} placed`);
  const docs = s.filter((x) => x.kind === 'make_document').length;
  if (docs) ledger.push(`${docs} ${docs === 1 ? 'document' : 'documents'} written`);
  if (ledger.length) parts.push(`Along the way: ${ledger.join(', ')}.`);

  if (errand.costUsd > 0) {
    const cents = Math.round(errand.costUsd * 100);
    parts.push(cents < 1 ? 'It cost less than a penny.' : `It cost about ${cents} ${cents === 1 ? 'cent' : 'cents'}.`);
  }
  if (errand.budgetStopped) {
    parts.push('I stopped there because the errand hit its spending limit — everything above is real, there just is not more of it.');
  }
  if (s.length) parts.push('Every step is in the receipts if you want to hear them.');
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function errandPublic(e, withSteps = false) {
  const out = {
    id: e.id,
    goal: e.goal,
    status: e.status,
    stageNote: e.stageNote,
    createdAt: e.createdAt,
    finishedAt: e.finishedAt || null,
    stepCount: e.steps.length,
    costUsd: e.costUsd,
    budgetUsd: e.budgetUsd,
    awaiting: e.status === 'awaiting_confirm' ? { ask: e.pending?.ask || '', since: e.pending?.since || null } : null,
    answer: e.answer || null,
    error: e.error || null,
    spokenSummary: spokenSummary(e),
  };
  if (withSteps) {
    out.steps = e.steps.map((x) => ({ ts: x.ts, kind: x.kind, summary: x.summary, costUsd: x.costUsd, detail: x.detail }));
  }
  return out;
}

/* ---------- the runner ---------- */
let working = false;

async function runErrand(errand, deps) {
  const t0 = Date.now();
  try {
    /* ---- PLAN (only once; a resumed errand keeps the plan it already has) ---- */
    if (!errand.plan) {
      setStatus(errand, 'running', 'working out what this takes');
      const { content, cost } = await askModel(errand, MODEL_PLAN, [{ role: 'user', content: planPrompt(errand.goal) }], { maxTokens: 900, json: true });
      const plan = jsonFrom(content) || {};
      const raw = Array.isArray(plan.steps) ? plan.steps : [];
      let callsSeen = 0;
      const steps = raw
        .filter((x) => x && (x.kind === 'research' || x.kind === 'confirm' || x.kind === 'call'))
        .filter((x) => (x.kind === 'call' ? ++callsSeen <= CALLS_PER_ERRAND : true))
        .slice(0, MAX_STEPS);
      const dropped = raw.length - steps.length;
      errand.plan = steps;
      errand.cursor = 0;
      addStep(errand, 'plan',
        steps.length
          ? `${plan.say || 'Here is the plan.'} That is ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}.`
          : 'I could not turn this into steps I know how to run.',
        { steps, dropped, say: plan.say || null }, cost);
      if (dropped > 0) {
        addStep(errand, 'note', `${dropped} planned ${dropped === 1 ? 'step was' : 'steps were'} something I can't do yet, so I left ${dropped === 1 ? 'it' : 'them'} out instead of pretending.`, { dropped });
      }
      if (!steps.length) {
        errand.error = 'nothing runnable in the plan';
        setStatus(errand, 'failed', 'could not break this into steps I can run');
        return;
      }
    }

    /* ---- WALK THE PLAN ---- */
    while (errand.cursor < errand.plan.length) {
      if (errand.cancelRequested) {
        addStep(errand, 'note', 'You called it off, so I stopped here.');
        setStatus(errand, 'cancelled', 'cancelled partway');
        return;
      }
      const step = errand.plan[errand.cursor];

      /* Budget is checked BEFORE spending, never after. */
      if (overBudget(errand)) {
        errand.budgetStopped = true;
        addStep(errand, 'budget_stop', `I stopped at the spending limit of ${Math.round(errand.budgetUsd * 100)} cents. What I already found still stands.`, { spent: errand.costUsd });
        break;
      }

      if (step.kind === 'confirm') {
        errand.pending = { ask: String(step.ask || 'Should I keep going?').slice(0, 300), since: new Date().toISOString(), cursor: errand.cursor, kind: 'plan_confirm' };
        addStep(errand, 'wait_confirm', `I stopped to ask: ${errand.pending.ask}`, { ask: errand.pending.ask });
        setStatus(errand, 'awaiting_confirm', 'waiting on your yes or no');
        await pushOut(errand, deps, 'A question on your errand', `${errand.pending.ask} Tell Kiana yes or no.`);
        return; // resumes from POST /errand/:id/confirm
      }

      if (step.kind === 'research') {
        setStatus(errand, 'running', 'looking things up');
        const question = String(step.question || errand.goal).slice(0, 600);
        const depth = step.depth === 'standard' ? 'standard' : 'quick';
        const started = researchDesk.createJob({
          userId: errand.userId, agentId: errand.agentId, agentName: errand.agentName,
          question, depth,
          // The errand does its own tap on the shoulder when the WHOLE job is
          // done. Letting the research desk push too means two buzzes for one
          // piece of news, three seconds apart.
          notify: false,
        });
        if (!started.ok) {
          addStep(errand, 'research', `I couldn't start that lookup: ${started.error}`, { ok: false, error: started.error, question });
          errand.cursor += 1;
          continue;
        }
        addStep(errand, 'research', `Started looking up: ${question}`, { ok: null, researchId: started.id, question, depth });

        const job = await waitForResearch(started.id, errand);
        const last = errand.steps[errand.steps.length - 1];
        if (job && job.status === 'done') {
          const srcs = job.sourcesFound || 0;
          last.detail = { ok: true, researchId: started.id, question, depth, sources: srcs, report: (job.report || '').slice(0, 9000) };
          last.summary = `Looked up: ${question} — answered from ${srcs} ${srcs === 1 ? 'source' : 'sources'}.`;
          last.costUsd = Math.round((job.costs?.estUSD || 0) * 1e5) / 1e5;
          errand.costUsd = Math.round((errand.costUsd + last.costUsd) * 1e5) / 1e5;
        } else {
          const why = job ? (job.error || job.status) : 'it never came back';
          last.detail = { ok: false, researchId: started.id, question, depth, error: why };
          last.summary = `That lookup didn't finish: ${why}.`;
          last.costUsd = Math.round((job?.costs?.estUSD || 0) * 1e5) / 1e5;
          errand.costUsd = Math.round((errand.costUsd + last.costUsd) * 1e5) / 1e5;
        }
        saveStore();
        errand.cursor += 1;
        continue;
      }

      if (step.kind === 'call') {
        const outcome = await runCallStep(errand, step, deps);
        if (outcome === 'parked') return;   // waiting on her yes — resumes on confirm
        errand.cursor += 1;
        continue;
      }

      /* Unknown kind — cannot happen through the planner's filter, but a
       * resumed errand from an older build could carry one. Say so; don't skip
       * silently. */
      addStep(errand, 'note', `I don't know how to run a "${step.kind}" step, so I skipped it.`, { step });
      errand.cursor += 1;
    }

    /* ---- WRAP: the sentence she actually hears ---- */
    await wrapUp(errand, deps);
  } catch (e) {
    errand.error = e.message;
    addStep(errand, 'note', `It hit a wall: ${e.message}`);
    setStatus(errand, 'failed', `hit a wall: ${e.message}`);
    await pushOut(errand, deps, 'Your errand hit a wall', `"${cut(errand.goal, 60)}" — ${cut(e.message, 120)} Ask Kiana for the receipts.`);
    console.error(`[errand] ${errand.id} failed:`, e.message);
  } finally {
    receipt({
      at: new Date().toISOString(), id: errand.id, userId: errand.userId,
      status: errand.status, goal: errand.goal.slice(0, 140),
      steps: errand.steps.length, costUsd: errand.costUsd,
      seconds: Math.round((Date.now() - t0) / 1000),
    });
    saveStore();
  }
}

/* ---------- RUNG 2: calling a business ----------
 * Three things happen here in a fixed order and the order is the safety:
 *   1. RESOLVE a real number — from the plan if the planner was handed one,
 *      otherwise pulled out of what the research steps actually read. A number
 *      the model invented is the one failure mode that dials a stranger, so
 *      an unresolvable number ends the step honestly instead of guessing.
 *   2. ASK HER, by name and number and reason, and STOP. No yes, no call.
 *      This is a return out of the runner, not a prompt instruction.
 *   3. Only then dial, through the bridge's own /outbound-call route so every
 *      guard that route already carries (allowlist, daily ceiling, callee-name
 *      sanity, disclosure-first greeting) applies unchanged.
 */
function withinCallWindow() {
  const now = centralClockHHMM();
  return now >= CALL_START_HHMM && now < CALL_END_HHMM;
}

function prettyNumber(e164) {
  const d = String(e164 || '').replace(/\D/g, '').replace(/^1/, '');
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : String(e164 || '');
}

function findingsText(errand) {
  return errand.steps
    .filter((x) => x.detail && x.detail.ok && x.detail.report)
    .map((x) => x.detail.report)
    .join('\n\n');
}

/* Pull a phone number for `who` out of what the errand actually READ. Returns
 * null rather than a guess — "I could not find a number" is a fine answer and
 * a wrong number is not. */
async function resolveNumber(errand, step) {
  const direct = String(step.number || '').replace(/\D/g, '');
  if (direct.length === 10 || (direct.length === 11 && direct.startsWith('1'))) {
    return { number: direct.slice(-10), name: String(step.who || '').slice(0, 60), from: 'the plan' };
  }
  const findings = findingsText(errand);
  if (!findings) return null;
  const { content, cost } = await askModel(errand, MODEL_WRITE, [{
    role: 'user',
    content: [
      'Pull ONE US phone number out of the notes below — the number for this business and no other.',
      'If the notes do not clearly contain that business\'s own phone number, say so. Never guess, never',
      'reconstruct a number from a pattern, never return a number that belongs to a different business.',
      '',
      `THE BUSINESS: ${step.who || errand.goal}`,
      '',
      'Answer with JSON only: {"found":true|false,"name":"<business name as written>","number":"<10 digits, no punctuation>"}',
      '',
      'NOTES:',
      findings.slice(0, 9000),
    ].join('\n'),
  }], { maxTokens: 200, json: true });
  addStep(errand, 'note', 'Looked through what I read for their phone number.', null, cost);
  const j = jsonFrom(content) || {};
  const digits = String(j.number || '').replace(/\D/g, '').replace(/^1/, '');
  if (j.found !== true || digits.length !== 10) return null;
  return { number: digits, name: String(j.name || step.who || '').slice(0, 60), from: 'what I read' };
}

async function runCallStep(errand, step, deps) {
  /* Already approved on a previous pass? Then this is the dial. */
  if (step.approvedNumber) return await placeCall(errand, step, deps);

  if (!process.env.BRIDGE_SECRET) {
    addStep(errand, 'note', 'I am not set up to place calls on this server, so I skipped that step.');
    return 'skipped';
  }
  const placed = errand.steps.filter((x) => x.kind === 'call_business').length;
  if (placed >= CALLS_PER_ERRAND) {
    addStep(errand, 'note', `I had already made ${placed} ${placed === 1 ? 'call' : 'calls'} on this errand, which is the limit, so I did not make another.`);
    return 'skipped';
  }
  if (!withinCallWindow()) {
    addStep(errand, 'note',
      `It is ${centralClockHHMM()} here, and I do not call businesses outside ${CALL_START_HHMM} to ${CALL_END_HHMM}. Ask me again during the day and I will make the call.`,
      { now: centralClockHHMM(), window: [CALL_START_HHMM, CALL_END_HHMM] });
    return 'skipped';
  }

  const resolved = await resolveNumber(errand, step);
  if (!resolved) {
    addStep(errand, 'note', `I could not find a phone number for ${step.who || 'them'} in anything I read, and I am not going to dial a number I made up. That call did not happen.`, { who: step.who || null });
    return 'skipped';
  }

  /* THE GATE. Who, why, and the number — read out loud, and nothing dials
   * until she answers. Parking here is the mechanism, not the message. */
  step.approvedNumber = null;
  step.pendingNumber = resolved.number;
  step.pendingName = resolved.name;
  const ask = `You want me to call ${resolved.name} at ${prettyNumber(resolved.number)}, to ask ${String(step.why || 'about this errand').replace(/\.$/, '')}. Should I make that call?`;
  errand.pending = { ask, since: new Date().toISOString(), cursor: errand.cursor, kind: 'call_confirm' };
  addStep(errand, 'wait_confirm', `I stopped to ask before dialing anyone: ${ask}`, { ask, who: resolved.name, number: resolved.number, foundIn: resolved.from });
  setStatus(errand, 'awaiting_confirm', 'waiting on your yes before I call anyone');
  await pushOut(errand, deps, 'Your errand wants to make a call', `${ask} Tell Kiana yes or no.`);
  return 'parked';
}

async function placeCall(errand, step, deps) {
  const number = step.approvedNumber;
  const who = step.pendingName || step.who || 'them';
  const why = String(step.why || 'a question about this errand').replace(/\.$/, '');
  setStatus(errand, 'running', `calling ${who}`);

  let callSid = null;
  try {
    const r = await axios.post(`${SELF_URL}/outbound-call`, {
      secret: process.env.BRIDGE_SECRET,
      to: number,
      userId: errand.userId,
      userName: process.env.ERRAND_CALLER_NAME || 'Kade',
      agentId: errand.agentId || undefined,
      agentName: errand.agentName || 'Kiana',
      purpose: why,
      /* Mission material: what the errand already learned, so the agent has
       * facts instead of improvisation. Never her private notes. */
      context: findingsText(errand).slice(0, 3000) || undefined,
    }, { timeout: 45000, validateStatus: () => true });
    if (r.status !== 200 || !r.data?.callSid) {
      const why2 = r.data?.error || `HTTP ${r.status}`;
      addStep(errand, 'call_business', `The call to ${who} never got placed: ${why2}.`, { ok: false, who, number, error: why2 });
      return 'failed';
    }
    callSid = r.data.callSid;
  } catch (e) {
    addStep(errand, 'call_business', `The call to ${who} never got placed: ${e.message}.`, { ok: false, who, number, error: e.message });
    return 'failed';
  }

  const result = await waitForCall(errand, callSid);
  const turns = Array.isArray(result?.transcript) ? result.transcript : [];
  const spoken = turns.map((t) => `${t.role === 'assistant' ? 'Kiana' : who}: ${t.content}`).join('\n').slice(0, 6000);

  let outcome = 'The call went through but nothing came back I can read to you.';
  let cost = 0;
  if (spoken) {
    const w = await askModel(errand, MODEL_WRITE, [{
      role: 'user',
      content: [
        'Below is the transcript of a phone call just made on someone\'s behalf. They are blind and will HEAR your summary.',
        'In two or three plain spoken sentences: what did the business actually say? Lead with the answer.',
        'Include any number, price, time or name they gave. If they did not answer the question, say that plainly.',
        'If it went to voicemail, say a message was left. No markdown, no lists, no preamble.',
        '',
        `WHAT WE CALLED TO ASK: ${why}`,
        '',
        'TRANSCRIPT:',
        spoken,
      ].join('\n'),
    }], { maxTokens: 300 });
    outcome = String(w.content || '').trim().replace(/[*_#`]/g, '') || outcome;
    cost = w.cost;
  } else if (result?.status && result.status !== 'completed') {
    outcome = `The call ended ${result.status} — nobody was reached.`;
  }

  const money = await callCost(errand, callSid, result);
  addStep(errand, 'call_business',
    `Called ${who} at ${prettyNumber(number)} to ask ${why}. ${outcome}`,
    { ok: true, who, number, mission: why, callSid, status: result?.status || 'unknown', turns: turns.length, outcome, transcript: spoken.slice(0, 4000), costEstimated: money.estimated },
    money.usd);
  return 'done';
}

/* The bridge's own report-back lane already waits up to 55s for a call to
 * wrap and hands back the transcript off the live meta, so this just keeps
 * asking until the call is no longer in progress. */
async function waitForCall(errand, callSid) {
  const deadline = Date.now() + CALL_WAIT_MS;
  for (;;) {
    let r;
    try {
      r = await axios.post(`${SELF_URL}/outbound/result`, {
        secret: process.env.BRIDGE_SECRET, userId: errand.userId, callSid, waitSec: 50,
      }, { timeout: 70000, validateStatus: () => true });
    } catch { r = null; }
    const d = r && r.status === 200 ? r.data : null;
    if (d && d.found && d.status !== 'in-progress') return d;
    if (Date.now() > deadline) return d || { status: 'timed out', transcript: [] };
    await sleep(3000);
  }
}

/* Twilio prices a call 30-90 seconds after it ends, so the real number often
 * is not there yet when the transcript is. Take the real one if it has landed,
 * otherwise estimate and SAY it is an estimate — a made-up exact figure in a
 * receipts ledger is worse than an honest approximation. */
async function callCost(errand, callSid, result) {
  try {
    const r = await axios.get(`${SELF_URL}/outbound/calls`, {
      params: { secret: process.env.BRIDGE_SECRET },
      timeout: 15000, validateStatus: () => true,
    });
    const rec = (r.data?.calls || r.data || []).find?.((x) => x.callSid === callSid);
    if (rec && typeof rec.costUsd === 'number') return { usd: rec.costUsd, estimated: false };
  } catch { /* fall through to the estimate */ }
  const secs = result?.durationSec || 0;
  return { usd: Math.round(Math.max(1, Math.ceil(secs / 60)) * 0.014 * 1e5) / 1e5, estimated: true };
}

async function wrapUp(errand, deps) {
  /* A phone call is a finding too — and usually the freshest one, which is
   * why it goes LAST where the writer weights it most. */
  const findings = errand.steps
    .filter((x) => x.detail && x.detail.ok && (x.detail.report || x.detail.outcome))
    .map((x, i) => (x.kind === 'call_business'
      ? `FINDING ${i + 1} (phoned ${x.detail.who} and asked ${x.detail.mission}):\n${x.detail.outcome}`
      : `FINDING ${i + 1} (${x.detail.question}):\n${x.detail.report}`))
    .join('\n\n');

  if (!findings) {
    errand.answer = errand.budgetStopped
      ? 'I ran out of budget before I got you a real answer.'
      : 'I came back empty on this one — nothing solid enough to tell you.';
    addStep(errand, 'note', errand.answer);
  } else if (overBudget(errand)) {
    /* Out of money for the summary too. Hand her the first finding raw rather
     * than nothing — honest and free. */
    errand.answer = cut(String(errand.steps.find((x) => x.detail?.report)?.detail.report || '').split('\n').find((l) => l.trim().length > 40) || '', 280);
    addStep(errand, 'note', 'I was out of budget for a written summary, so this is straight off the findings.');
  } else {
    const { content, cost } = await askModel(errand, MODEL_WRITE, [{ role: 'user', content: wrapPrompt(errand, findings) }], { maxTokens: 500 });
    errand.answer = String(content || '').trim().replace(/[*_#`]/g, '');
    addStep(errand, 'write', 'Wrote up what I found, in plain words.', { words: errand.answer.split(/\s+/).length }, cost);
  }

  setStatus(errand, 'done', 'finished');
  addStep(errand, 'notify', 'Pinged your phone that it was done.');
  await pushOut(errand, deps, 'Your errand is done', `"${cut(errand.goal, 55)}" — ${cut(errand.answer, 150)} Ask Kiana for the receipts.`);
}

function cut(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, t.lastIndexOf(' ', n) > 0 ? t.lastIndexOf(' ', n) : n)}…`;
}

/* THE ZERO-TARGET DISEASE, caught three times in Parts 59-60 and once more in
 * the crash alert: a push built from the RUN's userId or a channel id resolves
 * to no linked device, runNotify returns {ok:false,blocked:'no target user'}
 * WITHOUT rejecting, and the caller's catch never fires — a notifier that
 * cannot deliver, saying nothing. Errand pushes target the OWNER's user id and
 * log the delivery result either way. */
async function pushOut(errand, deps, title, body) {
  if (!deps || !deps.runNotify) return;
  try {
    const r = await deps.runNotify({
      agentId: errand.agentId || 'kade-errands',
      agentName: errand.agentName || 'Kiana',
      title, body, urgent: false,
      userId: OWNER_ID,
      category: 'KADE_ERRAND',
    });
    console.log(`[errand] ${errand.id} push "${title}": ${r && r.ok ? `sent:${r.sent != null ? r.sent : 1}` : `NOT SENT — ${r && r.blocked ? r.blocked : 'unknown'}`}`);
  } catch (e) {
    console.warn(`[errand] ${errand.id} push failed:`, e.message);
  }
}

/* Poll the research desk. The desk runs its own queue, so an errand waits
 * politely instead of holding a worker. Ceiling is generous (research's own
 * job timeout is 12 minutes) but finite — a lookup that never returns must
 * not wedge the errand forever. */
async function waitForResearch(id, errand) {
  const deadline = Date.now() + Math.max(60000, parseInt(process.env.ERRAND_RESEARCH_WAIT_MS, 10) || 14 * 60 * 1000);
  for (;;) {
    const job = researchDesk.getJob(id, { withReport: true });
    if (!job) return null;
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    if (errand.cancelRequested) {
      researchDesk.cancelJob(id);
      return { status: 'cancelled', error: 'you called the errand off' };
    }
    if (Date.now() > deadline) {
      researchDesk.cancelJob(id);
      return { status: 'failed', error: 'the lookup took too long and I stopped it' };
    }
    if (errand.stageNote !== job.stageNote) setStatus(errand, 'running', job.stageNote);
    await sleep(4000);
  }
}

/* The re-arm flag closes a real race: a job queued in the window between the
 * loop finding nothing and `working` going false would call pump(), get the
 * early return, and then sit there — for errands that meant a confirmed
 * errand stalling until its research deadline. `again` makes the running
 * pump do one more lap instead. */
let again = false;
async function pump(deps) {
  if (working) { again = true; return; }
  working = true;
  try {
    do {
      again = false;
      for (;;) {
        const next = store.errands.find((e) => e.status === 'queued' || e.resumeRequested);
        if (!next) break;
        next.resumeRequested = false;
        await runErrand(next, deps);
      }
    } while (again);
  } finally { working = false; }
}

/* ---------- routes ---------- */
function attachErrands(app, deps = {}) {
  const authOk = (req, provided) => {
    if (deps.bridgeSecretOk && deps.bridgeSecretOk(req, provided)) return true;
    if (deps.notifySecretOk && deps.notifySecretOk(req, provided)) return true;
    const scoped = process.env.ERRAND_TOOL_SECRET || '';
    if (!scoped) return false;
    const h = req.get && req.get('x-errand-secret');
    return h === scoped || provided === scoped;
  };
  const adminOk = (req, provided) => !!(deps.bridgeSecretOk && deps.bridgeSecretOk(req, provided));

  const mine = (userId) => store.errands.filter((e) => e.userId === userId);
  const find = (userId, id) => mine(userId).find((e) => e.id === id);

  /* POST /errand {secret, userId, agentId, agentName, goal} — create + start */
  app.post('/errand', express.json({ limit: '16kb' }), (req, res) => {
    if (!authOk(req, req.body?.secret)) return res.status(403).json({ error: 'Unauthorized' });
    if (!enabled()) return res.status(503).json({ error: `Errands are unavailable: ${disabledWhy()}.` });
    const userId = String(req.body?.userId || '').trim();
    const goal = String(req.body?.goal || '').replace(/%%%/g, '').trim().slice(0, 600);
    if (!userId || goal.length < 8) return res.status(400).json({ error: 'userId and a real goal are required' });
    /* Server-side seat check. The fork tool gates too; this is the floor under
     * a leaked scoped secret. Deliberately a plain refusal, not a 404 — unlike
     * the memory shelf there is no curious-kid problem here, and a confused
     * agent deserves a reason it can read out loud. */
    if (!userAllowed(userId)) {
      console.warn(`[errand] REFUSED — user ${userId} is not cleared to run errands`);
      return res.status(403).json({ error: 'Errands are Kade\'s only for now.' });
    }

    const today = centralDay();
    const todays = mine(userId).filter((e) => e.createdAt.slice(0, 10) === today).length;
    if (todays >= DAILY_CAP) return res.status(429).json({ error: `daily errand cap reached (${DAILY_CAP})` });
    const active = mine(userId).filter((e) => ACTIVE.includes(e.status));
    if (active.length >= ACTIVE_CAP) return res.status(429).json({ error: `you already have ${active.length} errands going — finish or cancel one first` });

    const errand = {
      id: crypto.randomBytes(5).toString('hex'),
      userId,
      agentId: String(req.body?.agentId || ''),
      agentName: String(req.body?.agentName || 'Kiana').slice(0, 60),
      goal,
      status: 'queued',
      stageNote: 'waiting its turn',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      steps: [],
      plan: null,
      cursor: 0,
      pending: null,
      answer: null,
      error: null,
      costUsd: 0,
      budgetUsd: BUDGET_USD,
      budgetStopped: false,
      cancelRequested: false,
      resumeRequested: false,
    };
    store.errands.unshift(errand);
    if (store.errands.length > ERRANDS_KEPT) store.errands.length = ERRANDS_KEPT;
    saveStore();
    setImmediate(() => pump(deps).catch((e) => console.error('[errand] pump:', e.message)));
    console.log(`[errand] ${errand.id} started for ${userId}: "${cut(goal, 80)}"`);
    res.json({
      ok: true, id: errand.id, status: errand.status,
      spokenSummary: `Alright, I'm on it. I'll ping your phone when it's done, and you can ask me how it's going any time. This one's number is ${errand.id}.`,
    });
  });

  /* GET /errand/:id?secret=&userId= — one errand, with its ledger */
  app.get('/errand/:id', (req, res) => {
    if (!authOk(req, req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const userId = String(req.query.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const e = find(userId, req.params.id);
    if (!e) return res.status(404).json({ error: 'no such errand' });
    res.json(errandPublic(e, req.query.steps !== '0'));
  });

  /* GET /errands?secret=&userId=[&active=1] — the list, spoken */
  app.get('/errands', (req, res) => {
    if (!authOk(req, req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const userId = String(req.query.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'userId required' });
    let list = mine(userId);
    if (req.query.active === '1') list = list.filter((e) => ACTIVE.includes(e.status));
    list = list.slice(0, 10);
    const waiting = list.filter((e) => e.status === 'awaiting_confirm');
    const going = list.filter((e) => ['queued', 'running'].includes(e.status));
    const parts = [];
    if (!list.length) parts.push(req.query.active === '1' ? 'Nothing running right now.' : 'No errands yet.');
    if (waiting.length) parts.push(`${waiting.length} ${waiting.length === 1 ? 'errand is' : 'errands are'} waiting on your yes or no.`);
    if (going.length) parts.push(`${going.length} still going.`);
    const finished = list.filter((e) => e.status === 'done');
    if (finished.length) parts.push(`${finished.length} finished and ready to hear.`);
    res.json({
      count: list.length,
      errands: list.map((e) => errandPublic(e, false)),
      spokenSummary: parts.join(' ') || 'Nothing to report.',
    });
  });

  /* POST /errand/:id/confirm {secret, userId, answer:"yes"|"no"} */
  app.post('/errand/:id/confirm', express.json({ limit: '8kb' }), (req, res) => {
    if (!authOk(req, req.body?.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const userId = String(req.body?.userId || '').trim();
    const e = find(userId, req.params.id);
    if (!e) return res.status(404).json({ error: 'no such errand' });
    if (e.status !== 'awaiting_confirm') return res.status(409).json({ error: `that errand isn't waiting on anything — it's ${e.status}`, ...errandPublic(e) });

    const yes = /^(y|yes|yeah|yep|sure|go|ok|okay|do it|please|affirmative)/i.test(String(req.body?.answer || '').trim());
    /* An old ask is a stale ask. Twelve hours later she may not remember what
     * she is saying yes TO, and rung 2 turns a yes into a phone call — so an
     * expired confirmation is refused rather than honored. */
    const age = Date.now() - Date.parse(e.pending?.since || e.createdAt);
    if (yes && age > CONFIRM_TTL_MS) {
      addStep(e, 'note', e.pending?.kind === 'call_confirm'
        ? 'That yes came in hours after I asked, and I am not dialing anyone on a stale yes. Ask me again and I will start fresh.'
        : 'That yes came in too long after I asked, so I did not act on it. Ask me again and I will start fresh.');
      setStatus(e, 'cancelled', 'the question went stale');
      e.pending = null;
      return res.json({ ok: true, ...errandPublic(e), spokenSummary: spokenSummary(e) });
    }

    /* TWO KINDS OF YES, and conflating them would be the bug that dials a
     * phone she never approved. A planning question's yes means "move past
     * this and carry on." A CALL's yes means "dial THAT number" — so it arms
     * the very step she approved and re-enters it without advancing, and the
     * number is read back off the step she said yes to, never off anything
     * sent in this request. A no to a call skips only the call; the rest of
     * the errand still runs, because refusing one phone call is not the same
     * as calling the whole thing off. */
    const kind = e.pending?.kind || 'plan_confirm';
    const askWas = e.pending?.ask || null;
    e.pending = null;

    if (kind === 'call_confirm') {
      const step = (e.plan || [])[e.cursor];
      if (yes && step && step.pendingNumber) {
        step.approvedNumber = step.pendingNumber;
        addStep(e, 'note', `You said yes, so I am calling ${step.pendingName || 'them'} now.`, { answer: 'yes', ask: askWas, number: step.pendingNumber });
        // cursor stays put on purpose — the runner re-enters this same step and dials
      } else {
        addStep(e, 'note', yes
          ? 'You said yes, but I had lost track of which number that was for, so I did not call anyone.'
          : 'You said no, so I did not make that call. I carried on with the rest.',
          { answer: yes ? 'yes' : 'no', ask: askWas });
        e.cursor += 1;
      }
    } else {
      addStep(e, 'note', yes ? 'You said yes, so I kept going.' : 'You said no, so I stopped there.', { answer: yes ? 'yes' : 'no', ask: askWas });
      if (!yes) {
        setStatus(e, 'cancelled', 'you said no');
        return res.json({ ok: true, ...errandPublic(e) });
      }
      e.cursor += 1;
    }

    e.resumeRequested = true;
    setStatus(e, 'running', 'picking back up');
    setImmediate(() => pump(deps).catch((err) => console.error('[errand] pump:', err.message)));
    res.json({ ok: true, ...errandPublic(e), spokenSummary: 'Alright, picking it back up. I\'ll ping you when it\'s done.' });
  });

  /* POST /errand/:id/cancel {secret, userId} */
  app.post('/errand/:id/cancel', express.json({ limit: '8kb' }), (req, res) => {
    if (!authOk(req, req.body?.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const userId = String(req.body?.userId || '').trim();
    const e = find(userId, req.params.id);
    if (!e) return res.status(404).json({ error: 'no such errand' });
    if (!ACTIVE.includes(e.status)) return res.json({ ok: true, already: e.status, ...errandPublic(e) });
    e.cancelRequested = true;
    if (e.status !== 'running') {
      addStep(e, 'note', 'You called it off before it got going.');
      setStatus(e, 'cancelled', 'cancelled');
      e.pending = null;
    }
    res.json({ ok: true, ...errandPublic(e), spokenSummary: 'Called off. Nothing else will happen on that one.' });
  });

  /* GET /errand-receipts?secret= — ADMIN ONLY, the spend ledger tail */
  app.get('/errand-receipts', (req, res) => {
    if (!adminOk(req, req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
    try {
      const lines = fs.existsSync(RECEIPTS_FILE) ? fs.readFileSync(RECEIPTS_FILE, 'utf8').trim().split('\n').slice(-40) : [];
      res.json({ receipts: lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* Anything left mid-flight by a redeploy: an errand that was RUNNING when the
   * container died is not running now. Say so in its own ledger rather than
   * leaving a ghost that reads "still working" forever. Errands parked on
   * awaiting_confirm survive untouched — that is the whole point of the
   * volume-backed store. */
  let revived = 0;
  for (const e of store.errands) {
    if (e.status === 'running' || e.status === 'queued') {
      addStep(e, 'note', 'The service restarted while this was mid-flight, so it stopped here.');
      setStatus(e, 'failed', 'interrupted by a restart');
      e.error = e.error || 'interrupted by a service restart';
      revived += 1;
    }
  }
  if (revived) { saveStore(); console.log(`[errand] ${revived} interrupted errand(s) closed out honestly on boot`); }

  console.log(`[errand] attached — ${enabled() ? `ENABLED (budget $${BUDGET_USD}/errand, ${OWNER_ONLY ? 'owner-only' : 'open'})` : `DISABLED (${disabledWhy()})`}`);
}

module.exports = { attachErrands, _internals: { store, spokenSummary, runErrand } };
