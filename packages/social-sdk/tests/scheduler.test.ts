import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as root from "../src/index.js";
import * as server from "../src/server/index.js";
import {
  SocialError,
  connectedAccountRef,
  createSocial,
  type CapabilityManifest,
  type PublishRequest,
  type SocialAdapter,
} from "../src/index.js";
import {
  MemoryKeyValueStore,
  MemoryScheduleStore,
  SocialScheduler,
  createKeyValueIdempotencyStore,
  createKeyValueScheduleStore,
  resolveLocalTime,
  scheduledOutcomes,
  type ScheduledJob,
  outcomeRecovery,
} from "../src/server/index.js";
import { definedFields } from "../src/core/fields.js";
import { MemoryIdempotencyStore, mockBackend } from "../src/testing/index.js";

const start = new Date("2026-03-01T10:00:00.000Z");

const xAccount = connectedAccountRef({
  backend: "default",
  platform: "x",
  accountId: "mock-account-1",
});

const threadsAccount = connectedAccountRef({
  backend: "default",
  platform: "threads",
  accountId: "mock-account-2",
});

function withCapabilities<A extends SocialAdapter<unknown>>(
  adapter: A,
  extra: CapabilityManifest["capabilities"],
): A {
  return {
    ...adapter,
    capabilities: {
      ...adapter.capabilities,
      capabilities: [...extra, ...adapter.capabilities.capabilities],
    },
  };
}

function harness(
  options: {
    readonly native?: boolean;
    readonly authorization?: root.AuthorizationPolicy;
    readonly idempotencyStore?: root.IdempotencyStore;
  } = {},
) {
  let now = start;
  const clock = () => now;
  const mock = mockBackend({ clock });

  const backend = options.native
    ? withCapabilities(mock, [
        { operation: "posts.schedule", platform: "x", availability: "available" },
      ])
    : mock;

  const social = createSocial({
    recovery: outcomeRecovery(),
    backend,
    idempotencyStore: options.idempotencyStore ?? new MemoryIdempotencyStore(),
    clock,
    ...definedFields({ authorization: options.authorization }),
  });

  const store = new MemoryScheduleStore();

  const scheduler = new SocialScheduler({
    social,
    store,
    clock,
    pollIntervalMs: 60_000,
    ownerId: "runner-a",
  });

  return {
    mock,
    social,
    store,
    scheduler,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);

      return now;
    },
    publishes: () =>
      mock.testing.history().filter((entry) => entry.operation === "posts.publishTarget"),
  };
}

function publication(key: string, ...accounts: root.ConnectedAccountRef[]): PublishRequest {
  return {
    targets: accounts.map((account) => ({ account })),
    content: { text: "Launch notes" },
    idempotencyKey: key,
  };
}

const inOneHour = { kind: "instant" as const, at: "2026-03-01T11:00:00Z" };

test("scheduler reads and mutations authorize the current caller before changing state", async () => {
  const h = harness({
    authorization: {
      async authorizeTargets({ accounts, context }) {
        return accounts.map((account) => ({
          account,
          allowed: context.authorization?.principalId === "owner",
        }));
      },
    },
  });

  const owner = { authorization: { tenantId: "tenant", principalId: "owner" } };
  const denied = { authorization: { tenantId: "tenant", principalId: "denied" } };

  const job = await h.scheduler.schedule({
    work: { kind: "publish", request: publication("authorized", xAccount) },
    at: inOneHour,
    ...owner,
  });

  for (const action of [
    () => h.scheduler.get(job.id, denied),
    () => h.scheduler.cancel(job.id, denied),
    () => h.scheduler.reschedule(job.id, inOneHour, denied),
    () => h.scheduler.reconcile(job.id, denied),
    () => h.scheduler.retryFailed(job.id, denied),
  ])
    await assert.rejects(
      action,
      (error: unknown): error is SocialError =>
        error instanceof SocialError && error.code === "unauthorized",
    );

  assert.equal((await h.scheduler.get(job.id, owner))?.status, "scheduled");
  assert.equal(h.publishes().length, 0);
});

