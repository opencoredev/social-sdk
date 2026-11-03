// Search-targeted guides at /guides. Each guide is one page in the info pages'
// hand-drawn shell, with TechArticle and BreadcrumbList structured data.
import { escapeHtml } from "../_blog/render";
import { renderShell, siteMeta } from "../_info/pages";
import { ayrshareAlternatives } from "./ayrshare-alternatives";
import { blueskyApi } from "./bluesky-api";
import { bufferApi } from "./buffer-api";
import { facebookPageAccessToken } from "./facebook-page-access-token";
import { linkedinPostsApi } from "./linkedin-posts-api";
import { socialMediaApis } from "./social-media-apis";
import { threadsApi } from "./threads-api";
import { xApiPricing } from "./x-api-pricing";
import { youtubeUploadApi } from "./youtube-upload-api";

export type Guide = {
  slug: string;
  title: string;
  description: string;
  /** One sentence for the guides index. */
  summary: string;
  heading: string;
  lede: string;
  /** ISO dates (YYYY-MM-DD). */
  published: string;
  updated: string;
  /** HTML, already escaped. */
  content: string;
};

const SITE = "https://social-sdk.dev";

const GUIDES_PATH = "/guides";

export const guides: readonly Guide[] = [
  facebookPageAccessToken,
  ayrshareAlternatives,
  youtubeUploadApi,
  linkedinPostsApi,
  socialMediaApis,
  bufferApi,
  xApiPricing,
  blueskyApi,
  threadsApi,
];

export function guidePath(guide: Pick<Guide, "slug">): string {
  return `${GUIDES_PATH}/${guide.slug}`;
}

type JsonValue = string | number | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function jsonLd(data: { readonly [key: string]: JsonValue }): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replaceAll("<", "\\u003c")}</script>`;
}

function breadcrumbs(items: readonly { name: string; path: string }[]): string {
  return jsonLd({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: `${SITE}${item.path}`,
    })),
  });
}

function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

const index = {
  path: GUIDES_PATH,
  title: "Social media API guides for developers",
  description:
    "Practical guides to social platform APIs: access rules, tokens, rate limits, and tested TypeScript examples with Social SDK.",
};

export function renderGuide(guide: Guide): string {
  const path = guidePath(guide);
  const url = `${SITE}${path}`;

  const article = jsonLd({
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: guide.heading,
    description: guide.description,
    url,
    mainEntityOfPage: url,
    datePublished: guide.published,
    dateModified: guide.updated,
    inLanguage: "en",
    image: `${SITE}/og-home.png`,
    author: {
      "@type": "Organization",
      name: "OpenCore",
      url: "https://github.com/opencoredev",
    },
    publisher: { "@type": "Organization", name: "Social SDK", url: SITE },
  });

  return renderShell({
    meta: [
      siteMeta({ path, title: guide.title, description: guide.description }),
      article,
      breadcrumbs([
        { name: "Home", path: "/" },
        { name: "Guides", path: GUIDES_PATH },
        { name: guide.heading, path },
      ]),
    ].join("\n    "),
    kicker: `updated ${escapeHtml(longDate(guide.updated))}`,
    heading: escapeHtml(guide.heading),
    lede: guide.lede,
    content: `<div class="prose">${guide.content}${relatedGuides(guide)}</div>`,
  });
}

function relatedGuides(guide: Guide): string {
  const items = guides
    .flatMap((other) =>
      other.slug === guide.slug
        ? []
        : [`<li><a href="${guidePath(other)}">${escapeHtml(other.heading)}</a></li>`],
    )
    .join("\n            ");

  return `
          <h2 id="related-guides">Related guides</h2>
          <ul>
            ${items}
          </ul>`;
}

export function renderGuidesIndex(): string {
  const items = guides
    .map(
      (guide) => `
          <li>
            <h2><a href="${guidePath(guide)}">${escapeHtml(guide.heading)}</a></h2>
            <span class="date">Updated <time datetime="${guide.updated}">${escapeHtml(longDate(guide.updated))}</time></span>
            <p>${escapeHtml(guide.summary)}</p>
          </li>`,
    )
    .join("");

  return renderShell({
    meta: [
      siteMeta(index),
      breadcrumbs([
        { name: "Home", path: "/" },
        { name: "Guides", path: GUIDES_PATH },
      ]),
    ].join("\n    "),
    kicker: "platform APIs, explained",
    heading: "Guides",
    lede: "How each social platform's API works, what it lets you do, how the alternatives compare, and how to call it all from TypeScript. Every guide cites its sources and includes an example we ran.",
    content: `<ul class="posts">${items}
        </ul>
        <div class="prose">
          <h2 id="recipes">Framework recipes</h2>
          <p>
            To call Social SDK from a web app, follow the <a href="/docs/integrations/nextjs">Next.js</a>,
            <a href="/docs/integrations/hono">Hono</a>, <a href="/docs/integrations/express">Express</a>, or
            <a href="/docs/integrations/tanstack-start">TanStack Start</a> recipe. To send posts later, use
            <a href="/docs/integrations/inngest">Inngest</a> or <a href="/docs/integrations/trigger-dev">Trigger.dev</a>.
            <a href="/docs/publishing">Publishing</a> explains the outcome you get back for each network.
          </p>
        </div>`,
  });
}
