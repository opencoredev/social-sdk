import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  SocialError,
  connectedAccountRef,
  type JsonValue,
  type RetryDisposition,
} from "../src/index.js";

function parseJson(json: string): JsonValue {
  return JSON.parse(json);
}

function roundTrip(error: SocialError): SocialError {
  return SocialError.fromJSON(parseJson(JSON.stringify(error)));
}

describe("SocialError.fromJSON", () => {
  test("restores every serialized field", () => {
    const original = new SocialError({
      code: "rate_limited",
      operation: "posts.publish",
      message: "Slow down",
      backend: "default",
      account: connectedAccountRef({ backend: "default", platform: "x", accountId: "42" }),
      issues: [
        { code: "text_too_long", message: "Too long", path: "content.text", severity: "error" },
        { code: "alt_missing", message: "No alt text", targetIndex: 1, severity: "warning" },
      ],
      correlationId: "req-1",
      upstreamStatus: 429,
      upstreamCode: "88",
      retryDisposition: { kind: "after-delay", delayMs: 15_000 },
      details: { limit: 300, window: "15m" },
      cause: new Error("dropped by toJSON"),
    });

    const restored = roundTrip(original);

    assert.ok(restored instanceof SocialError);
    assert.equal(restored.name, "SocialError");
    assert.deepEqual(restored.toJSON(), original.toJSON());
    assert.equal(restored.cause, undefined);
  });

  test("keeps absent optional fields absent", () => {
    const restored = roundTrip(
      new SocialError({ code: "not_found", operation: "posts.get", message: "Missing" }),
    );

    assert.deepEqual(restored.toJSON(), {
      name: "SocialError",
      code: "not_found",
      operation: "posts.get",
      message: "Missing",
      retryDisposition: { kind: "never" },
    });
  });

  test("round-trips every retry disposition", () => {
    const dispositions: readonly RetryDisposition[] = [
      { kind: "never" },
      { kind: "after-delay", delayMs: 0 },
      { kind: "after-reconnect" },
      { kind: "reconcile-first" },
    ];

    for (const retryDisposition of dispositions) {
      const restored = roundTrip(
        new SocialError({ code: "timeout", operation: "op", message: "m", retryDisposition }),
      );

      assert.deepEqual(restored.retryDisposition, retryDisposition);
    }
  });

  test("rejects values that are not a serialized SocialError", () => {
    const valid = {
      name: "SocialError",
      code: "gone",
      operation: "op",
      message: "m",
      retryDisposition: { kind: "never" },
    };

    const invalid: readonly JsonValue[] = [
      null,
      "SocialError",
      [],
      { ...valid, name: "Error" },
      { ...valid, code: "not_a_code" },
      { ...valid, operation: 1 },
      { name: "SocialError", code: "gone", operation: "op", retryDisposition: { kind: "never" } },
      { name: "SocialError", code: "gone", operation: "op", message: "m" },
      { ...valid, retryDisposition: { kind: "after-delay" } },
      { ...valid, retryDisposition: { kind: "after-delay", delayMs: -1 } },
      { ...valid, retryDisposition: { kind: "sometimes" } },
      { ...valid, backend: 7 },
      {
        ...valid,
        account: {
          kind: "connected-account",
          version: 2,
          backend: "b",
          platform: "x",
          accountId: "1",
        },
      },
      { ...valid, issues: [{ code: "c", message: "m", severity: "fatal" }] },
      { ...valid, issues: {} },
      { ...valid, upstreamStatus: "429" },
      { ...valid, details: [] },
    ];

    assert.ok(SocialError.fromJSON(valid) instanceof SocialError);

    for (const value of invalid)
      assert.throws(() => SocialError.fromJSON(value), {
        name: "SocialError",
        code: "invalid_input",
        operation: "SocialError.fromJSON",
      });
  });
});
