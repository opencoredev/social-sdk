import type { CredentialStore } from "../core/adapter.js";
import { definedFields } from "../core/fields.js";
import {
  stableSerialize,
  type IdempotencyClaim,
  type IdempotencyClaimInput,
  type IdempotencyStore,
} from "../core/idempotency.js";
import type {
  ConnectedAccountRef,
  DeliveryOutcome,
  DeliveryRef,
  PreparationIssue,
  RetryDisposition,
} from "../core/types.js";
import { parseJson, type JsonValue } from "../transport/json.js";
import type {
  ConnectionAccount,
  ConnectionAttempt,
  ConnectionGrant,
  ConnectionStore,
} from "./connections.js";
import {
  parseStoredCredential,
  type CredentialLease,
  type CredentialLock,
  type StoredCredential,
} from "./credentials.js";
import {
  encodeRecord,
  guarded,
  isObjectValue,
  isOptionalString,
  isStringArray,
  isStringValue,
  newRevision,
  parseRecord,
  positiveTtl,
  storeError,
  updateRecord,
  validKey,
  type DurableDriver,
  type JsonObjectValue,
} from "./durable-driver.js";

function isFiniteNumberValue(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseAccountRef(value: JsonValue | undefined): ConnectedAccountRef | undefined {
  if (
    !isObjectValue(value) ||
    value["kind"] !== "connected-account" ||
    value["version"] !== 1 ||
    !isStringValue(value["backend"]) ||
    !isStringValue(value["platform"]) ||
    !isStringValue(value["accountId"])
  )
    return undefined;

  return {
    kind: "connected-account",
    version: 1,
    backend: value["backend"],
    platform: value["platform"],
    accountId: value["accountId"],
  };
}

function parseList<Item>(
  value: JsonValue | undefined,
  parse: (item: JsonValue) => Item | undefined,
): Item[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: Item[] = [];

  for (const entry of value) {
    const item = parse(entry);

    if (item === undefined) return undefined;
    items.push(item);
  }

  return items;
}

// Connections --------------------------------------------------------------

type DiscoveryState =
  | { readonly kind: "unclaimed" }
  | { readonly kind: "claimed" }
  | { readonly kind: "discovered"; readonly accounts: readonly ConnectionAccount[] };

interface GrantEntry {
  readonly grant: ConnectionGrant;
  readonly revokedAt?: string;
}

/**
 * One document per attempt. Completion replaces the pending attempt (and its
 * secrets) with the grant set in a single revision check, so grants outlive
 * the attempt's expiry and a failed write leaves the attempt retryable.
 */
type ConnectionRecord =
  | {
      readonly kind: "pending";
      readonly attempt: ConnectionAttempt;
      readonly discovery: DiscoveryState;
    }
  | {
      readonly kind: "completed";
      readonly completedAt: string;
      readonly grants: readonly GrantEntry[];
    };

function parseAttempt(value: JsonValue | undefined): ConnectionAttempt | undefined {
  if (
    !isObjectValue(value) ||
    !isStringValue(value["id"]) ||
    !isStringValue(value["backend"]) ||
    !isStringValue(value["tenantId"]) ||
    !isStringValue(value["principalId"]) ||
    !isStringArray(value["platforms"]) ||
    !isStringArray(value["capabilities"]) ||
    !isStringValue(value["redirectUri"]) ||
    !isStringValue(value["state"]) ||
    !isStringValue(value["codeVerifier"]) ||
    !isOptionalString(value["providerState"]) ||
    !isStringValue(value["createdAt"]) ||
    !isStringValue(value["expiresAt"])
  )
    return undefined;

  return {
    id: value["id"],
    backend: value["backend"],
    tenantId: value["tenantId"],
    principalId: value["principalId"],
    platforms: [...value["platforms"]],
    capabilities: [...value["capabilities"]],
    redirectUri: value["redirectUri"],
    state: value["state"],
    codeVerifier: value["codeVerifier"],
    createdAt: value["createdAt"],
    expiresAt: value["expiresAt"],
    ...definedFields({ providerState: value["providerState"] }),
  };
}

function parseAccount(value: JsonValue): ConnectionAccount | undefined {
  if (!isObjectValue(value) || !isStringValue(value["displayName"])) return undefined;
  const ref = parseAccountRef(value["ref"]);

  return ref === undefined ? undefined : { ref, displayName: value["displayName"] };
}

function parseGrantEntry(value: JsonValue): GrantEntry | undefined {
  if (!isObjectValue(value) || !isOptionalString(value["revokedAt"])) return undefined;
  const grant = value["grant"];

  if (
    !isObjectValue(grant) ||
    !isStringValue(grant["grantId"]) ||
    !isStringValue(grant["tenantId"]) ||
    !isStringValue(grant["principalId"]) ||
    !isStringArray(grant["capabilities"])
  )
    return undefined;
  const account = parseAccountRef(grant["account"]);

  if (account === undefined) return undefined;

  return {
    grant: {
      grantId: grant["grantId"],
      tenantId: grant["tenantId"],
      principalId: grant["principalId"],
      account,
      capabilities: [...grant["capabilities"]],
    },
    ...definedFields({ revokedAt: value["revokedAt"] }),
  };
}

function parseDiscovery(value: JsonValue | undefined): DiscoveryState | undefined {
  if (!isObjectValue(value)) return undefined;

  if (value["kind"] === "unclaimed") return { kind: "unclaimed" };

  if (value["kind"] === "claimed") return { kind: "claimed" };

  if (value["kind"] !== "discovered") return undefined;
  const accounts = parseList(value["accounts"], parseAccount);

  return accounts === undefined ? undefined : { kind: "discovered", accounts };
}

function parseConnectionRecord(record: JsonObjectValue): ConnectionRecord {
  if (record["kind"] === "pending") {
    const attempt = parseAttempt(record["attempt"]);
    const discovery = parseDiscovery(record["discovery"]);

    if (attempt !== undefined && discovery !== undefined)
      return { kind: "pending", attempt, discovery };
  }

  if (record["kind"] === "completed" && isStringValue(record["completedAt"])) {
    const grants = parseList(record["grants"], parseGrantEntry);

    if (grants !== undefined)
      return { kind: "completed", completedAt: record["completedAt"], grants };
  }

  throw storeError("connections.store", "Stored connection record is malformed");
}

/** Compares without exiting early on the first differing byte. */
function sameSecret(expected: string, actual: string): boolean {
  const left = new TextEncoder().encode(expected);
  const right = new TextEncoder().encode(actual);
  let difference = left.length ^ right.length;

  for (let index = 0; index < Math.max(left.length, right.length); index++)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);

  return difference === 0;
}

