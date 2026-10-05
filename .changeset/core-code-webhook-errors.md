---
"@opencoredev/social-sdk": patch
---

Zernio webhook decoding now reports a missing event ID as invalid input instead of an authentication failure. Handle this as a malformed delivery rather than a reason to change signing credentials.
