import { defineAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import type {
  AccountRecord,
  AdapterOperationContext,
  CapabilityDeclaration,
  ConnectedAccountRef,
  DeliveryOutcome,
  DeliveryRef,
  JsonObject,
  JsonValue,
  MediaAttachment,
  Platform,
  PlatformPostRef,
  PreparationIssue,
  PreparedPublishTarget,
  ScheduleCancellation,
  ScheduledJobRef,
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
  optionalString,
  string,
  type JsonField,
} from "../transport/validation.js";
import { httpsUrl } from "../transport/upload.js";
import { decodeUploadPostWebhook, verifyUploadPostWebhook } from "../server/webhooks.js";
import {
  accountMatches,
  capabilityManifest,
  managedConstraints,
  managedHttp,
  managedOptionIssues,
  managedPreparation,
  mappedPlatform,
  optionsObject,
  type ManagedOptions,
} from "./common.js";

/*
 * Upload-Post REST API. Sources, checked 2026-10-24:
 * - OpenAPI 1.0.0: https://docs.upload-post.com/openapi.json
 * - Upload status: https://docs.upload-post.com/api/upload-status/
 * - Webhooks: https://docs.upload-post.com/api/webhooks
 * Every request selects one profile (`user`) and one platform so the core keeps
 * independent per-destination outcomes. Media travels inside the publish request:
 * Upload-Post has no separate upload endpoint that returns a reusable handle.
 */
const origin = "https://api.upload-post.com/api";

const apiRevision = "OpenAPI 1.0.0 (checked 2026-10-24)";

/** Platforms whose published posts Upload-Post can delete through /uploadposts/posts/unpublish. */
const unpublishPlatforms = ["facebook", "youtube", "x", "linkedin", "threads"] as const;

type Route = "text" | "photos" | "video" | "document";

function route(media: readonly MediaAttachment[]): Route {
  if (media.length === 0) return "text";

  if (media.some((item) => item.kind === "document")) return "document";

  // Instagram and Threads mixed carousels go through the photo route.
  if (media.length === 1 && media[0]?.kind === "video") return "video";

  return "photos";
}

/** Upload-Post keys accounts by SDK slugs; `normalizePlatform` already resolves legacy `twitter`. */
const nativePlatforms: ReadonlyMap<string, Platform> = new Map();

/** `social_accounts` values are objects, legacy strings, or null for disconnected slots. */
function connectedAccounts(
  profile: JsonObject,
  backend: string,
  options: Pick<ManagedOptions, "unknownPlatforms">,
): readonly AccountRecord[] {
  const username = string(profile["username"]);
  const social = isJsonObject(profile["social_accounts"]) ? profile["social_accounts"] : {};
  const accounts: AccountRecord[] = [];

  for (const [key, value] of Object.entries(social)) {
    const slug = mappedPlatform(nativePlatforms, key, options);

    if (value === null || value === "" || slug === undefined) continue;

    const details = isJsonObject(value) ? value : {};
    const handle = optionalString(details["handle"]) || undefined;

    accounts.push({
      ref: {
        kind: "connected-account",
        version: 1,
        backend,
        platform: slug,
        accountId: username,
      },
      displayName:
        optionalString(details["display_name"]) ||
        handle ||
        optionalString(profile["display_name"]) ||
        username,
      ...definedFields({ handle }),
      status: details["reauth_required"] === true ? "reconnect-required" : "connected",
    });
  }

  return accounts;
}

/** Upload-Post keys platform results by its own slug; accept the legacy `twitter` alias for X. */
function platformKeys(account: { readonly platform: string }): readonly string[] {
  return account.platform === "x" ? ["x", "twitter"] : [account.platform];
}

export function uploadPost(options: ManagedOptions) {
  const request = managedHttp(origin, options, (apiKey) => ["Authorization", `Apikey ${apiKey}`]);
  const now = () => (options.clock?.() ?? new Date()).toISOString();

  const delivery = (account: ConnectedAccountRef, deliveryId: string): DeliveryRef => ({
    kind: "delivery",
    version: 1,
    backend: account.backend,
    platform: account.platform,
    accountId: account.accountId,
    deliveryId,
  });

  const scheduledJob = (account: ConnectedAccountRef, jobId: string): ScheduledJobRef => ({
    kind: "scheduled-job",
    version: 1,
    backend: account.backend,
    platform: account.platform,
    accountId: account.accountId,
    jobId,
  });

  const published = (
    account: ConnectedAccountRef,
    base: { readonly targetIndex: number; readonly delivery?: DeliveryRef },
    postId: string,
    url: string | undefined,
  ): DeliveryOutcome => {
    const post: PlatformPostRef = {
      kind: "platform-post",
      version: 1,
      backend: account.backend,
      platform: account.platform,
      accountId: account.accountId,
      postId,
    };

    let link: string | undefined;

    try {
      link = url === undefined ? undefined : httpsUrl(url).href;
    } catch {
      link = undefined;
    }

    return {
      ...base,
      account,
      observedAt: now(),
      backendState: "completed",
      state: "published",
      post,
      ...definedFields({ url: link }),
    };
  };

  const resultEntry = (
    results: JsonObject,
    account: ConnectedAccountRef,
  ): JsonObject | undefined => {
    for (const key of platformKeys(account)) {
      const entry = results[key];

      if (isJsonObject(entry)) return entry;
    }

    return undefined;
  };

  /** Map one synchronous, async-accepted, or scheduled publish response. */
  const publishOutcome = (
    value: JsonValue,
    account: ConnectedAccountRef,
    targetIndex: number,
  ): DeliveryOutcome => {
    const response = object(value);
    const jobId = optionalString(response["job_id"]);
    const requestId = optionalString(response["request_id"]);

    const deliveryRef = jobId
      ? delivery(account, `job:${jobId}`)
      : requestId
        ? delivery(account, `request:${requestId}`)
        : undefined;

    const base = {
      targetIndex,
      account,
      observedAt: now(),
      ...definedFields({ delivery: deliveryRef }),
    };

    if (jobId) return { ...base, state: "scheduled", job: scheduledJob(account, jobId) };

    if (isJsonObject(response["results"])) {
      const entry = resultEntry(response["results"], account);

      if (entry === undefined)
        return {
          ...base,
          state: "unknown",
          reason: "unmapped-state",
          diagnostic: "Upload-Post returned no result for this platform.",
        };

      if (entry["success"] === false)
        return {
          ...base,
          state: "failed",
          backendState: "failed",
          code: "upstream_failure",
          message:
            "Upload-Post reports that this destination failed. Check the connected account and the provider dashboard.",
          retryDisposition: { kind: "never" },
        };

      const postId = optionalString(entry["post_id"]);

      if (entry["success"] === true && postId)
        return published(account, base, postId, optionalString(entry["url"]));

      return {
        ...base,
        state: "unknown",
        reason: "unmapped-state",
        diagnostic:
          "Upload-Post reported this destination without a native post ID. Reconcile before retrying.",
      };
    }

    if (requestId) return { ...base, state: "accepted", backendState: "async" };

    return {
      ...base,
      state: "unknown",
      reason: "unmapped-state",
      diagnostic: "Upload-Post returned neither results, a request ID, nor a job ID.",
    };
  };

  const appendMedia = (form: FormData, field: string, item: MediaAttachment): void => {
    if (item.source.kind === "https-url") form.append(field, httpsUrl(item.source.url).href);
    else if (item.source.kind === "blob")
      form.append(field, item.source.blob, item.filename ?? "upload");
    else
      throw new SocialError({
        code: "invalid_input",
        operation: "posts.publish",
        message: "Upload-Post media must be a public HTTPS URL or a Blob.",
      });
  };

  const prepareTarget = (target: PreparedPublishTarget): PreparationIssue[] => {
    const issues = [
      ...managedPreparation(target, "upload-post"),
      ...managedOptionIssues(target, "upload-post"),
    ];

    const fail = (code: string, message: string) =>
      issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

    const media = target.content.media ?? [];
    const config = optionsObject(target);
    const selected = route(media);
    const account = target.account.platform;

    for (const item of media) {
      if (item.source.kind === "stream" || item.source.kind === "media-ref")
        fail(
          "upload_post.media_source",
          "Upload-Post takes media in the publish request: use a public HTTPS URL or a Blob.",
        );

      if (item.altText !== undefined)
        fail("media.alt_text_unsupported", "Upload-Post documents no alt-text field.");

      if (item.caption !== undefined || item.thumbnail !== undefined)
        fail(
          "upload_post.media_metadata",
          "Per-attachment captions and thumbnails have no verified Upload-Post mapping.",
        );
    }

    if (selected === "document") {
      const document = media[0];

      if (account !== "linkedin" || media.length !== 1)
        fail("upload_post.document", "Upload-Post publishes one document to LinkedIn only.");

      if (document && !document.filename)
        fail(
          "upload_post.document_title",
          "Name the document with a filename; Upload-Post shows it as the title.",
        );

      // /upload_document documents no scheduled_date, so a schedule would publish immediately.
      if (target.schedule !== undefined)
        fail(
          "upload_post.document_schedule",
          "Upload-Post documents no scheduling for document posts; publish them without a schedule.",
        );
    }

    if (
      selected === "photos" &&
      media.some((item) => item.kind === "video") &&
      account !== "instagram" &&
      account !== "threads"
    )
      fail(
        "upload_post.media_mix",
        "Only Instagram and Threads accept mixed image and video carousels through Upload-Post.",
      );

    if (selected === "text" && ["instagram", "tiktok", "youtube"].includes(account))
      fail("media.required", "This destination requires media.");

    if (
      account === "linkedin" &&
      config["visibility"] === "connections" &&
      selected !== "video" &&
      selected !== "document"
    )
      fail(
        "linkedin.visibility_unsupported",
        "Upload-Post documents connections-only LinkedIn visibility for video and document posts only.",
      );

    if (account === "tiktok" && config["photoCoverIndex"] !== undefined && selected !== "photos")
      fail("tiktok.cover", "photoCoverIndex applies to photo posts.");

    return issues;
  };

  const publishTarget = async (
    target: PreparedPublishTarget,
    context: AdapterOperationContext,
  ): Promise<DeliveryOutcome> => {
    accountMatches(target.account, context);
    const media = target.content.media ?? [];
    const selected = route(media);
    const config = optionsObject(target);
    const account = target.account.platform;
    const form = new FormData();
    const text = target.content.text;

    form.set("user", target.account.accountId);
    form.append("platform[]", account);

    const set = (key: string, value: JsonField) => {
      if (isString(value)) form.set(key, value);
      else if (isBoolean(value) || isFiniteNumber(value)) form.set(key, String(value));
    };

    const [first] = media;

    if (selected === "document" && first !== undefined) {
      appendMedia(form, "document", first);
      set("title", first.filename);
      set("description", text);
    } else if (account === "youtube") {
      set("title", config["title"]);
      set("description", text);
    } else set("title", text ?? "");

    if (selected === "video" && first !== undefined) appendMedia(form, "video", first);

    if (selected === "photos") for (const item of media) appendMedia(form, "photos[]", item);

    if (target.schedule) {
      set("scheduled_date", target.schedule.at);
      set("timezone", target.schedule.timeZone);
    }

    // prepareTarget admits platform-post replies only where Upload-Post documents reply_to_id.
    if (target.replyTo?.kind === "platform-post") set("reply_to_id", target.replyTo.postId);

    if (
      account === "x" &&
      config["replySettings"] !== undefined &&
      config["replySettings"] !== "everyone"
    )
      set("reply_settings", config["replySettings"]);

    if (account === "instagram" && selected === "video")
      set("share_to_feed", config["shareToFeed"]);

    if (account === "youtube") {
      set("privacyStatus", config["visibility"]);
      set("selfDeclaredMadeForKids", config["madeForKids"]);
      set("categoryId", config["categoryId"]);
    }

    if (account === "linkedin" && (selected === "video" || selected === "document"))
      set("visibility", config["visibility"] === "connections" ? "CONNECTIONS" : "PUBLIC");
    else if (account === "linkedin" && selected === "photos" && config["visibility"] === "public")
      set("visibility", "PUBLIC");

    if (account === "tiktok") {
      set("privacy_level", config["privacy"]);
      set("post_mode", config["draft"] === true ? "MEDIA_UPLOAD" : "DIRECT_POST");
      set("disable_comment", config["disableComments"]);
      set("brand_content_toggle", config["brandedContent"]);
      set("brand_organic_toggle", config["ownBrand"]);

      if (selected === "video") {
        set("disable_duet", config["disableDuet"]);
        set("disable_stitch", config["disableStitch"]);
        set("is_aigc", config["aiGenerated"]);
      } else {
        set("is_ai_generated", config["aiGenerated"]);
        set("photo_cover_index", config["photoCoverIndex"]);
        set("auto_add_music", false);
      }
    }

    const path =
      selected === "text"
        ? "/upload_text"
        : selected === "photos"
          ? "/upload_photos"
          : selected === "video"
            ? "/upload"
            : "/upload_document";

    return publishOutcome(await request(path, context, form), target.account, target.targetIndex);
  };

  /** The status endpoint has no native IDs; upload history carries `platform_post_id`. */
  const historyPost = async (
    ref: DeliveryRef,
    id: { readonly kind: "request" | "job"; readonly value: string },
    context: AdapterOperationContext,
  ): Promise<JsonObject | undefined> => {
    const history = object(
      await request("/uploadposts/history", context, undefined, { page: "1", limit: "100" }),
    );

    return array(history["history"])
      .filter(isJsonObject)
      .find(
        (item) =>
          item[id.kind === "request" ? "request_id" : "job_id"] === id.value &&
          item["profile_username"] === ref.accountId &&
          platformKeys(ref).includes(String(item["platform"])) &&
          item["success"] === true &&
          isString(item["platform_post_id"]) &&
          item["platform_post_id"].length > 0,
      );
  };

  const getDelivery = async (
    ref: DeliveryRef,
    context: AdapterOperationContext,
  ): Promise<DeliveryOutcome> => {
    const account: ConnectedAccountRef = {
      kind: "connected-account",
      version: 1,
      backend: ref.backend,
      platform: ref.platform,
      accountId: ref.accountId,
    };

    accountMatches(account, context);
    const separator = ref.deliveryId.indexOf(":");
    const kind = ref.deliveryId.slice(0, separator);
    const value = ref.deliveryId.slice(separator + 1);

    if ((kind !== "request" && kind !== "job") || !value)
      throw new SocialError({
        code: "invalid_input",
        operation: "posts.getDelivery",
        message: "Use a delivery reference returned by this Upload-Post adapter.",
      });

    const status = object(
      await request("/uploadposts/status", context, undefined, {
        [kind === "request" ? "request_id" : "job_id"]: value,
      }),
    );

    const overall = optionalString(status["status"]) ?? "unknown";

    const base = {
      targetIndex: 0,
      account,
      observedAt: now(),
      delivery: { ...ref, kind: "delivery" as const, version: 1 as const },
      backendState: overall,
    };

    const entry = (isJsonArray(status["results"]) ? array(status["results"]) : [])
      .filter(isJsonObject)
      .find((item) => platformKeys(account).includes(String(item["platform"])));

    const entryState = optionalString(entry?.["status"]);
    const running = ["pending", "queued", "processing", "in_progress"].includes(overall);

    if (entry === undefined) {
      if (kind === "job" && overall === "pending")
        return { ...base, state: "scheduled", job: scheduledJob(account, value) };

      if (running) return { ...base, state: "processing" };

      if (overall === "failed")
        return {
          ...base,
          state: "failed",
          code: "upstream_failure",
          message: "Upload-Post reports that the upload failed.",
          retryDisposition: { kind: "never" },
        };

      return {
        ...base,
        state: "unknown",
        reason: "unmapped-state",
        diagnostic: "Upload-Post returned no result for this platform.",
      };
    }

    if (
      entryState === "skipped" ||
      entry["skipped"] === true ||
      entryState === "failed" ||
      entry["success"] === false
    )
      return {
        ...base,
        backendState: entryState ?? overall,
        state: "failed",
        code: "upstream_failure",
        message:
          entryState === "skipped" || entry["skipped"] === true
            ? "Upload-Post skipped this platform because the profile has no configured account for it."
            : "Upload-Post reports that this destination failed.",
        retryDisposition: { kind: "never" },
      };

    // An in-progress upload reports queued platforms with `success: true`.
    const completed =
      entryState === "completed" || (entryState === undefined && overall === "completed");

    if (!completed || entry["success"] !== true)
      return { ...base, backendState: entryState ?? overall, state: "processing" };

    const record = await historyPost(ref, { kind, value }, context);

    if (record !== undefined)
      return published(
        account,
        base,
        string(record["platform_post_id"]),
        optionalString(record["post_url"]),
      );

    return {
      ...base,
      state: "unknown",
      reason: "unmapped-state",
      diagnostic:
        "Upload-Post reports completion, but the latest upload history has no native post ID for it.",
    };
  };

  const cancelScheduled = async (
    ref: ScheduledJobRef,
    context: AdapterOperationContext,
  ): Promise<ScheduleCancellation> => {
    accountMatches(ref, context);
    const path = `/uploadposts/schedule/${encodeURIComponent(ref.jobId)}`;
    const job = object(await request(path, context));
    const platforms = isJsonArray(job["platforms"]) ? array(job["platforms"]) : [];

    if (
      job["profile_username"] !== ref.accountId ||
      platforms.length !== 1 ||
      !platformKeys(ref).includes(String(platforms[0]))
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "posts.cancelScheduled",
        message: "The scheduled job does not belong to exactly this profile and platform.",
      });

    const result = await request(path, context, undefined, {}, "DELETE");

    if (!isJsonObject(result) || result["success"] !== true)
      throw new SocialError({
        code: "ambiguous_outcome",
        operation: "posts.cancelScheduled",
        message: "Upload-Post did not confirm the cancellation. Reconcile before retrying.",
        retryDisposition: { kind: "reconcile-first" },
      });

    // Upload-Post documents that cancellation deletes the job and its assets.
    return { state: "cancelled", backendRecord: "deleted" };
  };

  const removeFromPlatform = async (
    ref: PlatformPostRef,
    context: AdapterOperationContext,
  ): Promise<void> => {
    accountMatches(ref, context);

    if (!unpublishPlatforms.some((item) => item === ref.platform))
      throw new SocialError({
        code: "unsupported_capability",
        operation: "posts.removeFromPlatform",
        message:
          "Upload-Post deletes published posts on Facebook, YouTube, X, LinkedIn and Threads only.",
      });

    const result = await request("/uploadposts/posts/unpublish", context, {
      platform: ref.platform,
      user: ref.accountId,
      post_id: ref.postId,
    });

    if (!isJsonObject(result) || result["success"] !== true)
      throw new SocialError({
        code: "ambiguous_outcome",
        operation: "posts.removeFromPlatform",
        message: "Upload-Post did not confirm the deletion. Reconcile before retrying.",
        retryDisposition: { kind: "reconcile-first" },
      });
  };

  const notes: Partial<Record<Platform, string>> = {
    facebook:
      "Page-scoped. Upload-Post selects the Page automatically only when the profile has one connected Page.",
    x: "Upload-Post strips URLs from X posts unless the account enables its link add-on. Replies use reply_to_id.",
    bluesky:
      "Text replies use reply_to_id; Upload-Post documents no reply field for Bluesky media posts.",
    linkedin:
      "Document posts accept one PDF, PPT, PPTX, DOC or DOCX. Video and document posts default to PUBLIC visibility.",
  };

  const manifest = capabilityManifest(
    "upload-post",
    apiRevision,
    [
      "accounts.read",
      "posts.publish",
      "posts.schedule",
      "posts.status",
      "posts.cancelScheduled",
      "webhooks.verify",
    ],
    (selected) =>
      selected === "youtube"
        ? ["video"]
        : selected === "instagram" || selected === "tiktok"
          ? ["image", "video", "carousel"]
          : selected === "linkedin"
            ? ["text", "image", "video", "carousel", "document"]
            : ["text", "image", "video", "carousel"],
    (_platform, operation) =>
      operation === "posts.publish"
        ? managedConstraints(operation, ["https-url", "blob"])
        : managedConstraints(operation),
    notes,
  );

  const extra: CapabilityDeclaration[] = [
    ...unpublishPlatforms.map((item) => ({
      platform: item,
      operation: "posts.removeFromPlatform",
      availability: "available" as const,
      surface: "normalized" as const,
    })),
    {
      platform: "*",
      operation: "media.upload",
      availability: "unsupported-by-platform",
      notes:
        "Upload-Post has no standalone upload that returns a reusable handle. Pass a public HTTPS URL or a Blob to posts.publish.",
    },
  ];

  return defineAdapter({
    id: "upload-post",
    capabilities: { ...manifest, capabilities: [...manifest.capabilities, ...extra] },
    accounts: {
      async list(input: { cursor?: string; limit?: number }, context: AdapterOperationContext) {
        const offset = input.cursor === undefined ? 0 : Number(input.cursor);
        const limit = input.limit ?? 25;

        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "accounts.read",
            message: "Use an opaque returned cursor and a page size from 1 to 100.",
          });

        // Upload-Post returns every profile at once; page locally over the flattened accounts.
        const result = object(await request("/uploadposts/users", context));

        const accounts = array(result["profiles"])
          .filter(isJsonObject)
          .flatMap((profile) => connectedAccounts(profile, context.backendInstance, options));

        const next = offset + limit < accounts.length ? String(offset + limit) : undefined;

        return {
          items: accounts.slice(offset, offset + limit),
          ...definedFields({ nextCursor: next }),
        };
      },
      async get(ref: ConnectedAccountRef, context: AdapterOperationContext) {
        accountMatches(ref, context);

        const result = object(
          await request(`/uploadposts/users/${encodeURIComponent(ref.accountId)}`, context),
        );

        const found = connectedAccounts(
          object(result["profile"]),
          context.backendInstance,
          options,
        ).find(
          (item) => item.ref.accountId === ref.accountId && item.ref.platform === ref.platform,
        );

        if (!found)
          throw new SocialError({
            code: "not_found",
            operation: "accounts.read",
            message: "The Upload-Post profile has no connected account for this platform.",
          });

        return found;
      },
    },
    posts: { prepareTarget, publishTarget, getDelivery, cancelScheduled, removeFromPlatform },
    webhooks: {
      async verify(input: { headers: Headers; body: Uint8Array }) {
        await verifyUploadPostWebhook({
          ...input,
          secret: options.webhookSecret ?? "",
          ...definedFields({ now: options.clock }),
        });

        return { valid: true, method: "hmac" as const };
      },
      async decode(
        input: { headers: Headers; body: Uint8Array },
        context: AdapterOperationContext,
      ): Promise<JsonObject> {
        return {
          ...(await decodeUploadPostWebhook({
            backend: context.backendInstance,
            body: input.body,
            receivedAt: now(),
          })),
        };
      },
    },
  });
}
