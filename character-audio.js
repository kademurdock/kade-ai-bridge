'use strict';

const MOMENTS = new Set(['laugh', 'chuckle', 'giggle', 'cackle', 'gasp', 'scoff', 'sigh', 'cry', 'sob']);
const DIRECTIONS = [
  ['concerned', /\b(?:sad|sadness|worried|concerned|sorrowful)\b/],
  ['serious', /\b(?:serious|solemn|firm)\b/],
  ['skeptical', /\b(?:skeptical|sceptical|doubtful|unconvinced)\b/],
  ['surprised', /\b(?:surprised|astonished|startled|shocked)\b/],
  ['amused', /\b(?:amused|playful|delighted|grinning|excited)\b/],
  ['warm', /\b(?:warm|fond|friendly|tender)\b/],
];

// Only leading tags on this exact synthesis input have a known clip boundary.
// Interior text offsets are not audio timestamps. Never send the input itself.
function leadingCues(input) {
  if (typeof input !== 'string') return [];
  const prefix = input.slice(0, 1400);
  const pattern = /\s*%%%([^%\r\n]{1,160})%%%/gy;
  const cues = [];
  let match;
  while (cues.length < 8 && (match = pattern.exec(prefix))) {
    const tag = match[1].toLowerCase().trim().replace(/\s+/g, ' ');
    const canonical = tag === 'reset' || MOMENTS.has(tag) ? tag
      : /\b(?:not|never|without|no)\b/.test(tag) ? 'reset'
      : DIRECTIONS.find(([, rule]) => rule.test(tag))?.[0] || 'reset';
    cues.push({ at: 0, tag: canonical });
  }
  return cues;
}

// Immediately precedes one WAV frame. No captions, persona, or guessed mid-clip timing.
function characterAudio(agentId, speech, synthInput) {
  return { type: 'character-audio', version: 1,
    agentId: typeof agentId === 'string' && agentId.length > 0 && agentId.length <= 128 ? agentId : null,
    speech: speech === true,
    ...(synthInput === undefined ? {} : { cues: speech === true ? leadingCues(synthInput) : [] }) };
}

module.exports = { characterAudio, leadingCues };
