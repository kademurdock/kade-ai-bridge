'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

function fixture(t, response, notification = { ok: true, sent: 1 }, jobOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-completion-'));
  const file = path.join(dir, 'scenema-jobs.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'test-job', userId: 'owner', agentId: 'soundbooth',
    state: 'running', runpodId: 'provider-job', createdAt: new Date(Date.now() - 300000).toISOString(), ...jobOverrides }]));
  const pushes = [], assets = [];
  const mod = { exports: {} };
  const provider = { create: () => ({ get: async () => ({ data: await response() }) }),
    post: async (url, body) => { if (url.endsWith('/api/kade/asset-event')) assets.push(body); return { data: {} }; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'scenema.js'), 'utf8'), {
    module: mod, require: name => name === 'axios' ? provider : require(name), console,
    process: { env: { SCENEMA_ENABLED: '0', RAILWAY_VOLUME_MOUNT_PATH: dir, KADE_USAGE_EVENT_SECRET: 'synthetic-only' } },
    Buffer, URL, setTimeout, clearTimeout,
  });
  mod.exports.attachScenema(express(), { runNotify: async payload => { pushes.push(payload); return notification; } });
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return { pump: mod.exports._internals.pump, read: () => JSON.parse(fs.readFileSync(file))[0], pushes, assets };
}

test('worker errors end the job and request one targeted, routed failure notification', async t => {
  const f = fixture(t, () => ({ status: 'COMPLETED', output: { error: 'Missing worker dependency' } }));
  await f.pump(); await f.pump();
  assert.equal(f.read().state, 'failed');
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0].userId, 'owner');
  assert.equal(f.pushes[0].requested, true);
  assert.equal(f.pushes[0].route, 'sound-booth');
  assert.equal(f.pushes[0].broadcast, undefined);
  assert.equal(f.read().notification.accepted, 1);
});

test('provider success produces one completion notification and persistent result', async t => {
  const f = fixture(t, () => ({ status: 'COMPLETED', output: { url: 'https://example.invalid/audio', duration_s: 12 } }));
  await f.pump(); await f.pump();
  assert.equal(f.read().state, 'done');
  assert.equal(f.pushes.length, 1);
  assert.match(f.pushes[0].title, /ready/);
  assert.equal(f.pushes[0].requested, true);
});

test('real completion path preserves provider diagnostics without inventing legacy values', async t => {
  const f = fixture(t, () => ({status:'COMPLETED',output:{url:'https://example.invalid/audio',duration_s:12,
    voice_sample:true,has_reference_voice:false,quality:'base-bf16-32',parts:1}}));
  await f.pump();
  const result=f.read().result;
  assert.equal(result.voiceSample,true);
  assert.equal(result.hasReferenceVoice,false);
  assert.equal(result.parts,1);
  assert.equal(result.quality,'base-bf16-32');
  assert.equal(result.diagnosticSample,undefined);
  const legacy=fixture(t, () => ({status:'COMPLETED',output:{url:'https://example.invalid/audio',duration_s:12}}));
  await legacy.pump();
  assert.equal(legacy.read().result.voiceSample,undefined);
  assert.equal(legacy.read().result.hasReferenceVoice,undefined);
});

test('actual completion keeps a verified private sample on its owner job and never mirrors it to the gallery', async t => {
  const owner='1234567890abcdef12345678';
  const output={url:'https://example.invalid/auk/clip.mp3',wav_key:'auk/clip.wav',wav_url:'https://example.invalid/auk/clip.wav',duration_s:12,
    voice_sample:true,has_reference_voice:false,diagnostic_sample:{owner_id:owner,key:'auk/clip.conditioning.wav',
      url:'https://example.invalid/auk/clip.conditioning.wav',duration_s:5,sha256:'a'.repeat(64),kind:'bootstrap_reference'}};
  const f=fixture(t,()=>({status:'COMPLETED',output}),undefined,{userId:owner});
  await f.pump();
  assert.equal(f.read().result.diagnosticSample.key,'auk/clip.conditioning.wav');
  assert.equal(f.assets.length,1);
  assert.equal(f.assets[0].url,output.url);
  assert.equal(f.assets[0].metadata.voiceSample,true);
  assert.equal(f.assets[0].metadata.hasReferenceVoice,false);
  assert.equal(f.assets[0].metadata.diagnosticSample,undefined);
  assert.equal(JSON.stringify(f.assets).includes('conditioning.wav'),false);
  const foreign=fixture(t,()=>({status:'COMPLETED',output}),undefined,{userId:'abcdef1234567890abcdef12'});
  await foreign.pump();
  assert.equal(foreign.read().result.diagnosticSample,undefined);
});

test('AuK progress is saved while working and timeouts explain recovery', async t => {
  let response = { status: 'IN_PROGRESS', output: 'AuK HQ: part 2 of 3' };
  const f = fixture(t, () => response);
  await f.pump();
  assert.equal(f.read().progress, 'AuK HQ: part 2 of 3');
  assert.equal(f.read().state, 'running');
  assert.equal(f.pushes.length, 0);
  response = { status: 'TIMED_OUT', executionTime: 12000 };
  await f.pump();
  assert.equal(f.read().state, 'failed');
  assert.match(f.read().error, /finished sections are kept.*resume/);
  assert.equal(f.pushes.length, 1);
});

test('repeated missing provider records terminate waiting, transient misses do not', async t => {
  let missing = true;
  const f = fixture(t, () => {
    if (missing) throw Object.assign(Error('Not found'), { response: { status: 404 } });
    return { status: 'IN_PROGRESS' };
  });
  await f.pump(); await f.pump();
  assert.equal(f.read().state, 'running');
  missing = false; await f.pump(); missing = true;
  await f.pump(); await f.pump();
  assert.equal(f.read().state, 'running');
  await f.pump(); await f.pump();
  assert.equal(f.read().state, 'failed');
  assert.match(f.read().error, /no longer has this job record/);
  assert.equal(f.pushes.length, 1);
});

test('blocked and deferred notifications are recorded without claiming delivery', async t => {
  for (const result of [{ ok: false, blocked: 'muted' }, { ok: true, sent: 0, deferred: true }]) {
    const f = fixture(t, () => ({ status: 'FAILED', error: 'Worker stopped' }), result);
    await f.pump();
    assert.equal(f.read().state, 'failed');
    assert.equal(f.read().notification.accepted, 0);
    assert.equal(f.read().notification.deferred, !!result.deferred);
    if (result.blocked) assert.equal(f.read().notification.blocked, 'muted');
  }
});
