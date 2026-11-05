import { normalizeMetrics } from "../core/projections.js";
import { managedRawRequest, rawRequestCapability } from "../core/raw-request.js";
import { createHash, randomBytes } from "node:crypto";
import { defineAdapter } from "../core/adapter.js";
import { SocialError, type SocialErrorCode } from "../core/errors.js";
import { definedFields } from "../core/fields.js";
import type {
  AccountRecord,
  AdapterOperationContext,
  AnalyticsReport,
  AnalyticsReportQuery,
  BackendPostRef,
  CapabilityDeclaration,
  ConnectedAccountRef,
  DeliveryOutcome,
  DeliveryRef,
  JsonObject,
  JsonValue,
  MediaAttachment,
  MetricValue,
  Platform,
  PlatformPostRef,
  PreparationIssue,
  PreparedPublishTarget,
  ScheduleCancellation,
  ScheduledJobRef,
} from "../core/types.js";
import { remainingBudget } from "../transport/budget.js";
import { createHttp, HttpError, type HttpOptions } from "../transport/http.js";
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
  optionalObject,
  optionalString,
  string,
  type JsonField,
} from "../transport/validation.js";
import {
  accountMatches,
  acknowledged,
  capabilityManifest,
  managedConstraints,
  managedOptionIssues,
  managedPreparation,
  mappedPlatform,
  optionsObject,
  publishFormats,
  type ManagedOptions,
  type PublishFormats,
} from "./common.js";

/** Buffer publishes document assets to LinkedIn only. */
const bufferFormats: PublishFormats = (platform) =>
  platform === "linkedin"
    ? ["text", "image", "video", "carousel", "document"]
    : publishFormats(platform);

/**
 * Substack Notes: text, one image or video, or a link card in `metadata.substack`, up to 10,000
 * UTF-16 code units (developers.buffer.com/reference, createPost and Character Limits, 2026-11-04).
 */
const substack = "substack";

const substackMaxLength = 10_000;

/** Buffer needs a document title; the caption wins over the filename. */
const documentTitle = (item: MediaAttachment): string | undefined =>
  [item.caption, item.filename].find((value) => value !== undefined && value.trim() !== "");

/** Buffer metadata keys of the platforms that take a `thread` of replies. */
const threadServices: Partial<Record<Platform, string>> = {
  x: "twitter",
  threads: "threads",
  bluesky: "bluesky",
  mastodon: "mastodon",
};

/** Options this adapter maps itself, on top of the shared managed options, per platform. */
const ownKeys: Partial<Record<Platform, readonly string[]>> = {
  x: ["aiGenerated", "retweet", "thread"],
  threads: ["thread", "topic", "location"],
  bluesky: ["thread"],
  mastodon: ["thread", "spoilerText"],
  instagram: [
    "postType",
    "firstComment",
    "location",
    "shopGridLink",
    "aiGenerated",
    "thumbnailOffset",
    "userTags",
  ],
  facebook: ["postType", "firstComment", "annotations"],
  linkedin: ["firstComment", "annotations"],
  youtube: ["embeddable", "license", "notifySubscribers", "aiGenerated"],
  tiktok: ["title", "thumbnailOffset"],
  pinterest: ["thumbnailOffset"],
  "google-business": ["postType", "callToAction", "event", "offer"],
};

/** Post-level Buffer fields, accepted on every platform. */
const postKeys = [
  "saveToDraft",
  "needsApproval",
  "shareMode",
  "schedulingType",
  "tagIds",
  "ideaId",
  "aiAssisted",
  "draftId",
  "animatedThumbnails",
];

/** Platforms whose Buffer metadata takes a `linkAttachment` link card. */
const linkCardPlatforms: readonly Platform[] = [
  "bluesky",
  "facebook",
  "linkedin",
  "threads",
  substack,
];

/** Video `thumbnailOffset` applies on these platforms only. */
const coverPlatforms: readonly Platform[] = ["instagram", "tiktok", "pinterest"];

const gbpButtons = ["book", "call", "learn_more", "none", "order", "shop", "signup"];

/** What a target's options add to the Buffer `createPost` input. */
interface BufferPlan {
  readonly mode?: "addToQueue" | "shareNext";
  readonly schedulingType: "automatic" | "notification";
  readonly saveToDraft?: boolean;
  readonly needsApproval: boolean;
  readonly tagIds?: readonly string[];
  readonly ideaId?: string;
  readonly aiAssisted?: boolean;
  readonly draftId?: string;
  /** Animated (GIF) preview URLs by image position, sent as `metadata.animatedThumbnail`. */
  readonly animatedThumbnails: ReadonlyMap<number, string>;
  /** Metadata fields per Buffer service key, merged over the shared mapping. */
  readonly metadata: readonly (readonly [string, JsonObject])[];
  /** Thread replies after the root post, which takes the post's text and assets. */
  readonly thread?: readonly string[];
  readonly thumbnailOffset?: number;
  /** User tags by image position. */
  readonly userTags: ReadonlyMap<number, readonly JsonObject[]>;
}

function withoutKeys(config: JsonObject, keys: readonly string[]): JsonObject {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !keys.includes(key)));
}

function isPublicHttps(value: JsonField): value is string {
  if (!isString(value)) return false;

  try {
    httpsUrl(value);

    return true;
  } catch {
    return false;
  }
}

function isDateTime(value: JsonField): value is string {
  return isString(value) && Number.isFinite(Date.parse(value)) && /T/.test(value);
}

function isWhole(value: JsonField): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

/** The `content.link` this target maps to a Buffer link card. */
function cardLink(target: PreparedPublishTarget) {
  return linkCardPlatforms.includes(target.account.platform) ? target.content.link : undefined;
}

/** Parse the Buffer-specific options of one target into issues and the input additions. */
function bufferPlan(target: PreparedPublishTarget, config: JsonObject) {
  const issues: PreparationIssue[] = [];
  const platform = target.account.platform;
  const media = target.content.media ?? [];
  const videos = media.filter((item) => item.kind === "video");
  const fields: Record<string, JsonValue> = {};
  const entries: [string, JsonObject][] = [];

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

  const objectOption = (key: string, code: string, allowed: readonly string[]) => {
    const value = config[key];

    if (value === undefined) return undefined;

    if (isJsonObject(value) && Object.keys(value).every((field) => allowed.includes(field)))
      return value;

    fail(code, `${key} takes only ${allowed.join(", ")}.`);

    return undefined;
  };

  const saveToDraft = flag("saveToDraft");
  const needsApproval = flag("needsApproval") === true;

  if (needsApproval && saveToDraft === false)
    fail("buffer.approval", "A post submitted for approval is always a draft.");

  const shareMode = config["shareMode"];

  if (shareMode !== undefined && shareMode !== "addToQueue" && shareMode !== "shareNext")
    fail("buffer.share_mode", "Select addToQueue or shareNext.");
  else if (shareMode !== undefined && target.schedule?.at !== undefined)
    fail("buffer.share_mode", "Use either a queue slot or schedule.at, not both.");

  const schedulingType = config["schedulingType"];

  if (
    schedulingType !== undefined &&
    schedulingType !== "automatic" &&
    schedulingType !== "notification"
  )
    fail("buffer.scheduling_type", "Select automatic or notification publishing.");

  const tags = config["tagIds"];

  const tagIds = isJsonArray(tags)
    ? tags.filter((tag): tag is string => isString(tag) && /^[^\s@]{1,256}$/.test(tag))
    : undefined;

  if (tags !== undefined && (tagIds === undefined || tagIds.length !== array(tags).length))
    fail("buffer.tags", "tagIds must be a list of Buffer tag IDs.");

  const ideaId = text("ideaId", "buffer.idea");

  if (ideaId !== undefined && /[\s@]/.test(ideaId)) fail("buffer.idea", "Use a Buffer idea ID.");

  const aiAssisted = flag("aiAssisted");
  const draftId = text("draftId", "buffer.draft");

  if (draftId !== undefined && /[\s@]/.test(draftId))
    fail("buffer.draft", "Use a Buffer draft ID.");

  const animatedThumbnails = new Map<number, string>();
  const animated = config["animatedThumbnails"];

  if (animated !== undefined) {
    const rows = isJsonArray(animated) ? animated : [];

    for (const row of rows) {
      const entry = isJsonObject(row) ? row : {};
      const index = entry["imageIndex"] ?? 0;
      const url = entry["url"];

      if (
        !isWhole(index) ||
        media[index]?.kind !== "image" ||
        !isPublicHttps(url) ||
        animatedThumbnails.has(index) ||
        Object.keys(entry).some((key) => key !== "imageIndex" && key !== "url")
      )
        fail(
          "buffer.animated_thumbnail",
          "Each animated thumbnail needs an image's imageIndex and a public HTTPS url, once per image.",
        );
      else animatedThumbnails.set(index, url);
    }

    if (rows.length === 0)
      fail("buffer.animated_thumbnail", "animatedThumbnails must be a non-empty list.");
  }

  let thread: string[] | undefined;
  const parts = config["thread"];

  if (parts !== undefined) {
    const replies = isJsonArray(parts) ? parts : [];

    thread = replies.flatMap((part) => {
      const row = isJsonObject(part) ? part : {};
      const reply = row["text"];

      return isString(reply) && reply.trim() !== "" && Object.keys(row).length === 1 ? [reply] : [];
    });

    if (threadServices[platform] === undefined)
      fail(
        "buffer.thread_unsupported",
        "Buffer threads posts on X, Threads, Bluesky, and Mastodon.",
      );
    else if (replies.length === 0 || thread.length !== replies.length)
      fail("buffer.thread", "thread must be a non-empty list of { text } replies.");
  }

  let thumbnailOffset: number | undefined;
  const offset = config["thumbnailOffset"];

  if (offset !== undefined) {
    if (!isWhole(offset))
      fail("buffer.cover_frame", "thumbnailOffset is a whole number of milliseconds.");
    else if (!coverPlatforms.includes(platform) || videos.length !== 1)
      fail(
        "buffer.cover_frame",
        "thumbnailOffset needs exactly one video on Instagram, TikTok, or Pinterest.",
      );
    else thumbnailOffset = offset;
  }

  const userTags = new Map<number, JsonObject[]>();
  const tagList = config["userTags"];

  if (tagList !== undefined) {
    const rows = isJsonArray(tagList) ? tagList : [];

    for (const row of rows) {
      const tag = isJsonObject(row) ? row : {};
      const { x, y } = tag;
      // The shared option names `username` and `mediaIndex`; Buffer's own are `handle` and
      // `imageIndex`, accepted as documented earlier. A tag sets one of each pair at most.
      const name = tag["username"];
      const handle = isString(name) ? name.replace(/^@/, "") : tag["handle"];
      const index = tag["mediaIndex"] ?? tag["imageIndex"] ?? 0;
      const image = isWhole(index) ? media[index] : undefined;

      const position = (value: JsonField): value is number =>
        isFiniteNumber(value) && value >= 0 && value <= 1;

      const keys = ["username", "handle", "x", "y", "mediaIndex", "imageIndex"];

      if (
        !isString(handle) ||
        !/^[A-Za-z0-9._]{1,30}$/.test(handle) ||
        (name !== undefined && tag["handle"] !== undefined) ||
        (tag["mediaIndex"] !== undefined && tag["imageIndex"] !== undefined) ||
        !position(x) ||
        !position(y) ||
        image?.kind !== "image" ||
        Object.keys(tag).some((key) => !keys.includes(key))
      ) {
        fail(
          "instagram.user_tags",
          "Each user tag needs a username, x and y from 0 to 1, and an image's mediaIndex.",
        );

        continue;
      }

      if (image.altText === undefined)
        fail("instagram.user_tags", "Buffer needs altText on an image that carries user tags.");

      userTags.set(Number(index), [...(userTags.get(Number(index)) ?? []), { handle, x, y }]);
    }

    if (rows.length === 0) fail("instagram.user_tags", "userTags must be a non-empty list.");
  }

  const location = objectOption("location", `${platform}.location`, ["id", "name"]);

  if (
    location !== undefined &&
    ![location["id"], location["name"]].some((value) => isString(value) && value.trim() !== "")
  )
    fail(`${platform}.location`, "A location needs an id or a name.");

  const firstComment = text("firstComment", `${platform}.first_comment`);

  if (firstComment !== undefined) fields["firstComment"] = firstComment;

  const link = cardLink(target);

  if (link !== undefined) {
    if (media.length > 0)
      fail("link.with_media", "A Buffer link card cannot be combined with attachments.");

    fields["linkAttachment"] = {
      url: link.url,
      ...definedFields({ title: link.title, description: link.description }),
    };
  }

  if (platform === "x") {
    const ai = flag("aiGenerated");
    const retweet = objectOption("retweet", "x.retweet", ["id", "comment"]);

    if (retweet !== undefined) {
      const comment = retweet["comment"];

      if (!isString(retweet["id"]) || !/^\d{1,20}$/.test(retweet["id"]))
        fail("x.retweet", "retweet needs the numeric ID of the post to repost or quote.");
      else if (comment !== undefined && !isString(comment))
        fail("x.retweet", "A quote comment is text.");
      else fields["retweet"] = definedFields({ id: retweet["id"], comment });

      if (ai !== undefined) fail("x.retweet", "Buffer labels AI content on original posts only.");
    }

    entries.push(["twitter", { ...definedFields({ isAiGenerated: ai, ...fields }) }]);
  }

  if (platform === "threads") {
    const topic = text("topic", "threads.topic");

    if (topic !== undefined) fields["topic"] = topic;

    if (location !== undefined)
      Object.assign(
        fields,
        definedFields({ locationId: location["id"], locationName: location["name"] }),
      );

    entries.push(["threads", fields]);
  }

  if (platform === "bluesky") entries.push(["bluesky", fields]);

  if (platform === substack) {
    if (media.length > 1)
      fail("substack.media_count", "Buffer posts a Substack Note with one image or one video.");

    entries.push([substack, fields]);
  }

  if (platform === "mastodon") {
    const spoiler = text("spoilerText", "mastodon.spoiler_text");

    entries.push(["mastodon", { ...definedFields({ spoilerText: spoiler }) }]);
  }

  const postType = config["postType"];

  if (platform === "instagram") {
    if (
      postType !== undefined &&
      postType !== "post" &&
      postType !== "story" &&
      postType !== "reel"
    )
      fail("instagram.post_type", "Select post, story, or reel.");
    else if (postType === "reel" && (media.length !== 1 || videos.length !== 1))
      fail("instagram.post_type", "An Instagram reel is a single video.");
    else if (postType !== undefined) fields["type"] = postType;

    const shopGridLink = config["shopGridLink"];

    if (shopGridLink !== undefined && !isPublicHttps(shopGridLink))
      fail("instagram.shop_grid_link", "shopGridLink must be a public HTTPS URL.");
    else if (shopGridLink !== undefined) fields["link"] = shopGridLink;

    if (location !== undefined)
      fields["geolocation"] = definedFields({ id: location["id"], text: location["name"] });

    const ai = flag("aiGenerated");

    if (ai !== undefined) fields["isAiGenerated"] = ai;

    entries.push(["instagram", fields]);
  }

  if (platform === "facebook") {
    if (
      postType !== undefined &&
      postType !== "post" &&
      postType !== "story" &&
      postType !== "reel"
    )
      fail("facebook.post_type", "Select post, story, or reel.");
    else if (postType === "reel" && (media.length !== 1 || videos.length !== 1))
      fail("facebook.post_type", "A Facebook reel is a single video.");

    const annotations = config["annotations"];

    if (annotations !== undefined) {
      const valid =
        isJsonArray(annotations) &&
        annotations.length > 0 &&
        annotations.every((entry) => {
          const row = isJsonObject(entry) ? entry : {};
          const indices = row["indices"];

          return (
            Object.keys(row).length === 4 &&
            ["content", "text", "url"].every((key) => isString(row[key])) &&
            isPublicHttps(row["url"]) &&
            isJsonArray(indices) &&
            indices.length === 2 &&
            indices.every(isWhole)
          );
        });

      if (!valid)
        fail(
          "facebook.annotations",
          "Each annotation needs content, text, an HTTPS url, and [start, end] indices.",
        );
      else fields["annotations"] = annotations;
    }

    // Buffer requires the Facebook post type whenever Facebook metadata is sent.
    if (Object.keys(fields).length > 0 || postType !== undefined)
      entries.push([
        "facebook",
        { ...fields, type: postType === "story" || postType === "reel" ? postType : "post" },
      ]);
  }

  if (platform === "linkedin") {
    const annotations = config["annotations"];

    if (annotations !== undefined) {
      const valid =
        isJsonArray(annotations) &&
        annotations.length > 0 &&
        annotations.every((entry) => {
          const row = isJsonObject(entry) ? entry : {};

          return (
            Object.keys(row).length === 7 &&
            ["id", "entity", "link", "localizedName", "vanityName"].every((key) =>
              isString(row[key]),
            ) &&
            isPublicHttps(row["link"]) &&
            isWhole(row["start"]) &&
            isWhole(row["length"])
          );
        });

      if (!valid)
        fail(
          "linkedin.annotations",
          "Each annotation needs id, entity, link, localizedName, vanityName, start, and length.",
        );
      else fields["annotations"] = annotations;
    }

    entries.push(["linkedin", fields]);
  }

  if (platform === "youtube") {
    const embeddable = flag("embeddable");
    const notifySubscribers = flag("notifySubscribers");
    const ai = flag("aiGenerated");
    const license = config["license"];

    if (license !== undefined && license !== "youtube" && license !== "creativeCommon")
      fail("youtube.license", "Select the youtube or creativeCommon license.");

    entries.push([
      "youtube",
      definedFields({
        embeddable,
        notifySubscribers,
        isAiGenerated: ai,
        license: license === "youtube" || license === "creativeCommon" ? license : undefined,
      }),
    ]);
  }

  if (platform === "tiktok") {
    const ai = flag("aiGenerated");
    const value = config["title"];
    let title: string | undefined;

    if (value !== undefined && (!isString(value) || value.trim() === "" || value.length > 90))
      fail("tiktok.title", "A TikTok photo title has 1 to 90 characters.");
    else if (value !== undefined && (media.length === 0 || videos.length > 0))
      fail("tiktok.title", "Buffer applies a TikTok title to photo posts only.");
    else if (isString(value)) title = value;

    entries.push(["tiktok", { ...definedFields({ isAiGenerated: ai, title }) }]);
  }

  if (platform === "google-business") {
    const type = postType ?? "whats_new";
    const action = objectOption("callToAction", "google_business.cta", ["type", "url"]);
    const button = action?.["type"];
    const url = action?.["url"];

    if (type !== "whats_new" && type !== "event" && type !== "offer")
      fail("google_business.post_type", "Select whats_new, event, or offer.");

    if (action !== undefined && !(isString(button) && gbpButtons.includes(button)))
      fail("google_business.cta", `Select a call to action: ${gbpButtons.join(", ")}.`);
    else if (action !== undefined && button !== "none" && button !== "call" && !isPublicHttps(url))
      fail("google_business.cta", "This call to action needs a public HTTPS url.");

    const cta = definedFields({ button, link: isPublicHttps(url) ? url : undefined });

    const event = objectOption("event", "google_business.event", [
      "title",
      "startDate",
      "endDate",
      "isFullDayEvent",
    ]);

    const offer = objectOption("offer", "google_business.offer", [
      "title",
      "startDate",
      "endDate",
      "code",
      "terms",
      "link",
    ]);

    const dated = (row: JsonObject) =>
      isString(row["title"]) &&
      row["title"].trim() !== "" &&
      isDateTime(row["startDate"]) &&
      isDateTime(row["endDate"]) &&
      Date.parse(row["startDate"]) <= Date.parse(row["endDate"]);

    if (
      type === "event" &&
      (event === undefined || !dated(event) || !isBoolean(event["isFullDayEvent"]))
    )
      fail(
        "google_business.event",
        "An event needs a title, ISO startDate and endDate, and isFullDayEvent.",
      );
    else if (type !== "event" && event !== undefined)
      fail("google_business.event", "Event details need postType event.");

    if (
      type === "offer" &&
      (offer === undefined ||
        !dated(offer) ||
        [offer["code"], offer["terms"]].some((value) => value !== undefined && !isString(value)) ||
        (offer["link"] !== undefined && !isPublicHttps(offer["link"])))
    )
      fail(
        "google_business.offer",
        "An offer needs a title, ISO startDate and endDate; code and terms are text and link is HTTPS.",
      );
    else if (type !== "offer" && offer !== undefined)
      fail("google_business.offer", "Offer details need postType offer.");

    const details =
      type === "whats_new"
        ? { detailsWhatsNew: cta }
        : type === "event" && event !== undefined
          ? { detailsEvent: { ...event, ...cta } }
          : type === "offer" && offer !== undefined
            ? { detailsOffer: offer }
            : {};

    if (postType !== undefined || action !== undefined)
      entries.push(["google", { type, ...details }]);
  }

  const plan: BufferPlan = {
    schedulingType: schedulingType === "notification" ? "notification" : "automatic",
    needsApproval,
    metadata: entries.filter(([, value]) => Object.keys(value).length > 0),
    userTags,
    animatedThumbnails,
    ...definedFields({
      mode: shareMode === "addToQueue" || shareMode === "shareNext" ? shareMode : undefined,
      saveToDraft,
      tagIds,
      ideaId,
      aiAssisted,
      draftId,
      thread,
      thumbnailOffset,
    }),
  };

  return { issues, plan };
}

