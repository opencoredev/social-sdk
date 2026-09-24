---
"@opencoredev/social-sdk": patch
---

Uploads of streams without a declared size now fail with `invalid-response` when storage answers before the stream ends, instead of reporting a partial upload as complete. Bluesky preparation rejects document attachments, and LinkedIn rejects a video status read that returns a different video.
