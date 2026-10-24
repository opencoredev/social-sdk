import assert from "node:assert/strict";
import { it } from "node:test";
import { connectedAccountRef, createSocial } from "../src/index.js";
import { x, type XSpacesLookupInput } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });

const conversation = {
  kind: "conversation" as const,
  version: 1 as const,
  backend: "default",
  platform: "x" as const,
  accountId: "u1",
  conversationId: "c1",
};

it("lists X conversations and messages and sends through social.messages", async () => {
  const requests: { url: URL; method: string; body: string | undefined }[] = [];
  let latestMessageId = "e3";

  const social = createSocial({
    backend: x({
      auth: { userId: "u1", accessToken: "token" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          url,
          method: init?.method ?? "GET",
          body: init?.body?.toString(),
        });

        if (url.pathname === "/2/dm_events" && url.searchParams.has("pagination_token"))
          return Response.json({
            data: [
              { id: "e1b", text: "older other", dm_conversation_id: "c2" },
              { id: "e0", text: "third", dm_conversation_id: "c3" },
            ],
            meta: {},
          });

        if (url.pathname === "/2/dm_events")
          return Response.json({
            data: [
              { id: latestMessageId, text: "latest", dm_conversation_id: "c1" },
              { id: "e2", text: "older", dm_conversation_id: "c1" },
              { id: "e1", text: "other", dm_conversation_id: "c2" },
            ],
            meta: { next_token: "next" },
          });

        if (url.pathname === "/2/dm_conversations/c1/dm_events")
          return Response.json({ data: [{ id: "e3", text: "latest" }], meta: {} });

        if (url.pathname === "/2/dm_conversations/c1/messages")
          return Response.json({ data: { dm_event_id: "e4", dm_conversation_id: "c1" } });

        return Response.json({ meta: {} });
      },
    }),
  });

  const conversations = await social.messages.listConversations(account, { limit: 2 });
  assert.deepEqual(
    conversations.items.map((item) => item["id"]),
    ["c1", "c2"],
  );
  assert.ok(conversations.nextCursor !== undefined);
  assert.equal(requests[0]?.url.searchParams.get("max_results"), "2");
  assert.equal(
    requests[0]?.url.searchParams.get("dm_event.fields"),
    "id,text,event_type,created_at,dm_conversation_id,sender_id,participant_ids,attachments,entities",
  );
  assert.equal(requests[0]?.url.searchParams.get("expansions"), "sender_id,participant_ids");

  const more = await social.messages.listConversations(account, {
    cursor: conversations.nextCursor,
    limit: 2,
  });

  assert.equal(requests[1]?.url.searchParams.get("pagination_token"), "next");
  // c2 was already returned, so the second page only yields the new conversation.
  assert.deepEqual(
    more.items.map((item) => item["id"]),
    ["c3"],
  );
  assert.equal(more.nextCursor, undefined);

  const first = conversations.items[0];
  assert.ok(first !== undefined);
  assert.ok(first.id !== undefined);
  assert.equal(first.native["id"], "e3");
  assert.equal(first.native["dm_conversation_id"], "c1");

  const listedConversation = { ...conversation, conversationId: first.id };
  const messages = await social.messages.listMessages(listedConversation);
  assert.equal(messages.items[0]?.["text"], "latest");
  assert.equal(messages.nextCursor, undefined);

  const sent = await social.messages.send(listedConversation, { text: "hi" });
  assert.deepEqual(sent, { data: { dm_event_id: "e4", dm_conversation_id: "c1" } });
  const send = requests.at(-1);
  assert.equal(send?.method, "POST");
  assert.deepEqual(JSON.parse(send?.body ?? "{}"), { text: "hi" });

  latestMessageId = "e5";
  const refreshed = await social.messages.listConversations(account, { limit: 2 });
  assert.equal(refreshed.items[0]?.id, "c1");
  assert.equal(refreshed.items[0]?.native["id"], "e5");

  const available = social
    .capabilities()
    .default.capabilities.filter((entry) => entry.operation.startsWith("messages."))
    .map((entry) => `${entry.operation}:${entry.availability}`)
    .sort();

  assert.deepEqual(available, [
    "messages.conversation.write:available",
    "messages.group.write:available",
    "messages.read:available",
    "messages.write:available",
  ]);
});

