import { remainingBudget } from "../transport/budget.js";
import { defineAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import type {
  AccountRecord,
  AnalyticsReport,
  AnalyticsReportQuery,
  AnalyticsReportRow,
  AdapterOperationContext,
  CommentRef,
  ConnectedAccountRef,
  DeliveryOutcome,
  JsonObject,
  JsonValue,
  MediaAttachment,
  MetricValue,
  Page,
  PlatformPostRef,
  PreparedPublishTarget,
  ScheduleCancellation,
  ScheduledJobRef,
  SearchPostsInput,
} from "../core/types.js";
import { managedHttp, optionsObject, publicFields } from "../cloud/common.js";
import { normalizeComment, normalizeMetrics } from "../core/projections.js";
import { definedFields } from "../core/fields.js";
import { verifyYouTubeWebhook } from "../server/webhooks.js";
import { directWebhooks, webhookCapability } from "./webhook-adapter.js";
import { abortable, createHttp, HttpError, retryDelay } from "../transport/http.js";
import { fetchWithoutRedirects } from "../transport/redirect.js";
import {
  array,
  isBoolean,
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  object,
  optionalArray,
  optionalObject,
  optionalString,
  string,
} from "../transport/validation.js";
import { readLiveChatStream, type YouTubeLiveChatStreamPage } from "./youtube-chat-stream.js";
import {
  beginYouTubeUpload,
  queryYouTubeUpload,
  sendYouTubeUpload,
  type YouTubeUploadSession,
  type YouTubeUploadStatus,
} from "./youtube-upload.js";

export type { YouTubeLiveChatStreamPage } from "./youtube-chat-stream.js";

export interface YouTubeOptions {
  readonly auth: { readonly accessToken: string; readonly channelId: string };
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
  /** Persist secret resumable URI server-side before uploading any video bytes. */
  readonly saveUploadSession?: (session: YouTubeUploadSession) => Promise<void>;
  /** The `hub.secret` sent when subscribing to push notifications. */
  readonly webhookSecret?: string;
}

export interface YouTubeNative {
  readonly resumeUpload: (
    session: YouTubeUploadSession,
    media: MediaAttachment,
    context: AdapterOperationContext,
  ) => Promise<YouTubeUploadStatus>;
  readonly queryUpload: (
    session: YouTubeUploadSession,
    context: AdapterOperationContext,
  ) => Promise<YouTubeUploadStatus>;
  readonly setThumbnail: (input: {
    readonly videoId: string;
    readonly thumbnail: MediaAttachment;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly captions: (input: {
    readonly action: "list" | "insert" | "update" | "delete" | "download";
    readonly videoId: string;
    readonly caption?: MediaAttachment;
    readonly captionId?: string;
    readonly body?: JsonObject;
    /**
     * For `download`: the `tfmt` format. Defaults to `vtt`; `original` omits `tfmt` so YouTube
     * returns the track in the format it was uploaded in.
     */
    readonly format?: "original" | "sbv" | "scc" | "srt" | "ttml" | "vtt";
    /** For `download`: `tlang`, a language code to machine-translate the track into. */
    readonly tlang?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject | Blob>;
  readonly playlists: (input: {
    readonly action: "list" | "insert" | "update" | "delete";
    readonly playlistId?: string;
    readonly channelId?: string;
    readonly mine?: boolean;
    readonly pageToken?: string;
    readonly maxResults?: number;
    readonly body?: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly playlistItems: (input: {
    readonly action: "list" | "insert" | "update" | "delete";
    readonly playlistId?: string;
    readonly playlistItemId?: string;
    readonly body?: JsonObject;
    readonly pageToken?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly rateVideo: (input: {
    readonly videoId: string;
    readonly rating: "like" | "dislike" | "none";
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly getRating: (input: {
    readonly videoIds: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly subscriptions: (input: {
    readonly action: "list" | "insert" | "delete";
    readonly subscriptionId?: string;
    readonly channelId?: string;
    /** List the configured channel's subscribers (`mySubscribers`) or newest first (`myRecentSubscribers`). */
    readonly subscribers?: "all" | "recent";
    /** `forChannelId`: keep only subscriptions to these channels. */
    readonly forChannelIds?: readonly string[];
    readonly order?: "alphabetical" | "relevance" | "unread";
    readonly maxResults?: number;
    readonly pageToken?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly search: (input: {
    readonly q: string;
    readonly type?: string;
    readonly channelId?: string;
    readonly order?: string;
    readonly publishedAfter?: string;
    readonly publishedBefore?: string;
    readonly pageToken?: string;
    readonly maxResults?: number;
    /** Requires `type: "video"`. */
    readonly eventType?: "completed" | "live" | "upcoming";
    readonly regionCode?: string;
    readonly relevanceLanguage?: string;
    readonly safeSearch?: "moderate" | "none" | "strict";
    /** Requires `type: "video"`. */
    readonly videoDuration?: "any" | "long" | "medium" | "short";
    /** Requires `type: "video"`. */
    readonly videoDefinition?: "any" | "high" | "standard";
    /** Requires `type: "video"`. */
    readonly videoCaption?: "any" | "closedCaption" | "none";
    /** Requires `type: "video"`. */
    readonly videoLicense?: "any" | "creativeCommon" | "youtube";
    /** Requires `type: "video"`. */
    readonly videoType?: "any" | "episode" | "movie";
    /** Requires `type: "video"`. */
    readonly videoCategoryId?: string;
    /** Requires `type: "video"`: a point and a radius such as `5km` (at most 1000 km). */
    readonly location?: {
      readonly latitude: number;
      readonly longitude: number;
      readonly radius: string;
    };
    readonly topicId?: string;
    /** Requires `type: "video"`: `true` keeps only videos that can be embedded. */
    readonly videoEmbeddable?: "any" | "true";
    /** Requires `type: "video"`: `true` keeps only videos playable outside youtube.com. */
    readonly videoSyndicated?: "any" | "true";
    /** Requires `type: "video"`. */
    readonly videoDimension?: "2d" | "3d" | "any";
    /** Requires `type: "video"`: `true` keeps only videos the creator marked as paid promotion. */
    readonly videoPaidProductPlacement?: "any" | "true";
    /** `show` keeps only show channels. */
    readonly channelType?: "any" | "show";
    /**
     * Search only the authorized channel's own videos, including private ones. Requires
     * `type: "video"` and excludes the other video filters except `eventType` and
     * `videoCategoryId`. At most one of `forMine` and `forDeveloper`.
     */
    readonly forMine?: boolean;
    /** Search only videos uploaded through this app's Google Cloud project. */
    readonly forDeveloper?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly commentsModeration: (input: {
    readonly action: "setModerationStatus" | "delete" | "update";
    readonly commentId: string;
    readonly moderationStatus?: "published" | "heldForReview" | "rejected";
    readonly banAuthor?: boolean;
    readonly body?: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject | void>;
  /**
   * Deletes one comment with `comments.delete`. For a top-level comment, pass the thread's
   * `snippet.topLevelComment.id`; `commentThreads` has no delete method. Google documents a
   * 403 `forbidden` for insufficient permissions. Google does not document which comments a channel may delete.
   * Use `commentsModeration` with `setModerationStatus: "rejected"` to remove another user's
   * comment from your video.
   */
  readonly deleteComment: (input: {
    readonly account: ConnectedAccountRef;
    readonly commentId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly heldComments: (input: {
    /** `heldForReview` (default) or `likelySpam`. */
    readonly moderationStatus?: "heldForReview" | "likelySpam";
    readonly pageToken?: string;
    readonly maxResults?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly updateVideo: (input: {
    readonly videoId: string;
    readonly body: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly deleteVideo: (input: {
    readonly videoId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /**
   * Update the configured channel with channels.update. One part is written per call. The adapter
   * reads the current part first and merges `value` into it, because YouTube deletes any mutable
   * property omitted from the write. A `null` field removes that property or localization.
   */
  readonly updateProfile: (input: {
    readonly part: "brandingSettings" | "localizations";
    readonly value: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly analytics: (input: {
    readonly query: Record<string, string>;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly liveBroadcasts: (input: {
    readonly action: "list" | "insert" | "update" | "delete" | "transition" | "bind" | "cuepoint";
    readonly body?: JsonObject;
    readonly id?: string;
    readonly broadcastStatus?: "testing" | "live" | "complete";
    /** For `bind`: the liveStream to attach. Omit it to remove the current binding. */
    readonly streamId?: string;
    /** For `cuepoint`: an ad break. Set at most one of `insertionOffsetTimeMs` and `walltimeMs`. */
    readonly cuepoint?: {
      readonly durationSecs?: number;
      readonly insertionOffsetTimeMs?: number;
      readonly walltimeMs?: number;
    };
    /**
     * For `list` without `id`: the `broadcastStatus` filter (`active`, `all`, `completed`,
     * `upcoming`) instead of `mine=true`.
     */
    readonly statusFilter?: "active" | "all" | "completed" | "upcoming";
    /** For `list`: `broadcastType`. YouTube defaults to `event`, which hides persistent broadcasts. */
    readonly broadcastType?: "all" | "event" | "persistent";
    /** For `list`: 0 to 50; YouTube defaults to 5. */
    readonly maxResults?: number;
    readonly pageToken?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** liveStreams list, insert, update, and delete: the ingestion endpoints a broadcast binds to. */
  readonly liveStreams: (input: {
    readonly action: "list" | "insert" | "update" | "delete";
    /** For list: these stream IDs instead of the caller's own (`mine=true`). */
    readonly ids?: readonly string[];
    readonly streamId?: string;
    readonly body?: JsonObject;
    readonly pageToken?: string;
    readonly maxResults?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** superChatEvents.list: Super Chat and Super Sticker purchases from the last 30 days. */
  readonly superChatEvents: (input: {
    readonly hl?: string;
    readonly pageToken?: string;
    readonly maxResults?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly liveChatMessages: (input: {
    /** `closePoll` ends an active poll with liveChatMessages.transition and returns its result. */
    readonly action: "list" | "insert" | "delete" | "closePoll";
    readonly liveChatId?: string;
    readonly messageId?: string;
    readonly pageToken?: string;
    readonly maxResults?: number;
    /** For `list`: language for localized Super Chat amount strings. */
    readonly hl?: string;
    /** For `list`: avatar size in pixels, 16 to 720 (YouTube defaults to 88). */
    readonly profileImageSize?: number;
    readonly body?: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject | void>;
  /**
   * liveChatMessages.streamList over HTTP (`GET /youtube/v3/liveChat/messages/stream`, 5 units):
   * one connection that yields each page of messages as YouTube sends it. The request is sent
   * when iteration starts; it stops when the caller stops iterating, `context.signal` aborts, the
   * optional `stallTimeoutMs` elapses, or YouTube ends the response. It never reconnects; resume
   * with the last page's `nextPageToken` as `pageToken`.
   */
  readonly liveChatStream: (input: {
    readonly liveChatId: string;
    /** The last page's `nextPageToken`, to resume. `undefined` starts from recent messages. */
    readonly pageToken?: string | undefined;
    readonly hl?: string;
    /** Author avatar size in pixels, 16 to 720 (YouTube defaults to 88). */
    readonly profileImageSize?: number;
    /** Abort if no bytes arrive for this long. Google documents no keep-alive interval. */
    readonly stallTimeoutMs?: number;
    readonly context: AdapterOperationContext;
  }) => AsyncGenerator<YouTubeLiveChatStreamPage, void, undefined>;
  readonly liveChatModerators: (input: {
    readonly action: "list" | "insert" | "delete";
    readonly liveChatId?: string;
    readonly moderatorId?: string;
    readonly pageToken?: string;
    readonly maxResults?: number;
    readonly body?: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject | void>;
  readonly liveChatBans: (input: {
    readonly action: "insert" | "delete";
    readonly banId?: string;
    readonly body?: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject | void>;
  readonly channelSections: (input: {
    readonly action: "list" | "insert" | "update" | "delete";
    readonly channelSectionId?: string;
    /** For `list`: another channel's sections. Defaults to the configured channel. */
    readonly channelId?: string;
    /** For `list`: language for localized section titles. */
    readonly hl?: string;
    readonly pageToken?: string;
    readonly maxResults?: number;
    readonly body?: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject | void>;
  readonly activities: (input: {
    readonly channelId?: string;
    readonly mine?: boolean;
    readonly pageToken?: string;
    readonly maxResults?: number;
    readonly publishedAfter?: string;
    readonly publishedBefore?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** videos.list for any video by ID, the `mostPopular` chart, or the caller's `myRating` list. */
  readonly videos: (input: {
    readonly filter:
      | { readonly kind: "id"; readonly ids: readonly string[] }
      | {
          readonly kind: "mostPopular";
          readonly regionCode?: string;
          readonly videoCategoryId?: string;
        }
      | { readonly kind: "myRating"; readonly rating: "like" | "dislike" };
    readonly parts?: readonly YouTubeVideoPart[];
    readonly hl?: string;
    /** With the `player` part: the largest embed width, 72 to 8192 pixels. */
    readonly maxWidth?: number;
    /** With the `player` part: the largest embed height, 72 to 8192 pixels. */
    readonly maxHeight?: number;
    readonly pageToken?: string;
    readonly maxResults?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** videos.batchGetStats: statistics for many videos from its own 10,000-unit daily bucket. */
  readonly batchGetStats: (input: {
    readonly videoIds: readonly string[];
    readonly parts?: readonly ("contentDetails" | "id" | "snippet" | "statistics")[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** channels.list for any channel by ID, handle (`forHandle`) or legacy username. */
  readonly channels: (input: {
    readonly filter:
      | { readonly kind: "id"; readonly ids: readonly string[] }
      | { readonly kind: "handle"; readonly handle: string }
      | { readonly kind: "username"; readonly username: string };
    readonly parts?: readonly YouTubeChannelPart[];
    readonly hl?: string;
    readonly pageToken?: string;
    readonly maxResults?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** videoCategories.list by region or ID, for choosing an upload `categoryId`. */
  readonly videoCategories: (input: {
    readonly filter:
      | { readonly kind: "region"; readonly regionCode: string }
      | { readonly kind: "id"; readonly ids: readonly string[] };
    readonly hl?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** i18nLanguages.list or i18nRegions.list. */
  readonly i18n: (input: {
    readonly resource: "languages" | "regions";
    readonly hl?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** videoAbuseReportReasons.list: the reason IDs reportAbuse accepts. */
  readonly videoAbuseReportReasons: (input: {
    readonly hl?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** videos.reportAbuse. YouTube answers 204 with no body. */
  readonly reportAbuse: (input: {
    readonly videoId: string;
    readonly reasonId: string;
    readonly secondaryReasonId?: string;
    readonly comments?: string;
    readonly language?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** commentThreads.list with its filters, or commentThreads.insert for a top-level comment. */
  readonly commentThreads: (
    input:
      | {
          readonly action: "list";
          readonly filter:
            | { readonly kind: "video"; readonly videoId: string }
            | { readonly kind: "channel"; readonly channelId?: string };
          readonly searchTerms?: string;
          readonly order?: "time" | "relevance";
          readonly textFormat?: "html" | "plainText";
          readonly moderationStatus?: "published" | "heldForReview" | "likelySpam";
          /** Adds the `replies` part, which carries some replies inline. */
          readonly includeReplies?: boolean;
          readonly pageToken?: string;
          readonly maxResults?: number;
          readonly context: AdapterOperationContext;
        }
      | {
          readonly action: "insert";
          readonly videoId: string;
          readonly text: string;
          /** The channel that owns the video. Defaults to the configured channel. */
          readonly channelId?: string;
          readonly context: AdapterOperationContext;
        },
  ) => Promise<JsonObject>;
  /** channelBanners.insert: upload a 16:9 banner image (at most 6 MiB) and return its `url`. */
  readonly uploadChannelBanner: (input: {
    readonly image: MediaAttachment;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** watermarks.set or watermarks.unset for the configured channel. */
  readonly watermarks: (
    input:
      | {
          readonly action: "set";
          readonly image: MediaAttachment;
          readonly timing: {
            readonly type: "offsetFromStart" | "offsetFromEnd";
            readonly offsetMs: number;
            readonly durationMs?: number;
          };
          /** Channel the watermark links to. Defaults to the configured channel. */
          readonly targetChannelId?: string;
          readonly context: AdapterOperationContext;
        }
      | { readonly action: "unset"; readonly context: AdapterOperationContext },
  ) => Promise<void>;
  /** playlistImages list, insert, update, and delete: a playlist's custom square thumbnail. */
  readonly playlistImages: (
    input:
      | {
          readonly action: "list";
          readonly playlistId: string;
          readonly pageToken?: string;
          readonly maxResults?: number;
          readonly context: AdapterOperationContext;
        }
      | {
          readonly action: "insert";
          readonly playlistId: string;
          readonly image: MediaAttachment;
          readonly context: AdapterOperationContext;
        }
      | {
          readonly action: "update";
          readonly playlistImageId: string;
          readonly playlistId: string;
          readonly image: MediaAttachment;
          readonly context: AdapterOperationContext;
        }
      | {
          readonly action: "delete";
          readonly playlistImageId: string;
          readonly context: AdapterOperationContext;
        },
  ) => Promise<JsonObject>;
  /** members.list for channel memberships. Needs YouTube approval and its own scope. */
  readonly members: (input: {
    readonly mode?: "all_current" | "updates";
    readonly filterByMemberChannelIds?: readonly string[];
    readonly hasAccessToLevel?: string;
    readonly pageToken?: string;
    readonly maxResults?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** membershipsLevels.list: the channel's membership levels. Needs YouTube approval. */
  readonly membershipsLevels: (input: {
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** YouTube Analytics groups list, insert, update, and delete: named sets for grouped reports. */
  readonly analyticsGroups: (
    input:
      | {
          readonly action: "list";
          /** These group IDs instead of the caller's own (`mine=true`). */
          readonly ids?: readonly string[];
          readonly pageToken?: string;
          readonly context: AdapterOperationContext;
        }
      | {
          readonly action: "insert";
          readonly title: string;
          readonly itemType: "youtube#channel" | "youtube#playlist" | "youtube#video";
          readonly context: AdapterOperationContext;
        }
      | {
          readonly action: "update";
          readonly groupId: string;
          readonly title: string;
          readonly context: AdapterOperationContext;
        }
      | {
          readonly action: "delete";
          readonly groupId: string;
          readonly context: AdapterOperationContext;
        },
  ) => Promise<JsonObject>;
  /** YouTube Analytics groupItems list, insert, and delete. */
  readonly analyticsGroupItems: (
    input:
      | {
          readonly action: "list";
          readonly groupId: string;
          readonly context: AdapterOperationContext;
        }
      | {
          readonly action: "insert";
          readonly groupId: string;
          readonly resource: {
            readonly kind: "youtube#channel" | "youtube#playlist" | "youtube#video";
            readonly id: string;
          };
          readonly context: AdapterOperationContext;
        }
      | {
          readonly action: "delete";
          readonly groupItemId: string;
          readonly context: AdapterOperationContext;
        },
  ) => Promise<JsonObject>;
  /** YouTube Reporting API reportTypes.list: the bulk report types a job can generate. */
  readonly reportTypes: (input: {
    readonly includeSystemManaged?: boolean;
    readonly pageSize?: number;
    readonly pageToken?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** YouTube Reporting API jobs: schedule a daily bulk report, or list, read, or delete jobs. */
  readonly reportingJobs: (
    input:
      | {
          readonly action: "list";
          readonly includeSystemManaged?: boolean;
          readonly pageSize?: number;
          readonly pageToken?: string;
          readonly context: AdapterOperationContext;
        }
      | {
          readonly action: "create";
          readonly reportTypeId: string;
          readonly name: string;
          readonly context: AdapterOperationContext;
        }
      | {
          readonly action: "get" | "delete";
          readonly jobId: string;
          readonly context: AdapterOperationContext;
        },
  ) => Promise<JsonObject>;
  /** YouTube Reporting API jobs.reports list and get: the generated reports and their downloadUrl. */
  readonly reports: (
    input:
      | {
          readonly action: "list";
          readonly jobId: string;
          readonly createdAfter?: string;
          readonly startTimeAtOrAfter?: string;
          readonly startTimeBefore?: string;
          readonly pageSize?: number;
          readonly pageToken?: string;
          readonly context: AdapterOperationContext;
        }
      | {
          readonly action: "get";
          readonly jobId: string;
          readonly reportId: string;
          readonly context: AdapterOperationContext;
        },
  ) => Promise<JsonObject>;
  /** Download a report's CSV from its `downloadUrl` on youtubereporting.googleapis.com. */
  readonly downloadReport: (input: {
    readonly downloadUrl: string;
    readonly context: AdapterOperationContext;
  }) => Promise<Blob>;
  /** comments.list with `id`: up to 50 comments or replies by ID. */
  readonly comments: (input: {
    readonly commentIds: readonly string[];
    readonly textFormat?: "html" | "plainText";
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** videoTrainability.get (beta, discovery only): who may train AI models on a video. */
  readonly videoTrainability: (input: {
    readonly videoId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<YouTubeVideoTrainability>;
  /** abuseReports.insert (beta, discovery only): report an entity with typed abuse IDs. */
  readonly abuseReports: (input: {
    readonly report: YouTubeAbuseReport;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** comments.list with `parentId`: every reply to a top-level comment. */
  readonly commentReplies: (input: {
    readonly parentId: string;
    readonly textFormat?: "html" | "plainText";
    readonly pageToken?: string;
    readonly maxResults?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
}

/** A videoTrainability resource: `permitted` is `["all"]`, `["none"]` or a list of parties. */
export interface YouTubeVideoTrainability {
  readonly videoId: string;
  readonly permitted: readonly string[];
  readonly raw: JsonObject;
}

/** An entity in an abuse report, as the discovery document's `Entity` schema describes it. */
export interface YouTubeAbuseEntity {
  readonly id?: string;
  readonly typeId?: string;
  readonly url?: string;
}

/** The discovery document's `AbuseReport` body. */
export interface YouTubeAbuseReport {
  readonly subject: YouTubeAbuseEntity;
  readonly abuseTypes: readonly { readonly id: string }[];
  readonly description?: string;
  readonly relatedEntities?: readonly { readonly entity: YouTubeAbuseEntity }[];
}

const videoParts = [
  "brandPartner",
  "contentDetails",
  "fileDetails",
  "id",
  "liveStreamingDetails",
  "localizations",
  "paidProductPlacementDetails",
  "player",
  "processingDetails",
  "recordingDetails",
  "snippet",
  "statistics",
  "status",
  "suggestions",
  "topicDetails",
] as const;

export type YouTubeVideoPart = (typeof videoParts)[number];

const channelParts = [
  "brandingSettings",
  "contentDetails",
  "id",
  "localizations",
  "snippet",
  "statistics",
  "status",
  "topicDetails",
] as const;

export type YouTubeChannelPart = (typeof channelParts)[number];

function isOneOf<T extends string>(allowed: readonly T[], value: string): value is T {
  return allowed.some((candidate) => candidate === value);
}

function invalidInput(operation: string, message: string): SocialError {
  return new SocialError({ code: "invalid_input", operation, message });
}

/** Validate a list of IDs: at least one, at most `max`, each non-empty without commas. */
function idList(ids: readonly string[], max: number, operation: string): string {
  if (
    ids.length === 0 ||
    ids.length > max ||
    ids.some((id) => !isString(id) || id.trim() === "" || id.includes(","))
  )
    throw invalidInput(operation, `Supply 1 to ${max} non-empty IDs without commas.`);

  return ids.join(",");
}

/** Validate selected parts against the documented list and join them. */
function partList<T extends string>(
  parts: readonly string[],
  allowed: readonly T[],
  operation: string,
): string {
  if (parts.length === 0 || parts.some((part) => !isOneOf(allowed, part)))
    throw invalidInput(operation, `parts must be drawn from: ${allowed.join(", ")}.`);

  return [...new Set(parts)].join(",");
}

/** maxResults as a query string, checked against the method's documented range. */
function pageSize(
  value: number | undefined,
  min: number,
  max: number,
  operation: string,
): string | undefined {
  if (value === undefined) return undefined;

  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw invalidInput(operation, `maxResults must be an integer from ${min} to ${max}.`);

  return String(value);
}

/** Reject an optional enum value outside the documented set (for untyped JavaScript callers). */
function optionalEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  name: string,
  operation: string,
): T | undefined {
  if (value === undefined) return undefined;

  if (!isOneOf(allowed, value))
    throw invalidInput(operation, `${name} must be one of: ${allowed.join(", ")}.`);

  return value;
}

const regionPattern = /^[A-Z]{2}$/u;

/** videos.list `maxWidth` or `maxHeight`: 72 to 8192 pixels. */
function embedSize(value: number | undefined, name: string, operation: string) {
  if (value === undefined) return undefined;

  if (!Number.isSafeInteger(value) || value < 72 || value > 8192)
    throw invalidInput(operation, `${name} must be an integer from 72 to 8192.`);

  return String(value);
}

/** liveChatMessages list and stream `hl` and `profileImageSize` (16 to 720 pixels). */
function chatDisplayOptions(
  hl: string | undefined,
  profileImageSize: number | undefined,
  operation: string,
) {
  if (hl !== undefined && !languageTag.test(hl))
    throw invalidInput(operation, "hl must be a language code such as fr.");

  if (
    profileImageSize !== undefined &&
    (!Number.isSafeInteger(profileImageSize) || profileImageSize < 16 || profileImageSize > 720)
  )
    throw invalidInput(operation, "profileImageSize must be an integer from 16 to 720.");

  return definedFields({
    hl,
    profileImageSize: profileImageSize === undefined ? undefined : String(profileImageSize),
  });
}

function abuseEntity(entity: YouTubeAbuseEntity, operation: string): JsonObject {
  const fields = definedFields({
    id: nonEmpty(entity.id?.trim()),
    typeId: nonEmpty(entity.typeId?.trim()),
    url: nonEmpty(entity.url?.trim()),
  });

  if (fields.id === undefined && fields.url === undefined)
    throw invalidInput(operation, "Each abuse report entity needs an id or a url.");

  return fields;
}

/** Validate an abuseReports.insert body against the discovery document's AbuseReport schema. */
function abuseReportBody(report: YouTubeAbuseReport): JsonObject {
  const operation = "abuseReports.insert";

  const abuseTypes = report.abuseTypes.map((type) => type.id.trim());

  if (abuseTypes.length === 0 || abuseTypes.some((id) => id === ""))
    throw invalidInput(operation, "abuseTypes needs at least one non-empty id.");

  return {
    subject: abuseEntity(report.subject, operation),
    abuseTypes: abuseTypes.map((id) => ({ id })),
    ...definedFields({
      description: nonEmpty(report.description?.trim()),
      relatedEntities: report.relatedEntities?.map((related) => ({
        entity: abuseEntity(related.entity, operation),
      })),
    }),
  };
}

const metresPerUnit = { m: 1, km: 1000, ft: 0.3048, mi: 1609.344 } as const;

/** search.list `location` and `locationRadius`; YouTube caps the radius at 1000 km. */
function searchArea(
  area: { readonly latitude: number; readonly longitude: number; readonly radius: string },
  operation: string,
) {
  const distance = /^(\d+(?:\.\d+)?)(m|km|ft|mi)$/u.exec(area.radius);

  const unit = distance?.[2];

  const metres =
    distance && unit !== undefined && isOneOf(["m", "km", "ft", "mi"], unit)
      ? Number(distance[1]) * metresPerUnit[unit]
      : Number.NaN;

  if (
    !Number.isFinite(area.latitude) ||
    Math.abs(area.latitude) > 90 ||
    !Number.isFinite(area.longitude) ||
    Math.abs(area.longitude) > 180 ||
    !(metres > 0 && metres <= 1_000_000)
  )
    throw invalidInput(
      operation,
      "location needs a valid latitude, longitude and a radius in m, km, ft or mi of at most 1000 km.",
    );

  return { location: `${area.latitude},${area.longitude}`, locationRadius: area.radius };
}

/** Drop empty strings so optional query parameters are omitted rather than sent blank. */
function nonEmpty(value: string | undefined): string | undefined {
  return value || undefined;
}

function writeResource(
  body: JsonObject | undefined,
  id: string | undefined,
  operation: string,
): JsonObject {
  if (!body || (id !== undefined && body["id"] !== undefined && body["id"] !== id))
    throw new SocialError({
      code: "invalid_input",
      operation,
      message: "A write body is required and its ID must match the selected resource.",
    });

  return id === undefined ? body : { ...body, id };
}

function writeParts(
  body: JsonObject | undefined,
  allowed: readonly string[],
  operation: string,
): string {
  const parts = Object.keys(body ?? {}).filter((key) => key !== "id");

  if (parts.length === 0 || parts.some((key) => !allowed.includes(key)))
    throw new SocialError({
      code: "invalid_input",
      operation,
      message: "Supply supported writable resource parts.",
    });

  return parts.join(",");
}

/** BCP-47 shaped language tag, such as `en`, `pt-BR`, or `zh-Hant`. */
const languageTag = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u;

/** YouTube's tag-length rule: commas count, and a tag with a space counts its quotation marks. */
function tagsLength(tags: readonly string[]): number {
  return tags.reduce(
    (total, tag, index) => total + [...tag].length + (/\s/u.test(tag) ? 2 : 0) + (index ? 1 : 0),
    0,
  );
}

interface UploadIssue {
  readonly code: string;
  readonly message: string;
}

/** Optional videos.insert fields from target options, decoded from `unknown` JSON. */
interface UploadExtras {
  readonly snippet: JsonObject;
  readonly status: JsonObject;
  readonly recordingDetails?: JsonObject;
  readonly localizations?: JsonObject;
  readonly notifySubscribers?: boolean;
}

type UploadExtrasResult =
  | { readonly kind: "valid"; readonly value: UploadExtras }
  | { readonly kind: "invalid"; readonly issues: readonly UploadIssue[] };

function uploadExtras(config: JsonObject): UploadExtrasResult {
  const issues: UploadIssue[] = [];

  const snippet: Record<string, JsonValue> = {};
  const status: Record<string, JsonValue> = {};

  const tags = config["tags"];

  if (tags !== undefined) {
    if (
      !isJsonArray(tags) ||
      !tags.every((tag): tag is string => isString(tag) && tag.trim() !== "" && !tag.includes(","))
    )
      issues.push({
        code: "youtube.tags",
        message: "tags must be non-empty strings without commas.",
      });
    else if (tagsLength(tags) > 500)
      issues.push({
        code: "youtube.tags",
        message: "tags may total at most 500 characters, counting commas and quoted spaces.",
      });
    else if (tags.length > 0) snippet["tags"] = tags;
  }

  const defaultLanguage = config["defaultLanguage"];

  if (defaultLanguage !== undefined) {
    if (isString(defaultLanguage) && languageTag.test(defaultLanguage))
      snippet["defaultLanguage"] = defaultLanguage;
    else
      issues.push({
        code: "youtube.defaultLanguage",
        message: "defaultLanguage must be a BCP-47 language tag.",
      });
  }

  const license = config["license"];

  if (license !== undefined) {
    if (license === "youtube" || license === "creativeCommon") status["license"] = license;
    else
      issues.push({
        code: "youtube.license",
        message: "license must be youtube or creativeCommon.",
      });
  }

  for (const key of ["embeddable", "publicStatsViewable", "containsSyntheticMedia"] as const) {
    const value = config[key];

    if (value === undefined) continue;

    if (isBoolean(value)) status[key] = value;
    else issues.push({ code: `youtube.${key}`, message: `${key} must be a boolean.` });
  }

  const recordingDate = config["recordingDate"];

  let recordingDetails: JsonObject | undefined;

  if (recordingDate !== undefined) {
    const time = isString(recordingDate) ? Date.parse(recordingDate) : Number.NaN;

    if (Number.isFinite(time)) recordingDetails = { recordingDate: new Date(time).toISOString() };
    else
      issues.push({
        code: "youtube.recordingDate",
        message: "recordingDate must be an ISO 8601 timestamp.",
      });
  }

  const localized = config["localizations"];

  let localizations: JsonObject | undefined;

  if (localized !== undefined) {
    const map = isJsonObject(localized) ? localized : undefined;

    const valid =
      map !== undefined &&
      Object.keys(map).length > 0 &&
      Object.entries(map).every(([language, entry]) => {
        if (!languageTag.test(language) || !isJsonObject(entry)) return false;

        const title = entry["title"];
        const description = entry["description"];

        return (
          Object.keys(entry).every((key) => key === "title" || key === "description") &&
          isString(title) &&
          title !== "" &&
          [...title].length <= 100 &&
          !/[<>]/u.test(title) &&
          (description === undefined ||
            (isString(description) &&
              new TextEncoder().encode(description).byteLength <= 5000 &&
              !/[<>]/u.test(description)))
        );
      });

    if (!valid || map === undefined)
      issues.push({
        code: "youtube.localizations",
        message:
          "localizations must map BCP-47 tags to a title (1 to 100 characters) and an optional description (at most 5000 UTF-8 bytes), without < or >.",
      });
    else if (snippet["defaultLanguage"] === undefined)
      issues.push({
        code: "youtube.localizations",
        message: "Set defaultLanguage before adding localizations.",
      });
    else localizations = map;
  }

  const notifySubscribers = config["notifySubscribers"];

  if (notifySubscribers !== undefined && !isBoolean(notifySubscribers))
    issues.push({
      code: "youtube.notifySubscribers",
      message: "notifySubscribers must be a boolean.",
    });

  if (issues.length > 0) return { kind: "invalid", issues };

  return {
    kind: "valid",
    value: {
      snippet,
      status,
      ...definedFields({
        recordingDetails,
        localizations,
        notifySubscribers: isBoolean(notifySubscribers) ? notifySubscribers : undefined,
      }),
    },
  };
}

export function youtube(
  options: YouTubeOptions,
): import("../core/adapter.js").SocialAdapter<YouTubeNative> {
  const request = managedHttp("https://www.googleapis.com", {
    apiKey: options.auth.accessToken,
    ...definedFields({ fetch: options.fetch }),
  });

  const analyticsRequest = managedHttp("https://youtubeanalytics.googleapis.com", {
    apiKey: options.auth.accessToken,
    ...definedFields({ fetch: options.fetch }),
  });

  const reportingRequest = managedHttp("https://youtubereporting.googleapis.com", {
    apiKey: options.auth.accessToken,
    ...definedFields({ fetch: options.fetch }),
  });

  const binaryRequest = createHttp({
    ...definedFields({ fetch: options.fetch }),
    timeoutMs: 30_000,
  });

  const now = () => (options.clock?.() ?? new Date()).toISOString();

  const authorize = (
    ref: { backend: string; platform: string; accountId: string },
    context: AdapterOperationContext,
  ) => {
    if (
      ref.backend !== context.backendInstance ||
      ref.platform !== "youtube" ||
      ref.accountId !== options.auth.channelId
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "youtube",
        message: "The selected channel does not belong to these configured credentials.",
      });
  };

  const get = async (
    ref: PlatformPostRef,
    context: AdapterOperationContext,
    extraParts: readonly ("recordingDetails" | "localizations")[] = [],
  ) => {
    authorize(ref, context);

    const result = object(
      await request("/youtube/v3/videos", context, undefined, {
        id: ref.postId,
        part: ["snippet", "status", "statistics", "processingDetails", ...extraParts].join(","),
      }),
    );

    const video = array(result["items"])
      .map(object)
      .find((item) => item["id"] === ref.postId);

    if (!video)
      throw new SocialError({
        code: "upstream_failure",
        operation: "posts.read",
        message: "Video is absent or inaccessible to this authorization.",
      });

    const snippet = object(video["snippet"]);

    if (snippet["channelId"] !== options.auth.channelId)
      throw new SocialError({
        code: "unauthorized",
        operation: "posts.read",
        message: "Video belongs to a different channel.",
      });

    return video;
  };

  /** Returns the publishAt time only while the video is private and still waiting to publish. */
  const scheduledAt = (status: JsonObject): string | undefined => {
    const publishAt = optionalString(status["publishAt"]);

    if (status["privacyStatus"] !== "private" || publishAt === undefined) return undefined;
    const time = Date.parse(publishAt);

    return Number.isFinite(time) && time > (options.clock?.() ?? new Date()).getTime()
      ? publishAt
      : undefined;
  };

  const outcome = (
    video: JsonObject,
    target: { account: ConnectedAccountRef; targetIndex: number },
  ): DeliveryOutcome => {
    const id = string(video["id"]);

    const status = object(video["status"]);

    const uploaded = optionalString(status["uploadStatus"]) ?? "unknown";

    const base = {
      ...target,
      observedAt: now(),
      backendState: uploaded,
      delivery: {
        kind: "delivery" as const,
        version: 1 as const,
        backend: target.account.backend,
        platform: "youtube",
        accountId: target.account.accountId,
        deliveryId: id,
      },
    };

    if (uploaded === "failed" || uploaded === "rejected")
      return {
        ...base,
        state: "failed",
        code: "media_error",
        message:
          "YouTube rejected or failed to process the video. Inspect channel eligibility and upload requirements.",
        retryDisposition: { kind: "never" },
      };

    // A private video with a future publishAt is waiting for YouTube to publish it.
    if (scheduledAt(status) !== undefined)
      return {
        ...base,
        state: "scheduled",
        job: {
          kind: "scheduled-job",
          version: 1,
          backend: target.account.backend,
          platform: "youtube",
          accountId: target.account.accountId,
          jobId: id,
        },
      };

    if (uploaded === "processed")
      return {
        ...base,
        state: "published",
        post: {
          kind: "platform-post",
          version: 1,
          backend: target.account.backend,
          platform: "youtube",
          accountId: target.account.accountId,
          postId: id,
        },
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
      };

    if (uploaded === "uploaded") return { ...base, state: "processing" };

    return {
      ...base,
      state: "unknown",
      reason: "unmapped-state",
      diagnostic: "Unmapped YouTube upload status.",
    };
  };

  const accountInfo = async (context: AdapterOperationContext): Promise<AccountRecord> => {
    let channel: JsonObject | undefined;
    let pageToken: string | undefined;
    const seen = new Set<string>();

    do {
      const result = object(
        await request("/youtube/v3/channels", context, undefined, {
          mine: "true",
          part: "snippet",
          maxResults: "50",
          ...definedFields({ pageToken }),
        }),
      );

      channel = array(result["items"])
        .map(object)
        .find((item) => item["id"] === options.auth.channelId);

      if (channel) break;

      pageToken = optionalString(result["nextPageToken"]);

      if (pageToken) {
        if (seen.has(pageToken) || seen.size >= 99)
          throw new SocialError({
            code: "upstream_failure",
            operation: "accounts.read",
            message: "YouTube channel pagination did not terminate.",
          });
        seen.add(pageToken);
      }
    } while (channel === undefined && pageToken);

    if (!channel)
      throw new SocialError({
        code: "unauthorized",
        operation: "accounts.read",
        message:
          "Configured channel was not returned for the authorized Google account. Select a channel through the connection flow.",
      });

    return {
      ref: {
        kind: "connected-account",
        version: 1,
        backend: context.backendInstance,
        platform: "youtube",
        accountId: options.auth.channelId,
      },
      displayName: string(object(channel["snippet"])["title"]),
      status: "connected",
    };
  };

  const nativeAuthorize = (context: AdapterOperationContext) =>
    authorize(
      { backend: context.backendInstance, platform: "youtube", accountId: options.auth.channelId },
      context,
    );

  const mediaBlob = (media: MediaAttachment | undefined): Blob => {
    if (!media || media.source.kind !== "blob")
      throw new SocialError({
        code: "invalid_input",
        operation: "native",
        message: "This YouTube operation requires a Blob media source.",
      });

    return media.source.blob;
  };

  /** Upload bytes and return the decoded response, which is `null` for a 204. */
  const binarySend = async (
    path: string,
    context: AdapterOperationContext,
    body: BodyInit,
    query: Record<string, string>,
    method: "POST" | "PUT" = "POST",
    contentType?: string,
  ): Promise<JsonValue> => {
    const url = new URL(`https://www.googleapis.com${path}`);

    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    try {
      const result = await binaryRequest({
        url,
        method,
        body,
        headers: {
          Authorization: `Bearer ${options.auth.accessToken}`,
          ...definedFields({ "Content-Type": nonEmpty(contentType) }),
        },
        timeoutMs: remainingBudget(context),
        ...definedFields({ signal: context.signal }),
      });

      return result;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      const ambiguous = error.dispatched && (error.kind !== "http" || (error.status ?? 0) >= 500);

      throw new SocialError({
        code: ambiguous
          ? "ambiguous_outcome"
          : error.status === 401
            ? "reconnect_required"
            : error.status === 403
              ? "missing_permission"
              : error.status === 429
                ? "rate_limited"
                : "upstream_failure",
        operation: path,
        message: error.message,
        upstreamStatus: error.status,
        retryDisposition: ambiguous ? { kind: "reconcile-first" } : { kind: "never" },
        cause: error,
      });
    }
  };

  const binaryJson = async (...args: Parameters<typeof binarySend>): Promise<JsonObject> =>
    object(await binarySend(...args));

  /**
   * Check an image upload against a method's documented MIME types and byte limit, then return
   * its Blob and the MIME type to send.
   */
  const uploadImage = (image: MediaAttachment, maxBytes: number, operation: string) => {
    const blob = mediaBlob(image);
    const mimeType = image.mimeType ?? blob.type;

    if (!["image/jpeg", "image/png", "application/octet-stream"].includes(mimeType))
      throw invalidInput(
        operation,
        "The image must be image/jpeg, image/png, or application/octet-stream.",
      );

    if (blob.size === 0 || blob.size > maxBytes)
      throw invalidInput(operation, `The image must be 1 byte to ${maxBytes} bytes.`);

    return { blob, mimeType };
  };

  /** A `multipart/related` body: the JSON resource first, then the media, as Google expects. */
  const multipartBody = (metadata: JsonObject, media: Blob, mimeType: string) => {
    const boundary = `youtube-upload-${crypto.randomUUID()}`;

    return {
      contentType: `multipart/related; boundary=${boundary}`,
      body: new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
        media,
        `\r\n--${boundary}--\r\n`,
      ]),
    };
  };

  /**
   * GET a binary resource with the bearer token, refusing redirects, and read it into a Blob
   * within the caller's remaining budget. Used for caption files and Reporting API CSVs.
   */
  const downloadBlob = async (
    url: URL,
    context: AdapterOperationContext,
    operation: string,
    failure: string,
  ): Promise<Blob> => {
    const controller = new AbortController();
    const abort = () => controller.abort(context.signal?.reason);
    const timeoutMs = remainingBudget(context);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    context.signal?.addEventListener("abort", abort, { once: true });

    if (context.signal?.aborted) abort();

    try {
      controller.signal.throwIfAborted();

      const response = await abortable(
        fetchWithoutRedirects(options.fetch ?? globalThis.fetch, url, {
          headers: { Authorization: `Bearer ${options.auth.accessToken}` },
          signal: controller.signal,
        }).then((response) => {
          if (controller.signal.aborted) {
            void response.body?.cancel().catch(() => undefined);
            controller.signal.throwIfAborted();
          }

          return response;
        }),
        controller.signal,
      );

      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        const delayMs = retryDelay(response.headers.get("retry-after"), Date.now());
        throw new SocialError({
          code:
            response.status === 401
              ? "reconnect_required"
              : response.status === 403
                ? "missing_permission"
                : response.status === 429
                  ? "rate_limited"
                  : "upstream_failure",
          operation,
          message: `YouTube returned HTTP ${response.status}.`,
          upstreamStatus: response.status,
          retryDisposition:
            response.status === 401
              ? { kind: "after-reconnect" }
              : response.status === 429 && delayMs !== undefined
                ? { kind: "after-delay", delayMs }
                : { kind: "never" },
        });
      }

      if (!response.body) return new Blob([], { type: response.headers.get("content-type") ?? "" });

      const reader = response.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];

      try {
        for (;;) {
          const chunk = await abortable(reader.read(), controller.signal);

          if (chunk.done) break;
          chunks.push(new Uint8Array(chunk.value));
        }

        return new Blob(chunks, { type: response.headers.get("content-type") ?? "" });
      } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (error instanceof SocialError) throw error;
      throw new SocialError({
        code: context.signal?.aborted
          ? "cancelled"
          : controller.signal.aborted
            ? "timeout"
            : "upstream_failure",
        operation,
        message: failure,
        retryDisposition: { kind: "never" },
      });
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
    }
  };

  const requireLiveChatId = (value: string | undefined, operation: string): string => {
    const id = value?.trim();

    if (!id)
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "liveChatId is required for this operation.",
      });

    return id;
  };

  const bodyLiveChatId = (body: JsonObject | undefined, operation: string): string => {
    const snippet = body?.["snippet"] === undefined ? undefined : object(body["snippet"]);

    return requireLiveChatId(optionalString(snippet?.["liveChatId"]), operation);
  };

  const assertLiveChatModerator = async (
    liveChatId: string,
    resourceId: string,
    context: AdapterOperationContext,
    operation: string,
  ): Promise<void> => {
    const seen = new Set<string>();
    let pageToken: string | undefined;

    do {
      const result = object(
        await request("/youtube/v3/liveChat/moderators", context, undefined, {
          liveChatId,
          part: "snippet",
          maxResults: "50",
          ...definedFields({ pageToken }),
        }),
      );

      const item = array(result["items"])
        .map(object)
        .find((candidate) => candidate["id"] === resourceId);

      if (item && optionalString(object(item["snippet"])["liveChatId"]) === liveChatId) return;

      pageToken = optionalString(result["nextPageToken"]);

      if (pageToken) {
        if (seen.has(pageToken) || seen.size >= 99)
          throw new SocialError({
            code: "upstream_failure",
            operation,
            message: "YouTube live chat pagination did not terminate.",
          });
        seen.add(pageToken);
      }
    } while (pageToken);

    throw new SocialError({
      code: "unauthorized",
      operation,
      message: "The selected live chat resource does not belong to this live chat.",
    });
  };

  const assertChannelSection = async (
    channelSectionId: string,
    context: AdapterOperationContext,
  ): Promise<void> => {
    const result = object(
      await request("/youtube/v3/channelSections", context, undefined, {
        id: channelSectionId,
        part: "snippet",
      }),
    );

    const section = array(result["items"])
      .map(object)
      .find((candidate) => candidate["id"] === channelSectionId);

    if (
      !section ||
      optionalString(object(section["snippet"])["channelId"]) !== options.auth.channelId
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "channel.sections.write",
        message: "The selected channel section does not belong to the configured channel.",
      });
  };

  const assertChannelSectionResult = (result: JsonObject, id: string): void => {
    const section = array(result["items"])
      .map(object)
      .find((candidate) => candidate["id"] === id);

    if (
      !section ||
      optionalString(object(section["snippet"])["channelId"]) !== options.auth.channelId
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "channel.sections.read",
        message: "The selected channel section does not belong to the configured channel.",
      });
  };

  return defineAdapter({
    id: "youtube",
    capabilities: {
      schemaVersion: 1 as const,
      backend: "youtube",
      apiRevision: "YouTube Data API v3",
      runtime: ["node22", "node24", "bun"],
      capabilities: [
        webhookCapability(
          "youtube",
          "Verifies the PubSubHubbub X-Hub-Signature for subscriptions created with hub.secret and decodes the Atom feed. Answer the GET verification with answerYouTubeWebhookChallenge.",
        ),
        ...[
          "accounts.read",
          "posts.read",
          "posts.list",
          "posts.status",
          "analytics.read",
          "analytics.account.read",
          "comments.read",
          "comments.write",
        ].map((operation) => ({
          operation,
          platform: "youtube",
          availability: "available" as const,
        })),
        {
          operation: "posts.publish",
          platform: "youtube",
          availability: "available" as const,
          formats: ["video" as const],
          requiredScopes: ["https://www.googleapis.com/auth/youtube.upload"],
          // Mirrors prepareTarget: one Blob or sized stream with a declared video MIME type.
          constraints: {
            mediaSources: ["blob" as const, "stream" as const],
            maxItems: 1,
            allowedMimeTypes: ["video/*"],
          },
          notes:
            "Since 2026-11-02 YouTube no longer forces uploads from unverified API projects to private; channel settings can still default an upload to private. Upload completion and video processing are separate.",
        },
        {
          operation: "posts.schedule",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.upload"],
          notes: "Scheduled videos are uploaded private with a future ISO publishAt timestamp.",
        },
        {
          operation: "posts.cancelScheduled",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
          notes:
            "Clears status.publishAt with videos.update and keeps the video private. The video is not deleted. Costs 51 quota units (videos.list + videos.update).",
        },
        {
          operation: "posts.removeFromPlatform",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
        },
        {
          operation: "notifications.read",
          platform: "youtube",
          availability: "unsupported-by-platform",
          notes:
            "The YouTube Data API has no notifications resource. activities.list reports actions a channel took, not notifications it received.",
        },
        {
          operation: "playlists.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"],
        },
        {
          operation: "playlists.write",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
        },
        {
          operation: "thumbnails.write",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
        },
        {
          operation: "videos.update",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
        },
        {
          operation: "posts.update",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
        },
        {
          operation: "profile.update",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
          notes:
            "Native access: updateProfile. Writes brandingSettings.channel or localizations through channels.update. Each call reads the channel (1 quota unit) and then writes it (50 units).",
        },
        {
          operation: "videos.delete",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
        },
        {
          operation: "posts.delete",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
        },
        {
          operation: "videos.rate",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
        },
        {
          operation: "captions.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
        },
        {
          operation: "captions.write",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
        },
        {
          operation: "subscriptions.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"],
        },
        {
          operation: "subscriptions.write",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
        },
        { operation: "search.keyword", platform: "youtube", availability: "available" },
        {
          operation: "search.posts",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"],
          notes:
            "Uses search.list with type=video. Each page request costs 1 unit in a separate search quota bucket with a default limit of 100 calls per day.",
        },
        {
          operation: "comments.moderate",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
        },
        {
          operation: "comments.delete",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
          notes:
            "comments.delete costs 50 quota units. Delete a thread through its top-level comment ID. Google does not document which comments a channel may delete; insufficient permissions return 403 forbidden.",
        },
        {
          operation: "analytics.youtube.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/yt-analytics.readonly"],
        },
        {
          operation: "live.chat.messages",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
          notes:
            "Native access to liveChatMessages list, insert, delete, and closePoll (liveChatMessages.transition, 20 units). The YouTube authorization determines whether the caller may act on the selected chat; the adapter validates the supplied chat ID and body but cannot independently verify chat ownership.",
        },
        {
          operation: "live.chat.stream",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"],
          notes:
            "Native liveChatStream: liveChatMessages.streamList over HTTP (GET /youtube/v3/liveChat/messages/stream, 5 units). Parses Google's streamed JSON-array framing; offline contract-tested only. Never reconnects; resume with nextPageToken.",
        },
        {
          operation: "live.chat.moderators",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
          notes:
            "Native access to liveChatModerators list, insert, and delete. The YouTube authorization determines whether the caller may moderate the selected chat; the adapter validates the supplied chat ID and body but cannot independently verify chat ownership.",
        },
        {
          operation: "live.chat.bans",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
          notes:
            "Native access to liveChatBans insert and delete. YouTube does not expose a liveChatBans list or read method, so provider authorization is the ownership boundary for ban deletion. Ban bodies must follow the YouTube liveChatBan resource shape.",
        },
        {
          operation: "channel.sections.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"],
        },
        {
          operation: "channel.sections.write",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
          notes:
            "Channel sections are limited to ten shelves and updates replace the mutable parts supplied in the request.",
        },
        {
          operation: "channel.activity.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"],
          notes:
            "Reads activities.list. Channel bulletins and activities.insert are deprecated and are not exposed.",
        },
        {
          operation: "analytics.report.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/yt-analytics.readonly"],
          notes: "Reports require an explicit bounded date range and provider-supported metrics.",
        },
        {
          operation: "analytics.groups",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/yt-analytics.readonly"],
          notes:
            "Native analyticsGroups and analyticsGroupItems on the YouTube Analytics API (/v2/groups, /v2/groupItems). Filter reports with filters=group==ID.",
        },
        {
          operation: "analytics.reporting.bulk",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/yt-analytics.readonly"],
          notes:
            "Native reportTypes, reportingJobs, reports, and downloadReport on the YouTube Reporting API (youtubereporting.googleapis.com). Downloads are bounded by the caller's budget and only follow Reporting API media URLs.",
        },
        {
          operation: "channel.banner.write",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.upload"],
          notes:
            "Native uploadChannelBanner (channelBanners.insert, 50 units, 16:9, at most 6 MiB). Apply the returned url with updateProfile brandingSettings.image.bannerExternalUrl, which needs the youtube scope.",
        },
        {
          operation: "channel.watermark.write",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
          notes: "Native watermarks set (at most 10 MiB) and unset, 50 units each.",
        },
        {
          operation: "playlists.images.write",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
          notes:
            "Native playlistImages list, insert, update, and delete: a square playlist thumbnail of at most 50 MB.",
        },
        {
          operation: "members.read",
          platform: "youtube",
          availability: "approval-dependent",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.channel-memberships.creator"],
          notes:
            "Native members and membershipsLevels. Only creators granted access through a Google or YouTube representative may call them, for their own memberships-enabled channel.",
        },
        {
          operation: "videos.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"],
          notes:
            "Native videos (videos.list by ID, chart=mostPopular, or myRating) and batchGetStats (videos.batchGetStats, its own 10,000-unit daily bucket). Reads any public video, not only the configured channel's.",
        },
        {
          operation: "channels.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"],
          notes: "Native channels: channels.list by ID, forHandle, or forUsername.",
        },
        {
          operation: "reference.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"],
          notes: "Native videoCategories and i18n (i18nLanguages.list, i18nRegions.list).",
        },
        {
          operation: "comments.create",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
          notes:
            "Native commentThreads: insert posts a top-level comment (50 units); list exposes searchTerms, order, textFormat, and moderationStatus including likelySpam.",
        },
        {
          operation: "comments.replies.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"],
          notes: "Native commentReplies: comments.list with parentId.",
        },
        {
          operation: "moderation.report",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
          notes:
            "Native reportAbuse (videos.reportAbuse, 50 units) with reason IDs from videoAbuseReportReasons. Native abuseReports calls the beta abuseReports.insert from the discovery document, which has no reference page.",
        },
        {
          operation: "live.broadcasts",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
          notes:
            "The channel must have live streaming enabled in YouTube Studio. Native liveBroadcasts lists (by id, mine, or broadcastStatus, with broadcastType and paging), inserts, updates, deletes, binds, inserts ad cuepoints, and transitions broadcasts.",
        },
        {
          operation: "live.streams",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube"],
          notes:
            "Native liveStreams list, insert, update, and delete. cdn.ingestionInfo contains the secret stream name.",
        },
        {
          operation: "live.superChat.read",
          platform: "youtube",
          availability: "available",
          requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"],
          notes:
            "Native superChatEvents: purchases from the channel's live streams in the last 30 days.",
        },
      ],
    },
    webhooks: directWebhooks(
      "youtube",
      (input) => verifyYouTubeWebhook({ ...input, secret: options.webhookSecret ?? "" }),
      now,
    ),
    accounts: {
      async list(_input: { cursor?: string; limit?: number }, context: AdapterOperationContext) {
        return { items: [await accountInfo(context)] };
      },
      async get(ref: ConnectedAccountRef, context: AdapterOperationContext) {
        authorize(ref, context);

        return accountInfo(context);
      },
    },
    posts: {
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        authorize(account, context);

        const limit = input.limit ?? 25;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || input.cursor === "")
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.read",
            message: "YouTube page size must be from 1 to 50 and page tokens must be nonempty.",
          });

        const channel = object(
          await request("/youtube/v3/channels", context, undefined, {
            id: options.auth.channelId,
            part: "contentDetails",
          }),
        );

        const row = array(channel["items"])
          .map(object)
          .find((item) => item["id"] === options.auth.channelId);

        if (!row)
          throw new SocialError({
            code: "unauthorized",
            operation: "posts.list",
            message: "Configured channel was not returned.",
          });

        const details = object(row["contentDetails"]),
          related = object(details["relatedPlaylists"]),
          uploads = string(related["uploads"]);

        const page = object(
          await request("/youtube/v3/playlistItems", context, undefined, {
            playlistId: uploads,
            part: "snippet,contentDetails",
            maxResults: String(limit),
            ...definedFields({ pageToken: nonEmpty(input.cursor) }),
          }),
        );

        return {
          items: array(page["items"]).map((value) => {
            const item = object(value),
              snippet = object(item["snippet"]),
              content = object(item["contentDetails"]);

            if (
              snippet["channelId"] !== options.auth.channelId ||
              (snippet["videoOwnerChannelId"] !== undefined &&
                snippet["videoOwnerChannelId"] !== options.auth.channelId)
            )
              throw new SocialError({
                code: "unauthorized",
                operation: "posts.read",
                message: "YouTube returned a video from another channel.",
              });

            return {
              id: string(content["videoId"]),
              snippet: publicFields(snippet, [
                "channelId",
                "title",
                "description",
                "publishedAt",
                "videoOwnerChannelId",
              ]),
              contentDetails: publicFields(content, ["videoId", "videoPublishedAt"]),
            };
          }),
          ...definedFields({ nextCursor: optionalString(page["nextPageToken"]) }),
        };
      },
      prepareTarget(target: PreparedPublishTarget) {
        const issues: { code: string; message: string; severity: "error"; targetIndex: number }[] =
          [];

        const fail = (code: string, message: string) =>
          issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

        if (
          target.account.platform !== "youtube" ||
          target.account.accountId !== options.auth.channelId
        )
          fail("youtube.channel", "Select the configured YouTube channel.");

        const media = target.content.media;

        if (media?.length !== 1 || media[0]?.kind !== "video")
          fail(
            "youtube.video",
            "YouTube requires exactly one video; text-only publication is unavailable.",
          );

        const item = media?.[0];

        if (item) {
          if (item.source.kind !== "blob" && item.source.kind !== "stream")
            fail("youtube.source", "Provide a Blob or replayable stream for resumable upload.");

          if (!item.mimeType?.startsWith("video/"))
            fail("youtube.mime", "Declare the actual video MIME type.");

          if (item.source.kind !== "blob" && !item.byteSize)
            fail("youtube.size", "Streaming upload requires its exact byte size.");
        }

        const config = optionsObject(target);

        const title = config["title"];

        if (!isString(title) || !title || [...title].length > 100 || /[<>]/u.test(title))
          fail("youtube.title", "Select a title of 1 to 100 characters.");

        if (!["public", "unlisted", "private"].includes(String(config["visibility"])))
          fail("youtube.visibility", "Explicit visibility is required.");

        if (!isBoolean(config["madeForKids"]))
          fail("youtube.audience", "Explicit made-for-kids declaration is required.");

        // videoCategories IDs are numeric strings, such as "22" for People & Blogs.
        if (
          config["categoryId"] !== undefined &&
          (!isString(config["categoryId"]) || !/^[0-9]{1,4}$/.test(config["categoryId"]))
        )
          fail("youtube.category", "categoryId must be a numeric YouTube video category ID.");

        if (
          target.content.text !== undefined &&
          (new TextEncoder().encode(target.content.text).byteLength > 5000 ||
            /[<>]/u.test(target.content.text))
        )
          fail(
            "youtube.description",
            "Description must be at most 5000 UTF-8 bytes and contain no angle brackets.",
          );

        if (
          target.schedule &&
          (!Number.isFinite(Date.parse(target.schedule.at)) ||
            Date.parse(target.schedule.at) <= (options.clock?.() ?? new Date()).getTime())
        )
          fail("youtube.schedule", "Schedule time must be a valid timestamp in the future.");

        if (target.replyTo) fail("youtube.operation", "Use comments.reply for replies.");

        const extras = uploadExtras(config);

        if (extras.kind === "invalid")
          for (const issue of extras.issues) fail(issue.code, issue.message);

        return issues;
      },
      async publishTarget(target: PreparedPublishTarget, context: AdapterOperationContext) {
        authorize(target.account, context);

        const media = target.content.media?.[0];

        if (!media)
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.publish",
            message: "Video required.",
          });

        const config = optionsObject(target);

        const uploadOptions = {
          timeoutMs: Math.max(remainingBudget(context), 15 * 60_000),
          accessToken: options.auth.accessToken,
          ...definedFields({ fetch: options.fetch, signal: context.signal }),
        };

        const size = media.byteSize ?? (media.source.kind === "blob" ? media.source.blob.size : 0);

        const mimeType = string(media.mimeType);

        const title = string(config["title"]);

        const visibility = string(config["visibility"]);

        const selfDeclaredMadeForKids = config["madeForKids"] === true;

        const categoryId = optionalString(config["categoryId"]);

        const extras = uploadExtras(config);

        if (extras.kind === "invalid")
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.publish",
            message: extras.issues.map((issue) => issue.message).join(" "),
          });

        // A schedule forces private visibility until YouTube publishes at `publishAt`.
        const status =
          target.schedule === undefined
            ? { ...extras.value.status, privacyStatus: visibility, selfDeclaredMadeForKids }
            : {
                ...extras.value.status,
                privacyStatus: "private",
                selfDeclaredMadeForKids,
                publishAt: new Date(target.schedule.at).toISOString(),
              };

        const session = await beginYouTubeUpload(
          {
            channelId: options.auth.channelId,
            size,
            mimeType,
            metadata: {
              snippet: {
                title,
                description: target.content.text ?? "",
                ...extras.value.snippet,
                ...definedFields({ categoryId }),
              },
              status,
              ...definedFields({
                recordingDetails: extras.value.recordingDetails,
                localizations: extras.value.localizations,
              }),
            },
            ...definedFields({ notifySubscribers: extras.value.notifySubscribers }),
          },
          uploadOptions,
        );

        if (options.saveUploadSession) await options.saveUploadSession(session);

        const result = await sendYouTubeUpload(session, media, uploadOptions);

        if (result.state === "incomplete")
          return {
            account: target.account,
            targetIndex: target.targetIndex,
            observedAt: now(),
            state: "unknown" as const,
            reason: "ambiguous-submission" as const,
            diagnostic:
              "Upload is incomplete. Query the saved server-side session and explicitly resume confirmed bytes.",
          };

        return outcome(result.video, target);
      },
      async get(ref: PlatformPostRef, context: AdapterOperationContext): Promise<JsonObject> {
        const video = await get(ref, context);

        return {
          id: string(video["id"]),
          snippet: publicFields(video["snippet"], [
            "title",
            "description",
            "channelId",
            "publishedAt",
          ]),
          status: publicFields(video["status"], [
            "privacyStatus",
            "uploadStatus",
            "selfDeclaredMadeForKids",
          ]),
        };
      },
      async getDelivery(
        ref: { backend: string; platform: string; accountId: string; deliveryId: string },
        context: AdapterOperationContext,
      ) {
        const account: ConnectedAccountRef = {
          kind: "connected-account",
          version: 1,
          backend: ref.backend,
          platform: "youtube",
          accountId: ref.accountId,
        };

        const video = await get(
          { ...account, kind: "platform-post", postId: ref.deliveryId },
          context,
        );

        return outcome(video, { account, targetIndex: 0 });
      },
      async cancelScheduled(
        ref: ScheduledJobRef,
        context: AdapterOperationContext,
      ): Promise<ScheduleCancellation> {
        authorize(ref, context);

        if (!ref.jobId)
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.cancelScheduled",
            message: "jobId must be the scheduled video's ID.",
          });

        const video = await get(
          {
            kind: "platform-post",
            version: 1,
            backend: ref.backend,
            platform: "youtube",
            accountId: ref.accountId,
            postId: ref.jobId,
          },
          context,
        );

        const status = object(video["status"]);

        if (scheduledAt(status) === undefined)
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.cancelScheduled",
            message:
              "Only a private video with a future publishAt can be cancelled. Reconcile a due or published video.",
          });

        // videos.update replaces the whole status part: an omitted field is reset. Resend every
        // writable field read above, set privacyStatus to private, and omit publishAt to clear it.
        const flag = (key: string): boolean | undefined => {
          const value = status[key];

          if (value === undefined || value === true || value === false) return value;
          throw new SocialError({
            code: "upstream_failure",
            operation: "posts.cancelScheduled",
            message: `YouTube returned an invalid status.${key} value.`,
          });
        };

        const selfDeclaredMadeForKids = flag("selfDeclaredMadeForKids");

        if (selfDeclaredMadeForKids === undefined)
          throw new SocialError({
            code: "upstream_failure",
            operation: "posts.cancelScheduled",
            message:
              "YouTube did not return the made-for-kids declaration, so the update could not preserve it. Nothing was changed.",
          });

        const license = optionalString(status["license"]);
        const embeddable = flag("embeddable");
        const publicStatsViewable = flag("publicStatsViewable");
        const containsSyntheticMedia = flag("containsSyntheticMedia");

        const next = (() => {
          const result: Record<string, JsonValue> = {};
          result["privacyStatus"] = "private";
          result["selfDeclaredMadeForKids"] = selfDeclaredMadeForKids;

          if (license !== undefined) result["license"] = license;

          if (embeddable !== undefined) result["embeddable"] = embeddable;

          if (publicStatsViewable !== undefined)
            result["publicStatsViewable"] = publicStatsViewable;

          if (containsSyntheticMedia !== undefined)
            result["containsSyntheticMedia"] = containsSyntheticMedia;

          return result satisfies JsonObject;
        })();

        const result = object(
          await request(
            "/youtube/v3/videos",
            context,
            { id: ref.jobId, status: next },
            { part: "status" },
            "PUT",
          ),
        );

        const written = result["status"] === undefined ? undefined : object(result["status"]);

        if (
          result["id"] !== ref.jobId ||
          written?.["privacyStatus"] !== "private" ||
          (written?.["publishAt"] !== undefined && written?.["publishAt"] !== null)
        )
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "posts.cancelScheduled",
            backend: context.backendInstance,
            correlationId: context.correlationId,
            message:
              "YouTube did not confirm that the schedule was cleared. Read the video before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return { state: "cancelled", backendRecord: "retained" };
      },
      async removeFromPlatform(ref: PlatformPostRef, context: AdapterOperationContext) {
        authorize(ref, context);

        if (!ref.postId)
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.removeFromPlatform",
            message: "postId is required.",
          });

        await get(ref, context);

        await request("/youtube/v3/videos", context, undefined, { id: ref.postId }, "DELETE");
      },
    },
    search: {
      async posts(
        account: ConnectedAccountRef,
        input: SearchPostsInput,
        context: AdapterOperationContext,
      ): Promise<Page<JsonObject>> {
        authorize(account, context);

        const limit = input.limit ?? 25;

        if (input.scope !== undefined && input.scope !== "recent")
          throw new SocialError({
            code: "invalid_input",
            operation: "search.posts",
            message: "YouTube search supports only the recent scope.",
          });

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
          throw new SocialError({
            code: "invalid_input",
            operation: "search.posts",
            message: "YouTube search limit must be between 1 and 50.",
          });

        const page = object(
          await request("/youtube/v3/search", context, undefined, {
            part: "snippet",
            q: input.query,
            type: "video",
            maxResults: String(limit),
            ...definedFields({
              pageToken: nonEmpty(input.cursor),
              publishedAfter: nonEmpty(input.startTime),
              publishedBefore: nonEmpty(input.endTime),
            }),
          }),
        );

        return {
          items: array(page["items"]).map(object),
          ...definedFields({ nextCursor: nonEmpty(optionalString(page["nextPageToken"])) }),
        };
      },
    },
    analytics: {
      async getPostMetrics(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        const video = await get(ref, context);

        if (video["statistics"] === undefined) return [];

        const values = object(video["statistics"]);

        const metrics: MetricValue[] = [];

        for (const name of ["viewCount", "likeCount", "commentCount"]) {
          const raw = values[name];

          if (!isString(raw) || !/^\d+$/.test(raw)) continue;

          const value = Number(raw);

          if (!Number.isSafeInteger(value)) continue;
          metrics.push({
            name,
            value,
            unit: "count",
            period: "lifetime",
            fetchedAt: now(),
            freshness: "unknown",
            source: "youtube-data-v3",
          });
        }

        return normalizeMetrics(metrics);
      },
      async getAccountMetrics(accountRef, context): Promise<readonly MetricValue[]> {
        // https://developers.google.com/youtube/v3/docs/channels/list
        authorize(accountRef, context);

        const result = object(
          await request("/youtube/v3/channels", context, undefined, {
            id: options.auth.channelId,
            part: "statistics,snippet",
          }),
        );

        const channel = array(result["items"])
          .map(object)
          .find((item) => item["id"] === options.auth.channelId);

        if (!channel)
          throw new SocialError({
            code: "unauthorized",
            operation: "analytics.account.read",
            message: "Configured channel was not returned for this authorization.",
          });

        const stats = object(channel["statistics"]);

        const fetchedAt = now();

        const metrics: readonly MetricValue[] = (
          ["viewCount", "subscriberCount", "videoCount"] as const
        ).flatMap((name) => {
          if (name === "subscriberCount" && stats["hiddenSubscriberCount"] === true) return [];

          const raw = stats[name];

          return isString(raw) && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
            ? [
                {
                  name,
                  value: Number(raw),
                  unit: "count" as const,
                  period: "lifetime" as const,
                  fetchedAt,
                  freshness: "unknown" as const,
                  source: "youtube-data-v3:channels.statistics",
                },
              ]
            : [];
        });

        return normalizeMetrics(metrics);
      },
      async getReport(
        accountRef: ConnectedAccountRef,
        query: AnalyticsReportQuery,
        context: AdapterOperationContext,
      ): Promise<AnalyticsReport> {
        authorize(accountRef, context);

        const date = /^\d{4}-\d{2}-\d{2}$/;

        if (
          !date.test(query.from) ||
          !date.test(query.to) ||
          query.from > query.to ||
          query.metrics.length === 0 ||
          query.metrics.some((metric) => !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(metric)) ||
          query.dimensions?.some((dimension) => !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(dimension))
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "analytics.report.read",
            message:
              "YouTube reports require YYYY-MM-DD dates (from <= to) and provider-safe metric names.",
          });

        const result = object(
          await analyticsRequest("/v2/reports", context, undefined, {
            ids: `channel==${options.auth.channelId}`,
            startDate: query.from,
            endDate: query.to,
            metrics: query.metrics.join(","),
            ...definedFields({
              dimensions:
                query.dimensions && query.dimensions.length > 0
                  ? query.dimensions.join(",")
                  : undefined,
            }),
          }),
        );

        const headers = array(result["columnHeaders"]).map((value) => {
          const header = object(value);

          return {
            name: string(header["name"]),
            type: optionalString(header["columnType"]) ?? "METRIC",
          };
        });

        const rows: AnalyticsReportRow[] = [];

        // Analytics omits `rows` entirely when the requested period has no data.
        for (const value of optionalArray(result["rows"]) ?? []) {
          const cells = array(value);

          const dimensions = Object.fromEntries(
            headers.flatMap((header, index) => {
              if (header.type !== "DIMENSION") return [];

              const raw = cells[index];

              // JSON numbers are always finite, so isFiniteNumber accepts every numeric cell.
              return isString(raw) || isFiniteNumber(raw) || isBoolean(raw)
                ? [[header.name, raw] as const]
                : [];
            }),
          );

          const metrics: Record<string, number> = {};

          headers.forEach((header, index) => {
            if (header.type === "DIMENSION") return;

            const raw = cells[index];

            const parsed = isFiniteNumber(raw)
              ? raw
              : isString(raw) && raw.trim() !== ""
                ? Number(raw)
                : undefined;

            if (parsed !== undefined && Number.isFinite(parsed)) metrics[header.name] = parsed;
          });

          rows.push({ dimensions, metrics });
        }

        return { query, rows, fetchedAt: now(), source: "youtube-analytics-v2" };
      },
    },
    comments: {
      async list(
        ref: PlatformPostRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        authorize(ref, context);

        const limit = input.limit ?? 25;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.read",
            message: "YouTube comment page size must be between 1 and 100.",
          });

        const result = object(
          await request("/youtube/v3/commentThreads", context, undefined, {
            part: "snippet",
            videoId: ref.postId,
            textFormat: "plainText",
            maxResults: String(limit),
            ...definedFields({ pageToken: input.cursor }),
          }),
        );

        const cursor = optionalString(result["nextPageToken"]);

        return {
          items: array(result["items"]).map((value) => {
            const row = object(value);

            const snippet = object(row["snippet"]);

            const comment = object(snippet["topLevelComment"]);

            // The thread snippet keeps topLevelComment, author channel, reply count, and edit time.
            // imageUrl is a signed link to an attached image or GIF that expires six hours after
            // retrieval; callers should copy the image promptly and never log the URL.
            return normalizeComment({
              id: string(comment["id"]),
              ...publicFields(comment["snippet"], [
                "textDisplay",
                "authorDisplayName",
                "publishedAt",
                "likeCount",
                "imageUrl",
              ]),
              snippet,
            });
          }),
          ...definedFields({ nextCursor: nonEmpty(cursor) }),
        };
      },
      async reply(
        ref: CommentRef,
        content: { text: string },
        context: AdapterOperationContext,
      ): Promise<CommentRef> {
        authorize(ref, context);

        let cursor: string | undefined;
        let parentSnippet: JsonObject | undefined;
        const seen = new Set<string>();

        do {
          const page = object(
            await request("/youtube/v3/commentThreads", context, undefined, {
              videoId: ref.postId,
              part: "snippet",
              maxResults: "100",
              ...definedFields({ pageToken: cursor }),
            }),
          );

          parentSnippet = array(page["items"])
            .map((value) => object(object(value)["snippet"]))
            .find((snippet) => object(snippet["topLevelComment"] ?? {})["id"] === ref.commentId);

          if (parentSnippet) break;

          cursor = nonEmpty(optionalString(page["nextPageToken"]));

          if (cursor) {
            if (seen.has(cursor))
              throw new SocialError({
                code: "upstream_failure",
                operation: "comments.write",
                message: "YouTube comment pagination did not terminate.",
              });
            seen.add(cursor);
          }
        } while (parentSnippet === undefined && cursor !== undefined);

        if (parentSnippet === undefined || parentSnippet["videoId"] !== ref.postId)
          throw new SocialError({
            code: "unauthorized",
            operation: "comments.write",
            message: "YouTube comment does not belong to the supplied video.",
          });

        const result = object(
          await request(
            "/youtube/v3/comments",
            context,
            { snippet: { parentId: ref.commentId, textOriginal: content.text } },
            { part: "snippet" },
          ),
        );

        return { ...ref, commentId: string(result["id"]) };
      },
    },
    native: {
      async resumeUpload(
        session: YouTubeUploadSession,
        media: MediaAttachment,
        context: AdapterOperationContext,
      ) {
        if (session.channelId !== options.auth.channelId)
          throw new SocialError({
            code: "unauthorized",
            operation: "youtube.upload",
            message: "Upload session belongs to another channel.",
          });

        const uploadOptions = {
          timeoutMs: Math.max(remainingBudget(context), 15 * 60_000),
          accessToken: options.auth.accessToken,
          ...definedFields({ fetch: options.fetch, signal: context.signal }),
        };

        const confirmed = await queryYouTubeUpload(session, uploadOptions);

        if (confirmed.state === "complete") return confirmed;

        return sendYouTubeUpload(session, media, uploadOptions, confirmed.nextByte);
      },
      async queryUpload(session: YouTubeUploadSession, context: AdapterOperationContext) {
        if (session.channelId !== options.auth.channelId)
          throw new SocialError({
            code: "unauthorized",
            operation: "youtube.upload",
            message: "Upload session belongs to another channel.",
          });

        return queryYouTubeUpload(session, {
          timeoutMs: remainingBudget(context),
          accessToken: options.auth.accessToken,
          ...definedFields({ fetch: options.fetch, signal: context.signal }),
        });
      },
      async setThumbnail({ videoId, thumbnail, context }) {
        nativeAuthorize(context);

        return binaryJson(
          "/upload/youtube/v3/thumbnails/set",
          context,
          mediaBlob(thumbnail),
          { videoId, uploadType: "media" },
          "POST",
          thumbnail.mimeType ?? "application/octet-stream",
        );
      },
      async captions({ action, videoId, captionId, caption, body, format, tlang, context }) {
        nativeAuthorize(context);

        if (action === "download") {
          if (!captionId)
            throw new SocialError({
              code: "invalid_input",
              operation: "captions.download",
              message: "captionId is required.",
            });

          const tfmt =
            optionalEnum(
              format,
              ["original", "sbv", "scc", "srt", "ttml", "vtt"],
              "format",
              "captions.download",
            ) ?? "vtt";

          if (tlang !== undefined && !languageTag.test(tlang))
            throw invalidInput("captions.download", "tlang must be a language code such as fr.");

          const url = new URL(
            `https://www.googleapis.com/youtube/v3/captions/${encodeURIComponent(captionId)}`,
          );

          if (tfmt !== "original") url.searchParams.set("tfmt", tfmt);

          if (tlang !== undefined) url.searchParams.set("tlang", tlang);

          return downloadBlob(
            url,
            context,
            "captions.download",
            "Caption download did not complete.",
          );
        }

        if (action === "insert" || action === "update") {
          if (action === "insert" && (!body || !caption))
            throw new SocialError({
              code: "invalid_input",
              operation: `captions.${action}`,
              message: "Caption metadata and media are required for insert.",
            });

          const snippet = object(body?.["snippet"] ?? {});

          if (
            action === "update" &&
            (Object.keys(body ?? {}).some((field) => field !== "id" && field !== "snippet") ||
              Object.keys(snippet).some((field) => field !== "isDraft") ||
              (snippet["isDraft"] !== undefined && !isBoolean(snippet["isDraft"])))
          )
            throw new SocialError({
              code: "invalid_input",
              operation: "captions.update",
              message: "Caption updates accept only id and a boolean snippet.isDraft.",
            });

          if (action === "update" && !caption && !isBoolean(snippet["isDraft"]))
            throw new SocialError({
              code: "invalid_input",
              operation: "captions.update",
              message: "Replacement media or an explicit isDraft change is required.",
            });

          if (action === "insert" && (!videoId || (snippet["videoId"] ?? videoId) !== videoId))
            throw new SocialError({
              code: "invalid_input",
              operation: "captions.insert",
              message: "videoId is required and must match body.snippet.videoId.",
            });

          const metadata: JsonObject =
            action === "update"
              ? {
                  id: captionId ?? body?.["id"] ?? null,
                  ...definedFields({
                    snippet:
                      snippet["isDraft"] === undefined
                        ? undefined
                        : { isDraft: snippet["isDraft"] },
                  }),
                }
              : { ...body, snippet: { ...snippet, videoId: videoId ?? null } };

          const part = action === "update" && snippet["isDraft"] === undefined ? "id" : "snippet";

          if (action === "update" && !isString(metadata["id"]))
            throw new SocialError({
              code: "invalid_input",
              operation: "captions.update",
              message: "captionId or body.id is required.",
            });

          if (action === "update" && !caption)
            return binaryJson(
              "/youtube/v3/captions",
              context,
              JSON.stringify(metadata),
              { part },
              "PUT",
              "application/json",
            );

          if (!caption)
            throw new SocialError({
              code: "invalid_input",
              operation: "captions.insert",
              message: "Caption media is required.",
            });

          const boundary = `youtube-caption-${crypto.randomUUID()}`;

          const media = mediaBlob(caption);

          const filename = (caption.filename ?? "captions.vtt").replace(/[\r\n]/gu, "");

          const encoded = new Blob([
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
            `--${boundary}\r\nContent-Type: ${caption.mimeType ?? "text/vtt"}\r\nContent-Disposition: attachment; filename="${filename}"\r\n\r\n`,
            media,
            `\r\n--${boundary}--\r\n`,
          ]);

          return binaryJson(
            "/upload/youtube/v3/captions",
            context,
            encoded,
            { uploadType: "multipart", part },
            action === "update" ? "PUT" : "POST",
            `multipart/related; boundary=${boundary}`,
          );
        }

        if (action === "delete") {
          if (!captionId)
            throw new SocialError({
              code: "invalid_input",
              operation: "captions.delete",
              message: "captionId is required.",
            });

          await request(
            "/youtube/v3/captions",
            context,
            undefined,
            { id: captionId ?? "" },
            "DELETE",
          );

          return {};
        }

        return object(
          await request(
            "/youtube/v3/captions",
            context,
            undefined,
            { part: "snippet", videoId },
            "GET",
          ),
        );
      },
      async playlists({
        action,
        playlistId,
        channelId,
        mine,
        pageToken,
        maxResults,
        body,
        context,
      }) {
        nativeAuthorize(context);

        const method =
          action === "list"
            ? "GET"
            : action === "delete"
              ? "DELETE"
              : action === "update"
                ? "PUT"
                : "POST";

        if ((action === "delete" || action === "update") && !playlistId)
          throw new SocialError({
            code: "invalid_input",
            operation: `playlists.${action}`,
            message: "playlistId is required.",
          });

        if (action === "delete") {
          await request(
            "/youtube/v3/playlists",
            context,
            undefined,
            { id: playlistId ?? "" },
            method,
          );

          return {};
        }

        return object(
          await request(
            "/youtube/v3/playlists",
            context,
            action === "list"
              ? undefined
              : writeResource(body, action === "update" ? playlistId : undefined, "playlists"),
            {
              part:
                action === "list"
                  ? "snippet,status,contentDetails"
                  : writeParts(body, ["snippet", "status"], "playlists"),
              ...definedFields(
                action === "list"
                  ? {
                      id: nonEmpty(playlistId),
                      channelId: nonEmpty(channelId),
                      // Listing with no playlist or channel filter defaults to the caller's playlists.
                      mine:
                        (action === "list" && !playlistId && !channelId) || mine
                          ? "true"
                          : undefined,
                      pageToken: nonEmpty(pageToken),
                      maxResults: maxResults ? String(maxResults) : undefined,
                    }
                  : {},
              ),
            },
            method,
          ),
        );
      },
      async playlistItems({ action, playlistId, playlistItemId, body, pageToken, context }) {
        nativeAuthorize(context);

        if (action === "update" && !playlistItemId)
          throw new SocialError({
            code: "invalid_input",
            operation: "playlistItems.update",
            message: "playlistItemId is required.",
          });

        const method =
          action === "list"
            ? "GET"
            : action === "delete"
              ? "DELETE"
              : action === "update"
                ? "PUT"
                : "POST";

        if (action === "delete") {
          if (!playlistItemId)
            throw new SocialError({
              code: "invalid_input",
              operation: "playlistItems.delete",
              message: "playlistItemId is required.",
            });

          await request(
            "/youtube/v3/playlistItems",
            context,
            undefined,
            { id: playlistItemId },
            method,
          );

          return {};
        }

        return object(
          await request(
            "/youtube/v3/playlistItems",
            context,
            action === "list"
              ? undefined
              : writeResource(
                  body,
                  action === "update" ? playlistItemId : undefined,
                  "playlistItems",
                ),
            {
              part:
                action === "list"
                  ? "snippet,contentDetails"
                  : writeParts(body, ["snippet", "contentDetails"], "playlistItems"),
              ...definedFields(
                action === "list"
                  ? {
                      playlistId: nonEmpty(playlistId),
                      id: nonEmpty(playlistItemId),
                      pageToken: nonEmpty(pageToken),
                    }
                  : {},
              ),
            },
            method,
          ),
        );
      },
      async updateVideo({ videoId, body, context }) {
        nativeAuthorize(context);

        if (!videoId)
          throw new SocialError({
            code: "invalid_input",
            operation: "videos.update",
            message: "videoId is required.",
          });

        if (
          Object.keys(body).some(
            (key) =>
              !["id", "snippet", "status", "recordingDetails", "localizations"].includes(key),
          ) ||
          (body["id"] !== undefined && body["id"] !== videoId)
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "videos.update",
            message:
              "Only snippet, status, recordingDetails and localizations patches with the selected ID are supported.",
          });

        const extraParts = (["recordingDetails", "localizations"] as const).filter(
          (part) => body[part] !== undefined,
        );

        const existing = await get(
          {
            kind: "platform-post",
            version: 1,
            backend: context.backendInstance,
            platform: "youtube",
            accountId: options.auth.channelId,
            postId: videoId,
          },
          context,
          extraParts,
        );

        const writablePart = (part: string, keys: readonly string[]): JsonObject => {
          const patch = object(body[part] ?? {});

          if (Object.keys(patch).some((key) => !keys.includes(key)))
            throw new SocialError({
              code: "invalid_input",
              operation: "videos.update",
              message: `Unsupported ${part} field.`,
            });

          const retained = { ...publicFields(existing[part], keys) };
          const tags = object(existing[part])["tags"];

          if (part === "snippet" && Array.isArray(tags) && tags.every(isString))
            retained["tags"] = tags;

          return Object.fromEntries(
            Object.entries({ ...retained, ...patch }).filter(([, value]) => value !== null),
          );
        };

        const snippet = writablePart("snippet", [
          "title",
          "description",
          "tags",
          "categoryId",
          "defaultLanguage",
          "defaultAudioLanguage",
        ]);

        const status = writablePart("status", [
          "privacyStatus",
          "license",
          "embeddable",
          "publicStatsViewable",
          "publishAt",
          "selfDeclaredMadeForKids",
          "containsSyntheticMedia",
        ]);

        if (
          !isString(snippet["title"]) ||
          !snippet["title"] ||
          !isString(snippet["categoryId"]) ||
          !snippet["categoryId"]
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "videos.update",
            message: "title and categoryId must be retained or supplied.",
          });

        const nextStatus = Object.fromEntries(
          Object.entries(status).filter(
            ([key]) => key !== "publishAt" || status["privacyStatus"] === "private",
          ),
        );

        // videos.update deletes omitted properties of a written part, so merge into the current
        // value; a null entry removes that recording date or localization.
        const mergePart = (part: "recordingDetails" | "localizations"): JsonObject => {
          const patch = body[part];

          if (!isJsonObject(patch))
            throw new SocialError({
              code: "invalid_input",
              operation: "videos.update",
              message: `${part} must be an object.`,
            });

          const valid =
            part === "recordingDetails"
              ? Object.entries(patch).every(
                  ([key, value]) =>
                    key === "recordingDate" &&
                    (value === null || (isString(value) && Number.isFinite(Date.parse(value)))),
                )
              : Object.entries(patch).every(
                  ([language, value]) =>
                    languageTag.test(language) &&
                    (value === null ||
                      (isJsonObject(value) &&
                        isString(value["title"]) &&
                        value["title"] !== "" &&
                        (value["description"] === undefined || isString(value["description"])))),
                );

          if (!valid)
            throw new SocialError({
              code: "invalid_input",
              operation: "videos.update",
              message:
                part === "recordingDetails"
                  ? "recordingDetails accepts only an ISO 8601 recordingDate or null."
                  : "localizations must map BCP-47 tags to { title, description? } or null.",
            });

          return Object.fromEntries(
            Object.entries({ ...optionalObject(existing[part]), ...patch }).filter(
              ([, value]) => value !== null,
            ),
          );
        };

        const extras = Object.fromEntries(extraParts.map((part) => [part, mergePart(part)]));

        if (extras["localizations"] !== undefined && snippet["defaultLanguage"] === undefined)
          throw new SocialError({
            code: "invalid_input",
            operation: "videos.update",
            message: "Set snippet.defaultLanguage before writing localizations.",
          });

        const merged = { id: videoId, snippet, status: nextStatus, ...extras };

        const part = ["snippet", "status", ...extraParts].join(",");

        return object(await request("/youtube/v3/videos", context, merged, { part }, "PUT"));
      },
      async updateProfile({ part, value, context }) {
        nativeAuthorize(context);

        const operation = "profile.update";

        const invalid = (message: string) =>
          new SocialError({ code: "invalid_input", operation, message });

        if (part !== "brandingSettings" && part !== "localizations")
          throw invalid("part must be brandingSettings or localizations.");

        if (!isJsonObject(value) || Object.keys(value).length === 0)
          throw invalid("value must be a non-empty object.");

        const channelPatch = value["channel"];
        const imagePatch = value["image"];

        // A new banner URL comes from uploadChannelBanner (channelBanners.insert).
        const bannerPatch = isJsonObject(imagePatch) ? imagePatch["bannerExternalUrl"] : undefined;

        if (
          part === "brandingSettings" &&
          (Object.keys(value).some((key) => key !== "channel" && key !== "image") ||
            (channelPatch !== undefined && !isJsonObject(channelPatch)) ||
            (imagePatch !== undefined &&
              (!isJsonObject(imagePatch) ||
                Object.keys(imagePatch).some((key) => key !== "bannerExternalUrl") ||
                !isString(bannerPatch) ||
                !bannerPatch.startsWith("https://"))))
        )
          throw invalid(
            "brandingSettings updates accept a channel object and an image object with an https bannerExternalUrl.",
          );

        if (
          part === "localizations" &&
          Object.entries(value).some(
            ([key, entry]) => key.trim() === "" || (entry !== null && !isJsonObject(entry)),
          )
        )
          throw invalid(
            "Each localization must be an object keyed by language, or null to remove it.",
          );

        // channels.update deletes omitted mutable properties, so merge into the current part.
        const merge = (current: JsonValue | undefined, patch: JsonObject): JsonObject =>
          Object.fromEntries(
            Object.entries({ ...optionalObject(current), ...patch }).filter(
              ([, entry]) => entry !== null,
            ),
          );

        const channel = array(
          object(
            await request("/youtube/v3/channels", context, undefined, {
              id: options.auth.channelId,
              part,
            }),
          )["items"],
        )
          .map(object)
          .find((item) => item["id"] === options.auth.channelId);

        if (!channel)
          throw new SocialError({
            code: "unauthorized",
            operation,
            message: "Configured channel is absent or inaccessible to this authorization.",
          });

        const branding = optionalObject(channel["brandingSettings"]) ?? {};

        // Resend only documented writable branding: the merged channel object and the new or
        // current banner URL, which channels.update would otherwise delete. Deprecated watch, hints, and
        // image fields are dropped; YouTube rejects some of them on write.
        const bannerExternalUrl = isString(bannerPatch)
          ? bannerPatch
          : optionalString(optionalObject(branding["image"])?.["bannerExternalUrl"]);

        const brandingNext = (patch: JsonObject): JsonObject => {
          const result: Record<string, JsonValue> = {};

          result["channel"] = merge(branding["channel"], patch);

          if (bannerExternalUrl !== undefined && bannerExternalUrl !== "")
            result["image"] = { bannerExternalUrl };

          return result;
        };

        const next =
          part === "brandingSettings"
            ? brandingNext(isJsonObject(channelPatch) ? channelPatch : {})
            : merge(channel["localizations"], value);

        return object(
          await request(
            "/youtube/v3/channels",
            context,
            { id: options.auth.channelId, [part]: next },
            { part },
            "PUT",
          ),
        );
      },
      async deleteVideo({ videoId, context }) {
        nativeAuthorize(context);

        if (!videoId)
          throw new SocialError({
            code: "invalid_input",
            operation: "videos.delete",
            message: "videoId is required.",
          });

        await get(
          {
            kind: "platform-post",
            version: 1,
            backend: context.backendInstance,
            platform: "youtube",
            accountId: options.auth.channelId,
            postId: videoId,
          },
          context,
        );
        await request("/youtube/v3/videos", context, undefined, { id: videoId }, "DELETE");
      },
      async rateVideo({ videoId, rating, context }) {
        nativeAuthorize(context);

        await request(
          "/youtube/v3/videos/rate",
          context,
          undefined,
          { id: videoId, rating },
          "POST",
        );
      },
      async getRating({ videoIds, context }) {
        nativeAuthorize(context);

        return object(
          await request("/youtube/v3/videos/getRating", context, undefined, {
            id: videoIds.join(","),
          }),
        );
      },
      async subscriptions({
        action,
        subscriptionId,
        channelId,
        subscribers,
        forChannelIds,
        order,
        maxResults,
        pageToken,
        context,
      }) {
        nativeAuthorize(context);

        const operation = `subscriptions.${action}`;

        if (subscribers !== undefined && (subscriptionId || channelId || action !== "list"))
          throw invalidInput(
            operation,
            "subscribers lists the configured channel's subscribers and cannot be combined with subscriptionId or channelId.",
          );

        const subscriberFilter = optionalEnum(
          subscribers,
          ["all", "recent"],
          "subscribers",
          operation,
        );

        const forChannelId =
          forChannelIds === undefined ? undefined : idList(forChannelIds, 50, operation);

        const listOrder = optionalEnum(
          order,
          ["alphabetical", "relevance", "unread"],
          "order",
          operation,
        );

        const listSize = pageSize(maxResults, 0, 50, operation);

        const method = action === "list" ? "GET" : action === "delete" ? "DELETE" : "POST";

        if (action === "delete" && !subscriptionId)
          throw new SocialError({
            code: "invalid_input",
            operation: "subscriptions.delete",
            message: "subscriptionId is required.",
          });

        if (action === "insert" && !channelId)
          throw new SocialError({
            code: "invalid_input",
            operation: "subscriptions.insert",
            message: "channelId is required.",
          });

        const insertBody =
          action === "insert" && channelId
            ? { snippet: { resourceId: { kind: "youtube#channel", channelId } } }
            : undefined;

        if (action === "delete") {
          await request(
            "/youtube/v3/subscriptions",
            context,
            undefined,
            { id: subscriptionId ?? "" },
            method,
          );

          return {};
        }

        return object(
          await request(
            "/youtube/v3/subscriptions",
            context,
            insertBody,
            {
              part:
                action === "insert"
                  ? "snippet"
                  : subscriberFilter
                    ? "snippet,contentDetails,subscriberSnippet"
                    : "snippet,contentDetails",
              // Filter by subscription, else by channel, else by subscribers, else list the
              // caller's own subscriptions.
              ...definedFields(
                action === "list"
                  ? {
                      id: nonEmpty(subscriptionId),
                      channelId: subscriptionId ? undefined : nonEmpty(channelId),
                      mine: subscriptionId || channelId || subscriberFilter ? undefined : "true",
                      mySubscribers: subscriberFilter === "all" ? "true" : undefined,
                      myRecentSubscribers: subscriberFilter === "recent" ? "true" : undefined,
                      forChannelId,
                      order: listOrder,
                      maxResults: listSize,
                      pageToken: nonEmpty(pageToken),
                    }
                  : {},
              ),
            },
            method,
          ),
        );
      },
      async search({
        q,
        type,
        channelId,
        order,
        publishedAfter,
        publishedBefore,
        pageToken,
        maxResults,
        eventType,
        regionCode,
        relevanceLanguage,
        safeSearch,
        videoDuration,
        videoDefinition,
        videoCaption,
        videoLicense,
        videoType,
        videoCategoryId,
        location,
        topicId,
        videoEmbeddable,
        videoSyndicated,
        videoDimension,
        videoPaidProductPlacement,
        channelType,
        forMine,
        forDeveloper,
        context,
      }) {
        nativeAuthorize(context);

        const operation = "search.keyword";

        if (forMine === true && forDeveloper === true)
          throw invalidInput(operation, "Set at most one of forMine and forDeveloper.");

        const area = location === undefined ? undefined : searchArea(location, operation);

        const videoFilters = definedFields({
          eventType: optionalEnum(
            eventType,
            ["completed", "live", "upcoming"],
            "eventType",
            operation,
          ),
          videoDuration: optionalEnum(
            videoDuration,
            ["any", "long", "medium", "short"],
            "videoDuration",
            operation,
          ),
          videoDefinition: optionalEnum(
            videoDefinition,
            ["any", "high", "standard"],
            "videoDefinition",
            operation,
          ),
          videoCaption: optionalEnum(
            videoCaption,
            ["any", "closedCaption", "none"],
            "videoCaption",
            operation,
          ),
          videoLicense: optionalEnum(
            videoLicense,
            ["any", "creativeCommon", "youtube"],
            "videoLicense",
            operation,
          ),
          videoType: optionalEnum(videoType, ["any", "episode", "movie"], "videoType", operation),
          videoCategoryId: nonEmpty(videoCategoryId),
          videoEmbeddable: optionalEnum(
            videoEmbeddable,
            ["any", "true"],
            "videoEmbeddable",
            operation,
          ),
          videoSyndicated: optionalEnum(
            videoSyndicated,
            ["any", "true"],
            "videoSyndicated",
            operation,
          ),
          videoDimension: optionalEnum(
            videoDimension,
            ["2d", "3d", "any"],
            "videoDimension",
            operation,
          ),
          videoPaidProductPlacement: optionalEnum(
            videoPaidProductPlacement,
            ["any", "true"],
            "videoPaidProductPlacement",
            operation,
          ),
          location: area?.location,
          locationRadius: area?.locationRadius,
        });

        if ((Object.keys(videoFilters).length > 0 || forMine === true) && type !== "video")
          throw invalidInput(
            operation,
            'forMine, eventType, location and the video* filters require type: "video".',
          );

        // search.list rejects these eight filters together with forMine.
        const ownerExcluded = [
          "videoDefinition",
          "videoDimension",
          "videoDuration",
          "videoEmbeddable",
          "videoLicense",
          "videoPaidProductPlacement",
          "videoSyndicated",
          "videoType",
        ];

        if (
          forMine === true &&
          Object.keys(videoFilters).some((key) => ownerExcluded.includes(key))
        )
          throw invalidInput(
            operation,
            `forMine cannot be combined with ${ownerExcluded.join(", ")}.`,
          );

        if (regionCode !== undefined && !regionPattern.test(regionCode))
          throw invalidInput(operation, "regionCode must be an ISO 3166-1 alpha-2 code.");

        if (relevanceLanguage !== undefined && !languageTag.test(relevanceLanguage))
          throw invalidInput(operation, "relevanceLanguage must be a language code such as en.");

        return object(
          await request("/youtube/v3/search", context, undefined, {
            part: "snippet",
            q,
            ...definedFields({
              type: nonEmpty(type),
              channelId: nonEmpty(channelId),
              order: nonEmpty(order),
              publishedAfter: nonEmpty(publishedAfter),
              publishedBefore: nonEmpty(publishedBefore),
              pageToken: nonEmpty(pageToken),
              maxResults: maxResults ? String(maxResults) : undefined,
              regionCode,
              relevanceLanguage,
              safeSearch: optionalEnum(
                safeSearch,
                ["moderate", "none", "strict"],
                "safeSearch",
                operation,
              ),
              topicId: nonEmpty(topicId),
              channelType: optionalEnum(channelType, ["any", "show"], "channelType", operation),
              forMine: forMine === true ? "true" : undefined,
              forDeveloper: forDeveloper === true ? "true" : undefined,
            }),
            ...videoFilters,
          }),
        );
      },
      async commentsModeration({ action, commentId, moderationStatus, banAuthor, body, context }) {
        nativeAuthorize(context);

        if (!commentId)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.moderate",
            message: "commentId is required.",
          });

        if (action === "setModerationStatus") {
          await request(
            "/youtube/v3/comments/setModerationStatus",
            context,
            undefined,
            {
              id: commentId,
              moderationStatus:
                moderationStatus ??
                (() => {
                  throw new SocialError({
                    code: "invalid_input",
                    operation: "comments.moderate",
                    message: "moderationStatus is required.",
                  });
                })(),
              ...definedFields({ banAuthor: banAuthor ? "true" : undefined }),
            },
            "POST",
          );

          return;
        }

        if (action === "delete") {
          await request("/youtube/v3/comments", context, undefined, { id: commentId }, "DELETE");

          return;
        }

        if (!body || (body["id"] ?? commentId) !== commentId)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.update",
            message: "Provide a comment body whose id, if present, matches commentId.",
          });

        return object(
          await request(
            "/youtube/v3/comments",
            context,
            { ...body, id: commentId },
            { part: "snippet" },
            "PUT",
          ),
        );
      },
      async deleteComment({ account, commentId, context }) {
        // Source: https://developers.google.com/youtube/v3/docs/comments/delete (accessed 2026-09-24).
        authorize(account, context);

        if (!commentId.trim())
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.delete",
            message: "commentId is required.",
          });

        await request("/youtube/v3/comments", context, undefined, { id: commentId }, "DELETE");
      },
      async heldComments({ moderationStatus, pageToken, maxResults, context }) {
        nativeAuthorize(context);

        return object(
          await request("/youtube/v3/commentThreads", context, undefined, {
            part: "snippet",
            moderationStatus:
              optionalEnum(
                moderationStatus,
                ["heldForReview", "likelySpam"],
                "moderationStatus",
                "comments.moderate",
              ) ?? "heldForReview",
            allThreadsRelatedToChannelId: options.auth.channelId,
            ...definedFields({
              pageToken: nonEmpty(pageToken),
              maxResults: maxResults ? String(maxResults) : undefined,
            }),
          }),
        );
      },
      async analytics({ query, context }) {
        return object(await analyticsRequest("/v2/reports", context, undefined, query));
      },
      async liveBroadcasts({
        action,
        body,
        id,
        broadcastStatus,
        streamId,
        cuepoint,
        statusFilter,
        broadcastType,
        maxResults,
        pageToken,
        context,
      }) {
        nativeAuthorize(context);

        const operation = "live.broadcasts";

        if (
          action !== "list" &&
          (statusFilter ?? broadcastType ?? maxResults ?? pageToken) !== undefined
        )
          throw invalidInput(
            operation,
            "statusFilter, broadcastType, maxResults and pageToken apply only to list.",
          );

        if (action === "delete") {
          if (!id?.trim()) throw invalidInput(operation, "id is required for delete.");

          await request("/youtube/v3/liveBroadcasts", context, undefined, { id }, "DELETE");

          return {};
        }

        if (action === "update") {
          if (!id?.trim()) throw invalidInput(operation, "id is required for update.");

          // liveBroadcasts.update deletes omitted mutable properties of each written part.
          const resource = writeResource(body, id, operation);

          return object(
            await request(
              "/youtube/v3/liveBroadcasts",
              context,
              resource,
              {
                part: writeParts(
                  resource,
                  ["snippet", "status", "contentDetails", "monetizationDetails"],
                  operation,
                ),
              },
              "PUT",
            ),
          );
        }

        if (action === "bind") {
          if (!id?.trim()) throw invalidInput(operation, "id is required for bind.");

          return object(
            await request(
              "/youtube/v3/liveBroadcasts/bind",
              context,
              undefined,
              {
                id,
                part: "id,snippet,contentDetails,status",
                ...definedFields({ streamId: nonEmpty(streamId?.trim()) }),
              },
              "POST",
            ),
          );
        }

        if (action === "cuepoint") {
          if (!id?.trim()) throw invalidInput(operation, "id is required for cuepoint.");

          const durationSecs = cuepoint?.durationSecs;
          const offset = cuepoint?.insertionOffsetTimeMs;
          const walltime = cuepoint?.walltimeMs;

          if (
            (durationSecs !== undefined &&
              (!Number.isSafeInteger(durationSecs) || durationSecs <= 0)) ||
            (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) ||
            (walltime !== undefined && (!Number.isSafeInteger(walltime) || walltime <= 0)) ||
            (offset !== undefined && walltime !== undefined)
          )
            throw invalidInput(
              operation,
              "cuepoint needs a positive integer durationSecs and at most one of insertionOffsetTimeMs and walltimeMs.",
            );

          return object(
            await request(
              "/youtube/v3/liveBroadcasts/cuepoint",
              context,
              {
                cueType: "cueTypeAd",
                ...definedFields({
                  durationSecs,
                  insertionOffsetTimeMs: offset,
                  walltimeMs: walltime,
                }),
              },
              { id },
              "POST",
            ),
          );
        }

        if (action === "list") {
          // liveBroadcasts.list takes exactly one of id, mine and broadcastStatus.
          if (id && statusFilter !== undefined)
            throw invalidInput(operation, "Use either id or statusFilter, not both.");

          const filter = optionalEnum(
            statusFilter,
            ["active", "all", "completed", "upcoming"],
            "statusFilter",
            operation,
          );

          return object(
            await request("/youtube/v3/liveBroadcasts", context, undefined, {
              part: "snippet,status,contentDetails",
              ...(id ? { id } : filter ? { broadcastStatus: filter } : { mine: "true" }),
              ...definedFields({
                broadcastType: optionalEnum(
                  broadcastType,
                  ["all", "event", "persistent"],
                  "broadcastType",
                  operation,
                ),
                maxResults: pageSize(maxResults, 0, 50, operation),
                pageToken: nonEmpty(pageToken),
              }),
            }),
          );
        }

        if (action === "transition") {
          if (!id || !broadcastStatus)
            throw new SocialError({
              code: "invalid_input",
              operation: "live.broadcasts",
              message: "id and broadcastStatus are required.",
            });

          return object(
            await request(
              "/youtube/v3/liveBroadcasts/transition",
              context,
              undefined,
              { part: "snippet,status", id, broadcastStatus },
              "POST",
            ),
          );
        }

        return object(
          await request(
            "/youtube/v3/liveBroadcasts",
            context,
            body,
            {
              part:
                body?.["contentDetails"] === undefined
                  ? "snippet,status"
                  : "snippet,status,contentDetails",
            },
            "POST",
          ),
        );
      },
      async liveChatMessages({
        action,
        liveChatId,
        messageId,
        pageToken,
        maxResults,
        hl,
        profileImageSize,
        body,
        context,
      }) {
        nativeAuthorize(context);

        if (action === "closePoll") {
          const id = messageId?.trim();

          if (!id) throw invalidInput("live.chat.messages", "messageId of the poll is required.");

          // Closing is the only documented transition; part=snippet returns the final tallies.
          return object(
            await request(
              "/youtube/v3/liveChat/messages/transition",
              context,
              undefined,
              { id, status: "closed", part: "snippet" },
              "POST",
            ),
          );
        }

        if (action === "list") {
          const chatId = liveChatId?.trim();

          if (!chatId)
            throw new SocialError({
              code: "invalid_input",
              operation: "live.chat.messages",
              message: "liveChatId is required for list.",
            });

          if (
            maxResults !== undefined &&
            (!Number.isInteger(maxResults) || maxResults < 200 || maxResults > 2000)
          )
            throw new SocialError({
              code: "invalid_input",
              operation: "live.chat.messages",
              message: "maxResults must be an integer between 200 and 2000.",
            });

          return object(
            await request("/youtube/v3/liveChat/messages", context, undefined, {
              liveChatId: chatId,
              part: "snippet,authorDetails",
              ...definedFields({
                pageToken: nonEmpty(pageToken),
                maxResults: maxResults ? String(maxResults) : undefined,
                ...chatDisplayOptions(hl, profileImageSize, "live.chat.messages"),
              }),
            }),
          );
        }

        const id = messageId?.trim();

        if (action === "delete") {
          requireLiveChatId(liveChatId, "live.chat.messages");

          if (!id)
            throw new SocialError({
              code: "invalid_input",
              operation: "live.chat.messages",
              message: "messageId is required.",
            });
          await request("/youtube/v3/liveChat/messages", context, undefined, { id }, "DELETE");

          return;
        }

        if (!body)
          throw new SocialError({
            code: "invalid_input",
            operation: "live.chat.messages",
            message: "A live chat message body is required.",
          });
        const chatId = bodyLiveChatId(body, "live.chat.messages");

        if (liveChatId !== undefined && liveChatId.trim() !== chatId)
          throw new SocialError({
            code: "invalid_input",
            operation: "live.chat.messages",
            message: "liveChatId must match body.snippet.liveChatId.",
          });

        return object(
          await request(
            "/youtube/v3/liveChat/messages",
            context,
            body,
            { part: "snippet" },
            "POST",
          ),
        );
      },
      async *liveChatStream({
        liveChatId,
        pageToken,
        hl,
        profileImageSize,
        stallTimeoutMs,
        context,
      }) {
        nativeAuthorize(context);

        const chatId = requireLiveChatId(liveChatId, "live.chat.stream");

        if (
          stallTimeoutMs !== undefined &&
          (!Number.isSafeInteger(stallTimeoutMs) || stallTimeoutMs < 1)
        )
          throw invalidInput("live.chat.stream", "stallTimeoutMs must be a positive integer.");

        const url = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages/stream");

        const query = {
          liveChatId: chatId,
          part: "id,snippet,authorDetails",
          ...definedFields({
            pageToken: nonEmpty(pageToken),
            ...chatDisplayOptions(hl, profileImageSize, "live.chat.stream"),
          }),
        };

        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

        yield* readLiveChatStream(
          {
            url,
            accessToken: options.auth.accessToken,
            ...definedFields({ fetch: options.fetch, stallTimeoutMs }),
          },
          context,
        );
      },
      async liveChatModerators({
        action,
        liveChatId,
        moderatorId,
        pageToken,
        maxResults,
        body,
        context,
      }) {
        nativeAuthorize(context);

        if (action === "list") {
          const chatId = liveChatId?.trim();

          if (!chatId)
            throw new SocialError({
              code: "invalid_input",
              operation: "live.chat.moderators",
              message: "liveChatId is required for list.",
            });

          return object(
            await request("/youtube/v3/liveChat/moderators", context, undefined, {
              liveChatId: chatId,
              part: "snippet",
              ...definedFields({
                pageToken: nonEmpty(pageToken),
                maxResults: maxResults ? String(maxResults) : undefined,
              }),
            }),
          );
        }

        const id = moderatorId?.trim();

        if (action === "delete") {
          const chatId = requireLiveChatId(liveChatId, "live.chat.moderators");

          if (!id)
            throw new SocialError({
              code: "invalid_input",
              operation: "live.chat.moderators",
              message: "moderatorId is required.",
            });
          await assertLiveChatModerator(chatId, id, context, "live.chat.moderators");
          await request("/youtube/v3/liveChat/moderators", context, undefined, { id }, "DELETE");

          return;
        }

        if (!body)
          throw new SocialError({
            code: "invalid_input",
            operation: "live.chat.moderators",
            message: "A live chat moderator body is required.",
          });
        const chatId = bodyLiveChatId(body, "live.chat.moderators");

        if (liveChatId !== undefined && liveChatId.trim() !== chatId)
          throw new SocialError({
            code: "invalid_input",
            operation: "live.chat.moderators",
            message: "liveChatId must match body.snippet.liveChatId.",
          });

        return object(
          await request(
            "/youtube/v3/liveChat/moderators",
            context,
            body,
            { part: "snippet" },
            "POST",
          ),
        );
      },
      async liveChatBans({ action, banId, body, context }) {
        nativeAuthorize(context);
        const id = banId?.trim();

        if (action === "delete") {
          if (!id)
            throw new SocialError({
              code: "invalid_input",
              operation: "live.chat.bans",
              message: "banId is required.",
            });
          await request("/youtube/v3/liveChat/bans", context, undefined, { id }, "DELETE");

          return;
        }

        if (!body)
          throw new SocialError({
            code: "invalid_input",
            operation: "live.chat.bans",
            message: "A live chat ban body is required.",
          });
        bodyLiveChatId(body, "live.chat.bans");

        return object(
          await request("/youtube/v3/liveChat/bans", context, body, { part: "snippet" }, "POST"),
        );
      },
      async channelSections({
        action,
        channelSectionId,
        channelId,
        hl,
        pageToken,
        maxResults,
        body,
        context,
      }) {
        nativeAuthorize(context);
        const id = channelSectionId?.trim();

        const otherChannel = channelId?.trim();

        if (action !== "list" && (channelId ?? hl) !== undefined)
          throw invalidInput("channel.sections.write", "channelId and hl apply only to list.");

        if (channelId !== undefined && (!otherChannel || id !== undefined))
          throw invalidInput(
            "channel.sections.read",
            "Supply a non-empty channelId or a channelSectionId, not both.",
          );

        if (hl !== undefined && !languageTag.test(hl))
          throw invalidInput("channel.sections.read", "hl must be a language code such as fr.");

        if (channelSectionId !== undefined && !id)
          throw new SocialError({
            code: "invalid_input",
            operation: "channel.sections.read",
            message: "channelSectionId cannot be blank.",
          });

        if (action === "list") {
          const result = object(
            await request("/youtube/v3/channelSections", context, undefined, {
              part: "snippet,contentDetails",
              ...definedFields({
                id,
                channelId: id === undefined ? (otherChannel ?? options.auth.channelId) : undefined,
                hl,
                pageToken: nonEmpty(pageToken),
                maxResults: maxResults ? String(maxResults) : undefined,
              }),
            }),
          );

          if (id !== undefined) assertChannelSectionResult(result, id);

          return result;
        }

        if (action === "delete") {
          if (!id)
            throw new SocialError({
              code: "invalid_input",
              operation: "channel.sections.write",
              message: "channelSectionId is required.",
            });
          await assertChannelSection(id, context);
          await request("/youtube/v3/channelSections", context, undefined, { id }, "DELETE");

          return;
        }

        if (action === "update" && !id)
          throw new SocialError({
            code: "invalid_input",
            operation: "channel.sections.write",
            message: "channelSectionId is required for update.",
          });

        const resource = writeResource(body, id, "channel.sections.write");
        const part = writeParts(resource, ["snippet", "contentDetails"], "channel.sections.write");

        const resourceChannelId =
          resource["snippet"] === undefined
            ? undefined
            : optionalString(object(resource["snippet"])["channelId"]);

        if (resourceChannelId !== undefined && resourceChannelId !== options.auth.channelId)
          throw new SocialError({
            code: "unauthorized",
            operation: "channel.sections.write",
            message: "The channel section body does not belong to the configured channel.",
          });

        if (action === "update") {
          if (!id)
            throw new SocialError({
              code: "invalid_input",
              operation: "channel.sections.write",
              message: "channelSectionId is required for update.",
            });
          await assertChannelSection(id, context);
        }

        return object(
          await request(
            "/youtube/v3/channelSections",
            context,
            resource,
            { part },
            action === "insert" ? "POST" : "PUT",
          ),
        );
      },
      async uploadChannelBanner({ image, context }) {
        nativeAuthorize(context);

        const { blob, mimeType } = uploadImage(image, 6 * 1024 * 1024, "channelBanners.insert");

        const result = await binaryJson(
          "/upload/youtube/v3/channelBanners/insert",
          context,
          blob,
          { uploadType: "media" },
          "POST",
          mimeType,
        );

        string(result["url"]);

        return result;
      },
      async watermarks(input) {
        nativeAuthorize(input.context);

        const operation = `watermarks.${input.action}`;

        if (input.action === "unset") {
          await request(
            "/youtube/v3/watermarks/unset",
            input.context,
            undefined,
            { channelId: options.auth.channelId },
            "POST",
          );

          return;
        }

        const { type, offsetMs, durationMs } = input.timing;

        if (
          (type !== "offsetFromStart" && type !== "offsetFromEnd") ||
          !Number.isSafeInteger(offsetMs) ||
          offsetMs < (type === "offsetFromEnd" ? 1000 : 0) ||
          (durationMs !== undefined &&
            (!Number.isSafeInteger(durationMs) ||
              durationMs < 1000 ||
              (type === "offsetFromEnd" && durationMs > offsetMs)))
        )
          throw invalidInput(
            operation,
            "timing needs a type, an integer offsetMs (at least 1000 from the end), and a durationMs of at least 1000 that fits before the end.",
          );

        const { blob, mimeType } = uploadImage(input.image, 10 * 1024 * 1024, operation);

        const upload = multipartBody(
          {
            timing: { type, offsetMs, ...definedFields({ durationMs }) },
            ...definedFields({ targetChannelId: nonEmpty(input.targetChannelId?.trim()) }),
          },
          blob,
          mimeType,
        );

        await binarySend(
          "/upload/youtube/v3/watermarks/set",
          input.context,
          upload.body,
          { channelId: options.auth.channelId, uploadType: "multipart" },
          "POST",
          upload.contentType,
        );
      },
      async playlistImages(input) {
        nativeAuthorize(input.context);

        const operation = `playlistImages.${input.action}`;

        if (input.action === "list") {
          if (!input.playlistId.trim()) throw invalidInput(operation, "playlistId is required.");

          // The discovery document (revision 20261103) names the playlist filter `parent`.
          return object(
            await request("/youtube/v3/playlistImages", input.context, undefined, {
              part: "id,snippet",
              parent: input.playlistId,
              ...definedFields({
                pageToken: nonEmpty(input.pageToken),
                maxResults: pageSize(input.maxResults, 0, 50, operation),
              }),
            }),
          );
        }

        if (input.action === "delete") {
          const id = input.playlistImageId.trim();

          if (!id) throw invalidInput(operation, "playlistImageId is required.");

          await request("/youtube/v3/playlistImages", input.context, undefined, { id }, "DELETE");

          return {};
        }

        if (!input.playlistId.trim()) throw invalidInput(operation, "playlistId is required.");

        if (input.action === "update" && !input.playlistImageId.trim())
          throw invalidInput(operation, "playlistImageId is required.");

        const { blob, mimeType } = uploadImage(input.image, 50 * 1024 * 1024, operation);

        const snippet = { playlistId: input.playlistId, type: "hero" };

        const upload = multipartBody(
          input.action === "update" ? { id: input.playlistImageId, snippet } : { snippet },
          blob,
          mimeType,
        );

        return binaryJson(
          "/upload/youtube/v3/playlistImages",
          input.context,
          upload.body,
          { part: "id,snippet", uploadType: "multipart" },
          input.action === "update" ? "PUT" : "POST",
          upload.contentType,
        );
      },
      async members({
        mode,
        filterByMemberChannelIds,
        hasAccessToLevel,
        pageToken,
        maxResults,
        context,
      }) {
        nativeAuthorize(context);

        const operation = "members.list";

        return object(
          await request("/youtube/v3/members", context, undefined, {
            part: "snippet",
            ...definedFields({
              mode: optionalEnum(mode, ["all_current", "updates"], "mode", operation),
              filterByMemberChannelId:
                filterByMemberChannelIds === undefined
                  ? undefined
                  : idList(filterByMemberChannelIds, 100, operation),
              hasAccessToLevel: nonEmpty(hasAccessToLevel),
              pageToken: nonEmpty(pageToken),
              maxResults: pageSize(maxResults, 0, 1000, operation),
            }),
          }),
        );
      },
      async membershipsLevels({ context }) {
        nativeAuthorize(context);

        return object(
          await request("/youtube/v3/membershipsLevels", context, undefined, {
            part: "id,snippet",
          }),
        );
      },
      async analyticsGroups(input) {
        nativeAuthorize(input.context);

        const operation = `analytics.groups.${input.action}`;

        if (input.action === "list")
          return object(
            await analyticsRequest("/v2/groups", input.context, undefined, {
              ...(input.ids === undefined
                ? { mine: "true" }
                : { id: idList(input.ids, 50, operation) }),
              ...definedFields({ pageToken: nonEmpty(input.pageToken) }),
            }),
          );

        if (input.action === "delete") {
          const id = input.groupId.trim();

          if (!id) throw invalidInput(operation, "groupId is required.");

          await analyticsRequest("/v2/groups", input.context, undefined, { id }, "DELETE");

          return {};
        }

        if (!input.title.trim()) throw invalidInput(operation, "title must be non-empty.");

        if (input.action === "update") {
          if (!input.groupId.trim()) throw invalidInput(operation, "groupId is required.");

          return object(
            await analyticsRequest(
              "/v2/groups",
              input.context,
              { id: input.groupId, snippet: { title: input.title } },
              {},
              "PUT",
            ),
          );
        }

        if (!isOneOf(["youtube#channel", "youtube#playlist", "youtube#video"], input.itemType))
          throw invalidInput(
            operation,
            "itemType must be youtube#channel, youtube#playlist, or youtube#video.",
          );

        return object(
          await analyticsRequest(
            "/v2/groups",
            input.context,
            { snippet: { title: input.title }, contentDetails: { itemType: input.itemType } },
            {},
            "POST",
          ),
        );
      },
      async analyticsGroupItems(input) {
        nativeAuthorize(input.context);

        const operation = `analytics.groupItems.${input.action}`;

        if (input.action === "delete") {
          const id = input.groupItemId.trim();

          if (!id) throw invalidInput(operation, "groupItemId is required.");

          await analyticsRequest("/v2/groupItems", input.context, undefined, { id }, "DELETE");

          return {};
        }

        const groupId = input.groupId.trim();

        if (!groupId) throw invalidInput(operation, "groupId is required.");

        if (input.action === "list")
          return object(
            await analyticsRequest("/v2/groupItems", input.context, undefined, { groupId }),
          );

        const { kind, id } = input.resource;

        if (!isOneOf(["youtube#channel", "youtube#playlist", "youtube#video"], kind) || !id.trim())
          throw invalidInput(
            operation,
            "resource needs a kind of youtube#channel, youtube#playlist, or youtube#video and an id.",
          );

        const inserted = await analyticsRequest(
          "/v2/groupItems",
          input.context,
          { groupId, resource: { kind, id } },
          {},
          "POST",
        );

        // Google answers 204 No Content when the item was already in the group; that is success.
        // Source, accessed 2026-11-04:
        // https://developers.google.com/youtube/analytics/reference/groupItems/insert#response
        return inserted === null ? { alreadyInGroup: true } : object(inserted);
      },
      async reportTypes({ includeSystemManaged, pageSize, pageToken, context }) {
        nativeAuthorize(context);

        return object(
          await reportingRequest("/v1/reportTypes", context, undefined, {
            ...definedFields({
              includeSystemManaged:
                includeSystemManaged === undefined ? undefined : String(includeSystemManaged),
              pageSize: pageSize === undefined ? undefined : String(pageSize),
              pageToken: nonEmpty(pageToken),
            }),
          }),
        );
      },
      async reportingJobs(input) {
        nativeAuthorize(input.context);

        const operation = `reporting.jobs.${input.action}`;

        if (input.action === "list")
          return object(
            await reportingRequest("/v1/jobs", input.context, undefined, {
              ...definedFields({
                includeSystemManaged:
                  input.includeSystemManaged === undefined
                    ? undefined
                    : String(input.includeSystemManaged),
                pageSize: input.pageSize === undefined ? undefined : String(input.pageSize),
                pageToken: nonEmpty(input.pageToken),
              }),
            }),
          );

        if (input.action === "create") {
          if (!input.reportTypeId.trim() || !input.name.trim() || [...input.name].length > 100)
            throw invalidInput(
              operation,
              "reportTypeId and a name of 1 to 100 characters are required.",
            );

          return object(
            await reportingRequest(
              "/v1/jobs",
              input.context,
              { reportTypeId: input.reportTypeId, name: input.name },
              {},
              "POST",
            ),
          );
        }

        if (!input.jobId.trim()) throw invalidInput(operation, "jobId is required.");

        const path = `/v1/jobs/${encodeURIComponent(input.jobId)}`;

        if (input.action === "delete") {
          await reportingRequest(path, input.context, undefined, {}, "DELETE");

          return {};
        }

        return object(await reportingRequest(path, input.context, undefined, {}));
      },
      async reports(input) {
        nativeAuthorize(input.context);

        const operation = `reporting.reports.${input.action}`;

        if (!input.jobId.trim()) throw invalidInput(operation, "jobId is required.");

        const base = `/v1/jobs/${encodeURIComponent(input.jobId)}/reports`;

        if (input.action === "get") {
          if (!input.reportId.trim()) throw invalidInput(operation, "reportId is required.");

          return object(
            await reportingRequest(
              `${base}/${encodeURIComponent(input.reportId)}`,
              input.context,
              undefined,
              {},
            ),
          );
        }

        for (const time of [input.createdAfter, input.startTimeAtOrAfter, input.startTimeBefore])
          if (time !== undefined && !Number.isFinite(Date.parse(time)))
            throw invalidInput(operation, "Report time filters must be RFC 3339 timestamps.");

        return object(
          await reportingRequest(base, input.context, undefined, {
            ...definedFields({
              createdAfter: nonEmpty(input.createdAfter),
              startTimeAtOrAfter: nonEmpty(input.startTimeAtOrAfter),
              startTimeBefore: nonEmpty(input.startTimeBefore),
              pageSize: input.pageSize === undefined ? undefined : String(input.pageSize),
              pageToken: nonEmpty(input.pageToken),
            }),
          }),
        );
      },
      async downloadReport({ downloadUrl, context }) {
        nativeAuthorize(context);

        const operation = "reporting.media.download";

        const url = URL.canParse(downloadUrl) ? new URL(downloadUrl) : undefined;

        // Send the token only to the Reporting API's own media route.
        if (
          url?.origin !== "https://youtubereporting.googleapis.com" ||
          !url.pathname.startsWith("/v1/media/") ||
          url.username ||
          url.password
        )
          throw invalidInput(
            operation,
            "downloadUrl must be a https://youtubereporting.googleapis.com/v1/media/ URL from a report.",
          );

        return downloadBlob(url, context, operation, "Report download did not complete.");
      },
      async liveStreams({ action, ids, streamId, body, pageToken, maxResults, context }) {
        nativeAuthorize(context);

        const operation = "live.streams";
        const id = streamId?.trim();

        if (action === "list")
          return object(
            await request("/youtube/v3/liveStreams", context, undefined, {
              part: "id,snippet,cdn,status",
              ...(ids === undefined ? { mine: "true" } : { id: idList(ids, 50, operation) }),
              ...definedFields({
                pageToken: nonEmpty(pageToken),
                maxResults: pageSize(maxResults, 0, 50, operation),
              }),
            }),
          );

        if (action === "delete") {
          if (!id) throw invalidInput(operation, "streamId is required for delete.");

          await request("/youtube/v3/liveStreams", context, undefined, { id }, "DELETE");

          return {};
        }

        if (action === "update" && !id)
          throw invalidInput(operation, "streamId is required for update.");

        const resource = writeResource(body, action === "update" ? id : undefined, operation);

        const snippet = optionalObject(resource["snippet"]);
        const cdn = optionalObject(resource["cdn"]);
        const title = snippet?.["title"];

        if (
          action === "insert" &&
          (!isString(title) ||
            title === "" ||
            [...title].length > 128 ||
            !isString(cdn?.["ingestionType"]) ||
            !isString(cdn?.["resolution"]) ||
            !isString(cdn?.["frameRate"]))
        )
          throw invalidInput(
            operation,
            "Insert needs snippet.title (1 to 128 characters) and cdn.ingestionType, cdn.resolution and cdn.frameRate.",
          );

        return object(
          await request(
            "/youtube/v3/liveStreams",
            context,
            resource,
            { part: writeParts(resource, ["snippet", "cdn", "contentDetails"], operation) },
            action === "insert" ? "POST" : "PUT",
          ),
        );
      },
      async superChatEvents({ hl, pageToken, maxResults, context }) {
        nativeAuthorize(context);

        return object(
          await request("/youtube/v3/superChatEvents", context, undefined, {
            part: "snippet",
            ...definedFields({
              hl: nonEmpty(hl),
              pageToken: nonEmpty(pageToken),
              maxResults: pageSize(maxResults, 1, 50, "live.superChat.read"),
            }),
          }),
        );
      },
      async videos({ filter, parts, hl, maxWidth, maxHeight, pageToken, maxResults, context }) {
        nativeAuthorize(context);

        const operation = "videos.list";

        const selectedParts = parts ?? ["snippet", "contentDetails", "statistics"];

        const playerSize = definedFields({
          maxWidth: embedSize(maxWidth, "maxWidth", operation),
          maxHeight: embedSize(maxHeight, "maxHeight", operation),
        });

        if (Object.keys(playerSize).length > 0 && !selectedParts.includes("player"))
          throw invalidInput(operation, 'maxWidth and maxHeight need the "player" part.');

        const selection =
          filter.kind === "id"
            ? { id: idList(filter.ids, 50, operation) }
            : filter.kind === "mostPopular"
              ? {
                  chart: "mostPopular",
                  ...definedFields({
                    regionCode: filter.regionCode,
                    videoCategoryId: nonEmpty(filter.videoCategoryId),
                  }),
                }
              : {
                  myRating:
                    optionalEnum(filter.rating, ["like", "dislike"], "rating", operation) ??
                    (() => {
                      throw invalidInput(operation, "rating must be like or dislike.");
                    })(),
                };

        if (
          filter.kind === "mostPopular" &&
          filter.regionCode !== undefined &&
          !regionPattern.test(filter.regionCode)
        )
          throw invalidInput(operation, "regionCode must be an ISO 3166-1 alpha-2 code.");

        // YouTube ignores paging for an ID lookup, so reject it rather than imply it applies.
        if (filter.kind === "id" && (pageToken !== undefined || maxResults !== undefined))
          throw invalidInput(operation, "pageToken and maxResults do not apply to an ID lookup.");

        return object(
          await request("/youtube/v3/videos", context, undefined, {
            part: partList(selectedParts, videoParts, operation),
            ...selection,
            ...playerSize,
            ...definedFields({
              hl: nonEmpty(hl),
              pageToken: nonEmpty(pageToken),
              maxResults: pageSize(maxResults, 1, 50, operation),
            }),
          }),
        );
      },
      async batchGetStats({ videoIds, parts, context }) {
        nativeAuthorize(context);

        const operation = "videos.batchGetStats";

        const result = object(
          await request("/youtube/v3/videos:batchGetStats", context, undefined, {
            id: idList(videoIds, 50, operation),
            part: partList(
              parts ?? ["statistics"],
              ["contentDetails", "id", "snippet", "statistics"],
              operation,
            ),
          }),
        );

        // Decode the documented envelope: items plus a summary that lists failed IDs.
        array(result["items"]).forEach(object);

        if (result["summary"] !== undefined)
          array(object(result["summary"])["failedVideoIds"] ?? []).forEach(string);

        return result;
      },
      async channels({ filter, parts, hl, pageToken, maxResults, context }) {
        nativeAuthorize(context);

        const operation = "channels.list";

        const selection =
          filter.kind === "id"
            ? { id: idList(filter.ids, 50, operation) }
            : filter.kind === "handle"
              ? { forHandle: filter.handle.trim() }
              : { forUsername: filter.username.trim() };

        if (Object.values(selection).some((value) => value === "" || value === "@"))
          throw invalidInput(operation, "Supply a non-empty handle or username.");

        return object(
          await request("/youtube/v3/channels", context, undefined, {
            part: partList(parts ?? ["snippet", "statistics"], channelParts, operation),
            ...selection,
            ...definedFields({
              hl: nonEmpty(hl),
              pageToken: nonEmpty(pageToken),
              maxResults: pageSize(maxResults, 0, 50, operation),
            }),
          }),
        );
      },
      async videoCategories({ filter, hl, context }) {
        nativeAuthorize(context);

        const operation = "videoCategories.list";

        if (filter.kind === "region" && !regionPattern.test(filter.regionCode))
          throw invalidInput(operation, "regionCode must be an ISO 3166-1 alpha-2 code.");

        return object(
          await request("/youtube/v3/videoCategories", context, undefined, {
            part: "snippet",
            ...(filter.kind === "region"
              ? { regionCode: filter.regionCode }
              : { id: idList(filter.ids, 50, operation) }),
            ...definedFields({ hl: nonEmpty(hl) }),
          }),
        );
      },
      async i18n({ resource, hl, context }) {
        nativeAuthorize(context);

        const path =
          resource === "languages"
            ? "/youtube/v3/i18nLanguages"
            : resource === "regions"
              ? "/youtube/v3/i18nRegions"
              : undefined;

        if (path === undefined)
          throw invalidInput("i18n.list", "resource must be languages or regions.");

        return object(
          await request(path, context, undefined, {
            part: "snippet",
            ...definedFields({ hl: nonEmpty(hl) }),
          }),
        );
      },
      async videoAbuseReportReasons({ hl, context }) {
        nativeAuthorize(context);

        return object(
          await request("/youtube/v3/videoAbuseReportReasons", context, undefined, {
            part: "id,snippet",
            ...definedFields({ hl: nonEmpty(hl) }),
          }),
        );
      },
      async reportAbuse({ videoId, reasonId, secondaryReasonId, comments, language, context }) {
        nativeAuthorize(context);

        if (!videoId.trim() || !reasonId.trim())
          throw invalidInput("videos.reportAbuse", "videoId and reasonId are required.");

        await request(
          "/youtube/v3/videos/reportAbuse",
          context,
          {
            videoId,
            reasonId,
            ...definedFields({
              secondaryReasonId: nonEmpty(secondaryReasonId),
              comments: nonEmpty(comments),
              language: nonEmpty(language),
            }),
          },
          {},
          "POST",
        );
      },
      async commentThreads(input) {
        nativeAuthorize(input.context);

        if (input.action === "insert") {
          const operation = "commentThreads.insert";

          if (!input.videoId.trim() || !input.text.trim())
            throw invalidInput(operation, "videoId and non-empty text are required.");

          return object(
            await request(
              "/youtube/v3/commentThreads",
              input.context,
              {
                snippet: {
                  channelId: nonEmpty(input.channelId?.trim()) ?? options.auth.channelId,
                  videoId: input.videoId,
                  topLevelComment: { snippet: { textOriginal: input.text } },
                },
              },
              { part: "snippet" },
              "POST",
            ),
          );
        }

        const operation = "commentThreads.list";
        const { filter } = input;

        if (filter.kind === "video" && !filter.videoId.trim())
          throw invalidInput(operation, "videoId is required.");

        return object(
          await request("/youtube/v3/commentThreads", input.context, undefined, {
            part: input.includeReplies ? "snippet,replies" : "snippet",
            ...(filter.kind === "video"
              ? { videoId: filter.videoId }
              : {
                  allThreadsRelatedToChannelId:
                    nonEmpty(filter.channelId?.trim()) ?? options.auth.channelId,
                }),
            ...definedFields({
              searchTerms: nonEmpty(input.searchTerms),
              order: optionalEnum(input.order, ["time", "relevance"], "order", operation),
              textFormat: optionalEnum(
                input.textFormat,
                ["html", "plainText"],
                "textFormat",
                operation,
              ),
              moderationStatus: optionalEnum(
                input.moderationStatus,
                ["published", "heldForReview", "likelySpam"],
                "moderationStatus",
                operation,
              ),
              pageToken: nonEmpty(input.pageToken),
              maxResults: pageSize(input.maxResults, 1, 100, operation),
            }),
          }),
        );
      },
      async comments({ commentIds, textFormat, context }) {
        nativeAuthorize(context);

        const operation = "comments.list";

        return object(
          await request("/youtube/v3/comments", context, undefined, {
            part: "snippet",
            id: idList(commentIds, 50, operation),
            ...definedFields({
              textFormat: optionalEnum(textFormat, ["html", "plainText"], "textFormat", operation),
            }),
          }),
        );
      },
      async videoTrainability({ videoId, context }) {
        nativeAuthorize(context);

        const id = videoId.trim();

        if (!id) throw invalidInput("videoTrainability.get", "videoId is required.");

        const raw = object(
          await request("/youtube/v3/videoTrainability", context, undefined, { id }),
        );

        return {
          videoId: string(raw["videoId"]),
          permitted: array(raw["permitted"] ?? []).map(string),
          raw,
        };
      },
      async abuseReports({ report, context }) {
        nativeAuthorize(context);

        const body = abuseReportBody(report);

        return object(
          await request(
            "/youtube/v3/abuseReports",
            context,
            body,
            { part: Object.keys(body).join(",") },
            "POST",
          ),
        );
      },
      async commentReplies({ parentId, textFormat, pageToken, maxResults, context }) {
        nativeAuthorize(context);

        const operation = "comments.list";

        if (!parentId.trim()) throw invalidInput(operation, "parentId is required.");

        return object(
          await request("/youtube/v3/comments", context, undefined, {
            part: "snippet",
            parentId,
            ...definedFields({
              textFormat: optionalEnum(textFormat, ["html", "plainText"], "textFormat", operation),
              pageToken: nonEmpty(pageToken),
              maxResults: pageSize(maxResults, 1, 100, operation),
            }),
          }),
        );
      },
      async activities({
        channelId,
        pageToken,
        maxResults,
        publishedAfter,
        publishedBefore,
        context,
      }) {
        nativeAuthorize(context);

        if (channelId && channelId !== options.auth.channelId)
          throw new SocialError({
            code: "unauthorized",
            operation: "channel.activity.read",
            message: "Activities may only be read for the configured channel.",
          });

        return object(
          await request("/youtube/v3/activities", context, undefined, {
            part: "snippet,contentDetails",
            channelId: options.auth.channelId,
            ...definedFields({
              pageToken: nonEmpty(pageToken),
              maxResults: maxResults ? String(maxResults) : undefined,
              publishedAfter: nonEmpty(publishedAfter),
              publishedBefore: nonEmpty(publishedBefore),
            }),
          }),
        );
      },
    },
  });
}
