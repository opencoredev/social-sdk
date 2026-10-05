---
"@opencoredev/social-sdk": patch
---

Instagram OAuth now accepts granted permissions as either comma-separated text or an array and keeps those permissions when long-lived token exchange omits them. Existing connection code needs no changes.
