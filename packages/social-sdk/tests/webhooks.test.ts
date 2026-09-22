import { it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  acceptWebhook,
  decodeWebhook,
  verifyPostForMeWebhook,
  verifyZernioWebhook,
  type EventInbox,
} from "../src/server/webhooks.js";

const secret = "test-endpoint-secret";

const raw = new TextEncoder().encode(
  JSON.stringify({
    id: "event-1",
    event: "post.platform.published",
    timestamp: "2026-09-19T00:00:00Z",
    accountId: "account-1",
    access_token: "private-token",
  }),
);

const signature = createHmac("sha256", secret).update(raw).digest("hex");

it("verifies Zernio raw bytes and rejects altered, malformed, absent, or wrong signatures", async () => {
  const headers = new Headers({ "X-Zernio-Signature": signature });
  assert.equal((await verifyZernioWebhook({ secret, headers, body: raw })).bodyAuthenticated, true);

  for (const bad of ["", "0", "zz".repeat(32), signature.toUpperCase(), "0".repeat(64)]) {
    await assert.rejects(
      verifyZernioWebhook({
        secret,
        headers: new Headers({ "X-Zernio-Signature": bad }),
        body: raw,
      }),
    );
  }

  await assert.rejects(
    verifyZernioWebhook({
      secret,
      headers,
      body: new TextEncoder().encode(new TextDecoder().decode(raw) + " "),
    }),
  );
  await assert.rejects(verifyZernioWebhook({ secret: "", headers, body: raw }));
});

it("uses Post for Me shared header independently and does not call it a body signature", async () => {
  const result = await verifyPostForMeWebhook({
    secret,
    headers: new Headers({ "Post-For-Me-Webhook-Secret": secret }),
    body: raw,
  });

  assert.equal(result.bodyAuthenticated, false);
  assert.equal(result.method, "shared-secret-header");
  await assert.rejects(
    verifyPostForMeWebhook({
      secret,
      headers: new Headers({ "X-Zernio-Signature": signature }),
      body: raw,
    }),
  );
  await assert.rejects(
    verifyPostForMeWebhook({
      secret,
      headers: new Headers({ "Post-For-Me-Webhook-Secret": "wrong" }),
      body: raw,
    }),
  );
  await assert.rejects(
    verifyZernioWebhook({
      secret,
      headers: new Headers({ "Post-For-Me-Webhook-Secret": secret }),
      body: raw,
    }),
  );
});

it("decodes signed identity and redacts secrets without trusting tenant fields", async () => {
  const event = await decodeWebhook({
    provider: "zernio",
    backend: "managed",
    body: raw,
    receivedAt: "2026-09-19T00:01:00Z",
  });

  assert.equal(event.type, "publication.updated");
  assert.equal(event.identity, "provider-event-id");
  assert.deepEqual(event.accountIds, ["account-1"]);
  assert.ok(!JSON.stringify(event).includes("private-token"));

  const unknown = await decodeWebhook({
    provider: "zernio",
    backend: "managed",
    body: new TextEncoder().encode(JSON.stringify({ id: "u", event: "brand.new.event" })),
  });

  assert.equal(unknown.type, "unknown");
});

it("documents absent Post for Me event IDs through deterministic exact-body identity", async () => {
  const body = new TextEncoder().encode(
    JSON.stringify({
      event_type: "social.post.result.created",
      data: { id: "result-1", social_account_id: "account-1", success: false },
    }),
  );

  const first = await decodeWebhook({ provider: "post-for-me", backend: "managed", body });
  const replay = await decodeWebhook({ provider: "post-for-me", backend: "managed", body });
  assert.equal(first.identity, "body-digest");
  assert.equal(first.id, replay.id);
  assert.deepEqual(first.accountIds, ["account-1"]);
});

