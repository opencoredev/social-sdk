import { test } from "node:test";
import assert from "node:assert/strict";
import { backendQuickstarts } from "./backend-quickstarts.js";

test("backend quickstarts construct all three clients without environment secrets or network probes", () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("unexpected network");
  };

  try {
    const clients = backendQuickstarts({
      bluesky: { service: "https://bsky.example", did: "did:plc:fixture", accessJwt: "fixture" },
      zernioApiKey: "fixture",
      postForMeApiKey: "fixture",
    });

    assert.deepEqual(Object.keys(clients), ["directBluesky", "managedZernio", "managedPostForMe"]);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
