import type {
  InstagramAudioConfigurationOption,
  ManagedBlueskyPublishOptions,
  ManagedFacebookPublishOptions,
  ManagedInstagramPublishOptions,
  ManagedLinkedInPublishOptions,
  ManagedThreadsPublishOptions,
  ManagedTikTokPublishOptions,
  ManagedXPublishOptions,
  ManagedYouTubePublishOptions,
} from "./publish-options.js";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type KnownPlatform =
  | "bluesky"
  | "discord"
  | "facebook"
  | "google-business"
  | "instagram"
  | "linkedin"
  | "mastodon"
  | "pinterest"
  | "reddit"
  | "snapchat"
  | "telegram"
  | "threads"
  | "tiktok"
  | "twitch"
  | "whatsapp"
  | "x"
  | "youtube";

export type Platform = KnownPlatform | (string & {});

interface ReferenceBase<K extends string> {
  readonly kind: K;
  readonly version: 1;
  readonly backend: string;
}

export interface ConnectedAccountRef<
  P extends Platform = Platform,
> extends ReferenceBase<"connected-account"> {
  readonly platform: P;
  readonly accountId: string;
}

export interface PublicationRef extends ReferenceBase<"publication"> {
  readonly publicationId: string;
}

export interface DeliveryRef extends ReferenceBase<"delivery"> {
  readonly deliveryId: string;
  readonly platform: Platform;
  readonly accountId: string;
}

export interface PlatformPostRef<
  P extends Platform = Platform,
> extends ReferenceBase<"platform-post"> {
  readonly platform: P;
  readonly accountId: string;
  readonly postId: string;
  /** Provider-native identifiers such as Bluesky's AT-URI/CID, when available. */
  readonly native?: JsonObject;
}

export interface BlueskyPlatformPostRef extends PlatformPostRef<"bluesky"> {
  readonly native: { readonly uri: string; readonly cid: string };
}

export interface ScheduledJobRef extends ReferenceBase<"scheduled-job"> {
  readonly jobId: string;
  readonly platform: Platform;
  readonly accountId: string;
}

/** Provider record identity; never a native platform post ID. */
export interface BackendPostRef extends ReferenceBase<"backend-post"> {
  readonly recordId: string;
  readonly platform: Platform;
  readonly accountId: string;
}

export interface ScheduleCancellation {
  readonly state: "cancelled";
  readonly backendRecord: "retained" | "deleted";
}

export interface MediaRef extends ReferenceBase<"media"> {
  readonly mediaId: string;
  readonly platform: Platform;
  readonly accountId: string;
}

export interface CommentRef extends ReferenceBase<"comment"> {
  readonly platform: Platform;
  readonly accountId: string;
  readonly postId: string;
  readonly commentId: string;
}

export interface ConversationRef extends ReferenceBase<"conversation"> {
  readonly platform: Platform;
  readonly accountId: string;
  readonly conversationId: string;
}

export type SocialRef =
  | ConnectedAccountRef
  | PublicationRef
  | DeliveryRef
  | PlatformPostRef
  | ScheduledJobRef
  | BackendPostRef
  | MediaRef
  | CommentRef
  | ConversationRef
  | ProfileRef;

export function connectedAccountRef<P extends Platform>(input: {
  backend: string;
  platform: P;
  accountId: string;
}): ConnectedAccountRef<P> {
  return { kind: "connected-account", version: 1, ...input };
}

export function platformPostRef<P extends Platform>(input: {
  backend: string;
  platform: P;
  accountId: string;
  postId: string;
}): PlatformPostRef<P> {
  return { kind: "platform-post", version: 1, ...input };
}

export type MediaInput =
  | { readonly kind: "https-url"; readonly url: string }
  | { readonly kind: "media-ref"; readonly ref: MediaRef }
  | {
      readonly kind: "blob";
      readonly blob: Blob;
      readonly fingerprint: string;
    }
  | {
      readonly kind: "stream";
      readonly open: () => ReadableStream<Uint8Array>;
      readonly fingerprint: string;
    };

export interface MediaAttachment {
  /** `document` covers paged files such as PDF, PPTX or DOCX where a platform accepts them. */
  readonly kind: "image" | "video" | "document";
  readonly source: MediaInput;
  readonly mimeType?: string;
  readonly filename?: string;
  readonly byteSize?: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly altText?: string;
  readonly caption?: string;
  readonly thumbnail?: MediaInput;
}

export interface LinkMetadata {
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
}

export interface PublishContent {
  readonly text?: string;
  readonly media?: readonly MediaAttachment[];
  readonly link?: LinkMetadata;
}

export interface TargetContentOverride {
  readonly text?: string;
  readonly media?: readonly MediaAttachment[];
  readonly link?: LinkMetadata;
}

/** Call-to-action buttons X renders on a media Post card (`media.call_to_actions`). */
export interface XMediaCallToActions {
  readonly visitSite?: { readonly url: string };
  readonly watchNow?: { readonly url: string };
  readonly appInstall?: {
    readonly appStoreId?: string;
    readonly ipadAppStoreId?: string;
    readonly playStoreId?: string;
  };
}

