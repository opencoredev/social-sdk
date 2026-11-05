import { SocialError } from "../core/errors.js";
import { definedFields } from "../core/fields.js";
import type { AdapterOperationContext, JsonObject, JsonValue } from "../core/types.js";
import { remainingBudget } from "../transport/budget.js";
import { abortable, retryDelay } from "../transport/http.js";
import { parseJson } from "../transport/json.js";
import { fetchWithoutRedirects } from "../transport/redirect.js";
import { isJsonObject, isString } from "../transport/validation.js";
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
  /**
   * Minutes (1-5) of Posts to replay after a short disconnection. Enterprise access only.
   * `0` or omitted means no backfill; the SDK then leaves `backfill_minutes` off the request.
   */
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
  return value !== undefined && isJsonObject(value) ? value : undefined;
}

function objectArray(value: JsonValue | undefined): readonly JsonObject[] | undefined {
  if (!Array.isArray(value)) return undefined;

  return value.flatMap((entry: JsonValue) => {
    const row = jsonObjectValue(entry);

    return row === undefined ? [] : [row];
  });
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return value !== undefined && isString(value) ? value : undefined;
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

  return { id, value: ruleValue, ...definedFields({ tag }) };
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
    ...definedFields({ summary }),
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

        return id === undefined ? [] : [{ id, ...definedFields({ tag }) }];
      }),
      ...definedFields({
        includes,
        errors: errors !== undefined && errors.length > 0 ? errors : undefined,
      }),
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

function streamInput(message: string): SocialError {
  return new SocialError({ code: "invalid_input", operation: "streams.read", message });
}

/** Checks the recovery and stall options every X streaming endpoint shares. */
function validateWindow(options: {
  readonly backfillMinutes?: number | undefined;
  readonly startTime?: string | undefined;
  readonly endTime?: string | undefined;
  readonly stallTimeoutMs?: number | undefined;
}): void {
  const backfill = options.backfillMinutes;

  if (backfill !== undefined && (!Number.isSafeInteger(backfill) || backfill < 0 || backfill > 5))
    throw streamInput("backfillMinutes must be an integer from 1 through 5, or 0 for no backfill.");

  const stall = options.stallTimeoutMs;

  if (stall !== undefined && (!Number.isSafeInteger(stall) || stall < 1000 || stall > 600_000))
    throw streamInput("stallTimeoutMs must be an integer from 1000 through 600000.");

  isoTime(options.startTime, "startTime");
  isoTime(options.endTime, "endTime");

  if (
    options.startTime !== undefined &&
    options.endTime !== undefined &&
    Date.parse(options.startTime) >= Date.parse(options.endTime)
  )
    throw streamInput("startTime must be earlier than endTime.");
}

function setWindow(
  url: URL,
  options: {
    readonly backfillMinutes?: number | undefined;
    readonly startTime?: string | undefined;
    readonly endTime?: string | undefined;
  },
): void {
  if (options.backfillMinutes !== undefined && options.backfillMinutes > 0)
    url.searchParams.set("backfill_minutes", String(options.backfillMinutes));

  if (options.startTime !== undefined) url.searchParams.set("start_time", options.startTime);

  if (options.endTime !== undefined) url.searchParams.set("end_time", options.endTime);
}

function setFields(
  url: URL,
  options: Omit<XStreamOptions, "expansions"> & { readonly expansions?: readonly string[] },
): void {
  const unique = (values: readonly string[]) =>
    values.filter((value, index) => values.indexOf(value) === index).join(",");

  if (options.tweetFields?.length)
    url.searchParams.set("tweet.fields", unique(options.tweetFields));

  if (options.expansions?.length) url.searchParams.set("expansions", unique(options.expansions));

  if (options.userFields?.length) url.searchParams.set("user.fields", unique(options.userFields));

  if (options.mediaFields?.length)
    url.searchParams.set("media.fields", unique(options.mediaFields));
}

/** Validate caller options and build the connection URL. Performs no I/O. */
export function streamUrl(options: XStreamOptions): URL {
  validateWindow(options);

  const url = new URL("https://api.x.com/2/tweets/search/stream");

  setFields(url, options);
  setWindow(url, options);

  return url;
}

