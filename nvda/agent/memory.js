'use strict';
/**
 * Memory — three tiers, because "how does the agent remember?" has three
 * different answers.
 *
 *   1. WORKING memory (per run): the live transcript (in observer.js) plus a
 *      scratchpad the loop writes to and reads back — "the Publish button is
 *      under the App Privacy heading", "this dialog has a SECOND confirm". Feeds
 *      straight into the next decision. Gone when the run ends.
 *
 *   2. TASK memory (durable, per user): the accessible PATH that worked, saved
 *      and replayed. This is the quiet superpower for a blind user — the agent
 *      figures out the screen-reader route to a thing ONCE, and next time it
 *      starts from the known-good path instead of re-groping. JSON on disk
 *      (the bridge's Railway volume survives deploys).
 *
 *   3. PLATFORM memory (the rest of the estate): durable facts about Kade go to
 *      /api/memories so Kiana and the others know them in chat and on the phone;
 *      static procedures can live in the memory-home repo. Both are injected
 *      hooks so this module stays standalone and testable.
 */

const fs = require('fs');
const path = require('path');

function taskKey(goal) {
  return String(goal || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 8)
    .sort()
    .join('-') || 'task';
}
const STOP = new Set(['the', 'and', 'for', 'get', 'got', 'this', 'that', 'with', 'into', 'from', 'you', 'your', 'please', 'can', 'could', 'would']);

class Memory {
  constructor(opts = {}) {
    this.userId = opts.userId || 'default';
    this.dir = opts.dir || '';
    this.onRemember = opts.onRemember || null; // async (fact) => {}  — e.g. POST /api/memories
    this.working = [];                          // per-run scratchpad
    this.task = {};                             // taskKey -> record
    this._file = this.dir ? path.join(this.dir, `task_memory_${safe(this.userId)}.json`) : '';
    if (this._file && fs.existsSync(this._file)) {
      try { this.task = JSON.parse(fs.readFileSync(this._file, 'utf8')); } catch { this.task = {}; }
    }
  }

  // --- working memory ---
  note(text) { if (text) this.working.push({ t: Date.now(), text: String(text) }); }
  workingNotes(n = 12) { return this.working.slice(-n).map((w) => w.text); }
  clearWorking() { this.working = []; }

  // --- task memory ---
  recall(goal) { return this.task[taskKey(goal)] || null; }

  /** Merge what worked for a goal: the ordered chords/idioms + freeform notes. */
  learn(goal, { steps = [], notes = [] } = {}) {
    const k = taskKey(goal);
    const prev = this.task[k] || { goal, steps: [], notes: [], runs: 0 };
    const rec = {
      goal,
      steps: steps.length ? steps : prev.steps,
      notes: dedupe([...(prev.notes || []), ...notes]).slice(-20),
      runs: (prev.runs || 0) + 1,
      lastUsed: Date.now(),
    };
    this.task[k] = rec;
    this._persist();
    return rec;
  }

  /** A hint block for the planner, built from what we already know. */
  hint(goal) {
    const rec = this.recall(goal);
    if (!rec) return '';
    const lines = [];
    if (rec.steps && rec.steps.length) lines.push('Known path that worked before: ' + rec.steps.join(' , '));
    if (rec.notes && rec.notes.length) lines.push('Notes about this machine: ' + rec.notes.slice(-5).join(' ; '));
    return lines.join('\n');
  }

  // --- platform memory ---
  async remember(fact) {
    this.note('remember: ' + fact);
    if (this.onRemember) { try { await this.onRemember(fact); return true; } catch { return false; } }
    return false;
  }

  _persist() {
    if (!this._file) return;
    try { fs.mkdirSync(path.dirname(this._file), { recursive: true }); fs.writeFileSync(this._file, JSON.stringify(this.task, null, 2)); } catch { /* non-fatal */ }
  }
}

function safe(s) { return String(s).replace(/[^a-z0-9_-]+/gi, '_'); }
function dedupe(arr) { return [...new Set(arr.map((x) => String(x)))]; }

module.exports = { Memory, taskKey };
