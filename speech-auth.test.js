'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { speechHeaders } = require('./speech-auth');

test('the secret rides x-proxy-secret and the lane names the caller', () => {
  assert.deepEqual(speechHeaders('bridge-phone', { KADE_SPEECH_SECRET: ' abc-0123456789-secret ' }), {
    'x-kade-caller': 'bridge-phone',
    'x-proxy-secret': 'abc-0123456789-secret',
  });
});

test('during a rotation (two comma-separated values) the first one is sent', () => {
  assert.equal(speechHeaders('x', { KADE_SPEECH_SECRET: 'new-0123456789,old-0123456789' })['x-proxy-secret'], 'new-0123456789');
});

test('with no secret set the header is left out instead of sent empty', () => {
  assert.deepEqual(speechHeaders('bridge-probe', {}), { 'x-kade-caller': 'bridge-probe' });
});
