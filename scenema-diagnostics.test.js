'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { audioDiagnostics, privateSample } = require('./scenema-diagnostics');
const owner = '1234567890abcdef12345678';
const sample = {owner_id:owner,key:'auk/example.conditioning.wav',url:'https://example.invalid/bucket/auk/example.conditioning.wav?signature=synthetic',
  duration_s:5.1,sha256:'a'.repeat(64),kind:'bootstrap_reference'};
const output = {wav_key:'auk/example.wav',wav_url:'https://example.invalid/bucket/auk/example.wav',diagnostic_sample:sample};

test('missing fields stay unknown and explicit false remains distinct from bootstrap conditioning', () => {
  assert.deepEqual(audioDiagnostics({}), {});
  assert.deepEqual(audioDiagnostics({voice_sample:true,has_reference_voice:false,parts:1,quality:'base-bf16-32'}),
    {voiceSample:true,hasReferenceVoice:false,parts:1,quality:'base-bf16-32'});
  assert.deepEqual(audioDiagnostics({voice_sample:'true',has_reference_voice:1,parts:-1,quality:'https://private.invalid'}), {});
  assert.deepEqual(audioDiagnostics({prompt:'private',model_key:'private',diagnostic_sample:sample}), {});
});

test('a diagnostic clip needs the exact owner, sibling key, expected kind and bounded audio/hash', () => {
  assert.equal(privateSample(output,owner).key,sample.key);
  assert.equal(privateSample(output,'abcdef1234567890abcdef12'),null);
  for (const change of [{owner_id:'someone'}, {key:'other/take.wav'}, {kind:'imported_reference'},
    {sha256:'bad'}, {duration_s:0}, {duration_s:9}, {duration_s:NaN}, {duration_s:'5'}]) {
    assert.equal(privateSample({...output,diagnostic_sample:{...sample,...change}},owner),null);
  }
});

test('diagnostic URLs cannot introduce another host, credentials or unsafe schemes', () => {
  for (const url of ['https://foreign.invalid/clip.wav','https://user:password@example.invalid/clip.wav',
    'https://example.invalid/another-owner/clip.wav',
    'http://example.invalid/clip.wav','file:///private.wav','bad']) {
    assert.equal(privateSample({...output,diagnostic_sample:{...sample,url}},owner),null);
  }
  assert.equal(privateSample({...output,wav_url:'bad'},owner),null);
  assert.equal(privateSample({},owner),null);
});