/**
 * Direct X publish options. Each maps to a `POST /2/tweets` body field; X decides
 * eligibility (Premium, Community membership, Super Follows, Ads API cards).
 * Managed backends accept only `replySettings`.
 */
export interface XPublishOptions extends ManagedXPublishOptions {
  readonly replySettings?: "everyone" | "following" | "mentionedUsers" | "subscribers" | "verified";
  /** Allow up to 25,000 weighted characters for an X Premium author instead of 280. */
  readonly longform?: boolean;
  /** Quote this post (`quote_tweet_id`). */
  readonly quotedPostId?: string;
  /** With `replyTo`, user IDs to leave out of the reply's mention list (`reply.exclude_reply_user_ids`). */
  readonly excludeReplyUserIds?: readonly string[];
  /**
   * With `replyTo`, sends `reply.auto_populate_reply_metadata`. X OpenAPI 2.173 says the field is
   * accepted for compatibility and dropped before the post is created.
   */
  readonly autoPopulateReplyMetadata?: boolean;
  /** Post into this Community (`community_id`). */
  readonly communityId?: string;
  /** Share an exclusive (Super Follows) post with all followers (`share_with_followers`). */
  readonly shareWithFollowers?: boolean;
  readonly paidPartnership?: boolean;
  readonly madeWithAi?: boolean;
  readonly forSuperFollowersOnly?: boolean;
  /** Geo-tag with an X place ID (`geo.place_id`). */
  readonly placeId?: string;
  readonly directMessageDeepLink?: string;
  /** A card URI created through the X Ads API (`card_uri`). */
  readonly cardUri?: string;
  /** Media card title and description (`media.title`, `media.description`). */
  readonly mediaTitle?: string;
  readonly mediaDescription?: string;
  /** Uploaded media ID used as the card preview image (`media.preview_media_id`). */
  readonly previewMediaId?: string;
  /** Keep media asset URLs from expiring and allow syndicated playback (`media.embeddable`). */
  readonly embeddable?: boolean;
  /** Up to 10 user IDs tagged in the attached media (`media.tagged_user_ids`). */
  readonly taggedUserIds?: readonly string[];
  readonly callToActions?: XMediaCallToActions;
}

export interface BlueskyPublishOptions extends ManagedBlueskyPublishOptions {
  readonly languages?: readonly string[];
  /** Explicit DID mentions using UTF-8 byte offsets; no implicit handle lookup. */
  readonly mentions?: readonly {
    readonly byteStart: number;
    readonly byteEnd: number;
    readonly did: string;
  }[];
  /** Post-level hashtags written to `record.tags` (at most 8, 64 graphemes each, no `#`). */
  readonly tags?: readonly string[];
  /** Self-labels (content warnings) written as `com.atproto.label.defs#selfLabels`. */
  readonly contentLabels?: readonly ("porn" | "sexual" | "nudity" | "graphic-media")[];
  /** Quote this post. Combined with media or a link card it becomes `recordWithMedia`. */
  readonly quote?: { readonly uri: string; readonly cid: string };
  /** Threadgate allow rules for a root post. An empty array lets nobody reply. */
  readonly replyControls?: readonly (
    | { readonly kind: "mention" | "follower" | "following" }
    | { readonly kind: "list"; readonly listUri: string }
  )[];
  /** Write a postgate with `disableRule` so nobody can quote the post. */
  readonly disableQuotes?: boolean;
  /**
   * WebVTT caption tracks for a video post (at most 20). Each file is a `text/vtt` blob of at
   * most 20,000 bytes, uploaded first with the Bluesky adapter's `native.uploadBlob`.
   */
  readonly videoCaptions?: readonly { readonly lang: string; readonly file: BlueskyBlobRef }[];
  /** Video presentation hint. `gif` asks clients to loop the video without controls. */
  readonly videoPresentation?: "default" | "gif";
  /** Thumbnail for the `content.link` card: an image/* blob of at most 1,000,000 bytes. */
  readonly linkThumbnail?: BlueskyBlobRef;
  /**
   * Record strongRefs that back the `content.link` card, written as `external.associatedRefs`.
   * Take them from the Bluesky adapter's `native.getEmbedExternalView`.
   */
  readonly linkAssociatedRefs?: readonly { readonly uri: string; readonly cid: string }[];
}

/** A blob reference returned by `com.atproto.repo.uploadBlob`. */
export interface BlueskyBlobRef {
  readonly $type: "blob";
  readonly ref: { readonly $link: string };
  readonly mimeType: string;
  readonly size: number;
}

/** Text styles Threads accepts in `text_attachment.text_with_styling_info`. */
export type ThreadsTextStyle = "bold" | "italic" | "highlight" | "underline" | "strikethrough";

/** A range in the post or attachment text, counted from zero. */
export interface ThreadsTextRange {
  readonly offset: number;
  readonly length: number;
}

