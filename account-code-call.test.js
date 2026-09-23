const test = require('node:test');
const assert = require('node:assert');
const { validCodeCall, codeCallTwiml, accountCodeCallHandler, GAP_MS } = require('./account-code-call');

function fakeRes() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

test('only a US number and six digits are accepted', () => {
  assert.deepStrictEqual(validCodeCall({ to: '+14175550142', code: '004821' }), { to: '+14175550142', code: '004821' });
  assert.strictEqual(validCodeCall({ to: '4175550142', code: '004821' }), null);
  assert.strictEqual(validCodeCall({ to: '+14175550142', code: '4821' }), null);
  assert.strictEqual(validCodeCall({ to: '+14175550142', code: '<Say>1</Say>' }), null);
});

test('the call reads each digit, twice, and hangs up', () => {
  const xml = codeCallTwiml('004821');
  assert.strictEqual((xml.match(/0, 0, 4, 8, 2, 1/g) || []).length, 2);
  assert.match(xml, /<Hangup\/><\/Response>$/);
});

test('the handler needs the secret, spaces calls to one number, and never logs the code', async () => {
  let clock = 1_000_000;
  const placed = [];
  const logged = [];
  const log = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    const handler = accountCodeCallHandler({
      secretOk: (req, provided) => req.secret === 's3' || provided === 's3',
      placeCall: async (to, twiml) => { placed.push({ to, twiml }); return 'CA1'; },
      now: () => clock,
    });
    const denied = fakeRes();
    await handler({ body: { to: '+14175550142', code: '123456' } }, denied);
    assert.strictEqual(denied.code, 403);

    const ok = fakeRes();
    await handler({ secret: 's3', body: { to: '+14175550142', code: '123456' } }, ok);
    assert.strictEqual(ok.code, 200);
    assert.strictEqual(placed.length, 1);

    const tooSoon = fakeRes();
    await handler({ secret: 's3', body: { to: '+14175550142', code: '654321' } }, tooSoon);
    assert.strictEqual(tooSoon.code, 429);

    clock += GAP_MS + 1;
    const later = fakeRes();
    await handler({ secret: 's3', body: { to: '+14175550142', code: '654321' } }, later);
    assert.strictEqual(later.code, 200);
  } finally {
    console.log = log;
  }
  const text = logged.join('\n');
  assert.doesNotMatch(text, /123456|654321/);
  assert.doesNotMatch(text, /4175550142/);
});
