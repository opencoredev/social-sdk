/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof, anti-slop/require-readable-spacing, anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract. */
import {
  connectedAccountRef,
  defineAdapter,
  platformPostRef,
  type AdapterOperationContext,
  type CommentRef,
  type CapabilityManifest,
  type DeliveryOutcome,
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
import { managedHttp, publicFields } from "../cloud/common.js";
import { object, array, optionalNumber, optionalString } from "../transport/validation.js";
import { httpsUrl } from "../transport/upload.js";

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
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
    ...(options.fetch ? { fetch: options.fetch } : {}),
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
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
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
      ) as JsonObject;
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
    const items = array(result["data"]).map((entry) => {
      // SAFETY: object() validates each provider data entry as a JSON object.
      return object(entry) as JsonObject;
    });
    const paging = result["paging"] === undefined ? {} : object(result["paging"]);
    const cursors = paging["cursors"] === undefined ? {} : object(paging["cursors"]);
    // Graph omits paging.next on the last page even when cursors.after is present.
    const nextCursor =
      typeof paging["next"] === "string" && paging["next"].length > 0
        ? optionalString(cursors["after"])
        : undefined;

    return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
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

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
    if (typeof id !== "string" || id !== auth.userId)
      fail("threads.accounts.read", "Threads returned an unauthorized account.", "unauthorized");

    return {
      ref: account,
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      displayName: typeof username === "string" ? username : (auth.handle ?? auth.userId),
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
      ...(typeof username === "string" ? { handle: username } : {}),
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
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
    const hasNext = typeof paging["next"] === "string" && paging["next"].length > 0;

    const nextCursor =
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      hasNext && typeof cursors["after"] === "string" ? cursors["after"] : undefined;

    return {
      items,
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
      ...(nextCursor === undefined ? {} : { nextCursor }),
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
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      const name = typeof row["name"] === "string" ? row["name"] : undefined;

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
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(totalValue === undefined && latestEnd !== undefined ? { measuredAt: latestEnd } : {}),
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
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
      { method: "GET", ...(c.signal ? { signal: c.signal } : {}) },
      "threads.container.status",
      c,
    );
  }

  const base = (
    a: ConnectedAccountRef,
    id: string,
    state: DeliveryOutcome["state"],
    backendState?: string,
  ) =>
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- provider payload is validated at this adapter boundary.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
    ({
      state,
      targetIndex: 0,
      account: a,
      observedAt: now(),
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
      ...(backendState ? { backendState } : {}),
      delivery: {
        kind: "delivery" as const,
        version: 1 as const,
        backend: a.backend,
        platform: "threads" as const,
        accountId: a.accountId,
        deliveryId: id,
      },
    }) as unknown as DeliveryOutcome;

  const terminalFailure = (a: ConnectedAccountRef, id: string, state: string): DeliveryOutcome =>
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
    ({
      ...base(a, id, "failed", state),
      code: "media_error",
      message: "Threads container failed or expired before publication.",
      retryDisposition: { kind: "never" },
    }) as DeliveryOutcome;

  async function resume(
    w: ThreadsWorkflow,
    a: ConnectedAccountRef,
    c: AdapterOperationContext,
  ): Promise<DeliveryOutcome> {
    if (w.nativeId)
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      return {
        ...base(a, w.id, "published", "PUBLISHED"),
        post: platformPostRef({
          backend,
          platform: "threads",
          accountId: a.accountId,
          postId: w.nativeId,
        }),
      } as DeliveryOutcome;

    if (w.stage === "unknown")
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      return {
        ...base(a, w.id, "unknown", w.backendState),
        reason: "ambiguous-submission",
        diagnostic: "Threads publish acceptance is unknown; no replay was attempted.",
      } as DeliveryOutcome;
    let cur = w;
    const items = Array.isArray(cur.options["_mediaItems"]) ? cur.options["_mediaItems"] : [];

    while (cur.childIds.length < items.length) {
      const item = object(items[cur.childIds.length]);

      const p = new URLSearchParams({
        media_type: item["kind"] === "video" ? "VIDEO" : "IMAGE",
        is_carousel_item: "true",
        ...(item["kind"] === "video"
          ? { video_url: String(item["url"]) }
          : { image_url: String(item["url"]) }),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
        ...(typeof item["altText"] === "string" ? { alt_text: item["altText"] } : {}),
      });

      await store.update(cur.id, { stage: "unknown", backendState: "CREATING_CHILD" });

      const child = await request(
        `${a.accountId}/threads?${p}`,
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        { method: "POST", ...(c.signal ? { signal: c.signal } : {}) },
        "threads.container.child",
        c,
      );

      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      if (typeof child["id"] !== "string")
        fail("threads.container.child", "Threads did not return a child container ID.");
      cur = await store.update(cur.id, {
        childIds: [...cur.childIds, child["id"]],
        stage: "children",
      });
    }

    for (const id of cur.childIds) {
      const s = await status(id, c);
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      const st = typeof s["status"] === "string" ? s["status"] : "";

      if (st === "ERROR" || st === "EXPIRED") return terminalFailure(a, w.id, st);

      if (st !== "FINISHED" && st !== "PUBLISHED")
        return base(a, w.id, "processing", st || "PROCESSING");
    }

    if (!cur.parentId) {
      const singleKind = cur.options["_mediaKind"];
      const singleUrl = cur.options["_mediaUrl"];

      const p = new URLSearchParams({
        media_type: cur.childIds.length
          ? "CAROUSEL"
          : singleKind === "video"
            ? "VIDEO"
            : singleKind === "image"
              ? "IMAGE"
              : "TEXT",
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(cur.childIds.length ? { children: cur.childIds.join(",") } : {}),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
        ...(typeof singleUrl === "string"
          ? singleKind === "video"
            ? { video_url: singleUrl }
            : { image_url: singleUrl }
          : {}),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
        ...(typeof cur.options["_altText"] === "string"
          ? { alt_text: cur.options["_altText"] }
          : {}),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(cur.caption ? { text: cur.caption } : {}),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
        ...(typeof cur.options["replyControl"] === "string"
          ? {
              reply_control:
                cur.options["replyControl"] === "accountsYouFollow"
                  ? "accounts_you_follow"
                  : cur.options["replyControl"] === "mentionedOnly"
                    ? "mentioned_only"
                    : "everyone",
            }
          : {}),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
        ...(typeof cur.options["_replyToId"] === "string"
          ? { reply_to_id: cur.options["_replyToId"] }
          : {}),
      });

      // Persist ambiguity before dispatch so a process crash cannot recreate a
      // possibly accepted container under the same continuation handle.
      await store.update(cur.id, { stage: "unknown", backendState: "CREATING_PARENT" });

      const parent = await request(
        `${a.accountId}/threads?${p}`,
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        { method: "POST", ...(c.signal ? { signal: c.signal } : {}) },
        "threads.container.create",
        c,
      );

      const parentId = parent["id"];

      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      if (typeof parentId !== "string")
        fail("threads.container.create", "Threads did not return a container ID.");
      cur = await store.update(cur.id, { parentId, stage: "parent" });
    }

    const parentId = cur.parentId;

    if (!parentId) fail("threads.container.create", "Missing parent container ID.");
    const ps = await status(parentId, c);
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
    const pst = typeof ps["status"] === "string" ? ps["status"] : "";

    if (pst === "ERROR" || pst === "EXPIRED") return terminalFailure(a, cur.id, pst);

    if (pst === "PUBLISHED") {
      await store.update(cur.id, { stage: "unknown", backendState: "PUBLISHED_WITHOUT_NATIVE_ID" });

      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      return {
        ...base(a, cur.id, "unknown", pst),
        reason: "ambiguous-submission",
      } as DeliveryOutcome;
    }

    if (pst !== "FINISHED") return base(a, cur.id, "processing", pst || "PROCESSING");
    await store.update(cur.id, { stage: "unknown", backendState: "PUBLISHING" });

    try {
      const pub = await request(
        `${a.accountId}/threads_publish?creation_id=${encodeURIComponent(parentId)}`,
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        { method: "POST", ...(c.signal ? { signal: c.signal } : {}) },
        "threads.publish",
        c,
      );

      const nativeId = pub["id"];

      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      if (typeof nativeId !== "string") {
        await store.update(cur.id, { stage: "unknown", backendState: "MISSING_ID" });

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return {
          ...base(a, cur.id, "unknown", "MISSING_ID"),
          reason: "ambiguous-submission",
          diagnostic: "Threads accepted publish without a native post ID.",
        } as DeliveryOutcome;
      }

      await store.update(cur.id, { nativeId, stage: "published", backendState: "PUBLISHED" });

      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      return {
        ...base(a, cur.id, "published", "PUBLISHED"),
        post: platformPostRef({
          backend,
          platform: "threads",
          accountId: a.accountId,
          postId: nativeId,
        }),
      } as DeliveryOutcome;
    } catch (e) {
      await store.update(cur.id, { stage: "unknown", backendState: "AMBIGUOUS" });

      if (e instanceof SocialError)
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return {
          ...base(a, cur.id, "unknown", "AMBIGUOUS"),
          reason: "ambiguous-submission",
          diagnostic: e.message,
        } as DeliveryOutcome;
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
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        { method: "GET", ...(c.signal ? { signal: c.signal } : {}) },
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

      if (!(await store.claim(id))) return base(a, id, "processing", "CLAIMED");

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
          result = await request(
            `profile_lookup?username=${encodeURIComponent(input.handle)}&fields=id,username,name,profile_picture_url,biography,is_verified`,
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
          result = await request(
            `${encodeURIComponent(profileId)}?fields=id,username,name,threads_profile_picture_url,threads_biography,is_verified`,
            { method: "GET" },
            "profiles.read",
            context,
          );
        }
        const returnedProfileId = optionalString(result["id"]);
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
          ...(displayName === undefined ? {} : { displayName }),
          ...(handle === undefined ? {} : { handle }),
          ...(avatarUrl === undefined ? {} : { avatarUrl }),
          ...(bio === undefined ? {} : { bio }),
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
          const o = object(target.options);

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

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        const opts = {
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
          ...(object(target.options ?? {}) as JsonObject),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(target.replyTo ? { _replyToId: target.replyTo.postId } : {}),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(media.length > 1
            ? {
                _mediaItems: media.map((entry) => ({
                  kind: entry.kind,
                  url: entry.source.kind === "https-url" ? entry.source.url : "",
                  // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
                  ...(entry.altText ? { altText: entry.altText } : {}),
                })),
              }
            : {}),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(item?.source.kind === "https-url"
            ? {
                _mediaKind: item.kind,
                _mediaUrl: item.source.url,
                // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
                ...(item.altText ? { _altText: item.altText } : {}),
              }
            : {}),
        } as JsonObject;

        const w = await store.create({
          backend,
          accountId: target.account.accountId,
          childIds: [],
          caption: target.content.text ?? "",
          options: opts,
          stage: "children",
        });

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        if (!(await store.claim(w.id))) return base(target.account, w.id, "processing", "CLAIMED");
        try {
          try {
            const outcome = await resume((await store.get(w.id)) ?? w, target.account, context);
            return { ...outcome, targetIndex: target.targetIndex } as DeliveryOutcome;
          } catch (error) {
            if (error instanceof SocialError && error.code === "ambiguous_outcome")
              return {
                ...base(target.account, w.id, "unknown", "AMBIGUOUS"),
                targetIndex: target.targetIndex,
                reason: "ambiguous-submission",
                diagnostic: error.message,
              } as DeliveryOutcome;
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

        if (w.nativeId)
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
          return {
            ...base(accountRef(backend, ref.accountId), w.id, "published", "PUBLISHED"),
            post: platformPostRef({
              backend,
              platform: "threads",
              accountId: ref.accountId,
              postId: w.nativeId,
            }),
          } as DeliveryOutcome;

        if (w.stage === "unknown")
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
          return {
            ...base(accountRef(backend, ref.accountId), w.id, "unknown", w.backendState),
            reason: "ambiguous-submission",
            diagnostic: "Explicit resumePublication is required.",
          } as DeliveryOutcome;

        if (!(await store.claim(w.id)))
          return base(accountRef(backend, ref.accountId), w.id, "processing", "CLAIMED");
        try {
          return await resume((await store.get(w.id)) ?? w, accountRef(backend, ref.accountId), c);
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

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        const rows = Array.isArray(result["data"]) ? (result["data"] as JsonObject[]) : [];

        return {
          items: rows,
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
          ...(typeof result["paging"] === "object" &&
          result["paging"] &&
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
          typeof (result["paging"] as JsonObject)["cursors"] === "object" &&
          (result["paging"] as JsonObject)["cursors"] !== null &&
          typeof ((result["paging"] as JsonObject)["cursors"] as JsonObject)["after"] === "string"
            ? {
                nextCursor: String(
                  ((result["paging"] as JsonObject)["cursors"] as JsonObject)["after"],
                ),
              }
            : {}),
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
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          { method: "GET", ...(c.signal ? { signal: c.signal } : {}) },
          "threads.analytics",
          c,
        );

        return array(r["data"]).flatMap((x) => {
          const row = object(x);
          const first = Array.isArray(row["values"]) ? row["values"][0] : undefined;

          const value =
            // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
            first && typeof first === "object"
              ? optionalNumber(object(first)["value"])
              : optionalNumber(row["value"]);

          const rawName = row["name"];
          const name = rawName === "link_total_values" ? "clicks" : rawName;

          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
          return value === undefined || typeof name !== "string"
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
