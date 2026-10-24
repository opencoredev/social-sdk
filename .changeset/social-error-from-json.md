---
"@opencoredev/social-sdk": minor
---

Add `SocialError.fromJSON()` to rebuild a `SocialError` from `toJSON()` output, directly or after a JSON round trip, such as an error passed back from a queue worker or background job. It restores the code, operation, message, retry disposition, and every optional field, and throws `invalid_input` for anything that is not a serialized `SocialError`.
