import { defineAdapter } from "../core/adapter.js";
import { definedFields } from "../core/fields.js";
import { SocialError } from "../core/errors.js";
import type {
  AdapterOperationContext,
  ConnectedAccountRef,
  DeliveryOutcome,
  JsonObject,
  PreparedPublishTarget,
  MetricValue,
  PlatformPostRef,
  ProfileRecord,
} from "../core/types.js";
import { profileRef } from "../core/types.js";
import { acknowledged, managedHttp, optionsObject, publicFields } from "../cloud/common.js";
import {
  rawProviderRequest,
  rawRequestCapability,
  type AccountRawProviderRequest,
  type RawProviderResponse,
  type RawRequestConfig,
} from "../core/raw-request.js";
import { HttpError, abortable, readJson, retryDelay } from "../transport/http.js";
import { fetchWithoutRedirects } from "../transport/redirect.js";
import {
  array,
  isBoolean,
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  object,
  optionalNumber,
  optionalString,
  string,
  type JsonField,
} from "../transport/validation.js";
import { httpsUrl } from "../transport/upload.js";
import { remainingBudget } from "../transport/budget.js";
import { verifyTikTokWebhook } from "../server/webhooks.js";
import { directWebhooks, webhookCapability } from "./webhook-adapter.js";
import { normalizeMetrics } from "../core/projections.js";
import {
  isTikTokChunkBytes,
  localTikTokVideo,
  tiktokDefaultChunkBytes,
  tiktokMaxVideoBytes,
  tiktokVideoMimeTypes,
  tiktokUploadUrl,
  transferTikTokVideo,
  type TikTokLocalVideo,
} from "./tiktok-upload.js";

export interface TikTokOptions {
  readonly auth: { readonly accessToken: string; readonly openId: string };
  /** Origins verified in the developer's TikTok app. PULL_FROM_URL requires ownership. */
  readonly verifiedMediaOrigins: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
  /** App client secret that TikTok uses to sign webhook deliveries (`TikTok-Signature`). */
  readonly webhookSecret?: string;
  /** Accepted age of a signed webhook timestamp, in seconds. Defaults to 300. */
  readonly webhookToleranceSeconds?: number;
  /** Preferred FILE_UPLOAD chunk size, 5 to 64 MiB. Defaults to 10 MiB. */
  readonly uploadChunkBytes?: number;
  /**
   * Set when the creator granted `user.info.profile`. `graph.getProfile` then also requests
   * `username`, `bio_description`, `profile_deep_link` and `is_verified`.
   */
  readonly userInfoProfile?: boolean;
}

/**
 * Fields of `GET /v2/user/info/`, grouped by the scope each needs.
 * Source, accessed 2026-11-04: https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info
 */
export const tiktokUserInfoFields = {
  "user.info.basic": [
    "open_id",
    "union_id",
    "avatar_url",
    "avatar_url_100",
    "avatar_large_url",
    "display_name",
  ],
  "user.info.profile": ["bio_description", "profile_deep_link", "is_verified", "username"],
  "user.info.stats": ["follower_count", "following_count", "likes_count", "video_count"],
} as const;

export type TikTokUserInfoField =
  (typeof tiktokUserInfoFields)[keyof typeof tiktokUserInfoFields][number];

const userInfoFieldNames: ReadonlySet<string> = new Set(Object.values(tiktokUserInfoFields).flat());

function isTikTokUserInfoField(value: string): value is TikTokUserInfoField {
  return userInfoFieldNames.has(value);
}

/** Data categories of the Data Portability API's add-data request. */
export type TikTokPortabilityCategory =
  | "all_data"
  | "video"
  | "profile"
  | "activity"
  | "direct_message";

export type TikTokPortabilityState = "pending" | "downloading" | "expired" | "cancelled";

const portabilityCategories: ReadonlySet<string> = new Set([
  "all_data",
  "video",
  "profile",
  "activity",
  "direct_message",
]);

const portabilityStates: readonly TikTokPortabilityState[] = [
  "pending",
  "downloading",
  "expired",
  "cancelled",
];

/** TikTok error codes are lowercase snake_case machine codes; anything else is not kept. */
function tiktokErrorCode(code: string): string | undefined {
  return /^[a-z][a-z0-9_]{0,99}$/.test(code) ? code : undefined;
}

/** A publish init answer's `publish_id`, which TikTok documents as a string. */
function tiktokPublishId(result: JsonObject): string {
  const id = string(result["publish_id"]);

  if (id.trim() === "" || id.length > 256)
    throw new HttpError("TikTok returned an unusable publish_id.", "invalid-response", true);

  return id;
}

function isPortabilityState(value: JsonField): value is TikTokPortabilityState {
  return portabilityStates.some((state) => state === value);
}

export interface TikTokDataRequest {
  /** Decimal `request_id`, limited to safe integers so it can be sent back exactly. */
  readonly requestId: string;
  /** `unknown` when TikTok reports a status this SDK version does not know; see `providerStatus`. */
  readonly state: TikTokPortabilityState | "unknown";
  readonly providerStatus: string;
  readonly appliedAt?: string;
  readonly collectionStartedAt?: string;
  readonly dataFormat?: string;
  readonly categories: readonly string[];
}

/** Host names for `native.request`: `api` is `https://open.tiktokapis.com`. */
export type TikTokRawHost = "api";

