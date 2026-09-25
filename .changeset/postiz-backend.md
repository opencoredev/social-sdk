---
"@opencoredev/social-sdk": minor
---

Add a Postiz managed backend at `@opencoredev/social-sdk/cloud/postiz`. It works with Postiz Cloud and with self-hosted instances through `baseUrl`. It lists connected channels, uploads media, publishes now or on a schedule, reads delivery state, cancels scheduled posts, deletes failed or draft records, reads post analytics, and creates connect links through `native.createConnectLink`. `postizAuthorizationUrl` and `exchangePostizCode` let your server connect other people's Postiz workspaces through your own Postiz OAuth app; the returned `pos_` token is used as the adapter's `apiKey`. The offline CLI diagnostics recognize the `postiz` adapter and `POSTIZ_API_KEY`.
