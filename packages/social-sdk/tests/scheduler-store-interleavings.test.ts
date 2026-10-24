import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MemoryKeyValueStore,
  connectedAccountRef,
  createKeyValueScheduleStore,
  type ScheduledJob,
  type VersionedKeyValueStore,
} from "../src/index.js";

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
