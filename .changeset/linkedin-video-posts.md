---
"@opencoredev/social-sdk": minor
---

Add LinkedIn video posts. `media.upload` now accepts one MP4 Blob (75 KB to 500 MB), uploads the parts LinkedIn returns, and finalizes the video without waiting for processing. The new native `videoStatus` helper reads the processing status once per call, and publishing creates a post only when the video is `AVAILABLE`. The native `registerVideo` method is deprecated and still throws `unsupported_capability`.
