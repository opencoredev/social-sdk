---
"@opencoredev/social-sdk": minor
---

Writes are confirmed only by the provider's documented success answer, and errors keep provider text out.

- Every adapter (direct platforms, managed backends, the shared post lifecycle and TikTok token revocation) resolves a sent write only on the provider's documented success answer. Any other answer after the request was sent, such as `null`, an array, or a missing or wrong-type field, now throws `ambiguous_outcome` with `retryDisposition: { kind: "reconcile-first" }` instead of a definite failure. HTTP error statuses and checks made before sending keep their definite error codes. `revokeTikTokOAuthToken` returns `"revoked"` only for TikTok's empty success body (or `{}`).
- Errors and delivery outcomes no longer copy provider prose, request values, tokens or URLs. They keep only recognized machine codes and fixed SDK messages: an unknown Zernio error category becomes `upstream_failure`, a backend status that is not a plain token becomes `unrecognized`, and a published link is kept only as an HTTPS URL without credentials.
- Newly documented as not supported, each with a raw-request route: Buffer `editPost` asset, metadata and other non-text fields, and tag mutations; Postiz delete by group; X edits other than text; Bluesky starter pack edits and `chat.bsky.moderation.updateActorAccess`; Facebook Page Post update fields beyond the message, pin, hide, AI label and schedule, photo and video edits, and album creation; removing Instagram product tags; undoing a Threads repost; and the Zernio routes outside posting (inbox edits and reactions, pins, queue slots, uploads, app and key management, and its non-social products).
- Facebook `native.updatePost` accepts `scheduleAt`, sent as `scheduled_publish_time`, to reschedule a scheduled Page post.
