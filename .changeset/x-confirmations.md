---
"@opencoredev/social-sdk": minor
---

X graph, deletion, and native engagement writes now require provider confirmation before reporting completion. Pending follows and malformed or unconfirmed responses require reconciliation before another attempt.

Migration: Catch `SocialError` with code `ambiguous_outcome` and retry disposition `reconcile-first` for pending or unconfirmed native writes. Check the current state in X before retrying instead of assuming the write completed.