export interface ThreadsPublishOptions extends ManagedThreadsPublishOptions {
  /** Who can reply (`reply_control`). */
  readonly replyControl?:
    | "everyone"
    | "accountsYouFollow"
    | "mentionedOnly"
    | "parentPostAuthorOnly"
    | "followersOnly";
  /** Holds new replies until the author approves them (`enable_reply_approvals`). */
  readonly enableReplyApprovals?: boolean;
  /** One topic, 1 to 50 characters without `.` or `&` (`topic_tag`). */
  readonly topicTag?: string;
  /** Quotes an existing Threads post (`quote_post_id`). */
  readonly quotePostId?: string;
  /** A poll on a text-only post: two to four options of 1 to 25 characters (`poll_attachment`). */
  readonly poll?: {
    readonly options:
      | readonly [string, string]
      | readonly [string, string, string]
      | readonly [string, string, string, string];
  };
  /** A GIPHY GIF on a text-only post (`gif_attachment`). */
  readonly gif?: { readonly gifId: string; readonly provider: "GIPHY" };
  /** Adds the AI info label (`is_made_with_ai`). */
  readonly isMadeWithAi?: boolean;
  /** Blurs every image or video in the post (`is_spoiler_media`). */
  readonly isSpoilerMedia?: boolean;
  /** Up to ten spoiler ranges in the post text (`text_entities`). */
  readonly spoilers?: readonly ThreadsTextRange[];
  /** Long-form text on a text-only post (`text_attachment`). */
  readonly textAttachment?: {
    readonly plaintext: string;
    readonly linkAttachmentUrl?: string;
    readonly styling?: readonly (ThreadsTextRange & {
      readonly styles: readonly ThreadsTextStyle[];
    })[];
  };
  /** A text-only post that Threads archives after 24 hours (`is_ghost_post`). */
  readonly isGhostPost?: boolean;
  /** A location ID from `native.locationSearch` (`location_id`). */
  readonly locationId?: string;
  /** ISO 3166-1 alpha-2 countries that may see the post (`allowlisted_country_codes`). */
  readonly allowlistedCountryCodes?: readonly string[];
  /** Also shares the post as a Story on the linked Instagram account (`crossreshare_to_ig`). */
  readonly shareToInstagramStory?: "light" | "dark";
  /**
   * Publishes a text-only post when its container is created (`auto_publish_text`), skipping
   * `threads_publish`. Threads does not document which ID that call returns, so the outcome
   * stays `unknown` until a status read confirms the post.
   */
  readonly autoPublishText?: boolean;
}

export interface YouTubePublishOptions extends ManagedYouTubePublishOptions {
  readonly title: string;
  /** Required by managed Buffer publishing; native YouTube can retain the channel default. */
  readonly categoryId?: string;
  readonly visibility: "private" | "unlisted" | "public";
  readonly madeForKids: boolean;
  /** Managed PostFast only: publish as a YouTube Short. Defaults to `false`. */
  readonly isShort?: boolean;
  /** Direct YouTube only: `snippet.tags`, at most 500 characters as YouTube counts them. */
  readonly tags?: readonly string[];
  /** Direct YouTube only: `snippet.defaultLanguage`, the BCP-47 language of title and description. */
  readonly defaultLanguage?: string;
  /** Direct YouTube only: `localizations`, keyed by BCP-47 language. Requires `defaultLanguage`. */
  readonly localizations?: Readonly<
    Record<string, { readonly title: string; readonly description?: string }>
  >;
  /** Direct YouTube only: `status.license`. */
  readonly license?: "youtube" | "creativeCommon";
  /** Direct YouTube only: `status.embeddable`. */
  readonly embeddable?: boolean;
  /** Direct YouTube only: `status.publicStatsViewable`. */
  readonly publicStatsViewable?: boolean;
  /** Direct YouTube only: `status.containsSyntheticMedia`, the altered or synthetic content disclosure. */
  readonly containsSyntheticMedia?: boolean;
  /** Direct YouTube only: `recordingDetails.recordingDate`, an ISO 8601 timestamp. */
  readonly recordingDate?: string;
  /** Direct YouTube only: the `notifySubscribers` query parameter. YouTube defaults to `true`. */
  readonly notifySubscribers?: boolean;
}

export interface TikTokPublishOptions extends ManagedTikTokPublishOptions {
  readonly privacy:
    | "SELF_ONLY"
    | "MUTUAL_FOLLOW_FRIENDS"
    | "FOLLOWER_OF_CREATOR"
    | "PUBLIC_TO_EVERYONE";
  readonly disableComments?: boolean;
  readonly disableDuet?: boolean;
  readonly disableStitch?: boolean;
  readonly brandedContent?: boolean;
  readonly ownBrand?: boolean;
  readonly aiGenerated: boolean;
  readonly draft: boolean;
  readonly photoCoverIndex?: number;
  /**
   * Video Direct Post only: the frame, in milliseconds from the start, that TikTok uses as the
   * cover (`post_info.video_cover_timestamp_ms`). TikTok uses the first frame when unset.
   */
  readonly videoCoverTimestampMs?: number;
  /**
   * Photo-post title (≤90). Zernio maps this onto `content` when set. Postiz keeps it only on an
   * inbox draft (`draft: true`).
   */
  readonly title?: string;
  /** Photo-post caption/description (≤4000). Zernio `platformSpecificData.description`. */
  readonly description?: string;
  /** Zernio-only: `"photo"` for image carousels. */
  readonly mediaType?: "photo";
  /**
   * Photo Direct Post only (`post_info.auto_add_music`): TikTok adds recommended music.
   * Defaults to false when unset. Inbox drafts (`draft: true`) reject it.
   */
  readonly autoAddMusic?: boolean;
  readonly consentGiven: boolean;
  readonly creatorInfo?: JsonObject;
}

