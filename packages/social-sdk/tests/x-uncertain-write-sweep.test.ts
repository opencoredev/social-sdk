import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, type AdapterOperationContext } from "../src/index.js";
import { SocialError } from "../src/core/errors.js";
import type { JsonValue } from "../src/core/types.js";
import { x, type XNative } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "11" });

const context = (): AdapterOperationContext => ({
  backendInstance: "default",
  correlationId: "x-uncertain-write-sweep",
  retryBudget: { maxAttempts: 3, maxElapsedMs: 10_000 },
});

function answering(body: JsonValue, status = 200) {
  let requests = 0;

  const adapter = x({
    auth: { userId: "11", accessToken: "fixture" },
    appBearerToken: "fixture-app",
    fetch: async () => {
      requests++;

      return Response.json(body, { status });
    },
  });

  assert.ok(adapter.native);

  return { api: adapter.native, requests: () => requests };
}

interface WriteCase {
  readonly name: string;
  /** A 2xx body this write's decoder rejects. Defaults to a JSON array. */
  readonly malformed?: JsonValue;
  readonly call: (api: XNative, context: AdapterOperationContext) => Promise<object>;
}

// Each write is dispatched once; X answers 2xx with a body the method cannot decode.
const writes: readonly WriteCase[] = [
  { name: "createList", call: (api, c) => api.createList({ account, name: "L", context: c }) },
  {
    name: "updateList",
    call: (api, c) => api.updateList({ account, listId: "5", name: "L", context: c }),
  },
  {
    name: "addListMember",
    call: (api, c) => api.addListMember({ account, listId: "5", userId: "6", context: c }),
  },
  { name: "followList", call: (api, c) => api.followList({ account, listId: "5", context: c }) },
  { name: "pinList", call: (api, c) => api.pinList({ account, listId: "5", context: c }) },
  {
    name: "quote",
    call: (api, c) => api.quote({ account, text: "hi", quotedPostId: "7", context: c }),
  },
  {
    name: "createPoll",
    call: (api, c) =>
      api.createPoll({ account, text: "q", options: ["a", "b"], durationMinutes: 60, context: c }),
  },
  {
    name: "hideReply",
    malformed: { data: 1 },
    call: (api, c) => api.hideReply({ account, replyId: "8", hidden: true, context: c }),
  },
  {
    name: "createBookmarkFolder",
    malformed: { data: {} },
    call: (api, c) => api.createBookmarkFolder({ account, name: "Reading", context: c }),
  },
  {
    name: "createWebhook",
    call: (api, c) =>
      api.createWebhook({ account, url: "https://hooks.example.com/x", context: c }),
  },
  {
    name: "createComplianceJob",
    call: (api, c) => api.createComplianceJob({ account, type: "tweets", context: c }),
  },
  {
    name: "replayWebhook",
    malformed: { data: { job_id: "9" } },
    call: (api, c) =>
      api.replayWebhook({
        account,
        webhookId: "9",
        from: "2026-11-04T10:00:00Z",
        to: "2026-11-04T11:00:00Z",
        context: c,
      }),
  },
  {
    name: "addStreamRules",
    call: (api, c) => api.addStreamRules({ account, rules: [{ value: "cats" }], context: c }),
  },
];

const uncertain = (error: SocialError) => {
  assert.ok(error instanceof SocialError);
  assert.equal(error.code, "ambiguous_outcome");
  assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });

  return true;
};

describe("X native writes with an unreadable acknowledgement", () => {
  for (const write of writes) {
    it(`${write.name}: a 2xx body its decoder rejects is uncertain, sent once`, async () => {
      const { api, requests } = answering(write.malformed ?? [1]);

      await assert.rejects(write.call(api, context()), uncertain);
      assert.equal(requests(), 1);
    });

    it(`${write.name}: a 4xx stays a definite failure`, async () => {
      const { api, requests } = answering({ title: "Forbidden", detail: "Not allowed." }, 403);

      await assert.rejects(write.call(api, context()), (error: SocialError) => {
        assert.ok(error instanceof SocialError);
        assert.notEqual(error.code, "ambiguous_outcome");
        assert.notDeepEqual(error.retryDisposition, { kind: "reconcile-first" });

        return true;
      });
      assert.equal(requests(), 1);
    });
  }

  it("a dry-run rule change only queries, so its decode failure is not uncertain", async () => {
    const { api, requests } = answering([1]);

    await assert.rejects(
      api.addStreamRules({ account, rules: [{ value: "cats" }], dryRun: true, context: context() }),
      (error: Error) => {
        assert.ok(!(error instanceof SocialError) || error.code !== "ambiguous_outcome");

        return true;
      },
    );
    assert.equal(requests(), 1);
  });

  it("a delete answered with an empty body still succeeds", async () => {
    let requests = 0;

    const adapter = x({
      auth: { userId: "11", accessToken: "fixture" },
      fetch: async () => {
        requests++;

        return new Response(null, { status: 204 });
      },
    });

    assert.ok(adapter.native);
    await adapter.native.deleteList({ account, listId: "5", context: context() });
    assert.equal(requests, 1);
  });
});
