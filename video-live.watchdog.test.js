/* video-live.watchdog.test.js — Aug 28 2026, reworked Oct 20 2026.
 *
 * The live-silence watchdog, born from a real call: "Can you see how much is
 * left in this?" / "Are you there?" / "Hello?" — 31 seconds, zero words back,
 * because Google's Live endpoint completed setup and then generated nothing.
 * The brownout was Google's; the unexplained dead air was ours. The pure
 * verdict is exported so its fence posts can be held still and tested.
 *
 * Oct 20 2026: the count ran from connect, but neither Live model speaks
 * before the caller does, so a caller who waited (or asked a long first
 * question) heard the notice with nothing wrong. The count now starts at the
 * caller's first speech and runs from their last. The second half of this
 * file drives the real module with a fake Google socket and mocked clocks;
 * nothing here opens a network connection.
 */
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'vlive-watchdog-'));
delete process.env.KADE_USAGE_EVENT_SECRET; // flush must never reach the network here

class FakeGoogle extends EventEmitter {
  constructor(url) { super(); this.url = url; this.readyState = 1; this.sent = []; FakeGoogle.sockets.push(this); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.closedByUs = true; }
}
FakeGoogle.sockets = [];
const realLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'ws' ? FakeGoogle : realLoad.call(this, request, ...rest); };
const vl = require('./video-live');
Module._load = realLoad;
const { shouldWarnLiveSilence, LIVE_SILENT_LINE } = vl;
const { liveSilenceDueAt, pcmRms, startLive } = vl._test;

// ── The pure verdict ─────────────────────────────────────────────────────────
const base = { liveOn: true, callerFirstAt: 1000, callerLastAt: 1000, wordsAt: 0, firstAudioAt: 0, warned: false, ms: 12000, maxMs: 20000 };

test('THE FALSE ALARM: a caller who has not said a word is never warned, however long they wait', () => {
  assert.ok(!shouldWarnLiveSilence({ ...base, callerFirstAt: 0, callerLastAt: 0, now: 10 * 60 * 1000 }));
});

test('HER CALL: the caller spoke, then twelve seconds with zero model audio -> warn', () => {
  assert.ok(shouldWarnLiveSilence({ ...base, now: 1000 + 12000 }));
});

test('before the deadline the model still has the floor', () => {
  assert.ok(!shouldWarnLiveSilence({ ...base, now: 1000 + 11999 }));
});

test('a long first question is timed from its end, not its start', () => {
  const longQ = { ...base, callerFirstAt: 1000, callerLastAt: 15000 };
  assert.ok(!shouldWarnLiveSilence({ ...longQ, now: 15000 + 11999 }));
  assert.ok(shouldWarnLiveSilence({ ...longQ, now: 15000 + 12000 }));
});

test('a caller who keeps asking "are you there?" still hears it, LIVE_SILENCE_MAX_MS after their first words', () => {
  const asking = { ...base, callerFirstAt: 4000, wordsAt: 5000, callerLastAt: 24000 };
  assert.ok(!shouldWarnLiveSilence({ ...asking, now: 5000 + 19999 }));
  assert.ok(shouldWarnLiveSilence({ ...asking, now: 5000 + 20000 }));
  assert.equal(liveSilenceDueAt(asking), 25000);
  assert.equal(liveSilenceDueAt({ ...asking, maxMs: 0 }), 36000, 'LIVE_SILENCE_MAX_MS=0 leaves only the last-speech count');
  assert.equal(liveSilenceDueAt({ ...asking, wordsAt: 0 }), 36000, 'voice alone (no words yet) has no cap: a long question is not cut off');
});

test('a healthy session that spoke is never warned about', () => {
  assert.ok(!shouldWarnLiveSilence({ ...base, firstAudioAt: 3000, now: 99999 }));
});

test('one warning per call, never nagging', () => {
  assert.ok(!shouldWarnLiveSilence({ ...base, warned: true, now: 99999 }));
});

test('a call that already ended stays quiet', () => {
  assert.ok(!shouldWarnLiveSilence({ ...base, liveOn: false, now: 99999 }));
});

