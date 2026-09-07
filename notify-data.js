'use strict';
function notificationData(routeName, runId) {
  if (!routeName) return undefined;
  return { kadeRoute: routeName,
    ...(routeName === 'agent-work' && /^r[a-z0-9]{8,40}$/.test(String(runId || '')) ? { kadeRunId: runId } : {}) };
}
module.exports = { notificationData };
