'use strict';

const moments = new Map([
  ['laugh', 'amused'], ['chuckle', 'amused'], ['giggle', 'amused'], ['cackle', 'amused'],
  ['scoff', 'skeptical'], ['gasp', 'surprised'], ['sigh', 'concerned'], ['cry', 'concerned'], ['sob', 'concerned'],
]);
const ignored = new Set(['breath', 'pant', 'huff', 'grunt', 'groan', 'moan', 'snort', 'wail', 'whimper', 'whine', 'sniffle', 'sniff', 'shriek', 'squeal', 'howl', 'clear throat', 'cough', 'sneeze', 'hiccup', 'yawn', 'burp', 'snore', 'choke', 'gag', 'swallow', 'gulp', 'spit', 'tongue click', 'mouth click', 'mouth sound', 'lip smack', 'kiss', 'shush', 'raspberry', 'whistle', 'bleh', 'chew', 'slurp', 'babble', 'beatbox', 'growl']);
const rules = [
  ['concerned', /\b(?:sad|sadness|worried|concerned|sorrowful)\b/],
  ['serious', /\b(?:serious|solemn|firm)\b/],
  ['skeptical', /\b(?:skeptical|sceptical|doubtful|unconvinced)\b/],
  ['surprised', /\b(?:surprised|astonished|startled|shocked)\b/],
  ['amused', /\b(?:amused|playful|delighted|grinning|excited)\b/],
  ['warm', /\b(?:warm|fond|friendly|tender)\b/],
];

// Only the authored opening direction has a known relationship to clip start.
// Interior tags are deliberately not assigned invented word timings.
function cueForSpeech(text) {
  let rest = typeof text === 'string' ? text.slice(0, 1024) : '';
  let expression = 'neutral', moment = null;
  for (let i = 0; i < 8; i++) {
    const match = rest.match(/^\s*%%%([^%\n]{1,160})%%%/);
    if (!match) break;
    const tag = match[1].toLowerCase().replace(/[^\p{L}]+/gu, ' ').trim();
    if (moments.has(tag)) moment = moments.get(tag);
    else if (!ignored.has(tag)) {
      expression = /\b(?:not|never|without|no)\b/.test(tag) ? 'neutral' : rules.find(([, re]) => re.test(tag))?.[0] || 'neutral';
      moment = null;
    }
    rest = rest.slice(match[0].length);
  }
  return { expression, moment };
}

function speechMetadata(speakerId, text) {
  if (typeof speakerId !== 'string' || !speakerId || speakerId.length > 64) return null;
  return { speakerId, speech: true, ...cueForSpeech(text) };
}

function sendCharacterMetadata(session, metadata) {
  const value = metadata || { speakerId: '', speech: false, expression: 'neutral', moment: null };
  try { session.ws.send(JSON.stringify({ type: 'character-audio', version: 1, ...value })); } catch { /* audio remains authoritative */ }
}

module.exports = { cueForSpeech, speechMetadata, sendCharacterMetadata };
