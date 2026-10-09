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
const infoShared: LineRange[] = [
  { file: "_info/pages.ts", from: "^import shell", to: "^const repo" },
  { file: "_info/pages.ts", from: "^export type Shell", to: "^export function renderInfoPage" },
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

export const pageSources: ReadonlyMap<string, PageSource> = new Map([
  ["/", { files: ["index.astro", "_home"], ranges: [] }],
  ["/about", infoPage("about")],
  ["/contact", infoPage("contact")],
  ["/privacy", infoPage("privacy")],
  ["/brand", { files: ["brand.astro", "_brand"], ranges: [] }],
  // Only used while the blog is empty; with posts, the blog sitemap dates it.
  [
    "/blog",
    { files: ["blog/index.astro", "_blog/render.ts", "_info/info.html"], ranges: infoShared },
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
