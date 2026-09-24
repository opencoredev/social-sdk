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
  type JsonValue,
  type MediaAttachment,
  type MediaInput,
  type MediaRef,
  type MetricValue,
  type Page,
  type PreparedPublishTarget,
  type ProfileRecord,
  type RelationshipRecord,
  type SocialAdapter,
} from "../core/index.js";
import { SocialError } from "../core/errors.js";
import { definedFields } from "../core/fields.js";
import { abortable, createHttp, HttpError } from "../transport/http.js";
import { httpsUrl } from "../transport/upload.js";
import {
  array,
  isBoolean,
  isFiniteNumber,
  isString,
  object,
  optionalNumber,
  optionalString,
  string,
  type JsonField,
} from "../transport/validation.js";
import { publicFields } from "../cloud/common.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const MAX_IMAGES = 4;

/** app.bsky.embed.video accepts one MP4 blob of at most 300,000,000 bytes. */
const MAX_VIDEO_BYTES = 300_000_000;

const DEFAULT_VIDEO_SERVICE = "https://video.bsky.app";

/** Bluesky's video guide recommends a 30 minute upload token lifetime. */
const VIDEO_UPLOAD_TOKEN_SECONDS = 30 * 60;

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
  /** HTTPS origin of the Bluesky video service. Defaults to https://video.bsky.app. */
  readonly videoService?: string;
  /**
   * Service DID of the account's PDS (for example `did:web:pds.example.com`). It is the
   * audience of the service token that lets the video service store the processed blob.
   * When omitted, `uploadVideo` reads the `#atproto_pds` endpoint from the DID document
   * returned by `com.atproto.server.getSession`.
   */
  readonly pdsDid?: string;
}

/** A Bluesky video processing job (`app.bsky.video.defs#jobStatus`). */
export interface BlueskyVideoJob {
  readonly jobId: string;
  readonly did: string;
  /** `JOB_STATE_COMPLETED`, `JOB_STATE_FAILED`, or an in-progress state. */
  readonly state: string;
  readonly progress?: number;
  /** The processed blob. Present once the video is stored on the PDS. */
  readonly blob?: JsonObject;
  readonly failureCode?: string;
  readonly error?: string;
  readonly message?: string;
}

