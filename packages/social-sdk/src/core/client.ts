import { decodeCursor, encodeCursor, iterateItems, type IterationOptions } from "./pagination.js";
import { createConcurrencyLimiter } from "./concurrency.js";
import type { AuthorizationPolicy, SocialAdapter } from "./adapter.js";
import { SocialError } from "./errors.js";
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
} from "./types.js";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-known-value-widening -- Adapter and pagination boundaries intentionally accept arbitrary rejection values and build narrow option records. */

export type BackendRegistry = Readonly<Record<string, SocialAdapter<unknown>>>;

export interface PublishCallOptions {
  readonly signal?: AbortSignal;
  readonly authorization?: AuthorizationContext;
  readonly retryBudget?: RetryBudget;
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Adapter rejections enter the error boundary here.
function outcomeFromError(
  error: unknown, // Transport and adapter rejections can be arbitrary JavaScript values.
  target: PreparedPublishTarget,
  observedAt: string,
): DeliveryOutcome {
  if (error instanceof SocialError) {
    if (error.code === "cancelled") {
      return {
        state: "unknown",
        targetIndex: target.targetIndex,
        account: target.account,
        observedAt,
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
        reason: "ambiguous-submission",
        diagnostic: "The request outcome is ambiguous; reconcile with the backend before retrying",
      };
    }

    return {
      state: "failed",
      targetIndex: target.targetIndex,
      account: target.account,
      observedAt,
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

    return limiter(signal, operation, work);
  }

  const clock = config.clock ?? (() => new Date());
  let correlationSequence = 0;

  function prepare(request: PublishRequest): PublishPreparation {
    const issues: PreparationIssue[] = [];
    const targets: PreparedPublishTarget[] = [];

    if (request.targets.length === 0) {
      issues.push(preparationIssue("targets.required", "At least one target is required"));
    }

    if (request.content.text === undefined && (request.content.media?.length ?? 0) === 0) {
      issues.push(preparationIssue("content.required", "Text or media is required"));
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

      const replyTo = target.replyTo ?? request.replyTo;

      if (
        replyTo &&
        (replyTo.version !== 1 ||
          !["platform-post", "comment"].includes(replyTo.kind) ||
          replyTo.backend !== target.account.backend ||
          replyTo.platform !== target.account.platform ||
          replyTo.accountId !== target.account.accountId)
      ) {
        issues.push(
          preparationIssue(
            "reply.reference_mismatch",
            "Reply references must use the selected account, backend, and platform",
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
    const declaration = adapter.capabilities.capabilities.find(
      (candidate) =>
        candidate.operation === operation &&
        (platform === "*" || candidate.platform === "*" || candidate.platform === platform),
    );

    if (declaration?.availability !== "available") unsupported(operation, backend);
  }

  async function publish(
    request: PublishRequest,
    options?: PublishCallOptions,
  ): Promise<PublishResult> {
    const correlationId = request.correlationId ?? `social-${++correlationSequence}`;
    const authContext = makeContext("*", correlationId, options);

    if (options?.signal?.aborted) {
      throw new SocialError({
        code: "cancelled",
        operation: "posts.publish",
        message: "Publishing was cancelled before authorization",
        correlationId,
      });
    }

    if (config.authorization !== undefined) {
      const decisions = await config.authorization.authorizeTargets({
        operation: "posts.publish",
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
            operation: "posts.publish",
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
        operation: "posts.publish",
        message: "Publication preparation failed; no targets were dispatched",
        correlationId,
        issues: plan.issues,
      });
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
          operation: "posts.publish",
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

        try {
          const candidate = await dispatch(
            target.account.backend,
            options?.signal,
            "posts.publish",
            () => {
              enteredAdapter = true;

              return adapter.posts!.publishTarget(
                target,
                makeContext(target.account.backend, correlationId, options, targetIdempotencyKey),
              );
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
                : outcomeFromError(error, target, observedAt());
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
      await authorizeRef("posts.read", account, callOptions, correlationId);
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
      const results: PublishResult[] = [];

      for (const [index, item] of request.items.entries()) {
        const publishRequest: PublishRequest = {
          targets: item.targets,
          content: item.content,
          idempotencyKey: `${request.idempotencyKey}:${index}`,
        };

        if (item.replyTo !== undefined) Object.assign(publishRequest, { replyTo: item.replyTo });
        const result = await publish(publishRequest, callOptions);

        results.push(result);

        if (request.stopOnFailure !== false && result.status !== "complete") break;
      }

      const status =
        results.length === request.items.length &&
        results.every((item) => item.status === "complete")
          ? "complete"
          : results.some((item) => item.status === "partial") || results.length > 0
            ? "partial"
            : "pending";

      return { status, items: results };
    },
    async get(ref: PlatformPostRef, callOptions?: PublishCallOptions): Promise<JsonObject> {
      const correlationId = `social-${++correlationSequence}`;
      await authorizeRef(
        "posts.read",
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
      requireCapability(adapter, "posts.read", ref.platform, ref.backend);

      if (adapter.posts?.get === undefined) unsupported("posts.read", ref.backend);

      return dispatch(ref.backend, callOptions?.signal, "posts.read", () =>
        adapter.posts!.get!(ref, makeContext(ref.backend, correlationId, callOptions)),
      );
    },
    async getDelivery(
      ref: import("./types.js").DeliveryRef,
      callOptions?: PublishCallOptions,
    ): Promise<DeliveryOutcome> {
      const correlationId = `social-${++correlationSequence}`;

      const account = {
        kind: "connected-account" as const,
        version: 1 as const,
        backend: ref.backend,
        platform: ref.platform,
        accountId: ref.accountId,
      };

      await authorizeRef("posts.read", account, callOptions, correlationId);
      const adapter = selected(ref, "posts.getDelivery");
      requireCapability(adapter, "posts.status", ref.platform, ref.backend);

      if (adapter.posts?.getDelivery === undefined) unsupported("posts.read", ref.backend);

      return dispatch(ref.backend, callOptions?.signal, "posts.status", () =>
        adapter.posts!.getDelivery!(ref, makeContext(ref.backend, correlationId, callOptions)),
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
      await authorizeRef("posts.publish", account, callOptions, correlationId);
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
      const correlationId = `social-${++correlationSequence}`;
      await authorizeRef("analytics.read", ref, callOptions, correlationId);
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
  };

  const commentsFacade = {
    async list(
      ref: PlatformPostRef,
      callOptions?: PublishCallOptions & { readonly cursor?: string; readonly limit?: number },
    ): Promise<Page<JsonObject>> {
      const correlationId = `social-${++correlationSequence}`;

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

  return {
    accounts: accountsFacade,
    posts: postsFacade,
    media: mediaFacade,
    analytics: analyticsFacade,
    comments: commentsFacade,
    messages: messagesFacade,
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

      if (selected === undefined) throw new Error(`Unknown backend: ${String(backend)}`);

      return selected;
    },
    native: (backend, acknowledgement) => {
      if (acknowledgement?.acknowledgeUnsafe !== true)
        throw new Error("Native access requires acknowledgeUnsafe: true");
      const selected = registry[String(backend)];

      if (selected === undefined) throw new Error(`Unknown backend: ${String(backend)}`);

      return selected.native;
    },
  };
}

function decodePageOptions(
  scope: string,
  options?: { readonly cursor?: string; readonly limit?: number },
) {
  const input: { cursor?: string; limit?: number } = {};

  if (options?.cursor !== undefined) input.cursor = decodeCursor(scope, options.cursor);

  if (options?.limit !== undefined) input.limit = options.limit;

  return input;
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
