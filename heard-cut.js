'use strict';
/* heard-cut.js — Nov 11 2026. KEEP ONLY WHAT WAS HEARD WHEN SOMEONE BARGES IN.
 *
 * Before this, a caller who talked over a character (phone line or app/web voice) cut the audio
 * off, but the WHOLE planned reply still went into the call's history, its memory and the Call
 * History transcript, as if every word had been said. The character then "remembered" telling
 * the person things they never heard, and would not repeat them.
 *
 * Now an interrupted turn stores only the pieces that actually started playing:
 *   - a piece that played to the end is kept whole;
 *   - the piece that was playing when the audio stopped is trimmed to the words heard, then
 *     "(cut off here; they did not hear the rest)" so the model knows it was interrupted and
 *     where; pieces that never started are dropped;
 *   - when nothing at all had started, the turn is stored as CUT_NONE alone.
 *
 * How far the cut piece got, best evidence first:
 *   1. its word timings (the `kdtm` chunk the voice proxy puts in a web call's WAV when a face is
 *      shown): the words whose end time is before the stop are the words heard;
 *   2. otherwise the share of its audio that played, applied to its spoken characters and snapped
 *      back to the last whole word;
 *   3. otherwise (no position at all) the started piece is kept whole.
 * The position comes from Twilio mark events on the phone line and from the app/web client's
 * {type:'heard', seq, ms} report on /ws/web-voice; voice-stream.js works those out. This file is
 * pure text and arithmetic, so the rules are tested on their own (heard-cut.test.js).
 *
 * BRIDGE_HEARD_ONLY=0 puts the old behaviour back (the whole reply is stored). Read per turn.
 */

const CUT_MARK = '(cut off here; they did not hear the rest)';
const CUT_NONE = '(cut off before I said anything; they heard none of this reply)';
// Any "(cut off ...)" the model writes back in its own reply is stripped before it is spoken.
const CUT_MARK_RE = /\(\s*cut off\b[^()\n]{0,100}\)/gi;
const WHOLE_SLACK_MS = 120; // this close to the end of a piece counts as heard whole
const WORD_SLACK_MS = 60;   // a word that ended this soon after the stop still counts as heard

function heardOnlyOn(env = process.env) {
  return String(env.BRIDGE_HEARD_ONLY || '').trim() !== '0';
}

function hasCutMark(text) {
  CUT_MARK_RE.lastIndex = 0;
  const hit = CUT_MARK_RE.test(String(text || ''));
  CUT_MARK_RE.lastIndex = 0;
  return hit;
}

