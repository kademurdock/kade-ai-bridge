/* live-billing.test.js — Sep 26 2026, Part 295 (Kade: "Spotter: fix both").
 *
 * The Spotter used to cost a flat $0.055 a wall-clock minute. Google bills Live
 * per turn for the whole context window, and says what it billed in
 * usageMetadata. These hold the price table, the per-call meter, and the
 * progressive posting (no lost call on a restart, no double charge) still.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'livebill-'));
const lb = require('./live-billing');

const MODEL = 'models/gemini-3.1-flash-live-preview';
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} != ${b}`);
const quiet = async (fn) => {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
};

test('the checked table: gemini-3.1-flash-live-preview at Google\'s Sep 24 2026 paid rates', () => {
  const row = lb.priceRow(MODEL);
  assert.deepEqual({ ...row.in }, { TEXT: 0.75, DOCUMENT: 0.75, AUDIO: 3, IMAGE: 1, VIDEO: 1 });
  assert.deepEqual({ ...row.out }, { TEXT: 4.5, AUDIO: 12 });
  assert.equal(lb.priceRow('gemini-3.1-flash-live-preview'), row, 'with or without models/');
  assert.equal(lb.priceRow('gemini-3.8-live'), row, 'the pricing page gives 3.8 Live the same row');
  assert.equal(lb.priceRow('models/gemini-9-live'), null, 'an unknown model is never guessed');
  assert.match(lb.LIVE_PRICES_CHECKED, /ai\.google\.dev\/gemini-api\/docs\/pricing/);
});

test('a camera turn is priced per modality: audio, video and text in; audio out', () => {
  const r = lb.priceLiveUsage({
    promptTokenCount: 12000,
    promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 3000 }, { modality: 'VIDEO', tokenCount: 8000 }, { modality: 'TEXT', tokenCount: 1000 }],
    responseTokenCount: 500,
    responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 500 }],
    totalTokenCount: 12500,
  }, MODEL);
  // 3000 x $3 + 8000 x $1 + 1000 x $0.75 + 500 x $12, per million
  close(r.usd, 0.02375);
  assert.deepEqual(r.tokens.in, { AUDIO: 3000, VIDEO: 8000, TEXT: 1000 });
  assert.deepEqual(r.tokens.out, { AUDIO: 500 });
});

test('tokens the breakdown does not name are billed at the audio rate, never free', () => {
  const r = lb.priceLiveUsage({
    promptTokenCount: 10000, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 4000 }],
    responseTokenCount: 200,
  }, MODEL);
  close(r.usd, (10000 * 3 + 200 * 12) / 1e6);
  assert.equal(r.tokens.in.UNSPLIT, 6000);
  assert.equal(r.tokens.out.UNSPLIT, 200);
});

test('thinking is billed once, at the text output rate, beside or inside the response', () => {
  const beside = lb.priceLiveUsage({
    promptTokenCount: 1000, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1000 }],
    responseTokenCount: 100, responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 100 }],
    thoughtsTokenCount: 400, totalTokenCount: 1500,
  }, MODEL);
  close(beside.usd, (1000 * 0.75 + 100 * 12 + 400 * 4.5) / 1e6);
  const inside = lb.priceLiveUsage({
    promptTokenCount: 1000, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1000 }],
    responseTokenCount: 500, thoughtsTokenCount: 400, totalTokenCount: 1500,
  }, MODEL);
  close(inside.usd, beside.usd, 'same bill when the total says thoughts sit inside the response');
});

test('an unknown model or a junk report prices to null (the fallback takes over)', () => {
  assert.equal(lb.priceLiveUsage({ promptTokenCount: 5 }, 'models/other'), null);
  assert.equal(lb.priceLiveUsage(null, MODEL), null);
  close(lb.priceLiveUsage({}, MODEL).usd, 0);
});

function call(extra = {}) {
  return { userId: 'u-amber', agentName: 'Kiana', streamSid: 'web-test', liveSecondsTotal: 0, ...extra };
}
const REPORT = {
  promptTokenCount: 12000,
  promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 3000 }, { modality: 'VIDEO', tokenCount: 8000 }, { modality: 'TEXT', tokenCount: 1000 }],
  responseTokenCount: 500, responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 500 }],
};

test('posts the REAL cost as video_live, never doubled here (the fork applies the user price)', async () => {
  process.env.KADE_USAGE_EVENT_SECRET = 'offline';
  process.env.KADE_BILLING_MULTIPLIER = '2';
  try {
    const s = call();
    const posts = [];
    lb.startSegment(s);
    lb.addUsage(s, REPORT, MODEL);
    s.liveSecondsTotal = 30;
    assert.equal(await lb.flush(s, 'stop', { post: async (b) => posts.push(b) }), true);
    assert.equal(posts.length, 1);
    const b = posts[0];
    assert.equal(b.service, 'video_live');
    assert.equal(b.unit, 'minutes');
    assert.equal(b.quantity, 0.5);
    close(b.costUSD, 0.02375, 'real cost, 1x');
    assert.equal(b.userId, 'u-amber');
    assert.equal(b.metadata.source, 'google usage');
    assert.equal(b.metadata.model, 'gemini-3.1-flash-live-preview');
    assert.equal(b.metadata.reports, 1);
    assert.deepEqual(b.metadata.tokens.in, { AUDIO: 3000, VIDEO: 8000, TEXT: 1000 });
    assert.equal(await lb.flush(s, 'stop', { post: async (x) => posts.push(x) }), false, 'nothing left, nothing sent');
    assert.equal(posts.length, 1);
  } finally { delete process.env.KADE_USAGE_EVENT_SECRET; delete process.env.KADE_BILLING_MULTIPLIER; }
});

test('progressive: due at $0.10 waiting, or after a minute with half a cent waiting', () => {
  const s = call();
  lb.startSegment(s);
  const b = s._liveBill;
  const t0 = b.lastPostAt;
  assert.equal(lb.due(b, t0 + 120000), false, 'nothing waiting is never due');
  lb.addUsage(s, REPORT, MODEL); // $0.02375
  assert.equal(lb.due(b, t0 + 1000), false, 'too soon, too small');
  assert.equal(lb.due(b, t0 + 60000), true, 'a minute on, half a cent or more waiting');
  for (let i = 0; i < 4; i++) lb.addUsage(s, REPORT, MODEL); // $0.11875
  assert.equal(lb.due(b, t0 + 1000), true, 'a dime waiting goes now');
});

test('a failure that proves nothing landed (5xx, refused) is kept and sent exactly once later', async () => {
  process.env.KADE_USAGE_EVENT_SECRET = 'offline';
  try {
    const s = call();
    const posts = [];
    lb.startSegment(s);
    lb.addUsage(s, REPORT, MODEL);
    s.liveSecondsTotal = 60;
    const fail500 = async () => { const e = new Error('Request failed with status code 500'); e.response = { status: 500 }; throw e; };
    await quiet(() => lb.flush(s, 'tick', { post: fail500 }));
    lb.addUsage(s, REPORT, MODEL);
    const refused = async () => { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; };
    await quiet(() => lb.flush(s, 'tick', { post: refused }));
    assert.equal(await lb.flush(s, 'tick', { post: async (b) => posts.push(b) }), true);
    assert.equal(posts.length, 1);
    close(posts[0].costUSD, 0.0475, 'both reports, once');
    assert.equal(posts[0].quantity, 1, 'and the minute rides along once');
  } finally { delete process.env.KADE_USAGE_EVENT_SECRET; }
});

test('a timeout or a 4xx may have landed, so it is never re-sent (no double charge)', async () => {
  process.env.KADE_USAGE_EVENT_SECRET = 'offline';
  try {
    for (const make of [
      () => { const e = new Error('timeout of 8000ms exceeded'); e.code = 'ECONNABORTED'; return e; },
      () => { const e = new Error('Request failed with status code 400'); e.response = { status: 400 }; return e; },
    ]) {
      const s = call();
      const posts = [];
      lb.startSegment(s);
      lb.addUsage(s, REPORT, MODEL);
      await quiet(() => lb.flush(s, 'tick', { post: async () => { throw make(); } }));
      assert.equal(await lb.flush(s, 'tick', { post: async (b) => posts.push(b) }), false);
      assert.equal(posts.length, 0);
    }
  } finally { delete process.env.KADE_USAGE_EVENT_SECRET; }
});

test('a stop retries a refused post before giving it back, without really waiting in the test', async () => {
  process.env.KADE_USAGE_EVENT_SECRET = 'offline';
  try {
    const s = call();
    lb.startSegment(s);
    lb.addUsage(s, REPORT, MODEL);
    let tries = 0;
    const waits = [];
    const ok = await lb.flush(s, 'stop', {
      post: async () => { tries++; if (tries < 3) { const e = new Error('refused'); e.code = 'ECONNREFUSED'; throw e; } },
      sleep: async (ms) => { waits.push(ms); },
    });
    assert.equal(ok, true);
    assert.equal(tries, 3);
    assert.deepEqual(waits, [5000, 10000]);
  } finally { delete process.env.KADE_USAGE_EVENT_SECRET; }
});

test('a Live connection with no usageMetadata at all falls back to minutes x LIVE_COST_PER_MIN_USD', async () => {
  process.env.KADE_USAGE_EVENT_SECRET = 'offline';
  try {
    const s = call();
    const posts = [];
    lb.startSegment(s);
    s.liveSecondsTotal = 120;
    await quiet(() => lb.endSegment(s));
    lb.endSegment(s); // stopLive can run twice; the second adds nothing
    await lb.flush(s, 'stop', { post: async (b) => posts.push(b) });
    assert.equal(posts.length, 1);
    close(posts[0].costUSD, 0.11, 'two minutes at $0.055');
    assert.equal(posts[0].metadata.source, 'per-minute estimate');
    assert.equal(posts[0].quantity, 2);
  } finally { delete process.env.KADE_USAGE_EVENT_SECRET; }
});

test('a metered connection never also pays the estimate; a later silent one does (mixed)', async () => {
  process.env.KADE_USAGE_EVENT_SECRET = 'offline';
  try {
    const s = call();
    const posts = [];
    lb.startSegment(s);
    lb.addUsage(s, REPORT, MODEL);
    s.liveSecondsTotal = 600;
    lb.endSegment(s);
    lb.startSegment(s); // Google's ~10-minute reconnect
    s.liveSecondsTotal = 660;
    await quiet(() => lb.endSegment(s));
    await lb.flush(s, 'stop', { post: async (b) => posts.push(b) });
    close(posts[0].costUSD, 0.02375 + 0.055);
    assert.equal(posts[0].metadata.source, 'mixed');
    close(posts[0].metadata.estimatedUSD, 0.055);
  } finally { delete process.env.KADE_USAGE_EVENT_SECRET; }
});

test('the hang-up post carries leftover minutes even with no cost left; never a second copy', async () => {
  process.env.KADE_USAGE_EVENT_SECRET = 'offline';
  try {
    const s = call();
    const posts = [];
    const post = async (b) => posts.push(b);
    lb.startSegment(s);
    lb.addUsage(s, REPORT, MODEL);
    s.liveSecondsTotal = 60;
    await lb.flush(s, 'tick', { post });
    s.liveSecondsTotal = 80;
    await quiet(() => lb.flush(s, 'final', { post }));
    assert.equal(posts.length, 2);
    assert.equal(posts[1].costUSD, 0);
    assert.equal(posts[1].quantity, 0.3333);
    await quiet(() => lb.flush(s, 'final', { post }));
    assert.equal(posts.length, 2);
  } finally { delete process.env.KADE_USAGE_EVENT_SECRET; }
});

test('nobody to bill (no secret, or an unlinked caller) posts nothing and never throws', async () => {
  const posts = [];
  const s = call({ userId: null });
  lb.startSegment(s);
  lb.addUsage(s, REPORT, MODEL);
  process.env.KADE_USAGE_EVENT_SECRET = 'offline';
  try {
    assert.equal(await lb.flush(s, 'stop', { post: async (b) => posts.push(b) }), false);
  } finally { delete process.env.KADE_USAGE_EVENT_SECRET; }
  const s2 = call();
  lb.startSegment(s2);
  lb.addUsage(s2, REPORT, MODEL);
  assert.equal(await lb.flush(s2, 'stop', { post: async (b) => posts.push(b) }), false);
  assert.equal(posts.length, 0);
  assert.equal(await lb.flush(null, 'final'), false);
});
