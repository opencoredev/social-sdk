import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import {
  SocialError,
  connectedAccountRef,
  createSocial,
  defineAdapter,
  platformPostRef,
  type AdapterOperationContext,
  type CapabilityManifest,
  type DeliveryOutcome,
  type DeliveryRef,
  type IdempotencyClaim,
  type IdempotencyClaimInput,
  type IdempotencyStore,
  type PreparedPublishTarget,
  type PublishRequest,
} from "../src/index.js";
import {
  MemoryScheduleStore,
  OutcomeReconciler,
  SocialScheduler,
  outcomeRecovery,
} from "../src/server/index.js";
import { definedFields } from "../src/core/fields.js";
import { MemoryIdempotencyStore, mockBackend } from "../src/testing/index.js";
import { x } from "../src/platforms/x.js";
import { DatabaseSync } from "node:sqlite";
import { createSqlStores, createSqliteExecutor } from "../src/server/sql-stores.js";

const manifest: CapabilityManifest = {
  schemaVersion: 1,
  backend: "test",
  apiRevision: "test-v1",
  runtime: ["node"],
  capabilities: [
    { operation: "posts.publish", platform: "*", availability: "available" },
    { operation: "posts.getDelivery", platform: "*", availability: "available" },
  ],
};

function account(accountId: string) {
  return connectedAccountRef({ backend: "default", platform: "x", accountId });
}

function deliveryRef(accountId: string, deliveryId: string): DeliveryRef {
  return {
    kind: "delivery",
    version: 1,
    backend: "default",
    platform: "x",
    accountId,
    deliveryId,
  };
}

const observedAt = "2026-01-01T00:00:00.000Z";

test("identical failures get distinct persisted retry attempts and provider keys", async () => {
  const { adapter, calls } = programmableAdapter({
    publish: (target) => ({
      state: "failed",
      targetIndex: target.targetIndex,
      account: target.account,
      observedAt,
      code: "rate_limited",
      message: "fixture",
      retryDisposition: { kind: "after-delay", delayMs: 0 },
    }),
  });

  const social = createSocial({
    recovery: outcomeRecovery(),
    backend: adapter,
    idempotencyStore: new MemoryIdempotencyStore(),
  });

  await social.posts.publish(request("a"));
  const first = await social.posts.retryFailed(request("a"));
  const second = await social.posts.retryFailed(request("a"));
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map((call) => call.key)).size, 3);
  assert.ok(first.outcomes[0]?.retryAttemptId);
  assert.notEqual(first.outcomes[0]?.retryAttemptId, second.outcomes[0]?.retryAttemptId);
});

test("conflicting delivery identity and malformed poll results preserve the saved claim", async () => {
  const accepted: DeliveryOutcome = {
    state: "accepted",
    targetIndex: 0,
    account: account("a"),
    observedAt,
    delivery: deliveryRef("a", "delivery-a"),
  };

  let candidate: DeliveryOutcome = {
    ...accepted,
    delivery: { ...deliveryRef("a", "delivery-a"), backend: "another-backend" },
  };

  const { adapter } = programmableAdapter({ publish: () => accepted, poll: () => candidate });

  const social = createSocial({
    recovery: outcomeRecovery(),
    backend: adapter,
    idempotencyStore: new MemoryIdempotencyStore(),
  });

  await social.posts.publish(request("a"));

  for (const malformed of [false, true]) {
    // Exercise an invalid JavaScript adapter result at the runtime boundary.
    if (malformed) candidate = JSON.parse(JSON.stringify({ ...accepted, state: "published" }));

    const result = await social.posts.reconcile(request("a"));
    assert.equal(result.pollErrors[0]?.code, "identity_mismatch");
    assert.deepEqual(result.outcomes[0], accepted);
  }
});

