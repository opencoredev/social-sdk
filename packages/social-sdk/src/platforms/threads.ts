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
} from "../core/index.js";
import { SocialError } from "../core/errors.js";
import { managedHttp, optionsObject, publicFields } from "../cloud/common.js";
import { definedFields } from "../core/fields.js";
import {
  object,
  array,
  isJsonArray,
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

export interface ThreadsNative {
  readonly getPost: (id: string, context: AdapterOperationContext) => Promise<JsonObject>;
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
  readonly mentions: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
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
  readonly listConversation: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly cursor?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly listPendingReplies: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaId: string;
    readonly cursor?: string;
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
  ): Promise<JsonObject> {
    const [raw = "", qs] = path.split("?", 2);
    const query = Object.fromEntries(new URLSearchParams(qs ?? ""));

    try {
      return object(
        await http(
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
      if (e instanceof SocialError) throw e;
      fail(operation, "Threads API request failed.");
    }
  }

  function authorize(ref: { backend: string; platform: string; accountId: string }, op: string) {
    if (ref.backend !== backend || ref.platform !== "threads" || ref.accountId !== auth.userId)
      fail(op, "Account reference does not match this Threads authorization.", "unauthorized");
  }

  const account = accountRef(backend, auth.userId);

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

    const query = new URLSearchParams({
      fields: "id,text,username,media_type,permalink,timestamp",
    });

    if (input.cursor !== undefined) query.set("after", input.cursor);

    if (input.limit !== undefined) query.set("limit", String(input.limit));

    const result = await request(
      `${encodeURIComponent(selected.accountId)}/threads?${query.toString()}`,
      { method: "GET" },
      "threads.posts.list",
      context,
    );

    const items = array(result["data"]).map((entry) =>
      publicFields(entry, ["id", "text", "username", "media_type", "permalink", "timestamp"]),
    );

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

    const allowed = new Set<string>([...metricNames, "link_total_values"]);

    return array(result["data"]).flatMap((entry) => {
      const row = object(entry);
      const name = optionalString(row["name"]);

      if (name === undefined || !allowed.has(name)) return [];
      const total = row["total_value"] === undefined ? undefined : object(row["total_value"]);
      const values = row["values"] === undefined ? [] : array(row["values"]);
      const latest = values.at(-1);
      const totalValue = optionalNumber(total?.["value"]);

      const value =
        totalValue ?? (latest === undefined ? undefined : optionalNumber(object(latest)["value"]));

      if (value === undefined) return [];

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
          name: name === "link_total_values" ? "clicks" : name,
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

  function replyControlParam(value: string): string {
    if (value === "accountsYouFollow") return "accounts_you_follow";

    if (value === "mentionedOnly") return "mentioned_only";

    return "everyone";
  }

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
      const replyControl = optionalString(cur.options["replyControl"]);

      const p = new URLSearchParams({
        media_type: parentMediaType(cur.childIds.length, singleKind),
        ...definedFields({
          children: cur.childIds.length ? cur.childIds.join(",") : undefined,
          video_url: singleKind === "video" ? singleUrl : undefined,
          image_url: singleKind === "video" ? undefined : singleUrl,
          alt_text: optionalString(cur.options["_altText"]),
          text: cur.caption === "" ? undefined : cur.caption,
          reply_control: replyControl === undefined ? undefined : replyControlParam(replyControl),
          reply_to_id: optionalString(cur.options["_replyToId"]),
        }),
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

      await store.update(cur.id, { nativeId, stage: "published", backendState: "PUBLISHED" });

      return published(a, cur.id, nativeId);
    } catch (e) {
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
        "Verifies Meta X-Hub-Signature-256 with the app secret and decodes replies, mentions, publish, and delete deliveries. Answer the GET handshake with answerMetaWebhookChallenge.",
      ),
      {
        operation: "posts.publish",
        platform: "threads",
        availability: "available",
        formats: ["text", "image", "video", "carousel"],
        requiredScopes: ["threads_basic", "threads_content_publish"],
      },
      { operation: "posts.read", platform: "threads", availability: "available" },
      { operation: "posts.list", platform: "threads", availability: "available" },
      { operation: "posts.status", platform: "threads", availability: "available" },
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
      {
        operation: "comments.write",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_basic", "threads_manage_replies"],
      },
      {
        operation: "comments.moderate",
        platform: "threads",
        availability: "available",
        requiredScopes: ["threads_manage_replies"],
        notes:
          "Hiding replies and pending-reply moderation require Threads reply-management permissions.",
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
      {
        operation: "messages.read",
        platform: "threads",
        availability: "unsupported-by-platform",
        notes: "Threads does not expose messaging APIs to standard apps.",
      },
    ],
  };

  const native: ThreadsNative = {
    getPost: (id, c) =>
      request(
        `${encodeURIComponent(id)}?fields=id,text,username,media_type,permalink`,
        { method: "GET", ...definedFields({ signal: c.signal }) },
        "threads.posts.get",
        c,
      ),
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

      const container = await request(
        `${encodeURIComponent(account.accountId)}/threads?media_type=TEXT&text=${encodeURIComponent(text)}&quote_post_id=${encodeURIComponent(postId)}`,
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

      return request(
        `${encodeURIComponent(postId)}/repost`,
        { method: "POST" },
        "threads.posts.repost",
        context,
      );
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
        fields: "id,text,media_type,media_url,permalink,timestamp,username,shortcode,is_quote_post",
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
    async mentions({ account, cursor, context }) {
      authorize(account, "threads.mentions");

      return request(
        `${encodeURIComponent(account.accountId)}/mentions?fields=id,text,username,media_type,media_url,permalink,timestamp${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`,
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
    async listConversation({ account, mediaId, cursor, context }) {
      authorize(account, "threads.comments.conversation");

      return request(
        `${encodeURIComponent(mediaId)}/conversation?fields=id,text,username,permalink,timestamp,is_reply,hide_status${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`,
        { method: "GET" },
        "threads.comments.conversation",
        context,
      );
    },
    async listPendingReplies({ account, mediaId, cursor, approvalStatus, context }) {
      authorize(account, "threads.comments.pending");

      const params = new URLSearchParams({
        fields: "id,text,username,timestamp,is_reply,hide_status,reply_approval_status",
      });

      if (cursor !== undefined) params.set("after", cursor);

      if (approvalStatus !== undefined) params.set("approval_status", approvalStatus);

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

        let returnedProfileId: string | undefined;

        if (input.handle !== undefined) {
          // Profile Discovery fields, per "Retrieve a Threads user's public profile information":
          // https://developers.facebook.com/documentation/threads/threads-profiles
          // (v1.0, page updated 2026-04-13, accessed 2026-09-24). `id` is not a documented
          // profile_lookup field, so it is not requested and the lookup has no provider ID.
          const params = new URLSearchParams({
            username: input.handle,
            fields: "username,name,profile_picture_url,biography,is_verified",
          });
          result = await request(
            `profile_lookup?${params.toString()}`,
            { method: "GET" },
            "profiles.read",
            context,
          );
        } else {
          const profileId = input.profileId ?? account.accountId;

          if (profileId !== account.accountId)
            fail(
              "profiles.read",
              "Threads profile reads are limited to the authorized app-scoped user.",
              "unauthorized",
            );
          // App-scoped profile fields, per "Retrieve a Threads app-scoped user's profile
          // information" on the same page (accessed 2026-09-24). `id` is documented here.
          result = await request(
            `${encodeURIComponent(profileId)}?fields=id,username,name,threads_profile_picture_url,threads_biography,is_verified`,
            { method: "GET" },
            "profiles.read",
            context,
          );
          returnedProfileId = optionalString(result["id"]);
        }

        const handle = optionalString(result["username"]) ?? input.handle;
        // profile_lookup returns no Threads user ID. The normalized ID is a namespaced
        // `lookup:<username>` so a username is never presented as a provider user ID.
        const profileId =
          returnedProfileId ??
          input.profileId ??
          (input.handle === undefined ? undefined : `lookup:${handle ?? input.handle}`);

        if (profileId === undefined)
          fail("profiles.read", "Threads profile response did not return a profile ID.");
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
          fields:
            "id,text,media_type,media_url,permalink,timestamp,username,shortcode,is_quote_post",
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

        if ((target.content.text?.length ?? 0) > 500)
          add("text.too_long", "Threads text is limited to 500 characters.");

        if (media.length > 10)
          add("media.too_many", "Threads carousels support at most ten items.");

        if (!media.length && !target.content.text)
          add("content.empty", "Threads requires text or media.");

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

          if (item.kind === "video" && item.mimeType && item.mimeType !== "video/mp4")
            add("media.format", "Threads videos must be MP4.");

          if (item.altText && item.altText.length > 1000)
            add("media.alt_text", "Alt text is limited to 1,000 characters.");
        }

        if (target.options !== undefined) {
          const o = optionsObject(target);

          if (Object.keys(o).some((key) => key !== "replyControl"))
            add("options.unmapped", "A supplied option has no Threads mapping.");
          const replyControl = o["replyControl"];

          if (
            replyControl !== undefined &&
            replyControl !== "everyone" &&
            replyControl !== "accountsYouFollow" &&
            replyControl !== "mentionedOnly"
          )
            add("options.reply_control", "Unsupported Threads reply control.");
        }

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
          `${encodeURIComponent(post.postId)}/replies?fields=id,text,username,timestamp${input.cursor ? `&after=${encodeURIComponent(input.cursor)}` : ""}`,
          { method: "GET" },
          "threads.comments.list",
          context,
        );

        const rows = (optionalArray(result["data"]) ?? []).filter(isJsonObject);
        const cursors = optionalObject(optionalObject(result["paging"])?.["cursors"]);

        return {
          items: rows,
          ...definedFields({ nextCursor: optionalString(cursors?.["after"]) }),
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

        return { ...comment, commentId: optionalString(result["id"]) ?? comment.commentId };
      },
    },
    analytics: {
      getAccountMetrics,
      async getPostMetrics(post, c): Promise<readonly MetricValue[]> {
        authorize(post, "threads.analytics");

        const r = await request(
          `${encodeURIComponent(post.postId)}/insights?metric=views,likes,replies,reposts,quotes,shares,link_total_values`,
          { method: "GET", ...definedFields({ signal: c.signal }) },
          "threads.analytics",
          c,
        );

        return array(r["data"]).flatMap((x) => {
          const row = object(x);
          const first = optionalArray(row["values"])?.[0];

          const value =
            isJsonObject(first) || isJsonArray(first)
              ? optionalNumber(object(first)["value"])
              : optionalNumber(row["value"]);

          const rawName = optionalString(row["name"]);
          const name = rawName === "link_total_values" ? "clicks" : rawName;

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
      },
    },
  });

  return adapter;
}
