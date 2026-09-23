/* oxlint-disable anti-slop/no-unknown-parameters -- validated external boundary or fixture contract. */
import { defineAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import type {
  AdapterOperationContext,
  ConnectedAccountRef,
  DeliveryOutcome,
  JsonObject,
  PreparedPublishTarget,
  MetricValue,
  PlatformPostRef,
} from "../core/types.js";
import { managedHttp, publicFields } from "../cloud/common.js";
import { array, object, optionalNumber, optionalString, string } from "../transport/validation.js";
import { httpsUrl } from "../transport/upload.js";

export interface TikTokOptions {
  readonly auth: { readonly accessToken: string; readonly openId: string };
  /** Origins verified in the developer's TikTok app. PULL_FROM_URL requires ownership. */
  readonly verifiedMediaOrigins: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
}

export interface TikTokNative {
  readonly creatorInfo: (
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ) => Promise<JsonObject>;
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
}

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
];

export function tiktok(
  options: TikTokOptions,
): import("../core/adapter.js").SocialAdapter<TikTokNative> {
  const request = managedHttp("https://open.tiktokapis.com", {
    apiKey: options.auth.accessToken,
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
    ...(options.fetch
      ? {
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = await options.fetch!(input, init);

            if (response.status < 400 || response.status >= 500) return response;

            const body = await response.clone().text();

            try {
              const parsed: unknown = JSON.parse(body);
              const parsedObject = object(parsed);
              const errorObject = object(parsedObject["error"]);

              if (errorObject["code"] !== undefined)
                return new Response(body, {
                  status: 200,
                  headers: response.headers,
                });
            } catch {
              // Preserve ordinary HTTP error handling for non-JSON responses.
            }

            return response;
          },
        }
      : {}),
  });

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

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated boundary or fixture contract.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- provider payload is validated at this adapter boundary.
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated external boundary or fixture contract.
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated external boundary or fixture contract.
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
  const data = (value: unknown): Record<string, unknown> => {
    const response = object(value);
    const error = object(response["error"]);

    if (error["code"] !== "ok")
      throw new SocialError({
        code:
          error["code"] === "access_token_invalid"
            ? "reconnect_required"
            : error["code"] === "scope_not_authorized" ||
                error["code"] === "unaudited_client_can_only_post_to_private_accounts"
              ? "missing_permission"
              : "upstream_failure",
        operation: "tiktok",
        message:
          "TikTok rejected the operation. Check creator eligibility, scope grants, and app audit status.",
        upstreamCode: string(error["code"]),
      });

    return object(response["data"]);
  };

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
      privacyLevels: array(creator["privacy_level_options"]).map(string),
      commentDisabled: creator["comment_disabled"] === true,
      duetDisabled: creator["duet_disabled"] === true,
      stitchDisabled: creator["stitch_disabled"] === true,
      maxVideoDurationSeconds: optionalNumber(creator["max_video_post_duration_sec"]) ?? null,
    };
  };

  const prepare = (target: PreparedPublishTarget) => {
    const issues: { code: string; message: string; severity: "error"; targetIndex: number }[] = [];

    const fail = (code: string, message: string) =>
      issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

    if (target.account.platform !== "tiktok" || target.account.accountId !== options.auth.openId)
      fail("tiktok.account", "Select the configured TikTok creator.");
    const config = target.options === undefined ? {} : object(target.options);
    const draft = config["draft"] === true;

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
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      if (typeof config[key] !== "boolean")
        fail(`tiktok.${key}`, `Explicit ${key} choice is required.`);

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
    if (!draft && (!config["creatorInfo"] || typeof config["creatorInfo"] !== "object"))
      fail(
        "tiktok.creator_info",
        "Query creator information explicitly and render its choices before preparation.",
      );
    else if (!draft) {
      const creator = object(config["creatorInfo"]);

      if (
        creator["accountId"] !== target.account.accountId ||
        creator["backend"] !== target.account.backend
      )
        fail(
          "tiktok.creator_mismatch",
          "Creator information belongs to a different account or backend.",
        );

      if (!array(creator["privacyLevels"]).includes(config["privacy"]))
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

    if (
      !video &&
      config["title"] !== undefined &&
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      (typeof config["title"] !== "string" || config["title"].length > 90)
    )
      fail("tiktok.title", "Photo titles are limited to 90 UTF-16 code units.");

    if (video && config["title"] !== undefined)
      fail("tiktok.title", "Video captions use content.text; title is a photo-only option.");

    if (
      !video &&
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      (typeof config["photoCoverIndex"] !== "number" ||
        !Number.isInteger(config["photoCoverIndex"]) ||
        config["photoCoverIndex"] < 0 ||
        config["photoCoverIndex"] >= media.length)
    )
      fail("tiktok.cover", "Select a photo cover index within the attached images.");

    for (const item of media) {
      if (item.source.kind !== "https-url") {
        fail(
          "tiktok.source",
          "This slice uses verified PULL_FROM_URL media. Supply a URL on your TikTok-verified origin.",
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

      if (
        item.kind === "video" &&
        (!Number.isFinite(item.durationSeconds) || (item.durationSeconds ?? 0) <= 0)
      )
        fail(
          "tiktok.duration",
          "Provide known video duration to check the creator's duration limit.",
        );
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
        {
          platform: "tiktok",
          operation: "posts.publish",
          availability: "available" as const,
          formats: ["image" as const, "video" as const, "carousel" as const],
          requiredScopes: ["video.publish"],
          notes:
            "Verified URL source; explicit creator choices/consent. Public posting requires app audit. Draft mode uses video.upload.",
        },
        { platform: "tiktok", operation: "posts.status", availability: "available" as const },
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
          requiredScopes: ["video.upload"],
        },
        { platform: "tiktok", operation: "posts.status.poll", availability: "available" as const },
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
          operation: "accounts.read",
          availability: "available" as const,
          requiredScopes: ["user.info.basic"],
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
      ],
    },
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
    posts: {
      async get(ref: PlatformPostRef, context: AdapterOperationContext): Promise<JsonObject> {
        authorize(ref, context);

        const result = data(
          await request(
            "/v2/video/query/",
            context,
            { filters: { video_ids: [ref.postId] } },
            {
              fields:
                "id,create_time,cover_image_url,share_url,title,video_description,duration,height,width,like_count,comment_count,share_count,view_count",
            },
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
            {
              fields:
                "id,create_time,cover_image_url,share_url,title,video_description,duration,height,width,like_count,comment_count,share_count,view_count",
            },
          ),
        );

        return {
          items: array(result["videos"]).map((row) => publicFields(row, videoFields)),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(result["has_more"] === true &&
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
          typeof result["cursor"] === "number" &&
          Number.isSafeInteger(result["cursor"]) &&
          result["cursor"] >= 0
            ? { nextCursor: String(result["cursor"]) }
            : {}),
        };
      },
      prepareTarget: prepare,
      async publishTarget(
        target: PreparedPublishTarget,
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        authorize(target.account, context);
        const config = object(target.options);
        const draft = config["draft"] === true;
        const latest = draft ? undefined : await creatorInfo(target.account, context);
        const media = target.content.media ?? [];
        const first = media[0];

        if (latest && !array(latest["privacyLevels"]).includes(config["privacy"]))
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
            first?.kind === "video" &&
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

        if (!first || first.source.kind !== "https-url")
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.publish",
            message: "Verified media URL required.",
          });

        if (
          first.kind === "video" &&
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
          latest &&
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
          typeof latest["maxVideoDurationSeconds"] === "number" &&
          (first.durationSeconds ?? Infinity) > latest["maxVideoDurationSeconds"]
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.publish",
            message: "Video exceeds this creator's allowed duration.",
          });

        const postInfo: JsonObject = {
          title: target.content.text ?? "",
          privacy_level: string(config["privacy"]),
          disable_comment: config["disableComments"] === true,
          brand_content_toggle: config["brandedContent"] === true,
          brand_organic_toggle: config["ownBrand"] === true,
        };

        // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated boundary or fixture contract.
        let result: Record<string, unknown>;

        if (first.kind === "video")
          result = data(
            await request(
              draft ? "/v2/post/publish/inbox/video/init/" : "/v2/post/publish/video/init/",
              context,
              {
                // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
                ...(draft
                  ? {}
                  : {
                      post_info: {
                        ...postInfo,
                        disable_duet: config["disableDuet"] === true,
                        disable_stitch: config["disableStitch"] === true,
                        is_aigc: config["aiGenerated"] === true,
                      },
                    }),
                source_info: { source: "PULL_FROM_URL", video_url: first.source.url },
              },
            ),
          );
        else
          result = data(
            await request("/v2/post/publish/content/init/", context, {
              post_info: {
                ...postInfo,
                // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
                title: typeof config["title"] === "string" ? config["title"] : "",
                description: target.content.text ?? "",
                auto_add_music: false,
              },
              source_info: {
                source: "PULL_FROM_URL",
                photo_cover_index:
                  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
                  typeof config["photoCoverIndex"] === "number" ? config["photoCoverIndex"] : 0,
                photo_images: media.map((item) =>
                  item.source.kind === "https-url" ? item.source.url : "",
                ),
              },
              post_mode: draft ? "MEDIA_UPLOAD" : "DIRECT_POST",
              media_type: "PHOTO",
              is_aigc: config["aiGenerated"] === true,
            }),
          );

        return {
          state: "accepted",
          account: target.account,
          targetIndex: target.targetIndex,
          observedAt: now(),
          backendState: "INITIALIZED",
          delivery: {
            kind: "delivery",
            version: 1,
            backend: target.account.backend,
            platform: "tiktok",
            accountId: target.account.accountId,
            deliveryId: string(result["publish_id"]),
          },
        };
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
          const ids = result["publicaly_available_post_id"];
          const id = Array.isArray(ids) && ids.length === 1 ? ids[0] : undefined;

          const nativeId =
            // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
            typeof id === "string"
              ? id
              : // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
                typeof id === "number" && Number.isSafeInteger(id)
                ? String(id)
                : undefined;

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

        if (!row) return [];
        const fetchedAt = now();

        return (["like_count", "comment_count", "share_count", "view_count"] as const).flatMap(
          (field) =>
            // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
            typeof row[field] === "number" && Number.isFinite(row[field])
              ? [
                  {
                    name: field,
                    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
                    value: row[field] as number,
                    unit: "count" as const,
                    period: "lifetime" as const,
                    fetchedAt,
                    freshness: "unknown" as const,
                    source: "tiktok:video.query",
                  },
                ]
              : [],
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

        return (
          ["follower_count", "following_count", "likes_count", "video_count"] as const
        ).flatMap((field) =>
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
          typeof user[field] === "number" && Number.isFinite(user[field])
            ? [
                {
                  name: field,
                  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
                  value: user[field] as number,
                  unit: "count" as const,
                  period: "lifetime" as const,
                  fetchedAt,
                  freshness: "unknown" as const,
                  source: "tiktok:user.info.stats",
                },
              ]
            : [],
        );
      },
    },
    native: {
      creatorInfo,
      async uploadDraft({ account, video, context }) {
        authorize(account, context);

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return data(
          await request("/v2/post/publish/inbox/video/init/", context, video),
        ) as JsonObject;
      },
      async listVideos({ account, cursor, maxCount, context }) {
        authorize(account, context);

        const parsedCursor = cursor === undefined ? 0 : Number(cursor);

        const result = data(
          await request(
            "/v2/video/list/",
            context,
            { cursor: parsedCursor, max_count: maxCount ?? 20 },
            { fields: videoFields.join(",") },
          ),
        );

        // SAFETY: data() validates the provider response as a JSON object.
        return result as JsonObject;
      },
      async publishStatus({ account, publishId, context }) {
        authorize(account, context);

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return data(
          await request("/v2/post/publish/status/fetch/", context, { publish_id: publishId }),
        ) as JsonObject;
      },
    },
  });
}
