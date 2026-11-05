import { it } from "node:test";
import assert from "node:assert/strict";
import { buffer } from "../src/cloud/buffer.js";
import { postfast } from "../src/cloud/postfast.js";
import { postForMe } from "../src/cloud/post-for-me.js";
import { postiz } from "../src/cloud/postiz.js";
import { zernioNative } from "../src/cloud/zernio-native.js";
import { connectedAccountRef, platformPostRef } from "../src/index.js";
import { SocialError } from "../src/core/errors.js";
import type { AdapterOperationContext, JsonValue, ScheduledJobRef } from "../src/core/types.js";
import { isJsonValue } from "../src/transport/json.js";
import { object, string } from "../src/transport/validation.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "managed-native-write-acknowledgements",
  retryBudget: { maxAttempts: 3, maxElapsedMs: 30_000 },
};

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface WriteCase {
  readonly name: string;
  /** Run one native write against `fetch`. */
  readonly run: (fetch: Fetch) => Promise<object | void>;
}

/**
 * 2xx bodies that cannot acknowledge a write: empty, null, the wrong JSON type, or an object
 * whose fields have the wrong types.
 */
const unreadable: readonly JsonValue[] = [
  {},
  null,
  [],
  "ok",
  1,
  { id: 7, success: "yes", data: 1 },
];

const x = connectedAccountRef({ backend: "default", platform: "x", accountId: "acc_x" });

const instagram = connectedAccountRef({
  backend: "default",
  platform: "instagram",
  accountId: "spc_account1",
});

const zernioCases: readonly WriteCase[] = [
  {
    name: "createProfile",
    run: (fetch) =>
      zernioNative({ apiKey: "fixture-key", fetch }).createProfile({ name: "Brand" }, context),
  },
  {
    name: "follow",
    run: (fetch) =>
      zernioNative({ apiKey: "fixture-key", fetch }).follow(
        { account: x, userId: "12345" },
        context,
      ),
  },
  {
    name: "startConversation",
    run: (fetch) =>
      zernioNative({ apiKey: "fixture-key", fetch }).startConversation(
        { account: x, recipient: { id: "user1" }, text: "Hello" },
        context,
      ),
  },
  {
    name: "likePost",
    run: (fetch) =>
      zernioNative({ apiKey: "fixture-key", fetch }).likePost(
        {
          post: platformPostRef({
            backend: "default",
            platform: "x",
            accountId: "acc_x",
            postId: "123",
          }),
        },
        context,
      ),
  },
];

const postFastCases: readonly WriteCase[] = [
  {
    name: "bulkDelete",
    run: (fetch) =>
      postfast({ apiKey: "fixture-key", fetch }).native.bulkDelete({ ids: ["p1"] }, context),
  },
  {
    name: "createConnectLink",
    run: (fetch) =>
      postfast({ apiKey: "fixture-key", fetch }).native.createConnectLink({}, context),
  },
  {
    name: "markInboxRead",
    run: (fetch) =>
      postfast({ apiKey: "fixture-key", fetch }).native.markInboxRead(
        { conversationId: "c1" },
        context,
      ),
  },
];

const postForMeCases: readonly WriteCase[] = [
  {
    name: "createWebhook",
    run: (fetch) =>
      postForMe({ apiKey: "fixture-key", fetch }).native.createWebhook(
        { url: "https://app.example.com/hooks", eventTypes: ["social.post.result.created"] },
        context,
      ),
  },
  {
    name: "deleteWebhook",
    run: (fetch) =>
      postForMe({ apiKey: "fixture-key", fetch }).native.deleteWebhook(
        { webhookId: "wh_1" },
        context,
      ),
  },
  {
    name: "disconnectAccount",
    run: (fetch) =>
      postForMe({ apiKey: "fixture-key", fetch }).native.disconnectAccount(
        { account: instagram },
        context,
      ),
  },
];

const postizCases: readonly WriteCase[] = [
  {
    name: "startClipping",
    run: (fetch) =>
      postiz({ apiKey: "fixture-key", fetch }).native.startClipping(
        { url: "https://www.youtube.com/watch?v=VIDEO_ID" },
        context,
      ),
  },
  {
    name: "generateVideo",
    run: (fetch) =>
      postiz({ apiKey: "fixture-key", fetch }).native.generateVideo(
        { type: "veo3", output: "vertical", customParams: { prompt: "Mountains" } },
        context,
      ),
  },
  {
    name: "deleteChannel",
    run: (fetch) =>
      postiz({ apiKey: "fixture-key", fetch }).native.deleteChannel(
        connectedAccountRef({ backend: "default", platform: "x", accountId: "int1" }),
        { confirmAccountId: "int1" },
        context,
      ),
  },
];

