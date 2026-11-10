import { SocialError } from "../core/errors.js";
import { definedFields } from "../core/fields.js";
import {
  connectedAccountRef,
  type JsonObject,
  type JsonValue,
  type Platform,
} from "../core/types.js";
import { isJsonValue } from "../transport/json.js";
import { fetchWithoutRedirects } from "../transport/redirect.js";
import {
  isBoolean,
  isFiniteNumber,
  isJsonObject,
  isString,
  type JsonField,
} from "../transport/validation.js";
import type { ConnectionAccount, ConnectionAttempt, ConnectionProvider } from "./connections.js";
import { readBounded, validateCallback } from "./oauth-internal.js";

export * from "./bluesky-oauth.js";

export interface OAuthTokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  /**
   * Refresh-token expiry, computed from `refresh_expires_in` when the provider returns it
   * (TikTok does on both the authorization-code and refresh grants). Reconnect before it passes.
   */
  readonly refreshExpiresAt?: string;
  readonly scopes?: readonly string[];
  readonly tokenType?: string;
}

export interface OAuthCredentialSink {
  save(input: {
    readonly account: ConnectionAccount;
    readonly token: OAuthTokenSet;
    readonly attempt: ConnectionAttempt;
  }): Promise<void>;
}

export interface OAuthProviderOptions {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUri?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly credentialSink?: OAuthCredentialSink;
  /**
   * Selects which validated discovered accounts receive persisted credentials.
   * When omitted, credentials are persisted for every discovered account.
   */
  readonly selectAccounts?: (
    accounts: readonly ConnectionAccount[],
    attempt: ConnectionAttempt,
  ) => readonly string[] | Promise<readonly string[]>;
  /** Optional label for callers; the attempt's backend is always authoritative. */
  readonly backend?: string;
  /**
   * Scopes to request. Replaces the provider's default scopes instead of adding to them, so
   * repeat any defaults you still need.
   */
  readonly scopes?: readonly string[];
  /** Explicit LinkedIn Marketing API version (YYYYMM). Required for LinkedIn OAuth. */
  readonly linkedinApiVersion?: string;
  /**
   * TikTok only: send `disable_auto_auth=1` so Login Kit always shows the authorization page,
   * even for a browser already signed in to TikTok. Use it to connect a second creator account.
   */
  readonly disableAutoAuth?: boolean;
  /**
   * TikTok only: `"desktop"` runs Login Kit for Desktop. The authorization URL then carries a
   * PKCE `code_challenge` as the hex-encoded SHA-256 of the verifier (TikTok's desktop format,
   * not base64url) with `code_challenge_method=S256`, the token exchange sends `code_verifier`,
   * and the redirect URI must be a loopback URL (`localhost` or `127.0.0.1`) with a port.
   * Defaults to `"web"`, which uses no PKCE.
   */
  readonly tiktokLoginKit?: "web" | "desktop";
  /**
   * YouTube only: send `include_granted_scopes=true` so the new token also covers scopes the
   * user granted this app before (Google incremental authorization).
   */
  readonly includeGrantedScopes?: boolean;
  /**
   * Instagram Business Login only: send `force_reauth=true` so Instagram asks for the
   * professional account's credentials even when the browser is signed in. Use it to connect a
   * second account, and on mobile, where Meta recommends it.
   */
  readonly forceReauth?: boolean;
  /**
   * Instagram Business Login only: send `enable_fb_login`. `false` hides the "Log in with
   * Facebook" option on the Instagram login page; Meta's default is `true`.
   */
  readonly enableFacebookLogin?: boolean;
  /** Graph API version for Threads account discovery. */
  readonly threadsApiVersion?: string;
  /** Graph API version for Instagram Login account discovery. */
  readonly instagramApiVersion?: string;
  /** Maximum time for a single OAuth request. Defaults to ten seconds. */
  readonly timeoutMs?: number;
  /** Maximum response body size. Defaults to one MiB. */
  readonly maxResponseBytes?: number;
  /** Cancels token requests and account discovery, including continuation pages. */
  readonly signal?: AbortSignal;
}

type ProviderKind = "youtube" | "x" | "threads" | "tiktok" | "instagram" | "linkedin";

interface ProviderConfig {
  readonly auth: string;
  readonly token: string;
  readonly scopes: readonly string[];
  readonly scopeDelimiter: " " | ",";
  readonly pkce: boolean;
  readonly clientKey: "client_id" | "client_key";
}

const configs: Record<ProviderKind, ProviderConfig> = {
  youtube: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scopes: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/youtube.upload",
    ],
    scopeDelimiter: " ",
    pkce: false,
    clientKey: "client_id",
  },
  x: {
    auth: "https://x.com/i/oauth2/authorize",
    token: "https://api.x.com/2/oauth2/token",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"],
    scopeDelimiter: " ",
    pkce: true,
    clientKey: "client_id",
  },
  threads: {
    auth: "https://threads.net/oauth/authorize",
    token: "https://graph.threads.net/oauth/access_token",
    scopes: ["threads_basic", "threads_content_publish"],
    scopeDelimiter: ",",
    pkce: false,
    clientKey: "client_id",
  },
  tiktok: {
    auth: "https://www.tiktok.com/v2/auth/authorize/",
    token: "https://open.tiktokapis.com/v2/oauth/token/",
    scopes: ["user.info.basic", "video.publish"],
    scopeDelimiter: ",",
    pkce: false,
    clientKey: "client_key",
  },
  instagram: {
    auth: "https://www.instagram.com/oauth/authorize",
    token: "https://api.instagram.com/oauth/access_token",
    scopes: ["instagram_business_basic", "instagram_business_content_publish"],
    scopeDelimiter: ",",
    pkce: false,
    clientKey: "client_id",
  },
  linkedin: {
    auth: "https://www.linkedin.com/oauth/v2/authorization",
    token: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["openid", "profile", "w_member_social"],
    scopeDelimiter: " ",
    pkce: false,
    clientKey: "client_id",
  },
};

const DEFAULT_TIMEOUT_MS = 10_000;

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

const webFetch = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args);

function fail(
  operation: string,
  message: string,
  code:
    | "upstream_failure"
    | "missing_permission"
    | "reconnect_required"
    | "invalid_input"
    | "unauthorized"
    | "cancelled"
    | "timeout"
    | "unsupported_capability"
    | "invalid_config" = "upstream_failure",
  cause?: unknown,
): never {
  throw new SocialError({ code, operation, message, cause });
}

function asRecord(value: JsonField, operation = "oauth.response"): JsonObject {
  if (!isJsonObject(value)) fail(operation, "OAuth provider returned an invalid response");

  return value;
}