const GRANT_ID_SEPARATOR = "~";

/** Grant IDs embed the attempt ID so a grant resolves to its document without an index. */
function attemptIdFromGrant(grantId: string): string | undefined {
  // crypto.randomUUID() is always 36 characters long.
  return grantId.length > 37 && grantId[36] === GRANT_ID_SEPARATOR ? grantId.slice(37) : undefined;
}

export interface DurableConnectionStoreOptions {
  /**
   * Stores attempt secrets (PKCE verifier, provider state such as a DPoP key)
   * exactly as given. Use encrypted storage or an encrypting driver.
   */
  readonly driver: DurableDriver;
  readonly now?: () => Date;
}

/**
 * {@link ConnectionStore} on a {@link DurableDriver}. Discovery claims are
 * permanent: a failed code exchange is never released for a second attempt.
 * Pending attempts are not deleted automatically after they expire.
 */
export class DurableConnectionStore implements ConnectionStore {
  readonly #driver: DurableDriver;
  readonly #now: () => Date;

  constructor(options: DurableConnectionStoreOptions) {
    this.#driver = options.driver;
    this.#now = options.now ?? (() => new Date());
  }

  async #read(attemptId: string): Promise<ConnectionRecord | undefined> {
    const stored = await guarded("connections.store", () =>
      this.#driver.read({ namespace: "connection", key: validKey("connections.store", attemptId) }),
    );

