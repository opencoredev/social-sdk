/**
 * Publish options that managed backends map onto their own wire fields. Each
 * platform's option interface in `types.ts` extends one of these. An adapter
 * that has no mapping for a supplied key rejects it at preparation
 * (`options.unmapped`) instead of dropping it, so a key listed here is never
 * silently ignored. The provider pages under `docs/backends` list which
 * backend maps which key.
 */

/** One later post in a thread. The target's own content is the first post. */
export interface ThreadItemOption {
  readonly text?: string;
  /** Public HTTPS media for this post. Uploads go through `content.media` on the first post. */
  readonly media?: readonly {
    readonly kind: "image" | "video";
    readonly url: string;
    readonly altText?: string;
  }[];
}

/** Uppercase ISO 3166-1 alpha-2 country codes, at most 25. */
export interface GeoRestrictionOption {
  readonly countries: readonly string[];
}

/**
 * Post for Me: one media tag (`UserTagDto`), sent as given. Post for Me calls `x` and `y` a
 * "percentage distance" from the left and top edges without stating the scale, so the SDK
 * checks they are finite numbers and forwards them unchanged. Not the 0 to 1 `userTags` of the
 * direct Instagram adapter.
 */
export interface PostForMeMediaTagOption {
  /** A Facebook user ID, an Instagram username or an Instagram product ID. */
  readonly id: string;
  /** `product` is Instagram only. */
  readonly type: "user" | "product";
  /** Must match the target's platform. */
  readonly platform: "facebook" | "instagram";
  /** Distance from the left edge, in Post for Me's unstated percentage scale. Not for videos or stories. */
  readonly x?: number;
  /** Distance from the top edge, in Post for Me's unstated percentage scale. Not for videos or stories. */
  readonly y?: number;
}

/** Options for one attachment, matched to the target's media by position. */
export interface ManagedMediaItemOption {
  /** Post for Me: post the file as-is, without processing (`skip_processing`). For large files. */
  readonly skipProcessing?: boolean;
  /** Post for Me, Facebook and Instagram targets: user and product tags on this attachment (`tags`). */
  readonly tags?: readonly PostForMeMediaTagOption[];
  /** Zernio: SRT or WebVTT closed captions for a video (`subtitles`), one file per language. */
  readonly subtitles?: readonly { readonly url: string; readonly language: string }[];
}

/** Zernio evergreen recycling: repost copies of the post on a fixed gap (`recycling`). */
export interface RecyclingOption {
  /** Interval units between copies, at least 1. */
  readonly gap: number;
  /** Interval unit; Zernio defaults to `month`. */
  readonly gapFreq?: "week" | "month";
  /** ISO 8601 start of the cycle; defaults to the post's scheduled time. */
  readonly startDate?: string;
  /** Stop after this many copies. */
  readonly expireCount?: number;
  /** ISO 8601 time after which no copies are made. */
  readonly expireDate?: string;
  /** 2 to 20 texts used in turn for the copies. */
  readonly contentVariations?: readonly string[];
}

/** Options every managed platform option set shares. */
export interface ManagedCommonPublishOptions {
  /** One entry per attachment, in media order; use `{}` for an attachment with no options. */
  readonly mediaOptions?: readonly ManagedMediaItemOption[];
  /** Zernio: repost this post on a schedule. */
  readonly recycling?: RecyclingOption;
}

