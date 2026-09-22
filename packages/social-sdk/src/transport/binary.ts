import { abortable, HttpError } from "./http.js";

/** Bounded buffering for APIs that require one small binary image payload. */
export async function readBinary(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    for (;;) {
      const chunk = await abortable(reader.read(), signal);

      if (chunk.done) break;
      length += chunk.value.byteLength;

      if (length > maxBytes)
        throw new HttpError("Media exceeds its byte limit.", "invalid-input", false);
      chunks.push(chunk.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const result = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}
