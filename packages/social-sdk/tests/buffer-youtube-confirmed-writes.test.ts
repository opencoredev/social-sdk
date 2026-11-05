import { it } from "node:test";
import assert from "node:assert/strict";
import { buffer } from "../src/cloud/buffer.js";
import { youtube } from "../src/platforms/youtube.js";
import { SocialError } from "../src/core/errors.js";
import type { AdapterOperationContext, JsonValue } from "../src/core/types.js";

const context = (signal?: AbortSignal): AdapterOperationContext => {
  const base: AdapterOperationContext = {
    backendInstance: "default",
    correlationId: "buffer-youtube-confirmed-writes",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
  };

  if (signal === undefined) return base;

  return { ...base, signal };
};

/** A dispatched write whose outcome is unknown must be reconciled, never retried. */
const uncertain = (error: SocialError) => {
  assert.ok(error instanceof SocialError);
  assert.equal(error.code, "ambiguous_outcome");
  assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });

  return true;
};

/** A fetch that answers every request with `body` and counts the calls. */
function answering(body: JsonValue) {
  const state = { calls: 0 };

  const fetch = async () => {
    state.calls += 1;

    return Response.json(body);
  };

  return { state, fetch };
}

const bufferWith = (
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) => buffer({ apiKey: "fixture-key", organizationId: "org_fixture", fetch });

const youtubeWith = (fetch: () => Promise<Response>) => {
  const { native } = youtube({
    auth: { accessToken: "fixture-key", channelId: "channel1" },
    fetch,
  });

  assert.ok(native);

  return native;
};

it("Buffer keeps a createIdea cancelled after dispatch uncertain", async () => {
  const controller = new AbortController();
  let calls = 0;

  const adapter = bufferWith(async () => {
    calls += 1;
    controller.abort();
    throw new DOMException("Fixture cancellation", "AbortError");
  });

  await assert.rejects(
    adapter.native.createIdea({ text: "fixture" }, context(controller.signal)),
    uncertain,
  );
  assert.equal(calls, 1);
});

it("Buffer keeps a createIdea that timed out after dispatch uncertain", async () => {
  let calls = 0;

  const adapter = buffer({
    apiKey: "fixture-key",
    organizationId: "org_fixture",
    timeoutMs: 25,
    fetch: async (_input, init) => {
      calls += 1;

      return await new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        }),
      );
    },
  });

  await assert.rejects(adapter.native.createIdea({ text: "fixture" }, context()), uncertain);
  assert.equal(calls, 1);
});

it("Buffer keeps provider content and signed URLs out of createIdea errors", async () => {
  const { state, fetch } = answering({
    data: {
      createIdea: {
        __typename: "UnexpectedError",
        message: "Rejected private-content-marker https://cdn.example/private?signature=fixture",
      },
    },
  });

  await assert.rejects(
    bufferWith(fetch).native.createIdea({ text: "fixture" }, context()),
    (error: SocialError) => {
      assert.ok(error instanceof SocialError);
      assert.doesNotMatch(JSON.stringify(error), /private-content-marker|signature=fixture/);
      assert.doesNotMatch(error.message, /private-content-marker|signature=fixture/);
      assert.equal(error.upstreamCode, "UnexpectedError");

      return uncertain(error);
    },
  );
  assert.equal(state.calls, 1);
});

it("Buffer keeps only the recognized createIdea error type, never its prose", async () => {
  const { state, fetch } = answering({
    data: { createIdea: { __typename: "UnauthorizedError", message: "private-content-marker" } },
  });

  await assert.rejects(
    bufferWith(fetch).native.createIdea({ text: "fixture" }, context()),
    (error: SocialError) =>
      error instanceof SocialError &&
      error.code === "missing_permission" &&
      error.upstreamCode === "UnauthorizedError" &&
      !error.message.includes("private-content-marker"),
  );
  assert.equal(state.calls, 1);
});

it("Buffer keeps GraphQL error prose out of public errors", async () => {
  const { state, fetch } = answering({
    data: null,
    errors: [{ message: "private-content-marker", extensions: { code: "private-content-marker" } }],
  });

  await assert.rejects(
    bufferWith(fetch).native.createIdea({ text: "fixture" }, context()),
    (error: SocialError) =>
      error instanceof SocialError &&
      error.upstreamCode === undefined &&
      !error.message.includes("private-content-marker") &&
      uncertain(error),
  );
  assert.equal(state.calls, 1);
});

