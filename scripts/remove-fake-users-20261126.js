#!/usr/bin/env node
'use strict';
/* Nov 26 2026 (lockdown): take the fake phone rows out of the bridge's user list.
 *
 * The bridge keeps its phone users in one JSON file, bridge-users.json, on the Railway volume
 * (RAILWAY_VOLUME_MOUNT_PATH). Each key is a phone number, each value is that person's row. This
 * script removes exactly these rows and nothing else:
 *   +14155551234  (named AuditProbe)
 *   +14155557777  (named AuditProbe2)
 *   the row named "Mallory Probe7979"  (number found when the script runs)
 *   the row named "pentest-i6575"      (number found when the script runs)
 * A fixed number is only removed if its row still has the AuditProbe name, so a real person who
 * somehow holds that number is never removed by mistake.
 * The two "Destiny" rows (+14175550134, +14175550101) are NOT touched. The script only reports
 * them, so Kade can decide about them herself.
 *
 * It prints phone numbers and names only. It never prints passwords, emails or anything else.
 *
 * How to run it:
 *   node scripts/remove-fake-users-20261126.js            looks only: says what it would remove
 *   node scripts/remove-fake-users-20261126.js --apply    removes them
 *   --file <path> reads another copy of the file instead of the one on the volume.
 * With --apply it first writes two backups next to the file: the removed rows on their own, and a
 * full copy of the file as it was. Then it writes the new file in one step (temp file, then rename).
 *
 * IMPORTANT: the running bridge holds the user list in memory and writes the WHOLE list back every
 * time anyone registers or changes their agent. So restart the bridge right after --apply, or the
 * removed rows can come back. Then run the script again without --apply: it should find nothing.
 */
const fs = require('fs');
const path = require('path');

const FIXED_NUMBERS = [
  { phone: '+14155551234', expect: /auditprobe/i, label: 'AuditProbe' },
  { phone: '+14155557777', expect: /auditprobe/i, label: 'AuditProbe2' },
];
const NAMES = ['Mallory Probe7979', 'pentest-i6575'];
const LEAVE_ALONE = ['+14175550134', '+14175550101']; // the two "Destiny" rows: report only
const LOOKS_FAKE = /probe|pentest|audit|mallory/i;

