'use strict';
/* ──────────────────────────────────────────────────────────────────────────
 * research.js — THE DEEP RESEARCH ENGINE (August 10 2026)
 *
 * The kade_research tool's back end: a character says "let me really dig
 * into that," this engine does the digging in the background, and the
 * person gets a phone tap when the report is ready — no dead air on a
 * voice call, no frozen turn on web.
 *
 * The pipeline, five stages, every one narrated in stageNote so the
 * character can honestly answer "how's my research coming?":
 *   PLAN      one cheap model call turns the question into sub-questions
 *             and varied search queries (always one hunting for downsides).
 *   GATHER    Tavily web search (TAVILY_API_KEY — the key already on the
 *             LibreChat service), URL-deduped, max two sources per site so
 *             one loud domain can't own the report.
 *   DISTILL   each source read (Tavily raw content → Jina Reader → bare
 *             fetch, in that order) and boiled to ~220 words of notes by
 *             the cheap model. Concurrency 3, polite to the 429 gods.
 *   REFLECT   (standard/deep) the big model checks the notes for gaps and
 *             conflicts and orders follow-up searches. Deep gets 2 rounds.
 *   WRITE     kimi-k3 composes the report FOR LISTENING — verdict first,
 *             plain spoken prose, numbered citations, honest "what I
 *             couldn't pin down" — per the platform's ear-first religion.
 *
 * MONEY (verified Aug 10 2026, api.moonshot.ai + tavily.com):
 *   kimi-k3 $3/M in $15/M out · kimi-k2.6 $0.95/M in $4/M out ·
 *   Tavily free tier 1,000 credits/mo (basic search 1, advanced 2).
 *   Measured per run: quick ≈ $0.03-0.06, standard ≈ $0.10-0.20,
 *   deep ≈ $0.25-0.45. Hard caps below make the worst case ≤ ~$0.75.
 *   $0 idle. Every job writes a receipt line (research-receipts.jsonl).
 *
 * RAILS: kill switch RESEARCH_ENABLED=0 · per-user daily cap
 * (RESEARCH_DAILY_CAP, default 8) · single-flight worker + queue cap ·
 * 12-minute hard timeout per job · jobs ring (last 60) on the volume so
 * reports survive deploys. Personal notes ride ONLY the caller's own
 * scoped memory lane (same lane as calls/briefs) and ONLY when the tool
 * asks for them.
 *
 * WIRING (server.js, after runNotify/fetchCallMemories exist):
 *   const { attachResearch } = require('./research');
 *   attachResearch(app, { bridgeSecretOk, notifySecretOk, runNotify, fetchCallMemories });
 * Env needed on THIS service: MOONSHOT_KEY, TAVILY_API_KEY.
 * ────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const express = require('express');

/* ---------- config ---------- */
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || os.tmpdir();
const JOBS_FILE = path.join(DATA_DIR, 'research-jobs.json');
const RECEIPTS_FILE = path.join(DATA_DIR, 'research-receipts.jsonl');

const MOONSHOT_URL = (process.env.MOONSHOT_URL || 'https://api.moonshot.ai/v1').replace(/\/$/, '');
const MOONSHOT_KEY = process.env.MOONSHOT_KEY || '';
const TAVILY_KEY = process.env.TAVILY_API_KEY || '';

const MODEL_PLAN = process.env.RESEARCH_PLAN_MODEL || 'kimi-k2.6';
const MODEL_DISTILL = process.env.RESEARCH_DISTILL_MODEL || 'kimi-k2.6';
const MODEL_REFLECT = process.env.RESEARCH_REFLECT_MODEL || 'kimi-k3';
const MODEL_SYNTH = process.env.RESEARCH_SYNTH_MODEL || 'kimi-k3';
const MODEL_SYNTH_QUICK = process.env.RESEARCH_SYNTH_QUICK_MODEL || 'kimi-k2.6';

/* $/M tokens — env RESEARCH_PRICES ({"model":{"in":x,"out":y}}) overrides. */
let PRICES = { 'kimi-k3': { in: 3, out: 15 }, 'kimi-k2.6': { in: 0.95, out: 4 } };
try { if (process.env.RESEARCH_PRICES) PRICES = { ...PRICES, ...JSON.parse(process.env.RESEARCH_PRICES) }; } catch { /* keep defaults */ }

