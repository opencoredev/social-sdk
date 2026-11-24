---
"@opencoredev/social-sdk": patch
---

Threads text is measured in graphemes instead of UTF-16 code units, so an emoji, flag, keycap, skin-tone emoji, joined family emoji or accented letter each counts as one character against the 500 limit. 0.5.0 counted UTF-16 code units, so it rejected more than 250 "🙂", though a post of 400 has published on Threads. The `text.too_long` message now says the text is counted in graphemes.
