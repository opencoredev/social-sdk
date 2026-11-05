import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createSocial } from "../src/index.js";
import { bluesky } from "../src/platforms/bluesky.js";
import { object } from "../src/transport/validation.js";
import { account, did, harness, json, recorder } from "./bluesky-harness.js";

const invalid = { name: "SocialError", code: "invalid_input" };

const anchor = "at://did:plc:author/app.bsky.feed.post/3kanchor";

describe("Bluesky search and notification reads", () => {
  it("sends structured filters to app.bsky.feed.searchPostsV2", async () => {
    const { native, calls } = harness(() =>
      json({
        posts: [{ uri: anchor }],
        hitsTotal: 12,
        cursor: "n",
        detectedQueryLanguages: ["ja"],
      }),
    );

    const result = await native.searchPostsV2({
      account,
      query: "atproto",
      sort: "top",
      authors: ["alice.test", "did:plc:bob"],
      excludeDomains: ["spam.example"],
      hashtags: ["#rust", "go"],
      languages: ["en"],
      hasMedia: true,
      excludeReplies: true,
      threadRootUri: anchor,
      allTime: true,
      limit: 30,
    });

    assert.equal(result.hitsTotal, 12);
    assert.deepEqual(result.detectedQueryLanguages, ["ja"]);
    const query = calls[0]?.url.searchParams;
    assert.equal(calls[0]?.url.pathname, "/xrpc/app.bsky.feed.searchPostsV2");
    assert.equal(query?.get("query"), "atproto");
    assert.equal(query?.get("sort"), "top");
    assert.deepEqual(query?.getAll("authors"), ["alice.test", "did:plc:bob"]);
    assert.deepEqual(query?.getAll("excludeDomains"), ["spam.example"]);
    assert.deepEqual(query?.getAll("hashtags"), ["rust", "go"]);
    assert.equal(query?.get("hasMedia"), "true");
    assert.equal(query?.get("excludeReplies"), "true");
    assert.equal(query?.get("threadRootUri"), anchor);
    assert.equal(query?.get("allTime"), "true");
    assert.equal(query?.get("limit"), "30");

    await assert.rejects(
      native.searchPostsV2({ account, repliesOnly: true, excludeReplies: true }),
      invalid,
    );
    assert.equal(calls.length, 1);
  });

  it("reads app.bsky.notification.getGroupedNotifications", async () => {
    const groups = {
      groups: [
        {
          id: "g1",
          isRead: false,
          indexedAt: "2026-11-04T00:00:00.000Z",
          count: 3,
          kind: {
            $type: "app.bsky.notification.getGroupedNotifications#likeGroup",
            post: anchor,
            items: [{ actor: "did:plc:a" }],
          },
        },
      ],
      relatedViews: [],
      cursor: "next",
    };

    const { native, calls } = harness(() => json(groups));

    assert.deepEqual(
      await native.getGroupedNotifications({ account, feed: "people-i-follow", limit: 40 }),
      groups,
    );
    assert.equal(calls[0]?.url.pathname, "/xrpc/app.bsky.notification.getGroupedNotifications");
    assert.equal(calls[0]?.url.searchParams.get("feed"), "people-i-follow");
    assert.equal(calls[0]?.url.searchParams.get("limit"), "40");

    await assert.rejects(native.getGroupedNotifications({ account, limit: 51 }), invalid);
  });

  it("reads app.bsky.graph.getStarterPacksWithMembership and searchStarterPacksV2", async () => {
    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("getStarterPacksWithMembership")
        ? json({ starterPacksWithMembership: [{ starterPack: { uri: "at://p" } }], cursor: "c" })
        : json({ starterPacks: [{ uri: "at://p" }], hitsTotal: 4 }),
    );

    const membership = await native.getStarterPacksWithMembership({ account, actor: "alice.test" });
    assert.equal(membership.items.length, 1);
    assert.equal(membership.cursor, "c");
    assert.equal(calls[0]?.url.searchParams.get("actor"), "alice.test");

    const found = await native.searchStarterPacksV2({ account, query: "science" });
    assert.equal(found.hitsTotal, 4);
    assert.equal(calls[1]?.url.pathname, "/xrpc/app.bsky.graph.searchStarterPacksV2");
    assert.equal(calls[1]?.url.searchParams.get("q"), "science");
  });
});