export interface BufferOptions extends ManagedOptions {
  /** Limit channel and post queries to one Buffer organization. Omit to read every organization on the key. */
  readonly organizationId?: string;
}

/** Every OAuth scope Buffer documents. This adapter itself needs only `bufferScopes`. */
export const bufferScopeNames = [
  "posts:read",
  "posts:write",
  "ideas:read",
  "ideas:write",
  "account:read",
  "account:write",
  "snippets:read",
  "snippets:write",
  "notes:read",
  "notes:write",
  "offline_access",
] as const;

export type BufferScope = (typeof bufferScopeNames)[number];

export interface BufferAuthorizationUrlOptions {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  /** S256 challenge from `createBufferPkce()`. */
  readonly codeChallenge: string;
  /** Defaults to `bufferScopes`. Add `ideas:write` for `native.createIdea`. */
  readonly scopes?: readonly BufferScope[];
}

/** A Buffer post this adapter created or read, addressed by the reference it returned. */
export type BufferPostRef = DeliveryRef | ScheduledJobRef | BackendPostRef;

export interface BufferPostingLimit {
  readonly channelId: string;
  readonly isAtLimit: boolean;
  /** The network's daily limit; absent when unlimited. */
  readonly limit?: number;
  readonly scheduled: number;
  readonly sent: number;
}

export interface BufferInstagramAudio {
  readonly id: string;
  readonly title: string;
  readonly type: "music" | "originalSound";
  readonly durationMs: number;
  readonly displayArtist?: string;
  readonly creatorUsername?: string;
}

export interface BufferPostEdit {
  readonly text?: string;
  /** A future time; the post moves to a custom schedule at it. */
  readonly at?: string;
  readonly saveToDraft?: boolean;
  readonly tagIds?: readonly string[];
  /**
   * `request` submits your own draft for approval; `revert` withdraws an approval request back to
   * a draft. Only on channels whose posting policy requires approval.
   */
  readonly approvalChange?: "request" | "revert";
  /** Mark the post as edited with the help of AI. */
  readonly aiAssisted?: boolean;
  /** The Buffer draft this post was generated from. */
  readonly draftId?: string;
}

/** The `BufferPostEdit` fields `editPost` sends; any other key is rejected before the request. */
const bufferPostEditFields: ReadonlySet<string> = new Set(
  Object.keys({
    text: true,
    at: true,
    saveToDraft: true,
    tagIds: true,
    approvalChange: true,
    aiAssisted: true,
    draftId: true,
  } satisfies Record<keyof BufferPostEdit, true>),
);

/** A file or link attached to a Buffer idea. */
export interface BufferIdeaMedia {
  /** Public HTTPS URL. */
  readonly url: string;
  /** Buffer's public API does not accept `video` on ideas. */
  readonly type: "image" | "gif" | "link" | "document";
  readonly alt?: string;
  readonly thumbnailUrl?: string;
  /** Size in bytes. */
  readonly size?: number;
  /** Where the media came from, such as `{ name: "Unsplash", author, authorUrl }`. */
  readonly source?: {
    readonly name: string;
    readonly id?: string;
    readonly trigger?: string;
    readonly author?: string;
    readonly authorUrl?: string;
  };
}

export interface BufferIdeaInput {
  readonly organizationId?: string;
  readonly title?: string;
  readonly text?: string;
  /** Target date, often the planned publish date. */
  readonly date?: string;
  readonly media?: readonly BufferIdeaMedia[];
  /** Organization tags, each with its `id`, `name`, and `color`. */
  readonly tags?: readonly { readonly id: string; readonly name: string; readonly color: string }[];
  /** Buffer services the idea targets, such as `instagram` or `twitter`. */
  readonly services?: readonly string[];
  /** Whether AI tools helped write the idea. */
  readonly aiAssisted?: boolean;
  /** The post template the idea was created from. */
  readonly templateId?: string;
  /** Call-to-action identifier Buffer records for analytics. */
  readonly cta?: string;
  /** Idea group (board column) to place the idea in; omit for the unassigned group. */
  readonly groupId?: string;
  /** Place the idea after this idea in its group; omit for the top. */
  readonly placeAfterId?: string;
}

export interface BufferIdeaGroup {
  readonly id: string;
  readonly name: string;
  /** Locked when the organization holds more groups than its plan allows. */
  readonly isLocked: boolean;
}

export interface BufferIdea {
  readonly id: string;
  readonly groupId?: string;
  readonly position?: number;
  readonly title?: string;
  readonly text?: string;
  readonly date?: string;
  readonly aiAssisted: boolean;
  readonly services: readonly string[];
  readonly tags: readonly { readonly id: string; readonly name: string; readonly color: string }[];
  readonly media: readonly {
    readonly url: string;
    readonly type: string;
    readonly alt?: string;
    readonly thumbnailUrl?: string;
  }[];
  /** ISO 8601, from Buffer's Unix timestamps. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BufferIdeasQuery {
  readonly organizationId?: string;
  /** Only ideas in these groups. Not with `membership`. */
  readonly groupIds?: readonly string[];
  /** Only ideas in some group, or only unassigned ones. Not with `groupIds`. */
  readonly membership?: "grouped" | "ungrouped";
  /** Ideas with any of these tag IDs, untagged ideas, or both. */
  readonly tags?: { readonly in?: readonly string[]; readonly isEmpty?: boolean };
  readonly limit?: number;
  readonly cursor?: string;
}

export interface BufferChannel {
  readonly id: string;
  /** The Social SDK platform, when this adapter maps the service. */
  readonly platform?: Platform;
  /** Buffer's service name, such as `twitter` or `substack`. */
  readonly service: string;
  /** The channel's ID on the network. */
  readonly serviceId: string;
  readonly name: string;
  readonly displayName?: string;
  readonly organizationId: string;
  /** `page`, `profile`, `business`, `group`, `account`, or `channel`. */
  readonly type: string;
  /** IANA timezone of the channel's posting schedule. */
  readonly timezone: string;
  /** A locked channel cannot post; Buffer locks channels beyond the plan's limit. */
  readonly isLocked: boolean;
  readonly isDisconnected: boolean;
  readonly isQueuePaused: boolean;
  readonly linkShortening: { readonly isEnabled: boolean };
  readonly postingGoal?: {
    readonly goal: number;
    readonly sentCount: number;
    readonly scheduledCount: number;
    /** `OnTrack`, `AtRisk`, or `Hit`. */
    readonly status: string;
    readonly periodStart: string;
    readonly periodEnd: string;
  };
  /** What your credentials may do on the channel, such as `scheduleUpdates`. */
  readonly allowedActions: readonly string[];
  /** Buffer products that support the channel, such as `publish` or `analyze`. */
  readonly products: readonly string[];
  /** Network scopes Buffer holds for the channel; empty when Buffer does not track them. */
  readonly scopes: readonly string[];
  readonly url?: string;
}

