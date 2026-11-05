import { SocialError } from "../core/errors.js";
import type { AdapterOperationContext, JsonObject } from "../core/types.js";
import { definedFields } from "../core/fields.js";
import { remainingBudget } from "../transport/budget.js";
import { abortable, retryDelay } from "../transport/http.js";
import { parseJson, type JsonValue } from "../transport/json.js";
import { providerErrorDecoder } from "../transport/provider-errors.js";
import { fetchWithoutRedirects } from "../transport/redirect.js";
import {
  array,
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  object,
  optionalString,
} from "../transport/validation.js";

/** One response from `liveChatMessages.streamList`: a page of messages, oldest first. */
export interface YouTubeLiveChatStreamPage {
  readonly items: readonly JsonObject[];
  /** Pass the last one as `pageToken` to resume after a reconnect. */
  readonly nextPageToken?: string;
  /** Set once the broadcast's chat has gone offline; no more messages will arrive. */
  readonly offlineAt?: string;
  readonly pollingIntervalMillis?: number;
  readonly activePollItem?: JsonObject;
  readonly raw: JsonObject;
}

const operation = "live.chat.stream";

/** A page holds at most 2000 messages; cap one response element well above that. */
const maxElementLength = 16 * 1024 * 1024;

const maxErrorBodyLength = 64 * 1024;

function invalidStream(message: string): SocialError {
  return new SocialError({
    code: "upstream_failure",
    operation,
    message,
    retryDisposition: { kind: "never" },
  });
}

/** Decode one streamed LiveChatMessageListResponse, or raise the error element Google sent. */
export function decodeLiveChatStreamElement(text: string): YouTubeLiveChatStreamPage {
  let value: JsonValue;

  try {
    value = parseJson(text);
  } catch {
    throw invalidStream("YouTube live chat stream sent malformed JSON.");
  }

  if (!isJsonObject(value)) throw invalidStream("YouTube live chat stream sent a non-object.");

  const failure = value["error"];

  if (isJsonObject(failure)) {
    const status = failure["code"];

    const upstreamCode = optionalString(failure["status"]);

    throw new SocialError({
      code: "upstream_failure",
      operation,
      message: "YouTube ended the live chat stream with an error. Resume with the last pageToken.",
      upstreamStatus: isFiniteNumber(status) ? status : undefined,
      upstreamCode,
      retryDisposition: { kind: "never" },
    });
  }

  const interval = value["pollingIntervalMillis"];

  const nextPageToken = optionalString(value["nextPageToken"]);

  const offlineAt = optionalString(value["offlineAt"]);

  const activePollItem =
    value["activePollItem"] === undefined ? undefined : object(value["activePollItem"]);

  return {
    items: array(value["items"] ?? []).map(object),
    ...definedFields({
      nextPageToken,
      offlineAt,
      pollingIntervalMillis: isFiniteNumber(interval) ? interval : undefined,
      activePollItem,
    }),
    raw: value,
  };
}

type FramingState = "before" | "between" | "element" | "done";

/**
 * Split Google's HTTP/JSON framing of a server-streamed method into its elements. Google sends
 * one JSON array whose elements arrive as the server produces them (`[{...}\n,{...}\n]`); a
 * plain JSON object is accepted as a single element. Text is fed in chunks; each call returns
 * the elements completed so far.
 */
export class JsonArrayStreamSplitter {
  private state: FramingState = "before";

  private array = false;

  private depth = 0;

  private inString = false;

  private escaped = false;

  private current = "";

  push(text: string): string[] {
    const complete: string[] = [];

    for (const char of text) {
      if (this.state === "element") {
        this.current += char;

        if (this.current.length > maxElementLength)
          throw invalidStream("YouTube live chat stream element exceeds 16 MiB.");

        if (this.inString) {
          if (this.escaped) this.escaped = false;
          else if (char === "\\") this.escaped = true;
          else if (char === '"') this.inString = false;

          continue;
        }

        if (char === '"') this.inString = true;
        else if (char === "{" || char === "[") this.depth += 1;
        else if (char === "}" || char === "]") this.depth -= 1;

        if (this.depth === 0) {
          complete.push(this.current);
          this.current = "";
          this.state = this.array ? "between" : "done";
        }

        continue;
      }

      if (/\s/u.test(char)) continue;

      if (this.state === "before" && char === "[") {
        this.array = true;
        this.state = "between";

        continue;
      }

      if ((this.state === "before" || this.state === "between") && char === "{") {
        this.state = "element";
        this.depth = 1;
        this.current = char;

        continue;
      }

      if (this.state === "between" && char === ",") continue;

      if (this.state === "between" && char === "]") {
        this.state = "done";

        continue;
      }

      throw invalidStream("YouTube live chat stream framing is not a JSON array of objects.");
    }

    return complete;
  }

  /** True once the closing `]` (or the single object) has arrived. */
  get finished(): boolean {
    return this.state === "done";
  }
}

async function errorBody(response: Response): Promise<JsonValue | undefined> {
  try {
    const text = await response.text();

    return text.length > maxErrorBodyLength ? undefined : parseJson(text);
  } catch {
    return undefined;
  }
}

/** Reads `error.errors[].reason` from a Google API error body. */
function googleErrorReasons(body: JsonValue | undefined): string[] {
  if (!isJsonObject(body)) return [];

  const error = body["error"];

  if (!isJsonObject(error)) return [];

  const errors = error["errors"];

  if (!isJsonArray(errors)) return [];

  const reasons: string[] = [];

  for (const item of errors)
    if (isJsonObject(item) && isString(item["reason"])) reasons.push(item["reason"]);

  return reasons;
}

