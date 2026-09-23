import { remainingBudget } from "../transport/budget.js";
import type { ManagedMediaStore } from "./media.js";
import { SocialError } from "../core/errors.js";
import type {
  AdapterOperationContext,
  CapabilityManifest,
  ConnectedAccountRef,
  JsonObject,
  JsonValue,
  MediaAttachment,
  Platform,
  PreparationIssue,
  PreparedPublishTarget,
} from "../core/types.js";
import { createHttp, HttpError, type HttpOptions } from "../transport/http.js";
import { httpsUrl, upload } from "../transport/upload.js";
import { object, string } from "../transport/validation.js";

export interface ManagedOptions extends HttpOptions {
  readonly apiKey: string;
  readonly mediaStore?: ManagedMediaStore;
  readonly webhookSecret?: string;
  readonly clock?: () => Date;
  readonly uploadHostAllowed?: (hostname: string) => boolean;
}

export const selectedPlatforms = [
  "x",
  "threads",
  "bluesky",
  "youtube",
  "tiktok",
  "instagram",
  "linkedin",
  "facebook",
] as const;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- provider payload is validated at this adapter boundary.
export function platform(value: unknown): Platform {
  const slug = value === "twitter" ? "x" : value;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
  if (typeof slug !== "string" || !selectedPlatforms.some((item) => item === slug))
    throw new SocialError({
      code: "unsupported_capability",
      operation: "accounts.read",
      message: "The provider returned a platform outside this adapter's selected support.",
    });

  return slug;
}

