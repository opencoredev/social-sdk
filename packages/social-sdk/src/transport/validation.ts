import { HttpError } from "./http.js";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- These helpers validate unknown provider responses at the transport boundary. */

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError("Upstream response must be an object.", "invalid-response", true);
  }

  return value as Record<string, unknown>;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new HttpError("Upstream response must contain an array.", "invalid-response", true);

  return value;
}

export function string(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new HttpError(
      "Upstream response is missing a string identifier or required field.",
      "invalid-response",
      true,
    );

  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
