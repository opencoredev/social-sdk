import assert from "node:assert/strict";
import { it } from "node:test";
import type { AdapterOperationContext } from "../src/core/index.js";
import { instagram } from "../src/platforms/instagram.js";
import { threads } from "../src/platforms/threads.js";

const context: AdapterOperationContext = {
  backendInstance: "instagram",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10000 },
};

it("replies to an Instagram comment with POST /{ig-comment-id}/replies [feature:instagram.comments.reply]", async () => {
  const seen: { method: string; path: string; body: string }[] = [];

  const adapter = instagram({
    auth: { accessToken: "fixture", accountId: "ig1" },
    fetch: async (input, init) => {
      seen.push({
        method: init?.method ?? "GET",
        path: new URL(String(input)).pathname,
        body: String(init?.body ?? ""),
      });

      return Response.json({ id: "reply-2" });
    },
  });

  const reply = await adapter.comments?.reply(
    {
      kind: "comment",
      version: 1,
      backend: "instagram",
      platform: "instagram",
      accountId: "ig1",
      postId: "media-1",
      commentId: "comment-1",
    },
    { text: "Thanks" },
    context,
  );

  assert.equal(reply?.commentId, "reply-2");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.method, "POST");
  assert.equal(seen[0]?.path, "/v27.0/comment-1/replies");
  assert.match(seen[0]?.body ?? "", /Thanks/);
});

it("Threads declares profile updates and messaging unsupported by the platform [feature:threads.account.update] [feature:threads.messaging]", () => {
  const { capabilities } = threads({
    auth: { userId: "u1", accessToken: "fixture" },
    fetch: async () => {
      throw new Error("declarations make no requests");
    },
  }).capabilities;

  for (const operation of ["profile.update", "messages.read"])
    assert.equal(
      capabilities.find((entry) => entry.operation === operation)?.availability,
      "unsupported-by-platform",
      operation,
    );
});
