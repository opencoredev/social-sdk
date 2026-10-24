import { decodeCursor, encodeCursor, iterateItems, type IterationOptions } from "./pagination.js";
import { createConcurrencyLimiter } from "./concurrency.js";
import type { AuthorizationPolicy, GraphAdapter, JobRunner, SocialAdapter } from "./adapter.js";
import { SocialError } from "./errors.js";
import { definedFields } from "./fields.js";
import { isString } from "../transport/validation.js";
import { parseJson } from "../transport/json.js";
import { decodeOutcome } from "./persisted-codec.js";
import {
  deriveTargetIdempotencyKey,
  fingerprint,
  stableSerialize,
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
} from "./types.js";

export type BackendRegistry = Readonly<Record<string, SocialAdapter<unknown>>>;

export interface PublishCallOptions {
  readonly signal?: AbortSignal;
  readonly authorization?: AuthorizationContext;
  readonly retryBudget?: RetryBudget;
}

export interface AuthorizeCallOptions extends PublishCallOptions {
  readonly operation?: import("./types.js").OperationName;
}

export interface SocialClient<B extends BackendRegistry = BackendRegistry> {
  /** Optional application runner inherited by SocialScheduler unless overridden. */
  readonly jobRunner?: JobRunner;
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
    /** Runs the authorization `publish` would run for this request, without dispatching. */
    authorize<const T extends PublishRequest>(
      request: CheckedPublishRequest<T>,
      options?: AuthorizeCallOptions,
    ): Promise<void>;
    /**
     * Polls pending targets of a previous `publish` with the same full request and saves
     * validated results into its original idempotency claim. Requires an
     * `idempotencyStore` with `compareAndSetOutcome`.
     */
    reconcile<const T extends PublishRequest>(
      request: CheckedPublishRequest<T>,
      options?: PublishCallOptions,
    ): Promise<ReconcileResult>;
    /**
     * Re-sends only targets whose saved outcome proves nothing is live: retryable
     * failures, `not-submitted`, and pre-submission cancellations. Published and
     * unresolved targets are never sent again.
     */
    retryFailed<const T extends PublishRequest>(
      request: CheckedPublishRequest<T>,
      options?: RetryCallOptions,
    ): Promise<RetryResult>;
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
    ): Promise<Page<JsonObject>>;
    iterate(
      ref: PlatformPostRef,
      options?: PublishCallOptions & IterationOptions & { readonly limit?: number },
    ): AsyncIterable<JsonObject>;
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
    ): Promise<Page<JsonObject>>;
    iterateConversations(
      account: ConnectedAccountRef,
      options?: PublishCallOptions & IterationOptions & { readonly limit?: number },
    ): AsyncIterable<JsonObject>;
    listMessages(
      ref: ConversationRef,
      options?: PublishCallOptions & { readonly cursor?: string; readonly limit?: number },
    ): Promise<Page<JsonObject>>;
    iterateMessages(
      ref: ConversationRef,
      options?: PublishCallOptions & IterationOptions & { readonly limit?: number },
    ): AsyncIterable<JsonObject>;
    send(
      ref: ConversationRef,
      content: { readonly text: string },
      options?: PublishCallOptions,
    ): Promise<JsonObject>;
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

export interface ReconcilePollError {
  readonly targetIndex: number;
  readonly code: string;
  readonly message: string;
}

export interface ReconcileResult extends PublishResult {
  /** Target indexes still scheduled, accepted, processing, or unknown after this pass. */
  readonly unresolved: readonly number[];
  /** Targets whose poll failed or returned an outcome for a different target. */
  readonly pollErrors: readonly ReconcilePollError[];
}

export type RetrySkipReason = "not-retryable" | "retry-not-due" | "unresolved" | "concurrent-retry";

export interface RetryCallOptions extends PublishCallOptions {
  /** Restricts the retry to these original target indexes. */
  readonly targetIndexes?: readonly number[];
}

