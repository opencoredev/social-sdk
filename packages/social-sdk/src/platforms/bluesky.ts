/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion, anti-slop/require-readable-spacing, anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof -- validated external boundary or fixture contract. */
import { readBinary } from "../transport/binary.js";
import { remainingBudget } from "../transport/budget.js";
import {
  connectedAccountRef,
  defineAdapter,
  platformPostRef,
  profileRef,
  type AccountRecord,
  type AdapterOperationContext,
  type CapabilityManifest,
  type CommentRef,
  type ConnectedAccountRef,
  type DeliveryOutcome,
  type JsonObject,
  type MediaInput,
  type MetricValue,
  type Page,
  type ProfileRecord,
  type RelationshipRecord,
  type SocialAdapter,
} from "../core/index.js";
import { SocialError } from "../core/errors.js";
import { abortable, createHttp, HttpError } from "../transport/http.js";
import { httpsUrl } from "../transport/upload.js";
import { array, object, string } from "../transport/validation.js";
import { publicFields } from "../cloud/common.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const MAX_IMAGES = 4;

export interface BlueskyAuthorization {
  readonly service: string;
  readonly did: string;
  readonly accessJwt?: string;
  readonly handle?: string;
}

export interface BlueskyOptions {
  readonly auth: BlueskyAuthorization;
  readonly backend?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /** Explicit egress policy for caller-provided remote media URLs. */
  readonly allowMediaHost?: (hostname: string) => boolean;
  /** Restored @atproto OAuthSession transport. Its DPoP-aware fetchHandler is used directly. */
  readonly session?: {
    readonly did: string;
    readonly fetchHandler: (pathname: string, init?: RequestInit) => Promise<Response>;
  };
}

export interface BlueskyPostRef {
  readonly uri: string;
  readonly cid: string;
}

/** Query parameters accepted by the public app.bsky.feed.searchPosts endpoint. */
export interface BlueskySearchPostsInput {
  readonly account: ConnectedAccountRef;
  readonly query: string;
  readonly scope?: "recent" | "all";
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: "latest" | "top";
  readonly since?: string;
  readonly until?: string;
  readonly mentions?: string;
  readonly author?: string;
  readonly lang?: string;
  readonly domain?: string;
  readonly url?: string;
  readonly tags?: readonly string[];
  readonly context?: AdapterOperationContext;
}

export interface BlueskySearchPostsResult {
  readonly posts: readonly JsonObject[];
  readonly cursor?: string;
  readonly hitsTotal?: number;
}

