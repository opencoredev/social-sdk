/* oxlint-disable anti-slop/require-readable-spacing -- compact mocked transport fixtures. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef, type AdapterOperationContext } from "../src/index.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });

const auth = { userId: "u1", accessToken: "test" };
const operationContext: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "x-test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

it("X image publishing uses OAuth2 v2 media upload and preserves reply settings", async () => {
  const methods: string[] = [];

  const social = createSocial({
    backend: x({
      auth,
      fetch: async (input, init) => {
        assert.equal(init?.redirect, "error");
        const url = new URL(String(input));
        methods.push(url.pathname);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test");

        if (url.pathname === "/2/media/upload") {
          assert.ok(init?.body instanceof FormData);
          assert.equal(init.body.get("media_category"), "tweet_image");

          return Response.json({ data: { id: "media1" } });
        }

        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.media, { media_ids: ["media1"] });
        assert.equal(body.reply_settings, "following");

        return Response.json({ data: { id: "post1" } });
      },
    }),
  });

  const result = await social.posts.publish({
    targets: [{ account, options: { replySettings: "following" } }],
    content: {
      text: "Image",
      media: [
        {
          kind: "image",
          mimeType: "image/png",
          filename: "image.png",
          source: {
            kind: "blob",
            blob: new Blob([new Uint8Array(100)], { type: "image/png" }),
            fingerprint: "image1",
          },
        },
      ],
    },
  });

  assert.equal(result.outcomes[0]?.state, "published");
  assert.deepEqual(methods, ["/2/media/upload", "/2/tweets"]);
});

it("X local validation counts weighted Unicode and URLs without network access", () => {
  const social = createSocial({ backend: x({ auth }) });

  for (const text of ["a".repeat(281), "界".repeat(141)])
    assert.equal(social.posts.prepare({ targets: [{ account }], content: { text } }).ok, false);

  for (const text of ["界".repeat(140), "https://example.com/" + "a".repeat(300), "👨‍👩‍👧‍👦".repeat(100)])
    assert.equal(social.posts.prepare({ targets: [{ account }], content: { text } }).ok, true);
  assert.equal(
    social.posts.prepare({
      targets: [{ account: { ...account, accountId: "other" } }],
      content: { text: "Hello" },
    }).ok,
    false,
  );
});

it("X lost create responses remain unknown and never replay", async () => {
  let calls = 0;

  const social = createSocial({
    backend: x({
      auth,
      fetch: async () => {
        calls++;
        throw new Error("private");
      },
    }),
  });

  const result = await social.posts.publish({ targets: [{ account }], content: { text: "Hello" } });
  assert.equal(result.outcomes[0]?.state, "unknown");
  assert.equal(calls, 1);
});

it("X validates upstream account ownership and exposes only returned metrics", async () => {
  const social = createSocial({
    backend: x({
      auth,
      fetch: async (input) =>
        String(input).includes("/users/me")
          ? Response.json({
              data: { id: "u1", name: "User", username: "user", token: "do-not-return" },
            })
          : Response.json({
              data: { id: "post1", author_id: "u1", public_metrics: { like_count: 0 } },
            }),
    }),
  });

  const accounts = await social.accounts.list();
  assert.ok(!JSON.stringify(accounts).includes("do-not-return"));

  const metrics = await social.analytics.getPostMetrics({
    ...account,
    kind: "platform-post",
    postId: "post1",
  });

  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]?.value, 0);
  assert.equal(metrics[0]?.measuredAt, undefined);
});

it("X search posts uses the recent endpoint, preserves query operators, and encodes cursors", async () => {
  let requested: URL | undefined;

  const social = createSocial({
    backend: x({
      auth,
      appBearerToken: "app-test",
      fetch: async (input) => {
        requested = new URL(String(input));

        return Response.json({
          data: [
            {
              id: "searched-1",
              text: "AI has:links -is:retweet",
              author_id: "other-user",
              created_at: "2026-09-22T12:00:00.000Z",
              secret: "redact",
            },
          ],
          meta: { next_token: "next-page" },
        });
      },
    }),
  });

  const page = await social.search.posts(account, {
    query: "AI has:links -is:retweet lang:en",
    limit: 10,
    startTime: "2026-09-20T00:00:00.000Z",
    endTime: "2026-09-22T00:00:00.000Z",
  });

  assert.equal(requested?.pathname, "/2/tweets/search/recent");
  assert.equal(requested?.searchParams.get("query"), "AI has:links -is:retweet lang:en");
  assert.equal(requested?.searchParams.get("max_results"), "10");
  assert.equal(requested?.searchParams.get("start_time"), "2026-09-20T00:00:00.000Z");
  assert.equal(page.items[0]?.["id"], "searched-1");
  assert.equal(page.items[0]?.["secret"], undefined);
  assert.match(page.nextCursor ?? "", /^social-v1\./);
});

it("X preserves requested tweet objects and treats omitted data as an empty page", async () => {
  let calls = 0;
  const social = createSocial({
    backend: x({
      auth,
      fetch: async () => {
        calls++;
        return calls === 1
          ? Response.json({
              data: [
                {
                  id: "1",
                  public_metrics: { like_count: 2 },
                  entities: { hashtags: [] },
                  attachments: { media_keys: [] },
                },
              ],
            })
          : Response.json({ meta: {} });
      },
    }),
  });
  const searched = await social.search.posts(account, { query: "hello", limit: 10 });
  assert.deepEqual(searched.items[0]?.["public_metrics"], { like_count: 2 });
  assert.deepEqual(searched.items[0]?.["entities"], { hashtags: [] });
  const listed = await social.posts.list(account);
  assert.deepEqual(listed.items, []);
});

it("X search posts supports full archive limits and rejects an invalid range", async () => {
  let requested: URL | undefined;

  const social = createSocial({
    backend: x({
      auth,
      appBearerToken: "app-test",
      fetch: async (input) => {
        requested = new URL(String(input));

        return Response.json({ data: [] });
      },
    }),
  });

  await social.search.posts(account, { query: "research", scope: "all", limit: 500 });
  assert.equal(requested?.pathname, "/2/tweets/search/all");
  assert.equal(requested?.searchParams.get("max_results"), "500");

  await assert.rejects(
    social.search.posts(account, {
      query: "research",
      startTime: "2026-09-23T00:00:00.000Z",
      endTime: "2026-09-22T00:00:00.000Z",
      limit: 10,
    }),
    /startTime must be earlier than endTime|Search requires/,
  );
});

it("X app-only reads request explicit fields and preserve pagination", async () => {
  const calls: URL[] = [];
  const social = createSocial({
    backend: x({
      auth: { userId: "u1" },
      appBearerToken: "app-token",
      fetch: async (input) => {
        const url = new URL(String(input));
        calls.push(url);
        if (url.pathname === "/2/users/u2")
          return Response.json({ data: { id: "u2", name: "Alice", username: "alice" } });
        return Response.json({
          data: [{ id: "u2", name: "Alice", username: "alice" }],
          meta: { next_token: "next" },
        });
      },
    }),
  });
  const profile = await social.graph.getProfile(account, { profileId: "u2" });
  assert.equal(profile.handle, "alice");
  assert.equal(
    calls[0]?.searchParams.get("user.fields"),
    "id,name,username,description,created_at,public_metrics,profile_image_url,verified",
  );
  const page = await social.graph.listRelationships(account, { kind: "followers", limit: 5 });
  assert.equal(calls[1]?.searchParams.get("max_results"), "5");
  assert.match(page.nextCursor ?? "", /^social-v1\./);
});

it("X validates the declared reply parent conversation before creating a reply", async () => {
  const methods: string[] = [];

  const social = createSocial({
    backend: x({
      auth,
      fetch: async (input, init) => {
        methods.push(init?.method ?? "GET");
        const id = new URL(String(input)).pathname.split("/").at(-1);

        return Response.json({
          data: { id, conversation_id: id === "parent2" ? "other-root" : "root1" },
        });
      },
    }),
  });

  await assert.rejects(
    social.comments.reply(
      {
        kind: "comment",
        version: 1,
        backend: "default",
        platform: "x",
        accountId: "u1",
        postId: "root1",
        commentId: "parent2",
      },
      { text: "reply" },
    ),
    /conversation/,
  );
  assert.deepEqual(methods, ["GET", "GET"]);
});

it("X native pinned lists, conversation DMs, and group DMs use v2 endpoints", async () => {
  const requests: { path: string; method: string; body?: string }[] = [];
  const social = createSocial({
    backend: x({
      auth,
      fetch: async (input, init) => {
        requests.push({
          path: new URL(String(input)).pathname,
          method: init?.method ?? "GET",
          body: String(init?.body ?? ""),
        });
        return Response.json({ data: [{ id: "l1" }], meta: { next_token: "next" } });
      },
    }),
  });
  const native = social.native("default", { acknowledgeUnsafe: true });
  await native.pinList({ account, listId: "l1", context: operationContext });
  await native.unpinList({ account, listId: "l1", context: operationContext });
  const page = await native.pinnedLists({ account, context: operationContext });
  await native.sendConversationMessage({
    account,
    conversationId: "c1",
    text: "hi",
    context: operationContext,
  });
  await native.createGroupConversation({
    account,
    participantIds: ["u2", "u3"],
    message: "hello",
    context: operationContext,
  });
  assert.equal(page.items[0]?.["id"], "l1");
  assert.deepEqual(
    requests.map((request) => [request.path, request.method]),
    [
      ["/2/users/u1/pinned_lists", "POST"],
      ["/2/users/u1/pinned_lists/l1", "DELETE"],
      ["/2/users/u1/pinned_lists", "GET"],
      ["/2/dm_conversations/c1/messages", "POST"],
      ["/2/dm_conversations", "POST"],
    ],
  );
  assert.deepEqual(JSON.parse(requests[4]?.body ?? "{}"), {
    conversation_type: "Group",
    participant_ids: ["u2", "u3"],
    message: { text: "hello" },
  });
});
