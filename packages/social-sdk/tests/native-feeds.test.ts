import { strict as assert } from "node:assert";
import { it } from "node:test";
import { youtube } from "../src/platforms/youtube.js";
import { linkedin } from "../src/platforms/linkedin.js";
import { tiktok } from "../src/platforms/tiktok.js";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";

const context = (backend: string): AdapterOperationContext => ({
  backendInstance: backend,
  correlationId: "feed",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

it("LinkedIn sends plain author URN and ends paging without a next link or remaining total", async () => {
  const author = "urn:li:person:owner";
  const urls: URL[] = [];
  let foreign = false;

  const adapter = linkedin({
    auth: { accessToken: "token", author },
    apiVersion: "202609",
    fetch: async (input) => {
      const url = new URL(String(input));
      urls.push(url);

      return json({
        elements: [
          {
            id: "urn:li:share:1",
            author: foreign ? "urn:li:person:other" : author,
            commentary: "hello",
            secret: "hidden",
          },
        ],
        paging: { start: Number(url.searchParams.get("start")), count: 1, total: 2 },
      });
    },
  });

  const account = connectedAccountRef({
    backend: "linkedin",
    platform: "linkedin",
    accountId: author,
  });

  const first = await adapter.posts!.list!(account, { limit: 1 }, context("linkedin"));
  assert.equal(urls[0]!.searchParams.get("author"), author);
  assert.equal(first.nextCursor, "1");
  assert.equal(first.items[0]!["secret"], undefined);
  assert.equal(
    (
      await adapter.posts!.list!(
        account,
        { limit: 1, cursor: first.nextCursor },
        context("linkedin"),
      )
    ).nextCursor,
    undefined,
  );
  const before = urls.length;
  await assert.rejects(adapter.posts!.list!(account, { cursor: "-1" }, context("linkedin")));
  await assert.rejects(adapter.posts!.list!(account, { limit: 1.5 }, context("linkedin")));
  assert.equal(urls.length, before);
  foreign = true;
  await assert.rejects(adapter.posts!.list!(account, {}, context("linkedin")), /another author/);
});

it("TikTok uses video query filters and has_more to terminate its feed", async () => {
  const requests: { url: URL; body: any }[] = [];

  const adapter = tiktok({
    auth: { accessToken: "token", openId: "u" },
    verifiedMediaOrigins: [],
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body));
      requests.push({ url, body });

      return json({
        data: {
          videos: [{ id: "v", title: "hello", secret: "hidden" }],
          cursor: 123,
          has_more: body.cursor === 0,
        },
        error: { code: "ok" },
      });
    },
  });

  const account = connectedAccountRef({ backend: "tiktok", platform: "tiktok", accountId: "u" });
  const first = await adapter.posts!.list!(account, { limit: 2 }, context("tiktok"));
  assert.deepEqual(requests[0]!.body, { cursor: 0, max_count: 2 });
  assert.equal(first.nextCursor, "123");
  assert.equal(
    (await adapter.posts!.list!(account, { cursor: "123" }, context("tiktok"))).nextCursor,
    undefined,
  );

  const post = await adapter.posts!.get!(
    { ...account, kind: "platform-post", postId: "v" },
    context("tiktok"),
  );

  assert.equal(post["secret"], undefined);
  assert.deepEqual(requests[2]!.body, { filters: { video_ids: ["v"] } });
  assert.ok(requests[2]!.url.searchParams.get("fields")?.includes("id"));
  const before = requests.length;
  await assert.rejects(adapter.posts!.list!(account, { limit: 21 }, context("tiktok")));
  await assert.rejects(adapter.posts!.list!(account, { cursor: "NaN" }, context("tiktok")));
  assert.equal(requests.length, before);
});

it("YouTube resolves channel uploads and returns native video IDs across pages", async () => {
  const urls: URL[] = [];
  let foreign = false;

  const adapter = youtube({
    auth: { accessToken: "token", channelId: "ch" },
    fetch: async (input) => {
      const url = new URL(String(input));
      urls.push(url);

      if (url.pathname.endsWith("channels"))
        return json({
          items: [
            {
              id: foreign ? "other" : "ch",
              contentDetails: { relatedPlaylists: { uploads: "uploads" } },
            },
          ],
        });

      return json({
        items: [
          {
            id: "playlist-entry",
            snippet: { channelId: "ch", title: "hello" },
            contentDetails: { videoId: "video" },
            secret: "hidden",
          },
        ],
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(url.searchParams.has("pageToken") ? {} : { nextPageToken: "next" }),
      });
    },
  });

  const account = connectedAccountRef({ backend: "youtube", platform: "youtube", accountId: "ch" });
  const first = await adapter.posts!.list!(account, { limit: 1 }, context("youtube"));
  assert.equal(first.items[0]!["id"], "video");
  assert.equal(first.items[0]!["secret"], undefined);
  assert.equal(urls[1]!.searchParams.get("playlistId"), "uploads");
  assert.equal(
    (await adapter.posts!.list!(account, { cursor: "next", limit: 1 }, context("youtube")))
      .nextCursor,
    undefined,
  );
  assert.equal(urls[3]!.searchParams.get("pageToken"), "next");
  const before = urls.length;
  await assert.rejects(adapter.posts!.list!(account, { limit: 51 }, context("youtube")));
  assert.equal(urls.length, before);
  foreign = true;
  await assert.rejects(adapter.posts!.list!(account, {}, context("youtube")), /Configured channel/);
});