export interface BufferOrganization {
  readonly id: string;
  readonly name: string;
  readonly channelCount: number;
  /** Members, counting the owner. */
  readonly memberCount: number;
  /** Plan limits: channels, members, scheduledPosts, ideas, tags, postTemplates, and more. */
  readonly limits: Readonly<Record<string, number>>;
}

export interface BufferAccount {
  readonly id: string;
  readonly name?: string;
  /** Account timezone, the default for new channels and posting plans. */
  readonly timezone?: string;
  readonly preferences?: {
    readonly timeFormat?: string;
    readonly startOfWeek?: string;
    /** `Queue`, `Prioritize`, `FixedTime`, or `Now`: the composer's default. */
    readonly defaultScheduleOption: string;
  };
}

export interface BufferContentRule {
  /** The rule type: `CountRule`, `LengthRule`, `ExclusiveRule`, `RequiresRule`, `FileSizeRule`, `DurationRule`, or `FormatRule`. */
  readonly kind: string;
  /** The content property it constrains, such as `text`, `image`, or `video`. */
  readonly property: string;
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;
  readonly maxMegabytes?: number;
  readonly maxDurationSeconds?: number;
  readonly conflictsWith?: readonly string[];
  readonly requires?: readonly string[];
  readonly allowedFormats?: readonly string[];
}

export interface BufferContentConfiguration {
  /** `post`, `story`, `reel`, or `comment`, grouped when they share rules. */
  readonly contentTypes: readonly string[];
  readonly supportedProperties: readonly string[];
  readonly rules: readonly BufferContentRule[];
}

export interface BufferConfiguration {
  readonly channels: readonly {
    readonly channelId: string;
    readonly service: string;
    readonly channelType: string;
    /** Per feature (`posting`, `comment`, `insights`, ...): `ok`, `needsRefresh`, `needsUpgrade`, `notEnoughData`, or `notEnoughRights`. */
    readonly authorizationStatus: readonly {
      readonly feature: string;
      readonly status: string;
      readonly reason?: string;
    }[];
    readonly content: readonly BufferContentConfiguration[];
  }[];
  readonly services: readonly {
    readonly service: string;
    readonly channelType: string;
    readonly content: readonly BufferContentConfiguration[];
  }[];
}

export interface BufferTeamMember {
  readonly id: string;
  readonly name?: string;
  /** `urn:buffer:account:<id>`, for a mention annotation's `serviceEntityId`. */
  readonly urn: string;
  readonly isLocked: boolean;
}

/** Buffer `Service` values an idea can target (developers.buffer.com/reference, 2026-11-04). */
const ideaServices = [
  "bluesky",
  "facebook",
  "googlebusiness",
  "instagram",
  "linkedin",
  "mastodon",
  "pinterest",
  "startPage",
  "substack",
  "threads",
  "tiktok",
  "twitter",
  "whatsapp",
  "youtube",
];