export interface TikTokNative {
  /**
   * Sends one request to a TikTok API path the SDK does not wrap, with the creator's bearer token.
   * Raw requests never retry or reconcile; the caller owns any write it sends.
   */
  readonly request: (
    input: AccountRawProviderRequest<TikTokRawHost>,
    context: AdapterOperationContext,
  ) => Promise<RawProviderResponse>;
  /**
   * Data Portability API (`POST /v2/user/data/add/`): ask TikTok to prepare an export of the
   * creator's data. Needs a matching `portability.*` scope and TikTok's approval.
   */
  readonly addDataRequest: (input: {
    readonly account: ConnectedAccountRef;
    readonly dataFormat: "text" | "json";
    readonly categories: readonly [TikTokPortabilityCategory, ...TikTokPortabilityCategory[]];
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly requestId: string }>;
  /** `POST /v2/user/data/check/`: read the state of an export request. */
  readonly checkDataRequest: (input: {
    readonly account: ConnectedAccountRef;
    readonly requestId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<TikTokDataRequest>;
  /** `POST /v2/user/data/cancel/`: cancel an export request. */
  readonly cancelDataRequest: (input: {
    readonly account: ConnectedAccountRef;
    readonly requestId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /**
   * `POST /v2/user/data/download/`: stream the prepared zip archive. The caller owns the stream
   * and must consume or cancel it. TikTok keeps the archive for four days after it is ready.
   */
  readonly downloadDataRequest: (input: {
    readonly account: ConnectedAccountRef;
    readonly requestId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<ReadableStream<Uint8Array>>;

  /**
   * Read `GET /v2/user/info/` for the authorized creator with exactly the requested fields.
   * Each field needs its scope from `tiktokUserInfoFields`; `open_id` is always requested.
   */
  readonly userInfo: (input: {
    readonly account: ConnectedAccountRef;
    readonly fields: readonly TikTokUserInfoField[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly creatorInfo: (
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ) => Promise<JsonObject>;
  /** Query Display API metadata for up to 20 videos owned by the creator. */
  readonly queryVideos: (input: {
    readonly account: ConnectedAccountRef;
    readonly videoIds: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly uploadDraft: (input: {
    readonly account: ConnectedAccountRef;
    readonly video: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly listVideos: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly maxCount?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly publishStatus: (input: {
    readonly account: ConnectedAccountRef;
    readonly publishId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /**
   * `POST /v2/post/publish/cancel/`: ask TikTok to stop a slow PULL_FROM_URL download for a
   * Direct Post or inbox upload. Needs `video.publish` or `video.upload`. Cancellation is best
   * effort: TikTok cannot stop a download that is nearly done or already processing, and a
   * resolved call does not mean the post was stopped. Poll `publishStatus` until it reports
   * `FAILED` with `fail_reason` `publish_cancelled`, or a final success.
   */
  readonly cancelPublish: (input: {
    readonly account: ConnectedAccountRef;
    readonly publishId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
}

/**
 * Embed Player query parameters. Each is sent as `1` (true) or `0` (false); omitted ones keep
 * TikTok's default, shown in brackets.
 * Source, accessed 2026-11-04: https://developers.tiktok.com/doc/embed-player
 */
export interface TikTokEmbedPlayerOptions {
  /** `controls` [on]. Off hides the progress bar and every control button. */
  readonly controls?: boolean;
  /** `progress_bar` [on], videos only. */
  readonly progressBar?: boolean;
  /** `play_button` [on], videos only. */
  readonly playButton?: boolean;
  /** `volume_control` [on]. */
  readonly volumeControl?: boolean;
  /** `fullscreen_button` [on]. */
  readonly fullscreenButton?: boolean;
  /** `timestamp` [on], videos only: current playback time and duration. */
  readonly timestamp?: boolean;
  /** `loop` [off], videos only. */
  readonly loop?: boolean;
  /** `autoplay` [off], videos only. */
  readonly autoplay?: boolean;
  /** `music_info` [off]: show the sound's details. */
  readonly musicInfo?: boolean;
  /** `description` [off]: show the post's description. */
  readonly description?: boolean;
  /** `rel` [on], videos only: on shows related videos, off shows the author's own videos. */
  readonly rel?: boolean;
  /** `native_context_menu` [on]: the browser's right-click menu. */
  readonly nativeContextMenu?: boolean;
  /** `closed_caption` [on], videos only. */
  readonly closedCaption?: boolean;
  /** `force_muted` [off]: volume 0 and the viewer cannot change it. */
  readonly forceMuted?: boolean;
}

const embedPlayerParams = [
  ["controls", "controls"],
  ["progressBar", "progress_bar"],
  ["playButton", "play_button"],
  ["volumeControl", "volume_control"],
  ["fullscreenButton", "fullscreen_button"],
  ["timestamp", "timestamp"],
  ["loop", "loop"],
  ["autoplay", "autoplay"],
  ["musicInfo", "music_info"],
  ["description", "description"],
  ["rel", "rel"],
  ["nativeContextMenu", "native_context_menu"],
  ["closedCaption", "closed_caption"],
  ["forceMuted", "force_muted"],
] as const satisfies readonly (readonly [keyof TikTokEmbedPlayerOptions, string])[];

/**
 * Builds an Embed Player URL, `https://www.tiktok.com/player/v1/{post_id}`, for an iframe `src`.
 * Embed Player replaces oEmbed and needs no access token.
 */
export function tiktokEmbedPlayerUrl(
  postId: string,
  options: TikTokEmbedPlayerOptions = {},
): string {
  if (!/^\d{1,32}$/.test(postId))
    throw new SocialError({
      code: "invalid_input",
      operation: "tiktok.embedPlayer",
      message: "TikTok post IDs are decimal digits.",
    });

  const url = new URL(`https://www.tiktok.com/player/v1/${postId}`);

  for (const [option, param] of embedPlayerParams) {
    const value = options[option];

    if (value !== undefined) url.searchParams.set(param, value ? "1" : "0");
  }

  return url.toString();
}

/** Host-to-player commands for `iframe.contentWindow.postMessage`. */
export type TikTokPlayerCommand =
  | { readonly type: "play" | "pause" | "mute" | "unMute" }
  /** Seconds from 0 to the video's length. */
  | { readonly type: "seekTo"; readonly value: number }
  /** Image posts only: image index from 0. */
  | { readonly type: "navigateTo"; readonly value: number };

/** Builds the `{ type, value, "x-tiktok-player": true }` message the Embed Player accepts. */
export function tiktokPlayerMessage(command: TikTokPlayerCommand): JsonObject {
  if (
    "value" in command &&
    (!Number.isFinite(command.value) ||
      command.value < 0 ||
      (command.type === "navigateTo" && !Number.isSafeInteger(command.value)))
  )
    throw new SocialError({
      code: "invalid_input",
      operation: "tiktok.embedPlayer",
      message: "TikTok player seek and navigation values must be nonnegative numbers.",
    });

  return "value" in command
    ? { type: command.type, value: command.value, "x-tiktok-player": true }
    : { type: command.type, "x-tiktok-player": true };
}

/** Player-to-host events from the Embed Player, decoded by {@link parseTikTokPlayerEvent}. */
export type TikTokPlayerEvent =
  | { readonly type: "onPlayerReady" }
  /** -1 init, 0 ended, 1 playing, 2 paused, 3 buffering. */
  | { readonly type: "onStateChange"; readonly value: number }
  | { readonly type: "onCurrentTime"; readonly currentTime: number; readonly duration: number }
  | { readonly type: "onMute"; readonly value: boolean }
  | { readonly type: "onVolumeChange"; readonly value: number }
  | { readonly type: "onImageChange"; readonly value: number }
  | { readonly type: "onPlayerError"; readonly errorCode: number; readonly errorType?: string };

/**
 * Decodes a `message` event's `data` from the Embed Player. Returns `undefined` for messages
 * without `"x-tiktok-player": true` or with a shape TikTok does not document. Check the event's
 * `origin` is `https://www.tiktok.com` before calling this.
 */
export function parseTikTokPlayerEvent(data: JsonField): TikTokPlayerEvent | undefined {
  if (!isJsonObject(data) || data["x-tiktok-player"] !== true) return undefined;

  const type = data["type"];
  const value = data["value"];

  if (type === "onPlayerReady") return { type };

  if (
    (type === "onStateChange" || type === "onVolumeChange" || type === "onImageChange") &&
    isFiniteNumber(value)
  )
    return { type, value };

  if (type === "onMute" && isBoolean(value)) return { type, value };

  if (type === "onCurrentTime" && isJsonObject(value)) {
    const currentTime = value["currentTime"];
    const duration = value["duration"];

    if (isFiniteNumber(currentTime) && isFiniteNumber(duration))
      return { type, currentTime, duration };
  }

  if (type === "onPlayerError" && isJsonObject(value) && isFiniteNumber(value["errorCode"]))
    return {
      type,
      errorCode: value["errorCode"],
      ...definedFields({ errorType: optionalString(value["errorType"]) }),
    };

  return undefined;
}

// Source, accessed 2026-11-04: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
// Each photo may be at most 20 MB.
const tiktokMaxPhotoBytes = 20 * 1024 * 1024;

const videoFields = [
  "id",
  "create_time",
  "cover_image_url",
  "share_url",
  "title",
  "video_description",
  "duration",
  "height",
  "width",
  "like_count",
  "comment_count",
  "share_count",
  "view_count",
  "embed_html",
  "embed_link",
  "is_aigc",
];

/**
 * TikTok reports some rejections as 4xx responses with a structured `error.code`.
 * Pass those through as 200 so `data()` can map the provider code, except
 * HTTP 429, whose status and Retry-After belong to the transport. Capture its
 * validated code separately so the transport error retains provider metadata.
 * Read the original stream within the transport's 16 KiB error-evidence cap
 * and request signal, so oversized or aborted reads cancel the source.
 */
function withTikTokErrorBodies(
  fetch: typeof globalThis.fetch,
  onRateLimitCode: (code: string | undefined) => void,
  onResponse: (response: Response | undefined) => void,
) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    onResponse(undefined);
    onRateLimitCode(undefined);

    const response = await fetch(input, init);

    onResponse(response);

    if (response.status < 400 || response.status >= 500) return response;

    try {
      const body = await readJson(response, 16 * 1024, init?.signal ?? undefined);
      const errorObject = object(object(body)["error"]);

      if (response.status === 429) {
        onRateLimitCode(tiktokErrorCode(string(errorObject["code"])));

        return response;
      }

      // Only a stated rejection code turns into the envelope; an HTTP error never reads as "ok".
      if (
        isString(errorObject["code"]) &&
        errorObject["code"] !== "" &&
        errorObject["code"] !== "ok"
      )
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: response.headers,
        });
    } catch {
      // Preserve ordinary HTTP error handling for non-JSON responses.
    }

    return response;
  };
}

export function tiktok(
  options: TikTokOptions,
): import("../core/adapter.js").SocialAdapter<TikTokNative> {
  if (!options.auth.accessToken.trim())
    throw new SocialError({
      code: "invalid_config",
      operation: "createAdapter",
      message: "Configure the selected provider's server-side API key.",
    });

  const chunkBytes = options.uploadChunkBytes ?? tiktokDefaultChunkBytes;

  if (!isTikTokChunkBytes(chunkBytes))
    throw new SocialError({
      code: "invalid_config",
      operation: "createAdapter",
      message: "TikTok uploadChunkBytes must be an integer from 5 MiB through 64 MiB.",
    });

  const request: ReturnType<typeof managedHttp> = async (...args) => {
    let upstreamCode: string | undefined;
    let upstreamStatus: number | undefined;
    let retryAfterMs: number | undefined;

    const httpRequest = managedHttp("https://open.tiktokapis.com", {
      apiKey: options.auth.accessToken,
      fetch: withTikTokErrorBodies(
        (input, init) => (options.fetch ?? globalThis.fetch)(input, init),
        (code) => {
          upstreamCode = code;
        },
        (response) => {
          // A received rejection stays definitive even if its optional evidence stalls.
          upstreamStatus = response?.status;
          retryAfterMs = retryDelay(response?.headers.get("retry-after") ?? null, Date.now());
        },
      ),
    });

    try {
      const result = await httpRequest(...args);
      // Inspect the envelope without throwing: decoding the answer belongs to each caller, so a
      // write can treat a malformed success body as unconfirmed.
      const envelope = isJsonObject(result) ? result["error"] : undefined;

      if (isJsonObject(envelope) && envelope["code"] === "rate_limit_exceeded")
        throw new SocialError({
          code: "rate_limited",
          operation: "tiktok",
          message: "TikTok rejected the operation because its rate limit was exceeded.",
          upstreamCode: "rate_limit_exceeded",
        });

      return result;
    } catch (error) {
      if (
        !(error instanceof SocialError) ||
        error.code === "cancelled" ||
        (error.code !== "rate_limited" && upstreamStatus !== 429)
      )
        throw error;

      const delay =
        retryAfterMs ??
        (error.retryDisposition.kind === "after-delay" ? error.retryDisposition.delayMs : 60_000);

      throw new SocialError({
        ...error.toJSON(),
        code: "rate_limited",
        message: "TikTok rejected the operation because its rate limit was exceeded.",
        ...definedFields({
          upstreamCode: upstreamCode ?? error.upstreamCode,
          upstreamStatus,
        }),
        retryDisposition: { kind: "after-delay", delayMs: Math.min(60_000, Math.max(0, delay)) },
      });
    }
  };

  const origins = new Set(options.verifiedMediaOrigins.map((value) => httpsUrl(value).origin));
  const now = () => (options.clock?.() ?? new Date()).toISOString();

  const authorize = (
    ref: { backend: string; platform: string; accountId: string },
    context: AdapterOperationContext,
  ) => {
    if (
      ref.backend !== context.backendInstance ||
      ref.platform !== "tiktok" ||
      ref.accountId !== options.auth.openId
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "tiktok",
        message: "Account reference does not belong to this TikTok authorization.",
      });
  };

  const checked = (value: JsonField): JsonObject => {
    const response = object(value);
    const error = object(response["error"]);

    if (error["code"] !== "ok")
      throw new SocialError({
        code:
          error["code"] === "rate_limit_exceeded"
            ? "rate_limited"
            : error["code"] === "access_token_invalid"
              ? "reconnect_required"
              : error["code"] === "scope_not_authorized" ||
                  error["code"] === "scope_permission_missed" ||
                  error["code"] === "unaudited_client_can_only_post_to_private_accounts"
                ? "missing_permission"
                : "upstream_failure",
        operation: "tiktok",
        message:
          "TikTok rejected the operation. Check creator eligibility, scope grants, and app audit status.",
        // Keep only a machine code; a malformed code means the answer cannot be read.
        ...definedFields({ upstreamCode: tiktokErrorCode(string(error["code"])) }),
        retryDisposition:
          error["code"] === "rate_limit_exceeded"
            ? { kind: "after-delay", delayMs: 60_000 }
            : { kind: "never" },
      });

    return response;
  };

  const data = (value: JsonField): JsonObject => object(checked(value)["data"]);

  /** Video, inbox and photo init answer `data.publish_id` as a non-empty string. */
  const publishInit = (value: JsonField): JsonObject => {
    const result = data(value);

    tiktokPublishId(result);

    return result;
  };

  const rawConfig: RawRequestConfig<TikTokRawHost> = {
    hosts: { api: "https://open.tiktokapis.com" },
    defaultHost: "api",
    fetch: () => options.fetch ?? globalThis.fetch,
    authorize: ({ headers }) => {
      headers.set("Authorization", `Bearer ${options.auth.accessToken}`);
    },
    // A rejection's `error.code` envelope maps like other TikTok calls; HTTP 429 keeps its delay.
    mapError: (error, body) => {
      if (
        error.code === "ambiguous_outcome" ||
        error.upstreamStatus === 429 ||
        !isJsonObject(body) ||
        !isJsonObject(body["error"])
      )
        return error;

      try {
        checked(body);
      } catch (provider) {
        if (provider instanceof SocialError)
          return new SocialError({
            ...provider.toJSON(),
            operation: error.operation,
            backend: error.backend,
            correlationId: error.correlationId,
            upstreamStatus: error.upstreamStatus,
            cause: error,
          });
      }

      return error;
    },
  };

  // Data Portability request IDs are int64. Only safe integers survive a JSON number round trip.
  const portabilityRequestId = (requestId: string): number => {
    const id = Number(requestId);

    if (!/^[1-9]\d*$/.test(requestId) || !Number.isSafeInteger(id))
      throw new SocialError({
        code: "invalid_input",
        operation: "native",
        message: "TikTok data request IDs must be positive decimal integers.",
      });

    return id;
  };

  const unixSeconds = (value: JsonField): string | undefined =>
    isFiniteNumber(value) && Number.isSafeInteger(value) && value > 0
      ? new Date(value * 1000).toISOString()
      : undefined;

  const creatorInfo = async (
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<JsonObject> => {
    authorize(account, context);
    const creator = data(await request("/v2/post/publish/creator_info/query/", context, {}));

    return {
      accountId: account.accountId,
      backend: account.backend,
      fetchedAt: now(),
      username: string(creator["creator_username"]),
      nickname: string(creator["creator_nickname"]),
      // TikTok signs this URL for two hours; refresh creator info instead of storing it.
      avatarUrl: optionalString(creator["creator_avatar_url"]) ?? null,
      privacyLevels: array(creator["privacy_level_options"]).map(string),
      commentDisabled: creator["comment_disabled"] === true,
      duetDisabled: creator["duet_disabled"] === true,
      stitchDisabled: creator["stitch_disabled"] === true,
      maxVideoDurationSeconds: optionalNumber(creator["max_video_post_duration_sec"]) ?? null,
    };
  };

  const userInfo = async (input: {
    readonly account: ConnectedAccountRef;
    readonly fields: readonly string[];
    readonly operation: string;
    readonly context: AdapterOperationContext;
  }): Promise<JsonObject> => {
    authorize(input.account, input.context);

    if (input.fields.some((field) => !isTikTokUserInfoField(field)))
      throw new SocialError({
        code: "invalid_input",
        operation: input.operation,
        message: "Request only fields that TikTok documents for /v2/user/info/.",
      });

    const fields = [...new Set(["open_id", ...input.fields])];

    const response = data(
      await request("/v2/user/info/", input.context, undefined, { fields: fields.join(",") }),
    );

    const user = object(response["user"]);

    if (user["open_id"] !== input.account.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation: input.operation,
        message: "TikTok creator identity mismatch.",
      });

    return publicFields(user, fields);
  };

  const prepare = (target: PreparedPublishTarget) => {
    const issues: { code: string; message: string; severity: "error"; targetIndex: number }[] = [];

    const fail = (code: string, message: string) =>
      issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

    if (target.account.platform !== "tiktok" || target.account.accountId !== options.auth.openId)
      fail("tiktok.account", "Select the configured TikTok creator.");
    const config = optionsObject(target);
    const draft = config["draft"] === true;

    for (const [key, message] of [
      ["description", "description is only supported by the Zernio managed adapter."],
      ["mediaType", "mediaType is only supported by the Zernio managed adapter."],
    ] as const)
      if (config[key] !== undefined) fail(`tiktok.${key}`, message);

    if (config["consentGiven"] !== true)
      fail(
        "tiktok.consent",
        "The creator must preview the content and explicitly consent before transfer.",
      );

    for (const key of [
      "disableComments",
      "disableDuet",
      "disableStitch",
      "brandedContent",
      "ownBrand",
      "aiGenerated",
      "draft",
    ])
      if (!isBoolean(config[key])) fail(`tiktok.${key}`, `Explicit ${key} choice is required.`);

    if (!draft && config["brandedContent"] === true && config["privacy"] === "SELF_ONLY")
      fail("tiktok.branded_privacy", "TikTok branded content cannot use private visibility.");

    const creatorInfoValue = config["creatorInfo"];

    if (!draft && !isJsonObject(creatorInfoValue))
      fail(
        "tiktok.creator_info",
        "Query creator information explicitly and render its choices before preparation.",
      );
    else if (!draft) {
      const creator = object(creatorInfoValue);

      if (
        creator["accountId"] !== target.account.accountId ||
        creator["backend"] !== target.account.backend
      )
        fail(
          "tiktok.creator_mismatch",
          "Creator information belongs to a different account or backend.",
        );

      const privacyLevels = array(creator["privacyLevels"]);
      const privacy = config["privacy"];

      if (privacy === undefined || !privacyLevels.includes(privacy))
        fail("tiktok.privacy", "Choose a privacy level returned by this creator's information.");
    }

    const media = target.content.media ?? [];
    const video = media.length === 1 && media[0]?.kind === "video";

    if (
      !video &&
      (media.length < 1 || media.length > 35 || media.some((item) => item.kind !== "image"))
    )
      fail("tiktok.media", "Choose one video or 1 to 35 photos; formats cannot be mixed.");

    if ((target.content.text?.length ?? 0) > (video ? 2200 : 4000))
      fail("tiktok.caption", "Caption exceeds TikTok's UTF-16 limit for this format.");

    const title = config["title"];

    if (!video && title !== undefined && (!isString(title) || title.length > 90))
      fail("tiktok.title", "Photo titles are limited to 90 UTF-16 code units.");

    if (video && title !== undefined)
      fail("tiktok.title", "Video captions use content.text; title is a photo-only option.");

    // TikTok documents auto_add_music as a photo post_info field for DIRECT_POST only.
    const autoAddMusic = config["autoAddMusic"];

    if (autoAddMusic !== undefined && (!isBoolean(autoAddMusic) || video || draft))
      fail(
        "tiktok.autoAddMusic",
        "autoAddMusic is a boolean for photo Direct Posts only (draft: false).",
      );

    // video_cover_timestamp_ms is an int32 post_info field of video Direct Post.
    const coverMs = config["videoCoverTimestampMs"];
    const durationMs = (media[0]?.durationSeconds ?? Number.POSITIVE_INFINITY) * 1000;

    if (
      coverMs !== undefined &&
      (!video ||
        draft ||
        !isFiniteNumber(coverMs) ||
        !Number.isSafeInteger(coverMs) ||
        coverMs < 0 ||
        coverMs > 2_147_483_647 ||
        coverMs > durationMs)
    )
      fail(
        "tiktok.videoCover",
        "videoCoverTimestampMs must be whole milliseconds within the video, for video Direct Posts only.",
      );

    const photoCoverIndex = config["photoCoverIndex"];

    if (
      !video &&
      (!isFiniteNumber(photoCoverIndex) ||
        !Number.isInteger(photoCoverIndex) ||
        photoCoverIndex < 0 ||
        photoCoverIndex >= media.length)
    )
      fail("tiktok.cover", "Select a photo cover index within the attached images.");

    for (const item of media) {
      if (item.kind === "image" && (item.byteSize ?? 0) > tiktokMaxPhotoBytes)
        fail("tiktok.photo_size", "TikTok accepts photos up to 20 MB each.");

      if (
        item.kind === "video" &&
        (!Number.isFinite(item.durationSeconds) || (item.durationSeconds ?? 0) <= 0)
      )
        fail(
          "tiktok.duration",
          "Provide known video duration to check the creator's duration limit.",
        );

      if (item.source.kind === "blob" || item.source.kind === "stream") {
        if (item.kind !== "video") {
          fail(
            "tiktok.source",
            "TikTok photos use PULL_FROM_URL. Stage local photos to your TikTok-verified origin first.",
          );
          continue;
        }

        const local = localTikTokVideo(item, item.source, chunkBytes);

        if (local.kind === "invalid") fail(local.code, local.message);
        continue;
      }

      if (item.source.kind !== "https-url") {
        fail(
          "tiktok.source",
          "Supply a URL on your TikTok-verified origin, or a Blob or stream video for FILE_UPLOAD.",
        );
        continue;
      }

      try {
        if (!origins.has(httpsUrl(item.source.url).origin))
          fail("tiktok.origin", "Media origin is not configured as verified for this TikTok app.");
      } catch {
        fail("tiktok.url", "Media requires a public HTTPS URL.");
      }

      const mime = item.mimeType;

      if (
        mime !== undefined &&
        !(
          item.kind === "video"
            ? ["video/mp4", "video/quicktime", "video/webm"]
            : ["image/jpeg", "image/webp"]
        ).includes(mime)
      )
        fail("tiktok.mime", "Unsupported media MIME type for TikTok publishing.");
    }

    if (target.schedule || target.replyTo || target.content.link)
      fail(
        "tiktok.operation",
        "This publishing operation does not support schedules, replies, or structured links.",
      );

    return issues;
  };

  return defineAdapter({
    id: "tiktok",
    capabilities: {
      schemaVersion: 1 as const,
      backend: "tiktok",
      apiRevision: "Content Posting API v2",
      runtime: ["node22", "node24", "bun"],
      capabilities: [
        rawRequestCapability("tiktok", "open.tiktokapis.com"),
        webhookCapability(
          "tiktok",
          "Verifies TikTok-Signature (HMAC-SHA256 over timestamp and raw body) with the client secret and a 300 second default timestamp window, then decodes the event.",
        ),
        {
          platform: "tiktok",
          operation: "posts.publish",
          availability: "available" as const,
          formats: ["video" as const],
          requiredScopes: ["video.publish"],
          constraints: {
            mediaSources: ["https-url", "blob", "stream"],
            maxItems: 1,
            maxBytes: tiktokMaxVideoBytes,
            allowedMimeTypes: tiktokVideoMimeTypes,
          },
          notes:
            "Videos use a verified URL (PULL_FROM_URL) or a Blob or sized stream (chunked FILE_UPLOAD); photos use verified URLs only. Explicit creator choices/consent. Public posting requires app audit. Draft mode uses video.upload.",
        },
        {
          platform: "tiktok",
          operation: "posts.publish",
          availability: "available" as const,
          formats: ["image" as const, "carousel" as const],
          requiredScopes: ["video.publish"],
          constraints: {
            mediaSources: ["https-url"],
            maxItems: 35,
            maxBytes: tiktokMaxPhotoBytes,
            allowedMimeTypes: ["image/jpeg", "image/webp"],
          },
          notes:
            "Photos require PULL_FROM_URL on an origin verified for the TikTok app. Local photos require mediaStaging.",
        },
        {
          platform: "tiktok",
          operation: "posts.publish.preflight",
          availability: "available" as const,
          requiredScopes: ["video.publish"],
          notes:
            "Direct Post refreshes creator_info/query immediately before initialization. Inbox drafts do not require this preflight.",
        },
        {
          platform: "tiktok",
          operation: "posts.schedule",
          availability: "unsupported-by-platform" as const,
          notes: "Content Posting API post_info has no publish-time field.",
        },
        {
          platform: "tiktok",
          operation: "posts.status",
          availability: "available" as const,
          notes: "Requires video.publish for Direct Post or video.upload for inbox drafts.",
        },
        {
          platform: "tiktok",
          operation: "posts.read",
          availability: "available" as const,
          requiredScopes: ["video.list"],
        },
        {
          platform: "tiktok",
          operation: "posts.list",
          availability: "available" as const,
          requiredScopes: ["video.list"],
        },
        {
          platform: "tiktok",
          operation: "posts.draft",
          availability: "available" as const,
          formats: ["video"],
          requiredScopes: ["video.upload"],
          constraints: {
            mediaSources: ["https-url", "blob", "stream"],
            maxItems: 1,
            maxBytes: tiktokMaxVideoBytes,
            allowedMimeTypes: tiktokVideoMimeTypes,
          },
        },
        {
          platform: "tiktok",
          operation: "posts.status.poll",
          availability: "available" as const,
          notes: "Requires video.publish for Direct Post or video.upload for inbox drafts.",
        },
        // Source, accessed 2026-09-24: https://developers.tiktok.com/doc/content-posting-api-get-started
        {
          platform: "tiktok",
          operation: "posts.update",
          availability: "unsupported-by-platform" as const,
          notes:
            "The Content Posting API sets caption and privacy only when a post is initialized. It has no endpoint to edit a published post.",
        },
        {
          platform: "tiktok",
          operation: "comments.read",
          availability: "unsupported-by-platform" as const,
          notes: "Standard Content Posting and Display APIs do not expose comments.",
        },
        {
          platform: "tiktok",
          operation: "messages.read",
          availability: "unsupported-by-platform" as const,
        },
        {
          platform: "tiktok",
          operation: "notifications.read",
          availability: "unsupported-by-platform" as const,
          notes: "TikTok for Developers APIs do not expose a user notification inbox.",
        },
        {
          platform: "tiktok",
          operation: "accounts.read",
          availability: "available" as const,
          requiredScopes: ["user.info.basic"],
        },
        {
          platform: "tiktok",
          operation: "profiles.read",
          availability: "available" as const,
          requiredScopes: ["user.info.basic"],
          notes:
            "Reads the authorized creator only. Set userInfoProfile when user.info.profile was granted to add username, bio, profile link and verification.",
        },
        {
          platform: "tiktok",
          operation: "analytics.account.read",
          availability: "available" as const,
          requiredScopes: ["user.info.stats"],
        },
        {
          platform: "tiktok",
          operation: "analytics.read",
          availability: "available" as const,
          requiredScopes: ["video.list"],
        },
        {
          platform: "tiktok",
          operation: "profile.update",
          availability: "unsupported-by-platform" as const,
          notes: "The Display API reads user info only. TikTok has no profile write endpoint.",
        },
      ],
    },
    webhooks: directWebhooks(
      "tiktok",
      (input) =>
        verifyTikTokWebhook({
          ...input,
          secret: options.webhookSecret ?? "",
          now: () => options.clock?.() ?? new Date(),
          ...definedFields({ toleranceSeconds: options.webhookToleranceSeconds }),
        }),
      now,
    ),
    accounts: {
      async list(_input: { cursor?: string; limit?: number }, context: AdapterOperationContext) {
        const response = data(
          await request("/v2/user/info/", context, undefined, { fields: "open_id,display_name" }),
        );

        const user = object(response["user"]);

        if (user["open_id"] !== options.auth.openId)
          throw new SocialError({
            code: "unauthorized",
            operation: "accounts.read",
            message: "TikTok returned a different authorized creator.",
          });

        return {
          items: [
            {
              ref: {
                kind: "connected-account" as const,
                version: 1 as const,
                backend: context.backendInstance,
                platform: "tiktok",
                accountId: options.auth.openId,
              },
              displayName: string(user["display_name"]),
              status: "connected" as const,
            },
          ],
        };
      },
      async get(account: ConnectedAccountRef, context: AdapterOperationContext) {
        authorize(account, context);

        const response = data(
          await request("/v2/user/info/", context, undefined, { fields: "open_id,display_name" }),
        );

        const user = object(response["user"]);

        if (user["open_id"] !== account.accountId)
          throw new SocialError({
            code: "unauthorized",
            operation: "accounts.read",
            message: "TikTok creator identity mismatch.",
          });

        return {
          ref: account,
          displayName: string(user["display_name"]),
          status: "connected" as const,
        };
      },
    },
    graph: {
      async getProfile(account, input, context): Promise<ProfileRecord> {
        // TikTok's Display API reads only the user who granted the token.
        if (
          input.handle !== undefined ||
          (input.profileId !== undefined && input.profileId !== account.accountId)
        )
          throw new SocialError({
            code: "unauthorized",
            operation: "profiles.read",
            message: "TikTok profile reads are limited to the authorized creator.",
          });

        const user = await userInfo({
          account,
          fields: [
            ...tiktokUserInfoFields["user.info.basic"],
            ...(options.userInfoProfile === true ? tiktokUserInfoFields["user.info.profile"] : []),
          ],
          operation: "profiles.read",
          context,
        });

        return {
          ref: profileRef({
            backend: account.backend,
            platform: "tiktok",
            accountId: account.accountId,
            profileId: account.accountId,
          }),
          ...definedFields({
            displayName: optionalString(user["display_name"]),
            handle: optionalString(user["username"]),
            avatarUrl: optionalString(user["avatar_url"]),
            bio: optionalString(user["bio_description"]),
          }),
          native: user,
        };
      },
    },
    posts: {
      async get(ref: PlatformPostRef, context: AdapterOperationContext): Promise<JsonObject> {
        authorize(ref, context);

        const result = data(
          await request(
            "/v2/video/query/",
            context,
            { filters: { video_ids: [ref.postId] } },
            { fields: videoFields.join(",") },
          ),
        );

        const row = array(result["videos"])
          .map(object)
          .find((video) => video["id"] === ref.postId);

        if (!row)
          throw new SocialError({
            code: "upstream_failure",
            operation: "posts.read",
            message: "TikTok video was not found for this authorization.",
          });

        return publicFields(row, videoFields);
      },
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        authorize(account, context);
        const limit = input.limit ?? 20;
        const cursor = input.cursor === undefined ? 0 : Number(input.cursor);

        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 20 ||
          !Number.isSafeInteger(cursor) ||
          cursor < 0 ||
          input.cursor === ""
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.read",
            message: "TikTok requires a nonnegative cursor and page size from 1 to 20.",
          });

        const result = data(
          await request(
            "/v2/video/list/",
            context,
            { cursor, max_count: limit },
            { fields: videoFields.join(",") },
          ),
        );

        const nextOffset = result["cursor"];

        const nextCursor =
          result["has_more"] === true &&
          isFiniteNumber(nextOffset) &&
          Number.isSafeInteger(nextOffset) &&
          nextOffset >= 0
            ? String(nextOffset)
            : undefined;

        return {
          items: array(result["videos"]).map((row) => publicFields(row, videoFields)),
          ...definedFields({ nextCursor }),
        };
      },
      prepareTarget: prepare,
      async publishTarget(
        target: PreparedPublishTarget,
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        authorize(target.account, context);
        const config = optionsObject(target);
        const draft = config["draft"] === true;

        if (!draft && config["brandedContent"] === true && config["privacy"] === "SELF_ONLY")
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.publish",
            message: "TikTok branded content cannot use private visibility.",
          });

        const media = target.content.media ?? [];
        const first = media[0];
        let local: TikTokLocalVideo | undefined;

        // Check every source before any provider request.
        if (first?.source.kind === "blob" || first?.source.kind === "stream") {
          const resolved =
            first.kind === "video" && media.length === 1
              ? localTikTokVideo(first, first.source, chunkBytes)
              : undefined;

          if (resolved?.kind !== "valid")
            throw new SocialError({
              code: "invalid_input",
              operation: "posts.publish",
              message:
                resolved?.message ??
                "TikTok photos use PULL_FROM_URL. Stage local photos to a verified origin first.",
            });
          local = resolved.video;
        } else if (!first || media.some((item) => item.source.kind !== "https-url"))
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.publish",
            message: "Verified media URL required.",
          });

        const latest = draft ? undefined : await creatorInfo(target.account, context);

        const privacy = config["privacy"];

        if (latest && (privacy === undefined || !array(latest["privacyLevels"]).includes(privacy)))
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.publish",
            message:
              "Creator privacy choices changed. Refresh the preview and ask the creator to select again.",
          });

        for (const [remote, choice] of [
          ["commentDisabled", "disableComments"],
          ["duetDisabled", "disableDuet"],
          ["stitchDisabled", "disableStitch"],
        ])
          if (
            (remote === "commentDisabled" || first?.kind === "video") &&
            latest &&
            remote &&
            choice &&
            latest[remote] === true &&
            config[choice] !== true
          )
            throw new SocialError({
              code: "invalid_input",
              operation: "posts.publish",
              message:
                "Creator interaction restrictions changed. Refresh the preview before publishing.",
            });

        const maxDuration = latest?.["maxVideoDurationSeconds"];

        if (
          first.kind === "video" &&
          isFiniteNumber(maxDuration) &&
          (first.durationSeconds ?? Infinity) > maxDuration
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.publish",
            message: "Video exceeds this creator's allowed duration.",
          });

        // TikTok documents these post_info fields for DIRECT_POST only.
        const directPostInfo: JsonObject = {
          privacy_level: string(config["privacy"]),
          disable_comment: config["disableComments"] === true,
          brand_content_toggle: config["brandedContent"] === true,
          brand_organic_toggle: config["ownBrand"] === true,
        };

        let result: JsonObject;

        if (first.kind === "video")
          result = await acknowledged(
            "posts.publish",
            request(
              draft ? "/v2/post/publish/inbox/video/init/" : "/v2/post/publish/video/init/",
              context,
              {
                ...definedFields({
                  post_info: draft
                    ? undefined
                    : {
                        title: target.content.text ?? "",
                        ...directPostInfo,
                        disable_duet: config["disableDuet"] === true,
                        disable_stitch: config["disableStitch"] === true,
                        is_aigc: config["aiGenerated"] === true,
                        ...definedFields({
                          video_cover_timestamp_ms: optionalNumber(config["videoCoverTimestampMs"]),
                        }),
                      },
                }),
                source_info: local
                  ? {
                      source: "FILE_UPLOAD",
                      video_size: local.plan.videoSize,
                      chunk_size: local.plan.chunkSize,
                      total_chunk_count: local.plan.totalChunkCount,
                    }
                  : {
                      source: "PULL_FROM_URL",
                      video_url: first.source.kind === "https-url" ? first.source.url : "",
                    },
              },
            ),
            publishInit,
          );
        else {
          const photoText: JsonObject = {
            title: optionalString(config["title"]) ?? "",
            description: target.content.text ?? "",
          };

          result = await acknowledged(
            "posts.publish",
            request("/v2/post/publish/content/init/", context, {
              // MEDIA_UPLOAD sends only the text; the creator finishes the post in TikTok.
              post_info: draft
                ? photoText
                : {
                    ...photoText,
                    ...directPostInfo,
                    auto_add_music: config["autoAddMusic"] === true,
                  },
              source_info: {
                source: "PULL_FROM_URL",
                photo_cover_index: optionalNumber(config["photoCoverIndex"]) ?? 0,
                photo_images: media.map((item) =>
                  item.source.kind === "https-url" ? item.source.url : "",
                ),
              },
              post_mode: draft ? "MEDIA_UPLOAD" : "DIRECT_POST",
              media_type: "PHOTO",
              is_aigc: config["aiGenerated"] === true,
            }),
            publishInit,
          );
        }

        const accepted = {
          account: target.account,
          targetIndex: target.targetIndex,
          delivery: {
            kind: "delivery" as const,
            version: 1 as const,
            backend: target.account.backend,
            platform: "tiktok",
            accountId: target.account.accountId,
            deliveryId: tiktokPublishId(result),
          },
        };

        if (!local)
          return { ...accepted, state: "accepted", observedAt: now(), backendState: "INITIALIZED" };

        // From here TikTok holds an initialized post: every outcome keeps its publish_id.
        const issuedUrl = optionalString(result["upload_url"]);
        const uploadUrl = issuedUrl === undefined ? undefined : tiktokUploadUrl(issuedUrl);

        if (!uploadUrl)
          return {
            ...accepted,
            state: "failed",
            observedAt: now(),
            backendState: "INITIALIZED",
            code: "upstream_failure",
            message:
              "TikTok returned an upload URL outside its known upload hosts. No video bytes were sent.",
            retryDisposition: { kind: "reconcile-first" },
          };

        let timeoutMs = 0;

        try {
          timeoutMs = remainingBudget(context);
        } catch {
          // An exhausted budget fails the transfer below without discarding the publish_id.
        }

        const transfer = await transferTikTokVideo({
          uploadUrl,
          video: local,
          fetch: options.fetch ?? globalThis.fetch,
          signal: context.signal,
          timeoutMs,
        });

        switch (transfer.kind) {
          case "complete":
            return {
              ...accepted,
              state: "processing",
              observedAt: now(),
              backendState: "PROCESSING_UPLOAD",
            };
          case "failed":
            return {
              ...accepted,
              state: "failed",
              observedAt: now(),
              backendState: "INITIALIZED",
              code: transfer.code,
              message: transfer.message,
              retryDisposition: { kind: "reconcile-first" },
            };
          case "uncertain":
            return {
              ...accepted,
              state: "unknown",
              observedAt: now(),
              reason: "ambiguous-submission",
              diagnostic: transfer.message,
            };
          case "cancelled":
            return {
              ...accepted,
              state: "cancelled",
              observedAt: now(),
              backendState: "INITIALIZED",
              reason: "The TikTok upload was cancelled before its final chunk.",
            };
          default: {
            const _exhaustive: never = transfer;

            return _exhaustive;
          }
        }
      },
      async getDelivery(
        ref: { backend: string; platform: string; accountId: string; deliveryId: string },
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        authorize(ref, context);

        const result = data(
          await request("/v2/post/publish/status/fetch/", context, { publish_id: ref.deliveryId }),
        );

        const state = string(result["status"]);

        const base = {
          account: {
            kind: "connected-account" as const,
            version: 1 as const,
            backend: ref.backend,
            platform: "tiktok",
            accountId: ref.accountId,
          },
          targetIndex: 0,
          observedAt: now(),
          backendState: state,
          delivery: { kind: "delivery" as const, version: 1 as const, ...ref },
        };

        if (state === "FAILED")
          return {
            ...base,
            state: "failed",
            code: optionalString(result["fail_reason"]) ?? "upstream_failure",
            message: "TikTok confirmed this publishing action failed.",
            retryDisposition: ["internal", "video_pull_failed", "photo_pull_failed"].includes(
              optionalString(result["fail_reason"]) ?? "",
            )
              ? { kind: "reconcile-first" }
              : { kind: "never" },
          };

        if (state === "PROCESSING_UPLOAD" || state === "PROCESSING_DOWNLOAD")
          return { ...base, state: "processing" };

        if (state === "SEND_TO_USER_INBOX") return { ...base, state: "accepted" };

        if (state === "PUBLISH_COMPLETE") {
          // One inbox publish_id can produce several public posts. Large int64 IDs
          // arrive as strings because the JSON reader keeps unsafe integers exact.
          const ids = result["publicaly_available_post_id"];

          const postIds = (Array.isArray(ids) ? ids : []).flatMap((id) =>
            isString(id) && /^\d+$/.test(id)
              ? [id]
              : isFiniteNumber(id) && Number.isSafeInteger(id) && id >= 0
                ? [String(id)]
                : [],
          );

          const decoded = Array.isArray(ids) && postIds.length === ids.length;
          const nativeId = decoded && postIds.length === 1 ? postIds[0] : undefined;

          if (decoded && postIds.length > 1) return { ...base, state: "accepted", postIds };

          if (nativeId)
            return {
              ...base,
              state: "published",
              post: {
                kind: "platform-post",
                version: 1,
                backend: ref.backend,
                platform: "tiktok",
                accountId: ref.accountId,
                postId: nativeId,
              },
            };

          return { ...base, state: "accepted" };
        }

        return {
          ...base,
          state: "unknown",
          reason: "unmapped-state",
          diagnostic:
            "Native public identifier is unavailable or provider status is unmapped. Retain the publishing reference for reconciliation.",
        };
      },
    },
    analytics: {
      async getPostMetrics(
        post: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        // https://developers.tiktok.com/doc/tiktok-api-v2-video-query/ (Display API video query)
        authorize(post, context);

        const result = data(
          await request(
            "/v2/video/query/",
            context,
            { filters: { video_ids: [post.postId] } },
            { fields: "id,like_count,comment_count,share_count,view_count" },
          ),
        );

        const row = array(result["videos"])
          .map(object)
          .find((video) => video["id"] === post.postId);

        if (!row)
          throw new SocialError({
            code: "upstream_failure",
            operation: "analytics.read",
            message: "TikTok video was not found for this authorization.",
          });
        const fetchedAt = now();

        return normalizeMetrics(
          (["like_count", "comment_count", "share_count", "view_count"] as const).flatMap(
            (field) => {
              const value = row[field];

              return isFiniteNumber(value)
                ? [
                    {
                      name: field,
                      value,
                      unit: "count" as const,
                      period: "lifetime" as const,
                      fetchedAt,
                      freshness: "unknown" as const,
                      source: "tiktok:video.query",
                    },
                  ]
                : [];
            },
          ),
        );
      },
      async getAccountMetrics(
        account: ConnectedAccountRef,
        context: AdapterOperationContext,
      ): Promise<readonly import("../core/index.js").MetricValue[]> {
        // https://developers.tiktok.com/doc/tiktok-api-v2-user-info/
        authorize(account, context);

        const response = data(
          await request("/v2/user/info/", context, undefined, {
            fields: "open_id,display_name,follower_count,following_count,likes_count,video_count",
          }),
        );

        const user = object(response["user"]);

        if (user["open_id"] !== account.accountId)
          throw new SocialError({
            code: "unauthorized",
            operation: "analytics.account.read",
            message: "TikTok creator identity mismatch.",
          });
        const fetchedAt = now();

        // likes_count counts likes received across all videos, so it has no canonical counter.
        return normalizeMetrics(
          (["follower_count", "following_count", "likes_count", "video_count"] as const).flatMap(
            (field) => {
              const value = user[field];

              return isFiniteNumber(value)
                ? [
                    {
                      name: field,
                      value,
                      unit: "count" as const,
                      period: "lifetime" as const,
                      fetchedAt,
                      freshness: "unknown" as const,
                      source: "tiktok:user.info.stats",
                    },
                  ]
                : [];
            },
          ),
        );
      },
    },
    native: {
      async request(input, context) {
        authorize(input.account, context);

        return rawProviderRequest(rawConfig, input, context);
      },
      // Data Portability API, accessed 2026-11-04:
      // https://developers.tiktok.com/doc/data-portability-api-get-started
      async addDataRequest({ account, dataFormat, categories, context }) {
        authorize(account, context);

        if (
          (dataFormat !== "text" && dataFormat !== "json") ||
          categories.length === 0 ||
          categories.some((category) => !portabilityCategories.has(category))
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "native",
            message:
              "Choose data_format text or json and at least one documented portability category.",
          });

        // TikTok may have created the export (a .single scope allows only one) once it answers
        // "ok", so an unusable success response is uncertain, not a failed create.
        const uncertain = (message: string, cause?: unknown) =>
          new SocialError({
            code: "ambiguous_outcome",
            operation: "native",
            message,
            retryDisposition: { kind: "reconcile-first" },
            ...definedFields({ cause }),
          });

        let requestId: JsonField;

        try {
          requestId = data(
            await request(
              "/v2/user/data/add/",
              context,
              { data_format: dataFormat, category_selection_list: [...new Set(categories)] },
              { fields: "request_id" },
            ),
          )["request_id"];
        } catch (error) {
          // Transport failures and explicit rejections arrive as SocialError; an HttpError here
          // means the received success response could not be decoded.
          if (error instanceof HttpError && error.kind === "invalid-response")
            throw uncertain(
              "TikTok answered the data request with a malformed response. Check the creator's requests in TikTok before retrying.",
              error,
            );
          throw error;
        }

        if (!isFiniteNumber(requestId) || !Number.isSafeInteger(requestId) || requestId <= 0)
          throw uncertain(
            "TikTok accepted the data request but returned a request ID that cannot be sent back exactly. Track it in TikTok before retrying.",
          );

        return { requestId: String(requestId) };
      },
      async checkDataRequest({ account, requestId, context }) {
        authorize(account, context);

        const result = data(
          await request(
            "/v2/user/data/check/",
            context,
            { request_id: portabilityRequestId(requestId) },
            {
              fields:
                "request_id,status,apply_time,collect_time,data_format,category_selection_list",
            },
          ),
        );

        const providerStatus = string(result["status"]);
        const categories = result["category_selection_list"];

        return {
          requestId,
          state: isPortabilityState(providerStatus) ? providerStatus : "unknown",
          providerStatus,
          categories: isJsonArray(categories) ? categories.filter(isString) : [],
          ...definedFields({
            appliedAt: unixSeconds(result["apply_time"]),
            collectionStartedAt: unixSeconds(result["collect_time"]),
            dataFormat: optionalString(result["data_format"]),
          }),
        };
      },
      async cancelDataRequest({ account, requestId, context }) {
        authorize(account, context);
        // Success is the bare `{"error":{"code":"ok"}}` envelope (Cancel Data Request reference).
        await acknowledged(
          "native",
          request("/v2/user/data/cancel/", context, {
            request_id: portabilityRequestId(requestId),
          }),
          checked,
        );
      },
      async downloadDataRequest({ account, requestId, context }) {
        authorize(account, context);

        const body = JSON.stringify({ request_id: portabilityRequestId(requestId) });
        const controller = new AbortController();
        const abort = () => controller.abort();

        if (context.signal?.aborted)
          throw new SocialError({
            code: "cancelled",
            operation: "native",
            message: "The TikTok data download was cancelled.",
          });
        // The budget covers the wait for response headers; the caller paces the body stream.
        const timeoutMs = remainingBudget(context);
        context.signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, timeoutMs);
        let response: Response;

        try {
          const pending = fetchWithoutRedirects(
            options.fetch ?? globalThis.fetch,
            "https://open.tiktokapis.com/v2/user/data/download/",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${options.auth.accessToken}`,
                "Content-Type": "application/json",
              },
              body,
              signal: controller.signal,
            },
          );

          // An injected fetch may ignore the signal; release a response that arrives too late.
          void pending.then(
            (late) => {
              if (controller.signal.aborted) void late.body?.cancel().catch(() => undefined);
            },
            () => undefined,
          );
          response = await abortable(pending, controller.signal);
        } catch (error) {
          context.signal?.removeEventListener("abort", abort);
          throw new SocialError({
            code: context.signal?.aborted
              ? "cancelled"
              : controller.signal.aborted
                ? "timeout"
                : "upstream_failure",
            operation: "native",
            message: "The TikTok data download request did not complete.",
            cause: error,
          });
        } finally {
          clearTimeout(timer);
        }

        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

        // Errors arrive as the usual JSON envelope; the archive itself is not JSON.
        if (contentType.includes("json") || !response.ok || !response.body) {
          if (response.status === 429) {
            void response.body?.cancel().catch(() => undefined);
            context.signal?.removeEventListener("abort", abort);

            throw new SocialError({
              code: "rate_limited",
              operation: "native",
              message: "TikTok rejected the operation because its rate limit was exceeded.",
              upstreamStatus: 429,
              retryDisposition: { kind: "after-delay", delayMs: 60_000 },
            });
          }

          let envelope: JsonField;

          // Cancellation and the remaining budget still apply while the error body is read.
          const readTimer = setTimeout(abort, remainingBudget(context));

          try {
            envelope = await readJson(response, 16 * 1024, controller.signal);
          } catch {
            envelope = undefined;
          } finally {
            clearTimeout(readTimer);
            context.signal?.removeEventListener("abort", abort);
          }

          if (isJsonObject(envelope) && isJsonObject(envelope["error"])) checked(envelope);

          throw new SocialError({
            code: "upstream_failure",
            operation: "native",
            message: "TikTok did not return the data archive.",
            upstreamStatus: response.status,
          });
        }

        const reader = response.body.getReader();
        const release = () => context.signal?.removeEventListener("abort", abort);

        // The wrapper detaches the abort listener once the archive ends, fails or is cancelled.
        return new ReadableStream<Uint8Array>({
          async pull(stream) {
            let next: ReadableStreamReadResult<Uint8Array>;

            try {
              next = await abortable(reader.read(), controller.signal);
            } catch (error) {
              release();
              void reader.cancel().catch(() => undefined);
              stream.error(
                new SocialError({
                  code: context.signal?.aborted ? "cancelled" : "upstream_failure",
                  operation: "native",
                  message: "The TikTok data archive stream did not complete.",
                  cause: error,
                }),
              );

              return;
            }

            if (next.done) {
              release();
              stream.close();

              return;
            }

            stream.enqueue(next.value);
          },
          cancel(reason) {
            release();

            return reader.cancel(reason);
          },
        });
      },
      userInfo: ({ account, fields, context }) =>
        userInfo({ account, fields, operation: "native", context }),
      creatorInfo,
      async queryVideos({ account, videoIds, context }) {
        authorize(account, context);

        if (
          videoIds.length < 1 ||
          videoIds.length > 20 ||
          videoIds.some((videoId) => videoId.trim() === "")
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "native",
            message: "TikTok video queries require 1 to 20 nonempty video IDs.",
          });

        return data(
          await request(
            "/v2/video/query/",
            context,
            { filters: { video_ids: [...videoIds] } },
            { fields: videoFields.join(",") },
          ),
        );
      },
      async uploadDraft({ account, video, context }) {
        authorize(account, context);

        const sourceInfo = video["source_info"];
        const fileUpload = isJsonObject(sourceInfo) && sourceInfo["source"] === "FILE_UPLOAD";

        // The Upload reference answers with a string publish_id, plus upload_url for FILE_UPLOAD.
        return acknowledged(
          "native",
          request("/v2/post/publish/inbox/video/init/", context, video),
          (body) => {
            const result = publishInit(body);

            if (fileUpload) string(result["upload_url"]);

            return result;
          },
        );
      },
      async listVideos({ account, cursor, maxCount, context }) {
        authorize(account, context);

        const parsedCursor = cursor === undefined ? 0 : Number(cursor);
        const parsedMaxCount = maxCount ?? 20;

        if (
          !Number.isSafeInteger(parsedCursor) ||
          parsedCursor < 0 ||
          cursor === "" ||
          !Number.isSafeInteger(parsedMaxCount) ||
          parsedMaxCount < 1 ||
          parsedMaxCount > 20
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "native",
            message: "TikTok requires a nonnegative cursor and page size from 1 to 20.",
          });

        return data(
          await request(
            "/v2/video/list/",
            context,
            { cursor: parsedCursor, max_count: parsedMaxCount },
            { fields: videoFields.join(",") },
          ),
        );
      },
      async publishStatus({ account, publishId, context }) {
        authorize(account, context);

        return data(
          await request("/v2/post/publish/status/fetch/", context, { publish_id: publishId }),
        );
      },
      async cancelPublish({ account, publishId, context }) {
        authorize(account, context);

        if (!publishId.trim() || publishId.length > 256)
          throw new SocialError({
            code: "invalid_input",
            operation: "native",
            message: "A TikTok publish_id is required.",
          });

        // Success is the `ok` envelope; stated rejections such as publish_not_cancellable stay definite.
        await acknowledged(
          "native",
          request("/v2/post/publish/cancel/", context, { publish_id: publishId }),
          checked,
        );
      },
    },
  });
}
