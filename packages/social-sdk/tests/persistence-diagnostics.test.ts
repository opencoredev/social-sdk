import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  connectedAccountRef,
  createSocial,
  type DeliveryOutcome,
  type IdempotencyClaim,
  type IdempotencyClaimInput,
  type IdempotencyStore,
  type PersistenceDiagnostic,
  type PublishWarning,
} from "../src/index.js";
import { MemoryIdempotencyStore, mockBackend } from "../src/testing/index.js";

const secret = "storage-secret-dsn://user:pa55@db.internal/claims";

const targets = [
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
];

/** Fails `saveOutcome` for chosen target indexes, either before or after writing. */
class FlakyIdempotencyStore implements IdempotencyStore {
  readonly inner = new MemoryIdempotencyStore();
  readonly claimIds: string[] = [];
  readonly targetKeys: string[] = [];
  saves = 0;

  constructor(
    private readonly failing: ReadonlySet<number>,
    private readonly timing: "before-write" | "after-write",
  ) {}

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaim> {
    const claim = await this.inner.claim(input);

    if (claim.kind !== "conflict") this.claimIds.push(claim.claimId);
    this.targetKeys.push(...input.targetKeys);

    return claim;
  }

  async saveOutcome(input: {
    readonly claimId: string;
    readonly targetKey: string;
    readonly outcome: DeliveryOutcome;
  }): Promise<void> {
    this.saves++;

    if (!this.failing.has(input.outcome.targetIndex)) return this.inner.saveOutcome(input);

    if (this.timing === "after-write") await this.inner.saveOutcome(input);

    throw new Error(`write failed for ${input.claimId} ${input.targetKey} ${secret}`);
  }
}

function assertSanitized(
  value: readonly (PersistenceDiagnostic | PublishWarning)[],
  store: FlakyIdempotencyStore,
): void {
  const text = JSON.stringify(value);

  assert.ok(!text.includes(secret));
  assert.ok(!text.includes("mock-account"));

  for (const claimId of store.claimIds) assert.ok(!text.includes(claimId));

  for (const targetKey of store.targetKeys) assert.ok(!text.includes(targetKey));
}

describe("idempotency persistence diagnostics", () => {
  test("keeps every destination outcome and reports a warning when a save fails before writing", async () => {
    const mock = mockBackend({ scenario: "mixed-success-failure" });
    const store = new FlakyIdempotencyStore(new Set([0, 1]), "before-write");
    const diagnostics: PersistenceDiagnostic[] = [];

    const social = createSocial({
      backend: mock,
      idempotencyStore: store,
      onPersistenceDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });

    const result = await social.posts.publish({
      idempotencyKey: "launch-1",
      targets,
      content: { text: "hello" },
    });

    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.state),
      ["published", "failed"],
    );
    assert.equal(result.status, "partial");
    assert.deepEqual(result.warnings, [
      { code: "idempotency-outcome-not-persisted", targetIndex: 0 },
      { code: "idempotency-outcome-not-persisted", targetIndex: 1 },
    ]);
    assert.deepEqual(
      [...diagnostics].sort((left, right) => left.targetIndex - right.targetIndex),
      [
        { code: "idempotency-outcome-not-persisted", operation: "posts.publish", targetIndex: 0 },
        { code: "idempotency-outcome-not-persisted", operation: "posts.publish", targetIndex: 1 },
      ],
    );
    assertSanitized(diagnostics, store);
    assertSanitized(result.warnings ?? [], store);
    assert.equal(store.saves, 2);
    assert.equal(
      mock.testing.history().filter((entry) => entry.operation === "posts.publishTarget").length,
      2,
    );
  });

  test("warns when the store wrote the outcome but then failed, and a retry replays without dispatch", async () => {
    const mock = mockBackend();
    const store = new FlakyIdempotencyStore(new Set([1]), "after-write");
    const diagnostics: PersistenceDiagnostic[] = [];

    const social = createSocial({
      backend: mock,
      idempotencyStore: store,
      onPersistenceDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });

    const request = { idempotencyKey: "launch-2", targets, content: { text: "hello" } };
    const first = await social.posts.publish(request);

    assert.deepEqual(first.warnings, [
      { code: "idempotency-outcome-not-persisted", targetIndex: 1 },
    ]);
    assert.deepEqual(diagnostics, [
      { code: "idempotency-outcome-not-persisted", operation: "posts.publish", targetIndex: 1 },
    ]);

    const replay = await social.posts.publish(request);

    assert.deepEqual(replay.outcomes, first.outcomes);
    assert.equal("warnings" in replay, false);
    assert.equal(
      mock.testing.history().filter((entry) => entry.operation === "posts.publishTarget").length,
      2,
    );
  });

  test("a throwing diagnostic callback does not change the result or cause another write", async () => {
    const mock = mockBackend();
    const store = new FlakyIdempotencyStore(new Set([0]), "before-write");
    let calls = 0;

    const social = createSocial({
      backend: mock,
      idempotencyStore: store,
      onPersistenceDiagnostic: async () => {
        calls++;
        throw new Error("sink offline");
      },
    });

    const request = { idempotencyKey: "launch-3", targets, content: { text: "hello" } };
    const result = await social.posts.publish(request);

    assert.equal(result.status, "complete");
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.state),
      ["published", "published"],
    );
    assert.deepEqual(result.warnings, [
      { code: "idempotency-outcome-not-persisted", targetIndex: 0 },
    ]);
    assert.equal(calls, 1);
    assert.equal(store.saves, 2);

    // The unsaved target replays as unknown instead of being dispatched again.
    const replay = await social.posts.publish(request);

    assert.equal(replay.outcomes[0]?.state, "unknown");
    assert.equal(replay.outcomes[1]?.state, "published");
    assert.equal(
      mock.testing.history().filter((entry) => entry.operation === "posts.publishTarget").length,
      2,
    );
    assert.equal(store.saves, 2);
  });

  test("reports the warning on the result even without a callback", async () => {
    const store = new FlakyIdempotencyStore(new Set([1]), "before-write");
    const social = createSocial({ backend: mockBackend(), idempotencyStore: store });

    const result = await social.posts.publish({
      idempotencyKey: "launch-4",
      targets,
      content: { text: "hello" },
    });

    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.state),
      ["published", "published"],
    );
    assert.deepEqual(result.warnings, [
      { code: "idempotency-outcome-not-persisted", targetIndex: 1 },
    ]);
    assertSanitized(result.warnings ?? [], store);
  });

  test("omits warnings when every outcome is saved", async () => {
    let calls = 0;

    const social = createSocial({
      backend: mockBackend(),
      idempotencyStore: new MemoryIdempotencyStore(),
      onPersistenceDiagnostic: () => {
        calls++;
      },
    });

    const result = await social.posts.publish({
      idempotencyKey: "launch-5",
      targets,
      content: { text: "hello" },
    });

    assert.equal("warnings" in result, false);
    assert.equal(calls, 0);
  });
});
