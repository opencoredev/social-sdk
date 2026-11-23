// The TypeScript sample both tools show for the platforms a reader selects. It
// follows the seven-network example in docs/platforms/index.mdx: one client with
// a direct adapter per platform, `posts.prepare` to list problems before anything
// is sent, then `posts.publish` with one outcome per target.
import { platformIds, type PlatformId } from "./platforms";

type Part = {
  importLine: string;
  backend: string;
  /** The target entry in `targets`, without the trailing comma. */
  target: string;
};

const ref = (platform: PlatformId, accountId: string) =>
  `connectedAccountRef({ backend: "${platform}", platform: "${platform}", accountId: ${accountId} })`;

const parts: Readonly<Record<PlatformId, Part>> = {
  x: {
    importLine: `import { x } from "@opencoredev/social-sdk/x";`,
    backend: `x: x({ auth: { userId: env("X_USER_ID"), accessToken: env("X_ACCESS_TOKEN") } }),`,
    target: `{ account: ${ref("x", `env("X_USER_ID")`)} }`,
  },
  bluesky: {
    importLine: `import { bluesky } from "@opencoredev/social-sdk/bluesky";`,
    backend: `bluesky: bluesky({
      backend: "bluesky",
      auth: { service: "https://bsky.social", did: env("BLUESKY_DID"), accessJwt: env("BLUESKY_ACCESS_JWT") },
    }),`,
    target: `{ account: ${ref("bluesky", `env("BLUESKY_DID")`)} }`,
  },
  threads: {
    importLine: `import { threads } from "@opencoredev/social-sdk/threads";`,
    backend: `threads: threads({
      backend: "threads",
      auth: { userId: env("THREADS_USER_ID"), accessToken: env("THREADS_ACCESS_TOKEN") },
    }),`,
    target: `{ account: ${ref("threads", `env("THREADS_USER_ID")`)} }`,
  },
  instagram: {
    importLine: `import { instagram } from "@opencoredev/social-sdk/instagram";`,
    backend: `instagram: instagram({
      auth: { accessToken: env("INSTAGRAM_ACCESS_TOKEN"), accountId: env("INSTAGRAM_ACCOUNT_ID") },
    }),`,
    target: `{
      account: ${ref("instagram", `env("INSTAGRAM_ACCOUNT_ID")`)},
      content: { media: [hostedVideo] },
    }`,
  },
  linkedin: {
    importLine: `import { linkedin } from "@opencoredev/social-sdk/linkedin";`,
    backend: `linkedin: linkedin({
      auth: { accessToken: env("LINKEDIN_ACCESS_TOKEN"), author: linkedinAuthor },
      apiVersion: "202609",
    }),`,
    target: `{ account: ${ref("linkedin", "linkedinAuthor")} }`,
  },
  tiktok: {
    importLine: `import { tiktok } from "@opencoredev/social-sdk/tiktok";`,
    backend: `tiktok: tiktok({
      auth: { accessToken: env("TIKTOK_ACCESS_TOKEN"), openId: env("TIKTOK_OPEN_ID") },
      verifiedMediaOrigins: ["https://media.example.com"],
    }),`,
    target: `{
      account: ${ref("tiktok", `env("TIKTOK_OPEN_ID")`)},
      content: { media: [hostedVideo] },
      // Inbox draft: needs video.upload and the creator's preview and consent first.
      options: {
        draft: true,
        privacy: "SELF_ONLY",
        consentGiven: true,
        disableComments: false,
        disableDuet: false,
        disableStitch: false,
        brandedContent: false,
        ownBrand: false,
        aiGenerated: false,
      },
    }`,
  },
  youtube: {
    importLine: `import { youtube } from "@opencoredev/social-sdk/youtube";`,
    backend: `youtube: youtube({
      auth: { accessToken: env("YOUTUBE_ACCESS_TOKEN"), channelId: env("YOUTUBE_CHANNEL_ID") },
    }),`,
    target: `{
      account: ${ref("youtube", `env("YOUTUBE_CHANNEL_ID")`)},
      content: { media: [uploadedVideo] },
      options: { title: "What changed in v2", visibility: "private", madeForKids: false },
    }`,
  },
  facebook: {
    importLine: `import { facebook } from "@opencoredev/social-sdk/facebook";`,
    backend: `facebook: facebook({
      auth: { pageId: env("FACEBOOK_PAGE_ID"), accessToken: env("FACEBOOK_PAGE_ACCESS_TOKEN") },
    }),`,
    target: `{ account: ${ref("facebook", `env("FACEBOOK_PAGE_ID")`)} }`,
  },
};

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
export function socialSnippet(selected: readonly PlatformId[], text: string): string {
  const platforms = platformIds.filter((id) => selected.includes(id));

  if (platforms.length === 0) return "// Pick at least one platform to see the code.";

  const has = (id: PlatformId) => platforms.includes(id);

  const uploads = has("youtube");

  const hosted = has("tiktok") || has("instagram");

  const lines: string[] = [];

  if (uploads) lines.push(`import { readFile } from "node:fs/promises";`);

  lines.push(
    uploads || hosted
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

  if (uploads)
    lines.push(
      `// YouTube uploads the file's bytes.
const file = new Blob([await readFile("./launch.mp4")], { type: "video/mp4" });
const uploadedVideo: MediaAttachment = {
  kind: "video",
  source: { kind: "blob", blob: file, fingerprint: "launch-v2" },
  mimeType: "video/mp4",
  byteSize: file.size,
};`,
      "",
    );

  if (hosted)
    lines.push(
      `// TikTok and Instagram pull the file from your HTTPS origin.
const hostedVideo: MediaAttachment = {
  kind: "video",
  source: { kind: "https-url", url: "https://media.example.com/launch.mp4" },
  mimeType: "video/mp4",
  durationSeconds: 30, // the file's real length
};`,
      "",
    );

  lines.push(
    `const request = {
  content: { text: ${JSON.stringify(text)} },
  targets: [
    ${platforms.map((id) => parts[id].target).join(",\n    ")},
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
