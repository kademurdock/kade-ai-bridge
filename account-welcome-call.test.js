const test = require('node:test');
const assert = require('node:assert');
const {
  validWelcomeCall,
  welcomeCallTwiml,
  spokenPhone,
  passwordPieces,
  createWelcomeStore,
  accountWelcomeCallHandler,
  accountWelcomeTwimlHandler,
  accountWelcomeStatusHandler,
  VOICEMAIL_TEXT,
  GAP_MS,
  PER_NUMBER_PER_DAY,
  PLATFORM_PER_DAY,
  SCRIPT_TTL_MS,
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

const SPELL = (w) => `<say-as interpret-as="spell-out">${w}</say-as>`;

test('each word is said, then spelled with SSML spell-out, and the number is read one digit at a time', () => {
  assert.deepStrictEqual(passwordPieces(PW), [
    `amber. Spelled ${SPELL('amber')}. Then a dash.`,
    `cedar. Spelled ${SPELL('cedar')}. Then a dash.`,
    `otter. Spelled ${SPELL('otter')}. Then a dash.`,
    'The number 4, 8, 2.',
  ]);
  /* mixed parts spell each letter too, and say the capitals */
  assert.strictEqual(passwordPieces('Ab3cdefg')[0], `capital ${SPELL('a')}, ${SPELL('b')}, 3, ${SPELL('c')}, ${SPELL('d')}, ${SPELL('e')}, ${SPELL('f')}, ${SPELL('g')}.`);
});

test('the call says the sign-in and the spelled password twice, where to go, and hangs up', () => {
  const xml = welcomeCallTwiml({ to: '+14177704722', password: PW, name: 'David' });
  assert.match(xml, /^<Response>/);
  assert.match(xml, /<Hangup\/><\/Response>$/);
  assert.match(xml, /Hi David, this is Kade A I/);
  assert.strictEqual((xml.match(/4, 1, 7\. 7, 7, 0\. 4, 7, 2, 2/g) || []).length, 2);
  assert.strictEqual((xml.split(`amber. Spelled ${SPELL('amber')}.`).length - 1), 2);
  assert.strictEqual((xml.split(`otter. Spelled ${SPELL('otter')}.`).length - 1), 2);
  /* the SSML is real markup inside <Say>, not escaped text */
  assert.doesNotMatch(xml, /&lt;say-as/);
  assert.ok(xml.includes(SPELL('kademurdock')));
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

/** Twilio fetching the script: the token is the last path piece of the url we gave it. */
function tokenOf(url) {
  return String(url).split('/').pop();
}
async function quietly(fn) {
  const logged = [];
  const log = console.log;
  const err = console.error;
  const warn = console.warn;
  console.log = (...a) => logged.push(a.join(' '));
  console.error = (...a) => logged.push(a.join(' '));
  console.warn = (...a) => logged.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = err;
    console.warn = warn;
  }
  return logged.join('\n');
}
const twimlRes = () => ({ type() { return this; }, send(x) { this.xml = x; return this; } });

test('the handler needs the secret, spaces and caps calls, and never logs secrets', async () => {
  let clock = 1_000_000;
  const placed = [];
  const store = createWelcomeStore();
  const text = await quietly(async () => {
    const handler = accountWelcomeCallHandler({
      secretOk: (req, provided) => req.secret === 's3' || provided === 's3',
      placeCall: async (to, url) => { placed.push({ to, url }); return 'CA1'; },
      publicUrl: 'https://bridge.example.test',
      store,
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
    /* Twilio is given a one-time script address, never the password itself */
    assert.match(placed[0].url, /^https:\/\/bridge\.example\.test\/account-welcome-call\/twiml\/[0-9a-f]{32}$/);
    assert.doesNotMatch(placed[0].url, /amber/);
    assert.match(store.scripts.get(tokenOf(placed[0].url)).twiml, /amber\. Spelled/);

    const tooSoon = fakeRes();
    await handler({ secret: 's3', body }, tooSoon);
    assert.strictEqual(tooSoon.code, 429);
    assert.strictEqual(tooSoon.body.reason, 'gap');
    assert.ok(tooSoon.body.retryAfterSec > 0);

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
  });
  assert.ok(text.includes('...42'));
  assert.doesNotMatch(text, /amber|cedar|otter|482/);
  assert.doesNotMatch(text, /4175550142|5550142/);
  assert.doesNotMatch(text, /Davidson/);
});

test('a dry run checks everything, places nothing, and uses up no call', async () => {
  let clock = 5_000_000;
  let calls = 0;
  let configured = true;
  const handler = accountWelcomeCallHandler({
    secretOk: () => true,
    placeCall: async () => { calls += 1; return 'CA2'; },
    ready: () => configured,
    now: () => clock,
  });
  const body = { to: '+14175550142', password: PW, name: 'David' };
  for (let i = 0; i < 5; i += 1) {
    const dry = fakeRes();
    await handler({ body: { ...body, dryRun: true } }, dry);
    assert.strictEqual(dry.code, 200);
    assert.deepStrictEqual(dry.body, { ok: true, dryRun: true });
  }
  assert.strictEqual(calls, 0);
  /* the real call still goes, then a dry run right after is refused like a call would be */
  await quietly(async () => {
    const real = fakeRes();
    await handler({ body }, real);
    assert.strictEqual(real.code, 200);
  });
  assert.strictEqual(calls, 1);
  const dryTooSoon = fakeRes();
  await handler({ body: { ...body, dryRun: true } }, dryTooSoon);
  assert.strictEqual(dryTooSoon.code, 429);
  assert.strictEqual(dryTooSoon.body.reason, 'gap');
  /* no Twilio: refused up front, dry or not */
  clock += GAP_MS + 1;
  configured = false;
  const notSet = fakeRes();
  await handler({ body: { ...body, dryRun: true } }, notSet);
  assert.strictEqual(notSet.code, 503);
  assert.strictEqual(calls, 1);
});

test('the platform cap holds across numbers', async () => {
  const handler = accountWelcomeCallHandler({ secretOk: () => true, placeCall: async () => 'CA3' });
  await quietly(async () => {
    for (let i = 0; i < PLATFORM_PER_DAY; i += 1) {
      const r = fakeRes();
      await handler({ body: { to: `+1417555${String(1000 + i)}`, password: PW } }, r);
      assert.strictEqual(r.code, 200);
    }
  });
  const capped = fakeRes();
  await handler({ body: { to: '+14175559999', password: PW, dryRun: true } }, capped);
  assert.strictEqual(capped.code, 429);
  assert.strictEqual(capped.body.reason, 'platform-day');
});

test('a person hears the whole call; a voicemail hears no number and no password', async () => {
  const store = createWelcomeStore();
  const urls = [];
  let clock = 9_000_000;
  const post = accountWelcomeCallHandler({
    secretOk: () => true,
    placeCall: async (to, url) => { urls.push(url); return 'CA' + String(urls.length).repeat(32); },
    store,
    now: () => clock,
  });
  const twiml = accountWelcomeTwimlHandler({ store, allowVoicemailPassword: () => false, now: () => clock });
  const status = accountWelcomeStatusHandler({
    secretOk: () => true,
    fetchCall: async () => ({ status: 'completed', duration: 21, answeredBy: 'machine_end_beep' }),
    store,
  });

  const text = await quietly(async () => {
    await post({ body: { to: '+14175550142', password: PW, name: 'David' } }, fakeRes());
    clock += GAP_MS + 1;
    await post({ body: { to: '+14175550142', password: PW, name: 'David' } }, fakeRes());

    /* first call: a person */
    const human = twimlRes();
    twiml({ params: { token: tokenOf(urls[0]) }, body: { CallSid: 'CA' + '1'.repeat(32), AnsweredBy: 'human' } }, human);
    assert.match(human.xml, /amber\. Spelled/);
    assert.match(human.xml, /4, 1, 7\. 5, 5, 5/);
    /* the script works once */
    assert.strictEqual(store.scripts.has(tokenOf(urls[0])), false);
    const replay = twimlRes();
    twiml({ params: { token: tokenOf(urls[0]) }, body: { AnsweredBy: 'human' } }, replay);
    assert.doesNotMatch(replay.xml, /amber/);

    /* second call: an answering machine */
    const machine = twimlRes();
    twiml({ params: { token: tokenOf(urls[1]) }, body: { CallSid: 'CA' + '2'.repeat(32), AnsweredBy: 'machine_end_beep' } }, machine);
    assert.ok(machine.xml.includes(VOICEMAIL_TEXT.replace(/'/g, '&apos;')));
    assert.doesNotMatch(machine.xml, /amber|cedar|otter|4, 8, 2|4, 1, 7/);
    assert.match(machine.xml, /<Hangup\/><\/Response>$/);
    /* and the script is gone, not waiting to be fetched */
    assert.strictEqual(store.scripts.has(tokenOf(urls[1])), false);
  });
  assert.doesNotMatch(text, /amber|4175550142/);

  const looked = fakeRes();
  await status({ params: { sid: 'CA' + '2'.repeat(32) }, query: {} }, looked);
  assert.strictEqual(looked.body.played, 'voicemail');
  const first = fakeRes();
  await status({ params: { sid: 'CA' + '1'.repeat(32) }, query: {} }, first);
  assert.strictEqual(first.body.played, 'full');
});

test('the voicemail switch, a fax, and a script that ran out of time', async () => {
  const store = createWelcomeStore();
  let clock = 1_000;
  await quietly(async () => {
    store.scripts.set('a'.repeat(32), { at: clock, twiml: '<Response>FULL</Response>' });
    store.scripts.set('b'.repeat(32), { at: clock, twiml: '<Response>FULL</Response>' });
    store.scripts.set('c'.repeat(32), { at: clock, twiml: '<Response>FULL</Response>' });
    const allowed = accountWelcomeTwimlHandler({ store, allowVoicemailPassword: () => true, now: () => clock });
    const r1 = twimlRes();
    allowed({ params: { token: 'a'.repeat(32) }, body: { AnsweredBy: 'machine_end_silence' } }, r1);
    assert.strictEqual(r1.xml, '<Response>FULL</Response>');

    delete process.env.WELCOME_CALL_VOICEMAIL_PASSWORD;
    const strict = accountWelcomeTwimlHandler({ store, now: () => clock });
    const r2 = twimlRes();
    strict({ params: { token: 'b'.repeat(32) }, body: { AnsweredBy: 'fax' } }, r2);
    assert.doesNotMatch(r2.xml, /FULL/);

    store.scripts.set('d'.repeat(32), { at: clock, twiml: '<Response>FULL</Response>' });
    const r4 = twimlRes();
    strict({ params: { token: 'd'.repeat(32) }, body: { AnsweredBy: 'unknown' } }, r4);
    assert.doesNotMatch(r4.xml, /FULL/, 'an undecided answer never hears the password');

    clock += SCRIPT_TTL_MS + 1;
    const r3 = twimlRes();
    strict({ params: { token: 'c'.repeat(32) }, body: { CallSid: 'CA' + 'c'.repeat(32), AnsweredBy: 'human' } }, r3);
    assert.doesNotMatch(r3.xml, /FULL/);
    assert.match(r3.xml, /call you back/);
    assert.strictEqual(store.played.get('CA' + 'c'.repeat(32)), 'lost');
  });
});

test('a failed call answers 502, drops its script, and still logs no secrets', async () => {
  const store = createWelcomeStore();
  const text = await quietly(async () => {
    const handler = accountWelcomeCallHandler({
      secretOk: () => true,
      store,
      placeCall: async () => { throw new Error("The 'To' number +14175550142 is not a valid phone number."); },
    });
    const res = fakeRes();
    await handler({ body: { to: '+14175550142', password: PW } }, res);
    assert.strictEqual(res.code, 502);
  });
  assert.strictEqual(store.scripts.size, 0);
  assert.doesNotMatch(text, /amber|4175550142/);
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
  assert.deepStrictEqual(ok.body, { ok: true, status: 'completed', duration: 74, answeredBy: 'human', played: null });
});
