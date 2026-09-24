import type { JsonObject, JsonValue } from "../core/types.js";
import { HttpError } from "./http.js";

/** A decoded JSON field; `undefined` when the key is absent from its object. */
export type JsonField = JsonValue | undefined;

export function isJsonObject(value: JsonField): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: JsonField): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function isString(value: JsonField): value is string {
  return typeof value === "string";
}

export function isFiniteNumber(value: JsonField): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isBoolean(value: JsonField): value is boolean {
  return typeof value === "boolean";
}

export function object(value: JsonField): JsonObject {
  if (!isJsonObject(value))
    throw new HttpError("Upstream response must be an object.", "invalid-response", true);

  return value;
}

export function array(value: JsonField): readonly JsonValue[] {
  if (!isJsonArray(value))
    throw new HttpError("Upstream response must contain an array.", "invalid-response", true);

  return value;
}

export function string(value: JsonField): string {
  if (!isString(value) || !value)
    throw new HttpError(
      "Upstream response is missing a string identifier or required field.",
      "invalid-response",
      true,
    );

  return value;
}

export function optionalString(value: JsonField): string | undefined {
  return isString(value) ? value : undefined;
}

export function optionalNumber(value: JsonField): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

export function optionalBoolean(value: JsonField): boolean | undefined {
  return isBoolean(value) ? value : undefined;
}

export function optionalObject(value: JsonField): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

export function optionalArray(value: JsonField): readonly JsonValue[] | undefined {
  return isJsonArray(value) ? value : undefined;
}