function requiredString(value: JsonField, field: string, operation = "oauth.response"): string {
  if (!isString(value) || value.length === 0 || value.length > 8192)
    fail(operation, `OAuth provider response is missing ${field}`);

  return value;
}

function optionalString(value: JsonField): string | undefined {
  return isString(value) && value.length > 0 && value.length <= 8192 ? value : undefined;
}

/** Any string, including an empty one, otherwise the fallback. */
function stringOr(value: JsonField, fallback: string): string {
  return isString(value) ? value : fallback;
}

/**
 * Plain `JSON.parse`, checked against the JSON grammar. OAuth bodies keep native
 * number parsing rather than the lossless integer handling in transport/json.
 */
function parseJsonText(raw: string): JsonValue {
  const parsed: unknown = JSON.parse(raw);

  if (!isJsonValue(parsed)) throw new SyntaxError("Expected a JSON value");

  return parsed;
}

function isAbortError(error: unknown): error is { readonly name: "AbortError" } {
  if (error instanceof DOMException) return error.name === "AbortError";

  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}

function errorForResponse(status: number, operation: string, providerCode?: string): never {
  if (status === 400 && providerCode === "invalid_grant")
    fail(
      operation,
      "OAuth authorization is no longer valid; reconnect the account",
      "reconnect_required",
    );

  if (status === 401)
    fail(
      operation,
      "OAuth authorization is no longer valid; reconnect the account",
      "reconnect_required",
    );

  if (status === 403)
    fail(
      operation,
      "OAuth authorization does not include the required permission",
      "missing_permission",
    );

  if (status === 429)
    throw new SocialError({
      code: "rate_limited",
      operation,
      message: "OAuth provider rate limited the request",
      upstreamStatus: status,
      retryDisposition: { kind: "after-delay", delayMs: 1000 },
    });
  throw new SocialError({
    code: "upstream_failure",
    operation,
    message: "OAuth provider request failed",
    upstreamStatus: status,
  });
}

async function body(
  response: Response,
  operation: string,
  maxBytes: number,
  signal: AbortSignal,
  allowEmpty: boolean,
): Promise<JsonObject> {
  const raw = await readBounded(response, maxBytes, operation, signal);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  if (!response.ok) {
    let providerCode: string | undefined;

    try {
      const parsed =
        contentType.includes("json") || raw.trimStart().startsWith("{")
          ? parseJsonText(raw)
          : Object.fromEntries(new URLSearchParams(raw).entries());

      if (isJsonObject(parsed)) {
        const error = parsed["error"];
        providerCode = isString(error) ? error : undefined;
      }
    } catch {
      // Preserve the HTTP error classification when an upstream error body is malformed.
    }

    return errorForResponse(response.status, operation, providerCode);
  }

  if (raw.trim() === "") {
    if (allowEmpty) return {};
    fail(operation, "OAuth provider returned an empty response");
  }

  if (
    contentType.includes("application/json") ||
    contentType.includes("+json") ||
    raw.trimStart().startsWith("{")
  ) {
    try {
      return asRecord(parseJsonText(raw), operation);
    } catch {
      fail(operation, "OAuth provider returned malformed JSON");
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(raw);

    if ([...params.keys()].length === 0)
      fail(operation, "OAuth provider returned malformed form data");

    return Object.fromEntries(params.entries());
  }

  fail(operation, "OAuth provider returned an unsupported response format");
}

function parseScopes(value: JsonField): readonly string[] | undefined {
  if (Array.isArray(value)) {
    if (!value.every(isString)) fail("oauth.token", "OAuth provider returned invalid scopes");

    return value;
  }

  const scope = optionalString(value);

  return scope === undefined ? undefined : scope.split(/[\s,]+/).filter(Boolean);
}

/** Converts a lifetime in seconds (`expires_in`, `refresh_expires_in`) to an RFC 3339 instant. */
function lifetimeEnd(value: JsonField, operation: string): string | undefined {
  if (value === undefined) return undefined;

  const seconds = isFiniteNumber(value)
    ? value
    : isString(value) && /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value)
      : Number.NaN;

  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 31_536_000_000)
    fail(operation, "OAuth provider returned an invalid token lifetime");

  return new Date(Date.now() + seconds * 1000).toISOString();
}

function tokenSet(data: JsonObject, operation = "oauth.token"): OAuthTokenSet {
  const accessToken = requiredString(data["access_token"], "access_token", operation);
  const expiresAt = lifetimeEnd(data["expires_in"], operation);
  const refreshToken = optionalString(data["refresh_token"]);

  // A refresh-token lifetime only describes a refresh token returned in the same response.
  const refreshExpiresAt =
    refreshToken === undefined ? undefined : lifetimeEnd(data["refresh_expires_in"], operation);

  const scopes = parseScopes(data["scope"]);
  const tokenType = optionalString(data["token_type"]);

  return {
    accessToken,
    ...definedFields({ refreshToken, expiresAt, refreshExpiresAt, scopes, tokenType }),
  };
}

/** Keeps the current refresh token, and its expiry, when a refresh response omits a new one. */
function keepRefreshToken(next: OAuthTokenSet, current: OAuthTokenSet): OAuthTokenSet {
  if (next.refreshToken !== undefined || current.refreshToken === undefined) return next;

  return {
    ...next,
    refreshToken: current.refreshToken,
    ...definedFields({ refreshExpiresAt: current.refreshExpiresAt }),
  };
}

interface TokenResult {
  readonly token: OAuthTokenSet;
  readonly accountHint?: string;
}

function tokenResult(data: JsonObject, kind: ProviderKind): TokenResult {
  let nested = data;

  if (kind === "tiktok" && data["data"] !== undefined)
    nested = asRecord(data["data"], "oauth.token");

  if (kind === "instagram" && Array.isArray(data["data"])) {
    const first = data["data"][0];
    nested = asRecord(first, "oauth.token");
  }

  const token = tokenSet(
    kind === "instagram" && nested["permissions"] !== undefined
      ? { ...nested, scope: nested["permissions"] }
      : nested,
  );

  const accountHint = optionalString(nested["user_id"]) ?? optionalString(nested["open_id"]);

  return accountHint === undefined ? { token } : { token, accountHint };
}

