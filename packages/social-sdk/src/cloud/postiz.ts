import { normalizeMetrics } from "../core/projections.js";
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
  CapabilityDeclaration,
  ConnectedAccountRef,
  DeliveryOutcome,
  DeliveryRef,
  JsonObject,
  JsonValue,
  MediaAttachment,
  MediaInput,
  MediaRef,
  MetricValue,
  Platform,
  PlatformPostRef,
  PreparationIssue,
  PreparedPublishTarget,
  ScheduleCancellation,
  ScheduledJobRef,
} from "../core/types.js";
import { definedFields } from "../core/fields.js";
import { createHttp, HttpError, type HttpOptions } from "../transport/http.js";
import { isJsonValue } from "../transport/json.js";
import { httpsUrl } from "../transport/upload.js";
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
import {
  accountMatches,
  capabilityManifest,
  managedConstraints,
  acknowledged,
  managedHttp,
  managedOptionIssues,
  managedPreparation,
  optionsObject,
  mappedPlatform,
  providerPlatforms,
  publishFormats,
  subredditName,
  type ManagedOptions,
  type PublishFormats,
} from "./common.js";

export interface PostizOptions extends ManagedOptions {
  /**
   * Public API base URL. Defaults to Postiz Cloud. A self-hosted Docker instance serves
   * the public API at `https://<your-host>/api/public/v1`.
   */
  readonly baseUrl?: string;
  /**
   * List only the channels assigned to this Postiz customer (group), from `native.listGroups`.
   * Omit to list every channel in the workspace.
   */
  readonly group?: string;
  /**
   * Ask Postiz to resize and re-encode files uploaded with `media.upload` to platform limits.
   * Before publishing such a reference, the adapter reads its status once and uses the
   * adjusted file, or fails while Postiz is still processing it.
   */
  readonly adjustMedia?: boolean;
}

/** A post this adapter created or listed, addressed by the ID it returned. */
export type PostizPostRef = DeliveryRef | ScheduledJobRef | BackendPostRef;

export interface PostizWorkspace {
  readonly organization: { readonly id: string; readonly name?: string };
  /** The Postiz user who approved an OAuth app. API keys belong to the whole workspace. */
  readonly user?: { readonly id: string; readonly name?: string; readonly picture?: string };
}

export interface PostizGroup {
  readonly id: string;
  readonly name?: string;
}

export interface PostizTool {
  readonly methodName: string;
  readonly description?: string;
  /** Parameter descriptions as Postiz reports them, such as `{ key, type, description }`. */
  readonly dataSchema: readonly JsonValue[];
}

export interface PostizChannelSettings {
  readonly rules?: string;
  readonly maxLength?: number;
  /** JSON schema of the provider settings, or Postiz's note that none are required. */
  readonly settings?: JsonValue;
  readonly tools: readonly PostizTool[];
}

export interface PostizMediaItem {
  readonly id: string;
  readonly path: string;
  readonly name?: string;
  readonly originalName?: string;
  readonly createdAt?: string;
}

export interface PostizMediaStatus {
  readonly id: string;
  readonly path?: string;
  readonly status: "processing" | "ready" | "failed";
  readonly warning?: string;
  readonly error?: string;
}

export interface PostizNotification {
  readonly id: string;
  readonly content: string;
  readonly link?: string;
  readonly createdAt?: string;
}

export interface PostizPostEdit {
  /** The new text of the post's first part. Follow-up parts stay as they are. */
  readonly text: string;
  /**
   * The post's attachments after the edit. Postiz replaces them, and its post list does not
   * return the current ones, so pass every file the post should keep; `[]` removes them all.
   */
  readonly media: readonly MediaAttachment[];
  /**
   * Publish the edited post again now. Required for a post that already published or failed,
   * and sent as `republish: true`; rejected for a queued or draft post.
   */
  readonly republish?: boolean;
}

export interface PostizListPostsInput {
  /** ISO 8601 start of the publish-date range. */
  readonly startDate: string;
  /** ISO 8601 end of the publish-date range. */
  readonly endDate: string;
  /** A customer ID from `listGroups`: only posts on that customer's channels. */
  readonly customer?: string;
}

export interface PostizPost {
  /** `<postiz post id>@<publish time>`, usable as a `backend-post` `recordId`. */
  readonly recordId: string;
  readonly id: string;
  readonly publishDate: string;
  /** `QUEUE`, `PUBLISHED`, `ERROR`, or `DRAFT`. */
  readonly state: string;
  readonly content?: string;
  readonly releaseId?: string;
  readonly url?: string;
  /** The platform's reason for a post in the `ERROR` state, when Postiz has one. */
  readonly error?: string;
  /** Days between repeats; Postiz lists a repeating post once per occurrence in the range. */
  readonly repeatEveryDays?: number;
  readonly group?: string;
  /** Workspace tag names. */
  readonly tags: readonly string[];
  readonly channel: { readonly id: string; readonly identifier: string; readonly name?: string };
}

export interface PostizMissingContent {
  /** Platform content ID to pass to `setReleaseId`. */
  readonly id: string;
  /** Thumbnail or preview URL. */
  readonly url?: string;
}

export interface PostizVideoRequest {
  readonly type: "image-text-slides" | "veo3";
  readonly output: "vertical" | "horizontal";
  readonly customParams: {
    /** ElevenLabs voice ID for `image-text-slides`, from `videoFunction` `loadVoices`. */
    readonly voice?: string;
    readonly prompt?: string;
    /** Up to three Postiz media files as reference images for `veo3`. */
    readonly images?: readonly { readonly id: string; readonly path: string }[];
  };
}

export interface PostizClippingRequest {
  /** A `youtube.com` or `youtu.be` video URL. */
  readonly url: string;
  /** Up to 20 channel IDs; Postiz creates one draft post per clip on each. */
  readonly integrations?: readonly string[];
  /** Maximum number of clips, 1 to 10. Postiz defaults to 5. */
  readonly clips?: number;
  readonly fit?: "blur" | "crop";
}

export interface PostizClipping {
  readonly id: string;
  readonly status: string;
  readonly url?: string;
  readonly error?: string;
  readonly title?: string;
  /** Clip rows as Postiz returns them, each with its own `status` and hosted `path`. */
  readonly clips: readonly JsonObject[];
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

/** What a Postiz-only channel accepts, from docs.postiz.com/general/platforms/overview (2026-11-04). */
interface PostizChannel {
  readonly maxLength: number;
  /** `images` allows images only; `images-or-video` adds a single video. */
  readonly media: "none" | "images" | "images-or-video";
  readonly maxImages?: number;
  /** Options this adapter maps to the channel's Postiz settings. */
  readonly keys: readonly string[];
}

/**
 * Channel types Postiz publishes to beyond the shared platform list, keyed by Postiz provider
 * identifier, which is also the Social SDK platform slug. Settings follow
 * docs.postiz.com/public-api/providers/<identifier> (checked 2026-11-04).
 */
const postizChannels = new Map<string, PostizChannel>([
  ["slack", { maxLength: 400_000, media: "images", keys: ["channelId"] }],
  ["lemmy", { maxLength: 10_000, media: "none", keys: ["communities"] }],
  ["warpcast", { maxLength: 800, media: "images", keys: ["channels"] }],
  ["nostr", { maxLength: 100_000, media: "images", keys: [] }],
  ["vk", { maxLength: 2048, media: "images", keys: [] }],
  ["kick", { maxLength: 500, media: "images", keys: [] }],
  [
    "medium",
    {
      maxLength: 100_000,
      media: "none",
      keys: ["title", "subtitle", "canonicalUrl", "publicationId", "tags"],
    },
  ],
  [
    "devto",
    {
      maxLength: 100_000,
      media: "none",
      keys: ["title", "mainImage", "canonicalUrl", "organizationId", "tags"],
    },
  ],
  [
    "hashnode",
    {
      maxLength: 10_000,
      media: "none",
      keys: ["title", "subtitle", "mainImage", "canonicalUrl", "publicationId", "tags"],
    },
  ],
  [
    "wordpress",
    {
      maxLength: 100_000,
      media: "none",
      keys: ["title", "mainImage", "postType", "status", "categoryIds", "tagIds"],
    },
  ],
  [
    "listmonk",
    { maxLength: 300_000, media: "none", keys: ["subject", "preview", "listId", "templateId"] },
  ],
  ["dribbble", { maxLength: 40_000, media: "images", maxImages: 1, keys: ["title", "teamUrl"] }],
  [
    "tumblr",
    {
      maxLength: 32_768,
      media: "images-or-video",
      maxImages: 30,
      keys: ["title", "link", "sourceUrl", "tags"],
    },
  ],
  ["mewe", { maxLength: 63_206, media: "none", keys: ["postType", "groupId"] }],
  ["moltbook", { maxLength: 300, media: "none", keys: ["submolt"] }],
  ["skool", { maxLength: 50_000, media: "images", keys: ["groupId", "labelId", "title"] }],
  ["whop", { maxLength: 50_000, media: "images", keys: ["companyId", "experienceId", "title"] }],
]);

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
  ["pinterest", "pinterest"],
  ["reddit", "reddit"],
  ["gmb", "google-business"],
  ["mastodon", "mastodon"],
  ["telegram", "telegram"],
  ["discord", "discord"],
  ["twitch", "twitch"],
  // Postiz names Farcaster `wrapcast` in the API and documents `warpcast` on its settings page.
  ["wrapcast", "warpcast"],
  ...Array.from(postizChannels.keys(), (slug): [string, Platform] => [slug, slug]),
]);

// OAuth providers among the mapped platforms. Bluesky needs an app password and Mastodon an
// instance URL, so they connect in the Postiz dashboard; Telegram is not offered here either.
const oauthProviders = [
  "x",
  "threads",
  "youtube",
  "tiktok",
  "tiktok-business",
  "instagram",
  "instagram-standalone",
  "linkedin",
  "linkedin-page",
  "facebook",
  "pinterest",
  "reddit",
  "gmb",
  "discord",
  "twitch",
];

const mimeTypes = ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4"] as const;

const maxBytes = { image: 10 * 1024 * 1024, video: 1024 * 1024 * 1024 } as const;

// Restrict source URLs and returned storage paths to extensions accepted by post creation.
const urlExtension = /\.(png|jpe?g|gif|webp|mp4)$/i;

const recordId = /^[A-Za-z0-9_-]{1,128}$/;

function channelId(value: string, operation: string): string {
  if (!recordId.test(value)) reject(operation, "Use a Postiz channel (integration) ID.");

  return value;
}

