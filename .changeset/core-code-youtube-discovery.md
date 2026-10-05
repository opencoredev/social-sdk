---
"@opencoredev/social-sdk": patch
---

YouTube OAuth account discovery now reads all channel pages, requesting up to 50 channels per page. Repeated page tokens and traversal beyond 100 pages fail instead of returning an incomplete account picker. Pass the optional OAuth `signal` to cancel token requests and discovery; existing callers need no changes.
