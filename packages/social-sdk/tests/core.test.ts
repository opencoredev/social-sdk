import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  SocialError,
  connectedAccountRef,
  createSocial,
  defineAdapter,
  type AdapterOperationContext,
  type CapabilityManifest,
  type DeliveryOutcome,
  type PreparedPublishTarget,
} from "../src/index.js";
import { MemoryIdempotencyStore, mockBackend } from "../src/testing/index.js";

const manifest: CapabilityManifest = {
  schemaVersion: 1,
  backend: "test",
  apiRevision: "test-v1",
  runtime: ["bun"],
  capabilities: [{ operation: "posts.publish", platform: "*", availability: "available" }],
};

function account(backend: string, id: string) {
  return connectedAccountRef({ backend, platform: "x", accountId: id });
}

function adapterFor(
  publishTarget: (
    input: PreparedPublishTarget,
    context: AdapterOperationContext,
  ) => Promise<DeliveryOutcome>,
) {
  return defineAdapter({
    id: "test",
    capabilities: manifest,
    posts: { prepareTarget: () => [], publishTarget },
  });
}

describe("core publication contract", () => {
  test("prepares every target before dispatch and preserves per-target results", async () => {
    const mock = mockBackend();
    const social = createSocial({ backend: mock });

    const result = await social.posts.publish({
      targets: [
        {
          account: connectedAccountRef({
            backend: "default",
            platform: "x",
            accountId: "mock-account-1",
          }),
        },
        {
          account: connectedAccountRef({
            backend: "default",
            platform: "threads",
            accountId: "mock-account-2",
          }),
        },
      ],
      content: { text: "hello" },
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.state),
      ["published", "published"],
    );
    assert.equal(
      mock.testing.history().filter((entry) => entry.operation === "posts.publishTarget").length,
      2,
    );
  });

  test("authorization resolves all targets before any dispatch", async () => {
    let authorizeCalls = 0;
    const mock = mockBackend();

    const social = createSocial({
      backend: mock,
      authorization: {
        async authorizeTargets({ accounts }) {
          authorizeCalls += 1;

          return accounts.map((candidate, index) => ({ account: candidate, allowed: index === 0 }));
        },
      },
    });

    await assert.rejects(
      social.posts.publish({
        targets: [
          {
            account: connectedAccountRef({
              backend: "default",
              platform: "x",
              accountId: "mock-account-1",
            }),
          },
          {
            account: connectedAccountRef({
              backend: "default",
              platform: "threads",
              accountId: "mock-account-2",
            }),
          },
        ],
        content: { text: "hello" },
      }),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
      (error: unknown) => error instanceof SocialError && error.code === "unauthorized",
    );
    assert.equal(authorizeCalls, 1);
    assert.equal(
      mock.testing.history().filter((entry) => entry.operation === "posts.publishTarget").length,
      0,
    );
  });

  test("does not dispatch when any target fails local preparation", async () => {
    const mock = mockBackend({ scenario: "unsupported-feature" });
    const social = createSocial({ backend: mock });
    await assert.rejects(
      social.posts.publish({
        targets: [
          {
            account: connectedAccountRef({
              backend: "default",
              platform: "x",
              accountId: "mock-account-1",
            }),
          },
        ],
        content: { text: "hello" },
      }),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
      (error: unknown) => error instanceof SocialError && error.code === "invalid_input",
    );
    assert.equal(mock.testing.history().length, 0);
  });

  test("does not dispatch when the capability manifest marks a platform unavailable", async () => {
    const adapter = defineAdapter({
      id: "limited",
      capabilities: {
        schemaVersion: 1,
        backend: "limited",
        apiRevision: "1",
        runtime: ["bun"],
        capabilities: [
          { operation: "posts.publish", platform: "x", availability: "unsupported-by-platform" },
        ],
      },
      posts: {
        prepareTarget: () => [],
        publishTarget: async () => {
          throw new Error("must not dispatch");
        },
      },
    });

    const social = createSocial({ backend: adapter });
    await assert.rejects(
      social.posts.publish({
        targets: [{ account: account("default", "a") }],
        content: { text: "hello" },
      }),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
      (error: unknown) => error instanceof SocialError && error.code === "invalid_input",
    );
  });

  test("rejects past schedules during local preparation", () => {
    const social = createSocial({ backend: mockBackend() });

    const plan = social.posts.prepare({
      targets: [
        {
          account: connectedAccountRef({
            backend: "default",
            platform: "x",
            accountId: "mock-account-1",
          }),
        },
      ],
      content: { text: "hello" },
      schedule: { at: "2020-01-01T00:00:00.000Z" },
    });

    assert.equal(plan.ok, false);
    assert.ok(plan.issues.map((issue) => issue.code).includes("schedule.in_past"));
  });

  test("uses bounded concurrency", async () => {
    let active = 0;
    let maximum = 0;

    const adapter = adapterFor(async (input) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;

      return {
        state: "published",
        targetIndex: input.targetIndex,
        account: input.account,
        observedAt: new Date(0).toISOString(),
        post: {
          kind: "platform-post",
          version: 1,
          backend: "default",
          platform: "x",
          accountId: input.account.accountId,
          postId: `post-${input.targetIndex}`,
        },
      };
    });

    const social = createSocial({ backend: adapter, concurrency: 2 });
    await social.posts.publish({
      targets: Array.from({ length: 8 }, (_, index) => ({
        account: account("default", `account-${index}`),
      })),
      content: { text: "hello" },
    });
    assert.equal(maximum, 2);
  });

  test("idempotency preserves successes and does not blindly replay", async () => {
    const store = new MemoryIdempotencyStore();
    const mock = mockBackend();
    const social = createSocial({ backend: mock, idempotencyStore: store });

    const request = {
      targets: [
        {
          account: connectedAccountRef({
            backend: "default",
            platform: "x",
            accountId: "mock-account-1",
          }),
        },
      ],
      content: { text: "same" },
      idempotencyKey: "operation-1",
    };

    const first = await social.posts.publish(request);
    const historyAfterFirst = mock.testing.history().length;
    const second = await social.posts.publish(request);
    assert.deepEqual(second.outcomes, first.outcomes);
    assert.equal(mock.testing.history().length, historyAfterFirst);
    await assert.rejects(
      social.posts.publish({ ...request, content: { text: "changed" } }),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
      (error: unknown) => error instanceof SocialError && error.code === "idempotency_conflict",
    );
  });

  test("ambiguous adapter failures become unknown outcomes", async () => {
    const mock = mockBackend({ scenario: "accepted-response-lost" });
    const social = createSocial({ backend: mock });

    const result = await social.posts.publish({
      targets: [
        {
          account: connectedAccountRef({
            backend: "default",
            platform: "x",
            accountId: "mock-account-1",
          }),
        },
      ],
      content: { text: "hello" },
    });

    assert.equal(result.outcomes[0]?.state, "unknown");
    assert.equal(result.outcomes[0]?.reason, "ambiguous-submission");
  });

  test("mock partial outcomes retain a successful target", async () => {
    const mock = mockBackend({ scenario: "mixed-success-failure" });
    const social = createSocial({ backend: mock });

    const result = await social.posts.publish({
      targets: [
        {
          account: connectedAccountRef({
            backend: "default",
            platform: "x",
            accountId: "mock-account-1",
          }),
        },
        {
          account: connectedAccountRef({
            backend: "default",
            platform: "threads",
            accountId: "mock-account-2",
          }),
        },
      ],
      content: { text: "partial" },
    });

    assert.equal(result.status, "partial");
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.state),
      ["published", "failed"],
    );
  });

  test("sequences preserve order and stop after a partial item by default", async () => {
    const social = createSocial({ backend: mockBackend({ scenario: "mixed-success-failure" }) });

    const result = await social.posts.publishSequence({
      idempotencyKey: "sequence-1",
      items: [
        {
          targets: [
            {
              account: connectedAccountRef({
                backend: "default",
                platform: "x",
                accountId: "mock-account-1",
              }),
            },
          ],
          content: { text: "first" },
        },
        {
          targets: [
            {
              account: connectedAccountRef({
                backend: "default",
                platform: "x",
                accountId: "mock-account-1",
              }),
            },
            {
              account: connectedAccountRef({
                backend: "default",
                platform: "threads",
                accountId: "mock-account-2",
              }),
            },
          ],
          content: { text: "second" },
        },
      ],
    });

    assert.equal(result.items.length, 2);
    assert.equal(result.items[0]?.outcomes[0]?.state, "published");
    assert.equal(result.items[1]?.status, "partial");
  });

  test("references are versioned and JSON-safe", () => {
    const ref = connectedAccountRef({
      backend: "managed-a",
      platform: "x",
      accountId: "900719925474099312345",
    });

    assert.deepEqual(JSON.parse(JSON.stringify(ref)), ref);
    assert.equal(ref.version, 1);
    const error = new SocialError({ code: "invalid_input", operation: "test", message: "bad" });
    assert.equal(error.toJSON().code, "invalid_input");
  });
});

