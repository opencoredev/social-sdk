---
"@opencoredev/social-sdk": minor
---

Add `comments.list` to the direct X adapter. It lists replies to a post through recent search with `conversation_id:<postId>`, pages with X's `next_token`, and drops the root post. X recent search limits apply: replies from the last 7 days only, page limits from 10 through 100, and a user token with `tweet.read` and `users.read` or an app bearer token. The X capability manifest now declares `comments.read`.
