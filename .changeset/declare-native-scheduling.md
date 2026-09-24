---
"@opencoredev/social-sdk": patch
---

Declare `posts.schedule` in the X, Threads, Bluesky, Instagram, TikTok and LinkedIn capability manifests. None of these publishing APIs holds a post for later publication, so the direct adapters keep rejecting `schedule` during preparation. X is marked `not-implemented-by-adapter` because its only scheduler is the separate Ads API; the others are `unsupported-by-platform`. Behavior is unchanged.
