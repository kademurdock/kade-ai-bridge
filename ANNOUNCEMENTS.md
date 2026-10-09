# Durable platform announcements

An admin can publish one platform introduction into the shared announcements
history and attempt native and browser notifications with a fresh public-agent
chat target. Each introduction has a durable operation ID. A repeated request
returns the existing outcome; it never repeats the audience send. Unknown provider
outcomes are reconciled by reads.

The new routes require the existing admin `x-bridge-secret` header:

- `GET /announcements/audience?agentId=agent_<21-character-id>` returns aggregate
  account, registered-device and browser-subscription counts plus the existing
  mute, quiet-hours, cooldown and daily-budget gate.
- `POST /announcements` accepts `{id,title,body,agentId,channels:{native:true,web:true}}`.
  The ID must be a lowercase identifier of8–96characters; title1–40 and body1–1000.
  The serialized APNs payload must also fit4096bytes. Unknown fields are rejected.
- `GET /announcements/:id` returns counts, durable-publication status and any
  unknown delivery state. It sends nothing and modifies no journal.

The public agent is verified through the LibreChat service. Chat URLs are derived
as `https://kademurdock.com/c/new?agent_id=<exact-id>`. No arbitrary external URL,
urgent override, user-target override or agent-scoped credential is accepted.
Native notifications use `KADE_ROUTE`, `kadeRoute:"agent-chat"`, the exact
`kadeAgentId`, and the operation's `kadeAnnouncementId`. The history row retains
the same chat metadata and public agent name for accessible actions.

The operation journal requires a real persistent Railway volume. There is no
temporary-directory fallback. The current production bridge has a READY volume
mounted at `/data`; both the new operation journal and existing history are
stored there. Writes use a flushed temporary file followed by rename. A missing
mount or unreadable operation store disables this new API while legacy bridge
features remain available.

History is persisted before either fanout. Native attempts exclude review/test,
unlinked, unconfigured and inactive-account devices. The fork checks active
account eligibility and public-agent access, persists its unique web operation,
and delivers only to existing consenting subscriptions. The bridge uses the
existing APNs/FCM dispatchers and prunes confirmed dead tokens. Native timeouts
remain unknown; late provider results can update counts without another send.
Web timeouts are resolved through the fork's read-only operation status.

The existing `/notify`, `/broadcasts` and notification preference routes retain
their behavior and existing history rows. This patch does not publish or send an
introduction by deploying alone.

## Companion LibreChat contract

All use the existing shared admin secret header. No raw account IDs or push
subscriptions appear in responses.

- `GET /api/kade/admin/announcement-audience?agentId=...` for aggregate reads.
- Read-only `POST /api/kade/admin/announcement-audience` accepts
  `{agentId,nativeUserIds:[...]}`; returns the eligible input indexes plus counts.
- `POST /api/kade/admin/announcement-web-push` accepts
  `{id,payloadHash,title,body,agentId,url}`.
- `GET /api/kade/admin/announcement-web-push/:id` returns the same bound operation
  and aggregate state without a resend.

`payloadHash` is SHA256 of UTF-8 `JSON.stringify({id,title,body,agentId,url})` in
that key order. The bridge additionally binds selected channels in its
`requestHash`. The web result binds ID and payload hash and reports state,
configured, eligibleUsers, subscriptions, attempted, accepted, failed and unknown.
States are sending, complete, failed, unknown or skipped; disabled/unconfigured
delivery is explicit. Accepted means the provider accepted the request, not
observed display on a person's phone.

## Release and device limits

The introduction must remain held until the new native version is available to
public App Store users, the fresh-chat web route and history action are deployed
and verified, both backend operation doors are deployed and verified, and the
owner's reviewed copy is declared ready. Then create one intent journal and send
one operation with its frozen ID. An unknown POST outcome is a status-read task,
never permission to repeat the broadcast.

Current native registration metadata contains no app/build version. Older
installed iPhone clients do not understand `agent-chat`; their notification tap
opens the app generally. Public availability of a new build does not prove every
person installed it. The persistent web announcement action opens the verified
fresh Angel chat, including for accounts without push permission. One shared
announcement may reach a person's several subscribed devices; counts are per
registered target and must not be presented as distinct people receiving a banner.

Validation:

```sh
node --check announcements.js
node --check server.js
node --test announcements.test.js announcements.integration.test.js notify-data.test.js fcm.test.js test-seat-policy.test.js call-plan-push.test.js
```
