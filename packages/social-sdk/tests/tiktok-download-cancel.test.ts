import { inspect } from "node:util";
import { it } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { connectedAccountRef } from "../src/index.js";
import { tiktok } from "../src/platforms/tiktok.js";
import { SocialError } from "../src/core/errors.js";

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

const downloadContext = (signal: AbortSignal) => ({
  backendInstance: "default",
  correlationId: "review-download",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
  signal,
});

it("TikTok rejects a portability download promptly when an injected fetch ignores the abort", async () => {
  const cancellation = new AbortController();

  const adapter = tiktok({
    auth: { accessToken: "review-fixture", openId: "review-creator" },
    verifiedMediaOrigins: [],
    // Never settles and never reads the signal.
    fetch: () => new Promise<Response>(() => {}),
  });

  assert.ok(adapter.native);

  const pending = adapter.native.downloadDataRequest({
    account,
    requestId: "123451234512345",
    context: downloadContext(cancellation.signal),
  });

  setTimeout(() => cancellation.abort(), 10);

  await assert.rejects(
    pending,
    (error: Error) => error instanceof SocialError && error.code === "cancelled",
  );
  assert.equal(getEventListeners(cancellation.signal, "abort").length, 0);
});

it("TikTok detaches the abort listener once an archive stream ends or is cancelled", async () => {
  const signal = new AbortController().signal;

  const adapter = tiktok({
    auth: { accessToken: "review-fixture", openId: "review-creator" },
    verifiedMediaOrigins: [],
    fetch: async () =>
      new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        headers: { "content-type": "application/zip" },
      }),
  });

  const native = adapter.native;

  assert.ok(native);

  const download = () =>
    native.downloadDataRequest({
      account,
      requestId: "123451234512345",
      context: downloadContext(signal),
    });

  const consumed = await download();

  assert.deepEqual(
    new Uint8Array(await new Response(consumed).arrayBuffer()),
    new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
  );
  assert.equal(getEventListeners(signal, "abort").length, 0);

  const cancelled = await download();

  assert.equal(getEventListeners(signal, "abort").length, 1);
  await cancelled.cancel();
  assert.equal(getEventListeners(signal, "abort").length, 0);
});

it("TikTok errors an archive stream with cancelled when the operation aborts mid-read", async () => {
  const cancellation = new AbortController();

  let sourceCancelled = false;

  const adapter = tiktok({
    auth: { accessToken: "review-fixture", openId: "review-creator" },
    verifiedMediaOrigins: [],
    // The body never ends and ignores the request signal, like a stalled injected transport.
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            sourceCancelled = true;
          },
        }),
        { headers: { "content-type": "application/zip" } },
      ),
  });

  assert.ok(adapter.native);

  const stream = await adapter.native.downloadDataRequest({
    account,
    requestId: "123451234512345",
    context: downloadContext(cancellation.signal),
  });

  const reading = stream.getReader().read();

  cancellation.abort();

  await assert.rejects(
    reading,
    (error: Error) => error instanceof SocialError && error.code === "cancelled",
  );
  assert.equal(sourceCancelled, true);
  assert.equal(getEventListeners(cancellation.signal, "abort").length, 0);
});

it("TikTok cancels the body of a rate-limited portability download", async () => {
  let cancelled = false;

  const adapter = tiktok({
    auth: { accessToken: "review-fixture", openId: "review-creator" },
    verifiedMediaOrigins: [],
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":'));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
  });

  assert.ok(adapter.native);

  await assert.rejects(
    adapter.native.downloadDataRequest({
      account,
      requestId: "123451234512345",
      context: {
        backendInstance: "default",
        correlationId: "review-rate-limited-body",
        retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
      },
    }),
    (error: SocialError) => error.code === "rate_limited",
  );
  assert.equal(cancelled, true);
});

it("TikTok data download failures keep no transport error that could carry request details", async () => {
  const secret = "https://open.tiktokapis.com/v2/user/data/download/?token=fixture-private";

  const failing = tiktok({
    auth: { accessToken: "review-fixture", openId: "review-creator" },
    verifiedMediaOrigins: [],
    fetch: async () => {
      throw new TypeError(`connect failed for ${secret}`);
    },
  });

  assert.ok(failing.native);

  const context = {
    backendInstance: "default",
    correlationId: "privacy-download",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
  };

  await assert.rejects(
    failing.native.downloadDataRequest({ account, requestId: "123451234512345", context }),
    (error: SocialError) =>
      error instanceof SocialError &&
      error.cause === undefined &&
      !inspect(error, { depth: 5 }).includes("fixture-private"),
  );

  const streaming = tiktok({
    auth: { accessToken: "review-fixture", openId: "review-creator" },
    verifiedMediaOrigins: [],
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            throw new TypeError(`socket reset for ${secret}`);
          },
        }),
        { status: 200, headers: { "content-type": "application/zip" } },
      ),
  });

  assert.ok(streaming.native);

  const stream = await streaming.native.downloadDataRequest({
    account,
    requestId: "123451234512345",
    context,
  });

  await assert.rejects(
    new Response(stream).arrayBuffer(),
    (error: SocialError) =>
      error instanceof SocialError &&
      error.cause === undefined &&
      !inspect(error, { depth: 5 }).includes("fixture-private"),
  );
});
