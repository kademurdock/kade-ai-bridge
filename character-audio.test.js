const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { cueForSpeech, speechMetadata, sendCharacterMetadata } = require('./character-audio');
const fixtures = require('./character-cues.json');

for (const row of fixtures) test('authored expression: ' + row.input.slice(0, 70), () => {
  assert.deepEqual(cueForSpeech(row.input), { expression: row.expression, moment: row.moment });
});
test('packet contains only bounded presentation data, never the transcript', () => {
  const data = speechMetadata('agent_kiana', '%%%warm%%% A private conversation.');
  assert.deepEqual(data, { speakerId: 'agent_kiana', speech: true, expression: 'warm', moment: null });
  assert.equal(speechMetadata('x'.repeat(65), 'hello'), null);
});

function sender(failMetadata = false) {
  const source = fs.readFileSync(require.resolve('./voice-stream'), 'utf8');
  const start = source.indexOf('async function playBufferWav(');
  const end = source.indexOf('// ── Play μ-law', start);
  const frames = [];
  const session = { ws: { readyState: 1, send(value, options) {
    if (typeof value === 'string' && failMetadata) throw new Error('presentation failure');
    frames.push({ value, options });
  } }, sendState(value) { frames.push({ state: value }); }, sendCaption() {}, llmAbort: false };
  const ctx = { WebSocket: { OPEN: 1 }, Date, Math, WEB_LEAD_MS: 600, wavDurationMs: () => 20,
    sendCharacterMetadata, setTimeout: () => 1, clearTimeout() {} };
  vm.createContext(ctx); vm.runInContext(source.slice(start, end) + '\nthis.play = playBufferWav;', ctx);
  return { frames, session, play: ctx.play };
}
test('actual WAV sender emits metadata immediately before the unchanged binary', async () => {
  const { frames, session, play } = sender();
  const wav = Buffer.alloc(960); const characterMetadata = speechMetadata('agent_della', '%%%concerned%%% Hello.');
  await play(session, wav, { characterMetadata });
  const metadata = JSON.parse(frames.at(-2).value);
  assert.equal(metadata.type, 'character-audio'); assert.equal(metadata.speakerId, 'agent_della');
  assert.equal(metadata.expression, 'concerned'); assert.equal(frames.at(-1).value, wav);
  assert.equal(frames.at(-1).options.binary, true);
});
test('a game effect clears speech identity rather than repeating the previous face cue', async () => {
  const { frames, session, play } = sender();
  await play(session, Buffer.alloc(960), { noCaption: true });
  const metadata = JSON.parse(frames.at(-2).value);
  assert.equal(metadata.speech, false); assert.equal(metadata.speakerId, '');
});
test('failed metadata delivery cannot interrupt voice audio', async () => {
  const { frames, session, play } = sender(true); const wav = Buffer.alloc(960);
  await play(session, wav); assert.equal(frames.at(-1).value, wav);
});
