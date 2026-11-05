import { defineAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import { profileRef } from "../core/types.js";
import type {
  AdapterOperationContext,
  CommentRef,
  ConversationRef,
  ConnectedAccountRef,
  DeliveryOutcome,
  InstagramProductTag,
  InstagramPublishOptions,
  JsonObject,
  JsonValue,
  MetricValue,
  PlatformPostRef,
  PreparationIssue,
  PreparedPublishTarget,
  Page,
  ProfileRecord,
} from "../core/types.js";
import { managedHttp, optionsObject, publicFields } from "../cloud/common.js";
import { HttpError } from "../transport/http.js";
import { metaOAuthReconnect } from "../transport/provider-errors.js";
import { definedFields } from "../core/fields.js";
import {
  normalizeComment,
  normalizeConversation,
  normalizeMessage,
  normalizeMetrics,
} from "../core/projections.js";
import {
  array,
  isBoolean,
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  object,
  optionalArray,
  optionalBoolean,
  optionalNumber,
  optionalObject,
  optionalString,
  string,
  type JsonField,
} from "../transport/validation.js";
import { httpsUrl } from "../transport/upload.js";
import { isJsonValue } from "../transport/json.js";
import { fetchWithoutRedirects } from "../transport/redirect.js";
import { remainingBudget } from "../transport/budget.js";
import { verifyMetaWebhook } from "../server/webhooks.js";
import { directWebhooks, webhookCapability } from "./webhook-adapter.js";

function publishIssueMessage(value: string, path: string): string {
  switch (value) {
    case "CAPTION_NOT_ATTACHED":
      return "Instagram published the media without its caption.";
    case "USER_TAGGING_FAILURE":
      return "Instagram published the media without its user tags.";
    case "POLL_CREATION_FAILURE":
      return "Instagram published the media without its caption poll.";
    case "PROMPT_CREATION_FAILURE":
      return "Instagram published the media without its comment prompt.";
    default:
      return `Instagram published the media but reported ${path} ${value}.`;
  }
}

/**
 * `media_publish` can succeed while dropping part of the request: `config_issue` reports a
 * missing caption or user tags, and `caption_add_on_attachment_status` a poll or comment
 * prompt that did not attach. Sources (Graph v26.0, checked 2026-11-04):
 * https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media_publish
 * https://developers.facebook.com/documentation/instagram-platform/content-publishing/caption-add-ons
 */
function publishIssues(result: JsonObject): readonly PreparationIssue[] {
  const issues: PreparationIssue[] = [];

  for (const path of ["config_issue", "caption_add_on_attachment_status"] as const) {
    const value = result[path];

    if (!isString(value) || value.length === 0) continue;

    issues.push({
      code: value,
      path,
      message: publishIssueMessage(value, path),
      severity: "warning",
    });
  }

  return issues;
}

/**
 * Decode `GET /{ig-media-id}/poll_attachment`. Options C and D are omitted together with
 * their vote shares when unused. Source (Graph v26.0, checked 2026-11-04):
 * https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-media/poll_attachment
 */
function pollResults(value: JsonField): InstagramPollResults | undefined {
  if (value === null || value === undefined) return undefined;

  const poll = object(value);
  const options: InstagramPollOption[] = [];

  for (const letter of ["a", "b", "c", "d"] as const) {
    const text = poll[`option_${letter}`];

    if (text === undefined && (letter === "c" || letter === "d")) continue;

    const share = poll[`option_${letter}_votes_percentage`];

    if (!isString(text) || !isFiniteNumber(share) || share < 0 || share > 1)
      throw new SocialError({
        code: "upstream_failure",
        operation: "instagram.posts.read",
        message: `Instagram returned an invalid poll option ${letter}.`,
      });

    options.push({ text, votesPercentage: share });
  }

  const totalVotes = poll["total_votes"];

  if (!isFiniteNumber(totalVotes) || !Number.isSafeInteger(totalVotes) || totalVotes < 0)
    throw new SocialError({
      code: "upstream_failure",
      operation: "instagram.posts.read",
      message: "Instagram returned an invalid poll total_votes.",
    });

  const expiresAt = poll["expiration_timestamp"];

  return {
    options,
    totalVotes,
    ...definedFields({
      expiresAt: isString(expiresAt)
        ? expiresAt
        : isFiniteNumber(expiresAt)
          ? new Date(expiresAt * 1000).toISOString()
          : undefined,
    }),
  };
}

const promptResponseFields = ["id", "text", "timestamp", "username"];

/** Container kinds that accept different native publishing fields. */
export type InstagramContainerKind = "image" | "reel" | "carousel" | "carousel-item" | "story";

/** Story user tags may omit coordinates. */
export interface InstagramStoryUserTag {
  readonly username: string;
  readonly x?: number;
  readonly y?: number;
}

const usernamePattern = /^[A-Za-z0-9._]{1,30}$/;

const invalidOption = (operation: string, message: string): never => {
  throw new SocialError({
    code: "invalid_input",
    operation,
    message,
    retryDisposition: { kind: "never" },
  });
};

const unitCoordinate = (value: JsonField, operation: string, label: string): number => {
  if (!isFiniteNumber(value) || value < 0 || value > 1)
    return invalidOption(operation, `${label} must be a number from 0 through 1.`);

  return value;
};

const nonEmptyText = (value: JsonField, operation: string, label: string): string => {
  if (!isString(value) || value.trim() === "")
    return invalidOption(operation, `${label} must be a non-empty string.`);

  return value;
};

const booleanOption = (value: JsonField, operation: string, label: string): boolean => {
  if (!isBoolean(value)) return invalidOption(operation, `${label} must be a boolean.`);

  return value;
};

const optionList = (value: JsonField, operation: string, label: string): readonly JsonValue[] => {
  if (!isJsonArray(value)) return invalidOption(operation, `${label} must be an array.`);

  return value;
};

const graduationStrategies = ["MANUAL", "SS_PERFORMANCE"] as const;

const isGraduationStrategy = (value: JsonField): value is "MANUAL" | "SS_PERFORMANCE" =>
  graduationStrategies.some((strategy) => strategy === value);

/**
 * Decode normalized `options` for an Instagram target. Unknown keys are rejected so a
 * misspelled option never publishes silently without its field.
 */
function decodeInstagramPublishOptions(
  raw: JsonObject,
  operation = "instagram.posts.publish",
): InstagramPublishOptions {
  const known = new Set([
    "shareToFeed",
    "coverUrl",
    "thumbOffsetMs",
    "audioName",
    "trial",
    "collaborators",
    "userTags",
    "locationId",
    "isAiGenerated",
    "isPaidPartnership",
    "brandedContentSponsorIds",
    "poll",
    "commentPrompt",
    "productTags",
    "audioConfiguration",
  ]);

  for (const key of Object.keys(raw))
    if (!known.has(key)) invalidOption(operation, `Unknown Instagram publish option "${key}".`);

  const field = (key: string): JsonField => raw[key];
  const result: { -readonly [K in keyof InstagramPublishOptions]: InstagramPublishOptions[K] } = {};

  if (field("shareToFeed") !== undefined)
    result.shareToFeed = booleanOption(field("shareToFeed"), operation, "shareToFeed");

  if (field("coverUrl") !== undefined)
    result.coverUrl = nonEmptyText(field("coverUrl"), operation, "coverUrl");

  const thumb = field("thumbOffsetMs");

  if (thumb !== undefined) {
    if (!isFiniteNumber(thumb)) return invalidOption(operation, "thumbOffsetMs must be a number.");
    result.thumbOffsetMs = thumb;
  }

  if (field("audioName") !== undefined)
    result.audioName = nonEmptyText(field("audioName"), operation, "audioName");

  const trial = field("trial");

  if (trial !== undefined) {
    const strategy = isJsonObject(trial) ? trial["graduationStrategy"] : undefined;

    if (!isGraduationStrategy(strategy))
      return invalidOption(
        operation,
        'trial.graduationStrategy must be "MANUAL" or "SS_PERFORMANCE".',
      );
    result.trial = { graduationStrategy: strategy };
  }

  if (field("collaborators") !== undefined)
    result.collaborators = optionList(field("collaborators"), operation, "collaborators").map(
      (entry) => nonEmptyText(entry, operation, "Each collaborator"),
    );

  if (field("userTags") !== undefined)
    result.userTags = optionList(field("userTags"), operation, "userTags").map((entry) => {
      const tag = isJsonObject(entry)
        ? entry
        : invalidOption(operation, "Each user tag must be an object.");

      if (tag["mediaIndex"] !== undefined)
        invalidOption(
          operation,
          "userTags[].mediaIndex is a Zernio option; Instagram's user_tags tag a single image.",
        );

      return {
        username: nonEmptyText(tag["username"], operation, "userTags[].username"),
        x: unitCoordinate(tag["x"], operation, "userTags[].x"),
        y: unitCoordinate(tag["y"], operation, "userTags[].y"),
      };
    });

  if (field("locationId") !== undefined)
    result.locationId = nonEmptyText(field("locationId"), operation, "locationId");

  if (field("isAiGenerated") !== undefined)
    result.isAiGenerated = booleanOption(field("isAiGenerated"), operation, "isAiGenerated");

  if (field("isPaidPartnership") !== undefined)
    result.isPaidPartnership = booleanOption(
      field("isPaidPartnership"),
      operation,
      "isPaidPartnership",
    );

  if (field("brandedContentSponsorIds") !== undefined)
    result.brandedContentSponsorIds = optionList(
      field("brandedContentSponsorIds"),
      operation,
      "brandedContentSponsorIds",
    ).map((entry) => nonEmptyText(entry, operation, "Each sponsor ID"));

  const poll = field("poll");

  if (poll !== undefined) {
    const pollObject = isJsonObject(poll)
      ? poll
      : invalidOption(operation, "poll must be an object.");

    const choices = optionList(pollObject["options"], operation, "poll.options").map((entry) =>
      nonEmptyText(entry, operation, "Each poll option"),
    );

    const [first, second, ...rest] = choices;

    if (first === undefined || second === undefined)
      return invalidOption(operation, "poll.options needs 2 to 4 options.");

    const extended = pollObject["extendedDuration"];

    result.poll = {
      options: [first, second, ...rest],
      ...definedFields({
        extendedDuration:
          extended === undefined
            ? undefined
            : booleanOption(extended, operation, "poll.extendedDuration"),
      }),
    };
  }

  if (field("commentPrompt") !== undefined)
    result.commentPrompt = booleanOption(field("commentPrompt"), operation, "commentPrompt");

  if (field("productTags") !== undefined)
    result.productTags = optionList(field("productTags"), operation, "productTags").map((entry) => {
      const tag = isJsonObject(entry)
        ? entry
        : invalidOption(operation, "Each product tag must be an object.");

      return {
        productId: nonEmptyText(tag["productId"], operation, "productTags[].productId"),
        ...definedFields({
          x:
            tag["x"] === undefined
              ? undefined
              : unitCoordinate(tag["x"], operation, "productTags[].x"),
          y:
            tag["y"] === undefined
              ? undefined
              : unitCoordinate(tag["y"], operation, "productTags[].y"),
        }),
      };
    });

  const audio = field("audioConfiguration");

  if (audio !== undefined) {
    const config = isJsonObject(audio)
      ? audio
      : invalidOption(operation, "audioConfiguration must be an object.");

    const volume = (key: "audioVolume" | "videoVolume") => {
      const value = config[key];

      if (value === undefined) return undefined;

      if (!isFiniteNumber(value))
        return invalidOption(operation, `audioConfiguration.${key} must be a number.`);

      return value;
    };

    result.audioConfiguration = {
      audioId: nonEmptyText(config["audioId"], operation, "audioConfiguration.audioId"),
      ...definedFields({ audioVolume: volume("audioVolume"), videoVolume: volume("videoVolume") }),
    };
  }

  return result;
}

/**
 * Map typed options to Meta container fields for one container kind. Sources (Graph API
 * v26.0, checked 2026-11-04): POST /{ig-user-id}/media reference and the content
 * publishing, audio, and product tagging guides.
 * https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media
 * https://developers.facebook.com/docs/instagram-platform/content-publishing
 */
function instagramContainerFields(input: {
  readonly options: InstagramPublishOptions & {
    readonly storyUserTags?: readonly InstagramStoryUserTag[];
  };
  readonly kind: InstagramContainerKind;
  readonly flavor: "instagram-login" | "facebook-login";
  readonly caption: string;
  readonly operation: string;
}): JsonObject {
  const { options, kind, flavor, caption, operation } = input;
  const fields: Record<string, JsonValue> = {};

  const only = (name: string, kinds: readonly InstagramContainerKind[]) => {
    if (!kinds.includes(kind))
      invalidOption(operation, `${name} is not supported on an Instagram ${kind} container.`);
  };

  const facebookOnly = (name: string) => {
    if (flavor !== "facebook-login")
      throw new SocialError({
        code: "unsupported_capability",
        operation,
        message: `${name} requires Instagram API with Facebook Login.`,
        retryDisposition: { kind: "never" },
      });
  };

  // Earlier releases accepted shareToFeed on any target and sent it only where Meta uses it,
  // so a single image still ignores it instead of failing.
  if (options.shareToFeed !== undefined && kind !== "image") {
    only("shareToFeed", ["reel", "carousel"]);
    fields["share_to_feed"] = options.shareToFeed;
  }

  if (options.coverUrl !== undefined) {
    only("coverUrl", ["reel"]);

    try {
      httpsUrl(options.coverUrl);
    } catch {
      invalidOption(operation, "coverUrl must be a public HTTPS URL.");
    }

    fields["cover_url"] = options.coverUrl;
  }

  if (options.thumbOffsetMs !== undefined) {
    only("thumbOffsetMs", ["reel"]);

    if (!Number.isSafeInteger(options.thumbOffsetMs) || options.thumbOffsetMs < 0)
      invalidOption(operation, "thumbOffsetMs must be a non-negative integer of milliseconds.");
    fields["thumb_offset"] = options.thumbOffsetMs;
  }

  if (options.audioName !== undefined) {
    only("audioName", ["reel"]);
    fields["audio_name"] = options.audioName;
  }

  if (options.trial !== undefined) {
    only("trial", ["reel"]);
    fields["trial_params"] = { graduation_strategy: options.trial.graduationStrategy };
  }

  if (options.collaborators !== undefined) {
    only("collaborators", ["image", "reel", "carousel"]);

    if (
      options.collaborators.length < 1 ||
      options.collaborators.length > 3 ||
      options.collaborators.some((name) => !usernamePattern.test(name))
    )
      invalidOption(operation, "collaborators takes 1 to 3 valid Instagram usernames.");
    fields["collaborators"] = [...options.collaborators];
  }

  if (options.userTags !== undefined) {
    only("userTags", ["image"]);
    fields["user_tags"] = options.userTags.map((tag) => {
      if (!usernamePattern.test(tag.username))
        invalidOption(operation, "Each user tag needs a valid Instagram username.");

      return {
        username: tag.username,
        x: unitCoordinate(tag.x, operation, "userTags[].x"),
        y: unitCoordinate(tag.y, operation, "userTags[].y"),
      };
    });
  }

  if (options.storyUserTags !== undefined) {
    only("userTags", ["story"]);
    fields["user_tags"] = options.storyUserTags.map((tag) => {
      if (!usernamePattern.test(tag.username))
        invalidOption(operation, "Each user tag needs a valid Instagram username.");

      if ((tag.x === undefined) !== (tag.y === undefined))
        invalidOption(operation, "A Story user tag needs both x and y, or neither.");

      return {
        username: tag.username,
        ...definedFields({
          x: tag.x === undefined ? undefined : unitCoordinate(tag.x, operation, "userTags[].x"),
          y: tag.y === undefined ? undefined : unitCoordinate(tag.y, operation, "userTags[].y"),
        }),
      };
    });
  }

  if (options.locationId !== undefined) {
    only("locationId", ["image", "reel", "carousel"]);

    if (!/^\d{1,32}$/.test(options.locationId))
      invalidOption(operation, "locationId must be a numeric Facebook Page ID.");
    fields["location_id"] = options.locationId;
  }

  if (options.isAiGenerated !== undefined) {
    only("isAiGenerated", ["image", "reel", "carousel"]);
    fields["is_ai_generated"] = options.isAiGenerated;
  }

  if (options.isPaidPartnership !== undefined) {
    facebookOnly("isPaidPartnership");
    only("isPaidPartnership", ["image", "reel", "carousel"]);
    fields["is_paid_partnership"] = options.isPaidPartnership;
  }

  if (options.brandedContentSponsorIds !== undefined) {
    facebookOnly("brandedContentSponsorIds");
    only("brandedContentSponsorIds", ["image", "reel", "carousel"]);
    const ids = options.brandedContentSponsorIds;

    if (ids.length < 1 || ids.length > 2 || ids.some((id) => !/^\d{1,32}$/.test(id)))
      invalidOption(operation, "brandedContentSponsorIds takes 1 or 2 numeric Instagram user IDs.");

    if (options.isPaidPartnership === false)
      invalidOption(operation, "Sponsor IDs always add the paid partnership label.");
    // Instagram user IDs exceed Number.MAX_SAFE_INTEGER, so they stay strings.
    fields["branded_content_sponsor_ids"] = [...ids];
  }

  if (options.poll !== undefined) {
    facebookOnly("poll");
    only("poll", ["image", "reel", "carousel"]);
    const choices = options.poll.options;

    if (choices.length > 4 || choices.some((choice) => choice.length < 1 || choice.length > 25))
      invalidOption(operation, "A poll needs 2 to 4 options of 1 to 25 characters each.");

    if (caption.trim() === "")
      invalidOption(operation, "A poll needs a non-empty caption, which becomes its question.");

    if (options.commentPrompt === true)
      invalidOption(operation, "A poll cannot be combined with a comment prompt.");
    const attachment: Record<string, JsonValue> = {};

    for (const [index, choice] of choices.entries())
      attachment[`option_${"abcd"[index] ?? ""}`] = choice;

    if (JSON.stringify(attachment).length > 200)
      invalidOption(operation, "The serialized poll must be 200 characters or fewer.");
    fields["poll_attachment"] = attachment;

    if (options.poll.extendedDuration !== undefined)
      fields["is_poll_duration_extended"] = options.poll.extendedDuration;
  }

  if (options.commentPrompt !== undefined) {
    facebookOnly("commentPrompt");
    only("commentPrompt", ["image", "reel", "carousel"]);

    if (options.commentPrompt && caption.trim() === "")
      invalidOption(operation, "A comment prompt needs a non-empty caption.");
    fields["is_comment_prompt_used"] = options.commentPrompt;
  }

  if (options.productTags !== undefined) {
    facebookOnly("productTags");
    only("productTags", ["image", "reel"]);
    const tags = options.productTags;

    if (tags.length < 1 || tags.length > 5)
      invalidOption(operation, "productTags takes 1 to 5 tags.");

    if (new Set(tags.map((tag) => tag.productId)).size !== tags.length)
      invalidOption(operation, "Each product can be tagged once per media.");
    fields["product_tags"] = tags.map((tag) => {
      if (!/^\d{1,32}$/.test(tag.productId))
        invalidOption(operation, "productTags[].productId must be a numeric catalog product ID.");

      if (kind !== "image" && (tag.x !== undefined || tag.y !== undefined))
        invalidOption(operation, "Product tag coordinates apply to images only.");

      return {
        product_id: tag.productId,
        ...definedFields({
          x: tag.x === undefined ? undefined : unitCoordinate(tag.x, operation, "productTags[].x"),
          y: tag.y === undefined ? undefined : unitCoordinate(tag.y, operation, "productTags[].y"),
        }),
      };
    });
  }

  if (options.audioConfiguration !== undefined) {
    facebookOnly("audioConfiguration");
    only("audioConfiguration", ["reel"]);
    const { audioId, audioVolume, videoVolume } = options.audioConfiguration;

    for (const volume of [audioVolume, videoVolume])
      if (volume !== undefined && (!Number.isSafeInteger(volume) || volume < 1 || volume > 100))
        invalidOption(operation, "Audio and video volumes must be integers from 1 through 100.");
    fields["audio_configuration"] = {
      audio_id: audioId,
      ...definedFields({ audio_volume: audioVolume, video_volume: videoVolume }),
    };
  }

  return fields;
}

const eventNotifications: readonly InstagramEventNotification[] = [
  "BEFORE_EVENT_2DAY",
  "BEFORE_EVENT_1DAY",
  "BEFORE_EVENT_1HOUR",
  "BEFORE_EVENT_15MIN",
  "EVENT_START",
  "AFTER_EVENT_1DAY",
  "AFTER_EVENT_2DAY",
  "AFTER_EVENT_3DAY",
  "AFTER_EVENT_4DAY",
  "AFTER_EVENT_5DAY",
  "AFTER_EVENT_6DAY",
  "AFTER_EVENT_7DAY",
];

const isoTime = (value: string, operation: string, label: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value)))
    return invalidOption(operation, `${label} must be an ISO 8601 date-time.`);

  return value;
};

