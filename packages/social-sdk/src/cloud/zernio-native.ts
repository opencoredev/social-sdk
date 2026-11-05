import { normalizeComment } from "../core/projections.js";
import { SocialError } from "../core/errors.js";
import type {
  AdapterOperationContext,
  CommentRef,
  ConnectedAccountRef,
  ConversationRef,
  DeliveryRef,
  JsonObject,
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
  isJsonArray,
  isJsonObject,
  isString,
  number,
  object,
  optionalBoolean,
  optionalNumber,
  optionalString,
  string,
  type JsonField,
} from "../transport/validation.js";
import {
  accountMatches,
  managedPreparation,
  managedOptionIssues,
  normalizePlatform,
  platform,
  publicFields,
  subredditName,
  zernioPlatform as wirePlatform,
  type ManagedOptions,
} from "./common.js";
import { zernioOutcome } from "./outcomes.js";
import { httpsUrl } from "../transport/upload.js";
import { zernioInternals, type ZernioSubmission } from "./zernio.js";

export type { ZernioSubmission } from "./zernio.js";

const {
  invalid,
  unconfirmed,
  inboxFields,
  targetData: zernioTargetData,
  keysWithCommon: zernioKeysWithCommon,
  editablePlatforms: zernioEditablePlatforms,
  hidePlatforms: zernioHidePlatforms,
  commentDeletePlatforms: zernioCommentDeletePlatforms,
  likePlatforms: zernioLikePlatforms,
  mentionPlatforms: zernioMentionPlatforms,
} = zernioInternals;

/** Validator media items: public HTTPS URLs only, with their per-attachment fields. */
function validationMedia(
  content: PublishContent,
  mediaFields: readonly JsonObject[],
): readonly JsonObject[] {
  return (content.media ?? []).map((item, index) => {
    if (item.source.kind !== "https-url")
      return invalid("posts.validate", "Validation takes public HTTPS media URLs only.");

    return { type: item.kind, url: httpsUrl(item.source.url).href, ...mediaFields[index] };
  });
}

/** Zernio explains errors under `error` and warnings under `warning`. */
function validationIssues(value: JsonField): readonly JsonObject[] {
  return isJsonArray(value)
    ? value.map((entry) =>
        publicFields(entry, ["platform", "field", "code", "message", "error", "warning"]),
      )
    : [];
}

export interface ZernioConnectionOptions {
  platform: string;
  profileId: string;
  redirectUrl: string;
  /** Refresh this existing account (same platform and profile) instead of adding a new one. */
  reconnectAccountId?: string;
  /** Instagram Login only: show the login page even when another account is signed in. */
  forceReauth?: boolean;
  /** Connect only if the login lands on this platform account ID; otherwise `account_mismatch`. */
  expectedPlatformUserId?: string;
  /** Connect only if the authorized handle is this one (case-insensitive, `@` ignored). */
  expectedUsername?: string;
  /** Request only these permission areas instead of the platform's full set. */
  scopes?: readonly ("posting" | "analytics" | "comments" | "messaging" | "ads")[];
  /** Connect through one of your own OAuth apps (`listOAuthApps`). */
  oauthAppId?: string;
  /** Instagram: `instagram_login` (Zernio's default) or `facebook_login`. */
  loginMethod?: "instagram_login" | "facebook_login";
  /** Send the user to a branded welcome screen first. */
  welcome?: boolean;
  /** Welcome screen product name, 1 to 60 characters. */
  brandName?: string;
  /** Welcome screen button colour, `#RRGGBB`. */
  primaryColor?: string;
  /** Welcome screen logo, an HTTPS URL of a square image. */
  logoUrl?: string;
}

export interface ZernioSubmitPostInput {
  readonly account: ConnectedAccountRef;
  readonly content: PublishContent;
  readonly options?: JsonObject;
  readonly submission: Exclude<ZernioSubmission, { readonly kind: "publish" }>;
}

export interface ZernioBlueskyConnection {
  /** Bluesky handle (such as `user.bsky.social`) or account email. */
  readonly identifier: string;
  /** An app password from Bluesky Settings, never the account password. */
  readonly appPassword: string;
  /** `{userId}-{profileId}` as Zernio documents it. */
  readonly state: string;
  readonly redirectUrl?: string;
}

export interface ZernioProfileInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly color?: string;
  /** IANA time zone used when a post names none. `null` returns to UTC. */
  readonly timezone?: string | null;
  /** Your own tenant identifier, 1 to 255 characters. */
  readonly externalId?: string | null;
}

export interface ZernioRescheduleInput {
  readonly text?: string;
  readonly at?: string;
  readonly timeZone?: string;
}

export interface ZernioYouTubeMetadata {
  readonly title?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly categoryId?: string;
  readonly privacyStatus?: "public" | "private" | "unlisted";
  readonly thumbnailUrl?: string;
  readonly madeForKids?: boolean;
  readonly containsSyntheticMedia?: boolean;
  readonly playlistId?: string;
}

function profileBody(input: ZernioProfileInput): JsonObject {
  return {
    ...definedFields({
      name: input.name,
      description: input.description,
      color: input.color,
      timezone: input.timezone,
      externalId: input.externalId,
    }),
  };
}

function profileFields(value: JsonField): JsonObject {
  return publicFields(value, [
    "_id",
    "name",
    "description",
    "color",
    "timezone",
    "externalId",
    "isDefault",
  ]);
}

function stringList(value: JsonField): string[] {
  return isJsonArray(value) ? value.filter(isString) : [];
}

/** Account insight routes by platform (docs.zernio.com/analytics, 2026-11-04). */
const insightRoutes = new Map<string, string>([
  ["instagram", "/v1/analytics/instagram/account-insights"],
  ["facebook", "/v1/analytics/facebook/page-insights"],
  ["tiktok", "/v1/analytics/tiktok/account-insights"],
  ["youtube", "/v1/analytics/youtube/channel-insights"],
  ["linkedin", "/v1/analytics/linkedin/org-aggregate-analytics"],
]);

type LinkedInReaction =
  | "LIKE"
  | "PRAISE"
  | "EMPATHY"
  | "INTEREST"
  | "APPRECIATION"
  | "ENTERTAINMENT";

function commentPath(ref: CommentRef): string {
  return `/v1/inbox/comments/${encodeURIComponent(ref.postId)}/${encodeURIComponent(ref.commentId)}`;
}

export interface ZernioWebhookInput {
  /** 1 to 50 characters. */
  readonly name: string;
  /** Public HTTPS endpoint that receives the events. */
  readonly url: string;
  /** HMAC-SHA256 secret behind `X-Zernio-Signature`. */
  readonly secret?: string;
  /** Event names such as `post.published` or `message.received`; at least one. */
  readonly events: readonly string[];
  readonly isActive?: boolean;
  /** Limit the subscription to these profiles or accounts. */
  readonly profileIds?: readonly string[];
  readonly accountIds?: readonly string[];
}

function webhookBody(input: Partial<ZernioWebhookInput>): JsonObject {
  if (input.name !== undefined && (input.name.length < 1 || input.name.length > 50))
    invalid("webhooks.write", "Webhook names are 1 to 50 characters.");

  if (input.events !== undefined && input.events.length === 0)
    invalid("webhooks.write", "Subscribe to at least one event.");

  return {
    ...definedFields({
      name: input.name,
      url: input.url === undefined ? undefined : httpsUrl(input.url).href,
      secret: input.secret,
      events: input.events && [...input.events],
      isActive: input.isActive,
      profileIds: input.profileIds && [...input.profileIds],
      accountIds: input.accountIds && [...input.accountIds],
    }),
  };
}

/** Webhook settings without the secret or custom headers. */
function webhookFields(value: JsonField): JsonObject {
  const row = object(value);

  return {
    ...publicFields(row, ["_id", "name", "url", "isActive", "lastFiredAt", "failureCount"]),
    events: stringList(row["events"]),
  };
}

/**
 * The named fields, nested values included. Use it only where Zernio documents a field's whole
 * structure; `publicFields` keeps scalars only.
 */
function documentedFields(value: JsonField, fields: readonly string[]): JsonObject {
  const data = object(value);

  return Object.fromEntries(
    fields.flatMap((field) => {
      const entry = data[field];

      return entry === undefined ? [] : [[field, entry]];
    }),
  );
}

/** The next page number as a cursor, when the response reports more pages. */
function nextPage(page: number, pages: number | undefined): string | undefined {
  return pages !== undefined && page < pages ? String(page + 1) : undefined;
}

/** Objects in an optional JSON array; any other entry is a decode error. */
function listOf(value: JsonField): readonly JsonObject[] {
  return value === undefined || value === null ? [] : array(value).map(object);
}

/** Zernio permission areas for a connect or an OAuth app. */
export type ZernioScopeArea = "posting" | "analytics" | "comments" | "messaging";

export type ZernioPostStatus =
  | "draft"
  | "pending_approval"
  | "scheduled"
  | "publishing"
  | "published"
  | "partial"
  | "failed"
  | "cancelled";

function instagramAudio(entry: JsonObject): JsonObject {
  return publicFields(entry, [
    "audioId",
    "title",
    "audioType",
    "durationInMs",
    "displayArtist",
    "coverArtworkThumbnailUrl",
    "igUsername",
    "isAdsEligible",
    "onPlatformAudioPreviewLink",
  ]);
}

function accountGroup(entry: JsonObject): JsonObject {
  return {
    ...definedFields({ groupId: optionalString(entry["_id"]) }),
    ...documentedFields(entry, ["name", "accountIds", "profileId"]),
  };
}

/** BCP-47 tags in an optional list; `null` means none are set. */
function languageList(value: JsonField): readonly string[] | null {
  return value === undefined || value === null ? null : array(value).filter(isString);
}

function discordSettings(entry: JsonObject): JsonObject {
  return publicFields(entry, [
    "channelId",
    "channelName",
    "channelType",
    "guildId",
    "webhookUsername",
    "webhookAvatarUrl",
  ]);
}

function pageInfo(entry: JsonObject): JsonObject {
  return documentedFields(entry, ["about", "description", "website", "phone", "emails", "hours"]);
}

function webhookSubscription(entry: JsonObject): JsonObject {
  return documentedFields(entry, [
    "pageId",
    "appSubscribed",
    "leadgen",
    "subscribedFields",
    "warning",
  ]);
}

/**
 * An OAuth app record. Zernio never returns the secrets; `hasSlackSigningSecret` says one is set.
 * `webhook` (Facebook, Instagram) and `slackEvents` (Slack) are the setup values to enter on
 * the app itself so the platform delivers comments and messages to it; both are null elsewhere.
 */
function oauthApp(entry: JsonObject): JsonObject {
  const { webhook, slackEvents } = entry;

  return {
    ...documentedFields(entry, [
      "id",
      "platform",
      "label",
      "clientId",
      "scopeAreas",
      "status",
      "lastCheckedAt",
      "lastError",
      "accountCount",
      "redirectUri",
      "sharedWebhookUrl",
      "hasSlackSigningSecret",
      "createdAt",
    ]),
    ...definedFields({
      webhook:
        webhook === undefined || webhook === null
          ? webhook
          : documentedFields(webhook, ["callbackUrl", "verifyToken", "object", "fields"]),
      slackEvents:
        slackEvents === undefined || slackEvents === null
          ? slackEvents
          : documentedFields(slackEvents, ["requestUrl", "botEvents"]),
    }),
  };
}

function welcomeScreen(entry: JsonObject): JsonObject {
  return documentedFields(entry, ["showByDefault", "brandName", "logoUrl", "theme"]);
}

/** A destination's account, sent as an ID string or a populated account object. */
function entryAccountId(value: JsonField): string | undefined {
  if (isString(value)) return value;

  return isJsonObject(value) ? optionalString(value["_id"]) : undefined;
}

const instagramPostFields = [
  "id",
  "caption",
  "mediaType",
  "permalink",
  "timestamp",
  "username",
  "likeCount",
  "commentsCount",
];

export interface GoogleBusinessLocationInput {
  readonly account: ConnectedAccountRef;
  /** A location of the account, such as `locations/123`; the selected location when omitted. */
  readonly locationId?: string;
}

export type GooglePlaceActionType =
  | "APPOINTMENT"
  | "ONLINE_APPOINTMENT"
  | "DINING_RESERVATION"
  | "FOOD_ORDERING"
  | "FOOD_DELIVERY"
  | "FOOD_TAKEOUT"
  | "SHOP_ONLINE";

export type GoogleMediaCategory =
  | "CATEGORY_UNSPECIFIED"
  | "COVER"
  | "PROFILE"
  | "LOGO"
  | "EXTERIOR"
  | "INTERIOR"
  | "PRODUCT"
  | "FOOD_AND_DRINK"
  | "MENU"
  | "COMMON_AREA"
  | "ROOMS"
  | "TEAMS"
  | "AT_WORK"
  | "ADDITIONAL";

/**
 * Daily metrics of `GET /v1/analytics/googlebusiness/performance` (Zernio OpenAPI v1.490.0,
 * checked 2026-11-04).
 */
const googlePerformanceMetrics = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "BUSINESS_CONVERSATIONS",
  "BUSINESS_DIRECTION_REQUESTS",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
  "BUSINESS_BOOKINGS",
  "BUSINESS_FOOD_ORDERS",
  "BUSINESS_FOOD_MENU_CLICKS",
] as const;

export type GoogleBusinessPerformanceMetric = (typeof googlePerformanceMetrics)[number];

function isGooglePerformanceMetric(value: string): value is GoogleBusinessPerformanceMetric {
  return googlePerformanceMetrics.some((metric) => metric === value);
}

/** One metric's daily values; `total` is absent when Zernio does not report it. */
export interface GoogleBusinessPerformanceSeries {
  readonly total?: number;
  readonly values: readonly { readonly date: string; readonly value: number }[];
}

export interface GoogleBusinessPerformance {
  readonly accountId: string;
  readonly dateRange?: { readonly startDate: string; readonly endDate: string };
  /** Only the metrics Zernio returned; a missing metric is unreported, not zero. */
  readonly metrics: Partial<
    Record<GoogleBusinessPerformanceMetric, GoogleBusinessPerformanceSeries>
  >;
  readonly dataDelay?: string;
}

function googlePerformanceSeries(value: JsonField): GoogleBusinessPerformanceSeries {
  const series = object(value);

  return {
    ...definedFields({ total: optionalNumber(series["total"]) }),
    values: listOf(series["values"]).map((day) => ({
      date: string(day["date"]),
      value: number(day["value"]),
    })),
  };
}

/** Location fields `updateGoogleBusinessLocationDetails` may write (Business Information API). */
const googleLocationFields = [
  "regularHours",
  "specialHours",
  "profile",
  "websiteUri",
  "phoneNumbers",
  "categories",
  "serviceItems",
  "title",
  "storeCode",
  "labels",
  "storefrontAddress",
  "serviceArea",
  "openInfo",
  "moreHours",
  "latlng",
  "adWordsLocationExtensions",
];

/** A review with the reviewer's display name and the owner reply; reviewer photos are dropped. */
function googleReview(entry: JsonObject): JsonObject {
  const reviewer = isJsonObject(entry["reviewer"]) ? entry["reviewer"] : {};
  const reply = isJsonObject(entry["reviewReply"]) ? entry["reviewReply"] : undefined;

  return {
    ...publicFields(entry, [
      "id",
      "name",
      "rating",
      "starRating",
      "comment",
      "createTime",
      "updateTime",
    ]),
    reviewer: publicFields(reviewer, ["displayName", "isAnonymous"]),
    ...definedFields({ reply: reply && publicFields(reply, ["comment", "updateTime"]) }),
  };
}

function placeAction(entry: JsonObject): JsonObject {
  return publicFields(entry, ["name", "uri", "placeActionType", "createTime", "updateTime"]);
}

/** Paging for Reddit listings: up to 100 items after a fullname cursor. */
function redditPage(limit: number | undefined, after: string | undefined): Record<string, string> {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100))
    invalid("posts.read", "limit is 1 to 100.");

  return definedFields({ limit: limit === undefined ? undefined : String(limit), after });
}

function redditListing(result: JsonObject): JsonObject {
  return {
    posts: listOf(result["items"]).map((post) =>
      publicFields(post, [
        "id",
        "fullname",
        "title",
        "author",
        "subreddit",
        "url",
        "permalink",
        "selftext",
        "createdUtc",
        "score",
        "numComments",
        "over18",
        "stickied",
        "flairText",
      ]),
    ),
    ...definedFields({ after: optionalString(result["after"]) }),
  };
}

export interface DiscordGuildInput {
  readonly account: ConnectedAccountRef;
  /** The server (guild) snowflake. */
  readonly guildId: string;
}

export interface DiscordChannelInput {
  readonly account: ConnectedAccountRef;
  readonly channelId: string;
}

export interface DiscordRoleFields {
  readonly name?: string;
  /** RGB color as an integer, 0 to 16777215. */
  readonly color?: number;
  readonly hoist?: boolean;
  readonly mentionable?: boolean;
  /** Discord permission bit set as a decimal string. */
  readonly permissions?: string;
}

function guildPath(input: DiscordGuildInput, rest: string): string {
  return `/v1/discord/guilds/${encodeURIComponent(input.guildId)}/${rest}`;
}

function channelPath(input: DiscordChannelInput, rest: string): string {
  return `/v1/discord/channels/${encodeURIComponent(input.channelId)}/${rest}`;
}

function discordRoleBody(input: DiscordRoleFields): JsonObject {
  if (input.name !== undefined && (input.name.length < 1 || input.name.length > 100))
    invalid("accounts.write", "A role name is 1 to 100 characters.");

  if (
    input.color !== undefined &&
    (!Number.isInteger(input.color) || input.color < 0 || input.color > 0xffffff)
  )
    invalid("accounts.write", "color is an integer from 0 to 16777215.");

  if (input.permissions !== undefined && !/^\d+$/.test(input.permissions))
    invalid("accounts.write", "permissions is a decimal permission bit set.");

  return definedFields({
    name: input.name,
    color: input.color,
    hoist: input.hoist,
    mentionable: input.mentionable,
    permissions: input.permissions,
  });
}

function discordRole(entry: JsonObject): JsonObject {
  return publicFields(entry, [
    "id",
    "name",
    "color",
    "position",
    "permissions",
    "managed",
    "mentionable",
    "hoist",
  ]);
}

function discordMember(entry: JsonObject): JsonObject {
  const user = isJsonObject(entry["user"]) ? entry["user"] : {};

  return {
    user: publicFields(user, ["id", "username", "global_name", "bot"]),
    ...documentedFields(entry, ["nick", "roles", "joined_at", "premium_since"]),
  };
}

function discordEvent(entry: JsonObject): JsonObject {
  return publicFields(entry, [
    "id",
    "guild_id",
    "channel_id",
    "name",
    "description",
    "scheduled_start_time",
    "scheduled_end_time",
    "status",
    "entity_type",
    "user_count",
  ]);
}

/** Shared checks for a scheduled event's name, description and times. */
function discordEventFields(input: {
  readonly name?: string;
  readonly description?: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly entity?: { readonly endsAt?: string };
}): void {
  if (input.name !== undefined && (!input.name.trim() || input.name.length > 100))
    invalid("accounts.write", "An event name is 1 to 100 characters.");

  if (input.description !== undefined && input.description.length > 1000)
    invalid("accounts.write", "An event description is up to 1,000 characters.");

  for (const time of [input.startsAt, input.endsAt, input.entity?.endsAt])
    if (time !== undefined && Number.isNaN(Date.parse(time)))
      invalid("accounts.write", "Event times are ISO 8601.");
}

function conversationPath(ref: ConversationRef): string {
  return `/v1/inbox/conversations/${encodeURIComponent(ref.conversationId)}`;
}

/** Account bot settings Zernio manages per account. */
export type ZernioBotSetting =
  | "messenger-menu"
  | "messenger-get-started"
  | "messenger-greeting"
  | "ice-breakers"
  | "telegram-commands";

export type ZernioBotSettingInput = { readonly account: ConnectedAccountRef } & (
  | { readonly setting: "messenger-menu"; readonly persistentMenu: readonly JsonObject[] }
  | { readonly setting: "messenger-get-started"; readonly payload: string }
  | {
      readonly setting: "messenger-greeting";
      readonly greetings: readonly { readonly locale: string; readonly text: string }[];
    }
  | {
      readonly setting: "ice-breakers";
      /** Facebook: one entry per locale, one of them `default`. Instagram: omit `locale`. */
      readonly iceBreakers: readonly {
        readonly locale?: string;
        readonly questions: readonly { readonly question: string; readonly payload: string }[];
      }[];
    }
  | {
      readonly setting: "telegram-commands";
      readonly commands: readonly { readonly command: string; readonly description: string }[];
    }
);

