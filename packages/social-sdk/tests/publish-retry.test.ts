import { it } from "node:test";
import assert from "node:assert/strict";
import {
  SocialError,
  connectedAccountRef,
  createSocial,
  defineAdapter,
  platformPostRef,
  type AdapterOperationContext,
  type CapabilityManifest,
  type DeliveryOutcome,
  type PreparedPublishTarget,
} from "../src/index.js";
import { MemoryIdempotencyStore } from "../src/testing/index.js";

const manifest: CapabilityManifest = {
  schemaVersion: 1,
  backend: "retry-test",
  apiRevision: "test-v1",
  runtime: ["node", "bun"],
  capabilities: [{ operation: "posts.publish", platform: "*", availability: "available" }],
};

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "a1" });

const request = { targets: [{ account }], content: { text: "hello" } };

type Answer = "rate-limited" | "slow-rate-limited" | "unknown" | "published";

/** An adapter that answers each publish attempt from `answers` and records its context. */
function scripted(answers: readonly Answer[]) {
  const contexts: AdapterOperationContext[] = [];

  const outcome = (target: PreparedPublishTarget, answer: Answer): DeliveryOutcome => {
    const base = {
      targetIndex: target.targetIndex,
      account: target.account,
      observedAt: new Date(0).toISOString(),
    };

    switch (answer) {
      case "published":
        return {
          ...base,
          state: "published",
          post: platformPostRef({ ...target.account, postId: "p1" }),
        };
      case "unknown":
        return { ...base, state: "unknown", reason: "ambiguous-submission" };
      case "rate-limited":
      case "slow-rate-limited":
        return {
          ...base,
          state: "failed",
          code: "rate_limited",
          message: "Rate limited.",
          retryDisposition: {
            kind: "after-delay",
            delayMs: answer === "rate-limited" ? 1 : 120_000,
          },
        };
      default: {
        const _exhaustive: never = answer;

        return _exhaustive;
      }
    }
  };

  const adapter = defineAdapter({
    id: "retry-test",
    capabilities: manifest,
    posts: {
      prepareTarget: () => [],
      publishTarget: async (target, context) => {
        contexts.push(context);

        return outcome(target, answers[Math.min(contexts.length, answers.length) - 1] ?? "unknown");
      },
    },
  });

  return { adapter, contexts };
}

it("publishes once and does not retry without a retry policy", async () => {
  const { adapter, contexts } = scripted(["rate-limited", "published"]);
  const result = await createSocial({ backend: adapter }).posts.publish(request);

  assert.equal(result.outcomes[0]?.state, "failed");
  assert.equal(contexts.length, 1);
});

it("retries a rate-limited target under the same per-target idempotency key", async () => {
  const { adapter, contexts } = scripted(["rate-limited", "published"]);
  const store = new MemoryIdempotencyStore();
  const social = createSocial({ backend: adapter, idempotencyStore: store });

  const result = await social.posts.publish(
    { ...request, idempotencyKey: "retry-1" },
    { retry: { maxAttempts: 3 } },
  );

  assert.equal(result.outcomes[0]?.state, "published");
  assert.equal(contexts.length, 2);
  assert.ok(contexts[0]?.targetIdempotencyKey);
  assert.equal(contexts[0]?.targetIdempotencyKey, contexts[1]?.targetIdempotencyKey);

  // A replay with the same key returns the saved final outcome without dispatching.
  const replay = await social.posts.publish({ ...request, idempotencyKey: "retry-1" });

  assert.equal(replay.outcomes[0]?.state, "published");
  assert.equal(contexts.length, 2);
});

it("stops after maxAttempts and returns the last failure", async () => {
  const { adapter, contexts } = scripted(["rate-limited"]);

  const result = await createSocial({ backend: adapter }).posts.publish(request, {
    retry: { maxAttempts: 3 },
  });

  assert.equal(result.outcomes[0]?.state, "failed");
  assert.equal(contexts.length, 3);
});

it("never resends an unknown outcome", async () => {
  const { adapter, contexts } = scripted(["unknown", "published"]);

  const result = await createSocial({ backend: adapter }).posts.publish(request, {
    retry: { maxAttempts: 5 },
  });

  assert.equal(result.outcomes[0]?.state, "unknown");
  assert.equal(contexts.length, 1);
});

it("does not wait longer than maxDelayMs", async () => {
  const { adapter, contexts } = scripted(["slow-rate-limited", "published"]);

  const result = await createSocial({ backend: adapter }).posts.publish(request, {
    retry: { maxAttempts: 2, maxDelayMs: 1_000 },
  });

  assert.equal(result.outcomes[0]?.state, "failed");
  assert.equal(contexts.length, 1);
});

