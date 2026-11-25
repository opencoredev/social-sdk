---
"@opencoredev/social-sdk": minor
---

`answerYouTubeWebhookChallenge` now verifies a hub request against the subscribe and unsubscribe requests the application has pending, matching both topic and mode. Before, any listed topic was confirmed for either mode, so an unsubscribe nobody requested could be confirmed. Requests that match no pending intent are refused with `not_found` (HTTP 404).

**Breaking change.** The `topics` option is replaced by `pending`, a list of `{ topic, mode }` entries.

Migration: record each request you send to the hub, and pass the ones still awaiting verification:

```ts
// Before
answerYouTubeWebhookChallenge({ query, topics: [topic] });

// After
answerYouTubeWebhookChallenge({ query, pending: [{ topic, mode: "subscribe" }] });
```

List an unsubscribe only while you have one in flight, and drop each entry once the hub has verified it.