/** A tagged Instagram user. `x` and `y` are 0 to 1 from the image's top-left corner. */
export interface InstagramUserTag {
  readonly username: string;
  readonly x: number;
  readonly y: number;
}

/** A Shopping product tag. `x` and `y` apply to images only. */
export interface InstagramProductTag {
  readonly productId: string;
  readonly x?: number;
  readonly y?: number;
}

/**
 * Native container fields for Instagram publishing. Each option applies only to the
 * container kinds Meta documents for it; the adapter rejects anything else before sending.
 */
export interface InstagramPublishOptions extends ManagedInstagramPublishOptions {
  /** Reels and carousel parent: `share_to_feed`. */
  readonly shareToFeed?: boolean;
  /** Reels: `cover_url`, a public HTTPS cover image. Overrides `thumbOffsetMs`. */
  readonly coverUrl?: string;
  /** Reels: `thumb_offset` in milliseconds from the start of the video. */
  readonly thumbOffsetMs?: number;
  /** Reels: `audio_name`, the name of original audio. */
  readonly audioName?: string;
  /** Reels: `trial_params`, shown only to non-followers until graduation. */
  readonly trial?: { readonly graduationStrategy: "MANUAL" | "SS_PERFORMANCE" };
  /** Image, Reel, or carousel parent: `collaborators`, up to 3 usernames. */
  readonly collaborators?: readonly string[];
  /** Single image: `user_tags`, each with a username and x/y position. */
  readonly userTags?: readonly InstagramUserTag[];
  /** Image, Reel, or carousel parent: `location_id`, a Facebook Page ID with location data. */
  readonly locationId?: string;
  /** Image, Reel, or carousel parent: `is_ai_generated`. Never on carousel children. */
  readonly isAiGenerated?: boolean;
  /** Facebook Login only: `is_paid_partnership`. */
  readonly isPaidPartnership?: boolean;
  /** Facebook Login only: `branded_content_sponsor_ids`, up to 2 Instagram user IDs. */
  readonly brandedContentSponsorIds?: readonly string[];
  /** Facebook Login only: `poll_attachment`. The caption becomes the poll question. */
  readonly poll?: {
    readonly options: readonly [string, string, ...string[]];
    /** `is_poll_duration_extended`: keep the poll open past the default 3 days. */
    readonly extendedDuration?: boolean;
  };
  /** Facebook Login only: `is_comment_prompt_used`. The caption becomes the prompt. */
  readonly commentPrompt?: boolean;
  /** Facebook Login only: `product_tags` on a single image or Reel, up to 5. */
  readonly productTags?: readonly InstagramProductTag[];
  /** Facebook Login only: `audio_configuration` for a Reel, from an `ig_audio` search result. */
  readonly audioConfiguration?: InstagramAudioConfigurationOption;
}

/**
 * A LinkedIn little-text annotation over the post text. `start` and `length` are JavaScript string
 * (UTF-16 code unit) offsets. A mention renders as `@[text](urn)`; a hashtag covers `#tag` and renders
 * as `{hashtag|\#|tag}`. Text outside annotations stays literal.
 */
export type LinkedInAnnotation =
  | {
      readonly kind: "mention";
      readonly start: number;
      readonly length: number;
      readonly urn: `urn:li:person:${string}` | `urn:li:organization:${string}`;
    }
  | { readonly kind: "hashtag"; readonly start: number; readonly length: number };

/** Organic organization-post targeting facets (`distribution.targetEntities`). */
export interface LinkedInTargeting {
  readonly geoLocations?: readonly `urn:li:geo:${string}`[];
  readonly seniorities?: readonly `urn:li:seniority:${string}`[];
  readonly industries?: readonly `urn:li:industry:${string}`[];
  readonly jobFunctions?: readonly `urn:li:function:${string}`[];
  readonly degrees?: readonly `urn:li:degree:${string}`[];
  readonly fieldsOfStudy?: readonly `urn:li:fieldOfStudy:${string}`[];
  /** School organizations. */
  readonly organizations?: readonly `urn:li:organization:${string}`[];
  readonly staffCountRanges?: readonly (
    | "SIZE_1"
    | "SIZE_2_TO_10"
    | "SIZE_11_TO_50"
    | "SIZE_51_TO_200"
    | "SIZE_201_TO_500"
    | "SIZE_501_TO_1000"
    | "SIZE_1001_TO_5000"
    | "SIZE_5001_TO_10000"
    | "SIZE_10001_OR_MORE"
  )[];
  /** Interface locales: lowercase ISO-639 `language`, optional uppercase ISO-3166 `country`. */
  readonly interfaceLocales?: readonly { readonly language: string; readonly country?: string }[];
}

