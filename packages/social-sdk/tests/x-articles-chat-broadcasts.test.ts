import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, type AdapterOperationContext } from "../src/index.js";
import type { JsonValue } from "../src/core/types.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "11" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "x-articles",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

interface Seen {
  readonly method: string;
  readonly href: string;
  readonly body: JsonValue | undefined;
}

function fake(routes: Readonly<Record<string, JsonValue>>) {
  const seen: Seen[] = [];

  const adapter = x({
    auth: { userId: "11", accessToken: "user" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      seen.push({
        method,
        href: url.href,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });

      const response = routes[`${method} ${url.pathname}`];

      return response === undefined
        ? Response.json({ title: "Not Found" }, { status: 404 })
        : Response.json(response);
    },
  });

  assert.ok(adapter.native);

  return { native: adapter.native, seen };
}

it("creates and publishes an Article through /2/articles [feature:x.articles.publish]", async () => {
  const { native, seen } = fake({
    "POST /2/articles/draft": { data: { id: "1146654567674912769", title: "Release notes" } },
    "POST /2/articles/1146654567674912769/publish": { data: { post_id: "1346889436626259968" } },
  });

  const draft = await native.createArticleDraft({
    account,
    title: "Release notes",
    blocks: [
      { text: "What shipped", type: "header-one" },
      {
        text: "Read the changelog for details.",
        type: "unstyled",
        inlineStyles: [{ offset: 0, length: 4, style: "bold" }],
        entityRanges: [{ entity: 0, offset: 9, length: 9 }],
      },
      { text: " ", type: "atomic", entityRanges: [{ entity: 1, offset: 0, length: 1 }] },
    ],
    entities: [
      { kind: "link", url: "https://example.com/changelog" },
      { kind: "post", postId: "1700000000000000000" },
    ],
    coverMedia: { mediaId: "901" },
    context,
  });

  assert.deepEqual(draft, { articleId: "1146654567674912769", title: "Release notes" });
  assert.deepEqual(seen[0], {
    method: "POST",
    href: "https://api.x.com/2/articles/draft",
    body: {
      title: "Release notes",
      content_state: {
        blocks: [
          { text: "What shipped", type: "header-one" },
          {
            text: "Read the changelog for details.",
            type: "unstyled",
            inline_style_ranges: [{ offset: 0, length: 4, style: "bold" }],
            entity_ranges: [{ key: 0, offset: 9, length: 9 }],
          },
          { text: " ", type: "atomic", entity_ranges: [{ key: 1, offset: 0, length: 1 }] },
        ],
        entities: [
          {
            key: "0",
            value: {
              type: "link",
              mutability: "mutable",
              data: { url: "https://example.com/changelog" },
            },
          },
          {
            key: "1",
            value: {
              type: "post",
              mutability: "immutable",
              data: { post_id: "1700000000000000000" },
            },
          },
        ],
      },
      cover_media: { media_id: "901", media_category: "tweet_image" },
    },
  });

  const post = await native.publishArticle({ account, articleId: draft.articleId, context });

  assert.deepEqual(post, {
    kind: "platform-post",
    version: 1,
    backend: "default",
    platform: "x",
    accountId: "11",
    postId: "1346889436626259968",
  });
  assert.deepEqual(seen[1], {
    method: "POST",
    href: "https://api.x.com/2/articles/1146654567674912769/publish",
    body: undefined,
  });

  await assert.rejects(
    native.createArticleDraft({
      account,
      title: "Broken",
      blocks: [
        { text: "short", type: "unstyled", entityRanges: [{ entity: 3, offset: 0, length: 2 }] },
      ],
      context,
    }),
    { code: "invalid_input" },
  );

  const lost = fake({ "POST /2/articles/5/publish": { data: {} } });
  await assert.rejects(lost.native.publishArticle({ account, articleId: "5", context }), {
    code: "ambiguous_outcome",
  });
});

it("lists X Chat conversations, reads events and sends plaintext or XDK messages [feature:x.xchat]", async () => {
  const { native, seen } = fake({
    "GET /2/chat/conversations": { data: [{ id: "11-12", type: "direct", unread: true }] },
    "GET /2/chat/conversations/11-12/events": {
      data: [{ id: "77", sender_id: "12", encoded_event: "opaque-base64" }],
      meta: { next_token: "e2" },
    },
    "POST /2/chat/conversations/11-12/messages": { data: { encoded_message_event: "sent-event" } },
  });

  assert.deepEqual(
    (await native.chatConversations({ account, unreadOnly: true, type: "direct", context })).items,
    [{ id: "11-12", type: "direct", unread: true }],
  );
  assert.equal(new URL(seen[0]?.href ?? "").pathname, "/2/chat/conversations");
  assert.equal(new URL(seen[0]?.href ?? "").searchParams.get("unread_only"), "true");

  assert.deepEqual(
    await native.chatEvents({ account, conversationId: "11-12", limit: 50, context }),
    {
      items: [{ id: "77", sender_id: "12", encoded_event: "opaque-base64" }],
      nextCursor: "e2",
    },
  );

  assert.deepEqual(
    await native.sendChatMessage({
      account,
      conversationId: "11-12",
      messageId: "msg-1",
      message: { kind: "text", text: "Hello" },
      context,
    }),
    { encodedMessageEvent: "sent-event" },
  );
  assert.deepEqual(seen[2]?.body, { message_id: "msg-1", content: { message: { text: "Hello" } } });

  await native.sendChatMessage({
    account,
    conversationId: "11-12",
    messageId: "msg-2",
    message: {
      kind: "encrypted",
      encodedMessageCreateEvent: "xdk-event",
      encodedMessageEventSignature: "xdk-signature",
      xdkVersion: "1.0.0",
    },
    context,
  });
  assert.deepEqual(seen[3]?.body, {
    message_id: "msg-2",
    encoded_message_create_event: "xdk-event",
    encoded_message_event_signature: "xdk-signature",
    xdk_version: "1.0.0",
  });

  await assert.rejects(native.chatEvents({ account, conversationId: "not/an/id", context }), {
    code: "invalid_input",
  });
});

