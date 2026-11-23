// Per-platform posting limits and access rules for the /tools pages. Every value
// comes from the platform docs under apps/docs/docs/platforms/ (which cite the
// provider's own pages and the date they were checked) or from the check the SDK
// adapter runs before sending. When a platform publishes no limit, the field says
// so instead of holding a guess.

export const platformIds = [
  "x",
  "bluesky",
  "threads",
  "instagram",
  "linkedin",
  "tiktok",
  "youtube",
  "facebook",
] as const;

export type PlatformId = (typeof platformIds)[number];

export function isPlatformId(value: string): value is PlatformId {
  return platformIds.some((id) => id === value);
}

/** How a platform measures post text, and its limit in that unit. */
export type TextRule =
  /** X's weighted count: most Latin characters 1, other characters and emoji 2, each URL 23. */
  | { kind: "x-weighted"; limit: number }
  /** Bluesky: graphemes and UTF-8 bytes, both capped. */
  | { kind: "graphemes"; limit: number; maxBytes: number }
  /** Threads: code points, with emoji counted by their UTF-8 bytes. */
  | { kind: "threads"; limit: number }
  /** JavaScript string length (UTF-16 code units), which is what the SDK checks. */
  | { kind: "utf16"; limit: number; photoLimit?: number }
  /** UTF-8 bytes, which is how YouTube measures a description; YouTube also rejects < and >. */
  | { kind: "utf8-bytes"; limit: number; noAngleBrackets: boolean }
  /** No published limit. */
  | { kind: "none" };

/** A byte limit and how the docs state it. */
export type SizeLimit = { bytes: number; label: string };

/** A duration range in seconds; `min` and `max` are omitted when there is none. */
export type DurationRule = {
  min?: number;
  max?: number;
  /** Above this length, the post may still work but needs something extra. */
  warnAbove?: { seconds: number; reason: string };
  note?: string;
  /** The matrix's length label when there is no fixed range. */
  summary?: string;
  /** The SDK rejects a video without a known length above 0 s (TikTok's creator limit check). */
  lengthRequired?: boolean;
};

export type PlatformSpec = {
  id: PlatformId;
  name: string;
  /** Docs page under /docs/platforms. */
  docsPath: string;
  /** Matching guides, most specific first. */
  guides: readonly { path: string; label: string }[];
  text: TextRule;
  /** A post may be text only. */
  textOnly: boolean;
  /** Hashtag and @-tag caps (Instagram). */
  tags?: { hashtags: number; mentions: number };
  image: { maxPerPost: number; size?: SizeLimit; formats: string } | null;
  /** Several images (or a mix) in one post. `warnAbove` covers Bluesky's gallery rule. */
  carousel: { min: number; max: number; warnAbove?: { count: number; reason: string } } | null;
  video: {
    size?: SizeLimit;
    minSize?: SizeLimit;
    sizeNote?: string;
    duration: DurationRule;
    formats: string;
  } | null;
  /** What an app needs before it can post for other people. */
  access: string;
  scopes: string;
  /** The main posting rate limit. */
  rateLimit: string;
  /** The provider pages that establish this row's limits, access, and scopes, with the date each was read (YYYY-MM-DD). */
  sources: readonly { label: string; url: string; checked: string }[];
};

const MB = 1_000_000;

const MIB = 1_048_576;

const GIB = 1_073_741_824;

