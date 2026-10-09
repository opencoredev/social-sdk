// Renders the blog into the hand-drawn shell the about and contact pages use.
// Everything that comes from Revnu is escaped here, except `body.html`, which
// Revnu documents as already escaped and safe to inject.
import { renderShell, siteMeta } from "../_info/pages";
import type { MetaField, Post, Summary } from "./revnu";

export const SITE = "https://social-sdk.dev";

export const BLOG_PATH = "/blog";

export const POSTS_PER_PAGE = 10;

const blog = {
  title: "Social SDK blog: guides and updates",
  description:
    "Guides and updates about Social SDK, the open-source TypeScript library for publishing, reading, and handling comments and webhooks across social platforms.",
};

const rssLink = `<link rel="alternate" type="application/rss+xml" title="Social SDK blog" href="${SITE}${BLOG_PATH}/rss.xml" />`;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function dateTag(date: Date): string {
  return `<time datetime="${date.toISOString()}">${dateFormat.format(date)}</time>`;
}

/** The site path of a blog page: page 1 is /blog, later pages /blog/page/N. */
export function indexPath(page: number): string {
  return page === 1 ? BLOG_PATH : `${BLOG_PATH}/page/${page}`;
}

export function pageCount(posts: readonly Summary[]): number {
  return Math.max(1, Math.ceil(posts.length / POSTS_PER_PAGE));
}

/** Path of a post on this site, from its Revnu route key. */
export function postPath(post: Pick<Summary, "canonicalPath">): string {
  return `${BLOG_PATH}${post.canonicalPath}`;
}

// ---------- index ----------

export function renderIndex({ posts, page }: { posts: readonly Summary[]; page: number }): string {
  const pages = pageCount(posts);
  const shown = posts.slice((page - 1) * POSTS_PER_PAGE, page * POSTS_PER_PAGE);
  const path = indexPath(page);
  const title = page === 1 ? blog.title : `${blog.title} (page ${page})`;

  const description =
    page === 1 ? blog.description : `${blog.description} Page ${page} of ${pages}, older posts.`;

  const relations = [
    page > 1 ? `<link rel="prev" href="${SITE}${indexPath(page - 1)}" />` : "",
    page < pages ? `<link rel="next" href="${SITE}${indexPath(page + 1)}" />` : "",
  ].filter(Boolean);

  const items = shown
    .map(
      (post) => `
          <li>
            <h2><a href="${postPath(post)}">${escapeHtml(post.title)}</a></h2>
            <span class="date">${dateTag(post.publishedAt)}</span>
            ${post.description ? `<p>${escapeHtml(post.description)}</p>` : ""}
          </li>`,
    )
    .join("");

  const pager =
    pages > 1
      ? `
        <nav class="pager" aria-label="Blog pages">
          <span>${page > 1 ? `<a href="${indexPath(page - 1)}" rel="prev">Newer posts</a>` : ""}</span>
          <span>Page ${page} of ${pages}</span>
          <span>${page < pages ? `<a href="${indexPath(page + 1)}" rel="next">Older posts</a>` : ""}</span>
        </nav>`
      : "";

  return renderShell({
    meta: [siteMeta({ path, title, description }), rssLink, ...relations].join("\n    "),
    kicker: "notes from the maintainers",
    heading: "Blog",
    lede: "Guides and updates about building social features with Social SDK.",
    content:
      shown.length > 0
        ? `<ul class="posts">${items}
        </ul>${pager}`
        : emptyIndex,
  });
}

// Shown while the blog has no posts, so the page still says what it is for and
// where to start reading.
const emptyIndex = `
        <section>
          <h2>No posts yet</h2>
          <p>
            Posts will cover building social features with Social SDK: setting up platform apps
            and connecting accounts, publishing text, images, and video to several platforms at
            once, reading per-platform outcomes and media processing states, choosing between
            direct platform routes and managed backends, and what changed in each release.
          </p>
          <p>
            New posts appear here and in the <a href="${BLOG_PATH}/rss.xml">RSS feed</a>. Until
            then, the documentation covers the same ground.
          </p>
        </section>
        <section>
          <h2>Start with the guides</h2>
          <ul>
            <li><a href="/docs/getting-started/mock-quickstart">Run the mock quickstart</a>, no credentials needed</li>
            <li><a href="/docs/getting-started/choose-an-integration">Choose between direct routes and managed backends</a></li>
            <li><a href="/docs/authentication">Connect accounts</a> with OAuth and tenant grants</li>
            <li><a href="/docs/publishing">Publish content</a> and read each destination's outcome</li>
            <li><a href="/docs/platforms">Compare what each platform supports</a></li>
            <li><a href="/docs/comments">Handle comments and messages</a></li>
          </ul>
        </section>`;

// ---------- post ----------

