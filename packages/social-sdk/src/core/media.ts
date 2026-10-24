import type { ConnectedAccountRef, MediaAttachment, MediaInput } from "./types.js";

/** A staged copy of local media at a URL the platform can fetch. */
export interface StagedMedia {
  /** Absolute HTTPS URL. It may be signed; the SDK never logs or returns it in errors. */
  readonly url: string;
  /**
   * Removes the staged copy. The SDK calls it only when no platform can still
   * fetch the URL: after a `published` outcome, or when the target never reached
   * the platform. Every other outcome (`accepted`, `processing`, `scheduled`,
   * `failed`, `unknown`) keeps the copy, so storage should also expire on a TTL
   * the application controls. A rejected cleanup never changes the outcome.
   */
  readonly cleanup?: () => Promise<void>;
}

/**
 * Application-owned storage that turns local media (`blob` or `stream`) into
 * HTTPS URLs for targets whose `posts.publish` capability accepts only
 * `https-url` sources, such as direct Instagram and Threads publishing.
 *
 * The SDK stages media only while publishing an authorized target, after an
 * idempotency replay has been ruled out, and inside the backend's concurrency
 * slot. `posts.prepare` never calls it.
 * Staging shares the publish retry budget and receives a signal that aborts
 * when that budget expires. Honor the signal to stop storage uploads promptly.
 */
export interface MediaStagingProvider {
  stageMedia(
    source: MediaInput,
    context: {
      readonly account: ConnectedAccountRef;
      readonly attachment: MediaAttachment;
      readonly signal?: AbortSignal;
    },
  ): Promise<StagedMedia>;
  /**
   * HTTPS origin of the URLs `stageMedia` returns, such as
   * `https://media.example.com`. Preparation validates targets against a
   * placeholder URL on this origin, so adapters that pin verified origins
   * (TikTok `PULL_FROM_URL`) can accept staged media. Defaults to a reserved
   * `.invalid` host.
   */
  readonly origin?: string;
}

export interface BytesOptions {
  /** Caller-owned content identity. Defaults to `sha256:<hex>` of the bytes. */
  readonly fingerprint?: string;
  readonly mimeType?: string;
}

function hex(digest: ArrayBuffer): string {
  let result = "";

  for (const byte of new Uint8Array(digest)) result += byte.toString(16).padStart(2, "0");

  return result;
}

/**
 * Wraps in-memory bytes as a `blob` media source. The bytes are copied, so
 * later changes to the caller's buffer do not change the fingerprint or the
 * uploaded content. Async because the default fingerprint uses Web Crypto,
 * which keeps the root import free of Node built-ins.
 */
export async function bytes(
  data: Uint8Array | ArrayBuffer,
  options: BytesOptions = {},
): Promise<Extract<MediaInput, { readonly kind: "blob" }>> {
  const copy = data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : new Uint8Array(data);

  const blob =
    options.mimeType === undefined
      ? new Blob([copy])
      : new Blob([copy], { type: options.mimeType });

  return {
    kind: "blob",
    blob,
    fingerprint:
      options.fingerprint ?? `sha256:${hex(await crypto.subtle.digest("SHA-256", copy))}`,
  };
}