test('LIVE_SILENCE_MS=0 disables it entirely', () => {
  assert.ok(!shouldWarnLiveSilence({ ...base, ms: 0, now: 99999 }));
});

test('the spoken line blames the right party and offers the way out', () => {
  assert.match(LIVE_SILENT_LINE, /not you/i, 'a blind caller must hear immediately that they did nothing wrong');
  assert.match(LIVE_SILENT_LINE, /call back|hang up|few seconds/i, 'it must offer an action, not just a diagnosis');
  assert.ok(!/error|fail|broke/i.test(LIVE_SILENT_LINE), 'no alarm words — this is a weather report, not a crash');
});

// ── The real module, a fake Google, mocked clocks ────────────────────────────
/** 100 ms of 16 kHz PCM16 at a steady level (RMS = amp). */
function pcm(amp, ms = 100) {
  const n = 16 * ms;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
  return b;
}
const LOUD = pcm(3000);  // speech at about -21 dBFS
const QUIET = pcm(60);   // a quiet room
test('the level meter reads a PCM16 chunk', () => {
  assert.equal(Math.round(pcmRms(LOUD)), 3000);
  assert.equal(pcmRms(Buffer.alloc(0)), 0);
});

function caller() {
  const out = { speaks: [], logs: [] };
  const session = {
    userId: 'u-test', lcEmail: 'caller@example.invalid', agentName: 'Kiana', voice: 'v', callerName: 'Amber',
    streamSid: 'web-test', history: [], ws: null,
    jsonSend() {}, sendClear() {},
  };
  const speak = (s, text) => { out.speaks.push(text); return Promise.resolve(); };
  return { session, speak, out };
}
function scene(fn, extra = {}) {
  return async () => {
    const env = { LIVE_ENABLED: 'true', GOOGLE_LIVE_API_KEY: 'offline-test-key', LIVE_CAP_EXEMPT_EMAILS: 'caller@example.invalid', ...extra };
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const { log, warn } = console;
    const logs = [];
    console.log = (...a) => logs.push(a.join(' ')); console.warn = console.log;
    const { session, speak, out } = caller();
    out.logs = logs;
    try {
      startLive(session, speak);
      const g = FakeGoogle.sockets.at(-1);
      g.emit('open');
      g.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
      const t0 = Date.now();
      const at = (ms) => { const d = t0 + ms - Date.now(); assert.ok(d >= 0, 'the scene runs forward'); mock.timers.tick(d); };
      /** Mic audio from `fromMs` to `toMs`, 100 ms chunks, as voice-stream forwards it. */
      const mic = (chunk, fromMs, toMs) => {
        at(fromMs);
        for (let t = fromMs; t < toMs; t += 100) { vl.forwardAudio(session, chunk.toString('base64'), chunk); mock.timers.tick(100); }
      };
      const modelSpeaks = () => g.emit('message', Buffer.from(JSON.stringify({
        serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] } },
      })));
      await fn({ session, out, g, at, mic, modelSpeaks });
    } finally {
      try { vl.stopLive(session, 'hangup'); } catch {}
      console.log = log; console.warn = warn;
      mock.timers.reset();
      for (const k of Object.keys(env)) delete process.env[k];
    }
  };
}
const warned = (out) => out.speaks.filter((t) => t === LIVE_SILENT_LINE).length;

test('HER WAIT: the Spotter connects, the caller says nothing for a minute, no notice', scene(async ({ out, mic, at }) => {
  mic(QUIET, 0, 30000);
  at(60000);
  assert.equal(warned(out), 0);
  assert.ok(!out.logs.some((l) => /WATCHDOG/.test(l)));
}));