export interface BufferPostsQuery {
  /** Channels to read; all must belong to one organization. */
  readonly accounts: readonly ConnectedAccountRef[];
  readonly status?: readonly (
    | "draft"
    | "error"
    | "needs_approval"
    | "scheduled"
    | "sending"
    | "sent"
  )[];
  /** Scheduled posting time range, ISO 8601 bounds. */
  readonly dueAt?: { readonly start?: string; readonly end?: string };
  /** `present` keeps posts with a scheduled time, `absent` those without; not with `dueAt` absent. */
  readonly dueAtPresence?: "present" | "absent";
  /** Creation time range, ISO 8601 bounds. */
  readonly createdAt?: { readonly start?: string; readonly end?: string };
  /** Post formats such as `reel`, `story`, `short`; `post` matches every other format. */
  readonly postTypes?: readonly string[];
  /** Posts with any of these tag IDs, untagged posts, or both. */
  readonly tags?: { readonly in?: readonly string[]; readonly isEmpty?: boolean };
  readonly sort?: readonly {
    readonly field: "dueAt" | "createdAt";
    readonly direction: "asc" | "desc";
  }[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface BufferCodeExchangeOptions extends HttpOptions {
  readonly clientId: string;
  /** Confidential clients only. Public clients authenticate with PKCE alone. */
  readonly clientSecret?: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly signal?: AbortSignal;
}

export interface BufferRefreshOptions extends HttpOptions {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly refreshToken: string;
  readonly signal?: AbortSignal;
}

export interface BufferAccessToken {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: string;
  readonly expiresIn?: number;
  readonly scope?: string;
}

export interface BufferPkce {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

export const bufferScopes = [
  "posts:read",
  "posts:write",
  "account:read",
  "offline_access",
] as const;

const apiOrigin = "https://api.buffer.com";

const authOrigin = "https://auth.buffer.com";

const nativePlatforms = new Map<string, Platform>([
  ["twitter", "x"],
  ["threads", "threads"],
  ["bluesky", "bluesky"],
  ["youtube", "youtube"],
  ["tiktok", "tiktok"],
  ["instagram", "instagram"],
  ["linkedin", "linkedin"],
  ["facebook", "facebook"],
  ["pinterest", "pinterest"],
  ["mastodon", "mastodon"],
  ["googlebusiness", "google-business"],
  [substack, substack],
]);

const postSelection = `
  id
  text
  channelId
  channelService
  dueAt
  sentAt
  status
  shareMode
  schedulingType
  externalLink
  createdAt
  ideaId
  via
  notificationStatus
  allowedActions
  error {
    message
    rawError
    supportUrl
  }
  tags {
    id
    name
    color
  }
  assets {
    type
    source
    thumbnail
    mimeType
    ... on ImageAsset {
      image {
        altText
        animatedThumbnail
      }
    }
  }
  author {
    id
    name
  }
  metadata {
    ... on CommonPostMetadata {
      type
    }
  }
`;

const contentSelection = `
  configurationContentTypes
  supportedProperties
  rules {
    __typename
    property
    ... on CountRule {
      min
      max
    }
    ... on LengthRule {
      maxLength
    }
    ... on ExclusiveRule {
      conflictsWith
    }
    ... on RequiresRule {
      requires
    }
    ... on FileSizeRule {
      maxMegabytes
    }
    ... on DurationRule {
      maxDurationSeconds
    }
    ... on FormatRule {
      allowedFormats
    }
  }
`;

/** Read a content configuration entry of Buffer's `configuration` query. */
function contentConfiguration(value: JsonValue): BufferContentConfiguration {
  const row = object(value);
  const names = (field: JsonField) => (isJsonArray(field) ? field.filter(isString) : undefined);

  return {
    contentTypes: names(row["configurationContentTypes"]) ?? [],
    supportedProperties: names(row["supportedProperties"]) ?? [],
    rules: array(row["rules"]).map((item) => {
      const rule = object(item);

      return {
        kind: string(rule["__typename"]),
        property: string(rule["property"]),
        ...definedFields({
          min: optionalNumber(rule["min"]),
          max: optionalNumber(rule["max"]),
          maxLength: optionalNumber(rule["maxLength"]),
          maxMegabytes: optionalNumber(rule["maxMegabytes"]),
          maxDurationSeconds: optionalNumber(rule["maxDurationSeconds"]),
          conflictsWith: names(rule["conflictsWith"]),
          requires: names(rule["requires"]),
          allowedFormats: names(rule["allowedFormats"]),
        }),
      };
    }),
  };
}

const metricsSelection = `
  metrics {
    type
    value
    unit
    name
  }
  metricsUpdatedAt
`;

const reject = (operation: string, message: string): never => {
  throw new SocialError({ code: "invalid_input", operation, message });
};

function postRecordId(ref: BufferPostRef): string {
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

function isBufferId(value: JsonField): value is string {
  return isString(value) && value !== "" && value.length <= 256 && !/[\s@]/.test(value);
}

function bufferId(value: string, operation: string, label: string): string {
  if (!isBufferId(value)) reject(operation, `Use a Buffer ${label} identifier.`);

  return value;
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
      message: "Configure the Buffer redirect URI as an HTTPS URL without credentials.",
    });

  return url;
}

function tokenError(error: HttpError, operation: string): SocialError {
  if (error.status === 401)
    return new SocialError({
      code: "invalid_config",
      operation,
      message: "Buffer rejected the OAuth client.",
      upstreamStatus: 401,
    });

  if (error.status === 400)
    return new SocialError({
      code: "invalid_input",
      operation,
      message:
        "Buffer rejected the authorization grant. It may be expired, used, or issued to another client. Start the authorization again.",
      upstreamStatus: 400,
    });

  if (error.status === 429)
    return new SocialError({
      code: "rate_limited",
      operation,
      message: "Buffer rate limited the token request.",
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
      ? "Buffer may have consumed the grant without returning tokens. Start the authorization again."
      : error.message,
    ...definedFields({ upstreamStatus: error.status }),
  });
}

function readToken(value: JsonValue, operation: string): BufferAccessToken {
  const row = object(value);
  const accessToken = optionalString(row["access_token"]);
  const tokenType = optionalString(row["token_type"]);

  if (!accessToken || !tokenType)
    throw new SocialError({
      code: "upstream_failure",
      operation,
      message: "Buffer did not return an access token. Start the authorization again.",
    });

  return {
    accessToken,
    tokenType,
    ...definedFields({
      refreshToken: optionalString(row["refresh_token"]),
      expiresIn: optionalNumber(row["expires_in"]),
      scope: optionalString(row["scope"]),
    }),
  };
}

async function requestToken(
  body: URLSearchParams,
  options: HttpOptions & { readonly signal?: AbortSignal },
  operation: string,
): Promise<BufferAccessToken> {
  let response: JsonValue;

  try {
    response = await createHttp(options)({
      url: new URL("/token", authOrigin),
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      ...definedFields({ signal: options.signal }),
    });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;

    throw tokenError(error, operation);
  }

  return readToken(response, operation);
}

/** Create a PKCE verifier and S256 challenge for Buffer's authorization-code flow. */
export function createBufferPkce(): BufferPkce {
  const codeVerifier = randomBytes(32).toString("base64url");

  return {
    codeVerifier,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
  };
}

/**
 * Build the Buffer URL that asks a person to approve your OAuth app. Buffer then
 * redirects to your registered URI with `code` and `state`, or with `error`.
 */
export function bufferAuthorizationUrl(options: BufferAuthorizationUrlOptions): string {
  const operation = "buffer.authorizationUrl";

  if (!options.clientId.trim() || !options.state.trim() || !options.codeChallenge.trim())
    throw new SocialError({
      code: "invalid_config",
      operation,
      message: "Pass the Buffer OAuth client ID, state, and PKCE code challenge.",
    });

  const url = new URL("/auth", authOrigin);

  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", originUrl(options.redirectUri, operation).href);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (options.scopes ?? bufferScopes).join(" "));
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "consent");

  return url.href;
}

/**
 * Exchange the authorization code for Buffer tokens. Refresh tokens are returned only
 * when `offline_access` was granted, and each refresh token is single-use.
 */
export async function exchangeBufferCode(
  options: BufferCodeExchangeOptions,
): Promise<BufferAccessToken> {
  const operation = "buffer.exchangeCode";

  if (!options.clientId.trim())
    throw new SocialError({
      code: "invalid_config",
      operation,
      message: "Configure the Buffer OAuth client ID.",
    });

  if (!options.code.trim() || !options.codeVerifier.trim())
    reject(
      operation,
      "Pass the authorization code and the PKCE verifier from the start of the flow.",
    );

  const body = new URLSearchParams({
    client_id: options.clientId,
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: originUrl(options.redirectUri, operation).href,
    code_verifier: options.codeVerifier,
  });

  if (options.clientSecret !== undefined) body.set("client_secret", options.clientSecret);

  return requestToken(body, options, operation);
}

/**
 * Exchange a Buffer refresh token for a new token pair. The refresh token you send is
 * invalidated; store the replacement and discard the old one.
 */
export async function refreshBufferToken(
  options: BufferRefreshOptions,
): Promise<BufferAccessToken> {
  const operation = "buffer.refreshToken";

  if (!options.clientId.trim())
    throw new SocialError({
      code: "invalid_config",
      operation,
      message: "Configure the Buffer OAuth client ID.",
    });

  if (!options.refreshToken.trim()) reject(operation, "Pass the current Buffer refresh token.");

  const body = new URLSearchParams({
    client_id: options.clientId,
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
  });

  if (options.clientSecret !== undefined) body.set("client_secret", options.clientSecret);

  return requestToken(body, options, operation);
}

/** The GraphQL `extensions.code`, kept only when it looks like a machine code, never prose. */
function graphqlCode(error: JsonValue): string | undefined {
  if (!isJsonObject(error)) return undefined;
  const extensions = error["extensions"];
  const code = isJsonObject(extensions) ? optionalString(extensions["code"]) : undefined;

  return code !== undefined && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

// Buffer's error prose is free text that can echo post content or signed media URLs, so
// public errors carry these SDK-authored messages and validated machine codes only.
const graphqlMessages = {
  rate_limited: "Buffer rate limited the request.",
  reconnect_required: "Buffer rejected the credential. Reconnect the account.",
  missing_permission: "Buffer does not allow this credential to make the request.",
  not_found: "Buffer could not find the requested resource.",
  ambiguous_outcome: "Buffer did not confirm the mutation. Reconcile before retrying.",
  upstream_failure: "Buffer returned a GraphQL error.",
} as const satisfies Partial<Record<SocialErrorCode, string>>;

/**
 * A Buffer mutation payload that states an error instead of the changed resource. Returns
 * undefined when the payload states nothing. Only the recognized `__typename` survives.
 */
function payloadRejection(input: {
  readonly result: JsonObject;
  readonly operation: string;
  readonly context: AdapterOperationContext;
  readonly kind: "query" | "mutation";
}): SocialError | undefined {
  const { result, operation, context, kind } = input;

  const typename = result["__typename"];

  // Every MutationError member carries the `__typename` the selection asks for; a payload with a
  // message but no type name is not a documented error answer.
  if (!isString(result["message"]) || !isString(typename) || typename === "") return undefined;

  const base = {
    operation,
    backend: context.backendInstance,
    correlationId: context.correlationId,
  };

  switch (typename) {
    case "UnauthorizedError":
      return new SocialError({
        ...base,
        code: "missing_permission",
        upstreamCode: typename,
        message: "Buffer does not allow this credential to make the change.",
        retryDisposition: { kind: "never" },
      });
    case "NotFoundError":
      return new SocialError({
        ...base,
        code: "not_found",
        upstreamCode: typename,
        message: "Buffer could not find the resource this change addresses.",
        retryDisposition: { kind: "never" },
      });
    case "LimitReachedError":
      return new SocialError({
        ...base,
        code: "billing_required",
        upstreamCode: typename,
        message: "The Buffer organization reached a plan limit for this change.",
        retryDisposition: { kind: "never" },
      });
    case "UnexpectedError":
      return kind === "mutation"
        ? new SocialError({
            ...base,
            code: "ambiguous_outcome",
            upstreamCode: typename,
            message:
              "Buffer reported an unexpected error after the change was sent. Reconcile before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          })
        : new SocialError({
            ...base,
            code: "upstream_failure",
            upstreamCode: typename,
            message: "Buffer reported an unexpected error.",
            retryDisposition: { kind: "never" },
          });
    case "InvalidInputError":
      return new SocialError({
        ...base,
        code: "invalid_input",
        upstreamCode: typename,
        message: "Buffer rejected the request input.",
        retryDisposition: { kind: "never" },
      });
    default:
      // A stated error without a recognized type is still a definite rejection.
      return new SocialError({
        ...base,
        code: "invalid_input",
        message: "Buffer rejected the request.",
        retryDisposition: { kind: "never" },
      });
  }
}

function transportError(
  error: HttpError,
  operation: string,
  context: AdapterOperationContext,
  kind: "query" | "mutation",
): SocialError {
  const ambiguous =
    kind === "mutation" &&
    error.dispatched &&
    (error.kind !== "http" || (error.status !== undefined && error.status >= 500));

  // A dispatched mutation that timed out, was cancelled, or lost its answer may have landed,
  // so uncertainty wins over the transport reason. Only HTTP 5xx counts among statuses.
  const code: SocialErrorCode = ambiguous
    ? "ambiguous_outcome"
    : error.status === 429
      ? "rate_limited"
      : error.kind === "cancelled"
        ? "cancelled"
        : error.kind === "timeout"
          ? "timeout"
          : error.status === 401
            ? "reconnect_required"
            : error.status === 403
              ? "missing_permission"
              : error.status === 404
                ? "not_found"
                : error.kind === "invalid-input"
                  ? "invalid_input"
                  : "upstream_failure";

  return new SocialError({
    code,
    operation,
    backend: context.backendInstance,
    correlationId: context.correlationId,
    message:
      code === "ambiguous_outcome"
        ? "Buffer did not confirm the mutation. Reconcile before retrying."
        : error.message,
    ...definedFields({
      upstreamStatus: error.status,
      retryDisposition:
        code === "ambiguous_outcome"
          ? { kind: "reconcile-first" }
          : error.status === 401
            ? { kind: "after-reconnect" }
            : error.status === 429 && error.retryAfterMs !== undefined
              ? { kind: "after-delay", delayMs: error.retryAfterMs }
              : { kind: "never" },
    }),
  });
}

/** GraphQL error codes that show Buffer refused a request rather than failing while running it. */
const rejectionCodes = new Set([
  "RATE_LIMIT_EXCEEDED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "BAD_USER_INPUT",
  "GRAPHQL_PARSE_FAILED",
  "GRAPHQL_VALIDATION_FAILED",
]);

function graphqlFailure(
  errors: readonly JsonValue[],
  operation: string,
  context: AdapterOperationContext,
  kind: "query" | "mutation",
): SocialError {
  const first = errors[0];
  const upstreamCode = first === undefined ? undefined : graphqlCode(first);

  const definite = (error: JsonValue) => {
    const errorCode = graphqlCode(error);

    return errorCode !== undefined && rejectionCodes.has(errorCode);
  };

  // A mutation that was sent is rejected only when every error carries a code that shows
  // Buffer refused it. An execution error, an unknown code or none leaves it uncertain.
  const code: keyof typeof graphqlMessages =
    kind === "mutation" && (errors.length === 0 || !errors.every(definite))
      ? "ambiguous_outcome"
      : upstreamCode === "RATE_LIMIT_EXCEEDED"
        ? "rate_limited"
        : upstreamCode === "UNAUTHORIZED"
          ? "reconnect_required"
          : upstreamCode === "FORBIDDEN"
            ? "missing_permission"
            : upstreamCode === "NOT_FOUND"
              ? "not_found"
              : "upstream_failure";

  return new SocialError({
    code,
    operation,
    backend: context.backendInstance,
    correlationId: context.correlationId,
    message: graphqlMessages[code],
    ...definedFields({
      upstreamCode,
      retryDisposition:
        code === "ambiguous_outcome"
          ? { kind: "reconcile-first" }
          : code === "reconnect_required"
            ? { kind: "after-reconnect" }
            : { kind: "never" },
    }),
  });
}

/**
 * Buffer managed backend. Buffer is a GraphQL scheduling service: you authenticate with
 * a personal API key or an OAuth access token, list connected channels, and create posts
 * that Buffer later delivers. Media must already be a public HTTPS URL; Buffer has no
 * upload endpoint.
 */
export function buffer(options: BufferOptions) {
  if (!options.apiKey.trim())
    throw new SocialError({
      code: "invalid_config",
      operation: "createAdapter",
      message: "Configure the Buffer API key or OAuth access token.",
    });

  const organizationId =
    options.organizationId === undefined
      ? undefined
      : bufferId(options.organizationId, "createAdapter", "organization");

  const http = createHttp(options);
  const clock = () => options.clock?.() ?? new Date();
  const now = () => clock().toISOString();

  const send = async (
    operation: string,
    query: string,
    variables: JsonObject,
    context: AdapterOperationContext,
    kind: "query" | "mutation",
  ): Promise<JsonValue> => {
    try {
      return await http({
        url: new URL(apiOrigin),
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        timeoutMs: remainingBudget(context),
        method: "POST",
        body: JSON.stringify({ query, variables }),
        ...definedFields({ signal: context.signal }),
        maxAttempts: 1,
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      throw transportError(error, operation, context, kind);
    }
  };

  /** The `data` of a GraphQL answer; stated errors keep their own classification. */
  const payloadData = (
    response: JsonValue,
    operation: string,
    context: AdapterOperationContext,
    kind: "query" | "mutation",
  ): JsonObject => {
    const payload = object(response);
    const errors = payload["errors"];
    const data = payload["data"];

    // A mutation field that came back non-null ran, even when a nested field errored:
    // its decoder reads the result, so a created post keeps its delivery reference.
    const ran =
      kind === "mutation" &&
      isJsonObject(data) &&
      Object.values(data).some((value) => value !== null);

    if (errors !== undefined && !ran) {
      const list = array(errors);

      if (list.length > 0) throw graphqlFailure(list, operation, context, kind);
    }

    if (data === null || data === undefined) {
      if (kind === "mutation")
        throw new SocialError({
          code: "ambiguous_outcome",
          operation,
          backend: context.backendInstance,
          correlationId: context.correlationId,
          message: "Buffer did not confirm the mutation. Reconcile before retrying.",
          retryDisposition: { kind: "reconcile-first" },
        });

      throw new SocialError({
        code: "upstream_failure",
        operation,
        backend: context.backendInstance,
        correlationId: context.correlationId,
        message: "Buffer returned no GraphQL data.",
        retryDisposition: { kind: "never" },
      });
    }

    return object(data);
  };

  const graphql = async (
    operation: string,
    query: string,
    variables: JsonObject,
    context: AdapterOperationContext,
    kind: "query" | "mutation",
  ): Promise<JsonObject> =>
    payloadData(await send(operation, query, variables, context, kind), operation, context, kind);

  /**
   * Run a mutation and decode its answer inside the uncertain-write boundary: once Buffer
   * answered 2xx, a payload `decode` cannot read leaves the change unconfirmed.
   */
  const mutate = <T>(
    operation: string,
    query: string,
    variables: JsonObject,
    context: AdapterOperationContext,
    decode: (data: JsonObject) => T,
  ): Promise<T> =>
    acknowledged(operation, send(operation, query, variables, context, "mutation"), (response) =>
      decode(payloadData(response, operation, context, "mutation")),
    );

  const organizations = async (context: AdapterOperationContext): Promise<string[]> => {
    if (organizationId) return [organizationId];

    const data = await graphql(
      "accounts.read",
      `
        query AccountOrganizations {
          account {
            organizations {
              id
            }
          }
        }
      `,
      {},
      context,
      "query",
    );

    return array(object(data["account"])["organizations"]).map((value) =>
      bufferId(string(object(value)["id"]), "accounts.read", "organization"),
    );
  };

  const account = (value: JsonValue, backend: string): AccountRecord | undefined => {
    const row = object(value);
    const slug = mappedPlatform(nativePlatforms, string(row["service"]), options);

    if (!slug) return undefined;
    const handle = optionalString(row["name"]);

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
      status: "connected",
    };
  };

  const channels = async (
    context: AdapterOperationContext,
  ): Promise<readonly { account: AccountRecord; organizationId: string }[]> => {
    const orgs = await organizations(context);
    const items: { account: AccountRecord; organizationId: string }[] = [];

    for (const org of orgs) {
      const data = await graphql(
        "accounts.read",
        `
          query Channels($input: ChannelsInput!) {
            channels(input: $input) {
              id
              name
              displayName
              service
              organizationId
            }
          }
        `,
        { input: { organizationId: org } },
        context,
        "query",
      );

      for (const value of array(data["channels"])) {
        const parsed = account(value, context.backendInstance);

        if (parsed)
          items.push({
            account: parsed,
            organizationId: optionalString(object(value)["organizationId"]) ?? org,
          });
      }
    }

    return items;
  };

  const ownedChannel = async (
    ref: Pick<ConnectedAccountRef, "backend" | "platform" | "accountId">,
    context: AdapterOperationContext,
    operation: string,
  ): Promise<{ account: AccountRecord; organizationId: string }> => {
    accountMatches(ref, context);

    const found = (await channels(context)).find(
      (item) =>
        item.account.ref.accountId === ref.accountId && item.account.ref.platform === ref.platform,
    );

    if (!found)
      throw new SocialError({
        code: "not_found",
        operation,
        message: "Buffer has no connected channel matching this reference.",
      });

    return found;
  };

  const postRow = (
    value: JsonField,
    operation: string,
    context: AdapterOperationContext,
  ): JsonObject => {
    if (value === null || value === undefined)
      throw new SocialError({
        code: "not_found",
        operation,
        message: "Buffer has no post with this identifier.",
      });

    const row = object(value);

    if (optionalString(row["id"])) return row;

    throw (
      payloadRejection({ result: row, operation, context, kind: "query" }) ??
      new SocialError({
        code: "upstream_failure",
        operation,
        message: "Buffer returned an unreadable post payload.",
      })
    );
  };

  const readPost = async (
    id: string,
    ref: Pick<ConnectedAccountRef, "backend" | "platform" | "accountId">,
    context: AdapterOperationContext,
    operation: string,
    includeMetrics = false,
  ): Promise<JsonObject> => {
    await ownedChannel(ref, context, operation);

    const postId = bufferId(id, operation, "post");

    const data = await graphql(
      operation,
      `query Post($input: PostInput!) {
        post(input: $input) {
          ${postSelection}
          ${includeMetrics ? metricsSelection : ""}
        }
      }`,
      { input: { id: postId } },
      context,
      "query",
    );

    const row = postRow(data["post"], operation, context);

    if (row["channelId"] !== ref.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation,
        message: "The Buffer post does not belong to the authorized channel.",
      });

    if (mappedPlatform(nativePlatforms, string(row["channelService"]), options) !== ref.platform)
      throw new SocialError({
        code: "unauthorized",
        operation,
        message: "The Buffer post does not belong to the authorized platform.",
      });

    return row;
  };

  const publicPost = (row: JsonObject): JsonObject => {
    const error = isJsonObject(row["error"]) ? row["error"] : undefined;
    const author = isJsonObject(row["author"]) ? row["author"] : undefined;
    const metadata = isJsonObject(row["metadata"]) ? row["metadata"] : undefined;

    const list = (value: JsonField) =>
      isJsonArray(value) ? value.filter(isJsonObject) : undefined;

    return {
      id: string(row["id"]),
      ...definedFields({
        text: optionalString(row["text"]),
        channelId: optionalString(row["channelId"]),
        status: optionalString(row["status"]),
        dueAt: optionalString(row["dueAt"]),
        sentAt: optionalString(row["sentAt"]),
        createdAt: optionalString(row["createdAt"]),
        shareMode: optionalString(row["shareMode"]),
        url: optionalString(row["externalLink"]),
        ideaId: optionalString(row["ideaId"]),
        via: optionalString(row["via"]),
        notificationStatus: optionalString(row["notificationStatus"]),
        postType: optionalString(metadata?.["type"]),
        allowedActions: isJsonArray(row["allowedActions"])
          ? row["allowedActions"].filter(isString)
          : undefined,
        error: error && {
          message: string(error["message"]),
          ...definedFields({
            supportUrl: optionalString(error["supportUrl"]),
            rawError: optionalString(error["rawError"]),
          }),
        },
        tags: list(row["tags"])?.map((tag) => ({
          id: string(tag["id"]),
          name: string(tag["name"]),
          ...definedFields({ color: optionalString(tag["color"]) }),
        })),
        assets: list(row["assets"])?.map((asset) => {
          const image = isJsonObject(asset["image"]) ? asset["image"] : undefined;

          return {
            type: string(asset["type"]),
            url: string(asset["source"]),
            ...definedFields({
              thumbnailUrl: optionalString(asset["thumbnail"]),
              mimeType: optionalString(asset["mimeType"]),
              altText: optionalString(image?.["altText"]) || undefined,
              animatedThumbnail: optionalString(image?.["animatedThumbnail"]),
            }),
          };
        }),
        author: author && {
          id: string(author["id"]),
          ...definedFields({ name: optionalString(author["name"]) }),
        },
      }),
    };
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
      case "scheduled":
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
      case "draft":
      case "needs_approval":
        return { ...base, state: "accepted" };
      case "sending":
        return { ...base, state: "processing" };
      case "sent": {
        const url = optionalString(row["externalLink"]);

        // A reminder post is published by a person; Buffer sending the reminder proves nothing.
        if (row["schedulingType"] === "notification")
          return {
            ...base,
            state: "unknown",
            reason: "unmapped-state",
            diagnostic:
              "Buffer sent the publishing reminder. Someone publishes the post by hand; check the network.",
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
            postId: id,
            native: { backendRecordId: id },
          },
          ...definedFields({ url }),
        };
      }

      case "error":
        // Buffer's `error.message`, `supportUrl` and `rawError` are free text that can echo post
        // content or signed media URLs, so the outcome keeps a fixed message. An authorized
        // `posts.get` or `native.listPosts` read returns the post's `error` as data.
        return {
          ...base,
          state: "failed",
          code: "upstream_failure",
          message:
            "Buffer reports that this post failed. Inspect the channel connection and the post in Buffer.",
          retryDisposition: { kind: "never" },
        };

      default:
        return {
          ...base,
          state: "unknown",
          reason: "unmapped-state",
          diagnostic: "Buffer returned a post status this adapter does not map.",
        };
    }
  };

  const metricUnit = (value: JsonField): MetricValue["unit"] | undefined => {
    // Buffer documents only count and percentage metric units.
    if (value === undefined || value === "count") return "count";

    if (value === "percentage") return value;

    return undefined;
  };

  const postMetrics = (row: JsonObject, platform: Platform): readonly MetricValue[] => {
    const values = row["metrics"];

    if (values === null || values === undefined) return [];

    return array(values).flatMap((entry) => {
      const metric = object(entry);
      const name = optionalString(metric["type"]) ?? optionalString(metric["name"]);
      const unit = metricUnit(metric["unit"]);
      const value = optionalNumber(metric["value"]);

      if (!name || unit === undefined || value === undefined || !Number.isFinite(value)) return [];

      return [
        {
          name,
          value,
          unit,
          period: "lifetime" as const,
          freshness: "unknown" as const,
          source: `buffer:${platform}:post`,
          ...definedFields({ fetchedAt: optionalString(row["metricsUpdatedAt"]) }),
        },
      ];
    });
  };

  const deleteOwned = async (
    id: string,
    context: AdapterOperationContext,
    operation: string,
  ): Promise<void> => {
    return mutate(
      operation,
      `
        mutation DeletePost($input: DeletePostInput!) {
          deletePost(input: $input) {
            ... on DeletePostSuccess {
              id
            }
            ... on MutationError {
              __typename
              message
            }
          }
        }
      `,
      { input: { id } },
      context,
      (data) => {
        const result = object(data["deletePost"]);

        if (result["id"] === id) return;

        const rejection = payloadRejection({ result, operation, context, kind: "mutation" });

        if (rejection) throw rejection;

        throw new SocialError({
          code: "ambiguous_outcome",
          operation,
          backend: context.backendInstance,
          correlationId: context.correlationId,
          message: "Buffer did not confirm the deletion. Reconcile before retrying.",
          retryDisposition: { kind: "reconcile-first" },
        });
      },
    );
  };

  const manifest = capabilityManifest(
    "buffer",
    "GraphQL api.buffer.com, docs read 2026-10-09",
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
      "analytics.report.read",
    ],
    bufferFormats,
    (_platform, operation) =>
      managedConstraints(operation, operation === "posts.publish" ? ["https-url"] : undefined),
  );

  // Substack sits outside the shared platform list, so the adapter declares it here.
  const substackCapabilities: CapabilityDeclaration[] = [
    "accounts.read",
    "posts.publish",
    "posts.schedule",
    "posts.read",
    "posts.list",
    "posts.status",
    "posts.cancelScheduled",
    "posts.deleteBackendRecord",
    "analytics.read",
    "analytics.report.read",
  ].map((operation) => ({
    platform: substack,
    operation,
    availability: "available",
    surface: "normalized",
    ...definedFields({
      formats: operation === "posts.publish" ? ["text", "image", "video"] : undefined,
    }),
    constraints: managedConstraints(
      operation,
      operation === "posts.publish" ? ["https-url"] : undefined,
    ),
    notes:
      "Contract implementation; live account verification and provider/platform eligibility are separate. Substack Notes, listed under Buffer's `substack` service.",
  }));

  const adapter = defineAdapter({
    id: "buffer",
    capabilities: {
      ...manifest,
      capabilities: [
        ...manifest.capabilities,
        rawRequestCapability("*", "api.buffer.com"),
        ...substackCapabilities,
      ],
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

        const all = (await channels(context)).map((item) => item.account);
        const next = offset + limit < all.length ? String(offset + limit) : undefined;

        return {
          items: all.slice(offset, offset + limit),
          ...definedFields({ nextCursor: next }),
        };
      },
      async get(ref: ConnectedAccountRef, context: AdapterOperationContext) {
        return (await ownedChannel(ref, context, "accounts.read")).account;
      },
    },
    posts: {
      prepareTarget(target: Parameters<typeof managedPreparation>[0]) {
        const config = optionsObject(target);

        // The shared checks see only the options they map; this adapter parses the rest.
        const shared = {
          ...target,
          options: withoutKeys(config, [...postKeys, ...(ownKeys[target.account.platform] ?? [])]),
        };

        const link = cardLink(target);

        // A repost carries no text of its own.
        const repost = target.account.platform === "x" && config["retweet"] !== undefined;

        const issues: PreparationIssue[] = [
          ...managedPreparation(shared, "buffer").filter(
            (issue) =>
              // A link card is the post's content; Buffer's CreatePostInput.text is optional.
              (link === undefined ||
                (issue.code !== "link.explicit_text" && issue.code !== "content.empty")) &&
              (!repost || issue.code !== "content.empty") &&
              // Substack is declared by this adapter, not the shared platform list.
              (target.account.platform !== substack || issue.code !== "platform.unsupported"),
          ),
          ...managedOptionIssues(shared, "buffer"),
          ...bufferPlan(target, config).issues,
        ];

        const fail = (code: string, message: string) =>
          issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

        const at = target.schedule?.at;

        if (link !== undefined && !isPublicHttps(link.url))
          fail("link.url", "Provide the link as a public HTTPS URL.");

        if (at !== undefined && !(Date.parse(at) > clock().getTime()))
          fail("schedule.past", "Buffer custom schedules require a time in the future.");

        if (
          target.account.platform === "youtube" &&
          (!isString(config["categoryId"]) || config["categoryId"].length === 0)
        )
          fail("youtube.category", "Select a YouTube category explicitly.");

        if (target.account.platform === "instagram" && !isBoolean(config["shareToFeed"]))
          fail(
            "instagram.share_to_feed",
            "Select whether Instagram should share the post to feed.",
          );

        if (
          target.account.platform === substack &&
          (target.content.text ?? "").length > substackMaxLength
        )
          fail("substack.text_too_long", "Buffer limits Substack Notes to 10,000 characters.");

        for (const item of target.content.media ?? []) {
          // Buffer rejects video assets with thumbnailUrl; thumbnailOffset picks a frame instead.
          if (item.kind === "video" && item.thumbnail !== undefined)
            fail(
              "media.thumbnail_unsupported",
              "Buffer takes no custom video thumbnail. Use thumbnailOffset on Instagram, TikTok, or Pinterest.",
            );

          if (
            item.kind === "image" &&
            item.thumbnail !== undefined &&
            item.thumbnail.kind !== "https-url"
          )
            fail("media.thumbnail_url", "Buffer takes an image thumbnail as a public HTTPS URL.");

          if (item.kind === "document") {
            if (target.account.platform !== "linkedin")
              fail(
                "media.document_unsupported",
                "Buffer document assets are mapped for LinkedIn only.",
              );

            if (item.source.kind !== "https-url")
              fail(
                "media.url_required",
                "Buffer has no upload endpoint. Host the file yourself and pass a public HTTPS URL.",
              );

            if (documentTitle(item) === undefined)
              fail(
                "media.document_title",
                "Buffer documents need a title. Set the attachment caption or filename.",
              );

            if (item.thumbnail?.kind !== "https-url")
              fail(
                "media.document_thumbnail",
                "Buffer documents need a thumbnail hosted at a public HTTPS URL.",
              );

            continue;
          }

          if (item.source.kind !== "https-url")
            fail(
              "media.url_required",
              "Buffer has no upload endpoint. Host the file yourself and pass a public HTTPS URL.",
            );
        }

        return issues;
      },
      async publishTarget(
        target: Parameters<typeof managedPreparation>[0],
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        accountMatches(target.account, context);

        try {
          await ownedChannel(target.account, context, "posts.publish");
        } catch (error) {
          if (error instanceof SocialError && error.code === "cancelled")
            return {
              state: "cancelled",
              targetIndex: target.targetIndex,
              account: target.account,
              observedAt: now(),
              reason: "before-submission",
            };

          if (error instanceof SocialError && error.code === "timeout")
            return {
              state: "not-submitted",
              targetIndex: target.targetIndex,
              account: target.account,
              observedAt: now(),
              reason: "before-submission",
            };

          throw error;
        }

        const at = target.schedule?.at;
        const scheduled = at !== undefined;

        if (scheduled && !(Date.parse(at) > clock().getTime()))
          reject("posts.publish", "Buffer custom schedules require a time in the future.");

        const config = optionsObject(target);
        const { issues, plan } = bufferPlan(target, config);

        if (issues.length > 0) reject("posts.publish", string(issues[0]?.message));

        const assets: JsonObject[] = [];

        // The cover frame of the one video, in milliseconds.
        const cover = definedFields({
          metadata:
            plan.thumbnailOffset === undefined
              ? undefined
              : { thumbnailOffset: plan.thumbnailOffset },
        });

        for (const [index, item] of (target.content.media ?? []).entries()) {
          const source = item.source;
          const userTags = plan.userTags.get(index);
          const animated = plan.animatedThumbnails.get(index);

          if (source.kind !== "https-url")
            reject(
              "posts.publish",
              "Buffer accepts public HTTPS image, video and document URLs only through this adapter.",
            );
          else if (item.kind === "document") {
            const title = documentTitle(item);
            const thumbnail = item.thumbnail;

            if (title === undefined || thumbnail?.kind !== "https-url")
              reject("posts.publish", "Buffer documents need a title and an HTTPS thumbnail.");
            else
              assets.push({
                document: {
                  url: httpsUrl(source.url).href,
                  title,
                  thumbnailUrl: httpsUrl(thumbnail.url).href,
                },
              });
          } else
            assets.push(
              item.kind === "video"
                ? { video: { url: httpsUrl(source.url).href, ...cover } }
                : {
                    image: {
                      url: httpsUrl(source.url).href,
                      ...definedFields({
                        thumbnailUrl:
                          item.thumbnail?.kind === "https-url"
                            ? httpsUrl(item.thumbnail.url).href
                            : undefined,
                        // Buffer's image metadata requires altText; "" sends none unless
                        // user tags or an animated thumbnail need the metadata object.
                        metadata:
                          item.altText || animated !== undefined || userTags !== undefined
                            ? {
                                altText: item.altText ?? "",
                                ...definedFields({ userTags, animatedThumbnail: animated }),
                              }
                            : undefined,
                      }),
                    },
                  },
            );
        }

        const metadataEntries: [string, JsonObject][] = [];

        if (target.account.platform === "youtube") {
          const title = config["title"];
          const categoryId = config["categoryId"];
          const visibility = optionalString(config["visibility"]);

          if (!isString(title) || title.length === 0)
            return reject("posts.publish", "Select a YouTube title explicitly.");

          if (visibility !== "public" && visibility !== "unlisted" && visibility !== "private")
            return reject(
              "posts.publish",
              "Select public, unlisted, or private YouTube visibility.",
            );

          if (!isString(categoryId) || categoryId.length === 0)
            return reject("posts.publish", "Select a YouTube category explicitly.");

          metadataEntries.push([
            "youtube",
            {
              title,
              categoryId,
              privacy: visibility,
              ...definedFields({
                madeForKids: isBoolean(config["madeForKids"]) ? config["madeForKids"] : undefined,
              }),
            },
          ]);
        }

        if (target.account.platform === "instagram") {
          const shareToFeed = config["shareToFeed"];

          if (!isBoolean(shareToFeed))
            return reject("posts.publish", "Instagram shareToFeed must be selected explicitly.");

          metadataEntries.push(["instagram", { shouldShareToFeed: shareToFeed, type: "post" }]);
        }

        if (target.account.platform === "pinterest") {
          const boardServiceId = optionalString(config["boardId"]);
          const title = optionalString(config["title"]);
          const url = optionalString(config["link"]);

          if (boardServiceId === undefined)
            return reject("posts.publish", "Select the Pinterest board by its ID.");

          metadataEntries.push(["pinterest", { boardServiceId, ...definedFields({ title, url }) }]);
        }

        const metadata: Record<string, JsonObject> = Object.fromEntries(metadataEntries);

        for (const [service, fields] of plan.metadata)
          metadata[service] = { ...metadata[service], ...fields };

        const threadService = threadServices[target.account.platform];

        // Buffer publishes the thread array itself: the root post first, then each reply.
        if (plan.thread !== undefined && threadService !== undefined)
          metadata[threadService] = {
            ...metadata[threadService],
            thread: [
              { text: target.content.text ?? "", assets },
              ...plan.thread.map((reply) => ({ text: reply, assets: [] })),
            ],
          };

        const input: JsonObject = {
          text: target.content.text ?? "",
          channelId: target.account.accountId,
          schedulingType: plan.schedulingType,
          mode: scheduled ? "customScheduled" : (plan.mode ?? "shareNow"),
          needsApproval: plan.needsApproval,
          assets,
          ...definedFields({
            dueAt: scheduled ? new Date(string(at)).toISOString() : undefined,
            saveToDraft: plan.saveToDraft,
            tagIds: plan.tagIds === undefined ? undefined : [...plan.tagIds],
            ideaId: plan.ideaId,
            aiAssisted: plan.aiAssisted,
            draftId: plan.draftId,
            metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          }),
        };

        return mutate(
          "posts.publish",
          `mutation CreatePost($input: CreatePostInput!) {
            createPost(input: $input) {
              ... on PostActionSuccess {
                post {
                  ${postSelection}
                }
              }
              ... on MutationError {
                __typename
                message
              }
            }
          }`,
          { input },
          context,
          (data) => {
            const result = object(data["createPost"]);

            if (isJsonObject(result["post"]))
              return outcome(
                confirmedPost(result["post"], target.account),
                target.account,
                target.targetIndex,
              );

            const rejection = payloadRejection({
              result,
              operation: "posts.publish",
              context,
              kind: "mutation",
            });

            if (rejection) throw rejection;

            throw new SocialError({
              code: "ambiguous_outcome",
              operation: "posts.publish",
              backend: context.backendInstance,
              correlationId: context.correlationId,
              message: "Buffer did not confirm post creation. Reconcile before retrying.",
              retryDisposition: { kind: "reconcile-first" },
            });
          },
        );
      },
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        const owned = await ownedChannel(account, context, "posts.list");
        const limit = input.limit ?? 20;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          reject("posts.list", "Use a page size from 1 to 100.");

        if (input.cursor !== undefined && (!input.cursor || /[\s@]/.test(input.cursor)))
          reject("posts.list", "Use the cursor Buffer returned from the previous page.");

        const data = await graphql(
          "posts.list",
          `query Posts($first: Int, $after: String, $input: PostsInput!) {
            posts(first: $first, after: $after, input: $input) {
              edges {
                cursor
                node {
                  ${postSelection}
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }`,
          {
            first: limit,
            input: {
              organizationId: owned.organizationId,
              filter: { channelIds: [account.accountId] },
            },
            ...definedFields({ after: input.cursor }),
          },
          context,
          "query",
        );

        const connection = object(data["posts"]);
        const pageInfo = connection["pageInfo"] ? object(connection["pageInfo"]) : {};

        const items = array(connection["edges"]).flatMap((edge) => {
          const row = object(edge);
          const node = row["node"];

          if (node === undefined) return [];

          const parsed = object(node);

          if (parsed["channelId"] !== account.accountId) return [];

          return [publicPost(parsed)];
        });

        return {
          items,
          ...definedFields({
            nextCursor:
              pageInfo["hasNextPage"] === true ? optionalString(pageInfo["endCursor"]) : undefined,
          }),
        };
      },
      async get(ref: PlatformPostRef, context: AdapterOperationContext) {
        return publicPost(await readPost(ref.postId, ref, context, "posts.read"));
      },
      async getDelivery(ref: DeliveryRef, context: AdapterOperationContext) {
        return outcome(
          await readPost(ref.deliveryId, ref, context, "posts.status"),
          {
            kind: "connected-account",
            version: 1,
            backend: ref.backend,
            platform: ref.platform,
            accountId: ref.accountId,
          },
          0,
        );
      },
      async cancelScheduled(
        ref: ScheduledJobRef,
        context: AdapterOperationContext,
      ): Promise<ScheduleCancellation> {
        const row = await readPost(ref.jobId, ref, context, "posts.cancelScheduled");
        const dueAt = optionalString(row["dueAt"]);

        if (
          row["status"] !== "scheduled" ||
          !dueAt ||
          !Number.isFinite(Date.parse(dueAt)) ||
          Date.parse(dueAt) <= clock().getTime()
        )
          reject(
            "posts.cancelScheduled",
            "Only a future scheduled Buffer post can be cancelled. Reconcile a due or dispatched post.",
          );

        await deleteOwned(string(row["id"]), context, "posts.cancelScheduled");

        return { state: "cancelled", backendRecord: "deleted" };
      },
      async deleteBackendRecord(ref: BackendPostRef, context: AdapterOperationContext) {
        const row = await readPost(ref.recordId, ref, context, "posts.deleteBackendRecord");
        const status = optionalString(row["status"]);

        if (status !== "draft" && status !== "error" && status !== "needs_approval")
          reject(
            "posts.deleteBackendRecord",
            "Only a Buffer draft, approval, or failed record can be deleted this way. Cancel a future schedule or reconcile a dispatched post.",
          );

        await deleteOwned(string(row["id"]), context, "posts.deleteBackendRecord");
      },
    },
    analytics: {
      async getPostMetrics(ref: PlatformPostRef, context: AdapterOperationContext) {
        const row = await readPost(ref.postId, ref, context, "analytics.read", true);

        if (row["status"] !== "sent")
          throw new SocialError({
            code: "not_found",
            operation: "analytics.read",
            message: "Buffer reports metrics only after a post is sent.",
          });

        return normalizeMetrics(postMetrics(row, ref.platform));
      },
      /**
       * `aggregatedPostMetrics` for one channel over `from` to `to`, at most 365 days. Returns one
       * row with the requested metric types Buffer reports, such as `postCount` or `reactions`.
       */
      async getReport(
        account: ConnectedAccountRef,
        query: AnalyticsReportQuery,
        context: AdapterOperationContext,
      ): Promise<AnalyticsReport> {
        if ((query.dimensions ?? []).length > 0)
          reject("analytics.report.read", "Buffer aggregates one channel; it takes no dimensions.");

        const start = Date.parse(`${query.from}T00:00:00Z`);
        const end = Date.parse(`${query.to}T00:00:00Z`);

        // Buffer's `endDateTime` is UTC midnight of the last day and covers that whole day, so
        // `from` to `to` spans (to - from) + 1 days, and Buffer caps that at 365.
        if (!Number.isFinite(start) || !Number.isFinite(end) || end - start >= 365 * 86_400_000)
          reject("analytics.report.read", "Buffer aggregates at most 365 days.");

        const owned = await ownedChannel(account, context, "analytics.report.read");

        const data = await graphql(
          "analytics.report.read",
          `query AggregatedPostMetrics($input: AggregatedPostMetricsInput!) {
            aggregatedPostMetrics(input: $input) {
              ${metricsSelection}
            }
          }`,
          {
            input: {
              organizationId: owned.organizationId,
              channelIds: [account.accountId],
              startDateTime: new Date(start).toISOString(),
              endDateTime: new Date(end).toISOString(),
            },
          },
          context,
          "query",
        );

        const values = postMetrics(object(data["aggregatedPostMetrics"]), account.platform);

        return {
          query,
          rows: [
            {
              dimensions: { channelId: account.accountId },
              metrics: Object.fromEntries(
                values
                  .filter((metric) => query.metrics.includes(metric.name))
                  .map((metric) => [metric.name, metric.value]),
              ),
            },
          ],
          fetchedAt: now(),
          source: `buffer:${account.platform}:aggregate`,
        };
      },
    },
    native: {
      /**
       * Sends one request to the Buffer API the SDK does not wrap, with the bearer API key. Host `api` is `https://api.buffer.com`; GraphQL goes to path `/` and reports errors in a 200 body.
       * The key is workspace-scoped, so the SDK cannot check which accounts the path touches.
       * Raw requests never retry or reconcile; the caller owns any write it sends.
       */
      request: managedRawRequest(apiOrigin, options),
      /**
       * `editPost`: change the text, custom time, draft state, or tags of a draft, scheduled, or
       * approval post. Fields you leave out keep their value.
       */
      async editPost(
        ref: BufferPostRef,
        edit: BufferPostEdit,
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        // A field this method does not send, such as `assets` or `metadata`, must not be dropped
        // silently: the edit would resolve while the post kept its old media or settings.
        if (Object.keys(edit).some((key) => !bufferPostEditFields.has(key)))
          reject(
            "posts.update",
            "editPost changes text, at, saveToDraft, tagIds, approvalChange, aiAssisted, and draftId only. Use a raw editPost request for assets or metadata.",
          );

        const row = await readPost(postRecordId(ref), ref, context, "posts.update");

        if (!["draft", "scheduled", "needs_approval"].includes(String(row["status"])))
          reject("posts.update", "Buffer edits only a draft, scheduled, or approval post.");

        if (edit.at !== undefined && !(Date.parse(edit.at) > clock().getTime()))
          reject("posts.update", "Pick a future time.");

        for (const tag of edit.tagIds ?? []) bufferId(tag, "posts.update", "tag");

        if (edit.approvalChange !== undefined) {
          if (edit.approvalChange !== "request" && edit.approvalChange !== "revert")
            reject("posts.update", "Set approvalChange to request or revert.");

          if (row["status"] !== "draft" && row["status"] !== "needs_approval")
            reject("posts.update", "Buffer changes the approval state of a draft only.");
        }

        if (edit.aiAssisted !== undefined && !isBoolean(edit.aiAssisted))
          reject("posts.update", "aiAssisted must be a boolean.");

        if (edit.draftId !== undefined) bufferId(edit.draftId, "posts.update", "draft");

        const input = {
          id: string(row["id"]),
          ...definedFields({
            text: edit.text,
            dueAt: edit.at === undefined ? undefined : new Date(edit.at).toISOString(),
            mode: edit.at === undefined ? undefined : "customScheduled",
            saveToDraft: edit.saveToDraft,
            tagIds: edit.tagIds === undefined ? undefined : [...edit.tagIds],
            approvalChange: edit.approvalChange,
            aiAssisted: edit.aiAssisted,
            draftId: edit.draftId,
          }),
        };

        if (Object.keys(input).length === 1) reject("posts.update", "Pass at least one change.");

        return mutate(
          "posts.update",
          `mutation EditPost($input: EditPostInput!) {
            editPost(input: $input) {
              ... on PostActionSuccess {
                post {
                  ${postSelection}
                }
              }
              ... on MutationError {
                __typename
                message
              }
            }
          }`,
          { input },
          context,
          (data) => {
            return actionOutcome(object(data["editPost"]), ref, input.id, "posts.update", context);
          },
        );
      },

      /**
       * `posts` with Buffer's filters and sort: status, `dueAt` and `createdAt` ranges,
       * `dueAtPresence`, `postTypes`, and tags, across channels of one organization.
       */
      async listPosts(
        query: BufferPostsQuery,
        context: AdapterOperationContext,
      ): Promise<{ readonly items: readonly JsonObject[]; readonly nextCursor?: string }> {
        const operation = "posts.list";
        const limit = query.limit ?? 20;

        if (query.accounts.length === 0) reject(operation, "Pass at least one channel.");

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          reject(operation, "Use a page size from 1 to 100.");

        if (query.cursor !== undefined && (!query.cursor || /[\s@]/.test(query.cursor)))
          reject(operation, "Use the cursor Buffer returned from the previous page.");

        const statuses = ["draft", "error", "needs_approval", "scheduled", "sending", "sent"];

        if (query.status?.some((value) => !statuses.includes(value)))
          reject(operation, `Filter status by ${statuses.join(", ")}.`);

        // Buffer rejects `carousel` and `thread`: no stored post format resolves to them.
        const postTypes = [
          "event",
          "ghost_post",
          "offer",
          "post",
          "reel",
          "short",
          "story",
          "whats_new",
        ];

        if (query.postTypes?.some((value) => !postTypes.includes(value)))
          reject(operation, `Filter postTypes by ${postTypes.join(", ")}.`);

        if (
          query.dueAtPresence !== undefined &&
          query.dueAtPresence !== "present" &&
          query.dueAtPresence !== "absent"
        )
          reject(operation, "Set dueAtPresence to present or absent.");

        if (query.dueAtPresence === "absent" && query.dueAt !== undefined)
          reject(operation, "Posts without a scheduled time cannot also match a dueAt range.");

        const range = (value: { readonly start?: string; readonly end?: string } | undefined) => {
          if (value === undefined) return undefined;

          const bounds = [value.start, value.end].filter((bound) => bound !== undefined);

          if (bounds.length === 0 || bounds.some((bound) => !isDateTime(bound)))
            return reject(operation, "Date ranges take ISO 8601 start and end times.");

          return definedFields({
            start: value.start === undefined ? undefined : new Date(value.start).toISOString(),
            end: value.end === undefined ? undefined : new Date(value.end).toISOString(),
          });
        };

        for (const tag of query.tags?.in ?? []) bufferId(tag, operation, "tag");

        if (query.tags?.isEmpty !== undefined && !isBoolean(query.tags.isEmpty))
          reject(operation, "tags.isEmpty must be a boolean.");

        const sort = query.sort?.map((entry) => {
          if (
            (entry.field !== "dueAt" && entry.field !== "createdAt") ||
            (entry.direction !== "asc" && entry.direction !== "desc")
          )
            reject(operation, "Sort by dueAt or createdAt, asc or desc.");

          return { field: entry.field, direction: entry.direction };
        });

        const owned = await channels(context);
        const organizations = new Set<string>();

        for (const account of query.accounts) {
          accountMatches(account, context);

          const found = owned.find(
            (item) =>
              item.account.ref.accountId === account.accountId &&
              item.account.ref.platform === account.platform,
          );

          if (!found)
            throw new SocialError({
              code: "not_found",
              operation,
              message: "Buffer has no connected channel matching this reference.",
            });

          organizations.add(found.organizationId);
        }

        if (organizations.size !== 1) reject(operation, "Pass channels of one organization.");

        const channelIds = query.accounts.map((account) => account.accountId);

        const data = await graphql(
          operation,
          `query Posts($first: Int, $after: String, $input: PostsInput!) {
            posts(first: $first, after: $after, input: $input) {
              edges {
                node {
                  ${postSelection}
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }`,
          {
            first: limit,
            input: {
              organizationId: string([...organizations][0]),
              filter: {
                channelIds,
                ...definedFields({
                  status: query.status === undefined ? undefined : [...query.status],
                  dueAt: range(query.dueAt),
                  dueAtPresence: query.dueAtPresence,
                  createdAt: range(query.createdAt),
                  postTypes: query.postTypes === undefined ? undefined : [...query.postTypes],
                  tags:
                    query.tags === undefined
                      ? undefined
                      : { in: [...(query.tags.in ?? [])], isEmpty: query.tags.isEmpty === true },
                }),
              },
              ...definedFields({ sort }),
            },
            ...definedFields({ after: query.cursor }),
          },
          context,
          "query",
        );

        const connection = object(data["posts"]);
        const pageInfo = isJsonObject(connection["pageInfo"]) ? connection["pageInfo"] : {};

        // Keep only the requested channels, even if Buffer widened the filter.
        const items = array(connection["edges"]).flatMap((edge) => {
          const node = object(edge)["node"];

          if (!isJsonObject(node) || !channelIds.includes(String(node["channelId"]))) return [];

          return [publicPost(node)];
        });

        return {
          items,
          ...definedFields({
            nextCursor:
              pageInfo["hasNextPage"] === true ? optionalString(pageInfo["endCursor"]) : undefined,
          }),
        };
      },

      /** `movePostInQueue` (beta): move a queued post to the `top` or `bottom` of its queue. */
      async movePostInQueue(
        ref: BufferPostRef,
        position: "top" | "bottom",
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        if (position !== "top" && position !== "bottom")
          reject("posts.schedule", "Move the post to the top or bottom.");

        const row = await readPost(postRecordId(ref), ref, context, "posts.schedule");

        if (row["status"] !== "scheduled")
          reject("posts.schedule", "Only a scheduled Buffer post moves in the queue.");

        return mutate(
          "posts.schedule",
          `mutation MovePostInQueue($input: MovePostInQueueInput!) {
            movePostInQueue(input: $input) {
              ... on PostActionSuccess {
                post {
                  ${postSelection}
                }
              }
              ... on MutationError {
                __typename
                message
              }
            }
          }`,
          { input: { id: string(row["id"]), position } },
          context,
          (data) => {
            return actionOutcome(
              object(data["movePostInQueue"]),
              ref,
              string(row["id"]),
              "posts.schedule",
              context,
            );
          },
        );
      },

      /**
       * `dailyPostingLimits`: whether one more post at `at` (default now) would exceed each
       * channel's network limit. The channels must share one organization.
       */
      async dailyPostingLimits(
        accounts: readonly ConnectedAccountRef[],
        input: { readonly at?: string },
        context: AdapterOperationContext,
      ): Promise<readonly BufferPostingLimit[]> {
        if (accounts.length === 0) reject("posts.schedule", "Pass at least one channel.");

        for (const account of accounts) accountMatches(account, context);

        if (input.at !== undefined && !Number.isFinite(Date.parse(input.at)))
          reject("posts.schedule", "Pass the intended posting time as an ISO date.");

        const data = await graphql(
          "posts.schedule",
          `
            query DailyPostingLimits($input: DailyPostingLimitsInput!) {
              dailyPostingLimits(input: $input) {
                channelId
                isAtLimit
                limit
                scheduled
                sent
              }
            }
          `,
          {
            input: {
              channelIds: accounts.map((account) =>
                bufferId(account.accountId, "posts.schedule", "channel"),
              ),
              ...definedFields({
                date: input.at === undefined ? undefined : new Date(input.at).toISOString(),
              }),
            },
          },
          context,
          "query",
        );

        return array(data["dailyPostingLimits"]).map((value) => {
          const row = object(value);

          return {
            channelId: string(row["channelId"]),
            isAtLimit: row["isAtLimit"] === true,
            scheduled: optionalNumber(row["scheduled"]) ?? 0,
            sent: optionalNumber(row["sent"]) ?? 0,
            ...definedFields({ limit: optionalNumber(row["limit"]) }),
          };
        });
      },

      /**
       * `createIdea`: save an idea in the organization's Create space, with media, tags, target
       * services, and its place in an idea group. Needs the `ideas:write` scope for OAuth tokens.
       * Pass the returned ID as the `ideaId` option to link a post to it.
       */
      async createIdea(
        input: BufferIdeaInput,
        context: AdapterOperationContext,
      ): Promise<{ readonly id: string }> {
        const operation = "ideas.create";
        const organization = input.organizationId ?? organizationId;

        if (organization === undefined)
          reject(operation, "Pass the Buffer organization that owns the idea.");

        if (input.title === undefined && input.text === undefined && input.media === undefined)
          reject(operation, "An idea needs a title, text, or media.");

        if (input.date !== undefined && !Number.isFinite(Date.parse(input.date)))
          reject(operation, "Pass the idea date as an ISO date.");

        const mediaTypes = ["image", "gif", "link", "document"];

        const media = input.media?.map((item) => {
          if (!mediaTypes.includes(item.type))
            reject(
              operation,
              "Idea media is an image, gif, link, or document; Buffer's API takes no idea video.",
            );

          if (
            !isPublicHttps(item.url) ||
            (item.thumbnailUrl !== undefined && !isPublicHttps(item.thumbnailUrl))
          )
            reject(operation, "Idea media and thumbnails need public HTTPS URLs.");

          if (item.size !== undefined && !isWhole(item.size))
            reject(operation, "Idea media size is a whole number of bytes.");

          const source = item.source;

          if (source !== undefined && (!isString(source.name) || source.name.trim() === ""))
            reject(operation, "An idea media source needs a name.");

          return {
            url: httpsUrl(item.url).href,
            type: item.type,
            ...definedFields({
              alt: item.alt,
              thumbnailUrl:
                item.thumbnailUrl === undefined ? undefined : httpsUrl(item.thumbnailUrl).href,
              size: item.size,
              source: source && {
                name: source.name,
                ...definedFields({
                  id: source.id,
                  trigger: source.trigger,
                  author: source.author,
                  authorUrl: source.authorUrl,
                }),
              },
            }),
          };
        });

        for (const tag of input.tags ?? []) {
          bufferId(tag.id, operation, "tag");

          if (!isString(tag.name) || !isString(tag.color) || !/^#[0-9A-Fa-f]{6}$/.test(tag.color))
            reject(operation, "Each idea tag needs its id, name, and hex color such as #F523F1.");
        }

        if (input.services?.some((service) => !ideaServices.includes(service)))
          reject(operation, `Target Buffer services: ${ideaServices.join(", ")}.`);

        if (input.aiAssisted !== undefined && !isBoolean(input.aiAssisted))
          reject(operation, "aiAssisted must be a boolean.");

        if (input.groupId !== undefined) bufferId(input.groupId, operation, "idea group");

        if (input.placeAfterId !== undefined) bufferId(input.placeAfterId, operation, "idea");

        return mutate(
          operation,
          `
            mutation CreateIdea($input: CreateIdeaInput!) {
              createIdea(input: $input) {
                ... on IdeaResponse {
                  idea {
                    id
                  }
                }
                ... on InvalidInputError {
                  __typename
                  message
                }
                ... on UnauthorizedError {
                  __typename
                  message
                }
                ... on LimitReachedError {
                  __typename
                  message
                }
                ... on UnexpectedError {
                  __typename
                  message
                }
              }
            }
          `,
          {
            input: {
              organizationId: bufferId(string(organization), operation, "organization"),
              content: definedFields({
                title: input.title,
                text: input.text,
                date: input.date === undefined ? undefined : new Date(input.date).toISOString(),
                media,
                tags: input.tags?.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color })),
                services: input.services === undefined ? undefined : [...input.services],
                aiAssisted: input.aiAssisted,
              }),
              ...definedFields({
                templateId: input.templateId,
                cta: input.cta,
                group:
                  input.groupId === undefined && input.placeAfterId === undefined
                    ? undefined
                    : definedFields({ groupId: input.groupId, placeAfterId: input.placeAfterId }),
              }),
            },
          },
          context,
          (data) => {
            // The mutation was dispatched; anything short of an idea ID or a stated error is uncertain.
            const result = optionalObject(data["createIdea"]) ?? {};
            const idea = optionalObject(result["idea"]);
            const id = idea?.["id"];

            if (isBufferId(id)) return { id };

            const rejection =
              idea === undefined
                ? payloadRejection({ result, operation, context, kind: "mutation" })
                : undefined;

            if (rejection) throw rejection;

            throw new SocialError({
              code: "ambiguous_outcome",
              operation,
              message: "Buffer did not confirm the idea. Check the Create space before retrying.",
              retryDisposition: { kind: "reconcile-first" },
            });
          },
        );
      },

