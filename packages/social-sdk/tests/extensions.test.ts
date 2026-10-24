import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as root from "../src/index.js";
import { SocialError, connectedAccountRef, createSocial, platformPostRef } from "../src/index.js";
import { inboxAggregation } from "../src/inbox.js";
import { localMediaStaging } from "../src/media-staging.js";
import { outcomeRecovery } from "../src/server/index.js";
import { MemoryIdempotencyStore, mockBackend } from "../src/testing/index.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "a" });

const request = {
  targets: [{ account }],
  content: { text: "hello" },
  idempotencyKey: "extensions-1",
};

function invalidConfig(pattern: RegExp) {
  return (error: unknown): error is SocialError =>
    error instanceof SocialError && error.code === "invalid_config" && pattern.test(error.message);
}

describe("opt-in client extensions", () => {
  test("reconcile, retryFailed, and inbox.list name the extension they need", async () => {
    const social = createSocial({
      backend: mockBackend(),
      idempotencyStore: new MemoryIdempotencyStore(),
    });

    await assert.rejects(social.posts.reconcile(request), invalidConfig(/outcomeRecovery\(\)/));
    await assert.rejects(social.posts.retryFailed(request), invalidConfig(/outcomeRecovery\(\)/));
    await assert.rejects(
      social.inbox.list({ accounts: [account] }),
      invalidConfig(/inboxAggregation\(\)/),
    );
  });

  test("installed extensions answer through the same client methods", async () => {
    const social = createSocial({
      backend: mockBackend(),
      idempotencyStore: new MemoryIdempotencyStore(),
      recovery: outcomeRecovery(),
      inbox: inboxAggregation(),
    });

    await social.posts.publish(request);

    const reconciled = await social.posts.reconcile(request);

    assert.equal(reconciled.status, "complete");
    assert.deepEqual(reconciled.unresolved, []);

    const inbox = await social.inbox.list({
      posts: [platformPostRef({ backend: "default", platform: "x", accountId: "a", postId: "p1" })],
    });

    assert.equal(inbox.sources.length, 1);
  });

  test("createSocial rejects a raw staging provider and non-extension values", () => {
    const provider = { stageMedia: async () => ({ url: "https://media.example.test/a.jpg" }) };

    assert.throws(
      // A JavaScript caller migrating from the provider-only option.
      () => createSocial({ backend: mockBackend(), mediaStaging: JSON.parse("{}") }),
      invalidConfig(/localMediaStaging\(provider\)/),
    );
    assert.throws(
      () => createSocial({ backend: mockBackend(), recovery: JSON.parse("{}") }),
      invalidConfig(/outcomeRecovery\(\)/),
    );
    assert.throws(
      () => createSocial({ backend: mockBackend(), inbox: JSON.parse("{}") }),
      invalidConfig(/inboxAggregation\(\)/),
    );
    assert.throws(
      () => localMediaStaging({ ...provider, origin: "https://media.example.test/path" }),
      invalidConfig(/origin/),
    );
    assert.equal(localMediaStaging(provider).origin, "https://staging.social-sdk.invalid");
  });

  test("the root entry point ships none of the extensions", () => {
    for (const name of ["outcomeRecovery", "inboxAggregation", "localMediaStaging"])
      assert.equal(name in root, false);
  });
});
