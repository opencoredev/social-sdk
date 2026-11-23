// Free developer tools at /tools, in the info pages' hand-drawn shell. Each tool
// page is server-rendered HTML that works as a static reference without
// JavaScript; its page script (calculator.client.ts, limits.client.ts) adds the
// live controls.
//
// Direction: the tools read like a marked-up spec sheet from the same notebook as
// /cloud. Ink outlines and offset shadows hold the controls, results read like a
// receipt with marker-red bars, and verdicts are hand-stamped. No gradients, pill
// clouds, or stock card grids.
import { escapeHtml } from "../_blog/render";
import { cloudCallout } from "../_cloud/cloud";
import { renderShell, siteMeta } from "../_info/pages";

export const SITE = "https://social-sdk.dev";

export const TOOLS_PATH = "/tools";

export type Tool = {
  slug: string;
  /** The <title>, at most 47 characters. */
  title: string;
  description: string;
  heading: string;
  /** One sentence for the tools index. */
  summary: string;
};

export const costCalculator: Tool = {
  slug: "api-cost-calculator",
  title: "Social media API cost calculator for developers",
  description:
    "Estimate a month of social media API costs: direct platform APIs with X's pay-per-use credits versus a per-profile unified API, using your own rates.",
  heading: "Social media API cost calculator",
  summary:
    "Compare a month of posting through each platform's own API, with X's pay-per-use credits, against a per-profile unified API, using rates you enter.",
};

export const platformLimits: Tool = {
  slug: "platform-limits",
  title: "Social media post limits and preflight checker",
  description:
    "Check a post against X, Bluesky, Threads, Instagram, LinkedIn, TikTok, YouTube, and Facebook limits for text, images, and video, plus app review rules.",
  heading: "Social media post limits and preflight checker",
  summary:
    "Paste a post and see whether it fits each platform's text, image, and video limits, then compare every platform's specs and access rules in one table.",
};

export const tools: readonly Tool[] = [costCalculator, platformLimits];

export function toolPath(tool: Pick<Tool, "slug">): string {
  return `${TOOLS_PATH}/${tool.slug}`;
}

