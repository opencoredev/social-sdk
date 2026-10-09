---
"@opencoredev/social-sdk": patch
---

Requests now work on Cloudflare Workers. The SDK sends `redirect: "manual"` instead of `redirect: "error"`, which workerd rejects, and still refuses redirects: a 301, 302, 303, 307 or 308 response fails the request as before. The one exception is YouTube resumable uploads, which now receive the provider's `308 Resume Incomplete` response (a 308 without a `Location` header) with the built-in `fetch` in Node.js and Bun. Existing callers need no changes; a custom `fetch` now sees `redirect: "manual"`.
