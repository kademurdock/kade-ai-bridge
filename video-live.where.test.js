/* video-live.where.test.js — Oct 20 2026.
 *
 * Kade: Spotters "seem to be having a lot of problems telling left and right,
 * helping find things". The WHERE THINGS ARE rules ride every Spotter (Scout,
 * long custom briefings and the short family ones alike) and outrank the
 * persona; LIVE_WHERE_RULES=0 restores the old one-liner.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

function freshModule(env) {
  const file = path.join(__dirname, 'video-live.js');
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; }
  delete require.cache[require.resolve(file)];
  const mod = require(file);
  for (const k of Object.keys(saved)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
  return mod;
}

function promptFor(mod, spotter) {
  const session = { callerName: 'Sam', agentName: 'Kiana', userId: 't' };
  if (spotter) session.spotter = spotter;
  return mod._test.buildSetupMessage(session).setup.systemInstruction.parts[0].text;
}

test('short family Spotters get the full direction rules, not one line', () => {
  const text = promptFor(freshModule({ LIVE_WHERE_RULES: null }), { name: 'Juno', persona: 'Laid-back and funny.' });
  assert.match(text, /WHERE THINGS ARE/);
  assert.match(text, /NOT a mirror; never flip it/);
  assert.match(text, /RIGHT side of the picture is THEIR LEFT/, 'a person facing the camera is the one exception');
  assert.match(text, /upside down/);
  assert.match(text, /FINDING SOMETHING/);
  assert.doesNotMatch(text, /never the camera's mirror/, 'the old line told the model there was a mirror to undo');
});

test('Scout and long briefings get the same rules after the persona', () => {
  const text = promptFor(freshModule({ LIVE_WHERE_RULES: null }), null);
  assert.ok(text.indexOf('WHERE THINGS ARE') > text.indexOf('You are Scout'), 'rules ride after the persona and outrank it');
  assert.doesNotMatch(text, /the hand you're holding the phone with/);
});

test('hand guidance only from a hand the model can see', () => {
  const text = promptFor(freshModule({ LIVE_WHERE_RULES: null }), { name: 'Juno', persona: 'x' });
  assert.match(text, /Only say where their hand is when you can see their hand in the picture/);
});

test('LIVE_WHERE_RULES=0 restores the old one-line rule', () => {
  const text = promptFor(freshModule({ LIVE_WHERE_RULES: '0' }), { name: 'Juno', persona: 'x' });
  assert.match(text, /never the camera's mirror/);
  assert.doesNotMatch(text, /WHERE THINGS ARE/);
  freshModule({ LIVE_WHERE_RULES: null });
});
