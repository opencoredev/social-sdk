// The TypeScript sample both tools show for the platforms a reader selects. It
// follows the seven-network example in docs/platforms/index.mdx: one client with
// a direct adapter per platform, `posts.prepare` to list problems before anything
// is sent, then `posts.publish` with one outcome per target.
import { platformIds, type PlatformId } from "./platforms";
import type { MediaPlan } from "./preflight";

type Part = {
  importLine: string;
  backend: string;
  account: string;
};

const ref = (platform: PlatformId, accountId: string) =>
  `connectedAccountRef({ backend: "${platform}", platform: "${platform}", accountId: ${accountId} })`;

const parts: Readonly<Record<PlatformId, Part>> = {
  x: {
    importLine: `import { x } from "@opencoredev/social-sdk/x";`,
    backend: `x: x({ auth: { userId: env("X_USER_ID"), accessToken: env("X_ACCESS_TOKEN") } }),`,
    account: ref("x", `env("X_USER_ID")`),
  },
  bluesky: {
    importLine: `import { bluesky } from "@opencoredev/social-sdk/bluesky";`,
    backend: `bluesky: bluesky({
      backend: "bluesky",
      auth: { service: "https://bsky.social", did: env("BLUESKY_DID"), accessJwt: env("BLUESKY_ACCESS_JWT") },
    }),`,
    account: ref("bluesky", `env("BLUESKY_DID")`),
  },
  threads: {
    importLine: `import { threads } from "@opencoredev/social-sdk/threads";`,
    backend: `threads: threads({
      backend: "threads",
      auth: { userId: env("THREADS_USER_ID"), accessToken: env("THREADS_ACCESS_TOKEN") },
    }),`,
    account: ref("threads", `env("THREADS_USER_ID")`),
  },
  instagram: {
    importLine: `import { instagram } from "@opencoredev/social-sdk/instagram";`,
    backend: `instagram: instagram({
      auth: { accessToken: env("INSTAGRAM_ACCESS_TOKEN"), accountId: env("INSTAGRAM_ACCOUNT_ID") },
    }),`,
    account: ref("instagram", `env("INSTAGRAM_ACCOUNT_ID")`),
  },
  linkedin: {
    importLine: `import { linkedin } from "@opencoredev/social-sdk/linkedin";`,
    backend: `linkedin: linkedin({
      auth: { accessToken: env("LINKEDIN_ACCESS_TOKEN"), author: linkedinAuthor },
      apiVersion: "202609",
    }),`,
    account: ref("linkedin", "linkedinAuthor"),
  },
  tiktok: {
    importLine: `import { tiktok } from "@opencoredev/social-sdk/tiktok";`,
    backend: `tiktok: tiktok({
      auth: { accessToken: env("TIKTOK_ACCESS_TOKEN"), openId: env("TIKTOK_OPEN_ID") },
      verifiedMediaOrigins: ["https://media.example.com"],
    }),`,
    account: ref("tiktok", `env("TIKTOK_OPEN_ID")`),
  },
  youtube: {
    importLine: `import { youtube } from "@opencoredev/social-sdk/youtube";`,
    backend: `youtube: youtube({
      auth: { accessToken: env("YOUTUBE_ACCESS_TOKEN"), channelId: env("YOUTUBE_CHANNEL_ID") },
    }),`,
    account: ref("youtube", `env("YOUTUBE_CHANNEL_ID")`),
  },
  facebook: {
    importLine: `import { facebook } from "@opencoredev/social-sdk/facebook";`,
    backend: `facebook: facebook({
      auth: { pageId: env("FACEBOOK_PAGE_ID"), accessToken: env("FACEBOOK_PAGE_ACCESS_TOKEN") },
    }),`,
    account: ref("facebook", `env("FACEBOOK_PAGE_ID")`),
  },
};

const hostedPlatforms = new Set<PlatformId>(["threads", "instagram", "tiktok", "facebook"]);

const blobImagePlatforms = new Set<PlatformId>(["x", "bluesky"]);

type TargetMedia = {
  accountExpr?: string;
  mediaExpr?: string;
  comment?: string;
};

