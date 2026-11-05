/**
 * Every Buffer mutation is confirmed only by its documented success answer: `PostActionSuccess`
 * with the post (a Buffer ID, the edited post's own ID on edits, a status string, the target
 * channel), `DeletePostSuccess` with the deleted ID, or `IdeaResponse` with the idea ID. A stated
 * `MutationError` keeps its classification. Every other answer after dispatch is
 * `ambiguous_outcome` with `reconcile-first`, after exactly one mutation request. Failure text
 * never carries Buffer's error prose or links.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { SocialError, connectedAccountRef, createSocial } from "../src/index.js";
import { buffer } from "../src/cloud/buffer.js";
import type { AdapterOperationContext, JsonObject, JsonValue } from "../src/core/types.js";
import { isJsonValue } from "../src/transport/json.js";
import { isJsonObject, isString } from "../src/transport/validation.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "write-confirmation",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const clock = () => new Date("2026-10-09T12:00:00.000Z");

const future = "2026-10-10T15:00:00.000Z";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "channel_x" });

const leak = "private-marker https://cdn.example.test/media?signature=fixture";

const post = (fields: JsonObject = {}): JsonObject => ({
  id: "post_example",
  text: "Hello",
  channelId: "channel_x",
  channelService: "twitter",
  dueAt: future,
  sentAt: null,
  status: "scheduled",
  shareMode: "customScheduled",
  schedulingType: "automatic",
  externalLink: null,
  ...fields,
});

function uncertain(error: SocialError): boolean {
  return (
    error instanceof SocialError &&
    error.code === "ambiguous_outcome" &&
    error.retryDisposition.kind === "reconcile-first"
  );
}

/** The `SocialError` a write rejected with; any other result fails the test. */
async function rejection(sent: Promise<object | void>): Promise<SocialError> {
  try {
    await sent;
  } catch (error) {
    if (error instanceof SocialError) return error;

    throw error;
  }

  return assert.fail("expected a rejection");
}

/**
 * A fake Buffer API: channels and post reads answer normally; each mutation gets `answer`, the
 * whole response body. Returns the mutation count.
 */
function fakeBuffer(answer: JsonValue, stored: JsonObject = post()) {
  const mutations: string[] = [];

  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const parsed: unknown = JSON.parse(String(init?.body));
    assert.ok(isJsonValue(parsed) && isJsonObject(parsed) && isString(parsed["query"]));
    const query = parsed["query"];

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

    if (!query.trim().startsWith("mutation")) return Response.json({ data: { post: stored } });

    mutations.push(query);

    return Response.json(answer);
  };

  return {
    mutations,
    adapter: buffer({ apiKey: "fixture-key", organizationId: "org_example", clock, fetch }),
  };
}

type Adapter = ReturnType<typeof fakeBuffer>["adapter"];

const delivery = {
  kind: "delivery",
  version: 1,
  backend: "default",
  platform: "x",
  accountId: "channel_x",
  deliveryId: "post_example",
} as const;

async function publish(adapter: Adapter) {
  const prepared = createSocial({ backend: adapter, clock }).posts.prepare({
    targets: [{ account }],
    content: { text: "hi" },
  });

  const target = prepared.targets[0];
  assert.ok(target);

  return adapter.posts.publishTarget(target, context);
}

/** Whole-response answers that confirm no mutation, for a mutation field named `field`. */
const unconfirmed = (field: string): readonly (readonly [string, JsonValue])[] => [
  ["JSON null", null],
  ["array", []],
  ["no data", {}],
  ["data null", { data: null }],
  ["field null", { data: { [field]: null } }],
  ["field array", { data: { [field]: [] } }],
  ["empty payload", { data: { [field]: {} } }],
  ["message without a type name", { data: { [field]: { message: "Rejected" } } }],
];

const postAnswers = (field: string): readonly (readonly [string, JsonValue])[] => [
  ...unconfirmed(field),
  ["post null", { data: { [field]: { post: null } } }],
  ["post without id", { data: { [field]: { post: post({ id: null }) } } }],
  ["numeric id", { data: { [field]: { post: post({ id: 7 }) } } }],
  ["blank id", { data: { [field]: { post: post({ id: " " }) } } }],
  ["missing status", { data: { [field]: { post: post({ status: null }) } } }],
  ["other channel", { data: { [field]: { post: post({ channelId: "channel_other" }) } } }],
];

const editAnswers = (field: string): readonly (readonly [string, JsonValue])[] => [
  ...postAnswers(field),
  ["another post", { data: { [field]: { post: post({ id: "post_other" }) } } }],
];

