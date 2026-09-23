import { createDecipheriv, createCipheriv, createHash, randomBytes } from "node:crypto";
import { and, asc, count, eq, sql } from "drizzle-orm";
import type { StoredCredential } from "@opencoredev/social-sdk/server";
import type {
  CredentialStore,
  DeliveryOutcome,
  IdempotencyClaim,
  IdempotencyClaimInput,
  IdempotencyStore,
  PublishResult,
} from "@opencoredev/social-sdk";
import type { Database } from "./db/client.js";
import {
  credentials,
  events,
  idempotency,
  publicationDeliveries,
  publications,
  removalReports,
} from "./db/schema.js";

export {
  openDatabaseFromEnv,
  openExampleDatabase,
  type Database,
  type ExampleDatabase,
} from "./db/client.js";

const sameTargets = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((key, index) => key === right[index]);

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Database) {}
  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaim> {
    const claimId = `pg-${createHash("sha256")
      .update(JSON.stringify([input.scope, input.key]))
      .digest("hex")}`;

    const inserted = await this.db
      .insert(idempotency)
      .values({
        scope: input.scope,
        operationKey: input.key,
        fingerprint: input.fingerprint,
        claimId,
        targetKeys: input.targetKeys,
        outcomes: {},
      })
      .onConflictDoNothing({ target: [idempotency.scope, idempotency.operationKey] })
      .returning({ claimId: idempotency.claimId });

    if (inserted.length > 0) return { kind: "new", claimId, outcomes: {} };

    const [existing] = await this.db
      .select()
      .from(idempotency)
      .where(and(eq(idempotency.scope, input.scope), eq(idempotency.operationKey, input.key)));

    if (existing === undefined) throw new Error("Idempotency claim disappeared during lookup");

    if (
      existing.fingerprint !== input.fingerprint ||
      !sameTargets(existing.targetKeys, input.targetKeys)
    )
      return { kind: "conflict" };

    return { kind: "existing", claimId: existing.claimId, outcomes: existing.outcomes };
  }
  async saveOutcome(input: {
    readonly claimId: string;
    readonly targetKey: string;
    readonly outcome: DeliveryOutcome;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ outcomes: idempotency.outcomes, targetKeys: idempotency.targetKeys })
        .from(idempotency)
        .where(eq(idempotency.claimId, input.claimId))
        .for("update");

      if (row === undefined) throw new Error("Unknown idempotency claim");

      if (!row.targetKeys.includes(input.targetKey))
        throw new Error("Target does not belong to this idempotency claim");

      await tx
        .update(idempotency)
        .set({ outcomes: { ...row.outcomes, [input.targetKey]: input.outcome } })
        .where(eq(idempotency.claimId, input.claimId));
    });
  }
}

function keyFromSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export class EncryptedPostgresCredentialStore implements CredentialStore<StoredCredential> {
  private readonly key: Buffer;
  constructor(
    private readonly db: Database,
    encryptionKey: string,
  ) {
    if (!encryptionKey)
      throw new Error("EXAMPLE_CREDENTIAL_KEY is required for durable credentials");
    this.key = keyFromSecret(encryptionKey);
  }
  async get(
    key: string,
  ): Promise<{ readonly value: StoredCredential; readonly revision: string } | undefined> {
    const [row] = await this.db.select().from(credentials).where(eq(credentials.key, key));

    if (row === undefined) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", this.key, row.iv);
    decipher.setAAD(Buffer.from(key));
    decipher.setAuthTag(row.tag);

    return {
      revision: row.revision,
      // SAFETY: AES-GCM authenticated this plaintext, which only compareAndSet writes from a StoredCredential.
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
    const revision = createHash("sha256").update(randomBytes(16)).digest("hex");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(input.key));

    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(input.value), "utf8"),
      cipher.final(),
    ]);

    const row = { key: input.key, revision, ciphertext, iv, tag: cipher.getAuthTag() };

    // Each branch is one conditional statement, so concurrent writers cannot both win.
    const written =
      input.expectedRevision === undefined
        ? await this.db
            .insert(credentials)
            .values(row)
            .onConflictDoNothing({ target: credentials.key })
            .returning({ revision: credentials.revision })
        : await this.db
            .update(credentials)
            .set({ revision, ciphertext, iv, tag: row.tag })
            .where(
              and(eq(credentials.key, input.key), eq(credentials.revision, input.expectedRevision)),
            )
            .returning({ revision: credentials.revision });

    return written.length > 0 ? { updated: true, revision } : { updated: false };
  }
  async delete(key: string): Promise<void> {
    await this.db.delete(credentials).where(eq(credentials.key, key));
  }
}

