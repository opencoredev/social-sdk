---
"@opencoredev/social-sdk": patch
---

When an operation runs out of its elapsed request budget after it has already sent a write, the `timeout` error now carries `retryDisposition: { kind: "reconcile-first" }` instead of `never`, because the earlier write may have taken effect. This applies to the managed backends (Zernio, Post for Me, PostFast, Postiz, Buffer mutations) and to LinkedIn, Bluesky, and YouTube upload requests. Budget exhaustion before any write still reports `never`, except that an expired YouTube upload deadline always reports `reconcile-first`. A LinkedIn image, document, or video byte transfer that times out while it is sending also still reports `timeout` with `never`: no post exists yet, so upload the media again. `posts.publish` outcomes are unchanged: a timeout there was already reported as `unknown`.
