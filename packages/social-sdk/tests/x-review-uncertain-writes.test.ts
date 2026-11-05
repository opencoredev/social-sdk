import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, type AdapterOperationContext } from "../src/index.js";
import { SocialError } from "../src/core/errors.js";
import type { JsonValue } from "../src/core/types.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "11" });

const context = (): AdapterOperationContext => ({
  backendInstance: "default",
  correlationId: "x-review-uncertain-writes",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
});

function native(fetch: typeof globalThis.fetch) {
  const adapter = x({ auth: { userId: "11", accessToken: "fixture" }, fetch });

  assert.ok(adapter.native);

  return adapter.native;
}

function answering(body: JsonValue) {
  let requests = 0;

  const api = native(async () => {
    requests++;

    return Response.json(body);
  });

  return { api, requests: () => requests };
}

const uncertain = (error: SocialError) => {
  assert.ok(error instanceof SocialError);
  assert.equal(error.code, "ambiguous_outcome");
  assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });

  return true;
};

// Enums from X OpenAPI 2.173 (https://api.x.com/2/openapi.json), read 2026-11-05.
it("DM event lookup sends only documented dm_event.fields and expands the sender", async () => {
  let sent: URL | undefined;

  const api = native(async (input) => {
    sent = new URL(String(input));

    return Response.json({ data: { id: "21" } });
  });

  await api.getDirectMessage({ account, eventId: "21", context: context() });

  const allowed = new Set([
    "attachments",
    "created_at",
    "dm_conversation_id",
    "entities",
    "event_type",
    "id",
    "text",
  ]);

  const fields = sent?.searchParams.get("dm_event.fields")?.split(",") ?? [];

  assert.ok(fields.length > 0);
  assert.deepEqual(
    fields.filter((field) => !allowed.has(field)),
    [],
  );
  assert.equal(sent?.searchParams.get("expansions"), "sender_id,attachments.media_keys");
});

it("List memberships sends only documented list.fields and expands the owner", async () => {
  let sent: URL | undefined;

  const api = native(async (input) => {
    sent = new URL(String(input));

    return Response.json({ data: [] });
  });

  await api.listMemberships({ account, context: context() });

  const allowed = new Set([
    "created_at",
    "description",
    "follower_count",
    "id",
    "member_count",
    "name",
    "private",
  ]);

  const fields = sent?.searchParams.get("list.fields")?.split(",") ?? [];

  assert.ok(fields.length > 0);
  assert.deepEqual(
    fields.filter((field) => !allowed.has(field)),
    [],
  );
  assert.equal(sent?.searchParams.get("expansions"), "owner_id");
});

for (const [label, body] of [
  ["null data", { data: null }],
  ["missing data", {}],
  ["array data", { data: [] }],
  ["primitive data", { data: "ENDED" }],
  ["a primitive body", 7],
] as const) {
  it(`endBroadcast keeps the outcome uncertain for ${label}`, async () => {
    const { api, requests } = answering(body);

    await assert.rejects(
      api.endBroadcast({ account, broadcastId: "1yNGaZbBzRjKj", context: context() }),
      uncertain,
    );
    assert.equal(requests(), 1);
  });

  it(`publishArticle keeps the outcome uncertain for ${label}`, async () => {
    const { api, requests } = answering(body);

    await assert.rejects(
      api.publishArticle({ account, articleId: "21", context: context() }),
      uncertain,
    );
    assert.equal(requests(), 1);
  });

  it(`createStreamSource keeps the outcome uncertain for ${label}`, async () => {
    const { api, requests } = answering(body);

    await assert.rejects(
      api.createStreamSource({ account, name: "Studio", region: "us-east-1", context: context() }),
      uncertain,
    );
    assert.equal(requests(), 1);
  });
}

for (const [label, data] of [
  ["empty data", {}],
  ["no stream key", { id: "1234567890123456789" }],
  ["no ID", { stream_key: "fixture" }],
  ["a numeric ID", { id: 7, stream_key: "fixture" }],
] as const) {
  it(`createStreamSource does not report success for ${label}`, async () => {
    const { api } = answering({ data });

    await assert.rejects(
      api.createStreamSource({ account, name: "Studio", region: "us-east-1", context: context() }),
      (error: SocialError) => {
        uncertain(error);
        assert.equal(JSON.stringify(error.toJSON()).includes("fixture"), false);

        return true;
      },
    );
  });
}

it("createStreamSource returns a source X confirmed", async () => {
  const { api } = answering({
    data: { id: "1234567890123456789", stream_key: "fixture", name: "Studio" },
  });

  assert.deepEqual(
    await api.createStreamSource({
      account,
      name: "Studio",
      region: "us-east-1",
      context: context(),
    }),
    { id: "1234567890123456789", stream_key: "fixture", name: "Studio" },
  );
});

for (const field of ["detail", "title"] as const) {
  it(`uploadChatMedia keeps the provider ${field} out of public errors`, async () => {
    let requests = 0;

    const api = native(async () => {
      requests++;

      return requests === 1
        ? Response.json({
            data: { session_id: "21", media_hash_key: "abc", conversation_id: "11-12" },
          })
        : Response.json({ errors: [{ [field]: "PRIVATE_CANARY" }] });
    });

    await assert.rejects(
      api.uploadChatMedia({
        account,
        conversationId: "11-12",
        media: new Blob(["encrypted fixture bytes"]),
        context: context(),
      }),
      (error: SocialError) => {
        assert.ok(error instanceof SocialError);
        assert.equal(error.code, "upstream_failure");
        assert.equal(JSON.stringify(error.toJSON()).includes("PRIVATE_CANARY"), false);
        assert.equal(error.message.includes("PRIVATE_CANARY"), false);
        assert.match(error.message, /segment 1 of 1/);

        return true;
      },
    );
    assert.equal(requests, 2);
  });
}
