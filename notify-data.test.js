const test = require('node:test');
const assert = require('node:assert/strict');
const { notificationData } = require('./notify-data');
test('notification payload preserves exact job identity through serialization and rejects path input', () => {
  const runId = 'r123456789';
  assert.deepEqual(JSON.parse(JSON.stringify(notificationData('agent-work', runId))), { kadeRoute: 'agent-work', kadeRunId: runId });
  assert.deepEqual(notificationData('agent-work', '../admin'), { kadeRoute: 'agent-work' });
  assert.deepEqual(notificationData('admin', runId), { kadeRoute: 'admin' });
  assert.equal(notificationData(null, runId), undefined);
});

test('a conversation push carries the exact conversation id, and nothing else gets one', () => {
  const id = '3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f';
  assert.deepEqual(notificationData('conversation', null, id), { kadeRoute: 'conversation', kadeConversationId: id });
  assert.deepEqual(notificationData('conversation', null, 'new'), { kadeRoute: 'conversation' });
  assert.deepEqual(notificationData('admin', null, id), { kadeRoute: 'admin' });
});
