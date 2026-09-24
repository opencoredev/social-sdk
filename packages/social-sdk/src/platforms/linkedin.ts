import { remainingBudget } from "../transport/budget.js";
import { definedFields } from "../core/fields.js";
import { defineAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import type {
  AdapterOperationContext,
  CommentRef,
  ConnectedAccountRef,
  JsonObject,
  MediaAttachment,
  MediaRef,
  MetricValue,
  PlatformPostRef,
  PreparedPublishTarget,
} from "../core/types.js";
import { createHttp, HttpError } from "../transport/http.js";
import {
  array,
  isJsonObject,
  object,
  string,
  optionalString,
  optionalNumber,
  type JsonField,
} from "../transport/validation.js";
import { upload } from "../transport/upload.js";
import { optionsObject, publicFields } from "../cloud/common.js";
import { verifyLinkedInWebhook } from "../server/webhooks.js";
import { directWebhooks } from "./webhook-adapter.js";

/** Documents API file types (PDF, PPT, PPTX, DOC, DOCX), checked 2026-09-24 against version 202609. */
const linkedInDocumentMimeTypes: readonly string[] = [
  "application/pdf",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

/** LinkedIn documents "100MB"; the decimal reading is the conservative local bound. */
const linkedInDocumentMaxBytes = 100_000_000;

const linkedInDocumentUrn = /^urn:li:document:[a-zA-Z0-9_-]+$/;

export interface LinkedInOptions {
  readonly auth: {
    readonly accessToken: string;
    readonly author: `urn:li:person:${string}` | `urn:li:organization:${string}`;
  };
  /** Explicit monthly API version, for example 202609. Upgrade after reviewing LinkedIn's migration notes. */
  readonly apiVersion: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
  /** App client secret that LinkedIn uses to sign webhook deliveries (`X-LI-Signature`). */
  readonly webhookSecret?: string;
}

export interface LinkedInTimeInterval {
  readonly granularity: "DAY" | "WEEK" | "MONTH";
  readonly start?: number;
  readonly end?: number;
}

export interface LinkedInFollowerBreakdown {
  readonly dimension:
    | "function"
    | "seniority"
    | "industry"
    | "geo"
    | "geoCountry"
    | "staffCountRange"
    | "associationType";
  readonly value: string;
  readonly organicFollowerCount?: number | undefined;
  readonly paidFollowerCount?: number | undefined;
}

export interface LinkedInFollowerStatistics {
  readonly organization: string;
  readonly interval?: LinkedInTimeInterval | undefined;
  readonly organicFollowerGain?: number | undefined;
  readonly paidFollowerGain?: number | undefined;
  readonly breakdowns: readonly LinkedInFollowerBreakdown[];
}

export interface LinkedInPageStatistics {
  readonly organization: string;
  readonly interval?: LinkedInTimeInterval | undefined;
  readonly views: Readonly<Record<string, number>>;
  readonly clicks: Readonly<Record<string, number>>;
  readonly breakdowns: {
    readonly dimension: string;
    readonly value: string;
    readonly views: Readonly<Record<string, number>>;
    readonly clicks: Readonly<Record<string, number>>;
  }[];
}

export interface LinkedInShareStatistics {
  readonly organization: string;
  readonly interval?: LinkedInTimeInterval | undefined;
  readonly metrics: Readonly<Record<string, number>>;
}

export interface LinkedInNative {
  readonly imageStatus: (ref: MediaRef, context: AdapterOperationContext) => Promise<JsonObject>;
  /**
   * Reads one uploaded video's owner and processing status with a single GET. Call it again later
   * while the status is PROCESSING or WAITING_UPLOAD, or use `waitForVideo`. Other methods never
   * poll on their own.
   */
  readonly videoStatus: (ref: MediaRef, context: AdapterOperationContext) => Promise<JsonObject>;
  /**
   * Opt-in bounded wait for one uploaded video. Reads the status like `videoStatus`, and while it is
   * PROCESSING or WAITING_UPLOAD waits `intervalMs` and reads again, up to `maxChecks` reads. It
   * stops early when the next wait would exceed the context's elapsed budget, and throws
   * `cancelled` when the context signal aborts. Returns the last status it read, which may still be
   * PROCESSING; it never throws for slow processing and never creates a post.
   */
  readonly waitForVideo: (
    ref: MediaRef,
    context: AdapterOperationContext,
    options?: LinkedInVideoWaitOptions,
  ) => Promise<JsonObject>;
  /** Reads `id`, `owner` and `status` (`WAITING_UPLOAD`, `PROCESSING`, `AVAILABLE`, `PROCESSING_FAILED`). */
  readonly documentStatus: (ref: MediaRef, context: AdapterOperationContext) => Promise<JsonObject>;
  /**
   * @deprecated Upload video bytes with `social.media.upload` and check processing with
   * `videoStatus`. This method always throws `unsupported_capability`.
   */
  readonly registerVideo: (input: {
    readonly account: ConnectedAccountRef;
    readonly byteSize: number;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly createPoll: (input: {
    readonly account: ConnectedAccountRef;
    readonly text: string;
    readonly options: readonly string[];
    readonly duration?: "ONE_DAY" | "THREE_DAYS" | "SEVEN_DAYS" | "FOURTEEN_DAYS";
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly react: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly reaction: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly reshare: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly updatePost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly body: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly deletePost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /**
   * Deletes a comment with the Comments API. `postId` is the share or ugcPost URN, and
   * `commentId` is the complete `commentUrn` from comment reads. Organization authors are sent
   * as the `actor`. LinkedIn does not document which comments an actor may delete, so expect
   * only the configured author's own comments to succeed.
   */
  readonly deleteComment: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly commentId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly organizationAnalytics: (input: {
    readonly account: ConnectedAccountRef;
    readonly query?: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly getOrganizationFollowerStatistics: (input: {
    readonly account: ConnectedAccountRef;
    readonly interval?: LinkedInTimeInterval;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly LinkedInFollowerStatistics[]>;
  readonly getOrganizationPageStatistics: (input: {
    readonly account: ConnectedAccountRef;
    readonly interval?: LinkedInTimeInterval;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly LinkedInPageStatistics[]>;
  readonly getOrganizationShareStatistics: (input: {
    readonly account: ConnectedAccountRef;
    readonly interval?: LinkedInTimeInterval;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly LinkedInShareStatistics[]>;
  readonly getOrganizationFollowerCount: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<number | undefined>;
}

/*
 * Videos API, accessed 2026-09-24:
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-09
 * Feed video is MP4, 75 KB to 500 MB and 3 seconds to 30 minutes. initializeUpload returns
 * contiguous part instructions of up to 4,194,304 bytes; each part's ETag is passed to finalizeUpload.
 * Posts API video content, accessed 2026-09-24:
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-09
 */
const linkedInVideoPartBytes = 4 * 1024 * 1024;

const linkedInVideoMinBytes = 75_000;

const linkedInVideoMaxBytes = 500 * 1024 * 1024;

const linkedInVideoUrn = /^urn:li:video:[a-zA-Z0-9_-]+$/;

const linkedInImageUrn = /^urn:li:image:[a-zA-Z0-9_-]+$/;

/* LinkedIn documents no processing time or polling interval; these bounds are the SDK's own. */
const linkedInVideoRetryDelayMs = 5_000;

const linkedInVideoWaitDefaults = { intervalMs: 5_000, maxChecks: 12 } as const;

const linkedInVideoWaitLimits = { minIntervalMs: 1_000, maxIntervalMs: 60_000, maxChecks: 60 };

export interface LinkedInVideoWaitOptions {
  /** Delay between status reads. Integer from 1,000 to 60,000 ms; defaults to 5,000. */
  readonly intervalMs?: number;
  /** Maximum status reads, including the first. Integer from 1 to 60; defaults to 12. */
  readonly maxChecks?: number;
}

export function linkedin(
  options: LinkedInOptions,
): import("../core/adapter.js").SocialAdapter<LinkedInNative> {
  if (
    !options.auth.accessToken.trim() ||
    !/^urn:li:(person|organization):[a-zA-Z0-9_-]+$/.test(options.auth.author) ||
    !/^20\d{2}(0[1-9]|1[0-2])$/.test(options.apiVersion)
  ) {
    throw new SocialError({
      code: "invalid_config",
      operation: "createAdapter",
      message:
        "Provide a LinkedIn access token, member/organization author URN and explicit YYYYMM API version.",
    });
  }

  const http = createHttp(options.fetch ? { fetch: options.fetch } : {});

  const now = () => (options.clock?.() ?? new Date()).toISOString();

  const escapeCommentary = (text: string) => text.replace(/[|{}@()[\]<>#\\*_~]/g, "\\$&");

  const authorize = (
    ref: { backend: string; platform: string; accountId: string },
    context: AdapterOperationContext,
  ) => {
    if (
      ref.backend !== context.backendInstance ||
      ref.platform !== "linkedin" ||
      ref.accountId !== options.auth.author
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "linkedin",
        message: "Reference does not belong to this LinkedIn author authorization.",
      });
  };

  async function request(
    path: string,
    context: AdapterOperationContext,
    body?: JsonObject,
    selectedHeaders?: readonly string[],
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = body === undefined ? "GET" : "POST",
    extraHeaders?: HeadersInit,
  ) {
    try {
      return await http({
        timeoutMs: remainingBudget(context),
        url: new URL(`https://api.linkedin.com${path}`),
        headers: {
          Authorization: `Bearer ${options.auth.accessToken}`,
          "Content-Type": "application/json",
          "Linkedin-Version": options.apiVersion,
          "X-Restli-Protocol-Version": "2.0.0",
          ...extraHeaders,
        },
        method,
        ...definedFields({
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: context.signal,
          responseHeaders: selectedHeaders,
        }),
        maxAttempts: method === "GET" ? Math.min(5, context.retryBudget.maxAttempts) : 1,
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      const ambiguous =
        body !== undefined &&
        error.dispatched &&
        (error.kind !== "http" || (error.status ?? 0) >= 500);

      throw new SocialError({
        code: ambiguous
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
                      : "upstream_failure",
        operation: path,
        message: error.message,
        upstreamStatus: error.status,
        retryDisposition: ambiguous
          ? { kind: "reconcile-first" }
          : error.status === 429 && error.retryAfterMs !== undefined
            ? { kind: "after-delay", delayMs: error.retryAfterMs }
            : { kind: "never" },
      });
    }
  }

  async function readPost(ref: PlatformPostRef, context: AdapterOperationContext) {
    authorize(ref, context);

    const result = object(await request(`/rest/posts/${encodeURIComponent(ref.postId)}`, context));

    if (result["author"] !== ref.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation: "posts.read",
        message: "LinkedIn post belongs to a different author.",
      });

    return result;
  }

  async function readCommentablePost(ref: PlatformPostRef, context: AdapterOperationContext) {
    authorize(ref, context);

    const result = object(await request(`/rest/posts/${encodeURIComponent(ref.postId)}`, context));

    if (result["id"] !== undefined && result["id"] !== ref.postId)
      throw new SocialError({
        code: "unauthorized",
        operation: "comments.write",
        message: "LinkedIn returned a different post than the declared parent.",
      });

    return result;
  }

  async function uploadImage(
    media: MediaAttachment,
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<MediaRef> {
    authorize(account, context);

    const source = media.source;

    if (
      media.kind !== "image" ||
      !["image/jpeg", "image/png", "image/gif"].includes(media.mimeType ?? "") ||
      (source.kind !== "blob" && source.kind !== "stream")
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: "Provide JPEG, PNG or GIF bytes as a Blob or replayable stream.",
      });

    const initialized = object(
      object(
        await request("/rest/images?action=initializeUpload", context, {
          initializeUploadRequest: { owner: account.accountId },
        }),
      )["value"],
    );

    const mediaId = string(initialized["image"]);

    if (!/^urn:li:image:[a-zA-Z0-9_-]+$/.test(mediaId))
      throw new SocialError({
        code: "media_error",
        operation: "media.upload",
        message: "LinkedIn returned an invalid image identifier.",
      });

    const size = media.byteSize ?? (source.kind === "blob" ? source.blob.size : undefined);

    await upload({
      url: string(initialized["uploadUrl"]),
      source: {
        mimeType: media.mimeType!,
        ...definedFields({ size }),
        open: source.kind === "blob" ? () => source.blob.stream() : source.open,
      },
      allowHost: (host) => host === "www.linkedin.com",
      maxBytes: 20 * 1024 * 1024,
      ...definedFields({ fetch: options.fetch, signal: context.signal }),
    });

    return {
      kind: "media",
      version: 1,
      backend: account.backend,
      platform: "linkedin",
      accountId: account.accountId,
      mediaId,
    };
  }

  function videoPartError(error: HttpError, part: number): SocialError {
    if (error.kind === "cancelled")
      return new SocialError({
        code: "cancelled",
        operation: "media.upload",
        message: `LinkedIn video part ${part} upload was cancelled. No post was created.`,
      });

    if (error.kind === "timeout")
      return new SocialError({
        code: "timeout",
        operation: "media.upload",
        message: `LinkedIn video part ${part} upload exceeded its elapsed budget. No post was created.`,
        retryDisposition: { kind: "never" },
      });

    if (error.status === 429)
      return new SocialError({
        code: "rate_limited",
        operation: "media.upload",
        message: `LinkedIn rate limited video part ${part}. No post was created.`,
        upstreamStatus: error.status,
        retryDisposition:
          error.retryAfterMs === undefined
            ? { kind: "never" }
            : { kind: "after-delay", delayMs: error.retryAfterMs },
      });

    return new SocialError({
      code: "media_error",
      operation: "media.upload",
      message:
        error.status === 401
          ? `LinkedIn rejected video part ${part} because its upload URL expired. Start a new upload.`
          : `LinkedIn did not accept video part ${part}. Start a new upload; no post was created.`,
      upstreamStatus: error.status,
      retryDisposition: { kind: "never" },
    });
  }

  /** Reads one video's public status fields with a single GET after checking the grant and owner. */
  async function readVideoStatus(ref: MediaRef, context: AdapterOperationContext) {
    authorize(ref, context);

    if (!linkedInVideoUrn.test(ref.mediaId))
      throw new SocialError({
        code: "invalid_input",
        operation: "media.read",
        message: "Use the urn:li:video reference returned by media.upload.",
      });

    const video = object(await request(`/rest/videos/${encodeURIComponent(ref.mediaId)}`, context));

    if (video["owner"] !== ref.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation: "media.read",
        message: "LinkedIn video belongs to another author.",
      });

    return publicFields(video, ["id", "owner", "status", "processingFailureReason", "duration"]);
  }

  function videoWaitCancelled(): SocialError {
    return new SocialError({
      code: "cancelled",
      operation: "media.read",
      message: "Waiting for the LinkedIn video was cancelled. No post was created.",
    });
  }

  /** Remaining elapsed budget in milliseconds, or 0 once it is exhausted. */
  function budgetLeft(context: AdapterOperationContext): number {
    try {
      return remainingBudget(context);
    } catch {
      return 0;
    }
  }

  /** Sleeps between explicit waitForVideo reads and rejects as soon as the context aborts. */
  function videoWaitDelay(milliseconds: number, context: AdapterOperationContext): Promise<void> {
    if (context.signal?.aborted) return Promise.reject(videoWaitCancelled());

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(videoWaitCancelled());
      };

      const timer = setTimeout(() => {
        context.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);

      context.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Initializes, uploads every part and finalizes one video. It never waits for processing. */
  async function uploadVideo(
    media: MediaAttachment,
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<MediaRef> {
    authorize(account, context);
    const source = media.source;

    if (media.mimeType !== "video/mp4" || source.kind !== "blob")
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: "Provide one MP4 video as a Blob with mimeType video/mp4.",
      });

    if (media.thumbnail !== undefined)
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: "LinkedIn video thumbnails are not implemented by this adapter.",
      });

    const blob = source.blob;

    if (
      (media.byteSize !== undefined && media.byteSize !== blob.size) ||
      blob.size < linkedInVideoMinBytes ||
      blob.size > linkedInVideoMaxBytes
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message:
          "LinkedIn feed video must be 75 KB to 500 MB, and byteSize must match the Blob size.",
      });

    if (
      media.durationSeconds !== undefined &&
      (!Number.isFinite(media.durationSeconds) ||
        media.durationSeconds < 3 ||
        media.durationSeconds > 1800)
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: "LinkedIn feed video must be 3 seconds to 30 minutes long.",
      });

    try {
      const initialized = object(
        object(
          await request("/rest/videos?action=initializeUpload", context, {
            initializeUploadRequest: {
              owner: account.accountId,
              fileSizeBytes: blob.size,
              uploadCaptions: false,
              uploadThumbnail: false,
            },
          }),
        )["value"],
      );

      const mediaId = string(initialized["video"]);
      // LinkedIn documents an empty upload token for some sessions, so only its type is checked.
      const uploadToken = optionalString(initialized["uploadToken"]);

      const parts = array(initialized["uploadInstructions"]).map((value) => {
        const part = object(value);

        return {
          url: string(part["uploadUrl"]),
          firstByte: optionalNumber(part["firstByte"]),
          lastByte: optionalNumber(part["lastByte"]),
        };
      });

      let nextByte = 0;
      const plan: { url: string; firstByte: number; lastByte: number }[] = [];

      for (const part of parts) {
        const { firstByte, lastByte } = part;

        if (
          firstByte !== nextByte ||
          lastByte === undefined ||
          !Number.isSafeInteger(lastByte) ||
          lastByte < firstByte ||
          lastByte - firstByte + 1 > linkedInVideoPartBytes
        )
          break;
        plan.push({ url: part.url, firstByte, lastByte });
        nextByte = lastByte + 1;
      }

      if (
        !linkedInVideoUrn.test(mediaId) ||
        uploadToken === undefined ||
        plan.length === 0 ||
        plan.length !== parts.length ||
        nextByte !== blob.size
      )
        throw new SocialError({
          code: "media_error",
          operation: "media.upload",
          message:
            "LinkedIn returned an invalid video identifier or an upload plan that does not cover the file. No bytes were sent.",
          retryDisposition: { kind: "never" },
        });

      const uploadedPartIds: string[] = [];

      for (const [index, part] of plan.entries()) {
        const body = blob.slice(part.firstByte, part.lastByte + 1);
        let result: { bytes: number; etag?: string };

        try {
          // fetch sends the Blob slice directly; the declared size lets upload() check every byte.
          result = await upload({
            url: part.url,
            source: {
              mimeType: "application/octet-stream",
              size: body.size,
              body,
              open: () => body.stream(),
            },
            allowHost: (host) => host === "www.linkedin.com",
            maxBytes: linkedInVideoPartBytes,
            timeoutMs: remainingBudget(context),
            ...definedFields({ fetch: options.fetch, signal: context.signal }),
          });
        } catch (error) {
          if (error instanceof HttpError) throw videoPartError(error, index + 1);
          throw error;
        }

        // finalizeUpload takes the ETag value without the HTTP quoting.
        const etag = result.etag?.trim().replace(/^"(.*)"$/, "$1");

        if (!etag)
          throw new SocialError({
            code: "media_error",
            operation: "media.upload",
            message: `LinkedIn accepted video part ${index + 1} without an ETag. Start a new upload.`,
            retryDisposition: { kind: "never" },
          });
        uploadedPartIds.push(etag);
      }

      await request("/rest/videos?action=finalizeUpload", context, {
        finalizeUploadRequest: { video: mediaId, uploadToken, uploadedPartIds },
      });

      return {
        kind: "media",
        version: 1,
        backend: account.backend,
        platform: "linkedin",
        accountId: account.accountId,
        mediaId,
      };
    } catch (error) {
      // Malformed upload responses fail before any post request, so no post exists.
      if (error instanceof HttpError)
        throw new SocialError({
          code: "media_error",
          operation: "media.upload",
          message: "LinkedIn returned a malformed video upload response. No post was created.",
          retryDisposition: { kind: "never" },
        });
      throw error;
    }
  }

  async function uploadDocument(
    media: MediaAttachment,
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<MediaRef> {
    authorize(account, context);
    const source = media.source;
    const size = source.kind === "blob" ? source.blob.size : media.byteSize;
    const mimeType = media.mimeType ?? "";

    if (
      media.kind !== "document" ||
      !linkedInDocumentMimeTypes.includes(mimeType) ||
      (source.kind !== "blob" && source.kind !== "stream")
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: "Provide PDF, PPT, PPTX, DOC or DOCX bytes as a Blob or replayable stream.",
      });

    if (
      (source.kind === "blob" && media.byteSize !== undefined && media.byteSize !== size) ||
      (size !== undefined &&
        (!Number.isSafeInteger(size) || size <= 0 || size > linkedInDocumentMaxBytes))
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message:
          "LinkedIn documents must be non-empty and at most 100 MB, and byteSize must match the Blob size.",
      });

    const initialized = object(
      object(
        await request("/rest/documents?action=initializeUpload", context, {
          initializeUploadRequest: { owner: account.accountId },
        }),
      )["value"],
    );

    const mediaId = string(initialized["document"]);

    if (!linkedInDocumentUrn.test(mediaId))
      throw new SocialError({
        code: "media_error",
        operation: "media.upload",
        message: "LinkedIn returned an invalid document identifier.",
      });

    let transferred: number;

    try {
      ({ bytes: transferred } = await upload({
        url: string(initialized["uploadUrl"]),
        source: {
          mimeType,
          ...definedFields({ size }),
          open: source.kind === "blob" ? () => source.blob.stream() : source.open,
        },
        allowHost: (host) => host === "www.linkedin.com",
        maxBytes: linkedInDocumentMaxBytes,
        timeoutMs: remainingBudget(context),
        ...definedFields({ fetch: options.fetch, signal: context.signal }),
      }));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      throw new SocialError({
        code:
          error.kind === "timeout"
            ? "timeout"
            : error.kind === "cancelled"
              ? "cancelled"
              : error.kind === "invalid-input"
                ? "invalid_input"
                : "media_error",
        operation: "media.upload",
        message: `LinkedIn document upload for ${mediaId} did not complete: ${error.message}`,
        upstreamStatus: error.status,
        retryDisposition: { kind: "never" },
      });
    }

    // A stream without byteSize can end empty; LinkedIn cannot publish an empty document.
    if (transferred === 0)
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: `LinkedIn document upload for ${mediaId} sent no bytes. Provide a non-empty document.`,
        retryDisposition: { kind: "never" },
      });

    return {
      kind: "media",
      version: 1,
      backend: account.backend,
      platform: "linkedin",
      accountId: account.accountId,
      mediaId,
    };
  }

  async function readDocument(ref: MediaRef, context: AdapterOperationContext, operation: string) {
    authorize(ref, context);

    if (!linkedInDocumentUrn.test(ref.mediaId))
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "Use the urn:li:document reference returned by media.upload.",
      });

    const document = object(
      await request(`/rest/documents/${encodeURIComponent(ref.mediaId)}`, context),
    );

    if (
      document["owner"] !== ref.accountId ||
      (document["id"] !== undefined && document["id"] !== ref.mediaId)
    )
      throw new SocialError({
        code: "unauthorized",
        operation,
        message: "LinkedIn document belongs to another author.",
      });

    return document;
  }

  /** The Posts API requires a title for documents; take it from caption, then filename. */
  const documentTitle = (media: MediaAttachment) =>
    media.caption?.trim() || media.filename?.trim() || "";

  const documentIssues = (target: PreparedPublishTarget): [string, string][] => {
    const media = target.content.media ?? [];

    if (!media.some((item) => item.kind === "document")) return [];
    const issues: [string, string][] = [];

    if (media.length !== 1)
      issues.push([
        "linkedin.document_count",
        "A LinkedIn document post carries exactly one document and no other media.",
      ]);

    for (const item of media) {
      if (item.kind !== "document") continue;

      if (item.source.kind !== "media-ref")
        issues.push([
          "linkedin.document",
          "Upload the document first with media.upload, then publish its account-bound reference.",
        ]);
      else if (
        item.source.ref.backend !== target.account.backend ||
        item.source.ref.accountId !== target.account.accountId ||
        item.source.ref.platform !== "linkedin" ||
        !linkedInDocumentUrn.test(item.source.ref.mediaId)
      )
        issues.push([
          "linkedin.media_owner",
          "Document reference belongs to another author/backend or has an invalid URN.",
        ]);

      if (!documentTitle(item))
        issues.push([
          "linkedin.document_title",
          "LinkedIn requires a document title. Set caption or filename on the attachment.",
        ]);

      if (item.altText !== undefined)
        issues.push([
          "linkedin.document_alt_text",
          "LinkedIn documents have no verified alt text mapping. Remove altText.",
        ]);
    }

    return issues;
  };

  async function documentContent(
    media: MediaAttachment,
    context: AdapterOperationContext,
  ): Promise<JsonObject> {
    if (media.source.kind !== "media-ref")
      throw new SocialError({
        code: "invalid_input",
        operation: "posts.publish",
        message: "Upload the document first with media.upload.",
      });

    const document = await readDocument(media.source.ref, context, "posts.publish");

    if (document["status"] !== "AVAILABLE")
      throw new SocialError({
        code: "media_error",
        operation: "posts.publish",
        message:
          "Document is not AVAILABLE. Check its status with the native documentStatus helper before publishing.",
      });

    return { media: { id: media.source.ref.mediaId, title: documentTitle(media) } };
  }

  const organizationOnly = (
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
    operation: string,
  ) => {
    authorize(account, context);

    if (!account.accountId.startsWith("urn:li:organization:"))
      throw new SocialError({
        code: "unsupported_capability",
        operation,
        message:
          "LinkedIn organization analytics require an organization account, not a member account.",
      });
  };

  const statisticsPath = (
    path: string,
    finder: "organization" | "organizationalEntity",
    account: ConnectedAccountRef,
    interval?: LinkedInTimeInterval,
  ) => {
    const params = [`q=${finder}`, `${finder}=${encodeURIComponent(account.accountId)}`];

    if (interval) {
      if (
        interval.start !== undefined &&
        (!Number.isSafeInteger(interval.start) || interval.start < 0)
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "analytics.organization.read",
          message: "Interval start must be a nonnegative epoch-millisecond integer.",
        });

      if (interval.end !== undefined && (!Number.isSafeInteger(interval.end) || interval.end < 0))
        throw new SocialError({
          code: "invalid_input",
          operation: "analytics.organization.read",
          message: "Interval end must be a nonnegative epoch-millisecond integer.",
        });

      if (
        interval.start !== undefined &&
        interval.end !== undefined &&
        interval.end <= interval.start
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "analytics.organization.read",
          message: "Interval end must be after interval start.",
        });

      if (interval.start === undefined)
        throw new SocialError({
          code: "invalid_input",
          operation: "analytics.organization.read",
          message: "Interval start is required for time-bound organization statistics.",
        });

      const rangeParts = [
        `start:${interval.start}`,
        ...(interval.end === undefined ? [] : [`end:${interval.end}`]),
      ];

      const range = `(timeRange:(${rangeParts.join(",")}),timeGranularityType:${interval.granularity})`;

      if (!["DAY", "WEEK", "MONTH"].includes(interval.granularity))
        throw new SocialError({
          code: "invalid_input",
          operation: "analytics.organization.read",
          message: "Interval granularity must be DAY, WEEK or MONTH.",
        });
      params.push(`timeIntervals=${range}`);
    }

    return `${path}?${params.join("&")}`;
  };

  const numberMap = (value: JsonField) => {
    const row = value === undefined ? {} : object(value);

    const output: Record<string, number> = {};

    for (const [key, item] of Object.entries(row)) {
      const number = optionalNumber(item);

      if (number !== undefined) output[key] = number;
      else if (isJsonObject(item)) {
        const nestedObject = item;

        const nested = ["pageViews", "uniquePageViews", "clicks", "count"]
          .map((name) => optionalNumber(nestedObject[name]))
          .find((candidate) => candidate !== undefined);

        if (nested !== undefined) output[key] = nested;
        else {
          for (const [nestedKey, nestedValue] of Object.entries(nestedObject)) {
            const nestedNumber = optionalNumber(nestedValue);

            if (nestedNumber !== undefined) output[`${key}.${nestedKey}`] = nestedNumber;
          }
        }
      }
    }

    return output;
  };

  const followerBreakdowns = (row: JsonObject): LinkedInFollowerBreakdown[] => {
    const dimensions = [
      ["function", "followerCountsByFunction", "function"],
      ["seniority", "followerCountsBySeniority", "seniority"],
      ["industry", "followerCountsByIndustry", "industry"],
      ["geo", "followerCountsByGeo", "geo"],
      ["geoCountry", "followerCountsByGeoCountry", "geo"],
      ["staffCountRange", "followerCountsByStaffCountRange", "staffCountRange"],
      ["associationType", "followerCountsByAssociationType", "associationType"],
    ] as const;

    const output: LinkedInFollowerBreakdown[] = [];

    for (const [dimension, field, key] of dimensions) {
      if (row[field] === undefined) continue;

      for (const value of array(row[field])) {
        const item = object(value);

        const label = optionalString(item[key]);

        if (!label) continue;

        const counts = item["followerCounts"] === undefined ? {} : object(item["followerCounts"]);
        output.push({
          dimension,
          value: label,
          ...definedFields({
            organicFollowerCount: optionalNumber(counts["organicFollowerCount"]),
            paidFollowerCount: optionalNumber(counts["paidFollowerCount"]),
          }),
        });
      }
    }

    return output;
  };

  const parseInterval = (
    row: JsonObject,
    requestedGranularity?: LinkedInTimeInterval["granularity"],
  ): LinkedInTimeInterval | undefined => {
    if (row["timeRange"] === undefined) return undefined;

    const range = object(row["timeRange"]);

    const start = optionalNumber(range["start"]);

    const end = optionalNumber(range["end"]);

    const granularity = requestedGranularity ?? optionalString(row["timeGranularityType"]);

    if (
      (granularity !== "DAY" && granularity !== "WEEK" && granularity !== "MONTH") ||
      (start === undefined && end === undefined)
    )
      return undefined;

    return { granularity, ...definedFields({ start, end }) };
  };

  const parseFollowerStatistics = (
    result: JsonObject,
    requestedGranularity?: LinkedInTimeInterval["granularity"],
  ): LinkedInFollowerStatistics[] =>
    array(result["elements"]).map((value) => {
      const row = object(value);

      const gains = row["followerGains"] === undefined ? {} : object(row["followerGains"]);

      return {
        organization: string(row["organizationalEntity"]),
        ...definedFields({
          interval: parseInterval(row, requestedGranularity),
          organicFollowerGain: optionalNumber(gains["organicFollowerGain"]),
          paidFollowerGain: optionalNumber(gains["paidFollowerGain"]),
        }),
        breakdowns: followerBreakdowns(row),
      };
    });

  const pageBreakdowns = (row: JsonObject) => {
    const output: LinkedInPageStatistics["breakdowns"] = [];

    for (const [field, dimension, key] of [
      ["pageStatisticsByFunction", "function", "function"],
      ["pageStatisticsBySeniority", "seniority", "seniority"],
      ["pageStatisticsByIndustryV2", "industryV2", "industryV2"],
      ["pageStatisticsByIndustry", "industry", "industry"],
      ["pageStatisticsByGeo", "geo", "geo"],
      ["pageStatisticsByGeoCountry", "geoCountry", "geo"],
      ["pageStatisticsByStaffCountRange", "staffCountRange", "staffCountRange"],
    ] as const) {
      if (row[field] === undefined) continue;

      for (const value of array(row[field])) {
        const item = object(value);

        const label = optionalString(item[key]);

        if (!label) continue;

        const stats = item["pageStatistics"] === undefined ? {} : object(item["pageStatistics"]);

        const views = stats["views"] === undefined ? {} : object(stats["views"]);

        const clicks = stats["clicks"] === undefined ? {} : object(stats["clicks"]);
        output.push({
          dimension,
          value: label,
          views: numberMap(views),
          clicks: numberMap(clicks),
        });
      }
    }

    return output;
  };

  const parsePageStatistics = (
    result: JsonObject,
    requestedGranularity?: LinkedInTimeInterval["granularity"],
  ): LinkedInPageStatistics[] =>
    array(result["elements"]).map((value) => {
      const row = object(value);

      const total =
        row["totalPageStatistics"] === undefined ? {} : object(row["totalPageStatistics"]);

      return {
        organization: string(row["organization"]),
        ...definedFields({ interval: parseInterval(row, requestedGranularity) }),
        views: numberMap(total["views"]),
        clicks: numberMap(total["clicks"]),
        breakdowns: pageBreakdowns(row),
      };
    });

  const parseShareStatistics = (
    result: JsonObject,
    requestedGranularity?: LinkedInTimeInterval["granularity"],
  ): LinkedInShareStatistics[] =>
    array(result["elements"]).map((value) => {
      const row = object(value);

      return {
        organization: string(row["organizationalEntity"]),
        ...definedFields({ interval: parseInterval(row, requestedGranularity) }),
        metrics: numberMap(row["totalShareStatistics"]),
      };
    });

  return defineAdapter({
    id: "linkedin",
    capabilities: {
      schemaVersion: 1 as const,
      backend: "linkedin",
      apiRevision: options.apiVersion,
      runtime: ["node22", "node24", "bun"],
      capabilities: [
        {
          platform: "linkedin",
          operation: "posts.publish",
          availability: "available" as const,
          formats: [
            "text" as const,
            "image" as const,
            "carousel" as const,
            "video" as const,
            "document" as const,
          ],
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "w_organization_social"
              : "w_member_social",
          ],
          notes:
            "Explicit author URN and public visibility. Organization role and app product approval required. One registered image, 2 to 20 images, one MP4 video, or one document per post; every asset must be AVAILABLE before creating a post.",
        },
        {
          platform: "linkedin",
          operation: "posts.read",
          availability: "available" as const,
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "r_organization_social"
              : "r_member_social",
          ],
          notes:
            "Member read access is restricted. Publication permission does not grant read permission.",
        },
        {
          platform: "linkedin",
          operation: "posts.multi-image",
          availability: "available" as const,
          formats: ["carousel" as const],
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "w_organization_social"
              : "w_member_social",
          ],
          notes:
            "Publishes 2 to 20 registered images through posts.publish as organic MultiImage content. Every image must be owned by the author and AVAILABLE. Sponsored multi-image posts are not supported.",
        },
        {
          platform: "linkedin",
          operation: "posts.video",
          availability: "available" as const,
          formats: ["video" as const],
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "w_organization_social"
              : "w_member_social",
          ],
          notes:
            "Upload one MP4 Blob (75 KB to 500 MB, 3 seconds to 30 minutes) with media.upload, then publish the video URN once it is AVAILABLE. Check processing with native videoStatus (one read) or the opt-in native waitForVideo (bounded reads within the operation budget). Publishing reads the status once and never waits; a processing video fails with no post created. The attachment caption becomes the optional video title.",
        },
        {
          platform: "linkedin",
          operation: "posts.document",
          availability: "available" as const,
          formats: ["document" as const],
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "w_organization_social"
              : "w_member_social",
          ],
          notes:
            "One PDF, PPT, PPTX, DOC or DOCX file up to 100 MB and 300 pages, uploaded through the Documents API. LinkedIn enforces the page limit during processing. Requires a title and AVAILABLE status.",
        },
        { platform: "linkedin", operation: "polls.create", availability: "available" as const },
        { platform: "linkedin", operation: "reactions.write", availability: "available" as const },
        { platform: "linkedin", operation: "reshares.write", availability: "available" as const },
        { platform: "linkedin", operation: "posts.update", availability: "available" as const },
        { platform: "linkedin", operation: "posts.delete", availability: "available" as const },
        {
          platform: "linkedin",
          operation: "posts.removeFromPlatform",
          availability: "available" as const,
        },
        {
          platform: "linkedin",
          operation: "comments.delete",
          availability: "available" as const,
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "w_organization_social"
              : "w_member_social",
          ],
          notes:
            "Native deleteComment needs the post URN and the complete commentUrn. LinkedIn does not document which comments an actor may delete; expect only the configured author's own comments to succeed.",
        },
        {
          platform: "linkedin",
          operation: "analytics.organization.read",
          availability: options.auth.author.startsWith("urn:li:organization:")
            ? ("available" as const)
            : ("account-ineligible" as const),
          requiredScopes: ["rw_organization_admin"],
          notes:
            "Requires the Community Management API product and organization administrator access. Member accounts are not eligible.",
        },
        {
          platform: "linkedin",
          operation: "articles.create",
          availability: "approval-dependent" as const,
        },
        {
          platform: "linkedin",
          operation: "messages.write",
          availability: "unsupported-by-platform" as const,
        },
        {
          platform: "linkedin",
          operation: "webhooks.verify",
          availability: "approval-dependent" as const,
          requiredScopes: ["rw_organization_admin"],
          notes:
            "LinkedIn enables webhooks only for apps with an approved webhook use case. Organization social action notifications also need the Community Management API and an organization administrator. Verifies X-LI-Signature (HMAC-SHA256 over hmacsha256= plus the raw body) with the app client secret; answer the GET validation with answerLinkedInWebhookChallenge.",
        },
        {
          platform: "linkedin",
          operation: "analytics.account.read",
          availability: options.auth.author.startsWith("urn:li:organization:")
            ? ("available" as const)
            : ("account-ineligible" as const),
          requiredScopes: ["rw_organization_admin"],
          notes:
            "Organization total followers only; authenticated member must administer the organization. No member-profile analytics claimed.",
        },
        ...["analytics.followers.read", "analytics.page.read", "analytics.shares.read"].map(
          (operation) => ({
            platform: "linkedin" as const,
            operation,
            availability: options.auth.author.startsWith("urn:li:organization:")
              ? ("available" as const)
              : ("account-ineligible" as const),
            requiredScopes: ["rw_organization_admin"],
            notes:
              "Community Management API product and organization administrator access are required. Member accounts are not eligible.",
          }),
        ),
        {
          platform: "linkedin",
          operation: "posts.list",
          availability: "available" as const,
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "r_organization_social"
              : "r_member_social",
          ],
          notes: "Author-feed pagination uses the returned offset cursor.",
        },
        {
          platform: "linkedin",
          operation: "media.upload",
          availability: "available" as const,
          formats: ["image" as const, "video" as const, "document" as const],
        },
        ...["comments.read", "comments.write", "analytics.read"].map((operation) => ({
          platform: "linkedin" as const,
          operation,
          availability: "available" as const,
          ...(operation === "analytics.read"
            ? { requiredScopes: ["r_member_social"] }
            : { requiredScopes: ["w_member_social", "r_member_social"] }),
          notes:
            "Community Management product permissions and author post read access required. Analytics contains returned social-action counts only.",
        })),
      ],
    },
    media: {
      upload: (
        media: MediaAttachment,
        account: ConnectedAccountRef,
        context: AdapterOperationContext,
      ) =>
        media.kind === "video"
          ? uploadVideo(media, account, context)
          : media.kind === "document"
            ? uploadDocument(media, account, context)
            : uploadImage(media, account, context),
    },
    posts: {
      prepareTarget(target: PreparedPublishTarget) {
        const issues: { code: string; message: string; severity: "error"; targetIndex: number }[] =
          [];

        const fail = (code: string, message: string) =>
          issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

        if (
          target.account.platform !== "linkedin" ||
          target.account.accountId !== options.auth.author
        )
          fail("linkedin.author", "Select the configured member or organization author URN.");

        if ((target.content.text?.length ?? 0) > 3000)
          fail("linkedin.text", "LinkedIn commentary exceeds 3,000 characters.");

        if (target.schedule || target.replyTo || target.content.link)
          fail(
            "linkedin.operation",
            "Scheduling, reply posts and structured links are not supported by this publishing slice.",
          );

        const settings = optionsObject(target);

        if (
          Object.keys(settings).some((key) => key !== "visibility") ||
          (settings["visibility"] !== undefined && settings["visibility"] !== "public")
        )
          fail(
            "linkedin.options",
            "This slice supports public visibility only; other native options require explicit implementation.",
          );

        const media = target.content.media ?? [];

        for (const [code, message] of documentIssues(target)) fail(code, message);

        // A MultiImage post takes 2 to 20 images; alt text is at most 4,086 characters.
        // A video post carries exactly one video and cannot be mixed with images.
        if (media.length > 20)
          fail(
            "linkedin.media_count",
            "LinkedIn accepts one image, one video, or a multi-image post of 2 to 20 images.",
          );

        if (media.length > 1 && media.some((item) => item.kind === "video"))
          fail(
            "linkedin.media_count",
            "A LinkedIn video post carries exactly one video and cannot be combined with other media.",
          );

        for (const item of media) {
          if (media.length > 1 && (item.altText?.length ?? 0) > 4086)
            fail("linkedin.alt_text", "LinkedIn multi-image alt text exceeds 4,086 characters.");

          if (item.kind === "document") continue;

          if ((item.kind !== "image" && item.kind !== "video") || item.source.kind !== "media-ref")
            fail(
              "linkedin.media",
              "Upload an image or video first with media.upload, then publish its account-bound reference.",
            );
          else if (
            item.source.ref.backend !== target.account.backend ||
            item.source.ref.accountId !== target.account.accountId ||
            item.source.ref.platform !== "linkedin" ||
            !(item.kind === "video" ? linkedInVideoUrn : linkedInImageUrn).test(
              item.source.ref.mediaId,
            )
          )
            fail(
              "linkedin.media_owner",
              "Media reference belongs to another author/backend or has an invalid URN for its kind.",
            );
          else if (item.kind === "video" && item.altText !== undefined)
            fail("linkedin.video_alt_text", "LinkedIn video posts do not accept alt text.");
        }

        return issues;
      },
      async publishTarget(target: PreparedPublishTarget, context: AdapterOperationContext) {
        authorize(target.account, context);
        const media = target.content.media ?? [];
        const entries: JsonObject[] = [];

        for (const item of media) {
          // Documents are read and validated by documentContent below.
          if (item.kind === "document" || item.source.kind !== "media-ref") continue;
          authorize(item.source.ref, context);

          const video = item.kind === "video";
          let image: JsonObject | undefined;

          try {
            image = object(
              await request(
                `/rest/${video ? "videos" : "images"}/${encodeURIComponent(item.source.ref.mediaId)}`,
                context,
              ),
            );
          } catch (error) {
            // Only image reads keep the member-token 403 exception. A video must prove AVAILABLE.
            if (
              video ||
              !(error instanceof SocialError) ||
              error.code !== "missing_permission" ||
              !options.auth.author.startsWith("urn:li:person:")
            )
              throw error;
          }

          if (image?.["owner"] !== undefined && image["owner"] !== target.account.accountId)
            throw new SocialError({
              code: "unauthorized",
              operation: "posts.publish",
              message: `LinkedIn ${video ? "video" : "image"} belongs to a different author.`,
            });

          if (video && image?.["status"] === "PROCESSING_FAILED")
            throw new SocialError({
              code: "media_error",
              operation: "posts.publish",
              message:
                "LinkedIn could not process this video. Upload it again; no post was created.",
              retryDisposition: { kind: "never" },
            });

          if (
            video &&
            (image?.["status"] === "PROCESSING" || image?.["status"] === "WAITING_UPLOAD")
          )
            // No post exists yet, so publishing again later is safe. The SDK does not retry.
            throw new SocialError({
              code: "media_error",
              operation: "posts.publish",
              message:
                "Video is still processing; no post was created. Wait with native waitForVideo or check videoStatus, then publish again.",
              retryDisposition: { kind: "after-delay", delayMs: linkedInVideoRetryDelayMs },
            });

          if (
            video
              ? image?.["status"] !== "AVAILABLE"
              : image?.["status"] !== undefined && image["status"] !== "AVAILABLE"
          )
            throw new SocialError({
              code: "media_error",
              operation: "posts.publish",
              message: video
                ? "Video is not AVAILABLE. Check it with native videoStatus before publishing."
                : "Image is not AVAILABLE. Check its status explicitly before publishing.",
            });
          // Posts API media.title is optional for video and required only for documents.
          const title = video ? item.caption?.trim() : undefined;
          entries.push({
            id: item.source.ref.mediaId,
            ...definedFields({
              title: title || undefined,
              altText: video ? undefined : item.altText || undefined,
            }),
          });
        }

        // MultiImage content takes 2 to 20 image URNs. Source (accessed 2026-09-24):
        // https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api?view=li-lms-2026-09
        // A single image or video uses content.media; a document post carries only its document.
        const document = media.find((item) => item.kind === "document");
        let content: JsonObject | undefined;

        if (document) content = await documentContent(document, context);
        else if (entries.length > 1) content = { multiImage: { images: entries } };
        else if (entries[0] !== undefined) content = { media: entries[0] };

        const result = object(
          await request(
            "/rest/posts",
            context,
            {
              author: target.account.accountId,
              commentary: escapeCommentary(target.content.text ?? ""),
              visibility: "PUBLIC",
              distribution: {
                feedDistribution: "MAIN_FEED",
                targetEntities: [],
                thirdPartyDistributionChannels: [],
              },
              lifecycleState: "PUBLISHED",
              isReshareDisabledByAuthor: false,
              ...definedFields({ content }),
            },
            ["x-restli-id"],
          ),
        );

        const id = optionalString(object(result["headers"])["x-restli-id"]);

        const base = {
          account: target.account,
          targetIndex: target.targetIndex,
          observedAt: now(),
        };

        if (!id || !/^urn:li:(share|ugcPost):[0-9]+$/.test(id))
          return {
            ...base,
            state: "unknown" as const,
            reason: "unmapped-state" as const,
            diagnostic:
              "LinkedIn accepted the create request without a valid native post identifier. Do not repeat it automatically.",
          };

        return {
          ...base,
          state: "published" as const,
          post: {
            kind: "platform-post" as const,
            version: 1 as const,
            backend: target.account.backend,
            platform: "linkedin",
            accountId: target.account.accountId,
            postId: id,
          },
        };
      },
      async get(ref: PlatformPostRef, context: AdapterOperationContext) {
        return publicFields(await readPost(ref, context), [
          "id",
          "author",
          "commentary",
          "visibility",
          "lifecycleState",
          "createdAt",
          "lastModifiedAt",
        ]);
      },
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        authorize(account, context);

        const start = input.cursor === undefined ? 0 : Number(input.cursor);

        const count = input.limit ?? 25;

        if (
          !Number.isSafeInteger(start) ||
          start < 0 ||
          input.cursor === "" ||
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > 100
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.read",
            message: "LinkedIn requires a nonnegative offset and page size from 1 to 100.",
          });

        const result = object(
          await request(
            `/rest/posts?q=author&author=${encodeURIComponent(options.auth.author)}&start=${start}&count=${count}&sortBy=LAST_MODIFIED`,
            context,
          ),
        );

        const rows = array(result["elements"]).map(object);

        if (rows.some((row) => row["author"] !== options.auth.author))
          throw new SocialError({
            code: "unauthorized",
            operation: "posts.read",
            message: "LinkedIn returned a post from another author.",
          });

        const items = rows.map((row) =>
          publicFields(row, [
            "id",
            "author",
            "commentary",
            "visibility",
            "lifecycleState",
            "createdAt",
            "lastModifiedAt",
          ]),
        );

        const paging = result["paging"] === undefined ? {} : object(result["paging"]);

        const total = optionalNumber(paging["total"]);

        const hasNext = array(paging["links"] ?? []).some((link) => object(link)["rel"] === "next");

        const nextCursor =
          items.length > 0 && (hasNext || (total !== undefined && start + items.length < total))
            ? String(start + items.length)
            : undefined;

        return { items, ...definedFields({ nextCursor }) };
      },
      async removeFromPlatform(ref: PlatformPostRef, context: AdapterOperationContext) {
        authorize(ref, context);

        await request(
          `/rest/posts/${encodeURIComponent(ref.postId)}`,
          context,
          undefined,
          undefined,
          "DELETE",
        );
      },
    },
    comments: {
      async list(
        ref: PlatformPostRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        await readPost(ref, context);

        const start = input.cursor === undefined ? 0 : Number(input.cursor);

        const count = input.limit ?? 25;

        if (
          !Number.isSafeInteger(start) ||
          start < 0 ||
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > 100
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.read",
            message:
              "LinkedIn comment pagination requires a returned offset and a page size from 1 to 100.",
          });

        const result = object(
          await request(
            `/rest/socialActions/${encodeURIComponent(ref.postId)}/comments?start=${start}&count=${count}`,
            context,
          ),
        );

        const items = array(result["elements"]).map((value) => {
          const row = object(value);

          return {
            ...publicFields(row, ["id", "actor", "commentUrn", "object"]),
            text: string(object(row["message"])["text"]),
          };
        });

        const paging = result["paging"] === undefined ? {} : object(result["paging"]);

        const total = optionalNumber(paging["total"]);

        const next =
          total !== undefined && start + items.length < total
            ? String(start + items.length)
            : undefined;

        return { items, ...definedFields({ nextCursor: next }) };
      },
      async reply(
        ref: CommentRef,
        content: { text: string },
        context: AdapterOperationContext,
      ): Promise<CommentRef> {
        if (!content.text.trim() || content.text.length > 1250)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.write",
            message: "Provide a comment of 1 to 1,250 characters.",
          });

        await readCommentablePost({ ...ref, kind: "platform-post" }, context);

        const match = /^urn:li:comment:\(urn:li:activity:(\d+),(\d+)\)$/.exec(ref.commentId);

        if (!match)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.write",
            message: "Use the complete commentUrn returned by LinkedIn comment reads.",
          });

        const parent = object(
          await request(
            `/rest/socialActions/${encodeURIComponent(ref.postId)}/comments/${match[2]}`,
            context,
          ),
        );

        if (parent["commentUrn"] !== ref.commentId)
          throw new SocialError({
            code: "unauthorized",
            operation: "comments.write",
            message: "Comment does not belong to the supplied post.",
          });

        const parentObject = optionalString(parent["object"]);

        if (
          parentObject !== undefined &&
          parentObject !== ref.postId &&
          parentObject !== `urn:li:activity:${match[1]}`
        )
          throw new SocialError({
            code: "unauthorized",
            operation: "comments.write",
            message: "Comment parent object does not match the supplied post.",
          });

        const response = object(
          await request(
            `/rest/socialActions/${encodeURIComponent(ref.commentId)}/comments`,
            context,
            {
              actor: ref.accountId,
              message: { text: content.text },
              object: ref.postId,
              parentComment: ref.commentId,
            },
          ),
        );

        const commentId = optionalString(response["commentUrn"]);

        if (!commentId)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "comments.write",
            message:
              "LinkedIn accepted the comment without returning its composite URN. Reconcile before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return { ...ref, commentId };
      },
    },
    analytics: {
      async getAccountMetrics(
        account: ConnectedAccountRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        authorize(account, context);

        if (!options.auth.author.startsWith("urn:li:organization:"))
          throw new SocialError({
            code: "unsupported_capability",
            operation: "analytics.account.read",
            message:
              "LinkedIn organization follower counts require an organization author and administrator access.",
          });

        const response = object(
          await request(
            `/rest/networkSizes/${encodeURIComponent(options.auth.author)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`,
            context,
          ),
        );

        const value = optionalNumber(response["firstDegreeSize"]);

        return value === undefined
          ? []
          : [
              {
                name: "followers",
                value,
                unit: "count",
                period: "lifetime",
                fetchedAt: now(),
                freshness: "unknown",
                source: `linkedin:${options.apiVersion}:networkSizes`,
              },
            ];
      },
      async getPostMetrics(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        await readPost(ref, context);

        const result = object(
          await request(`/rest/socialActions/${encodeURIComponent(ref.postId)}`, context),
        );

        if (result["target"] !== undefined && result["target"] !== ref.postId)
          throw new SocialError({
            code: "unauthorized",
            operation: "analytics.read",
            message: "LinkedIn returned social actions for a different post.",
          });

        const metrics: MetricValue[] = [];

        for (const [summary, field, name] of [
          ["likesSummary", "totalLikes", "likes"],
          ["commentsSummary", "totalFirstLevelComments", "comments"],
        ] as const) {
          if (result[summary] === undefined) continue;

          const value = optionalNumber(object(result[summary])[field]);

          if (value !== undefined)
            metrics.push({
              name,
              value,
              unit: "count",
              period: "lifetime",
              fetchedAt: now(),
              freshness: "unknown",
              source: `linkedin:${options.apiVersion}:socialActions`,
            });
        }

        return metrics;
      },
    },
    webhooks: directWebhooks(
      "linkedin",
      (input) => verifyLinkedInWebhook({ ...input, secret: options.webhookSecret ?? "" }),
      now,
    ),
    native: {
      async imageStatus(ref: MediaRef, context: AdapterOperationContext) {
        authorize(ref, context);

        const image = object(
          await request(`/rest/images/${encodeURIComponent(ref.mediaId)}`, context),
        );

        if (image["owner"] !== ref.accountId)
          throw new SocialError({
            code: "unauthorized",
            operation: "media.read",
            message: "LinkedIn image belongs to another author.",
          });

        return publicFields(image, ["id", "owner", "status"]);
      },
      videoStatus: readVideoStatus,
      async waitForVideo(
        ref: MediaRef,
        context: AdapterOperationContext,
        waitOptions: LinkedInVideoWaitOptions = {},
      ) {
        const intervalMs = waitOptions.intervalMs ?? linkedInVideoWaitDefaults.intervalMs;
        const maxChecks = waitOptions.maxChecks ?? linkedInVideoWaitDefaults.maxChecks;

        if (
          !Number.isInteger(intervalMs) ||
          intervalMs < linkedInVideoWaitLimits.minIntervalMs ||
          intervalMs > linkedInVideoWaitLimits.maxIntervalMs ||
          !Number.isInteger(maxChecks) ||
          maxChecks < 1 ||
          maxChecks > linkedInVideoWaitLimits.maxChecks
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "media.read",
            message:
              "waitForVideo takes an integer intervalMs from 1,000 to 60,000 and maxChecks from 1 to 60.",
          });

        let status = await readVideoStatus(ref, context);

        for (let check = 1; check < maxChecks; check++) {
          if (status["status"] !== "PROCESSING" && status["status"] !== "WAITING_UPLOAD") break;

          // Leave room for the next read; return the pending status instead of timing out.
          if (context.signal?.aborted) throw videoWaitCancelled();

          if (intervalMs >= budgetLeft(context)) break;

          await videoWaitDelay(intervalMs, context);

          // A late timer can wake after the deadline; keep the last status instead of timing out.
          if (budgetLeft(context) <= 0) break;
          status = await readVideoStatus(ref, context);
        }

        return status;
      },
      async documentStatus(ref: MediaRef, context: AdapterOperationContext) {
        return publicFields(await readDocument(ref, context, "media.read"), [
          "id",
          "owner",
          "status",
        ]);
      },
      async registerVideo({ account, context }) {
        authorize(account, context);

        throw new SocialError({
          code: "unsupported_capability",
          operation: "posts.video",
          message:
            "registerVideo is deprecated. Upload the video with media.upload and check it with videoStatus.",
        });
      },
      async createPoll({ account, text, options: pollOptions, duration = "THREE_DAYS", context }) {
        authorize(account, context);

        const result = object(
          await request(
            "/rest/posts",
            context,
            {
              author: account.accountId,
              commentary: escapeCommentary(text),
              visibility: "PUBLIC",
              distribution: {
                feedDistribution: "MAIN_FEED",
                targetEntities: [],
                thirdPartyDistributionChannels: [],
              },
              lifecycleState: "PUBLISHED",
              content: {
                poll: {
                  question: text,
                  options: pollOptions.map((option) => ({ text: option })),
                  settings: { duration },
                },
              },
            },
            ["x-restli-id"],
          ),
        );

        const id = optionalString(object(result["headers"])["x-restli-id"]);

        return id === undefined ? result : { ...result, id };
      },
      async react({ account, postId, reaction, context }) {
        authorize(account, context);

        await request(`/rest/reactions?actor=${encodeURIComponent(account.accountId)}`, context, {
          root: postId,
          reactionType: reaction,
        });
      },
      async reshare({ account, postId, context }) {
        authorize(account, context);

        const result = object(
          await request(
            "/rest/posts",
            context,
            {
              author: account.accountId,
              commentary: "",
              visibility: "PUBLIC",
              distribution: {
                feedDistribution: "MAIN_FEED",
                targetEntities: [],
                thirdPartyDistributionChannels: [],
              },
              lifecycleState: "PUBLISHED",
              reshareContext: { parent: postId },
            },
            ["x-restli-id"],
          ),
        );

        const id = optionalString(object(result["headers"])["x-restli-id"]);

        return id === undefined ? result : { ...result, id };
      },
      async updatePost({ account, postId, body, context }) {
        authorize(account, context);

        return object(
          await request(
            `/rest/posts/${encodeURIComponent(postId)}`,
            context,
            { patch: { $set: body } },
            ["x-restli-id"],
            "POST",
            { "X-RestLi-Method": "PARTIAL_UPDATE" },
          ),
        );
      },
      async deletePost({ account, postId, context }) {
        authorize(account, context);

        await request(
          `/rest/posts/${encodeURIComponent(postId)}`,
          context,
          undefined,
          undefined,
          "DELETE",
        );
      },
      async deleteComment({ account, postId, commentId, context }) {
        // Source: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api#delete-a-comment
        // (li-lms-2026-09, page updated 2026-04-28, accessed 2026-09-24).
        authorize(account, context);

        const match = /^urn:li:comment:\(urn:li:(?:activity|share|ugcPost):\d+,(\d+)\)$/.exec(
          commentId,
        );

        if (!/^urn:li:(share|ugcPost):\d+$/.test(postId) || !match)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.delete",
            message:
              "Provide the share or ugcPost URN and the complete commentUrn returned by comment reads.",
          });

        const actor = options.auth.author.startsWith("urn:li:organization:")
          ? `?actor=${encodeURIComponent(options.auth.author)}`
          : "";

        await request(
          `/rest/socialActions/${encodeURIComponent(postId)}/comments/${match[1]}${actor}`,
          context,
          undefined,
          undefined,
          "DELETE",
        );
      },
      async organizationAnalytics({ account, context }) {
        authorize(account, context);

        if (!account.accountId.startsWith("urn:li:organization:"))
          throw new SocialError({
            code: "unsupported_capability",
            operation: "analytics.organization.read",
            message: "Organization analytics requires an organization author.",
          });

        return object(
          await request(
            `/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(account.accountId)}`,
            context,
          ),
        );
      },
      async getOrganizationFollowerStatistics({ account, interval, context }) {
        organizationOnly(account, context, "analytics.followers.read");

        return parseFollowerStatistics(
          object(
            await request(
              statisticsPath(
                "/rest/organizationalEntityFollowerStatistics",
                "organizationalEntity",
                account,
                interval,
              ),
              context,
            ),
          ),
          interval?.granularity,
        );
      },
      async getOrganizationPageStatistics({ account, interval, context }) {
        organizationOnly(account, context, "analytics.page.read");

        return parsePageStatistics(
          object(
            await request(
              statisticsPath("/rest/organizationPageStatistics", "organization", account, interval),
              context,
            ),
          ),
          interval?.granularity,
        );
      },
      async getOrganizationShareStatistics({ account, interval, context }) {
        organizationOnly(account, context, "analytics.shares.read");

        return parseShareStatistics(
          object(
            await request(
              statisticsPath(
                "/rest/organizationalEntityShareStatistics",
                "organizationalEntity",
                account,
                interval,
              ),
              context,
            ),
          ),
          interval?.granularity,
        );
      },
      async getOrganizationFollowerCount({ account, context }) {
        organizationOnly(account, context, "analytics.account.read");

        const response = object(
          await request(
            `/rest/networkSizes/${encodeURIComponent(account.accountId)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`,
            context,
          ),
        );

        return optionalNumber(response["firstDegreeSize"]);
      },
    },
  });
}