// Postiz pinned source: the Twitch provider truncates chat messages to 500 characters, and the
// Reddit provider uploads `media[0].thumbnail` as the MP4 poster, typing it from the extension.
const twitchMaxLength = 500;

const imageExtension = /\.(png|jpe?g|gif|webp)$/i;

function isImageThumbnail(
  thumbnail: MediaAttachment["thumbnail"],
): thumbnail is Extract<MediaInput, { kind: "https-url" }> {
  if (thumbnail?.kind !== "https-url") return false;

  try {
    return imageExtension.test(httpsUrl(thumbnail.url).pathname);
  } catch {
    return false;
  }
}

/** An image attachment Postiz can import from a thumbnail URL, typed from its extension. */
function thumbnailImage(thumbnail: Extract<MediaInput, { kind: "https-url" }>): MediaAttachment {
  const extension = imageExtension.exec(httpsUrl(thumbnail.url).pathname)?.[1]?.toLowerCase();

  return {
    kind: "image",
    source: thumbnail,
    mimeType: `image/${extension === "jpg" ? "jpeg" : (extension ?? "jpeg")}`,
  };
}

/** The pinned Reddit provider rejects anything but exactly one attachment for a media post. */
const postizFormats: PublishFormats = (platform) =>
  platform === "reddit" ? ["text", "image", "video"] : publishFormats(platform);

/** Options this adapter maps itself, on top of the shared managed options, per platform. */
const ownKeys: Partial<Record<Platform, readonly string[]>> = {
  x: ["replySettings", "community", "aiGenerated", "paidPartnership", "article"],
  instagram: [
    "postType",
    "trialReel",
    "graduationStrategy",
    "collaborators",
    "audio",
    "thumbnailTimestamp",
  ],
  facebook: ["postType", "textFormatPresetId", "title"],
  youtube: ["tags"],
  tiktok: ["title", "autoAddMusic", "thumbnailTimestamp"],
  linkedin: ["carousel", "carouselName"],
  pinterest: ["dominantColor"],
  "google-business": ["topicType", "callToAction", "event", "offer"],
  twitch: ["messageType", "announcementColor"],
};

/** Post-level Postiz fields, accepted on every platform. */
const postKeys = [
  "saveToDraft",
  "shortLink",
  "workspaceTags",
  "thread",
  "repeatEveryDays",
] as const;

const twitchColors = ["primary", "blue", "green", "orange", "purple"];

const wordpressStatuses = ["publish", "draft", "pending", "private"];

const replySettings = ["everyone", "following", "mentionedUsers", "subscribers", "verified"];

const xCommunity = /^https:\/\/x\.com\/i\/communities\/\d+$/;

const hexColor = /^#[0-9A-Fa-f]{6}$/;

const gmbTopics = ["STANDARD", "EVENT", "OFFER"];

const gmbActions = ["NONE", "BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "GET_OFFER", "CALL"];

const isoDay = /^\d{4}-\d{2}-\d{2}$/;

const clockTime = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Postiz's composer posts no follow-up parts on these platforms. */
const singlePartPlatforms: readonly Platform[] = [
  "youtube",
  "tiktok",
  "pinterest",
  "mewe",
  "tumblr",
];

/** What a target's options add to the Postiz create request. */
interface PostizPlan {
  readonly draft: boolean;
  readonly shortLink: boolean;
  readonly tags: readonly JsonObject[];
  /** `value` items after the first: thread replies or comments, per platform. */
  readonly thread: readonly JsonObject[];
  /** Provider settings merged over the shared mapping. */
  readonly settings: JsonObject;
  /** Milliseconds into the video for the cover frame, set on the video media object. */
  readonly thumbnailTimestamp?: number;
  /** Days between repeats of the post, sent as `inter`. */
  readonly inter?: number;
  /** Public HTTPS image the adapter imports and sends as the article's `main_image`. */
  readonly mainImage?: string;
}

function withoutKeys(config: JsonObject, keys: readonly string[]): JsonObject {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !keys.includes(key)));
}

function isPublicHttps(value: string): boolean {
  try {
    httpsUrl(value);

    return true;
  } catch {
    return false;
  }
}

/** A link the target maps natively: a Facebook link preview or a Reddit link post. */
function mappedLink(target: PreparedPublishTarget): string | undefined {
  const link = target.content.link;
  const platform = target.account.platform;

  if (!link || (platform !== "facebook" && platform !== "reddit")) return undefined;

  return link.title === undefined && link.description === undefined ? link.url : undefined;
}

