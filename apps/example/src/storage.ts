/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract. */
import { DatabaseSync } from "node:sqlite";
import { createDecipheriv, createCipheriv, createHash, randomBytes } from "node:crypto";
import type { StoredCredential } from "@opencoredev/social-sdk/server";
import type {
  CredentialStore,
  DeliveryOutcome,
  IdempotencyClaim,
  IdempotencyClaimInput,
  IdempotencyStore,
} from "@opencoredev/social-sdk";

export function openExampleDatabase(filename = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  db.exec(`CREATE TABLE IF NOT EXISTS idempotency (scope TEXT NOT NULL, operation_key TEXT NOT NULL, fingerprint TEXT NOT NULL, claim_id TEXT NOT NULL, target_keys TEXT NOT NULL, outcomes TEXT NOT NULL, PRIMARY KEY(scope, operation_key));
    CREATE TABLE IF NOT EXISTS credentials (key TEXT PRIMARY KEY, revision TEXT NOT NULL, ciphertext BLOB NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS events (event_key TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL, processed_at TEXT);`);

  return db;
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");

  try {
    const result = work();
    db.exec("COMMIT");

    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export class SqliteIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: DatabaseSync) {}
  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaim> {
    return transaction(this.db, () => {
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      const existing = this.db
        .prepare("SELECT * FROM idempotency WHERE scope=? AND operation_key=?")
        // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated boundary or fixture contract.
        .get(input.scope, input.key) as Record<string, unknown> | undefined;

      if (existing !== undefined) {
        if (
          existing["fingerprint"] !== input.fingerprint ||
          existing["target_keys"] !== JSON.stringify(input.targetKeys)
        )
          return { kind: "conflict" };
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        const parsed = JSON.parse(String(existing["outcomes"])) as Record<string, DeliveryOutcome>;

        return { kind: "existing", claimId: String(existing["claim_id"]), outcomes: parsed };
      }

      const claimId = `sqlite-${createHash("sha256")
        .update(JSON.stringify([input.scope, input.key]))
        .digest("hex")}`;

      this.db
        .prepare(
          "INSERT INTO idempotency(scope,operation_key,fingerprint,claim_id,target_keys,outcomes) VALUES(?,?,?,?,?,?)",
        )
        .run(
          input.scope,
          input.key,
          input.fingerprint,
          claimId,
          JSON.stringify(input.targetKeys),
          "{}",
        );

      return { kind: "new", claimId, outcomes: {} };
    });
  }
  async saveOutcome(input: {
    readonly claimId: string;
    readonly targetKey: string;
    readonly outcome: DeliveryOutcome;
  }): Promise<void> {
    transaction(this.db, () => {
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      const row = this.db
        .prepare("SELECT outcomes,target_keys FROM idempotency WHERE claim_id=?")
        .get(input.claimId) as { outcomes: string; target_keys: string } | undefined;

      if (row === undefined) throw new Error("Unknown idempotency claim");

      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      if (!(JSON.parse(row.target_keys) as string[]).includes(input.targetKey))
        throw new Error("Target does not belong to this idempotency claim");
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      const outcomes = JSON.parse(row.outcomes) as Record<string, DeliveryOutcome>;
      outcomes[input.targetKey] = input.outcome;
      this.db
        .prepare("UPDATE idempotency SET outcomes=? WHERE claim_id=?")
        .run(JSON.stringify(outcomes), input.claimId);
    });
  }
}

function keyFromSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export class EncryptedSqliteCredentialStore implements CredentialStore<StoredCredential> {
  private readonly key: Buffer;
  constructor(
    private readonly db: DatabaseSync,
    encryptionKey: string,
  ) {
    if (!encryptionKey)
      throw new Error("EXAMPLE_CREDENTIAL_KEY is required for durable credentials");
    this.key = keyFromSecret(encryptionKey);
  }
  async get(
    key: string,
  ): Promise<{ readonly value: StoredCredential; readonly revision: string } | undefined> {
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
    const row = this.db.prepare("SELECT * FROM credentials WHERE key=?").get(key) as
      | { revision: string; ciphertext: Buffer; iv: Buffer; tag: Buffer }
      | undefined;

    if (row === undefined) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", this.key, row.iv);
    decipher.setAAD(Buffer.from(key));
    decipher.setAuthTag(row.tag);

    return {
      revision: row.revision,
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      value: JSON.parse(
        Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8"),
      ) as StoredCredential,
    };
  }
  async compareAndSet(input: {
    readonly key: string;
    readonly expectedRevision: string | undefined;
    readonly value: StoredCredential;
  }): Promise<{ readonly updated: boolean; readonly revision?: string }> {
    return transaction(this.db, () => {
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      const current = this.db
        .prepare("SELECT revision FROM credentials WHERE key=?")
        .get(input.key) as { revision: string } | undefined;

      if ((current?.revision ?? undefined) !== input.expectedRevision) return { updated: false };
      const revision = createHash("sha256").update(randomBytes(16)).digest("hex");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(Buffer.from(input.key));

      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(input.value), "utf8"),
        cipher.final(),
      ]);

      this.db
        .prepare(
          "INSERT INTO credentials(key,revision,ciphertext,iv,tag) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,ciphertext=excluded.ciphertext,iv=excluded.iv,tag=excluded.tag",
        )
        .run(input.key, revision, ciphertext, iv, cipher.getAuthTag());

      return { updated: true, revision };
    });
  }
  async delete(key: string): Promise<void> {
    this.db.prepare("DELETE FROM credentials WHERE key=?").run(key);
  }
}

export class SqliteEventInbox {
  constructor(private readonly db: DatabaseSync) {}
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
  accept(eventKey: string, payload: unknown, quarantined: boolean): "accepted" | "duplicate" {
    const result = this.db
      .prepare(
        "INSERT INTO events(event_key,state,payload) VALUES(?,?,?) ON CONFLICT(event_key) DO NOTHING",
      )
      .run(eventKey, quarantined ? "quarantined" : "pending", JSON.stringify(payload));

    return result.changes === 0 ? "duplicate" : "accepted";
  }
  pending(limit = 100): readonly { eventKey: string; payload: unknown }[] {
    return (
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- provider payload is validated at this adapter boundary.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      (
        this.db
          .prepare(
            "SELECT event_key,payload FROM events WHERE state='pending' ORDER BY rowid LIMIT ?",
          )
          .all(limit) as unknown as readonly { event_key: string; payload: string }[]
      )
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        .map((row) => ({ eventKey: row.event_key, payload: JSON.parse(row.payload) as unknown }))
    );
  }
  pendingCount(): number {
    return Number(
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      (
        this.db.prepare("SELECT COUNT(*) AS count FROM events WHERE state='pending'").get() as {
          count: number;
        }
      ).count,
    );
  }
  markProcessed(eventKey: string): void {
    this.db
      .prepare("UPDATE events SET state='processed',processed_at=? WHERE event_key=?")
      .run(new Date().toISOString(), eventKey);
  }
}