type JsonValue =
  | string
  | number
  | boolean
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function jsonLd(data: { readonly [key: string]: JsonValue }): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replaceAll("<", "\\u003c")}</script>`;
}

export function breadcrumbs(items: readonly { name: string; path: string }[]): string {
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

/** SoftwareApplication data for a free in-browser tool. */
export function softwareApplication(tool: Tool): string {
  const url = `${SITE}${toolPath(tool)}`;

  return jsonLd({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: tool.heading,
    description: tool.description,
    url,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Any (runs in the browser)",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@type": "Organization", name: "Social SDK", url: SITE },
  });
}

/** Splits a rendered page before </body>, where the .astro page renders its bundled script. */
export function splitAtBodyEnd(html: string): [string, string] {
  const end = html.lastIndexOf("</body>");

  if (end === -1) throw new Error("The tool page has no </body> to put its script before.");

  return [html.slice(0, end), html.slice(end)];
}

/** A copyable code block. The page script wires every [data-copy] button. */
export function codeBlock(id: string, code: string, label: string): string {
  return `<div class="code">
            <div class="code-bar">
              <span>${escapeHtml(label)}</span>
              <button type="button" class="copy" data-copy="${id}">Copy</button>
            </div>
            <pre><code id="${id}">${escapeHtml(code)}</code></pre>
          </div>`;
}

/** Widens the shell for a tool's two-column layout; prose stays at the shell's 760px measure. */
const wideLayout = `<style>
      /* The shell's own styles come after these, so the overrides need the extra specificity. */
      body .wrap {
        max-width: 1080px;
      }
      main > header,
      .measure {
        max-width: 760px;
      }
    </style>`;

export const toolStyles = `<style>
      :root {
        --panel: #fbf8f2;
        --marker-text: #b93c1c;
        --rule-soft: #d8d2c6;
      }
      html.dark {
        --panel: #1b1816;
        --marker-text: #f08a6c;
        --rule-soft: #3b3631;
      }
      .tool {
        display: grid;
        grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
        gap: 36px;
        align-items: start;
        padding-top: 40px;
      }
      .panel {
        position: relative;
        padding: 26px 26px 24px;
        border: 2px solid var(--ink);
        border-radius: 6px;
        background: var(--panel);
        box-shadow: 5px 6px 0 var(--ink);
      }
      html.dark .panel {
        box-shadow: 5px 6px 0 #3b3631;
      }
      .panel h2 {
        font-size: 24px;
      }
      .panel .tape {
        position: absolute;
        top: -14px;
        left: 50%;
        width: 110px;
        height: 28px;
        transform: translateX(-50%) rotate(-2deg);
        background: rgba(232, 84, 47, 0.18);
        border-left: 1px dashed rgba(232, 84, 47, 0.4);
        border-right: 1px dashed rgba(232, 84, 47, 0.4);
      }
      .sticky {
        position: sticky;
        top: 24px;
      }
      .field {
        margin-top: 22px;
        border: 0;
        min-width: 0;
      }
      .field > label:not(.check-row),
      .field > legend,
      .field-label {
        display: block;
        padding: 0;
        color: var(--ink);
        font-weight: 560;
        font-size: 17px;
      }
      .hint {
        margin-top: 2px;
        color: var(--ink-soft);
        font-size: 15px;
        line-height: 1.5;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-top: 10px;
      }
      .tool input[type="number"],
      .tool input[type="search"],
      .tool select,
      .tool textarea {
        padding: 9px 12px;
        border: 2px solid var(--ink);
        border-radius: 6px;
        background: var(--paper);
        color: var(--ink);
        font: inherit;
        font-size: 17px;
      }
      .tool input[type="number"] {
        width: 7.5em;
        font-family: var(--mono);
        font-size: 16px;
        font-variant-numeric: tabular-nums;
      }
      .tool textarea {
        display: block;
        width: 100%;
        margin-top: 10px;
        min-height: 150px;
        resize: vertical;
        line-height: 1.5;
      }
      .tool input:focus-visible,
      .tool select:focus-visible,
      .tool textarea:focus-visible,
      .tool button:focus-visible {
        outline: 3px solid var(--marker);
        outline-offset: 2px;
      }
      .tool input[type="range"] {
        flex: 1 1 auto;
        min-width: 0;
        height: 30px;
        accent-color: var(--marker);
        cursor: pointer;
      }
      .money {
        position: relative;
        display: inline-flex;
        align-items: center;
      }
      .money::before {
        content: "$";
        position: absolute;
        left: 12px;
        color: var(--ink-soft);
        font-family: var(--mono);
        font-size: 16px;
        pointer-events: none;
      }
      .tool .money input[type="number"] {
        padding-left: 26px;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 10px;
      }
      .chip {
        position: relative;
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        padding: 8px 15px;
        border: 2px solid var(--ink);
        border-radius: 999px;
        background: var(--paper);
        color: var(--ink);
        font-size: 16px;
        cursor: pointer;
        user-select: none;
        transition:
          background-color 0.15s ease,
          color 0.15s ease;
      }
      .chip input {
        position: absolute;
        inset: 0;
        margin: 0;
        opacity: 0;
        cursor: pointer;
      }
      .chip:hover:not(:has(input:checked)) {
        background: rgba(232, 84, 47, 0.1);
      }
      .chip:has(input:checked) {
        background: var(--ink);
        color: var(--paper);
      }
      .chip:has(input:focus-visible) {
        outline: 3px solid var(--marker);
        outline-offset: 3px;
      }
      .chip[aria-pressed="true"] {
        background: var(--ink);
        color: var(--paper);
      }
      .chip-sm {
        min-height: 40px;
        padding: 6px 13px;
        font-size: 15px;
        font-family: var(--mono);
      }
      .check-row {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        margin-top: 12px;
        color: var(--ink-soft);
        font-size: 16px;
        line-height: 1.45;
        cursor: pointer;
      }
      .check-row input {
        flex: none;
        width: 20px;
        height: 20px;
        margin-top: 2px;
        accent-color: var(--ink);
      }
      .two {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0 18px;
      }
      .num {
        font-family: var(--mono);
        font-variant-numeric: tabular-nums;
      }
      .total {
        margin-top: 4px;
        font-size: 15px;
        color: var(--ink-soft);
      }
      .bars {
        list-style: none;
        margin: 18px 0 0;
        padding: 0;
      }
      .bars > li {
        padding: 14px 0;
        border-top: 1.5px dashed var(--rule-soft);
      }
      .bars > li:first-child {
        border-top: 0;
        padding-top: 4px;
      }
      .bar-head {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: baseline;
        gap: 2px 12px;
      }
      .bar-head b {
        min-width: 0;
        font-weight: 560;
        font-size: 17px;
      }
      .bar-head .num {
        min-width: 0;
        margin-left: auto;
        font-size: clamp(16px, 5.2vw, 20px);
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      .track {
        height: 14px;
        margin-top: 8px;
        border: 1.5px solid var(--ink);
        border-radius: 4px;
        overflow: hidden;
      }
      .fill {
        display: block;
        height: 100%;
        width: 0;
        background: var(--ink);
        transition: width 0.25s cubic-bezier(0.33, 1, 0.68, 1);
      }
      .fill.marker {
        background: var(--marker);
      }
      .track.empty {
        border-style: dashed;
      }
      .lines {
        list-style: none;
        margin: 8px 0 0;
        padding: 0;
        color: var(--ink-soft);
        font-size: 15px;
      }
      .lines li {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 0 12px;
        margin-top: 2px;
      }
      .lines li > span {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .lines li > .num {
        margin-left: auto;
      }
      .total,
      .verdict-line {
        overflow-wrap: anywhere;
      }
      .bar-note {
        margin-top: 6px;
        color: var(--ink-soft);
        font-size: 15px;
        line-height: 1.45;
      }
      .verdict-line {
        margin-top: 18px;
        padding-top: 14px;
        border-top: 2px solid var(--ink);
        font-size: 17px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 18px;
      }
      .btn {
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        padding: 8px 16px;
        border: 2px solid var(--ink);
        border-radius: 6px;
        background: var(--paper);
        color: var(--ink);
        font: inherit;
        font-size: 16px;
        cursor: pointer;
        transition: transform 0.12s ease;
      }
      .btn:hover {
        background: rgba(232, 84, 47, 0.1);
      }
      .btn:active {
        transform: scale(0.97);
      }
      .btn-ink {
        background: var(--ink);
        color: var(--paper);
      }
      .btn-ink:hover {
        background: var(--ink);
        color: var(--paper);
        box-shadow: 3px 3px 0 var(--marker);
      }
      .status-note {
        min-height: 1.5em;
        margin-top: 8px;
        color: var(--ink-soft);
        font-size: 15px;
      }
      .code {
        margin-top: 18px;
        border: 2px solid var(--ink);
        border-radius: 6px;
        overflow: hidden;
        background: var(--paper);
      }
      .code-bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 6px 8px 6px 14px;
        border-bottom: 1.5px solid var(--ink);
        color: var(--ink-soft);
        font-family: var(--mono);
        font-size: 13px;
      }
      .copy {
        min-height: 36px;
        padding: 4px 12px;
        border: 1.5px solid var(--ink);
        border-radius: 5px;
        background: var(--paper);
        color: var(--ink);
        font: inherit;
        cursor: pointer;
      }
      .copy:hover {
        background: rgba(232, 84, 47, 0.1);
      }
      .code pre {
        max-height: 460px;
        margin: 0;
        padding: 14px 16px;
        overflow: auto;
        font-size: 13.5px;
        line-height: 1.55;
      }
      .code code {
        font-size: inherit;
      }
      .measure .partners {
        margin-top: 14px;
        padding: 0;
        list-style: none;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px 18px;
      }
      .measure .partners li + li {
        margin-top: 0;
      }
      .measure .partners a {
        font-weight: 560;
      }
      .measure .partners span {
        display: block;
        color: var(--ink-soft);
        font-size: 15px;
        line-height: 1.45;
      }
      .sources {
        font-size: 15px;
      }
      .measure .tool-list {
        list-style: none;
        padding: 0;
        margin-top: 28px;
        display: grid;
        gap: 30px;
      }
      .measure .tool-list li + li {
        margin-top: 0;
      }
      .tool-card {
        display: grid;
        grid-template-columns: 74px minmax(0, 1fr);
        gap: 6px 22px;
        align-items: start;
      }
      .tool-card svg {
        grid-row: span 2;
        width: 74px;
        height: 74px;
      }
      .tool-card h2 a {
        text-decoration: none;
      }
      .tool-card h2 a:hover {
        text-decoration: underline;
        text-decoration-color: var(--marker);
      }
      .tool-card p {
        margin-top: 0;
      }
      @media (max-width: 860px) {
        .tool {
          grid-template-columns: minmax(0, 1fr);
          gap: 30px;
        }
        .sticky {
          position: relative;
          top: 0;
        }
      }
      @media (max-width: 560px) {
        .panel {
          padding: 24px 18px 20px;
          box-shadow: 4px 5px 0 var(--ink);
        }
        .two,
        .measure .partners {
          grid-template-columns: minmax(0, 1fr);
        }
        .tool-card {
          grid-template-columns: 52px minmax(0, 1fr);
          gap: 4px 16px;
        }
        .tool-card svg {
          width: 52px;
          height: 52px;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .fill,
        .btn,
        .chip {
          transition: none;
        }
      }
    </style>`;

/** Fills the shared shell for a tool page, with the tool styles and structured data. */
export function renderToolShell(page: {
  path: string;
  title: string;
  description: string;
  kicker: string;
  heading: string;
  lede: string;
  content: string;
  structuredData: readonly string[];
  styles?: string;
  /** Two-column tool pages use the wider layout; the index keeps the shell's width. */
  wide: boolean;
}): string {
  return renderShell({
    meta: [
      siteMeta(page),
      ...page.structuredData,
      toolStyles,
      ...(page.wide ? [wideLayout] : []),
      ...(page.styles === undefined ? [] : [page.styles]),
    ].join("\n    "),
    kicker: page.kicker,
    heading: escapeHtml(page.heading),
    lede: page.lede,
    content: page.content,
  });
}

/** Each tool's hand-drawn mark, by slug. */
const icons = new Map([
  [
    costCalculator.slug,
    `<svg viewBox="0 0 74 74" fill="none" aria-hidden="true" filter="url(#roughen)"><rect x="12" y="8" width="50" height="58" rx="5" stroke="#1c1a17" stroke-width="2.4"/><rect x="20" y="16" width="34" height="12" rx="2" stroke="#1c1a17" stroke-width="2"/><path d="M22 40h6M34 40h6M46 40h6M22 50h6M34 50h6M46 50h6M22 59h18" stroke="#1c1a17" stroke-width="2.4" stroke-linecap="round"/><path d="M47 59h6" stroke="#e8542f" stroke-width="2.6" stroke-linecap="round"/></svg>`,
  ],
  [
    platformLimits.slug,
    `<svg viewBox="0 0 74 74" fill="none" aria-hidden="true" filter="url(#roughen)"><rect x="10" y="10" width="54" height="54" rx="5" stroke="#1c1a17" stroke-width="2.4"/><path d="M20 26h22M20 37h30M20 48h16" stroke="#1c1a17" stroke-width="2.4" stroke-linecap="round"/><path d="M44 48l5 5 10-12" stroke="#e8542f" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  ],
]);