      /** `ideaGroups`: the idea groups (Create-space board columns) of an organization. */
      async listIdeaGroups(
        input: { readonly organizationId?: string },
        context: AdapterOperationContext,
      ): Promise<readonly BufferIdeaGroup[]> {
        const organization = input.organizationId ?? organizationId;

        if (organization === undefined)
          reject("ideas.read", "Pass the Buffer organization that owns the ideas.");

        const data = await graphql(
          "ideas.read",
          `
            query IdeaGroups($input: IdeaGroupsInput!) {
              ideaGroups(input: $input) {
                id
                name
                isLocked
              }
            }
          `,
          {
            input: { organizationId: bufferId(string(organization), "ideas.read", "organization") },
          },
          context,
          "query",
        );

        return array(data["ideaGroups"]).map((value) => {
          const row = object(value);

          return {
            id: string(row["id"]),
            name: string(row["name"]),
            isLocked: row["isLocked"] === true,
          };
        });
      },

      /** `ideas`: a page of an organization's ideas, filtered by group and tags. */
      async listIdeas(
        query: BufferIdeasQuery,
        context: AdapterOperationContext,
      ): Promise<{ readonly items: readonly BufferIdea[]; readonly nextCursor?: string }> {
        const operation = "ideas.read";
        const organization = query.organizationId ?? organizationId;
        const limit = query.limit ?? 20;

        if (organization === undefined)
          reject(operation, "Pass the Buffer organization that owns the ideas.");

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          reject(operation, "Use a page size from 1 to 100.");

        if (query.cursor !== undefined && (!query.cursor || /[\s@]/.test(query.cursor)))
          reject(operation, "Use the cursor Buffer returned from the previous page.");

        if (query.groupIds !== undefined && query.membership !== undefined)
          reject(operation, "Filter by groupIds or membership, not both.");

        if (
          query.membership !== undefined &&
          query.membership !== "grouped" &&
          query.membership !== "ungrouped"
        )
          reject(operation, "Set membership to grouped or ungrouped.");

        for (const id of query.groupIds ?? []) bufferId(id, operation, "idea group");

        for (const tag of query.tags?.in ?? []) bufferId(tag, operation, "tag");

        const data = await graphql(
          operation,
          `
            query Ideas($first: Int, $after: String, $input: IdeasInput!) {
              ideas(first: $first, after: $after, input: $input) {
                edges {
                  node {
                    id
                    groupId
                    position
                    createdAt
                    updatedAt
                    content {
                      title
                      text
                      date
                      aiAssisted
                      services
                      tags {
                        id
                        name
                        color
                      }
                      media {
                        url
                        type
                        alt
                        thumbnailUrl
                      }
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          `,
          {
            first: limit,
            input: {
              organizationId: bufferId(string(organization), operation, "organization"),
              ...definedFields({
                groupFilter:
                  query.groupIds !== undefined
                    ? { groups: [...query.groupIds] }
                    : query.membership !== undefined
                      ? { membership: query.membership }
                      : undefined,
                tagsFilter:
                  query.tags === undefined
                    ? undefined
                    : { in: [...(query.tags.in ?? [])], isEmpty: query.tags.isEmpty === true },
              }),
            },
            ...definedFields({ after: query.cursor }),
          },
          context,
          "query",
        );

        const connection = object(data["ideas"]);
        const pageInfo = isJsonObject(connection["pageInfo"]) ? connection["pageInfo"] : {};

        // Buffer reports idea times as Unix seconds.
        const time = (value: JsonField) =>
          new Date((optionalNumber(value) ?? 0) * 1000).toISOString();

        const items = array(connection["edges"]).map((edge) => {
          const node = object(object(edge)["node"]);
          const content = object(node["content"]);

          return {
            id: string(node["id"]),
            aiAssisted: content["aiAssisted"] === true,
            services: isJsonArray(content["services"]) ? content["services"].filter(isString) : [],
            tags: (isJsonArray(content["tags"]) ? content["tags"] : []).map((value) => {
              const tag = object(value);

              return {
                id: string(tag["id"]),
                name: string(tag["name"]),
                color: string(tag["color"]),
              };
            }),
            media: (isJsonArray(content["media"]) ? content["media"] : []).map((value) => {
              const item = object(value);

              return {
                url: string(item["url"]),
                type: string(item["type"]),
                ...definedFields({
                  alt: optionalString(item["alt"]),
                  thumbnailUrl: optionalString(item["thumbnailUrl"]),
                }),
              };
            }),
            createdAt: time(node["createdAt"]),
            updatedAt: time(node["updatedAt"]),
            ...definedFields({
              groupId: optionalString(node["groupId"]),
              position: optionalNumber(node["position"]),
              title: optionalString(content["title"]),
              text: optionalString(content["text"]),
              date: optionalString(content["date"]),
            }),
          };
        });

        return {
          items,
          ...definedFields({
            nextCursor:
              pageInfo["hasNextPage"] === true ? optionalString(pageInfo["endCursor"]) : undefined,
          }),
        };
      },

