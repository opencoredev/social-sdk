import type { CredentialStore } from "../core/adapter.js";
import { SocialError, type SocialErrorCode } from "../core/errors.js";
import { definedFields } from "../core/fields.js";
import type { JsonValue } from "../core/types.js";
import { isJsonValue } from "../transport/json.js";
import { isJsonArray, isJsonObject, isString, type JsonField } from "../transport/validation.js";

export interface CredentialLease {
  readonly key: string;
  readonly token: string;
  readonly expiresAt: string;
}

export interface CredentialLock {
  acquire(key: string, ttlMs: number): Promise<CredentialLease | undefined>;
  release(lease: CredentialLease): Promise<void>;
}

/**
 * Persisted refresh progress. `in-flight` is written before the provider is
 * called; once its deadline passes without a result, or when the provider call
 * ends without a definite answer, the credential is treated as `uncertain` and
 * is not refreshed again until the application saves a new credential.
 */
export type CredentialRefreshState =
  | { readonly state: "in-flight"; readonly startedAt: string; readonly deadline: string }
  | { readonly state: "uncertain"; readonly since: string };

export interface StoredCredential {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** RFC 3339 access-token expiry. Absent means the access token does not expire. */
  readonly expiresAt?: string;
  readonly scopes?: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
  readonly refreshState?: CredentialRefreshState;
}

const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;

function isTimestamp(value: JsonField): value is string {
  return isString(value) && rfc3339.test(value) && !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value: JsonField): value is string {
  return isString(value) && value.length > 0;
}

function isStringList(value: JsonField): value is readonly string[] {
  return isJsonArray(value) && value.every(isString);
}

function isStringMap(value: JsonField): value is { readonly [key: string]: string } {
  return isJsonObject(value) && Object.values(value).every(isString);
}

const credentialFields = new Set([
  "accessToken",
  "refreshToken",
  "expiresAt",
  "scopes",
  "metadata",
  "refreshState",
]);

function invalidCredential(operation: string): never {
  throw new SocialError({
    code: "invalid_input",
    operation,
    message: "Credential is invalid",
  });
}

function parseRefreshState(value: JsonField, operation: string): CredentialRefreshState {
  if (!isJsonObject(value)) return invalidCredential(operation);
  const fields = Object.keys(value).length;
  const startedAt = value["startedAt"];
  const deadline = value["deadline"];
  const since = value["since"];

  if (
    value["state"] === "in-flight" &&
    fields === 3 &&
    isTimestamp(startedAt) &&
    isTimestamp(deadline)
  )
    return { state: "in-flight", startedAt, deadline };

  if (value["state"] === "uncertain" && fields === 2 && isTimestamp(since))
    return { state: "uncertain", since };

  return invalidCredential(operation);
}

/**
 * Strictly decodes a credential read from storage or returned by a refresher.
 * Unknown fields, empty tokens, and malformed timestamps are rejected. The
 * error never echoes the input.
 */
export function parseStoredCredential(
  value: StoredCredential | JsonValue,
  operation = "credentials.decode",
): StoredCredential {
  if (!isJsonValue(value) || !isJsonObject(value)) return invalidCredential(operation);

  for (const [field, entry] of Object.entries(value))
    if (!credentialFields.has(field) && entry !== undefined) return invalidCredential(operation);

  const accessToken = value["accessToken"];
  const refreshToken = value["refreshToken"];
  const expiresAt = value["expiresAt"];
  const scopes = value["scopes"];
  const metadata = value["metadata"];
  const refreshState = value["refreshState"];

  if (
    !isNonEmptyString(accessToken) ||
    (refreshToken !== undefined && !isNonEmptyString(refreshToken)) ||
    (expiresAt !== undefined && !isTimestamp(expiresAt)) ||
    (scopes !== undefined && !isStringList(scopes)) ||
    (metadata !== undefined && !isStringMap(metadata))
  )
    return invalidCredential(operation);

  return {
    accessToken,
    ...definedFields({
      refreshToken,
      expiresAt,
      scopes: scopes === undefined ? undefined : [...scopes],
      metadata: metadata === undefined ? undefined : { ...metadata },
      refreshState:
        refreshState === undefined ? undefined : parseRefreshState(refreshState, operation),
    }),
  };
}

function withoutRefreshState(value: StoredCredential): StoredCredential {
  const { refreshState: _refreshState, ...rest } = value;

  return rest;
}

