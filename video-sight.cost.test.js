/* video-sight.cost.test.js — Sep 26 2026, Part 295.
 *
 * Camera video on calls bills the caller the sum of each look's OpenRouter cost.
 * With her Google key inside OpenRouter (BYOK), usage.cost drops to OpenRouter's
 * fee and Google's charge moves to cost_details.upstream_inference_cost: a look
 * must cost the sum, and the Google share lands in the bridge's Google ledger.
 * A normal reply restates its cost in that field: it costs usage.cost once and
 * never reaches the Google ledger (monthly.js already counts it as OpenRouter).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'vsight-'));
const { addLookCost } = require('./video-sight')._test;
const gw = require('./google-watch');

test('a BYOK look costs fee + Google\'s charge, and Google\'s share is on the books', () => {
  const s = {};
  addLookCost(s, 'google/gemini-3.1-pro-preview', { cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.0041 } });
  addLookCost(s, 'google/gemini-3.1-flash-lite', { cost: 0.00002, is_byok: true, cost_details: { upstream_inference_cost: 0.00003 } });
  assert.ok(Math.abs(s.videoCostUSD - 0.00415) < 1e-12, String(s.videoCostUSD));
  gw.flushGoogleSpend();
  assert.ok(Math.abs(gw.readGoogleDays()[gw.centralDateKey()] - 0.00413) < 1e-12);
});

test('a normal look is unchanged, and never lands in the Google ledger', () => {
  const s = {};
  addLookCost(s, 'google/gemini-3.1-pro-preview', { cost: 0.0038 });
  addLookCost(s, 'google/gemini-3.1-pro-preview', {});
  addLookCost(s, 'openai/gpt-vision', { cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.002 } });
  assert.ok(Math.abs(s.videoCostUSD - 0.0058) < 1e-12, String(s.videoCostUSD));
  const before = gw.readGoogleDays()[gw.centralDateKey()];
  gw.flushGoogleSpend();
  assert.equal(gw.readGoogleDays()[gw.centralDateKey()], before, 'only Google models feed the Google ledger');
});

test('THE REAL NON-BYOK SHAPE: a look costs X once and adds nothing to the Google ledger', () => {
  // OpenRouter restates cost as upstream_inference_cost on every normal reply
  // (296 of 296 saved replies; is_byok false). Adding it billed looks twice.
  const s = {};
  const real = { cost: 0.0125646, is_byok: false, cost_details: { upstream_inference_cost: 0.0125646 } };
  const before = gw.readGoogleDays()[gw.centralDateKey()];
  addLookCost(s, 'google/gemini-3.1-pro-preview', real);
  addLookCost(s, 'google/gemini-3.1-flash-lite', { cost: 0.0001, is_byok: false, cost_details: { upstream_inference_cost: 0.0001 } });
  assert.ok(Math.abs(s.videoCostUSD - 0.0126646) < 1e-12, String(s.videoCostUSD));
  gw.flushGoogleSpend();
  assert.equal(gw.readGoogleDays()[gw.centralDateKey()], before, 'OpenRouter paid Google, so it is not Google spend');
});
