# X Spaces contract evidence

- **Provider:** X API v2
- **API revision:** OpenAPI 2.170
- **Source:** [X OpenAPI](https://docs.x.com/openapi.json) and [Spaces lookup documentation](https://docs.x.com/x-api/spaces/lookup/introduction)
- **Checked:** 2026-10-11
- **Covered endpoints:** `GET /2/spaces/:id`, `GET /2/spaces`, `GET /2/spaces/by/creator_ids`, and `GET /2/spaces/search`
- **Search pagination:** The OpenAPI search contract exposes bounded `max_results` (1–100) and no pagination token; the SDK intentionally does not advertise `cursor` or `nextCursor` for Space search.
- **Offline evidence:** `packages/social-sdk/tests/x-messages.test.ts` uses deterministic fixtures for object-shaped single lookup, collection reads, search, and mixed `data` plus `errors` responses. No live X request was made.
- **Unsupported:** Recordings are not implemented because this revision does not define a stable recordings endpoint or response contract.