describe("Bluesky threads, trends, and discovery", () => {
  it("reads app.bsky.unspecced.getPostThreadV2 and the other-replies view", async () => {
    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("getPostThreadV2")
        ? json({ thread: [{ uri: anchor, depth: 0, value: {} }], hasOtherReplies: true })
        : json({ thread: [] }),
    );

    const thread = await native.getPostThreadV2({
      account,
      anchor,
      above: false,
      below: 3,
      branchingFactor: 5,
      sort: "top",
    });

    assert.equal(thread["hasOtherReplies"], true);
    const query = calls[0]?.url.searchParams;
    assert.equal(query?.get("anchor"), anchor);
    assert.equal(query?.get("above"), "false");
    assert.equal(query?.get("below"), "3");
    assert.equal(query?.get("branchingFactor"), "5");
    assert.equal(query?.get("sort"), "top");

    await native.getPostThreadOtherV2({ account, anchor });
    assert.equal(calls[1]?.url.pathname, "/xrpc/app.bsky.unspecced.getPostThreadOtherV2");

    await assert.rejects(native.getPostThreadV2({ account, anchor, below: 21 }), invalid);
    assert.equal(calls.length, 2);
  });

  it("reads app.bsky.unspecced.getTrends and getTrendingTopics", async () => {
    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("getTrends")
        ? json({ trends: [{ topic: "eclipse", displayName: "Eclipse", link: "/x" }] })
        : json({ topics: [{ topic: "rust", link: "/r" }], suggested: [] }),
    );

    const trends = await native.getTrends({ account, limit: 5 });
    assert.equal(calls[0]?.url.pathname, "/xrpc/app.bsky.unspecced.getTrends");
    assert.equal(calls[0]?.url.searchParams.get("limit"), "5");
    assert.ok(Array.isArray(trends["trends"]));

    await native.getTrendingTopics({ account, viewer: did });
    assert.equal(calls[1]?.url.pathname, "/xrpc/app.bsky.unspecced.getTrendingTopics");
    assert.equal(calls[1]?.url.searchParams.get("viewer"), did);

    await assert.rejects(native.getTrends({ account, limit: 26 }), invalid);
  });

  it("reads app.bsky.unspecced.getSuggestedUsers and other suggestion endpoints", async () => {
    const { native, calls } = harness(({ url }) => {
      if (url.pathname.endsWith("getSuggestedUsers"))
        return json({ actors: [{ did: "did:plc:a", handle: "a.test" }] });

      if (url.pathname.endsWith("getPopularFeedGenerators"))
        return json({ feeds: [{ uri: "at://f" }], cursor: "f2" });

      if (url.pathname.endsWith("getSuggestedFeeds")) return json({ feeds: [{ uri: "at://f" }] });

      if (url.pathname.endsWith("getSuggestedStarterPacks"))
        return json({ starterPacks: [{ uri: "at://p" }] });

      return json({
        suggestions: [{ tag: "science", subjectType: "feed", subject: "at://f" }],
      });
    });

    const users = await native.getSuggestedUsers({ account, category: "science", limit: 10 });
    assert.equal(users.actors.length, 1);
    assert.equal(calls[0]?.url.searchParams.get("category"), "science");

    const popular = await native.getPopularFeedGenerators({ account, query: "art" });
    assert.equal(popular.cursor, "f2");
    assert.equal(calls[1]?.url.pathname, "/xrpc/app.bsky.unspecced.getPopularFeedGenerators");
    assert.equal(calls[1]?.url.searchParams.get("query"), "art");

    assert.equal((await native.getSuggestedFeeds({ account, limit: 3 })).items.length, 1);
    assert.equal((await native.getSuggestedStarterPacks({ account })).items.length, 1);
    assert.equal((await native.getTaggedSuggestions({ account }))[0]?.["tag"], "science");
    assert.equal(calls[4]?.url.pathname, "/xrpc/app.bsky.unspecced.getTaggedSuggestions");

    await assert.rejects(native.getSuggestedUsers({ account, limit: 51 }), invalid);
  });
});

describe("Bluesky identity, repositories, and age assurance", () => {
  it("resolves identities with com.atproto.identity.resolveIdentity, resolveHandle, and resolveDid", async () => {
    const didDoc = { id: "did:plc:alice", alsoKnownAs: ["at://alice.test"] };

    const { native, calls } = harness(({ url }) => {
      if (url.pathname.endsWith("resolveIdentity"))
        return json({ did: "did:plc:alice", handle: "alice.test", didDoc });

      if (url.pathname.endsWith("resolveHandle")) return json({ did: "did:plc:alice" });

      return json({ didDoc });
    });

    assert.deepEqual(await native.resolveIdentity({ account, identifier: "alice.test" }), {
      did: "did:plc:alice",
      handle: "alice.test",
      didDoc,
    });
    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.identity.resolveIdentity");
    assert.equal(calls[0]?.url.searchParams.get("identifier"), "alice.test");

    assert.equal(await native.resolveHandle({ account, handle: "alice.test" }), "did:plc:alice");
    assert.equal(calls[1]?.url.searchParams.get("handle"), "alice.test");

    assert.deepEqual(await native.resolveDid({ account, did: "did:plc:alice" }), didDoc);
    assert.equal(calls[2]?.url.pathname, "/xrpc/com.atproto.identity.resolveDid");

    await assert.rejects(native.resolveDid({ account, did: "alice.test" }), invalid);
  });

  it("reads com.atproto.repo.describeRepo", async () => {
    const { native, calls } = harness(() =>
      json({
        did,
        handle: "test.example",
        didDoc: { id: did },
        collections: ["app.bsky.feed.post", "app.bsky.actor.profile"],
        handleIsCorrect: true,
      }),
    );

    const description = await native.describeRepo({ account });
    assert.equal(description.handleIsCorrect, true);
    assert.deepEqual(description.collections, ["app.bsky.feed.post", "app.bsky.actor.profile"]);
    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.repo.describeRepo");
    assert.equal(calls[0]?.url.searchParams.get("repo"), did);
  });

  it("reads app.bsky.ageassurance.getState and starts the flow", async () => {
    const { native, calls } = harness(({ url }) => {
      if (url.pathname.endsWith("getState"))
        return json({ state: { status: "unknown", access: "unknown" }, metadata: {} });

      if (url.pathname.endsWith("getConfig")) return json({ regions: [] });

      return json({ status: "pending", access: "unknown" });
    });

    const state = await native.getAgeAssuranceState({ account, countryCode: "gb" });
    assert.deepEqual(object(state["state"]), { status: "unknown", access: "unknown" });
    assert.equal(calls[0]?.url.pathname, "/xrpc/app.bsky.ageassurance.getState");
    assert.equal(calls[0]?.url.searchParams.get("countryCode"), "GB");

    await native.getAgeAssuranceConfig({ account });
    assert.equal(calls[1]?.url.pathname, "/xrpc/app.bsky.ageassurance.getConfig");

    const begun = await native.beginAgeAssurance({
      account,
      email: "person@example.com",
      language: "en",
      countryCode: "GB",
    });

    assert.equal(begun["status"], "pending");
    assert.deepEqual(calls[2]?.body, {
      email: "person@example.com",
      language: "en",
      countryCode: "GB",
    });

    await assert.rejects(
      native.beginAgeAssurance({ account, email: "nope", language: "en", countryCode: "GB" }),
      invalid,
    );
    assert.equal(calls.length, 3);
  });
});

