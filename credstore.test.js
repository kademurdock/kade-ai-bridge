const test = require('node:test');
const assert = require('node:assert');
const cs = require('./credstore');

const KEY = 'a'.repeat(64); // 32 bytes of hex
const withKey = (fn) => {
  const old = process.env[cs.KEY_ENV];
  process.env[cs.KEY_ENV] = KEY;
  try { return fn(); } finally {
    if (old === undefined) delete process.env[cs.KEY_ENV]; else process.env[cs.KEY_ENV] = old;
  }
};
const withoutKey = (fn) => {
  const old = process.env[cs.KEY_ENV];
  delete process.env[cs.KEY_ENV];
  try { return fn(); } finally { if (old !== undefined) process.env[cs.KEY_ENV] = old; }
};

/* The live rows, by shape — Kade carries a password, Wiley is email-only. */
const KADE = { name: 'Kade', agentId: 'agent_x', lcEmail: 'k@example.com', lcPass: 'Sw0rdfish!42' };
const WILEY = { name: 'Wiley Murdock', agentId: 'agent_x', lcEmail: 'w@example.com' };

test('round trip returns the exact password the phone lane needs to log in', () => {
  withKey(() => {
    const disk = cs.encodeRow(KADE);
    assert.strictEqual(disk.lcPass, undefined, 'plaintext must not reach the disk shape');
    assert.match(disk.lcPassEnc, /^v1:/);
    assert.strictEqual(cs.decodeRow(disk).lcPass, KADE.lcPass);
  });
});

test('the ciphertext does not contain the password', () => {
  withKey(() => {
    assert.ok(!cs.encodeRow(KADE).lcPassEnc.includes('Sw0rdfish'));
  });
});

test('two encryptions of the same password differ (a fresh IV each time)', () => {
  withKey(() => {
    assert.notStrictEqual(cs.encodeRow(KADE).lcPassEnc, cs.encodeRow(KADE).lcPassEnc);
  });
});

test('tampered ciphertext is refused, not silently accepted', () => {
  withKey(() => {
    const disk = cs.encodeRow(KADE);
    const parts = disk.lcPassEnc.split(':');
    const bytes = Buffer.from(parts[3], 'base64');
    bytes[0] ^= 0xff;
    parts[3] = bytes.toString('base64');
    assert.strictEqual(cs.decodeRow({ ...disk, lcPassEnc: parts.join(':') }).lcPass, undefined);
  });
});

test('email-only rows are untouched — 4 of 6 rows look like this', () => {
  withKey(() => {
    assert.deepStrictEqual(cs.encodeRow(WILEY), WILEY);
    assert.deepStrictEqual(cs.decodeRow(WILEY), WILEY);
  });
});

/* ⚠️ The fail-safe. Getting this wrong moves Kade's and Holly's calls off their
 * own seats, which is worse than the leak being fixed. */
test('WITH NO KEY, nothing changes — legacy plaintext survives a save/load', () => {
  withoutKey(() => {
    const disk = cs.encodeRow(KADE);
    assert.strictEqual(disk.lcPass, KADE.lcPass, 'must NOT drop the password when it cannot encrypt');
    assert.strictEqual(disk.lcPassEnc, undefined);
    assert.strictEqual(cs.decodeRow(disk).lcPass, KADE.lcPass);
  });
});

test('legacy plaintext on disk is still readable after the key is added', () => {
  withKey(() => {
    assert.strictEqual(cs.decodeRow({ ...KADE }).lcPass, KADE.lcPass, 'migration must not need a flag day');
  });
});

test('migration: a legacy row re-encodes to ciphertext on its next save', () => {
  withKey(() => {
    const migrated = cs.encodeRow(cs.decodeRow({ ...KADE }));
    assert.strictEqual(migrated.lcPass, undefined);
    assert.strictEqual(cs.decodeRow(migrated).lcPass, KADE.lcPass);
  });
});

/* The wire. */
test('/users reports THAT a password exists, never what it is', () => {
  withKey(() => {
    for (const row of [KADE, cs.encodeRow(KADE)]) {
      const r = cs.redactRow(row);
      assert.strictEqual(r.lcPass, undefined);
      assert.strictEqual(r.lcPassEnc, undefined);
      assert.strictEqual(r.hasPass, true);
      assert.strictEqual(r.lcEmail, 'k@example.com', 'the rest of the row still comes back');
    }
    const w = cs.redactRow(WILEY);
    assert.strictEqual(w.hasPass, undefined, 'email-only rows must not claim a password');
  });
});

test('redaction survives JSON — the check is on the serialized body', () => {
  withKey(() => {
    const body = JSON.stringify(cs.mapRows({ '+1555': KADE, '+1556': WILEY }, cs.redactRow));
    assert.ok(!body.includes('Sw0rdfish!42'), 'no password may appear anywhere in the response');
    assert.ok(body.includes('hasPass'));
  });
});

test('junk input never throws', () => {
  for (const v of [null, undefined, 'string', 42]) {
    cs.encodeRow(v); cs.decodeRow(v); cs.redactRow(v);
  }
});
