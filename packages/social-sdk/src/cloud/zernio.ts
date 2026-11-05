import {
  normalizeMetrics,
  normalizeComment,
  normalizeMessage,
  normalizeConversation,
} from "../core/projections.js";
import { managedLifecycle, zernioRemovablePlatforms } from "./lifecycle.js";
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
  CapabilityDeclaration,
  CommentRef,
  ConnectedAccountRef,
  ConversationRef,
  DeliveryOutcome,
  JsonObject,
  JsonValue,
  MetricValue,
  Platform,
  PlatformPostRef,
  PreparationIssue,
  PreparedPublishTarget,
  SearchPostsInput,
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
import { decodeWebhook, verifyZernioWebhook } from "../server/webhooks.js";
import {
  accountMatches,
  capabilityManifest,
  acknowledged,
  linkedinDocumentFormats,
  managedHttp,
  managedPreparation,
  managedOptionIssues,
  normalizePlatform,
  optionsObject,
  platform,
  providerPlatforms,
  publicFields,
  subredditName,
  zernioPlatform as wirePlatform,
  type ManagedOptions,
} from "./common.js";
import { zernioOutcome } from "./outcomes.js";
import {
  assignDefined,
  flagSet,
  objectList,
  optionReader,
  threadItems,
  topicTag,
  xPoll,
  type OptionReader,
  type ThreadItem,
} from "./option-checks.js";
import { httpsUrl } from "../transport/upload.js";

function inboxFields(value: JsonValue, fields: readonly string[]): JsonObject {
  const row = object(value);
  const result = { ...publicFields(row, fields) };
  const authorFields = ["id", "did", "name", "displayName", "username", "handle"];

  for (const key of ["from", "author", "sender"]) {
    if (fields.includes(key) && isJsonObject(row[key]))
      result[key] = publicFields(row[key], authorFields);
  }

  const participants = row["participants"];

  const members = isJsonArray(participants)
    ? participants
    : isJsonObject(participants) && isJsonArray(participants["data"])
      ? participants["data"]
      : undefined;

  if (fields.includes("participants") && members)
    result["participants"] = members.map((member) => publicFields(member, authorFields));

  // Attachment metadata only: Zernio's media URLs can be signed, so they are not copied.
  if (fields.includes("attachments") && isJsonArray(row["attachments"]))
    result["attachments"] = row["attachments"].map((item) =>
      publicFields(item, ["id", "type", "originalType"]),
    );

  if (fields.includes("lastMessage") && isJsonObject(row["lastMessage"]))
    result["lastMessage"] = publicFields(row["lastMessage"], [
      "id",
      "text",
      "message",
      "senderId",
      "senderName",
      "createdAt",
      "createdTime",
    ]);

  return result;
}

/** Option keys Zernio maps beyond the shared managed set (docs.zernio.com/platforms, 2026-11-04). */
const zernioOptionKeys: Partial<Record<Platform, readonly string[]>> = {
  x: [
    "quotePostId",
    "poll",
    "paidPartnership",
    "madeWithAi",
    "sensitiveMedia",
    "geoRestriction",
    "threadItems",
    "longVideo",
    "mediaTaggedUsers",
  ],
  threads: ["topicTag", "threadItems", "firstComment"],
  bluesky: ["languages", "threadItems"],
  youtube: [
    "categoryId",
    "tags",
    "playlistId",
    "containsSyntheticMedia",
    "firstComment",
    "notifySubscribers",
  ],
  pinterest: ["boardSectionId", "coverImageUrl", "coverImageKeyFrameTime"],
  reddit: [
    "flairText",
    "spoiler",
    "sendReplies",
    "forceSelf",
    "nativeVideo",
    "videoGif",
    "videoPosterUrl",
  ],
  telegram: ["parseMode", "disableWebPagePreview", "disableNotification", "protectContent"],
  discord: [
    "embeds",
    "poll",
    "crosspost",
    "forumThreadName",
    "forumAppliedTags",
    "threadFromMessage",
    "tts",
    "webhookUsername",
    "webhookAvatarUrl",
  ],
  "google-business": [
    "topicType",
    "languageCode",
    "callToActionType",
    "callToActionUrl",
    "eventTitle",
    "eventStart",
    "eventEnd",
    "offerCouponCode",
    "offerRedeemUrl",
    "offerTerms",
  ],
  tiktok: ["musicSoundId", "coverTimestampMs", "coverImageUrl"],
  instagram: [
    "placement",
    "collaborators",
    "userTags",
    "locationId",
    "trialReel",
    "thumbOffsetMs",
    "audioName",
    "audioConfiguration",
    "muteAudio",
    "aiGenerated",
    "paidPartnership",
    "brandedContentSponsors",
    "commentsEnabled",
    "firstComment",
  ],
  facebook: [
    "reel",
    "story",
    "collaborators",
    "carouselCards",
    "carouselLink",
    "geoRestriction",
    "firstComment",
    "pageId",
  ],
  linkedin: [
    "visibility",
    "documentTitle",
    "reshare",
    "disableLinkPreview",
    "poll",
    "firstComment",
  ],
};

/** Every Zernio platform also takes per-attachment `mediaOptions` and `recycling`. */
const zernioKeysWithCommon: Partial<Record<Platform, readonly string[]>> = Object.fromEntries(
  providerPlatforms.zernio.map((name) => [
    name,
    [...(zernioOptionKeys[name] ?? []), "mediaOptions", "recycling"],
  ]),
);

/** Longest text Zernio accepts for one post in a thread, by platform. */
const threadTextLimit: Partial<Record<Platform, number>> = {
  x: 25_000,
  threads: 500,
  bluesky: 3_000,
};

interface ZernioTargetData {
  readonly issues: readonly PreparationIssue[];
  /** Fields for `platforms[0].platformSpecificData`. */
  readonly native: Readonly<Record<string, JsonValue>>;
  /** Request-level fields, such as YouTube `tags`. */
  readonly root: Readonly<Record<string, JsonValue>>;
  readonly threadItems?: readonly ThreadItem[];
  /** Fields merged into each `mediaItems` entry, by position: `thumbnail` and `subtitles`. */
  readonly mediaFields: readonly JsonObject[];
}

/**
 * Decode and check the Zernio-specific options of one target. `prepareTarget` reports the issues;
 * `publishTarget` maps `native` and `root` only after they are empty.
 */
