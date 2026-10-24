---
"@opencoredev/social-sdk": minor
---

Add canonical analytics metric names, normalized comment and message records, and cross-account inbox reads. Existing metric names remain available; unknown counters have no canonical name. Comment identities now use the reply-ready identifier, including Bluesky AT-URIs and LinkedIn comment URNs. Provider fields remain in `native`.

Add an optional application-owned media staging bridge for URL-only destinations, an in-memory bytes helper, and TikTok chunked FILE_UPLOAD for local videos. Capability constraints expose media limits, which local preparation and `social-sdk validate` check. Staging runs after authorization and idempotency checks; asynchronous and uncertain deliveries retain staged copies for application-owned expiry.

Correct Instagram inbox field requests and recipient lookup, X bookmark pagination, edit history and image alt text, Threads link attachments, YouTube category metadata, LinkedIn comment pagination, and Meta expired-token reconnect classification.

Migration: use normalized comment `id` when building a reply reference. LinkedIn's original numeric ID remains in `native.id`; its normalized `id` is the full comment URN. For staged media, configure storage expiry long enough for provider fetching and processing. No storage provider is required or bundled.
