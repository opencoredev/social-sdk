import { defineAdapter } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import { definedFields } from "../core/fields.js";
import type {
  AccountRecord,
  AdapterOperationContext,
  CapabilityDeclaration,
  CapabilityMediaSource,
  ConnectedAccountRef,
  DeliveryOutcome,
  DeliveryRef,
  JsonObject,
  JsonValue,
  MediaAttachment,
  Page,
  PlatformPostRef,
  PreparationIssue,
  PreparedPublishTarget,
} from "../core/types.js";
import { acknowledged, managedHttpExchange, optionsObject, publicFields } from "../cloud/common.js";
import { HttpError } from "../transport/http.js";
import { remainingBudget } from "../transport/budget.js";
import { httpsUrl, upload } from "../transport/upload.js";
import {
  array,
  isJsonObject,
  isString,
  object,
  optionalString,
  type JsonField,
} from "../transport/validation.js";

/**
 * Pinterest API v5. Sources, checked 2026-11-25 against the OpenAPI description 5.32.0
 * (github.com/pinterest/api-description, v5/openapi.json at commit 5c6c1fc, 2026-11-19):
 * - Create Pin: https://developers.pinterest.com/docs/api/v5/pins-create
 * - Delete Pin: https://developers.pinterest.com/docs/api/v5/pins-delete
 * - List boards: https://developers.pinterest.com/docs/api/v5/boards-list
 * - Register media upload and media status: https://developers.pinterest.com/docs/api/v5/media-create
 *   and https://developers.pinterest.com/docs/api/v5/media-get
 * - Get user account: https://developers.pinterest.com/docs/api/v5/user_account-get
 * - Video Pin flow: https://developers.pinterest.com/docs/work-with-organic-content-and-users/create-boards-and-pins/
 * - Sandbox, which cannot create video Pins: https://developers.pinterest.com/docs/developer-tools/sandbox/
 * - File types and video length: https://help.pinterest.com/en/article/review-pin-specs
 */
const apiRevision = "Pinterest API v5 (OpenAPI 5.32.0)";

const productionOrigin = "https://api.pinterest.com/v5";

const sandboxOrigin = "https://api-sandbox.pinterest.com/v5";

/** Pin request errors after which no Pin exists and the video workflow can be continued. */
const continuableCodes: ReadonlySet<string> = new Set([
  "rate_limited",
  "timeout",
  "cancelled",
  "reconnect_required",
  "missing_permission",
]);

/** Scopes Pinterest lists for POST and DELETE /v5/pins and for the media upload endpoints. */
const pinWriteScopes = ["boards:read", "boards:write", "pins:read", "pins:write"] as const;

const imageMimeTypes = ["image/bmp", "image/jpeg", "image/png", "image/tiff", "image/webp"];

/** `image_base64` and `multiple_image_base64` take only these content types. */
const base64MimeTypes: readonly string[] = ["image/jpeg", "image/png"];

const videoMimeTypes: readonly string[] = ["video/mp4", "video/x-m4v", "video/quicktime"];

/** Pinterest's web upload limit for images, applied to bytes the adapter base64-encodes. */
const maxBase64ImageBytes = 20 * 1024 * 1024;

/** The adapter's upload cap. Pinterest states no organic video size; its ad specs allow 2 GB. */
const maxVideoBytes = 2 * 1024 * 1024 * 1024;

const minVideoSeconds = 4;

const maxVideoSeconds = 300;

const boardFields = [
  "id",
  "name",
  "description",
  "privacy",
  "pin_count",
  "follower_count",
  "collaborator_count",
  "created_at",
  "board_pins_modified_at",
  "is_ads_only",
] as const;

const accountFields = [
  "id",
  "username",
  "account_type",
  "business_name",
  "website_url",
  "profile_image",
] as const;

const optionKeys: ReadonlySet<string> = new Set(["boardId", "boardSectionId", "title", "link"]);

/** Target options of the direct Pinterest adapter. `content.text` becomes the Pin description. */
export interface PinterestPublishOptions {
  /** `board_id`: the numeric board that receives the Pin. Read boards with `native.listBoards`. */
  readonly boardId: string;
  /** `board_section_id`: a numeric section of that board. */
  readonly boardSectionId?: string;
  /** `title`, up to 100 characters. */
  readonly title?: string;
  /** `link`, the destination URL, up to 2,048 characters. Defaults to `content.link.url`. */
  readonly link?: string;
}

export interface PinterestOptions {
  readonly auth: {
    readonly accessToken: string;
    /** The Pinterest user account ID that `GET /v5/user_account` returns as `id`. */
    readonly accountId: string;
  };
  /**
   * Send requests to `api-sandbox.pinterest.com`, the only host a Trial-access app can write to.
   * Use a sandbox token. The sandbox cannot create video Pins.
   */
  readonly sandbox?: boolean;
  /**
   * Accept Blob images and send them as `image_base64`. Leave it off when the client has a
   * `mediaStaging` store, so local images are staged and sent as `image_url`.
   */
  readonly imageBase64?: boolean;
  /**
   * Keeps video Pins that are still processing, so `posts.getDelivery` can report them and
   * `native.continueVideoPin` can create them later.
   */
  readonly workflowStore?: PinterestWorkflowStore;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
}

/** A video Pin waiting for Pinterest to finish processing its upload. */
export interface PinterestVideoWorkflow {
  readonly id: string;
  readonly backend: string;
  readonly accountId: string;
  /** Pinterest's `media_id` for the uploaded video. */
  readonly mediaId: string;
  /** The validated `POST /v5/pins` body, sent once the media has `succeeded`. */
  readonly pin: JsonObject;
  /** `creating` is saved before the Pin request, so an unanswered request is never repeated. */
  readonly stage: "processing" | "creating" | "published" | "failed";
  readonly pinId?: string;
}

export type PinterestWorkflowUpdate = Partial<Omit<PinterestVideoWorkflow, "id">>;

