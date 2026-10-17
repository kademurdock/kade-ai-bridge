/* spontaneous.inchat.test.js — Oct 16 2026.
 *
 * Friend texts are written on the person's own seat by the fork and land as the
 * first message of a real conversation (POST /api/kade/soul/speak); the fork
 * sends the push itself. The bridge keeps the gating (adults list, idle days,
 * gap, phone linked) and records the send. Nothing here touches the network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'spont-chat-'));
process.env.SPONTANEOUS_USERS = 'u-phone';
delete process.env.SPONTANEOUS_IN_CHAT;
process.env.BRIDGE_SECRET = 'bridge-secret';

const axios = require('axios');
const { attachSpontaneous } = require('./spontaneous');

function fakeApp() {
  const routes = {};
  const reg = (m) => (p, h) => { routes[`${m} ${p}`] = h; };
  return { routes, get: reg('GET'), post: reg('POST') };
}

test('a friend text goes through the fork into a conversation, platform-paid, and is recorded', async () => {
  const saved = { get: axios.get, post: axios.post };
  const posts = []; const notified = [];
  const old = new Date(Date.now() - 10 * 864e5).toISOString();
  axios.get = async () => ({ data: { users: [{ userId: 'u-phone', name: 'Phone', lastMessageAt: old }] } });
  axios.post = async (url, body, opts) => {
    posts.push({ url, body, secret: opts.headers['x-kade-secret'] });
    return { data: { ok: true, text: '%%%warm%%% did the porch swing ever get fixed', conversationId: 'c-1', pushed: { ok: true, sent: 1 } } };
  };
  const { log } = console; console.log = () => {};
  try {
    const app = fakeApp();
    attachSpontaneous(app, {
      bridgeSecretOk: () => true, notifySecretOk: () => true,
      runNotify: async (n) => { notified.push(n.userId); return { ok: true, sent: 1 }; },
      proxyUrl: 'http://proxy', proxySecret: 's', browserUA: 'ua', siteBase: 'http://site',
      kianaAgentId: 'agent_k', kianaName: 'Kiana', hasDevice: () => true,
    });
    let out = null;
    const res = { status() { return res; }, json(o) { out = o; return res; } };
    await app.routes['POST /spontaneous']({ body: { fire: true }, query: {} }, res);
    assert.equal(out.ok, true);
    assert.equal(out.sent, 1);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'http://site/api/kade/soul/speak');
    assert.equal(posts[0].secret, 'bridge-secret');
    assert.deepEqual(
      { userId: posts[0].body.userId, agentId: posts[0].body.agentId, kind: posts[0].body.kind, platformPaid: posts[0].body.platformPaid },
      { userId: 'u-phone', agentId: 'agent_k', kind: 'friend-text', platformPaid: true },
    );
    assert.doesNotMatch(posts[0].body.note, /^\[/, 'the fork frames the note itself');
    assert.deepEqual(notified, [], 'the fork pushes; the bridge does not push twice');
    assert.equal(out.results[0].conversationId, 'c-1');
  } finally {
    console.log = log;
    axios.get = saved.get; axios.post = saved.post;
  }
});
