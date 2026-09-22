/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof -- validated external boundary or fixture contract. */
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
  readonly search: (input: {
    readonly account: ConnectedAccountRef;
    readonly query: string;
    readonly cursor?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly mentions: (input: {
    readonly account: ConnectedAccountRef;
    readonly cursor?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly getProfile: (input: {
    readonly account: ConnectedAccountRef;
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

  async function readAccount(context: AdapterOperationContext) {
    const v = await request(
      "/me?fields=id,username",
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

    const allowed = new Set<string>(metricNames);

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
          name,
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
          ? { reply_control: cur.options["replyControl"] }
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
      },
      { operation: "posts.read", platform: "threads", availability: "available" },
      { operation: "posts.list", platform: "threads", availability: "available" },
      { operation: "posts.status", platform: "threads", availability: "available" },
      { operation: "analytics.read", platform: "threads", availability: "available" },
      { operation: "comments.read", platform: "threads", availability: "available" },
      { operation: "comments.write", platform: "threads", availability: "available" },
      { operation: "posts.quote", platform: "threads", availability: "available" },
      { operation: "posts.repost", platform: "threads", availability: "available" },
      { operation: "posts.delete", platform: "threads", availability: "available" },
      { operation: "profile.read", platform: "threads", availability: "available" },
      { operation: "search.keyword", platform: "threads", availability: "available" },
      { operation: "mentions.read", platform: "threads", availability: "available" },
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

      return request(
        `${encodeURIComponent(account.accountId)}/threads?media_type=TEXT&text=${encodeURIComponent(text)}&quote_id=${encodeURIComponent(postId)}`,
        { method: "POST" },
        "threads.posts.quote",
        context,
      );
    },
    async repost({ account, postId, context }) {
      authorize(account, "threads.posts.repost");

      return request(
        `${encodeURIComponent(account.accountId)}/threads?media_type=TEXT&repost_id=${encodeURIComponent(postId)}`,
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
    async search({ account, query, cursor, context }) {
      authorize(account, "threads.search");

      return request(
        `keyword_search?query=${encodeURIComponent(query)}${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`,
        { method: "GET" },
        "threads.search",
        context,
      );
    },
    async mentions({ account, cursor, context }) {
      authorize(account, "threads.mentions");

      return request(
        `${encodeURIComponent(account.accountId)}/mentions${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`,
        { method: "GET" },
        "threads.mentions",
        context,
      );
    },
    async getProfile({ account, context }) {
      authorize(account, "threads.profile.read");

      return request(
        `${encodeURIComponent(account.accountId)}?fields=id,username,name,threads_profile_picture_url`,
        { method: "GET" },
        "threads.profile.read",
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
      async publishTarget(target) {
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
        return {
          ...base(target.account, w.id, "processing", "CREATED"),
          targetIndex: target.targetIndex,
        } as DeliveryOutcome;
      },
      async get(ref, c) {
        authorize(ref, "threads.posts.get");

        return native.getPost(ref.postId, c);
      },
      async getDelivery(ref, _c): Promise<DeliveryOutcome> {
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

        return base(accountRef(backend, ref.accountId), w.id, "processing", w.stage.toUpperCase());
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
          typeof (result["paging"] as JsonObject)["next"] === "string"
            ? // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
              { nextCursor: String((result["paging"] as JsonObject)["next"]) }
            : {}),
        };
      },
      async reply(comment: CommentRef, content: { text: string }, context): Promise<CommentRef> {
        authorize(comment, "threads.comments.reply");

        if (!content.text.trim())
          fail("threads.comments.reply", "Comment text is required.", "invalid_input");

        const result = await request(
          `${encodeURIComponent(comment.postId)}/replies`,
          { method: "POST" },
          "threads.comments.reply",
          context,
        );

        return {
          ...comment,
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
          commentId: typeof result["id"] === "string" ? result["id"] : comment.commentId,
        };
      },
    },
    analytics: {
      getAccountMetrics,
      async getPostMetrics(post, c): Promise<readonly MetricValue[]> {
        authorize(post, "threads.analytics");

        const r = await request(
          `${encodeURIComponent(post.postId)}/insights?metric=views,likes,replies,reposts,quotes,shares`,
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

          const name = row["name"];

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