      /**
       * `channels` with Buffer's `isLocked` and `product` filters, and each channel's timezone,
       * posting goal, link shortening, allowed actions, products, and scopes.
       */
      async listChannels(
        input: {
          readonly organizationId?: string;
          readonly isLocked?: boolean;
          readonly product?: "publish" | "analyze" | "engage" | "comments" | "startPage" | "buffer";
        },
        context: AdapterOperationContext,
      ): Promise<readonly BufferChannel[]> {
        const operation = "accounts.read";
        const products = ["publish", "analyze", "engage", "comments", "startPage", "buffer"];

        if (input.isLocked !== undefined && !isBoolean(input.isLocked))
          reject(operation, "isLocked must be a boolean.");

        if (input.product !== undefined && !products.includes(input.product))
          reject(operation, `Filter product by ${products.join(", ")}.`);

        const orgs =
          input.organizationId === undefined
            ? await organizations(context)
            : [bufferId(input.organizationId, operation, "organization")];

        const items: BufferChannel[] = [];

        for (const org of orgs) {
          const data = await graphql(
            operation,
            `
              query ChannelSettings($input: ChannelsInput!) {
                channels(input: $input) {
                  id
                  name
                  displayName
                  service
                  serviceId
                  organizationId
                  type
                  timezone
                  isLocked
                  isDisconnected
                  isQueuePaused
                  externalLink
                  allowedActions
                  products
                  scopes
                  linkShortening {
                    isEnabled
                  }
                  postingGoal {
                    goal
                    sentCount
                    scheduledCount
                    status
                    periodStart
                    periodEnd
                  }
                }
              }
            `,
            {
              input: {
                organizationId: org,
                ...definedFields({
                  filter:
                    input.isLocked === undefined && input.product === undefined
                      ? undefined
                      : definedFields({ isLocked: input.isLocked, product: input.product }),
                }),
              },
            },
            context,
            "query",
          );

          for (const value of array(data["channels"])) {
            const row = object(value);
            const goal = isJsonObject(row["postingGoal"]) ? row["postingGoal"] : undefined;
            const shortening = isJsonObject(row["linkShortening"]) ? row["linkShortening"] : {};
            const names = (field: JsonField) => (isJsonArray(field) ? field.filter(isString) : []);

            items.push({
              id: string(row["id"]),
              service: string(row["service"]),
              serviceId: string(row["serviceId"]),
              name: string(row["name"]),
              organizationId: optionalString(row["organizationId"]) ?? org,
              type: string(row["type"]),
              timezone: string(row["timezone"]),
              isLocked: row["isLocked"] === true,
              isDisconnected: row["isDisconnected"] === true,
              isQueuePaused: row["isQueuePaused"] === true,
              linkShortening: { isEnabled: shortening["isEnabled"] === true },
              allowedActions: names(row["allowedActions"]),
              products: names(row["products"]),
              scopes: names(row["scopes"]),
              ...definedFields({
                platform: mappedPlatform(nativePlatforms, string(row["service"]), options),
                displayName: optionalString(row["displayName"]),
                url: optionalString(row["externalLink"]),
                postingGoal: goal && {
                  goal: optionalNumber(goal["goal"]) ?? 0,
                  sentCount: optionalNumber(goal["sentCount"]) ?? 0,
                  scheduledCount: optionalNumber(goal["scheduledCount"]) ?? 0,
                  status: string(goal["status"]),
                  periodStart: string(goal["periodStart"]),
                  periodEnd: string(goal["periodEnd"]),
                },
              }),
            });
          }
        }

        return items;
      },

