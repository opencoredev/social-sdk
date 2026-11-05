import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { zernio } from "../src/cloud/zernio.js";
import { zernioNative } from "../src/cloud/zernio-native.js";
import { definedFields } from "../src/core/fields.js";
import { isJsonValue } from "../src/transport/json.js";
import { object } from "../src/transport/validation.js";
import type {
  AdapterOperationContext,
  JsonObject,
  JsonValue,
  PlatformPostRef,
} from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body?: JsonObject;
  readonly headers: Headers;
}

/** A Zernio adapter whose fake fetch answers each `METHOD /path` from `routes`. */
function fake(routes: Readonly<Record<string, JsonValue>>) {
  const calls: Call[] = [];

  const options: Parameters<typeof zernio>[0] = {
    apiKey: "test",
    clock: () => new Date("2026-11-04T12:00:00Z"),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const path = url.pathname.replace(/^\/api/, "");
      const parsed: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));

      calls.push({
        method,
        path,
        query: Object.fromEntries(url.searchParams),
        headers: new Headers(init?.headers),
        ...definedFields({ body: isJsonValue(parsed) ? object(parsed) : undefined }),
      });

      const answer = routes[`${method} ${path}`];

      if (answer === undefined) return Response.json({ error: "no route" }, { status: 404 });

      return Response.json(answer);
    },
  };

  return { native: zernioNative(options), adapter: zernio(options), calls };
}

const x = connectedAccountRef({ backend: "default", platform: "x", accountId: "x1" });

const xPost: PlatformPostRef = {
  kind: "platform-post",
  version: 1,
  backend: "default",
  platform: "x",
  accountId: "x1",
  postId: "111",
  native: { backendRecordId: "post1" },
};

const comment = {
  kind: "comment",
  version: 1,
  backend: "default",
  platform: "instagram",
  accountId: "ig1",
  postId: "m1",
  commentId: "c1",
} as const;

const instagram = connectedAccountRef({
  backend: "default",
  platform: "instagram",
  accountId: "ig1",
});

it("declares Reddit and TikTok comments and lists replies by commentId [feature:zernio.comments.list_reply]", async () => {
  const declared = fake({}).adapter.capabilities.capabilities;

  for (const platform of ["reddit", "tiktok"])
    for (const operation of ["comments.read", "comments.write"])
      assert.ok(
        declared.some((entry) => entry.platform === platform && entry.operation === operation),
        `${platform} ${operation}`,
      );

  const { native, calls } = fake({
    "GET /v1/inbox/comments/m1": {
      comments: [
        { id: "c1", message: "parent" },
        { id: "r1", message: "reply", parentId: "c1", likeCount: 2 },
      ],
      pagination: { hasMore: true, cursor: "next" },
    },
  });

  const replies = await native.listCommentReplies({ comment, limit: 10 }, context);

  assert.deepEqual(calls[0]?.query, { accountId: "ig1", commentId: "c1", limit: "10" });
  assert.equal(replies.items.length, 1);
  assert.equal(replies.items[0]?.["id"], "r1");
  assert.equal(replies.nextCursor, "next");
});

it("hides, unhides and deletes comments through /hide and comments.delete", async () => {
  const { native, calls } = fake({
    "POST /v1/inbox/comments/m1/c1/hide": { status: "success", hidden: true },
    "DELETE /v1/inbox/comments/m1/c1/hide": { status: "success", hidden: false },
    "DELETE /v1/inbox/comments/m1": { success: true, data: { message: "deleted" } },
  });

  await native.moderateComment({ comment, action: "hide" }, context);
  await native.moderateComment({ comment, action: "unhide" }, context);
  await native.deleteComment({ comment }, context);

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      "POST /v1/inbox/comments/m1/c1/hide",
      "DELETE /v1/inbox/comments/m1/c1/hide",
      "DELETE /v1/inbox/comments/m1",
    ],
  );
  assert.deepEqual(calls[0]?.body, { accountId: "ig1" });
  assert.deepEqual(calls[1]?.query, { accountId: "ig1" });
  assert.deepEqual(calls[2]?.query, { accountId: "ig1", commentId: "c1" });

  const declared = fake({}).adapter.capabilities.capabilities;

  assert.ok(declared.some((d) => d.operation === "comments.delete" && d.platform === "youtube"));
  assert.ok(!declared.some((d) => d.operation === "comments.moderate" && d.platform === "youtube"));
  await assert.rejects(
    native.moderateComment(
      { comment: { ...comment, platform: "youtube" }, action: "hide" },
      context,
    ),
    { code: "invalid_input" },
  );
});

