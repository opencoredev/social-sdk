import { normalizeMetrics } from "../core/projections.js";
import { managedRawRequest, rawRequestCapability } from "../core/raw-request.js";
import { MemoryManagedMediaStore, storedMedia, type ManagedMediaRecord } from "./media.js";

export {
  MemoryManagedMediaStore,
  type ManagedMediaStore,
  type ManagedMediaRecord,
} from "./media.js";

import { defineAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import type {
  AccountRecord,
  AdapterOperationContext,
  BackendPostRef,
  CapabilityManifest,
  ConnectedAccountRef,
  DeliveryOutcome,
  DeliveryRef,
  JsonObject,
  JsonValue,
  MediaAttachment,
  MediaInput,
  MediaRef,
  MetricValue,
  Platform,
  PlatformPostRef,
  PreparationIssue,
  PreparedPublishTarget,
  PublishContent,
  ScheduleCancellation,
  ScheduledJobRef,
} from "../core/types.js";
import { definedFields } from "../core/fields.js";
import { HttpError } from "../transport/http.js";
import { remainingBudget } from "../transport/budget.js";
import { httpsUrl, upload } from "../transport/upload.js";
import {
  array,
  isBoolean,
  isJsonObject,
  isString,
  number,
  object,
  optionalNumber,
  optionalString,
  string,
  type JsonField,
} from "../transport/validation.js";
import {
  accountMatches,
  capabilityManifest,
  documentMimeTypes,
  acknowledged,
  managedHttp,
  managedConstraints,
  managedOptionIssues,
  managedPreparation,
  optionsObject,
  publicFields,
  linkedinDocumentFormats,
  mappedPlatform,
  providerPlatforms,
  type ManagedOptions,
} from "./common.js";
import {
  assignDefined,
  objectList,
  optionReader,
  topicTag,
  type OptionReader,
} from "./option-checks.js";

export interface PostFastConnectLinkOptions {
  /** PostFast platform values such as `X` or `INSTAGRAM`. Omit to offer every platform. */
  platforms?: readonly string[];
  /** Days until the link expires. PostFast defaults to 7. */
  expiryDays?: number;
  redirectUrl?: string;
  /** Your own identifier for the person connecting accounts. */
  externalId?: string;
}

const nativePlatforms = new Map<string, Platform>([
  ["X", "x"],
  ["THREADS", "threads"],
  ["BLUESKY", "bluesky"],
  ["YOUTUBE", "youtube"],
  ["TIKTOK", "tiktok"],
  ["INSTAGRAM", "instagram"],
  ["LINKEDIN", "linkedin"],
  ["FACEBOOK", "facebook"],
  ["PINTEREST", "pinterest"],
  ["TELEGRAM", "telegram"],
  ["GOOGLE_BUSINESS_PROFILE", "google-business"],
]);

const mimeTypes = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/mov",
  "video/quicktime",
] as const;

const maxBytes = {
  image: 10 * 1024 * 1024,
  video: 250 * 1024 * 1024,
  document: 60 * 1024 * 1024,
  caption: 10 * 1024 * 1024,
} as const;

/** Social Inbox conversation triage state. */
export type PostFastInboxStatus = "OPEN" | "SNOOZED" | "CLOSED";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How a post reaches PostFast: scheduled, saved as a draft, or held for approval. */
export type PostFastSubmission =
  | { readonly kind: "schedule" }
  | { readonly kind: "draft" }
  | { readonly kind: "approval" };

/** Option keys PostFast maps beyond the shared managed set (postfa.st/docs.md, 2026-11-04). */
const postfastOptionKeys: Partial<Record<Platform, readonly string[]>> = {
  x: ["repostUrl", "firstComment"],
  threads: ["topicTag", "firstComment"],
  youtube: [
    "tags",
    "playlistId",
    "containsSyntheticMedia",
    "firstComment",
    "language",
    "captionKey",
  ],
  tiktok: ["title", "autoAddMusic", "musicSoundId", "coverTimestampMs", "firstComment"],
  instagram: [
    "placement",
    "collaborators",
    "locationId",
    "aiGenerated",
    "trialReel",
    "thumbOffsetMs",
    "firstComment",
  ],
  facebook: [
    "reel",
    "story",
    "collaborators",
    "locationId",
    "geoRestriction",
    "carouselCards",
    "carouselLink",
    "carouselEndCard",
    "firstComment",
  ],
  linkedin: ["documentTitle"],
  "google-business": [
    "topicType",
    "callToActionType",
    "callToActionUrl",
    "eventTitle",
    "eventStart",
    "eventEnd",
    "offerCouponCode",
    "offerRedeemUrl",
    "offerTerms",
  ],
};

interface PostFastCard {
  readonly link: string;
  readonly name?: string;
  readonly description?: string;
}

interface PostFastTargetData {
  readonly issues: readonly PreparationIssue[];
  readonly controls: Readonly<Record<string, JsonValue>>;
  readonly firstComment?: string;
  readonly coverTimestamp?: number;
  readonly cards?: readonly PostFastCard[];
}

/** The MIME type of a JPEG or PNG cover given as a typed Blob. */
function thumbnailMime(input: MediaInput): string | undefined {
  return input.kind === "blob" &&
    (input.blob.type === "image/jpeg" || input.blob.type === "image/png")
    ? input.blob.type
    : undefined;
}

