import { strict as assert } from "node:assert";
import { it } from "node:test";
import { bluesky } from "../src/platforms/bluesky.js";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";
import { object } from "../src/transport/validation.js";

const did = "did:plc:review";

const account = connectedAccountRef({ backend: "default", platform: "bluesky", accountId: did });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "review-gallery",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

const recordEmbed = {
  $type: "app.bsky.embed.gallery",
  items: Array.from({ length: 5 }, (_, i) => ({
    $type: "app.bsky.embed.gallery#image",
    image: {
      $type: "blob",
      ref: { $link: "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" },
      mimeType: "image/jpeg",
      size: 100,
    },
    alt: `Image ${i}`,
    aspectRatio: { width: 100, height: 100 },
  })),
};

const viewEmbed = {
  $type: "app.bsky.embed.gallery#view",
  items: Array.from({ length: 5 }, (_, i) => ({
    $type: "app.bsky.embed.gallery#viewImage",
    thumbnail: `https://cdn.example/thumb-${i}.jpg`,
    fullsize: `https://cdn.example/full-${i}.jpg`,
    alt: `Image ${i}`,
    aspectRatio: { width: 100, height: 100 },
  })),
};

async function listedPost() {
  const adapter = bluesky({
    auth: { service: "https://pds.example", did, accessJwt: "fixture" },
    fetch: async () =>
      new Response(
        JSON.stringify({
          feed: [
            {
              post: {
                uri: `at://${did}/app.bsky.feed.post/3kpost`,
                cid: "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
                author: { did, handle: "review.example" },
                record: {
                  $type: "app.bsky.feed.post",
                  text: "Gallery",
                  createdAt: "2026-11-04T00:00:00Z",
                  embed: recordEmbed,
                },
                embed: viewEmbed,
              },
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  });

  assert.ok(adapter.posts?.list);
  const result = await adapter.posts.list(account, {}, context);

  return object(object(result.items[0])["post"]);
}

it("posts.list preserves gallery blob references from the format newly supported by publish", async () => {
  const post = await listedPost();
  assert.deepEqual(object(post["record"])["embed"], recordEmbed);
});

it("posts.list preserves gallery view image URLs and alt text", async () => {
  const post = await listedPost();
  assert.deepEqual(post["embed"], viewEmbed);
});