/**
 * Volume streams (Enterprise). `sample` is the 1% sample, `sample10` the 10% sample (Decahose),
 * `firehose` all public Posts, `firehose_<lang>` the language firehoses, and `likes_*` public Likes.
 */
export type XVolumeStream =
  | "sample"
  | "sample10"
  | "firehose"
  | "firehose_en"
  | "firehose_ja"
  | "firehose_ko"
  | "firehose_pt"
  | "likes_firehose"
  | "likes_sample10";

/** Compliance streams (Enterprise): Post, user and Like compliance events, and Post labels. */
export type XComplianceStream = "posts" | "users" | "likes" | "labels";

interface StreamRoute {
  readonly path: string;
  /** Highest partition number; omitted when the endpoint takes no partition. */
  readonly partitions?: number;
  /** Whether the endpoint accepts `start_time` and `end_time`. */
  readonly window: boolean;
  /**
   * Which field and expansion parameters the endpoint accepts: Post streams take the Post set,
   * Likes streams their own expansions, and the rest none.
   */
  readonly fields: "post" | "like" | "none";
}

// Paths, partition ranges and parameters from X OpenAPI 2.173 (checked 2026-11-04):
// https://docs.x.com/x-api/posts/volume-streams/introduction
// https://docs.x.com/x-api/compliance/streams/introduction
const volumeRoutes: Readonly<Record<XVolumeStream, StreamRoute>> = {
  sample: { path: "/2/tweets/sample/stream", window: false, fields: "post" },
  sample10: { path: "/2/tweets/sample10/stream", partitions: 2, window: true, fields: "post" },
  firehose: { path: "/2/tweets/firehose/stream", partitions: 20, window: true, fields: "post" },
  firehose_en: {
    path: "/2/tweets/firehose/stream/lang/en",
    partitions: 8,
    window: true,
    fields: "post",
  },
  firehose_ja: {
    path: "/2/tweets/firehose/stream/lang/ja",
    partitions: 2,
    window: true,
    fields: "post",
  },
  firehose_ko: {
    path: "/2/tweets/firehose/stream/lang/ko",
    partitions: 2,
    window: true,
    fields: "post",
  },
  firehose_pt: {
    path: "/2/tweets/firehose/stream/lang/pt",
    partitions: 2,
    window: true,
    fields: "post",
  },
  likes_firehose: {
    path: "/2/likes/firehose/stream",
    partitions: 20,
    window: true,
    fields: "like",
  },
  likes_sample10: {
    path: "/2/likes/sample10/stream",
    partitions: 2,
    window: true,
    fields: "like",
  },
};

const complianceRoutes: Readonly<Record<XComplianceStream, StreamRoute>> = {
  posts: { path: "/2/tweets/compliance/stream", partitions: 4, window: true, fields: "none" },
  users: { path: "/2/users/compliance/stream", partitions: 4, window: true, fields: "none" },
  likes: { path: "/2/likes/compliance/stream", window: true, fields: "none" },
  labels: { path: "/2/tweets/label/stream", window: true, fields: "none" },
};

/** Expansions X documents for the Likes volume streams (OpenAPI 2.173). */
export type XLikeExpansion = "attachments.media_keys" | "liked_tweet_author_id" | "liked_tweet_id";

const likeExpansions: ReadonlySet<string> = new Set<XLikeExpansion>([
  "attachments.media_keys",
  "liked_tweet_author_id",
  "liked_tweet_id",
]);

/** Post expansions that only the Likes streams accept. */
const likeOnlyExpansions: ReadonlySet<string> = new Set<XLikeExpansion>([
  "liked_tweet_author_id",
  "liked_tweet_id",
]);

/** Post fields the Likes streams do not list in their `tweet.fields` enum. */
const nonLikeTweetFields: ReadonlySet<string> = new Set<XTweetField>(["note_post"]);

/** Options for the volume, compliance and Activity streams. */
export interface XDataStreamOptions extends Omit<XStreamOptions, "expansions"> {
  /**
   * Post streams take Post expansions. The Likes streams take `attachments.media_keys`,
   * `liked_tweet_author_id`, and `liked_tweet_id`.
   */
  readonly expansions?: readonly (XTweetExpansion | XLikeExpansion)[];
  /** Required by partitioned endpoints: 1 through the endpoint's partition count. */
  readonly partition?: number;
}

