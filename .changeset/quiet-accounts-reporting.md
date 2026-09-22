---
"@opencoredev/social-sdk": minor
---

Add the platform features that were missing for launch. X gains user lookup, follower and following lists, likes, mute and block, lists and pinned lists, timelines, mentions, app-only bearer tokens, and working direct messages through both `social.messages` and native access. Bluesky gains follower lists, likes, actor search, lists, moderation reports, unblock, and unmute. Threads gains normalized search, profile reads, and reply hiding. Instagram gains comment hiding and deletion and mentions on Instagram Login. YouTube gains playlist management, thumbnails, video updates and deletes, captions, subscriptions, search, and comment moderation. LinkedIn gains follower, page, and share statistics.

Every implemented operation is now declared `available`, with tier, review, and enterprise requirements listed in `requiredScopes` and `notes`, so apps that hold the platform access can call it. Also fixes graph wiring, X search fields, empty result handling, the X DM endpoint, OAuth account persistence, webhook signature case handling, `publishSequence` outcomes, input validation, and the mock backend.
