---
"@opencoredev/social-sdk": patch
---

Direct YouTube adapter uploads work again. The resumable `videos.insert` request asked for the `processingDetails` part, which YouTube rejects with HTTP 400 `unexpectedPart`, so every YouTube publish failed before sending any bytes. The request now asks for `snippet,status` by default and adds `recordingDetails` or `localizations` when the upload supplies them. Upload errors also name YouTube's reason when it is a plain token, for example `YouTube upload request failed with HTTP 400 (unexpectedPart).` Existing callers need no changes.
