'use strict';

// Persist an attempt before sending. After a restart, an uncertain attempt
// becomes a chat receipt rather than a duplicate phone notification.
async function deliverReminder(sub, { notify, queueMissed, save, remove, isTestUser }) {
  if (isTestUser(sub.userId)) { remove(sub.id); return { sent: 0, testAccount: true }; }
  if (!sub.deliveryStatus) {
    sub.deliveryStatus = 'attempting'; save();
    try {
      const result = await notify(sub);
      if (result?.ok && result.sent > 0) {
        remove(sub.id);
        return { sent: result.sent };
      }
      sub.deliveryReason = result?.blocked || result?.note || result?.error || 'No phone accepted the notification';
    } catch (_) { sub.deliveryReason = 'The phone notification service did not confirm delivery'; }
    sub.deliveryStatus = 'missed'; save();
  }
  await queueMissed(sub);
  remove(sub.id);
  return { sent: 0, queuedForChat: true };
}
module.exports = { deliverReminder };
