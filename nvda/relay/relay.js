#!/usr/bin/env node
/**
 * Self-hostable NVDA Remote relay server — clean-room Node implementation.
 * (Aug 14, 2026. Kade's "own platform" relay, roadmap item 3.)
 *
 * WHY THIS EXISTS
 *   NVDA's Remote Access has both sides speak a small newline-delimited JSON
 *   protocol through a relay. The public relay (nvdaremote.com) is fine, but
 *   the speech stream IS everything her computer says — so she wanted her own
 *   relay, where that stream never crosses anyone else's box. This is that
 *   relay: Railway-sized, no dependencies, deploy-anywhere.
 *
 *   Bonus we proved the hard way: nvdaremote.com's relay rejected every Node
 *   TLS ClientHello we tried (alert 80) while accepting Python from the same
 *   box. Against OUR OWN Node relay, the Node client connects clean — so the
 *   Node lane the bridge wants is unblocked the moment the relay is ours.
 *
 * CLEAN-ROOM NOTE
 *   This is an independent implementation of the wire behavior (framing,
 *   handshake, channel fan-out), written from the protocol description, NOT
 *   copied from the GPL add-on/server source. Field names match so a real
 *   NVDA (the classic NVDA Remote add-on) interoperates. See README.
 *
 * PROTOCOL
 *   Transport: newline-delimited JSON over TLS, default port 6837.
 *   PROTOCOL_VERSION 2. A client sends {type:'protocol_version',version:2}
 *   then {type:'join',channel:KEY,connection_type:'master'|'slave'}.
 *   The relay is a dumb, faithful broadcaster: control messages
 *   (protocol_version / join / ping) are handled here; every other message is
 *   stamped with `origin` (the sender's id) and forwarded to the OTHER members
 *   of the same channel. That is how `speak` reaches the master and `key`
 *   reaches the slave.
 *
 * USAGE
 *   node relay/relay.js                       # TLS on 0.0.0.0:6837, self-signed cert
 *   node relay/relay.js --port 6837 --cert cert.pem --key key.pem
 *   node relay/relay.js --insecure            # plain TCP (LOCAL TESTING ONLY)
 *   PORT=6837 node relay/relay.js             # env also honored (Railway)
 */

'use strict';

const tls = require('tls');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PROTOCOL_VERSION = 2;

/** Generate an ephemeral self-signed cert with openssl. The trust model here
 *  is the CHANNEL KEY (rooms are key-gated), not the cert chain — exactly as
 *  the NVDA add-on itself treats it (clients connect rejectUnauthorized:false).
 *  Returns {key, cert} PEM buffers, or throws if openssl is missing. */
function generateSelfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvda-relay-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '3650',
    '-subj', '/CN=nvda-relay',
  ], { stdio: 'ignore' });
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

