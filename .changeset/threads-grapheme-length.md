---
"@opencoredev/social-sdk": patch
---

Threads text is now measured in graphemes, so preparation no longer rejects posts the Threads API accepts. The adapter used to count each emoji by its UTF-8 bytes, which reported `text.too_long` for more than 125 emoji. A flag, keycap, skin-tone emoji, joined family emoji or accented letter now each counts as one character against the 500 limit, and the `text.too_long` message says the text is counted in graphemes.