export interface PinterestWorkflowStore {
  create(input: Omit<PinterestVideoWorkflow, "id">): Promise<PinterestVideoWorkflow>;
  get(id: string): Promise<PinterestVideoWorkflow | undefined>;
  update(id: string, update: PinterestWorkflowUpdate): Promise<PinterestVideoWorkflow>;
  /**
   * Atomically claim a workflow for continuation. A claim is held until `release` and must not
   * expire on its own: a worker that stops mid-continuation may have sent the Pin request, so a
   * stale claim is cleared only after the board has been checked.
   */
  claim(id: string): Promise<boolean>;
  /** Release the claim once the continuation settles. */
  release(id: string): Promise<void>;
}

/** Process-local workflow store. Use a durable store when processing can outlive the process. */
export class MemoryPinterestWorkflowStore implements PinterestWorkflowStore {
  private readonly rows = new Map<string, PinterestVideoWorkflow>();
  private readonly claims = new Set<string>();

  async create(input: Omit<PinterestVideoWorkflow, "id">) {
    const row = { ...input, id: `pinwf_${globalThis.crypto.randomUUID()}` };
    this.rows.set(row.id, structuredClone(row));

    return structuredClone(row);
  }

  async get(id: string) {
    const row = this.rows.get(id);

    return row ? structuredClone(row) : undefined;
  }

  async update(id: string, update: PinterestWorkflowUpdate) {
    const row = this.rows.get(id);

    if (!row) throw new Error("Pinterest workflow not found");
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

export type PinterestBoardPrivacy = "PUBLIC" | "PROTECTED";

export interface PinterestListBoardsInput {
  readonly account: ConnectedAccountRef;
  readonly context: AdapterOperationContext;
  /** Pinterest's `bookmark` from the previous page. */
  readonly cursor?: string;
  /** `page_size`, 1 to 250. Defaults to 25. */
  readonly limit?: number;
  /** `privacy`. Secret boards need the `boards:read_secret` scope and are not listed. */
  readonly privacy?: PinterestBoardPrivacy;
}

export interface PinterestNative {
  /** `GET /v5/boards`: boards the account can Pin to, for `boardId`. Scope `boards:read`. */
  listBoards(input: PinterestListBoardsInput): Promise<Page<JsonObject>>;
  /**
   * Create the Pin of a processing video workflow once its upload has succeeded: one media
   * status read, then at most one `POST /v5/pins`. This is a write; authorize it like a publish.
   */
  continueVideoPin(input: PinterestContinueVideoInput): Promise<DeliveryOutcome>;
}

export interface PinterestContinueVideoInput {
  readonly delivery: DeliveryRef;
  readonly context: AdapterOperationContext;
}

function numericId(value: JsonField): value is string {
  return isString(value) && /^\d{1,32}$/.test(value);
}

/** JSON Schema `maxLength` counts code points. */
function characters(value: string): number {
  return Array.from(value).length;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isHttpsMediaUrl(value: string): boolean {
  try {
    httpsUrl(value);

    return true;
  } catch {
    return false;
  }
}

/** Accepts only the host Pinterest documents for `upload_url`: its S3 media bucket. */
function isUploadHost(hostname: string): boolean {
  return /^pinterest-media-upload\.s3(-accelerate|\.[a-z0-9-]+)?\.amazonaws\.com$/.test(hostname);
}

function blobMimeType(item: MediaAttachment): string | undefined {
  if (item.mimeType !== undefined) return item.mimeType;

  return item.source.kind === "blob" && item.source.blob.type !== ""
    ? item.source.blob.type
    : undefined;
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));

  return btoa(binary);
}

interface PinPlan {
  readonly issues: readonly PreparationIssue[];
  /** The `POST /v5/pins` body. Base64 `data` and the video `media_id` are added at dispatch. */
  readonly pin: JsonObject;
  /** Images to base64-encode at dispatch, in `media_source` order. */
  readonly blobs: readonly Blob[];
  readonly video?: { readonly blob: Blob; readonly mimeType: string };
}

export function pinterest(
  options: PinterestOptions,
): import("../core/adapter.js").SocialAdapter<PinterestNative> {
  if (!options.auth.accessToken.trim() || !numericId(options.auth.accountId))
    throw new SocialError({
      code: "invalid_config",
      operation: "createAdapter",
      message: "Configure a Pinterest access token and the numeric Pinterest user account ID.",
    });

  const sandbox = options.sandbox === true;
  const imageBase64 = options.imageBase64 === true;

  const exchange = managedHttpExchange(sandbox ? sandboxOrigin : productionOrigin, {
    apiKey: options.auth.accessToken,
    ...definedFields({ fetch: options.fetch }),
  });

  const request = async (...args: Parameters<typeof exchange>): Promise<JsonValue> =>
    (await exchange(...args)).body;

  const workflows = options.workflowStore ?? new MemoryPinterestWorkflowStore();
  const now = () => (options.clock?.() ?? new Date()).toISOString();

  const authorize = (
    ref: { readonly backend: string; readonly platform: string; readonly accountId: string },
    context: AdapterOperationContext,
  ) => {
    if (
      ref.backend !== context.backendInstance ||
      ref.platform !== "pinterest" ||
      ref.accountId !== options.auth.accountId
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "pinterest",
        message: "Account reference does not belong to this Pinterest authorization.",
      });
  };