test('a long first question (2 s to 11 s), no answer: the notice comes 12 s after it ends, not 12 s after connect', scene(async ({ out, mic, at }) => {
  mic(QUIET, 0, 2000);
  mic(LOUD, 2000, 11000);
  mic(QUIET, 11000, 22500);
  assert.equal(warned(out), 0, 'nothing at 12 s after connect, the caller was mid-question');
  at(22900);
  assert.equal(warned(out), 0, 'the model still has the floor at 11.9 s after the question');
  at(23200);
  assert.equal(warned(out), 1, 'the notice once 12 s after the question ended');
  assert.ok(out.logs.some((l) => /watchdog armed: the caller spoke \(voice\) 2s after setup/.test(l)), 'arming is logged');
  assert.ok(out.logs.some((l) => /WATCHDOG: no model audio \d+ms after the caller last spoke/.test(l)), 'the firing names what it measured');
  at(90000);
  assert.equal(warned(out), 1, 'never twice');
}));

test('the caller asks and the Spotter answers two seconds later: never a notice', scene(async ({ out, mic, at, modelSpeaks }) => {
  mic(LOUD, 3000, 5000);
  at(7000);
  modelSpeaks();
  assert.ok(out.logs.some((l) => /first model audio 7000ms after setup, \d+ms after the caller last spoke/.test(l)));
  mic(QUIET, 7000, 9000);
  at(90000);
  assert.equal(warned(out), 0);
}));

test('a cough, a bark or a door (300 ms of noise) does not start the count', scene(async ({ out, mic, at }) => {
  mic(LOUD, 5000, 5300);
  at(60000);
  assert.equal(warned(out), 0);
}));

test('the bridge\'s own voice in the mic is not the caller speaking', scene(async ({ session, out, mic, at }) => {
  session.isSpeaking = true;            // the character's handoff line is playing
  mic(LOUD, 0, 3000);
  session.isSpeaking = false; session.lastSpokAt = Date.now();
  mic(LOUD, 3000, 3800);                // its tail, inside the echo window
  at(60000);
  assert.equal(warned(out), 0);
}));

test('short words ("hi") arrive as a transcript: the count starts there', scene(async ({ session, out, at }) => {
  at(6000);
  vl.noteCallerWords(session);
  at(17900);
  assert.equal(warned(out), 0);
  at(18200);
  assert.equal(warned(out), 1);
  assert.ok(out.logs.some((l) => /watchdog armed: the caller spoke \(words\) 6s after setup/.test(l)));
}));

test('words transcribed in the first seconds may predate Google listening: they do not arm', scene(async ({ session, out, at }) => {
  at(2500);
  vl.noteCallerWords(session);
  at(60000);
  assert.equal(warned(out), 0);
}));

test('THE BROWNOUT: "can you see this?" / "are you there?" / "hello?" every 8 s, nothing back: the notice 20 s after the first words', scene(async ({ session, out, mic, at }) => {
  mic(LOUD, 3000, 4500); at(5500); vl.noteCallerWords(session);   // first words land at 5.5 s
  mic(LOUD, 11000, 12500); at(13500); vl.noteCallerWords(session);
  mic(LOUD, 19000, 20500); at(21500); vl.noteCallerWords(session);
  at(25400);
  assert.equal(warned(out), 0);
  at(25700);
  assert.equal(warned(out), 1, 'the cap: 20 s after the first words, though she kept talking');
  mic(LOUD, 27000, 28500); at(29500); vl.noteCallerWords(session);
  at(90000);
  assert.equal(warned(out), 1, 'once');
}));

test('LIVE_SILENCE_MS=0 still disables it, speech or not', scene(async ({ session, out, mic, at }) => {
  mic(LOUD, 2000, 4000);
  at(6000); vl.noteCallerWords(session);
  at(90000);
  assert.equal(warned(out), 0);
}, { LIVE_SILENCE_MS: '0' }));

test('voice-stream feeds the watchdog: the mic chunk as a Buffer, and the caller\'s live words', () => {
  const src = fs.readFileSync(require.resolve('./voice-stream.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /videoLive\.forwardAudio\(session, pcm\.toString\('base64'\), pcm\)/);
  const a = src.indexOf('  if (session.liveOn) {\n    // July 18 2026');
  const gate = src.slice(a, src.indexOf('    return;\n  }', a));
  assert.match(gate, /videoLive\.noteCallerWords\(session\)/, 'handleUtterance\'s live branch starts the count');
});
