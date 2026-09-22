import { test } from "node:test";
import assert from "node:assert/strict";
import { threads, MemoryThreadsWorkflowStore } from "../src/platforms/threads.js";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";

const account = connectedAccountRef({ backend: "default", platform: "threads", accountId: "u1" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "fixture",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

for (const kind of ["image", "video"] as const)
  test(`Threads reconstructs ${kind} workflow and uses POST for both writes`, async () => {
    const store = new MemoryThreadsWorkflowStore();
    const writes: URL[] = [];

    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith("/threads") || url.pathname.endsWith("/threads_publish")) {
        assert.equal(init?.method, "POST");
        writes.push(url);

        return Response.json({ id: url.pathname.endsWith("/threads") ? "container" : "native" });
      }

      assert.equal(init?.method, "GET");

      return Response.json({ id: "container", status: "FINISHED" });
    };

    const options = {
      auth: { userId: "u1", accessToken: "fixture-token" },
      workflowStore: store,
      fetch: fetcher,
    };

    const first = threads(options);

    const outcome = await first.posts!.publishTarget(
      {
        targetIndex: 0,
        targetKey: "t",
        account,
        content: {
          text: "caption",
          media: [{ kind, source: { kind: "https-url", url: `https://cdn.example.test/${kind}` } }],
        },
        options: { replyControl: "mentionedOnly" },
      },
      context,
    );

    assert.equal(writes.length, 0);
    const id = outcome.delivery!.deliveryId;
    const resumed = await threads(options).native!.resumePublication(account, id, context);
    assert.equal(resumed.state, "published");
    assert.equal(writes[0]?.searchParams.get("media_type"), kind.toUpperCase());
    assert.equal(writes[0]?.searchParams.get(`${kind}_url`), `https://cdn.example.test/${kind}`);
    assert.equal(writes[0]?.searchParams.get("reply_control"), "mentionedOnly");
    assert.equal(writes.length, 2);
    await first.native!.resumePublication(account, id, context);
    assert.equal(writes.length, 2);
  });

test("Threads never republishes after a lost create response or a PUBLISHED container without native ID", async () => {
  for (const scenario of ["lost-parent", "lost-publish", "published-container"]) {
    const store = new MemoryThreadsWorkflowStore();
    let writes = 0;

    const adapter = threads({
      auth: { userId: "u1", accessToken: "fixture" },
      workflowStore: store,
      fetch: async (input, init) => {
        const url = new URL(String(input));

        if (init?.method === "POST") {
          writes++;

          if (scenario === "lost-parent" || url.pathname.endsWith("threads_publish"))
            throw new Error("lost response");

          return Response.json({ id: "container" });
        }

        return Response.json({
          status: scenario === "published-container" ? "PUBLISHED" : "FINISHED",
        });
      },
    });

    const initial = await adapter.posts!.publishTarget(
      { targetIndex: 0, targetKey: "t", account, content: { text: "hello" } },
      context,
    );

    const id = initial.delivery!.deliveryId;

    try {
      await adapter.native!.resumePublication(account, id, context);
    } catch {
      /* A lost parent response is surfaced as an error; persisted workflow remains unknown. */
    }

    const count = writes;
    assert.equal((await adapter.native!.resumePublication(account, id, context)).state, "unknown");
    assert.equal(writes, count);
    await assert.rejects(
      adapter.native!.resumePublication({ ...account, accountId: "other" }, id, context),
    );
  }
});

test("Threads reads insight values from the documented values array", async () => {
  const adapter = threads({
    auth: { userId: "u1", accessToken: "fixture" },
    fetch: async () =>
      Response.json({
        data: [
          { name: "views", values: [{ value: 17 }] },
          { name: "likes", values: [] },
        ],
      }),
  });

  const metrics = await adapter.analytics!.getPostMetrics(
    { ...account, kind: "platform-post", postId: "post" },
    context,
  );

  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]?.value, 17);
});

test("Threads persists each carousel child before waiting and serializes concurrent resumes", async () => {
  const store = new MemoryThreadsWorkflowStore();

  let children = 0,
    parents = 0,
    publications = 0;

  let finished = false;

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));

    if (init?.method === "POST" && url.pathname.endsWith("/threads")) {
      if (url.searchParams.get("is_carousel_item") === "true")
        return Response.json({ id: `child-${++children}` });
      parents++;

      return Response.json({ id: "parent" });
    }

    if (init?.method === "POST") {
      publications++;

      return Response.json({ id: "native" });
    }

    return Response.json({ status: finished ? "FINISHED" : "IN_PROGRESS" });
  };

  const options = {
    auth: { userId: "u1", accessToken: "fixture" },
    workflowStore: store,
    fetch: fetcher,
  };

  const first = threads(options);

  const outcome = await first.posts!.publishTarget(
    {
      targetIndex: 0,
      targetKey: "t",
      account,
      content: {
        media: [1, 2].map((i) => ({
          kind: "image",
          source: { kind: "https-url", url: `https://cdn.example.test/${i}.jpg` },
        })),
      },
    },
    context,
  );

  const id = outcome.delivery!.deliveryId;
  assert.equal(children, 0);
  assert.equal((await first.native!.resumePublication(account, id, context)).state, "processing");
  assert.equal(children, 2);
  assert.equal(parents, 0);
  finished = true;
  const restarted = threads(options);

  const results = await Promise.all([
    restarted.native!.resumePublication(account, id, context),
    first.native!.resumePublication(account, id, context),
  ]);

  assert.ok(results.some((result) => result.state === "published"));
  assert.equal(children, 2);
  assert.equal(parents, 1);
  assert.equal(publications, 1);
});
