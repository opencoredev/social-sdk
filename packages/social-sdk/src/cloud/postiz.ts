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
import { createHttp, HttpError, type HttpOptions } from "../transport/http.js";
import { httpsUrl } from "../transport/upload.js";
import {
  array,
  isJsonArray,
  isString,
  object,
  optionalNumber,
  optionalString,
  string,
} from "../transport/validation.js";
import {
  accountMatches,
  capabilityManifest,
  managedHttp,
  managedOptionIssues,
  managedPreparation,
  optionsObject,
  selectedPlatforms,
  type ManagedOptions,
} from "./common.js";

export interface PostizOptions extends ManagedOptions {
  /**
   * Public API base URL. Defaults to Postiz Cloud. A self-hosted Docker instance serves
   * the public API at `https://<your-host>/api/public/v1`.
   */
  readonly baseUrl?: string;
}

export interface PostizConnectLinkOptions {
  /** Postiz provider identifier, such as `x`, `linkedin-page`, or `tiktok`. */
  provider: string;
  /** Postiz channel ID to reconnect instead of adding a new channel. */
  refreshAccountId?: string;
}

export interface PostizAuthorizationUrlOptions {
  /** Client ID of your Postiz OAuth app, starting with `pca_`. */
  readonly clientId: string;
  /** Unguessable value you store with the user's session and compare on the callback. */
  readonly state: string;
  /**
   * Postiz web app origin. Defaults to Postiz Cloud at `https://platform.postiz.com`.
   * For a self-hosted instance, pass your Postiz host, such as `https://postiz.example.com`.
   */
  readonly frontendUrl?: string;
}

export interface PostizCodeExchangeOptions extends HttpOptions {
  /** Client ID of your Postiz OAuth app, starting with `pca_`. */
  readonly clientId: string;
  /** Client secret of your Postiz OAuth app, starting with `pcs_`. Keep it on your server. */
  readonly clientSecret: string;
  /** The `code` query parameter Postiz sent to your redirect URL. It is single-use. */
  readonly code: string;
  /** The same public API base URL you pass to `postiz()`. Defaults to Postiz Cloud. */
  readonly baseUrl?: string;
  readonly signal?: AbortSignal;
}

export interface PostizAccessToken {
  /** Workspace token starting with `pos_`. Pass it to `postiz()` as `apiKey`. */
  readonly accessToken: string;
  /** ID of the Postiz workspace that approved the app. */
  readonly organizationId?: string;
  readonly scope?: string;
}

const cloudBaseUrl = "https://api.postiz.com/public/v1";

const cloudFrontendUrl = "https://platform.postiz.com";

const groupPrefix = "social-sdk-";

const nativePlatforms = new Map<string, Platform>([
  ["x", "x"],
  ["threads", "threads"],
  ["bluesky", "bluesky"],
  ["youtube", "youtube"],
  ["tiktok", "tiktok"],
  ["tiktok-business", "tiktok"],
  ["instagram", "instagram"],
  ["instagram-standalone", "instagram"],
  ["linkedin", "linkedin"],
  ["linkedin-page", "linkedin"],
  ["facebook", "facebook"],
]);

// Bluesky connects with an app password entered in Postiz, so it has no OAuth link.
const oauthProviders = [...nativePlatforms.keys()].filter((value) => value !== "bluesky");

const mimeTypes = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/tiff",
  "video/mp4",
] as const;

const maxBytes = { image: 10 * 1024 * 1024, video: 1024 * 1024 * 1024 } as const;

// Postiz imports remote media only from URLs with these extensions.
const urlExtension = /\.(png|jpe?g|gif|webp|mp4)$/i;

const recordId = /^[A-Za-z0-9_-]{1,128}$/;

const day = 24 * 60 * 60 * 1000;

const reject = (operation: string, message: string): never => {
  throw new SocialError({ code: "invalid_input", operation, message });
};

function baseUrl(value: string | undefined): string {
  let url: URL | undefined;

  try {
    url = new URL(value ?? cloudBaseUrl);
  } catch {
    url = undefined;
  }

  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new SocialError({
      code: "invalid_config",
      operation: "createAdapter",
      message: "Configure the Postiz public API base URL as an HTTPS URL without credentials.",
    });

  return url.href.replace(/\/+$/, "");
}

