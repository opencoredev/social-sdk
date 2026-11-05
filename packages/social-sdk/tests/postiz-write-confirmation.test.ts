/**
 * Every Postiz write is confirmed only by its documented success answer (docs.postiz.com/public-api).
 * Each row sends exactly one write after its reads; the documented answer resolves, and every
 * malformed one (a JSON `null`, an array, an empty object, a wrong or wrong-type ID, a wrong-type
 * field) is `ambiguous_outcome` with `reconcile-first`. A failed post's outcome never carries
 * Postiz's error prose.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { postiz } from "../src/cloud/postiz.js";
import { SocialError } from "../src/core/errors.js";
import type {
  AdapterOperationContext,
  DeliveryRef,
  JsonObject,
  JsonValue,
} from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "write-confirmation",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const clock = () => new Date("2026-11-04T12:00:00.000Z");

const future = "2026-11-06T09:00:00.000Z";

const group = "5e1f0c3a-8b2d-4f6e-9a7c-1d3b5f7e9a20";

const leak = "private-marker https://cdn.example.test/v.mp4?signature=fixture";

const delivery: DeliveryRef = {
  kind: "delivery",
  version: 1,
  backend: "default",
  platform: "x",
  accountId: "int1",
  deliveryId: `p1@${future}~${group}`,
};

const account = {
  kind: "connected-account",
  version: 1,
  backend: "default",
  platform: "x",
  accountId: "int1",
} as const;

const row = (fields: JsonObject = {}): JsonObject => ({
  id: "p1",
  content: "Old text",
  publishDate: future,
  releaseURL: null,
  releaseId: null,
  state: "QUEUE",
  group,
  settings: { __type: "x", who_can_reply_post: "following" },
  tags: [],
  integration: { id: "int1", providerIdentifier: "x", name: "Demo" },
  ...fields,
});

function uncertain(error: SocialError): boolean {
  return (
    error instanceof SocialError &&
    error.code === "ambiguous_outcome" &&
    error.retryDisposition.kind === "reconcile-first"
  );
}

/** Reads list `stored`; every write gets `answer`. Returns the writes sent. */
function fakePostiz(answer: JsonValue, stored: JsonObject = row()) {
  const writes: string[] = [];

  const adapter = postiz({
    apiKey: "fixture-key",
    clock,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (method === "GET") return Response.json({ posts: [stored] });

      writes.push(`${method} ${url.pathname}`);

      return Response.json(answer);
    },
  });

  return { adapter, writes };
}

type Adapter = ReturnType<typeof fakePostiz>["adapter"];

const unusable: readonly (readonly [string, JsonValue])[] = [
  ["JSON null", null],
  ["array", []],
  ["empty object", {}],
];

interface Write {
  readonly name: string;
  readonly stored?: JsonObject;
  readonly malformed: readonly (readonly [string, JsonValue])[];
  readonly valid: JsonValue;
  readonly send: (adapter: Adapter) => Promise<object | void>;
}

const writes: readonly Write[] = [
  {
    name: "changeStatus (PUT /posts/:id/status)",
    malformed: [
      ...unusable,
      ["another post", { id: "p2", state: "DRAFT" }],
      ["unchanged state", { id: "p1", state: "QUEUE" }],
      ["numeric id", { id: 1, state: "DRAFT" }],
    ],
    valid: { id: "p1", state: "DRAFT" },
    send: (adapter) => adapter.native.changeStatus(delivery, "draft", context),
  },
  {
    name: "updateSettings (PUT /posts/:id/settings)",
    malformed: [
      ...unusable,
      ["another post", { postId: "p2", publishDate: future }],
      ["numeric publishDate", { postId: "p1", publishDate: 7 }],
      ["null publishDate", { postId: "p1", publishDate: null }],
    ],
    valid: { postId: "p1", publishDate: future },
    send: (adapter) =>
      adapter.native.updateSettings(delivery, { who_can_reply_post: "everyone" }, context),
  },
  {
    name: "setReleaseId (PUT /posts/:id/release-id)",
    stored: row({ state: "PUBLISHED", releaseId: "missing" }),
    malformed: [
      ...unusable,
      ["another post", { id: "p2", releaseId: "r1" }],
      ["another release", { id: "p1", releaseId: "r2" }],
    ],
    valid: { id: "p1", releaseId: "r1" },
    send: (adapter) => adapter.native.setReleaseId(delivery, "r1", context),
  },
  {
    name: "deleteChannel (DELETE /integrations/:id)",
    malformed: [...unusable, ["another channel", { id: "int2" }], ["numeric id", { id: 1 }]],
    valid: { id: "int1" },
    send: (adapter) => adapter.native.deleteChannel(account, { confirmAccountId: "int1" }, context),
  },
  {
    name: "generateVideo (POST /generate-video)",
    malformed: [
      ["JSON null", null],
      ["empty object", {}],
      ["no files", []],
      ["file without path", [{ id: "m1" }]],
      ["file with an http path", [{ id: "m1", path: "http://uploads.postiz.com/v.mp4" }]],
    ],
    valid: [{ id: "m1", path: "https://uploads.postiz.com/v.mp4" }],
    send: (adapter) =>
      adapter.native.generateVideo(
        {
          type: "image-text-slides",
          output: "vertical",
          customParams: { voice: "v1", prompt: "launch" },
        },
        context,
      ),
  },
  {
    name: "startClipping (POST /clipping)",
    malformed: [...unusable, ["numeric id", { id: 7 }], ["blank id", { id: " " }]],
    valid: { id: "0b6f1c1e-5f0a-4c55-9a53-2f1f6f7f7c11" },
    send: (adapter) =>
      adapter.native.startClipping({ url: "https://www.youtube.com/watch?v=abc" }, context),
  },
  {
    name: "editPost (POST /posts type update)",
    malformed: [
      ...unusable,
      ["another post", [{ postId: "p2", integration: "int1" }]],
      ["two posts", [{ postId: "p1" }, { postId: "p1" }]],
      ["non-object row", ["p1"]],
    ],
    valid: [{ postId: "p1", integration: "int1" }],
    send: (adapter) => adapter.native.editPost(delivery, { text: "New", media: [] }, context),
  },
  {
    name: "posts.cancelScheduled (DELETE /posts/:id)",
    malformed: [...unusable, ["another post", { id: "p2" }]],
    valid: { id: "p1" },
    send: (adapter) =>
      adapter.posts.cancelScheduled(
        {
          kind: "scheduled-job",
          version: 1,
          backend: "default",
          platform: "x",
          accountId: "int1",
          jobId: delivery.deliveryId,
        },
        context,
      ),
  },
];

for (const write of writes) {
  for (const [name, answer] of write.malformed)
    it(`Postiz ${write.name}: ${name} is an unconfirmed write`, async () => {
      const { adapter, writes: sent } = fakePostiz(answer, write.stored);
      await assert.rejects(write.send(adapter), uncertain);
      assert.equal(sent.length, 1);
    });

  it(`Postiz ${write.name}: the documented answer resolves`, async () => {
    const { adapter, writes: sent } = fakePostiz(write.valid, write.stored);
    await write.send(adapter);
    assert.equal(sent.length, 1);
  });
}

it("Postiz failed-post outcomes never copy the platform's error prose or links", async () => {
  const { adapter } = fakePostiz(null, row({ state: "ERROR", error: leak }));
  const outcome = await adapter.posts.getDelivery(delivery, context);

  assert.equal(outcome.state, "failed");
  assert.doesNotMatch(JSON.stringify(outcome), /private-marker|signature|cdn\.example/);
});
