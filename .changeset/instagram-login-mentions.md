---
"@opencoredev/social-sdk": minor
---

Instagram `mentions.read` now works with Instagram Login. `listMentions`, `mentions`, and `listTaggedMedia` read `GET /{ig-user-id}/tags` on `graph.instagram.com` with `instagram_business_basic` and `instagram_business_manage_comments`, and the capability manifest declares `mentions.read` as available for both login flavors. `mentionedMedia` and `mentionedComment` still require Facebook Login and now raise a clearer `unsupported_capability` error with Instagram Login.
