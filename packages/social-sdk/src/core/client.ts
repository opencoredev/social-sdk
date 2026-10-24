import { decodeCursor, encodeCursor, iterateItems, type IterationOptions } from "./pagination.js";
import { createConcurrencyLimiter } from "./concurrency.js";
import type { AuthorizationPolicy, GraphAdapter, SocialAdapter } from "./adapter.js";
import { SocialError, type SocialErrorCode } from "./errors.js";
import { definedFields } from "./fields.js";
import { isString } from "../transport/validation.js";
import { httpsUrl } from "../transport/upload.js";
import type { MediaStagingProvider } from "./media.js";
import {
  DEFAULT_STAGING_ORIGIN,
  mediaConstraintIssues,
  needsStaging,
  selectPublishDeclaration,
  withStagingPlaceholders,
} from "./media-validation.js";
import {
  normalizeComment,
  normalizeConversation,
  normalizeMessage,
  normalizeMetrics,
  type CommentRecord,
  type ConversationRecord,
  type MessageRecord,
} from "./projections.js";
import { releaseLeases, stageContent, type StagingLease } from "./staging.js";
import {
  deriveTargetIdempotencyKey,
  fingerprint,
  type IdempotencyClaim,
  type IdempotencyStore,
} from "./idempotency.js";
import type {
  AdapterOperationContext,
  AuthorizationContext,
  ConnectedAccountRef,
  AccountRecord,
  AnalyticsReport,
  AnalyticsReportQuery,
  BackendPostRef,
  ScheduledJobRef,
  ScheduleCancellation,
  CommentRef,
  ConversationRef,
  DeliveryOutcome,
  PreparationIssue,
  PreparedPublishTarget,
  PublicationRef,
  PublicationStatus,
  PublishContent,
  PublishPreparation,
  PublishRequest,
  PublishResult,
  PublishSequenceRequest,
  PublishSequenceResult,
  Page,
  PlatformPostRef,
  MediaAttachment,
  MediaRef,
  JsonObject,
  MetricValue,
  RetryBudget,
  CheckedPublishRequest,
  SearchPostsInput,
  ProfileRecord,
  ProfileRef,
  RelationshipRecord,
  RetryDisposition,
} from "./types.js";

export type BackendRegistry = Readonly<Record<string, SocialAdapter<unknown>>>;

export interface PublishCallOptions {
  readonly signal?: AbortSignal;
  readonly authorization?: AuthorizationContext;
  readonly retryBudget?: RetryBudget;
}

/** One place `inbox.list` reads from. */
export type InboxSource =
  | { readonly kind: "conversations"; readonly account: ConnectedAccountRef }
  | { readonly kind: "comments"; readonly post: PlatformPostRef };

/**
 * Sources for one inbox read. Conversations are read per account. Comments are
 * read per post because providers expose them per post, not per account.
 */
export interface InboxListInput {
  /** Accounts whose direct-message conversations to read. */
  readonly accounts?: readonly ConnectedAccountRef[];
  /** Posts whose comments to read. */
  readonly posts?: readonly PlatformPostRef[];
  /** Page size requested from each source, 1 through 100. Defaults to 20. */
  readonly limit?: number;
  /** `nextCursor` from a previous call with the same accounts, posts, order, limit and tenant. */
  readonly cursor?: string;
}

export type InboxEntry =
  | {
      readonly kind: "conversation";
      /** Position of the source in `InboxPage.sources`. */
      readonly sourceIndex: number;
      readonly account: ConnectedAccountRef;
      readonly record: ConversationRecord;
    }
  | {
      readonly kind: "comment";
      readonly sourceIndex: number;
      readonly post: PlatformPostRef;
      readonly record: CommentRecord;
    };

export type InboxSourceOutcome =
  | {
      readonly state: "read";
      readonly source: InboxSource;
      readonly itemCount: number;
      /** False when this page was the source's last. */
      readonly hasMore: boolean;
    }
  /** Finished on an earlier page; reauthorized but not read again. */
  | { readonly state: "exhausted"; readonly source: InboxSource }
  /** The source keeps its position, so the next call with `nextCursor` retries it. */
  | {
      readonly state: "failed";
      readonly source: InboxSource;
      readonly code: SocialErrorCode;
      readonly message: string;
      readonly retryDisposition: RetryDisposition;
    };

export interface InboxPage {
  /** Every item from each source's page, grouped by source in `sources` order. Never truncated or re-sorted. */
  readonly entries: readonly InboxEntry[];
  /** One outcome per source: accounts in input order, then posts in input order. */
  readonly sources: readonly InboxSourceOutcome[];
  /** Absent once every source is exhausted. Present while any source has more pages or failed. */
  readonly nextCursor?: string;
}

/** Per-source cursor state: `null` not yet read, `false` exhausted, a string resumes the source. */
type InboxSourceState = null | false | string;

// At most 50 raw provider cursors, each capped at 16 KiB by the source facade.
// JSON escaping can expand a code unit sixfold; URI escaping is bounded too.
const inboxCursorLimits = { maxValueLength: 5_000_000, maxEncodedLength: 12_000_000 };

function inboxSourceScope(
  source: InboxSource,
  tenantId: string | null,
  limit: number | null,
): string {
  const ref = source.kind === "comments" ? source.post : source.account;

  return JSON.stringify([
    ref.backend,
    source.kind === "comments" ? "comments.read" : "messages.read",
    tenantId,
    ref.platform,
    ref.accountId,
    source.kind === "comments" ? source.post.postId : "conversations",
    limit,
  ]);
}

function isInboxState(value: unknown): value is readonly InboxSourceState[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry === null ||
        entry === false ||
        (isString(entry) && entry.length > 0 && entry.length <= 16_384),
    )
  );
}

export interface SocialClient<B extends BackendRegistry = BackendRegistry> {
  readonly accounts: {
    list(
      options?: PublishCallOptions & {
        readonly backend?: string;
        readonly cursor?: string;
        readonly limit?: number;
      },
    ): Promise<Page<AccountRecord>>;
    get(ref: ConnectedAccountRef, options?: PublishCallOptions): Promise<AccountRecord>;
    iterate(
      options?: PublishCallOptions &
        IterationOptions & { readonly backend?: string; readonly limit?: number },
    ): AsyncIterable<AccountRecord>;
  };
  readonly graph: {
    getProfile(
      account: ConnectedAccountRef,
      input: { readonly profileId?: string; readonly handle?: string },
      options?: PublishCallOptions,
    ): Promise<ProfileRecord>;
    listRelationships(
      account: ConnectedAccountRef,
      input: {
        readonly kind: "following" | "followers" | "blocked" | "muted";
        readonly cursor?: string;
        readonly limit?: number;
      },
      options?: PublishCallOptions,
    ): Promise<Page<RelationshipRecord>>;
    follow(target: ProfileRef, options?: PublishCallOptions): Promise<RelationshipRecord>;
    unfollow(target: ProfileRef, options?: PublishCallOptions): Promise<void>;
    block(target: ProfileRef, options?: PublishCallOptions): Promise<RelationshipRecord>;
    unblock(target: ProfileRef, options?: PublishCallOptions): Promise<void>;
    mute(target: ProfileRef, options?: PublishCallOptions): Promise<RelationshipRecord>;
    unmute(target: ProfileRef, options?: PublishCallOptions): Promise<void>;
  };
  readonly posts: {
    list(
      account: ConnectedAccountRef,
      options?: PublishCallOptions & { readonly cursor?: string; readonly limit?: number },
    ): Promise<Page<JsonObject>>;
    iterate(
      account: ConnectedAccountRef,
      options?: PublishCallOptions & IterationOptions & { readonly limit?: number },
    ): AsyncIterable<JsonObject>;
    prepare<const T extends PublishRequest>(request: CheckedPublishRequest<T>): PublishPreparation;
    publish<const T extends PublishRequest>(
      request: CheckedPublishRequest<T>,
      options?: PublishCallOptions,
    ): Promise<PublishResult>;
    publishSequence(
      request: PublishSequenceRequest,
      options?: PublishCallOptions,
    ): Promise<PublishSequenceResult>;
    get(ref: PlatformPostRef, options?: PublishCallOptions): Promise<JsonObject>;
    cancelScheduled(
      ref: ScheduledJobRef,
      options?: PublishCallOptions,
    ): Promise<ScheduleCancellation>;
    deleteBackendRecord(ref: BackendPostRef, options?: PublishCallOptions): Promise<void>;
    removeFromPlatform(ref: PlatformPostRef, options?: PublishCallOptions): Promise<void>;
    getDelivery(
      ref: import("./types.js").DeliveryRef,
      options?: PublishCallOptions,
    ): Promise<DeliveryOutcome>;
  };
  readonly search: {
    posts(
      account: ConnectedAccountRef,
      input: SearchPostsInput,
      options?: PublishCallOptions,
    ): Promise<Page<JsonObject>>;
    iteratePosts(
      account: ConnectedAccountRef,
      input: Omit<SearchPostsInput, "cursor">,
      options?: PublishCallOptions & IterationOptions,
    ): AsyncIterable<JsonObject>;
  };
  readonly media: {
    upload(
      input: MediaAttachment,
      account: ConnectedAccountRef,
      options?: PublishCallOptions,
    ): Promise<MediaRef>;
  };
  readonly analytics: {
    getAccountMetrics(
      ref: ConnectedAccountRef,
      options?: PublishCallOptions,
    ): Promise<readonly MetricValue[]>;
    getPostMetrics(
      ref: PlatformPostRef,
      options?: PublishCallOptions,
    ): Promise<readonly MetricValue[]>;
    getReport(
      ref: ConnectedAccountRef,
      query: AnalyticsReportQuery,
      options?: PublishCallOptions,
    ): Promise<AnalyticsReport>;
  };
  readonly comments: {
    list(
      ref: PlatformPostRef,
      options?: PublishCallOptions & { readonly cursor?: string; readonly limit?: number },
    ): Promise<Page<CommentRecord>>;
    iterate(
      ref: PlatformPostRef,
      options?: PublishCallOptions & IterationOptions & { readonly limit?: number },
    ): AsyncIterable<CommentRecord>;
    reply(
      ref: CommentRef,
      content: { readonly text: string },
      options?: PublishCallOptions,
    ): Promise<CommentRef>;
  };
  readonly messages: {
    listConversations(
      account: ConnectedAccountRef,
      options?: PublishCallOptions & { readonly cursor?: string; readonly limit?: number },
    ): Promise<Page<ConversationRecord>>;
    iterateConversations(
      account: ConnectedAccountRef,
      options?: PublishCallOptions & IterationOptions & { readonly limit?: number },
    ): AsyncIterable<ConversationRecord>;
    listMessages(
      ref: ConversationRef,
      options?: PublishCallOptions & { readonly cursor?: string; readonly limit?: number },
    ): Promise<Page<MessageRecord>>;
    iterateMessages(
      ref: ConversationRef,
      options?: PublishCallOptions & IterationOptions & { readonly limit?: number },
    ): AsyncIterable<MessageRecord>;
    send(
      ref: ConversationRef,
      content: { readonly text: string },
      options?: PublishCallOptions,
    ): Promise<JsonObject>;
  };
  readonly inbox: {
    /**
     * Reads one page from every source concurrently. Each source is authorized
     * on every call through the same checks as `messages.listConversations`
     * and `comments.list`, and a failing source is reported in `sources`
     * without failing the others.
     */
    list(input: InboxListInput, options?: PublishCallOptions): Promise<InboxPage>;
  };
  readonly notifications: {
    list(
      account: ConnectedAccountRef,
      options?: PublishCallOptions & { readonly cursor?: string; readonly limit?: number },
    ): Promise<Page<JsonObject>>;
    iterate(
      account: ConnectedAccountRef,
      options?: PublishCallOptions & IterationOptions & { readonly limit?: number },
    ): AsyncIterable<JsonObject>;
    markSeen(
      account: ConnectedAccountRef,
      input?: { readonly seenAt?: string },
      options?: PublishCallOptions,
    ): Promise<void>;
  };
  capabilities(): Readonly<{ [K in keyof B]: B[K]["capabilities"] }>;
  adapter<K extends keyof B>(
    backend: K,
    acknowledgement: { readonly acknowledgeUnsafe: true },
  ): B[K];
  native<K extends keyof B>(
    backend: K,
    acknowledgement: { readonly acknowledgeUnsafe: true },
  ): B[K]["native"];
}

