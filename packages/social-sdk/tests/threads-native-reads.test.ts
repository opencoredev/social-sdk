import { test } from "node:test";
import assert from "node:assert/strict";
import { threads } from "../src/platforms/threads.js";
import {
  connectedAccountRef,
  SocialError,
  type AdapterOperationContext,
  type JsonObject,
} from "../src/core/index.js";
import { decodePlatformWebhook } from "../src/server/webhooks.js";

const account = connectedAccountRef({ backend: "default", platform: "threads", accountId: "u1" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "fixture",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

interface Seen {
  readonly url: URL;
  readonly method: string;
  readonly authorization: string | null;
}

function recording(respond: (url: URL) => JsonObject = () => ({ data: [] })) {
  const seen: Seen[] = [];

  const adapter = threads({
    auth: { userId: "u1", accessToken: "user-fixture" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      seen.push({
        url,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
      });

      return Response.json(respond(url));
    },
  });

  const native = adapter.native;
  assert.ok(native);

  return { adapter, native, seen, last: () => seen.at(-1) };
}

const fields = (request: Seen | undefined) =>
  (request?.url.searchParams.get("fields") ?? "").split(",");

async function rejectsInvalid(promise: Promise<unknown>) {
  const error = await promise.catch((cause: unknown) => cause);

  assert.ok(error instanceof SocialError);
  assert.equal(error.code, "invalid_input");
}

test("Threads lists own posts with since, until, limit, before, and full fields [feature:threads.read.userThreads]", async () => {
  const { adapter, native, last } = recording(() => ({
    data: [
      {
        id: "1",
        text: "hi",
        topic_tag: "News",
        media_url: "https://cdn.example.test/a.jpg",
        quoted_post: { id: "9" },
      },
    ],
  }));

  const page = await native.listThreads({
    account,
    since: "2026-01-01",
    until: "1767225600",
    limit: 50,
    before: "BEFORE",
    context,
  });

  const params = last()?.url.searchParams;
  assert.equal(last()?.url.pathname, "/v1.0/u1/threads");
  assert.equal(params?.get("since"), "2026-01-01");
  assert.equal(params?.get("until"), "1767225600");
  assert.equal(params?.get("limit"), "50");
  assert.equal(params?.get("before"), "BEFORE");
  assert.equal(params?.get("after"), null);
  assert.ok(fields(last()).includes("quoted_post"));
  assert.ok(fields(last()).includes("owner"));
  assert.deepEqual(page["data"], [
    {
      id: "1",
      text: "hi",
      topic_tag: "News",
      media_url: "https://cdn.example.test/a.jpg",
      quoted_post: { id: "9" },
    },
  ]);

  await native.listThreads({ account, cursor: "AFTER", fields: ["id", "text"], context });
  assert.equal(last()?.url.searchParams.get("after"), "AFTER");
  assert.equal(last()?.url.searchParams.get("fields"), "id,text");

  await rejectsInvalid(native.listThreads({ account, cursor: "a", before: "b", context }));
  await rejectsInvalid(native.listThreads({ account, limit: 101, context }));
  await rejectsInvalid(native.listThreads({ account, fields: ["id&x=1"], context }));

  // posts.list keeps scalar fields such as topic_tag and media_url.
  const listed = await adapter.posts!.list!(account, {}, context);
  assert.deepEqual(listed.items, [
    { id: "1", text: "hi", topic_tag: "News", media_url: "https://cdn.example.test/a.jpg" },
  ]);
});

test("Threads media reads request the documented field set and accept overrides [feature:threads.read.media]", async () => {
  const { native, last } = recording(() => ({
    id: "m1",
    media_type: "VIDEO",
    thumbnail_url: "https://cdn.example.test/t.jpg",
  }));

  const media = await native.getPost("m1", context);
  const requested = fields(last());

  for (const field of ["media_url", "thumbnail_url", "gif_url", "children", "text_attachment"])
    assert.ok(requested.includes(field), field);
  assert.equal(media["thumbnail_url"], "https://cdn.example.test/t.jpg");

  await native.getPost("m1", context, ["id", "location_id", "allowlisted_country_codes"]);
  assert.equal(last()?.url.searchParams.get("fields"), "id,location_id,allowlisted_country_codes");
});

test("Threads decodes poll results with total_votes and vote shares", async () => {
  const { native, last } = recording(() => ({
    id: "m1",
    poll_attachment: {
      option_a: "Yes",
      option_b: "No",
      option_a_votes_percentage: 0.25,
      option_b_votes_percentage: 0.75,
      total_votes: 100,
      expiration_timestamp: "2026-11-05T23:00:00+0000",
    },
  }));

  const results = await native.getPollResults({ account, postId: "m1", context });
  assert.match(last()?.url.searchParams.get("fields") ?? "", /total_votes/);
  assert.deepEqual(results, {
    options: [
      { text: "Yes", votesPercentage: 0.25 },
      { text: "No", votesPercentage: 0.75 },
    ],
    totalVotes: 100,
    expiresAt: "2026-11-05T23:00:00+0000",
  });
});

test("Threads lists own replies, ghost posts, and public profile posts", async () => {
  const { native, last } = recording();

  await native.listOwnReplies({ account, limit: 10, context });
  assert.equal(last()?.url.pathname, "/v1.0/u1/replies");
  assert.ok(fields(last()).includes("is_reply_owned_by_me"));
  assert.ok(fields(last()).includes("root_post"));

  await native.listGhostPosts({ account, since: "1767225600", context });
  assert.equal(last()?.url.pathname, "/v1.0/u1/ghost_posts");
  assert.ok(fields(last()).includes("ghost_post_status"));
  assert.ok(fields(last()).includes("ghost_post_expiration_timestamp"));

  await native.profilePosts({ account, username: "@meta", limit: 5, context });
  assert.equal(last()?.url.pathname, "/v1.0/profile_posts");
  assert.equal(last()?.url.searchParams.get("username"), "meta");
  assert.equal(last()?.url.searchParams.get("limit"), "5");
  assert.ok(!fields(last()).includes("owner"));
  await rejectsInvalid(native.profilePosts({ account, username: "not a name", context }));
});

test("Threads reads recently_searched_keywords and is_eligible_for_geo_gating", async () => {
  const { native, last } = recording((url) =>
    url.searchParams.get("fields")?.includes("recently_searched_keywords")
      ? {
          id: "u1",
          recently_searched_keywords: [
            { query: "open source", timestamp: 1735707600000 },
            { timestamp: 1 },
          ],
        }
      : { id: "u1", is_eligible_for_geo_gating: true },
  );

  assert.deepEqual(await native.recentlySearchedKeywords({ account, context }), [
    { query: "open source", timestamp: 1735707600000 },
  ]);
  assert.equal(last()?.url.searchParams.get("fields"), "id,recently_searched_keywords");

  assert.equal(await native.geoGatingEligibility({ account, context }), true);
  assert.equal(last()?.url.searchParams.get("fields"), "id,is_eligible_for_geo_gating");

  const missing = recording(() => ({ id: "u1" }));

  const error = await missing.native
    .geoGatingEligibility({ account, context })
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SocialError);
  assert.equal(error.code, "upstream_failure");
});

test("Threads mentions send since, until, limit, and cursors [feature:threads.mentions.read]", async () => {
  const { native, last } = recording();

  await native.mentions({
    account,
    since: "1688540400",
    until: "1767225600",
    limit: 100,
    cursor: "AFTER",
    context,
  });

  const params = last()?.url.searchParams;
  assert.equal(last()?.url.pathname, "/v1.0/u1/mentions");
  assert.equal(params?.get("since"), "1688540400");
  assert.equal(params?.get("until"), "1767225600");
  assert.equal(params?.get("limit"), "100");
  assert.equal(params?.get("after"), "AFTER");
  assert.equal(params?.get("fields"), "id,text,username,media_type,media_url,permalink,timestamp");
});

test("Threads reply reads send reverse ordering", async () => {
  const { native, last } = recording();

  await native.listReplies({ account, mediaId: "m1", reverse: false, context });
  assert.equal(last()?.url.pathname, "/v1.0/m1/replies");
  assert.equal(last()?.url.searchParams.get("reverse"), "false");
  assert.ok(fields(last()).includes("is_reply_owned_by_me"));

  await native.listConversation({ account, mediaId: "m1", reverse: true, cursor: "c", context });
  assert.equal(last()?.url.pathname, "/v1.0/m1/conversation");
  assert.equal(last()?.url.searchParams.get("reverse"), "true");
  assert.equal(last()?.url.searchParams.get("after"), "c");

  await native.listPendingReplies({ account, mediaId: "m1", reverse: false, context });
  assert.equal(last()?.url.searchParams.get("reverse"), "false");
});

test("Threads publishing limit returns reply_quota_usage and delete_quota_usage", async () => {
  const quota = {
    quota_usage: 1,
    config: { quota_total: 250, quota_duration: 86400 },
    reply_quota_usage: 3,
    reply_config: { quota_total: 1000, quota_duration: 86400 },
    delete_quota_usage: 2,
    delete_config: { quota_total: 100, quota_duration: 86400 },
  };

  const { native, last } = recording(() => ({ data: [quota] }));

  const result = await native.publishingLimit({ account, context });
  assert.deepEqual(result["data"], [quota]);

  await native.publishingLimit({
    account,
    fields: ["location_search_quota_usage", "location_search_config"],
    context,
  });
  assert.equal(
    last()?.url.searchParams.get("fields"),
    "location_search_quota_usage,location_search_config",
  );
});

test("Threads user insights send since and until and keep series and per-link clicks [feature:threads.analytics.user]", async () => {
  const { native, last } = recording(() => ({
    data: [
      {
        name: "views",
        period: "day",
        values: [
          { value: 10, end_time: "2026-10-01T07:00:00+0000" },
          { value: 20, end_time: "2026-10-02T07:00:00+0000" },
        ],
      },
      {
        name: "clicks",
        period: "day",
        link_total_values: [
          { value: 11, link_url: "https://example.com/a" },
          { value: 4, link_url: "https://example.com/b" },
        ],
      },
      { name: "likes", period: "day", total_value: { value: 7 } },
    ],
  }));

  const rows = await native.userInsights({
    account,
    metrics: ["views", "clicks", "likes"],
    range: { since: 1_759_276_800, until: 1_759_449_600 },
    context,
  });

  const params = last()?.url.searchParams;
  assert.equal(last()?.url.pathname, "/v1.0/u1/threads_insights");
  assert.equal(params?.get("metric"), "views,clicks,likes");
  assert.equal(params?.get("since"), "1759276800");
  assert.equal(params?.get("until"), "1759449600");
  assert.deepEqual(rows, [
    {
      name: "views",
      period: "day",
      series: [
        { value: 10, endTime: "2026-10-01T07:00:00+0000" },
        { value: 20, endTime: "2026-10-02T07:00:00+0000" },
      ],
      links: [],
    },
    {
      name: "clicks",
      period: "day",
      series: [],
      links: [
        { url: "https://example.com/a", value: 11 },
        { url: "https://example.com/b", value: 4 },
      ],
    },
    { name: "likes", period: "day", series: [], links: [], total: 7 },
  ]);

  await rejectsInvalid(
    native.userInsights({
      account,
      metrics: ["views"],
      range: { since: 1_712_991_599, until: 1_759_449_600 },
      context,
    }),
  );
  await rejectsInvalid(
    native.userInsights({
      account,
      metrics: ["followers_count"],
      range: { since: 1_759_276_800, until: 1_759_449_600 },
      context,
    }),
  );
});

test("Threads follower demographics send one breakdown", async () => {
  const { native, last } = recording(() => ({ data: [{ name: "follower_demographics" }] }));

  await native.followerDemographics({ account, breakdown: "country", context });
  assert.equal(last()?.url.searchParams.get("metric"), "follower_demographics");
  assert.equal(last()?.url.searchParams.get("breakdown"), "country");
});

test("Threads location_search sends a query or coordinates and decodes locations", async () => {
  const { adapter, native, last } = recording((url) =>
    url.pathname.endsWith("/location_search")
      ? {
          data: [
            {
              id: 12345,
              name: "Facebook Headquarters",
              city: "Menlo Park",
              latitude: 37.48,
              longitude: -122.14,
              postal_code: "94025",
            },
          ],
        }
      : { id: "12345", name: "Facebook Headquarters", address: "1 Hacker Way" },
  );

  const found = await native.locationSearch({
    account,
    query: "Menlo Park",
    coordinates: { latitude: 37.48, longitude: -122.14 },
    context,
  });

  assert.equal(last()?.url.pathname, "/v1.0/location_search");
  assert.equal(last()?.url.searchParams.get("q"), "Menlo Park");
  assert.equal(last()?.url.searchParams.get("latitude"), "37.48");
  assert.equal(last()?.url.searchParams.get("longitude"), "-122.14");
  assert.deepEqual(found, [
    {
      id: "12345",
      name: "Facebook Headquarters",
      city: "Menlo Park",
      latitude: 37.48,
      longitude: -122.14,
      postalCode: "94025",
    },
  ]);

  await native.locationSearch({ account, coordinates: { latitude: 1, longitude: 2 }, context });
  assert.equal(last()?.url.searchParams.get("q"), null);
  await rejectsInvalid(
    native.locationSearch({ account, coordinates: { latitude: 91, longitude: 0 }, context }),
  );
  await rejectsInvalid(native.locationSearch({ account, query: " ", context }));

  assert.deepEqual(await native.getLocation({ account, locationId: "12345", context }), {
    id: "12345",
    name: "Facebook Headquarters",
    address: "1 Hacker Way",
  });
  assert.equal(last()?.url.pathname, "/v1.0/12345");
  await rejectsInvalid(native.getLocation({ account, locationId: "abc", context }));

  assert.deepEqual(
    adapter.capabilities.capabilities.find((entry) => entry.operation === "locations.search")
      ?.requiredScopes,
    ["threads_basic", "threads_location_tagging"],
  );
});

test("Threads /debug_token inspects a token with the user or app access token", async () => {
  const { native, last } = recording(() => ({
    data: {
      type: "USER",
      application: "Fixture App",
      is_valid: true,
      expires_at: 1752254132,
      issued_at: 1747070132,
      scopes: ["threads_basic", "threads_location_tagging"],
      user_id: "u1",
    },
  }));

  const own = await native.debugToken({ context });
  assert.equal(last()?.url.pathname, "/v1.0/debug_token");
  assert.equal(last()?.url.searchParams.get("input_token"), "user-fixture");
  assert.equal(last()?.authorization, "Bearer user-fixture");
  assert.deepEqual(own, {
    isValid: true,
    scopes: ["threads_basic", "threads_location_tagging"],
    type: "USER",
    application: "Fixture App",
    expiresAt: 1752254132,
    issuedAt: 1747070132,
    userId: "u1",
  });

  await native.debugToken({
    inputToken: "other-fixture",
    appAccessToken: "TH|123|app-secret-fixture",
    context,
  });
  assert.equal(last()?.url.searchParams.get("input_token"), "other-fixture");
  assert.equal(last()?.authorization, "Bearer TH|123|app-secret-fixture");

  await rejectsInvalid(native.debugToken({ appAccessToken: "not-an-app-token", context }));
});

test("Threads oembed sends url and maxwidth and decodes the embed", async () => {
  const { native, last } = recording(() => ({
    html: "<blockquote>post</blockquote>",
    provider_name: "Threads",
    provider_url: "https://www.threads.com/",
    type: "rich",
    version: "1.0",
    width: 658,
  }));

  const embed = await native.oembed({
    url: "https://www.threads.com/@meta/post/DDzbnVKx57R",
    maxWidth: 400,
    context,
  });

  assert.equal(last()?.url.pathname, "/v1.0/oembed");
  assert.equal(
    last()?.url.searchParams.get("url"),
    "https://www.threads.com/@meta/post/DDzbnVKx57R",
  );
  assert.equal(last()?.url.searchParams.get("maxwidth"), "400");
  assert.deepEqual(embed, {
    html: "<blockquote>post</blockquote>",
    providerName: "Threads",
    providerUrl: "https://www.threads.com/",
    type: "rich",
    version: "1.0",
    width: 658,
  });

  await native.oembed({ url: "https://www.threads.com/t/DDzbnVKx57R", context });
  await native.oembed({ url: "https://www.threads.com/@meta", context });
  await rejectsInvalid(native.oembed({ url: "https://example.com/@meta", context }));
  await rejectsInvalid(
    native.oembed({ url: "https://www.threads.com/@meta", maxWidth: 700, context }),
  );
});

test("Threads repost posts to /{media-id}/repost and requires the repost ID [feature:threads.engagement.repost]", async () => {
  const { native, last } = recording(() => ({ id: "repost-1" }));

  const result = await native.repost({ account, postId: "17890000000000001", context });
  assert.equal(last()?.method, "POST");
  assert.equal(last()?.url.pathname, "/v1.0/17890000000000001/repost");
  assert.deepEqual(result, { id: "repost-1" });

  const missing = recording(() => ({}));

  const error = await missing.native
    .repost({ account, postId: "17890000000000001", context })
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SocialError);
  assert.equal(error.code, "ambiguous_outcome");
  await rejectsInvalid(native.repost({ account, postId: "not-numeric", context }));
});