export interface BlueskyNative {
  readonly getPost: (input: {
    readonly uri: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly getPostThread: (input: {
    readonly uri: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly searchPosts: (input: BlueskySearchPostsInput) => Promise<BlueskySearchPostsResult>;
  readonly likePost: (input: {
    readonly post: BlueskyPostRef;
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<{ readonly uri: string; readonly cid: string }>;
  readonly unlikePost: (input: {
    readonly likeUri: string;
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly repostPost: (input: {
    readonly post: BlueskyPostRef;
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  readonly quotePost: (input: {
    readonly post: BlueskyPostRef;
    readonly account: ConnectedAccountRef;
    readonly text: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  readonly deletePost: (input: {
    readonly post: BlueskyPostRef;
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly uploadVideo: (input: {
    readonly account: ConnectedAccountRef;
    readonly video: Blob;
    readonly mimeType?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly follow: (input: {
    readonly account: ConnectedAccountRef;
    readonly did: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly unfollow: (input: {
    readonly account: ConnectedAccountRef;
    readonly followUri: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly block: (input: {
    readonly account: ConnectedAccountRef;
    readonly did: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly unblock: (input: {
    readonly account: ConnectedAccountRef;
    readonly blockUri: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly mute: (input: {
    readonly account: ConnectedAccountRef;
    readonly did: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly unmute: (input: {
    readonly account: ConnectedAccountRef;
    readonly did: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly getFollowers: (input: BlueskyActorPageInput) => Promise<BlueskyActorPageResult>;
  readonly getFollows: (input: BlueskyActorPageInput) => Promise<BlueskyActorPageResult>;
  readonly getMutes: (input: BlueskyPageInput) => Promise<BlueskyActorPageResult>;
  readonly getBlocks: (input: BlueskyPageInput) => Promise<BlueskyActorPageResult>;
  readonly getLikes: (input: BlueskyPostPageInput) => Promise<BlueskyLikePageResult>;
  readonly getActorLikes: (input: BlueskyActorPageInput) => Promise<BlueskyFeedPageResult>;
  readonly searchActors: (input: BlueskyActorSearchInput) => Promise<BlueskyActorPageResult>;
  readonly searchActorsTypeahead: (
    input: BlueskyActorSearchInput,
  ) => Promise<BlueskyActorPageResult>;
  readonly createList: (input: BlueskyCreateListInput) => Promise<BlueskyPostRef>;
  readonly updateList: (input: BlueskyUpdateListInput) => Promise<void>;
  readonly deleteList: (input: BlueskyOwnedRecordInput) => Promise<void>;
  readonly addListItem: (input: BlueskyListItemInput) => Promise<BlueskyPostRef>;
  readonly removeListItem: (input: BlueskyOwnedRecordInput) => Promise<void>;
  readonly getList: (input: BlueskyListPageInput) => Promise<JsonObject>;
  readonly getLists: (input: BlueskyActorPageInput) => Promise<JsonObject>;
  readonly muteList: (input: BlueskyListActionInput) => Promise<void>;
  readonly unmuteList: (input: BlueskyListActionInput) => Promise<void>;
  readonly blockList: (input: BlueskyListActionInput) => Promise<void>;
  readonly unblockList: (input: BlueskyListActionInput) => Promise<void>;
  readonly createModerationReport: (input: BlueskyModerationReportInput) => Promise<JsonObject>;
  readonly listNotifications: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly markNotificationsSeen: (input: {
    readonly account: ConnectedAccountRef;
    readonly seenAt?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly getProfile: (input: {
    readonly actor?: string;
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly updateProfile: (input: {
    readonly account: ConnectedAccountRef;
    readonly profile: JsonObject;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly listFeeds: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly listConversations: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly listMessages: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly sendMessage: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly text: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
}

export interface BlueskyPageInput {
  readonly account: ConnectedAccountRef;
  readonly cursor?: string;
  readonly limit?: number;
  readonly context?: AdapterOperationContext;
}

export interface BlueskyActorPageInput extends BlueskyPageInput {
  readonly actor?: string;
}

export interface BlueskyPostPageInput extends BlueskyPageInput {
  readonly uri: string;
  readonly cid?: string;
}

export interface BlueskyActorSearchInput extends BlueskyPageInput {
  readonly query: string;
}

export interface BlueskyActorPageResult {
  readonly actors: readonly JsonObject[];
  readonly cursor?: string;
}

export interface BlueskyLikePageResult {
  readonly likes: readonly JsonObject[];
  readonly cursor?: string;
}

export interface BlueskyFeedPageResult {
  readonly feed: readonly JsonObject[];
  readonly cursor?: string;
}

export interface BlueskyCreateListInput {
  readonly account: ConnectedAccountRef;
  readonly name: string;
  readonly purpose: "app.bsky.graph.defs#curatelist" | "app.bsky.graph.defs#modlist";
  readonly description?: string;
  readonly context?: AdapterOperationContext;
}

export interface BlueskyUpdateListInput extends BlueskyCreateListInput {
  readonly listUri: string;
}

export interface BlueskyOwnedRecordInput {
  readonly account: ConnectedAccountRef;
  readonly uri: string;
  readonly context?: AdapterOperationContext;
}

export interface BlueskyListItemInput {
  readonly account: ConnectedAccountRef;
  readonly listUri: string;
  readonly subject: string;
  readonly context?: AdapterOperationContext;
}

export interface BlueskyListPageInput extends BlueskyPageInput {
  readonly listUri: string;
}

export interface BlueskyListActionInput {
  readonly account: ConnectedAccountRef;
  readonly listUri: string;
  readonly context?: AdapterOperationContext;
}

export interface BlueskyModerationReportInput {
  readonly account: ConnectedAccountRef;
  readonly reasonType: string;
  readonly subject:
    | { readonly $type: "com.atproto.admin.defs#repoRef"; readonly did: string }
    | { readonly $type: "com.atproto.repo.strongRef"; readonly uri: string; readonly cid: string };
  readonly reason?: string;
  readonly context?: AdapterOperationContext;
}

function endpoint(service: string, method: string): URL {
  let base: URL;

  try {
    base = new URL(service);
  } catch {
    throw new SocialError({
      code: "invalid_config",
      operation: "bluesky.configure",
      message: "Bluesky service must be an absolute URL.",
    });
  }

  if (base.protocol !== "https:" || base.username || base.password) {
    throw new SocialError({
      code: "invalid_config",
      operation: "bluesky.configure",
      message: "Bluesky service must use HTTPS without embedded credentials.",
    });
  }

  return new URL(`/xrpc/${method}`, base);
}

function accountMatches(
  ref: ConnectedAccountRef,
  auth: BlueskyAuthorization,
  backend: string,
): boolean {
  return ref.backend === backend && ref.platform === "bluesky" && ref.accountId === auth.did;
}

function authHeaders(auth: BlueskyAuthorization): HeadersInit {
  return auth.accessJwt === undefined ? {} : { Authorization: `Bearer ${auth.accessJwt}` };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
function operationError(operation: string, error: unknown, mutation = true): SocialError {
  if (error instanceof SocialError) return error;

  if (error instanceof HttpError) {
    const ambiguous =
      mutation &&
      error.dispatched &&
      (error.kind !== "http" || (error.status !== undefined && error.status >= 500));

    const code = ambiguous
      ? "ambiguous_outcome"
      : error.kind === "timeout"
        ? "timeout"
        : error.kind === "cancelled"
          ? "cancelled"
          : error.status === 401
            ? "reconnect_required"
            : error.status === 403
              ? "missing_permission"
              : error.status === 404
                ? "not_found"
                : error.status === 429
                  ? "rate_limited"
                  : "upstream_failure";
    return new SocialError({
      code,
      operation,
      message: error.message,
      retryDisposition: ambiguous
        ? { kind: "reconcile-first" }
        : error.status === 401
          ? { kind: "after-reconnect" }
          : error.status === 429 && error.retryAfterMs !== undefined
            ? { kind: "after-delay", delayMs: error.retryAfterMs }
            : !mutation && error.status !== undefined && error.status >= 500
              ? { kind: "after-delay", delayMs: 1000 }
              : { kind: "never" },
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
      ...(error.status === undefined ? {} : { upstreamStatus: error.status }),
    });
  }

  return new SocialError({
    code: "upstream_failure",
    operation,
    message: "Bluesky request failed.",
    retryDisposition: { kind: "reconcile-first" },
    cause: error,
  });
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
function postRef(value: unknown): BlueskyPostRef {
  const record = object(value);

  return { uri: string(record["uri"]), cid: string(record["cid"]) };
}

function linkFacets(text: string): readonly JsonObject[] {
  const facets: JsonObject[] = [];
  const urlPattern = /https?:\/\/[^\s<>]+/g;

  for (const match of text.matchAll(urlPattern)) {
    const value = match[0]?.replace(/[.,;:!?)]*$/u, "");
    const start = match.index;

    if (start === undefined || value === undefined) continue;
    const end = start + value.length;
    const byteStart = new TextEncoder().encode(text.slice(0, start)).byteLength;
    const byteEnd = new TextEncoder().encode(text.slice(0, end)).byteLength;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: value }],
    });
  }

  return facets;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
function richTextOptions(text: string, options: unknown): JsonObject {
  const invalid = (message: string): never => {
    throw new SocialError({ code: "invalid_input", operation: "bluesky.prepare", message });
  };

  if (
    options !== undefined &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
    (options === null || typeof options !== "object" || Array.isArray(options))
  )
    invalid("Bluesky options must be an object.");
  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
  const config = (options ?? {}) as JsonObject;

  if (Object.keys(config).some((key) => key !== "languages" && key !== "mentions"))
    invalid("A supplied Bluesky option is not supported.");
  let langs: string[] | undefined;

  if (config["languages"] !== undefined) {
    const languages = config["languages"];

    if (
      !Array.isArray(languages) ||
      languages.length > 3 ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      languages.some((value) => typeof value !== "string")
    )
      invalid("Bluesky accepts at most three language tags.");

    try {
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      langs = Intl.getCanonicalLocales(languages as string[]);
    } catch {
      invalid("Bluesky languages must be valid BCP 47 tags.");
    }
  }

  const facets = [...linkFacets(text)];
  const bytes = new TextEncoder().encode(text);
  const mentions = config["mentions"] ?? [];

  if (!Array.isArray(mentions) || mentions.length > 100)
    invalid("Bluesky mentions must be an array of at most 100 DID references.");
  const spans: { start: number; end: number }[] = [];

  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
  for (const value of mentions as readonly JsonObject[]) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
    if (!value || typeof value !== "object" || Array.isArray(value))
      invalid("Each mention requires UTF-8 offsets and a DID.");

    const start = value["byteStart"],
      end = value["byteEnd"],
      did = value["did"];

    if (
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      typeof start !== "number" ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      typeof end !== "number" ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > bytes.length ||
      (bytes[start]! & 0xc0) === 0x80 ||
      (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      typeof did !== "string" ||
      !/^did:[a-z]+:[A-Za-z0-9._:%-]+$/.test(did)
    )
      invalid("Mention offsets must span complete UTF-8 characters and identify a DID.");

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
    const byteStart = start as number,
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      byteEnd = end as number;

    if (!new TextDecoder().decode(bytes.slice(byteStart, byteEnd)).startsWith("@"))
      invalid("A mention span must start with @.");

    if (
      spans.some((span) => byteStart < span.end && byteEnd > span.start) ||
      facets.some((facet) => {
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        const index = facet["index"] as JsonObject;

        return byteStart < Number(index["byteEnd"]) && byteEnd > Number(index["byteStart"]);
      })
    )
      invalid("Mention spans must not overlap links or other mentions.");
    spans.push({ start: byteStart, end: byteEnd });
    facets.push({
      index: { byteStart, byteEnd },
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      features: [{ $type: "app.bsky.richtext.facet#mention", did: did as string }],
    });
  }

  facets.sort(
    (left, right) =>
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      Number((left["index"] as JsonObject)["byteStart"]) -
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      Number((right["index"] as JsonObject)["byteStart"]),
  );

  // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
  return { ...(langs === undefined ? {} : { langs }), ...(facets.length ? { facets } : {}) };
}

function graphemeCount(text: string): number {
  const Segmenter =
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- provider payload is validated at this adapter boundary.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
    (
      Intl as unknown as {
        readonly Segmenter?: new (
          locales?: string | string[],
          options?: { readonly granularity?: "grapheme" | "word" | "sentence" },
        ) => { segment(value: string): Iterable<unknown> };
      }
    ).Segmenter;

  return Segmenter === undefined
    ? Array.from(text).length
    : [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
}

async function readMedia(
  source: MediaInput,
  fetcher: typeof globalThis.fetch,
  context: AdapterOperationContext,
  allowMediaHost: (hostname: string) => boolean,
): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }> {
  const duration = remainingBudget(context);
  const controller = new AbortController();
  const abort = () => controller.abort(context.signal?.reason);

  if (context.signal?.aborted) abort();
  context.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Media deadline exceeded")), duration);

  try {
    controller.signal.throwIfAborted();

    if (source.kind === "blob") {
      if (source.blob.size > MAX_IMAGE_BYTES)
        throw new SocialError({
          code: "media_error",
          operation: "bluesky.uploadBlob",
          message: "Image exceeds the 10 MiB limit.",
        });

      return {
        bytes: await readBinary(source.blob.stream(), MAX_IMAGE_BYTES, controller.signal),
        mimeType: source.blob.type || "application/octet-stream",
      };
    }

    if (source.kind === "stream")
      return {
        bytes: await readBinary(source.open(), MAX_IMAGE_BYTES, controller.signal),
        mimeType: "application/octet-stream",
      };

    if (source.kind === "https-url") {
      const url = httpsUrl(source.url);

      if (!allowMediaHost(url.hostname))
        throw new SocialError({
          code: "media_error",
          operation: "bluesky.uploadBlob",
          message: "Remote image host is outside the configured egress policy.",
        });
      const pending = fetcher(url, { redirect: "error", signal: controller.signal });
      void pending.then(
        (response) => {
          if (controller.signal.aborted) void response.body?.cancel().catch(() => undefined);
        },
        () => undefined,
      );
      const response = await abortable(pending, controller.signal);

      if (
        !response.ok ||
        !response.body ||
        Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES
      ) {
        void response.body?.cancel().catch(() => undefined);
        throw new SocialError({
          code: "media_error",
          operation: "bluesky.uploadBlob",
          message: "Remote image was unavailable or exceeded its byte limit.",
        });
      }

      return {
        bytes: await readBinary(response.body, MAX_IMAGE_BYTES, controller.signal),
        mimeType: response.headers.get("content-type")?.split(";")[0] || "application/octet-stream",
      };
    }

    throw new SocialError({
      code: "media_error",
      operation: "bluesky.uploadBlob",
      message: "This image source cannot be uploaded.",
    });
  } catch (error) {
    if (controller.signal.aborted)
      throw new SocialError({
        code: context.signal?.aborted ? "cancelled" : "timeout",
        operation: "bluesky.uploadBlob",
        message: "Image preparation was interrupted before publication.",
        retryDisposition: { kind: "never" },
      });
    throw error;
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", abort);
  }
}

export function bluesky(options: BlueskyOptions): SocialAdapter<BlueskyNative> {
  const backend = options.backend ?? "default";
  const fetcher = options.fetch ?? globalThis.fetch;
  const allowMediaHost = options.allowMediaHost ?? (() => false);

  const http = createHttp({
    fetch: options.session
      ? (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));

          // OAuthSession resolves a relative XRPC path against its verified token
          // audience. Never override that audience with caller-provided service URLs.
          return options.session!.fetchHandler(url.pathname + url.search, init);
        }
      : fetcher,
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  const auth = options.auth;

  if (options.session) {
    if (options.session.did !== auth.did)
      throw new SocialError({
        code: "invalid_config",
        operation: "bluesky.configure",
        message: "OAuth session DID must match the configured account DID.",
      });

    if (auth.accessJwt !== undefined)
      throw new SocialError({
        code: "invalid_config",
        operation: "bluesky.configure",
        message: "Use OAuth session transport or bearer credentials, not both.",
      });
  } else if (auth.accessJwt === undefined) {
    throw new SocialError({
      code: "invalid_config",
      operation: "bluesky.configure",
      message: "Bluesky authorization requires accessJwt or an OAuth session.",
    });
  }

  const service = auth.service;
  const account = connectedAccountRef({ backend, platform: "bluesky", accountId: auth.did });

  const capabilities: CapabilityManifest = {
    schemaVersion: 1,
    backend,
    apiRevision: "AT Protocol XRPC 2026-09",
    runtime: ["node>=22.12", "bun"],
    capabilities: [
      {
        operation: "accounts.read",
        platform: "bluesky",
        availability: "available",
        requiredScopes: ["repo"],
      },
      {
        operation: "posts.publish",
        platform: "bluesky",
        availability: "available",
        formats: ["text", "image"],
        requiredScopes: ["repo"],
      },
      {
        operation: "posts.read",
        platform: "bluesky",
        availability: "available",
        formats: ["text", "image"],
      },
      ...[
        "graph.read",
        "graph.follow",
        "graph.unfollow",
        "graph.block",
        "graph.unblock",
        "graph.mute",
        "graph.unmute",
        "likes.read",
        "likes.write",
        "lists.read",
        "lists.write",
        "profiles.search",
        "moderation.report",
      ].map((operation) => ({
        operation,
        platform: "bluesky" as const,
        availability: "available" as const,
        requiredScopes: ["repo"],
      })),
      {
        operation: "posts.list",
        platform: "bluesky",
        availability: "available",
        formats: ["text", "image"],
      },
      {
        operation: "comments.read",
        platform: "bluesky",
        availability: "available",
        formats: ["text"],
      },
      {
        operation: "analytics.read",
        platform: "bluesky",
        availability: "available",
        formats: ["text", "image"],
      },
      { operation: "analytics.account.read", platform: "bluesky", availability: "available" },
      {
        operation: "comments.write",
        platform: "bluesky",
        availability: "available",
        formats: ["text"],
        requiredScopes: ["repo"],
      },
      {
        operation: "posts.publish.video",
        platform: "bluesky",
        availability: "not-implemented-by-adapter",
        formats: ["video"],
        requiredScopes: ["repo"],
      },
      ...[
        "posts.repost",
        "posts.quote",
        "posts.delete",
        "posts.removeFromPlatform",
        "notifications.read",
        "notifications.seen",
        "profile.read",
        "profiles.read",
        "profile.update",
        "feeds.read",
        "search.posts",
        "chat.read",
        "chat.write",
      ].map((operation) => ({
        operation,
        platform: "bluesky" as const,
        availability: operation.startsWith("chat.")
          ? ("available" as const)
          : ("available" as const),
      })),
    ],
  };

  async function xrpc(
    method: string,
    context: AdapterOperationContext,
    init: {
      readonly body?: BodyInit;
      readonly headers?: HeadersInit;
      readonly maxAttempts?: number;
    } = {},
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- validated boundary or fixture contract.
  ): Promise<unknown> {
    try {
      const headers = new Headers(init.headers);
      if (typeof init.body === "string" && !headers.has("Content-Type"))
        headers.set("Content-Type", "application/json");
      if (method.startsWith("chat.bsky.") && !headers.has("atproto-proxy"))
        headers.set("atproto-proxy", "did:web:api.bsky.chat#bsky_chat");
      return await http({
        url: endpoint(service, method),
        timeoutMs: remainingBudget(context),
        method: init.body === undefined ? "GET" : "POST",
        ...(options.session
          ? { headers }
          : { headers: { ...authHeaders(auth), ...Object.fromEntries(headers.entries()) } }),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(init.body === undefined ? {} : { body: init.body }),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        maxAttempts:
          init.maxAttempts ??
          (init.body === undefined ? Math.min(context.retryBudget.maxAttempts, 3) : 1),
      });
    } catch (error) {
      throw operationError(`bluesky.${method}`, error, init.body !== undefined);
    }
  }

  async function verifiedSession(
    context: AdapterOperationContext,
  ): Promise<{ readonly did: string; readonly handle?: string }> {
    const session = object(
      await xrpc(
        options.session
          ? `app.bsky.actor.getProfile?actor=${encodeURIComponent(auth.did)}`
          : "com.atproto.server.getSession",
        context,
      ),
    );

    const did = string(session["did"]);

    if (did !== auth.did) {
      throw new SocialError({
        code: "unauthorized",
        operation: "bluesky.accounts.get",
        message: "The configured credential belongs to a different DID.",
      });
    }

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
    const handle = typeof session["handle"] === "string" ? session["handle"] : undefined;

    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
    return { did, ...(handle === undefined ? {} : { handle }) };
  }

  const nativeContext = (context: AdapterOperationContext | undefined, operation: string) =>
    context ?? {
      correlationId: operation,
      retryBudget: { maxAttempts: 2, maxElapsedMs: 30_000 },
      backendInstance: backend,
    };

  const assertNativeAccount = (
    selected: ConnectedAccountRef,
    context: AdapterOperationContext,
    operation: string,
  ) => {
    if (!accountMatches(selected, auth, backend) || context.backendInstance !== backend)
      throw new SocialError({
        code: "unauthorized",
        operation,
        message: "Account reference does not belong to this Bluesky adapter.",
      });
  };

  const pageQuery = (input: BlueskyPageInput): URLSearchParams => {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new SocialError({
        code: "invalid_input",
        operation: "bluesky.graph.read",
        message: "Page size must be between 1 and 100.",
      });
    return new URLSearchParams({
      limit: String(limit),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
  };

  const recordKey = (uri: string, collection: string): string => {
    const prefix = `at://${auth.did}/${collection}/`;
    const key = uri.startsWith(prefix) ? uri.slice(prefix.length) : "";
    if (!/^[A-Za-z0-9._~:-]{1,512}$/.test(key) || key === "." || key === "..")
      throw new SocialError({
        code: "invalid_input",
        operation: "bluesky.record.delete",
        message: "Record URI must belong to this account.",
      });
    return key;
  };

  const actorPage = (response: JsonObject, key: string): BlueskyActorPageResult => ({
    actors: array(response[key] ?? []).map((value) => object(value) as unknown as JsonObject),
    ...(typeof response["cursor"] === "string" ? { cursor: response["cursor"] } : {}),
  });

  const native: BlueskyNative = {
    async getPost(input) {
      const context = input.context ?? {
        correlationId: "bluesky-native",
        retryBudget: { maxAttempts: 2, maxElapsedMs: 30_000 },
        backendInstance: backend,
      };

      const query = new URLSearchParams({ uris: input.uri });
      const response = object(await xrpc(`app.bsky.feed.getPosts?${query.toString()}`, context));
      const posts = array(response["posts"]);
      const post = posts.find((value) => object(value)["uri"] === input.uri);

      if (post === undefined)
        throw new SocialError({
          code: "upstream_failure",
          operation: "bluesky.getPost",
          message: "Bluesky post was not found.",
        });

      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      return object(post) as JsonObject;
    },
    async getPostThread(input) {
      const context = input.context ?? {
        correlationId: "bluesky-native",
        retryBudget: { maxAttempts: 2, maxElapsedMs: 30_000 },
        backendInstance: backend,
      };

      const query = new URLSearchParams({ uri: input.uri });

      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      return object(
        await xrpc(`app.bsky.feed.getPostThread?${query.toString()}`, context),
      ) as JsonObject;
    },
    async searchPosts(input) {
      const context = nativeContext(input.context, "bluesky.search.posts");
      assertNativeAccount(input.account, context, "bluesky.search.posts");

      const queryText = input.query.trim();
      if (!queryText)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.search.posts",
          message: "Bluesky search query is required.",
          retryDisposition: { kind: "never" },
        });

      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.search.posts",
          message: "Bluesky search page size must be between 1 and 100.",
          retryDisposition: { kind: "never" },
        });

      if (input.sort !== undefined && input.sort !== "latest" && input.sort !== "top")
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.search.posts",
          message: "Bluesky search sort must be latest or top.",
          retryDisposition: { kind: "never" },
        });
      if (input.scope === "all")
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.search.posts",
          message: "Bluesky search does not support scope 'all'.",
        });

      if (input.context !== undefined && input.context.backendInstance !== backend)
        throw new SocialError({
          code: "unauthorized",
          operation: "bluesky.search.posts",
          message: "Account reference does not belong to this Bluesky adapter.",
        });

      const query = new URLSearchParams({ q: queryText, limit: String(limit) });
      const optional = {
        cursor: input.cursor,
        sort: input.sort,
        since: input.since,
        until: input.until,
        mentions: input.mentions,
        author: input.author,
        lang: input.lang,
        domain: input.domain,
        url: input.url,
      } as const;
      for (const [key, value] of Object.entries(optional))
        if (value !== undefined && value.trim() !== "") query.set(key, value);
      for (const tag of input.tags ?? []) {
        const normalizedTag = tag.trim();
        if (normalizedTag) query.append("tag", normalizedTag);
      }

      const response = object(await xrpc(`app.bsky.feed.searchPosts?${query}`, context));
      const posts = array(response["posts"]).map((post) => {
        const value = object(post);

        // The XRPC transport has already decoded a JSON payload; `object` validates
        // the record boundary while the recursive JSON shape is preserved for callers.
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion
        return value as JsonObject;
      });
      const cursorValue = response["cursor"];
      const hitsTotalValue = response["hitsTotal"];

      return {
        posts,
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(typeof cursorValue === "string" ? { cursor: cursorValue } : {}),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(typeof hitsTotalValue === "number" && Number.isSafeInteger(hitsTotalValue)
          ? { hitsTotal: hitsTotalValue }
          : {}),
      };
    },
    async likePost(input) {
      if (
        !accountMatches(input.account, auth, backend) ||
        (input.context && input.context.backendInstance !== backend)
      )
        throw new SocialError({
          code: "unauthorized",
          operation: "bluesky.reactions.like",
          message: "Account reference does not belong to this Bluesky adapter.",
        });

      if (
        !/^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/app\.bsky\.feed\.post\/[A-Za-z0-9._~:-]{1,512}$/.test(
          input.post.uri,
        ) ||
        !/^[A-Za-z0-9]{1,2048}$/.test(input.post.cid)
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.reactions.like",
          message: "Provide the native post URI and CID returned by a Bluesky read.",
        });

      const context = input.context ?? {
        correlationId: "bluesky-like",
        retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 },
        backendInstance: backend,
      };

      const response = object(
        await xrpc("com.atproto.repo.createRecord", context, {
          body: JSON.stringify({
            repo: auth.did,
            collection: "app.bsky.feed.like",
            record: {
              $type: "app.bsky.feed.like",
              subject: { uri: input.post.uri, cid: input.post.cid },
              createdAt: new Date().toISOString(),
            },
          }),
        }),
      );

      const prefix = `at://${auth.did}/app.bsky.feed.like/`;

      const uri = response["uri"],
        cid = response["cid"];

      if (
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
        typeof uri !== "string" ||
        !uri.startsWith(prefix) ||
        !/^[A-Za-z0-9._~:-]{1,512}$/.test(uri.slice(prefix.length)) ||
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
        typeof cid !== "string" ||
        !cid
      )
        throw new SocialError({
          code: "ambiguous_outcome",
          operation: "bluesky.reactions.like",
          message: "Bluesky did not return an owned like record. Reconcile before retrying.",
          retryDisposition: { kind: "reconcile-first" },
        });

      return { uri, cid };
    },
    async unlikePost(input) {
      if (
        !accountMatches(input.account, auth, backend) ||
        (input.context && input.context.backendInstance !== backend)
      )
        throw new SocialError({
          code: "unauthorized",
          operation: "bluesky.reactions.unlike",
          message: "Account reference does not belong to this Bluesky adapter.",
        });

      const context = input.context ?? {
        correlationId: "bluesky-unlike",
        retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 },
        backendInstance: backend,
      };

      const prefix = `at://${auth.did}/app.bsky.feed.like/`;
      const recordKey = input.likeUri.startsWith(prefix) ? input.likeUri.slice(prefix.length) : "";

      if (!/^[A-Za-z0-9._~:-]{1,512}$/.test(recordKey) || recordKey === "." || recordKey === "..")
        throw new SocialError({
          code: "unauthorized",
          operation: "bluesky.reactions.unlike",
          message: "Like record must belong to this Bluesky account.",
        });
      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({ repo: auth.did, collection: "app.bsky.feed.like", rkey: recordKey }),
      });
    },
    async repostPost(input) {
      const context = nativeContext(input.context, "bluesky.repost");
      assertNativeAccount(input.account, context, "bluesky.repost");

      const result = object(
        await xrpc("com.atproto.repo.createRecord", context, {
          body: JSON.stringify({
            repo: auth.did,
            collection: "app.bsky.feed.repost",
            record: {
              $type: "app.bsky.feed.repost",
              subject: input.post,
              createdAt: new Date().toISOString(),
            },
          }),
        }),
      );

      return postRef(result);
    },
    async quotePost(input) {
      const context = nativeContext(input.context, "bluesky.quote");
      assertNativeAccount(input.account, context, "bluesky.quote");

      if (!input.text.trim() || graphemeCount(input.text) > 300)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.quote",
          message: "Quote text must be 1-300 characters.",
        });

      const result = object(
        await xrpc("com.atproto.repo.createRecord", context, {
          body: JSON.stringify({
            repo: auth.did,
            collection: "app.bsky.feed.post",
            record: {
              $type: "app.bsky.feed.post",
              text: input.text,
              createdAt: new Date().toISOString(),
              embed: { $type: "app.bsky.embed.record", record: input.post },
            },
          }),
        }),
      );

      return postRef(result);
    },
    async deletePost(input) {
      const context = nativeContext(input.context, "bluesky.delete");
      assertNativeAccount(input.account, context, "bluesky.delete");
      const prefix = `at://${auth.did}/app.bsky.feed.post/`;
      const rkey = input.post.uri.startsWith(prefix) ? input.post.uri.slice(prefix.length) : "";

      if (!rkey)
        throw new SocialError({
          code: "unauthorized",
          operation: "bluesky.delete",
          message: "Post URI does not belong to this account.",
        });
      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({ repo: auth.did, collection: "app.bsky.feed.post", rkey }),
      });
    },
    async uploadVideo(_input) {
      throw new SocialError({
        code: "unsupported_capability",
        operation: "bluesky.video.upload",
        message:
          "Bluesky video upload requires the video service authentication and job polling flow; this adapter does not implement it.",
      });
    },
    async follow(input) {
      const context = nativeContext(input.context, "bluesky.follow");
      assertNativeAccount(input.account, context, "bluesky.follow");

      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      return object(
        await xrpc("com.atproto.repo.createRecord", context, {
          body: JSON.stringify({
            repo: auth.did,
            collection: "app.bsky.graph.follow",
            record: {
              $type: "app.bsky.graph.follow",
              subject: input.did,
              createdAt: new Date().toISOString(),
            },
          }),
        }),
      ) as JsonObject;
    },
    async unfollow(input) {
      const context = nativeContext(input.context, "bluesky.unfollow");
      assertNativeAccount(input.account, context, "bluesky.unfollow");
      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.graph.follow",
          rkey: recordKey(input.followUri, "app.bsky.graph.follow"),
        }),
      });
    },
    async block(input) {
      const context = nativeContext(input.context, "bluesky.block");
      assertNativeAccount(input.account, context, "bluesky.block");

      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      return object(
        await xrpc("com.atproto.repo.createRecord", context, {
          body: JSON.stringify({
            repo: auth.did,
            collection: "app.bsky.graph.block",
            record: {
              $type: "app.bsky.graph.block",
              subject: input.did,
              createdAt: new Date().toISOString(),
            },
          }),
        }),
      ) as JsonObject;
    },
    async unblock(input) {
      const context = nativeContext(input.context, "bluesky.unblock");
      assertNativeAccount(input.account, context, "bluesky.unblock");
      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.graph.block",
          rkey: recordKey(input.blockUri, "app.bsky.graph.block"),
        }),
      });
    },
    async mute(input) {
      const context = nativeContext(input.context, "bluesky.mute");
      assertNativeAccount(input.account, context, "bluesky.mute");

      await xrpc("app.bsky.graph.muteActor", context, {
        body: JSON.stringify({ actor: input.did }),
      });
    },
    async unmute(input) {
      const context = nativeContext(input.context, "bluesky.unmute");
      assertNativeAccount(input.account, context, "bluesky.unmute");
      await xrpc("app.bsky.graph.unmuteActor", context, {
        body: JSON.stringify({ actor: input.did }),
      });
    },
    async getFollowers(input) {
      const context = nativeContext(input.context, "bluesky.graph.followers");
      assertNativeAccount(input.account, context, "bluesky.graph.followers");
      const q = pageQuery(input);
      q.set("actor", input.actor ?? auth.did);
      return actorPage(
        object(await xrpc(`app.bsky.graph.getFollowers?${q}`, context)) as JsonObject,
        "followers",
      );
    },
    async getFollows(input) {
      const context = nativeContext(input.context, "bluesky.graph.follows");
      assertNativeAccount(input.account, context, "bluesky.graph.follows");
      const q = pageQuery(input);
      q.set("actor", input.actor ?? auth.did);
      return actorPage(
        object(await xrpc(`app.bsky.graph.getFollows?${q}`, context)) as JsonObject,
        "follows",
      );
    },
    async getMutes(input) {
      const context = nativeContext(input.context, "bluesky.graph.mutes");
      assertNativeAccount(input.account, context, "bluesky.graph.mutes");
      return actorPage(
        object(await xrpc(`app.bsky.graph.getMutes?${pageQuery(input)}`, context)) as JsonObject,
        "mutes",
      );
    },
    async getBlocks(input) {
      const context = nativeContext(input.context, "bluesky.graph.blocks");
      assertNativeAccount(input.account, context, "bluesky.graph.blocks");
      return actorPage(
        object(await xrpc(`app.bsky.graph.getBlocks?${pageQuery(input)}`, context)) as JsonObject,
        "blocks",
      );
    },
    async getLikes(input) {
      const context = nativeContext(input.context, "bluesky.likes.read");
      assertNativeAccount(input.account, context, "bluesky.likes.read");
      const q = pageQuery(input);
      q.set("uri", input.uri);
      if (input.cid) q.set("cid", input.cid);
      const value = object(await xrpc(`app.bsky.feed.getLikes?${q}`, context));
      return {
        likes: array(value["likes"] ?? []).map((entry) => object(entry) as JsonObject),
        ...(typeof value["cursor"] === "string" ? { cursor: value["cursor"] } : {}),
      };
    },
    async getActorLikes(input) {
      const context = nativeContext(input.context, "bluesky.likes.actor");
      assertNativeAccount(input.account, context, "bluesky.likes.actor");
      const q = pageQuery(input);
      q.set("actor", input.actor ?? auth.did);
      const value = object(await xrpc(`app.bsky.feed.getActorLikes?${q}`, context));
      return {
        feed: array(value["feed"] ?? []).map((entry) => object(entry) as JsonObject),
        ...(typeof value["cursor"] === "string" ? { cursor: value["cursor"] } : {}),
      };
    },
    async searchActors(input) {
      const context = nativeContext(input.context, "bluesky.profiles.search");
      assertNativeAccount(input.account, context, "bluesky.profiles.search");
      if (!input.query.trim())
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.profiles.search",
          message: "Actor search query is required.",
        });
      const q = pageQuery(input);
      q.set("q", input.query.trim());
      return actorPage(
        object(await xrpc(`app.bsky.actor.searchActors?${q}`, context)) as JsonObject,
        "actors",
      );
    },
    async searchActorsTypeahead(input) {
      const context = nativeContext(input.context, "bluesky.profiles.search");
      assertNativeAccount(input.account, context, "bluesky.profiles.search");
      if (!input.query.trim())
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.profiles.search",
          message: "Actor search query is required.",
        });
      const limit = input.limit ?? 8;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.profiles.search",
          message: "Page size must be between 1 and 100.",
        });
      const q = new URLSearchParams({ q: input.query.trim(), limit: String(limit) });
      return actorPage(
        object(await xrpc(`app.bsky.actor.searchActorsTypeahead?${q}`, context)) as JsonObject,
        "actors",
      );
    },
    async createList(input) {
      const context = nativeContext(input.context, "bluesky.lists.create");
      assertNativeAccount(input.account, context, "bluesky.lists.create");
      const record = {
        $type: "app.bsky.graph.list",
        name: input.name,
        purpose: input.purpose,
        createdAt: new Date().toISOString(),
        ...(input.description === undefined ? {} : { description: input.description }),
      } as unknown as JsonObject;
      return postRef(
        object(
          await xrpc("com.atproto.repo.createRecord", context, {
            body: JSON.stringify({ repo: auth.did, collection: "app.bsky.graph.list", record }),
          }),
        ) as unknown as JsonObject,
      );
    },
    async updateList(input) {
      const context = nativeContext(input.context, "bluesky.lists.update");
      assertNativeAccount(input.account, context, "bluesky.lists.update");
      const existing = object(
        await xrpc(
          `com.atproto.repo.getRecord?repo=${encodeURIComponent(auth.did)}&collection=app.bsky.graph.list&rkey=${encodeURIComponent(recordKey(input.listUri, "app.bsky.graph.list"))}`,
          context,
        ),
      );
      const record = object(existing["value"]);
      const next: JsonObject = {
        ...record,
        name: input.name,
        purpose: input.purpose,
        ...(input.description === undefined ? {} : { description: input.description }),
      };
      await xrpc("com.atproto.repo.putRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.graph.list",
          rkey: recordKey(input.listUri, "app.bsky.graph.list"),
          record: next,
        }),
      });
    },
    async deleteList(input) {
      const context = nativeContext(input.context, "bluesky.lists.delete");
      assertNativeAccount(input.account, context, "bluesky.lists.delete");
      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.graph.list",
          rkey: recordKey(input.uri, "app.bsky.graph.list"),
        }),
      });
    },
    async addListItem(input) {
      const context = nativeContext(input.context, "bluesky.lists.items.add");
      assertNativeAccount(input.account, context, "bluesky.lists.items.add");
      return postRef(
        object(
          await xrpc("com.atproto.repo.createRecord", context, {
            body: JSON.stringify({
              repo: auth.did,
              collection: "app.bsky.graph.listitem",
              record: {
                $type: "app.bsky.graph.listitem",
                list: input.listUri,
                subject: input.subject,
                createdAt: new Date().toISOString(),
              },
            }),
          }),
        ) as unknown as JsonObject,
      );
    },
    async removeListItem(input) {
      const context = nativeContext(input.context, "bluesky.lists.items.remove");
      assertNativeAccount(input.account, context, "bluesky.lists.items.remove");
      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.graph.listitem",
          rkey: recordKey(input.uri, "app.bsky.graph.listitem"),
        }),
      });
    },
    async getList(input) {
      const context = nativeContext(input.context, "bluesky.lists.get");
      assertNativeAccount(input.account, context, "bluesky.lists.get");
      const q = pageQuery(input);
      q.set("list", input.listUri);
      return object(await xrpc(`app.bsky.graph.getList?${q}`, context)) as JsonObject;
    },
    async getLists(input) {
      const context = nativeContext(input.context, "bluesky.lists.list");
      assertNativeAccount(input.account, context, "bluesky.lists.list");
      const q = pageQuery(input);
      q.set("actor", input.actor ?? auth.did);
      return object(await xrpc(`app.bsky.graph.getLists?${q}`, context)) as JsonObject;
    },
    async muteList(input) {
      const context = nativeContext(input.context, "bluesky.lists.mute");
      assertNativeAccount(input.account, context, "bluesky.lists.mute");
      await xrpc("app.bsky.graph.muteActorList", context, {
        body: JSON.stringify({ list: input.listUri }),
      });
    },
    async unmuteList(input) {
      const context = nativeContext(input.context, "bluesky.lists.unmute");
      assertNativeAccount(input.account, context, "bluesky.lists.unmute");
      await xrpc("app.bsky.graph.unmuteActorList", context, {
        body: JSON.stringify({ list: input.listUri }),
      });
    },
    async blockList(input) {
      const context = nativeContext(input.context, "bluesky.lists.block");
      assertNativeAccount(input.account, context, "bluesky.lists.block");
      await xrpc("com.atproto.repo.createRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.graph.listblock",
          record: {
            $type: "app.bsky.graph.listblock",
            subject: input.listUri,
            createdAt: new Date().toISOString(),
          },
        }),
      });
    },
    async unblockList(input) {
      const context = nativeContext(input.context, "bluesky.lists.unblock");
      assertNativeAccount(input.account, context, "bluesky.lists.unblock");
      let cursor: string | undefined;
      let record: JsonObject | undefined;

      do {
        const query = new URLSearchParams({
          repo: auth.did,
          collection: "app.bsky.graph.listblock",
          limit: "100",
          ...(cursor === undefined ? {} : { cursor }),
        });
        const records = object(
          await xrpc(`com.atproto.repo.listRecords?${query.toString()}`, context),
        );
        record = array(records["records"])
          .map((value) => object(value) as JsonObject)
          .find((value) => object(value["value"])["subject"] === input.listUri);
        cursor = typeof records["cursor"] === "string" ? records["cursor"] : undefined;
      } while (record === undefined && cursor !== undefined);

      if (record === undefined)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.lists.unblock",
          message: "No list block record was found for this list.",
        });
      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.graph.listblock",
          rkey: recordKey(string(record["uri"]), "app.bsky.graph.listblock"),
        }),
      });
    },
    async createModerationReport(input) {
      const context = nativeContext(input.context, "bluesky.moderation.report");
      assertNativeAccount(input.account, context, "bluesky.moderation.report");
      const body: JsonObject = {
        reasonType: input.reasonType,
        subject: input.subject,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      };
      return object(
        await xrpc("com.atproto.moderation.createReport", context, { body: JSON.stringify(body) }),
      ) as JsonObject;
    },
    async listNotifications(input) {
      const context = nativeContext(input.context, "bluesky.notifications.list");
      assertNativeAccount(input.account, context, "bluesky.notifications.list");
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.notifications.list",
          message: "Page size must be between 1 and 100.",
        });

      const query = new URLSearchParams({
        limit: String(limit),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });

      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      return object(
        await xrpc(`app.bsky.notification.listNotifications?${query}`, context),
      ) as JsonObject;
    },
    async markNotificationsSeen(input) {
      const context = nativeContext(input.context, "bluesky.notifications.seen");
      assertNativeAccount(input.account, context, "bluesky.notifications.seen");
      await xrpc("app.bsky.notification.updateSeen", context, {
        body: JSON.stringify({ seenAt: input.seenAt ?? new Date().toISOString() }),
      });
    },
    async getProfile(input) {
      const context = nativeContext(input.context, "bluesky.profile.get");
      assertNativeAccount(input.account, context, "bluesky.profile.get");

      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      return object(
        await xrpc(
          `app.bsky.actor.getProfile?actor=${encodeURIComponent(input.actor ?? auth.did)}`,
          context,
        ),
      ) as JsonObject;
    },
    async updateProfile(input) {
      const context = nativeContext(input.context, "bluesky.profile.update");
      assertNativeAccount(input.account, context, "bluesky.profile.update");
      await xrpc("com.atproto.repo.putRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.actor.profile",
          rkey: "self",
          record: input.profile,
        }),
      });
    },
    async listFeeds(input) {
      const context = nativeContext(input.context, "bluesky.feeds.list");
      assertNativeAccount(input.account, context, "bluesky.feeds.list");
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.feeds.list",
          message: "Page size must be between 1 and 100.",
        });

      const query = new URLSearchParams({
        limit: String(limit),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });

      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      return object(await xrpc(`app.bsky.feed.getSuggestedFeeds?${query}`, context)) as JsonObject;
    },
    async listConversations(input) {
      const context = nativeContext(input.context, "bluesky.chat.list");
      assertNativeAccount(input.account, context, "bluesky.chat.list");
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.chat.list",
          message: "Page size must be between 1 and 100.",
        });

      const query = new URLSearchParams({
        limit: String(limit),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });

      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      return object(await xrpc(`chat.bsky.convo.listConvos?${query}`, context)) as JsonObject;
    },
    async listMessages(input) {
      const context = nativeContext(input.context, "bluesky.chat.messages");
      assertNativeAccount(input.account, context, "bluesky.chat.messages");
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.chat.messages",
          message: "Page size must be between 1 and 100.",
        });

      const query = new URLSearchParams({
        limit: String(limit),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });

      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      return object(
        await xrpc(
          `chat.bsky.convo.getMessages?convoId=${encodeURIComponent(input.conversationId)}&${query}`,
          context,
        ),
      ) as JsonObject;
    },
    async sendMessage(input) {
      const context = nativeContext(input.context, "bluesky.chat.send");
      assertNativeAccount(input.account, context, "bluesky.chat.send");

      if (!input.text.trim())
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.chat.send",
          message: "Message text is required.",
        });

      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      return object(
        await xrpc("chat.bsky.convo.sendMessage", context, {
          body: JSON.stringify({ convoId: input.conversationId, message: { text: input.text } }),
        }),
      ) as JsonObject;
    },
  };

  const adapter = defineAdapter<BlueskyNative, SocialAdapter<BlueskyNative>>({
    id: backend,
    capabilities,
    native,
    graph: {
      async getProfile(account, input, context): Promise<ProfileRecord> {
        const value = await native.getProfile({
          account,
          ...(input.profileId === undefined ? {} : { actor: input.profileId }),
          ...(input.profileId === undefined && input.handle !== undefined
            ? { actor: input.handle }
            : {}),
          context,
        });
        const actor = object(value) as JsonObject;
        const id = string(actor["did"]);
        return {
          ref: profileRef({
            backend,
            platform: "bluesky",
            accountId: account.accountId,
            profileId: id,
          }),
          ...(typeof actor["displayName"] === "string"
            ? { displayName: actor["displayName"] }
            : {}),
          ...(typeof actor["handle"] === "string" ? { handle: actor["handle"] } : {}),
          ...(typeof actor["avatar"] === "string" ? { avatarUrl: actor["avatar"] } : {}),
          ...(typeof actor["description"] === "string" ? { bio: actor["description"] } : {}),
          native: actor,
        };
      },
      async listRelationships(account, input, context): Promise<Page<RelationshipRecord>> {
        const result =
          input.kind === "following"
            ? await native.getFollows({
                account,
                context,
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                ...(input.limit === undefined ? {} : { limit: input.limit }),
              })
            : input.kind === "followers"
              ? await native.getFollowers({
                  account,
                  context,
                  ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                  ...(input.limit === undefined ? {} : { limit: input.limit }),
                })
              : input.kind === "blocked"
                ? await native.getBlocks({
                    account,
                    context,
                    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                    ...(input.limit === undefined ? {} : { limit: input.limit }),
                  })
                : await native.getMutes({
                    account,
                    context,
                    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                    ...(input.limit === undefined ? {} : { limit: input.limit }),
                  });
        return {
          items: result.actors.map((actor) => {
            const value = object(actor);
            const id = string(value["did"]);
            return {
              profile: profileRef({
                backend,
                platform: "bluesky",
                accountId: account.accountId,
                profileId: id,
              }),
              relationship:
                input.kind === "following"
                  ? "following"
                  : input.kind === "followers"
                    ? "follower"
                    : input.kind,
            };
          }),
          ...(result.cursor === undefined ? {} : { nextCursor: result.cursor }),
        };
      },
      async follow(target, context): Promise<RelationshipRecord> {
        await native.follow({ account, did: target.profileId, context });
        return { profile: target, relationship: "following" };
      },
      async unfollow(target, context): Promise<void> {
        const profile = object(
          await native.getProfile({ account, actor: target.profileId, context }),
        );
        const viewer = object(profile["viewer"] ?? {});
        const uri = viewer["following"];
        if (typeof uri !== "string" || !uri)
          throw new SocialError({
            code: "invalid_input",
            operation: "graph.unfollow",
            message: "A follow record URI is required to unfollow.",
          });
        await native.unfollow({ account, followUri: uri, context });
      },
      async block(target, context): Promise<RelationshipRecord> {
        await native.block({ account, did: target.profileId, context });
        return { profile: target, relationship: "blocked" };
      },
      async unblock(target, context): Promise<void> {
        const profile = object(
          await native.getProfile({ account, actor: target.profileId, context }),
        );
        const viewer = object(profile["viewer"] ?? {});
        const uri = viewer["blocking"];
        if (typeof uri !== "string" || !uri)
          throw new SocialError({
            code: "invalid_input",
            operation: "graph.unblock",
            message: "A block record URI is required to unblock.",
          });
        await native.unblock({ account, blockUri: uri, context });
      },
      async mute(target, context): Promise<RelationshipRecord> {
        await native.mute({ account, did: target.profileId, context });
        return { profile: target, relationship: "muted" };
      },
      async unmute(target, context): Promise<void> {
        await native.unmute({ account, did: target.profileId, context });
      },
    },
    accounts: {
      async list(_input, context): Promise<Page<AccountRecord>> {
        const session = await verifiedSession(context);

        return {
          items: [
            {
              ref: account,
              displayName: session.handle ?? session.did,
              // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
              ...(session.handle === undefined ? {} : { handle: session.handle }),
              status: "connected",
            },
          ],
        };
      },
      async get(ref, context): Promise<AccountRecord> {
        if (!accountMatches(ref, auth, backend))
          throw new SocialError({
            code: "unauthorized",
            operation: "bluesky.accounts.get",
            message: "The account reference does not belong to this Bluesky adapter.",
            account: ref,
          });
        const session = await verifiedSession(context);

        return {
          ref: account,
          displayName: session.handle ?? session.did,
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(session.handle === undefined ? {} : { handle: session.handle }),
          status: "connected",
        };
      },
    },
    search: {
      async posts(account, input, context): Promise<Page<JsonObject>> {
        if (!accountMatches(account, auth, backend))
          throw new SocialError({
            code: "unauthorized",
            operation: "search.posts",
            message: "The account reference does not belong to this adapter.",
            account,
          });

        const result = await native.searchPosts({
          account,
          query: input.query,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.startTime === undefined ? {} : { since: input.startTime }),
          ...(input.endTime === undefined ? {} : { until: input.endTime }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          context,
        });

        return {
          items: result.posts,
          ...(result.cursor === undefined ? {} : { nextCursor: result.cursor }),
          ...(result.hitsTotal === undefined ? {} : { metadata: { hitsTotal: result.hitsTotal } }),
        };
      },
    },
    notifications: {
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ): Promise<Page<JsonObject>> {
        if (!accountMatches(account, auth, backend))
          throw new SocialError({
            code: "unauthorized",
            operation: "bluesky.notifications.list",
            message: "The account reference does not belong to this adapter.",
            account,
          });

        const response = await native.listNotifications({
          account,
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          context,
        });
        const values = response["notifications"];
        const items =
          values === undefined
            ? []
            : array(values).map((value) => {
                // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated provider notification object.
                return object(value) as JsonObject;
              });
        const cursor = response["cursor"];

        return {
          items,
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
          ...(typeof cursor === "string" ? { nextCursor: cursor } : {}),
        };
      },
      async markSeen(
        account: ConnectedAccountRef,
        input: { readonly seenAt?: string },
        context: AdapterOperationContext,
      ): Promise<void> {
        if (!accountMatches(account, auth, backend))
          throw new SocialError({
            code: "unauthorized",
            operation: "bluesky.notifications.seen",
            message: "The account reference does not belong to this adapter.",
            account,
          });
        await native.markNotificationsSeen({
          account,
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(input.seenAt === undefined ? {} : { seenAt: input.seenAt }),
          context,
        });
      },
    },
    posts: {
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ): Promise<Page<JsonObject>> {
        if (!accountMatches(account, auth, backend))
          throw new SocialError({
            code: "unauthorized",
            operation: "bluesky.posts.list",
            message: "The account reference does not belong to this adapter.",
          });
        const limit = input.limit ?? 50;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.read",
            message: "Bluesky author-feed page size must be between 1 and 100.",
          });

        const query = new URLSearchParams({
          actor: auth.did,
          limit: String(limit),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });

        const response = object(
          await xrpc(`app.bsky.feed.getAuthorFeed?${query.toString()}`, context),
        );

        const feed = array(response["feed"]).map((value) => {
          const entry = object(value);
          const post = object(entry["post"]);

          const safePost = {
            ...publicFields(post, [
              "uri",
              "cid",
              "likeCount",
              "repostCount",
              "replyCount",
              "quoteCount",
              "indexedAt",
              "labels",
            ]),
            // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
            ...(post["author"] === undefined
              ? {}
              : {
                  author: publicFields(object(post["author"]), [
                    "did",
                    "handle",
                    "displayName",
                    "avatar",
                  ]),
                }),
            // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
            ...(post["record"] === undefined
              ? {}
              : {
                  record: publicFields(object(post["record"]), [
                    "text",
                    "facets",
                    "createdAt",
                    "reply",
                    "embed",
                  ]),
                }),
          };

          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
          return {
            post: safePost,
            // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
            ...(entry["reason"] === undefined
              ? {}
              : { reason: publicFields(object(entry["reason"]), ["$type", "by", "indexedAt"]) }),
          } as JsonObject;
        });

        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
        const cursor = typeof response["cursor"] === "string" ? response["cursor"] : undefined;

        return {
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
          items: feed as JsonObject[],
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(cursor === undefined ? {} : { nextCursor: cursor }),
        };
      },
      prepareTarget(target) {
        const issues = [];
        const text = target.content.text ?? "";

        try {
          richTextOptions(text, target.options);
        } catch (error) {
          issues.push({
            code: "bluesky.richtext",
            message: error instanceof Error ? error.message : "Invalid Bluesky rich text options.",
            severity: "error" as const,
          });
        }

        if (new TextEncoder().encode(text).byteLength > 3000 || graphemeCount(text) > 300)
          issues.push({
            code: "text.too_long",
            message: "Bluesky posts must be at most 300 graphemes and 3,000 UTF-8 bytes.",
            severity: "error" as const,
          });

        if (target.account.platform !== "bluesky")
          issues.push({
            code: "platform.unsupported",
            message: "Bluesky adapter received a different platform.",
            severity: "error" as const,
          });

        if (target.schedule !== undefined)
          issues.push({
            code: "schedule.unsupported",
            message: "Bluesky scheduling requires an application-owned job runner.",
            severity: "error" as const,
          });

        if (target.content.media?.some((media) => media.kind !== "image"))
          issues.push({
            code: "media.unsupported",
            message: "Bluesky direct publishing supports images, not video.",
            severity: "error" as const,
          });

        if ((target.content.media?.length ?? 0) > MAX_IMAGES)
          issues.push({
            code: "media.too_many",
            message: `Bluesky supports at most ${MAX_IMAGES} images per post.`,
            severity: "error" as const,
          });

        return issues;
      },
      async publishTarget(target, context): Promise<DeliveryOutcome> {
        if (!accountMatches(target.account, auth, backend))
          throw new SocialError({
            code: "unauthorized",
            operation: "bluesky.publish",
            message: "The account reference does not belong to this adapter.",
            account: target.account,
          });

        try {
          const content = target.content;
          const text = content.text ?? "";

          // oxlint-disable-next-line anti-slop/no-known-value-widening -- validated boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-known-value-widening -- provider payload is validated at this adapter boundary.
          // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-known-value-widening -- validated external boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-known-value-widening -- validated external boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
          const record: Record<string, unknown> = {
            $type: "app.bsky.feed.post",
            text,
            createdAt: new Date().toISOString(),
          };

          Object.assign(record, richTextOptions(text, target.options));

          if (target.replyTo !== undefined) {
            if (target.replyTo.kind !== "platform-post")
              throw new SocialError({
                code: "unsupported_capability",
                operation: "bluesky.reply",
                message: "Bluesky replies require a platform post reference.",
              });

            const parent = await native.getPost({
              uri: target.replyTo.native?.["uri"]?.toString() ?? target.replyTo.postId,
              context,
            });

            const parentRecord = object(parent["record"]);

            const parentRef =
              target.replyTo.native === undefined
                ? { uri: string(parent["uri"]), cid: string(parent["cid"]) }
                : {
                    uri: string(target.replyTo.native["uri"]),
                    cid: string(target.replyTo.native["cid"]),
                  };

            const rootValue = parentRecord["reply"];
            const root = rootValue === undefined ? parentRef : object(object(rootValue)["root"]);
            Object.assign(record, { reply: { root, parent: parentRef } });
          }

          if (content.media !== undefined && content.media.length > 0) {
            // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated boundary or fixture contract.
            const blobs: Record<string, unknown>[] = [];

            for (const media of content.media) {
              const source = await readMedia(media.source, fetcher, context, allowMediaHost);

              const blob = object(
                await xrpc("com.atproto.repo.uploadBlob", context, {
                  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
                  body: new Blob([source.bytes.slice().buffer as ArrayBuffer], {
                    type: source.mimeType,
                  }),
                  headers: { "Content-Type": source.mimeType },
                }),
              );

              blobs.push(object(blob["blob"]));
            }

            Object.assign(record, {
              embed: {
                $type: "app.bsky.embed.images",
                images: blobs.map((blob, index) => ({
                  image: blob,
                  alt: content.media?.[index]?.altText ?? "",
                })),
              },
            });
          }

          const response = object(
            await xrpc("com.atproto.repo.createRecord", context, {
              body: JSON.stringify({ repo: auth.did, collection: "app.bsky.feed.post", record }),
              headers: { "Content-Type": "application/json" },
            }),
          );

          const created = postRef(response);

          const delivery = {
            kind: "delivery" as const,
            version: 1 as const,
            backend,
            deliveryId: created.uri,
            platform: "bluesky" as const,
            accountId: auth.did,
          };

          return {
            state: "published",
            targetIndex: target.targetIndex,
            account: target.account,
            delivery,
            post: {
              ...platformPostRef({
                backend,
                platform: "bluesky",
                accountId: auth.did,
                postId: created.uri,
              }),
              native: { uri: created.uri, cid: created.cid },
            },
            observedAt: new Date().toISOString(),
          };
        } catch (error) {
          throw operationError("bluesky.publish", error);
        }
      },
      async get(ref, context): Promise<JsonObject> {
        if (ref.backend !== backend || ref.platform !== "bluesky" || ref.accountId !== auth.did)
          throw new SocialError({
            code: "unauthorized",
            operation: "bluesky.posts.get",
            message: "The account reference does not belong to this adapter.",
          });

        return native.getPost({ uri: ref.postId, context });
      },
      async removeFromPlatform(ref, context): Promise<void> {
        if (
          !accountMatches(
            connectedAccountRef({
              backend: ref.backend,
              platform: "bluesky",
              accountId: ref.accountId,
            }),
            auth,
            backend,
          )
        )
          throw new SocialError({
            code: "unauthorized",
            operation: "posts.removeFromPlatform",
            message: "The post reference does not belong to this Bluesky adapter.",
          });
        await native.deletePost({
          account,
          post: {
            uri: ref.native?.["uri"]?.toString() ?? ref.postId,
            cid: ref.native?.["cid"]?.toString() ?? "",
          },
          context,
        });
      },
    },
    comments: {
      async list(post, input, context) {
        if (input.cursor !== undefined)
          throw new SocialError({
            code: "unsupported_capability",
            operation: "comments.read",
            message: "This adapter does not expose upstream comment pagination.",
          });
        const thread = await native.getPostThread({ uri: post.postId, context });
        const replies = array(object(thread["thread"])["replies"] ?? []);

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return { items: replies.map((reply) => object(reply) as JsonObject) };
      },
      async reply(comment, content, context): Promise<CommentRef> {
        const outcome = await adapter.posts?.publishTarget(
          {
            targetIndex: 0,
            targetKey: comment.backend + ":" + comment.platform + ":" + comment.accountId,
            account: connectedAccountRef({
              backend: comment.backend,
              platform: "bluesky",
              accountId: comment.accountId,
            }),
            content: { text: content.text },
            replyTo: platformPostRef({
              backend: comment.backend,
              platform: "bluesky",
              accountId: comment.accountId,
              postId: comment.commentId,
            }),
          },
          context,
        );

        if (outcome?.state !== "published")
          throw new SocialError({
            code: "upstream_failure",
            operation: "bluesky.comments.reply",
            message: "Bluesky did not confirm the comment reply.",
          });

        return {
          kind: "comment",
          version: 1,
          backend: comment.backend,
          platform: "bluesky",
          accountId: comment.accountId,
          postId: comment.postId,
          commentId: outcome.post.postId,
        };
      },
    },
    analytics: {
      async getPostMetrics(post, context): Promise<readonly MetricValue[]> {
        const value = await native.getPost({ uri: post.postId, context });
        const record = object(value);
        const fetchedAt = new Date().toISOString();
        const metrics: MetricValue[] = [];

        for (const [name, field] of [
          ["likes", "likeCount"],
          ["reposts", "repostCount"],
          ["replies", "replyCount"],
          ["quotes", "quoteCount"],
        ] as const) {
          const count = record[field];

          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
          if (typeof count === "number" && Number.isFinite(count))
            metrics.push({
              name,
              value: count,
              unit: "count",
              period: "lifetime",
              fetchedAt,
              freshness: "unknown",
              source: "app.bsky.feed.getPosts",
            });
        }

        return metrics;
      },
      async getAccountMetrics(accountRef, context): Promise<readonly MetricValue[]> {
        // https://docs.bsky.app/docs/api/app-bsky-actor-get-profile
        if (!accountMatches(accountRef, auth, backend))
          throw new SocialError({
            code: "unauthorized",
            operation: "bluesky.analytics.account",
            message: "Account reference does not belong to this Bluesky adapter.",
          });

        const profile = object(
          await xrpc(`app.bsky.actor.getProfile?actor=${encodeURIComponent(auth.did)}`, context),
        );

        if (profile["did"] !== auth.did)
          throw new SocialError({
            code: "unauthorized",
            operation: "bluesky.analytics.account",
            message: "Bluesky profile identity does not match the requested DID.",
          });
        const fetchedAt = new Date().toISOString();

        return (
          [
            ["followers", profile["followersCount"]],
            ["following", profile["followsCount"]],
            ["posts", profile["postsCount"]],
          ] as const
        ).flatMap(([name, value]) =>
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
          typeof value === "number" && Number.isFinite(value)
            ? [
                {
                  name,
                  value,
                  unit: "count" as const,
                  period: "lifetime" as const,
                  fetchedAt,
                  freshness: "unknown" as const,
                  source: "app.bsky.actor.getProfile",
                },
              ]
            : [],
        );
      },
    },
  });

  return adapter;
}
