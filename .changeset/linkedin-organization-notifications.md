---
"@opencoredev/social-sdk": minor
---

Add `notifications.read` for LinkedIn organization accounts. `social.notifications.list` and `iterate` pull organization social-action notifications from `organizationalEntityNotifications` with offset paging. Member accounts declare the capability as `account-ineligible`, and `notifications.seen` is `unsupported-by-platform` because LinkedIn has no seen state.

X, Threads, Instagram, YouTube, and TikTok now declare `notifications.read` as `unsupported-by-platform` with a reason, since none of their official APIs offers a notifications feed. Calls still raise `unsupported_capability` as before.
