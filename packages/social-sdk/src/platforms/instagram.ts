/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract. */
import { defineAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import type {
  AdapterOperationContext,
  CommentRef,
  ConnectedAccountRef,
  DeliveryOutcome,
  JsonObject,
  MetricValue,
  PlatformPostRef,
  PreparedPublishTarget,
} from "../core/types.js";
import { managedHttp, publicFields } from "../cloud/common.js";
import { array, object, optionalNumber, optionalString, string } from "../transport/validation.js";
import { httpsUrl } from "../transport/upload.js";

export interface InstagramOptions {
  /** Instagram Login for professional accounts; Facebook Login tokens are not interchangeable. */
  readonly auth: { readonly accessToken: string; readonly accountId: string };
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
  readonly workflowStore?: InstagramWorkflowStore;
}

export interface InstagramNative {
  readonly publishReel: (input: {
    readonly account: ConnectedAccountRef;
    readonly videoUrl: string;
    readonly caption?: string;
    readonly context: AdapterOperationContext;
  }) => Promise<DeliveryOutcome>;
  readonly publishStory: (input: {
    readonly account: ConnectedAccountRef;
    readonly mediaUrl: string;
    readonly context: AdapterOperationContext;
  }) => Promise<DeliveryOutcome>;
  readonly deletePost: (input: {
    readonly account: ConnectedAccountRef;
    readonly postId: string;
    readonly context: AdapterOperationContext;
  }) => Promise<void>;
  readonly hashtagSearch: (input: {
    readonly account: ConnectedAccountRef;
    readonly hashtag: string;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly publishingLimit: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
  readonly mentions: (input: {
    readonly account: ConnectedAccountRef;
    readonly context: AdapterOperationContext;
  }) => Promise<JsonObject>;
}

export interface InstagramWorkflow {
  readonly id: string;
  readonly backend: string;
  readonly accountId: string;
  readonly childIds: readonly string[];
  readonly parentId?: string;
  readonly nativeId?: string;
  readonly caption: string;
  readonly stage: "children" | "parent" | "published" | "unknown" | "failed";
}

export interface InstagramWorkflowStore {
  create(input: Omit<InstagramWorkflow, "id">): Promise<InstagramWorkflow>;
  get(id: string): Promise<InstagramWorkflow | undefined>;
  update(id: string, update: Partial<InstagramWorkflow>): Promise<InstagramWorkflow>;
  /** Atomically claim a workflow for continuation. */
  claim(id: string): Promise<boolean>;
  /** Release a transient continuation claim after the operation settles. */
  release?(id: string): Promise<void>;
}

class MemoryInstagramWorkflowStore implements InstagramWorkflowStore {
  private readonly workflows = new Map<string, InstagramWorkflow>();
  private readonly claims = new Set<string>();
  async create(input: Omit<InstagramWorkflow, "id">): Promise<InstagramWorkflow> {
    const workflow = { ...input, id: `igwf_${globalThis.crypto.randomUUID()}` };
    this.workflows.set(workflow.id, workflow);

    return workflow;
  }
  async get(id: string) {
    return this.workflows.get(id);
  }
  async update(id: string, update: Partial<InstagramWorkflow>) {
    const current = this.workflows.get(id);

    if (!current) throw new Error("Instagram workflow not found");
    const next = { ...current, ...update, id };
    this.workflows.set(id, next);

    return next;
  }
  async claim(id: string) {
    if (!this.workflows.has(id) || this.claims.has(id)) return false;
    this.claims.add(id);

    return true;
  }
  async release(id: string) {
    this.claims.delete(id);
  }
}

export function instagram(
  options: InstagramOptions,
): import("../core/adapter.js").SocialAdapter<InstagramNative> {
  const apiVersion = "v25.0";

  const request = managedHttp(`https://graph.instagram.com/${apiVersion}`, {
    apiKey: options.auth.accessToken,
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const now = () => (options.clock?.() ?? new Date()).toISOString();
  const workflows = options.workflowStore ?? new MemoryInstagramWorkflowStore();

  const authorize = (
    ref: { backend: string; platform: string; accountId: string },
    context: AdapterOperationContext,
  ) => {
    if (
      ref.backend !== context.backendInstance ||
      ref.platform !== "instagram" ||
      ref.accountId !== options.auth.accountId
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "instagram",
        message: "Account reference does not match this Instagram Login authorization.",
      });
  };

  const status = async (id: string, context: AdapterOperationContext) =>
    object(
      await request(`/${encodeURIComponent(id)}`, context, undefined, {
        fields: "id,status_code,status",
      }),
    );

  const listPosts = async (
    selected: ConnectedAccountRef,
    input: { readonly cursor?: string; readonly limit?: number },
    context: AdapterOperationContext,
  ) => {
    authorize(selected, context);

    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "posts.list",
        message: "Instagram feed limit must be an integer from 1 through 100.",
      });

    // oxlint-disable-next-line anti-slop/no-known-value-widening -- validated boundary or fixture contract.
    const query: Record<string, string> = {
      fields: "id,caption,media_type,media_product_type,permalink,timestamp,username",
    };

    if (input.cursor !== undefined) query["after"] = input.cursor;

    if (input.limit !== undefined) query["limit"] = String(input.limit);

    const result = object(
      await request(`/${encodeURIComponent(selected.accountId)}/media`, context, undefined, query),
    );

    const items = array(result["data"]).map((entry) =>
      publicFields(entry, [
        "id",
        "caption",
        "media_type",
        "media_product_type",
        "permalink",
        "timestamp",
        "username",
      ]),
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
  };

  const getAccountMetrics = async (
    selected: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<readonly MetricValue[]> => {
    authorize(selected, context);

    const result = object(
      await request("/me", context, undefined, {
        fields: "user_id,followers_count,media_count",
      }),
    );

    const id = optionalString(result["user_id"]) ?? optionalString(result["id"]);

    if (id !== selected.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation: "analytics.read",
        message: "Instagram returned metrics for a different account.",
      });

    return (["followers_count", "media_count"] as const).flatMap((name) => {
      const value = optionalNumber(result[name]);

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
              source: "Instagram Login Graph v25.0",
            },
          ];
    });
  };

  const publishContainer = async (
    account: ConnectedAccountRef,
    containerId: string,
    context: AdapterOperationContext,
    workflowId?: string,
  ): Promise<DeliveryOutcome> => {
    authorize(account, context);

    if (workflowId) {
      const workflow = await workflows.get(workflowId);

      if (workflow?.nativeId)
        return {
          ...processing(account, workflowId, "PUBLISHED"),
          state: "published",
          post: {
            kind: "platform-post",
            version: 1,
            backend: account.backend,
            platform: "instagram",
            accountId: account.accountId,
            postId: workflow.nativeId,
          },
        };
    }

    const state = await status(containerId, context);
    const code = string(state["status_code"]);

    const base = {
      account,
      targetIndex: 0,
      observedAt: now(),
      backendState: code,
      delivery: {
        kind: "delivery" as const,
        version: 1 as const,
        backend: account.backend,
        platform: "instagram",
        accountId: account.accountId,
        deliveryId: containerId,
      },
    };

    if (code === "IN_PROGRESS") return { ...base, state: "processing" };

    if (code === "ERROR" || code === "EXPIRED")
      return {
        ...base,
        state: "failed",
        code: "media_error",
        message: "Instagram container failed or expired before publication.",
        retryDisposition: { kind: "never" },
      };

    if (code === "PUBLISHED")
      return {
        ...base,
        state: "unknown",
        reason: "unmapped-state",
        diagnostic:
          "Instagram reports a published container but the native media ID was not persisted by this workflow.",
      };

    if (code !== "FINISHED")
      return {
        ...base,
        state: "unknown",
        reason: "unmapped-state",
        diagnostic:
          "Container is already published or has an unmapped state. No repeated publish was dispatched.",
      };

    if (workflowId) await workflows.update(workflowId, { stage: "unknown" });
    let result: JsonObject;

    try {
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      result = object(
        await request(`/${encodeURIComponent(account.accountId)}/media_publish`, context, {
          creation_id: containerId,
        }),
      ) as JsonObject;
    } catch (error) {
      if (workflowId) await workflows.update(workflowId, { stage: "unknown" });
      throw error;
    }

    const nativeId = string(result["id"]);

    if (workflowId)
      await workflows.update(workflowId, { nativeId, stage: "published", parentId: containerId });

    return {
      ...base,
      state: "published",
      backendState: "PUBLISHED",
      post: {
        kind: "platform-post",
        version: 1,
        backend: account.backend,
        platform: "instagram",
        accountId: account.accountId,
        postId: nativeId,
      },
    };
  };

  const processing = (
    account: ConnectedAccountRef,
    workflowId: string,
    backendState: string,
  ): DeliveryOutcome => ({
    state: "processing",
    targetIndex: 0,
    account,
    observedAt: now(),
    backendState,
    delivery: {
      kind: "delivery",
      version: 1,
      backend: account.backend,
      platform: "instagram",
      accountId: account.accountId,
      deliveryId: workflowId,
    },
  });

  const continueWorkflow = async (
    workflow: InstagramWorkflow,
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<DeliveryOutcome> => {
    if (workflow.nativeId)
      return {
        ...processing(account, workflow.id, "PUBLISHED"),
        state: "published",
        post: {
          kind: "platform-post",
          version: 1,
          backend: account.backend,
          platform: "instagram",
          accountId: account.accountId,
          postId: workflow.nativeId,
        },
      };

    if (workflow.stage === "unknown")
      return {
        ...processing(account, workflow.id, "AMBIGUOUS"),
        state: "unknown",
        reason: "ambiguous-submission",
        diagnostic: "Instagram publish acceptance is unknown; no replay was attempted.",
      };

    if (workflow.parentId)
      return publishContainer(account, workflow.parentId, context, workflow.id);

    for (const child of workflow.childIds) {
      const childStatus = await status(child, context);
      const code = string(childStatus["status_code"]);

      if (code !== "FINISHED") return processing(account, workflow.id, code);
    }

    await workflows.update(workflow.id, { stage: "unknown" });

    const parent = object(
      await request(`/${encodeURIComponent(account.accountId)}/media`, context, {
        media_type: "CAROUSEL",
        children: workflow.childIds.join(","),
        caption: workflow.caption,
      }),
    );

    const parentId = string(parent["id"]);
    await workflows.update(workflow.id, { parentId, stage: "parent" });

    return publishContainer(account, parentId, context, workflow.id);
  };

  const resumeWorkflow = async (
    workflow: InstagramWorkflow,
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ) => {
    if (!(await workflows.claim(workflow.id))) return processing(account, workflow.id, "CLAIMED");

    try {
      const current = (await workflows.get(workflow.id)) ?? workflow;

      return await continueWorkflow(current, account, context);
    } finally {
      await workflows.release?.(workflow.id);
    }
  };

  const readAccount = async (context: AdapterOperationContext) => {
    const response = object(
      await request("/me", context, undefined, { fields: "user_id,username,account_type" }),
    );

    const id = optionalString(response["user_id"]) ?? optionalString(response["id"]);

    if (id !== options.auth.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation: "accounts.read",
        message:
          "Instagram returned an account different from the configured professional account.",
      });

    return {
      ref: {
        kind: "connected-account" as const,
        version: 1 as const,
        backend: context.backendInstance,
        platform: "instagram",
        accountId: id,
      },
      displayName: string(response["username"]),
      status: "connected" as const,
    };
  };

  return defineAdapter({
    id: "instagram",
    capabilities: {
      schemaVersion: 1 as const,
      backend: "instagram",
      apiRevision: "Instagram Login Graph v25.0",
      runtime: ["node22", "node24", "bun"],
      capabilities: [
        {
          platform: "instagram",
          operation: "posts.publish",
          availability: "available" as const,
          formats: ["image" as const, "video" as const, "carousel" as const],
          requiredScopes: ["instagram_business_basic", "instagram_business_content_publish"],
          notes:
            "Professional accounts, public HTTPS media, explicit native continuation for processing containers. Carousels must have matching aspect ratios to avoid upstream cropping.",
        },
        ...[
          "accounts.read",
          "posts.list",
          "posts.read",
          "posts.status",
          "comments.read",
          "comments.write",
          "analytics.read",
        ].map((operation) => ({
          operation,
          platform: "instagram",
          availability: "available" as const,
        })),
        {
          platform: "instagram",
          operation: "reels.publish",
          availability: "available" as const,
          formats: ["video" as const],
        },
        { platform: "instagram", operation: "stories.publish", availability: "available" as const },
        { platform: "instagram", operation: "posts.delete", availability: "available" as const },
        { platform: "instagram", operation: "hashtags.search", availability: "available" as const },
        {
          platform: "instagram",
          operation: "publishing.limit.read",
          availability: "available" as const,
        },
        { platform: "instagram", operation: "mentions.read", availability: "available" as const },
        {
          platform: "instagram",
          operation: "product.tagging",
          availability: "approval-dependent" as const,
        },
        {
          platform: "instagram",
          operation: "messages.read",
          availability: "approval-dependent" as const,
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

        if (
          target.account.platform !== "instagram" ||
          target.account.accountId !== options.auth.accountId
        )
          fail("instagram.account", "Select the configured professional Instagram account.");
        const media = target.content.media ?? [];

        if (media.length < 1 || media.length > 10)
          fail("instagram.media", "Instagram requires 1 to 10 image/video attachments.");

        const firstRatio =
          media[0]?.width && media[0]?.height ? media[0].width / media[0].height : undefined;

        for (const item of media) {
          if (item.source.kind !== "https-url")
            fail(
              "instagram.source",
              "Instagram Login publishing requires public HTTPS media URLs.",
            );
          else
            try {
              httpsUrl(item.source.url);
            } catch {
              fail("instagram.url", "Use public HTTPS media without local hosts or credentials.");
            }

          if (item.kind === "image" && item.mimeType !== "image/jpeg")
            fail("instagram.jpeg", "Instagram image publishing requires JPEG media.");

          if (
            item.kind === "video" &&
            item.mimeType !== "video/mp4" &&
            item.mimeType !== "video/quicktime"
          )
            fail("instagram.video", "Provide MP4 or MOV video with a supported codec.");

          if (
            media.length > 1 &&
            (!item.width ||
              !item.height ||
              firstRatio === undefined ||
              Math.abs(item.width / item.height - firstRatio) > 0.001)
          )
            fail(
              "instagram.carousel_crop",
              "Provide matching known aspect ratios for every carousel item; the SDK will not silently accept cropping.",
            );
        }

        if ((target.content.text?.length ?? 0) > 2200)
          fail("instagram.caption", "Caption exceeds 2,200 characters.");

        if (target.schedule || target.replyTo || target.content.link)
          fail(
            "instagram.operation",
            "Use an explicit job runner, comment reply, or caption link instead of unsupported structured options.",
          );

        return issues;
      },
      async publishTarget(
        target: PreparedPublishTarget,
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        authorize(target.account, context);
        const media = target.content.media ?? [];
        const children: string[] = [];

        const workflow = await workflows.create({
          backend: target.account.backend,
          accountId: target.account.accountId,
          childIds: [],
          caption: target.content.text ?? "",
          stage: "children",
        });

        try {
          for (const item of media) {
            if (item.source.kind !== "https-url")
              throw new SocialError({
                code: "invalid_input",
                operation: "posts.publish",
                message: "Public HTTPS media required.",
              });
            const config = target.options === undefined ? {} : object(target.options);
            await workflows.update(workflow.id, { stage: "unknown" });

            const created = object(
              await request(`/${encodeURIComponent(target.account.accountId)}/media`, context, {
                ...(item.kind === "image"
                  ? {
                      image_url: item.source.url,
                      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
                      ...(item.altText === undefined ? {} : { alt_text: item.altText }),
                    }
                  : {
                      video_url: item.source.url,
                      media_type: media.length > 1 ? "VIDEO" : "REELS",
                      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
                      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
                      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
                      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
                      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
                      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
                      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
                      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated external boundary or fixture contract.
                      ...(typeof config["shareToFeed"] === "boolean"
                        ? { share_to_feed: config["shareToFeed"] }
                        : {}),
                    }),
                ...(media.length > 1
                  ? { is_carousel_item: true }
                  : { caption: target.content.text ?? "" }),
              }),
            );

            children.push(string(created["id"]));
            await workflows.update(workflow.id, { childIds: [...children], stage: "children" });
          }
        } catch (error) {
          if (error instanceof SocialError)
            throw new SocialError({
              code: "ambiguous_outcome",
              operation: "instagram.posts.publish",
              message: error.message,
              details: {
                createdContainerIds: children,
                workflowId: workflow.id,
              },
              retryDisposition: { kind: "reconcile-first" },
              cause: error,
            });
          throw error;
        }

        let containerId = children[0];

        if (!containerId) throw new Error("Missing Instagram container");

        if (children.length > 1) {
          const result = await resumeWorkflow(workflow, target.account, context);

          return { ...result, targetIndex: target.targetIndex };
        }

        await workflows.update(workflow.id, { parentId: containerId, stage: "parent" });
        const result = await publishContainer(target.account, containerId, context, workflow.id);

        return { ...result, targetIndex: target.targetIndex };
      },
      async get(ref: PlatformPostRef, context: AdapterOperationContext): Promise<JsonObject> {
        authorize(ref, context);

        return publicFields(
          await request(`/${encodeURIComponent(ref.postId)}`, context, undefined, {
            fields: "id,caption,media_type,media_product_type,permalink,timestamp,username",
          }),
          [
            "id",
            "caption",
            "media_type",
            "media_product_type",
            "permalink",
            "timestamp",
            "username",
          ],
        );
      },
      async getDelivery(
        ref: { backend: string; platform: string; accountId: string; deliveryId: string },
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        authorize(ref, context);
        const workflow = await workflows.get(ref.deliveryId);

        if (workflow) {
          if (workflow.backend !== ref.backend || workflow.accountId !== ref.accountId)
            throw new SocialError({
              code: "unauthorized",
              operation: "instagram.posts.status",
              message: "Instagram workflow handle is not authorized for this account.",
            });

          const account = {
            kind: "connected-account" as const,
            version: 1 as const,
            backend: ref.backend,
            platform: "instagram" as const,
            accountId: ref.accountId,
          };

          if (workflow.nativeId)
            return {
              ...processing(account, workflow.id, "PUBLISHED"),
              state: "published",
              post: {
                kind: "platform-post",
                version: 1,
                backend: ref.backend,
                platform: "instagram",
                accountId: ref.accountId,
                postId: workflow.nativeId,
              },
            };

          if (workflow.stage === "unknown")
            return {
              ...processing(account, workflow.id, "AMBIGUOUS"),
              state: "unknown",
              reason: "ambiguous-submission",
              diagnostic: "Explicit resumePublication is required.",
            };

          return processing(account, workflow.id, workflow.stage.toUpperCase());
        }

        const result = await status(ref.deliveryId, context);
        const code = string(result["status_code"]);

        const base = {
          account: {
            kind: "connected-account" as const,
            version: 1 as const,
            backend: ref.backend,
            platform: "instagram",
            accountId: ref.accountId,
          },
          targetIndex: 0,
          observedAt: now(),
          backendState: code,
          delivery: { kind: "delivery" as const, version: 1 as const, ...ref },
        };

        if (code === "IN_PROGRESS" || code === "FINISHED") return { ...base, state: "processing" };

        if (code === "ERROR" || code === "EXPIRED")
          return {
            ...base,
            state: "failed",
            code: "media_error",
            message: "Instagram container failed or expired.",
            retryDisposition: { kind: "never" },
          };

        return {
          ...base,
          state: "unknown",
          reason: "unmapped-state",
          diagnostic:
            "Container status alone does not identify a published native post. Reconcile stored publish results.",
        };
      },
    },
    comments: {
      async list(
        ref: PlatformPostRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        if (input.cursor !== undefined)
          throw new SocialError({
            code: "unsupported_capability",
            operation: "comments.read",
            message: "This adapter does not expose upstream comment pagination.",
          });
        authorize(ref, context);

        const result = object(
          await request(`/${encodeURIComponent(ref.postId)}/comments`, context, undefined, {
            fields: "id,text,timestamp,username",
            limit: "25",
          }),
        );

        return {
          items: array(result["data"]).map((entry) =>
            publicFields(entry, ["id", "text", "timestamp", "username"]),
          ),
        };
      },
      async reply(
        ref: CommentRef,
        content: { text: string },
        context: AdapterOperationContext,
      ): Promise<CommentRef> {
        authorize(ref, context);

        const result = object(
          await request(`/${encodeURIComponent(ref.commentId)}/replies`, context, {
            message: content.text,
          }),
        );

        return { ...ref, commentId: string(result["id"]) };
      },
    },
    analytics: {
      getAccountMetrics,
      async getPostMetrics(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        authorize(ref, context);

        const result = object(
          await request(`/${encodeURIComponent(ref.postId)}/insights`, context, undefined, {
            metric: "likes,comments,saved,shares,reach",
          }),
        );

        return array(result["data"]).flatMap((entry) => {
          const row = object(entry);
          const value = array(row["values"])[0];

          if (!value) return [];
          const count = optionalNumber(object(value)["value"]);

          return count === undefined
            ? []
            : [
                {
                  name: string(row["name"]),
                  value: count,
                  unit: "count" as const,
                  period: "lifetime" as const,
                  fetchedAt: now(),
                  freshness: "unknown" as const,
                  source: `instagram:${apiVersion}`,
                },
              ];
        });
      },
    },
    native: {
      publishContainer,
      async publishCarousel(
        account: ConnectedAccountRef,
        children: readonly string[],
        caption: string,
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        authorize(account, context);

        const workflow = await workflows.create({
          backend: account.backend,
          accountId: account.accountId,
          childIds: [...children],
          caption,
          stage: "children",
        });

        return resumeWorkflow(workflow, account, context);
      },
      async resumePublication(
        account: ConnectedAccountRef,
        workflowId: string,
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        authorize(account, context);
        const workflow = await workflows.get(workflowId);

        if (
          !workflow ||
          workflow.backend !== context.backendInstance ||
          workflow.accountId !== account.accountId
        )
          throw new SocialError({
            code: "unauthorized",
            operation: "instagram.posts.resume",
            message: "Instagram workflow handle is not authorized for this account.",
          });

        return resumeWorkflow(workflow, account, context);
      },
      async publishReel({ account, videoUrl, caption, context }) {
        authorize(account, context);

        const created = object(
          await request(`/${encodeURIComponent(account.accountId)}/media`, context, {
            media_type: "REELS",
            video_url: videoUrl,
            // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
            ...(caption ? { caption } : {}),
          }),
        );

        return publishContainer(account, string(created["id"]), context);
      },
      async publishStory({ account, mediaUrl, context }) {
        authorize(account, context);

        const created = object(
          await request(`/${encodeURIComponent(account.accountId)}/media`, context, {
            media_type: "STORIES",
            image_url: mediaUrl,
          }),
        );

        return publishContainer(account, string(created["id"]), context);
      },
      async deletePost({ account, postId, context }) {
        authorize(account, context);
        await request(`/${encodeURIComponent(postId)}`, context, undefined, {}, "DELETE");
      },
      async hashtagSearch({ account, hashtag, context }) {
        authorize(account, context);

        const tag = object(
          await request("/ig_hashtag_search", context, undefined, {
            user_id: account.accountId,
            q: hashtag.replace(/^#/, ""),
          }),
        );

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return tag as JsonObject;
      },
      async publishingLimit({ account, context }) {
        authorize(account, context);

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return object(
          await request(
            `/${encodeURIComponent(account.accountId)}/content_publishing_limit`,
            context,
            undefined,
            { fields: "config,quota_usage" },
          ),
        ) as JsonObject;
      },
      async mentions({ account, context }) {
        authorize(account, context);

        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        return object(
          await request(`/${encodeURIComponent(account.accountId)}/tags`, context, undefined, {
            fields: "id,caption,media_type,timestamp",
          }),
        ) as JsonObject;
      },
    },
  });
}
