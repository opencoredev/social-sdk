/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/require-readable-spacing -- validated external boundary or fixture contract. */
import { SocialError } from "../core/errors.js";
import type { AdapterOperationContext, JsonObject, JsonValue } from "../core/types.js";
import { remainingBudget } from "../transport/budget.js";
import { abortable, retryDelay } from "../transport/http.js";
import { parseJson } from "../transport/json.js";
import type { XMediaField, XTweetExpansion, XTweetField, XUserField } from "./x.js";

// Filtered stream contract, checked 2026-09-24 against X API v2 OpenAPI 2.168:
// https://docs.x.com/x-api/posts/filtered-stream/introduction
// https://docs.x.com/x-api/stream/stream-filtered-posts
// https://docs.x.com/x-api/stream/get-stream-rules
// https://docs.x.com/x-api/stream/update-stream-rules
// https://docs.x.com/x-api/fundamentals/handling-disconnections
// https://docs.x.com/x-api/fundamentals/recovery-and-redundancy

/** X sends a `\r\n` keep-alive at least every 20 seconds and recommends a 20-second read timeout. */
export const xStreamDefaultStallTimeoutMs = 20_000;

/** Upper bound for one newline-delimited stream message held in memory. */
const maxMessageLength = 1024 * 1024;

const ruleIdPattern = /^[0-9]{1,19}$/;

/** A filtered-stream rule as stored by X. */
export interface XStreamRule {
  readonly id: string;
  readonly value: string;
  readonly tag?: string;
}

/** A rule to add. X limits values to 1,024 characters on pay-per-use and 2,048 on Enterprise. */
export interface XStreamRuleInput {
  readonly value: string;
  readonly tag?: string;
}

/** Result of one rule mutation. `errors` holds per-rule rejections that X returned with HTTP 200. */
export interface XStreamRulesUpdate {
  readonly dryRun: boolean;
  readonly rules: readonly XStreamRule[];
  readonly summary?: JsonObject;
  readonly errors: readonly JsonObject[];
}

export interface XMatchingRule {
  readonly id: string;
  readonly tag?: string;
}

/**
 * One message from the filtered stream. `post` carries a matched Post. `error` carries an
 * error-only message such as `operational-disconnect`; X usually closes the connection after it.
 * `other` preserves message types this adapter does not recognize yet.
 */
export type XStreamEvent =
  | {
      readonly kind: "post";
      readonly post: JsonObject;
      readonly matchingRules: readonly XMatchingRule[];
      readonly includes?: JsonObject;
      readonly errors?: readonly JsonObject[];
    }
  | { readonly kind: "error"; readonly errors: readonly JsonObject[] }
  | { readonly kind: "other"; readonly message: JsonObject };

export interface XStreamOptions {
  readonly tweetFields?: readonly XTweetField[];
  readonly expansions?: readonly XTweetExpansion[];
  readonly userFields?: readonly XUserField[];
  readonly mediaFields?: readonly XMediaField[];
  /** Minutes (1-5) of Posts to replay after a short disconnection. Enterprise access only. */
  readonly backfillMinutes?: number;
  /** Recovery window start (ISO 8601, within the last 24 hours). Enterprise access only. */
  readonly startTime?: string;
  /** Recovery window end (ISO 8601). X closes the connection after the window is replayed. */
  readonly endTime?: string;
  /** Fail with `timeout` when neither data nor a keep-alive arrives within this window. */
  readonly stallTimeoutMs?: number;
}

