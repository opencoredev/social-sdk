---
"@opencoredev/social-sdk": patch
---

Close gaps between the 0.6.0 release notes and the code:

- Postiz delivery outcomes keep a published link only as an HTTPS URL without credentials, and a backend state that is not a plain token becomes `unrecognized`.
- Raw requests on managed backends (Zernio, Post for Me, PostFast, Postiz, Buffer) reject the `access_token`, `api_key` and `apikey` query parameters before any request.
- `CredentialManager.revoke` keeps the provider's HTTP status (`upstreamStatus`) when the revoke callback throws a `SocialError`.
- X media uploads map HTTP 402 to `billing_required` with no retry, including during media status checks, instead of `media_error`.
- Direct X replies accept a parent post written by another author on the same backend.
- Managed backends declare `accounts.read` for every listed account, so `social.accounts.get` reads accounts on networks the backend lists but cannot publish to, including those kept by `unknownPlatforms: "include"`.
