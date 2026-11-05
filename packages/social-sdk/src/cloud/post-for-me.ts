import { normalizeMetrics } from "../core/projections.js";
import { managedLifecycle } from "./lifecycle.js";
import { managedMedia } from "./media.js";

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
  ConnectedAccountRef,
  JsonObject,
  JsonValue,
  DeliveryRef,
  MetricValue,
  Platform,
  PlatformPostRef,
  PreparationIssue,
  PreparedPublishTarget,
  PublishContent,
  TargetContentOverride,
} from "../core/types.js";
import { definedFields } from "../core/fields.js";
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
} from "../transport/validation.js";
import { verifyPostForMeWebhook, decodeWebhook } from "../server/webhooks.js";
import {
  accountMatches,
  capabilityManifest,
  managedHttp,
  managedPreparation,
  managedOptionIssues,
  optionsObject,
  platform,
  providerPlatforms,
  publicFields,
  type ManagedOptions,
} from "./common.js";
import { httpsUrl } from "../transport/upload.js";
import { postForMeOutcome } from "./outcomes.js";
import { assignDefined, objectList, optionReader, xPoll } from "./option-checks.js";

/** PlatformPostDto.media is an array of URLs. Return only public, unsigned HTTPS URLs. */
function feedMedia(value: JsonValue | undefined): readonly string[] | undefined {
  if (!isJsonArray(value)) return undefined;

  return value.flatMap((entry) => {
    if (!isString(entry)) return [];

    try {
      const url = httpsUrl(entry);

      if (url.search || url.hash) return [];

      return [url.href];
    } catch {
      return [];
    }
  });
}

/** Media URLs from a preview's `SocialPostMediaDto` items; entries without an HTTPS URL are dropped. */
function previewMedia(value: JsonValue | undefined): readonly string[] {
  if (!isJsonArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isJsonObject(entry) || !isString(entry["url"])) return [];

    try {
      return [httpsUrl(entry["url"]).href];
    } catch {
      return [];
    }
  });
}

/** A preview runs the same local option checks as a publish target. */
function previewTarget(
  targetIndex: number,
  account: ConnectedAccountRef,
  content: PublishContent,
  options: JsonObject | undefined,
): PreparedPublishTarget {
  return {
    targetIndex,
    targetKey: `preview-${targetIndex}`,
    account,
    content,
    ...definedFields({ options }),
  };
}

/** The preview API takes SocialPostMediaDto objects, the same shape as a post's media. */
function previewMediaItems(
  content: PublishContent,
  itemOptions: readonly JsonObject[],
): readonly JsonObject[] {
  return (content.media ?? []).map((item, index): JsonObject => {
    if (item.source.kind !== "https-url")
      throw new SocialError({
        code: "invalid_input",
        operation: "posts.preview",
        message: "Previews take public HTTPS media URLs.",
      });

    return {
      url: httpsUrl(item.source.url).href,
      ...definedFields({
        alt_text: item.altText,
        thumbnail_url:
          item.thumbnail?.kind === "https-url" ? httpsUrl(item.thumbnail.url).href : undefined,
      }),
      ...itemOptions[index],
    };
  });
}

function previewRows(
  result: JsonValue,
): readonly (JsonObject & { readonly media: readonly string[] })[] {
  return array(result).map((entry) => ({
    ...publicFields(entry, ["caption", "platform", "social_account_id"]),
    media: previewMedia(object(entry)["media"]),
  }));
}

export interface PostForMeConnectionOptions {
  platform: string;
  externalId: string;
  permissions: readonly ("posts" | "feeds")[];
  redirectUrl?: string;
  /** Show the account picker or consent screen again on reconnect (Facebook, Instagram and others). */
  forceReauth?: boolean;
  /** Connection modes Post for Me needs for some platforms (`platform_data`). */
  platformData?: PostForMePlatformData;
}

export interface PostForMePlatformData {
  /** Bluesky connects with a handle and an app password instead of OAuth. */
  readonly bluesky?: { readonly handle: string; readonly appPassword: string };
  /** `organization` for Company Pages (always with Post for Me's own credentials). */
  readonly linkedin?: { readonly connectionType: "personal" | "organization" };
  /** `instagram` for Instagram Login, `facebook` for Facebook Login. */
  readonly instagram?: { readonly connectionType: "instagram" | "facebook" };
  /** OAuth 1.0a or 2.0 app credentials. */
  readonly x?: { readonly connectionType: "oauth1" | "oauth2" };
}

export interface PostForMeWebhookInput {
  /** Public HTTPS URL that receives the events. */
  readonly url: string;
  readonly eventTypes: readonly PostForMeWebhookEvent[];
}

export type PostForMeWebhookEvent =
  | "social.post.created"
  | "social.post.updated"
  | "social.post.deleted"
  | "social.post.result.created"
  | "social.account.created"
  | "social.account.updated";

/** Option keys Post for Me maps beyond the shared managed set (api.postforme.dev/docs, 2026-11-04). */
const postForMeOptionKeys: Partial<Record<Platform, readonly string[]>> = {
  x: ["quotePostId", "poll", "communityId"],
  instagram: ["placement", "collaborators", "locationId", "trialReel", "audioName", "aiGenerated"],
  facebook: ["reel", "story", "collaborators", "locationId", "captionEachImage"],
  youtube: ["categoryId", "tags", "containsSyntheticMedia", "paidProductPlacement"],
  tiktok: ["title", "autoAddMusic"],
  linkedin: ["documentTitle", "reshare"],
  pinterest: ["boardIds"],
  threads: ["placement"],
};