export const platformSpecs: readonly PlatformSpec[] = [
  {
    id: "x",
    name: "X",
    docsPath: "/docs/platforms/x",
    guides: [{ path: "/guides/x-api-pricing", label: "X API pricing" }],
    text: { kind: "x-weighted", limit: 280 },
    textOnly: true,
    image: { maxPerPost: 4, size: { bytes: 5 * MIB, label: "5 MiB" }, formats: "JPEG, PNG, WebP" },
    carousel: { min: 2, max: 4 },
    video: {
      size: { bytes: 16 * GIB, label: "16 GiB (SDK upload ceiling)" },
      sizeNote: "X's own size limit depends on the account's Premium or verified status.",
      duration: {
        summary: "length limit set per account",
        note: "X checks duration when the post is created; the limit depends on the account.",
      },
      formats: "MP4, MOV, WebM, or one GIF",
    },
    access:
      "A developer app and an OAuth 2.0 user token. Pay-per-use credits; no general free tier.",
    scopes: "tweet.read, tweet.write, users.read, media.write",
    rateLimit:
      "10,000 posts per app per 24 hours and 100 per user per 15 minutes. Each post is billed: $0.015, or $0.20 with a URL",
    sources: [
      {
        label: "X rate limits",
        url: "https://docs.x.com/x-api/fundamentals/rate-limits",
        checked: "2026-11-23",
      },
      {
        label: "X pricing",
        url: "https://docs.x.com/x-api/getting-started/pricing",
        checked: "2026-11-23",
      },
      {
        label: "X counting characters",
        url: "https://docs.x.com/fundamentals/counting-characters",
        checked: "2026-11-23",
      },
      {
        label: "X authentication",
        url: "https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping",
        checked: "2026-11-23",
      },
      {
        label: "X media best practices",
        url: "https://docs.x.com/x-api/media/quickstart/best-practices",
        checked: "2026-11-04",
      },
    ],
  },
  {
    id: "bluesky",
    name: "Bluesky",
    docsPath: "/docs/platforms/bluesky",
    guides: [{ path: "/guides/bluesky-api", label: "Bluesky API" }],
    text: { kind: "graphemes", limit: 300, maxBytes: 3000 },
    textOnly: true,
    image: {
      maxPerPost: 10,
      size: { bytes: 2 * MB, label: "2,000,000 bytes" },
      formats: "image/*",
    },
    carousel: {
      min: 2,
      max: 10,
      warnAbove: {
        count: 4,
        reason: "Five to ten images use a gallery, which needs width and height on every image.",
      },
    },
    video: {
      size: { bytes: 300 * MB, label: "300,000,000 bytes" },
      duration: {
        summary: "no length limit in the lexicon",
        note: "The lexicon sets no duration; the video service applies daily account limits.",
      },
      formats: "MP4",
    },
    access: "No developer account or key. Sign in as the account with an app password or OAuth.",
    scopes: "App password, or OAuth with atproto and repo scopes",
    rateLimit: "5,000 points an hour (3 per create), about 1,666 posts an hour per account",
    sources: [
      {
        label: "Bluesky rate limits",
        url: "https://bsky.network/docs/rate-limits/",
        checked: "2026-11-23",
      },
      { label: "AT Protocol OAuth", url: "https://atproto.com/specs/oauth", checked: "2026-11-23" },
      {
        label: "AT Protocol permissions",
        url: "https://atproto.com/specs/permission",
        checked: "2026-11-23",
      },
      {
        label: "Bluesky post lexicon",
        url: "https://raw.githubusercontent.com/bluesky-social/bsky/main/lexicons/app/bsky/feed/post.json",
        checked: "2026-11-23",
      },
      {
        label: "AT Protocol embed lexicons",
        url: "https://github.com/bluesky-social/atproto/tree/main/packages/api/lexicons/app/bsky/embed",
        checked: "2026-11-04",
      },
    ],
  },
  {
    id: "threads",
    name: "Threads",
    docsPath: "/docs/platforms/threads",
    guides: [{ path: "/guides/threads-api", label: "Threads API" }],
    text: { kind: "threads", limit: 500 },
    textOnly: true,
    image: { maxPerPost: 20, size: { bytes: 8 * MB, label: "8 MB" }, formats: "JPEG, PNG" },
    carousel: { min: 2, max: 20 },
    video: {
      size: { bytes: 1000 * MB, label: "1 GB" },
      duration: { max: 300 },
      formats: "MP4, MOV",
    },
    access: "A Meta app. App Review for users outside your app's roles.",
    scopes: "threads_basic, threads_content_publish",
    rateLimit: "250 API posts per profile per 24 hours (a carousel counts as one)",
    sources: [
      {
        label: "Meta: Threads posts",
        url: "https://developers.facebook.com/documentation/threads/posts",
        checked: "2026-11-21",
      },
    ],
  },
  {
    id: "instagram",
    name: "Instagram",
    docsPath: "/docs/platforms/instagram",
    guides: [{ path: "/guides/social-media-apis", label: "Social media APIs" }],
    text: { kind: "utf16", limit: 2200 },
    textOnly: false,
    tags: { hashtags: 30, mentions: 20 },
    image: { maxPerPost: 20, size: { bytes: 8 * MB, label: "8 MB" }, formats: "JPEG only" },
    carousel: { min: 2, max: 20 },
    video: {
      size: { bytes: 300 * MB, label: "300 MB" },
      duration: { min: 3, max: 900 },
      formats: "MP4 or MOV, published as a Reel",
    },
    access:
      "A professional (Business or Creator) account and a Meta app. Advanced Access (which requires App Review and Business Verification) for accounts outside your organization.",
    scopes: "instagram_business_basic, instagram_business_content_publish",
    rateLimit:
      "100 API-published posts per account in a moving 24 hours (a carousel counts as one)",
    sources: [
      {
        label: "Meta: Instagram Platform overview",
        url: "https://developers.facebook.com/documentation/instagram-platform/overview",
        checked: "2026-11-23",
      },
      {
        label: "Meta: Business Login for Instagram",
        url: "https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login",
        checked: "2026-11-23",
      },
      {
        label: "Meta: Instagram content publishing",
        url: "https://developers.facebook.com/documentation/instagram-platform/content-publishing/",
        checked: "2026-11-23",
      },
      {
        label: "Meta: IG User Media reference",
        url: "https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media",
        checked: "2026-11-04",
      },
    ],
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    docsPath: "/docs/platforms/linkedin",
    guides: [{ path: "/guides/linkedin-posts-api", label: "LinkedIn Posts API" }],
    text: { kind: "utf16", limit: 3000 },
    textOnly: true,
    image: {
      maxPerPost: 20,
      size: { bytes: 20 * MIB, label: "20 MiB (SDK policy; LinkedIn gives none)" },
      formats: "JPG, GIF, PNG",
    },
    carousel: { min: 2, max: 20 },
    video: {
      size: { bytes: 500 * MIB, label: "500 MB" },
      minSize: { bytes: 75_000, label: "75 KB" },
      duration: { min: 3, max: 1800 },
      formats: "MP4",
    },
    access:
      "w_member_social to post as a member, or w_organization_social plus an admin or poster role on the Page.",
    scopes: "w_member_social or w_organization_social",
    rateLimit:
      "Daily limits per app and per member, reset at midnight UTC; LinkedIn publishes no standard figures",
    sources: [
      {
        label: "LinkedIn Images and Videos APIs (202610)",
        url: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api",
        checked: "2026-11-04",
      },
    ],
  },
  {
    id: "tiktok",
    name: "TikTok",
    docsPath: "/docs/platforms/tiktok",
    guides: [{ path: "/guides/social-media-apis", label: "Social media APIs" }],
    text: { kind: "utf16", limit: 2200, photoLimit: 4000 },
    textOnly: false,
    image: { maxPerPost: 35, size: { bytes: 20 * MIB, label: "20 MB" }, formats: "JPEG, WebP" },
    carousel: { min: 2, max: 35 },
    video: {
      size: { bytes: 4 * GIB, label: "4 GB" },
      duration: {
        max: 600,
        lengthRequired: true,
        note: "It must also fit the creator's maxVideoDurationSeconds from creator info.",
      },
      formats: "MP4, WebM, MOV",
    },
    access:
      "A TikTok app. Until TikTok audits it, posts are private (SELF_ONLY) and reach at most five users in 24 hours.",
    scopes: "video.publish (video.upload for inbox drafts)",
    rateLimit: "About 15 Direct Posts per creator per day, shared across API clients",
    sources: [
      {
        label: "TikTok Media Transfer Guide",
        url: "https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide",
        checked: "2026-11-04",
      },
    ],
  },
  {
    id: "youtube",
    name: "YouTube",
    docsPath: "/docs/platforms/youtube",
    guides: [
      { path: "/guides/youtube-upload-api", label: "YouTube upload API" },
      { path: "/guides/youtube-data-api", label: "YouTube Data API" },
    ],
    text: { kind: "utf8-bytes", limit: 5000, noAngleBrackets: true },
    textOnly: false,
    image: null,
    carousel: null,
    video: {
      size: { bytes: 256_000_000_000, label: "256 GB" },
      duration: {
        max: 43_200,
        warnAbove: {
          seconds: 900,
          reason: "Over 15 minutes needs a verified YouTube account.",
        },
      },
      formats: "video/*",
    },
    access:
      "A Google Cloud project and an OAuth token. OAuth verification and the API audit are separate reviews.",
    scopes: "https://www.googleapis.com/auth/youtube.upload",
    rateLimit: "100 videos.insert calls a day by default",
    sources: [
      {
        label: "YouTube Data API videos.insert",
        url: "https://developers.google.com/youtube/v3/docs/videos/insert",
        checked: "2026-11-04",
      },
    ],
  },
  {
    id: "facebook",
    name: "Facebook",
    docsPath: "/docs/platforms/facebook",
    guides: [{ path: "/guides/facebook-page-access-token", label: "Facebook Page access token" }],
    text: { kind: "none" },
    textOnly: true,
    image: {
      maxPerPost: 10,
      size: { bytes: 10 * MB, label: "10 MB" },
      formats: "JPEG, BMP, PNG, GIF, TIFF",
    },
    carousel: { min: 2, max: 10 },
    video: {
      sizeNote: "Meta's Page videos reference gives no size limit.",
      duration: {
        summary: "no published length limit (Reels: 3 to 90 s)",
        note: "Page videos have no published duration limit. As a Reel: 3 to 90 seconds.",
      },
      formats: "Page video or Reel; MP4 recommended",
    },
    access:
      "A Meta app with Facebook Login and a Page access token from a user who can CREATE_CONTENT on the Page.",
    scopes: "pages_show_list, pages_manage_posts, pages_read_engagement",
    rateLimit: "30 API-published Reels per Page in a moving 24 hours",
    sources: [
      {
        label: "Meta: Page photos and Reels publishing",
        url: "https://developers.facebook.com/docs/video-api/guides/reels-publishing",
        checked: "2026-11-04",
      },
    ],
  },
];

export function platformSpec(id: PlatformId): PlatformSpec {
  const spec = platformSpecs.find((candidate) => candidate.id === id);

  if (spec === undefined) throw new Error(`No platform spec for ${id}`);

  return spec;
}

/** The text limit as a short label, such as "280 weighted characters". */
export function textLimitLabel(rule: TextRule): string {
  switch (rule.kind) {
    case "x-weighted":
      return `${rule.limit} weighted characters`;
    case "graphemes":
      return `${rule.limit} graphemes and ${rule.maxBytes.toLocaleString("en-US")} bytes`;
    case "threads":
      return `${rule.limit} characters (emoji count as bytes)`;
    case "utf16":
      return rule.photoLimit === undefined
        ? `${rule.limit.toLocaleString("en-US")} characters`
        : `${rule.limit.toLocaleString("en-US")} characters (${rule.photoLimit.toLocaleString("en-US")} for photo posts)`;
    case "utf8-bytes":
      return `${rule.limit.toLocaleString("en-US")} bytes (description)${rule.noAngleBrackets ? ", no < or >" : ""}`;
    case "none":
      return "No published limit";
    default: {
      const exhaustive: never = rule;

      return exhaustive;
    }
  }
}
