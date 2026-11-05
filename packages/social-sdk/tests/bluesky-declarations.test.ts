import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  blueskyFeedGeneratorDescription,
  blueskyFeedSkeleton,
  parseBlueskyFeedSkeletonRequest,
} from "../src/platforms/bluesky.js";
import { object } from "../src/transport/validation.js";
import { type Call, account, did, harness, json } from "./bluesky-harness.js";

const invalid = { name: "SocialError", code: "invalid_input" };

const record = (call: Call | undefined) => object(call?.body?.["record"]);

const written = (collection: string, rkey = "self") =>
  json({ uri: `at://${did}/${collection}/${rkey}`, cid: "bafyreiwritten" });

const notFound = () => json({ error: "RecordNotFound", message: "Could not locate record" }, 400);

const icon = {
  $type: "blob" as const,
  ref: { $link: "bafkreiicon" },
  mimeType: "image/webp",
  size: 2048,
};

describe("Bluesky account declarations", () => {
  it("reads and writes the app.bsky.notification.declaration record", async () => {
    const { native, calls } = harness(({ method, url }) =>
      method === "GET"
        ? url.searchParams.get("repo") === "did:plc:alice"
          ? json({
              uri: "at://did:plc:alice/app.bsky.notification.declaration/self",
              cid: "bafyreidecl",
              value: { $type: "app.bsky.notification.declaration", allowSubscriptions: "mutuals" },
            })
          : notFound()
        : written("app.bsky.notification.declaration"),
    );

    assert.deepEqual(await native.getNotificationDeclaration({ account, actor: "did:plc:alice" }), {
      allowSubscriptions: "mutuals",
    });
    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.repo.getRecord");
    assert.equal(calls[0]?.url.searchParams.get("collection"), "app.bsky.notification.declaration");
    assert.equal(calls[0]?.url.searchParams.get("rkey"), "self");
    assert.equal(await native.getNotificationDeclaration({ account }), undefined);

    await native.setNotificationDeclaration({ account, allowSubscriptions: "none" });
    assert.equal(calls[2]?.url.pathname, "/xrpc/com.atproto.repo.putRecord");
    assert.deepEqual(calls[2]?.body, {
      repo: did,
      collection: "app.bsky.notification.declaration",
      rkey: "self",
      record: { $type: "app.bsky.notification.declaration", allowSubscriptions: "none" },
    });
  });

  it("writes chat.bsky.actor.declaration and reads chat.bsky.actor.getStatus", async () => {
    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("getStatus")
        ? json({ chatDisabled: false, canCreateGroups: true, groupMemberLimit: 50 })
        : url.pathname.endsWith("getRecord")
          ? json({
              uri: `at://${did}/chat.bsky.actor.declaration/self`,
              cid: "bafyreichat",
              value: { $type: "chat.bsky.actor.declaration", allowIncoming: "following" },
            })
          : written("chat.bsky.actor.declaration"),
    );

    await native.setChatDeclaration({
      account,
      allowIncoming: "following",
      allowGroupInvites: "none",
    });
    assert.equal(calls[0]?.body?.["collection"], "chat.bsky.actor.declaration");
    assert.deepEqual(record(calls[0]), {
      $type: "chat.bsky.actor.declaration",
      allowIncoming: "following",
      allowGroupInvites: "none",
    });
    // The declaration is a repository record, so it is not proxied to the chat service.
    assert.equal(calls[0]?.headers.get("atproto-proxy"), null);

    assert.deepEqual(await native.getChatDeclaration({ account }), {
      allowIncoming: "following",
    });

    assert.deepEqual(await native.getChatStatus({ account }), {
      chatDisabled: false,
      canCreateGroups: true,
      groupMemberLimit: 50,
    });
    assert.equal(calls[2]?.url.pathname, "/xrpc/chat.bsky.actor.getStatus");
    assert.equal(calls[2]?.headers.get("atproto-proxy"), "did:web:api.bsky.chat#bsky_chat");
  });

  it("sets app.bsky.actor.contentVisibilityDeclaration and reads a missing record as false", async () => {
    const { native, calls } = harness(({ method }) =>
      method === "GET" ? notFound() : written("app.bsky.actor.contentVisibilityDeclaration"),
    );

    assert.deepEqual(await native.getContentVisibility({ account }), {
      hideFromAlgorithmicRecommendations: false,
    });

    await native.setContentVisibility({ account, hideFromAlgorithmicRecommendations: true });
    assert.equal(calls[1]?.body?.["collection"], "app.bsky.actor.contentVisibilityDeclaration");
    assert.deepEqual(record(calls[1]), {
      $type: "app.bsky.actor.contentVisibilityDeclaration",
      hideFromAlgorithmicRecommendations: true,
    });
  });

  it("opts out of a reference list with app.bsky.graph.referencelistoptout", async () => {
    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("createRecord")
        ? written("app.bsky.graph.referencelistoptout", "3koptout")
        : json({}),
    );

    const listUri = "at://did:plc:curator/app.bsky.graph.list/3klist";

    const ref = await native.optOutOfReferenceList({ account, listUri });
    assert.equal(ref.uri, `at://${did}/app.bsky.graph.referencelistoptout/3koptout`);
    assert.equal(calls[0]?.body?.["collection"], "app.bsky.graph.referencelistoptout");
    assert.equal(record(calls[0])["subject"], listUri);

    await native.deleteReferenceListOptOut({ account, uri: ref.uri });
    assert.deepEqual(calls[1]?.body, {
      repo: did,
      collection: "app.bsky.graph.referencelistoptout",
      rkey: "3koptout",
    });

    await assert.rejects(
      native.optOutOfReferenceList({ account, listUri: "at://alice.test/app.bsky.graph.list/x" }),
      invalid,
    );
    assert.equal(calls.length, 2);
  });

  it("creates app.bsky.actor.link records and orders them on the profile", async () => {
    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("createRecord") && calls.length === 1
        ? written("app.bsky.actor.link", "3klink")
        : url.pathname.endsWith("getRecord")
          ? json({
              uri: `at://${did}/app.bsky.actor.profile/self`,
              cid: "bafyreiprofile",
              value: { $type: "app.bsky.actor.profile", displayName: "Test" },
            })
          : written("app.bsky.actor.profile"),
    );

    const link = await native.createProfileLink({
      account,
      url: "https://example.com/blog",
      title: "Blog",
      icon,
    });

    assert.equal(calls[0]?.body?.["collection"], "app.bsky.actor.link");
    assert.equal(record(calls[0])["$type"], "app.bsky.actor.link");
    assert.equal(record(calls[0])["url"], "https://example.com/blog");
    assert.equal(record(calls[0])["title"], "Blog");
    assert.deepEqual(record(calls[0])["icon"], icon);

    await native.editProfile({ account, changes: { links: [link] } });
    assert.deepEqual(record(calls[2])["links"], [link]);
    assert.equal(record(calls[2])["displayName"], "Test");

    await assert.rejects(native.createProfileLink({ account, url: "http://example.com" }), invalid);
    await assert.rejects(
      native.editProfile({
        account,
        changes: { links: [{ uri: `at://${did}/app.bsky.feed.post/3k`, cid: "bafyreipost" }] },
      }),
      invalid,
    );
    assert.equal(calls.length, 3);
  });
});

