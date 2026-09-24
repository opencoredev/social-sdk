---
"@opencoredev/social-sdk": patch
---

Decode provider responses and publish options as JSON at the adapter boundary instead of casting them.

- `YouTubeNative.resumeUpload` and `queryUpload` now return `Promise<YouTubeUploadStatus>`, and `YouTubeUploadStatus.video` is a `JsonObject`.
- `stableSerialize` and `fingerprint` are generic over their input instead of taking `unknown`. Existing calls compile unchanged.
- Native publish options that are not JSON (functions, symbols, bigints or cycles) are rejected with an `invalid-response` error instead of being passed through.
- LinkedIn `organizationAnalytics` throws `invalid-response` on an empty upstream body instead of returning `null`.
- Threads `comments.list` skips entries that are not objects.