const tiktokPrivacy = new Map<string, string>([
  ["PUBLIC_TO_EVERYONE", "public"],
  ["SELF_ONLY", "private"],
  ["FOLLOWER_OF_CREATOR", "followers"],
  ["MUTUAL_FOLLOW_FRIENDS", "friends"],
]);

/**
 * The platform configuration a post sends: decoded options plus the shared managed ones. A
 * publish requires the YouTube title and visibility and the TikTok privacy level (preparation
 * checks them); a preview sends whichever of them are set.
 */
function platformConfiguration(
  target: PreparedPublishTarget,
  decoded: PostForMeTargetConfig,
  mode: "publish" | "preview",
): JsonObject {
  const config = optionsObject(target);
  const platformConfig = { ...decoded.config };

  const setting = (value: JsonValue | undefined): string | undefined =>
    mode === "publish" ? string(value) : optionalString(value);

  const shareToFeed = config["shareToFeed"];

  if (target.account.platform === "instagram" && isBoolean(shareToFeed))
    platformConfig["share_to_feed"] = shareToFeed;

  if (
    target.account.platform === "x" &&
    config["replySettings"] !== undefined &&
    config["replySettings"] !== "everyone"
  )
    platformConfig["reply_settings"] = string(config["replySettings"]);

  if (target.account.platform === "youtube") {
    assignDefined(platformConfig, {
      title: setting(config["title"]),
      privacy_status: setting(config["visibility"]),
    });

    const madeForKids = config["madeForKids"];

    if (isBoolean(madeForKids)) platformConfig["made_for_kids"] = madeForKids;
  }

  if (target.account.platform === "tiktok") {
    const privacy = optionalString(config["privacy"]);

    assignDefined(platformConfig, {
      privacy_status: setting(privacy === undefined ? undefined : tiktokPrivacy.get(privacy)),
    });
    // A publish states every interaction choice; a preview sends only the ones given.

    if (mode === "publish") {
      platformConfig["auto_add_music"] = decoded.config["auto_add_music"] ?? false;
      platformConfig["allow_duet"] = !config["disableDuet"];
      platformConfig["allow_stitch"] = !config["disableStitch"];
    } else {
      const { disableDuet, disableStitch } = config;

      if (isBoolean(disableDuet)) platformConfig["allow_duet"] = !disableDuet;

      if (isBoolean(disableStitch)) platformConfig["allow_stitch"] = !disableStitch;
    }

    // prepareTarget requires these TikTok choices to be booleans. Skipping an
    // absent value sends the same JSON body, since serialization drops undefined.
    for (const [nativeKey, optionKey] of [
      ["disclose_your_brand", "ownBrand"],
      ["is_ai_generated", "aiGenerated"],
      ["is_draft", "draft"],
    ] as const) {
      const value = config[optionKey];

      if (value !== undefined) platformConfig[nativeKey] = value;
    }

    const { disableComments, brandedContent } = config;

    if (isBoolean(disableComments)) platformConfig["allow_comment"] = !disableComments;

    if (isBoolean(brandedContent)) platformConfig["disclose_branded_content"] = brandedContent;
  }

  if (target.account.platform === "pinterest") {
    const boardId = optionalString(config["boardId"]);
    const title = optionalString(config["title"]);
    const link = optionalString(config["link"]);

    if (boardId !== undefined) platformConfig["board_ids"] = [boardId];

    if (title !== undefined) platformConfig["title"] = title;

    if (link !== undefined) platformConfig["link"] = link;
  }

  return platformConfig;
}

interface PostForMeMediaOptions {
  readonly issues: readonly PreparationIssue[];
  /** Wire fields to merge into each media item, by position. */
  readonly items: readonly JsonObject[];
}

const tagKeys = new Set(["id", "type", "platform", "x", "y"]);

/**
 * One `UserTagDto`, sent as given. Post for Me calls `x` and `y` a "percentage distance" without
 * stating the scale, so they pass through unchanged once they are finite numbers.
 */
function mediaTag(value: JsonValue, platform: Platform): JsonObject | undefined {
  if (!isJsonObject(value) || Object.keys(value).some((key) => !tagKeys.has(key))) return undefined;

  const { id, type, x, y } = value;
  const tagPlatform = value["platform"];

  if (!isString(id) || id.trim() === "") return undefined;

  if (type !== "user" && type !== "product") return undefined;

  if (tagPlatform !== platform || (tagPlatform !== "facebook" && tagPlatform !== "instagram"))
    return undefined;

  if (type === "product" && tagPlatform !== "instagram") return undefined;

  if ((x !== undefined && !isFiniteNumber(x)) || (y !== undefined && !isFiniteNumber(y)))
    return undefined;

  return definedFields({ id, type, platform: tagPlatform, x, y });
}

/**
 * `mediaOptions` entries, one per attachment in media order. Post for Me maps `skipProcessing`
 * (`skip_processing`) and `tags` (`tags`); media order is the array order, so no `index` is sent.
 */
function postForMeMediaOptions(target: PreparedPublishTarget): PostForMeMediaOptions {
  const reader = optionReader(target, optionsObject(target));
  const media = target.content.media ?? [];
  const { platform } = target.account;

  const items =
    objectList(
      reader,
      "mediaOptions",
      "media.options",
      { min: 1, max: Math.max(media.length, 1) },
      (entry): JsonObject | undefined => {
        const skip = entry["skipProcessing"];
        const tags = entry["tags"];

        if (Object.keys(entry).some((key) => key !== "skipProcessing" && key !== "tags"))
          return undefined;

        if (skip !== undefined && !isBoolean(skip)) return undefined;

        if (tags === undefined) return definedFields({ skip_processing: skip });

        const decoded = isJsonArray(tags)
          ? tags.flatMap((tag) => mediaTag(tag, platform) ?? [])
          : [];

        if (!isJsonArray(tags) || decoded.length === 0 || decoded.length !== tags.length) {
          reader.fail(
            "media.tags",
            "mediaOptions[].tags lists Post for Me tags: a non-empty id, type user or product (product for Instagram only), platform matching the target (facebook or instagram), and optional finite numbers x and y.",
          );

          return definedFields({ skip_processing: skip });
        }

        return definedFields({ skip_processing: skip, tags: decoded });
      },
      "mediaOptions lists one object per attachment, at most one per media item; Post for Me maps a boolean skipProcessing and tags.",
    ) ?? [];

  if (reader.has("mediaOptions") && media.length === 0)
    reader.fail("media.options", "mediaOptions needs media.");

  return { issues: reader.issues, items };
}

