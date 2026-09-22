/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-unknown-parameters -- adapter fixture assertions validate the error boundary. */
import assert from "node:assert/strict";
import { it } from "node:test";
import {
  connectedAccountRef,
  createSocial,
  profileRef,
  type CapabilityManifest,
  type SocialAdapter,
} from "../src/index.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "me" });
const target = profileRef({ ...account, profileId: "someone" });

function adapter(): SocialAdapter {
  const capabilities: CapabilityManifest = {
    schemaVersion: 1,
    backend: "graph-test",
    apiRevision: "test",
    runtime: ["node"],
    capabilities: [
      { operation: "profiles.read", platform: "x", availability: "available" },
      { operation: "graph.read", platform: "x", availability: "available" },
      { operation: "graph.follow", platform: "x", availability: "available" },
      { operation: "graph.unfollow", platform: "x", availability: "available" },
    ],
  };
  return {
    id: "graph-test",
    capabilities,
    graph: {
      async getProfile(_account, input) {
        return { ref: target, displayName: input.profileId ?? input.handle };
      },
      async listRelationships(_account, input) {
        return {
          items: [
            {
              profile: target,
              relationship: input.kind === "followers" ? "follower" : "following",
            },
          ],
        };
      },
      async follow() {
        return { profile: target, relationship: "following" };
      },
      async unfollow() {},
    },
  };
}

it("normalizes profile and graph operations through a custom adapter", async () => {
  const social = createSocial({ backend: adapter() });
  const profile = await social.graph.getProfile(account, { profileId: "someone" });
  assert.equal(profile.ref.profileId, "someone");
  const relationships = await social.graph.listRelationships(account, { kind: "following" });
  assert.equal(relationships.items[0]?.relationship, "following");
  const relationship = await social.graph.follow(target);
  assert.equal(relationship.relationship, "following");
  await social.graph.unfollow(target);
});

it("rejects graph calls whose capability is unavailable before dispatch", async () => {
  const social = createSocial({ backend: adapter() });
  await assert.rejects(
    social.graph.block(target),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "unsupported_capability",
  );
});
