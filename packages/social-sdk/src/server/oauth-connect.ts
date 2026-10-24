import { SocialError } from "../core/errors.js";
import type { JsonObject, JsonValue, Platform } from "../core/types.js";
import { parseJson } from "../transport/json.js";
import { isJsonArray, isJsonObject, isString, type JsonField } from "../transport/validation.js";
import type { ConnectionGrant, ConnectionManager, ConnectionProvider } from "./connections.js";

/** The application user, resolved by the server from its own authenticated session. */
export interface OAuthConnectPrincipal {
  readonly tenantId: string;
  readonly principalId: string;
}

/**
 * Server-owned settings for one connect flow. The browser picks a connection by
 * its key; it never supplies the backend, platforms, provider, or callback URL.
 */
export interface OAuthConnectRoute {
  readonly backend: string;
  readonly platforms: readonly Platform[];
  readonly capabilities?: readonly string[];
  /**
   * Exact registered callback. Each route needs its own origin and path so the
   * callback handler can find the route from the request URL alone.
   */
  readonly redirectUri: string;
  /**
   * An existing provider such as `youtubeOAuth(...)`. Its `credentialSink` runs
   * during discovery, before the user picks accounts, so it must stage
   * credentials under the attempt ID and never make them usable on its own.
   * `credentials.activate` promotes the selected ones afterwards.
   */
  readonly provider: ConnectionProvider;
}

/**
 * Carries the attempt ID from begin to callback and select. The default is an
 * HttpOnly `__Host-` cookie; a server session store can implement this instead.
 * Never derive the tenant or principal from the value.
 */
export interface OAuthAttemptCorrelation {
  remember(input: {
    readonly request: Request;
    readonly principal: OAuthConnectPrincipal;
    readonly attemptId: string;
    readonly maxAgeSeconds: number;
    readonly headers: Headers;
  }): Promise<void>;
  recall(input: {
    readonly request: Request;
    readonly principal: OAuthConnectPrincipal;
  }): Promise<string | undefined>;
  forget(input: {
    readonly request: Request;
    readonly principal: OAuthConnectPrincipal;
    readonly headers: Headers;
  }): Promise<void>;
}

export type OAuthConnectAction = "begin" | "select" | "disconnect";

export type OAuthRevocationResult = "revoked" | "already_revoked" | "not_supported";

export interface OAuthConnectHandlersOptions {
  readonly manager: Pick<ConnectionManager, "begin" | "discover" | "select">;
  /**
   * Resolve the principal from the server session (for example a verified
   * session cookie). Return `undefined` when the request is not signed in.
   * Never read a tenant or principal from the query or body.
   */
  readonly authenticate: (request: Request) => Promise<OAuthConnectPrincipal | undefined>;
  /**
   * Approve a state-changing POST, typically by checking a CSRF token header
   * and the `Origin` header. Must not read the request body. Return `false`
   * to refuse.
   */
  readonly authorizeMutation: (input: {
    readonly request: Request;
    readonly principal: OAuthConnectPrincipal;
    readonly action: OAuthConnectAction;
  }) => Promise<boolean>;
  /** Server-owned connect flows, keyed by the name the browser sends to `begin`. */
  readonly connections: Readonly<Record<string, OAuthConnectRoute>>;
  readonly credentials: {
    /**
     * Called after the selected grants are committed. Make the credentials the
     * provider staged for `attemptId` usable for exactly these grants and
     * discard the rest. Staged credentials for abandoned attempts must expire.
     * This is a separate step, not an atomic promotion: if it fails, the
     * grants exist without active credentials and the route reports
     * `activation_failed` so the application can reconcile or reconnect.
     */
    activate(input: {
      readonly attemptId: string;
      readonly principal: OAuthConnectPrincipal;
      readonly grants: readonly ConnectionGrant[];
    }): Promise<void>;
  };
  readonly grants: {
    /**
     * Return the grant only when this principal may disconnect it. The route
     * also refuses a grant from another tenant.
     */
    find(input: {
      readonly principal: OAuthConnectPrincipal;
      readonly grantId: string;
    }): Promise<ConnectionGrant | undefined>;
    /**
     * Revoke the provider token for this grant. Throw when revocation fails;
     * the grant and its credential are then kept so the user can retry.
     */
    revoke(input: {
      readonly principal: OAuthConnectPrincipal;
      readonly grant: ConnectionGrant;
    }): Promise<OAuthRevocationResult>;
    /** Delete the grant and the credential the server stores for it. */
    remove(input: {
      readonly principal: OAuthConnectPrincipal;
      readonly grant: ConnectionGrant;
    }): Promise<void>;
  };
  /** Defaults to an HttpOnly, Secure, SameSite=Lax `__Host-` cookie. */
  readonly correlation?: OAuthAttemptCorrelation;
  /**
   * Public URL of the callback request. Defaults to `request.url`; behind a
   * proxy, derive it from trusted configuration, never from client headers.
   */
  readonly publicUrl?: (request: Request) => string;
  /** Maximum POST body size. Defaults to 16 KiB. */
  readonly maxBodyBytes?: number;
  readonly now?: () => Date;
}

