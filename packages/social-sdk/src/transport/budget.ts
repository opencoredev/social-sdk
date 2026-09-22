import type { AdapterOperationContext } from "../core/types.js";
import { SocialError } from "../core/errors.js";

const deadlines = new WeakMap<AdapterOperationContext, number>();

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
    throw new SocialError({
      code: "timeout",
      operation: "transport",
      message: "The operation exhausted its elapsed request budget before the next dispatch.",
      retryDisposition: { kind: "never" },
    });

  return remaining;
}