type AssetUsage = {
  uploadedVideo: boolean;
  hostedVideo: boolean;
  uploadedImage: boolean;
  hostedImage: boolean;
  blueskyVideoRef: boolean;
  linkedinMedia: "none" | "image" | "carousel" | "video";
  carouselCount: number;
};

function targetMediaExpr(platform: PlatformId, media: MediaPlan, usage: AssetUsage): TargetMedia {
  if (platform === "youtube") {
    usage.uploadedVideo = true;

    if (media.kind === "image" || media.kind === "carousel")
      return {
        mediaExpr: "[uploadedVideo]",
        comment: "// YouTube accepts video only; remove or swap this target for image posts.",
      };

    return { mediaExpr: "[uploadedVideo]" };
  }

  if (platform === "linkedin") {
    if (media.kind === "none") return {};

    usage.linkedinMedia = media.kind;

    if (media.kind === "video") {
      usage.uploadedVideo = true;

      return { accountExpr: "linkedinAccount", mediaExpr: "[linkedinVideo]" };
    }

    usage.uploadedImage = true;

    if (media.kind === "carousel") {
      usage.carouselCount = media.count;

      return { accountExpr: "linkedinAccount", mediaExpr: "linkedinImages" };
    }

    return { accountExpr: "linkedinAccount", mediaExpr: "[linkedinImage]" };
  }

  if (media.kind === "none") {
    if (platform === "instagram" || platform === "tiktok") {
      usage.hostedVideo = true;

      return { mediaExpr: "[hostedVideo]" };
    }

    return {};
  }

  if (media.kind === "video") {
    if (hostedPlatforms.has(platform)) {
      usage.hostedVideo = true;

      return { mediaExpr: "[hostedVideo]" };
    }

    if (platform === "bluesky") {
      usage.uploadedVideo = true;
      usage.blueskyVideoRef = true;

      return { accountExpr: "blueskyAccount", mediaExpr: "[blueskyVideo]" };
    }

    if (platform === "x") {
      usage.uploadedVideo = true;

      return { mediaExpr: "[uploadedVideo]" };
    }

    return {};
  }

  // Image or carousel
  if (hostedPlatforms.has(platform)) {
    usage.hostedImage = true;

    if (media.kind === "carousel") {
      usage.carouselCount = media.count;

      return { mediaExpr: "hostedImages" };
    }

    return { mediaExpr: "[hostedImage]" };
  }

  if (blobImagePlatforms.has(platform)) {
    usage.uploadedImage = true;

    if (media.kind === "carousel") {
      usage.carouselCount = media.count;

      return { mediaExpr: "uploadedImages" };
    }

    return { mediaExpr: "[uploadedImage]" };
  }

  return {};
}

function renderTarget(platform: PlatformId, media: MediaPlan, usage: AssetUsage): string {
  const { accountExpr, mediaExpr, comment } = targetMediaExpr(platform, media, usage);
  const account = accountExpr ?? parts[platform].account;
  const fields: string[] = [];

  if (comment !== undefined) fields.push(`      ${comment}`);

  fields.push(`      account: ${account},`);

  if (mediaExpr !== undefined) fields.push(`      content: { media: ${mediaExpr} },`);

  if (platform === "tiktok") {
    const isPhoto = media.kind === "image" || media.kind === "carousel";

    fields.push(
      isPhoto
        ? `      // Inbox draft: sends the photos to TikTok's inbox (photoCoverIndex picks the cover); needs video.upload and creator consent.`
        : `      // Inbox draft: transfers the video only (add the caption in TikTok); needs video.upload and creator consent.`,
      isPhoto
        ? `      options: {
        draft: true,
        privacy: "SELF_ONLY",
        photoCoverIndex: 0,
        consentGiven: true,
        disableComments: false,
        disableDuet: false,
        disableStitch: false,
        brandedContent: false,
        ownBrand: false,
        aiGenerated: false,
      },`
        : `      options: {
        draft: true,
        privacy: "SELF_ONLY",
        consentGiven: true,
        disableComments: false,
        disableDuet: false,
        disableStitch: false,
        brandedContent: false,
        ownBrand: false,
        aiGenerated: false,
      },`,
    );
  }

  if (platform === "youtube")
    fields.push(
      `      options: { title: "What changed in v2", visibility: "private", madeForKids: false },`,
    );

  if (fields.length === 1 && comment === undefined) return `{ account: ${account} }`;

  return `{
${fields.join("\n")}
    }`;
}

