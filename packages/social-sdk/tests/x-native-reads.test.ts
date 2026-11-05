import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, type AdapterOperationContext } from "../src/index.js";
import { definedFields } from "../src/core/fields.js";
import type { JsonValue } from "../src/core/types.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "11" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "x-reads",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

interface Seen {
  readonly method: string;
  readonly href: string;
  readonly authorization: string | null;
  readonly body: JsonValue | undefined;
}

function fake(
  routes: Readonly<Record<string, JsonValue>>,
  credentials: { accessToken?: string; appBearerToken?: string } = { accessToken: "user" },
) {
  const seen: Seen[] = [];

  const adapter = x({
    auth: { userId: "11", ...definedFields({ accessToken: credentials.accessToken }) },
    ...definedFields({ appBearerToken: credentials.appBearerToken }),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      seen.push({
        method: init?.method ?? "GET",
        href: url.href,
        authorization: new Headers(init?.headers).get("authorization"),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });

      const response = routes[`${init?.method ?? "GET"} ${url.pathname}`] ?? routes[url.pathname];

      return response === undefined
        ? Response.json({ title: "Not Found" }, { status: 404 })
        : Response.json(response);
    },
  });

  assert.ok(adapter.native);

  return { native: adapter.native, seen };
}

const query = (seen: readonly Seen[], index = 0) =>
  Object.fromEntries(new URL(seen[index]?.href ?? "https://invalid").searchParams);

it("looks up Posts in one batch with GET /2/tweets?ids= [feature:x.read.posts_batch]", async () => {
  const { native, seen } = fake({
    "/2/tweets": {
      data: [{ id: "1", text: "one", edit_controls: { editable_until: "2026-11-04T10:00:00Z" } }],
      errors: [{ resource_id: "2", title: "Not Found Error" }],
      includes: { users: [{ id: "11", username: "opencoredev" }] },
    },
  });

  const page = await native.getPosts({
    account,
    postIds: ["1", "2"],
    fields: { tweetFields: ["id", "text", "edit_controls", "note_tweet", "paid_partnership"] },
    context,
  });

  assert.equal(
    seen[0]?.href,
    "https://api.x.com/2/tweets?ids=1%2C2&tweet.fields=id%2Ctext%2Cedit_controls%2Cnote_tweet%2Cpaid_partnership&expansions=author_id%2Creferenced_tweets.id%2Cattachments.media_keys&user.fields=id%2Cname%2Cusername%2Cdescription%2Ccreated_at%2Cpublic_metrics&media.fields=media_key%2Ctype%2Curl%2Cpreview_image_url%2Cduration_ms%2Cheight%2Cwidth",
  );
  assert.deepEqual(page.items, [
    { id: "1", text: "one", edit_controls: { editable_until: "2026-11-04T10:00:00Z" } },
  ]);
  assert.deepEqual(page.metadata, {
    includes: { users: [{ id: "11", username: "opencoredev" }] },
    errors: [{ resource_id: "2", title: "Not Found Error" }],
  });
  await assert.rejects(native.getPosts({ account, postIds: [], context }), {
    code: "invalid_input",
  });
  assert.equal(seen.length, 1);
});