      /** `account.organizations`: each organization's plan limits and member count. */
      async listOrganizations(
        context: AdapterOperationContext,
      ): Promise<readonly BufferOrganization[]> {
        const data = await graphql(
          "accounts.read",
          `
            query OrganizationLimits {
              account {
                organizations {
                  id
                  name
                  channelCount
                  members {
                    totalCount
                  }
                  limits {
                    channels
                    members
                    scheduledPosts
                    scheduledStoriesPerChannel
                    scheduledThreadsPerChannel
                    ideas
                    ideaGroups
                    tags
                    postTemplates
                    savedReplies
                    generateContent
                  }
                }
              }
            }
          `,
          {},
          context,
          "query",
        );

        return array(object(data["account"])["organizations"]).flatMap((value) => {
          const row = object(value);
          const id = string(row["id"]);

          // An adapter scoped to one organization reports only that one.
          if (organizationId !== undefined && id !== organizationId) return [];

          const limits = object(row["limits"]);

          return [
            {
              id,
              name: string(row["name"]),
              channelCount: optionalNumber(row["channelCount"]) ?? 0,
              memberCount: optionalNumber(object(row["members"])["totalCount"]) ?? 0,
              limits: Object.fromEntries(
                Object.entries(limits).flatMap(([key, limit]) =>
                  isFiniteNumber(limit) ? [[key, limit]] : [],
                ),
              ),
            },
          ];
        });
      },