function zernioTargetData(target: PreparedPublishTarget): ZernioTargetData {
  const reader = optionReader(target, optionsObject(target));
  const { fail } = reader;
  const native: Record<string, JsonValue> = {};
  const root: Record<string, JsonValue> = {};
  const media = target.content.media ?? [];
  const singleVideo = media.length === 1 && media[0]?.kind === "video";
  const platform = target.account.platform;

  if (
    media.some((item) => item.kind === "document") &&
    (platform !== "linkedin" || media.length !== 1)
  )
    fail("media.document", "Zernio publishes one document alone, to LinkedIn only.");

  const thread =
    threadTextLimit[platform] === undefined
      ? undefined
      : threadItems(reader, threadTextLimit[platform]);

  if (platform === "x") {
    const quote = reader.text("quotePostId", "x.quote", 128);
    const poll = xPoll(reader);

    if (poll && (media.length > 0 || thread || quote))
      fail("x.poll", "An X poll cannot carry media, a thread or a quote.");

    if (quote && media.length > 0) fail("x.quote", "An X quote post cannot carry media.");

    const replySettings = reader.config["replySettings"];

    if (replySettings !== undefined && replySettings !== "everyone" && target.replyTo)
      fail("x.reply_settings", "Zernio does not combine replySettings with a reply.");

    const sensitive = flagSet(
      reader,
      "sensitiveMedia",
      ["adultContent", "graphicViolence", "other"],
      "x.sensitive_media",
    );

    const geo = reader.countries("geoRestriction", "x.geo_restriction");

    if ((sensitive || geo) && media.length === 0)
      fail("x.media_required", "sensitiveMedia and geoRestriction apply to attached media only.");

    const tagged = reader.texts("mediaTaggedUsers", "x.media_tags", { max: 10, length: 16 });

    if (tagged?.some((name) => !/^@?\w{1,15}$/.test(name)))
      fail("x.media_tags", "mediaTaggedUsers are X usernames of 1 to 15 letters, digits or _.");

    if (tagged && (media.length === 0 || media.some((item) => item.kind !== "image")))
      fail("x.media_tags", "X tags people on photos only, not video or GIF.");

    const longVideo = reader.flag("longVideo", "x.long_video");

    if (longVideo !== undefined && !media.some((item) => item.kind === "video"))
      fail("x.long_video", "longVideo applies to a video upload.");

    assignDefined(native, {
      longVideo,
      mediaTaggedUsers: tagged && [...tagged],
      quoteTweetId: quote,
      poll: poll && { options: [...poll.options], duration_minutes: poll.durationMinutes },
      paidPartnership: reader.flag("paidPartnership", "x.paid_partnership"),
      madeWithAi: reader.flag("madeWithAi", "x.made_with_ai"),
      sensitiveMedia: sensitive,
      geoRestriction: geo && { countries: [...geo] },
    });
  }

  if (platform === "threads") {
    assignDefined(native, {
      topic_tag: topicTag(reader),
      firstComment: reader.text("firstComment", "threads.first_comment", 500),
    });
  }

  if (platform === "bluesky") {
    const langs = reader.texts("languages", "bluesky.languages", { max: 3, length: 35 });

    if (langs?.some((tag) => !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(tag)))
      fail("bluesky.languages", "languages must be BCP-47 codes such as en or pt-BR.");

    assignDefined(native, { langs: langs && [...langs] });
  }

  if (platform === "youtube") {
    const categoryId = reader.text("categoryId", "youtube.category", 8);

    if (categoryId !== undefined && !/^\d+$/.test(categoryId))
      fail("youtube.category", "categoryId must be a numeric YouTube category ID.");

    const tags = reader.texts("tags", "youtube.tags", { max: 500, length: 100 });

    if (tags && tags.join("").length > 500)
      fail("youtube.tags", "YouTube tags are limited to 500 characters combined.");

    assignDefined(native, {
      categoryId,
      playlistId: reader.text("playlistId", "youtube.playlist", 64),
      containsSyntheticMedia: reader.flag("containsSyntheticMedia", "youtube.synthetic_media"),
      firstComment: reader.text("firstComment", "youtube.first_comment", 10_000),
      notifySubscribers: reader.flag("notifySubscribers", "youtube.notify_subscribers"),
    });
    assignDefined(root, { tags: tags && [...tags] });
  }

  if (platform === "tiktok") {
    const sound = reader.text("musicSoundId", "tiktok.music", 128);

    if (sound !== undefined && reader.config["draft"] === true)
      fail("tiktok.music", "TikTok ignores music on drafts.");

    if (sound !== undefined && reader.config["autoAddMusic"] === true)
      fail("tiktok.music", "Choose either musicSoundId or autoAddMusic.");

    const coverAt = reader.integer("coverTimestampMs", "tiktok.cover", 0, 36_000_000);
    const coverUrl = reader.url("coverImageUrl", "tiktok.cover");

    if ((coverAt !== undefined || coverUrl !== undefined) && !singleVideo)
      fail("tiktok.cover", "Video cover options apply to a single video only.");

    assignDefined(native, {
      musicSoundInfo: sound === undefined ? undefined : { musicSoundId: sound },
      videoCoverTimestampMs: coverAt,
      videoCoverImageUrl: coverUrl,
    });
  }

  if (platform === "instagram") instagramData(reader, target, native);

  if (platform === "facebook") facebookData(reader, target, native);

  if (platform === "linkedin") {
    const documents = media.filter((item) => item.kind === "document").length;
    const documentTitle = reader.text("documentTitle", "linkedin.document_title", 400);
    const reshare = reader.text("reshare", "linkedin.reshare", 512);
    const poll = linkedInPoll(reader);

    if (documentTitle !== undefined && documents !== 1)
      fail("linkedin.document_title", "documentTitle needs one document attachment.");

    if (reshare !== undefined && media.length > 0)
      fail("linkedin.reshare", "A LinkedIn repost cannot carry media.");

    if (poll && (media.length > 0 || reshare !== undefined))
      fail("linkedin.poll", "A LinkedIn poll cannot carry media or a repost.");

    assignDefined(native, {
      documentTitle,
      reshareUrl: reshare,
      disableLinkPreview: reader.flag("disableLinkPreview", "linkedin.link_preview"),
      poll,
      firstComment: reader.text("firstComment", "linkedin.first_comment", 1250),
    });
  }

  if (platform === "pinterest") pinterestData(reader, target, native);

  if (platform === "reddit") redditData(reader, target, native);

  if (platform === "telegram")
    assignDefined(native, {
      parseMode: choice(reader, "parseMode", "telegram.parse_mode", [
        "HTML",
        "Markdown",
        "MarkdownV2",
      ]),
      disableWebPagePreview: reader.flag("disableWebPagePreview", "telegram.options"),
      disableNotification: reader.flag("disableNotification", "telegram.options"),
      protectContent: reader.flag("protectContent", "telegram.options"),
    });

  if (platform === "discord") discordData(reader, target, native);

  if (platform === "google-business") googleBusinessData(reader, native);

  assignDefined(root, { recycling: recyclingData(reader, platform) });

  return {
    issues: reader.issues,
    native,
    root,
    mediaFields: zernioMediaFields(reader, target),
    ...definedFields({ threadItems: thread }),
  };
}

/** One of the listed strings, or an issue. */
function choice(
  reader: OptionReader,
  key: string,
  code: string,
  values: readonly string[],
): string | undefined {
  const value = reader.config[key];

  if (value === undefined) return undefined;

  if (isString(value) && values.includes(value)) return value;

  reader.fail(code, `${key} must be one of ${values.join(", ")}.`);

  return undefined;
}

/** Platforms where Zernio applies a video's custom `thumbnail`. */
const zernioThumbnailPlatforms: readonly Platform[] = ["facebook", "youtube", "linkedin"];

/**
 * Per-attachment fields: a video `thumbnail` (Facebook, YouTube, LinkedIn; `instagramThumbnail`
 * for an Instagram Reel) and `mediaOptions[].subtitles`.
 */
function zernioMediaFields(reader: OptionReader, target: PreparedPublishTarget): JsonObject[] {
  const media = target.content.media ?? [];
  const platform = target.account.platform;

  const fields = media.map((item): Record<string, JsonValue> => {
    if (item.thumbnail === undefined) return {};

    if (
      item.kind !== "video" ||
      item.thumbnail.kind !== "https-url" ||
      (platform !== "instagram" && !zernioThumbnailPlatforms.includes(platform))
    ) {
      reader.fail(
        "media.thumbnail",
        "Zernio takes a video thumbnail as a public HTTPS URL for Facebook, YouTube, LinkedIn and Instagram Reels.",
      );

      return {};
    }

    const url = httpsUrl(item.thumbnail.url).href;

    return platform === "instagram" ? { instagramThumbnail: url } : { thumbnail: url };
  });

  const options = objectList(
    reader,
    "mediaOptions",
    "media.options",
    { min: 1, max: Math.max(media.length, 1) },
    (entry) => {
      if (Object.keys(entry).some((key) => key !== "subtitles")) return undefined;

      return entry["subtitles"] === undefined ? {} : subtitleTracks(entry["subtitles"]);
    },
    "mediaOptions lists one object per attachment; Zernio maps only subtitles: 1 to 20 tracks with a public HTTPS url and a distinct BCP-47 language.",
  );

  if (reader.has("mediaOptions") && media.length === 0)
    reader.fail("media.options", "mediaOptions needs media.");

  for (const [index, entry] of (options ?? []).entries()) {
    const target = fields[index];

    if (entry["subtitles"] === undefined || target === undefined) continue;

    if (media[index]?.kind !== "video")
      reader.fail("media.options", "Subtitles apply to video attachments only.");
    else target["subtitles"] = entry["subtitles"];
  }

  return fields;
}

/** SRT or WebVTT tracks: 1 to 20, HTTPS URLs, each language once. */
function subtitleTracks(value: JsonValue): JsonObject | undefined {
  if (!isJsonArray(value) || value.length < 1 || value.length > 20) return undefined;

  const tracks: JsonObject[] = [];
  const languages = new Set<string>();

  for (const entry of value) {
    const url = isJsonObject(entry) ? entry["url"] : undefined;
    const language = isJsonObject(entry) ? entry["language"] : undefined;

    if (!isString(url) || !isString(language)) return undefined;

    if (!/^[A-Za-z]{2}(-[A-Za-z0-9]{1,8})*$/.test(language) || languages.has(language))
      return undefined;

    try {
      tracks.push({ url: httpsUrl(url).href, language });
    } catch {
      return undefined;
    }

    languages.add(language);
  }

  return { subtitles: tracks };
}

/** Platforms Zernio's RecyclingConfig excludes from reposting. */
const recyclingExcluded: readonly Platform[] = ["youtube", "tiktok"];

/** `recycling`: repost on a gap of weeks or months, with optional limits and text variations. */
function recyclingData(reader: OptionReader, platform: Platform): JsonObject | undefined {
  const value = reader.config["recycling"];

  if (value === undefined) return undefined;

  if (recyclingExcluded.includes(platform)) {
    reader.fail("recycling.platform", "Zernio does not recycle YouTube or TikTok posts.");

    return undefined;
  }

  const fail = () => {
    reader.fail(
      "recycling",
      "recycling needs an integer gap of at least 1, gapFreq week or month, ISO 8601 startDate and expireDate, an expireCount of at least 1, and 2 to 20 contentVariations.",
    );

    return undefined;
  };

  if (!isJsonObject(value)) return fail();

  const allowed = ["gap", "gapFreq", "startDate", "expireCount", "expireDate", "contentVariations"];
  const { gap, gapFreq, startDate, expireCount, expireDate, contentVariations } = value;

  const isTime = (time: JsonValue | undefined) =>
    time === undefined || (isString(time) && !Number.isNaN(Date.parse(time)));

  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    !isFiniteNumber(gap) ||
    !Number.isInteger(gap) ||
    gap < 1 ||
    (gapFreq !== undefined && gapFreq !== "week" && gapFreq !== "month") ||
    !isTime(startDate) ||
    !isTime(expireDate) ||
    (expireCount !== undefined &&
      (!isFiniteNumber(expireCount) || !Number.isInteger(expireCount) || expireCount < 1)) ||
    (contentVariations !== undefined &&
      (!isJsonArray(contentVariations) ||
        contentVariations.length < 2 ||
        contentVariations.length > 20 ||
        contentVariations.some((text) => !isString(text) || !text.trim())))
  )
    return fail();

  return {
    enabled: true,
    gap,
    ...definedFields({ gapFreq, startDate, expireCount, expireDate, contentVariations }),
  };
}

