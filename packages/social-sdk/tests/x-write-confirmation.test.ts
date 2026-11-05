// SOC-37 write-confirmation sweep for X. Each native write is confirmed only by the success answer
// X OpenAPI 2.173 (https://api.x.com/2/openapi.json) documents for it. Every case sends one
// request: the documented answer resolves; malformed answers are `ambiguous_outcome` with
// `reconcile-first`. Fixtures are synthetic; no provider is called.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, createSocial, type AdapterOperationContext } from "../src/index.js";
import { SocialError } from "../src/core/errors.js";
import type { JsonValue } from "../src/core/types.js";
import { x, type XNative } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "11" });

const context = (): AdapterOperationContext => ({
  backendInstance: "default",
  correlationId: "x-write-confirmation",
  retryBudget: { maxAttempts: 3, maxElapsedMs: 10_000 },
});

function answering(body: JsonValue, status = 200) {
  let requests = 0;

  const adapter = x({
    auth: { userId: "11", accessToken: "fixture" },
    appBearerToken: "fixture-app",
    fetch: async () => {
      requests++;

      return Response.json(body, { status });
    },
  });

  assert.ok(adapter.native);

  return { api: adapter.native, requests: () => requests };
}

const uncertain = (error: SocialError) => {
  assert.ok(error instanceof SocialError);
  assert.equal(error.code, "ambiguous_outcome");
  assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });

  return true;
};

interface WriteCase {
  readonly name: string;
  readonly call: (api: XNative, context: AdapterOperationContext) => Promise<object | void>;
  /** The documented success answer. */
  readonly valid: JsonValue;
  /** Method-specific malformed answers, in addition to the shared envelope cases. */
  readonly malformed: readonly JsonValue[];
  readonly status?: number;
}

/** Envelopes no X write documents as success. */
const envelopes: readonly JsonValue[] = [null, [], "ok", {}, { data: null }, { data: [] }];

const post = (id: JsonValue, text: JsonValue = "hi") => ({ data: { id, text } });

const state = (field: string, value: JsonValue) => ({ data: { [field]: value } });

