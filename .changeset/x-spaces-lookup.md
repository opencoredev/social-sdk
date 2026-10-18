---
"@opencoredev/social-sdk": minor
---

Add native X Spaces lookup and search methods for single IDs, batches of IDs, creator IDs, and
live or scheduled keyword searches. Responses remain provider-shaped and preserve user and topic expansions;
the bounded Spaces search contract does not claim pagination or unsupported recording access.

Space field and expansion selectors match X OpenAPI 2.172. Request `creator_id`, `host_ids`, and
`speaker_ids` through `expansions`, rather than `spaceFields`.