    return stored === undefined
      ? undefined
      : parseConnectionRecord(parseRecord("connections.store", stored.text));
  }

  #update<Result>(
    attemptId: string,
    operation: string,
    decide: (
      current: ConnectionRecord | undefined,
    ) =>
      | { readonly kind: "write"; readonly record: ConnectionRecord; readonly result: Result }
      | { readonly kind: "done"; readonly result: Result },
  ): Promise<Result> {
    return updateRecord({
      driver: this.#driver,
      address: { namespace: "connection", key: validKey(operation, attemptId) },
      operation,
      decide: (current) => {
        const decision = decide(current === undefined ? undefined : parseConnectionRecord(current));

        return decision.kind === "done"
          ? decision
          : { kind: "write", body: encodeRecord(decision.record), result: decision.result };
      },
    });
  }

  async save(attempt: ConnectionAttempt): Promise<void> {
    const body = encodeRecord<ConnectionRecord>({
      kind: "pending",
      attempt,
      discovery: { kind: "unclaimed" },
    });

    const created = await guarded("connections.begin", () =>
      this.#driver.write({
        namespace: "connection",
        key: validKey("connections.begin", attempt.id),
        expectedRevision: undefined,
        revision: newRevision(),
        text: body,
      }),
    );

    if (!created) throw storeError("connections.begin", "Connection attempt ID collision");
  }

  async get(attemptId: string): Promise<ConnectionAttempt | undefined> {
    const record = await this.#read(attemptId);

    return record?.kind === "pending" ? record.attempt : undefined;
  }

  claimDiscovery(attemptId: string): Promise<boolean> {
    return this.#update(attemptId, "connections.discover", (current) => {
      if (
        current?.kind !== "pending" ||
        current.discovery.kind !== "unclaimed" ||
        this.#now().getTime() >= Date.parse(current.attempt.expiresAt)
      )
        return { kind: "done", result: false };

      return {
        kind: "write",
        record: { ...current, discovery: { kind: "claimed" } },
        result: true,
      };
    });
  }

  saveDiscoveredAccounts(attemptId: string, accounts: readonly ConnectionAccount[]): Promise<void> {
    return this.#update(attemptId, "connections.discover", (current) => {
      if (current?.kind !== "pending" || current.discovery.kind !== "claimed")
        throw storeError(
          "connections.discover",
          "Discovery cannot be saved for this attempt",
          "unauthorized",
        );

      return {
        kind: "write",
        record: { ...current, discovery: { kind: "discovered", accounts } },
        result: undefined,
      };
    });
  }

  async getDiscoveredAccounts(
    attemptId: string,
  ): Promise<readonly ConnectionAccount[] | undefined> {
    const record = await this.#read(attemptId);

    return record?.kind === "pending" && record.discovery.kind === "discovered"
      ? record.discovery.accounts
      : undefined;
  }

  complete(input: {
    readonly attemptId: string;
    readonly state: string;
    readonly accounts: readonly ConnectionAccount[];
    readonly selectedAccountIds: readonly string[];
  }): Promise<readonly ConnectionGrant[]> {
    return this.#update(input.attemptId, "connections.complete", (current) => {
      if (current?.kind !== "pending" || !sameSecret(current.attempt.state, input.state))
        throw storeError(
          "connections.complete",
          "Connection callback is invalid or already consumed",
          "unauthorized",
        );
      const { attempt, discovery } = current;
      const now = this.#now();

      if (now.getTime() >= Date.parse(attempt.expiresAt))
        throw storeError("connections.complete", "Connection attempt expired", "timeout");

      if (
        discovery.kind !== "discovered" ||
        stableSerialize(discovery.accounts) !== stableSerialize(input.accounts)
      )
        throw storeError(
          "connections.select",
          "Grants must match persisted discovery",
          "unauthorized",
        );
      const selected = new Set(input.selectedAccountIds);

      if (selected.size === 0 || selected.size !== input.selectedAccountIds.length)
        throw storeError(
          "connections.select",
          "Select one or more distinct discovered accounts",
          "invalid_input",
        );
      const known = new Set(discovery.accounts.map(({ ref }) => ref.accountId));

      if ([...selected].some((id) => !known.has(id)))
        throw storeError(
          "connections.select",
          "Selected account was not returned by the provider",
          "unauthorized",
        );
      const grants: ConnectionGrant[] = [];

      for (const account of discovery.accounts) {
        if (!selected.has(account.ref.accountId)) continue;
        grants.push({
          grantId: `${crypto.randomUUID()}${GRANT_ID_SEPARATOR}${attempt.id}`,
          tenantId: attempt.tenantId,
          principalId: attempt.principalId,
          account: account.ref,
          capabilities: attempt.capabilities,
        });
      }

      return {
        kind: "write",
        record: {
          kind: "completed",
          completedAt: now.toISOString(),
          grants: grants.map((grant) => ({ grant })),
        },
        result: grants,
      };
    });
  }

  /** Returns an active grant, or undefined when it is unknown or revoked. */
  async getGrant(grantId: string): Promise<ConnectionGrant | undefined> {
    const attemptId = attemptIdFromGrant(grantId);

    if (attemptId === undefined) return undefined;
    const record = await this.#read(attemptId);

    if (record?.kind !== "completed") return undefined;
    const entry = record.grants.find(({ grant }) => grant.grantId === grantId);

    return entry === undefined || entry.revokedAt !== undefined ? undefined : entry.grant;
  }

  /** Lists active grants created by one completed attempt. */
  async listGrants(attemptId: string): Promise<readonly ConnectionGrant[]> {
    const record = await this.#read(attemptId);

    if (record?.kind !== "completed") return [];
    const active: ConnectionGrant[] = [];

    for (const entry of record.grants) if (entry.revokedAt === undefined) active.push(entry.grant);

    return active;
  }

  /**
   * Marks a grant revoked for disconnect flows. Returns false when the grant is
   * unknown or already revoked. Callers still own provider token revocation and
   * credential deletion.
   */
  revokeGrant(grantId: string): Promise<boolean> {
    const attemptId = attemptIdFromGrant(grantId);

    if (attemptId === undefined) return Promise.resolve(false);

    return this.#update(attemptId, "connections.revoke", (current) => {
      if (current?.kind !== "completed") return { kind: "done", result: false };
      const index = current.grants.findIndex(({ grant }) => grant.grantId === grantId);

      if (index < 0 || current.grants[index]?.revokedAt !== undefined)
        return { kind: "done", result: false };
      const revokedAt = this.#now().toISOString();

      return {
        kind: "write",
        record: {
          ...current,
          grants: current.grants.map((entry, position) =>
            position === index ? { ...entry, revokedAt } : entry,
          ),
        },
        result: true,
      };
    });
  }
}

