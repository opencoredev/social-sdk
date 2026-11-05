import assert from "node:assert/strict";
import { it } from "node:test";
import { connectedAccountRef, createSocial, type AdapterOperationContext } from "../src/index.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "11" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "review-x",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

it("allows share_with_followers on an exclusive post without a Community", async () => {
  // X OpenAPI 2.173 CreatePostsRequest.share_with_followers:
  // "Share an exclusive (super-follower) tweet with all followers."
  // https://docs.x.com/openapi.json
  let calls = 0;

  const social = createSocial({
    backend: x({
      auth: { userId: "11", accessToken: "fixture-user" },
      fetch: async (_input, init) => {
        calls += 1;
        assert.deepEqual(JSON.parse(String(init?.body)), {
          text: "A subscriber update also shared with followers",
          for_super_followers_only: true,
          share_with_followers: true,
        });

        return Response.json({ data: { id: "101" } }, { status: 201 });
      },
    }),
  });

  const request = {
    targets: [{ account, options: { forSuperFollowersOnly: true, shareWithFollowers: true } }],
    content: { text: "A subscriber update also shared with followers" },
  };

  const prepared = social.posts.prepare(request);
  assert.equal(prepared.ok, true, JSON.stringify(prepared.issues));
  const result = await social.posts.publish(request);
  assert.equal(result.outcomes[0]?.state, "published");
  assert.equal(calls, 1);
});

it("preserves the Chat event page's conversation key events", async () => {
  // GetChatConversationEventsResponse.meta.conversation_key_events in X OpenAPI 2.173.
  // https://docs.x.com/openapi.json
  const adapter = x({
    auth: { userId: "11", accessToken: "fixture-user" },
    fetch: async () =>
      Response.json({
        data: [{ id: "71", encoded_event: "fixture-message", conversation_key_version: "2" }],
        meta: {
          conversation_key_events: ["fixture-key-event"],
          has_more: true,
          next_token: "next-page",
          result_count: 1,
        },
      }),
  });

  assert.ok(adapter.native);
  const page = await adapter.native.chatEvents({ account, conversationId: "11-12", context });
  assert.equal(page.nextCursor, "next-page");
  assert.ok(
    JSON.stringify(page).includes("fixture-key-event"),
    "The returned page must retain meta.conversation_key_events for the client",
  );
});

it("honors a pre-aborted context before downloading DM media", async () => {
  // GET /2/dm_conversations/media/{dm_id}/{media_id}/{resource_id}, X OpenAPI 2.173.
  // https://docs.x.com/openapi.json
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  const adapter = x({
    auth: { userId: "11", accessToken: "fixture-user" },
    fetch: async (_input, init) => {
      calls += 1;
      init?.signal?.throwIfAborted();

      return new Response(new Uint8Array([1, 2, 3]));
    },
  });

  assert.ok(adapter.native);
  await assert.rejects(
    adapter.native.downloadDmMedia({
      account,
      dmId: "1",
      mediaId: "2",
      resourceId: "3",
      context: { ...context, signal: controller.signal },
    }),
    { code: "cancelled" },
  );
  assert.equal(calls, 0);
});

it("preserves an uncertain Chat send when a 201 response omits the event", async () => {
  // POST /2/chat/conversations/{id}/messages returns HTTP 201 on creation.
  // https://docs.x.com/openapi.json
  let calls = 0;

  const adapter = x({
    auth: { userId: "11", accessToken: "fixture-user" },
    fetch: async () => {
      calls += 1;

      return Response.json({ data: {} }, { status: 201 });
    },
  });

  assert.ok(adapter.native);
  await assert.rejects(
    adapter.native.sendChatMessage({
      account,
      conversationId: "11-12",
      messageId: "review-message",
      message: { kind: "text", text: "One send only" },
      context,
    }),
    { code: "ambiguous_outcome", retryDisposition: { kind: "reconcile-first" } },
  );
  assert.equal(calls, 1);
});
