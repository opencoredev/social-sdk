---
"@opencoredev/social-sdk": patch
---

YouTube now checks comment-reply and video-deletion ownership, uses correct playlist update IDs and parts, and sends supported video, subscription, and live-broadcast fields. Caption replacement and downloads are bounded, resumed uploads and status checks honor the operation deadline, descriptions reject angle brackets, and channel upload caps return quota errors.

Video updates support writable snippet and status fields. Set optional fields to `null` to clear them while keeping title and categoryId present. Playlist writes replace only supplied parts. The guide includes OAuth setup, operation scopes, quota rules, and complete native examples.
