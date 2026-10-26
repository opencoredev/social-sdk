import { SocialError } from "../core/errors.js";
import { definedFields } from "../core/fields.js";
import { deriveTargetIdempotencyKey, stableSerialize } from "../core/idempotency.js";
import { decodeOutcome } from "../core/persisted-codec.js";
import {
  executionOperationFor,
  isNonBlankStringInput,
  isObjectInput,
  isSettledOutcome,
  makeContext,
  mapConcurrent,
  type PublicationPlan,
  targetKey,
  unrecordedOutcome,
} from "../core/client-support.js";
import type {
  PublishCallOptions,
  ReconcilePollError,
  ReconcileResult,
  RetryCallOptions,
  RetryResult,
  RetrySkipReason,
} from "../core/client.js";
import type { OutcomeRecovery } from "../core/extensions.js";
import type {
  DeliveryOutcome,
  DeliveryRef,
  PreparedPublishTarget,
  PublishRequest,
} from "../core/types.js";
import { parseJson } from "../transport/json.js";

/**
 * Adds `posts.reconcile` and `posts.retryFailed` to a client:
 * `createSocial({ ..., recovery: outcomeRecovery() })`. Both need an
 * `idempotencyStore` that implements `compareAndSetOutcome`. Kept out of
 * `createSocial` so applications that never recover outcomes do not bundle it.
 */
export function outcomeRecovery(): OutcomeRecovery {
  return (kernel) => {
    const {
      registry,
      idempotencyStore,
      clock,
      nextCorrelationId,
      authorizeRequest,
      planPublication,
      publicationResult,
      dispatchTarget,
      requireCapability,
      dispatch,
    } = kernel;

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
      const store = idempotencyStore;

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
        (target) => saved[target.targetKey] ?? unrecordedOutcome(target, clock().toISOString()),
      );

      const unresolved = outcomes
        .filter((outcome) => !isSettledOutcome(outcome))
        .map((outcome) => outcome.targetIndex);

      return { outcomes, unresolved };
    }

    /** Validates a polled outcome against the saved target before it can replace anything. */
    function polledOutcome(
      candidate: DeliveryOutcome,
      target: PreparedPublishTarget,
      ref: DeliveryRef,
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
      const correlationId = request.correlationId ?? nextCorrelationId();
      const claim = await openRecoveryClaim(request, options, "posts.reconcile", correlationId);
      const pollErrors: ReconcilePollError[] = [];

      await mapConcurrent(claim.plan.targets.length, claim.plan.targets.length, async (index) => {
        const target = claim.plan.targets[index];
        const saved = target === undefined ? undefined : claim.outcomes[target.targetKey];

        if (target === undefined || saved === undefined || isSettledOutcome(saved)) return;

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
          polled = await dispatch(
            target.account.backend,
            options?.signal,
            "posts.getDelivery",
            () => getDelivery(ref, makeContext(target.account.backend, correlationId, options)),
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
      const correlationId = request.correlationId ?? nextCorrelationId();
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
          diagnostic:
            "A retry was dispatched without a recorded outcome; reconcile before retrying",
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

    return { reconcile, retryFailed };
  };
}