test("reconcile by a delivery reader only polls, and retryFailed authorizes what it sends", async () => {
  const grants = new Map([
    ["owner", ["posts.read", "posts.getDelivery", "posts.publish", "posts.schedule"]],
    ["reader", ["posts.read", "posts.getDelivery"]],
    ["publisher", ["posts.read", "posts.getDelivery", "posts.publish"]],
  ]);

  const h = harness({
    native: true,
    authorization: {
      async authorizeTargets({ operation, accounts, context }) {
        const allowed = grants.get(context.authorization?.principalId ?? "") ?? [];

        return accounts.map((account) => ({ account, allowed: allowed.includes(operation) }));
      },
    },
  });

  const as = (principalId: string) => ({ authorization: { tenantId: "tenant", principalId } });

  const job = await h.scheduler.schedule({
    work: { kind: "publish", request: publication("read-only", threadsAccount) },
    at: inOneHour,
    ...as("owner"),
  });

  h.advance(3_600_000);
  const polled = await h.scheduler.reconcile(job.id, as("reader"));
  assert.equal(h.publishes().length, 0, "a reader's reconcile never publishes a due job");
  assert.equal(polled?.lanes[0]?.steps[0]?.state, "pending");

  const native = await h.scheduler.schedule({
    work: { kind: "publish", request: publication("native-retry", xAccount) },
    at: { kind: "instant", at: "2026-03-01T13:00:00Z" },
    ...as("owner"),
  });

  for (const principal of ["reader", "publisher"])
    await assert.rejects(
      h.scheduler.retryFailed(native.id, as(principal)),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && error.code === "unauthorized",
    );

  assert.equal(h.publishes().length, 0);

  // The creator's own reconcile still advances the due job.
  assert.equal((await h.scheduler.reconcile(job.id, as("owner")))?.status, "completed");
  assert.equal(h.publishes().length, 1);
});

test("the scheduler inherits JobRunner from createSocial configuration", async () => {
  const hints: string[] = [];

  const social = createSocial({
    recovery: outcomeRecovery(),
    backend: mockBackend({ clock: () => start }),
    idempotencyStore: new MemoryIdempotencyStore(),
    clock: () => start,
    jobRunner: {
      async enqueue(input) {
        hints.push(input.type);

        return { jobId: "hint" };
      },
      cancel: async () => true,
    },
  });

  const scheduler = new SocialScheduler({
    social,
    store: new MemoryScheduleStore(),
    clock: () => start,
  });

  await scheduler.schedule({
    work: { kind: "publish", request: publication("runner", xAccount) },
    at: inOneHour,
  });
  assert.deepEqual(hints, ["social-sdk.schedule.run-due"]);
});

test("an overlapping run on the same instance after lease expiry cannot resend or overwrite", async () => {
  const h = harness();
  const posts = h.mock.posts;
  assert.ok(posts !== undefined);
  const publishTarget = posts.publishTarget.bind(posts);
  let release: () => void = () => {};

  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered: () => void = () => {};

  const sending = new Promise<void>((resolve) => (entered = resolve));

  posts.publishTarget = async (target, context) => {
    entered();
    await gate;

    return publishTarget(target, context);
  };

  const job = await h.scheduler.schedule({
    work: { kind: "publish", request: publication("overlap", xAccount) },
    at: inOneHour,
  });

  const due = new Date("2026-03-01T11:00:00.000Z");
  const slow = h.scheduler.runDue({ now: due });
  await sending;

  // The same instance runs again after the first claim's lease has expired.
  const expired = new Date(due.getTime() + 300_001);
  const second = await h.scheduler.runDue({ now: expired });
  assert.equal(second.claimed, 1);
  const recovered = (await h.scheduler.get(job.id))?.lanes[0]?.steps[0];
  assert.equal(
    recovered?.state === "dispatched" ? recovered.outcomes[0]?.state : undefined,
    "unknown",
  );

  release();
  await slow;
  assert.equal(h.publishes().length, 1, "the step is sent once");

  // The first run's late result is not written over the new claim, but it is in the
  // idempotency claim, so reconciliation recovers it.
  const after = (await h.scheduler.get(job.id))?.lanes[0]?.steps[0];
  assert.equal(after?.state === "dispatched" ? after.outcomes[0]?.state : undefined, "unknown");
  const reconciled = await h.scheduler.reconcile(job.id);
  const step = reconciled?.lanes[0]?.steps[0];
  assert.equal(step?.state === "dispatched" ? step.outcomes[0]?.state : undefined, "published");
  assert.equal(h.publishes().length, 1);
});

