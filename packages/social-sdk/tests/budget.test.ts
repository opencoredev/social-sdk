import { test } from "node:test";
import assert from "node:assert/strict";
import { remainingBudget } from "../src/transport/budget.js";
import { threads } from "../src/platforms/threads.js";
import { createSocial } from "../src/index.js";

test("sequential requests consume one context budget while new contexts get their own budget", () => {
  const context = {
    backendInstance: "b",
    correlationId: "c",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 100 },
  };

  assert.equal(remainingBudget(context, 1000), 100);
  assert.equal(remainingBudget(context, 1040), 60);
  assert.throws(() => remainingBudget(context, 1100), { code: "timeout" });
  assert.equal(remainingBudget({ ...context }, 1100), 100);
});

test("Threads account reads preserve caller deadline even when fetch ignores abort", async () => {
  let calls = 0;

  const social = createSocial({
    backend: threads({
      auth: { accessToken: "fixture", userId: "a" },
      fetch: async () => {
        calls++;

        return new Promise<Response>(() => {});
      },
    }),
  });

  const start = performance.now();
  await assert.rejects(social.accounts.list({ retryBudget: { maxAttempts: 1, maxElapsedMs: 10 } }));
  assert.ok(performance.now() - start < 1000);
  assert.equal(calls, 1);
});

test("HTTP body and backoff deadlines do not depend on cooperative implementations", async () => {
  const { createHttp } = await import("../src/transport/http.js");
  const url = new URL("https://api.example.test/resource");

  const stream = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
    cancel: () => new Promise<void>(() => {}),
  });

  const read = createHttp({ timeoutMs: 10, fetch: async () => new Response(stream) });
  await assert.rejects(read({ url }), { kind: "timeout" });
  let calls = 0;

  const retry = createHttp({
    timeoutMs: 10,
    fetch: async () => {
      calls++;

      return new Response(null, { status: 429, headers: { "retry-after": "0" } });
    },
    sleep: async () => new Promise<void>(() => {}),
  });

  await assert.rejects(retry({ url, maxAttempts: 2 }), { kind: "timeout" });
  assert.equal(calls, 1);
});

test("managed uploads time out uncooperative fetch without reopening source", async () => {
  const { upload } = await import("../src/transport/upload.js");
  let opens = 0;
  await assert.rejects(
    upload({
      url: "https://storage.example.test/u",
      allowHost: () => true,
      maxBytes: 10,
      timeoutMs: 10,
      source: {
        mimeType: "video/mp4",
        size: 1,
        open: () => {
          opens++;

          return new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              controller.close();
            },
          });
        },
      },
      fetch: async () => new Promise<Response>(() => {}),
    }),
    { kind: "timeout" },
  );
  assert.equal(opens, 1);
});
