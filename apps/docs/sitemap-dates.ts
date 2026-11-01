// Dates for sitemap entries Blume leaves undated: the custom pages, and the
// blog index while it has no posts. Each page is dated by the last commit that
// touched what it renders, so the date only moves when its content does.
// scripts/prune-docs-output.ts applies these to the built sitemap.xml.

/** Lines of a shared file that belong to one page, as `git log -L` regexes. */
export type LineRange = { file: string; from: string; to: string };

/** What a page renders from, relative to apps/docs/pages. */
export type PageSource = { files: string[]; ranges: LineRange[] };

// The info pages share pages.ts: each one depends on its own copy block and
// the shared parts (imports, the repo link, the rendering helpers), not on the
// other pages' copy.
// renderShell and siteMeta, which the blog index also uses.
const shellHelpers: LineRange = {
  file: "_info/pages.ts",
  from: "^export type Shell",
  to: "^export function renderInfoPage",
};

const infoShared: LineRange[] = [
  { file: "_info/pages.ts", from: "^import shell", to: "^const repo" },
  shellHelpers,
  { file: "_info/pages.ts", from: "^export function renderInfoPage", to: "^}" },
];

function infoPage(name: string): PageSource {
  return {
    files: [`${name}.astro`, "_info/info.html"],
    ranges: [
      { file: "_info/pages.ts", from: `^export const ${name}: InfoPage`, to: "^};" },
      ...infoShared,
    ],
  };
}

// A guide page renders its own copy through renderGuide and the helpers in
// guides.ts. The guide list, the imports, and the index's own title change
// without touching a guide, so they date only the index, not every guide.
// The "Related guides" list is generated from the guide list too; adding a
// guide only adds a link there, so it is not treated as a content change.
const guideRendering: LineRange[] = [
  { file: "_guides/guides.ts", from: "^export type Guide", to: "^const GUIDES_PATH" },
  { file: "_guides/guides.ts", from: "^export function guidePath", to: "^const index" },
  {
    file: "_guides/guides.ts",
    from: "^export function renderGuide[(]",
    to: "^export function renderGuidesIndex",
  },
];

function guidePage(slug: string): PageSource {
  return {
    files: [`guides/${slug}.astro`, `_guides/${slug}.ts`, "_info/info.html"],
    ranges: [...guideRendering, shellHelpers],
  };
}

export const pageSources: ReadonlyMap<string, PageSource> = new Map([
  ["/", { files: ["index.astro", "_home"], ranges: [] }],
  ["/about", infoPage("about")],
  ["/contact", infoPage("contact")],
  ["/privacy", infoPage("privacy")],
  ["/terms", infoPage("terms")],
  ["/brand", { files: ["brand.astro", "_brand"], ranges: [] }],
  // Only used while the blog is empty; with posts, the blog sitemap dates it.
  [
    "/guides",
    // The index renders each guide's metadata, not its body.
    {
      files: ["guides/index.astro", "_guides/guides.ts", "_info/info.html"],
      ranges: [
        shellHelpers,
        { file: "_guides/youtube-upload-api.ts", from: "^  slug:", to: "^  updated:" },
        { file: "_guides/linkedin-posts-api.ts", from: "^  slug:", to: "^  updated:" },
        { file: "_guides/social-media-apis.ts", from: "^  slug:", to: "^  updated:" },
        { file: "_guides/buffer-api.ts", from: "^  slug:", to: "^  updated:" },
        { file: "_guides/bluesky-api.ts", from: "^  slug:", to: "^  updated:" },
        { file: "_guides/threads-api.ts", from: "^  slug:", to: "^  updated:" },
        { file: "_guides/x-api-pricing.ts", from: "^  slug:", to: "^  updated:" },
      ],
    },
  ],
  ["/guides/youtube-upload-api", guidePage("youtube-upload-api")],
  ["/guides/linkedin-posts-api", guidePage("linkedin-posts-api")],
  ["/guides/social-media-apis", guidePage("social-media-apis")],
  ["/guides/buffer-api", guidePage("buffer-api")],
  ["/guides/bluesky-api", guidePage("bluesky-api")],
  ["/guides/threads-api", guidePage("threads-api")],
  ["/guides/x-api-pricing", guidePage("x-api-pricing")],
  [
    "/blog",
    { files: ["blog/index.astro", "_blog/render.ts", "_info/info.html"], ranges: [shellHelpers] },
  ],
]);

/**
 * Adds a <lastmod> to a sitemap <url> entry that has none, dated by `dateOf`.
 * Entries that already have one are returned unchanged. An undated entry with
 * no known sources is an error, so a new page can't ship undated.
 */
export function addLastmod({
  entry,
  origin,
  dateOf,
}: {
  entry: string;
  origin: string;
  dateOf: (source: PageSource) => string;
}): string {
  if (entry.includes("<lastmod>")) return entry;

  const loc = entry.match(/<loc>([^<]*)<\/loc>/)?.[1];
  const path = loc?.startsWith(origin) ? loc.slice(origin.length) || "/" : undefined;
  const source = path === undefined ? undefined : pageSources.get(path);

  if (source === undefined)
    throw new Error(`No lastmod source for sitemap entry ${entry}; add it to pageSources.`);

  return entry.replace("</loc>", `</loc><lastmod>${dateOf(source)}</lastmod>`);
}