export class MemoryCredentialStore implements CredentialStore<StoredCredential> {
  readonly #values = new Map<string, { value: StoredCredential; revision: string }>();
  #sequence = 0;

  async get(
    key: string,
  ): Promise<{ readonly value: StoredCredential; readonly revision: string } | undefined> {
    const found = this.#values.get(key);

    if (found === undefined) return undefined;
    const value = { ...found.value };

    if (found.value.scopes !== undefined) value.scopes = [...found.value.scopes];

    return { value, revision: found.revision };
  }

  async compareAndSet(input: {
    readonly key: string;
    readonly expectedRevision: string | undefined;
    readonly value: StoredCredential;
  }): Promise<{ readonly updated: boolean; readonly revision?: string }> {
    const current = this.#values.get(input.key);

    if ((current?.revision ?? undefined) !== input.expectedRevision) return { updated: false };
    const revision = `credential-${++this.#sequence}`;
    const value = { ...input.value };

    if (input.value.scopes !== undefined) value.scopes = [...input.value.scopes];

    this.#values.set(input.key, { value, revision });

    return { updated: true, revision };
  }

  async delete(key: string): Promise<void> {
    this.#values.delete(key);
  }

  async deleteIfRevision(key: string, expectedRevision: string): Promise<boolean> {
    if (this.#values.get(key)?.revision !== expectedRevision) return false;
    this.#values.delete(key);

    return true;
  }
}

export class MemoryCredentialLock implements CredentialLock {
  readonly #leases = new Map<string, CredentialLease>();
  readonly #clock: () => Date;
  #sequence = 0;

  constructor(options: { readonly clock?: () => Date } = {}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  async acquire(key: string, ttlMs: number): Promise<CredentialLease | undefined> {
    const current = this.#leases.get(key);
    const now = this.#clock().getTime();

    if (current !== undefined && Date.parse(current.expiresAt) > now) return undefined;

    const lease = {
      key,
      token: `lease-${++this.#sequence}`,
      expiresAt: new Date(now + ttlMs).toISOString(),
    };

    this.#leases.set(key, lease);

    return lease;
  }

  async release(lease: CredentialLease): Promise<void> {
    if (this.#leases.get(lease.key)?.token === lease.token) this.#leases.delete(lease.key);
  }
}

export interface CredentialRefreshRequest {
  readonly key: string;
  readonly credential: StoredCredential;
  /** Aborted when the refresh times out or the caller cancels. */
  readonly signal: AbortSignal;
}

/**
 * Calls the provider token endpoint. Return the complete next credential,
 * carrying over the previous refresh token when the provider does not rotate it.
 * Throw a `SocialError` for a definite provider answer. Any other error, or a
 * `SocialError` with code `ambiguous_outcome`, `timeout`, or `cancelled`, leaves
 * the credential marked uncertain because the provider may have rotated tokens.
 */
export type CredentialRefresher = (request: CredentialRefreshRequest) => Promise<StoredCredential>;

export interface CredentialRevokeRequest {
  readonly key: string;
  readonly credential: StoredCredential;
  readonly signal?: AbortSignal;
}

export type CredentialReconnectReason =
  | "missing-credential"
  | "invalid-credential"
  | "missing-refresh-token"
  | "refresh-unavailable"
  | "refresh-rejected"
  | "refresh-uncertain";

/** Safe metadata only: never tokens, provider responses, or raw errors. */
export interface CredentialReconnectRequiredEvent {
  readonly key: string;
  readonly reason: CredentialReconnectReason;
  readonly observedAt: string;
}

/** Safe metadata only: never tokens, provider responses, or raw errors. */
export interface CredentialRefreshFailureEvent {
  readonly key: string;
  /** `rejected` restored the previous credential; `uncertain` marked it for reconnect. */
  readonly outcome: "rejected" | "uncertain";
  readonly code: SocialErrorCode;
  readonly observedAt: string;
}

export interface CredentialManagerOptions {
  /** Lock lease length. Defaults to 30 seconds. */
  readonly lockTtlMs?: number;
  readonly refresh?: CredentialRefresher;
  /** Provider revocation, called before the local record is deleted. */
  readonly revoke?: (request: CredentialRevokeRequest) => Promise<void>;
  readonly clock?: () => Date;
  /** Refresh this long before expiry. Positive integer; defaults to 60 seconds. */
  readonly refreshSkewMs?: number;
  /** Provider refresh deadline. At most `lockTtlMs`; defaults to half of it. */
  readonly refreshTimeoutMs?: number;
  readonly onRefreshFailure?: (event: CredentialRefreshFailureEvent) => void | Promise<void>;
  readonly onReconnectRequired?: (event: CredentialReconnectRequiredEvent) => void | Promise<void>;
}

export interface ResolvedCredential {
  readonly value: StoredCredential;
  readonly revision: string;
  readonly freshness: "fresh" | "non-expiring" | "refreshed";
}

type Assessment =
  | { readonly kind: "usable"; readonly freshness: "fresh" | "non-expiring" }
  | { readonly kind: "refresh-due" }
  | { readonly kind: "refresh-in-flight"; readonly retryAfterMs: number }
  | { readonly kind: "refresh-uncertain" };

type BlockedAssessment = Exclude<Assessment, { readonly kind: "usable" | "refresh-due" }>;

/** `when-due` refreshes only near expiry; `forced` is an explicit rotation. */
type RefreshMode =
  | { readonly kind: "when-due" }
  | { readonly kind: "forced"; readonly refresh: CredentialRefresher };

type RefreshAttempt =
  | { readonly kind: "value"; readonly value: StoredCredential }
  | { readonly kind: "error"; readonly cause: unknown }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "not-started" };

const uncertainCodes: ReadonlySet<SocialErrorCode> = new Set([
  "ambiguous_outcome",
  "timeout",
  "cancelled",
]);

function isLockTtl(options: number | CredentialManagerOptions): options is number {
  return typeof options === "number";
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new SocialError({
      code: "invalid_config",
      operation: "credentials.configure",
      message: `${name} must be a positive integer`,
    });

  return value;
}

export class CredentialManager {
  readonly #store: CredentialStore<StoredCredential>;
  readonly #lock: CredentialLock;
  readonly #lockTtlMs: number;
  readonly #refreshTimeoutMs: number;
  readonly #skewMs: number;
  readonly #clock: () => Date;
  readonly #options: CredentialManagerOptions;

