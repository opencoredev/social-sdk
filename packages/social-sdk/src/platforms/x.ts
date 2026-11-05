import { remainingBudget } from "../transport/budget.js";
import { definedFields } from "../core/fields.js";
import { isValidXText } from "./x-text.js";
import { defineAdapter } from "../core/adapter.js";
import { connectedAccountRef, profileRef } from "../core/types.js";
import { SocialError } from "../core/errors.js";
import type {
  AdapterOperationContext,
  CommentRef,
  ConnectedAccountRef,
  ConversationRef,
  DeliveryOutcome,
  JsonObject,
  JsonValue,
  MediaAttachment,
  MetricValue,
  Page,
  PlatformPostRef,
  PreparedPublishTarget,
  ProfileRecord,
  ProfileRef,
  RelationshipRecord,
  SearchPostsInput,
} from "../core/types.js";
import { managedHttp, optionsObject, publicFields } from "../cloud/common.js";
import { verifyXWebhook } from "../server/webhooks.js";
import { directWebhooks, webhookCapability } from "./webhook-adapter.js";
import { providerErrorDecoder } from "../transport/provider-errors.js";
import {
  normalizeComment,
  normalizeConversation,
  normalizeMessage,
  normalizeMetrics,
} from "../core/projections.js";
import { readBinary } from "../transport/binary.js";
import { createHttp, HttpError } from "../transport/http.js";
import { isJsonValue, parseJson } from "../transport/json.js";
import {
  activityStreamUrl,
  complianceStreamUrl,
  parseRulesUpdate,
  parseStreamRule,
  readDataStream,
  readFilteredStream,
  volumeStreamUrl,
  type StreamTarget,
  type XComplianceStream,
  type XDataStreamEvent,
  type XDataStreamOptions,
  type XVolumeStream,
  validateRuleIds,
  validateRuleInput,
  type XStreamEvent,
  type XStreamOptions,
  type XStreamRule,
  type XStreamRuleInput,
  type XStreamRulesUpdate,
} from "./x-stream.js";
import {
  array,
  isBoolean,
  isFiniteNumber,
  isJsonArray,
  isString,
  isJsonObject,
  object,
  optionalBoolean,
  optionalNumber,
  optionalString,
  string,
  type JsonField,
} from "../transport/validation.js";

// 53-bit conversation ID hashes, 11 base36 characters each. listConversations returns at
// most 1,200 distinct conversations, which keeps its cursor well under the client's 16,384
// character cursor limit.

interface XRecentSearchQuery extends Record<string, string> {
  query: string;
  "tweet.fields": string;
  next_token?: string;
  max_results?: string;
}

const conversationHashWidth = 11;

const maxConversationHashes = 1200;

const replyFields = [
  "id",
  "text",
  "author_id",
  "created_at",
  "conversation_id",
  "in_reply_to_user_id",
  "referenced_tweets",
  "public_metrics",
] as const;

const xIdPattern = /^[0-9]{1,19}$/;

const xNoteTags: ReadonlySet<string> = new Set([
  "disputed_claim_as_fact",
  "factual_error",
  "manipulated_media",
  "misinterpreted_satire",
  "missing_important_context",
  "other",
  "outdated_information",
]);

const xDmEventTypes: ReadonlySet<string> = new Set([
  "MessageCreate",
  "ParticipantsJoin",
  "ParticipantsLeave",
]);

const xVideoMimeTypes: ReadonlySet<string> = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

const xStaticImageMimeTypes: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const xReplySettings: ReadonlySet<string> = new Set([
  "everyone",
  "following",
  "mentionedUsers",
  "subscribers",
  "verified",
]);

const xPublishOptionKeys: ReadonlySet<string> = new Set([
  "replySettings",
  "longform",
  "quotedPostId",
  "excludeReplyUserIds",
  "autoPopulateReplyMetadata",
  "communityId",
  "shareWithFollowers",
  "paidPartnership",
  "madeWithAi",
  "forSuperFollowersOnly",
  "placeId",
  "directMessageDeepLink",
  "cardUri",
  "mediaTitle",
  "mediaDescription",
  "previewMediaId",
  "embeddable",
  "taggedUserIds",
  "callToActions",
]);

interface XPublishFields {
  /** Top-level `POST /2/tweets` fields. */
  readonly body: JsonObject;
  /** Fields merged into the `media` object next to `media_ids`. */
  readonly media: JsonObject;
  readonly excludeReplyUserIds?: readonly string[];
  readonly autoPopulateReplyMetadata?: boolean;
  readonly longform: boolean;
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}

function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);

    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Decodes the untyped per-target options into `POST /2/tweets` fields. Field names follow
 * https://docs.x.com/x-api/posts/create-or-edit-post and OpenAPI 2.173 (checked 2026-11-04).
 */
function parseXPublishOptions(
  settings: JsonObject,
  post: { readonly hasMedia: boolean; readonly isReply: boolean },
): XPublishFields {
  const issues: { code: string; message: string }[] = [];

  const fail = (code: string, message: string) => issues.push({ code, message });

  const body: Record<string, JsonValue> = {};

  const media: Record<string, JsonValue> = {};

  for (const key of Object.keys(settings))
    if (!xPublishOptionKeys.has(key)) fail("x.options", `X has no publish option named ${key}.`);

  const flag = (key: string, wire: string, into: Record<string, JsonValue>) => {
    const value = settings[key];

    if (value === undefined) return;

    if (!isBoolean(value)) fail("x.options", `${key} must be a boolean.`);
    else into[wire] = value;
  };

  const id = (key: string, wire: string, into: Record<string, JsonValue>) => {
    const value = settings[key];

    if (value === undefined) return;

    if (!isString(value) || !xIdPattern.test(value))
      fail("x.options", `${key} must be a numeric X ID of 1 to 19 digits.`);
    else into[wire] = value;
  };

  const ids = (key: string, max: number): readonly string[] | undefined => {
    const value = settings[key];

    if (value === undefined) return undefined;

    if (
      !isJsonArray(value) ||
      value.length < 1 ||
      value.length > max ||
      !value.every((entry) => isString(entry) && xIdPattern.test(entry))
    ) {
      fail("x.options", `${key} must list 1 to ${max} numeric X user IDs.`);

      return undefined;
    }

    return value.filter(isString);
  };

  const text = (key: string, wire: string, into: Record<string, JsonValue>) => {
    const value = settings[key];

    if (value === undefined) return;

    if (!isString(value) || !value.trim()) fail("x.options", `${key} must be non-empty text.`);
    else into[wire] = value;
  };

  const replySettings = settings["replySettings"];

  if (replySettings !== undefined) {
    if (!isString(replySettings) || !xReplySettings.has(replySettings))
      fail(
        "x.options",
        "replySettings must be everyone, following, mentionedUsers, subscribers, or verified.",
      );
    else if (replySettings !== "everyone") body["reply_settings"] = replySettings;
  }

  const longform = settings["longform"];

  if (longform !== undefined && !isBoolean(longform))
    fail("x.options", "longform must be a boolean.");

  id("quotedPostId", "quote_tweet_id", body);
  id("communityId", "community_id", body);
  flag("shareWithFollowers", "share_with_followers", body);

  flag("paidPartnership", "paid_partnership", body);
  flag("madeWithAi", "made_with_ai", body);
  flag("forSuperFollowersOnly", "for_super_followers_only", body);

  const placeId = settings["placeId"];

  if (placeId !== undefined) {
    if (!isString(placeId) || !/^[A-Za-z0-9]{1,64}$/.test(placeId))
      fail("x.options", "placeId must be an alphanumeric X place ID.");
    else body["geo"] = { place_id: placeId };
  }

  const deepLink = settings["directMessageDeepLink"];

  if (deepLink !== undefined) {
    if (!isString(deepLink) || !isHttpsUrl(deepLink))
      fail("x.options", "directMessageDeepLink must be an HTTPS URL.");
    else body["direct_message_deep_link"] = deepLink;
  }

  text("cardUri", "card_uri", body);
  text("mediaTitle", "title", media);
  text("mediaDescription", "description", media);
  id("previewMediaId", "preview_media_id", media);
  flag("embeddable", "embeddable", media);

  const tagged = ids("taggedUserIds", 10);

  if (tagged !== undefined) media["tagged_user_ids"] = [...tagged];

  const actions = settings["callToActions"];

  if (actions !== undefined) {
    const decoded = isJsonObject(actions) ? parseCallToActions(actions) : undefined;

    if (decoded === undefined)
      fail(
        "x.options",
        "callToActions takes visitSite or watchNow with an HTTPS url, or appInstall with store IDs.",
      );
    else media["call_to_actions"] = decoded;
  }

  if (Object.keys(media).length > 0 && !post.hasMedia)
    fail("x.media_options", "X media card options require an attached media item.");

  const excludeReplyUserIds = ids("excludeReplyUserIds", 100);

  if (excludeReplyUserIds !== undefined && !post.isReply)
    fail("x.options", "excludeReplyUserIds applies only to a reply; set replyTo.");

  const autoPopulate = settings["autoPopulateReplyMetadata"];

  if (autoPopulate !== undefined && !isBoolean(autoPopulate))
    fail("x.options", "autoPopulateReplyMetadata must be a boolean.");
  else if (autoPopulate !== undefined && !post.isReply)
    fail("x.options", "autoPopulateReplyMetadata applies only to a reply; set replyTo.");

  return {
    body,
    media,
    longform: longform === true,
    issues,
    ...definedFields({
      excludeReplyUserIds,
      autoPopulateReplyMetadata: isBoolean(autoPopulate) ? autoPopulate : undefined,
    }),
  };
}

