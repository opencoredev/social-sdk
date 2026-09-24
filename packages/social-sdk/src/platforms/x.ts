import { remainingBudget } from "../transport/budget.js";
import { definedFields } from "../core/fields.js";
import { isValidXText } from "./x-text.js";
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
  JsonValue,
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
import { managedHttp, optionsObject, publicFields } from "../cloud/common.js";
import { verifyXWebhook } from "../server/webhooks.js";
import { directWebhooks, webhookCapability } from "./webhook-adapter.js";
import { createHttp, HttpError } from "../transport/http.js";
import { isJsonValue } from "../transport/json.js";
import {
  array,
  isString,
  object,
  optionalNumber,
  optionalString,
  string,
} from "../transport/validation.js";

// 53-bit conversation ID hashes, 11 base36 characters each. listConversations returns at
// most 1,200 distinct conversations, which keeps its cursor well under the client's 16,384
// character cursor limit.
const conversationHashWidth = 11;

const maxConversationHashes = 1200;

const replyFields = [
  "id",
  "text",
  "author_id",
  "created_at",
  "conversation_id",
  "in_reply_to_user_id",
  "referenced_tweets",
  "public_metrics",
] as const;

function conversationHash(id: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let index = 0; index < id.length; index++) {
    const code = id.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);

  return value.toString(36).padStart(conversationHashWidth, "0");
}

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
  /**
   * OAuth 2.0 client secret (or legacy OAuth 1.0 consumer secret) that X uses to sign
   * webhook deliveries and CRC responses.
   */
  readonly webhookSecret?: string;
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

export interface XUploadedMedia {
  readonly mediaId: string;
}

