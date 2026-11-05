---
"@opencoredev/social-sdk": minor
---

Core and server groundwork for the provider features in this release.

- Typed per-platform publish option types (`ThreadItemOption`, `GeoRestrictionOption`, `RecyclingOption`, managed media item options and more), exported from the package root as types only.
- OAuth token sets and persisted credentials keep `refreshExpiresAt` when the provider reports a refresh-token lifetime, and a refresh that returns no new refresh token keeps the current one.
- OAuth helpers: TikTok QR-code login (`createTikTokQrCode`, `checkTikTokQrCode`, `exchangeTikTokQrCode`), token revocation for TikTok, Google and X, X OAuth 1.0a token exchange, and LinkedIn token introspection. New authorization options include `tiktokLoginKit`, `includeGrantedScopes`, `forceReauth`, `disableAutoAuth` and `enableFacebookLogin`.
- Normalized webhook events cover more provider events, including message reads, reactions, postbacks and referrals, conversation control changes, comment updates and removals, account permission changes and rate limits.
- Persisted publish attempts keep provider post IDs on accepted work and preparation issues on results.
- Uploads accept a POST method and extra provider headers for form uploads, and WebVTT caption files.
