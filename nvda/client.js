#!/usr/bin/env node
/**
 * NVDA Remote protocol client — v0.1, the co-listener (Aug 14, 2026).
 * Built the same night the protocol was verified from the nvdaremote source:
 * newline-delimited JSON over TLS, relay port 6837, PROTOCOL_VERSION 2.
 * Handshake per transport.py onConnected(): send protocol_version, then join
 * with a channel key and a connection_type ("master" hears the controlled
 * machine; "slave" IS the controlled machine).
 *
 * v0.1 scope, on purpose: LISTEN. The master receives every `speak` message
 * the controlled NVDA produces and appends the plain text to a log file a
 * session (or later, the bridge) can tail. sendKey() exists and is tested,
 * but nothing calls it unless a human asks — hands come in v0.2 with
 * confirm-before-act, per the spec's crawl-walk-run.
 *
 * Usage:
 *   node client.js --host nvdaremote.com --key CHANNELKEY --role master --log /tmp/nvda_speech.log
 *   node client.js --host nvdaremote.com --key CHANNELKEY --role slave --say "test line"   (loopback tester)
 *
 * No dependencies. Node 18+.
 */

'use strict';

const tls = require('tls');
const fs = require('fs');

const PROTOCOL_VERSION = 2;

function parseArgs(argv) {
  const a = { host: 'nvdaremote.com', port: 6837, role: 'master', log: '', key: '', say: '', quitAfter: 0 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--host') a.host = argv[++i];
    else if (k === '--port') a.port = parseInt(argv[++i], 10);
    else if (k === '--key') a.key = argv[++i];
    else if (k === '--role') a.role = argv[++i];
    else if (k === '--log') a.log = argv[++i];
    else if (k === '--say') a.say = argv[++i];
    else if (k === '--quit-after') a.quitAfter = parseInt(argv[++i], 10);
  }
  if (!a.key) { console.error('need --key'); process.exit(2); }
  if (!['master', 'slave'].includes(a.role)) { console.error('role must be master or slave'); process.exit(2); }
  return a;
}

/** Extract readable text from a speak message's sequence: strings stay,
 * speech-command objects (dicts) are dropped — same spirit as the TTS
 * proxy's prep chain. */
function textFromSequence(seq) {
  if (!Array.isArray(seq)) return '';
  return seq
    .filter((x) => typeof x === 'string')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

class NvdaRemoteClient {
  constructor(opts) {
    this.opts = opts;
    this.buffer = '';
    this.sock = null;
    this.onSpeak = opts.onSpeak || null;
    this.onEvent = opts.onEvent || null;
    this.pingTimer = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      /* The relay network historically runs self-signed certs; identity here
       * is the CHANNEL KEY, not the cert chain — same trust model as the
       * NVDA add-on itself. */
      this.sock = tls.connect(
        { host: this.opts.host, port: this.opts.port, rejectUnauthorized: false },
        () => {
          this.send({ type: 'protocol_version', version: PROTOCOL_VERSION });
          this.send({ type: 'join', channel: this.opts.key, connection_type: this.opts.role });
          this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 30000);
          resolve();
        },
      );
      this.sock.setEncoding('utf8');
      this.sock.on('data', (d) => this.onData(d));
      this.sock.on('error', reject);
      this.sock.on('close', () => { if (this.pingTimer) clearInterval(this.pingTimer); });
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.handle(msg);
    }
  }

  handle(msg) {
    const t = msg.type;
    if (t === 'speak') {
      const text = textFromSequence(msg.sequence);
      if (text && this.onSpeak) this.onSpeak(text, msg);
      return;
    }
    if (this.onEvent) this.onEvent(msg);
  }

  send(obj) {
    if (this.sock && !this.sock.destroyed) this.sock.write(JSON.stringify(obj) + '\n');
  }

  /** v0.2 material — present, tested, unused by the listener. */
  sendKey(vkCode, pressed, extended = false) {
    this.send({ type: 'key', vk_code: vkCode, extended, pressed, scan_code: null });
  }

  /** Loopback tester: emit a speak like a controlled NVDA would. */
  sendSpeak(text) {
    this.send({ type: 'speak', sequence: [text], priority: 0 });
  }

  close() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.sock) this.sock.end();
  }
}

if (require.main === module) {
  const a = parseArgs(process.argv);
  const stamp = () => new Date().toISOString().slice(11, 19);
  const out = (line) => {
    const s = `[${stamp()}] ${line}`;
    console.log(s);
    if (a.log) fs.appendFileSync(a.log, s + '\n');
  };
  const c = new NvdaRemoteClient({
    host: a.host, port: a.port, key: a.key, role: a.role,
    onSpeak: (text) => out(`SPEAK: ${text}`),
    onEvent: (m) => {
      if (m.type === 'channel_joined') out(`JOINED channel as ${a.role} (ids: ${JSON.stringify(m.user_ids || m.user_id || '')})`);
      else if (m.type === 'client_joined') out(`CLIENT JOINED: ${JSON.stringify(m.client || m.user_id || m)}`);
      else if (m.type === 'client_left') out(`CLIENT LEFT: ${JSON.stringify(m.client || m.user_id || m)}`);
      else if (m.type === 'motd') out(`MOTD: ${String(m.motd || '').slice(0, 200)}`);
      else if (m.type === 'error') out(`RELAY ERROR: ${JSON.stringify(m)}`);
      else if (m.type === 'version_mismatch') out('VERSION MISMATCH — relay refused protocol 2');
      else if (m.type !== 'ping') out(`EVENT: ${m.type}`);
    },
  });
  c.connect()
    .then(() => {
      out(`connected to ${a.host}:${a.port} as ${a.role}`);
      if (a.say) setTimeout(() => { c.sendSpeak(a.say); out(`SENT SPEAK: ${a.say}`); }, 1500);
      if (a.quitAfter) setTimeout(() => { c.close(); process.exit(0); }, a.quitAfter * 1000);
    })
    .catch((e) => { out(`CONNECT FAILED: ${e.message}`); process.exit(1); });
}

module.exports = { NvdaRemoteClient, textFromSequence, PROTOCOL_VERSION };
