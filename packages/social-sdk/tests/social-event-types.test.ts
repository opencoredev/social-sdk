import { it } from "node:test";
import assert from "node:assert/strict";
import { socialEventTypes, type SocialEventType } from "../src/server/event-types.js";
import type { SocialEvent } from "../src/server/webhooks.js";

it("lists every normalized webhook event type exactly once", () => {
  const repeated = socialEventTypes.filter(
    (type, index) => socialEventTypes.indexOf(type) !== index,
  );

  assert.deepEqual(repeated, []);
});

it("derives SocialEvent type from the event type list in both directions", () => {
  const fromList: SocialEvent["type"] = socialEventTypes[0];
  const toList: SocialEventType = "reaction.removed" satisfies SocialEvent["type"];

  assert.equal(fromList, "publication.updated");
  assert.ok(socialEventTypes.includes(toList));
});
