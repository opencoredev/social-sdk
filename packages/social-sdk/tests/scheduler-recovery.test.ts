import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MemoryScheduleStore,
  SocialScheduler,
  connectedAccountRef,
  createSocial,
  scheduledOutcomes,
} from "../src/index.js";
import { MemoryIdempotencyStore, mockBackend } from "../src/testing/index.js";

const at = { kind: "instant", at: "2026-03-01T11:00:00Z" } satisfies Parameters<
  SocialScheduler["schedule"]
>[0]["at"];

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "a" });

test("rescheduling revalidates and clears a previous execution authorization block", async () => {
  let now = new Date("2026-03-01T10:00:00Z");
  let allowed = true;
  const clock = () => now;
  const backend = mockBackend({ clock });
  const store = new MemoryScheduleStore();

  const social = createSocial({
    backend,
    clock,
    idempotencyStore: new MemoryIdempotencyStore(),
    authorization: {
      async authorizeTargets({ operation, accounts }) {
        return accounts.map((target) => ({
          account: target,
          allowed: allowed || operation === "posts.schedule",
        }));
      },
    },
  });

  const scheduler = new SocialScheduler({ social, store, clock });

  const job = await scheduler.schedule({
    work: {
      kind: "publish",
      request: { targets: [{ account }], content: { text: "fixture" }, idempotencyKey: "move" },
    },
    at,
  });

  allowed = false;
  now = new Date(at.at);
  await scheduler.runDue();
  assert.equal((await store.get({ scope: "credential-ready", id: job.id }))?.job.status, "blocked");

  await assert.rejects(
    scheduler.reschedule(job.id, { kind: "instant", at: "2026-03-01T12:00:00Z" }),
    /not authorized/,
  );
  assert.equal((await store.get({ scope: "credential-ready", id: job.id }))?.job.status, "blocked");

  allowed = true;
  const moved = await scheduler.reschedule(job.id, { kind: "instant", at: "2026-03-01T12:00:00Z" });
  assert.equal(moved.state, "rescheduled");
  assert.equal((await scheduler.get(job.id))?.blocked, undefined);
  now = new Date("2026-03-01T12:00:00Z");
  await scheduler.runDue();
  const finished = await scheduler.get(job.id);
  assert.ok(finished !== undefined);
  assert.equal(finished.status, "completed");
  assert.deepEqual(
    scheduledOutcomes(finished).flatMap((item) => item.outcomes.map((outcome) => outcome.state)),
    ["published"],
  );
  assert.equal(
    backend.testing.history().filter((entry) => entry.operation === "posts.publishTarget").length,
    1,
  );
});

test("cancelled in-flight work recovers its durable provider reference without sending pending destinations", async () => {
  const clock = () => new Date("2026-03-01T10:00:00Z");
  const backend = mockBackend({ clock });

  const social = createSocial({
    backend: {
      ...backend,
      capabilities: {
        ...backend.capabilities,
        capabilities: [
          { operation: "posts.schedule", platform: "x", availability: "available" },
          ...backend.capabilities.capabilities,
        ],
      },
    },
    clock,
    idempotencyStore: new MemoryIdempotencyStore(),
  });

  const scheduler = new SocialScheduler({
    social: {
      ...social,
      posts: {
        ...social.posts,
        async publish(request, options) {
          await social.posts.publish(request, options);
          throw new Error("crash after durable outcome save");
        },
      },
    },
    store: new MemoryScheduleStore(),
    clock,
  });

  const job = await scheduler.schedule({
    work: {
      kind: "publish",
      request: {
        targets: [
          { account },
          {
            account: connectedAccountRef({
              backend: "default",
              platform: "threads",
              accountId: "b",
            }),
          },
        ],
        content: { text: "fixture" },
        idempotencyKey: "cancel-crashed",
      },
    },
    at,
  });

  await assert.rejects(scheduler.runDue(), /crash after durable outcome save/);
  assert.equal((await scheduler.cancel(job.id)).state, "unresolved");
  const recovered = await scheduler.reconcile(job.id);
  assert.ok(recovered !== undefined);
  assert.equal(recovered.status, "cancel-unresolved");
  assert.deepEqual(
    scheduledOutcomes(recovered).flatMap((item) => item.outcomes.map((outcome) => outcome.state)),
    ["scheduled"],
  );
  assert.equal((await scheduler.retryFailed(job.id))?.status, "cancel-unresolved");
  assert.equal((await scheduler.cancel(job.id)).state, "cancelled");
  assert.equal(
    backend.testing.history().filter((entry) => entry.operation === "posts.publishTarget").length,
    1,
  );
  assert.equal(
    backend.testing.history().filter((entry) => entry.operation === "posts.cancelScheduled").length,
    1,
  );
});

test("reconciliation preserves a confirmed cancellation when another native destination is unresolved", async () => {
  const clock = () => new Date("2026-03-01T10:00:00Z");
  const backend = mockBackend({ clock });
  const posts = backend.posts;
  assert.ok(posts?.cancelScheduled !== undefined);
  const cancelScheduled = posts.cancelScheduled.bind(posts);
  const attempts = new Map<string, number>();
  posts.cancelScheduled = async (ref, context) => {
    const attempt = (attempts.get(ref.accountId) ?? 0) + 1;
    attempts.set(ref.accountId, attempt);

    if ((ref.accountId === "a" && attempt > 1) || (ref.accountId === "b" && attempt === 1))
      throw new Error("cancellation not confirmed");

    return cancelScheduled(ref, context);
  };

  const { getDelivery: _unavailable, ...unpollablePosts } = posts;

  const social = createSocial({
    backend: {
      ...backend,
      posts: unpollablePosts,
      capabilities: {
        ...backend.capabilities,
        capabilities: [
          { operation: "posts.schedule", platform: "x", availability: "available" },
          ...backend.capabilities.capabilities,
        ],
      },
    },
    clock,
    idempotencyStore: new MemoryIdempotencyStore(),
  });

  const scheduler = new SocialScheduler({ social, store: new MemoryScheduleStore(), clock });

  const job = await scheduler.schedule({
    work: {
      kind: "publish",
      request: {
        targets: [
          { account },
          { account: connectedAccountRef({ backend: "default", platform: "x", accountId: "b" }) },
        ],
        content: { text: "fixture" },
        idempotencyKey: "partial-cancellation",
      },
    },
    at,
  });

  await scheduler.runDue();
  const cancelled = await scheduler.cancel(job.id);
  assert.equal(cancelled.state, "unresolved");
  const reconciled = await scheduler.reconcile(job.id);
  assert.ok(reconciled !== undefined);
  assert.deepEqual(
    scheduledOutcomes(reconciled).flatMap((item) => item.outcomes.map((outcome) => outcome.state)),
    ["cancelled", "scheduled"],
  );
  assert.equal((await scheduler.cancel(job.id)).state, "cancelled");
  assert.deepEqual(
    [...attempts],
    [
      ["a", 1],
      ["b", 2],
    ],
  );
});
