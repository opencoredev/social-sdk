import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef, platformPostRef } from "../src/index.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });

const post = platformPostRef({ ...account, postId: "1700000000000000000" });

it("X comments.list searches the conversation, drops the root, and pages with next_token", async () => {
  const requests: URL[] = [];

  const social = createSocial({
    backend: x({
      auth: { userId: "u1", accessToken: "user-token" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(url);

        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer user-token");

        return requests.length === 1
          ? Response.json({
              data: [
                {
                  id: "1700000000000000002",
                  text: "Nested reply",
                  author_id: "u3",
                  created_at: "2026-09-23T10:00:00.000Z",
                  conversation_id: "1700000000000000000",
                  in_reply_to_user_id: "u2",
                  referenced_tweets: [{ type: "replied_to", id: "1700000000000000001" }],
                  public_metrics: { like_count: 1, reply_count: 0, extra: "drop" },
                  private_field: "drop",
                },
                {
                  id: "1700000000000000000",
                  text: "Root post",
                  author_id: "u1",
                  conversation_id: "1700000000000000000",
                },
              ],
              meta: { result_count: 2, next_token: "b26v89c19zqg8o3f" },
            })
          : Response.json({ meta: { result_count: 0 } });
      },
    }),
  });

  const first = await social.comments.list(post, { limit: 10 });

  const request = requests[0];

  assert.equal(request?.pathname, "/2/tweets/search/recent");

  assert.equal(request?.searchParams.get("query"), "conversation_id:1700000000000000000");

  assert.equal(request?.searchParams.get("max_results"), "10");

  assert.match(request?.searchParams.get("tweet.fields") ?? "", /conversation_id/);

  assert.equal(request?.searchParams.get("next_token"), null);

  assert.deepEqual(first.items, [
    {
      id: "1700000000000000002",
      text: "Nested reply",
      author_id: "u3",
      created_at: "2026-09-23T10:00:00.000Z",
      conversation_id: "1700000000000000000",
      in_reply_to_user_id: "u2",
      referenced_tweets: [{ type: "replied_to", id: "1700000000000000001" }],
      public_metrics: { like_count: 1, reply_count: 0 },
    },
  ]);

  assert.match(first.nextCursor ?? "", /^social-v1\./);

  const second = await social.comments.list(
    post,
    first.nextCursor === undefined ? { limit: 10 } : { limit: 10, cursor: first.nextCursor },
  );

  assert.equal(requests[1]?.searchParams.get("next_token"), "b26v89c19zqg8o3f");

  assert.deepEqual(second.items, []);

  assert.equal(second.nextCursor, undefined);
});

it("X comments.list uses the app bearer token when no user token is configured", async () => {
  let authorization: string | null = null;

  const social = createSocial({
    backend: x({
      auth: { userId: "u1" },
      appBearerToken: "app-token",
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");

        return Response.json({ meta: { result_count: 0 } });
      },
    }),
  });

  const page = await social.comments.list(post);

  assert.equal(authorization, "Bearer app-token");

  assert.deepEqual(page.items, []);
});

it("X comments.list rejects invalid input and foreign conversations", async () => {
  let calls = 0;

  const social = createSocial({
    backend: x({
      auth: { userId: "u1", accessToken: "user-token" },
      fetch: async () => {
        calls++;

        return Response.json({
          data: [{ id: "9", text: "Elsewhere", conversation_id: "1600000000000000000" }],
        });
      },
    }),
  });

  for (const limit of [1, 9, 101]) {
    await assert.rejects(social.comments.list(post, { limit }), {
      name: "SocialError",
      code: "invalid_input",
    });
  }

  await assert.rejects(
    social.comments.list(platformPostRef({ ...account, postId: "123 OR from:someone" })),
    { name: "SocialError", code: "invalid_input" },
  );

  assert.equal(calls, 0);

  await assert.rejects(social.comments.list(post), { name: "SocialError", code: "unauthorized" });

  await assert.rejects(
    social.comments.list(
      platformPostRef({ ...account, postId: "1700000000000000000", accountId: "other" }),
    ),
    {
      name: "SocialError",
      code: "unauthorized",
    },
  );

  assert.equal(calls, 1);
});

it("X declares comments.read with recent-search scopes", () => {
  const entry = x({ auth: { userId: "u1", accessToken: "t" } }).capabilities.capabilities.find(
    (capability) => capability.operation === "comments.read",
  );

  assert.equal(entry?.availability, "available");

  assert.deepEqual(entry?.requiredScopes, ["tweet.read", "users.read"]);
});