export interface OAuthConnectHandlers {
  /** POST `{ connection, loginHint? }`. Responds with the provider authorization URL. */
  readonly begin: (request: Request) => Promise<Response>;
  /** GET from the provider redirect. Responds with the discovered accounts. */
  readonly callback: (request: Request) => Promise<Response>;
  /** POST `{ accountIds }`. Commits grants for the discovered accounts chosen. */
  readonly select: (request: Request) => Promise<Response>;
  /** POST `{ grantId }`. Revokes, then removes a grant this principal owns. */
  readonly disconnect: (request: Request) => Promise<Response>;
}

type RefusalCode =
  | "method_not_allowed"
  | "unsupported_media_type"
  | "payload_too_large"
  | "invalid_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "unknown_connection"
  | "attempt_missing"
  | "authorization_denied"
  | "expired"
  | "discovery_unavailable"
  | "upstream_failure"
  | "activation_failed"
  | "revocation_failed"
  | "removal_failed"
  | "internal_error";

const refusals: Readonly<
  Record<RefusalCode, { readonly status: number; readonly message: string }>
> = {
  method_not_allowed: { status: 405, message: "This route does not accept that method." },
  unsupported_media_type: { status: 415, message: "Send the request body as application/json." },
  payload_too_large: { status: 413, message: "The request body is too large." },
  invalid_request: { status: 400, message: "The request is malformed." },
  unauthenticated: { status: 401, message: "Sign in before connecting an account." },
  forbidden: { status: 403, message: "The request was not authorized." },
  not_found: { status: 404, message: "Nothing matched this request." },
  unknown_connection: { status: 400, message: "The requested connection is not configured." },
  attempt_missing: { status: 400, message: "No connection attempt is active. Start again." },
  authorization_denied: { status: 400, message: "The provider did not authorize the account." },
  expired: { status: 410, message: "The connection attempt expired. Start again." },
  discovery_unavailable: {
    status: 409,
    message: "Account discovery is in progress or was lost. Start again.",
  },
  upstream_failure: { status: 502, message: "The provider request failed." },
  activation_failed: {
    status: 500,
    message: "The accounts were connected but their credentials were not activated.",
  },
  revocation_failed: {
    status: 502,
    message: "The provider token could not be revoked. Nothing was removed.",
  },
  removal_failed: {
    status: 500,
    message: "The provider token was revoked but the connection was not removed.",
  },
  internal_error: { status: 500, message: "The request could not be completed." },
};

class Refusal extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode) {
    super(code);
    this.code = code;
  }
}

function refuse(code: RefusalCode): never {
  throw new Refusal(code);
}

function invalidConfig(message: string): never {
  throw new SocialError({ code: "invalid_config", operation: "oauthConnect.create", message });
}

const ATTEMPT_COOKIE = "__Host-social-sdk-connect";

const COOKIE_VALUE = /^v1\.([A-Za-z0-9_-]{1,128})$/;