export interface LinkedInPublishOptions extends ManagedLinkedInPublishOptions {
  /** `connections` (first-degree network) is for member authors only. */
  readonly visibility?: "connections" | "public";
  /** Sends `isReshareDisabledByAuthor: true` so the post cannot be reshared. */
  readonly disableReshare?: boolean;
  readonly annotations?: readonly LinkedInAnnotation[];
  /** Organization authors only; LinkedIn requires a target audience above 300 members. */
  readonly targeting?: LinkedInTargeting;
  /** An uploaded image used as `content.article.thumbnail` for a `content.link` post. */
  readonly articleThumbnail?: MediaRef;
}

/** Facebook `call_to_action.type` values from the page/feed reference. */
export type FacebookCallToActionType =
  | "BOOK_TRAVEL"
  | "BUY_NOW"
  | "CALL_NOW"
  | "DOWNLOAD"
  | "GET_DIRECTIONS"
  | "GET_QUOTE"
  | "INSTALL_APP"
  | "INSTALL_MOBILE_APP"
  | "LEARN_MORE"
  | "LIKE_PAGE"
  | "LISTEN_MUSIC"
  | "MESSAGE_PAGE"
  | "NO_BUTTON"
  | "OPEN_LINK"
  | "PLAY_GAME"
  | "SHOP_NOW"
  | "SIGN_UP"
  | "SUBSCRIBE"
  | "USE_APP"
  | "USE_MOBILE_APP"
  | "WATCH_MORE"
  | "WATCH_VIDEO";

/** Facebook `content_category` values from the page/videos reference. */
export type FacebookVideoContentCategory =
  | "BEAUTY_FASHION"
  | "BUSINESS"
  | "CARS_TRUCKS"
  | "COMEDY"
  | "CUTE_ANIMALS"
  | "ENTERTAINMENT"
  | "FAMILY"
  | "FOOD_HEALTH"
  | "HOME"
  | "LIFESTYLE"
  | "MUSIC"
  | "NEWS"
  | "POLITICS"
  | "SCIENCE"
  | "SPORTS"
  | "TECHNOLOGY"
  | "VIDEO_GAMING"
  | "OTHER";

/** A user tag on a single photo, positioned in percent from the photo's left and top edges. */
export type FacebookPhotoTag =
  | { readonly userId: string; readonly x: number; readonly y: number }
  | { readonly text: string; readonly x: number; readonly y: number };

/** `targeting`: restricts who can see the post. */
export interface FacebookAudienceTargeting {
  readonly ageMin?: 13 | 15 | 18 | 21 | 25;
  /** Meta's `geo_locations` object, passed through (countries, regions, cities). */
  readonly geoLocations?: JsonObject;
}

/** `feed_targeting`: changes who is likely to see the post in News Feed, without restricting it. */
export interface FacebookFeedTargeting {
  readonly ageMin?: number;
  readonly ageMax?: number;
  /** 1 is male, 2 is female; omit for both. */
  readonly genders?: readonly (1 | 2)[];
  readonly geoLocations?: JsonObject;
  readonly locales?: readonly number[];
}

export interface FacebookChildAttachment {
  readonly link: string;
  readonly picture: string;
  readonly name?: string;
  readonly description?: string;
}

/** A feeling or activity: Open Graph action type, object, and optional icon IDs. */
export interface FacebookFeeling {
  readonly actionTypeId: string;
  readonly objectId: string;
  readonly iconId?: string;
}

