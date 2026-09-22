export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type KnownPlatform =
  | "bluesky"
  | "facebook"
  | "instagram"
  | "linkedin"
  | "threads"
  | "tiktok"
  | "x"
  | "youtube";

export type Platform = KnownPlatform | (string & {});

interface ReferenceBase<K extends string> {
  readonly kind: K;
  readonly version: 1;
  readonly backend: string;
}

export interface ConnectedAccountRef<
  P extends Platform = Platform,
> extends ReferenceBase<"connected-account"> {
  readonly platform: P;
  readonly accountId: string;
}

export interface PublicationRef extends ReferenceBase<"publication"> {
  readonly publicationId: string;
}

export interface DeliveryRef extends ReferenceBase<"delivery"> {
  readonly deliveryId: string;
  readonly platform: Platform;
  readonly accountId: string;
}

export interface PlatformPostRef<
  P extends Platform = Platform,
> extends ReferenceBase<"platform-post"> {
  readonly platform: P;
  readonly accountId: string;
  readonly postId: string;
  /** Provider-native identifiers such as Bluesky's AT-URI/CID, when available. */
  readonly native?: JsonObject;
}

export interface BlueskyPlatformPostRef extends PlatformPostRef<"bluesky"> {
  readonly native: { readonly uri: string; readonly cid: string };
}

export interface ScheduledJobRef extends ReferenceBase<"scheduled-job"> {
  readonly jobId: string;
  readonly platform: Platform;
  readonly accountId: string;
}

/** Provider record identity; never a native platform post ID. */
export interface BackendPostRef extends ReferenceBase<"backend-post"> {
  readonly recordId: string;
  readonly platform: Platform;
  readonly accountId: string;
}

export interface ScheduleCancellation {
  readonly state: "cancelled";
  readonly backendRecord: "retained" | "deleted";
}

export interface MediaRef extends ReferenceBase<"media"> {
  readonly mediaId: string;
  readonly platform: Platform;
  readonly accountId: string;
}

export interface CommentRef extends ReferenceBase<"comment"> {
  readonly platform: Platform;
  readonly accountId: string;
  readonly postId: string;
  readonly commentId: string;
}

export interface ConversationRef extends ReferenceBase<"conversation"> {
  readonly platform: Platform;
  readonly accountId: string;
  readonly conversationId: string;
}

export type SocialRef =
  | ConnectedAccountRef
  | PublicationRef
  | DeliveryRef
  | PlatformPostRef
  | ScheduledJobRef
  | BackendPostRef
  | MediaRef
  | CommentRef
  | ConversationRef;

export function connectedAccountRef<P extends Platform>(input: {
  backend: string;
  platform: P;
  accountId: string;
}): ConnectedAccountRef<P> {
  return { kind: "connected-account", version: 1, ...input };
}

export function platformPostRef<P extends Platform>(input: {
  backend: string;
  platform: P;
  accountId: string;
  postId: string;
}): PlatformPostRef<P> {
  return { kind: "platform-post", version: 1, ...input };
}

export type MediaInput =
  | { readonly kind: "https-url"; readonly url: string }
  | { readonly kind: "media-ref"; readonly ref: MediaRef }
  | {
      readonly kind: "blob";
      readonly blob: Blob;
      readonly fingerprint: string;
    }
  | {
      readonly kind: "stream";
      readonly open: () => ReadableStream<Uint8Array>;
      readonly fingerprint: string;
    };

export interface MediaAttachment {
  readonly kind: "image" | "video";
  readonly source: MediaInput;
  readonly mimeType?: string;
  readonly filename?: string;
  readonly byteSize?: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly altText?: string;
  readonly caption?: string;
  readonly thumbnail?: MediaInput;
}

export interface LinkMetadata {
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
}

export interface PublishContent {
  readonly text?: string;
  readonly media?: readonly MediaAttachment[];
  readonly link?: LinkMetadata;
}

export interface TargetContentOverride {
  readonly text?: string;
  readonly media?: readonly MediaAttachment[];
  readonly link?: LinkMetadata;
}