async function request(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
  options: OAuthProviderOptions,
  allowEmptyBody = false,
  /** A provider-side mutation, such as revocation: a lost response after dispatch is uncertain. */
  mutation = false,
): Promise<JsonObject> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    fail("oauth.config", "timeoutMs must be a positive safe integer", "invalid_input");

  if (options.signal?.aborted) fail(operation, "OAuth provider request cancelled", "cancelled");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let dispatched = false;
  let answeredOk = false;

  try {
    // Race injected fetchers and response readers that ignore AbortSignal.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new DOMException("OAuth request aborted", "AbortError")),
        { once: true },
      );
    });

    dispatched = true;

    const response = await Promise.race([
      fetchWithoutRedirects(fetcher, url, { ...init, signal: controller.signal }),
      aborted,
    ]);

    answeredOk = response.ok;

    return await Promise.race([
      body(
        response,
        operation,
        options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        controller.signal,
        allowEmptyBody,
      ),
      aborted,
    ]);
  } catch (error) {
    // A mutation that was sent and not definitely refused (an error status) may have been
    // applied: its response was lost, unreadable, oversized or malformed.
    const uncertain = mutation && dispatched && (answeredOk || !(error instanceof SocialError));

    if (error instanceof SocialError && !uncertain) throw error;

    if (uncertain)
      throw new SocialError({
        code: "ambiguous_outcome",
        operation,
        message:
          "The OAuth provider response to a sent change was lost or unreadable; the change may have been applied. Check the grant before retrying.",
        retryDisposition: { kind: "reconcile-first" },
        cause: error,
      });

    if (options.signal?.aborted) fail(operation, "OAuth provider request cancelled", "cancelled");

    if (isAbortError(error)) fail(operation, "OAuth provider request timed out", "timeout");
    fail(operation, "OAuth provider request failed", "upstream_failure", error);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }

  fail("oauth.internal", "OAuth request did not produce a result");
}

function account(platform: Platform, backend: string, id: string, name: string): ConnectionAccount {
  return { ref: connectedAccountRef({ backend, platform, accountId: id }), displayName: name };
}

function validateLinkedInVersion(value: string | undefined): string {
  if (value === undefined || !/^20\d{2}(0[1-9]|1[0-2])$/.test(value))
    fail("oauth.config", "LinkedIn OAuth requires an explicit YYYYMM API version", "invalid_input");

  return value;
}

function providerIdentity(
  kind: ProviderKind,
  hint: string | undefined,
  discovered: readonly ConnectionAccount[],
): void {
  if (hint === undefined || kind === "instagram") return;
  const normalized = kind === "linkedin" ? `urn:li:person:${hint}` : hint;

  if (
    !discovered.some(
      (item) => item.ref.accountId === normalized || item.ref.accountId.endsWith(`:${hint}`),
    )
  )
    fail(
      "oauth.identity",
      "OAuth token identity did not match the discovered account",
      "unauthorized",
    );
}

function validateDiscoveredAccounts(
  attempt: ConnectionAttempt,
  accounts: readonly ConnectionAccount[],
): void {
  if (accounts.length === 0)
    fail("oauth.accounts", "The provider returned no connected accounts", "invalid_input");
  const seen = new Set<string>();

  for (const item of accounts) {
    const { ref } = item;

    if (
      ref.kind !== "connected-account" ||
      ref.version !== 1 ||
      ref.backend !== attempt.backend ||
      !attempt.platforms.includes(ref.platform) ||
      !ref.accountId ||
      seen.has(ref.accountId)
    )
      fail(
        "oauth.accounts",
        "Provider returned an invalid or duplicate account for this connection attempt",
        "unauthorized",
      );
    seen.add(ref.accountId);
  }
}

/**
 * Login Kit for Desktop accepts only loopback redirect URIs: `localhost` or `127.0.0.1`, an
 * explicit port, and no query or fragment.
 * Source, accessed 2026-11-04: https://developers.tiktok.com/doc/login-kit-desktop
 */
function validateLoopbackRedirect(value: string): void {
  let url: URL | undefined;

  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }

  if (
    url === undefined ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") ||
    url.port === "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  )
    fail(
      "connections.begin",
      "TikTok Login Kit for Desktop needs a localhost or 127.0.0.1 redirect URI with a port and no query",
      "invalid_input",
    );
}

/**
 * Re-encodes the connection manager's base64url S256 challenge as lowercase hex. Both encode
 * the same SHA-256 digest of the verifier; Login Kit for Desktop expects the hex form.
 */
function hexChallenge(base64UrlChallenge: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(base64UrlChallenge))
    fail("connections.begin", "PKCE code challenge must be a SHA-256 digest", "invalid_input");

  const binary = atob(base64UrlChallenge.replaceAll("-", "+").replaceAll("_", "/") + "=");
  let hex = "";

  for (let index = 0; index < binary.length; index++)
    hex += binary.charCodeAt(index).toString(16).padStart(2, "0");

  return hex;
}