const ROUTE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

const MAX_CALLBACK_URL_LENGTH = 8 * 1024;

function cookieAttributes(maxAgeSeconds: number): string {
  return `Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

/**
 * Attempt correlation through a `__Host-` cookie: Secure, HttpOnly, Path=/,
 * no Domain, and SameSite=Lax so the provider's top-level redirect carries it.
 * The application session cookie must also be sent on that redirect.
 */
export function oauthAttemptCookie(): OAuthAttemptCorrelation {
  return {
    remember: async ({ attemptId, maxAgeSeconds, headers }) => {
      headers.append(
        "Set-Cookie",
        `${ATTEMPT_COOKIE}=v1.${attemptId}; ${cookieAttributes(maxAgeSeconds)}`,
      );
    },
    recall: async ({ request }) => {
      const values = (request.headers.get("Cookie") ?? "")
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${ATTEMPT_COOKIE}=`));

      if (values.length !== 1 || values[0] === undefined) return undefined;

      return COOKIE_VALUE.exec(values[0].slice(ATTEMPT_COOKIE.length + 1))?.[1];
    },
    forget: async ({ headers }) => {
      headers.append("Set-Cookie", `${ATTEMPT_COOKIE}=; ${cookieAttributes(0)}`);
    },
  };
}

function respond(status: number, body: JsonValue, headers = new Headers()): Response {
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  // Callback URLs carry authorization codes; never leak them through Referer.
  headers.set("Referrer-Policy", "no-referrer");

  return new Response(JSON.stringify(body), { status, headers });
}

function refusalResponse(code: RefusalCode, headers = new Headers()): Response {
  const { status, message } = refusals[code];

  if (code === "method_not_allowed" && !headers.has("Allow")) headers.set("Allow", "POST");

  return respond(status, { error: { code, message } }, headers);
}

function fromSocialError(error: SocialError): RefusalCode {
  switch (error.code) {
    case "unauthorized":
      return "forbidden";
    case "invalid_input":
      return "invalid_request";
    case "timeout":
      return "expired";
    case "reconnect_required":
      return "discovery_unavailable";
    case "upstream_failure":
    case "rate_limited":
      return "upstream_failure";
    default:
      return "internal_error";
  }
}

function refusalFor(cause: unknown): RefusalCode {
  if (cause instanceof Refusal) return cause.code;

  if (cause instanceof SocialError) return fromSocialError(cause);

  return "internal_error";
}

function allowedRedirect(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    invalidConfig("Each connection redirectUri must be an absolute URL");
  }

  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

  if (
    url.username ||
    url.password ||
    url.hash ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  )
    invalidConfig("Each connection redirectUri must be HTTPS without credentials or a fragment");

  return url;
}

interface ResolvedRoute {
  readonly key: string;
  readonly route: OAuthConnectRoute;
  readonly callback: string;
}

function resolveRoutes(connections: Readonly<Record<string, OAuthConnectRoute>>): ResolvedRoute[] {
  const routes: ResolvedRoute[] = [];
  const callbacks = new Set<string>();

  for (const [key, route] of Object.entries(connections)) {
    if (!ROUTE_KEY.test(key)) invalidConfig("Connection keys must be short identifiers");

    if (!route.backend || route.platforms.length === 0)
      invalidConfig("Each connection needs a backend and at least one platform");
    const url = allowedRedirect(route.redirectUri);
    const callback = url.origin + url.pathname;

    if (callbacks.has(callback))
      invalidConfig("Each connection needs its own redirectUri origin and path");
    callbacks.add(callback);
    routes.push({ key, route, callback });
  }

  if (routes.length === 0) invalidConfig("Configure at least one connection");

  return routes;
}

async function readBody(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("Content-Length");

  if (declared !== null && (!/^\d{1,15}$/.test(declared) || Number(declared) > maxBytes))
    refuse("payload_too_large");

  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const part = await reader.read();

      if (part.done) break;
      total += part.value.byteLength;

      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        refuse("payload_too_large");
      }

      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(merged);
  } catch {
    refuse("invalid_request");
  }
}