it("returns an empty page for X conversations with no DMs", async () => {
  const social = createSocial({
    backend: x({
      auth: { userId: "u1", accessToken: "token" },
      fetch: async () => Response.json({ meta: { result_count: 0 } }),
    }),
  });

  assert.deepEqual(await social.messages.listConversations(account), { items: [] });
  assert.deepEqual(await social.messages.listMessages(conversation), { items: [] });
});

it("rejects X DMs with only an app bearer token", async () => {
  const social = createSocial({
    backend: x({
      auth: { userId: "u1" },
      appBearerToken: "app",
      fetch: async () => Response.json({ meta: {} }),
    }),
  });

  await assert.rejects(social.messages.listConversations(account), { code: "missing_permission" });
  await assert.rejects(social.messages.send(conversation, { text: "hi" }), {
    code: "missing_permission",
  });
});

it("ends long X conversation walks without repeating conversations", async () => {
  const social = createSocial({
    backend: x({
      auth: { userId: "u1", accessToken: "token" },
      fetch: async (input) => {
        const url = new URL(String(input));
        const page = Number(url.searchParams.get("pagination_token") ?? "0");

        const data = Array.from({ length: 100 }, (_, index) => ({
          id: `e${page}-${index}`,
          // Older events cycle back to the first conversations after 1,250 of them.
          dm_conversation_id: `conversation-${(page * 100 + index) % 1250}`,
        }));

        return Response.json({ data, meta: page < 29 ? { next_token: String(page + 1) } : {} });
      },
    }),
  });

  let cursor: string | undefined;
  const returned: unknown[] = [];
  let calls = 0;

  do {
    const result =
      cursor === undefined
        ? await social.messages.listConversations(account, { limit: 100 })
        : await social.messages.listConversations(account, { limit: 100, cursor });

    calls += 1;
    returned.push(...result.items.map((item) => item["dm_conversation_id"]));
    cursor = result.nextCursor;
    assert.ok(cursor === undefined || cursor.length < 20_000);
  } while (cursor !== undefined);

  // The page that reaches the cap is the last one, with no empty follow-up page.
  assert.equal(calls, 12);
  assert.equal(returned.length, 1200);
  assert.equal(new Set(returned).size, 1200);
});

it("looks up and searches Spaces through the official v2 endpoints", async () => {
  const requests: URL[] = [];

  const adapter = x({
    auth: { userId: "u1", accessToken: "token" },
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);

      if (url.pathname === "/2/spaces/space1")
        return Response.json({
          data: { id: "space1", state: "scheduled", title: "Roadmap" },
          includes: { users: [{ id: "u2", username: "host" }] },
        });

      if (url.pathname === "/2/spaces/search")
        return Response.json({
          data: [{ id: "space2", state: "live", title: "AI" }],
          includes: { users: [{ id: "u2", username: "host" }] },
          errors: [{ resource_id: "missing", title: "Not Found" }],
        });

      if (url.pathname === "/2/spaces/by/creator_ids")
        return Response.json({
          data: [{ id: "space1", state: "scheduled" }],
          errors: [{ resource_id: "creator-missing", title: "Not Found" }],
        });

      return Response.json({
        data: [{ id: "space1", state: "scheduled" }],
        errors: [{ resource_id: "missing", title: "Not Found" }],
      });
    },
  });

  const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });

  const context = {
    backendInstance: "default",
    correlationId: "spaces",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
  } as const;

  assert.ok(adapter.native);

  const single = await adapter.native.getSpace({
    account,
    spaceId: "space1",
    options: { spaceFields: ["title", "state"], expansions: ["host_ids"] },
    context,
  });

  const byIds = await adapter.native.getSpaces({ account, spaceIds: ["space1"], context });

  const byCreators = await adapter.native.getSpacesByCreators({
    account,
    creatorIds: ["123"],
    context,
  });

  const result = await adapter.native.searchSpaces({
    account,
    search: { query: "AI", state: "live", limit: 5, userFields: ["username"] },
    context,
  });

  assert.equal(result.items[0]?.["title"], "AI");
  assert.deepEqual(single["data"], { id: "space1", state: "scheduled", title: "Roadmap" });
  assert.deepEqual(single["includes"], { users: [{ id: "u2", username: "host" }] });
  assert.deepEqual(byIds.metadata, { errors: [{ resource_id: "missing", title: "Not Found" }] });
  assert.deepEqual(byCreators.metadata, {
    errors: [{ resource_id: "creator-missing", title: "Not Found" }],
  });
  assert.deepEqual(result.metadata, {
    includes: { users: [{ id: "u2", username: "host" }] },
    errors: [{ resource_id: "missing", title: "Not Found" }],
  });
  assert.equal(requests[0]?.pathname, "/2/spaces/space1");
  assert.equal(requests[0]?.searchParams.get("space.fields"), "title,state");
  assert.equal(requests[0]?.searchParams.get("expansions"), "host_ids");
  assert.equal(requests[2]?.pathname, "/2/spaces/by/creator_ids");
  assert.equal(requests[2]?.searchParams.get("user_ids"), "123");
  assert.equal(requests[3]?.pathname, "/2/spaces/search");
  assert.equal(requests[3]?.searchParams.get("pagination_token"), null);
  assert.equal(requests[3]?.searchParams.get("max_results"), "5");
});