const writes: readonly WriteCase[] = [
  {
    name: "quote",
    call: (api, c) => api.quote({ account, text: "hi", quotedPostId: "7", context: c }),
    valid: post("1001"),
    malformed: [post("abc"), post(1001), post(""), { data: { id: "1001" } }],
    status: 201,
  },
  {
    name: "createPoll",
    call: (api, c) =>
      api.createPoll({ account, text: "q", options: ["a", "b"], durationMinutes: 60, context: c }),
    valid: post("1002"),
    malformed: [post("p1"), post("1002", 7)],
    status: 201,
  },
  {
    name: "updatePost",
    call: (api, c) => api.updatePost({ account, postId: "1001", text: "edited", context: c }),
    valid: { data: { id: "1003", text: "edited", edit_history_tweet_ids: ["1001", "1003"] } },
    malformed: [
      post("new"),
      { data: { id: "1003", text: 7 } },
      { data: { id: "1003", text: "edited", edit_history_tweet_ids: "1001" } },
      { data: { id: "1003", text: "edited", edit_history_tweet_ids: [1001] } },
    ],
  },
  {
    name: "createList",
    call: (api, c) => api.createList({ account, name: "L", context: c }),
    valid: { data: { id: "5", name: "L" } },
    malformed: [{ data: { id: "", name: "L" } }, { data: { id: "5" } }, { data: { name: "L" } }],
    status: 201,
  },
  {
    name: "updateList",
    call: (api, c) => api.updateList({ account, listId: "5", name: "L", context: c }),
    valid: state("updated", true),
    malformed: [state("updated", false), state("updated", "true")],
  },
  {
    name: "deleteList",
    call: (api, c) => api.deleteList({ account, listId: "5", context: c }),
    valid: state("deleted", true),
    malformed: [state("deleted", false), state("deleted", 1)],
  },
  {
    name: "addListMember",
    call: (api, c) => api.addListMember({ account, listId: "5", userId: "6", context: c }),
    valid: state("is_member", true),
    malformed: [state("is_member", false), state("is_member", "yes")],
  },
  {
    name: "removeListMember",
    call: (api, c) => api.removeListMember({ account, listId: "5", userId: "6", context: c }),
    valid: state("is_member", false),
    malformed: [state("is_member", true), state("is_member", null)],
  },
  {
    name: "followList",
    call: (api, c) => api.followList({ account, listId: "5", context: c }),
    valid: state("following", true),
    malformed: [state("following", false)],
  },
  {
    name: "unfollowList",
    call: (api, c) => api.unfollowList({ account, listId: "5", context: c }),
    valid: state("following", false),
    malformed: [state("following", true)],
  },
  {
    name: "pinList",
    call: (api, c) => api.pinList({ account, listId: "5", context: c }),
    valid: state("pinned", true),
    malformed: [state("pinned", false)],
  },
  {
    name: "unpinList",
    call: (api, c) => api.unpinList({ account, listId: "5", context: c }),
    valid: state("pinned", false),
    malformed: [state("pinned", true)],
  },
  {
    name: "hideReply",
    call: (api, c) => api.hideReply({ account, replyId: "8", hidden: true, context: c }),
    valid: state("hidden", true),
    malformed: [state("hidden", false), state("hidden", "true")],
  },
  {
    name: "bookmarkPosts",
    call: (api, c) => api.bookmarkPosts({ account, postIds: ["7"], context: c }),
    valid: { data: [{ tweet_id: "7", bookmarked: true }] },
    malformed: [
      { data: [{ tweet_id: 7, bookmarked: true }] },
      { data: [{ tweet_id: "7", bookmarked: "yes" }] },
      { data: [7] },
    ],
  },
  {
    name: "createCommunityNote",
    call: (api, c) =>
      api.createCommunityNote({
        account,
        note: {
          postId: "7",
          text: "Context: https://example.com/source",
          classification: "not_misleading",
          misleadingTags: [],
          trustworthySources: true,
          testMode: true,
        },
        context: c,
      }),
    valid: { data: { id: "9" } },
    malformed: [{ data: { id: "" } }, { data: { id: 9 } }],
    status: 201,
  },
  {
    name: "cancelComplianceJob",
    call: (api, c) => api.cancelComplianceJob({ account, jobId: "1", context: c }),
    valid: { data: { id: "1", type: "tweets", status: "failed" } },
    malformed: [
      { data: { id: "2", type: "tweets", status: "failed" } },
      { data: { id: "", type: "tweets", status: "failed" } },
      { data: { id: "1", type: "posts", status: "failed" } },
    ],
  },
  {
    name: "addStreamRules",
    call: (api, c) => api.addStreamRules({ account, rules: [{ value: "cats" }], context: c }),
    valid: {
      data: [{ id: "1", value: "cats" }],
      meta: { sent: "2026-11-05T00:00:00.000Z", summary: { created: 1, not_created: 0 } },
    },
    malformed: [
      { data: [{ id: "1", value: "cats" }] },
      { data: [{ id: "x", value: "cats" }], meta: { sent: "s", summary: { created: 1 } } },
      { meta: { sent: "s", summary: 1 } },
      { meta: { sent: "s", summary: {} }, errors: "duplicate" },
    ],
  },
  {
    name: "deleteStreamRules",
    call: (api, c) => api.deleteStreamRules({ account, ids: ["1"], context: c }),
    valid: { meta: { sent: "2026-11-05T00:00:00.000Z", summary: { deleted: 1 } } },
    malformed: [{ meta: { summary: { deleted: 1 } } }, { data: 1 }],
  },
  {
    name: "sendDirectMessage",
    call: (api, c) =>
      api.sendDirectMessage({ account, participantId: "2", text: "hi", context: c }),
    valid: { data: { dm_conversation_id: "2-11", dm_event_id: "3" } },
    malformed: [
      { data: { dm_event_id: "3" } },
      { data: { dm_conversation_id: "", dm_event_id: "3" } },
      { data: { dm_conversation_id: "2-11", dm_event_id: 3 } },
    ],
    status: 201,
  },
  {
    name: "attachSubtitles",
    call: (api, c) =>
      api.attachSubtitles({
        account,
        videoMediaId: "10",
        subtitleMediaId: "12",
        languageCode: "EN",
        context: c,
      }),
    valid: { data: { id: "10", media_category: "TweetVideo" } },
    malformed: [{ data: { id: "11" } }],
  },
  {
    name: "createActivitySubscription",
    call: (api, c) =>
      api.createActivitySubscription({
        account,
        eventType: "block.block",
        filter: { userId: "11" },
        context: c,
      }),
    valid: { data: { subscription: { subscription_id: "500" } } },
    malformed: [
      { data: { subscription: { id: "500" } } },
      { data: { subscription: "500" } },
      { data: { subscription: { subscription_id: "" } } },
    ],
  },
  {
    name: "updateActivitySubscription",
    call: (api, c) =>
      api.updateActivitySubscription({ account, subscriptionId: "500", tag: "t", context: c }),
    valid: { data: { subscription: { subscription_id: "500" }, total_subscriptions: 1 } },
    malformed: [
      { data: { subscription: { subscription_id: "501" } } },
      { data: { subscription: { subscription_id: "500" }, total_subscriptions: "1" } },
    ],
  },
  {
    name: "deleteActivitySubscriptions (one)",
    call: (api, c) =>
      api.deleteActivitySubscriptions({ account, subscriptionIds: ["500"], context: c }),
    valid: state("deleted", true),
    malformed: [state("deleted", false)],
  },
  {
    name: "deleteActivitySubscriptions (bulk)",
    call: (api, c) =>
      api.deleteActivitySubscriptions({ account, subscriptionIds: ["500", "501"], context: c }),
    valid: {
      data: [
        { deleted: true, subscription_id: "500" },
        { deleted: true, subscription_id: "501" },
      ],
    },
    malformed: [
      { data: [{ deleted: "yes", subscription_id: "500" }] },
      { data: [{ deleted: true, subscription_id: "999" }] },
      { data: { deleted: true } },
    ],
  },
  {
    name: "createArticleDraft",
    call: (api, c) =>
      api.createArticleDraft({
        account,
        title: "T",
        blocks: [{ text: "Body", type: "unstyled" }],
        context: c,
      }),
    valid: { data: { id: "20", title: "T" } },
    malformed: [{ data: { id: "20" } }, { data: { id: "", title: "T" } }],
    status: 201,
  },
  {
    name: "publishArticle",
    call: (api, c) => api.publishArticle({ account, articleId: "20", context: c }),
    valid: { data: { post_id: "1004" } },
    malformed: [{ data: { post_id: "article" } }, { data: { post_id: "" } }],
  },
  {
    name: "createCall",
    call: (api, c) => api.createCall({ account, title: "Call", context: c }),
    valid: { data: { id: "call1" } },
    malformed: [{ data: { id: "" } }, { data: { join_url: "https://x.com/i/calls/1" } }],
    status: 201,
  },
  {
    name: "joinCall",
    call: (api, c) => api.joinCall({ account, callId: "call1", context: c }),
    valid: { data: { session_id: "session1" } },
    malformed: [{ data: { media_url: "wss://media.example" } }, { data: { session_id: 1 } }],
  },
  {
    name: "setChatScreenCapture",
    call: (api, c) =>
      api.setChatScreenCapture({ account, conversationId: "g1", blocking: true, context: c }),
    valid: { data: { blocking: true, detection: false } },
    malformed: [{ data: { blocking: false } }, { data: { blocking: "true" } }],
  },
  {
    name: "addChatConversationKeys",
    call: (api, c) =>
      api.addChatConversationKeys({
        account,
        conversationId: "g1",
        conversationKeyVersion: "1",
        participantKeys: [{ userId: "2", encryptedConversationKey: "k", publicKeyVersion: "1" }],
        context: c,
      }),
    valid: { data: { conversation_id: "g1", sequence_id: "9" } },
    malformed: [{ data: { sequence_id: 9 } }, { data: { conversation_id: "g2" } }],
  },
  {
    name: "ensureDeveloperAccount",
    call: (api, c) => api.ensureDeveloperAccount({ account, context: c }),
    valid: { data: { account_id: "a1", created: true } },
    malformed: [{ data: { account_id: "", created: true } }, { data: { account_id: "a1" } }],
  },
  {
    name: "createBot",
    call: (api, c) => api.createBot({ account, handle: "mybot1", context: c }),
    valid: { data: { id: "1", token: "bot-token", scopes: ["dm.write"] } },
    malformed: [
      { data: { id: "1", token: "" } },
      { data: { id: "1", token: "bot-token", scopes: "dm.write" } },
      { data: { id: "1", token: "bot-token", username: 7 } },
    ],
    status: 201,
  },
  {
    name: "rotateBotToken",
    call: (api, c) => api.rotateBotToken({ account, botId: "1", context: c }),
    valid: { data: { id: "1", token: "bot-token" } },
    malformed: [{ data: { id: "2", token: "bot-token" } }],
  },
  {
    name: "endBroadcast",
    call: (api, c) => api.endBroadcast({ account, broadcastId: "1AbC", context: c }),
    valid: { data: { id: "1AbC", state: "ENDED" } },
    malformed: [
      { data: { id: "2XyZ", state: "ENDED" } },
      { data: { id: "1AbC", state: "RUNNING" } },
    ],
  },
  {
    name: "createUserBroadcast",
    call: (api, c) => api.createUserBroadcast({ account, sourceId: "src1", context: c }),
    valid: {
      data: { broadcast: { id: "1AbC" }, share_url: "https://x.com/i/broadcasts/1AbC" },
    },
    malformed: [
      { data: { broadcast: {}, share_url: "https://x.com/i/broadcasts/1AbC" } },
      { data: { broadcast: { id: "1AbC" }, share_url: "" } },
    ],
  },
  {
    name: "createUserStreamSource",
    call: (api, c) => api.createUserStreamSource({ account, name: "Studio", context: c }),
    valid: { data: { source: { id: "src1" } } },
    malformed: [{ data: { source: {} } }, { data: { source: "src1" } }],
  },
  {
    name: "renameUserStreamSource",
    call: (api, c) =>
      api.renameUserStreamSource({ account, sourceId: "src1", name: "Studio", context: c }),
    valid: { data: { source: { id: "src1" } } },
    malformed: [{ data: { source: { id: "src2" } } }],
  },
  {
    name: "createStreamSource",
    call: (api, c) =>
      api.createStreamSource({ account, name: "Studio", region: "us-east-1", context: c }),
    valid: { data: { id: "s1", stream_key: "stream-key" } },
    malformed: [{ data: { id: "s1", stream_key: "" } }, { data: { id: "", stream_key: "k" } }],
    status: 201,
  },
  {
    name: "sendBroadcastChat",
    call: (api, c) =>
      api.sendBroadcastChat({ account, broadcastId: "1AbC", text: "hi", context: c }),
    valid: { data: { success: true, timestamp: "1762300800000" } },
    malformed: [{ data: { success: true, timestamp: "" } }, { data: { success: false } }],
  },
  {
    name: "setChatModerator (add)",
    call: (api, c) => api.setChatModerator({ account, userId: "5", moderator: true, context: c }),
    valid: { data: { moderator_user_ids: ["5"] } },
    malformed: [{ data: { moderator_user_ids: ["6"] } }],
  },
  {
    name: "setChatModerator (remove)",
    call: (api, c) => api.setChatModerator({ account, userId: "5", moderator: false, context: c }),
    valid: { data: { moderator_user_ids: [] } },
    malformed: [{ data: { moderator_user_ids: ["5"] } }],
  },
];