// Credentials --------------------------------------------------------------

/**
 * Converts credentials to stored text and back. `encode` may encrypt, and
 * `decode` must authenticate and validate; return undefined to reject.
 */
export interface CredentialCodec<TCredential> {
  encode(value: TCredential): string;
  decode(text: string): TCredential | undefined;
}

/**
 * Plain JSON codec for {@link StoredCredential}. It validates every field,
 * including the `refreshState` fence, and does not encrypt.
 */
export const storedCredentialCodec: CredentialCodec<StoredCredential> = {
  encode: (value) => JSON.stringify(value),
  decode(text) {
    try {
      return parseStoredCredential(parseJson(text), "credentials.get");
    } catch {
      return undefined;
    }
  },
};

export interface DurableCredentialStoreOptions<TCredential> {
  readonly driver: DurableDriver;
  /** Supply an encrypting codec unless the driver encrypts at rest. */
  readonly codec: CredentialCodec<TCredential>;
}

/**
 * {@link CredentialStore} with UUID revisions, so a delete and recreate never
 * reuses a revision. A credential's `expiresAt` is data only: stored access and
 * refresh tokens are never deleted when the access token expires.
 */
export class DurableCredentialStore<TCredential> implements CredentialStore<TCredential> {
  readonly #driver: DurableDriver;
  readonly #codec: CredentialCodec<TCredential>;

