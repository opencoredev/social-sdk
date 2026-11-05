import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SocialError } from "../src/core/errors.js";
import type {
  AdapterOperationContext,
  BackendPostRef,
  ConnectedAccountRef,
  JsonValue,
  ScheduledJobRef,
} from "../src/core/types.js";
import { managedHttp } from "../src/cloud/common.js";
import { managedLifecycle } from "../src/cloud/lifecycle.js";
import { postForMeOutcome, zernioOutcome } from "../src/cloud/outcomes.js";
import { revokeTikTokOAuthToken } from "../src/server/oauth.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
};

const record: BackendPostRef = {
  kind: "backend-post",
  version: 1,
  backend: "default",
  platform: "threads",
  accountId: "account",
  recordId: "record",
};

const job: ScheduledJobRef = {
  kind: "scheduled-job",
  version: 1,
  backend: "default",
  platform: "threads",
  accountId: "account",
  jobId: "record",
};

const reply = (body: JsonValue, status = 200) => Response.json(body, { status });

/**
 * The shared lifecycle with the bare managed client, as any caller that does not wrap it gets:
 * reads answer with `read`, writes with `write`.
 */
function lifecycle(read: JsonValue, write: () => Response) {
  const methods: string[] = [];

  const request = managedHttp("https://api.postforme.dev", {
    apiKey: "fixture",
    fetch: async (_url, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);

      return method === "GET" ? reply(read) : write();
    },
  });

  return {
    methods,
    posts: managedLifecycle("post-for-me", request, () => "2026-01-01T00:00:00.000Z"),
  };
}

const draft = {
  id: "record",
  status: "draft",
  social_accounts: [{ id: "account", platform: "threads" }],
};

const scheduled = {
  id: "record",
  status: "scheduled",
  scheduled_at: "2027-01-01T00:00:00Z",
  caption: "caption",
  social_accounts: [{ id: "account", platform: "threads" }],
};

const isUncertain = (error: Error) =>
  error instanceof SocialError &&
  error.code === "ambiguous_outcome" &&
  error.retryDisposition?.kind === "reconcile-first";

const isDefinite = (code: string) => (error: Error) =>
  error instanceof SocialError && error.code === code;

describe("shared lifecycle write answers", () => {
  for (const [name, body] of [
    ["null", null],
    ["an array", []],
    ["a missing success field", {}],
    ["a wrong-type success field", { success: "true" }],
  ] satisfies [string, JsonValue][])
    it(`a delete answered with ${name} is ambiguous, not a definite failure`, async () => {
      const { methods, posts } = lifecycle(draft, () => reply(body));

      await assert.rejects(posts.deleteBackendRecord(record, context), isUncertain);
      assert.deepEqual(methods, ["GET", "DELETE"]);
    });

  for (const [name, body] of [
    ["null", null],
    ["an array", [{ id: "record", status: "draft" }]],
    ["a wrong-type id", { id: 1, status: "draft" }],
    ["a missing status", { id: "record" }],
  ] satisfies [string, JsonValue][])
    it(`a cancel answered with ${name} is ambiguous, not a definite failure`, async () => {
      const { methods, posts } = lifecycle(scheduled, () => reply(body));

      await assert.rejects(posts.cancelScheduled(job, context), isUncertain);
      assert.deepEqual(methods, ["GET", "PUT"]);
    });

  it("an HTTP error status on the write stays a definite failure", async () => {
    const { posts } = lifecycle(draft, () => reply({ message: "nope" }, 404));

    await assert.rejects(posts.deleteBackendRecord(record, context), (error: Error) =>
      isDefinite("not_found")(error),
    );
  });

  it("a malformed read before dispatch stays definite and sends no write", async () => {
    const { methods, posts } = lifecycle(null, () => reply({ success: true }));

    await assert.rejects(
      posts.deleteBackendRecord(record, context),
      (error: Error) => !isUncertain(error),
    );
    assert.deepEqual(methods, ["GET"]);
  });

  it("the documented answers still confirm the writes", async () => {
    await lifecycle(draft, () => reply({ success: true })).posts.deleteBackendRecord(
      record,
      context,
    );
    assert.deepEqual(
      await lifecycle(scheduled, () =>
        reply({ id: "record", status: "draft" }),
      ).posts.cancelScheduled(job, context),
      { state: "cancelled", backendRecord: "retained" },
    );
  });
});