export interface ManagedXPublishOptions extends ManagedCommonPublishOptions {
  /** Quote this X post ID. Zernio `quoteTweetId`, Post for Me `quote_tweet_id`. */
  readonly quotePostId?: string;
  /** Two to four choices of 1 to 25 characters, open for 5 to 10080 minutes. No media, quote or thread. */
  readonly poll?: { readonly options: readonly string[]; readonly durationMinutes: number };
  /** Post into this X Community. Post for Me `community_id`. */
  readonly communityId?: string;
  /** Zernio: X's paid-partnership label. */
  readonly paidPartnership?: boolean;
  /** Zernio: X's AI-generated media label. */
  readonly madeWithAi?: boolean;
  /** Zernio: mark attached media as sensitive. At least one flag must be true. */
  readonly sensitiveMedia?: {
    readonly adultContent?: boolean;
    readonly graphicViolence?: boolean;
    readonly other?: boolean;
  };
  /** Zernio: hide attached media outside these countries. */
  readonly geoRestriction?: GeoRestrictionOption;
  /** Zernio: later posts of a thread, sent as one `threadItems` sequence. */
  readonly threadItems?: readonly ThreadItemOption[];
  /** PostFast: repost this X post URL at the scheduled time (`xRetweetUrl`). */
  readonly repostUrl?: string;
  /** PostFast: posted as the first reply about ten seconds after publication. */
  readonly firstComment?: string;
  /** Zernio: upload video with X's `amplify_video` category (`longVideo`); paid X accounts only. */
  readonly longVideo?: boolean;
  /** Zernio: up to 10 X usernames tagged on the post's photos (`mediaTaggedUsers`). */
  readonly mediaTaggedUsers?: readonly string[];
}

export interface ManagedBlueskyPublishOptions extends ManagedCommonPublishOptions {
  /** Zernio: later posts of a thread, sent as one `threadItems` sequence. */
  readonly threadItems?: readonly ThreadItemOption[];
}

export interface ManagedThreadsPublishOptions extends ManagedCommonPublishOptions {
  /** One topic of 1 to 50 characters without `.` or `&`. Zernio `topic_tag`, PostFast `threadsTopicTag`. */
  readonly topicTag?: string;
  /** Zernio: later posts of a thread, sent as one `threadItems` sequence. */
  readonly threadItems?: readonly ThreadItemOption[];
  /** Zernio and PostFast: a reply posted right after publication, up to 500 characters. */
  readonly firstComment?: string;
  /**
   * Post for Me: Threads post placement (`placement`), sent unchanged. Post for Me does not
   * explain what `reels` means for Threads, so the SDK does not interpret either value.
   */
  readonly placement?: "reels" | "timeline";
}

export interface ManagedYouTubePublishOptions extends ManagedCommonPublishOptions {
  /** Each tag up to 100 characters, 500 combined. */
  readonly tags?: readonly string[];
  /** Add the uploaded video to this playlist. */
  readonly playlistId?: string;
  /** YouTube's altered or synthetic content disclosure. */
  readonly containsSyntheticMedia?: boolean;
  /** Post for Me: YouTube's paid product placement disclosure. */
  readonly paidProductPlacement?: boolean;
  /** Zernio and PostFast: a comment posted after publication. Zernio also pins it. */
  readonly firstComment?: string;
  /** PostFast: the video's BCP-47 language, such as `en` or `pt-BR` (`youtubeLanguage`). */
  readonly language?: string;
  /** PostFast: key of an SRT or VTT file from `native.uploadCaptions`; needs `language`. */
  readonly captionKey?: string;
  /** Zernio: `false` uploads without notifying subscribers (`notifySubscribers`). */
  readonly notifySubscribers?: boolean;
}

export interface ManagedTikTokPublishOptions extends ManagedCommonPublishOptions {
  /** A licensed track ID. Zernio `musicSoundInfo.musicSoundId`, PostFast `tiktokMusicSoundId`. */
  readonly musicSoundId?: string;
  /** Zernio, video only: the frame at this offset becomes the cover (`videoCoverTimestampMs`). */
  readonly coverTimestampMs?: number;
  /** Zernio, video only: a JPG, PNG or WebP cover image URL (`videoCoverImageUrl`). */
  readonly coverImageUrl?: string;
  /** PostFast: posted as a comment after publication, up to 1,200 characters. */
  readonly firstComment?: string;
}

export interface InstagramUserTagOption {
  readonly username: string;
  /** 0.0 to 1.0 from the left edge. Required for images. */
  readonly x?: number;
  /** 0.0 to 1.0 from the top edge. Required for images. */
  readonly y?: number;
  /** Zernio: zero-based carousel slide. */
  readonly mediaIndex?: number;
}

/** A catalog track for an Instagram Reel, with the track and original-sound volumes. */
export interface InstagramAudioConfigurationOption {
  readonly audioId: string;
  readonly audioVolume?: number;
  readonly videoVolume?: number;
}