/** Parse the Postiz-specific options of one target into issues and the request additions. */
function postizPlan(target: PreparedPublishTarget, config: JsonObject) {
  const issues: PreparationIssue[] = [];
  const platform = target.account.platform;
  const media = target.content.media ?? [];
  const videos = media.filter((item) => item.kind === "video");
  const settings: Record<string, JsonValue> = {};

  const fail = (code: string, message: string) =>
    issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

  const flag = (key: string): boolean | undefined => {
    const value = config[key];

    if (value === undefined || isBoolean(value)) return value;

    fail("options.boolean", `${key} must be a boolean.`);

    return undefined;
  };

  const text = (key: string, code: string): string | undefined => {
    const value = config[key];

    if (value === undefined) return undefined;

    if (isString(value) && value.trim() !== "") return value;

    fail(code, `${key} must be a non-empty string when set.`);

    return undefined;
  };

  const strings = (key: string, code: string): readonly string[] | undefined => {
    const value = config[key];

    if (value === undefined) return undefined;

    const items = isJsonArray(value) ? value.filter(isString) : [];

    if (
      !isJsonArray(value) ||
      items.length === 0 ||
      items.length !== value.length ||
      items.some((item) => item.trim() === "")
    ) {
      fail(code, `${key} must be a non-empty list of names.`);

      return undefined;
    }

    return items;
  };

  const objectOption = (key: string, code: string, fields: readonly string[]) => {
    const value = config[key];

    if (value === undefined) return undefined;

    if (isJsonObject(value) && Object.keys(value).every((field) => fields.includes(field)))
      return value;

    fail(code, `${key} takes only ${fields.join(", ")}.`);

    return undefined;
  };

  const draft = flag("saveToDraft") === true;
  const shortLink = flag("shortLink") === true;

  // Postiz attaches only tags that already exist in the workspace, matched by name.
  const tags = (strings("workspaceTags", "postiz.tags") ?? []).map((name) => ({
    value: name,
    label: name,
  }));

  const thread: JsonObject[] = [];
  const parts = config["thread"];

  if (parts !== undefined && singlePartPlatforms.includes(platform))
    fail("postiz.thread_unsupported", "Postiz posts no follow-up parts on this platform.");
  else if (parts !== undefined && (!isJsonArray(parts) || parts.length === 0))
    fail("postiz.thread", "thread must be a non-empty list of follow-up parts.");
  else if (isJsonArray(parts))
    for (const part of parts) {
      const row = isJsonObject(part) ? part : {};
      const content = row["text"];
      const delay = row["delayMinutes"];

      const minutes =
        delay === undefined
          ? undefined
          : isFiniteNumber(delay) && Number.isSafeInteger(delay) && delay >= 0
            ? delay
            : null;

      if (
        !isString(content) ||
        content.trim() === "" ||
        minutes === null ||
        Object.keys(row).some((field) => field !== "text" && field !== "delayMinutes")
      ) {
        fail(
          "postiz.thread",
          "Each thread part needs text and may set delayMinutes, a whole number of minutes.",
        );

        continue;
      }

      thread.push({ content, image: [], ...definedFields({ delay: minutes }) });
    }

  const repeat = config["repeatEveryDays"];

  const inter =
    repeat === undefined
      ? undefined
      : isFiniteNumber(repeat) && Number.isSafeInteger(repeat) && repeat >= 1
        ? repeat
        : null;

  if (inter === null)
    fail("postiz.repeat", "repeatEveryDays is a whole number of days, 1 or more.");

  let thumbnailTimestamp: number | undefined;
  const cover = config["thumbnailTimestamp"];

  if (cover !== undefined) {
    if (!isFiniteNumber(cover) || !Number.isSafeInteger(cover) || cover < 0)
      fail("postiz.cover_frame", "thumbnailTimestamp is a whole number of milliseconds.");
    else if (videos.length !== 1)
      fail("postiz.cover_frame", "thumbnailTimestamp needs exactly one video.");
    else if (platform === "tiktok" && config["draft"] === true)
      fail("tiktok.cover_frame", "TikTok applies a cover frame only to direct posts.");
    else thumbnailTimestamp = cover;
  }

  if (platform === "x") {
    const reply = config["replySettings"];

    if (reply !== undefined && !(isString(reply) && replySettings.includes(reply)))
      fail("x.reply_settings", `Select one of ${replySettings.join(", ")}.`);

    const community = text("community", "x.community");

    if (community !== undefined && !xCommunity.test(community))
      fail("x.community", "Use an X Community URL like https://x.com/i/communities/123.");
    else if (community !== undefined) settings["community"] = community;

    const ai = flag("aiGenerated");
    const paid = flag("paidPartnership");

    if (ai !== undefined) settings["made_with_ai"] = ai;

    if (paid !== undefined) settings["paid_partnership"] = paid;

    const article = objectOption("article", "x.article", ["title", "status"]);

    if (article !== undefined) {
      const title = article["title"];
      const status = article["status"];

      if (!isString(title) || title.trim() === "" || (status !== "draft" && status !== "published"))
        fail("x.article", "An X article needs a title and a status of draft or published.");
      else {
        settings["post_type"] = "article";
        settings["article_title"] = title;
        settings["article_status"] = status;
      }

      if (videos.length > 0) fail("x.article_media", "X articles take images only.");

      if (status === "draft" && thread.length > 0)
        fail("x.article_thread", "An X article saved as a draft cannot have thread replies.");
    }
  }

  if (platform === "instagram") {
    const postType = config["postType"];

    if (postType !== undefined && postType !== "post" && postType !== "story")
      fail("instagram.post_type", "Select post or story.");

    const story = postType === "story";

    if (story) {
      settings["post_type"] = "story";

      if (media.length !== 1)
        fail("instagram.story_media", "Postiz posts an Instagram story from one image or video.");
    }

    const reel = media.length === 1 && videos.length === 1 && !story;
    // The shared `trialReel: "manual" | "performance"` names the graduation strategy; the
    // earlier Postiz form is `trialReel: true` with an optional `graduationStrategy`.
    const trialValue = config["trialReel"];

    const named =
      trialValue === "manual"
        ? "MANUAL"
        : trialValue === "performance"
          ? "SS_PERFORMANCE"
          : undefined;

    const trial = named !== undefined || trialValue === true;
    const graduation = config["graduationStrategy"];

    if (trialValue !== undefined && named === undefined && !isBoolean(trialValue))
      fail("instagram.trial_reel", 'trialReel is "manual" or "performance".');
    else if (trial && !reel)
      fail("instagram.trial_reel", "A trial reel is a single video posted to the feed.");
    else if (trial) settings["is_trial_reel"] = true;

    if (named !== undefined && graduation === undefined) settings["graduation_strategy"] = named;
    else if (
      graduation !== undefined &&
      (trialValue !== true || (graduation !== "MANUAL" && graduation !== "SS_PERFORMANCE"))
    )
      fail(
        "instagram.graduation_strategy",
        'graduationStrategy (MANUAL or SS_PERFORMANCE) goes only with trialReel: true; "manual" and "performance" already set it.',
      );
    else if (graduation !== undefined) settings["graduation_strategy"] = graduation;

    const collaborators = strings("collaborators", "instagram.collaborators");

    if (collaborators !== undefined)
      settings["collaborators"] = collaborators.map((name) => ({ label: name.replace(/^@/, "") }));

    const audio = objectOption("audio", "instagram.audio", ["id", "audioVolume", "videoVolume"]);

    if (audio !== undefined) {
      const id = audio["id"];
      const volumes = [audio["audioVolume"], audio["videoVolume"]];

      const volume = (value: JsonField) =>
        value === undefined ||
        (isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0 && value <= 100);

      if (!isString(id) || id.trim() === "" || !volumes.every(volume))
        fail("instagram.audio", "Reel audio needs an audio id and volumes from 0 to 100.");
      else if (!reel) fail("instagram.audio", "Postiz attaches audio only to a single-video reel.");
      else
        settings["audio"] = {
          id,
          ...definedFields({
            audio_volume: audio["audioVolume"],
            video_volume: audio["videoVolume"],
          }),
        };
    }
  }

  if (platform === "facebook") {
    const postType = config["postType"];

    if (postType !== undefined && postType !== "post" && postType !== "story")
      fail("facebook.post_type", "Select post or story.");

    const story = postType === "story";

    if (story) {
      settings["post_type"] = "story";

      if (media.length === 0)
        fail("facebook.story_media", "A Facebook story needs at least one attachment.");
    }

    const preset = text("textFormatPresetId", "facebook.text_background");

    if (preset !== undefined) {
      if (story || media.length > 0 || (target.content.text ?? "").length > 130)
        fail(
          "facebook.text_background",
          "A text background applies only to a text-only post of up to 130 characters.",
        );
      else settings["text_format_preset_id"] = preset;
    }

    const title = text("title", "facebook.title");

    if (title !== undefined) {
      if (story || media[0]?.kind !== "video")
        fail(
          "facebook.title",
          "A Facebook title applies only to a post whose first file is a video.",
        );
      else settings["title"] = title;
    }

    const link = mappedLink(target);

    if (link !== undefined && story) fail("facebook.link", "A Facebook story takes no link.");
    else if (link !== undefined) settings["url"] = link;
  }

  if (platform === "youtube") {
    const videoTags = strings("tags", "youtube.tags");

    if (videoTags !== undefined)
      settings["tags"] = videoTags.map((name) => ({ value: name, label: name }));
  }

  if (platform === "tiktok") {
    const title = config["title"];

    if (title !== undefined && (!isString(title) || title.length === 0 || title.length > 90))
      fail("tiktok.title", "TikTok titles are limited to 90 characters.");

    const music = flag("autoAddMusic");

    if (music !== undefined) {
      if (videos.length > 0 || config["draft"] === true)
        fail("tiktok.auto_add_music", "autoAddMusic applies only to a direct photo post.");
      else settings["autoAddMusic"] = music ? "yes" : "no";
    }
  }

  if (platform === "linkedin") {
    const carousel = flag("carousel");
    const name = text("carouselName", "linkedin.carousel_name");

    if (carousel === true && (media.length < 2 || media.some((item) => item.kind !== "image")))
      fail("linkedin.carousel", "A LinkedIn carousel needs two or more images and no other files.");
    else if (carousel !== undefined) settings["post_as_images_carousel"] = carousel;

    if (name !== undefined && carousel !== true)
      fail("linkedin.carousel_name", "carouselName needs carousel set to true.");
    else if (name !== undefined) settings["carousel_name"] = name;
  }

  if (platform === "pinterest") {
    const color = text("dominantColor", "pinterest.dominant_color");

    if (color !== undefined && !hexColor.test(color))
      fail("pinterest.dominant_color", "dominantColor is a hex color such as #FF5733.");
    else if (color !== undefined) settings["dominant_color"] = color;
  }

  if (platform === "reddit" && mappedLink(target) !== undefined && media.length > 0)
    fail("reddit.link_media", "A Reddit link post takes no attachments.");

  if (platform === "google-business") {
    const topic = config["topicType"];

    if (topic !== undefined && !(isString(topic) && gmbTopics.includes(topic)))
      fail("google_business.topic", "Select STANDARD, EVENT, or OFFER.");
    else if (topic !== undefined) settings["topicType"] = topic;

    const action = objectOption("callToAction", "google_business.cta", ["type", "url"]);

    if (action !== undefined) {
      const type = action["type"];
      const url = action["url"];

      if (!isString(type) || !gmbActions.includes(type))
        fail("google_business.cta", `Select a call to action: ${gmbActions.join(", ")}.`);
      else if (type !== "NONE" && !(isString(url) && isPublicHttps(url)))
        fail("google_business.cta", "A call to action needs a public HTTPS url.");
      else {
        settings["callToActionType"] = type;

        if (isString(url)) settings["callToActionUrl"] = url;
      }
    }

    const event = objectOption("event", "google_business.event", [
      "title",
      "startDate",
      "endDate",
      "startTime",
      "endTime",
    ]);

    if (topic === "EVENT" && event === undefined)
      fail("google_business.event", "An EVENT post needs event details.");

    if (event !== undefined) {
      const { title, startDate, endDate, startTime, endTime } = event;

      const isDay = (value: JsonField) => isString(value) && isoDay.test(value);

      const isTime = (value: JsonField) =>
        value === undefined || (isString(value) && clockTime.test(value));

      if (topic !== "EVENT" && topic !== "OFFER")
        fail("google_business.event", "Event details apply to an EVENT or OFFER post.");
      else if (
        (topic === "EVENT" && !(isString(title) && title.trim() !== "")) ||
        (title !== undefined && !isString(title)) ||
        !isDay(startDate) ||
        !isDay(endDate) ||
        !isTime(startTime) ||
        !isTime(endTime)
      )
        fail(
          "google_business.event",
          "Event details need a title for EVENT posts, YYYY-MM-DD dates, and HH:MM times.",
        );
      else
        Object.assign(
          settings,
          definedFields({
            eventTitle: title,
            eventStartDate: startDate,
            eventEndDate: endDate,
            eventStartTime: startTime,
            eventEndTime: endTime,
          }),
        );
    }

    const offer = objectOption("offer", "google_business.offer", [
      "couponCode",
      "redeemUrl",
      "terms",
    ]);

    if (offer !== undefined) {
      const { couponCode, redeemUrl, terms } = offer;

      if (topic !== "OFFER") fail("google_business.offer", "Offer details need an OFFER post.");
      else if (
        [couponCode, terms].some((value) => value !== undefined && !isString(value)) ||
        (redeemUrl !== undefined && !(isString(redeemUrl) && isPublicHttps(redeemUrl)))
      )
        fail(
          "google_business.offer",
          "Offer details are strings, and redeemUrl is a public HTTPS URL.",
        );
      else
        Object.assign(
          settings,
          definedFields({
            offerCouponCode: couponCode,
            offerRedeemUrl: redeemUrl,
            offerTerms: terms,
          }),
        );
    }
  }

  if (platform === "twitch") {
    const messageType = config["messageType"];
    const color = config["announcementColor"];

    if (messageType !== undefined && messageType !== "message" && messageType !== "announcement")
      fail("twitch.message_type", "Select message or announcement.");
    else if (messageType !== undefined) settings["messageType"] = messageType;

    if (color !== undefined && !(isString(color) && twitchColors.includes(color)))
      fail("twitch.announcement_color", `Select one of ${twitchColors.join(", ")}.`);
    else if (color !== undefined && messageType !== "announcement")
      fail("twitch.announcement_color", "announcementColor needs messageType announcement.");
    else if (color !== undefined) settings["announcementColor"] = color;
  }

  const required = (key: string, code: string, minLength = 1): string | undefined => {
    const value = config[key];

    if (isString(value) && value.trim().length >= minLength) return value;

    fail(code, `${key} is required: a string of at least ${minLength} characters.`);

    return undefined;
  };

  const url = (key: string, code: string): string | undefined => {
    const value = text(key, code);

    if (value === undefined || isPublicHttps(value)) return value;

    fail(code, `${key} must be a public HTTPS URL.`);

    return undefined;
  };

  /** Up to `max` tag names, sent as Postiz `{ value, label }` pairs. */
  const tagPairs = (max: number, code: string): JsonObject[] | undefined => {
    const names = strings("tags", code);

    if (names !== undefined && names.length > max) fail(code, `Use at most ${max} tags.`);

    return names?.map((name) => ({ value: name, label: name }));
  };

  /** A list of positive whole-number IDs, such as WordPress category IDs. */
  const numericIds = (key: string, code: string): readonly number[] | undefined => {
    const value = config[key];

    if (value === undefined) return undefined;

    const ids = isJsonArray(value)
      ? value.filter(isFiniteNumber).filter((item) => Number.isSafeInteger(item) && item > 0)
      : [];

    if (isJsonArray(value) && value.length > 0 && ids.length === value.length) return ids;

    fail(code, `${key} must be a non-empty list of numeric IDs.`);

    return undefined;
  };

  const mainImage = url("mainImage", "postiz.main_image");

  if (mainImage !== undefined && !isImageThumbnail({ kind: "https-url", url: mainImage }))
    fail(
      "postiz.main_image",
      "mainImage must be a public HTTPS URL ending in .png, .jpg, .jpeg, .gif, or .webp.",
    );

  switch (platform) {
    case "slack":
      Object.assign(settings, definedFields({ channel: required("channelId", "slack.channel") }));
      break;

    case "lemmy": {
      const communities = config["communities"];
      const targets: JsonObject[] = [];

      for (const item of isJsonArray(communities) ? communities : []) {
        const row = isJsonObject(item) ? item : {};
        const { id, name, title, url: link } = row;

        if (
          !isString(id) ||
          id.trim() === "" ||
          !isString(name) ||
          name.trim().length < 2 ||
          !isString(title) ||
          title.trim().length < 2 ||
          (link !== undefined && !(isString(link) && isPublicHttps(link))) ||
          Object.keys(row).some((field) => !["id", "name", "title", "url"].includes(field))
        )
          continue;

        targets.push({ value: { subreddit: name, id, title, ...definedFields({ url: link }) } });
      }

      if (
        !isJsonArray(communities) ||
        targets.length === 0 ||
        targets.length !== communities.length
      )
        fail(
          "lemmy.communities",
          "communities lists { id, name, title, url? } targets: name and title of 2 or more characters, url a public HTTPS link.",
        );
      else settings["subreddit"] = targets;

      break;
    }

    case "warpcast": {
      const channels = strings("channels", "warpcast.channels");

      if (channels !== undefined) settings["subreddit"] = channels.map((id) => ({ value: { id } }));

      break;
    }

    case "medium":
      Object.assign(
        settings,
        definedFields({
          title: required("title", "medium.title", 2),
          subtitle: required("subtitle", "medium.subtitle", 2),
          canonical: url("canonicalUrl", "medium.canonical"),
          publication: text("publicationId", "medium.publication"),
          tags: tagPairs(4, "medium.tags"),
        }),
      );
      break;

    case "devto":
      Object.assign(
        settings,
        definedFields({
          title: required("title", "devto.title", 2),
          canonical: url("canonicalUrl", "devto.canonical"),
          organization: text("organizationId", "devto.organization"),
          tags: tagPairs(4, "devto.tags"),
        }),
      );
      break;

    case "hashnode": {
      const subtitle = text("subtitle", "hashnode.subtitle");
      const hashnodeTags = config["tags"];
      const pairs: JsonObject[] = [];

      if (subtitle !== undefined && subtitle.trim().length < 2)
        fail("hashnode.subtitle", "subtitle needs at least 2 characters.");

      for (const item of isJsonArray(hashnodeTags) ? hashnodeTags : []) {
        const row = isJsonObject(item) ? item : {};
        const { id, name } = row;

        if (isString(id) && id.trim() !== "" && isString(name) && name.trim() !== "")
          pairs.push({ value: id, label: name });
      }

      if (!isJsonArray(hashnodeTags) || pairs.length === 0 || pairs.length !== hashnodeTags.length)
        fail("hashnode.tags", "Hashnode needs one or more tags, each { id, name }.");

      Object.assign(
        settings,
        definedFields({
          title: required("title", "hashnode.title", 6),
          subtitle,
          canonical: url("canonicalUrl", "hashnode.canonical"),
          publication: required("publicationId", "hashnode.publication"),
          tags: pairs,
        }),
      );
      break;
    }

    case "wordpress": {
      const status = config["status"];

      if (status !== undefined && !(isString(status) && wordpressStatuses.includes(status)))
        fail("wordpress.status", `Select one of ${wordpressStatuses.join(", ")}.`);

      Object.assign(
        settings,
        definedFields({
          title: required("title", "wordpress.title", 2),
          type: required("postType", "wordpress.type"),
          status: isString(status) ? status : undefined,
          categories: numericIds("categoryIds", "wordpress.categories"),
          tags: numericIds("tagIds", "wordpress.tags"),
        }),
      );
      break;
    }

    case "listmonk":
      Object.assign(
        settings,
        definedFields({
          subject: required("subject", "listmonk.subject"),
          preview: required("preview", "listmonk.preview"),
          list: required("listId", "listmonk.list"),
          template: text("templateId", "listmonk.template"),
        }),
      );
      break;

    case "dribbble":
      if (media.length !== 1)
        fail("dribbble.media", "A Dribbble shot is exactly one 400x300 or 800x600 image.");

      Object.assign(
        settings,
        definedFields({
          title: required("title", "dribbble.title"),
          team: url("teamUrl", "dribbble.team"),
        }),
      );
      break;

    case "tumblr": {
      const title = text("title", "tumblr.title");
      const names = strings("tags", "tumblr.tags");
      const joined = names?.join(", ");

      if (title !== undefined && title.length > 4096)
        fail("tumblr.title", "Tumblr titles are limited to 4096 characters.");

      if (
        joined !== undefined &&
        (joined.length > 4096 || names?.some((name) => name.includes(",")))
      )
        fail("tumblr.tags", "Tumblr tags join to at most 4096 characters and contain no commas.");

      Object.assign(
        settings,
        definedFields({
          title,
          link: url("link", "tumblr.link"),
          sourceUrl: url("sourceUrl", "tumblr.source_url"),
          tags: joined,
        }),
      );
      break;
    }

    case "mewe": {
      const postType = config["postType"];
      const groupId = text("groupId", "mewe.group");

      if (postType !== "timeline" && postType !== "group")
        fail("mewe.post_type", "Select postType timeline or group.");
      else if (postType === "group" && groupId === undefined)
        fail("mewe.group", "A MeWe group post needs groupId.");
      else if (postType === "timeline" && groupId !== undefined)
        fail("mewe.group", "groupId applies only to postType group.");
      else Object.assign(settings, { postType, ...definedFields({ group: groupId }) });

      break;
    }

    case "moltbook":
      Object.assign(settings, definedFields({ submolt: required("submolt", "moltbook.submolt") }));
      break;

    case "skool":
      Object.assign(
        settings,
        definedFields({
          group: required("groupId", "skool.group"),
          label: required("labelId", "skool.label"),
          title: required("title", "skool.title"),
        }),
      );
      break;

    case "whop":
      Object.assign(
        settings,
        definedFields({
          company: required("companyId", "whop.company"),
          experience: required("experienceId", "whop.experience"),
          title: text("title", "whop.title"),
        }),
      );
      break;

    default:
      break;
  }

  const plan: PostizPlan = {
    draft,
    shortLink,
    tags,
    thread,
    settings,
    ...definedFields({ thumbnailTimestamp, inter: inter ?? undefined, mainImage }),
  };

  return { issues, plan };
}

