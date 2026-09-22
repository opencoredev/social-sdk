/* oxlint-disable anti-slop/require-readable-spacing -- provider fixture setup stays grouped by scenario. */
import { strict as assert } from "node:assert";
import { it } from "node:test";
import { youtube } from "../src/platforms/youtube.js";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";

const context = (backend: string): AdapterOperationContext => ({
  backendInstance: backend,
  correlationId: "analytics-report",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- test fixture serializer.
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

it("reads a bounded YouTube Analytics report into provider-neutral rows", async () => {
  let requested = "";
  const adapter = youtube({
    auth: { accessToken: "jwt", channelId: "channel-1" },
    fetch: async (input) => {
      requested = String(input);

      return json({
        columnHeaders: [
          { name: "day", columnType: "DIMENSION" },
          { name: "views", columnType: "METRIC" },
          { name: "estimatedMinutesWatched", columnType: "METRIC" },
        ],
        rows: [["2026-01-01", "12", "3.5"]],
      });
    },
  });
  const account = connectedAccountRef({
    backend: "youtube",
    platform: "youtube",
    accountId: "channel-1",
  });

  const report = await adapter.analytics!.getReport!(
    account,
    {
      from: "2026-01-01",
      to: "2026-01-31",
      metrics: ["views", "estimatedMinutesWatched"],
      dimensions: ["day"],
    },
    context("youtube"),
  );

  assert.deepEqual(report.rows, [
    {
      dimensions: { day: "2026-01-01" },
      metrics: { views: 12, estimatedMinutesWatched: 3.5 },
    },
  ]);
  const url = new URL(requested);
  assert.equal(url.pathname, "/v2/reports");
  assert.equal(url.searchParams.get("startDate"), "2026-01-01");
  assert.equal(url.searchParams.get("endDate"), "2026-01-31");
  assert.equal(url.searchParams.get("ids"), "channel==channel-1");
});

it("rejects unbounded or unsafe YouTube report queries", async () => {
  const adapter = youtube({
    auth: { accessToken: "jwt", channelId: "channel-1" },
    fetch: async () => json({}),
  });
  const account = connectedAccountRef({
    backend: "youtube",
    platform: "youtube",
    accountId: "channel-1",
  });

  await assert.rejects(
    adapter.analytics!.getReport!(
      account,
      { from: "2026-02-01", to: "2026-01-01", metrics: ["views"] },
      context("youtube"),
    ),
    { code: "invalid_input" },
  );
  await assert.rejects(
    adapter.analytics!.getReport!(
      account,
      { from: "2026-01-01", to: "2026-01-02", metrics: ["views&bad"] },
      context("youtube"),
    ),
    { code: "invalid_input" },
  );
});