interface Write {
  readonly name: string;
  readonly malformed: readonly (readonly [string, JsonValue])[];
  readonly valid: JsonValue;
  readonly send: (adapter: Adapter) => Promise<object | void>;
}

const writes: readonly Write[] = [
  {
    name: "createPost (posts.publishTarget)",
    malformed: postAnswers("createPost"),
    valid: { data: { createPost: { post: post() } } },
    send: publish,
  },
  {
    name: "editPost",
    malformed: editAnswers("editPost"),
    valid: { data: { editPost: { post: post({ text: "updated" }) } } },
    send: (adapter) => adapter.native.editPost(delivery, { text: "updated" }, context),
  },
  {
    name: "movePostInQueue",
    malformed: editAnswers("movePostInQueue"),
    valid: { data: { movePostInQueue: { post: post() } } },
    send: (adapter) => adapter.native.movePostInQueue(delivery, "top", context),
  },
  {
    name: "deletePost (posts.cancelScheduled)",
    malformed: [
      ...unconfirmed("deletePost"),
      ["numeric id", { data: { deletePost: { id: 7 } } }],
      ["another id", { data: { deletePost: { id: "post_other" } } }],
    ],
    valid: { data: { deletePost: { id: "post_example" } } },
    send: (adapter) =>
      adapter.posts.cancelScheduled(
        { ...delivery, kind: "scheduled-job", jobId: "post_example" },
        context,
      ),
  },
  {
    name: "createIdea",
    malformed: [
      ...unconfirmed("createIdea"),
      ["idea null", { data: { createIdea: { idea: null } } }],
      ["idea without id", { data: { createIdea: { idea: {} } } }],
      ["numeric id", { data: { createIdea: { idea: { id: 7 } } } }],
      ["blank id", { data: { createIdea: { idea: { id: " " } } } }],
    ],
    valid: { data: { createIdea: { idea: { id: "idea_1" } } } },
    send: (adapter) => adapter.native.createIdea({ title: "Idea" }, context),
  },
];

for (const write of writes) {
  for (const [name, answer] of write.malformed)
    it(`Buffer ${write.name}: ${name} is an unconfirmed write`, async () => {
      const { adapter, mutations } = fakeBuffer(answer);

      await assert.rejects(write.send(adapter), uncertain);
      assert.equal(mutations.length, 1);
    });

  it(`Buffer ${write.name}: the documented answer resolves`, async () => {
    const { adapter, mutations } = fakeBuffer(write.valid);
    await write.send(adapter);
    assert.equal(mutations.length, 1);
  });

  it(`Buffer ${write.name}: a stated MutationError stays definite and carries no prose`, async () => {
    const field = Object.keys(
      isJsonObject(write.valid) && isJsonObject(write.valid["data"]) ? write.valid["data"] : {},
    )[0];

    assert.ok(field !== undefined);

    const { adapter, mutations } = fakeBuffer({
      data: { [field]: { __typename: "InvalidInputError", message: leak } },
    });

    const error = await rejection(write.send(adapter));

    assert.equal(error.code, "invalid_input");
    assert.equal(error.upstreamCode, "InvalidInputError");
    assert.doesNotMatch(JSON.stringify(error.toJSON()), /private-marker|signature|cdn\.example/);
    assert.equal(mutations.length, 1);
  });
}

it("Buffer failed-post outcomes never copy Buffer's error prose or links", async () => {
  const failed = post({
    status: "error",
    error: { message: leak, rawError: leak, supportUrl: "https://cdn.example.test/?signature=1" },
  });

  const { adapter } = fakeBuffer(null, failed);
  const outcome = await adapter.posts.getDelivery(delivery, context);

  assert.equal(outcome.state, "failed");
  assert.doesNotMatch(JSON.stringify(outcome), /private-marker|signature|cdn\.example/);

  const edited = fakeBuffer({ data: { editPost: { post: failed } } }, post({ status: "draft" }));
  const after = await edited.adapter.native.editPost(delivery, { text: "x" }, context);

  assert.equal(after.state, "failed");
  assert.doesNotMatch(JSON.stringify(after), /private-marker|signature|cdn\.example/);
});

it("Buffer editPost rejects asset and metadata edits instead of dropping them", async () => {
  // A JavaScript caller, or a widened object, can carry fields the type does not name.
  const edit = { text: "updated", assets: [] };
  const { adapter, mutations } = fakeBuffer({ data: { editPost: { post: post() } } });

  const error = await rejection(adapter.native.editPost(delivery, edit, context));

  assert.equal(error.code, "invalid_input");
  assert.equal(mutations.length, 0);
});
