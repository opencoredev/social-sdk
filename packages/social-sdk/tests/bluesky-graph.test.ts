/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-conditional-empty-object-spread, anti-slop/require-readable-spacing, anti-slop/require-safety-comment-for-type-assertion -- fixture payloads validate the transport boundary. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { connectedAccountRef, createSocial, platformPostRef, profileRef } from "../src/index.js";
import { bluesky } from "../src/platforms/bluesky.js";

const response = (value: unknown): Response => Response.json(value);
const account = connectedAccountRef({
  backend: "default",
  platform: "bluesky",
  accountId: "did:plc:test",
});

function socialWith(fetch: typeof globalThis.fetch) {
  return createSocial({
    backend: bluesky({
      auth: {
        service: "https://bsky.example",
        did: account.accountId,
        accessJwt: "jwt",
      },
      fetch,
    }),
  });
}

it("lists Bluesky relationships through the client facade without inventing a since date", async () => {
  const urls: URL[] = [];
  const social = socialWith(async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname.endsWith("getFollows"))
      return response({
        follows: [
          {
            did: "did:plc:alice",
            handle: "alice.test",
            indexedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
        cursor: "next",
      });
    if (url.pathname.endsWith("getFollowers"))
      return response({
        followers: [{ did: "did:plc:bob", handle: "bob.test" }],
        cursor: "followers-next",
      });
    if (url.pathname.endsWith("getBlocks")) return response({ blocks: [], cursor: "blocks-next" });
    return response({ mutes: [] });
  });

  const page = await social.graph.listRelationships(account, { kind: "following", limit: 10 });
  assert.equal(page.items[0]?.profile.profileId, "did:plc:alice");
  assert.equal(page.items[0]?.relationship, "following");
  assert.equal(page.items[0]?.since, undefined);
  assert.ok(page.nextCursor?.startsWith("social-v1."));
  assert.equal(urls[0]?.searchParams.get("limit"), "10");

  const blocked = await social.graph.listRelationships(account, { kind: "blocked" });
  const followers = await social.graph.listRelationships(account, { kind: "followers", limit: 7 });
  const muted = await social.graph.listRelationships(account, { kind: "muted" });
  assert.deepEqual(blocked.items, []);
  assert.equal(followers.items[0]?.profile.profileId, "did:plc:bob");
  assert.equal(
    urls.find((url) => url.pathname.endsWith("getFollowers"))?.searchParams.get("limit"),
    "7",
  );
  assert.ok(blocked.nextCursor?.startsWith("social-v1."));
  assert.deepEqual(muted, { items: [] });
});

it("propagates an aborted client signal into Bluesky relationship reads", async () => {
  let calls = 0;
  const social = socialWith(async () => {
    calls++;
    return response({ follows: [] });
  });
  const controller = new AbortController();
  controller.abort(new Error("stop"));

  await assert.rejects(
    social.graph.listRelationships(account, { kind: "following" }, { signal: controller.signal }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "cancelled",
  );
  assert.equal(calls, 0);
});

it("unfollows, unblocks, and unmutes through the client facade", async () => {
  const requests: Array<{ url: URL; body?: Record<string, unknown> }> = [];
  const social = socialWith(async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      url,
      ...(init?.body === undefined
        ? {}
        : { body: JSON.parse(String(init.body)) as Record<string, unknown> }),
    });
    if (url.pathname.endsWith("app.bsky.actor.getProfile"))
      return response({
        did: url.searchParams.get("actor"),
        viewer: {
          following: "at://did:plc:test/app.bsky.graph.follow/follow-rkey",
          blocking: "at://did:plc:test/app.bsky.graph.block/block-rkey",
        },
      });
    return response({});
  });
  const target = profileRef({ ...account, profileId: "did:plc:alice" });

  await social.graph.unfollow(target);
  await social.graph.unblock(target);
  await social.graph.unmute(target);

  assert.deepEqual(
    requests.map(({ url }) => url.pathname.split("/xrpc/")[1]),
    [
      "app.bsky.actor.getProfile",
      "com.atproto.repo.deleteRecord",
      "app.bsky.actor.getProfile",
      "com.atproto.repo.deleteRecord",
      "app.bsky.graph.unmuteActor",
    ],
  );
  assert.deepEqual(requests[1]?.body, {
    repo: "did:plc:test",
    collection: "app.bsky.graph.follow",
    rkey: "follow-rkey",
  });
  assert.deepEqual(requests[3]?.body, {
    repo: "did:plc:test",
    collection: "app.bsky.graph.block",
    rkey: "block-rkey",
  });
  assert.deepEqual(requests[4]?.body, { actor: "did:plc:alice" });
});

