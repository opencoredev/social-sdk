import { remainingBudget } from "../transport/budget.js";
import type { ManagedMediaStore } from "./media.js";
import { SocialError } from "../core/errors.js";
import type {
  AdapterOperationContext,
  CapabilityDeclaration,
  CapabilityConstraints,
  CapabilityMediaSource,
  CapabilityManifest,
  ConnectedAccountRef,
  JsonObject,
  JsonValue,
  KnownPlatform,
  MediaAttachment,
  Platform,
  PreparationIssue,
  PreparedPublishTarget,
} from "../core/types.js";
import { createHttp, HttpError, type HttpOptions } from "../transport/http.js";
import { providerErrorDecoder } from "../transport/provider-errors.js";
import { isJsonValue } from "../transport/json.js";
import { httpsUrl, upload } from "../transport/upload.js";
import { definedFields } from "../core/fields.js";
import {
  isBoolean,
  isJsonArray,
  isJsonObject,
  isString,
  object,
  string,
  type JsonField,
} from "../transport/validation.js";

/**
 * What to do with a connected account on a network Social SDK has no `KnownPlatform` for.
 * `skip` leaves it out of account listings. `include` lists it under the provider's own
 * identifier, lowercased, so it can be read and referenced. Publishing still needs a platform
 * the backend documents.
 */
export type UnknownPlatforms = "skip" | "include";

export interface ManagedOptions extends HttpOptions {
  readonly apiKey: string;
  readonly mediaStore?: ManagedMediaStore;
  readonly webhookSecret?: string;
  readonly clock?: () => Date;
  readonly uploadHostAllowed?: (hostname: string) => boolean;
  /** Defaults to `skip`, which leaves accounts on unrecognized networks out of listings. */
  readonly unknownPlatforms?: UnknownPlatforms;
}

export type ManagedProvider =
  | "zernio"
  | "post-for-me"
  | "postfast"
  | "postiz"
  | "buffer"
  | "upload-post";

const corePlatforms = [
  "x",
  "threads",
  "bluesky",
  "youtube",
  "tiktok",
  "instagram",
  "linkedin",
  "facebook",
] as const satisfies readonly KnownPlatform[];

const knownPlatformList = [
  ...corePlatforms,
  "pinterest",
  "reddit",
  "mastodon",
  "telegram",
  "discord",
  "google-business",
  "snapchat",
  "whatsapp",
  "twitch",
] as const satisfies readonly KnownPlatform[];

/**
 * Paged document types (PDF, PPT, PPTX, DOC, DOCX). LinkedIn's Documents API (checked
 * 2026-09-24, version 202609) and Upload-Post's document route (checked 2026-10-24) list
 * the same set.
 */