export interface SharedSocialConfig {
  readonly authorization?: AuthorizationPolicy;
  /**
   * Stages `blob` and `stream` media as HTTPS URLs for targets whose
   * `posts.publish` capability declares `mediaSources` without them, such as
   * direct Instagram and Threads. See {@link MediaStagingProvider} for when
   * staged copies are removed and when they are kept.
   */
  readonly mediaStaging?: MediaStagingProvider;
  readonly idempotencyStore?: IdempotencyStore;
  readonly concurrency?: number;
  readonly maxQueued?: number;
  readonly clock?: () => Date;
}

export type SingleBackendConfig<A extends SocialAdapter<unknown>> = SharedSocialConfig & {
  readonly backend: A;
  readonly backends?: never;
};

export type MultiBackendConfig<B extends BackendRegistry> = SharedSocialConfig & {
  readonly backend?: never;
  readonly backends: B;
};

function targetKey(account: ConnectedAccountRef): string {
  return JSON.stringify([account.backend, account.platform, account.accountId]);
}

function mergeContent(
  base: PublishContent,
  override: PublishRequest["targets"][number]["content"],
): PublishContent {
  if (override === undefined) return base;
  const result: PublishContent = {};

  if (Object.hasOwn(override, "text")) {
    if (override.text !== undefined) Object.assign(result, { text: override.text });
  } else if (base.text !== undefined) Object.assign(result, { text: base.text });

  if (Object.hasOwn(override, "media")) {
    if (override.media !== undefined) Object.assign(result, { media: override.media });
  } else if (base.media !== undefined) Object.assign(result, { media: base.media });

  if (Object.hasOwn(override, "link")) {
    if (override.link !== undefined) Object.assign(result, { link: override.link });
  } else if (base.link !== undefined) Object.assign(result, { link: base.link });

  return result;
}

function mediaFingerprintView(content: PublishContent) {
  return {
    ...content,
    media: content.media?.map((media) => ({
      ...media,
      source:
        media.source.kind === "blob" || media.source.kind === "stream"
          ? { kind: media.source.kind, fingerprint: media.source.fingerprint }
          : media.source,
      thumbnail:
        media.thumbnail?.kind === "blob" || media.thumbnail?.kind === "stream"
          ? { kind: media.thumbnail.kind, fingerprint: media.thumbnail.fingerprint }
          : media.thumbnail,
    })),
  };
}

function preparationIssue(code: string, message: string, targetIndex?: number): PreparationIssue {
  const issue: PreparationIssue = { code, message, severity: "error" };

  if (targetIndex !== undefined) Object.assign(issue, { targetIndex });

  return issue;
}

function publicationStatus(outcomes: readonly DeliveryOutcome[]): PublicationStatus {
  const pending = new Set(["scheduled", "accepted", "processing"]);
  const success = new Set(["published"]);
  const hasPending = outcomes.some((outcome) => pending.has(outcome.state));
  const hasSuccess = outcomes.some((outcome) => success.has(outcome.state));

  const hasOther = outcomes.some(
    (outcome) => !pending.has(outcome.state) && !success.has(outcome.state),
  );

  if (hasPending && !hasSuccess && !hasOther) return "pending";

  if (!hasPending && !hasOther) return "complete";

  return "partial";
}