test("provider cancellations act with the current caller's context", async () => {
  const seen: { operation: string; principalId: string | undefined }[] = [];

  const h = harness({
    native: true,
    authorization: {
      async authorizeTargets({ operation, accounts, context }) {
        seen.push({ operation, principalId: context.authorization?.principalId });

        return accounts.map((account) => ({ account, allowed: true }));
      },
    },
  });

  const job = await h.scheduler.schedule({
    work: { kind: "publish", request: publication("caller-cancel", xAccount) },
    at: inOneHour,
    authorization: { tenantId: "tenant", principalId: "author" },
  });

  await h.scheduler.runDue();
  seen.length = 0;

  const result = await h.scheduler.cancel(job.id, {
    authorization: { tenantId: "tenant", principalId: "operator" },
  });

  assert.equal(result.state, "cancelled");
  assert.deepEqual(
    seen.filter((entry) => entry.operation === "posts.cancelScheduled"),
    [
      { operation: "posts.cancelScheduled", principalId: "operator" },
      { operation: "posts.cancelScheduled", principalId: "operator" },
    ],
  );
});

describe("SocialScheduler", () => {
  test("stores work, dispatches it once when due, and records per-destination outcomes", async () => {
    const h = harness();

    const job = await h.scheduler.schedule({
      work: { kind: "publish", request: publication("launch", xAccount, threadsAccount) },
      at: inOneHour,
    });

    assert.equal(job.status, "scheduled");
    assert.equal((await h.scheduler.runDue()).claimed, 0);
    assert.equal(h.publishes().length, 0);

    h.advance(3_600_000);
    const run = await h.scheduler.runDue();
    assert.equal(run.claimed, 1);
    assert.equal(run.jobs[0]?.status, "completed");
    assert.equal(h.publishes().length, 2);

    const saved = await h.scheduler.get(job.id);
    assert.ok(saved !== undefined);
    const [item] = scheduledOutcomes(saved);
    assert.deepEqual(
      item?.outcomes.map((outcome) => [outcome.targetIndex, outcome.state]),
      [
        [0, "published"],
        [1, "published"],
      ],
    );

    h.advance(3_600_000);
    assert.equal((await h.scheduler.runDue()).claimed, 0);
    assert.equal(h.publishes().length, 2);
  });

  test("concurrent runners claim a due job once", async () => {
    const h = harness();

    const other = new SocialScheduler({
      social: h.social,
      store: h.store,
      clock: () => new Date("2026-03-01T11:00:00Z"),
      ownerId: "runner-b",
    });

    await h.scheduler.schedule({
      work: { kind: "publish", request: publication("race", xAccount) },
      at: inOneHour,
    });
    h.advance(3_600_000);

    const [left, right] = await Promise.all([
      h.scheduler.runDue({ limit: 5, concurrency: 2 }),
      other.runDue(),
    ]);

    assert.equal(left.claimed + right.claimed, 1);
    assert.equal(h.publishes().length, 1);
  });

  test("cancel before dispatch prevents any write", async () => {
    const h = harness();

    const job = await h.scheduler.schedule({
      work: { kind: "publish", request: publication("cancel", xAccount) },
      at: inOneHour,
    });

    const result = await h.scheduler.cancel(job.id);
    assert.equal(result.state, "cancelled");

    h.advance(7_200_000);
    await h.scheduler.runDue();
    assert.equal(h.publishes().length, 0);
    assert.equal((await h.scheduler.get(job.id))?.status, "cancelled");
  });

  test("reschedule moves pending work", async () => {
    const h = harness();

    const job = await h.scheduler.schedule({
      work: { kind: "publish", request: publication("move", xAccount) },
      at: inOneHour,
    });

    const moved = await h.scheduler.reschedule(job.id, {
      kind: "instant",
      at: "2026-03-01T13:00:00+01:00",
    });

    assert.equal(moved.state, "rescheduled");
    assert.equal(moved.state === "rescheduled" ? moved.job.runAt : "", "2026-03-01T12:00:00.000Z");

    h.advance(3_600_000);
    await h.scheduler.runDue();
    assert.equal(h.publishes().length, 0);

    h.advance(3_600_000);
    await h.scheduler.runDue();
    assert.equal(h.publishes().length, 1);
  });

  test("routes that declare native scheduling are submitted early; others wait for runtime dispatch", async () => {
    const h = harness({ native: true });

    const job = await h.scheduler.schedule({
      work: { kind: "publish", request: publication("native", xAccount, threadsAccount) },
      at: inOneHour,
    });

    assert.deepEqual(
      job.lanes.map((lane) => [lane.id, lane.steps[0]?.targetIndexes]),
      [
        ["native", [0]],
        ["runtime", [1]],
      ],
    );

    await h.scheduler.runDue();
    assert.equal(h.publishes().length, 1, "only the native route is sent before the time");
    const early = await h.scheduler.get(job.id);
    assert.equal(early?.status, "scheduled");
    assert.equal(
      early === undefined ? undefined : scheduledOutcomes(early)[0]?.outcomes[0]?.state,
      "scheduled",
    );

    h.advance(3_600_000);
    await h.scheduler.runDue();
    assert.equal(h.publishes().length, 2);
  });

  test("preferNativeSchedule false and undeclared routes never submit early", async () => {
    const native = harness({ native: true });
    await native.scheduler.schedule({
      work: { kind: "publish", request: publication("runtime-only", xAccount) },
      at: inOneHour,
      preferNativeSchedule: false,
    });
    await native.scheduler.runDue();
    assert.equal(native.publishes().length, 0);

    // The plain mock does not declare posts.schedule, so preferring native cannot force it.
    const plain = harness();

    const job = await plain.scheduler.schedule({
      work: { kind: "publish", request: publication("plain", xAccount) },
      at: inOneHour,
    });

    assert.deepEqual(
      job.lanes.map((lane) => lane.mode),
      ["runtime"],
    );
    await plain.scheduler.runDue();
    assert.equal(plain.publishes().length, 0);
  });

  test("cancelling native work requires provider confirmation", async () => {
    const h = harness({ native: true });

    const job = await h.scheduler.schedule({
      work: { kind: "publish", request: publication("native-cancel", xAccount) },
      at: inOneHour,
    });

    await h.scheduler.runDue();
    const result = await h.scheduler.cancel(job.id);
    assert.equal(result.state, "cancelled");
    assert.equal(
      h.mock.testing.history().filter((entry) => entry.operation === "posts.cancelScheduled")
        .length,
      1,
    );
  });

  test("a cancellation that overtakes a reschedule cannot reactivate the job", async () => {
    const h = harness({ native: true });
    const posts = h.mock.posts;
    assert.ok(posts !== undefined);
    let release = () => {};

    let entered = () => {};

    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });

    let calls = 0;

    posts.cancelScheduled = async () => {
      if (calls++ === 0) {
        entered();
        await resumed;
      }

      return { state: "cancelled", backendRecord: "retained" };
    };

    const job = await h.scheduler.schedule({
      work: { kind: "publish", request: publication("cancel-move", xAccount) },
      at: inOneHour,
    });

    await h.scheduler.runDue();
    const moving = h.scheduler.reschedule(job.id, { kind: "instant", at: "2026-03-01T12:00:00Z" });
    await paused;

    try {
      assert.equal((await h.scheduler.cancel(job.id)).state, "cancelled");
    } finally {
      release();
    }

    assert.equal((await moving).state, "not-reschedulable");
    assert.equal((await h.scheduler.get(job.id))?.status, "cancelled");
    h.advance(10_800_000);
    assert.equal((await h.scheduler.runDue()).claimed, 0);
    assert.equal(h.publishes().length, 1);
  });

  test("an uncertain native cancellation is reported and reschedule creates no second copy", async () => {
    const h = harness({ native: true });
    const posts = h.mock.posts;
    assert.ok(posts !== undefined);

    posts.cancelScheduled = async () => {
      throw new SocialError({
        code: "ambiguous_outcome",
        operation: "posts.cancelScheduled",
        message: "lost",
      });
    };

    const job = await h.scheduler.schedule({
      work: { kind: "publish", request: publication("uncertain", xAccount) },
      at: inOneHour,
    });

    await h.scheduler.runDue();
    assert.equal(h.publishes().length, 1);

    const moved = await h.scheduler.reschedule(job.id, {
      kind: "instant",
      at: "2026-03-01T15:00:00Z",
    });

    assert.equal(moved.state, "unresolved");
    assert.deepEqual(moved.state === "unresolved" ? moved.unresolved : [], [
      { itemIndex: 0, targetIndex: 0, reason: "cancel-failed" },
    ]);
    assert.equal((await h.scheduler.get(job.id))?.status, "cancel-unresolved");

    h.advance(6 * 3_600_000);
    await h.scheduler.runDue();
    assert.equal(h.publishes().length, 1);
  });

  test("rejects media that cannot be stored", async () => {
    const h = harness();

    await assert.rejects(
      h.scheduler.schedule({
        work: {
          kind: "publish",
          request: {
            ...publication("blob", xAccount),
            content: {
              media: [
                {
                  kind: "image",
                  source: { kind: "blob", blob: new Blob(["x"]), fingerprint: "sha" },
                },
              ],
            },
          },
        },
        at: inOneHour,
      }),
      (error: unknown): error is SocialError =>
        error instanceof SocialError &&
        error.code === "invalid_input" &&
        /Blob and stream/.test(error.message),
    );

    await assert.rejects(
      h.scheduler.schedule({
        work: {
          kind: "publish",
          request: {
            ...publication("stream", xAccount),
            content: {
              media: [
                {
                  kind: "video",
                  source: { kind: "stream", open: () => new ReadableStream(), fingerprint: "sha" },
                },
              ],
            },
          },
        },
        at: inOneHour,
      }),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && error.code === "invalid_input",
    );
  });

  test("local times reject daylight-saving gaps and require a choice for repeated times", async () => {
    assert.deepEqual(
      resolveLocalTime({ date: "2026-03-08", time: "02:30", timeZone: "America/New_York" }),
      {
        kind: "nonexistent",
      },
    );
    assert.deepEqual(
      resolveLocalTime({ date: "2026-11-01", time: "01:30", timeZone: "America/New_York" }),
      {
        kind: "ambiguous",
        earlier: "2026-11-01T05:30:00.000Z",
        later: "2026-11-01T06:30:00.000Z",
      },
    );

    const h = harness();
    const request = publication("local", xAccount);

    await assert.rejects(
      h.scheduler.schedule({
        work: { kind: "publish", request },
        at: { kind: "local", date: "2026-03-08", time: "02:30", timeZone: "America/New_York" },
      }),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && /does not exist/.test(error.message),
    );

    await assert.rejects(
      h.scheduler.schedule({
        work: { kind: "publish", request },
        at: { kind: "local", date: "2026-11-01", time: "01:30", timeZone: "America/New_York" },
      }),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && /occurs twice/.test(error.message),
    );

    const later = await h.scheduler.schedule({
      work: { kind: "publish", request },
      at: {
        kind: "local",
        date: "2026-11-01",
        time: "01:30",
        timeZone: "America/New_York",
        ambiguous: "later",
      },
    });

    assert.equal(later.runAt, "2026-11-01T06:30:00.000Z");
    assert.equal(later.timeZone, "America/New_York");

    await assert.rejects(
      h.scheduler.schedule({
        work: { kind: "publish", request: publication("naive", xAccount) },
        at: { kind: "instant", at: "2026-03-01T12:00:00" },
      }),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && /explicit UTC offset/.test(error.message),
    );
  });

  test("queue slots skip nonexistent wall times and never double-book", async () => {
    const h = harness();

    const queue = {
      kind: "queue" as const,
      queueId: "daily",
      timeZone: "America/New_York",
      slots: [{ time: "02:30" }],
      notBefore: "2026-03-07T12:00:00Z",
    };

    const first = await h.scheduler.schedule({
      work: { kind: "publish", request: publication("q1", xAccount) },
      at: queue,
    });

    const second = await h.scheduler.schedule({
      work: { kind: "publish", request: publication("q2", xAccount) },
      at: queue,
    });

    // 2026-03-08 02:30 does not exist in New York, so the queue moves to the next day.
    assert.equal(first.runAt, "2026-03-09T06:30:00.000Z");
    assert.equal(second.runAt, "2026-03-10T06:30:00.000Z");

    await h.scheduler.cancel(first.id);

    const third = await h.scheduler.schedule({
      work: { kind: "publish", request: publication("q3", xAccount) },
      at: queue,
    });

    assert.equal(third.runAt, "2026-03-09T06:30:00.000Z", "a cancelled job frees its slot");

    await assert.rejects(
      h.scheduler.schedule({
        work: { kind: "publish", request: publication("q4", xAccount) },
        at: { ...queue, slots: [{ time: "09:00" }, { time: "09:00", weekdays: [1] }] },
      }),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && /listed twice/.test(error.message),
    );
  });

  test("lookups and mutations are scoped to the tenant", async () => {
    const h = harness();
    const t1 = { authorization: { tenantId: "t1" } };

    const job = await h.scheduler.schedule({
      work: { kind: "publish", request: publication("tenant", xAccount) },
      at: inOneHour,
      ...t1,
    });

    assert.equal(await h.scheduler.get(job.id, { authorization: { tenantId: "t2" } }), undefined);
    assert.equal(
      (await h.scheduler.cancel(job.id, { authorization: { tenantId: "t2" } })).state,
      "not-found",
    );
    assert.equal((await h.scheduler.get(job.id, t1))?.status, "scheduled");
  });

  test("execution reauthorizes with the stored context", async () => {
    let allowed = true;

    const h = harness({
      authorization: {
        async authorizeTargets({ accounts }) {
          return accounts.map((account) => ({ account, allowed }));
        },
      },
    });

    await assert.rejects(
      (() => {
        allowed = false;

        return h.scheduler.schedule({
          work: { kind: "publish", request: publication("denied", xAccount) },
          at: inOneHour,
        });
      })(),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && error.code === "unauthorized",
    );

    allowed = true;

    const job = await h.scheduler.schedule({
      work: { kind: "publish", request: publication("revoked", xAccount) },
      at: inOneHour,
      authorization: { tenantId: "t1" },
    });

    allowed = false;
    h.advance(3_600_000);
    await h.scheduler.runDue();
    assert.equal(h.publishes().length, 0);

    // Execution preflight reauthorizes every step before the first one is sent.
    await assert.rejects(
      h.scheduler.get(job.id, { authorization: { tenantId: "t1" } }),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && error.code === "unauthorized",
    );
    const saved = (await h.store.get({ scope: "t1", id: job.id }))?.job;
    assert.equal(saved?.status, "blocked");
    assert.equal(saved?.blocked?.code, "unauthorized");
    assert.deepEqual(saved === undefined ? undefined : scheduledOutcomes(saved), []);

    // Once access is restored, an explicit retry sends the never-submitted destination.
    allowed = true;
    const retried = await h.scheduler.retryFailed(job.id, { authorization: { tenantId: "t1" } });
    assert.equal(retried?.status, "completed");
    assert.equal(h.publishes().length, 1);
  });

  test("a step left dispatching is recovered from its claim and never sent again", async () => {
    const inner = new MemoryIdempotencyStore();
    let failClaims = 1;

    // The claim is written, then the process dies before the adapter is called.
    const idempotencyStore: root.IdempotencyStore = {
      async claim(input) {
        const claim = await inner.claim(input);

        if (failClaims-- > 0) throw new Error("process crashed");

        return claim;
      },
      saveOutcome: (input) => inner.saveOutcome(input),
      compareAndSetOutcome: (input) => inner.compareAndSetOutcome(input),
    };

    const h = harness({ idempotencyStore });

    const job = await h.scheduler.schedule({
      work: { kind: "publish", request: publication("crash", xAccount) },
      at: inOneHour,
    });

    h.advance(3_600_000);
    await assert.rejects(h.scheduler.runDue(), /process crashed/);
    assert.equal((await h.scheduler.get(job.id))?.lanes[0]?.steps[0]?.state, "dispatching");

    h.advance(120_000);
    await h.scheduler.runDue();
    assert.equal(h.publishes().length, 0);

    const saved = await h.scheduler.get(job.id);
    const step = saved?.lanes[0]?.steps[0];
    assert.equal(step?.state, "dispatched");
    assert.equal(step?.state === "dispatched" ? step.outcomes[0]?.state : undefined, "unknown");

    // Retrying unknown outcomes is refused: it could publish twice.
    await h.scheduler.retryFailed(job.id);
    assert.equal(h.publishes().length, 0);
  });

  test("wake hints are enqueued but the store stays authoritative", async () => {
    const hints: { type: string; runAt: string }[] = [];
    const h = harness();

    const scheduler = new SocialScheduler({
      social: h.social,
      store: h.store,
      clock: () => start,
      jobRunner: {
        async enqueue(input) {
          hints.push({ type: input.type, runAt: input.runAt });

          return { jobId: `hint-${hints.length}` };
        },
        cancel: async () => true,
      },
    });

    await scheduler.schedule({
      work: { kind: "publish", request: publication("hint", xAccount) },
      at: inOneHour,
    });
    assert.deepEqual(hints, [
      { type: "social-sdk.schedule.run-due", runAt: "2026-03-01T11:00:00.000Z" },
    ]);
  });
});