it("stops waiting when the caller aborts during the retry delay", async () => {
  const { adapter, contexts } = scripted(["slow-rate-limited", "published"]);
  const controller = new AbortController();

  // Keep retryBudget larger than the 120 s Retry-After so the retry genuinely enters waitToRetry
  // rather than exiting early on the default 30 s budget.
  const pending = createSocial({ backend: adapter }).posts.publish(request, {
    signal: controller.signal,
    retry: { maxAttempts: 2, maxDelayMs: 200_000 },
    retryBudget: { maxAttempts: 1, maxElapsedMs: 200_000 },
  });

  for (let tick = 0; tick < 100 && contexts.length === 0; tick++)
    await new Promise<void>((resolve) => setTimeout(resolve, 1));

  controller.abort();
  const result = await pending;

  assert.equal(result.outcomes[0]?.state, "failed");
  assert.equal(contexts.length, 1);
});

it("does not dispatch a retry after the shared deadline expires while waiting in the concurrency queue", async () => {
  let calls = 0;
  let blocker: Promise<unknown> | undefined;
  let social: ReturnType<typeof createSocial> | undefined;

  const adapter = defineAdapter({
    id: "queue-deadline-test",
    capabilities: {
      ...manifest,
      capabilities: [
        ...manifest.capabilities,
        { operation: "accounts.read", platform: "*", availability: "available" },
      ],
    },
    accounts: {
      list: async () => ({ items: [] }),
      get: async (ref) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));

        return { ref, status: "connected", displayName: "test" };
      },
    },
    posts: {
      prepareTarget: () => [],
      publishTarget: async (target) => {
        calls++;

        const base = {
          targetIndex: target.targetIndex,
          account: target.account,
          observedAt: new Date().toISOString(),
        };

        if (calls === 1) {
          blocker = social?.accounts.get(account);

          return {
            ...base,
            state: "failed",
            code: "rate_limited",
            message: "retry",
            retryDisposition: { kind: "after-delay", delayMs: 1 },
          };
        }

        return {
          ...base,
          state: "published",
          post: platformPostRef({ ...target.account, postId: "post-1" }),
        };
      },
    },
  });

  social = createSocial({ backend: adapter, concurrency: 1 });

  const result = await social.posts.publish(request, {
    retry: { maxAttempts: 2 },
    retryBudget: { maxAttempts: 1, maxElapsedMs: 50 },
  });

  await blocker;

  assert.equal(calls, 1);
  assert.equal(result.outcomes[0]?.state, "failed");
});

it("enforces the shared deadline and recomputes remaining budget on the first queued publish attempt", async () => {
  let nowMs = 1_000;
  let calls = 0;
  let receivedBudget: number | undefined;
  let releaseBlocker: (() => void) | undefined;
  let markEntered: (() => void) | undefined;

  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });

  const adapter = defineAdapter({
    id: "first-attempt-deadline-test",
    capabilities: {
      ...manifest,
      capabilities: [
        ...manifest.capabilities,
        { operation: "accounts.read", platform: "*", availability: "available" },
      ],
    },
    accounts: {
      list: async () => ({ items: [] }),
      get: async (ref) => {
        markEntered?.();
        await new Promise<void>((resolve) => {
          releaseBlocker = resolve;
        });

        return { ref, status: "connected", displayName: "test" };
      },
    },
    posts: {
      prepareTarget: () => [],
      publishTarget: async (target, context) => {
        calls++;
        receivedBudget = context.retryBudget.maxElapsedMs;

        return {
          targetIndex: target.targetIndex,
          account: target.account,
          observedAt: new Date(nowMs).toISOString(),
          state: "published",
          post: platformPostRef({ ...target.account, postId: "post-1" }),
        };
      },
    },
  });

  const social = createSocial({ backend: adapter, concurrency: 1, clock: () => new Date(nowMs) });
  const blocker = social.accounts.get(account);
  await entered;

  const pending = social.posts.publish(request, {
    retry: { maxAttempts: 2 },
    retryBudget: { maxAttempts: 1, maxElapsedMs: 50 },
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  nowMs = 1_020;
  releaseBlocker?.();

  const published = await pending;
  await blocker;

  assert.equal(calls, 1);
  assert.equal(receivedBudget, 30);
  assert.equal(published.outcomes[0]?.state, "published");

  // When the queue wait exceeds the deadline, the first attempt never enters the adapter.
  let enteredSecond: (() => void) | undefined;

  const secondGate = new Promise<void>((resolve) => {
    enteredSecond = resolve;
  });

  let releaseSecond: (() => void) | undefined;
  let expiredCalls = 0;

  const blockingAdapter = defineAdapter({
    id: "first-attempt-expired-test",
    capabilities: {
      ...manifest,
      capabilities: [
        ...manifest.capabilities,
        { operation: "accounts.read", platform: "*", availability: "available" },
      ],
    },
    accounts: {
      list: async () => ({ items: [] }),
      get: async (ref) => {
        enteredSecond?.();
        await new Promise<void>((resolve) => {
          releaseSecond = resolve;
        });

        return { ref, status: "connected", displayName: "test" };
      },
    },
    posts: {
      prepareTarget: () => [],
      publishTarget: async (target) => {
        expiredCalls++;

        return {
          targetIndex: target.targetIndex,
          account: target.account,
          observedAt: new Date(nowMs).toISOString(),
          state: "published",
          post: platformPostRef({ ...target.account, postId: "post-2" }),
        };
      },
    },
  });

  const social2 = createSocial({ backend: blockingAdapter, concurrency: 1 });
  const blocker2 = social2.accounts.get(account);
  await secondGate;

  const expired = await social2.posts.publish(request, {
    retry: { maxAttempts: 2 },
    retryBudget: { maxAttempts: 1, maxElapsedMs: 25 },
  });

  releaseSecond?.();
  await blocker2;

  assert.equal(expiredCalls, 0);
  assert.equal(expired.outcomes[0]?.state, "not-submitted");
});

