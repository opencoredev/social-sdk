/** Preserve integer IDs that JSON.parse would otherwise round. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

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

  // SAFETY: JSON.parse returns the recursive JSON grammar represented by JsonValue.
  return JSON.parse(lossless) as JsonValue;
}

export function jsonObject(value: JsonValue): { readonly [key: string]: JsonValue } {
  if (value === null || Array.isArray(value) || Object(value) !== value)
    throw new TypeError("Expected a JSON object");

  // SAFETY: Object(value) === value and Array.isArray(value) is false establish a JSON object.
  return value as { readonly [key: string]: JsonValue };
}