const bufferJob: ScheduledJobRef = {
  kind: "scheduled-job",
  version: 1,
  backend: "default",
  platform: "x",
  accountId: "channel_x",
  jobId: "post_example",
};

/**
 * Buffer answers its channel and post reads itself and hands every mutation to `mutations`,
 * so a case still sends exactly one mutation.
 */
function bufferReads(mutations: Fetch): Fetch {
  return async (input, init) => {
    const parsed: unknown = JSON.parse(String(init?.body));

    assert.ok(isJsonValue(parsed));

    const query = string(object(parsed)["query"]);

    if (query.trim().startsWith("mutation")) return mutations(input, init);

    if (query.includes("query Channels"))
      return Response.json({
        data: {
          channels: [
            {
              id: "channel_x",
              name: "x",
              displayName: "x",
              service: "twitter",
              organizationId: "org_example",
            },
          ],
        },
      });

    return Response.json({
      data: {
        post: {
          id: "post_example",
          text: "Hello",
          channelId: "channel_x",
          channelService: "twitter",
          dueAt: "2026-10-10T15:00:00.000Z",
          sentAt: null,
          status: "scheduled",
          shareMode: "customScheduled",
          schedulingType: "automatic",
          externalLink: null,
        },
      },
    });
  };
}

const bufferAdapter = (mutations: Fetch) =>
  buffer({
    apiKey: "fixture-key",
    organizationId: "org_example",
    clock: () => new Date("2026-10-09T12:00:00.000Z"),
    fetch: bufferReads(mutations),
  });

const bufferCases: readonly WriteCase[] = [
  {
    name: "createIdea",
    run: (fetch) => bufferAdapter(fetch).native.createIdea({ text: "An idea" }, context),
  },
  {
    name: "movePostInQueue",
    run: (fetch) => bufferAdapter(fetch).native.movePostInQueue(bufferJob, "top", context),
  },
  {
    name: "editPost",
    run: (fetch) => bufferAdapter(fetch).native.editPost(bufferJob, { text: "Edited" }, context),
  },
];

/** Buffer's 2xx GraphQL answers that cannot acknowledge a mutation, beside the bare bodies. */
const bufferUnreadable: readonly JsonValue[] = [
  ...unreadable,
  { data: {} },
  { data: { createIdea: 7, movePostInQueue: 7, editPost: 7 } },
  { data: { createIdea: { idea: 7 }, movePostInQueue: { post: 7 }, editPost: { post: 7 } } },
];

const table: readonly (readonly [string, readonly WriteCase[], readonly JsonValue[]])[] = [
  ["Zernio", zernioCases, unreadable],
  ["PostFast", postFastCases, unreadable],
  ["Post for Me", postForMeCases, unreadable],
  ["Postiz", postizCases, unreadable],
  ["Buffer", bufferCases, bufferUnreadable],
];

/** A fetch that answers every request with `body` and records each call's method. */
function answering(body: JsonValue, status: number) {
  const methods: string[] = [];

  const fetch: Fetch = async (_input, init) => {
    methods.push(init?.method ?? "GET");

    return Response.json(body, { status });
  };

  return { methods, fetch };
}

for (const [adapter, cases, bodies] of table)
  for (const write of cases) {
    it(`${adapter} ${write.name} keeps an unreadable 2xx acknowledgement uncertain without replaying`, async () => {
      for (const body of bodies) {
        const { methods, fetch } = answering(body, 200);

        await assert.rejects(write.run(fetch), (error: SocialError) => {
          assert.ok(error instanceof SocialError, `${JSON.stringify(body)}: ${String(error)}`);
          assert.equal(error.code, "ambiguous_outcome", JSON.stringify(body));
          assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });

          return true;
        });
        assert.equal(methods.length, 1, JSON.stringify(body));
        assert.notEqual(methods[0], "GET");
      }
    });

    it(`${adapter} ${write.name} keeps a 4xx answer a definite failure`, async () => {
      const { methods, fetch } = answering({ message: "Bad request" }, 400);

      await assert.rejects(write.run(fetch), (error: SocialError) => {
        assert.ok(error instanceof SocialError);
        assert.notEqual(error.code, "ambiguous_outcome");
        assert.deepEqual(error.retryDisposition, { kind: "never" });

        return true;
      });
      assert.equal(methods.length, 1);
    });
  }
