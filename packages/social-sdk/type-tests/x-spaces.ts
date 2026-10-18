import type { XSpaceExpansion, XSpaceField } from "../src/platforms/x.js";

// X OpenAPI 2.172: components.parameters.SpaceFieldsParameter.schema.items.enum.
const fields = {
  created_at: true,
  ended_at: true,
  id: true,
  is_ticketed: true,
  lang: true,
  participant_count: true,
  scheduled_start: true,
  started_at: true,
  state: true,
  subscriber_count: true,
  title: true,
  updated_at: true,
} satisfies Record<XSpaceField, true>;

// X OpenAPI 2.172: components.parameters.SpaceExpansionsParameter.schema.items.enum.
const expansions = {
  creator_id: true,
  host_ids: true,
  invited_user_ids: true,
  speaker_ids: true,
  topic_ids: true,
} satisfies Record<XSpaceExpansion, true>;

// @ts-expect-error Creator IDs belong in expansions, not space.fields.
const creatorField: XSpaceField = "creator_id";

// @ts-expect-error Host IDs belong in expansions, not space.fields.
const hostField: XSpaceField = "host_ids";

// @ts-expect-error Speaker IDs belong in expansions, not space.fields.
const speakerField: XSpaceField = "speaker_ids";

// @ts-expect-error Space fields cannot be used as expansions.
const titleExpansion: XSpaceExpansion = "title";

void [fields, expansions, creatorField, hostField, speakerField, titleExpansion];
