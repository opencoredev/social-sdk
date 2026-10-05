---
"@opencoredev/social-sdk": minor
---

X graph, deletion, and native engagement writes now require provider confirmation before reporting completion. Pending follows and malformed or unconfirmed responses require reconciliation before another attempt.

Migration: Inspect confirmation flags on native write responses. Reconcile pending or unconfirmed results with X before retrying instead of assuming the write completed.
