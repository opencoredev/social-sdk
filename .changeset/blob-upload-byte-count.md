---
"@opencoredev/social-sdk": patch
---

Fix Blob media uploads that failed with "Storage accepted before the full declared upload was consumed." The uploader no longer opens and pre-reads the source stream when it sends a Blob body directly, so that unused read can no longer inflate the byte count. This affected Blob uploads through the Zernio and Post for Me backends, including Blob slices. Streamed uploads still fail when storage answers before it has read the whole body.
