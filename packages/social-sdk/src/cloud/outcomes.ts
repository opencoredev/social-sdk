import type {
  ConnectedAccountRef,
  DeliveryOutcome,
  DeliveryRef,
  JsonValue,
} from "../core/types.js";
import {
  array,
  isJsonArray,
  isJsonObject,
  isString,
  object,
  optionalString,
  string,
  type JsonField,
} from "../transport/validation.js";
import { postForMePlatform, samePlatform } from "./common.js";

export interface OutcomeContext {
  account: ConnectedAccountRef;
  targetIndex: number;
  observedAt: string;
}

function delivery(context: OutcomeContext, deliveryId: string): DeliveryRef {
  return {
    kind: "delivery",
    version: 1,
    backend: context.account.backend,
    platform: context.account.platform,
    accountId: context.account.accountId,
    deliveryId,
  };
}

/**
 * A provider status kept as a machine token: absent is `unknown`; a lowercase token passes; any
 * other value (prose, a URL, a wrong type) is `unrecognized`, so no provider text reaches an outcome.
 */
function statusToken(value: JsonField): string {
  if (value === undefined || value === null) return "unknown";

  return isString(value) && /^[a-z_]{1,32}$/.test(value) ? value : "unrecognized";
}

/** A published post's public link: an absolute HTTPS URL without credentials, else dropped. */
function publicPostUrl(value: JsonField): string | undefined {
  if (!isString(value) || !URL.canParse(value)) return undefined;
  const url = new URL(value);

  return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
}

/**
 * `platforms[].errorCategory` values Zernio documents (openapi.yaml 1.501.1, read 2026-11-05:
 * https://zernio.com/openapi.yaml). Anything else is reported as `upstream_failure`.
 */
const zernioErrorCategories: readonly string[] = [
  "auth_expired",
  "user_content",
  "user_abuse",
  "account_issue",
  "platform_rejected",
  "platform_error",
  "platform_rate_limit",
  "quota_exhausted",
  "system_error",
  "unknown",
];

/**
 * Never infer destination success from the aggregate HTTP/parent status. Provider strings are
 * checked: a failed destination keeps only a documented error category as its code, the backend
 * state only a status token, and the link only an HTTPS URL.
 */
export function zernioOutcome(value: JsonValue, context: OutcomeContext): DeliveryOutcome {
  const response = object(value);
  const post = object(response["post"] ?? response["existingPost"] ?? response);
  const postId = string(post["_id"]);
  const entries = array(post["platforms"]).map(object);

  const matches = entries.filter((entry) => {
    const rawAccountId = entry["accountId"];

    const accountId = isString(rawAccountId)
      ? rawAccountId
      : isJsonObject(rawAccountId) || isJsonArray(rawAccountId)
        ? optionalString(object(rawAccountId)["_id"])
        : undefined;

    return (
      samePlatform(entry["platform"], context.account.platform) &&
      accountId === context.account.accountId
    );
  });

  const base = { ...context, delivery: delivery(context, postId) };

  if (matches.length !== 1)
    return {
      ...base,
      state: "unknown",
      reason: "unmapped-state",
      diagnostic: "Response has no unique matching account outcome.",
    };
  const entry = matches[0];

  if (!entry) throw new Error("Missing matched outcome");
  const status = statusToken(entry["status"]);
  const stateBase = { ...base, backendState: status };

  switch (status) {
    case "published": {
      const nativeId = optionalString(entry["platformPostId"]);

      if (!nativeId)
        return {
          ...stateBase,
          state: "unknown",
          reason: "unmapped-state",
          diagnostic:
            "Provider reports publication without a native identifier; reconcile to resolve the native post.",
        };
      const url = publicPostUrl(entry["platformPostUrl"]);

      const published: DeliveryOutcome = {
        ...stateBase,
        state: "published",
        post: {
          kind: "platform-post",
          version: 1,
          backend: context.account.backend,
          platform: context.account.platform,
          accountId: context.account.accountId,
          postId: nativeId,
          native: { backendRecordId: postId },
        },
      };

      return url ? { ...published, url } : published;
    }

    case "failed": {
      const category = entry["errorCategory"];

      return {
        ...stateBase,
        state: "failed",
        code:
          isString(category) && zernioErrorCategories.includes(category)
            ? category
            : "upstream_failure",
        message:
          "Zernio reports that this destination failed. Inspect account permissions and sanitized provider diagnostics.",
        retryDisposition:
          entry["errorCategory"] === "auth_expired"
            ? { kind: "after-reconnect" }
            : { kind: "never" },
      };
    }

    case "cancelled":
      return { ...stateBase, state: "cancelled" };
    case "processing":
    case "uploading":
      return { ...stateBase, state: "processing" };
    case "pending":
      return post["status"] === "scheduled"
        ? {
            ...stateBase,
            state: "scheduled",
            job: {
              kind: "scheduled-job",
              version: 1,
              backend: context.account.backend,
              platform: context.account.platform,
              accountId: context.account.accountId,
              jobId: postId,
            },
          }
        : { ...stateBase, state: "accepted" };
    default:
      return {
        ...stateBase,
        state: "unknown",
        reason: "unmapped-state",
        diagnostic: "Unmapped destination status; no success or cancellation inferred.",
      };
  }
}

