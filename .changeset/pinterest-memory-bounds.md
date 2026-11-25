---
"@opencoredev/social-sdk": patch
---

Bound the Pinterest adapter's memory use. `MemoryPinterestWorkflowStore` now takes `maxWorkflows` (default 1,000), `retentionMs` (default 24 hours) and an optional monotonic `now` clock: at the cap a new video Pin fails before its file is uploaded, and a settled workflow (`failed`, or `published` with its Pin ID) is removed by the first `create` or lookup after the retention window. Workflows still `processing` or `creating`, and claimed rows, are never removed. With `imageBase64: true`, the new `maxBase64Bytes` option (default 50 MB) limits the total Blob bytes in one Pin; preparation checks it from `Blob.size` before reading any Blob and reports `pinterest.image_size`, and images are encoded one at a time. Each limit must be a safe integer in range, or the constructor throws `invalid_config`.
