/* spontaneous.nophone.test.js — Sep 29 2026.
 *
 * Every day at 11 Central the friend-text tick composed a full Kiana turn for
 * each quiet person, then learned from runNotify that no phone was linked
 * ("ZERO TARGETS"). Nothing was sent, so nothing was recorded, and the same
 * people were composed for again the next day. The phone check now comes
 * first. Nothing here touches the network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'spont-'));
process.env.SPONTANEOUS_USERS = 'u-phone,u-nophone';

const axios = require('axios');
const { attachSpontaneous } = require('./spontaneous');

function fakeApp() {
  const routes = {};
  const reg = (m) => (p, h) => { routes[`${m} ${p}`] = h; };
  return { routes, get: reg('GET'), post: reg('POST') };
}
async function call(app, method, p, body) {
  let out = null; let code = 200;
  const res = { status(c) { code = c; return res; }, json(o) { out = o; return res; } };
  await app.routes[`${method} ${p}`]({ body, query: {} }, res);
  return { code, out };
}

test('a quiet person with no linked phone is skipped before any compose; one with a phone is composed and sent', async () => {
  const saved = { get: axios.get, post: axios.post };
  const asked = []; const notified = [];
  const old = new Date(Date.now() - 10 * 864e5).toISOString();
  axios.get = async () => ({ data: { users: [
    { userId: 'u-nophone', name: 'Nophone', lastMessageAt: old },
    { userId: 'u-phone', name: 'Phone', lastMessageAt: old },
  ] } });
  axios.post = async (url, body) => { asked.push(body); return { data: { text: 'hey, did the porch swing ever get fixed' } }; };
  const { log } = console; console.log = () => {};
  try {
    const app = fakeApp();
    attachSpontaneous(app, {
      bridgeSecretOk: () => true, notifySecretOk: () => true,
      runNotify: async (n) => { notified.push(n.userId); return { ok: true, sent: 1 }; },
      proxyUrl: 'http://proxy', proxySecret: 's', browserUA: 'ua', siteBase: 'http://site',
      kianaAgentId: 'agent_k', kianaName: 'Kiana',
      hasDevice: (id) => id === 'u-phone',
    });
    const r = await call(app, 'POST', '/spontaneous', { fire: true });
    assert.equal(r.out.ok, true);
    assert.equal(r.out.skippedNoPhone, 1);
    assert.equal(asked.length, 1, 'only the person with a phone cost a compose');
    assert.deepEqual(notified, ['u-phone']);
    assert.equal(r.out.sent, 1);
  } finally {
    console.log = log;
    axios.get = saved.get; axios.post = saved.post;
  }
});
