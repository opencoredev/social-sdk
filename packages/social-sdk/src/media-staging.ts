import { SocialError } from "./core/errors.js";
import { isObjectInput, preparationIssue } from "./core/client-support.js";
import type { MediaStaging, StageTargetInput, StagedTarget } from "./core/extensions.js";
import type { MediaStagingProvider } from "./core/media.js";
import { DEFAULT_STAGING_ORIGIN, needsStaging } from "./core/media-validation.js";
import { releaseLeases, stageContent, type StagingLease } from "./core/staging.js";
import type { DeliveryOutcome, PreparedPublishTarget } from "./core/types.js";
import { httpsUrl } from "./transport/upload.js";

export type { MediaStagingProvider, StagedMedia } from "./core/media.js";

function stagingOrigin(provider: MediaStagingProvider): string {
  if (provider.origin === undefined) return DEFAULT_STAGING_ORIGIN;

  let origin: URL | undefined;

  try {
    origin = httpsUrl(provider.origin);
  } catch {
    origin = undefined;
  }

  if (origin === undefined || origin.href !== `${origin.origin}/` || origin.search !== "")
    throw new SocialError({
      code: "invalid_config",
      operation: "createSocial",
      message: "mediaStaging.origin must be a public HTTPS origin without a path",
    });

  return origin.origin;
}

/** A sanitized outcome for staging that stopped before anything reached the platform. */
function stagingFailure(
  target: PreparedPublishTarget,
  reason: "cancelled" | "staging-failed" | "invalid-url",
  observedAt: string,
): DeliveryOutcome {
  const base = { targetIndex: target.targetIndex, account: target.account, observedAt };

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

/**
 * Stages `blob` and `stream` media as HTTPS URLs for targets whose `posts.publish`
 * capability declares `mediaSources` without them, such as direct Instagram and
 * Threads: `createSocial({ ..., mediaStaging: localMediaStaging(provider) })`.
 * See {@link MediaStagingProvider} for when staged copies are removed and kept.
 */
export function localMediaStaging(provider: MediaStagingProvider): MediaStaging {
  if (!isObjectInput(provider) || !(provider.stageMedia instanceof Function))
    throw new SocialError({
      code: "invalid_config",
      operation: "createSocial",
      message: "mediaStaging must provide a stageMedia function",
    });

  const origin = stagingOrigin(provider);

  async function stage(input: StageTargetInput): Promise<StagedTarget> {
    const { target, constraints, context, signal, observedAt, revalidate } = input;

    if (
      !(target.content.media ?? []).some(
        (item) =>
          needsStaging(constraints, item.source, true) ||
          (item.thumbnail !== undefined && needsStaging(constraints, item.thumbnail, true)),
      )
    )
      return { kind: "unchanged" };

    let leases: readonly StagingLease[] = [];

    // Remove staged copies only when no platform can still fetch them. Accepted,
    // processing, scheduled, failed and unknown outcomes keep them for the
    // provider's asynchronous fetch or for reconciliation.
    const settle = async (outcome: DeliveryOutcome, enteredAdapter: boolean): Promise<void> => {
      if (
        leases.length > 0 &&
        (!enteredAdapter || outcome.state === "published" || outcome.state === "not-submitted")
      )
        await releaseLeases(leases);
    };

    const stopped = (outcome: DeliveryOutcome): StagedTarget => ({
      kind: "stopped",
      outcome,
      settle,
    });

    const started = Date.now();

    const staged = await stageContent({
      content: target.content,
      constraints,
      provider,
      account: target.account,
      signal,
      maxElapsedMs: context.retryBudget.maxElapsedMs,
    });

    leases = staged.leases;

    if (staged.kind === "failed")
      return stopped(stagingFailure(target, staged.reason, observedAt()));

    const remaining = context.retryBudget.maxElapsedMs - (Date.now() - started);

    if (remaining <= 0) return stopped(stagingFailure(target, "staging-failed", observedAt()));

    const dispatched: PreparedPublishTarget = { ...target, content: staged.content };
    const issues = revalidate(dispatched);

    if (issues.length > 0)
      return stopped({
        state: "not-submitted",
        targetIndex: target.targetIndex,
        account: target.account,
        observedAt: observedAt(),
        reason: "validation",
        issues,
      });

    return {
      kind: "staged",
      target: dispatched,
      context: { ...context, retryBudget: { ...context.retryBudget, maxElapsedMs: remaining } },
      settle,
    };
  }

  return { origin, stage };
}