function pinterestData(
  reader: OptionReader,
  target: PreparedPublishTarget,
  native: Record<string, JsonValue>,
): void {
  const media = target.content.media ?? [];
  const video = media.some((item) => item.kind === "video");
  const section = reader.text("boardSectionId", "pinterest.board_section", 64);
  const coverUrl = reader.url("coverImageUrl", "pinterest.cover");
  const keyFrame = reader.integer("coverImageKeyFrameTime", "pinterest.cover", 0, 86_400);

  if (section !== undefined && !reader.has("boardId"))
    reader.fail("pinterest.board_section", "boardSectionId needs the boardId it belongs to.");

  if ((coverUrl !== undefined || keyFrame !== undefined) && !video)
    reader.fail("pinterest.cover", "Cover options apply to video Pins.");

  if (coverUrl !== undefined && keyFrame !== undefined)
    reader.fail("pinterest.cover", "Choose either coverImageUrl or coverImageKeyFrameTime.");

  assignDefined(native, {
    boardSectionId: section,
    coverImageUrl: coverUrl,
    coverImageKeyFrameTime: keyFrame,
  });
}

function redditData(
  reader: OptionReader,
  target: PreparedPublishTarget,
  native: Record<string, JsonValue>,
): void {
  const video = (target.content.media ?? []).some((item) => item.kind === "video");
  const nativeVideo = reader.flag("nativeVideo", "reddit.video");
  const videoGif = reader.flag("videoGif", "reddit.video");
  const poster = reader.url("videoPosterUrl", "reddit.video");

  if ((videoGif !== undefined || poster !== undefined || nativeVideo !== undefined) && !video)
    reader.fail("reddit.video", "Reddit video options need a video attachment.");

  if ((videoGif === true || poster !== undefined) && nativeVideo === false)
    reader.fail("reddit.video", "videoGif and videoPosterUrl apply to native video uploads.");

  assignDefined(native, {
    flairText: reader.text("flairText", "reddit.flair", 64),
    spoiler: reader.flag("spoiler", "reddit.spoiler"),
    sendreplies: reader.flag("sendReplies", "reddit.send_replies"),
    forceSelf: reader.flag("forceSelf", "reddit.force_self"),
    nativeVideo,
    videogif: videoGif,
    videoPosterUrl: poster,
  });
}

function discordData(
  reader: OptionReader,
  target: PreparedPublishTarget,
  native: Record<string, JsonValue>,
): void {
  const media = target.content.media ?? [];

  const embeds = objectList(
    reader,
    "embeds",
    "discord.embeds",
    { min: 1, max: 10 },
    discordEmbed,
    "embeds lists 1 to 10 Discord embeds with title up to 256 characters, description up to 4,096, an HTTPS url, an integer color and HTTPS image or thumbnail URLs.",
  );

  if (
    embeds &&
    embeds.reduce(
      (sum, embed) =>
        sum + String(embed["title"] ?? "").length + String(embed["description"] ?? "").length,
      0,
    ) > 6000
  )
    reader.fail("discord.embeds", "Embeds carry at most 6,000 characters combined.");

  const poll = discordPoll(reader);

  if (poll && media.length > 0)
    reader.fail("discord.poll", "A Discord poll cannot carry media attachments.");

  const tags = reader.texts("forumAppliedTags", "discord.forum", { max: 5, length: 32 });
  const forumName = reader.text("forumThreadName", "discord.forum", 100);

  if (tags && forumName === undefined)
    reader.fail("discord.forum", "forumAppliedTags apply to a forum post with forumThreadName.");

  const thread = reader.config["threadFromMessage"];
  let threadFromMessage: JsonObject | undefined;

  if (thread !== undefined) {
    const name = isJsonObject(thread) ? thread["name"] : undefined;
    const archive = isJsonObject(thread) ? thread["autoArchiveDuration"] : undefined;
    const slowMode = isJsonObject(thread) ? thread["rateLimitPerUser"] : undefined;

    if (
      !isJsonObject(thread) ||
      Object.keys(thread).some(
        (key) => !["name", "autoArchiveDuration", "rateLimitPerUser"].includes(key),
      ) ||
      !isString(name) ||
      name.length < 1 ||
      name.length > 100 ||
      (archive !== undefined && ![60, 1440, 4320, 10080].includes(Number(archive))) ||
      (slowMode !== undefined &&
        (!isFiniteNumber(slowMode) ||
          !Number.isInteger(slowMode) ||
          slowMode < 0 ||
          slowMode > 21600))
    )
      reader.fail(
        "discord.thread",
        "threadFromMessage needs a name of 1 to 100 characters, autoArchiveDuration of 60, 1440, 4320 or 10080 and rateLimitPerUser from 0 to 21600.",
      );
    else threadFromMessage = thread;
  }

  if (forumName !== undefined && threadFromMessage !== undefined)
    reader.fail("discord.thread", "A forum post is already a thread; drop threadFromMessage.");

  const username = reader.text("webhookUsername", "discord.webhook", 80);

  assignDefined(native, {
    embeds: embeds && [...embeds],
    poll,
    crosspost: reader.flag("crosspost", "discord.crosspost"),
    forumThreadName: forumName,
    forumAppliedTags: tags && [...tags],
    threadFromMessage,
    tts: reader.flag("tts", "discord.tts"),
    webhookUsername: username,
    webhookAvatarUrl: reader.url("webhookAvatarUrl", "discord.webhook"),
  });
}

const discordEmbedKeys = ["title", "description", "url", "color", "image", "thumbnail"];

function discordEmbed(entry: JsonObject): JsonObject | undefined {
  const { title, description, url, color, image, thumbnail } = entry;

  const imageUrl = (value: JsonValue | undefined) => {
    if (value === undefined) return true;

    if (!isJsonObject(value) || !isString(value["url"]) || Object.keys(value).length !== 1)
      return false;

    try {
      httpsUrl(value["url"]);

      return true;
    } catch {
      return false;
    }
  };

  if (
    Object.keys(entry).some((key) => !discordEmbedKeys.includes(key)) ||
    Object.keys(entry).length === 0 ||
    (title !== undefined && (!isString(title) || title.length > 256)) ||
    (description !== undefined && (!isString(description) || description.length > 4096)) ||
    (color !== undefined &&
      (!isFiniteNumber(color) || !Number.isInteger(color) || color < 0 || color > 0xffffff)) ||
    !imageUrl(image) ||
    !imageUrl(thumbnail)
  )
    return undefined;

  if (url !== undefined) {
    if (!isString(url)) return undefined;

    try {
      httpsUrl(url);
    } catch {
      return undefined;
    }
  }

  return entry;
}

/** A native Discord poll: a question, 1 to 10 answers, 1 to 768 hours. */
function discordPoll(reader: OptionReader): JsonObject | undefined {
  const value = reader.config["poll"];

  if (value === undefined) return undefined;

  const question = isJsonObject(value) ? value["question"] : undefined;
  const answers = isJsonObject(value) ? value["answers"] : undefined;
  const hours = isJsonObject(value) ? value["durationHours"] : undefined;
  const multiple = isJsonObject(value) ? value["allowMultiselect"] : undefined;

  const texts = isJsonArray(answers)
    ? answers.filter(
        (text): text is string => isString(text) && text.length >= 1 && text.length <= 55,
      )
    : [];

  if (
    !isJsonObject(value) ||
    !isString(question) ||
    question.length < 1 ||
    question.length > 300 ||
    !isJsonArray(answers) ||
    texts.length !== answers.length ||
    texts.length < 1 ||
    texts.length > 10 ||
    (hours !== undefined &&
      (!isFiniteNumber(hours) || !Number.isInteger(hours) || hours < 1 || hours > 768)) ||
    (multiple !== undefined && !isBoolean(multiple))
  ) {
    reader.fail(
      "discord.poll",
      "poll needs a question of 1 to 300 characters, 1 to 10 answers of 1 to 55 characters, durationHours from 1 to 768 and a boolean allowMultiselect.",
    );

    return undefined;
  }

  return {
    question: { text: question },
    answers: texts.map((text) => ({ poll_media: { text } })),
    ...definedFields({ duration: hours, allow_multiselect: multiple }),
  };
}

const gbpActions = ["LEARN_MORE", "BOOK", "ORDER", "SHOP", "SIGN_UP", "CALL"];

/** Google's civil date and optional time, from `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` local time. */
function googleDateTime(value: string): { date: JsonObject; time?: JsonObject } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);

  if (!match) return undefined;

  const [year, month, day, hours, minutes] = match
    .slice(1)
    .map((part) => (part === undefined ? undefined : Number(part)));

  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    (hours !== undefined && hours > 23) ||
    (minutes !== undefined && minutes > 59)
  )
    return undefined;

  return {
    date: { year, month, day },
    ...definedFields({
      time: hours === undefined || minutes === undefined ? undefined : { hours, minutes },
    }),
  };
}

