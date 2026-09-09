'use strict';

// Immediately precedes one WAV frame. No captions, private persona, or inferred cue times.
function characterAudio(agentId, speech) {
  return { type: 'character-audio', version: 1,
    agentId: typeof agentId === 'string' && agentId.length > 0 && agentId.length <= 128 ? agentId : null,
    speech: speech === true };
}

module.exports = { characterAudio };
