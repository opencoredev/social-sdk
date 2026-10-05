---
"@opencoredev/social-sdk": patch
---

Delivery reconciliation now rejects references with an unsupported kind or version before authorization or provider requests. Pass a delivery reference returned by the SDK when checking an outcome.
