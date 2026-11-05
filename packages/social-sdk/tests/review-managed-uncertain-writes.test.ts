import { it } from "node:test";
import assert from "node:assert/strict";
import { buffer } from "../src/cloud/buffer.js";
import { postfast } from "../src/cloud/postfast.js";
import { postForMe } from "../src/cloud/post-for-me.js";
import { zernioNative } from "../src/cloud/zernio-native.js";
import { connectedAccountRef } from "../src/index.js";
import { SocialError } from "../src/core/errors.js";
import type { AdapterOperationContext, JsonValue } from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "review-managed-uncertain-writes",
  retryBudget: { maxAttempts: 3, maxElapsedMs: 30_000 },
};

/** A dispatched write whose response cannot confirm it must be reconciled, never retried. */
const uncertain = (error: SocialError) => {
  assert.ok(error instanceof SocialError);
  assert.equal(error.code, "ambiguous_outcome");
  assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });

  return true;
};

/** A fetch that answers every request with `body` and counts the calls. */
function answering(body: JsonValue, status = 200) {
  const calls: { readonly method: string; readonly path: string }[] = [];

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname });

    return Response.json(body, { status });
  };

  return { calls, fetch };
}

const malformed: readonly JsonValue[] = [null, [], "deleted", 1];

it("Zernio deleteProfile keeps a malformed success response uncertain without replaying", async () => {
  for (const body of [...malformed, {}, { message: 1 }]) {
    const { calls, fetch } = answering(body);
    const native = zernioNative({ apiKey: "fixture-key", fetch });

    await assert.rejects(native.deleteProfile({ profileId: "profile1" }, context), uncertain);
    assert.deepEqual(calls, [{ method: "DELETE", path: "/api/v1/profiles/profile1" }]);
  }

  const { fetch } = answering({ message: "Profile deleted successfully" });

  assert.equal(
    await zernioNative({ apiKey: "fixture-key", fetch }).deleteProfile(
      { profileId: "profile1" },
      context,
    ),
    undefined,
  );
});

it("Post for Me deleteAccount keeps a malformed success response uncertain without replaying", async () => {
  const account = connectedAccountRef({
    backend: "default",
    platform: "instagram",
    accountId: "spc_account1",
  });

  for (const body of [...malformed, {}, { success: "true" }]) {
    const { calls, fetch } = answering(body);
    const adapter = postForMe({ apiKey: "fixture-key", fetch });

    await assert.rejects(adapter.native.deleteAccount({ account }, context), uncertain);
    assert.deepEqual(calls, [{ method: "DELETE", path: "/v1/social-accounts/spc_account1" }]);
  }

  const { fetch } = answering({ success: true });

  assert.equal(
    await postForMe({ apiKey: "fixture-key", fetch }).native.deleteAccount({ account }, context),
    undefined,
  );
});

it("Buffer createIdea keeps a malformed IdeaResponse uncertain and still reports stated errors", async () => {
  for (const createIdea of [
    null,
    [],
    "idea",
    { idea: {} },
    { idea: { id: 7 } },
    { idea: null },
    { message: "Text is too long" },
  ]) {
    const { calls, fetch } = answering({ data: { createIdea } });
    const adapter = buffer({ apiKey: "fixture-key", organizationId: "org_example", fetch });

    await assert.rejects(adapter.native.createIdea({ text: "An idea" }, context), uncertain);
    assert.equal(calls.length, 1);
  }

  const created = answering({ data: { createIdea: { idea: { id: "idea_1" } } } });

  assert.deepEqual(
    await buffer({
      apiKey: "fixture-key",
      organizationId: "org_example",
      fetch: created.fetch,
    }).native.createIdea({ text: "An idea" }, context),
    { id: "idea_1" },
  );

  // A stated error carries the `__typename` the selection asks for; an unrecognized type stays
  // a definite rejection, while a bare message without one is unconfirmed.
  const refused = answering({
    data: { createIdea: { __typename: "ValidationError", message: "Text is too long" } },
  });

  await assert.rejects(
    buffer({
      apiKey: "fixture-key",
      organizationId: "org_example",
      fetch: refused.fetch,
    }).native.createIdea({ text: "An idea" }, context),
    (error: SocialError) => {
      assert.ok(error instanceof SocialError);
      assert.equal(error.code, "invalid_input");
      // Buffer's prose can echo post content, so the SDK never copies it into errors.
      assert.equal(error.message, "Buffer rejected the request.");

      return true;
    },
  );
});

it("PostFast replies require the created OUTBOUND item instead of resolving an empty success", async () => {
  const unconfirmedReplies: readonly JsonValue[] = [
    ...malformed,
    {},
    { direction: "OUTBOUND", deliveryStatus: "SENT" },
    { id: "", direction: "OUTBOUND" },
    { id: "i2", direction: "INBOUND" },
    { id: "i2", deliveryStatus: "SENT" },
    { id: "i2", direction: "OUTBOUND", deliveryStatus: "DONE" },
  ];

  for (const body of unconfirmedReplies) {
    const reply = answering(body, 201);
    const replying = postfast({ apiKey: "fixture-key", fetch: reply.fetch });

    await assert.rejects(
      replying.native.replyToInboxItem({ itemId: "item1", text: "A reply" }, context),
      uncertain,
    );
    assert.deepEqual(reply.calls, [{ method: "POST", path: "/social-inbox/items/item1/reply" }]);

    const dm = answering(body, 201);
    const messaging = postfast({ apiKey: "fixture-key", fetch: dm.fetch });

    await assert.rejects(
      messaging.native.privateReply({ itemId: "item1", text: "A DM" }, context),
      uncertain,
    );
    assert.deepEqual(dm.calls, [
      { method: "POST", path: "/social-inbox/items/item1/private-reply" },
    ]);
  }

  // A reply still being delivered stays pending; it is not reported as sent.
  const pending = answering(
    {
      id: "i2",
      conversationId: "c1",
      kind: "COMMENT",
      direction: "OUTBOUND",
      externalItemId: null,
      state: "VISIBLE",
      deliveryStatus: "PENDING",
      authoredByUserId: null,
      platformCreatedAt: "2026-11-05T10:00:00.000Z",
      createdAt: "2026-11-05T10:00:00.000Z",
    },
    201,
  );

  assert.deepEqual(
    await postfast({ apiKey: "fixture-key", fetch: pending.fetch }).native.replyToInboxItem(
      { itemId: "item1", text: "A reply" },
      context,
    ),
    {
      id: "i2",
      conversationId: "c1",
      direction: "OUTBOUND",
      externalItemId: null,
      state: "VISIBLE",
      deliveryStatus: "PENDING",
      platformCreatedAt: "2026-11-05T10:00:00.000Z",
    },
  );
});

it("PostFast moderateInboxItem keeps a non-object success response uncertain without replaying", async () => {
  for (const body of [...malformed, {}, { id: "item1", state: "VISIBLE" }]) {
    const { calls, fetch } = answering(body, 201);
    const adapter = postfast({ apiKey: "fixture-key", fetch });

    await assert.rejects(
      adapter.native.moderateInboxItem({ itemId: "item1", action: "hide" }, context),
      (error: SocialError) => uncertain(error) && error.operation === "comments.moderate",
    );
    assert.deepEqual(calls, [{ method: "POST", path: "/social-inbox/items/item1/state" }]);
  }
});