describe("managed outcomes keep provider strings out", () => {
  const account: ConnectedAccountRef = {
    kind: "connected-account",
    version: 1,
    backend: "managed",
    platform: "x",
    accountId: "account-a",
  };

  const outcomeContext = { account, targetIndex: 0, observedAt: "2026-11-05T00:00:00Z" };
  const prose = "Token sk-live-123 rejected for https://cdn.example.test/signed?sig=abc";

  it("a Zernio failure keeps only a documented error category and a status token", () => {
    const outcome = zernioOutcome(
      {
        post: {
          _id: "p1",
          platforms: [
            { platform: "twitter", accountId: "account-a", status: "failed", errorCategory: prose },
          ],
        },
      },
      outcomeContext,
    );

    assert.equal(outcome.state, "failed");
    assert.equal(outcome.state === "failed" ? outcome.code : undefined, "upstream_failure");
    assert.equal(JSON.stringify(outcome).includes("sk-live"), false);

    const odd = zernioOutcome(
      {
        post: {
          _id: "p1",
          platforms: [{ platform: "twitter", accountId: "account-a", status: prose }],
        },
      },
      outcomeContext,
    );

    assert.equal(odd.backendState, "unrecognized");
    assert.equal(JSON.stringify(odd).includes("sig=abc"), false);
  });

  it("a documented Zernio error category is kept", () => {
    const outcome = zernioOutcome(
      {
        post: {
          _id: "p1",
          platforms: [
            {
              platform: "twitter",
              accountId: "account-a",
              status: "failed",
              errorCategory: "auth_expired",
            },
          ],
        },
      },
      outcomeContext,
    );

    assert.equal(outcome.state === "failed" ? outcome.code : undefined, "auth_expired");
  });

  it("a published link must be an HTTPS URL without credentials", () => {
    const published = (url: string) => {
      const outcome = zernioOutcome(
        {
          post: {
            _id: "p1",
            platforms: [
              {
                platform: "twitter",
                accountId: "account-a",
                status: "published",
                platformPostId: "123",
                platformPostUrl: url,
              },
            ],
          },
        },
        outcomeContext,
      );

      return outcome.state === "published" ? outcome.url : "not published";
    };

    assert.equal(published("https://x.com/a/status/123"), "https://x.com/a/status/123");
    assert.equal(published("https://user:pass@x.com/a"), undefined);
    assert.equal(published("javascript:alert(1)"), undefined);
    assert.equal(published(prose), undefined);
  });

  it("a Post for Me parent status that is not a token is unrecognized", () => {
    const outcome = postForMeOutcome(
      { id: "p1", status: prose, social_accounts: ["account-a"] },
      undefined,
      outcomeContext,
    );

    assert.equal(outcome.backendState, "unrecognized");
    assert.equal(JSON.stringify(outcome).includes("sk-live"), false);
  });
});

describe("TikTok token revocation answers", () => {
  const revoke = (answer: () => Response) =>
    revokeTikTokOAuthToken(
      { clientId: "client", clientSecret: "secret", fetch: async () => answer() },
      { accessToken: "act.token" },
    );

  it("an empty body or {} is the documented success", async () => {
    assert.equal(await revoke(() => new Response(null, { status: 200 })), "revoked");
    assert.equal(await revoke(() => reply({})), "revoked");
  });

  for (const [name, body] of [
    ["an unrelated object", { data: { revoked: false } }],
    ["a v2 error envelope", { error: { code: "ok", message: "", log_id: "log" } }],
    ["an empty error", { error: "" }],
    ["an array", []],
    ["null", null],
  ] satisfies [string, JsonValue][])
    it(`${name} after dispatch is ambiguous`, async () => {
      await assert.rejects(
        revoke(() => reply(body)),
        isUncertain,
      );
    });

  it("a documented OAuth error body is a definite failure without provider prose", async () => {
    await assert.rejects(
      revoke(() =>
        reply({ error: "invalid_request", error_description: "secret detail", log_id: "log" }),
      ),
      (error: Error) =>
        error instanceof SocialError &&
        error.code === "upstream_failure" &&
        error.upstreamCode === "invalid_request" &&
        !JSON.stringify(error).includes("secret detail"),
    );
    await assert.rejects(
      revoke(() => reply({ error: "Not a code, see https://example.test/x" })),
      (error: Error) =>
        error instanceof SocialError &&
        error.code === "upstream_failure" &&
        error.upstreamCode === undefined,
    );
  });

  it("an HTTP error status stays definite", async () => {
    await assert.rejects(
      revoke(() => reply({ error: "invalid_client" }, 401)),
      isDefinite("reconnect_required"),
    );
  });
});
