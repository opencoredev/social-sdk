import { it } from "node:test";
import assert from "node:assert/strict";
import { createHttp, HttpError, readBytes } from "../src/transport/http.js";

/** A body that sends one chunk and then stalls; its cancel never settles. */
function stalledBody(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
    },
    cancel() {
      onCancel();

      return new Promise<void>(() => undefined);
    },
  });
}

it("readBytes rejects with the abort reason when aborted mid-read and cancels the body", async () => {
  let cancelled = 0;
  const response = new Response(stalledBody(() => cancelled++));
  const controller = new AbortController();
  const reason = new Error("caller aborted");
  const read = readBytes(response, 1024, controller.signal);

  setTimeout(() => controller.abort(reason), 5);

  await assert.rejects(read, (error) => error === reason);
  assert.equal(cancelled, 1);
});

it("readBytes keeps the abort reason when the runtime throws from releaseLock", async () => {
  // Runtimes built before the 2022 Streams change throw a TypeError from releaseLock while a
  // read is pending. That TypeError must not replace the abort reason.
  const response = new Response(stalledBody(() => undefined));
  const body = response.body;

  assert.ok(body);
  const getReader = body.getReader.bind(body);

  Object.defineProperty(body, "getReader", {
    value: () => {
      const reader = getReader();

      Object.defineProperty(reader, "releaseLock", {
        value: () => {
          throw new TypeError("Cannot release a reader with outstanding read requests");
        },
      });

      return reader;
    },
  });

  const controller = new AbortController();
  const reason = new Error("caller aborted");
  const read = readBytes(response, 1024, controller.signal);

  setTimeout(() => controller.abort(reason), 5);

  await assert.rejects(read, (error) => error === reason);
});

it("an aborted body read surfaces as a cancelled HttpError, not a TypeError", async () => {
  const controller = new AbortController();

  const http = createHttp({
    fetch: async () =>
      new Response(
        stalledBody(() => undefined),
        { status: 200 },
      ),
  });

  const request = http({ url: new URL("https://api.example/feed"), signal: controller.signal });

  setTimeout(() => controller.abort(new Error("caller aborted")), 5);

  await assert.rejects(
    request,
    (error) => error instanceof HttpError && error.kind === "cancelled" && error.dispatched,
  );
});
