import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { bluesky } from "../src/platforms/bluesky.js";
import {
  connectedAccountRef,
  platformPostRef,
  SocialError,
  type AdapterOperationContext,
  type JsonObject,
  type JsonValue,
} from "../src/core/index.js";
import { definedFields } from "../src/core/fields.js";
import { isJsonValue } from "../src/transport/json.js";
import { object } from "../src/transport/validation.js";

const did = "did:plc:test";

const account = connectedAccountRef({ backend: "default", platform: "bluesky", accountId: did });

const postUri = "at://did:plc:alice/app.bsky.feed.post/3kpost";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "reads",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly body?: JsonObject;
}

function json(value: JsonValue): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function decode(body: BodyInit | null | undefined): JsonObject | undefined {
  if (body === undefined || body === null) return undefined;

  const parsed: unknown = JSON.parse(String(body));
  assert.ok(isJsonValue(parsed));

  return object(parsed);
}

/** Routes each XRPC method name to a fixture response and records the requests. */
function harness(routes: Readonly<Record<string, JsonValue>>) {
  const calls: Call[] = [];

  const adapter = bluesky({
    auth: { service: "https://pds.example", did, accessJwt: "fixture" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        method: init?.method ?? "GET",
        url,
        ...definedFields({ body: decode(init?.body) }),
      });

      const route = routes[url.pathname.replace("/xrpc/", "")];
      assert.ok(route !== undefined, `unexpected request ${url.pathname}`);

      return json(route);
    },
  });

  const last = (): Call => {
    const call = calls.at(-1);
    assert.ok(call);

    return call;
  };

  return { native: adapter.native!, adapter, calls, last };
}

describe("Bluesky post and feed reads", () => {
  it("hydrates up to 25 posts with repeated uris parameters on app.bsky.feed.getPosts", async () => {
    const { native, last, calls } = harness({
      "app.bsky.feed.getPosts": { posts: [{ uri: postUri, cid: "bafy" }] },
    });

    const posts = await native.getPosts({ account, uris: [postUri, `${postUri}2`] });

    assert.equal(posts.length, 1);
    assert.equal(last().url.pathname, "/xrpc/app.bsky.feed.getPosts");
    assert.deepEqual(last().url.searchParams.getAll("uris"), [postUri, `${postUri}2`]);

    await assert.rejects(
      native.getPosts({ account, uris: Array.from({ length: 26 }, () => postUri) }),
      (error) => error instanceof SocialError && error.code === "invalid_input",
    );
    assert.equal(calls.length, 1);
  });

  it("passes depth and parentHeight to getPostThread", async () => {
    const { native, last } = harness({ "app.bsky.feed.getPostThread": { thread: {} } });

    await native.getPostThread({ uri: postUri, depth: 0, parentHeight: 3, context });

    assert.equal(last().url.searchParams.get("depth"), "0");
    assert.equal(last().url.searchParams.get("parentHeight"), "3");
    await assert.rejects(native.getPostThread({ uri: postUri, parentHeight: 1001, context }));
  });

  it("asks the author feed to includePins and accepts the posts_with_video filter", async () => {
    const { native, last } = harness({ "app.bsky.feed.getAuthorFeed": { feed: [] } });

    await native.getAuthorFeed({ account, includePins: true, filter: "posts_with_video" });

    assert.equal(last().url.searchParams.get("includePins"), "true");
    assert.equal(last().url.searchParams.get("filter"), "posts_with_video");
    assert.equal(last().url.searchParams.get("actor"), did);
  });

  it("reads getListFeed, getQuotes, and getRepostedBy pages", async () => {
    const listUri = "at://did:plc:test/app.bsky.graph.list/3klist";

    const { native, calls } = harness({
      "app.bsky.feed.getListFeed": { feed: [{ post: { uri: postUri } }], cursor: "l2" },
      "app.bsky.feed.getQuotes": { uri: postUri, posts: [{ uri: "at://q" }], cursor: "q2" },
      "app.bsky.feed.getRepostedBy": { uri: postUri, repostedBy: [{ did: "did:plc:bob" }] },
    });

    const list = await native.getListFeed({ account, listUri, limit: 20 });
    assert.equal(list.cursor, "l2");
    assert.equal(calls[0]?.url.searchParams.get("list"), listUri);
    assert.equal(calls[0]?.url.searchParams.get("limit"), "20");

    const quotes = await native.getQuotes({ account, uri: postUri, cid: "bafycid" });
    assert.deepEqual(quotes, { items: [{ uri: "at://q" }], cursor: "q2" });
    assert.equal(calls[1]?.url.pathname, "/xrpc/app.bsky.feed.getQuotes");
    assert.equal(calls[1]?.url.searchParams.get("cid"), "bafycid");

    const reposters = await native.getRepostedBy({ account, uri: postUri });
    assert.deepEqual(reposters.items, [{ did: "did:plc:bob" }]);
    assert.equal(calls[2]?.url.pathname, "/xrpc/app.bsky.feed.getRepostedBy");
  });

  it("discovers feeds with getSuggestedFeeds, getActorFeeds, and getFeedGenerator(s)", async () => {
    const feed = "at://did:plc:alice/app.bsky.feed.generator/news";

    const { native, calls } = harness({
      "app.bsky.feed.getSuggestedFeeds": { feeds: [{ uri: feed }] },
      "app.bsky.feed.getActorFeeds": { feeds: [{ uri: feed }], cursor: "next" },
      "app.bsky.feed.getFeedGenerator": { view: { uri: feed }, isOnline: true, isValid: true },
      "app.bsky.feed.getFeedGenerators": { feeds: [{ uri: feed }] },
    });

    await native.listFeeds({ account, limit: 5 });
    assert.equal(calls[0]?.url.pathname, "/xrpc/app.bsky.feed.getSuggestedFeeds");

    const actorFeeds = await native.getActorFeeds({ account, actor: "alice.test" });
    assert.equal(actorFeeds.cursor, "next");
    assert.equal(calls[1]?.url.searchParams.get("actor"), "alice.test");

    const generator = await native.getFeedGenerator({ account, feed });
    assert.equal(generator["isOnline"], true);
    assert.equal(calls[2]?.url.searchParams.get("feed"), feed);

    const generators = await native.getFeedGenerators({ account, feeds: [feed, feed] });
    assert.equal(generators.length, 1);
    assert.deepEqual(calls[3]?.url.searchParams.getAll("feeds"), [feed, feed]);
  });
});

