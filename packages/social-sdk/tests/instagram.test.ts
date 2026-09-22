import { strict as assert } from "node:assert";
import { it } from "node:test";
import {
  instagram,
  type InstagramWorkflow,
  type InstagramWorkflowStore,
} from "../src/platforms/instagram.js";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";

const context = (backend = "instagram"): AdapterOperationContext => ({
  backendInstance: backend,
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10000 },
});

const target = (
  account: ReturnType<typeof connectedAccountRef>,
  media = [
    {
      kind: "image" as const,
      source: { kind: "https-url" as const, url: "https://cdn.example/image.jpg" },
      mimeType: "image/jpeg",
      width: 1080,
      height: 1080,
    },
  ],
) => ({ targetIndex: 0, targetKey: "instagram", account, content: { text: "caption", media } });

class TestWorkflowStore implements InstagramWorkflowStore {
  readonly rows = new Map<string, InstagramWorkflow>();
  readonly claims = new Set<string>();
  private next = 1;
  async create(input: Omit<InstagramWorkflow, "id">) {
    const row = { ...input, id: `wf${this.next++}` };
    this.rows.set(row.id, row);

    return row;
  }
  async get(id: string) {
    return this.rows.get(id);
  }
  async update(id: string, update: Partial<InstagramWorkflow>) {
    const row = { ...this.rows.get(id)!, ...update, id };
    this.rows.set(id, row);

    return row;
  }
  async claim(id: string) {
    if (this.claims.has(id)) return false;
    this.claims.add(id);

    return true;
  }
  async release(id: string) {
    this.claims.delete(id);
  }
}

it("validates professional-account media and publishes an image container", async () => {
  const calls: string[] = [];

  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch: async (input) => {
      calls.push(String(input));

      if (String(input).endsWith("/media"))
        return new Response(JSON.stringify({ id: "container" }));

      if (String(input).includes("status_code"))
        return new Response(JSON.stringify({ status_code: "FINISHED" }));

      return new Response(JSON.stringify({ id: "post1" }));
    },
  });

  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  assert.equal(adapter.posts?.prepareTarget(target(account)).length, 0);
  const result = await adapter.posts?.publishTarget(target(account), context());
  assert.equal(result?.state, "published");
  assert.ok(calls.some((call) => call.endsWith("/media")));
});

it("returns processing for a continuation handle and rejects cross-account references", async () => {
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch: async (input) =>
      String(input).includes("status_code")
        ? new Response(JSON.stringify({ status_code: "IN_PROGRESS" }))
        : new Response(JSON.stringify({ id: "x" })),
  });

  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  const result = await adapter.native?.publishContainer(account, "container", context());
  assert.equal(result?.state, "processing");
  await assert.rejects(() =>
    adapter.posts?.get(
      {
        kind: "platform-post",
        version: 1,
        backend: "instagram",
        platform: "instagram",
        accountId: "other",
        postId: "p",
      },
      context(),
    ),
  );
});

it("does not treat a PUBLISHED container ID as the native media ID", async () => {
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch: async () => new Response(JSON.stringify({ status_code: "PUBLISHED" })),
  });

  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  const result = await adapter.native?.publishContainer(account, "container", context());
  assert.equal(result?.state, "unknown");
});

it("treats ERROR and EXPIRED containers as terminal failures without publishing", async () => {
  for (const status of ["ERROR", "EXPIRED"] as const) {
    let publishCalls = 0;

    const adapter = instagram({
      auth: { accessToken: "token", accountId: "ig1" },
      fetch: async (_input, init) => {
        if (init?.method === "POST") publishCalls++;

        return new Response(JSON.stringify({ status_code: status }));
      },
    });

    const account = connectedAccountRef({
      backend: "instagram",
      platform: "instagram",
      accountId: "ig1",
    });

    const result = await adapter.native?.publishContainer(account, "container", context());
    assert.equal(result?.state, "failed");
    assert.equal(publishCalls, 0);
  }
});

