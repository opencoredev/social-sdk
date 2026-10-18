---
"@opencoredev/social-sdk": minor
---

Capability declarations can now identify normalized versus native execution surfaces and carry structured eligibility, approval, scope, and media-source constraints. Managed backend manifests use these fields to describe provider/account gates without claiming that a live account is eligible.

Existing declarations remain compatible; `surface` and `constraints` are optional for adapters that have not adopted the richer metadata.