/* Names came from a stranger: keep only printable characters so nothing odd reaches the terminal. */
function safeText(v) {
  return String(v == null ? '' : v).replace(/[^\x20-\x7E -￿]/g, '?').slice(0, 80);
}
function nameOf(row) {
  return row && typeof row === 'object' ? String(row.name || '') : '';
}
function sameName(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/* plan(rows) -> { remove: [{ phone, name, why }], skipped: [...], leftAlone: [...], lookAt: [...] } */
function plan(rows) {
  const remove = [];
  const skipped = [];
  const leftAlone = [];
  const lookAt = [];
  const taken = new Set();
  for (const f of FIXED_NUMBERS) {
    if (!Object.prototype.hasOwnProperty.call(rows, f.phone)) {
      skipped.push({ phone: f.phone, name: '', why: `not in the file (expected ${f.label})` });
      continue;
    }
    const name = nameOf(rows[f.phone]);
    if (f.expect.test(name)) {
      remove.push({ phone: f.phone, name, why: 'fixed number' });
      taken.add(f.phone);
    } else {
      skipped.push({ phone: f.phone, name, why: `kept: the name is not ${f.label}` });
    }
  }
  for (const wanted of NAMES) {
    const found = Object.keys(rows).filter((p) => sameName(nameOf(rows[p]), wanted));
    if (!found.length) skipped.push({ phone: '', name: wanted, why: 'no row has this name' });
    for (const p of found) {
      if (taken.has(p)) continue;
      if (LEAVE_ALONE.includes(p)) {
        skipped.push({ phone: p, name: nameOf(rows[p]), why: 'kept: this is one of the numbers to leave alone' });
        continue;
      }
      remove.push({ phone: p, name: nameOf(rows[p]), why: `named "${wanted}"` });
      taken.add(p);
    }
  }
  for (const p of LEAVE_ALONE) {
    if (Object.prototype.hasOwnProperty.call(rows, p)) leftAlone.push({ phone: p, name: nameOf(rows[p]) });
  }
  for (const p of Object.keys(rows)) {
    if (taken.has(p) || LEAVE_ALONE.includes(p)) continue;
    if (LOOKS_FAKE.test(nameOf(rows[p]))) lookAt.push({ phone: p, name: nameOf(rows[p]) });
  }
  return { remove, skipped, leftAlone, lookAt };
}

function line(r) {
  return `  ${r.phone || '(no number)'}  "${safeText(r.name)}"${r.why ? '  - ' + r.why : ''}`;
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

function run(argv = process.argv.slice(2), env = process.env, out = console.log) {
  const apply = argv.includes('--apply');
  const fileAt = argv.indexOf('--file');
  let file;
  if (fileAt >= 0) file = argv[fileAt + 1];
  else if (env.RAILWAY_VOLUME_MOUNT_PATH) file = path.join(env.RAILWAY_VOLUME_MOUNT_PATH, 'bridge-users.json');
  if (!file) {
    out('No file. Run this inside the bridge service (it reads RAILWAY_VOLUME_MOUNT_PATH), or pass --file <path>.');
    return 2;
  }
  if (!fs.existsSync(file)) { out(`The file is not there: ${file}`); return 2; }
  const raw = fs.readFileSync(file, 'utf8');
  const rows = JSON.parse(raw);
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) { out('The file is not a list of phone rows. Nothing changed.'); return 2; }

  const p = plan(rows);
  out(`User file: ${file}`);
  out(`Rows in it: ${Object.keys(rows).length}`);
  out(apply ? 'Mode: APPLY (rows will be removed)' : 'Mode: look only (nothing will change; add --apply to remove)');
  out('');
  out(`To remove (${p.remove.length}):`);
  for (const r of p.remove) out(line(r));
  if (p.skipped.length) { out(''); out('Not removed:'); for (const r of p.skipped) out(line(r)); }
  out('');
  out(`Left alone on purpose, for Kade to decide (${p.leftAlone.length}):`);
  for (const r of p.leftAlone) out(line(r));
  if (p.lookAt.length) {
    out('');
    out(`Other rows whose names look like testing, NOT removed, check by hand (${p.lookAt.length}):`);
    for (const r of p.lookAt) out(line(r));
  }
  out('');
  if (!apply) { out('Look-only run: nothing changed.'); return 0; }
  if (!p.remove.length) { out('Nothing to remove. Nothing changed.'); return 0; }

  const dir = path.dirname(file);
  const when = stamp();
  const removedFile = path.join(dir, `bridge-users.removed-20261126-${when}.json`);
  const fullFile = path.join(dir, `bridge-users.before-removal-${when}.json`);
  const removedRows = {};
  for (const r of p.remove) removedRows[r.phone] = rows[r.phone];
  fs.writeFileSync(removedFile, JSON.stringify(removedRows, null, 2), { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(fullFile, raw, { mode: 0o600, flag: 'wx' });
  out(`Backup of the removed rows: ${removedFile}`);
  out(`Full copy of the file as it was: ${fullFile}`);

  const next = { ...rows };
  for (const r of p.remove) delete next[r.phone];
  const tmp = file + `.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(tmp, file);

  const check = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stillThere = p.remove.filter((r) => Object.prototype.hasOwnProperty.call(check, r.phone));
  out(`Removed ${p.remove.length - stillThere.length} row(s). Rows now: ${Object.keys(check).length}.`);
  if (stillThere.length) { out('Some rows are still there. Check the file.'); return 1; }
  out('');
  out('NOW RESTART THE BRIDGE. The running bridge still has these rows in memory and writes its whole');
  out('list back on the next change. After the restart, run this again without --apply to confirm.');
  return 0;
}

if (require.main === module) process.exitCode = run();

module.exports = { plan, run, safeText, FIXED_NUMBERS, NAMES, LEAVE_ALONE };
