---
"@opencoredev/social-sdk": patch
---

Replies can now target another author's post on the acting account's backend and platform. The SDK still authorizes the acting account, and each adapter validates the parent post. Existing callers need no changes.
