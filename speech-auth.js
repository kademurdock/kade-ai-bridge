'use strict';
/**
 * speech-auth.js — the bridge's pass for the voice proxy (Oct 16 2026).
 *
 * inworld-tts-proxy's /v1/audio/speech used to answer anyone with its URL, so
 * a stranger could spend Kade's Fish and Inworld credit. It now wants
 * KADE_SPEECH_SECRET (the same Railway variable on the proxy, the fork and
 * here) in the x-proxy-secret header. `lane` names the caller in the proxy's
 * ten-minute summary so a rollout can see every lane sending it; it proves
 * nothing by itself. With the variable unset the headers simply leave the
 * secret out, and the proxy logs or refuses the call depending on its mode.
 */
function speechHeaders(lane, env = process.env) {
  const secret = String(env.KADE_SPEECH_SECRET || '').split(',')[0].trim();
  const headers = { 'x-kade-caller': String(lane || 'bridge') };
  if (secret) headers['x-proxy-secret'] = secret;
  return headers;
}

module.exports = { speechHeaders };
