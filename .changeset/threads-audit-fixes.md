---
"@opencoredev/social-sdk": patch
---

Threads now uses correct reply IDs and pagination, requests supported post metrics, and reports account clicks from link totals. Carousels accept up to twenty items, videos accept MOV, and text validation counts emoji as UTF-8 bytes. Reply permission declarations now include the publishing scope. Grant `threads_content_publish` alongside `threads_basic` when sending replies.