  constructor(
    store: CredentialStore<StoredCredential>,
    lock: CredentialLock,
    options: number | CredentialManagerOptions = {},
  ) {
    const resolved = isLockTtl(options) ? { lockTtlMs: options } : options;
    this.#store = store;
    this.#lock = lock;
    this.#options = resolved;
    this.#lockTtlMs = positiveInteger(resolved.lockTtlMs ?? 30_000, "lockTtlMs");
    this.#skewMs = positiveInteger(resolved.refreshSkewMs ?? 60_000, "refreshSkewMs");
    this.#refreshTimeoutMs = positiveInteger(
      resolved.refreshTimeoutMs ?? Math.max(1, Math.floor(this.#lockTtlMs / 2)),
      "refreshTimeoutMs",
    );
    this.#clock = resolved.clock ?? (() => new Date());

    if (this.#refreshTimeoutMs > this.#lockTtlMs)
      throw new SocialError({
        code: "invalid_config",
        operation: "credentials.configure",
        message: "refreshTimeoutMs must not exceed lockTtlMs",
      });
  }

  /** Reads the stored record as is, without expiry checks or refresh. */
  get(
    key: string,
  ): Promise<{ readonly value: StoredCredential; readonly revision: string } | undefined> {
    return this.#store.get(key);
  }

  async save(key: string, value: StoredCredential, expectedRevision?: string): Promise<string> {
    const result = await this.#store.compareAndSet({
      key,
      expectedRevision,
      value: parseStoredCredential(value, "credentials.save"),
    });

    if (!result.updated || result.revision === undefined)
      throw new SocialError({
        code: "upstream_failure",
        operation: "credentials.save",
        message: "Credential revision changed; reload before saving",
      });

    return result.revision;
  }

