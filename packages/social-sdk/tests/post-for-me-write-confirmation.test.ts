/**
 * Every Post for Me write is confirmed only by the answer its OpenAPI documents
 * (api.postforme.dev/docs): the addressed `SocialAccountDto` or `SocialPostDto`, a `WebhookDto`
 * with the URL and events that were set, `DeleteEntityResponseDto` with `success: true`, or an
 * auth URL for the requested platform. Each row sends exactly one write; every malformed answer
 * is `ambiguous_outcome` with `reconcile-first`.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { postForMe } from "../src/cloud/post-for-me.js";
import { SocialError } from "../src/core/errors.js";
import { connectedAccountRef } from "../src/index.js";
import type { AdapterOperationContext, JsonValue } from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "write-confirmation",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const clock = () => new Date("2026-11-04T12:00:00Z");

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "spc_1" });

const hook = "https://hooks.example.test/pfm";

const stored = {
  id: "sp_1",
  status: "scheduled",
  caption: "Old",
  scheduled_at: "2026-11-10T09:00:00Z",
  social_accounts: [{ id: "spc_1", platform: "x" }],
};

function uncertain(error: SocialError): boolean {
  return (
    error instanceof SocialError &&
    error.code === "ambiguous_outcome" &&
    error.retryDisposition.kind === "reconcile-first"
  );
}

/** Reads return the stored post; every write gets `answer`. */
function fakePostForMe(answer: JsonValue) {
  const writes: string[] = [];

  const adapter = postForMe({
    apiKey: "fixture-key",
    clock,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (method === "GET") return Response.json(stored);

      writes.push(`${method} ${url.pathname}`);

      return Response.json(answer);
    },
  });

  return { adapter, writes };
}

type Adapter = ReturnType<typeof fakePostForMe>["adapter"];

const unusable: readonly (readonly [string, JsonValue])[] = [
  ["JSON null", null],
  ["array", []],
  ["empty object", {}],
];

const socialAccount = (fields: Record<string, JsonValue>) => ({
  id: "spc_1",
  platform: "x",
  user_id: "u1",
  username: "demo",
  status: "connected",
  external_id: null,
  access_token: "fixture-token",
  ...fields,
});

const webhook = (fields: Record<string, JsonValue>) => ({
  id: "wh_1",
  url: hook,
  secret: "fixture-secret",
  event_types: ["social.post.created"],
  ...fields,
});

interface Write {
  readonly name: string;
  readonly malformed: readonly (readonly [string, JsonValue])[];
  readonly valid: JsonValue;
  readonly send: (adapter: Adapter) => Promise<object | void>;
}

const writes: readonly Write[] = [
  {
    name: "disconnectAccount",
    malformed: [
      ...unusable,
      ["another account", socialAccount({ id: "spc_2", status: "disconnected" })],
      ["another platform", socialAccount({ platform: "instagram", status: "disconnected" })],
      ["still connected", socialAccount({})],
    ],
    valid: socialAccount({ status: "disconnected" }),
    send: (adapter) => adapter.native.disconnectAccount({ account }, context),
  },
  {
    name: "updateAccount",
    malformed: [
      ...unusable,
      ["another account", socialAccount({ id: "spc_2", external_id: "tenant-2" })],
      ["old external_id", socialAccount({ external_id: "tenant-1" })],
      ["no external_id", socialAccount({ external_id: null })],
    ],
    valid: socialAccount({ external_id: "tenant-2" }),
    send: (adapter) => adapter.native.updateAccount({ account, externalId: "tenant-2" }, context),
  },
  {
    name: "deleteAccount",
    malformed: [
      ...unusable,
      ["success false", { success: false }],
      ["string", { success: "true" }],
    ],
    valid: { success: true },
    send: (adapter) => adapter.native.deleteAccount({ account }, context),
  },
  {
    name: "createConnection (auth-url)",
    malformed: [
      ...unusable,
      ["another platform", { url: "https://x.com/oauth", platform: "instagram" }],
      ["http URL", { url: "http://x.com/oauth", platform: "x" }],
    ],
    valid: { url: "https://x.com/oauth", platform: "x" },
    send: (adapter) =>
      adapter.native.createConnection(
        { platform: "x", externalId: "tenant-1", permissions: ["posts"] },
        context,
      ),
  },
  {
    name: "createWebhook",
    malformed: [
      ...unusable,
      ["blank id", webhook({ id: " " })],
      ["another URL", webhook({ url: "https://other.example.test/" })],
      ["other events", webhook({ event_types: ["social.post.deleted"] })],
      ["no secret", webhook({ secret: null })],
    ],
    valid: webhook({}),
    send: (adapter) =>
      adapter.native.createWebhook({ url: hook, eventTypes: ["social.post.created"] }, context),
  },
  {
    name: "updateWebhook",
    malformed: [
      ...unusable,
      ["another webhook", webhook({ id: "wh_2" })],
      ["old URL", webhook({ url: "https://old.example.test/" })],
      ["numeric events", webhook({ event_types: [1] })],
    ],
    valid: webhook({}),
    send: (adapter) => adapter.native.updateWebhook({ webhookId: "wh_1", url: hook }, context),
  },
  {
    name: "deleteWebhook",
    malformed: [...unusable, ["success false", { success: false }]],
    valid: { success: true },
    send: (adapter) => adapter.native.deleteWebhook({ webhookId: "wh_1" }, context),
  },
  {
    name: "updatePost (PUT /v1/social-posts/{id})",
    malformed: [...unusable, ["another post", { ...stored, id: "sp_2" }]],
    valid: { ...stored, caption: "New" },
    send: (adapter) =>
      adapter.native.updatePost(
        {
          delivery: {
            kind: "delivery",
            version: 1,
            backend: "default",
            platform: "x",
            accountId: "spc_1",
            deliveryId: "sp_1",
          },
          text: "New",
        },
        context,
      ),
  },
  {
    name: "posts.cancelScheduled (PUT isDraft)",
    malformed: [
      ...unusable,
      ["still scheduled", stored],
      ["another post", { ...stored, id: "sp_2", status: "draft" }],
    ],
    valid: { ...stored, status: "draft" },
    send: (adapter) =>
      adapter.posts.cancelScheduled(
        {
          kind: "scheduled-job",
          version: 1,
          backend: "default",
          platform: "x",
          accountId: "spc_1",
          jobId: "sp_1",
        },
        context,
      ),
  },
];

for (const write of writes) {
  for (const [name, answer] of write.malformed)
    it(`Post for Me ${write.name}: ${name} is an unconfirmed write`, async () => {
      const { adapter, writes: sent } = fakePostForMe(answer);
      await assert.rejects(write.send(adapter), uncertain);
      assert.equal(sent.length, 1);
    });

  it(`Post for Me ${write.name}: the documented answer resolves`, async () => {
    const { adapter, writes: sent } = fakePostForMe(write.valid);
    const result = await write.send(adapter);
    assert.equal(sent.length, 1);
    assert.doesNotMatch(JSON.stringify(result ?? null), /fixture-token/);
  });
}