/** Declarations for the Postiz-only channels, which sit outside the shared platform list. */
function channelCapabilities(): CapabilityDeclaration[] {
  return Array.from(postizChannels).flatMap(([platform, channel]) => {
    const formats: CapabilityDeclaration["formats"] =
      platform === "dribbble"
        ? ["image"]
        : channel.media === "none"
          ? ["text"]
          : channel.media === "images"
            ? ["text", "image", "carousel"]
            : ["text", "image", "video", "carousel"];

    const operations = [
      "accounts.read",
      "posts.publish",
      "posts.schedule",
      "posts.status",
      "posts.list",
      "posts.cancelScheduled",
      "posts.deleteBackendRecord",
      ...(channel.media === "none" ? [] : ["media.upload"]),
    ];

    return operations.map((operation) => ({
      platform,
      operation,
      availability: "available" as const,
      surface: "normalized" as const,
      ...definedFields({ formats: operation === "posts.publish" ? formats : undefined }),
      constraints: managedConstraints(
        operation,
        operation === "media.upload" || operation === "posts.publish"
          ? ["https-url", "media-ref", "blob", "stream"]
          : undefined,
      ),
      notes:
        "Contract implementation; live account verification and provider/platform eligibility are separate. A Postiz-only channel type, listed under its Postiz identifier.",
    }));
  });
}

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
 * `<postiz post id>@<ISO time>`. An identifier for a post this adapter created or edited
 * also carries the group Postiz assigned it, `~<group>`, which cancellation and deletion
 * require. Treat them as opaque.
 */
function encodeId(postId: string, at: string, group?: string): string {
  return group === undefined ? `${postId}@${at}` : `${postId}@${at}~${group}`;
}

interface PostizRecordId {
  postId: string;
  at: number;
  /** The group Postiz assigned when this adapter saved the post, when the identifier has one. */
  group: string | undefined;
}

function decodeId(value: string, operation: string): PostizRecordId {
  const tilde = value.indexOf("~");
  const base = tilde === -1 ? value : value.slice(0, tilde);
  const group = tilde === -1 ? undefined : value.slice(tilde + 1);
  const split = base.lastIndexOf("@");
  const postId = base.slice(0, split);
  const at = Date.parse(base.slice(split + 1));

  if (
    split < 1 ||
    !recordId.test(postId) ||
    !Number.isFinite(at) ||
    (group !== undefined && !recordId.test(group))
  )
    reject(operation, "Use the Postiz delivery, job, or record identifier the adapter returned.");

  return { postId, at, group };
}

/**
 * The identifier for a post this adapter just saved, carrying the group Postiz assigned.
 * The public API ignores a `group` in the request and gives each saved post a fresh one.
 */
function ownedId(row: JsonObject, at: string): string {
  const postId = string(row["id"]);
  const group = optionalString(row["group"]);

  return encodeId(postId, at, group !== undefined && recordId.test(group) ? group : undefined);
}

/** Postiz analytics labels such as `Impressions` or `Link Clicks`, as camelCase names. */
function metricName(label: string): string {
  const words = label.toLowerCase().match(/[a-z0-9]+/g) ?? [];

  return words
    .map((word, index) => (index === 0 ? word : word[0]?.toUpperCase() + word.slice(1)))
    .join("");
}

/** The latest value of each labelled series Postiz returns from an analytics route. */
function analyticsMetrics(result: JsonValue, source: string, fetchedAt: string): MetricValue[] {
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
      fetchedAt,
      freshness: "unknown",
      source,
      ...definedFields({
        measuredAt: Number.isFinite(measured) ? new Date(measured).toISOString() : undefined,
      }),
    });
  }

  return values;
}

function postRecordId(ref: PostizPostRef): string {
  switch (ref.kind) {
    case "delivery":
      return ref.deliveryId;
    case "scheduled-job":
      return ref.jobId;
    case "backend-post":
      return ref.recordId;
    default: {
      const exhaustive: never = ref;

      return exhaustive;
    }
  }
}

function pageNumber(value: number | undefined, first: number, operation: string): string {
  const page = value ?? first;

  if (!Number.isSafeInteger(page) || page < first)
    reject(operation, `Use a whole page number from ${first}.`);

  return String(page);
}

function mediaItem(value: JsonValue): PostizMediaItem {
  const row = object(value);

  return {
    id: string(row["id"]),
    path: httpsUrl(string(row["path"])).href,
    ...definedFields({
      name: optionalString(row["name"]),
      originalName: optionalString(row["originalName"]),
      createdAt: optionalString(row["createdAt"]),
    }),
  };
}