export function oauthProvider(
  kind: ProviderKind,
  options: OAuthProviderOptions,
): ConnectionProvider {
  const cfg = configs[kind];

  if (!options.clientId.trim()) fail("oauth.config", "clientId is required", "invalid_input");

  if (options.disableAutoAuth !== undefined && kind !== "tiktok")
    fail("oauth.config", "disableAutoAuth applies only to TikTok Login Kit", "invalid_input");

  if (options.tiktokLoginKit !== undefined && kind !== "tiktok")
    fail("oauth.config", "tiktokLoginKit applies only to TikTok Login Kit", "invalid_input");

  if (options.includeGrantedScopes !== undefined && kind !== "youtube")
    fail("oauth.config", "includeGrantedScopes applies only to Google OAuth", "invalid_input");

  if (
    (options.forceReauth !== undefined || options.enableFacebookLogin !== undefined) &&
    kind !== "instagram"
  )
    fail(
      "oauth.config",
      "forceReauth and enableFacebookLogin apply only to Instagram Business Login",
      "invalid_input",
    );

  if (kind === "linkedin") validateLinkedInVersion(options.linkedinApiVersion);
  const fetcher = options.fetch ?? webFetch;
  const scopes = options.scopes ?? cfg.scopes;
  const tiktokDesktop = kind === "tiktok" && options.tiktokLoginKit === "desktop";
  const pkce = cfg.pkce || tiktokDesktop;

  return {
    async start(input) {
      if (!input.platforms.includes(kind))
        fail(
          "connections.begin",
          `OAuth provider ${kind} cannot authorize the requested platforms`,
          "invalid_input",
        );

      if (options.redirectUri !== undefined && options.redirectUri !== input.redirectUri)
        fail(
          "connections.begin",
          "redirectUri does not match the configured OAuth callback",
          "invalid_input",
        );

      if (tiktokDesktop) validateLoopbackRedirect(input.redirectUri);

      const url = new URL(cfg.auth);
      url.searchParams.set(cfg.clientKey, options.clientId);
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(cfg.scopeDelimiter));
      url.searchParams.set("state", input.state);

      if (kind === "youtube") {
        url.searchParams.set("access_type", "offline");
        url.searchParams.set("prompt", "consent");

        if (options.includeGrantedScopes === true)
          url.searchParams.set("include_granted_scopes", "true");

        // Google accepts an email address or the user's `sub` ID to preselect the account.
        const hint = input.loginHint?.trim();

        if (hint) url.searchParams.set("login_hint", hint);
      }

      if (kind === "tiktok" && options.disableAutoAuth === true)
        url.searchParams.set("disable_auto_auth", "1");

      // Business Login for Instagram authorize options (checked 2026-11-04):
      // https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
      if (options.forceReauth !== undefined)
        url.searchParams.set("force_reauth", String(options.forceReauth));

      if (options.enableFacebookLogin !== undefined)
        url.searchParams.set("enable_fb_login", String(options.enableFacebookLogin));

      if (pkce) {
        url.searchParams.set(
          "code_challenge",
          tiktokDesktop ? hexChallenge(input.codeChallenge) : input.codeChallenge,
        );
        url.searchParams.set("code_challenge_method", "S256");
      }

      return { authorizationUrl: url.toString() };
    },
    async complete(input) {
      const callback = validateCallback(input);
      const denied = callback.searchParams.get("error");

      if (denied !== null) {
        const cancelled =
          denied === "access_denied" ||
          denied === "user_denied" ||
          callback.searchParams.get("error_reason") === "user_denied";

        fail(
          "connections.complete",
          "OAuth authorization was cancelled or denied",
          cancelled ? "cancelled" : "unauthorized",
        );
      }

      const code = callback.searchParams.get("code");

      if (!code)
        fail(
          "connections.complete",
          "OAuth callback did not include an authorization code",
          "invalid_input",
        );

      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: input.attempt.redirectUri,
        [cfg.clientKey]: options.clientId,
      });

      if (pkce) form.set("code_verifier", input.attempt.codeVerifier);

      const tokenHeaders = new Headers({
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      });

      if (kind === "x" && options.clientSecret)
        tokenHeaders.set(
          "authorization",
          `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`,
        );
      else if (options.clientSecret) form.set("client_secret", options.clientSecret);

      const raw = await request(
        fetcher,
        cfg.token,
        {
          method: "POST",
          headers: tokenHeaders,
          body: form,
        },
        "oauth.token",
        options,
      );

      let result = tokenResult(raw, kind);

      if ((kind === "threads" || kind === "instagram") && options.clientSecret)
        result =
          result.accountHint === undefined
            ? { token: await exchangeLongLived(kind, options, result.token) }
            : {
                token: await exchangeLongLived(kind, options, result.token),
                accountHint: result.accountHint,
              };

      const accounts = await discover(
        kind,
        result.token,
        result.accountHint,
        input.attempt.backend,
        fetcher,
        options,
      );

      providerIdentity(kind, result.accountHint, accounts);
      validateDiscoveredAccounts(input.attempt, accounts);

      if (options.credentialSink) {
        const selectedIds = options.selectAccounts
          ? await options.selectAccounts(accounts, input.attempt)
          : accounts.map((item) => item.ref.accountId);

        const selected = new Set(selectedIds);

        if (
          selected.size !== selectedIds.length ||
          selectedIds.some((id) => !accounts.some((item) => item.ref.accountId === id))
        )
          fail(
            "oauth.accounts",
            "Credential selection must contain distinct discovered account IDs",
            "invalid_input",
          );

        for (const item of accounts)
          if (selected.has(item.ref.accountId))
            await options.credentialSink.save({
              account: item,
              token: result.token,
              attempt: input.attempt,
            });
      }

      return accounts;
    },
  };
}

async function discover(
  kind: ProviderKind,
  token: OAuthTokenSet,
  hint: string | undefined,
  backend: string,
  fetcher: typeof fetch,
  options: OAuthProviderOptions,
): Promise<readonly ConnectionAccount[]> {
  const auth = { Authorization: `Bearer ${token.accessToken}`, accept: "application/json" };

  if (kind === "youtube") {
    const accounts: ConnectionAccount[] = [];
    const seen = new Set<string>();

    const url = new URL(
      "https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true&maxResults=50",
    );

    for (let page = 0; page < 100; page++) {
      const data = await request(
        fetcher,
        url.toString(),
        { headers: auth },
        "youtube.account",
        options,
      );

      const items = Array.isArray(data["items"]) ? data["items"] : [];

      for (const item of items) {
        const row = asRecord(item, "youtube.account");
        const snippet = asRecord(row["snippet"] ?? {}, "youtube.account");
        accounts.push(
          account(
            "youtube",
            backend,
            requiredString(row["id"], "channel id", "youtube.account"),
            stringOr(snippet["title"], "YouTube channel"),
          ),
        );
      }

      if (data["nextPageToken"] === undefined) return accounts;
      const next = requiredString(data["nextPageToken"], "nextPageToken", "youtube.account");

      if (seen.has(next))
        fail("youtube.account", "YouTube account discovery repeated a continuation token");
      seen.add(next);
      url.searchParams.set("pageToken", next);
    }

    fail("youtube.account", "YouTube account discovery exceeded the 100-page limit");
  }

  if (kind === "x") {
    const data = await request(
      fetcher,
      "https://api.x.com/2/users/me",
      { headers: auth },
      "x.account",
      options,
    );

    const row = asRecord(data["data"], "x.account");

    return [
      account(
        "x",
        backend,
        requiredString(row["id"], "user id", "x.account"),
        stringOr(row["name"], "X account"),
      ),
    ];
  }

  if (kind === "threads") {
    const version = options.threadsApiVersion ?? "v1.0";

    if (!/^v\d+\.\d+$/.test(version))
      fail("oauth.config", "Threads API version is invalid", "invalid_input");

    const data = await request(
      fetcher,
      `https://graph.threads.net/${version}/me?fields=id,username`,
      { headers: auth },
      "threads.account",
      options,
    );

    return [
      account(
        "threads",
        backend,
        requiredString(data["id"], "user id", "threads.account"),
        stringOr(data["username"], "Threads account"),
      ),
    ];
  }

  if (kind === "tiktok") {
    const data = await request(
      fetcher,
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name",
      { headers: auth },
      "tiktok.account",
      options,
    );

    const row = asRecord(data["data"], "tiktok.account");
    const user = asRecord(row["user"], "tiktok.account");

    return [
      account(
        "tiktok",
        backend,
        requiredString(user["open_id"], "open_id", "tiktok.account"),
        stringOr(user["display_name"], "TikTok account"),
      ),
    ];
  }

  if (kind === "instagram") {
    // Same Graph version as the Instagram adapter (src/platforms/instagram.ts).
    const version = options.instagramApiVersion ?? "v27.0";

    if (!/^v\d+\.\d+$/.test(version))
      fail("oauth.config", "Instagram API version is invalid", "invalid_input");

    const data = await request(
      fetcher,
      `https://graph.instagram.com/${version}/me?fields=id,user_id,username`,
      { headers: auth },
      "instagram.account",
      options,
    );

    const discoveredAccountId = requiredString(
      data["user_id"] ?? data["id"],
      "user id",
      "instagram.account",
    );

    // The exchange may identify the app-scoped id; publishing uses user_id.
    if (hint !== undefined && hint !== discoveredAccountId && hint !== optionalString(data["id"]))
      fail(
        "oauth.identity",
        "OAuth token identity did not match the discovered account",
        "unauthorized",
      );

    return [
      account(
        "instagram",
        backend,
        discoveredAccountId,
        stringOr(data["username"], "Instagram account"),
      ),
    ];
  }

  const version = validateLinkedInVersion(options.linkedinApiVersion);

  const data = await request(
    fetcher,
    "https://api.linkedin.com/v2/userinfo",
    { headers: { ...auth, "LinkedIn-Version": version } },
    "linkedin.account",
    options,
  );

  const subject = requiredString(data["sub"], "member id", "linkedin.account");

  const member = account(
    "linkedin",
    backend,
    `urn:li:person:${subject}`,
    stringOr(data["name"], "LinkedIn member"),
  );

  let acl: JsonObject;

  try {
    acl = await request(
      fetcher,
      "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee",
      { headers: { ...auth, "LinkedIn-Version": version } },
      "linkedin.organizations",
      options,
    );
  } catch (error) {
    // Member-only grants commonly cannot read organization ACLs. That is a known
    // absence of organization evidence; transport and malformed responses still fail.
    if (error instanceof SocialError && error.code === "missing_permission") return [member];
    throw error;
  }

  const elements = Array.isArray(acl["elements"]) ? acl["elements"] : [];

  const organizations = elements.flatMap((entry) => {
    const row = asRecord(entry, "linkedin.organizations");

    const organizationTarget = row["organizationTarget"];

    const target = isString(organizationTarget)
      ? organizationTarget
      : stringOr(row["organizationalTarget"], "");

    const role = row["role"];

    if (
      (role !== "ADMINISTRATOR" &&
        role !== "CONTENT_ADMINISTRATOR" &&
        role !== "DIRECT_SPONSORED_CONTENT_POSTER") ||
      !/^urn:li:organization:[a-zA-Z0-9_-]+$/.test(target)
    )
      return [];
    const id = target.slice("urn:li:organization:".length);

    return [
      account("linkedin", backend, `urn:li:organization:${id}`, `LinkedIn organization ${id}`),
    ];
  });

  return [member, ...organizations];
}