export function postForMeOutcome(
  parentValue: JsonValue,
  resultsValue: JsonField,
  context: OutcomeContext,
): DeliveryOutcome {
  const parent = object(parentValue);
  const postId = string(parent["id"]);
  const backendState = statusToken(parent["status"]);
  const base = { ...context, delivery: delivery(context, postId), backendState };

  if (resultsValue !== undefined) {
    const results = array(object(resultsValue)["data"]).map(object);

    const matches = results.filter(
      (result) =>
        result["post_id"] === postId && result["social_account_id"] === context.account.accountId,
    );

    if (matches.length > 1)
      return {
        ...base,
        state: "unknown",
        reason: "unmapped-state",
        diagnostic: "More than one result exists for the target; reconcile the provider records.",
      };
    const result = matches[0];

    if (result) {
      if (result["success"] === false)
        return {
          ...base,
          state: "failed",
          code: "upstream_failure",
          message: "Post for Me reports that this account's attempt failed.",
          retryDisposition: { kind: "never" },
        };

      if (result["success"] === true) {
        const data = object(result["platform_data"]);
        const postId = optionalString(data["id"]);

        if (postId) {
          const url = publicPostUrl(data["url"]);

          const published: DeliveryOutcome = {
            ...base,
            state: "published",
            post: {
              kind: "platform-post",
              version: 1,
              backend: context.account.backend,
              platform: context.account.platform,
              accountId: context.account.accountId,
              postId,
            },
          };

          return url ? { ...published, url } : published;
        }
      }

      return {
        ...base,
        state: "unknown",
        reason: "unmapped-state",
        diagnostic: "Destination result lacks a confirmed native post identifier.",
      };
    }
  }

  // Results are destination-specific; parent pending states require a matching owner too.
  const accounts = parent["social_accounts"];

  const owners = isJsonArray(accounts)
    ? accounts.filter((entry) => {
        if (isString(entry)) return entry === context.account.accountId;

        if (!isJsonObject(entry)) return false;

        return (
          entry["id"] === context.account.accountId &&
          (entry["platform"] === undefined ||
            samePlatform(postForMePlatform(entry["platform"]), context.account.platform))
        );
      })
    : [];

  if (owners.length !== 1)
    return {
      ...base,
      state: "unknown",
      reason: "unmapped-state",
      diagnostic: "Parent has no unique matching target account; reconcile before using its state.",
    };

  switch (backendState) {
    case "scheduled":
      return {
        ...base,
        state: "scheduled",
        job: {
          kind: "scheduled-job",
          version: 1,
          backend: context.account.backend,
          platform: context.account.platform,
          accountId: context.account.accountId,
          jobId: postId,
        },
      };
    case "processing":
      return { ...base, state: "processing" };
    case "processed":
      return {
        ...base,
        state: "unknown",
        reason: "unmapped-state",
        diagnostic: "The parent is processed, but this account has no confirmed result.",
      };
    default:
      return {
        ...base,
        state: "unknown",
        reason: "unmapped-state",
        diagnostic: "Unmapped parent status; no destination success inferred.",
      };
  }
}
