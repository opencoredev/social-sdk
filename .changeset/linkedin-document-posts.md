---
"@opencoredev/social-sdk": minor
---

Add LinkedIn document posts. `social.media.upload` now accepts a `document` attachment (PDF, PPT, PPTX, DOC or DOCX, up to 100 MB) for the LinkedIn adapter and uploads it through the Documents API. A publish request with one uploaded document creates a document post after the adapter confirms the document is owned by the configured author and `AVAILABLE`. The title comes from the attachment `caption` or `filename`. The LinkedIn native module adds `documentStatus`, which returns `id`, `owner` and `status` without the signed download URL. `posts.document` is now `available` in the LinkedIn manifest.

`MediaAttachment.kind` and the capability `formats` union gain `"document"`. Code that switches exhaustively on `MediaAttachment["kind"]` needs a `document` branch. Other adapters reject document attachments.
