const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { characterAudio } = require('./character-audio');

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