/** Parse a JSON object body that holds only the named fields. */
async function readFields(
  request: Request,
  maxBytes: number,
  allowed: readonly string[],
): Promise<JsonObject> {
  const mediaType = (request.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();

  if (mediaType !== "application/json") refuse("unsupported_media_type");
  const text = await readBody(request, maxBytes);
  let parsed: JsonField;

  try {
    parsed = parseJson(text);
  } catch {
    refuse("invalid_request");
  }

  if (!isJsonObject(parsed) || Object.keys(parsed).some((key) => !allowed.includes(key)))
    refuse("invalid_request");

  return parsed;
}

function boundedString(value: JsonField, maxLength: number): string {
  if (!isString(value) || value.length === 0 || value.length > maxLength) refuse("invalid_request");

  return value;
}

function distinctAccountIds(value: JsonField): string[] {
  if (!isJsonArray(value) || value.length === 0 || value.length > 100) refuse("invalid_request");
  const ids = value.map((id) => boundedString(id, 256));

  if (new Set(ids).size !== ids.length) refuse("invalid_request");

  return ids;
}

/** Read the callback query, refusing any repeated parameter. */
function callbackQuery(url: URL): ReadonlyMap<string, string> {
  const query = new Map<string, string>();

  for (const [key, value] of url.searchParams) {
    if (query.has(key)) refuse("invalid_request");
    query.set(key, value);
  }

  return query;
}

function isPrincipal(value: OAuthConnectPrincipal | undefined): value is OAuthConnectPrincipal {
  return value !== undefined && value.tenantId.length > 0 && value.principalId.length > 0;
}

/**
 * Framework-neutral routes for connecting and disconnecting social accounts.
 * Every handler takes a Web `Request` and returns a Web `Response` whose body
 * never includes PKCE verifiers, provider state, tokens, or provider error text.
 */
export function createOAuthConnectHandlers(
  options: OAuthConnectHandlersOptions,
): OAuthConnectHandlers {
  const routes = resolveRoutes(options.connections);
  const correlation = options.correlation ?? oauthAttemptCookie();
  const now = options.now ?? (() => new Date());
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1)
    invalidConfig("maxBodyBytes must be a positive safe integer");

  async function principalFor(request: Request): Promise<OAuthConnectPrincipal> {
    const principal = await options.authenticate(request);

    if (!isPrincipal(principal)) refuse("unauthenticated");

    return { tenantId: principal.tenantId, principalId: principal.principalId };
  }

  async function mutation(
    request: Request,
    action: OAuthConnectAction,
  ): Promise<OAuthConnectPrincipal> {
    if (request.method !== "POST") refuse("method_not_allowed");
    const principal = await principalFor(request);

    if (!(await options.authorizeMutation({ request, principal, action }))) refuse("forbidden");

    return principal;
  }

  async function attemptFor(request: Request, principal: OAuthConnectPrincipal): Promise<string> {
    const attemptId = await correlation.recall({ request, principal });

    if (attemptId === undefined) refuse("attempt_missing");

    return attemptId;
  }

  function guarded(
    handler: (request: Request, headers: Headers) => Promise<Response>,
  ): (request: Request) => Promise<Response> {
    return async (request) => {
      const headers = new Headers();

      try {
        return await handler(request, headers);
      } catch (error) {
        return refusalResponse(refusalFor(error), headers);
      }
    };
  }

  const begin = guarded(async (request, headers) => {
    const principal = await mutation(request, "begin");
    const body = await readFields(request, maxBodyBytes, ["connection", "loginHint"]);
    const key = boundedString(body["connection"], 64);
    const resolved = routes.find((entry) => entry.key === key);

    if (resolved === undefined) refuse("unknown_connection");

    const loginHint =
      body["loginHint"] === undefined ? undefined : boundedString(body["loginHint"], 512);

    const { route } = resolved;

    const beginInput = {
      backend: route.backend,
      tenantId: principal.tenantId,
      principalId: principal.principalId,
      platforms: route.platforms,
      capabilities: route.capabilities ?? [],
      redirectUri: route.redirectUri,
      allowedRedirectUris: [route.redirectUri],
      provider: route.provider,
    };

    const started = await options.manager.begin(
      loginHint === undefined ? beginInput : { ...beginInput, loginHint },
    );

    if (new URL(started.authorizationUrl).protocol !== "https:") refuse("internal_error");
    const remainingMs = Date.parse(started.attempt.expiresAt) - now().getTime();
    const maxAgeSeconds = Math.floor(remainingMs / 1000);

    if (!(maxAgeSeconds > 0)) refuse("expired");

    await correlation.remember({
      request,
      principal,
      attemptId: started.attempt.id,
      maxAgeSeconds,
      headers,
    });

    return respond(
      200,
      { authorizationUrl: started.authorizationUrl, expiresAt: started.attempt.expiresAt },
      headers,
    );
  });

  const callback = guarded(async (request, headers) => {
    if (request.method !== "GET") {
      headers.set("Allow", "GET");
      refuse("method_not_allowed");
    }

    const callbackUrl = options.publicUrl?.(request) ?? request.url;

    if (callbackUrl.length > MAX_CALLBACK_URL_LENGTH) refuse("invalid_request");
    let url: URL;

    try {
      url = new URL(callbackUrl);
    } catch {
      refuse("invalid_request");
    }

    const resolved = routes.find((entry) => entry.callback === url.origin + url.pathname);

    if (resolved === undefined) refuse("not_found");
    const query = callbackQuery(url);
    const principal = await principalFor(request);

    if (query.has("error")) refuse("authorization_denied");
    const state = query.get("state");

    if (!state || !query.get("code")) refuse("invalid_request");
    const attemptId = await attemptFor(request, principal);

    const accounts = await options.manager.discover({
      attemptId,
      tenantId: principal.tenantId,
      principalId: principal.principalId,
      callbackUrl,
      returnedState: state,
      allowedRedirectUris: [resolved.route.redirectUri],
      provider: resolved.route.provider,
    });

    return respond(
      200,
      {
        status: "discovered",
        accounts: accounts.map((account) => ({
          accountId: account.ref.accountId,
          platform: account.ref.platform,
          displayName: account.displayName,
        })),
      },
      headers,
    );
  });

  const select = guarded(async (request, headers) => {
    const principal = await mutation(request, "select");
    const body = await readFields(request, maxBodyBytes, ["accountIds"]);
    const selectedAccountIds = distinctAccountIds(body["accountIds"]);
    const attemptId = await attemptFor(request, principal);

    const grants = await options.manager.select({
      attemptId,
      tenantId: principal.tenantId,
      principalId: principal.principalId,
      selectedAccountIds,
    });

    // The attempt is consumed now, so the cookie is cleared whatever happens next.
    await correlation.forget({ request, principal, headers });

    try {
      await options.credentials.activate({ attemptId, principal, grants });
    } catch {
      refuse("activation_failed");
    }

    return respond(
      200,
      {
        status: "connected",
        grants: grants.map((grant) => ({
          grantId: grant.grantId,
          platform: grant.account.platform,
          accountId: grant.account.accountId,
        })),
      },
      headers,
    );
  });

  const disconnect = guarded(async (request, headers) => {
    const principal = await mutation(request, "disconnect");
    const body = await readFields(request, maxBodyBytes, ["grantId"]);
    const grantId = boundedString(body["grantId"], 256);
    const grant = await options.grants.find({ principal, grantId });

    if (grant === undefined || grant.grantId !== grantId || grant.tenantId !== principal.tenantId)
      refuse("not_found");
    let revocation: OAuthRevocationResult;

    try {
      revocation = await options.grants.revoke({ principal, grant });
    } catch {
      refuse("revocation_failed");
    }

    try {
      await options.grants.remove({ principal, grant });
    } catch {
      refuse("removal_failed");
    }

    return respond(200, { status: "disconnected", grantId, revocation }, headers);
  });

  return { begin, callback, select, disconnect };
}