it("reads quote Posts, reposters, reposts and reposts of me [feature:x.read.quote_posts] [feature:x.read.reposted_by]", async () => {
  const { native, seen } = fake({
    "/2/tweets/5/quote_tweets": { data: [{ id: "6", text: "quote" }], meta: { next_token: "q2" } },
    "/2/tweets/5/retweeted_by": { data: [{ id: "12", username: "fan" }] },
    "/2/tweets/5/retweets": { data: [{ id: "7", text: "RT" }] },
    "/2/users/reposts_of_me": { data: [{ id: "8", text: "mine" }], meta: { next_token: "r2" } },
  });

  const quotes = await native.quotePosts({
    account,
    postId: "5",
    exclude: ["replies"],
    limit: 10,
    cursor: "q1",
    context,
  });

  assert.deepEqual(quotes, { items: [{ id: "6", text: "quote" }], nextCursor: "q2" });
  assert.equal(new URL(seen[0]?.href ?? "").pathname, "/2/tweets/5/quote_tweets");
  assert.equal(query(seen)["exclude"], "replies");
  assert.equal(query(seen)["max_results"], "10");
  assert.equal(query(seen)["pagination_token"], "q1");

  const reposters = await native.repostedBy({ account, postId: "5", userFields: ["id"], context });
  assert.deepEqual(reposters.items, [{ id: "12", username: "fan" }]);
  assert.equal(seen[1]?.href, "https://api.x.com/2/tweets/5/retweeted_by?user.fields=id");

  const reposts = await native.reposts({ account, postId: "5", context });
  assert.deepEqual(reposts.items, [{ id: "7", text: "RT" }]);
  assert.equal(new URL(seen[2]?.href ?? "").pathname, "/2/tweets/5/retweets");

  const mine = await native.repostsOfMe({ account, limit: 100, context });
  assert.deepEqual(mine, { items: [{ id: "8", text: "mine" }], nextCursor: "r2" });
  assert.equal(new URL(seen[3]?.href ?? "").pathname, "/2/users/reposts_of_me");
  assert.equal(seen[3]?.authorization, "Bearer user");

  await assert.rejects(native.quotePosts({ account, postId: "5", limit: 5, context }), {
    code: "invalid_input",
  });
  await assert.rejects(fake({}, {}).native.repostsOfMe({ account, context }), {
    code: "missing_permission",
  });
});

it("looks up users by ids and usernames and searches users [feature:x.read.users] [feature:x.search.users]", async () => {
  const { native, seen } = fake({
    "/2/users": { data: [{ id: "12", username: "a" }] },
    "/2/users/by": { data: [{ id: "13", username: "b" }] },
    "/2/users/search": { data: [{ id: "14", username: "c" }], meta: { next_token: "n2" } },
  });

  assert.deepEqual((await native.getUsers({ account, userIds: ["12"], context })).items, [
    { id: "12", username: "a" },
  ]);
  assert.equal(query(seen, 0)["ids"], "12");

  const byName = await native.getUsersByUsernames({
    account,
    usernames: ["b", "c_1"],
    userFields: ["id", "username", "verified_type"],
    context,
  });

  assert.deepEqual(byName.items, [{ id: "13", username: "b" }]);
  assert.equal(
    seen[1]?.href,
    "https://api.x.com/2/users/by?usernames=b%2Cc_1&user.fields=id%2Cusername%2Cverified_type",
  );

  const found = await native.searchUsers({
    account,
    query: "open core",
    limit: 1000,
    cursor: "n1",
    context,
  });

  assert.deepEqual(found, { items: [{ id: "14", username: "c" }], nextCursor: "n2" });
  assert.equal(new URL(seen[2]?.href ?? "").pathname, "/2/users/search");
  assert.deepEqual(
    { query: query(seen, 2)["query"], next: query(seen, 2)["next_token"] },
    { query: "open core", next: "n1" },
  );

  await assert.rejects(native.getUsersByUsernames({ account, usernames: ["bad-name"], context }), {
    code: "invalid_input",
  });
  await assert.rejects(native.searchUsers({ account, query: "a;b", context }), {
    code: "invalid_input",
  });
  assert.equal(seen.length, 3);
});

