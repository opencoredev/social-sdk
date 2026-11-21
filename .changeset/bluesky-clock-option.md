---
"@opencoredev/social-sdk": minor
---

`bluesky()` accepts a `clock` option, matching the X, YouTube, TikTok, and managed adapters. It sets record `createdAt` timestamps, service-token expiry, and video-token refresh, so tests can drive them deterministically. Record keys (TIDs) still use the system clock so they stay unique. TikTok's handling of an HTTP-date `Retry-After` now also measures against its `clock` option.