  /** Validate a target and build its Pin request. Pure: preparation and dispatch share it. */
  const plan = (target: PreparedPublishTarget): PinPlan => {
    const issues: PreparationIssue[] = [];

    const fail = (code: string, message: string, path: string) =>
      issues.push({ code, message, path, severity: "error", targetIndex: target.targetIndex });

    if (
      target.account.platform !== "pinterest" ||
      target.account.accountId !== options.auth.accountId
    )
      fail("pinterest.account", "Select the configured Pinterest account.", "account");

    if (target.schedule !== undefined)
      fail("pinterest.schedule", "Pinterest's API creates Pins immediately.", "schedule");

    if (target.replyTo !== undefined)
      fail("pinterest.reply", "Pins cannot reply to posts or comments.", "replyTo");

    let config: JsonObject = {};

    try {
      config = optionsObject(target);
    } catch {
      fail("pinterest.options", "Pinterest options must be a JSON object.", "options");
    }

    for (const key of Object.keys(config))
      if (!optionKeys.has(key))
        fail(
          "pinterest.option",
          `The direct Pinterest adapter has no ${key} option.`,
          `options.${key}`,
        );

    const boardId = config["boardId"];

    if (!numericId(boardId))
      fail("pinterest.board", "Set boardId to the numeric ID of a board.", "options.boardId");

    const boardSectionId = config["boardSectionId"];

    if (boardSectionId !== undefined && !numericId(boardSectionId))
      fail(
        "pinterest.board_section",
        "boardSectionId must be a numeric board section ID.",
        "options.boardSectionId",
      );

    const title = config["title"];

    if (title !== undefined && (!isString(title) || characters(title) > 100))
      fail("pinterest.title", "Pin titles are limited to 100 characters.", "options.title");

    const link = config["link"] ?? target.content.link?.url;

    if (link !== undefined && (!isString(link) || link.length > 2048 || !isHttpUrl(link)))
      fail(
        "pinterest.link",
        "The destination link must be an HTTP or HTTPS URL of up to 2,048 characters.",
        "options.link",
      );

    const description = target.content.text;

    if (description !== undefined && characters(description) > 800)
      fail(
        "pinterest.description",
        "Pin descriptions are limited to 800 characters.",
        "content.text",
      );

    const media = target.content.media ?? [];
    const blobs: Blob[] = [];
    let mediaSource: JsonObject = {};
    let altText: string | undefined;
    let video: PinPlan["video"];

    const first = media[0];

    if (first !== undefined && media.length === 1 && first.kind === "video") {
      const mimeType = blobMimeType(first);
      const thumbnail = first.thumbnail;

      if (sandbox)
        fail(
          "pinterest.sandbox_video",
          "Pinterest's sandbox cannot create video Pins.",
          "content.media",
        );

      if (mimeType === undefined || !videoMimeTypes.includes(mimeType))
        fail(
          "pinterest.video_type",
          "Video Pins take MP4, M4V or MOV files.",
          "content.media[0].mimeType",
        );

      if (first.source.kind !== "blob")
        fail(
          "pinterest.video_source",
          "Pinterest uploads video files. Supply the video as a Blob.",
          "content.media[0].source",
        );
      else if (first.source.blob.size > maxVideoBytes)
        fail("pinterest.video_size", "The adapter uploads videos up to 2 GiB.", "content.media[0]");
      else if (mimeType !== undefined) video = { blob: first.source.blob, mimeType };

      const seconds = first.durationSeconds;

      if (seconds !== undefined && (seconds < minVideoSeconds || seconds > maxVideoSeconds))
        fail(
          "pinterest.video_length",
          "Video Pins run from 4 seconds to 5 minutes.",
          "content.media[0].durationSeconds",
        );

      // The schema also lists cover_image_key_frame_time, but the video Pin guide requires a
      // valid cover_image_url, so the adapter requires an HTTPS thumbnail.
      if (thumbnail?.kind !== "https-url" || !isHttpsMediaUrl(thumbnail.url))
        fail(
          "pinterest.cover",
          "Give the video Pin a cover: a public HTTPS thumbnail on the attachment.",
          "content.media[0].thumbnail",
        );

      altText = first.altText;
      mediaSource = {
        source_type: "video_id",
        cover_image_url: thumbnail?.kind === "https-url" ? thumbnail.url : "",
      };
    } else if (
      media.length < 1 ||
      media.length > 5 ||
      media.some((item) => item.kind !== "image")
    ) {
      fail(
        "pinterest.media",
        "A Pin needs one video, or one to five images; formats cannot be mixed.",
        "content.media",
      );
    } else {
      const urls = media.every((item) => item.source.kind === "https-url");

      if (!urls && !media.every((item) => item.source.kind === "blob"))
        fail(
          "pinterest.image_source",
          "Use HTTPS URLs for every image or Blobs for every image, not both.",
          "content.media",
        );

      const items: JsonObject[] = [];

      for (const [index, item] of media.entries()) {
        const path = `content.media[${index}].source`;
        const caption = definedFields({ description: item.caption });
        const source = item.source;

        if (source.kind === "https-url") {
          if (!isHttpsMediaUrl(source.url))
            fail("pinterest.image_source", "Image URLs must be public HTTPS URLs.", path);
          items.push({ url: source.url, ...caption });
          continue;
        }

        if (source.kind !== "blob" || !imageBase64) {
          fail(
            "pinterest.image_source",
            imageBase64
              ? "Supply each image as an HTTPS URL or a Blob."
              : "Supply each image as an HTTPS URL, or set imageBase64 to send Blob images.",
            path,
          );
          continue;
        }

        const mimeType = blobMimeType(item);

        if (mimeType === undefined || !base64MimeTypes.includes(mimeType))
          fail(
            "pinterest.image_type",
            "Base64 images must be JPEG or PNG.",
            `content.media[${index}].mimeType`,
          );
        else if (source.blob.size > maxBase64ImageBytes)
          fail("pinterest.image_size", "Base64 images are limited to 20 MB.", path);

        blobs.push(source.blob);
        items.push({ content_type: mimeType ?? "", ...caption });
      }

      if (media.length === 1) {
        const [item] = items;

        altText = first?.altText;
        mediaSource = urls
          ? { source_type: "image_url", url: item?.["url"] ?? "" }
          : { source_type: "image_base64", content_type: item?.["content_type"] ?? "" };
      } else {
        if (media.some((item) => item.altText !== undefined))
          fail(
            "pinterest.alt_text",
            "Pinterest takes alt text on single-image and video Pins only.",
            "content.media",
          );

        mediaSource = {
          source_type: urls ? "multiple_image_urls" : "multiple_image_base64",
          items,
        };
      }
    }

    if (altText !== undefined && characters(altText) > 500)
      fail(
        "pinterest.alt_text",
        "Pin alt text is limited to 500 characters.",
        "content.media[0].altText",
      );

    return {
      issues,
      blobs,
      ...definedFields({ video }),
      pin: {
        board_id: isString(boardId) ? boardId : "",
        media_source: mediaSource,
        ...definedFields({
          board_section_id: isString(boardSectionId) ? boardSectionId : undefined,
          title: isString(title) ? title : undefined,
          description,
          link: isString(link) ? link : undefined,
          alt_text: altText,
        }),
      },
    };
  };