describe("Bluesky feed feedback and enhanced link cards", () => {
  it("proxies app.bsky.feed.sendInteractions to the feed generator", async () => {
    const { native, calls } = harness(() => json({}));

    await native.sendFeedInteractions({
      account,
      feedServiceDid: "did:web:feeds.example.com",
      feed: "at://did:plc:curator/app.bsky.feed.generator/cats",
      interactions: [
        {
          item: anchor,
          event: "app.bsky.feed.defs#requestLess",
          feedContext: "ctx-1",
          reqId: "req-9",
        },
      ],
    });

    assert.equal(calls[0]?.url.pathname, "/xrpc/app.bsky.feed.sendInteractions");
    assert.equal(calls[0]?.headers.get("atproto-proxy"), "did:web:feeds.example.com#bsky_fg");
    assert.deepEqual(calls[0]?.body, {
      feed: "at://did:plc:curator/app.bsky.feed.generator/cats",
      interactions: [
        {
          event: "app.bsky.feed.defs#requestLess",
          item: anchor,
          feedContext: "ctx-1",
          reqId: "req-9",
        },
      ],
    });

    await assert.rejects(
      native.sendFeedInteractions({ account, feedServiceDid: "feeds.example", interactions: [] }),
      invalid,
    );
    assert.equal(calls.length, 1);
  });

  it("resolves getEmbedExternalView and writes associatedRefs on the link card", async () => {
    const article = {
      uri: "at://did:plc:writer/site.standard.document/3kdoc",
      cid: "bafyreidoccid",
    };

    const { native, calls } = harness(() => json({ associatedRefs: [article] }));

    const view = await native.getEmbedExternalView({
      account,
      url: "https://writer.example/post",
      canonicalUri: article.uri,
    });

    assert.deepEqual(view["associatedRefs"], [article]);
    assert.equal(calls[0]?.url.pathname, "/xrpc/app.bsky.embed.getEmbedExternalView");
    assert.equal(calls[0]?.url.searchParams.get("url"), "https://writer.example/post");
    assert.equal(calls[0]?.url.searchParams.get("canonicalUri"), article.uri);

    const pds = recorder(({ url }) =>
      url.pathname.endsWith("getPosts")
        ? json({ posts: [] })
        : json({ uri: `at://${did}/app.bsky.feed.post/3knew`, cid: "bafyreinewcid" }),
    );

    const social = createSocial({
      backend: bluesky({
        auth: { service: "https://pds.example", did, accessJwt: "fixture" },
        fetch: pds.fetch,
      }),
    });

    const result = await social.posts.publish({
      targets: [{ account, options: { linkAssociatedRefs: [article] } }],
      content: {
        text: "New article",
        link: { url: "https://writer.example/post", title: "Post", description: "Read it" },
      },
    });

    assert.equal(result.outcomes[0]?.state, "published");
    const created = pds.calls.find((call) => call.url.pathname.endsWith("createRecord"));
    assert.deepEqual(object(object(created?.body?.["record"])["embed"]), {
      $type: "app.bsky.embed.external",
      external: {
        uri: "https://writer.example/post",
        title: "Post",
        description: "Read it",
        associatedRefs: [article],
      },
    });

    const bad = await social.posts.prepare({
      targets: [{ account, options: { linkAssociatedRefs: [article] } }],
      content: { text: "No link" },
    });

    assert.ok(bad.issues.some((issue) => issue.code === "link.associated_refs_without_link"));
  });
});