/** Turns a camelCase Open Graph or Twitter key into its tag suffix. */
function tagSuffix(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

const articleKeys = new Set([
  "publishedTime",
  "modifiedTime",
  "expirationTime",
  "authors",
  "author",
  "section",
  "tags",
  "tag",
]);

type Tag = { attribute: "property" | "name"; key: string; value: string };

/** Turns one headMeta group (openGraph or twitter) into meta tags, keeping its values as-is. */
function groupTags({
  group,
  prefix,
  attribute,
  skip,
}: {
  group: readonly MetaField[];
  prefix: "og" | "twitter";
  attribute: Tag["attribute"];
  skip: ReadonlySet<string>;
}): Tag[] {
  return group
    .filter((field) => !skip.has(field.key))
    .flatMap((field) => {
      const name =
        prefix === "og" && articleKeys.has(field.key)
          ? `article:${tagSuffix(field.key.replace(/s$/, ""))}`
          : `${prefix}:${tagSuffix(field.key.replace(/^images$/, "image"))}`;

      return field.values.flatMap((value) => [
        { attribute, key: name, value: value.content },
        ...value.details.map((detail) => ({
          attribute,
          key: `${name}:${tagSuffix(detail.key)}`,
          value: detail.content,
        })),
      ]);
    });
}

function postMeta(post: Post): string {
  const { openGraph, twitter } = post.headMeta;

  // The canonical URL and og:url always come from post.canonicalUrl.
  const og = groupTags({
    group: openGraph,
    prefix: "og",
    attribute: "property",
    skip: new Set(["url"]),
  });

  const tw = groupTags({ group: twitter, prefix: "twitter", attribute: "name", skip: new Set() });
  const has = (key: string) => [...og, ...tw].some((tag) => tag.key === key);

  // Fill only what headMeta leaves out, so shares still get a title and card.
  const fallbacks: Tag[] = [
    { attribute: "property", key: "og:type", value: "article" },
    { attribute: "property", key: "og:site_name", value: "Social SDK" },
    { attribute: "property", key: "og:title", value: post.headMeta.title },
    { attribute: "property", key: "og:description", value: post.headMeta.description },
    {
      attribute: "property",
      key: "og:image",
      value: post.heroImageUrl ?? `${SITE}/og-home.png`,
    },
    { attribute: "property", key: "article:published_time", value: post.publishedAt.toISOString() },
    ...(post.updatedAt
      ? [
          {
            attribute: "property",
            key: "article:modified_time",
            value: post.updatedAt.toISOString(),
          } satisfies Tag,
        ]
      : []),
    { attribute: "name", key: "twitter:card", value: "summary_large_image" },
    { attribute: "name", key: "twitter:site", value: "@leodev" },
  ];

  const tags = [...og, ...tw, ...fallbacks.filter((tag) => !has(tag.key))]
    .map(
      (tag) =>
        `<meta ${tag.attribute}="${escapeHtml(tag.key)}" content="${escapeHtml(tag.value)}" />`,
    )
    .join("\n    ");

  // JSON.stringify leaves "<" alone, so "</script>" inside a string would close the tag.
  const jsonLd = post.jsonLd
    .map(
      (entry) =>
        `<script type="application/ld+json">${JSON.stringify(entry).replaceAll("<", "\\u003c")}</script>`,
    )
    .join("\n    ");

  return [
    `<title>${escapeHtml(post.headMeta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(post.headMeta.description)}" />`,
    `<link rel="canonical" href="${escapeHtml(post.canonicalUrl)}" />`,
    `<meta property="og:url" content="${escapeHtml(post.canonicalUrl)}" />`,
    tags,
    rssLink,
    jsonLd,
  ]
    .filter(Boolean)
    .join("\n    ");
}

/**
 * Revnu links between posts are root-relative, but the blog lives under /blog.
 * Only links to a published post (or the blog root) move; other site links such
 * as /docs stay as written.
 */
export function rewriteLinks({
  html,
  published,
}: {
  html: string;
  published: ReadonlySet<string>;
}): string {
  return html.replace(/href="(\/(?!\/)[^"#?]*)([^"]*)"/g, (link, path: string, rest: string) => {
    if (path === "/") return `href="${BLOG_PATH}${rest}"`;

    return published.has(path) ? `href="${BLOG_PATH}${path}${rest}"` : link;
  });
}

/** When a post last changed: its update time, or its publish time if never updated. */
function changedAt(post: Summary): Date {
  return post.updatedAt ?? post.publishedAt;
}

/** The latest change among `posts`, or null for none. */
function latestChange(posts: readonly Summary[]): Date | null {
  return posts.reduce<Date | null>(
    (latest, post) => (latest === null || changedAt(post) > latest ? changedAt(post) : latest),
    null,
  );
}

/** The absolute URL a post is served at. Feeds and the sitemap list this address. */
function servedUrl(post: Summary): string {
  return `${SITE}${postPath(post)}`;
}

