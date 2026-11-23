import { it } from "node:test";
import assert from "node:assert/strict";
import {
  SocialError,
  bytes,
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
import { localMediaStaging } from "../src/media-staging.js";

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

  if (expired.outcomes[0]?.state === "not-submitted")
    assert.equal(expired.outcomes[0].reason, "before-submission");
});

it("does not apply a queue deadline when retry is omitted", async () => {
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;

  const gate = new Promise<void>((resolve) => {
    entered = resolve;
  });

  let calls = 0;

  const adapter = defineAdapter({
    id: "no-retry-queue-test",
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
        entered?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });

        return { ref, status: "connected", displayName: "test" };
      },
    },
    posts: {
      prepareTarget: () => [],
      publishTarget: async (target) => {
        calls++;

        return {
          targetIndex: target.targetIndex,
          account: target.account,
          observedAt: new Date(0).toISOString(),
          state: "published",
          post: platformPostRef({ ...target.account, postId: "post-no-retry" }),
        };
      },
    },
  });

  const social = createSocial({ backend: adapter, concurrency: 1 });
  const blocker = social.accounts.get(account);
  await gate;

  // Without `retry`, a small retryBudget must not abort queue waiting before dispatch.
  const pending = social.posts.publish(request, {
    retryBudget: { maxAttempts: 1, maxElapsedMs: 10 },
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  release?.();
  const result = await pending;
  await blocker;

  assert.equal(calls, 1);
  assert.equal(result.outcomes[0]?.state, "published");
});

it("rejects non-positive or non-finite retryBudget.maxElapsedMs when retry is enabled", async () => {
  const { adapter, contexts } = scripted(["published"]);
  const social = createSocial({ backend: adapter });

  for (const maxElapsedMs of [0, -10, Number.NaN, Number.POSITIVE_INFINITY])
    await assert.rejects(
      social.posts.publish(request, {
        retry: { maxAttempts: 2 },
        retryBudget: { maxAttempts: 1, maxElapsedMs },
      }),
      (error) => error instanceof SocialError && error.code === "invalid_input",
    );

  assert.equal(contexts.length, 0);
});

it("does not expire early for valid retry budgets larger than the 32-bit timer limit", async () => {
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;

  const gate = new Promise<void>((resolve) => {
    entered = resolve;
  });

  let calls = 0;

  const adapter = defineAdapter({
    id: "large-budget-test",
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
        entered?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });

        return { ref, status: "connected", displayName: "test" };
      },
    },
    posts: {
      prepareTarget: () => [],
      publishTarget: async (target) => {
        calls++;

        return {
          targetIndex: target.targetIndex,
          account: target.account,
          observedAt: new Date(0).toISOString(),
          state: "published",
          post: platformPostRef({ ...target.account, postId: "post-large" }),
        };
      },
    },
  });

  const social = createSocial({ backend: adapter, concurrency: 1 });
  const blocker = social.accounts.get(account);
  await gate;

  const pending = social.posts.publish(request, {
    retry: { maxAttempts: 2 },
    retryBudget: { maxAttempts: 1, maxElapsedMs: 3_000_000_000 },
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  release?.();
  const result = await pending;
  await blocker;

  assert.equal(calls, 1);
  assert.equal(result.outcomes[0]?.state, "published");
});

it("does not retry an expired first attempt even with a fixed clock and zero capacityDelayMs", async () => {
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;

  const gate = new Promise<void>((resolve) => {
    entered = resolve;
  });

  let calls = 0;

  const adapter = defineAdapter({
    id: "fixed-clock-expiry-test",
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
        entered?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });

        return { ref, status: "connected", displayName: "test" };
      },
    },
    posts: {
      prepareTarget: () => [],
      publishTarget: async (target) => {
        calls++;

        return {
          targetIndex: target.targetIndex,
          account: target.account,
          observedAt: new Date(1_000).toISOString(),
          state: "published",
          post: platformPostRef({ ...target.account, postId: "should-not-happen" }),
        };
      },
    },
  });

  const social = createSocial({ backend: adapter, concurrency: 1, clock: () => new Date(1_000) });
  const blocker = social.accounts.get(account);
  await gate;

  const result = await social.posts.publish(request, {
    retry: { maxAttempts: 2, capacityDelayMs: 0 },
    retryBudget: { maxAttempts: 1, maxElapsedMs: 25 },
  });

  release?.();
  await blocker;

  assert.equal(calls, 0);
  assert.equal(result.outcomes[0]?.state, "not-submitted");

  if (result.outcomes[0]?.state === "not-submitted")
    assert.equal(result.outcomes[0].reason, "before-submission");
});

const stagingCapabilities: CapabilityManifest = {
  ...manifest,
  capabilities: [
    {
      operation: "posts.publish",
      platform: "*",
      availability: "available",
      constraints: { mediaSources: ["https-url"] },
    },
    { operation: "accounts.read", platform: "*", availability: "available" },
  ],
};

const mediaRequest = async () => ({
  ...request,
  content: {
    text: "hello",
    media: [
      {
        kind: "image" as const,
        mimeType: "image/png",
        source: await bytes(new Uint8Array([1, 2, 3])),
      },
    ],
  },
});

