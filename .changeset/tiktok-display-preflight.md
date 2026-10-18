---
"@opencoredev/social-sdk": minor
---

TikTok now declares the Content Posting API creator-info query as the required Direct Post preflight and exposes a bounded native Display API video query for up to 20 owned video IDs. Display video reads include the documented `embed_html`, `embed_link`, and `is_aigc` fields.

Migration: sanitize `embed_html` before rendering it. The preflight declaration describes the existing creator refresh before Direct Post initialization; inbox drafts continue to skip it. No Research API access is implied.