it("rejects an out-of-range retry policy before dispatch", async () => {
  const { adapter, contexts } = scripted(["published"]);
  const social = createSocial({ backend: adapter });

  for (const retry of [{ maxAttempts: 0 }, { maxAttempts: 6 }, { maxAttempts: 2, maxDelayMs: -1 }])
    await assert.rejects(
      social.posts.publish(request, { retry }),
      (error) => error instanceof SocialError && error.code === "invalid_input",
    );

  assert.equal(contexts.length, 0);
});

it("keeps one shared retryBudget deadline across publish retries", async () => {
  const { adapter } = scripted(["rate-limited", "published"]);
  const recorded: AdapterOperationContext[] = [];

  // The adapter reports a 1 ms retry delay, but with a 50 ms shared budget and a clock that
  // jumps 60 ms during attempt 1, no second dispatch may occur.
  let nowMs = 1_000;

  const social = createSocial({
    backend: defineAdapter({
      id: "retry-test",
      capabilities: manifest,
      posts: {
        prepareTarget: () => [],
        publishTarget: async (target, context) => {
          recorded.push(context);
          nowMs += 60;

          return adapter.posts.publishTarget(target, context);
        },
      },
    }),
    clock: () => new Date(nowMs),
  });

  const exhausted = await social.posts.publish(request, {
    retryBudget: { maxAttempts: 1, maxElapsedMs: 50 },
    retry: { maxAttempts: 2, maxDelayMs: 1_000 },
  });

  assert.equal(exhausted.outcomes[0]?.state, "failed");
  assert.equal(recorded.length, 1);

  // When a retry fits inside the remaining budget, attempt 2 receives only the remaining time.
  nowMs = 2_000;
  const passedContexts: AdapterOperationContext[] = [];

  const budgeted = createSocial({
    backend: defineAdapter({
      id: "retry-test",
      capabilities: manifest,
      posts: {
        prepareTarget: () => [],
        publishTarget: async (target, context) => {
          passedContexts.push(context);
          nowMs += 10;

          return {
            targetIndex: target.targetIndex,
            account: target.account,
            observedAt: new Date(nowMs).toISOString(),
            ...(passedContexts.length === 1
              ? {
                  state: "failed" as const,
                  code: "rate_limited" as const,
                  message: "Rate limited.",
                  retryDisposition: { kind: "after-delay" as const, delayMs: 5 },
                }
              : {
                  state: "published" as const,
                  post: platformPostRef({ ...target.account, postId: "p2" }),
                }),
          };
        },
      },
    }),
    clock: () => new Date(nowMs),
  });

  const retried = await budgeted.posts.publish(request, {
    retryBudget: { maxAttempts: 1, maxElapsedMs: 50 },
    retry: { maxAttempts: 2, maxDelayMs: 1_000 },
  });

  assert.equal(retried.outcomes[0]?.state, "published");
  assert.equal(passedContexts.length, 2);
  assert.equal(passedContexts[0]?.retryBudget.maxElapsedMs, 50);
  assert.ok((passedContexts[1]?.retryBudget.maxElapsedMs ?? 50) <= 40);
});