/** Decode the PostFast options of one target into `controls` and per-post fields. */
function postfastData(target: PreparedPublishTarget): PostFastTargetData {
  const reader = optionReader(target, optionsObject(target));
  const { fail } = reader;
  const controls: Record<string, JsonValue> = {};
  const media = target.content.media ?? [];
  const singleVideo = media.length === 1 && media[0]?.kind === "video";
  const platform = target.account.platform;
  let coverTimestamp: number | undefined;
  let cards: readonly PostFastCard[] | undefined;

  const firstCommentLimit = new Map<string, number>([
    ["x", 25_000],
    ["threads", 500],
    ["youtube", 10_000],
    ["tiktok", 1_200],
    ["instagram", 2_200],
    ["facebook", 8_000],
  ]).get(platform);

  const firstComment =
    firstCommentLimit === undefined
      ? undefined
      : reader.text("firstComment", "options.first_comment", firstCommentLimit);

  if (platform === "x")
    assignDefined(controls, { xRetweetUrl: reader.url("repostUrl", "x.repost") });

  if (platform === "threads") assignDefined(controls, { threadsTopicTag: topicTag(reader) });

  if (platform === "youtube") {
    const tags = reader.texts("tags", "youtube.tags", { max: 500, length: 100 });

    if (tags && tags.join("").length > 500)
      fail("youtube.tags", "YouTube tags are limited to 500 characters combined.");

    const language = reader.text("language", "youtube.language", 35);
    const captionKey = reader.text("captionKey", "youtube.captions", 128);

    if (language !== undefined && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(language))
      fail("youtube.language", "language must be a BCP-47 code such as en or pt-BR.");

    if (
      captionKey !== undefined &&
      (!/^file\/[0-9a-f-]+\.(srt|vtt)$/.test(captionKey) || language === undefined)
    )
      fail("youtube.captions", "captionKey must come from uploadCaptions and needs a language.");

    assignDefined(controls, {
      youtubeTags: tags?.slice(),
      youtubePlaylistId: reader.text("playlistId", "youtube.playlist", 64),
      youtubeContainsSyntheticMedia: reader.flag(
        "containsSyntheticMedia",
        "youtube.synthetic_media",
      ),
      youtubeLanguage: language,
      youtubeCaptionKey: captionKey,
    });
  }

  if (platform === "tiktok") {
    const photo = media.length > 0 && media.every((item) => item.kind === "image");
    const title = reader.text("title", "tiktok.title", 90);
    const autoAddMusic = reader.flag("autoAddMusic", "tiktok.auto_add_music");
    const sound = reader.text("musicSoundId", "tiktok.music", 128);

    if (autoAddMusic !== undefined && !photo)
      fail("tiktok.auto_add_music", "autoAddMusic applies to TikTok photo posts.");

    if (sound !== undefined && autoAddMusic === true)
      fail("tiktok.music", "Choose either musicSoundId or autoAddMusic.");

    if (sound !== undefined && reader.config["draft"] === true)
      fail("tiktok.music", "PostFast does not apply music to drafts.");

    coverTimestamp = reader.integer("coverTimestampMs", "tiktok.cover", 0, 36_000_000);

    if (coverTimestamp !== undefined && !singleVideo)
      fail("tiktok.cover", "coverTimestampMs applies to a single video.");

    assignDefined(controls, {
      tiktokTitle: title,
      tiktokAutoAddMusic: autoAddMusic,
      tiktokMusicSoundId: sound,
    });
  }

  if (platform === "instagram") {
    const placement = reader.config["placement"];

    if (
      placement !== undefined &&
      placement !== "feed" &&
      placement !== "story" &&
      placement !== "reels"
    )
      fail("instagram.placement", "placement must be feed, story or reels.");

    if (placement === "reels" && !singleVideo)
      fail("instagram.placement", "A Reel needs exactly one video.");

    const trialReel = reader.config["trialReel"];

    if (trialReel !== undefined && trialReel !== "performance")
      fail(
        "instagram.trial_reel",
        "PostFast documents only performance-based trial Reels (SS_PERFORMANCE).",
      );

    if (trialReel !== undefined && placement !== "reels")
      fail("instagram.trial_reel", "A trial Reel needs placement reels.");

    const locationId = reader.text("locationId", "instagram.location", 32);

    if (locationId !== undefined && media.length > 1)
      fail(
        "instagram.location",
        "PostFast tags a location on a single image, video, Reel or Story only.",
      );

    coverTimestamp = reader.integer("thumbOffsetMs", "instagram.thumb_offset", 0, 36_000_000);

    if (coverTimestamp !== undefined && !singleVideo)
      fail("instagram.thumb_offset", "thumbOffsetMs applies to a single video.");

    assignDefined(controls, {
      instagramPublishType:
        placement === "story"
          ? "STORY"
          : placement === "reels"
            ? "REEL"
            : placement === "feed"
              ? "TIMELINE"
              : undefined,
      instagramCollaborators: reader
        .texts("collaborators", "instagram.collaborators", { max: 3, length: 30 })
        ?.slice(),
      instagramLocationId: locationId,
      instagramIsAiGenerated: reader.flag("aiGenerated", "instagram.ai_generated"),
      instagramTrialReelStrategy: trialReel === "performance" ? "SS_PERFORMANCE" : undefined,
    });
  }

  if (platform === "facebook") {
    const reel = reader.flag("reel", "facebook.reel");
    const story = reader.flag("story", "facebook.story");

    if (reel && story) fail("facebook.placement", "Choose either reel or story.");

    if (reel && !singleVideo) fail("facebook.reel", "A Facebook Reel needs exactly one video.");

    const collaborators = reader.texts("collaborators", "facebook.collaborators", {
      max: 10,
      length: 64,
    });

    if (collaborators && !reel) fail("facebook.collaborators", "Collaborators apply to a Reel.");

    const geo = reader.countries("geoRestriction", "facebook.geo_restriction");
    const placeId = reader.text("locationId", "facebook.location", 32);

    if ((geo || placeId) && (reel || story))
      fail("facebook.feed_options", "Places and target countries apply to feed posts only.");

    cards = objectList(
      reader,
      "carouselCards",
      "facebook.carousel",
      { min: 2, max: 10 },
      (entry) => {
        const { link, name, description } = entry;

        if (!isString(link)) return undefined;

        if (name !== undefined && (!isString(name) || name.length > 255)) return undefined;

        if (description !== undefined && (!isString(description) || description.length > 255))
          return undefined;

        try {
          return {
            link: httpsUrl(link).href,
            ...definedFields({
              name: isString(name) ? name : undefined,
              description: isString(description) ? description : undefined,
            }),
          };
        } catch {
          return undefined;
        }
      },
      "carouselCards lists 2 to 10 cards with a public HTTPS link and optional name and description.",
    );

    const mainLink = reader.url("carouselLink", "facebook.carousel");

    if (
      cards &&
      (reel ||
        story ||
        cards.length !== media.length ||
        media.some((item) => item.kind !== "image"))
    )
      fail(
        "facebook.carousel",
        "A link carousel has one card per image and no other media or placement.",
      );

    if (mainLink !== undefined && !cards)
      fail("facebook.carousel", "carouselLink needs carouselCards.");

    const endCard = reader.flag("carouselEndCard", "facebook.carousel");

    if (endCard !== undefined && !cards)
      fail("facebook.carousel", "carouselEndCard needs carouselCards.");

    assignDefined(controls, {
      facebookContentType: reel ? "REEL" : story ? "STORY" : undefined,
      facebookReelsCollaborators: collaborators?.slice(),
      facebookPlaceId: placeId,
      facebookTargetCountries: geo?.slice(),
      facebookCarouselMainLink: cards ? (mainLink ?? cards[0]?.link) : undefined,
      facebookCarouselShowEndCard: cards ? endCard : undefined,
    });
  }

  if (platform === "linkedin") {
    const title = reader.text("documentTitle", "linkedin.document_title", 400);

    if (title !== undefined && media[0]?.kind !== "document")
      fail("linkedin.document_title", "documentTitle needs one document attachment.");

    assignDefined(controls, { linkedinAttachmentTitle: title });
  }

  if (platform === "google-business") gbpControls(reader, controls, media.length);

  return {
    issues: reader.issues,
    controls,
    ...definedFields({ firstComment, coverTimestamp, cards }),
  };
}

const gbpCallToActions = ["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"];

/** Google Business Profile topic, call to action, event and offer controls. */
function gbpControls(
  reader: OptionReader,
  controls: Record<string, JsonValue>,
  mediaCount: number,
): void {
  const { fail } = reader;
  const topic = reader.config["topicType"];

  if (topic !== undefined && topic !== "STANDARD" && topic !== "EVENT" && topic !== "OFFER")
    fail("google_business.topic", "topicType must be STANDARD, EVENT or OFFER.");

  const action = reader.config["callToActionType"];

  if (action !== undefined && !gbpCallToActions.includes(String(action)))
    fail(
      "google_business.call_to_action",
      `callToActionType must be one of ${gbpCallToActions.join(", ")}.`,
    );

  const eventTitle = reader.text("eventTitle", "google_business.event", 58);
  const start = reader.text("eventStart", "google_business.event", 40);
  const end = reader.text("eventEnd", "google_business.event", 40);

  for (const value of [start, end])
    if (value !== undefined && !Number.isFinite(Date.parse(value)))
      fail("google_business.event", "eventStart and eventEnd are ISO 8601 times.");

  if ((topic === "EVENT" || topic === "OFFER") && (start === undefined || end === undefined))
    fail("google_business.event", "EVENT and OFFER posts need eventStart and eventEnd.");

  if (topic === "EVENT" && eventTitle === undefined)
    fail("google_business.event", "An EVENT post needs an eventTitle.");

  if (mediaCount > 1)
    fail("google_business.media", "Google Business Profile posts take one image.");

  assignDefined(controls, {
    gbpTopicType: isString(topic) ? topic : undefined,
    gbpCallToActionType: isString(action) ? action : undefined,
    gbpCallToActionUrl: reader.url("callToActionUrl", "google_business.call_to_action"),
    gbpEventTitle: eventTitle,
    gbpEventStartDate: start,
    gbpEventEndDate: end,
    gbpOfferCouponCode: reader.text("offerCouponCode", "google_business.offer", 58),
    gbpOfferRedeemUrl: reader.url("offerRedeemUrl", "google_business.offer"),
    gbpOfferTerms: reader.text("offerTerms", "google_business.offer", 5000),
  });
}

