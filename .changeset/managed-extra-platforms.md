---
"@opencoredev/social-sdk": minor
---

Add `pinterest`, `reddit`, `mastodon`, `telegram`, `discord`, `google-business`, `snapchat`, `whatsapp`, and `twitch` to `KnownPlatform`, and stop the managed backends from silently dropping connected accounts on those networks. Zernio, Post for Me, PostFast, Postiz, and Buffer now list and read them, and publish to the ones each provider documents: Zernio (Pinterest, Reddit, Telegram, Discord, Google Business Profile, Snapchat), Post for Me (Pinterest), PostFast (Pinterest, Telegram, Google Business Profile), Postiz (Pinterest, Reddit, Mastodon, Telegram, Discord, Google Business Profile, Twitch), and Buffer (Pinterest, Mastodon, Google Business Profile). Provider aliases such as `twitter`, `gmb`, `googlebusiness`, and `google_business_profile` resolve to `x` and `google-business`. A new `unknownPlatforms: "include"` option lists accounts on any other network under the provider's own identifier, for reading; the default stays `"skip"`.

Also: Zernio account metrics now search every account page instead of the first. PostFast accepts a YouTube `isShort` option and still sends `false` when it is omitted. Postiz maps the TikTok inbox-draft `title`. Buffer publishes LinkedIn document assets from an HTTPS URL with a thumbnail and a caption or filename title.

An account on one of the new networks that `accounts.list` used to omit now appears in it.
