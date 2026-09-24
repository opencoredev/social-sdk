---
"@opencoredev/social-sdk": minor
---

Add LinkedIn multi-image posts to the direct adapter. `posts.publish` now accepts 2 to 20 uploaded image references and sends them as Posts API `multiImage` content, with optional per-image alt text. Preparation rejects more than 20 images and multi-image alt text over 4,086 characters. Before the post is created, every image is checked for author ownership and `AVAILABLE` status, and no post is created if any check fails. A single image still uses `content.media`. The `posts.multi-image` capability is now `available`, and `posts.publish` advertises the `carousel` format.
