---
"@opencoredev/social-sdk": minor
---

Managed backends now reject requests that could publish with unintended privacy, use expired media, or lose delivery information. PostFast rejects private TikTok Direct Posts, keeps explicit interaction and disclosure choices, selects ordinary YouTube videos, and limits schedules to one year. Zernio protects post retries with the provider's idempotency key, preserves duplicate-create delivery references through the public publishing facade, reports destination-specific cancellation and publication times, and requires reconciliation for unconfirmed comment or message writes.

Post for Me checks account ownership before reporting pending delivery, retains public feed media, and reads X reposts and Facebook reactions and views correctly. Its uploaded media expires after 24 hours and can be submitted only once. Postiz keeps confirmed acceptance when a status read fails and rejects unsupported image types, storage paths, and custom thumbnails.

Migration: Discard older persisted Post for Me uploads and upload fresh media for each submission; caller-owned HTTPS URLs remain reusable. Custom media stores must implement `claimSingleUse(mediaId, claimedAt)` as a durable atomic operation that rejects expired or consumed records and saves consumption before dispatch across all processes sharing the store. Use supported Postiz assets instead of AVIF, BMP, TIFF, or custom thumbnails, or choose another backend.
