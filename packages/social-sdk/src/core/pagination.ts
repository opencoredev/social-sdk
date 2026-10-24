import { SocialError } from "./errors.js";
import type { Page } from "./types.js";

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
export interface CursorLimits {
  readonly maxValueLength: number;
  readonly maxEncodedLength: number;
}

const defaultLimits: CursorLimits = { maxValueLength: 16_384, maxEncodedLength: 100_000 };

export function encodeCursor(
  scope: string,
  value: string,
  limits: CursorLimits = defaultLimits,
): string {
  if (!value || value.length > limits.maxValueLength)
    throw new SocialError({
      code: "upstream_failure",
      operation: "pagination",
      message: "Backend returned an invalid cursor",
    });

  const encoded = `social-v1.${encodeURIComponent(JSON.stringify([scope, value]))}`;

  if (encoded.length > limits.maxEncodedLength)
    throw new SocialError({
      code: "upstream_failure",
      operation: "pagination",
      message: "Backend returned an invalid cursor",
    });

  return encoded;
}

/** A decoded cursor body: `[scope, upstreamCursor]`. */
function isCursorPayload(value: unknown): value is readonly [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string"
  );
}

export function decodeCursor(
  scope: string,
  cursor: string,
  limits: CursorLimits = defaultLimits,
): string {
  try {
    if (!cursor.startsWith("social-v1.") || cursor.length > limits.maxEncodedLength)
      throw new Error();
    const parsed: unknown = JSON.parse(decodeURIComponent(cursor.slice(10)));

    if (
      !isCursorPayload(parsed) ||
      parsed[0] !== scope ||
      !parsed[1] ||
      parsed[1].length > limits.maxValueLength
    )
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