it("reads paginated Bluesky likes and actor search results", async () => {
  const social = socialWith(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("getLikes"))
      return response({ likes: [{ actor: { did: "did:plc:alice" } }], cursor: "likes-next" });
    if (url.pathname.endsWith("getActorLikes"))
      return response({ feed: [{ post: { uri: "at://post" } }], cursor: "feed-next" });
    if (url.pathname.endsWith("searchActors"))
      return response({ actors: [{ did: "did:plc:alice" }], cursor: "actors-next" });
    return response({ actors: [] });
  });
  const native = social.native("default", { acknowledgeUnsafe: true })!;

  const likes = await native.getLikes({ account, uri: "at://post", cid: "cid", limit: 25 });
  const actorLikes = await native.getActorLikes({ account, actor: "did:plc:alice", cursor: "c" });
  const actors = await native.searchActors({ account, query: " alice ", limit: 5 });
  const empty = await native.searchActorsTypeahead({ account, query: "nobody" });

  assert.equal(likes.likes.length, 1);
  assert.equal(likes.cursor, "likes-next");
  assert.equal(actorLikes.feed.length, 1);
  assert.equal(actorLikes.cursor, "feed-next");
  assert.equal(actors.actors[0]?.["did"], "did:plc:alice");
  assert.equal(actors.cursor, "actors-next");
  assert.deepEqual(empty, { actors: [] });
});

it("creates, reads, changes, and deletes Bluesky lists", async () => {
  const requests: Array<{ url: URL; body?: Record<string, unknown> }> = [];
  let create = 0;
  const social = socialWith(async (input, init) => {
    const url = new URL(String(input));
    const body =
      init?.body === undefined
        ? undefined
        : (JSON.parse(String(init.body)) as Record<string, unknown>);
    requests.push({ url, ...(body === undefined ? {} : { body }) });
    if (url.pathname.endsWith("createRecord")) {
      create++;
      const collection = String(body?.collection);
      return response({ uri: `at://did:plc:test/${collection}/created-${create}`, cid: "cid" });
    }
    if (url.pathname.endsWith("getRecord"))
      return response({
        value: { $type: "app.bsky.graph.list", name: "Old", purpose: "curatelist" },
      });
    if (url.pathname.endsWith("getList")) return response({ list: { name: "Friends" }, items: [] });
    if (url.pathname.endsWith("getLists")) return response({ lists: [], cursor: "lists-next" });
    return response({});
  });
  const native = social.native("default", { acknowledgeUnsafe: true })!;
  const list = await native.createList({
    account,
    name: "Friends",
    purpose: "app.bsky.graph.defs#curatelist",
  });
  await native.updateList({
    account,
    listUri: list.uri,
    name: "Close friends",
    purpose: "app.bsky.graph.defs#curatelist",
  });
  const item = await native.addListItem({ account, listUri: list.uri, subject: "did:plc:alice" });
  assert.equal((await native.getList({ account, listUri: list.uri })).list instanceof Object, true);
  assert.equal((await native.getLists({ account })).cursor, "lists-next");
  await native.muteList({ account, listUri: list.uri });
  await native.unmuteList({ account, listUri: list.uri });
  await native.blockList({ account, listUri: list.uri });
  await native.removeListItem({ account, uri: item.uri });
  await native.deleteList({ account, uri: list.uri });

  assert.ok(requests.some(({ url }) => url.pathname.endsWith("muteActorList")));
  assert.ok(requests.some(({ url }) => url.pathname.endsWith("unmuteActorList")));
  assert.equal(requests.filter(({ url }) => url.pathname.endsWith("deleteRecord")).length, 2);
});

