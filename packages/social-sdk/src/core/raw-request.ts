import { remainingBudget } from "../transport/budget.js";
import {
  abortable,
  HttpError,
  readBytes,
  requestId,
  retryDelay,
  type HttpErrorData,
} from "../transport/http.js";
import { parseJson, type JsonValue } from "../transport/json.js";
import { httpSocialError, providerErrorDecoder } from "../transport/provider-errors.js";
import { fetchWithoutRedirects } from "../transport/redirect.js";
import { SocialError } from "./errors.js";
import { definedFields } from "./fields.js";
import type {
  AdapterOperationContext,
  CapabilityDeclaration,
  ConnectedAccountRef,
} from "./types.js";

/*
 * Raw provider requests: one host-locked call to an endpoint the SDK does not wrap. Every adapter
 * exposes it as `native.request` (Zernio: `zernioNative(options).request`). The adapter supplies
 * its hosts, credentials and error decoding; this module validates the request, dispatches it once
 * and bounds the response. Root imports re-export only the types.
 */

export type RawRequestMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RawResponseType = "json" | "text" | "bytes";

/** Request body. The variant sets `Content-Type`; callers cannot set it as a header. */
export type RawRequestBody =
  | { readonly kind: "json"; readonly value: JsonValue }
  | { readonly kind: "text"; readonly value: string; readonly contentType: string }
  | { readonly kind: "bytes"; readonly value: Blob; readonly contentType: string }
  /** Multipart form data. `fetch` sets the boundary. */
  | { readonly kind: "form"; readonly value: FormData }
  | { readonly kind: "urlencoded"; readonly value: Readonly<Record<string, string>> };

export interface RawProviderRequest<THost extends string = string> {
  /** One of the adapter's named hosts. Defaults to the adapter's main API host. */
  readonly host?: THost;
  readonly method: RawRequestMethod;
  /**
   * Path below the host's base URL, starting with `/`, such as `/me/accounts` on Facebook's
   * versioned Graph base. Absolute URLs, `//`, `..` segments, `?` and `#` are rejected.
   */
  readonly path: string;
  /** A list value repeats the parameter once per entry. Credential parameters are rejected. */
  readonly query?: Readonly<Record<string, string | readonly string[]>>;
  readonly body?: RawRequestBody;
  /** Extra request headers. Credential, cookie, framing and `Content-Type` headers are rejected. */
  readonly headers?: Readonly<Record<string, string>>;
  /** How to decode the response body. Defaults to `json`. */
  readonly responseType?: RawResponseType;
  /** Response headers to return in addition to the default set. `set-cookie` is never returned. */
  readonly responseHeaders?: readonly string[];
  /** Response body limit in bytes, from 1 through 16 MiB. Defaults to 2 MiB. */
  readonly maxResponseBytes?: number;
}

/** A raw request on a direct platform adapter, made for its one authorized account. */
export interface AccountRawProviderRequest<
  THost extends string = string,
> extends RawProviderRequest<THost> {
  readonly account: ConnectedAccountRef;
}

interface RawResponseBase {
  readonly status: number;
  /** Lowercase names: the default set plus `responseHeaders`, when present. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface RawJsonResponse extends RawResponseBase {
  readonly responseType: "json";
  /** `null` for an empty body, a `HEAD` request or HTTP 204. */
  readonly body: JsonValue;
}

export interface RawTextResponse extends RawResponseBase {
  readonly responseType: "text";
  readonly body: string;
}

export interface RawBytesResponse extends RawResponseBase {
  readonly responseType: "bytes";
  readonly body: Uint8Array;
}

/** A 2xx response. Non-2xx responses reject with a `SocialError`. */
export type RawProviderResponse = RawJsonResponse | RawTextResponse | RawBytesResponse;

/** What the adapter's credential hook may change just before dispatch. */
export interface RawDispatch<THost extends string> {
  readonly host: THost;
  readonly method: RawRequestMethod;
  /** Path relative to the host's base URL, as validated. */
  readonly path: string;
  readonly url: URL;
  readonly headers: Headers;
}

