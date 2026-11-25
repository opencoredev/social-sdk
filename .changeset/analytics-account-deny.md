---
"@opencoredev/social-sdk": patch
---

`analytics.getAccountMetrics` no longer falls back to `analytics.read` when the authorization policy denies `analytics.account.read`. The fallback now applies only when the policy returns no decision for the account under `analytics.account.read`; an explicit `allowed: false` rejects the call with `unauthorized` before any request is sent.
