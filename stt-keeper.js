'use strict';
/* Nov 10 2026 (call limits lane). THE LISTENING SOCKET IS KEPT UP.
 *
 * Every call (phone, app, web) hears the caller through one Deepgram socket opened when the call
 * starts. When that socket dropped in the middle of a call, or never opened (a bad key, an empty
 * balance, a network blip), the close and error handlers only wrote a log line: the caller's audio
 * was thrown away for the rest of the call, they were told nothing, and the character sat silent
 * for ever. For a blind caller that is a dead line with no way to know why.
 *
 * Now a dropped listening socket is opened again, and if that keeps failing the caller is told.
 *
 *   - Lazily: a new socket is opened when the next piece of the caller's audio arrives and finds
 *     the old one gone. No audio flowing means no reconnecting, so nothing can spin.
 *   - Paced: the first try is at once, then 0.7 s, 2 s and 5 s apart.
 *   - After four tries in a row that did not hold, the character says once that it is having
 *     trouble hearing, and tries go on every 15 s without another word. When listening comes back
 *     after that, it says so. A socket that stayed up 10 s counts as held and resets the count.
 *
 * STT_RECONNECT=0 puts the old behaviour back (log and nothing else).
 *
 * This file opens nothing by itself. It is handed a function that opens the socket (voice-stream's
 * own openDeepgram, the one every call already uses) and a clock, so the rules are tested with fake
 * sockets in stt-keeper.test.js. Deepgram bills for audio it receives, not for a connection.
 */

const DEFAULTS = { gapsMs: [0, 700, 2000, 5000], slowGapMs: 15000, stableMs: 10000 };

function sttKeeperConfig(env = process.env) {
  return { enabled: String(env.STT_RECONNECT || '').trim() !== '0', ...DEFAULTS };
}

const TROUBLE_LINE = "I'm having trouble hearing you right now. Give me a few seconds. If I still don't answer, please hang up and call back.";
const BACK_LINE = 'Okay, I can hear you again. Go ahead.';

/**
 *   openSocket   () => a ws-like emitter ('open', 'close'), or null when it cannot be opened at all
 *   isCallOpen   () => the call itself is still up
 *   onTrouble    () => tell the caller listening is down (called once per bad spell)
 *   onBack       () => tell the caller listening is back (only after onTrouble was called)
 */
function createSttKeeper({ openSocket, isCallOpen, onTrouble, onBack, now = () => Date.now(), log = console, cfg = sttKeeperConfig(), label = '' }) {
  const st = { current: null, down: false, openAt: 0, tries: 0, lastTryAt: 0, told: false, ended: false, reopened: 0 };
  const tag = `[stt-keeper]${label ? ' ' + label : ''}`;

  function watch(ws) {
    st.current = ws;
    st.down = false;
    st.openAt = 0;
    if (!ws || typeof ws.on !== 'function') { st.down = true; return ws; }
    ws.on('open', () => {
      if (ws !== st.current) return;
      st.openAt = now();
    });
    ws.on('close', () => {
      if (st.ended || ws !== st.current) return;
      const held = st.openAt && now() - st.openAt >= cfg.stableMs;
      if (held) st.tries = 0;
      st.down = true;
      st.openAt = 0;
      if (cfg.enabled) log.warn(`${tag} the listening socket closed mid-call${held ? '' : ' before it held'}: it will be opened again on the next audio`);
      else log.warn(`${tag} the listening socket closed mid-call and STT_RECONNECT=0: the caller is no longer heard`);
    });
    return ws;
  }

  /** Called for every piece of caller audio that found no open socket. Returns a new socket, or null. */
  function frame() {
    if (st.ended || !cfg.enabled || !st.down) return null;
    if (!isCallOpen()) return null;
    const t = now();
    const quick = st.tries < cfg.gapsMs.length;
    const gap = quick ? cfg.gapsMs[st.tries] : cfg.slowGapMs;
    if (st.lastTryAt && t - st.lastTryAt < gap) return null;
    if (!quick && !st.told) {
      st.told = true;
      log.warn(`${tag} ${st.tries} tries did not hold: telling the caller, and trying every ${cfg.slowGapMs / 1000} s from here`);
      try { onTrouble && onTrouble(); } catch (e) { /* a notice must never break the call */ }
    }
    st.tries += 1;
    st.lastTryAt = t;
    let ws = null;
    try { ws = openSocket(); } catch (e) { log.warn(`${tag} could not open a listening socket: ${e && e.message}`); }
    if (!ws) { st.down = true; return null; }
    st.reopened += 1;
    log.log(`${tag} opening the listening socket again (try ${st.tries})`);
    watch(ws);
    ws.on('open', () => {
      if (ws !== st.current || st.ended) return;
      // Told the caller it was down, and it is up again: say so once it has held a moment.
      if (st.told) {
        const mine = ws;
        const check = () => {
          if (st.ended || st.current !== mine || st.down) return;
          st.told = false;
          st.tries = 0;
          log.log(`${tag} listening is back`);
          try { onBack && onBack(); } catch (e) {}
        };
        const timer = setTimeout(check, 1500);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
    });
    return ws;
  }

  function end() { st.ended = true; }

  return { watch, frame, end, state: st };
}

module.exports = { createSttKeeper, sttKeeperConfig, TROUBLE_LINE, BACK_LINE, DEFAULTS };
