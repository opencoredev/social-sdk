import { httpsUrl } from "../transport/upload.js";
import type { MediaStagingProvider, StagedMedia } from "./media.js";
import { needsStaging } from "./media-validation.js";
import type {
  CapabilityConstraints,
  ConnectedAccountRef,
  MediaAttachment,
  MediaInput,
  PublishContent,
} from "./types.js";

/** Removes one staged copy. */
export type StagingLease = () => Promise<void>;

export type StagingResult =
  | {
      readonly kind: "staged";
      readonly content: PublishContent;
      readonly leases: readonly StagingLease[];
    }
  | {
      readonly kind: "failed";
      /** `cancelled` when the signal aborted between stage calls. */
      readonly reason: "cancelled" | "staging-failed" | "invalid-url";
      /** Copies staged before the failure; nothing reached the platform, so all are removable. */
      readonly leases: readonly StagingLease[];
    };

function isStagedMedia(
  value: unknown,
): value is { readonly url: string; readonly cleanup?: StagingLease } {
  return (
    typeof value === "object" &&
    value !== null &&
    "url" in value &&
    typeof value.url === "string" &&
    (!("cleanup" in value) || value.cleanup === undefined || typeof value.cleanup === "function")
  );
}

/** Late results have never reached a platform and are safe to release. */
function stageBeforeAbort(
  work: () => Promise<StagedMedia>,
  signal: AbortSignal,
): Promise<StagedMedia | undefined> {
  return new Promise((resolve, reject) => {
    let abandoned = false;

    const abort = () => {
      abandoned = true;
      reject(new Error("Staging stopped before submission"));
    };

    if (signal.aborted) {
      abort();

      return;
    }

    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(work)
      .then(async (result) => {
        signal.removeEventListener("abort", abort);

        if (abandoned) {
          if (isStagedMedia(result) && result.cleanup !== undefined)
            await releaseLeases([() => result.cleanup?.call(result) ?? Promise.resolve()]);
        } else resolve(isStagedMedia(result) ? result : undefined);
      })
      .catch(() => {
        signal.removeEventListener("abort", abort);
        reject(new Error("Media staging failed before submission"));
      });
  });
}

/**
 * Stages each local source the target cannot accept, one at a time so a
 * failure stops further uploads. Provider errors and URLs are never surfaced:
 * they may contain signed storage URLs.
 */
export async function stageContent(input: {
  readonly content: PublishContent;
  readonly constraints: CapabilityConstraints | undefined;
  readonly provider: MediaStagingProvider;
  readonly account: ConnectedAccountRef;
  readonly signal: AbortSignal | undefined;
  readonly maxElapsedMs: number;
}): Promise<StagingResult> {
  const leases: StagingLease[] = [];
  const media = input.content.media;

  if (media === undefined) return { kind: "staged", content: input.content, leases };

  if (!Number.isFinite(input.maxElapsedMs) || input.maxElapsedMs <= 0)
    return { kind: "failed", reason: "staging-failed", leases };

  const deadline = new AbortController();

  const signal =
    input.signal === undefined ? deadline.signal : AbortSignal.any([input.signal, deadline.signal]);

  const timer = setTimeout(() => deadline.abort(), Math.min(2_147_483_647, input.maxElapsedMs));

  const stage = async (
    source: MediaInput,
    attachment: MediaAttachment,
  ): Promise<MediaInput | StagingResult> => {
    if (!needsStaging(input.constraints, source, true)) return source;

    if (signal.aborted)
      return {
        kind: "failed",
        reason: input.signal?.aborted ? "cancelled" : "staging-failed",
        leases,
      };

    let result: StagedMedia | undefined;

    try {
      const context: Parameters<MediaStagingProvider["stageMedia"]>[1] = {
        account: input.account,
        attachment,
        signal,
      };

      result = await stageBeforeAbort(() => input.provider.stageMedia(source, context), signal);
    } catch {
      return {
        kind: "failed",
        reason: input.signal?.aborted ? "cancelled" : "staging-failed",
        leases,
      };
    }

    if (result === undefined) return { kind: "failed", reason: "staging-failed", leases };

    const stagedMedia = result;
    const cleanup = stagedMedia.cleanup;

    if (cleanup !== undefined) leases.push(() => cleanup.call(stagedMedia));

    try {
      return { kind: "https-url", url: httpsUrl(stagedMedia.url).href };
    } catch {
      return { kind: "failed", reason: "invalid-url", leases };
    }
  };

  const staged: MediaAttachment[] = [];

  try {
    for (const item of media) {
      const source = await stage(item.source, item);

      if ("leases" in source) return source;

      const attachment: MediaAttachment = { ...item, source };

      if (item.thumbnail !== undefined) {
        const thumbnail = await stage(item.thumbnail, item);

        if ("leases" in thumbnail) return thumbnail;

        staged.push({ ...attachment, thumbnail });
      } else staged.push(attachment);
    }

    return signal.aborted
      ? { kind: "failed", reason: input.signal?.aborted ? "cancelled" : "staging-failed", leases }
      : { kind: "staged", content: { ...input.content, media: staged }, leases };
  } finally {
    clearTimeout(timer);
  }
}

/** Attempts every cleanup with an independent one-second grace for the whole batch. */
export async function releaseLeases(leases: readonly StagingLease[]): Promise<void> {
  if (leases.length === 0) return;

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      Promise.allSettled(leases.map(async (lease) => lease())),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
