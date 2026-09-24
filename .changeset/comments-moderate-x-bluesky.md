---
"@opencoredev/social-sdk": minor
---

Add native reply hiding for X and Bluesky, and declare `comments.moderate` for LinkedIn.

- X: `native.hideReply({ account, replyId, hidden, context })` calls `PUT /2/tweets/{id}/hidden` with a user-context token and returns the hidden state X reports.
- Bluesky: `native.hideReply({ account, replyUri, hidden, context })` adds or removes the reply in the root post's threadgate `hiddenReplies` list. It creates a threadgate without reply rules when none exists and updates an existing one with `swapRecord`.
- LinkedIn: `comments.moderate` is declared `unsupported-by-platform` because the Comments API has no hide operation.
