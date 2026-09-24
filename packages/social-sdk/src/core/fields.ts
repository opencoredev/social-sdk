/** Fields of `T` with `undefined` removed, each one optional. */
export type DefinedFields<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * Copy only the fields whose value is defined, so optional properties stay
 * absent under `exactOptionalPropertyTypes` instead of being set to `undefined`.
 */
export function definedFields<T extends object>(fields: T): DefinedFields<T> {
  const result: DefinedFields<T> = {};

  for (const key in fields) {
    const value = fields[key];

    if (value === undefined) continue;

    // SAFETY: the guard above removes undefined, which is the only difference
    // between T[K] and Exclude<T[K], undefined>; TypeScript cannot narrow a generic index.
    result[key] = value as Exclude<T[typeof key], undefined>;
  }

  return result;
}