async function exchangeLongLived(
  kind: "threads" | "instagram",
  options: OAuthProviderOptions,
  current: OAuthTokenSet,
): Promise<OAuthTokenSet> {
  if (!options.clientSecret)
    fail(
      "oauth.exchange",
      "A clientSecret is required for long-lived token exchange",
      "invalid_config",
    );

  const endpoint =
    kind === "threads"
      ? "https://graph.threads.net/access_token"
      : "https://graph.instagram.com/access_token";

  const params = new URLSearchParams({
    grant_type: kind === "threads" ? "th_exchange_token" : "ig_exchange_token",
    client_secret: options.clientSecret,
    access_token: current.accessToken,
  });

  const next = tokenSet(
    await request(
      options.fetch ?? webFetch,
      `${endpoint}?${params.toString()}`,
      { headers: { accept: "application/json" } },
      `oauth.${kind}.exchange`,
      options,
    ),
    `oauth.${kind}.exchange`,
  );

  return next.scopes === undefined && current.scopes !== undefined
    ? { ...next, scopes: current.scopes }
    : next;
}

/** Exchange a short-lived Threads or Instagram Login token for a long-lived token. */
export async function exchangeLongLivedOAuthToken(
  kind: "threads" | "instagram",
  options: OAuthProviderOptions,
  current: OAuthTokenSet,
): Promise<OAuthTokenSet> {
  return exchangeLongLived(kind, options, current);
}

/**
 * Google authorization-code provider for YouTube channels.
 *
 * Default scopes: `openid`, `https://www.googleapis.com/auth/userinfo.profile`,
 * `https://www.googleapis.com/auth/youtube.readonly` and
 * `https://www.googleapis.com/auth/youtube.upload`. Account discovery calls `channels.list` with
 * `mine=true`, so keep `youtube.readonly` (or a broader YouTube scope) in any custom list.
 *
 * The defaults do not cover `social.analytics.getReport`. It calls YouTube Analytics
 * `reports.query`, which needs `https://www.googleapis.com/auth/yt-analytics.readonly` and, per
 * Google's reference (checked 2026-11-10), `https://www.googleapis.com/auth/youtube.readonly`.
 * `scopes` replaces the defaults, so pass the defaults you still need plus the Analytics scope:
 *
 * @example
 * ```ts
 * const provider = youtubeOAuth({
 *   clientId,
 *   clientSecret,
 *   redirectUri,
 *   credentialSink,
 *   scopes: [
 *     "openid",
 *     "https://www.googleapis.com/auth/userinfo.profile",
 *     "https://www.googleapis.com/auth/youtube.readonly",
 *     "https://www.googleapis.com/auth/youtube.upload",
 *     "https://www.googleapis.com/auth/yt-analytics.readonly",
 *   ],
 * });
 * ```
 *
 * Source: https://developers.google.com/youtube/analytics/reference/reports/query
 */
export const youtubeOAuth = (options: OAuthProviderOptions) => oauthProvider("youtube", options);

export const xOAuth = (options: OAuthProviderOptions) => oauthProvider("x", options);

export const threadsOAuth = (options: OAuthProviderOptions) => oauthProvider("threads", options);

export const tiktokOAuth = (options: OAuthProviderOptions) => oauthProvider("tiktok", options);

/**
 * Revoke a TikTok user access token with `POST /v2/oauth/revoke/`, sending the app's client key
 * (`clientId`), client secret and the token as a form. TikTok answers success with an empty body.
 * Returns `"revoked"` only for that empty body (or `{}`), so it can back
 * `OAuthConnectHandlersOptions.grants.revoke`. A documented OAuth error body is a definite
 * `upstream_failure`; any other 2xx answer is `ambiguous_outcome` with `reconcile-first`.
 * A response lost after the request is sent throws `ambiguous_outcome` with `reconcile-first`:
 * the grant may already be revoked.
 * Source, accessed 2026-11-04: https://developers.tiktok.com/doc/oauth-revoke-a-user-access-token
 */
