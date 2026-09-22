import { SocialError } from "../core/errors.js";
import type {
  AdapterOperationContext,
  BackendPostRef,
  JsonObject,
  PlatformPostRef,
  ScheduleCancellation,
  ScheduledJobRef,
} from "../core/types.js";
import { array, object, string } from "../transport/validation.js";
import { accountMatches, type managedHttp } from "./common.js";

type ScopedRef = BackendPostRef | ScheduledJobRef | PlatformPostRef;

type Request = ReturnType<typeof managedHttp>;

const reject = (message: string): never => {
  throw new SocialError({ code: "invalid_input", operation: "posts.lifecycle", message });
};

const unconfirmed = (): never => {
  throw new SocialError({
    code: "ambiguous_outcome",
    operation: "posts.lifecycle",
    message: "The provider did not confirm the mutation. Reconcile before retrying.",
    retryDisposition: { kind: "reconcile-first" },
  });
};

/** Mutations affect whole provider records. Reject records shared by destinations. */
export function managedLifecycle(
  provider: "zernio" | "post-for-me",
  request: Request,
  now: () => string,
) {
  const path = (id: string) =>
    `${provider === "zernio" ? "/v1/posts" : "/v1/social-posts"}/${encodeURIComponent(id)}`;

  async function owned(
    ref: ScopedRef,
    id: string,
    context: AdapterOperationContext,
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- provider payload is validated at this adapter boundary.
  ): Promise<Record<string, unknown>> {
    accountMatches(ref, context);

    if (!id) reject("A backend record identifier is required.");
    const response = object(await request(path(id), context));
    const record = object(response["post"] ?? response);

    if (record[provider === "zernio" ? "_id" : "id"] !== id)
      reject("Provider returned a different backend record.");

    const entries = array(record[provider === "zernio" ? "platforms" : "social_accounts"]).map(
      object,
    );

    if (entries.length !== 1)
      reject("This operation requires a backend record with exactly one destination.");
    const entry = entries[0]!;
    const rawId = provider === "zernio" ? entry["accountId"] : entry["id"];
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
    const accountId = typeof rawId === "string" ? rawId : object(rawId)["_id"];
    const platform = entry["platform"] === "twitter" ? "x" : entry["platform"];

    if (accountId !== ref.accountId || platform !== ref.platform)
      throw new SocialError({
        code: "unauthorized",
        operation: "posts.lifecycle",
        message: "Backend record does not belong to the authorized account and platform.",
      });

    return record;
  }

  async function deleteRecord(id: string, context: AdapterOperationContext): Promise<void> {
    const response = object(await request(path(id), context, undefined, {}, "DELETE"));

    if (
      provider === "post-for-me"
        ? response["success"] !== true
        : response["message"] !== "Post deleted successfully"
    )
      unconfirmed();
  }

  return {
    async cancelScheduled(
      ref: ScheduledJobRef,
      context: AdapterOperationContext,
    ): Promise<ScheduleCancellation> {
      const record = await owned(ref, ref.jobId, context);
      const scheduledAt = record[provider === "zernio" ? "scheduledFor" : "scheduled_at"];

      if (
        record["status"] !== "scheduled" ||
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
        typeof scheduledAt !== "string" ||
        !Number.isFinite(Date.parse(scheduledAt)) ||
        Date.parse(scheduledAt) <= Date.parse(now())
      )
        reject(
          "Only a future scheduled record can be cancelled. Reconcile a due or dispatched post.",
        );

      if (provider === "zernio") {
        await deleteRecord(ref.jobId, context);

        return { state: "cancelled", backendRecord: "deleted" };
      }

      // A missing/null scheduled_at means publish immediately. Keep the timestamp.
      // oxlint-disable-next-line anti-slop/no-known-value-widening -- provider payload is validated at this adapter boundary.
      const body: Record<string, import("../core/types.js").JsonValue> = {
        caption: string(record["caption"]),
        social_accounts: [ref.accountId],
        scheduled_at: string(scheduledAt),
        isDraft: true,
      };

      for (const key of [
        "media",
        "platform_configurations",
        "account_configurations",
        "external_id",
      ]) {
        if (record[key] !== undefined && record[key] !== null)
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
          body[key] = record[key] as JsonObject;
      }

      const result = object(await request(path(ref.jobId), context, body, {}, "PUT"));

      if (result["id"] !== ref.jobId || result["status"] !== "draft") unconfirmed();

      return { state: "cancelled", backendRecord: "retained" };
    },
    async deleteBackendRecord(
      ref: BackendPostRef,
      context: AdapterOperationContext,
    ): Promise<void> {
      const record = await owned(ref, ref.recordId, context);

      if (record["status"] !== "draft")
        reject(
          "Delete only a draft backend record. Cancel a future schedule explicitly; never infer native deletion.",
        );
      await deleteRecord(ref.recordId, context);
    },
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
    ...(provider === "zernio"
      ? {
          async removeFromPlatform(
            ref: PlatformPostRef,
            context: AdapterOperationContext,
          ): Promise<void> {
            if (
              !["x", "threads", "bluesky", "youtube", "linkedin", "facebook"].includes(ref.platform)
            )
              reject("Zernio does not support native removal for this platform.");
            const id = string(ref.native?.["backendRecordId"]);
            const record = await owned(ref, id, context);
            const entry = object(array(record["platforms"])[0]);

            if (entry["status"] !== "published" || entry["platformPostId"] !== ref.postId)
              reject("The backend record does not identify this published native post.");

            const result = object(
              await request(`${path(id)}/unpublish`, context, {
                platform: ref.platform === "x" ? "twitter" : ref.platform,
              }),
            );

            if (result["success"] !== true) unconfirmed();
          },
        }
      : {}),
  };
}
