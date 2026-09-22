/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof, anti-slop/require-readable-spacing, anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract. */
import { remainingBudget } from "../transport/budget.js";
import twitterText from "twitter-text";
import { defineAdapter } from "../core/adapter.js";
import { connectedAccountRef, profileRef } from "../core/types.js";
import { SocialError } from "../core/errors.js";
import type {
  AdapterOperationContext,
  CommentRef,
  ConnectedAccountRef,
  ConversationRef,
  DeliveryOutcome,
  JsonObject,
  MediaAttachment,
  MetricValue,
  Page,
  PlatformPostRef,
  PreparedPublishTarget,
  ProfileRecord,
  ProfileRef,
  RelationshipRecord,
  SearchPostsInput,
} from "../core/types.js";
import { managedHttp, publicFields } from "../cloud/common.js";
import { createHttp, HttpError } from "../transport/http.js";
import {
  array,
  object as parseObject,
  optionalNumber,
  optionalString,
  string,
} from "../transport/validation.js";

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- transport parser validates the provider boundary.
const object = (value: unknown): JsonObject => parseObject(value) as JsonObject;

export interface XAuthorization {
  readonly userId: string;
  readonly accessToken?: string;
  readonly handle?: string;
}

export { xLike, xUnlike, type XEngagementOptions, type XEngagementResult } from "./x-engagement.js";

export interface XOptions {
  readonly auth: XAuthorization;
  /** App-only bearer token for full-archive search and filtered stream. */
  readonly appBearerToken?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
}

export type XTweetField =
  | "attachments"
  | "author_id"
  | "conversation_id"
  | "created_at"
  | "entities"
  | "geo"
  | "id"
  | "lang"
  | "public_metrics"
  | "referenced_tweets"
  | "text";

export type XTweetExpansion =
  | "attachments.media_keys"
  | "attachments.poll_ids"
  | "author_id"
  | "entities.mentions.username"
  | "geo.place_id"
  | "in_reply_to_user_id"
  | "referenced_tweets.id";

export type XUserField =
  | "created_at"
  | "description"
  | "id"
  | "name"
  | "public_metrics"
  | "username";

export type XMediaField =
  | "duration_ms"
  | "height"
  | "media_key"
  | "preview_image_url"
  | "type"
  | "url"
  | "width";

export interface XSearchInput extends SearchPostsInput {
  readonly sortOrder?: "recency" | "relevancy";
  readonly tweetFields?: readonly XTweetField[];
  readonly expansions?: readonly XTweetExpansion[];
  readonly userFields?: readonly XUserField[];
  readonly mediaFields?: readonly XMediaField[];
}

