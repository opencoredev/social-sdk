---
"@opencoredev/social-sdk": patch
---

Bound the Pinterest adapter's memory use. `MemoryPinterestWorkflowStore` now takes `maxWorkflows` (default 1,000) and `retentionMs` (default 24 hours): at the cap a new video Pin fails before its file is uploaded, and `published` or `failed` workflows are removed once the retention window has passed since they settled. Workflows still `processing` or `creating` are never removed. With `imageBase64: true`, the new `maxBase64Bytes` option (default 50 MB) limits the total Blob bytes in one Pin; preparation checks it from `Blob.size` before reading any Blob and reports `pinterest.image_size`, and images are encoded one at a time.
