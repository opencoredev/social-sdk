import assert from "node:assert/strict";
import { test } from "node:test";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";
import { facebook } from "../src/platforms/facebook.js";

// Meta's Reels guide documents this endpoint returning an invitation-status object.
// https://developers.facebook.com/docs/video-api/guides/reels-publishing/#get-invitation-status
test("Facebook listReelCollaborators accepts the documented invitation status response", async () => {
  const account = connectedAccountRef({
    backend: "default",
    platform: "facebook",
    accountId: "123",
  });

  const context: AdapterOperationContext = {
    backendInstance: "default",
    correlationId: "review-meta-collaborators",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
  };

  const documentedStatus = { id: "456", name: "Partner Page", invite_status: "Accepted" };
  const calls: URL[] = [];

  const adapter = facebook({
    auth: { pageId: "123", accessToken: "offline-fixture" },
    fetch: async (input) => {
      calls.push(new URL(String(input)));

      return Response.json(documentedStatus);
    },
  });

  assert.ok(adapter.native);
  const operation = adapter.native.listReelCollaborators({ account, videoId: "456", context });
  await assert.doesNotReject(
    operation,
    "Meta's documented invitation status object must be accepted",
  );
  const result = await operation;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.pathname, "/v27.0/456/collaborators");
  assert.deepEqual(result.items, [documentedStatus]);
});
