import type { DeliveryOutcome, JsonValue } from "./types.js";

export interface IdempotencyClaimInput {
  readonly scope: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly targetKeys: readonly string[];
}

export type IdempotencyClaim =
  | {
      readonly kind: "new" | "existing";
      readonly claimId: string;
      readonly outcomes: Readonly<Record<string, DeliveryOutcome>>;
    }
  | { readonly kind: "conflict" };

export interface IdempotencyStore {
  /** Atomically creates or reads a logical operation claim. */
  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaim>;
  /** Atomically persists one target outcome without replacing other target outcomes. */
  saveOutcome(input: {
    readonly claimId: string;
    readonly targetKey: string;
    readonly outcome: DeliveryOutcome;
  }): Promise<void>;
}

type JsonScalar = string | boolean | null;

function isJsonScalar<Value>(value: Value): value is Value & JsonScalar {
  return value === null || typeof value === "string" || typeof value === "boolean";
}

function isNumber<Value>(value: Value): value is Value & number {
  return typeof value === "number";
}

/** Arrays and plain or class objects; excludes bigints, symbols, and functions. */
function isWalkableObject<Value>(value: Value): value is Value & object {
  return typeof value === "object" && value !== null;
}

/**
 * Parses an arbitrary caller value into canonical JSON: object keys are sorted,
 * undefined properties are dropped, and values JSON cannot represent throw a TypeError.
 */
function normalizeForJson<Payload>(value: Payload, seen: Set<object>): JsonValue | undefined {
  if (isJsonScalar(value)) return value;

  if (isNumber(value)) {
    if (!Number.isFinite(value)) throw new TypeError("Idempotency payload numbers must be finite");

    return value;
  }

  if (value === undefined) return undefined;

  if (!isWalkableObject(value)) throw new TypeError("Idempotency payload must be JSON-safe");

  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Idempotency payload must not contain cycles");
    seen.add(value);
    // JSON.stringify writes an undefined array entry as null, so mapping it here keeps the output identical.
    const result = value.map((entry) => normalizeForJson(entry, seen) ?? null);
    seen.delete(value);

    return result;
  }

  if (typeof Blob !== "undefined" && value instanceof Blob) {
    throw new TypeError("Blob inputs require a caller-provided media fingerprint");
  }

  if (seen.has(value)) throw new TypeError("Idempotency payload must not contain cycles");
  seen.add(value);
  const entries = Object.entries(value);
  entries.sort(([left], [right]) => left.localeCompare(right));
  const result: { [key: string]: JsonValue } = {};

  for (const [key, entry] of entries) {
    const normalized = normalizeForJson(entry, seen);

    if (normalized !== undefined) result[key] = normalized;
  }

  seen.delete(value);

  return result;
}

/**
 * Serializes any caller value to canonical JSON. The input is parsed at runtime:
 * non-finite numbers, bigints, symbols, functions, `Blob`s, and cycles throw a TypeError.
 */
export function stableSerialize<Payload>(value: Payload): string {
  return JSON.stringify(normalizeForJson(value, new Set<object>()));
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";

  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");

  return result;
}

/** SHA-256 hex digest of {@link stableSerialize}. */
export async function fingerprint<Payload>(value: Payload): Promise<string> {
  const bytes = new TextEncoder().encode(stableSerialize(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return bytesToHex(new Uint8Array(digest));
}

export async function deriveTargetIdempotencyKey(input: {
  readonly logicalKey: string;
  readonly scope?: string;
  readonly backend: string;
  readonly targetKey: string;
  readonly payloadFingerprint: string;
}): Promise<string> {
  const digest = await fingerprint(input);

  return `social-${digest}`;
}
