/** Preserve integer IDs that JSON.parse would otherwise round. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * True when every member of `value` is a JSON primitive, array, or object. Object
 * properties set to `undefined` pass because reading them matches an absent key.
 * Cycles are rejected rather than followed.
 */
export function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return true;

  if (typeof value !== "object" || ancestors.has(value)) return false;

  ancestors.add(value);

  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.values(value).every((item) => item === undefined || isJsonValue(item, ancestors));

  ancestors.delete(value);

  return valid;
}

export function parseJson(text: string): JsonValue {
  // Match quoted strings first so digits within strings are never rewritten.
  const lossless = text.replace(
    /"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (token) => {
      if (token.startsWith('"') || /[.eE]/.test(token) || Number.isSafeInteger(Number(token)))
        return token;

      return `"${token}"`;
    },
  );

  const parsed: unknown = JSON.parse(lossless);

  // JSON.parse only yields this grammar; the check proves it to the type system.
  if (!isJsonValue(parsed)) throw new SyntaxError("Expected a JSON value");

  return parsed;
}

function isJsonObjectValue(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

export function jsonObject(value: JsonValue): { readonly [key: string]: JsonValue } {
  if (!isJsonObjectValue(value)) throw new TypeError("Expected a JSON object");

  return value;
}
