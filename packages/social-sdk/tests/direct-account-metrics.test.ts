import { test } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";
import { x } from "../src/platforms/x.js";
import { threads } from "../src/platforms/threads.js";
import { instagram } from "../src/platforms/instagram.js";

const context = (backend: string): AdapterOperationContext => ({
  backendInstance: backend,
  correlationId: "metrics",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
});

test("X account metrics request public user metrics and preserve zero values", async () => {
  const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });
  let requested: URL | undefined;

  const adapter = x({
    auth: { userId: "u1", accessToken: "token" },
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    fetch: async (input, init) => {
      assert.equal(init?.method, "GET");
      requested = new URL(String(input));

      return Response.json({
        data: {
          id: "u1",
          public_metrics: { followers_count: 0, tweet_count: 2, secret_count: 9 },
        },
      });
    },
  });

  const metrics = await adapter.analytics!.getAccountMetrics!(account, context("default"));
  assert.equal(requested?.pathname, "/2/users/u1");
  assert.equal(requested?.searchParams.get("user.fields"), "id,public_metrics");
  assert.deepEqual(
    metrics.map((metric) => [metric.name, metric.value]),
    [
      ["followers_count", 0],
      ["tweet_count", 2],
    ],
  );
  assert.equal(metrics[0]?.fetchedAt, "2026-01-01T00:00:00.000Z");
  await assert.rejects(
    adapter.analytics!.getAccountMetrics!({ ...account, accountId: "other" }, context("default")),
  );
});

test("Threads account insights map total and latest time-series values", async () => {
  const account = connectedAccountRef({ backend: "default", platform: "threads", accountId: "u1" });
  let requested: URL | undefined;

  const adapter = threads({
    auth: { userId: "u1", accessToken: "token" },
    clock: () => new Date("2026-01-02T00:00:00.000Z"),
    fetch: async (input, init) => {
      assert.equal(init?.method, "GET");
      requested = new URL(String(input));

      return Response.json({
        data: [
          {
            name: "views",
            period: "day",
            values: [
              { value: 0, end_time: "2026-01-01T00:00:00Z" },
              { value: 7, end_time: "2026-01-02T00:00:00Z" },
            ],
          },
          { name: "followers_count", total_value: { value: 4 } },
          { name: "likes", values: [{ value: 2 }] },
          {
            name: "replies",
            period: "day",
            total_value: { value: 3 },
            values: [{ value: 99, end_time: "2025-01-01T00:00:00Z" }],
          },
          { name: "follower_demographics", total_value: { value: "private" } },
        ],
      });
    },
  });

  const metrics = await adapter.analytics!.getAccountMetrics!(account, context("default"));
  assert.equal(requested?.pathname, "/v1.0/u1/threads_insights");
  assert.equal(
    requested?.searchParams.get("metric"),
    "views,likes,replies,reposts,quotes,clicks,followers_count",
  );
  assert.deepEqual(
    metrics.map((metric) => [metric.name, metric.value]),
    [
      ["views", 7],
      ["followers_count", 4],
      ["likes", 2],
      ["replies", 3],
    ],
  );
  assert.equal(metrics[0]?.measuredAt, "2026-01-02T00:00:00Z");
  assert.deepEqual(metrics[0]?.period, {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-02T00:00:00Z",
  });
  assert.equal(metrics[1]?.period, "lifetime");
  assert.equal(metrics[1]?.measuredAt, undefined);
  assert.equal(metrics[2]?.period, "unknown");
  assert.equal(metrics[3]?.period, "unknown");
  assert.equal(metrics[3]?.measuredAt, undefined);
});

test("Instagram account metrics use allowlisted profile fields and verify user identity", async () => {
  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  let requested: URL | undefined;

  const adapter = instagram({
    auth: { accountId: "ig1", accessToken: "token" },
    clock: () => new Date("2026-01-03T00:00:00.000Z"),
    fetch: async (input, init) => {
      assert.equal(init?.method, "GET");
      requested = new URL(String(input));

      return Response.json({ user_id: "ig1", followers_count: 0, media_count: 5, secret: "omit" });
    },
  });

  const metrics = await adapter.analytics!.getAccountMetrics!(account, context("instagram"));
  assert.equal(requested?.pathname, "/v25.0/me");
  assert.equal(requested?.searchParams.get("fields"), "user_id,followers_count,media_count");
  assert.deepEqual(
    metrics.map((metric) => [metric.name, metric.value]),
    [
      ["followers_count", 0],
      ["media_count", 5],
    ],
  );
  await assert.rejects(
    adapter.analytics!.getAccountMetrics!({ ...account, accountId: "other" }, context("instagram")),
  );
});
