import type { SocialErrorCode } from "../core/errors.js";
import type { MediaAttachment, MediaInput } from "../core/types.js";
import { abortable } from "../transport/http.js";
import { fetchWithoutRedirects } from "../transport/redirect.js";
import { httpsUrl } from "../transport/upload.js";

// Source, accessed 2026-10-24: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
// Chunks are 5 to 64 MB; the final chunk absorbs the remainder up to 128 MB; at most 1,000 chunks.
// Files smaller than one chunk upload whole, with chunk_size equal to video_size.
const mebibyte = 1024 * 1024;

export const tiktokMinChunkBytes = 5 * mebibyte;

export const tiktokMaxChunkBytes = 64 * mebibyte;

export const tiktokDefaultChunkBytes = 10 * mebibyte;

const maxFinalChunkBytes = 128 * mebibyte;

const maxChunkCount = 1000;

export const tiktokMaxVideoBytes = 4 * 1024 * mebibyte;

export const tiktokVideoMimeTypes = ["video/mp4", "video/quicktime", "video/webm"] as const;

export type TikTokVideoMimeType = (typeof tiktokVideoMimeTypes)[number];

export function isTikTokVideoMimeType(value: unknown): value is TikTokVideoMimeType {
  return tiktokVideoMimeTypes.some((mime) => mime === value);
}

export type TikTokLocalSource = Extract<MediaInput, { kind: "blob" } | { kind: "stream" }>;

export interface TikTokChunkPlan {
  readonly videoSize: number;
  readonly chunkSize: number;
  readonly totalChunkCount: number;
}

export interface TikTokLocalVideo {
  readonly source: TikTokLocalSource;
  readonly mimeType: TikTokVideoMimeType;
  readonly plan: TikTokChunkPlan;
}

export type TikTokLocalVideoResult =
  | { readonly kind: "valid"; readonly video: TikTokLocalVideo }
  | { readonly kind: "invalid"; readonly code: string; readonly message: string };

export function isTikTokChunkBytes(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value >= tiktokMinChunkBytes && value <= tiktokMaxChunkBytes
  );
}

/** `chunkBytes` is a validated preferred chunk size from 5 to 64 MiB. */
export function planTikTokChunks(
  videoSize: number,
  chunkBytes: number,
): TikTokChunkPlan | undefined {
  if (!Number.isSafeInteger(videoSize) || videoSize <= 0 || videoSize > tiktokMaxVideoBytes)
    return undefined;

  if (videoSize <= chunkBytes) return { videoSize, chunkSize: videoSize, totalChunkCount: 1 };

  const totalChunkCount = Math.floor(videoSize / chunkBytes);
  const finalChunk = videoSize - (totalChunkCount - 1) * chunkBytes;

  if (totalChunkCount > maxChunkCount || finalChunk > maxFinalChunkBytes) return undefined;

  return { videoSize, chunkSize: chunkBytes, totalChunkCount };
}

/**
 * Checks a local video before any provider request. Blobs use their actual size; streams need a
 * positive declared `byteSize`, which the transfer then enforces byte for byte.
 */
export function localTikTokVideo(
  media: MediaAttachment,
  source: TikTokLocalSource,
  chunkBytes: number,
): TikTokLocalVideoResult {
  const mimeType = media.mimeType;

  if (!isTikTokVideoMimeType(mimeType))
    return {
      kind: "invalid",
      code: "tiktok.mime",
      message:
        "Local TikTok videos need an explicit video/mp4, video/quicktime, or video/webm type.",
    };

  const size = source.kind === "blob" ? source.blob.size : media.byteSize;

  if (source.kind === "blob" && media.byteSize !== undefined && media.byteSize !== size)
    return {
      kind: "invalid",
      code: "tiktok.size",
      message: "Declared byteSize does not match the Blob size.",
    };

  const plan = size === undefined ? undefined : planTikTokChunks(size, chunkBytes);

  if (plan === undefined)
    return {
      kind: "invalid",
      code: "tiktok.size",
      message:
        source.kind === "stream"
          ? "Stream videos need a positive declared byteSize up to 4 GiB."
          : "TikTok videos must be between 1 byte and 4 GiB.",
    };

  return { kind: "valid", video: { source, mimeType, plan } };
}

const uploadHost = /^open-upload(?:-[a-z0-9]+)*\.tiktokapis\.com$/;

/** Accepts only provider-issued HTTPS upload URLs on known TikTok upload hosts. */
export function tiktokUploadUrl(value: string): URL | undefined {
  try {
    const url = httpsUrl(value);

    return uploadHost.test(url.hostname) ? url : undefined;
  } catch {
    return undefined;
  }
}

export type TikTokTransferResult =
  | { readonly kind: "complete" }
  /** The upload cannot complete; no final chunk was accepted. */
  | {
      readonly kind: "failed";
      readonly code: SocialErrorCode;
      readonly message: string;
      readonly upstreamStatus?: number;
    }
  /** The final chunk was dispatched without a definitive answer; TikTok may still publish. */
  | { readonly kind: "uncertain"; readonly message: string }
  | { readonly kind: "cancelled" };

