---
"@opencoredev/social-sdk": patch
---

TikTok now preserves HTTP 429 and validated provider codes, caps rate-limit delays, and never automatically repeats publishing requests. Rejection bodies are byte-limited and cancelled when oversized or interrupted; a stalled body keeps an already-received HTTP 429 rejection. Structured rate-limit responses honor valid Retry-After headers within the same delay cap. Cancelling a read during its retry wait preserves the cancellation result. Branded Direct Posts reject private visibility, photo posts honor refreshed comment restrictions, missing field scopes produce permission errors, and metrics fail when the requested video is absent.

The guide clarifies creator previews, drafts, scopes, media transfer, and delivery status. Use fresh creator choices and inspect per-destination outcomes before retrying uncertain submissions.
