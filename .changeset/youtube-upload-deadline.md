---
"@opencoredev/social-sdk": patch
---

YouTube upload deadlines are now fixed when each call starts. Before, the deadline was cached on the options object, so reusing the same options for a later upload, query, or resume could inherit an expired deadline and fail with `timeout` before sending anything. One `posts.publish` or `resumeUpload` still shares a single deadline across its begin, query, and send steps. The adapter's `clock` option now also drives those upload deadlines.
