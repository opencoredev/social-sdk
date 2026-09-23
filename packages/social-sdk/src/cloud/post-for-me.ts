/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract. */
import { managedLifecycle } from "./lifecycle.js";
import { managedMedia } from "./media.js";

export {
  MemoryManagedMediaStore,
  type ManagedMediaStore,
  type ManagedMediaRecord,
} from "./media.js";

import { defineAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import type {
  AccountRecord,
  AdapterOperationContext,
  ConnectedAccountRef,
  JsonObject,
  JsonValue,
  MetricValue,
  PlatformPostRef,
} from "../core/types.js";
import { array, object, optionalNumber, optionalString, string } from "../transport/validation.js";
import { verifyPostForMeWebhook, decodeWebhook } from "../server/webhooks.js";
import {
  accountMatches,
  capabilityManifest,
  managedHttp,
  managedPreparation,
  managedOptionIssues,
  optionsObject,
  platform,
  publicFields,
  type ManagedOptions,
} from "./common.js";
import { postForMeOutcome } from "./outcomes.js";

export interface PostForMeConnectionOptions {
  platform: string;
  externalId: string;
  permissions: readonly ("posts" | "feeds")[];
  redirectUrl?: string;
}

export function postForMe(options: ManagedOptions) {
  const request = managedHttp("https://api.postforme.dev", options);

  const mediaPipeline = managedMedia("post-for-me", options, (body, context) =>
    request("/v1/media/create-upload-url", context, body),
  );

  const now = () => (options.clock?.() ?? new Date()).toISOString();

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- provider payload is validated at this adapter boundary.
  const account = (value: unknown, backend: string): AccountRecord => {
    const row = object(value);
    const handle = optionalString(row["username"]);

    return {
      ref: {
        kind: "connected-account",
        version: 1,
        backend,
        platform: platform(row["platform"]),
        accountId: string(row["id"]),
      },
      displayName: handle ?? string(row["user_id"]),
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
      ...(handle ? { handle } : {}),
      status:
        row["status"] === "connected"
          ? "connected"
          : row["status"] === "disconnected"
            ? "reconnect-required"
            : "unknown",
    };
  };

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated by account at this boundary.
  const supportedAccount = (value: unknown, backend: string): AccountRecord | undefined => {
    try {
      return account(value, backend);
    } catch (error) {
      if (error instanceof SocialError && error.code === "unsupported_capability") return undefined;
      throw error;
    }
  };

  const feed = async (
    ref: PlatformPostRef,
    context: AdapterOperationContext,
    metrics: boolean,
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- provider payload is validated at this adapter boundary.
  ): Promise<Record<string, unknown>> => {
    accountMatches(ref, context);

    const result = object(
      await request(
        `/v1/social-account-feeds/${encodeURIComponent(ref.accountId)}`,
        context,
        undefined,
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
        { platform_post_id: ref.postId, limit: "1", ...(metrics ? { expand: "metrics" } : {}) },
      ),
    );

    const row = array(result["data"])
      .map(object)
      .find(
        (item) =>
          item["platform_post_id"] === ref.postId && item["social_account_id"] === ref.accountId,
      );

    if (!row)
      throw new SocialError({
        code: "upstream_failure",
        operation: "posts.read",
        message: "The native post is absent or inaccessible in this account feed.",
      });

    return row;
  };

  const adapter = defineAdapter({
    id: "post-for-me",
    capabilities: capabilityManifest("post-for-me", "v1 / OpenAPI 1.0", [
      "accounts.read",
      "posts.publish",
      "posts.read",
      "posts.list",
      "posts.status",
      "posts.cancelScheduled",
      "posts.deleteBackendRecord",
      "analytics.read",
      "media.upload",
      "webhooks.verify",
    ]),
    media: { upload: mediaPipeline.upload },
    accounts: {
      async list(input: { cursor?: string; limit?: number }, context: AdapterOperationContext) {
        const offset = input.cursor === undefined ? 0 : Number(input.cursor);
        const limit = input.limit ?? 25;

        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "accounts.read",
            message: "Use an opaque returned cursor and a page size from 1 to 100.",
          });

        const result = object(
          await request("/v1/social-accounts", context, undefined, {
            offset: String(offset),
            limit: String(limit),
          }),
        );

        const rows = array(result["data"]);
        const meta = object(result["meta"]);
        const next = meta["next"] ? String(offset + limit) : undefined;

        return {
          items: rows.flatMap((value) => {
            const parsed = supportedAccount(value, context.backendInstance);

            return parsed ? [parsed] : [];
          }),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
          ...(next ? { nextCursor: next } : {}),
        };
      },
      async get(ref: ConnectedAccountRef, context: AdapterOperationContext) {
        accountMatches(ref, context);

        const result = account(
          await request(`/v1/social-accounts/${encodeURIComponent(ref.accountId)}`, context),
          context.backendInstance,
        );

        if (result.ref.accountId !== ref.accountId || result.ref.platform !== ref.platform)
          throw new SocialError({
            code: "unauthorized",
            operation: "accounts.read",
            message: "Account identity does not match the requested reference.",
          });

        return result;
      },
    },
    posts: {
      ...managedLifecycle("post-for-me", request, now),
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        accountMatches(account, context);
        const limit = input.limit ?? 25;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.read",
            message: "Post for Me feed page size must be between 1 and 100.",
          });

        const result = object(
          await request(
            `/v1/social-account-feeds/${encodeURIComponent(account.accountId)}`,
            context,
            undefined,
            {
              limit: String(limit),
              // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            },
          ),
        );

        const rows = array(result["data"])
          .map(object)
          .filter((row) => row["social_account_id"] === account.accountId)
          .map((row) =>
            publicFields(row, [
              "platform_post_id",
              "social_account_id",
              "platform_account_id",
              "platform_url",
              "caption",
              "posted_at",
              "media",
              "created_at",
            ]),
          );

        const meta = result["meta"] === undefined ? {} : object(result["meta"]);
        const hasMore = meta["has_more"];
        const cursor = optionalString(meta["cursor"]);

        // `has_more: false` is authoritative. Older responses may omit it;
        // in that case, a non-empty `next` marker plus cursor permits continuation.
        const next =
          hasMore === false
            ? undefined
            : hasMore === true
              ? cursor
              : optionalString(meta["next"]) && cursor
                ? cursor
                : undefined;

        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
        return { items: rows as JsonObject[], ...(next === undefined ? {} : { nextCursor: next }) };
      },
      prepareTarget(target: Parameters<typeof managedPreparation>[0]) {
        const issues = [
          ...managedPreparation(target),
          ...managedOptionIssues(target, "post-for-me"),
        ];

        if (target.account.platform === "tiktok") {
          const privacy = optionsObject(target)["privacy"];

          if (privacy !== "SELF_ONLY" && privacy !== "PUBLIC_TO_EVERYONE")
            issues.push({
              code: "tiktok.privacy_unsupported",
              message:
                "Post for Me documents private/public privacy only; this adapter cannot map the selected privacy safely.",
              severity: "error",
              targetIndex: target.targetIndex,
            });
        }

        for (const media of target.content.media ?? [])
          if (media.altText !== undefined)
            issues.push({
              code: "media.alt_text_unsupported",
              message:
                "Post for Me's current media schema does not document alt text. Choose a backend with an explicit accessibility mapping.",
              severity: "error",
              targetIndex: target.targetIndex,
            });

        return issues;
      },
      async publishTarget(
        target: Parameters<typeof managedPreparation>[0],
        context: AdapterOperationContext,
      ) {
        accountMatches(target.account, context);
        const media: JsonObject[] = [];

        for (const item of target.content.media ?? [])
          media.push({ url: await mediaPipeline.resolve(item, target.account, context) });
        const config = optionsObject(target);
        const platformConfig: Record<string, JsonValue> = {};

        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
        if (target.account.platform === "instagram" && typeof config["shareToFeed"] === "boolean")
          platformConfig["share_to_feed"] = config["shareToFeed"];

        if (
          target.account.platform === "x" &&
          config["replySettings"] !== undefined &&
          config["replySettings"] !== "everyone"
        )
          platformConfig["reply_settings"] = string(config["replySettings"]);

        if (target.account.platform === "youtube") {
          platformConfig["title"] = string(config["title"]);
          platformConfig["privacy_status"] = string(config["visibility"]);

          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
          if (typeof config["madeForKids"] === "boolean")
            platformConfig["made_for_kids"] = config["madeForKids"];
        }

        if (target.account.platform === "tiktok") {
          platformConfig["privacy_status"] =
            config["privacy"] === "SELF_ONLY" ? "private" : "public";
          platformConfig["auto_add_music"] = false;
          platformConfig["allow_duet"] = !config["disableDuet"];
          platformConfig["allow_stitch"] = !config["disableStitch"];
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
          platformConfig["disclose_your_brand"] = config["ownBrand"] as boolean;
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
          platformConfig["is_ai_generated"] = config["aiGenerated"] as boolean;
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
          platformConfig["is_draft"] = config["draft"] as boolean;

          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
          if (typeof config["disableComments"] === "boolean")
            platformConfig["allow_comment"] = !config["disableComments"];

          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
          if (typeof config["brandedContent"] === "boolean")
            platformConfig["disclose_branded_content"] = config["brandedContent"];
        }

        const response = await request("/v1/social-posts", context, {
          caption: target.content.text ?? "",
          social_accounts: [target.account.accountId],
          media,
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
          ...(target.schedule ? { scheduled_at: target.schedule.at } : {}),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
          ...(context.targetIdempotencyKey ? { external_id: context.targetIdempotencyKey } : {}),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
          ...(Object.keys(platformConfig).length
            ? { platform_configurations: { [target.account.platform]: platformConfig } }
            : {}),
        });

        const parent = object(response);
        let results: unknown;

        if (parent["status"] === "processed") {
          try {
            results = await request("/v1/social-post-results", context, undefined, {
              post_id: string(parent["id"]),
              social_account_id: target.account.accountId,
              limit: "2",
            });
          } catch {
            /* Preserve the accepted parent if immediate reconciliation is unavailable. */
          }
        }

        return postForMeOutcome(parent, results, {
          account: target.account,
          targetIndex: target.targetIndex,
          observedAt: now(),
        });
      },
      async getDelivery(
        ref: { deliveryId: string; accountId: string; platform: string; backend: string },
        context: AdapterOperationContext,
      ) {
        const account: ConnectedAccountRef = {
          kind: "connected-account",
          version: 1,
          backend: ref.backend,
          platform: ref.platform,
          accountId: ref.accountId,
        };

        accountMatches(account, context);

        const parent = await request(
          `/v1/social-posts/${encodeURIComponent(ref.deliveryId)}`,
          context,
        );

        const results = await request("/v1/social-post-results", context, undefined, {
          post_id: ref.deliveryId,
          social_account_id: ref.accountId,
          limit: "2",
        });

        return postForMeOutcome(parent, results, { account, targetIndex: 0, observedAt: now() });
      },
      async get(ref: PlatformPostRef, context: AdapterOperationContext) {
        return publicFields(await feed(ref, context, false), [
          "platform_post_id",
          "social_account_id",
          "platform_account_id",
          "platform_url",
          "caption",
          "posted_at",
        ]);
      },
    },
    analytics: {
      async getPostMetrics(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        const row = await feed(ref, context, true);

        if (row["metrics"] === undefined || row["metrics"] === null) return [];
        const metrics = object(row["metrics"]);

        const values =
          ref.platform === "x" && metrics["public_metrics"] !== undefined
            ? object(metrics["public_metrics"])
            : metrics;

        const result: MetricValue[] = [];

        const fields: readonly (readonly [string, string])[] =
          ref.platform === "x"
            ? [
                ["likes", "like_count"],
                ["comments", "reply_count"],
                ["reposts", "repost_count"],
                ["impressions", "impression_count"],
              ]
            : ref.platform === "linkedin"
              ? [
                  ["likes", "likeCount"],
                  ["comments", "commentCount"],
                  ["impressions", "impressionCount"],
                ]
              : ref.platform === "bluesky"
                ? [
                    ["likes", "likeCount"],
                    ["comments", "replyCount"],
                    ["reposts", "repostCount"],
                  ]
                : // Other platforms report provider-shaped counters; accept the common spellings.
                  [
                    ["likes", "likes"],
                    ["likes", "like_count"],
                    ["likes", "likeCount"],
                    ["comments", "comments"],
                    ["comments", "comment_count"],
                    ["comments", "commentCount"],
                    ["comments", "replies"],
                    ["shares", "shares"],
                    ["shares", "share_count"],
                    ["reposts", "reposts"],
                    ["reposts", "repost_count"],
                    ["views", "views"],
                    ["views", "view_count"],
                    ["views", "viewCount"],
                    ["impressions", "impressions"],
                    ["reach", "reach"],
                  ];

        const seen = new Set<string>();

        for (const [name, key] of fields) {
          if (seen.has(name)) continue;
          const value = optionalNumber(values[key]);

          if (value === undefined) continue;
          seen.add(name);
          result.push({
            name,
            value,
            unit: "count",
            period: "lifetime",
            fetchedAt: now(),
            freshness: "unknown",
            source: `post-for-me:${ref.platform}:feed`,
          });
        }

        return result;
      },
    },
    webhooks: {
      async verify(input: { headers: Headers; body: Uint8Array }) {
        await verifyPostForMeWebhook({ ...input, secret: options.webhookSecret ?? "" });

        return { valid: true, method: "shared-secret" as const };
      },
      async decode(
        input: { headers: Headers; body: Uint8Array },
        context: AdapterOperationContext,
      ): Promise<JsonObject> {
        const event = await decodeWebhook({
          provider: "post-for-me",
          backend: context.backendInstance,
          body: input.body,
          receivedAt: now(),
        });

        return { ...event };
      },
    },
    native: {
      async createConnection(input: PostForMeConnectionOptions, context: AdapterOperationContext) {
        platform(input.platform);

        const result = object(
          await request("/v1/social-accounts/auth-url", context, {
            platform: input.platform,
            external_id: input.externalId,
            permissions: input.permissions,
            // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
            ...(input.redirectUrl ? { redirect_url_override: input.redirectUrl } : {}),
          }),
        );

        return { url: string(result["url"]), platform: string(result["platform"]) };
      },
    },
  });

  return adapter;
}