export interface XPublishOptions {
  readonly replySettings?: "everyone" | "following" | "mentionedUsers";
}

export interface BlueskyPublishOptions {
  readonly languages?: readonly string[];
  /** Explicit DID mentions using UTF-8 byte offsets; no implicit handle lookup. */
  readonly mentions?: readonly {
    readonly byteStart: number;
    readonly byteEnd: number;
    readonly did: string;
  }[];
}

export interface ThreadsPublishOptions {
  readonly replyControl?: "everyone" | "accountsYouFollow" | "mentionedOnly";
}

export interface YouTubePublishOptions {
  readonly title: string;
  readonly visibility: "private" | "unlisted" | "public";
  readonly madeForKids: boolean;
}

export interface TikTokPublishOptions {
  readonly privacy:
    | "SELF_ONLY"
    | "MUTUAL_FOLLOW_FRIENDS"
    | "FOLLOWER_OF_CREATOR"
    | "PUBLIC_TO_EVERYONE";
  readonly disableComments?: boolean;
  readonly disableDuet?: boolean;
  readonly disableStitch?: boolean;
  readonly brandedContent?: boolean;
  readonly ownBrand?: boolean;
  readonly aiGenerated?: boolean;
  readonly draft?: boolean;
  readonly photoCoverIndex?: number;
  readonly title?: string;
  readonly consentGiven: boolean;
  readonly creatorInfo?: JsonObject;
}

export interface InstagramPublishOptions {
  readonly shareToFeed?: boolean;
}

export interface LinkedInPublishOptions {
  readonly visibility?: "connections" | "public";
}

export type PublishOptionsFor<P extends Platform> = P extends "x"
  ? XPublishOptions
  : P extends "bluesky"
    ? BlueskyPublishOptions
    : P extends "threads"
      ? ThreadsPublishOptions
      : P extends "youtube"
        ? YouTubePublishOptions
        : P extends "tiktok"
          ? TikTokPublishOptions
          : P extends "instagram"
            ? InstagramPublishOptions
            : P extends "linkedin"
              ? LinkedInPublishOptions
              : JsonObject;

export interface PublishTarget<P extends Platform = Platform> {
  readonly account: ConnectedAccountRef<P>;
  readonly content?: TargetContentOverride;
  readonly replyTo?: CommentRef | PlatformPostRef;
  readonly options?: PublishOptionsFor<P>;
}

export interface PublishRequest {
  readonly targets: readonly PublishTarget[];
  readonly content: PublishContent;
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
  readonly schedule?: { readonly at: string; readonly timeZone?: string };
  readonly replyTo?: CommentRef | PlatformPostRef;
}

/** Preserve the relationship between each literal platform and its options. */
export type CheckedPublishTargets<T extends readonly PublishTarget[]> = {
  readonly [K in keyof T]: Omit<T[K], "options"> & {
    readonly options?: PublishOptionsFor<T[K]["account"]["platform"]>;
  };
};

export type CheckedPublishRequest<T extends PublishRequest> = T & {
  readonly targets: CheckedPublishTargets<NoInfer<T["targets"]>>;
};

export interface PublishSequenceRequest {
  readonly items: readonly {
    readonly targets: readonly PublishTarget[];
    readonly content: PublishContent;
    readonly replyTo?: CommentRef | PlatformPostRef;
  }[];
  readonly idempotencyKey: string;
  readonly stopOnFailure?: boolean;
}

export interface PublishSequenceResult {
  readonly status: PublicationStatus;
  readonly items: readonly PublishResult[];
}

export interface PreparedPublishTarget {
  readonly targetIndex: number;
  readonly targetKey: string;
  readonly account: ConnectedAccountRef;
  readonly content: PublishContent;
  readonly options?: unknown;
  readonly schedule?: PublishRequest["schedule"];
  readonly replyTo?: PublishRequest["replyTo"];
}

export interface PreparationIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly targetIndex?: number;
  readonly severity: "error" | "warning";
}

export interface PublishPreparation {
  readonly ok: boolean;
  readonly targets: readonly PreparedPublishTarget[];
  readonly issues: readonly PreparationIssue[];
}

