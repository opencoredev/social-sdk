---
"@opencoredev/social-sdk": minor
---

`posts.publish` accepts an opt-in `retry: { maxAttempts, maxDelayMs?, capacityDelayMs? }` option. Within the same call, it resends only targets that were provably not posted: `failed` outcomes with `retryDisposition` `after-delay` (such as a rate limit) and `not-submitted` outcomes with reason `capacity`. It waits the requested delay, reuses the same idempotency claim and per-target key, and saves only the final outcome. `maxAttempts` is 1 through 5. A wait longer than `maxDelayMs` (default 60 seconds) is not taken. `unknown` and other outcomes are never resent. Without `retry`, behavior is unchanged. The new types are `PublishOptions` and `PublishRetryPolicy`.
