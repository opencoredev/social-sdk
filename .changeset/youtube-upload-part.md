---
"@opencoredev/social-sdk": patch
---

YouTube uploads work again. The resumable `videos.insert` request asked for the `processingDetails` part, which YouTube rejects with HTTP 400 `unexpectedPart`, so every YouTube publish failed before sending any bytes. The request now asks for `snippet,status`. Upload errors also name YouTube's reason, for example `YouTube upload request failed with HTTP 400 (unexpectedPart).` Existing callers need no changes.