it("validates Space lookup inputs before dispatch", async () => {
  let calls = 0;

  const adapter = x({
    auth: { userId: "u1", accessToken: "token" },
    fetch: async () => {
      calls++;

      return Response.json({});
    },
  });

  const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });

  const context = {
    backendInstance: "default",
    correlationId: "spaces-validation",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
  } as const;

  assert.ok(adapter.native);
  await assert.rejects(adapter.native.getSpaces({ account, spaceIds: [], context }), {
    code: "invalid_input",
  });
  await assert.rejects(
    adapter.native.getSpacesByCreators({ account, creatorIds: ["not-a-user"], context }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    adapter.native.searchSpaces({ account, search: { query: "   " }, context }),
    { code: "invalid_input" },
  );
  assert.equal(calls, 0);
});

for (const userContext of [true, false])
  it(`preserves OpenAPI Space selectors and expanded topics with ${userContext ? "user" : "app"} auth`, async () => {
    const requests: { url: URL; authorization: string | null }[] = [];

    const space = {
      id: "space1",
      created_at: "2026-10-18T12:00:00.000Z",
      lang: "en",
      subscriber_count: 3,
      updated_at: "2026-10-18T12:01:00.000Z",
      invited_user_ids: ["u2"],
      topic_ids: ["topic1"],
    };

    const includes = {
      users: [{ id: "u2", username: "guest" }],
      topics: [{ id: "topic1", name: "Technology" }],
    };

    const adapter = x({
      auth: userContext ? { userId: "u1", accessToken: "user-token" } : { userId: "u1" },
      appBearerToken: "app-token",
      fetch: async (input, init) => {
        const url = new URL(String(input));

        requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });

        return Response.json({
          data: url.pathname === "/2/spaces/space1" ? space : [space],
          includes,
        });
      },
    });

    // Literal selectors from the OpenAPI 2.172 parameter enums.
    const options: XSpacesLookupInput = {
      spaceFields: [
        "created_at",
        "ended_at",
        "id",
        "is_ticketed",
        "lang",
        "participant_count",
        "scheduled_start",
        "started_at",
        "state",
        "subscriber_count",
        "title",
        "updated_at",
      ],
      expansions: ["creator_id", "host_ids", "invited_user_ids", "speaker_ids", "topic_ids"],
      userFields: ["username"],
    };

    const context = {
      backendInstance: "default",
      correlationId: "spaces-selectors",
      retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
    };

    assert.ok(adapter.native);

    const single = await adapter.native.getSpace({ account, spaceId: "space1", options, context });

    assert.deepEqual(single, { data: space, includes });

    const pages = [
      await adapter.native.getSpaces({ account, spaceIds: ["space1"], options, context }),
      await adapter.native.getSpacesByCreators({ account, creatorIds: ["123"], options, context }),
      await adapter.native.searchSpaces({ account, search: { ...options, query: "AI" }, context }),
    ];

    for (const page of pages) {
      assert.deepEqual(page.items, [space]);
      assert.deepEqual(page.metadata, { includes });
    }

    assert.equal(requests.length, 4);

    for (const request of requests) {
      assert.equal(request.authorization, userContext ? "Bearer user-token" : "Bearer app-token");
      assert.equal(
        request.url.searchParams.get("space.fields"),
        "created_at,ended_at,id,is_ticketed,lang,participant_count,scheduled_start,started_at,state,subscriber_count,title,updated_at",
      );
      assert.equal(
        request.url.searchParams.get("expansions"),
        "creator_id,host_ids,invited_user_ids,speaker_ids,topic_ids",
      );
      assert.equal(request.url.searchParams.get("user.fields"), "username");
    }
  });
