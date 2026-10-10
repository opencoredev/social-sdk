import { createHash, randomBytes } from "node:crypto";
import { defineAdapter } from "../core/adapter.js";
import { SocialError, type SocialErrorCode } from "../core/errors.js";
import { definedFields } from "../core/fields.js";
import type {
  AccountRecord,
  AdapterOperationContext,
  BackendPostRef,
  ConnectedAccountRef,
  DeliveryOutcome,
  DeliveryRef,
  JsonObject,
  JsonValue,
  MetricValue,
  Platform,
  PlatformPostRef,
  PreparationIssue,
  ScheduleCancellation,
  ScheduledJobRef,
} from "../core/types.js";
import { remainingBudget } from "../transport/budget.js";
import { createHttp, HttpError, type HttpOptions } from "../transport/http.js";
import { httpsUrl } from "../transport/upload.js";
import {
  array,
  isBoolean,
  isJsonObject,
  isString,
  object,
  optionalNumber,
  optionalString,
  string,
  type JsonField,
} from "../transport/validation.js";
import {
  accountMatches,
  capabilityManifest,
  managedOptionIssues,
  managedPreparation,
  optionsObject,
  type ManagedOptions,
} from "./common.js";

export interface BufferOptions extends ManagedOptions {
  /** Limit channel and post queries to one Buffer organization. Omit to read every organization on the key. */
  readonly organizationId?: string;
}

export interface BufferAuthorizationUrlOptions {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  /** S256 challenge from `createBufferPkce()`. */
  readonly codeChallenge: string;
  readonly scopes?: readonly string[];
}

export interface BufferCodeExchangeOptions extends HttpOptions {
  readonly clientId: string;
  /** Confidential clients only. Public clients authenticate with PKCE alone. */
  readonly clientSecret?: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly signal?: AbortSignal;
}

export interface BufferRefreshOptions extends HttpOptions {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly refreshToken: string;
  readonly signal?: AbortSignal;
}

export interface BufferAccessToken {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: string;
  readonly expiresIn?: number;
  readonly scope?: string;
}

export interface BufferPkce {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

export const bufferScopes = [
  "posts:read",
  "posts:write",
  "account:read",
  "offline_access",
] as const;

const apiOrigin = "https://api.buffer.com";

const authOrigin = "https://auth.buffer.com";

const nativePlatforms = new Map<string, Platform>([
  ["twitter", "x"],
  ["threads", "threads"],
  ["bluesky", "bluesky"],
  ["youtube", "youtube"],
  ["tiktok", "tiktok"],
  ["instagram", "instagram"],
  ["linkedin", "linkedin"],
  ["facebook", "facebook"],
]);

const postSelection = `
  id
  text
  channelId
  channelService
  dueAt
  sentAt
  status
  shareMode
  externalLink
`;

const metricsSelection = `
  metrics {
    type
    value
    unit
    name
  }
  metricsUpdatedAt
`;

const reject = (operation: string, message: string): never => {
  throw new SocialError({ code: "invalid_input", operation, message });
};

function bufferId(value: string, operation: string, label: string): string {
  if (!value || value !== value.trim() || value.length > 256 || /[\s@]/.test(value))
    reject(operation, `Use a Buffer ${label} identifier.`);

  return value;
}

function originUrl(value: string, operation: string): URL {
  let url: URL | undefined;

  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }

  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new SocialError({
      code: "invalid_config",
      operation,
      message: "Configure the Buffer redirect URI as an HTTPS URL without credentials.",
    });

  return url;
}

