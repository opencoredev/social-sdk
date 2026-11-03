---
"@opencoredev/social-sdk": minor
---

Add a direct Facebook Pages adapter at `@opencoredev/social-sdk/facebook`. It publishes text and link posts, one or more photos, Page videos, and Reels (`options.reel`). It schedules natively within Meta's 10-minute to 30-day window and cancels scheduled posts. It also reads and deletes posts, reconciles video processing, reads, replies to, hides, and deletes comments, and reads post engagement, Page counts, and daily Page Insights reports. Verified `object: "page"` webhooks are decoded too. `discoverFacebookPages` lists the Pages a Facebook Login user can manage, with their Page access tokens.

Managed backends now publish replies where the provider documents them, starting with Zernio on X (`replyToTweetId`). Other managed destinations still reject publish-time replies with `reply.use_comments`. `publishSequence` with `replyToPrevious` now builds an independent reply chain for each destination account. A destination whose previous link did not publish gets a `not-submitted` outcome with issue `sequence.parent_unpublished` instead of failing the whole sequence before dispatch. Items after the first that reply on several accounts send one request per account under `${idempotencyKey}:n:${destination}`, so replaying a sequence after reconciling one chain continues it instead of failing with `idempotency_conflict`; single-destination chains keep `${idempotencyKey}:n`.

Requests these features previously rejected are now accepted. Accepted requests behave as before, so no migration is needed.