export class DrizzleEventInbox {
  constructor(private readonly db: Database) {}
  async accept(
    eventKey: string,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- provider payloads are validated by the worker.
    payload: unknown,
    quarantined: boolean,
  ): Promise<"accepted" | "duplicate"> {
    const inserted = await this.db
      .insert(events)
      .values({ eventKey, state: quarantined ? "quarantined" : "pending", payload })
      .onConflictDoNothing({ target: events.eventKey })
      .returning({ eventKey: events.eventKey });

    return inserted.length === 0 ? "duplicate" : "accepted";
  }
  async pending(limit = 100): Promise<readonly { eventKey: string; payload: unknown }[]> {
    return this.db
      .select({ eventKey: events.eventKey, payload: events.payload })
      .from(events)
      .where(eq(events.state, "pending"))
      .orderBy(asc(events.sequence))
      .limit(limit);
  }
  async pendingCount(): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(events)
      .where(eq(events.state, "pending"));

    return row?.count ?? 0;
  }
  async markProcessed(eventKey: string): Promise<void> {
    await this.db
      .update(events)
      .set({ state: "processed", processedAt: new Date() })
      .where(eq(events.eventKey, eventKey));
  }
}

function reconcileProjection(
  existing: PublishResult | undefined,
  incoming: PublishResult,
): PublishResult {
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

  return {
    ...incoming,
    outcomes,
    status: outcomes.every((outcome) => outcome.state === "published")
      ? "complete"
      : outcomes.every((outcome) => ["scheduled", "accepted", "processing"].includes(outcome.state))
        ? "pending"
        : "partial",
  };
}

export class DrizzlePublicationStore {
  constructor(private readonly db: Database) {}
  async save(tenantId: string, key: string, result: PublishResult): Promise<void> {
    await this.db.transaction((tx) => this.saveProjection(tx, tenantId, key, result));
  }
  private async saveProjection(
    tx: Database,
    tenantId: string,
    key: string,
    incoming: PublishResult,
  ): Promise<void> {
    // FOR UPDATE locks nothing before the first save, so serialize on the key itself.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${tenantId}:${key}`}))`);

    const [existing] = await tx
      .select({ result: publications.result })
      .from(publications)
      .where(and(eq(publications.tenantId, tenantId), eq(publications.operationKey, key)))
      .for("update");

    const result = reconcileProjection(existing?.result, incoming);

    const deliveries = result.outcomes.flatMap((outcome) =>
      outcome.delivery
        ? [
            {
              tenantId,
              operationKey: key,
              backend: outcome.account.backend,
              deliveryId: outcome.delivery.deliveryId,
              accountId: outcome.account.accountId,
            },
          ]
        : [],
    );

    if (deliveries.length > 0)
      await tx.insert(publicationDeliveries).values(deliveries).onConflictDoNothing();

    await tx
      .insert(publications)
      .values({ tenantId, operationKey: key, result })
      .onConflictDoUpdate({
        target: [publications.tenantId, publications.operationKey],
        set: { result },
      });
  }
  async get(tenantId: string, key: string): Promise<PublishResult | undefined> {
    const [row] = await this.db
      .select({ result: publications.result })
      .from(publications)
      .where(and(eq(publications.tenantId, tenantId), eq(publications.operationKey, key)));

    return row?.result;
  }
  async findByDelivery(
    tenantId: string,
    backend: string,
    deliveryId: string,
    accountIds: readonly string[],
  ): Promise<string | undefined> {
    if (!accountIds.length) return undefined;

    const rows = await this.db
      .select({
        operationKey: publicationDeliveries.operationKey,
        accountId: publicationDeliveries.accountId,
      })
      .from(publicationDeliveries)
      .where(
        and(
          eq(publicationDeliveries.tenantId, tenantId),
          eq(publicationDeliveries.backend, backend),
          eq(publicationDeliveries.deliveryId, deliveryId),
        ),
      );

    const keys = [...new Set(rows.map((row) => row.operationKey))].filter((key) =>
      accountIds.every((id) =>
        rows.some((row) => row.operationKey === key && row.accountId === id),
      ),
    );

    return keys.length === 1 ? keys[0] : undefined;
  }
  async removalReports(tenantId: string, key: string): Promise<readonly unknown[]> {
    const rows = await this.db
      .select({ payload: removalReports.payload })
      .from(removalReports)
      .where(and(eq(removalReports.tenantId, tenantId), eq(removalReports.operationKey, key)))
      .orderBy(asc(removalReports.sequence));

    return rows.map((row) => row.payload);
  }
  /** Commit the reconciled projection and inbox completion together. Reads can be retried after a crash. */
  async applyEvent(
    tenantId: string,
    key: string,
    result: PublishResult,
    eventKey: string,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- removal reports are opaque JSON observations.
    removalReport?: unknown,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ state: events.state })
        .from(events)
        .where(eq(events.eventKey, eventKey))
        .for("update");

      if (row?.state !== "pending") return false;
      await this.saveProjection(tx, tenantId, key, result);

      if (removalReport !== undefined)
        await tx
          .insert(removalReports)
          .values({ tenantId, operationKey: key, eventKey, payload: removalReport })
          .onConflictDoNothing();

      await tx
        .update(events)
        .set({ state: "processed", processedAt: new Date() })
        .where(and(eq(events.eventKey, eventKey), eq(events.state, "pending")));

      return true;
    });
  }
}