type ChunkRead =
  | { readonly kind: "bytes"; readonly body: Blob | Uint8Array<ArrayBuffer> }
  | { readonly kind: "mismatch"; readonly message: string };

interface ChunkSource {
  readonly read: (start: number, end: number, signal: AbortSignal) => Promise<ChunkRead>;
  readonly release: () => void;
}

function blobChunks(blob: Blob, mimeType: string): ChunkSource {
  return {
    read: async (start, end) => ({ kind: "bytes", body: blob.slice(start, end, mimeType) }),
    release: () => undefined,
  };
}

/** Buffers one chunk at a time, so memory stays bounded by the chunk size. */
function streamChunks(open: () => ReadableStream<Uint8Array>, videoSize: number): ChunkSource {
  const reader = open().getReader();
  let buffered: Uint8Array = new Uint8Array(0);
  let cursor = 0;

  return {
    async read(start, end, signal) {
      const chunk = new Uint8Array(end - start);
      let written = 0;

      while (written < chunk.byteLength) {
        if (cursor === buffered.byteLength) {
          const next = await abortable(reader.read(), signal);

          if (next.done)
            return { kind: "mismatch", message: "Stream ended before its declared byteSize." };

          buffered = next.value;
          cursor = 0;
          continue;
        }

        const take = Math.min(chunk.byteLength - written, buffered.byteLength - cursor);
        chunk.set(buffered.subarray(cursor, cursor + take), written);
        written += take;
        cursor += take;
      }

      // Prove the declared size before sending the chunk that completes the upload.
      if (end === videoSize) {
        while (cursor === buffered.byteLength) {
          const next = await abortable(reader.read(), signal);

          if (next.done) return { kind: "bytes", body: chunk };

          buffered = next.value;
          cursor = 0;
        }

        return { kind: "mismatch", message: "Stream exceeds its declared byteSize." };
      }

      return { kind: "bytes", body: chunk };
    },
    release() {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    },
  };
}

/**
 * Sends each chunk once to the provider-issued upload URL. The URL carries its own upload token,
 * so requests have no API authorization, follow no redirects, and are never retried.
 */
export async function transferTikTokVideo(input: {
  readonly uploadUrl: URL;
  readonly video: TikTokLocalVideo;
  readonly fetch: typeof globalThis.fetch;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
}): Promise<TikTokTransferResult> {
  const { plan, mimeType, source } = input.video;

  if (input.signal?.aborted) return { kind: "cancelled" };

  if (!(input.timeoutMs > 0))
    return {
      kind: "failed",
      code: "timeout",
      message: "The request budget expired before the TikTok upload started.",
    };

  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });

  const timer = setTimeout(
    () => controller.abort(new Error("TikTok upload deadline exceeded")),
    input.timeoutMs,
  );

  let chunks: ChunkSource | undefined;
  let finalDispatched = false;

  const interrupted = (): TikTokTransferResult =>
    finalDispatched
      ? {
          kind: "uncertain",
          message:
            "The final TikTok upload chunk was interrupted. Check the publish status before retrying.",
        }
      : input.signal?.aborted
        ? { kind: "cancelled" }
        : controller.signal.aborted
          ? {
              kind: "failed",
              code: "timeout",
              message: "The TikTok upload exceeded its request budget before the final chunk.",
            }
          : {
              kind: "failed",
              code: "media_error",
              message: "The TikTok upload stopped before the final chunk.",
            };

  try {
    chunks =
      source.kind === "blob"
        ? blobChunks(source.blob, mimeType)
        : streamChunks(source.open, plan.videoSize);

    for (let index = 0; index < plan.totalChunkCount; index++) {
      const start = index * plan.chunkSize;
      const final = index === plan.totalChunkCount - 1;
      const end = final ? plan.videoSize : start + plan.chunkSize;
      const chunk = await chunks.read(start, end, controller.signal);

      if (chunk.kind === "mismatch")
        return { kind: "failed", code: "media_error", message: chunk.message };

      finalDispatched = final;

      const response = await abortable(
        fetchWithoutRedirects(input.fetch, input.uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": mimeType,
            "Content-Length": String(end - start),
            "Content-Range": `bytes ${start}-${end - 1}/${plan.videoSize}`,
          },
          body: chunk.body,
          signal: controller.signal,
        }),
        controller.signal,
      );

      void response.body?.cancel().catch(() => undefined);

      if (!response.ok) {
        if (final && response.status >= 500)
          return {
            kind: "uncertain",
            message: `TikTok answered the final upload chunk with HTTP ${response.status}. Check the publish status before retrying.`,
          };

        return {
          kind: "failed",
          code: response.status === 429 ? "rate_limited" : "media_error",
          message: `TikTok rejected upload chunk ${index + 1} of ${plan.totalChunkCount} with HTTP ${response.status}.`,
          upstreamStatus: response.status,
        };
      }
    }

    return { kind: "complete" };
  } catch {
    return interrupted();
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    chunks?.release();
  }
}