/** The post text the cost calculator's sample sends. */
export const SNIPPET_TEXT = "Shipped v2 today. Notes: https://example.com/changelog";

/** The npm release that predates the Facebook subpath, checked on 23 November 2026. */
export const FACEBOOK_SUBPATH_NOTE =
  "The ./facebook subpath is on main and not in the npm release 0.5.0 (checked 23 November 2026).";

/**
 * The platforms whose subpaths ship in the npm release, so the default sample
 * type-checks against `@opencoredev/social-sdk@0.5.0`. Facebook is opt-in.
 */
export const npmPlatformIds: readonly PlatformId[] = platformIds.filter((id) => id !== "facebook");

/** A runnable sample that prepares, then publishes, one post to each platform given. */
export function socialSnippet(
  selected: readonly PlatformId[],
  text: string,
  media: MediaPlan = { kind: "none" },
): string {
  const platforms = platformIds.filter((id) => selected.includes(id));

  if (platforms.length === 0) return "// Pick at least one platform to see the code.";

  const has = (id: PlatformId) => platforms.includes(id);

  const usage: AssetUsage = {
    uploadedVideo: false,
    hostedVideo: false,
    uploadedImage: false,
    hostedImage: false,
    blueskyVideoRef: false,
    linkedinMedia: "none",
    carouselCount: 0,
  };

  const renderedTargets = platforms.map((id) => renderTarget(id, media, usage));

  const needsReadFile = usage.uploadedVideo || usage.uploadedImage;

  const needsMediaType =
    usage.uploadedVideo ||
    usage.hostedVideo ||
    usage.uploadedImage ||
    usage.hostedImage ||
    usage.blueskyVideoRef ||
    usage.linkedinMedia !== "none";

  const lines: string[] = [];

  if (needsReadFile) lines.push(`import { readFile } from "node:fs/promises";`);

  lines.push(
    needsMediaType
      ? `import { createSocial, connectedAccountRef, type MediaAttachment } from "@opencoredev/social-sdk";`
      : `import { createSocial, connectedAccountRef } from "@opencoredev/social-sdk";`,
    ...platforms.map((id) => parts[id].importLine),
    ...(has("facebook") ? [`// ${FACEBOOK_SUBPATH_NOTE}`] : []),
    "",
    `const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(\`Missing \${name}\`);
  return value;
};`,
    "",
  );

  if (has("linkedin"))
    lines.push(
      'const linkedinAuthor: `urn:li:person:${string}` = `urn:li:person:${env("LINKEDIN_PERSON_ID")}`;',
      "",
    );

  lines.push(
    `const social = createSocial({
  backends: {
    ${platforms.map((id) => parts[id].backend).join("\n    ")}
  },
});`,
    "",
  );

  const durationSeconds =
    media.kind === "video" && media.seconds !== undefined && media.seconds > 0 ? media.seconds : 30;

  if (usage.uploadedVideo)
    lines.push(
      `// Upload the video bytes directly.
const videoFile = new Blob([await readFile("./launch.mp4")], { type: "video/mp4" });
const uploadedVideo: MediaAttachment = {
  kind: "video",
  source: { kind: "blob", blob: videoFile, fingerprint: "launch-v2" },
  mimeType: "video/mp4",
  byteSize: videoFile.size,
};`,
      "",
    );

  if (usage.hostedVideo)
    lines.push(
      `// Hosted HTTPS video URL pulled by the platform.
const hostedVideo: MediaAttachment = {
  kind: "video",
  source: { kind: "https-url", url: "https://media.example.com/launch.mp4" },
  mimeType: "video/mp4",
  durationSeconds: ${durationSeconds}, // the file's real length
};`,
      "",
    );

  if (usage.uploadedImage) {
    lines.push(
      `// Upload the image bytes directly (width and height are required for 5-10 image Bluesky galleries).
const imageFile = new Blob([await readFile("./launch.jpg")], { type: "image/jpeg" });
const uploadedImage: MediaAttachment = {
  kind: "image",
  source: { kind: "blob", blob: imageFile, fingerprint: "launch-img-1" },
  mimeType: "image/jpeg",
  byteSize: imageFile.size,
  width: 1200,
  height: 675,
};`,
    );

    if (usage.carouselCount > 0)
      lines.push(
        `const uploadedImages: MediaAttachment[] = Array.from({ length: ${usage.carouselCount} }, (_, index) => ({
  ...uploadedImage,
  source: { kind: "blob", blob: imageFile, fingerprint: \`launch-img-\${index + 1}\` },
}));`,
      );

    lines.push("");
  }

  if (usage.hostedImage) {
    lines.push(
      `// Hosted HTTPS image URL pulled by the platform (width and height verify carousel aspect ratios).
const hostedImage: MediaAttachment = {
  kind: "image",
  source: { kind: "https-url", url: "https://media.example.com/launch-1.jpg" },
  mimeType: "image/jpeg",
  width: 1200,
  height: 1200,
};`,
    );

    if (usage.carouselCount > 0)
      lines.push(
        `const hostedImages: MediaAttachment[] = Array.from({ length: ${usage.carouselCount} }, (_, index) => ({
  ...hostedImage,
  source: { kind: "https-url", url: \`https://media.example.com/launch-\${index + 1}.jpg\` },
}));`,
      );

    lines.push("");
  }

  if (usage.blueskyVideoRef)
    lines.push(
      `// Bluesky videos are uploaded first, then published by reference once processing yields a blob.
const blueskyAccount = ${parts.bluesky.account};
const blueskyVideoRef = await social.media.upload(uploadedVideo, blueskyAccount);
const blueskyVideo: MediaAttachment = {
  kind: "video",
  source: { kind: "media-ref", ref: blueskyVideoRef },
  mimeType: "video/mp4",
};`,
      "",
    );

  if (usage.linkedinMedia === "video")
    lines.push(
      `// LinkedIn videos are uploaded first, then published by their returned media reference.
const linkedinAccount = ${parts.linkedin.account};
const linkedinVideoRef = await social.media.upload(uploadedVideo, linkedinAccount);
const linkedinVideo: MediaAttachment = {
  kind: "video",
  source: { kind: "media-ref", ref: linkedinVideoRef },
  mimeType: "video/mp4",
};`,
      "",
    );
  else if (usage.linkedinMedia === "image")
    lines.push(
      `// LinkedIn images are uploaded first, then published by their returned media reference.
const linkedinAccount = ${parts.linkedin.account};
const linkedinImageRef = await social.media.upload(uploadedImage, linkedinAccount);
const linkedinImage: MediaAttachment = {
  kind: "image",
  source: { kind: "media-ref", ref: linkedinImageRef },
  mimeType: "image/jpeg",
};`,
      "",
    );
  else if (usage.linkedinMedia === "carousel")
    lines.push(
      `// LinkedIn multi-image posts register each image first, then publish their media references.
const linkedinAccount = ${parts.linkedin.account};
const linkedinImages: MediaAttachment[] = await Promise.all(
  uploadedImages.map(async (item) => ({
    kind: "image",
    source: { kind: "media-ref", ref: await social.media.upload(item, linkedinAccount) },
    mimeType: "image/jpeg",
  })),
); `.trimEnd(),
      "",
    );

  lines.push(
    `const request = {
  content: { text: ${JSON.stringify(text)} },
  targets: [
    ${renderedTargets.join(",\n    ")},
  ],
} as const;

// Lists every limit a target breaks, before anything is sent.
const plan = social.posts.prepare(request);
if (!plan.ok) throw new Error(plan.issues.map((issue) => issue.message).join("\\n"));

const result = await social.posts.publish(request);
for (const outcome of result.outcomes) {
  // "processing" and "unknown" are not published yet: check again before retrying.
  console.log(outcome.account.platform, outcome.state);
}`,
  );

  return lines.join("\n");
}
