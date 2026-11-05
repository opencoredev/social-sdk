import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, type AdapterOperationContext } from "../src/index.js";
import type { JsonValue } from "../src/core/types.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "11" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "x-broadcasts-user",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

interface Seen {
  readonly method: string;
  readonly href: string;
  readonly body: JsonValue | undefined;
}

function fake(routes: Readonly<Record<string, JsonValue>>) {
  const seen: Seen[] = [];

  const adapter = x({
    auth: { userId: "11", accessToken: "user" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      seen.push({
        method,
        href: url.href,
        body:
          init?.body === undefined || init.body === null
            ? undefined
            : JSON.parse(String(init.body)),
      });

      const route = routes[`${method} ${url.pathname}`];

      return route === undefined
        ? Response.json({ title: "Not Found" }, { status: 404 })
        : Response.json(route);
    },
  });

  assert.ok(adapter.native);

  return { native: adapter.native, seen };
}

it("mutes and unmutes a user in one broadcast at /2/broadcasts/{id}/chat/mutes", async () => {
  const { native, seen } = fake({
    "POST /2/broadcasts/1yNGaZbBzRjKj/chat/mutes": { data: { muted: true } },
    "DELETE /2/broadcasts/1yNGaZbBzRjKj/chat/mutes/12": { data: { muted: false } },
  });

  await native.setBroadcastChatMute({
    account,
    broadcastId: "1yNGaZbBzRjKj",
    userId: "12",
    muted: true,
    endAt: "2026-11-04T12:00:00.000Z",
    removeMessageId: "1700000000000000000",
    context,
  });
  await native.setBroadcastChatMute({
    account,
    broadcastId: "1yNGaZbBzRjKj",
    userId: "12",
    muted: false,
    context,
  });

  assert.deepEqual(seen[0]?.body, {
    user_id: "12",
    end_at_ms: String(Date.parse("2026-11-04T12:00:00.000Z")),
    message_id: "1700000000000000000",
  });
  assert.equal(seen[1]?.method, "DELETE");
});

it("manages user-scoped /2/users/{id}/broadcasts and /2/users/{id}/sources", async () => {
  const { native, seen } = fake({
    "GET /2/users/11/broadcasts": {
      data: { broadcasts: [{ id: "1yNGaZbBzRjKj" }], next_token: { offset: "o2" } },
    },
    "GET /2/users/11/broadcasts/1yNGaZbBzRjKj": { data: { broadcast: { id: "1yNGaZbBzRjKj" } } },
    "POST /2/users/11/broadcasts": {
      data: {
        broadcast: { id: "1yNGaZbBzRjKj" },
        share_url: "https://x.com/i/broadcasts/1yNGaZbBzRjKj",
        video_access: {},
      },
    },
    "PUT /2/users/11/broadcasts/1yNGaZbBzRjKj/state": {
      data: { broadcast: { id: "1yNGaZbBzRjKj", state: "RUNNING" } },
    },
    "DELETE /2/users/11/broadcasts/1yNGaZbBzRjKj": { data: { success: true } },
    "GET /2/users/11/sources": { data: { sources: [{ id: "src1", name: "Studio" }] } },
    "GET /2/users/11/sources/src1": { data: { source: { id: "src1" } } },
    "POST /2/users/11/sources": { data: { source: { id: "src2", name: "Field" } } },
    "PUT /2/users/11/sources/src2": { data: { source: { id: "src2", name: "Field B" } } },
    "DELETE /2/users/11/sources/src2": { data: {} },
  });

  const page = await native.userBroadcasts({ account, context });

  assert.deepEqual(page, { items: [{ id: "1yNGaZbBzRjKj" }], nextCursor: "o2" });
  assert.equal(
    (await native.getUserBroadcast({ account, broadcastId: "1yNGaZbBzRjKj", context }))["id"],
    "1yNGaZbBzRjKj",
  );

  const created = await native.createUserBroadcast({ account, sourceId: "src1", context });

  assert.equal(created.shareUrl, "https://x.com/i/broadcasts/1yNGaZbBzRjKj");

  await native.setUserBroadcastState({
    account,
    broadcastId: "1yNGaZbBzRjKj",
    state: { kind: "publish", title: "Launch", shouldNotTweet: true },
    context,
  });

  assert.deepEqual(seen[3]?.body, { state: "PUBLISH", title: "Launch", should_not_tweet: true });

  await native.deleteUserBroadcast({ account, broadcastId: "1yNGaZbBzRjKj", context });

  assert.equal((await native.userStreamSources({ account, context })).length, 1);
  await native.getUserStreamSource({ account, sourceId: "src1", context });
  await native.createUserStreamSource({ account, name: "Field", region: "atla", context });
  assert.deepEqual(seen[7]?.body, { name: "Field", region: "atla" });
  assert.equal(
    (await native.renameUserStreamSource({ account, sourceId: "src2", name: "Field B", context }))[
      "name"
    ],
    "Field B",
  );
  await native.deleteUserStreamSource({ account, sourceId: "src2", context });
  assert.equal(seen[9]?.method, "DELETE");
});