it("pages list-block records before unblocking and creates moderation reports", async () => {
  const requests: Array<{ url: URL; body?: Record<string, unknown> }> = [];
  const listUri = "at://did:plc:list/app.bsky.graph.list/l1";
  const social = socialWith(async (input, init) => {
    const url = new URL(String(input));
    const body =
      init?.body === undefined
        ? undefined
        : (JSON.parse(String(init.body)) as Record<string, unknown>);
    requests.push({ url, ...(body === undefined ? {} : { body }) });
    if (url.pathname.endsWith("listRecords")) {
      if (!url.searchParams.has("cursor")) return response({ records: [], cursor: "page-2" });
      return response({
        records: [
          {
            uri: "at://did:plc:test/app.bsky.graph.listblock/list-block-rkey",
            value: { subject: listUri },
          },
        ],
      });
    }
    if (url.pathname.endsWith("createReport")) return response({ id: 42, reasonType: "spam" });
    return response({});
  });
  const native = social.native("default", { acknowledgeUnsafe: true })!;

  await native.unblockList({ account, listUri });
  const report = await native.createModerationReport({
    account,
    reasonType: "com.atproto.moderation.defs#reasonSpam",
    subject: { $type: "com.atproto.admin.defs#repoRef", did: "did:plc:spam" },
    reason: "Repeated spam",
  });

  const listPages = requests.filter(({ url }) => url.pathname.endsWith("listRecords"));
  assert.equal(listPages.length, 2);
  assert.equal(listPages[1]?.url.searchParams.get("cursor"), "page-2");
  assert.deepEqual(requests[2]?.body, {
    repo: "did:plc:test",
    collection: "app.bsky.graph.listblock",
    rkey: "list-block-rkey",
  });
  assert.equal(report["id"], 42);
});

it("rejects unsupported Bluesky all-search scope before network access", async () => {
  let calls = 0;
  const social = socialWith(async () => {
    calls++;
    return response({ posts: [] });
  });
  await assert.rejects(
    social.search.posts(account, { query: "hello", scope: "all" }),
    /scope 'all'/,
  );
  assert.equal(calls, 0);
});

it("deletes a platform post through posts.removeFromPlatform and accepts empty no-output bodies", async () => {
  const requests: Array<{ url: URL; headers: Headers; body?: Record<string, unknown> }> = [];
  const social = socialWith(async (input, init) => {
    requests.push({
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      ...(init?.body === undefined
        ? {}
        : { body: JSON.parse(String(init.body)) as Record<string, unknown> }),
    });
    return new Response(null, { status: 200 });
  });
  const post = platformPostRef({
    backend: "default",
    platform: "bluesky",
    accountId: account.accountId,
    postId: "at://did:plc:test/app.bsky.feed.post/r1",
    native: { uri: "at://did:plc:test/app.bsky.feed.post/r1", cid: "cid" },
  });
  const native = social.native("default", { acknowledgeUnsafe: true })!;

  await native.mute({ account, did: "did:plc:alice" });
  await native.unmute({ account, did: "did:plc:alice" });
  await native.muteList({ account, listUri: "at://did:plc:test/app.bsky.graph.list/l1" });
  await native.unmuteList({ account, listUri: "at://did:plc:test/app.bsky.graph.list/l1" });
  await native.markNotificationsSeen({ account, seenAt: "2026-09-22T00:00:00.000Z" });
  await social.posts.removeFromPlatform(post);

  assert.equal(requests.at(-1)?.url.pathname.endsWith("deleteRecord"), true);
  assert.equal(requests.at(-1)?.headers.get("content-type"), "application/json");
  assert.equal(requests.at(-1)?.body?.rkey, "r1");
});
