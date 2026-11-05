import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  connectedAccountRef,
  SocialError,
  type AdapterOperationContext,
  type ConnectedAccountRef,
  type JsonValue,
  type RawProviderResponse,
} from "../src/index.js";
import { bluesky } from "../src/platforms/bluesky.js";
import { facebook } from "../src/platforms/facebook.js";
import { instagram } from "../src/platforms/instagram.js";
import { blueskyOAuthTransport } from "../src/server/bluesky-oauth.js";

// Offline regressions for the SOC-37 PR 8 review: Graph read-after-write uncertainty, the
// Bluesky raw transport deadline and the Bluesky OAuth nonce replay. No request leaves the process.

const context = (maxElapsedMs = 5_000): AdapterOperationContext => ({
  backendInstance: "default",
  correlationId: "review-raw-uncertain-writes",
  retryBudget: { maxAttempts: 1, maxElapsedMs },
});

const ref = (platform: ConnectedAccountRef["platform"], accountId: string) =>
  connectedAccountRef({ backend: "default", platform, accountId });

const json = (body: JsonValue, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
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

const graphError = (code: number) => ({
  error: { type: "OAuthException", code, message: "fixture" },
});

describe("Graph raw writes that read the object back", () => {
  const send = (
    platform: "facebook" | "instagram",
    response: () => Response,
    method: "GET" | "POST",
    query: Readonly<Record<string, string | readonly string[]>>,
  ) => {
    let calls = 0;

    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;

      return response();
    };

    const native =
      platform === "facebook"
        ? facebook({ auth: { pageId: "page-1", accessToken: "fixture-only" }, fetch }).native
        : instagram({ auth: { accountId: "ig-1", accessToken: "fixture-only" }, fetch }).native;

    assert.ok(native);
    const account = platform === "facebook" ? ref("facebook", "page-1") : ref("instagram", "ig-1");
    const path = platform === "facebook" ? "/page-1/feed" : "/ig-1/media";

    const work = native.request(
      method === "GET"
        ? { account, method, path, query }
        : { account, method, path, query, body: { kind: "urlencoded", value: { message: "x" } } },
      context(),
    );

    return { work, calls: () => calls };
  };

  for (const platform of ["facebook", "instagram"] satisfies readonly (
    | "facebook"
    | "instagram"
  )[]) {
    it(`${platform}: a failed read-back after a write stays ambiguous and is sent once`, async () => {
      // Graph documents that a failed read-after-write returns a standard error although the
      // write itself was applied: https://developers.facebook.com/docs/graph-api/overview
      const probe = send(platform, () => json(graphError(100), 400), "POST", {
        fields: "nonexistent_field",
      });

      const error = await rejection(probe.work);

      assert.equal(probe.calls(), 1);
      assert.equal(error.code, "ambiguous_outcome");
      assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });
      assert.equal(error.upstreamStatus, 400);
    });
  }

  it("an unreadable error body on a read-back write stays ambiguous", async () => {
    const probe = send("facebook", () => new Response("not json", { status: 400 }), "POST", {
      fields: "id",
    });

    assert.equal((await rejection(probe.work)).code, "ambiguous_outcome");
  });

  it("an expired token on a read-back write stays a definitive reconnect", async () => {
    const probe = send("facebook", () => json(graphError(190), 400), "POST", { fields: "id" });
    const error = await rejection(probe.work);

    assert.equal(error.code, "reconnect_required");
    assert.deepEqual(error.retryDisposition, { kind: "after-reconnect" });
  });

  it("authentication, permission and rate-limit rejections stay definitive", async () => {
    const cases = [
      [401, "reconnect_required"],
      [403, "missing_permission"],
      [429, "rate_limited"],
    ] as const;

    for (const [status, code] of cases) {
      const probe = send("facebook", () => json(graphError(10), status), "POST", { fields: "id" });

      assert.equal((await rejection(probe.work)).code, code);
    }
  });

  it("writes without fields and reads with fields keep the definitive mapping", async () => {
    const write = await rejection(
      send("facebook", () => json(graphError(100), 400), "POST", {}).work,
    );

    assert.equal(write.code, "upstream_failure");
    assert.deepEqual(write.retryDisposition, { kind: "never" });

    // An empty fields list sends no fields parameter, so nothing is read back.
    const emptyFields = await rejection(
      send("facebook", () => json(graphError(100), 400), "POST", { fields: [] }).work,
    );

    assert.equal(emptyFields.code, "upstream_failure");

    const read = await rejection(
      send("facebook", () => json(graphError(100), 400), "GET", { fields: "id" }).work,
    );

    assert.equal(read.code, "upstream_failure");
  });

  it("a successful read-back write returns the provider body", async () => {
    const response = await send("facebook", () => json({ id: "post-1" }), "POST", {
      fields: "id",
    }).work;

    assert.deepEqual(response.body, { id: "post-1" });
  });
});

