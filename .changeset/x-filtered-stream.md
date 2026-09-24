---
"@opencoredev/social-sdk": minor
---

Add X filtered stream support. The X native module now exposes `stream`, an async iterable over `GET /2/tweets/search/stream` that opens one connection per iteration, stops on `break` or `context.signal`, raises `timeout` when no data or keep-alive arrives within `stallTimeoutMs`, and never reconnects on its own. `listStreamRules`, `addStreamRules`, and `deleteStreamRules` manage filtered-stream rules, with `dryRun` support and per-rule errors preserved. All four use the app-only `appBearerToken`. The `streams.read` capability for X is now `available`.