/** The PUT body of a bot setting, checked against Zernio's documented limits. */
function botSettingBody(input: ZernioBotSettingInput): JsonObject {
  switch (input.setting) {
    case "messenger-menu":
      if (input.persistentMenu.length === 0) invalid("messages.write", "Give at least one menu.");

      return { persistent_menu: [...input.persistentMenu] };

    case "messenger-get-started":
      if (!input.payload || input.payload.length > 1000)
        invalid("messages.write", "payload is 1 to 1,000 characters.");

      return { payload: input.payload };

    case "messenger-greeting":
      if (
        !input.greetings.some((entry) => entry.locale === "default") ||
        input.greetings.some((entry) => !entry.text || entry.text.length > 160)
      )
        invalid(
          "messages.write",
          "Greetings need a default locale and texts of 1 to 160 characters.",
        );

      return {
        greeting: input.greetings.map((entry) => ({ locale: entry.locale, text: entry.text })),
      };

    case "ice-breakers": {
      const instagram = input.account.platform === "instagram";
      const questions = input.iceBreakers.flatMap((entry) => entry.questions);

      if (
        input.iceBreakers.some(
          (entry) => entry.questions.length < 1 || entry.questions.length > 4,
        ) ||
        questions.some((entry) => !entry.question || entry.question.length > 80 || !entry.payload)
      )
        invalid(
          "messages.write",
          "Each locale has 1 to 4 questions of up to 80 characters with a payload.",
        );

      if (instagram) {
        if (input.iceBreakers.length !== 1 || input.iceBreakers[0]?.locale !== undefined)
          invalid(
            "messages.write",
            "Instagram ice breakers are one list of up to 4 questions without a locale.",
          );

        return {
          ice_breakers: questions.map((entry) => ({
            question: entry.question,
            payload: entry.payload,
          })),
        };
      }

      if (!input.iceBreakers.some((entry) => entry.locale === "default"))
        invalid("messages.write", "Facebook ice breakers need a default locale.");

      return {
        ice_breakers: input.iceBreakers.map((entry) => ({
          locale: entry.locale ?? "default",
          call_to_actions: entry.questions.map((question) => ({
            question: question.question,
            payload: question.payload,
          })),
        })),
      };
    }

    case "telegram-commands":
      if (
        input.commands.length > 100 ||
        input.commands.some(
          (entry) =>
            !/^[a-z0-9_]{1,32}$/.test(entry.command) ||
            !entry.description ||
            entry.description.length > 256,
        )
      )
        invalid(
          "messages.write",
          "Up to 100 commands of 1 to 32 lowercase letters, digits or _ with a 1 to 256 character description.",
        );

      return {
        commands: input.commands.map((entry) => ({
          command: entry.command,
          description: entry.description,
        })),
      };
  }
}

/**
 * Zernio's routes beyond the normalized adapter: connections, profiles, drafts and approval,
 * analytics reports, inbox management, Google Business, Reddit, Discord and webhook settings.
 * Native calls skip the client's authorization and concurrency checks; run your own first.
 */