  /**
   * Returns a usable credential, refreshing it at most once under the lock when
   * it is within `refreshSkewMs` of expiry. A credential without `expiresAt` is
   * treated as non-expiring. Expiry never deletes the stored record.
   */
  async resolve(
    key: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ResolvedCredential> {
    const operation = "credentials.resolve";
    const current = await this.#read(key, operation);
    const assessment = this.#assess(current.value);

    if (assessment.kind === "usable") return { ...current, freshness: assessment.freshness };

    if (assessment.kind !== "refresh-due") return this.#blocked(key, assessment, operation);

    if (options.signal?.aborted) throw cancelledBeforeRefresh(operation);

    const lease = await this.#lock.acquire(key, this.#lockTtlMs);

    if (lease === undefined) throw busy(operation, this.#refreshTimeoutMs);

    try {
      if (options.signal?.aborted) throw cancelledBeforeRefresh(operation);

      return await this.#refreshHeld(key, operation, options.signal, { kind: "when-due" });
    } finally {
      await this.#release(lease);
    }
  }

  /**
   * Rotates a credential now, whatever its expiry, including non-expiring
   * credentials. It uses the same persisted refresh fence as `resolve`: an
   * in-flight or uncertain refresh blocks it, the in-flight marker is written
   * before `refresh` runs, `refresh` is bounded by `refreshTimeoutMs`, and an
   * ambiguous failure leaves the credential marked uncertain.
   */
  async rotate(
    key: string,
    refresh: (current: StoredCredential) => Promise<StoredCredential>,
  ): Promise<StoredCredential> {
    const operation = "credentials.rotate";
    const lease = await this.#lock.acquire(key, this.#lockTtlMs);

    if (lease === undefined) throw busy(operation, this.#refreshTimeoutMs);

    try {
      const rotated = await this.#refreshHeld(key, operation, undefined, {
        kind: "forced",
        refresh: (request) => refresh(request.credential),
      });

      return rotated.value;
    } finally {
      await this.#release(lease);
    }
  }

  /**
   * Revokes at the provider, then deletes the local record only if it is still
   * the revision that was revoked. If provider revocation fails, the error is
   * rethrown and the record is kept. If the record was replaced meanwhile, for
   * example by a reconnect, the replacement is kept and a conflict is thrown.
   * The store must implement `deleteIfRevision`; otherwise nothing is revoked.
   */
  async revoke(key: string, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    const operation = "credentials.revoke";
    const store = this.#store;

    if (store.deleteIfRevision === undefined)
      throw new SocialError({
        code: "invalid_config",
        operation,
        message: "revoke requires a credential store that implements deleteIfRevision",
      });

    const lease = await this.#lock.acquire(key, this.#lockTtlMs);

    if (lease === undefined) throw busy(operation, this.#refreshTimeoutMs);

    try {
      const current = await this.#store.get(key);

      if (current === undefined) return;
      const credential = parseStoredCredential(current.value, operation);
      const marker = credential.refreshState;

      if (marker?.state === "in-flight" && Date.parse(marker.deadline) > this.#clock().getTime())
        throw busy(operation, Date.parse(marker.deadline) - this.#clock().getTime());

      if (this.#options.revoke !== undefined)
        await this.#options.revoke({
          key,
          credential: withoutRefreshState(credential),
          ...definedFields({ signal: options.signal }),
        });

      if (await store.deleteIfRevision(key, current.revision)) return;

      if ((await store.get(key)) === undefined) return;

      throw new SocialError({
        code: "upstream_failure",
        operation,
        message: "The credential was replaced while it was being revoked; the replacement was kept",
        details: { reason: "credential-replaced" },
      });
    } finally {
      await this.#release(lease);
    }
  }

  /** Deletes the local record only. Use `revoke` to also revoke at the provider. */
  delete(key: string): Promise<void> {
    return this.#store.delete(key);
  }

  async #read(
    key: string,
    operation: string,
  ): Promise<{ readonly value: StoredCredential; readonly revision: string }> {
    const found = await this.#store.get(key);

    if (found === undefined) {
      await this.#notifyReconnect(key, "missing-credential");

      throw new SocialError({
        code: "reconnect_required",
        operation,
        message: "No credential is stored for this account",
      });
    }

    try {
      return { value: parseStoredCredential(found.value, operation), revision: found.revision };
    } catch (error) {
      await this.#notifyReconnect(key, "invalid-credential");
      throw error;
    }
  }

  #assess(value: StoredCredential): Assessment {
    if (value.expiresAt === undefined) return { kind: "usable", freshness: "non-expiring" };

    if (Date.parse(value.expiresAt) - this.#skewMs > this.#clock().getTime())
      return { kind: "usable", freshness: "fresh" };

    return this.#fence(value) ?? { kind: "refresh-due" };
  }

  /** The persisted refresh marker, if it forbids starting another refresh. */
  #fence(value: StoredCredential): BlockedAssessment | undefined {
    const marker = value.refreshState;

    if (marker === undefined) return undefined;

    switch (marker.state) {
      case "in-flight": {
        const remaining = Date.parse(marker.deadline) - this.#clock().getTime();

        return remaining > 0
          ? { kind: "refresh-in-flight", retryAfterMs: remaining }
          : { kind: "refresh-uncertain" };
      }

      case "uncertain":
        return { kind: "refresh-uncertain" };
      default: {
        const _exhaustive: never = marker;

        return _exhaustive;
      }
    }
  }

  async #blocked(key: string, assessment: BlockedAssessment, operation: string): Promise<never> {
    switch (assessment.kind) {
      case "refresh-in-flight":
        throw busy(operation, assessment.retryAfterMs);
      case "refresh-uncertain":
        return this.#reconnect(key, "refresh-uncertain", operation);
      default: {
        const _exhaustive: never = assessment;

        return _exhaustive;
      }
    }
  }

