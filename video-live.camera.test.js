/* video-live.camera.test.js -- Nov 2026 (platform audit DESC-4 and DESC-3). The phone locked,
 * the camera stopped, and the Spotter kept describing the last picture. The app now says so and
 * the bridge tells the Spotter once per stop. Also the frame guard: a frame that is not a
 * picture the apps could have made, or one that would queue behind a backed-up Google socket,
 * is dropped. Fake sockets, no network. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'vlive-camera-'));
delete process.env.KADE_USAGE_EVENT_SECRET;
delete process.env.LIVE_CAMERA_NOTE;
delete process.env.LIVE_CAMERA_NOTE_VIA;
delete process.env.LIVE_FRAME_GUARD;
const vl = require('./video-live');

function liveSession() {
  const sent = [];
  return { sent, session: { userId: 'u1', liveOn: true, _liveWs: { readyState: 1, send: (d) => sent.push(JSON.parse(d)) } } };
}

test('two "camera stopped" messages tell the Spotter once, as realtime text', () => {
  const { sent, session } = liveSession();
  assert.strictEqual(vl.noteCamera(session, false), true);
  assert.strictEqual(vl.noteCamera(session, false), false);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].realtimeInput.text, vl.LIVE_CAMERA_LOST);
  assert.ok(!sent[0].clientContent);
});

test('"camera back" re-arms the note', () => {
  const { sent, session } = liveSession();
  vl.noteCamera(session, false);
  vl.noteCamera(session, true);
  vl.noteCamera(session, false);
  assert.strictEqual(sent.length, 2);
});

test('a new frame re-arms the note even when "camera back" never arrived', () => {
  const { sent, session } = liveSession();
  vl.noteCamera(session, false);
  vl.forwardFrame(session, 'AAAA');
  vl.noteCamera(session, false);
  assert.strictEqual(sent.filter((m) => m.realtimeInput && m.realtimeInput.text).length, 2);
});

test('stopLive re-arms the note for the next "live on"', () => {
  const { session } = liveSession();
  session.history = [];
  vl.noteCamera(session, false);
  vl.stopLive(session, 'hangup');
  assert.strictEqual(session._liveCameraLostAt, 0);
});

test('nothing is sent when live is off or the Google socket is not open', () => {
  const a = liveSession(); a.session.liveOn = false;
  assert.strictEqual(vl.noteCamera(a.session, false), false);
  const b = liveSession(); b.session._liveWs.readyState = 3;
  assert.strictEqual(vl.noteCamera(b.session, false), false);
  assert.strictEqual(a.sent.length + b.sent.length, 0);
});

test('LIVE_CAMERA_NOTE=0 turns the note off; LIVE_CAMERA_NOTE_VIA=client sends a clientContent turn', () => {
  process.env.LIVE_CAMERA_NOTE = '0';
  const a = liveSession();
  assert.strictEqual(vl.noteCamera(a.session, false), false);
  delete process.env.LIVE_CAMERA_NOTE;
  process.env.LIVE_CAMERA_NOTE_VIA = 'client';
  const b = liveSession();
  vl.noteCamera(b.session, false);
  delete process.env.LIVE_CAMERA_NOTE_VIA;
  assert.strictEqual(b.sent[0].clientContent.turns[0].parts[0].text, vl.LIVE_CAMERA_LOST);
});

test('DESC-3: a normal frame is forwarded as a JPEG', () => {
  const { sent, session } = liveSession();
  vl.forwardFrame(session, 'A'.repeat(100 * 1024));
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].realtimeInput.video.mimeType, 'image/jpeg');
});

test('DESC-3: an oversized or non-string frame is dropped, logged once', () => {
  const { sent, session } = liveSession();
  const logs = [];
  const real = console.log; console.log = (m) => logs.push(String(m));
  try {
    vl.forwardFrame(session, 'A'.repeat(600 * 1024 + 1));
    vl.forwardFrame(session, { not: 'a string' });
    vl.forwardFrame(session, undefined);
  } finally { console.log = real; }
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(logs.filter((l) => l.includes('dropped a camera frame')).length, 1);
});

test('DESC-3: a frame never queues behind a backed-up Google socket; it flows again once drained', () => {
  const { sent, session } = liveSession();
  session._liveWs.bufferedAmount = 512 * 1024 + 1;
  vl.forwardFrame(session, 'AAAA');
  assert.strictEqual(sent.length, 0);
  session._liveWs.bufferedAmount = 0;
  vl.forwardFrame(session, 'AAAA');
  assert.strictEqual(sent.length, 1);
});

test('DESC-3: a dropped frame does not count as the camera coming back', () => {
  const { sent, session } = liveSession();
  vl.noteCamera(session, false);
  session._liveWs.bufferedAmount = 600 * 1024;
  vl.forwardFrame(session, 'AAAA');
  assert.ok(session._liveCameraLostAt > 0);
  assert.strictEqual(sent.length, 1);
});

test('LIVE_FRAME_GUARD=0 forwards every frame as before', () => {
  process.env.LIVE_FRAME_GUARD = '0';
  try {
    const { sent, session } = liveSession();
    session._liveWs.bufferedAmount = 10 * 1024 * 1024;
    vl.forwardFrame(session, 'A'.repeat(700 * 1024));
    assert.strictEqual(sent.length, 1);
  } finally { delete process.env.LIVE_FRAME_GUARD; }
});