function parseCallToActions(value: JsonObject): JsonObject | undefined {
  const result: Record<string, JsonValue> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (!isJsonObject(entry)) return undefined;

    if (key === "visitSite" || key === "watchNow") {
      const url = entry["url"];

      if (Object.keys(entry).some((name) => name !== "url") || !isString(url) || !isHttpsUrl(url))
        return undefined;
      result[key === "visitSite" ? "visit_site" : "watch_now"] = { url };
    } else if (key === "appInstall") {
      const install: Record<string, JsonValue> = {};

      for (const [name, wire] of [
        ["appStoreId", "app_store_id"],
        ["ipadAppStoreId", "ipad_app_store_id"],
        ["playStoreId", "play_store_id"],
      ] as const) {
        const storeId = entry[name];

        if (storeId === undefined) continue;

        if (!isString(storeId) || !storeId.trim()) return undefined;
        install[wire] = storeId;
      }

      if (
        Object.keys(install).length === 0 ||
        Object.keys(entry).length !== Object.keys(install).length
      )
        return undefined;
      result["app_install"] = install;
    } else return undefined;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

// Refused DM writes keep HTTP 403 and name the cause in the problem type (X changelog,
// Oct 26, 2026; OpenAPI 2.173 lists 43 `dm-` problem types). Only the type is kept: `detail`
// can describe the recipient.
const xDmProblemPrefix = "https://api.x.com/2/problems/dm-";

function xDmRefusal(body: JsonValue): XDmRefusal | undefined {
  if (!isJsonObject(body)) return undefined;

  const type = body["type"];

  if (!isString(type) || !type.startsWith(xDmProblemPrefix)) return undefined;

  const cause = type.slice(xDmProblemPrefix.length);

  return /^[a-z]+(?:-[a-z]+)*$/.test(cause) ? `dm-${cause}` : undefined;
}

function xDmRefusalCode(
  refusal: XDmRefusal,
): "invalid_input" | "not_found" | "rate_limited" | "missing_permission" {
  if (refusal === "dm-rate-limited") return "rate_limited";

  if (refusal.endsWith("-not-found")) return "not_found";

  if (
    /^dm-(bad-|text-|too-)/.test(refusal) ||
    refusal === "dm-conversation-name-too-long" ||
    refusal === "dm-unsupported-message" ||
    refusal === "dm-duplicate"
  )
    return "invalid_input";

  return "missing_permission";
}

function conversationHash(id: string): string {
  let h1 = 0xdeadbeef;

  let h2 = 0x41c6ce57;

  for (let index = 0; index < id.length; index++) {
    const code = id.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);

  return value.toString(36).padStart(conversationHashWidth, "0");
}

export interface XAuthorization {
  readonly userId: string;
  readonly accessToken?: string;
  readonly handle?: string;
}

export { xLike, xUnlike, type XEngagementOptions, type XEngagementResult } from "./x-engagement.js";

export {
  xStreamDefaultStallTimeoutMs,
  type XComplianceStream,
  type XDataStreamEvent,
  type XDataStreamOptions,
  type XLikeExpansion,
  type XVolumeStream,
  type XMatchingRule,
  type XStreamEvent,
  type XStreamOptions,
  type XStreamRule,
  type XStreamRuleInput,
  type XStreamRulesUpdate,
} from "./x-stream.js";

export interface XOptions {
  readonly auth: XAuthorization;
  /** App-only bearer for the filtered stream and fallback public reads/search. */
  readonly appBearerToken?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
  /**
   * OAuth 2.0 client secret (or legacy OAuth 1.0 consumer secret) that X uses to sign
   * webhook deliveries and CRC responses.
   */
  readonly webhookSecret?: string;
}

/**
 * Post field selectors sent as `tweet.fields`, following the X data dictionary
 * (https://docs.x.com/x-api/fundamentals/data-dictionary, checked 2026-11-04). OpenAPI 2.173
 * renames the parameter to `post.fields` and `note_tweet` to `note_post`; both names are accepted.
 * `non_public_metrics`, `organic_metrics`, and `promoted_metrics` need the author's user token
 * and cover Posts from the last 30 days.
 */
export type XTweetField =
  | "article"
  | "attachments"
  | "author_id"
  | "card_uri"
  | "community_id"
  | "context_annotations"
  | "conversation_id"
  | "created_at"
  | "display_text_range"
  | "edit_controls"
  | "edit_history_tweet_ids"
  | "entities"
  | "geo"
  | "id"
  | "in_reply_to_user_id"
  | "lang"
  | "media_metadata"
  | "non_public_metrics"
  | "note_post"
  | "note_tweet"
  | "organic_metrics"
  | "paid_partnership"
  | "possibly_sensitive"
  | "promoted_metrics"
  | "public_metrics"
  | "referenced_tweets"
  | "reply_settings"
  | "scopes"
  | "source"
  | "text"
  | "withheld";

export type XTweetExpansion =
  | "attachments.media_keys"
  | "attachments.poll_ids"
  | "author_id"
  | "entities.mentions.username"
  | "geo.place_id"
  | "in_reply_to_user_id"
  | "referenced_tweets.id";

export type XUserField =
  | "affiliation"
  | "created_at"
  | "description"
  | "entities"
  | "id"
  | "location"
  | "name"
  | "pinned_tweet_id"
  | "profile_image_url"
  | "protected"
  | "public_metrics"
  | "subscription_type"
  | "url"
  | "username"
  | "verified"
  | "verified_type";

export type XMediaField =
  | "alt_text"
  | "duration_ms"
  | "height"
  | "media_key"
  | "non_public_metrics"
  | "organic_metrics"
  | "preview_image_url"
  | "public_metrics"
  | "type"
  | "url"
  | "variants"
  | "width";

export interface XSearchInput extends SearchPostsInput {
  readonly sortOrder?: "recency" | "relevancy";
  readonly tweetFields?: readonly XTweetField[];
  readonly expansions?: readonly XTweetExpansion[];
  readonly userFields?: readonly XUserField[];
  readonly mediaFields?: readonly XMediaField[];
}

export interface XUploadedMedia {
  readonly mediaId: string;
}

/** Selectors from X OpenAPI 2.172 SpaceFieldsParameter. */
export type XSpaceField =
  | "created_at"
  | "ended_at"
  | "id"
  | "is_ticketed"
  | "lang"
  | "participant_count"
  | "scheduled_start"
  | "started_at"
  | "state"
  | "subscriber_count"
  | "title"
  | "updated_at";

/** Selectors from X OpenAPI 2.172 SpaceExpansionsParameter. */
export type XSpaceExpansion =
  | "creator_id"
  | "host_ids"
  | "invited_user_ids"
  | "speaker_ids"
  | "topic_ids";

export interface XSpacesLookupInput {
  readonly spaceFields?: readonly XSpaceField[];
  readonly expansions?: readonly XSpaceExpansion[];
  readonly userFields?: readonly XUserField[];
}

export interface XSpacesSearchInput extends XSpacesLookupInput {
  readonly query: string;
  readonly state?: "live" | "scheduled";
  readonly limit?: number;
}

/** A confirmed X post edit. X assigns every edited version a new post ID. */
export interface XUpdatedPost {
  /** Reference to the new version created by the edit. */
  readonly post: PlatformPostRef;
  /** The post ID that was passed as `previous_post_id`. */
  readonly previousPostId: string;
  readonly text: string;
  /** Oldest-first edit chain, when X returns it. The first entry is the original post ID. */
  readonly editHistoryPostIds?: readonly string[];
}

/** Field selectors for native Post reads. Omitted selectors use the adapter's defaults. */
export interface XPostFieldSelection {
  readonly tweetFields?: readonly XTweetField[];
  readonly expansions?: readonly XTweetExpansion[];
  readonly userFields?: readonly XUserField[];
  readonly mediaFields?: readonly XMediaField[];
}

/** Selectors from X OpenAPI 2.173 for `community.fields`. */
export type XCommunityField =
  | "access"
  | "created_at"
  | "description"
  | "id"
  | "join_policy"
  | "member_count"
  | "name";

export interface XPostCountsInput {
  /** Search query in the same syntax as recent and full-archive search, 1-4096 characters. */
  readonly query: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly sinceId?: string;
  readonly untilId?: string;
  /** Bucket size. X defaults to `hour`. */
  readonly granularity?: "minute" | "hour" | "day";
  readonly cursor?: string;
}

/** One time bucket of a Post counts response. */
export interface XPostCountBucket {
  readonly start: string;
  readonly end: string;
  readonly count: number;
}

export interface XPostCounts {
  readonly buckets: readonly XPostCountBucket[];
  /** Sum across this page's buckets, as X reports it. */
  readonly totalCount?: number;
  readonly nextCursor?: string;
}

export interface XTrend {
  readonly name: string;
  readonly postCount?: number;
}

export interface XPersonalizedTrend {
  readonly name: string;
  readonly category?: string;
  /** X returns a display string, such as "12.5K posts". */
  readonly postCount?: string;
  readonly trendingSince?: string;
}

/** USD balances from `GET /2/usage/credits`. */
export interface XCreditBalance {
  readonly totalBalance: number;
  readonly prepaidBalance: number;
  readonly freeBalance: number;
  readonly freeGrants: readonly { readonly amount: number; readonly expiresAt?: string }[];
}

export type XUsageField =
  | "cap_reset_day"
  | "daily_client_app_usage"
  | "daily_project_usage"
  | "project_cap"
  | "project_id"
  | "project_usage";

export interface XBookmarkFolder {
  readonly id: string;
  readonly name: string;
}

/**
 * X Direct Message refusal problem types, such as `dm-recipient-not-accepting`, from
 * `https://api.x.com/2/problems/dm-...` (X changelog, Oct 26, 2026). A refused DM write keeps
 * HTTP 403 and carries the type as `SocialError.upstreamCode`.
 */
export type XDmRefusal = `dm-${string}`;

/** Engagement metric selectors for `GET /2/tweets/analytics` (OpenAPI 2.173). */
export type XPostAnalyticsField =
  | "app_install_attempts"
  | "app_opens"
  | "bookmarks"
  | "detail_expands"
  | "email_tweet"
  | "engagements"
  | "follows"
  | "hashtag_clicks"
  | "id"
  | "impressions"
  | "likes"
  | "media_views"
  | "permalink_clicks"
  | "quote_tweets"
  | "replies"
  | "retweets"
  | "shares"
  | "timestamp"
  | "timestamped_metrics"
  | "unfollows"
  | "unlikes"
  | "url_clicks"
  | "user_profile_clicks";

/** Video metric selectors for `GET /2/media/analytics` (OpenAPI 2.173). */
export type XMediaAnalyticsField =
  | "cta_url_clicks"
  | "cta_watch_clicks"
  | "media_key"
  | "play_from_tap"
  | "playback25"
  | "playback50"
  | "playback75"
  | "playback_complete"
  | "playback_start"
  | "timestamp"
  | "timestamped_metrics"
  | "video_views"
  | "watch_time_ms";

/** Owner-only metrics of one Post from `non_public_metrics` and `organic_metrics`. */
export interface XPrivatePostMetrics {
  readonly postId: string;
  readonly nonPublic: Readonly<Record<string, number>>;
  readonly organic: Readonly<Record<string, number>>;
}

export interface XDownloadedMedia {
  readonly bytes: Uint8Array;
  /** The response `Content-Type`, when X sends one. */
  readonly contentType?: string;
}

/** X Activity API event types accepted by `POST /2/activity/subscriptions` (OpenAPI 2.173). */
export type XActivityEventType =
  | "block.block"
  | "block.unblock"
  | "broadcast.chat"
  | "broadcast.chat.remove"
  | "broadcast.end"
  | "broadcast.start"
  | "chat.conversation.admin_added"
  | "chat.conversation.admin_removed"
  | "chat.conversation.join"
  | "chat.conversation.member_added"
  | "chat.conversation.member_removed"
  | "chat.received"
  | "chat.sent"
  | "chat.update.group_name"
  | "chat.update.restrictions"
  | "dm.indicate_typing"
  | "dm.read"
  | "dm.received"
  | "dm.sent"
  | "follow.follow"
  | "follow.unfollow"
  | "like.create"
  | "mute.mute"
  | "mute.unmute"
  | "news.new"
  | "post.create"
  | "post.delete"
  | "post.mention.create"
  | "post.quote.create"
  | "post.reply.create"
  | "post.repost.create"
  | "profile.update.affiliate_badge"
  | "profile.update.banner_picture"
  | "profile.update.bio"
  | "profile.update.geo"
  | "profile.update.handle"
  | "profile.update.profile_picture"
  | "profile.update.screenname"
  | "profile.update.url"
  | "profile.update.verified_badge"
  | "spaces.end"
  | "spaces.start"
  | "subscriptions.subscribe"
  | "subscriptions.unsubscribe";

export interface XActivityFilter {
  /** The user the subscription follows. For `mute.*` and `block.*`, the authenticated user. */
  readonly userId?: string;
  /** Keyword filter, used by `news.new`. */
  readonly keyword?: string;
  readonly direction?: "inbound" | "outbound";
  /** Up to 8 event-specific predicates, such as `post_id` or `conversation_type`. */
  readonly qualifiers?: Readonly<Record<string, string>>;
}

/** Streaming endpoints the Connections API reports and terminates. */
export type XStreamEndpoint =
  | "filtered_stream"
  | "sample_stream"
  | "sample10_stream"
  | "firehose_stream"
  | "tweets_compliance_stream"
  | "users_compliance_stream"
  | "tweet_label_stream"
  | "firehose_stream_lang_en"
  | "firehose_stream_lang_ja"
  | "firehose_stream_lang_ko"
  | "firehose_stream_lang_pt"
  | "likes_firehose_stream"
  | "likes_sample10_stream"
  | "likes_compliance_stream";

/** Which streaming connections to close with the Connections API. */
export type XConnectionTarget =
  | { readonly kind: "uuids"; readonly uuids: readonly string[] }
  | { readonly kind: "endpoint"; readonly endpoint: XStreamEndpoint }
  | { readonly kind: "all" };

export interface XConnectionTermination {
  readonly successful: number;
  readonly failed: number;
  readonly results: readonly { readonly uuid: string; readonly success: boolean }[];
}

export interface XStreamRuleCounts {
  readonly projectRulesCount: number;
  readonly clientAppRulesCount: number;
  readonly capPerProject: number;
  readonly capPerClientApp: number;
}

export interface XWebhookConfig {
  readonly id: string;
  readonly url: string;
  readonly valid: boolean;
  readonly createdAt?: string;
}

/** DraftJS block types the Articles API accepts. `atomic` holds one embed entity. */
export type XArticleBlockType =
  | "unstyled"
  | "header-one"
  | "header-two"
  | "header-three"
  | "unordered-list-item"
  | "ordered-list-item"
  | "blockquote"
  | "atomic";

/** One DraftJS text block. Offsets and lengths count UTF-16 code units of `text`. */
export interface XArticleBlock {
  readonly text: string;
  readonly type: XArticleBlockType;
  readonly key?: string;
  readonly inlineStyles?: readonly {
    readonly offset: number;
    readonly length: number;
    readonly style: "bold" | "italic" | "strikethrough";
  }[];
  /** `entity` is the index into the draft's `entities`. */
  readonly entityRanges?: readonly {
    readonly entity: number;
    readonly offset: number;
    readonly length: number;
  }[];
}

/** A non-text Article entity. The adapter sets X's recommended mutability for each kind. */
export type XArticleEntity =
  | { readonly kind: "link"; readonly url: string }
  | { readonly kind: "post"; readonly postId: string }
  | {
      readonly kind: "image";
      readonly media: readonly { readonly mediaId: string; readonly mediaCategory: string }[];
      readonly caption?: string;
    }
  | { readonly kind: "markdown"; readonly markdown: string }
  | { readonly kind: "divider" }
  | { readonly kind: "latex" };

/** An X Chat message body: plaintext, or an encrypted event built by X's Chat XDK. */
export type XChatMessage =
  | { readonly kind: "text"; readonly text: string }
  /** Adds (or, with `remove: true`, removes) an emoji reaction on a message event. */
  | {
      readonly kind: "reaction";
      readonly eventId: string;
      readonly emoji: string;
      readonly remove?: boolean;
    }
  | {
      readonly kind: "encrypted";
      readonly encodedMessageCreateEvent: string;
      readonly encodedMessageEventSignature?: string;
      readonly xdkVersion?: string;
    };

/** A signature object produced by X's Chat XDK for one action (`action_signatures` item). */
export type XChatActionSignature = JsonObject;

/** One participant's conversation key, encrypted by the Chat XDK with their public key. */
export interface XChatParticipantKey {
  readonly userId: string;
  readonly encryptedConversationKey: string;
  readonly publicKeyVersion: string;
}

/** Encrypted group fields for `POST /2/chat/conversations/group`, built with the Chat XDK. */
export interface XChatGroupInput {
  /** The ID from `initializeChatGroup`. */
  readonly conversationId: string;
  readonly conversationKeyVersion: string;
  readonly participantKeys: readonly XChatParticipantKey[];
  readonly memberIds: readonly string[];
  /** Defaults to the creator when omitted. */
  readonly adminIds?: readonly string[];
  readonly name?: string;
  readonly description?: string;
  readonly avatarUrl?: string;
  /** Disappearing-message timer in milliseconds (`ttl_msec`). */
  readonly messageTtlMs?: number;
  readonly keyRotation?: string;
  readonly actionSignatures?: readonly XChatActionSignature[];
}

/** An encrypted group edit for `PUT /2/chat/conversations/{id}`. */
export interface XChatGroupUpdate {
  readonly modifiedFields: readonly ("group_name" | "group_avatar_url" | "group_description")[];
  readonly conversationKeyVersion: string;
  readonly name?: string;
  readonly description?: string;
  readonly avatarUrl?: string;
  readonly participantKeys?: readonly XChatParticipantKey[];
  readonly keyRotation?: string;
  /** `rotated_pmk_bundle` entries from the Chat XDK, forwarded unchanged. */
  readonly rotatedMessageKeys?: readonly JsonObject[];
  readonly actionSignatures?: readonly XChatActionSignature[];
}

/** Admin-only group actions (`PUT /2/chat/conversations/{id}/admin_settings`); true restricts. */
export interface XChatAdminSettings {
  readonly addMember?: boolean;
  readonly blockScreenCapture?: boolean;
  readonly editGroupInfo?: boolean;
  readonly editMessageTtl?: boolean;
  readonly sendMessage?: boolean;
  readonly startCall?: boolean;
}

/** Invite link options for `POST /2/chat/conversations/{id}/invite`. */
export interface XChatInviteInput {
  /** `https://x.com/i/chat/group_join/<conversation_id>/<10-character token>`. */
  readonly inviteUrl?: string;
  readonly validForMs?: number;
  readonly expiresAt?: string;
  readonly welcomeMessage?: string;
  readonly title?: string;
  readonly avatarUrl?: string;
  readonly affiliateUserId?: string;
  readonly actionSignatures?: readonly XChatActionSignature[];
}

/** Chat inbox settings (`PUT /2/chat/settings`). */
export interface XChatSettings {
  readonly allowMessagesFrom?: "all" | "verified" | "following";
  readonly alwaysAllowSubscribers?: boolean;
  readonly qualityFilter?: "enabled" | "disabled";
  readonly readReceipts?: "all_enabled" | "all_disabled";
  /** `av_settings`, forwarded unchanged. */
  readonly callSettings?: JsonObject;
}

export interface XScheduledBroadcastInput {
  /** The stream source's `id` (its stream key) from `streamSources` or `createStreamSource`. */
  readonly sourceId: string;
  readonly startAt: string;
  readonly endAt?: string;
  readonly title?: string;
  readonly description?: string;
  readonly locale?: string;
  /** If true, X waits for `goLive` instead of publishing at the start time. */
  readonly manualPublish?: boolean;
  readonly availableForReplay?: boolean;
  /** 0 default, 1 chat off, 2 everyone, 3 verified, 4 accounts the host follows, 5 subscribers, 6 followed by followed. */
  readonly chatOption?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** `is_locked`: lock the broadcast. */
  readonly isLocked?: boolean;
  /** Uploaded image shown before the broadcast starts (`thumbnail_media_id`). */
  readonly thumbnailMediaId?: string;
  /** Create only: repeat the broadcast `repeats` times, daily or weekly (`recurrence`). */
  readonly recurrence?: { readonly frequency: "Daily" | "Weekly"; readonly repeats: number };
}

/** Event types accepted by the `event_types` filter on X Direct Message event reads. */
export type XDmEventType = "MessageCreate" | "ParticipantsJoin" | "ParticipantsLeave";

/** Result of one `POST /2/users/{id}/bookmarks` call with `tweet_ids`. */
export interface XBookmarkResult {
  /** Post IDs X reported as bookmarked, in request order. */
  readonly bookmarked: readonly string[];
  /** Per-ID failures X returned with HTTP 200; the other IDs are still bookmarked. */
  readonly errors: readonly JsonObject[];
}

/**
 * Metadata for `POST /2/media/metadata` (OpenAPI 2.173). Each field maps to one `metadata` entry.
 * X types `sensitive_media_warning`, `geo_restrictions` and `audience_policy` as open objects
 * without listing their fields, so those are forwarded unchanged.
 */
export interface XMediaMetadata {
  /** `alt_text.text`, up to 1,000 characters. */
  readonly altText?: string;
  /** `allow_download_status.allow_download`. */
  readonly allowDownload?: boolean;
  /** ISO 8601 time sent as `content_expiration.timestamp_sec` (Unix seconds). */
  readonly contentExpiresAt?: string;
  /** Domains sent as `domain_restrictions.whitelist`. */
  readonly domainAllowlist?: readonly string[];
  /** `found_media_origin` with the origin `provider` and its `id`. */
  readonly foundMediaOrigin?: { readonly provider: string; readonly id: string };
  /** `management_info.managed`. */
  readonly managed?: boolean;
  /** `shared_info.shared`. */
  readonly shared?: boolean;
  /** `upload_source.upload_source`. */
  readonly uploadSource?: string;
  /** `sensitive_media_warning`, forwarded as given. */
  readonly sensitiveMediaWarning?: JsonObject;
  /** `geo_restrictions`, forwarded as given. */
  readonly geoRestrictions?: JsonObject;
  /** `audience_policy`, forwarded as given. */
  readonly audiencePolicy?: JsonObject;
}

/** A batch compliance job as X returns it (`compliance_job` object). */
export interface XComplianceJob {
  readonly id: string;
  readonly type: "tweets" | "users";
  readonly status: string;
  readonly name?: string;
  readonly resumable?: boolean;
  readonly createdAt?: string;
  /** Signed URL for the ID upload. Treat it as a secret. */
  readonly uploadUrl?: string;
  readonly uploadExpiresAt?: string;
  /** Signed URL for the results. Treat it as a secret. */
  readonly downloadUrl?: string;
  readonly downloadExpiresAt?: string;
}

/** Community Note classification (`info.classification`). */
export type XCommunityNoteClassification =
  | "misinformed_or_potentially_misleading"
  | "not_misleading";

/** Reasons a Post may be misleading (`info.misleading_tags`). */
export type XCommunityNoteTag =
  | "disputed_claim_as_fact"
  | "factual_error"
  | "manipulated_media"
  | "misinterpreted_satire"
  | "missing_important_context"
  | "other"
  | "outdated_information";

export interface XCommunityNoteInput {
  readonly postId: string;
  /** Note text; X requires at least one URL in it. */
  readonly text: string;
  readonly classification: XCommunityNoteClassification;
  readonly misleadingTags: readonly XCommunityNoteTag[];
  readonly trustworthySources: boolean;
  readonly isMediaNote?: boolean;
  /** `test_mode`: when true the note is not publicly visible. */
  readonly testMode: boolean;
}

export type XNewsField =
  | "category"
  | "cluster_posts_results"
  | "contexts"
  | "disclaimer"
  | "hook"
  | "id"
  | "keywords"
  | "name"
  | "summary"
  | "updated_at";

/** A scheduled X call (`POST /2/calls/scheduled`). Times are RFC 3339. */
export interface XScheduledCallInput {
  readonly startTime: string;
  readonly title?: string;
  readonly description?: string;
  /** 1-44,640 minutes; X defaults to 30. */
  readonly durationMinutes?: number;
  /** Up to 25 invitees on create. */
  readonly inviteeIds?: readonly string[];
  readonly notifyInvitees?: boolean;
  /** RFC 5545 RRULE such as `FREQ=WEEKLY;BYDAY=MO`. */
  readonly recurrence?: string;
  /** IANA time zone the recurrence follows. */
  readonly timeZone?: string;
}

/** Which occurrences of a recurring call a change applies to. */
export interface XCallOccurrence {
  readonly scope?: "all" | "this" | "this_and_following";
  readonly occurrenceStartTime?: string;
}

/** A bot account with its freshly minted bearer token. Keep `token` server-side. */
export interface XBotWithToken {
  readonly id: string;
  readonly username?: string;
  readonly token: string;
  readonly tokenExpiresAtMs?: string;
  readonly scopes?: readonly string[];
}

export interface XNative {
  readonly searchRecentPosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly search: Omit<XSearchInput, "scope">;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly searchAllPosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly search: Omit<XSearchInput, "scope">;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly readPost: (
    ref: PlatformPostRef,
    context: AdapterOperationContext,
  ) => Promise<JsonObject>;
  readonly repost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly quote: (input: {
    readonly account: ConnectedAccountRef;
    readonly text: string;
    readonly quotedPostId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly deletePost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /**
   * Edits the text of a recent post with `POST /2/tweets` and `edit_options.previous_post_id`.
   * X decides eligibility (X Premium, own post, edit window, edit count) and returns a new post ID.
   * Sources, accessed 2026-09-24: https://docs.x.com/x-api/posts/create-post,
   * https://docs.x.com/x-api/fundamentals/edit-posts, https://docs.x.com/changelog (2025-10-03).
   */
  readonly updatePost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly text: string;
    readonly context: AdapterOperationContext;
  }) => Promise<XUpdatedPost>;
  /**
   * Uploads one video Blob (up to 16 GiB) and waits for processing. Returns an attachable media ID.
   * `mimeType` defaults to `video/mp4`; X also accepts `video/quicktime` and `video/webm`.
   */
  readonly uploadVideo: (input: {
    readonly account: ConnectedAccountRef;
    readonly video: Blob;
    readonly mimeType?: "video/mp4" | "video/quicktime" | "video/webm";
    /** User IDs that may also attach this media (`additional_owners`). */
    readonly additionalOwners?: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<XUploadedMedia>;
  /** Uploads one GIF Blob (up to 15 MiB) and waits for processing. Returns an attachable media ID. */
  readonly uploadGif: (input: {
    readonly account: ConnectedAccountRef;
    readonly gif: Blob;
    /** User IDs that may also attach this media (`additional_owners`). */
    readonly additionalOwners?: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<XUploadedMedia>;
  readonly createPoll: (input: {
    readonly account: ConnectedAccountRef;
    readonly text: string;
    readonly options: readonly string[];
    readonly durationMinutes: number;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** One page of bookmarks. Pass `meta.next_token` from the response back as `cursor`. */
  readonly bookmarks: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    /** 1 through 100. */
    readonly maxResults?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly bookmark: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Bookmarks 1-25 posts in one request (`tweet_ids`), optionally into a folder (`folder_id`). */
  readonly bookmarkPosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly postIds: readonly string[];
    readonly folderId?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<XBookmarkResult>;
  /** Attaches metadata to uploaded media with `POST /2/media/metadata`; returns X's `associated_metadata`. */
  readonly setMediaMetadata: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly metadata: XMediaMetadata;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Creates a batch compliance job (`POST /2/compliance/jobs`). Needs `appBearerToken`. */
  readonly createComplianceJob: (input: {
    readonly account: ConnectedAccountRef;
    readonly type: "tweets" | "users";
    readonly name?: string;
    readonly resumable?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<XComplianceJob>;
  /** Lists the app's compliance jobs of one type (`GET /2/compliance/jobs`). */
  readonly complianceJobs: (input: {
    readonly account: ConnectedAccountRef;
    readonly type: "tweets" | "users";
    readonly status?: "created" | "in_progress" | "failed" | "complete";
    readonly context: AdapterOperationContext;
  }) => Promise<readonly XComplianceJob[]>;
  readonly getComplianceJob: (input: {
    readonly account: ConnectedAccountRef;
    readonly jobId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<XComplianceJob>;
  /** Uploads Post or user IDs, one per line, to the job's signed `uploadUrl` with PUT. */
  readonly uploadComplianceIds: (input: {
    readonly account: ConnectedAccountRef;
    readonly job: Pick<XComplianceJob, "uploadUrl">;
    readonly ids: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Downloads a completed job's newline-delimited JSON results from its signed `downloadUrl`. */
  readonly downloadComplianceResults: (input: {
    readonly account: ConnectedAccountRef;
    readonly job: Pick<XComplianceJob, "downloadUrl">;
    /** Defaults to 64 MiB; at most 1 GiB. */
    readonly maxBytes?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  /** Cancels a compliance job (`DELETE /2/compliance/jobs/{id}`) and returns its new state. */
  readonly cancelComplianceJob: (input: {
    readonly account: ConnectedAccountRef;
    readonly jobId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<XComplianceJob>;
  /** Writes a Community Note as an AI Note Writer (`POST /2/notes`). */
  readonly createCommunityNote: (input: {
    readonly account: ConnectedAccountRef;
    readonly note: XCommunityNoteInput;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly noteId: string }>;
  /** Scores draft note text against a Post (`POST /2/notes/evaluate`). */
  readonly evaluateCommunityNote: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly text: string;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly claimOpinionScore?: number }>;
  readonly deleteCommunityNote: (input: {
    readonly account: ConnectedAccountRef;
    readonly noteId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Notes this AI Note Writer wrote (`GET /2/notes/search/notes_written`). */
  readonly communityNotesWritten: (input: {
    readonly account: ConnectedAccountRef;
    readonly testMode: boolean;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Posts eligible for a note (`GET /2/notes/search/posts_eligible_for_notes`). */
  readonly postsEligibleForNotes: (input: {
    readonly account: ConnectedAccountRef;
    readonly testMode: boolean;
    readonly postSelection?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Searches X News stories (`GET /2/news/search`). */
  readonly searchNews: (input: {
    readonly account: ConnectedAccountRef;
    readonly query: string;
    /** 1-720 hours; X defaults to 168. */
    readonly maxAgeHours?: number;
    readonly limit?: number;
    readonly newsFields?: readonly XNewsField[];
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Reads one News story by ID (`GET /2/news/{id}`). */
  readonly getNews: (input: {
    readonly account: ConnectedAccountRef;
    readonly newsId: string;
    readonly newsFields?: readonly XNewsField[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly removeBookmark: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly follow: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly unfollow: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly listDirectMessages: (input: {
    readonly account: ConnectedAccountRef;
    readonly participantId?: string;
    readonly conversationId?: string;
    /** `event_types`; X returns all three types when omitted. */
    readonly eventTypes?: readonly XDmEventType[];
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly sendDirectMessage: (input: {
    readonly account: ConnectedAccountRef;
    readonly participantId: string;
    readonly text: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly sendConversationMessage: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly text: string;
    readonly attachments?: readonly JsonObject[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly createGroupConversation: (input: {
    readonly account: ConnectedAccountRef;
    readonly participantIds: readonly string[];
    readonly message: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Looks up one Space by its ID using the official Spaces lookup endpoint. */
  readonly getSpace: (input: {
    readonly account: ConnectedAccountRef;
    readonly spaceId: string;
    readonly options?: XSpacesLookupInput;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Looks up up to 100 Spaces by ID. */
  readonly getSpaces: (input: {
    readonly account: ConnectedAccountRef;
    readonly spaceIds: readonly string[];
    readonly options?: XSpacesLookupInput;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Looks up Spaces created by up to 100 users. */
  readonly getSpacesByCreators: (input: {
    readonly account: ConnectedAccountRef;
    readonly creatorIds: readonly string[];
    readonly options?: XSpacesLookupInput;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Searches live or scheduled Spaces by title keyword. */
  readonly searchSpaces: (input: {
    readonly account: ConnectedAccountRef;
    readonly search: XSpacesSearchInput;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly getUserById: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly getUserByUsername: (input: {
    readonly account: ConnectedAccountRef;
    readonly username: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly getMe: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly followers: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly following: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly followUser: XNative["follow"];
  readonly unfollowUser: XNative["unfollow"];
  readonly muteUser: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly unmuteUser: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly mutedUsers: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly blockUser: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly unblockUser: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly blockedUsers: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly like: XNative["bookmark"];
  readonly unlike: XNative["removeBookmark"];
  readonly likedPosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly likingUsers: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly createList: (input: {
    readonly account: ConnectedAccountRef;
    readonly name: string;
    readonly description?: string;
    readonly isPrivate?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly updateList: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly name?: string;
    readonly description?: string;
    readonly isPrivate?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly deleteList: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly getList: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly listMembers: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly addListMember: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly removeListMember: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly followList: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly unfollowList: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly ownedLists: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly pinList: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly unpinList: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Returns the full pinned set; rejects cursor/limit because X has no pagination here. */
  readonly pinnedLists: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly listPosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly userPosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly homeTimeline: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly mentions: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly undoRepost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Lists the app's filtered-stream rules. Requires `appBearerToken`. */
  readonly listStreamRules: (input: {
    readonly account: ConnectedAccountRef;
    readonly ids?: readonly string[];
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<XStreamRule>>;
  /** Adds filtered-stream rules in one request. Set `dryRun` to validate without saving. */
  readonly addStreamRules: (input: {
    readonly account: ConnectedAccountRef;
    readonly rules: readonly XStreamRuleInput[];
    readonly dryRun?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<XStreamRulesUpdate>;
  /** Deletes filtered-stream rules by ID in one request. Set `dryRun` to validate without saving. */
  readonly deleteStreamRules: (input: {
    readonly account: ConnectedAccountRef;
    readonly ids: readonly string[];
    readonly dryRun?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<XStreamRulesUpdate>;
  /** Deletes every filtered-stream rule of the project with `delete_all=true`. */
  readonly deleteAllStreamRules: (input: {
    readonly account: ConnectedAccountRef;
    readonly dryRun?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<XStreamRulesUpdate>;
  /**
   * Opens one filtered-stream connection when iteration starts. It yields until the caller
   * stops, `context.signal` aborts, the stall timeout elapses, or X closes the response. It
   * never reconnects on its own. Requires `appBearerToken`.
   */
  readonly stream: (
    input: XStreamOptions & {
      readonly account: ConnectedAccountRef;
      readonly context: AdapterOperationContext;
    },
  ) => AsyncGenerator<XStreamEvent, void, undefined>;
  /**
   * Opens the X Activity API stream (`GET /2/activity/stream`) and yields events for the app's
   * Activity subscriptions. One connection per iteration, no automatic reconnect. Needs
   * `appBearerToken`.
   */
  readonly activityStream: (
    input: Pick<
      XDataStreamOptions,
      "backfillMinutes" | "startTime" | "endTime" | "stallTimeoutMs"
    > & {
      readonly account: ConnectedAccountRef;
      readonly context: AdapterOperationContext;
    },
  ) => AsyncGenerator<XDataStreamEvent, void, undefined>;
  /** Opens one volume stream (sample, sample10, firehoses, likes). Enterprise; needs `appBearerToken`. */
  readonly volumeStream: (
    input: XDataStreamOptions & {
      readonly account: ConnectedAccountRef;
      readonly stream: XVolumeStream;
      readonly context: AdapterOperationContext;
    },
  ) => AsyncGenerator<XDataStreamEvent, void, undefined>;
  /** Opens one compliance stream (posts, users, likes, labels). Enterprise; needs `appBearerToken`. */
  readonly complianceStream: (
    input: Pick<
      XDataStreamOptions,
      "partition" | "backfillMinutes" | "startTime" | "endTime" | "stallTimeoutMs"
    > & {
      readonly account: ConnectedAccountRef;
      readonly stream: XComplianceStream;
      readonly context: AdapterOperationContext;
    },
  ) => AsyncGenerator<XDataStreamEvent, void, undefined>;
  /**
   * Hides or unhides a reply in a conversation the authenticated user started.
   * Calls `PUT /2/tweets/:id/hidden` and returns the hidden state X reports.
   */
  readonly hideReply: (input: {
    readonly account: ConnectedAccountRef;
    readonly replyId: string;
    readonly hidden: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly hidden: boolean }>;
  /** Looks up up to 100 Posts by ID with `GET /2/tweets?ids=`. Missing Posts appear in `metadata.errors`. */
  readonly getPosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly postIds: readonly string[];
    readonly fields?: XPostFieldSelection;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Posts that quote a Post (`GET /2/tweets/{id}/quote_tweets`). Limits are 10-100. */
  readonly quotePosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly exclude?: readonly ("replies" | "retweets")[];
    readonly fields?: XPostFieldSelection;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Users who reposted a Post (`GET /2/tweets/{id}/retweeted_by`). */
  readonly repostedBy: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly userFields?: readonly XUserField[];
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Repost Posts of a Post (`GET /2/tweets/{id}/retweets`). */
  readonly reposts: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly fields?: XPostFieldSelection;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Reposts of the authenticated user's Posts (`GET /2/users/reposts_of_me`). Needs `timeline.read`. */
  readonly repostsOfMe: (input: {
    readonly account: ConnectedAccountRef;
    readonly fields?: XPostFieldSelection;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Looks up up to 100 users by ID (`GET /2/users?ids=`). */
  readonly getUsers: (input: {
    readonly account: ConnectedAccountRef;
    readonly userIds: readonly string[];
    readonly userFields?: readonly XUserField[];
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Looks up up to 100 users by username (`GET /2/users/by?usernames=`). */
  readonly getUsersByUsernames: (input: {
    readonly account: ConnectedAccountRef;
    readonly usernames: readonly string[];
    readonly userFields?: readonly XUserField[];
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Searches users by name or handle (`GET /2/users/search`). Limits are 1-1000. */
  readonly searchUsers: (input: {
    readonly account: ConnectedAccountRef;
    readonly query: string;
    readonly userFields?: readonly XUserField[];
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Post counts over the last 7 days (`GET /2/tweets/counts/recent`). */
  readonly countRecentPosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly counts: XPostCountsInput;
    readonly context: AdapterOperationContext;
  }) => Promise<XPostCounts>;
  /** Full-archive Post counts (`GET /2/tweets/counts/all`). Requires `appBearerToken`. */
  readonly countAllPosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly counts: XPostCountsInput;
    readonly context: AdapterOperationContext;
  }) => Promise<XPostCounts>;
  /** Users affiliated with an organization account (`GET /2/users/{id}/affiliates`). */
  readonly affiliates: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly userFields?: readonly XUserField[];
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Users who follow a List (`GET /2/lists/{id}/followers`). */
  readonly listFollowers: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly userFields?: readonly XUserField[];
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Lists a user is a member of (`GET /2/users/{id}/list_memberships`). Defaults to the account. */
  readonly listMemberships: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** The account's bookmark folders (`GET /2/users/{id}/bookmarks/folders`). */
  readonly bookmarkFolders: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<XBookmarkFolder>>;
  /** Creates a bookmark folder with a 1-25 character name. */
  readonly createBookmarkFolder: (input: {
    readonly account: ConnectedAccountRef;
    readonly name: string;
    readonly context: AdapterOperationContext;
  }) => Promise<XBookmarkFolder>;
  /** Post IDs saved in one bookmark folder (`GET /2/users/{id}/bookmarks/folders/{folder_id}`). */
  readonly bookmarksByFolder: (input: {
    readonly account: ConnectedAccountRef;
    readonly folderId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Posts shared in a Space (`GET /2/spaces/{id}/tweets`). */
  readonly spacePosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly spaceId: string;
    readonly fields?: XPostFieldSelection;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Ticket buyers of the account's ticketed Space (`GET /2/spaces/{id}/buyers`). Needs a user token. */
  readonly spaceBuyers: (input: {
    readonly account: ConnectedAccountRef;
    readonly spaceId: string;
    readonly userFields?: readonly XUserField[];
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Looks up one Community (`GET /2/communities/{id}`). */
  readonly getCommunity: (input: {
    readonly account: ConnectedAccountRef;
    readonly communityId: string;
    readonly communityFields?: readonly XCommunityField[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Searches Communities by keyword (`GET /2/communities/search`). Limits are 10-100. */
  readonly searchCommunities: (input: {
    readonly account: ConnectedAccountRef;
    readonly query: string;
    readonly communityFields?: readonly XCommunityField[];
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Trends for a Yahoo! WOEID location (`GET /2/trends/by/woeid/{woeid}`); 1 is worldwide. */
  readonly trends: (input: {
    readonly account: ConnectedAccountRef;
    readonly woeid: number;
    readonly maxTrends?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly XTrend[]>;
  /** Trends personalized for the authenticated user (`GET /2/users/personalized_trends`). */
  readonly personalizedTrends: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly XPersonalizedTrend[]>;
  /** The project's Post consumption (`GET /2/usage/tweets`). Requires `appBearerToken`. */
  readonly postUsage: (input: {
    readonly account: ConnectedAccountRef;
    /** 1 through 90. X defaults to 7. */
    readonly days?: number;
    readonly usageFields?: readonly XUsageField[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Remaining pay-per-use credit balance in USD (`GET /2/usage/credits`). */
  readonly creditBalance: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<XCreditBalance>;
  /** Looks up up to 100 media items by media key (`GET /2/media?media_keys=`). */
  readonly getMedia: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaKeys: readonly string[];
    readonly mediaFields?: readonly XMediaField[];
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /**
   * Uploads one Direct Message attachment with `media_category` `dm_image`, `dm_gif`, or
   * `dm_video`. X allows 5 MB images, 15 MB GIFs, and DM video up to 512 MB (1 GB for Premium).
   * Attach the returned ID with `sendConversationMessage`'s `attachments`.
   */
  readonly uploadDmMedia: (input: {
    readonly account: ConnectedAccountRef;
    readonly media: Blob;
    readonly kind: "image" | "gif" | "video";
    /** Defaults to the Blob's type. */
    readonly mimeType?: string;
    /** User IDs that may also attach this media (`additional_owners`). */
    readonly additionalOwners?: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<XUploadedMedia>;
  /** Uploads an SRT or WebVTT subtitle file with `media_category=subtitles`. */
  readonly uploadSubtitles: (input: {
    readonly account: ConnectedAccountRef;
    readonly file: Blob;
    readonly format: "srt" | "vtt";
    readonly context: AdapterOperationContext;
  }) => Promise<XUploadedMedia>;
  /** Attaches an uploaded subtitle track to an uploaded video (`POST /2/media/subtitles`). */
  readonly attachSubtitles: (input: {
    readonly account: ConnectedAccountRef;
    readonly videoMediaId: string;
    readonly subtitleMediaId: string;
    /** Two uppercase letters, such as `EN`. */
    readonly languageCode: string;
    readonly displayName?: string;
    /** Defaults to `TweetVideo`. */
    readonly mediaCategory?: "TweetVideo" | "AmplifyVideo";
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Removes a video's subtitle track for one language (`DELETE /2/media/subtitles`). */
  readonly deleteSubtitles: (input: {
    readonly account: ConnectedAccountRef;
    readonly videoMediaId: string;
    readonly languageCode: string;
    readonly mediaCategory?: "TweetVideo" | "AmplifyVideo";
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Owner-only `non_public_metrics` and `organic_metrics` for up to 100 Posts from the last 30 days. */
  readonly privatePostMetrics: (input: {
    readonly account: ConnectedAccountRef;
    readonly postIds: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<readonly XPrivatePostMetrics[]>;
  /** Engagement time series for up to 100 owned Posts (`GET /2/tweets/analytics`). */
  readonly postAnalytics: (input: {
    readonly account: ConnectedAccountRef;
    readonly postIds: readonly string[];
    readonly startTime: string;
    readonly endTime: string;
    /** X defaults to `total`. */
    readonly granularity?: "hourly" | "daily" | "weekly" | "total";
    readonly fields?: readonly XPostAnalyticsField[];
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Video metrics for up to 100 owned media keys (`GET /2/media/analytics`). */
  readonly mediaAnalytics: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaKeys: readonly string[];
    readonly startTime: string;
    readonly endTime: string;
    /** X defaults to `daily`. */
    readonly granularity?: "hourly" | "daily" | "total";
    readonly fields?: readonly XMediaAnalyticsField[];
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Reads one DM event (`GET /2/dm_events/{event_id}`). */
  readonly getDirectMessage: (input: {
    readonly account: ConnectedAccountRef;
    readonly eventId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Deletes one DM event the account sent (`DELETE /2/dm_events/{event_id}`). */
  readonly deleteDirectMessage: (input: {
    readonly account: ConnectedAccountRef;
    readonly eventId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Downloads legacy DM media bytes (`GET /2/dm_conversations/media/{dm_id}/{media_id}/{resource_id}`). */
  readonly downloadDmMedia: (input: {
    readonly account: ConnectedAccountRef;
    readonly dmId: string;
    readonly mediaId: string;
    readonly resourceId: string;
    /** Largest accepted body. Defaults to 15 MiB; DM video can need up to 1 GiB. */
    readonly maxBytes?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<XDownloadedMedia>;
  /** Blocks Direct Messages to and from a user (`POST /2/users/{id}/dm/block`). */
  readonly blockDms: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Lifts a DM block (`POST /2/users/{id}/dm/unblock`). */
  readonly unblockDms: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Rule totals and caps for the filtered stream (`GET /2/tweets/search/stream/rules/counts`). */
  readonly streamRuleCounts: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<XStreamRuleCounts>;
  /** Webhooks that receive filtered-stream Posts (`GET /2/tweets/search/webhooks`). */
  readonly streamWebhooks: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Delivers filtered-stream Posts to a registered webhook (`POST /2/tweets/search/webhooks/{id}`). */
  readonly linkStreamWebhook: (input: {
    readonly account: ConnectedAccountRef;
    readonly webhookId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Stops delivering filtered-stream Posts to a webhook. */
  readonly unlinkStreamWebhook: (input: {
    readonly account: ConnectedAccountRef;
    readonly webhookId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Streaming connection history from the Connections API (`GET /2/connections`). */
  readonly streamConnections: (input: {
    readonly account: ConnectedAccountRef;
    /** X defaults to `active`. */
    readonly status?: "active" | "inactive" | "all";
    readonly endpoints?: readonly XStreamEndpoint[];
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Closes streaming connections by UUID, by endpoint, or all of them. */
  readonly terminateStreamConnections: (input: {
    readonly account: ConnectedAccountRef;
    readonly target: XConnectionTarget;
    readonly context: AdapterOperationContext;
  }) => Promise<XConnectionTermination>;
  /** Webhook configs registered for the app (`GET /2/webhooks`). */
  readonly listWebhooks: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly XWebhookConfig[]>;
  /** Registers an HTTPS webhook URL (`POST /2/webhooks`). X sends a CRC check first. */
  readonly createWebhook: (input: {
    readonly account: ConnectedAccountRef;
    readonly url: string;
    readonly context: AdapterOperationContext;
  }) => Promise<XWebhookConfig>;
  /** Asks X to re-run the CRC check and re-enable a webhook (`PUT /2/webhooks/{id}`). */
  readonly validateWebhook: (input: {
    readonly account: ConnectedAccountRef;
    readonly webhookId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly valid: boolean }>;
  readonly deleteWebhook: (input: {
    readonly account: ConnectedAccountRef;
    readonly webhookId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Re-delivers events from a time window to a webhook (`POST /2/webhooks/replay`). */
  readonly replayWebhook: (input: {
    readonly account: ConnectedAccountRef;
    readonly webhookId: string;
    /** ISO 8601 times; X takes minute precision in UTC. */
    readonly from: string;
    readonly to: string;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly jobId: string; readonly createdAt: string }>;
  /** Subscribes a webhook to X Activity API events (`POST /2/activity/subscriptions`). */
  readonly createActivitySubscription: (input: {
    readonly account: ConnectedAccountRef;
    readonly eventType: XActivityEventType;
    readonly filter: XActivityFilter;
    readonly webhookId?: string;
    readonly tag?: string;
    /** RFC 3339 time after which X deletes the subscription. */
    readonly expiresAt?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly listActivitySubscriptions: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Changes a subscription's tag or webhook (`PUT /2/activity/subscriptions/{id}`). */
  readonly updateActivitySubscription: (input: {
    readonly account: ConnectedAccountRef;
    readonly subscriptionId: string;
    readonly tag?: string;
    readonly webhookId?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Deletes up to 100 subscriptions. One ID uses the single-delete route. */
  readonly deleteActivitySubscriptions: (input: {
    readonly account: ConnectedAccountRef;
    readonly subscriptionIds: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Creates a draft long-form Article (`POST /2/articles/draft`). */
  readonly createArticleDraft: (input: {
    readonly account: ConnectedAccountRef;
    readonly title: string;
    readonly blocks: readonly XArticleBlock[];
    readonly entities?: readonly XArticleEntity[];
    readonly coverMedia?: { readonly mediaId: string; readonly mediaCategory?: string };
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly articleId: string; readonly title: string }>;
  /** Publishes a draft Article (`POST /2/articles/{id}/publish`) and returns the new Post. */
  readonly publishArticle: (input: {
    readonly account: ConnectedAccountRef;
    readonly articleId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<PlatformPostRef>;
  /** The account's X Chat inbox (`GET /2/chat/conversations`), newest first. */
  readonly chatConversations: (input: {
    readonly account: ConnectedAccountRef;
    readonly unreadOnly?: boolean;
    readonly type?: "direct" | "group";
    /** `participant_query`: up to 50 characters matched against participants' names. */
    readonly participantQuery?: string;
    /** `participant_ids`: conversations with all of these 1-10 users. */
    readonly participantIds?: readonly string[];
    readonly archived?: boolean;
    readonly muted?: boolean;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Events of one X Chat conversation. Encrypted `encoded_event` values need the Chat XDK. */
  readonly chatEvents: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Sends one X Chat message (`POST /2/chat/conversations/{id}/messages`). */
  readonly sendChatMessage: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    /** Your unique ID for this message. */
    readonly messageId: string;
    readonly message: XChatMessage;
    /** `conversation_token`, forwarded when X gives you one for the conversation. */
    readonly conversationToken?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly encodedMessageEvent: string }>;
  /** Reserves a group conversation ID (`POST /2/chat/conversations/group/initialize`). */
  readonly initializeChatGroup: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly conversationId: string }>;
  /** Creates an encrypted group from Chat XDK output (`POST /2/chat/conversations/group`). */
  readonly createChatGroup: (input: {
    readonly account: ConnectedAccountRef;
    readonly group: XChatGroupInput;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly conversationId: string; readonly keyChangeSequenceId?: string }>;
  /** Reads one conversation's metadata (`GET /2/chat/conversations/{id}`). */
  readonly getChatConversation: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly updateChatGroup: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly update: XChatGroupUpdate;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly deleteChatConversation: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly actionSignatures?: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Adds members; pass the rotated keys and re-encrypted title the Chat XDK produced. */
  readonly addChatMembers: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly userIds: readonly string[];
    readonly conversationKeyVersion?: string;
    readonly participantKeys?: readonly XChatParticipantKey[];
    readonly encryptedTitle?: string;
    readonly encryptedAvatarUrl?: string;
    readonly actionSignatures?: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly removeChatMembers: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly userIds: readonly string[];
    /** `group_key_rotation_data` from the Chat XDK, forwarded unchanged. */
    readonly keyRotation?: JsonObject;
    readonly actionSignatures?: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Grants (`/admins`) or revokes (`/admins/remove`) group admin rights. */
  readonly setChatAdmins: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly userIds: readonly string[];
    readonly admin: boolean;
    readonly actionSignatures?: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Users waiting for admin rights (`GET /2/chat/conversations/{id}/admin_requests`). */
  readonly chatAdminRequests: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly cursor?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly requestChatAdmin: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly actionSignatures?: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Approves or rejects one user's admin request. */
  readonly resolveChatAdminRequest: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly userId: string;
    readonly approve: boolean;
    readonly actionSignatures?: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly updateChatAdminSettings: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly settings: XChatAdminSettings;
    readonly actionSignatures?: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Turns on a group invite link and returns it (`POST .../invite`). */
  readonly enableChatInvite: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly invite: XChatInviteInput;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly disableChatInvite: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly actionSignatures?: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly getChatInvite: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly token: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Asks to join a group through its invite token (`POST .../join_requests`). */
  readonly requestToJoinChat: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly token: string;
    readonly actionSignatures?: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly rejectChatJoinRequests: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly userIds: readonly string[];
    readonly actionSignatures?: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Archives (`POST .../archive`) or unarchives (`DELETE .../archive`) a conversation. */
  readonly setChatArchived: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly archived: boolean;
    readonly actionSignatures?: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Mutes (`POST .../mute`) or unmutes (`DELETE .../mute`) a conversation. */
  readonly setChatMuted: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly muted: boolean;
    readonly actionSignatures?: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Marks a conversation read (`POST .../read`, optionally signed) or unread (`POST .../unread`). */
  readonly markChatRead: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly read: boolean;
    readonly actionSignatures?: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Sends a typing indicator (`POST .../typing`). */
  readonly sendChatTyping: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Turns disappearing messages on (`PUT .../message_ttl`) or off with `ttlMs: undefined`. */
  readonly setChatMessageTtl: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly ttlMs: number | undefined;
    readonly actionSignatures?: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Screenshot blocking and detection (`PUT .../screen_capture`). */
  readonly setChatScreenCapture: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly blocking?: boolean;
    readonly detection?: boolean;
    readonly blockingSignatures?: readonly XChatActionSignature[];
    readonly detectionSignatures?: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly blocking?: boolean; readonly detection?: boolean }>;
  /** Pinned messages as encoded events (`GET .../pinned_messages`). */
  readonly chatPinnedMessages: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly cursor?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Deletes messages by sequence ID for everyone or only the caller (`POST .../messages/delete`). */
  readonly deleteChatMessages: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly sequenceIds: readonly string[];
    readonly scope: "delete_for_all" | "delete_for_self";
    readonly mediaHashKeys?: readonly string[];
    readonly actionSignatures: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Adds or rotates a conversation's keys (`POST /2/chat/conversations/{id}/keys`). */
  readonly addChatConversationKeys: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly conversationKeyVersion: string;
    readonly participantKeys: readonly XChatParticipantKey[];
    readonly keyRotation?: string;
    readonly actionSignatures?: readonly XChatActionSignature[];
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly sequenceId?: string }>;
  /** Public keys of up to 100 users (`GET /2/users/public_keys`) or one user. */
  readonly chatPublicKeys: (input: {
    readonly account: ConnectedAccountRef;
    readonly userIds: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  /** Registers the account's public key (`POST /2/users/{id}/public_keys`), as built by the Chat XDK. */
  readonly registerChatPublicKey: (input: {
    readonly account: ConnectedAccountRef;
    readonly publicKey: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /**
   * Uploads already-encrypted chat media through initialize, 4 MiB appends, and finalize
   * (`/2/chat/media/upload`). Returns the hash key to reference in the encrypted message.
   */
  readonly uploadChatMedia: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly media: Blob;
    readonly messageId?: string;
    readonly ttlMs?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly mediaHashKey: string; readonly sessionId: string }>;
  /** Downloads encrypted chat media bytes (`GET /2/chat/media/{id}/{media_hash_key}`). */
  readonly downloadChatMedia: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly mediaHashKey: string;
    readonly maxBytes?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<XDownloadedMedia>;
  /** Pending message requests (`GET /2/chat/message_requests`). */
  readonly chatMessageRequests: (input: {
    readonly account: ConnectedAccountRef;
    readonly inboxType?: "you_may_know" | "low_quality";
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly getChatMessageRequest: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly acceptChatMessageRequest: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Reads (`GET /2/chat/settings`) or, with `settings`, updates (`PUT`) the chat settings. */
  readonly chatSettings: (input: {
    readonly account: ConnectedAccountRef;
    readonly settings?: XChatSettings;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Starts an X call hosted by the account (`POST /2/calls`); needs `calls.write`. */
  readonly createCall: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId?: string;
    readonly title?: string;
    readonly joinPolicy?: "open" | "closed" | "trusted";
    readonly audioOnly?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly getCall: (input: {
    readonly account: ConnectedAccountRef;
    readonly callId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /**
   * Starts a media session in a call (`POST /2/calls/{id}/join`, `calls.join`). The result's
   * short-lived `media_token` opens the media WebSocket at `media_url`; treat it as a secret.
   */
  readonly joinCall: (input: {
    readonly account: ConnectedAccountRef;
    readonly callId: string;
    /** `media.audio`: PCM16 mono at 8000, 16000, 24000 (X's default), or 48000 Hz. */
    readonly audio?: { readonly sampleRate?: 8000 | 16000 | 24000 | 48000 };
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly leaveCall: (input: {
    readonly account: ConnectedAccountRef;
    readonly callId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly scheduledCalls: (input: {
    readonly account: ConnectedAccountRef;
    readonly startTime?: string;
    readonly endTime?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly scheduleCall: (input: {
    readonly account: ConnectedAccountRef;
    readonly call: XScheduledCallInput;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly getScheduledCall: (input: {
    readonly account: ConnectedAccountRef;
    readonly scheduledCallId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** `inviteeIds` here replaces the whole invite list (up to 100). */
  readonly updateScheduledCall: (input: {
    readonly account: ConnectedAccountRef;
    readonly scheduledCallId: string;
    readonly update: Partial<XScheduledCallInput> & XCallOccurrence;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly cancelScheduledCall: (input: {
    readonly account: ConnectedAccountRef;
    readonly scheduledCallId: string;
    readonly occurrence?: XCallOccurrence;
    readonly notifyInvitees?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly rsvpScheduledCall: (input: {
    readonly account: ConnectedAccountRef;
    readonly scheduledCallId: string;
    readonly response: "accepted" | "declined" | "tentative";
    readonly occurrence?: XCallOccurrence;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** The project's bot accounts (`GET /2/bots`, app bearer). */
  readonly bots: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Creates (or, for an existing handle, re-mints) a bot (`POST /2/bots`). */
  readonly createBot: (input: {
    readonly account: ConnectedAccountRef;
    readonly handle: string;
    readonly displayName?: string;
    readonly orgOnly?: boolean;
    readonly scopes?: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<XBotWithToken>;
  readonly updateBot: (input: {
    readonly account: ConnectedAccountRef;
    readonly botId: string;
    readonly handle?: string;
    readonly displayName?: string;
    readonly dmPermission?: "everyone" | "premium" | "no_one";
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly deleteBot: (input: {
    readonly account: ConnectedAccountRef;
    readonly botId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Rotates (`POST /2/bots/{id}/token`) a bot's bearer token, revoking the previous one. */
  readonly rotateBotToken: (input: {
    readonly account: ConnectedAccountRef;
    readonly botId: string;
    readonly scopes?: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<XBotWithToken>;
  readonly revokeBotToken: (input: {
    readonly account: ConnectedAccountRef;
    readonly botId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** The user's X Developer Platform account (`GET /2/account`, `developer.read`). */
  readonly developerAccount: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Creates the developer account if missing (`POST /2/account`, `developer.write`). */
  readonly ensureDeveloperAccount: (input: {
    readonly account: ConnectedAccountRef;
    readonly metadata?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly accountId: string; readonly created: boolean }>;
  /** The account's live broadcasts (`GET /2/broadcasts`): by ID, or one page. */
  readonly broadcasts: (input: {
    readonly account: ConnectedAccountRef;
    readonly broadcastIds?: readonly string[];
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly getBroadcast: (input: {
    readonly account: ConnectedAccountRef;
    readonly broadcastId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Ends a running broadcast (`PUT /2/broadcasts/{id}/state` with `END`). */
  readonly endBroadcast: (input: {
    readonly account: ConnectedAccountRef;
    readonly broadcastId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Deletes a scheduled or ended broadcast and its replay. */
  readonly deleteBroadcast: (input: {
    readonly account: ConnectedAccountRef;
    readonly broadcastId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Schedules a broadcast on a stream source (`POST /2/broadcasts/scheduled`). */
  readonly scheduleBroadcast: (input: {
    readonly account: ConnectedAccountRef;
    readonly broadcast: XScheduledBroadcastInput;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly scheduledBroadcasts: (input: {
    readonly account: ConnectedAccountRef;
    /** `oldest_start_time` and `newest_start_time` bound the start times listed (ISO 8601). */
    readonly oldestStartAt?: string;
    readonly newestStartAt?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly getScheduledBroadcast: (input: {
    readonly account: ConnectedAccountRef;
    readonly broadcastId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Replaces a scheduled broadcast's settings (`PUT /2/broadcasts/scheduled/{id}`). */
  readonly updateScheduledBroadcast: (input: {
    readonly account: ConnectedAccountRef;
    readonly broadcastId: string;
    /** The numeric `scheduled_broadcast_id` from create, list, or get. */
    readonly scheduledBroadcastId: string;
    readonly broadcast: Omit<XScheduledBroadcastInput, "sourceId" | "recurrence" | "endAt"> & {
      readonly sourceId?: string;
      readonly endAt: string;
    };
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** The ingest region X picks for this caller (`GET /2/region`). */
  readonly ingestRegion: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<string>;
  /** Mutes or unmutes a user in one broadcast's chat (`/2/broadcasts/{id}/chat/mutes`). */
  readonly setBroadcastChatMute: (input: {
    readonly account: ConnectedAccountRef;
    readonly broadcastId: string;
    readonly userId: string;
    readonly muted: boolean;
    readonly endAt?: string;
    /** A chat message to remove while muting. */
    readonly removeMessageId?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** The account's own broadcasts (`GET /2/users/{id}/broadcasts`). */
  readonly userBroadcasts: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly getUserBroadcast: (input: {
    readonly account: ConnectedAccountRef;
    readonly broadcastId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Creates a broadcast on one of the account's sources (`POST /2/users/{id}/broadcasts`). */
  readonly createUserBroadcast: (input: {
    readonly account: ConnectedAccountRef;
    readonly sourceId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly broadcast: JsonObject; readonly shareUrl: string }>;
  /** Publishes or ends a user broadcast (`PUT /2/users/{id}/broadcasts/{broadcast_id}/state`). */
  readonly setUserBroadcastState: (input: {
    readonly account: ConnectedAccountRef;
    readonly broadcastId: string;
    readonly state:
      | {
          readonly kind: "publish";
          readonly title?: string;
          readonly locale?: string;
          readonly chatOption?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
          /** `should_not_tweet`: go live without posting the announcing Post. */
          readonly shouldNotTweet?: boolean;
        }
      | { readonly kind: "end" };
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly deleteUserBroadcast: (input: {
    readonly account: ConnectedAccountRef;
    readonly broadcastId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** The account's stream sources (`GET /2/users/{id}/sources`); each includes its stream key. */
  readonly userStreamSources: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  readonly getUserStreamSource: (input: {
    readonly account: ConnectedAccountRef;
    readonly sourceId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Creates a source; `region` is `atla` or `pdxa` (X's default). */
  readonly createUserStreamSource: (input: {
    readonly account: ConnectedAccountRef;
    readonly name: string;
    readonly region?: "atla" | "pdxa";
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly renameUserStreamSource: (input: {
    readonly account: ConnectedAccountRef;
    readonly sourceId: string;
    readonly name: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly deleteUserStreamSource: (input: {
    readonly account: ConnectedAccountRef;
    readonly sourceId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Publishes a scheduled broadcast created with `manualPublish: true`. */
  readonly goLive: (input: {
    readonly account: ConnectedAccountRef;
    readonly broadcastId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly deleteScheduledBroadcast: (input: {
    readonly account: ConnectedAccountRef;
    readonly broadcastId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** RTMP/RTMPS ingest sources (`GET /2/sources`). Each one includes its secret stream key. */
  readonly streamSources: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly createStreamSource: (input: {
    readonly account: ConnectedAccountRef;
    readonly name: string;
    /** An ingest region such as `us-east-1`, as listed by X's `GET /2/region`. */
    readonly region: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly deleteStreamSource: (input: {
    readonly account: ConnectedAccountRef;
    readonly sourceId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Newest-first chat messages of an owned broadcast. Limits are 1-200. */
  readonly broadcastChat: (input: {
    readonly account: ConnectedAccountRef;
    readonly broadcastId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /** Posts a chat message of up to 140 characters to a running broadcast. */
  readonly sendBroadcastChat: (input: {
    readonly account: ConnectedAccountRef;
    readonly broadcastId: string;
    readonly text: string;
    readonly replyTo?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly timestamp: string }>;
  readonly removeBroadcastChatMessage: (input: {
    readonly account: ConnectedAccountRef;
    readonly broadcastId: string;
    readonly messageId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Adds or removes a persistent chat moderator; returns the current moderator IDs. */
  readonly setChatModerator: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly moderator: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly string[]>;
  /** Mutes or unmutes a user in the host's broadcast chats. `endAt` makes the mute a timeout. */
  readonly setChatMute: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly muted: boolean;
    readonly broadcastId?: string;
    readonly endAt?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
}

export function x(options: XOptions): import("../core/adapter.js").SocialAdapter<XNative> {
  const request = managedHttp("https://api.x.com", {
    apiKey: options.auth.accessToken ?? "app-auth-placeholder",
    ...definedFields({ fetch: options.fetch }),
  });

  const appRequest = () => {
    if (!options.appBearerToken?.trim())
      throw new SocialError({
        code: "missing_permission",
        operation: "x.app-auth",
        message: "This X endpoint requires an app-only bearer token. Configure appBearerToken.",
      });

    return managedHttp("https://api.x.com", {
      apiKey: options.appBearerToken,
      ...definedFields({ fetch: options.fetch }),
    });
  };

  const requireUserToken = (operation: string) => {
    if (!options.auth.accessToken?.trim())
      throw new SocialError({
        code: "missing_permission",
        operation,
        message: "This X operation requires a user access token.",
      });

    return request;
  };

  const readRequest = (path: string) =>
    [
      "/2/users/me",
      "/liked_tweets",
      "/mentions",
      "/timelines/reverse_chronological",
      "/muting",
      "/blocking",
      "pinned_lists",
    ].some((suffix) => path.includes(suffix))
      ? requireUserToken("x.read")
      : options.auth.accessToken?.trim()
        ? request
        : appRequest();

  const spaceParams = (options: XSpacesLookupInput | undefined) => ({
    ...definedFields({
      "space.fields": options?.spaceFields?.join(","),
      expansions: options?.expansions?.join(","),
      "user.fields": options?.userFields?.join(","),
    }),
  });

  const spaceMetadata = (result: JsonObject): JsonObject | undefined => {
    const includes = result["includes"];
    const errors = result["errors"];

    if (includes === undefined && errors === undefined) return undefined;

    return {
      ...definedFields({
        includes: includes === undefined ? undefined : object(includes),
        errors: errors === undefined ? undefined : array(errors).map(object),
      }),
    };
  };

  const validateSpaceIds = (ids: readonly string[], name: string, max: number) => {
    if (ids.length < 1 || ids.length > max || ids.some((id) => !/^[a-zA-Z0-9]{1,13}$/.test(id)))
      throw new SocialError({
        code: "invalid_input",
        operation: "x.spaces.read",
        message: `${name} must contain ${max === 1 ? "one" : `1-${max}`} valid X Space IDs.`,
      });
  };

  const http = createHttp(definedFields({ fetch: options.fetch }));

  const now = () => (options.clock?.() ?? new Date()).toISOString();

  const authorize = (
    ref: { backend: string; platform: string; accountId: string },
    context: AdapterOperationContext,
  ) => {
    if (
      ref.backend !== context.backendInstance ||
      ref.platform !== "x" ||
      ref.accountId !== options.auth.userId
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "x",
        message: "Reference does not match this X user authorization.",
      });
  };

  function confirmedWrite(
    value: JsonValue,
    field: string,
    expected: boolean,
    operation: string,
  ): JsonObject {
    const result = isJsonObject(value) ? value : {};

    const data = result["data"];

    if (
      !isJsonObject(data) ||
      data[field] !== expected ||
      (field === "following" && expected && data["pending_follow"] === true)
    )
      throw new SocialError({
        code: "ambiguous_outcome",
        operation,
        message:
          "X did not confirm the requested change. Check provider state before retrying; a follow may still be pending.",
        retryDisposition: { kind: "reconcile-first" },
      });

    return result;
  }

  async function readAccount(context: AdapterOperationContext) {
    const user = object(object(await request("/2/users/me", context))["data"]);

    if (user["id"] !== options.auth.userId)
      throw new SocialError({
        code: "unauthorized",
        operation: "accounts.read",
        message: "The authenticated X user differs from the configured account.",
      });

    return {
      ref: {
        kind: "connected-account" as const,
        version: 1 as const,
        backend: context.backendInstance,
        platform: "x",
        accountId: options.auth.userId,
      },
      displayName: string(user["name"]),
      ...definedFields({ handle: optionalString(user["username"]) }),
      status: "connected" as const,
    };
  }

  async function readPost(
    ref: PlatformPostRef,
    context: AdapterOperationContext,
  ): Promise<JsonObject> {
    authorize(ref, context);

    const result = object(
      object(
        await request(`/2/tweets/${encodeURIComponent(ref.postId)}`, context, undefined, {
          "tweet.fields": "author_id,public_metrics,created_at,conversation_id,referenced_tweets",
        }),
      )["data"],
    );

    if (result["id"] !== ref.postId || result["author_id"] !== ref.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation: "posts.read",
        message: "X post identity or author does not match the declared reference.",
      });

    return result;
  }

  async function listPosts(
    account: ConnectedAccountRef,
    input: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
    context: AdapterOperationContext,
  ) {
    authorize(account, context);

    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 5 || input.limit > 100)
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "posts.list",
        message: "X feed limit must be an integer from 5 through 100.",
      });

    const result = object(
      await request(
        `/2/users/${encodeURIComponent(account.accountId)}/tweets`,
        context,
        undefined,
        {
          "tweet.fields": "id,text,author_id,created_at,conversation_id",
          ...definedFields({
            pagination_token: input.cursor,
            max_results: input.limit?.toString(),
          }),
        },
      ),
    );

    const items = (result["data"] === undefined ? [] : array(result["data"])).map((entry) => {
      const row = object(entry);

      const authorId = optionalString(row["author_id"]);

      if (authorId !== account.accountId)
        throw new SocialError({
          code: "unauthorized",
          operation: "posts.list",
          message: "X returned a post owned by a different account.",
        });

      return publicFields(row, ["id", "text", "author_id", "created_at", "conversation_id"]);
    });

    const meta = result["meta"] === undefined ? {} : object(result["meta"]);

    const nextCursor = optionalString(meta["next_token"]);

    return {
      items,
      ...definedFields({ nextCursor }),
    };
  }

  async function searchPosts(
    account: ConnectedAccountRef,
    input: SearchPostsInput,
    context: AdapterOperationContext,
    nativeInput?: XSearchInput,
  ): Promise<Page<JsonObject>> {
    authorize(account, context);

    const query = input.query;

    const scope = input.scope ?? "recent";

    const maxLimit = scope === "all" ? 500 : 100;

    if (!query.trim() || query.length > 4096)
      throw new SocialError({
        code: "invalid_input",
        operation: "search.posts",
        message: "X search queries must contain 1-4096 characters.",
      });

    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 10 || input.limit > maxLimit)
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "search.posts",
        message: `X ${scope} search limits must be integers from 10 through ${maxLimit}.`,
      });

    for (const [name, value] of [
      ["startTime", input.startTime],
      ["endTime", input.endTime],
    ] as const) {
      if (value !== undefined && !Number.isFinite(Date.parse(value)))
        throw new SocialError({
          code: "invalid_input",
          operation: "search.posts",
          message: `${name} must be an ISO 8601 timestamp.`,
        });
    }

    if (
      input.startTime !== undefined &&
      input.endTime !== undefined &&
      Date.parse(input.startTime) >= Date.parse(input.endTime)
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "search.posts",
        message: "startTime must be earlier than endTime.",
      });

    const result = object(
      await (options.auth.accessToken?.trim() ? request : appRequest())(
        `/2/tweets/search/${scope}`,
        context,
        undefined,
        {
          query,
          "tweet.fields": [
            "id",
            "text",
            "edit_history_tweet_ids",
            ...(nativeInput?.tweetFields ?? [
              "author_id",
              "created_at",
              "conversation_id",
              "public_metrics",
              "lang",
              "entities",
              "attachments",
              "referenced_tweets",
            ]),
          ]
            .filter((field, index, fields) => fields.indexOf(field) === index)
            .join(","),
          ...definedFields({
            next_token: input.cursor,
            max_results: input.limit?.toString(),
            start_time: input.startTime,
            end_time: input.endTime,
            sort_order: nativeInput?.sortOrder,
            expansions: nativeInput?.expansions?.join(","),
            "user.fields": nativeInput?.userFields?.join(","),
            "media.fields": nativeInput?.mediaFields?.join(","),
          }),
        },
      ),
    );

    const requestedFields = nativeInput?.tweetFields ?? [
      "id",
      "text",
      "author_id",
      "created_at",
      "conversation_id",
      "public_metrics",
      "lang",
      "entities",
      "attachments",
      "referenced_tweets",
    ];

    const items = (result["data"] === undefined ? [] : array(result["data"])).map((entry) => {
      const row = object(entry);

      const picked: Record<string, JsonValue> = {};

      // A Set keeps first-seen order, so "id" and "text" lead and repeated fields appear once.
      for (const field of new Set(["id", "text", "edit_history_tweet_ids", ...requestedFields])) {
        const value = row[field];

        if (value !== undefined) picked[field] = value;
      }

      return picked;
    });

    const meta = result["meta"] === undefined ? {} : object(result["meta"]);

    const nextCursor = optionalString(meta["next_token"]);

    const includes = result["includes"];

    return {
      items,
      ...definedFields({
        nextCursor,
        metadata: includes === undefined ? undefined : { includes: object(includes) },
      }),
    };
  }

  // Replies come from recent search with the standalone `conversation_id:` operator, which is
  // the method X documents for reading a conversation. Sources, accessed 2026-09-24:
  // https://docs.x.com/x-api/fundamentals/conversation-id
  // https://docs.x.com/x-api/posts/search/integrate/operators
  // https://docs.x.com/x-api/posts/search-recent-posts (max_results 10-100, next_token)
  // https://docs.x.com/x-api/posts/search/introduction (recent search covers the last 7 days)
  // https://docs.x.com/x-api/fundamentals/rate-limits (450/15min per app, 300/15min per user)
  async function listReplies(
    post: PlatformPostRef,
    input: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
    context: AdapterOperationContext,
  ): Promise<Page<JsonObject>> {
    authorize(post, context);

    if (!/^[0-9]{1,19}$/.test(post.postId))
      throw new SocialError({
        code: "invalid_input",
        operation: "comments.read",
        message: "X post IDs must be numeric.",
      });

    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 10 || input.limit > 100)
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "comments.read",
        message: "X reply limits must be integers from 10 through 100.",
      });

    const query: XRecentSearchQuery = {
      query: `conversation_id:${post.postId}`,
      "tweet.fields": replyFields.join(","),
    };

    if (input.cursor !== undefined) {
      query["next_token"] = input.cursor;
    }

    if (input.limit !== undefined) {
      query["max_results"] = String(input.limit);
    }

    const result = object(
      await (options.auth.accessToken?.trim() ? request : appRequest())(
        "/2/tweets/search/recent",
        context,
        undefined,
        query,
      ),
    );

    const items = (result["data"] === undefined ? [] : array(result["data"])).flatMap((entry) => {
      const row = object(entry);

      const id = string(row["id"]);

      if (row["conversation_id"] !== post.postId)
        throw new SocialError({
          code: "unauthorized",
          operation: "comments.read",
          message: "X returned a post from a different conversation.",
        });

      // The conversation root shares its own conversation_id; it is not a reply.
      if (id === post.postId) return [];

      const references =
        (row["referenced_posts"] ?? row["referenced_tweets"]) === undefined
          ? undefined
          : array(row["referenced_posts"] ?? row["referenced_tweets"]).map((reference) => {
              const item = object(reference);

              return { type: string(item["type"]), id: string(item["id"]) };
            });

      const counts =
        row["public_metrics"] === undefined ? undefined : object(row["public_metrics"]);

      const metrics =
        counts === undefined
          ? undefined
          : Object.fromEntries(
              Object.keys(counts).flatMap((name) => {
                const value = optionalNumber(counts[name]);

                return value === undefined ? [] : [[name, value]];
              }),
            );

      const itemFields = definedFields({
        ...publicFields(row, replyFields),
        referenced_tweets: references,
        public_metrics: metrics,
      });

      return [itemFields];
    });

    const meta = result["meta"] === undefined ? {} : object(result["meta"]);

    const nextCursor = optionalString(meta["next_token"]);

    if (nextCursor === undefined) return { items };

    return { items, nextCursor };
  }

  async function pageRequest(
    path: string,
    account: ConnectedAccountRef,
    input: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
    context: AdapterOperationContext,
    query: Record<string, string> = {},
    fields = "id,name,username,description,created_at,public_metrics",
    resource: "users" | "tweets" = "users",
  ): Promise<Page<JsonObject>> {
    authorize(account, context);

    const isTweets = resource === "tweets";

    const minLimit = /^\/2\/users\/[^/]+\/(tweets|mentions|liked_tweets)$/.test(path) ? 5 : 1;

    const maxLimit = /\/(followers|following|muting|blocking)$/.test(path) ? 1000 : 100;

    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < minLimit || input.limit > maxLimit)
    )
      throw new SocialError({
        code: "invalid_input",
        operation: path,
        message: `X limits must be integers from ${minLimit} through ${maxLimit}.`,
      });

    const result = object(
      await readRequest(path)(path, context, undefined, {
        ...query,
        ...(isTweets
          ? {
              "tweet.fields":
                "id,text,author_id,created_at,conversation_id,public_metrics,referenced_tweets,attachments",
              expansions: "author_id,referenced_tweets.id,attachments.media_keys",
              "user.fields": fields,
              "media.fields": "media_key,type,url,preview_image_url,duration_ms,height,width",
            }
          : path.endsWith("/owned_lists") || path.endsWith("/pinned_lists")
            ? { "list.fields": fields }
            : fields
              ? { "user.fields": fields }
              : {}),
        ...definedFields({ pagination_token: input.cursor, max_results: input.limit?.toString() }),
      }),
    );

    const items = (result["data"] === undefined ? [] : array(result["data"])).map(object);

    const meta = result["meta"] === undefined ? {} : object(result["meta"]);

    const nextCursor = optionalString(meta["next_token"]);

    return {
      items,
      ...definedFields({
        nextCursor,
        metadata:
          result["includes"] === undefined ? undefined : { includes: object(result["includes"]) },
      }),
    };
  }

  async function getAccountMetrics(
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<readonly MetricValue[]> {
    authorize(account, context);

    const result = object(
      await request(`/2/users/${encodeURIComponent(account.accountId)}`, context, undefined, {
        "user.fields": "id,public_metrics",
      }),
    );

    const data = object(result["data"]);

    const id = optionalString(data["id"]);

    if (id !== account.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation: "analytics.read",
        message: "X returned metrics for a different account.",
      });

    const counts = data["public_metrics"] === undefined ? {} : object(data["public_metrics"]);

    const fields = ["followers_count", "following_count", "tweet_count", "listed_count"] as const;

    const metrics: readonly MetricValue[] = fields.flatMap((name) => {
      const value = optionalNumber(
        name === "tweet_count" ? (counts["post_count"] ?? counts[name]) : counts[name],
      );

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
              source: "X API v2",
            },
          ];
    });

    return normalizeMetrics(metrics);
  }

  async function validateReplyParent(
    ref: CommentRef,
    context: AdapterOperationContext,
  ): Promise<void> {
    authorize(ref, context);

    requireUserToken("comments.write");

    const parent = object(
      object(
        await request(`/2/tweets/${encodeURIComponent(ref.commentId)}`, context, undefined, {
          "tweet.fields": "conversation_id",
        }),
      )["data"],
    );

    if (parent["id"] !== ref.commentId)
      throw new SocialError({
        code: "unauthorized",
        operation: "comments.write",
        message: "X did not return the declared reply parent.",
      });

    if (ref.postId !== ref.commentId) {
      const root = object(
        object(
          await request(`/2/tweets/${encodeURIComponent(ref.postId)}`, context, undefined, {
            "tweet.fields": "conversation_id",
          }),
        )["data"],
      );

      if (
        root["id"] !== ref.postId ||
        (isString(parent["conversation_id"]) &&
          parent["conversation_id"] !== root["conversation_id"])
      )
        throw new SocialError({
          code: "unauthorized",
          operation: "comments.write",
          message: "Reply parent does not belong to the declared X conversation.",
        });
    }
  }

  async function uploadImage(
    media: MediaAttachment,
    context: AdapterOperationContext,
  ): Promise<string> {
    requireUserToken("media.upload");

    if (
      media.source.kind !== "blob" ||
      media.kind !== "image" ||
      media.source.blob.size > 5 * 1024 * 1024
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: "This X slice uploads image Blobs up to 5 MiB.",
      });

    const body = new FormData();
    body.set("media", media.source.blob, media.filename ?? "image");
    body.set("media_category", "tweet_image");

    let result: JsonValue;

    try {
      result = await http({
        decodeErrorBody: providerErrorDecoder("https://api.x.com", "/2/media/upload"),
        url: new URL("https://api.x.com/2/media/upload"),
        method: "POST",
        headers: { Authorization: `Bearer ${options.auth.accessToken}` },
        body,
        timeoutMs: remainingBudget(context),
        ...definedFields({ signal: context.signal }),
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      throw mediaHttpError(error);
    }

    const data = object(object(result)["data"]);

    if (data["processing_info"] && object(data["processing_info"])["state"] !== "succeeded")
      throw new SocialError({
        code: "media_error",
        operation: "media.upload",
        message: "X media processing is not complete. No post was created.",
      });

    return string(data["id"]);
  }

  // X recommends segments at or below 5 MB; 4 MiB keeps 16 GiB within indices 0–9999.
  const xChunkBytes = 4 * 1024 * 1024;

  const xMaxVideoBytes = 17_179_869_184;

  const xMaxGifBytes = 15 * 1024 * 1024;

  const xMaxAltTextLength = 1000;

  const xMaxStatusPolls = 30;

  type XChunkedCategory = "tweet_video" | "tweet_gif";

  /** `media_category` values the chunked INIT accepts (OpenAPI 2.173). */
  type XUploadCategory = XChunkedCategory | "dm_image" | "dm_gif" | "dm_video" | "subtitles";

  type XProcessing = { state: string; checkAfterSecs: number };

  function chunkedCategory(media: MediaAttachment): XChunkedCategory | undefined {
    if (media.source.kind !== "blob") return undefined;

    if (media.kind === "video" && xVideoMimeTypes.has(media.mimeType ?? "")) return "tweet_video";

    if (media.kind === "image" && media.mimeType === "image/gif") return "tweet_gif";

    return undefined;
  }

  function chunkedLimits(media: MediaAttachment, category: XChunkedCategory): void {
    const size = media.source.kind === "blob" ? media.source.blob.size : 0;

    const maxBytes = category === "tweet_video" ? xMaxVideoBytes : xMaxGifBytes;

    if (size <= 0 || size > maxBytes)
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message:
          category === "tweet_video"
            ? "X video uploads require a non-empty MP4, QuickTime, or WebM Blob up to 16 GiB."
            : "X GIF uploads require a non-empty GIF Blob up to 15 MiB.",
      });
  }

  function mediaHttpError(error: HttpError): SocialError {
    if (error.data?.code === "usage-capped")
      return new SocialError({
        code: "billing_required",
        operation: "media.upload",
        message: "X usage is capped. Check credits and spending limits before retrying.",
        upstreamStatus: error.status,
        upstreamCode: "usage-capped",
        retryDisposition: { kind: "never" },
      });

    if (error.kind === "cancelled")
      return new SocialError({
        code: "cancelled",
        operation: "media.upload",
        message: "X media upload was cancelled before completion.",
        upstreamStatus: error.status,
      });

    if (error.kind === "timeout")
      return new SocialError({
        code: "timeout",
        operation: "media.upload",
        message: "X media upload exceeded its elapsed budget. Reconcile before retrying.",
        upstreamStatus: error.status,
        retryDisposition: { kind: "never" },
      });

    if (error.status === 401)
      return new SocialError({
        code: "reconnect_required",
        operation: "media.upload",
        message: "X rejected the media upload credentials. Reconnect before retrying.",
        upstreamStatus: error.status,
        retryDisposition: { kind: "after-reconnect" },
      });

    if (error.status === 429)
      return new SocialError({
        code: "rate_limited",
        operation: "media.upload",
        message: "X rate-limited the media upload.",
        upstreamStatus: error.status,
        retryDisposition:
          error.retryAfterMs === undefined
            ? { kind: "never" }
            : { kind: "after-delay", delayMs: error.retryAfterMs },
      });

    if (error.status === 413)
      return new SocialError({
        code: "media_error",
        operation: "media.upload",
        message: "Media chunk rejected by X (payload too large).",
        upstreamStatus: error.status,
        retryDisposition: { kind: "never" },
      });

    return new SocialError({
      code: "media_error",
      operation: "media.upload",
      message: error.message,
      upstreamStatus: error.status,
      retryDisposition: { kind: "never" },
    });
  }

  async function chunkedPost(
    path: string,
    body: JsonObject | undefined,
    context: AdapterOperationContext,
  ): Promise<JsonObject> {
    requireUserToken("media.upload");

    let result: JsonValue;

    try {
      result = await http({
        decodeErrorBody: providerErrorDecoder("https://api.x.com", "/2/media/upload"),
        url: new URL(`https://api.x.com${path}`),
        method: "POST",
        headers:
          body === undefined
            ? { Authorization: `Bearer ${options.auth.accessToken}` }
            : {
                Authorization: `Bearer ${options.auth.accessToken}`,
                "Content-Type": "application/json",
              },
        timeoutMs: remainingBudget(context),
        ...definedFields({
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: context.signal,
        }),
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      throw mediaHttpError(error);
    }

    return object(object(result)["data"]);
  }

  async function appendChunk(
    mediaId: string,
    segmentIndex: number,
    chunk: Blob,
    context: AdapterOperationContext,
  ): Promise<void> {
    requireUserToken("media.upload");

    const body = new FormData();
    body.set("segment_index", String(segmentIndex));
    body.set("media", chunk, `chunk-${segmentIndex}`);

    try {
      await http({
        decodeErrorBody: providerErrorDecoder("https://api.x.com", "/2/media/upload"),
        url: new URL(`https://api.x.com/2/media/upload/${encodeURIComponent(mediaId)}/append`),
        method: "POST",
        headers: { Authorization: `Bearer ${options.auth.accessToken}` },
        body,
        timeoutMs: remainingBudget(context),
        ...definedFields({ signal: context.signal }),
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      throw mediaHttpError(error);
    }
  }

  async function readMediaStatus(
    mediaId: string,
    context: AdapterOperationContext,
  ): Promise<XProcessing> {
    requireUserToken("media.upload");

    let result: JsonValue;

    try {
      result = await http({
        decodeErrorBody: providerErrorDecoder("https://api.x.com", "/2/media/upload"),
        url: new URL(
          `https://api.x.com/2/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
        ),
        method: "GET",
        headers: { Authorization: `Bearer ${options.auth.accessToken}` },
        timeoutMs: remainingBudget(context),
        ...definedFields({ signal: context.signal }),
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      throw mediaHttpError(error);
    }

    const data = object(object(result)["data"]);

    const processing = data["processing_info"];

    if (processing === undefined) return { state: "succeeded", checkAfterSecs: 0 };

    return processingState(object(processing));
  }

  function processingState(info: JsonObject): XProcessing {
    const checkAfter = optionalNumber(info["check_after_secs"]);

    return {
      state: optionalString(info["state"]) ?? "pending",
      // X always sends check_after_secs while processing; a missing value must not spin the poll.
      checkAfterSecs:
        checkAfter !== undefined && Number.isFinite(checkAfter) && checkAfter >= 0 ? checkAfter : 1,
    };
  }

  function uploadCancelled(): SocialError {
    return new SocialError({
      code: "cancelled",
      operation: "media.upload",
      message: "X media upload was cancelled before completion.",
    });
  }

  function throwIfUploadCancelled(context: AdapterOperationContext): void {
    if (context.signal?.aborted) throw uploadCancelled();
  }

  /** Waits for X's processing hint without outliving the shared operation budget. */
  function processingWait(milliseconds: number, context: AdapterOperationContext): Promise<void> {
    throwIfUploadCancelled(context);

    if (milliseconds <= 0) return Promise.resolve();

    if (milliseconds >= remainingBudget(context))
      throw new SocialError({
        code: "timeout",
        operation: "media.upload",
        message:
          "X media processing needs longer than the remaining elapsed budget. No post was created.",
        retryDisposition: { kind: "never" },
      });

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(uploadCancelled());
      };

      const timer = setTimeout(() => {
        context.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);

      context.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function uploadVideoOrGif(
    media: MediaAttachment,
    context: AdapterOperationContext,
    additionalOwners?: readonly string[],
  ): Promise<string> {
    try {
      return await chunkedUpload(media, context, additionalOwners);
    } catch (error) {
      // Malformed upload responses fail before any post request, so they are definite failures.
      if (error instanceof HttpError) throw mediaHttpError(error);

      throw error;
    }
  }

  async function chunkedUpload(
    media: MediaAttachment,
    context: AdapterOperationContext,
    additionalOwners?: readonly string[],
  ): Promise<string> {
    requireUserToken("media.upload");

    const category = chunkedCategory(media);

    if (category === undefined || media.source.kind !== "blob")
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message:
          "X chunked upload requires a video/mp4, video/quicktime, video/webm, or image/gif Blob.",
      });

    chunkedLimits(media, category);

    return uploadChunks(
      {
        blob: media.source.blob,
        category,
        // chunkedCategory returns tweet_video only for a listed video MIME type.
        mediaType: category === "tweet_video" ? (media.mimeType ?? "video/mp4") : "image/gif",
        ...definedFields({ additionalOwners }),
      },
      context,
    );
  }

  /** INIT, APPEND, FINALIZE, and a bounded STATUS poll for one Blob. Callers validate limits. */
  async function uploadChunks(
    upload: {
      readonly blob: Blob;
      readonly category: XUploadCategory;
      readonly mediaType: string;
      readonly additionalOwners?: readonly string[];
    },
    context: AdapterOperationContext,
  ): Promise<string> {
    requireUserToken("media.upload");

    const { blob, category } = upload;

    const totalBytes = blob.size;

    const initialized = await chunkedPost(
      "/2/media/upload/initialize",
      {
        media_category: category,
        media_type: upload.mediaType,
        total_bytes: totalBytes,
        ...definedFields({
          additional_owners:
            upload.additionalOwners === undefined ? undefined : [...upload.additionalOwners],
        }),
      },
      context,
    );

    const mediaId = string(initialized["id"]);

    const segmentCount = Math.ceil(totalBytes / xChunkBytes);

    let finalized: JsonObject;

    try {
      for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
        throwIfUploadCancelled(context);

        const start = segmentIndex * xChunkBytes;

        const end = Math.min(start + xChunkBytes, totalBytes);

        const chunk = blob.slice(start, end, upload.mediaType);

        await appendChunk(mediaId, segmentIndex, chunk, context);
      }

      finalized = await chunkedPost(
        `/2/media/upload/${encodeURIComponent(mediaId)}/finalize`,
        undefined,
        context,
      );
    } catch (error) {
      const failure = error instanceof HttpError ? mediaHttpError(error) : error;

      if (failure instanceof SocialError)
        throw new SocialError({
          ...failure.toJSON(),
          retryDisposition:
            failure.code === "timeout" ||
            failure.code === "cancelled" ||
            (failure.code === "media_error" &&
              (failure.upstreamStatus === undefined || failure.upstreamStatus >= 500))
              ? { kind: "reconcile-first" }
              : failure.retryDisposition,
          details: { ...failure.details, mediaId },
        });
      throw failure;
    }

    const finalizedId = optionalString(finalized["id"]) ?? mediaId;

    const processing = finalized["processing_info"];

    if (processing === undefined) return finalizedId;

    let { state, checkAfterSecs } = processingState(object(processing));

    for (let poll = 0; ; poll++) {
      if (state === "succeeded") return finalizedId;

      if (state === "failed")
        throw new SocialError({
          code: "media_error",
          operation: "media.upload",
          message: "X failed to process the uploaded media. No post was created.",
          retryDisposition: { kind: "never" },
        });

      if (poll >= xMaxStatusPolls) break;

      try {
        await processingWait(checkAfterSecs * 1000, context);
        ({ state, checkAfterSecs } = await readMediaStatus(finalizedId, context));
      } catch (error) {
        const failure = error instanceof HttpError ? mediaHttpError(error) : error;

        if (failure instanceof SocialError)
          throw new SocialError({
            ...failure.toJSON(),
            retryDisposition:
              failure.code === "billing_required"
                ? failure.retryDisposition
                : { kind: "reconcile-first" },
            details: { ...failure.details, mediaId: finalizedId },
          });
        throw failure;
      }
    }

    throw new SocialError({
      code: "timeout",
      operation: "media.upload",
      message: "X media processing did not complete in time. Reconcile before retrying.",
      retryDisposition: { kind: "reconcile-first" },
      details: { mediaId: finalizedId },
    });
  }

  // POST /2/media/metadata attaches alt text to uploaded images and GIFs. Source, accessed
  // 2026-10-24: https://docs.x.com/x-api/media/create-media-metadata
  async function setAltText(
    mediaId: string,
    altText: string,
    context: AdapterOperationContext,
  ): Promise<void> {
    if ([...altText].length > xMaxAltTextLength)
      throw new SocialError({
        code: "invalid_input",
        operation: "media.metadata",
        message: `X alt text is limited to ${xMaxAltTextLength} characters.`,
      });

    try {
      object(
        await requireUserToken("media.metadata")("/2/media/metadata", context, {
          id: mediaId,
          metadata: { alt_text: { text: altText } },
        }),
      );
    } catch (error) {
      throw new SocialError({
        code:
          error instanceof SocialError && error.code !== "ambiguous_outcome"
            ? error.code
            : "media_error",
        operation: "media.metadata",
        message:
          "X did not confirm the image alt text, so no post was created. The uploaded media was not attached to a post.",
        ...definedFields({
          backend: error instanceof SocialError ? error.backend : undefined,
          correlationId: error instanceof SocialError ? error.correlationId : undefined,
          upstreamStatus: error instanceof SocialError ? error.upstreamStatus : undefined,
        }),
        retryDisposition:
          error instanceof SocialError && error.code !== "ambiguous_outcome"
            ? error.retryDisposition
            : { kind: "never" },
        cause: error,
      });
    }
  }

  async function uploadXMedia(
    media: MediaAttachment,
    context: AdapterOperationContext,
  ): Promise<string> {
    if (chunkedCategory(media) !== undefined) return uploadVideoOrGif(media, context);

    return uploadImage(media, context);
  }

  async function createPost(
    account: ConnectedAccountRef,
    text: string,
    context: AdapterOperationContext,
    extra: JsonObject = {},
    targetIndex = 0,
  ): Promise<DeliveryOutcome> {
    authorize(account, context);

    const result = object(
      await requireUserToken("posts.publish")("/2/tweets", context, { text, ...extra }),
    );

    const data = result["data"] ? object(result["data"]) : {};

    const id = optionalString(data["id"]);

    const base = { account, targetIndex, observedAt: now() };

    if (!id)
      return {
        ...base,
        state: "unknown",
        reason: "unmapped-state",
        diagnostic: "X create response lacks a native ID. Reconcile before retrying.",
      };

    return {
      ...base,
      state: "published",
      post: {
        kind: "platform-post",
        version: 1,
        backend: account.backend,
        platform: "x",
        accountId: account.accountId,
        postId: id,
      },
    };
  }

  // Shared plumbing for native v2 reads. Paths, limits, and auth follow X OpenAPI 2.173
  // (https://docs.x.com/openapi.json, checked 2026-11-04).
  // `app-or-user` is for app-level resources such as webhook configs: the app bearer when set.
  type XCredential = "user" | "user-or-app" | "app-or-user" | "app";

  const credentialRequest = (credential: XCredential, operation: string) =>
    credential === "app" || (credential === "app-or-user" && options.appBearerToken?.trim())
      ? appRequest()
      : credential === "user" || credential === "app-or-user"
        ? requireUserToken(operation)
        : options.auth.accessToken?.trim()
          ? request
          : appRequest();

  const invalid = (operation: string, message: string) =>
    new SocialError({ code: "invalid_input", operation, message });

  const requireId = (value: string, name: string, operation: string, pattern = xIdPattern) => {
    if (!pattern.test(value)) throw invalid(operation, `${name} is not a valid X ID.`);
  };

  const requireIds = (
    values: readonly string[],
    name: string,
    operation: string,
    pattern = xIdPattern,
  ) => {
    if (values.length < 1 || values.length > 100 || values.some((value) => !pattern.test(value)))
      throw invalid(operation, `${name} must contain 1-100 valid X IDs.`);
  };

  const defaultTweetFields =
    "id,text,author_id,created_at,conversation_id,public_metrics,referenced_tweets,attachments";

  const defaultUserFields = "id,name,username,description,created_at,public_metrics";

  const defaultMediaFields = "media_key,type,url,preview_image_url,duration_ms,height,width";

  const postFieldQuery = (fields: XPostFieldSelection | undefined) => ({
    "tweet.fields": fields?.tweetFields?.join(",") ?? defaultTweetFields,
    expansions:
      fields?.expansions?.join(",") ?? "author_id,referenced_tweets.id,attachments.media_keys",
    "user.fields": fields?.userFields?.join(",") ?? defaultUserFields,
    "media.fields": fields?.mediaFields?.join(",") ?? defaultMediaFields,
  });

  const userFieldQuery = (userFields: readonly XUserField[] | undefined) => ({
    "user.fields": userFields?.join(",") ?? defaultUserFields,
  });

  function pageFrom(result: JsonObject): Page<JsonObject> {
    const meta = result["meta"] === undefined ? {} : object(result["meta"]);

    const includes = result["includes"];

    const errors = result["errors"];

    // Chat event pages carry the key events needed to decrypt their messages.
    const keyEvents = meta["conversation_key_events"];

    return {
      items: result["data"] === undefined ? [] : array(result["data"]).map(object),
      ...definedFields({
        nextCursor: optionalString(meta["next_token"]),
        metadata:
          includes === undefined && errors === undefined && keyEvents === undefined
            ? undefined
            : {
                ...definedFields({
                  includes: includes === undefined ? undefined : object(includes),
                  errors: errors === undefined ? undefined : array(errors).map(object),
                  conversationKeyEvents: keyEvents === undefined ? undefined : array(keyEvents),
                }),
              },
      }),
    };
  }

  async function xRead(input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
    readonly path: string;
    readonly operation: string;
    readonly credential: XCredential;
    readonly query?: Record<string, string>;
  }): Promise<JsonObject> {
    authorize(input.account, input.context);

    return object(
      await credentialRequest(input.credential, input.operation)(
        input.path,
        input.context,
        undefined,
        input.query ?? {},
      ),
    );
  }

  async function xReadPage(
    input: Parameters<typeof xRead>[0] & {
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
      readonly minLimit: number;
      readonly maxLimit: number;
      readonly cursorParam?: "pagination_token" | "next_token";
    },
  ): Promise<Page<JsonObject>> {
    const { cursor, limit, minLimit, maxLimit, operation } = input;

    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < minLimit || limit > maxLimit)
    )
      throw invalid(
        operation,
        `X limits here must be integers from ${minLimit} through ${maxLimit}.`,
      );

    if (cursor !== undefined && !cursor.trim())
      throw invalid(operation, "Pass the nextCursor value from a previous page.");

    const nextToken = input.cursorParam === "next_token";

    return pageFrom(
      await xRead({
        ...input,
        query: {
          ...input.query,
          ...definedFields({
            max_results: limit?.toString(),
            pagination_token: nextToken ? undefined : cursor,
            next_token: nextToken ? cursor : undefined,
          }),
        },
      }),
    );
  }

  async function postCounts(
    scope: "recent" | "all",
    account: ConnectedAccountRef,
    counts: XPostCountsInput,
    context: AdapterOperationContext,
  ): Promise<XPostCounts> {
    const operation = `x.counts.${scope}`;

    if (!counts.query.trim() || counts.query.length > 4096)
      throw invalid(operation, "X count queries must contain 1-4096 characters.");

    for (const [name, value] of [
      ["startTime", counts.startTime],
      ["endTime", counts.endTime],
    ] as const)
      if (value !== undefined && !Number.isFinite(Date.parse(value)))
        throw invalid(operation, `${name} must be an ISO 8601 timestamp.`);

    for (const [name, value] of [
      ["sinceId", counts.sinceId],
      ["untilId", counts.untilId],
    ] as const)
      if (value !== undefined) requireId(value, name, operation);

    const result = await xRead({
      account,
      context,
      path: `/2/tweets/counts/${scope}`,
      operation,
      credential: scope === "all" ? "app" : "user-or-app",
      query: {
        query: counts.query,
        ...definedFields({
          start_time: counts.startTime,
          end_time: counts.endTime,
          since_id: counts.sinceId,
          until_id: counts.untilId,
          granularity: counts.granularity,
          next_token: counts.cursor,
        }),
      },
    });

    const meta = result["meta"] === undefined ? {} : object(result["meta"]);

    const buckets = (result["data"] === undefined ? [] : array(result["data"])).map((entry) => {
      const row = object(entry);

      // OpenAPI 2.173 names the count post_count; older responses use tweet_count.
      const count = optionalNumber(row["post_count"]) ?? optionalNumber(row["tweet_count"]);

      if (count === undefined)
        throw new HttpError("X count bucket lacks a count.", "invalid-response", true);

      return { start: string(row["start"]), end: string(row["end"]), count };
    });

    return {
      buckets,
      ...definedFields({
        totalCount:
          optionalNumber(meta["total_post_count"]) ?? optionalNumber(meta["total_tweet_count"]),
        nextCursor: optionalString(meta["next_token"]),
      }),
    };
  }

  function webhookConfig(value: JsonField): XWebhookConfig {
    const row = object(value);

    const valid = optionalBoolean(row["valid"]);

    if (valid === undefined)
      throw new HttpError("X webhook config lacks its valid flag.", "invalid-response", true);

    return {
      id: string(row["id"]),
      url: string(row["url"]),
      valid,
      ...definedFields({ createdAt: optionalString(row["created_at"]) }),
    };
  }

  function bookmarkFolder(value: JsonField): XBookmarkFolder {
    const row = object(value);

    return { id: string(row["id"]), name: string(row["name"]) };
  }

  /** Maps a failed DM write. A dispatched write without a clear answer may have been delivered. */
  function dmHttpError(
    error: HttpError,
    operation: string,
    context: AdapterOperationContext,
  ): SocialError {
    const base = {
      operation,
      backend: context.backendInstance,
      correlationId: context.correlationId,
      ...definedFields({ upstreamStatus: error.status }),
    };

    const refusal = error.data?.dmRefusal;

    if (refusal !== undefined && refusal.startsWith("dm-"))
      return new SocialError({
        ...base,
        code: xDmRefusalCode(`dm-${refusal.slice(3)}`),
        upstreamCode: refusal,
        message: `X refused the Direct Message (${refusal}). Nothing was sent.`,
        retryDisposition: { kind: "never" },
      });

    if (error.data?.code === "usage-capped")
      return new SocialError({
        ...base,
        code: "billing_required",
        upstreamCode: "usage-capped",
        message: "X usage is capped. Check credits and spending limits before retrying.",
        retryDisposition: { kind: "never" },
      });

    if (error.dispatched && (error.kind !== "http" || (error.status ?? 0) >= 500))
      return new SocialError({
        ...base,
        code: "ambiguous_outcome",
        message: "X did not confirm the Direct Message. Read the conversation before retrying.",
        retryDisposition: { kind: "reconcile-first" },
      });

    const status = error.status;

    return new SocialError({
      ...base,
      code:
        error.kind === "cancelled"
          ? "cancelled"
          : error.kind === "timeout"
            ? "timeout"
            : status === 429
              ? "rate_limited"
              : status === 401
                ? "reconnect_required"
                : status === 402
                  ? "billing_required"
                  : status === 403
                    ? "missing_permission"
                    : status === 404
                      ? "not_found"
                      : "upstream_failure",
      message: error.message,
      retryDisposition:
        status === 401
          ? { kind: "after-reconnect" }
          : status === 429 && error.retryAfterMs !== undefined
            ? { kind: "after-delay", delayMs: error.retryAfterMs }
            : { kind: "never" },
    });
  }

  /** Sends one DM write once, decoding X's `dm-` refusal problem types. */
  async function dmWrite(
    path: string,
    body: JsonObject,
    context: AdapterOperationContext,
    operation: string,
  ): Promise<JsonObject> {
    requireUserToken(operation);

    const decode = providerErrorDecoder("https://api.x.com", path);

    try {
      return object(
        await http({
          url: new URL(`https://api.x.com${path}`),
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.auth.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          maxAttempts: 1,
          timeoutMs: remainingBudget(context),
          decodeErrorBody: (value, status) => {
            const refusal = status === 403 ? xDmRefusal(value) : undefined;

            return refusal === undefined
              ? decode(value, status)
              : { code: "x-dm-refused", dmRefusal: refusal };
          },
          ...definedFields({ signal: context.signal }),
        }),
      );
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      throw dmHttpError(error, operation, context);
    }
  }

  /** Reads one binary response into memory, refusing bodies larger than `maxBytes`. */
  async function downloadBytes(
    path: string,
    maxBytes: number,
    context: AdapterOperationContext,
    operation: string,
    credential: "user" | "app" | "none" = "user",
  ): Promise<XDownloadedMedia> {
    if (credential === "user") requireUserToken(operation);

    if (credential === "app") appRequest();

    const bearer = credential === "user" ? options.auth.accessToken : options.appBearerToken;

    const url = path.startsWith("https://") ? path : `https://api.x.com${path}`;

    const failure = (code: "cancelled" | "timeout" | "media_error", message: string) =>
      new SocialError({ code, operation, message, retryDisposition: { kind: "never" } });

    // An already-cancelled caller never dispatches the authenticated download.
    if (context.signal?.aborted) throw failure("cancelled", "The download was cancelled.");

    const controller = new AbortController();

    const onAbort = () => controller.abort();

    context.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(onAbort, remainingBudget(context));

    try {
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        method: "GET",
        headers: credential === "none" ? {} : { Authorization: `Bearer ${bearer}` },
        redirect: "manual",
        signal: controller.signal,
      });

      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);

        const status = response.status;

        throw new SocialError({
          code:
            status === 401
              ? "reconnect_required"
              : status === 403
                ? "missing_permission"
                : status === 404
                  ? "not_found"
                  : status === 429
                    ? "rate_limited"
                    : "upstream_failure",
          operation,
          message: `X media download failed with HTTP ${status}. Redirects are not followed.`,
          upstreamStatus: status,
          retryDisposition: status === 401 ? { kind: "after-reconnect" } : { kind: "never" },
        });
      }

      const declared = Number(response.headers.get("content-length"));

      if (Number.isFinite(declared) && declared > maxBytes) {
        void response.body?.cancel().catch(() => undefined);

        throw failure("media_error", `X media is larger than maxBytes (${maxBytes}).`);
      }

      const bytes =
        response.body === null
          ? new Uint8Array()
          : await readBinary(response.body, maxBytes, controller.signal);

      return {
        bytes,
        ...definedFields({ contentType: response.headers.get("content-type") ?? undefined }),
      };
    } catch (error) {
      if (error instanceof SocialError) throw error;

      if (error instanceof HttpError && error.kind === "invalid-input")
        throw failure("media_error", `X media is larger than maxBytes (${maxBytes}).`);

      if (controller.signal.aborted)
        throw context.signal?.aborted
          ? failure("cancelled", "X media download was cancelled.")
          : failure("timeout", "X media download exceeded its elapsed budget.");

      throw new SocialError({
        code: "upstream_failure",
        operation,
        message: "X media download failed before a response arrived.",
        retryDisposition: { kind: "never" },
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", onAbort);
    }
  }

  const requireAdditionalOwners = (owners: readonly string[] | undefined, operation: string) => {
    if (
      owners !== undefined &&
      (owners.length < 1 || owners.length > 100 || owners.some((id) => !xIdPattern.test(id)))
    )
      throw invalid(operation, "additionalOwners must list 1-100 numeric X user IDs.");
  };

  const requireWindow = (startTime: string, endTime: string, operation: string) => {
    const start = Date.parse(startTime);

    const end = Date.parse(endTime);

    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
      throw invalid(operation, "startTime and endTime must be ISO 8601 timestamps, start first.");
  };

  const dmMediaLimits = {
    image: { category: "dm_image", maxBytes: 5 * 1024 * 1024 },
    gif: { category: "dm_gif", maxBytes: 15 * 1024 * 1024 },
    video: { category: "dm_video", maxBytes: 1024 * 1024 * 1024 },
  } as const;

  const numericMetrics = (value: JsonField) => {
    if (value === undefined) return {};

    const metrics: Record<string, number> = {};

    for (const [name, entry] of Object.entries(object(value))) {
      const count = optionalNumber(entry);

      if (count !== undefined) metrics[name] = count;
    }

    return metrics;
  };

  const broadcastIdPattern = /^[a-zA-Z0-9]{1,24}$/;

  const chatConversationPattern = /^([0-9]{1,19}|[0-9]{1,19}-[0-9]{1,19}|g[0-9]{1,19})$/;

  /** Serializes typed Article blocks and entities into X's DraftJS `content_state`. */
  function articleContentState(
    blocks: readonly XArticleBlock[],
    entities: readonly XArticleEntity[],
  ): JsonObject {
    const operation = "x.articles.draft";

    if (blocks.length === 0) throw invalid(operation, "An Article needs at least one block.");

    const inRange = (offset: number, length: number, text: string) =>
      Number.isSafeInteger(offset) &&
      Number.isSafeInteger(length) &&
      offset >= 0 &&
      length >= 0 &&
      offset + length <= text.length;

    const wireBlocks = blocks.map((block) => {
      for (const style of block.inlineStyles ?? [])
        if (!inRange(style.offset, style.length, block.text))
          throw invalid(operation, "An inline style range falls outside its block text.");

      for (const range of block.entityRanges ?? [])
        if (
          !inRange(range.offset, range.length, block.text) ||
          !Number.isSafeInteger(range.entity) ||
          range.entity < 0 ||
          range.entity >= entities.length
        )
          throw invalid(
            operation,
            "An entity range must point at a listed entity inside the text.",
          );

      return {
        text: block.text,
        type: block.type,
        ...definedFields({
          key: block.key,
          inline_style_ranges: block.inlineStyles?.map((style) => ({
            offset: style.offset,
            length: style.length,
            style: style.style,
          })),
          entity_ranges: block.entityRanges?.map((range) => ({
            key: range.entity,
            offset: range.offset,
            length: range.length,
          })),
        }),
      };
    });

    const wireEntities = entities.map((entity, index) => {
      const value = (type: string, mutability: "mutable" | "immutable", data: JsonObject) => ({
        key: String(index),
        value: { type, mutability, data },
      });

      switch (entity.kind) {
        case "link":
          if (!isWebUrl(entity.url))
            throw invalid(operation, "Article links must be http or https URLs.");

          return value("link", "mutable", { url: entity.url });
        case "post":
          requireId(entity.postId, "postId", operation);

          return value("post", "immutable", { post_id: entity.postId });
        case "image":
          if (
            entity.media.length === 0 ||
            entity.media.some((item) => !xIdPattern.test(item.mediaId))
          )
            throw invalid(operation, "Article images need uploaded numeric media IDs.");

          return value("image", "immutable", {
            media_items: entity.media.map((item) => ({
              media_category: item.mediaCategory,
              media_id: item.mediaId,
            })),
            ...definedFields({ caption: entity.caption }),
          });
        case "markdown":
          if (!entity.markdown.trim()) throw invalid(operation, "Markdown entities need content.");

          return value("markdown", "mutable", { markdown: entity.markdown });
        case "divider":
          return value("divider", "immutable", {});
        case "latex":
          return value("latex", "immutable", {});
        default: {
          const _exhaustive: never = entity;

          throw invalid(operation, `Unknown Article entity ${String(_exhaustive)}.`);
        }
      }
    });

    return { blocks: wireBlocks, entities: wireEntities };
  }

  const callIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

  const rfc3339 =
    /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

  const scheduledCallBody = (
    call: Partial<XScheduledCallInput>,
    maxInvitees: number,
    operation: string,
  ): JsonObject => {
    if (call.startTime !== undefined && !rfc3339.test(call.startTime))
      throw invalid(operation, "startTime must be an RFC 3339 time.");

    if (call.title !== undefined && [...call.title].length > 100)
      throw invalid(operation, "Call titles are limited to 100 characters.");

    if (call.description !== undefined && [...call.description].length > 1000)
      throw invalid(operation, "Call descriptions are limited to 1,000 characters.");

    if (
      call.durationMinutes !== undefined &&
      (!Number.isSafeInteger(call.durationMinutes) ||
        call.durationMinutes < 1 ||
        call.durationMinutes > 44_640)
    )
      throw invalid(operation, "durationMinutes must be an integer from 1 through 44640.");

    if (
      call.inviteeIds !== undefined &&
      (call.inviteeIds.length > maxInvitees || call.inviteeIds.some((id) => !xIdPattern.test(id)))
    )
      throw invalid(operation, `inviteeIds lists up to ${maxInvitees} numeric user IDs.`);

    if (call.recurrence !== undefined && (!call.recurrence.trim() || call.recurrence.length > 500))
      throw invalid(operation, "recurrence must be an RFC 5545 RRULE of up to 500 characters.");

    return definedFields({
      start_time: call.startTime,
      title: call.title,
      description: call.description,
      duration_minutes: call.durationMinutes,
      invitee_ids: call.inviteeIds === undefined ? undefined : [...call.inviteeIds],
      notify_invitees: call.notifyInvitees,
      recurrence: call.recurrence,
      time_zone: call.timeZone,
    });
  };

  const callOccurrence = (occurrence: XCallOccurrence, operation: string): JsonObject => {
    if (
      occurrence.occurrenceStartTime !== undefined &&
      !rfc3339.test(occurrence.occurrenceStartTime)
    )
      throw invalid(operation, "occurrenceStartTime must be an RFC 3339 time.");

    return definedFields({
      scope: occurrence.scope,
      occurrence_start_time: occurrence.occurrenceStartTime,
    });
  };

  const botFields = (
    handle: string | undefined,
    displayName: string | undefined,
    operation: string,
  ) => {
    if (handle !== undefined && !/^[A-Za-z0-9_]{5,15}$/.test(handle))
      throw invalid(operation, "Bot handles are 5-15 letters, digits, or underscores.");

    if (displayName !== undefined && (!displayName.trim() || [...displayName].length > 50))
      throw invalid(operation, "Bot display names are 1-50 characters.");
  };

  const botWithToken = (value: JsonValue, operation: string): XBotWithToken => {
    const data = isJsonObject(value) ? value["data"] : undefined;

    const row = isJsonObject(data) ? data : {};

    const id = optionalString(row["id"]);

    const token = optionalString(row["token"]);

    if (id === undefined || token === undefined)
      throw new SocialError({
        code: "ambiguous_outcome",
        operation,
        message: "X did not return the bot token. Rotate the token before using the bot.",
        retryDisposition: { kind: "reconcile-first" },
      });

    const scopes = row["scopes"];

    return {
      id,
      token,
      ...definedFields({
        username: optionalString(row["username"]),
        tokenExpiresAtMs: tokenExpiry(row["token_expires_at_ms"]),
        scopes: isJsonArray(scopes) ? scopes.filter(isString) : undefined,
      }),
    };
  };

  /** X documents `token_expires_at_ms` as integer epoch milliseconds; the public field is a string. */
  const tokenExpiry = (value: JsonField) => {
    if (isFiniteNumber(value))
      return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;

    return isString(value) && /^[0-9]{1,16}$/.test(value) ? value : undefined;
  };

  const chatGroupPattern = /^g[0-9]{1,19}$/;

  const chatDirectPattern = /^([0-9]{1,19}|[0-9]{1,19}-[0-9]{1,19})$/;

  const chatInviteTokenPattern = /^[A-Za-z0-9_-]{10}$/;

  const xChatMediaChunkBytes = 4 * 1024 * 1024;

  const chatSignatures = (value: readonly XChatActionSignature[] | undefined) =>
    value === undefined ? undefined : [...value];

  const wireChatKeys = (keys: readonly XChatParticipantKey[]) =>
    keys.map((key) => ({
      user_id: key.userId,
      encrypted_conversation_key: key.encryptedConversationKey,
      public_key_version: key.publicKeyVersion,
    }));

  const chatConversationId = (data: JsonObject, operation: string) => {
    const id = optionalString(data["conversation_id"]);

    if (id === undefined)
      throw new SocialError({
        code: "ambiguous_outcome",
        operation,
        message: "X did not return the conversation ID. List the inbox before retrying.",
        retryDisposition: { kind: "reconcile-first" },
      });

    return id;
  };

  /** One X Chat write. With `confirm`, X must report that field with the expected value. */
  async function chatWrite(input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
    readonly operation: string;
    readonly path: string;
    readonly method: "POST" | "PUT" | "DELETE";
    readonly body?: JsonObject;
    readonly confirm?: readonly [string, boolean];
  }): Promise<JsonObject> {
    authorize(input.account, input.context);

    const result = await requireUserToken(input.operation)(
      input.path,
      input.context,
      input.body,
      {},
      input.method,
    );

    const data = isJsonObject(result) ? result["data"] : undefined;

    if (
      !isJsonObject(data) ||
      (input.confirm !== undefined && data[input.confirm[0]] !== input.confirm[1])
    )
      throw new SocialError({
        code: "ambiguous_outcome",
        operation: input.operation,
        message: "X did not confirm the chat change. Read the conversation before retrying.",
        retryDisposition: { kind: "reconcile-first" },
      });

    return data;
  }

  const streamSourcePattern = /^[a-zA-Z0-9]{1,32}$/;

  const broadcastExtras = (
    broadcast: Pick<XScheduledBroadcastInput, "isLocked" | "thumbnailMediaId">,
    operation: string,
  ) => {
    if (broadcast.thumbnailMediaId !== undefined)
      requireId(broadcast.thumbnailMediaId, "thumbnailMediaId", operation);

    return definedFields({
      is_locked: broadcast.isLocked,
      thumbnail_media_id: broadcast.thumbnailMediaId,
    });
  };

  const broadcastRecurrence = (
    recurrence: NonNullable<XScheduledBroadcastInput["recurrence"]>,
    operation: string,
  ) => {
    if (!Number.isSafeInteger(recurrence.repeats) || recurrence.repeats < 1)
      throw invalid(operation, "recurrence.repeats must be a positive integer.");

    return { frequency: recurrence.frequency, repeats: String(recurrence.repeats) };
  };

  const requireBroadcastId = (value: string, operation: string) =>
    requireId(value, "broadcastId", operation, broadcastIdPattern);

  async function broadcastWrite(
    path: string,
    body: JsonObject | undefined,
    method: "POST" | "PUT" | "DELETE",
    context: AdapterOperationContext,
    operation: string,
  ): Promise<JsonObject> {
    const result = await requireUserToken(operation)(path, context, body, {}, method);

    const data = isJsonObject(result) ? result["data"] : undefined;

    // The request was dispatched, so an unreadable envelope leaves the change uncertain.
    if (!isJsonObject(data))
      throw new SocialError({
        code: "ambiguous_outcome",
        operation,
        message: "X did not confirm the broadcast change. Read its state before retrying.",
        retryDisposition: { kind: "reconcile-first" },
      });

    return data;
  }

  const epochMs = (value: string, name: string, operation: string) => {
    const parsed = Date.parse(value);

    if (!Number.isFinite(parsed) || parsed < 0)
      throw invalid(operation, `${name} must be an ISO 8601 timestamp.`);

    return String(parsed);
  };

  const streamBearer = (name: string): string => {
    const bearerToken = options.appBearerToken;

    if (!bearerToken?.trim())
      throw new SocialError({
        code: "missing_permission",
        operation: "streams.read",
        message: `The X ${name} requires an app-only bearer token. Configure appBearerToken.`,
      });

    return bearerToken;
  };

  const complianceJobFields =
    "created_at,download_expires_at,download_url,id,name,resumable,status,type,upload_expires_at,upload_url";

  const defaultNewsFields: readonly XNewsField[] = [
    "id",
    "name",
    "category",
    "summary",
    "hook",
    "keywords",
    "contexts",
    "disclaimer",
    "updated_at",
  ];

  function complianceJob(value: JsonField, operation: string): XComplianceJob {
    const row = isJsonObject(value) ? value : {};

    const id = optionalString(row["id"]);

    const type = row["type"];

    const status = optionalString(row["status"]);

    if (id === undefined || status === undefined || (type !== "tweets" && type !== "users"))
      throw new SocialError({
        code: "upstream_failure",
        operation,
        message: "X returned a compliance job without an id, type, or status.",
        retryDisposition: { kind: "never" },
      });

    return {
      id,
      type,
      status,
      ...definedFields({
        name: optionalString(row["name"]),
        resumable: optionalBoolean(row["resumable"]),
        createdAt: optionalString(row["created_at"]),
        uploadUrl: optionalString(row["upload_url"]),
        uploadExpiresAt: optionalString(row["upload_expires_at"]),
        downloadUrl: optionalString(row["download_url"]),
        downloadExpiresAt: optionalString(row["download_expires_at"]),
      }),
    };
  }

  const signedComplianceUrl = (value: string | undefined, name: string, operation: string) => {
    let url: URL | undefined;

    try {
      url = value === undefined ? undefined : new URL(value);
    } catch {
      url = undefined;
    }

    if (url === undefined || url.protocol !== "https:" || url.username || url.password)
      throw invalid(operation, `${name} must be the HTTPS URL from the compliance job.`);

    return url;
  };

  const parseJsonLine = (line: string): JsonObject | undefined => {
    try {
      const parsed = parseJson(line);

      return isJsonObject(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  let nativeAdapter: XNative;

  const adapter = defineAdapter({
    id: "x",
    capabilities: {
      schemaVersion: 1 as const,
      backend: "x",
      apiRevision: "X API v2 / OpenAPI 2.169 (checked 2026-10-05)",
      runtime: ["node22", "node24", "bun"],
      capabilities: [
        webhookCapability(
          "x",
          "Verifies X-Twitter-Webhooks-Signature-OAuth2 or the legacy X-Twitter-Webhooks-Signature and decodes Account Activity deliveries. Answer the CRC GET with answerXWebhookChallenge.",
        ),
        {
          platform: "x",
          operation: "posts.publish",
          availability: "available" as const,
          formats: ["text" as const, "image" as const, "video" as const],
          requiredScopes: ["tweet.read", "tweet.write", "users.read", "media.write"],
          // Mirrors prepareTarget. Per-kind byte limits (5 MiB image, 15 MiB GIF) stay in prepare.
          constraints: {
            mediaSources: ["blob" as const],
            maxItems: 4,
            maxBytes: xMaxVideoBytes,
            allowedMimeTypes: [
              "image/jpeg",
              "image/png",
              "image/webp",
              "image/gif",
              "video/mp4",
              "video/quicktime",
              "video/webm",
            ],
          },
          notes:
            "User-context OAuth2 token; current X API access/billing required. Up to four static JPEG/PNG/WEBP image Blobs, each at most 5 MiB, or one MP4/QuickTime/WebM video up to the 16 GiB upload ceiling (account size/duration eligibility may be lower) / one GIF up to 15 MiB via 4 MiB chunked upload with bounded processing poll. Post attach can still reject over-duration video with 403. Self-serve replies require a parent-author mention or quote summoning this account; Enterprise is exempt (February 2026 changelog).",
        },
        ...[
          "accounts.read",
          "posts.list",
          "posts.read",
          "analytics.read",
          "analytics.account.read",
          "comments.write",
          "posts.repost",
          "posts.quote",
          "posts.delete",
          "polls.create",
          "bookmarks.read",
          "bookmarks.write",
          "follows.write",
          "mentions.read",
          "likes.read",
          "likes.write",
          "lists.read",
          "lists.write",
          "timelines.read",
        ].map((operation) => ({
          platform: "x",
          operation,
          availability: "available" as const,
          ...(["posts.repost"].includes(operation)
            ? { requiredScopes: ["tweet.read", "tweet.write", "users.read"] }
            : ["bookmarks.read"].includes(operation)
              ? { requiredScopes: ["bookmark.read", "tweet.read", "users.read"] }
              : ["bookmarks.write"].includes(operation)
                ? { requiredScopes: ["bookmark.write", "tweet.read", "users.read"] }
                : ["follows.write"].includes(operation)
                  ? { requiredScopes: ["follows.write", "tweet.read", "users.read"] }
                  : ["likes.read"].includes(operation)
                    ? { requiredScopes: ["like.read", "tweet.read", "users.read"] }
                    : ["likes.write"].includes(operation)
                      ? { requiredScopes: ["like.write", "tweet.read", "users.read"] }
                      : ["lists.read"].includes(operation)
                        ? { requiredScopes: ["list.read", "tweet.read", "users.read"] }
                        : ["lists.write"].includes(operation)
                          ? { requiredScopes: ["list.write", "tweet.read", "users.read"] }
                          : ["timelines.read", "mentions.read", "posts.list"].includes(operation)
                            ? { requiredScopes: ["tweet.read", "users.read"] }
                            : [
                                  "posts.quote",
                                  "posts.delete",
                                  "posts.publish",
                                  "comments.write",
                                  "polls.create",
                                ].includes(operation)
                              ? { requiredScopes: ["tweet.read", "tweet.write", "users.read"] }
                              : {}),
          ...(["posts.quote", "likes.read", "likes.write", "follows.write"].includes(operation)
            ? {
                notes:
                  "Enterprise-only operation per X's April 2026 changelog; endpoint access remains subject to X eligibility.",
              }
            : operation === "comments.write"
              ? {
                  notes:
                    "Self-serve replies require the parent author to have summoned the replying account by mentioning or quoting it. Enterprise is exempt (X February 2026 changelog).",
                }
              : {}),
        })),
        {
          platform: "x",
          operation: "posts.removeFromPlatform",
          availability: "available" as const,
          requiredScopes: ["tweet.read", "tweet.write", "users.read"],
        },
        {
          platform: "x",
          operation: "posts.update",
          availability: "available" as const,
          formats: ["text" as const],
          requiredScopes: ["tweet.read", "tweet.write", "users.read"],
          notes:
            "Text-only edit through native.updatePost. X requires X Premium, the account's own post, and a recent post within X's edit window and edit count. Polls, replies to others, reposts, and scheduled posts are not editable. Each edit creates a new post ID.",
        },
        {
          platform: "x",
          operation: "graph.read",
          availability: "available" as const,
          requiredScopes: ["users.read", "tweet.read", "follows.read", "mute.read", "block.read"],
          notes:
            "Use follows.read for followers/following, mute.read for muted users, and block.read for blocked users, with tweet.read and users.read. Following access is Enterprise-only per X's April 2026 changelog; muted/blocked reads require user context.",
        },
        {
          platform: "x",
          operation: "profiles.read",
          availability: "available" as const,
          requiredScopes: ["users.read"],
        },
        {
          platform: "x",
          operation: "graph.follow",
          availability: "available" as const,
          requiredScopes: ["users.read", "tweet.read", "follows.write"],
          notes: "Following operations require Enterprise access per X's April 2026 changelog.",
        },
        {
          platform: "x",
          operation: "graph.unfollow",
          availability: "available" as const,
          requiredScopes: ["users.read", "tweet.read", "follows.write"],
          notes: "Following operations require Enterprise access per X's April 2026 changelog.",
        },
        {
          platform: "x",
          operation: "graph.mute",
          availability: "available" as const,
          requiredScopes: ["users.read", "tweet.read", "mute.write"],
        },
        {
          platform: "x",
          operation: "graph.unmute",
          availability: "available" as const,
          requiredScopes: ["users.read", "tweet.read", "mute.write"],
        },
        {
          platform: "x",
          operation: "graph.block",
          availability: "available" as const,
          requiredScopes: ["users.read", "tweet.read", "block.write"],
          notes: "Enterprise plan only.",
        },
        {
          platform: "x",
          operation: "graph.unblock",
          availability: "available" as const,
          requiredScopes: ["users.read", "tweet.read", "block.write"],
          notes: "Enterprise plan only.",
        },
        {
          platform: "x",
          operation: "lists.pinned.read",
          availability: "available" as const,
          requiredScopes: ["users.read", "tweet.read", "list.read"],
        },
        {
          platform: "x",
          operation: "lists.pinned.write",
          availability: "available" as const,
          requiredScopes: ["users.read", "tweet.read", "list.write"],
        },
        {
          platform: "x",
          operation: "messages.conversation.write",
          availability: "available" as const,
          requiredScopes: ["dm.write", "users.read", "tweet.read"],
        },
        {
          platform: "x",
          operation: "messages.group.write",
          availability: "available" as const,
          requiredScopes: ["dm.write", "users.read", "tweet.read"],
        },
        {
          platform: "x",
          operation: "comments.read",
          availability: "available" as const,
          requiredScopes: ["tweet.read", "users.read"],
          notes:
            "Replies come from recent search with conversation_id, so only replies from the last 7 days are returned. Pass the conversation's root post. Page limits are 10-100. Recent search allows 450 requests per 15 minutes per app and 300 per user, and X bills post reads under the app's plan.",
        },
        {
          platform: "x",
          operation: "search.posts",
          availability: "available" as const,
          requiredScopes: ["tweet.read", "users.read"],
          notes:
            "Recent search covers the last 7 days. Full-archive search requires an eligible X API pay-per-use or Enterprise plan.",
        },
        {
          platform: "x",
          operation: "media.video",
          availability: "available" as const,
          formats: ["video" as const],
          requiredScopes: ["tweet.read", "tweet.write", "users.read", "media.write"],
          notes:
            "MP4, QuickTime, or WebM Blob chunked INIT/APPEND/FINALIZE with 4 MiB segments and bounded STATUS poll honoring check_after_secs.",
        },
        {
          platform: "x",
          operation: "media.gif",
          availability: "available" as const,
          requiredScopes: ["tweet.read", "tweet.write", "users.read", "media.write"],
          notes: "GIF Blob chunked upload; large GIFs process asynchronously before attach.",
        },
        {
          platform: "x",
          operation: "messages.read",
          availability: "available" as const,
          requiredScopes: ["dm.read", "users.read", "tweet.read"],
          notes: "Requires a user-context token and an X API tier that includes Direct Messages.",
        },
        {
          platform: "x",
          operation: "notifications.read",
          availability: "unsupported-by-platform" as const,
          notes:
            "X API v2 has no notifications list endpoint. Use mentions.read, or the Account Activity or X Activity API webhooks and streams.",
        },
        {
          platform: "x",
          operation: "messages.write",
          availability: "available" as const,
          requiredScopes: ["dm.write", "dm.read", "users.read", "tweet.read"],
          notes: "Requires a user-context token and an X API tier that includes Direct Messages.",
        },
        {
          platform: "x",
          operation: "comments.moderate",
          availability: "available" as const,
          requiredScopes: ["tweet.moderate.write", "tweet.read", "users.read"],
          notes:
            "Native hideReply hides or unhides replies in conversations the authenticated user started. Requires a user-context token.",
        },
        {
          platform: "x",
          operation: "streams.read",
          availability: "available" as const,
          notes:
            "Filtered stream via native stream, listStreamRules, addStreamRules, and deleteStreamRules with the app-only appBearerToken. Needs X API pay-per-use (1 connection, 1,000 rules of up to 1,024 characters) or Enterprise (multiple connections, 25,000+ rules of up to 2,048 characters). backfillMinutes and startTime/endTime recovery need Enterprise. One caller-controlled connection per iteration; no automatic reconnect.",
        },
        {
          platform: "x",
          operation: "posts.schedule",
          availability: "not-implemented-by-adapter" as const,
          notes:
            "X API v2 has no scheduled-post field; POST /2/tweets publishes immediately. X Ads API scheduled Tweets (ads-api.x.com/12/accounts/:account_id/scheduled_tweets) need Ads API approval, an ads account, and OAuth 1.0a-signed requests, which this OAuth 2.0 adapter does not implement (https://docs.x.com/x-ads-api/fundamentals/making-authenticated-requests, checked 2026-09-24). Scheduled Tweets default to nullcast=true (promoted-only, not on the public timeline); organic nullcast=false Tweets can only be created by the ads account's full promotable user (https://docs.x.com/x-ads-api/creatives, checked 2026-09-24). Use an application-owned job runner to publish at a chosen time.",
        },
        ...(
          [
            [
              "posts.lookup",
              ["tweet.read", "users.read"],
              "Batch lookup of up to 100 Posts with GET /2/tweets?ids=.",
            ],
            [
              "posts.quotes.read",
              ["tweet.read", "users.read"],
              "Quote Posts of a Post with GET /2/tweets/{id}/quote_tweets.",
            ],
            [
              "reposts.read",
              ["tweet.read", "users.read", "timeline.read"],
              "repostedBy, reposts, and repostsOfMe. repostsOfMe needs a user token with timeline.read.",
            ],
            [
              "users.lookup",
              ["users.read", "tweet.read"],
              "Batch user lookup by up to 100 IDs or usernames.",
            ],
            [
              "users.search",
              ["users.read", "tweet.read"],
              "User search with GET /2/users/search; needs a user token.",
            ],
            [
              "users.affiliates.read",
              ["users.read", "tweet.read"],
              "Affiliates of a verified organization with GET /2/users/{id}/affiliates.",
            ],
            [
              "search.counts",
              ["tweet.read", "users.read"],
              "Recent counts accept a user or app token; full-archive counts need appBearerToken and an eligible plan.",
            ],
            [
              "bookmarks.folders",
              ["bookmark.read", "bookmark.write", "tweet.read", "users.read"],
              "List and create bookmark folders and read a folder's Post IDs.",
            ],
            [
              "spaces.read",
              ["space.read", "tweet.read", "users.read"],
              "Space lookup, search, Space Posts, and ticket buyers. spaceBuyers needs the host's user token.",
            ],
            [
              "communities.read",
              ["list.read", "tweet.read", "users.read"],
              "Community lookup by ID and keyword search. Search needs a user token.",
            ],
            [
              "trends.read",
              ["tweet.read", "users.read"],
              "Trends by WOEID and personalized trends. Personalized trends need a user token.",
            ],
            [
              "usage.read",
              [],
              "Project Post usage needs appBearerToken; credit balance accepts a user or app token.",
            ],
            [
              "media.dm.upload",
              ["media.write", "dm.write", "users.read", "tweet.read"],
              "DM image, GIF, and video uploads with dm_image, dm_gif, or dm_video. Optional additional_owners on native uploads.",
            ],
            [
              "media.subtitles",
              ["media.write", "users.read", "tweet.read"],
              "Upload SRT or WebVTT subtitles and attach or remove them on an uploaded video with /2/media/subtitles.",
            ],
            [
              "analytics.private.read",
              ["tweet.read", "users.read"],
              "non_public_metrics and organic_metrics for the account's own Posts from the last 30 days; user token only.",
            ],
            [
              "analytics.posts.read",
              ["tweet.read", "users.read"],
              "Post engagement time series with GET /2/tweets/analytics for owned Posts; user token only.",
            ],
            [
              "analytics.media.read",
              ["tweet.read"],
              "Video metrics with GET /2/media/analytics for owned media; user token only.",
            ],
            [
              "messages.event.read",
              ["dm.read", "tweet.read", "users.read"],
              "One DM event by ID with GET /2/dm_events/{event_id}.",
            ],
            [
              "messages.delete",
              ["dm.write", "dm.read"],
              "Deletes a DM event the account sent; requires X to confirm deleted: true.",
            ],
            [
              "messages.media.read",
              ["dm.read"],
              "Downloads legacy DM media bytes into memory up to maxBytes (default 15 MiB).",
            ],
            [
              "messages.block",
              ["dm.write", "tweet.read", "users.read"],
              "Blocks or unblocks DMs from a user with /2/users/{id}/dm/block and /dm/unblock.",
            ],
            [
              "bookmarks.bulk",
              ["bookmark.write", "tweet.read", "users.read"],
              "Bookmarks up to 25 posts per request with tweet_ids, optionally into a bookmark folder (folder_id).",
            ],
            [
              "media.metadata",
              ["media.write"],
              "POST /2/media/metadata: alt text, download, expiration, domain, origin, and sensitive-media controls.",
            ],
            [
              "streams.activity",
              [],
              "X Activity API persistent stream (GET /2/activity/stream) with backfill_minutes and start/end recovery; needs appBearerToken and Activity subscriptions.",
            ],
            [
              "streams.volume",
              [],
              "Volume streams: sample, sample10, firehose, en/ja/ko/pt firehoses, likes firehose and likes sample10. Enterprise access; needs appBearerToken.",
            ],
            [
              "streams.compliance",
              [],
              "Post, user and Like compliance streams and the Post label stream. Enterprise access; needs appBearerToken.",
            ],
            [
              "compliance.jobs",
              [],
              "Batch compliance jobs: create, list, read, upload IDs to the signed upload_url, download results, and cancel. Needs appBearerToken.",
            ],
            [
              "notes.community",
              ["tweet.read", "tweet.write"],
              "Community Notes for AI Note Writers: create, evaluate, delete, notes written, and eligible Posts (test_mode).",
            ],
            [
              "news.read",
              ["tweet.read", "users.read"],
              "X News stories: search (query, max_age_hours) and lookup by ID; user token or appBearerToken.",
            ],
            [
              "chat.groups",
              ["dm.read", "dm.write", "tweet.read", "users.read"],
              "X Chat (beta) group lifecycle, members, admins, admin requests and settings, invite links, and join requests. Encrypted fields and action signatures come from X's Chat XDK.",
            ],
            [
              "chat.inbox",
              ["dm.read", "dm.write", "tweet.read", "users.read"],
              "X Chat (beta) archive, mute, read and unread, typing, disappearing messages, screen capture, pinned messages, message deletion, message requests, and chat settings.",
            ],
            [
              "chat.keys",
              ["dm.read", "dm.write", "tweet.read", "users.read"],
              "X Chat (beta) conversation keys and user public keys for end-to-end encryption; the SDK carries keys built by the Chat XDK.",
            ],
            [
              "chat.media",
              ["media.write"],
              "X Chat (beta) encrypted media upload (initialize, append, finalize) and download.",
            ],
            [
              "live.x.broadcasts.user",
              ["broadcast.read", "broadcast.write"],
              "User-scoped broadcasts and stream sources (/2/users/{id}/broadcasts and /sources), publish without the announcing Post (should_not_tweet), ingest region lookup, per-broadcast chat mutes, and scheduled-broadcast updates.",
            ],
            [
              "calls.manage",
              ["calls.read", "calls.write", "calls.join"],
              "X Calls (beta, OpenAPI 2.173): create, read, join and leave calls; list, schedule, update, cancel, and RSVP to scheduled calls.",
            ],
            [
              "bots.manage",
              [],
              "Bot accounts (beta, OpenAPI 2.173): list, create, update, delete, and rotate or revoke bot bearer tokens. Most routes need appBearerToken.",
            ],
            [
              "developer.account",
              ["developer.read", "developer.write"],
              "Developer account read and ensure (GET/POST /2/account, beta, OpenAPI 2.173).",
            ],
            [
              "streams.rules.counts",
              [],
              "Filtered-stream rule totals and caps; needs appBearerToken.",
            ],
            [
              "streams.webhooks",
              [],
              "Links filtered-stream delivery to a registered webhook; needs appBearerToken and Enterprise access.",
            ],
            [
              "streams.connections",
              [],
              "Connections API history and termination for streaming endpoints; needs appBearerToken.",
            ],
            [
              "webhooks.manage",
              [],
              "Register, list, re-validate, delete, and replay webhook configs. Prefers appBearerToken; replay needs it.",
            ],
            [
              "activity.subscriptions",
              ["tweet.read", "users.read"],
              "X Activity API subscriptions. Private events (likes, DMs, replies, mentions, mutes, blocks) need the user's OAuth 2.0 token and the matching read scope.",
            ],
            [
              "articles.publish",
              ["tweet.read", "tweet.write", "users.read"],
              "Create a DraftJS Article draft and publish it as a long-form Post with /2/articles.",
            ],
            [
              "chat.encrypted",
              ["dm.read", "dm.write", "tweet.read", "users.read"],
              "X Chat (beta) conversations, events, and messages. Sends plaintext content or an encrypted event built by X's Chat XDK; the SDK does not encrypt or decrypt.",
            ],
            [
              "live.x.broadcasts",
              ["broadcast.read", "broadcast.write"],
              "Live video broadcasts (beta): stream sources, scheduled broadcasts, go live, end, chat history and send, and chat moderators and mutes.",
            ],
            [
              "media.lookup",
              ["tweet.read"],
              "Media lookup by media key with GET /2/media?media_keys=.",
            ],
          ] as const
        ).map(([operation, requiredScopes, notes]) => ({
          platform: "x",
          operation,
          availability: "available" as const,
          ...definedFields({
            requiredScopes: requiredScopes.length ? [...requiredScopes] : undefined,
          }),
          notes,
        })),
        {
          platform: "x",
          operation: "profile.update",
          availability: "unsupported-by-platform" as const,
          notes:
            "X API v2 (OpenAPI 2.168, https://docs.x.com/openapi.json, checked 2026-09-24) has no endpoint that writes the user's profile. The v1.1 POST account/update_profile reference is no longer published on docs.x.com (its developer.x.com URL redirects to https://docs.x.com/overview), and v1.1 user writes require OAuth 1.0a.",
        },
      ],
    },
    accounts: {
      async list(_input: { cursor?: string; limit?: number }, context: AdapterOperationContext) {
        return { items: [await readAccount(context)] };
      },
      async get(ref: ConnectedAccountRef, context: AdapterOperationContext) {
        authorize(ref, context);

        return readAccount(context);
      },
    },
    graph: {
      async getProfile(account, input, context): Promise<ProfileRecord> {
        const value =
          input.profileId !== undefined
            ? await nativeAdapter.getUserById({ account, userId: input.profileId, context })
            : input.handle !== undefined
              ? await nativeAdapter.getUserByUsername({ account, username: input.handle, context })
              : await nativeAdapter.getMe({ account, context });

        const user = object(object(value)["data"]);

        const id = string(user["id"]);

        return {
          ref: profileRef({
            backend: context.backendInstance,
            platform: "x",
            accountId: account.accountId,
            profileId: id,
          }),
          ...definedFields({
            displayName: optionalString(user["name"]),
            handle: optionalString(user["username"]),
            bio: optionalString(user["description"]),
          }),
          native: user,
        };
      },
      async listRelationships(account, input, context): Promise<Page<RelationshipRecord>> {
        const pagination = {
          ...definedFields({ cursor: input.cursor, limit: input.limit }),
        };

        const result =
          input.kind === "following"
            ? await nativeAdapter.following({
                account,
                ...pagination,
                userId: account.accountId,
                context,
              })
            : input.kind === "followers"
              ? await nativeAdapter.followers({
                  account,
                  ...pagination,
                  userId: account.accountId,
                  context,
                })
              : input.kind === "blocked"
                ? await nativeAdapter.blockedUsers({
                    account,
                    ...pagination,
                    context,
                  })
                : await nativeAdapter.mutedUsers({
                    account,
                    ...pagination,
                    context,
                  });

        return {
          items: result.items.map((entry) => {
            const user = object(entry);

            const id = string(user["id"]);

            return {
              profile: profileRef({
                backend: context.backendInstance,
                platform: "x",
                accountId: account.accountId,
                profileId: id,
              }),
              relationship:
                input.kind === "following"
                  ? "following"
                  : input.kind === "followers"
                    ? "follower"
                    : input.kind,
            };
          }),
          ...definedFields({ nextCursor: result.nextCursor }),
        };
      },
      async follow(target: ProfileRef, context): Promise<RelationshipRecord> {
        const account = connectedAccountRef({
          backend: target.backend,
          platform: "x",
          accountId: target.accountId,
        });

        await nativeAdapter.followUser({ account, userId: target.profileId, context });

        return { profile: target, relationship: "following" };
      },
      async unfollow(target: ProfileRef, context): Promise<void> {
        const account = connectedAccountRef({
          backend: target.backend,
          platform: "x",
          accountId: target.accountId,
        });

        await nativeAdapter.unfollowUser({ account, userId: target.profileId, context });
      },
      async block(target: ProfileRef, context): Promise<RelationshipRecord> {
        const account = connectedAccountRef({
          backend: target.backend,
          platform: "x",
          accountId: target.accountId,
        });

        await nativeAdapter.blockUser({ account, userId: target.profileId, context });

        return { profile: target, relationship: "blocked" };
      },
      async unblock(target: ProfileRef, context): Promise<void> {
        const account = connectedAccountRef({
          backend: target.backend,
          platform: "x",
          accountId: target.accountId,
        });

        await nativeAdapter.unblockUser({ account, userId: target.profileId, context });
      },
      async mute(target: ProfileRef, context): Promise<RelationshipRecord> {
        const account = connectedAccountRef({
          backend: target.backend,
          platform: "x",
          accountId: target.accountId,
        });

        await nativeAdapter.muteUser({ account, userId: target.profileId, context });

        return { profile: target, relationship: "muted" };
      },
      async unmute(target: ProfileRef, context): Promise<void> {
        const account = connectedAccountRef({
          backend: target.backend,
          platform: "x",
          accountId: target.accountId,
        });

        await nativeAdapter.unmuteUser({ account, userId: target.profileId, context });
      },
    },
    search: {
      posts: (account, input, context) => searchPosts(account, input, context),
    },
    posts: {
      list: listPosts,
      prepareTarget(target: PreparedPublishTarget) {
        const issues: { code: string; message: string; severity: "error"; targetIndex: number }[] =
          [];

        const fail = (code: string, message: string) =>
          issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

        if (target.account.platform !== "x" || target.account.accountId !== options.auth.userId)
          fail("x.account", "Select the configured X user.");

        const text = target.content.text ?? "";

        const parsed = parseXPublishOptions(optionsObject(target), {
          hasMedia: (target.content.media ?? []).length > 0,
          isReply: target.replyTo !== undefined,
        });

        for (const issue of parsed.issues) fail(issue.code, issue.message);

        if (text && !isValidXText(text, { longform: parsed.longform }))
          fail(
            "x.text",
            parsed.longform
              ? "Text exceeds X's 25,000-character long-form limit or contains invalid characters."
              : "Text exceeds X's weighted 280-character limit or contains invalid characters. Set longform for an X Premium author.",
          );

        if (target.schedule || target.content.link)
          fail(
            "x.operation",
            "X API v2 cannot schedule posts; use an application job runner. Place URLs explicitly in text.",
          );

        if (
          target.replyTo &&
          (target.replyTo.platform !== "x" ||
            target.replyTo.backend !== target.account.backend ||
            target.replyTo.accountId !== target.account.accountId ||
            target.replyTo.kind !== "platform-post")
        )
          fail(
            "x.reply",
            "Use a platform-post reply reference authorized for this account and backend.",
          );

        const media = target.content.media ?? [];

        const hasChunked = media.some((item) => chunkedCategory(item) !== undefined);

        if (hasChunked && media.length !== 1)
          fail("x.media_count", "Attach a single video or GIF per post.");
        else if (!hasChunked && media.length > 4)
          fail("x.media_count", "Attach up to four images.");

        for (const item of media) {
          const category = chunkedCategory(item);

          if (category === "tweet_video") {
            if (item.source.kind !== "blob" || item.source.blob.size === 0)
              fail("x.video_size", "Video must be a non-empty MP4 Blob.");
            else if (item.source.blob.size > xMaxVideoBytes)
              fail(
                "x.video_size",
                "Video exceeds the 16 GiB upload ceiling; account attachment limits may be lower.",
              );
          } else if (category === "tweet_gif") {
            if (item.source.kind !== "blob" || item.source.blob.size === 0)
              fail("x.gif_size", "GIF must be a non-empty Blob.");
            else if (item.source.blob.size > xMaxGifBytes)
              fail("x.gif_size", "GIF exceeds the 15 MiB limit.");
          } else if (item.kind === "video")
            fail(
              "x.video",
              "X video uploads require a video/mp4, video/quicktime, or video/webm Blob.",
            );
          else if (
            item.kind !== "image" ||
            item.source.kind !== "blob" ||
            !xStaticImageMimeTypes.has(item.mimeType ?? "")
          )
            fail("x.image", "X images must be JPEG, PNG, WEBP, or GIF Blobs.");
          else if (item.source.blob.size > 5 * 1024 * 1024)
            fail("x.image_size", "Image exceeds the 5 MiB limit.");

          if (item.altText !== undefined && item.kind !== "image")
            fail("x.alt_text", "X alt text applies to images and GIFs only.");
          else if (item.altText !== undefined && [...item.altText].length > xMaxAltTextLength)
            fail("x.alt_text", `X alt text is limited to ${xMaxAltTextLength} characters.`);
        }

        return issues;
      },
      async publishTarget(target: PreparedPublishTarget, context: AdapterOperationContext) {
        authorize(target.account, context);

        const ids: string[] = [];

        for (const media of target.content.media ?? []) {
          const mediaId = await uploadXMedia(media, context);

          // Alt text must be attached before the post is created; a failure stops publication.
          if (media.altText !== undefined && media.altText !== "")
            await setAltText(mediaId, media.altText, context);
          ids.push(mediaId);
        }

        const fields = parseXPublishOptions(optionsObject(target), {
          hasMedia: ids.length > 0,
          isReply: target.replyTo !== undefined,
        });

        const [issue] = fields.issues;

        if (issue !== undefined)
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.publish",
            message: issue.message,
          });

        const hasVideo = (target.content.media ?? []).some(
          (media) => chunkedCategory(media) === "tweet_video",
        );

        try {
          return await createPost(
            target.account,
            target.content.text ?? "",
            context,
            {
              ...fields.body,
              ...definedFields({
                media: ids.length ? { media_ids: ids, ...fields.media } : undefined,
                reply: target.replyTo
                  ? {
                      in_reply_to_tweet_id: target.replyTo.postId,
                      ...definedFields({
                        auto_populate_reply_metadata: fields.autoPopulateReplyMetadata,
                        exclude_reply_user_ids:
                          fields.excludeReplyUserIds === undefined
                            ? undefined
                            : [...fields.excludeReplyUserIds],
                      }),
                    }
                  : undefined,
              }),
            },
            target.targetIndex,
          );
        } catch (error) {
          // Unknown 403 bodies cannot distinguish attachment eligibility from missing permission.
          if (
            hasVideo &&
            error instanceof SocialError &&
            error.upstreamStatus === 403 &&
            error.code === "missing_permission"
          )
            throw new SocialError({
              code: "missing_permission",
              operation: error.operation,
              backend: error.backend,
              correlationId: error.correlationId,
              message:
                "X rejected the post with its attached video (HTTP 403). The video may exceed this account's duration limit, or the token may lack post permission. No post was created.",
              upstreamStatus: 403,
              retryDisposition: { kind: "never" },
            });

          throw error;
        }
      },
      async get(ref: PlatformPostRef, context: AdapterOperationContext) {
        return publicFields(await readPost(ref, context), [
          "id",
          "text",
          "author_id",
          "created_at",
          "conversation_id",
        ]);
      },
      async removeFromPlatform(ref: PlatformPostRef, context: AdapterOperationContext) {
        authorize(ref, context);

        await nativeAdapter.deletePost({
          account: connectedAccountRef({
            backend: ref.backend,
            platform: "x",
            accountId: ref.accountId,
          }),
          postId: ref.postId,
          context,
        });
      },
    },
    comments: {
      async list(
        ref: PlatformPostRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ): Promise<Page<JsonObject>> {
        const page = await listReplies(ref, input, context);

        return { ...page, items: page.items.map(normalizeComment) };
      },
      async reply(
        ref: CommentRef,
        content: { text: string },
        context: AdapterOperationContext,
      ): Promise<CommentRef> {
        await validateReplyParent(ref, context);

        if (!isValidXText(content.text))
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.write",
            message: "Reply exceeds X's weighted text limits.",
          });

        const result = await createPost(
          { ...ref, kind: "connected-account" },
          content.text,
          context,
          { reply: { in_reply_to_tweet_id: ref.commentId } },
        );

        if (result.state !== "published")
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "comments.write",
            message: "X reply lacks a confirmed native ID. Reconcile before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return { ...ref, commentId: result.post.postId };
      },
    },
    messages: {
      async listConversations(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ): Promise<Page<JsonObject>> {
        // X has no conversation-list endpoint. This page is derived from /2/dm_events,
        // with the latest event for each distinct dm_conversation_id.
        requireUserToken("messages.read");

        if (
          input.limit !== undefined &&
          (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.read",
            message: "X DM limits must be integers from 1 through 100.",
          });
        // The cursor carries the event cursor plus fixed-width hashes of the conversations
        // already returned, so later event pages skip them. To stay under the client cursor
        // size limit, the walk ends after maxConversationHashes distinct conversations
        // rather than forgetting earlier ones and returning them again.
        let eventCursor: string | undefined;

        const seen: string[] = [];

        if (input.cursor !== undefined) {
          try {
            const parsed: unknown = JSON.parse(input.cursor);

            if (!isJsonValue(parsed)) throw new Error("bad cursor");

            const state = object(parsed);
            eventCursor = optionalString(state["c"]);

            const hashes = string(state["s"]);

            if (hashes.length % conversationHashWidth !== 0) throw new Error("bad cursor");

            for (let at = 0; at < hashes.length; at += conversationHashWidth)
              seen.push(hashes.slice(at, at + conversationHashWidth));
          } catch {
            throw new SocialError({
              code: "invalid_input",
              operation: "messages.read",
              message: "Use a cursor returned by listConversations.",
            });
          }
        }

        const seenSet = new Set(seen);

        const target = input.limit ?? 100;

        const items: JsonObject[] = [];

        // A walk that has reached the conversation cap has no next page.
        const pageFrom = (c: string | undefined): Page<JsonObject> =>
          seen.length >= maxConversationHashes
            ? { items }
            : { items, nextCursor: JSON.stringify({ c, s: seen.join("") }) };

        for (let fetches = 0; fetches < 10; fetches++) {
          const page = await nativeAdapter.listDirectMessages({
            account,
            ...definedFields({ cursor: eventCursor, limit: input.limit }),
            context,
          });

          for (const event of page.items) {
            const conversationId = optionalString(event["dm_conversation_id"]);

            if (conversationId === undefined) continue;

            const hash = conversationHash(conversationId);

            if (seenSet.has(hash)) continue;

            if (seen.length >= maxConversationHashes) return { items };

            // Stop mid-page and reread this event page next time; seen IDs skip the rest.
            if (items.length === target) return pageFrom(eventCursor);
            seenSet.add(hash);
            seen.push(hash);
            items.push(normalizeConversation({ ...event, id: conversationId, native: event }));
          }

          if (page.nextCursor === undefined) return { items };
          eventCursor = page.nextCursor;

          if (items.length === target) break;
        }

        return pageFrom(eventCursor);
      },
      async listMessages(
        conversation: ConversationRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ): Promise<Page<JsonObject>> {
        requireUserToken("messages.read");

        const page = await nativeAdapter.listDirectMessages({
          account: connectedAccountRef({
            backend: conversation.backend,
            platform: "x",
            accountId: conversation.accountId,
          }),
          conversationId: conversation.conversationId,
          ...definedFields({ cursor: input.cursor, limit: input.limit }),
          context,
        });

        return { ...page, items: page.items.map(normalizeMessage) };
      },
      async send(
        conversation: ConversationRef,
        content: { readonly text: string },
        context: AdapterOperationContext,
      ): Promise<JsonObject> {
        requireUserToken("messages.write");

        if (!content.text.trim())
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.write",
            message: "X direct messages require non-empty text.",
          });

        return nativeAdapter.sendConversationMessage({
          account: connectedAccountRef({
            backend: conversation.backend,
            platform: "x",
            accountId: conversation.accountId,
          }),
          conversationId: conversation.conversationId,
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
        const row = await readPost(ref, context);

        const counts = row["public_metrics"] ? object(row["public_metrics"]) : {};

        const metrics: readonly MetricValue[] = [
          ["likes", "like_count"],
          ["reposts", "retweet_count"],
          ["replies", "reply_count"],
          ["quotes", "quote_count"],
          ["impressions", "impression_count"],
          ["bookmarks", "bookmark_count"],
        ].flatMap(([name, key]) => {
          const value = key
            ? optionalNumber(
                key === "retweet_count" ? (counts["repost_count"] ?? counts[key]) : counts[key],
              )
            : undefined;

          return value === undefined || !name
            ? []
            : [
                {
                  name,
                  value,
                  unit: "count" as const,
                  period: "lifetime" as const,
                  fetchedAt: now(),
                  freshness: "unknown" as const,
                  source: "X API v2",
                },
              ];
        });

        return normalizeMetrics(metrics);
      },
    },
    webhooks: directWebhooks(
      "x",
      (input) => verifyXWebhook({ ...input, secret: options.webhookSecret ?? "" }),
      now,
    ),
    native: (nativeAdapter = {
      async searchRecentPosts({ account, search, context }) {
        return searchPosts(account, { ...search, scope: "recent" }, context, search);
      },
      async searchAllPosts({ account, search, context }) {
        return searchPosts(account, { ...search, scope: "all" }, context, search);
      },
      readPost,
      async repost({ account, postId, context }) {
        authorize(account, context);

        return confirmedWrite(
          await requireUserToken("x.repost")(
            `/2/users/${encodeURIComponent(account.accountId)}/retweets`,
            context,
            {
              tweet_id: postId,
            },
          ),
          "retweeted",
          true,
          "x.repost",
        );
      },
      async quote({ account, text, quotedPostId, context }) {
        authorize(account, context);

        return object(
          await requireUserToken("x.quote")("/2/tweets", context, {
            text,
            quote_tweet_id: quotedPostId,
          }),
        );
      },
      async deletePost({ account, postId, context }) {
        authorize(account, context);

        confirmedWrite(
          await requireUserToken("x.deletePost")(
            `/2/tweets/${encodeURIComponent(postId)}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
          "deleted",
          true,
          "x.deletePost",
        );
      },
      async updatePost({ account, postId, text, context }) {
        authorize(account, context);

        if (!/^[0-9]{1,19}$/.test(postId))
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.update",
            message: "X post edits require a numeric post ID.",
          });

        if (!text || !isValidXText(text))
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.update",
            message:
              "Edited text is empty, exceeds X's weighted 280-character limit, or contains invalid characters.",
          });

        const result = object(
          await requireUserToken("x.updatePost")("/2/tweets", context, {
            text,
            edit_options: { previous_post_id: postId },
          }),
        );

        const data = result["data"] === undefined ? {} : object(result["data"]);

        const id = optionalString(data["id"]);

        if (!id)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "posts.update",
            backend: context.backendInstance,
            correlationId: context.correlationId,
            message: "X edit response lacks a new post ID. Reconcile before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        const history = data["edit_history_post_ids"] ?? data["edit_history_tweet_ids"];

        const editHistoryPostIds = Array.isArray(history)
          ? history.filter((entry): entry is string => typeof entry === "string")
          : undefined;

        return {
          post: {
            kind: "platform-post",
            version: 1,
            backend: account.backend,
            platform: "x",
            accountId: account.accountId,
            postId: id,
          },
          previousPostId: postId,
          text: optionalString(data["text"]) ?? text,
          ...definedFields({ editHistoryPostIds }),
        };
      },
      async uploadVideo({ account, video, mimeType = "video/mp4", additionalOwners, context }) {
        authorize(account, context);
        requireAdditionalOwners(additionalOwners, "media.upload");

        const media: MediaAttachment = {
          kind: "video",
          mimeType,
          source: { kind: "blob", blob: video, fingerprint: "native-upload" },
        };

        return { mediaId: await uploadVideoOrGif(media, context, additionalOwners) };
      },
      async uploadGif({ account, gif, additionalOwners, context }) {
        authorize(account, context);
        requireAdditionalOwners(additionalOwners, "media.upload");

        const media: MediaAttachment = {
          kind: "image",
          mimeType: "image/gif",
          source: { kind: "blob", blob: gif, fingerprint: "native-upload" },
        };

        return { mediaId: await uploadVideoOrGif(media, context, additionalOwners) };
      },
      async createPoll({ account, text, options: pollOptions, durationMinutes, context }) {
        authorize(account, context);

        if (
          pollOptions.length < 2 ||
          pollOptions.length > 4 ||
          durationMinutes < 5 ||
          durationMinutes > 10080
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "x.polls.create",
            message: "X polls require 2-4 options and a duration from 5 minutes to 7 days.",
          });

        return object(
          await requireUserToken("x.createPoll")("/2/tweets", context, {
            text,
            poll: { options: [...pollOptions], duration_minutes: durationMinutes },
          }),
        );
      },
      // GET /2/users/:id/bookmarks takes max_results 1-100 and pagination_token from
      // meta.next_token. Source, accessed 2026-10-24: https://docs.x.com/x-api/users/get-bookmarks
      async bookmarks({ account, cursor, maxResults, context }) {
        authorize(account, context);

        if (
          maxResults !== undefined &&
          (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 100)
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "x.bookmarks",
            message: "X bookmark maxResults must be an integer from 1 through 100.",
          });

        if (cursor !== undefined && !/^[A-Za-z0-9_-]{1,1024}$/.test(cursor))
          throw new SocialError({
            code: "invalid_input",
            operation: "x.bookmarks",
            message: "Use the meta.next_token value returned by a previous bookmarks page.",
          });

        return object(
          await requireUserToken("x.bookmarks")(
            `/2/users/${encodeURIComponent(account.accountId)}/bookmarks`,
            context,
            undefined,
            definedFields({
              max_results: maxResults?.toString(),
              pagination_token: cursor,
            }),
          ),
        );
      },
      async bookmark({ account, postId, context }) {
        authorize(account, context);

        confirmedWrite(
          await requireUserToken("x.bookmark")(
            `/2/users/${encodeURIComponent(account.accountId)}/bookmarks`,
            context,
            {
              tweet_id: postId,
            },
          ),
          "bookmarked",
          true,
          "x.bookmark",
        );
      },
      async bookmarkPosts({ account, postIds, folderId, context }) {
        authorize(account, context);

        const operation = "x.bookmarks.bulk";

        if (postIds.length < 1 || postIds.length > 25 || postIds.some((id) => !xIdPattern.test(id)))
          throw invalid(operation, "postIds must list 1-25 numeric X post IDs.");

        if (folderId !== undefined) requireId(folderId, "folderId", operation);

        const result = object(
          await requireUserToken(operation)(
            `/2/users/${encodeURIComponent(account.accountId)}/bookmarks`,
            context,
            { tweet_ids: [...postIds], ...definedFields({ folder_id: folderId }) },
          ),
        );

        const data = result["data"];

        const errors = result["errors"] === undefined ? [] : array(result["errors"]).map(object);

        if (!isJsonArray(data) && errors.length === 0)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation,
            message: "X did not report which posts were bookmarked. Read the bookmarks first.",
            retryDisposition: { kind: "reconcile-first" },
          });

        const bookmarked = (isJsonArray(data) ? data : []).flatMap((entry) => {
          const row = object(entry);

          const id = optionalString(row["tweet_id"]);

          return row["bookmarked"] === true && id !== undefined ? [id] : [];
        });

        return { bookmarked, errors };
      },
      async setMediaMetadata({ account, mediaId, metadata, context }) {
        authorize(account, context);

        const operation = "x.media.metadata";

        requireId(mediaId, "mediaId", operation);

        const wire: Record<string, JsonValue> = {};

        if (metadata.altText !== undefined) {
          if ([...metadata.altText].length > 1000)
            throw invalid(operation, "altText is limited to 1,000 characters.");

          wire["alt_text"] = { text: metadata.altText };
        }

        if (metadata.allowDownload !== undefined)
          wire["allow_download_status"] = { allow_download: metadata.allowDownload };

        if (metadata.contentExpiresAt !== undefined) {
          const expires = Date.parse(metadata.contentExpiresAt);

          if (!Number.isFinite(expires))
            throw invalid(operation, "contentExpiresAt must be an ISO 8601 timestamp.");

          wire["content_expiration"] = { timestamp_sec: Math.floor(expires / 1000) };
        }

        if (metadata.domainAllowlist !== undefined) {
          if (metadata.domainAllowlist.some((domain) => !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)))
            throw invalid(
              operation,
              "domainAllowlist takes bare domain names such as example.com.",
            );

          wire["domain_restrictions"] = { whitelist: [...metadata.domainAllowlist] };
        }

        if (metadata.foundMediaOrigin !== undefined) {
          if (!metadata.foundMediaOrigin.provider.trim() || !metadata.foundMediaOrigin.id.trim())
            throw invalid(operation, "foundMediaOrigin needs a provider and an id.");

          wire["found_media_origin"] = {
            provider: metadata.foundMediaOrigin.provider,
            id: metadata.foundMediaOrigin.id,
          };
        }

        if (metadata.managed !== undefined) wire["management_info"] = { managed: metadata.managed };

        if (metadata.shared !== undefined) wire["shared_info"] = { shared: metadata.shared };

        if (metadata.uploadSource !== undefined) {
          if (!metadata.uploadSource.trim())
            throw invalid(operation, "uploadSource must not be empty.");

          wire["upload_source"] = { upload_source: metadata.uploadSource };
        }

        if (metadata.sensitiveMediaWarning !== undefined)
          wire["sensitive_media_warning"] = metadata.sensitiveMediaWarning;

        if (metadata.geoRestrictions !== undefined)
          wire["geo_restrictions"] = metadata.geoRestrictions;

        if (metadata.audiencePolicy !== undefined)
          wire["audience_policy"] = metadata.audiencePolicy;

        if (Object.keys(wire).length === 0)
          throw invalid(operation, "Pass at least one metadata field.");

        const data = object(
          object(
            await requireUserToken(operation)("/2/media/metadata", context, {
              id: mediaId,
              metadata: wire,
            }),
          )["data"],
        );

        if (data["id"] !== mediaId)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation,
            message: "X did not confirm the media metadata. Read the media before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return data["associated_metadata"] === undefined ? {} : object(data["associated_metadata"]);
      },
      async createComplianceJob({ account, type, name, resumable, context }) {
        authorize(account, context);

        const operation = "x.compliance.jobs.create";

        if (name !== undefined && (!name.trim() || [...name].length > 64))
          throw invalid(operation, "Compliance job names are 1-64 characters.");

        return complianceJob(
          object(
            await appRequest()(
              "/2/compliance/jobs",
              context,
              { type, ...definedFields({ name, resumable }) },
              { "compliance_job.fields": complianceJobFields },
            ),
          )["data"],
          operation,
        );
      },
      async complianceJobs({ account, type, status, context }) {
        const result = await xRead({
          account,
          context,
          path: "/2/compliance/jobs",
          operation: "x.compliance.jobs.list",
          credential: "app",
          query: {
            type,
            "compliance_job.fields": complianceJobFields,
            ...definedFields({ status }),
          },
        });

        return (result["data"] === undefined ? [] : array(result["data"])).map((entry) =>
          complianceJob(entry, "x.compliance.jobs.list"),
        );
      },
      async getComplianceJob({ account, jobId, context }) {
        requireId(jobId, "jobId", "x.compliance.jobs.get");

        return complianceJob(
          (
            await xRead({
              account,
              context,
              path: `/2/compliance/jobs/${jobId}`,
              operation: "x.compliance.jobs.get",
              credential: "app",
              query: { "compliance_job.fields": complianceJobFields },
            })
          )["data"],
          "x.compliance.jobs.get",
        );
      },
      async uploadComplianceIds({ account, job, ids, context }) {
        authorize(account, context);

        const operation = "x.compliance.jobs.upload";

        if (ids.length === 0 || ids.some((id) => !xIdPattern.test(id)))
          throw invalid(operation, "ids must list numeric X Post or user IDs.");

        const url = signedComplianceUrl(job.uploadUrl, "uploadUrl", operation);

        if (context.signal?.aborted)
          throw new SocialError({
            code: "cancelled",
            operation,
            message: "The upload was cancelled.",
          });

        const controller = new AbortController();

        const onAbort = () => controller.abort();

        context.signal?.addEventListener("abort", onAbort, { once: true });

        const timer = setTimeout(onAbort, remainingBudget(context));

        const headers = new Headers({ "content-type": "text/plain" });

        if (url.hostname === "api.x.com")
          headers.set("authorization", `Bearer ${options.appBearerToken ?? ""}`);

        let response: Response;

        try {
          response = await (options.fetch ?? globalThis.fetch)(url, {
            method: "PUT",
            headers,
            body: ids.join("\n"),
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (error) {
          throw new SocialError({
            code: context.signal?.aborted ? "cancelled" : "ambiguous_outcome",
            operation,
            message: "The compliance upload did not complete. Read the job status before retrying.",
            retryDisposition: { kind: "reconcile-first" },
            cause: error,
          });
        } finally {
          clearTimeout(timer);
          context.signal?.removeEventListener("abort", onAbort);
        }

        void response.body?.cancel().catch(() => undefined);

        if (!response.ok)
          throw new SocialError({
            code:
              response.status === 401 || response.status === 403
                ? "missing_permission"
                : "upstream_failure",
            operation,
            message: `The compliance upload failed with HTTP ${response.status}. The signed URL may have expired; create a new job.`,
            upstreamStatus: response.status,
            retryDisposition: { kind: "never" },
          });
      },
      async downloadComplianceResults({ account, job, maxBytes = 64 * 1024 * 1024, context }) {
        authorize(account, context);

        const operation = "x.compliance.jobs.download";

        const url = signedComplianceUrl(job.downloadUrl, "downloadUrl", operation);

        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024)
          throw invalid(operation, "maxBytes must be an integer from 1 through 1 GiB.");

        const { bytes } = await downloadBytes(
          url.href,
          maxBytes,
          context,
          operation,
          url.hostname === "api.x.com" ? "app" : "none",
        );

        let text: string;

        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new HttpError("X compliance results are not UTF-8.", "invalid-response", true);
        }

        return text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
          .map((line) => {
            const parsed = parseJsonLine(line);

            if (parsed === undefined)
              throw new HttpError(
                "X compliance results contain a non-object line.",
                "invalid-response",
                true,
              );

            return parsed;
          });
      },
      async cancelComplianceJob({ account, jobId, context }) {
        authorize(account, context);
        requireId(jobId, "jobId", "x.compliance.jobs.cancel");

        return complianceJob(
          object(
            await appRequest()(
              `/2/compliance/jobs/${jobId}`,
              context,
              undefined,
              { "compliance_job.fields": complianceJobFields },
              "DELETE",
            ),
          )["data"],
          "x.compliance.jobs.cancel",
        );
      },
      async createCommunityNote({ account, note, context }) {
        authorize(account, context);

        const operation = "x.notes.create";

        requireId(note.postId, "postId", operation);

        if (!/https?:\/\/\S+/.test(note.text))
          throw invalid(operation, "Community Note text must contain a URL.");

        if (
          note.misleadingTags.some((tag) => !xNoteTags.has(tag)) ||
          (note.classification === "misinformed_or_potentially_misleading" &&
            note.misleadingTags.length === 0)
        )
          throw invalid(
            operation,
            "A misleading note needs at least one known misleadingTags value.",
          );

        const data = object(
          object(
            await requireUserToken(operation)("/2/notes", context, {
              post_id: note.postId,
              test_mode: note.testMode,
              info: {
                text: note.text,
                classification: note.classification,
                misleading_tags: [...note.misleadingTags],
                trustworthy_sources: note.trustworthySources,
                ...definedFields({ is_media_note: note.isMediaNote }),
              },
            }),
          )["data"],
        );

        const noteId = optionalString(data["id"]);

        if (noteId === undefined)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation,
            message: "X did not return the note ID. Search the notes written before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return { noteId };
      },
      async evaluateCommunityNote({ account, postId, text, context }) {
        authorize(account, context);
        requireId(postId, "postId", "x.notes.evaluate");

        if (!text.trim()) throw invalid("x.notes.evaluate", "Pass the note text to evaluate.");

        const data = object(
          object(
            await requireUserToken("x.notes.evaluate")("/2/notes/evaluate", context, {
              post_id: postId,
              note_text: text,
            }),
          )["data"],
        );

        return definedFields({ claimOpinionScore: optionalNumber(data["claim_opinion_score"]) });
      },
      async deleteCommunityNote({ account, noteId, context }) {
        authorize(account, context);
        requireId(noteId, "noteId", "x.notes.delete");

        confirmedWrite(
          await requireUserToken("x.notes.delete")(
            `/2/notes/${noteId}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
          "deleted",
          true,
          "x.notes.delete",
        );
      },
      async communityNotesWritten({ account, testMode, cursor, limit, context }) {
        return xReadPage({
          account,
          context,
          path: "/2/notes/search/notes_written",
          operation: "x.notes.written",
          credential: "user",
          query: {
            test_mode: String(testMode),
            "note.fields": "id,info,scoring_status,status,test_result",
          },
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 100,
        });
      },
      async postsEligibleForNotes({ account, testMode, postSelection, cursor, limit, context }) {
        if (postSelection !== undefined && !postSelection.trim())
          throw invalid("x.notes.eligible", "postSelection must not be empty.");

        return xReadPage({
          account,
          context,
          path: "/2/notes/search/posts_eligible_for_notes",
          operation: "x.notes.eligible",
          credential: "user",
          query: {
            test_mode: String(testMode),
            ...definedFields({ post_selection: postSelection }),
          },
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 100,
        });
      },
      async searchNews({ account, query, maxAgeHours, limit, newsFields, context }) {
        const operation = "x.news.search";

        if (!query.trim() || query.length > 2048)
          throw invalid(operation, "News queries are 1-2048 characters.");

        if (
          maxAgeHours !== undefined &&
          (!Number.isSafeInteger(maxAgeHours) || maxAgeHours < 1 || maxAgeHours > 720)
        )
          throw invalid(operation, "maxAgeHours must be an integer from 1 through 720.");

        return xReadPage({
          account,
          context,
          path: "/2/news/search",
          operation,
          credential: "user-or-app",
          query: {
            query,
            "news.fields": (newsFields ?? defaultNewsFields).join(","),
            ...definedFields({ max_age_hours: maxAgeHours?.toString() }),
          },
          limit,
          minLimit: 1,
          maxLimit: 100,
        });
      },
      async getNews({ account, newsId, newsFields, context }) {
        requireId(newsId, "newsId", "x.news.get");

        return object(
          (
            await xRead({
              account,
              context,
              path: `/2/news/${newsId}`,
              operation: "x.news.get",
              credential: "user-or-app",
              query: { "news.fields": (newsFields ?? defaultNewsFields).join(",") },
            })
          )["data"],
        );
      },
      async removeBookmark({ account, postId, context }) {
        authorize(account, context);

        confirmedWrite(
          await requireUserToken("x.removeBookmark")(
            `/2/users/${encodeURIComponent(account.accountId)}/bookmarks/${encodeURIComponent(postId)}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
          "bookmarked",
          false,
          "x.removeBookmark",
        );
      },
      async follow({ account, userId, context }) {
        authorize(account, context);

        return confirmedWrite(
          await requireUserToken("x.follow")(
            `/2/users/${encodeURIComponent(account.accountId)}/following`,
            context,
            {
              target_user_id: userId,
            },
          ),
          "following",
          true,
          "x.follow",
        );
      },
      async unfollow({ account, userId, context }) {
        authorize(account, context);

        confirmedWrite(
          await requireUserToken("x.unfollow")(
            `/2/users/${encodeURIComponent(account.accountId)}/following/${encodeURIComponent(userId)}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
          "following",
          false,
          "x.unfollow",
        );
      },
      async listDirectMessages({
        account,
        participantId,
        conversationId,
        eventTypes,
        cursor,
        limit,
        context,
      }) {
        authorize(account, context);

        if (
          eventTypes !== undefined &&
          (eventTypes.length === 0 || eventTypes.some((type) => !xDmEventTypes.has(type)))
        )
          throw invalid(
            "messages.read",
            "eventTypes lists MessageCreate, ParticipantsJoin, or ParticipantsLeave.",
          );

        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.read",
            message: "X DM limits must be integers from 1 through 100.",
          });

        const path = conversationId
          ? `/2/dm_conversations/${encodeURIComponent(conversationId)}/dm_events`
          : participantId
            ? `/2/dm_conversations/with/${encodeURIComponent(participantId)}/dm_events`
            : "/2/dm_events";

        const result = object(
          await requireUserToken("x.listDirectMessages")(path, context, undefined, {
            "dm_event.fields":
              "id,text,event_type,created_at,dm_conversation_id,sender_id,participant_ids,attachments,entities",
            expansions: "sender_id,participant_ids",
            ...definedFields({
              event_types: eventTypes?.join(","),
              pagination_token: cursor,
              max_results: limit?.toString(),
            }),
          }),
        );

        const meta = result["meta"] === undefined ? {} : object(result["meta"]);

        const nextCursor = optionalString(meta["next_token"]);

        return {
          items: result["data"] === undefined ? [] : array(result["data"]).map(object),
          ...definedFields({
            nextCursor,
            metadata:
              result["includes"] === undefined
                ? undefined
                : { includes: object(result["includes"]) },
          }),
        };
      },
      async sendDirectMessage({ account, participantId, text, context }) {
        authorize(account, context);

        requireUserToken("messages.write");

        if (!text.trim())
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.write",
            message: "X direct messages require non-empty text.",
          });

        return dmWrite(
          `/2/dm_conversations/with/${encodeURIComponent(participantId)}/messages`,
          { text },
          context,
          "messages.write",
        );
      },
      async sendConversationMessage({ account, conversationId, text, attachments, context }) {
        authorize(account, context);

        if (
          attachments !== undefined &&
          (attachments.length > 1 ||
            attachments.some(
              (attachment) =>
                !isString(attachment["media_id"]) || !/^[0-9]{1,19}$/.test(attachment["media_id"]),
            ))
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.conversation.write",
            message: "X messages accept at most one attachment with a numeric media_id.",
          });

        if (!text.trim() && !attachments?.length)
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.conversation.write",
            message: "X direct messages require non-empty text or one media attachment.",
          });

        return dmWrite(
          `/2/dm_conversations/${encodeURIComponent(conversationId)}/messages`,
          { ...definedFields({ text: text.trim() ? text : undefined, attachments }) },
          context,
          "messages.conversation.write",
        );
      },
      async createGroupConversation({ account, participantIds, message, context }) {
        authorize(account, context);

        if (!message.trim())
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.group.write",
            message: "X direct messages require non-empty text.",
          });

        return dmWrite(
          "/2/dm_conversations",
          {
            conversation_type: "Group",
            participant_ids: [...participantIds],
            message: { text: message },
          },
          context,
          "messages.group.write",
        );
      },
      async getSpace({ account, spaceId, options: lookup, context }) {
        authorize(account, context);
        validateSpaceIds([spaceId], "spaceId", 1);

        return object(
          await readRequest(`/2/spaces/${encodeURIComponent(spaceId)}`)(
            `/2/spaces/${encodeURIComponent(spaceId)}`,
            context,
            undefined,
            spaceParams(lookup),
          ),
        );
      },
      async getSpaces({ account, spaceIds, options: lookup, context }) {
        authorize(account, context);
        validateSpaceIds(spaceIds, "spaceIds", 100);

        const result = object(
          await readRequest("/2/spaces")("/2/spaces", context, undefined, {
            ids: spaceIds.join(","),
            ...spaceParams(lookup),
          }),
        );

        const meta = result["meta"] === undefined ? undefined : object(result["meta"]);

        return {
          items: result["data"] === undefined ? [] : array(result["data"]).map(object),
          ...definedFields({
            nextCursor: meta === undefined ? undefined : optionalString(meta["next_token"]),
          }),
          ...definedFields({
            metadata: spaceMetadata(result),
          }),
        };
      },
      async getSpacesByCreators({ account, creatorIds, options: lookup, context }) {
        authorize(account, context);

        if (
          creatorIds.length < 1 ||
          creatorIds.length > 100 ||
          creatorIds.some((id) => !/^[0-9]{1,19}$/.test(id))
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "x.spaces.read",
            message: "creatorIds must contain 1-100 numeric X user IDs.",
          });

        const result = object(
          await readRequest("/2/spaces/by/creator_ids")(
            "/2/spaces/by/creator_ids",
            context,
            undefined,
            { user_ids: creatorIds.join(","), ...spaceParams(lookup) },
          ),
        );

        return {
          items: result["data"] === undefined ? [] : array(result["data"]).map(object),
          ...definedFields({
            metadata: spaceMetadata(result),
          }),
        };
      },
      async searchSpaces({ account, search, context }) {
        authorize(account, context);

        if (!search.query.trim())
          throw new SocialError({
            code: "invalid_input",
            operation: "x.spaces.read",
            message: "Space search query must be non-empty.",
          });

        if (
          search.limit !== undefined &&
          (!Number.isInteger(search.limit) || search.limit < 1 || search.limit > 100)
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "x.spaces.read",
            message: "Space search limits must be integers from 1 through 100.",
          });

        const result = object(
          await readRequest("/2/spaces/search")("/2/spaces/search", context, undefined, {
            query: search.query,
            ...definedFields({ state: search.state }),
            ...spaceParams(search),
            ...definedFields({ max_results: search.limit?.toString() }),
          }),
        );

        return {
          items: result["data"] === undefined ? [] : array(result["data"]).map(object),
          ...definedFields({
            metadata: spaceMetadata(result),
          }),
        };
      },
      async getUserById({ account, userId, context }) {
        authorize(account, context);

        const result = object(
          await readRequest("users")(`/2/users/${encodeURIComponent(userId)}`, context, undefined, {
            "user.fields":
              "id,name,username,description,created_at,public_metrics,profile_image_url,verified",
          }),
        );

        const errors = result["errors"];

        if (errors !== undefined && result["data"] === undefined) {
          const detail =
            array(errors)[0] === undefined
              ? "X user was not found."
              : (optionalString(object(array(errors)[0])["detail"]) ?? "X user was not found.");

          throw new SocialError({ code: "not_found", operation: "profiles.read", message: detail });
        }

        return result;
      },
      async getUserByUsername({ account, username, context }) {
        authorize(account, context);

        const result = object(
          await readRequest("users")(
            `/2/users/by/username/${encodeURIComponent(username)}`,
            context,
            undefined,
            {
              "user.fields":
                "id,name,username,description,created_at,public_metrics,profile_image_url,verified",
            },
          ),
        );

        if (result["errors"] !== undefined && result["data"] === undefined) {
          const first = array(result["errors"])[0];

          throw new SocialError({
            code: "not_found",
            operation: "profiles.read",
            message:
              first === undefined
                ? "X user was not found."
                : (optionalString(object(first)["detail"]) ?? "X user was not found."),
          });
        }

        return result;
      },
      async getMe({ account, context }) {
        authorize(account, context);

        return object(
          await readRequest("/2/users/me")("/2/users/me", context, undefined, {
            "user.fields":
              "id,name,username,description,created_at,public_metrics,profile_image_url,verified",
          }),
        );
      },
      async followers({ account, userId, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(userId)}/followers`,
          account,
          { cursor, limit },
          context,
        );
      },
      async following({ account, userId, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(userId)}/following`,
          account,
          { cursor, limit },
          context,
        );
      },
      async followUser({ account, userId, context }) {
        authorize(account, context);

        return confirmedWrite(
          await requireUserToken("graph.follow")(
            `/2/users/${encodeURIComponent(account.accountId)}/following`,
            context,
            {
              target_user_id: userId,
            },
          ),
          "following",
          true,
          "x.followUser",
        );
      },
      async unfollowUser({ account, userId, context }) {
        authorize(account, context);

        confirmedWrite(
          await requireUserToken("graph.unfollow")(
            `/2/users/${encodeURIComponent(account.accountId)}/following/${encodeURIComponent(userId)}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
          "following",
          false,
          "x.unfollowUser",
        );
      },
      async muteUser({ account, userId, context }) {
        authorize(account, context);

        return confirmedWrite(
          await requireUserToken("graph.mute")(
            `/2/users/${encodeURIComponent(account.accountId)}/muting`,
            context,
            {
              target_user_id: userId,
            },
          ),
          "muting",
          true,
          "x.muteUser",
        );
      },
      async unmuteUser({ account, userId, context }) {
        authorize(account, context);

        confirmedWrite(
          await requireUserToken("graph.unmute")(
            `/2/users/${encodeURIComponent(account.accountId)}/muting/${encodeURIComponent(userId)}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
          "muting",
          false,
          "x.unmuteUser",
        );
      },
      async mutedUsers({ account, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(account.accountId)}/muting`,
          account,
          { cursor, limit },
          context,
        );
      },
      async blockUser({ account, userId, context }) {
        authorize(account, context);

        return confirmedWrite(
          await requireUserToken("graph.block")(
            `/2/users/${encodeURIComponent(account.accountId)}/blocking`,
            context,
            {
              target_user_id: userId,
            },
          ),
          "blocking",
          true,
          "x.blockUser",
        );
      },
      async unblockUser({ account, userId, context }) {
        authorize(account, context);

        confirmedWrite(
          await requireUserToken("graph.unblock")(
            `/2/users/${encodeURIComponent(account.accountId)}/blocking/${encodeURIComponent(userId)}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
          "blocking",
          false,
          "x.unblockUser",
        );
      },
      async blockedUsers({ account, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(account.accountId)}/blocking`,
          account,
          { cursor, limit },
          context,
        );
      },
      async like({ account, postId, context }) {
        authorize(account, context);

        confirmedWrite(
          await requireUserToken("likes.write")(
            `/2/users/${encodeURIComponent(account.accountId)}/likes`,
            context,
            {
              tweet_id: postId,
            },
          ),
          "liked",
          true,
          "x.like",
        );
      },
      async unlike({ account, postId, context }) {
        authorize(account, context);

        confirmedWrite(
          await requireUserToken("likes.write")(
            `/2/users/${encodeURIComponent(account.accountId)}/likes/${encodeURIComponent(postId)}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
          "liked",
          false,
          "x.unlike",
        );
      },
      async likedPosts({ account, userId, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(userId ?? account.accountId)}/liked_tweets`,
          account,
          { cursor, limit },
          context,
          {},
          "id,name,username,description,created_at,public_metrics",
          "tweets",
        );
      },
      async likingUsers({ account, postId, cursor, limit, context }) {
        return pageRequest(
          `/2/tweets/${encodeURIComponent(postId)}/liking_users`,
          account,
          { cursor, limit },
          context,
          {},
          "id,name,username,description,created_at,public_metrics",
          "users",
        );
      },
      async createList({ account, name, description, isPrivate, context }) {
        authorize(account, context);

        return object(
          await requireUserToken("x.createList")("/2/lists", context, {
            name,
            ...definedFields({ description, private: isPrivate }),
          }),
        );
      },
      async updateList({ account, listId, name, description, isPrivate, context }) {
        authorize(account, context);

        return object(
          await requireUserToken("x.updateList")(
            `/2/lists/${encodeURIComponent(listId)}`,
            context,
            {
              ...definedFields({ name, description, private: isPrivate }),
            },
            {},
            "PUT",
          ),
        );
      },
      async deleteList({ account, listId, context }) {
        authorize(account, context);

        await requireUserToken("x.deleteList")(
          `/2/lists/${encodeURIComponent(listId)}`,
          context,
          undefined,
          {},
          "DELETE",
        );
      },
      async getList({ account, listId, context }) {
        authorize(account, context);

        return object(
          await readRequest("lists")(`/2/lists/${encodeURIComponent(listId)}`, context),
        );
      },
      async listMembers({ account, listId, cursor, limit, context }) {
        return pageRequest(
          `/2/lists/${encodeURIComponent(listId)}/members`,
          account,
          { cursor, limit },
          context,
          {},
          "id,name,username,description,created_at,public_metrics",
        );
      },
      async addListMember({ account, listId, userId, context }) {
        authorize(account, context);

        return object(
          await requireUserToken("x.addListMember")(
            `/2/lists/${encodeURIComponent(listId)}/members`,
            context,
            {
              user_id: userId,
            },
          ),
        );
      },
      async removeListMember({ account, listId, userId, context }) {
        authorize(account, context);

        await requireUserToken("x.removeListMember")(
          `/2/lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(userId)}`,
          context,
          undefined,
          {},
          "DELETE",
        );
      },
      async followList({ account, listId, context }) {
        authorize(account, context);

        return object(
          await requireUserToken("x.followList")(
            `/2/users/${encodeURIComponent(account.accountId)}/followed_lists`,
            context,
            { list_id: listId },
          ),
        );
      },
      async unfollowList({ account, listId, context }) {
        authorize(account, context);

        await requireUserToken("x.unfollowList")(
          `/2/users/${encodeURIComponent(account.accountId)}/followed_lists/${encodeURIComponent(listId)}`,
          context,
          undefined,
          {},
          "DELETE",
        );
      },
      async ownedLists({ account, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(account.accountId)}/owned_lists`,
          account,
          { cursor, limit },
          context,
          {},
          "id,name,description,private,member_count,follower_count",
        );
      },
      async pinList({ account, listId, context }) {
        authorize(account, context);

        return object(
          await requireUserToken("lists.pinned.write")(
            `/2/users/${encodeURIComponent(account.accountId)}/pinned_lists`,
            context,
            {
              list_id: listId,
            },
          ),
        );
      },
      async unpinList({ account, listId, context }) {
        authorize(account, context);

        await requireUserToken("lists.pinned.write")(
          `/2/users/${encodeURIComponent(account.accountId)}/pinned_lists/${encodeURIComponent(listId)}`,
          context,
          undefined,
          {},
          "DELETE",
        );
      },
      async pinnedLists({ account, cursor, limit, context }) {
        if (cursor !== undefined || limit !== undefined)
          throw new SocialError({
            code: "invalid_input",
            operation: "lists.pinned.read",
            message: "X returns the full pinned-list set; cursor and limit are not supported.",
          });
        authorize(account, context);

        const result = object(
          await readRequest("pinned_lists")(
            `/2/users/${encodeURIComponent(account.accountId)}/pinned_lists`,
            context,
            undefined,
            { "list.fields": "id,name,description,private,member_count,follower_count" },
          ),
        );

        return { items: result["data"] === undefined ? [] : array(result["data"]).map(object) };
      },
      async listPosts({ account, listId, cursor, limit, context }) {
        return pageRequest(
          `/2/lists/${encodeURIComponent(listId)}/tweets`,
          account,
          { cursor, limit },
          context,
          {},
          "id,name,username,description,created_at,public_metrics",
          "tweets",
        );
      },
      async userPosts({ account, userId, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(userId)}/tweets`,
          account,
          { cursor, limit },
          context,
          {},
          "id,name,username,description,created_at,public_metrics",
          "tweets",
        );
      },
      async homeTimeline({ account, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(account.accountId)}/timelines/reverse_chronological`,
          account,
          { cursor, limit },
          context,
          {},
          "id,name,username,description,created_at,public_metrics",
          "tweets",
        );
      },
      async mentions({ account, userId, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(userId ?? account.accountId)}/mentions`,
          account,
          { cursor, limit },
          context,
          {},
          "id,name,username,description,created_at,public_metrics",
          "tweets",
        );
      },
      async undoRepost({ account, postId, context }) {
        authorize(account, context);

        confirmedWrite(
          await requireUserToken("x.undoRepost")(
            `/2/users/${encodeURIComponent(account.accountId)}/retweets/${encodeURIComponent(postId)}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
          "retweeted",
          false,
          "x.undoRepost",
        );
      },
      async listStreamRules({ account, ids, cursor, limit, context }) {
        authorize(account, context);

        if (ids !== undefined) validateRuleIds(ids, "x.streamRules.list", 1000);

        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000))
          throw new SocialError({
            code: "invalid_input",
            operation: "x.streamRules.list",
            message: "X stream rule limits must be integers from 1 through 1000.",
          });

        const result = object(
          await appRequest()("/2/tweets/search/stream/rules", context, undefined, {
            ...definedFields({
              ids: ids?.join(","),
              pagination_token: cursor,
              max_results: limit === undefined ? undefined : String(limit),
            }),
          }),
        );

        const items = (result["data"] === undefined ? [] : array(result["data"])).map((entry) =>
          parseStreamRule(object(entry), "x.streamRules.list"),
        );

        const meta = result["meta"] === undefined ? {} : object(result["meta"]);
        const nextCursor = optionalString(meta["next_token"]);

        return { items, ...definedFields({ nextCursor }) };
      },
      async addStreamRules({ account, rules, dryRun = false, context }) {
        authorize(account, context);

        if (rules.length === 0)
          throw new SocialError({
            code: "invalid_input",
            operation: "x.streamRules.add",
            message: "Provide at least one X filtered-stream rule to add.",
          });

        for (const rule of rules) validateRuleInput(rule);

        const result = await appRequest()(
          "/2/tweets/search/stream/rules",
          context,
          {
            add: rules.map((rule) => ({
              value: rule.value,
              ...definedFields({ tag: rule.tag }),
            })),
          },
          dryRun ? { dry_run: "true" } : {},
        );

        return parseRulesUpdate(object(result), dryRun);
      },
      async deleteStreamRules({ account, ids, dryRun = false, context }) {
        authorize(account, context);
        validateRuleIds(ids, "x.streamRules.delete", 1000);

        const result = await appRequest()(
          "/2/tweets/search/stream/rules",
          context,
          { delete: { ids: [...ids] } },
          dryRun ? { dry_run: "true" } : {},
        );

        return parseRulesUpdate(object(result), dryRun);
      },
      async *activityStream({ account, context, ...streamOptions }) {
        authorize(account, context);

        const target: StreamTarget = {
          url: activityStreamUrl(streamOptions),
          name: "activity stream",
          denied:
            "X denied the activity stream. It needs an app-only bearer token and X Activity API access; create subscriptions first.",
          stallTimeoutMs: streamOptions.stallTimeoutMs,
        };

        yield* readDataStream(
          { bearerToken: streamBearer("activity stream"), fetch: options.fetch },
          target,
          context,
        );
      },
      async *volumeStream({ account, stream, context, ...streamOptions }) {
        authorize(account, context);

        const target: StreamTarget = {
          url: volumeStreamUrl(stream, streamOptions),
          name: `${stream} stream`,
          denied: `X denied the ${stream} stream. Volume streams need Enterprise access and an app-only bearer token.`,
          stallTimeoutMs: streamOptions.stallTimeoutMs,
        };

        yield* readDataStream(
          { bearerToken: streamBearer(`${stream} stream`), fetch: options.fetch },
          target,
          context,
        );
      },
      async *complianceStream({ account, stream, context, ...streamOptions }) {
        authorize(account, context);

        const target: StreamTarget = {
          url: complianceStreamUrl(stream, streamOptions),
          name: `${stream} compliance stream`,
          denied: `X denied the ${stream} compliance stream. Compliance streams need Enterprise access and an app-only bearer token.`,
          stallTimeoutMs: streamOptions.stallTimeoutMs,
        };

        yield* readDataStream(
          { bearerToken: streamBearer(`${stream} compliance stream`), fetch: options.fetch },
          target,
          context,
        );
      },
      async deleteAllStreamRules({ account, dryRun = false, context }) {
        authorize(account, context);

        const result = await appRequest()(
          "/2/tweets/search/stream/rules",
          context,
          {},
          { delete_all: "true", ...definedFields({ dry_run: dryRun ? "true" : undefined }) },
        );

        return parseRulesUpdate(object(result), dryRun);
      },
      async *stream({ account, context, ...streamOptions }) {
        authorize(account, context);
        const bearerToken = options.appBearerToken;

        if (!bearerToken?.trim())
          throw new SocialError({
            code: "missing_permission",
            operation: "streams.read",
            message:
              "The X filtered stream requires an app-only bearer token. Configure appBearerToken.",
          });

        yield* readFilteredStream({ bearerToken, fetch: options.fetch }, streamOptions, context);
      },
      async hideReply({ account, replyId, hidden, context }) {
        authorize(account, context);

        if (!/^[0-9]{1,19}$/.test(replyId))
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.moderate",
            message: "X reply IDs are numeric strings of 1 to 19 digits.",
            retryDisposition: { kind: "never" },
          });

        const result = object(
          await requireUserToken("comments.moderate")(
            `/2/tweets/${encodeURIComponent(replyId)}/hidden`,
            context,
            { hidden },
            {},
            "PUT",
          ),
        );

        const state =
          result["data"] === undefined
            ? undefined
            : optionalBoolean(object(result["data"])["hidden"]);

        if (state === undefined)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "comments.moderate",
            message: "X did not report the reply's hidden state.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return { hidden: state };
      },
      async getPosts({ account, postIds, fields, context }) {
        requireIds(postIds, "postIds", "x.posts.lookup");

        return pageFrom(
          await xRead({
            account,
            context,
            path: "/2/tweets",
            operation: "x.posts.lookup",
            credential: "user-or-app",
            query: { ids: postIds.join(","), ...postFieldQuery(fields) },
          }),
        );
      },
      async quotePosts({ account, postId, exclude, fields, cursor, limit, context }) {
        requireId(postId, "postId", "x.posts.quotes");

        return xReadPage({
          account,
          context,
          path: `/2/tweets/${postId}/quote_tweets`,
          operation: "x.posts.quotes",
          credential: "user-or-app",
          query: {
            ...postFieldQuery(fields),
            ...definedFields({ exclude: exclude?.join(",") }),
          },
          cursor,
          limit,
          minLimit: 10,
          maxLimit: 100,
        });
      },
      async repostedBy({ account, postId, userFields, cursor, limit, context }) {
        requireId(postId, "postId", "x.posts.repostedBy");

        return xReadPage({
          account,
          context,
          path: `/2/tweets/${postId}/retweeted_by`,
          operation: "x.posts.repostedBy",
          credential: "user-or-app",
          query: userFieldQuery(userFields),
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 100,
        });
      },
      async reposts({ account, postId, fields, cursor, limit, context }) {
        requireId(postId, "postId", "x.posts.reposts");

        return xReadPage({
          account,
          context,
          path: `/2/tweets/${postId}/retweets`,
          operation: "x.posts.reposts",
          credential: "user-or-app",
          query: postFieldQuery(fields),
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 100,
        });
      },
      async repostsOfMe({ account, fields, cursor, limit, context }) {
        return xReadPage({
          account,
          context,
          path: "/2/users/reposts_of_me",
          operation: "x.posts.repostsOfMe",
          credential: "user",
          query: postFieldQuery(fields),
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 100,
        });
      },
      async getUsers({ account, userIds, userFields, context }) {
        requireIds(userIds, "userIds", "x.users.lookup");

        return pageFrom(
          await xRead({
            account,
            context,
            path: "/2/users",
            operation: "x.users.lookup",
            credential: "user-or-app",
            query: { ids: userIds.join(","), ...userFieldQuery(userFields) },
          }),
        );
      },
      async getUsersByUsernames({ account, usernames, userFields, context }) {
        requireIds(usernames, "usernames", "x.users.lookup", /^[A-Za-z0-9_]{1,15}$/);

        return pageFrom(
          await xRead({
            account,
            context,
            path: "/2/users/by",
            operation: "x.users.lookup",
            credential: "user-or-app",
            query: { usernames: usernames.join(","), ...userFieldQuery(userFields) },
          }),
        );
      },
      async searchUsers({ account, query, userFields, cursor, limit, context }) {
        if (!/^[A-Za-z0-9_' ]{1,50}$/.test(query) || !query.trim())
          throw invalid(
            "x.users.search",
            "X user search queries are 1-50 letters, digits, underscores, apostrophes, or spaces.",
          );

        return xReadPage({
          account,
          context,
          path: "/2/users/search",
          operation: "x.users.search",
          credential: "user",
          query: { query, ...userFieldQuery(userFields) },
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 1000,
          cursorParam: "next_token",
        });
      },
      async countRecentPosts({ account, counts, context }) {
        return postCounts("recent", account, counts, context);
      },
      async countAllPosts({ account, counts, context }) {
        return postCounts("all", account, counts, context);
      },
      async affiliates({ account, userId, userFields, cursor, limit, context }) {
        requireId(userId, "userId", "x.users.affiliates");

        return xReadPage({
          account,
          context,
          path: `/2/users/${userId}/affiliates`,
          operation: "x.users.affiliates",
          credential: "user-or-app",
          query: userFieldQuery(userFields),
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 1000,
        });
      },
      async listFollowers({ account, listId, userFields, cursor, limit, context }) {
        requireId(listId, "listId", "x.lists.followers");

        return xReadPage({
          account,
          context,
          path: `/2/lists/${listId}/followers`,
          operation: "x.lists.followers",
          credential: "user-or-app",
          query: userFieldQuery(userFields),
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 100,
        });
      },
      async listMemberships({ account, userId, cursor, limit, context }) {
        const member = userId ?? account.accountId;

        requireId(member, "userId", "x.lists.memberships");

        return xReadPage({
          account,
          context,
          path: `/2/users/${member}/list_memberships`,
          operation: "x.lists.memberships",
          credential: "user-or-app",
          query: {
            "list.fields": "id,name,description,private,member_count,follower_count",
            expansions: "owner_id",
          },
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 100,
        });
      },
      async bookmarkFolders({ account, cursor, limit, context }) {
        const page = await xReadPage({
          account,
          context,
          path: `/2/users/${encodeURIComponent(account.accountId)}/bookmarks/folders`,
          operation: "x.bookmarks.folders",
          credential: "user",
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 100,
        });

        return { ...page, items: page.items.map(bookmarkFolder) };
      },
      async createBookmarkFolder({ account, name, context }) {
        authorize(account, context);

        if ([...name].length < 1 || [...name].length > 25 || !name.trim())
          throw invalid("x.bookmarks.folders.create", "Bookmark folder names are 1-25 characters.");

        const result = object(
          await requireUserToken("x.bookmarks.folders.create")(
            `/2/users/${encodeURIComponent(account.accountId)}/bookmarks/folders`,
            context,
            { name },
          ),
        );

        if (result["data"] === undefined)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "x.bookmarks.folders.create",
            message: "X did not return the created bookmark folder. List folders before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return bookmarkFolder(result["data"]);
      },
      async bookmarksByFolder({ account, folderId, cursor, limit, context }) {
        requireId(folderId, "folderId", "x.bookmarks.folder");

        return xReadPage({
          account,
          context,
          path: `/2/users/${encodeURIComponent(account.accountId)}/bookmarks/folders/${folderId}`,
          operation: "x.bookmarks.folder",
          credential: "user",
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 100,
        });
      },
      async spacePosts({ account, spaceId, fields, cursor, limit, context }) {
        validateSpaceIds([spaceId], "spaceId", 1);

        return xReadPage({
          account,
          context,
          path: `/2/spaces/${spaceId}/tweets`,
          operation: "x.spaces.posts",
          credential: "user-or-app",
          query: postFieldQuery(fields),
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 100,
        });
      },
      async spaceBuyers({ account, spaceId, userFields, cursor, limit, context }) {
        validateSpaceIds([spaceId], "spaceId", 1);

        return xReadPage({
          account,
          context,
          path: `/2/spaces/${spaceId}/buyers`,
          operation: "x.spaces.buyers",
          credential: "user",
          query: userFieldQuery(userFields),
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 100,
        });
      },
      async getCommunity({ account, communityId, communityFields, context }) {
        requireId(communityId, "communityId", "x.communities.lookup");

        return xRead({
          account,
          context,
          path: `/2/communities/${communityId}`,
          operation: "x.communities.lookup",
          credential: "user-or-app",
          query: definedFields({ "community.fields": communityFields?.join(",") }),
        });
      },
      async searchCommunities({ account, query, communityFields, cursor, limit, context }) {
        if (!query.trim() || query.length > 4096)
          throw invalid("x.communities.search", "Community search queries are 1-4096 characters.");

        return xReadPage({
          account,
          context,
          path: "/2/communities/search",
          operation: "x.communities.search",
          credential: "user",
          query: { query, ...definedFields({ "community.fields": communityFields?.join(",") }) },
          cursor,
          limit,
          minLimit: 10,
          maxLimit: 100,
          cursorParam: "next_token",
        });
      },
      async trends({ account, woeid, maxTrends, context }) {
        if (!Number.isSafeInteger(woeid) || woeid < 1)
          throw invalid("x.trends", "woeid must be a positive integer WOEID.");

        if (
          maxTrends !== undefined &&
          (!Number.isSafeInteger(maxTrends) || maxTrends < 1 || maxTrends > 50)
        )
          throw invalid("x.trends", "maxTrends must be an integer from 1 through 50.");

        const result = await xRead({
          account,
          context,
          path: `/2/trends/by/woeid/${woeid}`,
          operation: "x.trends",
          credential: "user-or-app",
          query: {
            "trend.fields": "trend_name,tweet_count",
            ...definedFields({ max_trends: maxTrends?.toString() }),
          },
        });

        return (result["data"] === undefined ? [] : array(result["data"])).map((entry) => {
          const row = object(entry);

          return {
            name: string(row["trend_name"]),
            ...definedFields({ postCount: optionalNumber(row["tweet_count"]) }),
          };
        });
      },
      async personalizedTrends({ account, context }) {
        const result = await xRead({
          account,
          context,
          path: "/2/users/personalized_trends",
          operation: "x.trends.personalized",
          credential: "user",
          query: { "personalized_trend.fields": "category,post_count,trend_name,trending_since" },
        });

        return (result["data"] === undefined ? [] : array(result["data"])).map((entry) => {
          const row = object(entry);

          return {
            name: string(row["trend_name"]),
            ...definedFields({
              category: optionalString(row["category"]),
              postCount: optionalString(row["post_count"]),
              trendingSince: optionalString(row["trending_since"]),
            }),
          };
        });
      },
      async postUsage({ account, days, usageFields, context }) {
        if (days !== undefined && (!Number.isSafeInteger(days) || days < 1 || days > 90))
          throw invalid("x.usage.posts", "days must be an integer from 1 through 90.");

        return xRead({
          account,
          context,
          path: "/2/usage/tweets",
          operation: "x.usage.posts",
          credential: "app",
          query: definedFields({
            days: days?.toString(),
            "usage.fields": usageFields?.join(","),
          }),
        });
      },
      async creditBalance({ account, context }) {
        const data = object(
          (
            await xRead({
              account,
              context,
              path: "/2/usage/credits",
              operation: "x.usage.credits",
              credential: "user-or-app",
            })
          )["data"],
        );

        const amount = (value: JsonField) => {
          const parsed = optionalNumber(value);

          if (parsed === undefined)
            throw new HttpError("X credit balance is not a number.", "invalid-response", true);

          return parsed;
        };

        return {
          totalBalance: amount(data["total_balance"]),
          prepaidBalance: amount(data["prepaid_balance"]),
          freeBalance: amount(data["free_balance"]),
          freeGrants: array(data["free_grants"]).map((entry) => {
            const grant = object(entry);

            return {
              amount: amount(grant["amount"]),
              ...definedFields({ expiresAt: optionalString(grant["expires_at"]) }),
            };
          }),
        };
      },
      async getMedia({ account, mediaKeys, mediaFields, context }) {
        requireIds(mediaKeys, "mediaKeys", "x.media.lookup", /^[0-9]+_[0-9]+$/);

        return pageFrom(
          await xRead({
            account,
            context,
            path: "/2/media",
            operation: "x.media.lookup",
            credential: "user-or-app",
            query: {
              media_keys: mediaKeys.join(","),
              "media.fields": mediaFields?.join(",") ?? defaultMediaFields,
            },
          }),
        );
      },
      async uploadDmMedia({ account, media, kind, mimeType, additionalOwners, context }) {
        authorize(account, context);
        requireAdditionalOwners(additionalOwners, "x.media.dm");

        const limit = dmMediaLimits[kind];

        const mediaType = mimeType ?? media.type;

        const accepted =
          kind === "gif"
            ? mediaType === "image/gif"
            : kind === "image"
              ? xStaticImageMimeTypes.has(mediaType)
              : xVideoMimeTypes.has(mediaType);

        if (!accepted)
          throw invalid(
            "x.media.dm",
            `The ${kind} MIME type ${mediaType || "(none)"} is not accepted.`,
          );

        if (media.size <= 0 || media.size > limit.maxBytes)
          throw invalid("x.media.dm", `X DM ${kind} uploads must be 1 to ${limit.maxBytes} bytes.`);

        return {
          mediaId: await uploadChunks(
            {
              blob: media,
              category: limit.category,
              mediaType,
              ...definedFields({ additionalOwners }),
            },
            context,
          ),
        };
      },
      async uploadSubtitles({ account, file, format, context }) {
        authorize(account, context);

        if (file.size <= 0) throw invalid("x.media.subtitles", "Subtitle files must not be empty.");

        return {
          mediaId: await uploadChunks(
            {
              blob: file,
              category: "subtitles",
              mediaType: format === "srt" ? "text/srt" : "text/vtt",
            },
            context,
          ),
        };
      },
      async attachSubtitles({
        account,
        videoMediaId,
        subtitleMediaId,
        languageCode,
        displayName,
        mediaCategory = "TweetVideo",
        context,
      }) {
        authorize(account, context);
        requireId(videoMediaId, "videoMediaId", "x.media.subtitles");
        requireId(subtitleMediaId, "subtitleMediaId", "x.media.subtitles");

        if (!/^[A-Z]{2}$/.test(languageCode))
          throw invalid(
            "x.media.subtitles",
            "languageCode must be two uppercase letters, such as EN.",
          );

        const result = object(
          await requireUserToken("x.media.subtitles")("/2/media/subtitles", context, {
            id: videoMediaId,
            media_category: mediaCategory,
            subtitles: {
              id: subtitleMediaId,
              language_code: languageCode,
              ...definedFields({ display_name: displayName }),
            },
          }),
        );

        return result["data"] === undefined ? {} : object(result["data"]);
      },
      async deleteSubtitles({
        account,
        videoMediaId,
        languageCode,
        mediaCategory = "TweetVideo",
        context,
      }) {
        authorize(account, context);
        requireId(videoMediaId, "videoMediaId", "x.media.subtitles");

        if (!/^[A-Z]{2}$/.test(languageCode))
          throw invalid(
            "x.media.subtitles",
            "languageCode must be two uppercase letters, such as EN.",
          );

        confirmedWrite(
          await requireUserToken("x.media.subtitles")(
            "/2/media/subtitles",
            context,
            { id: videoMediaId, media_category: mediaCategory, language_code: languageCode },
            {},
            "DELETE",
          ),
          "deleted",
          true,
          "x.media.subtitles",
        );
      },
      async privatePostMetrics({ account, postIds, context }) {
        requireIds(postIds, "postIds", "x.analytics.private");

        const result = await xRead({
          account,
          context,
          path: "/2/tweets",
          operation: "x.analytics.private",
          credential: "user",
          query: {
            ids: postIds.join(","),
            "tweet.fields": "id,author_id,non_public_metrics,organic_metrics",
          },
        });

        return (result["data"] === undefined ? [] : array(result["data"])).map((entry) => {
          const row = object(entry);

          if (row["author_id"] !== account.accountId)
            throw new SocialError({
              code: "unauthorized",
              operation: "x.analytics.private",
              message: "X returned private metrics for a Post owned by a different account.",
            });

          return {
            postId: string(row["id"]),
            nonPublic: numericMetrics(row["non_public_metrics"]),
            organic: numericMetrics(row["organic_metrics"]),
          };
        });
      },
      async postAnalytics({ account, postIds, startTime, endTime, granularity, fields, context }) {
        requireIds(postIds, "postIds", "x.analytics.posts");
        requireWindow(startTime, endTime, "x.analytics.posts");

        return pageFrom(
          await xRead({
            account,
            context,
            path: "/2/tweets/analytics",
            operation: "x.analytics.posts",
            credential: "user",
            query: {
              ids: postIds.join(","),
              start_time: startTime,
              end_time: endTime,
              ...definedFields({
                granularity,
                "analytics.fields": fields?.join(","),
              }),
            },
          }),
        );
      },
      async mediaAnalytics({
        account,
        mediaKeys,
        startTime,
        endTime,
        granularity,
        fields,
        context,
      }) {
        requireIds(mediaKeys, "mediaKeys", "x.analytics.media", /^[0-9]+_[0-9]+$/);
        requireWindow(startTime, endTime, "x.analytics.media");

        return pageFrom(
          await xRead({
            account,
            context,
            path: "/2/media/analytics",
            operation: "x.analytics.media",
            credential: "user",
            query: {
              media_keys: mediaKeys.join(","),
              start_time: startTime,
              end_time: endTime,
              ...definedFields({
                granularity,
                "media_analytics.fields": fields?.join(","),
              }),
            },
          }),
        );
      },
      async getDirectMessage({ account, eventId, context }) {
        requireId(eventId, "eventId", "messages.read");

        return xRead({
          account,
          context,
          path: `/2/dm_events/${eventId}`,
          operation: "messages.read",
          credential: "user",
          query: {
            "dm_event.fields":
              "id,text,event_type,created_at,dm_conversation_id,attachments,entities",
            expansions: "sender_id,attachments.media_keys",
          },
        });
      },
      async deleteDirectMessage({ account, eventId, context }) {
        authorize(account, context);
        requireId(eventId, "eventId", "messages.delete");

        confirmedWrite(
          await requireUserToken("messages.delete")(
            `/2/dm_events/${eventId}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
          "deleted",
          true,
          "messages.delete",
        );
      },
      async downloadDmMedia({
        account,
        dmId,
        mediaId,
        resourceId,
        maxBytes = 15 * 1024 * 1024,
        context,
      }) {
        authorize(account, context);

        for (const [name, value] of [
          ["dmId", dmId],
          ["mediaId", mediaId],
          ["resourceId", resourceId],
        ] as const)
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(value))
            throw invalid("messages.media", `${name} must be 1-128 letters, digits, _ or -.`);

        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024)
          throw invalid("messages.media", "maxBytes must be an integer from 1 through 1 GiB.");

        return downloadBytes(
          `/2/dm_conversations/media/${dmId}/${mediaId}/${resourceId}`,
          maxBytes,
          context,
          "messages.media",
        );
      },
      async blockDms({ account, userId, context }) {
        authorize(account, context);
        requireId(userId, "userId", "messages.block");

        confirmedWrite(
          await requireUserToken("messages.block")(
            `/2/users/${userId}/dm/block`,
            context,
            undefined,
            {},
            "POST",
          ),
          "blocked",
          true,
          "messages.block",
        );
      },
      async streamRuleCounts({ account, context }) {
        const data = object(
          (
            await xRead({
              account,
              context,
              path: "/2/tweets/search/stream/rules/counts",
              operation: "x.streamRules.counts",
              credential: "app",
            })
          )["data"],
        );

        const count = (value: JsonField) => {
          const parsed = optionalNumber(value);

          if (parsed === undefined)
            throw new HttpError("X rule counts are incomplete.", "invalid-response", true);

          return parsed;
        };

        return {
          projectRulesCount: count(data["project_rules_count"]),
          clientAppRulesCount: count(data["client_app_rules_count"]),
          capPerProject: count(data["cap_per_project"]),
          capPerClientApp: count(data["cap_per_client_app"]),
        };
      },
      async streamWebhooks({ account, context }) {
        return pageFrom(
          await xRead({
            account,
            context,
            path: "/2/tweets/search/webhooks",
            operation: "x.streamWebhooks.list",
            credential: "app",
          }),
        );
      },
      async linkStreamWebhook({ account, webhookId, context }) {
        authorize(account, context);
        requireId(webhookId, "webhookId", "x.streamWebhooks.link");

        confirmedWrite(
          await appRequest()(
            `/2/tweets/search/webhooks/${webhookId}`,
            context,
            undefined,
            {},
            "POST",
          ),
          "provisioned",
          true,
          "x.streamWebhooks.link",
        );
      },
      async unlinkStreamWebhook({ account, webhookId, context }) {
        authorize(account, context);
        requireId(webhookId, "webhookId", "x.streamWebhooks.unlink");

        confirmedWrite(
          await appRequest()(
            `/2/tweets/search/webhooks/${webhookId}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
          "deleted",
          true,
          "x.streamWebhooks.unlink",
        );
      },
      async streamConnections({ account, status, endpoints, cursor, limit, context }) {
        return xReadPage({
          account,
          context,
          path: "/2/connections",
          operation: "x.connections.list",
          credential: "app",
          query: {
            "connection.fields":
              "id,endpoint_name,client_ip,connected_at,disconnected_at,disconnect_reason",
            ...definedFields({ status, endpoints: endpoints?.join(",") }),
          },
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 100,
        });
      },
      async terminateStreamConnections({ account, target, context }) {
        authorize(account, context);

        let result: JsonValue;

        switch (target.kind) {
          case "uuids":
            if (
              target.uuids.length < 1 ||
              target.uuids.length > 100 ||
              target.uuids.some((uuid) => !/^[A-Za-z0-9-]{1,64}$/.test(uuid))
            )
              throw invalid("x.connections.terminate", "uuids must list 1-100 connection UUIDs.");

            result = await appRequest()(
              "/2/connections",
              context,
              { uuids: [...target.uuids] },
              {},
              "DELETE",
            );
            break;
          case "endpoint":
            result = await appRequest()(
              `/2/connections/${target.endpoint}`,
              context,
              undefined,
              {},
              "DELETE",
            );
            break;
          case "all":
            result = await appRequest()("/2/connections/all", context, undefined, {}, "DELETE");
            break;
          default: {
            const _exhaustive: never = target;

            throw invalid("x.connections.terminate", `Unknown target ${String(_exhaustive)}.`);
          }
        }

        const data = object(object(result)["data"]);

        const total = (value: JsonField) => {
          const parsed = optionalNumber(value);

          if (parsed === undefined)
            throw new HttpError(
              "X did not report terminated connections.",
              "invalid-response",
              true,
            );

          return parsed;
        };

        return {
          successful: total(data["successful_kills"]),
          failed: total(data["failed_kills"]),
          results: (data["results"] === undefined ? [] : array(data["results"])).map((entry) => {
            const row = object(entry);

            return {
              uuid: string(row["uuid"]),
              success: optionalBoolean(row["success"]) === true,
            };
          }),
        };
      },
      async listWebhooks({ account, context }) {
        const result = await xRead({
          account,
          context,
          path: "/2/webhooks",
          operation: "x.webhooks.list",
          credential: "app-or-user",
          query: { "webhook_config.fields": "id,url,valid,created_at" },
        });

        return (result["data"] === undefined ? [] : array(result["data"])).map(webhookConfig);
      },
      async createWebhook({ account, url, context }) {
        authorize(account, context);

        if (!isHttpsUrl(url) || url.length > 200)
          throw invalid(
            "x.webhooks.create",
            "Webhook URLs must be HTTPS and at most 200 characters.",
          );

        return webhookConfig(
          object(
            await credentialRequest("app-or-user", "x.webhooks.create")("/2/webhooks", context, {
              url,
            }),
          )["data"],
        );
      },
      async validateWebhook({ account, webhookId, context }) {
        authorize(account, context);
        requireId(webhookId, "webhookId", "x.webhooks.validate");

        const data = object(
          object(
            await credentialRequest("app-or-user", "x.webhooks.validate")(
              `/2/webhooks/${webhookId}`,
              context,
              undefined,
              {},
              "PUT",
            ),
          )["data"],
        );

        const valid = optionalBoolean(data["valid"]);

        if (valid === undefined)
          throw new HttpError("X did not report the webhook check.", "invalid-response", true);

        return { valid };
      },
      async deleteWebhook({ account, webhookId, context }) {
        authorize(account, context);
        requireId(webhookId, "webhookId", "x.webhooks.delete");

        confirmedWrite(
          await credentialRequest("app-or-user", "x.webhooks.delete")(
            `/2/webhooks/${webhookId}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
          "deleted",
          true,
          "x.webhooks.delete",
        );
      },
      async replayWebhook({ account, webhookId, from, to, context }) {
        authorize(account, context);
        requireId(webhookId, "webhookId", "x.webhooks.replay");
        requireWindow(from, to, "x.webhooks.replay");

        // X takes yyyymmddhhmm in UTC.
        const minute = (value: string) =>
          new Date(Date.parse(value)).toISOString().slice(0, 16).replaceAll(/[-T:]/g, "");

        const data = object(
          object(
            await appRequest()("/2/webhooks/replay", context, {
              webhook_id: webhookId,
              from_date: minute(from),
              to_date: minute(to),
            }),
          )["data"],
        );

        return { jobId: string(data["job_id"]), createdAt: string(data["created_at"]) };
      },
      async createActivitySubscription({
        account,
        eventType,
        filter,
        webhookId,
        tag,
        expiresAt,
        context,
      }) {
        authorize(account, context);

        const operation = "x.activity.subscribe";

        if (filter.userId !== undefined) requireId(filter.userId, "filter.userId", operation);

        if (webhookId !== undefined) requireId(webhookId, "webhookId", operation);

        if (tag !== undefined && (tag.length < 1 || tag.length > 200))
          throw invalid(operation, "tag must be 1-200 characters.");

        if (expiresAt !== undefined && !Number.isFinite(Date.parse(expiresAt)))
          throw invalid(operation, "expiresAt must be an RFC 3339 timestamp.");

        if (filter.qualifiers !== undefined && Object.keys(filter.qualifiers).length > 8)
          throw invalid(operation, "X accepts at most 8 filter qualifiers.");

        return object(
          await credentialRequest("user-or-app", operation)("/2/activity/subscriptions", context, {
            event_type: eventType,
            filter: {
              ...definedFields({
                user_id: filter.userId,
                keyword: filter.keyword,
                direction: filter.direction,
                qualifiers: filter.qualifiers === undefined ? undefined : { ...filter.qualifiers },
              }),
            },
            ...definedFields({ webhook_id: webhookId, tag, expires_at: expiresAt }),
          }),
        );
      },
      async listActivitySubscriptions({ account, userId, cursor, limit, context }) {
        if (userId !== undefined) requireId(userId, "userId", "x.activity.list");

        return xReadPage({
          account,
          context,
          path: "/2/activity/subscriptions",
          operation: "x.activity.list",
          credential: "user-or-app",
          query: definedFields({ user_id: userId }),
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 1000,
        });
      },
      async updateActivitySubscription({ account, subscriptionId, tag, webhookId, context }) {
        authorize(account, context);

        const operation = "x.activity.update";

        requireId(subscriptionId, "subscriptionId", operation);

        if (webhookId !== undefined) requireId(webhookId, "webhookId", operation);

        if (tag === undefined && webhookId === undefined)
          throw invalid(operation, "Set tag or webhookId to update a subscription.");

        return object(
          await credentialRequest("user-or-app", operation)(
            `/2/activity/subscriptions/${subscriptionId}`,
            context,
            { ...definedFields({ tag, webhook_id: webhookId }) },
            {},
            "PUT",
          ),
        );
      },
      async deleteActivitySubscriptions({ account, subscriptionIds, context }) {
        authorize(account, context);
        requireIds(subscriptionIds, "subscriptionIds", "x.activity.delete");

        const [single] = subscriptionIds;

        return object(
          subscriptionIds.length === 1 && single !== undefined
            ? await credentialRequest("user-or-app", "x.activity.delete")(
                `/2/activity/subscriptions/${single}`,
                context,
                undefined,
                {},
                "DELETE",
              )
            : await appRequest()(
                "/2/activity/subscriptions",
                context,
                undefined,
                { ids: subscriptionIds.join(",") },
                "DELETE",
              ),
        );
      },
      async createArticleDraft({ account, title, blocks, entities = [], coverMedia, context }) {
        authorize(account, context);

        const operation = "x.articles.draft";

        if (!title.trim()) throw invalid(operation, "Article titles must not be empty.");

        if (coverMedia !== undefined)
          requireId(coverMedia.mediaId, "coverMedia.mediaId", operation);

        const contentState = articleContentState(blocks, entities);

        const data = object(
          object(
            await requireUserToken(operation)("/2/articles/draft", context, {
              title,
              content_state: contentState,
              ...definedFields({
                cover_media:
                  coverMedia === undefined
                    ? undefined
                    : {
                        media_id: coverMedia.mediaId,
                        media_category: coverMedia.mediaCategory ?? "tweet_image",
                      },
              }),
            }),
          )["data"],
        );

        return { articleId: string(data["id"]), title: optionalString(data["title"]) ?? title };
      },
      async publishArticle({ account, articleId, context }) {
        authorize(account, context);
        requireId(articleId, "articleId", "x.articles.publish");

        const result = await requireUserToken("x.articles.publish")(
          `/2/articles/${articleId}/publish`,
          context,
          undefined,
          {},
          "POST",
        );

        const data = isJsonObject(result) ? result["data"] : undefined;

        const postId = isJsonObject(data) ? optionalString(data["post_id"]) : undefined;

        if (postId === undefined)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "x.articles.publish",
            message:
              "X did not return the published Article's post ID. Check the profile before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return {
          kind: "platform-post",
          version: 1,
          backend: account.backend,
          platform: "x",
          accountId: account.accountId,
          postId,
        };
      },
      async chatConversations({
        account,
        unreadOnly,
        type,
        participantQuery,
        participantIds,
        archived,
        muted,
        cursor,
        limit,
        context,
      }) {
        if (
          participantQuery !== undefined &&
          (!participantQuery.trim() || participantQuery.length > 50)
        )
          throw invalid("x.chat.conversations", "participantQuery is 1-50 characters.");

        if (
          participantIds !== undefined &&
          (participantIds.length < 1 || participantIds.length > 10)
        )
          throw invalid("x.chat.conversations", "participantIds lists 1-10 user IDs.");

        if (participantIds !== undefined)
          requireIds(participantIds, "participantIds", "x.chat.conversations");

        return xReadPage({
          account,
          context,
          path: "/2/chat/conversations",
          operation: "x.chat.conversations",
          credential: "user",
          query: {
            "chat_conversation.fields":
              "id,type,created_at,updated_at,unread,last_read_event_id,newest_event_id,is_muted,is_archived",
            expansions: "participant_ids",
            ...definedFields({
              unread_only: unreadOnly === undefined ? undefined : String(unreadOnly),
              type,
              participant_query: participantQuery,
              participant_ids: participantIds?.join(","),
              is_archived: archived === undefined ? undefined : String(archived),
              is_muted: muted === undefined ? undefined : String(muted),
            }),
          },
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 1000,
        });
      },
      async chatEvents({ account, conversationId, cursor, limit, context }) {
        requireId(conversationId, "conversationId", "x.chat.events", chatConversationPattern);

        return xReadPage({
          account,
          context,
          path: `/2/chat/conversations/${conversationId}/events`,
          operation: "x.chat.events",
          credential: "user",
          query: {
            "chat_message_event.fields":
              "id,conversation_id,sender_id,created_at,encoded_event,conversation_key_version,message_event_signature,is_trusted,previous_id",
          },
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 100,
        });
      },
      async sendChatMessage({
        account,
        conversationId,
        messageId,
        message,
        conversationToken,
        context,
      }) {
        authorize(account, context);

        const operation = "x.chat.send";

        requireId(conversationId, "conversationId", operation, chatConversationPattern);

        if (!/^[A-Za-z0-9_-]{1,64}$/.test(messageId))
          throw invalid(operation, "messageId must be 1-64 letters, digits, _ or -.");

        let body: JsonObject;

        switch (message.kind) {
          case "text":
            if (!message.text.trim()) throw invalid(operation, "Chat messages need text.");
            body = { message_id: messageId, content: { message: { text: message.text } } };
            break;
          case "reaction":
            requireId(message.eventId, "eventId", operation);

            if (!message.emoji.trim()) throw invalid(operation, "A reaction needs an emoji.");

            body = {
              message_id: messageId,
              content: {
                [message.remove === true ? "reaction_remove" : "reaction_add"]: {
                  event_id: message.eventId,
                  emoji: message.emoji,
                },
              },
            };
            break;
          case "encrypted":
            if (!message.encodedMessageCreateEvent.trim())
              throw invalid(operation, "Pass the encoded event produced by the Chat XDK.");
            body = {
              message_id: messageId,
              encoded_message_create_event: message.encodedMessageCreateEvent,
              ...definedFields({
                encoded_message_event_signature: message.encodedMessageEventSignature,
                xdk_version: message.xdkVersion,
              }),
            };
            break;
          default: {
            const _exhaustive: never = message;

            throw invalid(operation, `Unknown chat message ${String(_exhaustive)}.`);
          }
        }

        if (conversationToken !== undefined) {
          if (!conversationToken.trim())
            throw invalid(operation, "conversationToken must not be empty.");

          body = { ...body, conversation_token: conversationToken };
        }

        const response = await requireUserToken(operation)(
          `/2/chat/conversations/${conversationId}/messages`,
          context,
          body,
        );

        // The send was dispatched and accepted; a response without the event cannot prove
        // what X stored, so callers must read the conversation before any retry.
        const data = isJsonObject(response) ? response["data"] : undefined;

        const event = isJsonObject(data) ? data["encoded_message_event"] : undefined;

        if (!isString(event) || event === "")
          throw new SocialError({
            code: "ambiguous_outcome",
            operation,
            message:
              "X accepted the Chat message without returning its event. Read the conversation before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return { encodedMessageEvent: event };
      },
      async initializeChatGroup({ account, context }) {
        const data = await chatWrite({
          account,
          context,
          operation: "x.chat.groups.initialize",
          path: "/2/chat/conversations/group/initialize",
          method: "POST",
        });

        return { conversationId: chatConversationId(data, "x.chat.groups.initialize") };
      },
      async createChatGroup({ account, group, context }) {
        const operation = "x.chat.groups.create";

        requireId(group.conversationId, "conversationId", operation, chatGroupPattern);
        requireIds(group.memberIds, "memberIds", operation);

        if (group.adminIds !== undefined) requireIds(group.adminIds, "adminIds", operation);

        if (
          !/^[0-9]{1,19}$/.test(group.conversationKeyVersion) ||
          group.participantKeys.length === 0
        )
          throw invalid(
            operation,
            "Pass the conversation key version and participant keys from the Chat XDK.",
          );

        if (
          group.messageTtlMs !== undefined &&
          (!Number.isSafeInteger(group.messageTtlMs) || group.messageTtlMs < 1)
        )
          throw invalid(operation, "messageTtlMs must be a positive integer.");

        const data = await chatWrite({
          account,
          context,
          operation,
          path: "/2/chat/conversations/group",
          method: "POST",
          body: {
            conversation_id: group.conversationId,
            conversation_key_version: group.conversationKeyVersion,
            conversation_participant_keys: wireChatKeys(group.participantKeys),
            group_members: [...group.memberIds],
            ...definedFields({
              group_admins: group.adminIds === undefined ? undefined : [...group.adminIds],
              group_name: group.name,
              group_description: group.description,
              group_avatar_url: group.avatarUrl,
              ttl_msec: group.messageTtlMs?.toString(),
              base64_encoded_key_rotation: group.keyRotation,
              action_signatures: chatSignatures(group.actionSignatures),
            }),
          },
        });

        return {
          conversationId: chatConversationId(data, operation),
          ...definedFields({
            keyChangeSequenceId: optionalString(data["conversation_key_change_sequence_id"]),
          }),
        };
      },
      async getChatConversation({ account, conversationId, context }) {
        requireId(conversationId, "conversationId", "x.chat.conversation", chatConversationPattern);

        return object(
          (
            await xRead({
              account,
              context,
              path: `/2/chat/conversations/${conversationId}`,
              operation: "x.chat.conversation",
              credential: "user",
              query: {
                "chat_conversation.fields":
                  "id,type,created_at,updated_at,group_name,group_description,group_avatar_url,admin_settings,invite,is_archived,is_muted,unread,message_ttl_ms,screen_capture_blocking_enabled,screen_capture_detection_enabled,last_read_event_id,newest_event_id",
                expansions: "admin_ids,member_ids,participant_ids",
              },
            })
          )["data"],
        );
      },
      async updateChatGroup({ account, conversationId, update, context }) {
        const operation = "x.chat.groups.update";

        requireId(conversationId, "conversationId", operation, chatGroupPattern);

        if (
          update.modifiedFields.length === 0 ||
          !/^[0-9]{1,19}$/.test(update.conversationKeyVersion)
        )
          throw invalid(operation, "Pass modifiedFields and the conversation key version.");

        await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}`,
          method: "PUT",
          confirm: ["updated", true],
          body: {
            modified_fields: [...update.modifiedFields],
            conversation_key_version: update.conversationKeyVersion,
            ...definedFields({
              group_name: update.name,
              group_description: update.description,
              group_avatar_url: update.avatarUrl,
              conversation_participant_keys:
                update.participantKeys === undefined
                  ? undefined
                  : wireChatKeys(update.participantKeys),
              base64_encoded_key_rotation: update.keyRotation,
              rotated_pmk_bundle:
                update.rotatedMessageKeys === undefined
                  ? undefined
                  : [...update.rotatedMessageKeys],
              action_signatures: chatSignatures(update.actionSignatures),
            }),
          },
        });
      },
      async deleteChatConversation({ account, conversationId, actionSignatures, context }) {
        const operation = "x.chat.conversation.delete";

        requireId(conversationId, "conversationId", operation, chatConversationPattern);

        await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}`,
          method: "DELETE",
          confirm: ["deleted", true],
          body: definedFields({ action_signatures: chatSignatures(actionSignatures) }),
        });
      },
      async addChatMembers({
        account,
        conversationId,
        userIds,
        conversationKeyVersion,
        participantKeys,
        encryptedTitle,
        encryptedAvatarUrl,
        actionSignatures,
        context,
      }) {
        const operation = "x.chat.members.add";

        requireId(conversationId, "conversationId", operation, chatConversationPattern);
        requireIds(userIds, "userIds", operation);

        return chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}/members`,
          method: "POST",
          body: {
            user_ids: [...userIds],
            ...definedFields({
              conversation_key_version: conversationKeyVersion,
              conversation_participant_keys:
                participantKeys === undefined ? undefined : wireChatKeys(participantKeys),
              encrypted_title: encryptedTitle,
              encrypted_avatar_url: encryptedAvatarUrl,
              action_signatures: chatSignatures(actionSignatures),
            }),
          },
        });
      },
      async removeChatMembers({
        account,
        conversationId,
        userIds,
        keyRotation,
        actionSignatures,
        context,
      }) {
        const operation = "x.chat.members.remove";

        requireId(conversationId, "conversationId", operation, chatConversationPattern);
        requireIds(userIds, "userIds", operation);

        await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}/members/remove`,
          method: "POST",
          confirm: ["removed", true],
          body: {
            user_ids: [...userIds],
            ...definedFields({
              group_key_rotation_data: keyRotation,
              action_signatures: chatSignatures(actionSignatures),
            }),
          },
        });
      },
      async setChatAdmins({ account, conversationId, userIds, admin, actionSignatures, context }) {
        const operation = "x.chat.admins";

        requireId(conversationId, "conversationId", operation, chatGroupPattern);
        requireIds(userIds, "userIds", operation);

        await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}/admins${admin ? "" : "/remove"}`,
          method: "POST",
          confirm: [admin ? "added" : "removed", true],
          body: {
            user_ids: [...userIds],
            ...definedFields({ action_signatures: chatSignatures(actionSignatures) }),
          },
        });
      },
      async chatAdminRequests({ account, conversationId, cursor, context }) {
        requireId(conversationId, "conversationId", "x.chat.admins.requests", chatGroupPattern);

        return xReadPage({
          account,
          context,
          path: `/2/chat/conversations/${conversationId}/admin_requests`,
          operation: "x.chat.admins.requests",
          credential: "user",
          cursor,
          minLimit: 1,
          maxLimit: 1,
        });
      },
      async requestChatAdmin({ account, conversationId, actionSignatures, context }) {
        const operation = "x.chat.admins.request";

        requireId(conversationId, "conversationId", operation, chatGroupPattern);

        await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}/admin_requests`,
          method: "POST",
          confirm: ["requested", true],
          body: definedFields({ action_signatures: chatSignatures(actionSignatures) }),
        });
      },
      async resolveChatAdminRequest({
        account,
        conversationId,
        userId,
        approve,
        actionSignatures,
        context,
      }) {
        const operation = "x.chat.admins.resolve";

        requireId(conversationId, "conversationId", operation, chatGroupPattern);
        requireId(userId, "userId", operation);

        await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}/admin_requests/${userId}/${approve ? "approve" : "reject"}`,
          method: "POST",
          confirm: [approve ? "approved" : "rejected", true],
          body: definedFields({ action_signatures: chatSignatures(actionSignatures) }),
        });
      },
      async updateChatAdminSettings({
        account,
        conversationId,
        settings,
        actionSignatures,
        context,
      }) {
        const operation = "x.chat.admins.settings";

        requireId(conversationId, "conversationId", operation, chatGroupPattern);

        const body = definedFields({
          add_member: settings.addMember,
          block_screen_capture: settings.blockScreenCapture,
          edit_group_info: settings.editGroupInfo,
          edit_message_ttl: settings.editMessageTtl,
          send_message: settings.sendMessage,
          start_call: settings.startCall,
        });

        if (Object.keys(body).length === 0) throw invalid(operation, "Pass at least one setting.");

        await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}/admin_settings`,
          method: "PUT",
          confirm: ["updated", true],
          body: {
            ...body,
            ...definedFields({ action_signatures: chatSignatures(actionSignatures) }),
          },
        });
      },
      async enableChatInvite({ account, conversationId, invite, context }) {
        const operation = "x.chat.invite.enable";

        requireId(conversationId, "conversationId", operation, chatGroupPattern);

        if (
          invite.inviteUrl !== undefined &&
          !new RegExp(
            `^https://x\\.com/i/chat/group_join/${conversationId}/[A-Za-z0-9_-]{10}$`,
          ).test(invite.inviteUrl)
        )
          throw invalid(
            operation,
            "inviteUrl must be https://x.com/i/chat/group_join/<id>/<token>.",
          );

        if (
          invite.validForMs !== undefined &&
          (!Number.isSafeInteger(invite.validForMs) || invite.validForMs < 1)
        )
          throw invalid(operation, "validForMs must be a positive integer.");

        if (invite.affiliateUserId !== undefined)
          requireId(invite.affiliateUserId, "affiliateUserId", operation);

        if (invite.avatarUrl !== undefined && !isHttpsUrl(invite.avatarUrl))
          throw invalid(operation, "avatarUrl must be an HTTPS URL.");

        for (const [name, value] of [
          ["welcomeMessage", invite.welcomeMessage],
          ["title", invite.title],
        ] as const)
          if (value !== undefined && [...value].length > 1024)
            throw invalid(operation, `${name} is limited to 1,024 characters.`);

        return chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}/invite`,
          method: "POST",
          body: definedFields({
            invite_url: invite.inviteUrl,
            validity_duration_msec: invite.validForMs?.toString(),
            validity_expiry_timestamp_msec:
              invite.expiresAt === undefined
                ? undefined
                : epochMs(invite.expiresAt, "expiresAt", operation),
            welcome_message: invite.welcomeMessage,
            decrypted_title: invite.title,
            decrypted_avatar_url: invite.avatarUrl,
            affiliate_user_id: invite.affiliateUserId,
            action_signatures: chatSignatures(invite.actionSignatures),
          }),
        });
      },
      async disableChatInvite({ account, conversationId, actionSignatures, context }) {
        const operation = "x.chat.invite.disable";

        requireId(conversationId, "conversationId", operation, chatGroupPattern);

        await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}/invite`,
          method: "DELETE",
          confirm: ["disabled", true],
          body: definedFields({ action_signatures: chatSignatures(actionSignatures) }),
        });
      },
      async getChatInvite({ account, conversationId, token, context }) {
        requireId(conversationId, "conversationId", "x.chat.invite.get", chatGroupPattern);
        requireId(token, "token", "x.chat.invite.get", chatInviteTokenPattern);

        return object(
          (
            await xRead({
              account,
              context,
              path: `/2/chat/conversations/${conversationId}/invites/${token}`,
              operation: "x.chat.invite.get",
              credential: "user",
            })
          )["data"],
        );
      },
      async requestToJoinChat({ account, conversationId, token, actionSignatures, context }) {
        const operation = "x.chat.join";

        requireId(conversationId, "conversationId", operation, chatGroupPattern);
        requireId(token, "token", operation, chatInviteTokenPattern);

        await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}/join_requests`,
          method: "POST",
          confirm: ["requested", true],
          body: {
            token,
            ...definedFields({ action_signatures: chatSignatures(actionSignatures) }),
          },
        });
      },
      async rejectChatJoinRequests({
        account,
        conversationId,
        userIds,
        actionSignatures,
        context,
      }) {
        const operation = "x.chat.join.reject";

        requireId(conversationId, "conversationId", operation, chatGroupPattern);
        requireIds(userIds, "userIds", operation);

        await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}/join_requests/reject`,
          method: "POST",
          confirm: ["rejected", true],
          body: {
            user_ids: [...userIds],
            ...definedFields({ action_signatures: chatSignatures(actionSignatures) }),
          },
        });
      },
      async setChatArchived({ account, conversationId, archived, actionSignatures, context }) {
        const operation = "x.chat.archive";

        requireId(conversationId, "conversationId", operation, chatConversationPattern);

        await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}/archive`,
          method: archived ? "POST" : "DELETE",
          confirm: ["archived", archived],
          body: definedFields({ action_signatures: chatSignatures(actionSignatures) }),
        });
      },
      async setChatMuted({ account, conversationId, muted, actionSignatures, context }) {
        const operation = "x.chat.mute";

        requireId(conversationId, "conversationId", operation, chatConversationPattern);

        await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}/mute`,
          method: muted ? "POST" : "DELETE",
          confirm: ["muted", muted],
          body: definedFields({ action_signatures: chatSignatures(actionSignatures) }),
        });
      },
      async markChatRead({ account, conversationId, read, actionSignatures, context }) {
        const operation = "x.chat.read";

        requireId(conversationId, "conversationId", operation, chatConversationPattern);

        if (!read && actionSignatures !== undefined)
          throw invalid(operation, "Only read receipts take actionSignatures.");

        await chatWrite({
          account,
          context,
          operation,
          path: read
            ? `/2/chat/conversations/${conversationId}/read`
            : `/2/chat/conversations/${conversationId}/unread`,
          method: "POST",
          confirm: ["success", true],
          body: definedFields({ action_signatures: chatSignatures(actionSignatures) }),
        });
      },
      async sendChatTyping({ account, conversationId, context }) {
        requireId(conversationId, "conversationId", "x.chat.typing", chatConversationPattern);

        await chatWrite({
          account,
          context,
          operation: "x.chat.typing",
          path: `/2/chat/conversations/${conversationId}/typing`,
          method: "POST",
          confirm: ["success", true],
        });
      },
      async setChatMessageTtl({ account, conversationId, ttlMs, actionSignatures, context }) {
        const operation = "x.chat.message_ttl";

        requireId(conversationId, "conversationId", operation, chatConversationPattern);

        if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 1))
          throw invalid(operation, "ttlMs must be a positive integer of milliseconds.");

        const signatures = definedFields({ action_signatures: chatSignatures(actionSignatures) });

        await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}/message_ttl`,
          method: ttlMs === undefined ? "DELETE" : "PUT",
          confirm: [ttlMs === undefined ? "deleted" : "updated", true],
          body: ttlMs === undefined ? signatures : { message_ttl_ms: String(ttlMs), ...signatures },
        });
      },
      async setChatScreenCapture({
        account,
        conversationId,
        blocking,
        detection,
        blockingSignatures,
        detectionSignatures,
        context,
      }) {
        const operation = "x.chat.screen_capture";

        requireId(conversationId, "conversationId", operation, chatConversationPattern);

        if (blocking === undefined && detection === undefined)
          throw invalid(operation, "Pass blocking, detection, or both.");

        const data = await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}/screen_capture`,
          method: "PUT",
          body: definedFields({
            blocking,
            detection,
            blocking_action_signatures: chatSignatures(blockingSignatures),
            detection_action_signatures: chatSignatures(detectionSignatures),
          }),
        });

        return definedFields({
          blocking: optionalBoolean(data["blocking"]),
          detection: optionalBoolean(data["detection"]),
        });
      },
      async chatPinnedMessages({ account, conversationId, cursor, context }) {
        requireId(conversationId, "conversationId", "x.chat.pinned", chatConversationPattern);

        return xReadPage({
          account,
          context,
          path: `/2/chat/conversations/${conversationId}/pinned_messages`,
          operation: "x.chat.pinned",
          credential: "user",
          cursor,
          minLimit: 1,
          maxLimit: 1,
        });
      },
      async deleteChatMessages({
        account,
        conversationId,
        sequenceIds,
        scope,
        mediaHashKeys,
        actionSignatures,
        context,
      }) {
        const operation = "x.chat.messages.delete";

        requireId(conversationId, "conversationId", operation, chatConversationPattern);
        requireIds(sequenceIds, "sequenceIds", operation);

        if (actionSignatures.length === 0)
          throw invalid(operation, "Message deletion needs the Chat XDK action signatures.");

        if (mediaHashKeys !== undefined && scope !== "delete_for_all")
          throw invalid(operation, "mediaHashKeys apply only to delete_for_all.");

        await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}/messages/delete`,
          method: "POST",
          confirm: ["deleted", true],
          body: {
            sequence_ids: [...sequenceIds],
            delete_message_action: scope,
            action_signatures: [...actionSignatures],
            ...definedFields({
              media_hash_keys: mediaHashKeys === undefined ? undefined : [...mediaHashKeys],
            }),
          },
        });
      },
      async addChatConversationKeys({
        account,
        conversationId,
        conversationKeyVersion,
        participantKeys,
        keyRotation,
        actionSignatures,
        context,
      }) {
        const operation = "x.chat.keys";

        requireId(conversationId, "conversationId", operation, chatConversationPattern);

        if (!conversationKeyVersion.trim() || participantKeys.length === 0)
          throw invalid(operation, "Pass the key version and participant keys from the Chat XDK.");

        const data = await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/conversations/${conversationId}/keys`,
          method: "POST",
          body: {
            conversation_key_version: conversationKeyVersion,
            conversation_participant_keys: wireChatKeys(participantKeys),
            ...definedFields({
              base64_encoded_key_rotation: keyRotation,
              action_signatures: chatSignatures(actionSignatures),
            }),
          },
        });

        return definedFields({ sequenceId: optionalString(data["sequence_id"]) });
      },
      async chatPublicKeys({ account, userIds, context }) {
        requireIds(userIds, "userIds", "x.chat.public_keys");

        const [single] = userIds;

        const result = await xRead({
          account,
          context,
          path:
            userIds.length === 1 && single !== undefined
              ? `/2/users/${single}/public_keys`
              : "/2/users/public_keys",
          operation: "x.chat.public_keys",
          credential: "user",
          query: userIds.length === 1 ? {} : { ids: userIds.join(",") },
        });

        return result["data"] === undefined ? [] : array(result["data"]).map(object);
      },
      async registerChatPublicKey({ account, publicKey, context }) {
        return chatWrite({
          account,
          context,
          operation: "x.chat.public_keys.add",
          path: `/2/users/${encodeURIComponent(account.accountId)}/public_keys`,
          method: "POST",
          body: { public_key: publicKey },
        });
      },
      async uploadChatMedia({ account, conversationId, media, messageId, ttlMs, context }) {
        const operation = "x.chat.media.upload";

        requireId(conversationId, "conversationId", operation, chatConversationPattern);

        if (media.size === 0) throw invalid(operation, "Chat media must not be empty.");

        const parts = Math.ceil(media.size / xChatMediaChunkBytes);

        if (parts > 1000)
          throw invalid(operation, "Chat media is limited to 1,000 parts of 4 MiB.");

        if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 1))
          throw invalid(operation, "ttlMs must be a positive integer.");

        const started = await chatWrite({
          account,
          context,
          operation,
          path: "/2/chat/media/upload/initialize",
          method: "POST",
          body: { conversation_id: conversationId, total_bytes: media.size },
        });

        const sessionId = optionalString(started["session_id"]);

        const mediaHashKey = optionalString(started["media_hash_key"]);

        if (sessionId === undefined || !xIdPattern.test(sessionId) || mediaHashKey === undefined)
          throw new HttpError("X did not return a chat media session.", "invalid-response", true);

        for (let index = 0; index < parts; index++) {
          const form = new FormData();

          form.set("conversation_id", conversationId);
          form.set("media_hash_key", mediaHashKey);
          form.set("segment_index", String(index));
          form.set(
            "media",
            media.slice(index * xChatMediaChunkBytes, (index + 1) * xChatMediaChunkBytes),
          );

          const appended = await requireUserToken(operation)(
            `/2/chat/media/upload/${sessionId}/append`,
            context,
            form,
            {},
            "POST",
          );

          // X can answer HTTP 200 with only `errors`; that segment was not accepted.
          const appendErrors = isJsonObject(appended) ? appended["errors"] : undefined;

          // Provider prose can echo request values, so the message keeps only the segment position.
          if (isJsonArray(appendErrors) && appendErrors.length > 0)
            throw new SocialError({
              code: "upstream_failure",
              operation,
              message: `X rejected chat media segment ${index + 1} of ${parts}.`,
            });
        }

        await chatWrite({
          account,
          context,
          operation,
          path: `/2/chat/media/upload/${sessionId}/finalize`,
          method: "POST",
          confirm: ["success", true],
          body: {
            conversation_id: conversationId,
            media_hash_key: mediaHashKey,
            num_parts: String(parts),
            ...definedFields({ message_id: messageId, ttl_msec: ttlMs?.toString() }),
          },
        });

        return { mediaHashKey, sessionId };
      },
      async downloadChatMedia({
        account,
        conversationId,
        mediaHashKey,
        maxBytes = 15 * 1024 * 1024,
        context,
      }) {
        authorize(account, context);

        const operation = "x.chat.media.download";

        requireId(conversationId, "conversationId", operation, chatConversationPattern);

        if (!/^[a-zA-Z0-9]{1,50}$/.test(mediaHashKey))
          throw invalid(operation, "mediaHashKey must be 1-50 letters or digits.");

        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024)
          throw invalid(operation, "maxBytes must be an integer from 1 through 1 GiB.");

        return downloadBytes(
          `/2/chat/media/${conversationId}/${mediaHashKey}`,
          maxBytes,
          context,
          operation,
        );
      },
      async chatMessageRequests({ account, inboxType, cursor, limit, context }) {
        return xReadPage({
          account,
          context,
          path: "/2/chat/message_requests",
          operation: "x.chat.requests",
          credential: "user",
          query: definedFields({ inbox_type: inboxType }),
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 50,
        });
      },
      async getChatMessageRequest({ account, conversationId, context }) {
        requireId(conversationId, "conversationId", "x.chat.requests.get", chatDirectPattern);

        return object(
          (
            await xRead({
              account,
              context,
              path: `/2/chat/message_requests/${conversationId}`,
              operation: "x.chat.requests.get",
              credential: "user",
            })
          )["data"],
        );
      },
      async acceptChatMessageRequest({ account, conversationId, context }) {
        requireId(conversationId, "conversationId", "x.chat.requests.accept", chatDirectPattern);

        await chatWrite({
          account,
          context,
          operation: "x.chat.requests.accept",
          path: `/2/chat/message_requests/${conversationId}/accept`,
          method: "POST",
          confirm: ["accepted", true],
        });
      },
      async chatSettings({ account, settings, context }) {
        if (settings === undefined)
          return object(
            (
              await xRead({
                account,
                context,
                path: "/2/chat/settings",
                operation: "x.chat.settings",
                credential: "user",
              })
            )["data"],
          );

        const body = definedFields({
          allow_dms_from: settings.allowMessagesFrom,
          always_allow_dms_from_subscribers: settings.alwaysAllowSubscribers,
          dm_quality_filter: settings.qualityFilter,
          dm_receipt_settings: settings.readReceipts,
          av_settings: settings.callSettings,
        });

        if (Object.keys(body).length === 0)
          throw invalid("x.chat.settings", "Pass at least one setting to change.");

        return chatWrite({
          account,
          context,
          operation: "x.chat.settings",
          path: "/2/chat/settings",
          method: "PUT",
          body,
        });
      },
      async createCall({ account, conversationId, title, joinPolicy, audioOnly, context }) {
        const operation = "x.calls.create";

        if (conversationId !== undefined && !/^[A-Za-z0-9:_-]{1,128}$/.test(conversationId))
          throw invalid(operation, "conversationId is not a valid X Chat conversation ID.");

        if (title !== undefined && [...title].length > 100)
          throw invalid(operation, "Call titles are limited to 100 characters.");

        return chatWrite({
          account,
          context,
          operation,
          path: "/2/calls",
          method: "POST",
          body: definedFields({
            conversation_id: conversationId,
            title,
            join_policy: joinPolicy,
            audio_only: audioOnly,
          }),
        });
      },
      async getCall({ account, callId, context }) {
        requireId(callId, "callId", "x.calls.get", callIdPattern);

        return object(
          (
            await xRead({
              account,
              context,
              path: `/2/calls/${callId}`,
              operation: "x.calls.get",
              credential: "user",
            })
          )["data"],
        );
      },
      async joinCall({ account, callId, audio, context }) {
        requireId(callId, "callId", "x.calls.join", callIdPattern);

        return chatWrite({
          account,
          context,
          operation: "x.calls.join",
          path: `/2/calls/${callId}/join`,
          method: "POST",
          body:
            audio === undefined
              ? {}
              : {
                  media: {
                    type: "websocket",
                    audio: {
                      encoding: "pcm16",
                      ...definedFields({ sample_rate: audio.sampleRate }),
                    },
                  },
                },
        });
      },
      async leaveCall({ account, callId, context }) {
        requireId(callId, "callId", "x.calls.leave", callIdPattern);

        await chatWrite({
          account,
          context,
          operation: "x.calls.leave",
          path: `/2/calls/${callId}/leave`,
          method: "POST",
          confirm: ["left", true],
        });
      },
      async scheduledCalls({ account, startTime, endTime, limit, context }) {
        for (const value of [startTime, endTime])
          if (value !== undefined && !Number.isFinite(Date.parse(value)))
            throw invalid("x.calls.scheduled", "startTime and endTime must be RFC 3339 times.");

        return xReadPage({
          account,
          context,
          path: "/2/calls/scheduled",
          operation: "x.calls.scheduled",
          credential: "user",
          query: definedFields({ start_time: startTime, end_time: endTime }),
          limit,
          minLimit: 1,
          maxLimit: 100,
        });
      },
      async scheduleCall({ account, call, context }) {
        const operation = "x.calls.schedule";

        return chatWrite({
          account,
          context,
          operation,
          path: "/2/calls/scheduled",
          method: "POST",
          body: scheduledCallBody({ ...call, startTime: call.startTime }, 25, operation),
        });
      },
      async getScheduledCall({ account, scheduledCallId, context }) {
        requireId(scheduledCallId, "scheduledCallId", "x.calls.scheduled.get");

        return object(
          (
            await xRead({
              account,
              context,
              path: `/2/calls/scheduled/${scheduledCallId}`,
              operation: "x.calls.scheduled.get",
              credential: "user",
            })
          )["data"],
        );
      },
      async updateScheduledCall({ account, scheduledCallId, update, context }) {
        const operation = "x.calls.scheduled.update";

        requireId(scheduledCallId, "scheduledCallId", operation);

        const body = {
          ...scheduledCallBody(update, 100, operation),
          ...callOccurrence(update, operation),
        };

        if (Object.keys(body).length === 0) throw invalid(operation, "Pass at least one change.");

        await chatWrite({
          account,
          context,
          operation,
          path: `/2/calls/scheduled/${scheduledCallId}`,
          method: "PUT",
          confirm: ["updated", true],
          body,
        });
      },
      async cancelScheduledCall({ account, scheduledCallId, occurrence, notifyInvitees, context }) {
        authorize(account, context);

        const operation = "x.calls.scheduled.cancel";

        requireId(scheduledCallId, "scheduledCallId", operation);

        const wire = callOccurrence(occurrence ?? {}, operation);

        confirmedWrite(
          await requireUserToken(operation)(
            `/2/calls/scheduled/${scheduledCallId}`,
            context,
            undefined,
            definedFields({
              scope: optionalString(wire["scope"]),
              occurrence_start_time: optionalString(wire["occurrence_start_time"]),
              notify_invitees: notifyInvitees === undefined ? undefined : String(notifyInvitees),
            }),
            "DELETE",
          ),
          "cancelled",
          true,
          operation,
        );
      },
      async rsvpScheduledCall({ account, scheduledCallId, response, occurrence, context }) {
        const operation = "x.calls.scheduled.rsvp";

        requireId(scheduledCallId, "scheduledCallId", operation);

        const data = await chatWrite({
          account,
          context,
          operation,
          path: `/2/calls/scheduled/${scheduledCallId}/rsvp`,
          method: "POST",
          body: { response, ...callOccurrence(occurrence ?? {}, operation) },
        });

        if (data["response"] !== response)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation,
            message: "X did not confirm the RSVP. Read the scheduled call before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });
      },
      async bots({ account, context }) {
        return pageFrom(
          await xRead({
            account,
            context,
            path: "/2/bots",
            operation: "x.bots.list",
            credential: "app",
          }),
        );
      },
      async createBot({ account, handle, displayName, orgOnly, scopes, context }) {
        authorize(account, context);

        const operation = "x.bots.create";

        botFields(handle, displayName, operation);

        return botWithToken(
          await credentialRequest("app-or-user", operation)("/2/bots", context, {
            handle,
            ...definedFields({
              display_name: displayName,
              org_only: orgOnly,
              scopes: scopes === undefined ? undefined : [...scopes],
            }),
          }),
          operation,
        );
      },
      async updateBot({ account, botId, handle, displayName, dmPermission, context }) {
        authorize(account, context);

        const operation = "x.bots.update";

        requireId(botId, "botId", operation);
        botFields(handle, displayName, operation);

        const body = definedFields({
          handle,
          display_name: displayName,
          dm_permission: dmPermission,
        });

        if (Object.keys(body).length === 0) throw invalid(operation, "Pass at least one change.");

        confirmedWrite(
          await appRequest()(`/2/bots/${botId}`, context, body, {}, "PUT"),
          "updated",
          true,
          operation,
        );
      },
      async deleteBot({ account, botId, context }) {
        authorize(account, context);
        requireId(botId, "botId", "x.bots.delete");

        confirmedWrite(
          await appRequest()(`/2/bots/${botId}`, context, undefined, {}, "DELETE"),
          "deleted",
          true,
          "x.bots.delete",
        );
      },
      async rotateBotToken({ account, botId, scopes, context }) {
        authorize(account, context);

        const operation = "x.bots.token.rotate";

        requireId(botId, "botId", operation);

        return botWithToken(
          await credentialRequest("app-or-user", operation)(
            `/2/bots/${botId}/token`,
            context,
            definedFields({ scopes: scopes === undefined ? undefined : [...scopes] }),
            {},
            "POST",
          ),
          operation,
        );
      },
      async revokeBotToken({ account, botId, context }) {
        authorize(account, context);
        requireId(botId, "botId", "x.bots.token.revoke");

        confirmedWrite(
          await appRequest()(`/2/bots/${botId}/token`, context, undefined, {}, "DELETE"),
          "revoked",
          true,
          "x.bots.token.revoke",
        );
      },
      async developerAccount({ account, context }) {
        return object(
          (
            await xRead({
              account,
              context,
              path: "/2/account",
              operation: "x.account.developer",
              credential: "user",
            })
          )["data"],
        );
      },
      async ensureDeveloperAccount({ account, metadata, context }) {
        const operation = "x.account.developer.ensure";

        if (metadata !== undefined && [...metadata].length > 64)
          throw invalid(operation, "metadata is limited to 64 characters.");

        const data = await chatWrite({
          account,
          context,
          operation,
          path: "/2/account",
          method: "POST",
          body: definedFields({ metadata }),
        });

        const accountId = optionalString(data["account_id"]);

        const created = optionalBoolean(data["created"]);

        if (accountId === undefined || created === undefined)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation,
            message: "X did not return the developer account. Read it before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return { accountId, created };
      },
      async broadcasts({ account, broadcastIds, cursor, limit, context }) {
        const operation = "x.broadcasts.list";

        if (broadcastIds !== undefined) {
          if (limit !== undefined || cursor !== undefined)
            throw invalid(operation, "Pass broadcastIds or cursor and limit, not both.");

          requireIds(broadcastIds, "broadcastIds", operation, broadcastIdPattern);
        }

        return xReadPage({
          account,
          context,
          path: "/2/broadcasts",
          operation,
          credential: "user",
          query: definedFields({ ids: broadcastIds?.join(",") }),
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 100,
        });
      },
      async getBroadcast({ account, broadcastId, context }) {
        requireBroadcastId(broadcastId, "x.broadcasts.get");

        return xRead({
          account,
          context,
          path: `/2/broadcasts/${broadcastId}`,
          operation: "x.broadcasts.get",
          credential: "user",
        });
      },
      async endBroadcast({ account, broadcastId, context }) {
        authorize(account, context);
        requireBroadcastId(broadcastId, "x.broadcasts.end");

        const data = await broadcastWrite(
          `/2/broadcasts/${broadcastId}/state`,
          { state: "END" },
          "PUT",
          context,
          "x.broadcasts.end",
        );

        if (data["state"] !== "ENDED")
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "x.broadcasts.end",
            message: "X did not confirm the broadcast ended. Read it before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });
      },
      async deleteBroadcast({ account, broadcastId, context }) {
        authorize(account, context);
        requireBroadcastId(broadcastId, "x.broadcasts.delete");

        confirmedWrite(
          await requireUserToken("x.broadcasts.delete")(
            `/2/broadcasts/${broadcastId}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
          "deleted",
          true,
          "x.broadcasts.delete",
        );
      },
      async scheduleBroadcast({ account, broadcast, context }) {
        authorize(account, context);

        const operation = "x.broadcasts.schedule";

        if (!broadcast.sourceId.trim()) throw invalid(operation, "sourceId must not be empty.");

        const start = epochMs(broadcast.startAt, "startAt", operation);

        const end =
          broadcast.endAt === undefined ? undefined : epochMs(broadcast.endAt, "endAt", operation);

        if (end !== undefined && Number(end) <= Number(start))
          throw invalid(operation, "endAt must be later than startAt.");

        return broadcastWrite(
          "/2/broadcasts/scheduled",
          {
            source_id: broadcast.sourceId,
            scheduled_start_ms: start,
            ...definedFields({
              scheduled_end_ms: end,
              title: broadcast.title,
              description: broadcast.description,
              locale: broadcast.locale,
              manual_publish: broadcast.manualPublish,
              available_for_replay: broadcast.availableForReplay,
              chat_option:
                broadcast.chatOption === undefined ? undefined : String(broadcast.chatOption),
              ...broadcastExtras(broadcast, operation),
              recurrence:
                broadcast.recurrence === undefined
                  ? undefined
                  : broadcastRecurrence(broadcast.recurrence, operation),
            }),
          },
          "POST",
          context,
          operation,
        );
      },
      async scheduledBroadcasts({ account, oldestStartAt, newestStartAt, cursor, limit, context }) {
        for (const [name, value] of [
          ["oldestStartAt", oldestStartAt],
          ["newestStartAt", newestStartAt],
        ] as const)
          if (value !== undefined && !Number.isFinite(Date.parse(value)))
            throw invalid("x.broadcasts.scheduled", `${name} must be an ISO 8601 timestamp.`);

        return xReadPage({
          account,
          context,
          path: "/2/broadcasts/scheduled",
          operation: "x.broadcasts.scheduled",
          credential: "user",
          query: definedFields({
            oldest_start_time: oldestStartAt,
            newest_start_time: newestStartAt,
          }),
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 100,
        });
      },
      async getScheduledBroadcast({ account, broadcastId, context }) {
        requireBroadcastId(broadcastId, "x.broadcasts.scheduled.get");

        return object(
          (
            await xRead({
              account,
              context,
              path: `/2/broadcasts/scheduled/${broadcastId}`,
              operation: "x.broadcasts.scheduled.get",
              credential: "user",
            })
          )["data"],
        );
      },
      async updateScheduledBroadcast({
        account,
        broadcastId,
        scheduledBroadcastId,
        broadcast,
        context,
      }) {
        authorize(account, context);

        const operation = "x.broadcasts.scheduled.update";

        requireBroadcastId(broadcastId, operation);
        requireId(scheduledBroadcastId, "scheduledBroadcastId", operation);

        const start = epochMs(broadcast.startAt, "startAt", operation);

        const end = epochMs(broadcast.endAt, "endAt", operation);

        if (Number(end) <= Number(start))
          throw invalid(operation, "endAt must be later than startAt.");

        return broadcastWrite(
          `/2/broadcasts/scheduled/${broadcastId}`,
          {
            scheduled_broadcast_id: scheduledBroadcastId,
            scheduled_start_ms: start,
            scheduled_end_ms: end,
            ...definedFields({
              source_id: broadcast.sourceId,
              title: broadcast.title,
              description: broadcast.description,
              locale: broadcast.locale,
              manual_publish: broadcast.manualPublish,
              available_for_replay: broadcast.availableForReplay,
              chat_option:
                broadcast.chatOption === undefined ? undefined : String(broadcast.chatOption),
              ...broadcastExtras(broadcast, operation),
            }),
          },
          "PUT",
          context,
          operation,
        );
      },
      async ingestRegion({ account, context }) {
        const region = optionalString(
          (
            await xRead({
              account,
              context,
              path: "/2/region",
              operation: "x.broadcasts.region",
              credential: "user",
            })
          )["region"],
        );

        if (region === undefined)
          throw new HttpError("X did not return an ingest region.", "invalid-response", true);

        return region;
      },
      async setBroadcastChatMute({
        account,
        broadcastId,
        userId,
        muted,
        endAt,
        removeMessageId,
        context,
      }) {
        authorize(account, context);

        const operation = "x.broadcasts.chat.mutes";

        requireBroadcastId(broadcastId, operation);
        requireId(userId, "userId", operation);

        if (!muted && (endAt !== undefined || removeMessageId !== undefined))
          throw invalid(operation, "endAt and removeMessageId only apply when muting.");

        if (removeMessageId !== undefined) requireId(removeMessageId, "removeMessageId", operation);

        const result = muted
          ? await requireUserToken(operation)(`/2/broadcasts/${broadcastId}/chat/mutes`, context, {
              user_id: userId,
              ...definedFields({
                end_at_ms: endAt === undefined ? undefined : epochMs(endAt, "endAt", operation),
                message_id: removeMessageId,
              }),
            })
          : await requireUserToken(operation)(
              `/2/broadcasts/${broadcastId}/chat/mutes/${userId}`,
              context,
              undefined,
              {},
              "DELETE",
            );

        confirmedWrite(result, "muted", muted, operation);
      },
      async userBroadcasts({ account, cursor, context }) {
        if (cursor !== undefined && !cursor.trim())
          throw invalid("x.broadcasts.user", "Pass the nextCursor value from a previous page.");

        const data = object(
          (
            await xRead({
              account,
              context,
              path: `/2/users/${encodeURIComponent(account.accountId)}/broadcasts`,
              operation: "x.broadcasts.user",
              credential: "user",
              query: definedFields({ pagination_token: cursor }),
            })
          )["data"],
        );

        const next = data["next_token"];

        return {
          items: array(data["broadcasts"]).map(object),
          ...definedFields({
            nextCursor: isJsonObject(next) ? optionalString(next["offset"]) : undefined,
          }),
        };
      },
      async getUserBroadcast({ account, broadcastId, context }) {
        requireBroadcastId(broadcastId, "x.broadcasts.user.get");

        return object(
          object(
            (
              await xRead({
                account,
                context,
                path: `/2/users/${encodeURIComponent(account.accountId)}/broadcasts/${broadcastId}`,
                operation: "x.broadcasts.user.get",
                credential: "user",
              })
            )["data"],
          )["broadcast"],
        );
      },
      async createUserBroadcast({ account, sourceId, context }) {
        authorize(account, context);

        const operation = "x.broadcasts.user.create";

        requireId(sourceId, "sourceId", operation, streamSourcePattern);

        const data = await broadcastWrite(
          `/2/users/${encodeURIComponent(account.accountId)}/broadcasts`,
          { source_id: sourceId },
          "POST",
          context,
          operation,
        );

        const shareUrl = optionalString(data["share_url"]);

        if (!isJsonObject(data["broadcast"]) || shareUrl === undefined)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation,
            message: "X did not return the new broadcast. List broadcasts before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return { broadcast: data["broadcast"], shareUrl };
      },
      async setUserBroadcastState({ account, broadcastId, state, context }) {
        authorize(account, context);

        const operation = "x.broadcasts.user.state";

        requireBroadcastId(broadcastId, operation);

        const data = await broadcastWrite(
          `/2/users/${encodeURIComponent(account.accountId)}/broadcasts/${broadcastId}/state`,
          state.kind === "end"
            ? { state: "END" }
            : {
                state: "PUBLISH",
                ...definedFields({
                  title: state.title,
                  locale: state.locale,
                  chat_option: state.chatOption,
                  should_not_tweet: state.shouldNotTweet,
                }),
              },
          "PUT",
          context,
          operation,
        );

        if (state.kind === "end" ? data["success"] !== true : !isJsonObject(data["broadcast"]))
          throw new SocialError({
            code: "ambiguous_outcome",
            operation,
            message: "X did not confirm the broadcast state. Read it before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return data;
      },
      async deleteUserBroadcast({ account, broadcastId, context }) {
        authorize(account, context);
        requireBroadcastId(broadcastId, "x.broadcasts.user.delete");

        const data = await broadcastWrite(
          `/2/users/${encodeURIComponent(account.accountId)}/broadcasts/${broadcastId}`,
          undefined,
          "DELETE",
          context,
          "x.broadcasts.user.delete",
        );

        if (data["success"] !== true)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "x.broadcasts.user.delete",
            message: "X did not confirm the deletion. Read the broadcast before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });
      },
      async userStreamSources({ account, context }) {
        return array(
          object(
            (
              await xRead({
                account,
                context,
                path: `/2/users/${encodeURIComponent(account.accountId)}/sources`,
                operation: "x.sources.user",
                credential: "user",
              })
            )["data"],
          )["sources"],
        ).map(object);
      },
      async getUserStreamSource({ account, sourceId, context }) {
        requireId(sourceId, "sourceId", "x.sources.user.get", streamSourcePattern);

        return object(
          object(
            (
              await xRead({
                account,
                context,
                path: `/2/users/${encodeURIComponent(account.accountId)}/sources/${sourceId}`,
                operation: "x.sources.user.get",
                credential: "user",
              })
            )["data"],
          )["source"],
        );
      },
      async createUserStreamSource({ account, name, region, context }) {
        authorize(account, context);

        if (!name.trim()) throw invalid("x.sources.user.create", "Give the source a name.");

        return object(
          (
            await broadcastWrite(
              `/2/users/${encodeURIComponent(account.accountId)}/sources`,
              { name, ...definedFields({ region }) },
              "POST",
              context,
              "x.sources.user.create",
            )
          )["source"],
        );
      },
      async renameUserStreamSource({ account, sourceId, name, context }) {
        authorize(account, context);
        requireId(sourceId, "sourceId", "x.sources.user.rename", streamSourcePattern);

        if (!name.trim()) throw invalid("x.sources.user.rename", "Give the source a name.");

        return object(
          (
            await broadcastWrite(
              `/2/users/${encodeURIComponent(account.accountId)}/sources/${sourceId}`,
              { name },
              "PUT",
              context,
              "x.sources.user.rename",
            )
          )["source"],
        );
      },
      async deleteUserStreamSource({ account, sourceId, context }) {
        authorize(account, context);
        requireId(sourceId, "sourceId", "x.sources.user.delete", streamSourcePattern);

        const result = await requireUserToken("x.sources.user.delete")(
          `/2/users/${encodeURIComponent(account.accountId)}/sources/${sourceId}`,
          context,
          undefined,
          {},
          "DELETE",
        );

        if (!isJsonObject(result) || !isJsonObject(result["data"]))
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "x.sources.user.delete",
            message: "X did not confirm the deletion. List sources before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });
      },
      async goLive({ account, broadcastId, context }) {
        authorize(account, context);
        requireBroadcastId(broadcastId, "x.broadcasts.live");

        return broadcastWrite(
          `/2/broadcasts/scheduled/${broadcastId}/live`,
          undefined,
          "POST",
          context,
          "x.broadcasts.live",
        );
      },
      async deleteScheduledBroadcast({ account, broadcastId, context }) {
        authorize(account, context);
        requireBroadcastId(broadcastId, "x.broadcasts.scheduled.delete");

        confirmedWrite(
          await requireUserToken("x.broadcasts.scheduled.delete")(
            `/2/broadcasts/scheduled/${broadcastId}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
          "deleted",
          true,
          "x.broadcasts.scheduled.delete",
        );
      },
      async streamSources({ account, context }) {
        return pageFrom(
          await xRead({
            account,
            context,
            path: "/2/sources",
            operation: "x.sources.list",
            credential: "user",
          }),
        );
      },
      async createStreamSource({ account, name, region, context }) {
        authorize(account, context);

        if (!name.trim() || !/^[a-z]{2}-[a-z]+-[0-9]$/.test(region))
          throw invalid("x.sources.create", "Give a source name and a region such as us-east-1.");

        const source = await broadcastWrite(
          "/2/sources",
          { name, region },
          "POST",
          context,
          "x.sources.create",
        );

        // X's CreateSourceResponseData requires both; without them the source cannot be used.
        if (
          optionalString(source["id"]) === undefined ||
          optionalString(source["stream_key"]) === undefined
        )
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "x.sources.create",
            message: "X did not return the new stream source. List sources before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return source;
      },
      async deleteStreamSource({ account, sourceId, context }) {
        authorize(account, context);

        if (!/^[A-Za-z0-9_-]{1,128}$/.test(sourceId))
          throw invalid("x.sources.delete", "sourceId is not a valid X stream source ID.");

        confirmedWrite(
          await requireUserToken("x.sources.delete")(
            `/2/sources/${sourceId}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
          "deleted",
          true,
          "x.sources.delete",
        );
      },
      async broadcastChat({ account, broadcastId, cursor, limit, context }) {
        requireBroadcastId(broadcastId, "x.broadcasts.chat");

        return xReadPage({
          account,
          context,
          path: `/2/broadcasts/${broadcastId}/chat`,
          operation: "x.broadcasts.chat",
          credential: "user",
          query: {
            "broadcast_chat_message.fields":
              "id,text,author_name,author_username,created_at_ms,reply_to",
          },
          cursor,
          limit,
          minLimit: 1,
          maxLimit: 200,
        });
      },
      async sendBroadcastChat({ account, broadcastId, text, replyTo, context }) {
        authorize(account, context);

        const operation = "x.broadcasts.chat.send";

        requireBroadcastId(broadcastId, operation);

        if (!text.trim() || [...text].length > 140)
          throw invalid(operation, "Broadcast chat messages are 1-140 characters.");

        if (replyTo !== undefined) requireId(replyTo, "replyTo", operation);

        const data = await broadcastWrite(
          `/2/broadcasts/${broadcastId}/chat`,
          { text, ...definedFields({ reply_to: replyTo }) },
          "POST",
          context,
          operation,
        );

        const timestamp = optionalString(data["timestamp"]);

        if (data["success"] !== true || timestamp === undefined)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation,
            message: "X did not confirm the chat message. Read the chat before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return { timestamp };
      },
      async removeBroadcastChatMessage({ account, broadcastId, messageId, context }) {
        authorize(account, context);
        requireBroadcastId(broadcastId, "x.broadcasts.chat.remove");
        requireId(messageId, "messageId", "x.broadcasts.chat.remove");

        confirmedWrite(
          await requireUserToken("x.broadcasts.chat.remove")(
            `/2/broadcasts/${broadcastId}/chat/${messageId}`,
            context,
            undefined,
            {},
            "DELETE",
          ),
          "deleted",
          true,
          "x.broadcasts.chat.remove",
        );
      },
      async setChatModerator({ account, userId, moderator, context }) {
        authorize(account, context);
        requireId(userId, "userId", "x.broadcasts.moderators");

        const data = moderator
          ? await broadcastWrite(
              "/2/broadcasts/chat/moderators",
              { user_id: userId },
              "POST",
              context,
              "x.broadcasts.moderators",
            )
          : await broadcastWrite(
              `/2/broadcasts/chat/moderators/${userId}`,
              undefined,
              "DELETE",
              context,
              "x.broadcasts.moderators",
            );

        return array(data["moderator_user_ids"]).map(string);
      },
      async setChatMute({ account, userId, muted, broadcastId, endAt, context }) {
        authorize(account, context);

        const operation = "x.broadcasts.mutes";

        requireId(userId, "userId", operation);

        if (broadcastId !== undefined) requireBroadcastId(broadcastId, operation);

        if (!muted && endAt !== undefined)
          throw invalid(operation, "endAt only applies when muting.");

        const result = muted
          ? await requireUserToken(operation)("/2/broadcasts/chat/mutes", context, {
              user_id: userId,
              ...definedFields({
                broadcast_id: broadcastId,
                end_at_ms: endAt === undefined ? undefined : epochMs(endAt, "endAt", operation),
              }),
            })
          : await requireUserToken(operation)(
              `/2/broadcasts/chat/mutes/${userId}`,
              context,
              undefined,
              definedFields({ broadcast_id: broadcastId }),
              "DELETE",
            );

        confirmedWrite(result, "muted", muted, operation);
      },
      async unblockDms({ account, userId, context }) {
        authorize(account, context);
        requireId(userId, "userId", "messages.block");

        confirmedWrite(
          await requireUserToken("messages.block")(
            `/2/users/${userId}/dm/unblock`,
            context,
            undefined,
            {},
            "POST",
          ),
          "blocked",
          false,
          "messages.block",
        );
      },
    }),
  });

  return adapter;
}
