---
"@opencoredev/social-sdk": minor
---

TikTok publishing options now require explicit `aiGenerated` and `draft` booleans, matching the existing preparation checks.

Migration: Add both fields to every `TikTokPublishOptions` value. Take the choices from the creator preview, using `draft: false` for Direct Post or `draft: true` for inbox transfer.
