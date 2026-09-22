import type { DeliveryOutcome } from "./types.js";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening -- This module is the deliberate JSON boundary for arbitrary caller payloads. */

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

function normalizeForJson(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Idempotency payload numbers must be finite");

    return value;
  }

  if (typeof value === "undefined") return undefined;

  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    throw new TypeError("Idempotency payload must be JSON-safe");
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Idempotency payload must not contain cycles");
    seen.add(value);
    const result = value.map((entry) => normalizeForJson(entry, seen));
    seen.delete(value);

    return result;
  }

  if (typeof Blob !== "undefined" && value instanceof Blob) {
    throw new TypeError("Blob inputs require a caller-provided media fingerprint");
  }

  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Idempotency payload must not contain cycles");
    seen.add(value);
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    const result: Record<string, unknown> = {};

    for (const [key, entry] of entries) {
      const normalized = normalizeForJson(entry, seen);

      if (normalized !== undefined) result[key] = normalized;
    }

    seen.delete(value);

    return result;
  }

  throw new TypeError("Unsupported idempotency payload value");
}

export function stableSerialize(value: unknown): string {
  return JSON.stringify(normalizeForJson(value, new Set<object>()));
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";

  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");

  return result;
}

export async function fingerprint(value: unknown): Promise<string> {
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