export async function revokeTikTokOAuthToken(
  options: OAuthProviderOptions,
  token: Pick<OAuthTokenSet, "accessToken">,
): Promise<"revoked"> {
  const operation = "oauth.tiktok.revoke";

  if (!options.clientId.trim() || !options.clientSecret?.trim())
    fail("oauth.config", "TikTok revocation requires clientId and clientSecret", "invalid_input");

  if (!token.accessToken.trim()) fail(operation, "An access token is required", "invalid_input");

  const result = await request(
    options.fetch ?? webFetch,
    "https://open.tiktokapis.com/v2/oauth/revoke/",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        client_key: options.clientId,
        client_secret: options.clientSecret,
        token: token.accessToken,
      }),
    },
    operation,
    options,
    true,
    true,
  );

  // TikTok documents success as an empty body, read here as `{}`.
  if (Object.keys(result).length === 0) return "revoked";

  // A documented OAuth error body (`error`, `error_description`, `log_id`) refuses the revocation.
  // Only a machine-code `error` is kept; the description is provider prose and is dropped.
  const error = result["error"];

  if (isString(error) && error !== "")
    throw new SocialError({
      code: "upstream_failure",
      operation,
      message: "TikTok did not revoke the access token",
      ...definedFields({ upstreamCode: /^[a-z_]{1,64}$/.test(error) ? error : undefined }),
    });

  // Any other answer after dispatch does not say whether the grant was revoked.
  throw new SocialError({
    code: "ambiguous_outcome",
    operation,
    message: "TikTok did not confirm the revocation. Check the grant before retrying.",
    retryDisposition: { kind: "reconcile-first" },
  });
}

/** Status values of `POST /v2/oauth/check_qrcode/`. `utilised` appears in TikTok's examples. */
export type TikTokQrCodeStatus = "new" | "scanned" | "confirmed" | "expired" | "utilised";

/** A Login Kit QR code returned by {@link createTikTokQrCode}. Keep it for the whole QR flow. */
export interface TikTokQrCode {
  /** TikTok's QR `token`; send it to {@link checkTikTokQrCode}. Keep it server-side. */
  readonly token: string;
  /** `scan_qrcode_url` with `client_ticket` set to {@link clientTicket}. Render it as the QR code. */
  readonly scanQrCodeUrl: string;
  /** The integrity ticket placed in the QR URL. TikTok echoes it on each successful check. */
  readonly clientTicket: string;
  /** The `state` sent to TikTok, compared with the confirmed response. */
  readonly state?: string;
}

export type TikTokQrCodeCheck =
  | { readonly status: Exclude<TikTokQrCodeStatus, "confirmed"> }
  | {
      readonly status: "confirmed";
      /** Authorization code to exchange with {@link exchangeTikTokQrCode}. */
      readonly code: string;
      /** The app's redirect URI from the confirmed response, without `code` and `state`. */
      readonly redirectUri?: string;
    };

const qrStatuses: readonly TikTokQrCodeStatus[] = [
  "new",
  "scanned",
  "confirmed",
  "expired",
  "utilised",
];

function isQrStatus(value: JsonField): value is TikTokQrCodeStatus {
  return qrStatuses.some((status) => status === value);
}

function tiktokFormError(data: JsonObject, operation: string, message: string): void {
  const error = data["error"];

  const providerCode = isString(error)
    ? error
    : isJsonObject(error) && isString(error["code"]) && error["code"] !== "ok"
      ? error["code"]
      : undefined;

  if (providerCode !== undefined && providerCode !== "")
    throw new SocialError({
      code: "upstream_failure",
      operation,
      message,
      upstreamCode: providerCode,
    });
}

function randomTicket(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function requireTikTokSecret(options: OAuthProviderOptions, operation: string): string {
  if (!options.clientId.trim() || !options.clientSecret?.trim())
    fail("oauth.config", `${operation} requires clientId and clientSecret`, "invalid_input");

  return options.clientSecret;
}

function formPost(form: URLSearchParams): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
  };
}

/**
 * Login Kit QR code authorization, step 1: `POST /v2/oauth/get_qrcode/` with `client_key`,
 * comma-separated `scope` and optional `state`. Sets the `client_ticket` query parameter of the
 * returned `scan_qrcode_url` to a random URL-safe ticket (or `input.clientTicket`), as TikTok
 * requires. Use it on TVs, kiosks and other surfaces without a browser redirect.
 * Source, accessed 2026-11-04: https://developers.tiktok.com/doc/login-kit-qr-code-authorization
 */
export async function createTikTokQrCode(
  options: OAuthProviderOptions,
  input: {
    readonly scopes?: readonly string[];
    readonly state?: string;
    readonly clientTicket?: string;
  } = {},
): Promise<TikTokQrCode> {
  const operation = "oauth.tiktok.qrcode";

  if (!options.clientId.trim()) fail("oauth.config", "clientId is required", "invalid_input");

  const clientTicket = input.clientTicket ?? randomTicket();

  if (!/^[A-Za-z0-9._~-]+$/.test(clientTicket) || encodeURIComponent(clientTicket).length >= 512)
    fail(
      operation,
      "client_ticket must be URL-safe and shorter than 512 characters",
      "invalid_input",
    );

  const scopes = input.scopes ?? options.scopes ?? configs.tiktok.scopes;

  if (scopes.length === 0 || scopes.some((scope) => !/^[a-z0-9._]+$/i.test(scope)))
    fail(operation, "TikTok scopes must be non-empty scope names", "invalid_input");

  const form = new URLSearchParams({ client_key: options.clientId, scope: scopes.join(",") });

  if (input.state !== undefined) form.set("state", input.state);

  const data = await request(
    options.fetch ?? webFetch,
    "https://open.tiktokapis.com/v2/oauth/get_qrcode/",
    formPost(form),
    operation,
    options,
  );

  tiktokFormError(data, operation, "TikTok did not create a QR code");

  const token = requiredString(data["token"], "token", operation);
  let scanUrl: URL;

  try {
    scanUrl = new URL(requiredString(data["scan_qrcode_url"], "scan_qrcode_url", operation));
  } catch (error) {
    if (error instanceof SocialError) throw error;
    fail(operation, "TikTok returned an invalid scan_qrcode_url");
  }

  // TikTok documents an app deep link (`aweme://authorize?...`); accept it and HTTPS links only.
  // Source, accessed 2026-11-04: https://developers.tiktok.com/doc/login-kit-qr-code-authorization
  if (scanUrl.protocol !== "https:" && scanUrl.protocol !== "aweme:")
    fail(operation, "TikTok returned an invalid scan_qrcode_url");

  scanUrl.searchParams.set("client_ticket", clientTicket);

  return {
    token,
    scanQrCodeUrl: scanUrl.toString(),
    clientTicket,
    ...definedFields({ state: input.state }),
  };
}

