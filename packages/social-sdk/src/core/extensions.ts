import type { IdempotencyStore } from "./idempotency.js";
import type {
  BackendRegistry,
  InboxListInput,
  InboxPage,
  PublishCallOptions,
  ReconcileResult,
  RetryCallOptions,
  RetryResult,
} from "./client.js";
import type { PublicationPlan } from "./client-support.js";
import type { SocialAdapter } from "./adapter.js";
import type { CommentRecord, ConversationRecord } from "./projections.js";
import type {
  AdapterOperationContext,
  CapabilityConstraints,
  ConnectedAccountRef,
  DeliveryOutcome,
  OperationName,
  Page,
  PlatformPostRef,
  PreparationIssue,
  PreparedPublishTarget,
  PublishRequest,
  PublishResult,
} from "./types.js";

/*
 * Opt-in features receive a narrow view of the client once, when `createSocial`
 * runs. Keeping their code in separate entry points means an application that
 * imports only `createSocial` does not bundle them. Pass only the extensions this
 * package exports: the kernel dispatches without re-running authorization.
 */

/** What `outcomeRecovery()` needs from the client to reconcile and retry a publication. */
export interface PublishKernel {
  readonly registry: BackendRegistry;
  readonly idempotencyStore: IdempotencyStore | undefined;
  readonly clock: () => Date;
  nextCorrelationId(): string;
  authorizeRequest(
    request: PublishRequest,
    operation: OperationName,
    options: PublishCallOptions | undefined,
    correlationId: string,
  ): Promise<void>;
  planPublication(
    request: PublishRequest,
    options: PublishCallOptions | undefined,
    correlationId: string,
    mode: "execute" | "recovery",
  ): Promise<PublicationPlan>;
  publicationResult(
    request: PublishRequest,
    plan: PublicationPlan,
    correlationId: string,
    outcomes: DeliveryOutcome[],
  ): Promise<PublishResult>;
  dispatchTarget(
    target: PreparedPublishTarget,
    executionOperation: "posts.publish" | "posts.schedule",
    correlationId: string,
    options: PublishCallOptions | undefined,
    targetIdempotencyKey: string | undefined,
  ): Promise<DeliveryOutcome>;
  requireCapability(
    adapter: SocialAdapter<unknown>,
    operation: string,
    platform: string,
    backend: string,
  ): void;
  dispatch<T>(
    backend: string,
    signal: AbortSignal | undefined,
    operation: string,
    work: () => Promise<T>,
  ): Promise<T>;
}

export interface OutcomeRecoveryMethods {
  reconcile(request: PublishRequest, options?: PublishCallOptions): Promise<ReconcileResult>;
  retryFailed(request: PublishRequest, options?: RetryCallOptions): Promise<RetryResult>;
}

/** Created by `outcomeRecovery()` from `@opencoredev/social-sdk/server`. */
export type OutcomeRecovery = (kernel: PublishKernel) => OutcomeRecoveryMethods;

/** What `inboxAggregation()` needs from the client to read several sources at once. */
export interface InboxKernel {
  readonly concurrency: number;
  nextCorrelationId(): string;
  validateAccountRef(account: ConnectedAccountRef, operation: string): void;
  authorizeRef(
    operation: OperationName,
    account: ConnectedAccountRef,
    options: PublishCallOptions | undefined,
    correlationId: string,
  ): Promise<void>;
  listConversations(
    account: ConnectedAccountRef,
    options: PublishCallOptions & { readonly cursor?: string; readonly limit?: number },
  ): Promise<Page<ConversationRecord>>;
  listComments(
    post: PlatformPostRef,
    options: PublishCallOptions & { readonly cursor?: string; readonly limit?: number },
  ): Promise<Page<CommentRecord>>;
}

export interface InboxAggregationMethods {
  list(input: InboxListInput, options?: PublishCallOptions): Promise<InboxPage>;
}

/** Created by `inboxAggregation()` from `@opencoredev/social-sdk/inbox`. */
export type InboxAggregation = (kernel: InboxKernel) => InboxAggregationMethods;

/** One target's staging step, run inside its backend's concurrency slot. */
export interface StageTargetInput {
  readonly target: PreparedPublishTarget;
  readonly constraints: CapabilityConstraints | undefined;
  readonly context: AdapterOperationContext;
  readonly signal: AbortSignal | undefined;
  readonly observedAt: () => string;
  /** Adapter validation of the target after staged URLs replaced local media. */
  readonly revalidate: (target: PreparedPublishTarget) => readonly PreparationIssue[];
}

export type StagedTarget =
  /** Nothing in the target needed staging. */
  | { readonly kind: "unchanged" }
  /** Staging stopped before submission; `outcome` is the target's result. */
  | {
      readonly kind: "stopped";
      readonly outcome: DeliveryOutcome;
      readonly settle: (outcome: DeliveryOutcome, enteredAdapter: boolean) => Promise<void>;
    }
  | {
      readonly kind: "staged";
      readonly target: PreparedPublishTarget;
      readonly context: AdapterOperationContext;
      /** Removes staged copies once no platform can still fetch them. */
      readonly settle: (outcome: DeliveryOutcome, enteredAdapter: boolean) => Promise<void>;
    };

/** Created by `localMediaStaging(provider)` from `@opencoredev/social-sdk/media-staging`. */
export interface MediaStaging {
  /** HTTPS origin of staged URLs, used for placeholder URLs during preparation. */
  readonly origin: string;
  stage(input: StageTargetInput): Promise<StagedTarget>;
}
