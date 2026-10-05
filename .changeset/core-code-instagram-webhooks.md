---
"@opencoredev/social-sdk": patch
---

Instagram Login comment and live-comment webhooks now normalize to `comment.received` when their fields appear directly on entries. Facebook Login's nested change format remains supported. Existing webhook handlers need no changes.
