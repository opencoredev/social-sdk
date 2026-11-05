import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { zernioNative } from "../src/cloud/zernio-native.js";
import type { AdapterOperationContext } from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "offline-review",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

it("Zernio validatePost retains documented error and warning explanations", async () => {
  let called = false;

  const native = zernioNative({
    apiKey: "offline-fixture",
    fetch: async (input) => {
      called = true;
      assert.equal(new URL(String(input)).pathname, "/api/v1/tools/validate/post");

      return Response.json({
        valid: false,
        errors: [{ platform: "twitter", error: "Content exceeds the character limit" }],
        warnings: [{ platform: "twitter", warning: "Content is near the character limit" }],
      });
    },
  });

  const result = await native.validatePost(
    {
      account: connectedAccountRef({ backend: "default", platform: "x", accountId: "x1" }),
      content: { text: "Offline validation fixture" },
    },
    context,
  );

  assert.equal(called, true);
  assert.deepEqual(
    {
      error: result.errors[0]?.["message"] ?? result.errors[0]?.["error"],
      warning: result.warnings[0]?.["message"] ?? result.warnings[0]?.["warning"],
    },
    {
      error: "Content exceeds the character limit",
      warning: "Content is near the character limit",
    },
  );
});
