/**
 * Every Threads write is confirmed only by its documented answer: creates and publishes by a
 * non-empty string `id`, moderation and deletion by `{ success: true }`. Each malformed answer
 * is `ambiguous_outcome` with `reconcile-first` after exactly the writes sent so far. The sweep
 * behind this table is in the SOC-37 write-confirmation notes (sweep C).
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { connectedAccountRef, SocialError } from "../src/index.js";
import type { AdapterOperationContext, JsonValue } from "../src/core/types.js";
import { threads, type ThreadsNative } from "../src/platforms/threads.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "write-confirmation",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
};

const account = connectedAccountRef({ backend: "default", platform: "threads", accountId: "u1" });

function uncertain(error: SocialError): boolean {
  return (
    error instanceof SocialError &&
    error.code === "ambiguous_outcome" &&
    error.retryDisposition.kind === "reconcile-first"
  );
}

/** Answers each write in order and counts them. */
function setup(answers: readonly JsonValue[]) {
  let writes = 0;

  const adapter = threads({
    auth: { userId: "u1", accessToken: "fixture-only" },
    fetch: async (_input, init) => {
      const answer = answers[writes++];

      if (answer === undefined || (init?.method ?? "GET") === "GET")
        throw new Error("Unexpected request");

      return Response.json(answer);
    },
  });

  const native = adapter.native;

  if (native === undefined) throw new Error("The Threads adapter has no native surface");

  return { adapter, native, writes: () => writes };
}

const notSuccess: readonly JsonValue[] = [null, [], {}, { success: false }, { success: "true" }];

/** Answers that carry no usable ID. */
const notCreated: readonly JsonValue[] = [{}, { id: "" }, { id: 7 }, { id: null }];

interface Write {
  readonly name: string;
  readonly run: (native: ThreadsNative) => Promise<object | void>;
  readonly valid: readonly JsonValue[];
  readonly malformed: readonly JsonValue[];
}

const writes: readonly Write[] = [
  {
    name: "deletePost",
    run: (native) => native.deletePost({ account, postId: "17890000000000001", context }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "deleteComment",
    run: (native) => native.deleteComment({ account, commentId: "17890000000000002", context }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "hideReply",
    run: (native) => native.hideReply({ account, replyId: "r1", hide: true, context }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "managePendingReply",
    run: (native) => native.managePendingReply({ account, replyId: "r1", approve: true, context }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "repost",
    run: (native) => native.repost({ account, postId: "17890000000000001", context }),
    valid: [{ id: "repost1" }],
    malformed: [null, [], ...notCreated],
  },
];

for (const write of writes) {
  for (const answer of write.malformed)
    it(`Threads ${write.name} keeps ${JSON.stringify(answer)} uncertain after one write`, async () => {
      const { native, writes: sent } = setup([answer]);

      try {
        await assert.rejects(write.run(native), uncertain);
      } finally {
        assert.equal(sent(), 1);
      }
    });

  for (const answer of write.valid)
    it(`Threads ${write.name} confirms ${JSON.stringify(answer)} after one write`, async () => {
      const { native, writes: sent } = setup([answer]);

      await write.run(native);
      assert.equal(sent(), 1);
    });
}

/** Two-step writes: a container create, then its publish. */
const twoStep: readonly {
  readonly name: string;
  readonly run: (ready: ReturnType<typeof setup>) => Promise<object | void>;
}[] = [
  {
    name: "quotePost",
    run: ({ native }) =>
      native.quotePost({ account, postId: "17890000000000001", text: "Quote", context }),
  },
  {
    name: "comments.reply",
    run: ({ adapter }) =>
      adapter.comments?.reply(
        { ...account, kind: "comment", postId: "p1", commentId: "c1" },
        { text: "Reply" },
        context,
      ) ?? Promise.reject(new Error("no comments")),
  },
];

for (const step of twoStep) {
  for (const answer of notCreated)
    it(`Threads ${step.name} keeps a container answer ${JSON.stringify(answer)} uncertain`, async () => {
      const ready = setup([answer]);

      await assert.rejects(step.run(ready), uncertain);
      assert.equal(ready.writes(), 1);
    });

  for (const answer of notCreated)
    it(`Threads ${step.name} keeps a publish answer ${JSON.stringify(answer)} uncertain`, async () => {
      const ready = setup([{ id: "container1" }, answer]);

      await assert.rejects(step.run(ready), uncertain);
      assert.equal(ready.writes(), 2);
    });

  it(`Threads ${step.name} confirms a published ID after two writes`, async () => {
    const ready = setup([{ id: "container1" }, { id: "post1" }]);

    await step.run(ready);
    assert.equal(ready.writes(), 2);
  });
}
