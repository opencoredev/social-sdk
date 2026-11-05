---
"@opencoredev/social-sdk": minor
---

YouTube resource writes (playlists, playlist items, subscriptions, channel sections, live broadcasts and streams, live chat messages, moderators and bans, captions, playlist images, comment threads, comment replies, Analytics groups and group items, and Reporting jobs) now reject a success response without a non-empty string `id` with `ambiguous_outcome` and `reconcile-first`; `native.playlists` writes and reads the `localizations` part (with `snippet.defaultLanguage` required) and accepts `parts` for lists; and LinkedIn `comments.reply` reports `ambiguous_outcome` instead of `upstream_failure` when the sent reply's response is not an object or lacks a valid comment URN.
