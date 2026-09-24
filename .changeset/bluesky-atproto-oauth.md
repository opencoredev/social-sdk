---
"@opencoredev/social-sdk": minor
---

Add AT Protocol OAuth for Bluesky to `@opencoredev/social-sdk/server`. `blueskyOAuth` works with `ConnectionManager` and handles handle and DID resolution, PDS and authorization server discovery, pushed authorization requests, PKCE, DPoP-bound tokens, the `iss` callback check, and identity verification. `blueskyOAuthTransport` turns a stored session into the Bluesky adapter's `session`, and `refreshBlueskyOAuthSession` refreshes it with rotated refresh tokens. `blueskyOAuthClientMetadata`, `blueskyOAuthPublicJwk`, `blueskyLoopbackClientId`, and `parseBlueskyOAuthSession` cover client metadata and stored sessions. No runtime dependencies are added.

`ConnectionManager.begin` and `ConnectionProvider.start` accept an optional `loginHint`. The attempt returned by `begin` no longer includes `providerState`; it stays in the connection store with the PKCE verifier. Read it from the store if your code relied on the returned value.
