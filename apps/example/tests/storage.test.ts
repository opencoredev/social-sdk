import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { DeliveryOutcome } from "@opencoredev/social-sdk";
import { credentials, events } from "../src/db/schema.js";
import {
  openExampleDatabase,
  EncryptedPostgresCredentialStore,
  DrizzleEventInbox,
  PostgresIdempotencyStore,
} from "../src/storage.js";

describe("durable example storage", () => {
  test("encrypts credentials and supports CAS", async () => {
    const { db, close } = await openExampleDatabase();
    const store = new EncryptedPostgresCredentialStore(db, "test-only-key-from-environment");

    const first = await store.compareAndSet({
      key: "a",
      expectedRevision: undefined,
      value: { accessToken: "secret", refreshToken: "refresh" },
    });

    assert.equal(first.updated, true);
    const current = await store.get("a");
    assert.equal(current?.value.accessToken, "secret");

    const [stored] = await db
      .select({ ciphertext: credentials.ciphertext })
      .from(credentials)
      .where(eq(credentials.key, "a"));

    assert.equal(stored?.ciphertext.toString().includes("secret"), false);
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
    assert.equal(
      (
        await store.compareAndSet({
          key: "a",
          expectedRevision: undefined,
          value: { accessToken: "bad" },
        })
      ).updated,
      false,
    );

    const second = await store.compareAndSet({
      key: "a",
      expectedRevision: first.revision,
      value: { accessToken: "rotated" },
    });

    assert.equal(second.updated, true);
    assert.notEqual(second.revision, first.revision);
    assert.equal((await store.get("a"))?.value.accessToken, "rotated");
    await store.delete("a");
    assert.equal(await store.get("a"), undefined);
    await close();
  });
  test("deduplicates idempotency and event delivery across calls", async () => {
    const { db, close } = await openExampleDatabase();
    const idempotency = new PostgresIdempotencyStore(db);
    const input = { scope: "tenant:publish", key: "one", fingerprint: "f", targetKeys: ["a"] };
    const first = await idempotency.claim(input);
    const second = await idempotency.claim(input);
    assert.equal(first.kind, "new");
    assert.equal(second.kind, "existing");
    const inbox = new DrizzleEventInbox(db);
    assert.equal(await inbox.accept("event-1", { type: "post.updated" }, false), "accepted");
    assert.equal(await inbox.accept("event-1", { type: "post.updated" }, false), "duplicate");
    assert.equal((await inbox.pending()).length, 1);
    await close();
  });
});

test("idempotency claims conflict on changed intent and keep saved outcomes", async () => {
  const { db, close } = await openExampleDatabase();
  const store = new PostgresIdempotencyStore(db);
  const input = { scope: "tenant", key: "intent", fingerprint: "f", targetKeys: ["a", "b"] };
  const claim = await store.claim(input);
  assert.equal(claim.kind, "new");

  if (claim.kind !== "new") return;
  assert.equal((await store.claim({ ...input, fingerprint: "other" })).kind, "conflict");
  assert.equal((await store.claim({ ...input, targetKeys: ["b", "a"] })).kind, "conflict");

  const outcome: DeliveryOutcome = {
    state: "processing",
    targetIndex: 0,
    account: {
      kind: "connected-account",
      version: 1,
      backend: "mock",
      platform: "x",
      accountId: "a",
    },
    observedAt: "2026-01-01T00:00:00.000Z",
  };

  await store.saveOutcome({ claimId: claim.claimId, targetKey: "a", outcome });
  const existing = await store.claim(input);
  assert.deepEqual(existing, {
    kind: "existing",
    claimId: claim.claimId,
    outcomes: { a: outcome },
  });
  await assert.rejects(store.saveOutcome({ claimId: claim.claimId, targetKey: "c", outcome }));
  await assert.rejects(store.saveOutcome({ claimId: "unknown", targetKey: "a", outcome }));
  await close();
});

test("the inbox returns pending events in arrival order, 100 at a time, and skips quarantine", async () => {
  const { db, close } = await openExampleDatabase();
  const inbox = new DrizzleEventInbox(db);
  assert.equal(await inbox.accept("quarantined", { n: -1 }, true), "accepted");

  for (let n = 0; n < 105; n++) await inbox.accept(`event-${104 - n}`, { n }, false);
  const batch = await inbox.pending();
  assert.equal(batch.length, 100);
  assert.deepEqual(
    batch.slice(0, 2).map((entry) => entry.payload),
    [{ n: 0 }, { n: 1 }],
  );
  assert.equal(await inbox.pendingCount(), 105);
  await inbox.markProcessed("event-104");
  assert.equal(await inbox.pendingCount(), 104);
  const [processed] = await db.select().from(events).where(eq(events.eventKey, "event-104"));
  assert.equal(processed?.state, "processed");
  assert.ok(processed?.processedAt instanceof Date);
  await close();
});