describe("X writes are confirmed only by their documented answer", () => {
  for (const write of writes) {
    it(`${write.name}: the documented answer resolves after one request`, async () => {
      const { api, requests } = answering(write.valid, write.status);

      await write.call(api, context());
      assert.equal(requests(), 1);
    });

    for (const [index, body] of [...envelopes, ...write.malformed].entries())
      it(`${write.name}: malformed answer ${index + 1} is uncertain, sent once`, async () => {
        const { api, requests } = answering(body, write.status);

        await assert.rejects(write.call(api, context()), uncertain);
        assert.equal(requests(), 1);
      });
  }
});

describe("X publishing with an unreadable create answer", () => {
  // `posts.publish` reports an unconfirmed create as an unknown outcome instead of a raw error.
  for (const body of [null, [], {}, { data: 7 }, post("p1"), post(1001)])
    it(`reports an unknown outcome for ${JSON.stringify(body)}, sent once`, async () => {
      let requests = 0;

      const social = createSocial({
        backend: x({
          auth: { userId: "11", accessToken: "fixture" },
          fetch: async () => {
            requests++;

            return Response.json(body, { status: 201 });
          },
        }),
      });

      const result = await social.posts.publish({
        targets: [{ account }],
        content: { text: "hello" },
      });

      assert.equal(result.outcomes[0]?.state, "unknown");
      assert.equal(requests, 1);
    });

  it("publishes when X answers the documented numeric ID", async () => {
    const social = createSocial({
      backend: x({
        auth: { userId: "11", accessToken: "fixture" },
        fetch: async () => Response.json(post("1001", "hello"), { status: 201 }),
      }),
    });

    const result = await social.posts.publish({
      targets: [{ account }],
      content: { text: "hello" },
    });

    assert.equal(result.outcomes[0]?.state, "published");
  });
});

