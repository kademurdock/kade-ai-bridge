/* memory.js — THE PLATFORM'S OWN MEMORY (Part 63, Aug 14 2026).
 *
 * Her worry, verbatim spirit (Part 54 roadmap, her #1): the project's living
 * memory lives in a folder on her computer, so the platform loses its own
 * knowledge whenever that computer is off — "what if my crap computer takes
 * a crap." The private GitHub repo kademurdock/kade-ai-project is the
 * off-machine SOURCE OF TRUTH (sync_to_forge_repo.py pushes the folder up),
 * and THIS lane is how the platform reads it from anywhere: chat, phone,
 * a future fork tool, the NVDA agent's platform-memory hook, or a session
 * running while her PC sleeps.
 *
 * Three doors, all secret-gated:
 *   GET /memory/list    ?secret=…                 -> the doc shelf (paths + sizes)
 *   GET /memory/doc     ?secret=…&path=…[&head=N|&tail=N]  -> one doc's text
 *   GET /memory/search  ?secret=…&q=…             -> line hits across the shelf
 *
 * PRIVACY WALL, hard-coded and NOT configurable: the repo snapshot includes
 * PRIVATE_kade-ai_credentials.md and key files (that predates this lane).
 * This lane REFUSES to list, serve, or search anything credential-shaped.
 * The wall lives here, not in the caller, because the scoped secret may one
 * day sit on a fork tool that family-facing agents carry — Kiana talks to
 * everyone, including kids. A leak of MEMORY_TOOL_SECRET can at most read
 * project docs; it can never read a key.
 *
 * Secrets: BRIDGE_SECRET works (admin lane), or the scoped MEMORY_TOOL_SECRET
 * (same pattern as NOTIFY_AGENT_SECRET / NVDA_TOOL_SECRET — upserted on the
 * bridge AND LibreChat services Aug 14, value only in Railway).
 *
 * GitHub mechanics: tree via the Git Trees API (recursive), doc bodies via
 * the Git Blobs API keyed by blob sha — sha-keyed means the cache is
 * immutable-safe (a changed file is a NEW sha; an unchanged one never
 * refetches). Tree cache TTL 5 min (MEMORY_CACHE_TTL_MS), ?refresh=1 forces.
 * Oversized docs (PROJECT_STATUS.md is ~2MB) come back head-first by
 * default — that file is NEWEST-FIRST by design, so the head is exactly
 * what an agent wants; ?tail=N exists for the files that grow downward.
 * Search indexes each doc's first 200KB (partial files are named in the
 * response — honesty over silence) and returns up to 3 line hits per file,
 * 25 files max, query >= 3 chars. All caps exist to keep a tool call's
 * reply speakable, not to hide anything.
 *
 * Cost: $0. Private repo, PAT reads, RAM cache (~bounded 40MB, sha-keyed,
 * oldest-out). Kill the lane: MEMORY_ENABLED=0 (or drop the env vars).
 */
'use strict';

const MEMORY_REPO = process.env.MEMORY_REPO || 'kademurdock/kade-ai-project';
const CACHE_TTL_MS = Math.max(30_000, parseInt(process.env.MEMORY_CACHE_TTL_MS, 10) || 300_000);
const GH_TIMEOUT_MS = 12_000;
const SEARCH_INDEX_CAP = 200 * 1024;      // chars of each doc the search reads
const DOC_DEFAULT_CHARS = 20_000;         // head/tail default when uncapped would be huge
const DOC_FULL_THRESHOLD = 24_000;        // docs at/below this come back whole
const CACHE_MAX_BYTES = 40 * 1024 * 1024; // blob cache ceiling
const MAX_SEARCH_FILES = 25;
const MAX_HITS_PER_FILE = 3;