it("sends one private-reply DM to an Instagram comment", async () => {
  const { native, calls } = fake({
    "POST /v1/inbox/comments/m1/c1/private-reply": { status: "success", messageId: "dm1" },
  });

  assert.deepEqual(await native.privateReply({ comment, text: "Sent you the link" }, context), {
    messageId: "dm1",
  });
  assert.deepEqual(calls[0]?.body, { accountId: "ig1", message: "Sent you the link" });
});

it("likes and unlikes posts and comments through /like and pins comments through /pin", async () => {
  const linkedinComment = { ...comment, platform: "linkedin", accountId: "li1" } as const;

  const { native, calls } = fake({
    "POST /v1/inbox/posts/p9/like": { liked: true },
    "DELETE /v1/inbox/posts/p9/like": { liked: false },
    "POST /v1/inbox/comments/m1/c1/like": { liked: true, likeUri: "at://like" },
    "DELETE /v1/inbox/comments/m1/c1/like": { liked: false },
    "POST /v1/inbox/comments/m1/c1/pin": { pinned: true },
    "DELETE /v1/inbox/comments/m1/c1/pin": { pinned: false },
  });

  const post = { ...xPost, platform: "linkedin", accountId: "li1", postId: "p9" };

  await native.likePost({ post, reactionType: "PRAISE" }, context);
  await native.unlikePost({ post }, context);
  assert.deepEqual(await native.likeComment({ comment: linkedinComment }, context), {
    likeUri: "at://like",
  });
  await native.unlikeComment({ comment: linkedinComment }, context);
  await native.pinComment({ comment: linkedinComment, pinned: true }, context);
  await native.pinComment({ comment: linkedinComment, pinned: false }, context);

  assert.deepEqual(calls[0]?.body, { accountId: "li1", reactionType: "PRAISE" });
  assert.deepEqual(calls[1]?.query, { accountId: "li1" });
  assert.deepEqual(
    calls.map((call) => call.method),
    ["POST", "DELETE", "POST", "DELETE", "POST", "DELETE"],
  );
  await assert.rejects(native.likePost({ post: { ...post, platform: "tiktok" } }, context), {
    code: "invalid_input",
  });
});

it("retweets, bookmarks and follows through /v1/twitter/ routes", async () => {
  const { native, calls } = fake({
    "POST /v1/twitter/retweet": { retweeted: true },
    "DELETE /v1/twitter/retweet": { retweeted: false },
    "POST /v1/twitter/bookmark": { bookmarked: true },
    "DELETE /v1/twitter/bookmark": { bookmarked: false },
    "POST /v1/twitter/follow": { following: false, pending_follow: true },
    "DELETE /v1/twitter/follow": { following: false },
  });

  await native.repost({ account: x, postId: "123" }, context);
  await native.unrepost({ account: x, postId: "123" }, context);
  await native.bookmark({ account: x, postId: "123" }, context);
  await native.removeBookmark({ account: x, postId: "123" }, context);
  assert.deepEqual(await native.follow({ account: x, userId: "42" }, context), { pending: true });
  await native.unfollow({ account: x, userId: "42" }, context);

  assert.deepEqual(calls[0]?.body, { accountId: "x1", tweetId: "123" });
  assert.deepEqual(calls[1]?.query, { accountId: "x1", tweetId: "123" });
  assert.deepEqual(calls[4]?.body, { accountId: "x1", targetUserId: "42" });
  await assert.rejects(native.repost({ account: instagram, postId: "123" }, context), {
    code: "invalid_input",
  });
});

it("searches recent X posts through /v1/twitter/search", async () => {
  const { adapter, calls } = fake({
    "GET /v1/twitter/search": {
      tweets: [
        {
          id: "9",
          text: "sdk",
          created: "2026-11-03T00:00:00Z",
          likeCount: 1,
          author: { id: "a", username: "dev", name: "Dev", profileImageUrl: "https://p" },
        },
      ],
      pagination: { hasMore: true, cursor: "c2" },
    },
  });

  const page = await adapter.search.posts(x, { query: "social sdk", limit: 10 }, context);

  assert.deepEqual(calls[0]?.query, { accountId: "x1", query: "social sdk", limit: "10" });
  assert.deepEqual(page, {
    items: [
      {
        id: "9",
        text: "sdk",
        created: "2026-11-03T00:00:00Z",
        likeCount: 1,
        author: { id: "a", username: "dev", name: "Dev" },
      },
    ],
    nextCursor: "c2",
  });
  await assert.rejects(adapter.search.posts(x, { query: "q", scope: "all" }, context), {
    code: "invalid_input",
  });
});

