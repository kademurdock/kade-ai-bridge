'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('./llm');

const env = { MOONSHOT_KEY: 'mk', OPENROUTER_KEY: 'ok' };
const messages = [{ role: 'user', content: 'hi' }];

test('the default model is off Moonshot and rides zero-retention fast hosts', () => {
  assert.equal(llm.DEFAULT_MODEL, 'deepseek/deepseek-v4.1-flash');
  const call = llm.request(llm.DEFAULT_MODEL, messages, { maxTokens: 900, json: true, effort: 'none' }, env);
  assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(call.headers.Authorization, 'Bearer ok');
  assert.deepEqual(call.body.reasoning, { enabled: false });
  assert.equal(call.body.reasoning_effort, undefined, 'a Moonshot-only field never reaches OpenRouter');
  assert.equal(call.body.response_format, undefined);
  assert.equal(call.body.provider.zdr, true);
  assert.equal(call.body.provider.data_collection, 'deny');
  assert.deepEqual(call.body.provider.order, ['together', 'parasail', 'modal', 'makora']);
  assert.equal(call.body.temperature, undefined);
  assert.deepEqual(llm.request(llm.DEFAULT_MODEL, messages, { maxTokens: 5, effort: 'low' }, env).body.reasoning, { enabled: true, effort: 'low', exclude: true });
  const priced = llm.request(llm.DEFAULT_MODEL, messages, { maxTokens: 5 }, { ...env, KADE_DEEPSEEK_ORDER: '' });
  assert.equal(priced.body.provider.sort, 'price'); assert.equal(priced.body.provider.order, undefined); assert.equal(priced.body.provider.zdr, true);
});

test('a kimi model named in an env var still goes to Moonshot with its two load-bearing facts', () => {
  const call = llm.request('kimi-k3', messages, { maxTokens: 1200, json: true, effort: 'none' }, env);
  assert.equal(call.url, 'https://api.moonshot.ai/v1/chat/completions');
  assert.equal(call.headers.Authorization, 'Bearer mk');
  assert.equal(call.body.reasoning_effort, 'none');
  assert.equal(call.body.temperature, undefined);
  assert.deepEqual(call.body.response_format, { type: 'json_object' });
  assert.equal(call.body.provider, undefined);
});

test('a desk is disabled by the key its models actually need', () => {
  assert.equal(llm.missingKey([llm.DEFAULT_MODEL], { MOONSHOT_KEY: 'mk' }), 'OPENROUTER_KEY is not set on the bridge');
  assert.equal(llm.missingKey([llm.DEFAULT_MODEL], { OPENROUTER_API_KEY: 'x' }), '');
  assert.equal(llm.missingKey([llm.DEFAULT_MODEL, 'kimi-k2.6'], { OPENROUTER_KEY: 'x' }), 'MOONSHOT_KEY is not set on the bridge');
  assert.ok(llm.PRICES[llm.DEFAULT_MODEL].out > 0);
});