/* The wall. Case-insensitive, matched against the repo-relative path. */
const FORBIDDEN = [
  /private/i,            // PRIVATE_kade-ai_credentials.md and kin
  /credential/i,
  /authkey/i,            // AuthKey_*.p8 stems (any extension)
  /\.p8$/i,
  /api[ _-]?key/i,       // "Kiana openrouter api key.txt"
  /secret/i,
  /password/i,
  /\.jsonl$/i,           // sweep backups can embed raw agent configs
];
const ALLOWED_EXT = /\.(md|txt|py)$/i;

function forbidden(p) { return FORBIDDEN.some((re) => re.test(p)); }

function attachMemory(app, deps = {}) {
  if (process.env.MEMORY_ENABLED === '0') { console.log('[memory] disabled (MEMORY_ENABLED=0)'); return { enabled: false }; }
  const bridgeSecretOk = deps.bridgeSecretOk || (() => false);
  const PAT = process.env.GITHUB_PAT || '';
  if (!PAT) console.warn('[memory] GITHUB_PAT missing — the lane will answer 503 until it is set');

  const memorySecretOk = (req, provided) => {
    if (bridgeSecretOk(req, provided)) return true;
    const scoped = process.env.MEMORY_TOOL_SECRET;
    if (!scoped) return false;
    return provided === scoped || (req.get && req.get('x-memory-secret') === scoped);
  };

  /* ---- GitHub plumbing ---- */
  async function gh(path) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), GH_TIMEOUT_MS);
    try {
      const r = await fetch('https://api.github.com' + path, {
        headers: {
          Authorization: 'Bearer ' + PAT,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'kade-ai-bridge-memory',
        },
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error('GitHub ' + r.status + ' on ' + path.split('?')[0]);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  let treeCache = { at: 0, head: '', files: [] };
  async function getTree(force) {
    if (!force && treeCache.files.length && Date.now() - treeCache.at < CACHE_TTL_MS) return treeCache;
    const repoMeta = await gh('/repos/' + MEMORY_REPO);
    const branch = repoMeta.default_branch || 'main';
    const ref = await gh('/repos/' + MEMORY_REPO + '/git/ref/heads/' + branch);
    const head = ref.object.sha;
    if (treeCache.head === head && treeCache.files.length && !force) {
      treeCache.at = Date.now();
      return treeCache; // ref unmoved — the old tree is still the truth
    }
    const commit = await gh('/repos/' + MEMORY_REPO + '/git/commits/' + head);
    const tree = await gh('/repos/' + MEMORY_REPO + '/git/trees/' + commit.tree.sha + '?recursive=1');
    const files = (tree.tree || [])
      .filter((t) => t.type === 'blob' && ALLOWED_EXT.test(t.path) && !forbidden(t.path))
      .map((t) => ({ path: t.path, sha: t.sha, size: t.size || 0 }));
    treeCache = { at: Date.now(), head, files };
    console.log('[memory] tree refreshed: ' + files.length + ' readable docs @ ' + head.slice(0, 8));
    return treeCache;
  }

  /* Blob cache: sha -> text. Sha-keyed = immutable; bound by total bytes. */
  const blobCache = new Map();
  let blobCacheBytes = 0;
  async function getBlobText(sha) {
    if (blobCache.has(sha)) { const v = blobCache.get(sha); blobCache.delete(sha); blobCache.set(sha, v); return v; }
    const blob = await gh('/repos/' + MEMORY_REPO + '/git/blobs/' + sha);
    const text = Buffer.from(blob.content || '', 'base64').toString('utf8');
    blobCache.set(sha, text);
    blobCacheBytes += text.length;
    while (blobCacheBytes > CACHE_MAX_BYTES && blobCache.size > 1) {
      const oldest = blobCache.keys().next().value;
      blobCacheBytes -= blobCache.get(oldest).length;
      blobCache.delete(oldest);
    }
    return text;
  }

  function deny(res) { return res.status(403).json({ ok: false, error: 'That path is off the shelf. Credentials and key files are never served by the memory lane.' }); }
  function guard(req, res) {
    const provided = (req.query && req.query.secret) || (req.body && req.body.secret);
    if (!memorySecretOk(req, provided)) { res.status(403).json({ ok: false, error: 'Forbidden' }); return false; }
    if (!PAT) { res.status(503).json({ ok: false, error: 'Memory lane is not configured (GITHUB_PAT missing).' }); return false; }
    return true;
  }

  /* ---- the three doors ---- */
  app.get('/memory/list', async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const t = await getTree(req.query.refresh === '1');
      const files = t.files.map((f) => ({ path: f.path, kb: Math.max(1, Math.round(f.size / 1024)) }));
      res.json({
        ok: true, repo: MEMORY_REPO, head: t.head.slice(0, 8), count: files.length, files,
        note: 'Newest project state: PROJECT_STATUS.md (newest-first — read its head). Standing rules: NEXT_SESSION_PROMPT.md.',
      });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });

  app.get('/memory/doc', async (req, res) => {
    if (!guard(req, res)) return;
    const p = String(req.query.path || '').replace(/^\/+/, '').trim();
    if (!p) return res.status(400).json({ ok: false, error: 'Give a path (see /memory/list).' });
    if (forbidden(p) || !ALLOWED_EXT.test(p)) return deny(res);
    try {
      const t = await getTree(false);
      const f = t.files.find((x) => x.path === p) || t.files.find((x) => x.path.toLowerCase() === p.toLowerCase());
      if (!f) return res.status(404).json({ ok: false, error: 'No doc at that path. /memory/list shows the shelf.' });
      const text = await getBlobText(f.sha);
      const head = req.query.head ? parseInt(req.query.head, 10) : 0;
      const tail = req.query.tail ? parseInt(req.query.tail, 10) : 0;
      let mode = 'full', out = text;
      if (tail > 0) { mode = 'tail'; out = text.slice(-Math.min(tail, 400_000)); }
      else if (head > 0) { mode = 'head'; out = text.slice(0, Math.min(head, 400_000)); }
      else if (text.length > DOC_FULL_THRESHOLD) { mode = 'head'; out = text.slice(0, DOC_DEFAULT_CHARS); }
      res.json({
        ok: true, path: f.path, totalChars: text.length, returnedChars: out.length, mode, text: out,
        note: mode === 'full' ? undefined : 'Doc is ' + text.length + ' chars; this is the ' + mode + '. Use head=N or tail=N (chars) for more.',
      });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });

  app.get('/memory/search', async (req, res) => {
    if (!guard(req, res)) return;
    const q = String(req.query.q || '').trim();
    if (q.length < 3) return res.status(400).json({ ok: false, error: 'Query needs at least 3 characters.' });
    try {
      const t = await getTree(false);
      const needle = q.toLowerCase();
      const hits = []; const partial = [];
      let searched = 0;
      for (const f of t.files) {
        if (hits.length >= MAX_SEARCH_FILES * MAX_HITS_PER_FILE) break;
        let text;
        try { text = await getBlobText(f.sha); } catch { continue; }
        searched++;
        let scope = text;
        if (text.length > SEARCH_INDEX_CAP) { scope = text.slice(0, SEARCH_INDEX_CAP); partial.push(f.path); }
        if (!scope.toLowerCase().includes(needle)) continue;
        const lines = scope.split('\n');
        let per = 0;
        for (let i = 0; i < lines.length && per < MAX_HITS_PER_FILE; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            hits.push({ path: f.path, line: i + 1, text: lines[i].trim().slice(0, 240) });
            per++;
          }
        }
      }
      res.json({
        ok: true, query: q, filesSearched: searched, hitCount: hits.length, hits,
        partiallyIndexed: partial.length ? partial : undefined,
        note: partial.length ? 'Some large docs were searched in their first 200KB only (newest-first files keep their news there).' : undefined,
      });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });

  console.log('[memory] lane attached — repo ' + MEMORY_REPO + ', scoped secret ' + (process.env.MEMORY_TOOL_SECRET ? 'SET' : 'unset'));
  return { enabled: true };
}

module.exports = { attachMemory };
