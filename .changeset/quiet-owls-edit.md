---
"@opencoredev/social-sdk": minor
---

Add `updatePost` to the X native module. It edits the text of a recent post through `POST /2/tweets` with `edit_options.previous_post_id` and returns a reference to the new version, since X assigns each edit a new post ID. A response without a new ID, or a server failure after dispatch, raises `ambiguous_outcome` with `reconcile-first`. The X manifest now declares `posts.update` as available. Threads, Bluesky, Instagram, and TikTok declare `posts.update` as `unsupported-by-platform`, with the documented reason in each manifest entry.
