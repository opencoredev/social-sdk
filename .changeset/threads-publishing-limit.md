---
"@opencoredev/social-sdk": minor
---

Add a Threads native publishing-limit read. `threads.native.publishingLimit` reads the authenticated profile's rolling 24-hour quota through Meta's `threads_publishing_limit` endpoint and preserves the documented quota envelope. The capability manifest records the `threads_basic` and `threads_content_publish` approval gate.