function tokenError(error: HttpError, operation: string): SocialError {
  if (error.status === 401)
    return new SocialError({
      code: "invalid_config",
      operation,
      message: "Buffer rejected the OAuth client.",
      upstreamStatus: 401,
    });

  if (error.status === 400)
    return new SocialError({
      code: "invalid_input",
      operation,
      message:
        "Buffer rejected the authorization grant. It may be expired, used, or issued to another client. Start the authorization again.",
      upstreamStatus: 400,
    });

  if (error.status === 429)
    return new SocialError({
      code: "rate_limited",
      operation,
      message: "Buffer rate limited the token request.",
      upstreamStatus: 429,
      retryDisposition:
        error.retryAfterMs === undefined
          ? { kind: "never" }
          : { kind: "after-delay", delayMs: error.retryAfterMs },
    });

  const ambiguous =
    error.dispatched &&
    (error.kind !== "http" || (error.status !== undefined && error.status >= 500));

  return new SocialError({
    code: ambiguous
      ? "ambiguous_outcome"
      : error.kind === "cancelled"
        ? "cancelled"
        : error.kind === "timeout"
          ? "timeout"
          : error.kind === "invalid-input"
            ? "invalid_config"
            : "upstream_failure",
    operation,
    message: ambiguous
      ? "Buffer may have consumed the grant without returning tokens. Start the authorization again."
      : error.message,
    ...definedFields({ upstreamStatus: error.status }),
  });
}

function readToken(value: JsonValue, operation: string): BufferAccessToken {
  const row = object(value);
  const accessToken = optionalString(row["access_token"]);
  const tokenType = optionalString(row["token_type"]);

  if (!accessToken || !tokenType)
    throw new SocialError({
      code: "upstream_failure",
      operation,
      message: "Buffer did not return an access token. Start the authorization again.",
    });

  return {
    accessToken,
    tokenType,
    ...definedFields({
      refreshToken: optionalString(row["refresh_token"]),
      expiresIn: optionalNumber(row["expires_in"]),
      scope: optionalString(row["scope"]),
    }),
  };
}

async function requestToken(
  body: URLSearchParams,
  options: HttpOptions & { readonly signal?: AbortSignal },
  operation: string,
): Promise<BufferAccessToken> {
  let response: JsonValue;

  try {
    response = await createHttp(options)({
      url: new URL("/token", authOrigin),
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      ...definedFields({ signal: options.signal }),
    });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;

    throw tokenError(error, operation);
  }

  return readToken(response, operation);
}

/** Create a PKCE verifier and S256 challenge for Buffer's authorization-code flow. */
export function createBufferPkce(): BufferPkce {
  const codeVerifier = randomBytes(32).toString("base64url");

  return {
    codeVerifier,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
  };
}

/**
 * Build the Buffer URL that asks a person to approve your OAuth app. Buffer then
 * redirects to your registered URI with `code` and `state`, or with `error`.
 */
export function bufferAuthorizationUrl(options: BufferAuthorizationUrlOptions): string {
  const operation = "buffer.authorizationUrl";

  if (!options.clientId.trim() || !options.state.trim() || !options.codeChallenge.trim())
    throw new SocialError({
      code: "invalid_config",
      operation,
      message: "Pass the Buffer OAuth client ID, state, and PKCE code challenge.",
    });

  const url = new URL("/auth", authOrigin);

  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", originUrl(options.redirectUri, operation).href);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (options.scopes ?? bufferScopes).join(" "));
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "consent");

  return url.href;
}

/**
 * Exchange the authorization code for Buffer tokens. Refresh tokens are returned only
 * when `offline_access` was granted, and each refresh token is single-use.
 */
export async function exchangeBufferCode(
  options: BufferCodeExchangeOptions,
): Promise<BufferAccessToken> {
  const operation = "buffer.exchangeCode";

  if (!options.clientId.trim())
    throw new SocialError({
      code: "invalid_config",
      operation,
      message: "Configure the Buffer OAuth client ID.",
    });

  if (!options.code.trim() || !options.codeVerifier.trim())
    reject(
      operation,
      "Pass the authorization code and the PKCE verifier from the start of the flow.",
    );

  const body = new URLSearchParams({
    client_id: options.clientId,
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: originUrl(options.redirectUri, operation).href,
    code_verifier: options.codeVerifier,
  });

  if (options.clientSecret !== undefined) body.set("client_secret", options.clientSecret);

  return requestToken(body, options, operation);
}

/**
 * Exchange a Buffer refresh token for a new token pair. The refresh token you send is
 * invalidated; store the replacement and discard the old one.
 */