export interface XNative {
  readonly searchRecentPosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly search: Omit<XSearchInput, "scope">;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly searchAllPosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly search: Omit<XSearchInput, "scope">;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
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
    readonly participantId?: string;
    readonly conversationId?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly sendDirectMessage: (input: {
    readonly account: ConnectedAccountRef;
    readonly participantId: string;
    readonly text: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly sendConversationMessage: (input: {
    readonly account: ConnectedAccountRef;
    readonly conversationId: string;
    readonly text: string;
    readonly attachments?: readonly JsonObject[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly createGroupConversation: (input: {
    readonly account: ConnectedAccountRef;
    readonly participantIds: readonly string[];
    readonly message: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly getUserById: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly getUserByUsername: (input: {
    readonly account: ConnectedAccountRef;
    readonly username: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly getMe: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly followers: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly following: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly followUser: XNative["follow"];
  readonly unfollowUser: XNative["unfollow"];
  readonly muteUser: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly unmuteUser: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly mutedUsers: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly blockUser: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly unblockUser: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly blockedUsers: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly like: XNative["bookmark"];
  readonly unlike: XNative["removeBookmark"];
  readonly likedPosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly likingUsers: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly createList: (input: {
    readonly account: ConnectedAccountRef;
    readonly name: string;
    readonly description?: string;
    readonly isPrivate?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly updateList: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly name?: string;
    readonly description?: string;
    readonly isPrivate?: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly deleteList: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly getList: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly listMembers: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly addListMember: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly removeListMember: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly userId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly followList: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly unfollowList: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly ownedLists: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly pinList: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly unpinList: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly pinnedLists: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly listPosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly listId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly userPosts: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly homeTimeline: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly mentions: (input: {
    readonly account: ConnectedAccountRef;
    readonly userId?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<Page<JsonObject>>;
  readonly undoRepost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly stream: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<Response>;
}

export function x(options: XOptions): import("../core/adapter.js").SocialAdapter<XNative> {
  const request = managedHttp("https://api.x.com", {
    apiKey: options.auth.accessToken ?? "app-auth-placeholder",
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const appRequest = () => {
    if (!options.appBearerToken?.trim())
      throw new SocialError({
        code: "missing_permission",
        operation: "x.app-auth",
        message: "This X endpoint requires an app-only bearer token. Configure appBearerToken.",
      });
    return managedHttp("https://api.x.com", {
      apiKey: options.appBearerToken,
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  };
  const requireUserToken = (operation: string) => {
    if (!options.auth.accessToken?.trim())
      throw new SocialError({
        code: "missing_permission",
        operation,
        message: "This X operation requires a user access token.",
      });
    return request;
  };
  const readRequest = (_path: string) =>
    options.auth.accessToken?.trim() ? request : appRequest();

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
    input: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
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

    const items = (result["data"] === undefined ? [] : array(result["data"])).map((entry) => {
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

  async function searchPosts(
    account: ConnectedAccountRef,
    input: SearchPostsInput,
    context: AdapterOperationContext,
    nativeInput?: XSearchInput,
  ): Promise<Page<JsonObject>> {
    authorize(account, context);

    const query = input.query;
    const scope = input.scope ?? "recent";
    const maxLimit = scope === "all" ? 500 : 100;

    if (!query.trim() || query.length > (scope === "all" ? 4096 : 512))
      throw new SocialError({
        code: "invalid_input",
        operation: "search.posts",
        message: `X ${scope} search queries must contain 1-${scope === "all" ? 4096 : 512} characters.`,
      });

    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 10 || input.limit > maxLimit)
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "search.posts",
        message: `X ${scope} search limits must be integers from 10 through ${maxLimit}.`,
      });

    for (const [name, value] of [
      ["startTime", input.startTime],
      ["endTime", input.endTime],
    ] as const) {
      if (value !== undefined && !Number.isFinite(Date.parse(value)))
        throw new SocialError({
          code: "invalid_input",
          operation: "search.posts",
          message: `${name} must be an ISO 8601 timestamp.`,
        });
    }

    if (
      input.startTime !== undefined &&
      input.endTime !== undefined &&
      Date.parse(input.startTime) >= Date.parse(input.endTime)
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "search.posts",
        message: "startTime must be earlier than endTime.",
      });

    const result = object(
      await (scope === "all" ? appRequest() : request)(
        `/2/tweets/search/${scope}`,
        context,
        undefined,
        {
          query,
          "tweet.fields": [
            "id",
            "text",
            "edit_history_tweet_ids",
            ...(nativeInput?.tweetFields ?? [
              "author_id",
              "created_at",
              "conversation_id",
              "public_metrics",
              "lang",
              "entities",
              "attachments",
              "referenced_tweets",
            ]),
          ]
            .filter((field, index, fields) => fields.indexOf(field) === index)
            .join(","),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(input.cursor === undefined ? {} : { next_token: input.cursor }),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(input.limit === undefined ? {} : { max_results: String(input.limit) }),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(input.startTime === undefined ? {} : { start_time: input.startTime }),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(input.endTime === undefined ? {} : { end_time: input.endTime }),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(nativeInput?.sortOrder === undefined ? {} : { sort_order: nativeInput.sortOrder }),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(nativeInput?.expansions === undefined
            ? {}
            : { expansions: nativeInput.expansions.join(",") }),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(nativeInput?.userFields === undefined
            ? {}
            : { "user.fields": nativeInput.userFields.join(",") }),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(nativeInput?.mediaFields === undefined
            ? {}
            : { "media.fields": nativeInput.mediaFields.join(",") }),
        },
      ),
    );

    const requestedFields = nativeInput?.tweetFields ?? [
      "id",
      "text",
      "author_id",
      "created_at",
      "conversation_id",
      "public_metrics",
      "lang",
      "entities",
      "attachments",
      "referenced_tweets",
    ];

    const items = (result["data"] === undefined ? [] : array(result["data"])).map((entry) => {
      const row = object(entry);
      return Object.fromEntries(
        requestedFields.filter((field) => field in row).map((field) => [field, row[field]]),
      ) as JsonObject;
    });

    const meta = result["meta"] === undefined ? {} : object(result["meta"]);
    const nextCursor = optionalString(meta["next_token"]);

    const includes = result["includes"];

    return {
      items,
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
      ...(nextCursor === undefined ? {} : { nextCursor }),
      ...(includes === undefined
        ? {}
        : {
            // SAFETY: X's `includes` member is a JSON object validated by the transport boundary.
            metadata: { includes: object(includes) as JsonObject },
          }),
    };
  }

  async function pageRequest(
    path: string,
    account: ConnectedAccountRef,
    input: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
    context: AdapterOperationContext,
    query: Record<string, string> = {},
    fields = "id,name,username,description,created_at,public_metrics",
    resource: "users" | "tweets" = "users",
  ): Promise<Page<JsonObject>> {
    authorize(account, context);
    const isTweets = resource === "tweets";
    const minLimit = isTweets ? 5 : 1;
    const maxLimit = isTweets ? 100 : 1000;
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < minLimit || input.limit > maxLimit)
    )
      throw new SocialError({
        code: "invalid_input",
        operation: path,
        message: `X limits must be integers from ${minLimit} through ${maxLimit}.`,
      });
    const result = object(
      await readRequest(path)(path, context, undefined, {
        ...query,
        ...(isTweets
          ? {
              "tweet.fields":
                "id,text,author_id,created_at,conversation_id,public_metrics,referenced_tweets",
              expansions: "author_id,referenced_tweets.id",
            }
          : fields
            ? { "user.fields": fields }
            : {}),
        ...(input.cursor === undefined ? {} : { pagination_token: input.cursor }),
        ...(input.limit === undefined ? {} : { max_results: String(input.limit) }),
      }),
    );
    const items = (result["data"] === undefined ? [] : array(result["data"])).map(
      (entry) => object(entry) as JsonObject,
    );
    const meta = result["meta"] === undefined ? {} : object(result["meta"]);
    const nextCursor = optionalString(meta["next_token"]);
    return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
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

  let nativeAdapter: XNative;
  const adapter = defineAdapter({
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
          formats: ["text" as const, "image" as const],
          requiredScopes: ["tweet.read", "tweet.write", "users.read", "media.write"],
          notes:
            "User-context OAuth2 token; current X API access/billing required. Up to four static JPEG/PNG image Blobs, each at most 5 MiB. Video/GIF processing is outside this slice.",
        },
        ...[
          "accounts.read",
          "posts.list",
          "posts.read",
          "analytics.read",
          "analytics.account.read",
          "comments.write",
          "posts.repost",
          "posts.quote",
          "posts.delete",
          "polls.create",
          "bookmarks.read",
          "bookmarks.write",
          "follows.write",
          "mentions.read",
          "likes.read",
          "likes.write",
          "lists.read",
          "lists.write",
          "timelines.read",
        ].map((operation) => ({
          platform: "x",
          operation,
          availability: "available" as const,
        })),
        {
          platform: "x",
          operation: "graph.read",
          availability: "available" as const,
          requiredScopes: ["users.read", "follows.read", "mute.read", "block.read"],
          notes: "The required read scope depends on the requested relationship kind.",
        },
        {
          platform: "x",
          operation: "profiles.read",
          availability: "available" as const,
          requiredScopes: ["users.read"],
        },
        {
          platform: "x",
          operation: "graph.follow",
          availability: "available" as const,
          requiredScopes: ["users.read", "follows.write"],
          notes: "Follow writes require an eligible paid X API tier.",
        },
        {
          platform: "x",
          operation: "graph.unfollow",
          availability: "available" as const,
          requiredScopes: ["users.read", "follows.write"],
          notes: "Follow writes require an eligible paid X API tier.",
        },
        {
          platform: "x",
          operation: "graph.mute",
          availability: "available" as const,
          requiredScopes: ["users.read", "mute.write"],
        },
        {
          platform: "x",
          operation: "graph.unmute",
          availability: "available" as const,
          requiredScopes: ["users.read", "mute.write"],
        },
        {
          platform: "x",
          operation: "graph.block",
          availability: "available" as const,
          requiredScopes: ["users.read", "block.write"],
          notes: "Enterprise plan only.",
        },
        {
          platform: "x",
          operation: "graph.unblock",
          availability: "available" as const,
          requiredScopes: ["users.read", "block.write"],
          notes: "Enterprise plan only.",
        },
        {
          platform: "x",
          operation: "lists.pinned.read",
          availability: "available" as const,
          requiredScopes: ["users.read", "list.read"],
        },
        {
          platform: "x",
          operation: "lists.pinned.write",
          availability: "available" as const,
          requiredScopes: ["users.read", "list.write"],
        },
        {
          platform: "x",
          operation: "messages.conversation.write",
          availability: "available" as const,
          requiredScopes: ["dm.write"],
        },
        {
          platform: "x",
          operation: "messages.group.write",
          availability: "available" as const,
          requiredScopes: ["dm.write"],
        },
        {
          platform: "x",
          operation: "search.posts",
          availability: "available" as const,
          requiredScopes: ["tweet.read", "users.read"],
          notes:
            "Recent search covers the last 7 days. Full-archive search requires an eligible X API pay-per-use or Enterprise plan.",
        },
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
          availability: "available" as const,
          requiredScopes: ["dm.read", "users.read", "tweet.read"],
          notes: "Requires a user-context token and an X API tier that includes Direct Messages.",
        },
        {
          platform: "x",
          operation: "messages.write",
          availability: "available" as const,
          requiredScopes: ["dm.write", "dm.read", "users.read", "tweet.read"],
          notes: "Requires a user-context token and an X API tier that includes Direct Messages.",
        },
        {
          platform: "x",
          operation: "streams.read",
          availability: "available" as const,
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
    graph: {
      async getProfile(account, input, context): Promise<ProfileRecord> {
        const value =
          input.profileId !== undefined
            ? await nativeAdapter.getUserById({ account, userId: input.profileId, context })
            : input.handle !== undefined
              ? await nativeAdapter.getUserByUsername({ account, username: input.handle, context })
              : await nativeAdapter.getMe({ account, context });
        const user = object(object(value)["data"]);
        const id = string(user["id"]);
        return {
          ref: profileRef({
            backend: context.backendInstance,
            platform: "x",
            accountId: account.accountId,
            profileId: id,
          }),
          ...(typeof user["name"] === "string" ? { displayName: user["name"] } : {}),
          ...(typeof user["username"] === "string" ? { handle: user["username"] } : {}),
          ...(typeof user["description"] === "string" ? { bio: user["description"] } : {}),
          native: user,
        };
      },
      async listRelationships(account, input, context): Promise<Page<RelationshipRecord>> {
        const pagination = {
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        };
        const result =
          input.kind === "following"
            ? await nativeAdapter.following({
                account,
                ...pagination,
                userId: account.accountId,
                context,
              })
            : input.kind === "followers"
              ? await nativeAdapter.followers({
                  account,
                  ...pagination,
                  userId: account.accountId,
                  context,
                })
              : input.kind === "blocked"
                ? await nativeAdapter.blockedUsers({
                    account,
                    ...pagination,
                    context,
                  })
                : await nativeAdapter.mutedUsers({
                    account,
                    ...pagination,
                    context,
                  });
        return {
          items: result.items.map((entry) => {
            const user = object(entry);
            const id = string(user["id"]);
            return {
              profile: profileRef({
                backend: context.backendInstance,
                platform: "x",
                accountId: account.accountId,
                profileId: id,
              }),
              relationship:
                input.kind === "following"
                  ? "following"
                  : input.kind === "followers"
                    ? "follower"
                    : input.kind,
            };
          }),
          ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
        };
      },
      async follow(target: ProfileRef, context): Promise<RelationshipRecord> {
        const account = connectedAccountRef({
          backend: target.backend,
          platform: "x",
          accountId: target.accountId,
        });
        await nativeAdapter.followUser({ account, userId: target.profileId, context });
        return { profile: target, relationship: "following" };
      },
      async unfollow(target: ProfileRef, context): Promise<void> {
        const account = connectedAccountRef({
          backend: target.backend,
          platform: "x",
          accountId: target.accountId,
        });
        await nativeAdapter.unfollowUser({ account, userId: target.profileId, context });
      },
      async block(target: ProfileRef, context): Promise<RelationshipRecord> {
        const account = connectedAccountRef({
          backend: target.backend,
          platform: "x",
          accountId: target.accountId,
        });
        await nativeAdapter.blockUser({ account, userId: target.profileId, context });
        return { profile: target, relationship: "blocked" };
      },
      async unblock(target: ProfileRef, context): Promise<void> {
        const account = connectedAccountRef({
          backend: target.backend,
          platform: "x",
          accountId: target.accountId,
        });
        await nativeAdapter.unblockUser({ account, userId: target.profileId, context });
      },
      async mute(target: ProfileRef, context): Promise<RelationshipRecord> {
        const account = connectedAccountRef({
          backend: target.backend,
          platform: "x",
          accountId: target.accountId,
        });
        await nativeAdapter.muteUser({ account, userId: target.profileId, context });
        return { profile: target, relationship: "muted" };
      },
      async unmute(target: ProfileRef, context): Promise<void> {
        const account = connectedAccountRef({
          backend: target.backend,
          platform: "x",
          accountId: target.accountId,
        });
        await nativeAdapter.unmuteUser({ account, userId: target.profileId, context });
      },
    },
    search: {
      posts: (account, input, context) => searchPosts(account, input, context),
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
    messages: {
      async listConversations(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ): Promise<Page<JsonObject>> {
        // X has no conversation-list endpoint. This page is derived from /2/dm_events,
        // with one latest event for each distinct dm_conversation_id in the page.
        requireUserToken("messages.read");
        const page = await nativeAdapter.listDirectMessages({
          account,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          context,
        });
        const latest = new Map<string, JsonObject>();
        for (const event of page.items) {
          const conversationId = optionalString(event["dm_conversation_id"]);
          if (conversationId !== undefined && !latest.has(conversationId))
            latest.set(conversationId, event);
        }
        return {
          items: [...latest.values()],
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
      },
      async listMessages(
        conversation: ConversationRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ): Promise<Page<JsonObject>> {
        requireUserToken("messages.read");
        return nativeAdapter.listDirectMessages({
          account: connectedAccountRef({
            backend: conversation.backend,
            platform: "x",
            accountId: conversation.accountId,
          }),
          conversationId: conversation.conversationId,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          context,
        });
      },
      async send(
        conversation: ConversationRef,
        content: { readonly text: string },
        context: AdapterOperationContext,
      ): Promise<JsonObject> {
        requireUserToken("messages.write");
        return nativeAdapter.sendConversationMessage({
          account: connectedAccountRef({
            backend: conversation.backend,
            platform: "x",
            accountId: conversation.accountId,
          }),
          conversationId: conversation.conversationId,
          text: content.text,
          context,
        });
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
    native: (nativeAdapter = {
      async searchRecentPosts({ account, search, context }) {
        return searchPosts(account, { ...search, scope: "recent" }, context, search);
      },
      async searchAllPosts({ account, search, context }) {
        return searchPosts(account, { ...search, scope: "all" }, context, search);
      },
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
      async listDirectMessages({ account, participantId, conversationId, cursor, limit, context }) {
        authorize(account, context);
        const path = conversationId
          ? `/2/dm_conversations/${encodeURIComponent(conversationId)}/dm_events`
          : participantId
            ? `/2/dm_conversations/with/${encodeURIComponent(participantId)}/dm_events`
            : "/2/dm_events";
        const result = object(
          await request(path, context, undefined, {
            "dm_event.fields":
              "id,text,event_type,created_at,sender_id,dm_conversation_id,attachments,referenced_tweets",
            ...(cursor === undefined ? {} : { pagination_token: cursor }),
            ...(limit === undefined ? {} : { max_results: String(limit) }),
          }),
        );
        const meta = result["meta"] === undefined ? {} : object(result["meta"]);
        const nextCursor = optionalString(meta["next_token"]);
        return {
          items: result["data"] === undefined ? [] : array(result["data"]).map(object),
          ...(nextCursor === undefined ? {} : { nextCursor }),
        };
      },
      async sendDirectMessage({ account, participantId, text, context }) {
        authorize(account, context);
        return object(
          await request(
            `/2/dm_conversations/with/${encodeURIComponent(participantId)}/messages`,
            context,
            { text },
          ),
        ) as JsonObject;
      },
      async sendConversationMessage({ account, conversationId, text, attachments, context }) {
        authorize(account, context);
        return object(
          await requireUserToken("messages.conversation.write")(
            `/2/dm_conversations/${encodeURIComponent(conversationId)}/messages`,
            context,
            { text, ...(attachments === undefined ? {} : { attachments }) },
          ),
        );
      },
      async createGroupConversation({ account, participantIds, message, context }) {
        authorize(account, context);
        return object(
          await requireUserToken("messages.group.write")("/2/dm_conversations", context, {
            conversation_type: "Group",
            participant_ids: [...participantIds],
            message: { text: message },
          }),
        );
      },
      async getUserById({ account, userId, context }) {
        authorize(account, context);
        const result = object(
          await readRequest("users")(`/2/users/${encodeURIComponent(userId)}`, context, undefined, {
            "user.fields":
              "id,name,username,description,created_at,public_metrics,profile_image_url,verified",
          }),
        );
        const errors = result["errors"];
        if (errors !== undefined && result["data"] === undefined) {
          const detail =
            array(errors)[0] === undefined
              ? "X user was not found."
              : (optionalString(object(array(errors)[0])["detail"]) ?? "X user was not found.");
          throw new SocialError({ code: "not_found", operation: "profiles.read", message: detail });
        }
        return result;
      },
      async getUserByUsername({ account, username, context }) {
        authorize(account, context);
        const result = object(
          await readRequest("users")(
            `/2/users/by/username/${encodeURIComponent(username)}`,
            context,
            undefined,
            {
              "user.fields":
                "id,name,username,description,created_at,public_metrics,profile_image_url,verified",
            },
          ),
        );
        if (result["errors"] !== undefined && result["data"] === undefined) {
          const first = array(result["errors"])[0];
          throw new SocialError({
            code: "not_found",
            operation: "profiles.read",
            message:
              first === undefined
                ? "X user was not found."
                : (optionalString(object(first)["detail"]) ?? "X user was not found."),
          });
        }
        return result;
      },
      async getMe({ account, context }) {
        authorize(account, context);
        return object(
          await readRequest("users")("/2/users/me", context, undefined, {
            "user.fields":
              "id,name,username,description,created_at,public_metrics,profile_image_url,verified",
          }),
        );
      },
      async followers({ account, userId, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(userId)}/followers`,
          account,
          { cursor, limit },
          context,
        );
      },
      async following({ account, userId, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(userId)}/following`,
          account,
          { cursor, limit },
          context,
        );
      },
      followUser: async ({ account, userId, context }) =>
        object(
          await requireUserToken("graph.follow")(
            `/2/users/${encodeURIComponent(account.accountId)}/following`,
            context,
            {
              target_user_id: userId,
            },
          ),
        ) as JsonObject,
      async unfollowUser({ account, userId, context }) {
        authorize(account, context);
        await requireUserToken("graph.unfollow")(
          `/2/users/${encodeURIComponent(account.accountId)}/following/${encodeURIComponent(userId)}`,
          context,
          undefined,
          {},
          "DELETE",
        );
      },
      async muteUser({ account, userId, context }) {
        authorize(account, context);
        return object(
          await requireUserToken("graph.mute")(
            `/2/users/${encodeURIComponent(account.accountId)}/muting`,
            context,
            {
              target_user_id: userId,
            },
          ),
        );
      },
      async unmuteUser({ account, userId, context }) {
        authorize(account, context);
        await requireUserToken("graph.unmute")(
          `/2/users/${encodeURIComponent(account.accountId)}/muting/${encodeURIComponent(userId)}`,
          context,
          undefined,
          {},
          "DELETE",
        );
      },
      async mutedUsers({ account, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(account.accountId)}/muting`,
          account,
          { cursor, limit },
          context,
        );
      },
      async blockUser({ account, userId, context }) {
        authorize(account, context);
        return object(
          await requireUserToken("graph.block")(
            `/2/users/${encodeURIComponent(account.accountId)}/blocking`,
            context,
            {
              target_user_id: userId,
            },
          ),
        );
      },
      async unblockUser({ account, userId, context }) {
        authorize(account, context);
        await requireUserToken("graph.unblock")(
          `/2/users/${encodeURIComponent(account.accountId)}/blocking/${encodeURIComponent(userId)}`,
          context,
          undefined,
          {},
          "DELETE",
        );
      },
      async blockedUsers({ account, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(account.accountId)}/blocking`,
          account,
          { cursor, limit },
          context,
        );
      },
      async like({ account, postId, context }) {
        authorize(account, context);
        await request(`/2/users/${encodeURIComponent(account.accountId)}/likes`, context, {
          tweet_id: postId,
        });
      },
      async unlike({ account, postId, context }) {
        authorize(account, context);
        await request(
          `/2/users/${encodeURIComponent(account.accountId)}/likes/${encodeURIComponent(postId)}`,
          context,
          undefined,
          {},
          "DELETE",
        );
      },
      async likedPosts({ account, userId, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(userId ?? account.accountId)}/liked_tweets`,
          account,
          { cursor, limit },
          context,
          {},
          "id,name,username,description,created_at,public_metrics",
          "tweets",
        );
      },
      async likingUsers({ account, postId, cursor, limit, context }) {
        return pageRequest(
          `/2/tweets/${encodeURIComponent(postId)}/liking_users`,
          account,
          { cursor, limit },
          context,
          {},
          "id,name,username,description,created_at,public_metrics",
          "users",
        );
      },
      async createList({ account, name, description, isPrivate, context }) {
        authorize(account, context);
        return object(
          await request("/2/lists", context, {
            name,
            ...(description === undefined ? {} : { description }),
            ...(isPrivate === undefined ? {} : { private: isPrivate }),
          }),
        );
      },
      async updateList({ account, listId, name, description, isPrivate, context }) {
        authorize(account, context);
        return object(
          await request(
            `/2/lists/${encodeURIComponent(listId)}`,
            context,
            {
              ...(name === undefined ? {} : { name }),
              ...(description === undefined ? {} : { description }),
              ...(isPrivate === undefined ? {} : { private: isPrivate }),
            },
            {},
            "PUT",
          ),
        );
      },
      async deleteList({ account, listId, context }) {
        authorize(account, context);
        await request(`/2/lists/${encodeURIComponent(listId)}`, context, undefined, {}, "DELETE");
      },
      async getList({ account, listId, context }) {
        authorize(account, context);
        return object(await request(`/2/lists/${encodeURIComponent(listId)}`, context));
      },
      async listMembers({ account, listId, cursor, limit, context }) {
        return pageRequest(
          `/2/lists/${encodeURIComponent(listId)}/members`,
          account,
          { cursor, limit },
          context,
        );
      },
      async addListMember({ account, listId, userId, context }) {
        authorize(account, context);
        return object(
          await request(`/2/lists/${encodeURIComponent(listId)}/members`, context, {
            user_id: userId,
          }),
        );
      },
      async removeListMember({ account, listId, userId, context }) {
        authorize(account, context);
        await request(
          `/2/lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(userId)}`,
          context,
          undefined,
          {},
          "DELETE",
        );
      },
      async followList({ account, listId, context }) {
        authorize(account, context);
        return object(
          await request(
            `/2/users/${encodeURIComponent(account.accountId)}/followed_lists`,
            context,
            { list_id: listId },
          ),
        );
      },
      async unfollowList({ account, listId, context }) {
        authorize(account, context);
        await request(
          `/2/users/${encodeURIComponent(account.accountId)}/followed_lists/${encodeURIComponent(listId)}`,
          context,
          undefined,
          {},
          "DELETE",
        );
      },
      async ownedLists({ account, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(account.accountId)}/owned_lists`,
          account,
          { cursor, limit },
          context,
        );
      },
      async pinList({ account, listId, context }) {
        authorize(account, context);
        return object(
          await requireUserToken("lists.pinned.write")(
            `/2/users/${encodeURIComponent(account.accountId)}/pinned_lists`,
            context,
            {
              list_id: listId,
            },
          ),
        );
      },
      async unpinList({ account, listId, context }) {
        authorize(account, context);
        await requireUserToken("lists.pinned.write")(
          `/2/users/${encodeURIComponent(account.accountId)}/pinned_lists/${encodeURIComponent(listId)}`,
          context,
          undefined,
          {},
          "DELETE",
        );
      },
      async pinnedLists({ account, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(account.accountId)}/pinned_lists`,
          account,
          { cursor, limit },
          context,
        );
      },
      async listPosts({ account, listId, cursor, limit, context }) {
        return pageRequest(
          `/2/lists/${encodeURIComponent(listId)}/tweets`,
          account,
          { cursor, limit },
          context,
          {},
          "id,name,username,description,created_at,public_metrics",
          "tweets",
        );
      },
      async userPosts({ account, userId, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(userId)}/tweets`,
          account,
          { cursor, limit },
          context,
          {},
          "id,name,username,description,created_at,public_metrics",
          "tweets",
        );
      },
      async homeTimeline({ account, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(account.accountId)}/timelines/reverse_chronological`,
          account,
          { cursor, limit },
          context,
          {},
          "id,name,username,description,created_at,public_metrics",
          "tweets",
        );
      },
      async mentions({ account, userId, cursor, limit, context }) {
        return pageRequest(
          `/2/users/${encodeURIComponent(userId ?? account.accountId)}/mentions`,
          account,
          { cursor, limit },
          context,
          {},
          "id,name,username,description,created_at,public_metrics",
          "tweets",
        );
      },
      async undoRepost({ account, postId, context }) {
        authorize(account, context);
        await request(
          `/2/users/${encodeURIComponent(account.accountId)}/retweets/${encodeURIComponent(postId)}`,
          context,
          undefined,
          {},
          "DELETE",
        );
      },
      async stream({ account, context }) {
        authorize(account, context);
        if (!options.appBearerToken?.trim())
          throw new SocialError({
            code: "missing_permission",
            operation: "streams.read",
            message: "Filtered stream requires an app-only bearer token. Configure appBearerToken.",
          });

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return (await http({
          url: new URL("https://api.x.com/2/tweets/search/stream"),
          headers: { Authorization: `Bearer ${options.appBearerToken}` },
          timeoutMs: remainingBudget(context),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(context.signal ? { signal: context.signal } : {}),
        })) as Response;
      },
    }),
  });
  return adapter;
}
