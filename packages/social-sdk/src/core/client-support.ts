// Helpers shared by createSocial and its opt-in extensions. Not exported from the package.
import type { InboxSource, PublishCallOptions, PublishRetryPolicy } from "./client.js";
import { SocialError } from "./errors.js";
import type {
  AdapterOperationContext,
  PublishRequest,
  ConnectedAccountRef,
  DeliveryOutcome,
  PreparationIssue,
  PreparedPublishTarget,
  PublishTarget,
} from "./types.js";

export function targetKey(account: ConnectedAccountRef): string {
  return JSON.stringify([account.backend, account.platform, account.accountId]);
}

/**
 * Gives each target of a chained sequence item a placeholder parent on its own account,
 * so adapters validate reply support before anything is sent.
 */
export function withPreflightParents(targets: readonly PublishTarget[]): PublishTarget[] {
  return targets.map((target) => ({
    ...target,
    replyTo: {
      kind: "platform-post",
      version: 1,
      backend: target.account.backend,
      platform: target.account.platform,
      accountId: target.account.accountId,
      postId: "preflight",
    },
  }));
}

export function preparationIssue(
  code: string,
  message: string,
  targetIndex?: number,
): PreparationIssue {
  const issue: PreparationIssue = { code, message, severity: "error" };

  if (targetIndex !== undefined) Object.assign(issue, { targetIndex });

  return issue;
}

export const terminalStates: ReadonlySet<DeliveryOutcome["state"]> = new Set([
  "published",
  "failed",
  "cancelled",
  "not-submitted",
]);

/**
 * Whether a saved outcome is final. A failure whose provider asks to reconcile first and
 * that carries a delivery reference is not: polling it may still find the post.
 */
export function isSettledOutcome(outcome: DeliveryOutcome): boolean {
  if (outcome.state === "failed")
    return outcome.retryDisposition.kind !== "reconcile-first" || outcome.delivery === undefined;

  return terminalStates.has(outcome.state);
}

export async function mapConcurrent<T>(
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

export function makeContext(
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

/**
 * Runtime guards for JavaScript callers that bypass the facade's static types.
 * They are generic so a typed argument keeps its declared type when narrowed.
 */
export function isObjectInput<Value>(value: Value): value is Value & object {
  return typeof value === "object" && value !== null;
}

export function isNonBlankStringInput<Value>(value: Value): value is Value & string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Narrows an optional adapter surface to one whose optional `key` method is present. Unlike
 * `adapter.posts?.get !== undefined`, the narrowing holds inside the dispatch callback, and the
 * method is still called on its owner so `this` is preserved.
 */
export function implementsMethod<Surface extends object, Key extends keyof Surface>(
  surface: Surface | undefined,
  key: Key,
): surface is Surface & { readonly [Name in Key]-?: Exclude<Surface[Name], undefined> } {
  return surface !== undefined && surface[key] !== undefined;
}

/** The outcome of a claimed target whose outcome was never recorded. */
export function unrecordedOutcome(
  target: PreparedPublishTarget,
  observedAt: string,
): DeliveryOutcome {
  return {
    state: "unknown",
    targetIndex: target.targetIndex,
    account: target.account,
    observedAt,
    reason: "ambiguous-submission",
    diagnostic: "A previous execution claimed this target without recording an outcome",
  };
}

export function executionOperationFor(request: PublishRequest): "posts.publish" | "posts.schedule" {
  return request.schedule === undefined ? "posts.publish" : "posts.schedule";
}

/** A prepared publish request and the claim identity shared by publish, reconcile, and retry. */
export interface PublicationPlan {
  readonly targets: readonly PreparedPublishTarget[];
  readonly payloadFingerprint: string;
  readonly scope: string;
}

/** Cursor scope for one conversation or comment source, shared by its facade and `inbox.list`. */
export function inboxSourceScope(
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

/** A validated `PublishRetryPolicy` with defaults; no policy means one attempt. */
export function publishRetryPolicy(
  policy: PublishRetryPolicy | undefined,
  operation: string,
): Required<PublishRetryPolicy> {
  const maxAttempts = policy?.maxAttempts ?? 1;
  const maxDelayMs = policy?.maxDelayMs ?? 60_000;
  const capacityDelayMs = policy?.capacityDelayMs ?? 1_000;

  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 5 ||
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs < 0 ||
    !Number.isFinite(capacityDelayMs) ||
    capacityDelayMs < 0
  )
    throw new SocialError({
      code: "invalid_input",
      operation,
      message:
        "retry.maxAttempts must be an integer from 1 through 5, and retry delays must be finite and not negative.",
    });

  return { maxAttempts, maxDelayMs, capacityDelayMs };
}

/** How long to wait before sending a target again, or undefined when it must not be resent. */
export function publishRetryDelay(
  outcome: DeliveryOutcome,
  capacityDelayMs: number,
): number | undefined {
  if (outcome.state === "not-submitted" && outcome.reason === "capacity") return capacityDelayMs;

  if (outcome.state === "failed" && outcome.retryDisposition.kind === "after-delay")
    return outcome.retryDisposition.delayMs;

  return undefined;
}

/** Waits `milliseconds`; resolves false instead of waiting when the caller aborts. */
export function waitToRetry(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(true);
    }, milliseconds);

    signal?.addEventListener("abort", abort, { once: true });
  });
}
