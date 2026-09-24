---
"@opencoredev/social-sdk": minor
---

Add X video and GIF chunked upload to the direct adapter. MP4 video (up to 512 MiB) and GIF (up to 15 MiB) Blobs upload via 1 MiB INIT/APPEND/FINALIZE segments with a bounded STATUS poll honoring `check_after_secs`. Chunk rejections (413) and failed processing surface as terminal `media_error`. Processing waits never outlast the operation budget, and cancellation reports `cancelled`. A 403 when attaching a video reports `missing_permission` with a message that names the possible duration limit. `posts.publish` accepts a single video or GIF per post and advertises the `video` format, and the native module adds `uploadVideo` and `uploadGif`.