it("accepts replay once, keeps processing separate, and quarantines unmapped events", async () => {
  const accepted = new Map<string, Parameters<EventInbox["accept"]>[0]>();

  const inbox: EventInbox = {
    async accept(input) {
      if (accepted.has(input.key)) return "duplicate";
      accepted.set(input.key, input);

      return "accepted";
    },
  };

  const event = await decodeWebhook({ provider: "zernio", backend: "managed", body: raw });

  const input = {
    event,
    endpointId: "endpoint-1",
    inbox,
    resolveTenants: async () => ["tenant-1"],
  };

  assert.equal((await acceptWebhook(input)).state, "accepted");
  assert.equal((await acceptWebhook(input)).state, "duplicate");
  assert.equal(accepted.size, 1);
  assert.equal([...accepted.values()][0]?.state, "pending");
  assert.equal(
    (await acceptWebhook({ ...input, endpointId: "quarantine", resolveTenants: async () => [] }))
      .quarantined,
    true,
  );
  await assert.rejects(
    acceptWebhook({
      ...input,
      inbox: {
        async accept() {
          throw new Error("database unavailable");
        },
      },
    }),
  );
});

it("preserves large numeric IDs from webhook JSON exactly", async () => {
  const body = new TextEncoder().encode(
    '{"event_type":"social.post.updated","data":{"social_account_id":9007199254740993,"text":"9007199254740993","count":12}}',
  );

  const event = await decodeWebhook({ provider: "post-for-me", backend: "managed", body });
  assert.deepEqual(event.accountIds, ["9007199254740993"]);
  assert.equal(event.data["text"], "9007199254740993");
  assert.equal(event.data["count"], 12);
});

it("quarantines partially mapped and cross-tenant payloads instead of exposing other accounts", async () => {
  const event = {
    ...(await decodeWebhook({ provider: "zernio", backend: "managed", body: raw })),
    accountIds: ["a", "b"],
  };

  const records: Parameters<EventInbox["accept"]>[0][] = [];

  const inbox: EventInbox = {
    async accept(input) {
      records.push(input);

      return "accepted";
    },
  };

  const input = { event, endpointId: "endpoint", inbox };
  assert.equal(
    (
      await acceptWebhook({
        ...input,
        resolveTenants: async (_backend, ids) => (ids[0] === "a" ? ["tenant-a"] : []),
      })
    ).quarantined,
    true,
  );
  assert.equal(
    (
      await acceptWebhook({
        ...input,
        resolveTenants: async (_backend, ids) => (ids[0] === "a" ? ["tenant-a"] : ["tenant-b"]),
      })
    ).quarantined,
    true,
  );
  assert.deepEqual(records[0]?.tenantIds, []);
  assert.deepEqual(records[1]?.tenantIds, []);
  assert.equal(
    (
      await acceptWebhook({
        ...input,
        resolveTenants: async (_backend, ids) =>
          ids[0] === "a" ? ["tenant-shared", "tenant-a"] : ["tenant-shared", "tenant-b"],
      })
    ).quarantined,
    false,
  );
  assert.deepEqual(records[2]?.tenantIds, ["tenant-shared"]);
});

it("maps documented provider record IDs and keeps backend deletion distinct from native removal", async () => {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  const zernio = await decodeWebhook({
    provider: "zernio",
    backend: "managed",
    body: encode({
      id: "event",
      event: "post.platform.deleted",
      account: { accountId: "a", platform: "threads" },
      post: { id: "backend-record", platforms: [{ accountId: "a" }] },
      platform: { name: "threads", platformPostId: "native" },
    }),
  });

  assert.deepEqual(zernio.accountIds, ["a"]);
  assert.equal(zernio.backendRecordId, "backend-record");
  assert.equal(zernio.type, "post.removed");

  const pfm = await decodeWebhook({
    provider: "post-for-me",
    backend: "managed",
    body: encode({
      event_type: "social.post.deleted",
      data: { id: "backend-record", social_accounts: [{ id: "a" }] },
    }),
  });

  assert.equal(pfm.type, "backend-record.deleted");
  assert.equal(pfm.backendRecordId, "backend-record");
  assert.deepEqual(pfm.accountIds, ["a"]);

  const result = await decodeWebhook({
    provider: "post-for-me",
    backend: "managed",
    body: encode({
      event_type: "social.post.result.created",
      data: { id: "result", post_id: "backend-record", social_account_id: "a" },
    }),
  });

  assert.equal(result.backendRecordId, "backend-record");
});
