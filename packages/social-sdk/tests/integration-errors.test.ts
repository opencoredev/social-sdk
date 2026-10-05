import { it } from "node:test";
import assert from "node:assert/strict";
import { createHttp, HttpError } from "../src/transport/http.js";
import { managedHttp } from "../src/cloud/common.js";
import { SocialError } from "../src/core/errors.js";

const context = {
  backendInstance: "company",
  correlationId: "integration",
  retryBudget: { maxAttempts: 3, maxElapsedMs: 1000 },
};

it("Zernio conflict recovery retains only an opaque ID and never replays the write", async () => {
  for (const id of ["post-123", undefined, "https://private.test/caption"]) {
    let calls = 0;

    const request = managedHttp("https://zernio.com/api", {
      apiKey: "test",
      fetch: async () => {
        calls++;

        return Response.json(
          { code: "idempotency_conflict", existingPostId: id, caption: "private caption" },
          { status: 409, headers: { "retry-after": "2" } },
        );
      },
    });

    await assert.rejects(
      request("/v1/posts", context, {}),
      (error: unknown): error is SocialError => {
        assert.ok(error instanceof SocialError);
        assert.equal(error.code, "idempotency_conflict");
        assert.deepEqual(
          error.retryDisposition,
          id === "post-123" ? { kind: "reconcile-first" } : { kind: "after-delay", delayMs: 2000 },
        );
        assert.deepEqual(error.details, id === "post-123" ? { existingPostId: id } : undefined);
        assert.ok(!JSON.stringify(error).includes("private"));

        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

it("Google quota and X usage caps are scoped; unknown permission errors keep their fallback", async () => {
  for (const scenario of [
    {
      origin: "https://www.googleapis.com",
      path: "/youtube/v3/channels",
      status: 403,
      body: { error: { errors: [{ reason: "quotaExceeded" }] } },
      code: "rate_limited",
    },
    {
      origin: "https://api.x.com",
      path: "/2/tweets",
      status: 429,
      body: { type: "https://api.twitter.com/2/problems/usage-capped", detail: "private" },
      code: "billing_required",
    },
    {
      origin: "https://api.x.com",
      path: "/2/tweets",
      status: 403,
      body: { detail: "This user is not allowed to post a video longer than 20 minutes." },
      code: "media_error",
    },
    {
      origin: "https://api.x.com",
      path: "/2/tweets",
      status: 403,
      body: { detail: "Forbidden" },
      code: "missing_permission",
    },
    {
      origin: "https://other.test",
      path: "/2/tweets",
      status: 403,
      body: { error: { errors: [{ reason: "quotaExceeded" }] } },
      code: "missing_permission",
    },
  ]) {
    let calls = 0;

    const request = managedHttp(scenario.origin, {
      apiKey: "test",
      fetch: async () => {
        calls++;

        return Response.json(scenario.body, { status: scenario.status });
      },
    });

    await assert.rejects(
      request(scenario.path, context),
      (error: unknown): error is SocialError => {
        assert.ok(error instanceof SocialError);
        assert.equal(error.code, scenario.code);
        assert.deepEqual(error.retryDisposition, { kind: "never" });
        assert.ok(!JSON.stringify(error).includes("private"));

        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

it("error decoders cannot replace HTTP status on malformed, oversized, or throwing input", async () => {
  for (const text of ["not JSON", JSON.stringify({ detail: "x".repeat(17 * 1024) }), "{}"]) {
    const http = createHttp({ fetch: async () => new Response(text, { status: 409 }) });
    await assert.rejects(
      http({
        url: new URL("https://api.example.test/posts"),
        method: "POST",
        decodeErrorBody: () => {
          throw new Error("private decoder failure");
        },
      }),
      (error: unknown): error is HttpError => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.kind, "http");
        assert.equal(error.status, 409);
        assert.equal(error.data, undefined);
        assert.ok(!String(error).includes("private"));

        return true;
      },
    );
  }
});

it("Zernio content-hash conflicts reconcile the nested ID without requiring a machine code", async () => {
  const request = managedHttp("https://zernio.com/api", {
    apiKey: "test",
    fetch: async () =>
      Response.json(
        { details: { existingPostId: "post-123", caption: "private" } },
        { status: 409 },
      ),
  });

  await assert.rejects(
    request("/v1/posts", context, {}),
    (error: unknown): error is SocialError => {
      assert.ok(error instanceof SocialError);
      assert.deepEqual(error.details, { existingPostId: "post-123" });
      assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });

      return true;
    },
  );
});

it("Zernio conflicts without an ID or delay require manual reconciliation without replay", async () => {
  let calls = 0;

  const request = managedHttp("https://zernio.com/api", {
    apiKey: "test",
    fetch: async () => {
      calls++;

      return Response.json({ code: "idempotency_conflict" }, { status: 409 });
    },
  });

  await assert.rejects(
    request("/v1/posts", context, {}),
    (error: unknown): error is SocialError => {
      assert.ok(error instanceof SocialError);
      assert.equal(error.code, "idempotency_conflict");
      assert.equal(error.details, undefined);
      assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });

      return true;
    },
  );
  assert.equal(calls, 1);
});
