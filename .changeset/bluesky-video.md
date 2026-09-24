---
"@opencoredev/social-sdk": minor
---

Add Bluesky video publishing. `media.upload` sends an MP4 to the Bluesky video service and returns a media reference that holds the processing job ID. The new `native.getVideoJobStatus` and `native.getVideoUploadLimits` operations read job state and daily limits, so the caller controls polling. `posts.publish` with the video reference reads the job once and writes an `app.bsky.embed.video` record when processing is complete. If the job is still processing, the target fails with `media_error` and no post is created. The new `pdsDid` and `videoService` options set the upload token audience and the video service origin.