  constructor(options: DurableCredentialStoreOptions<TCredential>) {
    this.#driver = options.driver;
    this.#codec = options.codec;
  }

  async get(
    key: string,
  ): Promise<{ readonly value: TCredential; readonly revision: string } | undefined> {
    const stored = await guarded("credentials.get", () =>
      this.#driver.read({ namespace: "credential", key: validKey("credentials.get", key) }),
    );

    if (stored === undefined) return undefined;
    const record = parseRecord("credentials.get", stored.text);
    const text = record["credential"];

    const value =
      record["kind"] === "credential" && isStringValue(text) ? this.#codec.decode(text) : undefined;

    if (value === undefined) throw storeError("credentials.get", "Stored credential is malformed");

    return { value, revision: stored.revision };
  }

  async compareAndSet(input: {
    readonly key: string;
    readonly expectedRevision: string | undefined;
    readonly value: TCredential;
  }): Promise<{ readonly updated: boolean; readonly revision?: string }> {
    const revision = newRevision();
    const body = encodeRecord({ kind: "credential", credential: this.#codec.encode(input.value) });

    const updated = await guarded("credentials.save", () =>
      this.#driver.write({
        namespace: "credential",
        key: validKey("credentials.save", input.key),
        expectedRevision: input.expectedRevision,
        revision,
        text: body,
      }),
    );

    return updated ? { updated, revision } : { updated };
  }

  async delete(key: string): Promise<void> {
    await guarded("credentials.delete", () =>
      this.#driver.remove({ namespace: "credential", key: validKey("credentials.delete", key) }),
    );
  }

  deleteIfRevision(key: string, expectedRevision: string): Promise<boolean> {
    return guarded("credentials.delete", () =>
      this.#driver.remove({
        namespace: "credential",
        key: validKey("credentials.delete", key),
        expectedRevision,
      }),
    );
  }
}

export interface DurableCredentialLockOptions {
  readonly driver: DurableDriver;
  /**
   * Clock for reported `expiresAt` values. The SQL driver also compares lease
   * expiry with this clock, so workers sharing a table need synchronized clocks.
   */
  readonly now?: () => Date;
}

/** {@link CredentialLock} with random UUID lease tokens and owner-checked release. */
export class DurableCredentialLock implements CredentialLock {
  readonly #driver: DurableDriver;
  readonly #now: () => Date;

  constructor(options: DurableCredentialLockOptions) {
    this.#driver = options.driver;
    this.#now = options.now ?? (() => new Date());
  }

  #lease(key: string, token: string, ttlMs: number): CredentialLease {
    return { key, token, expiresAt: new Date(this.#now().getTime() + ttlMs).toISOString() };
  }

  async acquire(key: string, ttlMs: number): Promise<CredentialLease | undefined> {
    const ttl = positiveTtl("credentials.lock", ttlMs);
    const token = crypto.randomUUID();

    const acquired = await guarded("credentials.lock", () =>
      this.#driver.acquireLease({
        namespace: "credential-lease",
        key: validKey("credentials.lock", key),
        token,
        ttlMs: ttl,
      }),
    );

    return acquired ? this.#lease(key, token, ttl) : undefined;
  }

  /** Extends a lease this owner still holds. Returns undefined when it was lost or expired. */
  async renew(lease: CredentialLease, ttlMs: number): Promise<CredentialLease | undefined> {
    const ttl = positiveTtl("credentials.lock", ttlMs);

    const renewed = await guarded("credentials.lock", () =>
      this.#driver.renewLease({
        namespace: "credential-lease",
        key: validKey("credentials.lock", lease.key),
        token: lease.token,
        ttlMs: ttl,
      }),
    );

    return renewed ? this.#lease(lease.key, lease.token, ttl) : undefined;
  }

  async release(lease: CredentialLease): Promise<void> {
    await guarded("credentials.lock", () =>
      this.#driver.releaseLease({
        namespace: "credential-lease",
        key: validKey("credentials.lock", lease.key),
        token: lease.token,
      }),
    );
  }
}

