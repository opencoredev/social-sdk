import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { postForMe } from "../src/cloud/post-for-me.js";
import { zernio } from "../src/cloud/zernio.js";
import { bluesky } from "../src/platforms/bluesky.js";

const context = {
  backendInstance: "default",
  correlationId: "feed-test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 5_000 },
};

it("Post for Me lists only the requested account feed and preserves its cursor", async () => {
  const account = connectedAccountRef({
    backend: "default",
    platform: "x",
    accountId: "account-1",
  });

  const adapter = postForMe({
    apiKey: "test",
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/v1/social-account-feeds/account-1");
      assert.equal(url.searchParams.get("limit"), "2");

      return Response.json({
        data: [
          {
            social_account_id: "account-1",
            platform_post_id: "native-1",
            caption: "ok",
            secret: "redact",
          },
          { social_account_id: "other", platform_post_id: "native-2" },
        ],
        meta: {
          cursor: "opaque-2",
          has_more: true,
          next: "https://api.postforme.dev/v1/items?cursor=opaque-2",
        },
      });
    },
  });

  const page = await adapter.posts!.list!(account, { limit: 2 }, context);
  assert.deepEqual(page.items, [
    { social_account_id: "account-1", platform_post_id: "native-1", caption: "ok" },
  ]);
  assert.equal(page.nextCursor, "opaque-2");
});

it("Post for Me continues required-only pagination metadata without following next URLs", async () => {
  const account = connectedAccountRef({
    backend: "default",
    platform: "x",
    accountId: "account-1",
  });

  const adapter = postForMe({
    apiKey: "test",
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/v1/social-account-feeds/account-1");
      assert.equal(url.searchParams.get("cursor"), "opaque-2");

      return Response.json({ data: [], meta: { cursor: "opaque-2", next: "opaque-3" } });
    },
  });

  const page = await adapter.posts!.list!(account, { cursor: "opaque-2" }, context);
  assert.equal(page.nextCursor, "opaque-2");
});

it("Zernio lists external native posts and filters platform/account destinations", async () => {
  const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "acct-1" });

  const adapter = zernio({
    apiKey: "test",
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/api/v1/posts");
      assert.equal(url.searchParams.get("source"), "external");
      assert.equal(url.searchParams.get("accountId"), "acct-1");

      return Response.json({
        posts: [
          {
            _id: "backend-1",
            content: "native",
            platforms: [
              {
                platform: "twitter",
                accountId: "acct-1",
                platformPostId: "tweet-1",
                platformPostUrl: "https://x.test/1",
              },
              { platform: "linkedin", accountId: "other", platformPostId: "wrong" },
            ],
            secret: "redact",
          },
          {
            _id: "backend-2",
            platforms: [{ platform: "twitter", accountId: "other", platformPostId: "wrong" }],
          },
        ],
        pagination: { pages: 2 },
      });
    },
  });

  const page = await adapter.posts!.list!(account, {}, context);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.["platformPostId"], "tweet-1");
  assert.equal(page.items[0]?.["backendPostId"], "backend-1");
  assert.equal(page.nextCursor, "2");
  assert.equal(page.items[0]?.["secret"], undefined);
});

it("Bluesky lists author-feed entries with safe post and repost reason fields", async () => {
  const account = connectedAccountRef({
    backend: "default",
    platform: "bluesky",
    accountId: "did:plc:me",
  });

  const adapter = bluesky({
    auth: { service: "https://bsky.test", did: "did:plc:me", accessJwt: "token" },
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/xrpc/app.bsky.feed.getAuthorFeed");
      assert.equal(url.searchParams.get("actor"), "did:plc:me");

      return Response.json({
        feed: [
          {
            post: {
              uri: "at://post/1",
              cid: "cid",
              author: { did: "did:plc:other" },
              record: { text: "hello" },
              secret: "redact",
            },
            reason: {
              $type: "app.bsky.feed.defs#reasonRepost",
              by: { did: "did:plc:me" },
              secret: "redact",
            },
          },
        ],
        cursor: "next",
      });
    },
  });

  const page = await adapter.posts!.list!(account, { limit: 1 }, context);
  assert.equal(page.nextCursor, "next");
  assert.equal(page.items[0]?.["post"]["uri"], "at://post/1");
  assert.equal(page.items[0]?.["reason"]["$type"], "app.bsky.feed.defs#reasonRepost");
  assert.equal(page.items[0]?.["post"]["secret"], undefined);
  await assert.rejects(
    adapter.posts!.list!({ ...account, accountId: "did:plc:other" }, {}, context),
    /does not belong/,
  );
});
