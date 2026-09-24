---
"@opencoredev/social-sdk": minor
---

Verify and decode webhooks sent directly by Instagram, Threads, X, YouTube, and TikTok. `@opencoredev/social-sdk/server` adds `verifyMetaWebhook`, `verifyXWebhook`, `verifyYouTubeWebhook`, and `verifyTikTokWebhook` for signed POST deliveries, `answerMetaWebhookChallenge`, `answerXWebhookChallenge`, and `answerYouTubeWebhookChallenge` for the GET handshakes, and `decodePlatformWebhook` for normalized events. The five direct adapters accept a `webhookSecret` option and declare `webhooks.verify`. `VerifiedWebhook.signedTimestamp` is now a `boolean` and may include `signedAt`, and `SocialEvent.provider` includes the direct platform names.