test("memory idempotency keys isolate scope tuples and returned outcome mutations", async () => {
  const store = new MemoryIdempotencyStore();

  const one = await store.claim({
    scope: "tenant:a",
    key: "b",
    fingerprint: "f",
    targetKeys: ["target"],
  });

  const two = await store.claim({
    scope: "tenant",
    key: "a:b",
    fingerprint: "f",
    targetKeys: ["target"],
  });

  assert.equal(one.kind, "new");
  assert.equal(two.kind, "new");

  if (one.kind !== "new") throw new Error("Expected new claim");

  const outcome = {
    state: "processing" as const,
    targetIndex: 0,
    account: connectedAccountRef({ backend: "default", platform: "x", accountId: "a" }),
    observedAt: "2026-01-01T00:00:00Z",
  };

  await store.saveOutcome({ claimId: one.claimId, targetKey: "target", outcome });
  outcome.observedAt = "mutated";

  const read = await store.claim({
    scope: "tenant:a",
    key: "b",
    fingerprint: "f",
    targetKeys: ["target"],
  });

  if (read.kind !== "existing") throw new Error("Expected saved claim");
  assert.equal(read.outcomes["target"]?.observedAt, "2026-01-01T00:00:00Z");
  Object.assign(read.outcomes["target"]!, { observedAt: "mutated again" });

  const reread = await store.claim({
    scope: "tenant:a",
    key: "b",
    fingerprint: "f",
    targetKeys: ["target"],
  });

  if (reread.kind !== "existing") throw new Error("Expected saved claim");
  assert.equal(reread.outcomes["target"]?.observedAt, "2026-01-01T00:00:00Z");
});