/**
 * Postiz lists posts by publish date only, so identifiers carry the submitted time:
 * `<postiz post id>@<ISO time>`. Treat them as opaque.
 */
function encodeId(postId: string, at: string): string {
  return `${postId}@${at}`;
}

interface PostizRecordId {
  postId: string;
  at: number;
}

function decodeId(value: string, operation: string): PostizRecordId {
  const split = value.lastIndexOf("@");
  const postId = value.slice(0, split);
  const at = Date.parse(value.slice(split + 1));

  if (split < 1 || !recordId.test(postId) || !Number.isFinite(at))
    reject(operation, "Use the Postiz delivery, job, or record identifier the adapter returned.");

  return { postId, at };
}

/** Postiz analytics labels such as `Impressions` or `Link Clicks`, as camelCase names. */
function metricName(label: string): string {
  const words = label.toLowerCase().match(/[a-z0-9]+/g) ?? [];

  return words
    .map((word, index) => (index === 0 ? word : word[0]?.toUpperCase() + word.slice(1)))
    .join("");
}

async function bytes(item: MediaAttachment, limit: number, signal?: AbortSignal): Promise<Blob> {
  const source = item.source;

  // A Blob without a type would reach Postiz as application/octet-stream.
  if (source.kind === "blob")
    return source.blob.type
      ? source.blob
      : new Blob([source.blob], { type: string(item.mimeType) });

  if (source.kind !== "stream")
    return reject("media.upload", "Only uploadable bytes can be sent to Postiz storage.");

  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const reader = source.open().getReader();

  // A stalled stream never settles a read, so cancelling it is what ends the wait.
  const abort = () => void reader.cancel().catch(() => undefined);

  signal?.addEventListener("abort", abort, { once: true });

  const cancelled = () =>
    new SocialError({
      code: "cancelled",
      operation: "media.upload",
      message: "The media upload was cancelled.",
    });

  try {
    if (signal?.aborted) throw cancelled();

    for (;;) {
      const { done, value } = await reader.read();

      // Cancelling the reader ends the read as if the stream were done.
      if (signal?.aborted) throw cancelled();

      if (done) break;
      size += value.byteLength;

      if (size > limit)
        throw new SocialError({
          code: "media_error",
          operation: "media.upload",
          message: "Postiz accepts images up to 10 MB and MP4 videos up to 1 GB.",
        });
      chunks.push(new Uint8Array(value));
    }
  } catch (error) {
    // Do not wait: a source's cancel callback may never settle.
    abort();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }

  return new Blob(chunks, { type: string(item.mimeType) });
}

/**
 * Postiz managed backend, for Postiz Cloud or a self-hosted instance. Posts publish
 * immediately or at `schedule.at`. Media is uploaded to Postiz and referenced by ID and path.
 */
