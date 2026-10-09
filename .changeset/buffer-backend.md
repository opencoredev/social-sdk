---
"@opencoredev/social-sdk": minor
---

Add a Buffer managed backend at `@opencoredev/social-sdk/cloud/buffer`. It authenticates with a personal API key or an OAuth access token, lists connected channels, publishes now or at a custom time through Buffer's GraphQL API, reads posts and delivery status, cancels a future scheduled post, deletes draft or failed Buffer records, and reads post metrics after a post is sent. Media must already be a public HTTPS URL; Buffer has no upload endpoint. `bufferAuthorizationUrl`, `createBufferPkce`, `exchangeBufferCode`, and `refreshBufferToken` cover Buffer's authorization-code flow with required PKCE. The offline CLI diagnostics recognize the `buffer` adapter and `BUFFER_API_KEY`.