export async function refreshBufferToken(
  options: BufferRefreshOptions,
): Promise<BufferAccessToken> {
  const operation = "buffer.refreshToken";

  if (!options.clientId.trim())
    throw new SocialError({
      code: "invalid_config",
      operation,
      message: "Configure the Buffer OAuth client ID.",
    });

  if (!options.refreshToken.trim()) reject(operation, "Pass the current Buffer refresh token.");

  const body = new URLSearchParams({
    client_id: options.clientId,
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
  });

  if (options.clientSecret !== undefined) body.set("client_secret", options.clientSecret);

  return requestToken(body, options, operation);
}

function graphqlCode(error: JsonValue): string | undefined {
  if (!isJsonObject(error)) return undefined;
  const extensions = error["extensions"];

  return isJsonObject(extensions) ? optionalString(extensions["code"]) : undefined;
}

function transportError(
  error: HttpError,
  operation: string,
  context: AdapterOperationContext,
  kind: "query" | "mutation",
): SocialError {
  const ambiguous =
    kind === "mutation" &&
    error.dispatched &&
    (error.kind !== "http" || (error.status !== undefined && error.status >= 500));

  const code: SocialErrorCode =
    error.status === 429
      ? "rate_limited"
      : error.kind === "cancelled"
        ? "cancelled"
        : error.kind === "timeout"
          ? "timeout"
          : error.status === 401
            ? "reconnect_required"
            : error.status === 403
              ? "missing_permission"
              : error.status === 404
                ? "not_found"
                : ambiguous
                  ? "ambiguous_outcome"
                  : error.kind === "invalid-input"
                    ? "invalid_input"
                    : "upstream_failure";

  return new SocialError({
    code,
    operation,
    backend: context.backendInstance,
    correlationId: context.correlationId,
    message:
      code === "ambiguous_outcome"
        ? "Buffer did not confirm the mutation. Reconcile before retrying."
        : error.message,
    ...definedFields({
      upstreamStatus: error.status,
      retryDisposition:
        code === "ambiguous_outcome"
          ? { kind: "reconcile-first" }
          : error.status === 401
            ? { kind: "after-reconnect" }
            : error.status === 429 && error.retryAfterMs !== undefined
              ? { kind: "after-delay", delayMs: error.retryAfterMs }
              : { kind: "never" },
    }),
  });
}

function graphqlFailure(
  errors: readonly JsonValue[],
  operation: string,
  context: AdapterOperationContext,
  kind: "query" | "mutation",
): SocialError {
  const first = errors[0];
  const upstreamCode = first === undefined ? undefined : graphqlCode(first);

  const message =
    first !== undefined && isJsonObject(first)
      ? (optionalString(first["message"]) ?? "Buffer returned a GraphQL error.")
      : "Buffer returned a GraphQL error.";

  const code: SocialErrorCode =
    upstreamCode === "RATE_LIMIT_EXCEEDED"
      ? "rate_limited"
      : upstreamCode === "UNAUTHORIZED"
        ? "reconnect_required"
        : upstreamCode === "FORBIDDEN"
          ? "missing_permission"
          : upstreamCode === "NOT_FOUND"
            ? "not_found"
            : kind === "mutation" && upstreamCode === "UNEXPECTED"
              ? "ambiguous_outcome"
              : "upstream_failure";

  return new SocialError({
    code,
    operation,
    backend: context.backendInstance,
    correlationId: context.correlationId,
    message,
    ...definedFields({
      upstreamCode,
      retryDisposition:
        code === "ambiguous_outcome"
          ? { kind: "reconcile-first" }
          : code === "reconnect_required"
            ? { kind: "after-reconnect" }
            : { kind: "never" },
    }),
  });
}

/**
 * Buffer managed backend. Buffer is a GraphQL scheduling service: you authenticate with
 * a personal API key or an OAuth access token, list connected channels, and create posts
 * that Buffer later delivers. Media must already be a public HTTPS URL; Buffer has no
 * upload endpoint.
 */