export function renderPost({
  post,
  published,
}: {
  post: Post;
  /** Paths of every post on the site, so related links never point at a removed post. */
  published: ReadonlySet<string>;
}): string {
  const html = rewriteLinks({ html: post.html, published });

  const updated =
    post.updatedAt && post.updatedAt.getTime() !== post.publishedAt.getTime()
      ? ` · updated ${dateTag(post.updatedAt)}`
      : "";

  const toc =
    post.toc.length >= 3
      ? `
        <aside class="toc" aria-label="On this page">
          <b>on this page</b>
          <ul>${post.toc
            .map(
              (entry) =>
                `<li><a href="#${escapeHtml(entry.slug)}">${escapeHtml(entry.text)}</a></li>`,
            )
            .join("")}</ul>
        </aside>`
      : "";

  // FAQPage JSON-LD needs every answer visible. Show each entry the body lacks.
  const inBody = (value: string) => html.includes(value) || html.includes(escapeHtml(value));
  const faqItems = post.faqItems.filter((item) => !inBody(item.question) || !inBody(item.answer));

  const faq =
    faqItems.length > 0
      ? `
        <section class="faq">
          <h2>Frequently asked questions</h2>
          <dl>${faqItems
            .map(
              (item) => `<dt>${escapeHtml(item.question)}</dt><dd>${escapeHtml(item.answer)}</dd>`,
            )
            .join("")}</dl>
        </section>`
      : "";

  const citations = post.citations.filter((url) => !inBody(url));

  const sources =
    citations.length > 0
      ? `
        <section>
          <h2>Sources</h2>
          <ul>${citations
            .map((url) => `<li><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></li>`)
            .join("")}</ul>
        </section>`
      : "";

  const related = post.related.filter(
    (item) => item.canonicalPath !== post.canonicalPath && published.has(item.canonicalPath),
  );

  const relatedSection =
    related.length > 0
      ? `
        <section>
          <h2>Related posts</h2>
          <ul>${related
            .map((item) => `<li><a href="${postPath(item)}">${escapeHtml(item.title)}</a></li>`)
            .join("")}</ul>
        </section>`
      : "";

  // Revnu gives no hero size. Use the Open Graph image's when it is the same
  // file, else the 1200x630 card shape, so the browser reserves about the right space.
  const ogImage = post.headMeta.openGraph
    .filter((field) => field.key === "images" || field.key === "image")
    .flatMap((field) => field.values)
    .find((value) => value.content === post.heroImageUrl);

  const size = (key: string, fallback: string) =>
    ogImage?.details.find((detail) => detail.key === key)?.content ?? fallback;

  const hero = post.heroImageUrl
    ? `<img class="hero" src="${escapeHtml(post.heroImageUrl)}" width="${escapeHtml(size("width", "1200"))}" height="${escapeHtml(size("height", "630"))}" alt="" />`
    : "";

  return renderShell({
    meta: postMeta(post),
    kicker: `<a href="${BLOG_PATH}">blog</a>`,
    heading: escapeHtml(post.title),
    lede: `${post.description ? `${escapeHtml(post.description)}` : ""}<span class="date">${dateTag(post.publishedAt)}${updated}</span>`,
    content: `${hero}${toc}
        <article class="prose">${html}</article>${faq}${sources}${relatedSection}
        <nav class="pager" aria-label="Blog"><a href="${BLOG_PATH}">All posts</a></nav>`,
  });
}

// ---------- feeds ----------

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderRss(posts: readonly Summary[]): string {
  const items = posts
    .map(
      (post) => `
    <item>
      <title>${xml(post.title)}</title>
      <link>${xml(servedUrl(post))}</link>
      <guid isPermaLink="true">${xml(servedUrl(post))}</guid>
      <pubDate>${post.publishedAt.toUTCString()}</pubDate>${post.description ? `\n      <description>${xml(post.description)}</description>` : ""}
    </item>`,
    )
    .join("");

  const latest = latestChange(posts);
  const built = latest ? `\n    <lastBuildDate>${latest.toUTCString()}</lastBuildDate>` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Social SDK blog</title>
    <link>${SITE}${BLOG_PATH}</link>
    <description>${xml(blog.description)}</description>
    <language>en</language>
    <atom:link href="${SITE}${BLOG_PATH}/rss.xml" rel="self" type="application/rss+xml" />${built}${items}
  </channel>
</rss>
`;
}

/**
 * A sitemap of every blog URL with its last-modified time. The build merges it
 * into the site's sitemap.xml (scripts/prune-docs-output.ts).
 */
export function renderSitemap(posts: readonly Summary[]): string {
  const lastmod = (date: Date | null) => (date ? `<lastmod>${date.toISOString()}</lastmod>` : "");

  // Each index page changes when any post it lists changes.
  const indexes = Array.from({ length: pageCount(posts) }, (_, index) => {
    const listed = posts.slice(index * POSTS_PER_PAGE, (index + 1) * POSTS_PER_PAGE);

    return `  <url><loc>${SITE}${indexPath(index + 1)}</loc>${lastmod(latestChange(listed))}</url>`;
  });

  const entries = posts.map(
    (post) => `  <url><loc>${xml(servedUrl(post))}</loc>${lastmod(changedAt(post))}</url>`,
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...indexes, ...entries].join("\n")}
</urlset>
`;
}
