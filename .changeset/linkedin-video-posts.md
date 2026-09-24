---
"@opencoredev/social-sdk": minor
---

Add LinkedIn video posts. `media.upload` now accepts one MP4 Blob (75 KB to 500 MB), uploads the parts LinkedIn returns, and finalizes the video without waiting for processing. The new native `videoStatus` helper reads the processing status once per call, and the opt-in native `waitForVideo` helper rereads it at a fixed interval, bounded by a check limit, the operation's elapsed budget, and its abort signal. Publishing reads the status once and creates a post only when the video is `AVAILABLE`; a video that is still processing returns a `failed` outcome with an `after-delay` retry disposition and no post. A non-blank attachment `caption` is sent as the optional video title. The native `registerVideo` method is deprecated and still throws `unsupported_capability`.
