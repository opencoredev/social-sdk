import { strict as assert } from "node:assert";
import { it } from "node:test";
import { connectedAccountRef, SocialError, type AdapterOperationContext } from "../src/index.js";
import { facebook } from "../src/platforms/facebook.js";
import { instagram } from "../src/platforms/instagram.js";

function context(): AdapterOperationContext {
  return {
    backendInstance: "default",
    correlationId: "review-method-override",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 5_000 },
  };
}

// Meta's v27 launch notes explicitly retain ?method=delete for existing app use cases.
// https://developers.facebook.com/blog/post/2026/11/04/introducing-graph-api-v27-and-marketing-api-v27
for (const platform of ["facebook", "instagram"] satisfies readonly ("facebook" | "instagram")[]) {
  it(`${platform} raw GET method override cannot lose the uncertainty of a dispatched delete`, async () => {
    let deletes = 0;

    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));

      assert.equal(init?.method, "GET");
      assert.equal(url.searchParams.get("method"), "delete");
      deletes += 1;

      // The legacy Graph request completed its delete, then lost the HTTP response.
      throw new TypeError("simulated connection loss after delete");
    };

    const native =
      platform === "facebook"
        ? facebook({ auth: { pageId: "page-1", accessToken: "fixture-only" }, fetch }).native
        : instagram({
            auth: { accountId: "ig-1", accessToken: "fixture-only", flavor: "facebook-login" },
            fetch,
          }).native;

    assert.ok(native);

    const account = connectedAccountRef({
      backend: "default",
      platform,
      accountId: platform === "facebook" ? "page-1" : "ig-1",
    });

    try {
      await native.request(
        { account, method: "GET", path: "/1234567890", query: { method: "delete" } },
        context(),
      );
      assert.fail("Expected rejection or an uncertain write outcome");
    } catch (error) {
      assert.ok(error instanceof SocialError);

      if (deletes === 0) {
        assert.equal(error.code, "invalid_input");

        return;
      }

      assert.equal(error.code, "ambiguous_outcome");
      assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });
    }
  });
}