/** Graph time filters take Unix seconds; callers pass ISO 8601 date-times. */
function unixSeconds(value: string, operation: string): string {
  return String(Math.floor(Date.parse(isoTime(value, operation, "since/until")) / 1000));
}

/**
 * Upcoming event fields and Meta's notification rules, from the upcoming events guide
 * (Graph v26.0, checked 2026-11-04).
 */
function eventFields(
  event: Partial<InstagramUpcomingEvent>,
  mode: "create" | "update",
): JsonObject {
  const operation = "instagram.events.write";
  const fields: Record<string, JsonValue> = {};

  if (event.title !== undefined || mode === "create")
    fields["title"] = nonEmptyText(event.title, operation, "title");

  if (event.startTime !== undefined || mode === "create")
    fields["start_time"] = isoTime(event.startTime ?? "", operation, "startTime");

  if (event.endTime !== undefined) {
    if (event.notificationTargetTime === "EVENT_END")
      invalidOption(operation, "endTime is not allowed when notifications target EVENT_END.");

    fields["end_time"] = isoTime(event.endTime, operation, "endTime");
  }

  const subtypes = event.notificationSubtypes;

  if (subtypes !== undefined) {
    if (subtypes.some((subtype) => !eventNotifications.includes(subtype)))
      invalidOption(operation, "notificationSubtypes contains an unknown value.");

    const set = new Set(subtypes);

    if (event.notificationTargetTime === "EVENT_END") {
      if (
        set.size !== 3 ||
        !set.has("BEFORE_EVENT_2DAY") ||
        !set.has("BEFORE_EVENT_1DAY") ||
        !set.has("BEFORE_EVENT_1HOUR")
      )
        invalidOption(
          operation,
          "EVENT_END notifications must be exactly BEFORE_EVENT_2DAY, BEFORE_EVENT_1DAY, and BEFORE_EVENT_1HOUR.",
        );
    } else if (
      mode === "create" &&
      (!set.has("EVENT_START") || !set.has("BEFORE_EVENT_1DAY") || set.size < 3)
    )
      invalidOption(
        operation,
        "EVENT_START notifications need EVENT_START, BEFORE_EVENT_1DAY, and at least one more value.",
      );

    fields["notification_subtypes"] = [...set];
  }

  if (event.notificationTargetTime !== undefined) {
    if (
      event.notificationTargetTime !== "EVENT_START" &&
      event.notificationTargetTime !== "EVENT_END"
    )
      invalidOption(operation, "notificationTargetTime must be EVENT_START or EVENT_END.");

    fields["notification_target_time"] = event.notificationTargetTime;
  }

  return fields;
}

const messageOperation = "instagram.messages.write";

const publicHttps = (value: string, label: string): string => {
  try {
    return httpsUrl(value).href;
  } catch {
    return invalidOption(messageOperation, `${label} must be a public HTTPS URL.`);
  }
};

function buttonWire(button: InstagramMessageButton): JsonObject {
  const title = nonEmptyText(button.title, messageOperation, "Button title");

  switch (button.kind) {
    case "web_url":
      return { type: "web_url", title, url: publicHttps(button.url, "Button url") };
    case "postback":
      return {
        type: "postback",
        title,
        payload: nonEmptyText(button.payload, messageOperation, "Button payload"),
      };
    default: {
      const _exhaustive: never = button;

      return _exhaustive;
    }
  }
}

/**
 * Message bodies from the Instagram Login send, quick reply, and template guides (Graph
 * v26.0, checked 2026-11-04):
 * https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
 */
function outgoingMessageWire(message: InstagramOutgoingMessage): JsonObject {
  switch (message.kind) {
    case "text": {
      const text = nonEmptyText(message.text, messageOperation, "Message text");

      if (new TextEncoder().encode(text).byteLength > 1000)
        invalidOption(
          messageOperation,
          "Instagram message text must be 1,000 UTF-8 bytes or fewer.",
        );

      if (message.quickReplies === undefined) return { text };

      if (message.quickReplies.length < 1 || message.quickReplies.length > 13)
        invalidOption(messageOperation, "Instagram supports 1 to 13 quick replies.");

      return {
        text,
        quick_replies: message.quickReplies.map((reply) => ({
          content_type: "text",
          title: nonEmptyText(reply.title, messageOperation, "Quick reply title"),
          payload: nonEmptyText(reply.payload, messageOperation, "Quick reply payload"),
        })),
      };
    }

    case "images": {
      if (message.images.length < 1 || message.images.length > 10)
        invalidOption(messageOperation, "An image message takes 1 to 10 images.");

      return {
        attachments: message.images.map((image) => ({
          type: "image",
          payload:
            "url" in image
              ? { url: publicHttps(image.url, "Image url") }
              : {
                  attachment_id: nonEmptyText(image.attachmentId, messageOperation, "attachmentId"),
                },
        })),
      };
    }

    case "audio":
    case "video":
    case "file":
      return {
        attachment: { type: message.kind, payload: { url: publicHttps(message.url, "Media url") } },
      };
    case "like_heart":
      return { attachment: { type: "like_heart" } };
    case "media_share":
      return {
        attachment: {
          type: "MEDIA_SHARE",
          payload: { id: nonEmptyText(message.mediaId, messageOperation, "mediaId") },
        },
      };
    case "generic_template": {
      if (message.elements.length < 1 || message.elements.length > 10)
        invalidOption(messageOperation, "A generic template takes 1 to 10 elements.");

      return {
        attachment: {
          type: "template",
          payload: {
            template_type: "generic",
            elements: message.elements.map((element) => {
              if (element.title.length < 1 || element.title.length > 80)
                invalidOption(messageOperation, "Template titles take 1 to 80 characters.");

              if (element.subtitle !== undefined && element.subtitle.length > 80)
                invalidOption(messageOperation, "Template subtitles take up to 80 characters.");

              if (element.buttons !== undefined && element.buttons.length > 3)
                invalidOption(messageOperation, "A template element takes up to 3 buttons.");

              if (
                element.subtitle === undefined &&
                element.imageUrl === undefined &&
                element.defaultActionUrl === undefined &&
                (element.buttons?.length ?? 0) === 0
              )
                invalidOption(messageOperation, "Set at least one template field besides title.");

              return {
                title: element.title,
                ...definedFields({
                  subtitle: element.subtitle,
                  image_url:
                    element.imageUrl === undefined
                      ? undefined
                      : publicHttps(element.imageUrl, "imageUrl"),
                  default_action:
                    element.defaultActionUrl === undefined
                      ? undefined
                      : {
                          type: "web_url",
                          url: publicHttps(element.defaultActionUrl, "defaultActionUrl"),
                        },
                  buttons: element.buttons?.map(buttonWire),
                }),
              };
            }),
          },
        },
      };
    }

    case "button_template": {
      const text = nonEmptyText(message.text, messageOperation, "Button template text");

      if (text.length > 640)
        invalidOption(messageOperation, "Button template text takes up to 640 characters.");

      if (message.buttons.length < 1 || message.buttons.length > 3)
        invalidOption(messageOperation, "A button template takes 1 to 3 buttons.");

      return {
        attachment: {
          type: "template",
          payload: { template_type: "button", text, buttons: message.buttons.map(buttonWire) },
        },
      };
    }

    default: {
      const _exhaustive: never = message;

      return _exhaustive;
    }
  }
}

/**
 * Meta documents `{ recipient_id, message_id }` for a sent message. A send that returns no
 * message ID may still have been delivered, so it is uncertain rather than a success or failure.
 */
function sentMessage(value: JsonValue): InstagramSentMessage {
  const messageId = isJsonObject(value) ? value["message_id"] : undefined;

  if (!isJsonObject(value) || !isString(messageId) || messageId.length === 0)
    throw new SocialError({
      code: "ambiguous_outcome",
      operation: messageOperation,
      message:
        "Instagram did not return a message ID for the send. Read the conversation before retrying.",
      retryDisposition: { kind: "reconcile-first" },
    });

  const recipientId = value["recipient_id"];

  return {
    messageId,
    ...definedFields({ recipientId: optionalString(recipientId) }),
  };
}

const metricName = /^[a-z][a-z0-9_]{0,63}$/;

/** Daily account metrics that Meta documents with `metric_type=total_value`. */
const defaultAccountMetrics: readonly [string, ...string[]] = [
  "accounts_engaged",
  "reach",
  "views",
  "total_interactions",
];

/** Decode Graph insights rows; numeric values only, so a malformed row fails loudly. */
function insightRows(result: JsonObject): readonly InstagramInsight[] {
  return array(result["data"]).map((entry) => {
    const row = object(entry);
    const values = optionalArray(row["values"]);
    const total = optionalObject(row["total_value"]);

    return {
      name: string(row["name"]),
      ...definedFields({
        period: optionalString(row["period"]),
        values: values?.flatMap((item) => {
          const value = object(item);
          const count = value["value"];

          return isFiniteNumber(count)
            ? [{ value: count, ...definedFields({ endTime: optionalString(value["end_time"]) }) }]
            : [];
        }),
        totalValue:
          total === undefined
            ? undefined
            : definedFields({
                value: optionalNumber(total["value"]),
                breakdowns: optionalArray(total["breakdowns"])?.map((breakdown) => {
                  const part = object(breakdown);

                  return {
                    dimensionKeys: (optionalArray(part["dimension_keys"]) ?? []).map(string),
                    results: (optionalArray(part["results"]) ?? []).map((result) => {
                      const item = object(result);
                      const value = item["value"];

                      if (!isFiniteNumber(value))
                        throw new SocialError({
                          code: "upstream_failure",
                          operation: "instagram.analytics.read",
                          message: "Instagram returned a non-numeric insights breakdown value.",
                        });

                      return {
                        dimensionValues: (optionalArray(item["dimension_values"]) ?? []).map(
                          string,
                        ),
                        value,
                        ...definedFields({ endTime: optionalString(item["end_time"]) }),
                      };
                    }),
                  };
                }),
              }),
      }),
    };
  });
}

/** Meta's resumable upload URIs, from the resumable uploads guide (Graph v26.0, checked 2026-11-04). */
function ruploadUri(value: JsonField): URL {
  const uri = URL.parse(isString(value) ? value : "");

  if (
    uri?.protocol !== "https:" ||
    uri.hostname !== "rupload.facebook.com" ||
    !uri.pathname.startsWith("/ig-api-upload/") ||
    uri.username !== "" ||
    uri.password !== ""
  )
    throw new SocialError({
      code: "upstream_failure",
      operation: "instagram.media.upload",
      message: "Instagram returned an upload URI outside rupload.facebook.com/ig-api-upload.",
    });

  return uri;
}