interface OutcomeBase<S extends string> {
  readonly state: S;
  readonly targetIndex: number;
  readonly account: ConnectedAccountRef;
  readonly delivery?: DeliveryRef;
  readonly backendState?: string;
  readonly observedAt: string;
}

export type DeliveryOutcome =
  | (OutcomeBase<"not-submitted"> & {
      readonly reason: "validation" | "unauthorized" | "idempotency-conflict" | "capacity";
      readonly issues?: readonly PreparationIssue[];
    })
  | (OutcomeBase<"scheduled"> & { readonly job: ScheduledJobRef })
  | OutcomeBase<"accepted">
  | OutcomeBase<"processing">
  | (OutcomeBase<"published"> & {
      readonly post: PlatformPostRef;
      readonly url?: string;
    })
  | (OutcomeBase<"failed"> & {
      readonly code: string;
      readonly message: string;
      readonly retryDisposition: RetryDisposition;
    })
  | (OutcomeBase<"cancelled"> & { readonly reason?: string })
  | (OutcomeBase<"unknown"> & {
      readonly reason: "ambiguous-submission" | "unmapped-state";
      readonly diagnostic?: string;
    });

export type PublicationStatus = "pending" | "complete" | "partial";

export interface PublishResult {
  readonly status: PublicationStatus;
  readonly publication: PublicationRef;
  readonly outcomes: readonly DeliveryOutcome[];
}

export type RetryDisposition =
  | { readonly kind: "never" }
  | { readonly kind: "after-delay"; readonly delayMs: number }
  | { readonly kind: "after-reconnect" }
  | { readonly kind: "reconcile-first" };

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly metadata?: JsonObject;
}

export interface MetricValue {
  readonly name: string;
  readonly value: number;
  readonly unit: "count" | "milliseconds" | "percentage" | "seconds";
  readonly period: "lifetime" | "unknown" | { readonly from: string; readonly to: string };
  readonly measuredAt?: string;
  readonly fetchedAt?: string;
  readonly freshness?: "reported" | "unknown";
  readonly source: string;
}

export type CapabilityAvailability =
  | "available"
  | "unsupported-by-platform"
  | "not-implemented-by-adapter"
  | "permission-required"
  | "reconnect-required"
  | "account-ineligible"
  | "runtime-unavailable"
  | "approval-dependent"
  | "unknown-until-request";

export interface CapabilityDeclaration {
  readonly operation: string;
  readonly platform: Platform | "*";
  readonly availability: CapabilityAvailability;
  readonly formats?: readonly ("text" | "image" | "video" | "carousel" | "sequence")[];
  readonly requiredScopes?: readonly string[];
  readonly notes?: string;
}

export interface CapabilityManifest {
  readonly schemaVersion: 1;
  readonly backend: string;
  readonly apiRevision: string;
  readonly runtime: readonly string[];
  readonly capabilities: readonly CapabilityDeclaration[];
}

export interface AccountRecord {
  readonly ref: ConnectedAccountRef;
  readonly displayName: string;
  readonly handle?: string;
  readonly status: "connected" | "reconnect-required" | "revoked" | "unknown";
}

export interface AuthorizationContext {
  readonly tenantId?: string;
  readonly principalId?: string;
  readonly attributes?: JsonObject;
}

export interface RetryBudget {
  readonly maxAttempts: number;
  readonly maxElapsedMs: number;
}

export interface OperationContext {
  readonly signal?: AbortSignal;
  readonly correlationId: string;
  readonly authorization?: AuthorizationContext;
  readonly retryBudget: RetryBudget;
  readonly idempotencyKey?: string;
}

export interface AdapterOperationContext extends OperationContext {
  readonly backendInstance: string;
  readonly targetIdempotencyKey?: string;
}

export type OperationName =
  | "posts.publish"
  | "accounts.read"
  | "posts.read"
  | "analytics.read"
  | "comments.read"
  | "comments.write"
  | "messages.read"
  | "messages.write"
  | "posts.cancelScheduled"
  | "posts.deleteBackendRecord"
  | "posts.removeFromPlatform"
  | "webhooks.verify"
  | "native";
