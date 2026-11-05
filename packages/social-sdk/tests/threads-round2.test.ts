import { test } from "node:test";
import assert from "node:assert/strict";
import { threads, threadsFollowIntentUrl, threadsPostIntentUrl } from "../src/platforms/threads.js";
import {
  connectedAccountRef,
  SocialError,
  type AdapterOperationContext,
  type JsonObject,
} from "../src/core/index.js";

const account = connectedAccountRef({ backend: "default", platform: "threads", accountId: "u1" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "fixture",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

function recording(respond: (url: URL) => JsonObject = () => ({ data: [] })) {
  const seen: URL[] = [];

  const adapter = threads({
    auth: { userId: "u1", accessToken: "user-fixture" },
    fetch: async (input) => {
      const url = new URL(String(input));
      seen.push(url);

      return Response.json(respond(url));
    },
  });

  const native = adapter.native;
  assert.ok(native);

  return { adapter, native, seen, last: () => seen.at(-1) };
}

async function rejectsInvalid(promise: Promise<JsonObject>) {
  const error = await promise.then(
    () => undefined,
    (cause: Error) => cause,
  );

  assert.ok(error instanceof SocialError);
  assert.equal(error.code, "invalid_input");
}

function throwsInvalid(build: () => string) {
  assert.throws(build, (error) => error instanceof SocialError && error.code === "invalid_input");
}

test("Threads profile lookup decodes follower_count and 7-day views_count, likes_count, quotes_count, reposts_count", async () => {
  const { adapter, native, last } = recording(() => ({
    username: "meta",
    name: "Meta",
    profile_picture_url: "https://cdn.example.test/p.jpg",
    biography: "Bio",
    is_verified: true,
    follower_count: 1200,
    likes_count: 30,
    quotes_count: 4,
    reposts_count: 5,
    views_count: 9000,
  }));

  const profile = await native.lookupProfile({ account, username: "@meta", context });

  assert.equal(last()?.pathname, "/v1.0/profile_lookup");
  assert.equal(last()?.searchParams.get("username"), "meta");
  assert.equal(
    last()?.searchParams.get("fields"),
    "username,name,profile_picture_url,biography,is_verified,follower_count,likes_count,quotes_count,reposts_count,views_count",
  );
  assert.deepEqual(profile, {
    username: "meta",
    name: "Meta",
    profilePictureUrl: "https://cdn.example.test/p.jpg",
    biography: "Bio",
    isVerified: true,
    followerCount: 1200,
    likesCount: 30,
    quotesCount: 4,
    repostsCount: 5,
    viewsCount: 9000,
  });

  const normalized = await adapter.graph?.getProfile?.(account, { handle: "meta" }, context);

  assert.equal(normalized?.native?.["views_count"], 9000);
  assert.equal(normalized?.native?.["follower_count"], 1200);
});

test("Threads profile lookup omits missing counts and rejects malformed ones", async () => {
  const sparse = recording(() => ({ username: "meta" }));

  assert.deepEqual(await sparse.native.lookupProfile({ account, username: "meta", context }), {
    username: "meta",
  });

  const malformed = recording(() => ({ username: "meta", views_count: "lots" }));

  const error = await malformed.native.lookupProfile({ account, username: "meta", context }).then(
    () => undefined,
    (cause: Error) => cause,
  );

  assert.ok(error instanceof SocialError);
  assert.notEqual(error.code, "invalid_input");

  const invalid = recording();

  const rejected = await invalid.native
    .lookupProfile({ account, username: "not a handle", context })
    .then(
      () => undefined,
      (cause: Error) => cause,
    );

  assert.ok(rejected instanceof SocialError);
  assert.equal(rejected.code, "invalid_input");
  assert.equal(invalid.seen.length, 0);
});

test("Threads conversation and pending replies accept fields and before [feature:threads.comments.replyReadOptions]", async () => {
  const { native, last, seen } = recording();

  await native.listConversation({
    account,
    mediaId: "m1",
    before: "B1",
    fields: ["id", "is_verified", "profile_picture_url", "root_post", "replied_to", "topic_tag"],
    context,
  });
  assert.equal(last()?.pathname, "/v1.0/m1/conversation");
  assert.equal(
    last()?.searchParams.get("fields"),
    "id,is_verified,profile_picture_url,root_post,replied_to,topic_tag",
  );
  assert.equal(last()?.searchParams.get("before"), "B1");
  assert.equal(last()?.searchParams.has("after"), false);

  await native.listPendingReplies({
    account,
    mediaId: "m1",
    before: "B2",
    approvalStatus: "ignored",
    fields: ["id", "media_url", "gif_url", "reply_audience", "reply_approval_status"],
    context,
  });
  assert.equal(last()?.pathname, "/v1.0/m1/pending_replies");
  assert.equal(
    last()?.searchParams.get("fields"),
    "id,media_url,gif_url,reply_audience,reply_approval_status",
  );
  assert.equal(last()?.searchParams.get("before"), "B2");
  assert.equal(last()?.searchParams.get("approval_status"), "ignored");

  await native.listPendingReplies({ account, mediaId: "m1", context });
  assert.equal(
    last()?.searchParams.get("fields"),
    "id,text,username,timestamp,is_reply,hide_status,reply_approval_status",
  );

  const sent = seen.length;

  await rejectsInvalid(
    native.listConversation({ account, mediaId: "m1", cursor: "A", before: "B", context }),
  );
  await rejectsInvalid(native.listPendingReplies({ account, mediaId: "m1", fields: [], context }));
  assert.equal(seen.length, sent);
});

test("Threads native search sends a fields override [feature:threads.search.resultFields]", async () => {
  const { native, last } = recording(() => ({
    data: [{ id: "1", topic_tag: "News", poll_attachment: { option_a: "Yes" } }],
  }));

  const result = await native.search({
    account,
    query: "open source",
    fields: ["id", "topic_tag", "poll_attachment", "gif_url", "root_post", "quoted_post"],
    context,
  });

  assert.equal(last()?.pathname, "/v1.0/keyword_search");
  assert.equal(
    last()?.searchParams.get("fields"),
    "id,topic_tag,poll_attachment,gif_url,root_post,quoted_post",
  );
  assert.deepEqual(result["data"], [
    { id: "1", topic_tag: "News", poll_attachment: { option_a: "Yes" } },
  ]);

  await native.search({ account, query: "open source", context });
  assert.equal(
    last()?.searchParams.get("fields"),
    "id,text,media_type,media_url,permalink,timestamp,username,shortcode,is_quote_post",
  );

  await rejectsInvalid(native.search({ account, query: "x", fields: ["bad field"], context }));
});

test("Threads builds intent/post and intent/follow web intent URLs", () => {
  const post = new URL(
    threadsPostIntentUrl({
      text: "Say more & share",
      url: "https://example.test/a?b=1",
      tag: "Open Source",
      replyControl: "followers_only",
      replyPostShortcode: "DRM8DF9AGUc",
      quotePostShortcode: "DPgzLZcAJPr",
    }),
  );

  assert.equal(post.origin + post.pathname, "https://www.threads.com/intent/post");
  assert.equal(post.searchParams.get("text"), "Say more & share");
  assert.equal(post.searchParams.get("url"), "https://example.test/a?b=1");
  assert.equal(post.searchParams.get("tag"), "Open Source");
  assert.equal(post.searchParams.get("reply_control"), "followers_only");
  assert.equal(post.searchParams.get("reply_post_shortcode"), "DRM8DF9AGUc");
  assert.equal(post.searchParams.get("quote_post_shortcode"), "DPgzLZcAJPr");
  assert.equal(threadsPostIntentUrl({}), "https://www.threads.com/intent/post");

  assert.equal(
    threadsFollowIntentUrl("@threads"),
    "https://www.threads.com/intent/follow?username=threads",
  );

  throwsInvalid(() => threadsPostIntentUrl({ tag: "a.b" }));
  throwsInvalid(() => threadsPostIntentUrl({ tag: "x".repeat(51) }));
  throwsInvalid(() => threadsPostIntentUrl({ url: "javascript:alert(1)" }));
  throwsInvalid(() => threadsPostIntentUrl({ url: "not a url" }));
  throwsInvalid(() => threadsPostIntentUrl({ replyPostShortcode: "a/b" }));
  throwsInvalid(() => threadsFollowIntentUrl("two words"));
});