/** A confirmed X post edit. X assigns every edited version a new post ID. */
export interface XUpdatedPost {
  /** Reference to the new version created by the edit. */
  readonly post: PlatformPostRef;
  /** The post ID that was passed as `previous_post_id`. */
  readonly previousPostId: string;
  readonly text: string;
  /** Oldest-first edit chain, when X returns it. The first entry is the original post ID. */
  readonly editHistoryPostIds?: readonly string[];
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
  /**
   * Edits the text of a recent post with `POST /2/tweets` and `edit_options.previous_post_id`.
   * X decides eligibility (X Premium, own post, edit window, edit count) and returns a new post ID.
   * Sources, accessed 2026-09-24: https://docs.x.com/x-api/posts/create-post,
   * https://docs.x.com/x-api/fundamentals/edit-posts, https://docs.x.com/changelog (2025-10-03).
   */
  readonly updatePost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly text: string;
    readonly context: AdapterOperationContext;
  }) => Promise<XUpdatedPost>;
  /** Uploads one MP4 Blob (up to 512 MiB) and waits for processing. Returns an attachable media ID. */
  readonly uploadVideo: (input: {
    readonly account: ConnectedAccountRef;
    readonly video: Blob;
    readonly context: AdapterOperationContext;
  }) => Promise<XUploadedMedia>;
  /** Uploads one GIF Blob (up to 15 MiB) and waits for processing. Returns an attachable media ID. */
  readonly uploadGif: (input: {
    readonly account: ConnectedAccountRef;
    readonly gif: Blob;
    readonly context: AdapterOperationContext;
  }) => Promise<XUploadedMedia>;
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
  /**
   * Hides or unhides a reply in a conversation the authenticated user started.
   * Calls `PUT /2/tweets/:id/hidden` and returns the hidden state X reports.
   */
  readonly hideReply: (input: {
    readonly account: ConnectedAccountRef;
    readonly replyId: string;
    readonly hidden: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<{ readonly hidden: boolean }>;
}

export function x(options: XOptions): import("../core/adapter.js").SocialAdapter<XNative> {
  const request = managedHttp("https://api.x.com", {
    apiKey: options.auth.accessToken ?? "app-auth-placeholder",
    ...definedFields({ fetch: options.fetch }),
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
      ...definedFields({ fetch: options.fetch }),
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

  const readRequest = (path: string) =>
    ["/2/users/me", "/liked_tweets", "/mentions", "/timelines/reverse_chronological"].some(
      (suffix) => path.includes(suffix),
    )
      ? requireUserToken("x.read")
      : options.auth.accessToken?.trim()
        ? request
        : appRequest();

  const http = createHttp(definedFields({ fetch: options.fetch }));
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
      ...definedFields({ handle: optionalString(user["username"]) }),
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

    return result;
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
          ...definedFields({
            pagination_token: input.cursor,
            max_results: input.limit?.toString(),
          }),
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
      ...definedFields({ nextCursor }),
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

    if (!query.trim() || query.length > 4096)
      throw new SocialError({
        code: "invalid_input",
        operation: "search.posts",
        message: "X search queries must contain 1-4096 characters.",
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
      await (options.auth.accessToken?.trim() ? request : appRequest())(
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
          ...definedFields({
            next_token: input.cursor,
            max_results: input.limit?.toString(),
            start_time: input.startTime,
            end_time: input.endTime,
            sort_order: nativeInput?.sortOrder,
            expansions: nativeInput?.expansions?.join(","),
            "user.fields": nativeInput?.userFields?.join(","),
            "media.fields": nativeInput?.mediaFields?.join(","),
          }),
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

      const picked: Record<string, JsonValue> = {};

      // A Set keeps first-seen order, so "id" and "text" lead and repeated fields appear once.
      for (const field of new Set(["id", "text", ...requestedFields])) {
        const value = row[field];

        if (value !== undefined) picked[field] = value;
      }

      return picked;
    });

    const meta = result["meta"] === undefined ? {} : object(result["meta"]);
    const nextCursor = optionalString(meta["next_token"]);

    const includes = result["includes"];

    return {
      items,
      ...definedFields({
        nextCursor,
        metadata: includes === undefined ? undefined : { includes: object(includes) },
      }),
    };
  }

  // Replies come from recent search with the standalone `conversation_id:` operator, which is
  // the method X documents for reading a conversation. Sources, accessed 2026-09-24:
  // https://docs.x.com/x-api/fundamentals/conversation-id
  // https://docs.x.com/x-api/posts/search/integrate/operators
  // https://docs.x.com/x-api/posts/search-recent-posts (max_results 10-100, next_token)
  // https://docs.x.com/x-api/posts/search/introduction (recent search covers the last 7 days)
  // https://docs.x.com/x-api/fundamentals/rate-limits (450/15min per app, 300/15min per user)
  async function listReplies(
    post: PlatformPostRef,
    input: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
    context: AdapterOperationContext,
  ): Promise<Page<JsonObject>> {
    authorize(post, context);

    if (!/^[0-9]{1,19}$/.test(post.postId))
      throw new SocialError({
        code: "invalid_input",
        operation: "comments.read",
        message: "X post IDs must be numeric.",
      });

    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 10 || input.limit > 100)
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "comments.read",
        message: "X reply limits must be integers from 10 through 100.",
      });

    const result = object(
      await (options.auth.accessToken?.trim() ? request : appRequest())(
        "/2/tweets/search/recent",
        context,
        undefined,
        {
          query: `conversation_id:${post.postId}`,
          "tweet.fields": replyFields.join(","),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(input.cursor === undefined ? {} : { next_token: input.cursor }),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(input.limit === undefined ? {} : { max_results: String(input.limit) }),
        },
      ),
    );

    const items = (result["data"] === undefined ? [] : array(result["data"])).flatMap((entry) => {
      const row = object(entry);
      const id = string(row["id"]);

      if (row["conversation_id"] !== post.postId)
        throw new SocialError({
          code: "unauthorized",
          operation: "comments.read",
          message: "X returned a post from a different conversation.",
        });

      // The conversation root shares its own conversation_id; it is not a reply.
      if (id === post.postId) return [];

      const references =
        row["referenced_tweets"] === undefined
          ? undefined
          : array(row["referenced_tweets"]).map((reference) => {
              const item = object(reference);
              return { type: string(item["type"]), id: string(item["id"]) };
            });
      const counts =
        row["public_metrics"] === undefined ? undefined : object(row["public_metrics"]);

      return [
        {
          ...publicFields(row, replyFields),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(references === undefined ? {} : { referenced_tweets: references }),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(counts === undefined
            ? {}
            : {
                public_metrics: Object.fromEntries(
                  Object.keys(counts).flatMap((name) => {
                    const value = optionalNumber(counts[name]);
                    return value === undefined ? [] : [[name, value]];
                  }),
                ),
              }),
        },
      ];
    });

    const meta = result["meta"] === undefined ? {} : object(result["meta"]);
    const nextCursor = optionalString(meta["next_token"]);

    return {
      items,
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
      ...(nextCursor === undefined ? {} : { nextCursor }),
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
    const minLimit = 1;
    const maxLimit = 100;

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
          : path.endsWith("/owned_lists") || path.endsWith("/pinned_lists")
            ? { "list.fields": fields }
            : fields
              ? { "user.fields": fields }
              : {}),
        ...definedFields({ pagination_token: input.cursor, max_results: input.limit?.toString() }),
      }),
    );

    const items = (result["data"] === undefined ? [] : array(result["data"])).map(object);

    const meta = result["meta"] === undefined ? {} : object(result["meta"]);
    const nextCursor = optionalString(meta["next_token"]);

    return { items, ...definedFields({ nextCursor }) };
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
        (isString(parent["conversation_id"]) &&
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
    requireUserToken("media.upload");

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
    let result: JsonValue;

    try {
      result = await http({
        url: new URL("https://api.x.com/2/media/upload"),
        method: "POST",
        headers: { Authorization: `Bearer ${options.auth.accessToken}` },
        body,
        timeoutMs: remainingBudget(context),
        ...definedFields({ signal: context.signal }),
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

  const xChunkBytes = 1024 * 1024;
  const xMaxVideoBytes = 512 * 1024 * 1024;
  const xMaxGifBytes = 15 * 1024 * 1024;
  const xMaxStatusPolls = 30;

  type XChunkedCategory = "tweet_video" | "tweet_gif";

  type XProcessing = { state: string; checkAfterSecs: number };

  function chunkedCategory(media: MediaAttachment): XChunkedCategory | undefined {
    if (media.source.kind !== "blob") return undefined;

    if (media.kind === "video" && media.mimeType === "video/mp4") return "tweet_video";

    if (media.kind === "image" && media.mimeType === "image/gif") return "tweet_gif";

    return undefined;
  }

  function chunkedLimits(media: MediaAttachment, category: XChunkedCategory): void {
    const size = media.source.kind === "blob" ? media.source.blob.size : 0;
    const maxBytes = category === "tweet_video" ? xMaxVideoBytes : xMaxGifBytes;

    if (size <= 0 || size > maxBytes)
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message:
          category === "tweet_video"
            ? "X video uploads require a non-empty MP4 Blob up to 512 MiB."
            : "X GIF uploads require a non-empty GIF Blob up to 15 MiB.",
      });
  }

  function mediaHttpError(error: HttpError): SocialError {
    if (error.kind === "cancelled")
      return new SocialError({
        code: "cancelled",
        operation: "media.upload",
        message: "X media upload was cancelled before completion.",
        upstreamStatus: error.status,
      });

    if (error.kind === "timeout")
      return new SocialError({
        code: "timeout",
        operation: "media.upload",
        message: "X media upload exceeded its elapsed budget. Reconcile before retrying.",
        upstreamStatus: error.status,
        retryDisposition: { kind: "never" },
      });

    if (error.status === 401)
      return new SocialError({
        code: "reconnect_required",
        operation: "media.upload",
        message: "X rejected the media upload credentials. Reconnect before retrying.",
        upstreamStatus: error.status,
        retryDisposition: { kind: "after-reconnect" },
      });

    if (error.status === 429)
      return new SocialError({
        code: "rate_limited",
        operation: "media.upload",
        message: "X rate-limited the media upload.",
        upstreamStatus: error.status,
        retryDisposition:
          error.retryAfterMs === undefined
            ? { kind: "never" }
            : { kind: "after-delay", delayMs: error.retryAfterMs },
      });

    if (error.status === 413)
      return new SocialError({
        code: "media_error",
        operation: "media.upload",
        message: "Media chunk rejected by X (payload too large).",
        upstreamStatus: error.status,
        retryDisposition: { kind: "never" },
      });

    return new SocialError({
      code: "media_error",
      operation: "media.upload",
      message: error.message,
      upstreamStatus: error.status,
      retryDisposition: { kind: "never" },
    });
  }

  async function chunkedPost(
    path: string,
    body: JsonObject | undefined,
    context: AdapterOperationContext,
  ): Promise<JsonObject> {
    requireUserToken("media.upload");
    let result: JsonValue;

    try {
      result = await http({
        url: new URL(`https://api.x.com${path}`),
        method: "POST",
        headers:
          body === undefined
            ? { Authorization: `Bearer ${options.auth.accessToken}` }
            : {
                Authorization: `Bearer ${options.auth.accessToken}`,
                "Content-Type": "application/json",
              },
        timeoutMs: remainingBudget(context),
        ...definedFields({
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: context.signal,
        }),
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      throw mediaHttpError(error);
    }

    return object(object(result)["data"]);
  }

  async function appendChunk(
    mediaId: string,
    segmentIndex: number,
    chunk: Blob,
    context: AdapterOperationContext,
  ): Promise<void> {
    requireUserToken("media.upload");
    const body = new FormData();
    body.set("segment_index", String(segmentIndex));
    body.set("media", chunk, `chunk-${segmentIndex}`);

    try {
      await http({
        url: new URL(`https://api.x.com/2/media/upload/${encodeURIComponent(mediaId)}/append`),
        method: "POST",
        headers: { Authorization: `Bearer ${options.auth.accessToken}` },
        body,
        timeoutMs: remainingBudget(context),
        ...definedFields({ signal: context.signal }),
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      throw mediaHttpError(error);
    }
  }

  async function readMediaStatus(
    mediaId: string,
    context: AdapterOperationContext,
  ): Promise<XProcessing> {
    requireUserToken("media.upload");
    let result: JsonValue;

    try {
      result = await http({
        url: new URL(
          `https://api.x.com/2/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
        ),
        method: "GET",
        headers: { Authorization: `Bearer ${options.auth.accessToken}` },
        timeoutMs: remainingBudget(context),
        ...definedFields({ signal: context.signal }),
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      throw mediaHttpError(error);
    }

    const data = object(object(result)["data"]);
    const processing = data["processing_info"];

    if (processing === undefined) return { state: "succeeded", checkAfterSecs: 0 };

    return processingState(object(processing));
  }

  function processingState(info: JsonObject): XProcessing {
    const checkAfter = optionalNumber(info["check_after_secs"]);

    return {
      state: optionalString(info["state"]) ?? "pending",
      // X always sends check_after_secs while processing; a missing value must not spin the poll.
      checkAfterSecs:
        checkAfter !== undefined && Number.isFinite(checkAfter) && checkAfter >= 0 ? checkAfter : 1,
    };
  }

  function uploadCancelled(): SocialError {
    return new SocialError({
      code: "cancelled",
      operation: "media.upload",
      message: "X media upload was cancelled before completion.",
    });
  }

  function throwIfUploadCancelled(context: AdapterOperationContext): void {
    if (context.signal?.aborted) throw uploadCancelled();
  }

  /** Waits for X's processing hint without outliving the shared operation budget. */
  function processingWait(milliseconds: number, context: AdapterOperationContext): Promise<void> {
    throwIfUploadCancelled(context);

    if (milliseconds <= 0) return Promise.resolve();

    if (milliseconds >= remainingBudget(context))
      throw new SocialError({
        code: "timeout",
        operation: "media.upload",
        message:
          "X media processing needs longer than the remaining elapsed budget. No post was created.",
        retryDisposition: { kind: "never" },
      });

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(uploadCancelled());
      };

      const timer = setTimeout(() => {
        context.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);

      context.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function uploadVideoOrGif(
    media: MediaAttachment,
    context: AdapterOperationContext,
  ): Promise<string> {
    try {
      return await chunkedUpload(media, context);
    } catch (error) {
      // Malformed upload responses fail before any post request, so they are definite failures.
      if (error instanceof HttpError) throw mediaHttpError(error);

      throw error;
    }
  }

  async function chunkedUpload(
    media: MediaAttachment,
    context: AdapterOperationContext,
  ): Promise<string> {
    requireUserToken("media.upload");
    const category = chunkedCategory(media);

    if (category === undefined || media.source.kind !== "blob")
      throw new SocialError({
        code: "invalid_input",
        operation: "media.upload",
        message: "X chunked upload requires a video/mp4 or image/gif Blob.",
      });

    chunkedLimits(media, category);
    const blob = media.source.blob;
    const totalBytes = blob.size;

    const initialized = await chunkedPost(
      "/2/media/upload/initialize",
      {
        media_category: category,
        media_type: category === "tweet_video" ? "video/mp4" : "image/gif",
        total_bytes: totalBytes,
      },
      context,
    );

    const mediaId = string(initialized["id"]);
    const segmentCount = Math.ceil(totalBytes / xChunkBytes);

    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
      throwIfUploadCancelled(context);
      const start = segmentIndex * xChunkBytes;
      const end = Math.min(start + xChunkBytes, totalBytes);
      const chunk = blob.slice(start, end, media.mimeType ?? "");

      await appendChunk(mediaId, segmentIndex, chunk, context);
    }

    const finalized = await chunkedPost(
      `/2/media/upload/${encodeURIComponent(mediaId)}/finalize`,
      undefined,
      context,
    );

    const finalizedId = optionalString(finalized["id"]) ?? mediaId;
    const processing = finalized["processing_info"];

    if (processing === undefined) return finalizedId;

    let { state, checkAfterSecs } = processingState(object(processing));

    for (let poll = 0; ; poll++) {
      if (state === "succeeded") return finalizedId;

      if (state === "failed")
        throw new SocialError({
          code: "media_error",
          operation: "media.upload",
          message: "X failed to process the uploaded media. No post was created.",
          retryDisposition: { kind: "never" },
        });

      if (poll >= xMaxStatusPolls) break;

      await processingWait(checkAfterSecs * 1000, context);

      ({ state, checkAfterSecs } = await readMediaStatus(finalizedId, context));
    }

    throw new SocialError({
      code: "timeout",
      operation: "media.upload",
      message: "X media processing did not complete in time. Reconcile before retrying.",
      retryDisposition: { kind: "never" },
    });
  }

  async function uploadXMedia(
    media: MediaAttachment,
    context: AdapterOperationContext,
  ): Promise<string> {
    if (chunkedCategory(media) !== undefined) return uploadVideoOrGif(media, context);

    return uploadImage(media, context);
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
        webhookCapability(
          "x",
          "Verifies X-Twitter-Webhooks-Signature-OAuth2 or the legacy X-Twitter-Webhooks-Signature and decodes Account Activity deliveries. Answer the CRC GET with answerXWebhookChallenge.",
        ),
        {
          platform: "x",
          operation: "posts.publish",
          availability: "available" as const,
          formats: ["text" as const, "image" as const, "video" as const],
          requiredScopes: ["tweet.read", "tweet.write", "users.read", "media.write"],
          notes:
            "User-context OAuth2 token; current X API access/billing required. Up to four static JPEG/PNG image Blobs, each at most 5 MiB, or one MP4 video up to 512 MiB / one GIF up to 15 MiB via 1 MiB chunked upload with bounded processing poll. Post attach can still reject over-duration video with 403.",
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
          ...(["likes.read"].includes(operation)
            ? { requiredScopes: ["like.read", "tweet.read", "users.read"] }
            : ["likes.write"].includes(operation)
              ? { requiredScopes: ["like.write", "tweet.read", "users.read"] }
              : ["lists.read"].includes(operation)
                ? { requiredScopes: ["list.read", "tweet.read", "users.read"] }
                : ["lists.write"].includes(operation)
                  ? { requiredScopes: ["list.write", "tweet.read", "users.read"] }
                  : ["timelines.read", "mentions.read", "posts.list"].includes(operation)
                    ? { requiredScopes: ["tweet.read", "users.read"] }
                    : ["posts.quote", "posts.delete", "posts.publish"].includes(operation)
                      ? { requiredScopes: ["tweet.read", "tweet.write", "users.read"] }
                      : {}),
        })),
        {
          platform: "x",
          operation: "posts.removeFromPlatform",
          availability: "available" as const,
          requiredScopes: ["tweet.read", "tweet.write", "users.read"],
        },
        {
          platform: "x",
          operation: "posts.update",
          availability: "available" as const,
          formats: ["text" as const],
          requiredScopes: ["tweet.read", "tweet.write", "users.read"],
          notes:
            "Text-only edit through native.updatePost. X requires X Premium, the account's own post, and a recent post within X's edit window and edit count. Polls, replies to others, reposts, and scheduled posts are not editable. Each edit creates a new post ID.",
        },
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
          operation: "comments.read",
          availability: "available" as const,
          requiredScopes: ["tweet.read", "users.read"],
          notes:
            "Replies come from recent search with conversation_id, so only replies from the last 7 days are returned. Pass the conversation's root post. Page limits are 10-100. Recent search allows 450 requests per 15 minutes per app and 300 per user, and X bills post reads under the app's plan.",
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
          requiredScopes: ["tweet.read", "tweet.write", "users.read", "media.write"],
          notes:
            "MP4 Blob chunked INIT/APPEND/FINALIZE with 1 MiB segments and bounded STATUS poll honoring check_after_secs.",
        },
        {
          platform: "x",
          operation: "media.gif",
          availability: "available" as const,
          requiredScopes: ["tweet.read", "tweet.write", "users.read", "media.write"],
          notes: "GIF Blob chunked upload; large GIFs process asynchronously before attach.",
        },
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
          operation: "comments.moderate",
          availability: "available" as const,
          requiredScopes: ["tweet.moderate.write", "tweet.read", "users.read"],
          notes:
            "Native hideReply hides or unhides replies in conversations the authenticated user started. Requires a user-context token.",
        },
        {
          platform: "x",
          operation: "streams.read",
          availability: "not-implemented-by-adapter" as const,
          notes:
            "Filtered stream rules and streaming transport are not implemented by this adapter.",
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
          ...definedFields({
            displayName: optionalString(user["name"]),
            handle: optionalString(user["username"]),
            bio: optionalString(user["description"]),
          }),
          native: user,
        };
      },
      async listRelationships(account, input, context): Promise<Page<RelationshipRecord>> {
        const pagination = {
          ...definedFields({ cursor: input.cursor, limit: input.limit }),
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
          ...definedFields({ nextCursor: result.nextCursor }),
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

        if (text && !isValidXText(text))
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
        const settings = optionsObject(target);

        if (
          Object.keys(settings).some((key) => key !== "replySettings") ||
          (settings["replySettings"] !== undefined &&
            !["everyone", "following", "mentionedUsers"].includes(
              String(settings["replySettings"]),
            ))
        )
          fail("x.options", "Provide only a supported replySettings value.");
        const media = target.content.media ?? [];
        const hasChunked = media.some((item) => chunkedCategory(item) !== undefined);

        if (hasChunked && media.length !== 1)
          fail("x.media_count", "Attach a single video or GIF per post.");
        else if (!hasChunked && media.length > 4)
          fail("x.media_count", "Attach up to four images.");

        for (const item of media) {
          const category = chunkedCategory(item);

          if (category === "tweet_video") {
            if (item.source.kind !== "blob" || item.source.blob.size === 0)
              fail("x.video_size", "Video must be a non-empty MP4 Blob.");
            else if (item.source.blob.size > xMaxVideoBytes)
              fail("x.video_size", "Video exceeds the 512 MiB limit.");
          } else if (category === "tweet_gif") {
            if (item.source.kind !== "blob" || item.source.blob.size === 0)
              fail("x.gif_size", "GIF must be a non-empty Blob.");
            else if (item.source.blob.size > xMaxGifBytes)
              fail("x.gif_size", "GIF exceeds the 15 MiB limit.");
          } else if (item.kind === "video")
            fail("x.video", "X video uploads require a video/mp4 Blob.");
          else if (
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

        for (const media of target.content.media ?? [])
          ids.push(await uploadXMedia(media, context));
        const replySettings = optionsObject(target)["replySettings"];

        const hasVideo = (target.content.media ?? []).some(
          (media) => chunkedCategory(media) === "tweet_video",
        );

        try {
          return await createPost(
            target.account,
            target.content.text ?? "",
            context,
            {
              ...definedFields({
                media: ids.length ? { media_ids: ids } : undefined,
                reply: target.replyTo ? { in_reply_to_tweet_id: target.replyTo.postId } : undefined,
                reply_settings:
                  replySettings && replySettings !== "everyone" ? string(replySettings) : undefined,
              }),
            },
            target.targetIndex,
          );
        } catch (error) {
          // X checks video duration only at attach time and answers 403. The transport drops the
          // response body, so the adapter cannot tell a duration limit from a missing permission.
          if (hasVideo && error instanceof SocialError && error.upstreamStatus === 403)
            throw new SocialError({
              code: "missing_permission",
              operation: error.operation,
              backend: error.backend,
              correlationId: error.correlationId,
              message:
                "X rejected the post with its attached video (HTTP 403). The video may exceed this account's duration limit, or the token may lack post permission. No post was created.",
              upstreamStatus: 403,
              retryDisposition: { kind: "never" },
            });

          throw error;
        }
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
      async removeFromPlatform(ref: PlatformPostRef, context: AdapterOperationContext) {
        authorize(ref, context);
        await nativeAdapter.deletePost({
          account: connectedAccountRef({
            backend: ref.backend,
            platform: "x",
            accountId: ref.accountId,
          }),
          postId: ref.postId,
          context,
        });
      },
    },
    comments: {
      async list(
        ref: PlatformPostRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ): Promise<Page<JsonObject>> {
        return listReplies(ref, input, context);
      },
      async reply(
        ref: CommentRef,
        content: { text: string },
        context: AdapterOperationContext,
      ): Promise<CommentRef> {
        await validateReplyParent(ref, context);

        if (!isValidXText(content.text))
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
        // with the latest event for each distinct dm_conversation_id.
        requireUserToken("messages.read");

        if (
          input.limit !== undefined &&
          (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.read",
            message: "X DM limits must be integers from 1 through 100.",
          });
        // The cursor carries the event cursor plus fixed-width hashes of the conversations
        // already returned, so later event pages skip them. To stay under the client cursor
        // size limit, the walk ends after maxConversationHashes distinct conversations
        // rather than forgetting earlier ones and returning them again.
        let eventCursor: string | undefined;
        const seen: string[] = [];

        if (input.cursor !== undefined) {
          try {
            const parsed: unknown = JSON.parse(input.cursor);

            if (!isJsonValue(parsed)) throw new Error("bad cursor");
            const state = object(parsed);
            eventCursor = optionalString(state["c"]);
            const hashes = string(state["s"]);

            if (hashes.length % conversationHashWidth !== 0) throw new Error("bad cursor");

            for (let at = 0; at < hashes.length; at += conversationHashWidth)
              seen.push(hashes.slice(at, at + conversationHashWidth));
          } catch {
            throw new SocialError({
              code: "invalid_input",
              operation: "messages.read",
              message: "Use a cursor returned by listConversations.",
            });
          }
        }

        const seenSet = new Set(seen);
        const target = input.limit ?? 100;
        const items: JsonObject[] = [];

        // A walk that has reached the conversation cap has no next page.
        const pageFrom = (c: string | undefined): Page<JsonObject> =>
          seen.length >= maxConversationHashes
            ? { items }
            : { items, nextCursor: JSON.stringify({ c, s: seen.join("") }) };

        for (let fetches = 0; fetches < 10; fetches++) {
          const page = await nativeAdapter.listDirectMessages({
            account,
            ...definedFields({ cursor: eventCursor, limit: input.limit }),
            context,
          });

          for (const event of page.items) {
            const conversationId = optionalString(event["dm_conversation_id"]);

            if (conversationId === undefined) continue;

            const hash = conversationHash(conversationId);

            if (seenSet.has(hash)) continue;

            if (seen.length >= maxConversationHashes) return { items };

            // Stop mid-page and reread this event page next time; seen IDs skip the rest.
            if (items.length === target) return pageFrom(eventCursor);
            seenSet.add(hash);
            seen.push(hash);
            items.push(event);
          }

          if (page.nextCursor === undefined) return { items };
          eventCursor = page.nextCursor;

          if (items.length === target) break;
        }

        return pageFrom(eventCursor);
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
          ...definedFields({ cursor: input.cursor, limit: input.limit }),
          context,
        });
      },
      async send(
        conversation: ConversationRef,
        content: { readonly text: string },
        context: AdapterOperationContext,
      ): Promise<JsonObject> {
        requireUserToken("messages.write");

        if (!content.text.trim())
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.write",
            message: "X direct messages require non-empty text.",
          });

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
          ["impressions", "impression_count"],
          ["bookmarks", "bookmark_count"],
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
    webhooks: directWebhooks(
      "x",
      (input) => verifyXWebhook({ ...input, secret: options.webhookSecret ?? "" }),
      now,
    ),
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

        return object(
          await request(`/2/users/${encodeURIComponent(account.accountId)}/retweets`, context, {
            tweet_id: postId,
          }),
        );
      },
      async quote({ account, text, quotedPostId, context }) {
        authorize(account, context);

        return object(await request("/2/tweets", context, { text, quote_tweet_id: quotedPostId }));
      },
      async deletePost({ account, postId, context }) {
        authorize(account, context);
        await request(`/2/tweets/${encodeURIComponent(postId)}`, context, undefined, {}, "DELETE");
      },
      async updatePost({ account, postId, text, context }) {
        authorize(account, context);

        if (!/^[0-9]{1,19}$/.test(postId))
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.update",
            message: "X post edits require a numeric post ID.",
          });

        if (!text || !isValidXText(text))
          throw new SocialError({
            code: "invalid_input",
            operation: "posts.update",
            message:
              "Edited text is empty, exceeds X's weighted 280-character limit, or contains invalid characters.",
          });

        const result = object(
          await request("/2/tweets", context, {
            text,
            edit_options: { previous_post_id: postId },
          }),
        );

        const data = result["data"] === undefined ? {} : object(result["data"]);
        const id = optionalString(data["id"]);

        if (!id)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "posts.update",
            backend: context.backendInstance,
            correlationId: context.correlationId,
            message: "X edit response lacks a new post ID. Reconcile before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        const history = data["edit_history_post_ids"] ?? data["edit_history_tweet_ids"];

        const editHistoryPostIds = Array.isArray(history)
          ? history.filter((entry): entry is string => typeof entry === "string")
          : undefined;

        return {
          post: {
            kind: "platform-post",
            version: 1,
            backend: account.backend,
            platform: "x",
            accountId: account.accountId,
            postId: id,
          },
          previousPostId: postId,
          text: optionalString(data["text"]) ?? text,
          ...definedFields({ editHistoryPostIds }),
        };
      },
      async uploadVideo({ account, video, context }) {
        authorize(account, context);

        const media: MediaAttachment = {
          kind: "video",
          mimeType: "video/mp4",
          source: { kind: "blob", blob: video, fingerprint: "native-upload" },
        };

        return { mediaId: await uploadVideoOrGif(media, context) };
      },
      async uploadGif({ account, gif, context }) {
        authorize(account, context);

        const media: MediaAttachment = {
          kind: "image",
          mimeType: "image/gif",
          source: { kind: "blob", blob: gif, fingerprint: "native-upload" },
        };

        return { mediaId: await uploadVideoOrGif(media, context) };
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

        return object(
          await request("/2/tweets", context, {
            text,
            poll: { options: [...pollOptions], duration_minutes: durationMinutes },
          }),
        );
      },
      async bookmarks({ account, context }) {
        authorize(account, context);

        return object(
          await request(`/2/users/${encodeURIComponent(account.accountId)}/bookmarks`, context),
        );
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

        return object(
          await request(`/2/users/${encodeURIComponent(account.accountId)}/following`, context, {
            target_user_id: userId,
          }),
        );
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
      async listDirectMessages({ account, participantId, conversationId, cursor, limit, context }) {
        authorize(account, context);

        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.read",
            message: "X DM limits must be integers from 1 through 100.",
          });

        const path = conversationId
          ? `/2/dm_conversations/${encodeURIComponent(conversationId)}/dm_events`
          : participantId
            ? `/2/dm_conversations/with/${encodeURIComponent(participantId)}/dm_events`
            : "/2/dm_events";

        const result = object(
          await request(path, context, undefined, {
            "dm_event.fields":
              "id,text,event_type,created_at,dm_conversation_id,attachments,entities",
            expansions: "sender_id,participant_ids",
            ...definedFields({ pagination_token: cursor, max_results: limit?.toString() }),
          }),
        );

        const meta = result["meta"] === undefined ? {} : object(result["meta"]);
        const nextCursor = optionalString(meta["next_token"]);

        return {
          items: result["data"] === undefined ? [] : array(result["data"]).map(object),
          ...definedFields({ nextCursor }),
        };
      },
      async sendDirectMessage({ account, participantId, text, context }) {
        authorize(account, context);
        const userRequest = requireUserToken("messages.write");

        if (!text.trim())
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.write",
            message: "X direct messages require non-empty text.",
          });

        return object(
          await userRequest(
            `/2/dm_conversations/with/${encodeURIComponent(participantId)}/messages`,
            context,
            { text },
          ),
        );
      },
      async sendConversationMessage({ account, conversationId, text, attachments, context }) {
        authorize(account, context);

        if (!text.trim())
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.conversation.write",
            message: "X direct messages require non-empty text.",
          });

        return object(
          await requireUserToken("messages.conversation.write")(
            `/2/dm_conversations/${encodeURIComponent(conversationId)}/messages`,
            context,
            { text, ...definedFields({ attachments }) },
          ),
        );
      },
      async createGroupConversation({ account, participantIds, message, context }) {
        authorize(account, context);

        if (!message.trim())
          throw new SocialError({
            code: "invalid_input",
            operation: "messages.group.write",
            message: "X direct messages require non-empty text.",
          });

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
          await readRequest("/2/users/me")("/2/users/me", context, undefined, {
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
      async followUser({ account, userId, context }) {
        authorize(account, context);

        return object(
          await requireUserToken("graph.follow")(
            `/2/users/${encodeURIComponent(account.accountId)}/following`,
            context,
            {
              target_user_id: userId,
            },
          ),
        );
      },
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
        await requireUserToken("likes.write")(
          `/2/users/${encodeURIComponent(account.accountId)}/likes`,
          context,
          {
            tweet_id: postId,
          },
        );
      },
      async unlike({ account, postId, context }) {
        authorize(account, context);
        await requireUserToken("likes.write")(
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
          "id,name,description,created_at,public_metrics",
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
          "id,name,description,created_at,public_metrics",
          "users",
        );
      },
      async createList({ account, name, description, isPrivate, context }) {
        authorize(account, context);

        return object(
          await request("/2/lists", context, {
            name,
            ...definedFields({ description, private: isPrivate }),
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
              ...definedFields({ name, description, private: isPrivate }),
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
          {},
          "id,name,description,private,member_count,follower_count",
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
          {},
          "id,name,description,private,member_count,follower_count",
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
      async pinnedLists({ account, context }) {
        authorize(account, context);

        const result = object(
          await readRequest("pinned_lists")(
            `/2/users/${encodeURIComponent(account.accountId)}/pinned_lists`,
            context,
            undefined,
            { "list.fields": "id,name,description,private,member_count,follower_count" },
          ),
        );

        return { items: result["data"] === undefined ? [] : array(result["data"]).map(object) };
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
      async hideReply({ account, replyId, hidden, context }) {
        authorize(account, context);
        if (!/^[0-9]{1,19}$/.test(replyId))
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.moderate",
            message: "X reply IDs are numeric strings of 1 to 19 digits.",
            retryDisposition: { kind: "never" },
          });
        const result = object(
          await requireUserToken("comments.moderate")(
            `/2/tweets/${encodeURIComponent(replyId)}/hidden`,
            context,
            { hidden },
            {},
            "PUT",
          ),
        );
        const state = result["data"] === undefined ? undefined : object(result["data"])["hidden"];
        if (typeof state !== "boolean")
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "comments.moderate",
            message: "X did not report the reply's hidden state.",
            retryDisposition: { kind: "reconcile-first" },
          });
        return { hidden: state };
      },
    }),
  });

  return adapter;
}