/** Google Business post type, event, offer, button and language. */
function googleBusinessData(reader: OptionReader, native: Record<string, JsonValue>): void {
  const topic = choice(reader, "topicType", "google_business.topic", [
    "STANDARD",
    "EVENT",
    "OFFER",
  ]);

  const action = choice(reader, "callToActionType", "google_business.call_to_action", gbpActions);
  const actionUrl = reader.url("callToActionUrl", "google_business.call_to_action");
  const title = reader.text("eventTitle", "google_business.event", 58);
  const startText = reader.text("eventStart", "google_business.event", 16);
  const endText = reader.text("eventEnd", "google_business.event", 16);
  const start = startText === undefined ? undefined : googleDateTime(startText);
  const end = endText === undefined ? undefined : googleDateTime(endText);
  const language = reader.text("languageCode", "google_business.language", 35);

  if ((startText !== undefined && !start) || (endText !== undefined && !end))
    reader.fail(
      "google_business.event",
      "eventStart and eventEnd are YYYY-MM-DD or YYYY-MM-DDTHH:MM in the location's local time.",
    );

  if (language !== undefined && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(language))
    reader.fail("google_business.language", "languageCode is a BCP 47 code such as en or de.");

  if ((action === undefined) !== (actionUrl === undefined))
    reader.fail(
      "google_business.call_to_action",
      "callToActionType and callToActionUrl go together.",
    );

  if (topic === "EVENT" && (title === undefined || !start || !end))
    reader.fail(
      "google_business.event",
      "An EVENT post needs eventTitle, eventStart and eventEnd.",
    );

  if (topic !== "EVENT" && topic !== "OFFER" && (title ?? startText ?? endText) !== undefined)
    reader.fail("google_business.event", "Event fields apply to EVENT and OFFER posts.");

  const offer = definedFields({
    couponCode: reader.text("offerCouponCode", "google_business.offer", 58),
    redeemOnlineUrl: reader.url("offerRedeemUrl", "google_business.offer"),
    termsConditions: reader.text("offerTerms", "google_business.offer", 5000),
  });

  if (Object.keys(offer).length > 0 && topic !== "OFFER")
    reader.fail("google_business.offer", "Offer fields apply to OFFER posts.");

  assignDefined(native, {
    topicType: topic,
    languageCode: language,
    callToAction:
      action === undefined ? undefined : { type: action, ...definedFields({ url: actionUrl }) },
    event:
      title !== undefined && start && end
        ? {
            title,
            schedule: {
              startDate: start.date,
              endDate: end.date,
              ...definedFields({ startTime: start.time, endTime: end.time }),
            },
          }
        : undefined,
    offer: topic === "OFFER" ? offer : undefined,
  });
}

function linkedInPoll(reader: OptionReader): JsonObject | undefined {
  const value = reader.config["poll"];

  if (value === undefined) return undefined;

  const question = isJsonObject(value) ? value["question"] : undefined;
  const options = isJsonObject(value) ? value["options"] : undefined;
  const duration = isJsonObject(value) ? value["duration"] : undefined;

  const choices = isJsonArray(options)
    ? options.filter(
        (item): item is string => isString(item) && item.length >= 1 && item.length <= 30,
      )
    : [];

  if (
    !isString(question) ||
    question.length < 1 ||
    question.length > 140 ||
    !isJsonArray(options) ||
    choices.length !== options.length ||
    choices.length < 2 ||
    choices.length > 4 ||
    (duration !== undefined &&
      !["ONE_DAY", "THREE_DAYS", "SEVEN_DAYS", "FOURTEEN_DAYS"].includes(String(duration)))
  ) {
    reader.fail(
      "linkedin.poll",
      "poll needs a 1 to 140 character question, 2 to 4 options of 1 to 30 characters and an optional ONE_DAY, THREE_DAYS, SEVEN_DAYS or FOURTEEN_DAYS duration.",
    );

    return undefined;
  }

  return {
    question,
    options: choices,
    ...definedFields({ duration: isString(duration) ? duration : undefined }),
  };
}

function instagramData(
  reader: OptionReader,
  target: PreparedPublishTarget,
  native: Record<string, JsonValue>,
): void {
  const { fail } = reader;
  const media = target.content.media ?? [];
  const singleVideo = media.length === 1 && media[0]?.kind === "video";
  const placement = reader.config["placement"];

  if (
    placement !== undefined &&
    placement !== "feed" &&
    placement !== "story" &&
    placement !== "reels"
  )
    fail("instagram.placement", "placement must be feed, story or reels.");

  const story = placement === "story";
  // Zernio publishes a single video as a Reel and has no feed-video mode.
  const reel = !story && singleVideo;

  if (placement === "reels" && !singleVideo)
    fail("instagram.placement", "A Reel needs exactly one video.");

  if (placement === "feed" && singleVideo)
    fail(
      "instagram.placement",
      "Zernio publishes a single video as a Reel; choose reels or story.",
    );

  const collaborators = reader.texts("collaborators", "instagram.collaborators", {
    max: 3,
    length: 30,
  });

  const sponsors = reader.texts("brandedContentSponsors", "instagram.sponsors", {
    max: 2,
    length: 64,
  });

  const paidPartnership = reader.flag("paidPartnership", "instagram.paid_partnership");
  const locationId = reader.text("locationId", "instagram.location", 32);
  const firstComment = reader.text("firstComment", "instagram.first_comment", 2200);
  const trialReel = reader.config["trialReel"];

  if (locationId !== undefined && !/^\d+$/.test(locationId))
    fail(
      "instagram.location",
      "locationId must be the numeric ID of a Facebook Page with a location.",
    );

  if (trialReel !== undefined && trialReel !== "manual" && trialReel !== "performance")
    fail("instagram.trial_reel", "trialReel must be manual or performance.");

  if (
    story &&
    (collaborators ||
      sponsors ||
      paidPartnership !== undefined ||
      locationId ||
      firstComment ||
      trialReel)
  )
    fail(
      "instagram.story_options",
      "Stories take no collaborators, partnership label, location, first comment or trial Reel.",
    );

  const thumbOffset = reader.integer("thumbOffsetMs", "instagram.thumb_offset", 0, 36_000_000);
  const audioName = reader.text("audioName", "instagram.audio_name", 100);

  const audio = instagramAudio(reader);

  if (
    !reel &&
    (trialReel !== undefined ||
      thumbOffset !== undefined ||
      audioName !== undefined ||
      audio !== undefined)
  )
    fail(
      "instagram.reel_options",
      "trialReel, thumbOffsetMs, audioName and audioConfiguration apply to a Reel only.",
    );

  const muteAudio = reader.flag("muteAudio", "instagram.mute_audio");

  if (muteAudio !== undefined && !media.some((item) => item.kind === "video"))
    fail("instagram.mute_audio", "muteAudio needs a video; Zernio ignores it on images.");

  const userTags = objectList(
    reader,
    "userTags",
    "instagram.user_tags",
    { min: 1, max: 20 },
    (entry) => {
      const { username, x, y, mediaIndex } = entry;
      const index = mediaIndex ?? 0;

      if (!isString(username) || username.trim() === "") return undefined;

      if (!isFiniteNumber(index) || !Number.isInteger(index) || index < 0 || index >= media.length)
        return undefined;

      const point = [x, y].filter((value) => value !== undefined);

      if (
        point.length === 1 ||
        point.some((value) => !isFiniteNumber(value) || value < 0 || value > 1)
      )
        return undefined;

      // Images need a position; Reels and videos ignore it.
      if (!story && media[index]?.kind === "image" && point.length === 0) return undefined;

      return { username, ...definedFields({ x, y, mediaIndex }) };
    },
    "userTags lists up to 20 usernames, each on an existing media index, with x and y from 0 to 1 (required on images).",
  );

  assignDefined(native, {
    contentType: story ? "story" : undefined,
    collaborators: collaborators && [...collaborators],
    userTags: userTags && [...userTags],
    locationId,
    trialParams:
      trialReel === "manual"
        ? { graduationStrategy: "MANUAL" }
        : trialReel === "performance"
          ? { graduationStrategy: "SS_PERFORMANCE" }
          : undefined,
    thumbOffset,
    audioName,
    audioConfiguration: audio,
    muteAudio,
    isAiGenerated: reader.flag("aiGenerated", "instagram.ai_generated"),
    isPaidPartnership: paidPartnership,
    brandedContentSponsors: sponsors && [...sponsors],
    commentsEnabled: reader.flag("commentsEnabled", "instagram.comments_enabled"),
    firstComment,
  });
}

const instagramAudioKeys = ["audioId", "audioVolume", "videoVolume"];

/** `audioConfiguration`: a catalog track from `instagram/audio`, with optional 0-100 volumes. */
function instagramAudio(reader: OptionReader): JsonObject | undefined {
  const value = reader.config["audioConfiguration"];

  if (value === undefined) return undefined;

  const isVolume = (volume: JsonValue | undefined) =>
    volume === undefined ||
    (isFiniteNumber(volume) && Number.isInteger(volume) && volume >= 0 && volume <= 100);

  const { audioId, audioVolume, videoVolume } = isJsonObject(value) ? value : {};

  if (
    !isJsonObject(value) ||
    Object.keys(value).some((key) => !instagramAudioKeys.includes(key)) ||
    !isString(audioId) ||
    audioId.trim() === "" ||
    !isVolume(audioVolume) ||
    !isVolume(videoVolume)
  ) {
    reader.fail(
      "instagram.audio_configuration",
      "audioConfiguration needs an audioId from the Instagram audio search and optional integer audioVolume and videoVolume from 0 to 100.",
    );

    return undefined;
  }

  return { audioId, ...definedFields({ audioVolume, videoVolume }) };
}