/** Output of `app.bsky.video.getUploadLimits` for the configured account. */
export interface BlueskyVideoUploadLimits {
  readonly canUpload: boolean;
  readonly remainingDailyVideos?: number;
  readonly remainingDailyBytes?: number;
  readonly message?: string;
  readonly error?: string;
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
  /**
   * Sends one MP4 to the video service with a single upload request and returns the
   * processing job. It does not wait for processing; poll `getVideoJobStatus` explicitly.
   */
  readonly uploadVideo: (input: {
    readonly account: ConnectedAccountRef;
    readonly video: Blob;
    readonly mimeType?: string;
    /** File name reported to the video service. Defaults to `video.mp4`. */
    readonly name?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyVideoJob>;
  /** Reads a video processing job once. The caller decides when to check again. */
  readonly getVideoJobStatus: (input: {
    readonly account: ConnectedAccountRef;
    readonly jobId: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyVideoJob>;
  /** Reads the account's daily video upload allowance from the video service. */
  readonly getVideoUploadLimits: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyVideoUploadLimits>;
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

function operationError(operation: string, cause: unknown, mutation = true): SocialError {
  if (cause instanceof SocialError) return cause;

  if (cause instanceof HttpError) {
    const error = cause;

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
      ...definedFields({ upstreamStatus: error.status }),
    });
  }

  return new SocialError({
    code: "upstream_failure",
    operation,
    message: "Bluesky request failed.",
    retryDisposition: { kind: "reconcile-first" },
    cause,
  });
}

function postRef(value: JsonField): BlueskyPostRef {
  const record = object(value);

  return { uri: string(record["uri"]), cid: string(record["cid"]) };
}

function videoServiceOrigin(value: string | undefined): URL {
  let url: URL;

  try {
    url = new URL(value ?? DEFAULT_VIDEO_SERVICE);
  } catch {
    throw new SocialError({
      code: "invalid_config",
      operation: "bluesky.configure",
      message: "Bluesky video service must be an absolute URL.",
    });
  }

  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/")
    throw new SocialError({
      code: "invalid_config",
      operation: "bluesky.configure",
      message: "Bluesky video service must be an HTTPS origin without credentials or a path.",
    });

  return url;
}

function serviceDid(value: string, operation: string): string {
  if (!/^did:[a-z]+:[A-Za-z0-9._:%-]{1,2000}$/.test(value))
    throw new SocialError({
      code: "invalid_config",
      operation,
      message: "Bluesky PDS service DID is malformed.",
    });

  return value;
}

/** Validates a processed video blob before it is written into a post record. */
function videoBlob(value: JsonField): JsonObject {
  const blob = object(value);
  const link = object(blob["ref"])["$link"];
  const size = blob["size"];

  if (
    blob["$type"] !== "blob" ||
    !isString(link) ||
    !/^[a-z0-9]{8,128}$/i.test(link) ||
    blob["mimeType"] !== "video/mp4" ||
    !isFiniteNumber(size) ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_VIDEO_BYTES
  )
    throw new SocialError({
      code: "media_error",
      operation: "bluesky.video.job",
      message: "Bluesky returned a video blob that cannot be embedded.",
      retryDisposition: { kind: "never" },
    });

  return { $type: "blob", ref: { $link: link }, mimeType: "video/mp4", size };
}

/** Parses app.bsky.video.defs#jobStatus and binds it to the configured DID. */
function videoJob(value: JsonField, did: string): BlueskyVideoJob {
  const job = object(value);
  const owner = string(job["did"]);

  if (owner !== did)
    throw new SocialError({
      code: "unauthorized",
      operation: "bluesky.video.job",
      message: "Bluesky video job belongs to a different DID.",
    });

  const progress = optionalNumber(job["progress"]);
  const failureCode = optionalString(job["failureCode"]);
  const error = optionalString(job["error"]);
  const message = optionalString(job["message"]);

  return {
    jobId: string(job["jobId"]),
    did: owner,
    state: string(job["state"]),
    ...definedFields({
      progress,
      blob: job["blob"] === undefined ? undefined : videoBlob(job["blob"]),
      failureCode,
      error,
      message,
    }),
  };
}

type RichTextFacet = {
  readonly index: { readonly byteStart: number; readonly byteEnd: number };
  readonly features: readonly JsonObject[];
};

interface MentionInput {
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly did: string;
}

function linkFacets(text: string): RichTextFacet[] {
  const facets: RichTextFacet[] = [];
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

function invalidRichText(message: string): never {
  throw new SocialError({ code: "invalid_input", operation: "bluesky.prepare", message });
}

/** Caller-supplied publish options arrive untyped; this only admits non-array objects. */
function isOptionBag(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isStringItem(value: unknown): value is string {
  return typeof value === "string";
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isStringItem);
}

function hasMentionFields(value: unknown): value is MentionInput {
  return (
    isOptionBag(value) &&
    "byteStart" in value &&
    "byteEnd" in value &&
    "did" in value &&
    typeof value.byteStart === "number" &&
    typeof value.byteEnd === "number" &&
    typeof value.did === "string"
  );
}

function isJsonBody(body: BodyInit | undefined): body is string {
  return typeof body === "string";
}

function richTextOptions(text: string, target: PreparedPublishTarget): JsonObject {
  const options = target.options;

  if (options !== undefined && !isOptionBag(options))
    invalidRichText("Bluesky options must be an object.");
  const config = options ?? {};

  if (Object.keys(config).some((key) => key !== "languages" && key !== "mentions"))
    invalidRichText("A supplied Bluesky option is not supported.");
  let langs: string[] | undefined;
  const languages = "languages" in config ? config.languages : undefined;

  if (languages !== undefined) {
    if (!isStringList(languages) || languages.length > 3)
      invalidRichText("Bluesky accepts at most three language tags.");

    try {
      langs = Intl.getCanonicalLocales([...languages]);
    } catch {
      invalidRichText("Bluesky languages must be valid BCP 47 tags.");
    }
  }

  const facets = linkFacets(text);
  const bytes = new TextEncoder().encode(text);
  const mentions = ("mentions" in config ? config.mentions : undefined) ?? [];

  if (!isOptionList(mentions) || mentions.length > 100)
    invalidRichText("Bluesky mentions must be an array of at most 100 DID references.");
  const spans: { start: number; end: number }[] = [];

  for (const value of mentions) {
    if (!isOptionBag(value)) invalidRichText("Each mention requires UTF-8 offsets and a DID.");

    if (
      !hasMentionFields(value) ||
      !Number.isSafeInteger(value.byteStart) ||
      !Number.isSafeInteger(value.byteEnd) ||
      value.byteStart < 0 ||
      value.byteEnd <= value.byteStart ||
      value.byteEnd > bytes.length ||
      (bytes[value.byteStart]! & 0xc0) === 0x80 ||
      (value.byteEnd < bytes.length && (bytes[value.byteEnd]! & 0xc0) === 0x80) ||
      !/^did:[a-z]+:[A-Za-z0-9._:%-]+$/.test(value.did)
    )
      invalidRichText("Mention offsets must span complete UTF-8 characters and identify a DID.");

    const { byteStart, byteEnd, did } = value;

    if (!new TextDecoder().decode(bytes.slice(byteStart, byteEnd)).startsWith("@"))
      invalidRichText("A mention span must start with @.");

    if (
      spans.some((span) => byteStart < span.end && byteEnd > span.start) ||
      facets.some((facet) => byteStart < facet.index.byteEnd && byteEnd > facet.index.byteStart)
    )
      invalidRichText("Mention spans must not overlap links or other mentions.");
    spans.push({ start: byteStart, end: byteEnd });
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#mention", did }],
    });
  }

  facets.sort((left, right) => left.index.byteStart - right.index.byteStart);

  return definedFields({ langs, facets: facets.length ? facets : undefined });
}

function graphemeCount(text: string): number {
  return Intl.Segmenter === undefined
    ? Array.from(text).length
    : [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
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
    ...definedFields({ timeoutMs: options.timeoutMs }),
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
        operation: "webhooks.verify",
        platform: "bluesky",
        availability: "unsupported-by-platform",
        notes:
          "Bluesky has no signed webhook delivery. Events arrive over WebSocket streams you subscribe to: the relay firehose (com.atproto.sync.subscribeRepos) or Jetstream. See https://bsky.network/docs/consuming-the-firehose.",
      },
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
        formats: ["text", "image", "video"],
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
        availability: "available",
        formats: ["video"],
        requiredScopes: ["repo"],
        notes:
          "One MP4 per post from a media.upload reference. Publishing reads the video job once and creates the post only when the processed blob is ready; it never waits or polls.",
      },
      {
        operation: "media.upload",
        platform: "bluesky",
        availability: "available",
        formats: ["video"],
        requiredScopes: ["repo"],
        notes:
          "Uploads one video/mp4 Blob of at most 300,000,000 bytes to the Bluesky video service with a PDS service token. Returns the processing job ID as the media reference.",
      },
      {
        operation: "media.video",
        platform: "bluesky",
        availability: "available",
        formats: ["video"],
        requiredScopes: ["repo"],
        notes:
          "native.uploadVideo sends one app.bsky.video.uploadVideo request and returns the job.",
      },
      {
        operation: "media.status",
        platform: "bluesky",
        availability: "available",
        formats: ["video"],
        notes: "native.getVideoJobStatus reads app.bsky.video.getJobStatus once per call.",
      },
      {
        operation: "media.limits.read",
        platform: "bluesky",
        availability: "available",
        formats: ["video"],
        notes:
          "native.getVideoUploadLimits reads the daily video allowance. Uploads do not check it automatically.",
      },
      // Source, accessed 2026-09-24: https://github.com/bluesky-social/atproto/discussions/3038
      {
        operation: "posts.update",
        platform: "bluesky",
        availability: "unsupported-by-platform",
        notes:
          "Bluesky treats posts as immutable. A putRecord rewrite succeeds on the PDS, but the Bluesky AppView ignores post updates and the new CID breaks existing strong references from replies, quotes, likes, and reposts.",
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
  ): Promise<JsonValue> {
    try {
      const headers = new Headers(init.headers);

      if (isJsonBody(init.body) && !headers.has("Content-Type"))
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
        ...definedFields({ body: init.body, signal: context.signal }),
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

    return { did, ...definedFields({ handle: optionalString(session["handle"]) }) };
  }

  const videoOrigin = videoServiceOrigin(options.videoService);
  const timeout = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
  const videoHttp = createHttp({ fetch: fetcher, ...timeout });

  // Bluesky's video guide notes that a video the service already processed is reported as
  // `already_exists` together with the existing job and blob. The upload transport reads that
  // 409 body as a job status; `videoJob` still validates it and binds it to this DID.
  const videoUploadHttp = createHttp({
    fetch: async (input, init) => {
      const response = await fetcher(input, init);

      return response.status === 409
        ? new Response(response.body, { status: 200, headers: response.headers })
        : response;
    },
    ...timeout,
  });

  async function videoRequest(
    method: string,
    query: URLSearchParams,
    context: AdapterOperationContext,
    init: { readonly token?: string; readonly body?: Blob } = {},
  ): Promise<JsonValue> {
    const url = new URL(`/xrpc/${method}`, videoOrigin);
    url.search = query.toString();

    try {
      return await (init.body === undefined ? videoHttp : videoUploadHttp)({
        url,
        timeoutMs: remainingBudget(context),
        method: init.body === undefined ? "GET" : "POST",
        headers: definedFields({
          Authorization: init.token === undefined ? undefined : `Bearer ${init.token}`,
          "Content-Type": init.body === undefined ? undefined : "video/mp4",
        }),
        ...definedFields({ body: init.body, signal: context.signal }),
        maxAttempts: init.body === undefined ? Math.min(context.retryBudget.maxAttempts, 3) : 1,
      });
    } catch (error) {
      throw operationError(`bluesky.${method}`, error, init.body !== undefined);
    }
  }

  /** Requests a short-lived service token from the account's PDS. The token is never logged. */
  async function serviceToken(
    aud: string,
    lxm: string,
    expiresInSeconds: number | undefined,
    context: AdapterOperationContext,
  ): Promise<string> {
    const query = new URLSearchParams({ aud, lxm });

    if (expiresInSeconds !== undefined)
      query.set("exp", String(Math.floor(Date.now() / 1000) + expiresInSeconds));

    const response = object(
      await xrpc(`com.atproto.server.getServiceAuth?${query.toString()}`, context),
    );

    return string(response["token"]);
  }

  /** Resolves the PDS service DID that the video service stores the processed blob with. */
  async function pdsAudience(context: AdapterOperationContext): Promise<string> {
    if (options.pdsDid !== undefined) return serviceDid(options.pdsDid, "bluesky.video.upload");
    const session = object(await xrpc("com.atproto.server.getSession", context));
    const didDoc = session["didDoc"];

    if (session["did"] !== auth.did || didDoc === undefined)
      throw new SocialError({
        code: "invalid_config",
        operation: "bluesky.video.upload",
        message:
          "The session did not include a DID document for this account. Configure pdsDid for video uploads.",
      });
    const document = object(didDoc);

    const pds = array(document["service"] ?? []).find((entry) => {
      const service = object(entry);

      return optionalString(service["id"])?.endsWith("#atproto_pds") === true;
    });

    if (document["id"] !== auth.did || pds === undefined)
      throw new SocialError({
        code: "invalid_config",
        operation: "bluesky.video.upload",
        message: "The DID document does not name a PDS for this account. Configure pdsDid.",
      });
    let host: string;

    try {
      const url = new URL(string(object(pds)["serviceEndpoint"]));

      if (url.protocol !== "https:") throw new Error("PDS endpoint must use HTTPS");
      host = url.host;
    } catch {
      throw new SocialError({
        code: "invalid_config",
        operation: "bluesky.video.upload",
        message: "The DID document names an invalid PDS endpoint. Configure pdsDid.",
      });
    }

    return serviceDid(`did:web:${host.replace(":", "%3A")}`, "bluesky.video.upload");
  }

  /** Validates a normalized video attachment and returns its MP4 bytes without I/O. */
  function videoSource(media: MediaAttachment): Blob {
    const source = media.source;

    const mimeType =
      media.mimeType ?? (source.kind === "blob" ? source.blob.type || undefined : undefined);

    if (media.kind !== "video" || source.kind !== "blob" || mimeType !== "video/mp4")
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: "Bluesky video upload requires one video/mp4 Blob.",
        retryDisposition: { kind: "never" },
      });

    return source.blob;
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
      ...definedFields({ cursor: input.cursor || undefined }),
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
    actors: array(response[key] ?? []).map((value) => object(value)),
    ...definedFields({ cursor: optionalString(response["cursor"]) }),
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

      return object(post);
    },
    async getPostThread(input) {
      const context = input.context ?? {
        correlationId: "bluesky-native",
        retryBudget: { maxAttempts: 2, maxElapsedMs: 30_000 },
        backendInstance: backend,
      };

      const query = new URLSearchParams({ uri: input.uri });

      return object(await xrpc(`app.bsky.feed.getPostThread?${query.toString()}`, context));
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

      const posts = array(response["posts"]).map((post) => object(post));
      const hitsTotal = optionalNumber(response["hitsTotal"]);

      return {
        posts,
        ...definedFields({
          cursor: optionalString(response["cursor"]),
          hitsTotal:
            hitsTotal !== undefined && Number.isSafeInteger(hitsTotal) ? hitsTotal : undefined,
        }),
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
        !isString(uri) ||
        !uri.startsWith(prefix) ||
        !/^[A-Za-z0-9._~:-]{1,512}$/.test(uri.slice(prefix.length)) ||
        !isString(cid) ||
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
    async uploadVideo(input) {
      // https://docs.bsky.app/docs/tutorials/video (recommended method)
      const context = nativeContext(input.context, "bluesky.video.upload");
      assertNativeAccount(input.account, context, "bluesky.video.upload");
      const name = input.name ?? "video.mp4";

      if (
        (input.mimeType ?? input.video.type) !== "video/mp4" ||
        input.video.size <= 0 ||
        input.video.size > MAX_VIDEO_BYTES ||
        name.length > 255 ||
        [...name].some((char) => char.charCodeAt(0) < 0x20 || char === "/" || char === "\\")
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.video.upload",
          message: `Bluesky video upload requires a non-empty video/mp4 Blob of at most ${MAX_VIDEO_BYTES} bytes and a plain file name.`,
          retryDisposition: { kind: "never" },
        });

      const token = await serviceToken(
        await pdsAudience(context),
        "com.atproto.repo.uploadBlob",
        VIDEO_UPLOAD_TOKEN_SECONDS,
        context,
      );

      const response = object(
        await videoRequest(
          "app.bsky.video.uploadVideo",
          new URLSearchParams({ did: auth.did, name }),
          context,
          { token, body: input.video },
        ),
      );

      try {
        // The lexicon wraps the output in `jobStatus`; the video guide reads it unwrapped.
        return videoJob(response["jobStatus"] ?? response, auth.did);
      } catch (error) {
        throw operationError("bluesky.app.bsky.video.uploadVideo", error);
      }
    },
    async getVideoJobStatus(input) {
      // https://docs.bsky.app/docs/api/app-bsky-video-get-job-status
      const context = nativeContext(input.context, "bluesky.video.job");
      assertNativeAccount(input.account, context, "bluesky.video.job");

      if (!/^[\x21-\x7e]{1,256}$/.test(input.jobId))
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.video.job",
          message: "Bluesky video job ID is malformed.",
          retryDisposition: { kind: "never" },
        });

