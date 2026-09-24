---
"@opencoredev/social-sdk": minor
---

Add `posts.cancelScheduled` to the direct YouTube adapter. It reads the video, confirms it is private with a future `status.publishAt`, then calls `videos.update` with `part=status` to clear `publishAt` while resending the other status fields it read. The video stays uploaded and private and is not deleted, so the result is `{ state: "cancelled", backendRecord: "retained" }`. The call needs the `https://www.googleapis.com/auth/youtube` scope and costs 51 quota units. A lost or unconfirmed update raises `ambiguous_outcome` with `reconcile-first`.

Scheduled YouTube uploads now report the `scheduled` outcome with a `job` reference (the video ID) instead of `processing` or `published`, so a caller can pass it to `posts.cancelScheduled`. `getDelivery` reports `published` once the publish time has passed and the video is processed. Code that treated a scheduled YouTube upload's `published` state as success should check for `scheduled` too.