const DAILY_CAP = Math.max(1, parseInt(process.env.RESEARCH_DAILY_CAP, 10) || 8);
const QUEUE_CAP = Math.max(1, parseInt(process.env.RESEARCH_QUEUE_CAP, 10) || 4);
const JOB_TIMEOUT_MS = Math.max(120000, parseInt(process.env.RESEARCH_TIMEOUT_MS, 10) || 12 * 60 * 1000);
const JOBS_KEPT = 60;

/* Depth budgets — the whole cost story lives in this one table. */
const DEPTHS = {
  quick:    { queries: 4,  advanced: 0, sources: 5,  reflectRounds: 0, words: 450,  perSourceChars: 7000,  synthModel: MODEL_SYNTH_QUICK, etaMin: 2 },
  standard: { queries: 6,  advanced: 2, sources: 10, reflectRounds: 1, words: 900,  perSourceChars: 9000,  synthModel: MODEL_SYNTH,       etaMin: 4 },
  deep:     { queries: 10, advanced: 4, sources: 18, reflectRounds: 2, words: 1600, perSourceChars: 9000,  synthModel: MODEL_SYNTH,       etaMin: 8 },
};

function enabled() { return process.env.RESEARCH_ENABLED !== '0' && !!MOONSHOT_KEY && !!TAVILY_KEY; }
function disabledWhy() {
  if (process.env.RESEARCH_ENABLED === '0') return 'research is switched off (RESEARCH_ENABLED=0)';
  if (!MOONSHOT_KEY) return 'MOONSHOT_KEY is not set on the bridge';
  if (!TAVILY_KEY) return 'TAVILY_API_KEY is not set on the bridge';
  return '';
}

/* ---------- persistence (bridge house style: tiny JSON on the volume) ---------- */
const store = (() => {
  try { if (fs.existsSync(JOBS_FILE)) return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch { /* fresh */ }
  return { jobs: [] };
})();
function saveStore() {
  try { fs.writeFileSync(JOBS_FILE, JSON.stringify(store)); } catch (e) { console.error('[research] store save:', e.message); }
}
function receipt(line) {
  try { fs.appendFileSync(RECEIPTS_FILE, JSON.stringify(line) + '\n'); } catch { /* receipts never break the run */ }
}

function centralDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function centralDateSpoken() {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date());
}

/* ---------- model calls (Moonshot direct, same billing pot as the fleet) ---------- */
/* TWO MOONSHOT FACTS learned live in the sandbox, August 10 2026 (both the
 * same facts adaptForKimi handles for the fleet):
 *   1. kimi-k2.6/k3 REFUSE any temperature but 1 ("invalid temperature:
 *      only 1 is allowed") — so no temperature rides these requests at all;
 *      steering happens in the prompts.
 *   2. The DIRECT API defaults reasoning ON, and reasoning tokens eat
 *      max_tokens until content comes back EMPTY with finish_reason
 *      "length". reasoning_effort "none" turns it off ("minimal"/"low"
 *      still reason). Every call here sends "none" (RESEARCH_SYNTH_EFFORT
 *      can flip the report writer to "low" for pricier, deeper analysis).
 * The empty-content guard below retries once with double budget in case a
 * future Moonshot default shifts under us. */
const SYNTH_EFFORT = process.env.RESEARCH_SYNTH_EFFORT || 'none';
async function chat(job, model, messages, { maxTokens = 1200, json = false, effort = 'none' } = {}) {
  const mk = (budget) => {
    const body = { model, messages, max_tokens: budget, reasoning_effort: effort };
    if (json) body.response_format = { type: 'json_object' };
    return body;
  };
  let lastErr;
  let budget = effort === 'none' ? maxTokens : maxTokens + 4000; // reasoning rides the same budget
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep([2000, 8000, 20000][attempt - 1] || 20000); // the armadillo lesson: patience beats a dead turn
    try {
      const r = await axios.post(`${MOONSHOT_URL}/chat/completions`, mk(budget), {
        timeout: 240000,
        headers: { Authorization: `Bearer ${MOONSHOT_KEY}`, 'Content-Type': 'application/json' },
      });
      const usage = r.data?.usage || {};
      tallyTokens(job, model, usage.prompt_tokens || 0, usage.completion_tokens || 0);
      const choice = r.data?.choices?.[0] || {};
      const content = String(choice.message?.content || '');
      if (!content.trim() && choice.finish_reason === 'length') { budget = budget * 2; continue; } // reasoning starved the answer — feed it once
      return content;
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      if (status && status !== 429 && status < 500) break; // real errors don't deserve retries
    }
  }
  throw new Error(`model ${model}: ${lastErr?.response?.status || ''} ${lastErr?.message || 'empty reply'}`.trim());
}