test("idempotency includes reply destinations and isolates provider keys by tenant", async () => {
  const adapter = mockBackend();
  const social = createSocial({ backend: adapter, idempotencyStore: new MemoryIdempotencyStore() });

  const account = connectedAccountRef({
    backend: "default",
    platform: "x",
    accountId: "mock-account-1",
  });

  const input = {
    content: { text: "same reply" },
    targets: [{ account }],
    replyTo: { ...account, kind: "platform-post" as const, postId: "first" },
    idempotencyKey: "intent",
  };

  await social.posts.publish(input, { authorization: { tenantId: "a" } });
  await assert.rejects(
    social.posts.publish(
      { ...input, replyTo: { ...input.replyTo, postId: "second" } },
      { authorization: { tenantId: "a" } },
    ),
  );
  await social.posts.publish(input, { authorization: { tenantId: "b" } });

  const calls = adapter.testing
    .history()
    .filter((entry) => entry.operation === "posts.publishTarget");

  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]?.idempotencyKey, calls[1]?.idempotencyKey);
});

test("per-target replies stay bound to their selected backend, platform, and account", () => {
  const social = createSocial({ backend: mockBackend() });

  const one = connectedAccountRef({
    backend: "default",
    platform: "x",
    accountId: "mock-account-1",
  });

  const two = connectedAccountRef({
    backend: "default",
    platform: "threads",
    accountId: "mock-account-2",
  });

  const post = { ...one, kind: "platform-post" as const, postId: "post" };

  const request = {
    content: { text: "reply" },
    targets: [
      { account: one, replyTo: post },
      { account: two, replyTo: { ...two, kind: "platform-post" as const, postId: "other" } },
    ],
  };

  assert.equal(social.posts.prepare(request).ok, true);
  assert.equal(
    social.posts.prepare({ ...request, targets: [{ account: two, replyTo: post }] }).ok,
    false,
  );
  assert.equal(
    social.posts.prepare({
      content: { text: "reply" },
      targets: [{ account: one }, { account: two }],
      replyTo: post,
    }).ok,
    false,
  );
});

