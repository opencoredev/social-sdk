import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSocial,
  type DeliveryRef,
  type JsonObject,
  type ScheduledJobRef,
} from "@opencoredev/social-sdk";
import { postForMe } from "@opencoredev/social-sdk/cloud/post-for-me";
import { postfast } from "@opencoredev/social-sdk/cloud/postfast";
import { postiz } from "@opencoredev/social-sdk/cloud/postiz";
import type { EventInbox, SocialEvent } from "@opencoredev/social-sdk/server";
import { cancelAndDelete, postForMeWebhookRoute } from "./backend-post-for-me.js";
import { deleteFailedRecord, readPostMetrics, waitForDelivery } from "./backend-postfast.js";
import * as postizSnippets from "./backend-postiz.js";
import { nextStep, zernioWebhookRoute } from "./backend-zernio.js";

function memoryInbox() {
  const events: SocialEvent[] = [];
  const keys = new Set<string>();

  const inbox: EventInbox = {
    async accept(input) {
      if (keys.has(input.key)) return "duplicate";
      keys.add(input.key);
      events.push(input.event);

      return "accepted";
    },
  };

  return { inbox, events };
}

async function hmacHex(secret: string, body: Uint8Array<ArrayBuffer>) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));

  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("Zernio route verifies the raw body, then decodes and accepts the event", async () => {
  const { inbox, events } = memoryInbox();

  const route = zernioWebhookRoute({
    secret: "fixture-secret",
    endpointId: "zernio-main",
    inbox,
    resolveTenants: async () => ["tenant-a"],
  });

  const body = new TextEncoder().encode(
    JSON.stringify({
      id: "evt_1",
      event: "post.published",
      post: { _id: "rec_1", platforms: [{ accountId: "acc_1" }] },
    }),
  );

  const signature = await hmacHex("fixture-secret", body);
  const url = "https://app.example/api/zernio";

  const accepted = await route(
    new Request(url, { method: "POST", headers: { "X-Zernio-Signature": signature }, body }),
  );

  assert.equal(accepted.status, 202);
  assert.equal(await accepted.text(), "accepted");
  assert.equal(events[0]?.type, "publication.updated");
  assert.equal(events[0]?.backendRecordId, "rec_1");

  const rejected = await route(
    new Request(url, { method: "POST", headers: { "X-Zernio-Signature": "0".repeat(64) }, body }),
  );

  assert.equal(rejected.status, 401);
  assert.equal(events.length, 1);
});

test("Post for Me route checks the shared-secret header", async () => {
  const { inbox, events } = memoryInbox();

  const route = postForMeWebhookRoute({
    secret: "fixture-secret",
    endpointId: "pfm-main",
    inbox,
    resolveTenants: async () => ["tenant-a"],
  });

  const body = JSON.stringify({
    event_type: "social.post.updated",
    data: { id: "sp_1", social_accounts: ["spc_1"] },
  });

  const url = "https://app.example/api/post-for-me";

  const accepted = await route(
    new Request(url, {
      method: "POST",
      headers: { "Post-For-Me-Webhook-Secret": "fixture-secret" },
      body,
    }),
  );

  assert.equal(accepted.status, 202);
  assert.equal(events[0]?.backendRecordId, "sp_1");

  const rejected = await route(
    new Request(url, { method: "POST", headers: { "Post-For-Me-Webhook-Secret": "wrong" }, body }),
  );

  assert.equal(rejected.status, 401);
});

test("PostFast polling waits through approval and scheduling, then reads metrics", async () => {
  const row = (fields: JsonObject): JsonObject => ({
    id: "p1",
    content: "hello",
    status: "SCHEDULED",
    approvalStatus: "APPROVED",
    socialMediaId: "sm1",
    publishedAt: null,
    platformPostId: null,
    ...fields,
  });

  const published = row({
    status: "PUBLISHED",
    publishedAt: "2026-09-24T12:00:00.000Z",
    platformPostId: "native1",
  });

  const rows = [row({ approvalStatus: "PENDING_APPROVAL" }), row({})];

  const paths: string[] = [];

  const social = createSocial({
    backend: postfast({
      apiKey: "fixture",
      fetch: async (input) => {
        const url = new URL(String(input));

        paths.push(url.pathname);

        if (url.pathname === "/social-posts/analytics") return Response.json({ data: [] });

        return Response.json({ data: [rows.shift() ?? published] });
      },
    }),
  });

  const delivery: DeliveryRef = {
    kind: "delivery",
    version: 1,
    backend: "default",
    platform: "x",
    accountId: "sm1",
    deliveryId: "p1",
  };

  const outcome = await waitForDelivery(social, delivery, "tenant-a", { intervalMs: 0 });

  assert.equal(outcome.state, "published");
  assert.equal(nextStep(outcome), "published native1");
  assert.deepEqual(await readPostMetrics(social, outcome, "tenant-a"), []);
  assert.equal(paths.at(-1), "/social-posts/analytics");
  assert.equal(await deleteFailedRecord(social, outcome, "tenant-a"), false);
});

