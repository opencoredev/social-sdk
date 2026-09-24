import { SocialError } from "./errors.js";
import type { JsonValue, Page } from "./types.js";

export interface IterationOptions {
  readonly maxPages?: number;
  readonly maxItems?: number;
  readonly signal?: AbortSignal;
}

/** Lazy traversal with explicit bounds, cancellation and repeated-cursor detection. */
export async function* iterateItems<T>(
  read: (cursor?: string) => Promise<Page<T>>,
  options: IterationOptions = {},
): AsyncGenerator<T> {
  const maxPages = options.maxPages ?? 100;
  const maxItems = options.maxItems ?? 10_000;

  if (
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    !Number.isSafeInteger(maxItems) ||
    maxItems < 1
  )
    throw new SocialError({
      code: "invalid_input",
      operation: "pagination",
      message: "Iteration bounds must be positive safe integers",
    });
  const seen = new Set<string>();
  let cursor: string | undefined;
  let count = 0;

  for (let index = 0; index < maxPages; index++) {
    if (options.signal?.aborted)
      throw new SocialError({
        code: "cancelled",
        operation: "pagination",
        message: "Iteration was cancelled",
      });
    const page = await read(cursor);

    for (const item of page.items) {
      if (options.signal?.aborted)
        throw new SocialError({
          code: "cancelled",
          operation: "pagination",
          message: "Iteration was cancelled",
        });
      yield item;

      if (++count >= maxItems) return;
    }

    if (page.nextCursor === undefined) return;

    if (!page.nextCursor || seen.has(page.nextCursor))
      throw new SocialError({
        code: "upstream_failure",
        operation: "pagination",
        message: "Backend returned an empty or repeated pagination cursor",
      });
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

/** Cursors bind navigation to its query scope; they are never authorization grants. */
export function encodeCursor(scope: string, value: string): string {
  if (!value || value.length > 16_384)
    throw new SocialError({
      code: "upstream_failure",
      operation: "pagination",
      message: "Backend returned an invalid cursor",
    });

  return `social-v1.${encodeURIComponent(JSON.stringify([scope, value]))}`;
}

/** A decoded cursor body: `[scope, upstreamCursor]`. */
function isCursorPayload(value: JsonValue): value is readonly [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string"
  );
}

export function decodeCursor(scope: string, cursor: string): string {
  try {
    if (!cursor.startsWith("social-v1.") || cursor.length > 100_000) throw new Error();
    const parsed: JsonValue = JSON.parse(decodeURIComponent(cursor.slice(10)));

    if (!isCursorPayload(parsed) || parsed[0] !== scope || !parsed[1] || parsed[1].length > 16_384)
      throw new Error();

    return parsed[1];
  } catch {
    throw new SocialError({
      code: "invalid_input",
      operation: "pagination",
      message: "Cursor does not belong to this backend, tenant, and query",
    });
  }
}
