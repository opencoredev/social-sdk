---
"@opencoredev/social-sdk": minor
---

LinkedIn replies now accept activity, share, and ugcPost comment references. A comments-collection 404 returns an empty page only after a fresh parent-post check confirms the post is still readable; a deleted post returns `not_found`. Capability declarations use author-specific social-feed and parent-post read permissions and identify unimplemented article, profile-edit, and partner messaging operations.

Organization reports keep total page-view keys unchanged and now return nested unique counts under dotted keys such as `allPageViews.uniquePageViews`. Custom-button click arrays and their dimensions are kept in `rawClicks`, also on breakdown rows. Reports forward supported report queries and reject unsupported filters. Image uploads validate size before initialization, honor the operation deadline and report expired uploads as `timeout`, and enforce single-image alt-text limits. Image-storage rate limits return `rate_limited` and preserve valid `Retry-After` delays without automatically retrying uploads.

Migration: Read nested unique page-view counts from the dotted keys (for example `allPageViews.uniquePageViews`) instead of the parent key. Use `DAY` or `MONTH` for page and share report intervals; `WEEK` remains supported for follower statistics. Grant member or organization social-feed permissions for comments (both feed read and write grants for replies), plus the separate post-read permission needed for the parent check.
