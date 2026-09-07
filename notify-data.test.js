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