const rateLimited = (target: PreparedPublishTarget): DeliveryOutcome => ({
  targetIndex: target.targetIndex,
  account: target.account,
  observedAt: new Date(0).toISOString(),
  state: "failed",
  code: "rate_limited",
  message: "try later",
  retryDisposition: { kind: "after-delay", delayMs: 1 },
});

/**
 * An adapter whose `accounts.get` holds the single backend slot until `release` runs, so a
 * publish with `maxQueued: 0` is rejected for capacity before it stages any media.
 */
function slotHolder(publishTarget: (target: PreparedPublishTarget) => Promise<DeliveryOutcome>) {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;

  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const adapter = defineAdapter({
    id: "staging-slot-test",
    capabilities: stagingCapabilities,
    accounts: {
      list: async () => ({ items: [] }),
      get: async (ref) => {
        entered?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });

        return { ref, status: "connected", displayName: "test" };
      },
    },
    posts: { prepareTarget: () => [], publishTarget },
  });

  return { adapter, held, release: () => release?.() };
}

it("reuses staged media across retries and removes it once after the final outcome", async () => {
  let stages = 0;
  let cleanups = 0;
  const staged: string[] = [];
  const answers = ["rate-limited", "rate-limited", "published"] as const;

  const adapter = defineAdapter({
    id: "staging-reuse-test",
    capabilities: stagingCapabilities,
    posts: {
      prepareTarget: () => [],
      publishTarget: async (target) => {
        const source = target.content.media?.[0]?.source;

        if (source?.kind === "https-url") staged.push(source.url);

        if (answers[staged.length - 1] === "published")
          return {
            targetIndex: target.targetIndex,
            account: target.account,
            observedAt: new Date(0).toISOString(),
            state: "published",
            post: platformPostRef({ ...target.account, postId: "p1" }),
          };

        // Copies must stay available while the target can still be retried.
        assert.equal(cleanups, 0);

        return rateLimited(target);
      },
    },
  });

  const social = createSocial({
    backend: adapter,
    mediaStaging: localMediaStaging({
      origin: "https://media.example.com",
      stageMedia: async () => {
        stages++;

        return {
          url: `https://media.example.com/${stages}.png`,
          cleanup: async () => {
            cleanups++;
          },
        };
      },
    }),
  });

  const result = await social.posts.publish(await mediaRequest(), { retry: { maxAttempts: 3 } });

  assert.equal(result.outcomes[0]?.state, "published");
  assert.equal(stages, 1);
  assert.deepEqual(staged, [
    "https://media.example.com/1.png",
    "https://media.example.com/1.png",
    "https://media.example.com/1.png",
  ]);
  assert.equal(cleanups, 1);
});

it("does not replay a target with an uploaded media reference after the adapter ran", async () => {
  let calls = 0;
  let firstFailure: DeliveryOutcome | undefined;

  const adapter = defineAdapter({
    id: "media-ref-retry-test",
    capabilities: manifest,
    posts: {
      prepareTarget: () => [],
      publishTarget: async (target) => {
        calls++;
        firstFailure = rateLimited(target);

        return firstFailure;
      },
    },
  });

  const result = await createSocial({ backend: adapter }).posts.publish(
    {
      ...request,
      content: {
        text: "hello",
        media: [
          {
            kind: "image",
            mimeType: "image/png",
            source: {
              kind: "media-ref",
              ref: {
                kind: "media",
                version: 1,
                backend: "default",
                platform: "x",
                accountId: "a1",
                mediaId: "m1",
              },
            },
          },
        ],
      },
    },
    { retry: { maxAttempts: 3 } },
  );

  assert.equal(calls, 1);
  assert.strictEqual(result.outcomes[0], firstFailure);
});

it("preserves the previous outcome when retry media staging is aborted or times out", async () => {
  for (const mode of ["abort", "deadline"] as const) {
    let stages = 0;
    let calls = 0;
    const controller = new AbortController();

    const { adapter, held, release } = slotHolder(async (target) => {
      calls++;

      return rateLimited(target);
    });

    const social = createSocial({
      backend: adapter,
      concurrency: 1,
      maxQueued: 0,
      mediaStaging: localMediaStaging({
        origin: "https://media.example.com",
        stageMedia: async () => {
          stages++;

          if (mode === "abort") setTimeout(() => controller.abort(), 5);

          return new Promise(() => {});
        },
      }),
    });

    const blocker = social.accounts.get(account);
    await held;

    const pending = social.posts.publish(await mediaRequest(), {
      signal: controller.signal,
      retry: { maxAttempts: 2, capacityDelayMs: 100 },
      retryBudget: { maxAttempts: 1, maxElapsedMs: 400 },
    });

    // Free the slot only after the first attempt was rejected for capacity.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await blocker;

    const result = await pending;

    assert.equal(stages, 1);
    assert.equal(calls, 0);
    assert.equal(result.outcomes[0]?.state, "not-submitted");

    if (result.outcomes[0]?.state === "not-submitted")
      assert.equal(result.outcomes[0].reason, "capacity", mode);
  }
});