export function zernioNative(options: ManagedOptions) {
  const { request, now, account, createPost } = zernioInternals.client(options);

  /** Read one Zernio post and prove its single destination is the referenced account. */
  const ownedPost = async (
    ref: Pick<ConnectedAccountRef, "backend" | "platform" | "accountId">,
    id: string,
    context: AdapterOperationContext,
  ): Promise<JsonObject> => {
    accountMatches(ref, context);

    if (!id) invalid("posts.read", "A Zernio post identifier is required.");

    const response = object(await request(`/v1/posts/${encodeURIComponent(id)}`, context));
    const record = object(response["post"] ?? response);
    const entries = array(record["platforms"]).map(object);
    const entry = entries[0];
    const raw = entry?.["accountId"];
    const accountId = isString(raw) ? raw : isJsonObject(raw) ? raw["_id"] : undefined;

    if (
      record["_id"] !== id ||
      entries.length !== 1 ||
      accountId !== ref.accountId ||
      !isString(entry?.["platform"]) ||
      normalizePlatform(entry["platform"]) !== ref.platform
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "posts.read",
        message: "The Zernio post does not belong to exactly this account and platform.",
      });

    return record;
  };

  const xAccount = (ref: ConnectedAccountRef, context: AdapterOperationContext) => {
    accountMatches(ref, context);

    if (ref.platform !== "x") invalid("posts.repost", "This engagement applies to X accounts.");
  };

  const xEngagement = async (
    action: "retweet" | "bookmark",
    flag: "retweeted" | "bookmarked",
    on: boolean,
    input: { readonly account: ConnectedAccountRef; readonly postId: string },
    context: AdapterOperationContext,
  ) => {
    xAccount(input.account, context);

    if (!/^\d{1,19}$/.test(input.postId)) invalid("posts.repost", "X post IDs are numeric.");

    const path = `/v1/twitter/${action}`;
    const fields = { accountId: input.account.accountId, tweetId: input.postId };

    const result = object(
      on
        ? await request(path, context, fields)
        : await request(path, context, undefined, fields, "DELETE"),
    );

    if (result[flag] !== on) unconfirmed("posts.repost");
  };

  const likeable = (
    ref: Pick<ConnectedAccountRef, "backend" | "platform" | "accountId">,
    context: AdapterOperationContext,
  ) => {
    accountMatches(ref, context);

    if (!zernioLikePlatforms.includes(ref.platform))
      invalid(
        "likes.write",
        "Zernio likes posts and comments on LinkedIn, X, Facebook, YouTube and Bluesky.",
      );
  };

  const reviewable = (ref: ConnectedAccountRef, context: AdapterOperationContext) => {
    accountMatches(ref, context);

    if (ref.platform !== "facebook" && ref.platform !== "google-business")
      invalid("comments.read", "Reviews come from Facebook Pages and Google Business Profile.");
  };

  const deliveryContext = (ref: DeliveryRef) => ({
    account: {
      kind: "connected-account" as const,
      version: 1 as const,
      backend: ref.backend,
      platform: ref.platform,
      accountId: ref.accountId,
    },
    targetIndex: 0,
    observedAt: now(),
  });

  /**
   * `/v1/accounts/{id}/{route}` after checking the account belongs to this request and is one of
   * the platforms the route serves.
   */
  const accountRoute = (
    ref: Pick<ConnectedAccountRef, "backend" | "platform" | "accountId">,
    context: AdapterOperationContext,
    operation: string,
    platforms: readonly Platform[],
    route: string,
  ) => {
    accountMatches(ref, context);

    if (!platforms.includes(ref.platform))
      invalid(operation, `This Zernio route serves ${platforms.join(", ")} accounts.`);

    return `/v1/accounts/${encodeURIComponent(ref.accountId)}/${route}`;
  };

  /** Visitor or tagged posts of a Facebook Page, paged by cursor. */
  const facebookPagePosts = async (
    input: {
      readonly account: ConnectedAccountRef;
      readonly limit?: number;
      readonly cursor?: string;
    },
    context: AdapterOperationContext,
    route: "facebook-visitor-posts" | "facebook-tagged-posts",
    max: number,
  ) => {
    const limit = input.limit ?? 25;

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > max)
      invalid("posts.read", `limit is 1 to ${max}.`);

    const result = object(
      await request(
        accountRoute(input.account, context, "posts.read", ["facebook"], route),
        context,
        undefined,
        {
          limit: String(limit),
          ...definedFields({ cursor: input.cursor }),
        },
      ),
    );

    return {
      posts: listOf(result["data"]).map((post) => ({
        ...publicFields(post, ["id", "message", "createdTime", "taggedTime", "permalinkUrl"]),
        ...definedFields({
          from: isJsonObject(post["from"]) ? publicFields(post["from"], ["id", "name"]) : undefined,
        }),
      })),
      ...definedFields({ nextCursor: optionalString(result["nextCursor"]) }),
    };
  };

  /** A Google Business route of one account, for its selected location or `locationId`. */
  const googleBusiness = async (
    input: GoogleBusinessLocationInput,
    context: AdapterOperationContext,
    operation: string,
    route: string,
    call: {
      readonly body?: JsonObject;
      readonly query?: Readonly<Record<string, string>>;
      readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    } = {},
  ) =>
    object(
      await request(
        accountRoute(input.account, context, operation, ["google-business"], route),
        context,
        call.body,
        { ...definedFields({ locationId: input.locationId }), ...call.query },
        call.method,
      ),
    );

  /** An account-scoped analytics route that takes `accountId` as a query parameter. */
  const platformAnalyticsAccount = (
    ref: Pick<ConnectedAccountRef, "backend" | "platform" | "accountId">,
    context: AdapterOperationContext,
    expected: Platform,
  ) => {
    accountMatches(ref, context);

    if (ref.platform !== expected)
      invalid("analytics.read", `This report serves ${expected} accounts.`);
  };

  /** The route of one bot setting, after checking the account's platform serves it. */
  const botRoute = (
    ref: ConnectedAccountRef,
    setting: ZernioBotSetting,
    context: AdapterOperationContext,
  ): string => {
    if (setting === "ice-breakers")
      return accountRoute(
        ref,
        context,
        "messages.write",
        ["facebook", "instagram"],
        ref.platform === "instagram" ? "instagram-ice-breakers" : "messenger-ice-breakers",
      );

    if (setting === "telegram-commands")
      return accountRoute(ref, context, "messages.write", ["telegram"], "telegram-commands");

    return accountRoute(ref, context, "messages.write", ["facebook"], setting);
  };

  const redditAccount = (ref: ConnectedAccountRef, context: AdapterOperationContext) => {
    accountMatches(ref, context);

    if (ref.platform !== "reddit")
      invalid("posts.read", "This Zernio route serves Reddit accounts.");
  };

  const discordAccount = (ref: ConnectedAccountRef, context: AdapterOperationContext) => {
    accountMatches(ref, context);

    if (ref.platform !== "discord")
      invalid("accounts.read", "This Zernio route serves Discord accounts.");
  };

  /** A `/v1/discord/...` route acting as the connected bot of `account`. */
  const discord = async (
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
    operation: string,
    path: string,
    call: {
      readonly body?: JsonObject;
      readonly query?: Readonly<Record<string, string>>;
      readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      /** Event create and update carry `accountId` in the body instead of the query. */
      readonly accountQuery?: boolean;
    } = {},
  ) => {
    discordAccount(account, context);

    if (!/^\d+$/.test(path.split("/")[4] ?? ""))
      invalid(operation, "Discord server and channel IDs are numeric snowflakes.");

    return object(
      await request(
        path,
        context,
        call.body,
        {
          ...definedFields({
            accountId: call.accountQuery === false ? undefined : account.accountId,
          }),
          ...call.query,
        },
        call.method,
      ),
    );
  };

  return {
    async createConnection(input: ZernioConnectionOptions, context: AdapterOperationContext) {
      const slug = platform(input.platform, options);

      if (
        input.brandName !== undefined &&
        (input.brandName.length < 1 || input.brandName.length > 60)
      )
        invalid("accounts.connect", "brandName is 1 to 60 characters.");

      if (input.primaryColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(input.primaryColor))
        invalid("accounts.connect", "primaryColor is #RRGGBB.");

      if (
        (input.brandName ?? input.primaryColor ?? input.logoUrl) !== undefined &&
        input.welcome !== true
      )
        invalid(
          "accounts.connect",
          "brandName, primaryColor and logoUrl style the welcome screen; set welcome.",
        );

      for (const value of [input.expectedPlatformUserId, input.expectedUsername])
        if (value !== undefined && (!value.trim() || value.length > 100))
          invalid("accounts.connect", "Expected account values are 1 to 100 characters.");

      if (input.scopes?.length === 0)
        invalid("accounts.connect", "Leave scopes out for the full set.");

      const response = object(
        await request(`/v1/connect/${encodeURIComponent(wirePlatform(slug))}`, context, undefined, {
          profileId: input.profileId,
          redirect_url: input.redirectUrl,
          ...definedFields({
            reconnectAccountId: input.reconnectAccountId,
            forceReauth: input.forceReauth === undefined ? undefined : String(input.forceReauth),
            expectedPlatformUserId: input.expectedPlatformUserId,
            expectedUsername: input.expectedUsername,
            scopes: input.scopes?.join(","),
            oauthAppId: input.oauthAppId,
            loginMethod: input.loginMethod,
            welcome: input.welcome === undefined ? undefined : String(input.welcome),
            brandName: input.brandName,
            primaryColor: input.primaryColor,
            logoUrl: input.logoUrl === undefined ? undefined : httpsUrl(input.logoUrl).href,
          }),
        }),
      );

      return {
        url: string(response["authUrl"]),
        ...definedFields({ providerState: optionalString(response["state"]) }),
      };
    },
    async listProfiles(context: AdapterOperationContext) {
      const result = object(await request("/v1/profiles", context));

      return array(result["profiles"]).map((entry) =>
        publicFields(entry, ["_id", "name", "description"]),
      );
    },
    /** Connect a Bluesky account with an app password (POST /v1/connect/bluesky/credentials). */
    async connectBluesky(input: ZernioBlueskyConnection, context: AdapterOperationContext) {
      if (!input.identifier.trim() || !input.appPassword.trim())
        invalid("accounts.connect", "A Bluesky identifier and app password are required.");

      if (!/^[^-\s]+-[^-\s]+$/.test(input.state))
        invalid("accounts.connect", "state must be {userId}-{profileId}.");

      const response = object(
        await request("/v1/connect/bluesky/credentials", context, {
          identifier: input.identifier,
          appPassword: input.appPassword,
          state: input.state,
          ...definedFields({
            redirect_url: input.redirectUrl ? httpsUrl(input.redirectUrl).href : undefined,
          }),
        }),
      );

      const connected = response["account"];

      if (connected === undefined) return unconfirmed("accounts.connect");

      return account(connected, context.backendInstance);
    },
    async createProfile(
      input: ZernioProfileInput & { readonly name: string },
      context: AdapterOperationContext,
    ) {
      if (!input.name.trim()) invalid("profiles.write", "A profile name is required.");

      const response = object(await request("/v1/profiles", context, profileBody(input)));

      return profileFields(response["profile"]);
    },
    async updateProfile(
      input: ZernioProfileInput & { readonly profileId: string },
      context: AdapterOperationContext,
    ) {
      const { profileId, ...fields } = input;
      const body = profileBody(fields);

      if (Object.keys(body).length === 0)
        invalid("profiles.write", "Provide at least one profile field to change.");

      const response = object(
        await request(`/v1/profiles/${encodeURIComponent(profileId)}`, context, body, {}, "PUT"),
      );

      return profileFields(response["profile"]);
    },
    async deleteProfile(input: { readonly profileId: string }, context: AdapterOperationContext) {
      const response = object(
        await request(
          `/v1/profiles/${encodeURIComponent(input.profileId)}`,
          context,
          undefined,
          {},
          "DELETE",
        ),
      );

      if (!isString(response["message"])) unconfirmed("profiles.write");
    },
    /** Move a connected account to another profile (PATCH /v1/accounts/{id}). */
    async moveAccount(
      input: { readonly account: ConnectedAccountRef; readonly profileId: string },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.account, context);

      const response = object(
        await request(
          `/v1/accounts/${encodeURIComponent(input.account.accountId)}`,
          context,
          { profileId: input.profileId },
          {},
          "PATCH",
        ),
      );

      if (response["profileId"] !== input.profileId) unconfirmed("accounts.write");
    },
    /** Token, permission and sync health for one account (GET /v1/accounts/{id}/health). */
    async getAccountHealth(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.account, context);

      const row = object(
        await request(
          `/v1/accounts/${encodeURIComponent(input.account.accountId)}/health`,
          context,
        ),
      );

      if (
        row["accountId"] !== input.account.accountId ||
        !isString(row["platform"]) ||
        normalizePlatform(row["platform"]) !== input.account.platform
      )
        throw new SocialError({
          code: "unauthorized",
          operation: "accounts.read",
          message: "Zernio returned health for a different account.",
        });

      const token = isJsonObject(row["tokenStatus"]) ? row["tokenStatus"] : {};
      const permissions = isJsonObject(row["permissions"]) ? row["permissions"] : {};

      return {
        ...publicFields(row, ["status", "disconnectReason", "disconnectionType", "unhealthySince"]),
        token: publicFields(token, ["valid", "expiresAt", "needsRefresh"]),
        permissions: {
          ...publicFields(permissions, ["canPost", "canFetchAnalytics"]),
          missingRequired: stringList(permissions["missingRequired"]),
        },
        issues: stringList(row["issues"]),
        recommendations: stringList(row["recommendations"]),
      };
    },
    /** Disconnect and remove an account from Zernio (DELETE /v1/accounts/{id}). */
    async disconnectAccount(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.account, context);

      const response = object(
        await request(
          `/v1/accounts/${encodeURIComponent(input.account.accountId)}`,
          context,
          undefined,
          {},
          "DELETE",
        ),
      );

      if (!isString(response["message"])) unconfirmed("accounts.write");
    },
    /**
     * Save a draft, hold a post for approval or take the next queue slot. The options and
     * checks are the same as `posts.publish`.
     */
    async submitPost(input: ZernioSubmitPostInput, context: AdapterOperationContext) {
      const target: PreparedPublishTarget = {
        targetIndex: 0,
        targetKey: "native",
        account: input.account,
        content: input.content,
        ...definedFields({ options: input.options }),
      };

      const issues = [
        ...managedPreparation(target, "zernio"),
        ...managedOptionIssues(target, "zernio", zernioKeysWithCommon),
        ...zernioTargetData(target).issues,
      ];

      if (input.submission.kind === "approval" && !Number.isFinite(Date.parse(input.submission.at)))
        invalid("posts.publish", "An approval post needs a scheduled time.");

      if (issues.some((issue) => issue.severity === "error"))
        throw new SocialError({
          code: "invalid_input",
          operation: "posts.publish",
          message: `Post options failed preparation: ${issues.map((issue) => issue.code).join(", ")}.`,
        });

      return createPost(target, context, input.submission);
    },
    /** Approve (schedules it) or reject (returns it to draft) a pending_approval post. */
    async reviewPost(
      input: { readonly delivery: DeliveryRef; readonly decision: "approve" | "reject" },
      context: AdapterOperationContext,
    ) {
      await ownedPost(input.delivery, input.delivery.deliveryId, context);

      return zernioOutcome(
        await request(
          `/v1/posts/${encodeURIComponent(input.delivery.deliveryId)}/review`,
          context,
          { decision: input.decision },
        ),
        deliveryContext(input.delivery),
      );
    },
    /** Change the text or time of a draft, scheduled, failed or cancelled post (PUT /v1/posts/{id}). */
    async reschedulePost(
      input: ZernioRescheduleInput & { readonly delivery: DeliveryRef },
      context: AdapterOperationContext,
    ) {
      const record = await ownedPost(input.delivery, input.delivery.deliveryId, context);

      if (!["draft", "scheduled", "failed", "cancelled"].includes(String(record["status"])))
        invalid("posts.update", "Only a draft, scheduled, failed or cancelled post can change.");

      if (input.at !== undefined && !(Date.parse(input.at) > Date.parse(now())))
        invalid("posts.update", "A new schedule time must be in the future.");

      const body = {
        ...definedFields({
          content: input.text,
          scheduledFor: input.at,
          timezone: input.timeZone || undefined,
        }),
      };

      if (Object.keys(body).length === 0)
        invalid("posts.update", "Provide new text or a new schedule time.");

      return zernioOutcome(
        await request(
          `/v1/posts/${encodeURIComponent(input.delivery.deliveryId)}`,
          context,
          body,
          {},
          "PUT",
        ),
        deliveryContext(input.delivery),
      );
    },
    /**
     * Edit the text of a published post (POST /v1/posts/{id}/edit). X assigns a new post ID, so
     * use the returned reference afterwards.
     */
    async updatePost(
      input: { readonly post: PlatformPostRef; readonly text: string },
      context: AdapterOperationContext,
    ): Promise<PlatformPostRef> {
      if (!zernioEditablePlatforms.includes(input.post.platform))
        invalid("posts.update", "Zernio cannot edit published posts on this platform.");

      if (!input.text.trim()) invalid("posts.update", "New text is required.");

      const recordId = string(input.post.native?.["backendRecordId"]);
      const record = await ownedPost(input.post, recordId, context);
      const entry = object(array(record["platforms"])[0]);

      if (entry["platformPostId"] !== input.post.postId)
        invalid("posts.update", "The backend record does not identify this published post.");

      const result = object(
        await request(`/v1/posts/${encodeURIComponent(recordId)}/edit`, context, {
          platform: wirePlatform(input.post.platform),
          content: input.text,
          accountId: input.post.accountId,
        }),
      );

      if (result["success"] !== true) unconfirmed("posts.update");

      return { ...input.post, postId: string(result["id"]) };
    },
    /** Update a YouTube video's metadata without re-uploading it (direct video ID mode). */
    async updateYouTubeMetadata(
      input: { readonly post: PlatformPostRef; readonly metadata: ZernioYouTubeMetadata },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.post, context);

      if (input.post.platform !== "youtube")
        invalid("posts.update", "Metadata updates apply to YouTube videos.");

      const { tags, thumbnailUrl, title } = input.metadata;

      if (title !== undefined && (title.length === 0 || title.length > 100))
        invalid("posts.update", "YouTube titles are 1 to 100 characters.");

      if (tags && tags.join("").length > 500)
        invalid("posts.update", "YouTube tags are limited to 500 characters combined.");

      const fields = {
        ...definedFields({
          ...input.metadata,
          tags: tags && [...tags],
          thumbnailUrl: thumbnailUrl === undefined ? undefined : httpsUrl(thumbnailUrl).href,
        }),
      };

      if (Object.keys(fields).length === 0)
        invalid("posts.update", "Provide at least one metadata field to change.");

      const result = object(
        await request("/v1/posts/_/update-metadata", context, {
          platform: "youtube",
          videoId: input.post.postId,
          accountId: input.post.accountId,
          ...fields,
        }),
      );

      if (result["success"] !== true) unconfirmed("posts.update");

      return { updatedFields: stringList(result["updatedFields"]) };
    },
    /** Retry a failed post now (POST /v1/posts/{id}/retry). */
    async retryPost(input: { readonly delivery: DeliveryRef }, context: AdapterOperationContext) {
      const record = await ownedPost(input.delivery, input.delivery.deliveryId, context);

      if (record["status"] !== "failed")
        invalid("posts.publish", "Only a failed post can be retried.");

      return zernioOutcome(
        await request(
          `/v1/posts/${encodeURIComponent(input.delivery.deliveryId)}/retry`,
          context,
          {},
        ),
        deliveryContext(input.delivery),
      );
    },
    /**
     * Dry-run Zernio's validator over one target (POST /v1/tools/validate/post). Media must be
     * public HTTPS URLs; nothing is uploaded or created.
     */
    async validatePost(
      input: {
        readonly account: ConnectedAccountRef;
        readonly content: PublishContent;
        readonly options?: JsonObject;
      },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.account, context);

      const target: PreparedPublishTarget = {
        targetIndex: 0,
        targetKey: "validate",
        account: input.account,
        content: input.content,
        ...definedFields({ options: input.options }),
      };

      const data = zernioTargetData(target);

      const result = object(
        await request("/v1/tools/validate/post", context, {
          content: input.content.text ?? "",
          mediaItems: validationMedia(input.content, data.mediaFields),
          ...data.root,
          platforms: [
            {
              platform: wirePlatform(input.account.platform),
              accountId: input.account.accountId,
              ...definedFields({
                platformSpecificData: Object.keys(data.native).length ? data.native : undefined,
              }),
            },
          ],
        }),
      );

      return {
        valid: result["valid"] === true,
        errors: validationIssues(result["errors"]),
        warnings: validationIssues(result["warnings"]),
        localIssues: data.issues,
      };
    },
    /**
     * Dry-run several destinations in one validator call (POST /v1/tools/validate/post).
     * `content` is the shared text and media; a target's own `content` becomes its
     * `platforms[].customContent` and `customMedia`, which replace the shared values on that
     * destination only.
     */
    async validatePosts(
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
      if (input.targets.length === 0)
        invalid("posts.validate", "Validate at least one destination.");

      const issues: PreparationIssue[] = [];

      const platforms = input.targets.map((entry, index) => {
        accountMatches(entry.account, context);

        const content: PublishContent = { ...input.content, ...entry.content };

        const data = zernioTargetData({
          targetIndex: index,
          targetKey: `validate-${index}`,
          account: entry.account,
          content,
          ...definedFields({ options: entry.options }),
        });

        issues.push(...data.issues);

        const ownMedia =
          entry.content?.media !== undefined || entry.options?.["mediaOptions"] !== undefined;

        return {
          platform: wirePlatform(entry.account.platform),
          accountId: entry.account.accountId,
          ...definedFields({
            customContent: entry.content?.text,
            customMedia: ownMedia ? validationMedia(content, data.mediaFields) : undefined,
            platformSpecificData: Object.keys(data.native).length ? data.native : undefined,
          }),
        };
      });

      const result = object(
        await request("/v1/tools/validate/post", context, {
          content: input.content.text ?? "",
          mediaItems: validationMedia(input.content, []),
          platforms,
        }),
      );

      return {
        valid: result["valid"] === true,
        errors: validationIssues(result["errors"]),
        warnings: validationIssues(result["warnings"]),
        localIssues: issues,
      };
    },
    /**
     * TikTok creator info for the required pre-post screen: privacy levels, posting state and
     * limits (GET /v1/accounts/{id}/tiktok/creator-info).
     */
    async creatorInfo(
      input: { readonly account: ConnectedAccountRef; readonly mediaType?: "video" | "photo" },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.account, context);

      if (input.account.platform !== "tiktok")
        invalid("accounts.read", "Creator info applies to TikTok accounts.");

      const result = object(
        await request(
          `/v1/accounts/${encodeURIComponent(input.account.accountId)}/tiktok/creator-info`,
          context,
          undefined,
          definedFields({ mediaType: input.mediaType }),
        ),
      );

      const creator = isJsonObject(result["creator"]) ? result["creator"] : {};
      const limits = isJsonObject(result["postingLimits"]) ? result["postingLimits"] : {};

      const values = (value: JsonField) =>
        isJsonArray(value)
          ? value.flatMap((entry) => {
              const option = isJsonObject(entry) ? entry["value"] : undefined;

              return isString(option) ? [option] : [];
            })
          : [];

      return {
        creator: publicFields(creator, ["nickname", "isVerified", "canPostMore"]),
        privacyLevels: values(result["privacyLevels"]),
        commercialContentTypes: values(result["commercialContentTypes"]),
        ...definedFields({ maxVideoDurationSec: optionalNumber(limits["maxVideoDurationSec"]) }),
      };
    },
    /** Follower count history and growth for one or more accounts (analytics add-on). */
    async followerStats(
      input: {
        readonly accounts: readonly ConnectedAccountRef[];
        readonly fromDate?: string;
        readonly toDate?: string;
        readonly granularity?: "daily" | "weekly" | "monthly";
      },
      context: AdapterOperationContext,
    ) {
      if (input.accounts.length === 0) invalid("analytics.read", "Name at least one account.");

      for (const ref of input.accounts) accountMatches(ref, context);

      for (const date of [input.fromDate, input.toDate])
        if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date))
          invalid("analytics.read", "Dates are YYYY-MM-DD.");

      const result = object(
        await request("/v1/accounts/follower-stats", context, undefined, {
          accountIds: input.accounts.map((ref) => ref.accountId).join(","),
          ...definedFields({
            fromDate: input.fromDate,
            toDate: input.toDate,
            granularity: input.granularity,
          }),
        }),
      );

      if (result["requiresAddon"] === true)
        throw new SocialError({
          code: "billing_required",
          operation: "analytics.read",
          message: "Zernio follower stats need the Analytics add-on.",
        });

      const wanted = new Set(input.accounts.map((ref) => ref.accountId));
      const stats = isJsonObject(result["stats"]) ? result["stats"] : {};

      return {
        // Keep only the requested accounts' series, keyed by Zernio account ID.
        stats: Object.fromEntries(Object.entries(stats).filter(([id]) => wanted.has(id))),
        ...definedFields({ granularity: optionalString(result["granularity"]) }),
      };
    },
    /**
     * Account-level insights or audience demographics, for Instagram, Facebook Pages, TikTok,
     * YouTube and LinkedIn (`/v1/analytics/{platform}/account-insights` and `/demographics`).
     */
    async accountInsights(
      input: {
        readonly account: ConnectedAccountRef;
        readonly kind?: "insights" | "demographics";
        readonly metrics?: readonly string[];
        readonly breakdown?: string;
        readonly fromDate?: string;
        readonly toDate?: string;
      },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.account, context);
      const kind = input.kind ?? "insights";

      const route =
        kind === "demographics"
          ? ["instagram", "facebook", "tiktok", "youtube", "linkedin"].includes(
              input.account.platform,
            )
            ? `/v1/analytics/${input.account.platform}/demographics`
            : undefined
          : insightRoutes.get(input.account.platform);

      if (route === undefined)
        return invalid(
          "analytics.account.read",
          "Zernio has no account insights for this platform.",
        );

      const result = object(
        await request(route, context, undefined, {
          accountId: input.account.accountId,
          ...definedFields({
            metrics: input.metrics?.join(","),
            breakdown: input.breakdown,
            fromDate: input.fromDate,
            toDate: input.toDate,
          }),
        }),
      );

      if (result["accountId"] !== undefined && result["accountId"] !== input.account.accountId)
        throw new SocialError({
          code: "unauthorized",
          operation: "analytics.account.read",
          message: "Zernio returned insights for a different account.",
        });

      return {
        metrics: isJsonObject(result["metrics"]) ? result["metrics"] : {},
        ...publicFields(result, ["metricType", "breakdown", "dataDelay"]),
        ...definedFields({
          demographics: isJsonObject(result["demographics"]) ? result["demographics"] : undefined,
        }),
      };
    },
    /** Daily views, watch time and retention for one YouTube video (YouTube Analytics scope). */
    async youtubeDailyViews(
      input: {
        readonly post: PlatformPostRef;
        readonly fromDate?: string;
        readonly toDate?: string;
      },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.post, context);

      if (input.post.platform !== "youtube")
        invalid("analytics.read", "Daily views apply to YouTube videos.");

      const result = object(
        await request("/v1/analytics/youtube/daily-views", context, undefined, {
          videoId: input.post.postId,
          accountId: input.post.accountId,
          ...definedFields({ fromDate: input.fromDate, toDate: input.toDate }),
        }),
      );

      if (result["videoId"] !== input.post.postId)
        throw new SocialError({
          code: "upstream_failure",
          operation: "analytics.read",
          message: "Zernio returned daily views for a different video.",
        });

      return {
        ...publicFields(result, [
          "totalViews",
          "durationSeconds",
          "provisionalSince",
          "lastSyncedAt",
        ]),
        days: array(result["dailyViews"]).map((entry) =>
          publicFields(entry, [
            "date",
            "views",
            "estimatedMinutesWatched",
            "averageViewDuration",
            "averageViewPercentage",
            "subscribersGained",
            "subscribersLost",
            "likes",
            "comments",
            "shares",
          ]),
        ),
      };
    },
    /** Best posting slots from past engagement (GET /v1/analytics/best-time, analytics add-on). */
    async bestTimes(
      input: { readonly account: ConnectedAccountRef; readonly source?: "late" | "external" },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.account, context);

      const result = object(
        await request("/v1/analytics/best-time", context, undefined, {
          accountId: input.account.accountId,
          ...definedFields({ source: input.source }),
        }),
      );

      return array(result["slots"]).map((entry) =>
        publicFields(entry, ["day_of_week", "hour", "avg_engagement", "post_count"]),
      );
    },
    /** How fast posts reach their final engagement (GET /v1/analytics/content-decay). */
    async contentDecay(
      input: { readonly account: ConnectedAccountRef; readonly source?: "late" | "external" },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.account, context);

      const result = object(
        await request("/v1/analytics/content-decay", context, undefined, {
          accountId: input.account.accountId,
          ...definedFields({ source: input.source }),
        }),
      );

      return array(result["buckets"]).map((entry) =>
        publicFields(entry, ["bucket_order", "bucket_label", "avg_pct_of_final", "post_count"]),
      );
    },
    /** Replies to one comment (Facebook, Instagram, Reddit, TikTok), via `commentId` on the list. */
    async listCommentReplies(
      input: { readonly comment: CommentRef; readonly cursor?: string; readonly limit?: number },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.comment, context);

      const result = object(
        await request(
          `/v1/inbox/comments/${encodeURIComponent(input.comment.postId)}`,
          context,
          undefined,
          {
            accountId: input.comment.accountId,
            commentId: input.comment.commentId,
            limit: String(input.limit ?? 25),
            ...definedFields({ cursor: input.cursor }),
          },
        ),
      );

      const pagination = isJsonObject(result["pagination"]) ? result["pagination"] : {};
      const cursor = optionalString(pagination["cursor"]);

      return {
        items: array(result["comments"])
          .filter((entry) => object(entry)["id"] !== input.comment.commentId)
          .map((entry) =>
            normalizeComment(
              inboxFields(entry, ["id", "message", "from", "createdTime", "likeCount", "parentId"]),
            ),
          ),
        ...definedFields({
          nextCursor: pagination["hasMore"] === true && cursor ? cursor : undefined,
        }),
      };
    },
    /** Hide or unhide a comment (POST or DELETE /v1/inbox/comments/{postId}/{commentId}/hide). */
    async moderateComment(
      input: { readonly comment: CommentRef; readonly action: "hide" | "unhide" },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.comment, context);

      if (!zernioHidePlatforms.includes(input.comment.platform))
        invalid("comments.moderate", "Zernio cannot hide comments on this platform.");

      const path = `${commentPath(input.comment)}/hide`;
      const hide = input.action === "hide";

      const result = object(
        hide
          ? await request(path, context, { accountId: input.comment.accountId })
          : await request(
              path,
              context,
              undefined,
              { accountId: input.comment.accountId },
              "DELETE",
            ),
      );

      if (result["hidden"] !== hide) unconfirmed("comments.moderate");
    },
    /** Delete a comment (DELETE /v1/inbox/comments/{postId}?commentId=). */
    async deleteComment(input: { readonly comment: CommentRef }, context: AdapterOperationContext) {
      accountMatches(input.comment, context);

      if (!zernioCommentDeletePlatforms.includes(input.comment.platform))
        invalid("comments.delete", "Zernio cannot delete comments on this platform.");

      const result = object(
        await request(
          `/v1/inbox/comments/${encodeURIComponent(input.comment.postId)}`,
          context,
          undefined,
          { accountId: input.comment.accountId, commentId: input.comment.commentId },
          "DELETE",
        ),
      );

      if (result["success"] !== true) unconfirmed("comments.delete");
    },
    /**
     * Answer a comment with one private DM (Instagram and Facebook; once per comment, within
     * seven days).
     */
    async privateReply(
      input: { readonly comment: CommentRef; readonly text: string },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.comment, context);

      if (input.comment.platform !== "instagram" && input.comment.platform !== "facebook")
        invalid("comments.write", "Private replies apply to Instagram and Facebook comments.");

      if (!input.text.trim()) invalid("comments.write", "Private reply text is required.");

      const result = object(
        await request(`${commentPath(input.comment)}/private-reply`, context, {
          accountId: input.comment.accountId,
          message: input.text,
        }),
      );

      if (result["status"] !== "success") unconfirmed("comments.write");

      return { ...definedFields({ messageId: optionalString(result["messageId"]) }) };
    },
    async likePost(
      input: {
        readonly post: PlatformPostRef;
        readonly reactionType?: LinkedInReaction;
        readonly cid?: string;
      },
      context: AdapterOperationContext,
    ) {
      likeable(input.post, context);

      const result = object(
        await request(`/v1/inbox/posts/${encodeURIComponent(input.post.postId)}/like`, context, {
          accountId: input.post.accountId,
          ...definedFields({ reactionType: input.reactionType, cid: input.cid }),
        }),
      );

      if (result["liked"] !== true) unconfirmed("likes.write");

      return { ...definedFields({ likeUri: optionalString(result["likeUri"]) }) };
    },
    async unlikePost(
      input: { readonly post: PlatformPostRef; readonly likeUri?: string },
      context: AdapterOperationContext,
    ) {
      likeable(input.post, context);

      const result = object(
        await request(
          `/v1/inbox/posts/${encodeURIComponent(input.post.postId)}/like`,
          context,
          undefined,
          { accountId: input.post.accountId, ...definedFields({ likeUri: input.likeUri }) },
          "DELETE",
        ),
      );

      if (result["liked"] !== false) unconfirmed("likes.write");
    },
    async likeComment(
      input: {
        readonly comment: CommentRef;
        readonly reactionType?: LinkedInReaction;
        readonly cid?: string;
      },
      context: AdapterOperationContext,
    ) {
      likeable(input.comment, context);

      const result = object(
        await request(`${commentPath(input.comment)}/like`, context, {
          accountId: input.comment.accountId,
          ...definedFields({ reactionType: input.reactionType, cid: input.cid }),
        }),
      );

      if (result["liked"] !== true) unconfirmed("likes.write");

      return { ...definedFields({ likeUri: optionalString(result["likeUri"]) }) };
    },
    async unlikeComment(
      input: { readonly comment: CommentRef; readonly likeUri?: string },
      context: AdapterOperationContext,
    ) {
      likeable(input.comment, context);

      const result = object(
        await request(
          `${commentPath(input.comment)}/like`,
          context,
          undefined,
          { accountId: input.comment.accountId, ...definedFields({ likeUri: input.likeUri }) },
          "DELETE",
        ),
      );

      if (result["liked"] !== false) unconfirmed("likes.write");
    },
    /** Pin or unpin a comment on your own post (POST or DELETE .../{commentId}/pin). */
    async pinComment(
      input: { readonly comment: CommentRef; readonly pinned: boolean },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.comment, context);
      const path = `${commentPath(input.comment)}/pin`;

      const result = object(
        input.pinned
          ? await request(path, context, { accountId: input.comment.accountId })
          : await request(
              path,
              context,
              undefined,
              { accountId: input.comment.accountId },
              "DELETE",
            ),
      );

      if (result["pinned"] !== input.pinned) unconfirmed("comments.moderate");
    },
    /** Retweet an X post (POST /v1/twitter/retweet). */
    async repost(
      input: { readonly account: ConnectedAccountRef; readonly postId: string },
      context: AdapterOperationContext,
    ) {
      await xEngagement("retweet", "retweeted", true, input, context);
    },
    async unrepost(
      input: { readonly account: ConnectedAccountRef; readonly postId: string },
      context: AdapterOperationContext,
    ) {
      await xEngagement("retweet", "retweeted", false, input, context);
    },
    async bookmark(
      input: { readonly account: ConnectedAccountRef; readonly postId: string },
      context: AdapterOperationContext,
    ) {
      await xEngagement("bookmark", "bookmarked", true, input, context);
    },
    async removeBookmark(
      input: { readonly account: ConnectedAccountRef; readonly postId: string },
      context: AdapterOperationContext,
    ) {
      await xEngagement("bookmark", "bookmarked", false, input, context);
    },
    /** Follow an X user by numeric ID. A protected account returns `pending: true`. */
    async follow(
      input: { readonly account: ConnectedAccountRef; readonly userId: string },
      context: AdapterOperationContext,
    ) {
      xAccount(input.account, context);

      const result = object(
        await request("/v1/twitter/follow", context, {
          accountId: input.account.accountId,
          targetUserId: input.userId,
        }),
      );

      if (result["following"] !== true && result["pending_follow"] !== true)
        unconfirmed("follows.write");

      return { pending: result["pending_follow"] === true };
    },
    async unfollow(
      input: { readonly account: ConnectedAccountRef; readonly userId: string },
      context: AdapterOperationContext,
    ) {
      xAccount(input.account, context);

      const result = object(
        await request(
          "/v1/twitter/follow",
          context,
          undefined,
          { accountId: input.account.accountId, targetUserId: input.userId },
          "DELETE",
        ),
      );

      if (result["following"] !== false) unconfirmed("follows.write");
    },
    /** Mark a conversation read (POST /v1/inbox/conversations/{id}/read). */
    async markConversationRead(
      input: { readonly conversation: ConversationRef },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.conversation, context);

      const result = object(
        await request(
          `/v1/inbox/conversations/${encodeURIComponent(input.conversation.conversationId)}/read`,
          context,
          { accountId: input.conversation.accountId },
        ),
      );

      if (result["success"] !== true) unconfirmed("messages.write");

      return { ...definedFields({ markedCount: optionalNumber(result["markedCount"]) }) };
    },
    /** Start a conversation with a user by ID or handle (POST /v1/inbox/conversations). */
    async startConversation(
      input: {
        readonly account: ConnectedAccountRef;
        readonly recipient: { readonly id: string } | { readonly username: string };
        readonly text: string;
      },
      context: AdapterOperationContext,
    ): Promise<ConversationRef> {
      accountMatches(input.account, context);

      if (!input.text.trim()) invalid("messages.write", "Message text is required.");

      const result = object(
        await request("/v1/inbox/conversations", context, {
          accountId: input.account.accountId,
          message: input.text,
          ...("id" in input.recipient
            ? { participantId: input.recipient.id }
            : { participantUsername: input.recipient.username }),
        }),
      );

      if (result["success"] !== true) unconfirmed("messages.write");

      return {
        ...input.account,
        kind: "conversation",
        conversationId: string(object(result["data"])["conversationId"]),
      };
    },
    /** Send text and/or one public attachment in a conversation. */
    async sendMessage(
      input: {
        readonly conversation: ConversationRef;
        readonly text?: string;
        readonly attachment?: {
          readonly url: string;
          readonly type: "image" | "video" | "audio" | "file";
        };
      },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.conversation, context);

      if (!input.text?.trim() && input.attachment === undefined)
        invalid("messages.write", "Send text, an attachment or both.");

      const result = object(
        await request(
          `/v1/inbox/conversations/${encodeURIComponent(input.conversation.conversationId)}/messages`,
          context,
          {
            accountId: input.conversation.accountId,
            ...definedFields({
              message: input.text,
              attachmentUrl: input.attachment && httpsUrl(input.attachment.url).href,
              attachmentType: input.attachment?.type,
            }),
          },
        ),
      );

      if (result["success"] !== true) unconfirmed("messages.write");

      return {
        state: "sent" as const,
        ...definedFields({
          messageId: isJsonObject(result["data"])
            ? optionalString(result["data"]["messageId"])
            : undefined,
        }),
      };
    },
    /** Mentions of the account (LinkedIn organizations, Instagram, Facebook Pages). */
    async listMentions(
      input: {
        readonly account: ConnectedAccountRef;
        readonly cursor?: string;
        readonly limit?: number;
      },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.account, context);

      if (!zernioMentionPlatforms.includes(input.account.platform))
        invalid("mentions.read", "Zernio reads mentions on LinkedIn, Instagram and Facebook.");

      const result = object(
        await request("/v1/inbox/mentions", context, undefined, {
          accountId: input.account.accountId,
          limit: String(input.limit ?? 25),
          ...definedFields({ cursor: input.cursor }),
        }),
      );

      const pagination = isJsonObject(result["pagination"]) ? result["pagination"] : {};
      const cursor = optionalString(pagination["cursor"]);

      return {
        items: array(result["data"])
          .filter((entry) => object(entry)["accountId"] === input.account.accountId)
          .map((entry) =>
            publicFields(entry, [
              "id",
              "platform",
              "type",
              "mediaId",
              "postId",
              "commentId",
              "content",
              "permalink",
              "authorName",
              "authorUsername",
              "publishedAt",
            ]),
          ),
        ...definedFields({
          nextCursor: pagination["hasMore"] === true && cursor ? cursor : undefined,
        }),
      };
    },
    /** Facebook Page and Google Business Profile reviews (GET /v1/inbox/reviews). */
    async listReviews(
      input: {
        readonly account: ConnectedAccountRef;
        readonly hasReply?: boolean;
        readonly cursor?: string;
        readonly limit?: number;
      },
      context: AdapterOperationContext,
    ) {
      reviewable(input.account, context);

      const result = object(
        await request("/v1/inbox/reviews", context, undefined, {
          accountId: input.account.accountId,
          limit: String(input.limit ?? 25),
          ...definedFields({
            cursor: input.cursor,
            hasReply: input.hasReply === undefined ? undefined : String(input.hasReply),
          }),
        }),
      );

      const pagination = isJsonObject(result["pagination"]) ? result["pagination"] : {};

      return {
        items: array(result["data"])
          .filter((entry) => object(entry)["accountId"] === input.account.accountId)
          .map((entry) => ({
            ...publicFields(entry, [
              "id",
              "rating",
              "recommendationType",
              "text",
              "created",
              "hasReply",
            ]),
            ...definedFields({
              reviewer: isJsonObject(object(entry)["reviewer"])
                ? publicFields(object(entry)["reviewer"], ["name"])
                : undefined,
              reply: isJsonObject(object(entry)["reply"])
                ? publicFields(object(entry)["reply"], ["id", "text", "created"])
                : undefined,
            }),
          })),
        ...definedFields({ nextCursor: optionalString(pagination["nextCursor"]) || undefined }),
      };
    },
    /** Reply to a review, or replace your reply (POST /v1/inbox/reviews/{id}/reply). */
    async replyToReview(
      input: {
        readonly account: ConnectedAccountRef;
        readonly reviewId: string;
        readonly text: string;
      },
      context: AdapterOperationContext,
    ) {
      reviewable(input.account, context);

      if (!input.text.trim()) invalid("comments.write", "Review reply text is required.");

      const result = object(
        await request(`/v1/inbox/reviews/${encodeURIComponent(input.reviewId)}/reply`, context, {
          accountId: input.account.accountId,
          message: input.text,
        }),
      );

      return publicFields(result["reply"] ?? unconfirmed("comments.write"), [
        "id",
        "text",
        "created",
      ]);
    },
    async deleteReviewReply(
      input: { readonly account: ConnectedAccountRef; readonly reviewId: string },
      context: AdapterOperationContext,
    ) {
      reviewable(input.account, context);

      await request(
        `/v1/inbox/reviews/${encodeURIComponent(input.reviewId)}/reply`,
        context,
        undefined,
        { accountId: input.account.accountId },
        "DELETE",
      );
    },
    /** Webhook subscriptions on this Zernio API key (GET /v1/webhooks/settings). */
    async listWebhooks(context: AdapterOperationContext) {
      const result = object(await request("/v1/webhooks/settings", context));

      return array(result["webhooks"]).map(webhookFields);
    },
    /**
     * Create a webhook. Pass the same `secret` you give the adapter as `webhookSecret` so
     * `X-Zernio-Signature` verifies.
     */
    async createWebhook(input: ZernioWebhookInput, context: AdapterOperationContext) {
      const body = webhookBody(input);

      const result = object(await request("/v1/webhooks/settings", context, body));

      if (result["success"] !== true) unconfirmed("webhooks.write");

      return webhookFields(result["webhook"] ?? {});
    },
    async updateWebhook(
      input: Partial<ZernioWebhookInput> & { readonly webhookId: string },
      context: AdapterOperationContext,
    ) {
      const { webhookId, ...fields } = input;

      const result = object(
        await request(
          "/v1/webhooks/settings",
          context,
          { _id: webhookId, ...webhookBody(fields) },
          {},
          "PUT",
        ),
      );

      if (result["success"] !== true) unconfirmed("webhooks.write");

      return webhookFields(result["webhook"] ?? {});
    },
    async deleteWebhook(input: { readonly webhookId: string }, context: AdapterOperationContext) {
      const result = object(
        await request(
          "/v1/webhooks/settings",
          context,
          undefined,
          { webhookId: input.webhookId },
          "DELETE",
        ),
      );

      if (result["success"] !== true) unconfirmed("webhooks.write");
    },
    /** Send a test delivery, optionally as a sample of one event type. */
    async testWebhook(
      input: { readonly webhookId: string; readonly event?: string },
      context: AdapterOperationContext,
    ) {
      const result = object(
        await request("/v1/webhooks/test", context, {
          webhookId: input.webhookId,
          ...definedFields({ event: input.event }),
        }),
      );

      if (result["success"] !== true) unconfirmed("webhooks.write");
    },
    /** The 25 most recent posts on the platform itself, live (GET /v1/accounts/{id}/posts). */
    async listPlatformPosts(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.account, context);
      const accountId = encodeURIComponent(input.account.accountId);
      const result = object(await request(`/v1/accounts/${accountId}/posts`, context));

      return array(result["posts"]).map((entry) =>
        publicFields(entry, [
          "id",
          "message",
          "createdTime",
          "permalink",
          "mediaType",
          "commentCount",
          "likeCount",
          "reactionCount",
          "shareCount",
          "cid",
        ]),
      );
    },
    /**
     * The Facebook Pages one connection can post to, and the selected default
     * (GET /v1/accounts/{id}/facebook-page). Publish to another Page with the `pageId` option.
     */
    async listFacebookPages(
      input: { readonly account: ConnectedAccountRef; readonly refresh?: boolean },
      context: AdapterOperationContext,
    ) {
      const result = object(
        await request(
          accountRoute(input.account, context, "accounts.read", ["facebook"], "facebook-page"),
          context,
          undefined,
          definedFields({
            refresh: input.refresh === undefined ? undefined : String(input.refresh),
          }),
        ),
      );

      return {
        pages: listOf(result["pages"]).map((page) =>
          publicFields(page, ["id", "name", "username", "category", "fan_count"]),
        ),
        ...definedFields({ selectedPageId: optionalString(result["selectedPageId"]) }),
      };
    },
    /** Set the connection's default Facebook Page (PUT /v1/accounts/{id}/facebook-page). */
    async selectFacebookPage(
      input: { readonly account: ConnectedAccountRef; readonly pageId: string },
      context: AdapterOperationContext,
    ) {
      if (!/^\d+$/.test(input.pageId)) invalid("accounts.write", "pageId is a numeric Page ID.");

      const result = object(
        await request(
          accountRoute(input.account, context, "accounts.write", ["facebook"], "facebook-page"),
          context,
          { selectedPageId: input.pageId },
          {},
          "PUT",
        ),
      );

      const selected = isJsonObject(result["selectedPage"]) ? result["selectedPage"] : {};

      if (selected["id"] !== input.pageId) unconfirmed("accounts.write");

      return publicFields(selected, ["id", "name"]);
    },
    /** Pinterest boards of an account (GET /v1/accounts/{id}/pinterest-boards), for `boardId`. */
    async listPinterestBoards(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["pinterest"],
        "pinterest-boards",
      );

      const result = object(await request(route, context));

      return listOf(result["boards"]).map((board) =>
        publicFields(board, ["id", "name", "description", "privacy"]),
      );
    },
    /** Create a Pinterest board (POST /v1/accounts/{id}/pinterest-boards). */
    async createPinterestBoard(
      input: {
        readonly account: ConnectedAccountRef;
        readonly name: string;
        readonly description?: string;
        readonly privacy?: "PUBLIC" | "PROTECTED" | "SECRET";
      },
      context: AdapterOperationContext,
    ) {
      if (!input.name.trim()) invalid("accounts.write", "A board needs a name.");

      const route = accountRoute(
        input.account,
        context,
        "accounts.write",
        ["pinterest"],
        "pinterest-boards",
      );

      const result = object(
        await request(route, context, {
          name: input.name,
          ...definedFields({ description: input.description, privacy: input.privacy }),
        }),
      );

      return publicFields(object(result["board"]), ["id", "name", "description", "privacy", "url"]);
    },
    /** Set the board Pins use when `boardId` is omitted (PUT /v1/accounts/{id}/pinterest-boards). */
    async setDefaultPinterestBoard(
      input: {
        readonly account: ConnectedAccountRef;
        readonly boardId: string;
        readonly boardName?: string;
      },
      context: AdapterOperationContext,
    ) {
      if (!input.boardId.trim()) invalid("accounts.write", "Name the board.");

      const route = accountRoute(
        input.account,
        context,
        "accounts.write",
        ["pinterest"],
        "pinterest-boards",
      );

      await request(
        route,
        context,
        {
          defaultBoardId: input.boardId,
          ...definedFields({ defaultBoardName: input.boardName }),
        },
        {},
        "PUT",
      );
    },
    /** YouTube playlists and the default one (GET /v1/accounts/{id}/youtube-playlists). */
    async listYouTubePlaylists(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["youtube"],
        "youtube-playlists",
      );

      const result = object(await request(route, context));

      return {
        playlists: listOf(result["playlists"]).map((playlist) =>
          publicFields(playlist, [
            "id",
            "title",
            "description",
            "privacy",
            "itemCount",
            "thumbnailUrl",
          ]),
        ),
        ...definedFields({ defaultPlaylistId: optionalString(result["defaultPlaylistId"]) }),
      };
    },
    /** Create a YouTube playlist (POST /v1/accounts/{id}/youtube-playlists). */
    async createYouTubePlaylist(
      input: {
        readonly account: ConnectedAccountRef;
        readonly title: string;
        readonly description?: string;
        readonly privacy?: "private" | "public" | "unlisted";
      },
      context: AdapterOperationContext,
    ) {
      if (!input.title.trim()) invalid("accounts.write", "A playlist needs a title.");

      const route = accountRoute(
        input.account,
        context,
        "accounts.write",
        ["youtube"],
        "youtube-playlists",
      );

      const result = object(
        await request(route, context, {
          title: input.title,
          ...definedFields({ description: input.description, privacy: input.privacy }),
        }),
      );

      return publicFields(object(result["playlist"]), [
        "id",
        "title",
        "description",
        "privacy",
        "itemCount",
        "thumbnailUrl",
      ]);
    },
    /** Set the playlist uploads join when `playlistId` is omitted (PUT .../youtube-playlists). */
    async setDefaultYouTubePlaylist(
      input: {
        readonly account: ConnectedAccountRef;
        readonly playlistId: string;
        readonly playlistName?: string;
      },
      context: AdapterOperationContext,
    ) {
      if (!input.playlistId.trim()) invalid("accounts.write", "Name the playlist.");

      const route = accountRoute(
        input.account,
        context,
        "accounts.write",
        ["youtube"],
        "youtube-playlists",
      );

      const result = object(
        await request(
          route,
          context,
          {
            defaultPlaylistId: input.playlistId,
            ...definedFields({ defaultPlaylistName: input.playlistName }),
          },
          {},
          "PUT",
        ),
      );

      if (result["success"] !== true) unconfirmed("accounts.write");
    },
    /** Google Business Profile locations for `locationId` (GET /v1/accounts/{id}/gmb-locations). */
    async listGoogleBusinessLocations(
      input: {
        readonly account: ConnectedAccountRef;
        readonly search?: string;
        readonly limit?: number;
      },
      context: AdapterOperationContext,
    ) {
      const limit = input.limit ?? 100;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        invalid("accounts.read", "limit is 1 to 500.");

      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["google-business"],
        "gmb-locations",
      );

      const result = object(
        await request(route, context, undefined, {
          limit: String(limit),
          ...definedFields({ search: input.search }),
        }),
      );

      return {
        locations: listOf(result["locations"]).map((location) =>
          publicFields(location, ["id", "name", "address", "category", "websiteUrl", "storeCode"]),
        ),
        hasMore: result["hasMore"] === true,
        ...definedFields({ selectedLocationId: optionalString(result["selectedLocationId"]) }),
      };
    },
    /** Subreddits the account can post to and its default (GET .../reddit-subreddits). */
    async listSubreddits(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["reddit"],
        "reddit-subreddits",
      );

      const result = object(await request(route, context));

      return {
        subreddits: listOf(result["subreddits"]).map((entry) =>
          publicFields(entry, ["id", "name", "title", "url", "over18"]),
        ),
        ...definedFields({ defaultSubreddit: optionalString(result["defaultSubreddit"]) }),
      };
    },
    /** Set the subreddit used when `subreddit` is omitted (PUT .../reddit-subreddits). */
    async setDefaultSubreddit(
      input: { readonly account: ConnectedAccountRef; readonly subreddit: string },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "accounts.write",
        ["reddit"],
        "reddit-subreddits",
      );

      const result = object(
        await request(
          route,
          context,
          { defaultSubreddit: subredditName(input.subreddit) },
          {},
          "PUT",
        ),
      );

      if (result["success"] !== true) unconfirmed("accounts.write");
    },
    /** A subreddit's posting rules and Reddit's site rules (GET .../reddit-subreddits/{name}/rules). */
    async subredditRules(
      input: { readonly account: ConnectedAccountRef; readonly subreddit: string },
      context: AdapterOperationContext,
    ) {
      const name = encodeURIComponent(subredditName(input.subreddit));

      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["reddit"],
        `reddit-subreddits/${name}/rules`,
      );

      const result = object(await request(route, context));

      return {
        rules: listOf(result["rules"]).map((rule) =>
          publicFields(rule, ["kind", "shortName", "description", "violationReason", "priority"]),
        ),
        siteRules:
          result["siteRules"] === undefined ? [] : array(result["siteRules"]).filter(isString),
      };
    },
    /** Post flairs of a subreddit, for `flairId` (GET /v1/accounts/{id}/reddit-flairs). */
    async listRedditFlairs(
      input: { readonly account: ConnectedAccountRef; readonly subreddit: string },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["reddit"],
        "reddit-flairs",
      );

      const result = object(
        await request(route, context, undefined, { subreddit: subredditName(input.subreddit) }),
      );

      return listOf(result["flairs"]).map((flair) =>
        publicFields(flair, ["id", "text", "textColor", "backgroundColor"]),
      );
    },
    /** Channels of the connected Discord server, for `channelId` (GET .../discord-channels). */
    async listDiscordChannels(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["discord"],
        "discord-channels",
      );

      const result = object(await request(route, context));

      return listOf(result["channels"]).map((channel) =>
        publicFields(channel, ["id", "name", "type"]),
      );
    },
    /** TikTok location tags matching a query (GET /v1/accounts/{id}/tiktok/locations). */
    async searchTikTokLocations(
      input: { readonly account: ConnectedAccountRef; readonly query: string },
      context: AdapterOperationContext,
    ) {
      if (!input.query.trim() || input.query.length > 100)
        invalid("accounts.read", "query is 1 to 100 characters.");

      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["tiktok"],
        "tiktok/locations",
      );

      const result = object(await request(route, context, undefined, { query: input.query }));

      return listOf(result["locations"]).map((location) =>
        publicFields(location, ["id", "name", "address"]),
      );
    },
    /**
     * Trending TikTok Commercial Music Library tracks (GET .../tiktok/commercial-music). A
     * track `id` is the `musicSoundId` publish option.
     */
    async tiktokCommercialMusic(
      input: { readonly account: ConnectedAccountRef; readonly countryCode?: string },
      context: AdapterOperationContext,
    ) {
      if (input.countryCode !== undefined && !/^[A-Z]{2}$/.test(input.countryCode))
        invalid("accounts.read", "countryCode is an uppercase ISO 3166-1 alpha-2 code.");

      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["tiktok"],
        "tiktok/commercial-music",
      );

      const result = object(
        await request(route, context, undefined, definedFields({ countryCode: input.countryCode })),
      );

      return listOf(result["tracks"]).map((track) =>
        documentedFields(track, [
          "id",
          "commercialMusicId",
          "name",
          "artist",
          "durationSec",
          "genres",
          "previewUrl",
          "thumbnailUrl",
          "rank",
        ]),
      );
    },
    /** Instagram music or original sounds for Reels (GET /v1/accounts/{id}/instagram/audio). */
    async searchInstagramAudio(
      input: {
        readonly account: ConnectedAccountRef;
        readonly audioType: "music" | "original_sound";
        readonly query?: string;
      },
      context: AdapterOperationContext,
    ) {
      if (input.query !== undefined && input.query.length > 200)
        invalid("accounts.read", "query is at most 200 characters.");

      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["instagram"],
        "instagram/audio",
      );

      const result = object(
        await request(route, context, undefined, {
          audioType: input.audioType,
          ...definedFields({ q: input.query }),
        }),
      );

      return listOf(result["audio"]).map(instagramAudio);
    },
    /** One Instagram audio's metadata (GET /v1/accounts/{id}/instagram/audio/{audioId}). */
    async getInstagramAudio(
      input: { readonly account: ConnectedAccountRef; readonly audioId: string },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["instagram"],
        `instagram/audio/${encodeURIComponent(input.audioId)}`,
      );

      return instagramAudio(object(object(await request(route, context))["audio"]));
    },
    /**
     * How much of Instagram's rolling 24-hour publishing quota is used
     * (GET /v1/accounts/{id}/instagram/publishing-limit).
     */
    async instagramPublishingLimit(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["instagram"],
        "instagram/publishing-limit",
      );

      const result = object(await request(route, context));

      return {
        quotaUsage: number(result["quotaUsage"]),
        quotaTotal: number(result["quotaTotal"]),
        quotaDurationSeconds: number(result["quotaDurationSeconds"]),
      };
    },
    /** Named sets of accounts (GET /v1/account-groups). */
    async listAccountGroups(context: AdapterOperationContext) {
      const result = object(await request("/v1/account-groups", context));

      return listOf(result["groups"]).map(accountGroup);
    },
    /** Create a group of accounts (POST /v1/account-groups). */
    async createAccountGroup(
      input: {
        readonly name: string;
        readonly accounts: readonly ConnectedAccountRef[];
        readonly profileId?: string;
      },
      context: AdapterOperationContext,
    ) {
      if (!input.name.trim()) invalid("accounts.write", "A group needs a name.");

      for (const ref of input.accounts) accountMatches(ref, context);

      const result = object(
        await request("/v1/account-groups", context, {
          name: input.name,
          accountIds: input.accounts.map((ref) => ref.accountId),
          ...definedFields({ profileId: input.profileId }),
        }),
      );

      return accountGroup(object(result["group"]));
    },
    /** Rename a group or replace its accounts (PUT /v1/account-groups/{groupId}). */
    async updateAccountGroup(
      input: {
        readonly groupId: string;
        readonly name?: string;
        readonly accounts?: readonly ConnectedAccountRef[];
      },
      context: AdapterOperationContext,
    ) {
      if (input.name === undefined && input.accounts === undefined)
        invalid("accounts.write", "Change the name or the accounts.");

      for (const ref of input.accounts ?? []) accountMatches(ref, context);

      await request(
        `/v1/account-groups/${encodeURIComponent(input.groupId)}`,
        context,
        definedFields({
          name: input.name,
          accountIds: input.accounts?.map((ref) => ref.accountId),
        }),
        {},
        "PUT",
      );
    },
    /** Delete a group; its accounts stay connected (DELETE /v1/account-groups/{groupId}). */
    async deleteAccountGroup(
      input: { readonly groupId: string },
      context: AdapterOperationContext,
    ) {
      await request(
        `/v1/account-groups/${encodeURIComponent(input.groupId)}`,
        context,
        undefined,
        {},
        "DELETE",
      );
    },
    /** Default post languages of a Bluesky account (GET /v1/accounts/{id}/bluesky-settings). */
    async getBlueskySettings(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["bluesky"],
        "bluesky-settings",
      );

      const result = object(await request(route, context));

      return { defaultLanguages: languageList(result["defaultLangs"]) };
    },
    /** Set or clear (`null`) the default post languages (PATCH .../bluesky-settings). */
    async updateBlueskySettings(
      input: {
        readonly account: ConnectedAccountRef;
        readonly defaultLanguages: readonly string[] | null;
      },
      context: AdapterOperationContext,
    ) {
      const languages = input.defaultLanguages;

      if (
        languages !== null &&
        (languages.length < 1 ||
          languages.length > 3 ||
          languages.some((tag) => !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(tag)))
      )
        invalid("accounts.write", "defaultLanguages is 1 to 3 BCP-47 codes, or null to clear.");

      const route = accountRoute(
        input.account,
        context,
        "accounts.write",
        ["bluesky"],
        "bluesky-settings",
      );

      await request(route, context, { defaultLangs: languages && [...languages] }, {}, "PATCH");
    },
    /** The Discord channel and webhook identity of an account (GET .../discord-settings). */
    async getDiscordSettings(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["discord"],
        "discord-settings",
      );

      return discordSettings(object(object(await request(route, context))["account"]));
    },
    /** Change the default webhook name, avatar or channel (PATCH .../discord-settings). */
    async updateDiscordSettings(
      input: {
        readonly account: ConnectedAccountRef;
        readonly webhookUsername?: string;
        readonly webhookAvatarUrl?: string;
        readonly channelId?: string;
      },
      context: AdapterOperationContext,
    ) {
      const { webhookUsername, webhookAvatarUrl, channelId } = input;

      if (
        webhookUsername === undefined &&
        webhookAvatarUrl === undefined &&
        channelId === undefined
      )
        invalid("accounts.write", "Change the webhook name, avatar or channel.");

      if (
        webhookUsername !== undefined &&
        (webhookUsername.length < 1 || webhookUsername.length > 80)
      )
        invalid("accounts.write", "webhookUsername is 1 to 80 characters.");

      const route = accountRoute(
        input.account,
        context,
        "accounts.write",
        ["discord"],
        "discord-settings",
      );

      const result = object(
        await request(
          route,
          context,
          definedFields({
            webhookUsername,
            webhookAvatarUrl:
              webhookAvatarUrl === undefined ? undefined : httpsUrl(webhookAvatarUrl).href,
            channelId,
          }),
          {},
          "PATCH",
        ),
      );

      return discordSettings(object(result["account"]));
    },
    /** A Facebook Page's public about, website, phone, emails and hours (GET .../facebook-page-info). */
    async getFacebookPageInfo(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["facebook"],
        "facebook-page-info",
      );

      return pageInfo(object(await request(route, context)));
    },
    /** Update a Facebook Page's public info (PATCH /v1/accounts/{id}/facebook-page-info). */
    async updateFacebookPageInfo(
      input: {
        readonly account: ConnectedAccountRef;
        readonly about?: string;
        readonly description?: string;
        readonly website?: string;
        readonly phone?: string;
        readonly emails?: readonly string[];
        readonly hours?: Readonly<Record<string, string>>;
      },
      context: AdapterOperationContext,
    ) {
      const { about, description, website, phone, emails, hours } = input;

      const body = definedFields({
        about,
        description,
        website: website === undefined ? undefined : httpsUrl(website).href,
        phone,
        emails: emails && [...emails],
        hours: hours && { ...hours },
      });

      if (Object.keys(body).length === 0) invalid("accounts.write", "Change at least one field.");

      if (about !== undefined && about.length > 100)
        invalid("accounts.write", "about is at most 100 characters.");

      if (emails?.some((email) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)))
        invalid("accounts.write", "emails are email addresses.");

      const route = accountRoute(
        input.account,
        context,
        "accounts.write",
        ["facebook"],
        "facebook-page-info",
      );

      return pageInfo(object(await request(route, context, body, {}, "PATCH")));
    },
    /** LinkedIn organizations the member administers (GET .../linkedin-organizations). */
    async listLinkedInOrganizations(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["linkedin"],
        "linkedin-organizations",
      );

      const result = object(await request(route, context));

      return listOf(result["organizations"]).map((organization) =>
        publicFields(organization, ["id", "name", "vanityName", "localizedName"]),
      );
    },
    /**
     * Post as the member or as one of their organizations (PUT .../linkedin-organization).
     * `organization` comes from `listLinkedInOrganizations`.
     */
    async switchLinkedInAccountType(
      input: {
        readonly account: ConnectedAccountRef;
        readonly accountType: "personal" | "organization";
        readonly organization?: {
          readonly id: string;
          readonly name?: string;
          readonly vanityName?: string;
        };
      },
      context: AdapterOperationContext,
    ) {
      if ((input.accountType === "organization") !== (input.organization !== undefined))
        invalid(
          "accounts.write",
          "An organization account type needs the organization, and only it.",
        );

      const organization = input.organization;

      if (organization !== undefined && !/^\d+$/.test(organization.id))
        invalid("accounts.write", "The organization id is numeric.");

      const route = accountRoute(
        input.account,
        context,
        "accounts.write",
        ["linkedin"],
        "linkedin-organization",
      );

      const result = object(
        await request(
          route,
          context,
          {
            accountType: input.accountType,
            ...definedFields({
              selectedOrganization: organization && {
                id: organization.id,
                urn: `urn:li:organization:${organization.id}`,
                ...definedFields({
                  name: organization.name,
                  vanityName: organization.vanityName,
                }),
              },
            }),
          },
          {},
          "PUT",
        ),
      );

      if (result["accountType"] !== input.accountType) unconfirmed("accounts.write");

      return publicFields(result, ["accountType", "accountName"]);
    },
    /** Whether a Facebook Page is subscribed to Zernio's webhooks (GET .../webhook-subscription). */
    async getWebhookSubscription(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "webhooks.read",
        ["facebook"],
        "webhook-subscription",
      );

      return webhookSubscription(object(await request(route, context)));
    },
    /** Re-subscribe a Facebook Page that stopped sending events (POST .../webhook-subscription). */
    async resubscribeWebhooks(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "webhooks.write",
        ["facebook"],
        "webhook-subscription",
      );

      const result = object(await request(route, context, {}));

      return { resubscribed: result["resubscribed"] === true, ...webhookSubscription(result) };
    },
    /** Your own OAuth apps for white-label connects (GET /v1/connect/oauth-apps). Secrets are never returned. */
    async listOAuthApps(
      input: { readonly limit?: number; readonly cursor?: string },
      context: AdapterOperationContext,
    ) {
      const limit = input.limit ?? 50;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        invalid("accounts.read", "limit is 1 to 100.");

      const result = object(
        await request("/v1/connect/oauth-apps", context, undefined, {
          limit: String(limit),
          ...definedFields({ cursor: input.cursor }),
        }),
      );

      const pagination = isJsonObject(result["pagination"]) ? result["pagination"] : {};

      return {
        apps: listOf(result["apps"]).map(oauthApp),
        ...definedFields({ nextCursor: optionalString(pagination["nextCursor"]) }),
      };
    },
    /**
     * Add an OAuth app (POST /v1/connect/oauth-apps). The client secret goes to Zernio only;
     * the returned record carries the `redirectUri` to register with the platform.
     */
    async createOAuthApp(
      input: {
        readonly platform: string;
        readonly label: string;
        readonly clientId: string;
        readonly clientSecret: string;
        readonly metaAppId?: string;
        readonly metaAppSecret?: string;
        readonly scopeAreas?: readonly ZernioScopeArea[];
      },
      context: AdapterOperationContext,
    ) {
      if (!input.label.trim() || input.label.length > 80)
        invalid("accounts.write", "label is 1 to 80 characters.");

      if (!input.clientId.trim() || !input.clientSecret.trim())
        invalid("accounts.write", "Provide the app's client ID and secret.");

      const result = object(
        await request("/v1/connect/oauth-apps", context, {
          platform: wirePlatform(platform(input.platform, options)),
          label: input.label,
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          ...definedFields({
            metaAppId: input.metaAppId,
            metaAppSecret: input.metaAppSecret,
            scopeAreas: input.scopeAreas && [...input.scopeAreas],
          }),
        }),
      );

      return oauthApp(object(result["app"]));
    },
    /** One OAuth app (GET /v1/connect/oauth-apps/{appId}). */
    async getOAuthApp(input: { readonly appId: string }, context: AdapterOperationContext) {
      const result = object(
        await request(`/v1/connect/oauth-apps/${encodeURIComponent(input.appId)}`, context),
      );

      return oauthApp(object(result["app"]));
    },
    /** Change an OAuth app's label, secrets or scope areas (PATCH /v1/connect/oauth-apps/{appId}). */
    async updateOAuthApp(
      input: {
        readonly appId: string;
        readonly label?: string;
        readonly clientSecret?: string;
        readonly metaAppId?: string;
        readonly metaAppSecret?: string;
        readonly scopeAreas?: readonly ZernioScopeArea[];
      },
      context: AdapterOperationContext,
    ) {
      const body = definedFields({
        label: input.label,
        clientSecret: input.clientSecret,
        metaAppId: input.metaAppId,
        metaAppSecret: input.metaAppSecret,
        scopeAreas: input.scopeAreas && [...input.scopeAreas],
      });

      if (Object.keys(body).length === 0) invalid("accounts.write", "Change at least one field.");

      const result = object(
        await request(
          `/v1/connect/oauth-apps/${encodeURIComponent(input.appId)}`,
          context,
          body,
          {},
          "PATCH",
        ),
      );

      return oauthApp(object(result["app"]));
    },
    /**
     * Remove an OAuth app (DELETE /v1/connect/oauth-apps/{appId}). With `confirm: true` Zernio
     * also disconnects the accounts connected through it and returns how many.
     */
    async deleteOAuthApp(
      input: { readonly appId: string; readonly confirm?: boolean },
      context: AdapterOperationContext,
    ) {
      const result = object(
        await request(
          `/v1/connect/oauth-apps/${encodeURIComponent(input.appId)}`,
          context,
          undefined,
          definedFields({
            confirm: input.confirm === undefined ? undefined : String(input.confirm),
          }),
          "DELETE",
        ),
      );

      return { disconnectedAccounts: number(result["disconnectedAccounts"]) };
    },
    /** Check an OAuth app's keys with the platform (POST /v1/connect/oauth-apps/{appId}/test). */
    async testOAuthApp(input: { readonly appId: string }, context: AdapterOperationContext) {
      const result = object(
        await request(
          `/v1/connect/oauth-apps/${encodeURIComponent(input.appId)}/test`,
          context,
          {},
        ),
      );

      return oauthApp(object(result["app"]));
    },
    /** The saved hosted-connect welcome screen (GET /v1/connect/welcome-screen). */
    async getWelcomeScreen(context: AdapterOperationContext) {
      return welcomeScreen(object(await request("/v1/connect/welcome-screen", context)));
    },
    /** Save the welcome screen shown before a connect (PUT /v1/connect/welcome-screen). */
    async saveWelcomeScreen(
      input: {
        readonly showByDefault: boolean;
        readonly brandName?: string;
        readonly logoUrl?: string;
        readonly theme?: JsonObject;
      },
      context: AdapterOperationContext,
    ) {
      if (
        input.brandName !== undefined &&
        (input.brandName.length < 1 || input.brandName.length > 60)
      )
        invalid("accounts.write", "brandName is 1 to 60 characters.");

      const result = object(
        await request(
          "/v1/connect/welcome-screen",
          context,
          {
            showByDefault: input.showByDefault,
            ...definedFields({
              brandName: input.brandName,
              logoUrl: input.logoUrl === undefined ? undefined : httpsUrl(input.logoUrl).href,
              theme: input.theme,
            }),
          },
          {},
          "PUT",
        ),
      );

      return welcomeScreen(result);
    },
    /**
     * Finish a Discord connect by binding channels of a server to a profile
     * (POST /v1/connect/discord). Each channel becomes its own connected account; list accounts
     * afterwards to read them.
     */
    async connectDiscord(
      input: {
        readonly guildId: string;
        readonly channelIds: readonly string[];
        readonly profileId: string;
        readonly redirectUrl?: string;
      },
      context: AdapterOperationContext,
    ) {
      if (
        !/^\d+$/.test(input.guildId) ||
        input.channelIds.length < 1 ||
        input.channelIds.length > 25 ||
        input.channelIds.some((id) => !/^\d+$/.test(id))
      )
        invalid("accounts.write", "Give the numeric server ID and 1 to 25 numeric channel IDs.");

      await request("/v1/connect/discord", context, {
        guildId: input.guildId,
        profileId: input.profileId,
        channelIds: [...input.channelIds],
        ...definedFields({
          redirect_url:
            input.redirectUrl === undefined ? undefined : new URL(input.redirectUrl).href,
        }),
      });
    },
    /** Plan, limits, usage and spend (GET /v1/usage-stats). */
    async usageStats(input: { readonly reconcile?: boolean }, context: AdapterOperationContext) {
      const result = object(
        await request(
          "/v1/usage-stats",
          context,
          undefined,
          definedFields({
            reconcile: input.reconcile === undefined ? undefined : String(input.reconcile),
          }),
        ),
      );

      return documentedFields(result, [
        "planName",
        "billingPeriod",
        "billingAnchorDay",
        "hasAccess",
        "autoUpgradeEnabled",
        "limits",
        "usage",
        "spend",
      ]);
    },
    /**
     * Activity logs for publishing, connections, webhooks and messaging (GET /v1/logs). Logged
     * request and response bodies, IP addresses and user agents are not returned.
     */
    async listLogs(
      input: {
        readonly type?:
          | "all"
          | "publishing"
          | "connections"
          | "webhooks"
          | "messaging"
          | "workflow_event"
          | "api_request";
        readonly status?: "success" | "failed" | "pending" | "skipped" | "all";
        readonly account?: ConnectedAccountRef;
        readonly action?: string;
        readonly search?: string;
        readonly from?: string;
        readonly to?: string;
        readonly days?: number;
        readonly limit?: number;
        readonly skip?: number;
      },
      context: AdapterOperationContext,
    ) {
      if (input.account) accountMatches(input.account, context);

      const limit = input.limit ?? 50;
      const skip = input.skip ?? 0;

      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isSafeInteger(skip) ||
        skip < 0
      )
        invalid("accounts.read", "limit is 1 to 100 and skip is 0 or more.");

      if (
        input.days !== undefined &&
        (!Number.isSafeInteger(input.days) || input.days < 1 || input.days > 90)
      )
        invalid("accounts.read", "days is 1 to 90.");

      const result = object(
        await request("/v1/logs", context, undefined, {
          limit: String(limit),
          skip: String(skip),
          ...definedFields({
            type: input.type,
            status: input.status,
            accountId: input.account?.accountId,
            platform: input.account && wirePlatform(input.account.platform),
            action: input.action,
            search: input.search,
            from: input.from,
            to: input.to,
            days: input.days === undefined ? undefined : String(input.days),
          }),
        }),
      );

      const pagination = isJsonObject(result["pagination"]) ? result["pagination"] : {};

      return {
        logs: listOf(result["logs"]).map((entry) =>
          publicFields(entry, [
            "type",
            "action",
            "platform",
            "account_id",
            "profile_id",
            "status",
            "status_code",
            "error_message",
            "error_code",
            "duration_ms",
            "method",
            "path",
            "request_id",
            "created_at",
          ]),
        ),
        hasMore: pagination["hasMore"] === true,
        ...definedFields({ total: optionalNumber(pagination["total"]) }),
      };
    },
    /**
     * List Zernio posts with filters (GET /v1/posts): a date window (`dateFrom`, `dateTo`),
     * a changed-since cursor (`updatedSince`, in Zernio's OpenAPI v1.490.0), sort order, author, status, tags and hidden posts. Zernio's opaque cursor is unavailable
     * with `source: "external"`, which pages by number, so there `nextCursor` is the next page.
     */
    async listPosts(
      input: {
        readonly account?: ConnectedAccountRef;
        readonly source?: "zernio" | "external";
        readonly status?: ZernioPostStatus;
        readonly dateFrom?: string;
        readonly dateTo?: string;
        readonly updatedSince?: string;
        readonly sortBy?:
          | "scheduled-desc"
          | "scheduled-asc"
          | "created-desc"
          | "created-asc"
          | "status"
          | "platform";
        readonly createdBy?: string;
        readonly profileId?: string;
        readonly includeHidden?: boolean;
        readonly search?: string;
        readonly tags?: readonly string[];
        readonly limit?: number;
        readonly cursor?: string;
      },
      context: AdapterOperationContext,
    ) {
      if (input.account) accountMatches(input.account, context);

      const limit = input.limit ?? 25;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        invalid("posts.read", "limit is 1 to 500.");

      for (const date of [input.dateFrom, input.dateTo])
        if (date !== undefined && !/^\d{4}-\d{2}-\d{2}(T.+)?$/.test(date))
          invalid("posts.read", "dateFrom and dateTo are YYYY-MM-DD or ISO 8601 times.");

      if (
        input.updatedSince !== undefined &&
        (!/(Z|[+-]\d{2}:\d{2})$/.test(input.updatedSince) ||
          Number.isNaN(Date.parse(input.updatedSince)))
      )
        invalid("posts.read", "updatedSince is an ISO 8601 time with Z or an offset.");

      const external = input.source === "external";

      const page = external ? Number(input.cursor ?? "1") : undefined;

      if (page !== undefined && (!Number.isSafeInteger(page) || page < 1))
        invalid("posts.read", "Use a cursor returned by an external listing.");

      if (
        input.tags !== undefined &&
        (input.tags.length > 20 || input.tags.some((tag) => !tag || tag.includes(",")))
      )
        invalid("posts.read", "tags is up to 20 tags without commas.");

      const result = object(
        await request("/v1/posts", context, undefined, {
          limit: String(limit),
          ...definedFields({
            cursor: external ? undefined : input.cursor,
            page: page === undefined ? undefined : String(page),
            source: input.source,
            status: input.status,
            accountId: input.account?.accountId,
            platform: input.account && wirePlatform(input.account.platform),
            dateFrom: input.dateFrom,
            dateTo: input.dateTo,
            updatedSince: input.updatedSince,
            sortBy: input.sortBy,
            createdBy: input.createdBy,
            profileId: input.profileId,
            includeHidden:
              input.includeHidden === undefined ? undefined : String(input.includeHidden),
            search: input.search,
            tags: input.tags?.join(","),
          }),
        }),
      );

      const pagination = isJsonObject(result["pagination"]) ? result["pagination"] : {};

      return {
        posts: listOf(result["posts"]).map((post) => ({
          ...documentedFields(post, [
            "_id",
            "content",
            "status",
            "scheduledFor",
            "createdAt",
            "updatedAt",
            "tags",
            "isExternal",
          ]),
          platforms: listOf(post["platforms"]).map((entry) => ({
            ...publicFields(entry, [
              "platform",
              "status",
              "platformPostId",
              "platformPostUrl",
              "publishedAt",
              "errorMessage",
            ]),
            ...definedFields({ accountId: entryAccountId(entry["accountId"]) }),
          })),
        })),
        ...definedFields({
          nextCursor:
            page === undefined
              ? optionalString(pagination["nextCursor"])
              : nextPage(page, optionalNumber(pagination["pages"])),
        }),
      };
    },
    /**
     * Instagram reads (`/v1/accounts/{id}/instagram/...`): active `stories`, `live-media`,
     * posts the account is tagged in (`tags`), and a mention's media or comment. Media URLs
     * are left out because Instagram serves them as signed, expiring links; use `permalink`.
     */
    async instagramActiveStories(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "posts.read",
        ["instagram"],
        "instagram/stories",
      );

      const result = object(await request(route, context));

      return listOf(result["data"]).map((story) =>
        publicFields(story, ["id", "mediaType", "mediaProductType", "permalink", "timestamp"]),
      );
    },
    async instagramLiveMedia(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "posts.read",
        ["instagram"],
        "instagram/live-media",
      );

      const result = object(await request(route, context));

      return listOf(result["data"]).map((live) =>
        publicFields(live, ["id", "mediaType", "mediaProductType", "username", "timestamp"]),
      );
    },
    async instagramTaggedPosts(
      input: {
        readonly account: ConnectedAccountRef;
        readonly limit?: number;
        readonly cursor?: string;
      },
      context: AdapterOperationContext,
    ) {
      const limit = input.limit ?? 25;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
        invalid("posts.read", "limit is 1 to 50.");

      const route = accountRoute(
        input.account,
        context,
        "posts.read",
        ["instagram"],
        "instagram/tags",
      );

      const result = object(
        await request(route, context, undefined, {
          limit: String(limit),
          ...definedFields({ cursor: input.cursor }),
        }),
      );

      return {
        posts: listOf(result["data"]).map((post) => publicFields(post, instagramPostFields)),
        ...definedFields({ nextCursor: optionalString(result["nextCursor"]) }),
      };
    },
    /** A post that mentions the account in its caption (GET .../instagram/mentions/media/{mediaId}). */
    async instagramMentionedMedia(
      input: { readonly account: ConnectedAccountRef; readonly mediaId: string },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "posts.read",
        ["instagram"],
        `instagram/mentions/media/${encodeURIComponent(input.mediaId)}`,
      );

      return publicFields(object(await request(route, context)), instagramPostFields);
    },
    /** A comment that mentions the account (GET .../instagram/mentions/comments/{commentId}). */
    async instagramMentionedComment(
      input: { readonly account: ConnectedAccountRef; readonly commentId: string },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "comments.read",
        ["instagram"],
        `instagram/mentions/comments/${encodeURIComponent(input.commentId)}`,
      );

      const result = object(await request(route, context));

      const media = isJsonObject(result["media"])
        ? optionalString(result["media"]["id"])
        : undefined;

      return {
        ...publicFields(result, ["id", "text", "timestamp", "likeCount"]),
        ...definedFields({ mediaId: media }),
      };
    },
    /** Collaborators invited to an Instagram post and their status (GET .../instagram/media/{id}/collaborators). */
    async instagramCollaborators(
      input: { readonly account: ConnectedAccountRef; readonly mediaId: string },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "posts.read",
        ["instagram"],
        `instagram/media/${encodeURIComponent(input.mediaId)}/collaborators`,
      );

      const result = object(await request(route, context));

      return listOf(result["data"]).map((entry) =>
        publicFields(entry, ["id", "username", "inviteStatus"]),
      );
    },
    /**
     * Look up a public Instagram Business or Creator account by username with Instagram's
     * business discovery (GET .../instagram/business-discovery): profile counts and recent media.
     */
    async instagramBusinessDiscovery(
      input: {
        readonly account: ConnectedAccountRef;
        readonly username: string;
        readonly limit?: number;
      },
      context: AdapterOperationContext,
    ) {
      const username = input.username.replace(/^@/, "");
      const limit = input.limit ?? 12;

      if (!/^[A-Za-z0-9._]{1,30}$/.test(username))
        invalid("accounts.read", "username is an Instagram handle.");

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25)
        invalid("accounts.read", "limit is 1 to 25.");

      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["instagram"],
        "instagram/business-discovery",
      );

      const result = object(
        await request(route, context, undefined, { username, limit: String(limit) }),
      );

      return {
        profile: publicFields(object(result["profile"]), [
          "id",
          "username",
          "name",
          "biography",
          "website",
          "followersCount",
          "followsCount",
          "mediaCount",
        ]),
        media: listOf(result["media"]).map((post) =>
          publicFields(post, [...instagramPostFields, "mediaProductType", "viewCount"]),
        ),
      };
    },
    /** Whether an Instagram user follows the account (GET /v1/accounts/{id}/follow-status/{userId}). */
    async instagramFollowStatus(
      input: {
        readonly account: ConnectedAccountRef;
        readonly userId: string;
        readonly refresh?: boolean;
      },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "accounts.read",
        ["instagram"],
        `follow-status/${encodeURIComponent(input.userId)}`,
      );

      const result = object(
        await request(
          route,
          context,
          undefined,
          definedFields({
            refresh: input.refresh === undefined ? undefined : String(input.refresh),
          }),
        ),
      );

      return publicFields(result, [
        "userId",
        "isFollower",
        "isFollowedByAccount",
        "followerCount",
        "isVerified",
        "username",
        "name",
        "unavailableReason",
      ]);
    },
    /** Posts visitors left on a Facebook Page (GET /v1/accounts/{id}/facebook-visitor-posts). */
    async facebookVisitorPosts(
      input: {
        readonly account: ConnectedAccountRef;
        readonly limit?: number;
        readonly cursor?: string;
      },
      context: AdapterOperationContext,
    ) {
      return facebookPagePosts(input, context, "facebook-visitor-posts", 100);
    },
    /** Posts that tag a Facebook Page (GET /v1/accounts/{id}/facebook-tagged-posts). */
    async facebookTaggedPosts(
      input: {
        readonly account: ConnectedAccountRef;
        readonly limit?: number;
        readonly cursor?: string;
      },
      context: AdapterOperationContext,
    ) {
      return facebookPagePosts(input, context, "facebook-tagged-posts", 50);
    },
    /**
     * A YouTube video's transcript (GET /v1/accounts/{id}/youtube-captions): plain text and
     * timed cues, or SRT with `format: "srt"`, plus the caption tracks available.
     */
    async youtubeCaptions(
      input: {
        readonly account: ConnectedAccountRef;
        readonly videoId: string;
        readonly language?: string;
        readonly format?: "json" | "srt";
        readonly refresh?: boolean;
      },
      context: AdapterOperationContext,
    ) {
      if (!/^[A-Za-z0-9_-]{6,20}$/.test(input.videoId))
        invalid("posts.read", "videoId is a YouTube video ID.");

      const route = accountRoute(
        input.account,
        context,
        "posts.read",
        ["youtube"],
        "youtube-captions",
      );

      const result = object(
        await request(route, context, undefined, {
          videoId: input.videoId,
          ...definedFields({
            language: input.language,
            format: input.format,
            refresh: input.refresh === undefined ? undefined : String(input.refresh),
          }),
        }),
      );

      return documentedFields(result, [
        "videoId",
        "language",
        "trackId",
        "trackKind",
        "source",
        "fetchedAt",
        "text",
        "cues",
        "srt",
        "availableTracks",
      ]);
    },
    /**
     * Sync posts made outside Zernio now instead of waiting for the background sync
     * (POST /v1/posts/sync-external). Give a post `url` or platform `postId` to sync one post.
     */
    async syncExternalPosts(
      input: {
        readonly account: ConnectedAccountRef;
        readonly url?: string;
        readonly postId?: string;
      },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.account, context);

      if (input.url !== undefined && input.postId !== undefined)
        invalid("posts.read", "Give a post url or a postId, not both.");

      const result = object(
        await request("/v1/posts/sync-external", context, {
          accountId: input.account.accountId,
          ...definedFields({
            url: input.url === undefined ? undefined : httpsUrl(input.url).href,
            postId: input.postId,
          }),
        }),
      );

      const synced = isJsonObject(result["synced"]) ? result["synced"] : {};

      return {
        ...publicFields(synced, ["postsFound", "postsSynced", "skipped"]),
        ...definedFields({ found: optionalBoolean(result["found"]) }),
        posts: listOf(result["posts"]).map((post) =>
          publicFields(post, [
            "platform",
            "platformPostId",
            "platformPostUrl",
            "content",
            "publishedAt",
            "mediaType",
          ]),
        ),
      };
    },
    /**
     * Create posts from a Zernio CSV file (POST /v1/posts/bulk-upload). `dryRun` validates every
     * row without creating anything. Rows are not tied to this adapter's accounts, so the
     * client's authorization does not apply; check the CSV's accounts yourself.
     */
    async bulkUpload(
      input: { readonly csv: Blob | string; readonly dryRun?: boolean },
      context: AdapterOperationContext,
    ) {
      const file =
        input.csv instanceof Blob ? input.csv : new Blob([input.csv], { type: "text/csv" });

      if (file.size === 0) invalid("posts.publish", "The CSV is empty.");

      const form = new FormData();

      form.append("file", file, "posts.csv");

      const result = object(
        await request(
          "/v1/posts/bulk-upload",
          context,
          form,
          definedFields({
            dryRun: input.dryRun === undefined ? undefined : String(input.dryRun),
          }),
        ),
      );

      return documentedFields(result, ["total", "valid", "invalid", "results", "warnings"]);
    },
    /** Character count per platform for a text (POST /v1/tools/validate/post-length). */
    async validatePostLength(input: { readonly text: string }, context: AdapterOperationContext) {
      const result = object(
        await request("/v1/tools/validate/post-length", context, { text: input.text }),
      );

      return documentedFields(result, ["platforms"]);
    },
    /** Check a public media URL's type, size and per-platform limits (POST /v1/tools/validate/media). */
    async validateMedia(input: { readonly url: string }, context: AdapterOperationContext) {
      const result = object(
        await request("/v1/tools/validate/media", context, { url: httpsUrl(input.url).href }),
      );

      return documentedFields(result, [
        "valid",
        "error",
        "contentType",
        "size",
        "sizeFormatted",
        "type",
        "platformLimits",
      ]);
    },
    /** Whether a subreddit exists and accepts posts (GET /v1/tools/validate/subreddit). */
    async validateSubreddit(
      input: { readonly subreddit: string; readonly account?: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      if (input.account) accountMatches(input.account, context);

      const result = object(
        await request("/v1/tools/validate/subreddit", context, undefined, {
          name: subredditName(input.subreddit),
          ...definedFields({ accountId: input.account?.accountId }),
        }),
      );

      return documentedFields(result, ["exists", "subreddit", "error"]);
    },
    /** Google Business reviews of a location (GET /v1/accounts/{id}/gmb-reviews). */
    async listGoogleBusinessReviews(
      input: GoogleBusinessLocationInput & {
        readonly pageSize?: number;
        readonly pageToken?: string;
      },
      context: AdapterOperationContext,
    ) {
      const pageSize = input.pageSize ?? 50;

      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50)
        invalid("comments.read", "pageSize is 1 to 50.");

      const result = await googleBusiness(input, context, "comments.read", "gmb-reviews", {
        query: { pageSize: String(pageSize), ...definedFields({ pageToken: input.pageToken }) },
      });

      return {
        reviews: listOf(result["reviews"]).map(googleReview),
        ...definedFields({
          averageRating: optionalNumber(result["averageRating"]),
          totalReviewCount: optionalNumber(result["totalReviewCount"]),
          nextPageToken: optionalString(result["nextPageToken"]),
        }),
      };
    },
    /** One Google Business review (GET /v1/accounts/{id}/gmb-reviews/{reviewId}). */
    async getGoogleBusinessReview(
      input: GoogleBusinessLocationInput & { readonly reviewId: string },
      context: AdapterOperationContext,
    ) {
      const result = await googleBusiness(
        input,
        context,
        "comments.read",
        `gmb-reviews/${encodeURIComponent(input.reviewId)}`,
      );

      return googleReview(object(result["review"]));
    },
    /** Reviews across up to 50 locations in one call (POST /v1/accounts/{id}/gmb-reviews/batch). */
    async batchGoogleBusinessReviews(
      input: {
        readonly account: ConnectedAccountRef;
        readonly locationNames: readonly string[];
        readonly pageSize?: number;
        readonly pageToken?: string;
        readonly orderBy?: "updateTime desc" | "rating" | "rating desc";
      },
      context: AdapterOperationContext,
    ) {
      if (input.locationNames.length < 1 || input.locationNames.length > 50)
        invalid("comments.read", "Name 1 to 50 locations.");

      const result = await googleBusiness(input, context, "comments.read", "gmb-reviews/batch", {
        body: {
          locationNames: [...input.locationNames],
          ...definedFields({
            pageSize: input.pageSize,
            pageToken: input.pageToken,
            orderBy: input.orderBy,
          }),
        },
      });

      return {
        locationReviews: listOf(result["locationReviews"]).map((entry) => ({
          ...publicFields(entry, ["name"]),
          review: googleReview(object(entry["review"])),
        })),
        ...definedFields({ nextPageToken: optionalString(result["nextPageToken"]) }),
      };
    },
    /**
     * Business information of a location (GET /v1/accounts/{id}/gmb-location-details): title,
     * hours, special hours, description, website, phones, categories and service items.
     */
    async getGoogleBusinessLocationDetails(
      input: GoogleBusinessLocationInput & { readonly readMask?: string },
      context: AdapterOperationContext,
    ) {
      const result = await googleBusiness(input, context, "accounts.read", "gmb-location-details", {
        query: definedFields({ readMask: input.readMask }),
      });

      return documentedFields(result, [
        "location",
        "title",
        "regularHours",
        "specialHours",
        "profile",
        "websiteUri",
        "phoneNumbers",
        "categories",
        "serviceItems",
      ]);
    },
    /**
     * Change business information (PUT .../gmb-location-details). `fields` are Google's
     * Business Information location fields; `updateMask` names the ones to write.
     */
    async updateGoogleBusinessLocationDetails(
      input: GoogleBusinessLocationInput & {
        readonly updateMask: string;
        readonly fields: JsonObject;
      },
      context: AdapterOperationContext,
    ) {
      const unknown = Object.keys(input.fields).filter(
        (key) => !googleLocationFields.includes(key),
      );

      if (unknown.length > 0 || !input.updateMask.trim())
        invalid(
          "accounts.write",
          `Give an updateMask and only these location fields: ${googleLocationFields.join(", ")}.`,
        );

      const result = await googleBusiness(
        input,
        context,
        "accounts.write",
        "gmb-location-details",
        {
          body: { updateMask: input.updateMask, ...input.fields },
          method: "PUT",
        },
      );

      if (result["success"] !== true) unconfirmed("accounts.write");
    },
    /** A location's attributes, such as accessibility or payment options (GET .../gmb-attributes). */
    async getGoogleBusinessAttributes(
      input: GoogleBusinessLocationInput,
      context: AdapterOperationContext,
    ) {
      const result = await googleBusiness(input, context, "accounts.read", "gmb-attributes");

      return listOf(result["attributes"]);
    },
    /** Set attributes named in `attributeMask` (PUT /v1/accounts/{id}/gmb-attributes). */
    async updateGoogleBusinessAttributes(
      input: GoogleBusinessLocationInput & {
        readonly attributes: readonly JsonObject[];
        readonly attributeMask: string;
      },
      context: AdapterOperationContext,
    ) {
      if (
        input.attributes.some((attribute) => !isString(attribute["name"])) ||
        !input.attributeMask.trim()
      )
        invalid(
          "accounts.write",
          "Each attribute needs a name, and attributeMask names the ones to set.",
        );

      const result = await googleBusiness(input, context, "accounts.write", "gmb-attributes", {
        body: { attributes: [...input.attributes], attributeMask: input.attributeMask },
        method: "PUT",
      });

      return listOf(result["attributes"]);
    },
    /** Which attributes a category supports (GET /v1/accounts/{id}/gmb-attribute-metadata). */
    async googleBusinessAttributeMetadata(
      input: GoogleBusinessLocationInput & {
        readonly categoryName?: string;
        readonly regionCode?: string;
        readonly languageCode?: string;
        readonly pageSize?: number;
        readonly pageToken?: string;
      },
      context: AdapterOperationContext,
    ) {
      if (
        input.pageSize !== undefined &&
        (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 200)
      )
        invalid("accounts.read", "pageSize is 1 to 200.");

      const result = await googleBusiness(
        input,
        context,
        "accounts.read",
        "gmb-attribute-metadata",
        {
          query: definedFields({
            categoryName: input.categoryName,
            regionCode: input.regionCode,
            languageCode: input.languageCode,
            pageSize: input.pageSize === undefined ? undefined : String(input.pageSize),
            pageToken: input.pageToken,
          }),
        },
      );

      return {
        attributeMetadata: listOf(result["attributeMetadata"]),
        ...definedFields({ nextPageToken: optionalString(result["nextPageToken"]) }),
      };
    },
    /** Services a location offers (GET /v1/accounts/{id}/gmb-services). */
    async getGoogleBusinessServices(
      input: GoogleBusinessLocationInput,
      context: AdapterOperationContext,
    ) {
      return listOf(
        (await googleBusiness(input, context, "accounts.read", "gmb-services"))["services"],
      );
    },
    /** Replace the whole service list (PUT /v1/accounts/{id}/gmb-services). */
    async replaceGoogleBusinessServices(
      input: GoogleBusinessLocationInput & { readonly serviceItems: readonly JsonObject[] },
      context: AdapterOperationContext,
    ) {
      const result = await googleBusiness(input, context, "accounts.write", "gmb-services", {
        body: { serviceItems: [...input.serviceItems] },
        method: "PUT",
      });

      return listOf(result["services"]);
    },
    /** A restaurant location's food menus (GET /v1/accounts/{id}/gmb-food-menus). */
    async getGoogleBusinessFoodMenus(
      input: GoogleBusinessLocationInput,
      context: AdapterOperationContext,
    ) {
      return listOf(
        (await googleBusiness(input, context, "accounts.read", "gmb-food-menus"))["menus"],
      );
    },
    /** Replace the food menus; each menu needs `labels` (PUT /v1/accounts/{id}/gmb-food-menus). */
    async updateGoogleBusinessFoodMenus(
      input: GoogleBusinessLocationInput & {
        readonly menus: readonly JsonObject[];
        readonly updateMask?: string;
      },
      context: AdapterOperationContext,
    ) {
      if (input.menus.some((menu) => !isJsonArray(menu["labels"])))
        invalid("accounts.write", "Each menu needs labels.");

      const result = await googleBusiness(input, context, "accounts.write", "gmb-food-menus", {
        body: { menus: [...input.menus], ...definedFields({ updateMask: input.updateMask }) },
        method: "PUT",
      });

      return listOf(result["menus"]);
    },
    /** Booking, ordering and reservation links on the listing (GET .../gmb-place-actions). */
    async listGoogleBusinessPlaceActions(
      input: GoogleBusinessLocationInput & { readonly pageToken?: string },
      context: AdapterOperationContext,
    ) {
      const result = await googleBusiness(input, context, "accounts.read", "gmb-place-actions", {
        query: definedFields({ pageToken: input.pageToken }),
      });

      return {
        placeActionLinks: listOf(result["placeActionLinks"]).map(placeAction),
        ...definedFields({ nextPageToken: optionalString(result["nextPageToken"]) }),
      };
    },
    async createGoogleBusinessPlaceAction(
      input: GoogleBusinessLocationInput & {
        readonly uri: string;
        readonly placeActionType: GooglePlaceActionType;
      },
      context: AdapterOperationContext,
    ) {
      const result = await googleBusiness(input, context, "accounts.write", "gmb-place-actions", {
        body: { uri: httpsUrl(input.uri).href, placeActionType: input.placeActionType },
      });

      return placeAction(result);
    },
    async updateGoogleBusinessPlaceAction(
      input: GoogleBusinessLocationInput & {
        readonly name: string;
        readonly uri?: string;
        readonly placeActionType?: GooglePlaceActionType;
      },
      context: AdapterOperationContext,
    ) {
      if (input.uri === undefined && input.placeActionType === undefined)
        invalid("accounts.write", "Change the link or its type.");

      const result = await googleBusiness(input, context, "accounts.write", "gmb-place-actions", {
        body: {
          name: input.name,
          ...definedFields({
            uri: input.uri === undefined ? undefined : httpsUrl(input.uri).href,
            placeActionType: input.placeActionType,
          }),
        },
        method: "PATCH",
      });

      return placeAction(result);
    },
    async deleteGoogleBusinessPlaceAction(
      input: GoogleBusinessLocationInput & { readonly name: string },
      context: AdapterOperationContext,
    ) {
      const result = await googleBusiness(input, context, "accounts.write", "gmb-place-actions", {
        query: { name: input.name },
        method: "DELETE",
      });

      if (result["deleted"] !== true) unconfirmed("accounts.write");
    },
    /** Photos and videos on the listing (GET /v1/accounts/{id}/gmb-media). */
    async listGoogleBusinessMedia(
      input: GoogleBusinessLocationInput & { readonly pageToken?: string },
      context: AdapterOperationContext,
    ) {
      const result = await googleBusiness(input, context, "accounts.read", "gmb-media", {
        query: definedFields({ pageToken: input.pageToken }),
      });

      return {
        mediaItems: listOf(result["mediaItems"]).map((item) =>
          publicFields(item, ["name", "mediaFormat", "googleUrl", "description", "createTime"]),
        ),
        ...definedFields({
          nextPageToken: optionalString(result["nextPageToken"]),
          totalMediaItemsCount: optionalNumber(result["totalMediaItemsCount"]),
        }),
      };
    },
    /** Add a photo or video from a public URL (POST /v1/accounts/{id}/gmb-media). */
    async addGoogleBusinessMedia(
      input: GoogleBusinessLocationInput & {
        readonly sourceUrl: string;
        readonly mediaFormat?: "PHOTO" | "VIDEO";
        readonly description?: string;
        readonly category?: GoogleMediaCategory;
      },
      context: AdapterOperationContext,
    ) {
      const result = await googleBusiness(input, context, "accounts.write", "gmb-media", {
        body: {
          sourceUrl: httpsUrl(input.sourceUrl).href,
          ...definedFields({
            mediaFormat: input.mediaFormat,
            description: input.description,
            category: input.category,
          }),
        },
      });

      return publicFields(result, ["name", "mediaFormat", "googleUrl"]);
    },
    async deleteGoogleBusinessMedia(
      input: GoogleBusinessLocationInput & { readonly mediaId: string },
      context: AdapterOperationContext,
    ) {
      const result = await googleBusiness(input, context, "accounts.write", "gmb-media", {
        query: { mediaId: input.mediaId },
        method: "DELETE",
      });

      if (result["deleted"] !== true) unconfirmed("accounts.write");
    },
    /** Verification state of a location (GET /v1/accounts/{id}/gmb-verifications). */
    async getGoogleBusinessVerifications(
      input: GoogleBusinessLocationInput,
      context: AdapterOperationContext,
    ) {
      const result = await googleBusiness(input, context, "accounts.read", "gmb-verifications");

      return documentedFields(result, ["voiceOfMerchantState", "verifications"]);
    },
    /** Verification methods Google offers for a location (POST .../gmb-verifications/options). */
    async googleBusinessVerificationOptions(
      input: GoogleBusinessLocationInput & {
        readonly languageCode: string;
        readonly context?: JsonObject;
      },
      context: AdapterOperationContext,
    ) {
      const result = await googleBusiness(
        input,
        context,
        "accounts.read",
        "gmb-verifications/options",
        {
          body: {
            languageCode: input.languageCode,
            ...definedFields({ context: input.context }),
          },
        },
      );

      return listOf(result["options"]);
    },
    /** Start a verification by the chosen method (POST /v1/accounts/{id}/gmb-verifications). */
    async startGoogleBusinessVerification(
      input: GoogleBusinessLocationInput & {
        readonly method: "ADDRESS" | "EMAIL" | "PHONE_CALL" | "SMS" | "AUTO" | "VETTED_PARTNER";
        readonly languageCode?: string;
        readonly phoneNumber?: string;
        readonly emailAddress?: string;
        readonly mailerContact?: JsonObject;
      },
      context: AdapterOperationContext,
    ) {
      if (
        (input.method === "PHONE_CALL" || input.method === "SMS") &&
        input.phoneNumber === undefined
      )
        invalid(
          "accounts.write",
          "Phone and SMS verification need the phoneNumber Google offered.",
        );

      if (input.method === "EMAIL" && input.emailAddress === undefined)
        invalid("accounts.write", "Email verification needs the emailAddress.");

      const result = await googleBusiness(input, context, "accounts.write", "gmb-verifications", {
        body: {
          method: input.method,
          ...definedFields({
            languageCode: input.languageCode,
            phoneNumber: input.phoneNumber,
            emailAddress: input.emailAddress,
            mailerContact: input.mailerContact,
          }),
        },
      });

      return documentedFields(object(result["verification"]), [
        "name",
        "method",
        "state",
        "createTime",
      ]);
    },
    /** Finish a verification with the PIN Google sent (POST .../gmb-verifications/{id}/complete). */
    async completeGoogleBusinessVerification(
      input: GoogleBusinessLocationInput & {
        readonly verificationId: string;
        readonly pin: string;
      },
      context: AdapterOperationContext,
    ) {
      if (!/^\w{1,32}$/.test(input.pin)) invalid("accounts.write", "Give the verification PIN.");

      const result = await googleBusiness(
        input,
        context,
        "accounts.write",
        `gmb-verifications/${encodeURIComponent(input.verificationId)}/complete`,
        { body: { pin: input.pin } },
      );

      return documentedFields(object(result["verification"]), [
        "name",
        "method",
        "state",
        "createTime",
      ]);
    },
    /**
     * Upvote (1), downvote (-1) or clear a vote (0) on a Reddit post or comment by its fullname,
     * such as `t3_abc` (POST /v1/accounts/{id}/reddit-vote).
     */
    async redditVote(
      input: {
        readonly account: ConnectedAccountRef;
        readonly thingId: string;
        readonly direction: 1 | 0 | -1;
      },
      context: AdapterOperationContext,
    ) {
      if (!/^t[13]_[a-z0-9]+$/i.test(input.thingId))
        invalid("likes.write", "thingId is a Reddit post (t3_) or comment (t1_) fullname.");

      const route = accountRoute(input.account, context, "likes.write", ["reddit"], "reddit-vote");

      const result = object(
        await request(route, context, { thingId: input.thingId, direction: input.direction }),
      );

      if (result["success"] !== true) unconfirmed("likes.write");
    },
    /** Search Reddit posts, optionally within one subreddit (GET /v1/reddit/search). */
    async redditSearch(
      input: {
        readonly account: ConnectedAccountRef;
        readonly query: string;
        readonly subreddit?: string;
        readonly sort?: "relevance" | "hot" | "top" | "new" | "comments";
        readonly limit?: number;
        readonly after?: string;
      },
      context: AdapterOperationContext,
    ) {
      redditAccount(input.account, context);

      if (!input.query.trim()) invalid("posts.read", "Give a search query.");

      const result = object(
        await request("/v1/reddit/search", context, undefined, {
          accountId: input.account.accountId,
          q: input.query,
          ...redditPage(input.limit, input.after),
          ...definedFields({
            subreddit: input.subreddit === undefined ? undefined : subredditName(input.subreddit),
            restrict_sr: input.subreddit === undefined ? undefined : "1",
            sort: input.sort,
          }),
        }),
      );

      return redditListing(result);
    },
    /** A subreddit's feed, or the account's front page without one (GET /v1/reddit/feed). */
    async redditFeed(
      input: {
        readonly account: ConnectedAccountRef;
        readonly subreddit?: string;
        readonly sort?: "hot" | "new" | "top" | "rising";
        readonly time?: "hour" | "day" | "week" | "month" | "year" | "all";
        readonly limit?: number;
        readonly after?: string;
      },
      context: AdapterOperationContext,
    ) {
      redditAccount(input.account, context);

      const result = object(
        await request("/v1/reddit/feed", context, undefined, {
          accountId: input.account.accountId,
          ...redditPage(input.limit, input.after),
          ...definedFields({
            subreddit: input.subreddit === undefined ? undefined : subredditName(input.subreddit),
            sort: input.sort,
            t: input.time,
          }),
        }),
      );

      return redditListing(result);
    },
    /** The comment tree of a Reddit post (GET /v1/reddit/comments/{postId}). */
    async redditComments(
      input: {
        readonly account: ConnectedAccountRef;
        readonly postId: string;
        readonly sort?: "new" | "top" | "best" | "controversial" | "old" | "qa";
        readonly limit?: number;
        readonly commentId?: string;
      },
      context: AdapterOperationContext,
    ) {
      redditAccount(input.account, context);

      const result = object(
        await request(
          `/v1/reddit/comments/${encodeURIComponent(input.postId)}`,
          context,
          undefined,
          {
            accountId: input.account.accountId,
            ...redditPage(input.limit, undefined),
            ...definedFields({ sort: input.sort, commentId: input.commentId }),
          },
        ),
      );

      return {
        comments: listOf(result["items"]).map((comment) =>
          publicFields(comment, [
            "id",
            "fullname",
            "parentId",
            "author",
            "body",
            "permalink",
            "createdUtc",
            "score",
            "numReplies",
            "depth",
            "isSubmitter",
            "edited",
            "stickied",
          ]),
        ),
        more: result["more"] === undefined ? [] : array(result["more"]).filter(isString),
      };
    },
    /** Send a Discord direct message from the connected bot (POST /v1/discord/dms). */
    async sendDiscordDirectMessage(
      input: {
        readonly account: ConnectedAccountRef;
        readonly userId: string;
        readonly text?: string;
        readonly embeds?: readonly JsonObject[];
        readonly tts?: boolean;
      },
      context: AdapterOperationContext,
    ) {
      discordAccount(input.account, context);

      if (!/^\d+$/.test(input.userId))
        invalid("messages.write", "userId is a Discord user snowflake.");

      if ((input.text === undefined || !input.text.trim()) && !input.embeds?.length)
        invalid("messages.write", "Send text or embeds.");

      if ((input.text?.length ?? 0) > 2000 || (input.embeds?.length ?? 0) > 10)
        invalid("messages.write", "Text is up to 2,000 characters and embeds up to 10.");

      const result = object(
        await request("/v1/discord/dms", context, {
          accountId: input.account.accountId,
          userId: input.userId,
          ...definedFields({
            content: input.text,
            embeds: input.embeds && [...input.embeds],
            tts: input.tts,
          }),
        }),
      );

      return publicFields(result, ["messageId", "channelId", "url", "timestamp"]);
    },
    /** Roles of the connected server (GET /v1/discord/guilds/{guildId}/roles). */
    async listDiscordRoles(input: DiscordGuildInput, context: AdapterOperationContext) {
      const result = await discord(
        input.account,
        context,
        "accounts.read",
        guildPath(input, "roles"),
      );

      return listOf(result["data"]).map(discordRole);
    },
    async createDiscordRole(
      input: DiscordGuildInput & DiscordRoleFields & { readonly name: string },
      context: AdapterOperationContext,
    ) {
      const result = await discord(
        input.account,
        context,
        "accounts.write",
        guildPath(input, "roles"),
        {
          body: discordRoleBody(input),
        },
      );

      return discordRole(object(result["data"]));
    },
    async updateDiscordRole(
      input: DiscordGuildInput & DiscordRoleFields & { readonly roleId: string },
      context: AdapterOperationContext,
    ) {
      const body = discordRoleBody(input);

      if (Object.keys(body).length === 0)
        invalid("accounts.write", "Change at least one role field.");

      const result = await discord(
        input.account,
        context,
        "accounts.write",
        guildPath(input, `roles/${encodeURIComponent(input.roleId)}`),
        { body, method: "PATCH" },
      );

      return discordRole(object(result["data"]));
    },
    async deleteDiscordRole(
      input: DiscordGuildInput & { readonly roleId: string },
      context: AdapterOperationContext,
    ) {
      const result = await discord(
        input.account,
        context,
        "accounts.write",
        guildPath(input, `roles/${encodeURIComponent(input.roleId)}`),
        { method: "DELETE" },
      );

      if (result["success"] !== true) unconfirmed("accounts.write");
    },
    /** Members of the server, paged by user ID (GET /v1/discord/guilds/{guildId}/members). */
    async listDiscordMembers(
      input: DiscordGuildInput & { readonly limit?: number; readonly after?: string },
      context: AdapterOperationContext,
    ) {
      const limit = input.limit ?? 100;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        invalid("accounts.read", "limit is 1 to 1,000.");

      const result = await discord(
        input.account,
        context,
        "accounts.read",
        guildPath(input, "members"),
        {
          query: { limit: String(limit), ...definedFields({ after: input.after }) },
        },
      );

      const pagination = isJsonObject(result["pagination"]) ? result["pagination"] : {};

      return {
        members: listOf(result["data"]).map(discordMember),
        ...definedFields({ nextCursor: optionalString(pagination["nextCursor"]) }),
      };
    },
    /** Members whose username or nickname starts with `query` (GET .../members/search). */
    async searchDiscordMembers(
      input: DiscordGuildInput & { readonly query: string; readonly limit?: number },
      context: AdapterOperationContext,
    ) {
      if (!input.query.trim() || input.query.length > 100)
        invalid("accounts.read", "query is 1 to 100 characters.");

      const result = await discord(
        input.account,
        context,
        "accounts.read",
        guildPath(input, "members/search"),
        {
          query: {
            query: input.query,
            ...definedFields({
              limit: input.limit === undefined ? undefined : String(input.limit),
            }),
          },
        },
      );

      return listOf(result["data"]).map(discordMember);
    },
    async getDiscordMember(
      input: DiscordGuildInput & { readonly userId: string },
      context: AdapterOperationContext,
    ) {
      const result = await discord(
        input.account,
        context,
        "accounts.read",
        guildPath(input, `members/${encodeURIComponent(input.userId)}`),
      );

      return discordMember(object(result["data"]));
    },
    /** Give or take a role from a member (PUT or DELETE .../members/{userId}/roles/{roleId}). */
    async setDiscordMemberRole(
      input: DiscordGuildInput & {
        readonly userId: string;
        readonly roleId: string;
        readonly assigned: boolean;
      },
      context: AdapterOperationContext,
    ) {
      const result = await discord(
        input.account,
        context,
        "accounts.write",
        guildPath(
          input,
          `members/${encodeURIComponent(input.userId)}/roles/${encodeURIComponent(input.roleId)}`,
        ),
        { method: input.assigned ? "PUT" : "DELETE" },
      );

      if (result["success"] !== true) unconfirmed("accounts.write");
    },
    /** Pinned messages of a channel (GET /v1/discord/channels/{channelId}/pins). */
    async listDiscordPins(input: DiscordChannelInput, context: AdapterOperationContext) {
      const result = await discord(
        input.account,
        context,
        "posts.read",
        channelPath(input, "pins"),
      );

      return listOf(result["data"]).map((message) =>
        publicFields(message, ["id", "channel_id", "content", "timestamp"]),
      );
    },
    /** Pin or unpin a message (PUT or DELETE /v1/discord/channels/{channelId}/pins/{messageId}). */
    async setDiscordPin(
      input: DiscordChannelInput & { readonly messageId: string; readonly pinned: boolean },
      context: AdapterOperationContext,
    ) {
      const result = await discord(
        input.account,
        context,
        "posts.write",
        channelPath(input, `pins/${encodeURIComponent(input.messageId)}`),
        { method: input.pinned ? "PUT" : "DELETE" },
      );

      if (result["success"] !== true) unconfirmed("posts.write");
    },
    /** Start a public thread, from a message or standalone (POST .../channels/{channelId}/threads). */
    async createDiscordThread(
      input: DiscordChannelInput & {
        readonly name: string;
        readonly messageId?: string;
        readonly autoArchiveDuration?: 60 | 1440 | 4320 | 10080;
      },
      context: AdapterOperationContext,
    ) {
      if (!input.name.trim() || input.name.length > 100)
        invalid("posts.write", "name is 1 to 100 characters.");

      const result = await discord(
        input.account,
        context,
        "posts.write",
        channelPath(input, "threads"),
        {
          body: {
            name: input.name,
            ...definedFields({
              messageId: input.messageId,
              autoArchiveDuration: input.autoArchiveDuration,
            }),
          },
        },
      );

      return publicFields(object(result["data"]), ["id", "name"]);
    },
    /** Publish an announcement-channel message to following servers (POST .../messages/{id}/crosspost). */
    async crosspostDiscordMessage(
      input: DiscordChannelInput & { readonly messageId: string },
      context: AdapterOperationContext,
    ) {
      const result = await discord(
        input.account,
        context,
        "posts.write",
        channelPath(input, `messages/${encodeURIComponent(input.messageId)}/crosspost`),
        { body: {} },
      );

      return publicFields(object(result["data"]), ["id", "channel_id", "timestamp"]);
    },
    /** Delete a channel message (DELETE /v1/discord/channels/{channelId}/messages/{messageId}). */
    async deleteDiscordMessage(
      input: DiscordChannelInput & { readonly messageId: string },
      context: AdapterOperationContext,
    ) {
      const result = await discord(
        input.account,
        context,
        "posts.write",
        channelPath(input, `messages/${encodeURIComponent(input.messageId)}`),
        { method: "DELETE" },
      );

      if (result["success"] !== true) unconfirmed("posts.write");
    },
    /** Scheduled events of the server (GET /v1/discord/guilds/{guildId}/events). */
    async listDiscordEvents(
      input: DiscordGuildInput & { readonly withUserCount?: boolean },
      context: AdapterOperationContext,
    ) {
      const result = await discord(
        input.account,
        context,
        "accounts.read",
        guildPath(input, "events"),
        {
          query: definedFields({
            withUserCount:
              input.withUserCount === undefined ? undefined : String(input.withUserCount),
          }),
        },
      );

      return listOf(result["data"]).map(discordEvent);
    },
    async getDiscordEvent(
      input: DiscordGuildInput & { readonly eventId: string },
      context: AdapterOperationContext,
    ) {
      const result = await discord(
        input.account,
        context,
        "accounts.read",
        guildPath(input, `events/${encodeURIComponent(input.eventId)}`),
      );

      return discordEvent(object(result["data"]));
    },
    /**
     * Create a scheduled event (POST /v1/discord/guilds/{guildId}/events): an `external` event
     * at a location with an end time, or one in a `voice` or `stage` channel.
     */
    async createDiscordEvent(
      input: DiscordGuildInput & {
        readonly name: string;
        readonly description?: string;
        readonly startsAt: string;
        readonly entity:
          | { readonly type: "external"; readonly location: string; readonly endsAt: string }
          | {
              readonly type: "voice" | "stage";
              readonly channelId: string;
              readonly endsAt?: string;
            };
        readonly imageDataUri?: string;
      },
      context: AdapterOperationContext,
    ) {
      discordEventFields(input);

      const entity = input.entity;

      if (entity.type === "external" && (!entity.location.trim() || entity.location.length > 100))
        invalid("accounts.write", "An external event's location is 1 to 100 characters.");

      const result = await discord(
        input.account,
        context,
        "accounts.write",
        guildPath(input, "events"),
        {
          body: {
            accountId: input.account.accountId,
            name: input.name,
            startsAt: input.startsAt,
            entity: { ...entity },
            ...definedFields({
              description: input.description,
              imageDataUri: input.imageDataUri,
            }),
          },
          accountQuery: false,
        },
      );

      return discordEvent(object(result["data"]));
    },
    async updateDiscordEvent(
      input: DiscordGuildInput & {
        readonly eventId: string;
        readonly name?: string;
        readonly description?: string;
        readonly startsAt?: string;
        readonly endsAt?: string;
        readonly location?: string;
        readonly status?: "scheduled" | "active" | "completed" | "cancelled";
        readonly imageDataUri?: string;
      },
      context: AdapterOperationContext,
    ) {
      discordEventFields(input);

      const changes = definedFields({
        name: input.name,
        description: input.description,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        location: input.location,
        status: input.status,
        imageDataUri: input.imageDataUri,
      });

      if (Object.keys(changes).length === 0)
        invalid("accounts.write", "Change at least one event field.");

      const result = await discord(
        input.account,
        context,
        "accounts.write",
        guildPath(input, `events/${encodeURIComponent(input.eventId)}`),
        {
          body: { accountId: input.account.accountId, ...changes },
          method: "PATCH",
          accountQuery: false,
        },
      );

      return discordEvent(object(result["data"]));
    },
    async deleteDiscordEvent(
      input: DiscordGuildInput & { readonly eventId: string },
      context: AdapterOperationContext,
    ) {
      const result = await discord(
        input.account,
        context,
        "accounts.write",
        guildPath(input, `events/${encodeURIComponent(input.eventId)}`),
        { method: "DELETE" },
      );

      if (result["success"] !== true) unconfirmed("accounts.write");
    },
    /**
     * A post's daily analytics series (GET /v1/analytics/post-timeline), one row per day and
     * platform. Analytics add-on.
     */
    async postTimeline(
      input: {
        readonly delivery: DeliveryRef;
        readonly fromDate?: string;
        readonly toDate?: string;
      },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.delivery, context);

      const result = object(
        await request("/v1/analytics/post-timeline", context, undefined, {
          postId: input.delivery.deliveryId,
          ...definedFields({ fromDate: input.fromDate, toDate: input.toDate }),
        }),
      );

      return listOf(result["timeline"]).map((row) =>
        publicFields(row, [
          "date",
          "platform",
          "platformPostId",
          "impressions",
          "reach",
          "likes",
          "comments",
          "shares",
          "saves",
          "clicks",
          "views",
          "follows",
          "completionRate",
          "profileViews",
          "websiteClicks",
          "replays",
        ]),
      );
    },
    /**
     * Post analytics changed since a cursor, across accounts (GET /v1/analytics/delta). Store
     * `nextCursor` and pass it back to fetch only later changes. Rows are filtered to the
     * accounts named in `accounts`.
     */
    async analyticsDelta(
      input: {
        readonly accounts: readonly ConnectedAccountRef[];
        readonly cursor?: string;
        readonly limit?: number;
        readonly profileId?: string;
      },
      context: AdapterOperationContext,
    ) {
      if (input.accounts.length === 0) invalid("analytics.read", "Name at least one account.");

      for (const ref of input.accounts) accountMatches(ref, context);

      const limit = input.limit ?? 50;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        invalid("analytics.read", "limit is 1 to 100.");

      const platforms = new Set(input.accounts.map((ref) => wirePlatform(ref.platform)));

      const result = object(
        await request("/v1/analytics/delta", context, undefined, {
          limit: String(limit),
          ...definedFields({
            cursor: input.cursor,
            profileId: input.profileId,
            platform: platforms.size === 1 ? [...platforms][0] : undefined,
          }),
        }),
      );

      const wanted = new Set(input.accounts.map((ref) => ref.accountId));

      return {
        changes: listOf(result["data"])
          .filter((row) => isString(row["accountId"]) && wanted.has(row["accountId"]))
          .map((row) =>
            documentedFields(row, [
              "postId",
              "accountId",
              "platform",
              "platformPostId",
              "publishedAt",
              "syncedAt",
              "isDeleted",
              "metrics",
            ]),
          ),
        nextCursor: string(result["nextCursor"]),
        hasMore: result["hasMore"] === true,
      };
    },
    /**
     * Totals, followers, daily series and top and recent posts for a date range in one call
     * (GET /v1/analytics/dashboard).
     */
    async analyticsDashboard(
      input: {
        readonly fromDate: string;
        readonly toDate: string;
        readonly profileId?: string;
        readonly platform?: string;
        readonly comparePrevious?: boolean;
        readonly topPosts?: number;
        readonly recentPosts?: number;
      },
      context: AdapterOperationContext,
    ) {
      for (const date of [input.fromDate, input.toDate])
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) invalid("analytics.read", "Dates are YYYY-MM-DD.");

      for (const count of [input.topPosts, input.recentPosts])
        if (count !== undefined && (!Number.isSafeInteger(count) || count < 0 || count > 25))
          invalid("analytics.read", "topPosts and recentPosts are 0 to 25.");

      const result = object(
        await request("/v1/analytics/dashboard", context, undefined, {
          fromDate: input.fromDate,
          toDate: input.toDate,
          ...definedFields({
            profileId: input.profileId,
            platform:
              input.platform === undefined
                ? undefined
                : wirePlatform(platform(input.platform, options)),
            compare: input.comparePrevious ? "previous_period" : undefined,
            topPosts: input.topPosts === undefined ? undefined : String(input.topPosts),
            recentPosts: input.recentPosts === undefined ? undefined : String(input.recentPosts),
          }),
        }),
      );

      return documentedFields(result, [
        "dateRange",
        "totals",
        "previousTotals",
        "followers",
        "previousFollowers",
        "daily",
        "topPosts",
        "recentPosts",
        "dataAsOf",
      ]);
    },
    /** Instagram follower history (GET /v1/analytics/instagram/follower-history). */
    async instagramFollowerHistory(
      input: {
        readonly account: ConnectedAccountRef;
        readonly fromDate?: string;
        readonly toDate?: string;
        readonly metricType?: "time_series" | "total_value";
      },
      context: AdapterOperationContext,
    ) {
      platformAnalyticsAccount(input.account, context, "instagram");

      const result = object(
        await request("/v1/analytics/instagram/follower-history", context, undefined, {
          accountId: input.account.accountId,
          ...definedFields({
            fromDate: input.fromDate,
            toDate: input.toDate,
            metricType: input.metricType,
          }),
        }),
      );

      return documentedFields(result, [
        "dateRange",
        "metricType",
        "metrics",
        "unavailableMetrics",
        "dataDelay",
      ]);
    },
    /** When an Instagram account's followers are online, by day and hour (GET .../instagram/online-followers). */
    async instagramOnlineFollowers(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      platformAnalyticsAccount(input.account, context, "instagram");

      const result = object(
        await request("/v1/analytics/instagram/online-followers", context, undefined, {
          accountId: input.account.accountId,
        }),
      );

      return documentedFields(result, ["days", "note"]);
    },
    /** Insights of one Instagram story (GET /v1/accounts/{id}/instagram/stories/{storyId}/insights). */
    async instagramStoryInsights(
      input: { readonly account: ConnectedAccountRef; readonly storyId: string },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "analytics.read",
        ["instagram"],
        `instagram/stories/${encodeURIComponent(input.storyId)}/insights`,
      );

      return documentedFields(object(object(await request(route, context))["data"]), [
        "source",
        "metrics",
      ]);
    },
    /** Monetization earnings of a Facebook post (GET /v1/analytics/facebook/post-earnings). */
    async facebookPostEarnings(
      input: { readonly post: PlatformPostRef; readonly metrics?: readonly string[] },
      context: AdapterOperationContext,
    ) {
      platformAnalyticsAccount(input.post, context, "facebook");

      const result = object(
        await request("/v1/analytics/facebook/post-earnings", context, undefined, {
          accountId: input.post.accountId,
          postId: input.post.postId,
          ...definedFields({ metrics: input.metrics?.join(",") }),
        }),
      );

      return documentedFields(result, ["period", "metrics", "unavailableMetrics", "dataDelay"]);
    },
    /** Reaction counts of a Facebook post by type (GET /v1/accounts/{id}/facebook-post-reactions). */
    async facebookPostReactions(
      input: { readonly post: PlatformPostRef },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.post,
        context,
        "analytics.read",
        ["facebook"],
        "facebook-post-reactions",
      );

      const result = object(
        await request(route, context, undefined, { postId: input.post.postId }),
      );

      return documentedFields(result, ["total", "breakdown", "lastUpdated"]);
    },
    /** Stats of one LinkedIn post by URN (GET /v1/accounts/{id}/linkedin-post-analytics). */
    async linkedInPostAnalytics(
      input: { readonly post: PlatformPostRef },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.post,
        context,
        "analytics.read",
        ["linkedin"],
        "linkedin-post-analytics",
      );

      const result = object(await request(route, context, undefined, { urn: input.post.postId }));

      return documentedFields(result, ["postUrn", "accountType", "analytics", "lastUpdated"]);
    },
    /** Who reacted to a LinkedIn post (GET /v1/accounts/{id}/linkedin-post-reactions). */
    async linkedInPostReactions(
      input: {
        readonly post: PlatformPostRef;
        readonly limit?: number;
        readonly cursor?: string;
      },
      context: AdapterOperationContext,
    ) {
      const limit = input.limit ?? 25;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        invalid("analytics.read", "limit is 1 to 100.");

      const route = accountRoute(
        input.post,
        context,
        "analytics.read",
        ["linkedin"],
        "linkedin-post-reactions",
      );

      const result = object(
        await request(route, context, undefined, {
          urn: input.post.postId,
          limit: String(limit),
          ...definedFields({ cursor: input.cursor }),
        }),
      );

      const pagination = isJsonObject(result["pagination"]) ? result["pagination"] : {};

      return {
        reactions: listOf(result["reactions"]).map((reaction) => ({
          ...publicFields(reaction, ["reactionType", "reactionLabel", "reactedAt"]),
          ...definedFields({
            from: isJsonObject(reaction["from"])
              ? publicFields(reaction["from"], ["id", "name", "vanityName"])
              : undefined,
          }),
        })),
        ...definedFields({
          nextCursor:
            pagination["hasMore"] === true ? optionalString(pagination["cursor"]) : undefined,
          total: optionalNumber(pagination["total"]),
        }),
      };
    },
    /**
     * A LinkedIn account's aggregate post stats, as totals or a daily series
     * (GET /v1/accounts/{id}/linkedin-aggregate-analytics).
     */
    async linkedInAggregateAnalytics(
      input: {
        readonly account: ConnectedAccountRef;
        readonly aggregation?: "TOTAL" | "DAILY";
        readonly fromDate?: string;
        readonly toDate?: string;
        readonly metrics?: readonly string[];
      },
      context: AdapterOperationContext,
    ) {
      const route = accountRoute(
        input.account,
        context,
        "analytics.read",
        ["linkedin"],
        "linkedin-aggregate-analytics",
      );

      const result = object(
        await request(
          route,
          context,
          undefined,
          definedFields({
            aggregation: input.aggregation,
            fromDate: input.fromDate,
            toDate: input.toDate,
            metrics: input.metrics?.join(","),
          }),
        ),
      );

      return documentedFields(result, [
        "aggregation",
        "dateRange",
        "analytics",
        "metrics",
        "lastUpdated",
      ]);
    },
    /**
     * Search terms that showed a Google Business location, by month
     * (GET /v1/analytics/googlebusiness/search-keywords). Months are YYYY-MM.
     */
    async googleBusinessSearchKeywords(
      input: {
        readonly account: ConnectedAccountRef;
        readonly startMonth?: string;
        readonly endMonth?: string;
        readonly pageToken?: string;
      },
      context: AdapterOperationContext,
    ) {
      platformAnalyticsAccount(input.account, context, "google-business");

      for (const month of [input.startMonth, input.endMonth])
        if (month !== undefined && !/^\d{4}-\d{2}$/.test(month))
          invalid("analytics.read", "Months are YYYY-MM.");

      const result = object(
        await request("/v1/analytics/googlebusiness/search-keywords", context, undefined, {
          accountId: input.account.accountId,
          ...definedFields({
            startMonth: input.startMonth,
            endMonth: input.endMonth,
            pageToken: input.pageToken,
          }),
        }),
      );

      return {
        keywords: listOf(result["keywords"]).map((keyword) =>
          publicFields(keyword, ["keyword", "impressions", "impressionsThreshold"]),
        ),
        ...definedFields({
          nextPageToken: optionalString(result["nextPageToken"]),
          note: optionalString(result["note"]),
        }),
      };
    },
    /**
     * Daily Google Business Profile location metrics: impressions on Maps and Search by device,
     * website and call clicks, direction requests, conversations, bookings and food orders
     * (GET /v1/analytics/googlebusiness/performance). Dates are YYYY-MM-DD; Zernio defaults to
     * the last 30 days, allows 18 months back, and its data can lag 2 to 3 days.
     */
    async googleBusinessPerformance(
      input: {
        readonly account: ConnectedAccountRef;
        /** All metrics when omitted. */
        readonly metrics?: readonly GoogleBusinessPerformanceMetric[];
        readonly fromDate?: string;
        readonly toDate?: string;
      },
      context: AdapterOperationContext,
    ): Promise<GoogleBusinessPerformance> {
      platformAnalyticsAccount(input.account, context, "google-business");

      if (input.metrics !== undefined) {
        if (input.metrics.length === 0)
          invalid("analytics.read", "Name at least one metric, or omit metrics for all of them.");

        const unknown = input.metrics.filter((metric) => !isGooglePerformanceMetric(metric));

        if (unknown.length > 0)
          invalid(
            "analytics.read",
            `Unknown Google Business metrics: ${unknown.join(", ")}. Use ${googlePerformanceMetrics.join(", ")}.`,
          );
      }

      for (const date of [input.fromDate, input.toDate])
        if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date))
          invalid("analytics.read", "Dates are YYYY-MM-DD.");

      if (
        input.fromDate !== undefined &&
        input.toDate !== undefined &&
        input.fromDate > input.toDate
      )
        invalid("analytics.read", "fromDate must not be after toDate.");

      const result = object(
        await request("/v1/analytics/googlebusiness/performance", context, undefined, {
          accountId: input.account.accountId,
          ...definedFields({
            metrics:
              input.metrics === undefined ? undefined : [...new Set(input.metrics)].join(","),
            fromDate: input.fromDate,
            toDate: input.toDate,
          }),
        }),
      );

      const accountId = optionalString(result["accountId"]);

      if (accountId !== undefined && accountId !== input.account.accountId)
        throw new SocialError({
          code: "unauthorized",
          operation: "analytics.read",
          message: "Zernio returned performance metrics for a different account.",
        });

      const range = result["dateRange"];

      const metrics: Partial<
        Record<GoogleBusinessPerformanceMetric, GoogleBusinessPerformanceSeries>
      > = {};

      if (result["metrics"] !== undefined && result["metrics"] !== null)
        for (const [name, series] of Object.entries(object(result["metrics"])))
          if (isGooglePerformanceMetric(name)) metrics[name] = googlePerformanceSeries(series);

      return {
        accountId: input.account.accountId,
        ...definedFields({
          dateRange: isJsonObject(range)
            ? { startDate: string(range["startDate"]), endDate: string(range["endDate"]) }
            : undefined,
          dataDelay: optionalString(result["dataDelay"]),
        }),
        metrics,
      };
    },
    /**
     * Inbox analytics (GET /v1/analytics/inbox/...): message `volume`, a day-by-hour `heatmap`,
     * `source-breakdown`, `response-time` percentiles, `top-accounts` by volume, and per
     * `conversations` counts.
     */
    async inboxAnalytics(
      input: {
        readonly report:
          | "volume"
          | "heatmap"
          | "source-breakdown"
          | "response-time"
          | "top-accounts"
          | "conversations";
        readonly fromDate: string;
        readonly toDate?: string;
        readonly account?: ConnectedAccountRef;
        readonly profileId?: string;
        readonly platform?: string;
        readonly limit?: number;
        readonly page?: number;
      },
      context: AdapterOperationContext,
    ) {
      for (const date of [input.fromDate, input.toDate])
        if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date))
          invalid("analytics.read", "Dates are YYYY-MM-DD.");

      if (input.account) accountMatches(input.account, context);

      if (input.account && input.report === "top-accounts")
        invalid(
          "analytics.read",
          "top-accounts ranks accounts; filter by profileId or platform instead.",
        );

      const platformName = input.account?.platform ?? input.platform;

      const result = object(
        await request(`/v1/analytics/inbox/${input.report}`, context, undefined, {
          fromDate: input.fromDate,
          ...definedFields({
            toDate: input.toDate,
            accountId: input.account?.accountId,
            profileId: input.profileId,
            platform:
              platformName === undefined
                ? undefined
                : wirePlatform(platform(platformName, options)),
            limit: input.limit === undefined ? undefined : String(input.limit),
            page: input.page === undefined ? undefined : String(input.page),
          }),
        }),
      );

      return documentedFields(result, [
        "from",
        "to",
        "summary",
        "timeseries",
        "byPlatform",
        "buckets",
        "sources",
        "histogram",
        "accounts",
        "items",
        "pagination",
      ]);
    },
    /** Message counts and daily series of one conversation (GET /v1/analytics/inbox/conversations/{id}). */
    async conversationAnalytics(
      input: {
        readonly conversation: ConversationRef;
        readonly fromDate: string;
        readonly toDate?: string;
      },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.conversation, context);

      const result = object(
        await request(
          `/v1/analytics/inbox/conversations/${encodeURIComponent(input.conversation.conversationId)}`,
          context,
          undefined,
          { fromDate: input.fromDate, ...definedFields({ toDate: input.toDate }) },
        ),
      );

      return documentedFields(result, ["from", "to", "summary", "timeseries", "bySource"]);
    },
    /** Edit your own Reddit comment (PATCH /v1/inbox/comments/{postId}/{commentId}). */
    async editComment(
      input: { readonly comment: CommentRef; readonly text: string },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.comment, context);

      if (input.comment.platform !== "reddit")
        invalid("comments.write", "Zernio edits Reddit comments only.");

      if (!input.text.trim()) invalid("comments.write", "Give the new comment text.");

      await request(
        commentPath(input.comment),
        context,
        { accountId: input.comment.accountId, platform: "reddit", content: input.text },
        {},
        "PATCH",
      );
    },
    /**
     * Set a YouTube comment's moderation status: `published`, `rejected` or `heldForReview`,
     * optionally banning its author (POST /v1/inbox/comments/{postId}/{commentId}/moderation).
     */
    async setCommentModerationStatus(
      input: {
        readonly comment: CommentRef;
        readonly status: "published" | "rejected" | "heldForReview";
        readonly banAuthor?: boolean;
      },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.comment, context);

      if (input.comment.platform !== "youtube")
        invalid("comments.moderate", "Moderation status applies to YouTube comments.");

      if (input.banAuthor && input.status !== "rejected")
        invalid("comments.moderate", "banAuthor goes with a rejected comment.");

      const result = object(
        await request(`${commentPath(input.comment)}/moderation`, context, {
          accountId: input.comment.accountId,
          platform: "youtube",
          moderationStatus: input.status,
          ...definedFields({ banAuthor: input.banAuthor }),
        }),
      );

      if (result["success"] !== true) unconfirmed("comments.moderate");
    },
    /** Full-text search across DM conversations (GET /v1/inbox/conversations/search). */
    async searchConversations(
      input: {
        readonly query: string;
        readonly account?: ConnectedAccountRef;
        readonly direction?: "incoming" | "outgoing";
        readonly profileId?: string;
        readonly limit?: number;
        readonly cursor?: string;
      },
      context: AdapterOperationContext,
    ) {
      if (!input.query.trim() || input.query.length > 200)
        invalid("messages.read", "query is 1 to 200 characters.");

      if (input.account) accountMatches(input.account, context);

      const result = object(
        await request("/v1/inbox/conversations/search", context, undefined, {
          query: input.query,
          ...definedFields({
            accountId: input.account?.accountId,
            platform: input.account && wirePlatform(input.account.platform),
            direction: input.direction,
            profileId: input.profileId,
            limit: input.limit === undefined ? undefined : String(input.limit),
            cursor: input.cursor,
          }),
        }),
      );

      const pagination = isJsonObject(result["pagination"]) ? result["pagination"] : {};

      return {
        results: listOf(result["data"]).map((hit) => ({
          conversation: inboxFields(isJsonObject(hit["conversation"]) ? hit["conversation"] : {}, [
            "id",
            "platform",
            "accountId",
            "status",
            "updatedTime",
          ]),
          ...publicFields(hit, ["matchCount"]),
        })),
        ...definedFields({ nextCursor: optionalString(pagination["nextCursor"]) }),
      };
    },
    /** Archive or reactivate a conversation (PUT /v1/inbox/conversations/{id}). */
    async setConversationStatus(
      input: { readonly conversation: ConversationRef; readonly status: "active" | "archived" },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.conversation, context);

      const result = object(
        await request(
          conversationPath(input.conversation),
          context,
          { accountId: input.conversation.accountId, status: input.status },
          {},
          "PUT",
        ),
      );

      const data = isJsonObject(result["data"]) ? result["data"] : {};

      if (data["status"] !== input.status) unconfirmed("messages.write");
    },
    /** Delete a conversation and its stored messages from Zernio (DELETE /v1/inbox/conversations/{id}). */
    async deleteConversation(
      input: { readonly conversation: ConversationRef },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.conversation, context);

      const result = object(
        await request(
          conversationPath(input.conversation),
          context,
          undefined,
          { accountId: input.conversation.accountId },
          "DELETE",
        ),
      );

      const data = isJsonObject(result["data"]) ? result["data"] : {};

      return { ...definedFields({ deletedMessages: optionalNumber(data["deletedMessages"]) }) };
    },
    /** Accept a message request by replying to it (POST /v1/inbox/conversations/{id}/accept). */
    async acceptMessageRequest(
      input: { readonly conversation: ConversationRef; readonly text: string },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.conversation, context);

      if (!input.text.trim())
        invalid("messages.write", "Accepting a request sends a reply; give its text.");

      const result = object(
        await request(`${conversationPath(input.conversation)}/accept`, context, {
          accountId: input.conversation.accountId,
          message: input.text,
        }),
      );

      const data = isJsonObject(result["data"]) ? result["data"] : {};

      return { messageId: string(data["messageId"]) };
    },
    /**
     * Meta handover protocol (POST /v1/inbox/conversations/{id}/thread-control): `take` control,
     * `release` it, `pass` it to another app (`targetAppId`) or the AI agent, or `request` it.
     */
    async threadControl(
      input: {
        readonly conversation: ConversationRef;
        readonly action: "release" | "take" | "pass" | "request";
        readonly target?: "ai_agent";
        readonly targetAppId?: string;
        readonly metadata?: string;
      },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.conversation, context);

      if (input.action === "pass" && input.target === undefined && input.targetAppId === undefined)
        invalid("messages.write", "Passing control needs a target app or the AI agent.");

      if (input.metadata !== undefined && input.metadata.length > 2000)
        invalid("messages.write", "metadata is up to 2,000 characters.");

      const result = object(
        await request(`${conversationPath(input.conversation)}/thread-control`, context, {
          accountId: input.conversation.accountId,
          action: input.action,
          ...definedFields({
            target: input.target,
            targetAppId: input.targetAppId,
            metadata: input.metadata,
          }),
        }),
      );

      return publicFields(isJsonObject(result["control"]) ? result["control"] : {}, [
        "owner",
        "ownerAppId",
      ]);
    },
    /** A Facebook Page's conversation labels (GET /v1/inbox/labels). */
    async listInboxLabels(
      input: { readonly account: ConnectedAccountRef },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.account, context);

      const result = object(
        await request("/v1/inbox/labels", context, undefined, {
          accountId: input.account.accountId,
        }),
      );

      return listOf(result["labels"]).map((label) => publicFields(label, ["id", "name"]));
    },
    async createInboxLabel(
      input: { readonly account: ConnectedAccountRef; readonly name: string },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.account, context);

      if (!input.name.trim()) invalid("messages.write", "A label needs a name.");

      const result = object(
        await request("/v1/inbox/labels", context, {
          accountId: input.account.accountId,
          name: input.name,
        }),
      );

      return publicFields(object(result["label"]), ["id", "name"]);
    },
    async deleteInboxLabel(
      input: { readonly account: ConnectedAccountRef; readonly labelId: string },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.account, context);

      const result = object(
        await request(
          `/v1/inbox/labels/${encodeURIComponent(input.labelId)}`,
          context,
          undefined,
          { accountId: input.account.accountId },
          "DELETE",
        ),
      );

      if (result["success"] !== true) unconfirmed("messages.write");
    },
    /** Labels on one conversation (GET /v1/inbox/conversations/{id}/labels). */
    async listConversationLabels(
      input: { readonly conversation: ConversationRef },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.conversation, context);

      const result = object(
        await request(`${conversationPath(input.conversation)}/labels`, context, undefined, {
          accountId: input.conversation.accountId,
        }),
      );

      return listOf(result["labels"]).map((label) => publicFields(label, ["id", "name"]));
    },
    /** Add or remove a label on a conversation (POST or DELETE .../conversations/{id}/labels). */
    async setConversationLabel(
      input: {
        readonly conversation: ConversationRef;
        readonly labelId: string;
        readonly applied: boolean;
      },
      context: AdapterOperationContext,
    ) {
      accountMatches(input.conversation, context);

      const path = `${conversationPath(input.conversation)}/labels`;
      const accountId = input.conversation.accountId;

      const result = object(
        input.applied
          ? await request(path, context, { accountId, labelId: input.labelId })
          : await request(
              `${path}/${encodeURIComponent(input.labelId)}`,
              context,
              undefined,
              { accountId },
              "DELETE",
            ),
      );

      if (result["success"] !== true) unconfirmed("messages.write");
    },
    /**
     * Read a Messenger, Instagram or Telegram bot setting: the persistent menu
     * (`messenger-menu`), Get Started button, greeting, ice breakers (`messenger-ice-breakers`
     * or `instagram-ice-breakers`) or Telegram bot commands (`telegram-commands`).
     */
    async getBotSetting(
      input: { readonly account: ConnectedAccountRef; readonly setting: ZernioBotSetting },
      context: AdapterOperationContext,
    ) {
      const result = object(
        await request(botRoute(input.account, input.setting, context), context),
      );

      return { value: result["data"] ?? null };
    },
    /**
     * Replace a bot setting. `value` is the setting's documented shape: `persistentMenu` items
     * in Meta's format, `{ payload }` for Get Started, `{ locale, text }` greetings,
     * `{ locale, questions: [{ question, payload }] }` Messenger ice breakers,
     * `{ question, payload }` Instagram ice breakers or `{ command, description }` commands.
     */
    async setBotSetting(input: ZernioBotSettingInput, context: AdapterOperationContext) {
      const route = botRoute(input.account, input.setting, context);

      await request(route, context, botSettingBody(input), {}, "PUT");
    },
    /** Remove a bot setting (DELETE on its route). */
    async deleteBotSetting(
      input: { readonly account: ConnectedAccountRef; readonly setting: ZernioBotSetting },
      context: AdapterOperationContext,
    ) {
      await request(
        botRoute(input.account, input.setting, context),
        context,
        undefined,
        {},
        "DELETE",
      );
    },
  };
}