function tallyTokens(job, model, tin, tout) {
  if (!job.costs.tokens[model]) job.costs.tokens[model] = { in: 0, out: 0 };
  job.costs.tokens[model].in += tin;
  job.costs.tokens[model].out += tout;
  const p = PRICES[model] || { in: 1, out: 5 };
  job.costs.estUSD = Math.round((job.costs.estUSD + (tin * p.in + tout * p.out) / 1e6) * 1e5) / 1e5;
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

/* ---------- web: Tavily search + three-step page reading ---------- */
async function tavilySearch(job, query, { advanced = false, recent = false } = {}) {
  const body = {
    query,
    search_depth: advanced ? 'advanced' : 'basic',
    max_results: 6,
    include_raw_content: 'text',
  };
  if (recent) { body.topic = 'news'; body.days = 365; }
  const r = await axios.post('https://api.tavily.com/search', body, {
    timeout: 30000,
    headers: { Authorization: `Bearer ${TAVILY_KEY}`, 'Content-Type': 'application/json' },
  });
  job.costs.tavilyCredits += advanced ? 2 : 1;
  return Array.isArray(r.data?.results) ? r.data.results : [];
}

/* KadeReadPage's proven fallback stripper, kept verbatim in spirit. */
function stripHtml(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const main = s.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i);
  if (main) s = main[2];
  return s.replace(/<(p|div|br|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*(\n\s*)+/g, '\n\n')
    .trim();
}

async function readSource(src, cap) {
  if (src.raw_content && String(src.raw_content).length >= 600) {
    return String(src.raw_content).slice(0, cap);
  }
  try { // Jina Reader — the platform's proven free page lane (KadeReadPage, July 2)
    const r = await axios.get(`https://r.jina.ai/${src.url}`, {
      timeout: 25000, responseType: 'text',
      headers: { Accept: 'text/plain', 'X-Retain-Images': 'none', 'User-Agent': 'Mozilla/5.0 (compatible; KadeAI-Research/1.0)' },
      maxContentLength: 5 * 1024 * 1024,
    });
    if (r.data && String(r.data).length >= 400) return String(r.data).slice(0, cap);
  } catch { /* fall through */ }
  try {
    const r = await axios.get(src.url, {
      timeout: 15000, responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KadeAI-Research/1.0)' },
      maxContentLength: 4 * 1024 * 1024,
    });
    const text = stripHtml(r.data);
    if (text.length >= 300) return text.slice(0, cap);
  } catch { /* fall through */ }
  return String(src.content || '').slice(0, cap); // worst case: the search snippet still beats nothing
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function urlKey(u) { try { const x = new URL(u); return (x.hostname + x.pathname).replace(/\/$/, '').toLowerCase(); } catch { return String(u).toLowerCase(); } }

/* Video/social hosts whose pages strip to nothing (or a login wall) — proven
 * by the instagram source in the first sandbox run. Reddit stays IN: forum
 * threads are where real users actually talk, and they read fine as text. */
const SKIP_HOSTS = ['youtube.com', 'youtu.be', 'instagram.com', 'facebook.com', 'tiktok.com', 'x.com', 'twitter.com', 'pinterest.com'];
function skippableHost(host) { return SKIP_HOSTS.some((h) => host === h || host.endsWith('.' + h)); }

/* Word-boundary cut so pushed text never ends mid-word. */
function cutAtWord(s, cap) {
  s = String(s || '').trim();
  if (s.length <= cap) return s;
  return s.slice(0, cap).replace(/\s+\S*$/, '') + '…';
}

/* ---------- prompts (every output is written to be LISTENED to) ---------- */
function planPrompt(job, d) {
  return [
    `You are planning a web research run. Today is ${centralDateSpoken()} (US Central).`,
    `THE QUESTION: ${job.question}`,
    job.focus ? `EXTRA STEER FROM THE PERSON: ${job.focus}` : '',
    '',
    'Reply with STRICT JSON only, no prose around it:',
    `{"sub_questions": [3 to 5 concrete sub-questions that together fully answer the question],`,
    ` "queries": [exactly ${d.queries} web search queries — varied wording, each attacking a different angle; when the question involves a product, service, claim, place, or decision, make one query hunt specifically for criticism, complaints, or downsides],`,
    ` "recent": true or false — true when fresh information matters (news, prices, availability, laws, product versions, anything that changes year to year)}`,
  ].filter(Boolean).join('\n');
}

function distillPrompt(job, src, text) {
  return [
    `You are taking notes on ONE web source for a research report. Today is ${centralDateSpoken()}.`,
    `THE RESEARCH QUESTION: ${job.question}`,
    `SUB-QUESTIONS: ${(job.plan.sub_questions || []).join(' | ')}`,
    `SOURCE ${src.n}: "${src.title}" — ${src.url}`,
    '',
    'PAGE TEXT:',
    text,
    '',
    'Write compact notes, 220 words maximum, plain prose (no bullets):',
    '- Only material that bears on the question or sub-questions; skip the rest.',
    '- Keep numbers, dates, prices, and names EXACT; put short key phrases in quotes verbatim.',
    '- Name the publish date if the page shows one.',
    '- End with one plain sentence on trustworthiness (news outlet? vendor selling something? forum chatter? outdated?).',
    '- If the page holds NOTHING relevant, reply with exactly: NOTHING RELEVANT.',
  ].join('\n');
}

function reflectPrompt(job) {
  const notes = job.sources.filter((s) => s.note).map((s) => `SOURCE ${s.n} (${s.site}): ${s.note}`).join('\n\n');
  return [
    `You are auditing research notes for completeness. Today is ${centralDateSpoken()}.`,
    `THE QUESTION: ${job.question}`,
    `SUB-QUESTIONS: ${(job.plan.sub_questions || []).join(' | ')}`,
    '',
    'NOTES SO FAR:',
    notes,
    '',
    'Reply with STRICT JSON only:',
    '{"enough": true or false — can the question be answered well and honestly from these notes?,',
    ' "gaps": [sub-questions or angles still thin or unanswered],',
    ' "conflicts": [any places sources genuinely disagree],',
    ' "new_queries": [up to 4 web searches that would close the gaps — empty if enough]}',
  ].join('\n');
}

function synthPrompt(job, d) {
  const notes = job.sources.filter((s) => s.note).map((s) => `SOURCE ${s.n}: "${s.title}" — ${s.site}\n${s.note}`).join('\n\n');
  const conflicts = (job.reflect && job.reflect.conflicts && job.reflect.conflicts.length)
    ? `\nKNOWN DISAGREEMENTS TO ADDRESS: ${job.reflect.conflicts.join(' | ')}` : '';
  return [
    'You are writing a RESEARCH REPORT for a person who will most likely LISTEN to it through text-to-speech or a screen reader, so it must read as natural spoken prose.',
    `Today is ${centralDateSpoken()} (US Central).`,
    `THE QUESTION: ${job.question}`,
    job.focus ? `THE PERSON'S STEER: ${job.focus}` : '',
    conflicts,
    '',
    `NUMBERED SOURCE NOTES (${job.sources.filter((s) => s.note).length} sources, gathered within the last few minutes):`,
    notes,
    job.personalNotes ? `\n[THE PERSON'S OWN SAVED NOTES — context only, never quote or reference their existence directly]\n${job.personalNotes}` : '',
    '',
    'SHAPE:',
    '- Open with the verdict: two or three sentences that answer the question straight, before anything else.',
    '- Then the full story in plain paragraphs, grouped under short plain-line section titles (three or four words on their own line — no numbering, no markdown symbols).',
    '- Cite as you go, in parentheses, by source number: (source 3) or (sources 2 and 5). Every load-bearing fact gets one. Never cite a number that has no note above.',
    '- Where sources disagree, give the disagreement its own passage: who says what, and which reading looks stronger and why.',
    '- Near the end, one honest passage titled in your own words about what could NOT be pinned down — thin evidence, missing data, open questions. If everything checked out, say that instead.',
    '- Close with the source list, one per line, exactly like: Source 1: Page Title — site.com',
    '',
    'VOICE — this matters as much as the facts:',
    '- Plain sentences a person can follow by ear. NO tables, NO bullet points, NO markdown headers or bold or asterisks of any kind.',
    '- Write only from the notes above. A claim the notes cannot back does not go in.',
    '- Numbers read naturally ("around eight hundred dollars a month"; exact figures when exactness matters).',
    '- Contractions welcome. Warm and direct, zero corporate filler.',
    '- Banned words and moves: "delve", "moreover", "furthermore", "it\'s worth noting", "in conclusion", "comprehensive", "crucial", "leverage", "navigate", "landscape", "dive into", "in today\'s world", opening with a rhetorical question.',
    '- Honesty over polish: where the evidence is thin, say so plainly.',
    `LENGTH: at most ${d.words} words. Shorter is fine once the question is truly answered.`,
  ].filter(Boolean).join('\n');
}

/* ---------- the worker ---------- */
let working = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jobPublic(j, withReport = false) {
  const out = {
    id: j.id, question: j.question, depth: j.depth, status: j.status,
    stageNote: j.stageNote, createdAt: j.createdAt, finishedAt: j.finishedAt || null,
    sourcesFound: j.sources.filter((s) => s.note).length,
    costs: { estUSD: j.costs.estUSD, tavilyCredits: j.costs.tavilyCredits },
    error: j.error || null,
  };
  if (withReport && j.report) {
    out.report = j.report;
    out.sourceList = j.sources.filter((s) => s.note).map((s) => ({ n: s.n, title: s.title, url: s.url, site: s.site }));
  }
  return out;
}

function setStage(job, status, note) {
  job.status = status;
  job.stageNote = note;
  saveStore();
}

async function runJob(job, deps) {
  const d = DEPTHS[job.depth] || DEPTHS.standard;
  const t0 = Date.now();
  const guard = setTimeout(() => { job.cancelRequested = true; }, JOB_TIMEOUT_MS);
  try {
    /* PLAN */
    setStage(job, 'planning', 'working out the angles and search plan');
    const planRaw = await chat(job, MODEL_PLAN, [{ role: 'user', content: planPrompt(job, d) }], { maxTokens: 900, json: true });
    const plan = jsonFrom(planRaw) || {};
    job.plan = {
      sub_questions: (plan.sub_questions || []).slice(0, 5).map(String),
      queries: (plan.queries || []).slice(0, d.queries).map(String),
      recent: !!plan.recent,
    };
    if (!job.plan.queries.length) job.plan.queries = [job.question];
    if (job.cancelRequested) throw new Error('cancelled');

    /* GATHER */
    setStage(job, 'searching', `searching the web — ${job.plan.queries.length} searches`);
    const seen = new Set();
    const perHost = {};
    const pool = [];
    for (let i = 0; i < job.plan.queries.length; i++) {
      if (job.cancelRequested) throw new Error('cancelled');
      const advanced = i < d.advanced;
      let results = [];
      try { results = await tavilySearch(job, job.plan.queries[i], { advanced, recent: job.plan.recent }); }
      catch (e) { console.warn('[research] search failed:', e.message); }
      for (const r of results) {
        const key = urlKey(r.url);
        const host = hostOf(r.url);
        if (!r.url || seen.has(key) || skippableHost(host)) continue;
        if ((perHost[host] || 0) >= 2) continue; // no domain owns the report
        seen.add(key);
        perHost[host] = (perHost[host] || 0) + 1;
        pool.push({ url: r.url, title: String(r.title || host || 'untitled').slice(0, 160), site: host, score: r.score || 0, content: r.content || '', raw_content: r.raw_content || '' });
      }
    }
    pool.sort((a, b) => b.score - a.score);
    job.sources = pool.slice(0, d.sources).map((s, i) => ({ ...s, n: i + 1, note: null }));
    if (!job.sources.length) throw new Error('the web search returned nothing usable');

    /* DISTILL — concurrency 3 */
    const distillOne = async (src) => {
      if (job.cancelRequested) return;
      setStage(job, 'reading', `reading source ${src.n} of ${job.sources.length} — ${src.site}`);
      try {
        const text = await readSource(src, d.perSourceChars);
        if (!text || text.length < 200) { src.note = null; return; }
        const note = await chat(job, MODEL_DISTILL, [{ role: 'user', content: distillPrompt(job, src, text) }], { maxTokens: 500 });
        src.note = /NOTHING RELEVANT/i.test(note) ? null : note.trim().slice(0, 2200);
      } catch (e) { console.warn(`[research] source ${src.n} (${src.site}):`, e.message); src.note = null; }
      delete src.raw_content; delete src.content; // keep the store lean
    };
    for (let i = 0; i < job.sources.length; i += 3) {
      await Promise.all(job.sources.slice(i, i + 3).map(distillOne));
      if (job.cancelRequested) throw new Error('cancelled');
    }
    if (!job.sources.some((s) => s.note)) throw new Error('no source pages could be read');

    /* REFLECT → follow-up rounds */
    for (let round = 0; round < d.reflectRounds; round++) {
      if (job.cancelRequested) throw new Error('cancelled');
      setStage(job, 'thinking', 'checking the notes for gaps and disagreements');
      const refRaw = await chat(job, MODEL_REFLECT, [{ role: 'user', content: reflectPrompt(job) }], { maxTokens: 700, json: true });
      const ref = jsonFrom(refRaw) || {};
      job.reflect = { gaps: ref.gaps || [], conflicts: ref.conflicts || [] };
      const followups = (ref.enough ? [] : (ref.new_queries || [])).slice(0, 4).map(String);
      if (!followups.length) break;
      const room = Math.max(0, d.sources + 4 - job.sources.length); // follow-ups may stretch the budget slightly
      if (!room) break;
      setStage(job, 'searching', `digging into the gaps — ${followups.length} follow-up searches`);
      const extra = [];
      for (const q of followups) {
        try {
          for (const r of await tavilySearch(job, q, { recent: job.plan.recent })) {
            const key = urlKey(r.url); const host = hostOf(r.url);
            if (!r.url || seen.has(key) || skippableHost(host) || (perHost[host] || 0) >= 2) continue;
            seen.add(key); perHost[host] = (perHost[host] || 0) + 1;
            extra.push({ url: r.url, title: String(r.title || host || 'untitled').slice(0, 160), site: host, score: r.score || 0, content: r.content || '', raw_content: r.raw_content || '' });
          }
        } catch (e) { console.warn('[research] follow-up search failed:', e.message); }
      }
      extra.sort((a, b) => b.score - a.score);
      const startN = job.sources.length;
      const adds = extra.slice(0, room).map((s, i) => ({ ...s, n: startN + i + 1, note: null }));
      job.sources.push(...adds);
      for (let i = 0; i < adds.length; i += 3) {
        await Promise.all(adds.slice(i, i + 3).map(distillOne));
        if (job.cancelRequested) throw new Error('cancelled');
      }
    }

    /* personal notes — caller's own scoped lane only, only when asked */
    if (job.includePersonalNotes && deps.fetchCallMemories) {
      try {
        const mem = await deps.fetchCallMemories({ userId: job.userId }, job.agentId);
        if (mem) job.personalNotes = String(mem).slice(0, 1500);
      } catch { /* a report without their notes is still a report */ }
    }

    /* WRITE */
    if (job.cancelRequested) throw new Error('cancelled');
    setStage(job, 'writing', 'writing the report');
    const report = await chat(job, d.synthModel, [{ role: 'user', content: synthPrompt(job, d) }], { maxTokens: Math.round(d.words * 2.2), effort: SYNTH_EFFORT });
    if (!report || report.trim().length < 200) throw new Error('the report came back empty');
    job.report = report.trim();
    job.personalNotes = null; // never persist their notes inside the job record

    /* DONE + the tap on the shoulder */
    job.finishedAt = new Date().toISOString();
    const firstLine = job.report.split(/\n/).find((l) => l.trim().length > 40) || job.report.slice(0, 160);
    setStage(job, 'done', 'finished — report ready');
    if (deps.runNotify && job.notifyOnDone !== false) {
      try {
        await deps.runNotify({
          agentId: job.agentId, agentName: job.agentName || 'Research',
          title: 'Your research is ready',
          body: `"${cutAtWord(job.question, 70)}" — ${cutAtWord(firstLine, 140)} Ask ${job.agentName || 'me'} for the full story.`,
          urgent: false, userId: job.userId, category: 'KADE_RESEARCH',
        });
      } catch (e) { console.warn('[research] notify failed:', e.message); }
    }
  } catch (e) {
    job.status = job.cancelRequested && /cancel/i.test(e.message) ? 'cancelled' : 'failed';
    job.error = e.message;
    job.stageNote = job.status === 'cancelled' ? 'cancelled' : `hit a wall: ${e.message}`;
    job.finishedAt = new Date().toISOString();
    console.error(`[research] job ${job.id} ${job.status}:`, e.message);
  } finally {
    clearTimeout(guard);
    receipt({
      at: new Date().toISOString(), id: job.id, userId: job.userId, depth: job.depth,
      status: job.status, question: job.question.slice(0, 120),
      sources: job.sources.filter((s) => s.note).length,
      credits: job.costs.tavilyCredits, tokens: job.costs.tokens, estUSD: job.costs.estUSD,
      seconds: Math.round((Date.now() - t0) / 1000),
    });
    saveStore();
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
        const next = store.jobs.find((j) => j.status === 'queued');
        if (!next) break;
        await runJob(next, deps);
      }
    } while (again);
  } finally { working = false; }
}

