import { SocialError } from "../core/errors.js";
import type { JsonObject, MediaAttachment } from "../core/types.js";
import { readJson } from "../transport/http.js";
import { object, string } from "../transport/validation.js";

export interface YouTubeUploadSession {
  /** Secret upload URI. Store server-side; never serialize into public references. */
  readonly url: string;
  readonly size: number;
  readonly mimeType: string;
  readonly channelId: string;
}

export interface YouTubeUploadOptions {
  accessToken: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Internal absolute deadline shared by a resumable invocation. */
  readonly deadlineAt?: number;
}

const deadlines = new WeakMap<object, number>();

function deadlineFor(options: YouTubeUploadOptions): number {
  if (options.deadlineAt !== undefined) return options.deadlineAt;
  const existing = deadlines.get(options);

  if (existing !== undefined) return existing;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  deadlines.set(options, deadline);

  return deadline;
}

function remaining(options: YouTubeUploadOptions): number {
  const limit = deadlineFor(options);

  return limit - Date.now();
}

async function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  if (timeoutMs <= 0) {
    operation.catch(() => undefined);
    throw new SocialError({
      code: "timeout",
      operation: "youtube.upload",
      message,
      retryDisposition: { kind: "reconcile-first" },
    });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new SocialError({
            code: "timeout",
            operation: "youtube.upload",
            message,
            retryDisposition: { kind: "reconcile-first" },
          }),
        ),
      timeoutMs,
    );
  });

  operation.catch(() => undefined);

  const cancelled = signal
    ? new Promise<never>((_, reject) =>
        signal.addEventListener(
          "abort",
          () =>
            reject(
              new SocialError({
                code: "cancelled",
                operation: "youtube.upload",
                message: "Upload was cancelled.",
                retryDisposition: { kind: "never" },
              }),
            ),
          { once: true },
        ),
      )
    : undefined;

  try {
    return await Promise.race(cancelled ? [operation, timeout, cancelled] : [operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sessionUrl(value: string): URL {
  const url = new URL(value);

  if (
    url.origin !== "https://www.googleapis.com" ||
    url.pathname !== "/upload/youtube/v3/videos" ||
    url.username ||
    url.password
  ) {
    throw new SocialError({
      code: "media_error",
      operation: "youtube.upload",
      message: "YouTube returned an unexpected upload origin or route.",
    });
  }

  return url;
}

async function uploadRequest(
  url: URL,
  init: RequestInit,
  options: YouTubeUploadOptions,
): Promise<Response> {
  if (options.signal?.aborted)
    throw new SocialError({
      code: "cancelled",
      operation: "youtube.upload",
      message: "Upload was cancelled before this request.",
    });

  if (remaining(options) <= 0)
    throw new SocialError({
      code: "timeout",
      operation: "youtube.upload",
      message: "YouTube upload deadline expired before dispatch.",
      retryDisposition: { kind: "reconcile-first" },
    });
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), remaining(options));

  try {
    const response = await bounded(
      (options.fetch ?? globalThis.fetch)(url, {
        ...init,
        headers: { Authorization: `Bearer ${options.accessToken}`, ...init.headers },
        signal: controller.signal,
        redirect: "error",
      }),
      remaining(options),
      "YouTube upload request exceeded its total deadline.",
      options.signal,
    );

    // Read response within the deadline, then return a bounded in-memory response.
    if (response.status === 308) {
      void response.body?.cancel().catch(() => undefined);

      return new Response(null, { status: response.status, headers: response.headers });
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new SocialError({
        code: response.status >= 500 ? "ambiguous_outcome" : "media_error",
        operation: "youtube.upload",
        message: `YouTube upload request failed with HTTP ${response.status}.`,
        upstreamStatus: response.status,
        retryDisposition: response.status >= 500 ? { kind: "reconcile-first" } : { kind: "never" },
      });
    }

    if (response.status === 204 || response.headers.get("content-length") === "0") {
      void response.body?.cancel().catch(() => undefined);

      return new Response(null, { status: response.status, headers: response.headers });
    }

    if (init.method === "POST") {
      void response.body?.cancel().catch(() => undefined);

      return new Response(null, { status: response.status, headers: response.headers });
    }

    const body = await bounded(
      readJson(response, 2 * 1024 * 1024, controller.signal),
      remaining(options),
      "YouTube upload response exceeded its total deadline.",
      options.signal,
    );

    return Response.json(body, { status: response.status, headers: response.headers });
  } catch (error) {
    if (error instanceof SocialError) throw error;
    throw new SocialError({
      code: "ambiguous_outcome",
      operation: "youtube.upload",
      message: "YouTube upload acceptance is uncertain. Query the saved session before resuming.",
      retryDisposition: { kind: "reconcile-first" },
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function beginYouTubeUpload(
  input: { channelId: string; size: number; mimeType: string; metadata: JsonObject },
  options: YouTubeUploadOptions,
): Promise<YouTubeUploadSession> {
  if (
    !Number.isSafeInteger(input.size) ||
    input.size <= 0 ||
    input.size > 274877906944 ||
    !input.mimeType.startsWith("video/")
  )
    throw new SocialError({
      code: "invalid_input",
      operation: "youtube.upload",
      message: "Provide a positive video byte size no larger than 256 GiB and its video MIME type.",
    });

  const response = await uploadRequest(
    new URL(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status,processingDetails",
    ),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(input.size),
        "X-Upload-Content-Type": input.mimeType,
      },
      body: JSON.stringify(input.metadata),
    },
    options,
  );

  const url = string(response.headers.get("location"));
  sessionUrl(url);

  return { url, size: input.size, mimeType: input.mimeType, channelId: input.channelId };
}

export type YouTubeUploadStatus =
  | { state: "incomplete"; nextByte: number }
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated boundary or fixture contract.
  | { state: "complete"; video: Record<string, unknown> };

async function statusFrom(response: Response): Promise<YouTubeUploadStatus> {
  if (response.status !== 308) return { state: "complete", video: object(await response.json()) };
  const range = response.headers.get("range");

  if (!range) return { state: "incomplete", nextByte: 0 };
  const matched = /^bytes=0-(\d+)$/.exec(range);

  if (!matched?.[1])
    throw new SocialError({
      code: "media_error",
      operation: "youtube.upload",
      message: "YouTube returned an invalid upload range.",
    });
  const nextByte = Number(matched[1]) + 1;

  if (!Number.isSafeInteger(nextByte))
    throw new SocialError({
      code: "media_error",
      operation: "youtube.upload",
      message: "YouTube returned an invalid upload offset.",
    });

  return { state: "incomplete", nextByte };
}

export async function queryYouTubeUpload(
  session: YouTubeUploadSession,
  options: YouTubeUploadOptions,
): Promise<YouTubeUploadStatus> {
  return statusFrom(
    await uploadRequest(
      sessionUrl(session.url),
      {
        method: "PUT",
        headers: { "Content-Range": `bytes */${session.size}`, "Content-Length": "0" },
      },
      options,
    ),
  );
}

/** Explicit resumption reopens the caller's replayable source and skips confirmed bytes. */
export async function sendYouTubeUpload(
  session: YouTubeUploadSession,
  media: MediaAttachment,
  options: YouTubeUploadOptions,
  startByte = 0,
): Promise<YouTubeUploadStatus> {
  if (!Number.isSafeInteger(startByte) || startByte < 0 || startByte >= session.size)
    throw new SocialError({
      code: "invalid_input",
      operation: "youtube.upload",
      message: "Resume at a confirmed offset within the file.",
    });
  const operationOptions = options;
  const source = media.source;

  if (source.kind !== "blob" && source.kind !== "stream")
    throw new SocialError({
      code: "invalid_input",
      operation: "youtube.upload",
      message:
        "Direct YouTube uploads require a Blob or replayable stream; remote URLs are not fetched.",
    });
  const reader = (source.kind === "blob" ? source.blob.stream() : source.open()).getReader();
  const chunkBytes = 8 * 1024 * 1024;
  let buffered = new Uint8Array(0);
  let cursor = 0;
  let offset = startByte;
  let skipped = 0;
  let ended = false;

  try {
    while (offset < session.size) {
      const wanted = Math.min(chunkBytes, session.size - offset);
      const chunk = new Uint8Array(wanted);
      let written = 0;

      while (written < wanted) {
        operationOptions.signal?.throwIfAborted();

        if (cursor === buffered.byteLength) {
          const next = await bounded(
            reader.read(),
            remaining(operationOptions),
            "YouTube upload source exceeded its total deadline.",
            operationOptions.signal,
          );

          if (next.done) {
            ended = true;
            break;
          }

          if (next.value.byteLength > chunkBytes)
            throw new SocialError({
              code: "media_error",
              operation: "youtube.upload",
              message: "Source chunks must be at most 8 MiB.",
            });
          buffered = new Uint8Array(next.value);
          cursor = 0;
        }

        if (skipped < startByte) {
          const skip = Math.min(startByte - skipped, buffered.byteLength - cursor);
          skipped += skip;
          cursor += skip;
          continue;
        }

        const take = Math.min(wanted - written, buffered.byteLength - cursor);
        chunk.set(buffered.subarray(cursor, cursor + take), written);
        written += take;
        cursor += take;
      }

      if (ended || written !== wanted)
        throw new SocialError({
          code: "media_error",
          operation: "youtube.upload",
          message: "Source ended before its declared byte size.",
        });

      if (offset + wanted === session.size) {
        // Confirm the declared size before sending the chunk that finalizes publication.
        if (
          cursor < buffered.byteLength ||
          !(
            await bounded(
              reader.read(),
              remaining(operationOptions),
              "YouTube upload source exceeded its total deadline.",
              operationOptions.signal,
            )
          ).done
        ) {
          throw new SocialError({
            code: "media_error",
            operation: "youtube.upload",
            message: "Source exceeds its declared byte size.",
          });
        }
      }

      const result = await statusFrom(
        await uploadRequest(
          sessionUrl(session.url),
          {
            method: "PUT",
            headers: {
              "Content-Type": session.mimeType,
              "Content-Length": String(wanted),
              "Content-Range": `bytes ${offset}-${offset + wanted - 1}/${session.size}`,
            },
            body: chunk,
          },
          operationOptions,
        ),
      );

      if (result.state === "complete") return result;

      if (result.nextByte !== offset + wanted) return result;
      offset = result.nextByte;
    }

    return { state: "incomplete", nextByte: offset };
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