      /** `account`: the authenticated user's timezone and scheduling preferences. */
      async getAccount(context: AdapterOperationContext): Promise<BufferAccount> {
        const data = await graphql(
          "accounts.read",
          `
            query AccountPreferences {
              account {
                id
                name
                timezone
                preferences {
                  timeFormat
                  startOfWeek
                  defaultScheduleOption
                }
              }
            }
          `,
          {},
          context,
          "query",
        );

        const row = object(data["account"]);
        const preferences = isJsonObject(row["preferences"]) ? row["preferences"] : undefined;

        return {
          id: string(row["id"]),
          ...definedFields({
            name: optionalString(row["name"]),
            timezone: optionalString(row["timezone"]),
            preferences: preferences && {
              defaultScheduleOption: string(preferences["defaultScheduleOption"]),
              ...definedFields({
                timeFormat: optionalString(preferences["timeFormat"]),
                startOfWeek: optionalString(preferences["startOfWeek"]),
              }),
            },
          }),
        };
      },

      /**
       * `configuration` (experimental): each channel's per-feature authorization and content
       * rules, and Buffer's per-service capability catalog.
       */
      async getConfiguration(
        input: { readonly organizationId?: string },
        context: AdapterOperationContext,
      ): Promise<BufferConfiguration> {
        const organization = input.organizationId ?? organizationId;

        if (organization === undefined)
          reject("accounts.read", "Pass the Buffer organization to read configuration for.");

        const data = await graphql(
          "accounts.read",
          `query Configuration($input: ConfigurationInput!) {
            configuration(input: $input) {
              channels {
                channelId
                service
                channelType
                authorizationStatus {
                  feature
                  status
                  reason
                }
                content {
                  ${contentSelection}
                }
              }
              services {
                service
                channelType
                content {
                  ${contentSelection}
                }
              }
            }
          }`,
          {
            input: {
              organizationId: bufferId(string(organization), "accounts.read", "organization"),
            },
          },
          context,
          "query",
        );

        const result = object(data["configuration"]);

        return {
          channels: array(result["channels"]).map((value) => {
            const row = object(value);

            return {
              channelId: string(row["channelId"]),
              service: string(row["service"]),
              channelType: string(row["channelType"]),
              authorizationStatus: array(row["authorizationStatus"]).map((item) => {
                const entry = object(item);

                return {
                  feature: string(entry["feature"]),
                  status: string(entry["status"]),
                  ...definedFields({ reason: optionalString(entry["reason"]) }),
                };
              }),
              content: array(row["content"]).map(contentConfiguration),
            };
          }),
          services: array(result["services"]).map((value) => {
            const row = object(value);

            return {
              service: string(row["service"]),
              channelType: string(row["channelType"]),
              content: array(row["content"]).map(contentConfiguration),
            };
          }),
        };
      },

      /**
       * `selectableTeamMembers` (experimental): members of an organization, or those who can read
       * Notes on one channel, for mentions and pickers. Emails are not read.
       */
      async listTeamMembers(
        input: {
          readonly organizationId?: string;
          readonly account?: ConnectedAccountRef;
          readonly search?: string;
          readonly limit?: number;
          readonly cursor?: string;
        },
        context: AdapterOperationContext,
      ): Promise<{ readonly items: readonly BufferTeamMember[]; readonly nextCursor?: string }> {
        const operation = "accounts.read";
        const limit = input.limit ?? 50;

        if (input.account !== undefined && input.organizationId !== undefined)
          reject(operation, "Scope team members by organizationId or account, not both.");

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          reject(operation, "Use a page size from 1 to 100.");

        if (input.cursor !== undefined && (!input.cursor || /[\s@]/.test(input.cursor)))
          reject(operation, "Use the cursor Buffer returned from the previous page.");

        let scope: JsonObject;

        if (input.account !== undefined) {
          await ownedChannel(input.account, context, operation);

          scope = { channelId: input.account.accountId };
        } else {
          const organization = input.organizationId ?? organizationId;

          if (organization === undefined)
            reject(operation, "Pass the organization or channel to list team members for.");

          scope = { organizationId: bufferId(string(organization), operation, "organization") };
        }

        const data = await graphql(
          operation,
          `
            query SelectableTeamMembers(
              $first: Int
              $after: String
              $input: SelectableTeamMembersInput!
            ) {
              selectableTeamMembers(first: $first, after: $after, input: $input) {
                edges {
                  node {
                    id
                    name
                    urn
                    isLocked
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          `,
          {
            first: limit,
            input: { scope, ...definedFields({ search: input.search?.trim() || undefined }) },
            ...definedFields({ after: input.cursor }),
          },
          context,
          "query",
        );

        const connection = object(data["selectableTeamMembers"]);
        const pageInfo = isJsonObject(connection["pageInfo"]) ? connection["pageInfo"] : {};

        return {
          items: array(connection["edges"]).map((edge) => {
            const node = object(object(edge)["node"]);

            return {
              id: string(node["id"]),
              urn: string(node["urn"]),
              isLocked: node["isLocked"] === true,
              ...definedFields({ name: optionalString(node["name"]) }),
            };
          }),
          ...definedFields({
            nextCursor:
              pageInfo["hasNextPage"] === true ? optionalString(pageInfo["endCursor"]) : undefined,
          }),
        };
      },

      /**
       * `searchInstagramAudio` (beta): search Meta's licensed music or original sounds for an
       * Instagram channel. Buffer's post input has no audio field, so results are for reference.
       */
      async searchInstagramAudio(
        account: ConnectedAccountRef,
        input: { readonly query: string; readonly audioType: "music" | "originalSound" },
        context: AdapterOperationContext,
      ): Promise<readonly BufferInstagramAudio[]> {
        if (account.platform !== "instagram")
          reject("media.audio", "Instagram audio search needs an Instagram channel.");

        if (!input.query.trim()) reject("media.audio", "Pass the text to search for.");

        if (input.audioType !== "music" && input.audioType !== "originalSound")
          reject("media.audio", "Search music or originalSound.");

        await ownedChannel(account, context, "media.audio");

        const data = await graphql(
          "media.audio",
          `
            query SearchInstagramAudio($input: SearchInstagramAudioInput!) {
              searchInstagramAudio(input: $input) {
                ... on SearchInstagramAudioSuccess {
                  audio {
                    id
                    title
                    type
                    duration
                    displayArtist
                    creatorUsername
                  }
                }
                ... on ChannelRefreshRequired {
                  message
                }
              }
            }
          `,
          {
            input: {
              channelId: account.accountId,
              query: input.query,
              audioType: input.audioType,
            },
          },
          context,
          "query",
        );

        const result = object(data["searchInstagramAudio"]);
        const audio = result["audio"];

        if (audio === undefined)
          throw new SocialError({
            code: "reconnect_required",
            operation: "media.audio",
            message: "Buffer needs this Instagram channel refreshed before it can search audio.",
            retryDisposition: { kind: "after-reconnect" },
          });

        return array(audio).map((value) => {
          const row = object(value);
          const type = row["type"];

          return {
            id: string(row["id"]),
            title: string(row["title"]),
            type: type === "originalSound" ? "originalSound" : "music",
            durationMs: optionalNumber(row["duration"]) ?? 0,
            ...definedFields({
              displayArtist: optionalString(row["displayArtist"]),
              creatorUsername: optionalString(row["creatorUsername"]),
            }),
          };
        });
      },
    },
  });

  /**
   * The post a `PostActionSuccess` returned, checked against what the mutation addressed: a Buffer
   * post ID (equal to the edited post's ID on edits), a `PostStatus` string, and, when present,
   * the target channel. Anything else leaves the change unconfirmed.
   */
  function confirmedPost(
    value: JsonField,
    account: ConnectedAccountRef,
    expectedId?: string,
  ): JsonObject {
    const post = object(value);
    const id = post["id"];
    const channel = post["channelId"];

    if (
      !isBufferId(id) ||
      (expectedId !== undefined && id !== expectedId) ||
      !isString(post["status"]) ||
      post["status"] === "" ||
      (channel !== undefined && channel !== account.accountId)
    )
      throw new HttpError("Buffer did not return the changed post.", "invalid-response", true);

    return post;
  }

  /** The outcome of a post mutation that returns the post or a MutationError. */
  function actionOutcome(
    result: JsonObject,
    ref: BufferPostRef,
    expectedId: string,
    operation: string,
    context: AdapterOperationContext,
  ): DeliveryOutcome {
    const post = result["post"];

    const account: ConnectedAccountRef = {
      kind: "connected-account",
      version: 1,
      backend: ref.backend,
      platform: ref.platform,
      accountId: ref.accountId,
    };

    if (isJsonObject(post)) return outcome(confirmedPost(post, account, expectedId), account, 0);

    const rejection = payloadRejection({ result, operation, context, kind: "mutation" });

    if (rejection) throw rejection;

    throw new SocialError({
      code: "ambiguous_outcome",
      operation,
      message: "Buffer did not confirm the change. Read the post before retrying.",
      retryDisposition: { kind: "reconcile-first" },
    });
  }

  return adapter;
}
