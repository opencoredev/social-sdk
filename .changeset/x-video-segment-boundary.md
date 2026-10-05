---
"@opencoredev/social-sdk": patch
---

X video and GIF uploads now use 4 MiB segments. This keeps the full 16 GiB local video limit within X's APPEND segment range. Existing callers need no changes; account-specific attachment size and duration limits still apply.
