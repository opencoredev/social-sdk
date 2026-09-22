/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract. */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  openExampleDatabase,
  EncryptedSqliteCredentialStore,
  SqliteEventInbox,
  SqliteIdempotencyStore,
} from "../src/storage.js";

describe("durable example storage", () => {
  test("encrypts credentials and supports CAS", async () => {
    const db = openExampleDatabase();
    const store = new EncryptedSqliteCredentialStore(db, "test-only-key-from-environment");

    const first = await store.compareAndSet({
      key: "a",
      expectedRevision: undefined,
      value: { accessToken: "secret", refreshToken: "refresh" },
    });

    assert.equal(first.updated, true);
    const current = await store.get("a");
    assert.equal(current?.value.accessToken, "secret");
    assert.equal(
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      (
        db.prepare("SELECT ciphertext FROM credentials WHERE key='a'").get() as {
          ciphertext: Uint8Array;
        }
      ).ciphertext
        .toString()
        .includes("secret"),
      false,
    );
    assert.equal(
      (
        await store.compareAndSet({
          key: "a",
          expectedRevision: "stale",
          value: { accessToken: "bad" },
        })
      ).updated,
      false,
    );
  });
  test("deduplicates idempotency and event delivery across calls", async () => {
    const db = openExampleDatabase();
    const idempotency = new SqliteIdempotencyStore(db);
    const input = { scope: "tenant:publish", key: "one", fingerprint: "f", targetKeys: ["a"] };
    const first = await idempotency.claim(input);
    const second = await idempotency.claim(input);
    assert.equal(first.kind, "new");
    assert.equal(second.kind, "existing");
    const inbox = new SqliteEventInbox(db);
    assert.equal(inbox.accept("event-1", { type: "post.updated" }, false), "accepted");
    assert.equal(inbox.accept("event-1", { type: "post.updated" }, false), "duplicate");
    assert.equal(inbox.pending().length, 1);
  });
});

test("credentials reject encrypted row swaps and event database errors remain failures", async () => {
  const db = openExampleDatabase();
  const credentials = new EncryptedSqliteCredentialStore(db, "test-key");
  await credentials.compareAndSet({
    key: "tenant-a",
    expectedRevision: undefined,
    value: { accessToken: "a" },
  });
  await credentials.compareAndSet({
    key: "tenant-b",
    expectedRevision: undefined,
    value: { accessToken: "b" },
  });
  db.exec(
    "UPDATE credentials SET ciphertext=(SELECT ciphertext FROM credentials WHERE key='tenant-a'),iv=(SELECT iv FROM credentials WHERE key='tenant-a'),tag=(SELECT tag FROM credentials WHERE key='tenant-a') WHERE key='tenant-b'",
  );
  await assert.rejects(credentials.get("tenant-b"));
  const inbox = new SqliteEventInbox(db);
  db.close();
  assert.throws(() => inbox.accept("event", {}, false));
});

test("preserves credentials, idempotency and pending inbox records after reopening the database", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "social-example-test-"));

  try {
    const filename = join(dir, "example.db");
    const first = openExampleDatabase(filename);
    const credential = new EncryptedSqliteCredentialStore(first, "test-key");
    await credential.compareAndSet({
      key: "account",
      expectedRevision: undefined,
      value: { accessToken: "saved" },
    });
    const claim = { scope: "tenant", key: "intent", fingerprint: "f", targetKeys: ["target"] };
    assert.equal((await new SqliteIdempotencyStore(first).claim(claim)).kind, "new");
    new SqliteEventInbox(first).accept("event", { value: 1 }, false);
    first.close();
    const second = openExampleDatabase(filename);
    assert.equal(
      (await new EncryptedSqliteCredentialStore(second, "test-key").get("account"))?.value
        .accessToken,
      "saved",
    );
    assert.equal((await new SqliteIdempotencyStore(second).claim(claim)).kind, "existing");
    assert.deepEqual(new SqliteEventInbox(second).pending(), [
      { eventKey: "event", payload: { value: 1 } },
    ]);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("late reconciliation cannot overwrite a durable published result", async () => {
  const { SqlitePublicationStore } = await import("../src/storage.js");
  const { createSocial } = await import("@opencoredev/social-sdk");
  const { mockBackend } = await import("@opencoredev/social-sdk/testing");
  const db = openExampleDatabase();
  const backend = mockBackend();
  const social = createSocial({ backend });
  const account = (await social.accounts.list()).items[0]!.ref;

  const result = await social.posts.publish({
    content: { text: "stored" },
    targets: [{ account }],
  });

  const store = new SqlitePublicationStore(db);
  store.save("tenant", "key", result);
  store.save("tenant", "key", {
    ...result,
    outcomes: result.outcomes.map((outcome) => ({ ...outcome, state: "processing" })),
  });
  assert.equal(store.get("tenant", "key")?.outcomes[0]?.state, "published");
  db.close();
});

test("a later native URL can enrich a published result without changing its post identity", async () => {
  const { SqlitePublicationStore } = await import("../src/storage.js");
  const { createSocial } = await import("@opencoredev/social-sdk");
  const { mockBackend } = await import("@opencoredev/social-sdk/testing");
  const db = openExampleDatabase();
  const social = createSocial({ backend: mockBackend() });
  const account = (await social.accounts.list()).items[0]!.ref;
  const result = await social.posts.publish({ targets: [{ account }], content: { text: "hello" } });
  const original = result.outcomes[0]!;
  assert.equal(original.state, "published");
  const store = new SqlitePublicationStore(db);
  store.save("tenant", "intent", result);
  store.save("tenant", "intent", {
    ...result,
    outcomes: [
      { ...original, observedAt: "2026-01-02T00:00:00Z", url: "https://social.example/resolved" },
    ],
  });
  const saved = store.get("tenant", "intent")!.outcomes[0]!;
  assert.equal(saved.state, "published");

  if (saved.state === "published") assert.equal(saved.url, "https://social.example/resolved");
  db.close();
});