export interface ManagedInstagramPublishOptions extends ManagedCommonPublishOptions {
  /** `feed` (default), `story`, or `reels` for one video published as a Reel. */
  readonly placement?: "feed" | "story" | "reels";
  /** Up to three public Business or Creator usernames. Not for Stories. */
  readonly collaborators?: readonly string[];
  readonly userTags?: readonly InstagramUserTagOption[];
  /** Numeric ID of a Facebook Page with location data. */
  readonly locationId?: string;
  /** Publish a trial Reel shown to non-followers first; graduate it manually or on performance. */
  readonly trialReel?: "manual" | "performance";
  /** Zernio: the Reel cover frame, in milliseconds from the start. */
  readonly thumbOffsetMs?: number;
  /** Rename the Reel's original audio. Does not add music; see `audioConfiguration`. */
  readonly audioName?: string;
  /**
   * A Reel's catalog track, from an Instagram audio search. Needs a Facebook Login
   * connection. Zernio volumes are integers from 0 to 100; native Graph from 1 to 100.
   */
  readonly audioConfiguration?: InstagramAudioConfigurationOption;
  /** Zernio: strip the sound from every video before publishing. The result stays silent. */
  readonly muteAudio?: boolean;
  /** Instagram's AI-generated media label. */
  readonly aiGenerated?: boolean;
  /** Zernio: the "Paid partnership" label. Needs a Facebook-login connection. */
  readonly paidPartnership?: boolean;
  /** Zernio: up to two sponsor usernames or user IDs. Implies `paidPartnership`. */
  readonly brandedContentSponsors?: readonly string[];
  /** Zernio: `false` turns comments off right after publication. */
  readonly commentsEnabled?: boolean;
  /** Zernio and PostFast: a comment posted after publication. Not for Stories. */
  readonly firstComment?: string;
}

export interface FacebookCarouselCardOption {
  readonly link: string;
  readonly name?: string;
  readonly description?: string;
}

export interface ManagedFacebookPublishOptions extends ManagedCommonPublishOptions {
  /** Zernio: publish to this Page of the connection instead of its default Page (`pageId`). */
  readonly pageId?: string;
  /** Publish a Page Story instead of a feed post. */
  readonly story?: boolean;
  /** Page IDs (digits) invited as Reel collaborators. Reels only. */
  readonly collaborators?: readonly string[];
  /** One card per image, 2 to 10, in media order. Images only, not with `reel` or `story`. */
  readonly carouselCards?: readonly FacebookCarouselCardOption[];
  /** The carousel's "See more" link. Defaults to the first card's link. */
  readonly carouselLink?: string;
  /** PostFast: add Facebook's end card after the last carousel card. Off by default. */
  readonly carouselEndCard?: boolean;
  /** Zernio: limit the post to these countries. */
  readonly geoRestriction?: GeoRestrictionOption;
  /** Page ID of a place to tag. Post for Me `location`, PostFast `facebookPlaceId`. */
  readonly locationId?: string;
  /** Post for Me: repeat the caption on every image of a multi-image post. */
  readonly captionEachImage?: boolean;
  /** Zernio and PostFast: a comment posted after publication. Not for Stories. */
  readonly firstComment?: string;
}

export interface ManagedLinkedInPublishOptions extends ManagedCommonPublishOptions {
  /** Title shown on a document (PDF, PPT, DOC) post. */
  readonly documentTitle?: string;
  /** Repost this LinkedIn post: a post URL or `urn:li:share`/`urn:li:ugcPost` URN. No media. */
  readonly reshare?: string;
  /** Zernio: suppress the automatic link preview card. */
  readonly disableLinkPreview?: boolean;
  /** Zernio: a poll of 2 to 4 options (1 to 30 characters) with a 1 to 140 character question. */
  readonly poll?: {
    readonly question: string;
    readonly options: readonly string[];
    readonly duration?: "ONE_DAY" | "THREE_DAYS" | "SEVEN_DAYS" | "FOURTEEN_DAYS";
  };
  /** Zernio: a comment posted after publication. */
  readonly firstComment?: string;
}
