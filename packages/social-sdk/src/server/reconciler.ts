import type {
  PublishCallOptions,
  ReconcileResult,
  RetryCallOptions,
  RetryResult,
  SocialClient,
} from "../core/client.js";
import { SocialError } from "../core/errors.js";
import type { PublishRequest } from "../core/types.js";

/** The client operations recovery needs; any `createSocial` client satisfies it. */
export type RecoveryClient = Pick<SocialClient, "posts">;

export interface OutcomeReconcilerConfig {
  /** A client created with `recovery: outcomeRecovery()`. */
  readonly social: RecoveryClient;
  /** Waits between passes. Defaults to a timer that rejects when the signal aborts. */
  readonly wait?: (input: { readonly ms: number; readonly signal?: AbortSignal }) => Promise<void>;
}

export interface SettleOptions extends PublishCallOptions {
  /** Maximum reconcile passes, 1 through 100. Defaults to 10. */
  readonly maxPasses?: number;
  /** Delay between passes in milliseconds, 0 through 3600000. Defaults to 5000. */
  readonly intervalMs?: number;
}

function sleep(input: { readonly ms: number; readonly signal?: AbortSignal }): Promise<void> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(
        new SocialError({
          code: "cancelled",
          operation: "posts.reconcile",
          message: "Reconciliation was cancelled",
        }),
      );

      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      reject(
        new SocialError({
          code: "cancelled",
          operation: "posts.reconcile",
          message: "Reconciliation was cancelled",
        }),
      );
    };

    const timer = setTimeout(() => {
      input.signal?.removeEventListener("abort", onAbort);
      resolve();
    }, input.ms);

    input.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function boundedInteger(input: {
  readonly value: number | undefined;
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
  readonly name: string;
}): number {
  const value = input.value ?? input.fallback;

  if (!Number.isSafeInteger(value) || value < input.min || value > input.max)
    throw new SocialError({
      code: "invalid_input",
      operation: "posts.reconcile",
      message: `${input.name} must be an integer from ${input.min} through ${input.max}`,
    });

  return value;
}

/**
 * Resolves accepted, processing, scheduled, and unknown destinations of a previous
 * publication, and re-sends only destinations whose saved outcome proves nothing is live.
 * All state lives in the client's idempotency claim, so passes from different processes
 * see each other's results.
 */
export class OutcomeReconciler {
  readonly #social: RecoveryClient;
  readonly #wait: NonNullable<OutcomeReconcilerConfig["wait"]>;

  constructor(config: OutcomeReconcilerConfig) {
    this.#social = config.social;
    this.#wait = config.wait ?? sleep;
  }

  /** One polling pass. */
  reconcile(request: PublishRequest, options?: PublishCallOptions): Promise<ReconcileResult> {
    return this.#social.posts.reconcile(request, options);
  }

  /** Polls until no destination is unresolved or `maxPasses` is reached. */
  async settle(request: PublishRequest, options: SettleOptions = {}): Promise<ReconcileResult> {
    const maxPasses = boundedInteger({
      value: options.maxPasses,
      fallback: 10,
      min: 1,
      max: 100,
      name: "maxPasses",
    });

    const intervalMs = boundedInteger({
      value: options.intervalMs,
      fallback: 5_000,
      min: 0,
      max: 3_600_000,
      name: "intervalMs",
    });

    let result = await this.reconcile(request, options);

    for (let pass = 1; pass < maxPasses && result.unresolved.length > 0; pass++) {
      // An outcome without a delivery reference cannot change by polling, so stop early.
      if (result.outcomes.every((outcome) => !isPollable(outcome, result.unresolved))) break;

      await this.#wait(
        options.signal === undefined
          ? { ms: intervalMs }
          : { ms: intervalMs, signal: options.signal },
      );
      result = await this.reconcile(request, options);
    }

    return result;
  }

  /** Re-sends failed destinations; published and unresolved destinations are left alone. */
  retryFailed(request: PublishRequest, options?: RetryCallOptions): Promise<RetryResult> {
    return this.#social.posts.retryFailed(request, options);
  }
}

function isPollable(
  outcome: ReconcileResult["outcomes"][number],
  unresolved: readonly number[],
): boolean {
  return unresolved.includes(outcome.targetIndex) && outcome.delivery !== undefined;
}