const mutationErrors: readonly { readonly name: string; readonly errors: JsonValue }[] = [
  {
    name: "an execution error without extensions",
    errors: [{ message: "fixture", path: ["createIdea"] }],
  },
  {
    name: "an unfamiliar code",
    errors: [{ message: "fixture", extensions: { code: "INTERNAL_SERVER_ERROR" } }],
  },
  {
    name: "a rejection code next to an unrecognized error",
    errors: [{ message: "a", extensions: { code: "FORBIDDEN" } }, { message: "b" }],
  },
];

for (const { name, errors } of mutationErrors)
  it(`Buffer keeps a mutation uncertain after ${name}`, async () => {
    const { state, fetch } = answering({ data: null, errors });

    await assert.rejects(
      bufferWith(fetch).native.createIdea({ text: "fixture" }, context()),
      uncertain,
    );
    assert.equal(state.calls, 1);
  });

it("Buffer keeps a documented rejection code definite on a mutation", async () => {
  const { state, fetch } = answering({
    data: null,
    errors: [{ message: "fixture", extensions: { code: "FORBIDDEN" } }],
  });

  await assert.rejects(
    bufferWith(fetch).native.createIdea({ text: "fixture" }, context()),
    (error: SocialError) => error.code === "missing_permission",
  );
  assert.equal(state.calls, 1);
});

for (const action of ["bind", "transition"] as const)
  it(`YouTube liveBroadcasts ${action} rejects an unconfirmed resource body`, async () => {
    const { state, fetch } = answering({});

    await assert.rejects(
      youtubeWith(fetch).liveBroadcasts({
        action,
        id: "broadcast1",
        broadcastStatus: "live",
        context: context(),
      }),
      uncertain,
    );
    assert.equal(state.calls, 1);
  });

it("YouTube closePoll rejects an unconfirmed resource body", async () => {
  const { state, fetch } = answering({});

  await assert.rejects(
    youtubeWith(fetch).liveChatMessages({
      action: "closePoll",
      messageId: "poll1",
      context: context(),
    }),
    uncertain,
  );
  assert.equal(state.calls, 1);
});

it("YouTube transition requires the requested lifecycle state", async () => {
  const { state, fetch } = answering({ id: "broadcast1", status: { lifeCycleStatus: "ready" } });

  await assert.rejects(
    youtubeWith(fetch).liveBroadcasts({
      action: "transition",
      id: "broadcast1",
      broadcastStatus: "live",
      context: context(),
    }),
    uncertain,
  );
  assert.equal(state.calls, 1);
});

it("YouTube bind requires the bound stream it asked for", async () => {
  const { state, fetch } = answering({
    id: "broadcast1",
    contentDetails: { boundStreamId: "other-stream" },
  });

  await assert.rejects(
    youtubeWith(fetch).liveBroadcasts({
      action: "bind",
      id: "broadcast1",
      streamId: "stream1",
      context: context(),
    }),
    uncertain,
  );
  assert.equal(state.calls, 1);
});

it("control: Buffer pre-dispatch cancellation stays definite and does not fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  const { state, fetch } = answering({});

  await assert.rejects(
    bufferWith(fetch).native.createIdea({ text: "fixture" }, context(controller.signal)),
    (error: SocialError) =>
      error instanceof SocialError &&
      error.code === "cancelled" &&
      error.retryDisposition.kind === "never",
  );
  assert.equal(state.calls, 0);
});

it("control: YouTube bind accepts a resource response", async () => {
  const { state, fetch } = answering({ id: "broadcast1", status: { lifeCycleStatus: "ready" } });

  const result = await youtubeWith(fetch).liveBroadcasts({
    action: "bind",
    id: "broadcast1",
    context: context(),
  });

  assert.equal(result["id"], "broadcast1");
  assert.equal(state.calls, 1);
});

it("control: YouTube transition accepts the starting state of the requested transition", async () => {
  const { state, fetch } = answering({
    id: "broadcast1",
    status: { lifeCycleStatus: "liveStarting" },
  });

  const result = await youtubeWith(fetch).liveBroadcasts({
    action: "transition",
    id: "broadcast1",
    broadcastStatus: "live",
    context: context(),
  });

  assert.equal(result["id"], "broadcast1");
  assert.equal(state.calls, 1);
});