test("Postiz polling waits through the queue, then reads metrics", async () => {
  const row = (fields: JsonObject): JsonObject => ({
    id: "p1",
    content: "hello",
    publishDate: "2026-09-24T12:00:00.000Z",
    releaseURL: null,
    releaseId: null,
    state: "QUEUE",
    group: "g1",
    integration: { id: "int1", providerIdentifier: "x" },
    ...fields,
  });

  const rows = [row({})];
  const published = row({ state: "PUBLISHED", releaseId: "native1" });
  const paths: string[] = [];

  const social = createSocial({
    backend: postiz({
      apiKey: "fixture",
      fetch: async (input) => {
        const url = new URL(String(input));

        paths.push(url.pathname);

        if (url.pathname === "/public/v1/analytics/post/p1")
          return Response.json([{ label: "Likes", data: [{ total: "7", date: "2026-09-24" }] }]);

        return Response.json({ posts: [rows.shift() ?? published] });
      },
    }),
  });

  const delivery: DeliveryRef = {
    kind: "delivery",
    version: 1,
    backend: "default",
    platform: "x",
    accountId: "int1",
    deliveryId: "p1@2026-09-24T12:00:00.000Z",
  };

  const outcome = await postizSnippets.waitForDelivery(social, delivery, "tenant-a", {
    intervalMs: 0,
  });

  assert.equal(outcome.state, "published");
  assert.equal(nextStep(outcome), "published native1");

  const metrics = await postizSnippets.readPostMetrics(social, outcome, "tenant-a");

  assert.deepEqual(
    metrics.map((metric) => [metric.name, metric.value]),
    [["likes", 7]],
  );
  assert.equal(paths.at(-1), "/public/v1/analytics/post/p1");
});

test("Postiz OAuth checks state and exchanges the code for a workspace token", async () => {
  const app: postizSnippets.PostizOAuthApp = {
    clientId: "pca_fixture",
    clientSecret: "pcs_fixture",
    fetch: async (input, init) => {
      assert.equal(String(input), "https://api.postiz.com/oauth/token");
      assert.match(String(init?.body), /"code":"code-1"/);

      return Response.json({ id: "org1", access_token: "pos_fixture", scope: "*" });
    },
  };

  const session: postizSnippets.PostizOAuthSession = {};
  const authorize = new URL(postizSnippets.startPostizAuthorization(app, session));
  const state = authorize.searchParams.get("state") ?? "";

  assert.equal(authorize.origin, "https://platform.postiz.com");
  assert.equal(state, session.postizState);

  await assert.rejects(
    postizSnippets.finishPostizAuthorization(
      app,
      { postizState: state },
      new URL("https://app.example/postiz/callback?code=code-1&state=forged"),
    ),
    /state does not match/,
  );

  const token = await postizSnippets.finishPostizAuthorization(
    app,
    session,
    new URL(`https://app.example/postiz/callback?code=code-1&state=${state}`),
  );

  assert.deepEqual(token, { accessToken: "pos_fixture", organizationId: "org1", scope: "*" });
  assert.equal(session.postizState, undefined);
  assert.ok(postizSnippets.createTenantPostizSocial(token));
});

test("Post for Me cancellation keeps a draft, which is then deleted", async () => {
  const calls: string[] = [];
  const record = { id: "sp_1", status: "scheduled", scheduled_at: "2999-01-01T00:00:00.000Z" };

  const social = createSocial({
    backend: postForMe({
      apiKey: "fixture",
      fetch: async (input, init) => {
        const method = init?.method ?? "GET";
        const url = new URL(String(input));

        calls.push(`${method} ${url.pathname}`);

        if (method === "PUT") {
          record.status = "draft";

          return Response.json({ id: "sp_1", status: "draft" });
        }

        if (method === "DELETE") return Response.json({ success: true });

        return Response.json({
          ...record,
          caption: "Maintenance window tonight.",
          social_accounts: [{ id: "spc_1", platform: "x" }],
        });
      },
    }),
  });

  const job: ScheduledJobRef = {
    kind: "scheduled-job",
    version: 1,
    backend: "default",
    platform: "x",
    accountId: "spc_1",
    jobId: "sp_1",
  };

  const done = await cancelAndDelete(
    social,
    {
      state: "scheduled",
      targetIndex: 0,
      account: {
        kind: "connected-account",
        version: 1,
        backend: "default",
        platform: "x",
        accountId: "spc_1",
      },
      observedAt: "2026-09-24T12:00:00.000Z",
      job,
    },
    "tenant-a",
  );

  assert.equal(done, true);
  assert.deepEqual(
    calls.filter((call) => !call.startsWith("GET")),
    ["PUT /v1/social-posts/sp_1", "DELETE /v1/social-posts/sp_1"],
  );
});
