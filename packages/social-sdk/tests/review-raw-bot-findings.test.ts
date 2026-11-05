import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  connectedAccountRef,
  SocialError,
  type AdapterOperationContext,
  type RawProviderResponse,
} from "../src/index.js";
import { postfast } from "../src/cloud/postfast.js";
import { zernioNative } from "../src/cloud/zernio-native.js";
import { x } from "../src/platforms/x.js";
import type { RequestEvent } from "../src/transport/http.js";

// Offline regressions for the automated review of SOC-39 raw requests (PR #139): the
// x-rate-limit-reset fallback, the managed onRequest hook and the status on a non-UTF-8 body.
// No request leaves the process.

const context = (): AdapterOperationContext => ({
  backendInstance: "default",
  correlationId: "review-raw-bot-findings",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 5_000 },
});

async function rejection(work: Promise<RawProviderResponse>): Promise<SocialError> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof SocialError);

    return error;
  }

  assert.fail("Expected the raw request to reject.");
}

describe("raw request rate limits", () => {
  it("keeps the x-rate-limit-reset wait when Retry-After is absent", async () => {
    const reset = Math.ceil(Date.now() / 1000) + 60;

    const fetch: typeof globalThis.fetch = async () =>
      new Response("{}", {
        status: 429,
        headers: { "content-type": "application/json", "x-rate-limit-reset": String(reset) },
      });

    const native = x({ auth: { userId: "x-user" }, appBearerToken: "fixture-only", fetch }).native;
    assert.ok(native);

    const error = await rejection(
      native.request(
        {
          account: connectedAccountRef({ backend: "default", platform: "x", accountId: "x-user" }),
          method: "GET",
          path: "/2/tweets/search/recent",
        },
        context(),
      ),
    );

    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryDisposition.kind, "after-delay");

    if (error.retryDisposition.kind === "after-delay") {
      assert.ok(error.retryDisposition.delayMs > 50_000);
      assert.ok(error.retryDisposition.delayMs <= 61_000);
    }
  });
});

describe("managed raw request diagnostics", () => {
  it("reports each dispatched raw attempt to onRequest", async () => {
    const events: RequestEvent[] = [];
    let clock = 1_000;

    const fetch: typeof globalThis.fetch = async () => {
      clock += 40;

      return new Response("{}", { status: 503 });
    };

    const error = await rejection(
      zernioNative({
        apiKey: "fixture-only",
        fetch,
        now: () => clock,
        onRequest: (event) => {
          events.push(event);
        },
      }).request({ method: "GET", path: "/v1/posts" }, context()),
    );

    assert.equal(error.code, "upstream_failure");
    assert.deepEqual(events, [{ method: "GET", attempt: 1, elapsedMs: 40, status: 503 }]);
  });

  it("omits the status when no response arrived and ignores a failing hook", async () => {
    const events: RequestEvent[] = [];

    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError("network down");
    };

    const error = await rejection(
      postfast({
        apiKey: "fixture-only",
        fetch,
        onRequest: (event) => {
          events.push(event);
          throw new Error("diagnostics failed");
        },
      }).native.request(
        { method: "POST", path: "/social-posts", body: { kind: "json", value: {} } },
        context(),
      ),
    );

    assert.equal(error.code, "ambiguous_outcome");
    assert.equal(error.retryDisposition.kind, "reconcile-first");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.method, "POST");
    assert.equal(events[0]?.status, undefined);
  });

  it("does not report a request cancelled before dispatch", async () => {
    const events: RequestEvent[] = [];
    const controller = new AbortController();
    controller.abort();

    const error = await rejection(
      zernioNative({
        apiKey: "fixture-only",
        fetch: async () => new Response("{}"),
        onRequest: (event) => {
          events.push(event);
        },
      }).request({ method: "GET", path: "/v1/posts" }, { ...context(), signal: controller.signal }),
    );

    assert.equal(error.code, "cancelled");
    assert.equal(events.length, 0);
  });
});

describe("raw response decoding", () => {
  it("keeps the upstream status on a write answered with a body that is not UTF-8", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(new Uint8Array([0xff, 0xfe, 0xfd]), {
        status: 201,
        headers: { "content-type": "application/json" },
      });

    const error = await rejection(
      zernioNative({ apiKey: "fixture-only", fetch }).request(
        { method: "POST", path: "/v1/posts", body: { kind: "json", value: { content: "hi" } } },
        context(),
      ),
    );

    assert.equal(error.code, "ambiguous_outcome");
    assert.equal(error.retryDisposition.kind, "reconcile-first");
    assert.equal(error.upstreamStatus, 201);
  });
});
