---
"@opencoredev/social-sdk": minor
---

Bluesky now enforces the 2,000,000-byte image limit, preserves declared image types and dimensions, validates quote and reply text, and retains balanced parentheses in links. Quote validation errors identify the quote operation. Author feeds preserve nested quotes and supported nested embeds, facets, labels, reply references, and repost information while omitting fields outside the public allowlist. List edits check the version read before writing and clear obsolete annotations when descriptions change. Connection checks now use authenticated account status, and native reads default to one attempt.

OAuth requests now require an egress policy and an address-pinned transport. Nonce challenge inspection has a timeout and observes caller cancellation while preserving the original response. Authenticated account reads retain the handle verified in the OAuth session. Nonce failures retain response evidence for reconciliation, and failed session saves trigger one best-effort revocation. The guide explains saved connections, video, chat, lists, deletion, and notifications, including the transitional chat scope dependency.

Migration: Supply both `assertEgressAllowed` and an address-pinned `fetch` for connection, refresh, and resource requests. Use canonical OAuth URL authorities without explicit default HTTPS ports; hostname case and non-default redirect ports remain supported. Replace explicit link cards with URLs in post text. Set retry limits explicitly when native reads need more than one attempt.
