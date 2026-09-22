import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SocialError,
  connectedAccountRef,
  createSocial,
  defineAdapter,
  platformPostRef,
  type CapabilityManifest,
  type ConnectedAccountRef,
  type PreparedPublishTarget,
} from "../src/index.js";

const manifest: CapabilityManifest = {
  schemaVersion: 1,
  backend: "concurrency-test",
  apiRevision: "test-v1",
  runtime: ["node", "bun"],
  capabilities: [
    { operation: "accounts.read", platform: "*", availability: "available" },
    { operation: "posts.publish", platform: "*", availability: "available" },
    { operation: "posts.read", platform: "*", availability: "available" },
    { operation: "comments.read", platform: "*", availability: "available" },
    { operation: "comments.write", platform: "*", availability: "available" },
    { operation: "messages.read", platform: "*", availability: "available" },
    { operation: "messages.write", platform: "*", availability: "available" },
    { operation: "media.upload", platform: "*", availability: "available" },
    { operation: "analytics.read", platform: "*", availability: "available" },
  ],
};

function account(backend: string, accountId = "account-1") {
  return connectedAccountRef({ backend, platform: "x", accountId });
}

function post(ref: ConnectedAccountRef) {
  return platformPostRef({ ...ref, postId: "post-1" });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;

  const promise = new Promise<void>((next) => {
    resolve = next;
  });

  // oxlint-disable-next-line anti-slop/no-known-value-widening -- validated boundary or fixture contract.
  return { promise, resolve };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }

  assert.fail("Timed out waiting for adapter dispatch");
}

function makeAdapter(
  backend: string,
  state: { active: number; peak: number; calls: number; gate: Promise<void> },
) {
  async function network<T>(value: T): Promise<T> {
    state.calls += 1;
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);

    try {
      await state.gate;

      return value;
    } finally {
      state.active -= 1;
    }
  }

  return defineAdapter({
    id: `concurrency-${backend}`,
    capabilities: manifest,
    accounts: {
      get: async (ref) =>
        network({ ref, displayName: "Test", handle: "test", status: "connected" }),
      list: async () => network({ items: [] }),
    },
    posts: {
      prepareTarget: (_target: PreparedPublishTarget) => [],
      publishTarget: async (target) =>
        network({
          state: "published" as const,
          targetIndex: target.targetIndex,
          account: target.account,
          observedAt: new Date(0).toISOString(),
          post: post(target.account),
        }),
      get: async (ref) => network({ id: ref.postId }),
    },
    media: {
      upload: async (_input, ref) =>
        network({
          kind: "media" as const,
          version: 1 as const,
          backend,
          mediaId: "media-1",
          platform: ref.platform,
          accountId: ref.accountId,
        }),
    },
    comments: {
      list: async () => network({ items: [] }),
      reply: async (ref) => network(ref),
    },
    messages: {
      listConversations: async () => network({ items: [] }),
      listMessages: async () => network({ items: [] }),
      send: async () => network({ sent: true }),
    },
    analytics: {
      getPostMetrics: async () => network([]),
    },
  });
}

test("all network facades share one backend capacity", async () => {
  const gate = deferred();
  const state = { active: 0, peak: 0, calls: 0, gate: gate.promise };

  const social = createSocial({
    backend: makeAdapter("default", state),
    concurrency: 1,
    maxQueued: 10,
  });

  const ref = account("default");
  const postRef = post(ref);

  const operations = [
    social.accounts.get(ref),
    social.posts.publish({ targets: [{ account: ref }], content: { text: "hello" } }),
    social.media.upload(
      { kind: "image", source: { kind: "https-url", url: "https://example.invalid/image" } },
      ref,
    ),
    social.comments.list(postRef),
    social.messages.listConversations(ref),
  ];

  await eventually(() => state.calls === 1);
  assert.equal(state.peak, 1);
  gate.resolve();
  await Promise.all(operations);
  assert.equal(state.calls, operations.length);
  assert.equal(state.peak, 1);
});

test("a slow backend does not consume another backend's capacity", async () => {
  const first = deferred();
  const second = deferred();
  const a = { active: 0, peak: 0, calls: 0, gate: first.promise };
  const b = { active: 0, peak: 0, calls: 0, gate: second.promise };

  const social = createSocial({
    backends: { a: makeAdapter("a", a), b: makeAdapter("b", b) },
    concurrency: 1,
    maxQueued: 1,
  });

  const one = social.accounts.get(account("a"));
  await eventually(() => a.calls === 1);
  const two = social.accounts.get(account("b"));
  await eventually(() => b.calls === 1);
  assert.equal(a.peak, 1);
  assert.equal(b.peak, 1);
  first.resolve();
  second.resolve();
  await Promise.all([one, two]);
});

test("queue overflow rejects before the adapter is called", async () => {
  const gate = deferred();
  const state = { active: 0, peak: 0, calls: 0, gate: gate.promise };

  const social = createSocial({
    backend: makeAdapter("default", state),
    concurrency: 1,
    maxQueued: 0,
  });

  const first = social.accounts.get(account("default"));
  await eventually(() => state.calls === 1);
  await assert.rejects(
    social.accounts.get(account("default", "account-2")),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
    (error: unknown) => error instanceof SocialError && error.code === "rate_limited",
  );
  assert.equal(state.calls, 1);
  gate.resolve();
  await first;
});

test("cancelling a queued call frees its queue slot", async () => {
  const gate = deferred();
  const state = { active: 0, peak: 0, calls: 0, gate: gate.promise };

  const social = createSocial({
    backend: makeAdapter("default", state),
    concurrency: 1,
    maxQueued: 1,
  });

  const first = social.accounts.get(account("default"));
  await eventually(() => state.calls === 1);
  const controller = new AbortController();

  const cancelled = social.accounts.get(account("default", "account-2"), {
    signal: controller.signal,
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(
    cancelled,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
    (error: unknown) => error instanceof SocialError && error.code === "cancelled",
  );
  const third = social.accounts.get(account("default", "account-3"));
  gate.resolve();
  await Promise.all([first, third]);
  assert.equal(state.calls, 2);
});
