import { parseJson, type JsonValue } from "./json.js";

/* oxlint-disable anti-slop/no-unknown-returns -- Adapters validate provider-specific payloads at their boundary. */

/** Portable, bounded HTTP transport. Construction performs no I/O. */
export interface HttpOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onRequest?: (event: RequestEvent) => void | Promise<void>;
}

export interface RequestEvent {
  method: string;
  status?: number;
  attempt: number;
  elapsedMs: number;
}

export interface HttpRequest {
  url: URL;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: HeadersInit;
  body?: BodyInit;
  signal?: AbortSignal;
  /** Read retries only. Writes are never replayed by this transport. */
  maxAttempts?: number;
  /** Return only these selected response headers alongside the parsed body. */
  responseHeaders?: readonly string[];
  /** Per-operation elapsed budget, capped by the transport's configured deadline. */
  timeoutMs?: number;
}

export class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(
    message: string,
    readonly kind:
      | "http"
      | "network"
      | "timeout"
      | "cancelled"
      | "invalid-response"
      | "invalid-input",
    readonly dispatched: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export function retryDelay(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);

  if (value.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);

  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();

    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);

    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Enforce cancellation even when an injected I/O implementation ignores signals. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    throw signal.reason;
  }

  let abort: () => void = () => {};

  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });

  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function readJson(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<JsonValue> {
  if (response.status === 204 || !response.body) return null;
  const length = Number(response.headers.get("content-length"));

  if (Number.isFinite(length) && length > limit) {
    void response.body.cancel().catch(() => undefined);
    throw new HttpError(
      "Upstream response exceeds the configured byte limit.",
      "invalid-response",
      true,
      response.status,
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const chunk = await (signal ? abortable(reader.read(), signal) : reader.read());

      if (chunk.done) break;
      total += chunk.value.byteLength;

      if (total > limit)
        throw new HttpError(
          "Upstream response exceeds the configured byte limit.",
          "invalid-response",
          true,
          response.status,
        );
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

    if (!text.trim()) return null;

    return parseJson(text);
  } catch {
    throw new HttpError(
      "Upstream returned an invalid JSON response.",
      "invalid-response",
      true,
      response.status,
    );
  }
}

export function createHttp(options: HttpOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;

  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  ) {
    throw new HttpError(
      "HTTP timeout and response byte limit must be positive.",
      "invalid-input",
      false,
    );
  }

  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  return async function request(input: HttpRequest): Promise<unknown> {
    const deadlineMs = Math.min(timeoutMs, input.timeoutMs ?? timeoutMs);

    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
      throw new HttpError("Request elapsed budget must be positive.", "invalid-input", false);

    if (input.url.protocol !== "https:" || input.url.username || input.url.password) {
      throw new HttpError(
        "API URLs must use HTTPS without embedded credentials.",
        "invalid-input",
        false,
      );
    }

    const method = input.method ?? "GET";
    const safe = method === "GET" || method === "HEAD";
    const attempts = input.maxAttempts ?? 1;

    if (
      !Number.isSafeInteger(attempts) ||
      attempts < 1 ||
      attempts > 5 ||
      (!safe && attempts !== 1)
    ) {
      throw new HttpError(
        "Use one attempt for mutations and at most five attempts for reads.",
        "invalid-input",
        false,
      );
    }

    if (input.signal?.aborted)
      throw new HttpError("Request cancelled before dispatch.", "cancelled", false);
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });

    const timer = setTimeout(
      () => controller.abort(new Error("HTTP deadline exceeded")),
      deadlineMs,
    );

    const started = now();
    let dispatched = false;

    try {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        controller.signal.throwIfAborted();
        const attemptStarted = now();
        let status: number | undefined;
        let delay: number | undefined;

        try {
          dispatched = true;

          const requestInit: RequestInit = {
            method,
            signal: controller.signal,
            redirect: "error",
          };

          if (input.headers) requestInit.headers = input.headers;

          if (input.body !== undefined) requestInit.body = input.body;
          const pendingResponse = (options.fetch ?? globalThis.fetch)(input.url, requestInit);

          void pendingResponse.then(
            (response) => {
              if (controller.signal.aborted) void response.body?.cancel().catch(() => undefined);
            },
            () => undefined,
          );
          const response = await abortable(pendingResponse, controller.signal);
          status = response.status;

          if (response.ok) {
            const body =
              method === "HEAD" ? null : await readJson(response, maxBytes, controller.signal);

            if (!input.responseHeaders) return body;
            const headers: Record<string, string> = {};

            for (const name of input.responseHeaders) {
              const value = response.headers.get(name);

              if (value !== null) headers[name.toLowerCase()] = value;
            }

            return { body, headers };
          }

          delay = retryDelay(response.headers.get("retry-after"), now());
          void response.body?.cancel().catch(() => undefined);
          // Response bodies and URL query strings may contain credentials or user content.
          throw new HttpError(
            `Upstream request failed with HTTP ${response.status}.`,
            "http",
            true,
            response.status,
            delay,
          );
        } catch (error) {
          if (controller.signal.aborted) throw error;

          const retryable =
            !(error instanceof HttpError) ||
            (error.kind === "http" &&
              (error.status === 429 || (error.status !== undefined && error.status >= 500)));

          if (!safe || !retryable || attempt >= attempts) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(
              "Network request failed; a dispatched mutation may have been accepted.",
              "network",
              true,
            );
          }

          delay ??=
            Math.min(200 * 2 ** (attempt - 1), 5_000) * (0.5 + Math.max(0, Math.min(1, random())));
        } finally {
          if (options.onRequest) {
            // Diagnostics cannot change a write's outcome or leak a rejected promise.
            try {
              const requestEvent: RequestEvent = {
                method,
                attempt,
                elapsedMs: now() - attemptStarted,
              };

              if (status !== undefined) requestEvent.status = status;
              const pending = options.onRequest(requestEvent);

              if (pending) void pending.catch(() => undefined);
            } catch {
              /* application-owned diagnostics */
            }
          }
        }

        if (delay !== undefined) {
          if (now() - started + delay >= deadlineMs)
            throw new HttpError(
              "Retry delay exceeds the request deadline.",
              "timeout",
              dispatched,
              status,
              delay,
            );
          await abortable((options.sleep ?? sleep)(delay, controller.signal), controller.signal);
        }
      }

      throw new HttpError("Request attempt budget exhausted.", "network", dispatched);
    } catch (error) {
      if (input.signal?.aborted)
        throw new HttpError(
          "Request cancelled; a dispatched mutation may still complete remotely.",
          "cancelled",
          dispatched,
        );

      if (controller.signal.aborted)
        throw new HttpError(
          "Request deadline exceeded; reconcile dispatched mutations before retrying.",
          "timeout",
          dispatched,
        );
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    }
  };
}
