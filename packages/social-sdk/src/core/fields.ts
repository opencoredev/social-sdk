/**
 * Fields of `T` with `undefined` removed, each one optional. `T[K] & ({} | null)`
 * is the form TypeScript narrows a generic `T[K]` to after an `!== undefined`
 * check. For concrete types it matches `Exclude<T[K], undefined>`, except that an
 * `unknown` field becomes `{} | null`.
 */
export type DefinedFields<T> = { [K in keyof T]?: T[K] & ({} | null) };

/**
 * Copy only the fields whose value is defined, so optional properties stay
 * absent under `exactOptionalPropertyTypes` instead of being set to `undefined`.
 */
export function definedFields<T extends object>(fields: T): DefinedFields<T> {
  const result: DefinedFields<T> = {};

  for (const key in fields) {
    const value = fields[key];

    if (value === undefined) continue;

    result[key] = value;
  }

  return result;
}