async function statusError(
  response: Response,
  path: string,
  context: AdapterOperationContext,
): Promise<SocialError> {
  const status = response.status;

  const body = await errorBody(response);

  const reason =
    body === undefined
      ? undefined
      : providerErrorDecoder("https://www.googleapis.com", path)(body, status)?.code;

  const delayMs = retryDelay(response.headers.get("retry-after"), Date.now());

  const common = {
    operation,
    backend: context.backendInstance,
    correlationId: context.correlationId,
    upstreamStatus: status,
  };

  // Over-frequent stream requests answer 403 rateLimitExceeded, not a permission problem.
  // Source, accessed 2026-11-04:
  // https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList
  const throttled = googleErrorReasons(body).some(
    (item) => item === "rateLimitExceeded" || item === "userRateLimitExceeded",
  );

  if (reason === "quotaExceeded" || status === 429 || throttled)
    return new SocialError({
      ...common,
      code: "rate_limited",
      message: "YouTube refused the live chat stream for quota or rate limits.",
      upstreamCode: reason,
      retryDisposition:
        delayMs === undefined ? { kind: "never" } : { kind: "after-delay", delayMs },
    });

  if (status === 401)
    return new SocialError({
      ...common,
      code: "reconnect_required",
      message: "YouTube rejected the access token for the live chat stream.",
      retryDisposition: { kind: "after-reconnect" },
    });

  return new SocialError({
    ...common,
    code:
      status === 403
        ? "missing_permission"
        : status === 404
          ? "not_found"
          : status === 400
            ? "invalid_input"
            : "upstream_failure",
    message: `YouTube live chat stream failed with HTTP ${status}.`,
    retryDisposition: { kind: "never" },
  });
}

export interface LiveChatStreamConnection {
  readonly url: URL;
  readonly accessToken: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Abort if no bytes arrive for this long. Google documents no keep-alive interval. */
  readonly stallTimeoutMs?: number;
}

/**
 * Open one `liveChatMessages.streamList` connection and yield each response page as it arrives.
 * The request is sent when iteration starts. The connection closes when the caller stops
 * iterating, the context signal aborts, the optional stall timeout elapses, or YouTube ends the
 * response. It never reconnects; resume with the last page's `nextPageToken`.
 */
export async function* readLiveChatStream(
  connection: LiveChatStreamConnection,
  context: AdapterOperationContext,
): AsyncGenerator<YouTubeLiveChatStreamPage, void, undefined> {
  const outer = context.signal;

  const common = {
    operation,
    backend: context.backendInstance,
    correlationId: context.correlationId,
  };

  if (outer?.aborted)
    throw new SocialError({
      ...common,
      code: "cancelled",
      message: "The live chat stream was cancelled before connecting.",
    });

  const connectBudget = remainingBudget(context);

  const controller = new AbortController();

  const connectTimeout = new Error("connect timeout");

  const stalled = new Error("stalled");

  const onAbort = () => controller.abort(outer?.reason);

  outer?.addEventListener("abort", onAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => controller.abort(connectTimeout),
    connectBudget,
  );

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const interrupted = (phase: "connect" | "read"): SocialError => {
    const reason: unknown = controller.signal.reason;

    if (outer?.aborted)
      return new SocialError({
        ...common,
        code: "cancelled",
        message: "The live chat stream was cancelled by the caller.",
      });

    if (reason === connectTimeout || reason === stalled)
      return new SocialError({
        ...common,
        code: "timeout",
        message:
          reason === stalled
            ? "YouTube live chat stream sent no data within stallTimeoutMs. Resume with the last pageToken."
            : "YouTube live chat stream did not connect within the operation budget.",
        retryDisposition: { kind: "never" },
      });

    return new SocialError({
      ...common,
      code: "upstream_failure",
      upstreamCode: "stream-connection-interrupted",
      message:
        phase === "connect"
          ? "The live chat stream connection failed before YouTube responded."
          : "The live chat stream connection dropped. Resume with the last pageToken.",
      retryDisposition: { kind: "never" },
    });
  };

  try {
    let response: Response;

    try {
      const pending = fetchWithoutRedirects(connection.fetch ?? globalThis.fetch, connection.url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          Accept: "application/json",
        },
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
    timer = undefined;

    if (!response.ok) throw await statusError(response, connection.url.pathname, context);

    if (!response.body) throw invalidStream("YouTube returned an empty live chat stream body.");

    reader = response.body.getReader();

    const decoder = new TextDecoder("utf-8", { fatal: true });

    const splitter = new JsonArrayStreamSplitter();

    for (;;) {
      if (connection.stallTimeoutMs !== undefined)
        timer = setTimeout(() => controller.abort(stalled), connection.stallTimeoutMs);

      let chunk: ReadableStreamReadResult<Uint8Array>;

      try {
        chunk = await abortable(reader.read(), controller.signal);
      } catch {
        throw interrupted("read");
      } finally {
        clearTimeout(timer);
        timer = undefined;
      }

      let text: string;

      try {
        text = chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      } catch {
        throw invalidStream("YouTube live chat stream sent invalid UTF-8.");
      }

      for (const element of splitter.push(text)) yield decodeLiveChatStreamElement(element);

      if (chunk.done) {
        if (!splitter.finished)
          throw new SocialError({
            ...common,
            code: "upstream_failure",
            upstreamCode: "stream-connection-interrupted",
            message: "The live chat stream ended mid-response. Resume with the last pageToken.",
            retryDisposition: { kind: "never" },
          });

        return;
      }
    }
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);

    if (!controller.signal.aborted) controller.abort(new Error("stream closed"));
    void reader?.cancel().catch(() => undefined);
  }
}