it("schedules, runs and moderates live broadcasts through /2/broadcasts [feature:x.broadcasts]", async () => {
  const { native, seen } = fake({
    "GET /2/sources": { data: [{ id: "fixture-source", name: "Studio", region: "us-east-1" }] },
    "POST /2/sources": { data: { id: "fixture-source", name: "Studio", region: "us-east-1" } },
    "POST /2/broadcasts/scheduled": {
      data: { broadcast_id: "1yNGaQLWpejGj", manual_publish: true },
    },
    "POST /2/broadcasts/scheduled/1yNGaQLWpejGj/live": { data: { broadcast_id: "1yNGaQLWpejGj" } },
    "GET /2/broadcasts": { data: [{ id: "1yNGaQLWpejGj", state: "RUNNING" }] },
    "POST /2/broadcasts/1yNGaQLWpejGj/chat": {
      data: { success: true, timestamp: "1762250000000000000" },
    },
    "GET /2/broadcasts/1yNGaQLWpejGj/chat": { data: [{ id: "5", text: "hi" }] },
    "POST /2/broadcasts/chat/moderators": { data: { moderator_user_ids: ["12"] } },
    "POST /2/broadcasts/chat/mutes": { data: { muted: true } },
    "DELETE /2/broadcasts/chat/mutes/13": { data: { muted: false } },
    "PUT /2/broadcasts/1yNGaQLWpejGj/state": { data: { id: "1yNGaQLWpejGj", state: "ENDED" } },
    "DELETE /2/broadcasts/1yNGaQLWpejGj": { data: { deleted: true } },
  });

  assert.equal((await native.streamSources({ account, context })).items.length, 1);
  await native.createStreamSource({ account, name: "Studio", region: "us-east-1", context });

  const scheduled = await native.scheduleBroadcast({
    account,
    broadcast: {
      sourceId: "fixture-source",
      startAt: "2026-11-05T18:00:00Z",
      endAt: "2026-11-05T19:00:00Z",
      title: "Launch stream",
      manualPublish: true,
      chatOption: 2,
    },
    context,
  });

  assert.deepEqual(scheduled, { broadcast_id: "1yNGaQLWpejGj", manual_publish: true });
  assert.deepEqual(seen[2]?.body, {
    source_id: "fixture-source",
    scheduled_start_ms: String(Date.parse("2026-11-05T18:00:00Z")),
    scheduled_end_ms: String(Date.parse("2026-11-05T19:00:00Z")),
    title: "Launch stream",
    manual_publish: true,
    chat_option: "2",
  });

  await native.goLive({ account, broadcastId: "1yNGaQLWpejGj", context });
  assert.deepEqual(
    (await native.broadcasts({ account, broadcastIds: ["1yNGaQLWpejGj"], context })).items,
    [{ id: "1yNGaQLWpejGj", state: "RUNNING" }],
  );
  assert.equal(seen[4]?.href, "https://api.x.com/2/broadcasts?ids=1yNGaQLWpejGj");

  assert.deepEqual(
    await native.sendBroadcastChat({
      account,
      broadcastId: "1yNGaQLWpejGj",
      text: "Welcome",
      context,
    }),
    { timestamp: "1762250000000000000" },
  );
  assert.deepEqual(
    (await native.broadcastChat({ account, broadcastId: "1yNGaQLWpejGj", context })).items,
    [{ id: "5", text: "hi" }],
  );
  assert.deepEqual(
    await native.setChatModerator({ account, userId: "12", moderator: true, context }),
    ["12"],
  );
  await native.setChatMute({
    account,
    userId: "13",
    muted: true,
    endAt: "2026-11-05T18:30:00Z",
    context,
  });
  assert.deepEqual(seen[8]?.body, {
    user_id: "13",
    end_at_ms: String(Date.parse("2026-11-05T18:30:00Z")),
  });
  await native.setChatMute({ account, userId: "13", muted: false, context });
  await native.endBroadcast({ account, broadcastId: "1yNGaQLWpejGj", context });
  assert.deepEqual(seen[10]?.body, { state: "END" });
  await native.deleteBroadcast({ account, broadcastId: "1yNGaQLWpejGj", context });

  assert.deepEqual(
    seen.map((entry) => `${entry.method} ${new URL(entry.href).pathname}`),
    [
      "GET /2/sources",
      "POST /2/sources",
      "POST /2/broadcasts/scheduled",
      "POST /2/broadcasts/scheduled/1yNGaQLWpejGj/live",
      "GET /2/broadcasts",
      "POST /2/broadcasts/1yNGaQLWpejGj/chat",
      "GET /2/broadcasts/1yNGaQLWpejGj/chat",
      "POST /2/broadcasts/chat/moderators",
      "POST /2/broadcasts/chat/mutes",
      "DELETE /2/broadcasts/chat/mutes/13",
      "PUT /2/broadcasts/1yNGaQLWpejGj/state",
      "DELETE /2/broadcasts/1yNGaQLWpejGj",
    ],
  );

  await assert.rejects(
    native.sendBroadcastChat({
      account,
      broadcastId: "1yNGaQLWpejGj",
      text: "x".repeat(141),
      context,
    }),
    { code: "invalid_input" },
  );
  await assert.rejects(native.broadcasts({ account, broadcastIds: ["a"], limit: 5, context }), {
    code: "invalid_input",
  });
});