// Idempotency --------------------------------------------------------------

interface ClaimRecord {
  readonly kind: "claim";
  readonly claimId: string;
  readonly fingerprint: string;
  readonly targetKeys: readonly string[];
  readonly outcomes: Readonly<Record<string, DeliveryOutcome>>;
}

function parsePreparationIssue(value: JsonValue): PreparationIssue | undefined {
  if (
    !isObjectValue(value) ||
    !isStringValue(value["code"]) ||
    !isStringValue(value["message"]) ||
    !isOptionalString(value["path"]) ||
    (value["targetIndex"] !== undefined && !isFiniteNumberValue(value["targetIndex"])) ||
    (value["severity"] !== "error" && value["severity"] !== "warning")
  )
    return undefined;
  const targetIndex = value["targetIndex"];

  return {
    code: value["code"],
    message: value["message"],
    severity: value["severity"],
    ...definedFields({
      path: value["path"],
      targetIndex: isFiniteNumberValue(targetIndex) ? targetIndex : undefined,
    }),
  };
}

function parseRetryDisposition(value: JsonValue | undefined): RetryDisposition | undefined {
  if (!isObjectValue(value)) return undefined;

  switch (value["kind"]) {
    case "never":
      return { kind: "never" };
    case "after-reconnect":
      return { kind: "after-reconnect" };
    case "reconcile-first":
      return { kind: "reconcile-first" };
    case "after-delay": {
      const delayMs = value["delayMs"];

      return isFiniteNumberValue(delayMs) ? { kind: "after-delay", delayMs } : undefined;
    }

    default:
      return undefined;
  }
}

function parseScopedRef<Kind extends "delivery" | "scheduled-job">(
  value: JsonValue | undefined,
  kind: Kind,
  idField: Kind extends "delivery" ? "deliveryId" : "jobId",
):
  | {
      readonly backend: string;
      readonly platform: string;
      readonly accountId: string;
      readonly id: string;
    }
  | undefined {
  if (
    !isObjectValue(value) ||
    value["kind"] !== kind ||
    value["version"] !== 1 ||
    !isStringValue(value["backend"]) ||
    !isStringValue(value["platform"]) ||
    !isStringValue(value["accountId"]) ||
    !isStringValue(value[idField])
  )
    return undefined;

  return {
    backend: value["backend"],
    platform: value["platform"],
    accountId: value["accountId"],
    id: value[idField],
  };
}

function parseDeliveryRef(value: JsonValue | undefined): DeliveryRef | undefined {
  const ref = parseScopedRef(value, "delivery", "deliveryId");

  return ref === undefined
    ? undefined
    : {
        kind: "delivery",
        version: 1,
        backend: ref.backend,
        platform: ref.platform,
        accountId: ref.accountId,
        deliveryId: ref.id,
      };
}

