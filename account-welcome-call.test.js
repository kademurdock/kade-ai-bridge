const test = require('node:test');
const assert = require('node:assert');
const {
  validWelcomeCall,
  welcomeCallTwiml,
  spokenPhone,
  passwordPieces,
  accountWelcomeCallHandler,
  accountWelcomeStatusHandler,
  GAP_MS,
  PER_NUMBER_PER_DAY,
} = require('./account-welcome-call');

function fakeRes() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

const PW = 'amber-cedar-otter-482';

test('only a US number and a website-shaped password are accepted', () => {
  assert.deepStrictEqual(validWelcomeCall({ to: '+14175550142', password: PW, name: 'David Toker' }), {
    to: '+14175550142',
    password: PW,
    name: 'David',
  });
  assert.strictEqual(validWelcomeCall({ to: '4175550142', password: PW }), null);
  assert.strictEqual(validWelcomeCall({ to: '+14175550142', password: 'short' }), null);
  assert.strictEqual(validWelcomeCall({ to: '+14175550142', password: '<Say>hi</Say>-x-1' }), null);
  assert.strictEqual(validWelcomeCall({ to: '+14175550142', password: 'a b c d e f g h' }), null);
  /* a name can never smuggle markup into the call */
  assert.strictEqual(validWelcomeCall({ to: '+14175550142', password: PW, name: '<Hangup/>' }).name, 'Hangup');
});

test('the phone number is read digit by digit in its three groups', () => {
  assert.strictEqual(spokenPhone('+14177704722'), '4, 1, 7. 7, 7, 0. 4, 7, 2, 2');
});

test('each word is said and spelled, and the number is read one digit at a time', () => {
  assert.deepStrictEqual(passwordPieces(PW), [
    'amber. Spelled A, M, B, E, R. Then a dash.',
    'cedar. Spelled C, E, D, A, R. Then a dash.',
    'otter. Spelled O, T, T, E, R. Then a dash.',
    'The number 4, 8, 2.',
  ]);
});

test('the call says the sign-in and the spelled password twice, where to go, and hangs up', () => {
  const xml = welcomeCallTwiml({ to: '+14177704722', password: PW, name: 'David' });
  assert.match(xml, /^<Response>/);
  assert.match(xml, /<Hangup\/><\/Response>$/);
  assert.match(xml, /Hi David, this is Kade A I/);
  assert.strictEqual((xml.match(/4, 1, 7\. 7, 7, 0\. 4, 7, 2, 2/g) || []).length, 2);
  assert.strictEqual((xml.match(/Spelled A, M, B, E, R/g) || []).length, 2);
  assert.strictEqual((xml.match(/Spelled O, T, T, E, R/g) || []).length, 2);
  assert.strictEqual((xml.match(/The number 4, 8, 2\./g) || []).length, 2);
  assert.match(xml, /3 words and a number/);
  assert.match(xml, /kademurdock dot com/);
  assert.match(xml, /Kade A I app/);
  assert.match(xml, /change your password/);
  assert.match(xml, /Forgot your password/);
  /* slow: a pause after every piece of the password */
  assert.ok((xml.match(/<Pause length="2"\/>/g) || []).length >= 8);
});

test('the call works without a name', () => {
  const xml = welcomeCallTwiml({ to: '+14177704722', password: PW, name: '' });
  assert.match(xml, /Hi, this is Kade A I/);
});

test('the handler needs the secret, spaces and caps calls, and never logs secrets', async () => {
  let clock = 1_000_000;
  const placed = [];
  const logged = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => logged.push(a.join(' '));
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const handler = accountWelcomeCallHandler({
      secretOk: (req, provided) => req.secret === 's3' || provided === 's3',
      placeCall: async (to, twiml) => { placed.push({ to, twiml }); return 'CA1'; },
      now: () => clock,
    });
    const body = { to: '+14175550142', password: PW, name: 'Davidson' };

    const denied = fakeRes();
    await handler({ body }, denied);
    assert.strictEqual(denied.code, 403);
    const wrong = fakeRes();
    await handler({ body: { ...body, secret: 'nope' } }, wrong);
    assert.strictEqual(wrong.code, 403);

    const bad = fakeRes();
    await handler({ secret: 's3', body: { ...body, password: 'x' } }, bad);
    assert.strictEqual(bad.code, 400);

    const ok = fakeRes();
    await handler({ secret: 's3', body }, ok);
    assert.strictEqual(ok.code, 200);
    assert.deepStrictEqual(ok.body, { ok: true, sid: 'CA1' });
    assert.strictEqual(placed.length, 1);
    assert.match(placed[0].twiml, /Spelled A, M, B, E, R/);

    const tooSoon = fakeRes();
    await handler({ secret: 's3', body }, tooSoon);
    assert.strictEqual(tooSoon.code, 429);

    for (let i = 1; i < PER_NUMBER_PER_DAY; i += 1) {
      clock += GAP_MS + 1;
      const again = fakeRes();
      await handler({ secret: 's3', body }, again);
      assert.strictEqual(again.code, 200);
    }
    clock += GAP_MS + 1;
    const capped = fakeRes();
    await handler({ secret: 's3', body }, capped);
    assert.strictEqual(capped.code, 429);
    assert.strictEqual(capped.body.reason, 'number-day');

    /* a different number is not held up by the first one's cap */
    const other = fakeRes();
    await handler({ secret: 's3', body: { ...body, to: '+14175550199' } }, other);
    assert.strictEqual(other.code, 200);
  } finally {
    console.log = log;
    console.error = err;
  }
  const text = logged.join('\n');
  assert.ok(text.includes('...42'));
  assert.doesNotMatch(text, /amber|cedar|otter|482/);
  assert.doesNotMatch(text, /4175550142|5550142/);
  assert.doesNotMatch(text, /Davidson/);
});

test('a failed call answers 502 and still logs no secrets', async () => {
  const logged = [];
  const err = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const handler = accountWelcomeCallHandler({
      secretOk: () => true,
      placeCall: async () => { throw new Error("The 'To' number +14175550142 is not a valid phone number."); },
    });
    const res = fakeRes();
    await handler({ body: { to: '+14175550142', password: PW } }, res);
    assert.strictEqual(res.code, 502);
  } finally {
    console.error = err;
  }
  assert.doesNotMatch(logged.join('\n'), /amber|4175550142/);
});

test('the status lookup needs the secret and a real call id', async () => {
  const handler = accountWelcomeStatusHandler({
    secretOk: (req) => req.secret === 's3',
    fetchCall: async () => ({ status: 'completed', duration: '74', answeredBy: 'human' }),
  });
  const denied = fakeRes();
  await handler({ params: { sid: 'CA' + 'a'.repeat(32) }, query: {} }, denied);
  assert.strictEqual(denied.code, 403);
  const bad = fakeRes();
  await handler({ secret: 's3', params: { sid: '../calls' }, query: {} }, bad);
  assert.strictEqual(bad.code, 400);
  const ok = fakeRes();
  await handler({ secret: 's3', params: { sid: 'CA' + 'a'.repeat(32) }, query: {} }, ok);
  assert.deepStrictEqual(ok.body, { ok: true, status: 'completed', duration: 74, answeredBy: 'human' });
});