/**
 * Login Kit QR code authorization, step 2: `POST /v2/oauth/check_qrcode/` with `client_key`,
 * `client_secret` and the QR `token`. Poll it while the status is `new` or `scanned`; on
 * `expired`, create a new QR code. Each response that carries a `client_ticket` must echo the
 * ticket from {@link createTikTokQrCode}, and a `confirmed` response must carry it and the
 * `state` that was sent; otherwise this throws `unauthorized` and the response is discarded.
 * The authorization code comes from `code`, or from the `code` query parameter of
 * `redirect_uri` when only that is present, as in TikTok's example.
 */
export async function checkTikTokQrCode(
  options: OAuthProviderOptions,
  qr: Pick<TikTokQrCode, "token" | "clientTicket" | "state">,
): Promise<TikTokQrCodeCheck> {
  const operation = "oauth.tiktok.qrcode.check";
  const clientSecret = requireTikTokSecret(options, "TikTok QR code checks");

  if (!qr.token.trim()) fail(operation, "A QR code token is required", "invalid_input");

  const data = await request(
    options.fetch ?? webFetch,
    "https://open.tiktokapis.com/v2/oauth/check_qrcode/",
    formPost(
      new URLSearchParams({
        client_key: options.clientId,
        client_secret: clientSecret,
        token: qr.token,
      }),
    ),
    operation,
    options,
  );

  tiktokFormError(data, operation, "TikTok did not return the QR code status");

  const status = data["status"];

  if (!isQrStatus(status)) fail(operation, "TikTok returned an unknown QR code status");

  const ticket = optionalString(data["client_ticket"]);

  if ((ticket !== undefined || status === "confirmed") && ticket !== qr.clientTicket)
    fail(operation, "TikTok QR code response did not echo this client_ticket", "unauthorized");

  if (status !== "confirmed") return { status };

  let redirect: URL | undefined;
  const rawRedirect = optionalString(data["redirect_uri"]);

  if (rawRedirect !== undefined)
    try {
      redirect = new URL(rawRedirect);
    } catch {
      fail(operation, "TikTok returned an invalid redirect_uri");
    }

  const code =
    optionalString(data["code"]) ?? optionalString(redirect?.searchParams.get("code") ?? undefined);

  if (code === undefined) fail(operation, "OAuth provider response is missing code");

  const state =
    optionalString(data["state"]) ??
    optionalString(redirect?.searchParams.get("state") ?? undefined);

  if (qr.state !== undefined && state !== qr.state)
    fail(operation, "TikTok QR code state did not match", "unauthorized");

  if (redirect === undefined) return { status, code };

  for (const name of ["code", "state", "scopes"]) redirect.searchParams.delete(name);

  return { status, code, redirectUri: redirect.toString() };
}

/**
 * Login Kit QR code authorization, step 3: exchange a confirmed QR code's authorization code on
 * `POST /v2/oauth/token/` (`grant_type=authorization_code`). TikTok requires `redirect_uri` to
 * match the app's registered redirect URI; pass `redirectUri` from the confirmed check, or set
 * `options.redirectUri`. Returns the token set, including `refreshExpiresAt`, and the creator's
 * `open_id`.
 */
export async function exchangeTikTokQrCode(
  options: OAuthProviderOptions,
  input: { readonly code: string; readonly redirectUri?: string },
): Promise<{ readonly token: OAuthTokenSet; readonly openId: string }> {
  const operation = "oauth.tiktok.qrcode.token";
  const clientSecret = requireTikTokSecret(options, "TikTok QR code token exchange");
  const redirectUri = input.redirectUri ?? options.redirectUri;

  if (!input.code.trim()) fail(operation, "An authorization code is required", "invalid_input");

  if (redirectUri === undefined || !redirectUri.trim())
    fail(operation, "TikTok's token exchange requires redirect_uri", "invalid_input");

  const data = await request(
    options.fetch ?? webFetch,
    configs.tiktok.token,
    formPost(
      new URLSearchParams({
        client_key: options.clientId,
        client_secret: clientSecret,
        code: input.code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    ),
    operation,
    options,
  );

  tiktokFormError(data, operation, "TikTok did not issue a token for the QR code");

  const result = tokenResult(data, "tiktok");

  if (result.accountHint === undefined)
    fail(operation, "OAuth provider response is missing open_id");

  return { token: result.token, openId: result.accountHint };
}

/**
 * Revoke a Google OAuth grant with `POST https://oauth2.googleapis.com/revoke`, sending the token
 * as a form. Revoking an access token also revokes its refresh token. Google answers 200 on
 * success and 400 with an error code otherwise. Returns `"revoked"`, so it can back
 * `OAuthConnectHandlersOptions.grants.revoke`.
 * A response lost after the request is sent throws `ambiguous_outcome` with `reconcile-first`:
 * the grant may already be revoked.
 * Source, accessed 2026-11-04: https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps
 */
export async function revokeGoogleOAuthToken(
  options: Pick<OAuthProviderOptions, "fetch" | "timeoutMs" | "maxResponseBytes" | "signal">,
  token: { readonly token: string },
): Promise<"revoked"> {
  const operation = "oauth.youtube.revoke";

  if (!token.token.trim())
    fail(operation, "An access or refresh token is required", "invalid_input");

  await request(
    options.fetch ?? webFetch,
    "https://oauth2.googleapis.com/revoke",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({ token: token.token }),
    },
    operation,
    { clientId: "", ...options },
    true,
    true,
  );

  return "revoked";
}

/**
 * Revoke an X OAuth 2.0 access or refresh token with `POST https://api.x.com/2/oauth2/revoke`.
 * Confidential clients authenticate with HTTP Basic; public clients send `client_id` in the form.
 * Returns `"revoked"` unless X answers `revoked: false`, so it can back
 * `OAuthConnectHandlersOptions.grants.revoke`.
 * A response lost after the request is sent throws `ambiguous_outcome` with `reconcile-first`:
 * the grant may already be revoked.
 * Source, accessed 2026-11-04:
 * https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token
 */
export async function revokeXOAuthToken(
  options: OAuthProviderOptions,
  token: { readonly token: string },
): Promise<"revoked"> {
  const operation = "oauth.x.revoke";

  if (!options.clientId.trim())
    fail("oauth.config", "X revocation requires clientId", "invalid_input");

  if (!token.token.trim()) fail(operation, "A token is required", "invalid_input");

  const form = new URLSearchParams({ token: token.token });

  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  });

  if (options.clientSecret)
    headers.set("authorization", `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`);
  else form.set("client_id", options.clientId);

  const result = await request(
    options.fetch ?? webFetch,
    "https://api.x.com/2/oauth2/revoke",
    { method: "POST", headers, body: form },
    operation,
    options,
    true,
    true,
  );

  if (result["revoked"] === false)
    throw new SocialError({
      code: "upstream_failure",
      operation,
      message: "X did not revoke the token",
    });

  return "revoked";
}