/** Adapter wiring for raw requests. Internal: adapters build it from their own options. */
export interface RawRequestConfig<THost extends string> {
  /** Base URL per host name. An absent entry is a host this configuration does not use. */
  readonly hosts: Readonly<Partial<Record<THost, string>>>;
  readonly defaultHost: THost;
  readonly fetch: (host: THost) => typeof globalThis.fetch;
  /** Applies the adapter's own credentials after caller input is validated. */
  readonly authorize: (
    dispatch: RawDispatch<THost>,
    context: AdapterOperationContext,
  ) => void | Promise<void>;
  /** Credential headers beyond the shared list, lowercase, such as `pf-api-key`. */
  readonly reservedHeaders?: readonly string[];
  /** Credential query parameters, such as `access_token` and `appsecret_proof`. */
  readonly reservedQuery?: readonly string[];
  /**
   * Query parameters that change the HTTP method, such as Meta Graph's `method`. A `GET` carrying
   * one could be a write, which would lose the uncertainty a lost write response must keep, so
   * these are rejected before any request; send the real HTTP method instead.
   */
  readonly methodOverrideQuery?: readonly string[];
  readonly decodeError?: (
    body: JsonValue,
    status: number,
    dispatch: RawDispatch<THost>,
  ) => HttpErrorData | undefined;
  /** Refines a mapped failure with the adapter's provider rules, such as Meta code 190. */
  readonly mapError?: (error: SocialError, body: JsonValue | undefined) => SocialError;
  /** The adapter's configured transport deadline, when it has one. */
  readonly timeoutMs?: number;
}

const operation = "native.request";

const maxLimit = 16 * 1024 * 1024;

const defaultLimit = 2 * 1024 * 1024;

const methods: ReadonlySet<string> = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

const sharedReservedHeaders = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "dpop",
  "content-type",
  "content-length",
  "transfer-encoding",
  "connection",
];

const defaultResponseHeaders = [
  "content-type",
  "content-length",
  "etag",
  "last-modified",
  "location",
  "link",
  "retry-after",
  "x-request-id",
];

const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

// RFC 3986 path characters plus percent escapes, so `?`, `#`, `\`, spaces and controls fail.
const pathSegment = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%]*$/;

function isText(value: string | readonly string[] | JsonValue | Uint8Array): value is string {
  return typeof value === "string";
}

function isTextList(value: string | readonly string[]): value is readonly string[] {
  return Array.isArray(value) && value.every(isText);
}

function invalid(message: string): never {
  throw new SocialError({
    code: "invalid_input",
    operation,
    message,
    retryDisposition: { kind: "never" },
  });
}

/** Resolves `path` below `base` and proves the result stayed on that base. */
export function rawRequestUrl(base: string, path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 4096)
    invalid("Raw request paths start with one `/` and are relative to the adapter's host.");

  for (const segment of path.slice(1).split("/")) {
    if (!pathSegment.test(segment))
      invalid("Raw request paths contain only URL path characters. Pass the query in `query`.");
    let decoded: string;

    try {
      decoded = decodeURIComponent(segment);
    } catch {
      invalid("Raw request paths must use valid percent escapes.");
    }

    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\"))
      invalid("Raw request paths cannot contain dot segments or encoded separators.");
  }

  const root = new URL(base);
  const prefix = root.pathname.replace(/\/+$/, "");
  const url = new URL(root.origin + prefix + path);

  if (url.origin !== root.origin || url.pathname !== prefix + path)
    invalid("Raw request paths must stay on the adapter's host.");

  return url;
}

interface EncodedBody {
  readonly value: BodyInit;
  readonly contentType?: string;
}

function requestBody(body: RawRequestBody): EncodedBody {
  switch (body.kind) {
    case "json":
      return { value: JSON.stringify(body.value), contentType: "application/json" };
    case "text":
      return { value: body.value, contentType: body.contentType };
    case "bytes":
      if (!(body.value instanceof Blob)) invalid("A bytes body must be a Blob.");

      return { value: body.value, contentType: body.contentType };
    case "form":
      if (!(body.value instanceof FormData)) invalid("A form body must be FormData.");

      return { value: body.value };
    case "urlencoded":
      return {
        value: new URLSearchParams(body.value).toString(),
        contentType: "application/x-www-form-urlencoded",
      };
    default: {
      const _exhaustive: never = body;

      void _exhaustive;

      return invalid("Choose a json, text, bytes, form or urlencoded body.");
    }
  }
}

function responseLimit(value: number | undefined): number {
  if (value === undefined) return defaultLimit;

  if (!Number.isSafeInteger(value) || value < 1 || value > maxLimit)
    invalid("maxResponseBytes must be an integer from 1 through 16 MiB.");

  return value;
}

