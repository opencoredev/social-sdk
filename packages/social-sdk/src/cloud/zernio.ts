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
  CommentRef,
  ConnectedAccountRef,
  ConversationRef,
  JsonObject,
  JsonValue,
  MetricValue,
  PlatformPostRef,
  PreparedPublishTarget,
} from "../core/types.js";
import { definedFields } from "../core/fields.js";
import {
  array,
  isBoolean,
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  object,
  optionalNumber,
  optionalString,
  string,
} from "../transport/validation.js";
import { decodeWebhook, verifyZernioWebhook } from "../server/webhooks.js";
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
import { zernioOutcome } from "./outcomes.js";

export interface ZernioConnectionOptions {
  platform: string;
  profileId: string;
  redirectUrl: string;
}

export function zernio(options: ManagedOptions) {
  const request = managedHttp("https://zernio.com/api", options);

  const mediaPipeline = managedMedia("zernio", options, (body, context) =>
    request("/v1/media/presign", context, body),
  );

  const now = () => (options.clock?.() ?? new Date()).toISOString();

  const account = (value: JsonValue, backend: string): AccountRecord => {
    const row = object(value);
    const handle = optionalString(row["username"]);

    return {
      ref: {
        kind: "connected-account",
        version: 1,
        backend,
        platform: platform(row["platform"]),
        accountId: string(row["_id"]),
      },
      displayName: optionalString(row["displayName"]) ?? handle ?? string(row["_id"]),
      ...definedFields({ handle: handle || undefined }),
      status:
        row["isActive"] === true
          ? "connected"
          : row["isActive"] === false
            ? "reconnect-required"
            : "unknown",
    };
  };

  const supportedAccount = (value: JsonValue, backend: string): AccountRecord | undefined => {
    try {
      return account(value, backend);
    } catch (error) {
      if (error instanceof SocialError && error.code === "unsupported_capability") return undefined;
      throw error;
    }
  };

  const analytics = async (ref: PlatformPostRef, context: AdapterOperationContext) => {
    accountMatches(ref, context);

    return object(
      await request("/v1/analytics", context, undefined, {
        postId: ref.postId,
        accountId: ref.accountId,
        platform: ref.platform === "x" ? "twitter" : ref.platform,
      }),
    );
  };

  return defineAdapter({
    id: "zernio",
    capabilities: {
      ...capabilityManifest("zernio", "v1 / OpenAPI 1.25.1", [
        "accounts.read",
        "posts.publish",
        "posts.read",
        "posts.list",
        "posts.status",
        "posts.cancelScheduled",
        "posts.deleteBackendRecord",
        "analytics.read",
        "analytics.account.read",
        "media.upload",
        "webhooks.verify",
      ]),
      capabilities: [
        ...capabilityManifest("zernio", "1.25.1", [
          "accounts.read",
          "posts.publish",
          "posts.read",
          "posts.list",
          "posts.status",
          "posts.cancelScheduled",
          "posts.deleteBackendRecord",
          "analytics.read",
          "analytics.account.read",
          "media.upload",
          "webhooks.verify",
        ]).capabilities,
        ...["x", "threads", "bluesky", "youtube", "linkedin", "facebook"].map((platform) => ({
          platform,
          operation: "posts.removeFromPlatform",
          availability: "available" as const,
        })),
        ...["x", "threads", "bluesky", "youtube", "instagram", "linkedin", "facebook"].flatMap(
          (platform) =>
            ["comments.read", "comments.write"].map((operation) => ({
              platform,
              operation,
              availability: "available" as const,
            })),
        ),
        ...["x", "bluesky", "instagram", "facebook"].flatMap((platform) =>
          ["messages.read", "messages.write"].map((operation) => ({
            platform,
            operation,
            availability: "available" as const,
            notes:
              "Recipient permissions and reply-window eligibility remain upstream constraints.",
          })),
        ),
      ],
    },
    media: { upload: mediaPipeline.upload },
    accounts: {
      async list(input: { cursor?: string; limit?: number }, context: AdapterOperationContext) {
        const page = input.cursor === undefined ? 1 : Number(input.cursor);
        const limit = input.limit ?? 25;

        if (
          !Number.isSafeInteger(page) ||
          page < 1 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "accounts.read",
            message: "Use a returned cursor and page size from 1 to 100.",
          });

        const result = object(
          await request("/v1/accounts", context, undefined, {
            page: String(page),
            limit: String(limit),
          }),
        );

        const pagination = result["pagination"] ? object(result["pagination"]) : {};

        const pages =
          optionalNumber(pagination["pages"]) ?? optionalNumber(pagination["totalPages"]);

        return {
          items: array(result["accounts"]).flatMap((value) => {
            const parsed = supportedAccount(value, context.backendInstance);

            return parsed ? [parsed] : [];
          }),
          ...definedFields({
            nextCursor: pages !== undefined && page < pages ? String(page + 1) : undefined,
          }),
        };
      },
      async get(ref: ConnectedAccountRef, context: AdapterOperationContext) {
        accountMatches(ref, context);

        const platform = ref.platform === "x" ? "twitter" : ref.platform;
        let raw: ReturnType<typeof object> | undefined;

        // The list endpoint is paginated, so keep reading until the account appears.
        for (let page = 1; page <= 100 && !raw; page++) {
          const response = object(
            await request("/v1/accounts", context, undefined, {
              platform,
              page: String(page),
              limit: "100",
            }),
          );

          raw = array(response["accounts"])
            .map(object)
            .find(
              (item) =>
                item["_id"] === ref.accountId &&
                (item["platform"] === ref.platform || item["platform"] === platform),
            );

          const pagination = response["pagination"] ? object(response["pagination"]) : {};

          const pages =
            optionalNumber(pagination["pages"]) ?? optionalNumber(pagination["totalPages"]);

          if (pages === undefined || page >= pages) break;
        }

        if (!raw)
          throw new SocialError({
            code: "not_found",
            operation: "accounts.read",
            message: "Provider account was not found.",
          });

        const result = account(raw, context.backendInstance);

        if (result.ref.accountId !== ref.accountId || result.ref.platform !== ref.platform)
          throw new SocialError({
            code: "unauthorized",
            operation: "accounts.read",
            message: "Provider account does not match the requested reference.",
          });

        return result;
      },
    },
    posts: {
      ...managedLifecycle("zernio", request, now),
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        accountMatches(account, context);
        const page = input.cursor === undefined ? 1 : Number(input.cursor);
        const limit = input.limit ?? 25;

        if (
          !Number.isSafeInteger(page) ||
          page < 1 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 500
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.read",
            message: "Zernio post page requires a returned page cursor and a size from 1 to 500.",
          });

        const result = object(
          await request("/v1/posts", context, undefined, {
            page: String(page),
            limit: String(limit),
            source: "external",
            accountId: account.accountId,
            platform: account.platform === "x" ? "twitter" : account.platform,
          }),
        );

        const rows = array(result["posts"])
          .map(object)
          .flatMap((row): JsonObject[] => {
            const destinations = isJsonArray(row["platforms"])
              ? array(row["platforms"]).map(object)
              : [];

            const destination = destinations.find((item) => {
              const value = item["accountId"];

              const id = isString(value)
                ? value
                : isJsonObject(value) || isJsonArray(value)
                  ? object(value)["_id"]
                  : undefined;

              return (
                id === account.accountId &&
                (item["platform"] === account.platform ||
                  item["platform"] === (account.platform === "x" ? "twitter" : account.platform))
              );
            });

            if (destination === undefined) return [];

            return [
              {
                ...definedFields({
                  backendPostId: optionalString(row["_id"]),
                  platformPostId: optionalString(destination["platformPostId"]),
                }),
                platform: account.platform,
                accountId: account.accountId,
                ...definedFields({
                  platformPostUrl: optionalString(destination["platformPostUrl"]),
                }),
                ...publicFields(row, [
                  "content",
                  "caption",
                  "createdAt",
                  "publishedAt",
                  "status",
                  "isExternal",
                  "syncStatus",
                ]),
              },
            ];
          });

        const pagination = result["pagination"] === undefined ? {} : object(result["pagination"]);

        const totalPages =
          optionalNumber(pagination["pages"]) ?? optionalNumber(pagination["totalPages"]);

        return {
          items: rows,
          ...definedFields({
            nextCursor:
              totalPages !== undefined && page < totalPages ? String(page + 1) : undefined,
          }),
        };
      },
      prepareTarget(target: PreparedPublishTarget) {
        const issues = [...managedPreparation(target), ...managedOptionIssues(target, "zernio")];
        const config = optionsObject(target);

        if (target.account.platform === "threads" && config["replyControl"] !== undefined)
          issues.push({
            code: "threads.reply_control_unsupported",
            message:
              "Zernio's documented create-post schema does not expose this reply-control option.",
            severity: "error",
            targetIndex: target.targetIndex,
          });

        if (target.account.platform === "linkedin" && config["visibility"] === "connections")
          issues.push({
            code: "linkedin.visibility_unsupported",
            message: "This managed adapter cannot guarantee connections-only visibility.",
            severity: "error",
            targetIndex: target.targetIndex,
          });

        return issues;
      },
      async publishTarget(target: PreparedPublishTarget, context: AdapterOperationContext) {
        accountMatches(target.account, context);
        const media: JsonObject[] = [];

        for (const item of target.content.media ?? [])
          media.push({
            type: item.kind,
            url: await mediaPipeline.resolve(item, target.account, context),
            ...definedFields({ altText: item.altText, mimeType: item.mimeType }),
          });
        const config = optionsObject(target);
        const native: Record<string, JsonValue> = {};

        if (target.account.platform === "youtube") {
          native["title"] = string(config["title"]);
          native["visibility"] = string(config["visibility"]);

          const madeForKids = config["madeForKids"];

          if (isBoolean(madeForKids)) native["madeForKids"] = madeForKids;
        }

        const shareToFeed = config["shareToFeed"];

        if (target.account.platform === "instagram" && isBoolean(shareToFeed))
          native["shareToFeed"] = shareToFeed;

        if (
          target.account.platform === "x" &&
          config["replySettings"] !== undefined &&
          config["replySettings"] !== "everyone"
        )
          native["replySettings"] = string(config["replySettings"]);

        if (target.account.platform === "tiktok") {
          native["privacyLevel"] = string(config["privacy"]);
          native["contentPreviewConfirmed"] = true;
          native["expressConsentGiven"] = true;
          native["autoAddMusic"] = false;
          native["allowDuet"] = !config["disableDuet"];
          native["allowStitch"] = !config["disableStitch"];

          // prepareTarget requires these TikTok choices to be booleans. Skipping an
          // absent value sends the same JSON body, since serialization drops undefined.
          for (const [nativeKey, optionKey] of [
            ["isBrandOrganicPost", "ownBrand"],
            ["videoMadeWithAi", "aiGenerated"],
            ["draft", "draft"],
          ] as const) {
            const value = config[optionKey];

            if (value !== undefined) native[nativeKey] = value;
          }

          const { photoCoverIndex, disableComments, brandedContent } = config;

          if (isFiniteNumber(photoCoverIndex)) native["photoCoverIndex"] = photoCoverIndex;

          if (isBoolean(disableComments)) native["allowComment"] = !disableComments;

          if (isBoolean(brandedContent)) native["brandPartnerPromote"] = brandedContent;
        }

        const response = await request("/v1/posts", context, {
          content: target.content.text ?? "",
          mediaItems: media,
          platforms: [
            {
              platform: target.account.platform === "x" ? "twitter" : target.account.platform,
              accountId: target.account.accountId,
              ...definedFields({
                platformSpecificData: Object.keys(native).length ? native : undefined,
              }),
            },
          ],
          ...(target.schedule
            ? {
                scheduledFor: target.schedule.at,
                ...definedFields({ timezone: target.schedule.timeZone || undefined }),
              }
            : { publishNow: true }),
        });

        return zernioOutcome(response, {
          account: target.account,
          targetIndex: target.targetIndex,
          observedAt: now(),
        });
      },
      async getDelivery(
        ref: { backend: string; platform: string; accountId: string; deliveryId: string },
        context: AdapterOperationContext,
      ) {
        accountMatches(ref, context);
        const response = await request(`/v1/posts/${encodeURIComponent(ref.deliveryId)}`, context);

        return zernioOutcome(response, {
          account: {
            kind: "connected-account",
            version: 1,
            backend: ref.backend,
            platform: ref.platform,
            accountId: ref.accountId,
          },
          targetIndex: 0,
          observedAt: now(),
        });
      },
      async get(ref: PlatformPostRef, context: AdapterOperationContext) {
        return publicFields(await analytics(ref, context), [
          "postId",
          "content",
          "publishedAt",
          "platform",
          "platformPostUrl",
          "isExternal",
          "syncStatus",
        ]);
      },
    },
    analytics: {
      async getAccountMetrics(
        ref: ConnectedAccountRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        accountMatches(ref, context);

        // Zernio documents followersCount on GET /v1/accounts (when the
        // analytics add-on is enabled); there is no accountId-specific GET.
        const result = object(
          await request("/v1/accounts", context, undefined, {
            platform: ref.platform === "x" ? "twitter" : ref.platform,
          }),
        );

        const row = array(result["accounts"])
          .map(object)
          .find(
            (item) =>
              item["_id"] === ref.accountId &&
              item["platform"] === (ref.platform === "x" ? "twitter" : ref.platform),
          );

        if (!row)
          throw new SocialError({
            code: "unauthorized",
            operation: "analytics.account.read",
            message: "Provider account does not match the requested reference.",
          });
        const followers = optionalNumber(row["followersCount"]);

        if (followers === undefined) return [];
        const measuredAt = optionalString(row["followersLastUpdated"]);

        return [
          {
            name: "followers",
            value: followers,
            unit: "count",
            period: "lifetime",
            ...(measuredAt
              ? { measuredAt, freshness: "reported" as const }
              : { freshness: "unknown" as const }),
            fetchedAt: now(),
            source: `zernio:${ref.platform}:account`,
          },
        ];
      },
      async getPostMetrics(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        const result = await analytics(ref, context);

        if (result["syncStatus"] === "unavailable" || result["analytics"] === undefined) return [];
        const source = object(result["analytics"]);
        const measuredAt = optionalString(source["lastUpdated"]);
        // Do not label request time as measurement time when upstream freshness is absent.
        const metrics: MetricValue[] = [];

        for (const name of [
          "impressions",
          "reach",
          "likes",
          "comments",
          "shares",
          "saves",
          "clicks",
          "views",
          "follows",
          "reposts",
        ]) {
          const value = optionalNumber(source[name]);

          if (value !== undefined)
            metrics.push({
              name,
              value,
              unit: "count",
              period: "lifetime",
              ...(measuredAt ? { measuredAt, freshness: "reported" } : { freshness: "unknown" }),
              fetchedAt: now(),
              source: `zernio:${ref.platform}`,
            });
        }

        return metrics;
      },
    },
    comments: {
      async list(
        ref: PlatformPostRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        accountMatches(ref, context);
        const limit = input.limit ?? 25;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.read",
            message: "Zernio comment page size must be between 1 and 100.",
          });

        const result = object(
          await request(
            `/v1/inbox/comments/${encodeURIComponent(ref.postId)}`,
            context,
            undefined,
            {
              accountId: ref.accountId,
              limit: String(limit),
              ...definedFields({ cursor: input.cursor }),
            },
          ),
        );

        const pagination = result["pagination"] ? object(result["pagination"]) : {};
        const cursor = optionalString(pagination["cursor"]);
        const hasMore = pagination["hasMore"];

        return {
          items: array(result["comments"]).map((entry) =>
            publicFields(entry, [
              "id",
              "message",
              "createdTime",
              "likeCount",
              "replyCount",
              "parentId",
              "rootUri",
              "rootCid",
              "cid",
              "canReply",
              "canDelete",
              "canHide",
            ]),
          ),
          ...definedFields({ nextCursor: hasMore === false || !cursor ? undefined : cursor }),
        };
      },
      async reply(
        ref: CommentRef,
        content: { text: string },
        context: AdapterOperationContext,
      ): Promise<CommentRef> {
        accountMatches(ref, context);

        const result = object(
          await request(`/v1/inbox/comments/${encodeURIComponent(ref.postId)}`, context, {
            accountId: ref.accountId,
            message: content.text,
            commentId: ref.commentId,
          }),
        );

        if (result["success"] !== true)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "comments.write",
            message: "Comment reply lacks a confirmed success result; reconcile before retrying.",
          });

        return { ...ref, commentId: string(object(result["data"])["commentId"]) };
      },
    },
    messages: {
      async listConversations(
        ref: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        accountMatches(ref, context);
        const limit = input.limit ?? 50;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.read",
            message: "Zernio conversation page size must be between 1 and 100.",
          });

        const result = object(
          await request("/v1/inbox/conversations", context, undefined, {
            accountId: ref.accountId,
            limit: String(limit),
            ...definedFields({ cursor: input.cursor }),
          }),
        );

        const pagination = result["pagination"] === undefined ? {} : object(result["pagination"]);
        const cursor = optionalString(pagination["nextCursor"]);

        return {
          items: array(result["data"]).map((entry) =>
            publicFields(entry, [
              "id",
              "platform",
              "accountId",
              "participantId",
              "participantName",
              "lastMessage",
              "updatedTime",
              "unreadCount",
            ]),
          ),
          ...definedFields({ nextCursor: cursor || undefined }),
        };
      },
      async listMessages(
        ref: ConversationRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        accountMatches(ref, context);
        const limit = input.limit ?? 100;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.read",
            message: "Zernio message page size must be between 1 and 100.",
          });

        const result = object(
          await request(
            `/v1/inbox/conversations/${encodeURIComponent(ref.conversationId)}/messages`,
            context,
            undefined,
            {
              accountId: ref.accountId,
              limit: String(limit),
              ...definedFields({ cursor: input.cursor }),
            },
          ),
        );

        const pagination = result["pagination"] ? object(result["pagination"]) : {};
        const cursor = optionalString(pagination["nextCursor"]);

        return {
          items: array(result["messages"]).map((entry) =>
            publicFields(entry, [
              "id",
              "message",
              "senderId",
              "senderName",
              "direction",
              "createdAt",
              "deliveryStatus",
            ]),
          ),
          ...definedFields({ nextCursor: cursor || undefined }),
        };
      },
      async send(
        ref: ConversationRef,
        content: { text: string },
        context: AdapterOperationContext,
      ): Promise<JsonObject> {
        accountMatches(ref, context);

        const result = object(
          await request(
            `/v1/inbox/conversations/${encodeURIComponent(ref.conversationId)}/messages`,
            context,
            { accountId: ref.accountId, message: content.text },
          ),
        );

        if (result["success"] !== true)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "messages.write",
            message: "Message outcome is unconfirmed. Reconcile before retrying.",
          });
        const data = object(result["data"]);
        const messageId = optionalString(data["messageId"]);

        return { state: "sent", ...definedFields({ messageId: messageId || undefined }) };
      },
    },
    webhooks: {
      async verify(input: { headers: Headers; body: Uint8Array }) {
        await verifyZernioWebhook({ ...input, secret: options.webhookSecret ?? "" });

        return { valid: true, method: "hmac" as const };
      },
      async decode(
        input: { headers: Headers; body: Uint8Array },
        context: AdapterOperationContext,
      ): Promise<JsonObject> {
        return {
          ...(await decodeWebhook({
            provider: "zernio",
            backend: context.backendInstance,
            body: input.body,
            receivedAt: now(),
          })),
        };
      },
    },
    native: {
      async createConnection(input: ZernioConnectionOptions, context: AdapterOperationContext) {
        platform(input.platform);

        const response = object(
          await request(
            `/v1/connect/${input.platform === "x" ? "twitter" : encodeURIComponent(input.platform)}`,
            context,
            undefined,
            { profileId: input.profileId, redirect_url: input.redirectUrl },
          ),
        );

        return {
          url: string(response["authUrl"]),
          ...definedFields({ providerState: optionalString(response["state"]) }),
        };
      },
      async listProfiles(context: AdapterOperationContext) {
        const result = object(await request("/v1/profiles", context));

        return array(result["profiles"]).map((entry) =>
          publicFields(entry, ["_id", "name", "description"]),
        );
      },
    },
  });
}
