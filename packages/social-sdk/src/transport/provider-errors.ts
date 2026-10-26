import { SocialError } from "../core/errors.js";
import type { HttpErrorData } from "./http.js";
import type { JsonValue } from "./json.js";
import { isJsonObject, isJsonArray, isString } from "./validation.js";

// Meta Graph APIs report an invalid, expired, or revoked access token as an
// OAuthException with code 190, usually on HTTP 400 rather than 401. Source:
// https://developers.facebook.com/docs/graph-api/guides/error-handling (accessed 2026-10-24).
// Facebook video uploads use graph-video.facebook.com and Reels bytes go to rupload.facebook.com.
const metaGraphHosts = new Set([
  "graph.instagram.com",
  "graph.facebook.com",
  "graph-video.facebook.com",
  "rupload.facebook.com",
  "graph.threads.net",
]);

function hostname(origin: string): string | undefined {
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
}

/** Keep only recognized machine codes and an opaque reconciliation ID, never provider prose. */
export function providerErrorDecoder(origin: string, path: string) {
  return (body: JsonValue, status: number): HttpErrorData | undefined => {
    if (!isJsonObject(body)) return undefined;

    const host = hostname(origin);

    if (host !== undefined && metaGraphHosts.has(host)) {
      const error = body["error"];

      return isJsonObject(error) && error["code"] === 190
        ? { code: "oauth-token-invalid" }
        : undefined;
    }

    if (origin === "https://zernio.com/api" && path === "/v1/posts" && status === 409) {
      const details = body["details"];

      const id =
        body["existingPostId"] ?? (isJsonObject(details) ? details["existingPostId"] : undefined);

      if (isString(id) && /^[A-Za-z0-9_-]{1,128}$/.test(id))
        return { code: "idempotency_conflict", existingPostId: id };

      return body["code"] === "idempotency_conflict" ? { code: "idempotency_conflict" } : undefined;
    }

    if (
      (origin === "https://www.googleapis.com" ||
        origin === "https://youtubeanalytics.googleapis.com") &&
      status === 403
    ) {
      const error = body["error"];

      if (!isJsonObject(error) || !isJsonArray(error["errors"])) return undefined;

      if (
        error["errors"].some((entry) => isJsonObject(entry) && entry["reason"] === "quotaExceeded")
      )
        return { code: "quotaExceeded" };
    }

    if (origin === "https://api.x.com") {
      if (
        status === 429 &&
        (body["type"] === "https://api.twitter.com/2/problems/usage-capped" ||
          body["type"] === "https://api.x.com/2/problems/usage-capped")
      )
        return { code: "usage-capped" };

      // X reports attachment duration failures in the problem detail on post creation.
      // Inspect it only here; never carry the prose into errors or diagnostics.
      const detail = body["detail"];

      if (
        status === 403 &&
        path === "/2/tweets" &&
        isString(detail) &&
        (/(?:video|media).{0,80}duration.{0,80}(?:exceed|limit|too long)/i.test(detail) ||
          /^This user is not allowed to post a video longer than \d+(?:\.\d+)? minutes\.?$/i.test(
            detail,
          ))
      )
        return { code: "media-duration-exceeded" };
    }

    return undefined;
  };
}

/**
 * Reclassify a Meta Graph code 190 failure as a reconnect. The managed transport
 * keeps unknown provider codes as upstream failures, so Graph adapters call this
 * from their request wrappers. The message is fixed and never carries provider prose.
 * Other errors are returned unchanged.
 */
export function metaOAuthReconnect(error: SocialError): SocialError {
  if (error.upstreamCode !== "oauth-token-invalid") return error;

  return new SocialError({
    code: "reconnect_required",
    operation: error.operation,
    message: "The Meta access token is invalid, expired, or revoked. Reconnect the account.",
    backend: error.backend,
    correlationId: error.correlationId,
    upstreamStatus: error.upstreamStatus,
    upstreamCode: error.upstreamCode,
    retryDisposition: { kind: "after-reconnect" },
    cause: error,
  });
}
