'use strict';

function audioDiagnostics(output) {
  const result = {};
  if (typeof output.voice_sample === 'boolean') result.voiceSample = output.voice_sample;
  if (typeof output.has_reference_voice === 'boolean') result.hasReferenceVoice = output.has_reference_voice;
  if (Number.isInteger(output.parts) && output.parts > 0 && output.parts <= 360) result.parts = output.parts;
  if (typeof output.quality === 'string' && /^[a-z0-9-]{1,60}$/i.test(output.quality)) result.quality = output.quality;
  return result;
}

// A private bootstrap clip never becomes a gallery asset. It can be retained
// only with its exact authenticated owner's take, on the same private host/key.
function privateSample(output, userId) {
  const sample = output.diagnostic_sample;
  if (!sample || sample.owner_id !== userId || !/^[a-f0-9]{24}$/.test(userId) ||
      sample.kind !== 'bootstrap_reference' || typeof output.wav_key !== 'string' ||
      !output.wav_key.endsWith('.wav') || sample.key !== output.wav_key.slice(0, -4) + '.conditioning.wav' ||
      typeof sample.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sample.sha256) ||
      typeof sample.duration_s !== 'number' || !Number.isFinite(sample.duration_s) ||
      sample.duration_s <= 0 || sample.duration_s > 8.05) return null;
  try {
    const link = new URL(sample.url), master = new URL(output.wav_url);
    if (link.protocol !== 'https:' || link.username || link.password ||
        master.protocol !== 'https:' || link.host !== master.host ||
        !decodeURIComponent(link.pathname).endsWith('/' + sample.key)) return null;
    return { key: sample.key, url: link.href, durationS: sample.duration_s,
      sha256: sample.sha256, kind: sample.kind };
  } catch {
    return null;
  }
}

module.exports = { audioDiagnostics, privateSample };
