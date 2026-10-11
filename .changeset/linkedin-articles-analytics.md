---
"@opencoredev/social-sdk": minor
---

LinkedIn now publishes Posts API article links from `content.link` with explicit HTTPS source,
title, and description metadata. The direct adapter also declares native image, video, and document
status reads and exposes organization follower, page, share, and follower-count analytics with the
configured author and API-version headers preserved.

Migration: provide `link.title` and `link.description` for LinkedIn article posts. LinkedIn does
not scrape article URLs, and the generic link contract does not currently accept thumbnail URNs.
