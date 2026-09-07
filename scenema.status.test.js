'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

test('Scenema status respects the exact job and owner, while latest remains explicit', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenema-status-'));
  fs.writeFileSync(path.join(dir, 'scenema-jobs.json'), JSON.stringify([
    { id: 'alice-old', userId: 'alice', prompt: 'Invented old line', state: 'done' },
    { id: 'bob-job', userId: 'bob', prompt: 'Private fixture', state: 'done' },
    { id: 'alice-new', userId: 'alice', prompt: 'Invented new line', state: 'done' },
  ]));
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'scenema.js'), 'utf8'), {
    module: mod, require, console,
    process: { env: { SCENEMA_ENABLED: '0', RAILWAY_VOLUME_MOUNT_PATH: dir } },
    Buffer, URL, setTimeout, clearTimeout,
  });
  const app = express();
  mod.exports.attachScenema(app, { bridgeSecretOk: (_req, value) => value === 'test-only' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true });
  });
  const read = async (query) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/audio/scenema/status?secret=test-only&${query}`);
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  };
  const exact = await read('jobId=alice-old&userId=alice');
  assert.equal(exact.body.id, 'alice-old');
  assert.equal(exact.cache, 'no-store');
  assert.equal((await read('jobId=expired&userId=alice')).status, 404);
  const foreign = await read('jobId=bob-job&userId=alice');
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.promptPreview, undefined);
  assert.equal((await read('userId=alice')).body.id, 'alice-new');
  assert.equal((await read('jobId=bob-job')).body.id, 'bob-job');
});
