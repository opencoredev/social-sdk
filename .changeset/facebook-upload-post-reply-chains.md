---
"@opencoredev/social-sdk": minor
---

Add a direct Facebook Pages adapter at `@opencoredev/social-sdk/facebook`. It publishes text and link posts, one or more photos, Page videos, and Reels (`options.reel`). It schedules natively within Meta's 10-minute to 30-day window and cancels scheduled posts. It also reads and deletes posts, reconciles video processing, reads, replies to, hides, and deletes comments, and reads post engagement, Page counts, and daily Page Insights reports. Verified `object: "page"` webhooks are decoded too. `discoverFacebookPages` lists the Pages a Facebook Login user can manage, with their Page access tokens.

Add an Upload-Post managed backend at `@opencoredev/social-sdk/cloud/upload-post`. It covers profile accounts, text, photo, video, and LinkedIn document publishing with URL or Blob media, scheduling, delivery status with native IDs from upload history, schedule cancellation, removal of published posts, and verification of timestamped webhook signatures.

Managed backends now publish replies where the provider documents them: Zernio on X (`replyToTweetId`), and Upload-Post on X and on Bluesky text posts (`reply_to_id`). Other managed destinations still reject publish-time replies with `reply.use_comments`. `publishSequence` with `replyToPrevious` now builds an independent reply chain for each destination account. A destination whose previous link did not publish gets a `not-submitted` outcome with issue `sequence.parent_unpublished` instead of failing the whole sequence before dispatch.

Requests these features previously rejected are now accepted. Accepted requests behave as before, so no migration is needed.