/** Options accepted in `targets[].options` for a Facebook Page target. */
export interface FacebookPublishOptions extends ManagedFacebookPublishOptions {
  /** Publish a single video through the Reels API. */
  readonly reel?: boolean;
  /** Page ID of a location (`place`) for feed posts, photos, and Reels. */
  readonly place?: string;
  /** User IDs tagged in a feed post (`tags`); requires `place`. */
  readonly tags?: readonly string[];
  /** Positioned user tags on a single photo (`tags` on /photos). */
  readonly photoTags?: readonly FacebookPhotoTag[];
  /** Upload a single photo or video without a feed story (`no_story`). */
  readonly noStory?: boolean;
  /** A past ISO time to backdate the post to (`backdated_time`). */
  readonly backdatedTime?: string;
  readonly backdatedTimeGranularity?: "year" | "month" | "day" | "hour" | "minute";
  readonly targeting?: FacebookAudienceTargeting;
  readonly feedTargeting?: FacebookFeedTargeting;
  /** A button on a link post (`call_to_action`); `link` defaults to the post link. */
  readonly callToAction?: {
    readonly type: FacebookCallToActionType;
    readonly link?: string;
  };
  /** Two to five links shown as a carousel (`child_attachments`). */
  readonly childAttachments?: readonly FacebookChildAttachment[];
  /** Set false to hide the carousel end card (`multi_share_end_card`). */
  readonly multiShareEndCard?: boolean;
  readonly feeling?: FacebookFeeling;
  /** Video or Reel title. */
  readonly title?: string;
  /** Keep a Page video out of search and feeds; only its permalink or embed shows it. */
  readonly secret?: boolean;
  readonly embeddable?: boolean;
  readonly hideFromNewsfeed?: boolean;
  readonly contentCategory?: FacebookVideoContentCategory;
  /** Interest IDs that describe a Page video (`content_tags`). */
  readonly contentTags?: readonly string[];
  /** Labels used only to group the video in Insights (`custom_labels`). */
  readonly customLabels?: readonly string[];
  /** Upload a Blob video through a chunked upload session even when it is small. */
  readonly chunkedUpload?: boolean;
  /** Leave the Reel as a draft instead of publishing it. */
  readonly draft?: boolean;
  /** Disclose that the Reel was made or edited with AI (`is_ai_generated`). */
  readonly isAiGenerated?: boolean;
  /** Branded content: the sponsoring Page tagged on a photo or video (`sponsor_id`). */
  readonly sponsorId?: string;
  /** Meta's numeric `sponsor_relationship`, such as Paid Partnership With. */
  readonly sponsorRelationship?: number;
  /** Upload a single photo into one of the Page's albums (`POST /{album-id}/photos`). */
  readonly albumId?: string;
  /** Treat a photo with Photo Sphere metadata as a 360 photo (`allow_spherical_photo`). */
  readonly allowSphericalPhoto?: boolean;
  /** Photo Sphere fields such as `ProjectionType` that override embedded metadata. */
  readonly sphericalMetadata?: JsonObject;
  /** Mark a video as 360 (`spherical`) with its starting view and projection. */
  readonly sphericalVideo?: FacebookSphericalVideo;
  /** Per-language video descriptions (`multilingual_data`). */
  readonly multilingual?: readonly { readonly locale: string; readonly text: string }[];
  /** Replace the file of an existing Page video, keeping its engagement (`replace_video_id`). */
  readonly replaceVideoId?: string;
  /** Hide (`expire_only`) or delete (`expire_and_delete`) the video at an ISO time. */
  readonly expiration?: {
    readonly at: string;
    readonly type: "expire_and_delete" | "expire_only";
  };
}

/** 360 video fields from the page/videos reference. */
export interface FacebookSphericalVideo {
  /** Horizontal starting view in degrees (`initial_heading`). */
  readonly initialHeading?: number;
  /** Vertical starting view in degrees (`initial_pitch`). */
  readonly initialPitch?: number;
  /** Vertical field of view in degrees (`fov`). */
  readonly fov?: number;
  readonly projection?: "equirectangular" | "cubemap" | "half_equirectangular";
}

export type PublishOptionsFor<P extends Platform> = P extends "x"
  ? XPublishOptions
  : P extends "bluesky"
    ? BlueskyPublishOptions
    : P extends "threads"
      ? ThreadsPublishOptions
      : P extends "youtube"
        ? YouTubePublishOptions
        : P extends "tiktok"
          ? TikTokPublishOptions
          : P extends "instagram"
            ? InstagramPublishOptions
            : P extends "linkedin"
              ? LinkedInPublishOptions
              : P extends "facebook"
                ? FacebookPublishOptions
                : JsonObject;

export interface PublishTarget<P extends Platform = Platform> {
  readonly account: ConnectedAccountRef<P>;
  readonly content?: TargetContentOverride;
  readonly replyTo?: CommentRef | PlatformPostRef;
  readonly options?: PublishOptionsFor<P>;
}

export interface PublishRequest {
  readonly targets: readonly PublishTarget[];
  readonly content: PublishContent;
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
  readonly schedule?: { readonly at: string; readonly timeZone?: string };
  readonly replyTo?: CommentRef | PlatformPostRef;
}

/** Preserve the relationship between each literal platform and its options. */
export type CheckedPublishTargets<T extends readonly PublishTarget[]> = {
  readonly [K in keyof T]: Omit<T[K], "options"> & {
    readonly options?: PublishOptionsFor<T[K]["account"]["platform"]>;
  };
};

export type CheckedPublishRequest<T extends PublishRequest> = T & {
  readonly targets: CheckedPublishTargets<NoInfer<T["targets"]>>;
};

export interface PublishSequenceRequest {
  readonly items: readonly {
    readonly targets: readonly PublishTarget[];
    readonly content: PublishContent;
    readonly replyTo?: CommentRef | PlatformPostRef;
  }[];
  readonly idempotencyKey: string;
  readonly stopOnFailure?: boolean;
  /**
   * Reply each item to the previous item's post on the same account. Several
   * destinations form independent chains: a destination whose previous link was not
   * published gets a `not-submitted` outcome while the other chains continue.
   */
  readonly replyToPrevious?: boolean;
}

export interface PublishSequenceFailure {
  /** Position of the failed item in the request's `items`. */
  readonly index: number;
  readonly code: string;
  readonly message: string;
}

export interface PublishSequenceResult {
  readonly status: PublicationStatus;
  /** Returned publish results in request order, including results with failed outcomes.
   * Items whose publish call throws a SocialError are omitted and recorded by index in `failures`.
   * Items skipped after stopping or missing a published parent appear in neither array. */
  readonly items: readonly PublishResult[];
  readonly failures: readonly PublishSequenceFailure[];
}

