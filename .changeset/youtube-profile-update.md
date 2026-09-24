---
"@opencoredev/social-sdk": minor
---

Add `profile.update` for YouTube through `native.updateProfile`, which writes a channel's `brandingSettings.channel` fields or `localizations` with `channels.update`. The adapter reads the current part first and merges your fields, because YouTube deletes omitted properties; a `null` field removes a property or localization.

Declare `profile.update` for the other direct adapters: `unsupported-by-platform` for X, Threads, Instagram, and TikTok, which have no documented profile write, and `approval-dependent` for LinkedIn, whose Profile Edit API is limited to approved developers and is not implemented.