      const response = object(
        await videoRequest(
          "app.bsky.video.getJobStatus",
          new URLSearchParams({ jobId: input.jobId }),
          context,
        ),
      );

      try {
        return videoJob(response["jobStatus"], auth.did);
      } catch (error) {
        throw operationError("bluesky.app.bsky.video.getJobStatus", error, false);
      }
    },
    async getVideoUploadLimits(input) {
      // https://docs.bsky.app/docs/api/app-bsky-video-get-upload-limits
      const context = nativeContext(input.context, "bluesky.video.limits");
      assertNativeAccount(input.account, context, "bluesky.video.limits");

      const token = await serviceToken(
        `did:web:${videoOrigin.host.replace(":", "%3A")}`,
        "app.bsky.video.getUploadLimits",
        undefined,
        context,
      );

      const response = object(
        await videoRequest("app.bsky.video.getUploadLimits", new URLSearchParams(), context, {
          token,
        }),
      );

      const canUpload = response["canUpload"];

      if (!isBoolean(canUpload))
        throw operationError(
          "bluesky.app.bsky.video.getUploadLimits",
          new HttpError("Upload limits are missing canUpload.", "invalid-response", true),
          false,
        );
      const videos = optionalNumber(response["remainingDailyVideos"]);
      const bytes = optionalNumber(response["remainingDailyBytes"]);
      const message = optionalString(response["message"]);
      const error = optionalString(response["error"]);

      return {
        canUpload,
        ...definedFields({
          remainingDailyVideos: videos,
          remainingDailyBytes: bytes,
          message,
          error,
        }),
      };
    },
    async follow(input) {
      const context = nativeContext(input.context, "bluesky.follow");
      assertNativeAccount(input.account, context, "bluesky.follow");

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
      );
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
      );
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
        object(await xrpc(`app.bsky.graph.getFollowers?${q}`, context)),
        "followers",
      );
    },
    async getFollows(input) {
      const context = nativeContext(input.context, "bluesky.graph.follows");
      assertNativeAccount(input.account, context, "bluesky.graph.follows");
      const q = pageQuery(input);
      q.set("actor", input.actor ?? auth.did);

      return actorPage(object(await xrpc(`app.bsky.graph.getFollows?${q}`, context)), "follows");
    },
    async getMutes(input) {
      const context = nativeContext(input.context, "bluesky.graph.mutes");
      assertNativeAccount(input.account, context, "bluesky.graph.mutes");

      return actorPage(
        object(await xrpc(`app.bsky.graph.getMutes?${pageQuery(input)}`, context)),
        "mutes",
      );
    },
    async getBlocks(input) {
      const context = nativeContext(input.context, "bluesky.graph.blocks");
      assertNativeAccount(input.account, context, "bluesky.graph.blocks");

      return actorPage(
        object(await xrpc(`app.bsky.graph.getBlocks?${pageQuery(input)}`, context)),
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
        likes: array(value["likes"] ?? []).map((entry) => object(entry)),
        ...definedFields({ cursor: optionalString(value["cursor"]) }),
      };
    },
    async getActorLikes(input) {
      const context = nativeContext(input.context, "bluesky.likes.actor");
      assertNativeAccount(input.account, context, "bluesky.likes.actor");
      const q = pageQuery(input);
      q.set("actor", input.actor ?? auth.did);
      const value = object(await xrpc(`app.bsky.feed.getActorLikes?${q}`, context));

      return {
        feed: array(value["feed"] ?? []).map((entry) => object(entry)),
        ...definedFields({ cursor: optionalString(value["cursor"]) }),
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

      return actorPage(object(await xrpc(`app.bsky.actor.searchActors?${q}`, context)), "actors");
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
        object(await xrpc(`app.bsky.actor.searchActorsTypeahead?${q}`, context)),
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
        ...definedFields({ description: input.description }),
      };

      return postRef(
        await xrpc("com.atproto.repo.createRecord", context, {
          body: JSON.stringify({ repo: auth.did, collection: "app.bsky.graph.list", record }),
        }),
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

      const next = {
        ...record,
        name: input.name,
        purpose: input.purpose,
        ...definedFields({ description: input.description }),
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

      return object(await xrpc(`app.bsky.graph.getList?${q}`, context));
    },
    async getLists(input) {
      const context = nativeContext(input.context, "bluesky.lists.list");
      assertNativeAccount(input.account, context, "bluesky.lists.list");
      const q = pageQuery(input);
      q.set("actor", input.actor ?? auth.did);

      return object(await xrpc(`app.bsky.graph.getLists?${q}`, context));
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
          ...definedFields({ cursor }),
        });

        const records = object(
          await xrpc(`com.atproto.repo.listRecords?${query.toString()}`, context),
        );

        record = array(records["records"])
          .map((value) => object(value))
          .find((value) => object(value["value"])["subject"] === input.listUri);
        cursor = optionalString(records["cursor"]);
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

      const body = {
        reasonType: input.reasonType,
        subject: input.subject,
        ...definedFields({ reason: input.reason }),
      };

      return object(
        await xrpc("com.atproto.moderation.createReport", context, { body: JSON.stringify(body) }),
      );
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
        ...definedFields({ cursor: input.cursor || undefined }),
      });

      return object(await xrpc(`app.bsky.notification.listNotifications?${query}`, context));
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

      return object(
        await xrpc(
          `app.bsky.actor.getProfile?actor=${encodeURIComponent(input.actor ?? auth.did)}`,
          context,
        ),
      );
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
        ...definedFields({ cursor: input.cursor || undefined }),
      });

      return object(await xrpc(`app.bsky.feed.getSuggestedFeeds?${query}`, context));
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
        ...definedFields({ cursor: input.cursor || undefined }),
      });

      return object(await xrpc(`chat.bsky.convo.listConvos?${query}`, context));
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
        ...definedFields({ cursor: input.cursor || undefined }),
      });

      return object(
        await xrpc(
          `chat.bsky.convo.getMessages?convoId=${encodeURIComponent(input.conversationId)}&${query}`,
          context,
        ),
      );
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

      return object(
        await xrpc("chat.bsky.convo.sendMessage", context, {
          body: JSON.stringify({ convoId: input.conversationId, message: { text: input.text } }),
        }),
      );
    },
  };

  const adapter = defineAdapter<BlueskyNative, SocialAdapter<BlueskyNative>>({
    id: backend,
    capabilities,
    native,
    media: {
      async upload(media, accountRef, context): Promise<MediaRef> {
        const job = await native.uploadVideo({
          account: accountRef,
          video: videoSource(media),
          mimeType: "video/mp4",
          ...definedFields({ name: media.filename }),
          context,
        });

        return {
          kind: "media",
          version: 1,
          backend,
          platform: "bluesky",
          accountId: auth.did,
          mediaId: job.jobId,
        };
      },
    },
    graph: {
      async getProfile(account, input, context): Promise<ProfileRecord> {
        const value = await native.getProfile({
          account,
          ...definedFields({ actor: input.profileId ?? input.handle }),
          context,
        });

        const actor = object(value);
        const id = string(actor["did"]);

        return {
          ref: profileRef({
            backend,
            platform: "bluesky",
            accountId: account.accountId,
            profileId: id,
          }),
          ...definedFields({
            displayName: optionalString(actor["displayName"]),
            handle: optionalString(actor["handle"]),
            avatarUrl: optionalString(actor["avatar"]),
            bio: optionalString(actor["description"]),
          }),
          native: actor,
        };
      },
      async listRelationships(account, input, context): Promise<Page<RelationshipRecord>> {
        const page = definedFields({ cursor: input.cursor, limit: input.limit });

        const result =
          input.kind === "following"
            ? await native.getFollows({
                account,
                context,
                ...page,
              })
            : input.kind === "followers"
              ? await native.getFollowers({
                  account,
                  context,
                  ...page,
                })
              : input.kind === "blocked"
                ? await native.getBlocks({
                    account,
                    context,
                    ...page,
                  })
                : await native.getMutes({
                    account,
                    context,
                    ...page,
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
          ...definedFields({ nextCursor: result.cursor }),
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

        if (!isString(uri) || !uri)
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

        if (!isString(uri) || !uri)
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
              ...definedFields({ handle: session.handle }),
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
          ...definedFields({ handle: session.handle }),
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
          ...definedFields({
            cursor: input.cursor,
            limit: input.limit,
            since: input.startTime,
            until: input.endTime,
            scope: input.scope,
          }),
          context,
        });

        return {
          items: result.posts,
          ...definedFields({
            nextCursor: result.cursor,
            metadata: result.hitsTotal === undefined ? undefined : { hitsTotal: result.hitsTotal },
          }),
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
          ...definedFields({ cursor: input.cursor, limit: input.limit }),
          context,
        });

        const values = response["notifications"];
        const items = values === undefined ? [] : array(values).map((value) => object(value));

        return {
          items,
          ...definedFields({ nextCursor: optionalString(response["cursor"]) }),
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
          ...definedFields({ seenAt: input.seenAt }),
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
          ...definedFields({ cursor: input.cursor }),
        });

        const response = object(
          await xrpc(`app.bsky.feed.getAuthorFeed?${query.toString()}`, context),
        );

        const feed = array(response["feed"]).map((value): JsonObject => {
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
            ...definedFields({
              author:
                post["author"] === undefined
                  ? undefined
                  : publicFields(object(post["author"]), [
                      "did",
                      "handle",
                      "displayName",
                      "avatar",
                    ]),
              record:
                post["record"] === undefined
                  ? undefined
                  : publicFields(object(post["record"]), [
                      "text",
                      "facets",
                      "createdAt",
                      "reply",
                      "embed",
                    ]),
            }),
          };

          return {
            post: safePost,
            ...definedFields({
              reason:
                entry["reason"] === undefined
                  ? undefined
                  : publicFields(object(entry["reason"]), ["$type", "by", "indexedAt"]),
            }),
          };
        });

        return {
          items: feed,
          ...definedFields({ nextCursor: optionalString(response["cursor"]) }),
        };
      },
      prepareTarget(target) {
        const issues = [];
        const text = target.content.text ?? "";

        try {
          richTextOptions(text, target);
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

        const media = target.content.media ?? [];
        const videos = media.filter((item) => item.kind === "video");

        if (videos.length > 0 && media.length !== 1)
          issues.push({
            code: "media.mixed",
            message: "A Bluesky post carries either up to four images or exactly one video.",
            severity: "error" as const,
          });

        for (const video of videos) {
          const ref = video.source.kind === "media-ref" ? video.source.ref : undefined;

          if (ref === undefined)
            issues.push({
              code: "media.video_ref_required",
              message:
                "Upload the video with media.upload, wait until its job has a blob, then publish the returned media reference.",
              severity: "error" as const,
            });
          else if (
            ref.backend !== target.account.backend ||
            ref.platform !== "bluesky" ||
            ref.accountId !== target.account.accountId ||
            !/^[\x21-\x7e]{1,256}$/.test(ref.mediaId)
          )
            issues.push({
              code: "media.video_owner",
              message: "Video reference belongs to another account or backend, or is malformed.",
              severity: "error" as const,
            });

          if (
            (video.width === undefined) !== (video.height === undefined) ||
            [video.width, video.height].some(
              (value) => value !== undefined && (!Number.isSafeInteger(value) || value < 1),
            )
          )
            issues.push({
              code: "media.aspect_ratio",
              message: "Video width and height must be supplied together as positive integers.",
              severity: "error" as const,
            });
        }

        if (videos.length === 0 && media.length > MAX_IMAGES)
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
          const createdAt = new Date().toISOString();
          const richText = richTextOptions(text, target);
          let reply: JsonObject | undefined;
          let embed: JsonObject | undefined;

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
            reply = { root, parent: parentRef };
          }

          const video = content.media?.find((item) => item.kind === "video");

          if (video !== undefined) {
            if (video.source.kind !== "media-ref" || content.media?.length !== 1)
              throw new SocialError({
                code: "invalid_input",
                operation: "bluesky.publish",
                message: "Bluesky video posts require exactly one uploaded video reference.",
                retryDisposition: { kind: "never" },
              });
            const ref = video.source.ref;

            if (ref.backend !== backend || ref.platform !== "bluesky" || ref.accountId !== auth.did)
              throw new SocialError({
                code: "unauthorized",
                operation: "bluesky.publish",
                message: "The video reference does not belong to this adapter.",
                account: target.account,
              });

            // One status read. A job that is still processing fails before any post is created.
            const job = await native.getVideoJobStatus({
              account: target.account,
              jobId: ref.mediaId,
              context,
            });

            if (job.blob === undefined)
              throw new SocialError(
                job.state === "JOB_STATE_FAILED"
                  ? {
                      code: "media_error",
                      operation: "bluesky.publish",
                      message: "Bluesky video processing failed. No post was created.",
                      retryDisposition: { kind: "never" },
                      ...definedFields({ upstreamCode: job.failureCode }),
                    }
                  : {
                      code: "media_error",
                      operation: "bluesky.publish",
                      message:
                        "Bluesky video processing is not complete. No post was created. Check native.getVideoJobStatus, then publish again.",
                      retryDisposition: { kind: "after-delay", delayMs: 1000 },
                      upstreamCode: job.state,
                    },
              );

            embed = {
              $type: "app.bsky.embed.video",
              video: job.blob,
              ...definedFields({
                alt: video.altText,
                aspectRatio:
                  video.width === undefined || video.height === undefined
                    ? undefined
                    : { width: video.width, height: video.height },
              }),
            };
          } else if (content.media !== undefined && content.media.length > 0) {
            const blobs: JsonObject[] = [];

            for (const media of content.media) {
              const source = await readMedia(media.source, fetcher, context, allowMediaHost);

              const blob = object(
                await xrpc("com.atproto.repo.uploadBlob", context, {
                  body: new Blob([source.bytes.slice()], {
                    type: source.mimeType,
                  }),
                  headers: { "Content-Type": source.mimeType },
                }),
              );

              blobs.push(object(blob["blob"]));
            }

            embed = {
              $type: "app.bsky.embed.images",
              images: blobs.map((blob, index) => ({
                image: blob,
                alt: content.media?.[index]?.altText ?? "",
              })),
            };
          }

          const record = {
            $type: "app.bsky.feed.post",
            text,
            createdAt,
            ...richText,
            ...definedFields({ reply, embed }),
          };

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

        return { items: replies.map((reply) => object(reply)) };
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

          if (isFiniteNumber(count))
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
          isFiniteNumber(value)
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
