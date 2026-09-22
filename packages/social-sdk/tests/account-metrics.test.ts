import { strict as assert } from "node:assert";
import { it } from "node:test";
import { bluesky } from "../src/platforms/bluesky.js";
import { linkedin } from "../src/platforms/linkedin.js";
import { youtube } from "../src/platforms/youtube.js";
import { tiktok } from "../src/platforms/tiktok.js";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";
import { zernio } from "../src/cloud/zernio.js";

const context = (backend: string): AdapterOperationContext => ({
  backendInstance: backend,
  correlationId: "metrics",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

it("reads Bluesky profile counts and omits absent metrics", async () => {
  const adapter = bluesky({
    backend: "direct",
    auth: { service: "https://bsky.example", did: "did:plc:a", accessJwt: "jwt" },
    fetch: async () => json({ did: "did:plc:a", followersCount: 3, postsCount: 0 }),
  });

  const account = connectedAccountRef({
    backend: "direct",
    platform: "bluesky",
    accountId: "did:plc:a",
  });

  const metrics = await adapter.analytics?.getAccountMetrics?.(account, context("direct"));
  assert.deepEqual(
    metrics?.map((metric) => [metric.name, metric.value]),
    [
      ["followers", 3],
      ["posts", 0],
    ],
  );
  await assert.rejects(() =>
    adapter.analytics?.getAccountMetrics?.(
      connectedAccountRef({ backend: "direct", platform: "bluesky", accountId: "did:plc:b" }),
      context("direct"),
    ),
  );
});

it("reads Zernio follower snapshots from the documented accounts response", async () => {
  let requested: URL | undefined;

  const adapter = zernio({
    apiKey: "test",
    fetch: async (input) => {
      requested = new URL(String(input));

      return json({
        accounts: [
          {
            _id: "acct-1",
            platform: "twitter",
            followersCount: 0,
            followersLastUpdated: "2026-01-02T00:00:00Z",
            secret: "redact",
          },
          { _id: "acct-other", platform: "twitter", followersCount: 99 },
        ],
      });
    },
    clock: () => new Date("2026-01-03T00:00:00Z"),
  });

  const account = connectedAccountRef({ backend: "zernio", platform: "x", accountId: "acct-1" });
  const metrics = await adapter.analytics!.getAccountMetrics!(account, context("zernio"));
  assert.equal(requested?.pathname, "/api/v1/accounts");
  assert.equal(requested?.searchParams.get("platform"), "twitter");
  assert.deepEqual(metrics, [
    {
      name: "followers",
      value: 0,
      unit: "count",
      period: "lifetime",
      measuredAt: "2026-01-02T00:00:00Z",
      freshness: "reported",
      fetchedAt: "2026-01-03T00:00:00.000Z",
      source: "zernio:x:account",
    },
  ]);
  await assert.rejects(
    adapter.analytics!.getAccountMetrics!(
      { ...account, accountId: "acct-missing" },
      context("zernio"),
    ),
    { code: "unauthorized" },
  );
});

it("reads YouTube channel statistics only for the configured channel", async () => {
  const adapter = youtube({
    auth: { accessToken: "jwt", channelId: "ch" },
    fetch: async () =>
      json({
        items: [
          {
            id: "ch",
            statistics: {
              viewCount: "4",
              subscriberCount: "99",
              hiddenSubscriberCount: true,
              videoCount: "0",
            },
          },
        ],
      }),
  });

  const account = connectedAccountRef({ backend: "youtube", platform: "youtube", accountId: "ch" });
  const metrics = await adapter.analytics?.getAccountMetrics?.(account, context("youtube"));
  assert.deepEqual(
    metrics?.map((metric) => [metric.name, metric.value]),
    [
      ["viewCount", 4],
      ["videoCount", 0],
    ],
  );
});

it("reads TikTok account stats and post metrics with ownership checks", async () => {
  let queryUrl = "";
  let queryBody: unknown;

  const adapter = tiktok({
    auth: { accessToken: "jwt", openId: "u" },
    verifiedMediaOrigins: ["https://cdn.example"],
    fetch: async (input, init) => {
      queryUrl = String(input);
      queryBody = init?.body ? JSON.parse(String(init.body)) : undefined;

      return init?.method === "POST"
        ? json({ data: { videos: [{ id: "v", view_count: 5 }] }, error: { code: "ok" } })
        : json({ data: { user: { open_id: "u", follower_count: 2 } }, error: { code: "ok" } });
    },
  });

  const account = connectedAccountRef({ backend: "tiktok", platform: "tiktok", accountId: "u" });
  const metrics = await adapter.analytics?.getAccountMetrics?.(account, context("tiktok"));
  assert.deepEqual(
    metrics?.map((metric) => [metric.name, metric.value]),
    [["follower_count", 2]],
  );

  const postMetrics = await adapter.analytics?.getPostMetrics?.(
    {
      kind: "platform-post",
      version: 1,
      backend: "tiktok",
      platform: "tiktok",
      accountId: "u",
      postId: "v",
    },
    context("tiktok"),
  );

  assert.deepEqual(
    postMetrics?.map((metric) => [metric.name, metric.value]),
    [["view_count", 5]],
  );
  assert.match(queryUrl, /fields=id%2Clike_count%2Ccomment_count%2Cshare_count%2Cview_count/);
  assert.deepEqual(queryBody, { filters: { video_ids: ["v"] } });
});

it("LinkedIn organization counts use versioned networkSizes and reject member/cross-account calls", async () => {
  let calls = 0;
  let url = "";
  let count: number | undefined = 0;

  const fetch: typeof globalThis.fetch = async (input) => {
    calls++;
    url = String(input);

    return json(count === undefined ? {} : { firstDegreeSize: count });
  };

  const author = "urn:li:organization:123";
  const adapter = linkedin({ auth: { accessToken: "token", author }, apiVersion: "202609", fetch });

  const account = connectedAccountRef({
    backend: "linkedin",
    platform: "linkedin",
    accountId: author,
  });

  const metrics = await adapter.analytics!.getAccountMetrics!(account, context("linkedin"));
  assert.deepEqual(
    metrics.map((metric) => [metric.name, metric.value, metric.freshness]),
    [["followers", 0, "unknown"]],
  );
  assert.equal(new URL(url).pathname, "/rest/networkSizes/urn%3Ali%3Aorganization%3A123");
  assert.equal(new URL(url).searchParams.get("edgeType"), "COMPANY_FOLLOWED_BY_MEMBER");
  count = undefined;
  assert.deepEqual(await adapter.analytics!.getAccountMetrics!(account, context("linkedin")), []);
  const before = calls;
  await assert.rejects(
    adapter.analytics!.getAccountMetrics!(
      { ...account, accountId: "urn:li:organization:other" },
      context("linkedin"),
    ),
  );

  const member = linkedin({
    auth: { accessToken: "token", author: "urn:li:person:123" },
    apiVersion: "202609",
    fetch,
  });

  await assert.rejects(
    member.analytics!.getAccountMetrics!(
      { ...account, accountId: "urn:li:person:123" },
      context("linkedin"),
    ),
    /organization follower/,
  );
  assert.equal(calls, before);
});