it("reports a staging failure on a retry instead of the earlier capacity outcome", async () => {
  let calls = 0;

  const { adapter, held, release } = slotHolder(async (target) => {
    calls++;

    return rateLimited(target);
  });

  const social = createSocial({
    backend: adapter,
    concurrency: 1,
    maxQueued: 0,
    mediaStaging: localMediaStaging({
      origin: "https://media.example.com",
      stageMedia: async () => ({ url: "http://media.example.com/a.png" }),
    }),
  });

  const blocker = social.accounts.get(account);
  await held;

  const pending = social.posts.publish(await mediaRequest(), {
    retry: { maxAttempts: 2, capacityDelayMs: 100 },
    retryBudget: { maxAttempts: 1, maxElapsedMs: 5_000 },
  });

  // Free the slot only after the first attempt was rejected for capacity.
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  await blocker;

  const result = await pending;
  const outcome = result.outcomes[0];

  assert.equal(calls, 0);
  assert.equal(outcome?.state, "not-submitted");

  if (outcome?.state === "not-submitted")
    assert.deepEqual(
      outcome.issues?.map((issue) => issue.code),
      ["media.staging_url_invalid"],
    );
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

it("rejects invalid retryBudget.maxElapsedMs before planning or claiming idempotency", async () => {
  let prepareCalls = 0;
  let publishCalls = 0;
  const store = new MemoryIdempotencyStore();

  const adapter = defineAdapter({
    id: "invalid-budget-test",
    capabilities: manifest,
    posts: {
      prepareTarget: () => {
        prepareCalls++;

        return [];
      },
      publishTarget: async (target) => {
        publishCalls++;

        return {
          targetIndex: target.targetIndex,
          account: target.account,
          observedAt: new Date(0).toISOString(),
          state: "published",
          post: platformPostRef({ ...target.account, postId: "p-valid" }),
        };
      },
    },
  });

  const social = createSocial({ backend: adapter, idempotencyStore: store });

  for (const maxElapsedMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    await assert.rejects(
      social.posts.publish(
        { ...request, idempotencyKey: "invalid-budget-key" },
        { retry: { maxAttempts: 2 }, retryBudget: { maxAttempts: 1, maxElapsedMs } },
      ),
      (error) => error instanceof SocialError && error.code === "invalid_input",
    );

  assert.equal(prepareCalls, 0);
  assert.equal(publishCalls, 0);

  // The failed validation must not have claimed the idempotency key.
  const followUp = await social.posts.publish(
    { ...request, idempotencyKey: "invalid-budget-key" },
    { retry: { maxAttempts: 2 }, retryBudget: { maxAttempts: 1, maxElapsedMs: 5_000 } },
  );

  assert.equal(followUp.outcomes[0]?.state, "published");
  assert.equal(prepareCalls, 1);
  assert.equal(publishCalls, 1);
});

it("does not retry when retryDisposition.delayMs is NaN or negative", async () => {
  let calls = 0;

  const adapter = defineAdapter({
    id: "nan-delay-test",
    capabilities: manifest,
    posts: {
      prepareTarget: () => [],
      publishTarget: async (target) => {
        calls++;

        return {
          targetIndex: target.targetIndex,
          account: target.account,
          observedAt: new Date(0).toISOString(),
          state: "failed",
          code: "rate_limited",
          message: "Rate limited.",
          retryDisposition: { kind: "after-delay", delayMs: Number.NaN },
        };
      },
    },
  });

  const result = await createSocial({ backend: adapter }).posts.publish(request, {
    retry: { maxAttempts: 3 },
  });

  assert.equal(calls, 1);
  assert.equal(result.outcomes[0]?.state, "failed");
});

it("keeps retrying up to maxAttempts when an adapter returns the same frozen failure object", async () => {
  let calls = 0;
  let sharedFailure: DeliveryOutcome | undefined;

  const adapter = defineAdapter({
    id: "reused-outcome-test",
    capabilities: manifest,
    posts: {
      prepareTarget: () => [],
      publishTarget: async (target) => {
        calls++;

        if (calls < 3) {
          const failure: DeliveryOutcome =
            sharedFailure ??
            Object.freeze<DeliveryOutcome>({
              targetIndex: target.targetIndex,
              account: target.account,
              observedAt: new Date(0).toISOString(),
              state: "failed",
              code: "rate_limited",
              message: "Try again.",
              retryDisposition: { kind: "after-delay", delayMs: 1 },
            });

          sharedFailure = failure;

          return failure;
        }

        return {
          targetIndex: target.targetIndex,
          account: target.account,
          observedAt: new Date(0).toISOString(),
          state: "published",
          post: platformPostRef({ ...target.account, postId: "p-3" }),
        };
      },
    },
  });

  const result = await createSocial({ backend: adapter }).posts.publish(request, {
    retry: { maxAttempts: 3 },
  });

  assert.equal(calls, 3);
  assert.equal(result.outcomes[0]?.state, "published");
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