export const instagramOAuth = (options: OAuthProviderOptions) =>
  oauthProvider("instagram", options);

export const linkedinOAuth = (options: OAuthProviderOptions) => oauthProvider("linkedin", options);

/** Token state from LinkedIn token introspection. Times are ISO strings from epoch seconds. */
export interface LinkedInTokenIntrospection {
  /** False for expired, revoked or foreign tokens, including tokens of another client. */
  readonly active: boolean;
  /** `active`, `expired` or `revoked`. */
  readonly status?: string;
  /** Returned only for 3-legged (authorization code) tokens. */
  readonly scopes?: readonly string[];
  readonly clientId?: string;
  /** `3L` member token, `2L` application token, or `Enterprise_User`. */
  readonly authType?: string;
  readonly createdAt?: string;
  readonly authorizedAt?: string;
  readonly expiresAt?: string;
}

/**
 * Inspect a LinkedIn access token with `POST https://www.linkedin.com/oauth/v2/introspectToken`,
 * sending the app's client ID, client secret and the token as a form. Use it for connection health
 * checks; it does not refresh or change the token.
 * Source, accessed 2026-11-04: https://learn.microsoft.com/en-us/linkedin/shared/authentication/token-introspection
 */
export async function introspectLinkedInOAuthToken(
  options: OAuthProviderOptions,
  token: Pick<OAuthTokenSet, "accessToken">,
): Promise<LinkedInTokenIntrospection> {
  const operation = "oauth.linkedin.introspect";

  if (!options.clientId.trim() || !options.clientSecret?.trim())
    fail(
      "oauth.config",
      "LinkedIn token introspection requires clientId and clientSecret",
      "invalid_input",
    );

  if (!token.accessToken.trim()) fail(operation, "An access token is required", "invalid_input");

  const result = await request(
    options.fetch ?? webFetch,
    "https://www.linkedin.com/oauth/v2/introspectToken",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        token: token.accessToken,
      }),
    },
    operation,
    options,
  );

  const active = result["active"];

  if (!isBoolean(active))
    fail(operation, "LinkedIn introspection response is missing active", "upstream_failure");

  const text = (value: JsonField) => (isString(value) && value !== "" ? value : undefined);

  const time = (value: JsonField) =>
    isFiniteNumber(value) && value > 0 ? new Date(value * 1000).toISOString() : undefined;

  const scope = text(result["scope"]);

  return {
    active,
    ...definedFields({
      status: text(result["status"]),
      scopes:
        scope === undefined
          ? undefined
          : scope
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry !== ""),
      clientId: text(result["client_id"]),
      authType: text(result["auth_type"]),
      createdAt: time(result["created_at"]),
      authorizedAt: time(result["authorized_at"]),
      expiresAt: time(result["expires_at"]),
    }),
  };
}

export async function refreshOAuthToken(
  kind: ProviderKind,
  options: OAuthProviderOptions,
  current: OAuthTokenSet,
): Promise<OAuthTokenSet> {
  if (kind === "threads" || kind === "instagram") {
    const endpoint =
      kind === "threads"
        ? "https://graph.threads.net/refresh_access_token"
        : "https://graph.instagram.com/refresh_access_token";

    const grant = kind === "threads" ? "th_refresh_token" : "ig_refresh_token";
    const params = new URLSearchParams({ grant_type: grant, access_token: current.accessToken });

    const next = tokenSet(
      await request(
        options.fetch ?? webFetch,
        `${endpoint}?${params.toString()}`,
        { headers: { accept: "application/json" } },
        `oauth.${kind}.refresh`,
        options,
      ),
      `oauth.${kind}.refresh`,
    );

    const retained =
      next.scopes === undefined && current.scopes !== undefined
        ? { ...next, scopes: current.scopes }
        : next;

    return keepRefreshToken(retained, current);
  }

  if (!current.refreshToken)
    fail(
      "oauth.refresh",
      "No refresh token is available; reconnect the account",
      "reconnect_required",
    );
  const cfg = configs[kind];

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
    [cfg.clientKey]: options.clientId,
  });

  const refreshHeaders = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  });

  if (kind === "x" && options.clientSecret)
    refreshHeaders.set(
      "authorization",
      `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`,
    );
  else if (options.clientSecret) form.set("client_secret", options.clientSecret);

  const next = tokenSet(
    await request(
      options.fetch ?? webFetch,
      cfg.token,
      {
        method: "POST",
        headers: refreshHeaders,
        body: form,
      },
      "oauth.refresh",
      options,
    ),
    "oauth.refresh",
  );

  return keepRefreshToken(next, current);
}

/**
 * Exchanges a stored X OAuth 1.0a user access token and secret for OAuth 2.0 tokens with the
 * `token-exchange` grant on `POST /2/oauth2/token`, without a consent screen. X derives the
 * scopes from the user's original OAuth 1.0a permissions and always adds `offline.access`;
 * `scopes` can only narrow them. Confidential clients authenticate with HTTP Basic, public clients
 * send `client_id`. Source, checked 2026-11-04:
 * https://docs.x.com/fundamentals/authentication/oauth-2-0/oauth-1-0a-token-exchange
 */
export async function exchangeXOAuth1Token(
  options: OAuthProviderOptions,
  oauth1: {
    readonly token: string;
    readonly tokenSecret: string;
    readonly scopes?: readonly string[];
  },
): Promise<OAuthTokenSet> {
  const operation = "oauth.x.tokenExchange";

  if (!oauth1.token.trim() || !oauth1.tokenSecret.trim())
    fail(operation, "Provide the user's OAuth 1.0a access token and secret", "invalid_input");

  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: oauth1.token,
    subject_token_type: "urn:x:params:oauth:token-type:oauth1_token",
    oauth_token_secret: oauth1.tokenSecret,
  });

  if (oauth1.scopes !== undefined && oauth1.scopes.length > 0)
    form.set("scope", oauth1.scopes.join(" "));

  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  });

  if (options.clientSecret)
    headers.set("authorization", `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`);
  else form.set("client_id", options.clientId);

  return tokenSet(
    await request(
      options.fetch ?? webFetch,
      configs.x.token,
      { method: "POST", headers, body: form },
      operation,
      options,
    ),
    operation,
  );
}
