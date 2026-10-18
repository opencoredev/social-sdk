---
"@opencoredev/social-sdk": minor
---

Add guarded native YouTube access for live chat messages, moderators, and bans, plus channel sections and channel activity reads. Message deletion avoids a chat polling preflight and relies on provider authorization. Message lists validate the documented 200–2000 page-size range, and message inserts request only the supported snippet part. Ban deletion relies on YouTube's provider authorization because the API exposes no ban lookup endpoint.