it("declares Reddit and Telegram DMs and keeps attachment metadata without URLs [feature:zernio.messaging.core]", async () => {
  const conversation = {
    kind: "conversation",
    version: 1,
    backend: "default",
    platform: "telegram",
    accountId: "tg1",
    conversationId: "conv1",
  } as const;

  const { adapter, calls } = fake({
    "GET /v1/inbox/conversations/conv1/messages": {
      messages: [
        {
          id: "m1",
          message: "photo",
          direction: "incoming",
          attachments: [{ id: "a1", type: "image", url: "https://cdn.example/x?sig=secret" }],
        },
      ],
    },
    "POST /v1/inbox/conversations/conv1/messages": { success: true, data: { messageId: "m2" } },
  });

  const declared = adapter.capabilities.capabilities;

  for (const platform of ["reddit", "telegram"])
    assert.ok(declared.some((d) => d.platform === platform && d.operation === "messages.write"));

  const messages = await adapter.messages.listMessages(conversation, {}, context);

  assert.ok(!JSON.stringify(messages).includes("sig=secret"));
  assert.deepEqual(messages.items[0]?.["attachments"], [{ id: "a1", type: "image" }]);
  assert.deepEqual(await adapter.messages.send(conversation, { text: "hi" }, context), {
    state: "sent",
    messageId: "m2",
  });
  assert.deepEqual(calls[1]?.body, { accountId: "tg1", message: "hi" });
});

it("marks conversations read, starts conversations and sends attachments", async () => {
  const conversation = {
    kind: "conversation",
    version: 1,
    backend: "default",
    platform: "x",
    accountId: "x1",
    conversationId: "dm1",
  } as const;

  const { native, calls } = fake({
    "POST /v1/inbox/conversations/dm1/read": { success: true, markedCount: 3 },
    "POST /v1/inbox/conversations": {
      success: true,
      data: { conversationId: "dm2", messageId: "e1" },
    },
    "POST /v1/inbox/conversations/dm1/messages": { success: true, data: { messageId: "e2" } },
  });

  assert.deepEqual(await native.markConversationRead({ conversation }, context), {
    markedCount: 3,
  });

  const started = await native.startConversation(
    { account: x, recipient: { username: "@dev" }, text: "Hello" },
    context,
  );

  assert.equal(started.conversationId, "dm2");
  assert.deepEqual(calls[1]?.body, {
    accountId: "x1",
    message: "Hello",
    participantUsername: "@dev",
  });

  await native.sendMessage(
    { conversation, attachment: { url: "https://cdn.example.test/a.png", type: "image" } },
    context,
  );
  assert.deepEqual(calls[2]?.body, {
    accountId: "x1",
    attachmentUrl: "https://cdn.example.test/a.png",
    attachmentType: "image",
  });
});

it("lists /v1/inbox/mentions and /reviews and replies to a review", async () => {
  const linkedin = connectedAccountRef({
    backend: "default",
    platform: "linkedin",
    accountId: "li1",
  });

  const page = connectedAccountRef({ backend: "default", platform: "facebook", accountId: "fb1" });

  const { native, calls } = fake({
    "GET /v1/inbox/mentions": {
      data: [
        {
          id: "mn1",
          accountId: "li1",
          platform: "linkedin",
          content: "Thanks @Acme",
          authorPicture: "https://p",
        },
        { id: "mn2", accountId: "other", platform: "linkedin" },
      ],
      pagination: { hasMore: false, cursor: null },
    },
    "GET /v1/inbox/reviews": {
      data: [
        {
          id: "rv1",
          accountId: "fb1",
          rating: 5,
          text: "Great",
          hasReply: false,
          reviewer: { name: "Ana", profileImage: "https://p" },
        },
      ],
      pagination: { hasMore: false, nextCursor: null },
    },
    "POST /v1/inbox/reviews/rv1/reply": { reply: { id: "rp1", text: "Thank you" } },
  });

  const mentions = await native.listMentions({ account: linkedin }, context);

  assert.deepEqual(mentions.items, [{ id: "mn1", platform: "linkedin", content: "Thanks @Acme" }]);

  const reviews = await native.listReviews({ account: page, hasReply: false }, context);

  assert.deepEqual(reviews.items, [
    { id: "rv1", rating: 5, text: "Great", hasReply: false, reviewer: { name: "Ana" } },
  ]);
  assert.equal(calls[1]?.query["hasReply"], "false");
  assert.deepEqual(
    await native.replyToReview({ account: page, reviewId: "rv1", text: "Thank you" }, context),
    { id: "rp1", text: "Thank you" },
  );
});

