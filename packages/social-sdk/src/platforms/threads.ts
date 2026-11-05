import {
  connectedAccountRef,
  defineAdapter,
  platformPostRef,
  type AdapterOperationContext,
  type CommentRef,
  type CapabilityManifest,
  type DeliveryOutcome,
  type DeliveryRef,
  type JsonObject,
  type MetricValue,
  type SocialAdapter,
  type ConnectedAccountRef,
  type PreparedPublishTarget,
  type Page,
  type ProfileRecord,
  profileRef,
  type SearchPostsInput,
  type ThreadsPublishOptions,
  type ThreadsTextStyle,
} from "../core/index.js";
import { SocialError } from "../core/errors.js";
import { metaOAuthReconnect } from "../transport/provider-errors.js";
import { normalizeComment, normalizeMetrics } from "../core/projections.js";
import { managedHttp, optionsObject, publicFields } from "../cloud/common.js";
import { definedFields } from "../core/fields.js";
import {
  object,
  array,
  isJsonArray,
  isBoolean,
  isFiniteNumber,
  isJsonObject,
  isString,
  optionalArray,
  optionalNumber,
  optionalObject,
  optionalString,
  type JsonField,
} from "../transport/validation.js";
import { httpsUrl } from "../transport/upload.js";
import { verifyMetaWebhook } from "../server/webhooks.js";
import { directWebhooks, webhookCapability } from "./webhook-adapter.js";

export interface ThreadsAuthorization {
  readonly userId: string;
  readonly accessToken: string;
  readonly handle?: string;
}

export interface ThreadsWorkflow {
  readonly id: string;
  readonly backend: string;
  readonly accountId: string;
  readonly childIds: readonly string[];
  readonly parentId?: string;
  readonly nativeId?: string;
  readonly caption: string;
  readonly options: JsonObject;
  readonly stage: "children" | "parent" | "published" | "unknown";
  readonly backendState?: string;
  /**
   * `crossreshare_to_ig_status` from the publish response when `shareToInstagramStory` was set.
   * `FAILED` means the Threads post exists but the Instagram Story was not created.
   */
  readonly instagramStoryStatus?: "SUCCESS" | "FAILED";
}

export interface ThreadsWorkflowStore {
  create(input: Omit<ThreadsWorkflow, "id">): Promise<ThreadsWorkflow>;
  get(id: string): Promise<ThreadsWorkflow | undefined>;
  update(id: string, update: Partial<ThreadsWorkflow>): Promise<ThreadsWorkflow>;
  claim(id: string): Promise<boolean>;
  release?(id: string): Promise<void>;
}

export interface ThreadsSearchInput {
  readonly account: ConnectedAccountRef;
  readonly query: string;
  readonly cursor?: string;
  readonly searchType?: "TOP" | "RECENT";
  readonly searchMode?: "KEYWORD" | "TAG";
  readonly mediaType?: "TEXT" | "IMAGE" | "VIDEO";
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly authorUsername?: string;
  /**
   * Replaces the default result fields. Meta documents `thumbnail_url`, `children`, `alt_text`,
   * `link_attachment_url`, `has_replies`, `is_reply`, `root_post`, `replied_to`,
   * `reply_audience`, `quoted_post`, `reposted_post`, `gif_url`, `poll_attachment`, and
   * `topic_tag` alongside the defaults.
   */
  readonly fields?: readonly string[];
  readonly context: AdapterOperationContext;
}

export class MemoryThreadsWorkflowStore implements ThreadsWorkflowStore {
  private readonly rows = new Map<string, ThreadsWorkflow>();
  private readonly claims = new Set<string>();
  async create(input: Omit<ThreadsWorkflow, "id">) {
    const row = { ...input, id: `thwf_${globalThis.crypto.randomUUID()}` };
    this.rows.set(row.id, structuredClone(row));

    return structuredClone(row);
  }
  async get(id: string) {
    const row = this.rows.get(id);

    return row ? structuredClone(row) : undefined;
  }
  async update(id: string, update: Partial<ThreadsWorkflow>) {
    const row = this.rows.get(id);

    if (!row) throw new Error("Threads workflow not found");

    const next = { ...row, ...update, id };
    this.rows.set(id, structuredClone(next));

    return structuredClone(next);
  }
  async claim(id: string) {
    if (!this.rows.has(id) || this.claims.has(id)) return false;
    this.claims.add(id);

    return true;
  }
  async release(id: string) {
    this.claims.delete(id);
  }
}

export interface ThreadsOptions {
  readonly auth: ThreadsAuthorization;
  readonly backend?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly graphVersion?: string;
  readonly workflowStore?: ThreadsWorkflowStore;
  readonly clock?: () => Date;
  /** App secret that Meta uses to sign Threads webhook deliveries (`X-Hub-Signature-256`). */
  readonly webhookSecret?: string;
}

/**
 * A Threads media list edge read. `since` and `until` take a Unix timestamp or a date Meta can
 * parse, no earlier than `1688540400`. `cursor` is the `after` cursor; send it or `before`.
 */
export interface ThreadsMediaListInput {
  readonly account: ConnectedAccountRef;
  /** Replaces the default `fields` list. */
  readonly fields?: readonly string[];
  readonly since?: string;
  readonly until?: string;
  /** 1 through 100; Meta defaults to 25. */
  readonly limit?: number;
  readonly cursor?: string;
  readonly before?: string;
  readonly context: AdapterOperationContext;
}

/** Poll results decoded from `poll_attachment`. */
export interface ThreadsPollResults {
  readonly options: readonly {
    readonly text: string;
    /** Share of votes from 0 to 1, as Meta returns it. */
    readonly votesPercentage?: number;
  }[];
  readonly totalVotes?: number;
  readonly expiresAt?: string;
}

export interface ThreadsRecentSearch {
  readonly query: string;
  /** Milliseconds since the Unix epoch, as Meta returns it. */
  readonly timestamp?: number;
}

export interface ThreadsLocation {
  readonly id: string;
  readonly name?: string;
  readonly address?: string;
  readonly city?: string;
  readonly country?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly postalCode?: string;
}

interface ThreadsCoordinates {
  readonly latitude: number;
  readonly longitude: number;
}

/** Location search needs a query, coordinates, or both. */
export type ThreadsLocationQuery =
  | { readonly query: string; readonly coordinates?: ThreadsCoordinates }
  | { readonly query?: string; readonly coordinates: ThreadsCoordinates };

export type ThreadsUserMetric =
  | "views"
  | "likes"
  | "replies"
  | "reposts"
  | "quotes"
  | "clicks"
  | "followers_count";

/** One `threads_insights` row with every value Meta returned. */
export interface ThreadsInsightRow {
  readonly name: string;
  readonly period?: string;
  /** Daily points for time-series metrics such as `views`. */
  readonly series: readonly { readonly value: number; readonly endTime?: string }[];
  /** `total_value.value` for total-value metrics. */
  readonly total?: number;
  /** Per-URL `clicks` from `link_total_values`. */
  readonly links: readonly { readonly url: string; readonly value: number }[];
}

/** A public profile from `GET /profile_lookup`. Counts are omitted when Meta omits them. */
export interface ThreadsPublicProfile {
  readonly username: string;
  readonly name?: string;
  readonly profilePictureUrl?: string;
  readonly biography?: string;
  readonly isVerified?: boolean;
  /** `follower_count`: total followers. */
  readonly followerCount?: number;
  /** `likes_count`: likes on the profile's posts in the past 7 days. */
  readonly likesCount?: number;
  /** `quotes_count`: quotes of the profile's posts in the past 7 days. */
  readonly quotesCount?: number;
  /** `reposts_count`: reposts of the profile's posts in the past 7 days. */
  readonly repostsCount?: number;
  /** `views_count`: views of the profile's posts in the past 7 days. */
  readonly viewsCount?: number;
}

export type ThreadsIntentReplyControl =
  | "everyone"
  | "accounts_you_follow"
  | "mentioned_only"
  | "followers_only";

/** Query parameters for the `https://www.threads.com/intent/post` web intent. */
export interface ThreadsPostIntent {
  readonly text?: string;
  /** Link attachment; must be an `http` or `https` URL. */
  readonly url?: string;
  /** Topic tag, up to 50 characters, without newlines, tabs, periods, or ampersands. */
  readonly tag?: string;
  readonly replyControl?: ThreadsIntentReplyControl;
  /** Shortcode of the post to reply to (`reply_post_shortcode`). */
  readonly replyPostShortcode?: string;
  /** Shortcode of the post to quote (`quote_post_shortcode`). */
  readonly quotePostShortcode?: string;
}

const intentReplyControls: ReadonlySet<string> = new Set([
  "everyone",
  "accounts_you_follow",
  "mentioned_only",
  "followers_only",
]);

const intentShortcode = /^[\w-]{1,64}$/u;

function intentError(message: string): never {
  throw new SocialError({ code: "invalid_input", operation: "threads.intent", message });
}

/**
 * Builds a Threads post intent URL. Opening it shows the Threads composer prefilled with these
 * values; the person still confirms the post. It needs no token and makes no request.
 */
export function threadsPostIntentUrl(input: ThreadsPostIntent): string {
  const intent = new URL("https://www.threads.com/intent/post");

  const { text, url, tag, replyControl, replyPostShortcode, quotePostShortcode } = input;

  if (text !== undefined) intent.searchParams.set("text", text);

  if (url !== undefined) {
    let link: URL;

    try {
      link = new URL(url);
    } catch {
      intentError("url must be an absolute http or https URL.");
    }

    if (link.protocol !== "https:" && link.protocol !== "http:")
      intentError("url must be an absolute http or https URL.");
    intent.searchParams.set("url", url);
  }

  if (tag !== undefined) {
    if (!tag || [...tag].length > 50 || /[\n\r\t.&]/u.test(tag))
      intentError("tag must be 1 to 50 characters without newlines, tabs, periods, or ampersands.");
    intent.searchParams.set("tag", tag);
  }

  if (replyControl !== undefined) {
    if (!intentReplyControls.has(replyControl))
      intentError(
        "replyControl must be everyone, accounts_you_follow, mentioned_only, or followers_only.",
      );
    intent.searchParams.set("reply_control", replyControl);
  }

  if (replyPostShortcode !== undefined) {
    if (!intentShortcode.test(replyPostShortcode))
      intentError("replyPostShortcode must be a Threads post shortcode.");
    intent.searchParams.set("reply_post_shortcode", replyPostShortcode);
  }

  if (quotePostShortcode !== undefined) {
    if (!intentShortcode.test(quotePostShortcode))
      intentError("quotePostShortcode must be a Threads post shortcode.");
    intent.searchParams.set("quote_post_shortcode", quotePostShortcode);
  }

  return intent.href;
}

/** Builds a Threads follow intent URL (`https://www.threads.com/intent/follow?username=`). */
export function threadsFollowIntentUrl(username: string): string {
  const handle = username.trim().replace(/^@/u, "");

  if (!/^[\w.]+$/u.test(handle)) intentError("Provide a Threads username.");

  const intent = new URL("https://www.threads.com/intent/follow");
  intent.searchParams.set("username", handle);

  return intent.href;
}

export interface ThreadsTokenDebug {
  readonly type?: string;
  readonly application?: string;
  readonly isValid: boolean;
  readonly expiresAt?: number;
  readonly dataAccessExpiresAt?: number;
  readonly issuedAt?: number;
  readonly scopes: readonly string[];
  readonly userId?: string;
}