/* ---------- the desk's INTERNAL door (Part 66, Aug 15 2026) ----------
 * The errands engine runs research as a STEP, so it needs to start and read
 * jobs without going back out over HTTP to its own process. The route below
 * and the errand desk both go through createJob, deliberately: caps, queue
 * limits and the job record stay identical no matter who asked, so there is
 * exactly one place where "what a research job is" is defined. */
let liveDeps = null;

function createJob({ userId, agentId, agentName, question, depth, focus, includePersonalNotes, notify = true } = {}) {
  if (!enabled()) return { ok: false, code: 503, error: `Research is unavailable: ${disabledWhy()}.` };
  userId = String(userId || '').trim();
  question = String(question || '').replace(/%%%/g, '').trim().slice(0, 600);
  if (!userId || question.length < 8) return { ok: false, code: 400, error: 'userId and a real question are required' };
  const d = DEPTHS[depth] ? depth : 'standard';

  const today = centralDay();
  const todays = store.jobs.filter((j) => j.userId === userId && j.createdAt.slice(0, 10) === today).length;
  if (todays >= DAILY_CAP) return { ok: false, code: 429, error: `daily research cap reached (${DAILY_CAP})` };
  const active = store.jobs.filter((j) => ['queued', 'planning', 'searching', 'reading', 'thinking', 'writing'].includes(j.status));
  if (active.length >= QUEUE_CAP) return { ok: false, code: 429, error: 'the research desk is full right now — try again in a few minutes' };

  const job = {
    id: crypto.randomBytes(5).toString('hex'),
    userId, agentId: String(agentId || ''), agentName: String(agentName || '').slice(0, 60),
    question, focus: String(focus || '').replace(/%%%/g, '').trim().slice(0, 400) || null,
    depth: d, includePersonalNotes: includePersonalNotes === true,
    /* An internal caller (the errands desk) owns its own done-push; without
     * this flag one errand taps her phone TWICE for one piece of news —
     * caught in the Part 66 smoke, where both notifies landed 3 seconds
     * apart. Set by createJob's `notify:false`, honoured at the push site. */
    notifyOnDone: notify !== false,
    status: 'queued', stageNote: 'waiting for the research desk',
    createdAt: new Date().toISOString(), finishedAt: null,
    plan: {}, sources: [], reflect: null, report: null, personalNotes: null,
    costs: { tavilyCredits: 0, tokens: {}, estUSD: 0 }, error: null, cancelRequested: false,
  };
  store.jobs.unshift(job);
  if (store.jobs.length > JOBS_KEPT) store.jobs.length = JOBS_KEPT;
  saveStore();
  setImmediate(() => pump(liveDeps || {}).catch((e) => console.error('[research] pump:', e.message)));
  return { ok: true, id: job.id, position: active.length, etaMinutes: DEPTHS[d].etaMin + active.length * 3 };
}

