---
"@opencoredev/social-sdk": patch
---

Declare X `posts.schedule` as `not-implemented-by-adapter` and `profile.update` as `unsupported-by-platform` in the X capability manifest. The notes cite the X docs: X API v2 has no scheduling or profile write endpoint, and X Ads API scheduled Tweets require OAuth 1.0a, which this OAuth 2.0 adapter does not implement. The preparation message for a scheduled X target now says that X API v2 cannot schedule posts.