/** Every platform also takes the per-attachment `mediaOptions`. */
const optionKeysWithMedia: Partial<Record<Platform, readonly string[]>> = Object.fromEntries(
  providerPlatforms["post-for-me"].map((name) => [
    name,
    [...(postForMeOptionKeys[name] ?? []), "mediaOptions"],
  ]),
);

/** Decode the Post for Me options of one target into its platform configuration. */
interface PostForMeTargetConfig {
  readonly issues: readonly PreparationIssue[];
  readonly config: Readonly<Record<string, JsonValue>>;
}

function postForMeConfig(target: PreparedPublishTarget): PostForMeTargetConfig {
  const reader = optionReader(target, optionsObject(target));
  const { fail } = reader;
  const config: Record<string, JsonValue> = {};
  const media = target.content.media ?? [];
  const singleVideo = media.length === 1 && media[0]?.kind === "video";

  if (
    media.some((item) => item.kind === "document") &&
    (target.account.platform !== "linkedin" || media.length !== 1)
  )
    fail("media.document", "Post for Me publishes one document alone, to LinkedIn only.");

  for (const item of media)
    if (
      item.thumbnail !== undefined &&
      (item.kind !== "video" || item.thumbnail.kind !== "https-url")
    )
      fail("media.thumbnail", "Post for Me takes a video thumbnail as a public HTTPS URL.");

  switch (target.account.platform) {
    case "x": {
      const poll = xPoll(reader);
      const quote = reader.text("quotePostId", "x.quote", 64);
      const community = reader.text("communityId", "x.community", 64);

      if (poll && (media.length > 0 || quote))
        fail("x.poll", "An X poll cannot carry media or a quote.");

      assignDefined(config, {
        poll: poll && { options: [...poll.options], duration_minutes: poll.durationMinutes },
        quote_tweet_id: quote,
        community_id: community,
      });
      break;
    }

    case "instagram": {
      const placement = reader.config["placement"];

      if (
        placement !== undefined &&
        placement !== "feed" &&
        placement !== "story" &&
        placement !== "reels"
      )
        fail("instagram.placement", "placement must be feed, story or reels.");

      if (placement === "reels" && !singleVideo)
        fail("instagram.placement", "A Reel needs exactly one video.");

      const trialReel = reader.config["trialReel"];

      if (trialReel !== undefined && trialReel !== "manual" && trialReel !== "performance")
        fail("instagram.trial_reel", "trialReel must be manual or performance.");

      const audioName = reader.text("audioName", "instagram.audio_name", 100);

      if (
        (trialReel !== undefined || audioName !== undefined) &&
        (!singleVideo || placement === "story")
      )
        fail("instagram.reel_options", "trialReel and audioName apply to a Reel only.");

      assignDefined(config, {
        placement:
          placement === "story"
            ? "stories"
            : placement === "reels"
              ? "reels"
              : placement === "feed"
                ? "timeline"
                : undefined,
        collaborators: reader
          .texts("collaborators", "instagram.collaborators", { max: 3, length: 30 })
          ?.slice(),
        location: reader.text("locationId", "instagram.location", 32),
        trial_reel_type: isString(trialReel) ? trialReel : undefined,
        audio_name: audioName,
        is_ai_generated: reader.flag("aiGenerated", "instagram.ai_generated"),
      });
      break;
    }

    case "facebook": {
      const reel = reader.flag("reel", "facebook.reel");
      const story = reader.flag("story", "facebook.story");

      if (reel && story) fail("facebook.placement", "Choose either reel or story.");

      if (reel && !singleVideo) fail("facebook.reel", "A Facebook Reel needs exactly one video.");

      const collaborators = reader.texts("collaborators", "facebook.collaborators", {
        max: 10,
        length: 32,
      });

      if (collaborators && !reel) fail("facebook.collaborators", "Collaborators apply to a Reel.");

      assignDefined(config, {
        placement: reel ? "reels" : story ? "stories" : undefined,
        collaborators: collaborators?.slice(),
        location: reader.text("locationId", "facebook.location", 32),
        set_caption_for_each_image: reader.flag("captionEachImage", "facebook.caption_each_image"),
      });
      break;
    }

    case "youtube": {
      const tags = reader.texts("tags", "youtube.tags", { max: 500, length: 100 });

      if (tags && tags.join("").length > 500)
        fail("youtube.tags", "YouTube tags are limited to 500 characters combined.");

      const categoryId = reader.text("categoryId", "youtube.category", 8);

      if (categoryId !== undefined && !/^\d+$/.test(categoryId))
        fail("youtube.category", "categoryId must be a numeric YouTube category ID.");

      assignDefined(config, {
        tags: tags?.slice(),
        category_id: categoryId,
        contains_synthetic_media: reader.flag("containsSyntheticMedia", "youtube.synthetic_media"),
        has_paid_product_placement: reader.flag("paidProductPlacement", "youtube.paid_placement"),
      });
      break;
    }

    case "tiktok": {
      const photo = media.length > 0 && media.every((item) => item.kind === "image");
      const title = reader.text("title", "tiktok.title", 90);
      const music = reader.flag("autoAddMusic", "tiktok.auto_add_music");

      if ((title !== undefined || music !== undefined) && !photo)
        fail("tiktok.photo_options", "title and autoAddMusic apply to TikTok photo posts.");

      assignDefined(config, { title, auto_add_music: music });
      break;
    }

    case "linkedin": {
      const documentTitle = reader.text("documentTitle", "linkedin.document_title", 200);
      const reshare = reader.text("reshare", "linkedin.reshare", 128);

      if (documentTitle !== undefined && media[0]?.kind !== "document")
        fail("linkedin.document_title", "documentTitle needs one document attachment.");

      if (reshare !== undefined && media.length > 0)
        fail("linkedin.reshare", "A LinkedIn reshare cannot carry media.");

      assignDefined(config, { title: documentTitle, reshare_post_id: reshare });
      break;
    }

    case "threads": {
      const placement = reader.config["placement"];

      // Post for Me does not explain `reels` for Threads; forward the value without interpreting it.
      if (placement !== undefined && placement !== "reels" && placement !== "timeline")
        fail("threads.placement", "placement must be reels or timeline.");

      assignDefined(config, {
        placement: placement === "reels" || placement === "timeline" ? placement : undefined,
      });
      break;
    }

    case "pinterest": {
      const boards = reader.texts("boardIds", "pinterest.board", { max: 10, length: 64 });

      if (boards && reader.config["boardId"] !== undefined)
        fail("pinterest.board", "Use boardId or boardIds, not both.");

      assignDefined(config, { board_ids: boards?.slice() });
      break;
    }

    default:
      break;
  }

  return { issues: reader.issues, config };
}

