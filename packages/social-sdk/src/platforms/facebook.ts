import { defineAdapter, type SocialAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import type {
  AccountRecord,
  FacebookAudienceTargeting,
  FacebookCallToActionType,
  FacebookChildAttachment,
  FacebookFeedTargeting,
  FacebookPhotoTag,
  FacebookPublishOptions,
  FacebookSphericalVideo,
  FacebookVideoContentCategory,
  JsonValue,
  AdapterOperationContext,
  AnalyticsReport,
  AnalyticsReportQuery,
  AnalyticsReportRow,
  CommentRef,
  ConnectedAccountRef,
  ConversationRef,
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
  optionalBoolean,
  optionalNumber,
  optionalObject,
  optionalString,
  string,
  type JsonField,
} from "../transport/validation.js";
import { httpsUrl } from "../transport/upload.js";
import { isJsonValue } from "../transport/json.js";
import { metaOAuthReconnect } from "../transport/provider-errors.js";
import { verifyMetaWebhook } from "../server/webhooks.js";
import { directWebhooks, webhookCapability } from "./webhook-adapter.js";

/*
 * Facebook Pages through the Graph API. Official sources, checked 2026-10-24:
 * - Page posts, scheduling window and deletion: https://developers.facebook.com/docs/pages-api/posts
 * - Page Reels: https://developers.facebook.com/docs/video-api/guides/reels-publishing
 * - Page webhooks: https://developers.facebook.com/docs/graph-api/webhooks/reference/page
 *
 * The adapter pins Graph v27.0, matching the Instagram adapter (Threads versions separately on
 * graph.threads.net). Changelogs checked 2026-11-04 for the v25.0 -> v27.0 move:
 * - https://developers.facebook.com/docs/graph-api/changelog/version26.0
 * - https://developers.facebook.com/blog/post/2026/11/04/introducing-graph-api-v27-and-marketing-api-v27
 * - https://developers.facebook.com/docs/pages-api/changelog
 * - https://developers.facebook.com/docs/messenger-platform/changelog
 * Items checked against this adapter's calls:
 * - Field aliases (`.as()`) closed to new apps on all versions from 2026-11-04, removed in v28.0:
 *   getReactionCounts now reads one /{object-id}/reactions edge per type instead.
 * - v27.0 adds `is_ai_generated` to POST /{post-id} edits: exposed as updatePost isAiGenerated.
 * - `total_video_consumption_rate` stops returning from /{video-id}/video_insights on all
 *   versions: the adapter passes caller-chosen metrics and hard-codes none of them.
 * - v26.0 legacy protocol removals (`date_format`, `GET /?ids=`, `pretty`, `debug`,
 *   If-None-Match), and v27.0 closures of `method`, `callback` and `asyncbatch`: not sent.
 * - v26.0 New Pages Experience fields (`current_location`, `genre`, `network`, `parking`,
 *   `start_info`) are not requested; GET /{page-id}/settings returns rows, so a removed
 *   `auto_publish_page_info_updates` row is simply absent.
 * - Commerce Order Management, Rights Manager fields and Marketing API changes: not used.
 */
const apiVersion = "v27.0";

const graphOrigin = `https://graph.facebook.com/${apiVersion}`;

const videoOrigin = `https://graph-video.facebook.com/${apiVersion}`;

const source = `Facebook Graph ${apiVersion}`;

const minimumScheduleMs = 10 * 60 * 1000;

const dayMs = 24 * 60 * 60 * 1000;

/**
 * How far ahead each format can be scheduled. The Pages posts guide gives 30 days for feed
 * and photo posts, the page/videos reference gives six months for Page videos, and the
 * Reels publishing guide requires Reels within 29 days.
 */
type ScheduleKind = "post" | "video" | "reel";

/** `native.objectType` of a post reference that is not a Page post. */
type FacebookObjectType = "video" | "photo";

/** Delivery IDs of album photos, which are bare Photo IDs rather than `{page}_{post}` IDs. */
const photoDeliveryPrefix = "photo:";

const scheduleWindows: Readonly<
  Record<
    ScheduleKind,
    { readonly noun: string; readonly label: string; readonly latest: (now: Date) => number }
  >
> = {
  post: { noun: "Page posts", label: "30 days", latest: (now) => now.getTime() + 30 * dayMs },
  video: {
    noun: "Page videos",
    label: "6 months",
    latest: (now) => {
      const latest = new Date(now.getTime());
      latest.setUTCMonth(latest.getUTCMonth() + 6);

      return latest.getTime();
    },
  },
  reel: { noun: "Reels", label: "29 days", latest: (now) => now.getTime() + 29 * dayMs },
};

const maximumPhotos = 10;

const maximumTextLength = 63_206;

/** Larger Blob videos go through the chunked upload session instead of one multipart request. */
const singleRequestVideoBytes = 1024 * 1024 * 1024;

/** The Reels guide: 30 API-published Reels per Page in a moving 24-hour period. */
const reelsPerWindow = 30;

const callToActionTypes = [
  "BOOK_TRAVEL",
  "BUY_NOW",
  "CALL_NOW",
  "DOWNLOAD",
  "GET_DIRECTIONS",
  "GET_QUOTE",
  "INSTALL_APP",
  "INSTALL_MOBILE_APP",
  "LEARN_MORE",
  "LIKE_PAGE",
  "LISTEN_MUSIC",
  "MESSAGE_PAGE",
  "NO_BUTTON",
  "OPEN_LINK",
  "PLAY_GAME",
  "SHOP_NOW",
  "SIGN_UP",
  "SUBSCRIBE",
  "USE_APP",
  "USE_MOBILE_APP",
  "WATCH_MORE",
  "WATCH_VIDEO",
] as const satisfies readonly FacebookCallToActionType[];

const videoContentCategories = [
  "BEAUTY_FASHION",
  "BUSINESS",
  "CARS_TRUCKS",
  "COMEDY",
  "CUTE_ANIMALS",
  "ENTERTAINMENT",
  "FAMILY",
  "FOOD_HEALTH",
  "HOME",
  "LIFESTYLE",
  "MUSIC",
  "NEWS",
  "POLITICS",
  "SCIENCE",
  "SPORTS",
  "TECHNOLOGY",
  "VIDEO_GAMING",
  "OTHER",
] as const satisfies readonly FacebookVideoContentCategory[];

const sphericalProjections = [
  "equirectangular",
  "cubemap",
  "half_equirectangular",
] as const satisfies readonly NonNullable<FacebookSphericalVideo["projection"]>[];

const audienceAges = [13, 15, 18, 21, 25] as const satisfies readonly NonNullable<
  FacebookAudienceTargeting["ageMin"]
>[];

const backdateGranularities = [
  "year",
  "month",
  "day",
  "hour",
  "minute",
] as const satisfies readonly NonNullable<FacebookPublishOptions["backdatedTimeGranularity"]>[];

function oneOf<T extends string | number>(values: readonly T[], value: JsonField): value is T {
  return values.some((candidate) => candidate === value);
}

/** A mutable draft whose unset fields may hold `undefined` until `definedFields` drops them. */
type Draft<T> = { -readonly [K in keyof T]?: T[K] | undefined };

interface OptionIssue {
  readonly code: string;
  readonly message: string;
}

const numericId = /^\d{1,32}$/;

/** Decode `targets[].options` into typed Facebook options, collecting every invalid value. */
interface DecodedPublishOptions {
  readonly options: FacebookPublishOptions;
  readonly issues: readonly OptionIssue[];
}

function decodePublishOptions(raw: JsonObject): DecodedPublishOptions {
  const issues: OptionIssue[] = [];
  const out: Draft<FacebookPublishOptions> = {};

  const bad = (key: string, message: string): undefined => {
    issues.push({ code: `facebook.options.${key}`, message });

    return undefined;
  };

  const bool = (key: string, value: JsonField) =>
    isBoolean(value) ? value : bad(key, `${key} must be a boolean.`);

  const id = (key: string, value: JsonField) =>
    isString(value) && numericId.test(value)
      ? value
      : bad(key, `${key} must be a numeric Facebook ID.`);

  const text = (key: string, value: JsonField) =>
    isString(value) && value.trim() !== "" ? value : bad(key, `${key} must be non-empty text.`);

  const ids = (key: string, value: JsonField, max: number) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= max &&
    value.every((entry) => isString(entry) && numericId.test(entry))
      ? value.filter(isString)
      : bad(key, `${key} must list 1 to ${max} numeric Facebook IDs.`);

  const link = (key: string, value: JsonField) => {
    if (!isString(value)) return bad(key, `${key} must be a public HTTPS URL.`);

    try {
      return httpsUrl(value).href;
    } catch {
      return bad(key, `${key} must be a public HTTPS URL.`);
    }
  };

  const record = (key: string, value: JsonField, allowed: readonly string[]) => {
    if (!isJsonObject(value)) return bad(key, `${key} must be an object.`);
    const extra = Object.keys(value).filter((name) => !allowed.includes(name));

    return extra.length === 0
      ? value
      : bad(key, `${key} accepts only ${allowed.join(", ")}; remove ${extra.join(", ")}.`);
  };

  const integer = (value: JsonField, min: number, max: number): value is number =>
    isFiniteNumber(value) && Number.isInteger(value) && value >= min && value <= max;

  for (const [key, value] of Object.entries(raw))
    switch (key) {
      case "reel":
      case "noStory":
      case "multiShareEndCard":
      case "secret":
      case "embeddable":
      case "hideFromNewsfeed":
      case "chunkedUpload":
      case "draft":
      case "isAiGenerated":
        out[key] = bool(key, value);
        break;
      case "place":
        out.place = id(key, value);
        break;
      case "tags":
        out.tags = ids(key, value, 50);
        break;
      case "contentTags":
        out.contentTags = ids(key, value, 50);
        break;
      case "title":
        out.title = text(key, value);
        break;
      case "customLabels":
        out.customLabels =
          Array.isArray(value) &&
          value.length > 0 &&
          value.every((entry) => isString(entry) && entry.trim() !== "")
            ? value.filter(isString)
            : bad(key, "customLabels must list non-empty strings.");
        break;
      case "contentCategory":
        out.contentCategory = oneOf(videoContentCategories, value)
          ? value
          : bad(key, `contentCategory must be one of ${videoContentCategories.join(", ")}.`);
        break;
      case "backdatedTime":
        out.backdatedTime =
          isString(value) && Number.isFinite(Date.parse(value))
            ? value
            : bad(key, "backdatedTime must be an ISO 8601 time.");
        break;
      case "backdatedTimeGranularity":
        out.backdatedTimeGranularity = oneOf(backdateGranularities, value)
          ? value
          : bad(
              key,
              `backdatedTimeGranularity must be one of ${backdateGranularities.join(", ")}.`,
            );
        break;
      case "photoTags": {
        const tags = Array.isArray(value) && value.length > 0 ? value : [];

        const decoded = tags.flatMap((entry): FacebookPhotoTag[] => {
          if (!isJsonObject(entry)) return [];
          const { userId, text: label, x, y } = entry;

          if (!isFiniteNumber(x) || !isFiniteNumber(y) || x < 0 || x > 100 || y < 0 || y > 100)
            return [];

          if (Object.keys(entry).some((name) => !["userId", "text", "x", "y"].includes(name)))
            return [];

          if (isString(userId) && numericId.test(userId) && label === undefined)
            return [{ userId, x, y }];

          if (isString(label) && label.trim() !== "" && userId === undefined)
            return [{ text: label, x, y }];

          return [];
        });

        out.photoTags =
          decoded.length > 0 && decoded.length === tags.length
            ? decoded
            : bad(
                key,
                "photoTags must list tags with x and y from 0 to 100 and either a numeric userId or text.",
              );
        break;
      }

      case "targeting": {
        const value_ = record(key, value, ["ageMin", "geoLocations"]);

        if (value_ === undefined) break;
        const { ageMin, geoLocations } = value_;

        if (ageMin !== undefined && !oneOf(audienceAges, ageMin)) {
          bad(key, "targeting.ageMin must be 13, 15, 18, 21, or 25.");
          break;
        }

        if (geoLocations !== undefined && !isJsonObject(geoLocations)) {
          bad(key, "targeting.geoLocations must be a Meta geo_locations object.");
          break;
        }

        if (ageMin === undefined && geoLocations === undefined) {
          bad(key, "targeting needs ageMin or geoLocations.");
          break;
        }

        out.targeting = definedFields({ ageMin, geoLocations });
        break;
      }

      case "feedTargeting": {
        const value_ = record(key, value, [
          "ageMin",
          "ageMax",
          "genders",
          "geoLocations",
          "locales",
        ]);

        if (value_ === undefined) break;
        const { ageMin, ageMax, genders, geoLocations, locales } = value_;

        const genderList =
          genders === undefined
            ? undefined
            : Array.isArray(genders) && genders.every((entry) => entry === 1 || entry === 2)
              ? genders.filter((entry): entry is 1 | 2 => entry === 1 || entry === 2)
              : null;

        const localeList =
          locales === undefined
            ? undefined
            : Array.isArray(locales) && locales.every((entry) => integer(entry, 0, 100_000))
              ? locales.filter(isFiniteNumber)
              : null;

        if (
          (ageMin !== undefined && !integer(ageMin, 13, 65)) ||
          (ageMax !== undefined && !integer(ageMax, 13, 65)) ||
          (isFiniteNumber(ageMin) && isFiniteNumber(ageMax) && ageMax < ageMin) ||
          genderList === null ||
          localeList === null ||
          (geoLocations !== undefined && !isJsonObject(geoLocations))
        ) {
          bad(
            key,
            "feedTargeting takes ageMin and ageMax from 13 to 65, genders of 1 or 2, numeric locales, and a geoLocations object.",
          );
          break;
        }

        out.feedTargeting = definedFields({
          ageMin: isFiniteNumber(ageMin) ? ageMin : undefined,
          ageMax: isFiniteNumber(ageMax) ? ageMax : undefined,
          genders: genderList,
          geoLocations: isJsonObject(geoLocations) ? geoLocations : undefined,
          locales: localeList,
        });
        break;
      }

      case "callToAction": {
        const value_ = record(key, value, ["type", "link"]);

        if (value_ === undefined) break;

        if (!oneOf(callToActionTypes, value_["type"])) {
          bad(key, `callToAction.type must be one of ${callToActionTypes.join(", ")}.`);
          break;
        }

        const target = value_["link"] === undefined ? undefined : link(key, value_["link"]);

        if (value_["link"] !== undefined && target === undefined) break;
        out.callToAction = { type: value_["type"], ...definedFields({ link: target }) };
        break;
      }

      case "childAttachments": {
        const entries = Array.isArray(value) ? value : [];

        const decoded = entries.flatMap((entry): FacebookChildAttachment[] => {
          if (!isJsonObject(entry)) return [];
          const allowed = ["link", "picture", "name", "description"];

          if (Object.keys(entry).some((name) => !allowed.includes(name))) return [];
          const href = isString(entry["link"]) ? safeHttps(entry["link"]) : undefined;
          const picture = isString(entry["picture"]) ? safeHttps(entry["picture"]) : undefined;
          const name = entry["name"];
          const description = entry["description"];

          if (
            href === undefined ||
            picture === undefined ||
            (name !== undefined && !isString(name)) ||
            (description !== undefined && !isString(description))
          )
            return [];

          return [{ link: href, picture, ...definedFields({ name, description }) }];
        });

        out.childAttachments =
          decoded.length >= 2 && decoded.length <= 5 && decoded.length === entries.length
            ? decoded
            : bad(
                key,
                "childAttachments must list 2 to 5 links, each with an HTTPS link and picture and optional name and description.",
              );
        break;
      }

      case "feeling": {
        const value_ = record(key, value, ["actionTypeId", "objectId", "iconId"]);

        if (value_ === undefined) break;
        const { actionTypeId, objectId, iconId } = value_;

        if (
          !isString(actionTypeId) ||
          !numericId.test(actionTypeId) ||
          !isString(objectId) ||
          objectId.trim() === "" ||
          (iconId !== undefined && (!isString(iconId) || !numericId.test(iconId)))
        ) {
          bad(
            key,
            "feeling needs a numeric actionTypeId, an objectId, and an optional numeric iconId.",
          );
          break;
        }

        out.feeling = { actionTypeId, objectId, ...definedFields({ iconId }) };
        break;
      }

      case "sponsorId":
      case "albumId":
      case "replaceVideoId":
        out[key] = id(key, value);
        break;
      case "sponsorRelationship":
        out.sponsorRelationship = integer(value, 0, Number.MAX_SAFE_INTEGER)
          ? value
          : bad(key, "sponsorRelationship must be Meta's numeric relationship value.");
        break;
      case "allowSphericalPhoto":
        out.allowSphericalPhoto = bool(key, value);
        break;
      case "sphericalMetadata":
        out.sphericalMetadata =
          isJsonObject(value) && isString(value["ProjectionType"])
            ? value
            : bad(key, "sphericalMetadata must be an object with a ProjectionType.");
        break;
      case "sphericalVideo": {
        const value_ = record(key, value, ["initialHeading", "initialPitch", "fov", "projection"]);

        if (value_ === undefined) break;
        const { initialHeading, initialPitch, fov, projection } = value_;

        if (
          (initialHeading !== undefined && !integer(initialHeading, -180, 360)) ||
          (initialPitch !== undefined && !integer(initialPitch, -90, 90)) ||
          (fov !== undefined && !integer(fov, 1, 180)) ||
          (projection !== undefined && !oneOf(sphericalProjections, projection))
        ) {
          bad(
            key,
            `sphericalVideo takes integer initialHeading, initialPitch (-90 to 90), and fov degrees, and a projection of ${sphericalProjections.join(", ")}.`,
          );
          break;
        }

        out.sphericalVideo = definedFields({
          initialHeading: isFiniteNumber(initialHeading) ? initialHeading : undefined,
          initialPitch: isFiniteNumber(initialPitch) ? initialPitch : undefined,
          fov: isFiniteNumber(fov) ? fov : undefined,
          projection: oneOf(sphericalProjections, projection) ? projection : undefined,
        });
        break;
      }

      case "multilingual": {
        const entries = Array.isArray(value) ? value : [];

        const decoded = entries.flatMap((entry) =>
          isJsonObject(entry) &&
          isString(entry["locale"]) &&
          /^[a-z]{2}_[A-Z]{2}$/.test(entry["locale"]) &&
          isString(entry["text"]) &&
          entry["text"].trim() !== ""
            ? [{ locale: entry["locale"], text: entry["text"] }]
            : [],
        );

        out.multilingual =
          decoded.length > 0 && decoded.length === entries.length
            ? decoded
            : bad(key, "multilingual must list { locale, text } with locales such as es_LA.");
        break;
      }

      case "expiration": {
        const value_ = record(key, value, ["at", "type"]);

        if (value_ === undefined) break;
        const { at, type } = value_;

        out.expiration =
          isString(at) &&
          Number.isFinite(Date.parse(at)) &&
          (type === "expire_and_delete" || type === "expire_only")
            ? { at, type }
            : bad(key, "expiration needs an ISO time and type expire_and_delete or expire_only.");
        break;
      }

      default:
        bad("unmapped", `Facebook has no publish option named ${key}.`);
    }

  return { options: definedFields(out), issues };
}

function safeHttps(value: string): string | undefined {
  try {
    return httpsUrl(value).href;
  } catch {
    return undefined;
  }
}

/** `targeting` and `feed_targeting` use Meta's snake_case field names. */
function targetingWire(value: FacebookAudienceTargeting): JsonObject {
  return definedFields({ age_min: value.ageMin, geo_locations: value.geoLocations });
}

function feedTargetingWire(value: FacebookFeedTargeting): JsonObject {
  return definedFields({
    age_min: value.ageMin,
    age_max: value.ageMax,
    genders: value.genders === undefined ? undefined : [...value.genders],
    geo_locations: value.geoLocations,
    locales: value.locales === undefined ? undefined : [...value.locales],
  });
}

/** Which publish options each Facebook format accepts. */
const optionsByFormat = {
  feed: [
    "place",
    "tags",
    "targeting",
    "feedTargeting",
    "callToAction",
    "childAttachments",
    "multiShareEndCard",
    "feeling",
    "backdatedTime",
    "backdatedTimeGranularity",
  ],
  photo: [
    "place",
    "photoTags",
    "noStory",
    "sponsorId",
    "sponsorRelationship",
    "albumId",
    "allowSphericalPhoto",
    "sphericalMetadata",
    "targeting",
    "feedTargeting",
    "backdatedTime",
    "backdatedTimeGranularity",
  ],
  photos: [
    "place",
    "tags",
    "targeting",
    "feedTargeting",
    "feeling",
    "backdatedTime",
    "backdatedTimeGranularity",
  ],
  video: [
    "title",
    "noStory",
    "secret",
    "embeddable",
    "hideFromNewsfeed",
    "contentCategory",
    "contentTags",
    "customLabels",
    "chunkedUpload",
    "sponsorId",
    "sponsorRelationship",
    "sphericalVideo",
    "multilingual",
    "replaceVideoId",
    "expiration",
    "targeting",
    "feedTargeting",
    "backdatedTime",
    "backdatedTimeGranularity",
  ],
  reel: ["reel", "title", "place", "draft", "isAiGenerated"],
} as const satisfies Record<string, readonly (keyof FacebookPublishOptions)[]>;

type PublishFormat = keyof typeof optionsByFormat;

export type {
  FacebookAudienceTargeting,
  FacebookCallToActionType,
  FacebookChildAttachment,
  FacebookFeedTargeting,
  FacebookFeeling,
  FacebookPhotoTag,
  FacebookPublishOptions,
  FacebookSphericalVideo,
  FacebookVideoContentCategory,
} from "../core/types.js";

export interface FacebookOptions {
  /** A Page access token for the selected Page, from a user who can perform CREATE_CONTENT. */
  readonly auth: { readonly pageId: string; readonly accessToken: string };
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
  /** App secret that Meta uses to sign webhook deliveries (`X-Hub-Signature-256`). */
  readonly webhookSecret?: string;
  /**
   * App secret for `appsecret_proof`. When set, every Graph call carries the HMAC-SHA256 of
   * the access token, which apps with Require App Secret turned on must send.
   */
  readonly appSecret?: string;
  /**
   * Called with Meta's rate-limit usage headers (`X-App-Usage`, `X-Page-Usage`, and
   * `X-Business-Use-Case-Usage`) whenever a Graph response carries them. An error thrown
   * by the callback is ignored, so it cannot turn a completed write into a failure.
   */
  readonly onRateLimitUsage?: (usage: FacebookRateLimitUsage) => void;
}

/** One usage reading; each count is a percentage of the limit, throttled at 100. */
export interface FacebookUsage {
  readonly callCount?: number;
  readonly totalCputime?: number;
  readonly totalTime?: number;
  /** Minutes until throttled calls are accepted again. */
  readonly estimatedTimeToRegainAccess?: number;
}

/** Usage parsed from Graph response headers. */
export interface FacebookRateLimitUsage {
  /** `X-App-Usage`: the app's platform rate limit. */
  readonly app?: FacebookUsage;
  /** `X-Page-Usage`: the Page token's rate limit. */
  readonly page?: FacebookUsage;
  /** `X-Business-Use-Case-Usage`: per business object and limit type, such as `pages` or `messenger`. */
  readonly businessUseCase: readonly (FacebookUsage & {
    readonly businessId: string;
    readonly type?: string;
  })[];
}

function usageFields(value: JsonField): FacebookUsage | undefined {
  if (!isJsonObject(value)) return undefined;

  return definedFields({
    callCount: optionalNumber(value["call_count"]),
    totalCputime: optionalNumber(value["total_cputime"]),
    totalTime: optionalNumber(value["total_time"]),
    estimatedTimeToRegainAccess: optionalNumber(value["estimated_time_to_regain_access"]),
  });
}

function headerJson(headers: Headers, name: string): JsonValue | undefined {
  const raw = headers.get(name);

  if (raw === null) return undefined;

  try {
    const parsed: unknown = JSON.parse(raw);

    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read Meta's usage headers from a Graph response. Returns undefined when none is present.
 * Source, checked 2026-11-04: https://developers.facebook.com/docs/graph-api/overview/rate-limiting
 */
export function parseFacebookRateLimitUsage(headers: Headers): FacebookRateLimitUsage | undefined {
  const app = usageFields(headerJson(headers, "X-App-Usage"));
  const pageUsage = usageFields(headerJson(headers, "X-Page-Usage"));
  const business = headerJson(headers, "X-Business-Use-Case-Usage");

  const businessUseCase = isJsonObject(business)
    ? Object.entries(business).flatMap(([businessId, entries]) =>
        (isJsonArray(entries) ? entries : []).filter(isJsonObject).map((entry) => ({
          businessId,
          ...usageFields(entry),
          ...definedFields({ type: optionalString(entry["type"]) }),
        })),
      )
    : [];

  if (app === undefined && pageUsage === undefined && businessUseCase.length === 0)
    return undefined;

  return { businessUseCase, ...definedFields({ app, page: pageUsage }) };
}

/** `appsecret_proof`: the hex HMAC-SHA256 of the access token keyed with the app secret. */
export async function facebookAppSecretProof(
  accessToken: string,
  appSecret: string,
): Promise<string> {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(accessToken)));

  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  /** Publish, schedule, or draft one vertical video through the Page Reels API. */
  readonly publishReel: (
    input: FacebookReelVideo & {
      readonly account: ConnectedAccountRef;
      readonly description?: string;
      readonly title?: string;
      /** Page ID of the location to tag. */
      readonly place?: string;
      readonly scheduleAt?: string;
      /** Leave the Reel as a draft (`video_state: "DRAFT"`). */
      readonly draft?: boolean;
      readonly isAiGenerated?: boolean;
      readonly context: AdapterOperationContext;
    },
  ) => Promise<DeliveryOutcome>;
  /** Share a video that another Page allowed this Page to crosspost (`crossposted_video_id`). */
  readonly crosspostVideo: (input: {
    readonly account: ConnectedAccountRef;
    readonly videoId: string;
    readonly description?: string;
    readonly title?: string;
    readonly scheduleAt?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<DeliveryOutcome>;
  /** Invite another Page to collaborate on a Reel (POST /{video-id}/collaborators). */
  readonly inviteReelCollaborator: (input: {
    readonly account: ConnectedAccountRef;
    readonly videoId: string;
    readonly collaboratorPageId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly collaboratorId?: string; readonly invitationLink?: string }>;
  /** List a Reel's collaborator invitations and their `invite_status`. */
  readonly listReelCollaborators: (input: {
    readonly account: ConnectedAccountRef;
    readonly videoId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Read the Reel's `copyright_check_information`. */
  readonly getReelCopyrightCheck: (input: {
    readonly account: ConnectedAccountRef;
    readonly videoId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<FacebookCopyrightCheck>;
  /** Upload an unpublished photo, then publish it as a Page photo Story. */
  readonly publishPhotoStory: (
    input: FacebookStoryPhoto & {
      readonly account: ConnectedAccountRef;
      readonly context: AdapterOperationContext;
    },
  ) => Promise<DeliveryOutcome>;
  /** Publish a vertical video as a Page Story through the three-phase /video_stories flow. */
  readonly publishVideoStory: (
    input: FacebookReelVideo & {
      readonly account: ConnectedAccountRef;
      readonly isAiGenerated?: boolean;
      readonly context: AdapterOperationContext;
    },
  ) => Promise<DeliveryOutcome>;
  /** List the Page's Stories (GET /{page-id}/stories). */
  readonly listStories: (
    input: FacebookListInput & {
      readonly status?: "PUBLISHED" | "ARCHIVED";
      /** ISO times that bound the Story creation time. */
      readonly since?: string;
      readonly until?: string;
    },
  ) => Promise<Page<JsonObject>>;
  /** Create a Page live video, now or scheduled, and return its RTMPS ingest URL. */
  readonly createLiveVideo: (
    input: FacebookLiveOptions & {
      readonly account: ConnectedAccountRef;
      readonly title?: string;
      readonly description?: string;
      readonly context: AdapterOperationContext;
    } & (
        | {
            /** `UNPUBLISHED` creates a preview; `LIVE_NOW` goes live when the stream starts. */
            readonly status: "UNPUBLISHED" | "LIVE_NOW";
            readonly startAt?: never;
          }
        | {
            /** A planned broadcast: `SCHEDULED_UNPUBLISHED` is a preview, `SCHEDULED_LIVE` is announced. */
            readonly status: "SCHEDULED_UNPUBLISHED" | "SCHEDULED_LIVE";
            /** ISO start time, sent as `event_params.start_time`. */
            readonly startAt: string;
          }
      ),
  ) => Promise<FacebookLiveVideo>;
  /** Reschedule, retitle, go live, or cancel a planned broadcast (POST /{live-video-id}). */
  readonly updateLiveVideo: (input: {
    readonly account: ConnectedAccountRef;
    readonly liveVideoId: string;
    readonly status?:
      | "LIVE_NOW"
      | "SCHEDULED_UNPUBLISHED"
      | "SCHEDULED_LIVE"
      | "SCHEDULED_CANCELED";
    readonly startAt?: string;
    readonly title?: string;
    readonly description?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** The Page's live broadcasts (GET /{page-id}/live_videos). */
  readonly listLiveVideos: (input: FacebookListInput) => Promise<Page<JsonObject>>;
  /** One broadcast's status, planned start, and ingest stream health; stream URLs are dropped. */
  readonly getLiveVideo: (input: {
    readonly account: ConnectedAccountRef;
    readonly liveVideoId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Delete a broadcast (DELETE /{live-video-id}). */
  readonly deleteLiveVideo: (input: {
    readonly account: ConnectedAccountRef;
    readonly liveVideoId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Add a poll to a live broadcast (POST /{live-video-id}/polls). */
  readonly createLivePoll: (input: {
    readonly account: ConnectedAccountRef;
    readonly liveVideoId: string;
    readonly question: string;
    readonly options: readonly string[];
    /** 1-based number of the correct option, for a quiz. */
    readonly correctOption?: number;
    readonly showResults?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly id: string }>;
  /** Show voting, show results, close, attach, or delete a live poll (POST /{video-poll-id}). */
  readonly updateLivePoll: (input: {
    readonly account: ConnectedAccountRef;
    readonly pollId: string;
    readonly action: "ATTACH_TO_VIDEO" | "SHOW_VOTING" | "SHOW_RESULTS" | "CLOSE" | "DELETE_POLL";
    readonly showResults?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** A video's thumbnails and which one is preferred (GET /{video-id}/thumbnails). */
  readonly listVideoThumbnails: (input: {
    readonly account: ConnectedAccountRef;
    readonly videoId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  /** Upload a thumbnail image for an existing Page video (POST /{video-id}/thumbnails). */
  readonly addVideoThumbnail: (input: {
    readonly account: ConnectedAccountRef;
    readonly videoId: string;
    /** At most 10 MB. */
    readonly image: Blob;
    readonly isPreferred?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** A video's caption tracks (GET /{video-id}/captions). */
  readonly listVideoCaptions: (input: {
    readonly account: ConnectedAccountRef;
    readonly videoId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  /** Upload an SRT caption file, set the default locale, or delete caption locales. */
  readonly updateVideoCaptions: (input: {
    readonly account: ConnectedAccountRef;
    readonly videoId: string;
    /** SRT file of at most 200 KB for `locale`, such as `en_US`. */
    readonly captions?: { readonly file: Blob; readonly locale: string };
    /** A locale such as `en_US`, or `none`. */
    readonly defaultLocale?: string;
    readonly localesToDelete?: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Video and Reel Insights (GET /{video-id}/video_insights). */
  readonly getVideoInsights: (input: {
    readonly account: ConnectedAccountRef;
    readonly videoId: string;
    /** Defaults to `facebookReelInsightMetrics` with the `lifetime` period. */
    readonly metrics?: readonly string[];
    readonly period?: FacebookInsightPeriod;
    readonly since?: string;
    readonly until?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly FacebookInsightSeries[]>;
  /** The Page's photo albums (GET /{page-id}/albums). */
  readonly listAlbums: (input: FacebookListInput) => Promise<Page<JsonObject>>;
  /** One album's details (GET /{album-id}). */
  readonly getAlbum: (input: {
    readonly account: ConnectedAccountRef;
    readonly albumId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Photos in an album (GET /{album-id}/photos). */
  readonly listAlbumPhotos: (
    input: FacebookListInput & { readonly albumId: string },
  ) => Promise<Page<JsonObject>>;
  /** End a live broadcast (`end_live_video`). */
  readonly endLiveVideo: (input: {
    readonly account: ConnectedAccountRef;
    readonly liveVideoId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** List posts scheduled to publish later (GET /{page-id}/scheduled_posts). */
  readonly listScheduledPosts: (input: FacebookListInput) => Promise<Page<JsonObject>>;
  /**
   * Edit a post's message, pin, unpin, hide, or unhide it, or set its AI-generated label
   * (POST /{post-id}).
   */
  readonly updatePost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly message?: string;
    readonly pinned?: boolean;
    readonly hidden?: boolean;
    /** `true` adds Meta's AI-generated label, `false` removes it, omitted keeps it (Graph v27.0). */
    readonly isAiGenerated?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** List the Page's Reels, which posts.list does not return (GET /{page-id}/video_reels). */
  readonly listReels: (input: FacebookListInput) => Promise<Page<JsonObject>>;
  /** Posts that tag the Page (GET /{page-id}/tagged). */
  readonly listTaggedPosts: (input: FacebookListInput) => Promise<Page<JsonObject>>;
  /** Posts that visitors published on the Page (GET /{page-id}/visitor_posts). */
  readonly listVisitorPosts: (input: FacebookListInput) => Promise<Page<JsonObject>>;
  /** Photos the Page uploaded (GET /{page-id}/photos?type=uploaded). */
  readonly listPhotos: (input: FacebookListInput) => Promise<Page<JsonObject>>;
  /** Update Page details such as `about` or `website` (POST /{page-id}). */
  readonly updatePage: (input: {
    readonly account: ConnectedAccountRef;
    readonly about?: string;
    readonly description?: string;
    readonly website?: string;
    readonly phone?: string;
    readonly emails?: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Read Page settings as `{ setting, value }` rows (GET /{page-id}/settings). */
  readonly listPageSettings: (input: FacebookListInput) => Promise<Page<JsonObject>>;
  /** Turn one Page setting, such as `USERS_CAN_MESSAGE`, on or off. */
  readonly updatePageSetting: (input: {
    readonly account: ConnectedAccountRef;
    readonly setting: string;
    readonly value: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** People with a role on the Page and their tasks (GET /{page-id}/roles). */
  readonly listPageRoles: (input: FacebookListInput) => Promise<Page<JsonObject>>;
  /** Accept or reject a change Facebook proposed for the Page. */
  readonly respondToChangeProposal: (input: {
    readonly account: ConnectedAccountRef;
    readonly proposalId: string;
    readonly accept: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Recommendations and reviews of the Page (GET /{page-id}/ratings). */
  readonly listRatings: (input: FacebookListInput) => Promise<Page<JsonObject>>;
  /** Search Pages by name (GET /pages/search); needs Page Public Metadata Access. */
  readonly searchPages: (
    input: FacebookListInput & { readonly query: string },
  ) => Promise<Page<JsonObject>>;
  /** Read comments with Meta's `filter` and an optional `total_count` summary. */
  readonly listComments: (input: {
    readonly account: ConnectedAccountRef;
    readonly objectId: string;
    /** `toplevel` (the default) or `stream`, which adds replies in chronological order. */
    readonly filter?: "toplevel" | "stream";
    /** `chronological` (Meta's default) or `reverse_chronological` for newest first. */
    readonly order?: "chronological" | "reverse_chronological";
    /** Also read `can_reply_privately` and `private_reply_conversation`; needs `pages_messaging`. */
    readonly privateReplyFields?: boolean;
    readonly summary?: boolean;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject> & { readonly totalCount?: number }>;
  /** Comment on a post or reply to a comment, with text, an image, or a GIF. */
  readonly createComment: (
    input: FacebookCommentBody & {
      readonly account: ConnectedAccountRef;
      readonly objectId: string;
      readonly context: AdapterOperationContext;
    },
  ) => Promise<{ readonly id: string }>;
  /** Edit a comment's text or attachment (POST /{comment-id}). */
  readonly editComment: (
    input: FacebookCommentBody & {
      readonly account: ConnectedAccountRef;
      readonly commentId: string;
      readonly context: AdapterOperationContext;
    },
  ) => Promise<void>;
  /** Block a person from the Page by Page-scoped ID (POST /{page-id}/blocked). */
  readonly blockUser: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** People blocked from the Page (GET /{page-id}/blocked). */
  readonly listBlockedUsers: (input: FacebookListInput) => Promise<Page<JsonObject>>;
  /** Unblock a person by Page-scoped ID (DELETE /{page-id}/blocked). */
  readonly unblockUser: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Like (`liked: true`) or unlike a post, photo, album, or comment as the Page. */
  readonly setLike: (input: {
    readonly account: ConnectedAccountRef;
    readonly objectId: string;
    readonly liked: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Public reshares of a Page post (GET /{post-id}/sharedposts). */
  readonly listSharedPosts: (
    input: FacebookListInput & { readonly postId: string },
  ) => Promise<Page<JsonObject>>;
  /** Business and system users assigned to the Page with their tasks. */
  readonly listAssignedUsers: (
    input: FacebookListInput & { readonly businessId: string },
  ) => Promise<Page<JsonObject>>;
  /** Give a business or system user Page tasks (POST /{page-id}/assigned_users). */
  readonly assignUser: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly tasks: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Remove a business or system user from the Page (DELETE /{page-id}/assigned_users). */
  readonly unassignUser: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Location Pages under this main Page (GET /{page-id}/locations). */
  readonly listLocations: (input: FacebookListInput) => Promise<Page<JsonObject>>;
  /** Add a location Page under this main Page (POST /{page-id}/locations). */
  readonly addLocation: (
    input: {
      readonly account: ConnectedAccountRef;
      /** Your own ID for the store. */
      readonly storeNumber: string;
      readonly context: AdapterOperationContext;
    } & (
      | { readonly locationPageId: string; readonly newLocation?: never }
      | { readonly newLocation: FacebookNewLocation; readonly locationPageId?: never }
    ),
  ) => Promise<void>;
  /** Remove a location Page from this main Page (DELETE /{page-id}/locations). */
  readonly removeLocation: (input: {
    readonly account: ConnectedAccountRef;
    readonly storeNumber: string;
    readonly locationPageId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** The Page's video playlists (GET /{page-id}/video_lists). */
  readonly listVideoLists: (input: FacebookListInput) => Promise<Page<JsonObject>>;
  /** Set the Page profile picture from a hosted URL or an existing Page photo. */
  readonly setProfilePicture: (
    input: {
      readonly account: ConnectedAccountRef;
      readonly context: AdapterOperationContext;
    } & (
      | { readonly pictureUrl: string; readonly photoId?: never }
      | { readonly photoId: string; readonly pictureUrl?: never }
    ),
  ) => Promise<void>;
  /** Set the Page cover photo from a Page photo ID (POST /{page-id} with `cover`). */
  readonly setCoverPhoto: (input: {
    readonly account: ConnectedAccountRef;
    readonly photoId: string;
    /** Offset as a percentage from 0 through 100. */
    readonly offsetX?: number;
    readonly offsetY?: number;
    readonly noFeedStory?: boolean;
    readonly noNotification?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Remove this app's webhook subscription from the Page (DELETE /{page-id}/subscribed_apps). */
  readonly unsubscribeApp: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Count reactions on a post or comment by type. */
  readonly getReactionCounts: (input: {
    readonly account: ConnectedAccountRef;
    readonly objectId: string;
    readonly types?: readonly FacebookReactionType[];
    readonly context: AdapterOperationContext;
  }) => Promise<Readonly<Partial<Record<FacebookReactionType, number>>>>;
  /** Subscribe this app to the Page's webhook fields (POST /{page-id}/subscribed_apps). */
  readonly subscribeApp: (input: {
    readonly account: ConnectedAccountRef;
    readonly fields: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Apps subscribed to the Page's webhooks and their `subscribed_fields`. */
  readonly listSubscribedApps: (input: FacebookListInput) => Promise<Page<JsonObject>>;
  /** Send a Messenger message from the Page (POST /{page-id}/messages). */
  readonly sendMessage: (input: FacebookMessageInput) => Promise<FacebookSentMessage>;
  /** Post Insights such as `post_media_view` or `post_clicks` (GET /{post-id}/insights). */
  readonly getPostInsights: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly metrics: readonly string[];
    readonly period?: FacebookInsightPeriod;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly FacebookInsightSeries[]>;
  /** Page Insights for any period, by `date_preset` or a `since`/`until` range of at most 90 days. */
  readonly getPageInsights: (
    input: {
      readonly account: ConnectedAccountRef;
      readonly metrics: readonly string[];
      readonly period: FacebookInsightPeriod;
      readonly context: AdapterOperationContext;
    } & (
      | {
          readonly datePreset: FacebookInsightDatePreset;
          readonly since?: never;
          readonly until?: never;
        }
      | { readonly since: string; readonly until: string; readonly datePreset?: never }
      | { readonly datePreset?: never; readonly since?: never; readonly until?: never }
    ),
  ) => Promise<readonly FacebookInsightSeries[]>;
  /** Show typing or seen indicators, or react to a message (`sender_action`). */
  readonly sendSenderAction: (
    input: FacebookSenderAction & {
      readonly account: ConnectedAccountRef;
      readonly recipientId: string;
      readonly context: AdapterOperationContext;
    },
  ) => Promise<{ readonly recipientId?: string }>;
  /** Create a Messenger persona (POST /{page-id}/personas). */
  readonly createPersona: (input: {
    readonly account: ConnectedAccountRef;
    /** Up to 50 characters. */
    readonly name: string;
    readonly profilePictureUrl: string;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly id: string }>;
  /** The Page's personas (GET /{page-id}/personas). */
  readonly listPersonas: (input: FacebookListInput) => Promise<Page<FacebookPersona>>;
  /** Soft-delete a persona (DELETE /{persona-id}); its earlier messages stay visible. */
  readonly deletePersona: (input: {
    readonly account: ConnectedAccountRef;
    readonly personaId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Save a reusable attachment from a URL or bytes (POST /{page-id}/message_attachments). */
  readonly uploadMessageAttachment: (
    input: {
      readonly account: ConnectedAccountRef;
      readonly type: "image" | "video" | "audio" | "file";
      readonly context: AdapterOperationContext;
    } & (
      | { readonly url: string; readonly file?: never }
      | { readonly file: Blob; readonly url?: never }
    ),
  ) => Promise<{ readonly attachmentId: string }>;
  /** Read a person's profile by Page-scoped ID (User Profile API). */
  readonly getUserProfile: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    /** Defaults to `first_name`, `last_name`, and `profile_pic`. */
    readonly fields?: readonly FacebookUserProfileField[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Messenger conversations filtered by one person or by inbox folder. */
  readonly listConversations: (
    input: FacebookListInput & {
      /** The person's Page-scoped ID; returns the conversation with that person. */
      readonly userId?: string;
      readonly folder?: FacebookConversationFolder;
    },
  ) => Promise<Page<JsonObject>>;
  /** One message with attachments, shares, story, tags, and reactions (GET /{message-id}). */
  readonly getMessage: (input: {
    readonly account: ConnectedAccountRef;
    readonly messageId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<FacebookMessageDetail>;
  /** Read Messenger profile properties (GET /{page-id}/messenger_profile). */
  readonly getMessengerProfile: (input: {
    readonly account: ConnectedAccountRef;
    readonly fields: readonly FacebookMessengerProfileField[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Set Messenger profile properties; only the properties passed are overwritten. */
  readonly setMessengerProfile: (
    input: FacebookMessengerProfile & {
      readonly account: ConnectedAccountRef;
      readonly context: AdapterOperationContext;
    },
  ) => Promise<void>;
  /** Delete Messenger profile properties (DELETE /{page-id}/messenger_profile). */
  readonly deleteMessengerProfileFields: (input: {
    readonly account: ConnectedAccountRef;
    readonly fields: readonly FacebookMessengerProfileField[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Pass the conversation to another app, such as Page Inbox (`facebookPageInboxAppId`). */
  readonly passThreadControl: (input: {
    readonly account: ConnectedAccountRef;
    readonly recipientId: string;
    readonly targetAppId: string;
    readonly metadata?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Ask the app that owns the conversation to pass control to this app. */
  readonly requestThreadControl: (input: {
    readonly account: ConnectedAccountRef;
    readonly recipientId: string;
    readonly metadata?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Release control so the conversation returns to idle. */
  readonly releaseThreadControl: (input: {
    readonly account: ConnectedAccountRef;
    readonly recipientId: string;
    readonly metadata?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** The app ID that currently owns a conversation (GET /{page-id}/thread_owner). */
  readonly getThreadOwner: (input: {
    readonly account: ConnectedAccountRef;
    readonly recipientId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly appId?: string }>;
  /** Create a custom label for people (POST /{page-id}/custom_labels). */
  readonly createCustomLabel: (input: {
    readonly account: ConnectedAccountRef;
    readonly name: string;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly id: string }>;
  /** The Page's custom labels, or one person's labels when `userId` is set. */
  readonly listCustomLabels: (
    input: FacebookListInput & { readonly userId?: string },
  ) => Promise<Page<{ readonly id: string; readonly name?: string }>>;
  /** Assign a label to a person, or remove it with `assigned: false` (/{label-id}/label). */
  readonly setCustomLabel: (input: {
    readonly account: ConnectedAccountRef;
    readonly labelId: string;
    readonly userId: string;
    readonly assigned: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Delete a custom label (DELETE /{label-id}). */
  readonly deleteCustomLabel: (input: {
    readonly account: ConnectedAccountRef;
    readonly labelId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Submit a utility message template for review (POST /{page-id}/message_templates). */
  readonly createUtilityTemplate: (input: {
    readonly account: ConnectedAccountRef;
    readonly name: string;
    readonly language: string;
    /** HEADER, BODY, and BUTTONS components in Meta's wire shape, with examples. */
    readonly components: readonly JsonObject[];
    readonly parameterFormat?: "POSITIONAL" | "NAMED";
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly id: string; readonly status?: string; readonly category?: string }>;
  /** The Page's message templates (GET /{page-id}/message_templates). */
  readonly listMessageTemplates: (
    input: FacebookListInput & {
      readonly name?: string;
      readonly status?: readonly string[];
      readonly language?: readonly string[];
    },
  ) => Promise<Page<JsonObject>>;
  /** Send an approved utility template (`messaging_type: "UTILITY"`). */
  readonly sendUtilityTemplate: (input: {
    readonly account: ConnectedAccountRef;
    readonly recipientId: string;
    readonly name: string;
    readonly language: string;
    readonly header?: readonly FacebookTemplateParameter[];
    readonly body?: readonly FacebookTemplateParameter[];
    readonly context: AdapterOperationContext;
  }) => Promise<FacebookSentMessage>;
  /** Read Messenger Calling settings (GET /{page-id}/messenger_call_settings). */
  readonly getCallSettings: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Change the call icon, call hours, or inbound routing (POST messenger_call_settings). */
  readonly updateCallSettings: (input: {
    readonly account: ConnectedAccountRef;
    readonly iconEnabled?: boolean;
    readonly callHours?: FacebookCallHours;
    /** `META` rings Meta inboxes; `PARTNERS` rings apps subscribed to the calls webhook. */
    readonly ringTarget?: "META" | "PARTNERS";
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Send one private Messenger reply to the person who wrote a Page post comment. */
  readonly privateReply: (input: {
    readonly account: ConnectedAccountRef;
    readonly commentId: string;
    readonly text: string;
    readonly context: AdapterOperationContext;
  }) => Promise<FacebookSentMessage>;
}

/**
 * How a Messenger message may be sent: `RESPONSE` inside the 24-hour window after the
 * person's last message, `UPDATE` for a non-promotional update in that window, or
 * `MESSAGE_TAG` with `HUMAN_AGENT`, which lets a person reply manually for 7 days.
 */
export type FacebookMessaging =
  | { readonly messagingType: "RESPONSE" | "UPDATE"; readonly tag?: never }
  | { readonly messagingType: "MESSAGE_TAG"; readonly tag: "HUMAN_AGENT" };

/** An image, video, audio, or file attachment, by public URL or by a reusable attachment ID. */
export type FacebookMessageAttachment =
  | {
      readonly type: "image" | "video" | "audio" | "file";
      readonly url: string;
      /** Ask Meta to keep the upload so its `attachment_id` can be sent again. */
      readonly isReusable?: boolean;
    }
  | { readonly type: "image" | "video" | "audio" | "file"; readonly attachmentId: string };

/**
 * A quick reply button (`quick_replies`): a text button with a payload, or a button that
 * asks for the person's phone number or email address.
 */
export type FacebookQuickReply =
  | {
      readonly contentType: "text";
      /** Up to 20 characters. */
      readonly title: string;
      /** Up to 1,000 characters, returned in the `messages` webhook as `quick_reply.payload`. */
      readonly payload: string;
      readonly imageUrl?: string;
    }
  | { readonly contentType: "user_phone_number" | "user_email" };

/** Push behavior for a Send API message (`notification_type`); Meta's default is `REGULAR`. */
export type FacebookNotificationType = "REGULAR" | "SILENT_PUSH" | "NO_PUSH";

/** Send API options that apply to a text or attachment message. */
export interface FacebookSendOptions {
  /** Up to 13 quick reply buttons shown above the composer. */
  readonly quickReplies?: readonly FacebookQuickReply[];
  /** Quote an earlier message by its `mid` (`reply_to`). */
  readonly replyToMessageId?: string;
  readonly notificationType?: FacebookNotificationType;
  /** Up to 1,000 characters echoed back in the `message_echoes` webhook. */
  readonly metadata?: string;
  /** Send as a persona created with `createPersona` (`persona_id`). */
  readonly personaId?: string;
}

export type FacebookMessageInput = FacebookMessaging &
  FacebookSendOptions & {
    readonly account: ConnectedAccountRef;
    /** The person's Page-scoped ID. */
    readonly recipientId: string;
    readonly context: AdapterOperationContext;
  } & (
    | { readonly text: string; readonly attachment?: never }
    | { readonly attachment: FacebookMessageAttachment; readonly text?: never }
  );

export interface FacebookSentMessage {
  readonly messageId: string;
  readonly recipientId?: string;
  /** Present when Meta saved a reusable attachment. */
  readonly attachmentId?: string;
}

/**
 * A Messenger sender action (`sender_action`). Typing and seen indicators carry no message;
 * `react` sets an emoji reaction on one message and `unreact` removes it.
 */
export type FacebookSenderAction =
  | { readonly action: "typing_on" | "typing_off" | "mark_seen"; readonly personaId?: string }
  | { readonly action: "react"; readonly messageId: string; readonly reaction: string }
  | { readonly action: "unreact"; readonly messageId: string };

export interface FacebookPersona {
  readonly id: string;
  readonly name?: string;
  readonly profilePictureUrl?: string;
}

/** A new location Page; Meta limits creating new locations to selected developers. */
export interface FacebookNewLocation {
  readonly location: {
    readonly street: string;
    readonly city?: string;
    readonly state?: string;
    readonly zip?: string;
    readonly country?: string;
    readonly cityId?: number;
    readonly latitude: number;
    readonly longitude: number;
  };
  /** Place topic IDs that describe the business. */
  readonly placeTopics: readonly number[];
  readonly phone: string;
  /** Opening hours keyed `{day}_{n}_{open|close}`, such as `{ mon_1_open: "09:00" }`. */
  readonly hours?: Readonly<Record<string, string>>;
}

/** Reels metrics from the video_insights reference; each uses the `lifetime` period. */
export const facebookReelInsightMetrics = [
  "blue_reels_play_count",
  "fb_reels_total_plays",
  "fb_reels_replay_count",
  "post_impressions_unique",
  "post_video_avg_time_watched",
  "post_video_view_time",
  "post_video_followers",
  "post_video_social_actions",
] as const;

/** App ID of Page Inbox, the usual `targetAppId` when handing a conversation to people. */
export const facebookPageInboxAppId = "263902037430900";

/** Messenger Profile API properties. */
export type FacebookMessengerProfileField =
  | "get_started"
  | "greeting"
  | "ice_breakers"
  | "persistent_menu"
  | "whitelisted_domains"
  | "account_linking_url"
  | "commands";

/**
 * Messenger profile properties to set. `iceBreakers`, `persistentMenu`, and `commands`
 * use Meta's wire objects, such as `{ locale, composer_input_disabled, call_to_actions }`.
 */
export interface FacebookMessengerProfile {
  /** Postback payload sent when someone taps Get Started. */
  readonly getStarted?: { readonly payload: string };
  /** Welcome-screen greetings by locale; `default` is required when any is set. */
  readonly greeting?: readonly { readonly locale: string; readonly text: string }[];
  readonly iceBreakers?: readonly JsonObject[];
  readonly persistentMenu?: readonly JsonObject[];
  /** HTTPS origins allowed for Messenger Extensions and the checkbox plugin. */
  readonly whitelistedDomains?: readonly string[];
  readonly accountLinkingUrl?: string;
  readonly commands?: readonly JsonObject[];
}

/** One template variable value; `parameterName` is for templates with NAMED parameters. */
export interface FacebookTemplateParameter {
  readonly text: string;
  readonly parameterName?: string;
}

/** Weekly call hours; omitted days are closed and each update replaces all hours. */
export interface FacebookCallHours {
  /** IANA time zone, such as `America/Los_Angeles`. */
  readonly timezoneId: string;
  readonly weeklyOperatingHours: readonly {
    readonly dayOfWeek:
      | "MONDAY"
      | "TUESDAY"
      | "WEDNESDAY"
      | "THURSDAY"
      | "FRIDAY"
      | "SATURDAY"
      | "SUNDAY";
    /** `hhmm`, such as `0900`. */
    readonly openTime: string;
    readonly closeTime: string;
  }[];
}

/** User Profile API fields for a Page-scoped ID; locale, timezone, and gender need extra permissions. */
export type FacebookUserProfileField =
  | "first_name"
  | "last_name"
  | "name"
  | "profile_pic"
  | "locale"
  | "timezone"
  | "gender";

/** Page inbox folders accepted by the Conversations API `folder` filter. */
export type FacebookConversationFolder = "inbox" | "other" | "page_done" | "spam";

export interface FacebookMessageAttachmentDetail {
  readonly id?: string;
  readonly name?: string;
  readonly fileUrl?: string;
  /** `url`, `preview_url`, `width`, `height`, `render_as_sticker`, and GIF URLs. */
  readonly imageData?: JsonObject;
  /** `url`, `preview_url`, `width`, and `height`. */
  readonly videoData?: JsonObject;
}

/** One Messenger message with its attachments, shares, story reference, tags, and reactions. */
export interface FacebookMessageDetail {
  readonly id: string;
  readonly message?: string;
  readonly createdTime?: string;
  readonly from?: JsonObject;
  readonly to: readonly JsonObject[];
  readonly attachments: readonly FacebookMessageAttachmentDetail[];
  /** Image URL of an attachment that Messenger renders as a sticker. */
  readonly sticker?: string;
  readonly shares: readonly JsonObject[];
  /** The story a message replied to or mentioned, as `{ id, link }`. */
  readonly story?: JsonObject;
  /** Folder and source tags such as `inbox`, `read`, or `source:chat`. */
  readonly tags: readonly string[];
  readonly reactions: readonly { readonly reaction: string; readonly userIds: readonly string[] }[];
  /** True when the message holds content the API cannot return. */
  readonly isUnsupported?: boolean;
}

/** Insights periods from the insights reference; each metric supports only some of them. */
export type FacebookInsightPeriod =
  | "day"
  | "week"
  | "days_28"
  | "month"
  | "lifetime"
  | "total_over_range";

/** `date_preset` ranges named in the insights reference. */
export type FacebookInsightDatePreset =
  | "last_7d"
  | "last_28d"
  | "last_90d"
  | "this_month"
  | "maximum";

/** One Insights metric. A value is a count, or an object keyed by source or breakdown. */
export interface FacebookInsightSeries {
  readonly name: string;
  readonly period?: string;
  readonly title?: string;
  readonly values: readonly { readonly value: JsonValue; readonly endTime?: string }[];
}

const insightPeriods = [
  "day",
  "week",
  "days_28",
  "month",
  "lifetime",
  "total_over_range",
] as const satisfies readonly FacebookInsightPeriod[];

const insightDatePresets = [
  "last_7d",
  "last_28d",
  "last_90d",
  "this_month",
  "maximum",
] as const satisfies readonly FacebookInsightDatePreset[];

/** Reaction types from the object/reactions reference; `SORRY` is the sad reaction. */
export type FacebookReactionType = "LIKE" | "LOVE" | "WOW" | "HAHA" | "SORRY" | "ANGRY";

const reactionTypes = [
  "LIKE",
  "LOVE",
  "WOW",
  "HAHA",
  "SORRY",
  "ANGRY",
] as const satisfies readonly FacebookReactionType[];

/** A comment's text and at most one attachment: an image URL, an unpublished photo ID, or a GIF URL. */
export interface FacebookCommentBody {
  readonly message?: string;
  readonly attachmentUrl?: string;
  readonly attachmentId?: string;
  readonly attachmentShareUrl?: string;
}

/**
 * Mention text for a Page comment or post: `@[id]`, or `@[id,id]` for several people in a
 * reply to a comment. Meta lets a Page mention only people who created or commented on the
 * post, with their Page-scoped IDs.
 */
export function facebookMention(ids: readonly [string, ...string[]]): string {
  if (!ids.every((id) => numericId.test(id)))
    throw new SocialError({
      code: "invalid_input",
      operation: "facebook.mention",
      message: "Mention IDs must be numeric Page-scoped IDs.",
    });

  return `@[${ids.join(",")}]`;
}

export interface FacebookListInput {
  readonly account: ConnectedAccountRef;
  readonly cursor?: string;
  readonly limit?: number;
  readonly context: AdapterOperationContext;
}

/** A Story photo: a public HTTPS URL or the image bytes. */
export type FacebookStoryPhoto =
  | { readonly photoUrl: string; readonly photo?: never }
  | { readonly photo: Blob; readonly photoUrl?: never };

/** Broadcast options from the page/live_videos reference. */
export interface FacebookLiveOptions {
  /** Ask for a backup ingest URL (`enable_backup_ingest`). */
  readonly enableBackupIngest?: boolean;
  /** Stop the broadcast when the encoder sends deleteStream (`stop_on_delete_stream`). */
  readonly stopOnDeleteStream?: boolean;
  /** Interest IDs that describe the broadcast (`content_tags`). */
  readonly contentTags?: readonly string[];
  readonly targeting?: FacebookAudienceTargeting;
  /** Crosspost the broadcast to Pages with a crossposting relationship. */
  readonly crosspostingActions?: readonly {
    readonly pageId: string;
    readonly action:
      | "enable_crossposting"
      | "disable_crossposting"
      | "enable_crossposting_and_create_post";
  }[];
  /** A 360 broadcast (`is_spherical`) and its projection. */
  readonly isSpherical?: boolean;
  readonly projection?: "EQUIRECTANGULAR" | "CUBEMAP" | "HALF_EQUIRECTANGULAR";
}

export interface FacebookLiveVideo {
  readonly id: string;
  /**
   * RTMPS ingest URL with the stream key. It is a credential: send it only to the encoder
   * that streams, and never log it.
   */
  readonly secureStreamUrl?: string;
}

/** A Reel's video: a public HTTPS URL that Facebook fetches, or the bytes to upload. */
export type FacebookReelVideo =
  | { readonly videoUrl: string; readonly video?: never }
  | { readonly video: Blob; readonly videoUrl?: never };

export interface FacebookCopyrightCheck {
  /** `in_progress` until Meta finishes the check, then `complete`. */
  readonly status: string;
  readonly matchesFound?: boolean;
  /** Each match's `content_title`, `owner_copyright_policy`, and `matched_segments`. */
  readonly matches: readonly JsonObject[];
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

function graphPage(
  result: JsonObject,
  fields: readonly string[],
  project: (row: JsonObject) => JsonObject = (row) => row,
): Page<JsonObject> {
  const items = array(result["data"]).map((entry) => project(publicFields(entry, fields)));

  return { items, ...definedFields({ nextCursor: nextGraphCursor(result) }) };
}

type GraphRequest = ReturnType<typeof managedHttp>;

/** Add `appsecret_proof` to every call's query when an app secret is configured. */
function withAppSecretProof(
  graphRequest: GraphRequest,
  accessToken: string,
  appSecret: string | undefined,
): GraphRequest {
  if (appSecret === undefined) return graphRequest;

  if (!appSecret.trim())
    throw new SocialError({
      code: "invalid_config",
      operation: "createAdapter",
      message: "The Facebook app secret for appsecret_proof is empty.",
    });

  let proof: Promise<string> | undefined;

  return async (path, context, body, query = {}, method, headers) => {
    proof ??= facebookAppSecretProof(accessToken, appSecret);

    return graphRequest(
      path,
      context,
      body,
      { ...query, appsecret_proof: await proof },
      method,
      headers,
    );
  };
}

/** Report usage headers from every response, then hand the response on unchanged. */
function usageReportingFetch(
  base: typeof globalThis.fetch | undefined,
  onUsage: ((usage: FacebookRateLimitUsage) => void) | undefined,
): typeof globalThis.fetch | undefined {
  if (onUsage === undefined) return base;

  return async (input, init) => {
    const response = await (base ?? globalThis.fetch)(input, init);
    const usage = parseFacebookRateLimitUsage(response.headers);

    if (usage !== undefined)
      try {
        onUsage(usage);
      } catch {
        // The callback is observational; its failure must not change the request outcome.
      }

    return response;
  };
}

/** Graph reports an expired Page token as code 190 on HTTP 400; surface it as a reconnect. */
function reconnectOnExpiredToken(graphRequest: GraphRequest): GraphRequest {
  return async (...args) => {
    try {
      return await graphRequest(...args);
    } catch (error) {
      if (error instanceof SocialError) throw metaOAuthReconnect(error);

      throw error;
    }
  };
}

/** Transport options shared by the standalone Facebook Login helpers. */
export interface FacebookHelperOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function helperRequest(
  token: string,
  input: FacebookHelperOptions,
  appSecret?: string,
): GraphRequest {
  return reconnectOnExpiredToken(
    withAppSecretProof(
      managedHttp(graphOrigin, { apiKey: token, ...definedFields({ fetch: input.fetch }) }),
      token,
      appSecret,
    ),
  );
}

function helperContext(
  input: FacebookHelperOptions,
  correlationId: string,
): AdapterOperationContext {
  return {
    backendInstance: "facebook",
    correlationId,
    retryBudget: { maxAttempts: 3, maxElapsedMs: input.timeoutMs ?? 30_000 },
    ...definedFields({ signal: input.signal }),
  };
}

/** A Facebook app's ID and secret. Keep the secret on the server. */
export interface FacebookAppCredentials {
  readonly appId: string;
  readonly appSecret: string;
}

function appAccessToken(app: FacebookAppCredentials, operation: string): string {
  if (!numericId.test(app.appId) || !app.appSecret.trim())
    fail(operation, "Pass the numeric Facebook appId and its appSecret.");

  return `${app.appId}|${app.appSecret}`;
}

export interface FacebookUserToken {
  readonly accessToken: string;
  readonly tokenType?: string;
  /** Seconds until the token expires, when Meta reports it. */
  readonly expiresIn?: number;
}

function userToken(value: JsonField): FacebookUserToken {
  const result = object(value);

  return {
    accessToken: string(result["access_token"]),
    ...definedFields({
      tokenType: optionalString(result["token_type"]),
      expiresIn: optionalNumber(result["expires_in"]),
    }),
  };
}

/**
 * Build the Facebook Login dialog URL (`https://www.facebook.com/{version}/dialog/oauth`)
 * for the code flow. Store `state` server-side and compare it on the redirect.
 * Source, checked 2026-11-04:
 * https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/
 */
export function facebookLoginUrl(input: {
  readonly appId: string;
  readonly redirectUri: string;
  /** An unguessable value of at least 16 characters, checked on the redirect. */
  readonly state: string;
  readonly scopes: readonly string[];
  /** Ask again for permissions the person declined (`auth_type=rerequest`). */
  readonly rerequest?: boolean;
}): string {
  const operation = "facebook.login.url";

  if (!numericId.test(input.appId)) fail(operation, "appId must be the numeric Facebook app ID.");

  if (input.state.length < 16) fail(operation, "state must be at least 16 unguessable characters.");

  if (input.scopes.some((scope) => !/^[a-z_]{1,64}$/.test(scope)))
    fail(operation, "scopes must be Facebook permission names such as pages_show_list.");

  const url = new URL(`https://www.facebook.com/${apiVersion}/dialog/oauth`);

  url.searchParams.set("client_id", input.appId);
  url.searchParams.set("redirect_uri", httpsUrl(input.redirectUri).href);
  url.searchParams.set("state", input.state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(","));

  if (input.rerequest === true) url.searchParams.set("auth_type", "rerequest");

  return url.href;
}

/** Exchange the Login dialog's `code` for a user access token (GET /oauth/access_token). */
export async function exchangeFacebookCode(
  input: FacebookAppCredentials &
    FacebookHelperOptions & {
      readonly code: string;
      /** The exact `redirect_uri` sent to the Login dialog. */
      readonly redirectUri: string;
    },
): Promise<FacebookUserToken> {
  const operation = "facebook.login.exchange";

  if (!input.code.trim()) fail(operation, "Pass the code from the Login dialog redirect.");

  const request = helperRequest(appAccessToken(input, operation), input);

  return userToken(
    await request("/oauth/access_token", helperContext(input, operation), undefined, {
      client_id: input.appId,
      redirect_uri: httpsUrl(input.redirectUri).href,
      client_secret: input.appSecret,
      code: input.code,
    }),
  );
}

/**
 * Exchange a short-lived user token for a long-lived one (about 60 days) with
 * `grant_type=fb_exchange_token`. Page tokens that `discoverFacebookPages` reads with a
 * long-lived user token do not expire.
 */
export async function exchangeFacebookToken(
  input: FacebookAppCredentials & FacebookHelperOptions & { readonly accessToken: string },
): Promise<FacebookUserToken> {
  const operation = "facebook.login.long_lived";

  if (!input.accessToken.trim()) fail(operation, "Pass the short-lived user access token.");

  const request = helperRequest(appAccessToken(input, operation), input);

  return userToken(
    await request("/oauth/access_token", helperContext(input, operation), undefined, {
      grant_type: "fb_exchange_token",
      client_id: input.appId,
      client_secret: input.appSecret,
      fb_exchange_token: input.accessToken,
    }),
  );
}

/** What `debug_token` reports about a user or Page token. */
export interface FacebookTokenInfo {
  readonly isValid: boolean;
  /** True when the token was issued to the app whose credentials made the call. */
  readonly issuedToThisApp: boolean;
  readonly type?: string;
  readonly userId?: string;
  readonly profileId?: string;
  readonly scopes: readonly string[];
  /** Per-permission target IDs, such as the Pages a `pages_*` scope covers. */
  readonly granularScopes: readonly {
    readonly scope: string;
    readonly targetIds: readonly string[];
  }[];
  /** ISO expiry; absent when the token does not expire. */
  readonly expiresAt?: string;
  /** ISO time when the app loses data access unless the person returns. */
  readonly dataAccessExpiresAt?: string;
}

function unixTime(value: JsonField): string | undefined {
  const seconds = optionalNumber(value);

  return seconds === undefined || seconds === 0
    ? undefined
    : new Date(seconds * 1000).toISOString();
}

/** Inspect a token's validity, scopes, and expiry with the app token (GET /debug_token). */
export async function inspectFacebookToken(
  input: FacebookAppCredentials & FacebookHelperOptions & { readonly inputToken: string },
): Promise<FacebookTokenInfo> {
  const operation = "facebook.login.debug_token";

  if (!input.inputToken.trim()) fail(operation, "Pass the token to inspect.");

  const request = helperRequest(appAccessToken(input, operation), input);

  const data = object(
    object(
      await request("/debug_token", helperContext(input, operation), undefined, {
        input_token: input.inputToken,
      }),
    )["data"],
  );

  const id = (value: JsonField) =>
    isString(value) ? value : isFiniteNumber(value) ? String(value) : undefined;

  return {
    isValid: data["is_valid"] === true,
    issuedToThisApp: id(data["app_id"]) === input.appId,
    scopes: (isJsonArray(data["scopes"]) ? data["scopes"] : []).filter(isString),
    granularScopes: (isJsonArray(data["granular_scopes"]) ? data["granular_scopes"] : [])
      .filter(isJsonObject)
      .flatMap((entry) => {
        const scope = optionalString(entry["scope"]);

        return scope === undefined
          ? []
          : [
              {
                scope,
                targetIds: (isJsonArray(entry["target_ids"]) ? entry["target_ids"] : [])
                  .map(id)
                  .filter((value) => value !== undefined),
              },
            ];
      }),
    ...definedFields({
      type: optionalString(data["type"]),
      userId: id(data["user_id"]),
      profileId: id(data["profile_id"]),
      expiresAt: unixTime(data["expires_at"]),
      dataAccessExpiresAt: unixTime(data["data_access_expires_at"]),
    }),
  };
}

/** Which permissions a person granted, declined, or let expire (GET /me/permissions). */
export async function listFacebookPermissions(
  input: FacebookHelperOptions & {
    readonly userAccessToken: string;
    readonly appSecret?: string;
  },
): Promise<{
  readonly granted: readonly string[];
  readonly declined: readonly string[];
  readonly expired: readonly string[];
}> {
  const operation = "facebook.login.permissions";
  const request = helperRequest(input.userAccessToken, input, input.appSecret);

  const rows = array(
    object(await request("/me/permissions", helperContext(input, operation)))["data"],
  );

  const named = (status: string) =>
    rows
      .filter(isJsonObject)
      .filter((row) => row["status"] === status)
      .map((row) => optionalString(row["permission"]))
      .filter((permission) => permission !== undefined);

  return { granted: named("granted"), declined: named("declined"), expired: named("expired") };
}

/**
 * List the Pages a Facebook Login user token can manage, with their Page access
 * tokens (GET /me/accounts). Requires `pages_show_list`; publishing also needs
 * `pages_manage_posts` and `pages_read_engagement`. The tokens are credentials:
 * persist only the Page your application selected.
 */
export async function discoverFacebookPages(
  input: FacebookHelperOptions & {
    readonly userAccessToken: string;
    /** Adds `appsecret_proof` for apps with Require App Secret on. */
    readonly appSecret?: string;
    readonly cursor?: string;
    readonly limit?: number;
  },
): Promise<Page<FacebookPageGrant>> {
  const request = helperRequest(input.userAccessToken, input, input.appSecret);
  const context = helperContext(input, "facebook-page-discovery");

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

  const http = {
    apiKey: options.auth.accessToken,
    ...definedFields({ fetch: usageReportingFetch(options.fetch, options.onRateLimitUsage) }),
  };

  const graph = (origin: string) =>
    reconnectOnExpiredToken(
      withAppSecretProof(managedHttp(origin, http), options.auth.accessToken, options.appSecret),
    );

  const request = graph(graphOrigin);
  const videoRequest = graph(videoOrigin);

  // The Reels upload host expects `Authorization: OAuth <token>` rather than a bearer token.
  const ruploadRequest = reconnectOnExpiredToken(
    managedHttp("https://rupload.facebook.com", http, (token) => [
      "Authorization",
      `OAuth ${token}`,
    ]),
  );

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

  /**
   * Decode a dispatched write's answer. A write whose answer is not an object may still have
   * taken effect, so it is uncertain and must be reconciled rather than repeated.
   */
  const writeObject = (value: JsonField, operation: string): JsonObject => {
    if (isJsonObject(value)) return value;

    throw new SocialError({
      code: "ambiguous_outcome",
      operation,
      message: "Facebook returned an unreadable answer to the write. Reconcile before retrying.",
      retryDisposition: { kind: "reconcile-first" },
    });
  };

  /** Read the ID a write returned; without it the write is uncertain, not failed. */
  const writeId = (result: JsonObject, key: string, operation: string): string => {
    const id = result[key];

    if (isString(id) && id.length > 0) return id;

    throw new SocialError({
      code: "ambiguous_outcome",
      operation,
      message: `Facebook returned no ${key} for the write. Reconcile before retrying.`,
      retryDisposition: { kind: "reconcile-first" },
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

  /** Posts report `scheduled_publish_time` as Unix seconds; videos report an ISO datetime. */
  const scheduledTimeMs = (value: JsonField): number | undefined => {
    if (isFiniteNumber(value)) return value * 1000;

    if (!isString(value)) return undefined;
    const time = Date.parse(value);

    return Number.isFinite(time) ? time : undefined;
  };

  /**
   * Cancelling deletes the object, so a post or video that went live after it was
   * scheduled would be removed. Require affirmative evidence that it is still
   * unpublished with a future publish time. Feed post IDs are `{page-id}_{post-id}`;
   * Page videos and Reels use bare video IDs and report `published` instead.
   */
  const requireFutureSchedule = async (
    id: string,
    context: AdapterOperationContext,
  ): Promise<void> => {
    const post = id.includes("_");

    const node = object(
      await request(`/${encodeURIComponent(id)}`, context, undefined, {
        fields: post
          ? "id,is_published,scheduled_publish_time"
          : "id,published,scheduled_publish_time",
      }),
    );

    const unpublished = (post ? node["is_published"] : node["published"]) === false;
    const at = scheduledTimeMs(node["scheduled_publish_time"]);

    if (!unpublished || at === undefined || at <= clock().getTime())
      throw new SocialError({
        code: "invalid_input",
        operation: "posts.cancelScheduled",
        message:
          "Only an unpublished Facebook post or video with a future publish time can be cancelled. Reconcile a due or published item.",
      });
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
    objectType?: FacebookObjectType,
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
    objectType?: FacebookObjectType,
  ): DeliveryOutcome => ({
    state: "published",
    targetIndex,
    account,
    observedAt: now(),
    // A bare Photo ID would read as a video delivery, so album photos carry a prefix.
    delivery: delivery(
      account,
      objectType === "photo" ? `${photoDeliveryPrefix}${postId}` : postId,
    ),
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

  /** Multipart parts carry objects as JSON text; JSON bodies keep them as objects. */
  const formValue = (value: JsonValue): string => (isString(value) ? value : JSON.stringify(value));

  const present = (fields: Readonly<Record<string, JsonValue | undefined>>) =>
    Object.entries(fields).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined);

  /** A JSON body, or a multipart form when a file part such as `thumb` is attached. */
  const fieldsBody = (
    fields: Readonly<Record<string, JsonValue | undefined>>,
    files: Readonly<Record<string, Blob>>,
  ): JsonObject | FormData => {
    const attached = Object.entries(files);

    if (attached.length === 0) return Object.fromEntries(present(fields));

    const form = new FormData();

    for (const [key, value] of present(fields)) form.set(key, formValue(value));

    for (const [key, blob] of attached) form.set(key, blob, key);

    return form;
  };

  /** Graph accepts hosted media by URL or uploaded bytes in a multipart `source` part. */
  const mediaBody = (
    item: MediaAttachment,
    urlField: "url" | "file_url",
    fields: Readonly<Record<string, JsonValue | undefined>>,
    files: Readonly<Record<string, Blob>> = {},
  ): JsonObject | FormData => {
    if (item.source.kind === "https-url")
      return fieldsBody({ [urlField]: httpsUrl(item.source.url).href, ...fields }, files);

    if (item.source.kind !== "blob")
      fail("facebook.posts.publish", "Facebook media must be a public HTTPS URL or a Blob.");

    const form = new FormData();
    form.set("source", item.source.blob, item.filename ?? "upload");

    for (const [key, value] of present(fields)) form.set(key, formValue(value));

    for (const [key, blob] of Object.entries(files)) form.set(key, blob, key);

    return form;
  };

  const scheduleProblem = (at: string, kind: ScheduleKind): string | undefined => {
    const current = clock();
    const time = Date.parse(at);
    const window = scheduleWindows[kind];

    return !Number.isFinite(time) ||
      time - current.getTime() < minimumScheduleMs ||
      time > window.latest(current)
      ? `Facebook schedules ${window.noun} between 10 minutes and ${window.label} ahead.`
      : undefined;
  };

  const scheduleIssue = (at: string, kind: ScheduleKind, operation: string): void => {
    const problem = scheduleProblem(at, kind);

    if (problem !== undefined) fail(operation, problem);
  };

  /** Photos and videos spell the minute granularity `min`; feed posts spell it `minute`. */
  const backdateFields = (options: FacebookPublishOptions, spelling: "feed" | "media") =>
    definedFields({
      backdated_time:
        options.backdatedTime === undefined ? undefined : scheduleSeconds(options.backdatedTime),
      backdated_time_granularity:
        spelling === "media" && options.backdatedTimeGranularity === "minute"
          ? "min"
          : options.backdatedTimeGranularity,
    });

  const audienceFields = (options: FacebookPublishOptions) =>
    definedFields({
      targeting: options.targeting === undefined ? undefined : targetingWire(options.targeting),
      feed_targeting:
        options.feedTargeting === undefined ? undefined : feedTargetingWire(options.feedTargeting),
    });

  /** Feed post fields from the page/feed reference. */
  const feedOptionFields = (options: FacebookPublishOptions, postLink: string | undefined) => {
    const buttonLink = options.callToAction?.link ?? postLink;

    return {
      ...definedFields({
        place: options.place,
        tags: options.tags?.join(","),
        call_to_action:
          options.callToAction === undefined || buttonLink === undefined
            ? undefined
            : { type: options.callToAction.type, value: { link: buttonLink } },
        child_attachments: options.childAttachments?.map((child) =>
          definedFields({
            link: child.link,
            picture: child.picture,
            name: child.name,
            description: child.description,
          }),
        ),
        multi_share_end_card: options.multiShareEndCard,
        og_action_type_id: options.feeling?.actionTypeId,
        og_object_id: options.feeling?.objectId,
        og_icon_id: options.feeling?.iconId,
      }),
      ...audienceFields(options),
      ...backdateFields(options, "feed"),
    };
  };

  /** Single-photo fields from the page/photos reference; tag positions are percentages. */
  const photoOptionFields = (options: FacebookPublishOptions) => ({
    ...definedFields({
      place: options.place,
      tags: options.photoTags?.map((tag) =>
        "userId" in tag
          ? { tag_uid: tag.userId, x: tag.x, y: tag.y }
          : { tag_text: tag.text, x: tag.x, y: tag.y },
      ),
      no_story: options.noStory,
      allow_spherical_photo: options.allowSphericalPhoto,
      spherical_metadata: options.sphericalMetadata,
    }),
    ...brandedFields(options),
    ...audienceFields(options),
    ...backdateFields(options, "media"),
  });

  /** Branded content tags; both photos and videos accept them. */
  const brandedFields = (options: FacebookPublishOptions) =>
    definedFields({
      sponsor_id: options.sponsorId,
      sponsor_relationship: options.sponsorRelationship,
    });

  /** 360 video fields; `spherical` must be true for the others to apply. */
  const sphericalVideoFields = (value: FacebookSphericalVideo | undefined) =>
    value === undefined
      ? {}
      : {
          spherical: true,
          ...definedFields({
            initial_heading: value.initialHeading,
            initial_pitch: value.initialPitch,
            fov: value.fov,
            original_projection_type: value.projection,
          }),
        };

  /** Page video fields from the page/videos reference. */
  const videoOptionFields = (options: FacebookPublishOptions) => ({
    ...definedFields({
      title: options.title,
      no_story: options.noStory,
      secret: options.secret,
      embeddable: options.embeddable,
      hide_from_newsfeed: options.hideFromNewsfeed,
      content_category: options.contentCategory,
      content_tags: options.contentTags === undefined ? undefined : [...options.contentTags],
      custom_labels: options.customLabels === undefined ? undefined : [...options.customLabels],
      multilingual_data: options.multilingual?.map((entry) => ({
        multilingual_status_lang: entry.locale,
        multilingual_status: entry.text,
      })),
      replace_video_id: options.replaceVideoId,
      swap_mode: options.replaceVideoId === undefined ? undefined : "replace",
      expiration:
        options.expiration === undefined
          ? undefined
          : { time: scheduleSeconds(options.expiration.at), type: options.expiration.type },
    }),
    ...sphericalVideoFields(options.sphericalVideo),
    ...brandedFields(options),
    ...audienceFields(options),
    ...backdateFields(options, "media"),
  });

  /** Keeps the delivery of a video or Reel container that exists after an interrupted upload. */
  const uploadInterrupted = (
    account: ConnectedAccountRef,
    targetIndex: number,
    videoId: string,
    error: SocialError | undefined,
    what: string,
  ): DeliveryOutcome => {
    if (
      error === undefined ||
      error.code === "timeout" ||
      error.code === "ambiguous_outcome" ||
      error.code === "cancelled"
    )
      return {
        state: "unknown",
        targetIndex,
        account,
        observedAt: now(),
        delivery: delivery(account, videoId),
        reason: "ambiguous-submission",
        diagnostic: `The ${what} was interrupted after Facebook created it. Reconcile it.`,
      };

    return {
      state: "failed",
      targetIndex,
      account,
      observedAt: now(),
      delivery: delivery(account, videoId),
      code: error.code,
      message: error.message,
      retryDisposition: { kind: "reconcile-first" },
    };
  };

  /** Graph reports upload offsets as numeric strings. */
  const byteOffset = (value: JsonField, size: number): number => {
    const parsed = isString(value) && /^\d+$/.test(value) ? Number(value) : value;

    if (!isFiniteNumber(parsed) || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > size)
      throw new SocialError({
        code: "upstream_failure",
        operation: "facebook.videos.upload",
        message: "Facebook returned an upload offset outside the file.",
      });

    return parsed;
  };

  /**
   * Chunked Page video upload on graph-video: `start` with `file_size` opens a session,
   * each `transfer` sends the byte range Facebook asks for as `video_file_chunk` from
   * `start_offset`, and `finish` publishes with the post fields.
   */
  const uploadVideoInChunks = async (input: {
    readonly target: PreparedPublishTarget;
    readonly blob: Blob;
    readonly fields: Readonly<Record<string, JsonValue | undefined>>;
    readonly files: Readonly<Record<string, Blob>>;
    readonly context: AdapterOperationContext;
  }): Promise<DeliveryOutcome> => {
    const { target, blob, context } = input;
    const path = `/${encodeURIComponent(pageId)}/videos`;

    const started = writeObject(
      await videoRequest(path, context, { upload_phase: "start", file_size: blob.size }),
      "facebook.videos.upload",
    );

    const videoId = writeId(started, "video_id", "facebook.videos.upload");

    try {
      const sessionId = string(started["upload_session_id"]);
      let start = byteOffset(started["start_offset"], blob.size);
      let end = byteOffset(started["end_offset"], blob.size);

      while (start < end) {
        const form = new FormData();
        form.set("upload_phase", "transfer");
        form.set("upload_session_id", sessionId);
        form.set("start_offset", String(start));
        form.set("video_file_chunk", blob.slice(start, end), "chunk");

        const moved = writeObject(
          await videoRequest(path, context, form),
          "facebook.videos.upload",
        );

        const next = byteOffset(moved["start_offset"], blob.size);

        if (next <= start)
          throw new SocialError({
            code: "upstream_failure",
            operation: "facebook.videos.upload",
            message: "Facebook did not advance the chunked video upload.",
          });

        start = next;
        end = byteOffset(moved["end_offset"], blob.size);
      }

      if (start !== blob.size)
        throw new SocialError({
          code: "upstream_failure",
          operation: "facebook.videos.upload",
          message: "Facebook ended the chunked upload before receiving the whole file.",
        });

      confirmSuccess(
        await videoRequest(
          path,
          context,
          fieldsBody(
            { upload_phase: "finish", upload_session_id: sessionId, ...input.fields },
            input.files,
          ),
        ),
        "facebook.videos.upload",
        "Facebook did not confirm the chunked video upload.",
      );
    } catch (error) {
      return uploadInterrupted(
        target.account,
        target.targetIndex,
        videoId,
        error instanceof SocialError ? error : undefined,
        "chunked video upload",
      );
    }

    return target.schedule === undefined
      ? processing(target.account, target.targetIndex, videoId, "VIDEO_SUBMITTED")
      : scheduled(target.account, target.targetIndex, videoId);
  };

  /** Start times of Reels this adapter created, for Meta's moving-window Reels limit. */
  const reelStarts: number[] = [];

  const claimReelSlot = (): number => {
    const current = clock().getTime();

    while ((reelStarts[0] ?? current) <= current - dayMs) reelStarts.shift();

    if (reelStarts.length >= reelsPerWindow)
      throw new SocialError({
        code: "rate_limited",
        operation: "facebook.reels.publish",
        message: `This adapter already started ${reelsPerWindow} Reels for the Page in the last day, which is Meta's Reels API limit.`,
        retryDisposition: {
          kind: "after-delay",
          delayMs: Math.max(0, (reelStarts[0] ?? current) + dayMs - current),
        },
      });

    reelStarts.push(current);

    return current;
  };

  const releaseReelSlot = (claimed: number): void => {
    const index = reelStarts.indexOf(claimed);

    if (index !== -1) reelStarts.splice(index, 1);
  };

  /** Hosted video: a `file_url` header. Local bytes: the body, with `offset` and `file_size`. */
  const ruploadSource = (input: FacebookReelVideo, operation: string) => {
    const upload =
      input.video !== undefined
        ? {
            body: input.video,
            headers: { offset: "0", file_size: String(input.video.size) },
          }
        : input.videoUrl !== undefined
          ? { body: undefined, headers: { file_url: httpsUrl(input.videoUrl).href } }
          : fail(operation, "Pass a hosted videoUrl or the video bytes.");

    if (upload.body !== undefined && upload.body.size === 0) fail(operation, "The video is empty.");

    return upload;
  };

  /** Sends the video to the `upload_url` that the start phase returned, on rupload.facebook.com only. */
  const sendToRupload = async (
    started: JsonObject,
    upload: ReturnType<typeof ruploadSource>,
    context: AdapterOperationContext,
    operation: string,
  ): Promise<void> => {
    const uploadUrl = URL.parse(isString(started["upload_url"]) ? started["upload_url"] : "");

    if (uploadUrl?.protocol !== "https:" || uploadUrl.hostname !== "rupload.facebook.com")
      throw new SocialError({
        code: "upstream_failure",
        operation,
        message: "Facebook returned a video upload URL outside rupload.facebook.com.",
      });

    confirmSuccess(
      await ruploadRequest(uploadUrl.pathname, context, upload.body, {}, "POST", upload.headers),
      operation,
      "Facebook did not confirm the video upload.",
    );
  };

  const publishReel: FacebookNative["publishReel"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.reels.publish";

    if (input.draft === true && input.scheduleAt !== undefined)
      fail(operation, "A draft Reel cannot also be scheduled.");

    if (input.scheduleAt !== undefined) scheduleIssue(input.scheduleAt, "reel", operation);

    if (input.place !== undefined && !numericId.test(input.place))
      fail(operation, "place must be a numeric Facebook Page ID.");

    const upload = ruploadSource(input, operation);

    const page = `/${encodeURIComponent(pageId)}/video_reels`;
    const claimed = claimReelSlot();
    let started: JsonObject;

    try {
      started = writeObject(
        await request(page, input.context, { upload_phase: "start" }),
        operation,
      );
    } catch (error) {
      // A definite refusal created no Reel, so it does not count against the limit.
      if (
        error instanceof SocialError &&
        error.code !== "timeout" &&
        error.code !== "ambiguous_outcome" &&
        error.code !== "cancelled"
      )
        releaseReelSlot(claimed);

      throw error;
    }

    const videoId = writeId(started, "video_id", operation);

    try {
      // Inside the try: the container already exists, so a bad upload URL must still
      // return its delivery instead of losing the only reference to it.
      await sendToRupload(started, upload, input.context, "facebook.reels.upload");

      const finish = writeObject(
        await request(page, input.context, {
          upload_phase: "finish",
          video_id: videoId,
          video_state:
            input.draft === true
              ? "DRAFT"
              : input.scheduleAt === undefined
                ? "PUBLISHED"
                : "SCHEDULED",
          ...definedFields({
            description: input.description,
            title: input.title,
            place: input.place,
            is_ai_generated: input.isAiGenerated,
            scheduled_publish_time:
              input.scheduleAt === undefined ? undefined : scheduleSeconds(input.scheduleAt),
          }),
        }),
        operation,
      );

      confirmSuccess(finish, operation, "Facebook did not confirm the Reel.");
    } catch (error) {
      // The Reel container exists. Return its delivery so callers can reconcile it through
      // posts.status instead of losing the only reference to a Reel that may still publish.
      return uploadInterrupted(
        input.account,
        0,
        videoId,
        error instanceof SocialError ? error : undefined,
        "Reel upload",
      );
    }

    if (input.draft === true)
      return {
        state: "accepted",
        targetIndex: 0,
        account: input.account,
        observedAt: now(),
        delivery: delivery(input.account, videoId),
        backendState: "REEL_DRAFT",
      };

    return input.scheduleAt === undefined
      ? processing(input.account, 0, videoId, "REEL_SUBMITTED")
      : scheduled(input.account, 0, videoId);
  };

  const publishPhotos = async (
    target: PreparedPublishTarget,
    media: readonly MediaAttachment[],
    options: FacebookPublishOptions,
    context: AdapterOperationContext,
  ): Promise<DeliveryOutcome> => {
    const page = `/${encodeURIComponent(pageId)}`;
    const schedule = target.schedule;
    const first = media[0];

    if (media.length === 1 && first !== undefined && schedule === undefined) {
      const result = writeObject(
        await request(
          options.albumId === undefined
            ? `${page}/photos`
            : `/${encodeURIComponent(options.albumId)}/photos`,
          context,
          mediaBody(first, "url", {
            caption: target.content.text,
            alt_text_custom: first.altText,
            ...photoOptionFields(options),
          }),
        ),
        "facebook.posts.publish",
      );

      const postId = optionalString(result["post_id"]);

      // Meta returns no post_id for a photo added to an album; the ID is then a Photo node.
      // https://developers.facebook.com/docs/graph-api/reference/photo/ (checked 2026-11-04)
      return postId === undefined
        ? published(
            target.account,
            target.targetIndex,
            writeId(result, "id", "facebook.posts.publish"),
            "photo",
          )
        : published(target.account, target.targetIndex, postId);
    }

    const photoIds: string[] = [];

    // Removes the unpublished photos this call created, once Facebook definitely made no post
    // with them. Returns the IDs it could not remove.
    const discardPhotos = async (): Promise<string[]> => {
      const kept: string[] = [];

      for (const id of photoIds)
        try {
          await deleteObject(id, context, "facebook.posts.publish");
        } catch {
          kept.push(id);
        }

      return kept;
    };

    const definiteFailure = async (error: SocialError): Promise<never> => {
      const kept = await discardPhotos();

      throw new SocialError({
        code: error.code,
        operation: "facebook.posts.publish",
        message: error.message,
        ...definedFields({
          details: kept.length === 0 ? undefined : { unpublishedPhotoIds: kept },
        }),
        retryDisposition: error.retryDisposition,
        cause: error,
      });
    };

    try {
      for (const item of media) {
        const uploaded = writeObject(
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
          "facebook.posts.publish",
        );

        photoIds.push(writeId(uploaded, "id", "facebook.posts.publish"));
      }
    } catch (error) {
      if (!(error instanceof SocialError)) throw error;

      // No feed post exists yet, so every staged photo is safe to remove.
      return definiteFailure(error);
    }

    let result: JsonObject;

    try {
      result = writeObject(
        await request(`${page}/feed`, context, {
          attached_media: photoIds.map((id) => ({ media_fbid: id })),
          ...definedFields({ message: target.content.text }),
          ...feedOptionFields(options, undefined),
          ...scheduleFields(schedule),
        }),
        "facebook.posts.publish",
      );
    } catch (error) {
      // An ambiguous answer may still have created the post, which needs its photos, so they
      // stay and the client reports the target as unknown. A definite refusal created nothing.
      if (
        !(error instanceof SocialError) ||
        error.code === "timeout" ||
        error.code === "ambiguous_outcome" ||
        error.code === "cancelled"
      )
        throw error;

      return definiteFailure(error);
    }

    const id = writeId(result, "id", "facebook.posts.publish");

    return schedule === undefined
      ? published(target.account, target.targetIndex, id)
      : scheduled(target.account, target.targetIndex, id);
  };

  /** The format a target publishes as, which decides its endpoint, options, and schedule window. */
  const publishFormat = (target: PreparedPublishTarget, reel: boolean): PublishFormat => {
    const media = target.content.media ?? [];

    if (media.length === 0) return "feed";

    if (media[0]?.kind === "video") return reel ? "reel" : "video";

    return media.length === 1 && target.schedule === undefined ? "photo" : "photos";
  };

  const scheduleKind = (format: PublishFormat): ScheduleKind =>
    format === "video" ? "video" : format === "reel" ? "reel" : "post";

  const targetOptions = (target: PreparedPublishTarget): FacebookPublishOptions => {
    const decoded = decodePublishOptions(optionsObject(target));
    const first = decoded.issues[0];

    if (first !== undefined) fail("facebook.posts.publish", first.message);

    return decoded.options;
  };

  const publishTarget = async (
    target: PreparedPublishTarget,
    context: AdapterOperationContext,
  ): Promise<DeliveryOutcome> => {
    authorize(target.account, context);
    const media = target.content.media ?? [];
    const schedule = target.schedule;
    const page = `/${encodeURIComponent(pageId)}`;
    const options = targetOptions(target);
    const format = publishFormat(target, options.reel === true);

    if (schedule !== undefined)
      scheduleIssue(schedule.at, scheduleKind(format), "facebook.posts.schedule");

    if (format === "feed") {
      const result = writeObject(
        await request(`${page}/feed`, context, {
          ...definedFields({ message: target.content.text, link: target.content.link?.url }),
          ...feedOptionFields(options, target.content.link?.url),
          ...scheduleFields(schedule),
        }),
        "facebook.posts.publish",
      );

      const id = writeId(result, "id", "facebook.posts.publish");

      return schedule === undefined
        ? published(target.account, target.targetIndex, id)
        : scheduled(target.account, target.targetIndex, id);
    }

    const video = media[0];

    if (video?.kind === "video" && format === "reel") {
      const source = video.source;

      if (source.kind !== "https-url" && source.kind !== "blob")
        fail("facebook.reels.publish", "Reels upload from a public HTTPS URL or a Blob.");

      const outcome = await publishReel({
        account: target.account,
        context,
        ...(source.kind === "https-url" ? { videoUrl: source.url } : { video: source.blob }),
        ...definedFields({
          description: target.content.text,
          scheduleAt: schedule?.at,
          title: options.title,
          place: options.place,
          draft: options.draft,
          isAiGenerated: options.isAiGenerated,
        }),
      });

      return { ...outcome, targetIndex: target.targetIndex };
    }

    if (video?.kind === "video") {
      const thumbnail = video.thumbnail;

      const files: Record<string, Blob> =
        thumbnail?.kind === "blob" ? { thumb: thumbnail.blob } : {};

      const fields = {
        description: target.content.text,
        published: schedule === undefined ? undefined : "false",
        scheduled_publish_time: schedule === undefined ? undefined : scheduleSeconds(schedule.at),
        ...videoOptionFields(options),
      };

      if (
        video.source.kind === "blob" &&
        (options.chunkedUpload === true || video.source.blob.size > singleRequestVideoBytes)
      )
        return uploadVideoInChunks({ target, blob: video.source.blob, fields, files, context });

      const result = writeObject(
        await videoRequest(`${page}/videos`, context, mediaBody(video, "file_url", fields, files)),
        "facebook.videos.upload",
      );

      const id = writeId(result, "id", "facebook.videos.upload");

      return schedule === undefined
        ? processing(target.account, target.targetIndex, id, "VIDEO_SUBMITTED")
        : scheduled(target.account, target.targetIndex, id);
    }

    return publishPhotos(target, media, options, context);
  };

  const prepareTarget = (target: PreparedPublishTarget): PreparationIssue[] => {
    const issues: PreparationIssue[] = [];

    const issue = (code: string, message: string) =>
      issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

    if (target.account.platform !== "facebook" || target.account.accountId !== pageId)
      issue("facebook.account", "Select the configured Facebook Page.");

    const media = target.content.media ?? [];
    const text = target.content.text;
    const decoded = decodePublishOptions(optionsObject(target));
    const options = decoded.options;
    const reel = options.reel === true;
    const format = publishFormat(target, reel);

    for (const problem of decoded.issues) issue(problem.code, problem.message);

    const allowed: readonly string[] = optionsByFormat[format];

    for (const key of Object.keys(options))
      if (key !== "reel" && !allowed.includes(key))
        issue(
          "facebook.option_format",
          `The ${key} option does not apply to a Facebook ${format} post.`,
        );

    if (options.tags !== undefined && options.place === undefined)
      issue("facebook.tags_place", "Facebook accepts feed post tags only together with a place.");

    if (
      options.callToAction !== undefined &&
      options.callToAction.link === undefined &&
      target.content.link === undefined
    )
      issue(
        "facebook.call_to_action_link",
        "A call-to-action button needs content.link or its own link.",
      );

    if (options.backdatedTime !== undefined) {
      const time = Date.parse(options.backdatedTime);

      if (!(time < clock().getTime()))
        issue("facebook.backdated_time", "backdatedTime must be in the past.");

      if (target.schedule !== undefined)
        issue("facebook.backdated_schedule", "A scheduled post cannot also be backdated.");
    }

    if (options.backdatedTimeGranularity !== undefined && options.backdatedTime === undefined)
      issue("facebook.backdated_granularity", "backdatedTimeGranularity needs backdatedTime.");

    if (options.albumId !== undefined && (media.length !== 1 || target.schedule !== undefined))
      issue("facebook.album_photo", "albumId applies to one photo published now.");

    if (
      options.expiration !== undefined &&
      !(Date.parse(options.expiration.at) > clock().getTime())
    )
      issue("facebook.expiration", "expiration.at must be in the future.");

    if (options.sponsorRelationship !== undefined && options.sponsorId === undefined)
      issue("facebook.sponsor", "sponsorRelationship needs sponsorId.");

    if (options.draft === true && target.schedule !== undefined)
      issue("facebook.reel_draft_schedule", "A draft Reel cannot also be scheduled.");

    if (options.chunkedUpload === true && media[0]?.source.kind !== "blob")
      issue("facebook.chunked_source", "Chunked upload applies to a video passed as a Blob.");

    if (target.replyTo)
      issue(
        "reply.use_comments",
        "Reply to Page posts with the comment reply operation instead of publishing a post.",
      );

    if ((text?.length ?? 0) > maximumTextLength)
      issue("facebook.text", "Facebook post text exceeds 63,206 characters.");

    if (
      !text &&
      media.length === 0 &&
      target.content.link === undefined &&
      options.childAttachments === undefined
    )
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
      const problem = scheduleProblem(target.schedule.at, scheduleKind(format));

      if (problem !== undefined) issue("facebook.schedule_window", problem);
    }

    const videos = media.filter((item) => item.kind === "video");

    if (media.some((item) => item.kind === "document"))
      issue("facebook.document", "Facebook Page posts accept images and video only.");

    if (videos.length > 0 && media.length !== 1)
      issue("facebook.media_mix", "Publish one video, or one to ten images.");

    if (media.length > maximumPhotos)
      issue("facebook.media_count", "This adapter publishes at most ten photos per Page post.");

    if (reel && (videos.length !== 1 || media.length !== 1))
      issue("facebook.reel_media", "A Reel needs exactly one video.");

    for (const item of media) {
      if (item.source.kind === "https-url") {
        try {
          httpsUrl(item.source.url);
        } catch {
          issue("facebook.media_url", "Use public HTTPS media without local hosts or credentials.");
        }
      } else if (item.source.kind !== "blob")
        issue("facebook.media_source", "Facebook media must be a public HTTPS URL or a Blob.");

      if (item.source.kind === "blob" && !item.filename && !reel)
        issue("facebook.media_filename", "Uploaded bytes require a filename.");

      if (item.caption !== undefined)
        issue("facebook.media_caption", "Use content.text for the post text.");

      if (item.thumbnail !== undefined && (item.kind !== "video" || reel))
        issue("facebook.thumbnail", "Custom thumbnails apply to Page videos only.");

      if (item.thumbnail !== undefined && item.thumbnail.kind !== "blob")
        issue(
          "facebook.thumbnail_source",
          "Pass the Page video thumbnail as a Blob; it is sent as thumb.",
        );

      if (item.kind === "video" && item.altText !== undefined)
        issue("facebook.video_alt_text", "Facebook alt text applies to photos only.");
    }

    return issues;
  };

  const requireId = (value: string, name: string, operation: string): string => {
    if (!/^[\w.-]{1,128}$/.test(value)) fail(operation, `${name} must be a Facebook object ID.`);

    return value;
  };

  const crosspostVideo: FacebookNative["crosspostVideo"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.videos.crosspost";
    const videoId = requireId(input.videoId, "videoId", operation);

    if (input.scheduleAt !== undefined) scheduleIssue(input.scheduleAt, "video", operation);

    const result = writeObject(
      await videoRequest(`/${encodeURIComponent(pageId)}/videos`, input.context, {
        crossposted_video_id: videoId,
        ...definedFields({
          description: input.description,
          title: input.title,
          published: input.scheduleAt === undefined ? undefined : false,
          scheduled_publish_time:
            input.scheduleAt === undefined ? undefined : scheduleSeconds(input.scheduleAt),
        }),
      }),
      operation,
    );

    const id = writeId(result, "id", operation);

    return input.scheduleAt === undefined
      ? processing(input.account, 0, id, "VIDEO_SUBMITTED")
      : scheduled(input.account, 0, id);
  };

  const inviteReelCollaborator: FacebookNative["inviteReelCollaborator"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.reels.collaborators";
    const videoId = requireId(input.videoId, "videoId", operation);

    if (!numericId.test(input.collaboratorPageId))
      fail(operation, "collaboratorPageId must be a numeric Facebook Page ID.");

    const result = writeObject(
      await request(`/${encodeURIComponent(videoId)}/collaborators`, input.context, {
        target_id: input.collaboratorPageId,
      }),
      operation,
    );

    confirmSuccess(result, operation, "Facebook did not confirm the collaborator invitation.");

    return definedFields({
      collaboratorId: optionalString(result["collaborator_id"]),
      invitationLink: optionalString(result["invitation_link"]),
    });
  };

  const listReelCollaborators: FacebookNative["listReelCollaborators"] = async (input) => {
    authorize(input.account, input.context);
    const videoId = requireId(input.videoId, "videoId", "facebook.reels.collaborators");

    const result = object(
      await request(`/${encodeURIComponent(videoId)}/collaborators`, input.context),
    );

    const fields = ["id", "name", "invite_status"];

    // Meta's Reels guide shows one collaborator status object, not a `data` collection.
    // Source, accessed 2026-11-04:
    // https://developers.facebook.com/docs/video-api/guides/reels-publishing
    if (result["data"] === undefined && result["id"] !== undefined)
      return { items: [publicFields(result, fields)] };

    return graphPage(result, fields);
  };

  const getReelCopyrightCheck: FacebookNative["getReelCopyrightCheck"] = async (input) => {
    authorize(input.account, input.context);
    const videoId = requireId(input.videoId, "videoId", "facebook.reels.copyright");

    const result = object(
      await request(`/${encodeURIComponent(videoId)}`, input.context, undefined, {
        fields: "copyright_check_information",
      }),
    );

    const info = isJsonObject(result["copyright_check_information"])
      ? result["copyright_check_information"]
      : {};

    const status = isJsonObject(info["status"]) ? info["status"] : {};
    const matchesFound = status["matches_found"];

    return {
      status: optionalString(status["status"]) ?? "unknown",
      ...definedFields({ matchesFound: isBoolean(matchesFound) ? matchesFound : undefined }),
      matches: Array.isArray(info["copyright_matches"])
        ? info["copyright_matches"].filter(isJsonObject)
        : [],
    };
  };

  const pagePath = (edge: `/${string}`) => `/${encodeURIComponent(pageId)}${edge}`;

  /** One page of a Page edge with Graph cursors, keeping only the named scalar fields. */
  const listEdge = async (
    input: FacebookListInput,
    edge: `/${string}`,
    fields: readonly string[],
    operation: string,
    query: Readonly<Record<string, string>> = {},
  ): Promise<Page<JsonObject>> => {
    authorize(input.account, input.context);

    return graphPage(
      object(
        await request(pagePath(edge), input.context, undefined, {
          fields: fields.join(","),
          limit: String(pageLimit(input.limit, operation)),
          ...query,
          ...definedFields({ after: input.cursor }),
        }),
      ),
      fields,
    );
  };

  const publishPhotoStory: FacebookNative["publishPhotoStory"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.stories.publish";

    const photo: MediaAttachment =
      input.photo !== undefined
        ? {
            kind: "image",
            filename: "story",
            source: { kind: "blob", blob: input.photo, fingerprint: "story" },
          }
        : input.photoUrl !== undefined
          ? { kind: "image", source: { kind: "https-url", url: httpsUrl(input.photoUrl).href } }
          : fail(operation, "Pass a hosted photoUrl or the photo bytes.");

    // The Story photo is uploaded unpublished first, as the Page Stories guide requires.
    const uploaded = writeObject(
      await request(
        pagePath("/photos"),
        input.context,
        mediaBody(photo, "url", { published: false }),
      ),
      operation,
    );

    const photoId = writeId(uploaded, "id", operation);
    let result: JsonObject;

    try {
      result = writeObject(
        await request(pagePath("/photo_stories"), input.context, { photo_id: photoId }),
        operation,
      );
    } catch (error) {
      // A definite refusal made no Story, so the staged photo can go. An unclear answer keeps it.
      if (
        error instanceof SocialError &&
        error.code !== "timeout" &&
        error.code !== "ambiguous_outcome" &&
        error.code !== "cancelled"
      )
        await deleteObject(photoId, input.context, operation).catch(() => undefined);

      throw error;
    }

    confirmSuccess(result, operation, "Facebook did not confirm the photo Story.");

    return published(input.account, 0, writeId(result, "post_id", operation));
  };

  const publishVideoStory: FacebookNative["publishVideoStory"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.stories.publish";
    const upload = ruploadSource(input, operation);

    const started = writeObject(
      await request(pagePath("/video_stories"), input.context, { upload_phase: "start" }),
      operation,
    );

    const videoId = writeId(started, "video_id", operation);

    try {
      await sendToRupload(started, upload, input.context, "facebook.stories.upload");

      confirmSuccess(
        await request(pagePath("/video_stories"), input.context, {
          upload_phase: "finish",
          video_id: videoId,
          ...definedFields({ is_ai_generated: input.isAiGenerated }),
        }),
        operation,
        "Facebook did not confirm the video Story.",
      );
    } catch (error) {
      return uploadInterrupted(
        input.account,
        0,
        videoId,
        error instanceof SocialError ? error : undefined,
        "video Story upload",
      );
    }

    // Facebook still processes the video; posts.status reports when it is published.
    return processing(input.account, 0, videoId, "STORY_SUBMITTED");
  };

  const storyFields = ["post_id", "status", "creation_time", "media_type", "media_id", "url"];

  const listStories: FacebookNative["listStories"] = async (input) => {
    const bound = (value: string | undefined, name: string) => {
      if (value === undefined) return undefined;
      const time = Date.parse(value);

      if (!Number.isFinite(time)) fail("facebook.stories.read", `${name} must be an ISO time.`);

      return String(Math.floor(time / 1000));
    };

    return listEdge(
      input,
      "/stories",
      storyFields,
      "facebook.stories.read",
      definedFields({
        status: input.status,
        since: bound(input.since, "since"),
        until: bound(input.until, "until"),
      }),
    );
  };

  const createLiveStatuses = [
    "UNPUBLISHED",
    "LIVE_NOW",
    "SCHEDULED_UNPUBLISHED",
    "SCHEDULED_LIVE",
  ] as const;

  const updateLiveStatuses = [
    "LIVE_NOW",
    "SCHEDULED_UNPUBLISHED",
    "SCHEDULED_LIVE",
    "SCHEDULED_CANCELED",
  ] as const;

  const crosspostActions = [
    "enable_crossposting",
    "disable_crossposting",
    "enable_crossposting_and_create_post",
  ] as const;

  /** A planned broadcast start, sent as `event_params.start_time` in Unix seconds. */
  const liveStart = (at: string, operation: string) => {
    if (!(Date.parse(at) > clock().getTime()))
      fail(operation, "startAt must be a future ISO time.");

    return { start_time: Number(scheduleSeconds(at)) };
  };

  const liveTitle = (title: string | undefined, operation: string) => {
    if ((title?.length ?? 0) > 254)
      fail(operation, "Facebook live video titles are limited to 254 characters.");

    return title;
  };

  const createLiveVideo: FacebookNative["createLiveVideo"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.live.create";

    if (!oneOf(createLiveStatuses, input.status))
      fail(
        operation,
        "status must be UNPUBLISHED, LIVE_NOW, SCHEDULED_UNPUBLISHED, or SCHEDULED_LIVE.",
      );

    const scheduledStatus =
      input.status === "SCHEDULED_UNPUBLISHED" || input.status === "SCHEDULED_LIVE";

    if (scheduledStatus !== (input.startAt !== undefined))
      fail(
        operation,
        "Pass startAt exactly when the status is SCHEDULED_UNPUBLISHED or SCHEDULED_LIVE.",
      );

    if (input.contentTags?.some((tag) => !numericId.test(tag)))
      fail(operation, "contentTags must be numeric interest IDs.");

    if (
      input.crosspostingActions?.some(
        (entry) => !numericId.test(entry.pageId) || !oneOf(crosspostActions, entry.action),
      )
    )
      fail(
        operation,
        `crosspostingActions need a numeric pageId and one of ${crosspostActions.join(", ")}.`,
      );

    if (
      input.projection !== undefined &&
      !oneOf(["EQUIRECTANGULAR", "CUBEMAP", "HALF_EQUIRECTANGULAR"], input.projection)
    )
      fail(operation, "projection must be EQUIRECTANGULAR, CUBEMAP, or HALF_EQUIRECTANGULAR.");

    const result = writeObject(
      await request(pagePath("/live_videos"), input.context, {
        status: input.status,
        ...definedFields({
          title: liveTitle(input.title, operation),
          description: input.description,
          event_params:
            input.startAt === undefined ? undefined : liveStart(input.startAt, operation),
          enable_backup_ingest: input.enableBackupIngest,
          stop_on_delete_stream: input.stopOnDeleteStream,
          content_tags: input.contentTags === undefined ? undefined : [...input.contentTags],
          targeting: input.targeting === undefined ? undefined : targetingWire(input.targeting),
          crossposting_actions: input.crosspostingActions?.map((entry) => ({
            page_id: entry.pageId,
            action: entry.action,
          })),
          is_spherical: input.isSpherical,
          projection: input.projection,
        }),
      }),
      operation,
    );

    return {
      id: writeId(result, "id", operation),
      ...definedFields({ secureStreamUrl: optionalString(result["secure_stream_url"]) }),
    };
  };

  const updateLiveVideo: FacebookNative["updateLiveVideo"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.live.update";
    const id = requireId(input.liveVideoId, "liveVideoId", operation);

    if (input.status !== undefined && !oneOf(updateLiveStatuses, input.status))
      fail(
        operation,
        "status must be LIVE_NOW, SCHEDULED_UNPUBLISHED, SCHEDULED_LIVE, or SCHEDULED_CANCELED.",
      );

    const body = definedFields({
      status: input.status,
      event_params: input.startAt === undefined ? undefined : liveStart(input.startAt, operation),
      title: liveTitle(input.title, operation),
      description: input.description,
    });

    if (Object.keys(body).length === 0)
      fail(operation, "Pass a status, startAt, title, or description.");

    const result = writeObject(
      await request(`/${encodeURIComponent(id)}`, input.context, body),
      operation,
    );

    if (result["id"] !== id && result["success"] !== true)
      throw new SocialError({
        code: "ambiguous_outcome",
        operation,
        message: "Facebook did not confirm the live video update. Read it before retrying.",
        retryDisposition: { kind: "reconcile-first" },
      });
  };

  const liveFields = [
    "id",
    "title",
    "description",
    "status",
    "permalink_url",
    "creation_time",
    "planned_start_time",
    "broadcast_start_time",
  ];

  const getLiveVideo: FacebookNative["getLiveVideo"] = async (input) => {
    authorize(input.account, input.context);
    const id = requireId(input.liveVideoId, "liveVideoId", "facebook.live.read");

    const row = object(
      await request(`/${encodeURIComponent(id)}`, input.context, undefined, {
        fields: [...liveFields, "ingest_streams"].join(","),
      }),
    );

    // Ingest URLs embed the stream key, a credential; keep only the stream health data.
    const ingestStreams = (isJsonArray(row["ingest_streams"]) ? row["ingest_streams"] : [])
      .filter(isJsonObject)
      .map((stream) => ({
        ...publicFields(stream, ["id", "stream_id", "is_master"]),
        ...definedFields({ stream_health: optionalObject(stream["stream_health"]) }),
      }));

    return { ...publicFields(row, liveFields), ingest_streams: ingestStreams };
  };

  const pollActions = [
    "ATTACH_TO_VIDEO",
    "SHOW_VOTING",
    "SHOW_RESULTS",
    "CLOSE",
    "DELETE_POLL",
  ] as const;

  const createLivePoll: FacebookNative["createLivePoll"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.live.polls";
    const id = requireId(input.liveVideoId, "liveVideoId", operation);

    if (!input.question.trim()) fail(operation, "A poll needs a question.");

    if (input.options.length < 2 || input.options.some((option) => !option.trim()))
      fail(operation, "A poll needs at least two non-empty options.");

    if (
      input.correctOption !== undefined &&
      (!Number.isInteger(input.correctOption) ||
        input.correctOption < 1 ||
        input.correctOption > input.options.length)
    )
      fail(operation, "correctOption is the 1-based number of one of the options.");

    const result = writeObject(
      await request(`/${encodeURIComponent(id)}/polls`, input.context, {
        question: input.question,
        options: [...input.options],
        ...definedFields({ correct_option: input.correctOption, show_results: input.showResults }),
      }),
      operation,
    );

    return { id: writeId(result, "id", operation) };
  };

  const updateLivePoll: FacebookNative["updateLivePoll"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.live.polls";
    const id = requireId(input.pollId, "pollId", operation);

    if (!oneOf(pollActions, input.action))
      fail(operation, `action must be one of ${pollActions.join(", ")}.`);

    confirmSuccess(
      await request(`/${encodeURIComponent(id)}`, input.context, {
        action: input.action,
        ...definedFields({ show_results: input.showResults }),
      }),
      operation,
      "Facebook did not confirm the poll change.",
    );
  };

  const listVideoThumbnails: FacebookNative["listVideoThumbnails"] = async (input) => {
    authorize(input.account, input.context);
    const id = requireId(input.videoId, "videoId", "facebook.videos.thumbnails");

    return edgeRows(
      await request(`/${encodeURIComponent(id)}/thumbnails`, input.context, undefined, {
        fields: "id,uri,is_preferred,width,height,scale",
      }),
    ).map((row) => publicFields(row, ["id", "uri", "is_preferred", "width", "height", "scale"]));
  };

  const addVideoThumbnail: FacebookNative["addVideoThumbnail"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.videos.thumbnails";
    const id = requireId(input.videoId, "videoId", operation);

    if (input.image.size === 0 || input.image.size > 10 * 1024 * 1024)
      fail(operation, "A video thumbnail must be an image of at most 10 MB.");

    const form = new FormData();

    form.set("source", input.image, "thumbnail");

    if (input.isPreferred !== undefined) form.set("is_preferred", String(input.isPreferred));

    confirmSuccess(
      await request(`/${encodeURIComponent(id)}/thumbnails`, input.context, form),
      operation,
      "Facebook did not confirm the thumbnail upload.",
    );
  };

  const captionLocale = /^[a-z]{2}_[A-Z]{2}$/;

  const listVideoCaptions: FacebookNative["listVideoCaptions"] = async (input) => {
    authorize(input.account, input.context);
    const id = requireId(input.videoId, "videoId", "facebook.videos.captions");

    return edgeRows(await request(`/${encodeURIComponent(id)}/captions`, input.context)).map(
      (row) =>
        publicFields(row, ["locale_name", "is_default", "is_auto_generated", "create_time", "uri"]),
    );
  };

  const updateVideoCaptions: FacebookNative["updateVideoCaptions"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.videos.captions";
    const id = requireId(input.videoId, "videoId", operation);
    const form = new FormData();

    if (input.captions !== undefined) {
      if (!captionLocale.test(input.captions.locale))
        fail(operation, "Caption locales look like en_US.");

      if (input.captions.file.size === 0 || input.captions.file.size > 200 * 1024)
        fail(operation, "An SRT caption file must be at most 200 KB.");

      // Meta reads the locale from the file name, which must be `filename.locale.srt`.
      form.set("captions_file", input.captions.file, `captions.${input.captions.locale}.srt`);
    }

    if (input.defaultLocale !== undefined) {
      if (input.defaultLocale !== "none" && !captionLocale.test(input.defaultLocale))
        fail(operation, "defaultLocale is a locale such as en_US, or none.");

      form.set("default_locale", input.defaultLocale);
    }

    if (input.localesToDelete !== undefined) {
      if (input.localesToDelete.some((locale) => !captionLocale.test(locale)))
        fail(operation, "localesToDelete lists locales such as en_US.");

      form.set("locales_to_delete", JSON.stringify(input.localesToDelete));
    }

    if ([...form.keys()].length === 0)
      fail(operation, "Pass captions, defaultLocale, or localesToDelete.");

    confirmSuccess(
      await request(`/${encodeURIComponent(id)}/captions`, input.context, form),
      operation,
      "Facebook did not confirm the caption change.",
    );
  };

  const albumFields = [
    "id",
    "name",
    "description",
    "count",
    "created_time",
    "updated_time",
    "link",
    "can_upload",
  ];

  const getAlbum: FacebookNative["getAlbum"] = async (input) => {
    authorize(input.account, input.context);
    const id = requireId(input.albumId, "albumId", "facebook.albums.read");

    return publicFields(
      await request(`/${encodeURIComponent(id)}`, input.context, undefined, {
        fields: albumFields.join(","),
      }),
      albumFields,
    );
  };

  const listAlbumPhotos: FacebookNative["listAlbumPhotos"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.albums.read";
    const id = requireId(input.albumId, "albumId", operation);
    const fields = ["id", "name", "created_time", "link", "alt_text"];

    return graphPage(
      object(
        await request(`/${encodeURIComponent(id)}/photos`, input.context, undefined, {
          fields: fields.join(","),
          limit: String(pageLimit(input.limit, operation)),
          ...definedFields({ after: input.cursor }),
        }),
      ),
      fields,
    );
  };

  const endLiveVideo: FacebookNative["endLiveVideo"] = async (input) => {
    authorize(input.account, input.context);
    const id = requireId(input.liveVideoId, "liveVideoId", "facebook.live.end");

    const result = writeObject(
      await request(`/${encodeURIComponent(id)}`, input.context, { end_live_video: true }),
      "facebook.live.end",
    );

    if (result["id"] !== id && result["success"] !== true)
      throw new SocialError({
        code: "ambiguous_outcome",
        operation: "facebook.live.end",
        message: "Facebook did not confirm that the live video ended. Reconcile before retrying.",
        retryDisposition: { kind: "reconcile-first" },
      });
  };

  const updatePost: FacebookNative["updatePost"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.posts.update";
    const postId = requireId(input.postId, "postId", operation);

    if (
      input.message === undefined &&
      input.pinned === undefined &&
      input.hidden === undefined &&
      input.isAiGenerated === undefined
    )
      fail(operation, "Pass a message, pinned, hidden, or isAiGenerated change.");

    if (
      input.message !== undefined &&
      (!input.message.trim() || input.message.length > maximumTextLength)
    )
      fail(operation, "Facebook post text must be 1 to 63,206 characters.");

    confirmSuccess(
      await request(
        `/${encodeURIComponent(postId)}`,
        input.context,
        definedFields({
          message: input.message,
          is_pinned: input.pinned,
          is_hidden: input.hidden,
          is_ai_generated: input.isAiGenerated,
        }),
      ),
      operation,
      "Facebook did not confirm the post update. Read the post before retrying.",
    );
  };

  /** Rows keep scalar fields plus the string lists named in `lists`, such as role tasks. */
  const rowsWithLists = (
    result: JsonObject,
    fields: readonly string[],
    lists: readonly string[],
  ): Page<JsonObject> => ({
    items: array(result["data"]).map((entry) => {
      const row = object(entry);
      const listed: Record<string, JsonValue> = {};

      for (const name of lists)
        if (Array.isArray(row[name])) listed[name] = array(row[name]).filter(isString);

      return { ...publicFields(row, fields), ...listed };
    }),
    ...definedFields({ nextCursor: nextGraphCursor(result) }),
  });

  /** A Page website may use http or https, but never credentials. */
  const websiteUrl = (value: string, operation: string): string => {
    const url = URL.parse(value);

    if ((url?.protocol !== "https:" && url?.protocol !== "http:") || url.username || url.password)
      fail(operation, "website must be an http or https URL without credentials.");

    return url.href;
  };

  const updatePage: FacebookNative["updatePage"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.page.update";

    const body = definedFields({
      about: input.about,
      description: input.description,
      website: input.website === undefined ? undefined : websiteUrl(input.website, operation),
      phone: input.phone,
      emails: input.emails === undefined ? undefined : [...input.emails],
    });

    if (Object.keys(body).length === 0) fail(operation, "Pass at least one Page field to update.");

    if (input.emails?.some((email) => !/^[^\s@]+@[^\s@]+$/.test(email)))
      fail(operation, "emails must be email addresses.");

    confirmSuccess(
      await request(`/${encodeURIComponent(pageId)}`, input.context, body),
      operation,
      "Facebook did not confirm the Page update. Read the Page before retrying.",
    );
  };

  const updatePageSetting: FacebookNative["updatePageSetting"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.page.settings";

    if (!/^[A-Z][A-Z_]{1,63}$/.test(input.setting))
      fail(operation, "setting must be a Page setting name such as USERS_CAN_MESSAGE.");

    confirmSuccess(
      await request(pagePath("/settings"), input.context, {
        option: { [input.setting]: String(input.value) },
      }),
      operation,
      "Facebook did not confirm the Page setting change.",
    );
  };

  const respondToChangeProposal: FacebookNative["respondToChangeProposal"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.page.change_proposal";
    const proposalId = requireId(input.proposalId, "proposalId", operation);

    confirmSuccess(
      await request(`/${encodeURIComponent(proposalId)}`, input.context, { accept: input.accept }),
      operation,
      "Facebook did not confirm the proposal response.",
    );
  };

  const searchPages: FacebookNative["searchPages"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.pages.search";

    if (!input.query.trim()) fail(operation, "Pages Search needs a query.");

    const result = object(
      await request("/pages/search", input.context, undefined, {
        q: input.query,
        fields: "id,name,link,verification_status,location",
        limit: String(pageLimit(input.limit, operation)),
        ...definedFields({ after: input.cursor }),
      }),
    );

    return {
      items: array(result["data"]).map((entry) => {
        const row = object(entry);
        const location = row["location"];

        return {
          ...publicFields(row, ["id", "name", "link", "verification_status"]),
          ...definedFields({ location: isJsonObject(location) ? location : undefined }),
        };
      }),
      ...definedFields({ nextCursor: nextGraphCursor(result) }),
    };
  };

  const listComments: FacebookNative["listComments"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.comments.read";
    const objectId = requireId(input.objectId, "objectId", operation);

    const fields = [
      "id",
      "message",
      "created_time",
      "like_count",
      "comment_count",
      "parent",
      "is_hidden",
      "can_comment",
      ...(input.privateReplyFields === true ? ["can_reply_privately"] : []),
    ];

    if (
      input.order !== undefined &&
      !oneOf(["chronological", "reverse_chronological"], input.order)
    )
      fail(operation, "order must be chronological or reverse_chronological.");

    const result = object(
      await request(`/${encodeURIComponent(objectId)}/comments`, input.context, undefined, {
        fields: [
          ...fields,
          "from{id,name}",
          "attachment",
          "message_tags",
          ...(input.privateReplyFields === true ? ["private_reply_conversation"] : []),
        ].join(","),
        filter: input.filter ?? "toplevel",
        limit: String(pageLimit(input.limit, operation)),
        ...definedFields({
          order: input.order,
          summary: input.summary === true ? "true" : undefined,
          after: input.cursor,
        }),
      }),
    );

    const summary = isJsonObject(result["summary"]) ? result["summary"] : {};

    return {
      items: array(result["data"]).map((entry) => {
        const row = object(entry);
        const from = isJsonObject(row["from"]) ? row["from"] : undefined;

        const parent = isJsonObject(row["parent"])
          ? optionalString(row["parent"]["id"])
          : undefined;

        const attachment = optionalObject(row["attachment"]);
        const conversation = optionalObject(row["private_reply_conversation"]);

        // The commenter's Page-scoped ID and name are what a mention or private reply needs.
        return normalizeComment({
          ...publicFields(row, fields),
          ...definedFields({
            from: from === undefined ? undefined : publicFields(from, ["id", "name"]),
            parent_id: parent,
            attachment:
              attachment === undefined
                ? undefined
                : {
                    ...publicFields(attachment, ["type", "url", "title", "description"]),
                    ...definedFields({
                      media: optionalObject(attachment["media"]),
                      target: optionalObject(attachment["target"]),
                    }),
                  },
            message_tags: isJsonArray(row["message_tags"])
              ? row["message_tags"]
                  .filter(isJsonObject)
                  .map((tag) => publicFields(tag, ["id", "name", "type", "offset", "length"]))
              : undefined,
            private_reply_conversation_id: optionalString(conversation?.["id"]),
          }),
        });
      }),
      ...definedFields({
        nextCursor: nextGraphCursor(result),
        totalCount: optionalNumber(summary["total_count"]),
      }),
    };
  };

  /** One comment attachment at most; `attachment_share_url` is the GIF field. */
  const commentBody = (input: FacebookCommentBody, operation: string, requireContent: boolean) => {
    const attachments = [input.attachmentUrl, input.attachmentId, input.attachmentShareUrl].filter(
      (value) => value !== undefined,
    );

    if (attachments.length > 1) fail(operation, "Attach one image, photo ID, or GIF per comment.");

    if (requireContent && attachments.length === 0 && !input.message?.trim())
      fail(operation, "A Facebook comment needs a message or an attachment.");

    if (input.attachmentId !== undefined && !numericId.test(input.attachmentId))
      fail(operation, "attachmentId must be a numeric unpublished photo ID.");

    const body = definedFields({
      message: input.message,
      attachment_url:
        input.attachmentUrl === undefined ? undefined : httpsUrl(input.attachmentUrl).href,
      attachment_id: input.attachmentId,
      attachment_share_url:
        input.attachmentShareUrl === undefined
          ? undefined
          : httpsUrl(input.attachmentShareUrl).href,
    });

    if (Object.keys(body).length === 0) fail(operation, "Pass a message or an attachment.");

    return body;
  };

  const createComment: FacebookNative["createComment"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.comments.write";
    const objectId = requireId(input.objectId, "objectId", operation);

    const result = writeObject(
      await request(
        `/${encodeURIComponent(objectId)}/comments`,
        input.context,
        commentBody(input, operation, true),
      ),
      operation,
    );

    return { id: writeId(result, "id", operation) };
  };

  const editComment: FacebookNative["editComment"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.comments.edit";
    const commentId = requireId(input.commentId, "commentId", operation);

    confirmSuccess(
      await request(
        `/${encodeURIComponent(commentId)}`,
        input.context,
        commentBody(input, operation, false),
      ),
      operation,
      "Facebook did not confirm the comment edit. Read the comment before retrying.",
    );
  };

  const blockUser: FacebookNative["blockUser"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.page.block";

    if (!numericId.test(input.userId)) fail(operation, "userId must be a numeric Page-scoped ID.");

    // Meta answers with the blocked ID mapped to true.
    const result = writeObject(
      await request(pagePath("/blocked"), input.context, { user: input.userId }),
      operation,
    );

    if (!Object.values(result).includes(true))
      throw new SocialError({
        code: "ambiguous_outcome",
        operation,
        message: "Facebook did not confirm the block. Reconcile before retrying.",
        retryDisposition: { kind: "reconcile-first" },
      });
  };

  const listBlockedUsers: FacebookNative["listBlockedUsers"] = async (input) =>
    listEdge(input, "/blocked", ["id", "name"], "facebook.page.blocked");

  const unblockUser: FacebookNative["unblockUser"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.page.unblock";

    if (!numericId.test(input.userId)) fail(operation, "userId must be a numeric Page-scoped ID.");

    confirmSuccess(
      await request(
        pagePath("/blocked"),
        input.context,
        undefined,
        { user: input.userId },
        "DELETE",
      ),
      operation,
      "Facebook did not confirm the unblock. Read the blocked list before retrying.",
    );
  };

  const setLike: FacebookNative["setLike"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.engagement.like";
    const path = `/${encodeURIComponent(requireId(input.objectId, "objectId", operation))}/likes`;

    confirmSuccess(
      input.liked
        ? await request(path, input.context, {})
        : await request(path, input.context, undefined, {}, "DELETE"),
      operation,
      "Facebook did not confirm the like change.",
    );
  };

  const listSharedPosts: FacebookNative["listSharedPosts"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.posts.sharedposts";
    const postId = requireId(input.postId, "postId", operation);

    return graphPage(
      object(
        await request(`/${encodeURIComponent(postId)}/sharedposts`, input.context, undefined, {
          fields: otherPostFields.join(","),
          limit: String(pageLimit(input.limit, operation)),
          ...definedFields({ after: input.cursor }),
        }),
      ),
      otherPostFields,
    );
  };

  const listAssignedUsers: FacebookNative["listAssignedUsers"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.page.assigned_users";

    if (!numericId.test(input.businessId)) fail(operation, "businessId must be a numeric ID.");

    return rowsWithLists(
      object(
        await request(pagePath("/assigned_users"), input.context, undefined, {
          business: input.businessId,
          fields: "id,name,tasks,permitted_tasks",
          limit: String(pageLimit(input.limit, operation)),
          ...definedFields({ after: input.cursor }),
        }),
      ),
      ["id", "name"],
      ["tasks", "permitted_tasks"],
    );
  };

  const assignUser: FacebookNative["assignUser"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.page.assigned_users";

    if (!numericId.test(input.userId))
      fail(operation, "userId must be a business or system user ID.");

    if (input.tasks.length === 0 || input.tasks.some((task) => !/^[A-Z][A-Z_]{1,63}$/.test(task)))
      fail(operation, "tasks must be Page task names such as MANAGE or CREATE_CONTENT.");

    confirmSuccess(
      await request(pagePath("/assigned_users"), input.context, {
        user: input.userId,
        tasks: [...input.tasks],
      }),
      operation,
      "Facebook did not confirm the task assignment.",
    );
  };

  const unassignUser: FacebookNative["unassignUser"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.page.assigned_users";

    if (!numericId.test(input.userId))
      fail(operation, "userId must be a business or system user ID.");

    confirmSuccess(
      await request(
        pagePath("/assigned_users"),
        input.context,
        undefined,
        { user: input.userId },
        "DELETE",
      ),
      operation,
      "Facebook did not confirm the removal.",
    );
  };

  const locationFields = ["id", "name", "store_number", "link"];

  const addLocation: FacebookNative["addLocation"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.page.locations";

    if (!numericId.test(input.storeNumber)) fail(operation, "storeNumber must be numeric.");

    let body: JsonObject;

    if (input.newLocation === undefined) {
      if (input.locationPageId === undefined || !numericId.test(input.locationPageId))
        fail(operation, "locationPageId must be a numeric Page ID.");

      body = {
        main_page_id: pageId,
        store_number: input.storeNumber,
        location_page_id: input.locationPageId,
      };
    } else {
      const place = input.newLocation;
      const where = place.location;

      if (!where.street.trim()) fail(operation, "A new location needs a street.");

      if (where.cityId === undefined && (!where.city?.trim() || !where.country?.trim()))
        fail(operation, "A new location needs a city and country, or a cityId.");

      if (
        Math.abs(where.latitude) > 90 ||
        Math.abs(where.longitude) > 180 ||
        place.placeTopics.length === 0 ||
        !place.phone.trim()
      )
        fail(operation, "A new location needs coordinates, placeTopics, and a phone.");

      body = {
        main_page_id: pageId,
        store_number: input.storeNumber,
        location: definedFields({
          street: where.street,
          city: where.city,
          state: where.state,
          zip: where.zip,
          country: where.country,
          city_id: where.cityId,
          latitude: String(where.latitude),
          longitude: String(where.longitude),
        }),
        place_topics: [...place.placeTopics],
        phone: place.phone,
        ...definedFields({ hours: place.hours === undefined ? undefined : { ...place.hours } }),
      };
    }

    confirmSuccess(
      await request(pagePath("/locations"), input.context, body),
      operation,
      "Facebook did not confirm the location. List locations before retrying.",
    );
  };

  const removeLocation: FacebookNative["removeLocation"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.page.locations";

    if (!numericId.test(input.storeNumber) || !numericId.test(input.locationPageId))
      fail(operation, "storeNumber and locationPageId must be numeric.");

    confirmSuccess(
      await request(
        pagePath("/locations"),
        input.context,
        undefined,
        {
          main_page_id: pageId,
          store_number: input.storeNumber,
          location_page_id: input.locationPageId,
        },
        "DELETE",
      ),
      operation,
      "Facebook did not confirm the removal. List locations before retrying.",
    );
  };

  const setProfilePicture: FacebookNative["setProfilePicture"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.page.picture";

    const body =
      input.photoId === undefined
        ? input.pictureUrl === undefined
          ? fail(operation, "Pass a hosted pictureUrl or a Page photoId.")
          : { picture: httpsUrl(input.pictureUrl).href }
        : { photo: requireId(input.photoId, "photoId", operation) };

    confirmSuccess(
      await request(pagePath("/picture"), input.context, body),
      operation,
      "Facebook did not confirm the profile picture change.",
    );
  };

  const setCoverPhoto: FacebookNative["setCoverPhoto"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.page.cover";

    if (!numericId.test(input.photoId)) fail(operation, "photoId must be a numeric photo ID.");

    if (
      [input.offsetX, input.offsetY].some(
        (offset) =>
          offset !== undefined && (!Number.isFinite(offset) || offset < 0 || offset > 100),
      )
    )
      fail(operation, "Cover offsets are percentages from 0 through 100.");

    confirmSuccess(
      await request(`/${encodeURIComponent(pageId)}`, input.context, {
        cover: input.photoId,
        ...definedFields({
          offset_x: input.offsetX,
          offset_y: input.offsetY,
          no_feed_story: input.noFeedStory,
          no_notification: input.noNotification,
        }),
      }),
      operation,
      "Facebook did not confirm the cover photo change.",
    );
  };

  const unsubscribeApp: FacebookNative["unsubscribeApp"] = async (input) => {
    authorize(input.account, input.context);

    confirmSuccess(
      await request(pagePath("/subscribed_apps"), input.context, undefined, {}, "DELETE"),
      "facebook.webhooks.unsubscribe",
      "Facebook did not confirm the webhook unsubscription.",
    );
  };

  const getReactionCounts: FacebookNative["getReactionCounts"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.reactions.read";
    const objectId = requireId(input.objectId, "objectId", operation);
    const types = input.types ?? reactionTypes;

    if (types.length === 0 || types.some((type) => !oneOf(reactionTypes, type)))
      fail(operation, `Reaction types must be among ${reactionTypes.join(", ")}.`);

    // One reactions edge read per type with limit=0, so only its summary returns. Field aliases
    // (`.as()`) would fold these into one request, but Meta closed them to new apps on
    // 2026-11-04 and removes them in v28.0.
    const counts: Partial<Record<FacebookReactionType, number>> = {};

    for (const type of types) {
      const result = object(
        await request(`/${encodeURIComponent(objectId)}/reactions`, input.context, undefined, {
          type,
          limit: "0",
          summary: "total_count",
        }),
      );

      const summary = result["summary"];
      const total = isJsonObject(summary) ? optionalNumber(summary["total_count"]) : undefined;

      if (total !== undefined) counts[type] = total;
    }

    return counts;
  };

  const subscribeApp: FacebookNative["subscribeApp"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.webhooks.subscribe";

    if (input.fields.length === 0 || input.fields.some((field) => !/^[a-z_]{1,64}$/.test(field)))
      fail(operation, "Pass Page webhook field names such as feed and messages.");

    confirmSuccess(
      await request(pagePath("/subscribed_apps"), input.context, {
        subscribed_fields: input.fields.join(","),
      }),
      operation,
      "Facebook did not confirm the webhook subscription.",
    );
  };

  const sentMessage = (value: JsonField, operation: string): FacebookSentMessage => {
    const result = isJsonObject(value) ? value : undefined;
    const messageId = optionalString(result?.["message_id"]);

    if (result === undefined || messageId === undefined || messageId.length === 0)
      throw new SocialError({
        code: "ambiguous_outcome",
        operation,
        message: "Facebook returned no message ID. Reconcile before sending again.",
        retryDisposition: { kind: "reconcile-first" },
      });

    return {
      messageId,
      ...definedFields({
        recipientId: optionalString(result["recipient_id"]),
        attachmentId: optionalString(result["attachment_id"]),
      }),
    };
  };

  const quickReplyWire = (reply: FacebookQuickReply, operation: string): JsonObject => {
    if (reply.contentType !== "text") {
      if (reply.contentType !== "user_phone_number" && reply.contentType !== "user_email")
        fail(operation, "Quick reply contentType must be text, user_phone_number, or user_email.");

      return { content_type: reply.contentType };
    }

    if (!reply.title.trim() || [...reply.title].length > 20)
      fail(operation, "A text quick reply title must be 1 to 20 characters.");

    if (reply.payload.length > 1000)
      fail(operation, "A quick reply payload is limited to 1,000 characters.");

    return {
      content_type: "text",
      title: reply.title,
      payload: reply.payload,
      ...definedFields({
        image_url: reply.imageUrl === undefined ? undefined : httpsUrl(reply.imageUrl).href,
      }),
    };
  };

  const personaField = (personaId: string | undefined, operation: string) => {
    if (personaId !== undefined && !numericId.test(personaId))
      fail(operation, "personaId must be a numeric persona ID.");

    return definedFields({ persona_id: personaId });
  };

  const messagePayload = (input: FacebookMessageInput, operation: string): JsonObject => {
    const replies = input.quickReplies;

    if (replies !== undefined && (replies.length === 0 || replies.length > 13))
      fail(operation, "Send 1 to 13 quick replies.");

    if (input.metadata !== undefined && input.metadata.length > 1000)
      fail(operation, "Message metadata is limited to 1,000 characters.");

    const extras = definedFields({
      quick_replies: replies?.map((reply) => quickReplyWire(reply, operation)),
      metadata: input.metadata,
    });

    if (input.attachment === undefined) {
      if (!input.text?.trim()) fail(operation, "Messenger messages need text or an attachment.");

      return { text: input.text, ...extras };
    }

    const attachment = input.attachment;

    const payload =
      "attachmentId" in attachment
        ? { attachment_id: requireId(attachment.attachmentId, "attachmentId", operation) }
        : {
            url: httpsUrl(attachment.url).href,
            ...definedFields({ is_reusable: attachment.isReusable }),
          };

    return { attachment: { type: attachment.type, payload }, ...extras };
  };

  const notificationTypes = [
    "REGULAR",
    "SILENT_PUSH",
    "NO_PUSH",
  ] as const satisfies readonly FacebookNotificationType[];

  const recipientPsid = (value: string, operation: string): string => {
    if (!numericId.test(value))
      fail(operation, "recipientId must be the person's numeric Page-scoped ID.");

    return value;
  };

  /** Message IDs (`mid`) are opaque tokens such as `m_...`; allow only token characters. */
  const requireMessageId = (value: string, operation: string): string => {
    if (!/^[\w.:=+/-]{1,512}$/.test(value))
      fail(operation, "messageId must be a Messenger message ID (mid).");

    return value;
  };

  const sendMessage: FacebookNative["sendMessage"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messages.write";
    const recipientId = recipientPsid(input.recipientId, operation);

    if ((input.messagingType === "MESSAGE_TAG") !== (input.tag !== undefined))
      fail(operation, "Use tag HUMAN_AGENT exactly when messagingType is MESSAGE_TAG.");

    if (input.notificationType !== undefined && !oneOf(notificationTypes, input.notificationType))
      fail(operation, `notificationType must be one of ${notificationTypes.join(", ")}.`);

    const replyTo =
      input.replyToMessageId === undefined
        ? undefined
        : { mid: requireMessageId(input.replyToMessageId, operation) };

    return sentMessage(
      await request(pagePath("/messages"), input.context, {
        recipient: { id: recipientId },
        messaging_type: input.messagingType,
        ...definedFields({
          tag: input.tag,
          notification_type: input.notificationType,
          reply_to: replyTo,
        }),
        ...personaField(input.personaId, operation),
        message: messagePayload(input, operation),
      }),
      operation,
    );
  };

  const sendSenderAction: FacebookNative["sendSenderAction"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messages.sender_action";
    const recipient = { id: recipientPsid(input.recipientId, operation) };
    let body: JsonObject;

    if (input.action === "react" || input.action === "unreact") {
      const messageId = requireMessageId(input.messageId, operation);

      if (input.action === "react" && (!input.reaction.trim() || input.reaction.length > 32))
        fail(operation, "A reaction must be one emoji.");

      body = {
        recipient,
        sender_action: input.action,
        payload:
          input.action === "react"
            ? { message_id: messageId, reaction: input.reaction }
            : { message_id: messageId },
      };
    } else {
      if (!oneOf(["typing_on", "typing_off", "mark_seen"], input.action))
        fail(operation, "action must be typing_on, typing_off, mark_seen, react, or unreact.");

      // Sender actions carry only the recipient and the action; text goes in its own request.
      body = {
        recipient,
        sender_action: input.action,
        ...personaField(input.personaId, operation),
      };
    }

    const result = writeObject(
      await request(pagePath("/messages"), input.context, body),
      operation,
    );

    return definedFields({ recipientId: optionalString(result["recipient_id"]) });
  };

  const createPersona: FacebookNative["createPersona"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messages.personas";

    if (!input.name.trim() || [...input.name].length > 50)
      fail(operation, "A persona name must be 1 to 50 characters.");

    const result = writeObject(
      await request(pagePath("/personas"), input.context, {
        name: input.name,
        profile_picture_url: httpsUrl(input.profilePictureUrl).href,
      }),
      operation,
    );

    return { id: writeId(result, "id", operation) };
  };

  const listPersonas: FacebookNative["listPersonas"] = async (input) => {
    const rows = await listEdge(
      input,
      "/personas",
      ["id", "name", "profile_picture_url"],
      "facebook.messages.personas",
    );

    return {
      items: rows.items.map((row) => ({
        id: string(row["id"]),
        ...definedFields({
          name: optionalString(row["name"]),
          profilePictureUrl: optionalString(row["profile_picture_url"]),
        }),
      })),
      ...definedFields({ nextCursor: rows.nextCursor }),
    };
  };

  const deletePersona: FacebookNative["deletePersona"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messages.personas";

    if (!numericId.test(input.personaId)) fail(operation, "personaId must be a numeric ID.");

    await deleteObject(input.personaId, input.context, operation);
  };

  const attachmentTypes = ["image", "video", "audio", "file"] as const;

  const uploadMessageAttachment: FacebookNative["uploadMessageAttachment"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messages.attachment_upload";

    if (!oneOf(attachmentTypes, input.type))
      fail(operation, "type must be image, video, audio, or file.");

    let body: JsonObject | FormData;

    if (input.file === undefined) {
      if (input.url === undefined) fail(operation, "Pass a hosted url or the file bytes.");

      body = {
        message: {
          attachment: {
            type: input.type,
            payload: { url: httpsUrl(input.url).href, is_reusable: true },
          },
        },
      };
    } else {
      // A file upload sends the message object as JSON text beside the `filedata` part.
      body = new FormData();
      body.set(
        "message",
        JSON.stringify({ attachment: { type: input.type, payload: { is_reusable: true } } }),
      );
      body.set("filedata", input.file, "filedata");
    }

    const result = writeObject(
      await request(pagePath("/message_attachments"), input.context, body),
      operation,
    );

    return { attachmentId: writeId(result, "attachment_id", operation) };
  };

  const userProfileFields = [
    "first_name",
    "last_name",
    "name",
    "profile_pic",
    "locale",
    "timezone",
    "gender",
  ] as const satisfies readonly FacebookUserProfileField[];

  const getUserProfile: FacebookNative["getUserProfile"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messages.user_profile";
    const userId = recipientPsid(input.userId, operation);
    const fields = input.fields ?? ["first_name", "last_name", "profile_pic"];

    if (fields.length === 0 || fields.some((field) => !oneOf(userProfileFields, field)))
      fail(operation, `fields must be among ${userProfileFields.join(", ")}.`);

    return publicFields(
      await request(`/${encodeURIComponent(userId)}`, input.context, undefined, {
        fields: ["id", ...fields].join(","),
      }),
      ["id", ...fields],
    );
  };

  const privateReply: FacebookNative["privateReply"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messages.private_reply";
    const commentId = requireId(input.commentId, "commentId", operation);

    if (!input.text.trim()) fail(operation, "A private reply needs text.");

    // Private replies address the comment, not a Page-scoped ID; Meta allows one per comment.
    return sentMessage(
      await request(pagePath("/messages"), input.context, {
        recipient: { comment_id: commentId },
        message: { text: input.text },
      }),
      operation,
    );
  };

  const conversationFields = ["id", "updated_time", "message_count", "unread_count"];
  const messageFields = ["id", "message", "created_time"];

  /** Participants and senders keep only their Page-scoped ID and name; email is dropped. */
  const people = (value: JsonField): JsonValue[] => {
    const list = isJsonObject(value) ? value["data"] : value;

    return Array.isArray(list)
      ? list.filter(isJsonObject).map((person) => publicFields(person, ["id", "name"]))
      : [];
  };

  /** The conversation's messages are a field expansion, so a cursor is interpolated; allow only cursor characters. */
  const expansionCursor = (cursor: string): string => {
    if (!/^[A-Za-z0-9_\-=+/%.]{1,2048}$/.test(cursor))
      fail("facebook.messages.read", "The Messenger message cursor is malformed.");

    return cursor;
  };

  const conversationPage = async (
    account: ConnectedAccountRef,
    input: { readonly cursor?: string; readonly limit?: number },
    context: AdapterOperationContext,
    filters: Readonly<Record<string, string>> = {},
  ): Promise<Page<JsonObject>> => {
    authorize(account, context);

    const result = object(
      await request(pagePath("/conversations"), context, undefined, {
        platform: "messenger",
        fields: [...conversationFields, "participants"].join(","),
        limit: String(pageLimit(input.limit, "messages.read")),
        ...filters,
        ...definedFields({ after: input.cursor }),
      }),
    );

    return {
      items: array(result["data"]).map((entry) => {
        const row = object(entry);

        return normalizeConversation({
          ...publicFields(row, conversationFields),
          participants: people(row["participants"]),
        });
      }),
      ...definedFields({ nextCursor: nextGraphCursor(result) }),
    };
  };

  const messages = {
    async listConversations(
      account: ConnectedAccountRef,
      input: { readonly cursor?: string; readonly limit?: number },
      context: AdapterOperationContext,
    ): Promise<Page<JsonObject>> {
      return conversationPage(account, input, context);
    },
    async listMessages(
      conversation: ConversationRef,
      input: { readonly cursor?: string; readonly limit?: number },
      context: AdapterOperationContext,
    ): Promise<Page<JsonObject>> {
      authorize(conversation, context);
      const limit = pageLimit(input.limit, "messages.read");
      const after = input.cursor === undefined ? "" : `.after(${expansionCursor(input.cursor)})`;

      const result = object(
        await request(`/${encodeURIComponent(conversation.conversationId)}`, context, undefined, {
          fields: `messages.limit(${limit})${after}{${[...messageFields, "from", "to"].join(",")}}`,
        }),
      );

      const edge = result["messages"];

      if (!isJsonObject(edge))
        throw new SocialError({
          code: "upstream_failure",
          operation: "messages.read",
          message: "Facebook returned no messages for the conversation.",
        });

      return {
        items: array(edge["data"]).map((entry) => {
          const row = object(entry);
          const [from] = people(isJsonObject(row["from"]) ? [row["from"]] : []);

          return normalizeMessage({
            ...publicFields(row, messageFields),
            ...definedFields({ from }),
            to: people(row["to"]),
          });
        }),
        ...definedFields({ nextCursor: nextGraphCursor(edge) }),
      };
    },
    /**
     * Replies inside the 24-hour window (`messaging_type: "RESPONSE"`) to the conversation's
     * one other participant. Group or unidentifiable conversations are refused, not guessed.
     */
    async send(
      conversation: ConversationRef,
      content: { readonly text: string },
      context: AdapterOperationContext,
    ): Promise<JsonObject> {
      authorize(conversation, context);

      const result = object(
        await request(`/${encodeURIComponent(conversation.conversationId)}`, context, undefined, {
          fields: "participants",
        }),
      );

      const others = people(result["participants"])
        .filter(isJsonObject)
        .map((person) => optionalString(person["id"]))
        .filter((id): id is string => id !== undefined && id !== pageId);

      const [recipientId] = others;

      if (others.length !== 1 || recipientId === undefined)
        throw new SocialError({
          code: "invalid_input",
          operation: "messages.write",
          message:
            "The Messenger conversation must have exactly one participant besides the Page. Use native.sendMessage with a recipient ID.",
          retryDisposition: { kind: "never" },
        });

      const sent = await sendMessage({
        account: {
          kind: "connected-account",
          version: 1,
          backend: conversation.backend,
          platform: "facebook",
          accountId: conversation.accountId,
        },
        recipientId,
        messagingType: "RESPONSE",
        text: content.text,
        context,
      });

      return definedFields({ id: sent.messageId, recipientId: sent.recipientId });
    },
  };

  const conversationFolders = [
    "inbox",
    "other",
    "page_done",
    "spam",
  ] as const satisfies readonly FacebookConversationFolder[];

  const listConversations: FacebookNative["listConversations"] = async (input) => {
    const operation = "facebook.messages.conversations";

    if (input.folder !== undefined && !oneOf(conversationFolders, input.folder))
      fail(operation, `folder must be one of ${conversationFolders.join(", ")}.`);

    return conversationPage(
      input.account,
      input,
      input.context,
      definedFields({
        user_id: input.userId === undefined ? undefined : recipientPsid(input.userId, operation),
        folder: input.folder,
      }),
    );
  };

  const messageAttachment = (value: JsonValue): FacebookMessageAttachmentDetail => {
    const row = object(value);

    return definedFields({
      id: optionalString(row["id"]),
      name: optionalString(row["name"]),
      fileUrl: optionalString(row["file_url"]),
      imageData: optionalObject(row["image_data"]),
      videoData: optionalObject(row["video_data"]),
    });
  };

  /** Graph wraps lists as `{ data: [...] }`; a missing edge reads as empty. */
  const edgeRows = (value: JsonField): JsonObject[] => {
    const list = isJsonObject(value) ? value["data"] : value;

    return isJsonArray(list) ? list.filter(isJsonObject) : [];
  };

  const getMessage: FacebookNative["getMessage"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messages.read";
    const messageId = requireMessageId(input.messageId, operation);

    const row = object(
      await request(`/${encodeURIComponent(messageId)}`, input.context, undefined, {
        fields: [
          "id",
          "message",
          "created_time",
          "from",
          "to",
          "attachments{id,name,file_url,image_data,video_data}",
          "shares{id,name,description,type,url}",
          "story",
          "tags",
          "reactions",
          "is_unsupported",
        ].join(","),
      }),
    );

    const attachments = edgeRows(row["attachments"]).map(messageAttachment);

    const sticker = attachments.find(
      (attachment) => attachment.imageData?.["render_as_sticker"] === true,
    )?.imageData?.["url"];

    // Meta documents `story` as an array but shows a single `{ link, id }` object.
    const story = isJsonArray(row["story"])
      ? row["story"].find(isJsonObject)
      : optionalObject(row["story"]);

    const [from] = people(isJsonObject(row["from"]) ? [row["from"]] : []);

    return {
      id: string(row["id"]),
      ...definedFields({
        message: optionalString(row["message"]),
        createdTime: optionalString(row["created_time"]),
        from: isJsonObject(from) ? from : undefined,
        sticker: isString(sticker) ? sticker : undefined,
        story: story === undefined ? undefined : publicFields(story, ["id", "link"]),
        isUnsupported: optionalBoolean(row["is_unsupported"]),
      }),
      to: people(row["to"]).filter(isJsonObject),
      attachments,
      shares: edgeRows(row["shares"]).map((share) =>
        publicFields(share, ["id", "name", "description", "type", "url"]),
      ),
      tags: edgeRows(row["tags"])
        .map((tag) => optionalString(tag["name"]))
        .filter((name) => name !== undefined),
      reactions: edgeRows(row["reactions"]).flatMap((entry) => {
        const reaction = optionalString(entry["reaction"]);

        return reaction === undefined
          ? []
          : [
              {
                reaction,
                userIds: (isJsonArray(entry["users"]) ? entry["users"] : [])
                  .filter(isJsonObject)
                  .map((user) => optionalString(user["id"]))
                  .filter((id) => id !== undefined),
              },
            ];
      }),
    };
  };

  const profileFields = [
    "get_started",
    "greeting",
    "ice_breakers",
    "persistent_menu",
    "whitelisted_domains",
    "account_linking_url",
    "commands",
  ] as const satisfies readonly FacebookMessengerProfileField[];

  const requireProfileFields = (
    fields: readonly FacebookMessengerProfileField[],
    operation: string,
  ): string[] => {
    if (fields.length === 0 || fields.some((field) => !oneOf(profileFields, field)))
      fail(operation, `fields must be among ${profileFields.join(", ")}.`);

    return [...fields];
  };

  /** Messenger Profile writes answer `{ result: "success" }` rather than `{ success: true }`. */
  const confirmResult = (value: JsonField, operation: string, message: string): void => {
    if (!isJsonObject(value) || (value["result"] !== "success" && value["success"] !== true))
      throw new SocialError({
        code: "ambiguous_outcome",
        operation,
        message,
        retryDisposition: { kind: "reconcile-first" },
      });
  };

  const getMessengerProfile: FacebookNative["getMessengerProfile"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messenger_profile.read";
    const fields = requireProfileFields(input.fields, operation);

    const result = object(
      await request(pagePath("/messenger_profile"), input.context, undefined, {
        fields: fields.join(","),
      }),
    );

    const [row] = edgeRows(result);
    const profile: Record<string, JsonValue> = {};

    for (const field of fields) {
      const value = row?.[field];

      if (value !== undefined) profile[field] = value;
    }

    return profile;
  };

  const setMessengerProfile: FacebookNative["setMessengerProfile"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messenger_profile.write";

    if (input.greeting?.some((entry) => !entry.locale.trim() || [...entry.text].length > 160))
      fail(operation, "Each greeting needs a locale and at most 160 characters of text.");

    if ((input.iceBreakers?.length ?? 0) > 4)
      fail(operation, "Messenger shows at most 4 ice breakers per locale.");

    const body = definedFields({
      get_started:
        input.getStarted === undefined ? undefined : { payload: input.getStarted.payload },
      greeting: input.greeting?.map((entry) => ({ locale: entry.locale, text: entry.text })),
      ice_breakers: input.iceBreakers === undefined ? undefined : [...input.iceBreakers],
      persistent_menu: input.persistentMenu === undefined ? undefined : [...input.persistentMenu],
      whitelisted_domains: input.whitelistedDomains?.map((domain) => httpsUrl(domain).href),
      account_linking_url:
        input.accountLinkingUrl === undefined ? undefined : httpsUrl(input.accountLinkingUrl).href,
      commands: input.commands === undefined ? undefined : [...input.commands],
    });

    if (Object.keys(body).length === 0) fail(operation, "Pass at least one profile property.");

    confirmResult(
      await request(pagePath("/messenger_profile"), input.context, body),
      operation,
      "Facebook did not confirm the Messenger profile update.",
    );
  };

  const deleteMessengerProfileFields: FacebookNative["deleteMessengerProfileFields"] = async (
    input,
  ) => {
    authorize(input.account, input.context);
    const operation = "facebook.messenger_profile.delete";

    confirmResult(
      await request(
        pagePath("/messenger_profile"),
        input.context,
        { fields: requireProfileFields(input.fields, operation) },
        {},
        "DELETE",
      ),
      operation,
      "Facebook did not confirm the Messenger profile deletion.",
    );
  };

  const threadControl = async (
    edge: "/pass_thread_control" | "/request_thread_control" | "/release_thread_control",
    input: {
      readonly account: ConnectedAccountRef;
      readonly recipientId: string;
      readonly metadata?: string;
      readonly context: AdapterOperationContext;
    },
    extra: JsonObject = {},
  ): Promise<void> => {
    authorize(input.account, input.context);
    const operation = `facebook.handover${edge.replaceAll("/", ".")}`;

    if (input.metadata !== undefined && input.metadata.length > 1000)
      fail(operation, "Handover metadata is limited to 1,000 characters.");

    confirmSuccess(
      await request(pagePath(edge), input.context, {
        recipient: { id: recipientPsid(input.recipientId, operation) },
        ...extra,
        ...definedFields({ metadata: input.metadata }),
      }),
      operation,
      "Facebook did not confirm the thread control change. Read the thread owner before retrying.",
    );
  };

  const passThreadControl: FacebookNative["passThreadControl"] = async (input) => {
    if (!numericId.test(input.targetAppId))
      fail("facebook.handover.pass_thread_control", "targetAppId must be a numeric app ID.");

    await threadControl("/pass_thread_control", input, { target_app_id: input.targetAppId });
  };

  const getThreadOwner: FacebookNative["getThreadOwner"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.handover.thread_owner";

    const result = object(
      await request(pagePath("/thread_owner"), input.context, undefined, {
        recipient: recipientPsid(input.recipientId, operation),
      }),
    );

    const [row] = edgeRows(result);
    const owner = optionalObject(row?.["thread_owner"]);
    const appId = owner?.["app_id"];

    return definedFields({
      appId: isString(appId) ? appId : isFiniteNumber(appId) ? String(appId) : undefined,
    });
  };

  const requireLabelId = (value: string, operation: string): string => {
    if (!numericId.test(value)) fail(operation, "labelId must be a numeric custom label ID.");

    return value;
  };

  const createCustomLabel: FacebookNative["createCustomLabel"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messages.custom_labels";

    if (!input.name.trim()) fail(operation, "A custom label needs a name.");

    const result = writeObject(
      await request(pagePath("/custom_labels"), input.context, { page_label_name: input.name }),
      operation,
    );

    const id = result["id"];

    return { id: isFiniteNumber(id) ? String(id) : writeId(result, "id", operation) };
  };

  const listCustomLabels: FacebookNative["listCustomLabels"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messages.custom_labels";

    const owner =
      input.userId === undefined
        ? pagePath("/custom_labels")
        : `/${encodeURIComponent(recipientPsid(input.userId, operation))}/custom_labels`;

    const result = object(
      await request(owner, input.context, undefined, {
        fields: "page_label_name",
        limit: String(pageLimit(input.limit, operation)),
        ...definedFields({ after: input.cursor }),
      }),
    );

    return {
      items: edgeRows(result).map((row) => ({
        id: string(row["id"]),
        ...definedFields({ name: optionalString(row["page_label_name"]) }),
      })),
      ...definedFields({ nextCursor: nextGraphCursor(result) }),
    };
  };

  const setCustomLabel: FacebookNative["setCustomLabel"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messages.custom_labels";
    const labelId = requireLabelId(input.labelId, operation);
    const user = recipientPsid(input.userId, operation);
    const path = `/${encodeURIComponent(labelId)}/label`;

    confirmSuccess(
      input.assigned
        ? await request(path, input.context, { user })
        : await request(path, input.context, undefined, { user }, "DELETE"),
      operation,
      "Facebook did not confirm the label change. Read the person's labels before retrying.",
    );
  };

  const deleteCustomLabel: FacebookNative["deleteCustomLabel"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messages.custom_labels";

    await deleteObject(requireLabelId(input.labelId, operation), input.context, operation);
  };

  const templateName = /^[a-z0-9_]{1,512}$/;

  const createUtilityTemplate: FacebookNative["createUtilityTemplate"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messages.templates";

    if (!templateName.test(input.name))
      fail(operation, "Template names use lowercase letters, digits, and underscores.");

    if (!input.language.trim()) fail(operation, "A template needs a language code.");

    if (!input.components.some((component) => component["type"] === "BODY"))
      fail(operation, "A utility template needs a BODY component.");

    if (
      input.parameterFormat !== undefined &&
      input.parameterFormat !== "POSITIONAL" &&
      input.parameterFormat !== "NAMED"
    )
      fail(operation, "parameterFormat must be POSITIONAL or NAMED.");

    const result = writeObject(
      await request(pagePath("/message_templates"), input.context, {
        name: input.name,
        language: input.language,
        category: "UTILITY",
        components: [...input.components],
        ...definedFields({ parameter_format: input.parameterFormat }),
      }),
      operation,
    );

    return {
      id: writeId(result, "id", operation),
      ...definedFields({
        status: optionalString(result["status"]),
        category: optionalString(result["category"]),
      }),
    };
  };

  const templateFields = ["id", "name", "language", "status", "category"];

  const listMessageTemplates: FacebookNative["listMessageTemplates"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messages.templates";

    const result = object(
      await request(pagePath("/message_templates"), input.context, undefined, {
        limit: String(pageLimit(input.limit, operation)),
        ...definedFields({
          name: input.name,
          status: input.status?.join(","),
          language: input.language?.join(","),
          after: input.cursor,
        }),
      }),
    );

    return {
      items: edgeRows(result).map((row) => ({
        ...publicFields(row, templateFields),
        components: edgeRows(row["components"]),
      })),
      ...definedFields({ nextCursor: nextGraphCursor(result) }),
    };
  };

  const templateParameters = (
    values: readonly FacebookTemplateParameter[],
    operation: string,
  ): JsonObject[] =>
    values.map((value) => {
      if (!value.text.trim() || /[#$%]/.test(value.text))
        fail(operation, "Template parameters need text without #, $, or %.");

      return {
        type: "text",
        text: value.text,
        ...definedFields({ parameter_name: value.parameterName }),
      };
    });

  const sendUtilityTemplate: FacebookNative["sendUtilityTemplate"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messages.templates";

    if (!templateName.test(input.name))
      fail(operation, "Template names use lowercase letters, digits, and underscores.");

    const components = [
      ...(input.header === undefined
        ? []
        : [{ type: "header", parameters: templateParameters(input.header, operation) }]),
      ...(input.body === undefined
        ? []
        : [{ type: "body", parameters: templateParameters(input.body, operation) }]),
    ];

    return sentMessage(
      await request(pagePath("/messages"), input.context, {
        recipient: { id: recipientPsid(input.recipientId, operation) },
        messaging_type: "UTILITY",
        message: {
          template: {
            name: input.name,
            language: { code: input.language },
            ...definedFields({ components: components.length === 0 ? undefined : components }),
          },
        },
      }),
      operation,
    );
  };

  const getCallSettings: FacebookNative["getCallSettings"] = async (input) => {
    authorize(input.account, input.context);

    const result = object(
      await request(pagePath("/messenger_call_settings"), input.context, undefined, {
        fields: "call_hours,call_routing",
      }),
    );

    // Some Graph edges wrap one node in `data`; read either shape.
    const [row] = isJsonArray(result["data"]) ? edgeRows(result) : [result];

    return definedFields({
      call_hours: optionalObject(row?.["call_hours"]),
      call_routing: optionalObject(row?.["call_routing"]),
    });
  };

  const weekDays = [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ] as const;

  const callHoursWire = (hours: FacebookCallHours, operation: string): JsonObject => {
    const hhmm = /^([01]\d|2[0-3])[0-5]\d$/;
    const days = hours.weeklyOperatingHours.map((entry) => entry.dayOfWeek);

    if (!hours.timezoneId.trim()) fail(operation, "callHours needs a timezoneId.");

    if (new Set(days).size !== days.length || days.some((day) => !oneOf(weekDays, day)))
      fail(operation, "List each day of the week at most once.");

    if (
      hours.weeklyOperatingHours.some(
        (entry) =>
          !hhmm.test(entry.openTime) ||
          !hhmm.test(entry.closeTime) ||
          entry.closeTime <= entry.openTime,
      )
    )
      fail(operation, "Call hours use hhmm times with closeTime after openTime.");

    return {
      timezone_id: hours.timezoneId,
      weekly_operating_hours: hours.weeklyOperatingHours.map((entry) => ({
        day_of_week: entry.dayOfWeek,
        open_time: entry.openTime,
        close_time: entry.closeTime,
      })),
    };
  };

  const updateCallSettings: FacebookNative["updateCallSettings"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.messages.calling";

    if (input.ringTarget !== undefined && !oneOf(["META", "PARTNERS"], input.ringTarget))
      fail(operation, "ringTarget must be META or PARTNERS.");

    const body = definedFields({
      icon_enabled: input.iconEnabled,
      call_hours:
        input.callHours === undefined ? undefined : callHoursWire(input.callHours, operation),
      call_routing: input.ringTarget === undefined ? undefined : { ring_target: input.ringTarget },
    });

    if (Object.keys(body).length === 0) fail(operation, "Pass at least one call setting.");

    confirmResult(
      await request(pagePath("/messenger_call_settings"), input.context, body),
      operation,
      "Facebook did not confirm the call settings change.",
    );
  };

  const insightMetric = /^[a-z][a-z0-9_]{0,99}$/;

  const insightSeries = (value: JsonField): FacebookInsightSeries[] =>
    array(object(value)["data"]).map((entry) => {
      const series = object(entry);

      return {
        name: string(series["name"]),
        ...definedFields({
          period: optionalString(series["period"]),
          title: optionalString(series["title"]),
        }),
        values: array(series["values"]).map((point) => {
          const row = object(point);
          const metric = row["value"];

          return {
            value: metric === undefined ? null : metric,
            ...definedFields({ endTime: optionalString(row["end_time"]) }),
          };
        }),
      };
    });

  const insightQuery = (
    metrics: readonly string[],
    period: FacebookInsightPeriod | undefined,
    operation: string,
  ) => {
    if (metrics.length === 0 || metrics.some((metric) => !insightMetric.test(metric)))
      fail(operation, "Request one or more Insights metric names.");

    if (period !== undefined && !oneOf(insightPeriods, period))
      fail(operation, `period must be one of ${insightPeriods.join(", ")}.`);

    return { metric: metrics.join(","), ...definedFields({ period }) };
  };

  const getPostInsights: FacebookNative["getPostInsights"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.insights.post";
    const postId = requireId(input.postId, "postId", operation);

    return insightSeries(
      await request(
        `/${encodeURIComponent(postId)}/insights`,
        input.context,
        undefined,
        insightQuery(input.metrics, input.period, operation),
      ),
    );
  };

  const getVideoInsights: FacebookNative["getVideoInsights"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.insights.video";
    const videoId = requireId(input.videoId, "videoId", operation);

    const query: Record<string, string> =
      input.metrics === undefined
        ? insightQuery(facebookReelInsightMetrics, input.period ?? "lifetime", operation)
        : insightQuery(input.metrics, input.period, operation);

    for (const [name, value] of [
      ["since", input.since],
      ["until", input.until],
    ] as const) {
      if (value === undefined) continue;
      const time = Date.parse(value);

      if (!Number.isFinite(time)) fail(operation, `${name} must be an ISO time.`);

      query[name] = String(Math.floor(time / 1000));
    }

    return insightSeries(
      await request(
        `/${encodeURIComponent(videoId)}/video_insights`,
        input.context,
        undefined,
        query,
      ),
    );
  };

  const getPageInsights: FacebookNative["getPageInsights"] = async (input) => {
    authorize(input.account, input.context);
    const operation = "facebook.insights.page";
    const query: Record<string, string> = insightQuery(input.metrics, input.period, operation);

    if (input.datePreset !== undefined) {
      if (!oneOf(insightDatePresets, input.datePreset))
        fail(operation, `datePreset must be one of ${insightDatePresets.join(", ")}.`);

      query["date_preset"] = input.datePreset;
    }

    if (input.since !== undefined && input.until !== undefined) {
      const since = Date.parse(input.since);
      const until = Date.parse(input.until);

      if (
        !Number.isFinite(since) ||
        !Number.isFinite(until) ||
        until <= since ||
        until - since > 90 * dayMs
      )
        fail(operation, "since and until must be ISO times at most 90 days apart.");

      query["since"] = String(Math.floor(since / 1000));
      query["until"] = String(Math.floor(until / 1000));
    }

    return insightSeries(await request(pagePath("/insights"), input.context, undefined, query));
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

    if (ref.deliveryId.startsWith(photoDeliveryPrefix)) {
      const photo = object(
        await request(
          `/${encodeURIComponent(ref.deliveryId.slice(photoDeliveryPrefix.length))}`,
          context,
          undefined,
          { fields: "id" },
        ),
      );

      return published(account, 0, string(photo["id"]), "photo");
    }

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
      normalizeComment,
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
    "full_picture",
  ];

  // Posts by other people carry no is_published; scheduled ones add their publish time.
  const otherPostFields = [
    "id",
    "message",
    "created_time",
    "updated_time",
    "permalink_url",
    "full_picture",
  ];

  const scheduledPostFields = [...postFields, "scheduled_publish_time"];

  const videoFields = [
    "id",
    "description",
    "created_time",
    "updated_time",
    "permalink_url",
    "published",
  ];

  // A Photo node has `name` (its caption) and `link`, not the Page-post fields.
  // https://developers.facebook.com/docs/graph-api/reference/photo/ (checked 2026-11-04)
  const photoFields = ["id", "name", "created_time", "updated_time", "link"];

  const commentFields = ["id", "message", "created_time", "like_count", "comment_count"];
  const engagementScopes = ["pages_read_engagement", "pages_read_user_content"];
  const moderationScopes = ["pages_manage_engagement", "pages_read_user_content"];
  const publishScopes = ["pages_manage_posts", "pages_read_engagement", "pages_show_list"];
  const messagingScopes = ["pages_messaging", "pages_manage_metadata", "pages_read_engagement"];

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
            "Native scheduled_publish_time, at least 10 minutes ahead: feed and photo posts up to 30 days, Page videos up to 6 months, and Reels up to 29 days.",
        },
        {
          platform: "facebook",
          operation: "posts.cancelScheduled",
          availability: "available",
          requiredScopes: publishScopes,
          notes:
            "Reads the post or video first and deletes it only while it is unpublished with a future scheduled_publish_time. Due or published items are refused.",
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
          constraints: { mediaSources: ["https-url", "blob"] },
          notes:
            "9:16 video, 3 to 90 seconds, from a hosted URL or uploaded bytes, through the three-phase Page Reels API. Meta allows 30 API-published Reels per Page in a moving 24 hours window, and the adapter refuses a Reel past that count in one process.",
        },
        {
          platform: "facebook",
          operation: "posts.update",
          availability: "not-implemented-by-adapter",
          notes:
            "The normalized update is not implemented. native.updatePost edits a post's message (posts the app created) and pins or hides posts.",
        },
        {
          platform: "facebook",
          operation: "messages.read",
          availability: "available",
          requiredScopes: messagingScopes,
          notes:
            "Messenger conversations (platform=messenger) with participants, and message details, which Meta returns for the 20 most recent messages of a conversation.",
        },
        {
          platform: "facebook",
          operation: "messages.write",
          availability: "available",
          requiredScopes: messagingScopes,
          notes:
            "Replies with messaging_type RESPONSE inside the 24-hour window to the conversation's one other participant. native.sendMessage adds UPDATE, the HUMAN_AGENT tag, and attachments; native.privateReply answers a comment.",
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
        const objectType = ref.native?.["objectType"];

        const fields =
          objectType === "video" ? videoFields : objectType === "photo" ? photoFields : postFields;

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
        await requireFutureSchedule(ref.jobId, context);
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
          normalizeComment,
        );
      },
      async reply(
        ref: CommentRef,
        content: { readonly text: string },
        context: AdapterOperationContext,
      ): Promise<CommentRef> {
        authorize(ref, context);

        if (!content.text.trim()) fail("comments.write", "Facebook comment replies need text.");

        const result = writeObject(
          await request(`/${encodeURIComponent(ref.commentId)}/comments`, context, {
            message: content.text,
          }),
          "comments.write",
        );

        return { ...ref, commentId: writeId(result, "id", "comments.write") };
      },
    },
    messages,
    analytics: {
      async getPostMetrics(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        authorize(ref, context);

        // Videos and Photos have no `shares` field.
        const noShares =
          ref.native?.["objectType"] === "video" || ref.native?.["objectType"] === "photo";

        const result = object(
          await request(`/${encodeURIComponent(ref.postId)}`, context, undefined, {
            fields: [
              "reactions.summary(total_count).limit(0)",
              "comments.summary(total_count).limit(0)",
              ...(noShares ? [] : ["shares"]),
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

        const metrics = (
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

        return normalizeMetrics(metrics);
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

        const metrics = (["followers_count", "fan_count"] as const).flatMap((name) => {
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

        return normalizeMetrics(metrics);
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
      crosspostVideo,
      inviteReelCollaborator,
      listReelCollaborators,
      getReelCopyrightCheck,
      publishPhotoStory,
      publishVideoStory,
      listStories,
      createLiveVideo,
      updateLiveVideo,
      async listLiveVideos(input) {
        return listEdge(input, "/live_videos", liveFields, "facebook.live.read");
      },
      getLiveVideo,
      async deleteLiveVideo(input) {
        authorize(input.account, input.context);
        const operation = "facebook.live.delete";

        await deleteObject(
          requireId(input.liveVideoId, "liveVideoId", operation),
          input.context,
          operation,
        );
      },
      createLivePoll,
      updateLivePoll,
      listVideoThumbnails,
      addVideoThumbnail,
      listVideoCaptions,
      updateVideoCaptions,
      getVideoInsights,
      async listAlbums(input) {
        return listEdge(input, "/albums", albumFields, "facebook.albums.read");
      },
      getAlbum,
      listAlbumPhotos,
      endLiveVideo,
      async listScheduledPosts(input) {
        return listEdge(input, "/scheduled_posts", scheduledPostFields, "facebook.posts.scheduled");
      },
      updatePost,
      async listReels(input) {
        return listEdge(input, "/video_reels", videoFields, "facebook.reels.read");
      },
      async listTaggedPosts(input) {
        return listEdge(input, "/tagged", otherPostFields, "facebook.posts.tagged");
      },
      async listVisitorPosts(input) {
        return listEdge(input, "/visitor_posts", otherPostFields, "facebook.posts.visitor");
      },
      updatePage,
      async listPageSettings(input) {
        authorize(input.account, input.context);

        return graphPage(object(await request(pagePath("/settings"), input.context)), [
          "setting",
          "value",
        ]);
      },
      updatePageSetting,
      async listPageRoles(input) {
        authorize(input.account, input.context);

        return rowsWithLists(
          object(
            await request(pagePath("/roles"), input.context, undefined, {
              fields: "id,name,tasks",
              limit: String(pageLimit(input.limit, "facebook.page.roles")),
              ...definedFields({ after: input.cursor }),
            }),
          ),
          ["id", "name"],
          ["tasks"],
        );
      },
      respondToChangeProposal,
      async listRatings(input) {
        return listEdge(
          input,
          "/ratings",
          ["created_time", "recommendation_type", "review_text", "has_rating", "has_review"],
          "facebook.page.ratings",
        );
      },
      searchPages,
      listComments,
      createComment,
      editComment,
      blockUser,
      listBlockedUsers,
      unblockUser,
      setLike,
      listSharedPosts,
      listAssignedUsers,
      assignUser,
      unassignUser,
      async listLocations(input) {
        return listEdge(input, "/locations", locationFields, "facebook.page.locations");
      },
      addLocation,
      removeLocation,
      async listVideoLists(input) {
        return listEdge(
          input,
          "/video_lists",
          ["id", "title", "description", "creation_time", "last_modified", "season_number"],
          "facebook.videos.lists",
        );
      },
      setProfilePicture,
      setCoverPhoto,
      unsubscribeApp,
      getReactionCounts,
      subscribeApp,
      sendMessage,
      sendSenderAction,
      createPersona,
      listPersonas,
      deletePersona,
      uploadMessageAttachment,
      getUserProfile,
      listConversations,
      getMessage,
      getMessengerProfile,
      setMessengerProfile,
      deleteMessengerProfileFields,
      passThreadControl,
      async requestThreadControl(input) {
        await threadControl("/request_thread_control", input);
      },
      async releaseThreadControl(input) {
        await threadControl("/release_thread_control", input);
      },
      getThreadOwner,
      createCustomLabel,
      listCustomLabels,
      setCustomLabel,
      deleteCustomLabel,
      createUtilityTemplate,
      listMessageTemplates,
      sendUtilityTemplate,
      getCallSettings,
      updateCallSettings,
      privateReply,
      getPostInsights,
      getPageInsights,
      async listSubscribedApps(input) {
        authorize(input.account, input.context);

        return rowsWithLists(
          object(await request(pagePath("/subscribed_apps"), input.context)),
          ["id", "name"],
          ["subscribed_fields"],
        );
      },
      async listPhotos(input) {
        return listEdge(
          input,
          "/photos",
          ["id", "name", "created_time", "link", "alt_text"],
          "facebook.photos.read",
          {
            type: "uploaded",
          },
        );
      },
    },
  });
}