interface StreamConfig {
  readonly bearerToken: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

function jsonObjectValue(value: JsonValue | undefined): JsonObject | undefined {
  // SAFETY: parseJson produces the recursive JSON grammar; a non-null, non-array object is a JsonObject.
  return value !== null && value !== undefined && !Array.isArray(value) && Object(value) === value
    ? (value as JsonObject)
    : undefined;
}

function objectArray(value: JsonValue | undefined): readonly JsonObject[] | undefined {
  if (!Array.isArray(value)) return undefined;

  return value.flatMap((entry: JsonValue) => {
    const row = jsonObjectValue(entry);
    return row === undefined ? [] : [row];
  });
}

function stringValue(value: JsonValue | undefined): string | undefined {
  // SAFETY: the typeof guard narrows the JSON value to a string.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary.
  return typeof value === "string" ? value : undefined;
}

function invalidResponse(operation: string, message: string): SocialError {
  return new SocialError({
    code: "upstream_failure",
    operation,
    message,
    retryDisposition: { kind: "never" },
  });
}

/** Parse one rule object from X, rejecting malformed identifiers. */
export function parseStreamRule(value: JsonValue | undefined, operation: string): XStreamRule {
  const row = jsonObjectValue(value);
  const id = stringValue(row?.["id"]);
  const ruleValue = stringValue(row?.["value"]);
  const tag = stringValue(row?.["tag"]);

  if (id === undefined || !ruleIdPattern.test(id) || ruleValue === undefined)
    throw invalidResponse(operation, "X returned a filtered-stream rule without an id or value.");

  return { id, value: ruleValue, ...(tag === undefined ? {} : { tag }) };
}

/** Parse the rule-mutation response while keeping per-rule errors. */
export function parseRulesUpdate(value: JsonValue, dryRun: boolean): XStreamRulesUpdate {
  const operation = "x.streamRules.update";
  const body = jsonObjectValue(value);

  if (body === undefined) throw invalidResponse(operation, "X returned a non-object rule update.");

  const data = body["data"];
  const meta = jsonObjectValue(body["meta"]);
  const summary = jsonObjectValue(meta?.["summary"]);

  if (data !== undefined && !Array.isArray(data))
    throw invalidResponse(operation, "X returned a rule update whose data is not an array.");

  return {
    dryRun,
    rules: (data ?? []).map((entry: JsonValue) => parseStreamRule(entry, operation)),
    ...(summary === undefined ? {} : { summary }),
    errors: objectArray(body["errors"]) ?? [],
  };
}

/** Validate one rule for local bounds. X enforces the tier-specific limit. */
export function validateRuleInput(rule: XStreamRuleInput): void {
  if (!rule.value.trim() || rule.value.length > 2048)
    throw new SocialError({
      code: "invalid_input",
      operation: "x.streamRules.add",
      message: "X filtered-stream rule values must contain 1-2048 characters.",
    });

  if (rule.tag !== undefined && !rule.tag.trim())
    throw new SocialError({
      code: "invalid_input",
      operation: "x.streamRules.add",
      message: "X filtered-stream rule tags must not be empty when provided.",
    });
}

export function validateRuleIds(ids: readonly string[], operation: string, max: number): void {
  if (ids.length === 0 || ids.length > max || ids.some((id) => !ruleIdPattern.test(id)))
    throw new SocialError({
      code: "invalid_input",
      operation,
      message: `Provide 1-${max} numeric X filtered-stream rule IDs.`,
    });
}

/** Classify one newline-delimited message. */
export function parseStreamMessage(line: string): XStreamEvent {
  let parsed: JsonValue;

  try {
    parsed = parseJson(line);
  } catch {
    throw invalidResponse("streams.read", "X filtered stream sent an invalid JSON message.");
  }

  const message = jsonObjectValue(parsed);

  if (message === undefined)
    throw invalidResponse("streams.read", "X filtered stream sent a non-object message.");

  const post = jsonObjectValue(message["data"]);
  const errors = objectArray(message["errors"]);

  if (post !== undefined) {
    const includes = jsonObjectValue(message["includes"]);
    const rules = objectArray(message["matching_rules"]) ?? [];

    return {
      kind: "post",
      post,
      matchingRules: rules.flatMap((rule) => {
        const id = stringValue(rule["id"]);
        const tag = stringValue(rule["tag"]);
        return id === undefined ? [] : [{ id, ...(tag === undefined ? {} : { tag }) }];
      }),
      ...(includes === undefined ? {} : { includes }),
      ...(errors === undefined || errors.length === 0 ? {} : { errors }),
    };
  }

  if (errors !== undefined && errors.length > 0) return { kind: "error", errors };

  return { kind: "other", message };
}

function isoTime(value: string | undefined, name: string): void {
  if (value !== undefined && !Number.isFinite(Date.parse(value)))
    throw new SocialError({
      code: "invalid_input",
      operation: "streams.read",
      message: `${name} must be an ISO 8601 timestamp.`,
    });
}

/** Validate caller options and build the connection URL. Performs no I/O. */
export function streamUrl(options: XStreamOptions): URL {
  const backfill = options.backfillMinutes;

  if (backfill !== undefined && (!Number.isSafeInteger(backfill) || backfill < 0 || backfill > 5))
    throw new SocialError({
      code: "invalid_input",
      operation: "streams.read",
      message: "backfillMinutes must be an integer from 0 through 5.",
    });

  const stall = options.stallTimeoutMs;

  if (stall !== undefined && (!Number.isSafeInteger(stall) || stall < 1000 || stall > 600_000))
    throw new SocialError({
      code: "invalid_input",
      operation: "streams.read",
      message: "stallTimeoutMs must be an integer from 1000 through 600000.",
    });

  isoTime(options.startTime, "startTime");
  isoTime(options.endTime, "endTime");

  if (
    options.startTime !== undefined &&
    options.endTime !== undefined &&
    Date.parse(options.startTime) >= Date.parse(options.endTime)
  )
    throw new SocialError({
      code: "invalid_input",
      operation: "streams.read",
      message: "startTime must be earlier than endTime.",
    });

  const url = new URL("https://api.x.com/2/tweets/search/stream");
  const unique = (values: readonly string[]) =>
    values.filter((value, index) => values.indexOf(value) === index).join(",");

  if (options.tweetFields?.length)
    url.searchParams.set("tweet.fields", unique(options.tweetFields));

  if (options.expansions?.length) url.searchParams.set("expansions", unique(options.expansions));

  if (options.userFields?.length) url.searchParams.set("user.fields", unique(options.userFields));

  if (options.mediaFields?.length)
    url.searchParams.set("media.fields", unique(options.mediaFields));

  if (backfill !== undefined && backfill > 0)
    url.searchParams.set("backfill_minutes", String(backfill));

  if (options.startTime !== undefined) url.searchParams.set("start_time", options.startTime);

  if (options.endTime !== undefined) url.searchParams.set("end_time", options.endTime);

  return url;
}

function statusError(response: Response, context: AdapterOperationContext): SocialError {
  const status = response.status;
  const now = Date.now();
  let delay = retryDelay(response.headers.get("retry-after"), now);
  const reset = Number(response.headers.get("x-rate-limit-reset") ?? Number.NaN);

  if (delay === undefined && Number.isFinite(reset) && reset >= 0)
    delay = Math.max(0, reset * 1000 - now);

  const common = {
    operation: "streams.read",
    backend: context.backendInstance,
    correlationId: context.correlationId,
    upstreamStatus: status,
  };

  if (status === 401)
    return new SocialError({
      ...common,
      code: "reconnect_required",
      message: "X rejected the app-only bearer token for the filtered stream.",
      retryDisposition: { kind: "after-reconnect" },
    });

  if (status === 403)
    return new SocialError({
      ...common,
      code: "missing_permission",
      message:
        "X denied the filtered stream. It needs an app-only bearer token and pay-per-use or Enterprise access; backfill and recovery need Enterprise.",
      retryDisposition: { kind: "never" },
    });

  if (status === 402)
    return new SocialError({
      ...common,
      code: "billing_required",
      message: "X requires API credits or a plan change for the filtered stream.",
      retryDisposition: { kind: "never" },
    });

  if (status === 429)
    return new SocialError({
      ...common,
      code: "rate_limited",
      message:
        "X rate-limited the filtered stream connection or the connection limit is reached. Close other connections and back off before reconnecting.",
      retryDisposition:
        delay === undefined ? { kind: "never" } : { kind: "after-delay", delayMs: delay },
    });

  return new SocialError({
    ...common,
    code: "upstream_failure",
    message: `X filtered stream connection failed with HTTP ${status}.`,
    retryDisposition: { kind: "never" },
  });
}

/**
 * Open one filtered-stream connection and yield its messages. The connection is made when
 * iteration starts and closes when the caller stops iterating, the context signal aborts, the
 * stall timeout elapses, or X ends the response. This function never reconnects.
 */
export async function* readFilteredStream(
  config: StreamConfig,
  options: XStreamOptions,
  context: AdapterOperationContext,
): AsyncGenerator<XStreamEvent, void, undefined> {
  const url = streamUrl(options);
  const stallTimeoutMs = options.stallTimeoutMs ?? xStreamDefaultStallTimeoutMs;
  const outer = context.signal;
  const common = {
    operation: "streams.read",
    backend: context.backendInstance,
    correlationId: context.correlationId,
  };

  if (outer?.aborted)
    throw new SocialError({
      ...common,
      code: "cancelled",
      message: "The filtered stream was cancelled before connecting.",
    });

  const connectBudget = remainingBudget(context);
  const controller = new AbortController();
  const connectTimeout = new Error("connect timeout");
  const stalled = new Error("stalled");
  const onAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onAbort, { once: true });
  let timer = setTimeout(() => controller.abort(connectTimeout), connectBudget);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const interrupted = (phase: "connect" | "read"): SocialError => {
    const reason: unknown = controller.signal.reason;

    if (outer?.aborted)
      return new SocialError({
        ...common,
        code: "cancelled",
        message: "The filtered stream was cancelled by the caller.",
      });

    if (reason === connectTimeout || reason === stalled)
      return new SocialError({
        ...common,
        code: "timeout",
        message:
          reason === stalled
            ? `X filtered stream sent no data or keep-alive within ${stallTimeoutMs} ms. Reconnect explicitly.`
            : "X filtered stream did not connect within the operation budget.",
        retryDisposition: { kind: "never" },
      });

    return new SocialError({
      ...common,
      code: "upstream_failure",
      message:
        phase === "connect"
          ? "The filtered stream connection failed before X responded."
          : "The filtered stream connection dropped. Reconnect explicitly.",
      retryDisposition: { kind: "never" },
    });
  };

