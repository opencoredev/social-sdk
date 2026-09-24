import { MemoryManagedMediaStore, storedMedia, type ManagedMediaRecord } from "./media.js";

export {
  MemoryManagedMediaStore,
  type ManagedMediaStore,
  type ManagedMediaRecord,
} from "./media.js";

import { defineAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import type {
  AccountRecord,
  AdapterOperationContext,
  BackendPostRef,
  ConnectedAccountRef,
  DeliveryOutcome,
  DeliveryRef,
  JsonObject,
  JsonValue,
  MediaAttachment,
  MediaRef,
  MetricValue,
  Platform,
  PlatformPostRef,
  PreparationIssue,
  ScheduleCancellation,
  ScheduledJobRef,
} from "../core/types.js";
import { definedFields } from "../core/fields.js";
import { remainingBudget } from "../transport/budget.js";
import { httpsUrl, upload } from "../transport/upload.js";
import {
  array,
  isBoolean,
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
  managedHttp,
  managedOptionIssues,
  managedPreparation,
  optionsObject,
  publishFormats,
  selectedPlatforms,
  type ManagedOptions,
  type PublishFormats,
} from "./common.js";

export interface PostFastConnectLinkOptions {
  /** PostFast platform values such as `X` or `INSTAGRAM`. Omit to offer every platform. */
  platforms?: readonly string[];
  /** Days until the link expires. PostFast defaults to 7. */
  expiryDays?: number;
  redirectUrl?: string;
  /** Your own identifier for the person connecting accounts. */
  externalId?: string;
}

const nativePlatforms = new Map<string, Platform>([
  ["X", "x"],
  ["THREADS", "threads"],
  ["BLUESKY", "bluesky"],
  ["YOUTUBE", "youtube"],
  ["TIKTOK", "tiktok"],
  ["INSTAGRAM", "instagram"],
  ["LINKEDIN", "linkedin"],
  ["FACEBOOK", "facebook"],
]);

const mimeTypes = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/mov",
  "video/quicktime",
] as const;

// PostFast's Bluesky guide documents text and image posts only.
const postfastFormats: PublishFormats = (platform) =>
  platform === "bluesky" ? ["text", "image", "carousel"] : publishFormats(platform);

const maxBytes = { image: 10 * 1024 * 1024, video: 250 * 1024 * 1024 } as const;

const tiktokPrivacy = new Map([
  ["PUBLIC_TO_EVERYONE", "PUBLIC"],
  ["MUTUAL_FOLLOW_FRIENDS", "MUTUAL_FRIENDS"],
  ["FOLLOWER_OF_CREATOR", "FOLLOWER_OF_CREATOR"],
  ["SELF_ONLY", "ONLY_ME"],
]);

const reject = (operation: string, message: string): never => {
  throw new SocialError({ code: "invalid_input", operation, message });
};