function parseDeliveryOutcome(value: JsonValue): DeliveryOutcome | undefined {
  if (
    !isObjectValue(value) ||
    !isFiniteNumberValue(value["targetIndex"]) ||
    !isStringValue(value["observedAt"]) ||
    !isOptionalString(value["backendState"])
  )
    return undefined;
  const account = parseAccountRef(value["account"]);

  const delivery =
    value["delivery"] === undefined ? undefined : parseDeliveryRef(value["delivery"]);

  if (account === undefined || (value["delivery"] !== undefined && delivery === undefined))
    return undefined;

  const base = {
    targetIndex: value["targetIndex"],
    account,
    observedAt: value["observedAt"],
    ...definedFields({ delivery, backendState: value["backendState"] }),
  };

  const mediaId = value["mediaId"];

  switch (value["state"]) {
    case "accepted":
      return { ...base, state: "accepted" };
    case "processing":
      return { ...base, state: "processing" };
    case "cancelled":
      return isOptionalString(value["reason"])
        ? { ...base, state: "cancelled", ...definedFields({ reason: value["reason"] }) }
        : undefined;
    case "scheduled": {
      const job = parseScopedRef(value["job"], "scheduled-job", "jobId");

      return job === undefined
        ? undefined
        : {
            ...base,
            state: "scheduled",
            job: {
              kind: "scheduled-job",
              version: 1,
              backend: job.backend,
              platform: job.platform,
              accountId: job.accountId,
              jobId: job.id,
            },
          };
    }

    case "published": {
      const post = value["post"];

      if (
        !isObjectValue(post) ||
        post["kind"] !== "platform-post" ||
        post["version"] !== 1 ||
        !isStringValue(post["backend"]) ||
        !isStringValue(post["platform"]) ||
        !isStringValue(post["accountId"]) ||
        !isStringValue(post["postId"]) ||
        (post["native"] !== undefined && !isObjectValue(post["native"])) ||
        !isOptionalString(value["url"])
      )
        return undefined;
      const native = post["native"];

      return {
        ...base,
        state: "published",
        post: {
          kind: "platform-post",
          version: 1,
          backend: post["backend"],
          platform: post["platform"],
          accountId: post["accountId"],
          postId: post["postId"],
          ...definedFields({ native: isObjectValue(native) ? native : undefined }),
        },
        ...definedFields({ url: value["url"] }),
      };
    }

    case "failed": {
      const retryDisposition = parseRetryDisposition(value["retryDisposition"]);

      if (
        !isStringValue(value["code"]) ||
        !isStringValue(value["message"]) ||
        !isOptionalString(mediaId) ||
        retryDisposition === undefined
      )
        return undefined;

      return {
        ...base,
        state: "failed",
        code: value["code"],
        message: value["message"],
        retryDisposition,
        ...definedFields({ mediaId }),
      };
    }

    case "unknown": {
      const reason = value["reason"];

      if (
        (reason !== "ambiguous-submission" && reason !== "unmapped-state") ||
        !isOptionalString(mediaId) ||
        !isOptionalString(value["diagnostic"])
      )
        return undefined;

      return {
        ...base,
        state: "unknown",
        reason,
        ...definedFields({ mediaId, diagnostic: value["diagnostic"] }),
      };
    }

    case "not-submitted": {
      const reason = value["reason"];

      const issues =
        value["issues"] === undefined
          ? undefined
          : parseList(value["issues"], parsePreparationIssue);

      if (
        (reason !== "validation" &&
          reason !== "unauthorized" &&
          reason !== "idempotency-conflict" &&
          reason !== "capacity" &&
          reason !== "before-submission") ||
        (value["issues"] !== undefined && issues === undefined)
      )
        return undefined;

      return { ...base, state: "not-submitted", reason, ...definedFields({ issues }) };
    }

    default:
      return undefined;
  }
}

function parseClaimRecord(record: JsonObjectValue): ClaimRecord {
  const outcomes = record["outcomes"];

  if (
    record["kind"] === "claim" &&
    isStringValue(record["claimId"]) &&
    isStringValue(record["fingerprint"]) &&
    isStringArray(record["targetKeys"]) &&
    isObjectValue(outcomes)
  ) {
    const parsed: Record<string, DeliveryOutcome> = {};
    let valid = true;

    for (const [targetKey, entry] of Object.entries(outcomes)) {
      const outcome = parseDeliveryOutcome(entry);

      if (outcome === undefined) valid = false;
      else parsed[targetKey] = outcome;
    }

    if (valid)
      return {
        kind: "claim",
        claimId: record["claimId"],
        fingerprint: record["fingerprint"],
        targetKeys: [...record["targetKeys"]],
        outcomes: parsed,
      };
  }

  throw storeError("idempotency.store", "Stored idempotency claim is malformed");
}

async function claimDocumentKey(scope: string, key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableSerialize([scope, key])),
  );

  let hex = "";

  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");

  return hex;
}

const CLAIM_ID_SEPARATOR = ".";

