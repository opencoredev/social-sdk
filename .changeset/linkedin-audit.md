---
"@opencoredev/social-sdk": minor
---

LinkedIn replies now accept activity, share, and ugcPost comment references. A documented comments-collection 404 returns an empty page after a successful parent-post check. Capability declarations use author-specific social-feed and parent-post read permissions and identify unimplemented article, profile-edit, and partner messaging operations.

Organization reports keep total page-view keys unchanged and now return nested unique counts under dotted keys such as `allPageViews.uniquePageViews`. Custom-button click arrays and their dimensions are kept in `rawClicks`, also on breakdown rows. Reports forward supported report queries and reject unsupported filters. Image uploads validate size before initialization, honor the operation deadline, and enforce single-image alt-text limits.

Migration: Read nested unique page-view counts from the dotted keys (for example `allPageViews.uniquePageViews`) instead of the parent key. Use `DAY` or `MONTH` for page and share report intervals; `WEEK` remains supported for follower statistics. Grant member or organization social-feed permissions for comments (both feed read and write grants for replies), plus the separate post-read permission needed for the parent check.
