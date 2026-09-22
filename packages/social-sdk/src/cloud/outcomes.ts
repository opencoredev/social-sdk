import type { ConnectedAccountRef, DeliveryOutcome, DeliveryRef } from "../core/types.js";
import { array, object, optionalString, string } from "../transport/validation.js";

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

/** Never infer destination success from the aggregate HTTP/parent status. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- provider payload is validated at this adapter boundary.
export function zernioOutcome(value: unknown, context: OutcomeContext): DeliveryOutcome {
  const response = object(value);
  const post = object(response["post"] ?? response["existingPost"] ?? response);
  const postId = string(post["_id"]);
  const platform = context.account.platform === "x" ? "twitter" : context.account.platform;
  const entries = array(post["platforms"]).map(object);

  const matches = entries.filter((entry) => {
    const accountId =
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
      typeof entry["accountId"] === "string"
        ? entry["accountId"]
        : // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
          entry["accountId"] && typeof entry["accountId"] === "object"
          ? optionalString(object(entry["accountId"])["_id"])
          : undefined;

    return entry["platform"] === platform && accountId === context.account.accountId;
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
  const status = optionalString(entry["status"]) ?? "unknown";
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
      const url = optionalString(entry["platformPostUrl"]);

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

    case "failed":
      return {
        ...stateBase,
        state: "failed",
        code: optionalString(entry["errorCategory"]) ?? "upstream_failure",
        message:
          "Zernio reports that this destination failed. Inspect account permissions and sanitized provider diagnostics.",
        retryDisposition:
          entry["errorCategory"] === "auth_expired"
            ? { kind: "after-reconnect" }
            : { kind: "never" },
      };
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- provider payload is validated at this adapter boundary.
  parentValue: unknown,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- provider payload is validated at this adapter boundary.
  resultsValue: unknown | undefined,
  context: OutcomeContext,
): DeliveryOutcome {
  const parent = object(parentValue);
  const postId = string(parent["id"]);
  const backendState = optionalString(parent["status"]) ?? "unknown";
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
          const url = optionalString(data["url"]);

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
