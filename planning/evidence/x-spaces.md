# X Spaces contract evidence

- **Provider:** X API v2
- **API revision:** OpenAPI 2.172
- **Source:** [X OpenAPI](https://docs.x.com/openapi.json) and [Spaces lookup documentation](https://docs.x.com/x-api/spaces/lookup/introduction)
- **Checked:** 2026-10-18
- **Covered endpoints:** `GET /2/spaces/:id`, `GET /2/spaces`, `GET /2/spaces/by/creator_ids`, and `GET /2/spaces/search`
- **Search pagination:** The OpenAPI search contract exposes bounded `max_results` (1–100) and no pagination token; the SDK intentionally does not advertise `cursor` or `nextCursor` for Space search.
- **Selectors:** `XSpaceField` and `XSpaceExpansion` follow `components.parameters.SpaceFieldsParameter.schema.items.enum` and `SpaceExpansionsParameter.schema.items.enum`. All 12 fields and five expansions are supported, including `subscriber_count`, `invited_user_ids`, and `topic_ids`: the four endpoint contracts permit both user-context OAuth and app bearer tokens, and the adapter preserves provider-shaped Space data and expanded users/topics. Provider access still determines which data is returned. `packages/social-sdk/type-tests/x-spaces.ts` checks the exact selector unions and rejects user-ID expansions as fields.
- **Offline evidence:** `packages/social-sdk/tests/x-messages.test.ts` uses deterministic fixtures for object-shaped single lookup, collection reads, search, and mixed `data` plus `errors` responses. Both user-token and app-bearer fixtures check every selector on all four endpoints and preserve subscriber counts and expanded topics. No live X request was made.
- **Unsupported:** Recordings are not implemented because this revision does not define a stable recordings endpoint or response contract.