/**
 * {@link IdempotencyStore} on a {@link DurableDriver}. Claims and outcomes have
 * no TTL; unresolved claims stay until an operator removes them. A claim ID is
 * `<uuid>.<document key>`, so an outcome for a deleted and recreated claim is
 * rejected instead of merged into the new generation, and an outcome for an
 * absent claim never recreates it. Per-target outcomes merge under a revision
 * check, so concurrent writers for different targets do not overwrite each other.
 */
export class DurableIdempotencyStore implements IdempotencyStore {
  readonly #driver: DurableDriver;

  constructor(options: { readonly driver: DurableDriver }) {
    this.#driver = options.driver;
  }

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaim> {
    const documentKey = await claimDocumentKey(input.scope, input.key);

    return updateRecord<IdempotencyClaim>({
      driver: this.#driver,
      address: { namespace: "idempotency", key: documentKey },
      operation: "idempotency.claim",
      decide: (current) => {
        if (current !== undefined) {
          const existing = parseClaimRecord(current);

          if (
            existing.fingerprint !== input.fingerprint ||
            stableSerialize(existing.targetKeys) !== stableSerialize(input.targetKeys)
          )
            return { kind: "done", result: { kind: "conflict" } };

          return {
            kind: "done",
            result: { kind: "existing", claimId: existing.claimId, outcomes: existing.outcomes },
          };
        }

        const claimId = `${crypto.randomUUID()}${CLAIM_ID_SEPARATOR}${documentKey}`;

        return {
          kind: "write",
          body: encodeRecord<ClaimRecord>({
            kind: "claim",
            claimId,
            fingerprint: input.fingerprint,
            targetKeys: input.targetKeys,
            outcomes: {},
          }),
          result: { kind: "new", claimId, outcomes: {} },
        };
      },
    });
  }

  saveOutcome(input: {
    readonly claimId: string;
    readonly targetKey: string;
    readonly outcome: DeliveryOutcome;
  }): Promise<void> {
    const documentKey =
      input.claimId.length > 37 && input.claimId[36] === CLAIM_ID_SEPARATOR
        ? input.claimId.slice(37)
        : undefined;

    if (documentKey === undefined)
      return Promise.reject(
        storeError("idempotency.saveOutcome", "Unknown idempotency claim", "not_found"),
      );

    return updateRecord({
      driver: this.#driver,
      address: { namespace: "idempotency", key: documentKey },
      operation: "idempotency.saveOutcome",
      decide: (current) => {
        const existing = current === undefined ? undefined : parseClaimRecord(current);

        if (existing === undefined || existing.claimId !== input.claimId)
          throw storeError("idempotency.saveOutcome", "Unknown idempotency claim", "not_found");

        if (!existing.targetKeys.includes(input.targetKey))
          throw storeError(
            "idempotency.saveOutcome",
            "Target does not belong to this idempotency claim",
            "invalid_input",
          );

        return {
          kind: "write",
          body: encodeRecord<ClaimRecord>({
            ...existing,
            outcomes: { ...existing.outcomes, [input.targetKey]: input.outcome },
          }),
          result: undefined,
        };
      },
    });
  }
}

export interface DurableStores<TCredential> {
  readonly connections: DurableConnectionStore;
  readonly credentials: DurableCredentialStore<TCredential>;
  readonly credentialLock: DurableCredentialLock;
  readonly idempotency: DurableIdempotencyStore;
}

/** Builds every durable store on one driver. Runs no I/O. */
export function createDurableStores<TCredential>(input: {
  readonly driver: DurableDriver;
  readonly codec: CredentialCodec<TCredential>;
  readonly now?: (() => Date) | undefined;
}): DurableStores<TCredential> {
  const clock = definedFields({ now: input.now });

  return {
    connections: new DurableConnectionStore({ driver: input.driver, ...clock }),
    credentials: new DurableCredentialStore({ driver: input.driver, codec: input.codec }),
    credentialLock: new DurableCredentialLock({ driver: input.driver, ...clock }),
    idempotency: new DurableIdempotencyStore({ driver: input.driver }),
  };
}