export interface ThreadsOEmbed {
  readonly html: string;
  readonly providerName?: string;
  readonly providerUrl?: string;
  readonly type?: string;
  readonly version?: string;
  readonly width?: number;
}

export interface ThreadsNative {
  /**
   * Reads the authenticated profile's rolling quotas from `threads_publishing_limit`: posts
   * (`quota_usage`, 250), replies (`reply_quota_usage`, 1,000), and deletions
   * (`delete_quota_usage`, 100). Pass `fields` to add `location_search_quota_usage` and
   * `location_search_config`.
   */
  readonly publishingLimit: (input: {
    readonly account: ConnectedAccountRef;
    readonly fields?: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** Reads one media object. `fields` replaces the default field list. */
  readonly getPost: (
    id: string,
    context: AdapterOperationContext,
    fields?: readonly string[],
  ) => Promise<JsonObject>;
  /** Reads a post's poll from `poll_attachment`, including `total_votes`. */
  readonly getPollResults: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<ThreadsPollResults | undefined>;
  /** `GET /{threads-user-id}/threads`: the authorized user's posts. */
  readonly listThreads: (input: ThreadsMediaListInput) => Promise<JsonObject>;
  /** `GET /{threads-user-id}/replies`: replies the authorized user published. */
  readonly listOwnReplies: (input: ThreadsMediaListInput) => Promise<JsonObject>;
  /** `GET /{threads-user-id}/ghost_posts`: the authorized user's ghost posts. */
  readonly listGhostPosts: (input: ThreadsMediaListInput) => Promise<JsonObject>;
  /** `GET /profile_posts`: a public profile's posts. Needs `threads_profile_discovery`. */
  readonly profilePosts: (
    input: ThreadsMediaListInput & { readonly username: string },
  ) => Promise<JsonObject>;
  /**
   * `GET /profile_lookup`: an exact-username public profile with `follower_count` and the
   * 7-day `likes_count`, `quotes_count`, `reposts_count`, and `views_count`. Needs
   * `threads_profile_discovery`.
   */
  readonly lookupProfile: (input: {
    readonly account: ConnectedAccountRef;
    readonly username: string;
    readonly context: AdapterOperationContext;
  }) => Promise<ThreadsPublicProfile>;
  /** `recently_searched_keywords` on the authorized user. */
  readonly recentlySearchedKeywords: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<readonly ThreadsRecentSearch[]>;
  /** `is_eligible_for_geo_gating` on the authorized user. */
  readonly geoGatingEligibility: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<boolean>;
  /** `GET /location_search`. Needs `threads_location_tagging`. */
  readonly locationSearch: (
    input: ThreadsLocationQuery & {
      readonly account: ConnectedAccountRef;
      readonly context: AdapterOperationContext;
    },
  ) => Promise<readonly ThreadsLocation[]>;
  /** `GET /{location-id}`. Needs `threads_location_tagging`. */
  readonly getLocation: (input: {
    readonly account: ConnectedAccountRef;
    readonly locationId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<ThreadsLocation>;
  /**
   * `GET /{threads-user-id}/threads_insights` with every returned value. `range` takes Unix
   * seconds no earlier than `1712991600`; `followers_count` does not accept a range.
   */
  readonly userInsights: (input: {
    readonly account: ConnectedAccountRef;
    readonly metrics: readonly [ThreadsUserMetric, ...ThreadsUserMetric[]];
    readonly range?: { readonly since: number; readonly until: number };
    readonly context: AdapterOperationContext;
  }) => Promise<readonly ThreadsInsightRow[]>;
  /** `follower_demographics` with one breakdown. Needs at least 100 followers. */
  readonly followerDemographics: (input: {
    readonly account: ConnectedAccountRef;
    readonly breakdown: "country" | "city" | "age" | "gender";
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /**
   * `GET /debug_token` for `inputToken` (default: this adapter's token). The caller is this
   * adapter's token unless `appAccessToken` (`TH|<APP_ID>|<APP_SECRET>`) is given.
   */
  readonly debugToken: (input: {
    readonly inputToken?: string;
    readonly appAccessToken?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<ThreadsTokenDebug>;
  /** `GET /oembed` for a public post or profile URL. */
  readonly oembed: (input: {
    readonly url: string;
    /** 320 through 658 pixels. */
    readonly maxWidth?: number;
    readonly context: AdapterOperationContext;
  }) => Promise<ThreadsOEmbed>;
  readonly getContainer: (id: string, context: AdapterOperationContext) => Promise<JsonObject>;
  readonly resumePublication: (
    account: ConnectedAccountRef,
    workflowId: string,
    context: AdapterOperationContext,
  ) => Promise<DeliveryOutcome>;
  readonly quotePost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly text: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly repost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly deletePost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly search: (input: ThreadsSearchInput) => Promise<JsonObject>;
  /** `GET /{threads-user-id}/mentions`. Needs `threads_manage_mentions`. */
  readonly mentions: (input: ThreadsMediaListInput) => Promise<JsonObject>;
  readonly getProfile: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly hideReply: (input: {
    readonly account: ConnectedAccountRef;
    readonly replyId: string;
    readonly hide: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /**
   * Deletes a reply the authenticated user published, using `DELETE /{threads-media-id}`.
   * Threads deletes only media created by the authenticated user, allows 100 deletions per
   * account per day, and needs `threads_delete`. Use `hideReply` for other users' replies.
   */
  readonly deleteComment: (input: {
    readonly account: ConnectedAccountRef;
    readonly commentId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  /** `GET /{threads-media-id}/replies`: top-level replies with every documented field. */
  readonly listReplies: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly cursor?: string;
    readonly before?: string;
    /** `reverse`: `true` (Meta's default) lists newest first; `false` lists oldest first. */
    readonly reverse?: boolean;
    readonly fields?: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** `GET /{threads-media-id}/conversation`. `fields` replaces the default field list. */
  readonly listConversation: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly cursor?: string;
    readonly before?: string;
    /** `reverse`: `true` (Meta's default) lists newest first; `false` lists oldest first. */
    readonly reverse?: boolean;
    readonly fields?: readonly string[];
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  /** `GET /{threads-media-id}/pending_replies`. `fields` replaces the default field list. */
  readonly listPendingReplies: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly cursor?: string;
    readonly before?: string;
    readonly reverse?: boolean;
    readonly fields?: readonly string[];
    readonly approvalStatus?: "pending" | "ignored";
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly managePendingReply: (input: {
    readonly account: ConnectedAccountRef;
    readonly replyId: string;
    readonly approve: boolean;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
}

function fail(
  operation: string,
  message: string,
  code: "upstream_failure" | "unauthorized" | "invalid_input" = "upstream_failure",
): never {
  throw new SocialError({
    code,
    operation,
    message,
    retryDisposition: { kind: code === "invalid_input" ? "never" : "reconcile-first" },
  });
}

// Meta counts emoji as UTF-8 bytes; ordinary Unicode remains character-counted.
// RGI_Emoji includes flags, keycaps, modifiers and joined emoji sequences.
function threadsTextLength(text: string): number {
  let emojiBytes = 0;

  const encoder = new TextEncoder();

  const ordinary = text.replace(new RegExp("\\p{RGI_Emoji}", "gv"), (emoji) => {
    emojiBytes += encoder.encode(emoji).length;

    return "";
  });

  return Array.from(ordinary).length + emojiBytes;
}

type ThreadsReplyControl = NonNullable<ThreadsPublishOptions["replyControl"]>;

const replyControlWire: Readonly<Record<ThreadsReplyControl, string>> = {
  everyone: "everyone",
  accountsYouFollow: "accounts_you_follow",
  mentionedOnly: "mentioned_only",
  parentPostAuthorOnly: "parent_post_author_only",
  followersOnly: "followers_only",
};

function isReplyControl(value: JsonField): value is ThreadsReplyControl {
  return isString(value) && Object.hasOwn(replyControlWire, value);
}

const textStyles: ReadonlySet<string> = new Set<ThreadsTextStyle>([
  "bold",
  "italic",
  "highlight",
  "underline",
  "strikethrough",
]);

/** Public `ThreadsPublishOptions` keys. Internal workflow keys start with `_`. */
const threadsOptionKeys: ReadonlySet<string> = new Set([
  "replyControl",
  "enableReplyApprovals",
  "topicTag",
  "quotePostId",
  "poll",
  "gif",
  "isMadeWithAi",
  "isSpoilerMedia",
  "spoilers",
  "textAttachment",
  "isGhostPost",
  "locationId",
  "allowlistedCountryCodes",
  "shareToInstagramStory",
  "autoPublishText",
]);

interface ThreadsDraftPost {
  readonly text: string;
  readonly mediaCount: number;
  readonly linkUrl: string | undefined;
  readonly isReply: boolean;
}

interface ThreadsOptionIssue {
  readonly code: string;
  readonly message: string;
}

/** `text_attachment` as Threads documents it. */
interface ThreadsTextAttachmentWire {
  readonly plaintext: string;
  readonly link_attachment_url?: string;
  readonly text_with_styling_info?: readonly {
    readonly offset: number;
    readonly length: number;
    readonly styling_info: readonly string[];
  }[];
}

interface ThreadsContainerFields {
  readonly fields: Readonly<Record<string, string>>;
  readonly issues: readonly ThreadsOptionIssue[];
}

const isCount = (value: JsonField, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;

interface DecodedRange {
  readonly offset: number;
  readonly length: number;
  readonly entry: JsonObject;
}

/** Reads a list of ranges, or undefined when any entry is not an integer range inside `limit`. */
function textRanges(value: JsonField, limit: number): readonly DecodedRange[] | undefined {
  if (!isJsonArray(value)) return undefined;

  const ranges: DecodedRange[] = [];

  for (const entry of value) {
    if (!isJsonObject(entry)) return undefined;

    const offset = entry["offset"],
      length = entry["length"];

    if (!isCount(offset, 0) || !isCount(length, 1) || offset + length > limit) return undefined;
    ranges.push({ offset, length, entry });
  }

  return ranges;
}

// Meta counts unique URLs across text, link_attachment, and text_attachment.link_attachment_url.
// Source, accessed 2026-11-04: https://developers.facebook.com/docs/threads/posts#links
function uniqueLinkCount(text: string, extra: readonly (string | undefined)[]): number {
  const found = text.match(/(?:https?:\/\/|www\.)[^\s<>"]+/giu) ?? [];

  const normalized = [...found, ...extra.filter((url) => url !== undefined)].map((url) =>
    url
      .replace(/[.,!?;:)\]}'"]+$/u, "")
      .replace(/^https?:\/\//iu, "")
      .replace(/\/$/u, "")
      .toLowerCase(),
  );

  return new Set(normalized).size;
}

/**
 * Maps `ThreadsPublishOptions` to `POST /{threads-user-id}/threads` fields for the parent
 * container, and reports every option that Threads would reject for this post shape.
 * Source, accessed 2026-11-04: https://developers.facebook.com/documentation/threads/reference/publishing
 */
function threadsContainerFields(o: JsonObject, post: ThreadsDraftPost): ThreadsContainerFields {
  const fields: Record<string, string> = {};

  const issues: ThreadsOptionIssue[] = [];

  const add = (code: string, message: string) => issues.push({ code, message });

  const textOnly = post.mediaCount === 0;

  const flag = (key: string, wire: string) => {
    const value = o[key];

    if (value === undefined) return false;

    if (!isBoolean(value)) {
      add(`options.${wire}`, `${key} must be a boolean.`);

      return false;
    }

    fields[wire] = String(value);

    return value;
  };

  const replyControl = o["replyControl"];

  if (replyControl !== undefined) {
    if (isReplyControl(replyControl)) fields["reply_control"] = replyControlWire[replyControl];
    else add("options.reply_control", "Unsupported Threads reply control.");
  }

  flag("enableReplyApprovals", "enable_reply_approvals");

  const topicTag = o["topicTag"];

  if (topicTag !== undefined) {
    const length = isString(topicTag) ? Array.from(topicTag).length : 0;

    if (!isString(topicTag) || length < 1 || length > 50 || /[.&]/u.test(topicTag))
      add(
        "options.topic_tag",
        "Threads topic tags are 1 to 50 characters and cannot contain periods or ampersands.",
      );
    else fields["topic_tag"] = topicTag;
  }

  const quotePostId = o["quotePostId"];

  if (quotePostId !== undefined) {
    if (!isString(quotePostId) || !/^\d+$/u.test(quotePostId))
      add("options.quote_post_id", "quotePostId must be a numeric Threads media ID.");
    else fields["quote_post_id"] = quotePostId;
  }

  const poll = o["poll"];

  if (poll !== undefined) {
    const options = isJsonObject(poll) ? poll["options"] : undefined;

    const choices = isJsonArray(options) ? options.filter(isString) : [];

    if (
      !isJsonArray(options) ||
      choices.length !== options.length ||
      choices.length < 2 ||
      choices.length > 4 ||
      choices.some((choice) => Array.from(choice).length < 1 || Array.from(choice).length > 25)
    )
      add(
        "options.poll_attachment",
        "Threads polls need two to four options of 1 to 25 characters each.",
      );
    else if (!textOnly)
      add("options.poll_attachment", "Threads polls can be attached to text-only posts only.");
    else {
      const keys = ["option_a", "option_b", "option_c", "option_d"] as const;

      fields["poll_attachment"] = JSON.stringify(
        Object.fromEntries(choices.map((choice, index) => [keys[index], choice])),
      );
    }
  }

  const gif = o["gif"];

  if (gif !== undefined) {
    const gifId = isJsonObject(gif) ? gif["gifId"] : undefined;

    if (!isJsonObject(gif) || !isString(gifId) || !gifId.trim() || gif["provider"] !== "GIPHY")
      add(
        "options.gif_attachment",
        "Threads GIFs need a GIPHY gifId; GIPHY is the only supported provider.",
      );
    else if (!textOnly)
      add("options.gif_attachment", "Threads GIFs can be attached to text-only posts only.");
    else fields["gif_attachment"] = JSON.stringify({ gif_id: gifId, provider: "GIPHY" });
  }

  flag("isMadeWithAi", "is_made_with_ai");

  if (flag("isSpoilerMedia", "is_spoiler_media") && textOnly)
    add("options.is_spoiler_media", "Media spoilers need an image, video, or carousel post.");

  const spoilers = o["spoilers"];

  if (spoilers !== undefined) {
    const ranges = textRanges(spoilers, post.text.length);

    if (ranges === undefined || ranges.length < 1 || ranges.length > 10)
      add(
        "options.text_entities",
        "Text spoilers need one to ten integer ranges that fall inside the post text.",
      );
    else
      fields["text_entities"] = JSON.stringify(
        ranges.map(({ offset, length }) => ({ entity_type: "SPOILER", offset, length })),
      );
  }

  const attachment = o["textAttachment"];

  let attachmentLink: string | undefined;

  if (attachment !== undefined) {
    const plaintext = isJsonObject(attachment) ? attachment["plaintext"] : undefined;

    const link = isJsonObject(attachment) ? attachment["linkAttachmentUrl"] : undefined;

    const styling = isJsonObject(attachment) ? attachment["styling"] : undefined;

    const plaintextLength = isString(plaintext) ? Array.from(plaintext).length : 0;

    const ranges =
      styling === undefined || !isString(plaintext)
        ? []
        : textRanges(styling, plaintext.length)?.flatMap((range) => {
            const styles = range.entry["styles"];

            const named = isJsonArray(styles) ? styles.filter(isString) : [];

            return isJsonArray(styles) &&
              named.length === styles.length &&
              named.length > 0 &&
              named.every((style) => textStyles.has(style))
              ? [{ offset: range.offset, length: range.length, styles: named }]
              : [];
          });

    const sorted = [...(ranges ?? [])].sort((a, b) => a.offset - b.offset);

    const overlaps = sorted.some((range, index) => {
      const previous = index > 0 ? sorted[index - 1] : undefined;

      return previous !== undefined && range.offset < previous.offset + previous.length;
    });

    let linkValid = link === undefined;

    if (isString(link))
      try {
        httpsUrl(link);
        linkValid = true;
      } catch {
        linkValid = false;
      }

    if (!isString(plaintext) || plaintextLength < 1 || plaintextLength > 10_000)
      add("options.text_attachment", "Text attachments need plaintext of 1 to 10,000 characters.");
    else if (!linkValid)
      add("options.text_attachment", "Text attachment links must be public HTTPS URLs.");
    else if (
      styling !== undefined &&
      (ranges === undefined || !isJsonArray(styling) || ranges.length !== styling.length)
    )
      add(
        "options.text_attachment",
        "Text attachment styling needs ranges inside the plaintext with bold, italic, highlight, underline, or strikethrough styles.",
      );
    else if (overlaps)
      add("options.text_attachment", "Text attachment styling ranges cannot overlap.");
    else if (!textOnly)
      add("options.text_attachment", "Text attachments can be added to text-only posts only.");
    else if (poll !== undefined)
      add("options.text_attachment", "Text attachments cannot be combined with a poll.");
    else if (isString(link) && post.linkUrl !== undefined)
      add(
        "options.text_attachment",
        "A post with a link attachment cannot also put a link in its text attachment.",
      );
    else {
      attachmentLink = isString(link) ? link : undefined;

      const wire: ThreadsTextAttachmentWire = {
        plaintext,
        ...definedFields({
          link_attachment_url: attachmentLink,
          text_with_styling_info: sorted.length
            ? sorted.map(({ offset, length, styles }) => ({ offset, length, styling_info: styles }))
            : undefined,
        }),
      };

      fields["text_attachment"] = JSON.stringify(wire);
    }
  }

  // Ghost posts are text-only, cannot reply, and support text spoilers as their only feature.
  // Source, accessed 2026-11-04: https://developers.facebook.com/documentation/threads/create-posts/ghost-posts
  if (flag("isGhostPost", "is_ghost_post")) {
    const others = Object.keys(o).filter(
      (key) => threadsOptionKeys.has(key) && key !== "isGhostPost" && key !== "spoilers",
    );

    if (!textOnly || post.isReply || post.linkUrl !== undefined || others.length > 0)
      add(
        "options.is_ghost_post",
        "Ghost posts are text-only, cannot be replies, and support only text spoilers.",
      );
  }

  // auto_publish_text publishes on container creation and works only for text posts.
  // Source, accessed 2026-11-04: https://developers.facebook.com/documentation/threads/reference/publishing
  if (flag("autoPublishText", "auto_publish_text") && !textOnly)
    add("options.auto_publish_text", "autoPublishText works only on text posts without media.");

  const locationId = o["locationId"];

  if (locationId !== undefined) {
    if (!isString(locationId) || !/^\d+$/u.test(locationId))
      add("options.location_id", "locationId must be a numeric Threads location ID.");
    else fields["location_id"] = locationId;
  }

  const countries = o["allowlistedCountryCodes"];

  if (countries !== undefined) {
    const codes = isJsonArray(countries) ? countries.filter(isString) : [];

    if (
      !isJsonArray(countries) ||
      codes.length !== countries.length ||
      codes.length === 0 ||
      codes.some((code) => !/^[A-Z]{2}$/u.test(code)) ||
      new Set(codes).size !== codes.length
    )
      add(
        "options.allowlisted_country_codes",
        "allowlistedCountryCodes must be unique uppercase ISO 3166-1 alpha-2 codes.",
      );
    else fields["allowlisted_country_codes"] = codes.join(",");
  }

  const story = o["shareToInstagramStory"];

  if (story !== undefined) {
    if (story === "light") fields["crossreshare_to_ig"] = "true";
    else if (story === "dark") fields["crossreshare_to_ig_dark_mode"] = "true";
    else add("options.crossreshare_to_ig", 'shareToInstagramStory must be "light" or "dark".');
  }

  if (uniqueLinkCount(post.text, [post.linkUrl, attachmentLink]) > 5)
    add(
      "link.limit_exceeded",
      "Threads rejects posts with more than five unique links across text, the link attachment, and the text attachment.",
    );

  return { fields, issues };
}

const pollAttachmentField =
  "poll_attachment{option_a,option_b,option_c,option_d,option_a_votes_percentage,option_b_votes_percentage,option_c_votes_percentage,option_d_votes_percentage,total_votes,expiration_timestamp}";

// Media fields Meta documents for posts, accessed 2026-11-04:
// https://developers.facebook.com/documentation/threads/retrieve-and-discover-posts/retrieve-posts
const mediaFields = [
  "id",
  "media_product_type",
  "media_type",
  "media_url",
  "permalink",
  "username",
  "text",
  "timestamp",
  "shortcode",
  "thumbnail_url",
  "children",
  "is_quote_post",
  "quoted_post",
  "reposted_post",
  "alt_text",
  "link_attachment_url",
  "gif_url",
  pollAttachmentField,
  "topic_tag",
  "is_spoiler_media",
  "text_entities",
  "text_attachment",
  "is_verified",
  "profile_picture_url",
] as const;

// Reply fields Meta documents for /{threads-user-id}/replies and /{threads-media-id}/replies:
// https://developers.facebook.com/documentation/threads/reference/user
const searchFields =
  "id,text,media_type,media_url,permalink,timestamp,username,shortcode,is_quote_post";

const replyFields = [
  "id",
  "media_product_type",
  "media_type",
  "media_url",
  "permalink",
  "username",
  "text",
  "timestamp",
  "shortcode",
  "thumbnail_url",
  "children",
  "is_quote_post",
  "has_replies",
  "root_post",
  "replied_to",
  "is_reply",
  "is_reply_owned_by_me",
  "reply_audience",
  "quoted_post",
  "reposted_post",
  "gif_url",
  "is_verified",
  "profile_picture_url",
] as const;

const ghostPostFields = [...mediaFields, "ghost_post_status", "ghost_post_expiration_timestamp"];

const conversationFields = [
  "id",
  "text",
  "username",
  "permalink",
  "timestamp",
  "is_reply",
  "hide_status",
] as const;

const pendingReplyFields = [
  "id",
  "text",
  "username",
  "timestamp",
  "is_reply",
  "hide_status",
  "reply_approval_status",
] as const;

const mentionFields = [
  "id",
  "text",
  "username",
  "media_type",
  "media_url",
  "permalink",
  "timestamp",
];

// Scalar fields that posts.list keeps; native.listThreads returns nested fields too.
const listedPostFields = [
  "id",
  "text",
  "username",
  "media_type",
  "media_product_type",
  "media_url",
  "thumbnail_url",
  "permalink",
  "shortcode",
  "timestamp",
  "is_quote_post",
  "alt_text",
  "link_attachment_url",
  "gif_url",
  "topic_tag",
  "is_spoiler_media",
];

const locationFields = "id,address,name,city,country,latitude,longitude,postal_code";

// Graph field names, with an optional `{subfield,...}` selection.
const fieldName = /^[a-z_]+(?:\{[a-z_,]+\})?$/u;

const insightsFloor = 1_712_991_600;

type MediaPageKey = "fields" | "since" | "until" | "limit" | "cursor" | "before";

/** The paging and filter part of `ThreadsMediaListInput`, accepting explicit `undefined`. */
type MediaPageInput = { readonly [K in MediaPageKey]?: ThreadsMediaListInput[K] | undefined };

function decodeLocation(value: JsonField, operation: string): ThreadsLocation {
  const row = object(value);

  const rawId = row["id"];

  const id = isString(rawId) ? rawId : isFiniteNumber(rawId) ? String(rawId) : undefined;

  if (id === undefined) fail(operation, "Threads returned a location without an ID.");

  return {
    id,
    ...definedFields({
      name: optionalString(row["name"]),
      address: optionalString(row["address"]),
      city: optionalString(row["city"]),
      country: optionalString(row["country"]),
      latitude: optionalNumber(row["latitude"]),
      longitude: optionalNumber(row["longitude"]),
      postalCode: optionalString(row["postal_code"]),
    }),
  };
}

function decodeInsightRow(value: JsonField): ThreadsInsightRow | undefined {
  const row = object(value);

  const name = optionalString(row["name"]);

  if (name === undefined) return undefined;

  const series = (optionalArray(row["values"]) ?? []).flatMap((entry) => {
    const point = isJsonObject(entry) ? entry : {};

    const pointValue = optionalNumber(point["value"]);

    return pointValue === undefined || !Number.isFinite(pointValue)
      ? []
      : [{ value: pointValue, ...definedFields({ endTime: optionalString(point["end_time"]) }) }];
  });

  const links = (optionalArray(row["link_total_values"]) ?? []).flatMap((entry) => {
    const link = isJsonObject(entry) ? entry : {};

    const url = optionalString(link["link_url"]),
      clicks = optionalNumber(link["value"]);

    return url === undefined || clicks === undefined || !Number.isFinite(clicks)
      ? []
      : [{ url, value: clicks }];
  });

  const total = optionalObject(row["total_value"]);

  return {
    name,
    series,
    links,
    ...definedFields({
      period: optionalString(row["period"]),
      total: optionalNumber(total?.["value"]),
    }),
  };
}

// Accepted oEmbed URL forms, accessed 2026-11-04:
// https://developers.facebook.com/documentation/threads/reference/oembed
function isThreadsPermalink(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.hostname === "www.threads.com" &&
      url.username === "" &&
      url.password === "" &&
      /^\/(?:@[\w.]+(?:\/post\/[\w-]+)?|t\/[\w-]+)\/?$/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

const accountRef = (backend: string, accountId: string) =>
  connectedAccountRef({ backend, platform: "threads", accountId });

export function threads(options: ThreadsOptions): SocialAdapter<ThreadsNative> {
  const backend = options.backend ?? "default",
    version = options.graphVersion ?? "v1.0",
    auth = options.auth,
    store = options.workflowStore ?? new MemoryThreadsWorkflowStore(),
    now = () => (options.clock?.() ?? new Date()).toISOString();

  const http = managedHttp(`https://graph.threads.net/${version}`, {
    apiKey: auth.accessToken,
    ...definedFields({ fetch: options.fetch }),
  });

  async function request(
    path: string,
    init: RequestInit,
    operation: string,
    context: AdapterOperationContext,
    client: typeof http = http,
  ): Promise<JsonObject> {
    const [raw = "", qs] = path.split("?", 2);

    const query = Object.fromEntries(new URLSearchParams(qs ?? ""));

    try {
      return object(
        await client(
          `/${raw.replace(/^\//, "")}`,
          context,
          init.method === "POST" ? {} : undefined,
          query,
          init.method === "POST" || init.method === "DELETE" || init.method === "PUT"
            ? init.method
            : "GET",
        ),
      );
    } catch (e) {
      if (e instanceof SocialError) throw metaOAuthReconnect(e);
      fail(operation, "Threads API request failed.");
    }
  }

  // https://developers.facebook.com/documentation/threads/threads-profiles (accessed 2026-11-04):
  // the five counts are documented profile_lookup fields; likes, quotes, reposts, and views
  // cover the past 7 days.
  function profileLookup(
    username: string,
    operation: string,
    context: AdapterOperationContext,
  ): Promise<JsonObject> {
    return request(
      `profile_lookup?username=${encodeURIComponent(username)}&fields=username,name,profile_picture_url,biography,is_verified,follower_count,likes_count,quotes_count,reposts_count,views_count`,
      { method: "GET" },
      operation,
      context,
    );
  }

  function authorize(ref: { backend: string; platform: string; accountId: string }, op: string) {
    if (ref.backend !== backend || ref.platform !== "threads" || ref.accountId !== auth.userId)
      fail(op, "Account reference does not match this Threads authorization.", "unauthorized");
  }

  const account = accountRef(backend, auth.userId);

  function fieldList(operation: string, fields: readonly string[] | undefined): string | undefined {
    if (fields === undefined) return undefined;

    if (fields.length === 0 || fields.some((field) => !fieldName.test(field)))
      fail(operation, "fields must be Threads field names.", "invalid_input");

    return fields.join(",");
  }

  function mediaListQuery(
    operation: string,
    defaults: readonly string[],
    input: MediaPageInput,
  ): string {
    const { since, until, limit, cursor, before } = input;

    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100))
      fail(operation, "Threads list limit must be an integer from 1 through 100.", "invalid_input");

    if (cursor !== undefined && before !== undefined)
      fail(operation, "Send cursor (after) or before, not both.", "invalid_input");

    if ([since, until].some((value) => value !== undefined && !value.trim()))
      fail(operation, "since and until must be non-empty.", "invalid_input");

    const query = new URLSearchParams({
      fields: fieldList(operation, input.fields) ?? defaults.join(","),
    });

    if (since !== undefined) query.set("since", since);

    if (until !== undefined) query.set("until", until);

    if (limit !== undefined) query.set("limit", String(limit));

    if (before !== undefined) query.set("before", before);

    if (cursor !== undefined) query.set("after", cursor);

    return query.toString();
  }

  function pageFrom(result: JsonObject): Page<JsonObject> {
    const items = array(result["data"]).map((entry) => object(entry));

    const paging = result["paging"] === undefined ? {} : object(result["paging"]);

    const cursors = paging["cursors"] === undefined ? {} : object(paging["cursors"]);

    // Graph omits paging.next on the last page even when cursors.after is present.
    const nextCursor =
      isString(paging["next"]) && paging["next"].length > 0
        ? optionalString(cursors["after"])
        : undefined;

    return { items, ...definedFields({ nextCursor }) };
  }

  async function readAccount(context: AdapterOperationContext) {
    const v = await request(
      "/me?fields=id,username,threads_profile_picture_url,threads_biography",
      { method: "GET" },
      "threads.accounts.read",
      context,
    );

    const id = v["id"],
      username = v["username"];

    if (!isString(id) || id !== auth.userId)
      fail("threads.accounts.read", "Threads returned an unauthorized account.", "unauthorized");

    return {
      ref: account,
      displayName: optionalString(username) ?? auth.handle ?? auth.userId,
      ...definedFields({ handle: optionalString(username) }),
      status: "connected" as const,
    };
  }

  async function listPosts(
    selected: ConnectedAccountRef,
    input: { readonly cursor?: string; readonly limit?: number },
    context: AdapterOperationContext,
  ) {
    authorize(selected, "threads.posts.list");

    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    )
      fail(
        "threads.posts.list",
        "Threads feed limit must be an integer from 1 through 100.",
        "invalid_input",
      );

    const query = new URLSearchParams({ fields: listedPostFields.join(",") });

    if (input.cursor !== undefined) query.set("after", input.cursor);

    if (input.limit !== undefined) query.set("limit", String(input.limit));

    const result = await request(
      `${encodeURIComponent(selected.accountId)}/threads?${query.toString()}`,
      { method: "GET" },
      "threads.posts.list",
      context,
    );

    const items = array(result["data"]).map((entry) => publicFields(entry, listedPostFields));

    const paging = result["paging"] === undefined ? {} : object(result["paging"]);

    const cursors = paging["cursors"] === undefined ? {} : object(paging["cursors"]);

    const hasNext = isString(paging["next"]) && paging["next"].length > 0;

    const nextCursor = hasNext ? optionalString(cursors["after"]) : undefined;

    return {
      items,
      ...definedFields({ nextCursor }),
    };
  }

  async function getAccountMetrics(
    selected: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<readonly MetricValue[]> {
    authorize(selected, "threads.analytics");

    const metricNames = [
      "views",
      "likes",
      "replies",
      "reposts",
      "quotes",
      "clicks",
      "followers_count",
    ] as const;

    const result = await request(
      `${encodeURIComponent(selected.accountId)}/threads_insights?metric=${metricNames.join(",")}`,
      { method: "GET" },
      "threads.analytics",
      context,
    );

    const allowed = new Set<string>(metricNames);

    const metrics: readonly MetricValue[] = array(result["data"]).flatMap((entry) => {
      const row = object(entry);

      const name = optionalString(row["name"]);

      if (name === undefined || !allowed.has(name)) return [];

      const total = row["total_value"] === undefined ? undefined : object(row["total_value"]);

      const values = row["values"] === undefined ? [] : array(row["values"]);

      const latest = values.at(-1);

      const totalValue = optionalNumber(total?.["value"]);

      const linkValues =
        name === "clicks"
          ? (optionalArray(row["link_total_values"]) ?? []).flatMap((entry) => {
              const value = isJsonObject(entry) ? optionalNumber(entry["value"]) : undefined;

              return value === undefined ? [] : [value];
            })
          : [];

      const linkTotal =
        linkValues.length > 0 ? linkValues.reduce((sum, value) => sum + value, 0) : undefined;

      const value =
        linkTotal ??
        totalValue ??
        (latest === undefined ? undefined : optionalNumber(object(latest)["value"]));

      if (value === undefined || !Number.isFinite(value)) return [];

      const latestEnd =
        latest === undefined ? undefined : optionalString(object(latest)["end_time"]);

      const totalIsLifetime =
        totalValue !== undefined && (row["period"] === "lifetime" || name === "followers_count");

      const period =
        totalValue !== undefined
          ? totalIsLifetime
            ? ("lifetime" as const)
            : ("unknown" as const)
          : totalValue === undefined &&
              row["period"] === "day" &&
              latestEnd !== undefined &&
              Number.isFinite(Date.parse(latestEnd))
            ? {
                from: new Date(Date.parse(latestEnd) - 86_400_000).toISOString(),
                to: latestEnd,
              }
            : ("unknown" as const);

      return [
        {
          name,
          value,
          unit: "count" as const,
          period,
          ...definedFields({ measuredAt: totalValue === undefined ? latestEnd : undefined }),
          fetchedAt: now(),
          freshness: "unknown" as const,
          source: `threads:${version}`,
        },
      ];
    });

    return normalizeMetrics(metrics);
  }

  async function status(id: string, c: AdapterOperationContext) {
    return request(
      `${encodeURIComponent(id)}?fields=id,status,error_message`,
      { method: "GET", ...definedFields({ signal: c.signal }) },
      "threads.container.status",
      c,
    );
  }

  function outcomeFields(a: ConnectedAccountRef, id: string, backendState?: string) {
    const delivery: DeliveryRef = {
      kind: "delivery",
      version: 1,
      backend: a.backend,
      platform: "threads",
      accountId: a.accountId,
      deliveryId: id,
    };

    return {
      targetIndex: 0,
      account: a,
      observedAt: now(),
      ...definedFields({ backendState: backendState === "" ? undefined : backendState }),
      delivery,
    };
  }

  const processing = (
    a: ConnectedAccountRef,
    id: string,
    backendState: string,
  ): DeliveryOutcome => ({
    state: "processing",
    ...outcomeFields(a, id, backendState),
  });

  const published = (a: ConnectedAccountRef, id: string, postId: string): DeliveryOutcome => ({
    state: "published",
    ...outcomeFields(a, id, "PUBLISHED"),
    post: platformPostRef({ backend, platform: "threads", accountId: a.accountId, postId }),
  });

  const ambiguous = (
    a: ConnectedAccountRef,
    id: string,
    backendState: string | undefined,
    diagnostic?: string,
  ): DeliveryOutcome => ({
    state: "unknown",
    ...outcomeFields(a, id, backendState),
    reason: "ambiguous-submission",
    ...definedFields({ diagnostic }),
  });

  const terminalFailure = (a: ConnectedAccountRef, id: string, state: string): DeliveryOutcome => ({
    state: "failed",
    ...outcomeFields(a, id, state),
    code: "media_error",
    message: "Threads container failed or expired before publication.",
    retryDisposition: { kind: "never" },
  });

  function parentMediaType(childCount: number, singleKind: JsonField): string {
    if (childCount) return "CAROUSEL";

    if (singleKind === "video") return "VIDEO";

    if (singleKind === "image") return "IMAGE";

    return "TEXT";
  }

  async function resume(
    w: ThreadsWorkflow,
    a: ConnectedAccountRef,
    c: AdapterOperationContext,
  ): Promise<DeliveryOutcome> {
    if (w.nativeId) return published(a, w.id, w.nativeId);

    if (w.stage === "unknown")
      return ambiguous(
        a,
        w.id,
        w.backendState,
        "Threads publish acceptance is unknown; no replay was attempted.",
      );

    let cur = w;

    const items = optionalArray(cur.options["_mediaItems"]) ?? [];

    while (cur.childIds.length < items.length) {
      const item = object(items[cur.childIds.length]);

      const url = String(item["url"]);

      const isVideo = item["kind"] === "video";

      const p = new URLSearchParams({
        media_type: isVideo ? "VIDEO" : "IMAGE",
        is_carousel_item: "true",
        ...definedFields({
          video_url: isVideo ? url : undefined,
          image_url: isVideo ? undefined : url,
          alt_text: optionalString(item["altText"]),
        }),
      });

      await store.update(cur.id, { stage: "unknown", backendState: "CREATING_CHILD" });

      const child = await request(
        `${a.accountId}/threads?${p}`,
        { method: "POST", ...definedFields({ signal: c.signal }) },
        "threads.container.child",
        c,
      );

      const childId = optionalString(child["id"]);

      if (childId === undefined)
        fail("threads.container.child", "Threads did not return a child container ID.");
      cur = await store.update(cur.id, {
        childIds: [...cur.childIds, childId],
        stage: "children",
      });
    }

    for (const id of cur.childIds) {
      const s = await status(id, c);

      const st = optionalString(s["status"]) ?? "";

      if (st === "ERROR" || st === "EXPIRED") return terminalFailure(a, w.id, st);

      if (st !== "FINISHED" && st !== "PUBLISHED") return processing(a, w.id, st || "PROCESSING");
    }

    if (!cur.parentId) {
      const singleKind = cur.options["_mediaKind"];

      const singleUrl = optionalString(cur.options["_mediaUrl"]);

      const replyToId = optionalString(cur.options["_replyToId"]);

      const linkAttachment = optionalString(cur.options["_linkAttachment"]);

      const native = threadsContainerFields(cur.options, {
        text: cur.caption,
        mediaCount: cur.childIds.length || (singleUrl === undefined ? 0 : 1),
        linkUrl: linkAttachment,
        isReply: replyToId !== undefined,
      });

      if (native.issues.length)
        fail(
          "threads.container.create",
          "Stored Threads publish options are invalid; no container was created.",
          "invalid_input",
        );

      const p = new URLSearchParams({
        media_type: parentMediaType(cur.childIds.length, singleKind),
        ...definedFields({
          children: cur.childIds.length ? cur.childIds.join(",") : undefined,
          video_url: singleKind === "video" ? singleUrl : undefined,
          image_url: singleKind === "video" ? undefined : singleUrl,
          alt_text: optionalString(cur.options["_altText"]),
          text: cur.caption === "" ? undefined : cur.caption,
          reply_to_id: replyToId,
          link_attachment: linkAttachment,
        }),
        ...native.fields,
      });

      // Persist ambiguity before dispatch so a process crash cannot recreate a
      // possibly accepted container under the same continuation handle.
      await store.update(cur.id, { stage: "unknown", backendState: "CREATING_PARENT" });

      const parent = await request(
        `${a.accountId}/threads?${p}`,
        { method: "POST", ...definedFields({ signal: c.signal }) },
        "threads.container.create",
        c,
      );

      const parentId = optionalString(parent["id"]);

      if (parentId === undefined)
        fail("threads.container.create", "Threads did not return a container ID.");

      // With auto_publish_text, Threads publishes during container creation. Its reference does
      // not say whether the returned ID is the container or the post, so the SDK neither calls
      // threads_publish nor claims a published post; the ID stays a container reference.
      if (cur.options["autoPublishText"] === true) {
        await store.update(cur.id, { parentId, stage: "unknown", backendState: "AUTO_PUBLISHED" });

        return ambiguous(
          a,
          cur.id,
          "AUTO_PUBLISHED",
          "Threads publishes auto_publish_text posts when the container is created and does not document which ID it returns; find the post with native.listThreads.",
        );
      }

      cur = await store.update(cur.id, { parentId, stage: "parent" });
    }

    const parentId = cur.parentId;

    if (!parentId) fail("threads.container.create", "Missing parent container ID.");

    const ps = await status(parentId, c);

    const pst = optionalString(ps["status"]) ?? "";

    if (pst === "ERROR" || pst === "EXPIRED") return terminalFailure(a, cur.id, pst);

    if (pst === "PUBLISHED") {
      await store.update(cur.id, { stage: "unknown", backendState: "PUBLISHED_WITHOUT_NATIVE_ID" });

      return ambiguous(a, cur.id, pst);
    }

    if (pst !== "FINISHED") return processing(a, cur.id, pst || "PROCESSING");

    await store.update(cur.id, { stage: "unknown", backendState: "PUBLISHING" });

    try {
      const pub = await request(
        `${a.accountId}/threads_publish?creation_id=${encodeURIComponent(parentId)}`,
        { method: "POST", ...definedFields({ signal: c.signal }) },
        "threads.publish",
        c,
      );

      const nativeId = optionalString(pub["id"]);

      if (nativeId === undefined) {
        await store.update(cur.id, { stage: "unknown", backendState: "MISSING_ID" });

        return ambiguous(
          a,
          cur.id,
          "MISSING_ID",
          "Threads accepted publish without a native post ID.",
        );
      }

      // Threads publishes the post even when the Story cross-share fails, so the status is kept
      // beside the published outcome. Source, accessed 2026-11-04:
      // https://developers.facebook.com/documentation/threads/create-posts/share-to-ig-stories
      const storyStatus = pub["crossreshare_to_ig_status"];

      await store.update(cur.id, {
        nativeId,
        stage: "published",
        backendState: "PUBLISHED",
        ...definedFields({
          instagramStoryStatus:
            storyStatus === "SUCCESS" || storyStatus === "FAILED" ? storyStatus : undefined,
        }),
      });

      return published(a, cur.id, nativeId);
    } catch (e) {
      // Code 190 rejects the token before publication, so the container stays publishable.
      if (e instanceof SocialError && e.code === "reconnect_required") {
        await store.update(cur.id, { stage: "parent", backendState: "RECONNECT_REQUIRED" });

        throw e;
      }

      await store.update(cur.id, { stage: "unknown", backendState: "AMBIGUOUS" });

      if (e instanceof SocialError) return ambiguous(a, cur.id, "AMBIGUOUS", e.message);

      throw e;
    }
  }

  const capabilities: CapabilityManifest = {
    schemaVersion: 1,
    backend,
    apiRevision: `Meta Threads Graph ${version}`,
    runtime: ["node>=22.12", "bun"],
    capabilities: [
      { operation: "accounts.read", platform: "threads", availability: "available" },
      webhookCapability(
        "threads",
        "Verifies Meta X-Hub-Signature-256 with the app secret and decodes replies (comment.received), mentions (mention.received), publish (post.published, with no owner ID), and delete (post.removed) deliveries. Answer the GET handshake with answerMetaWebhookChallenge.",
      ),
      {
        operation: "posts.publish",
        platform: "threads",
        availability: "available",
        formats: ["text", "image", "video", "carousel"],
        requiredScopes: ["threads_basic", "threads_content_publish"],
        // Mirrors prepareTarget: up to 20 public HTTPS items; JPEG/PNG images, MP4/MOV video.
        constraints: {
          mediaSources: ["https-url"],
          maxItems: 20,
          allowedMimeTypes: ["image/jpeg", "image/png", "video/mp4", "video/quicktime"],
        },
        notes:
          "content.link.url is sent as link_attachment on text posts; posts with media reject a link. ThreadsPublishOptions map reply controls, reply approvals, topic tags, quotes, polls, GIPHY GIFs, AI labels, spoilers, text attachments, ghost posts, location tags, geo-gating, and Instagram Story cross-sharing. locationId also needs threads_location_tagging; shareToInstagramStory also needs threads_share_to_instagram.",
      },
      {
        operation: "posts.schedule",
        platform: "threads",
        availability: "unsupported-by-platform",
        notes:
          "Threads publishing endpoints have no publish-time parameter; threads_publish publishes immediately.",
      },
      { operation: "posts.read", platform: "threads", availability: "available" },
      { operation: "posts.list", platform: "threads", availability: "available" },
      { operation: "posts.status", platform: "threads", availability: "available" },
      // Source, accessed 2026-10-11: https://developers.facebook.com/docs/threads/overview
      {
        operation: "publishing.limit.read",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_content_publish"],
        notes:
          "Reads the authenticated profile's rolling 24-hour publishing quota from threads_publishing_limit. The response includes quota_usage and config.",
      },
      {
        operation: "analytics.read",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_manage_insights"],
      },
      {
        operation: "analytics.account.read",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_manage_insights"],
      },
      {
        operation: "comments.read",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_read_replies"],
      },
      // Source, accessed 2026-11-04:
      // https://developers.facebook.com/documentation/threads/retrieve-and-manage-replies/create-replies
      {
        operation: "comments.write",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_content_publish", "threads_manage_replies"],
        notes:
          "Meta requires threads_manage_replies for reply_to_id. Replying to another user's post also needs that post to come from keyword search or mentions.",
      },
      {
        operation: "comments.moderate",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_manage_replies"],
        notes:
          "Hiding replies and pending-reply moderation require Threads reply-management permissions.",
      },
      {
        operation: "comments.delete",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_delete"],
        notes:
          "Deletes only replies published by the authenticated user. Threads allows 100 deletions per account per day. Use hideReply for other users' replies.",
      },
      {
        operation: "posts.quote",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_content_publish"],
      },
      {
        operation: "posts.repost",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_content_publish"],
      },
      {
        operation: "posts.delete",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_delete"],
      },
      {
        operation: "posts.removeFromPlatform",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_delete"],
      },
      // Source, accessed 2026-09-24: https://developers.facebook.com/docs/threads/posts
      {
        operation: "posts.update",
        platform: "threads",
        availability: "unsupported-by-platform",
        notes:
          "The Threads API has no endpoint to edit a published post; text and attachments are set when the container is created.",
      },
      { operation: "profile.read", platform: "threads", availability: "available" },
      {
        operation: "profile.update",
        platform: "threads",
        availability: "unsupported-by-platform",
        notes: "The Threads API exposes profile reads only. It has no profile write endpoint.",
      },
      {
        operation: "search.keyword",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_keyword_search"],
      },
      {
        operation: "profiles.read",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic"],
        notes:
          "The profile endpoint reads the authorized app-scoped user; profile lookup requires threads_profile_discovery.",
      },
      {
        // https://developers.facebook.com/docs/threads/threads-profiles and
        // https://developers.facebook.com/docs/threads/reference/user (accessed 2026-09-24):
        // profile_lookup requires an exact username match; there is no profile search endpoint.
        operation: "profiles.search",
        platform: "threads",
        availability: "unsupported-by-platform",
        notes:
          "Threads has no profile search endpoint. Profile discovery only looks up an exact username, which profiles.read covers.",
      },
      {
        // https://developers.facebook.com/docs/threads/reference/user and
        // https://developers.facebook.com/docs/threads/insights (accessed 2026-09-24): the user
        // node has no followers or following edge; follower data is aggregate counts only.
        operation: "graph.read",
        platform: "threads",
        availability: "unsupported-by-platform",
        notes:
          "Threads does not expose follower or following lists. The followers_count metric is available through analytics.account.read.",
      },
      {
        operation: "search.posts",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_keyword_search"],
        notes:
          "Without threads_keyword_search approval, results are limited to the authorized user's posts.",
      },
      {
        operation: "mentions.read",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_manage_mentions"],
      },
      // Sources, accessed 2026-11-04: https://developers.facebook.com/documentation/threads/reference/user,
      // .../create-posts/location-tagging, .../insights, .../troubleshooting/debug-access-token,
      // and .../reference/oembed.
      {
        operation: "replies.own.read",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_read_replies"],
      },
      {
        operation: "posts.ghost.read",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic"],
      },
      {
        operation: "profiles.posts.read",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_profile_discovery"],
        notes:
          "Standard access returns posts from @meta, @threads, @instagram, and @facebook only; profiles need at least 100 followers.",
      },
      {
        operation: "locations.search",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_location_tagging"],
        notes:
          'Before threads_location_tagging approval, location_search only matches the query "Menlo Park". Meta allows 500 searches per 24 hours.',
      },
      {
        operation: "analytics.demographics.read",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_manage_insights"],
        notes: "follower_demographics needs at least 100 followers and one breakdown.",
      },
      {
        operation: "tokens.debug",
        platform: "threads",
        availability: "available",
        notes:
          "debug_token accepts an app access token, or a Threads tester's user token, from the same app as the inspected token.",
      },
      {
        operation: "posts.embed",
        platform: "threads",
        availability: "available",
        notes: "oEmbed needs no access token since March 3, 2026; the adapter still sends its own.",
      },
      {
        operation: "messages.read",
        platform: "threads",
        availability: "unsupported-by-platform",
        notes: "Threads does not expose messaging APIs to standard apps.",
      },
      {
        operation: "notifications.read",
        platform: "threads",
        availability: "unsupported-by-platform",
        notes:
          "The Threads API has no notifications endpoint. Use mentions.read, reply reads, or webhooks instead.",
      },
    ],
  };

  const native: ThreadsNative = {
    publishingLimit: async ({ account: selected, fields, context }) => {
      authorize(selected, "threads.publishing.limit.read");

      // Quota fields, accessed 2026-11-04:
      // https://developers.facebook.com/documentation/threads/troubleshooting#retrieve-quota-limits
      const query = new URLSearchParams({
        fields:
          fieldList("threads.publishing.limit.read", fields) ??
          "quota_usage,config,reply_quota_usage,reply_config,delete_quota_usage,delete_config",
      });

      return request(
        `${encodeURIComponent(selected.accountId)}/threads_publishing_limit?${query.toString()}`,
        { method: "GET" },
        "threads.publishing.limit.read",
        context,
      );
    },
    getPost: (id, c, fields) =>
      request(
        `${encodeURIComponent(id)}?${new URLSearchParams({ fields: fieldList("threads.posts.get", fields) ?? mediaFields.join(",") }).toString()}`,
        { method: "GET", ...definedFields({ signal: c.signal }) },
        "threads.posts.get",
        c,
      ),
    async getPollResults({ account: selected, postId, context }) {
      authorize(selected, "threads.posts.poll");

      const result = await request(
        `${encodeURIComponent(postId)}?fields=id,${pollAttachmentField}`,
        { method: "GET" },
        "threads.posts.poll",
        context,
      );

      const poll = optionalObject(result["poll_attachment"]);

      if (poll === undefined) return undefined;

      // Meta returns option C and D only when the poll has them.
      const options = (["a", "b", "c", "d"] as const).flatMap((letter) => {
        const text = optionalString(poll[`option_${letter}`]);

        return text === undefined
          ? []
          : [
              {
                text,
                ...definedFields({
                  votesPercentage: optionalNumber(poll[`option_${letter}_votes_percentage`]),
                }),
              },
            ];
      });

      return {
        options,
        ...definedFields({
          totalVotes: optionalNumber(poll["total_votes"]),
          expiresAt: optionalString(poll["expiration_timestamp"]),
        }),
      };
    },
    async listThreads({ account: selected, context, ...page }) {
      authorize(selected, "threads.posts.list");

      return request(
        `${encodeURIComponent(selected.accountId)}/threads?${mediaListQuery("threads.posts.list", [...mediaFields, "owner"], page)}`,
        { method: "GET" },
        "threads.posts.list",
        context,
      );
    },
    async listOwnReplies({ account: selected, context, ...page }) {
      authorize(selected, "threads.replies.own");

      return request(
        `${encodeURIComponent(selected.accountId)}/replies?${mediaListQuery("threads.replies.own", replyFields, page)}`,
        { method: "GET" },
        "threads.replies.own",
        context,
      );
    },
    async listGhostPosts({ account: selected, context, ...page }) {
      authorize(selected, "threads.posts.ghost");

      return request(
        `${encodeURIComponent(selected.accountId)}/ghost_posts?${mediaListQuery("threads.posts.ghost", ghostPostFields, page)}`,
        { method: "GET" },
        "threads.posts.ghost",
        context,
      );
    },
    async lookupProfile({ account: selected, username, context }) {
      authorize(selected, "threads.profile.lookup");

      const handle = username.trim().replace(/^@/u, "");

      if (!/^[\w.]+$/u.test(handle))
        fail("threads.profile.lookup", "Provide an exact Threads username.", "invalid_input");

      const result = await profileLookup(handle, "threads.profile.lookup", context);

      const count = (key: string): number | undefined => {
        const value = result[key];

        if (value === undefined) return undefined;

        if (!isCount(value, 0))
          fail("threads.profile.lookup", `Threads returned a malformed ${key}.`);

        return value;
      };

      const isVerified = result["is_verified"];

      return {
        username: optionalString(result["username"]) ?? handle,
        ...definedFields({
          name: optionalString(result["name"]),
          profilePictureUrl: optionalString(result["profile_picture_url"]),
          biography: optionalString(result["biography"]),
          isVerified: isBoolean(isVerified) ? isVerified : undefined,
          followerCount: count("follower_count"),
          likesCount: count("likes_count"),
          quotesCount: count("quotes_count"),
          repostsCount: count("reposts_count"),
          viewsCount: count("views_count"),
        }),
      };
    },
    async profilePosts({ account: selected, username, context, ...page }) {
      authorize(selected, "threads.profile.posts");

      const handle = username.trim().replace(/^@/u, "");

      if (!/^[\w.]+$/u.test(handle))
        fail("threads.profile.posts", "Provide an exact Threads username.", "invalid_input");

      return request(
        `profile_posts?username=${encodeURIComponent(handle)}&${mediaListQuery("threads.profile.posts", mediaFields, page)}`,
        { method: "GET" },
        "threads.profile.posts",
        context,
      );
    },
    async recentlySearchedKeywords({ account: selected, context }) {
      authorize(selected, "threads.search.recent");

      const result = await request(
        `${encodeURIComponent(selected.accountId)}?fields=id,recently_searched_keywords`,
        { method: "GET" },
        "threads.search.recent",
        context,
      );

      return (optionalArray(result["recently_searched_keywords"]) ?? []).flatMap((entry) => {
        const row = isJsonObject(entry) ? entry : {};

        const query = optionalString(row["query"]);

        return query === undefined
          ? []
          : [{ query, ...definedFields({ timestamp: optionalNumber(row["timestamp"]) }) }];
      });
    },
    async geoGatingEligibility({ account: selected, context }) {
      authorize(selected, "threads.geo_gating.read");

      const result = await request(
        `${encodeURIComponent(selected.accountId)}?fields=id,is_eligible_for_geo_gating`,
        { method: "GET" },
        "threads.geo_gating.read",
        context,
      );

      const eligible = result["is_eligible_for_geo_gating"];

      if (!isBoolean(eligible))
        fail("threads.geo_gating.read", "Threads did not return geo-gating eligibility.");

      return eligible;
    },
    async locationSearch({ account: selected, query, coordinates, context }) {
      authorize(selected, "threads.locations.search");

      const params = new URLSearchParams();

      if (query !== undefined) {
        if (!query.trim())
          fail("threads.locations.search", "A location query is required.", "invalid_input");
        params.set("q", query.trim());
      }

      if (coordinates !== undefined) {
        const { latitude, longitude } = coordinates;

        if (
          !Number.isFinite(latitude) ||
          !Number.isFinite(longitude) ||
          Math.abs(latitude) > 90 ||
          Math.abs(longitude) > 180
        )
          fail(
            "threads.locations.search",
            "Latitude must be within ±90 and longitude within ±180.",
            "invalid_input",
          );
        params.set("latitude", String(latitude));
        params.set("longitude", String(longitude));
      }

      if (!params.size)
        fail("threads.locations.search", "Provide a query or coordinates.", "invalid_input");

      // Not paginated. Source, accessed 2026-11-04:
      // https://developers.facebook.com/documentation/threads/create-posts/location-tagging
      const result = await request(
        `location_search?${params.toString()}`,
        { method: "GET" },
        "threads.locations.search",
        context,
      );

      return array(result["data"]).map((entry) =>
        decodeLocation(entry, "threads.locations.search"),
      );
    },
    async getLocation({ account: selected, locationId, context }) {
      authorize(selected, "threads.locations.read");

      if (!/^\d+$/u.test(locationId))
        fail("threads.locations.read", "Provide a numeric Threads location ID.", "invalid_input");

      return decodeLocation(
        await request(
          `${encodeURIComponent(locationId)}?fields=${locationFields}`,
          { method: "GET" },
          "threads.locations.read",
          context,
        ),
        "threads.locations.read",
      );
    },
    async userInsights({ account: selected, metrics, range, context }) {
      authorize(selected, "threads.insights.user");

      const metric = [...new Set(metrics)].join(",");

      if (range !== undefined) {
        const { since, until } = range;

        if (
          !Number.isSafeInteger(since) ||
          !Number.isSafeInteger(until) ||
          since < insightsFloor ||
          since >= until
        )
          fail(
            "threads.insights.user",
            "Insights ranges need Unix seconds with since at or after 1712991600 and before until.",
            "invalid_input",
          );

        if (metrics.includes("followers_count"))
          fail(
            "threads.insights.user",
            "followers_count does not accept a since/until range.",
            "invalid_input",
          );
      }

      // Source, accessed 2026-11-04: https://developers.facebook.com/documentation/threads/insights
      const result = await request(
        range === undefined
          ? `${encodeURIComponent(selected.accountId)}/threads_insights?metric=${metric}`
          : `${encodeURIComponent(selected.accountId)}/threads_insights?metric=${metric}&since=${range.since}&until=${range.until}`,
        { method: "GET" },
        "threads.insights.user",
        context,
      );

      return array(result["data"]).flatMap((entry) => decodeInsightRow(entry) ?? []);
    },
    async followerDemographics({ account: selected, breakdown, context }) {
      authorize(selected, "threads.insights.demographics");

      if (!["country", "city", "age", "gender"].includes(breakdown))
        fail(
          "threads.insights.demographics",
          "breakdown must be country, city, age, or gender.",
          "invalid_input",
        );

      return request(
        `${encodeURIComponent(selected.accountId)}/threads_insights?metric=follower_demographics&breakdown=${breakdown}`,
        { method: "GET" },
        "threads.insights.demographics",
        context,
      );
    },
    async debugToken({ inputToken, appAccessToken, context }) {
      if (appAccessToken !== undefined && !/^TH\|\d+\|\S+$/u.test(appAccessToken))
        fail(
          "threads.tokens.debug",
          "appAccessToken must use the TH|<APP_ID>|<APP_SECRET> format.",
          "invalid_input",
        );

      if (inputToken !== undefined && !inputToken.trim())
        fail("threads.tokens.debug", "inputToken must be non-empty.", "invalid_input");

      const client =
        appAccessToken === undefined
          ? http
          : managedHttp(`https://graph.threads.net/${version}`, {
              apiKey: appAccessToken,
              ...definedFields({ fetch: options.fetch }),
            });

      // Source, accessed 2026-11-04:
      // https://developers.facebook.com/documentation/threads/troubleshooting/debug-access-token
      const result = await request(
        `/debug_token?${new URLSearchParams({ input_token: inputToken ?? auth.accessToken }).toString()}`,
        { method: "GET" },
        "threads.tokens.debug",
        context,
        client,
      );

      const data = object(result["data"]);

      const valid = data["is_valid"];

      if (!isBoolean(valid)) fail("threads.tokens.debug", "Threads did not return token validity.");

      return {
        isValid: valid,
        scopes: (optionalArray(data["scopes"]) ?? []).filter(isString),
        ...definedFields({
          type: optionalString(data["type"]),
          application: optionalString(data["application"]),
          expiresAt: optionalNumber(data["expires_at"]),
          dataAccessExpiresAt: optionalNumber(data["data_access_expires_at"]),
          issuedAt: optionalNumber(data["issued_at"]),
          userId: optionalString(data["user_id"]),
        }),
      };
    },
    async oembed({ url, maxWidth, context }) {
      if (!isThreadsPermalink(url))
        fail(
          "threads.oembed",
          "Provide a https://www.threads.com post, /t/ short link, or profile URL.",
          "invalid_input",
        );

      if (
        maxWidth !== undefined &&
        (!Number.isSafeInteger(maxWidth) || maxWidth < 320 || maxWidth > 658)
      )
        fail(
          "threads.oembed",
          "maxWidth must be an integer from 320 through 658.",
          "invalid_input",
        );

      const params = new URLSearchParams({ url });

      if (maxWidth !== undefined) params.set("maxwidth", String(maxWidth));

      const result = await request(
        `oembed?${params.toString()}`,
        { method: "GET" },
        "threads.oembed",
        context,
      );

      const html = optionalString(result["html"]);

      if (html === undefined) fail("threads.oembed", "Threads did not return embed HTML.");

      return {
        html,
        ...definedFields({
          providerName: optionalString(result["provider_name"]),
          providerUrl: optionalString(result["provider_url"]),
          type: optionalString(result["type"]),
          version: optionalString(result["version"]),
          width: optionalNumber(result["width"]),
        }),
      };
    },
    getContainer: (id, c) => status(id, c),
    resumePublication: async (a, id, c) => {
      authorize(a, "threads.posts.resume");

      const w = await store.get(id);

      if (!w || w.backend !== backend || w.accountId !== a.accountId)
        fail(
          "threads.posts.resume",
          "Workflow handle is not authorized for this account.",
          "unauthorized",
        );

      if (!(await store.claim(id))) return processing(a, id, "CLAIMED");

      try {
        return await resume((await store.get(id)) ?? w, a, c);
      } finally {
        await store.release?.(id);
      }
    },
    async quotePost({ account, postId, text, context }) {
      authorize(account, "threads.posts.quote");

      const params = new URLSearchParams({ media_type: "TEXT", text, quote_post_id: postId });

      const container = await request(
        `${encodeURIComponent(account.accountId)}/threads?${params.toString()}`,
        { method: "POST" },
        "threads.posts.quote",
        context,
      );

      const creationId = optionalString(container["id"]);

      if (creationId === undefined)
        fail("threads.posts.quote", "Threads did not return a quote container ID.");

      return request(
        `${encodeURIComponent(account.accountId)}/threads_publish?creation_id=${encodeURIComponent(creationId)}`,
        { method: "POST" },
        "threads.posts.quote",
        context,
      );
    },
    async repost({ account, postId, context }) {
      authorize(account, "threads.posts.repost");

      if (!/^\d+$/u.test(postId))
        fail("threads.posts.repost", "Provide a numeric Threads media ID.", "invalid_input");

      const result = await request(
        `${encodeURIComponent(postId)}/repost`,
        { method: "POST" },
        "threads.posts.repost",
        context,
      );

      // The response carries the new repost's ID. Source, accessed 2026-11-04:
      // https://developers.facebook.com/documentation/threads/posts/reposts
      if (optionalString(result["id"]) === undefined)
        throw new SocialError({
          code: "ambiguous_outcome",
          operation: "threads.posts.repost",
          message: "Threads did not return a repost ID; reconcile before retrying.",
          retryDisposition: { kind: "reconcile-first" },
        });

      return result;
    },
    async deletePost({ account, postId, context }) {
      authorize(account, "threads.posts.delete");

      await request(
        encodeURIComponent(postId),
        { method: "DELETE" },
        "threads.posts.delete",
        context,
      );
    },
    async search({
      account,
      query,
      cursor,
      searchType,
      searchMode,
      mediaType,
      since,
      until,
      limit,
      authorUsername,
      fields,
      context,
    }) {
      authorize(account, "threads.search");

      const q = query.trim();

      if (!q) fail("threads.search", "A search query is required.", "invalid_input");

      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100))
        fail(
          "threads.search",
          "Search limit must be an integer from 1 through 100.",
          "invalid_input",
        );

      const params = new URLSearchParams({
        q,
        fields: fieldList("threads.search", fields) ?? searchFields,
      });

      if (searchType !== undefined) params.set("search_type", searchType);

      if (searchMode !== undefined) params.set("search_mode", searchMode);

      if (mediaType !== undefined) params.set("media_type", mediaType);

      if (since !== undefined) params.set("since", since);

      if (until !== undefined) params.set("until", until);

      if (limit !== undefined) params.set("limit", String(limit));

      if (authorUsername !== undefined) params.set("author_username", authorUsername);

      if (cursor !== undefined) params.set("after", cursor);

      return request(
        `keyword_search?${params.toString()}`,
        { method: "GET" },
        "threads.search",
        context,
      );
    },
    async mentions({ account, fields, since, until, limit, cursor, before, context }) {
      authorize(account, "threads.mentions");

      return request(
        `${encodeURIComponent(account.accountId)}/mentions?${mediaListQuery("threads.mentions", mentionFields, { fields, since, until, limit, cursor, before })}`,
        { method: "GET" },
        "threads.mentions",
        context,
      );
    },
    async getProfile({ account, context }) {
      authorize(account, "threads.profile.read");

      return request(
        `${encodeURIComponent(account.accountId)}?fields=id,username,name,threads_profile_picture_url,threads_biography,is_verified`,
        { method: "GET" },
        "threads.profile.read",
        context,
      );
    },
    async hideReply({ account, replyId, hide, context }) {
      authorize(account, "threads.comments.moderate");

      return request(
        `${encodeURIComponent(replyId)}/manage_reply?hide=${String(hide)}`,
        { method: "POST" },
        "threads.comments.moderate",
        context,
      );
    },
    async deleteComment({ account, commentId, context }) {
      // Sources (accessed 2026-09-24): https://developers.facebook.com/docs/threads/posts/delete-posts
      // and https://developers.facebook.com/docs/threads/retrieve-and-manage-replies/create-replies
      authorize(account, "threads.comments.delete");

      if (!/^\d+$/.test(commentId))
        fail(
          "threads.comments.delete",
          "Provide the numeric Threads reply media ID.",
          "invalid_input",
        );

      const result = await request(
        encodeURIComponent(commentId),
        { method: "DELETE" },
        "threads.comments.delete",
        context,
      );

      if (result["success"] !== true)
        fail("threads.comments.delete", "Threads did not confirm the reply deletion.");
    },
    async listReplies({ account, mediaId, cursor, before, reverse, fields, context }) {
      authorize(account, "threads.comments.list");

      const query = new URLSearchParams(
        mediaListQuery("threads.comments.list", [...replyFields, "hide_status", "topic_tag"], {
          fields,
          cursor,
          before,
        }),
      );

      if (reverse !== undefined) query.set("reverse", String(reverse));

      return request(
        `${encodeURIComponent(mediaId)}/replies?${query.toString()}`,
        { method: "GET" },
        "threads.comments.list",
        context,
      );
    },
    async listConversation({ account, mediaId, cursor, before, reverse, fields, context }) {
      authorize(account, "threads.comments.conversation");

      const selected =
        fieldList("threads.comments.conversation", fields) ?? conversationFields.join(",");

      if (cursor !== undefined && before !== undefined)
        fail(
          "threads.comments.conversation",
          "Send cursor (after) or before, not both.",
          "invalid_input",
        );

      const query = new URLSearchParams();

      if (before !== undefined) query.set("before", before);

      if (cursor !== undefined) query.set("after", cursor);

      if (reverse !== undefined) query.set("reverse", String(reverse));

      return request(
        `${encodeURIComponent(mediaId)}/conversation?fields=${selected}${query.size ? `&${query.toString()}` : ""}`,
        { method: "GET" },
        "threads.comments.conversation",
        context,
      );
    },
    async listPendingReplies({
      account,
      mediaId,
      cursor,
      before,
      reverse,
      approvalStatus,
      fields,
      context,
    }) {
      authorize(account, "threads.comments.pending");

      const params = new URLSearchParams(
        mediaListQuery("threads.comments.pending", pendingReplyFields, { fields, cursor, before }),
      );

      if (approvalStatus !== undefined) params.set("approval_status", approvalStatus);

      if (reverse !== undefined) params.set("reverse", String(reverse));

      return request(
        `${encodeURIComponent(mediaId)}/pending_replies?${params.toString()}`,
        { method: "GET" },
        "threads.comments.pending",
        context,
      );
    },
    async managePendingReply({ account, replyId, approve, context }) {
      authorize(account, "threads.comments.moderate");

      return request(
        `${encodeURIComponent(replyId)}/manage_pending_reply?approve=${String(approve)}`,
        { method: "POST" },
        "threads.comments.moderate",
        context,
      );
    },
  };

  const adapter = defineAdapter<ThreadsNative, SocialAdapter<ThreadsNative>>({
    id: backend,
    capabilities,
    native,
    webhooks: directWebhooks(
      "threads",
      (input) => verifyMetaWebhook({ ...input, secret: options.webhookSecret ?? "" }),
      now,
    ),
    accounts: {
      list: async (_input, context) => ({ items: [await readAccount(context)] }),
      get: async (ref, context) => {
        authorize(ref, "threads.accounts.get");

        return readAccount(context);
      },
    },
    graph: {
      async getProfile(account, input, context): Promise<ProfileRecord> {
        authorize(account, "profiles.read");

        let result: JsonObject;

        if (input.handle !== undefined) {
          result = await profileLookup(input.handle, "profiles.read", context);
        } else {
          const profileId = input.profileId ?? account.accountId;

          if (profileId !== account.accountId)
            fail(
              "profiles.read",
              "Threads profile reads are limited to the authorized app-scoped user.",
              "unauthorized",
            );
          result = await request(
            `${encodeURIComponent(profileId)}?fields=id,username,name,threads_profile_picture_url,threads_biography,is_verified`,
            { method: "GET" },
            "profiles.read",
            context,
          );
        }

        const returnedProfileId =
          input.handle === undefined ? optionalString(result["id"]) : undefined;

        const profileId =
          returnedProfileId ??
          input.profileId ??
          (input.handle ? `lookup:${input.handle}` : undefined);

        if (profileId === undefined)
          fail("profiles.read", "Threads profile response did not return a profile ID.");

        const handle = optionalString(result["username"]) ?? input.handle;

        const displayName = optionalString(result["name"]);

        const avatarUrl =
          optionalString(result["profile_picture_url"]) ??
          optionalString(result["threads_profile_picture_url"]);

        const bio =
          optionalString(result["biography"]) ?? optionalString(result["threads_biography"]);

        return {
          ref: profileRef({
            backend,
            platform: "threads",
            accountId: account.accountId,
            profileId,
          }),
          ...definedFields({ displayName, handle, avatarUrl, bio }),
          native:
            returnedProfileId === undefined ? { ...result, _profileIdUnavailable: true } : result,
        };
      },
    },
    search: {
      async posts(account, input: SearchPostsInput, context): Promise<Page<JsonObject>> {
        authorize(account, "search.posts");

        if (input.scope === "all")
          fail("search.posts", "Threads search does not support scope 'all'.", "invalid_input");

        const query = input.query.trim();

        if (!query) fail("search.posts", "A search query is required.", "invalid_input");

        const params = new URLSearchParams({
          q: query,
          fields: searchFields,
        });

        if (input.limit !== undefined) {
          if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
            fail(
              "search.posts",
              "Search limit must be an integer from 1 through 100.",
              "invalid_input",
            );
          params.set("limit", String(input.limit));
        }

        if (input.cursor !== undefined) params.set("after", input.cursor);

        if (input.startTime !== undefined) params.set("since", input.startTime);

        if (input.endTime !== undefined) params.set("until", input.endTime);

        const result = await request(
          `keyword_search?${params.toString()}`,
          { method: "GET" },
          "search.posts",
          context,
        );

        return pageFrom(result);
      },
    },
    posts: {
      list: listPosts,
      prepareTarget(target: PreparedPublishTarget) {
        const issues: { code: string; message: string; severity: "error"; targetIndex: number }[] =
          [];

        const add = (code: string, message: string) =>
          issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

        authorize(target.account, "threads.posts.prepare");

        const media = target.content.media ?? [];

        if (threadsTextLength(target.content.text ?? "") > 500)
          add(
            "text.too_long",
            "Threads text is limited to 500 characters, counting emoji as UTF-8 bytes.",
          );

        if (media.length > 20)
          add("media.too_many", "Threads carousels support at most twenty items.");

        if (!media.length && !target.content.text)
          add("content.empty", "Threads requires text or media.");

        // link_attachment is accepted on TEXT containers only. Source, accessed 2026-10-24:
        // https://developers.facebook.com/docs/threads/posts#link-attachments
        const link = target.content.link;

        if (link !== undefined) {
          if (media.length)
            add(
              "link.media_conflict",
              "Threads link attachments are supported on text posts only.",
            );

          try {
            httpsUrl(link.url);
          } catch {
            add("link.url_invalid", "Threads link attachments require a public HTTPS URL.");
          }
        }

        for (const item of media) {
          if (item.source.kind !== "https-url")
            add("media.url_required", "Threads requires public HTTPS media URLs.");
          else
            try {
              httpsUrl(item.source.url);
            } catch {
              add(
                "media.url_invalid",
                "Use public HTTPS media without credentials or local hosts.",
              );
            }

          if (
            item.kind === "image" &&
            item.mimeType &&
            item.mimeType !== "image/jpeg" &&
            item.mimeType !== "image/png"
          )
            add("media.format", "Threads images must be JPEG or PNG.");

          if (
            item.kind === "video" &&
            item.mimeType &&
            item.mimeType !== "video/mp4" &&
            item.mimeType !== "video/quicktime"
          )
            add("media.format", "Threads videos must be MP4 or MOV.");

          if (item.kind === "document")
            add("media.format", "Threads publishing accepts image and video media only.");

          if (item.altText && item.altText.length > 1000)
            add("media.alt_text", "Alt text is limited to 1,000 characters.");
        }

        const o = optionsObject(target);

        if (Object.keys(o).some((key) => !threadsOptionKeys.has(key)))
          add("options.unmapped", "A supplied option has no Threads mapping.");

        for (const issue of threadsContainerFields(o, {
          text: target.content.text ?? "",
          mediaCount: media.length,
          linkUrl: link?.url,
          isReply: target.replyTo !== undefined,
        }).issues)
          add(issue.code, issue.message);

        if (target.schedule)
          add("schedule.unsupported", "Threads scheduling requires an application-owned runner.");

        return issues;
      },
      async publishTarget(target, context) {
        authorize(target.account, "threads.posts.publish");

        const media = target.content.media ?? [];

        const item = media.length === 1 ? media[0] : undefined;

        const mediaItems =
          media.length > 1
            ? media.map((entry) => ({
                kind: entry.kind,
                url: entry.source.kind === "https-url" ? entry.source.url : "",
                ...definedFields({ altText: entry.altText === "" ? undefined : entry.altText }),
              }))
            : undefined;

        const singleSource = item?.source.kind === "https-url" ? item.source : undefined;

        const opts: JsonObject = {
          ...optionsObject(target),
          ...definedFields({
            _replyToId: target.replyTo?.postId,
            _linkAttachment: target.content.link?.url,
            _mediaItems: mediaItems,
            _mediaKind: singleSource === undefined ? undefined : item?.kind,
            _mediaUrl: singleSource?.url,
            _altText:
              singleSource === undefined || item?.altText === "" ? undefined : item?.altText,
          }),
        };

        const w = await store.create({
          backend,
          accountId: target.account.accountId,
          childIds: [],
          caption: target.content.text ?? "",
          options: opts,
          stage: "children",
        });

        if (!(await store.claim(w.id))) return processing(target.account, w.id, "CLAIMED");

        try {
          try {
            const outcome = await resume((await store.get(w.id)) ?? w, target.account, context);

            return { ...outcome, targetIndex: target.targetIndex };
          } catch (error) {
            if (error instanceof SocialError && error.code === "ambiguous_outcome")
              return {
                ...ambiguous(target.account, w.id, "AMBIGUOUS", error.message),
                targetIndex: target.targetIndex,
              };

            throw error;
          }
        } finally {
          await store.release?.(w.id);
        }
      },
      async get(ref, c) {
        authorize(ref, "threads.posts.get");

        return native.getPost(ref.postId, c);
      },
      async removeFromPlatform(ref, c) {
        authorize(ref, "threads.posts.delete");

        return native.deletePost({
          account: accountRef(backend, ref.accountId),
          postId: ref.postId,
          context: c,
        });
      },
      async getDelivery(ref, c): Promise<DeliveryOutcome> {
        authorize(ref, "threads.posts.status");

        const w = await store.get(ref.deliveryId);

        if (!w || w.backend !== backend || w.accountId !== ref.accountId)
          fail(
            "threads.posts.status",
            "Workflow handle is not authorized for this account.",
            "unauthorized",
          );

        const owner = accountRef(backend, ref.accountId);

        if (w.nativeId) return published(owner, w.id, w.nativeId);

        if (w.stage === "unknown")
          return ambiguous(owner, w.id, w.backendState, "Explicit resumePublication is required.");

        if (!(await store.claim(w.id))) return processing(owner, w.id, "CLAIMED");

        try {
          return await resume((await store.get(w.id)) ?? w, owner, c);
        } finally {
          await store.release?.(w.id);
        }
      },
    },
    comments: {
      async list(post, input, context): Promise<Page<JsonObject>> {
        authorize(post, "threads.comments.list");

        const result = await request(
          `${encodeURIComponent(post.postId)}/replies?fields=id,text,username,timestamp,permalink,replied_to,root_post,hide_status${input.cursor ? `&after=${encodeURIComponent(input.cursor)}` : ""}`,
          { method: "GET" },
          "threads.comments.list",
          context,
        );

        const listed = pageFrom(result);

        return {
          ...listed,
          items: listed.items.map((row) => {
            const parent = row["replied_to"];

            return normalizeComment({
              ...row,
              ...definedFields({
                parentId: isJsonObject(parent) ? optionalString(parent["id"]) : undefined,
              }),
            });
          }),
        };
      },
      async reply(comment: CommentRef, content: { text: string }, context): Promise<CommentRef> {
        authorize(comment, "threads.comments.reply");

        if (!content.text.trim())
          fail("threads.comments.reply", "Comment text is required.", "invalid_input");

        const container = await request(
          `${encodeURIComponent(comment.accountId)}/threads?media_type=TEXT&text=${encodeURIComponent(content.text)}&reply_to_id=${encodeURIComponent(comment.commentId)}`,
          { method: "POST" },
          "threads.comments.reply",
          context,
        );

        const creationId = optionalString(container["id"]);

        if (creationId === undefined)
          fail("threads.comments.reply", "Threads did not return a reply container ID.");

        const result = await request(
          `${encodeURIComponent(comment.accountId)}/threads_publish?creation_id=${encodeURIComponent(creationId)}`,
          { method: "POST" },
          "threads.comments.reply",
          context,
        );

        const replyId = optionalString(result["id"]);

        if (!replyId || replyId === comment.commentId)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "threads.comments.reply",
            message: "Threads publish did not return a new reply ID; reconcile before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return { ...comment, commentId: replyId };
      },
    },
    analytics: {
      getAccountMetrics,
      async getPostMetrics(post, c): Promise<readonly MetricValue[]> {
        authorize(post, "threads.analytics");

        const r = await request(
          `${encodeURIComponent(post.postId)}/insights?metric=views,likes,replies,reposts,quotes,shares`,
          { method: "GET", ...definedFields({ signal: c.signal }) },
          "threads.analytics",
          c,
        );

        const metrics: readonly MetricValue[] = array(r["data"]).flatMap((x) => {
          const row = object(x);

          const first = optionalArray(row["values"])?.[0];

          const value =
            isJsonObject(first) || isJsonArray(first)
              ? optionalNumber(object(first)["value"])
              : optionalNumber(row["value"]);

          const name = optionalString(row["name"]);

          return value === undefined || name === undefined
            ? []
            : [
                {
                  name,
                  value,
                  unit: "count",
                  period: "lifetime",
                  fetchedAt: now(),
                  freshness: "unknown",
                  source: `threads:${version}`,
                },
              ];
        });

        return normalizeMetrics(metrics);
      },
    },
  });

  return adapter;
}