/**
 * One message from a volume, compliance or Activity stream. `data` carries X's `data` object
 * unchanged: a Post, a Like, a compliance event such as `{ delete: ... }`, or an Activity event
 * with `event_type` and `payload`.
 */
export type XDataStreamEvent =
  | {
      readonly kind: "data";
      readonly data: JsonObject;
      readonly includes?: JsonObject;
      readonly errors?: readonly JsonObject[];
    }
  | { readonly kind: "error"; readonly errors: readonly JsonObject[] }
  | { readonly kind: "other"; readonly message: JsonObject };

function routeUrl(route: StreamRoute, name: string, options: XDataStreamOptions): URL {
  validateWindow(options);

  if (route.partitions === undefined) {
    if (options.partition !== undefined) throw streamInput(`The ${name} takes no partition.`);
  } else if (
    options.partition === undefined ||
    !Number.isSafeInteger(options.partition) ||
    options.partition < 1 ||
    options.partition > route.partitions
  )
    throw streamInput(`The ${name} needs a partition from 1 through ${route.partitions}.`);

  if (!route.window && (options.startTime !== undefined || options.endTime !== undefined))
    throw streamInput(`The ${name} has no startTime/endTime recovery window.`);

  const fields =
    options.tweetFields ?? options.expansions ?? options.userFields ?? options.mediaFields;

  if (route.fields === "none" && fields !== undefined)
    throw streamInput(`The ${name} does not take field or expansion options.`);

  const expansions = options.expansions ?? [];

  if (route.fields === "post") {
    const unsupported = expansions.find((expansion) => likeOnlyExpansions.has(expansion));

    if (unsupported !== undefined)
      throw streamInput(`The ${name} does not take the ${unsupported} expansion.`);
  }

  if (route.fields === "like") {
    const unsupported =
      expansions.find((expansion) => !likeExpansions.has(expansion)) ??
      options.tweetFields?.find((field) => nonLikeTweetFields.has(field));

    if (unsupported !== undefined)
      throw streamInput(`The ${name} does not take ${unsupported}; X documents it for Posts only.`);
  }

  const url = new URL(`https://api.x.com${route.path}`);

  if (route.fields !== "none") setFields(url, options);

  if (options.partition !== undefined) url.searchParams.set("partition", String(options.partition));

  setWindow(url, options);

  return url;
}

/** Builds the URL of a volume stream. Performs no I/O. */
export function volumeStreamUrl(stream: XVolumeStream, options: XDataStreamOptions): URL {
  return routeUrl(volumeRoutes[stream], `${stream} stream`, options);
}

/** Builds the URL of a compliance stream. Performs no I/O. */
export function complianceStreamUrl(stream: XComplianceStream, options: XDataStreamOptions): URL {
  return routeUrl(complianceRoutes[stream], `${stream} compliance stream`, options);
}

/** Builds the URL of the X Activity API stream (`GET /2/activity/stream`). Performs no I/O. */
export function activityStreamUrl(options: XDataStreamOptions): URL {
  return routeUrl(
    { path: "/2/activity/stream", window: true, fields: "none" },
    "activity stream",
    options,
  );
}

/** Classify one newline-delimited message from a volume, compliance or Activity stream. */
export function parseDataStreamMessage(line: string, name: string): XDataStreamEvent {
  let parsed: JsonValue;

  try {
    parsed = parseJson(line);
  } catch {
    throw invalidResponse("streams.read", `X ${name} sent an invalid JSON message.`);
  }

  const message = jsonObjectValue(parsed);

  if (message === undefined)
    throw invalidResponse("streams.read", `X ${name} sent a non-object message.`);

  const data = jsonObjectValue(message["data"]);
  const errors = objectArray(message["errors"]);

  if (data !== undefined)
    return {
      kind: "data",
      data,
      ...definedFields({
        includes: jsonObjectValue(message["includes"]),
        errors: errors !== undefined && errors.length > 0 ? errors : undefined,
      }),
    };

  if (errors !== undefined && errors.length > 0) return { kind: "error", errors };

  return { kind: "other", message };
}

/** What a connection is for: its URL, a name used in errors, and the 403 explanation. */
export interface StreamTarget {
  readonly url: URL;
  readonly name: string;
  readonly denied: string;
  readonly stallTimeoutMs?: number | undefined;
}

