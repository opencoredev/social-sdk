import { remainingBudget } from "../transport/budget.js";
import { definedFields } from "../core/fields.js";
import { defineAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import type {
  AccountRecord,
  AdapterOperationContext,
  CommentRef,
  ConnectedAccountRef,
  JsonObject,
  JsonValue,
  LinkedInAnnotation,
  MediaAttachment,
  MediaRef,
  MetricValue,
  Page,
  PlatformPostRef,
  PreparedPublishTarget,
} from "../core/types.js";
import { createHttp, HttpError } from "../transport/http.js";
import {
  array,
  isFiniteNumber,
  isJsonObject,
  isJsonArray,
  isString,
  object,
  optionalArray,
  optionalObject,
  string,
  optionalBoolean,
  optionalString,
  optionalNumber,
  type JsonField,
} from "../transport/validation.js";
import { upload } from "../transport/upload.js";
import {
  documentMimeTypes as linkedInDocumentMimeTypes,
  optionsObject,
  publicFields,
} from "../cloud/common.js";
import { normalizeComment, normalizeMetrics } from "../core/projections.js";
import { verifyLinkedInWebhook } from "../server/webhooks.js";
import { directWebhooks } from "./webhook-adapter.js";

/** LinkedIn documents "100MB"; the decimal reading is the conservative local bound. */
const linkedInDocumentMaxBytes = 100_000_000;

const linkedInDocumentUrn = /^urn:li:document:[a-zA-Z0-9_-]+$/;

export interface LinkedInOptions {
  readonly auth: {
    readonly accessToken: string;
    readonly author: `urn:li:person:${string}` | `urn:li:organization:${string}`;
  };
  /** Explicit monthly API version, for example 202609. Upgrade after reviewing LinkedIn's migration notes. */
  readonly apiVersion: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
  /** App client secret that LinkedIn uses to sign webhook deliveries (`X-LI-Signature`). */
  readonly webhookSecret?: string;
}

export interface LinkedInTimeInterval {
  readonly granularity: "DAY" | "WEEK" | "MONTH";
  readonly start?: number;
  readonly end?: number;
}

/** Page and share statistics do not support WEEK. */
export interface LinkedInPageShareTimeInterval extends LinkedInTimeInterval {
  readonly granularity: "DAY" | "MONTH";
}

export interface LinkedInFollowerBreakdown {
  readonly dimension:
    | "function"
    | "seniority"
    | "industry"
    | "geo"
    | "geoCountry"
    | "staffCountRange"
    | "associationType";
  readonly value: string;
  readonly organicFollowerCount?: number | undefined;
  readonly paidFollowerCount?: number | undefined;
}

export interface LinkedInFollowerStatistics {
  readonly organization: string;
  readonly interval?: LinkedInTimeInterval | undefined;
  readonly organicFollowerGain?: number | undefined;
  readonly paidFollowerGain?: number | undefined;
  readonly breakdowns: readonly LinkedInFollowerBreakdown[];
}

export interface LinkedInPageStatistics {
  readonly organization: string;
  readonly interval?: LinkedInTimeInterval | undefined;
  readonly views: Readonly<Record<string, number>>;
  readonly clicks: Readonly<Record<string, number>>;
  /** Provider click dimensions, including custom-button arrays. */
  readonly rawClicks: JsonObject;
  readonly breakdowns: {
    readonly dimension: string;
    readonly value: string;
    readonly views: Readonly<Record<string, number>>;
    readonly clicks: Readonly<Record<string, number>>;
    /** Provider click dimensions, including custom-button arrays. */
    readonly rawClicks: JsonObject;
  }[];
}

export interface LinkedInShareStatistics {
  readonly organization: string;
  readonly interval?: LinkedInTimeInterval | undefined;
  readonly metrics: Readonly<Record<string, number>>;
}

/** Organization roles from the Organization Access Control API. */
export type LinkedInOrganizationRoleType =
  | "ADMINISTRATOR"
  | "DIRECT_SPONSORED_CONTENT_POSTER"
  | "RECRUITING_POSTER"
  | "LEAD_CAPTURE_ADMINISTRATOR"
  | "LEAD_GEN_FORMS_MANAGER"
  | "ANALYST"
  | "CURATOR"
  | "CONTENT_ADMINISTRATOR";

export type LinkedInRoleState = "APPROVED" | "REJECTED" | "REQUESTED" | "REVOKED";

const linkedInOrganizationRoles: readonly LinkedInOrganizationRoleType[] = [
  "ADMINISTRATOR",
  "DIRECT_SPONSORED_CONTENT_POSTER",
  "RECRUITING_POSTER",
  "LEAD_CAPTURE_ADMINISTRATOR",
  "LEAD_GEN_FORMS_MANAGER",
  "ANALYST",
  "CURATOR",
  "CONTENT_ADMINISTRATOR",
];

const linkedInRoleStates: readonly LinkedInRoleState[] = [
  "APPROVED",
  "REJECTED",
  "REQUESTED",
  "REVOKED",
];

const isOrganizationRole = (value: JsonField): value is LinkedInOrganizationRoleType =>
  linkedInOrganizationRoles.some((role) => role === value);

const isRoleState = (value: JsonField): value is LinkedInRoleState =>
  linkedInRoleStates.some((state) => state === value);

/** One organization role returned by LinkedIn's `organizationAcls` roleAssignee finder. */
export interface LinkedInOrganizationRole {
  readonly organization: `urn:li:organization:${string}`;
  readonly role: LinkedInOrganizationRoleType;
  readonly state: LinkedInRoleState;
}

/** One role holder returned by the `organizationAcls` organization finder. */
export interface LinkedInOrganizationRoleAssignment extends LinkedInOrganizationRole {
  readonly roleAssignee: string;
}

/** Fields LinkedIn returns to non-administrators from organization lookups. */
export interface LinkedInOrganizationSummary {
  readonly organization: `urn:li:organization:${string}`;
  readonly localizedName?: string;
  readonly vanityName?: string;
  readonly localizedWebsite?: string;
  /** `SCHOOL`, `BRAND` (showcase page) or `NONE`. */
  readonly primaryOrganizationType?: string;
}

export interface LinkedInPostStatistics {
  readonly post: string;
  readonly metrics: Readonly<Record<string, number>>;
}

export type LinkedInMemberPostMetric =
  | "IMPRESSION"
  | "MEMBERS_REACHED"
  | "RESHARE"
  | "REACTION"
  | "COMMENT"
  | "POST_SAVE"
  | "POST_SEND"
  | "LINK_CLICKS"
  | "PREMIUM_CTA_CLICKS"
  | "FOLLOWER_GAINED_FROM_CONTENT"
  | "PROFILE_VIEW_FROM_CONTENT";

export type LinkedInMemberVideoMetric = "VIDEO_PLAY" | "VIDEO_VIEWER" | "VIDEO_WATCH_TIME";

export interface LinkedInDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Start is inclusive and end is exclusive. */
export interface LinkedInDateRange {
  readonly start?: LinkedInDate;
  readonly end?: LinkedInDate;
}

export interface LinkedInMemberAnalyticsPoint {
  readonly metric: string;
  readonly count: number;
  readonly post?: string;
  readonly dateRange?: LinkedInDateRange;
}

export interface LinkedInMemberFollowerCount {
  readonly count: number;
  readonly dateRange?: LinkedInDateRange;
}

/** Reactions API types. `MAYBE` is deprecated and LinkedIn rejects it on create. */
export type LinkedInReactionType =
  | "LIKE"
  | "PRAISE"
  | "EMPATHY"
  | "INTEREST"
  | "APPRECIATION"
  | "ENTERTAINMENT";

const linkedInReactionTypes: readonly LinkedInReactionType[] = [
  "LIKE",
  "PRAISE",
  "EMPATHY",
  "INTEREST",
  "APPRECIATION",
  "ENTERTAINMENT",
];

const isLinkedInReactionType = (value: string): value is LinkedInReactionType =>
  linkedInReactionTypes.some((type) => type === value);

/** Posts API `contentCallToActionLabel` values. `BUY_NOW` and `SHOP_NOW` need version 202504+. */
export type LinkedInCallToActionLabel =
  | "APPLY"
  | "DOWNLOAD"
  | "VIEW_QUOTE"
  | "LEARN_MORE"
  | "SIGN_UP"
  | "SUBSCRIBE"
  | "REGISTER"
  | "JOIN"
  | "ATTEND"
  | "REQUEST_DEMO"
  | "SEE_MORE"
  | "BUY_NOW"
  | "SHOP_NOW";

/** Typed fields for a Posts API PARTIAL_UPDATE. At least one field is required. */
export interface LinkedInPostChanges {
  /** New commentary, escaped as literal text except for `annotations`. At most 3,000 characters. */
  readonly text?: string;
  readonly annotations?: readonly LinkedInAnnotation[];
  readonly contentCallToActionLabel?: LinkedInCallToActionLabel;
  /** HTTPS landing page opened from the post content. */
  readonly contentLandingPage?: string;
}

export interface LinkedInNative {
  /**
   * Lists organizations the authenticated member administers (approved `ADMINISTRATOR` roles).
   * Requires `rw_organization_admin` or `r_organization_admin`. Use the result to configure
   * another adapter instance; this instance still acts only as its configured author.
   */
  readonly listAdministeredOrganizations: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    /** Defaults to `ADMINISTRATOR`; `CONTENT_ADMINISTRATOR` and others can also post. */
    readonly role?: LinkedInOrganizationRoleType;
    /** Defaults to `APPROVED`. */
    readonly state?: LinkedInRoleState;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<LinkedInOrganizationRole>>;
  /** Lists role holders of the configured organization (organizationAcls organization finder). */
  readonly listOrganizationRoles: (input: {
    readonly account: ConnectedAccountRef;
    readonly role?: LinkedInOrganizationRoleType;
    readonly state?: LinkedInRoleState;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<LinkedInOrganizationRoleAssignment>>;
  /** Non-administrator batch lookup (organizationsLookup) of up to 100 organizations. */
  readonly lookupOrganizations: (input: {
    readonly account: ConnectedAccountRef;
    readonly organizations: readonly `urn:li:organization:${string}`[];
    readonly context: AdapterOperationContext;
  }) => Promise<{
    readonly organizations: readonly LinkedInOrganizationSummary[];
    readonly errors: readonly { readonly organization: string; readonly status?: number }[];
  }>;
  /** Finds organizations, schools and showcase pages by vanity name (q=vanityName). */
  readonly findOrganizationByVanityName: (input: {
    readonly account: ConnectedAccountRef;
    readonly vanityName: string;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly LinkedInOrganizationSummary[]>;
  /** Lists showcase (brand) pages under a parent organization that the member administers. */
  readonly listOrganizationBrands: (input: {
    readonly account: ConnectedAccountRef;
    readonly parent: `urn:li:organization:${string}`;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<LinkedInOrganizationSummary>>;
  readonly imageStatus: (ref: MediaRef, context: AdapterOperationContext) => Promise<JsonObject>;
  /**
   * Reads one uploaded video's owner and processing status with a single GET. Call it again later
   * while the status is PROCESSING or WAITING_UPLOAD, or use `waitForVideo`. Other methods never
   * poll on their own.
   */
  readonly videoStatus: (ref: MediaRef, context: AdapterOperationContext) => Promise<JsonObject>;
  /**
   * Opt-in bounded wait for one uploaded video. Reads the status like `videoStatus`, and while it is
   * PROCESSING or WAITING_UPLOAD waits `intervalMs` and reads again, up to `maxChecks` reads. It
   * stops early when the next wait would exceed the context's elapsed budget, and throws
   * `cancelled` when the context signal aborts. Returns the last status it read, which may still be
   * PROCESSING; it never throws for slow processing and never creates a post.
   */
  readonly waitForVideo: (
    ref: MediaRef,
    context: AdapterOperationContext,
    options?: LinkedInVideoWaitOptions,
  ) => Promise<JsonObject>;
  /**
   * Uploads one MP4 like `social.media.upload`, with optional captions and media attribution.
   * A JPEG or PNG `media.thumbnail` Blob is uploaded as the custom thumbnail on both paths.
   */
  readonly uploadVideo: (
    input: {
      readonly account: ConnectedAccountRef;
      readonly media: MediaAttachment;
      readonly context: AdapterOperationContext;
    } & LinkedInVideoUploadExtras,
  ) => Promise<MediaRef>;
  /** Reads `id`, `owner` and `status` (`WAITING_UPLOAD`, `PROCESSING`, `AVAILABLE`, `PROCESSING_FAILED`). */
  readonly documentStatus: (ref: MediaRef, context: AdapterOperationContext) => Promise<JsonObject>;
  /**
   * @deprecated Upload video bytes with `social.media.upload` and check processing with
   * `videoStatus`. This method always throws `unsupported_capability`.
   */
  readonly registerVideo: (input: {
    readonly account: ConnectedAccountRef;
    readonly byteSize: number;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /**
   * Creates an organic poll post. `text` is the post commentary; `question` (at most 140
   * characters) defaults to `text`. LinkedIn takes 2 to 4 options of at most 30 characters each.
   */
  readonly createPoll: (input: {
    readonly account: ConnectedAccountRef;
    readonly text: string;
    readonly question?: string;
    readonly options: readonly string[];
    readonly duration?: "ONE_DAY" | "THREE_DAYS" | "SEVEN_DAYS" | "FOURTEEN_DAYS";
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly react: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly reaction: LinkedInReactionType;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Reshares a post through `reshareContext.parent`, with optional commentary (quote-style). */
  readonly reshare: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly text?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /**
   * Partially updates a post. Pass typed `changes` (the commentary is escaped and annotated like a
   * publish), or a raw `body` that is sent as `patch.$set` unchanged.
   */
  readonly updatePost: (
    input: {
      readonly account: ConnectedAccountRef;
      readonly postId: string;
      readonly context: AdapterOperationContext;
    } & (
      | { readonly changes: LinkedInPostChanges; readonly body?: never }
      | { readonly body: JsonObject; readonly changes?: never }
    ),
  ) => Promise<JsonObject>;
  readonly deletePost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /**
   * Deletes a comment with the Comments API. `postId` is the share or ugcPost URN, and
   * `commentId` is the complete `commentUrn` from comment reads. Organization authors are sent
   * as the `actor`. LinkedIn does not document which comments an actor may delete, so expect
   * only the configured author's own comments to succeed.
   */
  readonly deleteComment: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly commentId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly organizationAnalytics: (input: {
    readonly account: ConnectedAccountRef;
    readonly query?: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly getOrganizationFollowerStatistics: (input: {
    readonly account: ConnectedAccountRef;
    readonly interval?: LinkedInTimeInterval;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly LinkedInFollowerStatistics[]>;
  readonly getOrganizationPageStatistics: (input: {
    readonly account: ConnectedAccountRef;
    readonly interval?: LinkedInPageShareTimeInterval;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly LinkedInPageStatistics[]>;
  readonly getOrganizationShareStatistics: (input: {
    readonly account: ConnectedAccountRef;
    readonly interval?: LinkedInPageShareTimeInterval;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly LinkedInShareStatistics[]>;
  readonly getOrganizationFollowerCount: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<number | undefined>;
  /**
   * Lifetime organic statistics for up to 100 of the organization's posts. Posts with no activity
   * are omitted by LinkedIn and have zero counts.
   */
  readonly getOrganizationPostStatistics: (input: {
    readonly account: ConnectedAccountRef;
    readonly postIds: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<readonly LinkedInPostStatistics[]>;
  /** Page statistics for the configured organization read as a brand (showcase) page. */
  readonly getBrandPageStatistics: (input: {
    readonly account: ConnectedAccountRef;
    readonly interval?: LinkedInPageShareTimeInterval;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly LinkedInPageStatistics[]>;
  /** Member creator post analytics for one post (`postId`) or all the member's posts. */
  readonly getMemberPostAnalytics: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId?: string;
    readonly metric: LinkedInMemberPostMetric;
    readonly aggregation?: "TOTAL" | "DAILY";
    readonly dateRange?: LinkedInDateRange;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly LinkedInMemberAnalyticsPoint[]>;
  /** Member video analytics for one post that contains a video. */
  readonly getMemberVideoAnalytics: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly metric: LinkedInMemberVideoMetric;
    readonly aggregation?: "TOTAL" | "DAILY";
    readonly dateRange?: LinkedInDateRange;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly LinkedInMemberAnalyticsPoint[]>;
  /** Lifetime member follower count, or daily counts within `dateRange`. */
  readonly getMemberFollowerCount: (input: {
    readonly account: ConnectedAccountRef;
    readonly dateRange?: LinkedInDateRange;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly LinkedInMemberFollowerCount[]>;
  /**
   * Reads one post by URN, including `content`, poll results and reshare context. `viewContext`
   * `AUTHOR` returns the latest version, which may still be a draft or processing.
   */
  readonly getPost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly viewContext?: "READER" | "AUTHOR";
    readonly context: AdapterOperationContext;
  }) => Promise<LinkedInPost>;
  /** BATCH_GET for up to 100 posts. Development-tier apps cannot call it. */
  readonly getPosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly postIds: readonly string[];
    readonly viewContext?: "READER" | "AUTHOR";
    readonly context: AdapterOperationContext;
  }) => Promise<LinkedInPostBatch>;
  /** Per-type reaction counts, comment counts and comment state for a post or comment. */
  readonly getSocialMetadata: (input: {
    readonly account: ConnectedAccountRef;
    readonly entity: string;
    readonly context: AdapterOperationContext;
  }) => Promise<LinkedInSocialMetadata>;
  /** BATCH_GET of social metadata for up to 100 posts or comments in one request. */
  readonly getSocialMetadataBatch: (input: {
    readonly account: ConnectedAccountRef;
    readonly entities: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<LinkedInSocialMetadataBatch>;
  /** BATCH_GET of Social Actions like and comment summaries for up to 100 posts or comments. */
  readonly getSocialActionsBatch: (input: {
    readonly account: ConnectedAccountRef;
    readonly entities: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<LinkedInSocialActionsBatch>;
  /**
   * BATCH_GET of up to 100 comments on one post or comment. `commentIds` are complete commentUrns
   * from comment reads; the request sends their numeric IDs.
   */
  readonly getComments: (input: {
    readonly account: ConnectedAccountRef;
    readonly target: string;
    readonly commentIds: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<LinkedInCommentBatch>;
  /**
   * Reads the reaction of `actor` (defaults to the configured author) on a post or comment.
   * Returns undefined when LinkedIn answers 404: that actor has no reaction there.
   */
  readonly getReaction: (input: {
    readonly account: ConnectedAccountRef;
    readonly entity: string;
    readonly actor?: `urn:li:person:${string}` | `urn:li:organization:${string}`;
    readonly context: AdapterOperationContext;
  }) => Promise<LinkedInReaction | undefined>;
  /** BATCH_GET of up to 100 reactions by (actor, entity) key. */
  readonly getReactions: (input: {
    readonly account: ConnectedAccountRef;
    readonly keys: readonly LinkedInReactionKey[];
    readonly context: AdapterOperationContext;
  }) => Promise<LinkedInReactionBatch>;
  /**
   * Status of up to 100 uploaded images, videos and documents with one BATCH_GET per media type.
   * Every reference must belong to this author.
   */
  readonly mediaStatuses: (input: {
    readonly account: ConnectedAccountRef;
    readonly media: readonly MediaRef[];
    readonly context: AdapterOperationContext;
  }) => Promise<LinkedInMediaStatusBatch>;
  /**
   * Resolves a member profile URL to a person URN in the configured organization's context
   * (vanityUrl q=vanityUrlAsOrganization), for building @mentions. Organization authors only;
   * needs r_organization_followers. Returns undefined when LinkedIn finds no match.
   */
  readonly resolveMemberVanityUrl: (input: {
    readonly account: ConnectedAccountRef;
    /** `https://www.linkedin.com/in/{vanityName}`. */
    readonly vanityUrl: string;
    readonly context: AdapterOperationContext;
  }) => Promise<`urn:li:person:${string}` | undefined>;
  /**
   * Reads the authenticated member's profile with `GET /v2/me`, optionally with a Rest.li
   * `projection` such as `(id,firstName,lastName)`. Member authors only. Needs `r_liteprofile` or
   * `r_basicprofile`, which LinkedIn grants only to approved developers.
   */
  readonly getProfile: (input: {
    readonly account: ConnectedAccountRef;
    readonly projection?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<LinkedInProfile>;
  /**
   * Reads other members' profiles: `GET /v2/people/(id:...)` for one person URN, or
   * `GET /v2/people?ids=List((id:...),...)` for up to 50. Person IDs are app-scoped; LinkedIn
   * forbids storing profile data of members other than the authenticated one.
   */
  readonly getPeople: (input: {
    readonly account: ConnectedAccountRef;
    readonly people: readonly `urn:li:person:${string}`[];
    readonly projection?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<LinkedInProfileBatch>;
  /**
   * Asks LinkedIn whether a member may take one action for an organization
   * (`GET /rest/organizationAuthorizations/(impersonator,organization,action)`). Needs
   * `rw_organization_admin`.
   */
  readonly getOrganizationAuthorization: (input: {
    readonly account: ConnectedAccountRef;
    readonly key: LinkedInOrganizationAuthorizationKey;
    readonly context: AdapterOperationContext;
  }) => Promise<LinkedInOrganizationAuthorization>;
  /** BATCH_GET of up to 100 organization authorization keys. */
  readonly getOrganizationAuthorizations: (input: {
    readonly account: ConnectedAccountRef;
    readonly keys: readonly LinkedInOrganizationAuthorizationKey[];
    readonly context: AdapterOperationContext;
  }) => Promise<LinkedInOrganizationAuthorizationBatch>;
  /**
   * For the authenticated member, lists each organization's authorization for each action
   * (`bq=authorizationActionsAndImpersonator`). The result has one list per requested action.
   */
  readonly findOrganizationAuthorizations: (input: {
    readonly account: ConnectedAccountRef;
    readonly actions: readonly LinkedInOrganizationAuthorizationAction[];
    readonly context: AdapterOperationContext;
  }) => Promise<readonly (readonly LinkedInOrganizationAuthorization[])[]>;
  /**
   * Organization video analytics for one ugcPost video (`GET /rest/videoAnalytics?q=entity`).
   * Organization authors only; needs `r_organization_social`. LinkedIn keeps VIDEO_VIEW and VIEWER
   * data for six months.
   */
  readonly getOrganizationVideoAnalytics: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly metric: LinkedInVideoAnalyticsMetric;
    /** Defaults to `ALL`. Weeks run Sunday to Saturday. */
    readonly aggregation?: "DAY" | "WEEK" | "ALL";
    /** Epoch milliseconds; start inclusive, end exclusive. Omit for the video's lifetime. */
    readonly timeRange?: { readonly start?: number; readonly end?: number };
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<LinkedInVideoAnalyticsPoint>>;
  /**
   * Creates an event organized by the configured author (`POST /rest/events`). Needs `rw_events`
   * and an ADMINISTRATOR or CONTENT_ADMINISTRATOR role for organization organizers. The event is
   * not visible, readable or updatable until you post it with `createEventPost`.
   */
  readonly createEvent: (input: {
    readonly account: ConnectedAccountRef;
    readonly name: string;
    readonly description?: string;
    readonly type: LinkedInEventType;
    readonly startsAt: number;
    readonly vanityName?: string;
    readonly backgroundImage?: `urn:li:digitalmediaAsset:${string}`;
    readonly discoveryMode?: "LISTED" | "URL_ONLY";
    /** Attach a templated lead form (`privacyPolicyUrl`) or an approved existing form. */
    readonly leadGenForm?:
      | { readonly privacyPolicyUrl: string }
      | { readonly leadGenForm: `urn:li:versionedLeadGenForm:${string}` };
    /** Locale key for name and description, such as `en_US` (default). */
    readonly locale?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<LinkedInEvent>;
  /** Reads one posted event and checks that the configured author organizes it. Needs `r_events`. */
  readonly getEvent: (input: {
    readonly account: ConnectedAccountRef;
    readonly event: string;
    readonly context: AdapterOperationContext;
  }) => Promise<LinkedInEvent>;
  /**
   * Partially updates a posted, upcoming event. LinkedIn rejects updates once `startsAt` has passed
   * (400) or after cancellation (403).
   */
  readonly updateEvent: (input: {
    readonly account: ConnectedAccountRef;
    readonly event: string;
    readonly changes: LinkedInEventChanges;
    readonly locale?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Lists the configured author's events with the `eventsByOrganizer` finder. Needs `r_events`. */
  readonly listEvents: (input: {
    readonly account: ConnectedAccountRef;
    readonly excludeCancelled?: boolean;
    readonly timeBasedFilter?: LinkedInEventTimeFilter;
    readonly entryCriteria?: "PUBLIC" | "GATED";
    readonly sortOrder?: "START_TIME_ASC" | "END_TIME_DESC";
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<LinkedInEvent>>;
  /**
   * Uploads a JPEG or PNG event background image (`assets?action=registerUpload` with the
   * event-background-image recipe, then the returned upload URL) and returns its asset URN.
   */
  readonly uploadEventBackgroundImage: (input: {
    readonly account: ConnectedAccountRef;
    readonly image: Blob;
    readonly mimeType: "image/jpeg" | "image/png";
    readonly context: AdapterOperationContext;
  }) => Promise<`urn:li:digitalmediaAsset:${string}`>;
  /**
   * Posts an event with `content.reference`: pass `postReference` from `createEvent` (a
   * `urn:li:event` or, for live video, a `urn:li:liveVideo`). Returns the new post URN.
   */
  readonly createEventPost: (input: {
    readonly account: ConnectedAccountRef;
    readonly reference: string;
    readonly text?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly postId?: string }>;
  /** Opens or closes comments on a post. Closing deletes every existing comment on it. */
  readonly setCommentsState: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly state: "OPEN" | "CLOSED";
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly listReactions: (input: {
    readonly account: ConnectedAccountRef;
    readonly entity: string;
    readonly sort?: "CHRONOLOGICAL" | "REVERSE_CHRONOLOGICAL" | "RELEVANCE";
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<LinkedInReaction>>;
  /** Removes the configured author's reaction from a post or comment. */
  readonly deleteReaction: (input: {
    readonly account: ConnectedAccountRef;
    readonly entity: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Lists replies to one comment, after checking that the comment belongs to `postId`. */
  readonly listCommentReplies: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly commentId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /**
   * Creates a top-level comment on a post, or a nested reply when `parentCommentId` is set, with
   * optional mentions and one uploaded image. It does not pre-read the post.
   */
  readonly createComment: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly text: string;
    readonly mentions?: readonly LinkedInCommentMention[];
    readonly image?: MediaRef;
    readonly parentCommentId?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<LinkedInCreatedComment>;
  /**
   * Pulls the configured organization's social-action notifications (kept 60 days) with optional
   * action, `sourcePost` and `timeRange` filters.
   */
  readonly listOrganizationNotifications: (input: {
    readonly account: ConnectedAccountRef;
    readonly actions?: readonly LinkedInNotificationAction[];
    /** An activity URN. LinkedIn then accepts exactly one action. */
    readonly sourcePost?: string;
    /** Epoch milliseconds; start inclusive, end exclusive. */
    readonly timeRange?: { readonly start?: number; readonly end?: number };
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  /**
   * Creates or updates the organization's ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS subscription
   * for one administrator. The webhook must already be registered and validated.
   */
  readonly subscribeOrganizationNotifications: (input: {
    readonly account: ConnectedAccountRef;
    readonly developerApplication: `urn:li:developerApplication:${string}`;
    /** The person URN of the member whose token authorizes the subscription. */
    readonly member: `urn:li:person:${string}`;
    readonly webhook: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Lists the authenticated member's subscriptions for the configured organization. */
  readonly listOrganizationNotificationSubscriptions: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly LinkedInEventSubscription[]>;
  readonly unsubscribeOrganizationNotifications: (input: {
    readonly account: ConnectedAccountRef;
    readonly developerApplication: `urn:li:developerApplication:${string}`;
    readonly member: `urn:li:person:${string}`;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** Replaces a comment's text and mentions with a PARTIAL_UPDATE. */
  readonly editComment: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly commentId: string;
    readonly text: string;
    readonly mentions?: readonly LinkedInCommentMention[];
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
}

export type LinkedInNotificationAction =
  | "LIKE"
  | "COMMENT"
  | "SHARE"
  | "SHARE_MENTION"
  | "ADMIN_COMMENT"
  | "COMMENT_EDIT"
  | "COMMENT_DELETE";

const linkedInNotificationActions: readonly LinkedInNotificationAction[] = [
  "LIKE",
  "COMMENT",
  "SHARE",
  "SHARE_MENTION",
  "ADMIN_COMMENT",
  "COMMENT_EDIT",
  "COMMENT_DELETE",
];

export interface LinkedInEventSubscription {
  readonly entity: string;
  readonly eventType: string;
  readonly user?: string;
  readonly webhook?: string;
  /** Epoch milliseconds. */
  readonly expiresAt?: number;
}

export interface LinkedInPollResults {
  readonly question: string;
  /** `voteCount` is absent when LinkedIn hides per-option counts from the viewer. */
  readonly options: readonly { readonly text: string; readonly voteCount?: number }[];
  readonly uniqueVotersCount?: number;
  readonly duration?: string;
  readonly voteSelectionType?: string;
}

export interface LinkedInPost {
  readonly id: string;
  readonly author: string;
  readonly commentary?: string;
  readonly visibility?: string;
  readonly lifecycleState?: string;
  readonly createdAt?: number;
  readonly publishedAt?: number;
  readonly lastModifiedAt?: number;
  readonly isReshareDisabledByAuthor?: boolean;
  readonly isEditedByAuthor?: boolean;
  readonly reshareContext?: { readonly parent: string; readonly root?: string };
  /** The provider `content` object: media, multiImage, article, poll or celebration URNs. */
  readonly content?: JsonObject;
  readonly poll?: LinkedInPollResults;
}

export interface LinkedInPostBatch {
  readonly posts: readonly LinkedInPost[];
  readonly errors: readonly { readonly postId: string; readonly status?: number }[];
}

export interface LinkedInSocialMetadata {
  readonly entity?: string;
  readonly commentsState?: string;
  /** Count per reaction type, keyed by LinkedIn's enum (for example `LIKE`, `EMPATHY`). */
  readonly reactions: Readonly<Record<string, number>>;
  /** `total` includes replies; `topLevel` excludes them. */
  readonly comments?: { readonly total?: number; readonly topLevel?: number };
}

export interface LinkedInReaction {
  readonly id?: string;
  readonly reactionType: string;
  readonly actor?: string;
  readonly root?: string;
  readonly createdAt?: number;
}

/** A per-key failure from a Rest.li BATCH_GET: `status` is LinkedIn's per-key HTTP status. */
export interface LinkedInBatchError {
  readonly id: string;
  readonly status?: number;
}

export interface LinkedInSocialMetadataBatch {
  /** Keyed by the requested post or comment URN. */
  readonly results: Readonly<Record<string, LinkedInSocialMetadata>>;
  readonly errors: readonly LinkedInBatchError[];
}

/** Social Actions summary (`likesSummary`, `commentsSummary`) for one post or comment. */
export interface LinkedInSocialActionsSummary {
  readonly target?: string;
  readonly likes?: {
    readonly total?: number;
    readonly aggregatedTotal?: number;
    readonly likedByCurrentUser?: boolean;
  };
  readonly comments?: {
    readonly firstLevel?: number;
    readonly aggregatedTotal?: number;
    readonly state?: string;
  };
}

export interface LinkedInSocialActionsBatch {
  /** Keyed by the requested post or comment URN; absent when LinkedIn returns no entry. */
  readonly results: Readonly<Record<string, LinkedInSocialActionsSummary>>;
  readonly errors: readonly LinkedInBatchError[];
}

export interface LinkedInCommentBatch {
  readonly comments: readonly JsonObject[];
  /** `id` is the requested comment URN. */
  readonly errors: readonly LinkedInBatchError[];
}

/** The (actor, entity) key of one reaction. */
export interface LinkedInReactionKey {
  readonly actor: `urn:li:person:${string}` | `urn:li:organization:${string}`;
  readonly entity: string;
}

export interface LinkedInReactionBatch {
  readonly reactions: readonly (LinkedInReactionKey & { readonly reaction: LinkedInReaction })[];
  readonly errors: readonly (LinkedInReactionKey & { readonly status?: number })[];
}

/** One uploaded asset's status from a media BATCH_GET. */
export interface LinkedInMediaStatus {
  readonly mediaId: string;
  readonly owner: string;
  readonly status?: string;
  /** Videos only. */
  readonly processingFailureReason?: string;
  /** Videos only, in milliseconds. */
  readonly duration?: number;
}

export interface LinkedInMediaStatusBatch {
  readonly media: readonly LinkedInMediaStatus[];
  /** `id` is the requested media URN. */
  readonly errors: readonly LinkedInBatchError[];
}

/** Lite or basic Profile API fields, subject to the member's privacy settings. */
export interface LinkedInProfile {
  readonly personUrn: `urn:li:person:${string}`;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly headline?: string;
  /** Public profile URL is `https://www.linkedin.com/in/{vanityName}`. */
  readonly vanityName?: string;
  /** `profilePicture.displayImage`, a digital media asset URN. */
  readonly profilePictureUrn?: string;
  /** Bing Geo location (`geoLocation`), which replaces `location` from API version 202608. */
  readonly geoLocation?: { readonly geo: string; readonly autoGenerated?: boolean };
  /** Every returned field, including projected ones the SDK does not decode. */
  readonly fields: JsonObject;
}

export interface LinkedInProfileBatch {
  readonly profiles: readonly LinkedInProfile[];
  /** `id` is the requested person URN. */
  readonly errors: readonly LinkedInBatchError[];
}

/*
 * Organization Authorizations action enums (li-lms-2026-10, accessed 2026-11-04):
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-authorizations/organization-authorizations?view=li-lms-2026-10
 */
const linkedInAuthorizationActions = {
  organizationRoleAuthorizationAction: [
    "ADMINISTRATOR_READ",
    "ADMINISTRATOR_WRITE",
    "DIRECT_SPONSORED_CONTENT_POSTER_READ",
    "DIRECT_SPONSORED_CONTENT_POSTER_WRITE",
    "PIPELINE_BUILDER_READ",
    "PIPELINE_BUILDER_WRITE",
    "PENDING_ADMIN_READ",
    "PENDING_ADMIN_WRITE",
    "PENDING_DIRECT_SPONSORED_CONTENT_POSTER_READ",
    "PENDING_DIRECT_SPONSORED_CONTENT_POSTER_WRITE",
  ],
  organizationContentAuthorizationAction: [
    "ORGANIC_SHARE_VIEW_AS_AUTHOR",
    "ORGANIC_SHARE_CREATE",
    "ORGANIC_SHARE_EDIT",
    "ORGANIC_SHARE_DELETE",
    "DARK_SHARE_CREATE",
    "DARK_SHARE_EDIT",
    "DARK_SHARE_DELETE",
    "DARK_SHARE_VIEW_AS_AUTHOR",
  ],
  organizationProfileAuthorizationAction: ["ADMINISTRATION_PAGE_VIEW"],
  organizationActivityAuthorizationAction: ["ORGANIZATION_ACTIVITY_READ"],
  organizationAnalyticsAuthorizationAction: [
    "VISITOR_ANALYTICS_READ",
    "FOLLOWER_ANALYTICS_READ",
    "UPDATE_ANALYTICS_READ",
  ],
  organizationApplicationAuthorizationAction: ["APPLICATION_ASSOCIATE"],
} as const;

type LinkedInAuthorizationActionGroups = typeof linkedInAuthorizationActions;

/** One action to check, such as `{ organizationContentAuthorizationAction: "ORGANIC_SHARE_CREATE" }`. */
export type LinkedInOrganizationAuthorizationAction = {
  [Group in keyof LinkedInAuthorizationActionGroups]: {
    readonly group: Group;
    readonly actionType: LinkedInAuthorizationActionGroups[Group][number];
  };
}[keyof LinkedInAuthorizationActionGroups];

export interface LinkedInOrganizationAuthorizationKey {
  readonly impersonator: `urn:li:person:${string}`;
  readonly organization: `urn:li:organization:${string}`;
  readonly action: LinkedInOrganizationAuthorizationAction;
}

export interface LinkedInOrganizationAuthorization {
  readonly impersonator: string;
  readonly organization: string;
  readonly actionType: string;
  /** True when LinkedIn returns `com.linkedin.organization.Approved`. */
  readonly approved: boolean;
  /** The status record name without its namespace, such as `Approved` or `Denied`. */
  readonly status: string;
  /** Denial reasons, such as `MEMBER_HAS_INSUFFICIENT_PERMISSIONS_IN_ACCESS_CONTROL`. */
  readonly reasons: readonly string[];
}

export interface LinkedInOrganizationAuthorizationBatch {
  readonly authorizations: readonly LinkedInOrganizationAuthorization[];
  /** Requested keys LinkedIn returned no result for. */
  readonly missing: readonly LinkedInOrganizationAuthorizationKey[];
}

export type LinkedInVideoAnalyticsMetric =
  | "VIDEO_VIEW"
  | "VIEWER"
  | "TIME_WATCHED"
  | "TIME_WATCHED_FOR_VIDEO_VIEWS";

export interface LinkedInVideoAnalyticsPoint {
  readonly metric: string;
  /** Views or viewers, or milliseconds for the TIME_WATCHED metrics. */
  readonly value: number;
  /** Epoch milliseconds, start inclusive and end exclusive. Absent for lifetime totals. */
  readonly timeRange?: { readonly start?: number; readonly end?: number };
}

/** A postal address for an in-person event. `country` is an ISO-3166 two-letter code. */
export interface LinkedInEventAddress {
  readonly line1?: string;
  readonly line2?: string;
  readonly city?: string;
  readonly geographicArea?: string;
  readonly postalCode?: string;
  readonly country?: string;
}

/** Event format; `endsAt` is epoch milliseconds and must follow `startsAt`. */
export type LinkedInEventType =
  | { readonly kind: "liveVideo"; readonly endsAt: number; readonly testEvent?: boolean }
  | { readonly kind: "external"; readonly endsAt: number; readonly url: string }
  | {
      readonly kind: "inPerson";
      readonly endsAt: number;
      readonly url?: string;
      readonly address?: LinkedInEventAddress;
      readonly venueDetails?: string;
    };

/** Updatable sub-fields of the event's existing type; the type itself cannot change. */
export type LinkedInEventTypeChanges =
  | { readonly kind: "liveVideo"; readonly endsAt?: number }
  | { readonly kind: "external"; readonly endsAt?: number; readonly url?: string }
  | {
      readonly kind: "inPerson";
      readonly endsAt?: number;
      readonly url?: string;
      readonly address?: LinkedInEventAddress;
      readonly venueDetails?: string;
    };

export interface LinkedInEventChanges {
  readonly name?: string;
  readonly description?: string;
  readonly vanityName?: string;
  readonly startsAt?: number;
  /** A `urn:li:digitalmediaAsset` from `uploadEventBackgroundImage`. */
  readonly backgroundImage?: `urn:li:digitalmediaAsset:${string}`;
  readonly discoveryMode?: "LISTED" | "URL_ONLY";
  readonly type?: LinkedInEventTypeChanges;
}

export interface LinkedInEvent {
  readonly eventUrn: `urn:li:event:${string}`;
  readonly organizer?: string;
  readonly name?: string;
  readonly startsAt?: number;
  readonly endsAt?: number;
  readonly kind?: "liveVideo" | "external" | "inPerson";
  readonly vanityName?: string;
  readonly discoveryMode?: string;
  readonly backgroundImage?: string;
  /** The event's feed post, set once it is posted. Delete it to delete the event. */
  readonly ugcPost?: string;
  /** `urn:li:liveVideo` of a live video event; returned only by create. */
  readonly liveVideo?: string;
  readonly leadGenForm?: string;
  /** The `content.reference.id` to post the event with: the live video URN or the event URN. */
  readonly postReference?: string;
  /** Every returned field. */
  readonly fields: JsonObject;
}

/** One `timeBasedFilter` union member for `listEvents`. Times are epoch milliseconds. */
export type LinkedInEventTimeFilter =
  | { readonly lifeCycleState: "UPCOMING" | "ONGOING" | "PAST" }
  | { readonly ongoingTimeRange: { readonly start: number; readonly end: number } }
  | { readonly startTimeRange: { readonly start?: number; readonly end?: number } };

/** A comment mention over JavaScript string offsets of the comment text. */
export interface LinkedInCommentMention {
  readonly start: number;
  readonly length: number;
  readonly urn: `urn:li:person:${string}` | `urn:li:organization:${string}`;
}

export interface LinkedInCreatedComment {
  readonly commentUrn: string;
  readonly id?: string;
}

/*
 * Videos API, accessed 2026-09-24:
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-09
 * Feed video is MP4, 75 KB to 500 MB and 3 seconds to 30 minutes. initializeUpload returns
 * contiguous part instructions of up to 4,194,304 bytes; each part's ETag is passed to finalizeUpload.
 * Posts API video content, accessed 2026-09-24:
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-09
 */
const linkedInVideoPartBytes = 4 * 1024 * 1024;

const linkedInVideoMinBytes = 75_000;

const linkedInVideoMaxBytes = 500 * 1024 * 1024;

const linkedInVideoUrn = /^urn:li:video:[a-zA-Z0-9_-]+$/;

/* LinkedIn documents no thumbnail or caption size limit; this cap is the SDK's own. */
const linkedInVideoExtraMaxBytes = 20 * 1024 * 1024;

/** Optional Videos API extras for native uploadVideo. */
export interface LinkedInVideoUploadExtras {
  /** One English SRT captions file. */
  readonly captions?: Blob;
  /** Third-party template used to make the video (API version 202602+). */
  readonly templateName?: string;
  /** Context, such as a URL, that links back to the attribution (API version 202602+). */
  readonly linkbackContext?: string;
}

const linkedInImageUrn = /^urn:li:image:[a-zA-Z0-9_-]+$/;

/* LinkedIn documents no processing time or polling interval; these bounds are the SDK's own. */
const linkedInVideoRetryDelayMs = 5_000;

const linkedInVideoWaitDefaults = { intervalMs: 5_000, maxChecks: 12 } as const;

const linkedInVideoWaitLimits = { minIntervalMs: 1_000, maxIntervalMs: 60_000, maxChecks: 60 };

export interface LinkedInVideoWaitOptions {
  /** Delay between status reads. Integer from 1,000 to 60,000 ms; defaults to 5,000. */
  readonly intervalMs?: number;
  /** Maximum status reads, including the first. Integer from 1 to 60; defaults to 12. */
  readonly maxChecks?: number;
}

export function linkedin(
  options: LinkedInOptions,
): import("../core/adapter.js").SocialAdapter<LinkedInNative> {
  if (
    !options.auth.accessToken.trim() ||
    !/^urn:li:(person|organization):[a-zA-Z0-9_-]+$/.test(options.auth.author) ||
    !/^20\d{2}(0[1-9]|1[0-2])$/.test(options.apiVersion)
  ) {
    throw new SocialError({
      code: "invalid_config",
      operation: "createAdapter",
      message:
        "Provide a LinkedIn access token, member/organization author URN and explicit YYYYMM API version.",
    });
  }

  const http = createHttp(options.fetch ? { fetch: options.fetch } : {});

  const now = () => (options.clock?.() ?? new Date()).toISOString();

  const escapeCommentary = (text: string) => text.replace(/[|{}@()[\]<>#\\*_~]/g, "\\$&");

  const linkedInMemberOrOrganization = /^urn:li:(?:person|organization):[a-zA-Z0-9_-]+$/;

  /*
   * little text format, Posts API "Mentions and Hashtags using Posts commentary" (li-lms-2026-10,
   * accessed 2026-11-04): a mention is @[Name](urn) and must match the member or organization name;
   * LinkedIn returns hashtags as {hashtag|\#|tag}.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-10
   */
  const renderCommentary = (
    text: string,
    annotations: readonly LinkedInAnnotation[],
  ):
    | { readonly kind: "ok"; readonly commentary: string }
    | { readonly kind: "error"; readonly message: string } => {
    let commentary = "";
    let cursor = 0;

    for (const annotation of [...annotations].sort((left, right) => left.start - right.start)) {
      const end = annotation.start + annotation.length;

      if (
        !Number.isSafeInteger(annotation.start) ||
        !Number.isSafeInteger(annotation.length) ||
        annotation.start < cursor ||
        annotation.length < 1 ||
        end > text.length
      )
        return {
          kind: "error",
          message:
            "LinkedIn annotations need integer, non-overlapping start/length ranges inside the text.",
        };

      const covered = text.slice(annotation.start, end);
      commentary += escapeCommentary(text.slice(cursor, annotation.start));

      if (annotation.kind === "hashtag") {
        const tag = /^#([\p{L}\p{N}]+)$/u.exec(covered)?.[1];

        if (tag === undefined)
          return {
            kind: "error",
            message: "A LinkedIn hashtag annotation must cover # followed by letters or digits.",
          };
        commentary += `{hashtag|\\#|${tag}}`;
      } else {
        if (!linkedInMemberOrOrganization.test(annotation.urn))
          return {
            kind: "error",
            message: "A LinkedIn mention needs a urn:li:person or urn:li:organization URN.",
          };

        if (!covered.trim() || /[|{}@()[\]<>#\\*_~\n]/.test(covered))
          return {
            kind: "error",
            message:
              "LinkedIn mention text must be the member or organization name, without little-text reserved characters.",
          };
        commentary += `@[${covered}](${annotation.urn})`;
      }

      cursor = end;
    }

    return { kind: "ok", commentary: commentary + escapeCommentary(text.slice(cursor)) };
  };

  const decodeAnnotations = (value: JsonField): LinkedInAnnotation[] | undefined => {
    if (value === undefined) return [];

    if (!isJsonArray(value)) return undefined;
    const annotations: LinkedInAnnotation[] = [];

    for (const item of value) {
      if (!isJsonObject(item)) return undefined;
      const start = optionalNumber(item["start"]);
      const length = optionalNumber(item["length"]);
      const urn = optionalString(item["urn"]);

      if (start === undefined || length === undefined) return undefined;

      if (item["kind"] === "hashtag") annotations.push({ kind: "hashtag", start, length });
      else if (item["kind"] === "mention" && urn !== undefined && urn.startsWith("urn:li:person:"))
        annotations.push({ kind: "mention", start, length, urn: `urn:li:person:${urn.slice(14)}` });
      else if (
        item["kind"] === "mention" &&
        urn !== undefined &&
        urn.startsWith("urn:li:organization:")
      )
        annotations.push({
          kind: "mention",
          start,
          length,
          urn: `urn:li:organization:${urn.slice(20)}`,
        });
      else return undefined;
    }

    return annotations;
  };

  /*
   * Post schema targetEntities facets (li-lms-2026-10, accessed 2026-11-04). The audience must
   * exceed 300 members; LinkedIn enforces that, the SDK cannot count it offline.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/post-api-schema?view=li-lms-2026-10
   */
  const targetingFacets: readonly (readonly [string, string])[] = [
    ["geoLocations", "urn:li:geo:"],
    ["seniorities", "urn:li:seniority:"],
    ["industries", "urn:li:industry:"],
    ["jobFunctions", "urn:li:function:"],
    ["degrees", "urn:li:degree:"],
    ["fieldsOfStudy", "urn:li:fieldOfStudy:"],
    ["organizations", "urn:li:organization:"],
  ];

  const staffCountRanges = [
    "SIZE_1",
    "SIZE_2_TO_10",
    "SIZE_11_TO_50",
    "SIZE_51_TO_200",
    "SIZE_201_TO_500",
    "SIZE_501_TO_1000",
    "SIZE_1001_TO_5000",
    "SIZE_5001_TO_10000",
    "SIZE_10001_OR_MORE",
  ];

  /*
   * interfaceLocales is an array of Locale records: a lowercase ISO-639 `language` and an optional
   * uppercase ISO-3166 `country` (Object types "Locale", li-lms-2026-10, accessed 2026-11-04).
   * https://learn.microsoft.com/en-us/linkedin/shared/references/v2/object-types?view=li-lms-2026-10#locale
   */
  const decodeInterfaceLocales = (entries: JsonField): JsonObject[] | undefined => {
    if (!isJsonArray(entries) || entries.length === 0) return undefined;
    const locales: JsonObject[] = [];

    for (const entry of entries) {
      if (!isJsonObject(entry)) return undefined;
      const language = optionalString(entry["language"]);
      const country = entry["country"] === undefined ? "" : optionalString(entry["country"]);

      if (
        Object.keys(entry).some((key) => key !== "language" && key !== "country") ||
        language === undefined ||
        !/^[a-z]{2}$/.test(language) ||
        country === undefined ||
        (country !== "" && !/^[A-Z]{2}$/.test(country))
      )
        return undefined;
      locales.push(country === "" ? { language } : { country, language });
    }

    return locales;
  };

  /** Returns the wire targetEntities element, or undefined when the targeting is malformed. */
  const decodeTargeting = (value: JsonField): JsonObject | undefined => {
    if (!isJsonObject(value)) return undefined;
    const known = new Set([...targetingFacets.map(([field]) => field), "staffCountRanges"]);
    const entity: Record<string, JsonValue> = {};

    for (const [field, entries] of Object.entries(value)) {
      if (field === "interfaceLocales") {
        const locales = decodeInterfaceLocales(entries);

        if (locales === undefined) return undefined;
        entity[field] = locales;
        continue;
      }

      const prefix = targetingFacets.find(([name]) => name === field)?.[1];

      if (
        !known.has(field) ||
        !isJsonArray(entries) ||
        entries.length === 0 ||
        !entries.every(
          (entry) =>
            isString(entry) &&
            (prefix === undefined
              ? staffCountRanges.includes(entry)
              : entry.startsWith(prefix) && entry.length > prefix.length),
        )
      )
        return undefined;
      entity[field] = entries;
    }

    return Object.keys(entity).length === 0 ? undefined : entity;
  };

  /** Decodes an account-bound image reference that arrived through JSON publish options. */
  const decodeImageRef = (value: JsonField, account: ConnectedAccountRef): MediaRef | undefined => {
    if (!isJsonObject(value)) return undefined;
    const mediaId = optionalString(value["mediaId"]);

    if (
      value["kind"] !== "media" ||
      value["version"] !== 1 ||
      value["backend"] !== account.backend ||
      value["platform"] !== "linkedin" ||
      value["accountId"] !== account.accountId ||
      mediaId === undefined ||
      !linkedInImageUrn.test(mediaId)
    )
      return undefined;

    return {
      kind: "media",
      version: 1,
      backend: account.backend,
      platform: "linkedin",
      accountId: account.accountId,
      mediaId,
    };
  };

  interface PublishSettings {
    readonly visibility: "PUBLIC" | "CONNECTIONS";
    readonly disableReshare: boolean;
    readonly annotations: readonly LinkedInAnnotation[];
    readonly targetEntities: readonly JsonObject[];
    readonly articleThumbnail?: MediaRef;
  }

  interface DecodedPublishSettings {
    readonly settings: PublishSettings;
    readonly issues: readonly [string, string][];
  }

  /** Decodes LinkedIn publish options. Every problem becomes a prepare-time issue. */
  const publishSettings = (target: PreparedPublishTarget): DecodedPublishSettings => {
    const raw = optionsObject(target);
    const issues: [string, string][] = [];

    const organization = target.account.accountId.startsWith("urn:li:organization:");

    const allowed = [
      "visibility",
      "disableReshare",
      "annotations",
      "targeting",
      "articleThumbnail",
    ];

    for (const key of Object.keys(raw))
      if (!allowed.includes(key))
        issues.push(["linkedin.options", `LinkedIn publish option ${key} is not supported.`]);

    const visibility = raw["visibility"] ?? "public";

    if (visibility !== "public" && visibility !== "connections")
      issues.push(["linkedin.visibility", "LinkedIn visibility must be public or connections."]);
    else if (visibility === "connections" && organization)
      issues.push([
        "linkedin.visibility",
        "CONNECTIONS visibility targets a member's first-degree network; use it with a member author.",
      ]);

    const disableReshare =
      raw["disableReshare"] === undefined ? false : optionalBoolean(raw["disableReshare"]);

    if (disableReshare === undefined)
      issues.push(["linkedin.disable_reshare", "disableReshare must be a boolean."]);

    const annotations = decodeAnnotations(raw["annotations"]);

    if (annotations === undefined)
      issues.push([
        "linkedin.annotations",
        "Annotations need kind mention (with a person or organization URN) or hashtag, and integer start/length.",
      ]);
    else if (annotations.length > 0) {
      const rendered = renderCommentary(target.content.text ?? "", annotations);

      if (rendered.kind === "error") issues.push(["linkedin.annotations", rendered.message]);
    }

    let targetEntities: JsonObject[] = [];

    if (raw["targeting"] !== undefined) {
      const entity = decodeTargeting(raw["targeting"]);

      if (!organization)
        issues.push(["linkedin.targeting", "Targeted organic posts need an organization author."]);

      if (entity === undefined)
        issues.push([
          "linkedin.targeting",
          "Targeting needs non-empty facet arrays of the documented URN types, staff-count ranges or interfaceLocales { language, country? } locales.",
        ]);
      else targetEntities = [entity];
    }

    let articleThumbnail: MediaRef | undefined;

    if (raw["articleThumbnail"] !== undefined) {
      articleThumbnail = decodeImageRef(raw["articleThumbnail"], target.account);

      if (articleThumbnail === undefined)
        issues.push([
          "linkedin.article_thumbnail",
          "articleThumbnail must be an urn:li:image reference uploaded by this author.",
        ]);

      if (target.content.link === undefined)
        issues.push([
          "linkedin.article_thumbnail",
          "articleThumbnail applies only to an article post with content.link.",
        ]);
    }

    return {
      settings: {
        visibility: visibility === "connections" ? "CONNECTIONS" : "PUBLIC",
        disableReshare: disableReshare === true,
        annotations: annotations ?? [],
        targetEntities,
        ...definedFields({ articleThumbnail }),
      },
      issues,
    };
  };

  const authorize = (
    ref: { backend: string; platform: string; accountId: string },
    context: AdapterOperationContext,
  ) => {
    if (
      ref.backend !== context.backendInstance ||
      ref.platform !== "linkedin" ||
      ref.accountId !== options.auth.author
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "linkedin",
        message: "Reference does not belong to this LinkedIn author authorization.",
      });
  };

  async function request(
    path: string,
    context: AdapterOperationContext,
    body?: JsonObject,
    selectedHeaders?: readonly string[],
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = body === undefined ? "GET" : "POST",
    extraHeaders?: HeadersInit,
  ) {
    try {
      return await http({
        timeoutMs: remainingBudget(context),
        url: new URL(`https://api.linkedin.com${path}`),
        headers: path.startsWith("/v2/")
          ? { Authorization: `Bearer ${options.auth.accessToken}`, ...extraHeaders }
          : {
              Authorization: `Bearer ${options.auth.accessToken}`,
              "Content-Type": "application/json",
              "Linkedin-Version": options.apiVersion,
              "X-Restli-Protocol-Version": "2.0.0",
              ...extraHeaders,
            },
        method,
        ...definedFields({
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: context.signal,
          responseHeaders: selectedHeaders,
        }),
        maxAttempts: method === "GET" ? Math.min(5, context.retryBudget.maxAttempts) : 1,
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      const ambiguous =
        method !== "GET" &&
        error.dispatched &&
        (error.kind !== "http" || (error.status ?? 0) >= 500);

      throw new SocialError({
        code: ambiguous
          ? "ambiguous_outcome"
          : error.kind === "timeout"
            ? "timeout"
            : error.kind === "cancelled"
              ? "cancelled"
              : error.status === 401
                ? "reconnect_required"
                : error.status === 403
                  ? "missing_permission"
                  : error.status === 404
                    ? "not_found"
                    : error.status === 429
                      ? "rate_limited"
                      : "upstream_failure",
        operation: path,
        message: error.message,
        upstreamStatus: error.status,
        retryDisposition: ambiguous
          ? { kind: "reconcile-first" }
          : error.status === 429 && error.retryAfterMs !== undefined
            ? { kind: "after-delay", delayMs: error.retryAfterMs }
            : { kind: "never" },
      });
    }
  }

  async function readPost(ref: PlatformPostRef, context: AdapterOperationContext) {
    authorize(ref, context);

    const result = object(await request(`/rest/posts/${encodeURIComponent(ref.postId)}`, context));

    if (result["author"] !== ref.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation: "posts.read",
        message: "LinkedIn post belongs to a different author.",
      });

    return result;
  }

  async function readCommentablePost(ref: PlatformPostRef, context: AdapterOperationContext) {
    authorize(ref, context);

    const result = object(await request(`/rest/posts/${encodeURIComponent(ref.postId)}`, context));

    if (result["id"] !== undefined && result["id"] !== ref.postId)
      throw new SocialError({
        code: "unauthorized",
        operation: "comments.write",
        message: "LinkedIn returned a different post than the declared parent.",
      });

    return result;
  }

  /*
   * Account identity sources (accessed 2026-09-24):
   * - Member: OpenID Connect userinfo, GET https://api.linkedin.com/v2/userinfo, scopes `openid` and
   *   `profile`. `sub` is the member ID used in `urn:li:person:{sub}`.
   *   https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
   *   https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin
   * - Organization: GET /rest/organizations/{id} ("Retrieve an Administered Organization"), scope
   *   `rw_organization_admin`, 403 unless the member has the ADMINISTRATOR role.
   *   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api?view=li-lms-2026-09
   * - Administered organizations: GET /rest/organizationAcls?q=roleAssignee, scope
   *   `rw_organization_admin` or `r_organization_admin`.
   *   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role?view=li-lms-2026-09
   */
  async function accountRequest(path: string, context: AdapterOperationContext, scopes: string) {
    try {
      return await request(path, context);
    } catch (error) {
      if (error instanceof SocialError && error.code === "missing_permission")
        throw new SocialError({
          code: "missing_permission",
          operation: "accounts.read",
          message: `LinkedIn denied the account read. The token needs ${scopes}.`,
          upstreamStatus: error.upstreamStatus,
          retryDisposition: { kind: "never" },
        });
      throw error;
    }
  }

  async function readAccount(context: AdapterOperationContext): Promise<AccountRecord> {
    const ref = {
      kind: "connected-account" as const,
      version: 1 as const,
      backend: context.backendInstance,
      platform: "linkedin",
      accountId: options.auth.author,
    };

    if (options.auth.author.startsWith("urn:li:person:")) {
      const user = object(
        await accountRequest(
          "/v2/userinfo",
          context,
          "the openid and profile scopes (Sign In with LinkedIn using OpenID Connect)",
        ),
      );

      const sub = optionalString(user["sub"]);

      if (sub === undefined || `urn:li:person:${sub}` !== options.auth.author)
        throw new SocialError({
          code: "unauthorized",
          operation: "accounts.read",
          message: "The authenticated LinkedIn member differs from the configured author URN.",
        });

      const fullName =
        optionalString(user["name"]) ??
        [optionalString(user["given_name"]), optionalString(user["family_name"])]
          .filter((part) => part !== undefined && part !== "")
          .join(" ");

      return { ref, displayName: fullName || options.auth.author, status: "connected" };
    }

    const organizationId = options.auth.author.slice("urn:li:organization:".length);

    const organization = object(
      await accountRequest(
        `/rest/organizations/${encodeURIComponent(organizationId)}`,
        context,
        "rw_organization_admin and an approved ADMINISTRATOR role for the organization",
      ),
    );

    const returnedId = optionalNumber(organization["id"]);

    if (returnedId === undefined || String(returnedId) !== organizationId)
      throw new SocialError({
        code: "unauthorized",
        operation: "accounts.read",
        message: "LinkedIn returned a different organization than the configured author URN.",
      });

    const vanityName = optionalString(organization["vanityName"]);

    return Object.assign(
      {
        ref,
        displayName: optionalString(organization["localizedName"]) || options.auth.author,
        status: "connected" as const,
      },
      vanityName === undefined ? {} : { handle: vanityName },
    );
  }

  async function listAdministeredOrganizations(
    input: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly role?: LinkedInOrganizationRoleType;
      readonly state?: LinkedInRoleState;
    },
    context: AdapterOperationContext,
  ): Promise<Page<LinkedInOrganizationRole>> {
    const role = input.role ?? "ADMINISTRATOR";
    const state = input.state ?? "APPROVED";

    if (!isOrganizationRole(role) || !isRoleState(state))
      throw new SocialError({
        code: "invalid_input",
        operation: "accounts.read",
        message: "Use a documented organization role and role state.",
      });

    const start = input.cursor === undefined ? 0 : Number(input.cursor);
    const count = input.limit ?? 25;

    if (
      input.cursor === "" ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > 100
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "accounts.read",
        message: "LinkedIn requires a nonnegative offset and page size from 1 to 100.",
      });

    const memberUrn = options.auth.author;

    if (!memberUrn.startsWith("urn:li:person:"))
      throw new SocialError({
        code: "unauthorized",
        operation: "accounts.read",
        message:
          "LinkedIn administered organization lookup requires a member account authorization.",
      });

    const result = object(
      await accountRequest(
        `/rest/organizationAcls?q=roleAssignee&roleAssignee=${encodeURIComponent(memberUrn)}&role=${role}&state=${state}&start=${start}&count=${count}`,
        context,
        "rw_organization_admin or r_organization_admin",
      ),
    );

    const rows = array(result["elements"]).map(object);
    const items: LinkedInOrganizationRole[] = [];

    for (const row of rows) {
      // LinkedIn documents both `organization` and `organizationTarget` for this field.
      const organization =
        optionalString(row["organization"]) ?? optionalString(row["organizationTarget"]);

      if (
        organization === undefined ||
        !/^urn:li:organization:[0-9]+$/.test(organization) ||
        row["role"] !== role ||
        row["state"] !== state
      )
        continue;
      items.push({
        organization: `urn:li:organization:${organization.slice("urn:li:organization:".length)}`,
        role,
        state,
      });
    }

    const paging = result["paging"] === undefined ? {} : object(result["paging"]);
    const total = optionalNumber(paging["total"]);
    const hasNext = array(paging["links"] ?? []).some((link) => object(link)["rel"] === "next");

    return Object.assign(
      { items },
      rows.length > 0 && (hasNext || (total !== undefined && start + rows.length < total))
        ? { nextCursor: String(start + rows.length) }
        : {},
    );
  }

  async function uploadImage(
    media: MediaAttachment,
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<MediaRef> {
    authorize(account, context);

    const source = media.source;

    if (
      media.kind !== "image" ||
      !["image/jpeg", "image/png", "image/gif"].includes(media.mimeType ?? "") ||
      (source.kind !== "blob" && source.kind !== "stream")
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: "Provide JPEG, PNG or GIF bytes as a Blob or replayable stream.",
      });

    const maxBytes = 20 * 1024 * 1024;
    const size = media.byteSize ?? (source.kind === "blob" ? source.blob.size : undefined);
    const knownSizes = [size, source.kind === "blob" ? source.blob.size : undefined];

    if (
      knownSizes.some(
        (value) =>
          value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > maxBytes),
      )
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: "LinkedIn image bytes must be nonempty and fit the SDK's local 20 MiB cap.",
      });

    const initialized = object(
      object(
        await request("/rest/images?action=initializeUpload", context, {
          initializeUploadRequest: { owner: account.accountId },
        }),
      )["value"],
    );

    const mediaId = string(initialized["image"]);

    if (!/^urn:li:image:[a-zA-Z0-9_-]+$/.test(mediaId))
      throw new SocialError({
        code: "media_error",
        operation: "media.upload",
        message: "LinkedIn returned an invalid image identifier.",
      });

    try {
      await upload({
        url: string(initialized["uploadUrl"]),
        source: {
          mimeType: media.mimeType!,
          ...definedFields({ size }),
          open: source.kind === "blob" ? () => source.blob.stream() : source.open,
        },
        allowHost: (host) => host === "www.linkedin.com",
        maxBytes,
        timeoutMs: remainingBudget(context),
        ...definedFields({ fetch: options.fetch, signal: context.signal }),
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      throw new SocialError({
        code:
          error.kind === "timeout"
            ? "timeout"
            : error.kind === "cancelled"
              ? "cancelled"
              : error.status === 429
                ? "rate_limited"
                : error.kind === "invalid-input"
                  ? "invalid_input"
                  : "media_error",
        operation: "media.upload",
        message: `LinkedIn image upload did not complete: ${error.message}`,
        upstreamStatus: error.status,
        retryDisposition:
          error.status === 429 && error.retryAfterMs !== undefined
            ? { kind: "after-delay", delayMs: error.retryAfterMs }
            : { kind: "never" },
      });
    }

    return {
      kind: "media",
      version: 1,
      backend: account.backend,
      platform: "linkedin",
      accountId: account.accountId,
      mediaId,
    };
  }

  function videoPartError(error: HttpError, part: number): SocialError {
    if (error.kind === "cancelled")
      return new SocialError({
        code: "cancelled",
        operation: "media.upload",
        message: `LinkedIn video part ${part} upload was cancelled. No post was created.`,
      });

    if (error.kind === "timeout")
      return new SocialError({
        code: "timeout",
        operation: "media.upload",
        message: `LinkedIn video part ${part} upload exceeded its elapsed budget. No post was created.`,
        retryDisposition: { kind: "never" },
      });

    if (error.status === 429)
      return new SocialError({
        code: "rate_limited",
        operation: "media.upload",
        message: `LinkedIn rate limited video part ${part}. No post was created.`,
        upstreamStatus: error.status,
        retryDisposition:
          error.retryAfterMs === undefined
            ? { kind: "never" }
            : { kind: "after-delay", delayMs: error.retryAfterMs },
      });

    return new SocialError({
      code: "media_error",
      operation: "media.upload",
      message:
        error.status === 401
          ? `LinkedIn rejected video part ${part} because its upload URL expired. Start a new upload.`
          : `LinkedIn did not accept video part ${part}. Start a new upload; no post was created.`,
      upstreamStatus: error.status,
      retryDisposition: { kind: "never" },
    });
  }

  /** Reads one video's public status fields with a single GET after checking the grant and owner. */
  async function readVideoStatus(ref: MediaRef, context: AdapterOperationContext) {
    authorize(ref, context);

    if (!linkedInVideoUrn.test(ref.mediaId))
      throw new SocialError({
        code: "invalid_input",
        operation: "media.read",
        message: "Use the urn:li:video reference returned by media.upload.",
      });

    const video = object(await request(`/rest/videos/${encodeURIComponent(ref.mediaId)}`, context));

    if (video["owner"] !== ref.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation: "media.read",
        message: "LinkedIn video belongs to another author.",
      });

    if (video["id"] !== undefined && video["id"] !== ref.mediaId)
      throw new SocialError({
        code: "media_error",
        operation: "media.read",
        message: "LinkedIn returned the status of a different video.",
      });

    return publicFields(video, ["id", "owner", "status", "processingFailureReason", "duration"]);
  }

  function videoWaitCancelled(): SocialError {
    return new SocialError({
      code: "cancelled",
      operation: "media.read",
      message: "Waiting for the LinkedIn video was cancelled. No post was created.",
    });
  }

  /** Remaining elapsed budget in milliseconds, or 0 once it is exhausted. */
  function budgetLeft(context: AdapterOperationContext): number {
    try {
      return remainingBudget(context);
    } catch {
      return 0;
    }
  }

  /** Sleeps between explicit waitForVideo reads and rejects as soon as the context aborts. */
  function videoWaitDelay(milliseconds: number, context: AdapterOperationContext): Promise<void> {
    if (context.signal?.aborted) return Promise.reject(videoWaitCancelled());

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(videoWaitCancelled());
      };

      const timer = setTimeout(() => {
        context.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);

      context.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /*
   * Videos API thumbnail and caption uploads (li-lms-2026-10, accessed 2026-11-04): set
   * uploadThumbnail/uploadCaptions on initializeUpload, PUT the image to thumbnailUploadUrl with
   * media-type-family: STILLIMAGE, and POST the SRT file as multipart form data with caption
   * metadata to captionsUploadUrl. templateName and linkbackContext need version 202602+.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-10
   */
  async function sendVideoExtra(
    kind: "thumbnail" | "captions",
    url: string,
    body: Blob,
    mimeType: string,
    context: AdapterOperationContext,
  ) {
    try {
      await upload({
        url,
        source: { mimeType, size: body.size, body, open: () => body.stream() },
        allowHost: (host) => host === "www.linkedin.com",
        maxBytes: linkedInVideoExtraMaxBytes,
        timeoutMs: remainingBudget(context),
        ...(kind === "thumbnail"
          ? { headers: { "media-type-family": "STILLIMAGE" } }
          : { method: "POST" as const }),
        ...definedFields({ fetch: options.fetch, signal: context.signal }),
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      throw new SocialError({
        code:
          error.kind === "timeout"
            ? "timeout"
            : error.kind === "cancelled"
              ? "cancelled"
              : "media_error",
        operation: "media.upload",
        message: `LinkedIn did not accept the video ${kind}. Start a new upload; no post was created.`,
        upstreamStatus: error.status,
        retryDisposition: { kind: "never" },
      });
    }
  }

  /** Initializes, uploads every part and finalizes one video. It never waits for processing. */
  async function uploadVideo(
    media: MediaAttachment,
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
    extras: LinkedInVideoUploadExtras = {},
  ): Promise<MediaRef> {
    authorize(account, context);
    const source = media.source;

    if (media.mimeType !== "video/mp4" || source.kind !== "blob")
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: "Provide one MP4 video as a Blob with mimeType video/mp4.",
      });

    const thumbnail = media.thumbnail?.kind === "blob" ? media.thumbnail.blob : undefined;
    const captions = extras.captions;

    if (
      (media.thumbnail !== undefined &&
        (thumbnail === undefined ||
          !["image/jpeg", "image/png"].includes(thumbnail.type) ||
          thumbnail.size < 1 ||
          thumbnail.size > linkedInVideoExtraMaxBytes)) ||
      (captions !== undefined && (captions.size < 1 || captions.size > linkedInVideoExtraMaxBytes))
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message:
          "A LinkedIn video thumbnail must be a non-empty JPEG or PNG Blob, and captions a non-empty SRT Blob, each within the SDK's 20 MiB cap.",
      });

    if (
      (extras.templateName !== undefined || extras.linkbackContext !== undefined) &&
      (options.apiVersion < "202602" ||
        extras.templateName?.trim() === "" ||
        extras.linkbackContext?.trim() === "")
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message:
          "templateName and linkbackContext need API version 202602 or later and non-blank values.",
      });

    const blob = source.blob;

    if (
      (media.byteSize !== undefined && media.byteSize !== blob.size) ||
      blob.size < linkedInVideoMinBytes ||
      blob.size > linkedInVideoMaxBytes
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message:
          "LinkedIn feed video must be 75 KB to 500 MB, and byteSize must match the Blob size.",
      });

    if (
      media.durationSeconds !== undefined &&
      (!Number.isFinite(media.durationSeconds) ||
        media.durationSeconds < 3 ||
        media.durationSeconds > 1800)
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: "LinkedIn feed video must be 3 seconds to 30 minutes long.",
      });

    try {
      const initialized = object(
        object(
          await request("/rest/videos?action=initializeUpload", context, {
            initializeUploadRequest: {
              owner: account.accountId,
              fileSizeBytes: blob.size,
              uploadCaptions: captions !== undefined,
              uploadThumbnail: thumbnail !== undefined,
              ...definedFields({
                templateName: extras.templateName?.trim(),
                linkbackContext: extras.linkbackContext?.trim(),
              }),
            },
          }),
        )["value"],
      );

      const mediaId = string(initialized["video"]);
      // LinkedIn documents an empty upload token for some sessions, so only its type is checked.
      const uploadToken = optionalString(initialized["uploadToken"]);

      const parts = array(initialized["uploadInstructions"]).map((value) => {
        const part = object(value);

        return {
          url: string(part["uploadUrl"]),
          firstByte: optionalNumber(part["firstByte"]),
          lastByte: optionalNumber(part["lastByte"]),
        };
      });

      let nextByte = 0;
      const plan: { url: string; firstByte: number; lastByte: number }[] = [];

      for (const part of parts) {
        const { firstByte, lastByte } = part;

        if (
          firstByte !== nextByte ||
          lastByte === undefined ||
          !Number.isSafeInteger(lastByte) ||
          lastByte < firstByte ||
          lastByte - firstByte + 1 > linkedInVideoPartBytes
        )
          break;
        plan.push({ url: part.url, firstByte, lastByte });
        nextByte = lastByte + 1;
      }

      const thumbnailUploadUrl =
        thumbnail === undefined ? undefined : string(initialized["thumbnailUploadUrl"]);

      const captionsUploadUrl =
        captions === undefined ? undefined : string(initialized["captionsUploadUrl"]);

      if (
        !linkedInVideoUrn.test(mediaId) ||
        uploadToken === undefined ||
        plan.length === 0 ||
        plan.length !== parts.length ||
        nextByte !== blob.size
      )
        throw new SocialError({
          code: "media_error",
          operation: "media.upload",
          message:
            "LinkedIn returned an invalid video identifier or an upload plan that does not cover the file. No bytes were sent.",
          retryDisposition: { kind: "never" },
        });

      const uploadedPartIds: string[] = [];

      for (const [index, part] of plan.entries()) {
        const body = blob.slice(part.firstByte, part.lastByte + 1);
        let result: { bytes: number; etag?: string };

        try {
          // fetch sends the Blob slice directly; the declared size lets upload() check every byte.
          result = await upload({
            url: part.url,
            source: {
              mimeType: "application/octet-stream",
              size: body.size,
              body,
              open: () => body.stream(),
            },
            allowHost: (host) => host === "www.linkedin.com",
            maxBytes: linkedInVideoPartBytes,
            timeoutMs: remainingBudget(context),
            ...definedFields({ fetch: options.fetch, signal: context.signal }),
          });
        } catch (error) {
          if (error instanceof HttpError) throw videoPartError(error, index + 1);
          throw error;
        }

        // finalizeUpload takes the ETag value without the HTTP quoting.
        const etag = result.etag?.trim().replace(/^"(.*)"$/, "$1");

        if (!etag)
          throw new SocialError({
            code: "media_error",
            operation: "media.upload",
            message: `LinkedIn accepted video part ${index + 1} without an ETag. Start a new upload.`,
            retryDisposition: { kind: "never" },
          });
        uploadedPartIds.push(etag);
      }

      if (thumbnail !== undefined && thumbnailUploadUrl !== undefined)
        await sendVideoExtra(
          "thumbnail",
          thumbnailUploadUrl,
          thumbnail,
          "application/octet-stream",
          context,
        );

      if (captions !== undefined && captionsUploadUrl !== undefined) {
        // Only English captions are supported; the metadata mirrors LinkedIn's documented sample.
        const form = new FormData();

        form.append(
          "metadata",
          JSON.stringify({
            format: "SRT",
            formattedForEasyReader: true,
            largeText: true,
            source: "USER_PROVIDED",
            locale: { variant: "AMERICAN", country: "US", language: "EN" },
            transcriptType: "CLOSED_CAPTION",
          }),
        );
        form.append("file", new Blob([captions], { type: "text/plain" }), "captions.srt");
        // Serializing through Response yields the bytes and the boundary in the Blob type.
        const body = await new Response(form).blob();

        await sendVideoExtra("captions", captionsUploadUrl, body, body.type, context);
      }

      await request("/rest/videos?action=finalizeUpload", context, {
        finalizeUploadRequest: { video: mediaId, uploadToken, uploadedPartIds },
      });

      return {
        kind: "media",
        version: 1,
        backend: account.backend,
        platform: "linkedin",
        accountId: account.accountId,
        mediaId,
      };
    } catch (error) {
      // Malformed upload responses fail before any post request, so no post exists.
      if (error instanceof HttpError)
        throw new SocialError({
          code: "media_error",
          operation: "media.upload",
          message: "LinkedIn returned a malformed video upload response. No post was created.",
          retryDisposition: { kind: "never" },
        });
      throw error;
    }
  }

  async function uploadDocument(
    media: MediaAttachment,
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<MediaRef> {
    authorize(account, context);
    const source = media.source;
    const size = source.kind === "blob" ? source.blob.size : media.byteSize;
    const mimeType = media.mimeType ?? "";

    if (
      media.kind !== "document" ||
      !linkedInDocumentMimeTypes.includes(mimeType) ||
      (source.kind !== "blob" && source.kind !== "stream")
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: "Provide PDF, PPT, PPTX, DOC or DOCX bytes as a Blob or replayable stream.",
      });

    if (
      (source.kind === "blob" && media.byteSize !== undefined && media.byteSize !== size) ||
      (size !== undefined &&
        (!Number.isSafeInteger(size) || size <= 0 || size > linkedInDocumentMaxBytes))
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message:
          "LinkedIn documents must be non-empty and at most 100 MB, and byteSize must match the Blob size.",
      });

    const initialized = object(
      object(
        await request("/rest/documents?action=initializeUpload", context, {
          initializeUploadRequest: { owner: account.accountId },
        }),
      )["value"],
    );

    const mediaId = string(initialized["document"]);

    if (!linkedInDocumentUrn.test(mediaId))
      throw new SocialError({
        code: "media_error",
        operation: "media.upload",
        message: "LinkedIn returned an invalid document identifier.",
      });

    let transferred: number;

    try {
      ({ bytes: transferred } = await upload({
        url: string(initialized["uploadUrl"]),
        source: {
          mimeType,
          ...definedFields({ size }),
          open: source.kind === "blob" ? () => source.blob.stream() : source.open,
        },
        allowHost: (host) => host === "www.linkedin.com",
        maxBytes: linkedInDocumentMaxBytes,
        timeoutMs: remainingBudget(context),
        ...definedFields({ fetch: options.fetch, signal: context.signal }),
      }));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      throw new SocialError({
        code:
          error.kind === "timeout"
            ? "timeout"
            : error.kind === "cancelled"
              ? "cancelled"
              : error.kind === "invalid-input"
                ? "invalid_input"
                : "media_error",
        operation: "media.upload",
        message: `LinkedIn document upload for ${mediaId} did not complete: ${error.message}`,
        upstreamStatus: error.status,
        retryDisposition: { kind: "never" },
      });
    }

    // A stream without byteSize can end empty; LinkedIn cannot publish an empty document.
    if (transferred === 0)
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: `LinkedIn document upload for ${mediaId} sent no bytes. Provide a non-empty document.`,
        retryDisposition: { kind: "never" },
      });

    return {
      kind: "media",
      version: 1,
      backend: account.backend,
      platform: "linkedin",
      accountId: account.accountId,
      mediaId,
    };
  }

  async function readDocument(ref: MediaRef, context: AdapterOperationContext, operation: string) {
    authorize(ref, context);

    if (!linkedInDocumentUrn.test(ref.mediaId))
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "Use the urn:li:document reference returned by media.upload.",
      });

    const document = object(
      await request(`/rest/documents/${encodeURIComponent(ref.mediaId)}`, context),
    );

    if (
      document["owner"] !== ref.accountId ||
      (document["id"] !== undefined && document["id"] !== ref.mediaId)
    )
      throw new SocialError({
        code: "unauthorized",
        operation,
        message: "LinkedIn document belongs to another author.",
      });

    return document;
  }

  /** The Posts API requires a title for documents; take it from caption, then filename. */
  const documentTitle = (media: MediaAttachment) =>
    media.caption?.trim() || media.filename?.trim() || "";

  const documentIssues = (target: PreparedPublishTarget): [string, string][] => {
    const media = target.content.media ?? [];

    if (!media.some((item) => item.kind === "document")) return [];
    const issues: [string, string][] = [];

    if (media.length !== 1)
      issues.push([
        "linkedin.document_count",
        "A LinkedIn document post carries exactly one document and no other media.",
      ]);

    for (const item of media) {
      if (item.kind !== "document") continue;

      if (item.source.kind !== "media-ref")
        issues.push([
          "linkedin.document",
          "Upload the document first with media.upload, then publish its account-bound reference.",
        ]);
      else if (
        item.source.ref.backend !== target.account.backend ||
        item.source.ref.accountId !== target.account.accountId ||
        item.source.ref.platform !== "linkedin" ||
        !linkedInDocumentUrn.test(item.source.ref.mediaId)
      )
        issues.push([
          "linkedin.media_owner",
          "Document reference belongs to another author/backend or has an invalid URN.",
        ]);

      if (!documentTitle(item))
        issues.push([
          "linkedin.document_title",
          "LinkedIn requires a document title. Set caption or filename on the attachment.",
        ]);

      if (item.altText !== undefined)
        issues.push([
          "linkedin.document_alt_text",
          "LinkedIn documents have no verified alt text mapping. Remove altText.",
        ]);
    }

    return issues;
  };

  async function documentContent(
    media: MediaAttachment,
    context: AdapterOperationContext,
  ): Promise<JsonObject> {
    if (media.source.kind !== "media-ref")
      throw new SocialError({
        code: "invalid_input",
        operation: "posts.publish",
        message: "Upload the document first with media.upload.",
      });

    const document = await readDocument(media.source.ref, context, "posts.publish");

    if (document["status"] !== "AVAILABLE")
      throw new SocialError({
        code: "media_error",
        operation: "posts.publish",
        message:
          "Document is not AVAILABLE. Check its status with the native documentStatus helper, then publish again with a new idempotency key.",
      });

    return { media: { id: media.source.ref.mediaId, title: documentTitle(media) } };
  }

  /**
   * Reads one image before it is referenced elsewhere (an article thumbnail or a comment image).
   * A foreign owner or a returned status other than AVAILABLE stops the write. A member token's
   * 403 on the versioned image read is tolerated, as for image posts.
   */
  async function assertImageUsable(
    mediaId: string,
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ) {
    let image: JsonObject | undefined;

    try {
      image = object(await request(`/rest/images/${encodeURIComponent(mediaId)}`, context));
    } catch (error) {
      if (
        !(error instanceof SocialError) ||
        error.code !== "missing_permission" ||
        !account.accountId.startsWith("urn:li:person:")
      )
        throw error;
    }

    if (image?.["owner"] !== undefined && image["owner"] !== account.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation: "media.read",
        message: "LinkedIn image belongs to a different author.",
      });

    if (image?.["status"] !== undefined && image["status"] !== "AVAILABLE")
      throw new SocialError({
        code: "media_error",
        operation: "media.read",
        message: "Image is not AVAILABLE. Check it with native imageStatus before using it.",
      });
  }

  /** Normalized post read: scalar fields plus the URN-only `content` and `reshareContext` objects. */
  const postRecord = (row: JsonObject): JsonObject => ({
    ...publicFields(row, [
      "id",
      "author",
      "commentary",
      "visibility",
      "lifecycleState",
      "createdAt",
      "publishedAt",
      "lastModifiedAt",
      "isReshareDisabledByAuthor",
    ]),
    ...definedFields({
      content: optionalObject(row["content"]),
      reshareContext: optionalObject(row["reshareContext"]),
    }),
  });

  /*
   * Poll API (li-lms-2026-10, accessed 2026-11-04): reads return per-option voteCount (hidden from
   * some viewers) and uniqueVotersCount.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/poll-post-api?view=li-lms-2026-10
   */
  const decodePoll = (value: JsonField): LinkedInPollResults | undefined => {
    const poll = optionalObject(value);
    const question = optionalString(poll?.["question"]);

    if (poll === undefined || question === undefined) return undefined;
    const settings = optionalObject(poll["settings"]);

    return {
      question,
      options: (optionalArray(poll["options"]) ?? []).flatMap((entry) => {
        const option = optionalObject(entry);
        const text = optionalString(option?.["text"]);

        return text === undefined
          ? []
          : [{ text, ...definedFields({ voteCount: optionalNumber(option?.["voteCount"]) }) }];
      }),
      ...definedFields({
        uniqueVotersCount: optionalNumber(poll["uniqueVotersCount"]),
        duration: optionalString(settings?.["duration"]),
        voteSelectionType: optionalString(settings?.["voteSelectionType"]),
      }),
    };
  };

  const decodePost = (row: JsonObject): LinkedInPost => {
    const content = optionalObject(row["content"]);
    const reshare = optionalObject(row["reshareContext"]);
    const parent = optionalString(reshare?.["parent"]);

    return {
      id: string(row["id"]),
      author: string(row["author"]),
      ...definedFields({
        commentary: optionalString(row["commentary"]),
        visibility: optionalString(row["visibility"]),
        lifecycleState: optionalString(row["lifecycleState"]),
        createdAt: optionalNumber(row["createdAt"]),
        publishedAt: optionalNumber(row["publishedAt"]),
        lastModifiedAt: optionalNumber(row["lastModifiedAt"]),
        isReshareDisabledByAuthor: optionalBoolean(row["isReshareDisabledByAuthor"]),
        isEditedByAuthor: optionalBoolean(
          optionalObject(row["lifecycleStateInfo"])?.["isEditedByAuthor"],
        ),
        reshareContext:
          parent === undefined
            ? undefined
            : { parent, ...definedFields({ root: optionalString(reshare?.["root"]) }) },
        content,
        poll: decodePoll(content?.["poll"]),
      }),
    };
  };

  const linkedInPostUrn = /^urn:li:(?:share|ugcPost):\d+$/;

  /** Rest.li 2.0 encodes reserved characters, including the parentheses of a composite URN. */
  const restliEncode = (urn: string) =>
    encodeURIComponent(urn).replaceAll("(", "%28").replaceAll(")", "%29");

  const linkedInCommentUrn = /^urn:li:comment:\((urn:li:(?:activity|share|ugcPost):\d+),(\d+)\)$/;

  /** Validates a returned-offset cursor and a page size from 1 to 100. */
  const offsetPage = (
    input: { readonly cursor?: string; readonly limit?: number },
    operation: string,
  ) => {
    const start = input.cursor === undefined ? 0 : Number(input.cursor);
    const count = input.limit ?? 25;

    if (
      (input.cursor !== undefined && !/^(?:0|[1-9][0-9]{0,8})$/.test(input.cursor)) ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > 100
    )
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "LinkedIn requires a returned offset and page size from 1 to 100.",
      });

    return { start, count };
  };

  /** The next offset cursor from Rest.li paging, or undefined at the end. */
  const nextOffset = (result: JsonObject, start: number, returned: number) => {
    const paging = optionalObject(result["paging"]) ?? {};
    const total = optionalNumber(paging["total"]);

    const hasNext = (optionalArray(paging["links"]) ?? []).some(
      (link) => optionalObject(link)?.["rel"] === "next",
    );

    return returned > 0 && (hasNext || (total !== undefined && start + returned < total))
      ? String(start + returned)
      : undefined;
  };

  /** Keeps authorship, timestamps, threading, and engagement records for normalization. */
  const commentRecord = (value: JsonValue) => {
    const row = object(value);
    const nested: Record<string, JsonValue> = {};

    for (const field of [
      "message",
      "created",
      "lastModified",
      "parentComment",
      "content",
      "likesSummary",
      "commentsSummary",
    ]) {
      const entry = row[field];

      if (entry !== undefined) nested[field] = entry;
    }

    return normalizeComment({
      ...publicFields(row, ["id", "actor", "commentUrn", "object", "agent"]),
      ...nested,
      text: string(object(row["message"])["text"]),
    });
  };

  /*
   * Comments API mention attributes (li-lms-2026-10, accessed 2026-11-04): start, length and a
   * value of { person: { person } } or { organization: { organization } }.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api?view=li-lms-2026-10
   */
  const commentAttributes = (
    text: string,
    mentions: readonly LinkedInCommentMention[],
    operation: string,
  ): JsonObject[] | undefined => {
    if (!text.trim() || text.length > 1250)
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "Provide a comment of 1 to 1,250 characters.",
      });

    let cursor = 0;

    for (const mention of [...mentions].sort((left, right) => left.start - right.start)) {
      if (
        !Number.isSafeInteger(mention.start) ||
        !Number.isSafeInteger(mention.length) ||
        mention.start < cursor ||
        mention.length < 1 ||
        mention.start + mention.length > text.length ||
        !linkedInMemberOrOrganization.test(mention.urn)
      )
        throw new SocialError({
          code: "invalid_input",
          operation,
          message:
            "Comment mentions need non-overlapping start/length ranges inside the text and a person or organization URN.",
        });
      cursor = mention.start + mention.length;
    }

    return mentions.length === 0
      ? undefined
      : mentions.map((mention) => ({
          start: mention.start,
          length: mention.length,
          value: mention.urn.startsWith("urn:li:person:")
            ? { person: { person: mention.urn } }
            : { organization: { organization: mention.urn } },
        }));
  };

  /** The `?actor=` query LinkedIn requires when an organization edits or deletes a comment. */
  const organizationActor = () =>
    options.auth.author.startsWith("urn:li:organization:")
      ? `?actor=${encodeURIComponent(options.auth.author)}`
      : "";

  /** First value of a MultiLocaleString, preferring the flattened `localized{Field}` form. */
  const localizedText = (row: JsonObject, field: string, flattened: string) => {
    const direct = optionalString(row[flattened]);

    if (direct !== undefined) return direct;

    const localized = optionalObject(optionalObject(row[field])?.["localized"]);

    return localized === undefined
      ? undefined
      : Object.values(localized).find((value): value is string => isString(value));
  };

  const decodeProfile = (row: JsonObject): LinkedInProfile => {
    const id = string(row["id"]);

    if (!/^[a-zA-Z0-9_-]+$/.test(id))
      throw new SocialError({
        code: "upstream_failure",
        operation: "profile.read",
        message: "LinkedIn returned a profile without a valid person ID.",
      });

    const geoLocation = optionalObject(row["geoLocation"]);
    const geo = optionalString(geoLocation?.["geo"]);

    return {
      personUrn: `urn:li:person:${id}`,
      fields: row,
      ...definedFields({
        firstName: localizedText(row, "firstName", "localizedFirstName"),
        lastName: localizedText(row, "lastName", "localizedLastName"),
        headline: localizedText(row, "headline", "localizedHeadline"),
        vanityName: optionalString(row["vanityName"]),
        profilePictureUrn: optionalString(optionalObject(row["profilePicture"])?.["displayImage"]),
        geoLocation:
          geo === undefined
            ? undefined
            : {
                geo,
                ...definedFields({
                  autoGenerated: optionalBoolean(geoLocation?.["autoGenerated"]),
                }),
              },
      }),
    };
  };

  /** Validates a Rest.li field projection: field names, `~` decoration, commas, balanced parens. */
  const projectionQuery = (projection: string | undefined, operation: string) => {
    if (projection === undefined) return "";

    let depth = 0;

    for (const character of projection) {
      depth += character === "(" ? 1 : character === ")" ? -1 : 0;

      if (depth < 0) break;
    }

    if (projection.length > 1000 || !/^\([A-Za-z0-9_~,()]+\)$/.test(projection) || depth !== 0)
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "A projection is a parenthesized Rest.li field list, such as (id,firstName).",
      });

    // The decoder checks the member identity, so a projection always asks for `id` too.
    let level = 0;

    let field = "";

    const topLevel: string[] = [];

    for (const character of projection.slice(1, -1)) {
      if (character === "(") level++;
      else if (character === ")") level--;
      else if (character === "," && level === 0) {
        topLevel.push(field);
        field = "";
      } else if (level === 0) field += character;
    }

    topLevel.push(field);

    const withIdentity = topLevel.includes("id") ? projection : `(id,${projection.slice(1)}`;

    return `projection=${withIdentity}`;
  };

  const isAuthorizationAction = (action: LinkedInOrganizationAuthorizationAction) => {
    const allowed: readonly string[] = Object.hasOwn(linkedInAuthorizationActions, action.group)
      ? linkedInAuthorizationActions[action.group]
      : [];

    return allowed.includes(action.actionType);
  };

  const authorizationAction = (action: LinkedInOrganizationAuthorizationAction) =>
    `(${action.group}:(actionType:${action.actionType}))`;

  const authorizationKey = (key: LinkedInOrganizationAuthorizationKey) =>
    `(impersonator:${restliEncode(key.impersonator)},organization:${restliEncode(key.organization)},action:${authorizationAction(key.action)})`;

  const isAuthorizationKey = (key: LinkedInOrganizationAuthorizationKey) =>
    /^urn:li:person:[a-zA-Z0-9_-]+$/.test(key.impersonator) &&
    /^urn:li:organization:[1-9][0-9]*$/.test(key.organization) &&
    isAuthorizationAction(key.action);

  /** LinkedIn names the returned action record inconsistently; read its one `actionType`. */
  const decodeAuthorization = (value: JsonField): LinkedInOrganizationAuthorization => {
    const row = object(value);

    const actionType = Object.values(object(row["action"]))
      .map((entry) => optionalString(optionalObject(entry)?.["actionType"]))
      .find((entry) => entry !== undefined);

    const status = Object.entries(object(row["status"]))[0];

    if (actionType === undefined || status === undefined)
      throw new SocialError({
        code: "upstream_failure",
        operation: "organizations.authorizations.read",
        message: "LinkedIn returned an organization authorization without an action or status.",
      });

    const name = status[0].slice(status[0].lastIndexOf(".") + 1);

    return {
      impersonator: string(row["impersonator"]),
      organization: string(row["organization"]),
      actionType,
      approved: status[0] === "com.linkedin.organization.Approved",
      status: name,
      reasons: (optionalArray(optionalObject(status[1])?.["reasons"]) ?? []).filter(isString),
    };
  };

  const linkedInEventUrn = /^urn:li:event:(\d+)$/;

  /** Event IDs exceed Number.MAX_SAFE_INTEGER; the JSON reader keeps those as digit strings. */
  const longId = (value: JsonField) =>
    isString(value) && /^\d+$/.test(value)
      ? value
      : isFiniteNumber(value) && Number.isSafeInteger(value) && value > 0
        ? String(value)
        : undefined;

  const eventLocale = (locale: string | undefined) => {
    const key = locale ?? "en_US";

    if (!/^[a-z]{2}(?:_[A-Z]{2})?$/.test(key))
      throw new SocialError({
        code: "invalid_input",
        operation: "events.write",
        message: "An event locale is a key such as en_US.",
      });

    return key;
  };

  const multiLocale = (text: string, locale: string) => ({ localized: { [locale]: text } });

  const richText = (text: string, locale: string) => ({
    localized: { [locale]: { rawText: text } },
  });

  const eventInstant = (value: number | undefined) =>
    value === undefined || (Number.isSafeInteger(value) && value > 0);

  const eventHttpsUrl = (value: string | undefined) => {
    if (value === undefined) return true;

    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  };

  const eventAddress = (address: LinkedInEventAddress) => {
    if (address.country !== undefined && !/^[A-Z]{2}$/.test(address.country))
      throw new SocialError({
        code: "invalid_input",
        operation: "events.write",
        message: "Event address fields are strings and country is an ISO-3166 two-letter code.",
      });

    return definedFields({
      line1: address.line1,
      line2: address.line2,
      city: address.city,
      geographicArea: address.geographicArea,
      postalCode: address.postalCode,
      country: address.country,
    });
  };

  /** Wire `type` for a create (full type) or update (changed sub-fields of the same type). */
  const eventTypeWire = (type: LinkedInEventType | LinkedInEventTypeChanges, locale: string) => {
    if (!eventInstant(type.endsAt))
      throw new SocialError({
        code: "invalid_input",
        operation: "events.write",
        message: "Event endsAt must be positive epoch milliseconds.",
      });

    switch (type.kind) {
      case "liveVideo":
        return {
          online: {
            format: {
              liveVideo: definedFields({
                endsAt: type.endsAt,
                testEvent: "testEvent" in type ? type.testEvent : undefined,
              }),
            },
          },
        };
      case "external":
        if (!eventHttpsUrl(type.url))
          throw new SocialError({
            code: "invalid_input",
            operation: "events.write",
            message: "An external event url must be HTTPS.",
          });

        return {
          online: { format: { external: definedFields({ endsAt: type.endsAt, url: type.url }) } },
        };
      case "inPerson":
        if (!eventHttpsUrl(type.url))
          throw new SocialError({
            code: "invalid_input",
            operation: "events.write",
            message: "An in-person event url must be HTTPS.",
          });

        return {
          inPerson: definedFields({
            endsAt: type.endsAt,
            url: type.url,
            address: type.address === undefined ? undefined : eventAddress(type.address),
            venueDetails:
              type.venueDetails === undefined ? undefined : richText(type.venueDetails, locale),
          }),
        };
      default: {
        const exhaustive: never = type;

        return exhaustive;
      }
    }
  };

  const decodeEvent = (row: JsonObject, fallbackId?: string): LinkedInEvent => {
    const id = longId(row["id"]) ?? fallbackId;

    if (id === undefined)
      throw new SocialError({
        code: "upstream_failure",
        operation: "events.read",
        message: "LinkedIn returned an event without an ID.",
      });

    const type = optionalObject(row["type"]);
    const format = optionalObject(optionalObject(type?.["online"])?.["format"]);
    const liveVideo = optionalObject(format?.["liveVideo"]);
    const external = optionalObject(format?.["external"]);
    const inPerson = optionalObject(type?.["inPerson"]);
    const detail = liveVideo ?? external ?? inPerson;
    const liveVideoUrn = optionalString(liveVideo?.["liveVideo"]);
    const eventUrn: `urn:li:event:${string}` = `urn:li:event:${id}`;

    return {
      eventUrn,
      fields: row,
      ...definedFields({
        organizer: optionalString(row["organizer"]),
        name: localizedText(row, "name", "localizedName"),
        startsAt: optionalNumber(row["startsAt"]),
        endsAt: optionalNumber(detail?.["endsAt"]),
        kind:
          liveVideo !== undefined
            ? ("liveVideo" as const)
            : external !== undefined
              ? ("external" as const)
              : inPerson !== undefined
                ? ("inPerson" as const)
                : undefined,
        vanityName: optionalString(row["vanityName"]),
        discoveryMode: optionalString(row["discoveryMode"]),
        backgroundImage: optionalString(row["backgroundImage"]),
        ugcPost: optionalString(row["ugcPost"]),
        liveVideo: liveVideoUrn,
        leadGenForm: optionalString(row["leadGenForm"]),
        postReference: liveVideo === undefined ? eventUrn : liveVideoUrn,
      }),
    };
  };

  const eventPath = (event: string) => {
    const id = linkedInEventUrn.exec(event)?.[1];

    if (id === undefined)
      throw new SocialError({
        code: "invalid_input",
        operation: "events.read",
        message: "Identify the event by its urn:li:event URN.",
      });

    return `/rest/events/${id}`;
  };

  const decodeSocialMetadata = (result: JsonObject): LinkedInSocialMetadata => {
    const reactions: Record<string, number> = {};

    for (const [type, summary] of Object.entries(
      optionalObject(result["reactionSummaries"]) ?? {},
    )) {
      const count = optionalNumber(optionalObject(summary)?.["count"]);

      if (count !== undefined) reactions[type] = count;
    }

    const comments = optionalObject(result["commentSummary"]);

    return {
      reactions,
      ...definedFields({
        entity: optionalString(result["entity"]),
        commentsState: optionalString(result["commentsState"]),
        comments:
          comments === undefined
            ? undefined
            : definedFields({
                total: optionalNumber(comments["count"]),
                topLevel: optionalNumber(comments["topLevelCount"]),
              }),
      }),
    };
  };

  /**
   * Splits a Rest.li BATCH_GET response into rows for the requested keys and per-key failures.
   * `key` maps a requested id to the key LinkedIn uses in `results`, `statuses` and `errors`.
   */
  const batchRows = (
    result: JsonObject,
    ids: readonly string[],
    key: (id: string) => string = (id) => id,
  ) => {
    const results = optionalObject(result["results"]) ?? {};
    const statuses = optionalObject(result["statuses"]) ?? {};
    const failures = optionalObject(result["errors"]) ?? {};
    const rows: (readonly [string, JsonObject])[] = [];
    const errors: LinkedInBatchError[] = [];

    for (const id of ids) {
      const row = optionalObject(results[key(id)]);

      if (row !== undefined) {
        rows.push([id, row]);
        continue;
      }

      const status =
        optionalNumber(statuses[key(id)]) ??
        optionalNumber(optionalObject(failures[key(id)])?.["status"]);

      errors.push({ id, ...definedFields({ status }) });
    }

    return { rows, errors };
  };

  /** Validates 1 to 100 distinct post or comment URNs for a social BATCH_GET. */
  const socialBatchIds = (entities: readonly string[], operation: string) => {
    const ids = [...new Set(entities)];

    if (
      ids.length === 0 ||
      ids.length > 100 ||
      !ids.every((id) => linkedInPostUrn.test(id) || linkedInCommentUrn.test(id))
    )
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "Batch read 1 to 100 share, ugcPost or comment URNs.",
      });

    return ids;
  };

  const decodeReaction = (row: JsonObject): LinkedInReaction => {
    const created = optionalObject(row["created"]);

    return {
      reactionType: string(row["reactionType"]),
      ...definedFields({
        id: optionalString(row["id"]),
        actor: optionalString(created?.["actor"]),
        root: optionalString(row["root"]),
        createdAt: optionalNumber(created?.["time"]),
      }),
    };
  };

  /** Rest.li compound key of a reaction, with both URNs encoded as LinkedIn documents. */
  const reactionKey = (key: LinkedInReactionKey) =>
    `(actor:${restliEncode(key.actor)},entity:${restliEncode(key.entity)})`;

  const isReactionKey = (key: LinkedInReactionKey) =>
    linkedInMemberOrOrganization.test(key.actor) &&
    (linkedInPostUrn.test(key.entity) || linkedInCommentUrn.test(key.entity));

  const decodeOrganizationSummary = (value: JsonField): LinkedInOrganizationSummary[] => {
    const row = optionalObject(value);
    const id = optionalNumber(row?.["id"]);

    if (row === undefined || id === undefined || !Number.isSafeInteger(id) || id < 1) return [];

    return [
      {
        organization: `urn:li:organization:${id}`,
        ...definedFields({
          localizedName: optionalString(row["localizedName"]),
          vanityName: optionalString(row["vanityName"]),
          localizedWebsite: optionalString(row["localizedWebsite"]),
          primaryOrganizationType: optionalString(row["primaryOrganizationType"]),
        }),
      },
    ];
  };

  const memberOnly = (
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
    operation: string,
  ) => {
    authorize(account, context);

    if (!account.accountId.startsWith("urn:li:person:"))
      throw new SocialError({
        code: "unsupported_capability",
        operation,
        message: "LinkedIn member analytics require a member account, not an organization account.",
      });
  };

  const validDate = (date: LinkedInDate | undefined) =>
    date === undefined ||
    (Number.isSafeInteger(date.year) &&
      date.year >= 2000 &&
      date.year <= 9999 &&
      Number.isSafeInteger(date.month) &&
      date.month >= 1 &&
      date.month <= 12 &&
      Number.isSafeInteger(date.day) &&
      date.day >= 1 &&
      date.day <= 31);

  /** Rest.li record form, for example (start:(year:2024,month:5,day:4),end:(...)). */
  const dateRangeParam = (range: LinkedInDateRange, operation: string) => {
    if (!validDate(range.start) || !validDate(range.end) || (!range.start && !range.end))
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "dateRange needs a start or end with integer year, month (1-12) and day (1-31).",
      });

    const part = (name: string, date: LinkedInDate | undefined) =>
      date === undefined ? [] : [`${name}:(year:${date.year},month:${date.month},day:${date.day})`];

    return `(${[...part("start", range.start), ...part("end", range.end)].join(",")})`;
  };

  const decodeDate = (value: JsonField): LinkedInDate | undefined => {
    const date = optionalObject(value);
    const year = optionalNumber(date?.["year"]);
    const month = optionalNumber(date?.["month"]);
    const day = optionalNumber(date?.["day"]);

    return year === undefined || month === undefined || day === undefined
      ? undefined
      : { year, month, day };
  };

  const decodeDateRange = (value: JsonField): LinkedInDateRange | undefined => {
    const range = optionalObject(value);

    if (range === undefined) return undefined;

    const decoded = definedFields({
      start: decodeDate(range["start"]),
      end: decodeDate(range["end"]),
    });

    return decoded.start === undefined && decoded.end === undefined ? undefined : decoded;
  };

  /*
   * Member post and video statistics (li-lms-2026-10, accessed 2026-11-04). Versions before 202605
   * wrap metricType in an object keyed by its Pegasus type; both shapes decode.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics?view=li-lms-2026-10
   */
  const memberAnalyticsPoints = (result: JsonObject): LinkedInMemberAnalyticsPoint[] =>
    array(result["elements"]).map((value) => {
      const row = object(value);
      const metricType = row["metricType"];

      const metric = isString(metricType)
        ? metricType
        : Object.values(optionalObject(metricType) ?? {}).find(isString);

      const count = optionalNumber(row["count"]);

      if (metric === undefined || count === undefined)
        throw new SocialError({
          code: "upstream_failure",
          operation: "analytics.member.read",
          message: "LinkedIn returned a member analytics element without a metric and count.",
        });

      return {
        metric,
        count,
        ...definedFields({
          post: Object.values(optionalObject(row["targetEntity"]) ?? {}).find(isString),
          dateRange: decodeDateRange(row["dateRange"]),
        }),
      };
    });

  /** The memberCreator analytics `entity` parameter: (share:{urn}) or (ugc:{urn}). */
  const memberAnalyticsEntity = (postId: string, operation: string) => {
    if (!linkedInPostUrn.test(postId))
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "Member analytics need a urn:li:share or urn:li:ugcPost post.",
      });

    return `(${postId.startsWith("urn:li:share:") ? "share" : "ugc"}:${restliEncode(postId)})`;
  };

  /*
   * Member follower statistics (li-lms-2026-10, accessed 2026-11-04): q=me returns the lifetime
   * count; q=dateRange returns daily counts. Needs r_member_profileAnalytics.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/follower-statistics?view=li-lms-2026-10
   */
  async function memberFollowerCounts(
    dateRange: LinkedInDateRange | undefined,
    context: AdapterOperationContext,
  ): Promise<LinkedInMemberFollowerCount[]> {
    const query =
      dateRange === undefined
        ? "q=me"
        : `q=dateRange&dateRange=${dateRangeParam(dateRange, "analytics.member.followers.read")}`;

    const result = object(await request(`/rest/memberFollowersCount?${query}`, context));

    return array(result["elements"]).flatMap((value) => {
      const row = object(value);
      const count = optionalNumber(row["memberFollowersCount"]);

      return count === undefined
        ? []
        : [{ count, ...definedFields({ dateRange: decodeDateRange(row["dateRange"]) }) }];
    });
  }

  /*
   * Organization social action notifications, criteria finder (li-lms-2026-10, accessed
   * 2026-11-04): actions are required, timeRange.start is inclusive and end exclusive, and
   * sourcePost allows a single action. Notifications are kept for 60 days.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-social-action-notifications?view=li-lms-2026-10
   */
  async function pullNotifications(
    account: ConnectedAccountRef,
    input: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly actions?: readonly LinkedInNotificationAction[];
      readonly sourcePost?: string;
      readonly timeRange?: { readonly start?: number; readonly end?: number };
    },
    context: AdapterOperationContext,
  ): Promise<Page<JsonObject>> {
    const { start, count } = offsetPage(input, "notifications.read");
    const actions = input.actions ?? linkedInNotificationActions;
    const range = input.timeRange;

    const bound = (value: number | undefined) =>
      value === undefined || (Number.isSafeInteger(value) && value >= 0);

    if (
      actions.length === 0 ||
      !actions.every((action) => linkedInNotificationActions.includes(action)) ||
      (input.sourcePost !== undefined &&
        (actions.length !== 1 || !/^urn:li:activity:\d+$/.test(input.sourcePost))) ||
      (range !== undefined &&
        (!bound(range.start) ||
          !bound(range.end) ||
          (range.start === undefined && range.end === undefined) ||
          (range.start !== undefined && range.end !== undefined && range.end <= range.start)))
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "notifications.read",
        message:
          "Use documented notification actions, one action with an urn:li:activity sourcePost, and a timeRange of nonnegative epoch milliseconds with end after start.",
      });

    const timeRange =
      range === undefined
        ? ""
        : `&timeRange=(${[
            ...(range.start === undefined ? [] : [`start:${range.start}`]),
            ...(range.end === undefined ? [] : [`end:${range.end}`]),
          ].join(",")})`;

    const sourcePost =
      input.sourcePost === undefined ? "" : `&sourcePost=${restliEncode(input.sourcePost)}`;

    const result = object(
      await request(
        `/rest/organizationalEntityNotifications?q=criteria&actions=List(${actions.join(",")})&organizationalEntity=${encodeURIComponent(account.accountId)}${timeRange}${sourcePost}&start=${start}&count=${count}`,
        context,
      ),
    );

    const rows = array(result["elements"]).map(object);

    if (rows.some((row) => row["organizationalEntity"] !== account.accountId))
      throw new SocialError({
        code: "unauthorized",
        operation: "notifications.read",
        message: "LinkedIn returned a notification for another organization.",
      });

    const items = rows.map((row) =>
      publicFields(row, [
        "notificationId",
        "organizationalEntity",
        "action",
        "sourcePost",
        "generatedActivity",
        "lastModifiedAt",
      ]),
    );

    return { items, ...definedFields({ nextCursor: nextOffset(result, start, items.length) }) };
  }

  /** The eventSubscriptions key for the configured organization and one administrator. */
  const subscriptionPath = (
    account: ConnectedAccountRef,
    developerApplication: string,
    member: string,
  ) => {
    if (
      !/^urn:li:developerApplication:\d+$/.test(developerApplication) ||
      !/^urn:li:person:[a-zA-Z0-9_-]+$/.test(member)
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "webhooks.subscriptions.write",
        message:
          "Provide a urn:li:developerApplication URN and the administrator's urn:li:person URN.",
      });

    return `/rest/eventSubscriptions/(developerApplication:${restliEncode(developerApplication)},user:${restliEncode(member)},entity:${restliEncode(account.accountId)},eventType:ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS)`;
  };

  const organizationOnly = (
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
    operation: string,
  ) => {
    authorize(account, context);

    if (!account.accountId.startsWith("urn:li:organization:"))
      throw new SocialError({
        code: "unsupported_capability",
        operation,
        message: "This LinkedIn operation requires an organization account, not a member account.",
      });
  };

  const statisticsPath = (
    path: string,
    finder: "organization" | "organizationalEntity" | "brand",
    account: ConnectedAccountRef,
    interval?: LinkedInTimeInterval,
    entity: string = account.accountId,
  ) => {
    const params = [`q=${finder}`, `${finder}=${encodeURIComponent(entity)}`];

    if (interval) {
      if (
        interval.start !== undefined &&
        (!Number.isSafeInteger(interval.start) || interval.start < 0)
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "analytics.organization.read",
          message: "Interval start must be a nonnegative epoch-millisecond integer.",
        });

      if (interval.end !== undefined && (!Number.isSafeInteger(interval.end) || interval.end < 0))
        throw new SocialError({
          code: "invalid_input",
          operation: "analytics.organization.read",
          message: "Interval end must be a nonnegative epoch-millisecond integer.",
        });

      if (
        interval.start !== undefined &&
        interval.end !== undefined &&
        interval.end <= interval.start
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "analytics.organization.read",
          message: "Interval end must be after interval start.",
        });

      if (interval.start === undefined)
        throw new SocialError({
          code: "invalid_input",
          operation: "analytics.organization.read",
          message: "Interval start is required for time-bound organization statistics.",
        });

      const rangeParts = [
        `start:${interval.start}`,
        ...(interval.end === undefined ? [] : [`end:${interval.end}`]),
      ];

      const range = `(timeRange:(${rangeParts.join(",")}),timeGranularityType:${interval.granularity})`;

      if (
        !(
          path === "/rest/organizationalEntityFollowerStatistics"
            ? ["DAY", "WEEK", "MONTH"]
            : ["DAY", "MONTH"]
        ).includes(interval.granularity)
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "analytics.organization.read",
          message:
            "Follower intervals support DAY, WEEK or MONTH; page and share intervals support DAY or MONTH.",
        });
      params.push(`timeIntervals=${range}`);
    }

    return `${path}?${params.join("&")}`;
  };

  const numberMap = (value: JsonField) => {
    const output: Record<string, number> = {};

    const visit = (item: JsonField, key: string): void => {
      const number = optionalNumber(item);

      if (number !== undefined) output[key] = number;
      else if (isJsonArray(item)) {
        item.forEach((entry, index) => visit(entry, `${key}[${index}]`));
      } else if (isJsonObject(item)) {
        for (const [nestedKey, nestedValue] of Object.entries(item)) {
          // Keep existing total-view/click names. Unique views always retain their field name.
          const name =
            ["pageViews", "clicks", "count"].includes(nestedKey) || nestedKey === key
              ? key
              : key
                ? `${key}.${nestedKey}`
                : nestedKey;

          visit(nestedValue, name);
        }
      }
    };

    for (const [key, item] of Object.entries(value === undefined ? {} : object(value)))
      visit(item, key);

    return output;
  };

  const followerBreakdowns = (row: JsonObject): LinkedInFollowerBreakdown[] => {
    const dimensions = [
      ["function", "followerCountsByFunction", "function"],
      ["seniority", "followerCountsBySeniority", "seniority"],
      ["industry", "followerCountsByIndustry", "industry"],
      ["geo", "followerCountsByGeo", "geo"],
      ["geoCountry", "followerCountsByGeoCountry", "geo"],
      ["staffCountRange", "followerCountsByStaffCountRange", "staffCountRange"],
      ["associationType", "followerCountsByAssociationType", "associationType"],
    ] as const;

    const output: LinkedInFollowerBreakdown[] = [];

    for (const [dimension, field, key] of dimensions) {
      if (row[field] === undefined) continue;

      for (const value of array(row[field])) {
        const item = object(value);

        const label = optionalString(item[key]);

        if (!label) continue;

        const counts = item["followerCounts"] === undefined ? {} : object(item["followerCounts"]);
        output.push({
          dimension,
          value: label,
          ...definedFields({
            organicFollowerCount: optionalNumber(counts["organicFollowerCount"]),
            paidFollowerCount: optionalNumber(counts["paidFollowerCount"]),
          }),
        });
      }
    }

    return output;
  };

  const parseInterval = (
    row: JsonObject,
    requestedGranularity?: LinkedInTimeInterval["granularity"],
  ): LinkedInTimeInterval | undefined => {
    if (row["timeRange"] === undefined) return undefined;

    const range = object(row["timeRange"]);

    const start = optionalNumber(range["start"]);

    const end = optionalNumber(range["end"]);

    const granularity = requestedGranularity ?? optionalString(row["timeGranularityType"]);

    if (
      (granularity !== "DAY" && granularity !== "WEEK" && granularity !== "MONTH") ||
      (start === undefined && end === undefined)
    )
      return undefined;

    return { granularity, ...definedFields({ start, end }) };
  };

  const parseFollowerStatistics = (
    result: JsonObject,
    requestedGranularity?: LinkedInTimeInterval["granularity"],
  ): LinkedInFollowerStatistics[] =>
    array(result["elements"]).map((value) => {
      const row = object(value);

      const gains = row["followerGains"] === undefined ? {} : object(row["followerGains"]);

      return {
        organization: string(row["organizationalEntity"]),
        ...definedFields({
          interval: parseInterval(row, requestedGranularity),
          organicFollowerGain: optionalNumber(gains["organicFollowerGain"]),
          paidFollowerGain: optionalNumber(gains["paidFollowerGain"]),
        }),
        breakdowns: followerBreakdowns(row),
      };
    });

  const pageBreakdowns = (row: JsonObject) => {
    const output: LinkedInPageStatistics["breakdowns"] = [];

    for (const [field, dimension, key] of [
      ["pageStatisticsByFunction", "function", "function"],
      ["pageStatisticsBySeniority", "seniority", "seniority"],
      ["pageStatisticsByIndustryV2", "industryV2", "industryV2"],
      ["pageStatisticsByIndustry", "industry", "industry"],
      ["pageStatisticsByGeo", "geo", "geo"],
      ["pageStatisticsByGeoCountry", "geoCountry", "geo"],
      ["pageStatisticsByStaffCountRange", "staffCountRange", "staffCountRange"],
    ] as const) {
      if (row[field] === undefined) continue;

      for (const value of array(row[field])) {
        const item = object(value);

        const label = optionalString(item[key]);

        if (!label) continue;

        const stats = item["pageStatistics"] === undefined ? {} : object(item["pageStatistics"]);

        const views = stats["views"] === undefined ? {} : object(stats["views"]);

        const clicks = stats["clicks"] === undefined ? {} : object(stats["clicks"]);
        output.push({
          dimension,
          value: label,
          views: numberMap(views),
          clicks: numberMap(clicks),
          rawClicks: clicks,
        });
      }
    }

    return output;
  };

  const parsePageStatistics = (
    result: JsonObject,
    requestedGranularity?: LinkedInTimeInterval["granularity"],
    entityField: "organization" | "brand" = "organization",
  ): LinkedInPageStatistics[] =>
    array(result["elements"]).map((value) => {
      const row = object(value);

      const total =
        row["totalPageStatistics"] === undefined ? {} : object(row["totalPageStatistics"]);

      return {
        organization: string(row[entityField]),
        ...definedFields({ interval: parseInterval(row, requestedGranularity) }),
        views: numberMap(total["views"]),
        clicks: numberMap(total["clicks"]),
        rawClicks: total["clicks"] === undefined ? {} : object(total["clicks"]),
        breakdowns: pageBreakdowns(row),
      };
    });

  const parseShareStatistics = (
    result: JsonObject,
    requestedGranularity?: LinkedInTimeInterval["granularity"],
  ): LinkedInShareStatistics[] =>
    array(result["elements"]).map((value) => {
      const row = object(value);

      return {
        organization: string(row["organizationalEntity"]),
        ...definedFields({ interval: parseInterval(row, requestedGranularity) }),
        metrics: numberMap(row["totalShareStatistics"]),
      };
    });

  return defineAdapter({
    id: "linkedin",
    capabilities: {
      schemaVersion: 1 as const,
      backend: "linkedin",
      apiRevision: options.apiVersion,
      runtime: ["node22", "node24", "bun"],
      capabilities: [
        {
          platform: "linkedin",
          operation: "posts.publish",
          availability: "available" as const,
          formats: [
            "text" as const,
            "image" as const,
            "carousel" as const,
            "video" as const,
            "document" as const,
          ],
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "w_organization_social"
              : "w_member_social",
          ],
          // Mirrors prepareTarget: account-bound media references, at most 20 images per post.
          constraints: { mediaSources: ["media-ref" as const], maxItems: 20 },
          notes: options.auth.author.startsWith("urn:li:organization:")
            ? "Explicit organization author with public visibility, optional targetEntities targeting, annotations and reshare control. Requires product approval and ADMINISTRATOR, CONTENT_ADMIN (ACL CONTENT_ADMINISTRATOR) or DIRECT_SPONSORED_CONTENT_POSTER role. Supports image, multi-image, video and document posts."
            : "Explicit member author with public or connections visibility, annotations and reshare control. Requires w_member_social from Share on LinkedIn; no organization role is needed. Supports image, multi-image, video and document posts.",
        },
        {
          platform: "linkedin",
          operation: "posts.schedule",
          availability: "unsupported-by-platform" as const,
          notes:
            "The Posts API accepts only lifecycleState PUBLISHED on creation and has no publish-time field.",
        },
        {
          platform: "linkedin",
          operation: "posts.read",
          availability: "available" as const,
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "r_organization_social"
              : "r_member_social",
          ],
          notes:
            "Member post reads require the closed r_member_social grant, unavailable to new apps. Publication permission does not grant read permission.",
        },
        {
          platform: "linkedin",
          operation: "accounts.read",
          availability: "available" as const,
          requiredScopes: options.auth.author.startsWith("urn:li:organization:")
            ? ["rw_organization_admin"]
            : ["openid", "profile"],
          notes: options.auth.author.startsWith("urn:li:organization:")
            ? "Returns the configured organization only. Reads /rest/organizations/{id}, which LinkedIn restricts to members with an approved ADMINISTRATOR role."
            : "Returns the configured member only. Reads the OpenID Connect userinfo endpoint and checks that sub matches the author URN. Requires the Sign In with LinkedIn using OpenID Connect product.",
        },
        {
          platform: "linkedin",
          operation: "posts.multi-image",
          availability: "available" as const,
          formats: ["carousel" as const],
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "w_organization_social"
              : "w_member_social",
          ],
          notes:
            "Publishes 2 to 20 registered images through posts.publish as organic MultiImage content. Every image must be owned by the author and AVAILABLE. Sponsored multi-image posts are not supported.",
        },
        {
          platform: "linkedin",
          operation: "posts.video",
          availability: "available" as const,
          formats: ["video" as const],
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "w_organization_social"
              : "w_member_social",
          ],
          notes:
            "Upload one MP4 Blob (75 KB to 500 MB, 3 seconds to 30 minutes) with media.upload, then publish the video URN once it is AVAILABLE. Check processing with native videoStatus (one read) or the opt-in native waitForVideo (bounded reads within the operation budget). Publishing reads the status once and never waits; a processing video fails with no post created. The attachment caption becomes the optional video title.",
        },
        {
          platform: "linkedin",
          operation: "posts.document",
          availability: "available" as const,
          formats: ["document" as const],
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "w_organization_social"
              : "w_member_social",
          ],
          notes:
            "One PDF, PPT, PPTX, DOC or DOCX file up to 100 MB and 300 pages, uploaded through the Documents API. LinkedIn enforces the page limit during processing. Requires a title and AVAILABLE status.",
        },
        { platform: "linkedin", operation: "polls.create", availability: "available" as const },
        {
          platform: "linkedin",
          operation: "reactions.write",
          availability: "available" as const,
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "w_organization_social_feed"
              : "w_member_social_feed",
          ],
        },
        { platform: "linkedin", operation: "reshares.write", availability: "available" as const },
        { platform: "linkedin", operation: "posts.update", availability: "available" as const },
        { platform: "linkedin", operation: "posts.delete", availability: "available" as const },
        {
          platform: "linkedin",
          operation: "posts.removeFromPlatform",
          availability: "available" as const,
        },
        {
          platform: "linkedin",
          operation: "comments.delete",
          availability: "available" as const,
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "w_organization_social_feed"
              : "w_member_social_feed",
          ],
          notes:
            "Native deleteComment needs the post URN and the complete commentUrn. LinkedIn does not document which comments an actor may delete; expect only the configured author's own comments to succeed.",
        },
        {
          platform: "linkedin",
          operation: "media.video",
          availability: "available" as const,
          formats: ["video" as const],
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "w_organization_social"
              : "w_member_social",
          ],
          notes:
            "Native uploadVideo uploads an MP4 like media.upload, plus an English SRT captions file and templateName/linkbackContext attribution (API version 202602+). A JPEG or PNG media.thumbnail Blob becomes the custom thumbnail on both paths.",
        },
        ...(
          [
            [
              "webhooks.subscriptions.write",
              "Native subscribeOrganizationNotifications and unsubscribeOrganizationNotifications PUT and DELETE the eventSubscriptions key for the configured organization and one administrator.",
            ],
            [
              "webhooks.subscriptions.read",
              "Native listOrganizationNotificationSubscriptions lists the authenticated member's subscriptions for the configured organization.",
            ],
          ] as const
        ).map(([operation, notes]) => ({
          platform: "linkedin" as const,
          operation,
          availability: options.auth.author.startsWith("urn:li:organization:")
            ? ("approval-dependent" as const)
            : ("account-ineligible" as const),
          requiredScopes: ["rw_organization_admin"],
          notes: `${notes} Needs an approved webhook use case, a validated webhook and an ADMINISTRATOR role; the subscription ends with that member's grant or role.`,
        })),
        {
          platform: "linkedin",
          operation: "posts.read.batch",
          availability: "available" as const,
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "r_organization_social"
              : "r_member_social",
          ],
          notes:
            "Native getPosts sends BATCH_GET for up to 100 of the author's posts; native getPost reads one with viewContext READER or AUTHOR. LinkedIn does not allow BATCH_GET in the Development tier.",
        },
        ...(
          [
            [
              "social-metadata.read",
              "r",
              "Native getSocialMetadata returns reactionSummaries per type, comment totals and commentsState.",
            ],
            [
              "reactions.read",
              "r",
              "Native listReactions uses the q=entity finder with offset paging.",
            ],
            [
              "comments.replies.read",
              "r",
              "Native listCommentReplies checks the parent comment belongs to the post, then lists its replies.",
            ],
            [
              "reactions.delete",
              "w",
              "Native deleteReaction removes the configured author's reaction.",
            ],
            [
              "comments.state.write",
              "w",
              "Native setCommentsState sets commentsState OPEN or CLOSED. Closing deletes all existing comments.",
            ],
            [
              "comments.create",
              "w",
              "Native createComment writes a top-level comment or nested reply with optional mentions and one image, without pre-reading the post.",
            ],
            [
              "comments.edit",
              "w",
              "Native editComment replaces message text and mention attributes.",
            ],
          ] as const
        ).map(([operation, access, notes]) => ({
          platform: "linkedin" as const,
          operation,
          availability: "available" as const,
          requiredScopes: [
            `${access}_${options.auth.author.startsWith("urn:li:organization:") ? "organization" : "member"}_social_feed`,
          ],
          notes:
            access === "r"
              ? `${notes} LinkedIn restricts member r_member_social_feed to select developers.`
              : notes,
        })),
        {
          platform: "linkedin",
          operation: "analytics.organization.read",
          availability: options.auth.author.startsWith("urn:li:organization:")
            ? ("available" as const)
            : ("account-ineligible" as const),
          requiredScopes: ["rw_organization_admin"],
          notes:
            "Requires the Community Management API product and organization administrator access. Member accounts are not eligible.",
        },
        {
          platform: "linkedin",
          operation: "articles.create",
          availability: "available" as const,
          notes:
            "Publishes an article-link post through the Posts API. LinkedIn does not scrape article URLs; title and description are required by this adapter. The LinkedIn articleThumbnail option sends an uploaded image URN as the thumbnail.",
        },
        {
          platform: "linkedin",
          operation: "profile.update",
          availability: "not-implemented-by-adapter" as const,
          notes:
            "Member profile writes use the Profile Edit API, which LinkedIn restricts to approved developers. This adapter does not implement it.",
        },
        {
          platform: "linkedin",
          operation: "messages.write",
          availability: "not-implemented-by-adapter" as const,
          notes:
            "LinkedIn has a restricted partner Messages API. This adapter implements no message send method.",
        },
        {
          platform: "linkedin",
          operation: "webhooks.verify",
          availability: "approval-dependent" as const,
          requiredScopes: ["rw_organization_admin"],
          notes:
            "LinkedIn enables webhooks only for apps with an approved webhook use case. Organization social action notifications also need the Community Management API and an organization administrator. Verifies X-LI-Signature (HMAC-SHA256 over hmacsha256= plus the raw body) with the app client secret; answer the GET validation with answerLinkedInWebhookChallenge.",
        },
        {
          platform: "linkedin",
          operation: "notifications.read",
          availability: options.auth.author.startsWith("urn:li:organization:")
            ? ("available" as const)
            : ("account-ineligible" as const),
          requiredScopes: ["rw_organization_admin"],
          notes:
            "Organization social-action notifications from the last 60 days, pulled with offset paging; native listOrganizationNotifications adds action, sourcePost and timeRange filters. Requires the Community Management API product and organization administrator access. LinkedIn has no member notification API.",
        },
        {
          platform: "linkedin",
          operation: "notifications.seen",
          availability: "unsupported-by-platform" as const,
          notes: "LinkedIn does not expose a seen or read state for notifications.",
        },
        {
          platform: "linkedin",
          operation: "analytics.account.read",
          availability: "available" as const,
          requiredScopes: options.auth.author.startsWith("urn:li:organization:")
            ? ["rw_organization_admin"]
            : ["r_member_profileAnalytics"],
          notes: options.auth.author.startsWith("urn:li:organization:")
            ? "Total followers for the configured organization from networkSizes with COMPANY_FOLLOWED_BY_MEMBER. The provider documents this count for any organization; SDK author binding still applies."
            : "Lifetime follower count for the configured member from memberFollowersCount (q=me). Requires the Community Management r_member_profileAnalytics scope.",
        },
        {
          platform: "linkedin",
          operation: "analytics.member.posts.read",
          availability: options.auth.author.startsWith("urn:li:person:")
            ? ("available" as const)
            : ("account-ineligible" as const),
          requiredScopes: ["r_member_postAnalytics"],
          notes:
            "Native getMemberPostAnalytics (memberCreatorPostAnalytics) and getMemberVideoAnalytics (memberCreatorVideoAnalytics) for the configured member. Organization accounts are not eligible.",
        },
        {
          platform: "linkedin",
          operation: "analytics.member.followers.read",
          availability: options.auth.author.startsWith("urn:li:person:")
            ? ("available" as const)
            : ("account-ineligible" as const),
          requiredScopes: ["r_member_profileAnalytics"],
          notes:
            "Native getMemberFollowerCount reads memberFollowersCount, lifetime or daily within a dateRange.",
        },
        ...(
          [
            [
              "analytics.brand.read",
              "Native getBrandPageStatistics reads brandPageStatistics for the configured organization as a showcase page.",
            ],
            [
              "analytics.shares.posts.read",
              "Native getOrganizationPostStatistics reads lifetime share statistics for specific posts with shares=List(...) and ugcPosts=List(...).",
            ],
            [
              "organizations.roles.read",
              "Native listOrganizationRoles uses the organizationAcls organization finder for the configured organization.",
            ],
          ] as const
        ).map(([operation, notes]) => ({
          platform: "linkedin" as const,
          operation,
          availability: options.auth.author.startsWith("urn:li:organization:")
            ? ("available" as const)
            : ("account-ineligible" as const),
          requiredScopes: ["rw_organization_admin"],
          notes: `${notes} Requires an ADMINISTRATOR role.`,
        })),
        {
          platform: "linkedin",
          operation: "organizations.read",
          availability: "available" as const,
          requiredScopes: ["rw_organization_admin"],
          notes:
            "Native lookupOrganizations (organizationsLookup), findOrganizationByVanityName (q=vanityName) and listOrganizationBrands (q=parentOrganization). Lookups return non-admin fields; brand discovery returns only brands the member administers.",
        },
        ...(
          [
            [
              "social.batch.read",
              "r",
              "Native getSocialMetadataBatch (socialMetadata?ids=List), getSocialActionsBatch (socialActions?ids=List) and getComments (comments?ids=List) read up to 100 posts or comments per request.",
            ],
            [
              "reactions.get",
              "r",
              "Native getReaction reads one reaction by (actor, entity) and returns undefined on 404; getReactions batch gets up to 100 keys.",
            ],
          ] as const
        ).map(([operation, access, notes]) => ({
          platform: "linkedin" as const,
          operation,
          availability: "available" as const,
          requiredScopes: [
            `${access}_${options.auth.author.startsWith("urn:li:organization:") ? "organization" : "member"}_social_feed`,
          ],
          notes: `${notes} LinkedIn restricts member r_member_social_feed to select developers.`,
        })),
        {
          platform: "linkedin",
          operation: "media.read.batch",
          availability: "available" as const,
          formats: ["image" as const, "video" as const, "document" as const],
          notes:
            "Native mediaStatuses reads up to 100 of the author's images, videos and documents with one images?ids=List, videos?ids=List or documents?ids=List request per type. Scopes match media.read.",
        },
        ...(
          [
            [
              "events.write",
              "rw_events",
              "Native createEvent (POST /rest/events), updateEvent (partial update while upcoming), uploadEventBackgroundImage (assets registerUpload) and createEventPost (content.reference). Delete an event by deleting its ugcPost with deletePost.",
            ],
            [
              "events.read",
              "r_events",
              "Native getEvent and listEvents (q=eventsByOrganizer with excludeCancelled, timeBasedFilter, entryCriteria and sortOrder). Events are readable only after they are posted.",
            ],
          ] as const
        ).map(([operation, scope, notes]) => ({
          platform: "linkedin" as const,
          operation,
          availability: "approval-dependent" as const,
          requiredScopes: [scope],
          notes: `${notes} LinkedIn grants the Events API separately from the Marketing API program; organization organizers need an ADMINISTRATOR or CONTENT_ADMINISTRATOR role.`,
        })),
        {
          platform: "linkedin",
          operation: "analytics.video.read",
          availability: options.auth.author.startsWith("urn:li:organization:")
            ? ("available" as const)
            : ("account-ineligible" as const),
          requiredScopes: ["r_organization_social"],
          notes:
            "Native getOrganizationVideoAnalytics reads videoAnalytics (VIDEO_VIEW, VIEWER, TIME_WATCHED, TIME_WATCHED_FOR_VIDEO_VIEWS) for one ugcPost video with DAY, WEEK or ALL aggregation and an optional timeRange. Member accounts use getMemberVideoAnalytics.",
        },
        {
          platform: "linkedin",
          operation: "organizations.authorizations.read",
          availability: "available" as const,
          requiredScopes: ["rw_organization_admin"],
          notes:
            "Native getOrganizationAuthorization, getOrganizationAuthorizations (BATCH_GET) and findOrganizationAuthorizations (bq=authorizationActionsAndImpersonator) ask LinkedIn whether a member may take an action, such as ORGANIC_SHARE_CREATE or UPDATE_ANALYTICS_READ, for an organization.",
        },
        {
          platform: "linkedin",
          operation: "profile.read",
          availability: "approval-dependent" as const,
          requiredScopes: ["r_liteprofile"],
          notes:
            "Native getProfile (GET /v2/me, member authors only) and getPeople (GET /v2/people/(id:...) or /v2/people?ids=List(...), up to 50) with optional projections. LinkedIn restricts the Profile API to approved developers; r_basicprofile adds headline and vanityName. Store other members' profile data only as LinkedIn's terms allow.",
        },
        {
          platform: "linkedin",
          operation: "mentions.resolve",
          availability: options.auth.author.startsWith("urn:li:organization:")
            ? ("approval-dependent" as const)
            : ("account-ineligible" as const),
          requiredScopes: ["r_organization_followers"],
          notes:
            "Native resolveMemberVanityUrl maps a follower's profile URL to a person URN with vanityUrl q=vanityUrlAsOrganization. LinkedIn restricts the People Typeahead endpoints to select developers; keyword search (peopleTypeahead) is not implemented.",
        },
        ...["analytics.followers.read", "analytics.page.read", "analytics.shares.read"].map(
          (operation) => ({
            platform: "linkedin" as const,
            operation,
            availability: options.auth.author.startsWith("urn:li:organization:")
              ? ("available" as const)
              : ("account-ineligible" as const),
            requiredScopes: ["rw_organization_admin"],
            notes:
              "Community Management API product and organization administrator access are required. Member accounts are not eligible.",
          }),
        ),
        {
          platform: "linkedin",
          operation: "posts.list",
          availability: "available" as const,
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "r_organization_social"
              : "r_member_social",
          ],
          notes: "Author-feed pagination uses the returned offset cursor.",
        },
        {
          platform: "linkedin",
          operation: "media.upload",
          availability: "available" as const,
          formats: ["image" as const, "video" as const, "document" as const],
        },
        {
          platform: "linkedin",
          operation: "media.read",
          availability: "available" as const,
          formats: ["image" as const, "video" as const, "document" as const],
          notes:
            "Reads the configured author's uploaded media status through native helpers. Scopes vary by API and cannot be expressed as one required-scopes list. Videos: w_member_social or w_organization_social for the configured author (ads permissions are also documented). Images: rw_ads, w_organization_social, or w_power_creators; w_member_social alone cannot GET versioned images. Documents: the API lists w_member_social, r_member_social, w_organization_social, r_organization_social, rw_ads, and r_ads, without a GET-specific scope mapping. Provider ownership and organization role checks still apply.",
        },
        ...["comments.read", "comments.write", "analytics.read"].map((operation) => ({
          platform: "linkedin" as const,
          operation,
          availability: "available" as const,
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? operation === "comments.write"
                ? "w_organization_social_feed"
                : "r_organization_social_feed"
              : operation === "comments.write"
                ? "w_member_social_feed"
                : "r_member_social_feed",
            options.auth.author.startsWith("urn:li:organization:")
              ? "r_organization_social"
              : "r_member_social",
            ...(operation === "comments.write"
              ? [
                  options.auth.author.startsWith("urn:li:organization:")
                    ? "r_organization_social_feed"
                    : "r_member_social_feed",
                ]
              : []),
          ],
          notes:
            "Community Management product permissions and author post read access required. Member r_member_social is a closed grant unavailable to new apps. Analytics contains returned social-action counts only.",
        })),
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
    media: {
      upload: (
        media: MediaAttachment,
        account: ConnectedAccountRef,
        context: AdapterOperationContext,
      ) =>
        media.kind === "video"
          ? uploadVideo(media, account, context)
          : media.kind === "document"
            ? uploadDocument(media, account, context)
            : uploadImage(media, account, context),
    },
    posts: {
      prepareTarget(target: PreparedPublishTarget) {
        const issues: { code: string; message: string; severity: "error"; targetIndex: number }[] =
          [];

        const fail = (code: string, message: string) =>
          issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

        if (
          target.account.platform !== "linkedin" ||
          target.account.accountId !== options.auth.author
        )
          fail("linkedin.author", "Select the configured member or organization author URN.");

        if ((target.content.text?.length ?? 0) > 3000)
          fail("linkedin.text", "LinkedIn commentary exceeds 3,000 characters.");

        if (target.schedule || target.replyTo)
          fail(
            "linkedin.operation",
            "Scheduling and reply posts are not supported by this publishing slice.",
          );

        const link = target.content.link;

        if (link !== undefined) {
          let url: URL;

          try {
            url = new URL(link.url);
          } catch {
            fail("linkedin.article_url", "LinkedIn article source must be a valid HTTPS URL.");
            url = new URL("https://invalid.example");
          }

          if (url.protocol !== "https:")
            fail("linkedin.article_url", "LinkedIn article source must be a valid HTTPS URL.");

          if (!link.title?.trim() || !link.description?.trim())
            fail(
              "linkedin.article_metadata",
              "LinkedIn article posts require a non-empty title and description.",
            );

          if ((link.title?.trim().length ?? 0) >= 400)
            fail("linkedin.article_title", "LinkedIn article titles must be under 400 characters.");

          if ((link.description?.trim().length ?? 0) >= 4086)
            fail(
              "linkedin.article_description",
              "LinkedIn article descriptions must be under 4,086 characters.",
            );

          if (target.content.media?.length)
            fail("linkedin.article_media", "LinkedIn article posts cannot include media.");
        }

        for (const [code, message] of publishSettings(target).issues) fail(code, message);

        const media = target.content.media ?? [];

        for (const [code, message] of documentIssues(target)) fail(code, message);

        // A MultiImage post takes 2 to 20 images; alt text is at most 4,086 characters.
        // A video post carries exactly one video and cannot be mixed with images.
        if (media.length > 20)
          fail(
            "linkedin.media_count",
            "LinkedIn accepts one image, one video, or a multi-image post of 2 to 20 images.",
          );

        if (media.length > 1 && media.some((item) => item.kind === "video"))
          fail(
            "linkedin.media_count",
            "A LinkedIn video post carries exactly one video and cannot be combined with other media.",
          );

        for (const item of media) {
          if (item.kind === "image" && (item.altText?.length ?? 0) > 4086)
            fail("linkedin.alt_text", "LinkedIn image alt text exceeds 4,086 characters.");

          if (item.kind === "document") continue;

          if ((item.kind !== "image" && item.kind !== "video") || item.source.kind !== "media-ref")
            fail(
              "linkedin.media",
              "Upload an image or video first with media.upload, then publish its account-bound reference.",
            );
          else if (
            item.source.ref.backend !== target.account.backend ||
            item.source.ref.accountId !== target.account.accountId ||
            item.source.ref.platform !== "linkedin" ||
            !(item.kind === "video" ? linkedInVideoUrn : linkedInImageUrn).test(
              item.source.ref.mediaId,
            )
          )
            fail(
              "linkedin.media_owner",
              "Media reference belongs to another author/backend or has an invalid URN for its kind.",
            );
          else if (item.kind === "video" && item.altText !== undefined)
            fail("linkedin.video_alt_text", "LinkedIn video posts do not accept alt text.");
        }

        return issues;
      },
      async publishTarget(target: PreparedPublishTarget, context: AdapterOperationContext) {
        authorize(target.account, context);
        const media = target.content.media ?? [];
        const entries: JsonObject[] = [];

        for (const item of media) {
          // Documents are read and validated by documentContent below.
          if (item.kind === "document" || item.source.kind !== "media-ref") continue;
          authorize(item.source.ref, context);

          const video = item.kind === "video";
          let image: JsonObject | undefined;

          try {
            image = object(
              await request(
                `/rest/${video ? "videos" : "images"}/${encodeURIComponent(item.source.ref.mediaId)}`,
                context,
              ),
            );
          } catch (error) {
            // Only image reads keep the member-token 403 exception. A video must prove AVAILABLE.
            if (
              video ||
              !(error instanceof SocialError) ||
              error.code !== "missing_permission" ||
              !options.auth.author.startsWith("urn:li:person:")
            )
              throw error;
          }

          if (image?.["owner"] !== undefined && image["owner"] !== target.account.accountId)
            throw new SocialError({
              code: "unauthorized",
              operation: "posts.publish",
              message: `LinkedIn ${video ? "video" : "image"} belongs to a different author.`,
            });

          if (image?.["id"] !== undefined && image["id"] !== item.source.ref.mediaId)
            throw new SocialError({
              code: "media_error",
              operation: "posts.publish",
              message: `LinkedIn returned a different ${video ? "video" : "image"} than the one attached. No post was created.`,
            });

          if (video && image?.["status"] === "PROCESSING_FAILED")
            throw new SocialError({
              code: "media_error",
              operation: "posts.publish",
              message:
                "LinkedIn could not process this video. Upload it again; no post was created.",
              retryDisposition: { kind: "never" },
            });

          if (
            video &&
            (image?.["status"] === "PROCESSING" || image?.["status"] === "WAITING_UPLOAD")
          )
            // No post exists yet, so publishing again later is safe. The SDK does not retry.
            throw new SocialError({
              code: "media_error",
              operation: "posts.publish",
              message:
                "Video is still processing; no post was created. Wait with native waitForVideo or check videoStatus, then publish again with a new idempotency key.",
              retryDisposition: { kind: "after-delay", delayMs: linkedInVideoRetryDelayMs },
            });

          if (
            video
              ? image?.["status"] !== "AVAILABLE"
              : image?.["status"] !== undefined && image["status"] !== "AVAILABLE"
          )
            throw new SocialError({
              code: "media_error",
              operation: "posts.publish",
              message: video
                ? "Video is not AVAILABLE. Check it with native videoStatus before publishing."
                : "Image is not AVAILABLE. Check its status explicitly before publishing.",
            });
          // Posts API media.title is optional for video and required only for documents.
          const title = video ? item.caption?.trim() : undefined;
          entries.push({
            id: item.source.ref.mediaId,
            ...definedFields({
              title: title || undefined,
              altText: video ? undefined : item.altText || undefined,
            }),
          });
        }

        // MultiImage content takes 2 to 20 image URNs. Source (accessed 2026-09-24):
        // https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api?view=li-lms-2026-09
        // A single image or video uses content.media; a document post carries only its document.
        const document = media.find((item) => item.kind === "document");
        let content: JsonObject | undefined;

        const { settings, issues } = publishSettings(target);
        const rendered = renderCommentary(target.content.text ?? "", settings.annotations);

        if (issues[0] !== undefined || rendered.kind === "error")
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.publish",
            message: issues[0]?.[1] ?? (rendered.kind === "error" ? rendered.message : ""),
          });

        if (settings.articleThumbnail !== undefined) {
          authorize(settings.articleThumbnail, context);
          await assertImageUsable(settings.articleThumbnail.mediaId, target.account, context);
        }

        if (target.content.link !== undefined)
          content = {
            article: {
              source: target.content.link.url,
              ...definedFields({
                thumbnail: settings.articleThumbnail?.mediaId,
                title: target.content.link.title?.trim(),
                description: target.content.link.description?.trim(),
              }),
            },
          };
        else if (document) content = await documentContent(document, context);
        else if (entries.length > 1) content = { multiImage: { images: entries } };
        else if (entries[0] !== undefined) content = { media: entries[0] };

        const result = object(
          await request(
            "/rest/posts",
            context,
            {
              author: target.account.accountId,
              commentary: rendered.commentary,
              visibility: settings.visibility,
              distribution: {
                feedDistribution: "MAIN_FEED",
                targetEntities: [...settings.targetEntities],
                thirdPartyDistributionChannels: [],
              },
              lifecycleState: "PUBLISHED",
              isReshareDisabledByAuthor: settings.disableReshare,
              ...definedFields({ content }),
            },
            ["x-restli-id"],
          ),
        );

        const id = optionalString(object(result["headers"])["x-restli-id"]);

        const base = {
          account: target.account,
          targetIndex: target.targetIndex,
          observedAt: now(),
        };

        if (!id || !/^urn:li:(share|ugcPost):[0-9]+$/.test(id))
          return {
            ...base,
            state: "unknown" as const,
            reason: "unmapped-state" as const,
            diagnostic:
              "LinkedIn accepted the create request without a valid native post identifier. Do not repeat it automatically.",
          };

        return {
          ...base,
          state: "published" as const,
          post: {
            kind: "platform-post" as const,
            version: 1 as const,
            backend: target.account.backend,
            platform: "linkedin",
            accountId: target.account.accountId,
            postId: id,
          },
        };
      },
      async get(ref: PlatformPostRef, context: AdapterOperationContext) {
        return postRecord(await readPost(ref, context));
      },
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        authorize(account, context);

        const start = input.cursor === undefined ? 0 : Number(input.cursor);

        const count = input.limit ?? 25;

        if (
          !Number.isSafeInteger(start) ||
          start < 0 ||
          input.cursor === "" ||
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > 100
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.read",
            message: "LinkedIn requires a nonnegative offset and page size from 1 to 100.",
          });

        const result = object(
          await request(
            `/rest/posts?q=author&author=${encodeURIComponent(options.auth.author)}&start=${start}&count=${count}&sortBy=LAST_MODIFIED`,
            context,
          ),
        );

        const rows = array(result["elements"]).map(object);

        if (rows.some((row) => row["author"] !== options.auth.author))
          throw new SocialError({
            code: "unauthorized",
            operation: "posts.read",
            message: "LinkedIn returned a post from another author.",
          });

        const items = rows.map(postRecord);

        const paging = result["paging"] === undefined ? {} : object(result["paging"]);

        const total = optionalNumber(paging["total"]);

        const hasNext = array(paging["links"] ?? []).some((link) => object(link)["rel"] === "next");

        const nextCursor =
          items.length > 0 && (hasNext || (total !== undefined && start + items.length < total))
            ? String(start + items.length)
            : undefined;

        return { items, ...definedFields({ nextCursor }) };
      },
      async removeFromPlatform(ref: PlatformPostRef, context: AdapterOperationContext) {
        authorize(ref, context);

        await request(
          `/rest/posts/${encodeURIComponent(ref.postId)}`,
          context,
          undefined,
          undefined,
          "DELETE",
        );
      },
    },
    comments: {
      async list(
        ref: PlatformPostRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        // Cursors are decimal offsets this adapter returned; reject "", "1e2", "0x10", and padding.
        if (input.cursor !== undefined && !/^(?:0|[1-9][0-9]{0,8})$/.test(input.cursor))
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.read",
            message: "Use a LinkedIn comment cursor returned by a previous page.",
          });

        await readPost(ref, context);

        const start = input.cursor === undefined ? 0 : Number(input.cursor);

        const count = input.limit ?? 25;

        if (
          !Number.isSafeInteger(start) ||
          start < 0 ||
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > 100
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.read",
            message:
              "LinkedIn comment pagination requires a returned offset and a page size from 1 to 100.",
          });

        let result: JsonObject;

        try {
          result = object(
            await request(
              `/rest/socialActions/${encodeURIComponent(ref.postId)}/comments?start=${start}&count=${count}`,
              context,
            ),
          );
        } catch (error) {
          // A collection 404 can also follow post deletion; verify it is still readable.
          if (
            error instanceof SocialError &&
            error.code === "not_found" &&
            error.upstreamStatus === 404
          ) {
            await readPost(ref, context);

            return { items: [] };
          }

          throw error;
        }

        const items = array(result["elements"]).map(commentRecord);

        const paging = result["paging"] === undefined ? {} : object(result["paging"]);

        const total = optionalNumber(paging["total"]);

        // An empty page cannot advance the offset, so it ends the walk even when total is larger.
        const next =
          total !== undefined && items.length > 0 && start + items.length < total
            ? String(start + items.length)
            : undefined;

        return { items, ...definedFields({ nextCursor: next }) };
      },
      async reply(
        ref: CommentRef,
        content: { text: string },
        context: AdapterOperationContext,
      ): Promise<CommentRef> {
        if (!content.text.trim() || content.text.length > 1250)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.write",
            message: "Provide a comment of 1 to 1,250 characters.",
          });

        await readCommentablePost({ ...ref, kind: "platform-post" }, context);

        const match = /^urn:li:comment:\((urn:li:(?:activity|share|ugcPost):\d+),(\d+)\)$/.exec(
          ref.commentId,
        );

        if (!match)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.write",
            message: "Use the complete commentUrn returned by LinkedIn comment reads.",
          });

        const parent = object(
          await request(
            `/rest/socialActions/${encodeURIComponent(ref.postId)}/comments/${match[2]}`,
            context,
          ),
        );

        if (parent["commentUrn"] !== ref.commentId)
          throw new SocialError({
            code: "unauthorized",
            operation: "comments.write",
            message: "Comment does not belong to the supplied post.",
          });

        const parentObject = optionalString(parent["object"]);

        if (parentObject !== undefined && parentObject !== ref.postId && parentObject !== match[1])
          throw new SocialError({
            code: "unauthorized",
            operation: "comments.write",
            message: "Comment parent object does not match the supplied post.",
          });

        const response = object(
          await request(
            `/rest/socialActions/${encodeURIComponent(ref.commentId)}/comments`,
            context,
            {
              actor: ref.accountId,
              message: { text: content.text },
              object: ref.postId,
              parentComment: ref.commentId,
            },
          ),
        );

        const commentId = optionalString(response["commentUrn"]);

        if (!commentId)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "comments.write",
            message:
              "LinkedIn accepted the comment without returning its composite URN. Reconcile before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return { ...ref, commentId };
      },
    },
    notifications: {
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        authorize(account, context);

        if (!account.accountId.startsWith("urn:li:organization:"))
          throw new SocialError({
            code: "unsupported_capability",
            operation: "notifications.read",
            message:
              "LinkedIn notifications are available for organization accounts only, not member accounts.",
          });

        return pullNotifications(account, input, context);
      },
      async markSeen(
        account: ConnectedAccountRef,
        _input: { readonly seenAt?: string },
        context: AdapterOperationContext,
      ): Promise<void> {
        authorize(account, context);
        throw new SocialError({
          code: "unsupported_capability",
          operation: "notifications.seen",
          message: "LinkedIn does not expose a seen state for organization notifications.",
        });
      },
    },
    analytics: {
      async getAccountMetrics(
        account: ConnectedAccountRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        authorize(account, context);

        if (options.auth.author.startsWith("urn:li:person:")) {
          const lifetime = (await memberFollowerCounts(undefined, context))[0];

          return lifetime === undefined
            ? []
            : normalizeMetrics([
                {
                  name: "followers",
                  value: lifetime.count,
                  unit: "count",
                  period: "lifetime",
                  fetchedAt: now(),
                  freshness: "unknown",
                  source: `linkedin:${options.apiVersion}:memberFollowersCount`,
                },
              ]);
        }

        const response = object(
          await request(
            `/rest/networkSizes/${encodeURIComponent(options.auth.author)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`,
            context,
          ),
        );

        const value = optionalNumber(response["firstDegreeSize"]);

        return value === undefined
          ? []
          : normalizeMetrics([
              {
                name: "followers",
                value,
                unit: "count",
                period: "lifetime",
                fetchedAt: now(),
                freshness: "unknown",
                source: `linkedin:${options.apiVersion}:networkSizes`,
              },
            ]);
      },
      async getPostMetrics(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        await readPost(ref, context);

        const result = object(
          await request(`/rest/socialActions/${encodeURIComponent(ref.postId)}`, context),
        );

        if (result["target"] !== undefined && result["target"] !== ref.postId)
          throw new SocialError({
            code: "unauthorized",
            operation: "analytics.read",
            message: "LinkedIn returned social actions for a different post.",
          });

        const metrics: MetricValue[] = [];

        for (const [summary, field, name] of [
          ["likesSummary", "totalLikes", "likes"],
          ["commentsSummary", "totalFirstLevelComments", "comments"],
        ] as const) {
          if (result[summary] === undefined) continue;

          const value = optionalNumber(object(result[summary])[field]);

          if (value !== undefined)
            metrics.push({
              name,
              value,
              unit: "count",
              period: "lifetime",
              fetchedAt: now(),
              freshness: "unknown",
              source: `linkedin:${options.apiVersion}:socialActions`,
            });
        }

        return normalizeMetrics(metrics);
      },
    },
    webhooks: directWebhooks(
      "linkedin",
      (input) => verifyLinkedInWebhook({ ...input, secret: options.webhookSecret ?? "" }),
      now,
    ),
    native: {
      async listAdministeredOrganizations({ account, cursor, limit, role, state, context }) {
        authorize(account, context);

        if (!account.accountId.startsWith("urn:li:person:"))
          throw new SocialError({
            code: "unauthorized",
            operation: "accounts.read",
            message:
              "LinkedIn administered organization lookup requires a member account reference.",
          });

        return listAdministeredOrganizations(
          definedFields({ cursor, limit, role, state }),
          context,
        );
      },
      async imageStatus(ref: MediaRef, context: AdapterOperationContext) {
        authorize(ref, context);

        const image = object(
          await request(`/rest/images/${encodeURIComponent(ref.mediaId)}`, context),
        );

        if (image["owner"] !== ref.accountId)
          throw new SocialError({
            code: "unauthorized",
            operation: "media.read",
            message: "LinkedIn image belongs to another author.",
          });

        return publicFields(image, ["id", "owner", "status"]);
      },
      videoStatus: readVideoStatus,
      async uploadVideo({ account, media, context, captions, templateName, linkbackContext }) {
        if (media.kind !== "video")
          throw new SocialError({
            code: "invalid_input",
            operation: "media.upload",
            message: "native uploadVideo takes a video attachment.",
          });

        return uploadVideo(
          media,
          account,
          context,
          definedFields({ captions, templateName, linkbackContext }),
        );
      },
      async waitForVideo(
        ref: MediaRef,
        context: AdapterOperationContext,
        waitOptions: LinkedInVideoWaitOptions = {},
      ) {
        const intervalMs = waitOptions.intervalMs ?? linkedInVideoWaitDefaults.intervalMs;
        const maxChecks = waitOptions.maxChecks ?? linkedInVideoWaitDefaults.maxChecks;

        if (
          !Number.isInteger(intervalMs) ||
          intervalMs < linkedInVideoWaitLimits.minIntervalMs ||
          intervalMs > linkedInVideoWaitLimits.maxIntervalMs ||
          !Number.isInteger(maxChecks) ||
          maxChecks < 1 ||
          maxChecks > linkedInVideoWaitLimits.maxChecks
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "media.read",
            message:
              "waitForVideo takes an integer intervalMs from 1,000 to 60,000 and maxChecks from 1 to 60.",
          });

        let status = await readVideoStatus(ref, context);

        for (let check = 1; check < maxChecks; check++) {
          if (status["status"] !== "PROCESSING" && status["status"] !== "WAITING_UPLOAD") break;

          // Leave room for the next read; return the pending status instead of timing out.
          if (context.signal?.aborted) throw videoWaitCancelled();

          if (intervalMs >= budgetLeft(context)) break;

          await videoWaitDelay(intervalMs, context);

          // A late timer can wake after the deadline; keep the last status instead of timing out.
          if (budgetLeft(context) <= 0) break;
          status = await readVideoStatus(ref, context);
        }

        return status;
      },
      async documentStatus(ref: MediaRef, context: AdapterOperationContext) {
        return publicFields(await readDocument(ref, context, "media.read"), [
          "id",
          "owner",
          "status",
        ]);
      },
      async mediaStatuses({ account, media, context }) {
        authorize(account, context);

        const refs = [...new Map(media.map((ref) => [ref.mediaId, ref])).values()];

        if (refs.length === 0 || refs.length > 100)
          throw new SocialError({
            code: "invalid_input",
            operation: "media.read",
            message: "Read the status of 1 to 100 uploaded media references.",
          });

        for (const ref of refs) authorize(ref, context);

        const images = refs.filter((ref) => linkedInImageUrn.test(ref.mediaId));
        const videos = refs.filter((ref) => linkedInVideoUrn.test(ref.mediaId));
        const documents = refs.filter((ref) => linkedInDocumentUrn.test(ref.mediaId));

        if (images.length + videos.length + documents.length !== refs.length)
          throw new SocialError({
            code: "invalid_input",
            operation: "media.read",
            message:
              "Use urn:li:image, urn:li:video or urn:li:document references from media.upload.",
          });

        const list = (group: readonly MediaRef[]) =>
          group.map((ref) => restliEncode(ref.mediaId)).join(",");

        // Images, Videos and Documents API batch gets (li-lms-2026-10), one request per type.
        const batches: (readonly [readonly MediaRef[], string])[] = [
          [images, `/rest/images?ids=List(${list(images)})`],
          [videos, `/rest/videos?ids=List(${list(videos)})`],
          [documents, `/rest/documents?ids=List(${list(documents)})`],
        ];

        const found: LinkedInMediaStatus[] = [];
        const errors: LinkedInBatchError[] = [];

        for (const [group, path] of batches) {
          if (group.length === 0) continue;

          const batch = batchRows(
            object(await request(path, context)),
            group.map((ref) => ref.mediaId),
          );

          errors.push(...batch.errors);

          for (const [mediaId, row] of batch.rows) {
            if (row["owner"] !== account.accountId || (row["id"] ?? mediaId) !== mediaId)
              throw new SocialError({
                code: "unauthorized",
                operation: "media.read",
                message: "LinkedIn returned media that belongs to another author.",
              });

            found.push({
              mediaId,
              owner: account.accountId,
              ...definedFields({
                status: optionalString(row["status"]),
                processingFailureReason: optionalString(row["processingFailureReason"]),
                duration: optionalNumber(row["duration"]),
              }),
            });
          }
        }

        return { media: found, errors };
      },
      async registerVideo({ account, context }) {
        authorize(account, context);

        throw new SocialError({
          code: "unsupported_capability",
          operation: "posts.video",
          message:
            "registerVideo is deprecated. Upload the video with media.upload and check it with videoStatus.",
        });
      },
      async createPoll({
        account,
        text,
        question = text,
        options: pollOptions,
        duration = "THREE_DAYS",
        context,
      }) {
        authorize(account, context);

        // Poll API (li-lms-2026-10): question up to 140 characters, 2 to 4 options of up to 30.
        if (
          !question.trim() ||
          question.length > 140 ||
          text.length > 3000 ||
          pollOptions.length < 2 ||
          pollOptions.length > 4 ||
          pollOptions.some((option) => !option.trim() || option.length > 30) ||
          !["ONE_DAY", "THREE_DAYS", "SEVEN_DAYS", "FOURTEEN_DAYS"].includes(duration)
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "polls.create",
            message:
              "A LinkedIn poll needs a question of 1 to 140 characters, 2 to 4 options of 1 to 30 characters, a documented duration, and commentary of at most 3,000 characters.",
          });

        const result = object(
          await request(
            "/rest/posts",
            context,
            {
              author: account.accountId,
              commentary: escapeCommentary(text),
              visibility: "PUBLIC",
              distribution: {
                feedDistribution: "MAIN_FEED",
                targetEntities: [],
                thirdPartyDistributionChannels: [],
              },
              lifecycleState: "PUBLISHED",
              isReshareDisabledByAuthor: false,
              content: {
                poll: {
                  question,
                  options: pollOptions.map((option) => ({ text: option })),
                  settings: { duration },
                },
              },
            },
            ["x-restli-id"],
          ),
        );

        const id = optionalString(object(result["headers"])["x-restli-id"]);

        return id === undefined ? result : { ...result, id };
      },
      async react({ account, postId, reaction, context }) {
        authorize(account, context);

        // Reactions API (li-lms-2026-10): MAYBE is deprecated and returns 400 on create.
        if (!isLinkedInReactionType(reaction))
          throw new SocialError({
            code: "invalid_input",
            operation: "reactions.write",
            message: `LinkedIn reactionType must be one of ${linkedInReactionTypes.join(", ")}.`,
          });

        await request(`/rest/reactions?actor=${encodeURIComponent(account.accountId)}`, context, {
          root: postId,
          reactionType: reaction,
        });
      },
      async reshare({ account, postId, text = "", context }) {
        authorize(account, context);

        if (text.length > 3000 || !/^urn:li:(?:share|ugcPost):\d+$/.test(postId))
          throw new SocialError({
            code: "invalid_input",
            operation: "reshares.write",
            message:
              "Reshare a urn:li:share or urn:li:ugcPost post with commentary of at most 3,000 characters.",
          });

        const result = object(
          await request(
            "/rest/posts",
            context,
            {
              author: account.accountId,
              commentary: escapeCommentary(text),
              visibility: "PUBLIC",
              distribution: {
                feedDistribution: "MAIN_FEED",
                targetEntities: [],
                thirdPartyDistributionChannels: [],
              },
              lifecycleState: "PUBLISHED",
              isReshareDisabledByAuthor: false,
              reshareContext: { parent: postId },
            },
            ["x-restli-id"],
          ),
        );

        const id = optionalString(object(result["headers"])["x-restli-id"]);

        return id === undefined ? result : { ...result, id };
      },
      async updatePost({ account, postId, body, changes, context }) {
        authorize(account, context);

        let patch: JsonObject;

        if (changes !== undefined) {
          const rendered =
            changes.text === undefined
              ? undefined
              : renderCommentary(changes.text, changes.annotations ?? []);

          const landingPage = changes.contentLandingPage;
          let landingPageValid = landingPage === undefined;

          try {
            landingPageValid ||= new URL(landingPage ?? "").protocol === "https:";
          } catch {
            landingPageValid = false;
          }

          if (
            rendered?.kind === "error" ||
            (changes.text?.length ?? 0) > 3000 ||
            (changes.annotations !== undefined && changes.text === undefined) ||
            !landingPageValid ||
            (changes.text === undefined &&
              changes.contentCallToActionLabel === undefined &&
              landingPage === undefined)
          )
            throw new SocialError({
              code: "invalid_input",
              operation: "posts.update",
              message:
                rendered?.kind === "error"
                  ? rendered.message
                  : "Provide text (at most 3,000 characters, with annotations only alongside text), a call-to-action label, or an HTTPS landing page.",
            });

          patch = {
            $set: {
              ...definedFields({
                commentary: rendered?.commentary,
                contentCallToActionLabel: changes.contentCallToActionLabel,
                contentLandingPage: landingPage,
              }),
            },
          };
        } else if (body !== undefined) patch = { $set: body };
        else
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.update",
            message: "Provide typed changes or a raw body.",
          });

        return object(
          await request(
            `/rest/posts/${encodeURIComponent(postId)}`,
            context,
            { patch },
            ["x-restli-id"],
            "POST",
            { "X-RestLi-Method": "PARTIAL_UPDATE" },
          ),
        );
      },
      async deletePost({ account, postId, context }) {
        authorize(account, context);

        await request(
          `/rest/posts/${encodeURIComponent(postId)}`,
          context,
          undefined,
          undefined,
          "DELETE",
        );
      },
      async deleteComment({ account, postId, commentId, context }) {
        // Source: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api#delete-a-comment
        // (li-lms-2026-09, page updated 2026-04-28, accessed 2026-09-24).
        authorize(account, context);

        const match = /^urn:li:comment:\(urn:li:(?:activity|share|ugcPost):\d+,(\d+)\)$/.exec(
          commentId,
        );

        if (!/^urn:li:(share|ugcPost):\d+$/.test(postId) || !match)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.delete",
            message:
              "Provide the share or ugcPost URN and the complete commentUrn returned by comment reads.",
          });

        const actor = options.auth.author.startsWith("urn:li:organization:")
          ? `?actor=${encodeURIComponent(options.auth.author)}`
          : "";

        await request(
          `/rest/socialActions/${encodeURIComponent(postId)}/comments/${match[1]}${actor}`,
          context,
          undefined,
          undefined,
          "DELETE",
        );
      },
      async organizationAnalytics({ account, query, context }) {
        authorize(account, context);

        if (!account.accountId.startsWith("urn:li:organization:"))
          throw new SocialError({
            code: "unsupported_capability",
            operation: "analytics.organization.read",
            message: "Organization analytics requires an organization author.",
          });

        const invalidQuery = () =>
          new SocialError({
            code: "invalid_input",
            operation: "analytics.organization.read",
            message:
              "Supported query fields are q=organizationalEntity, the configured organizationalEntity, and timeIntervals with DAY or MONTH and a timeRange start/end. Use typed statistics methods for other reports.",
          });

        let interval: LinkedInPageShareTimeInterval | undefined;

        if (query !== undefined) {
          if (
            Object.keys(query).some(
              (key) => !["q", "organizationalEntity", "timeIntervals"].includes(key),
            ) ||
            (query["q"] !== undefined && query["q"] !== "organizationalEntity") ||
            (query["organizationalEntity"] !== undefined &&
              query["organizationalEntity"] !== account.accountId)
          )
            throw invalidQuery();
          const intervals = query["timeIntervals"];

          if (intervals !== undefined) {
            if (
              !isJsonObject(intervals) ||
              Object.keys(intervals).some(
                (key) => !["timeGranularityType", "timeRange"].includes(key),
              )
            )
              throw invalidQuery();
            const granularity = intervals["timeGranularityType"];
            const range = intervals["timeRange"];

            if (
              (granularity !== "DAY" && granularity !== "MONTH") ||
              !isJsonObject(range) ||
              Object.keys(range).some((key) => !["start", "end"].includes(key))
            )
              throw invalidQuery();
            const start = optionalNumber(range["start"]);
            const end = optionalNumber(range["end"]);

            if (start === undefined || (range["end"] !== undefined && end === undefined))
              throw invalidQuery();
            interval = { granularity, start, ...definedFields({ end }) };
          }
        }

        return object(
          await request(
            statisticsPath(
              "/rest/organizationalEntityShareStatistics",
              "organizationalEntity",
              account,
              interval,
            ),
            context,
          ),
        );
      },
      async getOrganizationFollowerStatistics({ account, interval, context }) {
        organizationOnly(account, context, "analytics.followers.read");

        return parseFollowerStatistics(
          object(
            await request(
              statisticsPath(
                "/rest/organizationalEntityFollowerStatistics",
                "organizationalEntity",
                account,
                interval,
              ),
              context,
            ),
          ),
          interval?.granularity,
        );
      },
      async getOrganizationPageStatistics({ account, interval, context }) {
        organizationOnly(account, context, "analytics.page.read");

        return parsePageStatistics(
          object(
            await request(
              statisticsPath("/rest/organizationPageStatistics", "organization", account, interval),
              context,
            ),
          ),
          interval?.granularity,
        );
      },
      async getOrganizationShareStatistics({ account, interval, context }) {
        organizationOnly(account, context, "analytics.shares.read");

        return parseShareStatistics(
          object(
            await request(
              statisticsPath(
                "/rest/organizationalEntityShareStatistics",
                "organizationalEntity",
                account,
                interval,
              ),
              context,
            ),
          ),
          interval?.granularity,
        );
      },
      async getOrganizationFollowerCount({ account, context }) {
        organizationOnly(account, context, "analytics.account.read");

        const response = object(
          await request(
            `/rest/networkSizes/${encodeURIComponent(account.accountId)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`,
            context,
          ),
        );

        return optionalNumber(response["firstDegreeSize"]);
      },
      async listOrganizationRoles({ account, role, state, cursor, limit, context }) {
        organizationOnly(account, context, "organizations.roles.read");

        const { start, count } = offsetPage(
          definedFields({ cursor, limit }),
          "organizations.roles.read",
        );

        if (
          (role !== undefined && !isOrganizationRole(role)) ||
          (state !== undefined && !isRoleState(state))
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "organizations.roles.read",
            message: "Use a documented organization role and role state.",
          });

        const filters = `${role === undefined ? "" : `&role=${role}`}${state === undefined ? "" : `&state=${state}`}`;

        // Organization Access Control "Find Organization Access Control" (li-lms-2026-10).
        const result = object(
          await request(
            `/rest/organizationAcls?q=organization&organization=${restliEncode(account.accountId)}${filters}&start=${start}&count=${count}`,
            context,
          ),
        );

        const rows = array(result["elements"]).map(object);
        const items: LinkedInOrganizationRoleAssignment[] = [];

        for (const row of rows) {
          const organization =
            optionalString(row["organization"]) ?? optionalString(row["organizationTarget"]);

          const roleAssignee = optionalString(row["roleAssignee"]);
          const rowRole = row["role"];
          const rowState = row["state"];

          if (organization !== account.accountId)
            throw new SocialError({
              code: "unauthorized",
              operation: "organizations.roles.read",
              message: "LinkedIn returned a role for another organization.",
            });

          if (roleAssignee === undefined || !isOrganizationRole(rowRole) || !isRoleState(rowState))
            continue;
          items.push({
            organization: `urn:li:organization:${organization.slice(20)}`,
            roleAssignee,
            role: rowRole,
            state: rowState,
          });
        }

        return { items, ...definedFields({ nextCursor: nextOffset(result, start, rows.length) }) };
      },
      async lookupOrganizations({ account, organizations, context }) {
        authorize(account, context);

        const ids = [...new Set(organizations)].map((urn) =>
          /^urn:li:organization:[1-9][0-9]*$/.test(urn) ? urn.slice(20) : "",
        );

        if (ids.length === 0 || ids.length > 100 || ids.includes(""))
          throw new SocialError({
            code: "invalid_input",
            operation: "organizations.read",
            message: "Look up 1 to 100 numeric urn:li:organization URNs.",
          });

        // Organization Lookup "Batch Get Non-Administered Organizations" (li-lms-2026-10).
        const result = object(
          await request(`/rest/organizationsLookup?ids=List(${ids.join(",")})`, context),
        );

        const results = optionalObject(result["results"]) ?? {};
        const statuses = optionalObject(result["statuses"]) ?? {};
        const found: LinkedInOrganizationSummary[] = [];
        const errors: { organization: string; status?: number }[] = [];

        for (const id of ids) {
          const summary = decodeOrganizationSummary(results[id]);

          if (summary[0] !== undefined && summary[0].organization === `urn:li:organization:${id}`)
            found.push(summary[0]);
          else
            errors.push({
              organization: `urn:li:organization:${id}`,
              ...definedFields({ status: optionalNumber(statuses[id]) }),
            });
        }

        return { organizations: found, errors };
      },
      async findOrganizationByVanityName({ account, vanityName, context }) {
        authorize(account, context);

        if (!vanityName.trim() || vanityName.length > 100)
          throw new SocialError({
            code: "invalid_input",
            operation: "organizations.read",
            message: "Provide a vanity name of 1 to 100 characters.",
          });

        const result = object(
          await request(
            `/rest/organizations?q=vanityName&vanityName=${encodeURIComponent(vanityName.trim())}`,
            context,
          ),
        );

        return array(result["elements"]).flatMap(decodeOrganizationSummary);
      },
      async listOrganizationBrands({ account, parent, cursor, limit, context }) {
        authorize(account, context);

        const { start, count } = offsetPage(definedFields({ cursor, limit }), "organizations.read");

        if (!/^urn:li:organization:[1-9][0-9]*$/.test(parent))
          throw new SocialError({
            code: "invalid_input",
            operation: "organizations.read",
            message: "Provide the parent organization as a numeric urn:li:organization URN.",
          });

        // Organization Lookup "Find Administered Organization by Parent Organization".
        const result = object(
          await request(
            `/rest/organizations?q=parentOrganization&parent=${restliEncode(parent)}&start=${start}&count=${count}`,
            context,
          ),
        );

        const rows = array(result["elements"]);
        const items = rows.flatMap(decodeOrganizationSummary);

        return { items, ...definedFields({ nextCursor: nextOffset(result, start, rows.length) }) };
      },
      async getOrganizationPostStatistics({ account, postIds, context }) {
        organizationOnly(account, context, "analytics.shares.posts.read");

        const ids = [...new Set(postIds)];

        if (ids.length === 0 || ids.length > 100 || !ids.every((id) => linkedInPostUrn.test(id)))
          throw new SocialError({
            code: "invalid_input",
            operation: "analytics.shares.posts.read",
            message: "Request statistics for 1 to 100 urn:li:share or urn:li:ugcPost posts.",
          });

        const shares = ids.filter((id) => id.startsWith("urn:li:share:"));
        const ugcPosts = ids.filter((id) => id.startsWith("urn:li:ugcPost:"));
        // Share statistics for specific posts are lifetime only; timeIntervals is not supported.
        const filters = `${shares.length === 0 ? "" : `&shares=List(${shares.map(restliEncode).join(",")})`}${ugcPosts.length === 0 ? "" : `&ugcPosts=List(${ugcPosts.map(restliEncode).join(",")})`}`;

        const result = object(
          await request(
            `${statisticsPath("/rest/organizationalEntityShareStatistics", "organizationalEntity", account)}${filters}`,
            context,
          ),
        );

        return array(result["elements"]).flatMap((value) => {
          const row = object(value);
          const post = optionalString(row["share"]) ?? optionalString(row["ugcPost"]);

          if (row["organizationalEntity"] !== account.accountId)
            throw new SocialError({
              code: "unauthorized",
              operation: "analytics.shares.posts.read",
              message: "LinkedIn returned statistics for another organization.",
            });

          return post === undefined
            ? []
            : [{ post, metrics: numberMap(row["totalShareStatistics"]) }];
        });
      },
      async getBrandPageStatistics({ account, interval, context }) {
        organizationOnly(account, context, "analytics.brand.read");

        // brandPageStatistics takes urn:li:organizationBrand:{id}; brand URNs map to organizations.
        const brand = `urn:li:organizationBrand:${account.accountId.slice(20)}`;

        return parsePageStatistics(
          object(
            await request(
              statisticsPath("/rest/brandPageStatistics", "brand", account, interval, brand),
              context,
            ),
          ),
          interval?.granularity,
          "brand",
        );
      },
      async getMemberPostAnalytics({
        account,
        postId,
        metric,
        aggregation = "TOTAL",
        dateRange,
        context,
      }) {
        memberOnly(account, context, "analytics.member.posts.read");

        const newer = [
          "POST_SAVE",
          "POST_SEND",
          "LINK_CLICKS",
          "PREMIUM_CTA_CLICKS",
          "FOLLOWER_GAINED_FROM_CONTENT",
          "PROFILE_VIEW_FROM_CONTENT",
        ];

        const noDaily = [
          "MEMBERS_REACHED",
          "LINK_CLICKS",
          "FOLLOWER_GAINED_FROM_CONTENT",
          "PROFILE_VIEW_FROM_CONTENT",
        ];

        if (
          !["IMPRESSION", "MEMBERS_REACHED", "RESHARE", "REACTION", "COMMENT", ...newer].includes(
            metric,
          ) ||
          (aggregation !== "TOTAL" && aggregation !== "DAILY") ||
          (aggregation === "DAILY" && noDaily.includes(metric)) ||
          (newer.includes(metric) && options.apiVersion < "202604")
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "analytics.member.posts.read",
            message:
              "Use a documented member post metric (newer metrics need version 202604 or later) with TOTAL or DAILY aggregation; DAILY is not supported for MEMBERS_REACHED, LINK_CLICKS, FOLLOWER_GAINED_FROM_CONTENT or PROFILE_VIEW_FROM_CONTENT.",
          });

        const finder =
          postId === undefined
            ? "q=me"
            : `q=entity&entity=${memberAnalyticsEntity(postId, "analytics.member.posts.read")}`;

        const range =
          dateRange === undefined
            ? ""
            : `&dateRange=${dateRangeParam(dateRange, "analytics.member.posts.read")}`;

        return memberAnalyticsPoints(
          object(
            await request(
              `/rest/memberCreatorPostAnalytics?${finder}&queryType=${metric}&aggregation=${aggregation}${range}`,
              context,
            ),
          ),
        );
      },
      async getMemberVideoAnalytics({
        account,
        postId,
        metric,
        aggregation = "TOTAL",
        dateRange,
        context,
      }) {
        memberOnly(account, context, "analytics.member.posts.read");

        // VIDEO_VIEWER and VIDEO_WATCH_TIME support neither daily aggregation nor time bounds.
        if (
          !["VIDEO_PLAY", "VIDEO_VIEWER", "VIDEO_WATCH_TIME"].includes(metric) ||
          (aggregation !== "TOTAL" && aggregation !== "DAILY") ||
          (metric !== "VIDEO_PLAY" && (aggregation === "DAILY" || dateRange !== undefined))
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "analytics.member.posts.read",
            message:
              "Use VIDEO_PLAY, VIDEO_VIEWER or VIDEO_WATCH_TIME; only VIDEO_PLAY supports DAILY aggregation or a dateRange.",
          });

        const range =
          dateRange === undefined
            ? ""
            : `&dateRange=${dateRangeParam(dateRange, "analytics.member.posts.read")}`;

        return memberAnalyticsPoints(
          object(
            await request(
              `/rest/memberCreatorVideoAnalytics?q=entity&entity=${memberAnalyticsEntity(postId, "analytics.member.posts.read")}&queryType=${metric}&aggregation=${aggregation}${range}`,
              context,
            ),
          ),
        );
      },
      async getMemberFollowerCount({ account, dateRange, context }) {
        memberOnly(account, context, "analytics.member.followers.read");

        return memberFollowerCounts(dateRange, context);
      },
      async getPost({ account, postId, viewContext = "READER", context }) {
        authorize(account, context);

        if (!linkedInPostUrn.test(postId) || (viewContext !== "READER" && viewContext !== "AUTHOR"))
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.read",
            message:
              "Read a urn:li:share or urn:li:ugcPost post with viewContext READER or AUTHOR.",
          });

        const post = decodePost(
          object(
            await request(
              `/rest/posts/${encodeURIComponent(postId)}?viewContext=${viewContext}`,
              context,
            ),
          ),
        );

        if (post.author !== account.accountId || post.id !== postId)
          throw new SocialError({
            code: "unauthorized",
            operation: "posts.read",
            message: "LinkedIn returned a post from another author or a different post.",
          });

        return post;
      },
      async getPosts({ account, postIds, viewContext = "READER", context }) {
        authorize(account, context);

        const ids = [...new Set(postIds)];

        if (
          ids.length === 0 ||
          ids.length > 100 ||
          !ids.every((id) => linkedInPostUrn.test(id)) ||
          (viewContext !== "READER" && viewContext !== "AUTHOR")
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.read",
            message:
              "Batch get 1 to 100 urn:li:share or urn:li:ugcPost posts with viewContext READER or AUTHOR.",
          });

        // Posts API BATCH_GET (li-lms-2026-10): ids=List(...) with X-RestLi-Method BATCH_GET.
        const result = object(
          await request(
            `/rest/posts?ids=List(${ids.map(restliEncode).join(",")})&viewContext=${viewContext}`,
            context,
            undefined,
            undefined,
            "GET",
            { "X-RestLi-Method": "BATCH_GET" },
          ),
        );

        const results = optionalObject(result["results"]) ?? {};
        const statuses = optionalObject(result["statuses"]) ?? {};
        const failures = optionalObject(result["errors"]) ?? {};
        const posts: LinkedInPost[] = [];
        const errors: { postId: string; status?: number }[] = [];

        for (const id of ids) {
          const row = optionalObject(results[id]);

          if (row === undefined) {
            const status =
              optionalNumber(statuses[id]) ??
              optionalNumber(optionalObject(failures[id])?.["status"]);

            errors.push({ postId: id, ...definedFields({ status }) });
            continue;
          }

          const post = decodePost(row);

          if (post.author !== account.accountId)
            throw new SocialError({
              code: "unauthorized",
              operation: "posts.read",
              message: "LinkedIn returned a post from another author.",
            });
          posts.push(post);
        }

        return { posts, errors };
      },
      async getSocialMetadata({ account, entity, context }) {
        authorize(account, context);

        if (!linkedInPostUrn.test(entity) && !linkedInCommentUrn.test(entity))
          throw new SocialError({
            code: "invalid_input",
            operation: "social-metadata.read",
            message: "Read social metadata for a share, ugcPost or comment URN.",
          });

        // Social Metadata API (li-lms-2026-10): reactionSummaries keyed by type, commentSummary.
        return decodeSocialMetadata(
          object(await request(`/rest/socialMetadata/${restliEncode(entity)}`, context)),
        );
      },
      async getSocialMetadataBatch({ account, entities, context }) {
        authorize(account, context);

        const ids = socialBatchIds(entities, "social-metadata.read");

        // Social Metadata API "Batch Get a Summary of Social Metadata" (li-lms-2026-10).
        const result = object(
          await request(
            `/rest/socialMetadata?ids=List(${ids.map(restliEncode).join(",")})`,
            context,
          ),
        );

        const { rows, errors } = batchRows(result, ids);
        const results: Record<string, LinkedInSocialMetadata> = {};

        for (const [id, row] of rows) results[id] = decodeSocialMetadata(row);

        return { results, errors };
      },
      async getSocialActionsBatch({ account, entities, context }) {
        authorize(account, context);

        const ids = socialBatchIds(entities, "social-metadata.read");

        // Social Actions API "Batch_GET Summary of Social Actions" (li-lms-2026-10).
        const result = object(
          await request(
            `/rest/socialActions?ids=List(${ids.map(restliEncode).join(",")})`,
            context,
          ),
        );

        const { rows, errors } = batchRows(result, ids);
        const results: Record<string, LinkedInSocialActionsSummary> = {};

        for (const [id, row] of rows) {
          const likes = optionalObject(row["likesSummary"]);
          const comments = optionalObject(row["commentsSummary"]);

          results[id] = definedFields({
            target: optionalString(row["target"]),
            likes:
              likes === undefined
                ? undefined
                : definedFields({
                    total: optionalNumber(likes["totalLikes"]),
                    aggregatedTotal: optionalNumber(likes["aggregatedTotalLikes"]),
                    likedByCurrentUser: optionalBoolean(likes["likedByCurrentUser"]),
                  }),
            comments:
              comments === undefined
                ? undefined
                : definedFields({
                    firstLevel: optionalNumber(comments["totalFirstLevelComments"]),
                    aggregatedTotal: optionalNumber(comments["aggregatedTotalComments"]),
                    state: optionalString(comments["commentsState"]),
                  }),
          });
        }

        return { results, errors };
      },
      async getComments({ account, target, commentIds, context }) {
        authorize(account, context);

        const urns = [...new Set(commentIds)];

        const numeric = urns.map((urn) => linkedInCommentUrn.exec(urn)?.[2] ?? "");

        if (
          (!linkedInPostUrn.test(target) && !linkedInCommentUrn.test(target)) ||
          urns.length === 0 ||
          urns.length > 100 ||
          numeric.includes("")
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.read",
            message:
              "Batch read 1 to 100 complete commentUrns on a share, ugcPost or comment target.",
          });

        // Comments API "Batch Get Comments" (li-lms-2026-10): results are keyed by comment ID.
        const result = object(
          await request(
            `/rest/socialActions/${restliEncode(target)}/comments?ids=List(${numeric.join(",")})`,
            context,
          ),
        );

        const idOf = new Map(urns.map((urn, index) => [urn, numeric[index] ?? ""]));
        const { rows, errors } = batchRows(result, urns, (urn) => idOf.get(urn) ?? urn);

        const comments = rows.map(([urn, row]) => {
          if (row["commentUrn"] !== urn)
            throw new SocialError({
              code: "upstream_failure",
              operation: "comments.read",
              message: "LinkedIn returned a different comment than the requested commentUrn.",
            });

          return commentRecord(row);
        });

        return { comments, errors };
      },
      async getReaction({ account, entity, actor = options.auth.author, context }) {
        authorize(account, context);

        if (!isReactionKey({ actor, entity }))
          throw new SocialError({
            code: "invalid_input",
            operation: "reactions.read",
            message:
              "Read a reaction by a person or organization actor on a share, ugcPost or comment URN.",
          });

        // Reactions API "Get a Reaction" (li-lms-2026-10).
        try {
          return decodeReaction(
            object(await request(`/rest/reactions/${reactionKey({ actor, entity })}`, context)),
          );
        } catch (error) {
          if (error instanceof SocialError && error.code === "not_found") return undefined;

          throw error;
        }
      },
      async getReactions({ account, keys, context }) {
        authorize(account, context);

        const unique = [...new Map(keys.map((key) => [reactionKey(key), key])).values()];

        if (unique.length === 0 || unique.length > 100 || !unique.every(isReactionKey))
          throw new SocialError({
            code: "invalid_input",
            operation: "reactions.read",
            message:
              "Batch read 1 to 100 reactions keyed by a person or organization actor and a share, ugcPost or comment URN.",
          });

        // Reactions API "Batch Get a Collection of Reactions" (li-lms-2026-10).
        const result = object(
          await request(`/rest/reactions?ids=List(${unique.map(reactionKey).join(",")})`, context),
        );

        const byKey = new Map(unique.map((key) => [reactionKey(key), key]));
        const { rows, errors } = batchRows(result, [...byKey.keys()]);

        return {
          reactions: rows.flatMap(([id, row]) => {
            const key = byKey.get(id);

            return key === undefined ? [] : [{ ...key, reaction: decodeReaction(row) }];
          }),
          errors: errors.flatMap((error) => {
            const key = byKey.get(error.id);

            return key === undefined
              ? []
              : [{ ...key, ...definedFields({ status: error.status }) }];
          }),
        };
      },
      async resolveMemberVanityUrl({ account, vanityUrl, context }) {
        organizationOnly(account, context, "mentions.resolve");

        if (!/^https:\/\/www\.linkedin\.com\/in\/[^/?#\s]{1,100}\/?$/.test(vanityUrl))
          throw new SocialError({
            code: "invalid_input",
            operation: "mentions.resolve",
            message:
              "Provide a member profile URL of the form https://www.linkedin.com/in/{vanityName}.",
          });

        /*
         * People Typeahead API "Search by Vanity URL for Organization Page" (li-lms-2026-10,
         * accessed 2026-11-04): an exact match that returns { member } elements.
         * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-atmention-search-api?view=li-lms-2026-10
         */
        const result = object(
          await request(
            `/rest/vanityUrl?q=vanityUrlAsOrganization&vanityUrl=${encodeURIComponent(vanityUrl)}&organization=${encodeURIComponent(account.accountId)}`,
            context,
          ),
        );

        const member = optionalString(optionalObject(array(result["elements"])[0])?.["member"]);

        if (member === undefined) return undefined;

        if (!/^urn:li:person:[a-zA-Z0-9_-]+$/.test(member))
          throw new SocialError({
            code: "upstream_failure",
            operation: "mentions.resolve",
            message: "LinkedIn returned a vanity URL match that is not a person URN.",
          });

        return `urn:li:person:${member.slice("urn:li:person:".length)}`;
      },
      async getProfile({ account, projection, context }) {
        authorize(account, context);

        if (!account.accountId.startsWith("urn:li:person:"))
          throw new SocialError({
            code: "unsupported_capability",
            operation: "profile.read",
            message: "GET /v2/me returns the token's member; use it with a member author.",
          });

        const query = projectionQuery(projection, "profile.read");

        // Profile API "Retrieve Current Member's Profile" (accessed 2026-11-04).
        const profile = decodeProfile(
          object(await request(`/v2/me${query === "" ? "" : `?${query}`}`, context)),
        );

        if (profile.personUrn !== account.accountId)
          throw new SocialError({
            code: "unauthorized",
            operation: "profile.read",
            message: "The authenticated LinkedIn member differs from the configured author URN.",
          });

        return profile;
      },
      async getPeople({ account, people, projection, context }) {
        authorize(account, context);

        const urns = [...new Set(people)];
        const ids = urns.map((urn) => /^urn:li:person:([a-zA-Z0-9_-]+)$/.exec(urn)?.[1] ?? "");

        if (urns.length === 0 || urns.length > 50 || ids.includes(""))
          throw new SocialError({
            code: "invalid_input",
            operation: "profile.read",
            message: "Read 1 to 50 urn:li:person profiles.",
          });

        const query = projectionQuery(projection, "profile.read");
        const restli = { "X-Restli-Protocol-Version": "2.0.0" };

        // Profile API "Retrieve Other Member's Profile" (accessed 2026-11-04).
        if (urns.length === 1) {
          const single = `/v2/people/(id:${ids[0] ?? ""})${query === "" ? "" : `?${query}`}`;

          try {
            const profile = decodeProfile(
              object(await request(single, context, undefined, undefined, "GET", restli)),
            );

            if (profile.personUrn !== urns[0])
              throw new SocialError({
                code: "upstream_failure",
                operation: "profile.read",
                message: "LinkedIn returned a different member than the requested person URN.",
              });

            return { profiles: [profile], errors: [] };
          } catch (error) {
            if (error instanceof SocialError && error.code === "not_found")
              return { profiles: [], errors: [{ id: urns[0] ?? "", status: 404 }] };

            throw error;
          }
        }

        const result = object(
          await request(
            `/v2/people?ids=List(${ids.map((id) => `(id:${id})`).join(",")})${query === "" ? "" : `&${query}`}`,
            context,
            undefined,
            undefined,
            "GET",
            restli,
          ),
        );

        // LinkedIn shows no batch response sample; accept keys as (id:{id}) or the bare ID.
        const keyed = [
          optionalObject(result["results"]),
          optionalObject(result["statuses"]),
          optionalObject(result["errors"]),
        ];

        const { rows, errors } = batchRows(result, urns, (urn) => {
          const compound = `(id:${urn.slice("urn:li:person:".length)})`;

          return keyed.some((map) => map?.[compound] !== undefined)
            ? compound
            : urn.slice("urn:li:person:".length);
        });

        const profiles = rows.map(([urn, row]) => {
          const profile = decodeProfile(row);

          if (profile.personUrn !== urn)
            throw new SocialError({
              code: "upstream_failure",
              operation: "profile.read",
              message: "LinkedIn returned a different member than the requested person URN.",
            });

          return profile;
        });

        return { profiles, errors };
      },
      async getOrganizationAuthorization({ account, key, context }) {
        authorize(account, context);

        if (!isAuthorizationKey(key))
          throw new SocialError({
            code: "invalid_input",
            operation: "organizations.authorizations.read",
            message:
              "Provide a person impersonator, a numeric organization URN and a documented authorization action.",
          });

        // Organization Authorizations "Get Organization Authorization Information".
        return decodeAuthorization(
          await request(`/rest/organizationAuthorizations/${authorizationKey(key)}`, context),
        );
      },
      async getOrganizationAuthorizations({ account, keys, context }) {
        authorize(account, context);

        const unique = [...new Map(keys.map((key) => [authorizationKey(key), key])).values()];

        if (unique.length === 0 || unique.length > 100 || !unique.every(isAuthorizationKey))
          throw new SocialError({
            code: "invalid_input",
            operation: "organizations.authorizations.read",
            message:
              "Batch check 1 to 100 keys of a person impersonator, a numeric organization URN and a documented action.",
          });

        const result = object(
          await request(
            `/rest/organizationAuthorizations?ids=List(${unique.map(authorizationKey).join(",")})`,
            context,
          ),
        );

        // LinkedIn reorders the fields of result keys, so match on the decoded record instead.
        const authorizations = Object.values(optionalObject(result["results"]) ?? {}).map(
          decodeAuthorization,
        );

        const missing = unique.filter(
          (key) =>
            !authorizations.some(
              (entry) =>
                entry.impersonator === key.impersonator &&
                entry.organization === key.organization &&
                entry.actionType === key.action.actionType,
            ),
        );

        return { authorizations, missing };
      },
      async findOrganizationAuthorizations({ account, actions, context }) {
        authorize(account, context);

        if (actions.length === 0 || actions.length > 20 || !actions.every(isAuthorizationAction))
          throw new SocialError({
            code: "invalid_input",
            operation: "organizations.authorizations.read",
            message: "Find authorizations for 1 to 20 documented actions.",
          });

        // Organization Authorizations batch finder authorizationActionsAndImpersonator.
        const result = object(
          await request(
            `/rest/organizationAuthorizations?bq=authorizationActionsAndImpersonator&authorizationActions=List(${actions.map((action) => `(authorizationAction:${authorizationAction(action)})`).join(",")})`,
            context,
          ),
        );

        const groups = array(result["elements"]);

        if (groups.length !== actions.length)
          throw new SocialError({
            code: "upstream_failure",
            operation: "organizations.authorizations.read",
            message: "LinkedIn returned a different number of result lists than requested actions.",
          });

        return groups.map((group) =>
          (optionalArray(object(group)["elements"]) ?? []).map(decodeAuthorization),
        );
      },
      async getOrganizationVideoAnalytics({
        account,
        postId,
        metric,
        aggregation = "ALL",
        timeRange,
        cursor,
        limit,
        context,
      }) {
        organizationOnly(account, context, "analytics.video.read");

        const { start, count } = offsetPage(
          definedFields({ cursor, limit }),
          "analytics.video.read",
        );

        const bound = (value: number | undefined) =>
          value === undefined || (Number.isSafeInteger(value) && value >= 0);

        if (
          !/^urn:li:ugcPost:\d+$/.test(postId) ||
          !["VIDEO_VIEW", "VIEWER", "TIME_WATCHED", "TIME_WATCHED_FOR_VIDEO_VIEWS"].includes(
            metric,
          ) ||
          !["DAY", "WEEK", "ALL"].includes(aggregation) ||
          !bound(timeRange?.start) ||
          !bound(timeRange?.end) ||
          (timeRange?.start !== undefined &&
            timeRange.end !== undefined &&
            timeRange.start >= timeRange.end)
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "analytics.video.read",
            message:
              "Read video analytics for a urn:li:ugcPost post with a documented metric, DAY, WEEK or ALL aggregation, and an epoch-millisecond timeRange whose start is before its end.",
          });

        const range =
          timeRange === undefined
            ? ""
            : `&timeRange=(${[
                ...(timeRange.start === undefined ? [] : [`start:${timeRange.start}`]),
                ...(timeRange.end === undefined ? [] : [`end:${timeRange.end}`]),
              ].join(",")})`;

        // Video Analytics API (li-lms-2026-10, accessed 2026-11-04).
        const result = object(
          await request(
            `/rest/videoAnalytics?q=entity&entity=${restliEncode(postId)}&type=${metric}${range}&aggregation=${aggregation}&start=${start}&count=${count}`,
            context,
          ),
        );

        const items = array(result["elements"]).map((value): LinkedInVideoAnalyticsPoint => {
          const row = object(value);
          const returned = optionalObject(row["timeRange"]);
          const amount = optionalNumber(row["value"]);

          if (amount === undefined)
            throw new SocialError({
              code: "upstream_failure",
              operation: "analytics.video.read",
              message: "LinkedIn returned a video analytics element without a value.",
            });

          return {
            metric: optionalString(row["statisticsType"]) ?? optionalString(row["type"]) ?? metric,
            value: amount,
            ...definedFields({
              timeRange:
                returned === undefined
                  ? undefined
                  : definedFields({
                      start: optionalNumber(returned["start"]),
                      end: optionalNumber(returned["end"]),
                    }),
            }),
          };
        });

        return { items, ...definedFields({ nextCursor: nextOffset(result, start, items.length) }) };
      },
      async createEvent({
        account,
        name,
        description,
        type,
        startsAt,
        vanityName,
        backgroundImage,
        discoveryMode,
        leadGenForm,
        locale,
        context,
      }) {
        authorize(account, context);

        const key = eventLocale(locale);

        if (
          !name.trim() ||
          !eventInstant(startsAt) ||
          !eventInstant(type.endsAt) ||
          type.endsAt <= startsAt ||
          (description !== undefined && !description.trim()) ||
          (vanityName !== undefined && !/^[a-zA-Z0-9-]{1,100}$/.test(vanityName)) ||
          (backgroundImage !== undefined &&
            !/^urn:li:digitalmediaAsset:[a-zA-Z0-9_-]+$/.test(backgroundImage)) ||
          (discoveryMode !== undefined && !["LISTED", "URL_ONLY"].includes(discoveryMode)) ||
          (leadGenForm !== undefined &&
            ("privacyPolicyUrl" in leadGenForm
              ? !eventHttpsUrl(leadGenForm.privacyPolicyUrl)
              : !leadGenForm.leadGenForm.startsWith("urn:li:versionedLeadGenForm:")))
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "events.write",
            message:
              "An event needs a name, positive epoch-millisecond startsAt before endsAt, and valid optional vanityName, digitalmediaAsset background image, discoveryMode and lead form.",
          });

        /*
         * Events API "Create an Event" (li-lms-2026-10, accessed 2026-11-04). The organizer is the
         * configured author and cannot change later.
         * https://learn.microsoft.com/en-us/linkedin/marketing/event-management/events?view=li-lms-2026-10
         */
        const result = object(
          await request(
            "/rest/events",
            context,
            {
              name: multiLocale(name, key),
              type: eventTypeWire(type, key),
              organizer: account.accountId,
              startsAt,
              ...definedFields({
                description: description === undefined ? undefined : richText(description, key),
                vanityName,
                backgroundImage,
                discoveryMode,
                leadGenFormSpec:
                  leadGenForm === undefined
                    ? undefined
                    : "privacyPolicyUrl" in leadGenForm
                      ? { privacyPolicyUrl: leadGenForm.privacyPolicyUrl }
                      : { leadGenForm: leadGenForm.leadGenForm },
              }),
            },
            ["x-restli-id"],
            "POST",
            { "X-RestLi-Method": "CREATE" },
          ),
        );

        const header = optionalString(optionalObject(result["headers"])?.["x-restli-id"]);

        const fromHeader =
          header === undefined ? undefined : longId(header.replace(/^urn:li:event:/, ""));

        return decodeEvent(optionalObject(result["body"]) ?? {}, fromHeader);
      },
      async getEvent({ account, event, context }) {
        authorize(account, context);

        // Events API "Fetch an Event": readable only after the event is posted.
        const decoded = decodeEvent(object(await request(eventPath(event), context)));

        if (decoded.eventUrn !== event || decoded.organizer !== account.accountId)
          throw new SocialError({
            code: "unauthorized",
            operation: "events.read",
            message: "LinkedIn returned an event of another organizer or a different event.",
          });

        return decoded;
      },
      async updateEvent({ account, event, changes, locale, context }) {
        authorize(account, context);

        const key = eventLocale(locale);
        const path = eventPath(event);

        if (
          (changes.name !== undefined && !changes.name.trim()) ||
          (changes.description !== undefined && !changes.description.trim()) ||
          (changes.vanityName !== undefined && !/^[a-zA-Z0-9-]{1,100}$/.test(changes.vanityName)) ||
          !eventInstant(changes.startsAt) ||
          (changes.backgroundImage !== undefined &&
            !/^urn:li:digitalmediaAsset:[a-zA-Z0-9_-]+$/.test(changes.backgroundImage)) ||
          (changes.discoveryMode !== undefined &&
            !["LISTED", "URL_ONLY"].includes(changes.discoveryMode)) ||
          (changes.startsAt !== undefined &&
            changes.type?.endsAt !== undefined &&
            changes.type.endsAt <= changes.startsAt)
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "events.write",
            message:
              "Event changes need a non-empty name or description, a valid vanityName, positive epoch-millisecond times with startsAt before endsAt, and a digitalmediaAsset background image.",
          });

        const set = definedFields({
          name: changes.name === undefined ? undefined : multiLocale(changes.name, key),
          description:
            changes.description === undefined ? undefined : richText(changes.description, key),
          vanityName: changes.vanityName,
          startsAt: changes.startsAt,
          backgroundImage: changes.backgroundImage,
          discoveryMode: changes.discoveryMode,
          type: changes.type === undefined ? undefined : eventTypeWire(changes.type, key),
        });

        if (Object.keys(set).length === 0)
          throw new SocialError({
            code: "invalid_input",
            operation: "events.write",
            message: "Provide at least one event change.",
          });

        // Events API "Update an Event": partial_update with patch.$set.
        await request(path, context, { patch: { $set: set } }, undefined, "POST", {
          "X-RestLi-Method": "PARTIAL_UPDATE",
        });
      },
      async listEvents({
        account,
        excludeCancelled,
        timeBasedFilter,
        entryCriteria,
        sortOrder,
        cursor,
        limit,
        context,
      }) {
        authorize(account, context);

        const { start, count } = offsetPage(definedFields({ cursor, limit }), "events.read");

        const range = (
          value: { readonly start?: number; readonly end?: number },
          closed: boolean,
        ) => {
          if (
            !eventInstant(value.start) ||
            !eventInstant(value.end) ||
            (closed && (value.start === undefined || value.end === undefined)) ||
            (value.start !== undefined && value.end !== undefined && value.start > value.end)
          )
            return undefined;

          return [
            ...(value.start === undefined ? [] : [`start:${value.start}`]),
            ...(value.end === undefined ? [] : [`end:${value.end}`]),
          ].join(",");
        };

        let filter: string | undefined;

        if (timeBasedFilter !== undefined) {
          if ("lifeCycleState" in timeBasedFilter)
            filter = ["UPCOMING", "ONGOING", "PAST"].includes(timeBasedFilter.lifeCycleState)
              ? `(lifeCycleState:${timeBasedFilter.lifeCycleState})`
              : undefined;
          else if ("ongoingTimeRange" in timeBasedFilter) {
            const inner = range(timeBasedFilter.ongoingTimeRange, true);

            filter = inner === undefined ? undefined : `(ongoingTimeRange:(${inner}))`;
          } else {
            const inner = range(timeBasedFilter.startTimeRange, false);

            filter = inner === undefined ? undefined : `(startTimeRange:(${inner}))`;
          }
        }

        if (
          (timeBasedFilter !== undefined && filter === undefined) ||
          (entryCriteria !== undefined && !["PUBLIC", "GATED"].includes(entryCriteria)) ||
          (sortOrder !== undefined && !["START_TIME_ASC", "END_TIME_DESC"].includes(sortOrder))
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "events.read",
            message:
              "Use a documented timeBasedFilter (lifeCycleState, ongoingTimeRange or startTimeRange), entryCriteria PUBLIC or GATED, and sortOrder START_TIME_ASC or END_TIME_DESC.",
          });

        // Events API "Find Events by Organizer"; timeBasedFilter is sent unencoded as documented.
        const query = [
          "q=eventsByOrganizer",
          `organizer=${encodeURIComponent(account.accountId)}`,
          `start=${start}`,
          `count=${count}`,
          ...(excludeCancelled === undefined ? [] : [`excludeCancelled=${excludeCancelled}`]),
          ...(filter === undefined ? [] : [`timeBasedFilter=${filter}`]),
          ...(entryCriteria === undefined ? [] : [`entryCriteria=${entryCriteria}`]),
          ...(sortOrder === undefined ? [] : [`sortOrder=${sortOrder}`]),
        ].join("&");

        const result = object(await request(`/rest/events?${query}`, context));

        const items = array(result["elements"]).map((value) => {
          const decoded = decodeEvent(object(value));

          if (decoded.organizer !== undefined && decoded.organizer !== account.accountId)
            throw new SocialError({
              code: "unauthorized",
              operation: "events.read",
              message: "LinkedIn returned an event of another organizer.",
            });

          return decoded;
        });

        return { items, ...definedFields({ nextCursor: nextOffset(result, start, items.length) }) };
      },
      async uploadEventBackgroundImage({ account, image, mimeType, context }) {
        authorize(account, context);

        // LinkedIn documents no background image size; the SDK applies its 20 MiB image cap.
        const maxBytes = 20 * 1024 * 1024;

        if (
          !["image/jpeg", "image/png"].includes(mimeType) ||
          image.size === 0 ||
          image.size > maxBytes
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "events.write",
            message: "Provide a nonempty JPEG or PNG background image within the SDK's 20 MiB cap.",
          });

        // Events API "Create Background Image Asset": register, then upload synchronously.
        const registered = object(
          object(
            await request("/rest/assets?action=registerUpload", context, {
              registerUploadRequest: {
                owner: account.accountId,
                recipes: ["urn:li:digitalmediaRecipe:event-background-image"],
                serviceRelationships: [
                  { identifier: "urn:li:userGeneratedContent", relationshipType: "OWNER" },
                ],
                supportedUploadMechanism: ["SYNCHRONOUS_UPLOAD"],
              },
            }),
          )["value"],
        );

        const asset = string(registered["asset"]);

        const uploadUrl = string(
          object(
            object(registered["uploadMechanism"])[
              "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
            ],
          )["uploadUrl"],
        );

        if (!/^urn:li:digitalmediaAsset:[a-zA-Z0-9_-]+$/.test(asset))
          throw new SocialError({
            code: "media_error",
            operation: "events.write",
            message: "LinkedIn returned an invalid background image asset URN.",
          });

        try {
          await upload({
            url: uploadUrl,
            method: "POST",
            source: { mimeType, size: image.size, body: image, open: () => image.stream() },
            // The documented upload sends the bearer token, so only LinkedIn's API host is allowed.
            allowHost: (host) => host === "api.linkedin.com",
            headers: { Authorization: `Bearer ${options.auth.accessToken}` },
            maxBytes,
            timeoutMs: remainingBudget(context),
            ...definedFields({ fetch: options.fetch, signal: context.signal }),
          });
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;

          throw new SocialError({
            code:
              error.kind === "timeout"
                ? "timeout"
                : error.kind === "cancelled"
                  ? "cancelled"
                  : error.kind === "invalid-input"
                    ? "invalid_input"
                    : "media_error",
            operation: "events.write",
            message: `LinkedIn background image upload did not complete: ${error.message}`,
            upstreamStatus: error.status,
            retryDisposition: { kind: "never" },
          });
        }

        return `urn:li:digitalmediaAsset:${asset.slice("urn:li:digitalmediaAsset:".length)}`;
      },
      async createEventPost({ account, reference, text = "", context }) {
        authorize(account, context);

        if (
          (!linkedInEventUrn.test(reference) && !/^urn:li:liveVideo:\d+$/.test(reference)) ||
          text.length > 3000
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "events.post",
            message:
              "Post an event with its urn:li:event or urn:li:liveVideo reference and at most 3,000 characters of commentary.",
          });

        // Posts API ReferenceContent (Events API "Post an Event", li-lms-2026-10).
        const result = object(
          await request(
            "/rest/posts",
            context,
            {
              author: account.accountId,
              commentary: escapeCommentary(text),
              visibility: "PUBLIC",
              distribution: {
                feedDistribution: "MAIN_FEED",
                targetEntities: [],
                thirdPartyDistributionChannels: [],
              },
              content: { reference: { id: reference } },
              lifecycleState: "PUBLISHED",
              isReshareDisabledByAuthor: false,
            },
            ["x-restli-id"],
          ),
        );

        return definedFields({
          postId: optionalString(optionalObject(result["headers"])?.["x-restli-id"]),
        });
      },
      async setCommentsState({ account, postId, state, context }) {
        authorize(account, context);

        if (!linkedInPostUrn.test(postId) || (state !== "OPEN" && state !== "CLOSED"))
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.state.write",
            message: "Set commentsState OPEN or CLOSED on a urn:li:share or urn:li:ugcPost post.",
          });

        await request(
          `/rest/socialMetadata/${restliEncode(postId)}?actor=${restliEncode(account.accountId)}`,
          context,
          { patch: { $set: { commentsState: state } } },
          undefined,
          "POST",
          { "X-RestLi-Method": "PARTIAL_UPDATE" },
        );
      },
      async listReactions({
        account,
        entity,
        sort = "REVERSE_CHRONOLOGICAL",
        cursor,
        limit,
        context,
      }) {
        authorize(account, context);

        const { start, count } = offsetPage(definedFields({ cursor, limit }), "reactions.read");

        if (
          (!linkedInPostUrn.test(entity) && !linkedInCommentUrn.test(entity)) ||
          !["CHRONOLOGICAL", "REVERSE_CHRONOLOGICAL", "RELEVANCE"].includes(sort)
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "reactions.read",
            message:
              "List reactions on a share, ugcPost or comment URN, sorted CHRONOLOGICAL, REVERSE_CHRONOLOGICAL or RELEVANCE.",
          });

        const result = object(
          await request(
            `/rest/reactions/(entity:${restliEncode(entity)})?q=entity&sort=(value:${sort})&start=${start}&count=${count}`,
            context,
          ),
        );

        const items = array(result["elements"]).map((value) => decodeReaction(object(value)));

        return { items, ...definedFields({ nextCursor: nextOffset(result, start, items.length) }) };
      },
      async deleteReaction({ account, entity, context }) {
        authorize(account, context);

        if (!linkedInPostUrn.test(entity) && !linkedInCommentUrn.test(entity))
          throw new SocialError({
            code: "invalid_input",
            operation: "reactions.delete",
            message: "Delete a reaction on a share, ugcPost or comment URN.",
          });

        await request(
          `/rest/reactions/(actor:${restliEncode(account.accountId)},entity:${restliEncode(entity)})`,
          context,
          undefined,
          undefined,
          "DELETE",
        );
      },
      async listCommentReplies({ account, postId, commentId, cursor, limit, context }) {
        authorize(account, context);

        const { start, count } = offsetPage(definedFields({ cursor, limit }), "comments.read");
        const match = linkedInCommentUrn.exec(commentId);

        if (!linkedInPostUrn.test(postId) || !match)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.read",
            message:
              "Provide the share or ugcPost URN and the complete commentUrn returned by comment reads.",
          });

        const parent = object(
          await request(
            `/rest/socialActions/${encodeURIComponent(postId)}/comments/${match[2]}`,
            context,
          ),
        );

        if (parent["commentUrn"] !== commentId)
          throw new SocialError({
            code: "unauthorized",
            operation: "comments.read",
            message: "Comment does not belong to the supplied post.",
          });

        // Comments API "Get Comments on Comments": the parent commentUrn is the target.
        const result = object(
          await request(
            `/rest/socialActions/${encodeURIComponent(commentId)}/comments?start=${start}&count=${count}`,
            context,
          ),
        );

        const items = array(result["elements"]).map(commentRecord);

        return { items, ...definedFields({ nextCursor: nextOffset(result, start, items.length) }) };
      },
      async createComment({ account, postId, text, mentions, image, parentCommentId, context }) {
        authorize(account, context);

        const attributes = commentAttributes(text, mentions ?? [], "comments.write");

        if (
          !linkedInPostUrn.test(postId) ||
          (parentCommentId !== undefined && !linkedInCommentUrn.test(parentCommentId)) ||
          (image !== undefined && !linkedInImageUrn.test(image.mediaId))
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.write",
            message:
              "Comment on a urn:li:share or urn:li:ugcPost post, reply to a complete commentUrn, and attach only an urn:li:image reference.",
          });

        if (image !== undefined) {
          authorize(image, context);
          await assertImageUsable(image.mediaId, account, context);
        }

        const body = {
          actor: account.accountId,
          object: postId,
          message: { text, ...definedFields({ attributes }) },
          ...definedFields({
            parentComment: parentCommentId,
            content: image === undefined ? undefined : [{ entity: { image: image.mediaId } }],
          }),
        };

        const response = object(
          await request(
            parentCommentId === undefined
              ? `/rest/socialActions/${encodeURIComponent(postId)}/comments`
              : `/rest/socialActions/${encodeURIComponent(parentCommentId)}/comments`,
            context,
            body,
          ),
        );

        const commentUrn = optionalString(response["commentUrn"]);

        if (!commentUrn)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "comments.write",
            message:
              "LinkedIn accepted the comment without returning its composite URN. Reconcile before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return { commentUrn, ...definedFields({ id: optionalString(response["id"]) }) };
      },
      async listOrganizationNotifications({ account, context, ...filters }) {
        organizationOnly(account, context, "notifications.read");

        return pullNotifications(account, filters, context);
      },
      async subscribeOrganizationNotifications({
        account,
        developerApplication,
        member,
        webhook,
        context,
      }) {
        organizationOnly(account, context, "webhooks.subscriptions.write");

        let url: URL | undefined;

        try {
          url = new URL(webhook);
        } catch {
          url = undefined;
        }

        if (url?.protocol !== "https:")
          throw new SocialError({
            code: "invalid_input",
            operation: "webhooks.subscriptions.write",
            message: "The LinkedIn webhook must be an absolute HTTPS URL.",
          });

        await request(
          subscriptionPath(account, developerApplication, member),
          context,
          { webhook },
          undefined,
          "PUT",
        );
      },
      async listOrganizationNotificationSubscriptions({ account, context }) {
        organizationOnly(account, context, "webhooks.subscriptions.read");

        const result = object(
          await request(
            "/rest/eventSubscriptions?q=subscriberAndEventType&eventType=ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS",
            context,
          ),
        );

        return array(result["elements"]).flatMap((value): LinkedInEventSubscription[] => {
          const row = object(value);
          const expiresAt = row["expiresAt"];

          // The finder lists every organization the member subscribed; keep this author's only.
          if (row["entity"] !== account.accountId) return [];

          return [
            {
              entity: account.accountId,
              eventType: string(row["eventType"]),
              ...definedFields({
                user: optionalString(row["user"]) ?? optionalString(row["member"]),
                webhook: optionalString(row["webhook"]),
                expiresAt:
                  isString(expiresAt) && /^\d+$/.test(expiresAt)
                    ? Number(expiresAt)
                    : optionalNumber(expiresAt),
              }),
            },
          ];
        });
      },
      async unsubscribeOrganizationNotifications({
        account,
        developerApplication,
        member,
        context,
      }) {
        organizationOnly(account, context, "webhooks.subscriptions.write");

        await request(
          subscriptionPath(account, developerApplication, member),
          context,
          undefined,
          undefined,
          "DELETE",
        );
      },
      async editComment({ account, postId, commentId, text, mentions, context }) {
        authorize(account, context);

        const attributes = commentAttributes(text, mentions ?? [], "comments.edit");
        const match = linkedInCommentUrn.exec(commentId);

        if (!linkedInPostUrn.test(postId) || !match)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.edit",
            message:
              "Provide the share or ugcPost URN and the complete commentUrn returned by comment reads.",
          });

        // Only message.text and message.attributes can change; empty attributes clear old mentions.
        await request(
          `/rest/socialActions/${encodeURIComponent(postId)}/comments/${match[2]}${organizationActor()}`,
          context,
          { patch: { message: { $set: { text, attributes: attributes ?? [] } } } },
          undefined,
          "POST",
          { "X-RestLi-Method": "PARTIAL_UPDATE" },
        );
      },
    },
  });
}
