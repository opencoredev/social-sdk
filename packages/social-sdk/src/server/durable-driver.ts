import { SocialError } from "../core/errors.js";
import type { RetryDisposition } from "../core/types.js";
import { parseJson, type JsonValue } from "../transport/json.js";

/**
 * Storage primitive behind the durable stores: one JSON document per
 * `(namespace, key)` guarded by an opaque revision, plus owned TTL leases.
 *
 * Documents never expire. Bodies are stored as given, so encryption at rest is
 * the caller's job: use encrypted storage, or wrap a driver so `write` seals
 * `text` and `read` opens it. Connection attempts hold PKCE verifiers and
 * provider state (for Bluesky, a DPoP private key), and credentials hold
 * access and refresh tokens.
 */
export interface DurableDriver {
  read(
    input: DurableAddress,
  ): Promise<{ readonly text: string; readonly revision: string } | undefined>;
  /**
   * Writes `text` under the new `revision` only when the stored revision equals
   * `expectedRevision`; `undefined` means the document must not exist. Returns
   * false when the precondition failed. Must be atomic.
   */
  write(
    input: DurableAddress & {
      readonly expectedRevision: string | undefined;
      readonly revision: string;
      readonly text: string;
    },
  ): Promise<boolean>;
  /** Deletes the document, only at `expectedRevision` when given. */
  remove(input: DurableAddress & { readonly expectedRevision?: string }): Promise<boolean>;
  /** Takes the lease when it is free or expired. */
  acquireLease(input: DurableLeaseInput & { readonly ttlMs: number }): Promise<boolean>;
  /** Extends a lease that `token` still holds and that has not expired. */
  renewLease(input: DurableLeaseInput & { readonly ttlMs: number }): Promise<boolean>;
  /** Frees a lease only when `token` still holds it. */
  releaseLease(input: DurableLeaseInput): Promise<boolean>;
}

export interface DurableAddress {
  readonly namespace: DurableNamespace;
  readonly key: string;
}

export interface DurableLeaseInput {
  readonly namespace: DurableNamespace;
  readonly key: string;
  readonly token: string;
}

/** Fixed namespaces keep stores from reading each other's documents. */
export type DurableNamespace = "connection" | "credential" | "credential-lease" | "idempotency";

export const durableNamespaces: readonly DurableNamespace[] = [
  "connection",
  "credential",
  "credential-lease",
  "idempotency",
];

export const DURABLE_RECORD_VERSION = 1;

/** Bounded retries for revision races between local writers. Never wraps provider calls. */
const MAX_CAS_ATTEMPTS = 16;

export type JsonObjectValue = { readonly [key: string]: JsonValue };

export function isObjectValue(value: JsonValue | undefined): value is JsonObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringValue(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

export function isOptionalString(value: JsonValue | undefined): value is string | undefined {
  return value === undefined || isStringValue(value);
}

export function isStringArray(value: JsonValue | undefined): value is string[] {
  return Array.isArray(value) && value.every(isStringValue);
}

/** Errors issued by the SDK's own storage code, whose fixed messages are safe to surface. */
const issued = new WeakSet<SocialError>();

/** Marks an SDK-built error with fixed, non-secret fields as safe to pass through `guarded`. */
export function issuedError(error: SocialError): SocialError {
  issued.add(error);

  return error;
}

export function storeError(
  operation: string,
  message: string,
  code: SocialError["code"] = "upstream_failure",
): SocialError {
  const error = new SocialError({ code, operation, message });

  issued.add(error);

  return error;
}

/**
 * Runs a storage call and replaces any failure the SDK did not issue with a generic
 * error. Drivers, executors, and application stores can echo statement parameters or
 * written records, which may hold tokens, verifiers, or provider state. A SocialError
 * keeps its code and retry disposition; nothing else from it survives.
 */
export async function guarded<Result>(
  operation: string,
  run: () => Promise<Result>,
  /** Retry disposition for failures that are not SocialErrors. */
  fallbackRetry: RetryDisposition = { kind: "never" },
): Promise<Result> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SocialError && issued.has(error)) throw error;

    const replacement =
      error instanceof SocialError
        ? new SocialError({
            code: error.code,
            operation,
            message: "Durable store request failed",
            retryDisposition: error.retryDisposition,
          })
        : new SocialError({
            code: "upstream_failure",
            operation,
            message: "Durable store request failed",
            details: { errorName: error instanceof Error ? error.name : "unknown" },
            retryDisposition: fallbackRetry,
          });

    issued.add(replacement);
    throw replacement;
  }
}

export function newRevision(): string {
  return crypto.randomUUID();
}

/** Parses a stored body into a versioned JSON object, or throws a sanitized error. */
export function parseRecord(operation: string, text: string): JsonObjectValue {
  let parsed: JsonValue;

  try {
    parsed = parseJson(text);
  } catch {
    throw storeError(operation, "Stored record is not valid JSON");
  }

  if (!isObjectValue(parsed) || parsed["v"] !== DURABLE_RECORD_VERSION)
    throw storeError(operation, "Stored record has an unsupported version");

  return parsed;
}

export type CasDecision<Result> =
  /** `body` comes from {@link encodeRecord}. */
  | { readonly kind: "write"; readonly body: string; readonly result: Result }
  | { readonly kind: "delete"; readonly result: Result }
  | { readonly kind: "done"; readonly result: Result };

/**
 * Read-decide-write loop over one document. `decide` must be pure: it can run
 * several times when other writers race, up to a fixed bound. Throwing from
 * `decide` aborts without writing.
 */
export async function updateRecord<Result>(input: {
  readonly driver: DurableDriver;
  readonly address: DurableAddress;
  readonly operation: string;
  readonly decide: (current: JsonObjectValue | undefined) => CasDecision<Result>;
}): Promise<Result> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const stored = await guarded(input.operation, () => input.driver.read(input.address));

    const decision = input.decide(
      stored === undefined ? undefined : parseRecord(input.operation, stored.text),
    );

    if (decision.kind === "done") return decision.result;

    if (decision.kind === "delete") {
      if (stored === undefined) return decision.result;

      const removed = await guarded(input.operation, () =>
        input.driver.remove({ ...input.address, expectedRevision: stored.revision }),
      );

      if (removed) return decision.result;
      continue;
    }

    const written = await guarded(input.operation, () =>
      input.driver.write({
        ...input.address,
        expectedRevision: stored?.revision,
        revision: newRevision(),
        text: decision.body,
      }),
    );

    if (written) return decision.result;
  }

  throw storeError(input.operation, "Durable record stayed contended; try again later");
}

/** Serializes a store's typed record with the current format version. */
export function encodeRecord<Body extends { readonly kind: string }>(body: Body): string {
  return JSON.stringify({ v: DURABLE_RECORD_VERSION, ...body });
}

export function positiveTtl(operation: string, ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
    throw storeError(operation, "ttlMs must be a positive safe integer", "invalid_input");

  return ttlMs;
}

export function validKey(operation: string, key: string): string {
  if (key.length === 0 || key.length > 1024)
    throw storeError(operation, "Store keys must be 1 to 1024 characters", "invalid_input");

  return key;
}