export function postiz(options: PostizOptions) {
  const request = managedHttp(baseUrl(options.baseUrl), options, (apiKey) => [
    "Authorization",
    apiKey,
  ]);

  const store = options.mediaStore ?? new MemoryManagedMediaStore();
  const clock = () => options.clock?.() ?? new Date();
  const now = () => clock().toISOString();

  const account = (value: JsonValue, backend: string): AccountRecord | undefined => {
    const row = object(value);
    const slug = nativePlatforms.get(string(row["identifier"]));

    if (!slug) return undefined;
    const handle = optionalString(row["profile"]);

    return {
      ref: {
        kind: "connected-account",
        version: 1,
        backend,
        platform: slug,
        accountId: string(row["id"]),
      },
      displayName: optionalString(row["name"]) || handle || string(row["id"]),
      ...definedFields({ handle: handle || undefined }),
      // Postiz reports a disabled channel without saying why.
      status: row["disabled"] === true ? "unknown" : "connected",
    };
  };

  const accounts = async (context: AdapterOperationContext): Promise<AccountRecord[]> =>
    array(await request("/integrations", context)).flatMap((value) => {
      const parsed = account(value, context.backendInstance);

      return parsed ? [parsed] : [];
    });

  /** Posts published within a day of `at`, the only way the public API lists posts. */
  const around = async (at: number, context: AdapterOperationContext): Promise<JsonObject[]> =>
    array(
      object(
        await request("/posts", context, undefined, {
          startDate: new Date(at - day).toISOString(),
          endDate: new Date(at + day).toISOString(),
        }),
      )["posts"],
    ).map(object);

  /** Read one post and prove it belongs to the referenced account. */
  const record = async (
    id: string,
    ref: Pick<ConnectedAccountRef, "backend" | "platform" | "accountId">,
    context: AdapterOperationContext,
    operation: string,
  ): Promise<{ row: JsonObject; nearby: JsonObject[] }> => {
    accountMatches(ref, context);
    const { postId, at } = decodeId(id, operation);
    const nearby = await around(at, context);
    const row = nearby.find((item) => item["id"] === postId);

    if (!row)
      throw new SocialError({
        code: "not_found",
        operation,
        message:
          "Postiz has no post with this identifier near its submitted time. It may be deleted or rescheduled.",
      });

    const integration = object(row["integration"]);

    if (
      integration["id"] !== ref.accountId ||
      nativePlatforms.get(string(integration["providerIdentifier"])) !== ref.platform
    )
      throw new SocialError({
        code: "unauthorized",
        operation,
        message: "The Postiz post does not belong to the authorized account.",
      });

    return { row, nearby };
  };

  const outcome = (
    row: JsonObject,
    id: string,
    target: ConnectedAccountRef,
    targetIndex: number,
  ): DeliveryOutcome => {
    const state = optionalString(row["state"]) ?? "unknown";

    const delivery: DeliveryRef = {
      kind: "delivery",
      version: 1,
      backend: target.backend,
      platform: target.platform,
      accountId: target.accountId,
      deliveryId: id,
    };

    const base = { targetIndex, account: target, delivery, backendState: state, observedAt: now() };

    switch (state) {
      case "QUEUE": {
        const publishDate = Date.parse(optionalString(row["publishDate"]) ?? "");

        if (!Number.isFinite(publishDate))
          return {
            ...base,
            state: "unknown",
            reason: "unmapped-state",
            diagnostic: "Postiz returned a queued post without a valid publish date.",
          };

        if (publishDate <= clock().getTime()) return { ...base, state: "processing" };

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
      }

      case "PUBLISHED": {
        const postId = optionalString(row["releaseId"]);
        const url = optionalString(row["releaseURL"]);

        // TikTok can publish without returning an ID; Postiz stores "missing" until resolved.
        if (!postId || postId === "missing")
          return {
            ...base,
            state: "unknown",
            reason: "unmapped-state",
            diagnostic:
              "Postiz reports publication without a native post identifier. Resolve it in Postiz.",
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
          ...definedFields({ url: url || undefined }),
        };
      }

      case "ERROR":
        return {
          ...base,
          state: "failed",
          code: "upstream_failure",
          message:
            "Postiz reports that this post failed. Its API does not return the reason; inspect the post and channel in Postiz.",
          retryDisposition: { kind: "never" },
        };
      case "DRAFT":
        return { ...base, state: "accepted" };
      default:
        return {
          ...base,
          state: "unknown",
          reason: "unmapped-state",
          diagnostic: "Postiz returned a post state this adapter does not map.",
        };
    }
  };

  /** Upload to Postiz storage and return the media ID and path a post references. */
  const uploadMedia = async (
    item: MediaAttachment,
    context: AdapterOperationContext,
  ): Promise<{ id: string; path: string }> => {
    if (item.kind === "document")
      throw new SocialError({
        code: "unsupported_capability",
        operation: "media.upload",
        message: "Postiz accepts image and video media only through this adapter.",
      });

    const mimeType = string(item.mimeType);

    if (!mimeTypes.some((value) => value === mimeType))
      reject("media.upload", "Postiz does not accept this media type.");

    let result: JsonValue;

    if (item.source.kind === "https-url") {
      const url = httpsUrl(item.source.url);

      if (!urlExtension.test(url.pathname))
        reject(
          "media.upload",
          "Postiz imports URLs ending in .png, .jpg, .jpeg, .gif, .webp, or .mp4.",
        );

      result = await request("/upload-from-url", context, { url: url.href });
    } else {
      const size = item.source.kind === "blob" ? item.source.blob.size : item.byteSize;

      if (size !== undefined && size > maxBytes[item.kind])
        throw new SocialError({
          code: "media_error",
          operation: "media.upload",
          message: "Postiz accepts images up to 10 MB and MP4 videos up to 1 GB.",
        });

      const form = new FormData();
      form.set(
        "file",
        await bytes(item, maxBytes[item.kind], context.signal),
        item.filename ?? "upload",
      );
      result = await request("/upload", context, form);
    }

    const row = object(result);

    return { id: string(row["id"]), path: httpsUrl(string(row["path"])).href };
  };

  const resolveMedia = async (
    item: MediaAttachment,
    target: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<{ id: string; path: string }> => {
    if (item.source.kind !== "media-ref") return uploadMedia(item, context);
    const stored = await storedMedia(item, item.source.ref, target, store, options);

    if (!stored.providerKey)
      throw new SocialError({
        code: "media_error",
        operation: "media.resolve",
        message: "This media reference was not uploaded to Postiz.",
      });

    return { id: stored.providerKey, path: stored.publicUrl };
  };

  /** The provider settings Postiz validates for each channel type. */
  const settings = (target: Parameters<typeof managedPreparation>[0]): JsonObject => {
    const config = optionsObject(target);

    switch (target.account.platform) {
      case "x":
        return { who_can_reply_post: String(config["replySettings"] ?? "everyone") };
      case "instagram":
        return { post_type: "post" };
      case "youtube":
        return {
          title: string(config["title"]),
          type: string(config["visibility"]),
          selfDeclaredMadeForKids: config["madeForKids"] === true ? "yes" : "no",
        };
      case "tiktok":
        return {
          privacy_level: string(config["privacy"]),
          // Postiz names the allowed interaction; Social SDK names the disabled one.
          duet: config["disableDuet"] !== true,
          stitch: config["disableStitch"] !== true,
          comment: config["disableComments"] !== true,
          autoAddMusic: "no",
          brand_content_toggle: config["brandedContent"] === true,
          brand_organic_toggle: config["ownBrand"] === true,
          video_made_with_ai: config["aiGenerated"] === true,
          content_posting_method: config["draft"] === true ? "UPLOAD" : "DIRECT_POST",
        };
      default:
        return {};
    }
  };

  const adapter = defineAdapter({
    id: "postiz",
    capabilities: capabilityManifest("postiz", "Public API v1, source 374fb20 read 2026-09-25", [
      "accounts.read",
      "posts.publish",
      "posts.status",
      "posts.cancelScheduled",
      "posts.deleteBackendRecord",
      "analytics.read",
      "media.upload",
    ]),
    media: {
      async upload(
        item: MediaAttachment,
        target: ConnectedAccountRef,
        context: AdapterOperationContext,
      ): Promise<MediaRef> {
        accountMatches(target, context);

        if (item.source.kind === "media-ref") {
          await resolveMedia(item, target, context);

          return item.source.ref;
        }

        if (!item.mimeType) reject("media.upload", "Provide the asset MIME type.");

        if (item.kind === "document")
          throw new SocialError({
            code: "unsupported_capability",
            operation: "media.upload",
            message: "Postiz accepts image and video media only through this adapter.",
          });
        const uploaded = await uploadMedia(item, context);

        const ref: MediaRef = {
          kind: "media",
          version: 1,
          backend: target.backend,
          platform: target.platform,
          accountId: target.accountId,
          mediaId: crypto.randomUUID(),
        };

        const stored: ManagedMediaRecord = {
          ref,
          publicUrl: uploaded.path,
          providerKey: uploaded.id,
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

        // Postiz returns every channel in one response; page locally.
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
            message: "Postiz has no connected channel matching this reference.",
          });

        return found;
      },
    },
    posts: {
      prepareTarget(target: Parameters<typeof managedPreparation>[0]) {
        const issues: PreparationIssue[] = [
          ...managedPreparation(target),
          ...managedOptionIssues(target, "postiz"),
        ];

        const fail = (code: string, message: string, severity: "error" | "warning" = "error") =>
          issues.push({ code, message, severity, targetIndex: target.targetIndex });

        const at = target.schedule?.at;

        if (at !== undefined && !(Date.parse(at) > clock().getTime()))
          fail("schedule.past", "Postiz needs a future schedule time. Omit it to publish now.");

        for (const item of target.content.media ?? []) {
          if (item.kind === "document") {
            fail("media.document_unsupported", "Postiz accepts image and video media only.");
            continue;
          }

          if (item.mimeType && !mimeTypes.some((value) => value === item.mimeType))
            fail(
              "media.mime_unsupported",
              "Postiz accepts JPEG, PNG, GIF, WebP, AVIF, BMP, and TIFF images and MP4 videos.",
            );

          if (item.source.kind === "https-url") {
            let path = "";

            try {
              path = new URL(item.source.url).pathname;
            } catch {
              // managedPreparation reports the invalid URL.
            }

            if (path && !urlExtension.test(path))
              fail(
                "media.url_extension",
                "Postiz imports URLs ending in .png, .jpg, .jpeg, .gif, .webp, or .mp4. Upload the bytes instead.",
              );
          }

          const size = item.source.kind === "blob" ? item.source.blob.size : item.byteSize;

          if (size !== undefined && size > maxBytes[item.kind])
            fail("media.too_large", "Postiz accepts images up to 10 MB and MP4 videos up to 1 GB.");
        }

        const config = optionsObject(target);

        if (target.account.platform === "instagram" && config["shareToFeed"] === false)
          fail(
            "instagram.share_to_feed_unsupported",
            "Postiz has no setting to keep an Instagram reel off the grid.",
          );

        if (target.account.platform === "tiktok" && config["draft"] === true)
          fail(
            "tiktok.draft_settings_ignored",
            "TikTok keeps only the caption for inbox drafts. Privacy, interaction, and disclosure choices apply when the creator posts it.",
            "warning",
          );

        return issues;
      },
      async publishTarget(
        target: Parameters<typeof managedPreparation>[0],
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        accountMatches(target.account, context);
        const at = target.schedule?.at;

        if (at !== undefined && !(Date.parse(at) > clock().getTime()))
          reject("posts.publish", "Postiz needs a future schedule time.");

        const image: JsonObject[] = [];

        for (const item of target.content.media ?? []) {
          const media = await resolveMedia(item, target.account, context);

          image.push({ ...media, ...definedFields({ alt: item.altText }) });
        }

        // Media uploads can outlast a near schedule.
        if (at !== undefined && !(Date.parse(at) > clock().getTime()))
          reject("posts.publish", "The schedule time passed while media uploaded.");

        const date = at === undefined ? now() : new Date(at).toISOString();

        const response = await request("/posts", context, {
          type: at === undefined ? "now" : "schedule",
          date,
          shortLink: false,
          tags: [],
          posts: [
            {
              integration: { id: target.account.accountId },
              value: [{ content: target.content.text ?? "", image }],
              // A fresh group per target keeps deletion from reaching any other post.
              group: `${groupPrefix}${crypto.randomUUID()}`,
              settings: settings(target),
            },
          ],
        });

        const rows = isJsonArray(response) ? response.map(object) : [];
        const created = rows[0];
        const postId = rows.length === 1 ? optionalString(created?.["postId"]) : undefined;

        if (
          !postId ||
          !recordId.test(postId) ||
          (created?.["integration"] !== undefined &&
            created["integration"] !== target.account.accountId)
        )
          return {
            state: "unknown",
            reason: "ambiguous-submission",
            diagnostic: "Postiz did not return exactly one post for the requested channel.",
            targetIndex: target.targetIndex,
            account: target.account,
            observedAt: now(),
          };

        const id = encodeId(postId, date);

        try {
          const { row } = await record(id, target.account, context, "posts.publish");

          return outcome(row, id, target.account, target.targetIndex);
        } catch (error) {
          // Postiz created a post, but not on the requested channel. Reconcile before retrying.
          if (error instanceof SocialError && error.code === "unauthorized")
            return {
              state: "unknown",
              reason: "ambiguous-submission",
              diagnostic: "Postiz created the post on a different channel. Reconcile it in Postiz.",
              targetIndex: target.targetIndex,
              account: target.account,
              observedAt: now(),
            };

          // Postiz queues every post it creates, so report the queued state if the read fails.
          return outcome(
            { state: "QUEUE", publishDate: date },
            id,
            target.account,
            target.targetIndex,
          );
        }
      },
      async getDelivery(
        ref: { deliveryId: string; accountId: string; platform: string; backend: string },
        context: AdapterOperationContext,
      ) {
        const slug = selectedPlatforms.find((value) => value === ref.platform);

        if (!slug) return reject("posts.status", "This platform is outside Postiz coverage.");

        const target: ConnectedAccountRef = {
          kind: "connected-account",
          version: 1,
          backend: ref.backend,
          platform: slug,
          accountId: ref.accountId,
        };

        const { row } = await record(ref.deliveryId, target, context, "posts.status");

        return outcome(row, ref.deliveryId, target, 0);
      },
      async cancelScheduled(
        ref: ScheduledJobRef,
        context: AdapterOperationContext,
      ): Promise<ScheduleCancellation> {
        const { row, nearby } = await record(ref.jobId, ref, context, "posts.cancelScheduled");
        const publishDate = Date.parse(optionalString(row["publishDate"]) ?? "");

        if (row["state"] !== "QUEUE" || !(publishDate > clock().getTime()))
          reject(
            "posts.cancelScheduled",
            "Only a future scheduled post can be cancelled. Reconcile a due or dispatched post.",
          );

        await remove(row, nearby, "posts.cancelScheduled", context);

        return { state: "cancelled", backendRecord: "deleted" };
      },
      async deleteBackendRecord(ref: BackendPostRef, context: AdapterOperationContext) {
        const { row, nearby } = await record(
          ref.recordId,
          ref,
          context,
          "posts.deleteBackendRecord",
        );

        if (row["state"] !== "ERROR" && row["state"] !== "DRAFT")
          reject(
            "posts.deleteBackendRecord",
            "Postiz deletes failed or draft records here. Cancel a future schedule explicitly; this never removes a published post.",
          );

        await remove(row, nearby, "posts.deleteBackendRecord", context);
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
            "Postiz metrics need the post reference returned by publish or status reads.",
          );
        const { row } = await record(string(id), ref, context, "analytics.read");

        if (row["state"] !== "PUBLISHED" || row["releaseId"] !== ref.postId)
          reject("analytics.read", "The Postiz record does not identify this published post.");

        const result = await request(
          `/analytics/post/${encodeURIComponent(string(row["id"]))}`,
          context,
          undefined,
          { date: "30" },
        );

        // Postiz returns `{ missing: true }` while a TikTok post ID is unresolved.
        if (!isJsonArray(result)) return [];

        const values: MetricValue[] = [];

        for (const entry of result.map(object)) {
          const name = metricName(optionalString(entry["label"]) ?? "");
          const points = array(entry["data"] ?? []).map(object);
          const latest = points.at(-1);
          const total = latest?.["total"];

          const value =
            isString(total) && total.trim() !== ""
              ? optionalNumber(Number(total))
              : optionalNumber(total);

          if (!name || value === undefined) continue;

          const measured = Date.parse(optionalString(latest?.["date"]) ?? "");

          values.push({
            name,
            value,
            unit: "count",
            // Providers report either a running total or a daily value; Postiz does not say which.
            period: "unknown",
            fetchedAt: now(),
            freshness: "unknown",
            source: `postiz:${ref.platform}:analytics`,
            ...definedFields({
              measuredAt: Number.isFinite(measured) ? new Date(measured).toISOString() : undefined,
            }),
          });
        }

        return values;
      },
    },
    native: {
      /**
       * Create a Postiz OAuth link where someone connects a channel to your workspace. The
       * link is valid for one hour and needs no Postiz login.
       */
      async createConnectLink(input: PostizConnectLinkOptions, context: AdapterOperationContext) {
        if (!oauthProviders.includes(input.provider))
          reject(
            "accounts.connect",
            "Choose an OAuth provider this adapter supports. Connect Bluesky in the Postiz dashboard.",
          );

        if (input.refreshAccountId !== undefined && !recordId.test(input.refreshAccountId))
          reject("accounts.connect", "Use a Postiz channel ID to reconnect.");

        const result = object(
          await request(
            `/social/${encodeURIComponent(input.provider)}`,
            context,
            undefined,
            input.refreshAccountId ? { refresh: input.refreshAccountId } : {},
          ),
        );

        return { url: httpsUrl(string(result["url"])).href };
      },
    },
  });

  /**
   * Postiz deletes a post's whole group. Only a group this adapter created holds a single
   * post, and the listing covers only nearby dates, so refuse any other group.
   */
  async function remove(
    row: JsonObject,
    nearby: readonly JsonObject[],
    operation: string,
    context: AdapterOperationContext,
  ): Promise<void> {
    const group = optionalString(row["group"]);

    if (
      !group?.startsWith(groupPrefix) ||
      nearby.some((item) => item["group"] === group && item["id"] !== row["id"])
    )
      reject(
        operation,
        "Social SDK did not create this Postiz post alone in its group, and deleting it could remove other posts. Manage it in Postiz.",
      );

    const result = await request(
      `/posts/${encodeURIComponent(string(row["id"]))}`,
      context,
      undefined,
      {},
      "DELETE",
    );

    // Postiz answers with the group's first post, which is this one for an adapter group.
    if (!isJsonArray(result) && result !== null && object(result)["id"] === row["id"]) return;

    throw new SocialError({
      code: "ambiguous_outcome",
      operation: "posts.lifecycle",
      message: "Postiz did not confirm the deletion. Reconcile before retrying.",
      retryDisposition: { kind: "reconcile-first" },
    });
  }

  return adapter;
}