function facebookData(
  reader: OptionReader,
  target: PreparedPublishTarget,
  native: Record<string, JsonValue>,
): void {
  const { fail } = reader;
  const media = target.content.media ?? [];
  const reel = reader.flag("reel", "facebook.reel");
  const story = reader.flag("story", "facebook.story");

  if (reel && story) fail("facebook.placement", "Choose either reel or story.");

  if (reel && (media.length !== 1 || media[0]?.kind !== "video"))
    fail("facebook.reel", "A Facebook Reel needs exactly one video.");

  if (story && media.length === 0) fail("facebook.story", "A Facebook Story needs media.");

  const collaborators = reader.texts("collaborators", "facebook.collaborators", {
    max: 10,
    length: 32,
  });

  if (collaborators && (!reel || collaborators.some((id) => !/^\d+$/.test(id))))
    fail("facebook.collaborators", "Reel collaborators are numeric Page IDs on a Reel.");

  const pageId = reader.text("pageId", "facebook.page", 32);

  if (pageId !== undefined && !/^\d+$/.test(pageId))
    fail("facebook.page", "pageId is a numeric Page ID from listFacebookPages.");

  assignDefined(native, { pageId });

  const cards = objectList(
    reader,
    "carouselCards",
    "facebook.carousel",
    { min: 2, max: 10 },
    (entry) => {
      const { link, name, description } = entry;

      if (
        !isString(link) ||
        Object.keys(entry).some((key) => !["link", "name", "description"].includes(key))
      )
        return undefined;

      for (const value of [name, description])
        if (value !== undefined && (!isString(value) || value.length > 255)) return undefined;

      try {
        return { link: httpsUrl(link).href, ...definedFields({ name, description }) };
      } catch {
        return undefined;
      }
    },
    "carouselCards lists 2 to 10 cards with a public HTTPS link and optional name and description up to 255 characters.",
  );

  const carouselLink = reader.url("carouselLink", "facebook.carousel");

  if (
    cards &&
    (reel || story || cards.length !== media.length || media.some((item) => item.kind !== "image"))
  )
    fail(
      "facebook.carousel",
      "A link carousel has one card per image and no other media or placement.",
    );

  if (carouselLink !== undefined && !cards)
    fail("facebook.carousel", "carouselLink needs carouselCards.");

  const geo = reader.countries("geoRestriction", "facebook.geo_restriction");
  const firstComment = reader.text("firstComment", "facebook.first_comment", 8000);

  if (story && (geo || firstComment))
    fail("facebook.story_options", "Stories take no geoRestriction or first comment.");

  assignDefined(native, {
    contentType: reel ? "reel" : story ? "story" : undefined,
    collaborators: collaborators && [...collaborators],
    facebookSettings: cards && {
      carouselCards: [...cards],
      ...definedFields({ carouselLink }),
    },
    geoRestriction: geo && { countries: [...geo] },
    firstComment,
  });
}

const zernioOperations = [
  "accounts.read",
  "posts.publish",
  "posts.schedule",
  "posts.read",
  "posts.list",
  "posts.status",
  "posts.cancelScheduled",
  "posts.deleteBackendRecord",
  "analytics.read",
  "analytics.account.read",
  "media.upload",
  "webhooks.verify",
] as const;

/**
 * How a native `submitPost` reaches Zernio. `draft` saves an unpublished draft, `approval`
 * creates a `pending_approval` post that publishes only after `reviewPost` approves it, and
 * `queue` takes the profile's next free queue slot.
 */
export type ZernioSubmission =
  | { readonly kind: "publish" }
  | { readonly kind: "draft" }
  | { readonly kind: "approval"; readonly at: string; readonly timeZone?: string }
  | { readonly kind: "queue"; readonly profileId: string; readonly queueId?: string };

/** Platforms whose published text Zernio edits (docs.zernio.com/posts/edit-post, 2026-11-04). */
const zernioEditablePlatforms: readonly string[] = [
  "x",
  "discord",
  "facebook",
  "reddit",
  "linkedin",
  "telegram",
  "pinterest",
  "google-business",
  "youtube",
];

function submissionFields(target: PreparedPublishTarget, submission: ZernioSubmission) {
  switch (submission.kind) {
    case "publish":
      return target.schedule
        ? {
            scheduledFor: target.schedule.at,
            ...definedFields({ timezone: target.schedule.timeZone || undefined }),
          }
        : { publishNow: true };
    case "draft":
      return { isDraft: true };
    case "approval":
      return {
        requiresApproval: true,
        scheduledFor: submission.at,
        ...definedFields({ timezone: submission.timeZone || undefined }),
      };
    case "queue":
      return {
        queuedFromProfile: submission.profileId,
        ...definedFields({ queueId: submission.queueId || undefined }),
      };
    default: {
      const exhaustive: never = submission;

      return exhaustive;
    }
  }
}

/** Comment inboxes Zernio documents (docs.zernio.com/comments, 2026-11-04). TikTok means Business accounts. */
const zernioCommentPlatforms: readonly string[] = [
  "x",
  "threads",
  "bluesky",
  "youtube",
  "instagram",
  "linkedin",
  "facebook",
  "reddit",
  "tiktok",
];

/** Direct-message inboxes Zernio documents for the platforms this SDK publishes to. */
const zernioMessagePlatforms: readonly string[] = [
  "x",
  "bluesky",
  "instagram",
  "facebook",
  "reddit",
  "telegram",
];

const zernioHidePlatforms: readonly string[] = ["facebook", "instagram", "threads", "x", "tiktok"];

const zernioCommentDeletePlatforms: readonly string[] = [
  "facebook",
  "instagram",
  "threads",
  "linkedin",
  "reddit",
  "bluesky",
  "x",
  "youtube",
  "tiktok",
];

const zernioLikePlatforms: readonly string[] = ["linkedin", "x", "facebook", "youtube", "bluesky"];

const zernioMentionPlatforms: readonly string[] = ["linkedin", "instagram", "facebook"];

const declare = (
  platforms: readonly string[],
  operation: string,
  notes: string,
): CapabilityDeclaration[] =>
  platforms.map((platform) => ({
    platform,
    operation,
    availability: "available",
    surface: operation === "search.posts" ? "normalized" : "native",
    notes,
  }));

const nativeDeclarations: readonly CapabilityDeclaration[] = [
  ...declare(["x"], "search.posts", "Recent X posts from the last seven days through Zernio."),
  ...declare(
    ["facebook", "instagram", "reddit", "tiktok"],
    "comments.replies.read",
    "Native access: listCommentReplies.",
  ),
  ...declare(
    zernioHidePlatforms,
    "comments.moderate",
    "Native access: moderateComment hides or unhides.",
  ),
  ...declare(zernioCommentDeletePlatforms, "comments.delete", "Native access: deleteComment."),
  ...declare(
    zernioLikePlatforms,
    "likes.write",
    "Native access: likePost, unlikePost, likeComment and unlikeComment.",
  ),
  ...declare(["x"], "posts.repost", "Native access: repost and unrepost."),
  ...declare(["x"], "bookmarks.write", "Native access: bookmark and removeBookmark."),
  ...declare(["x"], "follows.write", "Native access: follow and unfollow by X user ID."),
  ...declare(zernioMentionPlatforms, "mentions.read", "Native access: listMentions."),
];

const invalid = (operation: string, message: string): never => {
  throw new SocialError({ code: "invalid_input", operation, message });
};

const unconfirmed = (operation: string): never => {
  throw new SocialError({
    code: "ambiguous_outcome",
    operation,
    message: "Zernio did not confirm the change. Reconcile before retrying.",
    retryDisposition: { kind: "reconcile-first" },
  });
};

/**
 * `platforms[].errorCategory` values Zernio documents (openapi.yaml 1.501.1, read 2026-11-05:
 * https://zernio.com/openapi.yaml). Anything else is reported as `upstream_failure`.
 */
const zernioErrorCategories: readonly string[] = [
  "auth_expired",
  "user_content",
  "user_abuse",
  "account_issue",
  "platform_rejected",
  "platform_error",
  "platform_rate_limit",
  "quota_exhausted",
  "system_error",
  "unknown",
];

/**
 * `zernioOutcome` with its provider strings checked: a failed destination keeps only a
 * documented error category as its code, and the backend state only a lowercase status token,
 * so no provider text reaches the outcome.
 */
function zernioDeliveryOutcome(
  value: JsonValue,
  context: Parameters<typeof zernioOutcome>[1],
): DeliveryOutcome {
  const outcome = zernioOutcome(value, context);

  const backendState =
    outcome.backendState === undefined || /^[a-z_]{1,32}$/.test(outcome.backendState)
      ? outcome.backendState
      : "unrecognized";

  const checked = { ...outcome, ...definedFields({ backendState }) };

  return checked.state === "failed" && !zernioErrorCategories.includes(checked.code)
    ? { ...checked, code: "upstream_failure" }
    : checked;
}

/**
 * Wrap the client for the shared post lifecycle (cancel, unpublish, delete record). A dispatched
 * write whose 2xx answer is not a JSON object cannot be confirmed, so it is `ambiguous_outcome`
 * instead of an undecodable-response error.
 */
function lifecycleRequest(request: ReturnType<typeof managedHttp>): ReturnType<typeof managedHttp> {
  return async (...args) => {
    const [, , body, , method] = args;
    const answer = await request(...args);
    const write = (method ?? (body === undefined ? "GET" : "POST")) !== "GET";

    return write && !isJsonObject(answer) ? unconfirmed("posts.lifecycle") : answer;
  };
}

/** The HTTP client, account decoder and post builder that `zernio` and `zernioNative` share. */
/**
 * One client per options object, so `zernio(options)` and `zernioNative(options)` share the
 * request pipeline and the default media store: a media ref uploaded through the normalized
 * adapter stays usable in native submissions, as it was before the helpers moved to a subpath.
 */