describe("Bluesky actor and graph reads", () => {
  it("reads batch getProfiles, getSuggestions, and suggested follows", async () => {
    const { native, calls } = harness({
      "app.bsky.actor.getProfiles": { profiles: [{ did: "did:plc:a" }, { did: "did:plc:b" }] },
      "app.bsky.actor.getSuggestions": { actors: [{ did: "did:plc:c" }], cursor: "s2" },
      "app.bsky.graph.getSuggestedFollowsByActor": { suggestions: [{ did: "did:plc:d" }] },
    });

    const profiles = await native.getProfiles({ account, actors: ["did:plc:a", "bob.test"] });
    assert.equal(profiles.length, 2);
    assert.deepEqual(calls[0]?.url.searchParams.getAll("actors"), ["did:plc:a", "bob.test"]);

    await assert.rejects(
      native.getProfiles({ account, actors: Array.from({ length: 26 }, (_, i) => `a${i}.test`) }),
    );

    const suggestions = await native.getSuggestions({ account, limit: 10 });
    assert.deepEqual(suggestions, { actors: [{ did: "did:plc:c" }], cursor: "s2" });

    const similar = await native.getSuggestedFollowsByActor({ account, actor: "did:plc:a" });
    assert.deepEqual(similar.actors, [{ did: "did:plc:d" }]);
    assert.equal(calls[2]?.url.searchParams.get("actor"), "did:plc:a");
  });

  it("reads getRelationships and getKnownFollowers", async () => {
    const { native, calls } = harness({
      "app.bsky.graph.getRelationships": {
        actor: did,
        relationships: [{ did: "did:plc:a", following: "at://f", followedBy: "at://g" }],
      },
      "app.bsky.graph.getKnownFollowers": {
        subject: { did: "did:plc:a" },
        followers: [{ did: "did:plc:m" }],
      },
    });

    const relationships = await native.getRelationships({ account, others: ["did:plc:a"] });
    assert.equal(relationships[0]?.["following"], "at://f");
    assert.equal(calls[0]?.url.searchParams.get("actor"), did);
    assert.deepEqual(calls[0]?.url.searchParams.getAll("others"), ["did:plc:a"]);

    const known = await native.getKnownFollowers({ account, actor: "did:plc:a" });
    assert.deepEqual(known.actors, [{ did: "did:plc:m" }]);
  });

  it("decodes verifiedStatus from the profile view", async () => {
    const { native } = harness({
      "app.bsky.actor.getProfile": {
        did: "did:plc:a",
        verification: {
          verifiedStatus: "valid",
          trustedVerifierStatus: "none",
          verifications: [
            {
              issuer: "did:plc:verifier",
              uri: "at://did:plc:verifier/app.bsky.graph.verification/3kv",
              isValid: true,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      },
    });

    assert.deepEqual(await native.getVerificationState({ account, actor: "did:plc:a" }), {
      verifiedStatus: "valid",
      trustedVerifierStatus: "none",
      verifications: [
        {
          issuer: "did:plc:verifier",
          uri: "at://did:plc:verifier/app.bsky.graph.verification/3kv",
          isValid: true,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("mutes and unmutes a thread with muteThread", async () => {
    const { native, calls } = harness({
      "app.bsky.graph.muteThread": {},
      "app.bsky.graph.unmuteThread": {},
    });

    await native.muteThread({ account, rootUri: postUri });
    await native.unmuteThread({ account, rootUri: postUri });

    assert.deepEqual(
      calls.map((call) => [call.method, call.url.pathname, call.body]),
      [
        ["POST", "/xrpc/app.bsky.graph.muteThread", { root: postUri }],
        ["POST", "/xrpc/app.bsky.graph.unmuteThread", { root: postUri }],
      ],
    );
  });

  it("reads getListBlocks, getListMutes, and getListsWithMembership", async () => {
    const { native, calls } = harness({
      "app.bsky.graph.getListBlocks": { lists: [{ uri: "at://block-list" }] },
      "app.bsky.graph.getListMutes": { lists: [{ uri: "at://mute-list" }], cursor: "m2" },
      "app.bsky.graph.getListsWithMembership": {
        listsWithMembership: [{ list: { uri: "at://mine" }, listItem: { uri: "at://item" } }],
      },
    });

    assert.deepEqual((await native.getListBlocks({ account })).items, [{ uri: "at://block-list" }]);
    assert.equal((await native.getListMutes({ account })).cursor, "m2");

    const membership = await native.getListsWithMembership({
      account,
      actor: "did:plc:a",
      purposes: ["curatelist"],
    });

    assert.equal(membership.items.length, 1);
    assert.equal(calls[2]?.url.searchParams.get("actor"), "did:plc:a");
    assert.deepEqual(calls[2]?.url.searchParams.getAll("purposes"), ["curatelist"]);
  });

  it("creates and reads app.bsky.graph.starterpack records", async () => {
    const listUri = `at://${did}/app.bsky.graph.list/3kref`;
    const packUri = `at://${did}/app.bsky.graph.starterpack/3kpack`;
    const feed = "at://did:plc:alice/app.bsky.feed.generator/news";

    const { native, calls } = harness({
      "com.atproto.repo.createRecord": { uri: packUri, cid: "bafypack" },
      "com.atproto.repo.deleteRecord": {},
      "app.bsky.graph.getStarterPack": { starterPack: { uri: packUri, joinedWeekCount: 3 } },
      "app.bsky.graph.getStarterPacks": { starterPacks: [{ uri: packUri }] },
      "app.bsky.graph.getActorStarterPacks": { starterPacks: [{ uri: packUri }] },
      "app.bsky.graph.searchStarterPacks": { starterPacks: [{ uri: packUri }], cursor: "p2" },
    });

    const created = await native.createStarterPack({
      account,
      name: "TypeScript folks",
      listUri,
      description: "People who ship TS",
      feeds: [feed],
    });

    assert.deepEqual(created, { uri: packUri, cid: "bafypack" });

    const write = calls[0]?.body;
    assert.equal(write?.["collection"], "app.bsky.graph.starterpack");
    const record = object(write?.["record"]);
    assert.equal(record["$type"], "app.bsky.graph.starterpack");
    assert.equal(record["list"], listUri);
    assert.deepEqual(record["feeds"], [{ uri: feed }]);

    assert.equal((await native.getStarterPack({ account, uri: packUri }))["joinedWeekCount"], 3);
    assert.equal(calls[1]?.url.searchParams.get("starterPack"), packUri);
    assert.equal((await native.getStarterPacks({ account, uris: [packUri] })).length, 1);
    assert.equal((await native.getActorStarterPacks({ account })).items.length, 1);
    assert.equal((await native.searchStarterPacks({ account, query: "ts" })).cursor, "p2");
    assert.equal(calls[4]?.url.searchParams.get("q"), "ts");

    await native.deleteStarterPack({ account, uri: packUri });
    assert.deepEqual(calls[5]?.body, {
      repo: did,
      collection: "app.bsky.graph.starterpack",
      rkey: "3kpack",
    });

    await assert.rejects(
      native.createStarterPack({ account, name: "x", listUri, feeds: [feed, feed, feed, feed] }),
    );
    await assert.rejects(
      native.createStarterPack({
        account,
        name: "x",
        listUri: "at://did:plc:other/app.bsky.graph.list/3k",
      }),
    );
    assert.equal(calls.length, 6);
  });
});

describe("Bluesky engagement and moderation reads", () => {
  it("undoes an owned app.bsky.feed.repost record and rejects foreign ones", async () => {
    const { native, calls } = harness({ "com.atproto.repo.deleteRecord": {} });

    await native.unrepostPost({ account, repostUri: `at://${did}/app.bsky.feed.repost/3krp` });
    assert.deepEqual(calls[0]?.body, {
      repo: did,
      collection: "app.bsky.feed.repost",
      rkey: "3krp",
    });

    await assert.rejects(
      native.unrepostPost({ account, repostUri: "at://did:plc:other/app.bsky.feed.repost/3krp" }),
      (error) => error instanceof SocialError && error.code === "unauthorized",
    );
    assert.equal(calls.length, 1);
  });

  it("creates, deletes, and lists app.bsky.bookmark. bookmarks", async () => {
    const { native, calls } = harness({
      "app.bsky.bookmark.createBookmark": {},
      "app.bsky.bookmark.deleteBookmark": {},
      "app.bsky.bookmark.getBookmarks": {
        bookmarks: [{ subject: { uri: postUri, cid: "bafy" }, item: { uri: postUri } }],
        cursor: "b2",
      },
    });

    await native.createBookmark({ account, post: { uri: postUri, cid: "bafypostcid" } });
    await native.deleteBookmark({ account, uri: postUri });
    const bookmarks = await native.getBookmarks({ account, limit: 5 });

    assert.deepEqual(calls[0]?.body, { uri: postUri, cid: "bafypostcid" });
    assert.deepEqual(calls[1]?.body, { uri: postUri });
    assert.equal(bookmarks.cursor, "b2");
    assert.equal(bookmarks.items.length, 1);
  });

  it("reports bookmarkCount as a bookmarks metric", async () => {
    const { adapter } = harness({
      "app.bsky.feed.getPosts": {
        posts: [{ uri: postUri, likeCount: 4, quoteCount: 1, bookmarkCount: 7 }],
      },
    });

    const metrics = await adapter.analytics!.getPostMetrics!(
      platformPostRef({ backend: "default", platform: "bluesky", accountId: did, postId: postUri }),
      context,
    );

    const bookmarks = metrics.find((metric) => metric.name === "bookmarks");
    assert.equal(bookmarks?.value, 7);
    assert.equal(bookmarks?.canonicalName, "saves");
  });

  it("reads app.bsky.labeler.getServices and queryLabels", async () => {
    const { native, calls } = harness({
      "app.bsky.labeler.getServices": { views: [{ uri: "at://labeler", likeCount: 2 }] },
      "com.atproto.label.queryLabels": {
        labels: [
          { src: "did:plc:labeler", uri: postUri, val: "spam", cts: "2026-01-01T00:00:00Z" },
        ],
        cursor: "c2",
      },
    });

    const views = await native.getLabelerServices({
      account,
      dids: ["did:plc:labeler"],
      detailed: true,
    });

    assert.equal(views.length, 1);
    assert.equal(calls[0]?.url.searchParams.get("detailed"), "true");
    assert.deepEqual(calls[0]?.url.searchParams.getAll("dids"), ["did:plc:labeler"]);

    const labels = await native.queryLabels({
      account,
      uriPatterns: ["at://did:plc:alice/*"],
      sources: ["did:plc:labeler"],
      limit: 250,
    });

    assert.equal(labels.cursor, "c2");
    assert.equal(calls[1]?.url.searchParams.get("limit"), "250");
    assert.deepEqual(calls[1]?.url.searchParams.getAll("uriPatterns"), ["at://did:plc:alice/*"]);

    await assert.rejects(native.queryLabels({ account, uriPatterns: ["at://x"], limit: 251 }));
  });
});

describe("Bluesky notification controls", () => {
  it("filters listNotifications by reasons and priority", async () => {
    const { native, last } = harness({
      "app.bsky.notification.listNotifications": { notifications: [] },
    });

    await native.listNotifications({ account, reasons: ["mention", "reply"], priority: true });

    assert.deepEqual(last().url.searchParams.getAll("reasons"), ["mention", "reply"]);
    assert.equal(last().url.searchParams.get("priority"), "true");
  });

  it("reads the unread count from getUnreadCount", async () => {
    const { native, last } = harness({ "app.bsky.notification.getUnreadCount": { count: 12 } });

    assert.equal(await native.getUnreadNotificationCount({ account, priority: false }), 12);
    assert.equal(last().url.pathname, "/xrpc/app.bsky.notification.getUnreadCount");
    assert.equal(last().url.searchParams.get("priority"), "false");
  });

  it("reads app.bsky.notification.getPreferences and writes putPreferencesV2", async () => {
    const preferences = { reply: { include: "follows", list: true, push: false } };

    const { native, calls } = harness({
      "app.bsky.notification.getPreferences": { preferences },
      "app.bsky.notification.putPreferencesV2": { preferences },
    });

    assert.deepEqual(await native.getNotificationPreferences({ account }), preferences);

    const updated = await native.putNotificationPreferences({
      account,
      preferences: {
        reply: { include: "follows", list: true, push: false },
        chat: { include: "accepted", push: true },
      },
    });

    assert.deepEqual(updated, preferences);
    assert.equal(calls[1]?.url.pathname, "/xrpc/app.bsky.notification.putPreferencesV2");
    assert.deepEqual(calls[1]?.body, {
      reply: { include: "follows", list: true, push: false },
      chat: { include: "accepted", push: true },
    });
  });

  it("lists and puts activity subscriptions (listActivitySubscriptions, putActivitySubscription)", async () => {
    const { native, calls } = harness({
      "app.bsky.notification.listActivitySubscriptions": {
        subscriptions: [{ did: "did:plc:a", handle: "a.test" }],
        cursor: "n2",
      },
      "app.bsky.notification.putActivitySubscription": {
        subject: "did:plc:a",
        activitySubscription: { post: true, reply: false },
      },
    });

    const subscriptions = await native.listActivitySubscriptions({ account });
    assert.deepEqual(subscriptions, {
      actors: [{ did: "did:plc:a", handle: "a.test" }],
      cursor: "n2",
    });

    const put = await native.putActivitySubscription({
      account,
      subject: "did:plc:a",
      post: true,
      reply: false,
    });

    assert.deepEqual(put["activitySubscription"], { post: true, reply: false });
    assert.deepEqual(calls[1]?.body, {
      subject: "did:plc:a",
      activitySubscription: { post: true, reply: false },
    });

    await assert.rejects(
      native.putActivitySubscription({ account, subject: "a.test", post: true, reply: true }),
    );
    assert.equal(calls.length, 2);
  });
});
