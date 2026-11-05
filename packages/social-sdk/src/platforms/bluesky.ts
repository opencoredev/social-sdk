import { readBinary } from "../transport/binary.js";
import { remainingBudget } from "../transport/budget.js";
import {
  connectedAccountRef,
  defineAdapter,
  platformPostRef,
  profileRef,
  type AccountRecord,
  type AdapterOperationContext,
  type BlueskyBlobRef,
  type BlueskyPublishOptions,
  type CapabilityManifest,
  type CommentRef,
  type ConnectedAccountRef,
  type DeliveryOutcome,
  type JsonObject,
  type JsonValue,
  type MediaAttachment,
  type MediaInput,
  type MediaRef,
  type MetricValue,
  type Page,
  type PreparedPublishTarget,
  type ProfileRecord,
  type RelationshipRecord,
  type SocialAdapter,
} from "../core/index.js";
import { SocialError } from "../core/errors.js";
import { definedFields } from "../core/fields.js";
import { normalizeComment, normalizeMetrics } from "../core/projections.js";
import { abortable, createHttp, HttpError, type HttpErrorData } from "../transport/http.js";
import { httpsUrl } from "../transport/upload.js";
import { fetchWithoutRedirects } from "../transport/redirect.js";
import { parseJson } from "../transport/json.js";
import {
  array,
  isBoolean,
  isFiniteNumber,
  isJsonObject,
  isString,
  number,
  object,
  optionalNumber,
  optionalObject,
  optionalString,
  string,
  type JsonField,
} from "../transport/validation.js";

const MAX_IMAGE_BYTES = 2_000_000;

const MAX_IMAGES = 4;

/** app.bsky.embed.video accepts one MP4 blob of at most 300,000,000 bytes. */
const MAX_VIDEO_BYTES = 300_000_000;

const DEFAULT_VIDEO_SERVICE = "https://video.bsky.app";

/** Bluesky's video guide recommends a 30 minute upload token lifetime. */
const VIDEO_UPLOAD_TOKEN_SECONDS = 30 * 60;

/**
 * Videos larger than this go through the multipart upload from `media.upload`. Smaller ones use
 * the single `app.bsky.video.uploadVideo` request.
 */
const MULTIPART_VIDEO_MIN_BYTES = 50_000_000;

/** A part upload mints a fresh service token when the current one expires within this window. */
const VIDEO_TOKEN_REFRESH_MARGIN_MS = 60_000;

const VIDEO_UPLOAD_JOB_ID = /^[\x21-\x7e]{1,256}$/;

export interface BlueskyAuthorization {
  readonly service: string;
  readonly did: string;
  readonly accessJwt?: string;
  readonly handle?: string;
}

export interface BlueskyOptions {
  readonly auth: BlueskyAuthorization;
  readonly backend?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /** Explicit egress policy for caller-provided remote media URLs. */
  readonly allowMediaHost?: (hostname: string) => boolean;
  /** Restored @atproto OAuthSession transport. Its DPoP-aware fetchHandler is used directly. */
  readonly session?: {
    readonly did: string;
    readonly handle?: string;
    readonly fetchHandler: (pathname: string, init?: RequestInit) => Promise<Response>;
  };
  /** HTTPS origin of the Bluesky video service. Defaults to https://video.bsky.app. */
  readonly videoService?: string;
  /**
   * Service DID of the account's PDS (for example `did:web:pds.example.com`). It is the
   * audience of the service token that lets the video service store the processed blob.
   * When omitted, `uploadVideo` reads the `#atproto_pds` endpoint from the DID document
   * returned by `com.atproto.server.getSession`.
   */
  readonly pdsDid?: string;
}

/** A Bluesky video processing job (`app.bsky.video.defs#jobStatus`). */
export interface BlueskyVideoJob {
  readonly jobId: string;
  readonly did: string;
  /** `JOB_STATE_COMPLETED`, `JOB_STATE_FAILED`, or an in-progress state. */
  readonly state: string;
  readonly progress?: number;
  /** The processed blob. Present once the video is stored on the PDS. */
  readonly blob?: JsonObject;
  readonly failureCode?: string;
  readonly error?: string;
  readonly message?: string;
}

/** A multipart upload session opened by `app.bsky.video.startUpload`. */
export interface BlueskyVideoUploadSession {
  /** Upload job ID used by `uploadVideoPart`, `finishVideoUpload`, and the status calls. */
  readonly jobId: string;
  /** Size of every part except the last, which carries the remainder. */
  readonly partSizeBytes: number;
  readonly partCount: number;
  /** When the service discards an unfinished session. */
  readonly expiresAt: string;
}

/** Receipt for one part from `app.bsky.video.uploadPart`. */
export interface BlueskyVideoPartReceipt {
  readonly partNumber: number;
  readonly sizeBytes: number;
}

/** Output of `app.bsky.video.getUploadStatus`. */
export interface BlueskyVideoUploadStatus {
  readonly jobId: string;
  readonly partSizeBytes: number;
  readonly partCount: number;
  /** Part numbers the service has recorded. Re-send the others before finishing. */
  readonly receivedParts: readonly number[];
  readonly expiresAt: string;
  /** `created`, `finishing`, `completed`, `failed`, `aborted`, `expired`, or a newer value. */
  readonly state: string;
  /** Present when `state` is `completed`. Poll `getVideoJobStatus` with this ID. */
  readonly completedJobId?: string;
  /** Present when `state` is `completed`. */
  readonly job?: BlueskyVideoJob;
  /** Present when `state` is `failed`. */
  readonly failureReason?: string;
}

/** Output of `app.bsky.video.abortUpload`. */
export interface BlueskyVideoUploadAbortResult {
  /** `aborted`, or the terminal outcome the session already had: `completed`, `failed`, `expired`. */
  readonly state: string;
  readonly completedJobId?: string;
  readonly failureReason?: string;
}

/** Advisory media properties the video service uses only to fail early. */
export interface BlueskyVideoUploadHints {
  readonly durationMs?: number;
  readonly width?: number;
  readonly height?: number;
}

/** Output of `app.bsky.video.getUploadLimits` for the configured account. */
export interface BlueskyVideoUploadLimits {
  readonly canUpload: boolean;
  readonly remainingDailyVideos?: number;
  readonly remainingDailyBytes?: number;
  readonly message?: string;
  readonly error?: string;
}

export interface BlueskyPostRef {
  readonly uri: string;
  readonly cid: string;
}

/** Query parameters accepted by the public app.bsky.feed.searchPosts endpoint. */
export interface BlueskySearchPostsInput {
  readonly account: ConnectedAccountRef;
  readonly query: string;
  readonly scope?: "recent" | "all";
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: "latest" | "top";
  readonly since?: string;
  readonly until?: string;
  readonly mentions?: string;
  readonly author?: string;
  readonly lang?: string;
  readonly domain?: string;
  readonly url?: string;
  readonly tags?: readonly string[];
  readonly context?: AdapterOperationContext;
}

export interface BlueskySearchPostsResult {
  readonly posts: readonly JsonObject[];
  readonly cursor?: string;
  readonly hitsTotal?: number;
}

/** A threadgate allow rule: who may reply to a root post. */
export type BlueskyReplyRule = NonNullable<BlueskyPublishOptions["replyControls"]>[number];

/** One post inside a server-side draft (`app.bsky.draft.defs#draftPost`). */
export interface BlueskyDraftPost {
  /** Up to 10,000 bytes; drafts hold more than a post so it can be split later. */
  readonly text: string;
  readonly contentLabels?: BlueskyPublishOptions["contentLabels"];
  /** URL for a link card, stored as `embedExternals`. */
  readonly linkUrl?: string;
  /** Post to quote, stored as `embedRecords`. */
  readonly quote?: BlueskyPostRef;
  /**
   * Up to 4 images, stored as `embedImages`. Paths are local to the device that saved the
   * draft (`deviceId`); Bluesky stores no image bytes with a draft.
   */
  readonly images?: readonly BlueskyDraftMedia[];
  /** Up to 20 images for a gallery, stored as `embedGallery`. */
  readonly gallery?: readonly BlueskyDraftMedia[];
  /** One video, stored as `embedVideos`, with up to 20 caption tracks as text. */
  readonly video?: BlueskyDraftMedia & {
    readonly captions?: readonly { readonly lang: string; readonly content: string }[];
  };
}

/** A device-local media reference in a draft (`app.bsky.draft.defs#draftEmbedLocalRef`). */
export interface BlueskyDraftMedia {
  /** File path on the saving device, 1 to 1,024 characters. */
  readonly path: string;
  /** Alt text, up to 2,000 graphemes. */
  readonly alt?: string;
}

/** A server-side draft (`app.bsky.draft.defs#draft`): one post or a thread of up to 100. */
export interface BlueskyDraft {
  readonly posts: readonly BlueskyDraftPost[];
  readonly languages?: readonly string[];
  /** Threadgate rules to apply when the draft is published. */
  readonly replyControls?: readonly BlueskyReplyRule[];
  /** Write a postgate `disableRule` when the draft is published. */
  readonly disableQuotes?: boolean;
  readonly deviceId?: string;
  readonly deviceName?: string;
}

/** One record operation inside a com.atproto.repo.applyWrites transaction. */
export type BlueskyWrite =
  | {
      readonly action: "create";
      readonly collection: string;
      /** Omit to let the PDS assign a TID. */
      readonly rkey?: string;
      readonly value: JsonObject;
    }
  | {
      readonly action: "update";
      readonly collection: string;
      readonly rkey: string;
      readonly value: JsonObject;
    }
  | { readonly action: "delete"; readonly collection: string; readonly rkey: string };

export interface BlueskyWriteResult {
  readonly action: BlueskyWrite["action"];
  /** Absent for deletes. */
  readonly uri?: string;
  readonly cid?: string;
  readonly validationStatus?: "valid" | "unknown";
}

export interface BlueskyApplyWritesResult {
  readonly commit?: { readonly cid: string; readonly rev: string };
  readonly results: readonly BlueskyWriteResult[];
}