describe("key-value schedule store", () => {
  function sampleJob(id: string): ScheduledJob {
    return {
      version: 1,
      id,
      scope: "t1",
      status: "scheduled",
      runAt: "2026-03-01T11:00:00.000Z",
      nextRunAt: "2026-03-01T11:00:00.000Z",
      work: { kind: "publish", request: publication(id, xAccount) },
      lanes: [
        {
          id: "runtime",
          mode: "runtime",
          chained: false,
          revision: 0,
          steps: [{ itemIndex: 0, targetIndexes: [0], state: "pending" }],
        },
      ],
      createdAt: start.toISOString(),
      updatedAt: start.toISOString(),
    };
  }

  test("uses compare-and-set revisions and lists only due, unleased jobs", async () => {
    const store = createKeyValueScheduleStore(new MemoryKeyValueStore());
    const created = await store.create(sampleJob("a"));
    assert.equal(created.created, true);
    assert.equal((await store.create(sampleJob("a"))).created, false);

    const stored = await store.get({ scope: "t1", id: "a" });
    assert.ok(stored !== undefined);
    assert.deepEqual(stored.job, sampleJob("a"));
    assert.deepEqual(await store.listDue({ now: "2026-03-01T10:59:59.000Z", limit: 10 }), []);
    assert.equal((await store.listDue({ now: "2026-03-01T11:00:00.000Z", limit: 10 })).length, 1);

    const leased = await store.compareAndSet({
      expectedRevision: stored.revision,
      job: { ...stored.job, lease: { owner: "r", until: "2026-03-01T11:05:00.000Z" } },
    });

    assert.equal(leased.updated, true);
    assert.equal(
      (await store.compareAndSet({ expectedRevision: stored.revision, job: stored.job })).updated,
      false,
    );
    assert.equal((await store.listDue({ now: "2026-03-01T11:01:00.000Z", limit: 10 })).length, 0);
    assert.equal((await store.listDue({ now: "2026-03-01T11:06:00.000Z", limit: 10 })).length, 1);
  });

  test("a bounded KV scan fails explicitly instead of silently omitting due jobs", async () => {
    const store = createKeyValueScheduleStore(new MemoryKeyValueStore(), { maxScanEntries: 1 });
    await store.create(sampleJob("first"));
    await store.create(sampleJob("second"));
    await assert.rejects(
      store.listDue({ now: "2026-03-01T12:00:00.000Z", limit: 10 }),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && error.code === "rate_limited",
    );
  });

  test("an uncertain cancellation keeps its queue slot occupied until confirmed", async () => {
    const store = new MemoryScheduleStore();

    const job: ScheduledJob = {
      ...sampleJob("holder"),
      queueId: "daily",
      status: "cancel-unresolved",
    };

    await store.create(job);
    const slot = { scope: job.scope, queueId: "daily", at: job.runAt };
    assert.equal(await store.reserveSlot({ ...slot, jobId: job.id }), true);
    assert.equal(await store.reserveSlot({ ...slot, jobId: "other" }), false);
    const saved = await store.get({ scope: job.scope, id: job.id });
    assert.ok(saved !== undefined);
    await store.compareAndSet({
      expectedRevision: saved.revision,
      job: { ...job, status: "cancelled" },
    });
    assert.equal(await store.reserveSlot({ ...slot, jobId: "other" }), true);
  });

  test("rejects a corrupted stored record without trusting it", async () => {
    const kv = new MemoryKeyValueStore();
    const store = createKeyValueScheduleStore(kv);
    await store.create(sampleJob("bad"));
    const [entry] = await kv.list({ prefix: "schedule/job/", limit: 1 });
    assert.ok(entry !== undefined);

    await kv.compareAndSet({
      key: entry.key,
      expectedVersion: entry.version,
      value: entry.value
        .replace('"kind":"https-url"', '"kind":"blob"')
        .replace('"status":"scheduled"', '"status":"exploded"'),
    });

    await assert.rejects(
      store.get({ scope: "t1", id: "bad" }),
      (error: unknown): error is SocialError =>
        error instanceof SocialError &&
        error.code === "upstream_failure" &&
        /status/.test(error.message),
    );
  });

  test("the key-value idempotency store supports recovery across client instances", async () => {
    const kv = new MemoryKeyValueStore();
    const mock = mockBackend({ scenario: "media-processing-then-success" });
    const request = publication("kv-claim", xAccount);

    const first = createSocial({
      recovery: outcomeRecovery(),
      backend: mock,
      idempotencyStore: createKeyValueIdempotencyStore(kv),
    });

    assert.equal((await first.posts.publish(request)).outcomes[0]?.state, "processing");

    mock.testing.advanceProcessing();

    const second = createSocial({
      recovery: outcomeRecovery(),
      backend: mock,
      idempotencyStore: createKeyValueIdempotencyStore(kv),
    });

    const result = await second.posts.reconcile(request);
    assert.equal(result.outcomes[0]?.state, "published");
    assert.equal((await first.posts.publish(request)).outcomes[0]?.state, "published");
  });
});

