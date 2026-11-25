// Blume (checked through 2.0.3) leaves a collapsed sidebar group's links out of
// the page: the group's <details> holds an empty element with
// data-nav-src="/blume-nav/<version>/<locale>/<id>", and the sidebar script
// fetches that prerendered fragment on first open. Crawlers that don't run
// JavaScript only see the open groups' links, so most docs pages never link to
// the backends, integrations, concepts, or reference pages in their HTML.
//
// scripts/prune-docs-output.ts uses inlineSidebarFragments to copy each fragment
// into the page after the build and drop the attribute. The <details> elements
// keep their closed state, and with no data-nav-src left the sidebar script has
// nothing to fetch, so opening a group shows the same rows without a request.

/** Returns a fragment's HTML for its data-nav-src URL, or undefined if the build has none. */
export type FragmentReader = (src: string) => string | undefined;

export type InlineResult = { html: string; inlined: number };

// An HTML comment, which is copied as it is, or an opening tag that carries
// data-nav-src with a double- or single-quoted value. Blume renders the attribute
// on a <div> (collapsed group) or a drill-in panel; both are handled the same way.
// Matching comments first keeps a commented-out slot from being filled.
const deferredTag =
  /<!--[\s\S]*?(?:-->|$)|<([a-z][a-z0-9-]*)\b([^>]*?)\s+data-nav-src=(?:"([^"]*)"|'([^']*)')([^>]*)>/gi;

const comments = /<!--[\s\S]*?(?:-->|$)/g;

/**
 * Inlines every deferred sidebar section in `html`, recursively, so nested
 * collapsed groups (Integrations > Frameworks) are filled too. Throws when a
 * fragment is missing, refers back to itself, or its slot isn't empty, since
 * each of those means Blume's output changed and links would silently be lost.
 */
export function inlineSidebarFragments(html: string, read: FragmentReader): InlineResult {
  return inline(html, read, []);
}

function inline(html: string, read: FragmentReader, ancestors: readonly string[]): InlineResult {
  let output = "";

  let cursor = 0;

  let inlined = 0;

  for (const match of html.matchAll(deferredTag)) {
    const [opening, tag, before = "", doubleQuoted, singleQuoted, after = ""] = match;

    // A comment: leave it, and anything inside it, as it is.
    if (tag === undefined) continue;

    const src = doubleQuoted ?? singleQuoted ?? "";

    const start = match.index;

    const close = new RegExp(`^\\s*</${tag}>`, "i").exec(html.slice(start + opening.length));

    if (close === null)
      throw new Error(`The sidebar slot for ${src} isn't empty; Blume's sidebar markup changed.`);

    if (ancestors.includes(src))
      throw new Error(
        `The sidebar fragment ${src} includes itself through ${ancestors.join(" > ")}.`,
      );

    const fragment = read(src);

    if (fragment === undefined)
      throw new Error(`The sidebar fragment ${src} is missing from the build.`);

    const nested = inline(fragment, read, [...ancestors, src]);

    output += `${html.slice(cursor, start)}<${tag}${before}${after}>${nested.html}</${tag}>`;
    cursor = start + opening.length + close[0].length;
    inlined += 1 + nested.inlined;
  }

  return { html: output + html.slice(cursor), inlined };
}

/** Whether `html` still has a deferred sidebar section. */
export function hasDeferredSidebar(html: string): boolean {
  return /\sdata-nav-src=["']/.test(html.replace(comments, ""));
}
