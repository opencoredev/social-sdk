---
"@opencoredev/social-sdk": minor
---

Raw provider requests on every adapter.

- Add `native.request` to every adapter for provider endpoints the SDK does not wrap: X, Bluesky, Facebook, Instagram, Threads, LinkedIn, TikTok, YouTube, Post for Me, PostFast, Postiz and Buffer, plus `zernioNative(options).request` for Zernio. It sends one request to a path below one of the adapter's named hosts with the adapter's own credentials, account check, error mapping, elapsed budget and cancellation, and returns the status, selected headers and a JSON, text or bytes body. Absolute URLs, `//` and dot segments, credential headers and query parameters are rejected before any request, and redirects are not followed. Raw requests never retry, add idempotency keys or reconcile writes; a write without a definitive answer rejects with `ambiguous_outcome`. Each adapter declares the `raw.request` capability.
- Raw requests on Facebook, Instagram and Threads reject a `method` query parameter (Graph's method override), so a write sent as `GET ?method=delete` cannot lose its uncertain-outcome classification; send the real HTTP method instead.
- On Facebook and Instagram, a raw write that asks for `fields` (Graph read-after-write) and fails with a 4xx other than 401, 403, 429 or error code 190 rejects with `ambiguous_outcome` and `reconcile-first`, because Graph may have applied the write before the read-back failed.
- Bluesky raw requests honor the adapter's `timeoutMs`, and the docs now say a configured OAuth session may replay an explicit DPoP nonce challenge or refresh its credentials even though the raw layer never retries.