test("settling removes abort handlers after each completed wait", async () => {
  const pending: DeliveryOutcome = {
    state: "processing",
    targetIndex: 0,
    account: account("a"),
    observedAt,
    delivery: deliveryRef("a", "delivery-a"),
  };

  const { adapter } = programmableAdapter({ publish: () => pending, poll: () => pending });

  const social = createSocial({
    recovery: outcomeRecovery(),
    backend: adapter,
    idempotencyStore: new MemoryIdempotencyStore(),
  });

  await social.posts.publish(request("a"));
  const controller = new AbortController();
  const reconciler = new OutcomeReconciler({ social });
  await reconciler.settle(request("a"), { signal: controller.signal, maxPasses: 4, intervalMs: 0 });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

/** A programmable adapter: each account's publish and poll results come from the test. */
function programmableAdapter(input: {
  readonly publish: (target: PreparedPublishTarget) => DeliveryOutcome;
  readonly poll?: (ref: DeliveryRef) => DeliveryOutcome;
}) {
  const calls: { operation: string; accountId: string; key?: string }[] = [];

  const adapter = defineAdapter({
    id: "test",
    capabilities: manifest,
    posts: {
      prepareTarget: () => [],
      async publishTarget(target: PreparedPublishTarget, context: AdapterOperationContext) {
        calls.push({
          operation: "publish",
          accountId: target.account.accountId,
          ...definedFields({ key: context.targetIdempotencyKey }),
        });

        return input.publish(target);
      },
      async getDelivery(ref: DeliveryRef) {
        calls.push({ operation: "poll", accountId: ref.accountId });

        if (input.poll === undefined) throw new Error("poll not configured");

        return input.poll(ref);
      },
    },
  });

  return { adapter, calls };
}

function published(target: PreparedPublishTarget, postId: string): DeliveryOutcome {
  return {
    state: "published",
    targetIndex: target.targetIndex,
    account: target.account,
    observedAt,
    post: platformPostRef({
      backend: "default",
      platform: "x",
      accountId: target.account.accountId,
      postId,
    }),
  };
}

function request(...accountIds: string[]): PublishRequest {
  return {
    targets: accountIds.map((id) => ({ account: account(id) })),
    content: { text: "hello" },
    idempotencyKey: "logical-1",
  };
}

describe("core reconcile", () => {
  test("settles a pending delivery through the durable SQL idempotency store", async () => {
    const stores = createSqlStores({
      executor: createSqliteExecutor(new DatabaseSync(":memory:")),
      dialect: "sqlite",
    });

    await stores.driver.createSchema();
    let polled = false;

    const { adapter } = programmableAdapter({
      publish: (target) => ({
        state: "accepted",
        targetIndex: target.targetIndex,
        account: target.account,
        observedAt,
        delivery: deliveryRef("a", "delivery-a"),
      }),
      poll: (ref) => {
        polled = true;

        return {
          state: "published",
          targetIndex: 0,
          account: account(ref.accountId),
          observedAt,
          delivery: ref,
          post: platformPostRef({
            backend: "default",
            platform: "x",
            accountId: ref.accountId,
            postId: "post-a",
          }),
        };
      },
    });

    const social = createSocial({
      recovery: outcomeRecovery(),
      backend: adapter,
      idempotencyStore: stores.idempotency,
    });

    assert.equal((await social.posts.publish(request("a"))).outcomes[0]?.state, "accepted");

    const settled = await social.posts.reconcile(request("a"));

    assert.ok(polled);
    assert.equal(settled.status, "complete");
    assert.deepEqual(settled.unresolved, []);
    assert.equal((await social.posts.publish(request("a"))).outcomes[0]?.state, "published");
  });

  test("completes a failed delivery retry through the durable SQL idempotency store", async () => {
    const stores = createSqlStores({
      executor: createSqliteExecutor(new DatabaseSync(":memory:")),
      dialect: "sqlite",
    });

    await stores.driver.createSchema();
    let attempt = 0;

    const { adapter } = programmableAdapter({
      publish: (target) => {
        attempt += 1;

        return attempt === 1
          ? {
              state: "failed",
              targetIndex: target.targetIndex,
              account: target.account,
              observedAt,
              code: "rate_limited",
              message: "fixture",
              retryDisposition: { kind: "after-delay", delayMs: 0 },
            }
          : published(target, "post-a");
      },
    });

    const social = createSocial({
      recovery: outcomeRecovery(),
      backend: adapter,
      idempotencyStore: stores.idempotency,
    });

    assert.equal((await social.posts.publish(request("a"))).outcomes[0]?.state, "failed");

    const retried = await social.posts.retryFailed(request("a"));

    assert.equal(retried.outcomes[0]?.state, "published");
    assert.ok(retried.outcomes[0]?.retryAttemptId);
    const replayed = (await social.posts.publish(request("a"))).outcomes[0];

    assert.equal(replayed?.state, "published");
    assert.equal(replayed?.retryAttemptId, retried.outcomes[0]?.retryAttemptId);
  });

  test("polls pending deliveries and saves terminal outcomes in the original claim", async () => {
    const store = new MemoryIdempotencyStore();
    let pollState: "processing" | "published" = "processing";

    const { adapter, calls } = programmableAdapter({
      publish: (target) =>
        target.account.accountId === "a"
          ? published(target, "post-a")
          : {
              state: "accepted",
              targetIndex: target.targetIndex,
              account: target.account,
              observedAt,
              delivery: deliveryRef("b", "delivery-b"),
            },
      // Managed backends often report index 0; the core must remap it to the original target.
      poll: (ref) =>
        pollState === "processing"
          ? {
              state: "processing",
              targetIndex: 0,
              account: account(ref.accountId),
              observedAt,
              delivery: ref,
            }
          : {
              state: "published",
              targetIndex: 0,
              account: account(ref.accountId),
              observedAt,
              delivery: ref,
              post: platformPostRef({
                backend: "default",
                platform: "x",
                accountId: ref.accountId,
                postId: "post-b",
              }),
            },
    });

    const social = createSocial({
      recovery: outcomeRecovery(),
      backend: adapter,
      idempotencyStore: store,
    });

    const first = await social.posts.publish(request("a", "b"));
    assert.equal(first.outcomes[1]?.state, "accepted");

    const pending = await social.posts.reconcile(request("a", "b"));
    assert.equal(pending.outcomes[1]?.state, "processing");
    assert.equal(pending.outcomes[1]?.targetIndex, 1);
    assert.deepEqual(pending.unresolved, [1]);

    pollState = "published";
    const settled = await social.posts.reconcile(request("a", "b"));
    assert.equal(settled.status, "complete");
    assert.deepEqual(settled.unresolved, []);
    assert.equal(settled.outcomes[1]?.state, "published");
    assert.equal(settled.outcomes[1]?.targetIndex, 1);
    assert.equal(settled.publication.publicationId, first.publication.publicationId);

    // Published targets are never polled again, and replaying publish reads the saved outcome.
    const pollsBefore = calls.filter((call) => call.operation === "poll").length;
    const replay = await social.posts.publish(request("a", "b"));
    assert.equal(replay.outcomes[1]?.state, "published");
    await social.posts.reconcile(request("a", "b"));
    assert.equal(calls.filter((call) => call.operation === "poll").length, pollsBefore);
    assert.equal(calls.filter((call) => call.operation === "publish").length, 2);
  });

  test("polls a reconcile-first failure that has a delivery reference", async () => {
    let found = false;

    const { adapter, calls } = programmableAdapter({
      publish: (target) => ({
        state: "failed",
        targetIndex: target.targetIndex,
        account: target.account,
        observedAt,
        delivery: deliveryRef(target.account.accountId, "upload-1"),
        code: "upstream_failure",
        message: "upload finished without a status",
        retryDisposition: { kind: "reconcile-first" },
      }),
      poll: (ref) =>
        found
          ? {
              state: "published",
              targetIndex: 0,
              account: account(ref.accountId),
              observedAt,
              delivery: ref,
              post: platformPostRef({
                backend: "default",
                platform: "x",
                accountId: ref.accountId,
                postId: "post-a",
              }),
            }
          : {
              state: "processing",
              targetIndex: 0,
              account: account(ref.accountId),
              observedAt,
              delivery: ref,
            },
    });

    const social = createSocial({
      recovery: outcomeRecovery(),
      backend: adapter,
      idempotencyStore: new MemoryIdempotencyStore(),
    });

    await social.posts.publish(request("a"));

    // A retry would risk a duplicate; the failure must be reconciled first.
    const refused = await social.posts.retryFailed(request("a"));
    assert.deepEqual(refused.skipped, [{ targetIndex: 0, reason: "not-retryable" }]);

    const pending = await social.posts.reconcile(request("a"));
    assert.equal(pending.outcomes[0]?.state, "processing");
    assert.deepEqual(pending.unresolved, [0]);

    found = true;
    const settled = await social.posts.reconcile(request("a"));
    assert.equal(settled.outcomes[0]?.state, "published");
    assert.deepEqual(settled.unresolved, []);
    assert.equal(calls.filter((call) => call.operation === "publish").length, 1);
  });

  test("a scheduled job keeps polling a reconcile-first failure until it settles", async () => {
    const start = new Date("2026-03-01T10:00:00.000Z");
    let now = start;

    const { adapter, calls } = programmableAdapter({
      publish: (target) => ({
        state: "failed",
        targetIndex: target.targetIndex,
        account: target.account,
        observedAt,
        delivery: deliveryRef(target.account.accountId, "upload-1"),
        code: "upstream_failure",
        message: "upload finished without a status",
        retryDisposition: { kind: "reconcile-first" },
      }),
      poll: (ref) => ({
        state: "published",
        targetIndex: 0,
        account: account(ref.accountId),
        observedAt,
        delivery: ref,
        post: platformPostRef({
          backend: "default",
          platform: "x",
          accountId: ref.accountId,
          postId: "post-a",
        }),
      }),
    });

    const scheduler = new SocialScheduler({
      social: createSocial({
        recovery: outcomeRecovery(),
        backend: adapter,
        idempotencyStore: new MemoryIdempotencyStore(),
        clock: () => now,
      }),
      store: new MemoryScheduleStore(),
      clock: () => now,
    });

    const job = await scheduler.schedule({
      work: { kind: "publish", request: request("a") },
      at: { kind: "instant", at: "2026-03-01T11:00:00Z" },
    });

    now = new Date("2026-03-01T11:00:00.000Z");
    assert.equal((await scheduler.runDue()).jobs[0]?.status, "running");

    now = new Date("2026-03-01T11:01:00.000Z");
    assert.equal((await scheduler.runDue()).jobs[0]?.status, "completed");
    const step = (await scheduler.get(job.id))?.lanes[0]?.steps[0];
    assert.equal(step?.state === "dispatched" ? step.outcomes[0]?.state : undefined, "published");
    assert.equal(calls.filter((call) => call.operation === "publish").length, 1);
  });

  test("rejects a poll result for a different account or delivery", async () => {
    const store = new MemoryIdempotencyStore();

    const { adapter } = programmableAdapter({
      publish: (target) => ({
        state: "accepted",
        targetIndex: target.targetIndex,
        account: target.account,
        observedAt,
        delivery: deliveryRef("a", "delivery-a"),
      }),
      poll: () => ({
        state: "published",
        targetIndex: 0,
        account: account("intruder"),
        observedAt,
        post: platformPostRef({
          backend: "default",
          platform: "x",
          accountId: "intruder",
          postId: "p",
        }),
      }),
    });

    const social = createSocial({
      recovery: outcomeRecovery(),
      backend: adapter,
      idempotencyStore: store,
    });

    await social.posts.publish(request("a"));
    const result = await social.posts.reconcile(request("a"));
    assert.equal(result.outcomes[0]?.state, "accepted");
    assert.deepEqual(result.unresolved, [0]);
    assert.equal(result.pollErrors[0]?.code, "identity_mismatch");
  });

  test("stale polls do not overwrite a newer outcome", async () => {
    const inner = new MemoryIdempotencyStore();
    let claimId: string | undefined;

    // Records the claim ID so the test can act as a second, newer writer.
    const store: IdempotencyStore = {
      async claim(input) {
        const claim = await inner.claim(input);

        if (claim.kind !== "conflict") claimId = claim.claimId;

        return claim;
      },
      saveOutcome: (input) => inner.saveOutcome(input),
      compareAndSetOutcome: (input) => inner.compareAndSetOutcome(input),
    };

    let release: () => void = () => {};

    const gate = new Promise<void>((resolve) => (release = resolve));

    let entered: () => void = () => {};

    const polling = new Promise<void>((resolve) => (entered = resolve));

    const accepted: DeliveryOutcome = {
      state: "accepted",
      targetIndex: 0,
      account: account("a"),
      observedAt,
      delivery: deliveryRef("a", "delivery-a"),
    };

    const adapter = defineAdapter({
      id: "test",
      capabilities: manifest,
      posts: {
        prepareTarget: () => [],
        publishTarget: async () => accepted,
        async getDelivery(ref: DeliveryRef): Promise<DeliveryOutcome> {
          entered();
          await gate;

          return { ...accepted, state: "processing", delivery: ref };
        },
      },
    });

    const social = createSocial({
      recovery: outcomeRecovery(),
      backend: adapter,
      idempotencyStore: store,
    });

    await social.posts.publish(request("a"));
    const stale = social.posts.reconcile(request("a"));
    await polling;

    assert.ok(claimId !== undefined);

    const won = await inner.compareAndSetOutcome({
      claimId,
      targetKey: JSON.stringify(["default", "x", "a"]),
      expected: accepted,
      outcome: {
        state: "published",
        targetIndex: 0,
        account: account("a"),
        observedAt,
        post: platformPostRef({ backend: "default", platform: "x", accountId: "a", postId: "p" }),
      },
    });

    assert.equal(won, true);

    release();
    const result = await stale;
    assert.equal(result.outcomes[0]?.state, "published");
    assert.deepEqual(result.unresolved, []);
  });

  test("requires a durable store with compare-and-set outcomes", async () => {
    const legacy: IdempotencyStore = {
      async claim(_input: IdempotencyClaimInput): Promise<IdempotencyClaim> {
        return { kind: "new", claimId: "c", outcomes: {} };
      },
      async saveOutcome() {},
    };

    const { adapter } = programmableAdapter({ publish: (target) => published(target, "p") });

    const social = createSocial({
      recovery: outcomeRecovery(),
      backend: adapter,
      idempotencyStore: legacy,
    });

    await assert.rejects(
      social.posts.reconcile(request("a")),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && error.code === "invalid_config",
    );
    await assert.rejects(
      social.posts.retryFailed(request("a")),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && error.code === "invalid_config",
    );
  });

  test("X unknown outcomes without a native ID stay unresolved without any network call", async () => {
    let fetches = 0;
    const store = new MemoryIdempotencyStore();

    const adapter = x({
      auth: { userId: "u1", accessToken: "fixture" },
      fetch: async () => {
        fetches++;

        return new Response(JSON.stringify({ data: {} }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const social = createSocial({
      recovery: outcomeRecovery(),
      backend: adapter,
      idempotencyStore: store,
    });

    const xRequest: PublishRequest = {
      targets: [
        { account: connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" }) },
      ],
      content: { text: "hello" },
      idempotencyKey: "x-1",
    };

    const first = await social.posts.publish(xRequest);
    assert.equal(first.outcomes[0]?.state, "unknown");
    assert.equal(fetches, 1);
    const result = await social.posts.reconcile(xRequest);
    assert.deepEqual(result.unresolved, [0]);
    assert.equal(result.outcomes[0]?.state, "unknown");
    assert.equal(fetches, 1);
    const retry = await social.posts.retryFailed(xRequest);
    assert.deepEqual(retry.retried, []);
    assert.equal(fetches, 1);
  });
});

describe("core retryFailed", () => {
  test("retries only failed destinations and never duplicates successes", async () => {
    const store = new MemoryIdempotencyStore();
    let failB = true;

    const { adapter, calls } = programmableAdapter({
      publish: (target) =>
        target.account.accountId === "b" && failB
          ? {
              state: "failed",
              targetIndex: target.targetIndex,
              account: target.account,
              observedAt,
              code: "rate_limited",
              message: "slow down",
              retryDisposition: { kind: "after-delay", delayMs: 1_000 },
            }
          : published(target, `post-${target.account.accountId}`),
    });

    let now = new Date("2026-01-01T00:00:00.000Z");

    const social = createSocial({
      recovery: outcomeRecovery(),
      backend: adapter,
      idempotencyStore: store,
      clock: () => now,
    });

    const first = await social.posts.publish(request("a", "b", "c"));
    assert.equal(first.status, "partial");

    failB = false;
    const early = await social.posts.retryFailed(request("a", "b", "c"));
    assert.deepEqual(early.retried, []);
    assert.deepEqual(early.skipped, [{ targetIndex: 1, reason: "retry-not-due" }]);

    now = new Date("2026-01-01T00:00:02.000Z");
    const retried = await social.posts.retryFailed(request("a", "b", "c"));
    assert.deepEqual(retried.retried, [1]);
    assert.equal(retried.status, "complete");
    assert.equal(retried.outcomes[1]?.state, "published");

    const publishes = calls.filter((call) => call.operation === "publish");
    // Destinations publish concurrently, so only the retry's position is ordered.
    const initial = publishes.slice(0, 3);
    assert.deepEqual(initial.map((call) => call.accountId).sort(), ["a", "b", "c"]);
    assert.equal(publishes[3]?.accountId, "b");
    // The retry uses a new provider idempotency key so a provider-side dedupe cannot replay the failure.
    assert.notEqual(initial.find((call) => call.accountId === "b")?.key, publishes[3]?.key);

    const again = await social.posts.retryFailed(request("a", "b", "c"));
    assert.deepEqual(again.retried, []);
    assert.equal(calls.filter((call) => call.operation === "publish").length, 4);
  });

  test("validates the whole original request before selecting a subset", async () => {
    const store = new MemoryIdempotencyStore();

    const { adapter } = programmableAdapter({
      publish: (target) => ({
        state: "failed",
        targetIndex: target.targetIndex,
        account: target.account,
        observedAt,
        code: "upstream_failure",
        message: "x",
        retryDisposition: { kind: "after-delay", delayMs: 0 },
      }),
    });

    const social = createSocial({
      recovery: outcomeRecovery(),
      backend: adapter,
      idempotencyStore: store,
    });

    await social.posts.publish(request("a", "b"));
    await assert.rejects(
      social.posts.retryFailed(request("b")),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && error.code === "idempotency_conflict",
    );
    await assert.rejects(
      social.posts.retryFailed({ ...request("a", "b"), content: { text: "changed" } }),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && error.code === "idempotency_conflict",
    );
  });

  test("does not retry never, reconcile-first, or unknown outcomes", async () => {
    const mock = mockBackend({ scenario: "mixed-success-failure" });

    const social = createSocial({
      recovery: outcomeRecovery(),
      backend: mock,
      idempotencyStore: new MemoryIdempotencyStore(),
    });

    const mixed: PublishRequest = {
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
      idempotencyKey: "mixed",
    };

    await social.posts.publish(mixed);
    const before = mock.testing.history().length;
    const result = await social.posts.retryFailed(mixed);
    assert.deepEqual(result.retried, []);
    assert.deepEqual(result.skipped, [{ targetIndex: 1, reason: "not-retryable" }]);
    assert.equal(mock.testing.history().length, before);
  });

  test("concurrent retries dispatch a failed destination once", async () => {
    const store = new MemoryIdempotencyStore();
    let attempts = 0;

    const { adapter, calls } = programmableAdapter({
      publish: (target) =>
        attempts++ === 0
          ? {
              state: "failed",
              targetIndex: target.targetIndex,
              account: target.account,
              observedAt,
              code: "upstream_failure",
              message: "x",
              retryDisposition: { kind: "after-delay", delayMs: 0 },
            }
          : published(target, "post-a"),
    });

    const social = createSocial({
      recovery: outcomeRecovery(),
      backend: adapter,
      idempotencyStore: store,
    });

    await social.posts.publish(request("a"));

    const [left, right] = await Promise.all([
      social.posts.retryFailed(request("a")),
      social.posts.retryFailed(request("a")),
    ]);

    assert.equal(left.retried.length + right.retried.length, 1);
    assert.equal(calls.filter((call) => call.operation === "publish").length, 2);
  });

  test("reauthorizes every target before polling or retrying", async () => {
    const store = new MemoryIdempotencyStore();
    let allowed = true;

    const { adapter, calls } = programmableAdapter({
      publish: (target) => ({
        state: "failed",
        targetIndex: target.targetIndex,
        account: target.account,
        observedAt,
        code: "upstream_failure",
        message: "x",
        retryDisposition: { kind: "after-delay", delayMs: 0 },
      }),
    });

    const social = createSocial({
      recovery: outcomeRecovery(),
      backend: adapter,
      idempotencyStore: store,
      authorization: {
        async authorizeTargets({ accounts }) {
          return accounts.map((ref) => ({ account: ref, allowed }));
        },
      },
    });

    await social.posts.publish(request("a"), { authorization: { tenantId: "t1" } });
    allowed = false;
    const before = calls.length;
    await assert.rejects(
      social.posts.retryFailed(request("a"), { authorization: { tenantId: "t1" } }),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && error.code === "unauthorized",
    );
    await assert.rejects(
      social.posts.reconcile(request("a"), { authorization: { tenantId: "t1" } }),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && error.code === "unauthorized",
    );
    assert.equal(calls.length, before);
  });
});

describe("OutcomeReconciler", () => {
  test("polls until settled within a bounded number of passes", async () => {
    const mock = mockBackend({ scenario: "media-processing-then-success" });

    const social = createSocial({
      recovery: outcomeRecovery(),
      backend: mock,
      idempotencyStore: new MemoryIdempotencyStore(),
    });

    const reconciler = new OutcomeReconciler({
      social,
      wait: async () => mock.testing.advanceProcessing(),
    });

    const media: PublishRequest = {
      targets: [
        {
          account: connectedAccountRef({
            backend: "default",
            platform: "x",
            accountId: "mock-account-1",
          }),
        },
      ],
      content: { text: "video" },
      idempotencyKey: "media-1",
    };

    const first = await social.posts.publish(media);
    assert.equal(first.outcomes[0]?.state, "processing");
    const settled = await reconciler.settle(media, { maxPasses: 3, intervalMs: 10 });
    assert.equal(settled.outcomes[0]?.state, "published");
    assert.deepEqual(settled.unresolved, []);
  });
});