function getJob(id, { withReport = false } = {}) {
  const j = store.jobs.find((x) => x.id === id);
  return j ? jobPublic(j, withReport) : null;
}

function cancelJob(id) {
  const j = store.jobs.find((x) => x.id === id);
  if (!j) return false;
  if (['done', 'failed', 'cancelled'].includes(j.status)) return true;
  if (j.status === 'queued') { j.status = 'cancelled'; j.stageNote = 'cancelled before it started'; j.finishedAt = new Date().toISOString(); saveStore(); }
  else j.cancelRequested = true;
  return true;
}

/* ---------- routes ---------- */
function attachResearch(app, deps = {}) {
  liveDeps = deps; // the internal door (createJob) pumps with the same deps the routes use
  const authOk = (req, provided) =>
    (deps.bridgeSecretOk && deps.bridgeSecretOk(req, provided)) ||
    (deps.notifySecretOk && deps.notifySecretOk(req, provided));

  /* POST /research/start {userId, agentId, agentName, question, depth, focus, include_personal_notes} */
  app.post('/research/start', express.json({ limit: '32kb' }), (req, res) => {
    if (!authOk(req, req.body?.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const r = createJob({
      userId: req.body?.userId, agentId: req.body?.agentId, agentName: req.body?.agentName,
      question: req.body?.question, depth: req.body?.depth, focus: req.body?.focus,
      includePersonalNotes: req.body?.include_personal_notes,
    });
    if (!r.ok) return res.status(r.code || 400).json({ error: r.error });
    res.json({ ok: true, id: r.id, position: r.position, etaMinutes: r.etaMinutes });
  });

  /* GET /research/status?userId=&id= — one job in detail, or the recent list */
  app.get('/research/status', (req, res) => {
    if (!authOk(req, req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const userId = String(req.query.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const mine = store.jobs.filter((j) => j.userId === userId);
    if (req.query.id) {
      const j = mine.find((x) => x.id === req.query.id);
      return j ? res.json(jobPublic(j)) : res.status(404).json({ error: 'no such job' });
    }
    res.json({ jobs: mine.slice(0, 8).map((j) => jobPublic(j)) });
  });

  /* GET /research/report?userId=&id= — the finished goods */
  app.get('/research/report', (req, res) => {
    if (!authOk(req, req.query.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const userId = String(req.query.userId || '').trim();
    const mine = store.jobs.filter((j) => j.userId === userId);
    const j = req.query.id ? mine.find((x) => x.id === req.query.id) : mine.find((x) => x.status === 'done');
    if (!j) return res.status(404).json({ error: 'no such job' });
    if (j.status !== 'done') return res.status(409).json({ error: 'not finished', ...jobPublic(j) });
    res.json(jobPublic(j, true));
  });

  /* POST /research/cancel {userId, id} */
  app.post('/research/cancel', express.json({ limit: '8kb' }), (req, res) => {
    if (!authOk(req, req.body?.secret)) return res.status(403).json({ error: 'Unauthorized' });
    const j = store.jobs.find((x) => x.userId === String(req.body?.userId || '') && x.id === String(req.body?.id || ''));
    if (!j) return res.status(404).json({ error: 'no such job' });
    if (['done', 'failed', 'cancelled'].includes(j.status)) return res.json({ ok: true, already: j.status });
    if (j.status === 'queued') { j.status = 'cancelled'; j.stageNote = 'cancelled before it started'; j.finishedAt = new Date().toISOString(); saveStore(); }
    else j.cancelRequested = true;
    res.json({ ok: true });
  });

  /* GET /research/receipts — ADMIN ONLY (bridge secret), the spend ledger tail */
  app.get('/research/receipts', (req, res) => {
    if (!(deps.bridgeSecretOk && deps.bridgeSecretOk(req, req.query.secret))) return res.status(403).json({ error: 'Unauthorized' });
    try {
      const lines = fs.existsSync(RECEIPTS_FILE) ? fs.readFileSync(RECEIPTS_FILE, 'utf8').trim().split('\n').slice(-40) : [];
      res.json({ receipts: lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log(`[research] attached — ${enabled() ? 'ENABLED' : `DISABLED (${disabledWhy()})`}`);
}

module.exports = {
  attachResearch,
  researchDesk: { createJob, getJob, cancelJob, enabled, disabledWhy, DEPTHS },
  _internals: { runJob, DEPTHS, jobPublic, store },
};