it("manages /v1/webhooks settings without returning the secret", async () => {
  const hook = {
    _id: "wh1",
    name: "Prod",
    url: "https://app.example.com/hooks/zernio",
    secret: "whsec_live",
    events: ["post.published", "message.received"],
    isActive: true,
  };

  const { native, calls } = fake({
    "POST /v1/webhooks/settings": { success: true, webhook: hook },
    "GET /v1/webhooks/settings": { webhooks: [hook] },
    "PUT /v1/webhooks/settings": { success: true, webhook: { ...hook, isActive: false } },
    "POST /v1/webhooks/test": { success: true, message: "sent" },
    "DELETE /v1/webhooks/settings": { success: true },
  });

  const created = await native.createWebhook(
    {
      name: "Prod",
      url: "https://app.example.com/hooks/zernio",
      secret: "whsec_live",
      events: ["post.published", "message.received"],
    },
    context,
  );

  assert.ok(!JSON.stringify(created).includes("whsec_live"));
  assert.deepEqual(created["events"], ["post.published", "message.received"]);
  assert.equal((await native.listWebhooks(context)).length, 1);
  await native.updateWebhook({ webhookId: "wh1", isActive: false }, context);
  await native.testWebhook({ webhookId: "wh1", event: "post.failed" }, context);
  await native.deleteWebhook({ webhookId: "wh1" }, context);

  assert.deepEqual(calls[2]?.body, { _id: "wh1", isActive: false });
  assert.deepEqual(calls[3]?.body, { webhookId: "wh1", event: "post.failed" });
  assert.deepEqual(calls[4]?.query, { webhookId: "wh1" });
  await assert.rejects(
    native.createWebhook({ name: "x", url: "https://a.example", events: [] }, context),
    { code: "invalid_input" },
  );
});

it("reads follower-stats, account insights, YouTube daily-views, best-time and content-decay", async () => {
  const { native, calls } = fake({
    "GET /v1/accounts/follower-stats": {
      stats: { x1: [{ date: "2026-11-01", followers: 120 }], other: [{ followers: 9 }] },
      granularity: "daily",
    },
    "GET /v1/analytics/instagram/account-insights": {
      accountId: "ig1",
      metricType: "total_value",
      metrics: { reach: { total: 500 } },
    },
    "GET /v1/analytics/youtube/daily-views": {
      videoId: "vid1",
      totalViews: 40,
      dailyViews: [
        { date: "2026-11-01", views: 40, estimatedMinutesWatched: 12.5, averageViewDuration: 19 },
      ],
    },
    "GET /v1/analytics/best-time": {
      slots: [{ day_of_week: 1, hour: 14, avg_engagement: 8, post_count: 3 }],
    },
    "GET /v1/analytics/content-decay": {
      buckets: [{ bucket_order: 0, bucket_label: "0-6h", avg_pct_of_final: 45, post_count: 10 }],
    },
  });

  assert.deepEqual(await native.followerStats({ accounts: [x], fromDate: "2026-10-01" }, context), {
    stats: { x1: [{ date: "2026-11-01", followers: 120 }] },
    granularity: "daily",
  });
  assert.deepEqual(calls[0]?.query, { accountIds: "x1", fromDate: "2026-10-01" });

  assert.deepEqual(
    await native.accountInsights({ account: instagram, metrics: ["reach"] }, context),
    {
      metrics: { reach: { total: 500 } },
      metricType: "total_value",
    },
  );

  const daily = await native.youtubeDailyViews(
    { post: { ...xPost, platform: "youtube", accountId: "yt1", postId: "vid1" } },
    context,
  );

  assert.deepEqual(daily, {
    totalViews: 40,
    days: [
      { date: "2026-11-01", views: 40, estimatedMinutesWatched: 12.5, averageViewDuration: 19 },
    ],
  });
  assert.deepEqual(await native.bestTimes({ account: x }, context), [
    { day_of_week: 1, hour: 14, avg_engagement: 8, post_count: 3 },
  ]);
  assert.equal((await native.contentDecay({ account: x }, context))[0]?.["avg_pct_of_final"], 45);
  assert.equal(calls.at(-1)?.path, "/v1/analytics/content-decay");
});

it("decodes Zernio cancelled, recycled, external, message-state, reaction and review events", async () => {
  const { decodeWebhook } = await import("../src/server/webhooks.js");

  for (const [event, type] of [
    ["post.cancelled", "publication.updated"],
    ["post.recycled", "publication.updated"],
    ["post.external.created", "publication.updated"],
    ["post.external.updated", "publication.updated"],
    ["message.sent", "message.updated"],
    ["message.delivered", "message.updated"],
    ["message.read", "message.updated"],
    ["message.failed", "message.updated"],
    ["reaction.received", "reaction.received"],
    ["review.new", "review.updated"],
    ["review.deleted", "review.updated"],
    ["webhook.test", "unknown"],
  ] as const) {
    const decoded = await decodeWebhook({
      provider: "zernio",
      backend: "default",
      receivedAt: "2026-11-04T12:00:00Z",
      body: new TextEncoder().encode(
        JSON.stringify({ id: `evt-${event}`, event, account: { accountId: "acc1" } }),
      ),
    });

    assert.equal(decoded.type, type, event);
    assert.equal(decoded.originalType, event);
    assert.deepEqual(decoded.accountIds, ["acc1"]);
  }
});
