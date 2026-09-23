/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/require-readable-spacing -- OAuth responses are unknown by contract and validated at this boundary. */
import { SocialError } from "../core/errors.js";
import { connectedAccountRef, type Platform } from "../core/types.js";
import type { ConnectionAccount, ConnectionAttempt, ConnectionProvider } from "./connections.js";

export interface OAuthTokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
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
  readonly scopes?: readonly string[];
  /** Explicit LinkedIn Marketing API version (YYYYMM). Required for LinkedIn OAuth. */
  readonly linkedinApiVersion?: string;
  /** Graph API version for Threads account discovery. */
  readonly threadsApiVersion?: string;
  /** Graph API version for Instagram Login account discovery. */
  readonly instagramApiVersion?: string;
  /** Maximum time for a single OAuth request. Defaults to ten seconds. */
  readonly timeoutMs?: number;
  /** Maximum response body size. Defaults to one MiB. */
  readonly maxResponseBytes?: number;
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

function asRecord(value: unknown, operation = "oauth.response"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(operation, "OAuth provider returned an invalid response");

  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, operation = "oauth.response"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192)
    fail(operation, `OAuth provider response is missing ${field}`);

  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 8192 ? value : undefined;
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

async function readBounded(
  response: Response,
  maxBytes: number,
  operation: string,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    fail("oauth.config", "maxResponseBytes must be a positive safe integer", "invalid_input");

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const part = await reader.read();

      if (part.done) break;
      total += part.value.byteLength;

      if (total > maxBytes) {
        await reader.cancel();
        fail(
          operation,
          "OAuth provider response exceeded the configured size limit",
          "upstream_failure",
        );
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

  return new TextDecoder().decode(merged);
}

async function body(
  response: Response,
  operation: string,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const raw = await readBounded(response, maxBytes, operation);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  if (!response.ok) {
    let providerCode: string | undefined;

    try {
      const parsed: unknown =
        contentType.includes("json") || raw.trimStart().startsWith("{")
          ? JSON.parse(raw)
          : Object.fromEntries(new URLSearchParams(raw).entries());
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const error = (parsed as Record<string, unknown>)["error"];
        providerCode = typeof error === "string" ? error : undefined;
      }
    } catch {
      // Preserve the HTTP error classification when an upstream error body is malformed.
    }

    return errorForResponse(response.status, operation, providerCode);
  }

  if (raw.trim() === "") fail(operation, "OAuth provider returned an empty response");

  if (
    contentType.includes("application/json") ||
    contentType.includes("+json") ||
    raw.trimStart().startsWith("{")
  ) {
    try {
      return asRecord(JSON.parse(raw), operation);
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

function parseScopes(value: unknown): readonly string[] | undefined {
  const scope = optionalString(value);

  return scope === undefined ? undefined : scope.split(/[\s,]+/).filter(Boolean);
}

function tokenSet(data: Record<string, unknown>, operation = "oauth.token"): OAuthTokenSet {
  const accessToken = requiredString(data["access_token"], "access_token", operation);
  const expires = data["expires_in"];
  let expiresAt: string | undefined;

  if (expires !== undefined) {
    const seconds =
      typeof expires === "number"
        ? expires
        : typeof expires === "string" && /^\d+(?:\.\d+)?$/.test(expires)
          ? Number(expires)
          : Number.NaN;

    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 31_536_000_000)
      fail(operation, "OAuth provider returned an invalid token lifetime");
    expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
  }

  const refreshToken = optionalString(data["refresh_token"]);
  const scopes = parseScopes(data["scope"]);
  const tokenType = optionalString(data["token_type"]);

  // oxlint-disable-next-line anti-slop/no-known-value-widening -- validated boundary or fixture contract.
  const result: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
    scopes?: readonly string[];
    tokenType?: string;
    // oxlint-disable-next-line anti-slop/no-known-value-widening -- provider payload is validated at this adapter boundary.
  } = { accessToken };

  if (refreshToken !== undefined) result.refreshToken = refreshToken;

  if (expiresAt !== undefined) result.expiresAt = expiresAt;

  if (scopes !== undefined) result.scopes = scopes;

  if (tokenType !== undefined) result.tokenType = tokenType;

  return result;
}

interface TokenResult {
  readonly token: OAuthTokenSet;
  readonly accountHint?: string;
}

function tokenResult(data: Record<string, unknown>, kind: ProviderKind): TokenResult {
  let nested = data;
  if (kind === "tiktok" && data["data"] !== undefined)
    nested = asRecord(data["data"], "oauth.token");
  if (kind === "instagram" && Array.isArray(data["data"])) {
    const first = data["data"][0];
    nested = asRecord(first, "oauth.token");
  }

  const token = tokenSet(nested);
  const accountHint = optionalString(nested["user_id"]) ?? optionalString(nested["open_id"]);

  return accountHint === undefined ? { token } : { token, accountHint };
}

async function request(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
  options: OAuthProviderOptions,
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    fail("oauth.config", "timeoutMs must be a positive safe integer", "invalid_input");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let raceTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    // AbortController handles standards-compliant fetch implementations; the
    // race also bounds injected fetchers that ignore AbortSignal.
    const timeout = new Promise<never>((_, reject) => {
      raceTimer = setTimeout(
        () => reject(new DOMException("OAuth request timed out", "AbortError")),
        timeoutMs,
      );
    });

    const response = await Promise.race([
      fetcher(url, { ...init, redirect: "error", signal: controller.signal }),
      timeout,
    ]);

    return await Promise.race([
      body(response, operation, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES),
      timeout,
    ]);
  } catch (error) {
    if (error instanceof SocialError) throw error;

    if (
      (error instanceof DOMException && error.name === "AbortError") ||
      (typeof error === "object" &&
        error !== null &&
        "name" in error &&
        (error as { name?: unknown }).name === "AbortError")
    )
      fail(operation, "OAuth provider request timed out", "timeout");
    fail(operation, "OAuth provider request failed", "upstream_failure", error);
  } finally {
    clearTimeout(timer);

    if (raceTimer !== undefined) clearTimeout(raceTimer);
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

function validateCallback(input: {
  readonly callbackUrl: string;
  readonly attempt: ConnectionAttempt;
}): URL {
  let callback: URL;

  try {
    callback = new URL(input.callbackUrl);
  } catch {
    fail("connections.complete", "OAuth callback URL is invalid", "invalid_input");
  }

  let expected: URL;

  try {
    expected = new URL(input.attempt.redirectUri);
  } catch {
    fail("connections.complete", "OAuth attempt redirect URI is invalid", "invalid_input");
  }

  if (
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.username ||
    callback.password ||
    callback.hash
  )
    fail(
      "connections.complete",
      "OAuth callback does not match the registered redirect",
      "unauthorized",
    );

  for (const [key, value] of expected.searchParams)
    if (callback.searchParams.getAll(key).length !== 1 || callback.searchParams.get(key) !== value)
      fail(
        "connections.complete",
        "OAuth callback does not match the registered redirect",
        "unauthorized",
      );
  const states = callback.searchParams.getAll("state");

  if (states.length !== 1 || states[0] !== input.attempt.state)
    fail(
      "connections.complete",
      "OAuth callback state did not match the authenticated attempt",
      "unauthorized",
    );

  return callback;
}

function providerIdentity(
  kind: ProviderKind,
  hint: string | undefined,
  discovered: readonly ConnectionAccount[],
): void {
  if (hint === undefined) return;
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

export function oauthProvider(
  kind: ProviderKind,
  options: OAuthProviderOptions,
): ConnectionProvider {
  const cfg = configs[kind];

  if (!options.clientId.trim()) fail("oauth.config", "clientId is required", "invalid_input");

  if (kind === "linkedin") validateLinkedInVersion(options.linkedinApiVersion);
  const fetcher = options.fetch ?? webFetch;
  const scopes = options.scopes ?? cfg.scopes;

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
      const url = new URL(cfg.auth);
      url.searchParams.set(cfg.clientKey, options.clientId);
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(cfg.scopeDelimiter));
      url.searchParams.set("state", input.state);

      if (kind === "youtube") {
        url.searchParams.set("access_type", "offline");
        url.searchParams.set("prompt", "consent");
      }

      if (cfg.pkce) {
        url.searchParams.set("code_challenge", input.codeChallenge);
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

      if (cfg.pkce) form.set("code_verifier", input.attempt.codeVerifier);

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
    const data = await request(
      fetcher,
      "https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true",
      { headers: auth },
      "youtube.account",
      options,
    );

    const items = Array.isArray(data["items"]) ? data["items"] : [];

    return items.map((item) => {
      const row = asRecord(item, "youtube.account");
      const snippet = asRecord(row["snippet"] ?? {}, "youtube.account");

      return account(
        "youtube",
        backend,
        requiredString(row["id"], "channel id", "youtube.account"),
        typeof snippet["title"] === "string" ? snippet["title"] : "YouTube channel",
      );
    });
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
        typeof row["name"] === "string" ? row["name"] : "X account",
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
        typeof data["username"] === "string" ? data["username"] : "Threads account",
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
        typeof user["display_name"] === "string" ? user["display_name"] : "TikTok account",
      ),
    ];
  }

  if (kind === "instagram") {
    const version = options.instagramApiVersion ?? "v25.0";

    if (!/^v\d+\.\d+$/.test(version))
      fail("oauth.config", "Instagram API version is invalid", "invalid_input");

    const data = await request(
      fetcher,
      `https://graph.instagram.com/${version}/me?fields=id,user_id,username`,
      { headers: auth },
      "instagram.account",
      options,
    );

    const discoveredId = requiredString(
      data["id"] ?? data["user_id"],
      "user id",
      "instagram.account",
    );
    const discoveredUserId = optionalString(data["user_id"]);
    const discoveredAccountId =
      hint !== undefined && (hint === discoveredId || hint === discoveredUserId)
        ? hint
        : discoveredId;

    return [
      account(
        "instagram",
        backend,
        discoveredAccountId,
        typeof data["username"] === "string" ? data["username"] : "Instagram account",
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
    typeof data["name"] === "string" ? data["name"] : "LinkedIn member",
  );

  let acl: Record<string, unknown>;

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

    const target =
      typeof row["organizationTarget"] === "string"
        ? row["organizationTarget"]
        : typeof row["organizationalTarget"] === "string"
          ? row["organizationalTarget"]
          : "";

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

  return tokenSet(
    await request(
      options.fetch ?? webFetch,
      `${endpoint}?${params.toString()}`,
      { headers: { accept: "application/json" } },
      `oauth.${kind}.exchange`,
      options,
    ),
    `oauth.${kind}.exchange`,
  );
}

/** Exchange a short-lived Threads or Instagram Login token for a long-lived token. */
export async function exchangeLongLivedOAuthToken(
  kind: "threads" | "instagram",
  options: OAuthProviderOptions,
  current: OAuthTokenSet,
): Promise<OAuthTokenSet> {
  return exchangeLongLived(kind, options, current);
}

export const youtubeOAuth = (options: OAuthProviderOptions) => oauthProvider("youtube", options);

export const xOAuth = (options: OAuthProviderOptions) => oauthProvider("x", options);

export const threadsOAuth = (options: OAuthProviderOptions) => oauthProvider("threads", options);

export const tiktokOAuth = (options: OAuthProviderOptions) => oauthProvider("tiktok", options);

export const instagramOAuth = (options: OAuthProviderOptions) =>
  oauthProvider("instagram", options);

export const linkedinOAuth = (options: OAuthProviderOptions) => oauthProvider("linkedin", options);

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

    if (next.refreshToken !== undefined || current.refreshToken === undefined) return next;

    return { ...next, refreshToken: current.refreshToken };
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

  return next.refreshToken ? next : { ...next, refreshToken: current.refreshToken };
}
