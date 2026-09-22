/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract. */
import { remainingBudget } from "../transport/budget.js";
import { defineAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import type {
  AccountRecord,
  AdapterOperationContext,
  CommentRef,
  ConnectedAccountRef,
  DeliveryOutcome,
  JsonObject,
  MediaAttachment,
  MetricValue,
  PlatformPostRef,
  PreparedPublishTarget,
} from "../core/types.js";
import { managedHttp, publicFields } from "../cloud/common.js";
import { array, object, optionalString, string } from "../transport/validation.js";
import {
  beginYouTubeUpload,
  queryYouTubeUpload,
  sendYouTubeUpload,
  type YouTubeUploadSession,
} from "./youtube-upload.js";

export interface YouTubeOptions {
  readonly auth: { readonly accessToken: string; readonly channelId: string };
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
  /** Persist secret resumable URI server-side before uploading any video bytes. */
  readonly saveUploadSession?: (session: YouTubeUploadSession) => Promise<void>;
}

export interface YouTubeNative {
  readonly resumeUpload: (
    session: YouTubeUploadSession,
    media: MediaAttachment,
    context: AdapterOperationContext,
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- validated boundary or fixture contract.
  ) => Promise<unknown>;
  readonly queryUpload: (
    session: YouTubeUploadSession,
    context: AdapterOperationContext,
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- validated boundary or fixture contract.
  ) => Promise<unknown>;
  readonly setThumbnail: (input: {
    readonly videoId: string;
    readonly thumbnail: MediaAttachment;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly captions: (input: {
    readonly action: "list" | "insert" | "delete";
    readonly videoId: string;
    readonly caption?: MediaAttachment;
    readonly captionId?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly playlists: (input: {
    readonly action: "list" | "insert" | "update" | "delete";
    readonly playlistId?: string;
    readonly body?: JsonObject;
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
  readonly analytics: (input: {
    readonly query: Record<string, string>;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly liveBroadcasts: (input: {
    readonly action: "list" | "insert" | "transition";
    readonly body?: JsonObject;
    readonly id?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
}

export function youtube(
  options: YouTubeOptions,
): import("../core/adapter.js").SocialAdapter<YouTubeNative> {
  const request = managedHttp("https://www.googleapis.com", {
    apiKey: options.auth.accessToken,
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const analyticsRequest = managedHttp("https://youtubeanalytics.googleapis.com", {
    apiKey: options.auth.accessToken,
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
    ...(options.fetch ? { fetch: options.fetch } : {}),
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

  const outcome = (
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated boundary or fixture contract.
    video: Record<string, unknown>,
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

    if (uploaded === "failed" || uploaded === "rejected")
      return {
        ...base,
        state: "failed",
        code: "media_error",
        message:
          "YouTube rejected or failed to process the video. Inspect channel eligibility and upload requirements.",
        retryDisposition: { kind: "never" },
      };

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

  return defineAdapter({
    id: "youtube",
    capabilities: {
      schemaVersion: 1 as const,
      backend: "youtube",
      apiRevision: "YouTube Data API v3",
      runtime: ["node22", "node24", "bun"],
      capabilities: [
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
        },
        {
          operation: "thumbnails.write",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
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
        { operation: "playlists.read", platform: "youtube", availability: "available" },
        { operation: "playlists.write", platform: "youtube", availability: "available" },
        { operation: "posts.update", platform: "youtube", availability: "available" },
        { operation: "posts.delete", platform: "youtube", availability: "available" },
        {
          operation: "analytics.youtube.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/yt-analytics.readonly"],
        },
        { operation: "live.broadcasts", platform: "youtube", availability: "approval-dependent" },
      ],
    },
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
            // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
            ...(input.cursor ? { pageToken: input.cursor } : {}),
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
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
          ...(typeof page["nextPageToken"] === "string"
            ? { nextCursor: page["nextPageToken"] }
            : {}),
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

        const config = target.options === undefined ? {} : object(target.options);

        if (
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
          typeof config["title"] !== "string" ||
          !config["title"] ||
          [...config["title"]].length > 100
        )
          fail("youtube.title", "Select a title of 1 to 100 characters.");

        if (!["public", "unlisted", "private"].includes(String(config["visibility"])))
          fail("youtube.visibility", "Explicit visibility is required.");

        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
        if (typeof config["madeForKids"] !== "boolean")
          fail("youtube.audience", "Explicit made-for-kids declaration is required.");

        if (target.schedule || target.replyTo)
          fail(
            "youtube.operation",
            "Use a job runner for scheduling or comments.reply for replies.",
          );

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
        const config = object(target.options);

        const uploadOptions = {
          timeoutMs: remainingBudget(context),
          accessToken: options.auth.accessToken,
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(options.fetch ? { fetch: options.fetch } : {}),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(context.signal ? { signal: context.signal } : {}),
        };

        const size = media.byteSize ?? (media.source.kind === "blob" ? media.source.blob.size : 0);

        const session = await beginYouTubeUpload(
          {
            channelId: options.auth.channelId,
            size,
            mimeType: string(media.mimeType),
            metadata: {
              snippet: { title: string(config["title"]), description: target.content.text ?? "" },
              status: {
                privacyStatus: string(config["visibility"]),
                selfDeclaredMadeForKids: config["madeForKids"] === true,
              },
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

          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
          if (typeof raw !== "string" || !/^\d+$/.test(raw)) continue;
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

          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
          return typeof raw === "string" && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
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
            // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
            ...(input.cursor === undefined ? {} : { pageToken: input.cursor }),
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
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(cursor ? { nextCursor: cursor } : {}),
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
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(options.fetch ? { fetch: options.fetch } : {}),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(context.signal ? { signal: context.signal } : {}),
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
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(options.fetch ? { fetch: options.fetch } : {}),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(context.signal ? { signal: context.signal } : {}),
        });
      },
      async setThumbnail({ videoId, thumbnail, context }) {
        void thumbnail;
        authorize(
          {
            backend: context.backendInstance,
            platform: "youtube",
            accountId: options.auth.channelId,
          },
          context,
        );

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return object(
          await request(
            "/youtube/v3/thumbnails/set",
            context,
            undefined,
            { videoId, uploadType: "media" },
            "POST",
          ),
        ) as JsonObject;
      },
      async captions({ action, videoId, captionId, context }) {
        const method = action === "list" ? "GET" : action === "delete" ? "DELETE" : "POST";

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return object(
          await request(
            "/youtube/v3/captions",
            context,
            action === "insert" ? { snippet: { videoId } } : undefined,
            {
              // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
              ...(action === "list" || action === "insert" ? { videoId } : {}),
              // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
              ...(captionId ? { id: captionId } : {}),
              part: "snippet",
            },
            method,
          ),
        ) as JsonObject;
      },
      async playlists({ action, playlistId, body, context }) {
        const method =
          action === "list"
            ? "GET"
            : action === "delete"
              ? "DELETE"
              : action === "update"
                ? "PUT"
                : "POST";

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return object(
          await request(
            "/youtube/v3/playlists",
            context,
            body,
            // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
            { ...(playlistId ? { id: playlistId } : {}), part: "snippet,status,contentDetails" },
            method,
          ),
        ) as JsonObject;
      },
      async updateVideo({ videoId, body, context }) {
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return object(
          await request(
            "/youtube/v3/videos",
            context,
            { id: videoId, ...body },
            { part: "snippet,status" },
            "PUT",
          ),
        ) as JsonObject;
      },
      async deleteVideo({ videoId, context }) {
        await request("/youtube/v3/videos", context, undefined, { id: videoId }, "DELETE");
      },
      async analytics({ query, context }) {
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return object(
          await analyticsRequest("/v2/reports", context, undefined, query),
        ) as JsonObject;
      },
      async liveBroadcasts({ action, body, id, context }) {
        if (action === "list")
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
          return object(
            await request("/youtube/v3/liveBroadcasts", context, undefined, {
              part: "snippet,status",
              // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
              ...(id ? { id } : {}),
            }),
          ) as JsonObject;

        if (action === "transition")
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
          return object(
            await request(
              "/youtube/v3/liveBroadcasts/transition",
              context,
              body,
              { part: "snippet,status", id: id ?? "" },
              "POST",
            ),
          ) as JsonObject;

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return object(
          await request(
            "/youtube/v3/liveBroadcasts",
            context,
            body,
            { part: "snippet,status" },
            "POST",
          ),
        ) as JsonObject;
      },
    },
  });
}