export function managedHttp(origin: string, options: ManagedOptions) {
  if (!options.apiKey.trim())
    throw new SocialError({
      code: "invalid_config",
      operation: "createAdapter",
      message: "Configure the selected provider's server-side API key.",
    });
  const http = createHttp(options);

  return async (
    path: string,
    context: AdapterOperationContext,
    body?: JsonObject,
    query: Record<string, string> = {},
    method: "GET" | "POST" | "PUT" | "DELETE" = body === undefined ? "GET" : "POST",
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- provider payload is validated at this adapter boundary.
  ): Promise<unknown> => {
    const url = new URL(origin + path);

    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const headers = new Headers({
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    });

    if (context.targetIdempotencyKey && origin.includes("zernio.com"))
      headers.set(
        path === "/v1/posts" ? "x-request-id" : "Idempotency-Key",
        context.targetIdempotencyKey,
      );

    try {
      return await http({
        url,
        headers,
        timeoutMs: remainingBudget(context),
        method,
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
        ...(context.signal ? { signal: context.signal } : {}),
        maxAttempts: method === "GET" ? Math.min(5, context.retryBudget.maxAttempts) : 1,
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      const ambiguous =
        method !== "GET" &&
        error.dispatched &&
        (error.kind !== "http" || (error.status !== undefined && error.status >= 500));

      throw new SocialError({
        code: ambiguous
          ? "ambiguous_outcome"
          : error.status === 429
            ? "rate_limited"
            : error.kind === "cancelled"
              ? "cancelled"
              : error.kind === "timeout"
                ? "timeout"
                : error.status === 401
                  ? "reconnect_required"
                  : error.status === 403
                    ? "missing_permission"
                    : error.status === 402
                      ? "billing_required"
                      : error.status === 404
                        ? "not_found"
                        : error.status === 410
                          ? "gone"
                          : error.kind === "invalid-input"
                            ? "invalid_input"
                            : "upstream_failure",
        operation: path,
        backend: context.backendInstance,
        correlationId: context.correlationId,
        message: error.message,
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
        ...(error.status === undefined ? {} : { upstreamStatus: error.status }),
        retryDisposition: ambiguous
          ? { kind: "reconcile-first" }
          : error.status === 401
            ? { kind: "after-reconnect" }
            : error.status === 429 && error.retryAfterMs !== undefined
              ? { kind: "after-delay", delayMs: error.retryAfterMs }
              : { kind: "never" },
      });
    }
  };
}

export function capabilityManifest(
  backend: string,
  apiRevision: string,
  operations: readonly string[],
): CapabilityManifest {
  return {
    schemaVersion: 1,
    backend,
    apiRevision,
    runtime: ["node22", "node24", "bun"],
    capabilities: selectedPlatforms.flatMap((platform) =>
      operations.map((operation) => ({
        platform,
        operation,
        availability: "available" as const,
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
        ...(operation === "posts.publish"
          ? {
              // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
              formats: (platform === "youtube"
                ? ["video"]
                : platform === "instagram" || platform === "tiktok"
                  ? ["image", "video", "carousel"]
                  : ["text", "image", "video", "carousel"]) as (
                | "text"
                | "image"
                | "video"
                | "carousel"
              )[],
            }
          : {}),
        notes:
          "Contract implementation; live account verification and provider/platform eligibility are separate.",
      })),
    ),
  };
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- provider payload is validated at this adapter boundary.
export function optionsObject(target: PreparedPublishTarget): Record<string, unknown> {
  return target.options === undefined ? {} : object(target.options);
}

/** Every accepted normalized option has an intentional provider mapping. */
export function managedOptionIssues(
  target: PreparedPublishTarget,
  provider: "zernio" | "post-for-me",
): PreparationIssue[] {
  const config = optionsObject(target);

  // oxlint-disable-next-line anti-slop/no-known-value-widening -- provider payload is validated at this adapter boundary.
  const keys: Record<string, readonly string[]> = {
    youtube: ["title", "visibility", "madeForKids"],
    instagram: ["shareToFeed"],
    x: ["replySettings"],
    tiktok: [
      "privacy",
      "consentGiven",
      "disableComments",
      "disableDuet",
      "disableStitch",
      "brandedContent",
      "ownBrand",
      "aiGenerated",
      "draft",
      ...(provider === "zernio" ? ["photoCoverIndex"] : []),
    ],
  };

  const issues: PreparationIssue[] = [];

  const fail = (code: string, message: string) =>
    issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

  if (Object.keys(config).some((key) => !keys[target.account.platform]?.includes(key)))
    fail(
      "options.unmapped",
      "A supplied platform option has no verified mapping in this managed adapter.",
    );

  for (const key of [
    "shareToFeed",
    "madeForKids",
    "consentGiven",
    "disableComments",
    "disableDuet",
    "disableStitch",
    "brandedContent",
    "ownBrand",
    "aiGenerated",
    "draft",
  ]) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
    if (config[key] !== undefined && typeof config[key] !== "boolean")
      fail(
        "options.boolean",
        "Consent, audience, interaction and disclosure choices must be booleans.",
      );
  }

  if (
    config["replySettings"] !== undefined &&
    !["everyone", "following", "mentionedUsers"].includes(String(config["replySettings"]))
  )
    fail("x.reply_settings", "Select a supported reply setting explicitly.");

  if (target.account.platform === "tiktok") {
    for (const key of [
      "disableComments",
      "disableDuet",
      "disableStitch",
      "brandedContent",
      "ownBrand",
      "aiGenerated",
      "draft",
    ])
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
      if (typeof config[key] !== "boolean")
        fail(
          "tiktok.explicit_choice",
          "Select every interaction, disclosure, AI-content and draft/direct-post choice before submission.",
        );

    if (config["brandedContent"] === true && config["privacy"] === "SELF_ONLY")
      fail("tiktok.branded_privacy", "TikTok branded content cannot use private visibility.");
    const media = target.content.media ?? [];

    if (
      media.some((item) => item.kind === "video") &&
      (media.length !== 1 || media[0]?.kind !== "video")
    )
      fail("tiktok.media_mix", "Select one video or an image-only photo post.");

    if (media.length > 35)
      fail("tiktok.media_count", "TikTok photo posts support at most 35 images.");

    if (
      config["photoCoverIndex"] !== undefined &&
      (!Number.isInteger(config["photoCoverIndex"]) ||
        Number(config["photoCoverIndex"]) < 0 ||
        Number(config["photoCoverIndex"]) >= media.length ||
        media.some((item) => item.kind !== "image"))
    )
      fail("tiktok.cover", "Choose an existing photo index for the cover.");
  }

  return issues;
}

export function managedPreparation(target: PreparedPublishTarget): PreparationIssue[] {
  const issues: PreparationIssue[] = [];

  const fail = (code: string, message: string) =>
    issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

  if (!selectedPlatforms.some((value) => value === target.account.platform))
    fail("platform.unsupported", "This platform is outside the selected adapter coverage.");

  if (target.replyTo)
    fail(
      "reply.use_comments",
      "Use the supported comment reply operation rather than publishing a reply through managed post creation.",
    );
  const media = target.content.media ?? [];

  if (!target.content.text && media.length === 0)
    fail("content.empty", "Text or media is required.");

  if (target.content.link)
    fail(
      "link.explicit_text",
      "Include the link in text; this adapter does not silently discard structured link metadata.",
    );

  for (const item of media) {
    if (!item.mimeType || !item.mimeType.startsWith(`${item.kind}/`))
      fail("media.mime", "Provide the actual image/video MIME type matching the attachment kind.");

    if (item.source.kind === "https-url") {
      try {
        httpsUrl(item.source.url);
      } catch {
        fail(
          "media.url",
          "Provide a public HTTPS media URL without local hosts, credentials, or a custom port.",
        );
      }
    } else if (item.source.kind === "media-ref") {
      const ref = item.source.ref;

      if (
        ref.backend !== target.account.backend ||
        ref.accountId !== target.account.accountId ||
        ref.platform !== target.account.platform
      )
        fail("media.handle_scope", "Media reference belongs to another account or backend.");
    } else if (!item.filename) fail("media.filename", "Uploadable bytes require a filename.");
  }

  if (target.account.platform === "youtube") {
    const options = optionsObject(target);

    if (media.length !== 1 || media[0]?.kind !== "video")
      fail("youtube.video", "YouTube requires exactly one video.");

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
    if (typeof options["title"] !== "string" || !options["title"])
      fail("youtube.title", "Select a YouTube title explicitly.");

    if (!["public", "unlisted", "private"].includes(String(options["visibility"])))
      fail("youtube.visibility", "Select public, unlisted, or private visibility explicitly.");

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
    if (typeof options["madeForKids"] !== "boolean")
      fail("youtube.audience", "Declare whether the video is made for kids.");
  }

  if (["instagram", "tiktok"].includes(target.account.platform) && media.length === 0)
    fail("media.required", "This destination requires image or video media.");

  if (target.account.platform === "tiktok") {
    const options = optionsObject(target);

    if (options["consentGiven"] !== true)
      fail("tiktok.consent", "Obtain creator consent after preview and before uploading.");

    if (
      !["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "PUBLIC_TO_EVERYONE"].includes(
        String(options["privacy"]),
      )
    )
      fail("tiktok.privacy", "Select a privacy level offered by the current creator information.");
  }

  return issues;
}

export async function uploadManagedMedia(
  item: MediaAttachment,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- provider payload is validated at this adapter boundary.
  presign: (body: JsonObject) => Promise<unknown>,
  config: {
    options: ManagedOptions;
    provider: "zernio" | "post-for-me";
    context: AdapterOperationContext;
  },
): Promise<string> {
  if (item.source.kind === "https-url") return httpsUrl(item.source.url).href;

  if (item.source.kind === "media-ref")
    throw new SocialError({
      code: "media_error",
      operation: "media.upload",
      message: "Unvalidated media references cannot cross account/backend boundaries.",
    });
  const mimeType = string(item.mimeType);
  const filename = string(item.filename);
  const source = item.source;
  const size = item.byteSize ?? (source.kind === "blob" ? source.blob.size : undefined);

  const data = object(
    await presign(
      config.provider === "zernio"
        ? // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
          { filename, contentType: mimeType, ...(size === undefined ? {} : { size }) }
        : {},
    ),
  );

  const uploadUrl = string(data[config.provider === "zernio" ? "uploadUrl" : "upload_url"]);
  const publicUrl = string(data[config.provider === "zernio" ? "publicUrl" : "media_url"]);

  const allowHost =
    config.options.uploadHostAllowed ??
    (config.provider === "zernio"
      ? (host: string) => host.endsWith(".r2.cloudflarestorage.com")
      : (host: string) => host.endsWith(".supabase.co"));

  await upload({
    url: uploadUrl,
    source: {
      mimeType,
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
      ...(size === undefined ? {} : { size }),
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Blob bodies preserve known-size uploads for presigned storage.
      ...(source.kind === "blob" ? { body: source.blob } : {}),
      open: source.kind === "blob" ? () => source.blob.stream() : source.open,
    },
    allowHost,
    maxBytes: 5 * 1024 * 1024 * 1024,
    timeoutMs: remainingBudget(config.context),
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
    ...(config.options.fetch ? { fetch: config.options.fetch } : {}),
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- provider payload is validated at this adapter boundary.
    ...(config.context.signal ? { signal: config.context.signal } : {}),
  });

  return httpsUrl(publicUrl).href;
}

export function accountMatches(
  ref: Pick<ConnectedAccountRef, "backend" | "platform" | "accountId">,
  context: AdapterOperationContext,
): void {
  if (ref.backend !== context.backendInstance)
    throw new SocialError({
      code: "unauthorized",
      operation: "accounts.read",
      message: "Account reference belongs to another backend instance.",
    });
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- provider payload is validated at this adapter boundary.
export function publicFields(value: unknown, fields: readonly string[]): JsonObject {
  const data = object(value);
  const result: Record<string, JsonValue> = {};

  for (const field of fields) {
    const value = data[field];

    if (
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
      typeof value === "string" ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
      typeof value === "boolean" ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider payload is validated at this adapter boundary.
      typeof value === "number" ||
      value === null
    )
      result[field] = value;
  }

  return result;
}