describe("Bluesky raw requests honor the adapter's timeoutMs", () => {
  const did = "did:plc:abcdefghijklmnopqrstuvwx";

  const send = (method: "GET" | "POST") => {
    let signal: AbortSignal | undefined;

    const adapter = bluesky({
      auth: { service: "https://pds.test", did, accessJwt: "fixture-only" },
      timeoutMs: 5,
      fetch: async (_input, init) => {
        signal = init?.signal ?? undefined;
        await new Promise((resolve) => setTimeout(resolve, 60));

        return json({ ok: true });
      },
    });

    const account = ref("bluesky", did);
    assert.ok(adapter.native);

    const work = adapter.native.request(
      method === "GET"
        ? { account, method, path: "/xrpc/app.bsky.actor.getPreferences" }
        : {
            account,
            method,
            path: "/xrpc/app.bsky.actor.putPreferences",
            body: { kind: "json", value: { preferences: [] } },
          },
      context(1_000),
    );

    return { work, signal: () => signal };
  };

  it("a read times out at the configured deadline and cancels the fetch", async () => {
    const probe = send("GET");
    const error = await rejection(probe.work);

    assert.equal(error.code, "timeout");
    assert.equal(probe.signal()?.aborted, true);
  });

  it("a dispatched write that times out stays ambiguous", async () => {
    const probe = send("POST");
    const error = await rejection(probe.work);

    assert.equal(error.code, "ambiguous_outcome");
    assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });
    assert.equal(probe.signal()?.aborted, true);
  });
});

describe("Bluesky raw requests through the built-in OAuth transport", () => {
  it("the session, not the raw layer, replays one explicit DPoP nonce challenge", async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);

    const dpopKey = await crypto.subtle.exportKey("jwk", keys.privateKey);
    let calls = 0;

    const session = blueskyOAuthTransport(
      {
        version: 1,
        did: "did:plc:abcdefghijklmnopqrstuvwx",
        pdsUrl: "https://pds.test",
        issuer: "https://auth.test",
        clientId: "https://app.test/client-metadata.json",
        authMethod: "none",
        accessToken: "fixture-only",
        scopes: ["atproto"],
        dpopKey,
      },
      {
        assertEgressAllowed: () => undefined,
        fetch: async () => {
          calls += 1;

          return calls === 1
            ? json({ error: "use_dpop_nonce" }, 401, {
                "DPoP-Nonce": "nonce-1",
                "WWW-Authenticate": 'DPoP error="use_dpop_nonce"',
              })
            : json({ uri: "at://fixture" }, 200, { "DPoP-Nonce": "nonce-2" });
        },
      },
    );

    const adapter = bluesky({ auth: { service: "https://pds.test", did: session.did }, session });

    assert.ok(adapter.native);

    const response = await adapter.native.request(
      {
        account: ref("bluesky", session.did),
        method: "POST",
        path: "/xrpc/com.atproto.repo.createRecord",
        body: {
          kind: "json",
          value: {
            repo: session.did,
            collection: "app.bsky.feed.post",
            record: { text: "fixture" },
          },
        },
      },
      context(),
    );

    assert.equal(response.status, 200);
    // The nonce challenge was rejected before the write ran; the session replays it once.
    assert.equal(calls, 2);

    const declared = adapter.capabilities.capabilities.find(
      (entry) => entry.operation === "raw.request",
    );

    assert.match(declared?.notes ?? "", /OAuth session may still replay an explicit DPoP nonce/);
  });
});