describe("Bluesky custom feeds and labelers", () => {
  it("publishes an app.bsky.feed.generator record", async () => {
    const { native, calls } = harness(() => written("app.bsky.feed.generator", "cats"));

    const ref = await native.putFeedGenerator({
      account,
      rkey: "cats",
      did: "did:web:feeds.example.com",
      displayName: "Cats",
      description: "Cat posts from https://example.com #cats",
      acceptsInteractions: true,
      contentMode: "app.bsky.feed.defs#contentModeUnspecified",
    });

    assert.equal(ref.uri, `at://${did}/app.bsky.feed.generator/cats`);
    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.repo.putRecord");
    assert.equal(calls[0]?.body?.["rkey"], "cats");
    const value = record(calls[0]);
    assert.equal(value["$type"], "app.bsky.feed.generator");
    assert.equal(value["did"], "did:web:feeds.example.com");
    assert.equal(value["acceptsInteractions"], true);
    assert.ok(Array.isArray(value["descriptionFacets"]));

    await assert.rejects(
      native.putFeedGenerator({ account, rkey: "x", did: "feeds.example.com", displayName: "X" }),
      invalid,
    );
    await assert.rejects(
      native.putFeedGenerator({
        account,
        rkey: "x",
        did: "did:web:feeds.example.com",
        displayName: "A name that is far longer than 24 graphemes",
      }),
      invalid,
    );
    assert.equal(calls.length, 1);
  });

  it("serves app.bsky.feed.describeFeedGenerator and getFeedSkeleton bodies", () => {
    const feed = `at://${did}/app.bsky.feed.generator/cats`;

    assert.deepEqual(
      blueskyFeedGeneratorDescription({
        did: "did:web:feeds.example.com",
        feeds: [feed],
        links: { privacyPolicy: "https://feeds.example.com/privacy" },
      }),
      {
        did: "did:web:feeds.example.com",
        feeds: [{ uri: feed }],
        links: { privacyPolicy: "https://feeds.example.com/privacy" },
      },
    );

    const request = parseBlueskyFeedSkeletonRequest(
      new URL(
        `https://feeds.example.com/xrpc/app.bsky.feed.getFeedSkeleton?feed=${encodeURIComponent(feed)}&limit=30&cursor=c1`,
      ),
    );

    assert.deepEqual(request, { feed, limit: 30, cursor: "c1" });

    assert.deepEqual(
      blueskyFeedSkeleton({
        feed: [
          { post: "at://did:plc:a/app.bsky.feed.post/1", feedContext: "ctx-1" },
          { post: "at://did:plc:a/app.bsky.feed.post/2", reason: "pin" },
        ],
        cursor: "c2",
        reqId: "req-9",
      }),
      {
        feed: [
          { post: "at://did:plc:a/app.bsky.feed.post/1", feedContext: "ctx-1" },
          {
            post: "at://did:plc:a/app.bsky.feed.post/2",
            reason: { $type: "app.bsky.feed.defs#skeletonReasonPin" },
          },
        ],
        cursor: "c2",
        reqId: "req-9",
      },
    );

    assert.throws(
      () =>
        parseBlueskyFeedSkeletonRequest(
          new URL(`https://f.example/xrpc/app.bsky.feed.getFeedSkeleton?feed=${feed}&limit=500`),
        ),
      invalid,
    );
    assert.throws(
      () => blueskyFeedGeneratorDescription({ did: "did:web:f.example", feeds: ["at://x"] }),
      invalid,
    );
  });

  it("declares an app.bsky.labeler.service record with label definitions", async () => {
    const { native, calls } = harness(() => written("app.bsky.labeler.service"));

    await native.putLabelerService({
      account,
      policies: {
        labelValues: ["spoiler", "!warn"],
        labelValueDefinitions: [
          {
            identifier: "spoiler",
            severity: "inform",
            blurs: "content",
            defaultSetting: "warn",
            locales: [{ lang: "en", name: "Spoiler", description: "Reveals a plot point." }],
          },
        ],
      },
      reasonTypes: ["com.atproto.moderation.defs#reasonOther"],
      subjectTypes: ["record"],
      subjectCollections: ["app.bsky.feed.post"],
    });

    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.repo.putRecord");
    assert.equal(calls[0]?.body?.["collection"], "app.bsky.labeler.service");
    assert.equal(calls[0]?.body?.["rkey"], "self");
    const value = record(calls[0]);
    assert.equal(value["$type"], "app.bsky.labeler.service");
    assert.deepEqual(value["policies"], {
      labelValues: ["spoiler", "!warn"],
      labelValueDefinitions: [
        {
          identifier: "spoiler",
          severity: "inform",
          blurs: "content",
          defaultSetting: "warn",
          locales: [{ lang: "en", name: "Spoiler", description: "Reveals a plot point." }],
        },
      ],
    });
    assert.deepEqual(value["subjectCollections"], ["app.bsky.feed.post"]);

    await assert.rejects(
      native.putLabelerService({
        account,
        policies: {
          labelValues: ["Bad Label"],
          labelValueDefinitions: [
            { identifier: "Bad Label", severity: "inform", blurs: "none", locales: [] },
          ],
        },
      }),
      invalid,
    );
    assert.equal(calls.length, 1);
  });
});
