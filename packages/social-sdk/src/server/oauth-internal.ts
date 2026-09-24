import { SocialError } from "../core/errors.js";
import type { ConnectionAttempt } from "./connections.js";

// Internal helpers shared by the direct OAuth providers. Not exported from the package.

function fail(
  operation: string,
  message: string,
  code: "upstream_failure" | "invalid_input" | "unauthorized",
): never {
  throw new SocialError({ code, operation, message });
}

export async function readBounded(
  response: Response,
  maxBytes: number,
  operation: string,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    fail("oauth.config", "maxResponseBytes must be a positive safe integer", "invalid_input");

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const part = await reader.read();

      if (part.done) break;
      total += part.value.byteLength;

      if (total > maxBytes) {
        await reader.cancel();
        fail(
          operation,
          "OAuth provider response exceeded the configured size limit",
          "upstream_failure",
        );
      }

      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(merged);
}

export function validateCallback(input: {
  readonly callbackUrl: string;
  readonly attempt: ConnectionAttempt;
}): URL {
  let callback: URL;

  try {
    callback = new URL(input.callbackUrl);
  } catch {
    fail("connections.complete", "OAuth callback URL is invalid", "invalid_input");
  }

  let expected: URL;

  try {
    expected = new URL(input.attempt.redirectUri);
  } catch {
    fail("connections.complete", "OAuth attempt redirect URI is invalid", "invalid_input");
  }

  if (
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.username ||
    callback.password ||
    callback.hash
  )
    fail(
      "connections.complete",
      "OAuth callback does not match the registered redirect",
      "unauthorized",
    );

  for (const [key, value] of expected.searchParams)
    if (callback.searchParams.getAll(key).length !== 1 || callback.searchParams.get(key) !== value)
      fail(
        "connections.complete",
        "OAuth callback does not match the registered redirect",
        "unauthorized",
      );
  const states = callback.searchParams.getAll("state");

  if (states.length !== 1 || states[0] !== input.attempt.state)
    fail(
      "connections.complete",
      "OAuth callback state did not match the authenticated attempt",
      "unauthorized",
    );

  return callback;
}