export interface RetryResult extends PublishResult {
  readonly retried: readonly number[];
  /** Unpublished targets left alone, with the reason. Published targets are omitted. */
  readonly skipped: readonly { readonly targetIndex: number; readonly reason: RetrySkipReason }[];
}

export interface SharedSocialConfig {
  readonly jobRunner?: JobRunner;
  readonly authorization?: AuthorizationPolicy;
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

const terminalStates: ReadonlySet<DeliveryOutcome["state"]> = new Set([
  "published",
  "failed",
  "cancelled",
  "not-submitted",
]);

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
    return prepareWith(request, false);
  }

  function prepareWith(request: PublishRequest, allowPastSchedule: boolean): PublishPreparation {
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
      } else if (!allowPastSchedule && scheduledAt <= clock().getTime()) {
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

      const declaration = adapter.capabilities.capabilities.find(
        (candidate) =>
          candidate.operation === "posts.publish" &&
          (candidate.platform === "*" || candidate.platform === target.account.platform),
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
        content: mergeContent(request.content, target.content),
      };

      if (target.options !== undefined) Object.assign(prepared, { options: target.options });

      if (request.schedule !== undefined) Object.assign(prepared, { schedule: request.schedule });

      if (replyTo !== undefined) Object.assign(prepared, { replyTo });
      targets.push(prepared);

      try {
        issues.push(...adapter.posts.prepareTarget(prepared));
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

  function executionOperationFor(request: PublishRequest): "posts.publish" | "posts.schedule" {
    return request.schedule === undefined ? "posts.publish" : "posts.schedule";
  }

  async function authorizeRequest(
    request: PublishRequest,
    operation: import("./types.js").OperationName,
    options: PublishCallOptions | undefined,
    correlationId: string,
  ): Promise<void> {
    if (options?.signal?.aborted) {
      throw new SocialError({
        code: "cancelled",
        operation,
        message: "Publishing was cancelled before authorization",
        correlationId,
      });
    }

    if (config.authorization === undefined) return;

    const decisions = await config.authorization.authorizeTargets({
      operation,
      accounts: request.targets.map((target) => target.account),
      context: makeContext("*", correlationId, options),
    });

    for (const target of request.targets) {
      const decision = decisions.find(
        (candidate) => targetKey(candidate.account) === targetKey(target.account),
      );

      if (decision?.allowed !== true) {
        throw new SocialError({
          code: "unauthorized",
          operation,
          message: decision?.reason ?? "A target is not authorized for this operation",
          account: target.account,
          correlationId,
        });
      }
    }
  }

  interface PublicationPlan {
    readonly targets: readonly PreparedPublishTarget[];
    readonly payloadFingerprint: string;
    readonly scope: string;
  }

  /**
   * Prepares the request and derives the claim identity shared by publish, reconcile,
   * and retry. `recovery` tolerates a schedule that has since passed and adapter issues
   * introduced after submission, but still requires every original target.
   */
  async function planPublication(
    request: PublishRequest,
    options: PublishCallOptions | undefined,
    correlationId: string,
    mode: "execute" | "recovery",
  ): Promise<PublicationPlan> {
    const executionOperation = executionOperationFor(request);
    const plan = prepareWith(request, mode === "recovery");

    if (mode === "recovery" ? plan.targets.length !== request.targets.length : !plan.ok) {
      throw new SocialError({
        code: "invalid_input",
        operation: executionOperation,
        message: "Publication preparation failed; no targets were dispatched",
        correlationId,
        issues: plan.issues,
      });
    }

    if (mode === "execute") {
      for (const target of plan.targets) {
        const adapter = registry[target.account.backend];

        if (adapter === undefined) throw new Error("Prepared adapter disappeared");

        requireCapability(
          adapter,
          "posts.publish",
          target.account.platform,
          target.account.backend,
        );

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

    return { targets: plan.targets, payloadFingerprint, scope };
  }

  async function publicationResult(
    request: PublishRequest,
    plan: PublicationPlan,
    correlationId: string,
    outcomes: DeliveryOutcome[],
  ): Promise<PublishResult> {
    outcomes.sort((left, right) => left.targetIndex - right.targetIndex);

    const publicationBackend =
      new Set(plan.targets.map((target) => target.account.backend)).size === 1
        ? (plan.targets[0]?.account.backend ?? "unknown")
        : "multiple";

    const publicationId = await fingerprint({
      scope: plan.scope,
      key: request.idempotencyKey ?? correlationId,
      payloadFingerprint: plan.payloadFingerprint,
    });

    const publication: PublicationRef = {
      kind: "publication",
      version: 1,
      backend: publicationBackend,
      publicationId,
    };

    return { status: publicationStatus(outcomes), publication, outcomes };
  }

  /** Sends one prepared target and maps every adapter failure into its outcome. */
  async function dispatchTarget(
    target: PreparedPublishTarget,
    executionOperation: "posts.publish" | "posts.schedule",
    correlationId: string,
    options: PublishCallOptions | undefined,
    targetIdempotencyKey: string | undefined,
  ): Promise<DeliveryOutcome> {
    const adapter = registry[target.account.backend];
    const posts = adapter?.posts;

    if (posts === undefined) throw new Error("Prepared adapter disappeared");

    const observedAt = (): string => clock().toISOString();
    let enteredAdapter = false;

    try {
      const candidate = await dispatch(
        target.account.backend,
        options?.signal,
        executionOperation,
        () => {
          enteredAdapter = true;

          return posts.publishTarget(
            target,
            makeContext(target.account.backend, correlationId, options, targetIdempotencyKey),
          );
        },
      );

      return assertValidOutcome(candidate, target)
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
      return !enteredAdapter && error instanceof SocialError && error.code === "cancelled"
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
  }

  async function publish(
    request: PublishRequest,
    options?: PublishCallOptions,
  ): Promise<PublishResult> {
    const correlationId = request.correlationId ?? `social-${++correlationSequence}`;
    const executionOperation = executionOperationFor(request);
    await authorizeRequest(request, executionOperation, options, correlationId);
    const plan = await planPublication(request, options, correlationId, "execute");
    let claim: IdempotencyClaim | undefined;

    if (request.idempotencyKey !== undefined && config.idempotencyStore !== undefined) {
      claim = await config.idempotencyStore.claim({
        scope: plan.scope,
        key: request.idempotencyKey,
        fingerprint: plan.payloadFingerprint,
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

    const outcomes = await mapConcurrent(
      plan.targets.length,
      Math.max(1, plan.targets.length),
      async (index) => {
        const target = plan.targets[index];

        if (target === undefined) throw new Error("Prepared target index was lost");

        if (claim !== undefined && claim.kind === "existing") {
          return claim.outcomes[target.targetKey] ?? unrecordedOutcome(target);
        }

        const targetIdempotencyKey =
          request.idempotencyKey === undefined
            ? undefined
            : await deriveTargetIdempotencyKey({
                logicalKey: request.idempotencyKey,
                scope: plan.scope,
                backend: target.account.backend,
                targetKey: target.targetKey,
                payloadFingerprint: plan.payloadFingerprint,
              });

        const outcome = await dispatchTarget(
          target,
          executionOperation,
          correlationId,
          options,
          targetIdempotencyKey,
        );

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

        return outcome;
      },
    );

    return publicationResult(request, plan, correlationId, outcomes);
  }

  function unrecordedOutcome(target: PreparedPublishTarget): DeliveryOutcome {
    return {
      state: "unknown",
      targetIndex: target.targetIndex,
      account: target.account,
      observedAt: clock().toISOString(),
      reason: "ambiguous-submission",
      diagnostic: "A previous execution claimed this target without recording an outcome",
    };
  }

  interface RecoveryClaim {
    readonly plan: PublicationPlan;
    readonly claimId: string;
    readonly outcomes: Readonly<Record<string, DeliveryOutcome>>;
    readonly compareAndSet: (input: {
      readonly targetKey: string;
      readonly expected: DeliveryOutcome | undefined;
      readonly outcome: DeliveryOutcome;
    }) => Promise<boolean>;
    readonly reload: () => Promise<Readonly<Record<string, DeliveryOutcome>>>;
  }

  /**
   * Opens the original claim for recovery. Only a caller holding the full original
   * request and an authorized context can reach it; no claim ID is accepted as input.
   * A key that was never claimed is fenced with `not-submitted` so a late original
   * execution cannot dispatch alongside recovery.
   */
  async function openRecoveryClaim(
    request: PublishRequest,
    options: PublishCallOptions | undefined,
    operation: "posts.reconcile" | "posts.retryFailed",
    correlationId: string,
  ): Promise<RecoveryClaim> {
    const store = config.idempotencyStore;

    if (store?.compareAndSetOutcome === undefined)
      throw new SocialError({
        code: "invalid_config",
        operation,
        message:
          "Recovery requires a durable idempotencyStore that implements compareAndSetOutcome",
        correlationId,
      });

    const key = request.idempotencyKey;

    if (!isNonBlankStringInput(key))
      throw new SocialError({
        code: "invalid_input",
        operation,
        message: "Recovery requires the original request's idempotencyKey",
        correlationId,
      });

    await authorizeRequest(
      request,
      operation === "posts.reconcile" ? "posts.getDelivery" : executionOperationFor(request),
      options,
      correlationId,
    );

    const plan = await planPublication(
      request,
      options,
      correlationId,
      operation === "posts.reconcile" ? "recovery" : "execute",
    );

    const claimInput = {
      scope: plan.scope,
      key,
      fingerprint: plan.payloadFingerprint,
      targetKeys: plan.targets.map((target) => target.targetKey),
    };

    const readClaim = async () => {
      const claim = await store.claim(claimInput);

      if (claim.kind === "conflict")
        throw new SocialError({
          code: "idempotency_conflict",
          operation,
          message: "The idempotency key was already used with a different target or payload",
          correlationId,
        });

      return claim;
    };

    const compareAndSetOutcome = store.compareAndSetOutcome.bind(store);
    const claim = await readClaim();

    const compareAndSet: RecoveryClaim["compareAndSet"] = (input) =>
      compareAndSetOutcome({ claimId: claim.claimId, ...input });

    if (claim.kind === "new") {
      for (const target of plan.targets)
        await compareAndSet({
          targetKey: target.targetKey,
          expected: undefined,
          outcome: {
            state: "not-submitted",
            targetIndex: target.targetIndex,
            account: target.account,
            observedAt: clock().toISOString(),
            reason: "before-submission",
          },
        });
    }

    const reload = async () => (await readClaim()).outcomes;

    return {
      plan,
      claimId: claim.claimId,
      outcomes: claim.kind === "new" ? await reload() : claim.outcomes,
      compareAndSet,
      reload,
    };
  }

  async function recoveredOutcomes(
    claim: RecoveryClaim,
  ): Promise<{ readonly outcomes: DeliveryOutcome[]; readonly unresolved: number[] }> {
    const saved = await claim.reload();

    const outcomes = claim.plan.targets.map(
      (target) => saved[target.targetKey] ?? unrecordedOutcome(target),
    );

    const unresolved = outcomes
      .filter((outcome) => !terminalStates.has(outcome.state))
      .map((outcome) => outcome.targetIndex);

    return { outcomes, unresolved };
  }

  /** Validates a polled outcome against the saved target before it can replace anything. */
  function polledOutcome(
    candidate: DeliveryOutcome,
    target: PreparedPublishTarget,
    ref: import("./types.js").DeliveryRef,
  ): DeliveryOutcome | undefined {
    let polled: DeliveryOutcome;

    try {
      polled = decodeOutcome(parseJson(stableSerialize(candidate)), "outcome");
    } catch {
      return undefined;
    }

    if (
      !isObjectInput(polled) ||
      !isObjectInput(polled.account) ||
      targetKey(polled.account) !== target.targetKey ||
      polled.state === "not-submitted" ||
      !Number.isFinite(Date.parse(polled.observedAt)) ||
      (polled.delivery !== undefined &&
        (polled.delivery.deliveryId !== ref.deliveryId ||
          polled.delivery.backend !== ref.backend ||
          polled.delivery.platform !== ref.platform ||
          polled.delivery.accountId !== ref.accountId)) ||
      (polled.state === "published" &&
        (!isObjectInput(polled.post) ||
          polled.post.kind !== "platform-post" ||
          polled.post.version !== 1 ||
          polled.post.backend !== target.account.backend ||
          polled.post.platform !== target.account.platform ||
          polled.post.accountId !== target.account.accountId)) ||
      (polled.state === "scheduled" &&
        (!isObjectInput(polled.job) ||
          polled.job.kind !== "scheduled-job" ||
          polled.job.version !== 1 ||
          polled.job.backend !== target.account.backend ||
          polled.job.platform !== target.account.platform ||
          polled.job.accountId !== target.account.accountId))
    )
      return undefined;

    // Managed backends often report index 0; outcomes keep the original target index.
    return { ...polled, targetIndex: target.targetIndex, account: target.account, delivery: ref };
  }

  async function reconcile(
    request: PublishRequest,
    options?: PublishCallOptions,
  ): Promise<ReconcileResult> {
    const correlationId = request.correlationId ?? `social-${++correlationSequence}`;
    const claim = await openRecoveryClaim(request, options, "posts.reconcile", correlationId);
    const pollErrors: ReconcilePollError[] = [];

    await mapConcurrent(claim.plan.targets.length, claim.plan.targets.length, async (index) => {
      const target = claim.plan.targets[index];
      const saved = target === undefined ? undefined : claim.outcomes[target.targetKey];

      if (target === undefined || saved === undefined || terminalStates.has(saved.state)) return;

      const ref = saved.delivery;

      // Without a provider identifier there is nothing safe to look up; content search could
      // match an unrelated post, so the outcome stays unresolved.
      if (ref === undefined) return;

      const adapter = registry[target.account.backend];

      if (
        ref.kind !== "delivery" ||
        ref.version !== 1 ||
        ref.backend !== target.account.backend ||
        ref.platform !== target.account.platform ||
        ref.accountId !== target.account.accountId
      ) {
        pollErrors.push({
          targetIndex: target.targetIndex,
          code: "identity_mismatch",
          message: "The saved delivery reference belongs to a different target",
        });

        return;
      }

      const getDelivery = adapter?.posts?.getDelivery;

      if (adapter === undefined || getDelivery === undefined) {
        pollErrors.push({
          targetIndex: target.targetIndex,
          code: "unsupported_capability",
          message: `${target.account.backend} does not implement posts.getDelivery`,
        });

        return;
      }

      let polled: DeliveryOutcome;

      try {
        requireCapability(
          adapter,
          "posts.getDelivery",
          target.account.platform,
          target.account.backend,
        );
        polled = await dispatch(target.account.backend, options?.signal, "posts.getDelivery", () =>
          getDelivery(ref, makeContext(target.account.backend, correlationId, options)),
        );
      } catch (error) {
        pollErrors.push({
          targetIndex: target.targetIndex,
          code: error instanceof SocialError ? error.code : "upstream_failure",
          message:
            error instanceof SocialError ? error.message : "The delivery could not be polled",
        });

        return;
      }

      const next = polledOutcome(polled, target, ref);

      if (next === undefined) {
        pollErrors.push({
          targetIndex: target.targetIndex,
          code: "identity_mismatch",
          message: "The backend returned a delivery for a different target",
        });

        return;
      }

      // Compare-and-set fences this poll: a retry or newer poll that already replaced the
      // saved outcome wins, and this stale observation is dropped.
      await claim.compareAndSet({ targetKey: target.targetKey, expected: saved, outcome: next });
    });

    const { outcomes, unresolved } = await recoveredOutcomes(claim);
    const result = await publicationResult(request, claim.plan, correlationId, outcomes);

    pollErrors.sort((left, right) => left.targetIndex - right.targetIndex);

    return { ...result, unresolved, pollErrors };
  }

  /** Why a target cannot be retried now, or undefined when a retry is safe. */
  function retryBlocker(
    saved: DeliveryOutcome | undefined,
    now: number,
  ): RetrySkipReason | "published" | undefined {
    if (saved === undefined) return "unresolved";

    switch (saved.state) {
      case "published":
        return "published";
      case "not-submitted":
        return undefined;
      case "cancelled":
        return saved.reason === "before-submission" ? undefined : "not-retryable";
      case "failed": {
        const disposition = saved.retryDisposition;

        if (disposition.kind === "never" || disposition.kind === "reconcile-first")
          return "not-retryable";

        if (
          disposition.kind === "after-delay" &&
          Date.parse(saved.observedAt) + disposition.delayMs > now
        )
          return "retry-not-due";

        return undefined;
      }

      case "scheduled":
      case "accepted":
      case "processing":
      case "unknown":
        return "unresolved";
      default: {
        const _exhaustive: never = saved;

        return _exhaustive;
      }
    }
  }

  async function retryFailed(
    request: PublishRequest,
    options?: RetryCallOptions,
  ): Promise<RetryResult> {
    const correlationId = request.correlationId ?? `social-${++correlationSequence}`;
    const claim = await openRecoveryClaim(request, options, "posts.retryFailed", correlationId);
    const executionOperation = executionOperationFor(request);
    const key = request.idempotencyKey ?? "";
    const retried: number[] = [];
    const skipped: { targetIndex: number; reason: RetrySkipReason }[] = [];
    const now = clock().getTime();

    await mapConcurrent(claim.plan.targets.length, claim.plan.targets.length, async (index) => {
      const target = claim.plan.targets[index];

      if (target === undefined) return;

      if (options?.targetIndexes !== undefined && !options.targetIndexes.includes(index)) return;

      const saved = claim.outcomes[target.targetKey];
      const blocker = retryBlocker(saved, now);

      if (blocker === "published") return;

      if (blocker !== undefined) {
        skipped.push({ targetIndex: target.targetIndex, reason: blocker });

        return;
      }

      const fence: DeliveryOutcome = {
        state: "unknown",
        retryAttemptId: crypto.randomUUID(),
        targetIndex: target.targetIndex,
        account: target.account,
        observedAt: clock().toISOString(),
        reason: "ambiguous-submission",
        diagnostic: "A retry was dispatched without a recorded outcome; reconcile before retrying",
      };

      // Moving the failure to `unknown` before dispatch fences concurrent retries: only the
      // writer whose compare-and-set wins may send, and a crash leaves an unresolved outcome.
      if (
        !(await claim.compareAndSet({
          targetKey: target.targetKey,
          expected: saved,
          outcome: fence,
        }))
      ) {
        skipped.push({ targetIndex: target.targetIndex, reason: "concurrent-retry" });

        return;
      }

      const targetIdempotencyKey = await deriveTargetIdempotencyKey({
        logicalKey: `${key}#retry:${fence.retryAttemptId}`,
        scope: claim.plan.scope,
        backend: target.account.backend,
        targetKey: target.targetKey,
        payloadFingerprint: claim.plan.payloadFingerprint,
      });

      const outcome = await dispatchTarget(
        target,
        executionOperation,
        correlationId,
        options,
        targetIdempotencyKey,
      );

      await claim.compareAndSet({
        targetKey: target.targetKey,
        expected: fence,
        outcome: { ...outcome, ...definedFields({ retryAttemptId: fence.retryAttemptId }) },
      });
      retried.push(target.targetIndex);
    });

    const { outcomes } = await recoveredOutcomes(claim);
    const result = await publicationResult(request, claim.plan, correlationId, outcomes);

    retried.sort((left, right) => left - right);
    skipped.sort((left, right) => left.targetIndex - right.targetIndex);

    return { ...result, retried, skipped };
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
    reconcile,
    retryFailed,
    async authorize(request: PublishRequest, callOptions?: AuthorizeCallOptions): Promise<void> {
      await authorizeRequest(
        request,
        callOptions?.operation ?? executionOperationFor(request),
        callOptions,
        request.correlationId ?? `social-${++correlationSequence}`,
      );
    },
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

      return dispatch(ref.backend, callOptions?.signal, "analytics.account.read", () =>
        adapter.analytics!.getAccountMetrics!(
          ref,
          makeContext(ref.backend, correlationId, callOptions),
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

      return dispatch(ref.backend, callOptions?.signal, "analytics.read", () =>
        adapter.analytics!.getPostMetrics(
          ref,
          makeContext(ref.backend, correlationId, callOptions),
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
    ): Promise<Page<JsonObject>> {
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

      const cursorScope = JSON.stringify([
        ref.backend,
        "comments.read",
        callOptions?.authorization?.tenantId ?? null,
        ref.platform,
        ref.accountId,
        ref.postId,
        callOptions?.limit ?? null,
      ]);

      const received = await dispatch(ref.backend, callOptions?.signal, "comments.read", () =>
        adapter.comments!.list(
          ref,
          decodePageOptions(cursorScope, callOptions),
          makeContext(ref.backend, correlationId, callOptions),
        ),
      );

      return encodePage(cursorScope, received);
    },
    iterate(
      ref: PlatformPostRef,
      callOptions?: PublishCallOptions & IterationOptions & { readonly limit?: number },
    ): AsyncIterable<JsonObject> {
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
    ): Promise<Page<JsonObject>> {
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

      const cursorScope = JSON.stringify([
        account.backend,
        "messages.read",
        callOptions?.authorization?.tenantId ?? null,
        account.platform,
        account.accountId,
        "conversations",
        callOptions?.limit ?? null,
      ]);

      const received = await dispatch(account.backend, callOptions?.signal, "messages.read", () =>
        adapter.messages!.listConversations(
          account,
          decodePageOptions(cursorScope, callOptions),
          makeContext(account.backend, correlationId, callOptions),
        ),
      );

      return encodePage(cursorScope, received);
    },
    iterateConversations(
      account: ConnectedAccountRef,
      callOptions?: PublishCallOptions & IterationOptions & { readonly limit?: number },
    ): AsyncIterable<JsonObject> {
      return iterateItems(
        (cursor) =>
          messagesFacade.listConversations(account, iterationPageOptions(callOptions, cursor)),
        callOptions,
      );
    },
    async listMessages(
      ref: ConversationRef,
      callOptions?: PublishCallOptions & { readonly cursor?: string; readonly limit?: number },
    ): Promise<Page<JsonObject>> {
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

      return encodePage(cursorScope, received);
    },
    iterateMessages(
      ref: ConversationRef,
      callOptions?: PublishCallOptions & IterationOptions & { readonly limit?: number },
    ): AsyncIterable<JsonObject> {
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
    ...definedFields({ jobRunner: config.jobRunner }),
    graph: graphFacade,
    posts: postsFacade,
    search: searchFacade,
    media: mediaFacade,
    analytics: analyticsFacade,
    comments: commentsFacade,
    messages: messagesFacade,
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

function iterationPageOptions<T extends object>(
  options: T | undefined,
  cursor: string | undefined,
) {
  const result: (T & { cursor?: string }) | { cursor?: string } = { ...options };

  if (cursor !== undefined) result.cursor = cursor;

  return result;
}