it("decodes recent and full-archive Post counts [feature:x.search.counts]", async () => {
  const { native, seen } = fake(
    {
      "/2/tweets/counts/recent": {
        data: [{ start: "2026-11-03T00:00:00Z", end: "2026-11-04T00:00:00Z", post_count: 42 }],
        meta: { total_post_count: 42, next_token: "c2" },
      },
      "/2/tweets/counts/all": {
        data: [{ start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z", tweet_count: 7 }],
        meta: { total_tweet_count: 7 },
      },
    },
    { accessToken: "user", appBearerToken: "app" },
  );

  const recent = await native.countRecentPosts({
    account,
    counts: { query: "from:opencoredev", granularity: "day", sinceId: "100" },
    context,
  });

  assert.deepEqual(recent, {
    buckets: [{ start: "2026-11-03T00:00:00Z", end: "2026-11-04T00:00:00Z", count: 42 }],
    totalCount: 42,
    nextCursor: "c2",
  });
  assert.equal(
    seen[0]?.href,
    "https://api.x.com/2/tweets/counts/recent?query=from%3Aopencoredev&since_id=100&granularity=day",
  );
  assert.equal(seen[0]?.authorization, "Bearer user");

  const all = await native.countAllPosts({ account, counts: { query: "sdk" }, context });
  assert.deepEqual(all, {
    buckets: [{ start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z", count: 7 }],
    totalCount: 7,
  });
  assert.equal(seen[1]?.authorization, "Bearer app");

  await assert.rejects(
    fake({}).native.countAllPosts({ account, counts: { query: "sdk" }, context }),
    { code: "missing_permission" },
  );
  await assert.rejects(
    native.countRecentPosts({ account, counts: { query: "sdk", startTime: "yesterday" }, context }),
    { code: "invalid_input" },
  );
});

it("reads affiliates, List followers and List memberships [feature:x.graph.affiliates] [feature:x.lists.followers_memberships]", async () => {
  const { native, seen } = fake({
    "/2/users/20/affiliates": { data: [{ id: "21", username: "team" }] },
    "/2/lists/30/followers": { data: [{ id: "22" }], meta: { next_token: "f2" } },
    "/2/users/11/list_memberships": { data: [{ id: "31", name: "SDKs", member_count: 4 }] },
  });

  assert.deepEqual(
    (await native.affiliates({ account, userId: "20", limit: 1000, context })).items,
    [{ id: "21", username: "team" }],
  );
  assert.equal(new URL(seen[0]?.href ?? "").pathname, "/2/users/20/affiliates");

  assert.deepEqual(await native.listFollowers({ account, listId: "30", context }), {
    items: [{ id: "22" }],
    nextCursor: "f2",
  });

  assert.deepEqual((await native.listMemberships({ account, context })).items, [
    { id: "31", name: "SDKs", member_count: 4 },
  ]);
  assert.equal(
    seen[2]?.href,
    "https://api.x.com/2/users/11/list_memberships?list.fields=id%2Cname%2Cdescription%2Cprivate%2Cmember_count%2Cfollower_count%2Cowner_id",
  );
});

it("lists, creates and reads bookmark folders [feature:x.engagement.bookmark_folders]", async () => {
  const { native, seen } = fake({
    "/2/users/11/bookmarks/folders": { data: [{ id: "40", name: "Read later" }] },
    "POST /2/users/11/bookmarks/folders": { data: { id: "40", name: "Read later" } },
    "/2/users/11/bookmarks/folders/40": { data: [{ id: "1" }, { id: "2" }] },
  });

  assert.deepEqual(await native.bookmarkFolders({ account, context }), {
    items: [{ id: "40", name: "Read later" }],
  });

  const created = await native.createBookmarkFolder({ account, name: "Read later", context });
  assert.deepEqual(created, { id: "40", name: "Read later" });
  assert.equal(seen[1]?.method, "POST");
  assert.deepEqual(seen[1]?.body, { name: "Read later" });

  assert.deepEqual((await native.bookmarksByFolder({ account, folderId: "40", context })).items, [
    { id: "1" },
    { id: "2" },
  ]);
  assert.equal(seen[2]?.href, "https://api.x.com/2/users/11/bookmarks/folders/40");

  await assert.rejects(native.createBookmarkFolder({ account, name: "x".repeat(26), context }), {
    code: "invalid_input",
  });
});

it("reads Space Posts and ticket buyers [feature:x.spaces.posts_buyers]", async () => {
  const { native, seen } = fake({
    "/2/spaces/1DXxyRYNejbKM/tweets": { data: [{ id: "9", text: "live" }] },
    "/2/spaces/1DXxyRYNejbKM/buyers": { data: [{ id: "23" }] },
  });

  assert.deepEqual(
    (await native.spacePosts({ account, spaceId: "1DXxyRYNejbKM", context })).items,
    [{ id: "9", text: "live" }],
  );
  assert.deepEqual(
    (await native.spaceBuyers({ account, spaceId: "1DXxyRYNejbKM", userFields: ["id"], context }))
      .items,
    [{ id: "23" }],
  );
  assert.equal(seen[1]?.href, "https://api.x.com/2/spaces/1DXxyRYNejbKM/buyers?user.fields=id");
});

it("looks up and searches Communities [feature:x.communities.lookup]", async () => {
  const { native, seen } = fake({
    "/2/communities/1500000000000000001": { data: { id: "1500000000000000001", name: "Builders" } },
    "/2/communities/search": { data: [{ id: "1500000000000000002", name: "SDK" }] },
  });

  assert.deepEqual(
    await native.getCommunity({
      account,
      communityId: "1500000000000000001",
      communityFields: ["id", "name", "member_count"],
      context,
    }),
    { data: { id: "1500000000000000001", name: "Builders" } },
  );
  assert.equal(
    seen[0]?.href,
    "https://api.x.com/2/communities/1500000000000000001?community.fields=id%2Cname%2Cmember_count",
  );

  assert.deepEqual(
    (await native.searchCommunities({ account, query: "sdk", limit: 10, context })).items,
    [{ id: "1500000000000000002", name: "SDK" }],
  );
  assert.equal(new URL(seen[1]?.href ?? "").pathname, "/2/communities/search");
});

it("decodes trends by WOEID and personalized trends [feature:x.trends]", async () => {
  const { native, seen } = fake({
    "/2/trends/by/woeid/1": { data: [{ trend_name: "#TypeScript", tweet_count: 1200 }] },
    "/2/users/personalized_trends": {
      data: [{ trend_name: "Bun", category: "Technology", post_count: "5K posts" }],
    },
  });

  assert.deepEqual(await native.trends({ account, woeid: 1, maxTrends: 5, context }), [
    { name: "#TypeScript", postCount: 1200 },
  ]);
  assert.equal(
    seen[0]?.href,
    "https://api.x.com/2/trends/by/woeid/1?trend.fields=trend_name%2Ctweet_count&max_trends=5",
  );
  assert.deepEqual(await native.personalizedTrends({ account, context }), [
    { name: "Bun", category: "Technology", postCount: "5K posts" },
  ]);
  await assert.rejects(native.trends({ account, woeid: 1, maxTrends: 51, context }), {
    code: "invalid_input",
  });
});

it("reads Post usage with the app token and decodes the credit balance [feature:x.usage.read]", async () => {
  const { native, seen } = fake(
    {
      "/2/usage/tweets": { data: { project_usage: "1200", project_cap: "10000" } },
      "/2/usage/credits": {
        data: {
          total_balance: 4.5,
          prepaid_balance: 0,
          free_balance: 4.5,
          free_grants: [{ amount: 4.5, expires_at: "2026-12-01T00:00:00Z" }],
        },
      },
    },
    { accessToken: "user", appBearerToken: "app" },
  );

  assert.deepEqual(await native.postUsage({ account, days: 30, context }), {
    data: { project_usage: "1200", project_cap: "10000" },
  });
  assert.equal(seen[0]?.href, "https://api.x.com/2/usage/tweets?days=30");
  assert.equal(seen[0]?.authorization, "Bearer app");

  assert.deepEqual(await native.creditBalance({ account, context }), {
    totalBalance: 4.5,
    prepaidBalance: 0,
    freeBalance: 4.5,
    freeGrants: [{ amount: 4.5, expiresAt: "2026-12-01T00:00:00Z" }],
  });

  const broken = fake({ "/2/usage/credits": { data: { total_balance: "4.5" } } });
  await assert.rejects(broken.native.creditBalance({ account, context }));
});

it("looks up media by media key with GET /2/media [feature:x.media.lookup]", async () => {
  const { native, seen } = fake({
    "/2/media": { data: [{ media_key: "3_1700000000000000000", type: "photo" }] },
  });

  const page = await native.getMedia({
    account,
    mediaKeys: ["3_1700000000000000000"],
    mediaFields: ["media_key", "type", "alt_text"],
    context,
  });

  assert.deepEqual(page.items, [{ media_key: "3_1700000000000000000", type: "photo" }]);
  assert.equal(
    seen[0]?.href,
    "https://api.x.com/2/media?media_keys=3_1700000000000000000&media.fields=media_key%2Ctype%2Calt_text",
  );
  await assert.rejects(native.getMedia({ account, mediaKeys: ["photo"], context }), {
    code: "invalid_input",
  });
});