  /** Add the base64 `data` of each image in the order the plan recorded them. */
  const withBase64 = async (pin: JsonObject, blobs: readonly Blob[]): Promise<JsonObject> => {
    if (blobs.length === 0) return pin;

    const encoded = await Promise.all(blobs.map(base64));
    const source = object(pin["media_source"]);

    if (source["source_type"] === "image_base64")
      return { ...pin, media_source: { ...source, data: encoded[0] ?? "" } };

    return {
      ...pin,
      media_source: {
        ...source,
        items: array(source["items"]).map((item, index) => ({
          ...object(item),
          data: encoded[index] ?? "",
        })),
      },
    };
  };

  const deliveryRef = (account: ConnectedAccountRef, deliveryId: string): DeliveryRef => ({
    kind: "delivery",
    version: 1,
    backend: account.backend,
    platform: "pinterest",
    accountId: account.accountId,
    deliveryId,
  });

  const published = (
    account: ConnectedAccountRef,
    pinId: string,
    delivery?: DeliveryRef,
  ): DeliveryOutcome => ({
    state: "published",
    targetIndex: 0,
    account,
    observedAt: now(),
    backendState: "CREATED",
    post: {
      kind: "platform-post",
      version: 1,
      backend: account.backend,
      platform: "pinterest",
      accountId: account.accountId,
      postId: pinId,
    },
    ...definedFields({
      delivery,
      // Sandbox Pins are visible only to their owner, so they have no public URL.
      url: sandbox ? undefined : `https://www.pinterest.com/pin/${pinId}/`,
    }),
  });

  /** `POST /v5/pins`. Only a 200 or 201 with a numeric Pin ID confirms the write. */
  const createPin = async (pin: JsonObject, context: AdapterOperationContext): Promise<string> => {
    const answer = await exchange("/pins", context, pin);

    // Pinterest documents 200 and 201 for a created Pin; any other 2xx is unconfirmed.
    return acknowledged("pinterest.posts.publish", Promise.resolve(answer.body), (body) => {
      const id = object(body)["id"];

      if ((answer.status !== 200 && answer.status !== 201) || !numericId(id))
        throw new Error("Pinterest did not confirm the Pin");

      return id;
    });
  };

  /** A failed outcome that keeps the workflow reference, so the upload can be continued. */
  const failedVideo = (
    workflow: PinterestVideoWorkflow,
    account: ConnectedAccountRef,
    error: SocialError,
    continuable: boolean,
    fromPublish: boolean,
  ): DeliveryOutcome => ({
    state: "failed",
    targetIndex: 0,
    account,
    delivery: deliveryRef(account, workflow.id),
    observedAt: now(),
    mediaId: workflow.mediaId,
    code: error.code,
    message: error.message,
    // A continuable workflow is resumed with native.continueVideoPin, never by publishing the
    // target again, which would upload the video a second time. From a continuation, retrying
    // means continuing again, so the error's own delay or reconnect advice applies.
    retryDisposition:
      continuable && fromPublish ? { kind: "reconcile-first" } : error.retryDisposition,
  });

  /** The outcome a stored workflow already settles, or undefined while it is still processing. */
  const settled = (
    row: PinterestVideoWorkflow,
    account: ConnectedAccountRef,
  ): DeliveryOutcome | undefined => {
    const delivery = deliveryRef(account, row.id);
    const base = { targetIndex: 0, account, delivery, observedAt: now(), mediaId: row.mediaId };

    if (row.stage === "processing") return undefined;

    if (row.stage === "published" && row.pinId !== undefined)
      return published(account, row.pinId, delivery);

    if (row.stage === "failed")
      return {
        ...base,
        state: "failed",
        code: "media_error",
        message: "The Pinterest video Pin was not created.",
        retryDisposition: { kind: "never" },
      };

    return {
      ...base,
      state: "unknown",
      reason: "ambiguous-submission",
      diagnostic: "The Pin request was sent without a confirmed answer and was not repeated.",
    };
  };