function clipping(value: JsonValue): PostizClipping {
  const row = object(value);
  const clips = row["clips"];

  return {
    id: string(row["id"]),
    status: string(row["status"]),
    clips: clips === undefined ? [] : array(clips).map(object),
    ...definedFields({
      url: optionalString(row["url"]),
      error: optionalString(row["error"]),
      title: optionalString(row["title"]),
    }),
  };
}

const youtubeHost = /^(?:www\.|m\.)?youtube\.com$|^youtu\.be$/;

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

  const group = options.group === undefined ? undefined : channelId(options.group, "createAdapter");

  const clock = () => options.clock?.() ?? new Date();
  const now = () => clock().toISOString();

  const account = (value: JsonValue, backend: string): AccountRecord | undefined => {
    const row = object(value);
    const slug = mappedPlatform(nativePlatforms, string(row["identifier"]), options);

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
    array(
      await request("/integrations", context, undefined, group === undefined ? {} : { group }),
    ).flatMap((value) => {
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
  ): Promise<{ row: JsonObject; nearby: JsonObject[]; owned: boolean }> => {
    accountMatches(ref, context);
    const { postId, at, group } = decodeId(id, operation);
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
      mappedPlatform(nativePlatforms, string(integration["providerIdentifier"]), options) !==
        ref.platform
    )
      throw new SocialError({
        code: "unauthorized",
        operation,
        message: "The Postiz post does not belong to the authorized account.",
      });

    // The identifier still names the group Postiz gave the post when this adapter saved it.
    return { row, nearby, owned: group !== undefined && row["group"] === group };
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

      case "ERROR": {
        const reason = optionalString(row["error"]);

        return {
          ...base,
          state: "failed",
          code: "upstream_failure",
          message: reason
            ? `Postiz reports that this post failed: ${reason}`
            : "Postiz reports that this post failed without a reason; inspect the post and channel in Postiz.",
          retryDisposition: { kind: "never" },
        };
      }

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
    adjust = false,
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
          "This adapter requires URL paths ending in .png, .jpg, .jpeg, .gif, .webp, or .mp4.",
        );

      result = await request("/upload-from-url", context, {
        url: url.href,
        ...definedFields({ adjust: adjust || undefined }),
      });
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

      if (adjust) form.set("adjust", "true");
      result = await request("/upload", context, form);
    }

    const row = object(result);

    const path = httpsUrl(string(row["path"]));

    if (!urlExtension.test(path.pathname))
      reject("media.upload", "Postiz returned an upload path unsupported by its post schema.");

    return { id: string(row["id"]), path: path.href };
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

    let path = httpsUrl(stored.publicUrl);

    // An adjusted upload is re-encoded in the background and may get a new path.
    if (options.adjustMedia === true) {
      const status = await mediaStatus(stored.providerKey, context);

      if (status.status !== "ready")
        throw new SocialError({
          code: "media_error",
          operation: "media.resolve",
          message:
            status.status === "processing"
              ? "Postiz is still adjusting this media. Publish again once getMediaStatus reports ready."
              : "Postiz could not adjust this media, and the original cannot be published as is.",
        });

      if (status.path !== undefined) path = httpsUrl(status.path);
    }

    if (!urlExtension.test(path.pathname))
      reject("media.resolve", "Stored Postiz media has a path unsupported by its post schema.");

    return { id: stored.providerKey, path: path.href };
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
          ...definedFields({ title: optionalString(config["title"]) }),
        };
      case "pinterest":
        return {
          board: string(config["boardId"]),
          ...definedFields({
            title: optionalString(config["title"]),
            link: optionalString(config["link"]),
          }),
        };
      case "reddit": {
        const link = mappedLink(target);

        return {
          subreddit: [
            {
              value: {
                subreddit: `/r/${subredditName(string(config["subreddit"]))}`,
                title: string(config["title"]),
                // Postiz uploads the first attached image or video for a media post.
                type: link ? "link" : (target.content.media ?? []).length > 0 ? "media" : "self",
                is_flair_required: false,
                ...definedFields({ url: link }),
              },
            },
          ],
        };
      }

      case "discord":
        return { channel: string(config["channelId"]) };
      default:
        return {};
    }
  };

  const manifest = capabilityManifest(
    "postiz",
    "Public API v1, source 374fb20 read 2026-09-25",
    [
      "accounts.read",
      "posts.publish",
      "posts.schedule",
      "posts.status",
      "posts.list",
      "posts.cancelScheduled",
      "posts.deleteBackendRecord",
      "analytics.read",
      "analytics.account.read",
      "media.upload",
    ],
    postizFormats,
    (_platform, operation) =>
      managedConstraints(
        operation,
        operation === "media.upload"
          ? ["https-url", "media-ref", "blob", "stream"]
          : operation === "posts.publish"
            ? ["https-url", "media-ref", "blob", "stream"]
            : undefined,
      ),
    {
      facebook:
        "Postiz's Facebook integration is Page-scoped; personal profiles are not supported.",
    },
  );

  const adapter = defineAdapter({
    id: "postiz",
    capabilities: {
      ...manifest,
      capabilities: [...manifest.capabilities, ...channelCapabilities()],
    },
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
        const uploaded = await uploadMedia(item, context, options.adjustMedia === true);

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
        const config = optionsObject(target);

        // The shared checks see only the options they map; this adapter parses the rest.
        const channel = postizChannels.get(target.account.platform);

        const shared = {
          ...target,
          options: withoutKeys(config, [
            ...postKeys,
            ...(ownKeys[target.account.platform] ?? channel?.keys ?? []),
          ]),
        };

        const link = mappedLink(target);

        const issues: PreparationIssue[] = [
          ...managedPreparation(shared, "postiz").filter(
            (issue) =>
              // A mapped link is the post's content, so it needs no text or media.
              (link === undefined ||
                (issue.code !== "link.explicit_text" && issue.code !== "content.empty")) &&
              // Postiz-only channels are declared by this adapter, not the shared platform list.
              (channel === undefined || issue.code !== "platform.unsupported"),
          ),
          ...managedOptionIssues(shared, "postiz"),
          ...postizPlan(target, config).issues,
        ];

        const fail = (code: string, message: string, severity: "error" | "warning" = "error") =>
          issues.push({ code, message, severity, targetIndex: target.targetIndex });

        const at = target.schedule?.at;

        if (at !== undefined && !(Date.parse(at) > clock().getTime()))
          fail("schedule.past", "Postiz needs a future schedule time. Omit it to publish now.");

        const media = target.content.media ?? [];
        const platform = target.account.platform;

        // Postiz's Twitch provider sends only the first 500 characters to chat and ignores media.
        if (platform === "twitch") {
          if (media.length > 0)
            fail("twitch.media_unsupported", "Postiz posts Twitch chat messages as text only.");

          if ((target.content.text ?? "").length > twitchMaxLength)
            fail(
              "twitch.text_too_long",
              "Postiz Twitch chat messages are limited to 500 characters.",
            );
        }

        if (channel !== undefined) {
          const images = media.filter((item) => item.kind === "image").length;
          const videos = media.filter((item) => item.kind === "video").length;

          if ((target.content.text ?? "").length > channel.maxLength)
            fail(
              `${platform}.text_too_long`,
              `Postiz limits ${platform} posts to ${channel.maxLength} characters.`,
            );

          if (channel.media === "none" && media.length > 0)
            fail(`${platform}.media_unsupported`, `Postiz posts ${platform} content as text only.`);
          else if (channel.media === "images" && videos > 0)
            fail(`${platform}.video_unsupported`, `Postiz takes images only on ${platform}.`);
          else if (videos > 1)
            fail(`${platform}.media_count`, `Postiz takes at most one video on ${platform}.`);

          if (channel.maxImages !== undefined && images > channel.maxImages)
            fail(
              `${platform}.media_count`,
              `Postiz takes at most ${channel.maxImages} images on ${platform}.`,
            );
        }

        // Postiz's Reddit provider uploads exactly one attachment, and an MP4 needs a poster image.
        if (platform === "reddit" && media.length > 1)
          fail("reddit.media_count", "Postiz Reddit media posts take exactly one image or video.");

        for (const item of media) {
          const redditVideo = platform === "reddit" && item.kind === "video";

          if (redditVideo && item.thumbnail === undefined)
            fail(
              "reddit.video_thumbnail_required",
              "Postiz Reddit video posts need a thumbnail image at a public HTTPS URL.",
            );
          else if (redditVideo && !isImageThumbnail(item.thumbnail))
            fail(
              "reddit.video_thumbnail_source",
              "Use a public HTTPS thumbnail URL ending in .png, .jpg, .jpeg, .gif, or .webp.",
            );
          else if (
            platform === "youtube" &&
            item.kind === "video" &&
            item.thumbnail !== undefined &&
            !isImageThumbnail(item.thumbnail)
          )
            fail(
              "youtube.thumbnail_source",
              "Use a public HTTPS thumbnail URL ending in .png, .jpg, .jpeg, .gif, or .webp.",
            );
          else if (!redditVideo && platform !== "youtube" && item.thumbnail !== undefined)
            fail(
              "media.thumbnail_unsupported",
              "Postiz custom thumbnails map only to Reddit and YouTube videos in this adapter.",
            );

          if (item.kind === "document") {
            fail("media.document_unsupported", "Postiz accepts image and video media only.");
            continue;
          }

          if (item.mimeType && !mimeTypes.some((value) => value === item.mimeType))
            fail(
              "media.mime_unsupported",
              "Postiz publish paths accept JPEG, PNG, GIF, WebP images and MP4 videos.",
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
                "This adapter requires URL paths ending in .png, .jpg, .jpeg, .gif, .webp, or .mp4. Upload the bytes instead.",
              );
          }

          const size = item.source.kind === "blob" ? item.source.blob.size : item.byteSize;

          if (size !== undefined && size > maxBytes[item.kind])
            fail("media.too_large", "Postiz accepts images up to 10 MB and MP4 videos up to 1 GB.");
        }

        if (link !== undefined && !isPublicHttps(link))
          fail("link.url", "Provide the link as a public HTTPS URL.");

        if (target.account.platform === "instagram" && config["shareToFeed"] === false)
          fail(
            "instagram.share_to_feed_unsupported",
            "Postiz has no setting to keep an Instagram reel off the grid.",
          );

        if (target.account.platform === "tiktok" && config["draft"] === true)
          fail(
            "tiktok.draft_settings_ignored",
            "Postiz TikTok UPLOAD ignores settings except its title. Publish the inbox item within 24 hours; no caption or privacy guarantee is made.",
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

        const { issues, plan } = postizPlan(target, optionsObject(target));

        if (issues.length > 0) reject("posts.publish", string(issues[0]?.message));

        const platform = target.account.platform;
        const image: JsonObject[] = [];
        let youtubeThumbnail: JsonObject | undefined;

        for (const item of target.content.media ?? []) {
          const thumbnail = item.thumbnail;
          let thumbnailUrl: string | undefined;

          if (thumbnail !== undefined) {
            if (item.kind !== "video" || !isImageThumbnail(thumbnail))
              reject(
                "posts.publish",
                "Postiz custom thumbnails map only to Reddit and YouTube videos, from a public HTTPS image URL.",
              );
            else if (platform === "reddit") thumbnailUrl = httpsUrl(thumbnail.url).href;
            // YouTube takes its thumbnail as an uploaded Postiz file in the settings.
            else if (platform === "youtube")
              youtubeThumbnail = await uploadMedia(thumbnailImage(thumbnail), context);
            else
              reject(
                "posts.publish",
                "Postiz custom thumbnails map only to Reddit and YouTube videos, from a public HTTPS image URL.",
              );
          }

          const media = await resolveMedia(item, target.account, context);

          image.push({
            ...media,
            ...definedFields({
              alt: item.altText,
              thumbnail: thumbnailUrl,
              thumbnailTimestamp: item.kind === "video" ? plan.thumbnailTimestamp : undefined,
            }),
          });
        }

        // Dev.to, Hashnode and WordPress take the cover as an uploaded Postiz file.
        const mainImage =
          plan.mainImage === undefined
            ? undefined
            : await uploadMedia(
                thumbnailImage({ kind: "https-url", url: plan.mainImage }),
                context,
              );

        // Media uploads can outlast a near schedule.
        if (at !== undefined && !(Date.parse(at) > clock().getTime()))
          reject("posts.publish", "The schedule time passed while media uploaded.");

        const date = at === undefined ? now() : new Date(at).toISOString();

        const response = await request("/posts", context, {
          type: plan.draft ? "draft" : at === undefined ? "now" : "schedule",
          date,
          shortLink: plan.shortLink,
          ...definedFields({ inter: plan.inter }),
          tags: [...plan.tags],
          posts: [
            {
              integration: { id: target.account.accountId },
              value: [{ content: target.content.text ?? "", image }, ...plan.thread],
              settings: {
                ...settings(target),
                ...plan.settings,
                ...definedFields({ thumbnail: youtubeThumbnail, main_image: mainImage }),
              },
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

          return outcome(row, ownedId(row, date), target.account, target.targetIndex);
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

          // The create ID confirms acceptance, but says nothing about the current queue state.
          return {
            state: "accepted",
            targetIndex: target.targetIndex,
            account: target.account,
            observedAt: now(),
            delivery: {
              kind: "delivery",
              version: 1,
              backend: target.account.backend,
              platform: target.account.platform,
              accountId: target.account.accountId,
              deliveryId: id,
            },
          };
        }
      },
      /**
       * Postiz lists posts only by date range, so each page covers one week, newest first,
       * from 30 days ahead back to 365 days ago. A page can be empty while later pages are not.
       */
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        accountMatches(account, context);

        const limit = input.limit ?? 25;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          reject("posts.list", "Use a page size from 1 to 100.");

        const start = clock().getTime();
        let end = start + 30 * day;
        let offset = 0;

        if (input.cursor !== undefined) {
          const match = /^w(\d{1,15})o(\d{1,6})$/.exec(input.cursor);
          const cursorEnd = Number(match?.[1]);

          if (!match || !Number.isSafeInteger(cursorEnd))
            return reject("posts.list", "Use the cursor the previous page returned.");

          end = cursorEnd;
          offset = Number(match[2]);
        }

        const from = end - 7 * day;

        const rows = array(
          object(
            await request("/posts", context, undefined, {
              startDate: new Date(from).toISOString(),
              endDate: new Date(end).toISOString(),
            }),
          )["posts"],
        )
          .map(object)
          .filter((row) => {
            const integration = row["integration"];

            return (
              isJsonObject(integration) &&
              integration["id"] === account.accountId &&
              mappedPlatform(
                nativePlatforms,
                optionalString(integration["providerIdentifier"]) ?? "",
                options,
              ) === account.platform
            );
          })
          .flatMap((row) => {
            const at = Date.parse(optionalString(row["publishDate"]) ?? "");
            const id = optionalString(row["id"]);

            if (!Number.isFinite(at) || id === undefined || !recordId.test(id)) return [];

            const publishDate = new Date(at).toISOString();

            return [
              {
                at,
                item: {
                  id: encodeId(id, publishDate),
                  publishDate,
                  ...definedFields({
                    state: optionalString(row["state"]),
                    text: optionalString(row["content"]),
                    url: optionalString(row["releaseURL"]) || undefined,
                  }),
                } satisfies JsonObject,
              },
            ];
          })
          .sort((a, b) => b.at - a.at)
          .map((entry) => entry.item);

        const nextCursor =
          offset + limit < rows.length
            ? `w${end}o${offset + limit}`
            : from > start - 365 * day
              ? `w${from}o0`
              : undefined;

        return {
          items: rows.slice(offset, offset + limit),
          ...definedFields({ nextCursor }),
        };
      },
      async getDelivery(
        ref: { deliveryId: string; accountId: string; platform: string; backend: string },
        context: AdapterOperationContext,
      ) {
        const slug =
          providerPlatforms.postiz.find((value) => value === ref.platform) ??
          (postizChannels.has(ref.platform) ? ref.platform : undefined);

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
        const { row, nearby, owned } = await record(
          ref.jobId,
          ref,
          context,
          "posts.cancelScheduled",
        );

        const publishDate = Date.parse(optionalString(row["publishDate"]) ?? "");

        if (row["state"] !== "QUEUE" || !(publishDate > clock().getTime()))
          reject(
            "posts.cancelScheduled",
            "Only a future scheduled post can be cancelled. Reconcile a due or dispatched post.",
          );

        await remove({ row, nearby, owned }, "posts.cancelScheduled", context);

        return { state: "cancelled", backendRecord: "deleted" };
      },
      async deleteBackendRecord(ref: BackendPostRef, context: AdapterOperationContext) {
        const { row, nearby, owned } = await record(
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

        await remove({ row, nearby, owned }, "posts.deleteBackendRecord", context);
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

        return normalizeMetrics(
          analyticsMetrics(result, `postiz:${ref.platform}:analytics`, now()),
        );
      },
      /** Channel metrics such as followers and impressions over the last 30 days. */
      async getAccountMetrics(
        account: ConnectedAccountRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        accountMatches(account, context);

        const result = await request(
          `/analytics/${encodeURIComponent(channelId(account.accountId, "analytics.account.read"))}`,
          context,
          undefined,
          { date: "30" },
        );

        return normalizeMetrics(
          analyticsMetrics(result, `postiz:${account.platform}:account`, now()),
        );
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

      /** `GET /me`: the workspace these credentials act on, and the approving user for OAuth tokens. */
      async me(context: AdapterOperationContext): Promise<PostizWorkspace> {
        const row = object(await request("/me", context));
        const organization = object(row["organization"]);
        const user = row["user"];
        const approver = user === null || user === undefined ? undefined : object(user);

        return {
          organization: {
            id: string(organization["id"]),
            ...definedFields({ name: optionalString(organization["name"]) }),
          },
          ...definedFields({
            user: approver && {
              id: string(approver["id"]),
              ...definedFields({
                name: optionalString(approver["name"]),
                picture: optionalString(approver["picture"]),
              }),
            },
          }),
        };
      },

      /** `GET /is-connected`: true when Postiz accepts the configured credentials. */
      async isConnected(context: AdapterOperationContext): Promise<boolean> {
        return object(await request("/is-connected", context))["connected"] === true;
      },

      /** `GET /groups`: the workspace's customers, which you can pass as the `group` option. */
      async listGroups(context: AdapterOperationContext): Promise<readonly PostizGroup[]> {
        return array(await request("/groups", context)).map((value) => {
          const row = object(value);

          return {
            id: string(row["id"]),
            ...definedFields({ name: optionalString(row["name"]) }),
          };
        });
      },

      /**
       * `DELETE /integrations/:id`: delete a channel. Postiz also deletes every scheduled post
       * on it. Pass the channel ID again as `confirmAccountId` to confirm.
       */
      async deleteChannel(
        account: ConnectedAccountRef,
        input: { readonly confirmAccountId: string },
        context: AdapterOperationContext,
      ): Promise<void> {
        accountMatches(account, context);

        const id = channelId(account.accountId, "accounts.delete");

        if (input.confirmAccountId !== id)
          reject("accounts.delete", "Confirm the channel deletion with the same channel ID.");

        const result = await request(
          `/integrations/${encodeURIComponent(id)}`,
          context,
          undefined,
          {},
          "DELETE",
        );

        if (isJsonObject(result) && result["id"] === id) return;

        throw new SocialError({
          code: "ambiguous_outcome",
          operation: "accounts.delete",
          message: "Postiz did not confirm the channel deletion. Check the channel in Postiz.",
          retryDisposition: { kind: "reconcile-first" },
        });
      },

      /**
       * `GET /integration-settings/:id`: the channel's posting rules, maximum length, settings
       * schema, and the tools `triggerTool` can run.
       */
      async getChannelSettings(
        account: ConnectedAccountRef,
        context: AdapterOperationContext,
      ): Promise<PostizChannelSettings> {
        accountMatches(account, context);

        const result = object(
          await request(
            `/integration-settings/${encodeURIComponent(channelId(account.accountId, "accounts.settings"))}`,
            context,
          ),
        );

        const output = object(result["output"]);
        const tools = output["tools"];

        return {
          tools: (tools === undefined || tools === null ? [] : array(tools)).map((value) => {
            const tool = object(value);
            const schema = tool["dataSchema"];

            return {
              methodName: string(tool["methodName"]),
              dataSchema: schema === undefined ? [] : array(schema),
              ...definedFields({ description: optionalString(tool["description"]) }),
            };
          }),
          ...definedFields({
            rules: optionalString(output["rules"]),
            maxLength: optionalNumber(output["maxLength"]),
            settings: output["settings"],
          }),
        };
      },

      /**
       * `POST /integration-trigger/:id`: run a provider tool listed by `getChannelSettings`,
       * such as Instagram `audioSearch`, LinkedIn `mention`, or a Discord channel list.
       */
      async triggerTool(
        account: ConnectedAccountRef,
        input: { readonly methodName: string; readonly data?: Readonly<Record<string, string>> },
        context: AdapterOperationContext,
      ): Promise<JsonValue> {
        accountMatches(account, context);

        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.methodName))
          reject("accounts.tool", "Use a tool methodName from getChannelSettings.");

        const result = object(
          await request(
            `/integration-trigger/${encodeURIComponent(channelId(account.accountId, "accounts.tool"))}`,
            context,
            { methodName: input.methodName, data: input.data ?? {} },
          ),
        );

        return result["output"] ?? null;
      },

      /** `GET /find-slot/:id`: the channel's next free time slot, for `schedule.at`. */
      async findSlot(
        account: ConnectedAccountRef,
        context: AdapterOperationContext,
      ): Promise<{ readonly at: string }> {
        accountMatches(account, context);

        const result = object(
          await request(
            `/find-slot/${encodeURIComponent(channelId(account.accountId, "posts.schedule"))}`,
            context,
          ),
        );

        const at = Date.parse(string(result["date"]));

        if (!Number.isFinite(at))
          throw new SocialError({
            code: "upstream_failure",
            operation: "posts.schedule",
            message: "Postiz returned an unreadable slot time.",
          });

        return { at: new Date(at).toISOString() };
      },

      /** `GET /media`: the workspace media library, newest first, 18 files per page. */
      async listMedia(
        input: { readonly page?: number; readonly search?: string },
        context: AdapterOperationContext,
      ): Promise<{ readonly pages: number; readonly items: readonly PostizMediaItem[] }> {
        const result = object(
          await request("/media", context, undefined, {
            page: pageNumber(input.page, 1, "media.list"),
            ...definedFields({ search: input.search }),
          }),
        );

        return {
          pages: optionalNumber(result["pages"]) ?? 0,
          items: array(result["results"]).map(mediaItem),
        };
      },

      /** `GET /media/:id/status`: whether a file uploaded with `adjustMedia` finished adjusting. */
      async getMediaStatus(
        ref: MediaRef,
        context: AdapterOperationContext,
      ): Promise<PostizMediaStatus> {
        accountMatches(ref, context);

        return mediaStatus(await uploadedId(ref), context);
      },

      /** `GET /notifications`: workspace notifications, newest first, 100 per page from page 0. */
      async listNotifications(
        input: { readonly page?: number },
        context: AdapterOperationContext,
      ): Promise<{ readonly items: readonly PostizNotification[]; readonly hasMore: boolean }> {
        const result = object(
          await request("/notifications", context, undefined, {
            page: pageNumber(input.page, 0, "notifications.list"),
          }),
        );

        return {
          hasMore: result["hasMore"] === true,
          items: array(result["notifications"]).map((value) => {
            const row = object(value);

            return {
              id: string(row["id"]),
              content: optionalString(row["content"]) ?? "",
              ...definedFields({
                link: optionalString(row["link"]),
                createdAt: optionalString(row["createdAt"]),
              }),
            };
          }),
        };
      },

      /**
       * `PUT /posts/:id/status`: move an unpublished post to `draft`, which stops its publishing
       * workflow, or back to `schedule`, which publishes it at its stored date.
       */
      async changeStatus(
        ref: PostizPostRef,
        status: "draft" | "schedule",
        context: AdapterOperationContext,
      ): Promise<{ readonly state: "DRAFT" | "QUEUE" }> {
        if (status !== "draft" && status !== "schedule")
          reject("posts.status.update", "Choose draft or schedule.");

        const { row } = await record(postRecordId(ref), ref, context, "posts.status.update");

        if (row["state"] !== "QUEUE" && row["state"] !== "DRAFT")
          reject("posts.status.update", "Only a queued or draft Postiz post changes status.");

        return acknowledged(
          "posts.status.update",
          request(
            `/posts/${encodeURIComponent(string(row["id"]))}/status`,
            context,
            { status },
            {},
            "PUT",
          ),
          (reply) => {
            const result = object(reply);

            const state = result["state"];
            const expected = status === "draft" ? "DRAFT" : "QUEUE";

            if (result["id"] === row["id"] && state === expected) return { state: expected };

            throw new SocialError({
              code: "ambiguous_outcome",
              operation: "posts.status.update",
              message: "Postiz did not confirm the status change. Read the post before retrying.",
              retryDisposition: { kind: "reconcile-first" },
            });
          },
        );
      },

      /**
       * `PUT /posts/:id/settings`: merge provider settings, using Postiz's own keys, into a
       * scheduled or draft post. Content and publish date stay as they are.
       */
      async updateSettings(
        ref: PostizPostRef,
        settings: JsonObject,
        context: AdapterOperationContext,
      ): Promise<{ readonly publishDate?: string }> {
        if (!isJsonValue(settings) || !isJsonObject(settings) || Object.keys(settings).length === 0)
          reject("posts.update", "Pass the Postiz settings keys to change.");

        const { row } = await record(postRecordId(ref), ref, context, "posts.update");

        if (row["state"] !== "QUEUE" && row["state"] !== "DRAFT")
          reject("posts.update", "Postiz changes settings only before a post publishes.");

        return acknowledged(
          "posts.update",
          request(
            `/posts/${encodeURIComponent(string(row["id"]))}/settings`,
            context,
            { settings },
            {},
            "PUT",
          ),
          (reply) => {
            const result = object(reply);

            if (result["postId"] !== row["id"])
              throw new SocialError({
                code: "ambiguous_outcome",
                operation: "posts.update",
                message:
                  "Postiz did not confirm the settings change. Read the post before retrying.",
                retryDisposition: { kind: "reconcile-first" },
              });

            return definedFields({ publishDate: optionalString(result["publishDate"]) });
          },
        );
      },

      /**
       * `POST /posts` with the post's own `value[].id`: replace the text and media of the post's
       * first part. A queued or draft post is saved with `type: "update"`, which keeps its date,
       * state, settings, tags, and repeat interval. A published or failed post changes only when
       * `republish` is true: Postiz then publishes the edited post again now (`republish: true`).
       */
      async editPost(
        ref: PostizPostRef,
        edit: PostizPostEdit,
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        const operation = "posts.update";

        if (!isString(edit.text) || !Array.isArray(edit.media))
          reject(operation, "Pass the new text and the full list of media.");

        if (edit.text.trim() === "" && edit.media.length === 0)
          reject(operation, "A Postiz post needs text or media.");

        if (edit.republish !== undefined && !isBoolean(edit.republish))
          reject(operation, "republish must be a boolean.");

        const { row, owned } = await record(postRecordId(ref), ref, context, operation);
        const state = row["state"];
        const republish = edit.republish === true;

        if ((state === "QUEUE" || state === "DRAFT") && republish)
          reject(operation, "Edit a queued or draft post without republish; it keeps its date.");
        else if ((state === "PUBLISHED" || state === "ERROR") && !republish)
          reject(
            operation,
            "Postiz cannot change a published or failed post in place. Pass republish: true to publish the edited post again now.",
          );
        else if (
          state !== "QUEUE" &&
          state !== "DRAFT" &&
          state !== "PUBLISHED" &&
          state !== "ERROR"
        )
          reject(operation, "Postiz returned a post state this adapter does not edit.");

        const stored = row["settings"];
        let parsed: JsonValue | undefined = stored;

        if (isString(stored))
          try {
            const value: unknown = JSON.parse(stored);

            parsed = isJsonValue(value) ? value : undefined;
          } catch {
            parsed = undefined;
          }

        // Postiz replaces the settings, so an edit must carry the stored ones.
        if (!isJsonObject(parsed))
          reject(operation, "Postiz did not return this post's settings. Edit it in Postiz.");

        const account: ConnectedAccountRef = {
          kind: "connected-account",
          version: 1,
          backend: ref.backend,
          platform: ref.platform,
          accountId: ref.accountId,
        };

        const image: JsonObject[] = [];

        for (const item of edit.media) {
          if (item.thumbnail !== undefined)
            reject(operation, "An edit keeps no custom thumbnail. Edit it in Postiz.");

          image.push({
            ...(await resolveMedia(item, account, context)),
            ...definedFields({ alt: item.altText }),
          });
        }

        const tags = (isJsonArray(row["tags"]) ? row["tags"] : []).flatMap((item) => {
          const tag = isJsonObject(item) ? item["tag"] : undefined;
          const name = isJsonObject(tag) ? tag["name"] : undefined;

          return isString(name) ? [{ value: name, label: name }] : [];
        });

        const interval = row["intervalInDays"];
        // A repeating post is listed once per occurrence; `actualDate` is its stored date.
        const storedDate = optionalString(row["actualDate"]) ?? string(row["publishDate"]);
        const date = republish ? now() : new Date(storedDate).toISOString();

        const rows = await acknowledged(
          operation,
          request("/posts", context, {
            type: republish ? "now" : "update",
            date,
            shortLink: false,
            ...definedFields({
              republish: republish || undefined,
              inter: isFiniteNumber(interval) && interval >= 1 ? interval : undefined,
            }),
            tags,
            posts: [
              {
                integration: { id: ref.accountId },
                value: [{ id: string(row["id"]), content: edit.text, image }],
                settings: isJsonObject(parsed) ? parsed : {},
              },
            ],
          }),
          (reply) => (isJsonArray(reply) ? reply.map(object) : []),
        );

        if (rows.length !== 1 || rows[0]?.["postId"] !== row["id"])
          throw new SocialError({
            code: "ambiguous_outcome",
            operation,
            message: "Postiz did not confirm the edit. Read the post before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        const id = encodeId(string(row["id"]), date);

        try {
          const { row: current } = await record(id, account, context, operation);

          // Postiz gives an edited post a fresh group, so an owned identifier carries the new one.
          return outcome(current, owned ? ownedId(current, date) : id, account, 0);
        } catch {
          return {
            state: "accepted",
            targetIndex: 0,
            account,
            observedAt: now(),
            delivery: {
              kind: "delivery",
              version: 1,
              backend: ref.backend,
              platform: ref.platform,
              accountId: ref.accountId,
              deliveryId: id,
            },
          };
        }
      },

      /**
       * `GET /posts`: every top-level post in the workspace published or due in the range,
       * optionally only on one customer's channels (`customer`). Check the tenant's grants
       * before you show these, because the list is not scoped to one account.
       */
      async listPosts(
        input: PostizListPostsInput,
        context: AdapterOperationContext,
      ): Promise<readonly PostizPost[]> {
        const start = Date.parse(input.startDate);
        const end = Date.parse(input.endDate);

        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
          reject("posts.list", "Pass an ISO 8601 startDate no later than endDate.");

        if (input.customer !== undefined && !recordId.test(input.customer))
          reject("posts.list", "Use a customer ID from listGroups.");

        const result = object(
          await request("/posts", context, undefined, {
            startDate: new Date(start).toISOString(),
            endDate: new Date(end).toISOString(),
            ...definedFields({ customer: input.customer }),
          }),
        );

        return array(result["posts"]).map((value) => {
          const row = object(value);
          const integration = object(row["integration"]);
          const id = string(row["id"]);
          const publishDate = new Date(string(row["publishDate"])).toISOString();
          const interval = row["intervalInDays"];

          const tags = (isJsonArray(row["tags"]) ? row["tags"] : []).flatMap((item) => {
            const tag = isJsonObject(item) ? item["tag"] : undefined;
            const name = isJsonObject(tag) ? tag["name"] : undefined;

            return isString(name) ? [name] : [];
          });

          return {
            recordId: encodeId(id, publishDate),
            id,
            publishDate,
            state: string(row["state"]),
            tags,
            channel: {
              id: string(integration["id"]),
              identifier: string(integration["providerIdentifier"]),
              ...definedFields({ name: optionalString(integration["name"]) }),
            },
            ...definedFields({
              content: optionalString(row["content"]),
              releaseId: optionalString(row["releaseId"]) || undefined,
              url: optionalString(row["releaseURL"]) || undefined,
              error: optionalString(row["error"]) || undefined,
              repeatEveryDays: isFiniteNumber(interval) && interval >= 1 ? interval : undefined,
              group: optionalString(row["group"]),
            }),
          };
        });
      },

      /**
       * `GET /posts/:id/missing`: recent platform content to match a published post whose
       * platform ID Postiz stored as `missing`, as TikTok can return.
       */
      async listMissingContent(
        ref: PostizPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly PostizMissingContent[]> {
        const row = await missingRelease(ref, context, "posts.resolve");

        return array(
          await request(`/posts/${encodeURIComponent(string(row["id"]))}/missing`, context),
        ).map((value) => {
          const item = object(value);

          return {
            id: string(item["id"]),
            ...definedFields({ url: optionalString(item["url"]) }),
          };
        });
      },

      /** `PUT /posts/:id/release-id`: connect a `missing` post to its platform content ID. */
      async setReleaseId(
        ref: PostizPostRef,
        releaseId: string,
        context: AdapterOperationContext,
      ): Promise<void> {
        if (!/^[A-Za-z0-9_:.-]{1,128}$/.test(releaseId))
          reject("posts.resolve", "Use a platform content ID from listMissingContent.");

        const row = await missingRelease(ref, context, "posts.resolve");

        return acknowledged(
          "posts.resolve",
          request(
            `/posts/${encodeURIComponent(string(row["id"]))}/release-id`,
            context,
            { releaseId },
            {},
            "PUT",
          ),
          (reply) => {
            const result = object(reply);

            if (result["id"] === row["id"] && result["releaseId"] === releaseId) return;

            throw new SocialError({
              code: "ambiguous_outcome",
              operation: "posts.resolve",
              message: "Postiz did not confirm the release ID. Read the post before retrying.",
              retryDisposition: { kind: "reconcile-first" },
            });
          },
        );
      },

      /**
       * `POST /generate-video`: generate a video with Postiz's AI tools. It uses the workspace's
       * Postiz credits. Returns the generated files, which you can publish by URL.
       */
      async generateVideo(
        input: PostizVideoRequest,
        context: AdapterOperationContext,
      ): Promise<readonly { readonly id: string; readonly path: string }[]> {
        if (input.type !== "image-text-slides" && input.type !== "veo3")
          reject("media.generate", "Choose the image-text-slides or veo3 video type.");

        if (input.output !== "vertical" && input.output !== "horizontal")
          reject("media.generate", "Choose a vertical or horizontal video.");

        const images = input.customParams.images ?? [];

        if (images.length > 3 || (images.length > 0 && input.type !== "veo3"))
          reject("media.generate", "veo3 takes up to three reference images.");

        const sent = request("/generate-video", context, {
          type: input.type,
          output: input.output,
          customParams: {
            ...definedFields({
              voice: input.customParams.voice,
              prompt: input.customParams.prompt,
            }),
            ...definedFields({
              images:
                images.length > 0
                  ? images.map((image) => ({ id: image.id, path: httpsUrl(image.path).href }))
                  : undefined,
            }),
          },
        });

        // The generation used credits; an answer without its files cannot confirm what was made.
        return acknowledged("media.generate", sent, (reply) => {
          const files = array(reply).map(mediaItem);

          if (files.length > 0) return files;

          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "media.generate",
            message: "Postiz returned no generated files. Check the media library before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });
        });
      },

      /** `POST /video/function`: helpers for video generation, such as `loadVoices`. */
      async videoFunction(
        input: {
          readonly functionName: string;
          readonly identifier: PostizVideoRequest["type"];
          readonly params?: JsonObject;
        },
        context: AdapterOperationContext,
      ): Promise<JsonValue> {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.functionName))
          reject("media.generate", "Use a Postiz video function name such as loadVoices.");

        if (input.params !== undefined && !isJsonValue(input.params))
          reject("media.generate", "Video function parameters must be JSON.");

        return request("/video/function", context, {
          functionName: input.functionName,
          identifier: input.identifier,
          ...definedFields({ params: input.params }),
        });
      },

      /**
       * `POST /clipping`: cut a long YouTube video into short vertical clips. Clips land in the
       * media library, plus one draft post per clip on each listed channel; nothing publishes.
       * It uses the workspace's clipping minutes. Poll `getClipping` with the returned ID.
       */
      async startClipping(
        input: PostizClippingRequest,
        context: AdapterOperationContext,
      ): Promise<{ readonly id: string }> {
        let host = "";

        try {
          host = httpsUrl(input.url).hostname;
        } catch {
          host = "";
        }

        if (!youtubeHost.test(host)) reject("media.clip", "Postiz clips YouTube videos only.");

        const integrations = input.integrations ?? [];

        if (integrations.length > 20) reject("media.clip", "Pass at most 20 channels.");

        for (const id of integrations) channelId(id, "media.clip");

        if (
          input.clips !== undefined &&
          (!Number.isSafeInteger(input.clips) || input.clips < 1 || input.clips > 10)
        )
          reject("media.clip", "Ask for 1 to 10 clips.");

        if (input.fit !== undefined && input.fit !== "blur" && input.fit !== "crop")
          reject("media.clip", "Choose the blur or crop fit.");

        return acknowledged(
          "media.clip",
          request("/clipping", context, {
            url: httpsUrl(input.url).href,
            ...definedFields({
              integrations: integrations.length > 0 ? [...integrations] : undefined,
              clips: input.clips,
              fit: input.fit,
            }),
          }),
          (reply) => {
            const result = object(reply);

            return { id: string(result["id"]) };
          },
        );
      },

      /** `GET /clipping/:id`: a clipping's status and its clips. */
      async getClipping(id: string, context: AdapterOperationContext): Promise<PostizClipping> {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) reject("media.clip", "Use a Postiz clipping ID.");

        return clipping(await request(`/clipping/${encodeURIComponent(id)}`, context));
      },

      /** `GET /clipping`: the workspace's clippings, newest first, 20 per page from page 1. */
      async listClippings(
        input: { readonly page?: number },
        context: AdapterOperationContext,
      ): Promise<{ readonly pages: number; readonly items: readonly PostizClipping[] }> {
        const result = object(
          await request("/clipping", context, undefined, {
            page: pageNumber(input.page, 1, "media.clip"),
          }),
        );

        return {
          pages: optionalNumber(result["pages"]) ?? 0,
          items: array(result["results"]).map(clipping),
        };
      },
    },
  });

  /** Read a published post whose platform ID Postiz could not resolve. */
  async function missingRelease(
    ref: PostizPostRef,
    context: AdapterOperationContext,
    operation: string,
  ): Promise<JsonObject> {
    const { row } = await record(postRecordId(ref), ref, context, operation);

    if (row["state"] !== "PUBLISHED" || row["releaseId"] !== "missing")
      reject(operation, "Only a published Postiz post with a missing platform ID needs this.");

    return row;
  }

  /** The Postiz file ID behind a stored media reference. */
  async function uploadedId(ref: MediaRef): Promise<string> {
    const stored = await store.get(ref.mediaId);

    if (
      !stored?.providerKey ||
      stored.ref.backend !== ref.backend ||
      stored.ref.accountId !== ref.accountId ||
      stored.ref.platform !== ref.platform
    )
      throw new SocialError({
        code: "media_error",
        operation: "media.status",
        message: "This media reference was not uploaded to Postiz by this adapter's store.",
      });

    return stored.providerKey;
  }

  async function mediaStatus(id: string, context: AdapterOperationContext) {
    const row = object(await request(`/media/${encodeURIComponent(id)}/status`, context));
    const status = row["status"];

    if (status !== "processing" && status !== "ready" && status !== "failed")
      throw new SocialError({
        code: "upstream_failure",
        operation: "media.status",
        message: "Postiz returned a media status this adapter does not map.",
      });

    const path = optionalString(row["path"]);

    return {
      id: string(row["id"]),
      status,
      ...definedFields({
        path: path === undefined ? undefined : httpsUrl(path).href,
        warning: optionalString(row["warning"]),
        error: optionalString(row["error"]),
      }),
    } satisfies PostizMediaStatus;
  }

  /**
   * Postiz deletes a post's whole group. Delete only a post whose identifier still names the
   * group Postiz assigned when this adapter saved it, and that no other nearby post shares.
   * The listing covers only nearby dates.
   */
  async function remove(
    target: {
      readonly row: JsonObject;
      readonly nearby: readonly JsonObject[];
      readonly owned: boolean;
    },
    operation: string,
    context: AdapterOperationContext,
  ): Promise<void> {
    const { row, nearby } = target;
    const group = optionalString(row["group"]);

    if (
      !target.owned ||
      group === undefined ||
      nearby.some((item) => item["group"] === group && item["id"] !== row["id"])
    )
      reject(
        operation,
        "This identifier does not show that Social SDK saved this Postiz post alone in its group, and deleting it could remove other posts. Use the identifier the adapter returned when it published or edited the post, or manage it in Postiz.",
      );

    await acknowledged(
      "posts.lifecycle",
      request(`/posts/${encodeURIComponent(string(row["id"]))}`, context, undefined, {}, "DELETE"),
      (reply) => {
        // Postiz answers with the group's first post, which is this one for an adapter group.
        if (isJsonObject(reply) && reply["id"] === row["id"]) return;

        throw new SocialError({
          code: "ambiguous_outcome",
          operation: "posts.lifecycle",
          message: "Postiz did not confirm the deletion. Reconcile before retrying.",
          retryDisposition: { kind: "reconcile-first" },
        });
      },
    );
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