test("Threads native quotePost sends quote_post_id on a TEXT container", async () => {
  const { native, seen } = recording((url) =>
    url.pathname.endsWith("/threads") ? { id: "container-1" } : { id: "quote-1" },
  );

  await native.quotePost({ account, postId: "17890000000000001", text: "Look", context });
  const create = seen[0]?.url.searchParams;
  assert.equal(create?.get("media_type"), "TEXT");
  assert.equal(create?.get("text"), "Look");
  assert.equal(create?.get("quote_post_id"), "17890000000000001");
  assert.equal(seen[1]?.url.searchParams.get("creation_id"), "container-1");
});

const webhook = (body: JsonObject) =>
  decodePlatformWebhook({
    platform: "threads",
    backend: "direct",
    body: new TextEncoder().encode(JSON.stringify(body)),
  });

test("Threads mentions webhooks decode as mention.received for the mentioned user [feature:threads.webhooks.mentions]", async () => {
  const event = await webhook({
    app_id: "123456",
    topic: "interaction",
    target_id: "78901",
    time: 1723226877,
    values: { field: "mentions", value: { id: "8901234", text: "hi @you" } },
  });

  assert.equal(event.type, "mention.received");
  assert.equal(event.originalType, "mentions");
  assert.deepEqual(event.accountIds, ["78901"]);
});

test("Threads publish webhooks decode as post.published without an owner [feature:threads.webhooks.publish]", async () => {
  const event = await webhook({
    app_id: "123456",
    topic: "interaction",
    target_id: "78901",
    time: 1723226877,
    values: { field: "publish", value: { id: "8901234", media_type: "TEXT_POST" } },
  });

  assert.equal(event.type, "post.published");
  assert.equal(event.originalType, "publish");
  assert.deepEqual(event.accountIds, []);
});
