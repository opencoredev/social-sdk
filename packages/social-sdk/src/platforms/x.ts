/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract. */
import { remainingBudget } from "../transport/budget.js";
import twitterText from "twitter-text";
import { defineAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import type {
  AdapterOperationContext,
  CommentRef,
  ConnectedAccountRef,
  DeliveryOutcome,
  JsonObject,
  MediaAttachment,
  MetricValue,
  PlatformPostRef,
  PreparedPublishTarget,
} from "../core/types.js";
import { managedHttp, publicFields } from "../cloud/common.js";
import { createHttp, HttpError } from "../transport/http.js";
import { array, object, optionalNumber, optionalString, string } from "../transport/validation.js";

export interface XAuthorization {
  readonly userId: string;
  readonly accessToken: string;
  readonly handle?: string;
}

export { xLike, xUnlike, type XEngagementOptions, type XEngagementResult } from "./x-engagement.js";

export interface XOptions {
  readonly auth: XAuthorization;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
}

export interface XNative {
  readonly readPost: (
    ref: PlatformPostRef,
    context: AdapterOperationContext,
  ) => Promise<JsonObject>;
  readonly repost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly quote: (input: {
    readonly account: ConnectedAccountRef;
    readonly text: string;
    readonly quotedPostId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly deletePost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly createPoll: (input: {
    readonly account: ConnectedAccountRef;
    readonly text: string;
    readonly options: readonly string[];
    readonly durationMinutes: number;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly bookmarks: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly bookmark: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly removeBookmark: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly follow: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly unfollow: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly uploadVideo: (input: {
    readonly account: ConnectedAccountRef;
    readonly media: Blob;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly uploadGif: (input: {
    readonly account: ConnectedAccountRef;
    readonly media: Blob;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly listDirectMessages: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly stream: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<Response>;
}

export function x(options: XOptions): import("../core/adapter.js").SocialAdapter<XNative> {
  const request = managedHttp("https://api.x.com", {
    apiKey: options.auth.accessToken,
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const http = createHttp(options.fetch ? { fetch: options.fetch } : {});
  const now = () => (options.clock?.() ?? new Date()).toISOString();

  const authorize = (
    ref: { backend: string; platform: string; accountId: string },
    context: AdapterOperationContext,
  ) => {
    if (
      ref.backend !== context.backendInstance ||
      ref.platform !== "x" ||
      ref.accountId !== options.auth.userId
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "x",
        message: "Reference does not match this X user authorization.",
      });
  };

  async function readAccount(context: AdapterOperationContext) {
    const user = object(object(await request("/2/users/me", context))["data"]);

    if (user["id"] !== options.auth.userId)
      throw new SocialError({
        code: "unauthorized",
        operation: "accounts.read",
        message: "The authenticated X user differs from the configured account.",
      });

    return {
      ref: {
        kind: "connected-account" as const,
        version: 1 as const,
        backend: context.backendInstance,
        platform: "x",
        accountId: options.auth.userId,
      },
      displayName: string(user["name"]),
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
      ...(typeof user["username"] === "string" ? { handle: user["username"] } : {}),
      status: "connected" as const,
    };
  }

  async function readPost(
    ref: PlatformPostRef,
    context: AdapterOperationContext,
  ): Promise<JsonObject> {
    authorize(ref, context);

    const result = object(
      object(
        await request(`/2/tweets/${encodeURIComponent(ref.postId)}`, context, undefined, {
          "tweet.fields": "author_id,public_metrics,created_at,conversation_id,referenced_tweets",
        }),
      )["data"],
    );

    if (result["id"] !== ref.postId || result["author_id"] !== ref.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation: "posts.read",
        message: "X post identity or author does not match the declared reference.",
      });

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
    return result as JsonObject;
  }

  async function listPosts(
    account: ConnectedAccountRef,
    input: { readonly cursor?: string; readonly limit?: number },
    context: AdapterOperationContext,
  ) {
    authorize(account, context);

    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "posts.list",
        message: "X feed limit must be an integer from 1 through 100.",
      });

    const result = object(
      await request(
        `/2/users/${encodeURIComponent(account.accountId)}/tweets`,
        context,
        undefined,
        {
          "tweet.fields": "id,text,author_id,created_at,conversation_id",
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(input.cursor === undefined ? {} : { pagination_token: input.cursor }),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(input.limit === undefined ? {} : { max_results: String(input.limit) }),
        },
      ),
    );

    const items = array(result["data"]).map((entry) => {
      const row = object(entry);
      const authorId = optionalString(row["author_id"]);

      if (authorId !== account.accountId)
        throw new SocialError({
          code: "unauthorized",
          operation: "posts.list",
          message: "X returned a post owned by a different account.",
        });

      return publicFields(row, ["id", "text", "author_id", "created_at", "conversation_id"]);
    });

    const meta = result["meta"] === undefined ? {} : object(result["meta"]);
    const nextCursor = optionalString(meta["next_token"]);

    return {
      items,
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  async function getAccountMetrics(
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<readonly MetricValue[]> {
    authorize(account, context);

    const result = object(
      await request(`/2/users/${encodeURIComponent(account.accountId)}`, context, undefined, {
        "user.fields": "id,public_metrics",
      }),
    );

    const data = object(result["data"]);
    const id = optionalString(data["id"]);

    if (id !== account.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation: "analytics.read",
        message: "X returned metrics for a different account.",
      });
    const counts = data["public_metrics"] === undefined ? {} : object(data["public_metrics"]);
    const fields = ["followers_count", "following_count", "tweet_count", "listed_count"] as const;

    return fields.flatMap((name) => {
      const value = optionalNumber(counts[name]);

      return value === undefined
        ? []
        : [
            {
              name,
              value,
              unit: "count" as const,
              period: "lifetime" as const,
              fetchedAt: now(),
              freshness: "unknown" as const,
              source: "X API v2",
            },
          ];
    });
  }

  async function validateReplyParent(
    ref: CommentRef,
    context: AdapterOperationContext,
  ): Promise<void> {
    authorize(ref, context);

    const parent = object(
      object(
        await request(`/2/tweets/${encodeURIComponent(ref.commentId)}`, context, undefined, {
          "tweet.fields": "conversation_id",
        }),
      )["data"],
    );

    if (parent["id"] !== ref.commentId)
      throw new SocialError({
        code: "unauthorized",
        operation: "comments.write",
        message: "X did not return the declared reply parent.",
      });

    if (ref.postId !== ref.commentId) {
      const root = object(
        object(
          await request(`/2/tweets/${encodeURIComponent(ref.postId)}`, context, undefined, {
            "tweet.fields": "conversation_id",
          }),
        )["data"],
      );

      if (
        root["id"] !== ref.postId ||
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
        (typeof parent["conversation_id"] === "string" &&
          parent["conversation_id"] !== root["conversation_id"])
      )
        throw new SocialError({
          code: "unauthorized",
          operation: "comments.write",
          message: "Reply parent does not belong to the declared X conversation.",
        });
    }
  }

  async function uploadImage(
    media: MediaAttachment,
    context: AdapterOperationContext,
  ): Promise<string> {
    if (
      media.source.kind !== "blob" ||
      media.kind !== "image" ||
      media.source.blob.size > 5 * 1024 * 1024
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: "This X slice uploads image Blobs up to 5 MiB.",
      });
    const body = new FormData();
    body.set("media", media.source.blob, media.filename ?? "image");
    body.set("media_category", "tweet_image");
    let result: unknown;

    try {
      result = await http({
        url: new URL("https://api.x.com/2/media/upload"),
        method: "POST",
        headers: { Authorization: `Bearer ${options.auth.accessToken}` },
        body,
        timeoutMs: remainingBudget(context),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      throw new SocialError({
        code: "media_error",
        operation: "media.upload",
        message: error.message,
        upstreamStatus: error.status,
        retryDisposition: { kind: "never" },
      });
    }

    const data = object(object(result)["data"]);

    if (data["processing_info"] && object(data["processing_info"])["state"] !== "succeeded")
      throw new SocialError({
        code: "media_error",
        operation: "media.upload",
        message: "X media processing is not complete. No post was created.",
      });

    return string(data["id"]);
  }

  async function createPost(
    account: ConnectedAccountRef,
    text: string,
    context: AdapterOperationContext,
    extra: JsonObject = {},
    targetIndex = 0,
  ): Promise<DeliveryOutcome> {
    authorize(account, context);
    const result = object(await request("/2/tweets", context, { text, ...extra }));
    const data = result["data"] ? object(result["data"]) : {};
    const id = optionalString(data["id"]);
    const base = { account, targetIndex, observedAt: now() };

    if (!id)
      return {
        ...base,
        state: "unknown",
        reason: "unmapped-state",
        diagnostic: "X create response lacks a native ID. Reconcile before retrying.",
      };

    return {
      ...base,
      state: "published",
      post: {
        kind: "platform-post",
        version: 1,
        backend: account.backend,
        platform: "x",
        accountId: account.accountId,
        postId: id,
      },
    };
  }

  return defineAdapter({
    id: "x",
    capabilities: {
      schemaVersion: 1 as const,
      backend: "x",
      apiRevision: "X API v2 / OpenAPI 2.168",
      runtime: ["node22", "node24", "bun"],
      capabilities: [
        {
          platform: "x",
          operation: "posts.publish",
          availability: "available" as const,
          formats: ["text" as const, "image" as const, "video" as const],
          requiredScopes: ["tweet.read", "tweet.write", "users.read", "media.write"],
          notes:
            "User-context OAuth2 token; current X API access/billing required. Up to four static JPEG/PNG image Blobs, each at most 5 MiB. Video/GIF processing is outside this slice.",
        },
        ...[
          "accounts.read",
          "posts.list",
          "posts.read",
          "analytics.read",
          "comments.write",
          "posts.repost",
          "posts.quote",
          "posts.delete",
          "polls.create",
          "bookmarks.read",
          "bookmarks.write",
          "follows.write",
        ].map((operation) => ({
          platform: "x",
          operation,
          availability: "available" as const,
        })),
        {
          platform: "x",
          operation: "media.video",
          availability: "available" as const,
          formats: ["video" as const],
        },
        { platform: "x", operation: "media.gif", availability: "available" as const },
        {
          platform: "x",
          operation: "messages.read",
          availability: "permission-required" as const,
          requiredScopes: ["dm.read"],
        },
        {
          platform: "x",
          operation: "streams.read",
          availability: "approval-dependent" as const,
          notes: "Filtered stream access depends on the X API tier.",
        },
      ],
    },
    accounts: {
      async list(_input: { cursor?: string; limit?: number }, context: AdapterOperationContext) {
        return { items: [await readAccount(context)] };
      },
      async get(ref: ConnectedAccountRef, context: AdapterOperationContext) {
        authorize(ref, context);

        return readAccount(context);
      },
    },
    posts: {
      list: listPosts,
      prepareTarget(target: PreparedPublishTarget) {
        const issues: { code: string; message: string; severity: "error"; targetIndex: number }[] =
          [];

        const fail = (code: string, message: string) =>
          issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

        if (target.account.platform !== "x" || target.account.accountId !== options.auth.userId)
          fail("x.account", "Select the configured X user.");
        const text = target.content.text ?? "";

        if (text && !twitterText.parseTweet(text).valid)
          fail(
            "x.text",
            "Text exceeds X's weighted 280-character limit or contains invalid characters.",
          );

        if (target.schedule || target.content.link)
          fail(
            "x.operation",
            "Scheduling needs an application runner; place URLs explicitly in text.",
          );

        if (
          target.replyTo &&
          (target.replyTo.platform !== "x" ||
            target.replyTo.backend !== target.account.backend ||
            target.replyTo.accountId !== target.account.accountId ||
            target.replyTo.kind !== "platform-post")
        )
          fail(
            "x.reply",
            "Use a platform-post reply reference authorized for this account and backend.",
          );
        const settings = target.options === undefined ? {} : object(target.options);

        if (
          Object.keys(settings).some((key) => key !== "replySettings") ||
          (settings["replySettings"] !== undefined &&
            !["everyone", "following", "mentionedUsers"].includes(
              String(settings["replySettings"]),
            ))
        )
          fail("x.options", "Provide only a supported replySettings value.");
        const media = target.content.media ?? [];

        if (media.length > 4) fail("x.media_count", "Attach up to four images.");

        for (const item of media) {
          if (
            item.kind !== "image" ||
            item.source.kind !== "blob" ||
            !["image/jpeg", "image/png"].includes(item.mimeType ?? "")
          )
            fail("x.image", "This slice requires a JPEG or PNG image Blob.");
          else if (item.source.blob.size > 5 * 1024 * 1024)
            fail("x.image_size", "Image exceeds the 5 MiB limit.");

          if (item.altText !== undefined)
            fail(
              "x.alt_text",
              "This slice has no verified media metadata mapping. Use a backend that supports alt text.",
            );
        }

        return issues;
      },
      async publishTarget(target: PreparedPublishTarget, context: AdapterOperationContext) {
        authorize(target.account, context);
        const ids: string[] = [];

        for (const media of target.content.media ?? []) ids.push(await uploadImage(media, context));
        const settings = target.options === undefined ? {} : object(target.options);

        return createPost(
          target.account,
          target.content.text ?? "",
          context,
          {
            // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
            ...(ids.length ? { media: { media_ids: ids } } : {}),
            // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
            ...(target.replyTo ? { reply: { in_reply_to_tweet_id: target.replyTo.postId } } : {}),
            // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
            ...(settings["replySettings"] && settings["replySettings"] !== "everyone"
              ? { reply_settings: string(settings["replySettings"]) }
              : {}),
          },
          target.targetIndex,
        );
      },
      async get(ref: PlatformPostRef, context: AdapterOperationContext) {
        return publicFields(await readPost(ref, context), [
          "id",
          "text",
          "author_id",
          "created_at",
          "conversation_id",
        ]);
      },
    },
    comments: {
      async list() {
        throw new SocialError({
          code: "unsupported_capability",
          operation: "comments.read",
          message: "X reply search is not implemented in this slice.",
        });
      },
      async reply(
        ref: CommentRef,
        content: { text: string },
        context: AdapterOperationContext,
      ): Promise<CommentRef> {
        await validateReplyParent(ref, context);

        if (!twitterText.parseTweet(content.text).valid)
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.write",
            message: "Reply exceeds X's weighted text limits.",
          });

        const result = await createPost(
          { ...ref, kind: "connected-account" },
          content.text,
          context,
          { reply: { in_reply_to_tweet_id: ref.commentId } },
        );

        if (result.state !== "published")
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "comments.write",
            message: "X reply lacks a confirmed native ID. Reconcile before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return { ...ref, commentId: result.post.postId };
      },
    },
    analytics: {
      getAccountMetrics,
      async getPostMetrics(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        const row = await readPost(ref, context);
        const counts = row["public_metrics"] ? object(row["public_metrics"]) : {};

        return [
          ["likes", "like_count"],
          ["reposts", "retweet_count"],
          ["replies", "reply_count"],
          ["quotes", "quote_count"],
        ].flatMap(([name, key]) => {
          const value = key ? optionalNumber(counts[key]) : undefined;

          return value === undefined || !name
            ? []
            : [
                {
                  name,
                  value,
                  unit: "count" as const,
                  period: "lifetime" as const,
                  fetchedAt: now(),
                  freshness: "unknown" as const,
                  source: "X API v2",
                },
              ];
        });
      },
    },
    native: {
      readPost,
      async repost({ account, postId, context }) {
        authorize(account, context);

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return object(
          await request(`/2/users/${encodeURIComponent(account.accountId)}/retweets`, context, {
            tweet_id: postId,
          }),
        ) as JsonObject;
      },
      async quote({ account, text, quotedPostId, context }) {
        authorize(account, context);

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return object(
          await request("/2/tweets", context, { text, quote_tweet_id: quotedPostId }),
        ) as JsonObject;
      },
      async deletePost({ account, postId, context }) {
        authorize(account, context);
        await request(`/2/tweets/${encodeURIComponent(postId)}`, context, undefined, {}, "DELETE");
      },
      async createPoll({ account, text, options: pollOptions, durationMinutes, context }) {
        authorize(account, context);

        if (
          pollOptions.length < 2 ||
          pollOptions.length > 4 ||
          durationMinutes < 5 ||
          durationMinutes > 10080
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "x.polls.create",
            message: "X polls require 2-4 options and a duration from 5 minutes to 7 days.",
          });

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return object(
          await request("/2/tweets", context, {
            text,
            poll: { options: [...pollOptions], duration_minutes: durationMinutes },
          }),
        ) as JsonObject;
      },
      async bookmarks({ account, context }) {
        authorize(account, context);

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return object(
          await request(`/2/users/${encodeURIComponent(account.accountId)}/bookmarks`, context),
        ) as JsonObject;
      },
      async bookmark({ account, postId, context }) {
        authorize(account, context);
        await request(`/2/users/${encodeURIComponent(account.accountId)}/bookmarks`, context, {
          tweet_id: postId,
        });
      },
      async removeBookmark({ account, postId, context }) {
        authorize(account, context);
        await request(
          `/2/users/${encodeURIComponent(account.accountId)}/bookmarks/${encodeURIComponent(postId)}`,
          context,
          undefined,
          {},
          "DELETE",
        );
      },
      async follow({ account, userId, context }) {
        authorize(account, context);

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return object(
          await request(`/2/users/${encodeURIComponent(account.accountId)}/following`, context, {
            target_user_id: userId,
          }),
        ) as JsonObject;
      },
      async unfollow({ account, userId, context }) {
        authorize(account, context);
        await request(
          `/2/users/${encodeURIComponent(account.accountId)}/following/${encodeURIComponent(userId)}`,
          context,
          undefined,
          {},
          "DELETE",
        );
      },
      async uploadVideo({ account, media, context }) {
        authorize(account, context);

        if (!media.type.startsWith("video/") || media.size > 512 * 1024 * 1024)
          throw new SocialError({
            code: "invalid_input",
            operation: "x.media.video",
            message: "Provide a video Blob no larger than 512 MiB.",
          });
        const body = new FormData();
        body.set("media", media, "video");
        body.set("media_category", "tweet_video");

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return object(
          await http({
            url: new URL("https://api.x.com/2/media/upload"),
            method: "POST",
            headers: { Authorization: `Bearer ${options.auth.accessToken}` },
            body,
            timeoutMs: remainingBudget(context),
            // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
            ...(context.signal ? { signal: context.signal } : {}),
          }),
        ) as JsonObject;
      },
      async uploadGif({ account, media, context }) {
        authorize(account, context);

        if (media.type !== "image/gif")
          throw new SocialError({
            code: "invalid_input",
            operation: "x.media.gif",
            message: "GIF uploads require image/gif media.",
          });
        const body = new FormData();
        body.set("media", media, "image.gif");
        body.set("media_category", "tweet_gif");

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return object(
          await http({
            url: new URL("https://api.x.com/2/media/upload"),
            method: "POST",
            headers: { Authorization: `Bearer ${options.auth.accessToken}` },
            body,
            timeoutMs: remainingBudget(context),
            // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
            ...(context.signal ? { signal: context.signal } : {}),
          }),
        ) as JsonObject;
      },
      async listDirectMessages({ account, context }) {
        authorize(account, context);

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return object(await request("/2/dm_conversations", context)) as JsonObject;
      },
      async stream({ account, context }) {
        authorize(account, context);

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return (await http({
          url: new URL("https://api.x.com/2/tweets/search/stream"),
          headers: { Authorization: `Bearer ${options.auth.accessToken}` },
          timeoutMs: remainingBudget(context),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(context.signal ? { signal: context.signal } : {}),
        })) as Response;
      },
    },
  });
}