  /** Read the media status once and create the Pin when it has `succeeded`. No polling. */
  const continueVideo = async (
    workflow: PinterestVideoWorkflow,
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
    fromPublish: boolean,
  ): Promise<DeliveryOutcome> => {
    const delivery = deliveryRef(account, workflow.id);
    const base = { targetIndex: 0, account, delivery, mediaId: workflow.mediaId };
    let media: JsonValue;

    try {
      media = await request(`/media/${encodeURIComponent(workflow.mediaId)}`, context);
    } catch (error) {
      // Nothing was written: the workflow stays processing and can be continued later.
      if (error instanceof SocialError)
        return failedVideo(workflow, account, error, true, fromPublish);
      throw error;
    }

    if (!isJsonObject(media) || !isString(media["media_id"]) || !isString(media["status"]))
      return failedVideo(workflow, account, unreadableMedia(), true, fromPublish);

    const status = media["status"];

    if (media["media_id"] !== workflow.mediaId)
      return {
        ...base,
        observedAt: now(),
        state: "unknown",
        reason: "unmapped-state",
        diagnostic: "Pinterest answered for a different media upload. No Pin was requested.",
      };

    if (status === "registered" || status === "processing")
      return {
        targetIndex: 0,
        account,
        delivery,
        observedAt: now(),
        state: "processing",
        backendState: status,
      };

    if (status === "failed") {
      await workflows.update(workflow.id, { stage: "failed" });

      return {
        ...base,
        observedAt: now(),
        state: "failed",
        backendState: status,
        code: "media_error",
        message: "Pinterest could not process the uploaded video. No Pin was created.",
        retryDisposition: { kind: "never" },
      };
    }

    if (status !== "succeeded")
      return {
        ...base,
        observedAt: now(),
        state: "unknown",
        reason: "unmapped-state",
        diagnostic: "Pinterest reported an unmapped media status. No Pin was requested.",
      };

    await workflows.update(workflow.id, { stage: "creating" });
    let pinId: string;

    try {
      pinId = await createPin(
        {
          ...workflow.pin,
          media_source: { ...object(workflow.pin["media_source"]), media_id: workflow.mediaId },
        },
        context,
      );
    } catch (error) {
      // An unanswered request stays `creating` and is never resent. The transport reports a
      // dispatched POST that timed out or was cancelled as ambiguous_outcome, so timeout and
      // cancelled here mean the request was never sent.
      if (!(error instanceof SocialError) || error.code === "ambiguous_outcome")
        return {
          ...base,
          observedAt: now(),
          state: "unknown",
          reason: "ambiguous-submission",
          diagnostic: "The Pin request was sent without a confirmed answer and was not repeated.",
        };

      // No Pin was created. A rate limit, an expired or under-scoped token, or an unsent request
      // can be continued later; any other stated rejection ends the workflow.
      const continuable = continuableCodes.has(error.code);
      const rejected = failedVideo(workflow, account, error, continuable, fromPublish);

      try {
        await workflows.update(workflow.id, { stage: continuable ? "processing" : "failed" });
      } catch {
        // The row still says `creating`, so later calls report unknown and never resend. Pinterest
        // did reject this request; a caller who has checked the board can reset the row.
        return { ...rejected, backendState: "WORKFLOW_SAVE_FAILED" };
      }

      return rejected;
    }

    const outcome = published(account, pinId, delivery);

    try {
      await workflows.update(workflow.id, { stage: "published", pinId });
    } catch {
      // The Pin exists; the caller must repair the workflow before relying on it.
      return { ...outcome, backendState: "CREATED_WORKFLOW_SAVE_FAILED" };
    }

    return outcome;
  };

  /** Read-only status of a processing workflow: one media status read, no Pin request. */
  const videoStatus = async (
    workflow: PinterestVideoWorkflow,
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<DeliveryOutcome> => {
    const answer = await request(`/media/${encodeURIComponent(workflow.mediaId)}`, context);
    const media = isJsonObject(answer) ? answer : {};
    const status = media["status"];

    const base = {
      targetIndex: 0,
      account,
      delivery: deliveryRef(account, workflow.id),
      observedAt: now(),
    };

    if (media["media_id"] === workflow.mediaId && status === "failed")
      return {
        ...base,
        state: "failed",
        backendState: status,
        mediaId: workflow.mediaId,
        code: "media_error",
        message: "Pinterest could not process the uploaded video. No Pin was created.",
        retryDisposition: { kind: "never" },
      };

    if (
      media["media_id"] !== workflow.mediaId ||
      (status !== "registered" && status !== "processing" && status !== "succeeded")
    )
      return {
        ...base,
        state: "unknown",
        reason: "unmapped-state",
        mediaId: workflow.mediaId,
        diagnostic: "Pinterest reported an unmapped media status. No Pin was requested.",
      };

    // A succeeded upload still needs its Pin: native.continueVideoPin sends that write.
    return {
      ...base,
      state: "processing",
      backendState: status === "succeeded" ? "MEDIA_READY" : status,
    };
  };

  /** Video workflows exist only in production, so a sandbox adapter never reads or continues one. */
  const rejectSandboxVideo = (operation: string) => {
    if (sandbox)
      throw new SocialError({
        code: "unsupported_capability",
        operation,
        message: "Pinterest's sandbox cannot create video Pins, so it has no video workflows.",
      });
  };

  /** Load a workflow for an account reference, rejecting another account's workflow. */
  const loadWorkflow = async (
    ref: { readonly backend: string; readonly accountId: string; readonly deliveryId: string },
    operation: string,
  ): Promise<{
    readonly workflow: PinterestVideoWorkflow;
    readonly account: ConnectedAccountRef;
  }> => {
    const workflow = await workflows.get(ref.deliveryId);

    if (workflow === undefined)
      throw new SocialError({
        code: "not_found",
        operation,
        message: "The configured workflow store has no Pinterest video Pin with this delivery ID.",
      });

    if (workflow.backend !== ref.backend || workflow.accountId !== ref.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation,
        message: "The Pinterest workflow belongs to a different account.",
      });

    return {
      workflow,
      account: {
        kind: "connected-account",
        version: 1,
        backend: ref.backend,
        platform: "pinterest",
        accountId: ref.accountId,
      },
    };
  };

  /**
   * Continue a workflow under its claim. The row is reread after the claim, so a continuation
   * never acts on a copy another worker has already advanced. A failed release does not hide
   * the outcome; it is reported in `backendState`.
   */
  const resume = async (
    id: string,
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
    fromPublish: boolean,
  ): Promise<DeliveryOutcome> => {
    if (!(await workflows.claim(id)))
      return {
        targetIndex: 0,
        account,
        delivery: deliveryRef(account, id),
        observedAt: now(),
        state: "processing",
        backendState: "CLAIMED",
      };

    let outcome: DeliveryOutcome;

    try {
      const current = await workflows.get(id);

      if (current === undefined)
        throw new SocialError({
          code: "not_found",
          operation: "pinterest.posts.status",
          message: "The Pinterest video workflow disappeared from the store.",
        });

      outcome =
        settled(current, account) ?? (await continueVideo(current, account, context, fromPublish));
    } catch (error) {
      await workflows.release(id).catch(() => undefined);
      throw error;
    }

    try {
      await workflows.release(id);
    } catch {
      return { ...outcome, backendState: "CLAIM_RELEASE_FAILED" };
    }

    return outcome;
  };

