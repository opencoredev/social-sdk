import assert from "node:assert/strict";
import { it } from "node:test";
import { zernio } from "../src/cloud/zernio.js";
import { postForMe } from "../src/cloud/post-for-me.js";
import { platformPostRef, type AdapterOperationContext } from "../src/core/index.js";
import {
  canonicalMetricName,
  normalizeComment,
  normalizeMessage,
} from "../src/core/projections.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "normalized-reads",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10000 },
};

const post = platformPostRef({ backend: "default", platform: "x", accountId: "a1", postId: "p1" });

it("managed metrics add canonical names without changing provider names or zero counts", async () => {
  const adapter = postForMe({
    apiKey: "fixture",
    fetch: async () =>
      Response.json({
        data: [
          {
            platform_post_id: "p1",
            social_account_id: "a1",
            metrics: {
              public_metrics: {
                like_count: 0,
                reply_count: 3,
                retweet_count: 4,
                impression_count: 5,
              },
            },
          },
        ],
      }),
  });

  const metrics = await adapter.analytics.getPostMetrics(post, context);
  assert.deepEqual(
    metrics.map(({ name, canonicalName, value }) => [name, canonicalName, value]),
    [
      ["likes", "likes", 0],
      ["comments", "comments", 3],
      ["reposts", "shares", 4],
      ["impressions", "impressions", 5],
    ],
  );
});

it("Zernio comments retain provider fields and expose author, body, time and parent", async () => {
  const adapter = zernio({
    apiKey: "fixture",
    fetch: async () =>
      Response.json({
        comments: [
          {
            id: "c1",
            message: "A fixture reply",
            createdTime: "2026-10-01T12:00:00Z",
            parentId: "root",
            from: { id: "writer", username: "fixture", name: "Fixture Writer" },
            likeCount: 2,
          },
        ],
        pagination: { hasMore: false },
      }),
  });

  const page = await adapter.comments.list(post, {}, context);
  assert.equal(page.items[0]?.["id"], "c1");
  assert.equal(page.items[0]?.["text"], "A fixture reply");
  assert.equal(page.items[0]?.["authorId"], "writer");
  assert.equal(page.items[0]?.["authorHandle"], "fixture");
  assert.equal(page.items[0]?.["authorName"], "Fixture Writer");
  assert.equal(page.items[0]?.["createdAt"], "2026-10-01T12:00:00Z");
  assert.equal(page.items[0]?.["parentId"], "root");
  assert.equal(page.items[0]?.["message"], "A fixture reply");
  assert.ok(page.items[0]?.["native"]);
});

it("projects nested Bluesky, YouTube and LinkedIn comments without losing native data", () => {
  const bluesky = normalizeComment({
    post: {
      uri: "at://did:plc:writer/app.bsky.feed.post/reply",
      author: { did: "did:plc:writer", handle: "writer.test", displayName: "Writer" },
      record: {
        text: "Reply",
        createdAt: "2026-10-01T12:00:00Z",
        reply: {
          parent: { uri: "at://did:plc:writer/app.bsky.feed.post/root" },
        },
      },
    },
  });

  assert.equal(bluesky.id, "at://did:plc:writer/app.bsky.feed.post/reply");
  assert.equal(bluesky.authorId, "did:plc:writer");
  assert.equal(bluesky.authorHandle, "writer.test");
  assert.equal(bluesky.text, "Reply");
  assert.equal(bluesky.parentId, "at://did:plc:writer/app.bsky.feed.post/root");
  assert.deepEqual(normalizeComment(bluesky), bluesky);

  const youtube = normalizeComment({
    id: "thread",
    snippet: {
      topLevelComment: {
        id: "comment",
        snippet: {
          textDisplay: "Body",
          authorDisplayName: "Writer",
          authorChannelId: { value: "channel" },
          publishedAt: "2026-10-01T12:00:00Z",
        },
      },
    },
  });

  assert.equal(youtube.id, "comment");
  assert.equal(youtube.text, "Body");
  assert.equal(youtube.authorName, "Writer");
  assert.equal(youtube.authorId, "channel");
  assert.equal(youtube.createdAt, "2026-10-01T12:00:00Z");

  const linkedin = normalizeComment({
    id: "123",
    commentUrn: "urn:li:comment:(urn:li:activity:1,123)",
    actor: "urn:li:person:writer",
    message: { text: "Body" },
    created: { time: 1790856000000 },
  });

  assert.equal(linkedin.authorId, "urn:li:person:writer");
  assert.equal(linkedin.id, "urn:li:comment:(urn:li:activity:1,123)");
  assert.equal(linkedin.native["id"], "123");
  assert.equal(linkedin.text, "Body");
  assert.equal(linkedin.createdAt, "2026-10-01T12:00:00.000Z");
});

it("keeps unknown metrics and missing record fields absent without inventing values", () => {
  assert.equal(canonicalMetricName("profile_views"), "profile_views");
  assert.equal(canonicalMetricName("viewCount"), "views");
  assert.equal(canonicalMetricName("followers_count"), "followers");
  assert.equal(canonicalMetricName("engagementRate"), undefined);
  assert.equal(canonicalMetricName("follows"), undefined);
  assert.equal(canonicalMetricName("constructor"), undefined);
  assert.equal(canonicalMetricName("toString"), undefined);
  const message = normalizeMessage({ id: 123, text: { unexpected: true }, sender_id: "sender" });
  assert.equal(message.id, "123");
  assert.equal(message.text, undefined);
  assert.equal(message.authorId, "sender");
  assert.equal(message.native["id"], 123);
  assert.equal(message.createdAt, undefined);
});

it("Zernio conversations and messages preserve inbox content and safe nested fields", async () => {
  const adapter = zernio({
    apiKey: "fixture",
    fetch: async (input) => {
      if (String(input).includes("/messages"))
        return Response.json({
          messages: [
            {
              id: "m1",
              message: "Message body",
              senderId: "writer",
              senderName: "Writer",
              createdAt: "2026-10-01T12:00:00Z",
              access_token: "excluded",
            },
          ],
          pagination: {},
        });

      return Response.json({
        data: [
          {
            id: "c1",
            participantId: "writer",
            participantName: "Writer",
            lastMessage: { text: "Message body", senderId: "writer", privateToken: "excluded" },
            updatedTime: "2026-10-01T12:00:00Z",
            participants: [{ id: "writer", username: "fixture" }],
          },
        ],
        pagination: {},
      });
    },
  });

  const account = {
    kind: "connected-account",
    version: 1,
    backend: "default",
    platform: "x",
    accountId: "a1",
  } satisfies import("../src/core/types.js").ConnectedAccountRef;

  const conversations = await adapter.messages.listConversations(account, {}, context);
  assert.equal(conversations.items[0]?.["text"], "Message body");
  assert.equal(conversations.items[0]?.["authorId"], "writer");
  assert.equal(conversations.items[0]?.["updatedAt"], "2026-10-01T12:00:00Z");

  const messages = await adapter.messages.listMessages(
    { ...account, kind: "conversation", conversationId: "c1" },
    {},
    context,
  );

  assert.equal(messages.items[0]?.["text"], "Message body");
  assert.equal(messages.items[0]?.["authorName"], "Writer");
  assert.doesNotMatch(JSON.stringify([conversations, messages]), /excluded/);
});