export interface PreparedPublishTarget {
  readonly targetIndex: number;
  readonly targetKey: string;
  readonly account: ConnectedAccountRef;
  readonly content: PublishContent;
  readonly options?: unknown;
  readonly schedule?: PublishRequest["schedule"];
  readonly replyTo?: PublishRequest["replyTo"];
}

export interface PreparationIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly targetIndex?: number;
  readonly severity: "error" | "warning";
}

export interface PublishPreparation {
  readonly ok: boolean;
  readonly targets: readonly PreparedPublishTarget[];
  readonly issues: readonly PreparationIssue[];
}

interface OutcomeBase<S extends string> {
  readonly state: S;
  readonly targetIndex: number;
  readonly account: ConnectedAccountRef;
  readonly delivery?: DeliveryRef;
  readonly backendState?: string;
  readonly observedAt: string;
  /** SDK recovery attempt identity, persisted to fence stale retries and observations. */
  readonly retryAttemptId?: string;
}

export type DeliveryOutcome =
  | (OutcomeBase<"not-submitted"> & {
      readonly reason:
        | "validation"
        | "unauthorized"
        | "idempotency-conflict"
        | "capacity"
        | "before-submission";
      readonly issues?: readonly PreparationIssue[];
    })
  | (OutcomeBase<"scheduled"> & { readonly job: ScheduledJobRef })
  | (OutcomeBase<"accepted"> & {
      /**
       * Native post IDs when one delivery produced several public posts, such as a TikTok
       * inbox draft the creator posted more than once. `published` needs exactly one post.
       */
      readonly postIds?: readonly string[];
    })
  | OutcomeBase<"processing">
  | (OutcomeBase<"published"> & {
      readonly post: PlatformPostRef;
      readonly url?: string;
      /**
       * Provider warnings about parts of the request that were dropped although the post went
       * live, such as an Instagram caption or poll that did not attach. Always `warning` severity.
       */
      readonly issues?: readonly PreparationIssue[];
    })
  | (OutcomeBase<"failed"> & {
      /** Opaque upload ID retained for media recovery before another submission. */
      readonly mediaId?: string;
      readonly code: string;
      readonly message: string;
      readonly retryDisposition: RetryDisposition;
    })
  | (OutcomeBase<"cancelled"> & { readonly reason?: string })
  | (OutcomeBase<"unknown"> & {
      /** Opaque upload ID retained for media recovery before another submission. */
      readonly mediaId?: string;
      readonly reason: "ambiguous-submission" | "unmapped-state";
      readonly diagnostic?: string;
    });

export type PublicationStatus = "pending" | "complete" | "partial";

/** A publish warning that does not change any delivery outcome. */
export interface PublishWarning {
  /** The idempotency store could not save this target's outcome, so a retry may not replay it. */
  readonly code: "idempotency-outcome-not-persisted";
  readonly targetIndex: number;
}

/** Sanitized persistence diagnostic. It never carries storage errors, keys, or account identity. */
export interface PersistenceDiagnostic {
  readonly code: PublishWarning["code"];
  readonly operation: "posts.publish" | "posts.schedule";
  readonly targetIndex: number;
}

export interface PublishResult {
  readonly status: PublicationStatus;
  readonly publication: PublicationRef;
  readonly outcomes: readonly DeliveryOutcome[];
  /** Present only when at least one warning was recorded. */
  readonly warnings?: readonly PublishWarning[];
}

export type RetryDisposition =
  | { readonly kind: "never" }
  | { readonly kind: "after-delay"; readonly delayMs: number }
  | { readonly kind: "after-reconnect" }
  | { readonly kind: "reconcile-first" };

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly metadata?: JsonObject;
}

/** Account-scoped search for provider posts. Provider-specific filters remain in the query syntax. */
export interface SearchPostsInput {
  readonly query: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly startTime?: string;
  readonly endTime?: string;
  /** Provider search horizon. Adapters may reject unsupported horizons. */
  readonly scope?: "recent" | "all";
}

/**
 * Provider-neutral metric names. Adapters keep the provider's own `name` and
 * add `canonicalName` only when the provider metric means the same thing.
 */
export type CanonicalMetricName =
  | "views"
  | "likes"
  | "comments"
  | "shares"
  | "impressions"
  | "reach"
  | "saves"
  | "clicks"
  | "followers"
  | "profile_views";

export interface MetricValue {
  readonly name: string;
  /** Present only when `name` maps to a provider-neutral metric. */
  readonly canonicalName?: CanonicalMetricName;
  readonly value: number;
  readonly unit: "count" | "milliseconds" | "percentage" | "seconds";
  readonly period: "lifetime" | "unknown" | { readonly from: string; readonly to: string };
  readonly measuredAt?: string;
  readonly fetchedAt?: string;
  readonly freshness?: "reported" | "unknown";
  readonly source: string;
}

/**
 * A bounded, account-scoped analytics query that adapters can honor without
 * inventing historical values. Dates use the provider-neutral YYYY-MM-DD
 * representation; providers may expose fewer metrics or dimensions.
 */
export interface AnalyticsReportQuery {
  readonly from: string;
  readonly to: string;
  readonly metrics: readonly string[];
  readonly dimensions?: readonly string[];
}