function parseUploadResponse(text: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(text);

    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Caption limits from the IG User media reference: 2,200 characters, 30 hashtags, 20 @ tags. */
function instagramCaptionIssues(caption: string): readonly string[] {
  const issues: string[] = [];

  if (caption.length > 2200) issues.push("Caption exceeds 2,200 characters.");

  const hashtags = caption.match(/(?:^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  const mentions = caption.match(/(?:^|[^A-Za-z0-9._])@[A-Za-z0-9._]+/g)?.length ?? 0;

  if (hashtags > 30) issues.push("Caption has more than 30 hashtags.");

  if (mentions > 20) issues.push("Caption has more than 20 @ tags.");

  return issues;
}

export interface InstagramOptions {
  /** Instagram Login by default. Facebook Login is required for business discovery and hashtags. */
  readonly auth: {
    readonly accessToken: string;
    readonly accountId: string;
    readonly flavor?: "instagram-login" | "facebook-login";
  };
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
  readonly workflowStore?: InstagramWorkflowStore;
  /** App secret that Meta uses to sign webhook deliveries (`X-Hub-Signature-256`). */
  readonly webhookSecret?: string;
}

export interface InstagramNative {
  readonly moderateComment: (input: {
    readonly account: ConnectedAccountRef;
    readonly commentId: string;
    readonly hidden: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly deleteComment: (input: {
    readonly account: ConnectedAccountRef;
    readonly commentId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly setCommentsEnabled: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly enabled: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly listCommentReplies: (input: {
    readonly account: ConnectedAccountRef;
    readonly commentId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly listMentions: (input: InstagramTagsInput) => Promise<Page<JsonObject>>;
  readonly sendMessage: (input: {
    readonly account: ConnectedAccountRef;
    readonly recipientId: string;
    readonly text: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly mentionedMedia: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly mentionedComment: (input: {
    readonly account: ConnectedAccountRef;
    readonly commentId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly listTaggedMedia: (input: InstagramTagsInput) => Promise<Page<JsonObject>>;
  readonly hashtagMedia: (input: {
    readonly account: ConnectedAccountRef;
    readonly hashtagId: string;
    readonly kind: "top" | "recent";
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly businessDiscovery: (input: {
    readonly account: ConnectedAccountRef;
    readonly username: string;
    readonly fields?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Reel container fields come from `InstagramPublishOptions`; see the Instagram docs page. */
  readonly publishReel: (
    input: {
      readonly account: ConnectedAccountRef;
      readonly videoUrl: string;
      readonly caption?: string;
      readonly context: AdapterOperationContext;
    } & Omit<InstagramPublishOptions, "userTags">,
  ) => Promise<DeliveryOutcome>;
  readonly publishStory: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaUrl: string;
    readonly videoUrl?: string;
    /** Story `user_tags`; coordinates are optional on Stories. */
    readonly userTags?: readonly InstagramStoryUserTag[];
    readonly context: AdapterOperationContext;
  }) => Promise<DeliveryOutcome>;
  readonly deletePost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly hashtagSearch: (input: {
    readonly account: ConnectedAccountRef;
    readonly hashtag: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly publishingLimit: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly mentions: (input: InstagramTagsInput) => Promise<Page<JsonObject>>;
  readonly publishContainer: (
    account: ConnectedAccountRef,
    containerId: string,
    context: AdapterOperationContext,
    workflowId?: string,
  ) => Promise<DeliveryOutcome>;
  /** Publish 2 to 20 finished child containers. `options` sets carousel parent fields. */
  readonly publishCarousel: (
    account: ConnectedAccountRef,
    children: readonly string[],
    caption: string,
    context: AdapterOperationContext,
    options?: InstagramPublishOptions,
  ) => Promise<DeliveryOutcome>;
  /** Facebook Login only: search licensed audio through `GET /ig_audio` for `audioConfiguration`. */
  readonly searchAudio: (input: {
    readonly account: ConnectedAccountRef;
    readonly audioType: "original_sound" | "music";
    /** Omit to get trending audio. */
    readonly query?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Facebook Login only: read one audio asset through `GET /{ig-audio-id}`. */
  readonly getAudio: (input: {
    readonly account: ConnectedAccountRef;
    readonly audioId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /**
   * Facebook Login only: read Meta's copyright check for an unpublished video container
   * (`copyright_check_status`) or a published video (`copyright_check_information`).
   */
  readonly getCopyrightCheck: (input: {
    readonly account: ConnectedAccountRef;
    readonly id: string;
    readonly stage: "container" | "media";
    readonly context: AdapterOperationContext;
  }) => Promise<InstagramCopyrightCheck>;
  /**
   * Facebook Login only: create a video container with `upload_type=resumable`. Upload the
   * bytes with `uploadVideo`, then publish the container with `publishContainer` (or pass a
   * `VIDEO` carousel item to `publishCarousel`).
   */
  readonly createResumableUpload: (
    input: {
      readonly account: ConnectedAccountRef;
      readonly mediaType: "REELS" | "STORIES" | "VIDEO";
      readonly caption?: string;
      readonly context: AdapterOperationContext;
    } & Omit<InstagramPublishOptions, "userTags">,
  ) => Promise<InstagramResumableUpload>;
  /**
   * Facebook Login only: send video bytes, or a hosted `file_url`, to the
   * `rupload.facebook.com` URI returned by `createResumableUpload`.
   */
  readonly uploadVideo: (input: {
    readonly account: ConnectedAccountRef;
    readonly uploadUri: string;
    readonly source:
      | { readonly kind: "blob"; readonly blob: Blob; readonly offset?: number }
      | { readonly kind: "https-url"; readonly url: string };
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Read `status`, `status_code`, and `video_status` upload and processing phases. */
  readonly getUploadStatus: (input: {
    readonly account: ConnectedAccountRef;
    readonly containerId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Read the child media of a carousel album through `GET /{ig-media-id}/children`. */
  readonly listChildren: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Facebook Login only: current Stories (24 hours) through `GET /{ig-user-id}/stories`. */
  readonly listStories: (input: InstagramEdgeInput) => Promise<Page<JsonObject>>;
  /** Facebook Login only: live videos broadcasting now, through `GET /{ig-user-id}/live_media`. */
  readonly listLiveMedia: (
    input: InstagramEdgeInput & { readonly since?: string; readonly until?: string },
  ) => Promise<Page<JsonObject>>;
  /** Facebook Login only: other accounts' media this account collaborates on. */
  readonly listCollaborativeMedia: (input: InstagramEdgeInput) => Promise<Page<JsonObject>>;
  /** Facebook Login only: invited collaborators and their `invite_status` for owned media. */
  readonly listMediaCollaborators: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly InstagramCollaborator[]>;
  /** Facebook Login only: pending invitations to collaborate on other accounts' media. */
  readonly listCollaborationInvites: (input: InstagramEdgeInput) => Promise<Page<JsonObject>>;
  /** Facebook Login only: accept (`true`) or decline (`false`) a collaboration invite. */
  readonly respondToCollaborationInvite: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly accept: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Facebook Login only: the Threads user connected to this Instagram account, if any. */
  readonly getConnectedThreadsUser: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly threadsUserId?: string }>;
  /**
   * Embed HTML for a public post, Reel, or profile through `GET /instagram_oembed` on
   * graph.facebook.com. For front-end embedding only. Pass an app or client access token
   * when the adapter token is not accepted for oEmbed.
   */
  readonly getOEmbed: (input: {
    readonly url: string;
    readonly maxWidth?: number;
    readonly omitScript?: boolean;
    readonly appAccessToken?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Facebook Login only: events the account hosts, through `GET /{ig-user-id}/upcoming_events`. */
  readonly listUpcomingEvents: (input: InstagramEdgeInput) => Promise<Page<JsonObject>>;
  /** Facebook Login only: create an upcoming event and return its ID. */
  readonly createUpcomingEvent: (
    input: {
      readonly account: ConnectedAccountRef;
      readonly context: AdapterOperationContext;
    } & InstagramUpcomingEvent,
  ) => Promise<{ readonly id: string }>;
  /** Facebook Login only: update an upcoming event's title, times, or notifications. */
  readonly updateUpcomingEvent: (
    input: {
      readonly account: ConnectedAccountRef;
      readonly eventId: string;
      readonly context: AdapterOperationContext;
    } & Partial<Omit<InstagramUpcomingEvent, "notificationTargetTime">>,
  ) => Promise<{ readonly id: string }>;
  /** Facebook Login only: hashtag IDs searched in the last 7 days, to track the 30-tag budget. */
  readonly listRecentlySearchedHashtags: (input: {
    readonly account: ConnectedAccountRef;
    readonly limit?: number;
    readonly cursor?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Comment on owned media through `POST /{ig-media-id}/comments`. Not on live video. */
  readonly createComment: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly text: string;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly id: string }>;
  /** Read one comment, including `hidden`, through `GET /{ig-comment-id}`. */
  readonly getComment: (input: {
    readonly account: ConnectedAccountRef;
    readonly commentId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Facebook Login only: comments in Instagram's display order (`ordered_comments`). */
  readonly listOrderedComments: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /**
   * Reply to an @mention through `POST /{ig-user-id}/mentions`: omit `commentId` to reply to
   * a caption mention, or pass it to reply to a comment mention.
   */
  readonly replyToMention: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly commentId?: string;
    readonly text: string;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly id: string }>;
  /** Send one private message to a commenter, addressed by comment ID. */
  readonly privateReply: (input: {
    readonly account: ConnectedAccountRef;
    readonly commentId: string;
    readonly text: string;
    readonly context: AdapterOperationContext;
  }) => Promise<InstagramSentMessage>;
  /** Send text, media, a sticker, a shared post, or a template. */
  readonly sendDirectMessage: (input: {
    readonly account: ConnectedAccountRef;
    /** The Instagram-scoped ID (IGSID) from a messaging webhook. */
    readonly recipientId: string;
    readonly message: InstagramOutgoingMessage;
    /** `reply_to.mid`: reply to a specific message. */
    readonly replyToMessageId?: string;
    /** Send with the `HUMAN_AGENT` tag inside Meta's 7-day human agent window. */
    readonly humanAgent?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<InstagramSentMessage>;
  /** React to a message, or replace an earlier reaction. */
  readonly reactToMessage: (input: {
    readonly account: ConnectedAccountRef;
    readonly recipientId: string;
    readonly messageId: string;
    /** An emoji, or `love`. */
    readonly reaction: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Remove this account's reaction (`unreact`). */
  readonly removeReaction: (input: {
    readonly account: ConnectedAccountRef;
    readonly recipientId: string;
    readonly messageId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Show a typing indicator or mark the conversation seen. */
  readonly sendSenderAction: (input: {
    readonly account: ConnectedAccountRef;
    readonly recipientId: string;
    readonly action: "typing_on" | "typing_off" | "mark_seen";
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Read the conversation-starter ice breakers. */
  readonly getIceBreakers: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly InstagramIceBreakers[]>;
  /** Replace the ice breakers, up to 4 questions per locale. */
  readonly setIceBreakers: (input: {
    readonly account: ConnectedAccountRef;
    readonly iceBreakers: readonly InstagramIceBreakers[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Remove all ice breakers. */
  readonly deleteIceBreakers: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Read the persistent menu. */
  readonly getPersistentMenu: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Replace the persistent menu shown in conversations. */
  readonly setPersistentMenu: (input: {
    readonly account: ConnectedAccountRef;
    readonly menus: readonly InstagramPersistentMenu[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Remove the persistent menu. */
  readonly deletePersistentMenu: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** User Profile API read for a person who messaged the account. */
  readonly getMessagingUserProfile: (input: {
    readonly account: ConnectedAccountRef;
    readonly recipientId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<InstagramMessagingProfile>;
  /**
   * Read media insights through `GET /{ig-media-id}/insights`, for example `views`,
   * `total_interactions`, `reposts`, `ig_reels_avg_watch_time`, `navigation`, or `replies`.
   */
  readonly getMediaInsights: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly metrics: readonly [string, ...string[]];
    /** `action_type` for `profile_activity`, `story_navigation_action_type` for `navigation`. */
    readonly breakdown?: "action_type" | "story_navigation_action_type";
    readonly context: AdapterOperationContext;
  }) => Promise<readonly InstagramInsight[]>;
  /** Read account insights through `GET /{ig-user-id}/insights`. */
  readonly getAccountInsights: (input: {
    readonly account: ConnectedAccountRef;
    /** Defaults to `accounts_engaged`, `reach`, `views`, and `total_interactions`. */
    readonly metrics?: readonly [string, ...string[]];
    readonly period: "day" | "lifetime";
    readonly metricType?: "total_value" | "time_series";
    /** ISO 8601 date-times, sent as Unix seconds. Meta looks back 24 hours when omitted. */
    readonly since?: string;
    readonly until?: string;
    /** Only with `metricType: "total_value"`, such as `media_product_type` or `follow_type`. */
    readonly breakdown?: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<readonly InstagramInsight[]>;
  /** Read `follower_demographics` or `engaged_audience_demographics` for one breakdown. */
  readonly getAudienceDemographics: (input: {
    readonly account: ConnectedAccountRef;
    readonly metric: "follower_demographics" | "engaged_audience_demographics";
    readonly breakdown: "age" | "city" | "country" | "gender";
    readonly timeframe: "this_week" | "this_month";
    readonly context: AdapterOperationContext;
  }) => Promise<InstagramInsight>;
  /**
   * Enable webhook fields for this account through `POST /{id}/subscribed_apps`. Instagram
   * Login and Unified Login subscribe the Instagram account; Page-linked Facebook Login
   * subscribes the linked `pageId`.
   */
  readonly subscribeWebhooks: (input: {
    readonly account: ConnectedAccountRef;
    readonly fields: readonly [string, ...string[]];
    /**
     * Facebook Login with a linked Page: subscribe that Page. Omit it with a Unified Login token
     * to subscribe the Instagram account itself on graph.facebook.com.
     */
    readonly pageId?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /**
   * Facebook Login only: find the Instagram professional account linked to a Facebook Page
   * through `GET /{page-id}?fields=instagram_business_account`.
   */
  readonly getPageInstagramAccount: (input: {
    readonly pageId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly id: string; readonly username?: string } | undefined>;
  /**
   * Facebook Login only, for Unified Login: the client's business ID through
   * `GET /me?fields=client_business_id`. Store it with the token to manage the token later.
   */
  readonly getClientBusinessId: (input: {
    readonly context: AdapterOperationContext;
  }) => Promise<string | undefined>;
  /**
   * Facebook Login only, for Unified Login: the Instagram accounts the client shared with a
   * Business Integration System User token, through `GET /me/assigned_instagram_accounts`.
   */
  readonly listAssignedAccounts: (input: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<{ readonly id: string; readonly username?: string }>>;
  /** Facebook Login only: `shopping_product_tag_eligibility` for this account. */
  readonly getProductTagEligibility: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<boolean>;
  /** Facebook Login only: catalogs this account can tag products from (`available_catalogs`). */
  readonly listAvailableCatalogs: (input: InstagramEdgeInput) => Promise<Page<JsonObject>>;
  /** Facebook Login only: tag-eligible products in a catalog (`catalog_product_search`). */
  readonly searchCatalogProducts: (
    input: InstagramEdgeInput & { readonly catalogId: string; readonly query?: string },
  ) => Promise<Page<JsonObject>>;
  /** Facebook Login only: product tags on published media. */
  readonly listProductTags: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  /** Facebook Login only: add product tags to published media, or move existing ones. */
  readonly updateProductTags: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly tags: readonly InstagramProductTag[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /**
   * Find the conversation with one person through `GET /{ig-user-id}/conversations?user_id=`,
   * using the Instagram-scoped ID (IGSID) from a messaging webhook. `undefined` when none exists.
   */
  readonly findConversation: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<ConversationRef | undefined>;
  readonly resumePublication: (
    account: ConnectedAccountRef,
    workflowId: string,
    context: AdapterOperationContext,
  ) => Promise<DeliveryOutcome>;
  /**
   * Facebook Login only: like a feed post, Reel, carousel, comment, or reply through
   * `POST /{ig-user-id}/likes`. Needs `instagram_manage_engagement`. Liking twice has no effect.
   */
  readonly like: (
    input: {
      readonly account: ConnectedAccountRef;
      readonly context: AdapterOperationContext;
    } & InstagramLikeTarget,
  ) => Promise<void>;
  /** Facebook Login only: remove a like through `DELETE /{ig-user-id}/likes`. */
  readonly unlike: (
    input: {
      readonly account: ConnectedAccountRef;
      readonly context: AdapterOperationContext;
    } & InstagramLikeTarget,
  ) => Promise<void>;
  /**
   * Facebook Login only: vote shares of the caption poll through
   * `GET /{ig-media-id}/poll_attachment`, or `undefined` when the media has no poll.
   */
  readonly getPollResults: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<InstagramPollResults | undefined>;
  /**
   * Facebook Login only: answers to the caption comment prompt through
   * `GET /{ig-media-id}/prompt_response`.
   */
  readonly listPromptResponses: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<InstagramPromptResponses>;
}

/** Exactly one of a media ID or a comment (or reply) ID. */
export type InstagramLikeTarget =
  | { readonly mediaId: string; readonly commentId?: never }
  | { readonly commentId: string; readonly mediaId?: never };

/** Input for the `GET /{ig-user-id}/tags` readers. */
export interface InstagramTagsInput {
  readonly account: ConnectedAccountRef;
  readonly cursor?: string;
  readonly limit?: number;
  /** ISO 8601 date-time, sent as `posted_after`. Only media posted strictly after it. */
  readonly postedAfter?: string;
  /** ISO 8601 date-time, sent as `posted_before`. Only media posted strictly before it. */
  readonly postedBefore?: string;
  readonly context: AdapterOperationContext;
}

export interface InstagramPollOption {
  readonly text: string;
  /** Share of all votes, from 0 to 1 (`option_<x>_votes_percentage`). */
  readonly votesPercentage: number;
}

export interface InstagramPollResults {
  /** Two to four options in `option_a` through `option_d` order. */
  readonly options: readonly InstagramPollOption[];
  readonly totalVotes: number;
  /** `expiration_timestamp`; absent when the poll does not expire. */
  readonly expiresAt?: string;
}

export interface InstagramPromptResponses extends Page<JsonObject> {
  /**
   * `false` when Meta returns `data: null`: the media has no comment prompt, or the owner
   * turned comments off. An empty page with `true` can still have a `nextCursor`.
   */
  readonly available: boolean;
}

export interface InstagramCopyrightCheck {
  /** Meta documents `completed`, `error`, `in_progress`, and `not_started`. */
  readonly status: string;
  readonly matchesFound: boolean;
  /** The provider object, including `copyright_matches` or match details when found. */
  readonly native: JsonObject;
}

export interface InstagramResumableUpload {
  readonly containerId: string;
  /** `https://rupload.facebook.com/ig-api-upload/<version>/<container-id>` */
  readonly uploadUri: string;
}

export interface InstagramEdgeInput {
  readonly account: ConnectedAccountRef;
  readonly cursor?: string;
  readonly limit?: number;
  readonly context: AdapterOperationContext;
}

export interface InstagramCollaborator {
  readonly id: string;
  readonly username?: string;
  /** Meta documents `Accepted` and `Pending`. */
  readonly inviteStatus?: string;
}

export type InstagramEventNotification =
  | "BEFORE_EVENT_2DAY"
  | "BEFORE_EVENT_1DAY"
  | "BEFORE_EVENT_1HOUR"
  | "BEFORE_EVENT_15MIN"
  | "EVENT_START"
  | "AFTER_EVENT_1DAY"
  | "AFTER_EVENT_2DAY"
  | "AFTER_EVENT_3DAY"
  | "AFTER_EVENT_4DAY"
  | "AFTER_EVENT_5DAY"
  | "AFTER_EVENT_6DAY"
  | "AFTER_EVENT_7DAY";

export interface InstagramUpcomingEvent {
  readonly title: string;
  /** ISO 8601 start time. */
  readonly startTime: string;
  /** ISO 8601 end time. Not allowed when `notificationTargetTime` is `EVENT_END`. */
  readonly endTime?: string;
  readonly notificationSubtypes?: readonly InstagramEventNotification[];
  readonly notificationTargetTime?: "EVENT_START" | "EVENT_END";
}

export interface InstagramSentMessage {
  readonly recipientId?: string;
  readonly messageId: string;
}

/** A `web_url` or `postback` button for templates and persistent menus. */
export type InstagramMessageButton =
  | { readonly kind: "web_url"; readonly title: string; readonly url: string }
  | { readonly kind: "postback"; readonly title: string; readonly payload: string };

export interface InstagramTemplateElement {
  /** Up to 80 characters. Set at least one other field as well. */
  readonly title: string;
  /** Up to 80 characters. */
  readonly subtitle?: string;
  readonly imageUrl?: string;
  /** Opens this URL when the element is tapped. */
  readonly defaultActionUrl?: string;
  /** Up to 3 buttons. */
  readonly buttons?: readonly InstagramMessageButton[];
}

/** Outgoing Instagram message bodies from the Instagram Login messaging guides. */
export type InstagramOutgoingMessage =
  | {
      readonly kind: "text";
      readonly text: string;
      /** Up to 13 text quick replies; titles over 20 characters are truncated by Instagram. */
      readonly quickReplies?: readonly { readonly title: string; readonly payload: string }[];
    }
  | {
      readonly kind: "images";
      /** 1 to 10 images by public URL or by `attachment_id` from Meta's Attachment Upload API. */
      readonly images: readonly ({ readonly url: string } | { readonly attachmentId: string })[];
    }
  | { readonly kind: "audio" | "video" | "file"; readonly url: string }
  | { readonly kind: "like_heart" }
  | { readonly kind: "media_share"; readonly mediaId: string }
  | { readonly kind: "generic_template"; readonly elements: readonly InstagramTemplateElement[] }
  | {
      readonly kind: "button_template";
      /** Up to 640 characters. */
      readonly text: string;
      /** 1 to 3 buttons. */
      readonly buttons: readonly InstagramMessageButton[];
    };

export interface InstagramIceBreakers {
  readonly locale?: string;
  /** Up to 4 questions. */
  readonly questions: readonly { readonly question: string; readonly payload: string }[];
}

export interface InstagramPersistentMenu {
  /** `default`, or a locale such as `zh_CN`. */
  readonly locale: string;
  readonly items: readonly InstagramMessageButton[];
}

export interface InstagramMessagingProfile {
  readonly id: string;
  readonly name?: string;
  readonly username?: string;
  readonly profilePic?: string;
  readonly followerCount?: number;
  readonly isUserFollowBusiness?: boolean;
  readonly isBusinessFollowUser?: boolean;
  readonly isVerifiedUser?: boolean;
}

export interface InstagramInsightBreakdown {
  readonly dimensionKeys: readonly string[];
  readonly results: readonly {
    readonly dimensionValues: readonly string[];
    readonly value: number;
    readonly endTime?: string;
  }[];
}

/** One insights row. Absent values stay absent; Meta returns no row instead of zero. */
export interface InstagramInsight {
  readonly name: string;
  readonly period?: string;
  /** `values[]` entries for lifetime media metrics and `time_series` account metrics. */
  readonly values?: readonly { readonly value: number; readonly endTime?: string }[];
  /** `total_value` for `total_value` account metrics and breakdown requests. */
  readonly totalValue?: {
    readonly value?: number;
    readonly breakdowns?: readonly InstagramInsightBreakdown[];
  };
}

export interface InstagramWorkflow {
  readonly id: string;
  readonly backend: string;
  readonly accountId: string;
  readonly childIds: readonly string[];
  readonly parentId?: string;
  readonly nativeId?: string;
  /**
   * Warnings from the `media_publish` response, such as `config_issue`. Meta cannot return them
   * again later, so the workflow keeps them for status reads and resumed publications.
   */
  readonly publishIssues?: readonly PreparationIssue[];
  readonly caption: string;
  readonly shareToFeed?: boolean;
  /** Validated carousel parent container fields, such as `collaborators` or `location_id`. */
  readonly parentFields?: JsonObject;
  readonly stage: "children" | "parent" | "published" | "unknown" | "failed";
}

export interface InstagramWorkflowStore {
  create(input: Omit<InstagramWorkflow, "id">): Promise<InstagramWorkflow>;
  get(id: string): Promise<InstagramWorkflow | undefined>;
  update(id: string, update: Partial<InstagramWorkflow>): Promise<InstagramWorkflow>;
  /** Atomically claim a workflow for continuation. */
  claim(id: string): Promise<boolean>;
  /** Release a transient continuation claim after the operation settles. */
  release?(id: string): Promise<void>;
}

class MemoryInstagramWorkflowStore implements InstagramWorkflowStore {
  private readonly workflows = new Map<string, InstagramWorkflow>();
  private readonly claims = new Set<string>();
  async create(input: Omit<InstagramWorkflow, "id">): Promise<InstagramWorkflow> {
    const workflow = { ...input, id: `igwf_${globalThis.crypto.randomUUID()}` };
    this.workflows.set(workflow.id, workflow);

    return workflow;
  }
  async get(id: string) {
    return this.workflows.get(id);
  }
  async update(id: string, update: Partial<InstagramWorkflow>) {
    const current = this.workflows.get(id);

    if (!current) throw new Error("Instagram workflow not found");
    const next = { ...current, ...update, id };
    this.workflows.set(id, next);

    return next;
  }
  async claim(id: string) {
    if (!this.workflows.has(id) || this.claims.has(id)) return false;
    this.claims.add(id);

    return true;
  }
  async release(id: string) {
    this.claims.delete(id);
  }
}

export function instagram(
  options: InstagramOptions,
): import("../core/adapter.js").SocialAdapter<InstagramNative> {
  // Graph v27.0. Changelogs checked 2026-11-04 for the v26.0 -> v27.0 move:
  // https://developers.facebook.com/blog/post/2026/11/04/introducing-graph-api-v27-and-marketing-api-v27
  // and https://developers.facebook.com/docs/instagram-platform/changelog (newest entry
  // 2026-07-30). v27.0 lists no Instagram endpoint, field, permission or webhook change. Of the
  // legacy features it closes to new apps, this adapter sends none (`ids`, `date_format`,
  // `method`, field aliases, `callback`, `asyncbatch`).
  const apiVersion = "v27.0";
  const flavor = options.auth.flavor ?? "instagram-login";

  const origin =
    flavor === "facebook-login"
      ? `https://graph.facebook.com/${apiVersion}`
      : `https://graph.instagram.com/${apiVersion}`;

  const graphRequest = managedHttp(origin, {
    apiKey: options.auth.accessToken,
    ...definedFields({ fetch: options.fetch }),
  });

  const request: typeof graphRequest = async (...args) => {
    try {
      return await graphRequest(...args);
    } catch (error) {
      if (error instanceof SocialError) throw metaOAuthReconnect(error);

      throw error;
    }
  };

  const now = () => (options.clock?.() ?? new Date()).toISOString();
  const workflows = options.workflowStore ?? new MemoryInstagramWorkflowStore();

  const validatedObject = (value: JsonField, operation: string): JsonObject => {
    try {
      return object(value);
    } catch (error) {
      if (error instanceof HttpError && error.kind === "invalid-response")
        throw new SocialError({
          code: "upstream_failure",
          operation,
          message: error.message,
          cause: error,
        });
      throw error;
    }
  };

  const requireFacebookLogin = (operation: string) => {
    if (flavor !== "facebook-login")
      throw new SocialError({
        code: "unsupported_capability",
        operation,
        message: `${operation} requires a Facebook Login Graph API access token for an Instagram professional account.`,
        retryDisposition: { kind: "never" },
      });
  };

  const numericId = (value: string, operation: string, label: string): string => {
    if (!/^\d{1,32}$/.test(value)) invalidOption(operation, `${label} must be a numeric Graph ID.`);

    return value;
  };

  /**
   * Like or unlike media or a comment. Facebook Login only, with `instagram_manage_engagement`;
   * Meta locks the account out for an hour after more than 50 calls in 5 seconds. Source:
   * https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/user-likes
   * (Graph v26.0, checked 2026-11-04).
   */
  const setLike = async (
    input: {
      readonly account: ConnectedAccountRef;
      readonly context: AdapterOperationContext;
    } & InstagramLikeTarget,
    method: "POST" | "DELETE",
  ): Promise<void> => {
    const operation = "instagram.likes.write";

    authorize(input.account, input.context);
    requireFacebookLogin(operation);

    const target =
      input.mediaId !== undefined && input.commentId === undefined
        ? { media_id: numericId(input.mediaId, operation, "mediaId") }
        : input.commentId !== undefined && input.mediaId === undefined
          ? { comment_id: numericId(input.commentId, operation, "commentId") }
          : invalidOption(operation, "Pass exactly one of mediaId or commentId.");

    const result: JsonValue = await request(
      `/${encodeURIComponent(input.account.accountId)}/likes`,
      input.context,
      undefined,
      target,
      method,
    );

    if (!isJsonObject(result) || result["success"] !== true)
      throw new SocialError({
        code: "ambiguous_outcome",
        operation,
        message: `Instagram did not confirm the ${method === "POST" ? "like" : "unlike"}. Read the object before retrying.`,
        retryDisposition: { kind: "reconcile-first" },
      });
  };

  // Meta's Instagram Login mentions guide lists only GET /{ig-user-id}/tags and
  // POST /{ig-user-id}/mentions. The mentioned_media and mentioned_comment field
  // expansions are documented for Facebook Login only. Sources, accessed 2026-09-24
  // against Graph API v25.0:
  // https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/mentions
  // https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/mentions
  // https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/tags
  // https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/mentioned_media
  const requireFacebookLoginForMentionLookup = (field: "mentioned_media" | "mentioned_comment") => {
    if (flavor !== "facebook-login")
      throw new SocialError({
        code: "unsupported_capability",
        operation: "instagram.mentions.read",
        message: `Instagram ${field} lookups require a Facebook Login Graph API access token. Instagram Login supports only the /{ig-user-id}/tags mentions edge.`,
        retryDisposition: { kind: "never" },
      });
  };

  // Meta documents `DELETE /{ig-media-id}` for Instagram API with Facebook Login only.
  // Source: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media
  // (accessed 2026-09-24, Graph API v25.0).
  const deleteMedia = async (
    mediaId: string,
    context: AdapterOperationContext,
    operation: "instagram.posts.delete" | "instagram.posts.removeFromPlatform",
  ): Promise<void> => {
    if (flavor !== "facebook-login")
      throw new SocialError({
        code: "unsupported_capability",
        operation,
        message: `${operation} is not supported with Instagram Login. Meta supports media deletion only through Instagram API with Facebook Login.`,
        retryDisposition: { kind: "never" },
      });

    const result: unknown = await request(
      `/${encodeURIComponent(mediaId)}`,
      context,
      undefined,
      {},
      "DELETE",
    );

    const confirmed = isJsonValue(result) && isJsonObject(result) ? result["success"] : undefined;

    if (confirmed !== true)
      throw new SocialError({
        code: "ambiguous_outcome",
        operation,
        message: "Instagram did not confirm the media deletion. Reconcile before retrying.",
        retryDisposition: { kind: "reconcile-first" },
      });
  };

  const pageLimit = (limit: number | undefined, max = 50) => {
    const value = limit ?? 25;

    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new SocialError({
        code: "invalid_input",
        operation: "instagram.pagination",
        message: `Instagram page limit must be an integer from 1 through ${max}.`,
      });

    return value;
  };

  const page = (
    result: JsonObject,
    fields: readonly string[],
    cursorOnly = false,
  ): Page<JsonObject> => {
    const items = array(result["data"]).map((entry) => publicFields(entry, fields));
    const paging = result["paging"] === undefined ? {} : object(result["paging"]);
    const cursors = paging["cursors"] === undefined ? {} : object(paging["cursors"]);

    // Graph API omits `paging.next` on the last page even when `cursors.after` is present.
    const nextCursor =
      (cursorOnly || isString(paging["next"])) &&
      (!cursorOnly || items.length > 0) &&
      isString(cursors["after"]) &&
      cursors["after"].length > 0
        ? cursors["after"]
        : undefined;

    return { items, ...definedFields({ nextCursor }) };
  };

  /** Keep the requested fields, including nested author, participant, and attachment records. */
  const recordPage = (
    result: JsonObject,
    fields: readonly string[],
    normalize: (record: JsonObject) => JsonObject,
    cursorOnly = true,
  ): Page<JsonObject> => {
    const listed = page(result, [], cursorOnly);

    const items = array(result["data"]).map((entry) => {
      const data = object(entry);
      const record: Record<string, JsonValue> = {};

      for (const field of fields) {
        const value = data[field];

        if (value !== undefined) record[field] = value;
      }

      return normalize(record);
    });

    return { items, ...definedFields({ nextCursor: listed.nextCursor }) };
  };

  const authorize = (
    ref: { backend: string; platform: string; accountId: string },
    context: AdapterOperationContext,
  ) => {
    if (
      ref.backend !== context.backendInstance ||
      ref.platform !== "instagram" ||
      ref.accountId !== options.auth.accountId
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "instagram",
        message: "Account reference does not match this Instagram authorization.",
      });
  };

  const status = async (id: string, context: AdapterOperationContext) =>
    object(
      await request(`/${encodeURIComponent(id)}`, context, undefined, {
        fields: "id,status_code,status",
      }),
    );

  const listPosts = async (
    selected: ConnectedAccountRef,
    input: { readonly cursor?: string; readonly limit?: number },
    context: AdapterOperationContext,
  ) => {
    authorize(selected, context);

    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "posts.list",
        message: "Instagram feed limit must be an integer from 1 through 100.",
      });

    const query = {
      fields: mediaReadFields.join(","),
      ...definedFields({
        after: input.cursor,
        limit: input.limit === undefined ? undefined : String(input.limit),
      }),
    };

    const result = object(
      await request(`/${encodeURIComponent(selected.accountId)}/media`, context, undefined, query),
    );

    const items = array(result["data"]).map((entry) => publicFields(entry, mediaReadFields));

    const paging = result["paging"] === undefined ? {} : object(result["paging"]);
    const cursors = paging["cursors"] === undefined ? {} : object(paging["cursors"]);
    const hasNext = isString(paging["next"]) && paging["next"].length > 0;
    const nextCursor = hasNext ? optionalString(cursors["after"]) : undefined;

    return {
      items,
      ...definedFields({ nextCursor }),
    };
  };

  const getAccountMetrics = async (
    selected: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<readonly MetricValue[]> => {
    authorize(selected, context);

    const result = object(
      await request(
        flavor === "facebook-login" ? `/${encodeURIComponent(selected.accountId)}` : "/me",
        context,
        undefined,
        {
          fields:
            flavor === "facebook-login"
              ? "id,followers_count,media_count"
              : "user_id,followers_count,media_count",
        },
      ),
    );

    const id = optionalString(result["user_id"]) ?? optionalString(result["id"]);

    if (id !== selected.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation: "analytics.read",
        message: "Instagram returned metrics for a different account.",
      });

    const metrics: readonly MetricValue[] = (["followers_count", "media_count"] as const).flatMap(
      (name) => {
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
                source: `${flavor === "facebook-login" ? "Facebook Login" : "Instagram Login"} Graph ${apiVersion}`,
              },
            ];
      },
    );

    return normalizeMetrics(metrics);
  };

  const publishContainer = async (
    account: ConnectedAccountRef,
    containerId: string,
    context: AdapterOperationContext,
    workflowId?: string,
  ): Promise<DeliveryOutcome> => {
    authorize(account, context);

    if (workflowId) {
      const workflow = await workflows.get(workflowId);

      if (workflow?.nativeId) return publishedWorkflow(account, workflow, workflow.nativeId);
    }

    const state = await status(containerId, context);
    const code = string(state["status_code"]);

    const base = {
      account,
      targetIndex: 0,
      observedAt: now(),
      backendState: code,
      delivery: {
        kind: "delivery" as const,
        version: 1 as const,
        backend: account.backend,
        platform: "instagram",
        accountId: account.accountId,
        deliveryId: workflowId ?? containerId,
      },
    };

    if (code === "IN_PROGRESS") return { ...base, state: "processing" };

    if (code === "ERROR" || code === "EXPIRED")
      return {
        ...base,
        state: "failed",
        code: "media_error",
        message: "Instagram container failed or expired before publication.",
        retryDisposition: { kind: "never" },
      };

    if (code === "PUBLISHED")
      return {
        ...base,
        state: "unknown",
        reason: "unmapped-state",
        diagnostic:
          "Instagram reports a published container but the native media ID was not persisted by this workflow.",
      };

    if (code !== "FINISHED")
      return {
        ...base,
        state: "unknown",
        reason: "unmapped-state",
        diagnostic:
          "Container is already published or has an unmapped state. No repeated publish was dispatched.",
      };

    if (workflowId) await workflows.update(workflowId, { stage: "unknown" });
    let result: JsonObject;

    try {
      result = object(
        await request(`/${encodeURIComponent(account.accountId)}/media_publish`, context, {
          creation_id: containerId,
        }),
      );
    } catch (error) {
      if (workflowId) await workflows.update(workflowId, { stage: "unknown" });
      throw error;
    }

    const nativeId = string(result["id"]);
    const issues = publishIssues(result);

    const outcome: DeliveryOutcome = {
      ...base,
      state: "published",
      backendState: "PUBLISHED",
      post: {
        kind: "platform-post",
        version: 1,
        backend: account.backend,
        platform: "instagram",
        accountId: account.accountId,
        postId: nativeId,
      },
      ...definedFields({ issues: issues.length === 0 ? undefined : issues }),
    };

    if (workflowId) {
      try {
        await workflows.update(workflowId, {
          nativeId,
          stage: "published",
          parentId: containerId,
          ...definedFields({ publishIssues: issues.length === 0 ? undefined : issues }),
        });
      } catch {
        // Publication is confirmed, but callers must repair the workflow before relying on it.
        return { ...outcome, backendState: "PUBLISHED_WORKFLOW_SAVE_FAILED" };
      }
    }

    return outcome;
  };

  const processing = (
    account: ConnectedAccountRef,
    workflowId: string,
    backendState: string,
  ): DeliveryOutcome => ({
    state: "processing",
    targetIndex: 0,
    account,
    observedAt: now(),
    backendState,
    delivery: {
      kind: "delivery",
      version: 1,
      backend: account.backend,
      platform: "instagram",
      accountId: account.accountId,
      deliveryId: workflowId,
    },
  });

  /** The published outcome of a workflow, with the warnings its `media_publish` returned. */
  const publishedWorkflow = (
    account: ConnectedAccountRef,
    workflow: InstagramWorkflow,
    nativeId: string,
  ): DeliveryOutcome => ({
    ...processing(account, workflow.id, "PUBLISHED"),
    state: "published",
    post: {
      kind: "platform-post",
      version: 1,
      backend: account.backend,
      platform: "instagram",
      accountId: account.accountId,
      postId: nativeId,
    },
    ...definedFields({
      issues: workflow.publishIssues?.length ? workflow.publishIssues : undefined,
    }),
  });

  const continueWorkflow = async (
    workflow: InstagramWorkflow,
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<DeliveryOutcome> => {
    if (workflow.nativeId) return publishedWorkflow(account, workflow, workflow.nativeId);

    if (workflow.stage === "unknown")
      return {
        ...processing(account, workflow.id, "AMBIGUOUS"),
        state: "unknown",
        reason: "ambiguous-submission",
        diagnostic: "Instagram publish acceptance is unknown; no replay was attempted.",
      };

    if (workflow.parentId)
      return publishContainer(account, workflow.parentId, context, workflow.id);

    for (const child of workflow.childIds) {
      const childStatus = await status(child, context);
      const code = string(childStatus["status_code"]);

      if (code !== "FINISHED") return processing(account, workflow.id, code);
    }

    await workflows.update(workflow.id, { stage: "unknown" });

    const parent = object(
      await request(`/${encodeURIComponent(account.accountId)}/media`, context, {
        media_type: "CAROUSEL",
        children: workflow.childIds.join(","),
        caption: workflow.caption,
        ...definedFields({ share_to_feed: workflow.shareToFeed }),
        ...workflow.parentFields,
      }),
    );

    const parentId = string(parent["id"]);
    await workflows.update(workflow.id, { parentId, stage: "parent" });

    return publishContainer(account, parentId, context, workflow.id);
  };

  const resumeWorkflow = async (
    workflow: InstagramWorkflow,
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ) => {
    if (!(await workflows.claim(workflow.id))) return processing(account, workflow.id, "CLAIMED");

    try {
      const current = (await workflows.get(workflow.id)) ?? workflow;

      return await continueWorkflow(current, account, context);
    } finally {
      await workflows.release?.(workflow.id);
    }
  };

  /** Validated container fields for a normalized target: the single container or carousel parent. */
  const containerPlan = (target: PreparedPublishTarget): JsonObject => {
    const media = target.content.media ?? [];
    let raw: JsonObject;

    try {
      raw = optionsObject(target);
    } catch {
      return invalidOption("instagram.posts.publish", "Instagram options must be a JSON object.");
    }

    const kind: InstagramContainerKind =
      media.length > 1 ? "carousel" : media[0]?.kind === "video" ? "reel" : "image";

    return instagramContainerFields({
      options: decodeInstagramPublishOptions(raw),
      kind,
      flavor,
      caption: target.content.text ?? "",
      operation: "instagram.posts.publish",
    });
  };

  const saveNativeContainer = async (
    workflowId: string,
    containerId: string,
  ): Promise<InstagramWorkflow> => {
    try {
      return await workflows.update(workflowId, { parentId: containerId, stage: "parent" });
    } catch (cause) {
      throw new SocialError({
        code: "upstream_failure",
        operation: "instagram.posts.persist-container",
        message:
          "Instagram container was created but its workflow could not be saved. Repair the workflow before resuming publication.",
        retryDisposition: { kind: "reconcile-first" },
        details: { workflowId, containerId },
        cause,
      });
    }
  };

  const readAccount = async (context: AdapterOperationContext) => {
    const response = object(
      await request(
        flavor === "facebook-login" ? `/${encodeURIComponent(options.auth.accountId)}` : "/me",
        context,
        undefined,
        {
          fields:
            flavor === "facebook-login"
              ? "id,username,account_type"
              : "user_id,username,account_type",
        },
      ),
    );

    const id = optionalString(response["user_id"]) ?? optionalString(response["id"]);

    if (id !== options.auth.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation: "accounts.read",
        message:
          "Instagram returned an account different from the configured professional account.",
      });

    return {
      ref: {
        kind: "connected-account" as const,
        version: 1 as const,
        backend: context.backendInstance,
        platform: "instagram",
        accountId: id,
      },
      displayName: string(response["username"]),
      status: "connected" as const,
    };
  };

  const tagFields = [
    "id",
    "caption",
    "media_type",
    "permalink",
    "timestamp",
    "username",
    ...(flavor === "facebook-login" ? ["media_product_type"] : []),
  ];

  const commentScopes =
    flavor === "facebook-login"
      ? ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"]
      : ["instagram_business_basic", "instagram_business_manage_comments"];

  // Unified Login sends messaging to graph.facebook.com/{ig-user-id} with a Business
  // Integration System User token and the instagram_* permissions. Source (checked 2026-11-04):
  // https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/migration-guide
  const messageScopes =
    flavor === "facebook-login"
      ? ["instagram_basic", "instagram_manage_messages"]
      : ["instagram_business_basic", "instagram_business_manage_messages"];

  const insightScopes =
    flavor === "facebook-login"
      ? ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"]
      : ["instagram_business_basic", "instagram_business_manage_insights"];

  /**
   * `posted_after` and `posted_before` bound the tags edge by post time. Meta filters each
   * page after selecting it, so a short or empty page can still have a next cursor.
   * Source: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/tags
   * (Graph v26.0, checked 2026-11-04).
   */
  const tagsWindow = (postedAfter: string | undefined, postedBefore: string | undefined) => {
    const operation = "instagram.mentions.read";

    const after =
      postedAfter === undefined ? undefined : isoTime(postedAfter, operation, "postedAfter");

    const before =
      postedBefore === undefined ? undefined : isoTime(postedBefore, operation, "postedBefore");

    if (after !== undefined && before !== undefined && Date.parse(before) <= Date.parse(after))
      invalidOption(operation, "postedBefore must be later than postedAfter.");

    return definedFields({ posted_after: after, posted_before: before });
  };

  const listMentions: InstagramNative["listMentions"] = async ({
    account,
    cursor,
    limit,
    postedAfter,
    postedBefore,
    context,
  }) => {
    authorize(account, context);

    // Both login flavors expose GET /{ig-user-id}/tags; only the host and scopes differ.
    const query = {
      fields: tagFields.join(","),
      limit: String(pageLimit(limit)),
      ...definedFields({ after: cursor }),
      ...tagsWindow(postedAfter, postedBefore),
    };

    const result = validatedObject(
      await request(`/${encodeURIComponent(account.accountId)}/tags`, context, undefined, query),
      "instagram.mentions.read",
    );

    return page(result, tagFields, true);
  };

  // Field lists from the IG Comment, Conversation, and Message references (Graph v25.0,
  // accessed 2026-10-24):
  // https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment
  // https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/conversations-api
  const commentFields = [
    "id",
    "text",
    "timestamp",
    "username",
    "from",
    "parent_id",
    "like_count",
  ] as const;

  const conversationFields = ["id", "participants", "updated_time"] as const;

  const messageFields = ["id", "message", "from", "to", "created_time", "attachments"] as const;

  /** Cursors are interpolated into a field expansion, so only opaque cursor characters pass. */
  const expansionCursor = (cursor: string) => {
    if (!/^[A-Za-z0-9_\-=+/%.]{1,2048}$/.test(cursor))
      throw new SocialError({
        code: "invalid_input",
        operation: "instagram.messages.read",
        message: "Instagram message cursor is malformed.",
        retryDisposition: { kind: "never" },
      });

    return cursor;
  };

  const listConversations = async (
    account: ConnectedAccountRef,
    input: { readonly cursor?: string; readonly limit?: number },
    context: AdapterOperationContext,
  ): Promise<Page<JsonObject>> => {
    authorize(account, context);
    const limit = input.limit === undefined ? undefined : pageLimit(input.limit, 100);

    const result = validatedObject(
      await request(`/${encodeURIComponent(account.accountId)}/conversations`, context, undefined, {
        platform: "instagram",
        fields: conversationFields.join(","),
        ...definedFields({ after: input.cursor, limit: limit?.toString() }),
      }),
      "instagram.messages.read",
    );

    return recordPage(result, conversationFields, normalizeConversation);
  };

  const listMessages = async (
    conversation: ConversationRef,
    input: { readonly cursor?: string; readonly limit?: number },
    context: AdapterOperationContext,
  ): Promise<Page<JsonObject>> => {
    authorize(conversation, context);
    const limit = input.limit === undefined ? undefined : pageLimit(input.limit, 100);
    const cursor = input.cursor === undefined ? undefined : expansionCursor(input.cursor);

    const result = validatedObject(
      await request(`/${encodeURIComponent(conversation.conversationId)}`, context, undefined, {
        fields: `messages${limit === undefined ? "" : `.limit(${limit})`}${cursor === undefined ? "" : `.after(${cursor})`}{${messageFields.join(",")}}`,
      }),
      "instagram.messages.read",
    );

    const messages = result["messages"];

    if (messages === undefined)
      throw new SocialError({
        code: "upstream_failure",
        operation: "instagram.messages.read",
        message: "Instagram returned no messages connection for the conversation.",
      });

    return recordPage(object(messages), messageFields, normalizeMessage);
  };

  /**
   * Resolve the single other participant of an authorized conversation. A
   * conversation ID is never a recipient ID, so group, self-only, and
   * unidentifiable conversations are rejected instead of guessed.
   */
  const conversationRecipient = async (
    conversation: ConversationRef,
    context: AdapterOperationContext,
  ): Promise<string> => {
    const result = validatedObject(
      await request(`/${encodeURIComponent(conversation.conversationId)}`, context, undefined, {
        fields: "participants",
      }),
      "instagram.messages.write",
    );

    const participants = result["participants"];

    const entries = isJsonObject(participants)
      ? (optionalArray(participants["data"]) ?? [])
      : (optionalArray(participants) ?? []);

    const ids = entries.flatMap((entry) => {
      const id = isJsonObject(entry) ? optionalString(entry["id"]) : undefined;

      return id === undefined || id === "" ? [] : [id];
    });

    const others = [...new Set(ids)].filter((id) => id !== conversation.accountId);

    if (
      ids.length !== entries.length ||
      !ids.includes(conversation.accountId) ||
      others.length !== 1
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "instagram.messages.write",
        message:
          "The Instagram conversation must have exactly one identifiable participant besides this account. Use native.sendMessage with an explicit recipient ID.",
        retryDisposition: { kind: "never" },
      });

    const [recipient] = others;

    if (recipient === undefined)
      throw new SocialError({
        code: "invalid_input",
        operation: "instagram.messages.write",
        message: "The Instagram conversation has no recipient.",
        retryDisposition: { kind: "never" },
      });

    return recipient;
  };

  const messengerProfile = (account: ConnectedAccountRef) =>
    `/${encodeURIComponent(account.accountId)}/messenger_profile`;

  const confirmProfileWrite = (result: JsonValue) => {
    if (!isJsonObject(result) || result["success"] !== true)
      throw new SocialError({
        code: "ambiguous_outcome",
        operation: messageOperation,
        message:
          "Instagram did not confirm the messaging profile change. Read it back before retrying.",
        retryDisposition: { kind: "reconcile-first" },
      });
  };

  const sendMessage = async ({
    account,
    recipientId,
    text,
    context,
  }: {
    readonly account: ConnectedAccountRef;
    readonly recipientId: string;
    readonly text: string;
    readonly context: AdapterOperationContext;
  }): Promise<JsonObject> => {
    authorize(account, context);

    if (!text.trim())
      throw new SocialError({
        code: "invalid_input",
        operation: "instagram.messages.write",
        message: "Instagram messages require non-empty text.",
      });

    if (new TextEncoder().encode(text).byteLength > 1000)
      throw new SocialError({
        code: "invalid_input",
        operation: "instagram.messages.write",
        message: "Instagram message text must be 1,000 UTF-8 bytes or fewer.",
      });

    return validatedObject(
      await request(`/${encodeURIComponent(account.accountId)}/messages`, context, {
        recipient: { id: recipientId },
        message: { text },
      }),
      "instagram.messages.write",
    );
  };

  // Audio fields from the Instagram Audio API guide (Graph v26.0, checked 2026-11-04):
  // https://developers.facebook.com/documentation/instagram-platform/content-publishing/audio-api
  // Field lists from the IG Media, IG User stories, live_media, and collaboration references
  // (Graph v26.0, checked 2026-11-04). Fields Meta marks Facebook Login-only are requested
  // only on that flavor.
  const mediaReadFields = [
    "id",
    "caption",
    "media_type",
    "media_product_type",
    "media_url",
    "thumbnail_url",
    "permalink",
    "shortcode",
    "timestamp",
    "username",
    "like_count",
    "comments_count",
    "is_comment_enabled",
    "is_shared_to_feed",
    "media_audio_type",
  ];

  // `total_views_count` is Facebook Login-only and, like the owner counters, top-level only.
  const ownerCounterFields =
    flavor === "facebook-login"
      ? ["saved_count", "shares_count", "reposts_count", "total_views_count"]
      : [];

  const childFields = ["id", "media_type", "media_url", "thumbnail_url", "timestamp", "username"];

  const storyFields = [
    "id",
    "caption",
    "media_type",
    "media_product_type",
    "media_url",
    "thumbnail_url",
    "permalink",
    "timestamp",
    "username",
  ];

  const liveFields = ["id", "media_type", "media_product_type", "username", "timestamp"];

  const collaborativeFields = [
    "id",
    "caption",
    "media_type",
    "media_url",
    "permalink",
    "timestamp",
    "username",
    "total_like_count",
    "total_comments_count",
  ];

  const facebookGraphRequest = managedHttp(`https://graph.facebook.com/${apiVersion}`, {
    apiKey: options.auth.accessToken,
    ...definedFields({ fetch: options.fetch }),
  });

  const edgePage = async (input: {
    readonly account: ConnectedAccountRef;
    /** The IG User edge path, such as `/stories`. */
    readonly edge: `/${string}`;
    readonly fields: readonly string[];
    readonly operation: string;
    readonly query: Readonly<Record<string, string>>;
    readonly context: AdapterOperationContext;
    readonly cursorOnly?: boolean;
  }): Promise<Page<JsonObject>> =>
    page(
      validatedObject(
        await request(
          `/${encodeURIComponent(input.account.accountId)}${input.edge}`,
          input.context,
          undefined,
          { fields: input.fields.join(","), ...input.query },
        ),
        input.operation,
      ),
      input.fields,
      input.cursorOnly,
    );

  const edgeQuery = (cursor: string | undefined, limit: number | undefined) =>
    definedFields({
      after: cursor,
      limit: limit === undefined ? undefined : String(pageLimit(limit)),
    });

  const audioFields = [
    "audio_id",
    "title",
    "audio_type",
    "display_artist",
    "duration_in_ms",
    "cover_artwork_thumbnail_uri",
    "download_url",
    "ig_username",
    "profile_picture_url",
    "is_ads_eligible",
    "on_platform_audio_preview_link",
  ];

  const profileFields = [
    "id",
    "username",
    "name",
    "biography",
    "profile_picture_url",
    "followers_count",
    "follows_count",
    "media_count",
    "website",
    "has_profile_pic",
    "is_published",
  ] as const;

  // `has_profile_pic` and `is_published` are own-account status fields on the IG User node
  // (Graph v26.0, checked 2026-11-04), so other-profile reads do not request them.
  const ownProfileFields =
    "username,name,biography,profile_picture_url,followers_count,follows_count,media_count,website,has_profile_pic,is_published";

  return defineAdapter({
    id: "instagram",
    capabilities: {
      schemaVersion: 1 as const,
      backend: "instagram",
      apiRevision: `${flavor === "facebook-login" ? "Facebook Login" : "Instagram Login"} Graph ${apiVersion}`,
      runtime: ["node22", "node24", "bun"],
      capabilities: [
        {
          platform: "instagram",
          operation: "posts.publish",
          availability: "available" as const,
          formats: ["image" as const, "video" as const, "carousel" as const],
          requiredScopes:
            flavor === "facebook-login"
              ? ["instagram_basic", "instagram_content_publish", "pages_read_engagement"]
              : ["instagram_business_basic", "instagram_business_content_publish"],
          // Mirrors prepareTarget: 1-20 public HTTPS items, JPEG images, MP4 or MOV video.
          constraints: {
            mediaSources: ["https-url" as const],
            maxItems: 20,
            allowedMimeTypes: ["image/jpeg", "video/mp4", "video/quicktime"],
          },
          notes:
            "Professional accounts, public HTTPS media, explicit native continuation for processing containers. Carousels must have matching aspect ratios to avoid upstream cropping.",
        },
        {
          platform: "instagram",
          operation: "posts.schedule",
          availability: "unsupported-by-platform" as const,
          notes:
            "The content publishing API has no publish-time parameter; media_publish publishes immediately and unpublished containers expire after 24 hours.",
        },
        {
          platform: "instagram",
          operation: "posts.update",
          availability: "unsupported-by-platform" as const,
          notes: "Instagram Graph API does not provide an edit endpoint for published media.",
        },
        ...[
          "accounts.read",
          "posts.list",
          "posts.read",
          "posts.status",
          "analytics.account.read",
        ].map((operation) => ({
          operation,
          platform: "instagram",
          availability: "available" as const,
        })),
        ...["comments.read", "comments.write"].map((operation) => ({
          platform: "instagram",
          operation,
          availability: "available" as const,
          requiredScopes: commentScopes,
        })),
        {
          platform: "instagram",
          operation: "analytics.read",
          availability: "available" as const,
          requiredScopes: insightScopes,
        },
        {
          platform: "instagram",
          operation: "comments.moderate",
          availability: "available" as const,
          requiredScopes: commentScopes,
          notes:
            "Hide or unhide a comment, or enable or disable comments on media. Instagram Login and Facebook Login are supported where the account and app permissions qualify.",
        },
        {
          platform: "instagram",
          operation: "comments.delete",
          availability: "available" as const,
          requiredScopes: commentScopes,
        },
        {
          platform: "instagram",
          operation: "comments.replies.read",
          availability: "available" as const,
          requiredScopes: commentScopes,
        },
        {
          platform: "instagram",
          operation: "profiles.read",
          availability: "available" as const,
          requiredScopes:
            flavor === "facebook-login"
              ? ["instagram_basic", "pages_read_engagement"]
              : ["instagram_business_basic"],
        },
        {
          platform: "instagram",
          operation: "reels.publish",
          availability: "available" as const,
          formats: ["video" as const],
        },
        { platform: "instagram", operation: "stories.publish", availability: "available" as const },
        {
          platform: "instagram",
          operation: "profile.update",
          availability: "unsupported-by-platform" as const,
          notes: "The IG User node supports reads only. Updating it is not supported.",
        },

        ...(["posts.delete", "posts.removeFromPlatform"] as const).map((operation) =>
          flavor === "facebook-login"
            ? {
                platform: "instagram",
                operation,
                availability: "available" as const,
                requiredScopes: ["instagram_basic", "instagram_manage_contents"],
                notes:
                  "Deletes non-ad posts, Stories, Reels, and whole carousel albums through DELETE /{ig-media-id}. Individual carousel children cannot be deleted.",
              }
            : {
                platform: "instagram",
                operation,
                availability: "unsupported-by-platform" as const,
                notes:
                  "Meta documents media deletion for Instagram API with Facebook Login only. See https://developers.facebook.com/docs/instagram-platform/reference/instagram-media",
              },
        ),

        ...(flavor === "facebook-login"
          ? [
              {
                platform: "instagram",
                operation: "hashtags.search",
                availability: "available" as const,
                requiredScopes: ["instagram_basic"],
                notes:
                  "Requires Facebook Login, Instagram Public Content Access feature approval, and a qualifying Instagram professional account.",
              },
            ]
          : []),
        {
          platform: "instagram",
          operation: "publishing.limit.read",
          availability: "available" as const,
        },
        {
          platform: "instagram",
          operation: "mentions.read",
          availability: "available" as const,
          requiredScopes:
            flavor === "facebook-login"
              ? ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"]
              : ["instagram_business_basic", "instagram_business_manage_comments"],
          notes:
            flavor === "facebook-login"
              ? "Reads the paginated /{ig-user-id}/tags edge. Native mentionedMedia and mentionedComment look up single @mentions. Story mentions and private media are not returned."
              : "Reads the paginated /{ig-user-id}/tags edge on graph.instagram.com. mentionedMedia and mentionedComment require Facebook Login. Story mentions and private media are not returned.",
        },
        flavor === "instagram-login"
          ? {
              platform: "instagram",
              operation: "product.tagging",
              availability: "unsupported-by-platform" as const,
              notes: "Product tagging is unavailable with Instagram Login.",
            }
          : {
              platform: "instagram",
              operation: "product.tagging",
              availability: "available" as const,
              requiredScopes: [
                "instagram_basic",
                "catalog_management",
                "instagram_shopping_tag_products",
              ],
              notes:
                "Native catalog search, eligibility, product tag reads and updates, and productTags publish options. Needs an approved Instagram Shop and an admin role on the owning Business Manager.",
            },
        {
          platform: "instagram",
          operation: "messages.read",
          availability: "available" as const,
          requiredScopes: messageScopes,
          notes: `Reads conversations with participants and messages with sender, recipients, text, timestamps, and attachments through GET /{ig-user-id}/conversations${flavor === "facebook-login" ? " on graph.facebook.com, which needs a Unified Login (Business Integration System User) token" : ""}. The account must be a qualifying professional account and the app must have the required access level.`,
        },
        {
          platform: "instagram",
          operation: "messages.write",
          availability: "available" as const,
          requiredScopes: messageScopes,
          notes: `Reads the conversation participants and sends to the single participant other than this account through POST /{ig-user-id}/messages${flavor === "facebook-login" ? " on graph.facebook.com, which needs a Unified Login (Business Integration System User) token" : ""}. Group, self-only, and unidentifiable conversations are rejected; use native.sendMessage with an explicit recipient ID for those.`,
        },
        webhookCapability(
          "instagram",
          "Verifies Meta X-Hub-Signature-256 with the app secret and decodes object=instagram deliveries. Answer the GET handshake with answerMetaWebhookChallenge.",
        ),
        {
          platform: "instagram",
          operation: "likes.write",
          availability:
            flavor === "facebook-login"
              ? ("available" as const)
              : ("unsupported-by-platform" as const),
          requiredScopes: ["instagram_basic", "instagram_manage_engagement"],
          notes:
            flavor === "facebook-login"
              ? "native.like and native.unlike send POST or DELETE /{ig-user-id}/likes with media_id or comment_id for feed posts, Reels, carousels, comments, and replies. Not Stories or private accounts. More than 50 calls in 5 seconds locks the account out for an hour."
              : "Meta documents /{ig-user-id}/likes for Instagram API with Facebook Login only.",
        },
        {
          platform: "instagram",
          operation: "notifications.read",
          availability: "unsupported-by-platform" as const,
          notes:
            "The Instagram API has no notifications edge. Use mentions.read, tags, comments, or webhooks instead.",
        },
      ],
    },
    webhooks: directWebhooks(
      "instagram",
      (input) => verifyMetaWebhook({ ...input, secret: options.webhookSecret ?? "" }),
      now,
    ),
    accounts: {
      async list(_input: { cursor?: string; limit?: number }, context: AdapterOperationContext) {
        return { items: [await readAccount(context)] };
      },
      async get(ref: ConnectedAccountRef, context: AdapterOperationContext) {
        authorize(ref, context);

        return readAccount(context);
      },
    },
    posts: {
      list: listPosts,
      prepareTarget(target: PreparedPublishTarget) {
        const issues: { code: string; message: string; severity: "error"; targetIndex: number }[] =
          [];

        const fail = (code: string, message: string) =>
          issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

        if (
          target.account.platform !== "instagram" ||
          target.account.accountId !== options.auth.accountId
        )
          fail("instagram.account", "Select the configured professional Instagram account.");
        const media = target.content.media ?? [];

        // Meta documents carousels of up to 20 images and videos.
        if (media.length < 1 || media.length > 20)
          fail("instagram.media", "Instagram requires 1 to 20 image/video attachments.");

        const firstRatio =
          media[0]?.width && media[0]?.height ? media[0].width / media[0].height : undefined;

        for (const item of media) {
          if (item.source.kind !== "https-url")
            fail(
              "instagram.source",
              "Instagram Login publishing requires public HTTPS media URLs.",
            );
          else
            try {
              httpsUrl(item.source.url);
            } catch {
              fail("instagram.url", "Use public HTTPS media without local hosts or credentials.");
            }

          if (item.kind === "document")
            fail("instagram.document", "Instagram publishing accepts image and video media only.");

          if (item.kind === "image" && (item.altText?.length ?? 0) > 1000)
            fail("instagram.alt_text", "Image alt text exceeds 1,000 characters.");

          if (item.kind === "image" && item.mimeType !== "image/jpeg")
            fail("instagram.jpeg", "Instagram image publishing requires JPEG media.");

          if (
            item.kind === "video" &&
            item.mimeType !== "video/mp4" &&
            item.mimeType !== "video/quicktime"
          )
            fail("instagram.video", "Provide MP4 or MOV video with a supported codec.");

          if (
            media.length > 1 &&
            (!item.width ||
              !item.height ||
              firstRatio === undefined ||
              Math.abs(item.width / item.height - firstRatio) > 0.001)
          )
            fail(
              "instagram.carousel_crop",
              "Provide matching known aspect ratios for every carousel item; the SDK will not silently accept cropping.",
            );
        }

        for (const message of instagramCaptionIssues(target.content.text ?? ""))
          fail("instagram.caption", message);

        try {
          containerPlan(target);
        } catch (error) {
          if (!(error instanceof SocialError)) throw error;
          fail(
            error.code === "unsupported_capability"
              ? "instagram.options_flavor"
              : "instagram.options",
            error.message,
          );
        }

        if (target.schedule || target.replyTo || target.content.link)
          fail(
            "instagram.operation",
            "Use an explicit job runner, comment reply, or caption link instead of unsupported structured options.",
          );

        return issues;
      },
      async publishTarget(
        target: PreparedPublishTarget,
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        authorize(target.account, context);
        const media = target.content.media ?? [];
        const children: string[] = [];
        const plan = containerPlan(target);

        const workflow = await workflows.create({
          backend: target.account.backend,
          accountId: target.account.accountId,
          childIds: [],
          caption: target.content.text ?? "",
          ...definedFields({ parentFields: media.length > 1 ? plan : undefined }),
          stage: "children",
        });

        try {
          for (const item of media) {
            if (item.source.kind !== "https-url")
              throw new SocialError({
                code: "invalid_input",
                operation: "posts.publish",
                message: "Public HTTPS media required.",
              });
            await workflows.update(workflow.id, { stage: "unknown" });

            const created = object(
              await request(`/${encodeURIComponent(target.account.accountId)}/media`, context, {
                ...(item.kind === "image"
                  ? {
                      image_url: item.source.url,
                      ...definedFields({ alt_text: item.altText }),
                    }
                  : {
                      video_url: item.source.url,
                      media_type: media.length > 1 ? "VIDEO" : "REELS",
                    }),
                ...(media.length > 1
                  ? { is_carousel_item: true }
                  : { caption: target.content.text ?? "", ...plan }),
              }),
            );

            children.push(string(created["id"]));
            await workflows.update(workflow.id, { childIds: [...children], stage: "children" });
          }
        } catch (error) {
          // Code 190 rejects the token before any container is created; earlier children stay recorded.
          if (error instanceof SocialError && error.code === "reconnect_required")
            throw new SocialError({
              code: "reconnect_required",
              operation: "instagram.posts.publish",
              message: error.message,
              details: { createdContainerIds: children, workflowId: workflow.id },
              retryDisposition: { kind: "after-reconnect" },
              cause: error,
            });

          if (error instanceof SocialError)
            throw new SocialError({
              code: "ambiguous_outcome",
              operation: "instagram.posts.publish",
              message: error.message,
              details: {
                createdContainerIds: children,
                workflowId: workflow.id,
              },
              retryDisposition: { kind: "reconcile-first" },
              cause: error,
            });
          throw error;
        }

        let containerId = children[0];

        if (!containerId) throw new Error("Missing Instagram container");

        if (children.length > 1) {
          const result = await resumeWorkflow(workflow, target.account, context);

          return { ...result, targetIndex: target.targetIndex };
        }

        await workflows.update(workflow.id, { parentId: containerId, stage: "parent" });

        const result = await publishContainer(target.account, containerId, context, workflow.id);

        return { ...result, targetIndex: target.targetIndex };
      },
      async get(ref: PlatformPostRef, context: AdapterOperationContext): Promise<JsonObject> {
        authorize(ref, context);

        const fields = [...mediaReadFields, ...ownerCounterFields];

        return publicFields(
          await request(`/${encodeURIComponent(ref.postId)}`, context, undefined, {
            fields: fields.join(","),
          }),
          fields,
        );
      },
      async getDelivery(
        ref: { backend: string; platform: string; accountId: string; deliveryId: string },
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        authorize(ref, context);
        const workflow = await workflows.get(ref.deliveryId);

        if (workflow) {
          if (workflow.backend !== ref.backend || workflow.accountId !== ref.accountId)
            throw new SocialError({
              code: "unauthorized",
              operation: "instagram.posts.status",
              message: "Instagram workflow handle is not authorized for this account.",
            });

          const account = {
            kind: "connected-account" as const,
            version: 1 as const,
            backend: ref.backend,
            platform: "instagram" as const,
            accountId: ref.accountId,
          };

          if (workflow.nativeId) return publishedWorkflow(account, workflow, workflow.nativeId);

          return resumeWorkflow(workflow, account, context);
        }

        const result = await status(ref.deliveryId, context);
        const code = string(result["status_code"]);

        const base = {
          account: {
            kind: "connected-account" as const,
            version: 1 as const,
            backend: ref.backend,
            platform: "instagram",
            accountId: ref.accountId,
          },
          targetIndex: 0,
          observedAt: now(),
          backendState: code,
          delivery: { kind: "delivery" as const, version: 1 as const, ...ref },
        };

        if (code === "FINISHED") {
          const workflow = await workflows.get(ref.deliveryId);

          if (workflow) return resumeWorkflow(workflow, base.account, context);
        }

        if (code === "IN_PROGRESS") return { ...base, state: "processing" };

        if (code === "ERROR" || code === "EXPIRED")
          return {
            ...base,
            state: "failed",
            code: "media_error",
            message: "Instagram container failed or expired.",
            retryDisposition: { kind: "never" },
          };

        return {
          ...base,
          state: "unknown",
          reason: "unmapped-state",
          diagnostic:
            "Container status alone does not identify a published native post. Reconcile stored publish results.",
        };
      },
      async removeFromPlatform(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<void> {
        authorize(ref, context);
        await deleteMedia(ref.postId, context, "instagram.posts.removeFromPlatform");
      },
    },
    comments: {
      async list(
        ref: PlatformPostRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        authorize(ref, context);

        const query = {
          fields: commentFields.join(","),
          limit: String(pageLimit(input.limit)),
          ...definedFields({ after: input.cursor }),
        };

        const result = validatedObject(
          await request(`/${encodeURIComponent(ref.postId)}/comments`, context, undefined, query),
          "instagram.comments.read",
        );

        return recordPage(result, commentFields, normalizeComment, false);
      },
      async reply(
        ref: CommentRef,
        content: { text: string },
        context: AdapterOperationContext,
      ): Promise<CommentRef> {
        authorize(ref, context);

        const result = object(
          await request(`/${encodeURIComponent(ref.commentId)}/replies`, context, {
            message: content.text,
          }),
        );

        return { ...ref, commentId: string(result["id"]) };
      },
    },
    messages: {
      listConversations,
      listMessages,
      async send(conversation: ConversationRef, content: { readonly text: string }, context) {
        authorize(conversation, context);

        const recipientId = await conversationRecipient(conversation, context);

        return sendMessage({
          account: {
            kind: "connected-account",
            version: 1,
            backend: conversation.backend,
            platform: conversation.platform,
            accountId: conversation.accountId,
          },
          recipientId,
          text: content.text,
          context,
        });
      },
    },
    analytics: {
      getAccountMetrics,
      async getPostMetrics(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        authorize(ref, context);

        const media = validatedObject(
          await request(`/${encodeURIComponent(ref.postId)}`, context, undefined, {
            fields: "media_product_type",
          }),
          "instagram.analytics.read",
        );

        const result = validatedObject(
          await request(`/${encodeURIComponent(ref.postId)}/insights`, context, undefined, {
            metric:
              // `views` replaces the deprecated `impressions` metric (Graph v26.0).
              media["media_product_type"] === "STORY"
                ? "shares,reach,views,total_interactions"
                : "likes,comments,saved,shares,reach,views,total_interactions",
          }),
          "instagram.analytics.read",
        );

        const metrics: readonly MetricValue[] = array(result["data"]).flatMap((entry) => {
          const row = object(entry);
          const value = array(row["values"])[0];

          if (!value) return [];
          const count = optionalNumber(object(value)["value"]);

          return count === undefined
            ? []
            : [
                {
                  name: string(row["name"]),
                  value: count,
                  unit: "count" as const,
                  period: "lifetime" as const,
                  fetchedAt: now(),
                  freshness: "unknown" as const,
                  source: `instagram:${apiVersion}`,
                },
              ];
        });

        return normalizeMetrics(metrics);
      },
    },
    graph: {
      async getProfile(account, input, context): Promise<ProfileRecord> {
        authorize(account, context);
        let profile: JsonObject;

        if (input.profileId === undefined && input.handle === undefined) {
          const own = validatedObject(
            await request(`/${encodeURIComponent(account.accountId)}`, context, undefined, {
              fields:
                flavor === "facebook-login"
                  ? `id,${ownProfileFields}`
                  : `user_id,id,${ownProfileFields}`,
            }),
            "profiles.read",
          );

          profile = publicFields(own, profileFields);
          const ownId = optionalString(own["user_id"]);

          if (ownId !== undefined) profile = { ...profile, id: ownId };
        } else if (input.profileId !== undefined) {
          profile = publicFields(
            await request(`/${encodeURIComponent(input.profileId)}`, context, undefined, {
              fields:
                "id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count,website",
            }),
            profileFields,
          );
        } else {
          requireFacebookLogin("instagram.profiles.read");
          const username = input.handle;

          if (username === undefined)
            throw new SocialError({
              code: "invalid_input",
              operation: "profiles.read",
              message: "An Instagram profile ID or handle is required.",
            });

          if (!/^[A-Za-z0-9._]{1,30}$/.test(username))
            throw new SocialError({
              code: "invalid_input",
              operation: "profiles.read",
              message:
                "Instagram profile handles must contain only letters, numbers, periods, or underscores.",
            });

          const response = object(
            await request(`/${encodeURIComponent(account.accountId)}`, context, undefined, {
              fields: `business_discovery.username(${username}){id,username,biography,followers_count,media_count,website}`,
            }),
          );

          profile = publicFields(response["business_discovery"], [
            "id",
            "username",
            "biography",
            "followers_count",
            "media_count",
            "website",
          ]);
        }

        const id = string(profile["id"]);

        return {
          ref: profileRef({
            backend: account.backend,
            platform: "instagram",
            accountId: account.accountId,
            profileId: id,
          }),
          ...definedFields({
            displayName: optionalString(profile["name"]),
            handle: optionalString(profile["username"]),
            avatarUrl: optionalString(profile["profile_picture_url"]),
            bio: optionalString(profile["biography"]),
          }),
          native: profile,
        };
      },
    },
    native: {
      async moderateComment({ account, commentId, hidden, context }) {
        authorize(account, context);
        await request(
          `/${encodeURIComponent(commentId)}`,
          context,
          undefined,
          { hide: String(hidden) },
          "POST",
        );
      },
      async deleteComment({ account, commentId, context }) {
        authorize(account, context);
        await request(`/${encodeURIComponent(commentId)}`, context, undefined, {}, "DELETE");
      },
      async setCommentsEnabled({ account, mediaId, enabled, context }) {
        authorize(account, context);
        await request(
          `/${encodeURIComponent(mediaId)}`,
          context,
          undefined,
          { comment_enabled: String(enabled) },
          "POST",
        );
      },
      async listCommentReplies({ account, commentId, cursor, limit, context }) {
        authorize(account, context);

        const query = {
          fields: "id,text,timestamp,username",
          limit: String(pageLimit(limit)),
          ...definedFields({ after: cursor }),
        };

        return page(
          validatedObject(
            await request(`/${encodeURIComponent(commentId)}/replies`, context, undefined, query),
            "instagram.comments.replies.read",
          ),
          ["id", "text", "timestamp", "username"],
        );
      },
      listMentions,
      sendMessage,
      async mentionedMedia({ account, mediaId, context }) {
        authorize(account, context);
        requireFacebookLoginForMentionLookup("mentioned_media");

        return validatedObject(
          await request(`/${encodeURIComponent(account.accountId)}`, context, undefined, {
            fields: `mentioned_media.media_id(${encodeURIComponent(mediaId)}){id,caption,media_type,media_url,timestamp,username,comments_count,like_count}`,
          }),
          "instagram.mentions.read",
        );
      },
      async mentionedComment({ account, commentId, context }) {
        authorize(account, context);
        requireFacebookLoginForMentionLookup("mentioned_comment");

        return validatedObject(
          await request(`/${encodeURIComponent(account.accountId)}`, context, undefined, {
            fields: `mentioned_comment.comment_id(${encodeURIComponent(commentId)}){id,text,timestamp,like_count,media}`,
          }),
          "instagram.mentions.read",
        );
      },
      listTaggedMedia: listMentions,
      async hashtagMedia({ account, hashtagId, kind, cursor, limit, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.hashtags.search");

        const query = {
          user_id: account.accountId,
          fields: "id,caption,media_type,permalink,timestamp",
          limit: String(pageLimit(limit, 50)),
          ...definedFields({ after: cursor }),
        };

        return page(
          validatedObject(
            await request(
              `/${encodeURIComponent(hashtagId)}/${kind}_media`,
              context,
              undefined,
              query,
            ),
            "instagram.hashtags.search",
          ),
          ["id", "caption", "media_type", "permalink", "timestamp"],
        );
      },
      async businessDiscovery({ account, username, fields, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.profiles.businessDiscovery");

        if (!/^[A-Za-z0-9._]{1,30}$/.test(username))
          throw new SocialError({
            code: "invalid_input",
            operation: "instagram.profiles.businessDiscovery",
            message:
              "Business discovery usernames must contain only letters, numbers, periods, or underscores.",
          });

        const selectedFields =
          fields ??
          `business_discovery.username(${username}){id,username,biography,followers_count,media_count,website,media.limit(25){id,caption,media_type,permalink,timestamp}}`;

        return object(
          await request(`/${encodeURIComponent(account.accountId)}`, context, undefined, {
            fields: selectedFields,
          }),
        );
      },
      publishContainer,
      async publishCarousel(
        account: ConnectedAccountRef,
        children: readonly string[],
        caption: string,
        context: AdapterOperationContext,
        options: InstagramPublishOptions = {},
      ): Promise<DeliveryOutcome> {
        authorize(account, context);

        if (children.length < 2 || children.length > 20)
          invalidOption("instagram.posts.publish", "A carousel takes 2 to 20 child containers.");

        for (const message of instagramCaptionIssues(caption))
          invalidOption("instagram.posts.publish", message);

        const parentFields = instagramContainerFields({
          options,
          kind: "carousel",
          flavor,
          caption,
          operation: "instagram.posts.publish",
        });

        const workflow = await workflows.create({
          backend: account.backend,
          accountId: account.accountId,
          childIds: [...children],
          caption,
          parentFields,
          stage: "children",
        });

        return resumeWorkflow(workflow, account, context);
      },
      async searchAudio({ account, audioType, query, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.audio.search");

        if (audioType !== "original_sound" && audioType !== "music")
          invalidOption("instagram.audio.search", 'audioType must be "original_sound" or "music".');

        const result = validatedObject(
          await request("/ig_audio", context, undefined, {
            audio_type: audioType,
            user_id: account.accountId,
            ...definedFields({ search_query: query?.trim() === "" ? undefined : query }),
          }),
          "instagram.audio.search",
        );

        // Meta's audio search answers with an `audio` array rather than Graph's usual `data`.
        // Source, accessed 2026-11-04:
        // https://developers.facebook.com/documentation/instagram-platform/content-publishing/audio-api
        const assets = result["data"] === undefined ? result["audio"] : undefined;

        return page(assets === undefined ? result : { ...result, data: assets }, audioFields);
      },
      async getAudio({ account, audioId, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.audio.search");

        return publicFields(
          validatedObject(
            await request(`/${encodeURIComponent(audioId)}`, context, undefined, {
              user_id: account.accountId,
            }),
            "instagram.audio.search",
          ),
          // A single asset returns `cover_artwork_thumbnail_url`; search returns `..._uri`.
          [...audioFields, "cover_artwork_thumbnail_url"],
        );
      },
      async getCopyrightCheck({ account, id, stage, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.posts.copyrightCheck");

        const field =
          stage === "container" ? "copyright_check_status" : "copyright_check_information";

        const result = validatedObject(
          await request(`/${encodeURIComponent(id)}`, context, undefined, { fields: field }),
          "instagram.posts.copyrightCheck",
        );

        const native = validatedObject(result[field], "instagram.posts.copyrightCheck");

        // Published media nests the summary under `status`.
        const summary =
          stage === "media"
            ? validatedObject(native["status"], "instagram.posts.copyrightCheck")
            : native;

        const matches = summary["matches_found"];

        if (!isBoolean(matches))
          throw new SocialError({
            code: "upstream_failure",
            operation: "instagram.posts.copyrightCheck",
            message: "Instagram returned a copyright check without matches_found.",
          });

        return { status: string(summary["status"]), matchesFound: matches, native };
      },
      async createResumableUpload({ account, mediaType, caption, context, ...options }) {
        authorize(account, context);
        requireFacebookLogin("instagram.media.upload");

        if (!["REELS", "STORIES", "VIDEO"].includes(mediaType))
          invalidOption("instagram.media.upload", "mediaType must be REELS, STORIES, or VIDEO.");

        if (mediaType !== "REELS" && caption !== undefined)
          invalidOption(
            "instagram.media.upload",
            "Only a resumable Reel container takes a caption.",
          );

        const fields = instagramContainerFields({
          options,
          kind:
            mediaType === "REELS" ? "reel" : mediaType === "STORIES" ? "story" : "carousel-item",
          flavor,
          caption: caption ?? "",
          operation: "instagram.media.upload",
        });

        const created = validatedObject(
          await request(
            `/${encodeURIComponent(account.accountId)}/media`,
            context,
            {
              media_type: mediaType,
              ...definedFields({
                is_carousel_item: mediaType === "VIDEO" ? true : undefined,
                caption,
              }),
              ...fields,
            },
            { upload_type: "resumable" },
          ),
          "instagram.media.upload",
        );

        return { containerId: string(created["id"]), uploadUri: ruploadUri(created["uri"]).href };
      },
      async uploadVideo({ account, uploadUri, source, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.media.upload");
        const uri = ruploadUri(uploadUri);

        const headers = new Headers({ Authorization: `OAuth ${options.auth.accessToken}` });
        let body: Blob | undefined;

        if (source.kind === "https-url") {
          try {
            headers.set("file_url", httpsUrl(source.url).href);
          } catch {
            invalidOption("instagram.media.upload", "The hosted video must be a public HTTPS URL.");
          }
        } else {
          const offset = source.offset ?? 0;

          if (!Number.isSafeInteger(offset) || offset < 0 || offset >= source.blob.size)
            invalidOption(
              "instagram.media.upload",
              "offset must be an integer inside the video, such as video_status bytes_transferred.",
            );

          headers.set("offset", String(offset));
          headers.set("file_size", String(source.blob.size));
          headers.set("Content-Type", "application/octet-stream");
          body = source.blob.slice(offset);
        }

        // The upload shares the operation's elapsed budget with Graph requests, and the
        // deadline covers both the request and reading the response body.
        const deadline = new AbortController();

        const timer = setTimeout(
          () => deadline.abort(),
          Math.min(2_147_483_647, remainingBudget(context)),
        );

        const signal =
          context.signal === undefined
            ? deadline.signal
            : AbortSignal.any([context.signal, deadline.signal]);

        let status: number;
        let parsed: JsonValue | undefined;

        try {
          const response = await fetchWithoutRedirects(options.fetch ?? globalThis.fetch, uri, {
            method: "POST",
            headers,
            signal,
            ...definedFields({ body }),
          });

          status = response.status;
          parsed = parseUploadResponse(await response.text());
        } catch (cause) {
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "instagram.media.upload",
            message:
              "The Instagram video upload did not return a readable response. Read getUploadStatus and resume from bytes_transferred.",
            retryDisposition: { kind: "reconcile-first" },
            cause,
          });
        } finally {
          clearTimeout(timer);
        }

        if (status >= 200 && status < 300 && isJsonObject(parsed) && parsed["success"] === true)
          return;

        const debug = isJsonObject(parsed) ? optionalObject(parsed["debug_info"]) : undefined;

        // Meta documents an explicit refusal as a `debug_info` object, and a 4xx status is a
        // definite rejection. Anything else, such as a 5xx or a success response without
        // `success: true`, leaves the upload state unknown.
        if (debug === undefined && (status < 400 || status >= 500))
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "instagram.media.upload",
            message: `Instagram did not confirm the video upload (HTTP ${status}). Read getUploadStatus and resume from bytes_transferred.`,
            retryDisposition: { kind: "reconcile-first" },
          });

        throw new SocialError({
          code: "upstream_failure",
          operation: "instagram.media.upload",
          message:
            optionalString(debug?.["message"]) ??
            `Instagram did not confirm the video upload (HTTP ${status}).`,
          retryDisposition:
            debug?.["retriable"] === true ? { kind: "reconcile-first" } : { kind: "never" },
          ...definedFields({
            details: definedFields({ type: optionalString(debug?.["type"]) }),
          }),
        });
      },
      async getUploadStatus({ account, containerId, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.media.upload");

        return validatedObject(
          await request(`/${encodeURIComponent(containerId)}`, context, undefined, {
            fields: "id,status,status_code,video_status",
          }),
          "instagram.media.upload",
        );
      },
      async listChildren({ account, mediaId, context }) {
        authorize(account, context);

        return page(
          validatedObject(
            await request(`/${encodeURIComponent(mediaId)}/children`, context, undefined, {
              fields: childFields.join(","),
            }),
            "instagram.posts.read",
          ),
          childFields,
        );
      },
      async listStories({ account, cursor, limit, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.stories.read");

        return edgePage({
          account,
          edge: "/stories",
          fields: storyFields,
          operation: "instagram.stories.read",
          query: edgeQuery(cursor, limit),
          context,
        });
      },
      async listLiveMedia({ account, cursor, limit, since, until, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.live.read");

        return edgePage({
          account,
          edge: "/live_media",
          fields: liveFields,
          operation: "instagram.live.read",
          query: {
            ...edgeQuery(cursor, limit),
            ...definedFields({
              since: since === undefined ? undefined : unixSeconds(since, "instagram.live.read"),
              until: until === undefined ? undefined : unixSeconds(until, "instagram.live.read"),
            }),
          },
          context,
        });
      },
      async listCollaborativeMedia({ account, cursor, limit, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.collaboration.read");

        return edgePage({
          account,
          edge: "/collaborative_media",
          fields: collaborativeFields,
          operation: "instagram.collaboration.read",
          query: edgeQuery(cursor, limit),
          context,
        });
      },
      async listMediaCollaborators({ account, mediaId, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.collaboration.read");

        const result = validatedObject(
          await request(`/${encodeURIComponent(mediaId)}/collaborators`, context, undefined, {
            fields: "id,username,invite_status",
          }),
          "instagram.collaboration.read",
        );

        return array(result["data"]).map((entry) => {
          const row = object(entry);

          return {
            id: string(row["id"]),
            ...definedFields({
              username: optionalString(row["username"]),
              inviteStatus: optionalString(row["invite_status"]),
            }),
          };
        });
      },
      async listCollaborationInvites({ account, cursor, limit, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.collaboration.read");

        return edgePage({
          account,
          edge: "/collaboration_invites",
          fields: ["media_id", "media_owner_username", "caption", "media_url"],
          operation: "instagram.collaboration.read",
          query: edgeQuery(cursor, limit),
          context,
          cursorOnly: true,
        });
      },
      async respondToCollaborationInvite({ account, mediaId, accept, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.collaboration.write");

        if (!/^\d{1,32}$/.test(mediaId))
          invalidOption("instagram.collaboration.write", "mediaId must be a numeric media ID.");

        const result = validatedObject(
          await request(
            `/${encodeURIComponent(account.accountId)}/collaboration_invites`,
            context,
            { media_id: mediaId, accept },
          ),
          "instagram.collaboration.write",
        );

        if (result["success"] !== true)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "instagram.collaboration.write",
            message: "Instagram did not confirm the collaboration invite response.",
            retryDisposition: { kind: "reconcile-first" },
          });
      },
      async findConversation({ account, userId, context }) {
        authorize(account, context);
        const igsid = numericId(userId, "instagram.messages.read", "userId");

        const result = validatedObject(
          await request(
            `/${encodeURIComponent(account.accountId)}/conversations`,
            context,
            undefined,
            {
              platform: "instagram",
              user_id: igsid,
            },
          ),
          "instagram.messages.read",
        );

        const data = result["data"] === undefined ? [] : array(result["data"]);
        const [first] = data;

        if (first === undefined) return undefined;

        const conversationId = string(object(first)["id"]);

        if (data.length > 1 || conversationId.length === 0)
          throw new SocialError({
            code: "upstream_failure",
            operation: "instagram.messages.read",
            message: "Instagram returned an unexpected conversation lookup result.",
          });

        return {
          kind: "conversation",
          version: 1,
          backend: account.backend,
          platform: "instagram",
          accountId: account.accountId,
          conversationId,
        };
      },
      like: async (input) => setLike(input, "POST"),
      unlike: async (input) => setLike(input, "DELETE"),
      async getPollResults({ account, mediaId, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.posts.read");
        const id = numericId(mediaId, "instagram.posts.read", "mediaId");

        // The edge rejects field expansion, so it is its own request.
        const result = validatedObject(
          await request(`/${id}/poll_attachment`, context, undefined, {}),
          "instagram.posts.read",
        );

        return pollResults(result["poll_attachment"]);
      },
      async listPromptResponses({ account, mediaId, cursor, limit, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.comments.read");
        const id = numericId(mediaId, "instagram.comments.read", "mediaId");

        const result = validatedObject(
          await request(`/${id}/prompt_response`, context, undefined, {
            fields: promptResponseFields.join(","),
            limit: String(pageLimit(limit)),
            ...definedFields({ after: cursor }),
          }),
          "instagram.comments.read",
        );

        // `data: null` means no prompt (or comments turned off); an empty array can still page.
        if (result["data"] === null) return { items: [], available: false };

        return { ...page(result, promptResponseFields), available: true };
      },
      async getConnectedThreadsUser({ account, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.threads.read");

        const result = validatedObject(
          await request(
            `/${encodeURIComponent(account.accountId)}/connected_threads_user`,
            context,
            undefined,
            { fields: "threads_user_id" },
          ),
          "instagram.threads.read",
        );

        const [first] = array(result["data"]);

        const threadsUserId =
          first === undefined ? undefined : optionalString(object(first)["threads_user_id"]);

        return definedFields({ threadsUserId });
      },
      async getOEmbed({ url, maxWidth, omitScript, appAccessToken, context }) {
        let target: URL;

        try {
          target = httpsUrl(url);
        } catch {
          return invalidOption("instagram.oembed", "url must be a public HTTPS Instagram URL.");
        }

        if (!["instagram.com", "www.instagram.com"].includes(target.hostname))
          invalidOption("instagram.oembed", "url must point to instagram.com.");

        if (maxWidth !== undefined && (!Number.isSafeInteger(maxWidth) || maxWidth < 1))
          invalidOption("instagram.oembed", "maxWidth must be a positive integer.");

        const oembedRequest =
          appAccessToken === undefined
            ? facebookGraphRequest
            : managedHttp(`https://graph.facebook.com/${apiVersion}`, {
                apiKey: appAccessToken,
                ...definedFields({ fetch: options.fetch }),
              });

        return validatedObject(
          await oembedRequest("/instagram_oembed", context, undefined, {
            url: target.href,
            ...definedFields({
              maxwidth: maxWidth === undefined ? undefined : String(maxWidth),
              omitscript: omitScript === undefined ? undefined : String(omitScript),
            }),
          }),
          "instagram.oembed",
        );
      },
      async listUpcomingEvents({ account, cursor, limit, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.events.read");

        return edgePage({
          account,
          edge: "/upcoming_events",
          fields: ["id", "title", "start_time", "end_time"],
          operation: "instagram.events.read",
          query: edgeQuery(cursor, limit),
          context,
        });
      },
      async createUpcomingEvent({ account, context, ...event }) {
        authorize(account, context);
        requireFacebookLogin("instagram.events.write");

        const result = validatedObject(
          await request(
            `/${encodeURIComponent(account.accountId)}/upcoming_events`,
            context,
            eventFields(event, "create"),
          ),
          "instagram.events.write",
        );

        return { id: string(result["id"]) };
      },
      async updateUpcomingEvent({ account, eventId, context, ...event }) {
        authorize(account, context);
        requireFacebookLogin("instagram.events.write");
        const fields = eventFields(event, "update");

        if (Object.keys(fields).length === 0)
          invalidOption(
            "instagram.events.write",
            "Supply at least one upcoming event field to update.",
          );

        const result = validatedObject(
          await request(`/${encodeURIComponent(eventId)}`, context, fields),
          "instagram.events.write",
        );

        return { id: string(result["id"]) };
      },
      async listRecentlySearchedHashtags({ account, limit, cursor, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.hashtags.search");

        return edgePage({
          account,
          edge: "/recently_searched_hashtags",
          fields: ["id"],
          operation: "instagram.hashtags.search",
          query: { limit: String(pageLimit(limit, 30)), ...definedFields({ after: cursor }) },
          context,
        });
      },
      async createComment({ account, mediaId, text, context }) {
        authorize(account, context);
        const message = nonEmptyText(text, "instagram.comments.write", "Comment text");

        const result = validatedObject(
          await request(`/${encodeURIComponent(mediaId)}/comments`, context, { message }),
          "instagram.comments.write",
        );

        return { id: string(result["id"]) };
      },
      async getComment({ account, commentId, context }) {
        authorize(account, context);

        const fields = [
          "id",
          "text",
          "timestamp",
          "username",
          "hidden",
          "like_count",
          "parent_id",
          "from",
          "media",
        ];

        const result = validatedObject(
          await request(`/${encodeURIComponent(commentId)}`, context, undefined, {
            fields: fields.join(","),
          }),
          "instagram.comments.read",
        );

        const record: Record<string, JsonValue> = {};

        for (const field of fields) {
          const value = result[field];

          if (value !== undefined) record[field] = value;
        }

        return record;
      },
      async listOrderedComments({ account, mediaId, cursor, limit, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.comments.read");

        const result = validatedObject(
          await request(`/${encodeURIComponent(mediaId)}/ordered_comments`, context, undefined, {
            fields: commentFields.join(","),
            limit: String(pageLimit(limit)),
            ...definedFields({ after: cursor }),
          }),
          "instagram.comments.read",
        );

        return recordPage(result, commentFields, normalizeComment, false);
      },
      async replyToMention({ account, mediaId, commentId, text, context }) {
        authorize(account, context);
        const message = nonEmptyText(text, "instagram.mentions.reply", "Mention reply text");

        const result = validatedObject(
          await request(`/${encodeURIComponent(account.accountId)}/mentions`, context, {
            media_id: nonEmptyText(mediaId, "instagram.mentions.reply", "mediaId"),
            message,
            ...definedFields({ comment_id: commentId }),
          }),
          "instagram.mentions.reply",
        );

        return { id: string(result["id"]) };
      },
      async privateReply({ account, commentId, text, context }) {
        authorize(account, context);
        const message = outgoingMessageWire({ kind: "text", text });

        return sentMessage(
          await request(`/${encodeURIComponent(account.accountId)}/messages`, context, {
            recipient: { comment_id: nonEmptyText(commentId, messageOperation, "commentId") },
            message,
          }),
        );
      },
      async sendDirectMessage({
        account,
        recipientId,
        message,
        replyToMessageId,
        humanAgent,
        context,
      }) {
        authorize(account, context);
        const body = outgoingMessageWire(message);

        return sentMessage(
          await request(`/${encodeURIComponent(account.accountId)}/messages`, context, {
            recipient: { id: nonEmptyText(recipientId, messageOperation, "recipientId") },
            message: body,
            ...definedFields({
              reply_to: replyToMessageId === undefined ? undefined : { mid: replyToMessageId },
              messaging_type: humanAgent === true ? "MESSAGE_TAG" : undefined,
              tag: humanAgent === true ? "HUMAN_AGENT" : undefined,
            }),
          }),
        );
      },
      async reactToMessage({ account, recipientId, messageId, reaction, context }) {
        authorize(account, context);

        await request(`/${encodeURIComponent(account.accountId)}/messages`, context, {
          recipient: { id: recipientId },
          sender_action: "react",
          payload: {
            message_id: nonEmptyText(messageId, messageOperation, "messageId"),
            reaction: nonEmptyText(reaction, messageOperation, "reaction"),
          },
        });
      },
      async removeReaction({ account, recipientId, messageId, context }) {
        authorize(account, context);

        await request(`/${encodeURIComponent(account.accountId)}/messages`, context, {
          recipient: { id: recipientId },
          sender_action: "unreact",
          payload: { message_id: nonEmptyText(messageId, messageOperation, "messageId") },
        });
      },
      async sendSenderAction({ account, recipientId, action, context }) {
        authorize(account, context);

        if (!["typing_on", "typing_off", "mark_seen"].includes(action))
          invalidOption(messageOperation, "action must be typing_on, typing_off, or mark_seen.");

        await request(`/${encodeURIComponent(account.accountId)}/messages`, context, {
          recipient: { id: nonEmptyText(recipientId, messageOperation, "recipientId") },
          sender_action: action,
        });
      },
      async getIceBreakers({ account, context }) {
        authorize(account, context);

        const result = validatedObject(
          await request(messengerProfile(account), context, undefined, {
            platform: "instagram",
            fields: "ice_breakers",
          }),
          messageOperation,
        );

        return array(result["data"]).map((entry) => {
          const row = object(entry);

          return {
            ...definedFields({ locale: optionalString(row["locale"]) }),
            questions: array(row["call_to_actions"]).map((action) => {
              const question = object(action);

              return {
                question: string(question["question"]),
                payload: string(question["payload"]),
              };
            }),
          };
        });
      },
      async setIceBreakers({ account, iceBreakers, context }) {
        authorize(account, context);

        if (iceBreakers.length < 1)
          invalidOption(messageOperation, "Supply ice breakers, or use deleteIceBreakers.");

        const ice_breakers = iceBreakers.map((entry) => {
          if (entry.questions.length < 1 || entry.questions.length > 4)
            invalidOption(messageOperation, "Each ice breaker locale takes 1 to 4 questions.");

          return {
            call_to_actions: entry.questions.map((question) => ({
              question: nonEmptyText(question.question, messageOperation, "Ice breaker question"),
              payload: nonEmptyText(question.payload, messageOperation, "Ice breaker payload"),
            })),
            ...definedFields({ locale: entry.locale }),
          };
        });

        confirmProfileWrite(
          await request(messengerProfile(account), context, {
            platform: "instagram",
            ice_breakers,
          }),
        );
      },
      async deleteIceBreakers({ account, context }) {
        authorize(account, context);

        confirmProfileWrite(
          await request(
            messengerProfile(account),
            context,
            { fields: ["ice_breakers"] },
            {},
            "DELETE",
          ),
        );
      },
      async getPersistentMenu({ account, context }) {
        authorize(account, context);

        return validatedObject(
          await request(messengerProfile(account), context, undefined, {
            platform: "instagram",
            fields: "persistent_menu",
          }),
          messageOperation,
        );
      },
      async setPersistentMenu({ account, menus, context }) {
        authorize(account, context);

        if (menus.length < 1)
          invalidOption(messageOperation, "Supply a menu, or use deletePersistentMenu.");

        const persistent_menu = menus.map((menu) => {
          if (menu.items.length < 1)
            invalidOption(messageOperation, "Each persistent menu needs at least one item.");

          return {
            locale: nonEmptyText(menu.locale, messageOperation, "Menu locale"),
            composer_input_disabled: false,
            call_to_actions: menu.items.map(buttonWire),
          };
        });

        confirmProfileWrite(
          await request(messengerProfile(account), context, {
            platform: "instagram",
            persistent_menu,
          }),
        );
      },
      async deletePersistentMenu({ account, context }) {
        authorize(account, context);

        confirmProfileWrite(
          await request(
            messengerProfile(account),
            context,
            { fields: ["persistent_menu"] },
            {},
            "DELETE",
          ),
        );
      },
      async getMessagingUserProfile({ account, recipientId, context }) {
        authorize(account, context);

        const result = validatedObject(
          await request(`/${encodeURIComponent(recipientId)}`, context, undefined, {
            fields:
              "name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user,is_verified_user",
          }),
          "instagram.messages.read",
        );

        return {
          id: optionalString(result["id"]) ?? recipientId,
          ...definedFields({
            name: optionalString(result["name"]),
            username: optionalString(result["username"]),
            profilePic: optionalString(result["profile_pic"]),
            followerCount: optionalNumber(result["follower_count"]),
            isUserFollowBusiness: optionalBoolean(result["is_user_follow_business"]),
            isBusinessFollowUser: optionalBoolean(result["is_business_follow_user"]),
            isVerifiedUser: optionalBoolean(result["is_verified_user"]),
          }),
        };
      },
      async getMediaInsights({ account, mediaId, metrics, breakdown, context }) {
        authorize(account, context);

        if (metrics.some((metric) => !metricName.test(metric)))
          invalidOption(
            "instagram.analytics.read",
            "Insight metric names are lowercase identifiers.",
          );

        if (
          breakdown !== undefined &&
          !metrics.includes(breakdown === "action_type" ? "profile_activity" : "navigation")
        )
          invalidOption(
            "instagram.analytics.read",
            "action_type applies to profile_activity and story_navigation_action_type to navigation.",
          );

        return insightRows(
          validatedObject(
            await request(`/${encodeURIComponent(mediaId)}/insights`, context, undefined, {
              metric: metrics.join(","),
              ...definedFields({ breakdown }),
            }),
            "instagram.analytics.read",
          ),
        );
      },
      async getAccountInsights({
        account,
        metrics = defaultAccountMetrics,
        period,
        metricType = metrics === defaultAccountMetrics ? "total_value" : undefined,
        since,
        until,
        breakdown,
        context,
      }) {
        authorize(account, context);
        const operation = "instagram.analytics.account.read";

        if (metrics.some((metric) => !metricName.test(metric)))
          invalidOption(operation, "Insight metric names are lowercase identifiers.");

        if (breakdown !== undefined && metricType !== "total_value")
          invalidOption(operation, 'Breakdowns apply only with metricType "total_value".');

        if (breakdown?.some((key) => !metricName.test(key)))
          invalidOption(operation, "Breakdown names are lowercase identifiers.");

        return insightRows(
          validatedObject(
            await request(
              `/${encodeURIComponent(account.accountId)}/insights`,
              context,
              undefined,
              {
                metric: metrics.join(","),
                period,
                ...definedFields({
                  metric_type: metricType,
                  since: since === undefined ? undefined : unixSeconds(since, operation),
                  until: until === undefined ? undefined : unixSeconds(until, operation),
                  breakdown: breakdown?.join(","),
                }),
              },
            ),
            operation,
          ),
        );
      },
      async getAudienceDemographics({ account, metric, breakdown, timeframe, context }) {
        authorize(account, context);
        const operation = "instagram.analytics.account.read";

        if (!["follower_demographics", "engaged_audience_demographics"].includes(metric))
          invalidOption(
            operation,
            "Select follower_demographics or engaged_audience_demographics.",
          );

        if (!["age", "city", "country", "gender"].includes(breakdown))
          invalidOption(operation, "Demographic breakdowns are age, city, country, or gender.");

        // v20.0 and later accept only this_week and this_month.
        if (timeframe !== "this_week" && timeframe !== "this_month")
          invalidOption(operation, "Demographic timeframes are this_week or this_month.");

        const [row] = insightRows(
          validatedObject(
            await request(
              `/${encodeURIComponent(account.accountId)}/insights`,
              context,
              undefined,
              {
                metric,
                period: "lifetime",
                metric_type: "total_value",
                timeframe,
                breakdown,
              },
            ),
            operation,
          ),
        );

        if (row === undefined)
          throw new SocialError({
            code: "upstream_failure",
            operation,
            message:
              "Instagram returned no demographics row. Meta omits demographics for accounts under 100 followers or engagements.",
          });

        return row;
      },
      async subscribeWebhooks({ account, fields, pageId, context }) {
        authorize(account, context);
        const operation = "instagram.webhooks.subscribe";

        if (fields.some((field) => !metricName.test(field)))
          invalidOption(operation, "Webhook field names are lowercase identifiers.");

        if (flavor !== "facebook-login" && pageId !== undefined)
          invalidOption(operation, "pageId applies only to Facebook Login subscriptions.");

        // Unified Login has no Page: omit pageId to subscribe the Instagram account itself on
        // graph.facebook.com. Page-linked Facebook Login subscribes the linked Page.
        const target =
          pageId === undefined ? account.accountId : numericId(pageId, operation, "pageId");

        const result = await request(
          `/${encodeURIComponent(target)}/subscribed_apps`,
          context,
          undefined,
          { subscribed_fields: fields.join(",") },
          "POST",
        );

        if (!isJsonObject(result) || result["success"] !== true)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation,
            message: "Instagram did not confirm the webhook subscription.",
            retryDisposition: { kind: "reconcile-first" },
          });
      },
      async getClientBusinessId({ context }) {
        requireFacebookLogin("instagram.accounts.discover");

        const result = validatedObject(
          await request("/me", context, undefined, { fields: "client_business_id" }),
          "instagram.accounts.discover",
        );

        return optionalString(result["client_business_id"]);
      },
      async listAssignedAccounts({ cursor, limit, context }) {
        requireFacebookLogin("instagram.accounts.discover");

        const result = validatedObject(
          await request("/me/assigned_instagram_accounts", context, undefined, {
            fields: "id,username",
            limit: String(pageLimit(limit)),
            ...definedFields({ after: cursor }),
          }),
          "instagram.accounts.discover",
        );

        const listed = page(result, ["id", "username"], true);

        const items = listed.items.map((item) => ({
          id: string(item["id"]),
          ...definedFields({ username: optionalString(item["username"]) }),
        }));

        return { items, ...definedFields({ nextCursor: listed.nextCursor }) };
      },
      async getPageInstagramAccount({ pageId, context }) {
        requireFacebookLogin("instagram.accounts.discover");

        if (!/^\d{1,32}$/.test(pageId))
          invalidOption(
            "instagram.accounts.discover",
            "pageId must be a numeric Facebook Page ID.",
          );

        const result = validatedObject(
          await request(`/${encodeURIComponent(pageId)}`, context, undefined, {
            fields: "instagram_business_account{id,username}",
          }),
          "instagram.accounts.discover",
        );

        const linked = optionalObject(result["instagram_business_account"]);

        return linked === undefined
          ? undefined
          : {
              id: string(linked["id"]),
              ...definedFields({ username: optionalString(linked["username"]) }),
            };
      },
      async getProductTagEligibility({ account, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.product.tagging");

        const result = validatedObject(
          await request(`/${encodeURIComponent(account.accountId)}`, context, undefined, {
            fields: "shopping_product_tag_eligibility",
          }),
          "instagram.product.tagging",
        );

        return result["shopping_product_tag_eligibility"] === true;
      },
      async listAvailableCatalogs({ account, cursor, limit, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.product.tagging");

        return edgePage({
          account,
          edge: "/available_catalogs",
          fields: ["catalog_id", "catalog_name", "shop_name", "product_count"],
          operation: "instagram.product.tagging",
          query: edgeQuery(cursor, limit),
          context,
          cursorOnly: true,
        });
      },
      async searchCatalogProducts({ account, catalogId, query, cursor, limit, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.product.tagging");

        if (!/^\d{1,32}$/.test(catalogId))
          invalidOption("instagram.product.tagging", "catalogId must be a numeric catalog ID.");

        return edgePage({
          account,
          edge: "/catalog_product_search",
          fields: [
            "product_id",
            "merchant_id",
            "product_name",
            "image_url",
            "retailer_id",
            "review_status",
            "is_checkout_flow",
          ],
          operation: "instagram.product.tagging",
          query: {
            catalog_id: catalogId,
            ...edgeQuery(cursor, limit),
            ...definedFields({ q: query?.trim() === "" ? undefined : query }),
          },
          context,
          cursorOnly: true,
        });
      },
      async listProductTags({ account, mediaId, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.product.tagging");

        const result = validatedObject(
          await request(`/${encodeURIComponent(mediaId)}/product_tags`, context),
          "instagram.product.tagging",
        );

        return array(result["data"]).map((entry) =>
          publicFields(entry, [
            "product_id",
            "merchant_id",
            "name",
            "review_status",
            "is_checkout",
            "x",
            "y",
          ]),
        );
      },
      async updateProductTags({ account, mediaId, tags, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.product.tagging");
        const operation = "instagram.product.tagging";

        if (tags.length < 1) invalidOption(operation, "Supply at least one product tag.");

        const updated_tags = tags.map((tag) => {
          if (!/^\d{1,32}$/.test(tag.productId))
            invalidOption(operation, "productId must be a numeric catalog product ID.");

          if ((tag.x === undefined) !== (tag.y === undefined))
            invalidOption(operation, "A product tag needs both x and y, or neither.");

          return {
            product_id: tag.productId,
            ...definedFields({
              x: tag.x === undefined ? undefined : unitCoordinate(tag.x, operation, "x"),
              y: tag.y === undefined ? undefined : unitCoordinate(tag.y, operation, "y"),
            }),
          };
        });

        const result = await request(`/${encodeURIComponent(mediaId)}/product_tags`, context, {
          updated_tags,
        });

        // Meta documents a bare boolean; Graph also wraps booleans as `{ success }`.
        const confirmed = result === true || (isJsonObject(result) && result["success"] === true);

        if (!confirmed)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation,
            message: "Instagram did not confirm the product tag update. Read the tags back.",
            retryDisposition: { kind: "reconcile-first" },
          });
      },
      async resumePublication(
        account: ConnectedAccountRef,
        workflowId: string,
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        authorize(account, context);
        const workflow = await workflows.get(workflowId);

        if (
          !workflow ||
          workflow.backend !== context.backendInstance ||
          workflow.accountId !== account.accountId
        )
          throw new SocialError({
            code: "unauthorized",
            operation: "instagram.posts.resume",
            message: "Instagram workflow handle is not authorized for this account.",
          });

        return resumeWorkflow(workflow, account, context);
      },
      async publishReel({ account, videoUrl, caption, context, ...options }) {
        authorize(account, context);

        const fields = instagramContainerFields({
          options,
          kind: "reel",
          flavor,
          caption: caption ?? "",
          operation: "instagram.reels.publish",
        });

        for (const message of instagramCaptionIssues(caption ?? ""))
          invalidOption("instagram.reels.publish", message);

        const workflow = await workflows.create({
          backend: account.backend,
          accountId: account.accountId,
          childIds: [],
          caption: "",
          stage: "unknown",
        });

        const created = object(
          await request(`/${encodeURIComponent(account.accountId)}/media`, context, {
            media_type: "REELS",
            video_url: videoUrl,
            ...definedFields({ caption: caption === "" ? undefined : caption }),
            ...fields,
          }),
        );

        const ready = await saveNativeContainer(workflow.id, string(created["id"]));

        return resumeWorkflow(ready, account, context);
      },
      async publishStory({ account, mediaUrl, videoUrl, userTags, context }) {
        authorize(account, context);

        const fields = instagramContainerFields({
          options: definedFields({ storyUserTags: userTags }),
          kind: "story",
          flavor,
          caption: "",
          operation: "instagram.stories.publish",
        });

        const workflow = await workflows.create({
          backend: account.backend,
          accountId: account.accountId,
          childIds: [],
          caption: "",
          stage: "unknown",
        });

        const created = object(
          await request(`/${encodeURIComponent(account.accountId)}/media`, context, {
            media_type: "STORIES",
            ...(videoUrl === undefined ? { image_url: mediaUrl } : { video_url: videoUrl }),
            ...fields,
          }),
        );

        const ready = await saveNativeContainer(workflow.id, string(created["id"]));

        return resumeWorkflow(ready, account, context);
      },
      async deletePost({ account, postId, context }) {
        authorize(account, context);
        await deleteMedia(postId, context, "instagram.posts.delete");
      },
      async hashtagSearch({ account, hashtag, context }) {
        authorize(account, context);
        requireFacebookLogin("instagram.hashtags.search");
        const normalized = hashtag.replace(/^#/, "").trim();

        if (!normalized)
          throw new SocialError({
            code: "invalid_input",
            operation: "instagram.hashtags.search",
            message: "Instagram hashtag search requires a non-empty hashtag name.",
          });

        const result = validatedObject(
          await request("/ig_hashtag_search", context, undefined, {
            user_id: account.accountId,
            q: normalized,
          }),
          "instagram.hashtags.search",
        );

        return {
          data: array(result["data"]).map((entry) => {
            const row = object(entry);

            return { id: string(row["id"]) };
          }),
        };
      },
      async publishingLimit({ account, context }) {
        authorize(account, context);

        return object(
          await request(
            `/${encodeURIComponent(account.accountId)}/content_publishing_limit`,
            context,
            undefined,
            { fields: "config,quota_usage" },
          ),
        );
      },
      mentions: listMentions,
    },
  });
}