describe("X errors do not copy provider prose or URLs", () => {
  const sentinel = "private-sentinel-handle";

  for (const [name, call] of [
    [
      "getUserById",
      (api: XNative) => api.getUserById({ account, userId: "99", context: context() }),
    ],
    [
      "getUserByUsername",
      (api: XNative) => api.getUserByUsername({ account, username: sentinel, context: context() }),
    ],
  ] as const)
    it(`${name}: a not-found message is fixed`, async () => {
      const { api } = answering({
        errors: [
          { title: "Not Found Error", detail: `Could not find user with username: [${sentinel}].` },
        ],
      });

      await assert.rejects(call(api), (error: SocialError) => {
        assert.ok(error instanceof SocialError);
        assert.equal(error.code, "not_found");
        assert.ok(!error.message.includes(sentinel));
        assert.ok(!error.message.includes("Could not find"));

        return true;
      });
    });

  it("a failed compliance upload keeps neither the signed URL nor the fetch error", async () => {
    const signed = "https://storage.example/upload?X-Goog-Signature=private-signature";

    const adapter = x({
      auth: { userId: "11", accessToken: "fixture" },
      appBearerToken: "fixture-app",
      fetch: async () => {
        throw new TypeError(`fetch failed for ${signed}`);
      },
    });

    assert.ok(adapter.native);

    await assert.rejects(
      adapter.native.uploadComplianceIds({
        account,
        job: { uploadUrl: signed },
        ids: ["1"],
        context: context(),
      }),
      (error: SocialError) => {
        uncertain(error);
        assert.ok(error instanceof SocialError);
        assert.equal(error.cause, undefined);
        assert.ok(!error.message.includes("private-signature"));
        assert.ok(!JSON.stringify(error.details ?? {}).includes("private-signature"));

        return true;
      },
    );
  });

  it("a compliance upload answered with a 2xx other than 200 is uncertain", async () => {
    let requests = 0;

    const adapter = x({
      auth: { userId: "11", accessToken: "fixture" },
      fetch: async () => {
        requests++;

        return new Response(null, { status: 202 });
      },
    });

    assert.ok(adapter.native);

    await assert.rejects(
      adapter.native.uploadComplianceIds({
        account,
        job: { uploadUrl: "https://storage.example/upload?sig=1" },
        ids: ["1"],
        context: context(),
      }),
      uncertain,
    );
    assert.equal(requests, 1);
  });
});
