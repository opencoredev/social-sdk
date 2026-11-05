import { it } from "node:test";
import assert from "node:assert/strict";
import { postfast } from "../src/cloud/postfast.js";
import type { AdapterOperationContext } from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "review-postfast-unconfirmed",
  retryBudget: { maxAttempts: 3, maxElapsedMs: 30_000 },
};

it("keeps a malformed status-write success response uncertain without replaying", async () => {
  let writes = 0;

  const adapter = postfast({
    apiKey: "fixture-key",
    fetch: async (input, init) => {
      assert.equal(
        new URL(String(input)).pathname,
        "/social-inbox/conversations/9f4c1a2e-5b6d-4c7e-8f90-123456789abc/status",
      );
      assert.equal(init?.method, "POST");
      writes++;

      return Response.json(null, { status: 201 });
    },
  });

  await assert.rejects(
    adapter.native.setInboxStatus(
      { conversationId: "9f4c1a2e-5b6d-4c7e-8f90-123456789abc", status: "CLOSED" },
      context,
    ),
    { code: "ambiguous_outcome", retryDisposition: { kind: "reconcile-first" } },
  );
  assert.equal(writes, 1);
});

it("keeps a malformed assignment-write success response uncertain without replaying", async () => {
  let writes = 0;

  const adapter = postfast({
    apiKey: "fixture-key",
    fetch: async (input, init) => {
      assert.equal(
        new URL(String(input)).pathname,
        "/social-inbox/conversations/9f4c1a2e-5b6d-4c7e-8f90-123456789abc/assign",
      );
      assert.equal(init?.method, "POST");
      writes++;

      return Response.json([], { status: 201 });
    },
  });

  await assert.rejects(
    adapter.native.assignInboxConversation(
      { conversationId: "9f4c1a2e-5b6d-4c7e-8f90-123456789abc", assigneeUserId: null },
      context,
    ),
    { code: "ambiguous_outcome", retryDisposition: { kind: "reconcile-first" } },
  );
  assert.equal(writes, 1);
});