const zernioClients = new WeakMap<ManagedOptions, ReturnType<typeof createZernioClient>>();

/** The post text and `platformSpecificData` that one Zernio target sends. */
interface ZernioWirePost {
  readonly content: string;
  readonly native: JsonObject;
}

/**
 * The text and `platformSpecificData` Zernio receives for one target, shared by publishing
 * and the dry-run validators so both see the same post. `media` holds the wire media items.
 */
function zernioWirePost(
  target: PreparedPublishTarget,
  data: ZernioTargetData,
  media: readonly JsonObject[],
): ZernioWirePost {
  const config = optionsObject(target);
  const native = { ...data.native };

  if (data.threadItems)
    native["threadItems"] = [
      {
        content: target.content.text ?? "",
        ...definedFields({ mediaItems: media.length > 0 ? media : undefined }),
      },
      ...data.threadItems.map((item) => ({
        ...definedFields({
          content: item.text,
          mediaItems:
            item.media.length > 0
              ? item.media.map((entry) => ({
                  type: entry.kind,
                  url: entry.url,
                  ...definedFields({ altText: entry.altText }),
                }))
              : undefined,
        }),
      })),
    ];

  if (target.account.platform === "youtube") {
    // Preparation requires these before a publish; a validator sends what it was given.
    for (const key of ["title", "visibility"] as const) {
      const value = optionalString(config[key]);

      if (value !== undefined) native[key] = value;
    }

    const madeForKids = config["madeForKids"];

    if (isBoolean(madeForKids)) native["madeForKids"] = madeForKids;
  }

  const shareToFeed = config["shareToFeed"];

  if (target.account.platform === "instagram" && isBoolean(shareToFeed))
    native["shareToFeed"] = shareToFeed;

  if (
    target.account.platform === "x" &&
    config["replySettings"] !== undefined &&
    config["replySettings"] !== "everyone"
  )
    native["replySettings"] = string(config["replySettings"]);

  // prepareTarget admits only platform-post replies on X (managedReplySupported).
  if (target.account.platform === "x" && target.replyTo?.kind === "platform-post")
    native["replyToTweetId"] = target.replyTo.postId;

  if (target.account.platform === "tiktok") {
    const video = media.length === 1 && media[0]?.["type"] === "video";
    const photo = media.length > 0 && media.every((item) => item["type"] === "image");
    const privacy = optionalString(config["privacy"]);

    if (privacy !== undefined) native["privacyLevel"] = privacy;
    native["contentPreviewConfirmed"] = true;
    native["expressConsentGiven"] = true;

    if (video) native["autoAddMusic"] = false;
    else if (photo)
      native["autoAddMusic"] = isBoolean(config["autoAddMusic"]) ? config["autoAddMusic"] : false;
    native["allowDuet"] = !config["disableDuet"];
    native["allowStitch"] = !config["disableStitch"];

    // prepareTarget requires these TikTok choices to be booleans. Skipping an
    // absent value sends the same JSON body, since serialization drops undefined.
    for (const [nativeKey, optionKey] of [
      ["isBrandOrganicPost", "ownBrand"],
      ["videoMadeWithAi", "aiGenerated"],
      ["draft", "draft"],
    ] as const) {
      const value = config[optionKey];

      if (value !== undefined) native[nativeKey] = value;
    }

    const { photoCoverIndex, disableComments, brandedContent, description, mediaType } = config;

    if (isFiniteNumber(photoCoverIndex)) native["photoCoverIndex"] = photoCoverIndex;

    if (isBoolean(disableComments)) native["allowComment"] = !disableComments;

    if (isBoolean(brandedContent)) native["brandPartnerPromote"] = brandedContent;

    // Zernio's single disclosure type; both booleans above still disclose both kinds at once.
    native["commercialContentType"] =
      brandedContent === true
        ? "brand_content"
        : config["ownBrand"] === true
          ? "brand_organic"
          : "none";

    if (photo && (isString(description) || target.content.text !== undefined))
      native["description"] = description ?? target.content.text ?? "";

    if (photo && mediaType === "photo") native["mediaType"] = "photo";
  }

  if (target.account.platform === "pinterest")
    for (const key of ["boardId", "title", "link"] as const) {
      const value = optionalString(config[key]);

      if (value !== undefined) native[key] = value;
    }

  if (target.account.platform === "reddit") {
    const subreddit = optionalString(config["subreddit"]);

    if (subreddit !== undefined) native["subreddit"] = subredditName(subreddit);

    for (const key of ["title", "flairId"] as const) {
      const value = optionalString(config[key]);

      if (value !== undefined) native[key] = value;
    }

    if (isBoolean(config["nsfw"])) native["nsfw"] = config["nsfw"];
  }

  const channelId = optionalString(config["channelId"]);

  if (target.account.platform === "discord" && channelId !== undefined)
    native["channelId"] = channelId;

  if (target.account.platform === "google-business") {
    const locationId = optionalString(config["locationId"]);

    if (locationId !== undefined) native["locationId"] = locationId;
  }

  if (target.account.platform === "snapchat") {
    const contentType = optionalString(config["contentType"]);

    if (contentType !== undefined) native["contentType"] = contentType;
  }

  const tiktokPhoto =
    target.account.platform === "tiktok" &&
    media.length > 0 &&
    media.every((item) => item["type"] === "image");

  const tiktokTitle = tiktokPhoto ? optionalString(config["title"]) : undefined;

  return { content: tiktokTitle ?? target.content.text ?? "", native };
}

/** Zernio's preparation checks for one target, shared by `posts.publish` and native submissions. */
function zernioTargetIssues(target: PreparedPublishTarget): PreparationIssue[] {
  const config = optionsObject(target);

  // A LinkedIn reshare without commentary publishes as a text-free repost.
  const reshare = target.account.platform === "linkedin" && config["reshare"] !== undefined;

  const issues = [
    ...managedPreparation(target, "zernio").filter(
      (issue) => !reshare || issue.code !== "content.empty",
    ),
    ...managedOptionIssues(target, "zernio", zernioKeysWithCommon),
    ...zernioTargetData(target).issues,
  ];

  if (target.account.platform === "threads" && config["replyControl"] !== undefined)
    issues.push({
      code: "threads.reply_control_unsupported",
      message: "Zernio's documented create-post schema does not expose this reply-control option.",
      severity: "error",
      targetIndex: target.targetIndex,
    });

  if (target.account.platform === "linkedin" && config["visibility"] === "connections")
    issues.push({
      code: "linkedin.visibility_unsupported",
      message: "This managed adapter cannot guarantee connections-only visibility.",
      severity: "error",
      targetIndex: target.targetIndex,
    });

  return issues;
}

function zernioClient(options: ManagedOptions) {
  const existing = zernioClients.get(options);

  if (existing !== undefined) return existing;

  const client = createZernioClient(options);

  zernioClients.set(options, client);

  return client;
}

function createZernioClient(options: ManagedOptions) {
  const request = managedHttp("https://zernio.com/api", options);

  const mediaPipeline = managedMedia("zernio", options, (body, context) =>
    request("/v1/media/presign", context, body),
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
        platform: platform(row["platform"], options),
        accountId: string(row["_id"]),
      },
      displayName: optionalString(row["displayName"]) ?? handle ?? string(row["_id"]),
      ...definedFields({ handle: handle || undefined }),
      status:
        row["isActive"] === true
          ? "connected"
          : row["isActive"] === false
            ? "reconnect-required"
            : "unknown",
    };
  };

  /** Create one Zernio post for one prepared target, published, scheduled, drafted, queued or held for approval. */
  const createPost = async (
    target: PreparedPublishTarget,
    context: AdapterOperationContext,
    submission: ZernioSubmission,
  ): Promise<DeliveryOutcome> => {
    accountMatches(target.account, context);
    const media: JsonObject[] = [];

    const data = zernioTargetData(target);

    for (const [index, item] of (target.content.media ?? []).entries())
      media.push({
        type: item.kind,
        url: await mediaPipeline.resolve(item, target.account, context),
        ...definedFields({ altText: item.altText, mimeType: item.mimeType }),
        ...data.mediaFields[index],
      });

    if (data.issues.length > 0)
      throw new SocialError({
        code: "invalid_input",
        operation: "posts.publish",
        message: "Publish options failed preparation; call prepare to list the issues.",
      });

    const wire = zernioWirePost(target, data, media);

    try {
      const sent = request("/v1/posts", context, {
        content: wire.content,
        mediaItems: media,
        ...data.root,
        platforms: [
          {
            platform: wirePlatform(target.account.platform),
            accountId: target.account.accountId,
            ...definedFields({
              platformSpecificData: Object.keys(wire.native).length ? wire.native : undefined,
            }),
          },
        ],
        ...submissionFields(target, submission),
      });

      return await acknowledged("posts.publish", sent, (response) =>
        zernioDeliveryOutcome(response, {
          account: target.account,
          targetIndex: target.targetIndex,
          observedAt: now(),
        }),
      );
    } catch (error) {
      const existingPostId =
        error instanceof SocialError ? error.details?.["existingPostId"] : undefined;

      if (
        !(error instanceof SocialError) ||
        error.code !== "idempotency_conflict" ||
        !isString(existingPostId) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(existingPostId)
      )
        throw error;

      return {
        state: "failed",
        code: error.code,
        message: error.message,
        retryDisposition: error.retryDisposition,
        targetIndex: target.targetIndex,
        account: target.account,
        observedAt: now(),
        delivery: {
          kind: "delivery",
          version: 1,
          backend: target.account.backend,
          platform: target.account.platform,
          accountId: target.account.accountId,
          deliveryId: existingPostId,
        },
      };
    }
  };

  return { request, mediaPipeline, now, account, createPost };
}

