import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { zernio } from "@opencoredev/social-sdk/cloud/zernio";
import { postForMe } from "@opencoredev/social-sdk/cloud/post-for-me";
import { createExampleHandler } from "../src/app.js";
import { openExampleDatabase } from "../src/storage.js";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
const request = (path: string, value: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3030${path}`, {
    method: "POST",
    headers: { host: "localhost:3030", ...headers },
    body: JSON.stringify(value),
  });

const publication = { accountIds: ["a"], text: "hello", idempotencyKey: "intent" };

const session = { principal: "user", tenantId: "tenant" };

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
const membership = (_session: unknown, id: string) => id === "a";

test("Zernio event survives restart, uses saved delivery, quarantines unknown mapping and preserves removal reports", async () => {
  const db = await openExampleDatabase();
  let published = false;
  let writes = 0;

  const backend = zernio({
    apiKey: "fixture",
    webhookSecret: "secret",
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;

      if (path === "/api/v1/accounts")
        return Response.json({ accounts: [{ _id: "a", platform: "threads", isActive: true }] });

      if (init?.method === "POST") writes++;

      return Response.json({
        post: {
          _id: "record",
          status: published ? "published" : "processing",
          platforms: [
            {
              platform: "threads",
              accountId: "a",
              status: published ? "published" : "processing",
              // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
              ...(published ? { platformPostId: "native" } : {}),
            },
          ],
        },
      });
    },
  });

  const options = { database: db, backend, backendName: "managed", session, membership };
  const first = createExampleHandler(options);
  assert.equal((await first.handle(request("/api/publish", publication))).status, 200);

  const event = {
    id: "event",
    event: "post.platform.published",
    post: { id: "record", platforms: [{ platform: "threads", accountId: "a" }] },
    account: { accountId: "a" },
  };

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
  const send = (value: unknown) =>
    request("/api/events", value, {
      "X-Zernio-Signature": createHmac("sha256", "secret")
        .update(JSON.stringify(value))
        .digest("hex"),
    });

  assert.equal((await first.handle(request("/api/events", event))).status, 403);
  assert.deepEqual(await (await first.handle(send(event))).json(), {
    state: "accepted",
    quarantined: false,
  });
  assert.deepEqual(await (await first.handle(send(event))).json(), {
    state: "duplicate",
    quarantined: false,
  });
  assert.equal(
    (
      await (
        await first.handle(send({ ...event, id: "unknown", account: { accountId: "other" } }))
      ).json()
    ).quarantined,
    true,
  );
  published = true;
  const restarted = createExampleHandler(options);
  assert.deepEqual(await (await restarted.handle(request("/api/events/process", {}))).json(), {
    applied: 1,
    pending: 0,
  });
  assert.equal(
    (await (await restarted.handle(request("/api/reconcile", { idempotencyKey: "intent" }))).json())
      .result.outcomes[0].state,
    "published",
  );

  const removal = {
    ...event,
    id: "removed",
    event: "post.platform.deleted",
    platform: { name: "threads", platformPostId: "native", status: "deleted" },
  };

  await restarted.handle(send(removal));
  await restarted.handle(request("/api/events/process", {}));

  const reports = await (
    await restarted.handle(request("/api/events/reports", { idempotencyKey: "intent" }))
  ).json();

  assert.equal(reports.reports[0].state, "removal-reported");
  assert.equal(
    (await (await restarted.handle(request("/api/reconcile", { idempotencyKey: "intent" }))).json())
      .result.outcomes[0].state,
    "published",
  );
  assert.equal(writes, 1);
  await db.close();
});

test("Post for Me result webhook resolves post_id without using result ID or payload tenant", async () => {
  const db = await openExampleDatabase();
  let allowed = true;
  let reads = 0;

  const backend = postForMe({
    apiKey: "fixture",
    webhookSecret: "secret",
    fetch: async (url) => {
      reads++;
      const path = new URL(String(url)).pathname;

      if (path === "/v1/social-accounts")
        return Response.json({
          data: [{ id: "a", platform: "threads", username: "fixture", status: "connected" }],
          meta: {},
        });

      if (path === "/v1/social-post-results")
        return Response.json({
          data: [
            {
              post_id: "record",
              social_account_id: "a",
              success: true,
              platform_data: { id: "native" },
            },
          ],
        });

      return Response.json({ id: "record", status: "processing" });
    },
  });

  const { handle } = createExampleHandler({
    database: db,
    backend,
    backendName: "managed",
    session,
    membership: (_session, id) => allowed && membership(_session, id),
  });

  assert.equal((await handle(request("/api/publish", publication))).status, 200);

  const event = {
    event_type: "social.post.result.created",
    data: { id: "result", post_id: "record", social_account_id: "a", tenantId: "untrusted" },
  };

  assert.deepEqual(
    await (
      await handle(request("/api/events", event, { "Post-For-Me-Webhook-Secret": "secret" }))
    ).json(),
    { state: "accepted", quarantined: false },
  );
  allowed = false;
  const readsBeforeRevocation = reads;
  assert.deepEqual(await (await handle(request("/api/events/process", {}))).json(), {
    applied: 0,
    pending: 1,
  });
  assert.equal(
    reads,
    readsBeforeRevocation,
    "worker must not query the provider after grant revocation",
  );
  allowed = true;
  assert.deepEqual(await (await handle(request("/api/events/process", {}))).json(), {
    applied: 1,
    pending: 0,
  });
  assert.equal(
    (await (await handle(request("/api/reconcile", { idempotencyKey: "intent" }))).json()).result
      .outcomes[0].state,
    "published",
  );
  await db.close();
});