/** PostFast returns counters as bigint strings. Keep only values a JS number holds exactly. */
function count(value: JsonField): number | undefined {
  const parsed = isString(value) && /^\d+$/.test(value) ? Number(value) : optionalNumber(value);

  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * PostFast managed backend. PostFast only schedules posts, so every target needs a
 * future `schedule.at`. Media is uploaded to PostFast storage and referenced by key.
 */
export function postfast(options: ManagedOptions) {
  const request = managedHttp("https://api.postfa.st", options, (apiKey) => ["pf-api-key", apiKey]);

  const store = options.mediaStore ?? new MemoryManagedMediaStore();
  const clock = () => options.clock?.() ?? new Date();
  const now = () => clock().toISOString();

  const allowHost =
    options.uploadHostAllowed ??
    ((host: string) =>
      host === "s3.amazonaws.com" ||
      (host.startsWith("postfast-uploads.s3.") && host.endsWith(".amazonaws.com")));

  const account = (value: JsonValue, backend: string): AccountRecord | undefined => {
    const row = object(value);
    const slug = nativePlatforms.get(string(row["platform"]));

    if (!slug) return undefined;
    const handle = optionalString(row["platformUsername"]);

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
      status:
        row["connectionStatus"] === "CONNECTED"
          ? "connected"
          : row["connectionStatus"] === "DISABLED"
            ? "reconnect-required"
            : "unknown",
    };
  };

  const accounts = async (context: AdapterOperationContext): Promise<AccountRecord[]> =>
    array(await request("/social-media/my-social-accounts", context)).flatMap((value) => {
      const parsed = account(value, context.backendInstance);

      return parsed ? [parsed] : [];
    });

  /** Read one post record and prove it belongs to the referenced account. */
  const record = async (
    id: string,
    ref: Pick<ConnectedAccountRef, "backend" | "platform" | "accountId">,
    context: AdapterOperationContext,
    operation: string,
  ): Promise<JsonObject> => {
    accountMatches(ref, context);

    if (!id) reject(operation, "A PostFast post identifier is required.");

    const result = object(
      await request("/social-posts", context, undefined, { ids: id, limit: "1" }),
    );

    const row = array(result["data"])
      .map(object)
      .find((item) => item["id"] === id);

    if (!row)
      throw new SocialError({
        code: "not_found",
        operation,
        message: "PostFast has no post with this identifier in the workspace.",
      });

    if (row["socialMediaId"] !== ref.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation,
        message: "The PostFast post does not belong to the authorized account.",
      });

    return row;
  };

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
      case "SCHEDULED":
        if (row["approvalStatus"] === "PENDING_APPROVAL")
          return { ...base, backendState: "SCHEDULED/PENDING_APPROVAL", state: "accepted" };

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
      case "PUBLISHED": {
        const postId = optionalString(row["platformPostId"]);

        if (!postId)
          return {
            ...base,
            state: "unknown",
            reason: "unmapped-state",
            diagnostic: "PostFast reports publication without a native post identifier.",
          };

        return {
          ...base,
          state: "published",
          post: {
            kind: "platform-post",
            version: 1,
            backend: target.backend,
            platform: target.platform,
            accountId: target.accountId,
            postId,
            native: { backendRecordId: id },
          },
        };
      }

      case "FAILED":
        return {
          ...base,
          state: "failed",
          code: "upstream_failure",
          message:
            "PostFast reports that this post failed. Inspect the account connection and the post in PostFast.",
          retryDisposition: { kind: "never" },
        };
      default:
        return {
          ...base,
          state: "unknown",
          reason: "unmapped-state",
          diagnostic: "PostFast returned a post status this adapter does not map.",
        };
    }
  };

  /** Upload bytes to PostFast storage and return the storage key. */
  const uploadBytes = async (
    item: MediaAttachment,
    context: AdapterOperationContext,
  ): Promise<string> => {
    if (item.kind === "document")
      throw new SocialError({
        code: "unsupported_capability",
        operation: "media.upload",
        message: "PostFast accepts image and video media only through this adapter.",
      });

    const source = item.source;

    if (source.kind === "https-url" || source.kind === "media-ref")
      return reject("media.upload", "Only uploadable bytes can be sent to PostFast storage.");
    const mimeType = string(item.mimeType);

    if (!mimeTypes.some((value) => value === mimeType))
      reject("media.upload", "PostFast does not accept this media type.");
    const size = item.byteSize ?? (source.kind === "blob" ? source.blob.size : undefined);

    if (size !== undefined && size > maxBytes[item.kind])
      throw new SocialError({
        code: "media_error",
        operation: "media.upload",
        message: "PostFast accepts images up to 10 MB and videos up to 250 MB.",
      });

    const signed = array(
      await request("/file/get-signed-upload-urls", context, { contentType: mimeType, count: 1 }),
    );

    if (signed.length !== 1)
      throw new SocialError({
        code: "upstream_failure",
        operation: "media.upload",
        message: "PostFast returned an unexpected number of upload URLs.",
      });
    const entry = object(signed[0]);
    const key = string(entry["key"]);

    await upload({
      url: string(entry["signedUrl"]),
      source: {
        mimeType,
        ...definedFields({ size, body: source.kind === "blob" ? source.blob : undefined }),
        open: source.kind === "blob" ? () => source.blob.stream() : source.open,
      },
      allowHost,
      maxBytes: maxBytes[item.kind],
      timeoutMs: remainingBudget(context),
      ...definedFields({ fetch: options.fetch, signal: context.signal }),
    });

    return key;
  };

  const mediaKey = async (
    item: MediaAttachment,
    target: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<string> => {
    if (item.source.kind !== "media-ref") return uploadBytes(item, context);
    const stored = await storedMedia(item, item.source.ref, target, store, options);

    if (!stored.providerKey)
      throw new SocialError({
        code: "media_error",
        operation: "media.resolve",
        message: "This media reference was not uploaded to PostFast storage.",
      });

    return stored.providerKey;
  };

  const adapter = defineAdapter({
    id: "postfast",
    capabilities: capabilityManifest(
      "postfast",
      "REST API, docs fetched 2026-09-24",
      [
        "accounts.read",
        "posts.publish",
        "posts.status",
        "posts.cancelScheduled",
        "posts.deleteBackendRecord",
        "analytics.read",
        "media.upload",
      ],
      postfastFormats,
    ),
    media: {
      async upload(
        item: MediaAttachment,
        target: ConnectedAccountRef,
        context: AdapterOperationContext,
      ): Promise<MediaRef> {
        accountMatches(target, context);

        if (item.kind === "document")
          throw new SocialError({
            code: "unsupported_capability",
            operation: "media.upload",
            message: "PostFast accepts image and video media only through this adapter.",
          });

        if (item.source.kind === "media-ref") {
          await mediaKey(item, target, context);

          return item.source.ref;
        }

        if (!item.mimeType) reject("media.upload", "Provide the asset MIME type.");
        const key = await uploadBytes(item, context);

        const ref: MediaRef = {
          kind: "media",
          version: 1,
          backend: target.backend,
          platform: target.platform,
          accountId: target.accountId,
          mediaId: crypto.randomUUID(),
        };

        // PostFast references uploads by key. The URL without its signature is kept for
        // inspection only and never grants access.
        const stored: ManagedMediaRecord = {
          ref,
          publicUrl: `https://s3.amazonaws.com/postfast-uploads/${key}`,
          providerKey: key,
          kind: item.kind,
          mimeType: string(item.mimeType),
        };

        await store.put(stored);

        return ref;
      },
    },
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

        // PostFast returns every account in one response; page locally.
        const all = await accounts(context);
        const next = offset + limit < all.length ? String(offset + limit) : undefined;

        return {
          items: all.slice(offset, offset + limit),
          ...definedFields({ nextCursor: next }),
        };
      },
      async get(ref: ConnectedAccountRef, context: AdapterOperationContext) {
        accountMatches(ref, context);

        const found = (await accounts(context)).find(
          (item) => item.ref.accountId === ref.accountId && item.ref.platform === ref.platform,
        );

        if (!found)
          throw new SocialError({
            code: "not_found",
            operation: "accounts.read",
            message: "PostFast has no connected account matching this reference.",
          });

        return found;
      },
    },
    posts: {
      prepareTarget(target: Parameters<typeof managedPreparation>[0]) {
        const issues: PreparationIssue[] = [
          ...managedPreparation(target),
          ...managedOptionIssues(target, "postfast"),
        ];

        const fail = (code: string, message: string, severity: "error" | "warning" = "error") =>
          issues.push({ code, message, severity, targetIndex: target.targetIndex });

        const at = target.schedule?.at;

        if (!at)
          fail(
            "schedule.required",
            "PostFast only schedules posts. Set a future schedule time for this target.",
          );
        else if (!(Date.parse(at) > clock().getTime()))
          fail("schedule.past", "PostFast requires a schedule time in the future.");

        const media = target.content.media ?? [];

        for (const item of media) {
          if (item.kind === "document") {
            fail("media.document_unsupported", "PostFast accepts image and video media only.");
            continue;
          }

          if (item.source.kind === "https-url")
            fail(
              "media.url_unsupported",
              "PostFast accepts uploaded files only. Pass the bytes or a PostFast media reference.",
            );

          if (item.mimeType && !mimeTypes.some((value) => value === item.mimeType))
            fail("media.mime_unsupported", "PostFast does not accept this media type.");

          const size =
            item.byteSize ?? (item.source.kind === "blob" ? item.source.blob.size : undefined);

          if (size !== undefined && size > maxBytes[item.kind])
            fail("media.too_large", "PostFast accepts images up to 10 MB and videos up to 250 MB.");

          if (item.altText !== undefined)
            fail(
              "media.alt_text_unsupported",
              "PostFast's post schema does not document alt text. Choose a backend with an explicit accessibility mapping.",
            );
        }

        if (target.account.platform === "bluesky" && media.some((item) => item.kind === "video"))
          fail("bluesky.video_unsupported", "PostFast publishes text and images to Bluesky.");

        const config = optionsObject(target);

        if (
          target.account.platform === "x" &&
          config["replySettings"] !== undefined &&
          config["replySettings"] !== "everyone"
        )
          fail("x.reply_settings_unsupported", "PostFast does not document X reply settings.");

        if (
          target.account.platform === "tiktok" &&
          config["draft"] !== true &&
          media.some((item) => item.kind === "video")
        ) {
          if (config["privacy"] !== "PUBLIC_TO_EVERYONE")
            fail(
              "tiktok.privacy_unsupported",
              "PostFast publishes TikTok videos with the account's default privacy. Save a TikTok draft to keep a video private.",
            );
          else
            fail(
              "tiktok.privacy_account_default",
              "PostFast publishes TikTok videos with the account's default privacy.",
              "warning",
            );
        }

        return issues;
      },
      async publishTarget(
        target: Parameters<typeof managedPreparation>[0],
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        accountMatches(target.account, context);
        const at = target.schedule?.at;

        if (!at || !(Date.parse(at) > clock().getTime()))
          reject("posts.publish", "PostFast requires a future schedule time.");

        const mediaItems: JsonObject[] = [];

        for (const [index, item] of (target.content.media ?? []).entries())
          mediaItems.push({
            key: await mediaKey(item, target.account, context),
            type: item.kind === "video" ? "VIDEO" : "IMAGE",
            sortOrder: index,
          });

        const config = optionsObject(target);
        const controls: Record<string, JsonValue> = {};

        if (target.account.platform === "youtube") {
          controls["youtubeTitle"] = string(config["title"]);
          controls["youtubePrivacy"] = string(config["visibility"]).toUpperCase();

          const madeForKids = config["madeForKids"];

          if (isBoolean(madeForKids)) controls["youtubeMadeForKids"] = madeForKids;
        }

        if (target.account.platform === "instagram" && isBoolean(config["shareToFeed"]))
          controls["instagramPostToGrid"] = config["shareToFeed"];

        if (target.account.platform === "tiktok") {
          const privacy = tiktokPrivacy.get(String(config["privacy"]));

          if (privacy) controls["tiktokPrivacy"] = privacy;

          // prepareTarget requires every one of these choices to be a boolean.
          for (const [nativeKey, optionKey, negate] of [
            ["tiktokAllowComments", "disableComments", true],
            ["tiktokAllowDuet", "disableDuet", true],
            ["tiktokAllowStitch", "disableStitch", true],
            ["tiktokBrandOrganic", "ownBrand", false],
            ["tiktokBrandContent", "brandedContent", false],
            ["tiktokIsAigc", "aiGenerated", false],
            ["tiktokIsDraft", "draft", false],
          ] as const) {
            const value = config[optionKey];

            if (isBoolean(value)) controls[nativeKey] = negate ? !value : value;
          }
        }

        // Media uploads can outlast a near schedule, and PostFast rejects a past time.
        if (!(Date.parse(string(at)) > clock().getTime()))
          reject("posts.publish", "The schedule time passed while media uploaded.");

        const response = object(
          await request("/social-posts", context, {
            posts: [
              {
                content: target.content.text ?? "",
                socialMediaId: target.account.accountId,
                scheduledAt: new Date(string(at)).toISOString(),
                ...definedFields({ mediaItems: mediaItems.length ? mediaItems : undefined }),
              },
            ],
            status: "SCHEDULED",
            ...definedFields({
              controls: Object.keys(controls).length ? controls : undefined,
            }),
          }),
        );

        const ids = array(response["postIds"]);
        const id = ids.length === 1 && isString(ids[0]) ? ids[0] : undefined;

        if (!id)
          return {
            state: "unknown",
            reason: "ambiguous-submission",
            diagnostic: "PostFast did not return exactly one post identifier.",
            targetIndex: target.targetIndex,
            account: target.account,
            observedAt: now(),
          };

        try {
          return outcome(
            await record(id, target.account, context, "posts.publish"),
            target.account,
            target.targetIndex,
          );
        } catch (error) {
          // A post was written, so an ownership mismatch stays an uncertain write instead of an error.
          if (error instanceof SocialError && error.code === "unauthorized")
            return {
              state: "unknown",
              reason: "ambiguous-submission",
              diagnostic: "PostFast returned a post that does not belong to the requested account.",
              targetIndex: target.targetIndex,
              account: target.account,
              observedAt: now(),
            };

          // Keep the created post visible even if the follow-up read fails.
          return {
            state: "accepted",
            targetIndex: target.targetIndex,
            account: target.account,
            delivery: {
              kind: "delivery",
              version: 1,
              backend: target.account.backend,
              platform: target.account.platform,
              accountId: target.account.accountId,
              deliveryId: id,
            },
            observedAt: now(),
          };
        }
      },
      async getDelivery(
        ref: { deliveryId: string; accountId: string; platform: string; backend: string },
        context: AdapterOperationContext,
      ) {
        const slug = selectedPlatforms.find((value) => value === ref.platform);

        if (!slug) return reject("posts.status", "This platform is outside PostFast coverage.");

        const target: ConnectedAccountRef = {
          kind: "connected-account",
          version: 1,
          backend: ref.backend,
          platform: slug,
          accountId: ref.accountId,
        };

        return outcome(await record(ref.deliveryId, target, context, "posts.status"), target, 0);
      },
      async cancelScheduled(
        ref: ScheduledJobRef,
        context: AdapterOperationContext,
      ): Promise<ScheduleCancellation> {
        const row = await record(ref.jobId, ref, context, "posts.cancelScheduled");
        const scheduledAt = optionalString(row["scheduledAt"]);

        if (
          row["status"] !== "SCHEDULED" ||
          !scheduledAt ||
          !(Date.parse(scheduledAt) > clock().getTime())
        )
          reject(
            "posts.cancelScheduled",
            "Only a future scheduled post can be cancelled. Reconcile a due or dispatched post.",
          );

        await remove(ref.jobId, context);

        return { state: "cancelled", backendRecord: "deleted" };
      },
      async deleteBackendRecord(ref: BackendPostRef, context: AdapterOperationContext) {
        const row = await record(ref.recordId, ref, context, "posts.deleteBackendRecord");

        if (row["status"] !== "FAILED")
          reject(
            "posts.deleteBackendRecord",
            "PostFast deletes failed records here. Cancel a future schedule explicitly; this never removes a published post.",
          );

        await remove(ref.recordId, context);
      },
    },
    analytics: {
      async getPostMetrics(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        const id = optionalString(ref.native?.["backendRecordId"]);

        if (!id)
          reject(
            "analytics.read",
            "PostFast metrics need the post reference returned by publish or status reads.",
          );
        const row = await record(string(id), ref, context, "analytics.read");
        const publishedAt = optionalString(row["publishedAt"]);

        if (row["platformPostId"] !== ref.postId || !publishedAt || !Date.parse(publishedAt))
          reject("analytics.read", "The PostFast record does not identify this published post.");

        const published = Date.parse(string(publishedAt));
        const day = 24 * 60 * 60 * 1000;

        const result = object(
          await request("/social-posts/analytics", context, undefined, {
            startDate: new Date(published - day).toISOString(),
            endDate: new Date(published + day).toISOString(),
            socialMediaIds: ref.accountId,
          }),
        );

        const match = array(result["data"])
          .map(object)
          .find(
            (item) =>
              item["id"] === id &&
              item["platformPostId"] === ref.postId &&
              item["socialMediaId"] === ref.accountId,
          );

        if (!match || match["latestMetric"] === null || match["latestMetric"] === undefined)
          return [];
        const metrics = object(match["latestMetric"]);
        const values: MetricValue[] = [];

        const push = (name: string, value: number | undefined, unit: MetricValue["unit"]) => {
          if (value === undefined) return;
          values.push({
            name,
            value,
            unit,
            period: "lifetime",
            fetchedAt: now(),
            freshness: "unknown",
            source: `postfast:${ref.platform}:analytics`,
          });
        };

        for (const [name, key] of [
          ["likes", "likes"],
          ["comments", "comments"],
          ["shares", "shares"],
          ["impressions", "impressions"],
          ["reach", "reach"],
          ["interactions", "totalInteractions"],
          ["views", "videoViews"],
        ] as const)
          push(name, count(metrics[key]), "count");

        push("averageWatchTime", optionalNumber(metrics["avgWatchTimeSeconds"]), "seconds");
        push("totalWatchTime", optionalNumber(metrics["totalWatchTimeSeconds"]), "seconds");
        push("saveRate", optionalNumber(metrics["saveRate"]), "percentage");

        return values;
      },
    },
    native: {
      /** Create a hosted link where someone connects their social accounts to your workspace. */
      async createConnectLink(input: PostFastConnectLinkOptions, context: AdapterOperationContext) {
        for (const value of input.platforms ?? [])
          if (!nativePlatforms.has(value))
            reject("accounts.connect", "Choose PostFast platforms this adapter supports.");

        if (input.redirectUrl !== undefined) httpsUrl(input.redirectUrl);

        const result = object(
          await request("/social-media/connect-link", context, {
            ...definedFields({
              platforms: input.platforms ? [...input.platforms] : undefined,
              expiryDays: input.expiryDays,
              redirectUrl: input.redirectUrl || undefined,
              externalId: input.externalId || undefined,
            }),
          }),
        );

        return { url: httpsUrl(string(result["connectUrl"])).href };
      },
    },
  });

  async function remove(id: string, context: AdapterOperationContext): Promise<void> {
    const result = object(
      await request(`/social-posts/${encodeURIComponent(id)}`, context, undefined, {}, "DELETE"),
    );

    if (result["deleted"] !== true)
      throw new SocialError({
        code: "ambiguous_outcome",
        operation: "posts.lifecycle",
        message: "PostFast did not confirm the deletion. Reconcile before retrying.",
        retryDisposition: { kind: "reconcile-first" },
      });
  }

  return adapter;
}