function platformData(input: PostForMePlatformData): JsonObject {
  return {
    ...definedFields({
      bluesky: input.bluesky && {
        handle: input.bluesky.handle,
        app_password: input.bluesky.appPassword,
      },
      linkedin: input.linkedin && { connection_type: input.linkedin.connectionType },
      instagram: input.instagram && { connection_type: input.instagram.connectionType },
      x: input.x && { connection_type: input.x.connectionType },
    }),
  };
}

/** Webhook settings without the secret. */
function webhookFields(value: JsonValue): JsonObject {
  const row = object(value);
  const events = row["event_types"];

  return {
    ...publicFields(row, ["id", "url"]),
    eventTypes: isJsonArray(events) ? events.filter(isString) : [],
  };
}

const invalid = (operation: string, message: string): never => {
  throw new SocialError({ code: "invalid_input", operation, message });
};

const unconfirmed = (operation: string): never => {
  throw new SocialError({
    code: "ambiguous_outcome",
    operation,
    message: "Post for Me did not confirm the change. Reconcile before retrying.",
    retryDisposition: { kind: "reconcile-first" },
  });
};

export function postForMe(options: ManagedOptions) {
  const request = managedHttp("https://api.postforme.dev", options);

  const mediaPipeline = managedMedia("post-for-me", options, (body, context) =>
    request("/v1/media/create-upload-url", context, body),
  );

  const now = () => (options.clock?.() ?? new Date()).toISOString();

  const account = (value: JsonValue, backend: string): AccountRecord => {
    const row = object(value);
    const handle = optionalString(row["username"]);

    return {
      ref: {
        kind: "connected-account",
        version: 1,
        backend,
        // Post for Me lists TikTok Business accounts as `tiktok_business`; both publish as TikTok.
        platform: platform(
          row["platform"] === "tiktok_business" ? "tiktok" : row["platform"],
          options,
        ),
        accountId: string(row["id"]),
      },
      displayName: handle ?? string(row["user_id"]),
      ...definedFields({ handle: handle || undefined }),
      status:
        row["status"] === "connected"
          ? "connected"
          : row["status"] === "disconnected"
            ? "reconnect-required"
            : "unknown",
    };
  };

  const supportedAccount = (value: JsonValue, backend: string): AccountRecord | undefined => {
    try {
      return account(value, backend);
    } catch (error) {
      if (error instanceof SocialError && error.code === "unsupported_capability") return undefined;
      throw error;
    }
  };

  const feed = async (
    ref: PlatformPostRef,
    context: AdapterOperationContext,
    metrics: boolean,
  ): Promise<JsonObject> => {
    accountMatches(ref, context);

    const result = object(
      await request(
        `/v1/social-account-feeds/${encodeURIComponent(ref.accountId)}`,
        context,
        undefined,
        {
          platform_post_id: ref.postId,
          limit: "1",
          ...definedFields({ expand: metrics ? "metrics" : undefined }),
        },
      ),
    );

    const row = array(result["data"])
      .map(object)
      .find(
        (item) =>
          item["platform_post_id"] === ref.postId && item["social_account_id"] === ref.accountId,
      );

    if (!row)
      throw new SocialError({
        code: "upstream_failure",
        operation: "posts.read",
        message: "The native post is absent or inaccessible in this account feed.",
      });

    return row;
  };

  const manifest = capabilityManifest(
    "post-for-me",
    "v1 / OpenAPI 1.0",
    [
      "accounts.read",
      "posts.publish",
      "posts.schedule",
      "posts.read",
      "posts.list",
      "posts.status",
      "posts.cancelScheduled",
      "posts.deleteBackendRecord",
      "analytics.read",
      "media.upload",
      "webhooks.verify",
    ],
    undefined,
    undefined,
    {
      facebook:
        "Post for Me's Facebook integration is Page-scoped; personal profiles are not supported.",
    },
  );

  const adapter = defineAdapter({
    id: "post-for-me",
    capabilities: {
      ...manifest,
      capabilities: [
        ...manifest.capabilities,
        ...providerPlatforms["post-for-me"].map((platform) => ({
          platform,
          operation: "posts.update",
          availability: "available" as const,
          surface: "native" as const,
          notes: "Native access: updatePost changes a draft or scheduled post before it publishes.",
        })),
      ],
    },
    media: { upload: mediaPipeline.upload },
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
          throw new SocialError({
            code: "invalid_input",
            operation: "accounts.read",
            message: "Use an opaque returned cursor and a page size from 1 to 100.",
          });

        const result = object(
          await request("/v1/social-accounts", context, undefined, {
            offset: String(offset),
            limit: String(limit),
          }),
        );

        const rows = array(result["data"]);
        const meta = object(result["meta"]);
        const next = meta["next"] ? String(offset + limit) : undefined;

        return {
          items: rows.flatMap((value) => {
            const parsed = supportedAccount(value, context.backendInstance);

            return parsed ? [parsed] : [];
          }),
          ...definedFields({ nextCursor: next }),
        };
      },
      async get(ref: ConnectedAccountRef, context: AdapterOperationContext) {
        accountMatches(ref, context);

        const result = account(
          await request(`/v1/social-accounts/${encodeURIComponent(ref.accountId)}`, context),
          context.backendInstance,
        );

        if (result.ref.accountId !== ref.accountId || result.ref.platform !== ref.platform)
          throw new SocialError({
            code: "unauthorized",
            operation: "accounts.read",
            message: "Account identity does not match the requested reference.",
          });

        return result;
      },
    },
    posts: {
      ...managedLifecycle("post-for-me", request, now),
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        accountMatches(account, context);
        const limit = input.limit ?? 25;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.read",
            message: "Post for Me feed page size must be between 1 and 100.",
          });

        const result = object(
          await request(
            `/v1/social-account-feeds/${encodeURIComponent(account.accountId)}`,
            context,
            undefined,
            {
              limit: String(limit),
              ...definedFields({ cursor: input.cursor }),
            },
          ),
        );

        const rows = array(result["data"])
          .map(object)
          .filter((row) => row["social_account_id"] === account.accountId)
          .map((row) => ({
            ...publicFields(row, [
              "platform_post_id",
              "social_account_id",
              "platform_account_id",
              "platform_url",
              "caption",
              "posted_at",
              "created_at",
            ]),
            ...definedFields({ media: feedMedia(row["media"]) }),
          }));

        const meta = result["meta"] === undefined ? {} : object(result["meta"]);
        const hasMore = meta["has_more"];
        const cursor = optionalString(meta["cursor"]);

        // `has_more: false` is authoritative. Older responses may omit it;
        // in that case, a non-empty `next` marker plus cursor permits continuation.
        const next =
          hasMore === false
            ? undefined
            : hasMore === true
              ? cursor
              : optionalString(meta["next"]) && cursor
                ? cursor
                : undefined;

        return { items: rows, ...definedFields({ nextCursor: next }) };
      },
      prepareTarget(target: Parameters<typeof managedPreparation>[0]) {
        const issues = [
          ...managedPreparation(target, "post-for-me"),
          ...managedOptionIssues(target, "post-for-me", optionKeysWithMedia),
          ...postForMeConfig(target).issues,
          ...postForMeMediaOptions(target).issues,
        ];

        return issues;
      },
      async publishTarget(
        target: Parameters<typeof managedPreparation>[0],
        context: AdapterOperationContext,
      ) {
        accountMatches(target.account, context);
        const media: JsonObject[] = [];
        const itemOptions = postForMeMediaOptions(target);

        for (const [index, item] of (target.content.media ?? []).entries())
          media.push({
            url: await mediaPipeline.resolve(item, target.account, context),
            ...definedFields({
              alt_text: item.altText,
              thumbnail_url:
                item.thumbnail?.kind === "https-url"
                  ? httpsUrl(item.thumbnail.url).href
                  : undefined,
            }),
            ...itemOptions.items[index],
          });
        const decoded = postForMeConfig(target);

        if (decoded.issues.length > 0 || itemOptions.issues.length > 0)
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.publish",
            message: "Publish options failed preparation; call prepare to list the issues.",
          });

        const platformConfig = platformConfiguration(target, decoded, "publish");

        // Uploaded refs are single-submission assets: publication or schedule deletion
        // can remove them. Invalidate before dispatch, including uncertain writes.
        await mediaPipeline.consume(target.content.media ?? []);

        const response = await request("/v1/social-posts", context, {
          caption: target.content.text ?? "",
          social_accounts: [target.account.accountId],
          media,
          ...definedFields({
            scheduled_at: target.schedule?.at,
            external_id: context.targetIdempotencyKey || undefined,
            // A TikTok account may be a TikTok Business account, which Post for Me configures
            // under `tiktok_business`; only the key matching the account's type applies.
            platform_configurations: Object.keys(platformConfig).length
              ? target.account.platform === "tiktok"
                ? { tiktok: platformConfig, tiktok_business: platformConfig }
                : { [target.account.platform]: platformConfig }
              : undefined,
          }),
        });

        const parent = object(response);
        let results: JsonValue | undefined;

        if (parent["status"] === "processed") {
          try {
            results = await request("/v1/social-post-results", context, undefined, {
              post_id: string(parent["id"]),
              social_account_id: target.account.accountId,
              limit: "2",
            });
          } catch {
            /* Preserve the accepted parent if immediate reconciliation is unavailable. */
          }
        }

        return postForMeOutcome(parent, results, {
          account: target.account,
          targetIndex: target.targetIndex,
          observedAt: now(),
        });
      },
      async getDelivery(
        ref: { deliveryId: string; accountId: string; platform: string; backend: string },
        context: AdapterOperationContext,
      ) {
        const account: ConnectedAccountRef = {
          kind: "connected-account",
          version: 1,
          backend: ref.backend,
          platform: ref.platform,
          accountId: ref.accountId,
        };

        accountMatches(account, context);

        const parent = await request(
          `/v1/social-posts/${encodeURIComponent(ref.deliveryId)}`,
          context,
        );

        const results = await request("/v1/social-post-results", context, undefined, {
          post_id: ref.deliveryId,
          social_account_id: ref.accountId,
          limit: "2",
        });

        return postForMeOutcome(parent, results, { account, targetIndex: 0, observedAt: now() });
      },
      async get(ref: PlatformPostRef, context: AdapterOperationContext) {
        return publicFields(await feed(ref, context, false), [
          "platform_post_id",
          "social_account_id",
          "platform_account_id",
          "platform_url",
          "caption",
          "posted_at",
        ]);
      },
    },
    analytics: {
      async getPostMetrics(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        const row = await feed(ref, context, true);

        if (row["metrics"] === undefined || row["metrics"] === null) return [];
        const metrics = object(row["metrics"]);

        const values =
          ref.platform === "x" && metrics["public_metrics"] !== undefined
            ? object(metrics["public_metrics"])
            : metrics;

        const result: MetricValue[] = [];

        const fields: readonly (readonly [string, string])[] =
          ref.platform === "x"
            ? [
                ["likes", "like_count"],
                ["comments", "reply_count"],
                ["reposts", "retweet_count"],
                ["impressions", "impression_count"],
              ]
            : ref.platform === "facebook"
              ? [
                  ["likes", "reactions_like"],
                  ["reactions", "reactions_total"],
                  ["comments", "comments"],
                  ["shares", "shares"],
                  ["reach", "reach"],
                  // Prefer media_views over the overlapping video_views counter; never sum them.
                  ["views", "media_views"],
                  ["views", "video_views"],
                ]
              : ref.platform === "linkedin"
                ? [
                    ["likes", "likeCount"],
                    ["comments", "commentCount"],
                    ["impressions", "impressionCount"],
                  ]
                : ref.platform === "instagram"
                  ? [
                      ["likes", "likes"],
                      ["comments", "comments"],
                      ["views", "views"],
                      ["reach", "reach"],
                      ["saves", "saved"],
                      ["shares", "shares"],
                      ["follows", "follows"],
                      ["profileVisits", "profile_visits"],
                      ["interactions", "total_interactions"],
                    ]
                  : ref.platform === "bluesky"
                    ? [
                        ["likes", "likeCount"],
                        ["comments", "replyCount"],
                        ["reposts", "repostCount"],
                      ]
                    : // Other platforms report provider-shaped counters; accept the common spellings.
                      [
                        ["likes", "likes"],
                        ["likes", "like_count"],
                        ["likes", "likeCount"],
                        ["comments", "comments"],
                        ["comments", "comment_count"],
                        ["comments", "commentCount"],
                        ["comments", "replies"],
                        ["shares", "shares"],
                        ["shares", "share_count"],
                        ["reposts", "reposts"],
                        ["reposts", "repost_count"],
                        ["views", "views"],
                        ["views", "view_count"],
                        ["views", "viewCount"],
                        ["impressions", "impressions"],
                        ["reach", "reach"],
                      ];

        const seen = new Set<string>();

        for (const [name, key] of fields) {
          if (seen.has(name)) continue;
          const value = optionalNumber(values[key]);

          if (value === undefined) continue;
          seen.add(name);
          result.push({
            name,
            value,
            unit: "count",
            period: "lifetime",
            fetchedAt: now(),
            freshness: "unknown",
            source: `post-for-me:${ref.platform}:feed`,
          });
        }

        // Instagram reports Reel watch time in milliseconds.
        if (ref.platform === "instagram")
          for (const [name, key] of [
            ["averageWatchTime", "ig_reels_avg_watch_time"],
            ["totalWatchTime", "ig_reels_video_view_total_time"],
          ] as const) {
            const value = optionalNumber(values[key]);

            if (value !== undefined)
              result.push({
                name,
                value,
                unit: "milliseconds",
                period: "lifetime",
                fetchedAt: now(),
                freshness: "unknown",
                source: `post-for-me:${ref.platform}:feed`,
              });
          }

        return normalizeMetrics(result);
      },
    },
    webhooks: {
      async verify(input: { headers: Headers; body: Uint8Array }) {
        await verifyPostForMeWebhook({ ...input, secret: options.webhookSecret ?? "" });

        return { valid: true, method: "shared-secret" as const };
      },
      async decode(
        input: { headers: Headers; body: Uint8Array },
        context: AdapterOperationContext,
      ): Promise<JsonObject> {
        const event = await decodeWebhook({
          provider: "post-for-me",
          backend: context.backendInstance,
          body: input.body,
          receivedAt: now(),
        });

        return { ...event };
      },
    },
    native: {
      async createConnection(input: PostForMeConnectionOptions, context: AdapterOperationContext) {
        platform(input.platform, options);

        const result = object(
          await request("/v1/social-accounts/auth-url", context, {
            platform: input.platform,
            external_id: input.externalId,
            permissions: input.permissions,
            ...definedFields({
              redirect_url_override: input.redirectUrl || undefined,
              force_reauth: input.forceReauth,
              platform_data: input.platformData && platformData(input.platformData),
            }),
          }),
        );

        return { url: string(result["url"]), platform: string(result["platform"]) };
      },
      /** Remove an account's tokens and mark it disconnected; the record and history stay. */
      async disconnectAccount(
        input: { readonly account: ConnectedAccountRef },
        context: AdapterOperationContext,
      ) {
        accountMatches(input.account, context);

        const result = object(
          await request(
            `/v1/social-accounts/${encodeURIComponent(input.account.accountId)}/disconnect`,
            context,
            {},
          ),
        );

        if (result["id"] !== input.account.accountId || result["status"] !== "disconnected")
          unconfirmed("accounts.write");

        return account(result, context.backendInstance);
      },
      /** Permanently delete an account and its post history (DELETE /v1/social-accounts/{id}). */
      async deleteAccount(
        input: { readonly account: ConnectedAccountRef },
        context: AdapterOperationContext,
      ) {
        accountMatches(input.account, context);

        const result = object(
          await request(
            `/v1/social-accounts/${encodeURIComponent(input.account.accountId)}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
        );

        if (result["success"] !== true) unconfirmed("accounts.write");
      },
      /** Set your own `external_id` on an account (PATCH /v1/social-accounts/{id}). */
      async updateAccount(
        input: { readonly account: ConnectedAccountRef; readonly externalId: string },
        context: AdapterOperationContext,
      ) {
        accountMatches(input.account, context);

        const result = object(
          await request(
            `/v1/social-accounts/${encodeURIComponent(input.account.accountId)}`,
            context,
            { external_id: input.externalId },
            {},
            "PATCH",
          ),
        );

        if (result["id"] !== input.account.accountId) unconfirmed("accounts.write");

        return account(result, context.backendInstance);
      },
      /**
       * Change the caption or time of a draft or scheduled post before it publishes
       * (PUT /v1/social-posts/{id}). Other stored fields are sent back unchanged.
       */
      async updatePost(
        input: { readonly delivery: DeliveryRef; readonly text?: string; readonly at?: string },
        context: AdapterOperationContext,
      ) {
        accountMatches(input.delivery, context);

        if (input.text === undefined && input.at === undefined)
          invalid("posts.update", "Provide a new caption or schedule time.");

        if (input.at !== undefined && !(Date.parse(input.at) > Date.parse(now())))
          invalid("posts.update", "A new schedule time must be in the future.");

        const id = input.delivery.deliveryId;
        const record = object(await request(`/v1/social-posts/${encodeURIComponent(id)}`, context));
        const accounts = array(record["social_accounts"]).map(object);

        if (
          record["id"] !== id ||
          accounts.length !== 1 ||
          accounts[0]?.["id"] !== input.delivery.accountId
        )
          throw new SocialError({
            code: "unauthorized",
            operation: "posts.update",
            message: "The Post for Me post does not belong to exactly this account.",
          });

        if (record["status"] !== "scheduled" && record["status"] !== "draft")
          invalid("posts.update", "Only a draft or scheduled post can change.");

        const kept = [
          "media",
          "platform_configurations",
          "account_configurations",
          "external_id",
        ].flatMap((key) => {
          const value = record[key];

          return value === undefined || value === null ? [] : [[key, value] as const];
        });

        const scheduledAt = input.at ?? optionalString(record["scheduled_at"]);

        const result = object(
          await request(
            `/v1/social-posts/${encodeURIComponent(id)}`,
            context,
            {
              caption: input.text ?? string(record["caption"]),
              social_accounts: [input.delivery.accountId],
              ...definedFields({ scheduled_at: scheduledAt }),
              isDraft: record["status"] === "draft",
              ...Object.fromEntries(kept),
            },
            {},
            "PUT",
          ),
        );

        if (result["id"] !== id) unconfirmed("posts.update");

        return postForMeOutcome(result, undefined, {
          account: {
            kind: "connected-account",
            version: 1,
            backend: input.delivery.backend,
            platform: input.delivery.platform,
            accountId: input.delivery.accountId,
          },
          targetIndex: 0,
          observedAt: now(),
        });
      },
      /**
       * Render how a post will look per account before publishing (POST /v1/social-post-previews).
       * Useful for TikTok's rule that creators see a preview before they consent.
       */
      async previewPost(
        input: {
          readonly account: ConnectedAccountRef;
          readonly content: PublishContent;
          readonly options?: JsonObject;
        },
        context: AdapterOperationContext,
      ) {
        accountMatches(input.account, context);

        const target = previewTarget(0, input.account, input.content, input.options);
        const decoded = postForMeConfig(target);
        const itemOptions = postForMeMediaOptions(target);
        const platformConfig = platformConfiguration(target, decoded, "preview");

        const result = await request("/v1/social-post-previews", context, {
          caption: input.content.text ?? "",
          preview_social_accounts: [
            { id: input.account.accountId, platform: input.account.platform },
          ],
          media: previewMediaItems(input.content, itemOptions.items),
          ...definedFields({
            platform_configurations: Object.keys(platformConfig).length
              ? { [input.account.platform]: platformConfig }
              : undefined,
          }),
        });

        return {
          previews: previewRows(result),
          localIssues: [...decoded.issues, ...itemOptions.issues],
        };
      },
      /**
       * Preview several accounts in one call (POST /v1/social-post-previews). `content` is the
       * shared caption and media; a target's own `content` and `options` become its entry in
       * `account_configurations`, which overrides the shared values for that account only.
       */
      async previewPosts(
        input: {
          readonly content: PublishContent;
          readonly targets: readonly {
            readonly account: ConnectedAccountRef;
            readonly content?: TargetContentOverride;
            readonly options?: JsonObject;
          }[];
        },
        context: AdapterOperationContext,
      ) {
        if (input.targets.length === 0) invalid("posts.preview", "Preview at least one account.");

        const issues: PreparationIssue[] = [];
        const configurations: JsonObject[] = [];

        for (const [index, entry] of input.targets.entries()) {
          accountMatches(entry.account, context);

          const content: PublishContent = { ...input.content, ...entry.content };
          const target = previewTarget(index, entry.account, content, entry.options);
          const decoded = postForMeConfig(target);
          const itemOptions = postForMeMediaOptions(target);

          issues.push(...decoded.issues, ...itemOptions.issues);

          const configuration: JsonObject = {
            ...definedFields({
              caption: entry.content?.text,
              media:
                entry.content?.media || entry.options?.["mediaOptions"] !== undefined
                  ? previewMediaItems(content, itemOptions.items)
                  : undefined,
            }),
            ...platformConfiguration(target, decoded, "preview"),
          };

          if (Object.keys(configuration).length > 0)
            configurations.push({ social_account_id: entry.account.accountId, configuration });
        }

        const result = await request("/v1/social-post-previews", context, {
          caption: input.content.text ?? "",
          preview_social_accounts: input.targets.map((entry) => ({
            id: entry.account.accountId,
            platform: entry.account.platform,
          })),
          media: previewMediaItems(input.content, []),
          ...definedFields({
            account_configurations: configurations.length > 0 ? configurations : undefined,
          }),
        });

        return { previews: previewRows(result), localIssues: issues };
      },
      /**
       * Find feed posts by the Post for Me post that created them (`social_post_id`, a delivery
       * ID), by your `external_post_id` (the target idempotency key this adapter sends as
       * `external_id`) or by `platform_post_id` (GET /v1/social-account-feeds/{id}). Several values
       * of one filter match any of them.
       */
      async findFeedPosts(
        input: {
          readonly account: ConnectedAccountRef;
          readonly socialPostIds?: readonly string[];
          readonly externalPostIds?: readonly string[];
          readonly platformPostIds?: readonly string[];
          /** Include each post's analytics (`expand=metrics`). */
          readonly metrics?: boolean;
          readonly limit?: number;
          readonly cursor?: string;
        },
        context: AdapterOperationContext,
      ) {
        accountMatches(input.account, context);

        const filters = [input.socialPostIds, input.externalPostIds, input.platformPostIds];

        if (filters.every((values) => values === undefined || values.length === 0))
          invalid("posts.read", "Filter by at least one post ID; use posts.list to page the feed.");

        if (filters.some((values) => values?.some((value) => !value.trim())))
          invalid("posts.read", "Post IDs are non-empty strings.");

        const limit = input.limit ?? 50;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          invalid("posts.read", "Post for Me feed page size must be between 1 and 100.");

        const result = object(
          await request(
            `/v1/social-account-feeds/${encodeURIComponent(input.account.accountId)}`,
            context,
            undefined,
            {
              limit: String(limit),
              ...definedFields({
                cursor: input.cursor,
                social_post_id: input.socialPostIds,
                external_post_id: input.externalPostIds,
                platform_post_id: input.platformPostIds,
                expand: input.metrics ? "metrics" : undefined,
              }),
            },
          ),
        );

        const meta = result["meta"] === undefined ? {} : object(result["meta"]);

        return {
          items: array(result["data"])
            .map(object)
            .filter((row) => row["social_account_id"] === input.account.accountId)
            .map((row) => ({
              ...publicFields(row, [
                "social_post_id",
                "external_post_id",
                "social_post_result_id",
                "platform_post_id",
                "social_account_id",
                "platform_url",
                "caption",
                "posted_at",
              ]),
              ...definedFields({
                media: feedMedia(row["media"]),
                metrics: isJsonObject(row["metrics"]) ? row["metrics"] : undefined,
              }),
            })),
          ...definedFields({
            nextCursor: meta["has_more"] === true ? optionalString(meta["cursor"]) : undefined,
          }),
        };
      },
      /** Webhooks have no dashboard UI in Post for Me; manage them here. */
      async listWebhooks(context: AdapterOperationContext) {
        const result = object(await request("/v1/webhooks", context, undefined, { limit: "100" }));

        return array(result["data"]).map(webhookFields);
      },
      /**
       * Create a webhook. The response carries the generated `secret` once; store it as the
       * adapter's `webhookSecret`.
       */
      async createWebhook(input: PostForMeWebhookInput, context: AdapterOperationContext) {
        if (input.eventTypes.length === 0)
          invalid("webhooks.write", "Subscribe to at least one event.");

        const result = object(
          await request("/v1/webhooks", context, {
            url: httpsUrl(input.url).href,
            event_types: [...input.eventTypes],
          }),
        );

        return { ...webhookFields(result), secret: string(result["secret"]) };
      },
      async updateWebhook(
        input: Partial<PostForMeWebhookInput> & { readonly webhookId: string },
        context: AdapterOperationContext,
      ) {
        const result = object(
          await request(
            `/v1/webhooks/${encodeURIComponent(input.webhookId)}`,
            context,
            {
              ...definedFields({
                url: input.url === undefined ? undefined : httpsUrl(input.url).href,
                event_types: input.eventTypes && [...input.eventTypes],
              }),
            },
            {},
            "PATCH",
          ),
        );

        if (result["id"] !== input.webhookId) unconfirmed("webhooks.write");

        return webhookFields(result);
      },
      async deleteWebhook(input: { readonly webhookId: string }, context: AdapterOperationContext) {
        const result = object(
          await request(
            `/v1/webhooks/${encodeURIComponent(input.webhookId)}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
        );

        if (result["success"] !== true) unconfirmed("webhooks.write");
      },
    },
  });

  return adapter;
}