export const documentMimeTypes: readonly string[] = [
  "application/pdf",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

/**
 * Platforms each backend documents for publishing. Accounts on other known platforms are still
 * listed, but `prepareTarget` rejects them.
 */
export const providerPlatforms: Readonly<Record<ManagedProvider, readonly KnownPlatform[]>> = {
  zernio: [
    ...corePlatforms,
    "pinterest",
    "reddit",
    "telegram",
    "discord",
    "google-business",
    "snapchat",
  ],
  "post-for-me": [...corePlatforms, "pinterest"],
  postfast: [...corePlatforms, "pinterest", "telegram", "google-business"],
  postiz: [
    ...corePlatforms,
    "pinterest",
    "reddit",
    "mastodon",
    "telegram",
    "discord",
    "google-business",
    "twitch",
  ],
  buffer: [...corePlatforms, "pinterest", "mastodon", "google-business"],
  // Upload-Post also lists Pinterest and Reddit, but this adapter maps no board or subreddit yet.
  "upload-post": [...corePlatforms],
};

export function isKnownPlatform(value: string): value is KnownPlatform {
  return knownPlatformList.some((item) => item === value);
}

const platformAliases = new Map<string, KnownPlatform>([
  ["twitter", "x"],
  ["gmb", "google-business"],
  ["googlebusiness", "google-business"],
  ["google_business", "google-business"],
  ["google_business_profile", "google-business"],
  ["google-business-profile", "google-business"],
  ["googlebusinessprofile", "google-business"],
]);

/** Lowercase a provider's platform identifier and resolve its aliases to the SDK slug. */
export function normalizePlatform(value: string): Platform {
  const slug = value.trim().toLowerCase();

  return platformAliases.get(slug) ?? slug;
}

/**
 * Resolve a provider identifier through the backend's own table first, so a backend can name its
 * variants (`tiktok-business`). Anything else is skipped, or kept under its own name when the
 * caller opted in with `unknownPlatforms: "include"`.
 */
export function mappedPlatform(
  table: ReadonlyMap<string, Platform>,
  identifier: string,
  options: Pick<ManagedOptions, "unknownPlatforms">,
): Platform | undefined {
  const mapped = table.get(identifier);

  if (mapped !== undefined) return mapped;

  const slug = normalizePlatform(identifier);

  if (slug === "") return undefined;

  return isKnownPlatform(slug) || options.unknownPlatforms === "include" ? slug : undefined;
}

export function platform(
  value: JsonField,
  options: Pick<ManagedOptions, "unknownPlatforms"> = {},
): Platform {
  const slug = isString(value) ? normalizePlatform(value) : "";

  if (slug !== "" && (isKnownPlatform(slug) || options.unknownPlatforms === "include")) return slug;

  throw new SocialError({
    code: "unsupported_capability",
    operation: "accounts.read",
    message: "The provider returned a platform outside this adapter's selected support.",
  });
}

/** True when a provider's platform identifier names this SDK platform. */
export function samePlatform(identifier: JsonField, slug: Platform): boolean {
  return isString(identifier) && normalizePlatform(identifier) === slug;
}

/** Zernio names X "twitter" and Google Business Profile "googlebusiness". */
export function zernioPlatform(value: string): string {
  return value === "x" ? "twitter" : value === "google-business" ? "googlebusiness" : value;
}

/** `r/name`, `/r/name/` and `name` all name the same subreddit. */
export function subredditName(value: string): string {
  return value
    .trim()
    .replace(/^\/?r\//i, "")
    .replace(/\/+$/, "");
}

/** How a provider expects its server-side API key. Defaults to a bearer token. */
export type ManagedAuthHeader = (apiKey: string) => readonly [name: string, value: string];

const bearer: ManagedAuthHeader = (apiKey) => ["Authorization", `Bearer ${apiKey}`];

export function managedHttp(
  origin: string,
  options: ManagedOptions,
  authHeader: ManagedAuthHeader = bearer,
) {
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
    body?: JsonObject | FormData,
    query: Record<string, string> = {},
    method: "GET" | "POST" | "PUT" | "DELETE" = body === undefined ? "GET" : "POST",
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<JsonValue> => {
    const url = new URL(origin + path);

    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const form = body instanceof FormData;
    // Fetch sets the multipart boundary itself.
    const headers = new Headers(form ? {} : { "Content-Type": "application/json" });

    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
    headers.set(...authHeader(options.apiKey));

    // Both providers document Idempotency-Key replay protection for create requests.
    if (
      context.targetIdempotencyKey &&
      (origin.includes("zernio.com") || origin.includes("api.upload-post.com"))
    )
      headers.set("Idempotency-Key", context.targetIdempotencyKey);

    try {
      return await http({
        url,
        decodeErrorBody: providerErrorDecoder(origin, path),
        headers,
        timeoutMs: remainingBudget(context),
        method,
        ...definedFields({
          body: body === undefined || form ? body : JSON.stringify(body),
          signal: context.signal,
        }),
        maxAttempts: method === "GET" ? Math.min(5, context.retryBudget.maxAttempts) : 1,
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;

      const ambiguous =
        method !== "GET" &&
        error.dispatched &&
        (error.kind !== "http" || (error.status !== undefined && error.status >= 500));

      const providerCode = error.data?.code;
      const existingPostId = error.data?.existingPostId;

      throw new SocialError({
        code:
          providerCode === "idempotency_conflict"
            ? "idempotency_conflict"
            : providerCode === "usage-capped"
              ? "billing_required"
              : providerCode === "quotaExceeded"
                ? "rate_limited"
                : providerCode === "media-duration-exceeded"
                  ? "media_error"
                  : ambiguous
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
        ...definedFields({
          upstreamStatus: error.status,
          upstreamCode: providerCode,
          details: existingPostId === undefined ? undefined : { existingPostId },
        }),
        retryDisposition:
          providerCode === "idempotency_conflict" && existingPostId !== undefined
            ? { kind: "reconcile-first" }
            : providerCode === "idempotency_conflict" && error.retryAfterMs !== undefined
              ? { kind: "after-delay", delayMs: error.retryAfterMs }
              : providerCode === "idempotency_conflict"
                ? { kind: "reconcile-first" }
                : providerCode !== undefined
                  ? { kind: "never" }
                  : ambiguous
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

export type PublishFormats = (platform: KnownPlatform) => CapabilityDeclaration["formats"];

export const publishFormats: PublishFormats = (platform) => {
  if (platform === "youtube" || platform === "snapchat") return ["video"];

  if (platform === "instagram" || platform === "tiktok" || platform === "pinterest")
    return ["image", "video", "carousel"];

  if (platform === "twitch") return ["text"];

  return ["text", "image", "video", "carousel"];
};

const managedEligibility = [
  "A connected account returned by the managed provider is required.",
] as const;

const managedApproval = [
  "Provider account eligibility and application approval are checked by the managed provider.",
] as const;

export function managedConstraints(
  operation: string,
  mediaSources?: readonly CapabilityMediaSource[],
): CapabilityConstraints {
  const eligibility =
    operation === "accounts.read" || operation === "webhooks.verify"
      ? undefined
      : managedEligibility;

  if (mediaSources !== undefined && eligibility !== undefined)
    return { approval: managedApproval, eligibility, mediaSources };

  if (mediaSources !== undefined) return { approval: managedApproval, mediaSources };

  if (eligibility !== undefined) return { approval: managedApproval, eligibility };

  return { approval: managedApproval };
}

export type CapabilityConstraintsFor = (
  platform: KnownPlatform,
  operation: string,
) => CapabilityConstraints;

export function capabilityManifest(
  backend: ManagedProvider,
  apiRevision: string,
  operations: readonly string[],
  formats: PublishFormats = publishFormats,
  constraintsFor: CapabilityConstraintsFor = (_platform, operation) =>
    managedConstraints(operation),
  platformNotes: Partial<Record<Platform, string>> = {},
): CapabilityManifest {
  return {
    schemaVersion: 1,
    backend,
    apiRevision,
    runtime: ["node22", "node24", "bun"],
    capabilities: providerPlatforms[backend].flatMap((platform) =>
      operations.map((operation) => ({
        platform,
        operation,
        availability: "available" as const,
        surface: "normalized" as const,
        ...definedFields({
          formats: operation === "posts.publish" ? formats(platform) : undefined,
          constraints: constraintsFor(platform, operation),
        }),
        notes: [
          "Contract implementation; live account verification and provider/platform eligibility are separate.",
          platformNotes[platform],
        ]
          .filter((value): value is string => value !== undefined)
          .join(" "),
      })),
    ),
  };
}

export function optionsObject(target: PreparedPublishTarget): JsonObject {
  const options = target.options;

  if (options === undefined) return {};

  // Reject exactly as `object` does, including options with members JSON cannot represent.
  if (!isJsonValue(options))
    throw new HttpError("Upstream response must be an object.", "invalid-response", true);

  return object(options);
}

/**
 * Platforms where a provider documents publishing a reply to an existing native post.
 * Zernio: `platformSpecificData.replyToTweetId` (docs.zernio.com/twitter-engagement/search-tweets).
 * Upload-Post: `reply_to_id`, X on every upload route and Bluesky on text uploads
 * (docs.upload-post.com/openapi.json, both checked 2026-10-24).
 */
export function managedReplySupported(
  provider: ManagedProvider,
  target: Pick<PreparedPublishTarget, "account" | "content">,
): boolean {
  if (provider === "zernio") return target.account.platform === "x";

  if (provider === "upload-post")
    return (
      target.account.platform === "x" ||
      (target.account.platform === "bluesky" && (target.content.media?.length ?? 0) === 0)
    );

  return false;
}

/** Every accepted normalized option has an intentional provider mapping. */
export function managedOptionIssues(
  target: PreparedPublishTarget,
  provider: ManagedProvider,
): PreparationIssue[] {
  const config = optionsObject(target);

  const keys: Partial<Record<Platform, readonly string[]>> = {
    pinterest: provider === "postfast" ? ["boardId", "link"] : ["boardId", "title", "link"],
    reddit:
      provider === "zernio" ? ["subreddit", "title", "flairId", "nsfw"] : ["subreddit", "title"],
    discord: ["channelId"],
    snapchat: ["contentType"],
    "google-business": provider === "zernio" || provider === "postfast" ? ["locationId"] : [],
    youtube: [
      "title",
      "visibility",
      "madeForKids",
      ...(provider === "buffer" || provider === "upload-post" ? ["categoryId"] : []),
      ...(provider === "postfast" ? ["isShort"] : []),
    ],
    instagram: ["shareToFeed"],
    x: provider === "buffer" ? [] : ["replySettings"],
    linkedin: provider === "upload-post" ? ["visibility"] : [],
    tiktok:
      provider === "buffer"
        ? ["aiGenerated"]
        : [
            "privacy",
            "consentGiven",
            "disableComments",
            "disableDuet",
            "disableStitch",
            "brandedContent",
            "ownBrand",
            "aiGenerated",
            "draft",
            ...(provider === "zernio"
              ? ["photoCoverIndex", "title", "description", "mediaType", "autoAddMusic"]
              : provider === "postiz"
                ? ["title"]
                : provider === "upload-post"
                  ? ["photoCoverIndex"]
                  : []),
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
    "nsfw",
    "isShort",
  ]) {
    if (config[key] !== undefined && !isBoolean(config[key]))
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

  const text = (key: string) => {
    const value = config[key];

    return isString(value) && value.trim() !== "" ? value : undefined;
  };

  const optionalText = (key: string, code: string) => {
    if (config[key] !== undefined && text(key) === undefined)
      fail(code, `${key} must be a non-empty string when set.`);
  };

  const publicLink = (key: string, code: string) => {
    const value = text(key);

    if (value === undefined) return;

    try {
      httpsUrl(value);
    } catch {
      fail(code, `${key} must be a public HTTPS URL.`);
    }
  };

  if (target.account.platform === "pinterest") {
    const board = text("boardId");

    if (provider === "postfast" || provider === "postiz" || provider === "buffer") {
      if (board === undefined)
        fail("pinterest.board", "Select the Pinterest board by its ID before publishing.");
      else if (provider === "postiz" && !/^\d+$/.test(board))
        fail("pinterest.board", "Postiz needs the numeric Pinterest board ID, not the board name.");
    } else optionalText("boardId", "pinterest.board");

    optionalText("title", "pinterest.title");

    if ((text("title")?.length ?? 0) > 100)
      fail("pinterest.title", "Pinterest pin titles are limited to 100 characters.");
    publicLink("link", "pinterest.link");
  }

  if (target.account.platform === "reddit") {
    if (text("subreddit") === undefined)
      fail("reddit.subreddit", "Select the subreddit to post to.");

    if (provider === "postiz" && (text("title")?.length ?? 0) < 2)
      fail("reddit.title", "Postiz requires a Reddit post title of at least two characters.");
    else optionalText("title", "reddit.title");

    if ((text("title")?.length ?? 0) > 300)
      fail("reddit.title", "Reddit titles are limited to 300 characters.");
    optionalText("flairId", "reddit.flair");
  }

  if (target.account.platform === "discord" && text("channelId") === undefined)
    fail("discord.channel", "Select the Discord channel ID to post to.");

  if (target.account.platform === "google-business") {
    if (provider === "postfast" && text("locationId") === undefined)
      fail("google_business.location", "PostFast needs the Google Business Profile location ID.");
    else optionalText("locationId", "google_business.location");
  }

  if (
    target.account.platform === "snapchat" &&
    config["contentType"] !== undefined &&
    !["story", "saved_story", "spotlight"].includes(String(config["contentType"]))
  )
    fail("snapchat.content_type", "Select story, saved_story, or spotlight.");

  if (
    provider === "postiz" &&
    target.account.platform === "tiktok" &&
    config["title"] !== undefined
  ) {
    if (config["draft"] !== true)
      fail(
        "tiktok.title",
        "Postiz only keeps a TikTok title on an inbox draft; set draft to true.",
      );
    else if (
      !isString(config["title"]) ||
      config["title"].length === 0 ||
      config["title"].length > 90
    )
      fail("tiktok.title", "TikTok titles are limited to 90 characters.");
  }

  if (target.account.platform === "tiktok") {
    if (provider !== "buffer") {
      for (const key of [
        "disableComments",
        "disableDuet",
        "disableStitch",
        "brandedContent",
        "ownBrand",
        "aiGenerated",
        "draft",
      ])
        if (!isBoolean(config[key]))
          fail(
            "tiktok.explicit_choice",
            "Select every interaction, disclosure, AI-content and draft/direct-post choice before submission.",
          );

      if (config["brandedContent"] === true && config["privacy"] === "SELF_ONLY")
        fail("tiktok.branded_privacy", "TikTok branded content cannot use private visibility.");
    }

    const media = target.content.media ?? [];
    const video = media.length === 1 && media[0]?.kind === "video";

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

    if (provider === "zernio" && video) {
      if (config["title"] !== undefined)
        fail("tiktok.title", "Video captions use content.text; title is a photo-only option.");

      if (config["description"] !== undefined)
        fail("tiktok.description", "Description is a photo-only option.");

      if (config["mediaType"] !== undefined)
        fail("tiktok.media_type", "mediaType is a photo-only option.");

      if (config["autoAddMusic"] !== undefined)
        fail("tiktok.auto_add_music", "autoAddMusic is a photo-only option.");
    } else if (provider === "zernio" && media.length === 0) {
      if (config["title"] !== undefined)
        fail("tiktok.title", "Photo titles require at least one image.");

      if (config["description"] !== undefined)
        fail("tiktok.description", "Photo descriptions require at least one image.");

      if (config["mediaType"] !== undefined)
        fail("tiktok.media_type", "mediaType requires at least one image.");

      if (config["autoAddMusic"] !== undefined)
        fail("tiktok.auto_add_music", "autoAddMusic requires at least one image.");
    } else if (provider === "zernio") {
      const photoTitle = config["title"] ?? target.content.text;

      if (
        photoTitle !== undefined &&
        (!isString(photoTitle) || String(photoTitle).length === 0 || String(photoTitle).length > 90)
      )
        fail("tiktok.title", "Photo titles are limited to 90 characters.");

      const photoDescription = config["description"] ?? target.content.text;

      if (
        photoDescription !== undefined &&
        (!isString(photoDescription) || String(photoDescription).length > 4000)
      )
        fail("tiktok.description", "Photo descriptions are limited to 4000 characters.");

      if (config["mediaType"] !== undefined && config["mediaType"] !== "photo")
        fail("tiktok.media_type", 'mediaType must be "photo" when set.');

      if (config["autoAddMusic"] !== undefined && !isBoolean(config["autoAddMusic"]))
        fail("tiktok.auto_add_music", "autoAddMusic must be a boolean.");

      if (
        config["autoAddMusic"] === true &&
        (config["brandedContent"] === true || config["ownBrand"] === true)
      )
        fail(
          "tiktok.auto_add_music",
          "Branded and brand-organic photo posts cannot request automatic music.",
        );
    }
  }

  return issues;
}

export function managedPreparation(
  target: PreparedPublishTarget,
  provider: ManagedProvider,
): PreparationIssue[] {
  const issues: PreparationIssue[] = [];

  const fail = (code: string, message: string) =>
    issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

  if (!providerPlatforms[provider].some((value) => value === target.account.platform))
    fail("platform.unsupported", "This platform is outside the selected adapter coverage.");

  if (target.replyTo?.kind === "comment")
    fail(
      "reply.use_comments",
      "Use the supported comment reply operation rather than publishing a comment reply through managed post creation.",
    );
  else if (target.replyTo && !managedReplySupported(provider, target))
    fail(
      "reply.use_comments",
      "This managed provider documents no reply-to-post mapping for this destination and content. Use the comment reply operation or a backend that supports reply chains here.",
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
    // Each provider decides whether it maps documents; any document it does map is a paged type.
    if (
      item.kind === "document"
        ? !documentMimeTypes.includes(item.mimeType ?? "")
        : !item.mimeType || !item.mimeType.startsWith(`${item.kind}/`)
    )
      fail(
        "media.mime",
        "Provide the actual MIME type matching the attachment kind: image/*, video/*, or a PDF, PPT, PPTX, DOC or DOCX document where the provider accepts documents.",
      );

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

    if (!isString(options["title"]) || !options["title"])
      fail("youtube.title", "Select a YouTube title explicitly.");

    if (!["public", "unlisted", "private"].includes(String(options["visibility"])))
      fail("youtube.visibility", "Select public, unlisted, or private visibility explicitly.");

    if (!isBoolean(options["madeForKids"]))
      fail("youtube.audience", "Declare whether the video is made for kids.");
  }

  if (
    ["instagram", "tiktok", "pinterest", "snapchat"].includes(target.account.platform) &&
    media.length === 0
  )
    fail("media.required", "This destination requires image or video media.");

  if (target.account.platform === "tiktok" && provider !== "buffer") {
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
  presign: (body: JsonObject) => Promise<JsonValue>,
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
        ? { filename, contentType: mimeType, ...definedFields({ size }) }
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
      ...definedFields({ size, body: source.kind === "blob" ? source.blob : undefined }),
      open: source.kind === "blob" ? () => source.blob.stream() : source.open,
    },
    allowHost,
    maxBytes: 5 * 1024 * 1024 * 1024,
    timeoutMs: remainingBudget(config.context),
    ...definedFields({ fetch: config.options.fetch, signal: config.context.signal }),
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

export function publicFields(value: JsonField, fields: readonly string[]): JsonObject {
  const data = object(value);
  const result: Record<string, JsonValue> = {};

  for (const field of fields) {
    const value = data[field];

    if (value !== undefined && !isJsonObject(value) && !isJsonArray(value)) result[field] = value;
  }

  return result;
}
