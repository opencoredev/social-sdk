---
"@opencoredev/social-sdk": patch
---

The YouTube capability manifest now lists `https://www.googleapis.com/auth/youtube.readonly` alongside `https://www.googleapis.com/auth/yt-analytics.readonly` for `analytics.report.read`, `analytics.youtube.read` and `analytics.groups`, because Google requires `reports.query` and `groupItems.list` requests to have access to `youtube.readonly`. The `youtubeOAuth` TSDoc and the authentication guide explain that `scopes` replaces the defaults and show the list to pass for `social.analytics.getReport`. Default OAuth scopes and the public API are unchanged.