it("reads the ingest region from /2/region", async () => {
  const { native, seen } = fake({ "GET /2/region": { region: "us-west-2" } });

  assert.equal(await native.ingestRegion({ account, context }), "us-west-2");
  assert.equal(new URL(seen[0]?.href ?? "").pathname, "/2/region");
});

it("schedules a recurring locked broadcast with a thumbnail and updates it", async () => {
  const scheduled = {
    scheduled_broadcast_id: "1900000000000000000",
    broadcast_id: "1yNGaZbBzRjKj",
  };

  const { native, seen } = fake({
    "POST /2/broadcasts/scheduled": { data: scheduled },
    "PUT /2/broadcasts/scheduled/1yNGaZbBzRjKj": { data: scheduled },
    "GET /2/broadcasts/scheduled/1yNGaZbBzRjKj": { data: scheduled },
    "GET /2/broadcasts/scheduled": { data: [scheduled] },
  });

  await native.scheduleBroadcast({
    account,
    broadcast: {
      sourceId: "src1",
      startAt: "2026-11-05T18:00:00Z",
      isLocked: true,
      thumbnailMediaId: "1146654567674912769",
      recurrence: { frequency: "Weekly", repeats: 4 },
    },
    context,
  });

  assert.deepEqual(seen[0]?.body, {
    source_id: "src1",
    scheduled_start_ms: String(Date.parse("2026-11-05T18:00:00Z")),
    is_locked: true,
    thumbnail_media_id: "1146654567674912769",
    recurrence: { frequency: "Weekly", repeats: "4" },
  });

  await native.updateScheduledBroadcast({
    account,
    broadcastId: "1yNGaZbBzRjKj",
    scheduledBroadcastId: "1900000000000000000",
    broadcast: {
      startAt: "2026-11-05T18:00:00Z",
      endAt: "2026-11-05T19:00:00Z",
      thumbnailMediaId: "1146654567674912770",
    },
    context,
  });

  assert.deepEqual(seen[1]?.body, {
    scheduled_broadcast_id: "1900000000000000000",
    scheduled_start_ms: String(Date.parse("2026-11-05T18:00:00Z")),
    scheduled_end_ms: String(Date.parse("2026-11-05T19:00:00Z")),
    thumbnail_media_id: "1146654567674912770",
  });

  await native.getScheduledBroadcast({ account, broadcastId: "1yNGaZbBzRjKj", context });
  await native.scheduledBroadcasts({
    account,
    oldestStartAt: "2026-11-01T00:00:00Z",
    newestStartAt: "2026-12-01T00:00:00Z",
    context,
  });

  const listUrl = new URL(seen[3]?.href ?? "");

  assert.equal(listUrl.searchParams.get("oldest_start_time"), "2026-11-01T00:00:00Z");
  assert.equal(listUrl.searchParams.get("newest_start_time"), "2026-12-01T00:00:00Z");
});
