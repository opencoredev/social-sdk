import { abortable, HttpError } from "./http.js";

/* oxlint-disable anti-slop/require-readable-spacing -- stream pull branches stay compact. */

export interface UploadSource {
  mimeType: string;
  size?: number;
  body?: Blob;
  /** Called exactly once per explicit upload. Return a fresh stream each time. */
  open: () => ReadableStream<Uint8Array>;
}

export interface UploadOptions {
  url: string;
  source: UploadSource;
  /** Trusted application/adapter policy, never browser-supplied. */
  allowHost: (hostname: string) => boolean;
  maxBytes: number;
  maxChunkBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  onProgress?: (bytes: number) => void;
}

export function httpsUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new HttpError("Media URL must be an absolute HTTPS URL.", "invalid-input", false);
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hash
  ) {
    throw new HttpError(
      "Media URL must use HTTPS port 443 without credentials or a fragment.",
      "invalid-input",
      false,
    );
  }

  const hostname = url.hostname.toLowerCase();

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.includes(":") ||
    /^\d+(\.\d+){3}$/.test(hostname)
  ) {
    throw new HttpError(
      "Local and IP-literal media hosts are not permitted.",
      "invalid-input",
      false,
    );
  }

  return url;
}

/** A provider-issued upload URL is used once, without API authorization or redirects. */
export async function upload(options: UploadOptions): Promise<{ bytes: number; etag?: string }> {
  const url = httpsUrl(options.url);

  if (!options.allowHost(url.hostname))
    throw new HttpError(
      "Upload host is outside the configured storage policy.",
      "invalid-input",
      false,
    );
  const maxChunkBytes = options.maxChunkBytes ?? 1024 * 1024;

  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes <= 0 ||
    !Number.isSafeInteger(maxChunkBytes) ||
    maxChunkBytes <= 0
  ) {
    throw new HttpError(
      "Upload size and chunk limits must be positive integers.",
      "invalid-input",
      false,
    );
  }

  const { source } = options;

  if (!/^(image|video|application)\/[a-z0-9.+-]+$/i.test(source.mimeType))
    throw new HttpError(
      "An explicit supported media MIME type is required.",
      "invalid-input",
      false,
    );

  if (
    source.size !== undefined &&
    (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > options.maxBytes)
  ) {
    throw new HttpError(
      "Media size exceeds the upload limit or is invalid.",
      "invalid-input",
      false,
    );
  }

  if (
    source.body !== undefined &&
    (source.body.size > options.maxBytes ||
      (source.size !== undefined && source.body.size !== source.size))
  )
    throw new HttpError(
      "Media body exceeds the upload limit or does not match its declared size.",
      "invalid-input",
      false,
    );

  if (options.signal?.aborted)
    throw new HttpError("Upload cancelled before opening the stream.", "cancelled", false);
  const timeout = options.timeoutMs ?? 120_000;

  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new HttpError("Upload deadline must be positive.", "invalid-input", false);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Upload deadline exceeded")), timeout);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let buffered: Uint8Array | undefined;
  let bufferedOffset = 0;
  let bytes = 0;
  let dispatched = false;

  try {
    reader = source.open().getReader();
    const sourceReader = reader;

    const bodyStream = new ReadableStream<Uint8Array>(
      {
        async pull(output) {
          try {
            controller.signal.throwIfAborted();

            if (buffered === undefined || bufferedOffset >= buffered.byteLength) {
              const next = await abortable(sourceReader.read(), controller.signal);

              if (next.done) {
                if (source.size !== undefined && bytes !== source.size)
                  throw new HttpError(
                    "Upload stream length does not match declared size.",
                    "invalid-input",
                    dispatched,
                  );
                output.close();

                return;
              }
              if (bytes + next.value.byteLength > options.maxBytes) {
                // oxlint-disable-next-line anti-slop/require-readable-spacing -- compact guarded error construction.
                throw new HttpError(
                  "Upload stream exceeds its total byte limit.",
                  "invalid-input",
                  dispatched,
                );
              }

              buffered = next.value;
              bufferedOffset = 0;
            }

            const chunk = buffered!.subarray(
              bufferedOffset,
              Math.min(buffered!.byteLength, bufferedOffset + maxChunkBytes),
            );

            bufferedOffset += chunk.byteLength;
            bytes += chunk.byteLength;
            output.enqueue(chunk);

            try {
              options.onProgress?.(bytes);
            } catch {
              /* diagnostics cannot alter upload */
            }
          } catch (error) {
            void sourceReader.cancel().catch(() => undefined);
            output.error(error);
          }
        },
        cancel(reason) {
          void sourceReader.cancel(reason).catch(() => undefined);
        },
      },
      { highWaterMark: 1 },
    );

    const requestBody = source.body ?? bodyStream;

    if (source.body !== undefined) bytes = source.body.size;
    const headers = new Headers({ "Content-Type": source.mimeType });

    if (source.size !== undefined) headers.set("Content-Length", String(source.size));

    const init: RequestInit & Partial<{ duplex: "half" }> = {
      method: "PUT",
      headers,
      body: requestBody,
      redirect: "error",
      signal: controller.signal,
    };

    if (source.body === undefined) init.duplex = "half";

    dispatched = true;
    const pending = (options.fetch ?? globalThis.fetch)(url, init);
    void pending.then(
      (response) => {
        if (controller.signal.aborted) void response.body?.cancel().catch(() => undefined);
      },
      () => undefined,
    );
    const response = await abortable(pending, controller.signal);
    void response.body?.cancel().catch(() => undefined);

    if (!response.ok)
      throw new HttpError(
        `Storage upload failed with HTTP ${response.status}.`,
        "http",
        true,
        response.status,
      );

    if (source.size !== undefined && bytes !== source.size)
      throw new HttpError(
        "Storage accepted before the full declared upload was consumed.",
        "invalid-response",
        true,
      );
    const etag = response.headers.get("etag");

    if (etag === null) return { bytes };

    return { bytes, etag };
  } catch (error) {
    if (options.signal?.aborted)
      throw new HttpError(
        "Upload cancelled; remote acceptance is uncertain after dispatch.",
        "cancelled",
        dispatched,
      );

    if (controller.signal.aborted)
      throw new HttpError("Upload deadline exceeded.", "timeout", dispatched);

    if (error instanceof HttpError) throw error;
    throw new HttpError(
      "Upload failed. Reconcile the upload before explicitly reopening its source.",
      "network",
      dispatched,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    void reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}