const reject = (operation: string, message: string): never => {
  throw new SocialError({ code: "invalid_input", operation, message });
};

/** A PostFast record ID as it comes back in an answer: a non-empty string without whitespace. */
function isPostFastId(value: JsonField): value is string {
  return isString(value) && value !== "" && value.length <= 256 && !/\s/.test(value);
}

/** The response did not show the requested inbox change; the write may or may not have landed. */
const unconfirmed = (change: string): never => {
  throw new SocialError({
    code: "ambiguous_outcome",
    operation: "comments.write",
    message: `PostFast did not confirm the conversation ${change}. Reconcile before retrying.`,
    retryDisposition: { kind: "reconcile-first" },
  });
};

/** Signed bigint strings such as `-123`, kept only when a JS number holds them exactly. */
function signedCount(value: JsonField): number | undefined {
  const parsed = isString(value) && /^-?\d+$/.test(value) ? Number(value) : optionalNumber(value);

  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** A Social Inbox item without author IDs beyond the username. */
function inboxItem(value: JsonValue): JsonObject {
  return publicFields(value, [
    "id",
    "conversationId",
    "direction",
    "externalItemId",
    "parentExternalItemId",
    "authorUsername",
    "text",
    "state",
    "deliveryStatus",
    "platformCreatedAt",
    "canPrivateReply",
  ]);
}

/**
 * The OUTBOUND item a reply route answers with. The reply was dispatched, so a body without
 * the item's ID, its direction or a known delivery status cannot confirm it. `PENDING` stays
 * pending.
 */
function sentInboxItem(value: JsonValue, change: string): JsonObject {
  const delivery = isJsonObject(value) ? value["deliveryStatus"] : undefined;

  if (
    !isJsonObject(value) ||
    !isPostFastId(value["id"]) ||
    value["direction"] !== "OUTBOUND" ||
    !(
      delivery === undefined ||
      delivery === null ||
      delivery === "PENDING" ||
      delivery === "SENT" ||
      delivery === "FAILED"
    )
  )
    unconfirmed(change);

  return inboxItem(value);
}

/** A Social Inbox conversation without contact IDs, avatars or post previews. */
function inboxConversation(value: JsonValue): JsonObject {
  return publicFields(value, [
    "id",
    "platform",
    "externalPostId",
    "socialPostId",
    "status",
    "assignedToUserId",
    "unreadCount",
    "lastItemAt",
    "lastItemPreview",
    "participantUsername",
    "participantDisplayName",
    "canReply",
    "maxReplyLength",
    "maxPrivateReplyLengthBytes",
    "disabledReason",
  ]);
}

/** PostFast returns counters as bigint strings. Keep only values a JS number holds exactly. */
function count(value: JsonField): number | undefined {
  const parsed = isString(value) && /^\d+$/.test(value) ? Number(value) : optionalNumber(value);

  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * PostFast managed backend. PostFast only schedules posts, so every target needs a
 * future `schedule.at`. Media is uploaded to PostFast storage and referenced by key.
 */
export function postfast(options: ManagedOptions) {
  const request = managedHttp("https://api.postfa.st", options, (apiKey) => ["pf-api-key", apiKey]);

  const store = options.mediaStore ?? new MemoryManagedMediaStore();
  const clock = () => options.clock?.() ?? new Date();
  const now = () => clock().toISOString();

  const allowHost =
    options.uploadHostAllowed ??
    ((host: string) =>
      host === "s3.amazonaws.com" ||
      (host.startsWith("postfast-uploads.s3.") && host.endsWith(".amazonaws.com")));

  const account = (value: JsonValue, backend: string): AccountRecord | undefined => {
    const row = object(value);
    const slug = mappedPlatform(nativePlatforms, string(row["platform"]), options);

    if (!slug) return undefined;
    const handle = optionalString(row["platformUsername"]);
    const disabledReason = optionalString(row["disabledReason"]);

    return {
      ref: {
        kind: "connected-account",
        version: 1,
        backend,
        platform: slug,
        accountId: string(row["id"]),
      },
      displayName: optionalString(row["displayName"]) || handle || string(row["id"]),
      ...definedFields({ handle: handle || undefined }),
      status:
        row["connectionStatus"] === "CONNECTED"
          ? "connected"
          : row["connectionStatus"] === "DISABLED"
            ? "reconnect-required"
            : "unknown",
      ...definedFields({ native: disabledReason ? { disabledReason } : undefined }),
    };
  };

  const accounts = async (context: AdapterOperationContext): Promise<AccountRecord[]> =>
    array(await request("/social-media/my-social-accounts", context)).flatMap((value) => {
      const parsed = account(value, context.backendInstance);

      return parsed ? [parsed] : [];
    });

  /** Read one post record and prove it belongs to the referenced account. */
  const record = async (
    id: string,
    ref: Pick<ConnectedAccountRef, "backend" | "platform" | "accountId">,
    context: AdapterOperationContext,
    operation: string,
  ): Promise<JsonObject> => {
    accountMatches(ref, context);

    if (!id) reject(operation, "A PostFast post identifier is required.");

    const result = object(
      await request("/social-posts", context, undefined, { ids: id, limit: "1" }),
    );

    const row = array(result["data"])
      .map(object)
      .find((item) => item["id"] === id);

    if (!row)
      throw new SocialError({
        code: "not_found",
        operation,
        message: "PostFast has no post with this identifier in the workspace.",
      });

    if (row["socialMediaId"] !== ref.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation,
        message: "The PostFast post does not belong to the authorized account.",
      });

    return row;
  };

  const outcome = (
    row: JsonObject,
    target: ConnectedAccountRef,
    targetIndex: number,
  ): DeliveryOutcome => {
    const id = string(row["id"]);
    const status = optionalString(row["status"]) ?? "unknown";

    const delivery: DeliveryRef = {
      kind: "delivery",
      version: 1,
      backend: target.backend,
      platform: target.platform,
      accountId: target.accountId,
      deliveryId: id,
    };

    const base = {
      targetIndex,
      account: target,
      delivery,
      backendState: status,
      observedAt: now(),
    };

    switch (status) {
      case "SCHEDULED":
        if (row["approvalStatus"] === "PENDING_APPROVAL")
          return { ...base, backendState: "SCHEDULED/PENDING_APPROVAL", state: "accepted" };

        return {
          ...base,
          state: "scheduled",
          job: {
            kind: "scheduled-job",
            version: 1,
            backend: target.backend,
            platform: target.platform,
            accountId: target.accountId,
            jobId: id,
          },
        };
      case "PUBLISHED": {
        const postId = optionalString(row["platformPostId"]);

        if (!postId)
          return {
            ...base,
            state: "unknown",
            reason: "unmapped-state",
            diagnostic: "PostFast reports publication without a native post identifier.",
          };

        return {
          ...base,
          state: "published",
          post: {
            kind: "platform-post",
            version: 1,
            backend: target.backend,
            platform: target.platform,
            accountId: target.accountId,
            postId,
            native: { backendRecordId: id },
          },
        };
      }

      case "DRAFT":
        return { ...base, state: "accepted" };
      case "FAILED":
        return {
          ...base,
          state: "failed",
          code: "upstream_failure",
          message:
            "PostFast reports that this post failed. Inspect the account connection and the post in PostFast.",
          retryDisposition: { kind: "never" },
        };
      default:
        return {
          ...base,
          state: "unknown",
          reason: "unmapped-state",
          diagnostic: "PostFast returned a post status this adapter does not map.",
        };
    }
  };

  /** Upload bytes to PostFast storage and return the storage key. */
  const uploadBytes = async (
    item: MediaAttachment,
    context: AdapterOperationContext,
  ): Promise<string> => {
    const source = item.source;

    if (source.kind === "https-url" || source.kind === "media-ref")
      return reject("media.upload", "Only uploadable bytes can be sent to PostFast storage.");
    const mimeType = string(item.mimeType);

    if (
      item.kind === "document"
        ? !documentMimeTypes.includes(mimeType)
        : !mimeTypes.some((value) => value === mimeType)
    )
      reject("media.upload", "PostFast does not accept this media type.");
    const size = item.byteSize ?? (source.kind === "blob" ? source.blob.size : undefined);

    if (size !== undefined && size > maxBytes[item.kind])
      throw new SocialError({
        code: "media_error",
        operation: "media.upload",
        message:
          "PostFast accepts images up to 10 MB, videos up to 250 MB and documents up to 60 MB.",
      });

    const signed = array(
      await request("/file/get-signed-upload-urls", context, { contentType: mimeType, count: 1 }),
    );

    if (signed.length !== 1)
      throw new SocialError({
        code: "upstream_failure",
        operation: "media.upload",
        message: "PostFast returned an unexpected number of upload URLs.",
      });
    const entry = object(signed[0]);
    const key = string(entry["key"]);

    await upload({
      url: string(entry["signedUrl"]),
      source: {
        mimeType,
        ...definedFields({ size, body: source.kind === "blob" ? source.blob : undefined }),
        open: source.kind === "blob" ? () => source.blob.stream() : source.open,
      },
      allowHost,
      maxBytes: maxBytes[item.kind],
      timeoutMs: remainingBudget(context),
      ...definedFields({ fetch: options.fetch, signal: context.signal }),
    });

    return key;
  };

  const mediaKey = async (
    item: MediaAttachment,
    target: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<string> => {
    if (item.source.kind !== "media-ref") return uploadBytes(item, context);
    const stored = await storedMedia(item, item.source.ref, target, store, options);

    if (!stored.providerKey)
      throw new SocialError({
        code: "media_error",
        operation: "media.resolve",
        message: "This media reference was not uploaded to PostFast storage.",
      });

    return stored.providerKey;
  };

  /** Local checks for one target under one submission mode. Performs no I/O. */
  const prepareIssues = (
    target: PreparedPublishTarget,
    submission: PostFastSubmission,
  ): PreparationIssue[] => {
    const data = postfastData(target);

    // An X repost is sent with empty content (controls.xRetweetUrl).
    const repost =
      target.account.platform === "x" && optionsObject(target)["repostUrl"] !== undefined;

    const issues: PreparationIssue[] = [
      ...managedPreparation(target, "postfast").filter(
        (issue) => !repost || issue.code !== "content.empty",
      ),
      ...managedOptionIssues(target, "postfast", postfastOptionKeys),
      ...data.issues,
    ];

    const fail = (code: string, message: string, severity: "error" | "warning" = "error") =>
      issues.push({ code, message, severity, targetIndex: target.targetIndex });

    const at = target.schedule?.at;

    // A draft may be saved without a time; every other post is scheduled.
    if (!at) {
      if (submission.kind !== "draft")
        fail(
          "schedule.required",
          "PostFast only schedules posts. Set a future schedule time for this target.",
        );
    } else if (!(Date.parse(at) > clock().getTime()))
      fail("schedule.past", "PostFast requires a schedule time in the future.");
    else if (Date.parse(at) > clock().getTime() + 365 * 86400_000)
      fail("schedule.horizon", "PostFast requires a schedule within one year.");

    const media = target.content.media ?? [];

    for (const item of media) {
      if (item.source.kind === "https-url")
        fail(
          "media.url_unsupported",
          "PostFast accepts uploaded files only. Pass the bytes or a PostFast media reference.",
        );

      if (item.kind === "document") {
        if (target.account.platform !== "linkedin" || media.length !== 1)
          fail(
            "media.document_unsupported",
            "PostFast publishes one document alone, to LinkedIn only.",
          );

        if (item.source.kind === "media-ref")
          fail(
            "media.document_ref",
            "Pass the document bytes; PostFast document keys are not stored.",
          );

        const size =
          item.byteSize ?? (item.source.kind === "blob" ? item.source.blob.size : undefined);

        if (size !== undefined && size > maxBytes.document)
          fail("media.too_large", "PostFast accepts documents up to 60 MB.");

        continue;
      }

      if (item.mimeType && !mimeTypes.some((value) => value === item.mimeType))
        fail("media.mime_unsupported", "PostFast does not accept this media type.");

      const size =
        item.byteSize ?? (item.source.kind === "blob" ? item.source.blob.size : undefined);

      if (size !== undefined && size > maxBytes[item.kind])
        fail("media.too_large", "PostFast accepts images up to 10 MB and videos up to 250 MB.");

      if (item.altText !== undefined)
        fail(
          "media.alt_text_unsupported",
          "PostFast's post schema does not document alt text. Choose a backend with an explicit accessibility mapping.",
        );

      if (item.thumbnail !== undefined && (item.kind !== "video" || !thumbnailMime(item.thumbnail)))
        fail(
          "media.thumbnail",
          "PostFast takes a video cover as JPEG or PNG bytes (a Blob with its type set).",
        );
    }

    // PostFast's Bluesky guide (October 2026) documents one MP4 video up to 100 MB.
    if (target.account.platform === "bluesky" && media.some((item) => item.kind === "video")) {
      const video = media[0];

      const size =
        video?.byteSize ?? (video?.source.kind === "blob" ? video.source.blob.size : undefined);

      if (
        media.length !== 1 ||
        video?.mimeType !== "video/mp4" ||
        (size !== undefined && size > 100 * 1024 * 1024)
      )
        fail(
          "bluesky.video",
          "PostFast posts one MP4 video up to 100 MB to Bluesky, with no images.",
        );
    }

    const config = optionsObject(target);

    if (
      target.account.platform === "x" &&
      config["replySettings"] !== undefined &&
      config["replySettings"] !== "everyone"
    )
      fail("x.reply_settings_unsupported", "PostFast does not document X reply settings.");

    if (target.account.platform === "tiktok" && config["draft"] !== true) {
      if (config["privacy"] !== "PUBLIC_TO_EVERYONE")
        fail(
          "tiktok.privacy_unsupported",
          "PostFast direct TikTok posts do not honor private settings. Only explicit draft mode avoids direct publication.",
        );
      else
        fail(
          "tiktok.privacy_account_default",
          "PostFast TikTok videos use account-default privacy and photos default public. The deprecated privacy control does not override these settings.",
          "warning",
        );
    }

    return issues;
  };

  /** Create one PostFast post: scheduled, saved as a draft or held for approval. */
  const createPost = async (
    target: PreparedPublishTarget,
    context: AdapterOperationContext,
    submission: PostFastSubmission,
  ): Promise<DeliveryOutcome> => {
    accountMatches(target.account, context);
    const at = target.schedule?.at;

    if (prepareIssues(target, submission).some((issue) => issue.severity === "error"))
      reject("posts.publish", "The post failed preparation; call prepare to list the issues.");

    const config = optionsObject(target);
    const data = postfastData(target);
    const controls = { ...data.controls };
    const mediaItems: JsonObject[] = [];

    for (const [index, item] of (target.content.media ?? []).entries()) {
      if (item.kind === "document") {
        controls["linkedinAttachmentKey"] = await uploadBytes(item, context);
        continue;
      }

      const card = data.cards?.[index];
      const thumbnail = item.thumbnail;

      const thumbnailKey =
        thumbnail === undefined ? undefined : await uploadThumbnail(thumbnail, context);

      if (thumbnailKey !== undefined && target.account.platform === "youtube")
        controls["youtubeThumbnailKey"] = thumbnailKey;

      mediaItems.push({
        key: await mediaKey(item, target.account, context),
        type: item.kind === "video" ? "VIDEO" : "IMAGE",
        sortOrder: index,
        ...definedFields({
          coverImageKey: target.account.platform === "youtube" ? undefined : thumbnailKey,
          coverTimestamp:
            item.kind === "video" && data.coverTimestamp !== undefined
              ? String(data.coverTimestamp)
              : undefined,
          mediaLink: card?.link,
          mediaCaption: card?.name,
          mediaDescription: card?.description,
        }),
      });
    }

    if (target.account.platform === "youtube") {
      controls["youtubeTitle"] = string(config["title"]);
      controls["youtubeIsShort"] = config["isShort"] === true;
      controls["youtubePrivacy"] = string(config["visibility"]).toUpperCase();

      const madeForKids = config["madeForKids"];

      if (isBoolean(madeForKids)) controls["youtubeMadeForKids"] = madeForKids;
    }

    if (target.account.platform === "pinterest") {
      controls["pinterestBoardId"] = string(config["boardId"]);

      const link = optionalString(config["link"]);

      if (link !== undefined) controls["pinterestLink"] = link;
    }

    if (target.account.platform === "google-business")
      controls["gbpLocationId"] = string(config["locationId"]);

    if (target.account.platform === "instagram" && isBoolean(config["shareToFeed"]))
      controls["instagramPostToGrid"] = config["shareToFeed"];

    if (target.account.platform === "tiktok") {
      // prepareTarget requires every one of these choices to be a boolean.
      for (const [nativeKey, optionKey, negate] of [
        ["tiktokAllowComments", "disableComments", true],
        ["tiktokAllowDuet", "disableDuet", true],
        ["tiktokAllowStitch", "disableStitch", true],
        ["tiktokBrandOrganic", "ownBrand", false],
        ["tiktokBrandContent", "brandedContent", false],
        ["tiktokIsAigc", "aiGenerated", false],
        ["tiktokIsDraft", "draft", false],
      ] as const) {
        const value = config[optionKey];

        if (isBoolean(value)) controls[nativeKey] = negate ? !value : value;
      }
    }

    // Media uploads can outlast a near schedule, and PostFast rejects a past time.
    if (at !== undefined && !(Date.parse(at) > clock().getTime()))
      reject("posts.publish", "The schedule time passed while media uploaded.");

    const ids = await acknowledged(
      "posts.publish",
      request("/social-posts", context, {
        posts: [
          {
            content: target.content.text ?? "",
            socialMediaId: target.account.accountId,
            ...definedFields({
              scheduledAt: at === undefined ? undefined : new Date(at).toISOString(),
              mediaItems: mediaItems.length ? mediaItems : undefined,
              firstComment: data.firstComment,
            }),
          },
        ],
        status: submission.kind === "draft" ? "DRAFT" : "SCHEDULED",
        ...definedFields({
          approvalStatus: submission.kind === "approval" ? "PENDING_APPROVAL" : undefined,
          controls: Object.keys(controls).length ? controls : undefined,
        }),
      }),
      (reply) => array(object(reply)["postIds"]),
    );

    const first = ids[0];
    const id = ids.length === 1 && isPostFastId(first) ? first : undefined;

    if (!id)
      return {
        state: "unknown",
        reason: "ambiguous-submission",
        diagnostic: "PostFast did not return exactly one post identifier.",
        targetIndex: target.targetIndex,
        account: target.account,
        observedAt: now(),
      };

    try {
      return outcome(
        await record(id, target.account, context, "posts.publish"),
        target.account,
        target.targetIndex,
      );
    } catch (error) {
      // A post was written, so an ownership mismatch stays an uncertain write instead of an error.
      if (error instanceof SocialError && error.code === "unauthorized")
        return {
          state: "unknown",
          reason: "ambiguous-submission",
          diagnostic: "PostFast returned a post that does not belong to the requested account.",
          targetIndex: target.targetIndex,
          account: target.account,
          observedAt: now(),
        };

      // Keep the created post visible even if the follow-up read fails.
      return {
        state: "accepted",
        targetIndex: target.targetIndex,
        account: target.account,
        delivery: {
          kind: "delivery",
          version: 1,
          backend: target.account.backend,
          platform: target.account.platform,
          accountId: target.account.accountId,
          deliveryId: id,
        },
        observedAt: now(),
      };
    }
  };

  /** Upload a JPEG or PNG cover and return its PostFast key. */
  const uploadThumbnail = async (
    thumbnail: MediaInput,
    context: AdapterOperationContext,
  ): Promise<string> => {
    const mimeType = thumbnailMime(thumbnail);

    if (mimeType === undefined)
      return reject("media.upload", "PostFast takes a video cover as JPEG or PNG bytes.");

    return uploadBytes({ kind: "image", source: thumbnail, mimeType, filename: "cover" }, context);
  };

  const withPostFastRawRequest = (manifest: CapabilityManifest): CapabilityManifest => ({
    ...manifest,
    capabilities: [...manifest.capabilities, rawRequestCapability("*", "api.postfa.st")],
  });

  const adapter = defineAdapter({
    id: "postfast",
    capabilities: withPostFastRawRequest(
      capabilityManifest(
        "postfast",
        "REST API, docs fetched 2026-09-24",
        [
          "accounts.read",
          "posts.publish",
          "posts.schedule",
          "posts.status",
          "posts.list",
          "posts.cancelScheduled",
          "posts.deleteBackendRecord",
          "analytics.read",
          "analytics.account.read",
          "media.upload",
        ],
        linkedinDocumentFormats,
        (_platform, operation) =>
          managedConstraints(
            operation,
            operation === "posts.publish" ? ["media-ref", "blob", "stream"] : undefined,
          ),
        {
          facebook:
            "PostFast's Facebook integration is Page-scoped; personal profiles are not supported.",
        },
      ),
    ),
    media: {
      async upload(
        item: MediaAttachment,
        target: ConnectedAccountRef,
        context: AdapterOperationContext,
      ): Promise<MediaRef> {
        accountMatches(target, context);

        if (item.kind === "document")
          throw new SocialError({
            code: "unsupported_capability",
            operation: "media.upload",
            message: "PostFast accepts image and video media only through this adapter.",
          });

        if (item.source.kind === "media-ref") {
          await mediaKey(item, target, context);

          return item.source.ref;
        }

        if (!item.mimeType) reject("media.upload", "Provide the asset MIME type.");
        const key = await uploadBytes(item, context);

        const ref: MediaRef = {
          kind: "media",
          version: 1,
          backend: target.backend,
          platform: target.platform,
          accountId: target.accountId,
          mediaId: crypto.randomUUID(),
        };

        // PostFast references uploads by key. The URL without its signature is kept for
        // inspection only and never grants access.
        const stored: ManagedMediaRecord = {
          ref,
          publicUrl: `https://s3.amazonaws.com/postfast-uploads/${key}`,
          providerKey: key,
          kind: item.kind,
          mimeType: string(item.mimeType),
        };

        await store.put(stored);

        return ref;
      },
    },
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
          reject("accounts.read", "Use an opaque returned cursor and a page size from 1 to 100.");

        // PostFast returns every account in one response; page locally.
        const all = await accounts(context);
        const next = offset + limit < all.length ? String(offset + limit) : undefined;

        return {
          items: all.slice(offset, offset + limit),
          ...definedFields({ nextCursor: next }),
        };
      },
      async get(ref: ConnectedAccountRef, context: AdapterOperationContext) {
        accountMatches(ref, context);

        const found = (await accounts(context)).find(
          (item) => item.ref.accountId === ref.accountId && item.ref.platform === ref.platform,
        );

        if (!found)
          throw new SocialError({
            code: "not_found",
            operation: "accounts.read",
            message: "PostFast has no connected account matching this reference.",
          });

        return found;
      },
    },
    posts: {
      prepareTarget(target: PreparedPublishTarget) {
        return prepareIssues(target, { kind: "schedule" });
      },
      async publishTarget(
        target: PreparedPublishTarget,
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        return createPost(target, context, { kind: "schedule" });
      },
      /**
       * Posts of one account, newest schedule last, including posts PostFast imported from the
       * last 60 days on Facebook, Instagram, Threads and TikTok.
       */
      async list(
        account: ConnectedAccountRef,
        input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        accountMatches(account, context);
        const page = input.cursor === undefined ? 0 : Number(input.cursor);
        const limit = input.limit ?? 20;

        if (
          !Number.isSafeInteger(page) ||
          page < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 50
        )
          reject("posts.list", "Use a returned cursor and a page size from 1 to 50.");

        const result = object(
          await request("/social-posts", context, undefined, {
            socialMediaIds: account.accountId,
            page: String(page),
            limit: String(limit),
          }),
        );

        const pageInfo = isJsonObject(result["pageInfo"]) ? result["pageInfo"] : {};

        return {
          items: array(result["data"])
            .map(object)
            .filter((row) => row["socialMediaId"] === account.accountId)
            .map((row) => ({
              ...publicFields(row, [
                "id",
                "content",
                "status",
                "scheduledAt",
                "publishedAt",
                "platformPostId",
                "approvalStatus",
                "firstComment",
              ]),
            })),
          ...definedFields({
            nextCursor: pageInfo["hasNextPage"] === true ? String(page + 1) : undefined,
          }),
        };
      },
      async getDelivery(
        ref: { deliveryId: string; accountId: string; platform: string; backend: string },
        context: AdapterOperationContext,
      ) {
        const slug = providerPlatforms.postfast.find((value) => value === ref.platform);

        if (!slug) return reject("posts.status", "This platform is outside PostFast coverage.");

        const target: ConnectedAccountRef = {
          kind: "connected-account",
          version: 1,
          backend: ref.backend,
          platform: slug,
          accountId: ref.accountId,
        };

        return outcome(await record(ref.deliveryId, target, context, "posts.status"), target, 0);
      },
      async cancelScheduled(
        ref: ScheduledJobRef,
        context: AdapterOperationContext,
      ): Promise<ScheduleCancellation> {
        const row = await record(ref.jobId, ref, context, "posts.cancelScheduled");
        const scheduledAt = optionalString(row["scheduledAt"]);

        if (
          row["status"] !== "SCHEDULED" ||
          !scheduledAt ||
          !(Date.parse(scheduledAt) > clock().getTime())
        )
          reject(
            "posts.cancelScheduled",
            "Only a future scheduled post can be cancelled. Reconcile a due or dispatched post.",
          );

        await remove(ref.jobId, context);

        return { state: "cancelled", backendRecord: "deleted" };
      },
      async deleteBackendRecord(ref: BackendPostRef, context: AdapterOperationContext) {
        const row = await record(ref.recordId, ref, context, "posts.deleteBackendRecord");

        if (row["status"] !== "FAILED")
          reject(
            "posts.deleteBackendRecord",
            "PostFast deletes failed records here. Cancel a future schedule explicitly; this never removes a published post.",
          );

        await remove(ref.recordId, context);
      },
    },
    analytics: {
      async getPostMetrics(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        const id = optionalString(ref.native?.["backendRecordId"]);

        if (!id)
          reject(
            "analytics.read",
            "PostFast metrics need the post reference returned by publish or status reads.",
          );
        const row = await record(string(id), ref, context, "analytics.read");
        const publishedAt = optionalString(row["publishedAt"]);

        if (row["platformPostId"] !== ref.postId || !publishedAt || !Date.parse(publishedAt))
          reject("analytics.read", "The PostFast record does not identify this published post.");

        const published = Date.parse(string(publishedAt));
        const day = 24 * 60 * 60 * 1000;

        const result = object(
          await request("/social-posts/analytics", context, undefined, {
            startDate: new Date(published - day).toISOString(),
            endDate: new Date(published + day).toISOString(),
            socialMediaIds: ref.accountId,
          }),
        );

        const match = array(result["data"])
          .map(object)
          .find(
            (item) =>
              item["id"] === id &&
              item["platformPostId"] === ref.postId &&
              item["socialMediaId"] === ref.accountId,
          );

        if (!match || match["latestMetric"] === null || match["latestMetric"] === undefined)
          return [];
        const metrics = object(match["latestMetric"]);
        const values: MetricValue[] = [];

        const push = (name: string, value: number | undefined, unit: MetricValue["unit"]) => {
          if (value === undefined) return;
          values.push({
            name,
            value,
            unit,
            period: "lifetime",
            fetchedAt: now(),
            freshness: "unknown",
            source: `postfast:${ref.platform}:analytics`,
          });
        };

        for (const [name, key] of [
          ["likes", "likes"],
          ["comments", "comments"],
          ["shares", "shares"],
          ["impressions", "impressions"],
          ["reach", "reach"],
          ["interactions", "totalInteractions"],
          ["views", "videoViews"],
        ] as const)
          push(name, count(metrics[key]), "count");

        push("averageWatchTime", optionalNumber(metrics["avgWatchTimeSeconds"]), "seconds");
        push("totalWatchTime", optionalNumber(metrics["totalWatchTimeSeconds"]), "seconds");
        push("saveRate", optionalNumber(metrics["saveRate"]), "percentage");
        // Instagram Reels only: the share of viewers who skipped in the first three seconds.
        push("reelsSkipRate", optionalNumber(metrics["reelsSkipRate"]), "percentage");

        const extras = isJsonObject(metrics["extras"]) ? metrics["extras"] : {};

        push("favorites", count(extras["favorites"]), "count");

        return normalizeMetrics(values);
      },
      /** The daily follower or subscriber count PostFast stores on the account. */
      async getAccountMetrics(
        ref: ConnectedAccountRef,
        context: AdapterOperationContext,
      ): Promise<readonly MetricValue[]> {
        accountMatches(ref, context);

        const row = array(await request("/social-media/my-social-accounts", context))
          .map(object)
          .find((item) => item["id"] === ref.accountId);

        if (
          !row ||
          mappedPlatform(nativePlatforms, string(row["platform"]), options) !== ref.platform
        )
          throw new SocialError({
            code: "not_found",
            operation: "analytics.account.read",
            message: "PostFast has no connected account matching this reference.",
          });

        const followers = count(row["followerCount"]);

        if (followers === undefined) return [];

        const measuredAt = optionalString(row["followerCountUpdatedAt"]);

        return normalizeMetrics([
          {
            name: "followers",
            value: followers,
            unit: "count",
            period: "lifetime",
            ...(measuredAt
              ? { measuredAt, freshness: "reported" as const }
              : { freshness: "unknown" as const }),
            fetchedAt: now(),
            source: `postfast:${ref.platform}:account`,
          },
        ]);
      },
    },
    native: {
      /**
       * Sends one request to a PostFast API path the SDK does not wrap, with the `pf-api-key` header. Host `api` is `https://api.postfa.st`.
       * The key is workspace-scoped, so the SDK cannot check which accounts the path touches.
       * Raw requests never retry or reconcile; the caller owns any write it sends.
       */
      request: managedRawRequest("https://api.postfa.st", options, (apiKey) => [
        "pf-api-key",
        apiKey,
      ]),
      /** Create a hosted link where someone connects their social accounts to your workspace. */
      async createConnectLink(input: PostFastConnectLinkOptions, context: AdapterOperationContext) {
        for (const value of input.platforms ?? [])
          if (!nativePlatforms.has(value))
            reject("accounts.connect", "Choose PostFast platforms this adapter supports.");

        if (input.redirectUrl !== undefined) httpsUrl(input.redirectUrl);

        return acknowledged(
          "accounts.connect",
          request("/social-media/connect-link", context, {
            ...definedFields({
              platforms: input.platforms ? [...input.platforms] : undefined,
              expiryDays: input.expiryDays,
              redirectUrl: input.redirectUrl || undefined,
              externalId: input.externalId || undefined,
            }),
          }),
          (reply) => ({ url: httpsUrl(string(object(reply)["connectUrl"])).href }),
        );
      },
      /**
       * Save a draft (`status: DRAFT`, schedule optional) or hold a scheduled post for approval
       * (`approvalStatus: PENDING_APPROVAL`). Same options and checks as `posts.publish`.
       */
      async submitPost(
        input: {
          readonly account: ConnectedAccountRef;
          readonly content: PublishContent;
          readonly options?: JsonObject;
          readonly schedule?: { readonly at: string };
          readonly submission: Exclude<PostFastSubmission, { readonly kind: "schedule" }>;
        },
        context: AdapterOperationContext,
      ) {
        return createPost(
          {
            targetIndex: 0,
            targetKey: "native",
            account: input.account,
            content: input.content,
            ...definedFields({ options: input.options, schedule: input.schedule }),
          },
          context,
          input.submission,
        );
      },
      /** Delete up to 100 posts at once from PostFast (POST /social-posts/bulk-delete). */
      async bulkDelete(
        input: { readonly ids: readonly string[] },
        context: AdapterOperationContext,
      ) {
        if (input.ids.length < 1 || input.ids.length > 100)
          reject("posts.deleteBackendRecord", "Delete 1 to 100 posts per bulk call.");

        return acknowledged(
          "posts.deleteBackendRecord",
          request("/social-posts/bulk-delete", context, { ids: [...input.ids] }),
          (reply) => {
            const result = object(reply);
            const requested = new Set(input.ids);

            // Every listed ID must be one this call asked to delete; anything else is unreadable.
            const listed = (value: JsonField): string[] =>
              array(value).map((id) => {
                if (!isString(id) || !requested.has(id))
                  throw new HttpError(
                    "PostFast listed a post this call did not delete.",
                    "invalid-response",
                    true,
                  );

                return id;
              });

            return {
              deletedIds: listed(result["deletedIds"]),
              notFoundIds: listed(result["notFoundIds"]),
            };
          },
        );
      },
      /** Upload an SRT or VTT caption file and return the key for YouTube `captionKey`. */
      async uploadCaptions(
        input: { readonly file: Blob; readonly format: "srt" | "vtt" },
        context: AdapterOperationContext,
      ) {
        if (input.file.size > maxBytes.caption)
          throw new SocialError({
            code: "media_error",
            operation: "media.upload",
            message: "PostFast accepts caption files up to 10 MB.",
          });

        const contentType = input.format === "srt" ? "application/x-subrip" : "text/vtt";

        const signed = array(
          await request("/file/get-signed-upload-urls", context, { contentType, count: 1 }),
        );

        const entry = object(signed[0]);
        const key = string(entry["key"]);

        if (signed.length !== 1 || !/^file\/[0-9a-f-]+\.(srt|vtt)$/.test(key))
          throw new SocialError({
            code: "upstream_failure",
            operation: "media.upload",
            message: "PostFast returned an unexpected caption upload slot.",
          });

        await upload({
          url: string(entry["signedUrl"]),
          source: {
            mimeType: contentType,
            size: input.file.size,
            body: input.file,
            open: () => input.file.stream(),
          },
          allowHost,
          maxBytes: maxBytes.caption,
          timeoutMs: remainingBudget(context),
          ...definedFields({ fetch: options.fetch, signal: context.signal }),
        });

        return { key };
      },
      /** Daily follower snapshots and the net change (GET /social-media/:id/follower-history). */
      async followerHistory(
        input: {
          readonly account: ConnectedAccountRef;
          readonly from?: string;
          readonly to?: string;
        },
        context: AdapterOperationContext,
      ) {
        accountMatches(input.account, context);

        const result = object(
          await request(
            `/social-media/${encodeURIComponent(input.account.accountId)}/follower-history`,
            context,
            undefined,
            definedFields({ from: input.from, to: input.to }),
          ),
        );

        if (result["socialMediaId"] !== input.account.accountId)
          throw new SocialError({
            code: "unauthorized",
            operation: "analytics.account.read",
            message: "PostFast returned history for a different account.",
          });

        return {
          ...definedFields({
            currentFollowerCount: count(result["currentFollowerCount"]),
            delta: signedCount(result["delta"]),
            trackingStartedAt: optionalString(result["trackingStartedAt"]),
          }),
          series: array(result["series"]).flatMap((entry) => {
            const row = object(entry);
            const value = count(row["followerCount"]);
            const capturedAt = optionalString(row["capturedAt"]);

            return value === undefined || capturedAt === undefined
              ? []
              : [{ capturedAt, followerCount: value }];
          }),
        };
      },
      /** Pinterest boards for `boardId` (GET /social-media/:id/pinterest-boards). */
      async pinterestBoards(
        input: { readonly account: ConnectedAccountRef },
        context: AdapterOperationContext,
      ) {
        return lookup(
          input.account,
          "pinterest",
          "pinterest-boards",
          ["boardId", "name", "description"],
          context,
        );
      },
      /** YouTube playlists for `playlistId` (GET /social-media/:id/youtube-playlists). */
      async youtubePlaylists(
        input: { readonly account: ConnectedAccountRef },
        context: AdapterOperationContext,
      ) {
        return lookup(
          input.account,
          "youtube",
          "youtube-playlists",
          ["playlistId", "title", "description"],
          context,
        );
      },
      /** Google Business Profile locations for `locationId` (GET /social-media/:id/gbp-locations). */
      async gbpLocations(
        input: { readonly account: ConnectedAccountRef },
        context: AdapterOperationContext,
      ) {
        return lookup(
          input.account,
          "google-business",
          "gbp-locations",
          ["locationId", "title", "address", "mapsUri"],
          context,
        );
      },
      /** Trending TikTok sounds for `musicSoundId` (GET /social-media/:id/tiktok-sounds). */
      async tiktokSounds(
        input: {
          readonly account: ConnectedAccountRef;
          readonly genre?: string;
          readonly countryCode?: string;
          readonly dateRange?: "1DAY" | "7DAY" | "30DAY" | "90DAY";
        },
        context: AdapterOperationContext,
      ) {
        return lookup(
          input.account,
          "tiktok",
          "tiktok-sounds",
          ["musicSoundId", "name", "artist", "duration", "rankPosition"],
          context,
          definedFields({
            genre: input.genre,
            countryCode: input.countryCode,
            dateRange: input.dateRange,
          }),
        );
      },
      /**
       * Facebook Pages with a location, usable as Facebook `locationId` and Instagram
       * `locationId` (GET /social-media/search-places).
       */
      async searchPlaces(input: { readonly query: string }, context: AdapterOperationContext) {
        if (input.query.trim().length < 2)
          reject("accounts.read", "Search with at least two characters.");

        return array(
          await request("/social-media/search-places", context, undefined, { q: input.query }),
        ).map((entry) => publicFields(entry, ["id", "name", "city", "country", "street", "zip"]));
      },
      /** Comment threads in the Social Inbox (TikTok, Instagram, Facebook Pages, Threads). */
      async listInboxConversations(
        input: {
          readonly account: ConnectedAccountRef;
          readonly page?: number;
          readonly limit?: number;
          readonly unreadOnly?: boolean;
          /** Triage states to include; all when omitted. */
          readonly statuses?: readonly PostFastInboxStatus[];
          /** Only conversations assigned to this PostFast user (UUID). */
          readonly assignedToUserId?: string;
        },
        context: AdapterOperationContext,
      ) {
        accountMatches(input.account, context);

        if (input.statuses?.length === 0)
          reject("comments.read", "Leave statuses out to include every triage state.");

        if (input.assignedToUserId !== undefined && !uuidPattern.test(input.assignedToUserId))
          reject("comments.read", "assignedToUserId is a PostFast user UUID.");

        const result = object(
          await request("/social-inbox/conversations", context, undefined, {
            socialMediaIds: input.account.accountId,
            page: String(input.page ?? 0),
            limit: String(input.limit ?? 20),
            ...definedFields({
              unreadOnly: input.unreadOnly === undefined ? undefined : String(input.unreadOnly),
              statuses: input.statuses?.join(","),
              assignedToUserId: input.assignedToUserId,
            }),
          }),
        );

        return array(result["data"])
          .filter((entry) => object(entry)["socialMediaId"] === input.account.accountId)
          .map(inboxConversation);
      },
      /** Comments and replies in one Social Inbox conversation. */
      async listInboxItems(
        input: {
          readonly conversationId: string;
          readonly page?: number;
          readonly limit?: number;
          /** `ASC` (oldest first, PostFast's default) or `DESC`. */
          readonly order?: "ASC" | "DESC";
        },
        context: AdapterOperationContext,
      ) {
        const result = object(
          await request(
            `/social-inbox/conversations/${encodeURIComponent(input.conversationId)}/items`,
            context,
            undefined,
            {
              page: String(input.page ?? 0),
              limit: String(input.limit ?? 20),
              ...definedFields({ order: input.order }),
            },
          ),
        );

        return array(result["data"]).map(inboxItem);
      },
      /** Reply publicly under a comment item; `idempotencyKey` stops a retry double-sending. */
      async replyToInboxItem(
        input: { readonly itemId: string; readonly text: string; readonly idempotencyKey?: string },
        context: AdapterOperationContext,
      ) {
        if (!input.text.trim()) reject("comments.write", "Reply text is required.");

        return sentInboxItem(
          await request(`/social-inbox/items/${encodeURIComponent(input.itemId)}/reply`, context, {
            text: input.text,
            ...definedFields({ idempotencyKey: input.idempotencyKey }),
          }),
          "reply",
        );
      },
      /** Instagram only: one private DM reply per comment, within seven days, up to 1,000 bytes. */
      async privateReply(
        input: { readonly itemId: string; readonly text: string; readonly idempotencyKey?: string },
        context: AdapterOperationContext,
      ) {
        if (new TextEncoder().encode(input.text).length > 1000 || !input.text.trim())
          reject("comments.write", "A private reply is 1 to 1,000 bytes.");

        return sentInboxItem(
          await request(
            `/social-inbox/items/${encodeURIComponent(input.itemId)}/private-reply`,
            context,
            {
              text: input.text,
              ...definedFields({ idempotencyKey: input.idempotencyKey }),
            },
          ),
          "private reply",
        );
      },
      /** Hide, unhide or delete a comment on the platform (POST /social-inbox/items/:id/state). */
      async moderateInboxItem(
        input: { readonly itemId: string; readonly action: "hide" | "unhide" | "delete" },
        context: AdapterOperationContext,
      ) {
        const response = await request(
          `/social-inbox/items/${encodeURIComponent(input.itemId)}/state`,
          context,
          { action: input.action.toUpperCase() },
        );

        const expected =
          input.action === "hide" ? "HIDDEN" : input.action === "unhide" ? "VISIBLE" : "DELETED";

        // The moderation was dispatched; a body that is not the item cannot confirm it.
        const item = isJsonObject(response) ? inboxItem(response) : undefined;

        if (item === undefined || item["id"] !== input.itemId || item["state"] !== expected)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "comments.moderate",
            message: "PostFast did not confirm the moderation. Reconcile before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });

        return item;
      },
      /** Zero a conversation's unread count; nothing changes on the platform. */
      async markInboxRead(
        input: { readonly conversationId: string },
        context: AdapterOperationContext,
      ) {
        return acknowledged(
          "comments.write",
          request(
            `/social-inbox/conversations/${encodeURIComponent(input.conversationId)}/read`,
            context,
            {},
          ),
          // The answer is the Conversation; only this conversation at zero unread confirms it.
          (reply) => {
            const conversation = object(reply);
            const unreadCount = number(conversation["unreadCount"]);

            if (conversation["id"] !== input.conversationId || unreadCount !== 0)
              unconfirmed("read state");

            return { unreadCount };
          },
        );
      },
      /**
       * Set a conversation's triage state (POST /social-inbox/conversations/:id/status).
       * Triage is PostFast state; nothing changes on the platform.
       */
      async setInboxStatus(
        input: { readonly conversationId: string; readonly status: PostFastInboxStatus },
        context: AdapterOperationContext,
      ) {
        const response = await request(
          `/social-inbox/conversations/${encodeURIComponent(input.conversationId)}/status`,
          context,
          { status: input.status },
        );

        // The write was dispatched; a body that is not a Conversation cannot confirm it.
        if (!isJsonObject(response)) unconfirmed("triage state");

        const conversation = inboxConversation(response);

        if (conversation["id"] !== input.conversationId || conversation["status"] !== input.status)
          unconfirmed("triage state");

        return conversation;
      },
      /**
       * Assign a conversation to a workspace member, or pass `assigneeUserId: null` to
       * unassign (POST /social-inbox/conversations/:id/assign). PostFast answers
       * `inbox.assigneeNotMember` for a user outside the workspace.
       */
      async assignInboxConversation(
        input: { readonly conversationId: string; readonly assigneeUserId: string | null },
        context: AdapterOperationContext,
      ) {
        if (input.assigneeUserId !== null && !uuidPattern.test(input.assigneeUserId))
          reject("comments.write", "assigneeUserId is a PostFast user UUID, or null to unassign.");

        const response = await request(
          `/social-inbox/conversations/${encodeURIComponent(input.conversationId)}/assign`,
          context,
          input.assigneeUserId === null ? {} : { assigneeUserId: input.assigneeUserId },
        );

        // The write was dispatched; a body that is not a Conversation cannot confirm it.
        if (!isJsonObject(response)) unconfirmed("assignment");

        const conversation = inboxConversation(response);

        if (
          conversation["id"] !== input.conversationId ||
          conversation["assignedToUserId"] !== input.assigneeUserId
        )
          unconfirmed("assignment");

        return conversation;
      },
      async inboxUnreadCount(context: AdapterOperationContext) {
        const result = object(await request("/social-inbox/unread-count", context));

        return { unreadCount: optionalNumber(result["unreadCount"]) ?? 0 };
      },
    },
  });

  async function lookup(
    account: ConnectedAccountRef,
    expected: Platform,
    route: string,
    fields: readonly string[],
    context: AdapterOperationContext,
    query: Record<string, string> = {},
  ): Promise<JsonObject[]> {
    accountMatches(account, context);

    if (account.platform !== expected)
      reject("accounts.read", `This lookup applies to ${expected} accounts.`);

    return array(
      await request(
        `/social-media/${encodeURIComponent(account.accountId)}/${route}`,
        context,
        undefined,
        query,
      ),
    ).map((entry) => publicFields(entry, fields));
  }

  async function remove(id: string, context: AdapterOperationContext): Promise<void> {
    await acknowledged(
      "posts.lifecycle",
      request(`/social-posts/${encodeURIComponent(id)}`, context, undefined, {}, "DELETE"),
      (reply) => {
        if (object(reply)["deleted"] !== true)
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "posts.lifecycle",
            message: "PostFast did not confirm the deletion. Reconcile before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });
      },
    );
  }

  return adapter;
}