export interface AnalyticsReportRow {
  readonly dimensions: JsonObject;
  readonly metrics: Readonly<Record<string, number>>;
}

export interface AnalyticsReport {
  readonly query: AnalyticsReportQuery;
  readonly rows: readonly AnalyticsReportRow[];
  readonly fetchedAt: string;
  readonly source: string;
}

export type CapabilityAvailability =
  | "available"
  | "unsupported-by-platform"
  | "not-implemented-by-adapter"
  | "permission-required"
  | "reconnect-required"
  | "account-ineligible"
  | "runtime-unavailable"
  | "approval-dependent"
  | "unknown-until-request";

export type CapabilitySurface = "normalized" | "native";

export type CapabilityMediaSource = MediaInput["kind"];

export interface CapabilityConstraints {
  readonly eligibility?: readonly string[];
  readonly approval?: readonly string[];
  readonly scopes?: readonly string[];
  readonly mediaSources?: readonly CapabilityMediaSource[];
  /** Largest accepted attachment, in bytes. */
  readonly maxBytes?: number;
  /** Most attachments accepted in one post. */
  readonly maxItems?: number;
  /** Exact MIME types, or `type/*` wildcards such as `image/*`. */
  readonly allowedMimeTypes?: readonly string[];
  /** Inclusive width/height range for images and videos, such as `[0.8, 1.91]`. */
  readonly aspectRatioRange?: readonly [min: number, max: number];
  /** Longest accepted video, in seconds. */
  readonly maxDurationSeconds?: number;
}

export interface CapabilityDeclaration {
  readonly operation: string;
  readonly platform: Platform | "*";
  readonly availability: CapabilityAvailability;
  readonly surface?: CapabilitySurface;
  readonly formats?: readonly ("text" | "image" | "video" | "carousel" | "sequence" | "document")[];
  readonly requiredScopes?: readonly string[];
  readonly constraints?: CapabilityConstraints;
  readonly notes?: string;
}

export interface CapabilityManifest {
  readonly schemaVersion: 1;
  readonly backend: string;
  readonly apiRevision: string;
  readonly runtime: readonly string[];
  readonly capabilities: readonly CapabilityDeclaration[];
}

export interface AccountRecord {
  readonly ref: ConnectedAccountRef;
  readonly displayName: string;
  readonly handle?: string;
  readonly status: "connected" | "reconnect-required" | "revoked" | "unknown";
  /** Provider-specific account fields the adapter keeps, such as PostFast's `disabledReason`. */
  readonly native?: JsonObject;
}

/** A provider profile addressed from a connected account. */
export interface ProfileRef extends ReferenceBase<"profile"> {
  readonly platform: Platform;
  readonly accountId: string;
  /** Provider-native actor/user identifier. */
  readonly profileId: string;
}

/** Normalized public profile fields. Provider-specific fields stay in `native`. */
export interface ProfileRecord {
  readonly ref: ProfileRef;
  readonly displayName?: string;
  readonly handle?: string;
  readonly avatarUrl?: string;
  readonly bio?: string;
  readonly native?: JsonObject;
}

export type RelationshipKind = "following" | "follower" | "blocked" | "muted";

export interface RelationshipRecord {
  readonly profile: ProfileRef;
  readonly relationship: RelationshipKind;
  readonly since?: string;
}

export function profileRef(input: {
  backend: string;
  platform: Platform;
  accountId: string;
  profileId: string;
}): ProfileRef {
  return {
    kind: "profile",
    version: 1,
    backend: input.backend,
    platform: input.platform,
    accountId: input.accountId,
    profileId: input.profileId,
  };
}

export interface AuthorizationContext {
  readonly tenantId?: string;
  readonly principalId?: string;
  readonly attributes?: JsonObject;
}

export interface RetryBudget {
  readonly maxAttempts: number;
  readonly maxElapsedMs: number;
}

export interface OperationContext {
  readonly signal?: AbortSignal;
  readonly correlationId: string;
  readonly authorization?: AuthorizationContext;
  readonly retryBudget: RetryBudget;
  readonly idempotencyKey?: string;
}

export interface AdapterOperationContext extends OperationContext {
  readonly backendInstance: string;
  readonly targetIdempotencyKey?: string;
}

export type OperationName =
  | "posts.publish"
  | "posts.update"
  | "posts.delete"
  | "posts.schedule"
  | "accounts.read"
  | "profiles.read"
  | "graph.read"
  | "graph.follow"
  | "graph.unfollow"
  | "graph.block"
  | "graph.unblock"
  | "graph.mute"
  | "graph.unmute"
  | "posts.read"
  | "posts.list"
  | "posts.get"
  | "posts.getDelivery"
  | "posts.status"
  | "media.upload"
  | "search.posts"
  | "analytics.read"
  | "analytics.account.read"
  | "analytics.report.read"
  | "comments.read"
  | "comments.write"
  | "comments.moderate"
  | "comments.delete"
  | "messages.read"
  | "messages.write"
  | "notifications.read"
  | "notifications.seen"
  | "posts.cancelScheduled"
  | "posts.deleteBackendRecord"
  | "posts.removeFromPlatform"
  | "webhooks.verify"
  | "native";
