import { strict as assert } from "node:assert";
import { it } from "node:test";
import { x } from "../src/platforms/x.js";
import { threads } from "../src/platforms/threads.js";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";

const context = (backendInstance = "default"): AdapterOperationContext => ({
  backendInstance,
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
});

it("publishes an X tweet with a reply", async () => {
  const calls: string[] = [];

  const adapter = x({
    auth: { userId: "u1", accessToken: "token" },
    fetch: async (input) => {
      calls.push(String(input));

      if (String(input).includes("tweets?"))
        return new Response(
          JSON.stringify({ data: { id: "1", public_metrics: { like_count: 3 } } }),
          { status: 200 },
        );

      return new Response(JSON.stringify({ data: { id: "2" } }), { status: 200 });
    },
  });

  const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });

  const result = await adapter.posts?.publishTarget(
    {
      targetIndex: 0,
      targetKey: "x",
      account,
      content: { text: "hello" },
      replyTo: {
        kind: "platform-post",
        version: 1,
        backend: "default",
        platform: "x",
        accountId: "u1",
        postId: "0",
      },
    },
    context(),
  );

  assert.equal(result?.state, "published");
  assert.ok(calls.some((call) => call.includes("api.x.com/2/tweets")));
});

it("creates and publishes a Threads text container", async () => {
  const calls: string[] = [];

  const adapter = threads({
    auth: { userId: "u1", accessToken: "token" },
    fetch: async (input, init) => {
      calls.push(String(input));

      if (init?.method === "GET")
        return new Response(JSON.stringify({ id: "container", status: "FINISHED" }), {
          status: 200,
        });

      return new Response(JSON.stringify({ id: calls.length === 1 ? "container" : "published" }), {
        status: 200,
      });
    },
  });

  const account = connectedAccountRef({ backend: "default", platform: "threads", accountId: "u1" });

  const result = await adapter.posts?.publishTarget(
    { targetIndex: 0, targetKey: "threads", account, content: { text: "hello" } },
    context(),
  );

  assert.equal(result?.state, "published");
  assert.ok(calls.some((call) => call.includes("threads_publish")));
});

it("creates a Threads image container from an explicit public URL", async () => {
  const calls: string[] = [];

  const adapter = threads({
    auth: { userId: "u1", accessToken: "token" },
    fetch: async (input, init) => {
      calls.push(String(input));

      if (init?.method === "GET")
        return new Response(JSON.stringify({ id: "container", status: "FINISHED" }), {
          status: 200,
        });

      return new Response(JSON.stringify({ id: calls.length === 1 ? "container" : "published" }), {
        status: 200,
      });
    },
  });

  const account = connectedAccountRef({ backend: "default", platform: "threads", accountId: "u1" });

  const result = await adapter.posts?.publishTarget(
    {
      targetIndex: 0,
      targetKey: "threads-image",
      account,
      content: {
        media: [
          { kind: "image", source: { kind: "https-url", url: "https://cdn.example/image.jpg" } },
        ],
      },
    },
    context(),
  );

  assert.equal(result?.state, "published");
  assert.ok(calls.some((call) => call.includes("image_url=https%3A%2F%2Fcdn.example%2Fimage.jpg")));
});

it("maps Threads ERROR and EXPIRED containers to terminal failures", async () => {
  for (const status of ["ERROR", "EXPIRED"] as const) {
    const adapter = threads({
      auth: { userId: "u1", accessToken: "token" },
      fetch: async (_input, init) =>
        init?.method === "GET"
          ? new Response(JSON.stringify({ id: "container", status }), { status: 200 })
          : new Response(JSON.stringify({ id: "unexpected" }), { status: 200 }),
    });

    const account = connectedAccountRef({
      backend: "default",
      platform: "threads",
      accountId: "u1",
    });

    const pending = await adapter.posts?.publishTarget(
      { targetIndex: 0, targetKey: "threads", account, content: { text: "hello" } },
      context(),
    );

    const result = await adapter.native?.resumePublication(
      account,
      pending?.delivery?.deliveryId ?? "",
      context(),
    );

    assert.equal(result?.state, "failed");
  }
});

it("binds custom backend workflow handles and transport context", async () => {
  const calls: Array<{ url: string; method: string }> = [];

  const adapter = threads({
    backend: "managed-a",
    auth: { userId: "u1", accessToken: "token" },
    fetch: async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });

      return init?.method === "GET"
        ? new Response(JSON.stringify({ status: "FINISHED" }), { status: 200 })
        : new Response(JSON.stringify({ id: calls.length === 1 ? "container" : "native" }), {
            status: 200,
          });
    },
  });

  const account = connectedAccountRef({
    backend: "managed-a",
    platform: "threads",
    accountId: "u1",
  });

  const pending = await adapter.posts?.publishTarget(
    { targetIndex: 0, targetKey: "threads", account, content: { text: "hello" } },
    { ...context("managed-a") },
  );

  assert.equal(pending?.delivery?.backend, "managed-a");

  const result = await adapter.native?.resumePublication(
    account,
    pending?.delivery?.deliveryId ?? "",
    context("managed-a"),
  );

  assert.equal(result?.state, "published");
  assert.ok(calls.some((call) => call.method === "POST" && call.url.includes("threads_publish")));
});