const index = {
  path: TOOLS_PATH,
  title: "Free social media API tools for developers",
  description:
    "Free tools for developers adding social posting to an app: a social media API cost calculator and a post limits checker for X, Bluesky, Threads, and more.",
};

export function renderToolsIndex(): string {
  const items = tools
    .map(
      (tool) => `
          <li class="tool-card">
            ${icons.get(tool.slug) ?? ""}
            <h2><a href="${toolPath(tool)}">${escapeHtml(tool.heading)}</a></h2>
            <p>${escapeHtml(tool.summary)}</p>
          </li>`,
    )
    .join("");

  const collection = jsonLd({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Free social media API tools for developers",
    description: index.description,
    url: `${SITE}${TOOLS_PATH}`,
    mainEntity: {
      "@type": "ItemList",
      itemListElement: tools.map((tool, position) => ({
        "@type": "ListItem",
        position: position + 1,
        url: `${SITE}${toolPath(tool)}`,
        name: tool.heading,
      })),
    },
  });

  return renderToolShell({
    ...index,
    kicker: "free, no sign-up, runs in your browser",
    heading: "Developer tools",
    wide: false,
    lede: `Small tools for planning social media API work: what a month of posting costs, and whether a post fits every platform before you send it. Both run in your browser; post text stays local, and calculator numbers appear in the page URL when you edit or share a scenario. The <a href="/privacy">privacy policy</a> covers site analytics.`,
    structuredData: [
      collection,
      breadcrumbs([
        { name: "Home", path: "/" },
        { name: "Tools", path: TOOLS_PATH },
      ]),
    ],
    content: `<div class="measure">
        <ul class="tool-list">${items}
        </ul>
        <section>
          <h2>Go further</h2>
          <p>
            The <a href="/guides">guides</a> explain how each platform's API works, with sources
            and tested TypeScript. The <a href="/docs">docs</a> cover the Social SDK package, from
            <a href="/docs/getting-started/installation">installation</a> to the
            <a href="/docs/reference/capabilities">capability matrix</a>. To post from your own
            framework, start with the <a href="/docs/integrations/nextjs">Next.js</a>,
            <a href="/docs/integrations/hono">Hono</a>, or
            <a href="/docs/integrations/tanstack-start">TanStack Start</a> recipe, and queue posts
            with <a href="/docs/integrations/inngest">Inngest</a>.
          </p>
          ${cloudCallout}
        </section>
      </div>`,
  });
}