test("overlapping publish calls share dispatch capacity and queued cancellation makes no write", async () => {
  const base = mockBackend();

  let active = 0,
    peak = 0,
    calls = 0;

  let releaseFirst: () => void = () => {};

  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const backend = {
    ...base,
    posts: {
      ...base.posts!,
      async publishTarget(...args: Parameters<NonNullable<typeof base.posts>["publishTarget"]>) {
        calls++;
        active++;
        peak = Math.max(peak, active);

        try {
          if (calls === 1) await firstGate;

          return await base.posts!.publishTarget(...args);
        } finally {
          active--;
        }
      },
    },
  };

  const social = createSocial({ backend, concurrency: 1 });

  const account = connectedAccountRef({
    backend: "default",
    platform: "x",
    accountId: "mock-account-1",
  });

  const input = { content: { text: "test" }, targets: [{ account }] };
  const first = social.posts.publish(input);

  // Hashing yields to WebCrypto, so wait for the controlled adapter entry.
  while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  const controller = new AbortController();
  const second = social.posts.publish(input, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const cancelled = await second;
  assert.equal(cancelled.outcomes[0]?.state, "cancelled");

  if (cancelled.outcomes[0]?.state === "cancelled")
    assert.equal(cancelled.outcomes[0].reason, "before-submission");
  releaseFirst();
  assert.equal((await first).outcomes[0]?.state, "published");
  assert.equal(calls, 1);
  assert.equal(peak, 1);
  await social.posts.publish(input);
  assert.equal(calls, 2);
});

test("mock publications have independent delivery IDs and reject cross-account reconciliation", async () => {
  const backend = mockBackend({ scenario: "media-processing-then-success" });
  const social = createSocial({ backend });
  const account = (await social.accounts.list()).items[0]!.ref;
  const first = await social.posts.publish({ content: { text: "one" }, targets: [{ account }] });
  const second = await social.posts.publish({ content: { text: "two" }, targets: [{ account }] });
  const firstRef = first.outcomes[0]!.delivery!;
  const secondRef = second.outcomes[0]!.delivery!;
  assert.notEqual(firstRef.deliveryId, secondRef.deliveryId);
  await assert.rejects(social.posts.getDelivery({ ...firstRef, accountId: "other" }), {
    code: "unauthorized",
  });
  backend.testing.advanceProcessing();

  const results = await Promise.all([
    social.posts.getDelivery(firstRef),
    social.posts.getDelivery(secondRef),
  ]);

  assert.equal(results[0]!.state, "published");
  assert.equal(results[1]!.state, "published");

  if (results[0]!.state === "published" && results[1]!.state === "published")
    assert.notEqual(results[0]!.post.postId, results[1]!.post.postId);
});