/**
 * Internal: what `zernio-native.ts` shares with this adapter, so native calls send the same
 * requests, build posts the same way and raise the same errors. Not a supported API; it can
 * change in any release.
 */
export const zernioInternals = {
  client: zernioClient,
  targetData: zernioTargetData,
  targetIssues: zernioTargetIssues,
  wirePost: zernioWirePost,
  inboxFields,
  invalid,
  unconfirmed,
  deliveryOutcome: zernioDeliveryOutcome,
  editablePlatforms: zernioEditablePlatforms,
  hidePlatforms: zernioHidePlatforms,
  commentDeletePlatforms: zernioCommentDeletePlatforms,
  likePlatforms: zernioLikePlatforms,
  mentionPlatforms: zernioMentionPlatforms,
};

export function zernio(options: ManagedOptions) {
  const { request, mediaPipeline, now, account, createPost } = zernioClient(options);

  const supportedAccount = (value: JsonValue, backend: string): AccountRecord | undefined => {
    try {
      return account(value, backend);
    } catch (error) {
      if (error instanceof SocialError && error.code === "unsupported_capability") return undefined;
      throw error;
    }
  };

  /** The list endpoint is paginated, so keep reading until the account appears. */
  const findAccount = async (
    ref: Pick<ConnectedAccountRef, "platform" | "accountId">,
    context: AdapterOperationContext,
  ): Promise<JsonObject | undefined> => {
    for (let page = 1; page <= 100; page++) {
      const response = object(
        await request("/v1/accounts", context, undefined, {
          platform: wirePlatform(ref.platform),
          page: String(page),
          limit: "100",
        }),
      );

      const found = array(response["accounts"])
        .map(object)
        .find(
          (item) =>
            item["_id"] === ref.accountId &&
            isString(item["platform"]) &&
            normalizePlatform(item["platform"]) === ref.platform,
        );

      if (found) return found;

      const pagination = response["pagination"] ? object(response["pagination"]) : {};

      const pages = optionalNumber(pagination["pages"]) ?? optionalNumber(pagination["totalPages"]);

      if (pages === undefined || page >= pages) return undefined;
    }

    return undefined;
  };

  const analytics = async (ref: PlatformPostRef, context: AdapterOperationContext) => {
    accountMatches(ref, context);

    return object(
      await request("/v1/analytics", context, undefined, {
        postId: ref.postId,
        accountId: ref.accountId,
        platform: wirePlatform(ref.platform),
      }),
    );
  };

  return defineAdapter({
    id: "zernio",
    capabilities: {
      ...capabilityManifest(
        "zernio",
        "v1 / OpenAPI 1.25.1",
        zernioOperations,
        linkedinDocumentFormats,
      ),
      capabilities: [
        ...capabilityManifest("zernio", "1.25.1", zernioOperations, linkedinDocumentFormats)
          .capabilities,
        {
          platform: "*",
          operation: "raw.request",
          availability: "available" as const,
          surface: "native" as const,
          notes:
            "zernioNative(options).request sends one request to zernio.com/api with the API key. It never retries, adds idempotency keys or reconciles writes.",
        },
        ...zernioRemovablePlatforms.map((platform) => {
          const declaration = {
            platform,
            operation: "posts.removeFromPlatform",
            availability: "available" as const,
          };

          if (platform === "facebook")
            return {
              ...declaration,
              notes: "Zernio removes Facebook Page posts; personal profiles are not supported.",
            };

          return declaration;
        }),
        ...zernioEditablePlatforms.map((platform) => ({
          platform,
          operation: "posts.update",
          availability: "available" as const,
          surface: "native" as const,
          notes:
            "Native access: updatePost edits published text (X assigns a new post ID); reschedulePost changes a draft, scheduled, failed or cancelled post.",
        })),
        {
          platform: "tiktok",
          operation: "posts.publish.preflight",
          availability: "available" as const,
          surface: "native" as const,
          notes: "Native access: creatorInfo returns the privacy levels and posting state.",
        },
        ...zernioCommentPlatforms.flatMap((platform) =>
          ["comments.read", "comments.write"].map((operation) => {
            const declaration = {
              platform,
              operation,
              availability: "available" as const,
            };

            if (platform === "facebook")
              return {
                ...declaration,
                notes:
                  "Zernio's Facebook inbox is Page-scoped; personal profiles are not supported.",
              };

            return declaration;
          }),
        ),
        ...zernioMessagePlatforms.flatMap((platform) =>
          ["messages.read", "messages.write"].map((operation) => ({
            platform,
            operation,
            availability: "available" as const,
            notes:
              platform === "facebook"
                ? "Zernio's Facebook messaging is Page-scoped; recipient permissions and reply-window eligibility remain upstream constraints."
                : "Recipient permissions and reply-window eligibility remain upstream constraints.",
          })),
        ),
        ...nativeDeclarations,
      ],
    },
    media: { upload: mediaPipeline.upload },
    accounts: {
      async list(input: { cursor?: string; limit?: number }, context: AdapterOperationContext) {
        const page = input.cursor === undefined ? 1 : Number(input.cursor);
        const limit = input.limit ?? 25;

        if (
          !Number.isSafeInteger(page) ||
          page < 1 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "accounts.read",
            message: "Use a returned cursor and page size from 1 to 100.",
          });

        const result = object(
          await request("/v1/accounts", context, undefined, {
            page: String(page),
            limit: String(limit),
          }),
        );

        const pagination = result["pagination"] ? object(result["pagination"]) : {};

        const pages =
          optionalNumber(pagination["pages"]) ?? optionalNumber(pagination["totalPages"]);

        return {
          items: array(result["accounts"]).flatMap((value) => {
            const parsed = supportedAccount(value, context.backendInstance);

            return parsed ? [parsed] : [];
          }),
          ...definedFields({
            nextCursor: pages !== undefined && page < pages ? String(page + 1) : undefined,
          }),
        };
      },
      async get(ref: ConnectedAccountRef, context: AdapterOperationContext) {
        accountMatches(ref, context);

        const raw = await findAccount(ref, context);

        if (!raw)
          throw new SocialError({
            code: "not_found",
            operation: "accounts.read",
            message: "Provider account was not found.",
          });

        const result = account(raw, context.backendInstance);

        if (result.ref.accountId !== ref.accountId || result.ref.platform !== ref.platform)
          throw new SocialError({
            code: "unauthorized",
            operation: "accounts.read",
            message: "Provider account does not match the requested reference.",
          });

        return result;
      },
    },
    posts: {
      ...managedLifecycle("zernio", lifecycleRequest(request), now),
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        accountMatches(account, context);
        const page = input.cursor === undefined ? 1 : Number(input.cursor);
        const limit = input.limit ?? 25;

        if (
          !Number.isSafeInteger(page) ||
          page < 1 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 500
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.read",
            message: "Zernio post page requires a returned page cursor and a size from 1 to 500.",
          });

        const result = object(
          await request("/v1/posts", context, undefined, {
            page: String(page),
            limit: String(limit),
            source: "external",
            accountId: account.accountId,
            platform: wirePlatform(account.platform),
          }),
        );

        const rows = array(result["posts"])
          .map(object)
          .flatMap((row): JsonObject[] => {
            const destinations = isJsonArray(row["platforms"])
              ? array(row["platforms"]).map(object)
              : [];

            const destination = destinations.find((item) => {
              const value = item["accountId"];

              const id = isString(value)
                ? value
                : isJsonObject(value) || isJsonArray(value)
                  ? object(value)["_id"]
                  : undefined;

              return (
                id === account.accountId &&
                (item["platform"] === account.platform ||
                  item["platform"] === wirePlatform(account.platform))
              );
            });

            if (destination === undefined) return [];

            return [
              {
                ...definedFields({
                  backendPostId: optionalString(row["_id"]),
                  platformPostId: optionalString(destination["platformPostId"]),
                }),
                platform: account.platform,
                accountId: account.accountId,
                ...definedFields({
                  platformPostUrl: optionalString(destination["platformPostUrl"]),
                  publishedAt: optionalString(destination["publishedAt"]),
                }),
                ...publicFields(row, [
                  "content",
                  "caption",
                  "createdAt",
                  "status",
                  "isExternal",
                  "syncStatus",
                ]),
              },
            ];
          });

        const pagination = result["pagination"] === undefined ? {} : object(result["pagination"]);

        const totalPages =
          optionalNumber(pagination["pages"]) ?? optionalNumber(pagination["totalPages"]);

        return {
          items: rows,
          ...definedFields({
            nextCursor:
              totalPages !== undefined && page < totalPages ? String(page + 1) : undefined,
          }),
        };
      },
      prepareTarget(target: PreparedPublishTarget) {
        return zernioTargetIssues(target);
      },
      async publishTarget(
        target: PreparedPublishTarget,
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        return createPost(target, context, { kind: "publish" });
      },
      async getDelivery(
        ref: { backend: string; platform: string; accountId: string; deliveryId: string },
        context: AdapterOperationContext,
      ) {
        accountMatches(ref, context);
        const response = await request(`/v1/posts/${encodeURIComponent(ref.deliveryId)}`, context);

        return zernioDeliveryOutcome(response, {
          account: {
            kind: "connected-account",
            version: 1,
            backend: ref.backend,
            platform: ref.platform,
            accountId: ref.accountId,
          },
          targetIndex: 0,
          observedAt: now(),
        });
      },
      async get(ref: PlatformPostRef, context: AdapterOperationContext) {
        return publicFields(await analytics(ref, context), [
          "postId",
          "content",
          "publishedAt",
          "platform",
          "platformPostUrl",
          "isExternal",
          "syncStatus",
        ]);
      },
    },
    analytics: {
      async getAccountMetrics(
        ref: ConnectedAccountRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        accountMatches(ref, context);

        // Zernio documents followersCount on GET /v1/accounts (when the
        // analytics add-on is enabled); there is no accountId-specific GET.
        const row = await findAccount(ref, context);

        if (!row)
          throw new SocialError({
            code: "unauthorized",
            operation: "analytics.account.read",
            message: "Provider account does not match the requested reference.",
          });
        const followers = optionalNumber(row["followersCount"]);

        if (followers === undefined) return [];
        const measuredAt = optionalString(row["followersLastUpdated"]);

        return normalizeMetrics([
          {
            name: "followers",
            value: followers,
            unit: "count",
            period: "lifetime",
            ...(measuredAt
              ? { measuredAt, freshness: "reported" as const }
              : { freshness: "unknown" as const }),
            fetchedAt: now(),
            source: `zernio:${ref.platform}:account`,
          },
        ]);
      },
      async getPostMetrics(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        const result = await analytics(ref, context);

        if (result["syncStatus"] === "unavailable" || result["analytics"] === undefined) return [];
        const source = object(result["analytics"]);
        const measuredAt = optionalString(source["lastUpdated"]);
        // Do not label request time as measurement time when upstream freshness is absent.
        const metrics: MetricValue[] = [];

        for (const name of [
          "impressions",
          "reach",
          "likes",
          "comments",
          "shares",
          "saves",
          "clicks",
          "views",
          "follows",
          "reposts",
        ]) {
          const value = optionalNumber(source[name]);

          if (value !== undefined)
            metrics.push({
              name,
              value,
              unit: "count",
              period: "lifetime",
              ...(measuredAt ? { measuredAt, freshness: "reported" } : { freshness: "unknown" }),
              fetchedAt: now(),
              source: `zernio:${ref.platform}`,
            });
        }

        return normalizeMetrics(metrics);
      },
    },
    comments: {
      async list(
        ref: PlatformPostRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        accountMatches(ref, context);
        const limit = input.limit ?? 25;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.read",
            message: "Zernio comment page size must be between 1 and 100.",
          });

        const result = object(
          await request(
            `/v1/inbox/comments/${encodeURIComponent(ref.postId)}`,
            context,
            undefined,
            {
              accountId: ref.accountId,
              limit: String(limit),
              ...definedFields({ cursor: input.cursor }),
            },
          ),
        );

        const pagination = result["pagination"] ? object(result["pagination"]) : {};
        const cursor = optionalString(pagination["cursor"]);
        const hasMore = pagination["hasMore"];

        return {
          items: array(result["comments"]).map((entry) =>
            normalizeComment(
              inboxFields(entry, [
                "id",
                "message",
                "from",
                "author",
                "authorId",
                "authorHandle",
                "authorName",
                "createdTime",
                "likeCount",
                "replyCount",
                "parentId",
                "rootUri",
                "rootCid",
                "cid",
                "canReply",
                "canDelete",
                "canHide",
              ]),
            ),
          ),
          ...definedFields({ nextCursor: hasMore === false || !cursor ? undefined : cursor }),
        };
      },
      async reply(
        ref: CommentRef,
        content: { text: string },
        context: AdapterOperationContext,
      ): Promise<CommentRef> {
        accountMatches(ref, context);

        return acknowledged(
          "comments.write",
          request(`/v1/inbox/comments/${encodeURIComponent(ref.postId)}`, context, {
            accountId: ref.accountId,
            message: content.text,
            commentId: ref.commentId,
          }),
          (body) => {
            const result = object(body);

            if (result["success"] !== true) unconfirmed("comments.write");

            return { ...ref, commentId: string(object(result["data"])["commentId"]) };
          },
        );
      },
    },
    search: {
      /** Recent X posts (last seven days) through GET /v1/twitter/search. */
      async posts(
        ref: ConnectedAccountRef,
        input: SearchPostsInput,
        context: AdapterOperationContext,
      ) {
        accountMatches(ref, context);
        const limit = input.limit ?? 10;

        if (ref.platform !== "x") invalid("search.posts", "Zernio searches X posts only.");

        if (input.scope === "all")
          invalid("search.posts", "Zernio searches the last seven days of X posts only.");

        if (!input.query.trim() || input.query.length > 512)
          invalid("search.posts", "The X query must be 1 to 512 characters.");

        if (!Number.isSafeInteger(limit) || limit < 10 || limit > 100)
          invalid("search.posts", "X search pages hold 10 to 100 posts.");

        const result = object(
          await request("/v1/twitter/search", context, undefined, {
            accountId: ref.accountId,
            query: input.query,
            limit: String(limit),
            ...definedFields({
              cursor: input.cursor,
              startTime: input.startTime,
              endTime: input.endTime,
            }),
          }),
        );

        const pagination = isJsonObject(result["pagination"]) ? result["pagination"] : {};
        const cursor = optionalString(pagination["cursor"]);

        return {
          items: array(result["tweets"]).map((entry) => ({
            ...publicFields(entry, [
              "id",
              "text",
              "created",
              "conversationId",
              "inReplyToTweetId",
              "lang",
              "likeCount",
              "replyCount",
              "retweetCount",
              "quoteCount",
            ]),
            ...definedFields({
              author: isJsonObject(object(entry)["author"])
                ? publicFields(object(entry)["author"], ["id", "username", "name"])
                : undefined,
            }),
          })),
          ...definedFields({
            nextCursor: pagination["hasMore"] === true && cursor ? cursor : undefined,
          }),
        };
      },
    },
    messages: {
      async listConversations(
        ref: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        accountMatches(ref, context);
        const limit = input.limit ?? 50;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.read",
            message: "Zernio conversation page size must be between 1 and 100.",
          });

        const result = object(
          await request("/v1/inbox/conversations", context, undefined, {
            accountId: ref.accountId,
            limit: String(limit),
            ...definedFields({ cursor: input.cursor }),
          }),
        );

        const pagination = result["pagination"] === undefined ? {} : object(result["pagination"]);
        const cursor = optionalString(pagination["nextCursor"]);

        return {
          items: array(result["data"]).map((entry) =>
            normalizeConversation(
              inboxFields(entry, [
                "id",
                "platform",
                "accountId",
                "participantId",
                "participantName",
                "participantHandle",
                "participants",
                "lastMessage",
                "updatedTime",
                "unreadCount",
              ]),
            ),
          ),
          ...definedFields({ nextCursor: cursor || undefined }),
        };
      },
      async listMessages(
        ref: ConversationRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        accountMatches(ref, context);
        const limit = input.limit ?? 100;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.read",
            message: "Zernio message page size must be between 1 and 100.",
          });

        const result = object(
          await request(
            `/v1/inbox/conversations/${encodeURIComponent(ref.conversationId)}/messages`,
            context,
            undefined,
            {
              accountId: ref.accountId,
              limit: String(limit),
              ...definedFields({ cursor: input.cursor }),
            },
          ),
        );

        const pagination = result["pagination"] ? object(result["pagination"]) : {};
        const cursor = optionalString(pagination["nextCursor"]);

        return {
          items: array(result["messages"]).map((entry) =>
            normalizeMessage(
              inboxFields(entry, [
                "id",
                "message",
                "from",
                "sender",
                "senderId",
                "senderName",
                "senderHandle",
                "direction",
                "createdAt",
                "deliveryStatus",
                "attachments",
              ]),
            ),
          ),
          ...definedFields({ nextCursor: cursor || undefined }),
        };
      },
      async send(
        ref: ConversationRef,
        content: { text: string },
        context: AdapterOperationContext,
      ): Promise<JsonObject> {
        accountMatches(ref, context);

        return acknowledged(
          "messages.write",
          request(
            `/v1/inbox/conversations/${encodeURIComponent(ref.conversationId)}/messages`,
            context,
            { accountId: ref.accountId, message: content.text },
          ),
          (body): JsonObject => {
            const result = object(body);

            if (result["success"] !== true) unconfirmed("messages.write");
            const raw = object(result["data"])["messageId"];

            // A present message ID must be a non-empty string; anything else is malformed.
            const messageId =
              raw === undefined
                ? undefined
                : isString(raw) && raw.length > 0
                  ? raw
                  : unconfirmed("messages.write");

            return { state: "sent", ...definedFields({ messageId }) };
          },
        );
      },
    },
    webhooks: {
      async verify(input: { headers: Headers; body: Uint8Array }) {
        await verifyZernioWebhook({ ...input, secret: options.webhookSecret ?? "" });

        return { valid: true, method: "hmac" as const };
      },
      async decode(
        input: { headers: Headers; body: Uint8Array },
        context: AdapterOperationContext,
      ): Promise<JsonObject> {
        return {
          ...(await decodeWebhook({
            provider: "zernio",
            backend: context.backendInstance,
            body: input.body,
            receivedAt: now(),
          })),
        };
      },
    },
  });
}
