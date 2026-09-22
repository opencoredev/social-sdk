import { test } from "node:test";
import assert from "node:assert/strict";
import { bluesky } from "../src/platforms/bluesky.js";
import { x } from "../src/platforms/x.js";
import { youtube } from "../src/platforms/youtube.js";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "parity",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

test("Bluesky parity native routes preserve AT Protocol records", async () => {
  const paths: string[] = [];

  const adapter = bluesky({
    auth: { service: "https://bsky.example", did: "did:plc:test", accessJwt: "token" },
    fetch: async (input) => {
      paths.push(new URL(String(input)).pathname);

      return Response.json({ uri: "at://did:plc:test/app.bsky.feed.repost/r1", cid: "cid" });
    },
  });

  const account = connectedAccountRef({
    backend: "default",
    platform: "bluesky",
    accountId: "did:plc:test",
  });

  await adapter.native!.repostPost({
    account,
    post: { uri: "at://did:plc:other/app.bsky.feed.post/p1", cid: "cid" },
    context,
  });
  await adapter.native!.deletePost({
    account,
    post: { uri: "at://did:plc:test/app.bsky.feed.post/p1", cid: "cid" },
    context,
  });
  assert.deepEqual(paths, [
    "/xrpc/com.atproto.repo.createRecord",
    "/xrpc/com.atproto.repo.deleteRecord",
  ]);
});

test("X parity native engagement and poll operations use typed routes", async () => {
  const calls: Array<{ path: string; method: string }> = [];

  const adapter = x({
    auth: { userId: "u1", accessToken: "token" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, method: init?.method ?? "GET" });

      return Response.json({ data: { id: "ok" } });
    },
  });

  const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });
  await adapter.native!.createPoll({
    account,
    text: "Choose",
    options: ["A", "B"],
    durationMinutes: 60,
    context,
  });
  await adapter.native!.deletePost({ account, postId: "p1", context });
  assert.deepEqual(
    calls.map((call) => [call.path, call.method]),
    [
      ["/2/tweets", "POST"],
      ["/2/tweets/p1", "DELETE"],
    ],
  );
});

test("YouTube parity declares native API families", () => {
  const adapter = youtube({ auth: { accessToken: "token", channelId: "channel" } });
  const operations = adapter.capabilities.capabilities.map((entry) => entry.operation);

  for (const operation of [
    "posts.schedule",
    "thumbnails.write",
    "captions.write",
    "playlists.write",
    "posts.delete",
    "analytics.youtube.read",
    "live.broadcasts",
  ])
    assert.ok(operations.includes(operation));
});
