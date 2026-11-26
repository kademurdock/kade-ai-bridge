'use strict';
/* site-seat.test.js -- Nov 26 2026 (Part 461). Calls to the site carry X-Kade-Service; calls to
 * anywhere else never do, not even after a redirect from the site. No network beyond 127.0.0.1. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const axios = require('axios');
const seat = require('./site-seat');

const SECRET = 'test-only-seat-secret-0123456789abcdef';

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
const echo = (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ seat: req.headers['x-kade-service'] || null }));
};

test('only the site origins count', () => {
  const env = { LIBRECHAT_URL: 'https://kademurdock.com/', FORK_USAGE_URL: 'https://kade-production.up.railway.app' };
  assert.equal(seat.isSiteUrl('https://kademurdock.com/api/auth/login', env), true);
  assert.equal(seat.isSiteUrl('https://kade-production.up.railway.app/api/x', env), true);
  assert.equal(seat.isSiteUrl('https://kademurdock.com.evil.example/api', env), false);
  assert.equal(seat.isSiteUrl('http://kademurdock.com/api', env), false);
  assert.equal(seat.isSiteUrl('https://inworld-tts-proxy-production.up.railway.app/librechat/ask', env), false);
  assert.equal(seat.isSiteUrl('not a url', env), false);
});

test('seatRequest adds the header for the site only, and only when the secret is set', () => {
  const env = { LIBRECHAT_URL: 'https://kademurdock.com', KADE_SERVICE_LIMIT_SECRET: SECRET };
  const site = seat.seatRequest({ url: 'https://kademurdock.com/api/auth/login', headers: { 'User-Agent': 'x' } }, env);
  assert.equal(site.headers['X-Kade-Service'], SECRET);
  assert.equal(site.headers['User-Agent'], 'x');
  const based = seat.seatRequest({ baseURL: 'https://kademurdock.com', url: '/api/x', headers: {} }, env);
  assert.equal(based.headers['X-Kade-Service'], SECRET);
  const other = seat.seatRequest({ url: 'https://api.openrouter.ai/v1', headers: {} }, env);
  assert.equal(other.headers['X-Kade-Service'], undefined);
  const off = seat.seatRequest({ url: 'https://kademurdock.com/api/x', headers: {} }, { LIBRECHAT_URL: 'https://kademurdock.com' });
  assert.equal(off.headers['X-Kade-Service'], undefined);
});

test('through real axios: the site gets the header, another host does not, a redirect off the site drops it', async () => {
  const other = await listen(echo);
  const site = await listen((req, res) => {
    if (req.url === '/away') { res.statusCode = 302; res.setHeader('location', `${other.base}/landed`); return res.end(); }
    if (req.url === '/stay') { res.statusCode = 302; res.setHeader('location', '/here'); return res.end(); }
    return echo(req, res);
  });
  const env = { LIBRECHAT_URL: site.base, KADE_SERVICE_LIMIT_SECRET: SECRET };
  const ax = axios.create();
  ax.interceptors.request.use((c) => seat.seatRequest(c, env));
  try {
    assert.equal((await ax.post(`${site.base}/api/auth/login`, {})).data.seat, SECRET);
    assert.equal((await ax.get(`${other.base}/x`)).data.seat, null);
    assert.equal((await ax.get(`${site.base}/stay`)).data.seat, SECRET);
    assert.equal((await ax.get(`${site.base}/away`)).data.seat, null);
  } finally {
    site.server.close();
    other.server.close();
  }
});

test('a failed site call does not carry the secret on its error', async () => {
  const site = await listen((req, res) => { res.statusCode = 500; res.end('no'); });
  const env = { LIBRECHAT_URL: site.base, KADE_SERVICE_LIMIT_SECRET: SECRET };
  const ax = axios.create();
  ax.interceptors.request.use((c) => seat.seatRequest(c, env));
  ax.interceptors.response.use((r) => r, (e) => Promise.reject(seat.scrubError(e)));
  try {
    const err = await ax.get(`${site.base}/api/x`).then(() => null, (e) => e);
    assert.ok(err && err.response && err.response.status === 500);
    assert.equal(require('util').inspect(err, { depth: 6 }).includes(SECRET), false);
  } finally {
    site.server.close();
  }
});

test('installAxiosSeat hooks the shared axios instance once', () => {
  const calls = [];
  const fake = { interceptors: { request: { use: (fn) => calls.push(fn) }, response: { use: (_ok, bad) => calls.push(bad) } } };
  assert.equal(seat.installAxiosSeat(fake), true);
  assert.equal(seat.installAxiosSeat(fake), false);
  assert.equal(calls.length, 2);
});

test('server.js installs the hook right after it loads axios', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  assert.match(src, /const axios\s+= require\('axios'\);\n[^\n]*\nrequire\('\.\/site-seat'\)\.installAxiosSeat\(axios\);/);
});

test('a secret the site would ignore (short, or with a comma) is never sent', () => {
  for (const bad of ['short-secret', 'abc,defghijklmnopqrstuvwxyz0123']) {
    const env = { LIBRECHAT_URL: 'https://kademurdock.com', KADE_SERVICE_LIMIT_SECRET: bad };
    assert.equal(seat.seatSecret(env), '');
    assert.match(seat.seatSecretProblem(env), /at least 24 characters/);
    assert.equal(seat.seatSecretProblem(env).includes(bad), false);
    const cfg = seat.seatRequest({ url: 'https://kademurdock.com/api/auth/login', headers: {} }, env);
    assert.equal(cfg.headers['X-Kade-Service'], undefined);
  }
  assert.equal(seat.seatSecretProblem({}), '');
  assert.equal(seat.seatSecretProblem({ KADE_SERVICE_LIMIT_SECRET: SECRET }), '');
});