/**
 * Build the Postiz URL that asks a person to approve your OAuth app for one of their
 * workspaces. Postiz then redirects to the Redirect URL saved on the app with `code` and
 * `state`, or with `error=access_denied` when the person declines.
 */
export function postizAuthorizationUrl(options: PostizAuthorizationUrlOptions): string {
  const operation = "postiz.authorizationUrl";

  if (!options.clientId.trim() || !options.state.trim())
    throw new SocialError({
      code: "invalid_config",
      operation,
      message: "Pass the Postiz OAuth client ID and a non-empty state value.",
    });

  const url = new URL(
    "/oauth/authorize",
    originUrl(options.frontendUrl ?? cloudFrontendUrl, operation),
  );

  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", options.state);

  return url.href;
}

/**
 * Exchange the authorization code from your redirect URL for a Postiz workspace token.
 * The code is single-use and expires after 10 minutes. The token does not expire; the
 * workspace owner revokes it in Postiz under Settings, Approved Apps.
 */
export async function exchangePostizCode(
  options: PostizCodeExchangeOptions,
): Promise<PostizAccessToken> {
  const operation = "postiz.exchangeCode";

  if (!options.clientId.trim() || !options.clientSecret.trim())
    throw new SocialError({
      code: "invalid_config",
      operation,
      message: "Configure the Postiz OAuth client ID and client secret.",
    });

  if (!options.code.trim())
    reject(operation, "Pass the authorization code from the Postiz redirect.");

  // The OAuth routes sit beside the public API: `/public/v1` becomes `/oauth/token`.
  const url = new URL(baseUrl(options.baseUrl).replace(/\/public\/v1$/, "") + "/oauth/token");
  let response: JsonValue;

  try {
    response = await createHttp(options)({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: options.code,
        client_id: options.clientId,
        client_secret: options.clientSecret,
      }),
      ...definedFields({ signal: options.signal }),
    });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;

    throw exchangeError(error, operation);
  }

  const row = object(response);
  const accessToken = optionalString(row["access_token"]);

  if (!accessToken?.startsWith("pos_"))
    throw new SocialError({
      code: "upstream_failure",
      operation,
      message: "Postiz did not return a workspace token. Start the authorization again.",
    });

  return {
    accessToken,
    ...definedFields({
      organizationId: optionalString(row["id"]),
      scope: optionalString(row["scope"]),
    }),
  };
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
      message: "Configure the Postiz web app URL as an HTTPS URL without credentials.",
    });

  return url;
}

function exchangeError(error: HttpError, operation: string): SocialError {
  // Postiz answers 401 for an unknown client or wrong secret and 400 for a code that is
  // expired, already used, or issued to another app. Messages never repeat the code.
  if (error.status === 401)
    return new SocialError({
      code: "invalid_config",
      operation,
      message: "Postiz rejected the OAuth client ID or secret.",
      upstreamStatus: 401,
    });

  if (error.status === 400)
    return new SocialError({
      code: "invalid_input",
      operation,
      message:
        "Postiz rejected the authorization code. It may be expired, used, or from another app. Start the authorization again.",
      upstreamStatus: 400,
    });

  if (error.status === 429)
    return new SocialError({
      code: "rate_limited",
      operation,
      message: "Postiz rate limited the token request.",
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
      ? "Postiz may have used the authorization code without returning a token. Start the authorization again."
      : error.message,
    ...definedFields({ upstreamStatus: error.status }),
  });
}
