import { defineAdapter, type SocialAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import type {
  AccountRecord,
  AdapterOperationContext,
  AnalyticsReport,
  AnalyticsReportQuery,
  AnalyticsReportRow,
  CommentRef,
  ConnectedAccountRef,
  DeliveryOutcome,
  DeliveryRef,
  JsonObject,
  MediaAttachment,
  MetricValue,
  Page,
  PlatformPostRef,
  PreparationIssue,
  PreparedPublishTarget,
  ScheduledJobRef,
  ScheduleCancellation,
} from "../core/types.js";
import { managedHttp, optionsObject, publicFields } from "../cloud/common.js";
import { definedFields } from "../core/fields.js";
import {
  array,
  isBoolean,
  isFiniteNumber,
  isJsonObject,
  isString,
  object,
  optionalNumber,
  optionalString,
  string,
  type JsonField,
} from "../transport/validation.js";
import { httpsUrl } from "../transport/upload.js";
import { verifyMetaWebhook } from "../server/webhooks.js";
import { directWebhooks, webhookCapability } from "./webhook-adapter.js";

/*
 * Facebook Pages through the Graph API. Official sources, checked 2026-10-24:
 * - Page posts, scheduling window and deletion: https://developers.facebook.com/docs/pages-api/posts
 * - Page Reels: https://developers.facebook.com/docs/video-api/guides/reels-publishing
 * - Page webhooks: https://developers.facebook.com/docs/graph-api/webhooks/reference/page
 * The adapter pins Graph v25.0, matching the Instagram and Threads adapters.
 */
const apiVersion = "v25.0";

const graphOrigin = `https://graph.facebook.com/${apiVersion}`;

const videoOrigin = `https://graph-video.facebook.com/${apiVersion}`;

const source = `Facebook Graph ${apiVersion}`;

/** Meta accepts scheduled Page posts between 10 minutes and 30 days after the request. */
const minimumScheduleMs = 10 * 60 * 1000;

const maximumScheduleMs = 30 * 24 * 60 * 60 * 1000;

const maximumPhotos = 10;

const maximumTextLength = 63_206;

const maximumVideoBlobBytes = 1024 * 1024 * 1024;

export interface FacebookOptions {
  /** A Page access token for the selected Page, from a user who can perform CREATE_CONTENT. */
  readonly auth: { readonly pageId: string; readonly accessToken: string };
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
  /** App secret that Meta uses to sign webhook deliveries (`X-Hub-Signature-256`). */
  readonly webhookSecret?: string;
}

export interface FacebookNative {
  readonly deletePost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly deleteComment: (input: {
    readonly account: ConnectedAccountRef;
    readonly commentId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly moderateComment: (input: {
    readonly account: ConnectedAccountRef;
    readonly commentId: string;
    readonly hidden: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly listCommentReplies: (input: {
    readonly account: ConnectedAccountRef;
    readonly commentId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Publish or schedule one hosted vertical video through the Page Reels API. */
  readonly publishReel: (input: {
    readonly account: ConnectedAccountRef;
    readonly videoUrl: string;
    readonly description?: string;
    readonly scheduleAt?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<DeliveryOutcome>;
}

/** A Page the signed-in user manages, with the Page access token Meta issued for it. */
export interface FacebookPageGrant {
  readonly pageId: string;
  readonly name: string;
  readonly tasks: readonly string[];
  /** Page access token. Store it server-side like any other credential. */
  readonly accessToken: string;
  /** True when the user can perform CREATE_CONTENT, which Page publishing requires. */
  readonly canPublish: boolean;
}

function fail(operation: string, message: string): never {
  throw new SocialError({ code: "invalid_input", operation, message });
}

function pageLimit(limit: number | undefined, operation: string, max = 100): number {
  const value = limit ?? 25;

  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    fail(operation, `Facebook page size must be an integer from 1 through ${max}.`);

  return value;
}

/** Graph cursor pagination: `paging.next` is omitted on the last page. */
function nextGraphCursor(result: JsonObject): string | undefined {
  const paging = isJsonObject(result["paging"]) ? result["paging"] : {};
  const cursors = isJsonObject(paging["cursors"]) ? paging["cursors"] : {};
  const after = cursors["after"];

  return isString(paging["next"]) &&
    paging["next"].length > 0 &&
    isString(after) &&
    after.length > 0
    ? after
    : undefined;
}

function graphPage(result: JsonObject, fields: readonly string[]): Page<JsonObject> {
  const items = array(result["data"]).map((entry) => publicFields(entry, fields));

  return { items, ...definedFields({ nextCursor: nextGraphCursor(result) }) };
}

/**
 * List the Pages a Facebook Login user token can manage, with their Page access
 * tokens (GET /me/accounts). Requires `pages_show_list`; publishing also needs
 * `pages_manage_posts` and `pages_read_engagement`. The tokens are credentials:
 * persist only the Page your application selected.
 */
export async function discoverFacebookPages(input: {
  readonly userAccessToken: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<Page<FacebookPageGrant>> {
  const request = managedHttp(graphOrigin, {
    apiKey: input.userAccessToken,
    ...definedFields({ fetch: input.fetch }),
  });

  const context: AdapterOperationContext = {
    backendInstance: "facebook",
    correlationId: "facebook-page-discovery",
    retryBudget: { maxAttempts: 3, maxElapsedMs: input.timeoutMs ?? 30_000 },
    ...definedFields({ signal: input.signal }),
  };

  const result = object(
    await request("/me/accounts", context, undefined, {
      fields: "id,name,tasks,access_token",
      limit: String(pageLimit(input.limit, "facebook.pages.discover")),
      ...definedFields({ after: input.cursor }),
    }),
  );

  const items = array(result["data"]).map((value): FacebookPageGrant => {
    const row = object(value);
    const tasks = Array.isArray(row["tasks"]) ? array(row["tasks"]).filter(isString) : [];

    return {
      pageId: string(row["id"]),
      name: optionalString(row["name"]) ?? string(row["id"]),
      tasks,
      accessToken: string(row["access_token"]),
      canPublish: tasks.includes("CREATE_CONTENT"),
    };
  });

  return { items, ...definedFields({ nextCursor: nextGraphCursor(result) }) };
}

export function facebook(options: FacebookOptions): SocialAdapter<FacebookNative> {
  const pageId = options.auth.pageId;

  if (!pageId.trim())
    throw new SocialError({
      code: "invalid_config",
      operation: "createAdapter",
      message: "Configure the Facebook Page ID that the Page access token belongs to.",
    });

  const http = { apiKey: options.auth.accessToken, ...definedFields({ fetch: options.fetch }) };
  const request = managedHttp(graphOrigin, http);
  const videoRequest = managedHttp(videoOrigin, http);

  // The Reels upload host expects `Authorization: OAuth <token>` rather than a bearer token.
  const ruploadRequest = managedHttp("https://rupload.facebook.com", http, (token) => [
    "Authorization",
    `OAuth ${token}`,
  ]);

  const clock = () => options.clock?.() ?? new Date();
  const now = () => clock().toISOString();

  const authorize = (
    ref: { readonly backend: string; readonly platform: string; readonly accountId: string },
    context: AdapterOperationContext,
  ) => {
    if (
      ref.backend !== context.backendInstance ||
      ref.platform !== "facebook" ||
      ref.accountId !== pageId
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "facebook",
        message: "Account reference does not match this Facebook Page authorization.",
      });
  };

  const confirmSuccess = (value: JsonField, operation: string, message: string): void => {
    if (!isJsonObject(value) || value["success"] !== true)
      throw new SocialError({
        code: "ambiguous_outcome",
        operation,
        message,
        retryDisposition: { kind: "reconcile-first" },
      });
  };

  const deleteObject = async (
    id: string,
    context: AdapterOperationContext,
    operation: string,
  ): Promise<void> => {
    confirmSuccess(
      await request(`/${encodeURIComponent(id)}`, context, undefined, {}, "DELETE"),
      operation,
      "Facebook did not confirm the deletion. Reconcile before retrying.",
    );
  };

  const scheduleSeconds = (at: string) => String(Math.floor(Date.parse(at) / 1000));

  /** Unpublished-with-a-time is how Graph expresses a scheduled Page post. */
  const scheduleFields = (schedule: PreparedPublishTarget["schedule"]) =>
    definedFields({
      published: schedule === undefined ? undefined : false,
      scheduled_publish_time: schedule === undefined ? undefined : scheduleSeconds(schedule.at),
    });

  const delivery = (account: ConnectedAccountRef, deliveryId: string): DeliveryRef => ({
    kind: "delivery",
    version: 1,
    backend: account.backend,
    platform: "facebook",
    accountId: account.accountId,
    deliveryId,
  });

  const postRef = (
    account: { readonly backend: string; readonly accountId: string },
    postId: string,
    objectType?: "video",
  ): PlatformPostRef => ({
    kind: "platform-post",
    version: 1,
    backend: account.backend,
    platform: "facebook",
    accountId: account.accountId,
    postId,
    ...definedFields({ native: objectType === undefined ? undefined : { objectType } }),
  });

  const published = (
    account: ConnectedAccountRef,
    targetIndex: number,
    postId: string,
    objectType?: "video",
  ): DeliveryOutcome => ({
    state: "published",
    targetIndex,
    account,
    observedAt: now(),
    delivery: delivery(account, postId),
    post: postRef(account, postId, objectType),
  });

  const scheduled = (
    account: ConnectedAccountRef,
    targetIndex: number,
    id: string,
  ): DeliveryOutcome => ({
    state: "scheduled",
    targetIndex,
    account,
    observedAt: now(),
    delivery: delivery(account, id),
    job: {
      kind: "scheduled-job",
      version: 1,
      backend: account.backend,
      platform: "facebook",
      accountId: account.accountId,
      jobId: id,
    },
  });

  const processing = (
    account: ConnectedAccountRef,
    targetIndex: number,
    videoId: string,
    backendState?: string,
  ): DeliveryOutcome => ({
    state: "processing",
    targetIndex,
    account,
    observedAt: now(),
    delivery: delivery(account, videoId),
    ...definedFields({ backendState }),
  });

  /** Graph accepts hosted media by URL or uploaded bytes in a multipart `source` part. */
  const mediaBody = (
    item: MediaAttachment,
    urlField: "url" | "file_url",
    fields: Readonly<Record<string, string | undefined>>,
  ): JsonObject | FormData => {
    const present = Object.entries(fields).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    );

    if (item.source.kind === "https-url")
      return { [urlField]: httpsUrl(item.source.url).href, ...Object.fromEntries(present) };

    if (item.source.kind !== "blob")
      fail("facebook.posts.publish", "Facebook media must be a public HTTPS URL or a Blob.");

    const form = new FormData();
    form.set("source", item.source.blob, item.filename ?? "upload");

    for (const [key, value] of present) form.set(key, value);

    return form;
  };

  const scheduleIssue = (at: string, operation: string): void => {
    const offset = Date.parse(at) - clock().getTime();

    if (!Number.isFinite(offset) || offset < minimumScheduleMs || offset > maximumScheduleMs)
      fail(operation, "Facebook schedules Page posts between 10 minutes and 30 days ahead.");
  };

  const publishReel: FacebookNative["publishReel"] = async (input) => {
    authorize(input.account, input.context);

    if (input.scheduleAt !== undefined) scheduleIssue(input.scheduleAt, "facebook.reels.publish");
    const videoUrl = httpsUrl(input.videoUrl).href;
    const page = `/${encodeURIComponent(pageId)}/video_reels`;
    const started = object(await request(page, input.context, { upload_phase: "start" }));
    const videoId = string(started["video_id"]);
    const uploadUrl = new URL(string(started["upload_url"]));

    if (uploadUrl.protocol !== "https:" || uploadUrl.hostname !== "rupload.facebook.com")
      throw new SocialError({
        code: "upstream_failure",
        operation: "facebook.reels.publish",
        message: "Facebook returned a Reels upload URL outside rupload.facebook.com.",
        details: { videoId },
      });

    try {
      confirmSuccess(
        await ruploadRequest(uploadUrl.pathname, input.context, undefined, {}, "POST", {
          file_url: videoUrl,
        }),
        "facebook.reels.upload",
        "Facebook did not confirm the hosted Reels upload.",
      );

      const finish = object(
        await request(page, input.context, {
          upload_phase: "finish",
          video_id: videoId,
          video_state: input.scheduleAt === undefined ? "PUBLISHED" : "SCHEDULED",
          ...definedFields({
            description: input.description,
            scheduled_publish_time:
              input.scheduleAt === undefined ? undefined : scheduleSeconds(input.scheduleAt),
          }),
        }),
      );

      confirmSuccess(finish, "facebook.reels.publish", "Facebook did not confirm the Reel.");
    } catch (error) {
      // The Reel container exists; keep its ID so callers can reconcile through posts.status.
      if (error instanceof SocialError && error.details?.["videoId"] === undefined)
        throw new SocialError({
          code: error.code,
          operation: "facebook.reels.publish",
          message: error.message,
          details: { videoId },
          retryDisposition: { kind: "reconcile-first" },
          cause: error,
        });
      throw error;
    }

    return input.scheduleAt === undefined
      ? processing(input.account, 0, videoId, "REEL_SUBMITTED")
      : scheduled(input.account, 0, videoId);
  };

  const publishPhotos = async (
    target: PreparedPublishTarget,
    media: readonly MediaAttachment[],
    context: AdapterOperationContext,
  ): Promise<DeliveryOutcome> => {
    const page = `/${encodeURIComponent(pageId)}`;
    const schedule = target.schedule;
    const first = media[0];

    if (media.length === 1 && first !== undefined && schedule === undefined) {
      const result = object(
        await request(
          `${page}/photos`,
          context,
          mediaBody(first, "url", {
            caption: target.content.text,
            alt_text_custom: first.altText,
          }),
        ),
      );

      return published(
        target.account,
        target.targetIndex,
        optionalString(result["post_id"]) ?? string(result["id"]),
      );
    }

    const photoIds: string[] = [];

    try {
      for (const item of media) {
        const uploaded = object(
          await request(
            `${page}/photos`,
            context,
            mediaBody(item, "url", {
              published: "false",
              // Scheduled multi-photo posts require temporary unpublished photos.
              temporary: schedule === undefined ? undefined : "true",
              alt_text_custom: item.altText,
            }),
          ),
        );

        photoIds.push(string(uploaded["id"]));
      }
    } catch (error) {
      if (error instanceof SocialError)
        throw new SocialError({
          code: error.code,
          operation: "facebook.posts.publish",
          message: error.message,
          details: { unpublishedPhotoIds: photoIds },
          retryDisposition: error.retryDisposition,
          cause: error,
        });
      throw error;
    }

    const result = object(
      await request(`${page}/feed`, context, {
        attached_media: photoIds.map((id) => ({ media_fbid: id })),
        ...definedFields({ message: target.content.text }),
        ...scheduleFields(schedule),
      }),
    );

    const id = string(result["id"]);

    return schedule === undefined
      ? published(target.account, target.targetIndex, id)
      : scheduled(target.account, target.targetIndex, id);
  };

  const publishTarget = async (
    target: PreparedPublishTarget,
    context: AdapterOperationContext,
  ): Promise<DeliveryOutcome> => {
    authorize(target.account, context);
    const media = target.content.media ?? [];
    const schedule = target.schedule;
    const page = `/${encodeURIComponent(pageId)}`;

    if (schedule !== undefined) scheduleIssue(schedule.at, "facebook.posts.schedule");

    if (media.length === 0) {
      const result = object(
        await request(`${page}/feed`, context, {
          ...definedFields({ message: target.content.text, link: target.content.link?.url }),
          ...scheduleFields(schedule),
        }),
      );

      const id = string(result["id"]);

      return schedule === undefined
        ? published(target.account, target.targetIndex, id)
        : scheduled(target.account, target.targetIndex, id);
    }

    const video = media[0];

    if (video?.kind === "video") {
      if (optionsObject(target)["reel"] === true && video.source.kind === "https-url") {
        const outcome = await publishReel({
          account: target.account,
          videoUrl: video.source.url,
          context,
          ...definedFields({ description: target.content.text, scheduleAt: schedule?.at }),
        });

        return { ...outcome, targetIndex: target.targetIndex };
      }

      const result = object(
        await videoRequest(
          `${page}/videos`,
          context,
          mediaBody(video, "file_url", {
            description: target.content.text,
            published: schedule === undefined ? undefined : "false",
            scheduled_publish_time:
              schedule === undefined ? undefined : scheduleSeconds(schedule.at),
          }),
        ),
      );

      const id = string(result["id"]);

      return schedule === undefined
        ? processing(target.account, target.targetIndex, id, "VIDEO_SUBMITTED")
        : scheduled(target.account, target.targetIndex, id);
    }

    return publishPhotos(target, media, context);
  };

  const prepareTarget = (target: PreparedPublishTarget): PreparationIssue[] => {
    const issues: PreparationIssue[] = [];

    const issue = (code: string, message: string) =>
      issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

    if (target.account.platform !== "facebook" || target.account.accountId !== pageId)
      issue("facebook.account", "Select the configured Facebook Page.");

    const media = target.content.media ?? [];
    const text = target.content.text;
    const config = optionsObject(target);
    const reel = config["reel"];

    if (Object.keys(config).some((key) => key !== "reel"))
      issue("options.unmapped", "Facebook accepts only the reel publish option.");

    if (reel !== undefined && !isBoolean(reel)) issue("facebook.reel", "reel must be a boolean.");

    if (target.replyTo)
      issue(
        "reply.use_comments",
        "Reply to Page posts with the comment reply operation instead of publishing a post.",
      );

    if ((text?.length ?? 0) > maximumTextLength)
      issue("facebook.text", "Facebook post text exceeds 63,206 characters.");

    if (!text && media.length === 0 && target.content.link === undefined)
      issue("content.empty", "Text, a link, or media is required.");

    if (target.content.link !== undefined) {
      if (media.length > 0)
        issue(
          "facebook.link_media",
          "Facebook link previews apply to text posts; put the link in the text.",
        );

      try {
        httpsUrl(target.content.link.url);
      } catch {
        issue("facebook.link_url", "Use a public HTTPS link without credentials or a custom port.");
      }
    }

    if (target.schedule !== undefined) {
      const offset = Date.parse(target.schedule.at) - clock().getTime();

      if (!Number.isFinite(offset) || offset < minimumScheduleMs || offset > maximumScheduleMs)
        issue(
          "facebook.schedule_window",
          "Facebook schedules Page posts between 10 minutes and 30 days ahead.",
        );
    }

    const videos = media.filter((item) => item.kind === "video");

    if (media.some((item) => item.kind === "document"))
      issue("facebook.document", "Facebook Page posts accept images and video only.");

    if (videos.length > 0 && media.length !== 1)
      issue("facebook.media_mix", "Publish one video, or one to ten images.");

    if (media.length > maximumPhotos)
      issue("facebook.media_count", "This adapter publishes at most ten photos per Page post.");

    if (reel === true && (videos.length !== 1 || media.length !== 1))
      issue("facebook.reel_media", "A Reel needs exactly one video.");

    for (const item of media) {
      if (item.source.kind === "https-url") {
        try {
          httpsUrl(item.source.url);
        } catch {
          issue("facebook.media_url", "Use public HTTPS media without local hosts or credentials.");
        }
      } else if (item.source.kind !== "blob" || reel === true)
        issue(
          "facebook.media_source",
          reel === true
            ? "Reels upload from a public HTTPS video URL."
            : "Facebook media must be a public HTTPS URL or a Blob.",
        );

      if (item.source.kind === "blob" && !item.filename)
        issue("facebook.media_filename", "Uploaded bytes require a filename.");

      if (
        item.kind === "video" &&
        item.source.kind === "blob" &&
        item.source.blob.size > maximumVideoBlobBytes
      )
        issue(
          "facebook.video_size",
          "Uploaded video bytes are limited to 1 GiB; use a public HTTPS video URL instead.",
        );

      if (item.caption !== undefined)
        issue("facebook.media_caption", "Use content.text for the post text.");

      if (item.thumbnail !== undefined)
        issue("facebook.thumbnail", "This adapter does not upload custom video thumbnails.");

      if (item.kind === "video" && item.altText !== undefined)
        issue("facebook.video_alt_text", "Facebook alt text applies to photos only.");
    }

    return issues;
  };

  const readPage = async (context: AdapterOperationContext): Promise<AccountRecord> => {
    const result = object(
      await request(`/${encodeURIComponent(pageId)}`, context, undefined, {
        fields: "id,name,username",
      }),
    );

    if (result["id"] !== pageId)
      throw new SocialError({
        code: "unauthorized",
        operation: "accounts.read",
        message: "Facebook returned a Page different from the configured Page.",
      });

    const handle = optionalString(result["username"]);

    return {
      ref: {
        kind: "connected-account",
        version: 1,
        backend: context.backendInstance,
        platform: "facebook",
        accountId: pageId,
      },
      displayName: optionalString(result["name"]) ?? pageId,
      ...definedFields({ handle }),
      status: "connected",
    };
  };

  const getDelivery = async (
    ref: DeliveryRef,
    context: AdapterOperationContext,
  ): Promise<DeliveryOutcome> => {
    authorize(ref, context);

    const account: ConnectedAccountRef = {
      kind: "connected-account",
      version: 1,
      backend: ref.backend,
      platform: "facebook",
      accountId: ref.accountId,
    };

    // Feed and photo deliveries are already native post IDs (`{page-id}_{post-id}`).
    if (ref.deliveryId.includes("_")) {
      const post = object(
        await request(`/${encodeURIComponent(ref.deliveryId)}`, context, undefined, {
          fields: "id,is_published,scheduled_publish_time",
        }),
      );

      // Require affirmative evidence: an unpublished post without a time may be a draft.
      if (post["is_published"] === true) return published(account, 0, string(post["id"]));

      if (post["is_published"] === false && post["scheduled_publish_time"] !== undefined)
        return scheduled(account, 0, ref.deliveryId);

      return {
        state: "unknown",
        targetIndex: 0,
        account,
        observedAt: now(),
        delivery: delivery(account, ref.deliveryId),
        reason: "unmapped-state",
        diagnostic: "Facebook returned no publication state for this post.",
      };
    }

    const video = object(
      await request(`/${encodeURIComponent(ref.deliveryId)}`, context, undefined, {
        fields: "id,status",
      }),
    );

    const status = isJsonObject(video["status"]) ? video["status"] : {};
    const videoStatus = optionalString(status["video_status"]) ?? "unknown";

    const phase = (name: string) => {
      const value = status[name];

      return isJsonObject(value) ? value : {};
    };

    const publishing = phase("publishing_phase");

    if (
      videoStatus === "error" ||
      ["uploading_phase", "processing_phase", "publishing_phase"].some(
        (name) => phase(name)["status"] === "error",
      )
    )
      return {
        state: "failed",
        targetIndex: 0,
        account,
        observedAt: now(),
        delivery: delivery(account, ref.deliveryId),
        backendState: videoStatus,
        code: "media_error",
        message: "Facebook could not process or publish this video.",
        retryDisposition: { kind: "never" },
      };

    if (publishing["publish_status"] === "scheduled") return scheduled(account, 0, ref.deliveryId);

    if (publishing["status"] !== "complete")
      return processing(account, 0, ref.deliveryId, videoStatus);

    if (publishing["publish_status"] === "published")
      return published(account, 0, string(video["id"]), "video");

    // A completed phase without a published status may be a draft; do not call it published.
    return {
      state: "unknown",
      targetIndex: 0,
      account,
      observedAt: now(),
      delivery: delivery(account, ref.deliveryId),
      backendState: optionalString(publishing["publish_status"]) ?? videoStatus,
      reason: "unmapped-state",
      diagnostic: "Facebook finished the video without reporting it as published.",
    };
  };

  const listCommentReplies: FacebookNative["listCommentReplies"] = async (input) => {
    authorize(input.account, input.context);

    const fields = ["id", "message", "created_time", "like_count", "comment_count"];

    return graphPage(
      object(
        await request(
          `/${encodeURIComponent(input.commentId)}/comments`,
          input.context,
          undefined,
          {
            fields: fields.join(","),
            limit: String(pageLimit(input.limit, "facebook.comments.replies")),
            ...definedFields({ after: input.cursor }),
          },
        ),
      ),
      fields,
    );
  };

  const reportMetric = /^[a-z][a-z0-9_]{0,99}$/;

  const getReport = async (
    account: ConnectedAccountRef,
    query: AnalyticsReportQuery,
    context: AdapterOperationContext,
  ): Promise<AnalyticsReport> => {
    authorize(account, context);
    const dimensions = query.dimensions ?? [];

    if (query.metrics.length === 0 || query.metrics.some((metric) => !reportMetric.test(metric)))
      fail("analytics.report.read", "Request one or more Page Insights metric names.");

    if (dimensions.some((dimension) => dimension !== "endTime"))
      fail("analytics.report.read", "Facebook Page reports support only the endTime dimension.");

    const from = Date.parse(`${query.from}T00:00:00Z`);
    const to = Date.parse(`${query.to}T00:00:00Z`);

    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 89 * 86_400_000)
      fail("analytics.report.read", "Facebook daily Page Insights cover at most 90 days.");

    const until = new Date(to + 86_400_000).toISOString().slice(0, 10);

    const result = object(
      await request(`/${encodeURIComponent(pageId)}/insights`, context, undefined, {
        metric: query.metrics.join(","),
        period: "day",
        since: query.from,
        until,
      }),
    );

    const rows = new Map<string, Record<string, number>>();

    for (const value of array(result["data"])) {
      const series = object(value);
      const name = string(series["name"]);

      for (const point of array(series["values"])) {
        const entry = object(point);
        const endTime = string(entry["end_time"]);
        const metric = entry["value"];

        // Breakdown metrics return objects; only scalar counts fit the normalized row.
        if (!isFiniteNumber(metric)) continue;
        const row = rows.get(endTime) ?? {};
        row[name] = metric;
        rows.set(endTime, row);
      }
    }

    const reportRows: AnalyticsReportRow[] = [...rows].map(([endTime, metrics]) => ({
      dimensions: dimensions.includes("endTime") ? { endTime } : {},
      metrics,
    }));

    return { query, rows: reportRows, fetchedAt: now(), source };
  };

  const postFields = [
    "id",
    "message",
    "created_time",
    "updated_time",
    "permalink_url",
    "status_type",
    "is_published",
  ];

  const videoFields = [
    "id",
    "description",
    "created_time",
    "updated_time",
    "permalink_url",
    "published",
  ];

  const commentFields = ["id", "message", "created_time", "like_count", "comment_count"];
  const engagementScopes = ["pages_read_engagement", "pages_read_user_content"];
  const moderationScopes = ["pages_manage_engagement", "pages_read_user_content"];
  const publishScopes = ["pages_manage_posts", "pages_read_engagement", "pages_show_list"];

  return defineAdapter({
    id: "facebook",
    capabilities: {
      schemaVersion: 1,
      backend: "facebook",
      apiRevision: source,
      runtime: ["node22", "node24", "bun"],
      capabilities: [
        {
          platform: "facebook",
          operation: "posts.publish",
          availability: "available",
          formats: ["text", "image", "video", "carousel"],
          requiredScopes: publishScopes,
          constraints: {
            eligibility: ["A Page access token from a user who can perform CREATE_CONTENT."],
            mediaSources: ["https-url", "blob"],
          },
          notes:
            "Page feed text and link posts, one photo, multi-photo posts (up to 10), Page videos, and Reels through the reel option. Videos and Reels return processing until posts.status reports them published.",
        },
        {
          platform: "facebook",
          operation: "posts.schedule",
          availability: "available",
          requiredScopes: publishScopes,
          notes:
            "Native scheduled_publish_time. Meta accepts times between 10 minutes and 30 days after the request.",
        },
        {
          platform: "facebook",
          operation: "posts.cancelScheduled",
          availability: "available",
          requiredScopes: publishScopes,
          notes: "Deletes the unpublished scheduled post or video.",
        },
        ...["accounts.read", "posts.list", "posts.read", "posts.status"].map((operation) => ({
          operation,
          platform: "facebook",
          availability: "available" as const,
          requiredScopes: ["pages_read_engagement", "pages_show_list"],
        })),
        ...(["posts.delete", "posts.removeFromPlatform"] as const).map((operation) => ({
          platform: "facebook",
          operation,
          availability: "available" as const,
          requiredScopes: publishScopes,
          notes: "DELETE /{post-id}. Posts the Page did not create cannot be deleted.",
        })),
        ...["comments.read", "comments.replies.read"].map((operation) => ({
          platform: "facebook",
          operation,
          availability: "available" as const,
          requiredScopes: engagementScopes,
        })),
        ...["comments.write", "comments.moderate", "comments.delete"].map((operation) => ({
          platform: "facebook",
          operation,
          availability: "available" as const,
          requiredScopes: moderationScopes,
        })),
        {
          platform: "facebook",
          operation: "analytics.read",
          availability: "available",
          requiredScopes: ["pages_read_engagement"],
          notes: "Lifetime reaction, comment, and share counts read from the post object.",
        },
        {
          platform: "facebook",
          operation: "analytics.account.read",
          availability: "available",
          requiredScopes: ["pages_read_engagement"],
          notes: "Page followers_count and fan_count.",
        },
        {
          platform: "facebook",
          operation: "analytics.report.read",
          availability: "available",
          requiredScopes: ["read_insights", "pages_read_engagement"],
          notes:
            "Daily Page Insights for caller-selected metric names, up to 90 days. Meta retires metrics over time; unknown names fail upstream.",
        },
        {
          platform: "facebook",
          operation: "reels.publish",
          availability: "available",
          formats: ["video"],
          requiredScopes: publishScopes,
          constraints: { mediaSources: ["https-url"] },
          notes: "Hosted 9:16 video, 3 to 90 seconds, through the three-phase Page Reels API.",
        },
        {
          platform: "facebook",
          operation: "posts.update",
          availability: "not-implemented-by-adapter",
          notes: "Editing published Page posts is not implemented.",
        },
        {
          platform: "facebook",
          operation: "messages.read",
          availability: "not-implemented-by-adapter",
          notes:
            "Page messaging uses the Messenger Platform, which this adapter does not implement.",
        },
        webhookCapability(
          "facebook",
          "Verifies Meta X-Hub-Signature-256 with the app secret and decodes object=page deliveries. Answer the GET handshake with answerMetaWebhookChallenge.",
        ),
      ],
    },
    webhooks: directWebhooks(
      "facebook",
      (input) => verifyMetaWebhook({ ...input, secret: options.webhookSecret ?? "" }),
      now,
    ),
    accounts: {
      async list(_input: { cursor?: string; limit?: number }, context: AdapterOperationContext) {
        return { items: [await readPage(context)] };
      },
      async get(ref: ConnectedAccountRef, context: AdapterOperationContext) {
        authorize(ref, context);

        return readPage(context);
      },
    },
    posts: {
      prepareTarget,
      publishTarget,
      getDelivery,
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        authorize(account, context);

        return graphPage(
          object(
            await request(`/${encodeURIComponent(pageId)}/posts`, context, undefined, {
              fields: postFields.join(","),
              limit: String(pageLimit(input.limit, "posts.list")),
              ...definedFields({ after: input.cursor }),
            }),
          ),
          postFields,
        );
      },
      async get(ref: PlatformPostRef, context: AdapterOperationContext): Promise<JsonObject> {
        authorize(ref, context);
        const fields = ref.native?.["objectType"] === "video" ? videoFields : postFields;

        return publicFields(
          await request(`/${encodeURIComponent(ref.postId)}`, context, undefined, {
            fields: fields.join(","),
          }),
          fields,
        );
      },
      async cancelScheduled(
        ref: ScheduledJobRef,
        context: AdapterOperationContext,
      ): Promise<ScheduleCancellation> {
        authorize(ref, context);
        await deleteObject(ref.jobId, context, "facebook.posts.cancelScheduled");

        return { state: "cancelled", backendRecord: "deleted" };
      },
      async removeFromPlatform(ref: PlatformPostRef, context: AdapterOperationContext) {
        authorize(ref, context);
        await deleteObject(ref.postId, context, "facebook.posts.removeFromPlatform");
      },
    },
    comments: {
      async list(
        ref: PlatformPostRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        authorize(ref, context);

        return graphPage(
          object(
            await request(`/${encodeURIComponent(ref.postId)}/comments`, context, undefined, {
              fields: commentFields.join(","),
              limit: String(pageLimit(input.limit, "comments.read")),
              ...definedFields({ after: input.cursor }),
            }),
          ),
          commentFields,
        );
      },
      async reply(
        ref: CommentRef,
        content: { readonly text: string },
        context: AdapterOperationContext,
      ): Promise<CommentRef> {
        authorize(ref, context);

        if (!content.text.trim()) fail("comments.write", "Facebook comment replies need text.");

        const result = object(
          await request(`/${encodeURIComponent(ref.commentId)}/comments`, context, {
            message: content.text,
          }),
        );

        return { ...ref, commentId: string(result["id"]) };
      },
    },
    analytics: {
      async getPostMetrics(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        authorize(ref, context);
        const video = ref.native?.["objectType"] === "video";

        const result = object(
          await request(`/${encodeURIComponent(ref.postId)}`, context, undefined, {
            fields: [
              "reactions.summary(total_count).limit(0)",
              "comments.summary(total_count).limit(0)",
              ...(video ? [] : ["shares"]),
            ].join(","),
          }),
        );

        const total = (field: string) => {
          const edge = result[field];
          const summary = isJsonObject(edge) ? edge["summary"] : undefined;

          return isJsonObject(summary) ? optionalNumber(summary["total_count"]) : undefined;
        };

        const shares = isJsonObject(result["shares"])
          ? optionalNumber(result["shares"]["count"])
          : undefined;

        return (
          [
            ["reactions", total("reactions")],
            ["comments", total("comments")],
            ["shares", shares],
          ] as const
        ).flatMap(([name, value]) =>
          value === undefined
            ? []
            : [
                {
                  name,
                  value,
                  unit: "count" as const,
                  period: "lifetime" as const,
                  fetchedAt: now(),
                  freshness: "unknown" as const,
                  source,
                },
              ],
        );
      },
      async getAccountMetrics(
        account: ConnectedAccountRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        authorize(account, context);

        const result = object(
          await request(`/${encodeURIComponent(pageId)}`, context, undefined, {
            fields: "id,followers_count,fan_count",
          }),
        );

        if (result["id"] !== pageId)
          throw new SocialError({
            code: "unauthorized",
            operation: "analytics.account.read",
            message: "Facebook returned metrics for a different Page.",
          });

        return (["followers_count", "fan_count"] as const).flatMap((name) => {
          const value = optionalNumber(result[name]);

          return value === undefined
            ? []
            : [
                {
                  name,
                  value,
                  unit: "count" as const,
                  period: "lifetime" as const,
                  fetchedAt: now(),
                  freshness: "unknown" as const,
                  source,
                },
              ];
        });
      },
      getReport,
    },
    native: {
      async deletePost({ account, postId, context }) {
        authorize(account, context);
        await deleteObject(postId, context, "facebook.posts.delete");
      },
      async deleteComment({ account, commentId, context }) {
        authorize(account, context);
        await deleteObject(commentId, context, "facebook.comments.delete");
      },
      async moderateComment({ account, commentId, hidden, context }) {
        authorize(account, context);
        confirmSuccess(
          await request(`/${encodeURIComponent(commentId)}`, context, { is_hidden: hidden }),
          "facebook.comments.moderate",
          "Facebook did not confirm the comment visibility change.",
        );
      },
      listCommentReplies,
      publishReel,
    },
  });
}
