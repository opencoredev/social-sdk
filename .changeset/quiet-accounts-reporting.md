---
"@opencoredev/social-sdk": minor
---

Add the platform features that were missing for launch. X gains user lookup, follower and following lists, likes, mute and block, lists and pinned lists, timelines, mentions, app-only bearer tokens, and working direct messages through both `social.messages` and native access. Bluesky gains follower lists, likes, actor search, lists, moderation reports, unblock, and unmute. Threads gains normalized search, profile reads, and reply hiding. Instagram gains comment hiding and deletion. YouTube gains playlist management, thumbnails, video updates and deletes, captions, subscriptions, search, and comment moderation. LinkedIn gains follower, page, and share statistics.

Every implemented operation is now declared `available`, with tier, review, and enterprise requirements listed in `requiredScopes` and `notes`, so apps that hold the platform access can call it. Also fixes graph wiring, X search fields, empty result handling, the X DM endpoint, OAuth account persistence, webhook signature case handling, `publishSequence` outcomes, input validation, and the mock backend.

`posts.removeFromPlatform` now works on X, Bluesky, Threads, Instagram (Facebook Login), YouTube, and LinkedIn. YouTube videos can be scheduled with `publishAt`. Webhook docs now use `verifyZernioWebhook` and `verifyPostForMeWebhook`.

This release also fixes OAuth for X, TikTok, Instagram, and LinkedIn, Threads container publishing and replies, TikTok publishing states and video listing, YouTube chunked uploads and upload deadlines, Bluesky request headers and facets, X DM fields and follow authorization, Instagram delivery tracking and metrics, cloud backend pagination and analytics, rate-limit handling in the transport, and adapter error mapping in the client. `publishSequence` now checks every item before it starts, requires an `idempotencyKey`, reports thrown item errors with their index in `failures`, and stops a `replyToPrevious` chain when a parent was not published. Package builds now run on `prepack`, and the release workflow checks the built package before it publishes.

Some features are now declared `not-implemented-by-adapter` because the adapter could not do them correctly: Bluesky video, X video and GIF uploads and filtered streams, LinkedIn multi-image, video, and document posts, and deletion and mentions on Instagram Login.
