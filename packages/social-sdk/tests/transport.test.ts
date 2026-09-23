import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHttp, HttpError, retryDelay } from "../src/transport/http.js";

/* oxlint-disable anti-slop/require-readable-spacing -- assertions keep their options adjacent. */

describe("HTTP transport", () => {
  it("rejects oversized responses without waiting for an uncooperative cancellation hook", async () => {
    for (const declaredLength of [false, true]) {
      let cancelled = false;

      const http = createHttp({
        maxResponseBytes: 1,
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(2));
              },
              cancel() {
                cancelled = true;

                return new Promise(() => {});
              },
            }),
            { headers: declaredLength ? { "content-length": "2" } : {} },
          ),
      });

      await assert.rejects(
        http({ url: new URL("https://api.example.test/posts"), method: "POST" }),
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
        (error: unknown) => error instanceof HttpError && error.kind === "invalid-response",
      );
      assert.equal(cancelled, true);
    }
  });

  it("preserves unquoted large social IDs while leaving strings and safe numbers intact", async () => {
    const http = createHttp({
      fetch: async () =>
        new Response(
          '{"id":6844785523593134080,"negative":-9007199254740992,"count":5,"decimal":1.25,"text":"id 6844785523593134080 \\\"quoted\\\""}',
        ),
    });

    assert.deepEqual(await http({ url: new URL("https://api.example.test/posts") }), {
      id: "6844785523593134080",
      negative: "-9007199254740992",
      count: 5,
      decimal: 1.25,
      text: 'id 6844785523593134080 "quoted"',
    });
  });

  it("reads selected creation headers from empty responses without returning secret headers", async () => {
    const http = createHttp({
      fetch: async () =>
        new Response("", {
          status: 201,
          headers: { "x-restli-id": "urn:li:share:123", "set-cookie": "private" },
        }),
    });

    assert.deepEqual(
      await http({
        url: new URL("https://api.example.test/posts"),
        method: "POST",
        responseHeaders: ["x-restli-id"],
      }),
      { body: null, headers: { "x-restli-id": "urn:li:share:123" } },
    );
  });
  it("does no I/O at construction and makes no mutation retries", async () => {
    let calls = 0;

    const http = createHttp({
      fetch: async () => {
        calls++;
        throw new Error("secret-token");
      },
    });

    assert.equal(calls, 0);
    await assert.rejects(
      http({ url: new URL("https://api.example.test/posts"), method: "POST" }),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.kind, "network");
        assert.equal(error.dispatched, true);
        assert.ok(!String(error).includes("secret-token"));

        return true;
      },
    );
    assert.equal(calls, 1);
    await assert.rejects(
      http({ url: new URL("https://api.example.test/posts"), method: "POST", maxAttempts: 2 }),
    );
    assert.equal(calls, 1);
  });

  it("respects read retry delays and total budget with an injected clock", async () => {
    let time = 0;
    let calls = 0;
    const delays: number[] = [];

    const http = createHttp({
      now: () => time,
      sleep: async (delay) => {
        delays.push(delay);
        time += delay;
      },
      fetch: async () =>
        ++calls === 1
          ? new Response(null, { status: 429, headers: { "Retry-After": "2" } })
          : Response.json({ ok: true }),
    });

    assert.deepEqual(
      await http({ url: new URL("https://api.example.test/posts"), maxAttempts: 3 }),
      { ok: true },
    );
    assert.deepEqual(delays, [2000]);
    assert.equal(calls, 2);
    assert.equal(retryDelay("Thu, 01 Jan 1970 00:00:05 GMT", 1000), 4000);
    assert.equal(retryDelay("invalid", 0), undefined);
  });

  it("does not replay permission failures and strips response secrets", async () => {
    let calls = 0;

    const http = createHttp({
      fetch: async () => {
        calls++;

        return new Response("secret-body", { status: 403 });
      },
    });

    await assert.rejects(
      http({ url: new URL("https://api.example.test/posts?token=secret"), maxAttempts: 5 }),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 403);
        assert.ok(!JSON.stringify(error).includes("secret"));

        return true;
      },
    );
    assert.equal(calls, 1);
  });

  it("caps read retry delays by the operation's elapsed budget", async () => {
    let calls = 0;

    const http = createHttp({
      fetch: async () => {
        calls++;

        return new Response(null, { status: 429, headers: { "Retry-After": "2" } });
      },
    });

    await assert.rejects(
      http({ url: new URL("https://api.example.test/posts"), maxAttempts: 5, timeoutMs: 1000 }),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
      (error: unknown) =>
        error instanceof HttpError &&
        error.kind === "http" &&
        error.status === 429 &&
        error.retryAfterMs === 2000,
    );
    assert.equal(calls, 1);
  });

  it("uses x-rate-limit-reset when Retry-After is absent", async () => {
    let now = 1_000;
    const http = createHttp({
      now: () => now,
      sleep: async (delay) => {
        assert.equal(delay, 4_000);
        now += delay;
      },
      fetch: async () =>
        new Response(null, { status: 429, headers: { "x-rate-limit-reset": "5" } }),
    });

    // oxlint-disable-next-line anti-slop/require-readable-spacing -- assertion options stay adjacent to the assertion.
    await assert.rejects(http({ url: new URL("https://api.example.test/posts"), maxAttempts: 2 }), {
      kind: "http",
      status: 429,
    });
  });

  it("rejects redirects and cannot forward authorization to media origins", async () => {
    let init: RequestInit | undefined;

    const http = createHttp({
      fetch: async (_url, options) => {
        init = options;

        return new Response(null, { status: 302 });
      },
    });

    await assert.rejects(
      http({
        url: new URL("https://api.example.test/posts"),
        headers: { Authorization: "Bearer private" },
      }),
    );
    assert.equal(init?.redirect, "error");
  });

  it("bounds JSON response bodies even without content-length", async () => {
    let cancelled = false;

    const http = createHttp({
      maxResponseBytes: 3,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("1234"));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });

    await assert.rejects(
      http({ url: new URL("https://api.example.test/posts") }),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
      (error: unknown) => error instanceof HttpError && error.kind === "invalid-response",
    );
    assert.equal(cancelled, true);
  });

  it("distinguishes cancellation before and after dispatch", async () => {
    const pre = new AbortController();
    pre.abort();

    const http = createHttp({
      fetch: async () => {
        throw new Error("must not run");
      },
    });

    await assert.rejects(
      http({ url: new URL("https://api.example.test/posts"), signal: pre.signal }),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
      (error: unknown) => error instanceof HttpError && !error.dispatched,
    );
    const post = new AbortController();

    const after = createHttp({
      fetch: async () => {
        post.abort();
        throw new Error("cancelled");
      },
    });

    await assert.rejects(
      after({
        url: new URL("https://api.example.test/posts"),
        method: "POST",
        signal: post.signal,
      }),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
      (error: unknown) =>
        error instanceof HttpError && error.dispatched && error.kind === "cancelled",
    );
  });

  it("diagnostic callbacks cannot replace an accepted result or block completion", async () => {
    const http = createHttp({
      fetch: async () => Response.json({ accepted: true }),
      onRequest: () => new Promise(() => {}),
    });

    assert.deepEqual(
      await http({ url: new URL("https://api.example.test/posts"), method: "POST" }),
      { accepted: true },
    );
  });
});

it("managed reads preserve provider missing, gone and permission categories", async () => {
  const { managedHttp } = await import("../src/cloud/common.js");

  for (const [status, code] of [
    [404, "not_found"],
    [410, "gone"],
    [403, "missing_permission"],
  ] as const) {
    const read = managedHttp("https://api.example.test", {
      apiKey: "fixture",
      fetch: async () => new Response(null, { status }),
    });

    await assert.rejects(
      read("/resource", {
        backendInstance: "test",
        correlationId: "test",
        retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
      }),
      { code, upstreamStatus: status },
    );
  }
});