test("the inbox keeps provider payloads that contain NUL characters", async () => {
  const { db, close } = await openExampleDatabase();
  const inbox = new DrizzleEventInbox(db);
  assert.equal(await inbox.accept("nul", { text: "a\u0000b" }, false), "accepted");
  assert.deepEqual(
    (await inbox.pending()).map((entry) => entry.payload),
    [{ text: "a\u0000b" }],
  );
  await close();
});

test("credentials reject encrypted row swaps and event database errors remain failures", async () => {
  const database = await openExampleDatabase();
  const { db } = database;
  const store = new EncryptedPostgresCredentialStore(db, "test-key");
  await store.compareAndSet({
    key: "tenant-a",
    expectedRevision: undefined,
    value: { accessToken: "a" },
  });
  await store.compareAndSet({
    key: "tenant-b",
    expectedRevision: undefined,
    value: { accessToken: "b" },
  });
  const [source] = await db.select().from(credentials).where(eq(credentials.key, "tenant-a"));
  assert.ok(source);
  await db
    .update(credentials)
    .set({ ciphertext: source.ciphertext, iv: source.iv, tag: source.tag })
    .where(eq(credentials.key, "tenant-b"));
  await assert.rejects(store.get("tenant-b"));
  const inbox = new DrizzleEventInbox(db);
  await database.close();
  await assert.rejects(inbox.accept("event", {}, false));
});

test("preserves credentials, idempotency and pending inbox records after reopening the database", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "social-example-test-"));

  try {
    const dataDir = join(dir, "pglite");
    const first = await openExampleDatabase({ dataDir });
    const credential = new EncryptedPostgresCredentialStore(first.db, "test-key");
    await credential.compareAndSet({
      key: "account",
      expectedRevision: undefined,
      value: { accessToken: "saved" },
    });
    const claim = { scope: "tenant", key: "intent", fingerprint: "f", targetKeys: ["target"] };
    assert.equal((await new PostgresIdempotencyStore(first.db).claim(claim)).kind, "new");
    await new DrizzleEventInbox(first.db).accept("event", { value: 1 }, false);
    await first.close();
    const second = await openExampleDatabase({ dataDir });
    assert.equal(
      (await new EncryptedPostgresCredentialStore(second.db, "test-key").get("account"))?.value
        .accessToken,
      "saved",
    );
    assert.equal((await new PostgresIdempotencyStore(second.db).claim(claim)).kind, "existing");
    assert.deepEqual(await new DrizzleEventInbox(second.db).pending(), [
      { eventKey: "event", payload: { value: 1 } },
    ]);
    await second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("late reconciliation cannot overwrite a durable published result", async () => {
  const { DrizzlePublicationStore } = await import("../src/storage.js");
  const { createSocial } = await import("@opencoredev/social-sdk");
  const { mockBackend } = await import("@opencoredev/social-sdk/testing");
  const database = await openExampleDatabase();
  const backend = mockBackend();
  const social = createSocial({ backend });
  const account = (await social.accounts.list()).items[0]!.ref;

  const result = await social.posts.publish({
    content: { text: "stored" },
    targets: [{ account }],
  });

  const store = new DrizzlePublicationStore(database.db);
  await store.save("tenant", "key", result);
  await store.save("tenant", "key", {
    ...result,
    outcomes: result.outcomes.map((outcome) => ({ ...outcome, state: "processing" })),
  });
  assert.equal((await store.get("tenant", "key"))?.outcomes[0]?.state, "published");
  await database.close();
});

test("a later native URL can enrich a published result without changing its post identity", async () => {
  const { DrizzlePublicationStore } = await import("../src/storage.js");
  const { createSocial } = await import("@opencoredev/social-sdk");
  const { mockBackend } = await import("@opencoredev/social-sdk/testing");
  const database = await openExampleDatabase();
  const social = createSocial({ backend: mockBackend() });
  const account = (await social.accounts.list()).items[0]!.ref;
  const result = await social.posts.publish({ targets: [{ account }], content: { text: "hello" } });
  const original = result.outcomes[0]!;
  assert.equal(original.state, "published");
  const store = new DrizzlePublicationStore(database.db);
  await store.save("tenant", "intent", result);
  await store.save("tenant", "intent", {
    ...result,
    outcomes: [
      { ...original, observedAt: "2026-01-02T00:00:00Z", url: "https://social.example/resolved" },
    ],
  });
  const saved = (await store.get("tenant", "intent"))!.outcomes[0]!;
  assert.equal(saved.state, "published");

  if (saved.state === "published") assert.equal(saved.url, "https://social.example/resolved");
  await database.close();
});
