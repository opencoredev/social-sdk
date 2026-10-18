import { test } from "node:test";
import assert from "node:assert/strict";
import { bluesky } from "../src/platforms/bluesky.js";
import { x } from "../src/platforms/x.js";
import { youtube } from "../src/platforms/youtube.js";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";
import { instagram } from "../src/platforms/instagram.js";
import { linkedin } from "../src/platforms/linkedin.js";
import { threads } from "../src/platforms/threads.js";
import * as server from "../src/server/index.js";

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

      return Response.json({ data: init?.method === "DELETE" ? { deleted: true } : { id: "ok" } });
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

test("lifecycle vocabulary is available to capability and authorization contracts", () => {
  const adapters = [
    [
      "bluesky",
      bluesky({
        auth: { service: "https://bsky.example", did: "did:plc:test", accessJwt: "token" },
        fetch: async () => Response.json({}),
      }),
      ["comments.moderate", "posts.update"],
    ],
    [
      "instagram",
      instagram({
        auth: { accountId: "ig1", accessToken: "token" },
        fetch: async () => Response.json({}),
      }),
      ["comments.moderate", "comments.delete", "posts.update"],
    ],
    [
      "linkedin",
      linkedin({
        auth: { accessToken: "token", author: "urn:li:person:person-1" },
        apiVersion: "202601",
        fetch: async () => Response.json({}),
      }),
      ["comments.delete", "posts.delete", "posts.update"],
    ],
    [
      "threads",
      threads({
        auth: { userId: "threads-1", accessToken: "token" },
        fetch: async () => Response.json({}),
      }),
      ["comments.delete", "comments.moderate", "posts.delete", "posts.update"],
    ],
    [
      "x",
      x({ auth: { userId: "u1", accessToken: "token" }, fetch: async () => Response.json({}) }),
      ["comments.moderate", "posts.update"],
    ],
    [
      "youtube",
      youtube({ auth: { accessToken: "token", channelId: "channel" } }),
      ["comments.delete", "comments.moderate", "posts.delete", "posts.update"],
    ],
  ] as const;

  for (const [id, adapter, lifecycleOperations] of adapters) {
    const declared = new Set(adapter.capabilities.capabilities.map((entry) => entry.operation));

    assert.ok(declared.size > 0, `${id} should expose a non-empty capability manifest`);

    for (const operation of lifecycleOperations) {
      assert.ok(declared.has(operation), `${id} should declare ${operation}`);
    }
  }
});

test("native lifecycle operations remain explicit instead of being advertised as normalized methods", () => {
  const adapters = [
    [
      "bluesky",
      bluesky({
        auth: { service: "https://bsky.example", did: "did:plc:test", accessJwt: "token" },
        fetch: async () => Response.json({}),
      }),
      ["deletePost", "hideReply"],
    ],
    [
      "threads",
      threads({
        auth: { userId: "threads-1", accessToken: "token" },
        fetch: async () => Response.json({}),
      }),
      ["deletePost", "hideReply", "deleteComment"],
    ],
    [
      "linkedin",
      linkedin({
        auth: { accessToken: "token", author: "urn:li:person:person-1" },
        apiVersion: "202601",
        fetch: async () => Response.json({}),
      }),
      ["updatePost", "deletePost", "deleteComment"],
    ],
    [
      "x",
      x({ auth: { userId: "u1", accessToken: "token" }, fetch: async () => Response.json({}) }),
      ["updatePost", "deletePost", "hideReply"],
    ],
  ] as const;

  for (const [id, adapter, nativeOperations] of adapters) {
    assert.ok(adapter.native, `${id} should expose its native surface`);

    for (const operation of nativeOperations) {
      assert.ok(
        Object.keys(adapter.native).includes(operation),
        `${id}.${operation} should remain native-only`,
      );
    }

    if (adapter.posts !== undefined) {
      assert.equal(Object.hasOwn(adapter.posts, "update"), false);
    }

    if (adapter.comments !== undefined) {
      assert.equal(Object.hasOwn(adapter.comments, "delete"), false);
      assert.equal(Object.hasOwn(adapter.comments, "moderate"), false);
    }
  }
});

test("the server subpath exports the normalized webhook facade", () => {
  assert.ok(Object.hasOwn(server, "acceptWebhook"));
  assert.ok(Object.hasOwn(server, "decodeWebhook"));
  assert.ok(Object.hasOwn(server, "verifyPostForMeWebhook"));
  assert.ok(Object.hasOwn(server, "verifyZernioWebhook"));
});