  async #reconnect(
    key: string,
    reason: CredentialReconnectReason,
    operation: string,
  ): Promise<never> {
    await this.#notifyReconnect(key, reason);

    throw new SocialError({
      code: "reconnect_required",
      operation,
      message:
        reason === "refresh-uncertain"
          ? "A previous credential refresh did not finish; reconnect the account"
          : "The credential expired and cannot be refreshed; reconnect the account",
      retryDisposition: { kind: "after-reconnect" },
    });
  }

  async #refreshHeld(
    key: string,
    operation: string,
    callerSignal: AbortSignal | undefined,
    mode: RefreshMode,
  ): Promise<ResolvedCredential> {
    // Re-read under the lock: another worker may have refreshed already.
    const latest = await this.#read(key, operation);

    if (callerSignal?.aborted) throw cancelledBeforeRefresh(operation);
    let refresher: CredentialRefresher;

    if (mode.kind === "forced") {
      const fence = this.#fence(latest.value);

      if (fence !== undefined) return this.#blocked(key, fence, operation);
      refresher = mode.refresh;
    } else {
      const assessment = this.#assess(latest.value);

      if (assessment.kind === "usable") return { ...latest, freshness: assessment.freshness };

      if (assessment.kind !== "refresh-due") return this.#blocked(key, assessment, operation);

      if (latest.value.refreshToken === undefined)
        return this.#reconnect(key, "missing-refresh-token", operation);

      if (this.#options.refresh === undefined)
        return this.#reconnect(key, "refresh-unavailable", operation);
      refresher = this.#options.refresh;
    }

    const startedAt = this.#clock();
    const deadline = new Date(startedAt.getTime() + this.#refreshTimeoutMs);

    const marked = await this.#store.compareAndSet({
      key,
      expectedRevision: latest.revision,
      value: {
        ...latest.value,
        refreshState: {
          state: "in-flight",
          startedAt: startedAt.toISOString(),
          deadline: deadline.toISOString(),
        },
      },
    });

    if (!marked.updated || marked.revision === undefined)
      throw busy(operation, this.#refreshTimeoutMs);

    const markerRevision = marked.revision;
    const attempt = await this.#attempt(refresher, key, latest.value, callerSignal);

    if (attempt.kind === "not-started") {
      // The provider was never called, so the previous credential is still valid.
      await this.#compareAndSetQuietly(key, markerRevision, latest.value);

      throw cancelledBeforeRefresh(operation);
    }

    if (attempt.kind === "value") {
      let next: StoredCredential;

      try {
        next = withoutRefreshState(parseStoredCredential(attempt.value, operation));
      } catch {
        return this.#failUncertain(key, markerRevision, latest.value, {
          code: "upstream_failure",
          error: new SocialError({
            code: "upstream_failure",
            operation,
            message: "Credential refresh returned an invalid credential",
          }),
        });
      }

      let saved: { readonly updated: boolean; readonly revision?: string };

      try {
        saved = await this.#store.compareAndSet({
          key,
          expectedRevision: markerRevision,
          value: next,
        });
      } catch (cause) {
        // The write may or may not have landed; the provider may have rotated tokens.
        return this.#failUncertain(key, markerRevision, latest.value, {
          code: "ambiguous_outcome",
          error: cause,
        });
      }

      if (!saved.updated || saved.revision === undefined) {
        const error = new SocialError({
          code: "ambiguous_outcome",
          operation,
          message:
            "Credential changed while refreshing; do not repeat the provider request blindly",
        });

        await this.#notifyFailure(key, "uncertain", error.code);
        throw error;
      }

      return { value: next, revision: saved.revision, freshness: "refreshed" };
    }

    if (attempt.kind === "timeout")
      return this.#failUncertain(key, markerRevision, latest.value, {
        code: "timeout",
        error: new SocialError({
          code: "timeout",
          operation,
          message: "Credential refresh did not finish before its deadline",
        }),
      });

    if (attempt.kind === "cancelled")
      return this.#failUncertain(key, markerRevision, latest.value, {
        code: "cancelled",
        error: new SocialError({
          code: "cancelled",
          operation,
          message: "Credential refresh was cancelled after the provider request started",
        }),
      });

    const error = attempt.cause;

    if (error instanceof SocialError && !uncertainCodes.has(error.code)) {
      // A definite provider answer: the previous credential is still the latest.
      await this.#compareAndSetQuietly(key, markerRevision, latest.value);
      await this.#notifyFailure(key, "rejected", error.code);

      if (error.code === "reconnect_required") await this.#notifyReconnect(key, "refresh-rejected");

      throw error;
    }

    return this.#failUncertain(key, markerRevision, latest.value, {
      code: error instanceof SocialError ? error.code : "ambiguous_outcome",
      error,
    });
  }

  async #failUncertain(
    key: string,
    markerRevision: string,
    previous: StoredCredential,
    failure: { readonly code: SocialErrorCode; readonly error: unknown },
  ): Promise<never> {
    await this.#compareAndSetQuietly(key, markerRevision, {
      ...previous,
      refreshState: { state: "uncertain", since: this.#clock().toISOString() },
    });
    await this.#notifyFailure(key, "uncertain", failure.code);
    await this.#notifyReconnect(key, "refresh-uncertain");

    throw failure.error;
  }

  async #attempt(
    refresher: CredentialRefresher,
    key: string,
    credential: StoredCredential,
    callerSignal: AbortSignal | undefined,
  ): Promise<RefreshAttempt> {
    if (callerSignal?.aborted) return { kind: "not-started" };

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onCallerAbort: (() => void) | undefined;
    let started = false;

    const timedOut = new Promise<RefreshAttempt>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: "timeout" });
      }, this.#refreshTimeoutMs);
    });

    const cancelled = new Promise<RefreshAttempt>((resolve) => {
      onCallerAbort = () => {
        controller.abort();
        resolve({ kind: "cancelled" });
      };

      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    });

    // Settles to a value so a late rejection after the deadline is never unhandled.
    const work = Promise.resolve().then((): RefreshAttempt | Promise<RefreshAttempt> => {
      if (controller.signal.aborted) return { kind: "not-started" };
      started = true;

      try {
        return refresher({ key, credential, signal: controller.signal }).then(
          (value): RefreshAttempt => ({ kind: "value", value }),
          (cause: unknown): RefreshAttempt => ({ kind: "error", cause }),
        );
      } catch (cause) {
        return { kind: "error", cause };
      }
    });

    try {
      const attempt = await Promise.race([work, timedOut, cancelled]);

      return started ? attempt : { kind: "not-started" };
    } finally {
      clearTimeout(timer);

      if (onCallerAbort !== undefined) callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  async #compareAndSetQuietly(
    key: string,
    expectedRevision: string,
    value: StoredCredential,
  ): Promise<void> {
    try {
      await this.#store.compareAndSet({ key, expectedRevision, value });
    } catch {
      // The in-flight marker stays and expires into the uncertain state.
    }
  }

  async #release(lease: CredentialLease): Promise<void> {
    try {
      await this.#lock.release(lease);
    } catch {
      // The lease expires on its own; a release failure must not mask the result.
    }
  }

  async #notifyReconnect(key: string, reason: CredentialReconnectReason): Promise<void> {
    const callback = this.#options.onReconnectRequired;

    if (callback === undefined) return;

    try {
      await callback({ key, reason, observedAt: this.#clock().toISOString() });
    } catch {
      // Notification failures never replace the credential outcome.
    }
  }

  async #notifyFailure(
    key: string,
    outcome: CredentialRefreshFailureEvent["outcome"],
    code: SocialErrorCode,
  ): Promise<void> {
    const callback = this.#options.onRefreshFailure;

    if (callback === undefined) return;

    try {
      await callback({ key, outcome, code, observedAt: this.#clock().toISOString() });
    } catch {
      // Notification failures never replace the credential outcome.
    }
  }
}

function busy(operation: string, retryAfterMs: number): SocialError {
  return new SocialError({
    code: "upstream_failure",
    operation,
    message: "Another worker is refreshing this credential",
    retryDisposition: { kind: "after-delay", delayMs: Math.max(1, retryAfterMs) },
  });
}

function cancelledBeforeRefresh(operation: string): SocialError {
  return new SocialError({
    code: "cancelled",
    operation,
    message: "Credential resolution was cancelled before refresh",
  });
}
