import type { AdapterOperationContext } from "../core/types.js";
import { SocialError } from "../core/errors.js";

const deadlines = new WeakMap<AdapterOperationContext, number>();

const writes = new WeakSet<AdapterOperationContext>();

/** Sequential requests sharing an operation context consume one elapsed budget. */
export function remainingBudget(context: AdapterOperationContext, now = performance.now()): number {
  const duration = context.retryBudget.maxElapsedMs;

  if (!Number.isFinite(duration) || duration <= 0)
    throw new SocialError({
      code: "invalid_input",
      operation: "transport",
      message: "Elapsed request budget must be positive and finite.",
    });
  let deadline = deadlines.get(context);

  if (deadline === undefined) {
    deadline = now + duration;
    deadlines.set(context, deadline);
  }

  const remaining = deadline - now;

  if (remaining <= 0)
    throw writes.has(context)
      ? new SocialError({
          code: "timeout",
          operation: "transport",
          message:
            "The operation exhausted its elapsed request budget after an earlier write was sent; reconcile before retrying.",
          retryDisposition: { kind: "reconcile-first" },
        })
      : new SocialError({
          code: "timeout",
          operation: "transport",
          message: "The operation exhausted its elapsed request budget before the next dispatch.",
          retryDisposition: { kind: "never" },
        });

  return remaining;
}

/**
 * The budget for one request. A write marks the context, so if a later request in the same
 * operation runs out of budget its error says to reconcile first instead of `never`: the
 * earlier write may have taken effect. The mark is set before dispatch, which errs toward
 * reconciling.
 */
export function requestBudget(
  context: AdapterOperationContext,
  request: { readonly write: boolean },
  now = performance.now(),
): number {
  const remaining = remainingBudget(context, now);

  if (request.write) writes.add(context);

  return remaining;
}