it("reconstructs a carousel workflow and resumes without recreating children", async () => {
  const store = new TestWorkflowStore();
  let ready = false;
  const calls: string[] = [];

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);

    if (init?.method === "POST" && url.endsWith("/media")) {
      const count = calls.filter((x) => x.includes("POST") && x.endsWith("/media")).length;

      return new Response(
        JSON.stringify({ id: count === 1 ? "c1" : count === 2 ? "c2" : "parent" }),
      );
    }

    if (init?.method !== "POST")
      return new Response(JSON.stringify({ status_code: ready ? "FINISHED" : "IN_PROGRESS" }));

    return new Response(JSON.stringify({ id: "post" }));
  };

  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  const media = [
    {
      kind: "image" as const,
      source: { kind: "https-url" as const, url: "https://cdn.example/1.jpg" },
      mimeType: "image/jpeg",
      width: 100,
      height: 100,
    },
    {
      kind: "image" as const,
      source: { kind: "https-url" as const, url: "https://cdn.example/2.jpg" },
      mimeType: "image/jpeg",
      width: 100,
      height: 100,
    },
  ];

  const first = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch,
    workflowStore: store,
  });

  const pending = await first.posts?.publishTarget(target(account, media), context());
  assert.equal(pending?.state, "processing");
  const workflowId = pending?.delivery?.deliveryId;
  assert.ok(workflowId);
  assert.deepEqual([...store.rows.keys()], [workflowId]);
  ready = true;

  const second = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch,
    workflowStore: store,
  });

  const resumed = await second.native?.resumePublication(account, workflowId, context());
  assert.equal(resumed?.state, "published");
  assert.equal(calls.filter((x) => x.includes("POST") && x.endsWith("/media")).length, 3);
});

it("serializes concurrent carousel resumes and rejects unauthorized handles", async () => {
  const store = new TestWorkflowStore();

  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    workflowStore: store,
    fetch: async (input, init) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ id: "parent" }))
        : new Response(JSON.stringify({ status_code: "FINISHED" })),
  });

  const workflow = await store.create({
    backend: "instagram",
    accountId: "ig1",
    childIds: ["c1", "c2"],
    caption: "x",
    stage: "children",
  });

  const [a, b] = await Promise.all([
    adapter.native?.resumePublication(account, workflow.id, context()),
    adapter.native?.resumePublication(account, workflow.id, context()),
  ]);

  assert.equal([a?.state, b?.state].filter((state) => state === "published").length, 1);
  assert.equal([a?.state, b?.state].filter((state) => state === "processing").length, 1);
  await assert.rejects(() =>
    adapter.native?.resumePublication(
      connectedAccountRef({ backend: "instagram", platform: "instagram", accountId: "other" }),
      workflow.id,
      context(),
    ),
  );
});

it("reconstructs a single media workflow and never replays an uncertain publish", async () => {
  const store = new TestWorkflowStore();

  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  let publishes = 0;

  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      publishes++;

      if (publishes === 1) return new Response(JSON.stringify({ id: "container" }));

      if (publishes === 2) throw new Error("connection lost after publish");

      return new Response(JSON.stringify({ id: "should-not-replay" }));
    }

    return new Response(JSON.stringify({ status_code: "FINISHED" }));
  };

  const first = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch,
    workflowStore: store,
  });

  await assert.rejects(() => first.posts?.publishTarget(target(account), context()));
  const workflowId = [...store.rows.keys()][0];
  assert.ok(workflowId);

  const second = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch,
    workflowStore: store,
  });

  const resumed = await second.native?.resumePublication(account, workflowId, context());
  assert.equal(resumed?.state, "unknown");
  assert.equal(publishes, 2);
});

it("keeps an ambiguous marker when persistence fails after accepted publish", async () => {
  const store = new TestWorkflowStore();
  let failNativePersist = true;
  const originalUpdate = store.update.bind(store);
  store.update = async (id, update) => {
    if (failNativePersist && update.nativeId) {
      failNativePersist = false;
      throw new Error("persistence unavailable");
    }

    return originalUpdate(id, update);
  };

  let postCalls = 0;

  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      postCalls++;

      return new Response(JSON.stringify({ id: postCalls === 1 ? "container" : "native" }));
    }

    return new Response(JSON.stringify({ status_code: "FINISHED" }));
  };

  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch,
    workflowStore: store,
  });

  await assert.rejects(() => adapter.posts?.publishTarget(target(account), context()));
  const id = [...store.rows.keys()][0];
  const resumed = await adapter.native?.resumePublication(account, id, context());
  assert.equal(resumed?.state, "unknown");
  assert.equal(postCalls, 2);
});