export function buffer(options: BufferOptions) {
  if (!options.apiKey.trim())
    throw new SocialError({
      code: "invalid_config",
      operation: "createAdapter",
      message: "Configure the Buffer API key or OAuth access token.",
    });

  const organizationId =
    options.organizationId === undefined
      ? undefined
      : bufferId(options.organizationId, "createAdapter", "organization");

  const http = createHttp(options);
  const clock = () => options.clock?.() ?? new Date();
  const now = () => clock().toISOString();

  const graphql = async (
    operation: string,
    query: string,
    variables: JsonObject,
    context: AdapterOperationContext,
    kind: "query" | "mutation",
  ): Promise<JsonObject> => {
    let response: JsonValue;

    try {
      response = await http({
        url: new URL(apiOrigin),
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        timeoutMs: remainingBudget(context),
        method: "POST",
        body: JSON.stringify({ query, variables }),
        ...definedFields({ signal: context.signal }),
        maxAttempts: 1,
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      throw transportError(error, operation, context, kind);
    }

    const payload = object(response);
    const errors = payload["errors"];

    if (errors !== undefined) {
      const list = array(errors);

      if (list.length > 0) throw graphqlFailure(list, operation, context, kind);
    }

    const data = payload["data"];

    if (data === null || data === undefined) {
      if (kind === "mutation")
        throw new SocialError({
          code: "ambiguous_outcome",
          operation,
          backend: context.backendInstance,
          correlationId: context.correlationId,
          message: "Buffer did not confirm the mutation. Reconcile before retrying.",
          retryDisposition: { kind: "reconcile-first" },
        });

      throw new SocialError({
        code: "upstream_failure",
        operation,
        backend: context.backendInstance,
        correlationId: context.correlationId,
        message: "Buffer returned no GraphQL data.",
        retryDisposition: { kind: "never" },
      });
    }

    return object(data);
  };

  const organizations = async (context: AdapterOperationContext): Promise<string[]> => {
    if (organizationId) return [organizationId];

    const data = await graphql(
      "accounts.read",
      `
        query AccountOrganizations {
          account {
            organizations {
              id
            }
          }
        }
      `,
      {},
      context,
      "query",
    );

    return array(object(data["account"])["organizations"]).map((value) =>
      bufferId(string(object(value)["id"]), "accounts.read", "organization"),
    );
  };

  const account = (value: JsonValue, backend: string): AccountRecord | undefined => {
    const row = object(value);
    const slug = nativePlatforms.get(string(row["service"]));

    if (!slug) return undefined;
    const handle = optionalString(row["name"]);

    return {
      ref: {
        kind: "connected-account",
        version: 1,
        backend,
        platform: slug,
        accountId: string(row["id"]),
      },
      displayName: optionalString(row["displayName"]) || handle || string(row["id"]),
      ...definedFields({ handle: handle || undefined }),
      status: "connected",
    };
  };

  const channels = async (
    context: AdapterOperationContext,
  ): Promise<readonly { account: AccountRecord; organizationId: string }[]> => {
    const orgs = await organizations(context);
    const items: { account: AccountRecord; organizationId: string }[] = [];

    for (const org of orgs) {
      const data = await graphql(
        "accounts.read",
        `
          query Channels($input: ChannelsInput!) {
            channels(input: $input) {
              id
              name
              displayName
              service
              organizationId
            }
          }
        `,
        { input: { organizationId: org } },
        context,
        "query",
      );

      for (const value of array(data["channels"])) {
        const parsed = account(value, context.backendInstance);

        if (parsed)
          items.push({
            account: parsed,
            organizationId: optionalString(object(value)["organizationId"]) ?? org,
          });
      }
    }

    return items;
  };

  const ownedChannel = async (
    ref: Pick<ConnectedAccountRef, "backend" | "platform" | "accountId">,
    context: AdapterOperationContext,
    operation: string,
  ): Promise<{ account: AccountRecord; organizationId: string }> => {
    accountMatches(ref, context);

    const found = (await channels(context)).find(
      (item) =>
        item.account.ref.accountId === ref.accountId && item.account.ref.platform === ref.platform,
    );

    if (!found)
      throw new SocialError({
        code: "not_found",
        operation,
        message: "Buffer has no connected channel matching this reference.",
      });

    return found;
  };

  const postRow = (value: JsonField, operation: string): JsonObject => {
    if (value === null || value === undefined)
      throw new SocialError({
        code: "not_found",
        operation,
        message: "Buffer has no post with this identifier.",
      });

    const row = object(value);

    if (optionalString(row["id"])) return row;

    const message = optionalString(row["message"]);

    throw new SocialError({
      code: message ? "invalid_input" : "upstream_failure",
      operation,
      message: message ?? "Buffer returned an unreadable post payload.",
    });
  };

  const readPost = async (
    id: string,
    ref: Pick<ConnectedAccountRef, "backend" | "platform" | "accountId">,
    context: AdapterOperationContext,
    operation: string,
    includeMetrics = false,
  ): Promise<JsonObject> => {
    await ownedChannel(ref, context, operation);

    const postId = bufferId(id, operation, "post");

    const data = await graphql(
      operation,
      `query Post($input: PostInput!) {
        post(input: $input) {
          ${postSelection}
          ${includeMetrics ? metricsSelection : ""}
        }
      }`,
      { input: { id: postId } },
      context,
      "query",
    );

    const row = postRow(data["post"], operation);

    if (row["channelId"] !== ref.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation,
        message: "The Buffer post does not belong to the authorized channel.",
      });

    if (nativePlatforms.get(string(row["channelService"])) !== ref.platform)
      throw new SocialError({
        code: "unauthorized",
        operation,
        message: "The Buffer post does not belong to the authorized platform.",
      });

    return row;
  };

  const publicPost = (row: JsonObject): JsonObject => ({
    id: string(row["id"]),
    ...definedFields({
      text: optionalString(row["text"]),
      channelId: optionalString(row["channelId"]),
      status: optionalString(row["status"]),
      dueAt: optionalString(row["dueAt"]),
      sentAt: optionalString(row["sentAt"]),
      shareMode: optionalString(row["shareMode"]),
      url: optionalString(row["externalLink"]),
    }),
  });

  const outcome = (
    row: JsonObject,
    target: ConnectedAccountRef,
    targetIndex: number,
  ): DeliveryOutcome => {
    const id = string(row["id"]);
    const status = optionalString(row["status"]) ?? "unknown";

    const delivery: DeliveryRef = {
      kind: "delivery",
      version: 1,
      backend: target.backend,
      platform: target.platform,
      accountId: target.accountId,
      deliveryId: id,
    };

    const base = {
      targetIndex,
      account: target,
      delivery,
      backendState: status,
      observedAt: now(),
    };

    switch (status) {
      case "scheduled":
        return {
          ...base,
          state: "scheduled",
          job: {
            kind: "scheduled-job",
            version: 1,
            backend: target.backend,
            platform: target.platform,
            accountId: target.accountId,
            jobId: id,
          },
        };
      case "draft":
      case "needs_approval":
        return { ...base, state: "accepted" };
      case "sending":
        return { ...base, state: "processing" };
      case "sent": {
        const url = optionalString(row["externalLink"]);

        return {
          ...base,
          state: "published",
          post: {
            kind: "platform-post",
            version: 1,
            backend: target.backend,
            platform: target.platform,
            accountId: target.accountId,
            postId: id,
            native: { backendRecordId: id },
          },
          ...definedFields({ url }),
        };
      }

      case "error":
        return {
          ...base,
          state: "failed",
          code: "upstream_failure",
          message:
            "Buffer reports that this post failed. Inspect the channel connection and the post in Buffer.",
          retryDisposition: { kind: "never" },
        };
      default:
        return {
          ...base,
          state: "unknown",
          reason: "unmapped-state",
          diagnostic: "Buffer returned a post status this adapter does not map.",
        };
    }
  };

  const metricUnit = (value: JsonField): MetricValue["unit"] | undefined => {
    if (value === undefined || value === "count") return "count";

    if (value === "percentage" || value === "milliseconds" || value === "seconds") return value;

    return undefined;
  };

  const postMetrics = (row: JsonObject, platform: Platform): readonly MetricValue[] => {
    const values = row["metrics"];

    if (values === null || values === undefined) return [];

    return array(values).flatMap((entry) => {
      const metric = object(entry);
      const name = optionalString(metric["type"]) ?? optionalString(metric["name"]);
      const unit = metricUnit(metric["unit"]);
      const value = optionalNumber(metric["value"]);

      if (!name || unit === undefined || value === undefined || !Number.isFinite(value)) return [];

      return [
        {
          name,
          value,
          unit,
          period: "lifetime" as const,
          freshness: "unknown" as const,
          source: `buffer:${platform}:post`,
          ...definedFields({ fetchedAt: optionalString(row["metricsUpdatedAt"]) }),
        },
      ];
    });
  };

  const deleteOwned = async (
    id: string,
    context: AdapterOperationContext,
    operation: string,
  ): Promise<void> => {
    const data = await graphql(
      operation,
      `
        mutation DeletePost($input: DeletePostInput!) {
          deletePost(input: $input) {
            ... on DeletePostSuccess {
              id
            }
            ... on MutationError {
              message
            }
          }
        }
      `,
      { input: { id } },
      context,
      "mutation",
    );

    const result = object(data["deletePost"]);

    if (result["id"] === id) return;

    const message = optionalString(result["message"]);

    if (message)
      throw new SocialError({
        code: "invalid_input",
        operation,
        message,
      });

    throw new SocialError({
      code: "ambiguous_outcome",
      operation,
      backend: context.backendInstance,
      correlationId: context.correlationId,
      message: "Buffer did not confirm the deletion. Reconcile before retrying.",
      retryDisposition: { kind: "reconcile-first" },
    });
  };

  const adapter = defineAdapter({
    id: "buffer",
    capabilities: capabilityManifest("buffer", "GraphQL api.buffer.com, docs read 2026-10-09", [
      "accounts.read",
      "posts.publish",
      "posts.read",
      "posts.list",
      "posts.status",
      "posts.cancelScheduled",
      "posts.deleteBackendRecord",
      "analytics.read",
    ]),
    accounts: {
      async list(input: { cursor?: string; limit?: number }, context: AdapterOperationContext) {
        const offset = input.cursor === undefined ? 0 : Number(input.cursor);
        const limit = input.limit ?? 25;

        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          reject("accounts.read", "Use an opaque returned cursor and a page size from 1 to 100.");

        const all = (await channels(context)).map((item) => item.account);
        const next = offset + limit < all.length ? String(offset + limit) : undefined;

        return {
          items: all.slice(offset, offset + limit),
          ...definedFields({ nextCursor: next }),
        };
      },
      async get(ref: ConnectedAccountRef, context: AdapterOperationContext) {
        return (await ownedChannel(ref, context, "accounts.read")).account;
      },
    },
    posts: {
      prepareTarget(target: Parameters<typeof managedPreparation>[0]) {
        const issues: PreparationIssue[] = [
          ...managedPreparation(target, "buffer"),
          ...managedOptionIssues(target, "buffer"),
        ];

        const fail = (code: string, message: string) =>
          issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

        const at = target.schedule?.at;
        const config = optionsObject(target);

        if (at !== undefined && !(Date.parse(at) > clock().getTime()))
          fail("schedule.past", "Buffer custom schedules require a time in the future.");

        if (
          target.account.platform === "youtube" &&
          (!isString(config["categoryId"]) || config["categoryId"].length === 0)
        )
          fail("youtube.category", "Select a YouTube category explicitly.");

        if (target.account.platform === "instagram" && !isBoolean(config["shareToFeed"]))
          fail(
            "instagram.share_to_feed",
            "Select whether Instagram should share the post to feed.",
          );

        for (const item of target.content.media ?? []) {
          if (item.kind === "document") {
            fail(
              "media.document_unsupported",
              "This adapter maps Buffer image and video assets only. Document assets need a title and thumbnail the SDK does not collect.",
            );
            continue;
          }

          if (item.source.kind !== "https-url")
            fail(
              "media.url_required",
              "Buffer has no upload endpoint. Host the file yourself and pass a public HTTPS URL.",
            );
        }

        return issues;
      },
      async publishTarget(
        target: Parameters<typeof managedPreparation>[0],
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        accountMatches(target.account, context);

        try {
          await ownedChannel(target.account, context, "posts.publish");
        } catch (error) {
          if (error instanceof SocialError && error.code === "cancelled")
            return {
              state: "cancelled",
              targetIndex: target.targetIndex,
              account: target.account,
              observedAt: now(),
              reason: "before-submission",
            };

          if (error instanceof SocialError && error.code === "timeout")
            return {
              state: "not-submitted",
              targetIndex: target.targetIndex,
              account: target.account,
              observedAt: now(),
              reason: "before-submission",
            };

          throw error;
        }

        const at = target.schedule?.at;
        const scheduled = at !== undefined;

        if (scheduled && !(Date.parse(at) > clock().getTime()))
          reject("posts.publish", "Buffer custom schedules require a time in the future.");

        const assets: JsonObject[] = [];

        for (const item of target.content.media ?? []) {
          const source = item.source;

          if (source.kind !== "https-url" || item.kind === "document")
            reject(
              "posts.publish",
              "Buffer accepts public HTTPS image and video URLs only through this adapter.",
            );
          else
            assets.push(
              item.kind === "video"
                ? { video: { url: httpsUrl(source.url).href } }
                : {
                    image: {
                      url: httpsUrl(source.url).href,
                      ...definedFields({
                        metadata: item.altText ? { altText: item.altText } : undefined,
                      }),
                    },
                  },
            );
        }

        const config = optionsObject(target);
        const metadataEntries: [string, JsonValue][] = [];

        if (target.account.platform === "youtube") {
          const title = config["title"];
          const categoryId = config["categoryId"];
          const visibility = optionalString(config["visibility"]);

          if (!isString(title) || title.length === 0)
            return reject("posts.publish", "Select a YouTube title explicitly.");

          if (visibility !== "public" && visibility !== "unlisted" && visibility !== "private")
            return reject(
              "posts.publish",
              "Select public, unlisted, or private YouTube visibility.",
            );

          if (!isString(categoryId) || categoryId.length === 0)
            return reject("posts.publish", "Select a YouTube category explicitly.");

          metadataEntries.push([
            "youtube",
            {
              title,
              categoryId,
              privacy: visibility,
              ...definedFields({
                madeForKids: isBoolean(config["madeForKids"]) ? config["madeForKids"] : undefined,
              }),
            },
          ]);
        }

        if (target.account.platform === "instagram") {
          const shareToFeed = config["shareToFeed"];

          if (!isBoolean(shareToFeed))
            return reject("posts.publish", "Instagram shareToFeed must be selected explicitly.");

          metadataEntries.push([
            "instagram",
            {
              shouldShareToFeed: shareToFeed,
              type: "post",
            },
          ]);
        }

        if (target.account.platform === "tiktok" && config["aiGenerated"] !== undefined) {
          if (!isBoolean(config["aiGenerated"]))
            reject("posts.publish", "TikTok aiGenerated must be a boolean.");

          metadataEntries.push(["tiktok", { isAiGenerated: config["aiGenerated"] }]);
        }

        const metadata = Object.fromEntries(metadataEntries);

        const input: JsonObject = {
          text: target.content.text ?? "",
          channelId: target.account.accountId,
          schedulingType: "automatic",
          mode: scheduled ? "customScheduled" : "shareNow",
          needsApproval: false,
          assets,
          ...definedFields({
            dueAt: scheduled ? new Date(string(at)).toISOString() : undefined,
            metadata: metadataEntries.length ? metadata : undefined,
          }),
        };

        const data = await graphql(
          "posts.publish",
          `mutation CreatePost($input: CreatePostInput!) {
            createPost(input: $input) {
              ... on PostActionSuccess {
                post {
                  ${postSelection}
                }
              }
              ... on MutationError {
                message
              }
            }
          }`,
          { input },
          context,
          "mutation",
        );

        const result = object(data["createPost"]);

        if (isJsonObject(result["post"]))
          return outcome(object(result["post"]), target.account, target.targetIndex);

        const message = optionalString(result["message"]);

        if (message)
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.publish",
            message,
          });

        throw new SocialError({
          code: "ambiguous_outcome",
          operation: "posts.publish",
          backend: context.backendInstance,
          correlationId: context.correlationId,
          message: "Buffer did not confirm post creation. Reconcile before retrying.",
          retryDisposition: { kind: "reconcile-first" },
        });
      },
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        const owned = await ownedChannel(account, context, "posts.list");
        const limit = input.limit ?? 20;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          reject("posts.list", "Use a page size from 1 to 100.");

        if (input.cursor !== undefined && (!input.cursor || /[\s@]/.test(input.cursor)))
          reject("posts.list", "Use the cursor Buffer returned from the previous page.");

        const data = await graphql(
          "posts.list",
          `query Posts($first: Int, $after: String, $input: PostsInput!) {
            posts(first: $first, after: $after, input: $input) {
              edges {
                cursor
                node {
                  ${postSelection}
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }`,
          {
            first: limit,
            input: {
              organizationId: owned.organizationId,
              filter: { channelIds: [account.accountId] },
            },
            ...definedFields({ after: input.cursor }),
          },
          context,
          "query",
        );

        const connection = object(data["posts"]);
        const pageInfo = connection["pageInfo"] ? object(connection["pageInfo"]) : {};

        const items = array(connection["edges"]).flatMap((edge) => {
          const row = object(edge);
          const node = row["node"];

          if (node === undefined) return [];

          const parsed = object(node);

          if (parsed["channelId"] !== account.accountId) return [];

          return [publicPost(parsed)];
        });

        return {
          items,
          ...definedFields({
            nextCursor:
              pageInfo["hasNextPage"] === true ? optionalString(pageInfo["endCursor"]) : undefined,
          }),
        };
      },
      async get(ref: PlatformPostRef, context: AdapterOperationContext) {
        return publicPost(await readPost(ref.postId, ref, context, "posts.read"));
      },
      async getDelivery(ref: DeliveryRef, context: AdapterOperationContext) {
        return outcome(
          await readPost(ref.deliveryId, ref, context, "posts.status"),
          {
            kind: "connected-account",
            version: 1,
            backend: ref.backend,
            platform: ref.platform,
            accountId: ref.accountId,
          },
          0,
        );
      },
      async cancelScheduled(
        ref: ScheduledJobRef,
        context: AdapterOperationContext,
      ): Promise<ScheduleCancellation> {
        const row = await readPost(ref.jobId, ref, context, "posts.cancelScheduled");
        const dueAt = optionalString(row["dueAt"]);

        if (
          row["status"] !== "scheduled" ||
          !dueAt ||
          !Number.isFinite(Date.parse(dueAt)) ||
          Date.parse(dueAt) <= clock().getTime()
        )
          reject(
            "posts.cancelScheduled",
            "Only a future scheduled Buffer post can be cancelled. Reconcile a due or dispatched post.",
          );

        await deleteOwned(string(row["id"]), context, "posts.cancelScheduled");

        return { state: "cancelled", backendRecord: "deleted" };
      },
      async deleteBackendRecord(ref: BackendPostRef, context: AdapterOperationContext) {
        const row = await readPost(ref.recordId, ref, context, "posts.deleteBackendRecord");
        const status = optionalString(row["status"]);

        if (status !== "draft" && status !== "error" && status !== "needs_approval")
          reject(
            "posts.deleteBackendRecord",
            "Only a Buffer draft, approval, or failed record can be deleted this way. Cancel a future schedule or reconcile a dispatched post.",
          );

        await deleteOwned(string(row["id"]), context, "posts.deleteBackendRecord");
      },
    },
    analytics: {
      async getPostMetrics(ref: PlatformPostRef, context: AdapterOperationContext) {
        const row = await readPost(ref.postId, ref, context, "analytics.read", true);

        if (row["status"] !== "sent")
          throw new SocialError({
            code: "not_found",
            operation: "analytics.read",
            message: "Buffer reports metrics only after a post is sent.",
          });

        return postMetrics(row, ref.platform);
      },
    },
  });

  return adapter;
}