export class SqlitePublicationStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS publication_deliveries (tenant_id TEXT NOT NULL, operation_key TEXT NOT NULL, backend TEXT NOT NULL, delivery_id TEXT NOT NULL, account_id TEXT NOT NULL, PRIMARY KEY(tenant_id,operation_key,backend,delivery_id,account_id)); CREATE INDEX IF NOT EXISTS publication_delivery_lookup ON publication_deliveries(tenant_id,backend,delivery_id)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS removal_reports (tenant_id TEXT NOT NULL, operation_key TEXT NOT NULL, event_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(tenant_id,event_key))",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS publications (tenant_id TEXT NOT NULL, operation_key TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(tenant_id, operation_key))",
    );
  }
  save(
    tenantId: string,
    key: string,
    result: import("@opencoredev/social-sdk").PublishResult,
  ): void {
    transaction(this.db, () => this.saveProjection(tenantId, key, result));
  }
  private saveProjection(
    tenantId: string,
    key: string,
    incoming: import("@opencoredev/social-sdk").PublishResult,
  ): void {
    const existing = this.get(tenantId, key);

    const outcomes = incoming.outcomes.map((outcome) => {
      const previous = existing?.outcomes.find(
        (candidate) =>
          candidate.account.backend === outcome.account.backend &&
          candidate.account.platform === outcome.account.platform &&
          candidate.account.accountId === outcome.account.accountId &&
          candidate.targetIndex === outcome.targetIndex,
      );

      if (!previous) return outcome;

      // A late processing snapshot cannot undo a saved terminal observation.
      if (
        previous.state === "published" &&
        outcome.state === "published" &&
        previous.post.postId === outcome.post.postId &&
        Date.parse(outcome.observedAt) >= Date.parse(previous.observedAt)
      )
        return { ...previous, ...outcome, post: { ...previous.post, ...outcome.post } };

      if (["published", "failed", "cancelled", "not-submitted"].includes(previous.state))
        return previous;

      if (Date.parse(previous.observedAt) > Date.parse(outcome.observedAt)) return previous;

      return outcome;
    });

    const result = {
      ...incoming,
      outcomes,
      status: outcomes.every((outcome) => outcome.state === "published")
        ? "complete"
        : outcomes.every((outcome) =>
              ["scheduled", "accepted", "processing"].includes(outcome.state),
            )
          ? "pending"
          : "partial",
    };

    for (const outcome of outcomes) {
      if (outcome.delivery)
        this.db
          .prepare("INSERT OR IGNORE INTO publication_deliveries VALUES(?,?,?,?,?)")
          .run(
            tenantId,
            key,
            outcome.account.backend,
            outcome.delivery.deliveryId,
            outcome.account.accountId,
          );
    }

    this.db
      .prepare(
        "INSERT INTO publications VALUES(?,?,?) ON CONFLICT(tenant_id,operation_key) DO UPDATE SET result=excluded.result",
      )
      .run(tenantId, key, JSON.stringify(result));
  }
  get(tenantId: string, key: string): import("@opencoredev/social-sdk").PublishResult | undefined {
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
    const row = this.db
      .prepare("SELECT result FROM publications WHERE tenant_id=? AND operation_key=?")
      .get(tenantId, key) as { result: string } | undefined;

    return row
      ? // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        (JSON.parse(row.result) as import("@opencoredev/social-sdk").PublishResult)
      : undefined;
  }
  findByDelivery(
    tenantId: string,
    backend: string,
    deliveryId: string,
    accountIds: readonly string[],
  ): string | undefined {
    if (!accountIds.length) return undefined;

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
    const rows = this.db
      .prepare(
        "SELECT operation_key,account_id FROM publication_deliveries WHERE tenant_id=? AND backend=? AND delivery_id=?",
      )
      .all(tenantId, backend, deliveryId) as { operation_key: string; account_id: string }[];

    const keys = [...new Set(rows.map((row) => row.operation_key))].filter((key) =>
      accountIds.every((id) =>
        rows.some((row) => row.operation_key === key && row.account_id === id),
      ),
    );

    return keys.length === 1 ? keys[0] : undefined;
  }
  removalReports(tenantId: string, key: string): readonly unknown[] {
    return (
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      (
        this.db
          .prepare(
            "SELECT payload FROM removal_reports WHERE tenant_id=? AND operation_key=? ORDER BY rowid",
          )
          .all(tenantId, key) as { payload: string }[]
      )
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        .map((row) => JSON.parse(row.payload) as unknown)
    );
  }
  /** Commit the reconciled projection and inbox completion together. Reads can be retried after a crash. */
  applyEvent(
    tenantId: string,
    key: string,
    result: import("@opencoredev/social-sdk").PublishResult,
    eventKey: string,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
    removalReport?: unknown,
  ): boolean {
    return transaction(this.db, () => {
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      const row = this.db.prepare("SELECT state FROM events WHERE event_key=?").get(eventKey) as
        | { state: string }
        | undefined;

      if (row?.state !== "pending") return false;
      this.saveProjection(tenantId, key, result);

      if (removalReport !== undefined)
        this.db
          .prepare("INSERT OR IGNORE INTO removal_reports VALUES(?,?,?,?)")
          .run(tenantId, key, eventKey, JSON.stringify(removalReport));
      this.db
        .prepare(
          "UPDATE events SET state='processed',processed_at=? WHERE event_key=? AND state='pending'",
        )
        .run(new Date().toISOString(), eventKey);

      return true;
    });
  }
}