test("the scheduler ships from /server and stays out of the root entry point", async () => {
  // The root stays small: the scheduler, its stores, and recovery load only from /server.
  for (const name of [
    "SocialScheduler",
    "OutcomeReconciler",
    "MemoryScheduleStore",
    "outcomeRecovery",
  ])
    assert.equal(name in root, false);

  const social = root.createSocial({
    recovery: outcomeRecovery(),
    backend: mockBackend(),
    idempotencyStore: new MemoryIdempotencyStore(),
  });

  const scheduler = new server.SocialScheduler({
    social,
    store: new server.MemoryScheduleStore(),
    clock: () => start,
  });

  const job = await scheduler.schedule({
    work: {
      kind: "sequence",
      request: {
        items: [
          { targets: [{ account: xAccount }], content: { text: "1/ What changed" } },
          { targets: [{ account: xAccount }], content: { text: "2/ Why" } },
        ],
        idempotencyKey: "consumer-thread",
        replyToPrevious: true,
      },
    },
    at: { kind: "local", date: "2026-03-02", time: "09:00", timeZone: "Europe/Berlin" },
  });

  assert.equal(job.runAt, "2026-03-02T08:00:00.000Z");
  const run = await scheduler.runDue({ now: new Date("2026-03-02T08:00:00Z") });
  assert.equal(run.jobs[0]?.status, "completed");
});
