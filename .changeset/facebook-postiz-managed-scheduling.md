---
"@opencoredev/social-sdk": patch
---

Fix Facebook, Postiz, Buffer, and managed scheduling gaps.

- Facebook `cancelScheduled` reads the post or video first and deletes it only while Graph reports it unpublished with a future `scheduled_publish_time`. A due or published item now fails with `invalid_input` instead of being deleted.
- Facebook feed, video (`graph-video.facebook.com`), and Reels upload requests report an expired Page token (Graph code 190) as `reconnect_required` with retry disposition `after-reconnect`.
- A Facebook Reel that fails after Facebook created it returns an outcome with its delivery reference: `unknown` for timeouts and unclear results, otherwise `failed` with `reconcile-first`. `native.publishReel` returns that outcome instead of throwing. A malformed or foreign Reels upload URL is handled the same way.
- A Facebook multi-photo post that fails definitely, during an upload or when Facebook refuses the final post, deletes the unpublished photos it uploaded. An ambiguous final request keeps them and reports the target as `unknown`.
- Postiz Reddit posts take one attachment, and an MP4 needs a `thumbnail` at a public HTTPS image URL, sent as the video poster. Reddit no longer advertises `carousel`. Postiz Twitch targets reject media and text over 500 characters.
- Zernio, Post for Me, PostFast, Postiz, Buffer, and Upload-Post declare `posts.schedule`, so `SocialScheduler` hands their routes to the provider. PostFast now works under `SocialScheduler`.
- Buffer advertises `document` for LinkedIn.
