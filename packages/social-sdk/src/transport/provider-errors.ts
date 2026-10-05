import type { HttpErrorData } from "./http.js";
import type { JsonValue } from "./json.js";
import { isJsonObject, isJsonArray, isString } from "./validation.js";

/** Keep only recognized machine codes and an opaque reconciliation ID, never provider prose. */
export function providerErrorDecoder(origin: string, path: string) {
  return (body: JsonValue, status: number): HttpErrorData | undefined => {
    if (!isJsonObject(body)) return undefined;

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