function stripCutMarks(text) {
  const s = String(text || '');
  if (!hasCutMark(s)) return s;
  return s.replace(CUT_MARK_RE, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

// Bracketed stage tokens that are never spoken. A bracketed sound such as [laugh] or [sigh] IS
// voiced (Inworld times it as its own word), so it counts as a word.
const STAGE_TOKEN_RE = /^\[(?:sound:|table:|watch\b|press\b|end call\]|say nothing\]|deep think|instant\b)/i;
const VOICED_TAG_RE = /^\[[a-z][a-z \-']{0,24}\]$/i;

/* The spoken words of one piece of reply text, each with its character range in that text.
 * %%%direction%%% tags and stage tokens are skipped; everything between them is split on
 * whitespace. */
function spokenWords(raw) {
  const s = String(raw || '');
  const words = [];
  const tagRe = /%%%[\s\S]*?%%%|\[[^\]\n]{0,200}\]/g;
  let pos = 0;
  const textWords = (from, to) => {
    const re = /\S+/g;
    const chunk = s.slice(from, to);
    let m;
    while ((m = re.exec(chunk)) !== null) words.push({ start: from + m.index, end: from + m.index + m[0].length, text: m[0] });
  };
  let t;
  while ((t = tagRe.exec(s)) !== null) {
    textWords(pos, t.index);
    const tag = t[0];
    if (tag[0] === '[' && !STAGE_TOKEN_RE.test(tag) && VOICED_TAG_RE.test(tag)) {
      words.push({ start: t.index, end: t.index + tag.length, text: tag });
    }
    pos = t.index + tag.length;
  }
  textWords(pos, s.length);
  return words;
}

/* The first n spoken words of a piece, with any tags that came before or between them. */
function cutAtWords(raw, n) {
  const s = String(raw || '');
  if (!(n > 0)) return '';
  const words = spokenWords(s);
  if (n >= words.length) return s.trim();
  return s.slice(0, words[n - 1].end).trim();
}

/* How many whole words fit in the first `fraction` of the spoken text (by characters). */
function wordsByShare(words, fraction) {
  if (!words.length) return 0;
  if (!(fraction > 0)) return 0;
  if (fraction >= 1) return words.length;
  let end = 0;
  const ends = words.map((w, i) => (end = end + (i ? 1 : 0) + (w.end - w.start)));
  const reach = fraction * end + 0.5;
  let n = 0;
  while (n < ends.length && ends[n] <= reach) n++;
  return n;
}

/* Words of a piece heard after `heardMs` of its audio.
 * unit: { raw, durMs?, timedWords? } where timedWords is the kdtm `w` list: [[startMs, endMs, text]].
 * heardMs: null/undefined = unknown (keep whole). */
function heardWordCount(unit, heardMs) {
  const words = spokenWords(unit && unit.raw);
  const total = words.length;
  if (heardMs === null || heardMs === undefined || !Number.isFinite(heardMs)) return total;
  const dur = Number(unit.durMs) || 0;
  if (dur > 0 && heardMs >= dur - WHOLE_SLACK_MS) return total;
  if (heardMs <= 0) return 0;
  const tw = Array.isArray(unit.timedWords) ? unit.timedWords.filter((w) => Array.isArray(w) && Number.isFinite(w[1])) : [];
  if (tw.length) {
    const k = tw.filter((w) => w[1] <= heardMs + WORD_SLACK_MS).length;
    if (k >= tw.length) return total;
    if (tw.length === total) return k;
    return Math.floor((k * total) / tw.length); // pronunciation fixes can change the count: scale
  }
  if (dur > 0) return wordsByShare(words, heardMs / dur);
  return total;
}

/* Builds the stored text of an interrupted turn.
 *   units: the pieces that were handed to playback, in order, each with
 *          { raw, heard } where heard is 'whole' | 'none' | { ms } (plus durMs / timedWords);
 *   lostText: true when the reply had more text that never became a piece (the model was still
 *          writing, or a piece was dropped by the abort).
 * Returns { text, cut } — cut false means everything was heard and `text` is just the pieces. */
function buildHeardText(units, { lostText = false } = {}) {
  const pieces = [];
  let cut = !!lostText;
  for (const u of units || []) {
    const h = u && u.heard;
    if (!h || h === 'none') { cut = true; break; }
    if (h === 'whole') { if (u.raw && String(u.raw).trim()) pieces.push(String(u.raw).trim()); continue; }
    const total = spokenWords(u.raw).length;
    const n = heardWordCount(u, h.ms);
    const kept = cutAtWords(u.raw, n);
    if (kept) pieces.push(kept);
    if (n < total) { cut = true; break; }
  }
  const said = pieces.join(' ').replace(/\[END CALL\]/gi, '').replace(/[ \t]{2,}/g, ' ').trim();
  if (!cut) return { text: said, cut: false };
  // Nothing heard: the marker alone. A cut mid-word or between pieces: the heard words, then the marker.
  if (!spokenWords(said).length) return { text: CUT_NONE, cut: true };
  return { text: `${said} ${CUT_MARK}`, cut: true };
}

/* Where each piece got to, on the PHONE line.
 *   units: { sendAt, durMs, markAt, cueAt } — sendAt is when its first frame went to Twilio,
 *          markAt when Twilio said the mark after its last frame had played.
 *   stopAt: when the audio was cleared.
 * Twilio plays as it receives, so a piece starts when it was sent or when the piece before it
 * finished playing (that piece's mark), whichever is later. Marks that arrive after the clear
 * are Twilio returning unplayed marks, not playback, so they are ignored. */
function placePhone(units, stopAt) {
  let prevMark = 0;
  for (const u of units) {
    if (!u.sendAt) { u.heard = u.cueAt && u.cueAt < stopAt && !u.hasSpeech ? 'whole' : 'none'; continue; }
    if (u.markAt && u.markAt <= stopAt) { u.heard = 'whole'; prevMark = u.markAt; continue; }
    const startAt = Math.max(u.sendAt, prevMark || 0);
    u.heard = startAt >= stopAt ? 'none' : { ms: stopAt - startAt };
    prevMark = 0;
  }
  return units;
}

/* Where each piece got to, on APP/WEB voice.
 *   units: { seq, startEst, durMs, cueAt } — seq is the piece's clip number on this socket (the
 *          bridge counts every WAV it sends; the client counts every WAV it receives), startEst
 *          the bridge's own guess of when the client started playing it.
 *   report: the client's latest { seq, ms, at } heard report, or null.
 *   stopAt: when the bridge cleared the client.
 * A report sent after the stop wins: clips numbered below it played whole, the clip it names
 * played `ms`, clips after it never started. Without one, the bridge's own playhead guess. */
function placeWeb(units, report, stopAt) {
  const fresh = report && Number.isFinite(report.at) && report.at >= stopAt && Number.isInteger(report.seq) ? report : null;
  for (const u of units) {
    if (!u.seq) { u.heard = u.cueAt && u.cueAt < stopAt && !u.hasSpeech ? 'whole' : 'none'; continue; }
    if (fresh) {
      if (u.seq < fresh.seq) u.heard = 'whole';
      else if (u.seq > fresh.seq) u.heard = 'none';
      else u.heard = { ms: Math.max(0, Number(fresh.ms) || 0) };
      continue;
    }
    const startAt = Number(u.startEst) || 0;
    u.heard = !startAt || startAt >= stopAt ? 'none' : { ms: stopAt - startAt };
  }
  return units;
}

/* The `w` (word timings) list of a WAV's kdtm chunk, or null. Walks the RIFF chunks; never throws. */
function kdtmWords(buf) {
  try {
    if (!buf || buf.length < 20 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'data') return null;
      if (id === 'kdtm') {
        if (off + 8 + size > buf.length || size > 600 * 1024) return null;
        const track = JSON.parse(buf.toString('utf8', off + 8, off + 8 + size));
        return track && track.v === 1 && Array.isArray(track.w) ? track.w : null;
      }
      off += 8 + size + (size % 2);
    }
  } catch { /* a bad track is no track */ }
  return null;
}

module.exports = {
  CUT_MARK, CUT_NONE, heardOnlyOn, hasCutMark, stripCutMarks,
  spokenWords, cutAtWords, wordsByShare, heardWordCount, buildHeardText,
  placePhone, placeWeb, kdtmWords,
};
