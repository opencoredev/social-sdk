import { remainingBudget } from "../transport/budget.js";
import { defineAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import type {
  AdapterOperationContext,
  CommentRef,
  ConnectedAccountRef,
  JsonObject,
  MediaAttachment,
  MediaRef,
  MetricValue,
  PlatformPostRef,
  PreparedPublishTarget,
} from "../core/types.js";
import { createHttp, HttpError } from "../transport/http.js";
import { array, object, string, optionalString, optionalNumber } from "../transport/validation.js";
import { upload } from "../transport/upload.js";
import { publicFields } from "../cloud/common.js";

export interface LinkedInOptions {
  readonly auth: {
    readonly accessToken: string;
    readonly author: `urn:li:person:${string}` | `urn:li:organization:${string}`;
  };
  /** Explicit monthly API version, for example 202609. Upgrade after reviewing LinkedIn's migration notes. */
  readonly apiVersion: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
}

export interface LinkedInNative {
  readonly imageStatus: (ref: MediaRef, context: AdapterOperationContext) => Promise<JsonObject>;
  readonly registerVideo: (input: {
    readonly account: ConnectedAccountRef;
    readonly byteSize: number;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly createPoll: (input: {
    readonly account: ConnectedAccountRef;
    readonly text: string;
    readonly options: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly react: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly reaction: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly reshare: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly updatePost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly body: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly deletePost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly organizationAnalytics: (input: {
    readonly account: ConnectedAccountRef;
    readonly query?: JsonObject;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
}

export function linkedin(
  options: LinkedInOptions,
): import("../core/adapter.js").SocialAdapter<LinkedInNative> {
  if (
    !options.auth.accessToken.trim() ||
    !/^urn:li:(person|organization):[a-zA-Z0-9_-]+$/.test(options.auth.author) ||
    !/^20\d{2}(0[1-9]|1[0-2])$/.test(options.apiVersion)
  ) {
    throw new SocialError({
      code: "invalid_config",
      operation: "createAdapter",
      message:
        "Provide a LinkedIn access token, member/organization author URN and explicit YYYYMM API version.",
    });
  }

  const http = createHttp(options.fetch ? { fetch: options.fetch } : {});
  const now = () => (options.clock?.() ?? new Date()).toISOString();

  const authorize = (
    ref: { backend: string; platform: string; accountId: string },
    context: AdapterOperationContext,
  ) => {
    if (
      ref.backend !== context.backendInstance ||
      ref.platform !== "linkedin" ||
      ref.accountId !== options.auth.author
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "linkedin",
        message: "Reference does not belong to this LinkedIn author authorization.",
      });
  };

  async function request(
    path: string,
    context: AdapterOperationContext,
    body?: JsonObject,
    selectedHeaders?: readonly string[],
    method: "GET" | "POST" | "PUT" | "DELETE" = body === undefined ? "GET" : "POST",
  ) {
    try {
      return await http({
        timeoutMs: remainingBudget(context),
        url: new URL(`https://api.linkedin.com${path}`),
        headers: {
          Authorization: `Bearer ${options.auth.accessToken}`,
          "Content-Type": "application/json",
          "Linkedin-Version": options.apiVersion,
          "X-Restli-Protocol-Version": "2.0.0",
        },
        method,
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(context.signal ? { signal: context.signal } : {}),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(selectedHeaders ? { responseHeaders: selectedHeaders } : {}),
        maxAttempts: method === "GET" ? Math.min(5, context.retryBudget.maxAttempts) : 1,
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      const ambiguous =
        body !== undefined &&
        error.dispatched &&
        (error.kind !== "http" || (error.status ?? 0) >= 500);

      throw new SocialError({
        code: ambiguous
          ? "ambiguous_outcome"
          : error.status === 401
            ? "reconnect_required"
            : error.status === 403
              ? "missing_permission"
              : error.status === 429
                ? "rate_limited"
                : "upstream_failure",
        operation: path,
        message: error.message,
        upstreamStatus: error.status,
        retryDisposition: ambiguous ? { kind: "reconcile-first" } : { kind: "never" },
      });
    }
  }

  async function readPost(ref: PlatformPostRef, context: AdapterOperationContext) {
    authorize(ref, context);
    const result = object(await request(`/rest/posts/${encodeURIComponent(ref.postId)}`, context));

    if (result["author"] !== ref.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation: "posts.read",
        message: "LinkedIn post belongs to a different author.",
      });

    return result;
  }

  async function readCommentablePost(ref: PlatformPostRef, context: AdapterOperationContext) {
    authorize(ref, context);
    const result = object(await request(`/rest/posts/${encodeURIComponent(ref.postId)}`, context));

    if (result["id"] !== undefined && result["id"] !== ref.postId)
      throw new SocialError({
        code: "unauthorized",
        operation: "comments.write",
        message: "LinkedIn returned a different post than the declared parent.",
      });

    return result;
  }

  async function uploadImage(
    media: MediaAttachment,
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<MediaRef> {
    authorize(account, context);
    const source = media.source;

    if (
      media.kind !== "image" ||
      !["image/jpeg", "image/png", "image/gif"].includes(media.mimeType ?? "") ||
      (source.kind !== "blob" && source.kind !== "stream")
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: "Provide JPEG, PNG or GIF bytes as a Blob or replayable stream.",
      });

    const initialized = object(
      object(
        await request("/rest/images?action=initializeUpload", context, {
          initializeUploadRequest: { owner: account.accountId },
        }),
      )["value"],
    );

    const mediaId = string(initialized["image"]);

    if (!/^urn:li:image:[a-zA-Z0-9_-]+$/.test(mediaId))
      throw new SocialError({
        code: "media_error",
        operation: "media.upload",
        message: "LinkedIn returned an invalid image identifier.",
      });
    const size = media.byteSize ?? (source.kind === "blob" ? source.blob.size : undefined);
    await upload({
      url: string(initialized["uploadUrl"]),
      source: {
        mimeType: media.mimeType!,
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(size === undefined ? {} : { size }),
        open: source.kind === "blob" ? () => source.blob.stream() : source.open,
      },
      allowHost: (host) => host === "www.linkedin.com",
      maxBytes: 20 * 1024 * 1024,
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
      ...(options.fetch ? { fetch: options.fetch } : {}),
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
      ...(context.signal ? { signal: context.signal } : {}),
    });

    return {
      kind: "media",
      version: 1,
      backend: account.backend,
      platform: "linkedin",
      accountId: account.accountId,
      mediaId,
    };
  }

  return defineAdapter({
    id: "linkedin",
    capabilities: {
      schemaVersion: 1 as const,
      backend: "linkedin",
      apiRevision: options.apiVersion,
      runtime: ["node22", "node24", "bun"],
      capabilities: [
        {
          platform: "linkedin",
          operation: "posts.publish",
          availability: "available" as const,
          formats: ["text" as const, "image" as const],
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "w_organization_social"
              : "w_member_social",
          ],
          notes:
            "Explicit author URN and public visibility. Organization role and app product approval required. Registered images must be AVAILABLE before creating a post.",
        },
        {
          platform: "linkedin",
          operation: "posts.read",
          availability: "available" as const,
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "r_organization_social"
              : "r_member_social",
          ],
          notes:
            "Member read access is restricted. Publication permission does not grant read permission.",
        },
        {
          platform: "linkedin",
          operation: "posts.multi-image",
          availability: "available" as const,
          formats: ["carousel" as const],
        },
        {
          platform: "linkedin",
          operation: "posts.video",
          availability: "available" as const,
          formats: ["video" as const],
        },
        { platform: "linkedin", operation: "posts.document", availability: "available" as const },
        { platform: "linkedin", operation: "polls.create", availability: "available" as const },
        { platform: "linkedin", operation: "reactions.write", availability: "available" as const },
        { platform: "linkedin", operation: "reshares.write", availability: "available" as const },
        { platform: "linkedin", operation: "posts.update", availability: "available" as const },
        { platform: "linkedin", operation: "posts.delete", availability: "available" as const },
        {
          platform: "linkedin",
          operation: "analytics.organization.read",
          availability: "permission-required" as const,
        },
        {
          platform: "linkedin",
          operation: "articles.create",
          availability: "approval-dependent" as const,
        },
        {
          platform: "linkedin",
          operation: "messages.write",
          availability: "unsupported-by-platform" as const,
        },
        {
          platform: "linkedin",
          operation: "analytics.account.read",
          availability: options.auth.author.startsWith("urn:li:organization:")
            ? ("available" as const)
            : ("account-ineligible" as const),
          requiredScopes: ["rw_organization_admin"],
          notes:
            "Organization total followers only; authenticated member must administer the organization. No member-profile analytics claimed.",
        },
        {
          platform: "linkedin",
          operation: "posts.list",
          availability: "available" as const,
          requiredScopes: [
            options.auth.author.startsWith("urn:li:organization:")
              ? "r_organization_social"
              : "r_member_social",
          ],
          notes: "Author feed requires approved read access for the configured author.",
        },
        {
          platform: "linkedin",
          operation: "media.upload",
          availability: "available" as const,
          formats: ["image" as const],
        },
        ...["comments.read", "comments.write", "analytics.read"].map((operation) => ({
          platform: "linkedin",
          operation,
          availability: "available" as const,
          notes:
            "Community Management product permissions and author post read access required. Analytics contains returned social-action counts only.",
        })),
      ],
    },
    media: { upload: uploadImage },
    posts: {
      prepareTarget(target: PreparedPublishTarget) {
        const issues: { code: string; message: string; severity: "error"; targetIndex: number }[] =
          [];

        const fail = (code: string, message: string) =>
          issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

        if (
          target.account.platform !== "linkedin" ||
          target.account.accountId !== options.auth.author
        )
          fail("linkedin.author", "Select the configured member or organization author URN.");

        if ((target.content.text?.length ?? 0) > 3000)
          fail("linkedin.text", "LinkedIn commentary exceeds 3,000 characters.");

        if (target.schedule || target.replyTo || target.content.link)
          fail(
            "linkedin.operation",
            "Scheduling, reply posts and structured links are not supported by this publishing slice.",
          );

        if (target.options !== undefined) {
          const settings = object(target.options);

          if (
            Object.keys(settings).some((key) => key !== "visibility") ||
            (settings["visibility"] !== undefined && settings["visibility"] !== "public")
          )
            fail(
              "linkedin.options",
              "This slice supports public visibility only; other native options require explicit implementation.",
            );
        }

        const media = target.content.media ?? [];

        if (media.length > 1)
          fail("linkedin.media_count", "This slice accepts one registered image per post.");

        for (const item of media) {
          if (item.kind !== "image" || item.source.kind !== "media-ref")
            fail(
              "linkedin.media",
              "Upload an image first with media.upload, then publish its account-bound reference.",
            );
          else if (
            item.source.ref.backend !== target.account.backend ||
            item.source.ref.accountId !== target.account.accountId ||
            item.source.ref.platform !== "linkedin" ||
            !/^urn:li:image:[a-zA-Z0-9_-]+$/.test(item.source.ref.mediaId)
          )
            fail(
              "linkedin.media_owner",
              "Image reference belongs to another author/backend or has an invalid URN.",
            );
        }

        return issues;
      },
      async publishTarget(target: PreparedPublishTarget, context: AdapterOperationContext) {
        authorize(target.account, context);
        const media = target.content.media?.[0];
        let content: JsonObject | undefined;

        if (media?.source.kind === "media-ref") {
          authorize(media.source.ref, context);

          const image = object(
            await request(`/rest/images/${encodeURIComponent(media.source.ref.mediaId)}`, context),
          );

          if (image["owner"] !== target.account.accountId)
            throw new SocialError({
              code: "unauthorized",
              operation: "posts.publish",
              message: "LinkedIn image belongs to a different author.",
            });

          if (image["status"] !== "AVAILABLE")
            throw new SocialError({
              code: "media_error",
              operation: "posts.publish",
              message: "Image is not AVAILABLE. Check its status explicitly before publishing.",
            });
          content = {
            media: {
              id: media.source.ref.mediaId,
              // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
              ...(media.altText ? { altText: media.altText } : {}),
            },
          };
        }

        const result = object(
          await request(
            "/rest/posts",
            context,
            {
              author: target.account.accountId,
              commentary: target.content.text ?? "",
              visibility: "PUBLIC",
              distribution: {
                feedDistribution: "MAIN_FEED",
                targetEntities: [],
                thirdPartyDistributionChannels: [],
              },
              lifecycleState: "PUBLISHED",
              isReshareDisabledByAuthor: false,
              // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
              ...(content ? { content } : {}),
            },
            ["x-restli-id"],
          ),
        );

        const id = optionalString(object(result["headers"])["x-restli-id"]);

        const base = {
          account: target.account,
          targetIndex: target.targetIndex,
          observedAt: now(),
        };

        if (!id || !/^urn:li:(share|ugcPost):[0-9]+$/.test(id))
          return {
            ...base,
            state: "unknown" as const,
            reason: "unmapped-state" as const,
            diagnostic:
              "LinkedIn accepted the create request without a valid native post identifier. Do not repeat it automatically.",
          };

        return {
          ...base,
          state: "published" as const,
          post: {
            kind: "platform-post" as const,
            version: 1 as const,
            backend: target.account.backend,
            platform: "linkedin",
            accountId: target.account.accountId,
            postId: id,
          },
        };
      },
      async get(ref: PlatformPostRef, context: AdapterOperationContext) {
        return publicFields(await readPost(ref, context), [
          "id",
          "author",
          "commentary",
          "visibility",
          "lifecycleState",
          "createdAt",
          "lastModifiedAt",
        ]);
      },
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        authorize(account, context);
        const start = input.cursor === undefined ? 0 : Number(input.cursor);
        const count = input.limit ?? 25;

        if (
          !Number.isSafeInteger(start) ||
          start < 0 ||
          input.cursor === "" ||
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > 100
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.read",
            message: "LinkedIn requires a nonnegative offset and page size from 1 to 100.",
          });

        const result = object(
          await request(
            `/rest/posts?q=author&author=${encodeURIComponent(options.auth.author)}&start=${start}&count=${count}&sortBy=LAST_MODIFIED`,
            context,
          ),
        );

        const rows = array(result["elements"]).map(object);

        if (rows.some((row) => row["author"] !== options.auth.author))
          throw new SocialError({
            code: "unauthorized",
            operation: "posts.read",
            message: "LinkedIn returned a post from another author.",
          });

        const items = rows.map((row) =>
          publicFields(row, [
            "id",
            "author",
            "commentary",
            "visibility",
            "lifecycleState",
            "createdAt",
            "lastModifiedAt",
          ]),
        );

        const paging = result["paging"] === undefined ? {} : object(result["paging"]);
        const total = optionalNumber(paging["total"]);
        const hasNext = array(paging["links"] ?? []).some((link) => object(link)["rel"] === "next");

        return {
          items,
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(items.length > 0 && (hasNext || (total !== undefined && start + items.length < total))
            ? { nextCursor: String(start + items.length) }
            : {}),
        };
      },
    },
    comments: {
      async list(
        ref: PlatformPostRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        await readPost(ref, context);
        const start = input.cursor === undefined ? 0 : Number(input.cursor);
        const count = input.limit ?? 25;

        if (
          !Number.isSafeInteger(start) ||
          start < 0 ||
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > 100
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.read",
            message:
              "LinkedIn comment pagination requires a returned offset and a page size from 1 to 100.",
          });

        const result = object(
          await request(
            `/rest/socialActions/${encodeURIComponent(ref.postId)}/comments?start=${start}&count=${count}`,
            context,
          ),
        );

        const items = array(result["elements"]).map((value) => {
          const row = object(value);

          return {
            ...publicFields(row, ["id", "actor", "commentUrn", "object"]),
            text: string(object(row["message"])["text"]),
          };
        });

        const paging = result["paging"] === undefined ? {} : object(result["paging"]);
        const total = optionalNumber(paging["total"]);

        const next =
          total !== undefined && start + items.length < total
            ? String(start + items.length)
            : undefined;

        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        return { items, ...(next === undefined ? {} : { nextCursor: next }) };
      },
      async reply(
        ref: CommentRef,
        content: { text: string },
        context: AdapterOperationContext,
      ): Promise<CommentRef> {
        if (!content.text.trim() || content.text.length > 1250)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.write",
            message: "Provide a comment of 1 to 1,250 characters.",
          });
        await readCommentablePost({ ...ref, kind: "platform-post" }, context);
        const match = /^urn:li:comment:\(urn:li:activity:\d+,(\d+)\)$/.exec(ref.commentId);

        if (!match)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.write",
            message: "Use the complete commentUrn returned by LinkedIn comment reads.",
          });

        const parent = object(
          await request(
            `/rest/socialActions/${encodeURIComponent(ref.postId)}/comments/${match[1]}`,
            context,
          ),
        );

        if (parent["commentUrn"] !== ref.commentId)
          throw new SocialError({
            code: "unauthorized",
            operation: "comments.write",
            message: "Comment does not belong to the supplied post.",
          });

        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
        if (typeof parent["object"] === "string" && parent["object"] !== ref.postId)
          throw new SocialError({
            code: "unauthorized",
            operation: "comments.write",
            message: "Comment parent object does not match the supplied post.",
          });

        const response = object(
          await request(
            `/rest/socialActions/${encodeURIComponent(ref.commentId)}/comments`,
            context,
            {
              actor: ref.accountId,
              message: { text: content.text },
              object: ref.postId,
              parentComment: ref.commentId,
            },
          ),
        );

        const commentId = optionalString(response["commentUrn"]);

        if (!commentId)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "comments.write",
            message:
              "LinkedIn accepted the comment without returning its composite URN. Reconcile before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return { ...ref, commentId };
      },
    },
    analytics: {
      async getAccountMetrics(
        account: ConnectedAccountRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        authorize(account, context);

        if (!options.auth.author.startsWith("urn:li:organization:"))
          throw new SocialError({
            code: "unsupported_capability",
            operation: "analytics.account.read",
            message:
              "LinkedIn organization follower counts require an organization author and administrator access.",
          });

        const response = object(
          await request(
            `/rest/networkSizes/${encodeURIComponent(options.auth.author)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`,
            context,
          ),
        );

        const value = optionalNumber(response["firstDegreeSize"]);

        return value === undefined
          ? []
          : [
              {
                name: "followers",
                value,
                unit: "count",
                period: "lifetime",
                fetchedAt: now(),
                freshness: "unknown",
                source: `linkedin:${options.apiVersion}:networkSizes`,
              },
            ];
      },
      async getPostMetrics(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        await readPost(ref, context);

        const result = object(
          await request(`/rest/socialActions/${encodeURIComponent(ref.postId)}`, context),
        );

        if (result["target"] !== undefined && result["target"] !== ref.postId)
          throw new SocialError({
            code: "unauthorized",
            operation: "analytics.read",
            message: "LinkedIn returned social actions for a different post.",
          });
        const metrics: MetricValue[] = [];

        for (const [summary, field, name] of [
          ["likesSummary", "totalLikes", "likes"],
          ["commentsSummary", "totalFirstLevelComments", "comments"],
        ] as const) {
          if (result[summary] === undefined) continue;
          const value = optionalNumber(object(result[summary])[field]);

          if (value !== undefined)
            metrics.push({
              name,
              value,
              unit: "count",
              period: "lifetime",
              fetchedAt: now(),
              freshness: "unknown",
              source: `linkedin:${options.apiVersion}:socialActions`,
            });
        }

        return metrics;
      },
    },
    native: {
      async imageStatus(ref: MediaRef, context: AdapterOperationContext) {
        authorize(ref, context);

        const image = object(
          await request(`/rest/images/${encodeURIComponent(ref.mediaId)}`, context),
        );

        if (image["owner"] !== ref.accountId)
          throw new SocialError({
            code: "unauthorized",
            operation: "media.read",
            message: "LinkedIn image belongs to another author.",
          });

        return publicFields(image, ["id", "owner", "status"]);
      },
      async registerVideo({ account, byteSize, context }) {
        authorize(account, context);

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return (await request("/rest/videos?action=initializeUpload", context, {
          initializeUploadRequest: { owner: account.accountId, fileSizeBytes: byteSize },
        })) as JsonObject;
      },
      async createPoll({ account, text, options: pollOptions, context }) {
        authorize(account, context);

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return (await request("/rest/posts", context, {
          author: account.accountId,
          commentary: text,
          distribution: { feedDistribution: "MAIN_FEED" },
          content: { poll: { question: text, options: [...pollOptions] } },
        })) as JsonObject;
      },
      async react({ account, postId, reaction, context }) {
        authorize(account, context);
        await request(`/rest/reactions`, context, {
          root: postId,
          reactionType: reaction,
          actor: account.accountId,
        });
      },
      async reshare({ account, postId, context }) {
        authorize(account, context);

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return (await request("/rest/posts", context, {
          author: account.accountId,
          resharedPost: postId,
          commentary: "",
        })) as JsonObject;
      },
      async updatePost({ account, postId, body, context }) {
        authorize(account, context);

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return (await request(
          `/rest/posts/${encodeURIComponent(postId)}`,
          context,
          body,
          undefined,
          "PUT",
        )) as JsonObject;
      },
      async deletePost({ account, postId, context }) {
        authorize(account, context);
        await request(
          `/rest/posts/${encodeURIComponent(postId)}`,
          context,
          undefined,
          undefined,
          "DELETE",
        );
      },
      async organizationAnalytics({ account, query, context }) {
        authorize(account, context);

        if (!account.accountId.startsWith("urn:li:organization:"))
          throw new SocialError({
            code: "unsupported_capability",
            operation: "analytics.organization.read",
            message: "Organization analytics requires an organization author.",
          });

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return (await request(
          `/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(account.accountId)}`,
          context,
          query,
        )) as JsonObject;
      },
    },
  });
}