class NvdaRelay {
  constructor(opts = {}) {
    this.port = opts.port || parseInt(process.env.PORT, 10) || 6837;
    this.host = opts.host || '0.0.0.0';
    this.useTls = opts.tls !== false;
    this.certs = opts.certs || null; // {key, cert} — if null and useTls, generated
    this.log = opts.log || ((...a) => console.log('[relay]', ...a));
    this.channels = new Map(); // channelKey -> Map(id -> client)
    this.nextId = 100000;
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const onConn = (sock) => this._onConnection(sock);
      if (this.useTls) {
        const certs = this.certs || generateSelfSigned();
        // First-byte demux on ONE port: a TLS handshake starts with 0x16, so
        // those become NVDA relay connections; anything else (a plain HTTP GET)
        // is answered as a health check. This lets the relay pass a hosting
        // platform's HTTP /health probe AND serve the raw-TLS NVDA protocol on
        // the same port — no second port, no platform config gymnastics.
        const secureContext = tls.createSecureContext({ key: certs.key, cert: certs.cert });
        this.server = net.createServer((socket) => {
          // Paused-mode peek: read one byte, put it back, then route. Using
          // 'readable'+read(1) (not 'data') keeps the stream paused so the
          // unshifted byte is cleanly re-consumed by whichever handler takes over.
          const onReadable = () => {
            const chunk = socket.read(1);
            if (chunk === null) return; // not enough yet; wait for next readable
            socket.removeListener('readable', onReadable);
            socket.unshift(chunk);
            if (chunk[0] === 0x16) {
              const tlsSocket = new tls.TLSSocket(socket, { isServer: true, secureContext });
              tlsSocket.on('error', () => { try { tlsSocket.destroy(); } catch { /* */ } });
              onConn(tlsSocket);
            } else {
              const body = 'ok';
              try { socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`); } catch { /* */ }
            }
          };
          socket.on('readable', onReadable);
          socket.on('error', () => { /* pre-handshake resets are normal */ });
        });
      } else {
        this.server = net.createServer(onConn);
      }
      this.server.on('error', reject);
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address();
        this.log(`listening ${this.useTls ? 'TLS(+health)' : 'PLAIN'} on ${this.host}:${addr.port} (protocol ${PROTOCOL_VERSION})`);
        resolve(addr.port);
      });
    });
  }

  _onConnection(sock) {
    const client = { id: this.nextId++, sock, channel: null, role: null, buffer: '', proto: null, joinTimer: null };
    /* Aug 15 2026 — THE REAPER. After the squatters left, the relay still
     * never slept, and the likeliest reason is sockets that connect and
     * never join (scanners, half-opens) holding "traffic" forever. A
     * socket gets 60 seconds to say join or it's gone; a legitimate NVDA
     * add-on joins within one. */
    client.joinTimer = setTimeout(() => {
      if (!client.channel) {
        this.log(`reaped unjoined socket id=${client.id} (60s, no join)`);
        try { sock.destroy(); } catch (_) {}
      }
    }, 60_000);
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => this._onData(client, chunk));
    sock.on('error', () => this._drop(client));
    sock.on('close', () => this._drop(client));
  }

  _onData(client, chunk) {
    client.buffer += chunk;
    let idx;
    while ((idx = client.buffer.indexOf('\n')) >= 0) {
      const line = client.buffer.slice(0, idx);
      client.buffer = client.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this._handle(client, msg);
    }
  }

  _handle(client, msg) {
    switch (msg.type) {
      case 'protocol_version':
        client.proto = msg.version;
        if (msg.version !== PROTOCOL_VERSION) {
          this._sendTo(client, { type: 'version_mismatch' });
        }
        return;
      case 'join':
        this._join(client, msg);
        return;
      case 'ping':
        this._sendTo(client, { type: 'ping' });
        return;
      default:
        // Everything else (speak, key, cancel, tone, wave, set_clipboard_text,
        // braille, …) is fanned out to the rest of the channel, origin-stamped.
        if (!client.channel) return;
        msg.origin = client.id;
        this._broadcast(client, msg);
        return;
    }
  }

  _join(client, msg) {
    const key = String(msg.channel || '');
    /* Aug 15 2026 — THE DOOR GETS A POLICY. sleepApplication was on and the
     * service never slept: the logs showed a foreign controlled machine
     * parked nearly four hours in channel "appleres…" plus stray
     * "relaysvc…" joins — neither shape exists anywhere in this codebase,
     * and Kade doesn't know them. An NVDA Remote relay on a public TCP
     * proxy WILL be found, and an open one relays strangers' screen-reader
     * sessions on her dime. Rooms are minted-keys-only now: the bridge
     * hands out kade-<24 hex> and reads it to her aloud, so the real flow
     * pays nothing. Debug escape hatch: RELAY_OPEN=1 restores the old
     * open door. */
    if (process.env.RELAY_OPEN !== '1' && !/^kade-[0-9a-f]{24}$/.test(key)) {
      this.log(`REFUSED join id=${client.id} channel=${key.slice(0, 8)}… (minted keys only)`);
      this._sendTo(client, { type: 'error', message: 'This relay admits invited sessions only.' });
      try { client.sock.destroy(); } catch (_) {}
      return;
    }
    if (client.joinTimer) { clearTimeout(client.joinTimer); client.joinTimer = null; }
    client.channel = key;
    client.role = msg.connection_type || 'master';
    if (!this.channels.has(key)) this.channels.set(key, new Map());
    const room = this.channels.get(key);

    const others = [...room.values()];
    room.set(client.id, client);

    // Tell the joiner who is already here (both id list and rich objects).
    this._sendTo(client, {
      type: 'channel_joined',
      origin: client.id,
      channel: key,
      user_ids: others.map((c) => c.id),
      clients: others.map((c) => ({ id: c.id, connection_type: c.role })),
    });

    // Tell existing members someone arrived.
    const joined = {
      type: 'client_joined',
      origin: client.id,
      user_id: client.id,
      client: { id: client.id, connection_type: client.role },
    };
    for (const c of others) this._sendTo(c, joined);

    this.log(`join id=${client.id} role=${client.role} channel=${key.slice(0, 8)}… (${room.size} in room)`);
  }

  _broadcast(from, msg) {
    const room = this.channels.get(from.channel);
    if (!room) return;
    for (const c of room.values()) {
      if (c.id !== from.id) this._sendTo(c, msg);
    }
  }

  _sendTo(client, obj) {
    if (client.sock && !client.sock.destroyed) {
      try { client.sock.write(JSON.stringify(obj) + '\n'); } catch { /* dropped */ }
    }
  }

  _drop(client) {
    if (!client.channel) return;
    const room = this.channels.get(client.channel);
    if (!room || !room.has(client.id)) return;
    room.delete(client.id);
    const left = {
      type: 'client_left',
      origin: client.id,
      user_id: client.id,
      client: { id: client.id, connection_type: client.role },
    };
    for (const c of room.values()) this._sendTo(c, left);
    if (room.size === 0) this.channels.delete(client.channel);
    this.log(`left id=${client.id} channel=${String(client.channel).slice(0, 8)}…`);
    client.channel = null;
  }

  stop() {
    return new Promise((resolve) => {
      for (const room of this.channels.values()) {
        for (const c of room.values()) { try { c.sock.destroy(); } catch { /* */ } }
      }
      this.channels.clear();
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }
}

function parseArgs(argv) {
  const a = { port: 0, host: '0.0.0.0', tls: true, cert: '', key: '' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--port') a.port = parseInt(argv[++i], 10);
    else if (k === '--host') a.host = argv[++i];
    else if (k === '--insecure') a.tls = false;
    else if (k === '--cert') a.cert = argv[++i];
    else if (k === '--key') a.key = argv[++i];
  }
  return a;
}

if (require.main === module) {
  const a = parseArgs(process.argv);
  const certs = a.cert && a.key
    ? { cert: fs.readFileSync(a.cert), key: fs.readFileSync(a.key) }
    : null;
  const relay = new NvdaRelay({ port: a.port || undefined, host: a.host, tls: a.tls, certs });
  relay.start().catch((e) => { console.error('[relay] start failed:', e.message); process.exit(1); });
  process.on('SIGINT', () => relay.stop().then(() => process.exit(0)));
}

module.exports = { NvdaRelay, PROTOCOL_VERSION, generateSelfSigned };
