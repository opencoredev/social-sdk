import { remainingBudget } from "../transport/budget.js";
import { defineAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import type {
  AccountRecord,
  AnalyticsReport,
  AnalyticsReportQuery,
  AnalyticsReportRow,
  AdapterOperationContext,
  CommentRef,
  ConnectedAccountRef,
  DeliveryOutcome,
  JsonObject,
  JsonValue,
  MediaAttachment,
  MetricValue,
  Page,
  PlatformPostRef,
  PreparedPublishTarget,
  ScheduleCancellation,
  ScheduledJobRef,
  SearchPostsInput,
} from "../core/types.js";
import { managedHttp, optionsObject, publicFields } from "../cloud/common.js";
import { definedFields } from "../core/fields.js";
import { verifyYouTubeWebhook } from "../server/webhooks.js";
import { directWebhooks, webhookCapability } from "./webhook-adapter.js";
import { createHttp, HttpError } from "../transport/http.js";
import {
  array,
  isBoolean,
  isFiniteNumber,
  isJsonObject,
  isString,
  object,
  optionalArray,
  optionalObject,
  optionalString,
  string,
} from "../transport/validation.js";
import {
  beginYouTubeUpload,
  queryYouTubeUpload,
  sendYouTubeUpload,
  type YouTubeUploadSession,
  type YouTubeUploadStatus,
} from "./youtube-upload.js";

export interface YouTubeOptions {
  readonly auth: { readonly accessToken: string; readonly channelId: string };
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
  /** Persist secret resumable URI server-side before uploading any video bytes. */
  readonly saveUploadSession?: (session: YouTubeUploadSession) => Promise<void>;
  /** The `hub.secret` sent when subscribing to push notifications. */
  readonly webhookSecret?: string;
}

export interface YouTubeNative {
  readonly resumeUpload: (
    session: YouTubeUploadSession,
    media: MediaAttachment,
    context: AdapterOperationContext,
  ) => Promise<YouTubeUploadStatus>;
  readonly queryUpload: (
    session: YouTubeUploadSession,
    context: AdapterOperationContext,
  ) => Promise<YouTubeUploadStatus>;
  readonly setThumbnail: (input: {
    readonly videoId: string;
    readonly thumbnail: MediaAttachment;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly captions: (input: {
    readonly action: "list" | "insert" | "update" | "delete" | "download";
    readonly videoId: string;
    readonly caption?: MediaAttachment;
    readonly captionId?: string;
    readonly body?: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject | Blob>;
  readonly playlists: (input: {
    readonly action: "list" | "insert" | "update" | "delete";
    readonly playlistId?: string;
    readonly channelId?: string;
    readonly mine?: boolean;
    readonly pageToken?: string;
    readonly maxResults?: number;
    readonly body?: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly playlistItems: (input: {
    readonly action: "list" | "insert" | "update" | "delete";
    readonly playlistId?: string;
    readonly playlistItemId?: string;
    readonly body?: JsonObject;
    readonly pageToken?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly rateVideo: (input: {
    readonly videoId: string;
    readonly rating: "like" | "dislike" | "none";
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly getRating: (input: {
    readonly videoIds: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly subscriptions: (input: {
    readonly action: "list" | "insert" | "delete";
    readonly subscriptionId?: string;
    readonly channelId?: string;
    readonly pageToken?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly search: (input: {
    readonly q: string;
    readonly type?: string;
    readonly channelId?: string;
    readonly order?: string;
    readonly publishedAfter?: string;
    readonly publishedBefore?: string;
    readonly pageToken?: string;
    readonly maxResults?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly commentsModeration: (input: {
    readonly action: "setModerationStatus" | "delete" | "update";
    readonly commentId: string;
    readonly moderationStatus?: "published" | "heldForReview" | "rejected";
    readonly banAuthor?: boolean;
    readonly body?: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject | void>;
  /**
   * Deletes one comment with `comments.delete`. For a top-level comment, pass the thread's
   * `snippet.topLevelComment.id`; `commentThreads` has no delete method. Google documents a
   * 403 `forbidden` for insufficient permissions and does not list which comments a channel
   * may delete. Use `commentsModeration` with `setModerationStatus: "rejected"` to remove
   * another user's comment from your video.
   */
  readonly deleteComment: (input: {
    readonly account: ConnectedAccountRef;
    readonly commentId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly heldComments: (input: {
    readonly pageToken?: string;
    readonly maxResults?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly updateVideo: (input: {
    readonly videoId: string;
    readonly body: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly deleteVideo: (input: {
    readonly videoId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /**
   * Update the configured channel with channels.update. One part is written per call. The adapter
   * reads the current part first and merges `value` into it, because YouTube deletes any mutable
   * property omitted from the write. A `null` field removes that property or localization.
   */
  readonly updateProfile: (input: {
    readonly part: "brandingSettings" | "localizations";
    readonly value: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly analytics: (input: {
    readonly query: Record<string, string>;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly liveBroadcasts: (input: {
    readonly action: "list" | "insert" | "transition";
    readonly body?: JsonObject;
    readonly id?: string;
    readonly broadcastStatus?: "testing" | "live" | "complete";
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
}

/** Drop empty strings so optional query parameters are omitted rather than sent blank. */
function nonEmpty(value: string | undefined): string | undefined {
  return value || undefined;
}

export function youtube(
  options: YouTubeOptions,
): import("../core/adapter.js").SocialAdapter<YouTubeNative> {
  const request = managedHttp("https://www.googleapis.com", {
    apiKey: options.auth.accessToken,
    ...definedFields({ fetch: options.fetch }),
  });

  const analyticsRequest = managedHttp("https://youtubeanalytics.googleapis.com", {
    apiKey: options.auth.accessToken,
    ...definedFields({ fetch: options.fetch }),
  });

  const binaryRequest = createHttp({
    ...definedFields({ fetch: options.fetch }),
    timeoutMs: 30_000,
  });

  const now = () => (options.clock?.() ?? new Date()).toISOString();

  const authorize = (
    ref: { backend: string; platform: string; accountId: string },
    context: AdapterOperationContext,
  ) => {
    if (
      ref.backend !== context.backendInstance ||
      ref.platform !== "youtube" ||
      ref.accountId !== options.auth.channelId
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "youtube",
        message: "The selected channel does not belong to these configured credentials.",
      });
  };

  const get = async (ref: PlatformPostRef, context: AdapterOperationContext) => {
    authorize(ref, context);

    const result = object(
      await request("/youtube/v3/videos", context, undefined, {
        id: ref.postId,
        part: "snippet,status,statistics,processingDetails",
      }),
    );

    const video = array(result["items"])
      .map(object)
      .find((item) => item["id"] === ref.postId);

    if (!video)
      throw new SocialError({
        code: "upstream_failure",
        operation: "posts.read",
        message: "Video is absent or inaccessible to this authorization.",
      });

    const snippet = object(video["snippet"]);

    if (snippet["channelId"] !== options.auth.channelId)
      throw new SocialError({
        code: "unauthorized",
        operation: "posts.read",
        message: "Video belongs to a different channel.",
      });

    return video;
  };

  /** Returns the publishAt time only while the video is private and still waiting to publish. */
  const scheduledAt = (status: JsonObject): string | undefined => {
    const publishAt = optionalString(status["publishAt"]);

    if (status["privacyStatus"] !== "private" || publishAt === undefined) return undefined;
    const time = Date.parse(publishAt);

    return Number.isFinite(time) && time > (options.clock?.() ?? new Date()).getTime()
      ? publishAt
      : undefined;
  };

  const outcome = (
    video: JsonObject,
    target: { account: ConnectedAccountRef; targetIndex: number },
  ): DeliveryOutcome => {
    const id = string(video["id"]);

    const status = object(video["status"]);

    const uploaded = optionalString(status["uploadStatus"]) ?? "unknown";

    const base = {
      ...target,
      observedAt: now(),
      backendState: uploaded,
      delivery: {
        kind: "delivery" as const,
        version: 1 as const,
        backend: target.account.backend,
        platform: "youtube",
        accountId: target.account.accountId,
        deliveryId: id,
      },
    };

    if (uploaded === "failed" || uploaded === "rejected")
      return {
        ...base,
        state: "failed",
        code: "media_error",
        message:
          "YouTube rejected or failed to process the video. Inspect channel eligibility and upload requirements.",
        retryDisposition: { kind: "never" },
      };

    // A private video with a future publishAt is waiting for YouTube to publish it.
    if (scheduledAt(status) !== undefined)
      return {
        ...base,
        state: "scheduled",
        job: {
          kind: "scheduled-job",
          version: 1,
          backend: target.account.backend,
          platform: "youtube",
          accountId: target.account.accountId,
          jobId: id,
        },
      };

    if (uploaded === "processed")
      return {
        ...base,
        state: "published",
        post: {
          kind: "platform-post",
          version: 1,
          backend: target.account.backend,
          platform: "youtube",
          accountId: target.account.accountId,
          postId: id,
        },
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
      };

    if (uploaded === "uploaded") return { ...base, state: "processing" };

    return {
      ...base,
      state: "unknown",
      reason: "unmapped-state",
      diagnostic: "Unmapped YouTube upload status.",
    };
  };

  const accountInfo = async (context: AdapterOperationContext): Promise<AccountRecord> => {
    const result = object(
      await request("/youtube/v3/channels", context, undefined, {
        mine: "true",
        part: "snippet",
        maxResults: "50",
      }),
    );

    const channel = array(result["items"])
      .map(object)
      .find((item) => item["id"] === options.auth.channelId);

    if (!channel)
      throw new SocialError({
        code: "unauthorized",
        operation: "accounts.read",
        message:
          "Configured channel was not returned for the authorized Google account. Select a channel through the connection flow.",
      });

    return {
      ref: {
        kind: "connected-account",
        version: 1,
        backend: context.backendInstance,
        platform: "youtube",
        accountId: options.auth.channelId,
      },
      displayName: string(object(channel["snippet"])["title"]),
      status: "connected",
    };
  };

  const nativeAuthorize = (context: AdapterOperationContext) =>
    authorize(
      { backend: context.backendInstance, platform: "youtube", accountId: options.auth.channelId },
      context,
    );

  const mediaBlob = (media: MediaAttachment | undefined): Blob => {
    if (!media || media.source.kind !== "blob")
      throw new SocialError({
        code: "invalid_input",
        operation: "native",
        message: "This YouTube operation requires a Blob media source.",
      });

    return media.source.blob;
  };

  const binaryJson = async (
    path: string,
    context: AdapterOperationContext,
    body: BodyInit,
    query: Record<string, string>,
    method: "POST" | "PUT" = "POST",
    contentType?: string,
  ): Promise<JsonObject> => {
    const url = new URL(`https://www.googleapis.com${path}`);

    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    try {
      const result = await binaryRequest({
        url,
        method,
        body,
        headers: {
          Authorization: `Bearer ${options.auth.accessToken}`,
          ...definedFields({ "Content-Type": nonEmpty(contentType) }),
        },
        timeoutMs: remainingBudget(context),
        ...definedFields({ signal: context.signal }),
      });

      return object(result);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      const ambiguous = error.dispatched && (error.kind !== "http" || (error.status ?? 0) >= 500);

      throw new SocialError({
        code: ambiguous
          ? "ambiguous_outcome"
          : error.status === 401
            ? "reconnect_required"
            : error.status === 403
              ? "missing_permission"
              : error.status === 429
                ? "rate_limited"
                : "upstream_failure",
        operation: path,
        message: error.message,
        upstreamStatus: error.status,
        retryDisposition: ambiguous ? { kind: "reconcile-first" } : { kind: "never" },
        cause: error,
      });
    }
  };

  return defineAdapter({
    id: "youtube",
    capabilities: {
      schemaVersion: 1 as const,
      backend: "youtube",
      apiRevision: "YouTube Data API v3",
      runtime: ["node22", "node24", "bun"],
      capabilities: [
        webhookCapability(
          "youtube",
          "Verifies the PubSubHubbub X-Hub-Signature for subscriptions created with hub.secret and decodes the Atom feed. Answer the GET verification with answerYouTubeWebhookChallenge.",
        ),
        ...[
          "accounts.read",
          "posts.read",
          "posts.list",
          "posts.status",
          "analytics.read",
          "analytics.account.read",
          "comments.read",
          "comments.write",
        ].map((operation) => ({
          operation,
          platform: "youtube",
          availability: "available" as const,
        })),
        {
          operation: "posts.publish",
          platform: "youtube",
          availability: "available" as const,
          formats: ["video" as const],
          requiredScopes: ["https://www.googleapis.com/auth/youtube.upload"],
          notes:
            "Unaudited projects may be restricted to private visibility. Upload completion and video processing are separate.",
        },
        {
          operation: "posts.schedule",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.upload"],
          notes: "Scheduled videos are uploaded private with a future ISO publishAt timestamp.",
        },
        {
          operation: "posts.cancelScheduled",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
          notes:
            "Clears status.publishAt with videos.update and keeps the video private. The video is not deleted. Costs 51 quota units (videos.list + videos.update).",
        },
        {
          operation: "posts.removeFromPlatform",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
        },
        {
          operation: "notifications.read",
          platform: "youtube",
          availability: "unsupported-by-platform",
          notes:
            "The YouTube Data API has no notifications resource. activities.list reports actions a channel took, not notifications it received.",
        },
        {
          operation: "playlists.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"],
        },
        {
          operation: "playlists.write",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
        },
        {
          operation: "thumbnails.write",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
        },
        {
          operation: "videos.update",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
        },
        {
          operation: "posts.update",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
        },
        {
          operation: "profile.update",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
          notes:
            "Native access: updateProfile. Writes brandingSettings.channel or localizations through channels.update. Each call reads the channel (1 quota unit) and then writes it (50 units).",
        },
        {
          operation: "videos.delete",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
        },
        {
          operation: "posts.delete",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
        },
        {
          operation: "videos.rate",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
        },
        {
          operation: "captions.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
        },
        {
          operation: "captions.write",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
        },
        {
          operation: "subscriptions.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"],
        },
        {
          operation: "subscriptions.write",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
        },
        { operation: "search.keyword", platform: "youtube", availability: "available" },
        {
          operation: "search.posts",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"],
          notes: "Uses search.list with type=video. Each request costs 100 quota units.",
        },
        {
          operation: "comments.moderate",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
        },
        {
          operation: "comments.delete",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
          notes:
            "comments.delete costs 50 quota units. Delete a thread through its top-level comment ID. Google does not document which comments a channel may delete; insufficient permissions return 403 forbidden.",
        },
        {
          operation: "analytics.youtube.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/yt-analytics.readonly"],
        },
        {
          operation: "analytics.report.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/yt-analytics.readonly"],
          notes: "Reports require an explicit bounded date range and provider-supported metrics.",
        },
        {
          operation: "live.broadcasts",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
          notes:
            "The channel must have live streaming enabled in YouTube Studio. Use native access: liveBroadcasts.",
        },
      ],
    },
    webhooks: directWebhooks(
      "youtube",
      (input) => verifyYouTubeWebhook({ ...input, secret: options.webhookSecret ?? "" }),
      now,
    ),
    accounts: {
      async list(_input: { cursor?: string; limit?: number }, context: AdapterOperationContext) {
        return { items: [await accountInfo(context)] };
      },
      async get(ref: ConnectedAccountRef, context: AdapterOperationContext) {
        authorize(ref, context);

        return accountInfo(context);
      },
    },
    posts: {
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        authorize(account, context);

        const limit = input.limit ?? 25;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || input.cursor === "")
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.read",
            message: "YouTube page size must be from 1 to 50 and page tokens must be nonempty.",
          });

        const channel = object(
          await request("/youtube/v3/channels", context, undefined, {
            id: options.auth.channelId,
            part: "contentDetails",
          }),
        );

        const row = array(channel["items"])
          .map(object)
          .find((item) => item["id"] === options.auth.channelId);

        if (!row)
          throw new SocialError({
            code: "unauthorized",
            operation: "posts.list",
            message: "Configured channel was not returned.",
          });

        const details = object(row["contentDetails"]),
          related = object(details["relatedPlaylists"]),
          uploads = string(related["uploads"]);

        const page = object(
          await request("/youtube/v3/playlistItems", context, undefined, {
            playlistId: uploads,
            part: "snippet,contentDetails",
            maxResults: String(limit),
            ...definedFields({ pageToken: nonEmpty(input.cursor) }),
          }),
        );

        return {
          items: array(page["items"]).map((value) => {
            const item = object(value),
              snippet = object(item["snippet"]),
              content = object(item["contentDetails"]);

            if (
              snippet["channelId"] !== options.auth.channelId ||
              (snippet["videoOwnerChannelId"] !== undefined &&
                snippet["videoOwnerChannelId"] !== options.auth.channelId)
            )
              throw new SocialError({
                code: "unauthorized",
                operation: "posts.read",
                message: "YouTube returned a video from another channel.",
              });

            return {
              id: string(content["videoId"]),
              snippet: publicFields(snippet, [
                "channelId",
                "title",
                "description",
                "publishedAt",
                "videoOwnerChannelId",
              ]),
              contentDetails: publicFields(content, ["videoId", "videoPublishedAt"]),
            };
          }),
          ...definedFields({ nextCursor: optionalString(page["nextPageToken"]) }),
        };
      },
      prepareTarget(target: PreparedPublishTarget) {
        const issues: { code: string; message: string; severity: "error"; targetIndex: number }[] =
          [];

        const fail = (code: string, message: string) =>
          issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

        if (
          target.account.platform !== "youtube" ||
          target.account.accountId !== options.auth.channelId
        )
          fail("youtube.channel", "Select the configured YouTube channel.");

        const media = target.content.media;

        if (media?.length !== 1 || media[0]?.kind !== "video")
          fail(
            "youtube.video",
            "YouTube requires exactly one video; text-only publication is unavailable.",
          );

        const item = media?.[0];

        if (item) {
          if (item.source.kind !== "blob" && item.source.kind !== "stream")
            fail("youtube.source", "Provide a Blob or replayable stream for resumable upload.");

          if (!item.mimeType?.startsWith("video/"))
            fail("youtube.mime", "Declare the actual video MIME type.");

          if (item.source.kind !== "blob" && !item.byteSize)
            fail("youtube.size", "Streaming upload requires its exact byte size.");
        }

        const config = optionsObject(target);

        const title = config["title"];

        if (!isString(title) || !title || [...title].length > 100 || /[<>]/u.test(title))
          fail("youtube.title", "Select a title of 1 to 100 characters.");

        if (!["public", "unlisted", "private"].includes(String(config["visibility"])))
          fail("youtube.visibility", "Explicit visibility is required.");

        if (!isBoolean(config["madeForKids"]))
          fail("youtube.audience", "Explicit made-for-kids declaration is required.");

        if (
          target.content.text !== undefined &&
          new TextEncoder().encode(target.content.text).byteLength > 5000
        )
          fail("youtube.description", "Description must be at most 5000 UTF-8 bytes.");

        if (
          target.schedule &&
          (!Number.isFinite(Date.parse(target.schedule.at)) ||
            Date.parse(target.schedule.at) <= (options.clock?.() ?? new Date()).getTime())
        )
          fail("youtube.schedule", "Schedule time must be a valid timestamp in the future.");

        if (target.replyTo) fail("youtube.operation", "Use comments.reply for replies.");

        return issues;
      },
      async publishTarget(target: PreparedPublishTarget, context: AdapterOperationContext) {
        authorize(target.account, context);

        const media = target.content.media?.[0];

        if (!media)
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.publish",
            message: "Video required.",
          });

        const config = optionsObject(target);

        const uploadOptions = {
          timeoutMs: Math.max(remainingBudget(context), 15 * 60_000),
          accessToken: options.auth.accessToken,
          ...definedFields({ fetch: options.fetch, signal: context.signal }),
        };

        const size = media.byteSize ?? (media.source.kind === "blob" ? media.source.blob.size : 0);

        const mimeType = string(media.mimeType);

        const title = string(config["title"]);

        const visibility = string(config["visibility"]);

        const selfDeclaredMadeForKids = config["madeForKids"] === true;

        // A schedule forces private visibility until YouTube publishes at `publishAt`.
        const status =
          target.schedule === undefined
            ? { privacyStatus: visibility, selfDeclaredMadeForKids }
            : {
                privacyStatus: "private",
                selfDeclaredMadeForKids,
                publishAt: new Date(target.schedule.at).toISOString(),
              };

        const session = await beginYouTubeUpload(
          {
            channelId: options.auth.channelId,
            size,
            mimeType,
            metadata: {
              snippet: { title, description: target.content.text ?? "" },
              status,
            },
          },
          uploadOptions,
        );

        if (options.saveUploadSession) await options.saveUploadSession(session);

        const result = await sendYouTubeUpload(session, media, uploadOptions);

        if (result.state === "incomplete")
          return {
            account: target.account,
            targetIndex: target.targetIndex,
            observedAt: now(),
            state: "unknown" as const,
            reason: "ambiguous-submission" as const,
            diagnostic:
              "Upload is incomplete. Query the saved server-side session and explicitly resume confirmed bytes.",
          };

        return outcome(result.video, target);
      },
      async get(ref: PlatformPostRef, context: AdapterOperationContext): Promise<JsonObject> {
        const video = await get(ref, context);

        return {
          id: string(video["id"]),
          snippet: publicFields(video["snippet"], [
            "title",
            "description",
            "channelId",
            "publishedAt",
          ]),
          status: publicFields(video["status"], [
            "privacyStatus",
            "uploadStatus",
            "selfDeclaredMadeForKids",
          ]),
        };
      },
      async getDelivery(
        ref: { backend: string; platform: string; accountId: string; deliveryId: string },
        context: AdapterOperationContext,
      ) {
        const account: ConnectedAccountRef = {
          kind: "connected-account",
          version: 1,
          backend: ref.backend,
          platform: "youtube",
          accountId: ref.accountId,
        };

        const video = await get(
          { ...account, kind: "platform-post", postId: ref.deliveryId },
          context,
        );

        return outcome(video, { account, targetIndex: 0 });
      },
      async cancelScheduled(
        ref: ScheduledJobRef,
        context: AdapterOperationContext,
      ): Promise<ScheduleCancellation> {
        authorize(ref, context);

        if (!ref.jobId)
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.cancelScheduled",
            message: "jobId must be the scheduled video's ID.",
          });

        const video = await get(
          {
            kind: "platform-post",
            version: 1,
            backend: ref.backend,
            platform: "youtube",
            accountId: ref.accountId,
            postId: ref.jobId,
          },
          context,
        );

        const status = object(video["status"]);

        if (scheduledAt(status) === undefined)
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.cancelScheduled",
            message:
              "Only a private video with a future publishAt can be cancelled. Reconcile a due or published video.",
          });

        // videos.update replaces the whole status part: an omitted field is reset. Resend every
        // writable field read above, set privacyStatus to private, and omit publishAt to clear it.
        const flag = (key: string): boolean | undefined => {
          const value = status[key];

          if (value === undefined || value === true || value === false) return value;
          throw new SocialError({
            code: "upstream_failure",
            operation: "posts.cancelScheduled",
            message: `YouTube returned an invalid status.${key} value.`,
          });
        };

        const selfDeclaredMadeForKids = flag("selfDeclaredMadeForKids");

        if (selfDeclaredMadeForKids === undefined)
          throw new SocialError({
            code: "upstream_failure",
            operation: "posts.cancelScheduled",
            message:
              "YouTube did not return the made-for-kids declaration, so the update could not preserve it. Nothing was changed.",
          });

        const license = optionalString(status["license"]);
        const embeddable = flag("embeddable");
        const publicStatsViewable = flag("publicStatsViewable");
        const containsSyntheticMedia = flag("containsSyntheticMedia");

        const next = (() => {
          const result: Record<string, JsonValue> = {};
          result["privacyStatus"] = "private";
          result["selfDeclaredMadeForKids"] = selfDeclaredMadeForKids;

          if (license !== undefined) result["license"] = license;

          if (embeddable !== undefined) result["embeddable"] = embeddable;

          if (publicStatsViewable !== undefined)
            result["publicStatsViewable"] = publicStatsViewable;

          if (containsSyntheticMedia !== undefined)
            result["containsSyntheticMedia"] = containsSyntheticMedia;

          return result satisfies JsonObject;
        })();

        const result = object(
          await request(
            "/youtube/v3/videos",
            context,
            { id: ref.jobId, status: next },
            { part: "status" },
            "PUT",
          ),
        );

        const written = result["status"] === undefined ? undefined : object(result["status"]);

        if (
          result["id"] !== ref.jobId ||
          written?.["privacyStatus"] !== "private" ||
          (written?.["publishAt"] !== undefined && written?.["publishAt"] !== null)
        )
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "posts.cancelScheduled",
            backend: context.backendInstance,
            correlationId: context.correlationId,
            message:
              "YouTube did not confirm that the schedule was cleared. Read the video before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return { state: "cancelled", backendRecord: "retained" };
      },
      async removeFromPlatform(ref: PlatformPostRef, context: AdapterOperationContext) {
        authorize(ref, context);

        if (!ref.postId)
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.removeFromPlatform",
            message: "postId is required.",
          });

        await request("/youtube/v3/videos", context, undefined, { id: ref.postId }, "DELETE");
      },
    },
    search: {
      async posts(
        account: ConnectedAccountRef,
        input: SearchPostsInput,
        context: AdapterOperationContext,
      ): Promise<Page<JsonObject>> {
        authorize(account, context);

        const limit = input.limit ?? 25;

        if (input.scope !== undefined && input.scope !== "recent")
          throw new SocialError({
            code: "invalid_input",
            operation: "search.posts",
            message: "YouTube search supports only the recent scope.",
          });

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
          throw new SocialError({
            code: "invalid_input",
            operation: "search.posts",
            message: "YouTube search limit must be between 1 and 50.",
          });

        const page = object(
          await request("/youtube/v3/search", context, undefined, {
            part: "snippet",
            q: input.query,
            type: "video",
            maxResults: String(limit),
            ...definedFields({
              pageToken: nonEmpty(input.cursor),
              publishedAfter: nonEmpty(input.startTime),
              publishedBefore: nonEmpty(input.endTime),
            }),
          }),
        );

        return {
          items: array(page["items"]).map(object),
          ...definedFields({ nextCursor: nonEmpty(optionalString(page["nextPageToken"])) }),
        };
      },
    },
    analytics: {
      async getPostMetrics(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        const video = await get(ref, context);

        if (video["statistics"] === undefined) return [];

        const values = object(video["statistics"]);

        const metrics: MetricValue[] = [];

        for (const name of ["viewCount", "likeCount", "commentCount"]) {
          const raw = values[name];

          if (!isString(raw) || !/^\d+$/.test(raw)) continue;

          const value = Number(raw);

          if (!Number.isSafeInteger(value)) continue;
          metrics.push({
            name,
            value,
            unit: "count",
            period: "lifetime",
            fetchedAt: now(),
            freshness: "unknown",
            source: "youtube-data-v3",
          });
        }

        return metrics;
      },
      async getAccountMetrics(accountRef, context): Promise<readonly MetricValue[]> {
        // https://developers.google.com/youtube/v3/docs/channels/list
        authorize(accountRef, context);

        const result = object(
          await request("/youtube/v3/channels", context, undefined, {
            id: options.auth.channelId,
            part: "statistics,snippet",
          }),
        );

        const channel = array(result["items"])
          .map(object)
          .find((item) => item["id"] === options.auth.channelId);

        if (!channel)
          throw new SocialError({
            code: "unauthorized",
            operation: "analytics.account.read",
            message: "Configured channel was not returned for this authorization.",
          });

        const stats = object(channel["statistics"]);

        const fetchedAt = now();

        return (["viewCount", "subscriberCount", "videoCount"] as const).flatMap((name) => {
          if (name === "subscriberCount" && stats["hiddenSubscriberCount"] === true) return [];

          const raw = stats[name];

          return isString(raw) && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
            ? [
                {
                  name,
                  value: Number(raw),
                  unit: "count" as const,
                  period: "lifetime" as const,
                  fetchedAt,
                  freshness: "unknown" as const,
                  source: "youtube-data-v3:channels.statistics",
                },
              ]
            : [];
        });
      },
      async getReport(
        accountRef: ConnectedAccountRef,
        query: AnalyticsReportQuery,
        context: AdapterOperationContext,
      ): Promise<AnalyticsReport> {
        authorize(accountRef, context);

        const date = /^\d{4}-\d{2}-\d{2}$/;

        if (
          !date.test(query.from) ||
          !date.test(query.to) ||
          query.from > query.to ||
          query.metrics.length === 0 ||
          query.metrics.some((metric) => !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(metric)) ||
          query.dimensions?.some((dimension) => !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(dimension))
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "analytics.report.read",
            message:
              "YouTube reports require YYYY-MM-DD dates (from <= to) and provider-safe metric names.",
          });

        const result = object(
          await analyticsRequest("/v2/reports", context, undefined, {
            ids: `channel==${options.auth.channelId}`,
            startDate: query.from,
            endDate: query.to,
            metrics: query.metrics.join(","),
            ...definedFields({
              dimensions:
                query.dimensions && query.dimensions.length > 0
                  ? query.dimensions.join(",")
                  : undefined,
            }),
          }),
        );

        const headers = array(result["columnHeaders"]).map((value) => {
          const header = object(value);

          return {
            name: string(header["name"]),
            type: optionalString(header["columnType"]) ?? "METRIC",
          };
        });

        const rows: AnalyticsReportRow[] = [];

        // Analytics omits `rows` entirely when the requested period has no data.
        for (const value of optionalArray(result["rows"]) ?? []) {
          const cells = array(value);

          const dimensions = Object.fromEntries(
            headers.flatMap((header, index) => {
              if (header.type !== "DIMENSION") return [];

              const raw = cells[index];

              // JSON numbers are always finite, so isFiniteNumber accepts every numeric cell.
              return isString(raw) || isFiniteNumber(raw) || isBoolean(raw)
                ? [[header.name, raw] as const]
                : [];
            }),
          );

          const metrics: Record<string, number> = {};

          headers.forEach((header, index) => {
            if (header.type === "DIMENSION") return;

            const raw = cells[index];

            const parsed = isFiniteNumber(raw)
              ? raw
              : isString(raw) && raw.trim() !== ""
                ? Number(raw)
                : undefined;

            if (parsed !== undefined && Number.isFinite(parsed)) metrics[header.name] = parsed;
          });

          rows.push({ dimensions, metrics });
        }

        return { query, rows, fetchedAt: now(), source: "youtube-analytics-v2" };
      },
    },
    comments: {
      async list(
        ref: PlatformPostRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        authorize(ref, context);

        const limit = input.limit ?? 25;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.read",
            message: "YouTube comment page size must be between 1 and 100.",
          });

        const result = object(
          await request("/youtube/v3/commentThreads", context, undefined, {
            part: "snippet",
            videoId: ref.postId,
            textFormat: "plainText",
            maxResults: String(limit),
            ...definedFields({ pageToken: input.cursor }),
          }),
        );

        const cursor = optionalString(result["nextPageToken"]);

        return {
          items: array(result["items"]).map((value) => {
            const row = object(value);

            const comment = object(object(row["snippet"])["topLevelComment"]);

            return {
              id: string(comment["id"]),
              ...publicFields(comment["snippet"], [
                "textDisplay",
                "authorDisplayName",
                "publishedAt",
                "likeCount",
              ]),
            };
          }),
          ...definedFields({ nextCursor: nonEmpty(cursor) }),
        };
      },
      async reply(
        ref: CommentRef,
        content: { text: string },
        context: AdapterOperationContext,
      ): Promise<CommentRef> {
        authorize(ref, context);

        const parentResult = object(
          await request("/youtube/v3/comments", context, undefined, {
            id: ref.commentId,
            part: "snippet",
          }),
        );

        const parent = array(parentResult["items"]).map(object)[0];

        const parentSnippet = parent === undefined ? undefined : object(parent["snippet"]);

        if (parentSnippet === undefined || parentSnippet["videoId"] !== ref.postId)
          throw new SocialError({
            code: "unauthorized",
            operation: "comments.write",
            message: "YouTube comment does not belong to the supplied video.",
          });

        const result = object(
          await request(
            "/youtube/v3/comments",
            context,
            { snippet: { parentId: ref.commentId, textOriginal: content.text } },
            { part: "snippet" },
          ),
        );

        return { ...ref, commentId: string(result["id"]) };
      },
    },
    native: {
      async resumeUpload(
        session: YouTubeUploadSession,
        media: MediaAttachment,
        context: AdapterOperationContext,
      ) {
        if (session.channelId !== options.auth.channelId)
          throw new SocialError({
            code: "unauthorized",
            operation: "youtube.upload",
            message: "Upload session belongs to another channel.",
          });

        const uploadOptions = {
          timeoutMs: remainingBudget(context),
          accessToken: options.auth.accessToken,
          ...definedFields({ fetch: options.fetch, signal: context.signal }),
        };

        const confirmed = await queryYouTubeUpload(session, uploadOptions);

        if (confirmed.state === "complete") return confirmed;

        return sendYouTubeUpload(session, media, uploadOptions, confirmed.nextByte);
      },
      async queryUpload(session: YouTubeUploadSession, context: AdapterOperationContext) {
        if (session.channelId !== options.auth.channelId)
          throw new SocialError({
            code: "unauthorized",
            operation: "youtube.upload",
            message: "Upload session belongs to another channel.",
          });

        return queryYouTubeUpload(session, {
          accessToken: options.auth.accessToken,
          ...definedFields({ fetch: options.fetch, signal: context.signal }),
        });
      },
      async setThumbnail({ videoId, thumbnail, context }) {
        nativeAuthorize(context);

        return binaryJson(
          "/upload/youtube/v3/thumbnails/set",
          context,
          mediaBlob(thumbnail),
          { videoId, uploadType: "media" },
          "POST",
          thumbnail.mimeType ?? "application/octet-stream",
        );
      },
      async captions({ action, videoId, captionId, caption, body, context }) {
        nativeAuthorize(context);

        if (action === "download") {
          if (!captionId)
            throw new SocialError({
              code: "invalid_input",
              operation: "captions.download",
              message: "captionId is required.",
            });

          const url = new URL(
            `https://www.googleapis.com/youtube/v3/captions/${encodeURIComponent(captionId)}`,
          );

          url.searchParams.set("tfmt", "vtt");

          const response = await (options.fetch ?? globalThis.fetch)(url, {
            headers: { Authorization: `Bearer ${options.auth.accessToken}` },
            redirect: "error",
            ...definedFields({ signal: context.signal }),
          });

          if (!response.ok)
            throw new SocialError({
              code: "upstream_failure",
              operation: "captions.download",
              message: `YouTube returned HTTP ${response.status}.`,
              upstreamStatus: response.status,
              retryDisposition: { kind: "never" },
            });

          return response.blob();
        }

        if (action === "insert" || action === "update") {
          if (!body || (action === "insert" && !caption))
            throw new SocialError({
              code: "invalid_input",
              operation: `captions.${action}`,
              message: "Caption metadata and media are required for insert.",
            });

          const snippet = object(body["snippet"] ?? {});

          if (action === "insert" && (!videoId || (snippet["videoId"] ?? videoId) !== videoId))
            throw new SocialError({
              code: "invalid_input",
              operation: "captions.insert",
              message: "videoId is required and must match body.snippet.videoId.",
            });

          const metadata: JsonObject =
            action === "update"
              ? { ...body, id: captionId ?? body["id"] ?? null }
              : { ...body, snippet: { ...snippet, videoId: videoId ?? null } };

          if (action === "update" && !isString(metadata["id"]))
            throw new SocialError({
              code: "invalid_input",
              operation: "captions.update",
              message: "captionId or body.id is required.",
            });

          if (action === "update" && !caption)
            return binaryJson(
              "/youtube/v3/captions",
              context,
              JSON.stringify(metadata),
              { part: "snippet" },
              "PUT",
              "application/json",
            );

          if (!caption)
            throw new SocialError({
              code: "invalid_input",
              operation: "captions.insert",
              message: "Caption media is required.",
            });

          const boundary = `youtube-caption-${crypto.randomUUID()}`;

          const media = mediaBlob(caption);

          const filename = (caption.filename ?? "captions.vtt").replace(/[\r\n]/gu, "");

          const encoded = new Blob([
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
            `--${boundary}\r\nContent-Type: ${caption.mimeType ?? "text/vtt"}\r\nContent-Disposition: attachment; filename="${filename}"\r\n\r\n`,
            media,
            `\r\n--${boundary}--\r\n`,
          ]);

          return binaryJson(
            "/upload/youtube/v3/captions",
            context,
            encoded,
            { uploadType: "multipart", part: "snippet" },
            action === "update" ? "PUT" : "POST",
            `multipart/related; boundary=${boundary}`,
          );
        }

        if (action === "delete") {
          if (!captionId)
            throw new SocialError({
              code: "invalid_input",
              operation: "captions.delete",
              message: "captionId is required.",
            });

          await request(
            "/youtube/v3/captions",
            context,
            undefined,
            { id: captionId ?? "" },
            "DELETE",
          );

          return {};
        }

        return object(
          await request(
            "/youtube/v3/captions",
            context,
            undefined,
            { part: "snippet", videoId },
            "GET",
          ),
        );
      },
      async playlists({
        action,
        playlistId,
        channelId,
        mine,
        pageToken,
        maxResults,
        body,
        context,
      }) {
        nativeAuthorize(context);

        const method =
          action === "list"
            ? "GET"
            : action === "delete"
              ? "DELETE"
              : action === "update"
                ? "PUT"
                : "POST";

        if ((action === "delete" || action === "update") && !playlistId)
          throw new SocialError({
            code: "invalid_input",
            operation: `playlists.${action}`,
            message: "playlistId is required.",
          });

        if (action === "delete") {
          await request(
            "/youtube/v3/playlists",
            context,
            undefined,
            { id: playlistId ?? "" },
            method,
          );

          return {};
        }

        return object(
          await request(
            "/youtube/v3/playlists",
            context,
            body,
            {
              part: "snippet,status,contentDetails",
              ...definedFields({
                id: nonEmpty(playlistId),
                channelId: nonEmpty(channelId),
                // Listing with no playlist or channel filter defaults to the caller's playlists.
                mine: (action === "list" && !playlistId && !channelId) || mine ? "true" : undefined,
                pageToken: nonEmpty(pageToken),
                maxResults: maxResults ? String(maxResults) : undefined,
              }),
            },
            method,
          ),
        );
      },
      async playlistItems({ action, playlistId, playlistItemId, body, pageToken, context }) {
        nativeAuthorize(context);

        const method =
          action === "list"
            ? "GET"
            : action === "delete"
              ? "DELETE"
              : action === "update"
                ? "PUT"
                : "POST";

        if (action === "delete") {
          if (!playlistItemId)
            throw new SocialError({
              code: "invalid_input",
              operation: "playlistItems.delete",
              message: "playlistItemId is required.",
            });

          await request(
            "/youtube/v3/playlistItems",
            context,
            undefined,
            { id: playlistItemId },
            method,
          );

          return {};
        }

        return object(
          await request(
            "/youtube/v3/playlistItems",
            context,
            body,
            {
              part: "snippet,contentDetails",
              ...definedFields({
                playlistId: nonEmpty(playlistId),
                id: nonEmpty(playlistItemId),
                pageToken: nonEmpty(pageToken),
              }),
            },
            method,
          ),
        );
      },
      async updateVideo({ videoId, body, context }) {
        nativeAuthorize(context);

        if (!videoId)
          throw new SocialError({
            code: "invalid_input",
            operation: "videos.update",
            message: "videoId is required.",
          });

        const existing = await get(
          {
            kind: "platform-post",
            version: 1,
            backend: context.backendInstance,
            platform: "youtube",
            accountId: options.auth.channelId,
            postId: videoId,
          },
          context,
        );

        const merged = {
          ...existing,
          ...body,
          id: videoId,
          snippet: { ...object(existing["snippet"]), ...object(body["snippet"] ?? {}) },
          status: { ...object(existing["status"] ?? {}), ...object(body["status"] ?? {}) },
        };

        return object(
          await request("/youtube/v3/videos", context, merged, { part: "snippet,status" }, "PUT"),
        );
      },
      async updateProfile({ part, value, context }) {
        nativeAuthorize(context);

        const operation = "profile.update";

        const invalid = (message: string) =>
          new SocialError({ code: "invalid_input", operation, message });

        if (part !== "brandingSettings" && part !== "localizations")
          throw invalid("part must be brandingSettings or localizations.");

        if (!isJsonObject(value) || Object.keys(value).length === 0)
          throw invalid("value must be a non-empty object.");

        const channelPatch = value["channel"];

        if (
          part === "brandingSettings" &&
          (Object.keys(value).some((key) => key !== "channel") || !isJsonObject(channelPatch))
        )
          throw invalid("brandingSettings updates accept only a channel object.");

        if (
          part === "localizations" &&
          Object.entries(value).some(
            ([key, entry]) => key.trim() === "" || (entry !== null && !isJsonObject(entry)),
          )
        )
          throw invalid(
            "Each localization must be an object keyed by language, or null to remove it.",
          );

        // channels.update deletes omitted mutable properties, so merge into the current part.
        const merge = (current: JsonValue | undefined, patch: JsonObject): JsonObject =>
          Object.fromEntries(
            Object.entries({ ...optionalObject(current), ...patch }).filter(
              ([, entry]) => entry !== null,
            ),
          );

        const channel = array(
          object(
            await request("/youtube/v3/channels", context, undefined, {
              id: options.auth.channelId,
              part,
            }),
          )["items"],
        )
          .map(object)
          .find((item) => item["id"] === options.auth.channelId);

        if (!channel)
          throw new SocialError({
            code: "unauthorized",
            operation,
            message: "Configured channel is absent or inaccessible to this authorization.",
          });

        const branding = optionalObject(channel["brandingSettings"]) ?? {};

        // Resend only documented writable branding: the merged channel object and the current
        // banner URL, which channels.update would otherwise delete. Deprecated watch, hints, and
        // image fields are dropped; YouTube rejects some of them on write.
        const bannerExternalUrl = optionalString(
          optionalObject(branding["image"])?.["bannerExternalUrl"],
        );

        const brandingNext = (patch: JsonObject): JsonObject => {
          const result: Record<string, JsonValue> = {};

          result["channel"] = merge(branding["channel"], patch);

          if (bannerExternalUrl !== undefined && bannerExternalUrl !== "")
            result["image"] = { bannerExternalUrl };

          return result;
        };

        const next =
          part === "brandingSettings" && isJsonObject(channelPatch)
            ? brandingNext(channelPatch)
            : merge(channel["localizations"], value);

        return object(
          await request(
            "/youtube/v3/channels",
            context,
            { id: options.auth.channelId, [part]: next },
            { part },
            "PUT",
          ),
        );
      },
      async deleteVideo({ videoId, context }) {
        nativeAuthorize(context);

        if (!videoId)
          throw new SocialError({
            code: "invalid_input",
            operation: "videos.delete",
            message: "videoId is required.",
          });

        await request("/youtube/v3/videos", context, undefined, { id: videoId }, "DELETE");
      },
      async rateVideo({ videoId, rating, context }) {
        nativeAuthorize(context);

        await request(
          "/youtube/v3/videos/rate",
          context,
          undefined,
          { id: videoId, rating },
          "POST",
        );
      },
      async getRating({ videoIds, context }) {
        nativeAuthorize(context);

        return object(
          await request("/youtube/v3/videos/getRating", context, undefined, {
            id: videoIds.join(","),
          }),
        );
      },
      async subscriptions({ action, subscriptionId, channelId, pageToken, context }) {
        nativeAuthorize(context);

        const method = action === "list" ? "GET" : action === "delete" ? "DELETE" : "POST";

        if (action === "delete" && !subscriptionId)
          throw new SocialError({
            code: "invalid_input",
            operation: "subscriptions.delete",
            message: "subscriptionId is required.",
          });

        const insertBody = channelId
          ? { snippet: { resourceId: { kind: "youtube#channel", channelId } } }
          : undefined;

        if (action === "delete") {
          await request(
            "/youtube/v3/subscriptions",
            context,
            undefined,
            { id: subscriptionId ?? "" },
            method,
          );

          return {};
        }

        return object(
          await request(
            "/youtube/v3/subscriptions",
            context,
            insertBody,
            {
              part: "snippet,contentDetails",
              // Filter by subscription, else by channel, else list the caller's own subscriptions.
              ...definedFields({
                id: nonEmpty(subscriptionId),
                channelId: subscriptionId ? undefined : nonEmpty(channelId),
                mine: subscriptionId || channelId || action !== "list" ? undefined : "true",
                pageToken: nonEmpty(pageToken),
              }),
            },
            method,
          ),
        );
      },
      async search({
        q,
        type,
        channelId,
        order,
        publishedAfter,
        publishedBefore,
        pageToken,
        maxResults,
        context,
      }) {
        nativeAuthorize(context);

        return object(
          await request("/youtube/v3/search", context, undefined, {
            part: "snippet",
            q,
            ...definedFields({
              type: nonEmpty(type),
              channelId: nonEmpty(channelId),
              order: nonEmpty(order),
              publishedAfter: nonEmpty(publishedAfter),
              publishedBefore: nonEmpty(publishedBefore),
              pageToken: nonEmpty(pageToken),
              maxResults: maxResults ? String(maxResults) : undefined,
            }),
          }),
        );
      },
      async commentsModeration({ action, commentId, moderationStatus, banAuthor, body, context }) {
        nativeAuthorize(context);

        if (!commentId)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.moderate",
            message: "commentId is required.",
          });

        if (action === "setModerationStatus") {
          await request(
            "/youtube/v3/comments/setModerationStatus",
            context,
            undefined,
            {
              id: commentId,
              moderationStatus:
                moderationStatus ??
                (() => {
                  throw new SocialError({
                    code: "invalid_input",
                    operation: "comments.moderate",
                    message: "moderationStatus is required.",
                  });
                })(),
              ...definedFields({ banAuthor: banAuthor ? "true" : undefined }),
            },
            "POST",
          );

          return;
        }

        if (action === "delete") {
          await request("/youtube/v3/comments", context, undefined, { id: commentId }, "DELETE");

          return;
        }

        if (!body || (body["id"] ?? commentId) !== commentId)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.update",
            message: "Provide a comment body whose id, if present, matches commentId.",
          });

        return object(
          await request(
            "/youtube/v3/comments",
            context,
            { ...body, id: commentId },
            { part: "snippet" },
            "PUT",
          ),
        );
      },
      async deleteComment({ account, commentId, context }) {
        // Source: https://developers.google.com/youtube/v3/docs/comments/delete (accessed 2026-09-24).
        authorize(account, context);

        if (!commentId.trim())
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.delete",
            message: "commentId is required.",
          });

        await request("/youtube/v3/comments", context, undefined, { id: commentId }, "DELETE");
      },
      async heldComments({ pageToken, maxResults, context }) {
        nativeAuthorize(context);

        return object(
          await request("/youtube/v3/commentThreads", context, undefined, {
            part: "snippet",
            moderationStatus: "heldForReview",
            allThreadsRelatedToChannelId: options.auth.channelId,
            ...definedFields({
              pageToken: nonEmpty(pageToken),
              maxResults: maxResults ? String(maxResults) : undefined,
            }),
          }),
        );
      },
      async analytics({ query, context }) {
        return object(await analyticsRequest("/v2/reports", context, undefined, query));
      },
      async liveBroadcasts({ action, body, id, broadcastStatus, context }) {
        if (action === "list")
          return object(
            await request("/youtube/v3/liveBroadcasts", context, undefined, {
              part: "snippet,status",
              ...(id ? { id } : { mine: "true" }),
            }),
          );

        if (action === "transition") {
          if (!id || !broadcastStatus)
            throw new SocialError({
              code: "invalid_input",
              operation: "live.broadcasts",
              message: "id and broadcastStatus are required.",
            });

          return object(
            await request(
              "/youtube/v3/liveBroadcasts/transition",
              context,
              undefined,
              { part: "snippet,status", id, broadcastStatus },
              "POST",
            ),
          );
        }

        return object(
          await request(
            "/youtube/v3/liveBroadcasts",
            context,
            body,
            { part: "snippet,status" },
            "POST",
          ),
        );
      },
    },
  });
}