async function mapConcurrent<T>(
  count: number,
  concurrency: number,
  execute: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  let next = 0;

  async function worker(): Promise<void> {
    while (next < count) {
      const index = next++;
      results[index] = await execute(index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, () => worker()));

  return results;
}

function makeContext(
  backendInstance: string,
  correlationId: string,
  options: PublishCallOptions | undefined,
  targetIdempotencyKey?: string,
): AdapterOperationContext {
  const context: AdapterOperationContext = {
    backendInstance,
    correlationId,
    retryBudget: options?.retryBudget ?? { maxAttempts: 1, maxElapsedMs: 30_000 },
  };

  if (options?.signal !== undefined) Object.assign(context, { signal: options.signal });

  if (options?.authorization !== undefined)
    Object.assign(context, { authorization: options.authorization });

  if (targetIdempotencyKey !== undefined)
    Object.assign(context, { idempotencyKey: targetIdempotencyKey, targetIdempotencyKey });

  return context;
}

function unsupported(operation: string, backend: string): never {
  throw new SocialError({
    code: "unsupported_capability",
    operation,
    backend,
    message: `${backend} does not implement ${operation}`,
  });
}

/**
 * Runtime guards for JavaScript callers that bypass the facade's static types.
 * They are generic so a typed argument keeps its declared type when narrowed.
 */
function isObjectInput<Value>(value: Value): value is Value & object {
  return typeof value === "object" && value !== null;
}

function isNonBlankStringInput<Value>(value: Value): value is Value & string {
  return typeof value === "string" && value.trim() !== "";
}

/** `error` is the rejection when it was a SocialError, or undefined for any other thrown value. */
function outcomeFromError(
  error: SocialError | undefined,
  target: PreparedPublishTarget,
  observedAt: string,
): DeliveryOutcome {
  if (error !== undefined) {
    const candidate = error.operation === "media.upload" ? error.details?.["mediaId"] : undefined;

    const mediaId =
      isString(candidate) && /^[A-Za-z0-9_-]{1,256}$/.test(candidate) ? candidate : undefined;

    if (error.code === "cancelled") {
      return {
        state: "unknown",
        targetIndex: target.targetIndex,
        account: target.account,
        observedAt,
        ...definedFields({ mediaId }),
        reason: "ambiguous-submission",
        diagnostic: "Cancellation interrupted a dispatched request; reconcile before retrying",
      };
    }

    if (error.code === "ambiguous_outcome" || error.code === "timeout") {
      return {
        state: "unknown",
        targetIndex: target.targetIndex,
        account: target.account,
        observedAt,
        ...definedFields({ mediaId }),
        reason: "ambiguous-submission",
        diagnostic: "The request outcome is ambiguous; reconcile with the backend before retrying",
      };
    }

    return {
      state: "failed",
      targetIndex: target.targetIndex,
      account: target.account,
      observedAt,
      ...definedFields({ mediaId }),
      code: error.code,
      message: error.message,
      retryDisposition: error.retryDisposition,
    };
  }

  return {
    state: "unknown",
    targetIndex: target.targetIndex,
    account: target.account,
    observedAt,
    reason: "ambiguous-submission",
    diagnostic: "Adapter failed after dispatch; reconcile with the backend before retrying",
  };
}

function assertValidOutcome(outcome: DeliveryOutcome, target: PreparedPublishTarget): boolean {
  return (
    outcome.targetIndex === target.targetIndex &&
    outcome.account.backend === target.account.backend &&
    outcome.account.platform === target.account.platform &&
    outcome.account.accountId === target.account.accountId
  );
}

export function createSocial<A extends SocialAdapter<unknown>>(
  config: SingleBackendConfig<A>,
): SocialClient<{ readonly default: A }>;
export function createSocial<const B extends BackendRegistry>(
  config: MultiBackendConfig<B>,
): SocialClient<B>;
export function createSocial(
  config: SingleBackendConfig<SocialAdapter<unknown>> | MultiBackendConfig<BackendRegistry>,
): SocialClient<BackendRegistry> {
  const registry: BackendRegistry =
    "backend" in config && config.backend !== undefined
      ? { default: config.backend }
      : config.backends;

  const entries = Object.entries(registry);

  if (entries.length === 0) {
    throw new SocialError({
      code: "invalid_config",
      operation: "createSocial",
      message: "Configure at least one backend",
    });
  }

  const concurrency = config.concurrency ?? 4;

  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new SocialError({
      code: "invalid_config",
      operation: "createSocial",
      message: "concurrency must be an integer from 1 through 100",
    });
  }

  const maxQueued = config.maxQueued ?? 100;

  if (!Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > 10_000) {
    throw new SocialError({
      code: "invalid_config",
      operation: "createSocial",
      message: "maxQueued must be an integer from 0 through 10000",
    });
  }

  const mediaStaging = config.mediaStaging;
  let stagingOrigin = DEFAULT_STAGING_ORIGIN;

  if (mediaStaging !== undefined) {
    if (!isObjectInput(mediaStaging) || !("stageMedia" in mediaStaging))
      throw new SocialError({
        code: "invalid_config",
        operation: "createSocial",
        message: "mediaStaging must provide a stageMedia function",
      });

    if (mediaStaging.origin !== undefined) {
      let origin: URL | undefined;

      try {
        origin = httpsUrl(mediaStaging.origin);
      } catch {
        origin = undefined;
      }

      if (origin === undefined || origin.href !== `${origin.origin}/` || origin.search !== "")
        throw new SocialError({
          code: "invalid_config",
          operation: "createSocial",
          message: "mediaStaging.origin must be a public HTTPS origin without a path",
        });
      stagingOrigin = origin.origin;
    }
  }

  const limiters = new Map<string, ReturnType<typeof createConcurrencyLimiter>>(
    entries.map(([backend]) => [
      backend,
      createConcurrencyLimiter({ maxActive: concurrency, maxQueued, backend }),
    ]),
  );

  function dispatch<T>(
    backend: string,
    signal: AbortSignal | undefined,
    operation: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const limiter = limiters.get(backend);

    if (limiter === undefined) {
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: `Unknown backend instance: ${backend}`,
      });
    }

    return limiter(signal, operation, work).catch((cause: unknown) => {
      if (cause instanceof SocialError) throw cause;
      throw new SocialError({
        code: "upstream_failure",
        operation,
        backend,
        message: "The adapter failed while processing the request",
        cause,
      });
    });
  }

  const clock = config.clock ?? (() => new Date());
  let correlationSequence = 0;

  function prepare(request: PublishRequest): PublishPreparation {
    const issues: PreparationIssue[] = [];
    const targets: PreparedPublishTarget[] = [];

    if (request.targets.length === 0) {
      issues.push(preparationIssue("targets.required", "At least one target is required"));
    }

    if (
      request.content.text === undefined &&
      (request.content.media?.length ?? 0) === 0 &&
      request.content.link === undefined
    ) {
      issues.push(preparationIssue("content.required", "Text, media, or link is required"));
    }

    if (request.schedule !== undefined) {
      const scheduledAt = Date.parse(request.schedule.at);

      if (!Number.isFinite(scheduledAt)) {
        issues.push(preparationIssue("schedule.invalid", "schedule.at must be an ISO timestamp"));
      } else if (scheduledAt <= clock().getTime()) {
        issues.push(preparationIssue("schedule.in_past", "A scheduled time must be in the future"));
      }
    }

    const seen = new Set<string>();

    for (const [targetIndex, target] of request.targets.entries()) {
      if (
        target.account.kind !== "connected-account" ||
        target.account.version !== 1 ||
        target.account.backend.length === 0 ||
        target.account.platform.length === 0 ||
        target.account.accountId.length === 0
      ) {
        issues.push(
          preparationIssue(
            "target.reference_invalid",
            "Target account reference must be a version 1 connected-account reference",
            targetIndex,
          ),
        );
        continue;
      }

      const key = targetKey(target.account);

      if (seen.has(key)) {
        issues.push(preparationIssue("target.duplicate", "Duplicate target", targetIndex));
      }

      seen.add(key);
      const adapter = registry[target.account.backend];

      if (adapter === undefined) {
        issues.push(
          preparationIssue(
            "target.backend_unknown",
            `Unknown backend instance: ${target.account.backend}`,
            targetIndex,
          ),
        );
        continue;
      }

      if (adapter.posts === undefined) {
        issues.push(
          preparationIssue(
            "target.posts_unavailable",
            `Backend ${target.account.backend} does not implement posts`,
            targetIndex,
          ),
        );
        continue;
      }

      const content = mergeContent(request.content, target.content);

      const declaration = selectPublishDeclaration(
        adapter.capabilities.capabilities,
        target.account.platform,
        content,
      );

      if (declaration === undefined || declaration.availability !== "available") {
        issues.push(
          preparationIssue(
            "capability.unavailable",
            declaration?.notes ??
              `Backend ${target.account.backend} does not declare posts.publish for ${target.account.platform}`,
            targetIndex,
          ),
        );
        continue;
      }

      if (request.schedule !== undefined) {
        const scheduleDeclaration = adapter.capabilities.capabilities.find(
          (candidate) =>
            candidate.operation === "posts.schedule" &&
            (candidate.platform === "*" || candidate.platform === target.account.platform),
        );

        if (scheduleDeclaration !== undefined && scheduleDeclaration.availability !== "available") {
          issues.push(
            preparationIssue(
              "capability.unavailable",
              scheduleDeclaration.notes ??
                `Backend ${target.account.backend} does not declare posts.schedule for ${target.account.platform}`,
              targetIndex,
            ),
          );
        }
      }

      const replyTo = target.replyTo ?? request.replyTo;

      if (
        replyTo &&
        (replyTo.version !== 1 ||
          !["platform-post", "comment"].includes(replyTo.kind) ||
          replyTo.backend !== target.account.backend ||
          replyTo.platform !== target.account.platform)
      ) {
        issues.push(
          preparationIssue(
            "reply.reference_mismatch",
            "Reply references must use the selected backend and platform",
            targetIndex,
          ),
        );
      }

      const prepared: PreparedPublishTarget = {
        targetIndex,
        targetKey: key,
        account: target.account,
        content,
      };

      if (target.options !== undefined) Object.assign(prepared, { options: target.options });

      if (request.schedule !== undefined) Object.assign(prepared, { schedule: request.schedule });

      if (replyTo !== undefined) Object.assign(prepared, { replyTo });
      targets.push(prepared);

      const constraints = declaration.constraints;

      issues.push(
        ...mediaConstraintIssues({
          media: content.media ?? [],
          constraints,
          targetIndex,
          stagingEnabled: mediaStaging !== undefined,
        }),
      );

      // The adapter validates the URLs staging will produce; the plan keeps the
      // caller's media so idempotency fingerprints use the original content.
      const adapterView: PreparedPublishTarget =
        mediaStaging === undefined
          ? prepared
          : {
              ...prepared,
              content: withStagingPlaceholders(content, constraints, stagingOrigin),
            };

      try {
        issues.push(...adapter.posts.prepareTarget(adapterView));
      } catch (error) {
        issues.push(
          preparationIssue(
            "adapter.prepare_failed",
            error instanceof SocialError
              ? error.message
              : "The adapter could not validate this target locally",
            targetIndex,
          ),
        );
      }
    }

    return { ok: !issues.some((issue) => issue.severity === "error"), targets, issues };
  }

  async function authorizeRef(
    operation: import("./types.js").OperationName,
    account: ConnectedAccountRef,
    options: PublishCallOptions | undefined,
    correlationId: string,
  ): Promise<void> {
    if (config.authorization === undefined) return;

    const decision = (
      await config.authorization.authorizeTargets({
        operation,
        accounts: [account],
        context: makeContext("*", correlationId, options),
      })
    )[0];

    if (decision?.allowed !== true || targetKey(decision.account) !== targetKey(account)) {
      throw new SocialError({
        code: "unauthorized",
        operation,
        message: decision?.reason ?? "The account is not authorized for this operation",
        account,
        correlationId,
      });
    }
  }

  async function authorizeRefWithFallback(
    operation: import("./types.js").OperationName,
    fallback: import("./types.js").OperationName,
    account: ConnectedAccountRef,
    options: PublishCallOptions | undefined,
    correlationId: string,
  ): Promise<void> {
    try {
      await authorizeRef(operation, account, options, correlationId);
    } catch (error) {
      if (!(error instanceof SocialError) || error.code !== "unauthorized") throw error;
      await authorizeRef(fallback, account, options, correlationId);
    }
  }

  function validateAccountRef(account: ConnectedAccountRef, operation: string): void {
    if (
      !isObjectInput(account) ||
      account.kind !== "connected-account" ||
      account.version !== 1 ||
      !isNonBlankStringInput(account.backend) ||
      !account.platform ||
      !isNonBlankStringInput(account.accountId)
    )
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "A valid connected account reference is required",
      });
  }

  function validDateOnly(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);

    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  function validTimestamp(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "" && !Number.isNaN(Date.parse(value));
  }

  function selected(
    ref: { readonly backend: string; readonly kind?: string; readonly version?: number },
    operation: string,
  ): SocialAdapter<unknown> {
    if (ref.kind !== undefined && (ref.kind === "" || ref.version !== 1)) {
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "Reference kind/version does not match the Social SDK contract",
      });
    }

    const adapter = registry[ref.backend];

    if (adapter === undefined) {
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: `Unknown backend instance: ${ref.backend}`,
      });
    }

    return adapter;
  }

  function requireCapability(
    adapter: SocialAdapter<unknown>,
    operation: string,
    platform: string,
    backend: string,
  ): void {
    const aliases =
      operation === "posts.get"
        ? [operation, "posts.read"]
        : operation === "posts.getDelivery"
          ? [operation, "posts.status"]
          : [operation];

    const canonical = adapter.capabilities.capabilities.find(
      (candidate) =>
        candidate.operation === operation &&
        (platform === "*" || candidate.platform === "*" || candidate.platform === platform),
    );

    const declaration =
      canonical ??
      adapter.capabilities.capabilities.find(
        (candidate) =>
          aliases.includes(candidate.operation) &&
          (platform === "*" || candidate.platform === "*" || candidate.platform === platform),
      );

    if (declaration?.availability !== "available") unsupported(operation, backend);
  }

  /** Errors the adapter reports for a target whose staged URLs replaced local media. */
  function preparedIssues(
    posts: NonNullable<SocialAdapter<unknown>["posts"]>,
    target: PreparedPublishTarget,
  ): readonly PreparationIssue[] {
    try {
      return posts.prepareTarget(target).filter((issue) => issue.severity === "error");
    } catch {
      return [
        preparationIssue(
          "adapter.prepare_failed",
          "The adapter could not validate the staged media",
          target.targetIndex,
        ),
      ];
    }
  }

  /** A sanitized outcome for staging that stopped before anything reached the platform. */
  function stagingFailure(
    target: PreparedPublishTarget,
    reason: "cancelled" | "staging-failed" | "invalid-url",
  ): DeliveryOutcome {
    const base = {
      targetIndex: target.targetIndex,
      account: target.account,
      observedAt: clock().toISOString(),
    };

    if (reason === "cancelled") return { ...base, state: "cancelled", reason: "before-submission" };

    return {
      ...base,
      state: "not-submitted",
      reason: "before-submission",
      issues: [
        reason === "invalid-url"
          ? preparationIssue(
              "media.staging_url_invalid",
              "Media staging returned a URL that is not public HTTPS",
              target.targetIndex,
            )
          : preparationIssue(
              "media.staging_failed",
              "Media staging failed before submission",
              target.targetIndex,
            ),
      ],
    };
  }

  async function publish(
    request: PublishRequest,
    options?: PublishCallOptions,
  ): Promise<PublishResult> {
    const correlationId = request.correlationId ?? `social-${++correlationSequence}`;
    const executionOperation = request.schedule === undefined ? "posts.publish" : "posts.schedule";
    const authContext = makeContext("*", correlationId, options);

    if (options?.signal?.aborted) {
      throw new SocialError({
        code: "cancelled",
        operation: executionOperation,
        message: "Publishing was cancelled before authorization",
        correlationId,
      });
    }

    const authorizationOperation = executionOperation;

    if (config.authorization !== undefined) {
      const decisions = await config.authorization.authorizeTargets({
        operation: authorizationOperation,
        accounts: request.targets.map((target) => target.account),
        context: authContext,
      });

      for (const target of request.targets) {
        const decision = decisions.find(
          (candidate) => targetKey(candidate.account) === targetKey(target.account),
        );

        if (decision?.allowed !== true) {
          throw new SocialError({
            code: "unauthorized",
            operation: authorizationOperation,
            message: decision?.reason ?? "A target is not authorized for this operation",
            account: target.account,
            correlationId,
          });
        }
      }
    }

    const plan = prepare(request);

    if (!plan.ok) {
      throw new SocialError({
        code: "invalid_input",
        operation: executionOperation,
        message: "Publication preparation failed; no targets were dispatched",
        correlationId,
        issues: plan.issues,
      });
    }

    for (const target of plan.targets) {
      const adapter = registry[target.account.backend];

      if (adapter === undefined) throw new Error("Prepared adapter disappeared");

      requireCapability(adapter, "posts.publish", target.account.platform, target.account.backend);

      if (
        target.schedule !== undefined &&
        adapter.capabilities.capabilities.some(
          (candidate) =>
            candidate.operation === "posts.schedule" &&
            (candidate.platform === "*" || candidate.platform === target.account.platform),
        )
      )
        requireCapability(
          adapter,
          "posts.schedule",
          target.account.platform,
          target.account.backend,
        );
    }

    const targetViews = plan.targets.map((target) => ({
      account: target.account,
      content: mediaFingerprintView(target.content),
      options: target.options,
      replyTo: target.replyTo,
      schedule: target.schedule,
    }));

    const payloadFingerprint = await fingerprint(targetViews);

    const scope = JSON.stringify([
      options?.authorization?.tenantId ?? "credential-ready",
      "posts.publish",
    ]);

    let claim: IdempotencyClaim | undefined;

    if (request.idempotencyKey !== undefined && config.idempotencyStore !== undefined) {
      claim = await config.idempotencyStore.claim({
        scope,
        key: request.idempotencyKey,
        fingerprint: payloadFingerprint,
        targetKeys: plan.targets.map((target) => target.targetKey),
      });

      if (claim.kind === "conflict") {
        throw new SocialError({
          code: "idempotency_conflict",
          operation: executionOperation,
          message: "The idempotency key was already used with a different target or payload",
          correlationId,
        });
      }
    }

    const observedAt = (): string => clock().toISOString();

    const outcomes = await mapConcurrent(
      plan.targets.length,
      Math.max(1, plan.targets.length),
      async (index) => {
        const target = plan.targets[index];

        if (target === undefined) throw new Error("Prepared target index was lost");

        if (claim !== undefined && claim.kind === "existing") {
          const saved = claim.outcomes[target.targetKey];

          if (saved !== undefined) return saved;

          return {
            state: "unknown",
            targetIndex: target.targetIndex,
            account: target.account,
            observedAt: observedAt(),
            reason: "ambiguous-submission",
            diagnostic: "A previous execution claimed this target without recording an outcome",
          } satisfies DeliveryOutcome;
        }

        const adapter = registry[target.account.backend];

        if (adapter?.posts === undefined) throw new Error("Prepared adapter disappeared");

        const targetIdempotencyKey =
          request.idempotencyKey === undefined
            ? undefined
            : await deriveTargetIdempotencyKey({
                logicalKey: request.idempotencyKey,
                scope,
                backend: target.account.backend,
                targetKey: target.targetKey,
                payloadFingerprint,
              });

        let outcome: DeliveryOutcome;
        let enteredAdapter = false;
        const posts = adapter.posts;

        const constraints = selectPublishDeclaration(
          adapter.capabilities.capabilities,
          target.account.platform,
          target.content,
        )?.constraints;

        const staging =
          mediaStaging !== undefined &&
          (target.content.media ?? []).some(
            (item) =>
              needsStaging(constraints, item.source, true) ||
              (item.thumbnail !== undefined && needsStaging(constraints, item.thumbnail, true)),
          )
            ? mediaStaging
            : undefined;

        let leases: readonly StagingLease[] = [];

        try {
          const candidate = await dispatch(
            target.account.backend,
            options?.signal,
            executionOperation,
            async () => {
              let dispatched = target;

              let context = makeContext(
                target.account.backend,
                correlationId,
                options,
                targetIdempotencyKey,
              );

              // Staging runs here: after authorization and the replay check, inside
              // the backend's concurrency slot, and under the caller's signal.
              if (staging !== undefined) {
                const started = Date.now();

                const staged = await stageContent({
                  content: target.content,
                  constraints,
                  provider: staging,
                  account: target.account,
                  signal: options?.signal,
                  maxElapsedMs: context.retryBudget.maxElapsedMs,
                });

                leases = staged.leases;

                if (staged.kind === "failed") return stagingFailure(target, staged.reason);

                const remaining = context.retryBudget.maxElapsedMs - (Date.now() - started);

                if (remaining <= 0) return stagingFailure(target, "staging-failed");

                context = {
                  ...context,
                  retryBudget: { ...context.retryBudget, maxElapsedMs: remaining },
                };

                dispatched = { ...target, content: staged.content };

                const issues = preparedIssues(posts, dispatched);

                if (issues.length > 0)
                  return {
                    state: "not-submitted",
                    targetIndex: target.targetIndex,
                    account: target.account,
                    observedAt: clock().toISOString(),
                    reason: "validation",
                    issues,
                  } satisfies DeliveryOutcome;
              }

              enteredAdapter = true;

              return posts.publishTarget(dispatched, context);
            },
          );

          outcome = assertValidOutcome(candidate, target)
            ? candidate
            : {
                state: "unknown",
                targetIndex: target.targetIndex,
                account: target.account,
                observedAt: observedAt(),
                reason: "unmapped-state",
                diagnostic: "Adapter returned an outcome for a different target",
              };
        } catch (error) {
          outcome =
            !enteredAdapter && error instanceof SocialError && error.code === "cancelled"
              ? {
                  state: "cancelled",
                  targetIndex: target.targetIndex,
                  account: target.account,
                  observedAt: observedAt(),
                  reason: "before-submission",
                }
              : !enteredAdapter && error instanceof SocialError && error.code === "rate_limited"
                ? {
                    state: "not-submitted",
                    targetIndex: target.targetIndex,
                    account: target.account,
                    observedAt: observedAt(),
                    reason: "capacity",
                  }
                : outcomeFromError(
                    error instanceof SocialError ? error : undefined,
                    target,
                    observedAt(),
                  );
        }

        if (claim?.kind === "new" && config.idempotencyStore !== undefined) {
          try {
            await config.idempotencyStore.saveOutcome({
              claimId: claim.claimId,
              targetKey: target.targetKey,
              outcome,
            });
          } catch {
            // Return the complete in-memory result even if durable persistence is unavailable.
          }
        }

        // Remove staged copies only when no platform can still fetch them. Accepted,
        // processing, scheduled, failed and unknown outcomes keep them for the
        // provider's asynchronous fetch or for reconciliation.
        if (
          leases.length > 0 &&
          (!enteredAdapter || outcome.state === "published" || outcome.state === "not-submitted")
        )
          await releaseLeases(leases);

        return outcome;
      },
    );

    outcomes.sort((left, right) => left.targetIndex - right.targetIndex);

    const publicationBackend =
      new Set(plan.targets.map((target) => target.account.backend)).size === 1
        ? (plan.targets[0]?.account.backend ?? "unknown")
        : "multiple";

    const publicationId = await fingerprint({
      scope,
      key: request.idempotencyKey ?? correlationId,
      payloadFingerprint,
    });

    const publication: PublicationRef = {
      kind: "publication",
      version: 1,
      backend: publicationBackend,
      publicationId,
    };

    return { status: publicationStatus(outcomes), publication, outcomes };
  }

  const accountsFacade = {
    async list(
      callOptions?: PublishCallOptions & {
        readonly backend?: string;
        readonly cursor?: string;
        readonly limit?: number;
      },
    ): Promise<Page<AccountRecord>> {
      const correlationId = `social-${++correlationSequence}`;

      if (entries.length > 1 && callOptions?.backend === undefined)
        throw new SocialError({
          code: "invalid_input",
          operation: "accounts.read",
          message: "Select a backend instance when listing accounts from a mixed registry.",
        });

      const first =
        callOptions?.backend === undefined
          ? entries[0]
          : entries.find(([key]) => key === callOptions.backend);

      if (first === undefined || first[1].accounts === undefined)
        unsupported("accounts.read", first?.[0] ?? "unknown");
      requireCapability(first[1], "accounts.read", "*", first[0]);

      const cursorScope = JSON.stringify([
        first[0],
        "accounts.read",
        callOptions?.authorization?.tenantId ?? null,
        callOptions?.limit ?? null,
      ]);

      const received = await dispatch(first[0], callOptions?.signal, "accounts.read", () =>
        first[1].accounts!.list(
          decodePageOptions(cursorScope, callOptions),
          makeContext(first[0], correlationId, callOptions),
        ),
      );

      const page = encodePage(cursorScope, received);

      if (config.authorization === undefined) return page;

      const decisions = await config.authorization.authorizeTargets({
        operation: "accounts.read",
        accounts: page.items.map((item) => item.ref),
        context: makeContext(first[0], correlationId, callOptions),
      });

      const allowed = new Set(
        decisions.filter((item) => item.allowed).map((item) => targetKey(item.account)),
      );

      const filtered: Page<AccountRecord> = {
        items: page.items.filter((item) => allowed.has(targetKey(item.ref))),
      };

      if (page.nextCursor !== undefined) Object.assign(filtered, { nextCursor: page.nextCursor });

      if (page.metadata !== undefined) Object.assign(filtered, { metadata: page.metadata });

      return filtered;
    },
    iterate(
      callOptions?: PublishCallOptions &
        IterationOptions & { readonly backend?: string; readonly limit?: number },
    ): AsyncIterable<AccountRecord> {
      return iterateItems(
        (cursor) => accountsFacade.list(iterationPageOptions(callOptions, cursor)),
        callOptions,
      );
    },
    async get(ref: ConnectedAccountRef, callOptions?: PublishCallOptions): Promise<AccountRecord> {
      const correlationId = `social-${++correlationSequence}`;
      await authorizeRef("accounts.read", ref, callOptions, correlationId);
      const adapter = selected(ref, "accounts.get");
      requireCapability(adapter, "accounts.read", ref.platform, ref.backend);

      if (adapter.accounts === undefined) unsupported("accounts.read", ref.backend);

      return dispatch(ref.backend, callOptions?.signal, "accounts.read", () =>
        adapter.accounts!.get(ref, makeContext(ref.backend, correlationId, callOptions)),
      );
    },
  };

  const graphFacade = {
    async getProfile(
      account: ConnectedAccountRef,
      input: { readonly profileId?: string; readonly handle?: string },
      callOptions?: PublishCallOptions,
    ): Promise<ProfileRecord> {
      validateAccountRef(account, "profiles.read");

      if (
        !isObjectInput(input) ||
        (input.profileId !== undefined && !isNonBlankStringInput(input.profileId)) ||
        (input.handle !== undefined && !isNonBlankStringInput(input.handle))
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "profiles.read",
          message: "Profile selector fields must be nonempty strings when provided",
        });
      const correlationId = `social-${++correlationSequence}`;
      await authorizeRef("profiles.read", account, callOptions, correlationId);
      const adapter = selected(account, "profiles.read");
      requireCapability(adapter, "profiles.read", account.platform, account.backend);

      if (adapter.graph?.getProfile === undefined) unsupported("profiles.read", account.backend);

      return dispatch(account.backend, callOptions?.signal, "profiles.read", () =>
        adapter.graph!.getProfile!(
          account,
          input,
          makeContext(account.backend, correlationId, callOptions),
        ),
      );
    },
    async listRelationships(
      account: ConnectedAccountRef,
      input: {
        readonly kind: "following" | "followers" | "blocked" | "muted";
        readonly cursor?: string;
        readonly limit?: number;
      },
      callOptions?: PublishCallOptions,
    ): Promise<Page<RelationshipRecord>> {
      validateAccountRef(account, "graph.read");

      if (
        !isObjectInput(input) ||
        !["following", "followers", "blocked", "muted"].includes(input.kind) ||
        (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1))
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "graph.read",
          message: !["following", "followers", "blocked", "muted"].includes(input?.kind)
            ? "Relationship kind must be following, followers, blocked, or muted"
            : "Relationship page limit must be a positive integer",
        });
      const correlationId = `social-${++correlationSequence}`;
      await authorizeRef("graph.read", account, callOptions, correlationId);
      const adapter = selected(account, "graph.read");
      requireCapability(adapter, "graph.read", account.platform, account.backend);

      if (adapter.graph?.listRelationships === undefined)
        unsupported("graph.read", account.backend);

      const scope = JSON.stringify([
        account.backend,
        "graph.read",
        callOptions?.authorization?.tenantId ?? null,
        account.platform,
        account.accountId,
        input.kind,
        input.limit ?? null,
      ]);

      const page = await dispatch(account.backend, callOptions?.signal, "graph.read", () =>
        adapter.graph!.listRelationships!(
          account,
          {
            ...input,
            ...definedFields({
              cursor: input.cursor === undefined ? undefined : decodeCursor(scope, input.cursor),
            }),
          },
          makeContext(account.backend, correlationId, callOptions),
        ),
      );

      return encodePage(scope, page);
    },
    follow: (target: ProfileRef, options?: PublishCallOptions) =>
      graphMutation(target, "graph.follow", options, async (graph, context) => {
        if (graph.follow === undefined) unsupported("graph.follow", target.backend);

        return await graph.follow(target, context);
      }),
    unfollow: (target: ProfileRef, options?: PublishCallOptions) =>
      graphMutation(target, "graph.unfollow", options, async (graph, context) => {
        if (graph.unfollow === undefined) unsupported("graph.unfollow", target.backend);
        await graph.unfollow(target, context);
      }),
    block: (target: ProfileRef, options?: PublishCallOptions) =>
      graphMutation(target, "graph.block", options, async (graph, context) => {
        if (graph.block === undefined) unsupported("graph.block", target.backend);

        return await graph.block(target, context);
      }),
    unblock: (target: ProfileRef, options?: PublishCallOptions) =>
      graphMutation(target, "graph.unblock", options, async (graph, context) => {
        if (graph.unblock === undefined) unsupported("graph.unblock", target.backend);
        await graph.unblock(target, context);
      }),
    mute: (target: ProfileRef, options?: PublishCallOptions) =>
      graphMutation(target, "graph.mute", options, async (graph, context) => {
        if (graph.mute === undefined) unsupported("graph.mute", target.backend);

        return await graph.mute(target, context);
      }),
    unmute: (target: ProfileRef, options?: PublishCallOptions) =>
      graphMutation(target, "graph.unmute", options, async (graph, context) => {
        if (graph.unmute === undefined) unsupported("graph.unmute", target.backend);
        await graph.unmute(target, context);
      }),
  };

  /** Validates and authorizes a graph mutation, then runs `mutate` inside the backend limiter. */
  async function graphMutation<Result>(
    target: ProfileRef,
    operation:
      | "graph.follow"
      | "graph.unfollow"
      | "graph.block"
      | "graph.unblock"
      | "graph.mute"
      | "graph.unmute",
    callOptions: PublishCallOptions | undefined,
    mutate: (graph: GraphAdapter, context: AdapterOperationContext) => Promise<Result>,
  ): Promise<Result> {
    if (
      !isObjectInput(target) ||
      target.kind !== "profile" ||
      target.version !== 1 ||
      !isNonBlankStringInput(target.backend) ||
      !isNonBlankStringInput(target.platform) ||
      !isNonBlankStringInput(target.accountId) ||
      !isNonBlankStringInput(target.profileId)
    )
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "A valid profile reference is required",
      });

    const account: ConnectedAccountRef = {
      kind: "connected-account",
      version: 1,
      backend: target.backend,
      platform: target.platform,
      accountId: target.accountId,
    };

    const correlationId = `social-${++correlationSequence}`;
    await authorizeRef(operation, account, callOptions, correlationId);
    const adapter = selected(target, operation);
    requireCapability(adapter, operation, target.platform, target.backend);

    if (adapter.graph === undefined) unsupported(operation, target.backend);
    const context = makeContext(target.backend, correlationId, callOptions);

    const graph = adapter.graph;

    return dispatch(target.backend, callOptions?.signal, operation, () => mutate(graph, context));
  }

  async function lifecycle<R extends PlatformPostRef | BackendPostRef | ScheduledJobRef>(
    ref: R,
    expectedKind: R["kind"],
    operation: "posts.cancelScheduled" | "posts.deleteBackendRecord" | "posts.removeFromPlatform",
    callOptions: PublishCallOptions | undefined,
  ) {
    if (ref.kind !== expectedKind || ref.version !== 1 || !ref.accountId || !ref.platform)
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "Use the account-scoped reference returned for this resource kind.",
      });
    const correlationId = `social-${++correlationSequence}`;
    await authorizeRef(
      operation,
      {
        kind: "connected-account",
        version: 1,
        backend: ref.backend,
        platform: ref.platform,
        accountId: ref.accountId,
      },
      callOptions,
      correlationId,
    );
    const adapter = selected(ref, operation);
    requireCapability(adapter, operation, ref.platform, ref.backend);

    return { adapter, context: makeContext(ref.backend, correlationId, callOptions) };
  }

  const postsFacade = {
    async list(
      account: ConnectedAccountRef,
      callOptions?: PublishCallOptions & { readonly cursor?: string; readonly limit?: number },
    ): Promise<Page<JsonObject>> {
      const correlationId = `social-${++correlationSequence}`;
      await authorizeRef("posts.list", account, callOptions, correlationId);
      const adapter = selected(account, "posts.list");
      requireCapability(adapter, "posts.list", account.platform, account.backend);

      if (!adapter.posts?.list) unsupported("posts.list", account.backend);

      const scope = JSON.stringify([
        account.backend,
        "posts.list",
        callOptions?.authorization?.tenantId ?? null,
        account.platform,
        account.accountId,
        callOptions?.limit ?? null,
      ]);

      const input = decodePageOptions(scope, callOptions);

      const page = await dispatch(account.backend, callOptions?.signal, "posts.list", () =>
        adapter.posts!.list!(
          account,
          input,
          makeContext(account.backend, correlationId, callOptions),
        ),
      );

      return encodePage(scope, page);
    },
    iterate(
      account: ConnectedAccountRef,
      callOptions?: PublishCallOptions & IterationOptions & { readonly limit?: number },
    ): AsyncIterable<JsonObject> {
      return iterateItems(
        (cursor) => postsFacade.list(account, iterationPageOptions(callOptions, cursor)),
        callOptions,
      );
    },
    async cancelScheduled(
      ref: ScheduledJobRef,
      callOptions?: PublishCallOptions,
    ): Promise<ScheduleCancellation> {
      const { adapter, context } = await lifecycle(
        ref,
        "scheduled-job",
        "posts.cancelScheduled",
        callOptions,
      );

      if (!adapter.posts?.cancelScheduled) unsupported("posts.cancelScheduled", ref.backend);

      return dispatch(ref.backend, callOptions?.signal, "posts.cancelScheduled", () =>
        adapter.posts!.cancelScheduled!(ref, context),
      );
    },
    async deleteBackendRecord(
      ref: BackendPostRef,
      callOptions?: PublishCallOptions,
    ): Promise<void> {
      const { adapter, context } = await lifecycle(
        ref,
        "backend-post",
        "posts.deleteBackendRecord",
        callOptions,
      );

      if (!adapter.posts?.deleteBackendRecord)
        unsupported("posts.deleteBackendRecord", ref.backend);

      return dispatch(ref.backend, callOptions?.signal, "posts.deleteBackendRecord", () =>
        adapter.posts!.deleteBackendRecord!(ref, context),
      );
    },
    async removeFromPlatform(
      ref: PlatformPostRef,
      callOptions?: PublishCallOptions,
    ): Promise<void> {
      const { adapter, context } = await lifecycle(
        ref,
        "platform-post",
        "posts.removeFromPlatform",
        callOptions,
      );

      if (!adapter.posts?.removeFromPlatform) unsupported("posts.removeFromPlatform", ref.backend);

      return dispatch(ref.backend, callOptions?.signal, "posts.removeFromPlatform", () =>
        adapter.posts!.removeFromPlatform!(ref, context),
      );
    },
    prepare,
    publish,
    async publishSequence(
      request: PublishSequenceRequest,
      callOptions?: PublishCallOptions,
    ): Promise<PublishSequenceResult> {
      if (request.items.length === 0)
        throw new SocialError({
          code: "invalid_input",
          operation: "posts.publishSequence",
          message: "A sequence requires at least one item",
        });

      if (!isNonBlankStringInput(request.idempotencyKey))
        throw new SocialError({
          code: "invalid_input",
          operation: "posts.publishSequence",
          message: "A nonempty idempotencyKey is required",
        });

      const prepared: PublishRequest[] = [];

      for (const [index, item] of request.items.entries()) {
        const publishRequest: PublishRequest = {
          targets: item.targets,
          content: item.content,
          idempotencyKey: `${request.idempotencyKey}:${index}`,
        };

        if (item.replyTo !== undefined) Object.assign(publishRequest, { replyTo: item.replyTo });
        const chained = request.replyToPrevious === true && index > 0;

        if (chained) {
          const account = item.targets[0]?.account;
          const parent = request.items[index - 1]?.targets[0]?.account;

          // A chain replies to the single post the previous item created, so every link
          // must publish to one target on the same account.
          if (
            item.targets.length !== 1 ||
            request.items[index - 1]?.targets.length !== 1 ||
            item.replyTo !== undefined ||
            item.targets[0]?.replyTo !== undefined ||
            account === undefined ||
            parent === undefined ||
            account.backend !== parent.backend ||
            account.platform !== parent.platform ||
            account.accountId !== parent.accountId
          )
            throw new SocialError({
              code: "invalid_input",
              operation: "posts.publishSequence",
              message:
                "replyToPrevious requires every item to publish to the same single account without its own replyTo",
            });
        }

        const plan = prepare(
          chained
            ? {
                ...publishRequest,
                // Placeholder parent so adapters validate reply support before anything is sent.
                replyTo: {
                  kind: "platform-post",
                  version: 1,
                  backend: item.targets[0]!.account.backend,
                  platform: item.targets[0]!.account.platform,
                  accountId: item.targets[0]!.account.accountId,
                  postId: "preflight",
                },
              }
            : publishRequest,
        );

        if (!plan.ok)
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.publishSequence",
            message: "Publication preparation failed; no targets were dispatched",
            issues: plan.issues,
          });

        for (const target of plan.targets)
          await authorizeRef(
            "posts.publish",
            target.account,
            callOptions,
            `social-${++correlationSequence}`,
          );
        prepared.push(publishRequest);
      }

      const results: PublishResult[] = [];
      const failures: { index: number; code: string; message: string }[] = [];
      let previous: PlatformPostRef | undefined;

      for (const [index, publishRequest] of prepared.entries()) {
        const chained = request.replyToPrevious === true && index > 0;

        // Without a published parent the item would post as an unrelated root post.
        if (chained && previous === undefined) break;

        const nextRequest =
          chained && previous !== undefined
            ? { ...publishRequest, replyTo: previous }
            : publishRequest;

        let result: PublishResult;
        previous = undefined;

        try {
          result = await publish(nextRequest, callOptions);
        } catch (error) {
          if (error instanceof SocialError) {
            failures.push({ index, code: error.code, message: error.message });

            if (request.stopOnFailure !== false) break;
            continue;
          }

          throw error;
        }

        results.push(result);

        const published = result.outcomes.find((outcome) => outcome.state === "published");

        if (published?.post !== undefined) previous = published.post;

        if (request.stopOnFailure !== false && result.status === "partial") break;
      }

      const status =
        results.length < request.items.length || results.some((item) => item.status === "partial")
          ? "partial"
          : results.every((item) => item.status === "complete")
            ? "complete"
            : "pending";

      return { status, items: results, failures };
    },
    async get(ref: PlatformPostRef, callOptions?: PublishCallOptions): Promise<JsonObject> {
      const correlationId = `social-${++correlationSequence}`;
      await authorizeRef(
        "posts.get",
        {
          kind: "connected-account",
          version: 1,
          backend: ref.backend,
          platform: ref.platform,
          accountId: ref.accountId,
        },
        callOptions,
        correlationId,
      );
      const adapter = selected(ref, "posts.get");
      requireCapability(adapter, "posts.get", ref.platform, ref.backend);

      if (adapter.posts?.get === undefined) unsupported("posts.get", ref.backend);

      return dispatch(ref.backend, callOptions?.signal, "posts.get", () =>
        adapter.posts!.get!(ref, makeContext(ref.backend, correlationId, callOptions)),
      );
    },
    async getDelivery(
      ref: import("./types.js").DeliveryRef,
      callOptions?: PublishCallOptions,
    ): Promise<DeliveryOutcome> {
      if (ref.kind !== "delivery" || ref.version !== 1)
        throw new SocialError({
          code: "invalid_input",
          operation: "posts.getDelivery",
          message: "Use the version 1 delivery reference returned for this resource.",
        });
      const correlationId = `social-${++correlationSequence}`;

      const account = {
        kind: "connected-account" as const,
        version: 1 as const,
        backend: ref.backend,
        platform: ref.platform,
        accountId: ref.accountId,
      };

      await authorizeRef("posts.getDelivery", account, callOptions, correlationId);
      const adapter = selected(ref, "posts.getDelivery");
      requireCapability(adapter, "posts.getDelivery", ref.platform, ref.backend);

      if (adapter.posts?.getDelivery === undefined) unsupported("posts.getDelivery", ref.backend);

      return dispatch(ref.backend, callOptions?.signal, "posts.getDelivery", () =>
        adapter.posts!.getDelivery!(ref, makeContext(ref.backend, correlationId, callOptions)),
      );
    },
  };

  const searchFacade = {
    async posts(
      account: ConnectedAccountRef,
      input: SearchPostsInput,
      callOptions?: PublishCallOptions,
    ): Promise<Page<JsonObject>> {
      validateAccountRef(account, "search.posts");

      if (
        input === null ||
        input === undefined ||
        !isNonBlankStringInput(input.query) ||
        (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) ||
        (input.startTime !== undefined && !validTimestamp(input.startTime)) ||
        (input.endTime !== undefined && !validTimestamp(input.endTime)) ||
        (input.startTime !== undefined &&
          input.endTime !== undefined &&
          Date.parse(input.startTime) > Date.parse(input.endTime)) ||
        (input.scope !== undefined && input.scope !== "recent" && input.scope !== "all")
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "search.posts",
          message:
            "Search requires an account reference, a nonempty query, and a positive page limit.",
        });

      const correlationId = `social-${++correlationSequence}`;
      await authorizeRef("search.posts", account, callOptions, correlationId);
      const adapter = selected(account, "search.posts");
      requireCapability(adapter, "search.posts", account.platform, account.backend);
      const search = adapter.search;

      if (search === undefined) unsupported("search.posts", account.backend);

      const scope = await fingerprint([
        account.backend,
        "search.posts",
        callOptions?.authorization?.tenantId ?? null,
        account.platform,
        account.accountId,
        input.query,
        input.limit ?? null,
        input.startTime ?? null,
        input.endTime ?? null,
        input.scope ?? "recent",
      ]);

      const providerInput = { ...input };

      if (input.cursor !== undefined) {
        Object.assign(providerInput, { cursor: decodeCursor(scope, input.cursor) });
      }

      const page = await dispatch(account.backend, callOptions?.signal, "search.posts", () =>
        search.posts(
          account,
          providerInput,
          makeContext(account.backend, correlationId, callOptions),
        ),
      );

      return encodePage(scope, page);
    },
    iteratePosts(
      account: ConnectedAccountRef,
      input: Omit<SearchPostsInput, "cursor">,
      callOptions?: PublishCallOptions & IterationOptions,
    ): AsyncIterable<JsonObject> {
      return iterateItems(
        (cursor) =>
          searchFacade.posts(
            account,
            { ...input, ...iterationPageOptions(undefined, cursor) },
            callOptions,
          ),
        callOptions,
      );
    },
  };

  const mediaFacade = {
    async upload(
      input: MediaAttachment,
      account: ConnectedAccountRef,
      callOptions?: PublishCallOptions,
    ): Promise<MediaRef> {
      const correlationId = `social-${++correlationSequence}`;
      await authorizeRef("media.upload", account, callOptions, correlationId);
      const adapter = selected(account, "media.upload");
      requireCapability(adapter, "media.upload", account.platform, account.backend);

      if (adapter.media === undefined) unsupported("media.upload", account.backend);

      return dispatch(account.backend, callOptions?.signal, "media.upload", () =>
        adapter.media!.upload(
          input,
          account,
          makeContext(account.backend, correlationId, callOptions),
        ),
      );
    },
  };

  const analyticsFacade = {
    async getAccountMetrics(
      ref: ConnectedAccountRef,
      callOptions?: PublishCallOptions,
    ): Promise<readonly MetricValue[]> {
      validateAccountRef(ref, "analytics.account.read");
      const correlationId = `social-${++correlationSequence}`;
      await authorizeRefWithFallback(
        "analytics.account.read",
        "analytics.read",
        ref,
        callOptions,
        correlationId,
      );
      const adapter = selected(ref, "analytics.getAccountMetrics");
      requireCapability(adapter, "analytics.account.read", ref.platform, ref.backend);

      if (!adapter.analytics?.getAccountMetrics) unsupported("analytics.account.read", ref.backend);

      return normalizeMetrics(
        await dispatch(ref.backend, callOptions?.signal, "analytics.account.read", () =>
          adapter.analytics!.getAccountMetrics!(
            ref,
            makeContext(ref.backend, correlationId, callOptions),
          ),
        ),
      );
    },
    async getPostMetrics(
      ref: PlatformPostRef,
      callOptions?: PublishCallOptions,
    ): Promise<readonly MetricValue[]> {
      const correlationId = `social-${++correlationSequence}`;

      const account = {
        kind: "connected-account" as const,
        version: 1 as const,
        backend: ref.backend,
        platform: ref.platform,
        accountId: ref.accountId,
      };

      await authorizeRef("analytics.read", account, callOptions, correlationId);
      const adapter = selected(ref, "analytics.getPostMetrics");
      requireCapability(adapter, "analytics.read", ref.platform, ref.backend);

      if (adapter.analytics === undefined) unsupported("analytics.read", ref.backend);

      return normalizeMetrics(
        await dispatch(ref.backend, callOptions?.signal, "analytics.read", () =>
          adapter.analytics!.getPostMetrics(
            ref,
            makeContext(ref.backend, correlationId, callOptions),
          ),
        ),
      );
    },
    async getReport(
      ref: ConnectedAccountRef,
      query: AnalyticsReportQuery,
      callOptions?: PublishCallOptions,
    ): Promise<AnalyticsReport> {
      validateAccountRef(ref, "analytics.report.read");

      if (
        query === undefined ||
        query === null ||
        !validDateOnly(query.from) ||
        !validDateOnly(query.to) ||
        query.from > query.to ||
        !Array.isArray(query.metrics) ||
        query.metrics.length === 0 ||
        query.metrics.some((metric) => !isNonBlankStringInput(metric)) ||
        (query.dimensions !== undefined &&
          (!Array.isArray(query.dimensions) ||
            query.dimensions.some((dimension) => !isNonBlankStringInput(dimension))))
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "analytics.report.read",
          message:
            "Reports require an ordered YYYY-MM-DD range, at least one metric, and nonempty dimensions.",
        });
      const correlationId = `social-${++correlationSequence}`;
      await authorizeRef("analytics.report.read", ref, callOptions, correlationId);
      const adapter = selected(ref, "analytics.getReport");
      requireCapability(adapter, "analytics.report.read", ref.platform, ref.backend);

      if (!adapter.analytics?.getReport) unsupported("analytics.report.read", ref.backend);

      return dispatch(ref.backend, callOptions?.signal, "analytics.report.read", () =>
        adapter.analytics!.getReport!(
          ref,
          query,
          makeContext(ref.backend, correlationId, callOptions),
        ),
      );
    },
  };

  const commentsFacade = {
    async list(
      ref: PlatformPostRef,
      callOptions?: PublishCallOptions & { readonly cursor?: string; readonly limit?: number },
    ): Promise<Page<CommentRecord>> {
      const correlationId = `social-${++correlationSequence}`;

      if (
        callOptions?.limit !== undefined &&
        (!Number.isSafeInteger(callOptions.limit) || callOptions.limit < 1)
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "comments.read",
          message: "Comment page limit must be a positive integer",
        });

      const account = {
        kind: "connected-account" as const,
        version: 1 as const,
        backend: ref.backend,
        platform: ref.platform,
        accountId: ref.accountId,
      };

      await authorizeRef("comments.read", account, callOptions, correlationId);
      const adapter = selected(ref, "comments.list");
      requireCapability(adapter, "comments.read", ref.platform, ref.backend);

      if (adapter.comments === undefined) unsupported("comments.read", ref.backend);

      const cursorScope = inboxSourceScope(
        { kind: "comments", post: ref },
        callOptions?.authorization?.tenantId ?? null,
        callOptions?.limit ?? null,
      );

      const received = await dispatch(ref.backend, callOptions?.signal, "comments.read", () =>
        adapter.comments!.list(
          ref,
          decodePageOptions(cursorScope, callOptions),
          makeContext(ref.backend, correlationId, callOptions),
        ),
      );

      return mapItems(encodePage(cursorScope, received), normalizeComment);
    },
    iterate(
      ref: PlatformPostRef,
      callOptions?: PublishCallOptions & IterationOptions & { readonly limit?: number },
    ): AsyncIterable<CommentRecord> {
      return iterateItems(
        (cursor) => commentsFacade.list(ref, iterationPageOptions(callOptions, cursor)),
        callOptions,
      );
    },
    async reply(
      ref: CommentRef,
      content: { readonly text: string },
      callOptions?: PublishCallOptions,
    ): Promise<CommentRef> {
      const correlationId = `social-${++correlationSequence}`;

      const account = {
        kind: "connected-account" as const,
        version: 1 as const,
        backend: ref.backend,
        platform: ref.platform,
        accountId: ref.accountId,
      };

      await authorizeRef("comments.write", account, callOptions, correlationId);
      const adapter = selected(ref, "comments.reply");
      requireCapability(adapter, "comments.write", ref.platform, ref.backend);

      if (adapter.comments === undefined) unsupported("comments.write", ref.backend);

      return dispatch(ref.backend, callOptions?.signal, "comments.write", () =>
        adapter.comments!.reply(ref, content, makeContext(ref.backend, correlationId, callOptions)),
      );
    },
  };

  const messagesFacade = {
    async listConversations(
      account: ConnectedAccountRef,
      callOptions?: PublishCallOptions & { readonly cursor?: string; readonly limit?: number },
    ): Promise<Page<ConversationRecord>> {
      const correlationId = `social-${++correlationSequence}`;

      if (
        callOptions?.limit !== undefined &&
        (!Number.isSafeInteger(callOptions.limit) || callOptions.limit < 1)
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "messages.read",
          message: "Message page limit must be a positive integer",
        });
      await authorizeRef("messages.read", account, callOptions, correlationId);
      const adapter = selected(account, "messages.listConversations");
      requireCapability(adapter, "messages.read", account.platform, account.backend);

      if (adapter.messages === undefined) unsupported("messages.read", account.backend);

      const cursorScope = inboxSourceScope(
        { kind: "conversations", account },
        callOptions?.authorization?.tenantId ?? null,
        callOptions?.limit ?? null,
      );

      const received = await dispatch(account.backend, callOptions?.signal, "messages.read", () =>
        adapter.messages!.listConversations(
          account,
          decodePageOptions(cursorScope, callOptions),
          makeContext(account.backend, correlationId, callOptions),
        ),
      );

      return mapItems(encodePage(cursorScope, received), normalizeConversation);
    },
    iterateConversations(
      account: ConnectedAccountRef,
      callOptions?: PublishCallOptions & IterationOptions & { readonly limit?: number },
    ): AsyncIterable<ConversationRecord> {
      return iterateItems(
        (cursor) =>
          messagesFacade.listConversations(account, iterationPageOptions(callOptions, cursor)),
        callOptions,
      );
    },
    async listMessages(
      ref: ConversationRef,
      callOptions?: PublishCallOptions & { readonly cursor?: string; readonly limit?: number },
    ): Promise<Page<MessageRecord>> {
      const correlationId = `social-${++correlationSequence}`;

      if (
        callOptions?.limit !== undefined &&
        (!Number.isSafeInteger(callOptions.limit) || callOptions.limit < 1)
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "messages.read",
          message: "Message page limit must be a positive integer",
        });

      const account = {
        kind: "connected-account" as const,
        version: 1 as const,
        backend: ref.backend,
        platform: ref.platform,
        accountId: ref.accountId,
      };

      await authorizeRef("messages.read", account, callOptions, correlationId);
      const adapter = selected(ref, "messages.listMessages");
      requireCapability(adapter, "messages.read", ref.platform, ref.backend);

      if (adapter.messages === undefined) unsupported("messages.read", ref.backend);

      const cursorScope = JSON.stringify([
        ref.backend,
        "messages.read",
        callOptions?.authorization?.tenantId ?? null,
        ref.platform,
        ref.accountId,
        ref.conversationId,
        callOptions?.limit ?? null,
      ]);

      const received = await dispatch(ref.backend, callOptions?.signal, "messages.read", () =>
        adapter.messages!.listMessages(
          ref,
          decodePageOptions(cursorScope, callOptions),
          makeContext(ref.backend, correlationId, callOptions),
        ),
      );

      return mapItems(encodePage(cursorScope, received), normalizeMessage);
    },
    iterateMessages(
      ref: ConversationRef,
      callOptions?: PublishCallOptions & IterationOptions & { readonly limit?: number },
    ): AsyncIterable<MessageRecord> {
      return iterateItems(
        (cursor) => messagesFacade.listMessages(ref, iterationPageOptions(callOptions, cursor)),
        callOptions,
      );
    },
    async send(
      ref: ConversationRef,
      content: { readonly text: string },
      callOptions?: PublishCallOptions,
    ): Promise<JsonObject> {
      const correlationId = `social-${++correlationSequence}`;

      const account = {
        kind: "connected-account" as const,
        version: 1 as const,
        backend: ref.backend,
        platform: ref.platform,
        accountId: ref.accountId,
      };

      await authorizeRef("messages.write", account, callOptions, correlationId);
      const adapter = selected(ref, "messages.send");
      requireCapability(adapter, "messages.write", ref.platform, ref.backend);

      if (adapter.messages === undefined) unsupported("messages.write", ref.backend);

      return dispatch(ref.backend, callOptions?.signal, "messages.write", () =>
        adapter.messages!.send(ref, content, makeContext(ref.backend, correlationId, callOptions)),
      );
    },
  };

  const inboxFacade = {
    async list(input: InboxListInput, callOptions?: PublishCallOptions): Promise<InboxPage> {
      const invalid = (message: string): never => {
        throw new SocialError({ code: "invalid_input", operation: "inbox.list", message });
      };

      if (!isObjectInput(input)) invalid("Inbox input must be an object");

      const accounts = input.accounts ?? [];
      const posts = input.posts ?? [];

      if (!Array.isArray(accounts) || !Array.isArray(posts))
        invalid("accounts and posts must be arrays");

      const sources: InboxSource[] = [
        ...accounts.map((account): InboxSource => ({ kind: "conversations", account })),
        ...posts.map((post): InboxSource => ({ kind: "comments", post })),
      ];

      if (sources.length === 0 || sources.length > 50) invalid("Select 1 through 50 inbox sources");

      const limit = input.limit ?? 20;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        invalid("Inbox page limit must be an integer from 1 through 100");

      const keys = sources.map((source) => {
        if (source.kind === "conversations") {
          validateAccountRef(source.account, "inbox.list");

          return JSON.stringify(["conversations", targetKey(source.account)]);
        }

        const post = source.post;

        if (
          !isObjectInput(post) ||
          post.kind !== "platform-post" ||
          post.version !== 1 ||
          !isNonBlankStringInput(post.backend) ||
          !isNonBlankStringInput(post.platform) ||
          !isNonBlankStringInput(post.accountId) ||
          !isNonBlankStringInput(post.postId)
        )
          invalid("Inbox posts must be version 1 platform-post references");

        return JSON.stringify([
          "comments",
          JSON.stringify([post.backend, post.platform, post.accountId]),
          post.postId,
        ]);
      });

      if (new Set(keys).size !== keys.length) invalid("Inbox sources must not repeat");

      const scope = await fingerprint([
        "inbox.list",
        callOptions?.authorization?.tenantId ?? null,
        keys,
        limit,
      ]);

      let states: readonly InboxSourceState[] = sources.map(() => null);

      if (input.cursor !== undefined) {
        let parsed: unknown;

        try {
          parsed = JSON.parse(decodeCursor(scope, input.cursor, inboxCursorLimits));
        } catch (error) {
          if (error instanceof SocialError) throw error;
          parsed = undefined;
        }

        if (!isInboxState(parsed) || parsed.length !== sources.length)
          invalid("Cursor does not belong to these inbox sources");
        else states = parsed;
      }

      const sourceOptions: PublishCallOptions = definedFields({
        signal: callOptions?.signal,
        authorization: callOptions?.authorization,
        retryBudget: callOptions?.retryBudget,
      });

      const read = async (
        index: number,
      ): Promise<{
        readonly outcome: InboxSourceOutcome;
        readonly entries: readonly InboxEntry[];
        readonly state: InboxSourceState;
      }> => {
        const source = sources[index];
        const state = states[index] ?? null;

        if (source === undefined) throw new Error("Inbox source index was lost");

        const sourceScope = inboxSourceScope(
          source,
          callOptions?.authorization?.tenantId ?? null,
          limit,
        );

        const pageOptions: PublishCallOptions & { limit: number; cursor?: string } = {
          ...sourceOptions,
          limit,
        };

        if (state !== null && state !== false)
          pageOptions.cursor = encodeCursor(sourceScope, state);

        try {
          if (source.kind === "conversations") {
            if (state === false) {
              await authorizeRef(
                "messages.read",
                source.account,
                sourceOptions,
                `social-${++correlationSequence}`,
              );

              return { outcome: { state: "exhausted", source }, entries: [], state };
            }

            const page = await messagesFacade.listConversations(source.account, pageOptions);

            return {
              outcome: {
                state: "read",
                source,
                itemCount: page.items.length,
                hasMore: page.nextCursor !== undefined,
              },
              entries: page.items.map((record) => ({
                kind: "conversation",
                sourceIndex: index,
                account: source.account,
                record,
              })),
              state:
                page.nextCursor === undefined ? false : decodeCursor(sourceScope, page.nextCursor),
            };
          }

          if (state === false) {
            await authorizeRef(
              "comments.read",
              {
                kind: "connected-account",
                version: 1,
                backend: source.post.backend,
                platform: source.post.platform,
                accountId: source.post.accountId,
              },
              sourceOptions,
              `social-${++correlationSequence}`,
            );

            return { outcome: { state: "exhausted", source }, entries: [], state };
          }

          const page = await commentsFacade.list(source.post, pageOptions);

          return {
            outcome: {
              state: "read",
              source,
              itemCount: page.items.length,
              hasMore: page.nextCursor !== undefined,
            },
            entries: page.items.map((record) => ({
              kind: "comment",
              sourceIndex: index,
              post: source.post,
              record,
            })),
            state:
              page.nextCursor === undefined ? false : decodeCursor(sourceScope, page.nextCursor),
          };
        } catch (error) {
          const failure =
            error instanceof SocialError
              ? error
              : new SocialError({
                  code: "upstream_failure",
                  operation: "inbox.list",
                  message: "The inbox source could not be read",
                });

          return {
            outcome: {
              state: "failed",
              source,
              code: failure.code,
              message: failure.message,
              retryDisposition: failure.retryDisposition,
            },
            entries: [],
            state,
          };
        }
      };

      const results = await mapConcurrent(sources.length, concurrency, read);
      const nextStates = results.map((result) => result.state);

      const page: InboxPage = {
        entries: results.flatMap((result) => result.entries),
        sources: results.map((result) => result.outcome),
      };

      return nextStates.every((state) => state === false)
        ? page
        : {
            ...page,
            nextCursor: encodeCursor(scope, JSON.stringify(nextStates), inboxCursorLimits),
          };
    },
  };

  const notificationsFacade = {
    async list(
      account: ConnectedAccountRef,
      callOptions?: PublishCallOptions & { readonly cursor?: string; readonly limit?: number },
    ): Promise<Page<JsonObject>> {
      validateAccountRef(account, "notifications.read");

      if (
        callOptions?.limit !== undefined &&
        (!Number.isSafeInteger(callOptions.limit) || callOptions.limit < 1)
      )
        throw new SocialError({
          code: "invalid_input",
          operation: "notifications.read",
          message: "Notification page limit must be a positive integer",
        });
      const correlationId = `social-${++correlationSequence}`;
      await authorizeRef("notifications.read", account, callOptions, correlationId);
      const adapter = selected(account, "notifications.list");
      requireCapability(adapter, "notifications.read", account.platform, account.backend);

      if (adapter.notifications === undefined) unsupported("notifications.read", account.backend);

      const cursorScope = JSON.stringify([
        account.backend,
        "notifications.read",
        callOptions?.authorization?.tenantId ?? null,
        account.platform,
        account.accountId,
        callOptions?.limit ?? null,
      ]);

      const received = await dispatch(
        account.backend,
        callOptions?.signal,
        "notifications.read",
        () =>
          adapter.notifications!.list(
            account,
            decodePageOptions(cursorScope, callOptions),
            makeContext(account.backend, correlationId, callOptions),
          ),
      );

      return encodePage(cursorScope, received);
    },
    iterate(
      account: ConnectedAccountRef,
      callOptions?: PublishCallOptions & IterationOptions & { readonly limit?: number },
    ): AsyncIterable<JsonObject> {
      return iterateItems(
        (cursor) => notificationsFacade.list(account, iterationPageOptions(callOptions, cursor)),
        callOptions,
      );
    },
    async markSeen(
      account: ConnectedAccountRef,
      input: { readonly seenAt?: string } = {},
      callOptions?: PublishCallOptions,
    ): Promise<void> {
      validateAccountRef(account, "notifications.seen");

      if (!isObjectInput(input) || (input.seenAt !== undefined && !validTimestamp(input.seenAt)))
        throw new SocialError({
          code: "invalid_input",
          operation: "notifications.seen",
          message: "seenAt must be a valid timestamp",
        });
      const correlationId = `social-${++correlationSequence}`;
      await authorizeRef("notifications.seen", account, callOptions, correlationId);
      const adapter = selected(account, "notifications.markSeen");
      requireCapability(adapter, "notifications.seen", account.platform, account.backend);

      if (adapter.notifications === undefined) unsupported("notifications.seen", account.backend);

      return dispatch(account.backend, callOptions?.signal, "notifications.seen", () =>
        adapter.notifications!.markSeen(
          account,
          input,
          makeContext(account.backend, correlationId, callOptions),
        ),
      );
    },
  };

  return {
    accounts: accountsFacade,
    graph: graphFacade,
    posts: postsFacade,
    search: searchFacade,
    media: mediaFacade,
    analytics: analyticsFacade,
    comments: commentsFacade,
    messages: messagesFacade,
    inbox: inboxFacade,
    notifications: notificationsFacade,
    capabilities: () =>
      Object.fromEntries(entries.map(([key, adapter]) => [key, adapter.capabilities])),
    adapter: (backend, acknowledgement) => {
      if (acknowledgement?.acknowledgeUnsafe !== true)
        throw new SocialError({
          code: "invalid_input",
          operation: "native",
          message:
            "Raw adapter access bypasses client authorization. Explicit acknowledgeUnsafe: true is required.",
        });
      const selected = registry[String(backend)];

      if (selected === undefined)
        throw new SocialError({
          code: "invalid_input",
          operation: "adapter",
          message: `Unknown backend: ${String(backend)}`,
        });

      return selected;
    },
    native: (backend, acknowledgement) => {
      if (acknowledgement?.acknowledgeUnsafe !== true)
        throw new SocialError({
          code: "invalid_input",
          operation: "native",
          message: "Native access requires acknowledgeUnsafe: true",
        });
      const selected = registry[String(backend)];

      if (selected === undefined)
        throw new SocialError({
          code: "invalid_input",
          operation: "native",
          message: `Unknown backend: ${String(backend)}`,
        });

      return selected.native;
    },
  };
}

function decodePageOptions(
  scope: string,
  options?: { readonly cursor?: string; readonly limit?: number },
) {
  return definedFields({
    cursor: options?.cursor === undefined ? undefined : decodeCursor(scope, options.cursor),
    limit: options?.limit,
  });
}

function encodePage<T>(scope: string, page: Page<T>): Page<T> {
  const result = { ...page };

  if (page.nextCursor !== undefined) result.nextCursor = encodeCursor(scope, page.nextCursor);

  return result;
}

function mapItems<T, U>(page: Page<T>, project: (item: T) => U): Page<U> {
  return { ...page, items: page.items.map(project) };
}

function iterationPageOptions<T extends object>(
  options: T | undefined,
  cursor: string | undefined,
) {
  const result: (T & { cursor?: string }) | { cursor?: string } = { ...options };

  if (cursor !== undefined) result.cursor = cursor;

  return result;
}