  try {
    let response: Response;

    try {
      const pending = (config.fetch ?? globalThis.fetch)(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${config.bearerToken}` },
        signal: controller.signal,
        redirect: "error",
      });
      void pending.then(
        (late) => {
          if (controller.signal.aborted) void late.body?.cancel().catch(() => undefined);
        },
        () => undefined,
      );
      response = await abortable(pending, controller.signal);
    } catch {
      throw interrupted("connect");
    }

    clearTimeout(timer);

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw statusError(response, context);
    }

    if (!response.body) throw invalidResponse("streams.read", "X returned an empty stream body.");

    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";

    for (;;) {
      timer = setTimeout(() => controller.abort(stalled), stallTimeoutMs);
      let chunk: ReadableStreamReadResult<Uint8Array>;

      try {
        chunk = await abortable(reader.read(), controller.signal);
      } catch {
        throw interrupted("read");
      } finally {
        clearTimeout(timer);
      }

      try {
        buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      } catch {
        throw invalidResponse("streams.read", "X filtered stream sent invalid UTF-8.");
      }

      const lines = buffer.split("\n");
      buffer = chunk.done ? "" : (lines.pop() ?? "");

      if (buffer.length > maxMessageLength)
        throw invalidResponse("streams.read", "X filtered stream message exceeds 1 MiB.");

      for (const line of lines) {
        const text = line.trim();

        // Blank lines are X keep-alive heartbeats.
        if (text) yield parseStreamMessage(text);
      }

      if (chunk.done) return;
    }
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
    if (!controller.signal.aborted) controller.abort(new Error("stream closed"));
    void reader?.cancel().catch(() => undefined);
  }
}
