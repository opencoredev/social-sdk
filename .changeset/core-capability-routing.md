---
"@opencoredev/social-sdk": minor
---

Normalized post reads, delivery reconciliation, media uploads, and scheduled publishing now use canonical authorization and dispatch operations. Existing capability aliases remain supported, while declared schedule restrictions are enforced before provider dispatch.

Migration: authorization policies that match operation names must use `posts.list` for list calls, `posts.get` for post reads, `posts.getDelivery` for delivery reconciliation, `media.upload` for media uploads, and `posts.schedule` for scheduled publishing. Capability manifests may continue declaring `posts.read` for normalized post reads and `posts.status` for delivery reconciliation during the compatibility period. Managed backends without a `posts.schedule` declaration continue to validate schedules in their adapter.
