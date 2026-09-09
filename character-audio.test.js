const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { characterAudio, leadingCues } = require('./character-audio');

test('only leading synthesis directions get clip-start cues; text and interior tags stay private', () => {
  assert.deepEqual(leadingCues(' %%%warm and fond%%% %%%chuckle%%% Hello secret-name. %%%sad%%%'),
    [{ at: 0, tag: 'warm' }, { at: 0, tag: 'chuckle' }]);
  assert.deepEqual(leadingCues('Hello %%%warm%%%'), []);
  assert.deepEqual(leadingCues('%%%not warm%%% Words'), [{ at: 0, tag: 'reset' }]);
  assert.deepEqual(leadingCues('%%%speak gently about private-name%%%'), [{ at: 0, tag: 'reset' }]);
  assert.deepEqual(leadingCues({}), []);
  assert.equal(leadingCues('%%%warm%%%'.repeat(20)).length, 8);
  assert.deepEqual(characterAudio('kiana', false, '%%%laugh%%%').cues, []);
});

test('the shared WAV dispatcher carries the exact clip input without changing audio', async () => {
  const source = fs.readFileSync(require.resolve('./voice-stream'), 'utf8');
  const begin = source.indexOf('async function playBufferWav(');
  const end = source.indexOf('// ── Thinking-gap', begin);
  const sent = [];
  const sandbox = { characterAudio, WebSocket: { OPEN: 1 }, Date, JSON, Math,
    setTimeout: () => 1, clearTimeout() {}, wavDurationMs: () => 100 };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(begin, end) + '\nglobalThis.play=playBuffer;', sandbox);
  const bytes = Buffer.from('same waveform');
  const session = { agentId: 'kiana', media: 'wav', llmAbort: true,
    _currentSpokenText: '%%%sad%%% stale caption', ws: { readyState: 1, send(data) { sent.push(data); } } };
  await sandbox.play(session, bytes, { synthInput: '%%%warm%%% current synthesized clip' });
  assert.deepEqual(JSON.parse(sent[0]).cues, [{ at: 0, tag: 'warm' }]);
  assert.strictEqual(sent[1], bytes);
});

test('minimal metadata names the speaker and marks effects without carrying text', () => {
  assert.deepEqual(characterAudio('agent_kiana', true), { type:'character-audio',version:1,agentId:'agent_kiana',speech:true });
  assert.equal(characterAudio('agent_kiana', false).speech, false);
  assert.equal(characterAudio({}, true).agentId, null);
});

test('actual WAV sender preserves bytes and continues if presentation send fails', async () => {
  const source=fs.readFileSync(require.resolve('./voice-stream'), 'utf8');
  const begin=source.indexOf('async function playBufferWav(');
  const end=source.indexOf('// ── Play',begin);
  for (const failMetadata of [false,true]) {
    const sent=[];
    const sandbox={characterAudio,WebSocket:{OPEN:1},Date,JSON,Math,setTimeout:()=>1,clearTimeout(){},wavDurationMs:()=>100};
    vm.createContext(sandbox);
    vm.runInContext(source.slice(begin,end)+'\nglobalThis.play=playBufferWav;',sandbox);
    const bytes=Buffer.from('unchanged audio');
    const session={agentId:'agent_kiana',llmAbort:true,ws:{readyState:1,send(data){if(typeof data==='string'&&failMetadata)throw Error('visual failure');sent.push(data);}}};
    await sandbox.play(session,bytes,{noCaption:true});
    assert.strictEqual(sent.at(-1),bytes);
    if(!failMetadata)assert.equal(JSON.parse(sent[0]).speech,false);
  }
});
