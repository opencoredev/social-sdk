---
"@opencoredev/social-sdk": minor
---

Add a PostFast managed backend at `@opencoredev/social-sdk/cloud/postfast`. It lists connected accounts, uploads media, schedules posts, reads delivery state, cancels scheduled posts, deletes failed records, reads post analytics, and creates connect links through `native.createConnectLink`. PostFast only accepts scheduled posts, so every target needs a future `schedule`. The offline CLI diagnostics recognize the `postfast` adapter and `POSTFAST_API_KEY`.