function statusError(
  response: Response,
  context: AdapterOperationContext,
  target: StreamTarget,
): SocialError {
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
      message: `X rejected the app-only bearer token for the ${target.name}.`,
      retryDisposition: { kind: "after-reconnect" },
    });

  if (status === 403)
    return new SocialError({
      ...common,
      code: "missing_permission",
      message: target.denied,
      retryDisposition: { kind: "never" },
    });

  if (status === 402)
    return new SocialError({
      ...common,
      code: "billing_required",
      message: `X requires API credits or a plan change for the ${target.name}.`,
      retryDisposition: { kind: "never" },
    });

  if (status === 429)
    return new SocialError({
      ...common,
      code: "rate_limited",
      message: `X rate-limited the ${target.name} connection or the connection limit is reached. Close other connections and back off before reconnecting.`,
      retryDisposition: { kind: "after-delay", delayMs: delay ?? 60_000 },
    });

  return new SocialError({
    ...common,
    code: "upstream_failure",
    message: `X ${target.name} connection failed with HTTP ${status}.`,
    retryDisposition: { kind: "never" },
  });
}

/**
 * Open one streaming connection and yield its non-blank lines. The connection is made when
 * iteration starts and closes when the caller stops iterating, the context signal aborts, the
 * stall timeout elapses, or X ends the response. This function never reconnects.
 */
export async function* readStreamLines(
  config: StreamConfig,
  target: StreamTarget,
  context: AdapterOperationContext,
): AsyncGenerator<string, void, undefined> {
  const { url, name } = target;
  const stallTimeoutMs = target.stallTimeoutMs ?? xStreamDefaultStallTimeoutMs;
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
      message: `The ${name} was cancelled before connecting.`,
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
        message: `The ${name} was cancelled by the caller.`,
      });

    if (reason === connectTimeout || reason === stalled)
      return new SocialError({
        ...common,
        code: "timeout",
        message:
          reason === stalled
            ? `X ${name} sent no data or keep-alive within ${stallTimeoutMs} ms. Reconnect explicitly.`
            : `X ${name} did not connect within the operation budget.`,
        retryDisposition: { kind: "never" },
      });

    return new SocialError({
      ...common,
      code: "upstream_failure",
      upstreamCode: "stream-connection-interrupted",
      message:
        phase === "connect"
          ? `The ${name} connection failed before X responded.`
          : `The ${name} connection dropped. Reconnect explicitly.`,
      retryDisposition: { kind: "never" },
    });
  };

  try {
    let response: Response;

    try {
      const pending = fetchWithoutRedirects(config.fetch ?? globalThis.fetch, url, {
        method: "GET",
        headers: { Authorization: `Bearer ${config.bearerToken}` },
        signal: controller.signal,
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
      throw statusError(response, context, target);
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
        throw invalidResponse("streams.read", `X ${name} sent invalid UTF-8.`);
      }

      const lines = buffer.split("\n");
      buffer = chunk.done ? "" : (lines.pop() ?? "");

      if (buffer.length > maxMessageLength)
        throw invalidResponse("streams.read", `X ${name} message exceeds 1 MiB.`);

      for (const line of lines) {
        if (line.length > maxMessageLength)
          throw invalidResponse("streams.read", `X ${name} message exceeds 1 MiB.`);

        const text = line.trim();

        // Blank lines are X keep-alive heartbeats.
        if (text) yield text;
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
  const target: StreamTarget = {
    url: streamUrl(options),
    name: "filtered stream",
    denied:
      "X denied the filtered stream. It needs an app-only bearer token and pay-per-use or Enterprise access; backfill and recovery need Enterprise.",
    stallTimeoutMs: options.stallTimeoutMs,
  };

  for await (const line of readStreamLines(config, target, context)) yield parseStreamMessage(line);
}

/** Open one volume, compliance or Activity stream connection and yield its messages. */
export async function* readDataStream(
  config: StreamConfig,
  target: StreamTarget,
  context: AdapterOperationContext,
): AsyncGenerator<XDataStreamEvent, void, undefined> {
  for await (const line of readStreamLines(config, target, context))
    yield parseDataStreamMessage(line, target.name);
}
