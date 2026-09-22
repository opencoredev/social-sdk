import { test } from "node:test";
import assert from "node:assert/strict";
import { exampleBackendConfig } from "../src/config.js";

test("example defaults to a local mock and requires explicit real account membership", () => {
  assert.equal(exampleBackendConfig({}).backend?.id, "mock");
  assert.throws(() => exampleBackendConfig({ EXAMPLE_BACKEND: "zernio" }), /EXAMPLE_ACCOUNT_IDS/);
  assert.throws(
    () => exampleBackendConfig({ EXAMPLE_BACKEND: "post-for-me", EXAMPLE_ACCOUNT_IDS: "a" }),
    /POST_FOR_ME_API_KEY/,
  );

  const configured = exampleBackendConfig({
    EXAMPLE_BACKEND: "zernio",
    EXAMPLE_ACCOUNT_IDS: "a,b",
    ZERNIO_API_KEY: "fixture",
  });

  assert.equal(configured.backend?.id, "zernio");
  assert.equal(
    configured.membership?.({ principal: "local-demo-user", tenantId: "local-demo-tenant" }, "a"),
    true,
  );
  assert.equal(
    configured.membership?.({ principal: "local-demo-user", tenantId: "other" }, "a"),
    false,
  );
  assert.equal(
    configured.membership?.(
      { principal: "local-demo-user", tenantId: "local-demo-tenant" },
      "unknown",
    ),
    false,
  );
});