function selectedHeaders(names: readonly string[] | undefined): readonly string[] {
  const selected = new Set(defaultResponseHeaders);

  for (const name of names ?? []) {
    const lower = name.toLowerCase();

    if (!headerName.test(name) || lower === "set-cookie" || lower === "set-cookie2")
      invalid("responseHeaders must be header names other than set-cookie.");
    selected.add(lower);
  }

  return [...selected];
}

function decodeBody(
  bytes: Uint8Array,
  responseType: RawResponseType,
  status: number,
): JsonValue | string | Uint8Array {
  if (responseType === "bytes") return bytes;

  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError("Upstream returned a body that is not UTF-8.", "invalid-response", true);
  }

  if (responseType === "text") return text;

  if (!text.trim()) return null;

  try {
    return parseJson(text);
  } catch {
    throw new HttpError(
      `Upstream returned HTTP ${status} with a body that is not JSON. Request responseType "text" or "bytes".`,
      "invalid-response",
      true,
      status,
    );
  }
}

function rawResponse(
  status: number,
  headers: Readonly<Record<string, string>>,
  responseType: RawResponseType,
  body: JsonValue | string | Uint8Array,
): RawProviderResponse {
  if (responseType === "bytes" && body instanceof Uint8Array)
    return { status, headers, responseType, body };

  if (responseType === "text" && isText(body)) return { status, headers, responseType, body };

  if (responseType === "json" && !(body instanceof Uint8Array))
    return { status, headers, responseType, body };

  throw new HttpError(
    "Upstream response did not match its responseType.",
    "invalid-response",
    true,
  );
}

/**
 * Sends one validated request to one of the adapter's hosts. No retries, idempotency keys or
 * outcome tracking: a write that fails without a definitive rejection is `ambiguous_outcome`.
 */
