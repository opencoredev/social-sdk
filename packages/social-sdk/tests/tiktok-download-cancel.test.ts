import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { tiktok } from "../src/platforms/tiktok.js";

const account = connectedAccountRef({
  backend: "default",
  platform: "tiktok",
  accountId: "review-creator",
});

it("TikTok cancels a stalled portability JSON error body when the operation is aborted", async () => {
  const cancellation = new AbortController();

  let markStarted = () => {};

  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  let source: ReadableStreamDefaultController<Uint8Array> | undefined;

  let sourceCancelled = false;

  const adapter = tiktok({
    auth: { accessToken: "review-fixture", openId: "review-creator" },
    verifiedMediaOrigins: [],
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
            controller.enqueue(new TextEncoder().encode('{"error":'));
          },
          pull() {
            markStarted();
          },
          cancel() {
            sourceCancelled = true;
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
  });

  assert.ok(adapter.native);

  const pending = adapter.native
    .downloadDataRequest({
      account,
      requestId: "123451234512345",
      context: {
        backendInstance: "default",
        correlationId: "review-cancel-error-body",
        retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
        signal: cancellation.signal,
      },
    })
    .then(
      () => "settled",
      () => "settled",
    );

  await started;
  cancellation.abort();

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      pending,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("still-pending-after-abort"), 200);
      }),
    ]);

    assert.equal(result, "settled");
    assert.equal(sourceCancelled, true);
  } finally {
    clearTimeout(timer);

    if (!sourceCancelled) source?.error(new Error("Fixture cleanup"));

    await pending;
  }
});