export interface BlueskyNative {
  readonly getPost: (input: {
    readonly uri: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Hydrates up to 25 posts by AT-URI with one `app.bsky.feed.getPosts` call. */
  readonly getPosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly uris: readonly string[];
    readonly context?: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  readonly getPostThread: (input: {
    readonly uri: string;
    /** Reply levels to include, 0 to 1000. Bluesky's default is 6. */
    readonly depth?: number;
    /** Parent levels to include, 0 to 1000. Bluesky's default is 80. */
    readonly parentHeight?: number;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly searchPosts: (input: BlueskySearchPostsInput) => Promise<BlueskySearchPostsResult>;
  readonly likePost: (input: {
    readonly post: BlueskyPostRef;
    readonly account: ConnectedAccountRef;
    /**
     * The `app.bsky.feed.repost` record the post was seen through. Stored as the like's `via`
     * strongRef so the reposter gets a `like-via-repost` notification.
     */
    readonly via?: BlueskyPostRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<{ readonly uri: string; readonly cid: string }>;
  readonly unlikePost: (input: {
    readonly likeUri: string;
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly repostPost: (input: {
    readonly post: BlueskyPostRef;
    readonly account: ConnectedAccountRef;
    /** The repost record the post was seen through, stored as the repost's `via` strongRef. */
    readonly via?: BlueskyPostRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  readonly quotePost: (input: {
    readonly post: BlueskyPostRef;
    readonly account: ConnectedAccountRef;
    readonly text: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  readonly deletePost: (input: {
    readonly post: BlueskyPostRef;
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /**
   * Sends one MP4 to the video service with a single upload request and returns the
   * processing job. It does not wait for processing; poll `getVideoJobStatus` explicitly.
   */
  readonly uploadVideo: (input: {
    readonly account: ConnectedAccountRef;
    readonly video: Blob;
    readonly mimeType?: string;
    /** File name reported to the video service. Defaults to `video.mp4`. */
    readonly name?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyVideoJob>;
  /** Reads a video processing job once. The caller decides when to check again. */
  readonly getVideoJobStatus: (input: {
    readonly account: ConnectedAccountRef;
    readonly jobId: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyVideoJob>;
  /** Reads the account's daily video upload allowance from the video service. */
  readonly getVideoUploadLimits: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyVideoUploadLimits>;
  /**
   * Uploads one MP4 in parts: `app.bsky.video.startUpload`, one `uploadPart` request per part in
   * order, then `finishUpload`. Returns the processing job without waiting for it; poll
   * `getVideoJobStatus` with the returned `jobId`. It never retries a request or aborts the
   * session on its own. A failure after the session opened carries the upload job ID in
   * `error.details.uploadJobId`, so the caller can resume with `getVideoUploadStatus`,
   * `uploadVideoPart`, and `finishVideoUpload`, or release the quota with `abortVideoUpload`.
   */
  readonly uploadVideoMultipart: (
    input: {
      readonly account: ConnectedAccountRef;
      readonly video: Blob;
      readonly mimeType?: string;
      /** File name reported to the video service. Defaults to `video.mp4`. */
      readonly name?: string;
      readonly context?: AdapterOperationContext;
    } & BlueskyVideoUploadHints,
  ) => Promise<BlueskyVideoJob>;
  /** Opens a multipart upload session with `app.bsky.video.startUpload`. */
  readonly startVideoUpload: (
    input: {
      readonly account: ConnectedAccountRef;
      /** Exact byte size of the whole video. */
      readonly sizeBytes: number;
      readonly mimeType?: "video/mp4";
      readonly name?: string;
      readonly context?: AdapterOperationContext;
    } & BlueskyVideoUploadHints,
  ) => Promise<BlueskyVideoUploadSession>;
  /**
   * Sends one part with `app.bsky.video.uploadPart`. Part `n` (from 1) holds bytes
   * `(n - 1) * partSizeBytes` up to `n * partSizeBytes` of the video; the service rejects any
   * other length. Parts are idempotent, so a part can be sent again.
   */
  readonly uploadVideoPart: (input: {
    readonly account: ConnectedAccountRef;
    readonly jobId: string;
    readonly partNumber: number;
    readonly part: Blob;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyVideoPartReceipt>;
  /**
   * Finishes a multipart upload with `app.bsky.video.finishUpload` and returns the processing
   * job. On deduplication the returned `jobId` differs from the upload job ID; poll with it.
   */
  readonly finishVideoUpload: (input: {
    readonly account: ConnectedAccountRef;
    readonly jobId: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyVideoJob>;
  /** Reads a multipart upload session once with `app.bsky.video.getUploadStatus`. */
  readonly getVideoUploadStatus: (input: {
    readonly account: ConnectedAccountRef;
    readonly jobId: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyVideoUploadStatus>;
  /** Aborts an unfinished session with `app.bsky.video.abortUpload`, releasing its quota. */
  readonly abortVideoUpload: (input: {
    readonly account: ConnectedAccountRef;
    readonly jobId: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyVideoUploadAbortResult>;
  readonly follow: (input: {
    readonly account: ConnectedAccountRef;
    readonly did: string;
    /** The `app.bsky.graph.starterpack` record the follow came from, stored as `via`. */
    readonly via?: BlueskyPostRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly unfollow: (input: {
    readonly account: ConnectedAccountRef;
    readonly followUri: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly block: (input: {
    readonly account: ConnectedAccountRef;
    readonly did: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly unblock: (input: {
    readonly account: ConnectedAccountRef;
    readonly blockUri: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly mute: (input: {
    readonly account: ConnectedAccountRef;
    readonly did: string;
    /** Mute only this actor's reposts instead of the whole account. */
    readonly onlyReposts?: boolean;
    /** Mute only this actor's quote posts instead of the whole account. */
    readonly onlyQuoteposts?: boolean;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly unmute: (input: {
    readonly account: ConnectedAccountRef;
    readonly did: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly getFollowers: (input: BlueskyFollowPageInput) => Promise<BlueskyActorPageResult>;
  readonly getFollows: (input: BlueskyFollowPageInput) => Promise<BlueskyActorPageResult>;
  readonly getMutes: (input: BlueskyPageInput) => Promise<BlueskyActorPageResult>;
  readonly getBlocks: (input: BlueskyPageInput) => Promise<BlueskyActorPageResult>;
  readonly getLikes: (input: BlueskyPostPageInput) => Promise<BlueskyLikePageResult>;
  readonly getActorLikes: (input: BlueskyActorPageInput) => Promise<BlueskyFeedPageResult>;
  /** Reads the authenticated user's default chronological timeline. */
  readonly getTimeline: (
    input: BlueskyPageInput & { readonly algorithm?: string },
  ) => Promise<BlueskyFeedPageResult>;
  /** Reads posts from a feed generator identified by its AT-URI. */
  readonly getFeed: (
    input: BlueskyPageInput & { readonly feed: string },
  ) => Promise<BlueskyFeedPageResult>;
  /** Reads posts authored by an actor, with the provider's author-feed filter. */
  readonly getAuthorFeed: (
    input: BlueskyActorPageInput & {
      readonly filter?:
        | "posts_with_replies"
        | "posts_no_replies"
        | "posts_with_media"
        | "posts_and_author_threads"
        | "posts_with_video";
      /** Include the actor's pinned post at the top of the first page. */
      readonly includePins?: boolean;
    },
  ) => Promise<BlueskyFeedPageResult>;
  /** Recent posts and reposts from the members of a list. */
  readonly getListFeed: (
    input: BlueskyPageInput & { readonly listUri: string },
  ) => Promise<BlueskyFeedPageResult>;
  /** Posts that quote a post. `cid` narrows to one version of the record. */
  readonly getQuotes: (input: BlueskyPostPageInput) => Promise<BlueskyPage>;
  /** Actors who reposted a post. */
  readonly getRepostedBy: (input: BlueskyPostPageInput) => Promise<BlueskyPage>;
  /** Feed generators an actor created. */
  readonly getActorFeeds: (input: BlueskyActorPageInput) => Promise<BlueskyPage>;
  /** One feed generator view plus its online and validity flags. */
  readonly getFeedGenerator: (input: {
    readonly account: ConnectedAccountRef;
    readonly feed: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly getFeedGenerators: (input: {
    readonly account: ConnectedAccountRef;
    readonly feeds: readonly string[];
    readonly context?: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  /** Detailed profile views for up to 25 actors (DIDs or handles). */
  readonly getProfiles: (input: {
    readonly account: ConnectedAccountRef;
    readonly actors: readonly string[];
    readonly context?: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  /** Suggested accounts to follow (`app.bsky.actor.getSuggestions`). */
  readonly getSuggestions: (input: BlueskyPageInput) => Promise<BlueskyActorPageResult>;
  /** Accounts similar to one actor (`app.bsky.graph.getSuggestedFollowsByActor`). */
  readonly getSuggestedFollowsByActor: (input: {
    readonly account: ConnectedAccountRef;
    readonly actor: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyActorPageResult>;
  /** Follow, block, and list-membership relationships between one actor and up to 30 others. */
  readonly getRelationships: (input: {
    readonly account: ConnectedAccountRef;
    /** Defaults to the configured account. */
    readonly actor?: string;
    readonly others: readonly string[];
    readonly context?: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  /** Followers of `actor` whom the configured account also follows. */
  readonly getKnownFollowers: (
    input: BlueskyPageInput & { readonly actor: string },
  ) => Promise<BlueskyActorPageResult>;
  /** Reads an actor's verification state from their profile view. */
  readonly getVerificationState: (input: {
    readonly account: ConnectedAccountRef;
    readonly actor?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyVerificationState | undefined>;
  readonly searchActors: (input: BlueskyActorSearchInput) => Promise<BlueskyActorPageResult>;
  readonly searchActorsTypeahead: (
    input: BlueskyActorSearchInput,
  ) => Promise<BlueskyActorPageResult>;
  readonly createList: (input: BlueskyCreateListInput) => Promise<BlueskyPostRef>;
  readonly updateList: (input: BlueskyUpdateListInput) => Promise<void>;
  readonly deleteList: (input: BlueskyOwnedRecordInput) => Promise<void>;
  readonly addListItem: (input: BlueskyListItemInput) => Promise<BlueskyPostRef>;
  readonly removeListItem: (input: BlueskyOwnedRecordInput) => Promise<void>;
  readonly getList: (input: BlueskyListPageInput) => Promise<JsonObject>;
  readonly getLists: (input: BlueskyActorPageInput) => Promise<JsonObject>;
  readonly muteList: (input: BlueskyListActionInput) => Promise<void>;
  readonly unmuteList: (input: BlueskyListActionInput) => Promise<void>;
  readonly blockList: (input: BlueskyListActionInput) => Promise<void>;
  readonly unblockList: (input: BlueskyListActionInput) => Promise<void>;
  /** Moderation lists the configured account blocks. */
  readonly getListBlocks: (input: BlueskyPageInput) => Promise<BlueskyPage>;
  /** Moderation lists the configured account mutes. */
  readonly getListMutes: (input: BlueskyPageInput) => Promise<BlueskyPage>;
  /** The configured account's curate and mod lists, each with `actor`'s membership. */
  readonly getListsWithMembership: (
    input: BlueskyPageInput & {
      readonly actor: string;
      readonly purposes?: readonly ("modlist" | "curatelist")[];
    },
  ) => Promise<BlueskyPage>;
  /** Mutes notifications from a thread and its replies. Mutes are private. */
  readonly muteThread: (input: {
    readonly account: ConnectedAccountRef;
    readonly rootUri: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly unmuteThread: (input: {
    readonly account: ConnectedAccountRef;
    readonly rootUri: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /**
   * Creates an `app.bsky.graph.starterpack` record. The list must be a reference list
   * (`app.bsky.graph.defs#referencelist`) owned by this account.
   */
  readonly createStarterPack: (input: {
    readonly account: ConnectedAccountRef;
    readonly name: string;
    readonly listUri: string;
    readonly description?: string;
    /** Up to three feed generator AT-URIs to suggest. */
    readonly feeds?: readonly string[];
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  readonly deleteStarterPack: (input: BlueskyOwnedRecordInput) => Promise<void>;
  readonly getStarterPack: (input: {
    readonly account: ConnectedAccountRef;
    readonly uri: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly getStarterPacks: (input: {
    readonly account: ConnectedAccountRef;
    readonly uris: readonly string[];
    readonly context?: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  readonly getActorStarterPacks: (input: BlueskyActorPageInput) => Promise<BlueskyPage>;
  readonly searchStarterPacks: (input: BlueskyActorSearchInput) => Promise<BlueskyPage>;
  /** Removes this account's repost record. Only repost URIs in this repository are accepted. */
  readonly unrepostPost: (input: {
    readonly account: ConnectedAccountRef;
    readonly repostUri: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /** Private bookmarks. Bluesky currently accepts `app.bsky.feed.post` records only. */
  readonly createBookmark: (input: {
    readonly account: ConnectedAccountRef;
    readonly post: BlueskyPostRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly deleteBookmark: (input: {
    readonly account: ConnectedAccountRef;
    readonly uri: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly getBookmarks: (input: BlueskyPageInput) => Promise<BlueskyPage>;
  /** Labeler service views by DID; `detailed` adds each service's label policies. */
  readonly getLabelerServices: (input: {
    readonly account: ConnectedAccountRef;
    readonly dids: readonly string[];
    readonly detailed?: boolean;
    readonly context?: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  /** Labels on subjects matching AT-URI patterns (a trailing `*` matches a prefix). */
  readonly queryLabels: (
    input: BlueskyPageInput & {
      readonly uriPatterns: readonly string[];
      readonly sources?: readonly string[];
    },
  ) => Promise<BlueskyPage>;
  readonly createModerationReport: (input: BlueskyModerationReportInput) => Promise<JsonObject>;
  readonly listNotifications: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    /** Only these notification reasons, for example `["mention", "reply", "quote"]`. */
    readonly reasons?: readonly string[];
    /** Only notifications from accounts the user marked as priority. */
    readonly priority?: boolean;
    readonly seenAt?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly getUnreadNotificationCount: (input: {
    readonly account: ConnectedAccountRef;
    readonly priority?: boolean;
    readonly seenAt?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<number>;
  /** Reads push and in-app notification preferences per notification type. */
  readonly getNotificationPreferences: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Changes only the supplied notification types with `putPreferencesV2`; returns the result. */
  readonly putNotificationPreferences: (input: {
    readonly account: ConnectedAccountRef;
    readonly preferences: BlueskyNotificationPreferences;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Accounts whose new posts or replies notify the configured account. */
  readonly listActivitySubscriptions: (input: BlueskyPageInput) => Promise<BlueskyActorPageResult>;
  /** Subscribes to (or, with both flags false, unsubscribes from) an account's activity. */
  readonly putActivitySubscription: (input: {
    readonly account: ConnectedAccountRef;
    readonly subject: string;
    readonly post: boolean;
    readonly reply: boolean;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly markNotificationsSeen: (input: {
    readonly account: ConnectedAccountRef;
    readonly seenAt?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly getProfile: (input: {
    readonly actor?: string;
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /**
   * Replaces the whole `app.bsky.actor.profile/self` record. Pass the CID you read as
   * `swapRecord` so the PDS rejects the write if the profile changed since. Prefer editProfile.
   */
  readonly updateProfile: (input: {
    readonly account: ConnectedAccountRef;
    readonly profile: JsonObject;
    readonly swapRecord?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /**
   * Changes only the given profile fields. It reads the stored record, merges the changes
   * (`null` removes a field), and writes it back with the read CID as `swapRecord`.
   */
  readonly editProfile: (input: {
    readonly account: ConnectedAccountRef;
    readonly changes: BlueskyProfileChanges;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  /** Pins one of this account's posts to the profile, or unpins with `post: null`. */
  readonly pinPost: (input: {
    readonly account: ConnectedAccountRef;
    readonly post: BlueskyPostRef | null;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  /**
   * Marks the account as live with an `app.bsky.actor.status` record linking to the stream.
   * Replaces any current status.
   */
  readonly setLiveStatus: (input: {
    readonly account: ConnectedAccountRef;
    readonly url: string;
    readonly title?: string;
    readonly description?: string;
    readonly thumb?: BlueskyBlobRef;
    /** How long the status lasts, in whole minutes (at least 1). */
    readonly durationMinutes: number;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  /** Ends the live status by deleting the status record. */
  readonly clearLiveStatus: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /** Private account preferences: saved feeds, muted words, content label settings, and more. */
  readonly getPreferences: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  /** Replaces the entire preference list. Read, change, and write back the full array. */
  readonly putPreferences: (input: {
    readonly account: ConnectedAccountRef;
    readonly preferences: readonly JsonObject[];
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly listFeeds: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly listConversations: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    /** `direct` or `group` conversations only. */
    readonly kind?: "direct" | "group";
    /** `accepted` or `request` conversations only; prefer listConvoRequests for requests. */
    readonly status?: "accepted" | "request";
    /** Only conversations with unread messages. */
    readonly unreadOnly?: boolean;
    /** Group chats by lock state: `unlocked`, `locked`, or `locked-permanently`. */
    readonly lockStatus?: "unlocked" | "locked" | "locked-permanently";
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly listMessages: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /**
   * Sends one message. Links and hashtags in the text become facets, `mentions` adds DID
   * mentions at UTF-8 offsets, and `embedPost` shares a post as an `app.bsky.embed.record`.
   */
  readonly sendMessage: (
    input: BlueskyMessageInput & {
      readonly account: ConnectedAccountRef;
      readonly conversationId: string;
      readonly context?: AdapterOperationContext;
    },
  ) => Promise<JsonObject>;
  /** Sends up to 100 messages, possibly to different conversations, in one call. */
  readonly sendMessageBatch: (input: {
    readonly account: ConnectedAccountRef;
    readonly items: readonly (BlueskyMessageInput & { readonly conversationId: string })[];
    readonly context?: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  /** Gets or creates the direct conversation with the given members (DIDs, at most 10). */
  readonly getConvoForMembers: (input: {
    readonly account: ConnectedAccountRef;
    readonly members: readonly string[];
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Checks whether a direct chat with the members is allowed, without creating one. */
  readonly getConvoAvailability: (input: {
    readonly account: ConnectedAccountRef;
    readonly members: readonly string[];
    readonly context?: AdapterOperationContext;
  }) => Promise<{ readonly canChat: boolean; readonly convo?: JsonObject }>;
  readonly getConversation: (input: BlueskyConvoInput) => Promise<JsonObject>;
  /** Incoming message requests and group join requests. Marked unstable by Bluesky. */
  readonly listConvoRequests: (input: BlueskyPageInput) => Promise<BlueskyPage>;
  /** Accepts a message request. Returns the accept `rev`, absent if already accepted. */
  readonly acceptConvo: (input: BlueskyConvoInput) => Promise<{ readonly rev?: string }>;
  readonly addReaction: (input: BlueskyReactionInput) => Promise<JsonObject>;
  readonly removeReaction: (input: BlueskyReactionInput) => Promise<JsonObject>;
  /** Marks a conversation read up to `messageId`, or to the latest message. */
  readonly markConversationRead: (
    input: BlueskyConvoInput & { readonly messageId?: string },
  ) => Promise<JsonObject>;
  /** Marks every conversation (optionally only `accepted` or `request`) read. */
  readonly markAllConversationsRead: (input: {
    readonly account: ConnectedAccountRef;
    readonly status?: "accepted" | "request";
    readonly context?: AdapterOperationContext;
  }) => Promise<number>;
  readonly muteConversation: (input: BlueskyConvoInput) => Promise<JsonObject>;
  readonly unmuteConversation: (input: BlueskyConvoInput) => Promise<JsonObject>;
  /** Leaves a conversation. For a direct chat it only hides the conversation for this user. */
  readonly leaveConversation: (input: BlueskyConvoInput) => Promise<{ readonly rev: string }>;
  /** Deletes a message for this user only; other members still see it. */
  readonly deleteMessageForSelf: (
    input: BlueskyConvoInput & { readonly messageId: string },
  ) => Promise<JsonObject>;
  /** Reads chat events after `cursor` (new messages, reactions, read and membership changes). */
  readonly getChatLog: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<{ readonly logs: readonly JsonObject[]; readonly cursor?: string }>;
  /** Group chats. Bluesky marks these endpoints unstable while under active development. */
  readonly createGroupChat: (input: {
    readonly account: ConnectedAccountRef;
    readonly name: string;
    /** Member DIDs, at most 49 besides the creator. */
    readonly members: readonly string[];
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly renameGroupChat: (
    input: BlueskyConvoInput & { readonly name: string },
  ) => Promise<JsonObject>;
  /** Adds members in `request` status; each must accept. */
  readonly addGroupChatMembers: (
    input: BlueskyConvoInput & { readonly members: readonly string[] },
  ) => Promise<JsonObject>;
  readonly removeGroupChatMembers: (
    input: BlueskyConvoInput & { readonly members: readonly string[] },
  ) => Promise<JsonObject>;
  /**
   * Hides or unhides a reply in a thread whose root post belongs to this account.
   * Updates the root post's `app.bsky.feed.threadgate` record `hiddenReplies` list.
   */
  readonly hideReply: (input: BlueskyHideReplyInput) => Promise<BlueskyHideReplyResult>;
  /**
   * Uploads one blob with `com.atproto.repo.uploadBlob` and returns its reference for a record:
   * profile avatars and banners, link-card thumbnails, or video caption files. The PDS deletes a
   * blob that no record references within a few minutes.
   */
  readonly uploadBlob: (input: {
    readonly account: ConnectedAccountRef;
    readonly blob: Blob;
    /** Defaults to the Blob's own type. Required when the Blob has none. */
    readonly mimeType?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyBlobRef>;
  /**
   * Replaces the reply rules on one of this account's root posts. `allow: null` removes the
   * rules so anyone can reply; `[]` lets nobody reply. Hidden replies are kept. The write uses
   * the read record's CID as `swapRecord`, so a concurrent change fails instead of being lost.
   */
  readonly setThreadgate: (input: {
    readonly account: ConnectedAccountRef;
    readonly postUri: string;
    readonly allow: readonly BlueskyReplyRule[] | null;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  /** Turns quoting of one of this account's posts off or back on with a postgate `disableRule`. */
  readonly setQuotesDisabled: (input: {
    readonly account: ConnectedAccountRef;
    readonly postUri: string;
    readonly disabled: boolean;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  /**
   * Detaches (or reattaches) this account's post from another post that quotes it, through the
   * postgate `detachedEmbeddingUris` list (at most 50 URIs).
   */
  readonly detachQuote: (input: {
    readonly account: ConnectedAccountRef;
    readonly postUri: string;
    readonly quoteUri: string;
    readonly detached: boolean;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  /** Stores a private server-side draft with `app.bsky.draft.createDraft`. */
  readonly createDraft: (input: {
    readonly account: ConnectedAccountRef;
    readonly draft: BlueskyDraft;
    readonly context?: AdapterOperationContext;
  }) => Promise<{ readonly id: string }>;
  /** Lists this account's drafts with `app.bsky.draft.getDrafts`. */
  readonly listDrafts: (input: BlueskyPageInput) => Promise<{
    readonly drafts: readonly JsonObject[];
    readonly cursor?: string;
  }>;
  /** Replaces a draft. Bluesky silently ignores an ID that does not exist. */
  readonly updateDraft: (input: {
    readonly account: ConnectedAccountRef;
    readonly id: string;
    readonly draft: BlueskyDraft;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly deleteDraft: (input: {
    readonly account: ConnectedAccountRef;
    readonly id: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /** Applies creates, updates, and deletes to this account's repository in one transaction. */
  readonly applyWrites: (input: {
    readonly account: ConnectedAccountRef;
    readonly writes: readonly BlueskyWrite[];
    /** `false` skips lexicon validation on the PDS; omit to use the PDS default. */
    readonly validate?: boolean;
    /** Commit CID the repository must still be at, for compare-and-swap. */
    readonly swapCommit?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyApplyWritesResult>;
  /**
   * Reads an `app.bsky.notification.declaration` record (rkey `self`). `undefined` means no
   * record, which Bluesky treats as `allowSubscriptions: "followers"`.
   */
  readonly getNotificationDeclaration: (input: {
    readonly account: ConnectedAccountRef;
    /** DID whose declaration to read. Defaults to the connected account. */
    readonly actor?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<{ readonly allowSubscriptions: string } | undefined>;
  /** Sets who may subscribe to this account's new posts and replies. */
  readonly setNotificationDeclaration: (input: {
    readonly account: ConnectedAccountRef;
    readonly allowSubscriptions: "followers" | "mutuals" | "none";
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  /** Reads the `chat.bsky.actor.declaration` record; `undefined` when the account has none. */
  readonly getChatDeclaration: (input: {
    readonly account: ConnectedAccountRef;
    readonly actor?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyChatDeclaration | undefined>;
  /** Sets who may start a chat with this account and who may add it to group chats. */
  readonly setChatDeclaration: (input: {
    readonly account: ConnectedAccountRef;
    readonly allowIncoming: BlueskyChatAudience;
    readonly allowGroupInvites?: BlueskyChatAudience;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  /** Reads chat availability for this account from `chat.bsky.actor.getStatus`. */
  readonly getChatStatus: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<{
    readonly chatDisabled: boolean;
    readonly canCreateGroups: boolean;
    readonly groupMemberLimit: number;
  }>;
  /** Reads `hideFromAlgorithmicRecommendations`; a missing record reads as `false`. */
  readonly getContentVisibility: (input: {
    readonly account: ConnectedAccountRef;
    readonly actor?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<{ readonly hideFromAlgorithmicRecommendations: boolean }>;
  /** Asks feeds and recommendation surfaces to leave this account's posts out. */
  readonly setContentVisibility: (input: {
    readonly account: ConnectedAccountRef;
    readonly hideFromAlgorithmicRecommendations: boolean;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  /**
   * Asks to be left out of someone else's reference list (the list behind a starter pack) by
   * creating an `app.bsky.graph.referencelistoptout` record.
   */
  readonly optOutOfReferenceList: (input: {
    readonly account: ConnectedAccountRef;
    /** DID-based AT-URI of the `app.bsky.graph.list` record. */
    readonly listUri: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  /** Withdraws an opt-out by deleting this account's opt-out record. */
  readonly deleteReferenceListOptOut: (input: BlueskyOwnedRecordInput) => Promise<void>;
  /**
   * Creates an `app.bsky.actor.link` record. A link shows on the profile only after its
   * reference is added to the profile's `links` with `editProfile`.
   */
  readonly createProfileLink: (input: {
    readonly account: ConnectedAccountRef;
    /** https URL. */
    readonly url: string;
    /** Up to 40 graphemes. */
    readonly title?: string;
    /** PNG, JPEG, or WebP blob of at most 100,000 bytes from `uploadBlob`. */
    readonly icon?: BlueskyBlobRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  readonly deleteProfileLink: (input: BlueskyOwnedRecordInput) => Promise<void>;
  /**
   * Creates or replaces an `app.bsky.feed.generator` record so a custom feed appears in
   * Bluesky. Serving the feed is your generator's job; see `blueskyFeedGeneratorDescription`.
   */
  readonly putFeedGenerator: (input: {
    readonly account: ConnectedAccountRef;
    /** Record key, which becomes the last segment of the feed AT-URI. */
    readonly rkey: string;
    /** The feed generator service DID, usually a `did:web`. */
    readonly did: string;
    /** Up to 24 graphemes. */
    readonly displayName: string;
    /** Up to 300 graphemes. */
    readonly description?: string;
    readonly avatar?: BlueskyBlobRef;
    /** Whether the generator accepts `app.bsky.feed.sendInteractions` feedback. */
    readonly acceptsInteractions?: boolean;
    readonly contentMode?:
      | "app.bsky.feed.defs#contentModeUnspecified"
      | "app.bsky.feed.defs#contentModeVideo";
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  readonly deleteFeedGenerator: (input: BlueskyOwnedRecordInput) => Promise<void>;
  /**
   * Creates or replaces the account's `app.bsky.labeler.service` declaration (rkey `self`).
   * The account must also run a labeler service; this record only declares it.
   */
  readonly putLabelerService: (input: {
    readonly account: ConnectedAccountRef;
    readonly policies: BlueskyLabelerPolicies;
    /** Report reason types in scope; omit to accept all. */
    readonly reasonTypes?: readonly string[];
    /** `account`, `record`, or `chat`. */
    readonly subjectTypes?: readonly string[];
    /** Collection NSIDs that can be reported; omit to accept any. */
    readonly subjectCollections?: readonly string[];
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPostRef>;
  /**
   * Downloads this account's chat data from `chat.bsky.actor.exportAccountData`. The service
   * answers with JSON Lines; each line becomes one object. Responses are capped at 50 MB.
   */
  readonly exportChatAccountData: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  /** Deletes this account's chat data with `chat.bsky.actor.deleteAccount`. Irreversible. */
  readonly deleteChatAccount: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /** Chat-service notification settings, separate from `app.bsky.notification` preferences. */
  readonly getChatNotificationPreferences: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyChatNotificationPreferences>;
  /** Changes `chat` and/or `chatRequest` settings and returns the stored preferences. */
  readonly putChatNotificationPreferences: (input: {
    readonly account: ConnectedAccountRef;
    readonly chat?: BlueskyChatNotificationPreference;
    readonly chatRequest?: BlueskyChatNotificationPreference;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyChatNotificationPreferences>;
  /** Unread accepted and request conversation counts (`chat.bsky.convo.getUnreadCounts`). */
  readonly getUnreadConversationCounts: (input: {
    readonly account: ConnectedAccountRef;
    /** Count group chats too. Bluesky's default is true. */
    readonly includeGroupChats?: boolean;
    readonly context?: AdapterOperationContext;
  }) => Promise<{ readonly unreadAcceptedConvos: number; readonly unreadRequestConvos: number }>;
  /** Locks a group chat so members cannot send messages. Owners and admins only. Unstable. */
  readonly lockGroupChat: (input: BlueskyConvoInput) => Promise<JsonObject>;
  readonly unlockGroupChat: (input: BlueskyConvoInput) => Promise<JsonObject>;
  /** Pages the members of a conversation. Unstable. */
  readonly getConvoMembers: (
    input: BlueskyConvoInput & { readonly cursor?: string; readonly limit?: number },
  ) => Promise<BlueskyActorPageResult>;
  /** Group chats this account shares with `subject`. Unstable. */
  readonly listMutualGroups: (
    input: BlueskyPageInput & { readonly subject: string },
  ) => Promise<BlueskyPage>;
  /** Creates the group's join link. A group has at most one enabled link. Unstable. */
  readonly createJoinLink: (
    input: BlueskyConvoInput & {
      readonly joinRule: "anyone" | "followedByOwner";
      readonly requireApproval?: boolean;
    },
  ) => Promise<JsonObject>;
  readonly editJoinLink: (
    input: BlueskyConvoInput & {
      readonly joinRule?: "anyone" | "followedByOwner";
      readonly requireApproval?: boolean;
    },
  ) => Promise<JsonObject>;
  readonly enableJoinLink: (input: BlueskyConvoInput) => Promise<JsonObject>;
  readonly disableJoinLink: (input: BlueskyConvoInput) => Promise<JsonObject>;
  /** Previews up to 50 join link codes; disabled and invalid codes come back as such. */
  readonly getJoinLinkPreviews: (input: {
    readonly account: ConnectedAccountRef;
    readonly codes: readonly string[];
    readonly context?: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  /** Joins through a link code; `pending` when the owner must approve. */
  readonly requestJoinGroupChat: (input: {
    readonly account: ConnectedAccountRef;
    readonly code: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<{ readonly status: string; readonly convo?: JsonObject }>;
  readonly withdrawJoinRequest: (input: BlueskyConvoInput) => Promise<void>;
  /** Pending join requests for a group this account owns or administers. */
  readonly listJoinRequests: (
    input: BlueskyConvoInput & { readonly cursor?: string; readonly limit?: number },
  ) => Promise<BlueskyPage>;
  readonly approveJoinRequest: (
    input: BlueskyConvoInput & { readonly member: string },
  ) => Promise<JsonObject>;
  readonly rejectJoinRequest: (
    input: BlueskyConvoInput & { readonly member: string },
  ) => Promise<void>;
  /** Marks a group's join requests as read. */
  readonly markJoinRequestsRead: (input: BlueskyConvoInput) => Promise<void>;
  /**
   * Structured post search with `app.bsky.feed.searchPostsV2`: include and exclude lists for
   * authors, mentions, domains, URLs, embedded records, hashtags, and languages, plus media
   * and reply filters. `query` may be omitted when a filter narrows the search.
   */
  readonly searchPostsV2: (
    input: BlueskySearchPostsV2Input,
  ) => Promise<BlueskySearchPostsResult & { readonly detectedQueryLanguages?: readonly string[] }>;
  /**
   * Pre-grouped notifications from `app.bsky.notification.getGroupedNotifications`. Bluesky
   * marks this endpoint unstable. Returns `groups`, `relatedViews`, `seenAt`, and `cursor`.
   */
  readonly getGroupedNotifications: (input: {
    readonly account: ConnectedAccountRef;
    readonly feed?: "all" | "people-i-follow" | "conversations" | "followers" | "activity";
    /** 1 to 50. Bluesky's default is 30. */
    readonly limit?: number;
    readonly cursor?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** This account's starter packs, each with `actor`'s list item when they are in it. */
  readonly getStarterPacksWithMembership: (
    input: BlueskyPageInput & { readonly actor: string },
  ) => Promise<BlueskyPage>;
  /** Starter pack search with `app.bsky.graph.searchStarterPacksV2`. */
  readonly searchStarterPacksV2: (
    input: BlueskyActorSearchInput,
  ) => Promise<BlueskyPage & { readonly hitsTotal?: number }>;
  /**
   * Resolves an Atmosphere record into an enhanced link card with
   * `app.bsky.embed.getEmbedExternalView`. Write the returned `associatedRefs` into the post
   * with the `linkAssociatedRefs` publish option. An empty object means fall back.
   */
  readonly getEmbedExternalView: (input: {
    readonly account: ConnectedAccountRef;
    /** The web URL the card represents. */
    readonly url: string;
    /** AT-URI of the record the page declares; takes precedence over `uris`. */
    readonly canonicalUri?: string;
    /** Legacy Standard.site record AT-URIs, at most 4. */
    readonly uris?: readonly string[];
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /**
   * Sends show-more, show-less, seen, and clickthrough feedback to a feed generator with
   * `app.bsky.feed.sendInteractions`, proxied to `feedServiceDid#bsky_fg`.
   */
  readonly sendFeedInteractions: (input: {
    readonly account: ConnectedAccountRef;
    /** The feed generator's service DID (`did` in its generator view). */
    readonly feedServiceDid: string;
    /** The feed's AT-URI. */
    readonly feed?: string;
    readonly interactions: readonly BlueskyFeedInteraction[];
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /** Which collections a repository holds and whether its handle verifies. */
  readonly describeRepo: (input: {
    readonly account: ConnectedAccountRef;
    /** DID or handle. Defaults to the connected account. */
    readonly repo?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyRepoDescription>;
  /**
   * Reads a thread as a flat list with `app.bsky.unspecced.getPostThreadV2`, which Bluesky
   * marks unstable. `hasOtherReplies` says whether `getPostThreadOtherV2` has hidden replies.
   */
  readonly getPostThreadV2: (input: {
    readonly account: ConnectedAccountRef;
    readonly anchor: string;
    /** Include parents. Default true. */
    readonly above?: boolean;
    /** Reply levels below the anchor, 0 to 20. Default 6. */
    readonly below?: number;
    /** Replies per level, 0 to 100. Default 10. */
    readonly branchingFactor?: number;
    readonly sort?: "newest" | "oldest" | "top";
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Hidden and other replies for an anchor post (`getPostThreadOtherV2`, unstable). */
  readonly getPostThreadOtherV2: (input: {
    readonly account: ConnectedAccountRef;
    readonly anchor: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Current trends (`app.bsky.unspecced.getTrends`, unstable). `limit` 1 to 25. */
  readonly getTrends: (input: {
    readonly account: ConnectedAccountRef;
    readonly limit?: number;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Trending and suggested topics (`app.bsky.unspecced.getTrendingTopics`, unstable). */
  readonly getTrendingTopics: (input: {
    readonly account: ConnectedAccountRef;
    /** DID used to personalize; defaults to none. */
    readonly viewer?: string;
    readonly limit?: number;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Suggested accounts, optionally for one category (`getSuggestedUsers`, unstable). */
  readonly getSuggestedUsers: (input: {
    readonly account: ConnectedAccountRef;
    readonly category?: string;
    /** 1 to 50. */
    readonly limit?: number;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyActorPageResult>;
  /** Popular feed generators, optionally matching `query` (`getPopularFeedGenerators`). */
  readonly getPopularFeedGenerators: (
    input: BlueskyPageInput & { readonly query?: string },
  ) => Promise<BlueskyPage>;
  /** Suggested feeds (`getSuggestedFeeds`, unstable). `limit` 1 to 25. */
  readonly getSuggestedFeeds: (input: {
    readonly account: ConnectedAccountRef;
    readonly limit?: number;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPage>;
  /** Suggested starter packs (`getSuggestedStarterPacks`, unstable). `limit` 1 to 25. */
  readonly getSuggestedStarterPacks: (input: {
    readonly account: ConnectedAccountRef;
    readonly limit?: number;
    readonly context?: AdapterOperationContext;
  }) => Promise<BlueskyPage>;
  /** Tagged actor and feed suggestions (`getTaggedSuggestions`, unstable). */
  readonly getTaggedSuggestions: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<readonly JsonObject[]>;
  /** Age assurance rules per region (`app.bsky.ageassurance.getConfig`). */
  readonly getAgeAssuranceConfig: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** This account's age assurance `state` and `metadata` for a country (and region). */
  readonly getAgeAssuranceState: (input: {
    readonly account: ConnectedAccountRef;
    /** ISO 3166-1 alpha-2 country code. */
    readonly countryCode: string;
    readonly regionCode?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /**
   * Starts age assurance with `app.bsky.ageassurance.begin`; Bluesky emails the user a
   * verification link. Returns the new state.
   */
  readonly beginAgeAssurance: (input: {
    readonly account: ConnectedAccountRef;
    readonly email: string;
    /** Language for the email, such as `en`. */
    readonly language: string;
    readonly countryCode: string;
    readonly regionCode?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Resolves a handle to a DID with `com.atproto.identity.resolveHandle`. */
  readonly resolveHandle: (input: {
    readonly account: ConnectedAccountRef;
    readonly handle: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<string>;
  /** Reads a DID document with `com.atproto.identity.resolveDid`. */
  readonly resolveDid: (input: {
    readonly account: ConnectedAccountRef;
    readonly did: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /**
   * Resolves a handle or DID with `com.atproto.identity.resolveIdentity`. The server checks
   * both directions; `handle` is `handle.invalid` when the handle does not verify.
   */
  readonly resolveIdentity: (input: {
    readonly account: ConnectedAccountRef;
    readonly identifier: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<{ readonly did: string; readonly handle: string; readonly didDoc: JsonObject }>;
  /**
   * Creates an app password with `com.atproto.server.createAppPassword`. The password is
   * returned only here; store it like any credential. Needs a full-scope session: app-password
   * sessions cannot create app passwords. `privileged` passwords can also use chat.
   */
  readonly createAppPassword: (input: {
    readonly account: ConnectedAccountRef;
    readonly name: string;
    readonly privileged?: boolean;
    readonly context?: AdapterOperationContext;
  }) => Promise<{
    readonly name: string;
    readonly password: string;
    readonly createdAt: string;
    readonly privileged?: boolean;
  }>;
  /** Lists app password names and dates. Passwords themselves are never returned. */
  readonly listAppPasswords: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<
    readonly { readonly name: string; readonly createdAt: string; readonly privileged?: boolean }[]
  >;
  /** Revokes an app password by name, ending every session it created. */
  readonly revokeAppPassword: (input: {
    readonly account: ConnectedAccountRef;
    readonly name: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /** Changes the account's handle with `com.atproto.identity.updateHandle`. */
  readonly updateHandle: (input: {
    readonly account: ConnectedAccountRef;
    readonly handle: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /** Asks the service to re-resolve a handle or DID now, after a DNS or handle change. */
  readonly refreshIdentity: (input: {
    readonly account: ConnectedAccountRef;
    readonly identifier: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<{ readonly did: string; readonly handle: string; readonly didDoc: JsonObject }>;
  /**
   * Deactivates the account with `com.atproto.server.deactivateAccount`. Its content stops
   * being served until `activateAccount`. `deleteAfter` asks the PDS to delete it after then.
   */
  readonly deactivateAccount: (input: {
    readonly account: ConnectedAccountRef;
    readonly deleteAfter?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly activateAccount: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /** Emails a deletion token; finish with `deleteBlueskyAccount`. */
  readonly requestAccountDelete: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /** Emails a confirmation token for the account's address; finish with `confirmEmail`. */
  readonly requestEmailConfirmation: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  readonly confirmEmail: (input: {
    readonly account: ConnectedAccountRef;
    readonly email: string;
    readonly token: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /** Starts an email change; `tokenRequired` says whether a code was emailed. */
  readonly requestEmailUpdate: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<{ readonly tokenRequired: boolean }>;
  readonly updateEmail: (input: {
    readonly account: ConnectedAccountRef;
    readonly email: string;
    /** Required when `requestEmailUpdate` returned `tokenRequired: true`. */
    readonly token?: string;
    /** Require an emailed code at sign-in. */
    readonly emailAuthFactor?: boolean;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /**
   * Mints a service-auth JWT with `com.atproto.server.getServiceAuth`, for example to create an
   * account on a new PDS during migration. Treat the token as a credential.
   */
  readonly getServiceAuth: (input: {
    readonly account: ConnectedAccountRef;
    /** DID of the service the token is for. */
    readonly aud: string;
    /** Lifetime in seconds. */
    readonly expiresInSeconds?: number;
    /** Restrict the token to one method NSID. */
    readonly lxm?: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<string>;
  /** DID credentials the (new) PDS wants in the DID document during migration. */
  readonly getRecommendedDidCredentials: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Emails a token that `signPlcOperation` needs. did:plc accounts only. */
  readonly requestPlcOperationSignature: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /** Has the current PDS sign a PLC operation with the given changes; returns the operation. */
  readonly signPlcOperation: (input: {
    readonly account: ConnectedAccountRef;
    readonly token: string;
    readonly rotationKeys?: readonly string[];
    readonly alsoKnownAs?: readonly string[];
    readonly verificationMethods?: JsonObject;
    readonly services?: JsonObject;
    readonly context?: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Submits a signed PLC operation through the (new) PDS. */
  readonly submitPlcOperation: (input: {
    readonly account: ConnectedAccountRef;
    readonly operation: JsonObject;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /**
   * Imports a repository CAR file with `com.atproto.repo.importRepo`. Large repositories need a
   * `context` with a longer `retryBudget.maxElapsedMs` than the 30-second default.
   */
  readonly importRepo: (input: {
    readonly account: ConnectedAccountRef;
    readonly car: Blob | Uint8Array<ArrayBuffer>;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /** Blobs referenced by imported records that the PDS does not have yet. */
  readonly listMissingBlobs: (input: BlueskyPageInput) => Promise<{
    readonly blobs: readonly { readonly cid: string; readonly recordUri: string }[];
    readonly cursor?: string;
  }>;
  /** Texts a verification code to a phone number for contact import. Beta. */
  readonly startPhoneVerification: (input: {
    readonly account: ConnectedAccountRef;
    /** E.164, for example `+12125550123`. */
    readonly phone: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /** Exchanges the texted code for the token `importContacts` needs. */
  readonly verifyPhone: (input: {
    readonly account: ConnectedAccountRef;
    readonly phone: string;
    readonly code: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<{ readonly token: string }>;
  /**
   * Uploads up to 1,000 E.164 phone numbers with `app.bsky.contact.importContacts` and returns
   * matched profiles with the index of the contact each matched.
   */
  readonly importContacts: (input: {
    readonly account: ConnectedAccountRef;
    readonly token: string;
    readonly contacts: readonly string[];
    readonly context?: AdapterOperationContext;
  }) => Promise<readonly { readonly match: JsonObject; readonly contactIndex: number }[]>;
  readonly getContactMatches: (input: BlueskyPageInput) => Promise<BlueskyActorPageResult>;
  readonly dismissContactMatch: (input: {
    readonly account: ConnectedAccountRef;
    readonly subject: string;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
  /** When contacts were last synced and how many matched; `undefined` if never. */
  readonly getContactSyncStatus: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<{ readonly syncedAt: string; readonly matchesCount: number } | undefined>;
  /** Deletes the account's imported contact data and phone verification. */
  readonly removeContactData: (input: {
    readonly account: ConnectedAccountRef;
    readonly context?: AdapterOperationContext;
  }) => Promise<void>;
}

/** Filters for `app.bsky.feed.searchPostsV2`. Arrays repeat the query parameter. */
export interface BlueskySearchPostsV2Input extends BlueskyPageInput {
  readonly query?: string;
  readonly sort?: "recent" | "top";
  readonly authors?: readonly string[];
  readonly excludeAuthors?: readonly string[];
  readonly mentions?: readonly string[];
  readonly excludeMentions?: readonly string[];
  readonly domains?: readonly string[];
  readonly excludeDomains?: readonly string[];
  readonly urls?: readonly string[];
  readonly excludeUrls?: readonly string[];
  readonly embeddedAtUris?: readonly string[];
  readonly excludeEmbeddedAtUris?: readonly string[];
  /** Without `#`, up to 64 graphemes each. */
  readonly hashtags?: readonly string[];
  readonly excludeHashtags?: readonly string[];
  readonly languages?: readonly string[];
  readonly excludeLanguages?: readonly string[];
  readonly since?: string;
  readonly until?: string;
  /** Search the full index instead of the recent window. */
  readonly allTime?: boolean;
  readonly hasMedia?: boolean;
  readonly hasVideo?: boolean;
  readonly replyParentUri?: string;
  readonly threadRootUri?: string;
  readonly excludeReplies?: boolean;
  readonly repliesOnly?: boolean;
  /** Only posts from accounts the viewer follows. */
  readonly following?: boolean;
  /** Hint for queries in `ja`, `zh`, `ko`, `th`, or `ar`. */
  readonly queryLanguage?: string;
}

/** One `app.bsky.feed.defs#interaction` sent back to a feed generator. */
export interface BlueskyFeedInteraction {
  /** The post AT-URI the interaction is about. */
  readonly item?: string;
  /** For example `app.bsky.feed.defs#requestLess` or `app.bsky.feed.defs#interactionSeen`. */
  readonly event: string;
  /** The `feedContext` the skeleton item carried, echoed back. */
  readonly feedContext?: string;
  /** The `reqId` the feed response carried, echoed back. */
  readonly reqId?: string;
}

export interface BlueskyRepoDescription {
  readonly did: string;
  readonly handle: string;
  readonly handleIsCorrect: boolean;
  readonly collections: readonly string[];
  readonly didDoc: JsonObject;
}

/** Which chats notify, and whether they push (`chat.bsky.notification.defs#chatPreference`). */
export interface BlueskyChatNotificationPreference {
  readonly include: "all" | "follows";
  readonly push: boolean;
}

export interface BlueskyChatNotificationPreferences {
  readonly chat: BlueskyChatNotificationPreference;
  readonly chatRequest: BlueskyChatNotificationPreference;
}

/** `all`, `following`, or `none`. */
export type BlueskyChatAudience = "all" | "following" | "none";

export interface BlueskyChatDeclaration {
  readonly allowIncoming: string;
  readonly allowGroupInvites?: string;
}

/** One custom label a labeler defines (`com.atproto.label.defs#labelValueDefinition`). */
export interface BlueskyLabelValueDefinition {
  /** Lowercase letters and hyphens, up to 100 characters. */
  readonly identifier: string;
  readonly severity: "inform" | "alert" | "none";
  readonly blurs: "content" | "media" | "none";
  readonly defaultSetting?: "ignore" | "warn" | "hide";
  readonly adultOnly?: boolean;
  readonly locales: readonly {
    readonly lang: string;
    readonly name: string;
    readonly description: string;
  }[];
}

export interface BlueskyLabelerPolicies {
  /** Every label value the labeler may emit, global or custom. */
  readonly labelValues: readonly string[];
  readonly labelValueDefinitions?: readonly BlueskyLabelValueDefinition[];
}

/** XRPC query parameters; arrays repeat the parameter name. */
type QueryParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Field changes for `app.bsky.actor.profile`. `null` removes a field; omitted fields stay. */
export interface BlueskyProfileChanges {
  /** Up to 64 graphemes. */
  readonly displayName?: string | null;
  /** Up to 256 graphemes. */
  readonly description?: string | null;
  /** Up to 20 graphemes. */
  readonly pronouns?: string | null;
  readonly website?: string | null;
  /** PNG or JPEG blob of at most 1,000,000 bytes from `native.uploadBlob`. */
  readonly avatar?: BlueskyBlobRef | null;
  readonly banner?: BlueskyBlobRef | null;
  readonly pinnedPost?: BlueskyPostRef | null;
  /** The `app.bsky.graph.starterpack` record the account signed up through. */
  readonly joinedViaStarterPack?: BlueskyPostRef | null;
  /** Up to 10 `app.bsky.actor.link` records from `createProfileLink`, in display order. */
  readonly links?: readonly BlueskyPostRef[] | null;
}

/** Message content for `chat.bsky.convo.defs#messageInput`. */
export interface BlueskyMessageInput {
  /** Up to 1,000 graphemes and 10,000 UTF-8 bytes. */
  readonly text: string;
  readonly mentions?: BlueskyPublishOptions["mentions"];
  /** A post to share in the message. */
  readonly embedPost?: BlueskyPostRef;
  /** A group chat join link code to share as a `chat.bsky.embed.joinLink` card. */
  readonly embedJoinLink?: string;
}

export interface BlueskyConvoInput {
  readonly account: ConnectedAccountRef;
  readonly conversationId: string;
  readonly context?: AdapterOperationContext;
}

export interface BlueskyReactionInput extends BlueskyConvoInput {
  readonly messageId: string;
  /** One emoji. */
  readonly value: string;
}

/** A page of native views with Bluesky's opaque cursor. */
export interface BlueskyPage {
  readonly items: readonly JsonObject[];
  readonly cursor?: string;
}

/** `app.bsky.actor.defs#verificationState` from a profile view. */
export interface BlueskyVerificationState {
  /** `valid`, `invalid`, or `none` for verifications issued about this actor. */
  readonly verifiedStatus: string;
  /** `valid`, `invalid`, or `none` for this actor acting as a trusted verifier. */
  readonly trustedVerifierStatus: string;
  readonly verifications: readonly {
    readonly issuer: string;
    readonly uri: string;
    readonly isValid: boolean;
    readonly createdAt: string;
  }[];
}

type FilterablePreference = {
  readonly include: "all" | "follows";
  readonly list: boolean;
  readonly push: boolean;
};

type PlainPreference = { readonly list: boolean; readonly push: boolean };

/** Fields of `app.bsky.notification.putPreferencesV2`. Omitted types stay unchanged. */
export interface BlueskyNotificationPreferences {
  readonly chat?: { readonly include: "all" | "accepted"; readonly push: boolean };
  readonly follow?: FilterablePreference;
  readonly like?: FilterablePreference;
  readonly likeViaRepost?: FilterablePreference;
  readonly mention?: FilterablePreference;
  readonly quote?: FilterablePreference;
  readonly reply?: FilterablePreference;
  readonly repost?: FilterablePreference;
  readonly repostViaRepost?: FilterablePreference;
  readonly starterpackJoined?: PlainPreference;
  readonly subscribedPost?: PlainPreference;
  readonly unverified?: PlainPreference;
  readonly verified?: PlainPreference;
}

export interface BlueskyHideReplyInput {
  readonly account: ConnectedAccountRef;
  /** AT-URI of the reply post to hide or unhide. */
  readonly replyUri: string;
  readonly hidden: boolean;
  readonly context?: AdapterOperationContext;
}

export interface BlueskyHideReplyResult {
  readonly hidden: boolean;
  /** The threadgate record after the change. Absent when no threadgate exists. */
  readonly threadgate?: BlueskyPostRef;
}

export interface BlueskyPageInput {
  readonly account: ConnectedAccountRef;
  readonly cursor?: string;
  readonly limit?: number;
  readonly context?: AdapterOperationContext;
}

export interface BlueskyActorPageInput extends BlueskyPageInput {
  readonly actor?: string;
}

export interface BlueskyPostPageInput extends BlueskyPageInput {
  readonly uri: string;
  readonly cid?: string;
}

/** `latest` (newest first) or `top`; other values the AppView adds are passed through. */
export interface BlueskyFollowPageInput extends BlueskyActorPageInput {
  readonly sort?: "latest" | "top" | (string & {});
}

export interface BlueskyActorSearchInput extends BlueskyPageInput {
  readonly query: string;
}

export interface BlueskyActorPageResult {
  readonly actors: readonly JsonObject[];
  readonly cursor?: string;
}

export interface BlueskyLikePageResult {
  readonly likes: readonly JsonObject[];
  readonly cursor?: string;
}

export interface BlueskyFeedPageResult {
  readonly feed: readonly JsonObject[];
  readonly cursor?: string;
}

export interface BlueskyCreateListInput {
  readonly account: ConnectedAccountRef;
  readonly name: string;
  /** A reference list backs a starter pack. */
  readonly purpose:
    | "app.bsky.graph.defs#curatelist"
    | "app.bsky.graph.defs#modlist"
    | "app.bsky.graph.defs#referencelist";
  readonly description?: string;
  readonly context?: AdapterOperationContext;
}

export interface BlueskyUpdateListInput extends BlueskyCreateListInput {
  readonly listUri: string;
}

export interface BlueskyOwnedRecordInput {
  readonly account: ConnectedAccountRef;
  readonly uri: string;
  readonly context?: AdapterOperationContext;
}

export interface BlueskyListItemInput {
  readonly account: ConnectedAccountRef;
  readonly listUri: string;
  readonly subject: string;
  readonly context?: AdapterOperationContext;
}

export interface BlueskyListPageInput extends BlueskyPageInput {
  readonly listUri: string;
}

export interface BlueskyListActionInput {
  readonly account: ConnectedAccountRef;
  readonly listUri: string;
  readonly context?: AdapterOperationContext;
}

export interface BlueskyModerationReportInput {
  readonly account: ConnectedAccountRef;
  readonly reasonType: string;
  readonly subject:
    | { readonly $type: "com.atproto.admin.defs#repoRef"; readonly did: string }
    | { readonly $type: "com.atproto.repo.strongRef"; readonly uri: string; readonly cid: string };
  readonly reason?: string;
  /** The tool that filed the report, for moderator tracing (`modTool.name`, free-form `meta`). */
  readonly modTool?: { readonly name: string; readonly meta?: JsonValue };
  readonly context?: AdapterOperationContext;
}

function endpoint(service: string, method: string): URL {
  let base: URL;

  try {
    base = new URL(service);
  } catch {
    throw new SocialError({
      code: "invalid_config",
      operation: "bluesky.configure",
      message: "Bluesky service must be an absolute URL.",
    });
  }

  if (base.protocol !== "https:" || base.username || base.password) {
    throw new SocialError({
      code: "invalid_config",
      operation: "bluesky.configure",
      message: "Bluesky service must use HTTPS without embedded credentials.",
    });
  }

  return new URL(`/xrpc/${method}`, base);
}

function accountMatches(
  ref: ConnectedAccountRef,
  auth: BlueskyAuthorization,
  backend: string,
): boolean {
  return ref.backend === backend && ref.platform === "bluesky" && ref.accountId === auth.did;
}

function authHeaders(auth: BlueskyAuthorization): HeadersInit {
  return auth.accessJwt === undefined ? {} : { Authorization: `Bearer ${auth.accessJwt}` };
}

function operationError(operation: string, cause: unknown, mutation = true): SocialError {
  if (cause instanceof SocialError) return cause;

  if (cause instanceof HttpError) {
    const error = cause;

    const ambiguous =
      mutation &&
      error.dispatched &&
      (error.kind !== "http" || (error.status !== undefined && error.status >= 500));

    const code = ambiguous
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
                  : "upstream_failure";

    return new SocialError({
      code,
      operation,
      message: error.message,
      retryDisposition: ambiguous
        ? { kind: "reconcile-first" }
        : error.status === 401
          ? { kind: "after-reconnect" }
          : error.status === 429 && error.retryAfterMs !== undefined
            ? { kind: "after-delay", delayMs: error.retryAfterMs }
            : !mutation && error.status !== undefined && error.status >= 500
              ? { kind: "after-delay", delayMs: 1000 }
              : { kind: "never" },
      ...definedFields({ upstreamStatus: error.status, upstreamCode: error.data?.code }),
    });
  }

  return new SocialError({
    code: "upstream_failure",
    operation,
    message: "Bluesky request failed.",
    retryDisposition: { kind: "reconcile-first" },
    cause,
  });
}

function postRef(value: JsonField): BlueskyPostRef {
  const record = object(value);

  return { uri: string(record["uri"]), cid: string(record["cid"]) };
}

/**
 * Decodes the `{ uri, cid }` a successful record write returns. The write may already have
 * happened, so an unreadable response is an uncertain outcome rather than a transport error.
 */
function writtenRef(value: JsonField, operation: string): BlueskyPostRef {
  const record = isJsonObject(value) ? value : {};

  const uri = optionalString(record["uri"]);

  const cid = optionalString(record["cid"]);

  if (!uri || !cid)
    throw new SocialError({
      code: "ambiguous_outcome",
      operation,
      message:
        "Bluesky accepted the record write but returned no URI and CID. Reconcile before retrying.",
      retryDisposition: { kind: "reconcile-first" },
    });

  return { uri, cid };
}

/**
 * Decodes the response of a write that Bluesky already received. The write may have happened, so
 * a missing or malformed required field is an uncertain outcome, never a definite failure.
 */
function decodeWrite<T>(
  response: JsonValue,
  operation: string,
  decode: (response: JsonObject) => T,
): T {
  try {
    return decode(object(response));
  } catch (cause) {
    throw new SocialError({
      code: "ambiguous_outcome",
      operation,
      message:
        "Bluesky received the write but returned a missing or malformed result. Reconcile before retrying.",
      retryDisposition: { kind: "reconcile-first" },
      cause,
    });
  }
}

/**
 * XRPC names a missing record `RecordNotFound` on HTTP 400; keep only that name.
 * Source: https://github.com/bluesky-social/atproto/blob/7fc8c879cdbc619b76c03e6ef4d05ae2dc5d9ac2/lexicons/com/atproto/repo/getRecord.json
 */
function decodeXrpcError(body: JsonValue): HttpErrorData | undefined {
  return isJsonObject(body) && body["error"] === "RecordNotFound"
    ? { code: "record-not-found" }
    : undefined;
}

/** A `getRecord` failure that means the record does not exist (some hosts answer 404). */
function isMissingRecord(error: SocialError): boolean {
  return error.upstreamCode === "record-not-found" || error.upstreamStatus === 404;
}

function videoServiceOrigin(value: string | undefined): URL {
  let url: URL;

  try {
    url = new URL(value ?? DEFAULT_VIDEO_SERVICE);
  } catch {
    throw new SocialError({
      code: "invalid_config",
      operation: "bluesky.configure",
      message: "Bluesky video service must be an absolute URL.",
    });
  }

  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/")
    throw new SocialError({
      code: "invalid_config",
      operation: "bluesky.configure",
      message: "Bluesky video service must be an HTTPS origin without credentials or a path.",
    });

  return url;
}

function serviceDid(value: string, operation: string): string {
  if (!/^did:[a-z]+:[A-Za-z0-9._:%-]{1,2000}$/.test(value))
    throw new SocialError({
      code: "invalid_config",
      operation,
      message: "Bluesky PDS service DID is malformed.",
    });

  return value;
}

/** Validates a processed video blob before it is written into a post record. */
function videoBlob(value: JsonField): JsonObject {
  const blob = object(value);

  const link = object(blob["ref"])["$link"];

  const size = blob["size"];

  if (
    blob["$type"] !== "blob" ||
    !isString(link) ||
    !/^[a-z0-9]{8,128}$/i.test(link) ||
    blob["mimeType"] !== "video/mp4" ||
    !isFiniteNumber(size) ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_VIDEO_BYTES
  )
    throw new SocialError({
      code: "media_error",
      operation: "bluesky.video.job",
      message: "Bluesky returned a video blob that cannot be embedded.",
      retryDisposition: { kind: "never" },
    });

  return { $type: "blob", ref: { $link: link }, mimeType: "video/mp4", size };
}

/** Parses app.bsky.video.defs#jobStatus and binds it to the configured DID. */
function videoJob(value: JsonField, did: string): BlueskyVideoJob {
  const job = object(value);

  const owner = string(job["did"]);

  if (owner !== did)
    throw new SocialError({
      code: "unauthorized",
      operation: "bluesky.video.job",
      message: "Bluesky video job belongs to a different DID.",
    });

  const progress = optionalNumber(job["progress"]);

  const failureCode = optionalString(job["failureCode"]);

  const error = optionalString(job["error"]);

  const message = optionalString(job["message"]);

  return {
    jobId: string(job["jobId"]),
    did: owner,
    state: string(job["state"]),
    ...definedFields({
      progress,
      blob: job["blob"] === undefined ? undefined : videoBlob(job["blob"]),
      failureCode,
      error,
      message,
    }),
  };
}

function invalidUploadResponse(message: string): never {
  throw new HttpError(message, "invalid-response", true);
}

function positiveInteger(value: JsonField): number {
  if (!isFiniteNumber(value) || !Number.isSafeInteger(value) || value <= 0)
    return invalidUploadResponse("Upstream response has an invalid part number, count, or size.");

  return value;
}

function uploadJobId(value: JsonField): string {
  const id = string(value);

  if (!VIDEO_UPLOAD_JOB_ID.test(id))
    return invalidUploadResponse("Upstream response has a malformed upload job ID.");

  return id;
}

/** Parses app.bsky.video.startUpload output. */
function uploadSession(value: JsonField): BlueskyVideoUploadSession {
  const session = object(value);

  return {
    jobId: uploadJobId(session["jobId"]),
    partSizeBytes: positiveInteger(session["partSizeBytes"]),
    partCount: positiveInteger(session["partCount"]),
    expiresAt: string(session["expiresAt"]),
  };
}

/** Parses app.bsky.video.getUploadStatus output and binds a completed job to the configured DID. */
function uploadStatus(value: JsonField, did: string): BlueskyVideoUploadStatus {
  const status = object(value);

  const completedJobId =
    status["completedJobId"] === undefined ? undefined : uploadJobId(status["completedJobId"]);

  const job = status["jobStatus"] === undefined ? undefined : videoJob(status["jobStatus"], did);

  const failureReason = optionalString(status["failureReason"]);

  return {
    jobId: uploadJobId(status["jobId"]),
    partSizeBytes: positiveInteger(status["partSizeBytes"]),
    partCount: positiveInteger(status["partCount"]),
    receivedParts: array(status["receivedParts"]).map((part) => positiveInteger(part)),
    expiresAt: string(status["expiresAt"]),
    state: string(status["state"]),
    ...definedFields({ completedJobId, job, failureReason }),
  };
}

/** Parses app.bsky.video.abortUpload output. */
function uploadAbortResult(value: JsonField): BlueskyVideoUploadAbortResult {
  const result = object(value);

  const completedJobId =
    result["completedJobId"] === undefined ? undefined : uploadJobId(result["completedJobId"]);

  const failureReason = optionalString(result["failureReason"]);

  return { state: string(result["state"]), ...definedFields({ completedJobId, failureReason }) };
}

interface VideoPart {
  readonly partNumber: number;
  readonly start: number;
  readonly end: number;
}

/** Splits `size` bytes into parts numbered from 1; the last part carries the remainder. */
function videoParts(size: number, partSize: number): VideoPart[] {
  const parts: VideoPart[] = [];

  for (let start = 0; start < size; start += partSize)
    parts.push({ partNumber: parts.length + 1, start, end: Math.min(start + partSize, size) });

  return parts;
}

function isPlainFileName(name: string): boolean {
  return (
    name.length <= 255 &&
    ![...name].some((char) => char.charCodeAt(0) < 0x20 || char === "/" || char === "\\")
  );
}

function hasValidHints(hints: BlueskyVideoUploadHints): boolean {
  return [hints.durationMs, hints.width, hints.height].every(
    (value) => value === undefined || (Number.isSafeInteger(value) && value > 0),
  );
}

/** Adds the multipart upload job ID to a failure so the caller can resume or abort the session. */
function withUploadJob(failure: SocialError, jobId: string): SocialError {
  return new SocialError({
    code: failure.code,
    operation: failure.operation,
    message: failure.message,
    backend: failure.backend,
    account: failure.account,
    issues: failure.issues,
    correlationId: failure.correlationId,
    upstreamStatus: failure.upstreamStatus,
    upstreamCode: failure.upstreamCode,
    retryDisposition: failure.retryDisposition,
    details: { ...failure.details, uploadJobId: jobId },
    cause: failure,
  });
}

type RichTextFacet = {
  readonly index: { readonly byteStart: number; readonly byteEnd: number };
  readonly features: readonly JsonObject[];
};

interface MentionInput {
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly did: string;
}

function linkFacets(text: string): RichTextFacet[] {
  const facets: RichTextFacet[] = [];

  const urlPattern = /https?:\/\/[^\s<>]+/g;

  for (const match of text.matchAll(urlPattern)) {
    let value = match[0]?.replace(/[.,;:!?]*$/u, "");

    if (value !== undefined) {
      while (
        value.endsWith(")") &&
        (value.match(/\)/g)?.length ?? 0) > (value.match(/\(/g)?.length ?? 0)
      )
        value = value.slice(0, -1).replace(/[.,;:!?]*$/u, "");
    }

    const start = match.index;

    if (start === undefined || value === undefined) continue;

    const end = start + value.length;

    const byteStart = new TextEncoder().encode(text.slice(0, start)).byteLength;

    const byteEnd = new TextEncoder().encode(text.slice(0, end)).byteLength;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: value }],
    });
  }

  return facets;
}

function invalidRichText(message: string, operation = "bluesky.prepare"): never {
  throw new SocialError({ code: "invalid_input", operation, message });
}

/** Caller-supplied publish options arrive untyped; this only admits non-array objects. */
function isOptionBag(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isStringItem(value: unknown): value is string {
  return typeof value === "string";
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isStringItem);
}

function hasMentionFields(value: unknown): value is MentionInput {
  return (
    isOptionBag(value) &&
    "byteStart" in value &&
    "byteEnd" in value &&
    "did" in value &&
    typeof value.byteStart === "number" &&
    typeof value.byteEnd === "number" &&
    typeof value.did === "string"
  );
}

function isJsonBody(body: BodyInit | undefined): body is string {
  return typeof body === "string";
}

const POST_URI =
  /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/app\.bsky\.feed\.post\/[A-Za-z0-9._~:-]{1,512}$/;

const LIST_URI =
  /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/app\.bsky\.graph\.list\/[A-Za-z0-9._~:-]{1,512}$/;

const CID = /^[A-Za-z0-9]{8,2048}$/;

const REPOST_URI =
  /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/app\.bsky\.feed\.repost\/[A-Za-z0-9._~:-]{1,512}$/;

const LINK_URI =
  /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/app\.bsky\.actor\.link\/[A-Za-z0-9._~:-]{1,512}$/;

const LIST_RECORD_URI =
  /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/app\.bsky\.graph\.list\/[A-Za-z0-9._~:-]{1,512}$/;

const DID = /^did:[a-z]+:[A-Za-z0-9._:%-]{1,2000}$/;

const LABEL_IDENTIFIER = /^[a-z-]{1,100}$/;

const STARTER_PACK_URI =
  /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/app\.bsky\.graph\.starterpack\/[A-Za-z0-9._~:-]{1,512}$/;

/** Validates an optional `via` strongRef against the record collection it must point to. */
function viaRef(
  via: BlueskyPostRef | undefined,
  uri: RegExp,
  operation: string,
  what: string,
): JsonObject | undefined {
  if (via === undefined) return undefined;

  if (!uri.test(via.uri) || !CID.test(via.cid))
    throw new SocialError({
      code: "invalid_input",
      operation,
      message: `via must be the AT-URI and CID of ${what}.`,
      retryDisposition: { kind: "never" },
    });

  return { uri: via.uri, cid: via.cid };
}

const NSID = /^[a-zA-Z][a-zA-Z0-9-]{0,62}(\.[a-zA-Z0-9-]{1,63}){2,}$/;

const RKEY = /^[A-Za-z0-9._~:-]{1,512}$/;

/** The reference PDS rejects applyWrites batches larger than 200 writes. */
const MAX_APPLY_WRITES = 200;

/** Validates a blob reference returned by com.atproto.repo.uploadBlob. */
function blobRef(value: JsonField, operation: string): JsonObject {
  const blob = object(value);

  const link = object(blob["ref"])["$link"];

  const mimeType = blob["mimeType"];

  const size = blob["size"];

  if (
    blob["$type"] !== "blob" ||
    !isString(link) ||
    !link ||
    !isString(mimeType) ||
    !isFiniteNumber(size) ||
    !Number.isSafeInteger(size) ||
    size < 0
  )
    throw new SocialError({
      code: "upstream_failure",
      operation,
      message: "Bluesky returned an invalid blob reference.",
    });

  return { $type: "blob", ref: { $link: link }, mimeType, size };
}

/** Self-label values the Bluesky app honours on posts. */
const POST_SELF_LABELS = new Set(["porn", "sexual", "nudity", "graphic-media"]);

/** Most Bluesky clients render at most four images; galleries carry five to ten. */
const MAX_GALLERY_IMAGES = 10;

const MAX_CAPTION_BYTES = 20_000;

const MAX_LINK_THUMB_BYTES = 1_000_000;

const PUBLISH_OPTION_KEYS = new Set([
  "languages",
  "mentions",
  "tags",
  "contentLabels",
  "quote",
  "replyControls",
  "disableQuotes",
  "videoCaptions",
  "videoPresentation",
  "linkThumbnail",
  "linkAssociatedRefs",
]);

type ReplyRuleKind = "mention" | "follower" | "following" | "list";

const REPLY_RULE_TYPES: Readonly<Record<ReplyRuleKind, string>> = {
  mention: "app.bsky.feed.threadgate#mentionRule",
  follower: "app.bsky.feed.threadgate#followerRule",
  following: "app.bsky.feed.threadgate#followingRule",
  list: "app.bsky.feed.threadgate#listRule",
};

function isReplyRuleKind(value: unknown): value is ReplyRuleKind {
  return value === "mention" || value === "follower" || value === "following" || value === "list";
}

function isReplyRule(value: unknown): value is BlueskyReplyRule {
  if (!isOptionBag(value) || !("kind" in value) || !isReplyRuleKind(value.kind)) return false;

  return value.kind !== "list" || ("listUri" in value && typeof value.listUri === "string");
}

function isFlag(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isPresentation(value: unknown): value is "default" | "gif" {
  return value === "default" || value === "gif";
}

function isCaptionInput(value: unknown): value is CaptionTrack {
  return (
    isOptionBag(value) &&
    "lang" in value &&
    "file" in value &&
    typeof value.lang === "string" &&
    isBlobRefInput(
      value.file,
      (mimeType, size) => mimeType === "text/vtt" && size <= MAX_CAPTION_BYTES,
    )
  );
}

/** Admits a `com.atproto.repo.uploadBlob` reference whose MIME type and size pass `accept`. */
function isBlobRefInput(
  value: unknown,
  accept: (mimeType: string, size: number) => boolean,
): value is BlueskyBlobRef {
  return (
    isOptionBag(value) &&
    "$type" in value &&
    "ref" in value &&
    "mimeType" in value &&
    "size" in value &&
    value.$type === "blob" &&
    isOptionBag(value.ref) &&
    "$link" in value.ref &&
    typeof value.ref.$link === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.size === "number" &&
    blobRefFits(
      {
        $type: "blob",
        ref: { $link: value.ref.$link },
        mimeType: value.mimeType,
        size: value.size,
      },
      accept,
    )
  );
}

/** Checks a typed blob reference's link syntax, size, and MIME type. */
function blobRefFits(
  blob: BlueskyBlobRef,
  accept: (mimeType: string, size: number) => boolean,
): boolean {
  return (
    blob.$type === "blob" &&
    /^[a-z0-9]{8,128}$/i.test(blob.ref.$link) &&
    Number.isSafeInteger(blob.size) &&
    blob.size > 0 &&
    accept(blob.mimeType, blob.size)
  );
}

function blobJson(blob: BlueskyBlobRef): JsonObject {
  return {
    $type: "blob",
    ref: { $link: blob.ref.$link },
    mimeType: blob.mimeType,
    size: blob.size,
  };
}

const RECORD_URI =
  /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/[a-zA-Z][a-zA-Z0-9-]{0,62}(\.[a-zA-Z0-9-]{1,63}){2,}\/[A-Za-z0-9._~:-]{1,512}$/;

/** A strongRef to any record in a DID-based repository. */
function isRecordRefInput(value: unknown): value is BlueskyPostRef {
  return (
    isOptionBag(value) &&
    "uri" in value &&
    "cid" in value &&
    typeof value.uri === "string" &&
    typeof value.cid === "string" &&
    RECORD_URI.test(value.uri) &&
    CID.test(value.cid)
  );
}

function isPostRefInput(value: unknown): value is BlueskyPostRef {
  return (
    isOptionBag(value) &&
    "uri" in value &&
    "cid" in value &&
    typeof value.uri === "string" &&
    typeof value.cid === "string" &&
    POST_URI.test(value.uri) &&
    CID.test(value.cid)
  );
}

/** A validated WebVTT caption track for `app.bsky.embed.video#caption`. */
interface CaptionTrack {
  readonly lang: string;
  readonly file: BlueskyBlobRef;
}

/** Publish options after validation. `record` holds the fields written straight into the post. */
interface PostOptions {
  readonly record: JsonObject;
  readonly quote?: BlueskyPostRef;
  /** Threadgate `allow` rules. Present (even empty) only when the caller set replyControls. */
  readonly replyRules?: readonly JsonObject[];
  readonly disableQuotes: boolean;
  readonly captions: readonly CaptionTrack[];
  readonly presentation?: "default" | "gif";
  readonly linkThumbnail?: BlueskyBlobRef;
  readonly linkAssociatedRefs?: readonly BlueskyPostRef[];
}

/** A copy of a stored record without one field, so a rewrite can drop it. */
function withoutField(record: JsonObject | undefined, field: string): JsonObject {
  return Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => key !== field));
}

function byteOffset(text: string, index: number): number {
  return new TextEncoder().encode(text.slice(0, index)).byteLength;
}

/**
 * Hashtag facets, following the detection rules of Bluesky's reference RichText: a `#` or `＃`
 * after whitespace or at the start, at least one non-digit, non-punctuation character, trailing
 * punctuation removed, and at most 64 characters.
 */
function tagFacets(text: string): RichTextFacet[] {
  const facets: RichTextFacet[] = [];

  // Each `(?:(?!…).)` is one tag character: not whitespace, a soft hyphen, a zero-width or
  // joining character, or U+20E2. The middle run must also contain a non-digit, non-punctuation
  // character. Alternation keeps the joiners out of character classes.
  const pattern =
    /(^|\s)[#＃]((?!\ufe0f)(?:(?!\s|\u00AD|\u2060|\u200A|\u200B|\u200C|\u200D|\u20E2).)*(?:(?!\d|\p{P}|\s|\u00AD|\u2060|\u200A|\u200B|\u200C|\u200D|\u20E2).)+(?:(?!\s|\u00AD|\u2060|\u200A|\u200B|\u200C|\u200D|\u20E2).)*)?/gu;

  for (const match of text.matchAll(pattern)) {
    const leading = match[1] ?? "";

    const tag = (match[2] ?? "").trim().replace(/\p{P}+$/gu, "");

    if (tag.length === 0 || tag.length > 64) continue;

    const start = match.index + leading.length;

    facets.push({
      index: {
        byteStart: byteOffset(text, start),
        byteEnd: byteOffset(text, start + 1 + tag.length),
      },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag }],
    });
  }

  return facets;
}

function overlaps(facet: RichTextFacet, others: readonly RichTextFacet[]): boolean {
  return others.some(
    (other) =>
      facet.index.byteStart < other.index.byteEnd && facet.index.byteEnd > other.index.byteStart,
  );
}

function languageTags(values: readonly string[], max: number, message: string): string[] {
  if (values.length > max) invalidRichText(message);

  try {
    return Intl.getCanonicalLocales([...values]);
  } catch {
    invalidRichText("Bluesky languages must be valid BCP 47 tags.");
  }
}

function postTags(values: readonly string[]): string[] {
  if (values.length > 8) invalidRichText("Bluesky options.tags accepts at most 8 hashtags.");

  return values.map((raw) => {
    const tag = raw.trim().replace(/^[#＃]/u, "");

    if (
      tag.length === 0 ||
      /\s/u.test(tag) ||
      graphemeCount(tag) > 64 ||
      new TextEncoder().encode(tag).byteLength > 640
    )
      invalidRichText("Each Bluesky tag needs 1-64 graphemes, at most 640 bytes, and no spaces.");

    return tag;
  });
}

function selfLabels(values: readonly string[]): JsonObject {
  if (
    values.length === 0 ||
    values.length > 10 ||
    values.some((label) => !POST_SELF_LABELS.has(label))
  )
    invalidRichText(
      "Bluesky contentLabels accepts up to 10 of porn, sexual, nudity, and graphic-media.",
    );

  return {
    $type: "com.atproto.label.defs#selfLabels",
    values: [...new Set(values)].map((val) => ({ val })),
  };
}

function replyRules(rules: readonly BlueskyReplyRule[]): JsonObject[] {
  if (rules.length > 5) invalidRichText("Bluesky replyControls accepts at most 5 rules.");

  return rules.map((rule) => {
    if (rule.kind !== "list") return { $type: REPLY_RULE_TYPES[rule.kind] };

    if (!LIST_URI.test(rule.listUri))
      invalidRichText("A list reply rule needs an app.bsky.graph.list AT-URI in listUri.");

    return { $type: REPLY_RULE_TYPES.list, list: rule.listUri };
  });
}

function captionTracks(tracks: readonly CaptionTrack[]): CaptionTrack[] {
  if (tracks.length > 20) invalidRichText("Bluesky videoCaptions accepts at most 20 tracks.");

  return tracks.map((track) => {
    const [lang] = languageTags([track.lang], 1, "Caption lang must be one BCP 47 tag.");

    if (lang === undefined) invalidRichText("Caption lang must be one BCP 47 tag.");

    return { lang, file: track.file };
  });
}

/**
 * Rich-text facets for post or chat text: a link facet per URL, a tag facet per hashtag, and the
 * caller's DID mentions after checking their UTF-8 offsets.
 */
function richTextFacets(text: string, mentions: readonly MentionInput[]): RichTextFacet[] {
  const links = linkFacets(text);

  const facets = [...links, ...tagFacets(text).filter((facet) => !overlaps(facet, links))];

  const bytes = new TextEncoder().encode(text);

  if (mentions.length > 100)
    invalidRichText("Bluesky mentions must be an array of at most 100 DID references.");

  const spans: { start: number; end: number }[] = [];

  for (const value of mentions) {
    if (
      !Number.isSafeInteger(value.byteStart) ||
      !Number.isSafeInteger(value.byteEnd) ||
      value.byteStart < 0 ||
      value.byteEnd <= value.byteStart ||
      value.byteEnd > bytes.length ||
      (bytes[value.byteStart]! & 0xc0) === 0x80 ||
      (value.byteEnd < bytes.length && (bytes[value.byteEnd]! & 0xc0) === 0x80) ||
      !/^did:[a-z]+:[A-Za-z0-9._:%-]+$/.test(value.did)
    )
      invalidRichText("Mention offsets must span complete UTF-8 characters and identify a DID.");

    const { byteStart, byteEnd, did } = value;

    if (!new TextDecoder().decode(bytes.slice(byteStart, byteEnd)).startsWith("@"))
      invalidRichText("A mention span must start with @.");

    if (
      spans.some((span) => byteStart < span.end && byteEnd > span.start) ||
      facets.some((facet) => byteStart < facet.index.byteEnd && byteEnd > facet.index.byteStart)
    )
      invalidRichText("Mention spans must not overlap links, hashtags, or other mentions.");
    spans.push({ start: byteStart, end: byteEnd });
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#mention", did }],
    });
  }

  facets.sort((left, right) => left.index.byteStart - right.index.byteStart);

  return facets;
}

function postOptions(text: string, target: PreparedPublishTarget): PostOptions {
  const options = target.options ?? {};

  if (!isOptionBag(options)) invalidRichText("Bluesky options must be an object.");

  if (Object.keys(options).some((key) => !PUBLISH_OPTION_KEYS.has(key)))
    invalidRichText("A supplied Bluesky option is not supported.");

  const languages = "languages" in options ? options.languages : undefined;

  if (languages !== undefined && !isStringList(languages))
    invalidRichText("Bluesky accepts at most three language tags.");

  const langs =
    languages === undefined
      ? undefined
      : languageTags(languages, 3, "Bluesky accepts at most three language tags.");

  const mentions = ("mentions" in options ? options.mentions : undefined) ?? [];

  if (!isOptionList(mentions) || mentions.length > 100 || !mentions.every(hasMentionFields))
    invalidRichText("Bluesky mentions must be an array of at most 100 DID references.");

  const facets = richTextFacets(text, mentions);

  const tagList = "tags" in options ? options.tags : undefined;

  if (tagList !== undefined && !isStringList(tagList))
    invalidRichText("Bluesky options.tags must be a list of strings.");

  const labelList = "contentLabels" in options ? options.contentLabels : undefined;

  if (labelList !== undefined && !isStringList(labelList))
    invalidRichText("Bluesky contentLabels must be a list of label values.");

  const tags = tagList === undefined ? undefined : postTags(tagList);

  const labels = labelList === undefined ? undefined : selfLabels(labelList);

  const quote = "quote" in options ? options.quote : undefined;

  if (quote !== undefined && !isPostRefInput(quote))
    invalidRichText("Bluesky options.quote needs a post AT-URI and CID.");

  const ruleList = "replyControls" in options ? options.replyControls : undefined;

  if (ruleList !== undefined && (!isOptionList(ruleList) || !ruleList.every(isReplyRule)))
    invalidRichText("Each reply rule needs kind mention, follower, following, or list.");

  const rules = ruleList === undefined ? undefined : replyRules(ruleList);

  const disableQuotes = "disableQuotes" in options ? options.disableQuotes : undefined;

  if (disableQuotes !== undefined && !isFlag(disableQuotes))
    invalidRichText("Bluesky options.disableQuotes must be a boolean.");

  const captionList = "videoCaptions" in options ? options.videoCaptions : undefined;

  if (
    captionList !== undefined &&
    (!isOptionList(captionList) || !captionList.every(isCaptionInput))
  )
    invalidRichText(
      "Each video caption needs a lang and an uploaded text/vtt blob of at most 20,000 bytes.",
    );

  const captions = captionList === undefined ? [] : captionTracks(captionList);

  const presentation = "videoPresentation" in options ? options.videoPresentation : undefined;

  if (presentation !== undefined && !isPresentation(presentation))
    invalidRichText("Bluesky options.videoPresentation must be default or gif.");

  const linkThumbnail = "linkThumbnail" in options ? options.linkThumbnail : undefined;

  if (
    linkThumbnail !== undefined &&
    !isBlobRefInput(
      linkThumbnail,
      (mimeType, size) =>
        /^image\/[a-z0-9!#$&^_.+-]+$/i.test(mimeType) && size <= MAX_LINK_THUMB_BYTES,
    )
  )
    invalidRichText(
      "Bluesky linkThumbnail must be an uploaded image/* blob of at most 1,000,000 bytes.",
    );

  const associated = "linkAssociatedRefs" in options ? options.linkAssociatedRefs : undefined;

  if (
    associated !== undefined &&
    (!isOptionList(associated) || !associated.every((ref) => isRecordRefInput(ref)))
  )
    invalidRichText("Bluesky linkAssociatedRefs must be record AT-URI and CID pairs.");

  const linkAssociatedRefs = associated?.map((ref) => ({ uri: ref.uri, cid: ref.cid }));

  return {
    record: definedFields({
      langs,
      facets: facets.length ? facets : undefined,
      tags,
      labels,
    }),
    disableQuotes: disableQuotes === true,
    captions,
    ...definedFields({ quote, replyRules: rules, presentation, linkThumbnail, linkAssociatedRefs }),
  };
}

const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

let lastTidMicros = 0n;

/**
 * A record key in the AT Protocol TID format: 53 bits of microseconds since the epoch and a
 * 10-bit clock identifier, base32-sortable. Callers that write a post together with its
 * threadgate or postgate need the key before the write, because gates share the post's key.
 */
function nextTid(): string {
  const now = BigInt(Date.now()) * 1000n;

  lastTidMicros = now > lastTidMicros ? now : lastTidMicros + 1n;

  const clock = new Uint16Array(1);
  globalThis.crypto.getRandomValues(clock);

  let value = (lastTidMicros << 10n) | BigInt((clock[0] ?? 0) & 0x3ff);

  let out = "";

  for (let index = 0; index < 13; index++) {
    out = (TID_ALPHABET[Number(value & 31n)] ?? "2") + out;
    value >>= 5n;
  }

  return out;
}

const DRAFT_ID = /^[234567a-z]{13}$/;

/** Encodes a draft for `app.bsky.draft.defs#draft`, validating it against the lexicon bounds. */
function draftJson(draft: BlueskyDraft): JsonObject {
  if (draft.posts.length === 0 || draft.posts.length > 100)
    invalidRichText("A Bluesky draft holds 1 to 100 posts.", "bluesky.drafts");

  const posts = draft.posts.map((post): JsonObject => {
    if (new TextEncoder().encode(post.text).byteLength > 10_000)
      invalidRichText("Draft post text is limited to 10,000 bytes.", "bluesky.drafts");

    if (post.linkUrl !== undefined && !/^https?:\/\/[^\s]+$/i.test(post.linkUrl))
      invalidRichText("Draft linkUrl must be an absolute http(s) URL.", "bluesky.drafts");

    if (post.quote !== undefined && !isPostRefInput(post.quote))
      invalidRichText("Draft quote needs a post AT-URI and CID.", "bluesky.drafts");

    const mediaKinds = [post.images, post.gallery, post.video].filter((kind) => kind !== undefined);

    if (
      mediaKinds.length > 1 ||
      (post.images?.length ?? 0) > 4 ||
      post.images?.length === 0 ||
      (post.gallery?.length ?? 0) > 20 ||
      post.gallery?.length === 0 ||
      (post.video?.captions?.length ?? 0) > 20 ||
      (post.video?.captions ?? []).some(
        (caption) =>
          !caption.lang.trim() || new TextEncoder().encode(caption.content).byteLength > 10_000,
      )
    )
      invalidRichText(
        "A draft post holds one media kind: 1 to 4 images, a gallery of 1 to 20 images, or one video with up to 20 captions of at most 10,000 UTF-8 bytes.",
        "bluesky.drafts",
      );

    const localImage = (media: BlueskyDraftMedia): JsonObject => {
      if (media.path.length < 1 || new TextEncoder().encode(media.path).byteLength > 1024)
        invalidRichText("Draft media paths are 1 to 1,024 UTF-8 bytes.", "bluesky.drafts");

      if (media.alt !== undefined && graphemeCount(media.alt) > 2000)
        invalidRichText("Draft alt text is limited to 2,000 graphemes.", "bluesky.drafts");

      return { localRef: { path: media.path }, ...definedFields({ alt: media.alt }) };
    };

    const video = post.video;

    return {
      text: post.text,
      ...definedFields({
        labels: post.contentLabels === undefined ? undefined : selfLabels(post.contentLabels),
        embedExternals: post.linkUrl === undefined ? undefined : [{ uri: post.linkUrl }],
        embedRecords:
          post.quote === undefined
            ? undefined
            : [{ record: { uri: post.quote.uri, cid: post.quote.cid } }],
        embedImages: post.images?.map(localImage),
        embedGallery:
          post.gallery === undefined
            ? undefined
            : {
                items: post.gallery.map((media) => ({
                  $type: "app.bsky.draft.defs#draftEmbedImage",
                  ...localImage(media),
                })),
              },
        embedVideos:
          video === undefined
            ? undefined
            : [
                {
                  ...localImage(video),
                  ...definedFields({
                    captions: video.captions?.map((caption) => ({
                      lang: caption.lang,
                      content: caption.content,
                    })),
                  }),
                },
              ],
      }),
    };
  });

  for (const [field, value] of [
    ["deviceId", draft.deviceId],
    ["deviceName", draft.deviceName],
  ] as const)
    if (value !== undefined && value.length > 100)
      invalidRichText(`Draft ${field} is limited to 100 characters.`, "bluesky.drafts");

  return {
    posts,
    ...definedFields({
      langs:
        draft.languages === undefined
          ? undefined
          : languageTags(draft.languages, 3, "A Bluesky draft accepts at most three languages."),
      threadgateAllow:
        draft.replyControls === undefined ? undefined : replyRules(draft.replyControls),
      postgateEmbeddingRules: draft.disableQuotes
        ? [{ $type: "app.bsky.feed.postgate#disableRule" }]
        : undefined,
      deviceId: draft.deviceId,
      deviceName: draft.deviceName,
    }),
  };
}

const PROFILE_TEXT_LIMITS = {
  displayName: { graphemes: 64, bytes: 640 },
  description: { graphemes: 256, bytes: 2560 },
  pronouns: { graphemes: 20, bytes: 200 },
} as const;

/** Validates profile changes against the app.bsky.actor.profile lexicon and encodes them. */
function profileChanges(
  changes: BlueskyProfileChanges,
  operation: string,
): Record<string, JsonValue | null> {
  for (const [field, limit] of Object.entries(PROFILE_TEXT_LIMITS)) {
    const value =
      field === "displayName"
        ? changes.displayName
        : field === "description"
          ? changes.description
          : changes.pronouns;

    if (
      isStringItem(value) &&
      (graphemeCount(value) > limit.graphemes ||
        new TextEncoder().encode(value).byteLength > limit.bytes)
    )
      invalidRichText(`Profile ${field} is limited to ${limit.graphemes} graphemes.`, operation);
  }

  if (isStringItem(changes.website) && !/^https?:\/\/[^\s]+$/i.test(changes.website))
    invalidRichText("Profile website must be an absolute http(s) URL.", operation);

  const image = (blob: BlueskyBlobRef | null | undefined): JsonObject | null | undefined => {
    if (blob === null || blob === undefined) return blob;

    if (
      !blobRefFits(
        blob,
        (mimeType, size) =>
          (mimeType === "image/png" || mimeType === "image/jpeg") && size <= 1_000_000,
      )
    )
      invalidRichText(
        "Avatars and banners must be PNG or JPEG blobs of at most 1,000,000 bytes.",
        operation,
      );

    return blobJson(blob);
  };

  const pinned = changes.pinnedPost;

  if (pinned !== undefined && pinned !== null && !isPostRefInput(pinned))
    invalidRichText("pinnedPost needs a post AT-URI and CID.", operation);

  const joined = changes.joinedViaStarterPack;

  if (
    joined !== undefined &&
    joined !== null &&
    (!STARTER_PACK_URI.test(joined.uri) || !CID.test(joined.cid))
  )
    invalidRichText("joinedViaStarterPack needs a starter pack AT-URI and CID.", operation);

  const links = changes.links;

  if (
    links !== undefined &&
    links !== null &&
    (links.length > 10 || links.some((link) => !LINK_URI.test(link.uri) || !CID.test(link.cid)))
  )
    invalidRichText("Profile links take up to 10 app.bsky.actor.link AT-URIs and CIDs.", operation);

  return definedFields({
    displayName: changes.displayName,
    description: changes.description,
    pronouns: changes.pronouns,
    website: changes.website,
    avatar: image(changes.avatar),
    banner: image(changes.banner),
    pinnedPost:
      pinned === undefined || pinned === null ? pinned : { uri: pinned.uri, cid: pinned.cid },
    joinedViaStarterPack:
      joined === undefined || joined === null ? joined : { uri: joined.uri, cid: joined.cid },
    links:
      links === undefined || links === null
        ? links
        : links.map((link) => ({ uri: link.uri, cid: link.cid })),
  });
}

interface PublicProjection {
  readonly variants?: Readonly<Record<string, PublicProjection>>;
  readonly strings?: readonly string[];
  readonly numbers?: readonly string[];
  readonly booleans?: readonly string[];
  readonly objects?: Readonly<Record<string, PublicProjection>>;
  readonly arrays?: Readonly<Record<string, PublicProjection>>;
}

function projectPublic(value: JsonField, projection: PublicProjection): JsonObject {
  const source = object(value);

  if (projection.variants !== undefined) {
    const type = optionalString(source["$type"]);
    const variant = type === undefined ? undefined : projection.variants[type];

    return projectPublic(source, variant ?? { strings: ["$type"] });
  }

  const result: Record<string, JsonValue> = {};

  for (const field of projection.strings ?? []) {
    const item = optionalString(source[field]);

    if (item !== undefined) result[field] = item;
  }

  for (const field of projection.numbers ?? []) {
    const item = optionalNumber(source[field]);

    if (item !== undefined) result[field] = item;
  }

  for (const field of projection.booleans ?? []) {
    const item = source[field];

    if (item !== undefined) {
      if (!isBoolean(item))
        throw new SocialError({
          code: "upstream_failure",
          operation: "bluesky.posts.list",
          message: "Bluesky returned an invalid public boolean field.",
        });
      result[field] = item;
    }
  }

  for (const [field, nested] of Object.entries(projection.objects ?? {}))
    if (source[field] !== undefined) result[field] = projectPublic(source[field], nested);

  for (const [field, nested] of Object.entries(projection.arrays ?? {}))
    if (source[field] !== undefined)
      result[field] = array(source[field]).map((item) => projectPublic(item, nested));

  return result;
}

const publicAuthor: PublicProjection = { strings: ["did", "handle", "displayName", "avatar"] };

const publicStrongRef: PublicProjection = { strings: ["uri", "cid"] };

const publicBlob: PublicProjection = {
  strings: ["$type", "mimeType"],
  numbers: ["size"],
  objects: { ref: { strings: ["$link"] } },
};

const publicAspectRatio: PublicProjection = { numbers: ["width", "height"] };

const publicMediaRecord: PublicProjection = {
  variants: {
    "app.bsky.embed.images": {
      strings: ["$type"],
      arrays: {
        images: {
          strings: ["alt"],
          objects: { image: publicBlob, aspectRatio: publicAspectRatio },
        },
      },
    },
    "app.bsky.embed.video": {
      strings: ["$type", "alt"],
      objects: { video: publicBlob, aspectRatio: publicAspectRatio },
    },
    "app.bsky.embed.external": {
      strings: ["$type"],
      objects: {
        external: { strings: ["uri", "title", "description"], objects: { thumb: publicBlob } },
      },
    },
    "app.bsky.embed.gallery": {
      strings: ["$type"],
      arrays: {
        items: {
          strings: ["$type", "alt"],
          objects: { image: publicBlob, aspectRatio: publicAspectRatio },
        },
      },
    },
  },
};

const publicRecordEmbed: PublicProjection = {
  strings: ["$type"],
  objects: { record: publicStrongRef },
};

const publicEmbed: PublicProjection = {
  variants: {
    ...publicMediaRecord.variants,
    "app.bsky.embed.record": publicRecordEmbed,
    "app.bsky.embed.recordWithMedia": {
      strings: ["$type"],
      objects: { record: publicRecordEmbed, media: publicMediaRecord },
    },
  },
};

const publicMediaView: PublicProjection = {
  variants: {
    "app.bsky.embed.images#view": {
      strings: ["$type"],
      arrays: {
        images: {
          strings: ["alt", "thumb", "fullsize"],
          objects: { aspectRatio: publicAspectRatio },
        },
      },
    },
    "app.bsky.embed.video#view": {
      strings: ["$type", "cid", "playlist", "thumbnail", "alt"],
      objects: { aspectRatio: publicAspectRatio },
    },
    "app.bsky.embed.external#view": {
      strings: ["$type"],
      objects: { external: { strings: ["uri", "title", "description", "thumb"] } },
    },
    "app.bsky.embed.gallery#view": {
      strings: ["$type"],
      arrays: {
        items: {
          strings: ["$type", "thumbnail", "fullsize", "alt"],
          objects: { aspectRatio: publicAspectRatio },
        },
      },
    },
  },
};

const publicPostRecord: PublicProjection = {
  strings: ["$type", "text", "createdAt"],
  objects: {
    reply: { objects: { root: publicStrongRef, parent: publicStrongRef } },
    embed: publicEmbed,
  },
  arrays: {
    facets: {
      objects: { index: { numbers: ["byteStart", "byteEnd"] } },
      arrays: { features: { strings: ["$type", "uri", "did", "tag"] } },
    },
  },
};

const publicRecordView: PublicProjection = {
  strings: ["$type"],
  objects: {
    record: {
      strings: ["$type", "uri", "cid", "indexedAt"],
      objects: { author: publicAuthor, value: publicPostRecord },
      arrays: {
        get embeds() {
          return publicEmbedView;
        },
      },
    },
  },
};

const publicEmbedView: PublicProjection = {
  variants: {
    ...publicMediaView.variants,
    "app.bsky.embed.record#view": publicRecordView,
    "app.bsky.embed.recordWithMedia#view": {
      strings: ["$type"],
      objects: { record: publicRecordView, media: publicMediaView },
    },
  },
};

const publicFeedPost: PublicProjection = {
  strings: ["uri", "cid", "indexedAt"],
  numbers: ["likeCount", "repostCount", "replyCount", "quoteCount", "bookmarkCount"],
  objects: { author: publicAuthor, record: publicPostRecord, embed: publicEmbedView },
  arrays: {
    labels: {
      strings: ["src", "uri", "cid", "val", "cts", "exp"],
      booleans: ["neg"],
      numbers: ["ver"],
    },
  },
};

function graphemeCount(text: string): number {
  return Intl.Segmenter === undefined
    ? Array.from(text).length
    : [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
}

function validatePostText(text: string, operation = "bluesky.prepare"): void {
  if (new TextEncoder().encode(text).byteLength > 3000 || graphemeCount(text) > 300)
    invalidRichText(
      "Bluesky posts must be at most 300 graphemes and 3,000 UTF-8 bytes.",
      operation,
    );
}

function imageMimeType(value: string | undefined): string {
  if (value === undefined || !/^image\/[a-z0-9!#$&^_.+-]+$/i.test(value))
    invalidRichText("Bluesky images require a declared image/* MIME type.");

  return value.toLowerCase();
}

async function readMedia(
  source: MediaInput,
  fetcher: typeof globalThis.fetch,
  context: AdapterOperationContext,
  allowMediaHost: (hostname: string) => boolean,
  declaredMimeType: string | undefined,
): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }> {
  const duration = remainingBudget(context);

  const controller = new AbortController();

  const abort = () => controller.abort(context.signal?.reason);

  if (context.signal?.aborted) abort();
  context.signal?.addEventListener("abort", abort, { once: true });

  const timer = setTimeout(() => controller.abort(new Error("Media deadline exceeded")), duration);

  try {
    controller.signal.throwIfAborted();

    if (source.kind === "blob") {
      if (source.blob.size > MAX_IMAGE_BYTES)
        throw new SocialError({
          code: "media_error",
          operation: "bluesky.uploadBlob",
          message: "Image exceeds the 2,000,000-byte limit.",
        });

      return {
        bytes: await readBinary(source.blob.stream(), MAX_IMAGE_BYTES, controller.signal),
        mimeType: imageMimeType(declaredMimeType ?? (source.blob.type || undefined)),
      };
    }

    if (source.kind === "stream")
      return {
        bytes: await readBinary(source.open(), MAX_IMAGE_BYTES, controller.signal),
        mimeType: imageMimeType(declaredMimeType),
      };

    if (source.kind === "https-url") {
      const url = httpsUrl(source.url);

      if (!allowMediaHost(url.hostname))
        throw new SocialError({
          code: "media_error",
          operation: "bluesky.uploadBlob",
          message: "Remote image host is outside the configured egress policy.",
        });

      const pending = fetchWithoutRedirects(fetcher, url, { signal: controller.signal });
      void pending.then(
        (response) => {
          if (controller.signal.aborted) void response.body?.cancel().catch(() => undefined);
        },
        () => undefined,
      );

      const response = await abortable(pending, controller.signal);

      if (
        !response.ok ||
        !response.body ||
        Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES
      ) {
        void response.body?.cancel().catch(() => undefined);

        throw new SocialError({
          code: "media_error",
          operation: "bluesky.uploadBlob",
          message: "Remote image was unavailable or exceeded its byte limit.",
        });
      }

      return {
        bytes: await readBinary(response.body, MAX_IMAGE_BYTES, controller.signal),
        mimeType: imageMimeType(
          declaredMimeType ?? response.headers.get("content-type")?.split(";")[0]?.trim(),
        ),
      };
    }

    throw new SocialError({
      code: "media_error",
      operation: "bluesky.uploadBlob",
      message: "This image source cannot be uploaded.",
    });
  } catch (error) {
    if (controller.signal.aborted)
      throw new SocialError({
        code: context.signal?.aborted ? "cancelled" : "timeout",
        operation: "bluesky.uploadBlob",
        message: "Image preparation was interrupted before publication.",
        retryDisposition: { kind: "never" },
      });

    throw error;
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", abort);
  }
}

export function bluesky(options: BlueskyOptions): SocialAdapter<BlueskyNative> {
  const backend = options.backend ?? "default";

  const fetcher = options.fetch ?? globalThis.fetch;

  const allowMediaHost = options.allowMediaHost ?? (() => false);

  const http = createHttp({ fetch: fetcher, ...definedFields({ timeoutMs: options.timeoutMs }) });

  const auth = options.auth;

  if (options.session) {
    if (options.session.did !== auth.did)
      throw new SocialError({
        code: "invalid_config",
        operation: "bluesky.configure",
        message: "OAuth session DID must match the configured account DID.",
      });

    if (auth.accessJwt !== undefined)
      throw new SocialError({
        code: "invalid_config",
        operation: "bluesky.configure",
        message: "Use OAuth session transport or bearer credentials, not both.",
      });
  } else if (auth.accessJwt === undefined) {
    throw new SocialError({
      code: "invalid_config",
      operation: "bluesky.configure",
      message: "Bluesky authorization requires accessJwt or an OAuth session.",
    });
  }

  const service = auth.service;

  const account = connectedAccountRef({ backend, platform: "bluesky", accountId: auth.did });

  const capabilities: CapabilityManifest = {
    schemaVersion: 1,
    backend,
    apiRevision: "AT Protocol XRPC 2026-09",
    runtime: ["node>=22.12", "bun"],
    capabilities: [
      {
        operation: "webhooks.verify",
        platform: "bluesky",
        availability: "unsupported-by-platform",
        notes:
          "Bluesky has no signed webhook delivery. Read the connected account inbox with notifications.list and markSeen. The firehose and Jetstream are network indexing streams; filtering by the connected DID watches its authored records, not inbound mentions or replies. blueskyJetstreamSubscription builds a Jetstream URL and parseBlueskyJetstreamEvent decodes frames; the SDK opens no sockets.",
      },
      {
        operation: "accounts.read",
        platform: "bluesky",
        availability: "available",
        notes:
          "App passwords authorize through the PDS. OAuth requires atproto plus appropriate repo:<collection>?action=... or rpc:<method> permissions, or the broad transition:generic grant. These are alternatives; inspect the returned grant.",
      },
      {
        operation: "posts.publish",
        platform: "bluesky",
        availability: "available",
        formats: ["text", "image", "video"],
        // Mirrors prepareTarget: up to ten images (2,000,000 bytes each) or one uploaded MP4.
        constraints: { maxItems: MAX_GALLERY_IMAGES, allowedMimeTypes: ["image/*", "video/mp4"] },
        notes:
          "One to four images use app.bsky.embed.images; five to ten use app.bsky.embed.gallery and need width and height. Reply controls and quote blocking write a threadgate and postgate with the post in one com.atproto.repo.applyWrites call. App passwords authorize through the PDS. OAuth requires atproto plus appropriate repo:<collection>?action=... or rpc:<method> permissions, or the broad transition:generic grant. These are alternatives; inspect the returned grant.",
      },
      {
        operation: "posts.schedule",
        platform: "bluesky",
        availability: "unsupported-by-platform",
        notes:
          "AT Protocol records are visible once written. The post createdAt field is a client-declared timestamp and does not delay publication.",
      },
      {
        operation: "posts.read",
        platform: "bluesky",
        availability: "available",
        formats: ["text", "image"],
      },
      ...[
        "graph.read",
        "graph.follow",
        "graph.unfollow",
        "graph.block",
        "graph.unblock",
        "graph.mute",
        "graph.unmute",
        "likes.read",
        "likes.write",
        "lists.read",
        "lists.write",
        "profiles.search",
        "moderation.report",
      ].map((operation) => ({
        operation,
        platform: "bluesky" as const,
        availability: "available" as const,
        notes:
          "App passwords authorize through the PDS. OAuth requires atproto plus appropriate repo:<collection>?action=... or rpc:<method> permissions, or the broad transition:generic grant. These are alternatives; inspect the returned grant.",
      })),
      {
        operation: "posts.list",
        platform: "bluesky",
        availability: "available",
        formats: ["text", "image"],
      },
      {
        operation: "posts.draft",
        platform: "bluesky",
        availability: "available",
        surface: "native",
        notes:
          "native.createDraft, listDrafts, updateDraft, and deleteDraft store private app.bsky.draft drafts. Drafts do not publish on a schedule; image, gallery, and video draft embeds hold device-local paths, not media bytes.",
      },
      ...["bookmarks.read", "bookmarks.write", "labels.read"].map((operation) => ({
        operation,
        platform: "bluesky" as const,
        availability: "available" as const,
        surface: "native" as const,
        notes:
          operation === "labels.read"
            ? "native.getLabelerServices and native.queryLabels read labeler views and labels."
            : "Private bookmarks through app.bsky.bookmark; post records only.",
      })),
      {
        operation: "messages.group.write",
        platform: "bluesky",
        availability: "available",
        surface: "native",
        notes:
          "Bluesky marks chat.bsky.group endpoints unstable while under active development. Group creation is not idempotent.",
      },
      {
        operation: "comments.read",
        platform: "bluesky",
        availability: "available",
      },
      {
        operation: "analytics.read",
        platform: "bluesky",
        availability: "available",
        formats: ["text", "image"],
      },
      { operation: "analytics.account.read", platform: "bluesky", availability: "available" },
      {
        operation: "comments.write",
        platform: "bluesky",
        availability: "available",
        formats: ["text"],
        notes:
          "App passwords authorize through the PDS. OAuth requires atproto plus appropriate repo:<collection>?action=... or rpc:<method> permissions, or the broad transition:generic grant. These are alternatives; inspect the returned grant.",
      },
      {
        operation: "posts.publish.video",
        platform: "bluesky",
        availability: "available",
        formats: ["video"],
        notes:
          "One MP4 per post from a media.upload reference. Publishing reads the video job once and creates the post only when the processed blob is ready; it never waits or polls.",
      },
      {
        operation: "comments.moderate",
        platform: "bluesky",
        availability: "available",
        notes:
          "Native hideReply adds or removes a reply URI in the root post's threadgate hiddenReplies list. Only the root post's author can hide replies.",
      },
      {
        operation: "media.upload",
        platform: "bluesky",
        availability: "available",
        formats: ["video"],
        notes:
          "Uploads one video/mp4 Blob of at most 300,000,000 bytes to the Bluesky video service with a PDS service token: one uploadVideo request up to 50,000,000 bytes, the multipart upload above that. Returns the processing job ID as the media reference.",
      },
      {
        operation: "media.video",
        platform: "bluesky",
        availability: "available",
        formats: ["video"],
        notes:
          "native.uploadVideo sends one app.bsky.video.uploadVideo request and returns the job. native.uploadVideoMultipart sends startUpload, each uploadPart in order, and finishUpload; startVideoUpload, uploadVideoPart, finishVideoUpload, getVideoUploadStatus, and abortVideoUpload expose each step for resuming.",
      },
      {
        operation: "media.status",
        platform: "bluesky",
        availability: "available",
        formats: ["video"],
        notes: "native.getVideoJobStatus reads app.bsky.video.getJobStatus once per call.",
      },
      {
        operation: "media.limits.read",
        platform: "bluesky",
        availability: "available",
        formats: ["video"],
        notes:
          "native.getVideoUploadLimits reads the daily video allowance. Uploads do not check it automatically.",
      },
      // Source, accessed 2026-09-24: https://github.com/bluesky-social/atproto/discussions/3038
      {
        operation: "posts.update",
        platform: "bluesky",
        availability: "unsupported-by-platform",
        notes:
          "Bluesky treats posts as immutable. A putRecord rewrite succeeds on the PDS, but the Bluesky AppView ignores post updates and the new CID breaks existing strong references from replies, quotes, likes, and reposts.",
      },
      ...[
        "posts.repost",
        "posts.quote",
        "posts.delete",
        "posts.removeFromPlatform",
        "notifications.read",
        "notifications.seen",
        "profile.read",
        "profiles.read",
        "profile.update",
        "feeds.read",
        "search.posts",
        "chat.read",
        "chat.write",
      ].map((operation) => ({
        operation,
        platform: "bluesky" as const,
        availability: "available" as const,
        notes: operation.startsWith("chat.")
          ? "Native chat calls proxy through did:web:api.bsky.chat#bsky_chat. OAuth needs atproto transition:generic transition:chat.bsky in requested and metadata scopes, or appropriate rpc:chat.bsky... permissions; transition:generic alone excludes chat. Inspect returned grants. Application authorization is required."
          : "App passwords or operation-specific OAuth permissions are required for authenticated calls; inspect the returned grant.",
      })),
    ],
  };

  async function xrpc(
    method: string,
    context: AdapterOperationContext,
    init: {
      readonly body?: BodyInit;
      readonly headers?: HeadersInit;
      readonly maxAttempts?: number;
      /** Forces POST for a procedure that takes no input body. */
      readonly method?: "POST";
      /** Keeps the XRPC `RecordNotFound` error name on a failed request. */
      readonly decodeRecordNotFound?: true;
    } = {},
  ): Promise<JsonValue> {
    const httpMethod = init.method ?? (init.body === undefined ? "GET" : "POST");

    // Keep a transport protocol error local to this request so concurrent calls
    // cannot overwrite its original response evidence.
    let sessionError: SocialError | undefined;
    const session = options.session;

    const requestHttp =
      session === undefined
        ? http
        : createHttp({
            ...definedFields({ timeoutMs: options.timeoutMs }),
            fetch: async (input, init) => {
              const url = new URL(input instanceof Request ? input.url : String(input));

              try {
                return await session.fetchHandler(url.pathname + url.search, init);
              } catch (error) {
                if (error instanceof SocialError) {
                  sessionError = error;
                  // The HTTP wrapper must not interpret a protocol rejection as a
                  // retryable network error or discard its response evidence.
                  throw new HttpError(
                    "Bluesky session transport rejected the request.",
                    "invalid-response",
                    false,
                  );
                }

                throw error;
              }
            },
          });

    try {
      const headers = new Headers(init.headers);

      if (isJsonBody(init.body) && !headers.has("Content-Type"))
        headers.set("Content-Type", "application/json");

      if (method.startsWith("chat.bsky.") && !headers.has("atproto-proxy"))
        headers.set("atproto-proxy", "did:web:api.bsky.chat#bsky_chat");

      return await requestHttp({
        url: endpoint(service, method),
        timeoutMs: remainingBudget(context),
        method: httpMethod,
        ...(options.session
          ? { headers }
          : { headers: { ...authHeaders(auth), ...Object.fromEntries(headers.entries()) } }),
        ...definedFields({
          body: init.body,
          signal: context.signal,
          decodeErrorBody: init.decodeRecordNotFound ? decodeXrpcError : undefined,
        }),
        maxAttempts:
          init.maxAttempts ??
          (httpMethod === "GET" ? Math.min(context.retryBudget.maxAttempts, 3) : 1),
      });
    } catch (error) {
      if (sessionError !== undefined) throw sessionError;
      throw operationError(`bluesky.${method}`, error, httpMethod === "POST");
    }
  }

  /**
   * One authenticated GET whose response is text rather than JSON, such as JSON Lines. It uses
   * the same credentials and chat proxy header as `xrpc`, without retries.
   */
  async function xrpcText(
    method: string,
    context: AdapterOperationContext,
    maxBytes: number,
  ): Promise<string> {
    const operation = `bluesky.${method}`;

    const headers = new Headers(options.session ? undefined : authHeaders(auth));

    if (method.startsWith("chat.bsky."))
      headers.set("atproto-proxy", "did:web:api.bsky.chat#bsky_chat");

    const controller = new AbortController();

    const abort = () => controller.abort(context.signal?.reason);
    context.signal?.addEventListener("abort", abort, { once: true });

    const timer = setTimeout(
      () => controller.abort(new Error("HTTP deadline exceeded")),
      Math.max(1, remainingBudget(context)),
    );

    try {
      const url = endpoint(service, method);

      const init: RequestInit = { method: "GET", headers, signal: controller.signal };

      const response = await abortable(
        options.session === undefined
          ? fetchWithoutRedirects(fetcher, url, init)
          : options.session.fetchHandler(url.pathname + url.search, init),
        controller.signal,
      );

      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);

        throw new HttpError("Bluesky rejected the request.", "http", true, response.status);
      }

      if (response.body === null) return "";

      return new TextDecoder("utf-8", { fatal: true }).decode(
        await readBinary(response.body, maxBytes, controller.signal),
      );
    } catch (error) {
      if (error instanceof SocialError) throw error;

      throw operationError(operation, error, false);
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
    }
  }

  async function verifiedSession(
    context: AdapterOperationContext,
  ): Promise<{ readonly did: string; readonly handle?: string }> {
    if (options.session !== undefined) {
      const status = object(await xrpc("com.atproto.server.checkAccountStatus", context));

      if (!isBoolean(status["activated"]) || !isBoolean(status["validDid"]))
        throw new SocialError({
          code: "upstream_failure",
          operation: "bluesky.accounts.get",
          message: "Bluesky returned an invalid authenticated account status.",
        });

      if (!status["activated"] || !status["validDid"])
        throw new SocialError({
          code: "ineligible_account",
          operation: "bluesky.accounts.get",
          message: "Bluesky account is inactive or its DID is not valid for this PDS.",
        });

      return { did: auth.did, ...definedFields({ handle: options.session.handle }) };
    }

    const session = object(await xrpc("com.atproto.server.getSession", context));
    const did = string(session["did"]);

    if (did !== auth.did)
      throw new SocialError({
        code: "unauthorized",
        operation: "bluesky.accounts.get",
        message: "The configured credential belongs to a different DID.",
      });

    return { did, ...definedFields({ handle: optionalString(session["handle"]) }) };
  }

  /** Uploads bytes with com.atproto.repo.uploadBlob and returns the validated blob reference. */
  async function uploadBytes(
    bytes: Uint8Array,
    mimeType: string,
    context: AdapterOperationContext,
  ): Promise<JsonObject> {
    const response = object(
      await xrpc("com.atproto.repo.uploadBlob", context, {
        body: new Blob([bytes.slice()], { type: mimeType }),
        headers: { "Content-Type": mimeType },
      }),
    );

    return blobRef(response["blob"], "bluesky.uploadBlob");
  }

  /** Sends one com.atproto.repo.applyWrites transaction and decodes each per-write result. */
  async function applyWritesRequest(
    writes: readonly BlueskyWrite[],
    context: AdapterOperationContext,
    extra: { readonly validate?: boolean; readonly swapCommit?: string } = {},
  ): Promise<BlueskyApplyWritesResult> {
    const operation = "bluesky.applyWrites";

    if (writes.length === 0 || writes.length > MAX_APPLY_WRITES)
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: `applyWrites takes 1 to ${MAX_APPLY_WRITES} writes.`,
        retryDisposition: { kind: "never" },
      });

    const wire = writes.map((write): JsonObject => {
      if (!NSID.test(write.collection))
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "Each write needs a valid collection NSID.",
          retryDisposition: { kind: "never" },
        });

      if (write.rkey !== undefined && (!RKEY.test(write.rkey) || /^\.{1,2}$/.test(write.rkey)))
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "Record keys must use the AT Protocol record-key syntax.",
          retryDisposition: { kind: "never" },
        });

      if (write.action !== "delete" && write.value["$type"] !== write.collection)
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "Each record value needs a $type equal to its collection.",
          retryDisposition: { kind: "never" },
        });

      return write.action === "delete"
        ? {
            $type: "com.atproto.repo.applyWrites#delete",
            collection: write.collection,
            rkey: write.rkey,
          }
        : {
            $type: `com.atproto.repo.applyWrites#${write.action}`,
            collection: write.collection,
            value: write.value,
            ...definedFields({ rkey: write.rkey }),
          };
    });

    const raw = await xrpc("com.atproto.repo.applyWrites", context, {
      body: JSON.stringify({
        repo: auth.did,
        writes: wire,
        ...definedFields({ validate: extra.validate, swapCommit: extra.swapCommit }),
      }),
    });

    try {
      const response = object(raw);

      const commit = response["commit"] === undefined ? undefined : object(response["commit"]);

      const results = array(response["results"] ?? []).map((value, index): BlueskyWriteResult => {
        const result = object(value);

        const action = writes[index]?.action ?? "create";

        const status = optionalString(result["validationStatus"]);

        return {
          action,
          ...definedFields({
            uri: optionalString(result["uri"]),
            cid: optionalString(result["cid"]),
            validationStatus: status === "valid" || status === "unknown" ? status : undefined,
          }),
        };
      });

      return {
        results,
        ...definedFields({
          commit:
            commit === undefined
              ? undefined
              : { cid: string(commit["cid"]), rev: string(commit["rev"]) },
        }),
      };
    } catch {
      throw new SocialError({
        code: "ambiguous_outcome",
        operation,
        message: "Bluesky accepted applyWrites but returned unreadable results. Reconcile first.",
        retryDisposition: { kind: "reconcile-first" },
      });
    }
  }

  /**
   * Reads this account's threadgate or postgate for a post and writes the mutated record. An
   * existing record is replaced with its CID as `swapRecord`; a missing one is created with the
   * post's record key, which fails rather than overwrites if another writer created it first.
   */
  async function upsertGate(
    collection: "app.bsky.feed.threadgate" | "app.bsky.feed.postgate",
    postUri: string,
    mutate: (current: JsonObject | undefined) => JsonObject,
    context: AdapterOperationContext,
  ): Promise<BlueskyPostRef> {
    return upsertOwnRecord(collection, recordKey(postUri, "app.bsky.feed.post"), mutate, context);
  }

  /** Read-modify-write of one record in this repository with compare-and-swap. */
  /** Reads one record from any repository; `undefined` when it does not exist. */
  async function readRecord(
    repo: string,
    collection: string,
    rkey: string,
    context: AdapterOperationContext,
  ): Promise<JsonObject | undefined> {
    const query = new URLSearchParams({ repo, collection, rkey });

    try {
      return object(
        object(
          await xrpc(`com.atproto.repo.getRecord?${query}`, context, {
            decodeRecordNotFound: true,
          }),
        )["value"],
      );
    } catch (error) {
      if (error instanceof SocialError && isMissingRecord(error)) return undefined;

      throw error;
    }
  }

  /** Writes a singleton record with rkey `self`, creating or replacing it. */
  async function putSelfRecord(
    collection: string,
    record: JsonObject,
    context: AdapterOperationContext,
  ): Promise<BlueskyPostRef> {
    return writtenRef(
      await xrpc("com.atproto.repo.putRecord", context, {
        body: JSON.stringify({ repo: auth.did, collection, rkey: "self", record }),
      }),
      "bluesky.com.atproto.repo.putRecord",
    );
  }

  /** Creates a TID-keyed record in this account's repository. */
  async function createOwnRecord(
    collection: string,
    record: JsonObject,
    context: AdapterOperationContext,
  ): Promise<BlueskyPostRef> {
    return writtenRef(
      await xrpc("com.atproto.repo.createRecord", context, {
        body: JSON.stringify({ repo: auth.did, collection, record }),
      }),
      "bluesky.com.atproto.repo.createRecord",
    );
  }

  /** Deletes one of this account's records after checking the URI's collection. */
  async function deleteOwnRecord(
    input: BlueskyOwnedRecordInput,
    collection: string,
    operation: string,
  ): Promise<void> {
    const context = nativeContext(input.context, operation);
    assertNativeAccount(input.account, context, operation);

    await xrpc("com.atproto.repo.deleteRecord", context, {
      body: JSON.stringify({ repo: auth.did, collection, rkey: recordKey(input.uri, collection) }),
    });
  }

  async function upsertOwnRecord(
    collection: string,
    rkey: string,
    mutate: (current: JsonObject | undefined) => JsonObject,
    context: AdapterOperationContext,
  ): Promise<BlueskyPostRef> {
    const query = new URLSearchParams({ repo: auth.did, collection, rkey });

    let existing: { readonly record: JsonObject; readonly cid: string } | undefined;

    try {
      const found = object(
        await xrpc(`com.atproto.repo.getRecord?${query}`, context, { decodeRecordNotFound: true }),
      );

      existing = { record: object(found["value"]), cid: string(found["cid"]) };
    } catch (error) {
      if (!(error instanceof SocialError) || !isMissingRecord(error)) throw error;
    }

    const record = mutate(existing?.record);

    return writtenRef(
      existing === undefined
        ? await xrpc("com.atproto.repo.createRecord", context, {
            body: JSON.stringify({ repo: auth.did, collection, rkey, record }),
          })
        : await xrpc("com.atproto.repo.putRecord", context, {
            body: JSON.stringify({
              repo: auth.did,
              collection,
              rkey,
              record,
              swapRecord: existing.cid,
            }),
          }),
      existing === undefined
        ? "bluesky.com.atproto.repo.createRecord"
        : "bluesky.com.atproto.repo.putRecord",
    );
  }

  /**
   * Creates a post and its threadgate and/or postgate in one applyWrites transaction. Gates must
   * share the post's record key, so the key is generated here as a TID before the write.
   */
  async function createGatedPost(
    record: JsonObject,
    parsed: PostOptions,
    createdAt: string,
    context: AdapterOperationContext,
  ): Promise<BlueskyPostRef> {
    const rkey = nextTid();

    const uri = `at://${auth.did}/app.bsky.feed.post/${rkey}`;

    const writes: BlueskyWrite[] = [
      { action: "create", collection: "app.bsky.feed.post", rkey, value: record },
    ];

    if (parsed.replyRules !== undefined)
      writes.push({
        action: "create",
        collection: "app.bsky.feed.threadgate",
        rkey,
        value: {
          $type: "app.bsky.feed.threadgate",
          post: uri,
          allow: [...parsed.replyRules],
          createdAt,
        },
      });

    if (parsed.disableQuotes)
      writes.push({
        action: "create",
        collection: "app.bsky.feed.postgate",
        rkey,
        value: {
          $type: "app.bsky.feed.postgate",
          post: uri,
          embeddingRules: [{ $type: "app.bsky.feed.postgate#disableRule" }],
          createdAt,
        },
      });

    const { results } = await applyWritesRequest(writes, context);

    const first = results[0];

    if (first?.uri !== uri || first.cid === undefined || !first.cid)
      throw new SocialError({
        code: "ambiguous_outcome",
        operation: "bluesky.publish",
        message: "Bluesky did not confirm the post in the applyWrites result. Reconcile first.",
        retryDisposition: { kind: "reconcile-first" },
      });

    return { uri, cid: first.cid };
  }

  const videoOrigin = videoServiceOrigin(options.videoService);

  const timeout = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };

  const videoHttp = createHttp({ fetch: fetcher, ...timeout });

  // Bluesky's video guide notes that a video the service already processed is reported as
  // `already_exists` together with the existing job and blob. The upload transport reads that
  // 409 body as a job status; `videoJob` still validates it and binds it to this DID.
  const videoUploadHttp = createHttp({
    fetch: async (input, init) => {
      const response = await fetcher(input, init);

      return response.status === 409
        ? new Response(response.body, { status: 200, headers: response.headers })
        : response;
    },
    ...timeout,
  });

  async function videoRequest(
    method: string,
    query: URLSearchParams,
    context: AdapterOperationContext,
    init: {
      readonly token?: string;
      /** Sends a POST with this body. Without it the request is a GET. */
      readonly payload?: { readonly body: Blob | string; readonly contentType: string };
      /** Reads a 409 `already_exists` body as the existing job (single-request upload only). */
      readonly acceptExisting?: true;
    } = {},
  ): Promise<JsonValue> {
    const url = new URL(`/xrpc/${method}`, videoOrigin);
    url.search = query.toString();

    const payload = init.payload;

    try {
      return await (init.acceptExisting ? videoUploadHttp : videoHttp)({
        url,
        timeoutMs: remainingBudget(context),
        method: payload === undefined ? "GET" : "POST",
        headers: definedFields({
          Authorization: init.token === undefined ? undefined : `Bearer ${init.token}`,
          "Content-Type": payload?.contentType,
        }),
        ...definedFields({ body: payload?.body, signal: context.signal }),
        maxAttempts: payload === undefined ? Math.min(context.retryBudget.maxAttempts, 3) : 1,
      });
    } catch (error) {
      throw operationError(`bluesky.${method}`, error, payload !== undefined);
    }
  }

  /** Requests a short-lived service token from the account's PDS. The token is never logged. */
  async function serviceToken(
    aud: string,
    lxm: string,
    expiresInSeconds: number | undefined,
    context: AdapterOperationContext,
  ): Promise<string> {
    const query = new URLSearchParams({ aud, lxm });

    if (expiresInSeconds !== undefined)
      query.set("exp", String(Math.floor(Date.now() / 1000) + expiresInSeconds));

    const response = object(
      await xrpc(`com.atproto.server.getServiceAuth?${query.toString()}`, context),
    );

    return string(response["token"]);
  }

  /** Resolves the PDS service DID that the video service stores the processed blob with. */
  async function pdsAudience(context: AdapterOperationContext): Promise<string> {
    if (options.pdsDid !== undefined) return serviceDid(options.pdsDid, "bluesky.video.upload");

    const session = object(await xrpc("com.atproto.server.getSession", context));

    const didDoc = session["didDoc"];

    if (session["did"] !== auth.did || didDoc === undefined)
      throw new SocialError({
        code: "invalid_config",
        operation: "bluesky.video.upload",
        message:
          "The session did not include a DID document for this account. Configure pdsDid for video uploads.",
      });

    const document = object(didDoc);

    const pds = array(document["service"] ?? []).find((entry) => {
      const service = object(entry);

      return optionalString(service["id"])?.endsWith("#atproto_pds") === true;
    });

    if (document["id"] !== auth.did || pds === undefined)
      throw new SocialError({
        code: "invalid_config",
        operation: "bluesky.video.upload",
        message: "The DID document does not name a PDS for this account. Configure pdsDid.",
      });

    let host: string;

    try {
      const url = new URL(string(object(pds)["serviceEndpoint"]));

      if (url.protocol !== "https:") throw new Error("PDS endpoint must use HTTPS");
      host = url.host;
    } catch {
      throw new SocialError({
        code: "invalid_config",
        operation: "bluesky.video.upload",
        message: "The DID document names an invalid PDS endpoint. Configure pdsDid.",
      });
    }

    return serviceDid(`did:web:${host.replace(":", "%3A")}`, "bluesky.video.upload");
  }

  /**
   * Mints the token for the multipart upload calls. Bluesky's app sends every multipart call with
   * the same token as the single-request upload: audience is the account's PDS service DID, `lxm`
   * is `com.atproto.repo.uploadBlob`, and it lasts 30 minutes.
   */
  async function uploadToken(
    aud: string,
    context: AdapterOperationContext,
  ): Promise<{ readonly token: string; readonly expiresAt: number }> {
    const expiresAt = Date.now() + VIDEO_UPLOAD_TOKEN_SECONDS * 1000;

    const token = await serviceToken(
      aud,
      "com.atproto.repo.uploadBlob",
      VIDEO_UPLOAD_TOKEN_SECONDS,
      context,
    );

    return { token, expiresAt };
  }

  function jsonPayload(value: JsonObject) {
    return { body: JSON.stringify(value), contentType: "application/json" };
  }

  async function startUploadRequest(
    input: { readonly sizeBytes: number; readonly name?: string } & BlueskyVideoUploadHints,
    token: string,
    context: AdapterOperationContext,
  ): Promise<BlueskyVideoUploadSession> {
    const response = await videoRequest(
      "app.bsky.video.startUpload",
      new URLSearchParams(),
      context,
      {
        token,
        payload: jsonPayload({
          sizeBytes: input.sizeBytes,
          mimeType: "video/mp4",
          ...definedFields({
            name: input.name,
            durationMs: input.durationMs,
            width: input.width,
            height: input.height,
          }),
        }),
      },
    );

    try {
      return uploadSession(response);
    } catch (error) {
      throw operationError("bluesky.app.bsky.video.startUpload", error);
    }
  }

  async function uploadPartRequest(
    input: { readonly jobId: string; readonly partNumber: number; readonly part: Blob },
    token: string,
    context: AdapterOperationContext,
  ): Promise<BlueskyVideoPartReceipt> {
    const response = await videoRequest(
      "app.bsky.video.uploadPart",
      new URLSearchParams({ jobId: input.jobId, partNumber: String(input.partNumber) }),
      context,
      { token, payload: { body: input.part, contentType: "application/octet-stream" } },
    );

    try {
      const receipt = object(response);

      const partNumber = positiveInteger(receipt["partNumber"]);

      const sizeBytes = positiveInteger(receipt["sizeBytes"]);

      if (partNumber !== input.partNumber || sizeBytes !== input.part.size)
        invalidUploadResponse("Bluesky recorded a different part number or size.");

      return { partNumber, sizeBytes };
    } catch (error) {
      throw operationError("bluesky.app.bsky.video.uploadPart", error);
    }
  }

  async function finishUploadRequest(
    jobId: string,
    token: string,
    context: AdapterOperationContext,
  ): Promise<BlueskyVideoJob> {
    const response = await videoRequest(
      "app.bsky.video.finishUpload",
      new URLSearchParams(),
      context,
      { token, payload: jsonPayload({ jobId }) },
    );

    try {
      const result = object(response);

      const completedJobId = uploadJobId(result["completedJobId"]);

      // On deduplication the processing job differs from the upload job; poll the completed one.
      return { ...videoJob(result["jobStatus"], auth.did), jobId: completedJobId };
    } catch (error) {
      throw operationError("bluesky.app.bsky.video.finishUpload", error);
    }
  }

  /** Validates the account and arguments shared by the multipart session calls. */
  function multipartContext(
    input: {
      readonly account: ConnectedAccountRef;
      readonly jobId: string;
      readonly context?: AdapterOperationContext;
    },
    operation: string,
  ): AdapterOperationContext {
    const context = nativeContext(input.context, operation);
    assertNativeAccount(input.account, context, operation);

    if (!VIDEO_UPLOAD_JOB_ID.test(input.jobId))
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "Bluesky video upload job ID is malformed.",
        retryDisposition: { kind: "never" },
      });

    return context;
  }

  function invalidMultipartInput(operation: string): never {
    throw new SocialError({
      code: "invalid_input",
      operation,
      message: `Bluesky multipart video upload requires a non-empty video/mp4 of at most ${MAX_VIDEO_BYTES} bytes, a plain file name, and positive integer duration and dimension hints.`,
      retryDisposition: { kind: "never" },
    });
  }

  /** Validates a normalized video attachment and returns its MP4 bytes without I/O. */
  function videoSource(media: MediaAttachment): Blob {
    const source = media.source;

    const mimeType =
      media.mimeType ?? (source.kind === "blob" ? source.blob.type || undefined : undefined);

    if (media.kind !== "video" || source.kind !== "blob" || mimeType !== "video/mp4")
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: "Bluesky video upload requires one video/mp4 Blob.",
        retryDisposition: { kind: "never" },
      });

    return source.blob;
  }

  const nativeContext = (context: AdapterOperationContext | undefined, operation: string) =>
    context ?? {
      correlationId: operation,
      retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 },
      backendInstance: backend,
    };

  const assertNativeAccount = (
    selected: ConnectedAccountRef,
    context: AdapterOperationContext,
    operation: string,
  ) => {
    if (!accountMatches(selected, auth, backend) || context.backendInstance !== backend)
      throw new SocialError({
        code: "unauthorized",
        operation,
        message: "Account reference does not belong to this Bluesky adapter.",
      });
  };

  const pageQuery = (
    input: BlueskyPageInput,
    operation = "bluesky.graph.read",
  ): URLSearchParams => {
    const limit = input.limit ?? 50;

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "Page size must be between 1 and 100.",
      });

    return new URLSearchParams({
      limit: String(limit),
      ...definedFields({ cursor: input.cursor || undefined }),
    });
  };

  const recordKey = (uri: string, collection: string): string => {
    const prefix = `at://${auth.did}/${collection}/`;

    const key = uri.startsWith(prefix) ? uri.slice(prefix.length) : "";

    if (!/^[A-Za-z0-9._~:-]{1,512}$/.test(key) || key === "." || key === "..")
      throw new SocialError({
        code: "invalid_input",
        operation: "bluesky.record.delete",
        message: "Record URI must belong to this account.",
      });

    return key;
  };

  const actorPage = (response: JsonObject, key: string): BlueskyActorPageResult => ({
    actors: array(response[key] ?? []).map((value) => object(value)),
    ...definedFields({ cursor: optionalString(response["cursor"]) }),
  });

  const feedPage = (response: JsonObject, operation: string): BlueskyFeedPageResult => {
    if (response["feed"] === undefined)
      throw new SocialError({
        code: "upstream_failure",
        operation,
        message: "Bluesky feed response did not include a feed array.",
      });

    return {
      feed: array(response["feed"]).map((entry) => object(entry)),
      ...definedFields({ cursor: optionalString(response["cursor"]) }),
    };
  };

  /** Trims identifiers (DIDs, handles, or AT-URIs) and enforces the endpoint's count limit. */
  const identifiers = (
    values: readonly string[],
    max: number,
    operation: string,
    what: string,
  ): string[] => {
    const cleaned = values.map((value) => value.trim());

    if (cleaned.length === 0 || cleaned.length > max || cleaned.some((value) => !value))
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: `Provide 1 to ${max} ${what}.`,
        retryDisposition: { kind: "never" },
      });

    return cleaned;
  };

  const listOf = (response: JsonObject, key: string): readonly JsonObject[] =>
    array(response[key] ?? []).map((value) => object(value));

  const page = (response: JsonObject, key: string): BlueskyPage => ({
    items: listOf(response, key),
    ...definedFields({ cursor: optionalString(response["cursor"]) }),
  });

  const withParams = (query: URLSearchParams, params: QueryParams): URLSearchParams => {
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined) continue;

      if (isStringItem(value)) query.set(name, value);
      else for (const item of value) query.append(name, item);
    }

    return query;
  };

  /** One authenticated GET for a paged view; the account must be this adapter's account. */
  const pagedRead = async (
    input: BlueskyPageInput,
    method: string,
    operation: string,
    params: QueryParams = {},
  ): Promise<JsonObject> => {
    const context = nativeContext(input.context, operation);
    assertNativeAccount(input.account, context, operation);

    const query = withParams(pageQuery(input, operation), params);

    return object(await xrpc(`${method}?${query}`, context));
  };

  /** One authenticated GET without paging. */
  const viewRead = async (
    account: ConnectedAccountRef,
    supplied: AdapterOperationContext | undefined,
    method: string,
    operation: string,
    params: QueryParams,
  ): Promise<JsonObject> => {
    const context = nativeContext(supplied, operation);
    assertNativeAccount(account, context, operation);

    const query = withParams(new URLSearchParams(), params);

    return object(await xrpc(`${method}?${query}`, context));
  };

  /**
   * One authenticated procedure call with a JSON body. `decode` reads the required output fields;
   * it runs after dispatch, so its failure is reported as an uncertain write.
   */
  const decodedProcedure = async <T>(
    account: ConnectedAccountRef,
    supplied: AdapterOperationContext | undefined,
    method: string,
    operation: string,
    body: JsonObject,
    decode: (response: JsonObject) => T,
  ): Promise<T> => {
    const context = nativeContext(supplied, operation);
    assertNativeAccount(account, context, operation);

    return decodeWrite(
      await xrpc(method, context, { body: JSON.stringify(body) }),
      operation,
      decode,
    );
  };

  /** One authenticated procedure call with a JSON body whose output is an object. */
  const procedure = async (
    account: ConnectedAccountRef,
    supplied: AdapterOperationContext | undefined,
    method: string,
    operation: string,
    body: JsonObject,
  ): Promise<JsonObject> =>
    decodedProcedure(account, supplied, method, operation, body, (response) => response);

  /** One authenticated procedure whose lexicon declares no output; HTTP 200 may carry no body. */
  const voidProcedure = async (
    account: ConnectedAccountRef,
    supplied: AdapterOperationContext | undefined,
    method: string,
    operation: string,
    body: JsonObject,
  ): Promise<void> => {
    const context = nativeContext(supplied, operation);
    assertNativeAccount(account, context, operation);

    await xrpc(method, context, { body: JSON.stringify(body) });
  };

  const chatPreference = (
    value: JsonField,
    operation: string,
  ): BlueskyChatNotificationPreference => {
    const preference = object(value);

    const include = preference["include"],
      push = preference["push"];

    if ((include !== "all" && include !== "follows") || !isBoolean(push))
      throw new SocialError({
        code: "upstream_failure",
        operation,
        message: "Bluesky returned an invalid chat notification preference.",
      });

    return { include, push };
  };

  const chatPreferences = (
    response: JsonObject,
    operation: string,
  ): BlueskyChatNotificationPreferences => {
    const preferences = object(response["preferences"]);

    return {
      chat: chatPreference(preferences["chat"], operation),
      chatRequest: chatPreference(preferences["chatRequest"], operation),
    };
  };

  const convoProcedure = async (
    method: string,
    operation: string,
    input: BlueskyConvoInput,
  ): Promise<JsonObject> =>
    decodedProcedure(
      input.account,
      input.context,
      method,
      operation,
      { convoId: convoId(input.conversationId, operation) },
      (response) => object(response["convo"]),
    );

  const joinLink = (response: JsonObject): JsonObject => object(response["joinLink"]);

  const joinRule = (value: string, operation: string): string => {
    if (value !== "anyone" && value !== "followedByOwner")
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "joinRule must be anyone or followedByOwner.",
        retryDisposition: { kind: "never" },
      });

    return value;
  };

  const memberDid = (value: string, operation: string): string => {
    if (!DID.test(value))
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "member must be a DID.",
        retryDisposition: { kind: "never" },
      });

    return value;
  };

  /** A trimmed, non-empty string field. */
  const requiredText = (value: string, operation: string, what: string): string => {
    const trimmed = value.trim();

    if (!trimmed)
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: `Provide a ${what}.`,
        retryDisposition: { kind: "never" },
      });

    return trimmed;
  };

  /** A procedure with neither input nor output, sent as a bodyless POST. */
  const emptyProcedure = async (
    input: { readonly account: ConnectedAccountRef; readonly context?: AdapterOperationContext },
    method: string,
    operation: string,
  ): Promise<void> => {
    const context = nativeContext(input.context, operation);
    assertNativeAccount(input.account, context, operation);

    await xrpc(method, context, { method: "POST" });
  };

  const emailAddress = (value: string, operation: string): string => {
    if (!/^[^\s@]+@[^\s@]+$/.test(value))
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "Provide an email address.",
        retryDisposition: { kind: "never" },
      });

    return value;
  };

  const phoneNumber = (value: string, operation: string): string => {
    if (!/^\+[1-9][0-9]{6,14}$/.test(value))
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "Phone numbers must be in E.164 format, such as +12125550123.",
        retryDisposition: { kind: "never" },
      });

    return value;
  };

  /** Encodes an optional page size bounded by the endpoint's own maximum. */
  const limitParam = (value: number | undefined, max: number, operation: string) => {
    if (value === undefined) return undefined;

    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: `Page size must be between 1 and ${max}.`,
        retryDisposition: { kind: "never" },
      });

    return String(value);
  };

  const countryCode = (value: string, operation: string): string => {
    if (!/^[A-Za-z]{2}$/.test(value))
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "countryCode must be a two-letter ISO 3166-1 code.",
        retryDisposition: { kind: "never" },
      });

    return value.toUpperCase();
  };

  const atUri = (value: string, operation: string): string => {
    if (!/^at:\/\/[^\s/]+(\/[^\s/]+){0,2}$/.test(value))
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "Expected an AT-URI.",
        retryDisposition: { kind: "never" },
      });

    return value;
  };

  const convoId = (value: string, operation: string): string => {
    if (!/^[\x21-\x7e]{1,256}$/.test(value))
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "Conversation and message IDs are opaque printable strings.",
        retryDisposition: { kind: "never" },
      });

    return value;
  };

  const memberDids = (values: readonly string[], max: number, operation: string): string[] => {
    const dids = identifiers(values, max, operation, "member DIDs");

    if (dids.some((value) => !/^did:[a-z]+:[A-Za-z0-9._:%-]{1,2000}$/.test(value)))
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "Chat members are identified by DID.",
        retryDisposition: { kind: "never" },
      });

    return dids;
  };

  // createGroup and editGroup: at most 50 graphemes and 500 UTF-8 bytes.
  const groupName = (value: string, operation: string): string => {
    if (
      !value.trim() ||
      graphemeCount(value) > 50 ||
      new TextEncoder().encode(value).byteLength > 500
    )
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "Group chat names need 1 to 50 graphemes and at most 500 bytes.",
        retryDisposition: { kind: "never" },
      });

    return value;
  };

  /** Encodes `chat.bsky.convo.defs#messageInput` with facets and an optional shared post. */
  const messageJson = (input: BlueskyMessageInput): JsonObject => {
    if (
      !input.text.trim() ||
      graphemeCount(input.text) > 1000 ||
      new TextEncoder().encode(input.text).byteLength > 10_000
    )
      invalidRichText(
        "Message text is required and limited to 1,000 graphemes and 10,000 bytes.",
        "bluesky.chat.send",
      );

    if (input.embedPost !== undefined && !isPostRefInput(input.embedPost))
      invalidRichText("embedPost needs a post AT-URI and CID.", "bluesky.chat.send");

    if (
      input.embedJoinLink !== undefined &&
      (input.embedPost !== undefined || !/^[\x21-\x7e]{1,256}$/.test(input.embedJoinLink))
    )
      invalidRichText(
        "embedJoinLink needs a join link code and cannot be combined with embedPost.",
        "bluesky.chat.send",
      );

    const facets = richTextFacets(input.text, input.mentions ?? []);

    return {
      text: input.text,
      ...definedFields({
        facets: facets.length ? facets : undefined,
        embed:
          input.embedPost !== undefined
            ? {
                $type: "app.bsky.embed.record",
                record: { uri: input.embedPost.uri, cid: input.embedPost.cid },
              }
            : input.embedJoinLink !== undefined
              ? { $type: "chat.bsky.embed.joinLink", code: input.embedJoinLink }
              : undefined,
      }),
    };
  };

  const reaction = async (
    method: "chat.bsky.convo.addReaction" | "chat.bsky.convo.removeReaction",
    input: BlueskyReactionInput,
  ): Promise<JsonObject> => {
    const operation = "bluesky.chat.reaction";

    if (!input.value || input.value.length > 64 || graphemeCount(input.value) !== 1)
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "A chat reaction is a single emoji.",
        retryDisposition: { kind: "never" },
      });

    return decodedProcedure(
      input.account,
      input.context,
      method,
      operation,
      {
        convoId: convoId(input.conversationId, operation),
        messageId: convoId(input.messageId, operation),
        value: input.value,
      },
      (response) => object(response["message"]),
    );
  };

  const convoAction = async (
    method: string,
    operation: string,
    input: BlueskyConvoInput,
  ): Promise<JsonObject> =>
    decodedProcedure(
      input.account,
      input.context,
      method,
      operation,
      {
        convoId: convoId(input.conversationId, operation),
      },
      (response) => object(response["convo"]),
    );

  const groupMembers = async (
    method: string,
    operation: string,
    input: BlueskyConvoInput & { readonly members: readonly string[] },
  ): Promise<JsonObject> =>
    decodedProcedure(
      input.account,
      input.context,
      method,
      operation,
      {
        convoId: convoId(input.conversationId, operation),
        members: memberDids(input.members, 49, operation),
      },
      (response) => object(response["convo"]),
    );

  const native: BlueskyNative = {
    async getPosts(input) {
      const operation = "bluesky.posts.hydrate";

      const query = new URLSearchParams();

      for (const uri of identifiers(input.uris, 25, operation, "post AT-URIs"))
        query.append("uris", atUri(uri, operation));

      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      return listOf(object(await xrpc(`app.bsky.feed.getPosts?${query}`, context)), "posts");
    },
    async getListFeed(input) {
      const operation = "bluesky.feeds.list";

      return feedPage(
        await pagedRead(input, "app.bsky.feed.getListFeed", operation, {
          list: atUri(input.listUri, operation),
        }),
        operation,
      );
    },
    async getQuotes(input) {
      const operation = "bluesky.posts.quotes";

      return page(
        await pagedRead(input, "app.bsky.feed.getQuotes", operation, {
          uri: atUri(input.uri, operation),
          cid: input.cid || undefined,
        }),
        "posts",
      );
    },
    async getRepostedBy(input) {
      const operation = "bluesky.posts.repostedBy";

      return page(
        await pagedRead(input, "app.bsky.feed.getRepostedBy", operation, {
          uri: atUri(input.uri, operation),
          cid: input.cid || undefined,
        }),
        "repostedBy",
      );
    },
    async getActorFeeds(input) {
      return page(
        await pagedRead(input, "app.bsky.feed.getActorFeeds", "bluesky.feeds.actor", {
          actor: input.actor?.trim() || auth.did,
        }),
        "feeds",
      );
    },
    async getFeedGenerator(input) {
      const operation = "bluesky.feeds.generator";

      return viewRead(input.account, input.context, "app.bsky.feed.getFeedGenerator", operation, {
        feed: atUri(input.feed, operation),
      });
    },
    async getFeedGenerators(input) {
      const operation = "bluesky.feeds.generators";

      const feeds = identifiers(input.feeds, 100, operation, "feed generator AT-URIs").map((uri) =>
        atUri(uri, operation),
      );

      return listOf(
        await viewRead(input.account, input.context, "app.bsky.feed.getFeedGenerators", operation, {
          feeds,
        }),
        "feeds",
      );
    },
    async getProfiles(input) {
      const operation = "bluesky.profiles.batch";

      return listOf(
        await viewRead(input.account, input.context, "app.bsky.actor.getProfiles", operation, {
          actors: identifiers(input.actors, 25, operation, "actors"),
        }),
        "profiles",
      );
    },
    async getSuggestions(input) {
      return actorPage(
        await pagedRead(input, "app.bsky.actor.getSuggestions", "bluesky.profiles.suggestions"),
        "actors",
      );
    },
    async getSuggestedFollowsByActor(input) {
      const operation = "bluesky.profiles.suggestions";

      return actorPage(
        await viewRead(
          input.account,
          input.context,
          "app.bsky.graph.getSuggestedFollowsByActor",
          operation,
          { actor: identifiers([input.actor], 1, operation, "actor")[0] },
        ),
        "suggestions",
      );
    },
    async getRelationships(input) {
      const operation = "bluesky.graph.relationships";

      return listOf(
        await viewRead(input.account, input.context, "app.bsky.graph.getRelationships", operation, {
          actor: input.actor?.trim() || auth.did,
          others: identifiers(input.others, 30, operation, "other actors"),
        }),
        "relationships",
      );
    },
    async getKnownFollowers(input) {
      const operation = "bluesky.graph.knownFollowers";

      return actorPage(
        await pagedRead(input, "app.bsky.graph.getKnownFollowers", operation, {
          actor: identifiers([input.actor], 1, operation, "actor")[0],
        }),
        "followers",
      );
    },
    async getVerificationState(input) {
      const profile = await native.getProfile(input);

      const state = profile["verification"];

      if (state === undefined) return undefined;

      const view = object(state);

      return {
        verifiedStatus: string(view["verifiedStatus"]),
        trustedVerifierStatus: string(view["trustedVerifierStatus"]),
        verifications: array(view["verifications"] ?? []).map((value) => {
          const entry = object(value);

          const isValid = entry["isValid"];

          if (!isBoolean(isValid))
            throw new SocialError({
              code: "upstream_failure",
              operation: "bluesky.profile.verification",
              message: "Bluesky returned a verification without isValid.",
            });

          return {
            issuer: string(entry["issuer"]),
            uri: string(entry["uri"]),
            isValid,
            createdAt: string(entry["createdAt"]),
          };
        }),
      };
    },
    async getListBlocks(input) {
      return page(
        await pagedRead(input, "app.bsky.graph.getListBlocks", "bluesky.lists.blocks"),
        "lists",
      );
    },
    async getListMutes(input) {
      return page(
        await pagedRead(input, "app.bsky.graph.getListMutes", "bluesky.lists.mutes"),
        "lists",
      );
    },
    async getListsWithMembership(input) {
      const operation = "bluesky.lists.membership";

      return page(
        await pagedRead(input, "app.bsky.graph.getListsWithMembership", operation, {
          actor: identifiers([input.actor], 1, operation, "actor")[0],
          purposes: input.purposes,
        }),
        "listsWithMembership",
      );
    },
    async muteThread(input) {
      const operation = "bluesky.threads.mute";

      await voidProcedure(input.account, input.context, "app.bsky.graph.muteThread", operation, {
        root: atUri(input.rootUri, operation),
      });
    },
    async unmuteThread(input) {
      const operation = "bluesky.threads.unmute";

      await voidProcedure(input.account, input.context, "app.bsky.graph.unmuteThread", operation, {
        root: atUri(input.rootUri, operation),
      });
    },
    async createStarterPack(input) {
      const operation = "bluesky.starterPacks.create";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const name = input.name.trim();

      const feeds = input.feeds ?? [];

      if (
        !name ||
        graphemeCount(name) > 50 ||
        new TextEncoder().encode(name).byteLength > 500 ||
        (input.description !== undefined &&
          (graphemeCount(input.description) > 300 ||
            new TextEncoder().encode(input.description).byteLength > 3000)) ||
        feeds.length > 3
      )
        throw new SocialError({
          code: "invalid_input",
          operation,
          message:
            "A starter pack needs a 1-50 grapheme name, at most a 300 grapheme description, and at most 3 feeds.",
          retryDisposition: { kind: "never" },
        });

      recordKey(input.listUri, "app.bsky.graph.list");

      return writtenRef(
        await xrpc("com.atproto.repo.createRecord", context, {
          body: JSON.stringify({
            repo: auth.did,
            collection: "app.bsky.graph.starterpack",
            record: {
              $type: "app.bsky.graph.starterpack",
              name,
              list: input.listUri,
              createdAt: new Date().toISOString(),
              ...definedFields({
                description: input.description,
                feeds: feeds.length
                  ? feeds.map((uri) => ({ uri: atUri(uri, operation) }))
                  : undefined,
              }),
            },
          }),
        }),
        operation,
      );
    },
    async deleteStarterPack(input) {
      const operation = "bluesky.starterPacks.delete";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.graph.starterpack",
          rkey: recordKey(input.uri, "app.bsky.graph.starterpack"),
        }),
      });
    },
    async getStarterPack(input) {
      const operation = "bluesky.starterPacks.get";

      return object(
        (
          await viewRead(input.account, input.context, "app.bsky.graph.getStarterPack", operation, {
            starterPack: atUri(input.uri, operation),
          })
        )["starterPack"],
      );
    },
    async getStarterPacks(input) {
      const operation = "bluesky.starterPacks.batch";

      const uris = identifiers(input.uris, 25, operation, "starter pack AT-URIs").map((uri) =>
        atUri(uri, operation),
      );

      return listOf(
        await viewRead(input.account, input.context, "app.bsky.graph.getStarterPacks", operation, {
          uris,
        }),
        "starterPacks",
      );
    },
    async getActorStarterPacks(input) {
      return page(
        await pagedRead(
          input,
          "app.bsky.graph.getActorStarterPacks",
          "bluesky.starterPacks.actor",
          {
            actor: input.actor?.trim() || auth.did,
          },
        ),
        "starterPacks",
      );
    },
    async searchStarterPacks(input) {
      const operation = "bluesky.starterPacks.search";

      return page(
        await pagedRead(input, "app.bsky.graph.searchStarterPacks", operation, {
          q: identifiers([input.query], 1, operation, "search query")[0],
        }),
        "starterPacks",
      );
    },
    async unrepostPost(input) {
      const operation = "bluesky.unrepost";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const prefix = `at://${auth.did}/app.bsky.feed.repost/`;

      const rkey = input.repostUri.startsWith(prefix) ? input.repostUri.slice(prefix.length) : "";

      if (!RKEY.test(rkey) || /^\.{1,2}$/.test(rkey))
        throw new SocialError({
          code: "unauthorized",
          operation,
          message: "Repost record must belong to this Bluesky account.",
        });

      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({ repo: auth.did, collection: "app.bsky.feed.repost", rkey }),
      });
    },
    async createBookmark(input) {
      const operation = "bluesky.bookmarks.create";

      if (!POST_URI.test(input.post.uri) || !CID.test(input.post.cid))
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "Bookmarks need a post AT-URI and CID.",
          retryDisposition: { kind: "never" },
        });

      await voidProcedure(
        input.account,
        input.context,
        "app.bsky.bookmark.createBookmark",
        operation,
        {
          uri: input.post.uri,
          cid: input.post.cid,
        },
      );
    },
    async deleteBookmark(input) {
      const operation = "bluesky.bookmarks.delete";

      await voidProcedure(
        input.account,
        input.context,
        "app.bsky.bookmark.deleteBookmark",
        operation,
        {
          uri: atUri(input.uri, operation),
        },
      );
    },
    async getBookmarks(input) {
      return page(
        await pagedRead(input, "app.bsky.bookmark.getBookmarks", "bluesky.bookmarks.list"),
        "bookmarks",
      );
    },
    async getLabelerServices(input) {
      const operation = "bluesky.labelers.get";

      return listOf(
        await viewRead(input.account, input.context, "app.bsky.labeler.getServices", operation, {
          dids: identifiers(input.dids, 100, operation, "labeler DIDs"),
          detailed: input.detailed === undefined ? undefined : String(input.detailed),
        }),
        "views",
      );
    },
    async queryLabels(input) {
      const operation = "bluesky.labels.query";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const limit = input.limit ?? 50;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250)
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "queryLabels page size must be between 1 and 250.",
          retryDisposition: { kind: "never" },
        });

      const query = withParams(new URLSearchParams({ limit: String(limit) }), {
        cursor: input.cursor || undefined,
        uriPatterns: identifiers(input.uriPatterns, 100, operation, "URI patterns"),
        sources: input.sources,
      });

      return page(object(await xrpc(`com.atproto.label.queryLabels?${query}`, context)), "labels");
    },
    async getUnreadNotificationCount(input) {
      const response = await viewRead(
        input.account,
        input.context,
        "app.bsky.notification.getUnreadCount",
        "bluesky.notifications.unread",
        {
          priority: input.priority === undefined ? undefined : String(input.priority),
          seenAt: input.seenAt,
        },
      );

      const count = response["count"];

      if (!isFiniteNumber(count) || !Number.isSafeInteger(count) || count < 0)
        throw new SocialError({
          code: "upstream_failure",
          operation: "bluesky.notifications.unread",
          message: "Bluesky returned an invalid unread count.",
        });

      return count;
    },
    async getNotificationPreferences(input) {
      return object(
        (
          await viewRead(
            input.account,
            input.context,
            "app.bsky.notification.getPreferences",
            "bluesky.notifications.preferences",
            {},
          )
        )["preferences"],
      );
    },
    async putNotificationPreferences(input) {
      const preferences = input.preferences;

      const body: JsonObject = definedFields({
        chat: preferences.chat && {
          include: preferences.chat.include,
          push: preferences.chat.push,
        },
        follow: preferences.follow && { ...preferences.follow },
        like: preferences.like && { ...preferences.like },
        likeViaRepost: preferences.likeViaRepost && { ...preferences.likeViaRepost },
        mention: preferences.mention && { ...preferences.mention },
        quote: preferences.quote && { ...preferences.quote },
        reply: preferences.reply && { ...preferences.reply },
        repost: preferences.repost && { ...preferences.repost },
        repostViaRepost: preferences.repostViaRepost && { ...preferences.repostViaRepost },
        starterpackJoined: preferences.starterpackJoined && { ...preferences.starterpackJoined },
        subscribedPost: preferences.subscribedPost && { ...preferences.subscribedPost },
        unverified: preferences.unverified && { ...preferences.unverified },
        verified: preferences.verified && { ...preferences.verified },
      });

      return decodedProcedure(
        input.account,
        input.context,
        "app.bsky.notification.putPreferencesV2",
        "bluesky.notifications.preferences",
        body,
        (response) => object(response["preferences"]),
      );
    },
    async listActivitySubscriptions(input) {
      return actorPage(
        await pagedRead(
          input,
          "app.bsky.notification.listActivitySubscriptions",
          "bluesky.notifications.subscriptions",
        ),
        "subscriptions",
      );
    },
    async putActivitySubscription(input) {
      const operation = "bluesky.notifications.subscribe";

      if (!/^did:[a-z]+:[A-Za-z0-9._:%-]{1,2000}$/.test(input.subject))
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "Activity subscriptions need the subject account's DID.",
          retryDisposition: { kind: "never" },
        });

      return procedure(
        input.account,
        input.context,
        "app.bsky.notification.putActivitySubscription",
        operation,
        {
          subject: input.subject,
          activitySubscription: { post: input.post, reply: input.reply },
        },
      );
    },
    async uploadBlob(input) {
      const operation = "bluesky.uploadBlob";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const mimeType = (input.mimeType ?? input.blob.type).toLowerCase();

      if (input.blob.size === 0 || !/^[a-z0-9.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType))
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "uploadBlob needs a non-empty Blob and a type/subtype MIME type.",
          retryDisposition: { kind: "never" },
        });

      const response = object(
        await xrpc("com.atproto.repo.uploadBlob", context, {
          body: input.blob,
          headers: { "Content-Type": mimeType },
        }),
      );

      const blob = blobRef(response["blob"], operation);

      return {
        $type: "blob",
        ref: { $link: string(object(blob["ref"])["$link"]) },
        mimeType: string(blob["mimeType"]),
        size: Number(blob["size"]),
      };
    },
    async applyWrites(input) {
      const context = nativeContext(input.context, "bluesky.applyWrites");
      assertNativeAccount(input.account, context, "bluesky.applyWrites");

      return applyWritesRequest(
        input.writes,
        context,
        definedFields({ validate: input.validate, swapCommit: input.swapCommit }),
      );
    },
    async setThreadgate(input) {
      const operation = "bluesky.threadgate.set";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const allow = input.allow === null ? undefined : replyRules(input.allow);

      return upsertGate(
        "app.bsky.feed.threadgate",
        input.postUri,
        // An absent allow list keeps replies open; an empty one closes them.
        (current) => ({
          ...withoutField(current, "allow"),
          $type: "app.bsky.feed.threadgate",
          post: input.postUri,
          createdAt: optionalString(current?.["createdAt"]) ?? new Date().toISOString(),
          ...definedFields({ allow }),
        }),
        context,
      );
    },
    async setQuotesDisabled(input) {
      const operation = "bluesky.postgate.quotes";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      return upsertGate(
        "app.bsky.feed.postgate",
        input.postUri,
        (current) => ({
          ...withoutField(current, "embeddingRules"),
          $type: "app.bsky.feed.postgate",
          post: input.postUri,
          createdAt: optionalString(current?.["createdAt"]) ?? new Date().toISOString(),
          ...definedFields({
            embeddingRules: input.disabled
              ? [{ $type: "app.bsky.feed.postgate#disableRule" }]
              : undefined,
          }),
        }),
        context,
      );
    },
    async detachQuote(input) {
      const operation = "bluesky.postgate.detach";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      if (!POST_URI.test(input.quoteUri))
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "quoteUri must be the AT-URI of the post that quotes yours.",
          retryDisposition: { kind: "never" },
        });

      return upsertGate(
        "app.bsky.feed.postgate",
        input.postUri,
        (current) => {
          const previous =
            current?.["detachedEmbeddingUris"] === undefined
              ? []
              : array(current["detachedEmbeddingUris"]).map((value) => string(value));

          const detached = input.detached
            ? [...new Set([...previous, input.quoteUri])]
            : previous.filter((uri) => uri !== input.quoteUri);

          if (detached.length > 50)
            throw new SocialError({
              code: "invalid_input",
              operation,
              message: "A postgate can detach at most 50 quoting posts.",
              retryDisposition: { kind: "never" },
            });

          return {
            ...current,
            $type: "app.bsky.feed.postgate",
            post: input.postUri,
            createdAt: optionalString(current?.["createdAt"]) ?? new Date().toISOString(),
            detachedEmbeddingUris: detached,
          };
        },
        context,
      );
    },
    async createDraft(input) {
      const context = nativeContext(input.context, "bluesky.drafts.create");
      assertNativeAccount(input.account, context, "bluesky.drafts.create");

      return decodeWrite(
        await xrpc("app.bsky.draft.createDraft", context, {
          body: JSON.stringify({ draft: draftJson(input.draft) }),
        }),
        "bluesky.drafts.create",
        (response) => ({ id: string(response["id"]) }),
      );
    },
    async listDrafts(input) {
      const context = nativeContext(input.context, "bluesky.drafts.list");
      assertNativeAccount(input.account, context, "bluesky.drafts.list");

      const response = object(
        await xrpc(`app.bsky.draft.getDrafts?${pageQuery(input, "bluesky.drafts.list")}`, context),
      );

      return {
        drafts: array(response["drafts"]).map((value) => object(value)),
        ...definedFields({ cursor: optionalString(response["cursor"]) }),
      };
    },
    async updateDraft(input) {
      const context = nativeContext(input.context, "bluesky.drafts.update");
      assertNativeAccount(input.account, context, "bluesky.drafts.update");

      if (!DRAFT_ID.test(input.id)) invalidRichText("Draft IDs are TIDs.", "bluesky.drafts");

      await xrpc("app.bsky.draft.updateDraft", context, {
        body: JSON.stringify({ draft: { id: input.id, draft: draftJson(input.draft) } }),
      });
    },
    async deleteDraft(input) {
      const context = nativeContext(input.context, "bluesky.drafts.delete");
      assertNativeAccount(input.account, context, "bluesky.drafts.delete");

      if (!DRAFT_ID.test(input.id)) invalidRichText("Draft IDs are TIDs.", "bluesky.drafts");

      await xrpc("app.bsky.draft.deleteDraft", context, {
        body: JSON.stringify({ id: input.id }),
      });
    },
    async getPost(input) {
      const context = input.context ?? {
        correlationId: "bluesky-native",
        retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 },
        backendInstance: backend,
      };

      const query = new URLSearchParams({ uris: input.uri });

      const response = object(await xrpc(`app.bsky.feed.getPosts?${query.toString()}`, context));

      const posts = array(response["posts"]);

      const post = posts.find((value) => object(value)["uri"] === input.uri);

      if (post === undefined)
        throw new SocialError({
          code: "upstream_failure",
          operation: "bluesky.getPost",
          message: "Bluesky post was not found.",
        });

      return object(post);
    },
    async getPostThread(input) {
      const context = input.context ?? {
        correlationId: "bluesky-native",
        retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 },
        backendInstance: backend,
      };

      for (const [name, value] of [
        ["depth", input.depth],
        ["parentHeight", input.parentHeight],
      ] as const)
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 1000))
          throw new SocialError({
            code: "invalid_input",
            operation: "bluesky.getPostThread",
            message: `${name} must be an integer from 0 to 1000.`,
            retryDisposition: { kind: "never" },
          });

      const query = withParams(new URLSearchParams({ uri: input.uri }), {
        depth: input.depth === undefined ? undefined : String(input.depth),
        parentHeight: input.parentHeight === undefined ? undefined : String(input.parentHeight),
      });

      return object(await xrpc(`app.bsky.feed.getPostThread?${query.toString()}`, context));
    },
    async searchPosts(input) {
      const context = nativeContext(input.context, "bluesky.search.posts");
      assertNativeAccount(input.account, context, "bluesky.search.posts");

      const queryText = input.query.trim();

      if (!queryText)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.search.posts",
          message: "Bluesky search query is required.",
          retryDisposition: { kind: "never" },
        });

      const limit = input.limit ?? 50;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.search.posts",
          message: "Bluesky search page size must be between 1 and 100.",
          retryDisposition: { kind: "never" },
        });

      if (input.sort !== undefined && input.sort !== "latest" && input.sort !== "top")
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.search.posts",
          message: "Bluesky search sort must be latest or top.",
          retryDisposition: { kind: "never" },
        });

      if (input.scope === "all")
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.search.posts",
          message: "Bluesky search does not support scope 'all'.",
        });

      if (input.context !== undefined && input.context.backendInstance !== backend)
        throw new SocialError({
          code: "unauthorized",
          operation: "bluesky.search.posts",
          message: "Account reference does not belong to this Bluesky adapter.",
        });

      const query = new URLSearchParams({ q: queryText, limit: String(limit) });

      const optional = {
        cursor: input.cursor,
        sort: input.sort,
        since: input.since,
        until: input.until,
        mentions: input.mentions,
        author: input.author,
        lang: input.lang,
        domain: input.domain,
        url: input.url,
      } as const;

      for (const [key, value] of Object.entries(optional))
        if (value !== undefined && value.trim() !== "") query.set(key, value);

      for (const tag of input.tags ?? []) {
        const normalizedTag = tag.trim();

        if (normalizedTag) query.append("tag", normalizedTag);
      }

      const response = object(await xrpc(`app.bsky.feed.searchPosts?${query}`, context));

      const posts = array(response["posts"]).map((post) => object(post));

      const hitsTotal = optionalNumber(response["hitsTotal"]);

      return {
        posts,
        ...definedFields({
          cursor: optionalString(response["cursor"]),
          hitsTotal:
            hitsTotal !== undefined && Number.isSafeInteger(hitsTotal) ? hitsTotal : undefined,
        }),
      };
    },
    async likePost(input) {
      if (
        !accountMatches(input.account, auth, backend) ||
        (input.context && input.context.backendInstance !== backend)
      )
        throw new SocialError({
          code: "unauthorized",
          operation: "bluesky.reactions.like",
          message: "Account reference does not belong to this Bluesky adapter.",
        });

      if (
        !/^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/app\.bsky\.feed\.post\/[A-Za-z0-9._~:-]{1,512}$/.test(
          input.post.uri,
        ) ||
        !/^[A-Za-z0-9]{1,2048}$/.test(input.post.cid)
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.reactions.like",
          message: "Provide the native post URI and CID returned by a Bluesky read.",
        });

      const likeVia = viaRef(input.via, REPOST_URI, "bluesky.reactions.like", "a repost record");

      const context = input.context ?? {
        correlationId: "bluesky-like",
        retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 },
        backendInstance: backend,
      };

      const response = object(
        await xrpc("com.atproto.repo.createRecord", context, {
          body: JSON.stringify({
            repo: auth.did,
            collection: "app.bsky.feed.like",
            record: {
              $type: "app.bsky.feed.like",
              subject: { uri: input.post.uri, cid: input.post.cid },
              createdAt: new Date().toISOString(),
              ...definedFields({ via: likeVia }),
            },
          }),
        }),
      );

      const prefix = `at://${auth.did}/app.bsky.feed.like/`;

      const uri = response["uri"],
        cid = response["cid"];

      if (
        !isString(uri) ||
        !uri.startsWith(prefix) ||
        !/^[A-Za-z0-9._~:-]{1,512}$/.test(uri.slice(prefix.length)) ||
        !isString(cid) ||
        !cid
      )
        throw new SocialError({
          code: "ambiguous_outcome",
          operation: "bluesky.reactions.like",
          message: "Bluesky did not return an owned like record. Reconcile before retrying.",
          retryDisposition: { kind: "reconcile-first" },
        });

      return { uri, cid };
    },
    async unlikePost(input) {
      if (
        !accountMatches(input.account, auth, backend) ||
        (input.context && input.context.backendInstance !== backend)
      )
        throw new SocialError({
          code: "unauthorized",
          operation: "bluesky.reactions.unlike",
          message: "Account reference does not belong to this Bluesky adapter.",
        });

      const context = input.context ?? {
        correlationId: "bluesky-unlike",
        retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 },
        backendInstance: backend,
      };

      const prefix = `at://${auth.did}/app.bsky.feed.like/`;

      const recordKey = input.likeUri.startsWith(prefix) ? input.likeUri.slice(prefix.length) : "";

      if (!/^[A-Za-z0-9._~:-]{1,512}$/.test(recordKey) || recordKey === "." || recordKey === "..")
        throw new SocialError({
          code: "unauthorized",
          operation: "bluesky.reactions.unlike",
          message: "Like record must belong to this Bluesky account.",
        });

      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({ repo: auth.did, collection: "app.bsky.feed.like", rkey: recordKey }),
      });
    },
    async repostPost(input) {
      const context = nativeContext(input.context, "bluesky.repost");
      assertNativeAccount(input.account, context, "bluesky.repost");

      const via = viaRef(input.via, REPOST_URI, "bluesky.repost", "a repost record");

      const result = object(
        await xrpc("com.atproto.repo.createRecord", context, {
          body: JSON.stringify({
            repo: auth.did,
            collection: "app.bsky.feed.repost",
            record: {
              $type: "app.bsky.feed.repost",
              subject: input.post,
              createdAt: new Date().toISOString(),
              ...definedFields({ via }),
            },
          }),
        }),
      );

      return postRef(result);
    },
    async quotePost(input) {
      const context = nativeContext(input.context, "bluesky.quote");
      assertNativeAccount(input.account, context, "bluesky.quote");

      validatePostText(input.text, "bluesky.quote");
      const facets = linkFacets(input.text);

      const result = object(
        await xrpc("com.atproto.repo.createRecord", context, {
          body: JSON.stringify({
            repo: auth.did,
            collection: "app.bsky.feed.post",
            record: {
              $type: "app.bsky.feed.post",
              text: input.text,
              ...definedFields({
                facets: facets.length ? facets : undefined,
              }),
              createdAt: new Date().toISOString(),
              embed: { $type: "app.bsky.embed.record", record: input.post },
            },
          }),
        }),
      );

      return postRef(result);
    },
    async deletePost(input) {
      const context = nativeContext(input.context, "bluesky.delete");
      assertNativeAccount(input.account, context, "bluesky.delete");

      const prefix = `at://${auth.did}/app.bsky.feed.post/`;

      const rkey = input.post.uri.startsWith(prefix) ? input.post.uri.slice(prefix.length) : "";

      if (!rkey)
        throw new SocialError({
          code: "unauthorized",
          operation: "bluesky.delete",
          message: "Post URI does not belong to this account.",
        });

      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({ repo: auth.did, collection: "app.bsky.feed.post", rkey }),
      });
    },
    async uploadVideo(input) {
      // https://docs.bsky.app/docs/tutorials/video (recommended method)
      const context = nativeContext(input.context, "bluesky.video.upload");
      assertNativeAccount(input.account, context, "bluesky.video.upload");

      const name = input.name ?? "video.mp4";

      if (
        (input.mimeType ?? input.video.type) !== "video/mp4" ||
        input.video.size <= 0 ||
        input.video.size > MAX_VIDEO_BYTES ||
        name.length > 255 ||
        [...name].some((char) => char.charCodeAt(0) < 0x20 || char === "/" || char === "\\")
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.video.upload",
          message: `Bluesky video upload requires a non-empty video/mp4 Blob of at most ${MAX_VIDEO_BYTES} bytes and a plain file name.`,
          retryDisposition: { kind: "never" },
        });

      const token = await serviceToken(
        await pdsAudience(context),
        "com.atproto.repo.uploadBlob",
        VIDEO_UPLOAD_TOKEN_SECONDS,
        context,
      );

      const response = object(
        await videoRequest(
          "app.bsky.video.uploadVideo",
          new URLSearchParams({ did: auth.did, name }),
          context,
          { token, payload: { body: input.video, contentType: "video/mp4" }, acceptExisting: true },
        ),
      );

      try {
        // The lexicon wraps the output in `jobStatus`; the video guide reads it unwrapped.
        return videoJob(response["jobStatus"] ?? response, auth.did);
      } catch (error) {
        throw operationError("bluesky.app.bsky.video.uploadVideo", error);
      }
    },
    async getVideoJobStatus(input) {
      // https://docs.bsky.app/docs/api/app-bsky-video-get-job-status
      const context = nativeContext(input.context, "bluesky.video.job");
      assertNativeAccount(input.account, context, "bluesky.video.job");

      if (!/^[\x21-\x7e]{1,256}$/.test(input.jobId))
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.video.job",
          message: "Bluesky video job ID is malformed.",
          retryDisposition: { kind: "never" },
        });

      const response = object(
        await videoRequest(
          "app.bsky.video.getJobStatus",
          new URLSearchParams({ jobId: input.jobId }),
          context,
        ),
      );

      try {
        return videoJob(response["jobStatus"], auth.did);
      } catch (error) {
        throw operationError("bluesky.app.bsky.video.getJobStatus", error, false);
      }
    },
    async getVideoUploadLimits(input) {
      // https://docs.bsky.app/docs/api/app-bsky-video-get-upload-limits
      const context = nativeContext(input.context, "bluesky.video.limits");
      assertNativeAccount(input.account, context, "bluesky.video.limits");

      const token = await serviceToken(
        `did:web:${videoOrigin.host.replace(":", "%3A")}`,
        "app.bsky.video.getUploadLimits",
        undefined,
        context,
      );

      const response = object(
        await videoRequest("app.bsky.video.getUploadLimits", new URLSearchParams(), context, {
          token,
        }),
      );

      const canUpload = response["canUpload"];

      if (!isBoolean(canUpload))
        throw operationError(
          "bluesky.app.bsky.video.getUploadLimits",
          new HttpError("Upload limits are missing canUpload.", "invalid-response", true),
          false,
        );

      const videos = optionalNumber(response["remainingDailyVideos"]);

      const bytes = optionalNumber(response["remainingDailyBytes"]);

      const message = optionalString(response["message"]);

      const error = optionalString(response["error"]);

      return {
        canUpload,
        ...definedFields({
          remainingDailyVideos: videos,
          remainingDailyBytes: bytes,
          message,
          error,
        }),
      };
    },
    async uploadVideoMultipart(input) {
      // Flow from Bluesky's app: src/lib/media/video/multipart/upload.ts in bluesky-social/social-app.
      const operation = "bluesky.video.multipart";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const name = input.name ?? "video.mp4";

      const size = input.video.size;

      if (
        (input.mimeType ?? input.video.type) !== "video/mp4" ||
        size <= 0 ||
        size > MAX_VIDEO_BYTES ||
        !isPlainFileName(name) ||
        !hasValidHints(input)
      )
        invalidMultipartInput(operation);

      const aud = await pdsAudience(context);

      let current = await uploadToken(aud, context);

      const session = await startUploadRequest(
        {
          sizeBytes: size,
          name,
          ...definedFields({
            durationMs: input.durationMs,
            width: input.width,
            height: input.height,
          }),
        },
        current.token,
        context,
      );

      try {
        const parts = videoParts(size, session.partSizeBytes);

        if (parts.length !== session.partCount)
          throw new SocialError({
            code: "upstream_failure",
            operation,
            message: "Bluesky returned a part plan that does not match the video size.",
            retryDisposition: { kind: "never" },
          });

        for (const part of parts) {
          if (context.signal?.aborted === true)
            throw new SocialError({
              code: "cancelled",
              operation,
              message: "Bluesky multipart video upload was cancelled.",
              retryDisposition: { kind: "never" },
            });

          if (Date.now() >= current.expiresAt - VIDEO_TOKEN_REFRESH_MARGIN_MS)
            current = await uploadToken(aud, context);

          await uploadPartRequest(
            {
              jobId: session.jobId,
              partNumber: part.partNumber,
              part: input.video.slice(part.start, part.end),
            },
            current.token,
            context,
          );
        }

        // Bluesky's app mints a fresh token before finishing: the service keeps it to store the
        // processed blob on the PDS later.
        current = await uploadToken(aud, context);

        return await finishUploadRequest(session.jobId, current.token, context);
      } catch (error) {
        throw withUploadJob(operationError(operation, error), session.jobId);
      }
    },
    async startVideoUpload(input) {
      const operation = "bluesky.video.multipart.start";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      if (
        (input.mimeType !== undefined && input.mimeType !== "video/mp4") ||
        !Number.isSafeInteger(input.sizeBytes) ||
        input.sizeBytes <= 0 ||
        input.sizeBytes > MAX_VIDEO_BYTES ||
        (input.name !== undefined && !isPlainFileName(input.name)) ||
        !hasValidHints(input)
      )
        invalidMultipartInput(operation);

      const { token } = await uploadToken(await pdsAudience(context), context);

      return await startUploadRequest(
        {
          sizeBytes: input.sizeBytes,
          ...definedFields({
            name: input.name,
            durationMs: input.durationMs,
            width: input.width,
            height: input.height,
          }),
        },
        token,
        context,
      );
    },
    async uploadVideoPart(input) {
      const operation = "bluesky.video.multipart.part";
      const context = multipartContext(input, operation);

      if (
        !Number.isSafeInteger(input.partNumber) ||
        input.partNumber < 1 ||
        input.part.size <= 0 ||
        input.part.size > MAX_VIDEO_BYTES
      )
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "Bluesky video part needs a part number from 1 and a non-empty Blob.",
          retryDisposition: { kind: "never" },
        });

      const { token } = await uploadToken(await pdsAudience(context), context);

      return await uploadPartRequest(
        { jobId: input.jobId, partNumber: input.partNumber, part: input.part },
        token,
        context,
      );
    },
    async finishVideoUpload(input) {
      const context = multipartContext(input, "bluesky.video.multipart.finish");

      const { token } = await uploadToken(await pdsAudience(context), context);

      return await finishUploadRequest(input.jobId, token, context);
    },
    async getVideoUploadStatus(input) {
      const context = multipartContext(input, "bluesky.video.multipart.status");

      const { token } = await uploadToken(await pdsAudience(context), context);

      const response = await videoRequest(
        "app.bsky.video.getUploadStatus",
        new URLSearchParams({ jobId: input.jobId }),
        context,
        { token },
      );

      try {
        return uploadStatus(response, auth.did);
      } catch (error) {
        throw operationError("bluesky.app.bsky.video.getUploadStatus", error, false);
      }
    },
    async abortVideoUpload(input) {
      const context = multipartContext(input, "bluesky.video.multipart.abort");

      const { token } = await uploadToken(await pdsAudience(context), context);

      const response = await videoRequest(
        "app.bsky.video.abortUpload",
        new URLSearchParams(),
        context,
        { token, payload: jsonPayload({ jobId: input.jobId }) },
      );

      try {
        return uploadAbortResult(response);
      } catch (error) {
        throw operationError("bluesky.app.bsky.video.abortUpload", error);
      }
    },
    async follow(input) {
      const context = nativeContext(input.context, "bluesky.follow");
      assertNativeAccount(input.account, context, "bluesky.follow");

      const via = viaRef(input.via, STARTER_PACK_URI, "bluesky.follow", "a starter pack record");

      return object(
        await xrpc("com.atproto.repo.createRecord", context, {
          body: JSON.stringify({
            repo: auth.did,
            collection: "app.bsky.graph.follow",
            record: {
              $type: "app.bsky.graph.follow",
              subject: input.did,
              createdAt: new Date().toISOString(),
              ...definedFields({ via }),
            },
          }),
        }),
      );
    },
    async unfollow(input) {
      const context = nativeContext(input.context, "bluesky.unfollow");
      assertNativeAccount(input.account, context, "bluesky.unfollow");

      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.graph.follow",
          rkey: recordKey(input.followUri, "app.bsky.graph.follow"),
        }),
      });
    },
    async block(input) {
      const context = nativeContext(input.context, "bluesky.block");
      assertNativeAccount(input.account, context, "bluesky.block");

      return object(
        await xrpc("com.atproto.repo.createRecord", context, {
          body: JSON.stringify({
            repo: auth.did,
            collection: "app.bsky.graph.block",
            record: {
              $type: "app.bsky.graph.block",
              subject: input.did,
              createdAt: new Date().toISOString(),
            },
          }),
        }),
      );
    },
    async unblock(input) {
      const context = nativeContext(input.context, "bluesky.unblock");
      assertNativeAccount(input.account, context, "bluesky.unblock");

      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.graph.block",
          rkey: recordKey(input.blockUri, "app.bsky.graph.block"),
        }),
      });
    },
    async mute(input) {
      const context = nativeContext(input.context, "bluesky.mute");
      assertNativeAccount(input.account, context, "bluesky.mute");

      await xrpc("app.bsky.graph.muteActor", context, {
        body: JSON.stringify({
          actor: input.did,
          ...definedFields({
            onlyReposts: input.onlyReposts,
            onlyQuoteposts: input.onlyQuoteposts,
          }),
        }),
      });
    },
    async unmute(input) {
      const context = nativeContext(input.context, "bluesky.unmute");
      assertNativeAccount(input.account, context, "bluesky.unmute");

      await xrpc("app.bsky.graph.unmuteActor", context, {
        body: JSON.stringify({ actor: input.did }),
      });
    },
    async getFollowers(input) {
      const context = nativeContext(input.context, "bluesky.graph.followers");
      assertNativeAccount(input.account, context, "bluesky.graph.followers");

      const q = pageQuery(input);
      q.set("actor", input.actor ?? auth.did);

      if (input.sort !== undefined) q.set("sort", input.sort);

      return actorPage(
        object(await xrpc(`app.bsky.graph.getFollowers?${q}`, context)),
        "followers",
      );
    },
    async getFollows(input) {
      const context = nativeContext(input.context, "bluesky.graph.follows");
      assertNativeAccount(input.account, context, "bluesky.graph.follows");

      const q = pageQuery(input);
      q.set("actor", input.actor ?? auth.did);

      if (input.sort !== undefined) q.set("sort", input.sort);

      return actorPage(object(await xrpc(`app.bsky.graph.getFollows?${q}`, context)), "follows");
    },
    async getMutes(input) {
      const context = nativeContext(input.context, "bluesky.graph.mutes");
      assertNativeAccount(input.account, context, "bluesky.graph.mutes");

      return actorPage(
        object(await xrpc(`app.bsky.graph.getMutes?${pageQuery(input)}`, context)),
        "mutes",
      );
    },
    async getBlocks(input) {
      const context = nativeContext(input.context, "bluesky.graph.blocks");
      assertNativeAccount(input.account, context, "bluesky.graph.blocks");

      return actorPage(
        object(await xrpc(`app.bsky.graph.getBlocks?${pageQuery(input)}`, context)),
        "blocks",
      );
    },
    async getLikes(input) {
      const context = nativeContext(input.context, "bluesky.likes.read");
      assertNativeAccount(input.account, context, "bluesky.likes.read");

      const q = pageQuery(input);
      q.set("uri", input.uri);

      if (input.cid) q.set("cid", input.cid);

      const value = object(await xrpc(`app.bsky.feed.getLikes?${q}`, context));

      return {
        likes: array(value["likes"] ?? []).map((entry) => object(entry)),
        ...definedFields({ cursor: optionalString(value["cursor"]) }),
      };
    },
    async getActorLikes(input) {
      const context = nativeContext(input.context, "bluesky.likes.actor");
      assertNativeAccount(input.account, context, "bluesky.likes.actor");

      const q = pageQuery(input);
      q.set("actor", input.actor ?? auth.did);

      const value = object(await xrpc(`app.bsky.feed.getActorLikes?${q}`, context));

      return {
        feed: array(value["feed"] ?? []).map((entry) => object(entry)),
        ...definedFields({ cursor: optionalString(value["cursor"]) }),
      };
    },
    async getTimeline(input) {
      const context = nativeContext(input.context, "bluesky.feeds.timeline");
      assertNativeAccount(input.account, context, "bluesky.feeds.timeline");

      const q = pageQuery(input, "bluesky.feeds.timeline");

      if (input.algorithm?.trim()) q.set("algorithm", input.algorithm.trim());

      const value = object(await xrpc(`app.bsky.feed.getTimeline?${q}`, context));

      return feedPage(value, "bluesky.feeds.timeline");
    },
    async getFeed(input) {
      const context = nativeContext(input.context, "bluesky.feeds.feed");
      assertNativeAccount(input.account, context, "bluesky.feeds.feed");

      if (!input.feed.trim())
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.feeds.feed",
          message: "Feed generator AT-URI is required.",
        });

      const q = pageQuery(input, "bluesky.feeds.feed");

      q.set("feed", input.feed.trim());

      const value = object(await xrpc(`app.bsky.feed.getFeed?${q}`, context));

      return feedPage(value, "bluesky.feeds.feed");
    },
    async getAuthorFeed(input) {
      const context = nativeContext(input.context, "bluesky.feeds.author");
      assertNativeAccount(input.account, context, "bluesky.feeds.author");

      const q = pageQuery(input, "bluesky.feeds.author");

      q.set("actor", input.actor?.trim() || auth.did);

      if (input.filter) q.set("filter", input.filter);

      if (input.includePins !== undefined) q.set("includePins", String(input.includePins));

      const value = object(await xrpc(`app.bsky.feed.getAuthorFeed?${q}`, context));

      return feedPage(value, "bluesky.feeds.author");
    },
    async searchActors(input) {
      const context = nativeContext(input.context, "bluesky.profiles.search");
      assertNativeAccount(input.account, context, "bluesky.profiles.search");

      if (!input.query.trim())
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.profiles.search",
          message: "Actor search query is required.",
        });

      const q = pageQuery(input);
      q.set("q", input.query.trim());

      return actorPage(object(await xrpc(`app.bsky.actor.searchActors?${q}`, context)), "actors");
    },
    async searchActorsTypeahead(input) {
      const context = nativeContext(input.context, "bluesky.profiles.search");
      assertNativeAccount(input.account, context, "bluesky.profiles.search");

      if (!input.query.trim())
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.profiles.search",
          message: "Actor search query is required.",
        });

      const limit = input.limit ?? 8;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.profiles.search",
          message: "Page size must be between 1 and 100.",
        });

      const q = new URLSearchParams({ q: input.query.trim(), limit: String(limit) });

      return actorPage(
        object(await xrpc(`app.bsky.actor.searchActorsTypeahead?${q}`, context)),
        "actors",
      );
    },
    async createList(input) {
      const context = nativeContext(input.context, "bluesky.lists.create");
      assertNativeAccount(input.account, context, "bluesky.lists.create");

      const record = {
        $type: "app.bsky.graph.list",
        name: input.name,
        purpose: input.purpose,
        createdAt: new Date().toISOString(),
        ...definedFields({ description: input.description }),
      };

      return postRef(
        await xrpc("com.atproto.repo.createRecord", context, {
          body: JSON.stringify({ repo: auth.did, collection: "app.bsky.graph.list", record }),
        }),
      );
    },
    async updateList(input) {
      const context = nativeContext(input.context, "bluesky.lists.update");
      assertNativeAccount(input.account, context, "bluesky.lists.update");

      const existing = object(
        await xrpc(
          `com.atproto.repo.getRecord?repo=${encodeURIComponent(auth.did)}&collection=app.bsky.graph.list&rkey=${encodeURIComponent(recordKey(input.listUri, "app.bsky.graph.list"))}`,
          context,
        ),
      );

      const record = object(existing["value"]);

      const next = { ...record };

      next["name"] = input.name;
      next["purpose"] = input.purpose;

      // Omission preserves the description; an empty string explicitly clears it.
      if (input.description !== undefined && input.description !== record["description"]) {
        delete next["descriptionFacets"];

        if (input.description === "") delete next["description"];
        else next["description"] = input.description;
      }

      await xrpc("com.atproto.repo.putRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.graph.list",
          rkey: recordKey(input.listUri, "app.bsky.graph.list"),
          record: next,
          swapRecord: string(existing["cid"]),
        }),
      });
    },
    async deleteList(input) {
      const context = nativeContext(input.context, "bluesky.lists.delete");
      assertNativeAccount(input.account, context, "bluesky.lists.delete");

      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.graph.list",
          rkey: recordKey(input.uri, "app.bsky.graph.list"),
        }),
      });
    },
    async addListItem(input) {
      const context = nativeContext(input.context, "bluesky.lists.items.add");
      assertNativeAccount(input.account, context, "bluesky.lists.items.add");

      return postRef(
        await xrpc("com.atproto.repo.createRecord", context, {
          body: JSON.stringify({
            repo: auth.did,
            collection: "app.bsky.graph.listitem",
            record: {
              $type: "app.bsky.graph.listitem",
              list: input.listUri,
              subject: input.subject,
              createdAt: new Date().toISOString(),
            },
          }),
        }),
      );
    },
    async removeListItem(input) {
      const context = nativeContext(input.context, "bluesky.lists.items.remove");
      assertNativeAccount(input.account, context, "bluesky.lists.items.remove");

      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.graph.listitem",
          rkey: recordKey(input.uri, "app.bsky.graph.listitem"),
        }),
      });
    },
    async getList(input) {
      const context = nativeContext(input.context, "bluesky.lists.get");
      assertNativeAccount(input.account, context, "bluesky.lists.get");

      const q = pageQuery(input);
      q.set("list", input.listUri);

      return object(await xrpc(`app.bsky.graph.getList?${q}`, context));
    },
    async getLists(input) {
      const context = nativeContext(input.context, "bluesky.lists.list");
      assertNativeAccount(input.account, context, "bluesky.lists.list");

      const q = pageQuery(input);
      q.set("actor", input.actor ?? auth.did);

      return object(await xrpc(`app.bsky.graph.getLists?${q}`, context));
    },
    async muteList(input) {
      const context = nativeContext(input.context, "bluesky.lists.mute");
      assertNativeAccount(input.account, context, "bluesky.lists.mute");

      await xrpc("app.bsky.graph.muteActorList", context, {
        body: JSON.stringify({ list: input.listUri }),
      });
    },
    async unmuteList(input) {
      const context = nativeContext(input.context, "bluesky.lists.unmute");
      assertNativeAccount(input.account, context, "bluesky.lists.unmute");

      await xrpc("app.bsky.graph.unmuteActorList", context, {
        body: JSON.stringify({ list: input.listUri }),
      });
    },
    async blockList(input) {
      const context = nativeContext(input.context, "bluesky.lists.block");
      assertNativeAccount(input.account, context, "bluesky.lists.block");

      await xrpc("com.atproto.repo.createRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.graph.listblock",
          record: {
            $type: "app.bsky.graph.listblock",
            subject: input.listUri,
            createdAt: new Date().toISOString(),
          },
        }),
      });
    },
    async unblockList(input) {
      const context = nativeContext(input.context, "bluesky.lists.unblock");
      assertNativeAccount(input.account, context, "bluesky.lists.unblock");

      let cursor: string | undefined;

      let record: JsonObject | undefined;

      do {
        const query = new URLSearchParams({
          repo: auth.did,
          collection: "app.bsky.graph.listblock",
          limit: "100",
          ...definedFields({ cursor }),
        });

        const records = object(
          await xrpc(`com.atproto.repo.listRecords?${query.toString()}`, context),
        );

        record = array(records["records"])
          .map((value) => object(value))
          .find((value) => object(value["value"])["subject"] === input.listUri);
        cursor = optionalString(records["cursor"]);
      } while (record === undefined && cursor !== undefined);

      if (record === undefined)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.lists.unblock",
          message: "No list block record was found for this list.",
        });

      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.graph.listblock",
          rkey: recordKey(string(record["uri"]), "app.bsky.graph.listblock"),
        }),
      });
    },
    async createModerationReport(input) {
      const context = nativeContext(input.context, "bluesky.moderation.report");
      assertNativeAccount(input.account, context, "bluesky.moderation.report");

      if (input.modTool !== undefined && !input.modTool.name.trim())
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.moderation.report",
          message: "modTool.name must name the reporting tool.",
          retryDisposition: { kind: "never" },
        });

      const body = {
        reasonType: input.reasonType,
        subject: input.subject,
        ...definedFields({
          reason: input.reason,
          modTool:
            input.modTool === undefined
              ? undefined
              : {
                  name: input.modTool.name.trim(),
                  ...definedFields({ meta: input.modTool.meta }),
                },
        }),
      };

      return object(
        await xrpc("com.atproto.moderation.createReport", context, { body: JSON.stringify(body) }),
      );
    },
    async listNotifications(input) {
      const context = nativeContext(input.context, "bluesky.notifications.list");
      assertNativeAccount(input.account, context, "bluesky.notifications.list");

      const limit = input.limit ?? 50;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.notifications.list",
          message: "Page size must be between 1 and 100.",
        });

      const query = withParams(new URLSearchParams({ limit: String(limit) }), {
        cursor: input.cursor || undefined,
        reasons: input.reasons,
        priority: input.priority === undefined ? undefined : String(input.priority),
        seenAt: input.seenAt,
      });

      return object(await xrpc(`app.bsky.notification.listNotifications?${query}`, context));
    },
    async markNotificationsSeen(input) {
      const context = nativeContext(input.context, "bluesky.notifications.seen");
      assertNativeAccount(input.account, context, "bluesky.notifications.seen");

      await xrpc("app.bsky.notification.updateSeen", context, {
        body: JSON.stringify({ seenAt: input.seenAt ?? new Date().toISOString() }),
      });
    },
    async getProfile(input) {
      const context = nativeContext(input.context, "bluesky.profile.get");
      assertNativeAccount(input.account, context, "bluesky.profile.get");

      return object(
        await xrpc(
          `app.bsky.actor.getProfile?actor=${encodeURIComponent(input.actor ?? auth.did)}`,
          context,
        ),
      );
    },
    async updateProfile(input) {
      const context = nativeContext(input.context, "bluesky.profile.update");
      assertNativeAccount(input.account, context, "bluesky.profile.update");

      if (input.profile["$type"] !== "app.bsky.actor.profile")
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.profile.update",
          message: "The profile record needs $type app.bsky.actor.profile.",
          retryDisposition: { kind: "never" },
        });

      await xrpc("com.atproto.repo.putRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.actor.profile",
          rkey: "self",
          record: input.profile,
          ...definedFields({ swapRecord: input.swapRecord }),
        }),
      });
    },
    async editProfile(input) {
      const operation = "bluesky.profile.edit";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const changes = profileChanges(input.changes, operation);

      return upsertOwnRecord(
        "app.bsky.actor.profile",
        "self",
        (current) => {
          const kept = Object.fromEntries(
            Object.entries(current ?? {}).filter(([key]) => !(key in changes)),
          );

          const set = Object.fromEntries(
            Object.entries(changes).flatMap(([key, value]) =>
              value === null ? [] : [[key, value]],
            ),
          );

          return { ...kept, ...set, $type: "app.bsky.actor.profile" };
        },
        context,
      );
    },
    async pinPost(input) {
      if (input.post !== null) recordKey(input.post.uri, "app.bsky.feed.post");

      return native.editProfile({
        account: input.account,
        changes: { pinnedPost: input.post },
        ...definedFields({ context: input.context }),
      });
    },
    async setLiveStatus(input) {
      const operation = "bluesky.status.live";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      if (
        !/^https:\/\/[^\s]+$/i.test(input.url) ||
        !Number.isSafeInteger(input.durationMinutes) ||
        input.durationMinutes < 1 ||
        (input.thumb !== undefined &&
          !blobRefFits(
            input.thumb,
            (mimeType, size) => mimeType.startsWith("image/") && size <= MAX_LINK_THUMB_BYTES,
          ))
      )
        throw new SocialError({
          code: "invalid_input",
          operation,
          message:
            "A live status needs an https stream URL, durationMinutes of at least 1, and an optional image thumb of at most 1,000,000 bytes.",
          retryDisposition: { kind: "never" },
        });

      return writtenRef(
        await xrpc("com.atproto.repo.putRecord", context, {
          body: JSON.stringify({
            repo: auth.did,
            collection: "app.bsky.actor.status",
            rkey: "self",
            record: {
              $type: "app.bsky.actor.status",
              status: "app.bsky.actor.status#live",
              embed: {
                $type: "app.bsky.embed.external",
                external: {
                  uri: input.url,
                  title: input.title ?? "",
                  description: input.description ?? "",
                  ...definedFields({
                    thumb: input.thumb === undefined ? undefined : blobJson(input.thumb),
                  }),
                },
              },
              durationMinutes: input.durationMinutes,
              createdAt: new Date().toISOString(),
            },
          }),
        }),
        operation,
      );
    },
    async clearLiveStatus(input) {
      const operation = "bluesky.status.clear";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      await xrpc("com.atproto.repo.deleteRecord", context, {
        body: JSON.stringify({ repo: auth.did, collection: "app.bsky.actor.status", rkey: "self" }),
      });
    },
    async getNotificationDeclaration(input) {
      const operation = "bluesky.notifications.declaration.get";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const found = await readRecord(
        input.actor ?? auth.did,
        "app.bsky.notification.declaration",
        "self",
        context,
      );

      return found === undefined
        ? undefined
        : { allowSubscriptions: string(found["allowSubscriptions"]) };
    },
    async setNotificationDeclaration(input) {
      const operation = "bluesky.notifications.declaration.set";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      if (!["followers", "mutuals", "none"].includes(input.allowSubscriptions))
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "allowSubscriptions must be followers, mutuals, or none.",
          retryDisposition: { kind: "never" },
        });

      return putSelfRecord(
        "app.bsky.notification.declaration",
        {
          $type: "app.bsky.notification.declaration",
          allowSubscriptions: input.allowSubscriptions,
        },
        context,
      );
    },
    async getChatDeclaration(input) {
      const operation = "bluesky.chat.declaration.get";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const found = await readRecord(
        input.actor ?? auth.did,
        "chat.bsky.actor.declaration",
        "self",
        context,
      );

      return found === undefined
        ? undefined
        : {
            allowIncoming: string(found["allowIncoming"]),
            ...definedFields({ allowGroupInvites: optionalString(found["allowGroupInvites"]) }),
          };
    },
    async setChatDeclaration(input) {
      const operation = "bluesky.chat.declaration.set";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const audiences = ["all", "following", "none"];

      if (
        !audiences.includes(input.allowIncoming) ||
        (input.allowGroupInvites !== undefined && !audiences.includes(input.allowGroupInvites))
      )
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "allowIncoming and allowGroupInvites must be all, following, or none.",
          retryDisposition: { kind: "never" },
        });

      return putSelfRecord(
        "chat.bsky.actor.declaration",
        {
          $type: "chat.bsky.actor.declaration",
          allowIncoming: input.allowIncoming,
          ...definedFields({ allowGroupInvites: input.allowGroupInvites }),
        },
        context,
      );
    },
    async getChatStatus(input) {
      const status = await viewRead(
        input.account,
        input.context,
        "chat.bsky.actor.getStatus",
        "bluesky.chat.status",
        {},
      );

      const chatDisabled = status["chatDisabled"],
        canCreateGroups = status["canCreateGroups"],
        groupMemberLimit = status["groupMemberLimit"];

      if (
        !isBoolean(chatDisabled) ||
        !isBoolean(canCreateGroups) ||
        !isFiniteNumber(groupMemberLimit)
      )
        throw new SocialError({
          code: "upstream_failure",
          operation: "bluesky.chat.status",
          message: "Bluesky returned an invalid chat status.",
        });

      return { chatDisabled, canCreateGroups, groupMemberLimit };
    },
    async getContentVisibility(input) {
      const operation = "bluesky.profile.contentVisibility.get";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const found = await readRecord(
        input.actor ?? auth.did,
        "app.bsky.actor.contentVisibilityDeclaration",
        "self",
        context,
      );

      return {
        hideFromAlgorithmicRecommendations: found?.["hideFromAlgorithmicRecommendations"] === true,
      };
    },
    async setContentVisibility(input) {
      const operation = "bluesky.profile.contentVisibility.set";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      return putSelfRecord(
        "app.bsky.actor.contentVisibilityDeclaration",
        {
          $type: "app.bsky.actor.contentVisibilityDeclaration",
          hideFromAlgorithmicRecommendations: input.hideFromAlgorithmicRecommendations,
        },
        context,
      );
    },
    async optOutOfReferenceList(input) {
      const operation = "bluesky.referenceLists.optOut";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      if (!LIST_RECORD_URI.test(input.listUri))
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "listUri must be a DID-based app.bsky.graph.list AT-URI.",
          retryDisposition: { kind: "never" },
        });

      return createOwnRecord(
        "app.bsky.graph.referencelistoptout",
        {
          $type: "app.bsky.graph.referencelistoptout",
          subject: input.listUri,
          createdAt: new Date().toISOString(),
        },
        context,
      );
    },
    async deleteReferenceListOptOut(input) {
      await deleteOwnRecord(
        input,
        "app.bsky.graph.referencelistoptout",
        "bluesky.referenceLists.optIn",
      );
    },
    async createProfileLink(input) {
      const operation = "bluesky.profile.links.create";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      if (
        !/^https:\/\/[^\s]+$/i.test(input.url) ||
        (input.title !== undefined &&
          (graphemeCount(input.title) > 40 ||
            new TextEncoder().encode(input.title).byteLength > 320)) ||
        (input.icon !== undefined &&
          !blobRefFits(
            input.icon,
            (mimeType, size) =>
              ["image/png", "image/jpeg", "image/webp"].includes(mimeType) && size <= 100_000,
          ))
      )
        throw new SocialError({
          code: "invalid_input",
          operation,
          message:
            "A profile link needs an https URL, a title of at most 40 graphemes, and an optional PNG, JPEG, or WebP icon of at most 100,000 bytes.",
          retryDisposition: { kind: "never" },
        });

      return createOwnRecord(
        "app.bsky.actor.link",
        {
          $type: "app.bsky.actor.link",
          url: input.url,
          ...definedFields({
            title: input.title,
            icon: input.icon === undefined ? undefined : blobJson(input.icon),
          }),
          createdAt: new Date().toISOString(),
        },
        context,
      );
    },
    async deleteProfileLink(input) {
      await deleteOwnRecord(input, "app.bsky.actor.link", "bluesky.profile.links.delete");
    },
    async putFeedGenerator(input) {
      const operation = "bluesky.feeds.generator.put";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const description = input.description;

      if (
        !RKEY.test(input.rkey) ||
        input.rkey === "." ||
        input.rkey === ".." ||
        !DID.test(input.did) ||
        !input.displayName.trim() ||
        graphemeCount(input.displayName) > 24 ||
        new TextEncoder().encode(input.displayName).byteLength > 240 ||
        (description !== undefined &&
          (graphemeCount(description) > 300 ||
            new TextEncoder().encode(description).byteLength > 3000)) ||
        (input.avatar !== undefined &&
          !blobRefFits(
            input.avatar,
            (mimeType, size) =>
              (mimeType === "image/png" || mimeType === "image/jpeg") && size <= 1_000_000,
          ))
      )
        throw new SocialError({
          code: "invalid_input",
          operation,
          message:
            "A feed generator needs a record key, a service DID, a displayName of 1 to 24 graphemes, a description of at most 300, and an optional PNG or JPEG avatar of at most 1,000,000 bytes.",
          retryDisposition: { kind: "never" },
        });

      const facets = description === undefined ? [] : richTextFacets(description, []);

      return writtenRef(
        await xrpc("com.atproto.repo.putRecord", context, {
          body: JSON.stringify({
            repo: auth.did,
            collection: "app.bsky.feed.generator",
            rkey: input.rkey,
            record: {
              $type: "app.bsky.feed.generator",
              did: input.did,
              displayName: input.displayName,
              ...definedFields({
                description,
                descriptionFacets: facets.length ? facets : undefined,
                avatar: input.avatar === undefined ? undefined : blobJson(input.avatar),
                acceptsInteractions: input.acceptsInteractions,
                contentMode: input.contentMode,
              }),
              createdAt: new Date().toISOString(),
            },
          }),
        }),
        operation,
      );
    },
    async deleteFeedGenerator(input) {
      await deleteOwnRecord(input, "app.bsky.feed.generator", "bluesky.feeds.generator.delete");
    },
    async putLabelerService(input) {
      const operation = "bluesky.labeler.service.put";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const definitions = input.policies.labelValueDefinitions ?? [];

      const invalidDefinition = definitions.some(
        (definition) =>
          !LABEL_IDENTIFIER.test(definition.identifier) ||
          !["inform", "alert", "none"].includes(definition.severity) ||
          !["content", "media", "none"].includes(definition.blurs) ||
          (definition.defaultSetting !== undefined &&
            !["ignore", "warn", "hide"].includes(definition.defaultSetting)) ||
          definition.locales.length === 0 ||
          definition.locales.some(
            (locale) =>
              !locale.lang.trim() ||
              !locale.name.trim() ||
              graphemeCount(locale.name) > 64 ||
              graphemeCount(locale.description) > 10_000,
          ),
      );

      if (
        input.policies.labelValues.length === 0 ||
        input.policies.labelValues.some((value) => !value || value.length > 128) ||
        invalidDefinition ||
        (input.subjectCollections ?? []).some((collection) => !NSID.test(collection))
      )
        throw new SocialError({
          code: "invalid_input",
          operation,
          message:
            "A labeler declaration needs label values, valid label definitions (lowercase identifier, severity, blurs, and at least one locale), and NSID subject collections.",
          retryDisposition: { kind: "never" },
        });

      return putSelfRecord(
        "app.bsky.labeler.service",
        {
          $type: "app.bsky.labeler.service",
          policies: {
            labelValues: [...input.policies.labelValues],
            ...definedFields({
              labelValueDefinitions:
                input.policies.labelValueDefinitions === undefined
                  ? undefined
                  : definitions.map((definition) => ({
                      identifier: definition.identifier,
                      severity: definition.severity,
                      blurs: definition.blurs,
                      ...definedFields({
                        defaultSetting: definition.defaultSetting,
                        adultOnly: definition.adultOnly,
                      }),
                      locales: definition.locales.map((locale) => ({
                        lang: locale.lang,
                        name: locale.name,
                        description: locale.description,
                      })),
                    })),
            }),
          },
          ...definedFields({
            reasonTypes: input.reasonTypes === undefined ? undefined : [...input.reasonTypes],
            subjectTypes: input.subjectTypes === undefined ? undefined : [...input.subjectTypes],
            subjectCollections:
              input.subjectCollections === undefined ? undefined : [...input.subjectCollections],
          }),
          createdAt: new Date().toISOString(),
        },
        context,
      );
    },
    async getPreferences(input) {
      return listOf(
        await viewRead(
          input.account,
          input.context,
          "app.bsky.actor.getPreferences",
          "bluesky.preferences.get",
          {},
        ),
        "preferences",
      );
    },
    async putPreferences(input) {
      const operation = "bluesky.preferences.put";

      if (
        input.preferences.some((preference) => {
          const type = preference["$type"];

          return !isString(type) || !type.startsWith("app.bsky.actor.defs#");
        })
      )
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "Each preference needs an app.bsky.actor.defs# $type.",
          retryDisposition: { kind: "never" },
        });

      await voidProcedure(
        input.account,
        input.context,
        "app.bsky.actor.putPreferences",
        operation,
        {
          preferences: [...input.preferences],
        },
      );
    },
    async listFeeds(input) {
      const context = nativeContext(input.context, "bluesky.feeds.list");
      assertNativeAccount(input.account, context, "bluesky.feeds.list");

      const limit = input.limit ?? 50;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.feeds.list",
          message: "Page size must be between 1 and 100.",
        });

      const query = new URLSearchParams({
        limit: String(limit),
        ...definedFields({ cursor: input.cursor || undefined }),
      });

      return object(await xrpc(`app.bsky.feed.getSuggestedFeeds?${query}`, context));
    },
    async listConversations(input) {
      const context = nativeContext(input.context, "bluesky.chat.list");
      assertNativeAccount(input.account, context, "bluesky.chat.list");

      const limit = input.limit ?? 50;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.chat.list",
          message: "Page size must be between 1 and 100.",
        });

      const query = withParams(new URLSearchParams({ limit: String(limit) }), {
        cursor: input.cursor || undefined,
        kind: input.kind,
        status: input.status,
        readState: input.unreadOnly === true ? "unread" : undefined,
        lockStatus: input.lockStatus,
      });

      return object(await xrpc(`chat.bsky.convo.listConvos?${query}`, context));
    },
    async listMessages(input) {
      const context = nativeContext(input.context, "bluesky.chat.messages");
      assertNativeAccount(input.account, context, "bluesky.chat.messages");

      const limit = input.limit ?? 50;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new SocialError({
          code: "invalid_input",
          operation: "bluesky.chat.messages",
          message: "Page size must be between 1 and 100.",
        });

      const query = new URLSearchParams({
        limit: String(limit),
        ...definedFields({ cursor: input.cursor || undefined }),
      });

      return object(
        await xrpc(
          `chat.bsky.convo.getMessages?convoId=${encodeURIComponent(input.conversationId)}&${query}`,
          context,
        ),
      );
    },
    async sendMessage(input) {
      const context = nativeContext(input.context, "bluesky.chat.send");
      assertNativeAccount(input.account, context, "bluesky.chat.send");

      return object(
        await xrpc("chat.bsky.convo.sendMessage", context, {
          body: JSON.stringify({
            convoId: convoId(input.conversationId, "bluesky.chat.send"),
            message: messageJson(input),
          }),
        }),
      );
    },
    async sendMessageBatch(input) {
      const operation = "bluesky.chat.sendBatch";

      if (input.items.length === 0 || input.items.length > 100)
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "sendMessageBatch takes 1 to 100 messages.",
          retryDisposition: { kind: "never" },
        });

      const items = input.items.map((item) => ({
        convoId: convoId(item.conversationId, operation),
        message: messageJson(item),
      }));

      // The lexicon requires `items`; a reply without it is not a confirmation.
      return decodedProcedure(
        input.account,
        input.context,
        "chat.bsky.convo.sendMessageBatch",
        operation,
        { items },
        (response) => array(response["items"]).map((value) => object(value)),
      );
    },
    async getConvoForMembers(input) {
      const operation = "bluesky.chat.start";

      return object(
        (
          await viewRead(
            input.account,
            input.context,
            "chat.bsky.convo.getConvoForMembers",
            operation,
            {
              members: memberDids(input.members, 10, operation),
            },
          )
        )["convo"],
      );
    },
    async getConvoAvailability(input) {
      const operation = "bluesky.chat.availability";

      const response = await viewRead(
        input.account,
        input.context,
        "chat.bsky.convo.getConvoAvailability",
        operation,
        { members: memberDids(input.members, 10, operation) },
      );

      const canChat = response["canChat"];

      if (!isBoolean(canChat))
        throw new SocialError({
          code: "upstream_failure",
          operation,
          message: "Bluesky chat availability is missing canChat.",
        });

      return {
        canChat,
        ...definedFields({
          convo: response["convo"] === undefined ? undefined : object(response["convo"]),
        }),
      };
    },
    async getConversation(input) {
      const operation = "bluesky.chat.get";

      return object(
        (
          await viewRead(input.account, input.context, "chat.bsky.convo.getConvo", operation, {
            convoId: convoId(input.conversationId, operation),
          })
        )["convo"],
      );
    },
    async listConvoRequests(input) {
      return page(
        await pagedRead(input, "chat.bsky.convo.listConvoRequests", "bluesky.chat.requests"),
        "requests",
      );
    },
    async acceptConvo(input) {
      const operation = "bluesky.chat.accept";

      const response = await procedure(
        input.account,
        input.context,
        "chat.bsky.convo.acceptConvo",
        operation,
        { convoId: convoId(input.conversationId, operation) },
      );

      return definedFields({ rev: optionalString(response["rev"]) });
    },
    async addReaction(input) {
      return reaction("chat.bsky.convo.addReaction", input);
    },
    async removeReaction(input) {
      return reaction("chat.bsky.convo.removeReaction", input);
    },
    async markConversationRead(input) {
      const operation = "bluesky.chat.read";

      return decodedProcedure(
        input.account,
        input.context,
        "chat.bsky.convo.updateRead",
        operation,
        {
          convoId: convoId(input.conversationId, operation),
          ...definedFields({ messageId: input.messageId }),
        },
        (response) => object(response["convo"]),
      );
    },
    async markAllConversationsRead(input) {
      const operation = "bluesky.chat.readAll";

      return decodedProcedure(
        input.account,
        input.context,
        "chat.bsky.convo.updateAllRead",
        operation,
        definedFields({ status: input.status }),
        (response) => number(response["updatedCount"]),
      );
    },
    async muteConversation(input) {
      return convoAction("chat.bsky.convo.muteConvo", "bluesky.chat.mute", input);
    },
    async unmuteConversation(input) {
      return convoAction("chat.bsky.convo.unmuteConvo", "bluesky.chat.unmute", input);
    },
    async leaveConversation(input) {
      const operation = "bluesky.chat.leave";

      return decodedProcedure(
        input.account,
        input.context,
        "chat.bsky.convo.leaveConvo",
        operation,
        { convoId: convoId(input.conversationId, operation) },
        (response) => ({ rev: string(response["rev"]) }),
      );
    },
    async deleteMessageForSelf(input) {
      const operation = "bluesky.chat.deleteForSelf";

      return procedure(
        input.account,
        input.context,
        "chat.bsky.convo.deleteMessageForSelf",
        operation,
        {
          convoId: convoId(input.conversationId, operation),
          messageId: convoId(input.messageId, operation),
        },
      );
    },
    async getChatLog(input) {
      const response = await viewRead(
        input.account,
        input.context,
        "chat.bsky.convo.getLog",
        "bluesky.chat.log",
        { cursor: input.cursor || undefined },
      );

      return {
        logs: listOf(response, "logs"),
        ...definedFields({ cursor: optionalString(response["cursor"]) }),
      };
    },
    async createGroupChat(input) {
      const operation = "bluesky.chat.groups.create";

      return decodedProcedure(
        input.account,
        input.context,
        "chat.bsky.group.createGroup",
        operation,
        {
          name: groupName(input.name, operation),
          members: memberDids(input.members, 49, operation),
        },
        (response) => object(response["convo"]),
      );
    },
    async renameGroupChat(input) {
      const operation = "bluesky.chat.groups.edit";

      return decodedProcedure(
        input.account,
        input.context,
        "chat.bsky.group.editGroup",
        operation,
        {
          convoId: convoId(input.conversationId, operation),
          name: groupName(input.name, operation),
        },
        (response) => object(response["convo"]),
      );
    },
    async addGroupChatMembers(input) {
      return groupMembers("chat.bsky.group.addMembers", "bluesky.chat.groups.add", input);
    },
    async removeGroupChatMembers(input) {
      return groupMembers("chat.bsky.group.removeMembers", "bluesky.chat.groups.remove", input);
    },
    async exportChatAccountData(input) {
      const operation = "bluesky.chat.export";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const text = await xrpcText("chat.bsky.actor.exportAccountData", context, 50_000_000);

      try {
        return text
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => object(parseJson(line)));
      } catch {
        throw new SocialError({
          code: "upstream_failure",
          operation,
          message: "Bluesky returned chat export lines that are not JSON objects.",
        });
      }
    },
    async deleteChatAccount(input) {
      const operation = "bluesky.chat.deleteAccount";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      await xrpc("chat.bsky.actor.deleteAccount", context, { method: "POST" });
    },
    async getChatNotificationPreferences(input) {
      return chatPreferences(
        await viewRead(
          input.account,
          input.context,
          "chat.bsky.notification.getPreferences",
          "bluesky.chat.notifications.get",
          {},
        ),
        "bluesky.chat.notifications.get",
      );
    },
    async putChatNotificationPreferences(input) {
      const operation = "bluesky.chat.notifications.put";

      const encode = (
        value: BlueskyChatNotificationPreference | undefined,
      ): JsonObject | undefined => {
        if (value === undefined) return undefined;

        if ((value.include !== "all" && value.include !== "follows") || !isFlag(value.push))
          throw new SocialError({
            code: "invalid_input",
            operation,
            message: "Chat notification include must be all or follows, and push a boolean.",
            retryDisposition: { kind: "never" },
          });

        return { include: value.include, push: value.push };
      };

      const body = definedFields({
        chat: encode(input.chat),
        chatRequest: encode(input.chatRequest),
      });

      if (Object.keys(body).length === 0)
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "Provide chat, chatRequest, or both.",
          retryDisposition: { kind: "never" },
        });

      return decodedProcedure(
        input.account,
        input.context,
        "chat.bsky.notification.putPreferences",
        operation,
        body,
        (response) => chatPreferences(response, operation),
      );
    },
    async getUnreadConversationCounts(input) {
      const counts = await viewRead(
        input.account,
        input.context,
        "chat.bsky.convo.getUnreadCounts",
        "bluesky.chat.unreadCounts",
        {
          includeGroupChats:
            input.includeGroupChats === undefined ? undefined : String(input.includeGroupChats),
        },
      );

      const accepted = counts["unreadAcceptedConvos"],
        requests = counts["unreadRequestConvos"];

      if (!isFiniteNumber(accepted) || !isFiniteNumber(requests))
        throw new SocialError({
          code: "upstream_failure",
          operation: "bluesky.chat.unreadCounts",
          message: "Bluesky returned invalid unread conversation counts.",
        });

      return { unreadAcceptedConvos: accepted, unreadRequestConvos: requests };
    },
    async lockGroupChat(input) {
      return convoProcedure("chat.bsky.convo.lockConvo", "bluesky.chat.groups.lock", input);
    },
    async unlockGroupChat(input) {
      return convoProcedure("chat.bsky.convo.unlockConvo", "bluesky.chat.groups.unlock", input);
    },
    async getConvoMembers(input) {
      const operation = "bluesky.chat.members";

      return actorPage(
        await pagedRead(input, "chat.bsky.convo.getConvoMembers", operation, {
          convoId: convoId(input.conversationId, operation),
        }),
        "members",
      );
    },
    async listMutualGroups(input) {
      const operation = "bluesky.chat.groups.mutual";

      if (!DID.test(input.subject))
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "subject must be a DID.",
          retryDisposition: { kind: "never" },
        });

      return page(
        await pagedRead(input, "chat.bsky.group.listMutualGroups", operation, {
          subject: input.subject,
        }),
        "convos",
      );
    },
    async createJoinLink(input) {
      const operation = "bluesky.chat.joinLinks.create";

      return decodedProcedure(
        input.account,
        input.context,
        "chat.bsky.group.createJoinLink",
        operation,
        {
          convoId: convoId(input.conversationId, operation),
          joinRule: joinRule(input.joinRule, operation),
          ...definedFields({ requireApproval: input.requireApproval }),
        },
        joinLink,
      );
    },
    async editJoinLink(input) {
      const operation = "bluesky.chat.joinLinks.edit";

      if (input.joinRule === undefined && input.requireApproval === undefined)
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "Provide joinRule, requireApproval, or both.",
          retryDisposition: { kind: "never" },
        });

      return decodedProcedure(
        input.account,
        input.context,
        "chat.bsky.group.editJoinLink",
        operation,
        {
          convoId: convoId(input.conversationId, operation),
          ...definedFields({
            joinRule:
              input.joinRule === undefined ? undefined : joinRule(input.joinRule, operation),
            requireApproval: input.requireApproval,
          }),
        },
        joinLink,
      );
    },
    async enableJoinLink(input) {
      const operation = "bluesky.chat.joinLinks.enable";

      return decodedProcedure(
        input.account,
        input.context,
        "chat.bsky.group.enableJoinLink",
        operation,
        {
          convoId: convoId(input.conversationId, operation),
        },
        joinLink,
      );
    },
    async disableJoinLink(input) {
      const operation = "bluesky.chat.joinLinks.disable";

      return decodedProcedure(
        input.account,
        input.context,
        "chat.bsky.group.disableJoinLink",
        operation,
        {
          convoId: convoId(input.conversationId, operation),
        },
        joinLink,
      );
    },
    async getJoinLinkPreviews(input) {
      const operation = "bluesky.chat.joinLinks.preview";

      return listOf(
        await viewRead(
          input.account,
          input.context,
          "chat.bsky.group.getJoinLinkPreviews",
          operation,
          {
            codes: identifiers(input.codes, 50, operation, "join link codes"),
          },
        ),
        "joinLinkPreviews",
      );
    },
    async requestJoinGroupChat(input) {
      const operation = "bluesky.chat.joinLinks.join";

      return decodedProcedure(
        input.account,
        input.context,
        "chat.bsky.group.requestJoin",
        operation,
        { code: convoId(input.code, operation) },
        (result) => ({
          status: string(result["status"]),
          ...definedFields({ convo: optionalObject(result["convo"]) }),
        }),
      );
    },
    async withdrawJoinRequest(input) {
      const operation = "bluesky.chat.joinRequests.withdraw";

      await voidProcedure(
        input.account,
        input.context,
        "chat.bsky.group.withdrawJoinRequest",
        operation,
        {
          convoId: convoId(input.conversationId, operation),
        },
      );
    },
    async listJoinRequests(input) {
      const operation = "bluesky.chat.joinRequests.list";

      return page(
        await pagedRead(input, "chat.bsky.group.listJoinRequests", operation, {
          convoId: convoId(input.conversationId, operation),
        }),
        "requests",
      );
    },
    async approveJoinRequest(input) {
      const operation = "bluesky.chat.joinRequests.approve";

      return decodedProcedure(
        input.account,
        input.context,
        "chat.bsky.group.approveJoinRequest",
        operation,
        {
          convoId: convoId(input.conversationId, operation),
          member: memberDid(input.member, operation),
        },
        (response) => object(response["convo"]),
      );
    },
    async rejectJoinRequest(input) {
      const operation = "bluesky.chat.joinRequests.reject";

      await voidProcedure(
        input.account,
        input.context,
        "chat.bsky.group.rejectJoinRequest",
        operation,
        {
          convoId: convoId(input.conversationId, operation),
          member: memberDid(input.member, operation),
        },
      );
    },
    async markJoinRequestsRead(input) {
      const operation = "bluesky.chat.joinRequests.read";

      await voidProcedure(
        input.account,
        input.context,
        "chat.bsky.group.updateJoinRequestsRead",
        operation,
        { convoId: convoId(input.conversationId, operation) },
      );
    },
    async searchPostsV2(input) {
      const operation = "bluesky.search.postsV2";

      const query = input.query?.trim();

      const filters = {
        authors: input.authors,
        excludeAuthors: input.excludeAuthors,
        mentions: input.mentions,
        excludeMentions: input.excludeMentions,
        domains: input.domains,
        excludeDomains: input.excludeDomains,
        urls: input.urls,
        excludeUrls: input.excludeUrls,
        embeddedAtUris: input.embeddedAtUris,
        excludeEmbeddedAtUris: input.excludeEmbeddedAtUris,
        hashtags: input.hashtags?.map((tag) => tag.replace(/^#/, "")),
        excludeHashtags: input.excludeHashtags?.map((tag) => tag.replace(/^#/, "")),
        languages: input.languages,
        excludeLanguages: input.excludeLanguages,
      } satisfies QueryParams;

      if (
        Object.values(filters).some((list) => list?.some((item) => !item.trim())) ||
        [...(filters.hashtags ?? []), ...(filters.excludeHashtags ?? [])].some(
          (tag) => graphemeCount(tag) > 64,
        ) ||
        (input.sort !== undefined && input.sort !== "recent" && input.sort !== "top") ||
        (input.repliesOnly === true && input.excludeReplies === true)
      )
        throw new SocialError({
          code: "invalid_input",
          operation,
          message:
            "Search filters need non-empty values, hashtags of at most 64 graphemes, sort recent or top, and not both repliesOnly and excludeReplies.",
          retryDisposition: { kind: "never" },
        });

      const flag = (value: boolean | undefined) =>
        value === undefined ? undefined : String(value);

      const response = await pagedRead(input, "app.bsky.feed.searchPostsV2", operation, {
        ...filters,
        query: query || undefined,
        sort: input.sort,
        since: input.since,
        until: input.until,
        allTime: flag(input.allTime),
        hasMedia: flag(input.hasMedia),
        hasVideo: flag(input.hasVideo),
        replyParentUri:
          input.replyParentUri === undefined ? undefined : atUri(input.replyParentUri, operation),
        threadRootUri:
          input.threadRootUri === undefined ? undefined : atUri(input.threadRootUri, operation),
        excludeReplies: flag(input.excludeReplies),
        repliesOnly: flag(input.repliesOnly),
        following: flag(input.following),
        queryLanguage: input.queryLanguage,
      });

      const hitsTotal = optionalNumber(response["hitsTotal"]);

      const languages = response["detectedQueryLanguages"];

      return {
        posts: array(response["posts"]).map((post) => object(post)),
        ...definedFields({
          cursor: optionalString(response["cursor"]),
          hitsTotal:
            hitsTotal !== undefined && Number.isSafeInteger(hitsTotal) ? hitsTotal : undefined,
          detectedQueryLanguages:
            languages === undefined ? undefined : array(languages).map((value) => string(value)),
        }),
      };
    },
    async getGroupedNotifications(input) {
      const operation = "bluesky.notifications.grouped";

      const response = await viewRead(
        input.account,
        input.context,
        "app.bsky.notification.getGroupedNotifications",
        operation,
        {
          feed: input.feed,
          limit: limitParam(input.limit, 50, operation),
          cursor: input.cursor || undefined,
        },
      );

      array(response["groups"]);

      return response;
    },
    async getStarterPacksWithMembership(input) {
      const operation = "bluesky.starterPacks.membership";

      return page(
        await pagedRead(input, "app.bsky.graph.getStarterPacksWithMembership", operation, {
          actor: identifiers([input.actor], 1, operation, "actor")[0],
        }),
        "starterPacksWithMembership",
      );
    },
    async searchStarterPacksV2(input) {
      const operation = "bluesky.starterPacks.searchV2";

      const response = await pagedRead(input, "app.bsky.graph.searchStarterPacksV2", operation, {
        q: identifiers([input.query], 1, operation, "search query")[0],
      });

      const hitsTotal = optionalNumber(response["hitsTotal"]);

      return {
        ...page(response, "starterPacks"),
        ...definedFields({ hitsTotal }),
      };
    },
    async getEmbedExternalView(input) {
      const operation = "bluesky.embeds.externalView";

      if (!/^https?:\/\/[^\s]+$/i.test(input.url) || (input.uris?.length ?? 0) > 4)
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "getEmbedExternalView needs an absolute http(s) url and at most 4 uris.",
          retryDisposition: { kind: "never" },
        });

      return viewRead(
        input.account,
        input.context,
        "app.bsky.embed.getEmbedExternalView",
        operation,
        {
          url: input.url,
          canonicalUri:
            input.canonicalUri === undefined ? undefined : atUri(input.canonicalUri, operation),
          uris: input.uris?.map((uri) => atUri(uri, operation)),
        },
      );
    },
    async sendFeedInteractions(input) {
      const operation = "bluesky.feeds.interactions";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      if (
        !DID.test(input.feedServiceDid) ||
        input.interactions.length === 0 ||
        input.interactions.some(
          (interaction) =>
            !interaction.event.trim() ||
            (interaction.feedContext?.length ?? 0) > 2000 ||
            (interaction.reqId?.length ?? 0) > 100,
        )
      )
        throw new SocialError({
          code: "invalid_input",
          operation,
          message:
            "Feed interactions need the generator's service DID and at least one interaction with an event, a feedContext of at most 2000 characters, and a reqId of at most 100.",
          retryDisposition: { kind: "never" },
        });

      await xrpc("app.bsky.feed.sendInteractions", context, {
        headers: { "atproto-proxy": `${input.feedServiceDid}#bsky_fg` },
        body: JSON.stringify({
          ...definedFields({
            feed: input.feed === undefined ? undefined : atUri(input.feed, operation),
          }),
          interactions: input.interactions.map((interaction) => ({
            event: interaction.event,
            ...definedFields({
              item: interaction.item === undefined ? undefined : atUri(interaction.item, operation),
              feedContext: interaction.feedContext,
              reqId: interaction.reqId,
            }),
          })),
        }),
      });
    },
    async describeRepo(input) {
      const operation = "bluesky.repo.describe";

      const response = await viewRead(
        input.account,
        input.context,
        "com.atproto.repo.describeRepo",
        operation,
        {
          repo: input.repo ?? auth.did,
        },
      );

      const handleIsCorrect = response["handleIsCorrect"];

      if (!isBoolean(handleIsCorrect))
        throw new SocialError({
          code: "upstream_failure",
          operation,
          message: "Bluesky returned an invalid repository description.",
        });

      return {
        did: string(response["did"]),
        handle: string(response["handle"]),
        handleIsCorrect,
        collections: array(response["collections"]).map((value) => string(value)),
        didDoc: object(response["didDoc"]),
      };
    },
    async getPostThreadV2(input) {
      const operation = "bluesky.threads.readV2";

      const bounded = (value: number | undefined, max: number) => {
        if (value === undefined) return undefined;

        if (!Number.isSafeInteger(value) || value < 0 || value > max)
          throw new SocialError({
            code: "invalid_input",
            operation,
            message: "below is 0 to 20 and branchingFactor 0 to 100.",
            retryDisposition: { kind: "never" },
          });

        return String(value);
      };

      const response = await viewRead(
        input.account,
        input.context,
        "app.bsky.unspecced.getPostThreadV2",
        operation,
        {
          anchor: atUri(input.anchor, operation),
          above: input.above === undefined ? undefined : String(input.above),
          below: bounded(input.below, 20),
          branchingFactor: bounded(input.branchingFactor, 100),
          sort: input.sort,
        },
      );

      array(response["thread"]);

      return response;
    },
    async getPostThreadOtherV2(input) {
      const operation = "bluesky.threads.otherV2";

      const response = await viewRead(
        input.account,
        input.context,
        "app.bsky.unspecced.getPostThreadOtherV2",
        operation,
        { anchor: atUri(input.anchor, operation) },
      );

      array(response["thread"]);

      return response;
    },
    async getTrends(input) {
      const operation = "bluesky.trends.list";

      const response = await viewRead(
        input.account,
        input.context,
        "app.bsky.unspecced.getTrends",
        operation,
        {
          limit: limitParam(input.limit, 25, operation),
        },
      );

      array(response["trends"]);

      return response;
    },
    async getTrendingTopics(input) {
      const operation = "bluesky.trends.topics";

      const response = await viewRead(
        input.account,
        input.context,
        "app.bsky.unspecced.getTrendingTopics",
        operation,
        { viewer: input.viewer, limit: limitParam(input.limit, 25, operation) },
      );

      array(response["topics"]);

      return response;
    },
    async getSuggestedUsers(input) {
      const operation = "bluesky.discovery.users";

      return actorPage(
        await viewRead(
          input.account,
          input.context,
          "app.bsky.unspecced.getSuggestedUsers",
          operation,
          {
            category: input.category,
            limit: limitParam(input.limit, 50, operation),
          },
        ),
        "actors",
      );
    },
    async getPopularFeedGenerators(input) {
      return page(
        await pagedRead(
          input,
          "app.bsky.unspecced.getPopularFeedGenerators",
          "bluesky.discovery.feeds",
          {
            query: input.query?.trim() || undefined,
          },
        ),
        "feeds",
      );
    },
    async getSuggestedFeeds(input) {
      const operation = "bluesky.discovery.suggestedFeeds";

      return page(
        await viewRead(
          input.account,
          input.context,
          "app.bsky.unspecced.getSuggestedFeeds",
          operation,
          {
            limit: limitParam(input.limit, 25, operation),
          },
        ),
        "feeds",
      );
    },
    async getSuggestedStarterPacks(input) {
      const operation = "bluesky.discovery.starterPacks";

      return page(
        await viewRead(
          input.account,
          input.context,
          "app.bsky.unspecced.getSuggestedStarterPacks",
          operation,
          { limit: limitParam(input.limit, 25, operation) },
        ),
        "starterPacks",
      );
    },
    async getTaggedSuggestions(input) {
      return listOf(
        await viewRead(
          input.account,
          input.context,
          "app.bsky.unspecced.getTaggedSuggestions",
          "bluesky.discovery.tagged",
          {},
        ),
        "suggestions",
      );
    },
    async getAgeAssuranceConfig(input) {
      const response = await viewRead(
        input.account,
        input.context,
        "app.bsky.ageassurance.getConfig",
        "bluesky.ageAssurance.config",
        {},
      );

      array(response["regions"]);

      return response;
    },
    async getAgeAssuranceState(input) {
      const operation = "bluesky.ageAssurance.state";

      const response = await viewRead(
        input.account,
        input.context,
        "app.bsky.ageassurance.getState",
        operation,
        {
          countryCode: countryCode(input.countryCode, operation),
          regionCode: input.regionCode,
        },
      );

      object(response["state"]);

      return response;
    },
    async beginAgeAssurance(input) {
      const operation = "bluesky.ageAssurance.begin";

      if (!/^[^\s@]+@[^\s@]+$/.test(input.email) || !input.language.trim())
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "Age assurance needs an email address and a language.",
          retryDisposition: { kind: "never" },
        });

      return procedure(input.account, input.context, "app.bsky.ageassurance.begin", operation, {
        email: input.email,
        language: input.language,
        countryCode: countryCode(input.countryCode, operation),
        ...definedFields({ regionCode: input.regionCode }),
      });
    },
    async resolveHandle(input) {
      const operation = "bluesky.identity.resolveHandle";

      const did = string(
        (
          await viewRead(
            input.account,
            input.context,
            "com.atproto.identity.resolveHandle",
            operation,
            {
              handle: identifiers([input.handle], 1, operation, "handle")[0],
            },
          )
        )["did"],
      );

      if (!DID.test(did))
        throw new SocialError({
          code: "upstream_failure",
          operation,
          message: "Bluesky resolved the handle to an invalid DID.",
        });

      return did;
    },
    async resolveDid(input) {
      const operation = "bluesky.identity.resolveDid";

      return object(
        (
          await viewRead(
            input.account,
            input.context,
            "com.atproto.identity.resolveDid",
            operation,
            {
              did: memberDid(input.did, operation),
            },
          )
        )["didDoc"],
      );
    },
    async resolveIdentity(input) {
      const operation = "bluesky.identity.resolve";

      const info = await viewRead(
        input.account,
        input.context,
        "com.atproto.identity.resolveIdentity",
        operation,
        {
          identifier: identifiers([input.identifier], 1, operation, "handle or DID")[0],
        },
      );

      const did = string(info["did"]);

      if (!DID.test(did))
        throw new SocialError({
          code: "upstream_failure",
          operation,
          message: "Bluesky returned an invalid identity.",
        });

      return { did, handle: string(info["handle"]), didDoc: object(info["didDoc"]) };
    },
    async createAppPassword(input) {
      const operation = "bluesky.appPasswords.create";

      const name = input.name.trim();

      if (!name)
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "An app password needs a name.",
          retryDisposition: { kind: "never" },
        });

      return decodedProcedure(
        input.account,
        input.context,
        "com.atproto.server.createAppPassword",
        operation,
        { name, ...definedFields({ privileged: input.privileged }) },
        (created) => {
          const privileged = created["privileged"];

          return {
            name: string(created["name"]),
            password: string(created["password"]),
            createdAt: string(created["createdAt"]),
            ...definedFields({ privileged: isBoolean(privileged) ? privileged : undefined }),
          };
        },
      );
    },
    async listAppPasswords(input) {
      return listOf(
        await viewRead(
          input.account,
          input.context,
          "com.atproto.server.listAppPasswords",
          "bluesky.appPasswords.list",
          {},
        ),
        "passwords",
      ).map((entry) => {
        const privileged = entry["privileged"];

        return {
          name: string(entry["name"]),
          createdAt: string(entry["createdAt"]),
          ...definedFields({ privileged: isBoolean(privileged) ? privileged : undefined }),
        };
      });
    },
    async revokeAppPassword(input) {
      await voidProcedure(
        input.account,
        input.context,
        "com.atproto.server.revokeAppPassword",
        "bluesky.appPasswords.revoke",
        { name: requiredText(input.name, "bluesky.appPasswords.revoke", "app password name") },
      );
    },
    async updateHandle(input) {
      const operation = "bluesky.identity.updateHandle";

      const handle = input.handle.trim().toLowerCase();

      if (
        !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(handle) ||
        handle.length > 253
      )
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "Provide a valid domain-name handle, such as alice.example.com.",
          retryDisposition: { kind: "never" },
        });

      await voidProcedure(
        input.account,
        input.context,
        "com.atproto.identity.updateHandle",
        operation,
        {
          handle,
        },
      );
    },
    async refreshIdentity(input) {
      const operation = "bluesky.identity.refresh";

      return decodedProcedure(
        input.account,
        input.context,
        "com.atproto.identity.refreshIdentity",
        operation,
        { identifier: requiredText(input.identifier, operation, "handle or DID") },
        (info) => ({
          did: string(info["did"]),
          handle: string(info["handle"]),
          didDoc: object(info["didDoc"]),
        }),
      );
    },
    async deactivateAccount(input) {
      const operation = "bluesky.account.deactivate";

      if (input.deleteAfter !== undefined && Number.isNaN(Date.parse(input.deleteAfter)))
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "deleteAfter must be an ISO 8601 datetime.",
          retryDisposition: { kind: "never" },
        });

      await voidProcedure(
        input.account,
        input.context,
        "com.atproto.server.deactivateAccount",
        operation,
        definedFields({ deleteAfter: input.deleteAfter }),
      );
    },
    async activateAccount(input) {
      await emptyProcedure(input, "com.atproto.server.activateAccount", "bluesky.account.activate");
    },
    async requestAccountDelete(input) {
      await emptyProcedure(
        input,
        "com.atproto.server.requestAccountDelete",
        "bluesky.account.requestDelete",
      );
    },
    async requestEmailConfirmation(input) {
      await emptyProcedure(
        input,
        "com.atproto.server.requestEmailConfirmation",
        "bluesky.account.requestEmailConfirmation",
      );
    },
    async confirmEmail(input) {
      const operation = "bluesky.account.confirmEmail";

      await voidProcedure(
        input.account,
        input.context,
        "com.atproto.server.confirmEmail",
        operation,
        {
          email: emailAddress(input.email, operation),
          token: requiredText(input.token, operation, "token"),
        },
      );
    },
    async requestEmailUpdate(input) {
      const operation = "bluesky.account.requestEmailUpdate";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      return decodeWrite(
        await xrpc("com.atproto.server.requestEmailUpdate", context, { method: "POST" }),
        operation,
        (response) => {
          const tokenRequired = response["tokenRequired"];

          if (!isBoolean(tokenRequired))
            throw new SocialError({
              code: "upstream_failure",
              operation,
              message: "Bluesky did not say whether an email token is required.",
            });

          return { tokenRequired };
        },
      );
    },
    async updateEmail(input) {
      const operation = "bluesky.account.updateEmail";

      await voidProcedure(
        input.account,
        input.context,
        "com.atproto.server.updateEmail",
        operation,
        {
          email: emailAddress(input.email, operation),
          ...definedFields({ token: input.token, emailAuthFactor: input.emailAuthFactor }),
        },
      );
    },
    async getServiceAuth(input) {
      const operation = "bluesky.server.serviceAuth";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      if (
        !DID.test(input.aud.split("#")[0] ?? "") ||
        (input.lxm !== undefined && !NSID.test(input.lxm)) ||
        (input.expiresInSeconds !== undefined &&
          (!Number.isSafeInteger(input.expiresInSeconds) || input.expiresInSeconds < 1))
      )
        throw new SocialError({
          code: "invalid_input",
          operation,
          message:
            "getServiceAuth needs a service DID as aud, an NSID lxm, and a positive lifetime.",
          retryDisposition: { kind: "never" },
        });

      const query = new URLSearchParams({ aud: input.aud });

      if (input.lxm !== undefined) query.set("lxm", input.lxm);

      if (input.expiresInSeconds !== undefined)
        query.set("exp", String(Math.floor(Date.now() / 1000) + input.expiresInSeconds));

      return string(
        object(await xrpc(`com.atproto.server.getServiceAuth?${query}`, context))["token"],
      );
    },
    async getRecommendedDidCredentials(input) {
      return viewRead(
        input.account,
        input.context,
        "com.atproto.identity.getRecommendedDidCredentials",
        "bluesky.identity.recommendedCredentials",
        {},
      );
    },
    async requestPlcOperationSignature(input) {
      await emptyProcedure(
        input,
        "com.atproto.identity.requestPlcOperationSignature",
        "bluesky.identity.requestPlcSignature",
      );
    },
    async signPlcOperation(input) {
      const operation = "bluesky.identity.signPlc";

      return decodedProcedure(
        input.account,
        input.context,
        "com.atproto.identity.signPlcOperation",
        operation,
        {
          token: requiredText(input.token, operation, "token"),
          ...definedFields({
            rotationKeys: input.rotationKeys === undefined ? undefined : [...input.rotationKeys],
            alsoKnownAs: input.alsoKnownAs === undefined ? undefined : [...input.alsoKnownAs],
            verificationMethods: input.verificationMethods,
            services: input.services,
          }),
        },
        (response) => object(response["operation"]),
      );
    },
    async submitPlcOperation(input) {
      await voidProcedure(
        input.account,
        input.context,
        "com.atproto.identity.submitPlcOperation",
        "bluesky.identity.submitPlc",
        { operation: input.operation },
      );
    },
    async importRepo(input) {
      const operation = "bluesky.repo.import";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const size = input.car instanceof Blob ? input.car.size : input.car.byteLength;

      if (size === 0)
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "The repository CAR file is empty.",
          retryDisposition: { kind: "never" },
        });

      await xrpc("com.atproto.repo.importRepo", context, {
        body: input.car,
        headers: { "Content-Type": "application/vnd.ipld.car" },
      });
    },
    async listMissingBlobs(input) {
      const operation = "bluesky.repo.missingBlobs";
      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const query = new URLSearchParams({
        ...definedFields({
          limit: limitParam(input.limit, 1000, operation),
          cursor: input.cursor || undefined,
        }),
      });

      const response = object(await xrpc(`com.atproto.repo.listMissingBlobs?${query}`, context));

      return {
        blobs: array(response["blobs"]).map((value) => {
          const blob = object(value);

          return { cid: string(blob["cid"]), recordUri: string(blob["recordUri"]) };
        }),
        ...definedFields({ cursor: optionalString(response["cursor"]) }),
      };
    },
    async startPhoneVerification(input) {
      const operation = "bluesky.contacts.startPhoneVerification";

      await procedure(
        input.account,
        input.context,
        "app.bsky.contact.startPhoneVerification",
        operation,
        {
          phone: phoneNumber(input.phone, operation),
        },
      );
    },
    async verifyPhone(input) {
      const operation = "bluesky.contacts.verifyPhone";

      return decodedProcedure(
        input.account,
        input.context,
        "app.bsky.contact.verifyPhone",
        operation,
        {
          phone: phoneNumber(input.phone, operation),
          code: requiredText(input.code, operation, "verification code"),
        },
        (result) => ({ token: string(result["token"]) }),
      );
    },
    async importContacts(input) {
      const operation = "bluesky.contacts.import";

      if (input.contacts.length === 0 || input.contacts.length > 1000)
        throw new SocialError({
          code: "invalid_input",
          operation,
          message: "Import 1 to 1000 phone numbers at a time.",
          retryDisposition: { kind: "never" },
        });

      return decodedProcedure(
        input.account,
        input.context,
        "app.bsky.contact.importContacts",
        operation,
        {
          token: requiredText(input.token, operation, "verification token"),
          contacts: input.contacts.map((contact) => phoneNumber(contact, operation)),
        },
        (response) =>
          array(response["matchesAndContactIndexes"]).map((value) => {
            const entry = object(value);

            const contactIndex = entry["contactIndex"];

            if (
              !isFiniteNumber(contactIndex) ||
              !Number.isSafeInteger(contactIndex) ||
              contactIndex < 0
            )
              throw new SocialError({
                code: "upstream_failure",
                operation,
                message: "Bluesky returned an invalid contact index.",
              });

            return { match: object(entry["match"]), contactIndex };
          }),
      );
    },
    async getContactMatches(input) {
      return actorPage(
        await pagedRead(input, "app.bsky.contact.getMatches", "bluesky.contacts.matches"),
        "matches",
      );
    },
    async dismissContactMatch(input) {
      const operation = "bluesky.contacts.dismiss";

      await procedure(input.account, input.context, "app.bsky.contact.dismissMatch", operation, {
        subject: memberDid(input.subject, operation),
      });
    },
    async getContactSyncStatus(input) {
      const status = optionalObject(
        (
          await viewRead(
            input.account,
            input.context,
            "app.bsky.contact.getSyncStatus",
            "bluesky.contacts.status",
            {},
          )
        )["syncStatus"],
      );

      if (status === undefined) return undefined;

      const matchesCount = status["matchesCount"];

      if (!isFiniteNumber(matchesCount))
        throw new SocialError({
          code: "upstream_failure",
          operation: "bluesky.contacts.status",
          message: "Bluesky returned an invalid contact sync status.",
        });

      return { syncedAt: string(status["syncedAt"]), matchesCount };
    },
    async removeContactData(input) {
      await procedure(
        input.account,
        input.context,
        "app.bsky.contact.removeData",
        "bluesky.contacts.remove",
        {},
      );
    },
    async hideReply(input) {
      const operation = "bluesky.comments.moderate";

      const context = nativeContext(input.context, operation);
      assertNativeAccount(input.account, context, operation);

      const invalid = (message: string) =>
        new SocialError({
          code: "invalid_input",
          operation,
          message,
          retryDisposition: { kind: "never" },
        });

      const postUri =
        /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/app\.bsky\.feed\.post\/[A-Za-z0-9._~:-]{1,512}$/;

      if (!postUri.test(input.replyUri))
        throw invalid("Reply must be an app.bsky.feed.post AT-URI.");

      const postView = async (uri: string): Promise<ReturnType<typeof object>> => {
        const query = new URLSearchParams({ uris: uri });

        const found = array(
          object(await xrpc(`app.bsky.feed.getPosts?${query.toString()}`, context))["posts"],
        )
          .map((value) => object(value))
          .find((value) => value["uri"] === uri);

        if (found === undefined)
          throw new SocialError({
            code: "not_found",
            operation,
            message: "Bluesky post was not found.",
          });

        return found;
      };

      const reply = object(object((await postView(input.replyUri))["record"]))["reply"];

      if (reply === undefined) throw invalid("The URI identifies a root post, not a reply.");

      const rootUri = string(object(object(reply)["root"])["uri"]);

      if (!rootUri.startsWith(`at://${auth.did}/app.bsky.feed.post/`))
        throw invalid("Only the author of the thread's root post can hide its replies.");

      const rkey = recordKey(rootUri, "app.bsky.feed.post");

      const threadgateUri = `at://${auth.did}/app.bsky.feed.threadgate/${rkey}`;

      const gate = (await postView(rootUri))["threadgate"];

      let existing:
        | {
            readonly ref: BlueskyPostRef;
            readonly record: ReturnType<typeof object>;
            readonly hiddenReplies: readonly string[];
          }
        | undefined;

      if (gate !== undefined) {
        const view = object(gate);

        if (view["uri"] !== threadgateUri)
          throw new SocialError({
            code: "upstream_failure",
            operation,
            message: "Bluesky returned a threadgate for a different post.",
          });

        const record = object(view["record"]);
        existing = {
          ref: postRef(view),
          record,
          hiddenReplies:
            record["hiddenReplies"] === undefined
              ? []
              : array(record["hiddenReplies"]).map((value) => string(value)),
        };
      }

      const current = existing?.hiddenReplies.includes(input.replyUri) ?? false;

      if (current === input.hidden)
        return existing === undefined
          ? { hidden: current }
          : { hidden: current, threadgate: existing.ref };

      if (existing === undefined) {
        // Omit `allow`: an absent allow list keeps replies open, an empty one closes them.
        const created = await xrpc("com.atproto.repo.createRecord", context, {
          body: JSON.stringify({
            repo: auth.did,
            collection: "app.bsky.feed.threadgate",
            rkey,
            record: {
              $type: "app.bsky.feed.threadgate",
              post: rootUri,
              createdAt: new Date().toISOString(),
              hiddenReplies: [input.replyUri],
            },
          }),
        });

        return { hidden: true, threadgate: writtenRef(created, operation) };
      }

      const hiddenReplies = input.hidden
        ? [...existing.hiddenReplies, input.replyUri]
        : existing.hiddenReplies.filter((uri) => uri !== input.replyUri);
      // swapRecord makes the PDS reject the write if the threadgate changed since it was read.

      const updated = await xrpc("com.atproto.repo.putRecord", context, {
        body: JSON.stringify({
          repo: auth.did,
          collection: "app.bsky.feed.threadgate",
          rkey,
          record: { ...existing.record, hiddenReplies },
          swapRecord: existing.ref.cid,
        }),
      });

      return { hidden: input.hidden, threadgate: writtenRef(updated, operation) };
    },
  };

  const adapter = defineAdapter<BlueskyNative, SocialAdapter<BlueskyNative>>({
    id: backend,
    capabilities,
    native,
    media: {
      async upload(media, accountRef, context): Promise<MediaRef> {
        const video = videoSource(media);

        const upload =
          video.size > MULTIPART_VIDEO_MIN_BYTES ? native.uploadVideoMultipart : native.uploadVideo;

        const job = await upload({
          account: accountRef,
          video,
          mimeType: "video/mp4",
          ...definedFields({ name: media.filename }),
          context,
        });

        return {
          kind: "media",
          version: 1,
          backend,
          platform: "bluesky",
          accountId: auth.did,
          mediaId: job.jobId,
        };
      },
    },
    graph: {
      async getProfile(account, input, context): Promise<ProfileRecord> {
        const value = await native.getProfile({
          account,
          ...definedFields({ actor: input.profileId ?? input.handle }),
          context,
        });

        const actor = object(value);

        const id = string(actor["did"]);

        return {
          ref: profileRef({
            backend,
            platform: "bluesky",
            accountId: account.accountId,
            profileId: id,
          }),
          ...definedFields({
            displayName: optionalString(actor["displayName"]),
            handle: optionalString(actor["handle"]),
            avatarUrl: optionalString(actor["avatar"]),
            bio: optionalString(actor["description"]),
          }),
          native: actor,
        };
      },
      async listRelationships(account, input, context): Promise<Page<RelationshipRecord>> {
        const page = definedFields({ cursor: input.cursor, limit: input.limit });

        const result =
          input.kind === "following"
            ? await native.getFollows({
                account,
                context,
                ...page,
              })
            : input.kind === "followers"
              ? await native.getFollowers({
                  account,
                  context,
                  ...page,
                })
              : input.kind === "blocked"
                ? await native.getBlocks({
                    account,
                    context,
                    ...page,
                  })
                : await native.getMutes({
                    account,
                    context,
                    ...page,
                  });

        return {
          items: result.actors.map((actor) => {
            const value = object(actor);

            const id = string(value["did"]);

            return {
              profile: profileRef({
                backend,
                platform: "bluesky",
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
          ...definedFields({ nextCursor: result.cursor }),
        };
      },
      async follow(target, context): Promise<RelationshipRecord> {
        await native.follow({ account, did: target.profileId, context });

        return { profile: target, relationship: "following" };
      },
      async unfollow(target, context): Promise<void> {
        const profile = object(
          await native.getProfile({ account, actor: target.profileId, context }),
        );

        const viewer = object(profile["viewer"] ?? {});

        const uri = viewer["following"];

        if (!isString(uri) || !uri)
          throw new SocialError({
            code: "invalid_input",
            operation: "graph.unfollow",
            message: "A follow record URI is required to unfollow.",
          });

        await native.unfollow({ account, followUri: uri, context });
      },
      async block(target, context): Promise<RelationshipRecord> {
        await native.block({ account, did: target.profileId, context });

        return { profile: target, relationship: "blocked" };
      },
      async unblock(target, context): Promise<void> {
        const profile = object(
          await native.getProfile({ account, actor: target.profileId, context }),
        );

        const viewer = object(profile["viewer"] ?? {});

        const uri = viewer["blocking"];

        if (!isString(uri) || !uri)
          throw new SocialError({
            code: "invalid_input",
            operation: "graph.unblock",
            message: "A block record URI is required to unblock.",
          });

        await native.unblock({ account, blockUri: uri, context });
      },
      async mute(target, context): Promise<RelationshipRecord> {
        await native.mute({ account, did: target.profileId, context });

        return { profile: target, relationship: "muted" };
      },
      async unmute(target, context): Promise<void> {
        await native.unmute({ account, did: target.profileId, context });
      },
    },
    accounts: {
      async list(_input, context): Promise<Page<AccountRecord>> {
        const session = await verifiedSession(context);

        return {
          items: [
            {
              ref: account,
              displayName: session.handle ?? session.did,
              ...definedFields({ handle: session.handle }),
              status: "connected",
            },
          ],
        };
      },
      async get(ref, context): Promise<AccountRecord> {
        if (!accountMatches(ref, auth, backend))
          throw new SocialError({
            code: "unauthorized",
            operation: "bluesky.accounts.get",
            message: "The account reference does not belong to this Bluesky adapter.",
            account: ref,
          });

        const session = await verifiedSession(context);

        return {
          ref: account,
          displayName: session.handle ?? session.did,
          ...definedFields({ handle: session.handle }),
          status: "connected",
        };
      },
    },
    search: {
      async posts(account, input, context): Promise<Page<JsonObject>> {
        if (!accountMatches(account, auth, backend))
          throw new SocialError({
            code: "unauthorized",
            operation: "search.posts",
            message: "The account reference does not belong to this adapter.",
            account,
          });

        const result = await native.searchPosts({
          account,
          query: input.query,
          ...definedFields({
            cursor: input.cursor,
            limit: input.limit,
            since: input.startTime,
            until: input.endTime,
            scope: input.scope,
          }),
          context,
        });

        return {
          items: result.posts,
          ...definedFields({
            nextCursor: result.cursor,
            metadata: result.hitsTotal === undefined ? undefined : { hitsTotal: result.hitsTotal },
          }),
        };
      },
    },
    notifications: {
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ): Promise<Page<JsonObject>> {
        if (!accountMatches(account, auth, backend))
          throw new SocialError({
            code: "unauthorized",
            operation: "bluesky.notifications.list",
            message: "The account reference does not belong to this adapter.",
            account,
          });

        const response = await native.listNotifications({
          account,
          ...definedFields({ cursor: input.cursor, limit: input.limit }),
          context,
        });

        const values = response["notifications"];

        const items = values === undefined ? [] : array(values).map((value) => object(value));

        return {
          items,
          ...definedFields({ nextCursor: optionalString(response["cursor"]) }),
        };
      },
      async markSeen(
        account: ConnectedAccountRef,
        input: { readonly seenAt?: string },
        context: AdapterOperationContext,
      ): Promise<void> {
        if (!accountMatches(account, auth, backend))
          throw new SocialError({
            code: "unauthorized",
            operation: "bluesky.notifications.seen",
            message: "The account reference does not belong to this adapter.",
            account,
          });

        await native.markNotificationsSeen({
          account,
          ...definedFields({ seenAt: input.seenAt }),
          context,
        });
      },
    },
    posts: {
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ): Promise<Page<JsonObject>> {
        if (!accountMatches(account, auth, backend))
          throw new SocialError({
            code: "unauthorized",
            operation: "bluesky.posts.list",
            message: "The account reference does not belong to this adapter.",
          });

        const limit = input.limit ?? 50;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.read",
            message: "Bluesky author-feed page size must be between 1 and 100.",
          });

        const query = new URLSearchParams({
          actor: auth.did,
          limit: String(limit),
          ...definedFields({ cursor: input.cursor }),
        });

        const response = object(
          await xrpc(`app.bsky.feed.getAuthorFeed?${query.toString()}`, context),
        );

        const feed = array(response["feed"]).map((value): JsonObject => {
          const entry = object(value);

          const post = object(entry["post"]);

          return {
            post: projectPublic(post, publicFeedPost),
            ...definedFields({
              reason:
                entry["reason"] === undefined
                  ? undefined
                  : projectPublic(entry["reason"], {
                      strings: ["$type", "indexedAt"],
                      objects: { by: publicAuthor },
                    }),
            }),
          };
        });

        return {
          items: feed,
          ...definedFields({ nextCursor: optionalString(response["cursor"]) }),
        };
      },
      prepareTarget(target) {
        const issues = [];

        const text = target.content.text ?? "";

        let parsed: PostOptions | undefined;

        try {
          parsed = postOptions(text, target);
        } catch (error) {
          issues.push({
            code: "bluesky.richtext",
            message: error instanceof Error ? error.message : "Invalid Bluesky rich text options.",
            severity: "error" as const,
          });
        }

        const link = target.content.link;

        if (link !== undefined && !/^https?:\/\/[^\s]+$/i.test(link.url))
          issues.push({
            code: "link.invalid",
            message: "A Bluesky link card needs an absolute http(s) URL.",
            severity: "error" as const,
          });

        if (link !== undefined && (target.content.media?.length ?? 0) > 0)
          issues.push({
            code: "link.with_media",
            message:
              "A Bluesky post carries one media embed: images, one video, or one link card. Put the URL in text instead.",
            severity: "error" as const,
          });

        if (parsed?.linkAssociatedRefs !== undefined && link === undefined)
          issues.push({
            code: "link.associated_refs_without_link",
            message: "linkAssociatedRefs applies only to a content.link card.",
            severity: "error" as const,
          });

        if (parsed?.linkThumbnail !== undefined && link === undefined)
          issues.push({
            code: "link.thumbnail_without_link",
            message: "linkThumbnail applies only to a content.link card.",
            severity: "error" as const,
          });

        if (parsed?.replyRules !== undefined && target.replyTo !== undefined)
          issues.push({
            code: "bluesky.reply_controls_on_reply",
            message: "Reply controls (threadgates) apply to a thread's root post, not to a reply.",
            severity: "error" as const,
          });

        if (new TextEncoder().encode(text).byteLength > 3000 || graphemeCount(text) > 300)
          issues.push({
            code: "text.too_long",
            message: "Bluesky posts must be at most 300 graphemes and 3,000 UTF-8 bytes.",
            severity: "error" as const,
          });

        if (target.account.platform !== "bluesky")
          issues.push({
            code: "platform.unsupported",
            message: "Bluesky adapter received a different platform.",
            severity: "error" as const,
          });

        if (target.schedule !== undefined)
          issues.push({
            code: "schedule.unsupported",
            message: "Bluesky scheduling requires an application-owned job runner.",
            severity: "error" as const,
          });

        const media = target.content.media ?? [];

        const videos = media.filter((item) => item.kind === "video");

        if (
          videos.length === 0 &&
          parsed !== undefined &&
          (parsed.captions.length > 0 || parsed.presentation !== undefined)
        )
          issues.push({
            code: "bluesky.video_options_without_video",
            message: "videoCaptions and videoPresentation apply only to a video post.",
            severity: "error" as const,
          });

        if (media.some((item) => item.kind === "document"))
          issues.push({
            code: "media.unsupported_kind",
            message: "Bluesky posts accept image and video media only.",
            severity: "error" as const,
          });

        if (videos.length > 0 && media.length !== 1)
          issues.push({
            code: "media.mixed",
            message: "A Bluesky post carries either up to ten images or exactly one video.",
            severity: "error" as const,
          });

        for (const image of media.filter((item) => item.kind === "image")) {
          try {
            const mimeType =
              image.mimeType ??
              (image.source.kind === "blob" ? image.source.blob.type || undefined : undefined);

            if (mimeType !== undefined || image.source.kind !== "https-url")
              imageMimeType(mimeType);
          } catch (error) {
            issues.push({
              code: "media.mime_type",
              message: error instanceof Error ? error.message : "Invalid image MIME type.",
              severity: "error" as const,
            });
          }

          if (image.source.kind === "blob" && image.source.blob.size > MAX_IMAGE_BYTES)
            issues.push({
              code: "media.too_large",
              message: "Image exceeds the 2,000,000-byte limit.",
              severity: "error" as const,
            });
        }

        for (const item of media) {
          if (
            (item.width === undefined) !== (item.height === undefined) ||
            [item.width, item.height].some(
              (value) => value !== undefined && (!Number.isSafeInteger(value) || value < 1),
            )
          )
            issues.push({
              code: "media.aspect_ratio",
              message: "Media width and height must be supplied together as positive integers.",
              severity: "error" as const,
            });
        }

        for (const video of videos) {
          const ref = video.source.kind === "media-ref" ? video.source.ref : undefined;

          if (ref === undefined)
            issues.push({
              code: "media.video_ref_required",
              message:
                "Upload the video with media.upload, wait until its job has a blob, then publish the returned media reference.",
              severity: "error" as const,
            });
          else if (
            ref.backend !== target.account.backend ||
            ref.platform !== "bluesky" ||
            ref.accountId !== target.account.accountId ||
            !/^[\x21-\x7e]{1,256}$/.test(ref.mediaId)
          )
            issues.push({
              code: "media.video_owner",
              message: "Video reference belongs to another account or backend, or is malformed.",
              severity: "error" as const,
            });
        }

        if (videos.length === 0 && media.length > MAX_GALLERY_IMAGES)
          issues.push({
            code: "media.too_many",
            message: `Bluesky supports at most ${MAX_GALLERY_IMAGES} images per post.`,
            severity: "error" as const,
          });

        // Five or more images use app.bsky.embed.gallery, whose items require an aspect ratio.
        if (
          videos.length === 0 &&
          media.length > MAX_IMAGES &&
          media.some((item) => item.width === undefined || item.height === undefined)
        )
          issues.push({
            code: "media.aspect_ratio_required",
            message:
              "A Bluesky gallery of five or more images needs width and height on every image.",
            severity: "error" as const,
          });

        return issues;
      },
      async publishTarget(target, context): Promise<DeliveryOutcome> {
        if (!accountMatches(target.account, auth, backend))
          throw new SocialError({
            code: "unauthorized",
            operation: "bluesky.publish",
            message: "The account reference does not belong to this adapter.",
            account: target.account,
          });

        try {
          const content = target.content;

          const text = content.text ?? "";
          validatePostText(text);
          const issues = adapter.posts?.prepareTarget?.(target) ?? [];

          if (issues.some((issue) => issue.severity === "error"))
            throw new SocialError({
              code: "invalid_input",
              operation: "bluesky.publish",
              message: "Bluesky content failed validation.",
              issues,
            });

          const createdAt = new Date().toISOString();

          const parsed = postOptions(text, target);

          let reply: JsonObject | undefined;

          let media: JsonObject | undefined;

          if (target.replyTo !== undefined) {
            if (target.replyTo.kind !== "platform-post")
              throw new SocialError({
                code: "unsupported_capability",
                operation: "bluesky.reply",
                message: "Bluesky replies require a platform post reference.",
              });

            const parent = await native.getPost({
              uri: target.replyTo.native?.["uri"]?.toString() ?? target.replyTo.postId,
              context,
            });

            const parentRecord = object(parent["record"]);

            const parentRef =
              target.replyTo.native === undefined
                ? { uri: string(parent["uri"]), cid: string(parent["cid"]) }
                : {
                    uri: string(target.replyTo.native["uri"]),
                    cid: string(target.replyTo.native["cid"]),
                  };

            const rootValue = parentRecord["reply"];

            const root = rootValue === undefined ? parentRef : object(object(rootValue)["root"]);
            reply = { root, parent: parentRef };
          }

          const video = content.media?.find((item) => item.kind === "video");

          if (video !== undefined) {
            if (video.source.kind !== "media-ref" || content.media?.length !== 1)
              throw new SocialError({
                code: "invalid_input",
                operation: "bluesky.publish",
                message: "Bluesky video posts require exactly one uploaded video reference.",
                retryDisposition: { kind: "never" },
              });

            const ref = video.source.ref;

            if (ref.backend !== backend || ref.platform !== "bluesky" || ref.accountId !== auth.did)
              throw new SocialError({
                code: "unauthorized",
                operation: "bluesky.publish",
                message: "The video reference does not belong to this adapter.",
                account: target.account,
              });

            // One status read. A job that is still processing fails before any post is created.
            const job = await native.getVideoJobStatus({
              account: target.account,
              jobId: ref.mediaId,
              context,
            });

            if (job.blob === undefined)
              throw new SocialError(
                job.state === "JOB_STATE_FAILED"
                  ? {
                      code: "media_error",
                      operation: "bluesky.publish",
                      message: "Bluesky video processing failed. No post was created.",
                      retryDisposition: { kind: "never" },
                      ...definedFields({ upstreamCode: job.failureCode }),
                    }
                  : {
                      code: "media_error",
                      operation: "bluesky.publish",
                      message:
                        "Bluesky video processing is not complete. No post was created. Check native.getVideoJobStatus, then publish again.",
                      retryDisposition: { kind: "after-delay", delayMs: 1000 },
                      upstreamCode: job.state,
                    },
              );

            // Caption tracks reference text/vtt blobs the caller uploaded with native.uploadBlob.
            const captions = parsed.captions.map((track) => ({
              lang: track.lang,
              file: blobJson(track.file),
            }));

            media = {
              $type: "app.bsky.embed.video",
              video: job.blob,
              ...definedFields({
                alt: video.altText,
                aspectRatio:
                  video.width === undefined || video.height === undefined
                    ? undefined
                    : { width: video.width, height: video.height },
                captions: captions.length ? captions : undefined,
                presentation: parsed.presentation,
              }),
            };
          } else if (content.media !== undefined && content.media.length > 0) {
            const items: JsonObject[] = [];

            for (const attachment of content.media) {
              const source = await readMedia(
                attachment.source,
                fetcher,
                context,
                allowMediaHost,
                attachment.mimeType,
              );

              items.push({
                image: await uploadBytes(source.bytes, source.mimeType, context),
                alt: attachment.altText ?? "",
                ...definedFields({
                  aspectRatio:
                    attachment.width === undefined || attachment.height === undefined
                      ? undefined
                      : { width: attachment.width, height: attachment.height },
                }),
              });
            }

            // Up to four images keep the widely rendered images embed; five to ten use a gallery.
            media =
              items.length <= MAX_IMAGES
                ? { $type: "app.bsky.embed.images", images: items }
                : {
                    $type: "app.bsky.embed.gallery",
                    items: items.map((item) => ({
                      $type: "app.bsky.embed.gallery#image",
                      ...item,
                    })),
                  };
          } else if (content.link !== undefined) {
            // The card uses only caller-supplied metadata; the SDK never fetches the page.
            const thumb =
              parsed.linkThumbnail === undefined ? undefined : blobJson(parsed.linkThumbnail);

            media = {
              $type: "app.bsky.embed.external",
              external: {
                uri: content.link.url,
                title: content.link.title ?? "",
                description: content.link.description ?? "",
                ...definedFields({
                  thumb,
                  associatedRefs:
                    parsed.linkAssociatedRefs === undefined
                      ? undefined
                      : parsed.linkAssociatedRefs.map((ref) => ({ uri: ref.uri, cid: ref.cid })),
                }),
              },
            };
          }

          const quoted =
            parsed.quote === undefined
              ? undefined
              : {
                  $type: "app.bsky.embed.record",
                  record: { uri: parsed.quote.uri, cid: parsed.quote.cid },
                };

          const embed =
            quoted === undefined
              ? media
              : media === undefined
                ? quoted
                : { $type: "app.bsky.embed.recordWithMedia", record: quoted, media };

          const record = {
            $type: "app.bsky.feed.post",
            text,
            createdAt,
            ...parsed.record,
            ...definedFields({ reply, embed }),
          };

          const created =
            parsed.replyRules === undefined && !parsed.disableQuotes
              ? postRef(
                  object(
                    await xrpc("com.atproto.repo.createRecord", context, {
                      body: JSON.stringify({
                        repo: auth.did,
                        collection: "app.bsky.feed.post",
                        record,
                      }),
                      headers: { "Content-Type": "application/json" },
                    }),
                  ),
                )
              : await createGatedPost(record, parsed, createdAt, context);

          const delivery = {
            kind: "delivery" as const,
            version: 1 as const,
            backend,
            deliveryId: created.uri,
            platform: "bluesky" as const,
            accountId: auth.did,
          };

          return {
            state: "published",
            targetIndex: target.targetIndex,
            account: target.account,
            delivery,
            post: {
              ...platformPostRef({
                backend,
                platform: "bluesky",
                accountId: auth.did,
                postId: created.uri,
              }),
              native: { uri: created.uri, cid: created.cid },
            },
            observedAt: new Date().toISOString(),
          };
        } catch (error) {
          throw operationError("bluesky.publish", error);
        }
      },
      async get(ref, context): Promise<JsonObject> {
        if (ref.backend !== backend || ref.platform !== "bluesky" || ref.accountId !== auth.did)
          throw new SocialError({
            code: "unauthorized",
            operation: "bluesky.posts.get",
            message: "The account reference does not belong to this adapter.",
          });

        return native.getPost({ uri: ref.postId, context });
      },
      async removeFromPlatform(ref, context): Promise<void> {
        if (
          !accountMatches(
            connectedAccountRef({
              backend: ref.backend,
              platform: "bluesky",
              accountId: ref.accountId,
            }),
            auth,
            backend,
          )
        )
          throw new SocialError({
            code: "unauthorized",
            operation: "posts.removeFromPlatform",
            message: "The post reference does not belong to this Bluesky adapter.",
          });

        await native.deletePost({
          account,
          post: {
            uri: ref.native?.["uri"]?.toString() ?? ref.postId,
            cid: ref.native?.["cid"]?.toString() ?? "",
          },
          context,
        });
      },
    },
    comments: {
      async list(post, input, context) {
        if (input.cursor !== undefined)
          throw new SocialError({
            code: "unsupported_capability",
            operation: "comments.read",
            message: "This adapter does not expose upstream comment pagination.",
          });

        const thread = await native.getPostThread({ uri: post.postId, context });

        const replies = array(object(thread["thread"])["replies"] ?? []);

        // Each thread view keeps post.author, post.record, and record.reply.parent for normalization.
        return { items: replies.map((reply) => normalizeComment(object(reply))) };
      },
      async reply(comment, content, context): Promise<CommentRef> {
        const outcome = await adapter.posts?.publishTarget(
          {
            targetIndex: 0,
            targetKey: comment.backend + ":" + comment.platform + ":" + comment.accountId,
            account: connectedAccountRef({
              backend: comment.backend,
              platform: "bluesky",
              accountId: comment.accountId,
            }),
            content: { text: content.text },
            replyTo: platformPostRef({
              backend: comment.backend,
              platform: "bluesky",
              accountId: comment.accountId,
              postId: comment.commentId,
            }),
          },
          context,
        );

        if (outcome?.state !== "published")
          throw new SocialError({
            code: "upstream_failure",
            operation: "bluesky.comments.reply",
            message: "Bluesky did not confirm the comment reply.",
          });

        return {
          kind: "comment",
          version: 1,
          backend: comment.backend,
          platform: "bluesky",
          accountId: comment.accountId,
          postId: comment.postId,
          commentId: outcome.post.postId,
        };
      },
    },
    analytics: {
      async getPostMetrics(post, context): Promise<readonly MetricValue[]> {
        const value = await native.getPost({ uri: post.postId, context });

        const record = object(value);

        const fetchedAt = new Date().toISOString();

        const metrics: MetricValue[] = [];

        for (const [name, field] of [
          ["likes", "likeCount"],
          ["reposts", "repostCount"],
          ["replies", "replyCount"],
          ["quotes", "quoteCount"],
          ["bookmarks", "bookmarkCount"],
        ] as const) {
          const count = record[field];

          if (isFiniteNumber(count))
            metrics.push({
              name,
              value: count,
              unit: "count",
              period: "lifetime",
              fetchedAt,
              freshness: "unknown",
              source: "app.bsky.feed.getPosts",
            });
        }

        return normalizeMetrics(metrics);
      },
      async getAccountMetrics(accountRef, context): Promise<readonly MetricValue[]> {
        // https://docs.bsky.app/docs/api/app-bsky-actor-get-profile
        if (!accountMatches(accountRef, auth, backend))
          throw new SocialError({
            code: "unauthorized",
            operation: "bluesky.analytics.account",
            message: "Account reference does not belong to this Bluesky adapter.",
          });

        const profile = object(
          await xrpc(`app.bsky.actor.getProfile?actor=${encodeURIComponent(auth.did)}`, context),
        );

        if (profile["did"] !== auth.did)
          throw new SocialError({
            code: "unauthorized",
            operation: "bluesky.analytics.account",
            message: "Bluesky profile identity does not match the requested DID.",
          });

        const fetchedAt = new Date().toISOString();

        const metrics: readonly MetricValue[] = (
          [
            ["followers", profile["followersCount"]],
            ["following", profile["followsCount"]],
            ["posts", profile["postsCount"]],
          ] as const
        ).flatMap(([name, value]) =>
          isFiniteNumber(value)
            ? [
                {
                  name,
                  value,
                  unit: "count" as const,
                  period: "lifetime" as const,
                  fetchedAt,
                  freshness: "unknown" as const,
                  source: "app.bsky.actor.getProfile",
                },
              ]
            : [],
        );

        return normalizeMetrics(metrics);
      },
    },
  });

  return adapter;
}

/** An app-password session from `com.atproto.server.createSession` or `refreshSession`. */
export interface BlueskySession {
  readonly did: string;
  readonly handle: string;
  /** Short-lived bearer token for `bluesky({ auth: { accessJwt } })`. Never log it. */
  readonly accessJwt: string;
  /** Longer-lived token that mints the next session. It rotates on every refresh. */
  readonly refreshJwt: string;
  readonly active?: boolean;
  /** `takendown`, `suspended`, or `deactivated` when the account is not active. */
  readonly status?: string;
}

interface SessionRequest {
  readonly service: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function sessionFrom(value: JsonValue, operation: string): BlueskySession {
  try {
    const session = object(value);

    const did = string(session["did"]);

    const accessJwt = string(session["accessJwt"]);

    const refreshJwt = string(session["refreshJwt"]);

    if (!/^did:[a-z]+:[A-Za-z0-9._:%-]{1,2000}$/.test(did) || !accessJwt || !refreshJwt)
      throw new Error("invalid session");

    const active = session["active"];

    return {
      did,
      handle: string(session["handle"]),
      accessJwt,
      refreshJwt,
      ...definedFields({
        active: isBoolean(active) ? active : undefined,
        status: optionalString(session["status"]),
      }),
    };
  } catch {
    throw new SocialError({
      code: "upstream_failure",
      operation,
      message: "Bluesky returned an invalid session.",
      retryDisposition: { kind: "reconcile-first" },
    });
  }
}

async function sessionCall(
  request: SessionRequest,
  method: "com.atproto.server.createSession" | "com.atproto.server.refreshSession",
  init: { readonly headers: HeadersInit; readonly body?: string },
): Promise<BlueskySession> {
  const operation = `bluesky.${method}`;

  const http = createHttp({
    fetch: request.fetch ?? globalThis.fetch,
    ...definedFields({ timeoutMs: request.timeoutMs }),
  });

  try {
    return sessionFrom(
      await http({
        url: endpoint(request.service, method),
        method: "POST",
        headers: init.headers,
        maxAttempts: 1,
        ...definedFields({ body: init.body, signal: request.signal }),
      }),
      operation,
    );
  } catch (error) {
    throw operationError(operation, error);
  }
}

/**
 * Signs in with an app password through `com.atproto.server.createSession`. Bluesky limits this
 * to 30 calls per 5 minutes and 300 per day per account, so store the session and refresh it
 * instead of signing in again.
 */
export async function createBlueskySession(
  input: SessionRequest & {
    /** Handle, DID, or email. */
    readonly identifier: string;
    readonly password: string;
    /** Email sign-in code when the account has two-factor email enabled. */
    readonly authFactorToken?: string;
    /**
     * Lets a taken-down account sign in so it can export its data. Without it the PDS rejects
     * the login with `AccountTakedown`; with it the session reports `status: "takendown"`.
     */
    readonly allowTakendown?: boolean;
  },
): Promise<BlueskySession> {
  if (!input.identifier.trim() || !input.password)
    throw new SocialError({
      code: "invalid_input",
      operation: "bluesky.com.atproto.server.createSession",
      message: "An identifier and app password are required.",
      retryDisposition: { kind: "never" },
    });

  return sessionCall(input, "com.atproto.server.createSession", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identifier: input.identifier.trim(),
      password: input.password,
      ...definedFields({
        authFactorToken: input.authFactorToken,
        allowTakendown: input.allowTakendown,
      }),
    }),
  });
}

/**
 * Mints a new session with `com.atproto.server.refreshSession`, authenticated by the refresh
 * token. The old refresh token stops working, so save the returned one atomically. A lost
 * response is `ambiguous_outcome`: the old token may already be spent.
 */
export async function refreshBlueskySession(
  input: SessionRequest & { readonly refreshJwt: string },
): Promise<BlueskySession> {
  if (!input.refreshJwt)
    throw new SocialError({
      code: "invalid_input",
      operation: "bluesky.com.atproto.server.refreshSession",
      message: "A refresh token is required.",
      retryDisposition: { kind: "never" },
    });

  return sessionCall(input, "com.atproto.server.refreshSession", {
    headers: { Authorization: `Bearer ${input.refreshJwt}` },
  });
}

/**
 * Signs an app-password session out with `com.atproto.server.deleteSession`, authenticated by
 * the refresh token. Both tokens stop working. For OAuth sessions use
 * `revokeBlueskyOAuthSession` from the server entry point instead.
 */
export async function deleteBlueskySession(
  input: SessionRequest & { readonly refreshJwt: string },
): Promise<void> {
  if (!input.refreshJwt)
    throw new SocialError({
      code: "invalid_input",
      operation: "bluesky.com.atproto.server.deleteSession",
      message: "A refresh token is required.",
      retryDisposition: { kind: "never" },
    });

  await serverCall(input, "com.atproto.server.deleteSession", {
    headers: { Authorization: `Bearer ${input.refreshJwt}` },
  });
}

/** What a PDS accepts for sign-up (`com.atproto.server.describeServer`). No authentication. */
export async function describeBlueskyServer(input: SessionRequest): Promise<{
  readonly did: string;
  readonly availableUserDomains: readonly string[];
  readonly inviteCodeRequired?: boolean;
  readonly phoneVerificationRequired?: boolean;
  readonly links?: JsonObject;
}> {
  const operation = "bluesky.com.atproto.server.describeServer";

  try {
    const response = object(
      await serverCall(input, "com.atproto.server.describeServer", {}, "GET"),
    );

    const invite = response["inviteCodeRequired"],
      phone = response["phoneVerificationRequired"];

    return {
      did: string(response["did"]),
      availableUserDomains: array(response["availableUserDomains"]).map((value) => string(value)),
      ...definedFields({
        inviteCodeRequired: isBoolean(invite) ? invite : undefined,
        phoneVerificationRequired: isBoolean(phone) ? phone : undefined,
        links: optionalObject(response["links"]),
      }),
    };
  } catch (error) {
    if (error instanceof SocialError) throw error;

    throw new SocialError({
      code: "upstream_failure",
      operation,
      message: "Bluesky returned an invalid server description.",
    });
  }
}

/**
 * Creates an account with `com.atproto.server.createAccount` and returns its session. For a
 * migration, pass the existing `did` and a `serviceAuthToken` from the old PDS's
 * `native.getServiceAuth` (with `lxm: "com.atproto.server.createAccount"`); the account starts
 * deactivated until the repository is imported and `activateAccount` is called.
 */
export async function createBlueskyAccount(
  input: SessionRequest & {
    readonly handle: string;
    readonly email?: string;
    readonly password?: string;
    readonly inviteCode?: string;
    readonly verificationCode?: string;
    readonly verificationPhone?: string;
    /** An existing DID to move to this PDS. */
    readonly did?: string;
    readonly recoveryKey?: string;
    readonly plcOp?: JsonObject;
    /** Bearer service-auth JWT that proves control of `did` during migration. */
    readonly serviceAuthToken?: string;
  },
): Promise<BlueskySession> {
  const operation = "bluesky.com.atproto.server.createAccount";

  if (!input.handle.trim() || (input.did !== undefined && !DID.test(input.did)))
    throw new SocialError({
      code: "invalid_input",
      operation,
      message: "createAccount needs a handle and, when moving an account, a valid DID.",
      retryDisposition: { kind: "never" },
    });

  return sessionFrom(
    await serverCall(input, "com.atproto.server.createAccount", {
      headers: {
        "Content-Type": "application/json",
        ...definedFields({
          Authorization:
            input.serviceAuthToken === undefined ? undefined : `Bearer ${input.serviceAuthToken}`,
        }),
      },
      body: JSON.stringify({
        handle: input.handle.trim(),
        ...definedFields({
          email: input.email,
          password: input.password,
          inviteCode: input.inviteCode,
          verificationCode: input.verificationCode,
          verificationPhone: input.verificationPhone,
          did: input.did,
          recoveryKey: input.recoveryKey,
          plcOp: input.plcOp,
        }),
      }),
    }),
    operation,
  );
}

/** Emails a password reset token (`com.atproto.server.requestPasswordReset`). */
export async function requestBlueskyPasswordReset(
  input: SessionRequest & { readonly email: string },
): Promise<void> {
  if (!/^[^\s@]+@[^\s@]+$/.test(input.email))
    throw new SocialError({
      code: "invalid_input",
      operation: "bluesky.com.atproto.server.requestPasswordReset",
      message: "Provide an email address.",
      retryDisposition: { kind: "never" },
    });

  await serverCall(input, "com.atproto.server.requestPasswordReset", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: input.email }),
  });
}

/** Sets a new password with the emailed token (`com.atproto.server.resetPassword`). */
export async function resetBlueskyPassword(
  input: SessionRequest & { readonly token: string; readonly password: string },
): Promise<void> {
  if (!input.token || !input.password)
    throw new SocialError({
      code: "invalid_input",
      operation: "bluesky.com.atproto.server.resetPassword",
      message: "A reset token and a new password are required.",
      retryDisposition: { kind: "never" },
    });

  await serverCall(input, "com.atproto.server.resetPassword", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: input.token, password: input.password }),
  });
}

/**
 * Permanently deletes an account with `com.atproto.server.deleteAccount`, using the account
 * password and the token from `native.requestAccountDelete`. This cannot be undone.
 */
export async function deleteBlueskyAccount(
  input: SessionRequest & {
    readonly did: string;
    readonly password: string;
    readonly token: string;
  },
): Promise<void> {
  if (!DID.test(input.did) || !input.password || !input.token)
    throw new SocialError({
      code: "invalid_input",
      operation: "bluesky.com.atproto.server.deleteAccount",
      message: "Account deletion needs the DID, the account password, and the emailed token.",
      retryDisposition: { kind: "never" },
    });

  await serverCall(input, "com.atproto.server.deleteAccount", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ did: input.did, password: input.password, token: input.token }),
  });
}

/** One XRPC call to a PDS outside an adapter, without retries. POST unless `GET` is asked. */
async function serverCall(
  request: SessionRequest,
  method: string,
  init: { readonly headers?: HeadersInit; readonly body?: string },
  httpMethod: "GET" | "POST" = "POST",
): Promise<JsonValue> {
  const http = createHttp({
    fetch: request.fetch ?? globalThis.fetch,
    ...definedFields({ timeoutMs: request.timeoutMs }),
  });

  try {
    return await http({
      url: endpoint(request.service, method),
      method: httpMethod,
      maxAttempts: 1,
      ...definedFields({ headers: init.headers, body: init.body, signal: request.signal }),
    });
  } catch (error) {
    throw operationError(`bluesky.${method}`, error, httpMethod === "POST");
  }
}

type JetstreamKind = "commit" | "identity" | "account" | "sync";

/** Filters for a Jetstream subscription. Jetstream needs no authentication. */
export interface BlueskyJetstreamInput {
  /** Host name only. Defaults to `jetstream.us-east.bsky.network` (v2). */
  readonly host?: string;
  /** Jetstream protocol version. v2 is recommended; v1 is the legacy `/subscribe` API. */
  readonly version?: 1 | 2;
  /** Up to 100 collection NSIDs or `app.bsky.feed.*` namespace wildcards. */
  readonly collections?: readonly string[];
  /** Up to 10,000 repository DIDs. */
  readonly dids?: readonly string[];
  /** v2 only: event kinds to receive. Omit for all four. */
  readonly kinds?: readonly JetstreamKind[];
  /** v2: the last `seq` processed (inclusive) or a unix-microsecond time. v1: `time_us`. */
  readonly cursor?: number;
}

/** The WebSocket URL and subprotocols to open; the SDK does not open the socket. */
export interface BlueskyJetstreamSubscription {
  readonly url: URL;
  readonly protocols: readonly string[];
}

/**
 * Builds a Jetstream WebSocket subscription. Jetstream decodes the relay firehose
 * (`com.atproto.sync.subscribeRepos`) into JSON and filters it server-side. Open the socket
 * with your runtime's WebSocket, then decode each frame with `parseBlueskyJetstreamEvent`.
 */
export function blueskyJetstreamSubscription(
  input: BlueskyJetstreamInput = {},
): BlueskyJetstreamSubscription {
  const version = input.version ?? 2;

  const host =
    input.host ??
    (version === 2 ? "jetstream.us-east.bsky.network" : "jetstream2.us-east.bsky.network");

  const collections = input.collections ?? [];

  const dids = input.dids ?? [];

  const invalid = (message: string): never => {
    throw new SocialError({
      code: "invalid_input",
      operation: "bluesky.jetstream.subscribe",
      message,
      retryDisposition: { kind: "never" },
    });
  };

  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) invalid("Jetstream host must be a host name.");

  if (
    collections.length > 100 ||
    collections.some((nsid) => !/^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+)+(\.\*)?$/.test(nsid))
  )
    invalid("Jetstream accepts up to 100 collection NSIDs or namespace wildcards.");

  if (dids.length > 10_000 || dids.some((did) => !/^did:[a-z]+:[A-Za-z0-9._:%-]+$/.test(did)))
    invalid("Jetstream accepts up to 10,000 DIDs.");

  if (input.cursor !== undefined && (!Number.isSafeInteger(input.cursor) || input.cursor < 0))
    invalid("Jetstream cursor must be a non-negative integer.");

  if (version === 1 && input.kinds !== undefined)
    invalid("Jetstream v1 has no kinds filter; use version 2.");

  const v2 = version === 2;

  const url = new URL(
    v2 ? `wss://${host}/xrpc/network.bsky.jetstream.subscribeEvents` : `wss://${host}/subscribe`,
  );

  for (const nsid of collections)
    url.searchParams.append(v2 ? "collections" : "wantedCollections", nsid);

  for (const did of dids) url.searchParams.append(v2 ? "dids" : "wantedDids", did);

  for (const kind of input.kinds ?? []) url.searchParams.append("kinds", kind);

  if (input.cursor !== undefined) url.searchParams.set("cursor", String(input.cursor));

  return { url, protocols: v2 ? ["xrpc.v1.json"] : [] };
}

/** A decoded Jetstream event. Commits carry the record already decoded from CBOR. */
export type BlueskyJetstreamEvent =
  | {
      readonly kind: "commit";
      readonly did: string;
      /** v2 sequence number; pass the last one back as `cursor` to resume. */
      readonly seq?: number;
      /** v1 unix-microsecond timestamp. */
      readonly timeUs?: number;
      readonly operation: "create" | "update" | "delete";
      readonly collection: string;
      readonly rkey: string;
      /** `at://<did>/<collection>/<rkey>`: a stable key for idempotent handling. */
      readonly uri: string;
      readonly rev?: string;
      readonly cid?: string;
      /** Absent on deletes. */
      readonly record?: JsonObject;
    }
  | {
      readonly kind: "identity" | "account" | "sync";
      readonly did: string;
      readonly seq?: number;
      readonly timeUs?: number;
      readonly payload: JsonObject;
    };

function isJetstreamKind(value: JsonValue | undefined): value is JetstreamKind {
  return value === "commit" || value === "identity" || value === "account" || value === "sync";
}

function isCommitOperation(value: JsonValue | undefined): value is "create" | "update" | "delete" {
  return value === "create" || value === "update" || value === "delete";
}

/**
 * Decodes one Jetstream text frame (v2 envelope or v1 event). Returns `undefined` for frames
 * that are not events, such as v2 info messages. Delivery is at-least-once: key on `uri`.
 */
export function parseBlueskyJetstreamEvent(frame: string): BlueskyJetstreamEvent | undefined {
  const malformed = (): never => {
    throw new SocialError({
      code: "upstream_failure",
      operation: "bluesky.jetstream.event",
      message: "Jetstream sent a malformed event.",
      retryDisposition: { kind: "never" },
    });
  };

  let message: JsonObject;

  try {
    message = object(parseJson(frame));
  } catch {
    return malformed();
  }

  // v2 frames wrap the event in { $type: "message", payload: { $type: "...#commit", ... } }.
  const v2 = message["$type"] !== undefined;

  if (v2 && message["$type"] !== "message") return undefined;

  const event = v2 ? optionalObject(message["payload"]) : message;

  if (event === undefined) return malformed();

  const kind = v2
    ? optionalString(event["$type"])?.replace("network.bsky.jetstream.subscribeEvents#", "")
    : event["kind"];

  if (kind === undefined || !isJetstreamKind(kind)) return undefined;

  const did = optionalString(event["did"]);

  if (did === undefined) return malformed();

  const position = definedFields({
    seq: optionalNumber(event["seq"]),
    timeUs: optionalNumber(event["time_us"]),
  });

  if (kind !== "commit") {
    const payload = v2 ? event : optionalObject(event[kind]);

    return payload === undefined ? malformed() : { kind, did, ...position, payload };
  }

  const commit = v2 ? event : optionalObject(event["commit"]);

  if (commit === undefined) return malformed();

  const operation = commit["operation"];

  const collection = optionalString(commit["collection"]);

  const rkey = optionalString(commit["rkey"]);

  if (!isCommitOperation(operation) || collection === undefined || rkey === undefined)
    return malformed();

  return {
    kind,
    did,
    ...position,
    operation,
    collection,
    rkey,
    uri: `at://${did}/${collection}/${rkey}`,
    ...definedFields({
      rev: optionalString(commit["rev"]),
      cid: optionalString(commit["cid"]),
      record: optionalObject(commit["record"]),
    }),
  };
}

const FEED_GENERATOR_URI =
  /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/app\.bsky\.feed\.generator\/[A-Za-z0-9._~:-]{1,512}$/;

function feedServerError(message: string): never {
  throw new SocialError({
    code: "invalid_input",
    operation: "bluesky.feeds.server",
    message,
    retryDisposition: { kind: "never" },
  });
}

/** What a feed generator service reports from `app.bsky.feed.describeFeedGenerator`. */
export interface BlueskyFeedGeneratorDescriptionInput {
  /** The service DID that every published `app.bsky.feed.generator` record names. */
  readonly did: string;
  /** AT-URIs of the `app.bsky.feed.generator` records this service serves. */
  readonly feeds: readonly string[];
  readonly links?: { readonly privacyPolicy?: string; readonly termsOfService?: string };
}

/**
 * Builds the JSON body a feed generator returns from
 * `GET /xrpc/app.bsky.feed.describeFeedGenerator`. The SDK runs no server; return this from
 * your own route.
 */
export function blueskyFeedGeneratorDescription(
  input: BlueskyFeedGeneratorDescriptionInput,
): JsonObject {
  if (!DID.test(input.did)) feedServerError("The feed generator DID is invalid.");

  if (input.feeds.some((feed) => !FEED_GENERATOR_URI.test(feed)))
    feedServerError("Each feed must be an app.bsky.feed.generator AT-URI.");

  const links = definedFields({
    privacyPolicy: input.links?.privacyPolicy,
    termsOfService: input.links?.termsOfService,
  });

  return {
    did: input.did,
    feeds: input.feeds.map((uri) => ({ uri })),
    ...definedFields({ links: Object.keys(links).length ? links : undefined }),
  };
}

/** A validated `app.bsky.feed.getFeedSkeleton` request. */
export interface BlueskyFeedSkeletonRequest {
  readonly feed: string;
  /** 1 to 100; Bluesky's default is 50. */
  readonly limit: number;
  readonly cursor?: string;
}

/**
 * Parses the query of `GET /xrpc/app.bsky.feed.getFeedSkeleton`. It does not verify the
 * requester's service-auth JWT (`Authorization: Bearer`); verify it yourself when the feed is
 * personalized.
 */
export function parseBlueskyFeedSkeletonRequest(url: URL): BlueskyFeedSkeletonRequest {
  if (blueskyFeedGeneratorMethod(url) !== "app.bsky.feed.getFeedSkeleton")
    feedServerError("Not a getFeedSkeleton request.");

  const feed = url.searchParams.get("feed") ?? "";

  if (!FEED_GENERATOR_URI.test(feed)) feedServerError("feed must be a feed generator AT-URI.");

  const rawLimit = url.searchParams.get("limit");

  const limit = rawLimit === null ? 50 : Number(rawLimit);

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    feedServerError("limit must be an integer from 1 to 100.");

  const cursor = url.searchParams.get("cursor");

  return { feed, limit, ...definedFields({ cursor: cursor || undefined }) };
}

/** One post in a feed skeleton (`app.bsky.feed.defs#skeletonFeedPost`). */
export interface BlueskySkeletonItem {
  readonly post: string;
  /** Show the post as reposted by this repost record, or as pinned. */
  readonly reason?: { readonly repost: string } | "pin";
  /** Opaque context (up to 2000 characters) the client echoes back in sendInteractions. */
  readonly feedContext?: string;
}

/** Builds the `app.bsky.feed.getFeedSkeleton` response body. */
export function blueskyFeedSkeleton(input: {
  readonly feed: readonly BlueskySkeletonItem[];
  readonly cursor?: string;
  /** Request ID (up to 100 characters) the client echoes back in sendInteractions. */
  readonly reqId?: string;
}): JsonObject {
  if ((input.reqId?.length ?? 0) > 100) feedServerError("reqId is limited to 100 characters.");

  return {
    feed: input.feed.map((item) => {
      if (!POST_URI.test(item.post)) feedServerError("Each skeleton post must be a post AT-URI.");

      if ((item.feedContext?.length ?? 0) > 2000)
        feedServerError("feedContext is limited to 2000 characters.");

      if (
        item.reason !== undefined &&
        item.reason !== "pin" &&
        !REPOST_URI.test(item.reason.repost)
      )
        feedServerError("A repost reason needs an app.bsky.feed.repost AT-URI.");

      const reason =
        item.reason === undefined
          ? undefined
          : item.reason === "pin"
            ? { $type: "app.bsky.feed.defs#skeletonReasonPin" }
            : { $type: "app.bsky.feed.defs#skeletonReasonRepost", repost: item.reason.repost };

      return { post: item.post, ...definedFields({ reason, feedContext: item.feedContext }) };
    }),
    ...definedFields({ cursor: input.cursor, reqId: input.reqId }),
  };
}

/** The XRPC methods a feed generator serves. */
export type BlueskyFeedGeneratorMethod =
  | "app.bsky.feed.describeFeedGenerator"
  | "app.bsky.feed.getFeedSkeleton";

/**
 * Says which feed generator method a request path names, so one route can serve both
 * `app.bsky.feed.describeFeedGenerator` and `app.bsky.feed.getFeedSkeleton`. Other paths return
 * `undefined`; answer them with 404.
 */
export function blueskyFeedGeneratorMethod(url: URL): BlueskyFeedGeneratorMethod | undefined {
  if (url.pathname === "/xrpc/app.bsky.feed.describeFeedGenerator")
    return "app.bsky.feed.describeFeedGenerator";

  if (url.pathname === "/xrpc/app.bsky.feed.getFeedSkeleton")
    return "app.bsky.feed.getFeedSkeleton";

  return undefined;
}

/** A label from a labeler's stream (`com.atproto.label.defs#label`). */
export interface BlueskyStreamLabel {
  readonly src: string;
  readonly uri: string;
  readonly cid?: string;
  readonly val: string;
  /** True when the label negates (removes) an earlier one. */
  readonly neg?: boolean;
  readonly cts: string;
  readonly exp?: string;
  readonly ver?: number;
  /** The labeler's signature over the label. The SDK does not verify it. */
  readonly sig?: Uint8Array;
}

export type BlueskyLabelStreamEvent =
  | {
      readonly kind: "labels";
      readonly seq: number;
      readonly labels: readonly BlueskyStreamLabel[];
    }
  | { readonly kind: "info"; readonly name: string; readonly message?: string }
  | { readonly kind: "error"; readonly error: string; readonly message?: string };

/**
 * Builds the WebSocket URL for a labeler's `com.atproto.label.subscribeLabels` stream. The SDK
 * opens no socket. Pass the last `seq` you processed as `cursor` to replay from there.
 */
export function blueskyLabelStreamUrl(input: {
  /** The labeler service endpoint from its DID document, for example `https://mod.example`. */
  readonly service: string;
  readonly cursor?: number;
}): URL {
  const url = endpoint(input.service, "com.atproto.label.subscribeLabels");

  url.protocol = "wss:";

  if (input.cursor !== undefined) {
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0)
      throw new SocialError({
        code: "invalid_input",
        operation: "bluesky.labels.stream",
        message: "cursor must be a non-negative integer sequence number.",
        retryDisposition: { kind: "never" },
      });

    url.searchParams.set("cursor", String(input.cursor));
  }

  return url;
}

/** A CID link (DAG-CBOR tag 42). */
class CborLink {
  constructor(readonly bytes: Uint8Array) {}
}

type CborValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | CborLink
  | readonly CborValue[]
  | { readonly [key: string]: CborValue };

function cborFail(): never {
  throw new SocialError({
    code: "upstream_failure",
    operation: "bluesky.labels.stream",
    message: "The label stream frame is not valid DAG-CBOR.",
  });
}

interface CborDecoded {
  readonly value: CborValue;
  readonly next: number;
}

function isCborString(value: CborValue | undefined): value is string {
  return typeof value === "string";
}

function isCborNumber(value: CborValue | undefined): value is number {
  return typeof value === "number";
}

function isCborBoolean(value: CborValue | undefined): value is boolean {
  return typeof value === "boolean";
}

/** Decodes one DAG-CBOR item starting at `offset`. Indefinite lengths are rejected. */
function cborItem(bytes: Uint8Array, offset: number): CborDecoded {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (offset >= bytes.byteLength) cborFail();

  const initial = bytes[offset] ?? cborFail();

  const major = initial >> 5;

  const info = initial & 0x1f;

  let position = offset + 1;

  const need = (count: number) => {
    if (position + count > bytes.byteLength) cborFail();
  };

  let argument: number;

  if (info < 24) argument = info;
  else if (info === 24) {
    need(1);
    argument = view.getUint8(position);
    position += 1;
  } else if (info === 25) {
    need(2);
    argument = view.getUint16(position);
    position += 2;
  } else if (info === 26) {
    need(4);
    argument = view.getUint32(position);
    position += 4;
  } else if (info === 27) {
    need(8);

    const big = view.getBigUint64(position);

    if (major !== 7 && big > BigInt(Number.MAX_SAFE_INTEGER)) cborFail();
    argument = major === 7 ? 0 : Number(big);
    position += 8;
  } else cborFail();

  switch (major) {
    case 0:
      return { value: argument, next: position };
    case 1:
      return { value: -1 - argument, next: position };
    case 2:
      need(argument);

      return { value: bytes.slice(position, position + argument), next: position + argument };
    case 3: {
      need(argument);

      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(position, position + argument),
      );

      return { value: text, next: position + argument };
    }

    case 4: {
      const items: CborValue[] = [];

      for (let index = 0; index < argument; index++) {
        const item = cborItem(bytes, position);
        items.push(item.value);
        position = item.next;
      }

      return { value: items, next: position };
    }

    case 5: {
      const entries: Record<string, CborValue> = {};

      for (let index = 0; index < argument; index++) {
        const key = cborItem(bytes, position);

        if (!isCborString(key.value)) cborFail();

        const item = cborItem(bytes, key.next);
        entries[key.value] = item.value;
        position = item.next;
      }

      return { value: entries, next: position };
    }

    case 6: {
      const tagged = cborItem(bytes, position);

      if (argument !== 42 || !(tagged.value instanceof Uint8Array)) cborFail();

      return { value: new CborLink(tagged.value), next: tagged.next };
    }

    default:
      if (info === 20) return { value: false, next: position };

      if (info === 21) return { value: true, next: position };

      if (info === 22) return { value: null, next: position };

      if (info === 27) return { value: view.getFloat64(offset + 1), next: position };

      return cborFail();
  }
}

function isCborMap(value: CborValue | undefined): value is { readonly [key: string]: CborValue } {
  return (
    value !== undefined &&
    value !== null &&
    !isCborString(value) &&
    !isCborNumber(value) &&
    !isCborBoolean(value) &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof CborLink)
  );
}

function cborText(map: { readonly [key: string]: CborValue }, key: string): string | undefined {
  const value = map[key];

  return isCborString(value) ? value : undefined;
}

function streamLabel(value: CborValue): BlueskyStreamLabel {
  if (!isCborMap(value)) cborFail();

  const src = cborText(value, "src"),
    uri = cborText(value, "uri"),
    val = cborText(value, "val"),
    cts = cborText(value, "cts");

  if (src === undefined || uri === undefined || val === undefined || cts === undefined) cborFail();

  const neg = value["neg"],
    ver = value["ver"],
    sig = value["sig"];

  return {
    src,
    uri,
    val,
    cts,
    ...definedFields({
      cid: cborText(value, "cid"),
      exp: cborText(value, "exp"),
      neg: isCborBoolean(neg) ? neg : undefined,
      ver: isCborNumber(ver) ? ver : undefined,
      sig: sig instanceof Uint8Array ? sig : undefined,
    }),
  };
}

/**
 * Decodes one binary frame from `com.atproto.label.subscribeLabels`: a DAG-CBOR header
 * (`op`, `t`) followed by the body. Returns `undefined` for message types this version does not
 * know, so new event types can be skipped.
 */
export function parseBlueskyLabelFrame(frame: Uint8Array): BlueskyLabelStreamEvent | undefined {
  const header = cborItem(frame, 0);

  const body = cborItem(frame, header.next);

  if (body.next !== frame.byteLength || !isCborMap(header.value) || !isCborMap(body.value))
    cborFail();

  const op = header.value["op"];

  if (op === -1)
    return {
      kind: "error",
      error: cborText(body.value, "error") ?? "Unknown",
      ...definedFields({ message: cborText(body.value, "message") }),
    };

  if (op !== 1) cborFail();

  const type = cborText(header.value, "t");

  if (type === "#labels") {
    const seq = body.value["seq"],
      labels = body.value["labels"];

    if (!isCborNumber(seq) || !Array.isArray(labels)) cborFail();

    return { kind: "labels", seq, labels: labels.map(streamLabel) };
  }

  if (type === "#info")
    return {
      kind: "info",
      name: cborText(body.value, "name") ?? cborFail(),
      ...definedFields({ message: cborText(body.value, "message") }),
    };

  return undefined;
}
