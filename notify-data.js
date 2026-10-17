'use strict';
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/* Oct 16 2026: 'conversation' opens one exact chat (a character's message, a
 * finished task); builds that do not know the route just open the app. */
function notificationData(routeName, runId, conversationId) {
  if (!routeName) return undefined;
  return { kadeRoute: routeName,
    ...(routeName === 'agent-work' && /^r[a-z0-9]{8,40}$/.test(String(runId || '')) ? { kadeRunId: runId } : {}),
    ...(routeName === 'conversation' && CONVERSATION_ID.test(String(conversationId || '')) ? { kadeConversationId: String(conversationId) } : {}) };
}
module.exports = { notificationData };