export async function rawProviderRequest<THost extends string>(
  config: RawRequestConfig<THost>,
  input: RawProviderRequest<THost>,
  context: AdapterOperationContext,
): Promise<RawProviderResponse> {
  const host = input.host ?? config.defaultHost;

  const base = Object.hasOwn(config.hosts, host) ? config.hosts[host] : undefined;

  if (base === undefined || !isText(base))
    invalid("Choose one of this adapter's raw request hosts.");

  if (!methods.has(input.method)) invalid("Choose GET, HEAD, POST, PUT, PATCH or DELETE.");
  const method = input.method;
  const responseType = input.responseType ?? "json";

  if (responseType !== "json" && responseType !== "text" && responseType !== "bytes")
    invalid('responseType must be "json", "text" or "bytes".');
  const limit = responseLimit(input.maxResponseBytes);
  const returned = selectedHeaders(input.responseHeaders);
  const url = rawRequestUrl(base, input.path);
  const reservedQuery = new Set((config.reservedQuery ?? []).map((name) => name.toLowerCase()));

  const overrideQuery = new Set(
    (config.methodOverrideQuery ?? []).map((name) => name.toLowerCase()),
  );

  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (reservedQuery.has(key.toLowerCase()))
      invalid("Raw requests use the adapter's credentials; credential parameters are rejected.");

    if (overrideQuery.has(key.toLowerCase()))
      invalid("Send the HTTP method itself; method override query parameters are rejected.");

    if (isText(value)) url.searchParams.append(key, value);
    else if (isTextList(value)) for (const entry of value) url.searchParams.append(key, entry);
    else invalid("Query values must be strings or string lists.");
  }

  const reserved = new Set([...sharedReservedHeaders, ...(config.reservedHeaders ?? [])]);
  const headers = new Headers();

  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!headerName.test(name) || reserved.has(name.toLowerCase()))
      invalid(
        "Raw requests use the adapter's credentials; credential and framing headers are rejected.",
      );

    try {
      headers.set(name, value);
    } catch {
      invalid("Header values must be valid HTTP header values.");
    }
  }

  let body: BodyInit | undefined;

  if (input.body !== undefined) {
    if (method === "GET" || method === "HEAD") invalid("GET and HEAD requests cannot have a body.");
    const encoded = requestBody(input.body);
    body = encoded.value;

    if (encoded.contentType !== undefined)
      try {
        headers.set("Content-Type", encoded.contentType);
      } catch {
        invalid("The body content type must be a valid header value.");
      }
  }

  const dispatch: RawDispatch<THost> = { host, method, path: input.path, url, headers };

  if (context.signal?.aborted)
    throw httpSocialError(
      new HttpError("Request cancelled before dispatch.", "cancelled", false),
      operation,
      method,
      context,
    );
  await config.authorize(dispatch, context);

  const deadlineMs = Math.min(remainingBudget(context), config.timeoutMs ?? Infinity);
  const controller = new AbortController();
  const abort = () => controller.abort(context.signal?.reason);
  context.signal?.addEventListener("abort", abort, { once: true });

  const timer = setTimeout(
    () => controller.abort(new Error("HTTP deadline exceeded")),
    Math.max(1, deadlineMs),
  );

  let dispatched = false;
  let errorBody: JsonValue | undefined;

  try {
    if (context.signal?.aborted)
      throw new HttpError("Request cancelled before dispatch.", "cancelled", false);
    dispatched = true;

    const init: RequestInit = { method, headers, signal: controller.signal };

    if (body !== undefined) init.body = body;
    const pending = fetchWithoutRedirects(config.fetch(host), url, init);

    void pending.then(
      (response) => {
        if (controller.signal.aborted) void response.body?.cancel().catch(() => undefined);
      },
      () => undefined,
    );
    const response = await abortable(pending, controller.signal);

    if (!response.ok) {
      try {
        errorBody = parseJson(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await readBytes(response, Math.min(limit, 16 * 1024), controller.signal),
          ),
        );
      } catch {
        // Invalid, oversized or unreadable bodies keep the status-only mapping.
        void response.body?.cancel().catch(() => undefined);
      }

      throw new HttpError(
        `Upstream request failed with HTTP ${response.status}.`,
        "http",
        true,
        response.status,
        retryDelay(response.headers.get("retry-after"), Date.now()),
        requestId(response.headers),
        errorBody === undefined
          ? undefined
          : config.decodeError?.(errorBody, response.status, dispatch),
      );
    }

    const selected: Record<string, string> = {};

    for (const name of returned) {
      const value = response.headers.get(name);

      if (value !== null) selected[name] = value;
    }

    const empty = method === "HEAD" || response.status === 204 || response.status === 205;

    if (empty) void response.body?.cancel().catch(() => undefined);
    const bytes = empty ? new Uint8Array(0) : await readBytes(response, limit, controller.signal);

    return rawResponse(
      response.status,
      selected,
      responseType,
      decodeBody(bytes, responseType, response.status),
    );
  } catch (error) {
    // A session transport, such as Bluesky OAuth, may reject with its own classified error.
    if (error instanceof SocialError && !controller.signal.aborted) throw error;
    let failure: HttpError;

    if (context.signal?.aborted)
      failure = new HttpError(
        "Request cancelled; a dispatched write may still complete remotely.",
        "cancelled",
        dispatched,
      );
    else if (controller.signal.aborted)
      failure = new HttpError(
        "Request deadline exceeded; reconcile a dispatched write before retrying.",
        "timeout",
        dispatched,
      );
    else if (error instanceof HttpError) failure = error;
    else
      failure = new HttpError(
        "Network request failed; a dispatched write may have been accepted.",
        "network",
        dispatched,
      );

    const mapped = httpSocialError(failure, operation, method, context);

    throw config.mapError ? config.mapError(mapped, errorBody) : mapped;
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", abort);
  }
}

/** Raw-request wiring for a managed backend that authenticates with one API key header. */
export function managedRawRequest(
  origin: string,
  options: {
    readonly apiKey: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
  },
  authHeader: (apiKey: string) => readonly [name: string, value: string] = (apiKey) => [
    "Authorization",
    `Bearer ${apiKey}`,
  ],
) {
  const [credentialHeader] = authHeader(options.apiKey);

  const config: RawRequestConfig<"api"> = {
    hosts: { api: origin },
    defaultHost: "api",
    fetch: () => options.fetch ?? globalThis.fetch,
    authorize: ({ headers }) => {
      headers.set(...authHeader(options.apiKey));
    },
    reservedHeaders: [credentialHeader.toLowerCase()],
    decodeError: (body, status, dispatch) =>
      providerErrorDecoder(origin, dispatch.path)(body, status),
    ...definedFields({ timeoutMs: options.timeoutMs }),
  };

  return (input: RawProviderRequest<"api">, context: AdapterOperationContext) =>
    rawProviderRequest(config, input, context);
}

/** The `raw.request` capability declaration, listing the hosts the adapter allows. */
export function rawRequestCapability(
  platform: CapabilityDeclaration["platform"],
  hosts: string,
): CapabilityDeclaration {
  return {
    platform,
    operation: "raw.request",
    availability: "available",
    surface: "native",
    notes: `native.request sends one request to ${hosts} with the adapter's own credentials. It never retries, adds idempotency keys or reconciles writes; the caller owns any write it sends.`,
  };
}
