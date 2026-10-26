import assert from "node:assert/strict";
import { test } from "node:test";
import { connectedAccountRef, createSocial } from "../src/index.js";
import {
  MemoryKeyValueStore,
  SocialScheduler,
  createKeyValueScheduleStore,
  outcomeRecovery,
  type ScheduledJob,
  type VersionedKeyValueStore,
} from "../src/server/index.js";
import { MemoryIdempotencyStore, mockBackend } from "../src/testing/index.js";

test("a due scan during job creation cannot orphan the scheduled job", async () => {
  const memory = new MemoryKeyValueStore();
  let releaseWrite = () => {};

  let enteredWrite = () => {};

  const paused = new Promise<void>((resolve) => {
    enteredWrite = resolve;
  });

  const resumed = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });

  const kv: VersionedKeyValueStore = {
    get: (key) => memory.get(key),
    list: (input) => memory.list(input),
    delete: (input) => memory.delete(input),
    async compareAndSet(input) {
      if (input.key.startsWith("schedule/job/")) {
        enteredWrite();
        await resumed;
      }

      return memory.compareAndSet(input);
    },
  };

  const store = createKeyValueScheduleStore(kv);
  const now = "2026-10-24T12:00:00.000Z";

  const job: ScheduledJob = {
    version: 1,
    id: "race-job",
    scope: "tenant-a",
    status: "scheduled",
    runAt: now,
    nextRunAt: now,
    createdAt: now,
    updatedAt: now,
    work: {
      kind: "publish",
      request: {
        idempotencyKey: "race-publication",
        content: { text: "scheduled fixture" },
        targets: [
          {
            account: connectedAccountRef({
              backend: "default",
              platform: "x",
              accountId: "fixture-account",
            }),
          },
        ],
      },
    },
    lanes: [
      {
        id: "runtime",
        mode: "runtime",
        chained: false,
        revision: 0,
        steps: [{ itemIndex: 0, targetIndexes: [0], state: "pending" }],
      },
    ],
  };

  const creating = store.create(job);
  await paused;

  try {
    assert.deepEqual(await store.listDue({ now: "2026-10-26T12:00:00.000Z", limit: 10 }), []);
  } finally {
    releaseWrite();
  }

  assert.equal((await creating).created, true);
  assert.equal((await store.get({ scope: job.scope, id: job.id }))?.job.id, job.id);
  assert.deepEqual(
    (await store.listDue({ now, limit: 10 })).map((entry) => entry.job.id),
    [job.id],
  );
});

test("a slot reserved by a reschedule stays held until the job moves into it", async () => {
  const memory = new MemoryKeyValueStore();
  const contested = "schedule/slot/tenant-a/daily/2026-03-03T09:00:00.000Z";
  let pauseOnce = true;
  let releaseMove = () => {};

  let reserved = () => {};

  const paused = new Promise<void>((resolve) => {
    reserved = resolve;
  });

  const resumed = new Promise<void>((resolve) => {
    releaseMove = resolve;
  });

  const kv: VersionedKeyValueStore = {
    get: (key) => memory.get(key),
    list: (input) => memory.list(input),
    delete: (input) => memory.delete(input),
    async compareAndSet(input) {
      const result = await memory.compareAndSet(input);

      // Pause the reschedule after it reserves its new slot and before it saves the move.
      if (pauseOnce && input.key === contested && input.value === "job-a" && result.updated) {
        pauseOnce = false;
        reserved();
        await resumed;
      }

      return result;
    },
  };

  const now = new Date("2026-03-01T10:00:00.000Z");
  const clock = () => now;

  const scheduler = new SocialScheduler({
    social: createSocial({
      recovery: outcomeRecovery(),
      backend: mockBackend({ clock }),
      idempotencyStore: new MemoryIdempotencyStore(),
      clock,
    }),
    store: createKeyValueScheduleStore(kv),
    clock,
  });

  const queue = {
    kind: "queue" as const,
    queueId: "daily",
    timeZone: "UTC",
    slots: [{ time: "09:00" }],
  };

  const work = (key: string) => ({
    kind: "publish" as const,
    request: {
      targets: [
        {
          account: connectedAccountRef({
            backend: "default",
            platform: "x",
            accountId: "mock-account-1",
          }),
        },
      ],
      content: { text: "queued" },
      idempotencyKey: key,
    },
  });

  const authorization = { tenantId: "tenant-a" };

  const first = await scheduler.schedule({
    id: "job-a",
    work: work("a"),
    at: queue,
    authorization,
  });

  assert.equal(first.runAt, "2026-03-02T09:00:00.000Z");

  const moving = scheduler.reschedule("job-a", queue, { authorization });
  await paused;

  const second = await scheduler.schedule({
    id: "job-b",
    work: work("b"),
    at: queue,
    authorization,
  });

  releaseMove();
  const moved = await moving;

  assert.equal(
    moved.state === "rescheduled" ? moved.job.runAt : moved.state,
    "2026-03-03T09:00:00.000Z",
  );
  assert.equal(second.runAt, "2026-03-04T09:00:00.000Z", "the move keeps its reserved slot");
});