  const unreadableMedia = () =>
    new SocialError({
      code: "upstream_failure",
      operation: "pinterest.posts.status",
      message: "Pinterest returned an unreadable media status. No Pin was requested.",
    });

  const mediaError = (message: string, mediaId?: string) =>
    new SocialError({
      code: "media_error",
      operation: "media.upload",
      message,
      ...definedFields({ details: mediaId === undefined ? undefined : { mediaId } }),
      retryDisposition: { kind: "never" },
    });

  /** `POST /v5/media`. Registering an upload sends no file and creates nothing visible. */
  const registerVideo = async (context: AdapterOperationContext) => {
    const registered = object(await request("/media", context, { media_type: "video" }));
    const mediaId = registered["media_id"];
    const uploadUrl = registered["upload_url"];
    const parameters = registered["upload_parameters"];

    if (!numericId(mediaId) || !isString(uploadUrl) || !isJsonObject(parameters))
      throw mediaError("Pinterest returned an unusable media registration. No Pin was created.");

    return { mediaId, uploadUrl, parameters };
  };

  /**
   * The documented multipart POST of the file to `upload_url`. `unconfirmed` means the file was
   * sent and the storage gave no answer or a 5xx, so only the media status can tell whether it
   * landed. A returned SocialError means the file was not accepted.
   */
  const sendVideo = async (
    { mediaId, uploadUrl, parameters }: Awaited<ReturnType<typeof registerVideo>>,
    video: NonNullable<PinPlan["video"]>,
    context: AdapterOperationContext,
  ): Promise<"accepted" | "unconfirmed" | SocialError> => {
    // Stream the multipart body around the original Blob, so the file is neither copied nor
    // buffered. Its length is known, so the upload sends an exact Content-Length.
    const boundary = "pinterest" + globalThis.crypto.randomUUID().replaceAll("-", "");
    let head = "";

    for (const [name, value] of Object.entries(parameters)) {
      if (!isString(value) || /["\r\n]/.test(name) || /[\r\n]/.test(value))
        return mediaError(
          "Pinterest returned an unusable upload parameter. No Pin was created.",
          mediaId,
        );
      head +=
        "--" +
        boundary +
        '\r\nContent-Disposition: form-data; name="' +
        name +
        '"\r\n\r\n' +
        value +
        "\r\n";
    }

    head +=
      "--" + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="video"\r\n';
    head += "Content-Type: " + video.mimeType + "\r\n\r\n";
    const encoder = new TextEncoder();
    const prefix = encoder.encode(head);
    const suffix = encoder.encode("\r\n--" + boundary + "--\r\n");
    const size = prefix.byteLength + video.blob.size + suffix.byteLength;

    const open = (): ReadableStream<Uint8Array> => {
      const file = video.blob.stream().getReader();
      let stage: "prefix" | "file" | "suffix" | "done" = "prefix";

      return new ReadableStream<Uint8Array>({
        async pull(output) {
          if (stage === "prefix") {
            stage = "file";
            output.enqueue(prefix);

            return;
          }

          if (stage === "file") {
            const next = await file.read();

            if (!next.done) {
              output.enqueue(next.value);

              return;
            }

            stage = "suffix";
          }

          if (stage === "suffix") {
            stage = "done";
            output.enqueue(suffix);

            return;
          }

          output.close();
        },
        cancel(reason) {
          void file.cancel(reason).catch(() => undefined);
        },
      });
    };

    try {
      await upload({
        url: uploadUrl,
        method: "POST",
        source: { mimeType: "multipart/form-data; boundary=" + boundary, size, open },
        allowHost: isUploadHost,
        maxBytes: maxVideoBytes + 1024 * 1024,
        timeoutMs: remainingBudget(context),
        ...definedFields({ fetch: options.fetch, signal: context.signal }),
      });
    } catch (error) {
      // The operation budget ran out or was cancelled before the upload started.
      if (error instanceof SocialError) return error;

      // Anything else cannot prove the file stayed unsent.
      if (!(error instanceof HttpError)) return "unconfirmed";

      // Sent without an answer, or with a storage-side 5xx: the file may have landed.
      if (error.dispatched && (error.status === undefined || error.status >= 500))
        return "unconfirmed";

      if (error.kind === "cancelled")
        return new SocialError({
          code: "cancelled",
          operation: "media.upload",
          message: "The video upload was cancelled before it was sent. No Pin was created.",
          details: { mediaId },
        });

      if (error.status === undefined)
        return new SocialError({
          code: error.kind === "timeout" ? "timeout" : "upstream_failure",
          operation: "media.upload",
          message: "The video upload could not be sent. No Pin was created.",
          details: { mediaId },
          retryDisposition: { kind: "never" },
        });

      return new SocialError({
        code: error.status === 429 ? "rate_limited" : "media_error",
        operation: "media.upload",
        message: "Pinterest's storage did not accept the video upload. No Pin was created.",
        details: { mediaId },
        ...definedFields({ upstreamStatus: error.status }),
        retryDisposition: { kind: "never" },
      });
    }

    return "accepted";
  };

  const readAccount = async (context: AdapterOperationContext): Promise<AccountRecord> => {
    const account = object(await request("/user_account", context));

    if (account["id"] !== options.auth.accountId)
      throw new SocialError({
        code: "unauthorized",
        operation: "pinterest.accounts.read",
        message: "The Pinterest token belongs to a different user account.",
      });

    const username = optionalString(account["username"]);

    return {
      ref: {
        kind: "connected-account",
        version: 1,
        backend: context.backendInstance,
        platform: "pinterest",
        accountId: options.auth.accountId,
      },
      displayName: optionalString(account["business_name"]) ?? username ?? options.auth.accountId,
      status: "connected",
      native: publicFields(account, accountFields),
      ...definedFields({ handle: username }),
    };
  };

  const imageSources: readonly CapabilityMediaSource[] = imageBase64
    ? ["https-url", "blob"]
    : ["https-url"];

  const unavailable = (
    operation: string,
    availability: "unsupported-by-platform" | "not-implemented-by-adapter",
    notes: string,
  ): CapabilityDeclaration => ({ platform: "pinterest", operation, availability, notes });

  return defineAdapter({
    id: "pinterest",
    capabilities: {
      schemaVersion: 1 as const,
      backend: "pinterest",
      apiRevision,
      runtime: ["node22", "node24", "bun"],
      capabilities: [
        {
          platform: "pinterest",
          operation: "posts.publish",
          availability: "available" as const,
          formats: ["image" as const, "carousel" as const],
          requiredScopes: pinWriteScopes,
          constraints: {
            mediaSources: imageSources,
            maxItems: 5,
            allowedMimeTypes: imageMimeTypes,
          },
          notes: `Creates an image Pin, or a carousel Pin of 2 to 5 images, on options.boardId. content.text is the description.${sandbox ? " Requests go to the sandbox, where Pins are visible only to their owner." : ""}`,
        },
        sandbox
          ? unavailable(
              "posts.publish",
              "unsupported-by-platform",
              "Pinterest's sandbox cannot create video Pins.",
            )
          : {
              platform: "pinterest",
              operation: "posts.publish",
              availability: "available" as const,
              formats: ["video" as const],
              requiredScopes: pinWriteScopes,
              constraints: {
                // The cover thumbnail is an HTTPS URL; the video itself must be a Blob.
                mediaSources: ["blob" as const, "https-url" as const],
                maxItems: 1,
                maxBytes: maxVideoBytes,
                maxDurationSeconds: maxVideoSeconds,
                allowedMimeTypes: videoMimeTypes,
              },
              notes:
                "Registers the upload, sends the Blob, reads the media status once and creates the Pin when it has succeeded. Otherwise the outcome is processing; native.continueVideoPin creates the Pin once the upload has succeeded. Needs an HTTPS thumbnail for the cover.",
            },
        sandbox
          ? unavailable(
              "posts.status",
              "unsupported-by-platform",
              "Only video Pins have a delivery status, and Pinterest's sandbox cannot create them.",
            )
          : {
              platform: "pinterest",
              operation: "posts.status",
              availability: "available" as const,
              // GET /v5/media/{media_id} needs pins:read.
              requiredScopes: ["pins:read"],
              notes:
                "Read-only. Reports a stored video Pin result, or one media status read; MEDIA_READY means native.continueVideoPin can create the Pin.",
            },
        {
          platform: "pinterest",
          operation: "posts.removeFromPlatform",
          availability: "available" as const,
          requiredScopes: pinWriteScopes,
          notes: "DELETE /v5/pins/{pin_id}.",
        },
        {
          platform: "pinterest",
          operation: "accounts.read",
          availability: "available" as const,
          requiredScopes: ["user_accounts:read"],
        },
        sandbox
          ? unavailable(
              "posts.publish.continue",
              "unsupported-by-platform",
              "Pinterest's sandbox cannot create video Pins.",
            )
          : {
              platform: "pinterest",
              operation: "posts.publish.continue",
              availability: "available" as const,
              requiredScopes: pinWriteScopes,
              notes:
                "native.continueVideoPin: the write that creates a processed video Pin. It bypasses normalized authorization, so gate it like posts.publish.",
            },
        {
          platform: "pinterest",
          operation: "boards.read",
          availability: "available" as const,
          requiredScopes: ["boards:read"],
          notes: "native.listBoards reads public and protected boards, for options.boardId.",
        },
        unavailable(
          "posts.schedule",
          "unsupported-by-platform",
          "Pinterest's API creates Pins immediately; it has no publish-time field.",
        ),
        unavailable(
          "boards.secret.read",
          "not-implemented-by-adapter",
          "Secret boards need the boards:read_secret scope and are not listed.",
        ),
        unavailable(
          "posts.read",
          "not-implemented-by-adapter",
          "GET /v5/pins/{pin_id} is not mapped.",
        ),
        unavailable(
          "posts.update",
          "not-implemented-by-adapter",
          "PATCH /v5/pins/{pin_id} is not mapped.",
        ),
        unavailable(
          "analytics.read",
          "not-implemented-by-adapter",
          "Pin and account analytics are not mapped.",
        ),
        unavailable(
          "comments.read",
          "unsupported-by-platform",
          "Pinterest API v5 has no Pin comment endpoints.",
        ),
        unavailable(
          "webhooks.verify",
          "not-implemented-by-adapter",
          "Pinterest webhooks are not mapped.",
        ),
        unavailable("ads.manage", "not-implemented-by-adapter", "Ads endpoints are not mapped."),
        unavailable(
          "catalogs.manage",
          "not-implemented-by-adapter",
          "Catalog endpoints are not mapped.",
        ),
      ],
    },
    accounts: {
      async list(
        _input: { readonly cursor?: string; readonly limit?: number },
        context: AdapterOperationContext,
      ) {
        return { items: [await readAccount(context)] };
      },
      async get(ref: ConnectedAccountRef, context: AdapterOperationContext) {
        authorize(ref, context);

        return readAccount(context);
      },
    },
    posts: {
      prepareTarget(target: PreparedPublishTarget) {
        return plan(target).issues;
      },
      async publishTarget(
        target: PreparedPublishTarget,
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        authorize(target.account, context);
        const prepared = plan(target);

        if (prepared.issues.length > 0)
          throw new SocialError({
            code: "invalid_input",
            operation: "pinterest.posts.publish",
            message: "The Pinterest target did not pass preparation.",
            issues: prepared.issues,
          });

        if (prepared.video === undefined) {
          const pinId = await createPin(await withBase64(prepared.pin, prepared.blobs), context);

          return { ...published(target.account, pinId), targetIndex: target.targetIndex };
        }

        const registration = await registerVideo(context);
        const { mediaId } = registration;
        const base = { targetIndex: target.targetIndex, account: target.account, mediaId };
        let workflow: PinterestVideoWorkflow;

        // The workflow is saved before the file is sent, so every outcome after the upload
        // starts keeps a delivery reference.
        try {
          workflow = await workflows.create({
            backend: target.account.backend,
            accountId: target.account.accountId,
            mediaId,
            pin: prepared.pin,
            stage: "processing",
          });
        } catch {
          return {
            ...base,
            observedAt: now(),
            state: "failed",
            code: "upstream_failure",
            message:
              "The workflow store did not save the video workflow, so the video was not uploaded. No Pin was created.",
            retryDisposition: { kind: "never" },
          };
        }

        const delivery = deliveryRef(target.account, workflow.id);
        const sent = await sendVideo(registration, prepared.video, context);

        if (sent instanceof SocialError) {
          await workflows.update(workflow.id, { stage: "failed" }).catch(() => undefined);

          return {
            ...base,
            delivery,
            observedAt: now(),
            state: "failed",
            code: sent.code,
            message: sent.message,
            retryDisposition: { kind: "never" },
          };
        }

        if (sent === "unconfirmed")
          return {
            ...base,
            delivery,
            observedAt: now(),
            state: "unknown",
            reason: "ambiguous-submission",
            diagnostic:
              "The video upload was sent without a confirmed answer. posts.getDelivery reads its media status; no Pin was requested.",
          };

        try {
          return {
            ...(await resume(workflow.id, target.account, context, true)),
            targetIndex: target.targetIndex,
          };
        } catch (error) {
          // Every error that leaves resume came before the Pin request or after a stated
          // rejection, so no Pin exists; the saved workflow says whether it can be continued.
          return {
            ...base,
            delivery,
            observedAt: now(),
            state: "failed",
            code: error instanceof SocialError ? error.code : "upstream_failure",
            message: "The video Pin could not be continued. Check it with posts.getDelivery.",
            retryDisposition: { kind: "reconcile-first" },
          };
        }
      },
      /** Read-only: reports the stored result or the media status, and never creates a Pin. */
      async getDelivery(
        ref: DeliveryRef,
        context: AdapterOperationContext,
      ): Promise<DeliveryOutcome> {
        authorize(ref, context);
        rejectSandboxVideo("pinterest.posts.status");
        const { workflow, account } = await loadWorkflow(ref, "pinterest.posts.status");

        return settled(workflow, account) ?? (await videoStatus(workflow, account, context));
      },
      async removeFromPlatform(
        ref: PlatformPostRef,
        context: AdapterOperationContext,
      ): Promise<void> {
        authorize(ref, context);

        if (!numericId(ref.postId))
          throw new SocialError({
            code: "invalid_input",
            operation: "pinterest.posts.removeFromPlatform",
            message: "Pinterest Pin IDs are numeric.",
          });

        const answer = await exchange(
          `/pins/${encodeURIComponent(ref.postId)}`,
          context,
          undefined,
          {},
          "DELETE",
        );

        const body = answer.body;

        // Pinterest documents 204 No Content, or 200 with the deleted Pin, whose ID must match.
        if (
          answer.status !== 204 &&
          !(answer.status === 200 && isJsonObject(body) && body["id"] === ref.postId)
        )
          throw new SocialError({
            code: "ambiguous_outcome",
            operation: "pinterest.posts.removeFromPlatform",
            message:
              "Pinterest returned an unreadable answer to the deletion. Reconcile before retrying.",
            retryDisposition: { kind: "reconcile-first" },
          });
      },
    },
    native: {
      async continueVideoPin(input: PinterestContinueVideoInput): Promise<DeliveryOutcome> {
        authorize(input.delivery, input.context);
        rejectSandboxVideo("pinterest.posts.publish");
        const { workflow, account } = await loadWorkflow(input.delivery, "pinterest.posts.publish");

        return (
          settled(workflow, account) ?? (await resume(workflow.id, account, input.context, false))
        );
      },
      async listBoards(input: PinterestListBoardsInput): Promise<Page<JsonObject>> {
        authorize(input.account, input.context);
        const limit = input.limit ?? 25;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250)
          throw new SocialError({
            code: "invalid_input",
            operation: "pinterest.boards.read",
            message: "Pinterest board pages hold 1 to 250 boards.",
          });

        if (
          input.privacy !== undefined &&
          input.privacy !== "PUBLIC" &&
          input.privacy !== "PROTECTED"
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "pinterest.boards.read",
            message: "List PUBLIC or PROTECTED boards. Secret boards are not supported.",
          });

        const result = object(
          await request("/boards", input.context, undefined, {
            page_size: String(limit),
            ...definedFields({ bookmark: input.cursor, privacy: input.privacy }),
          }),
        );

        // Without a privacy filter Pinterest returns every board the token may read, which
        // includes secret boards when it holds boards:read_secret. Keep only boards Pinterest marks
        // public or protected, so a missing or new privacy value is never passed through.
        const items = array(result["items"])
          .map((board) => publicFields(board, boardFields))
          .filter((board) => board["privacy"] === "PUBLIC" || board["privacy"] === "PROTECTED");

        if (items.some((board) => !numericId(board["id"])))
          throw new SocialError({
            code: "upstream_failure",
            operation: "pinterest.boards.read",
            message: "Pinterest returned a board without a numeric ID.",
          });

        const bookmark = result["bookmark"];

        return {
          items,
          ...definedFields({
            nextCursor: isString(bookmark) && bookmark !== "" ? bookmark : undefined,
          }),
        };
      },
    },
  });
}
