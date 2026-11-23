// /tools/platform-limits: the post preflight checker and the platform spec and
// access matrix. The checker is rendered for a sample post so the page is a
// complete reference without JavaScript; limits.client.ts makes it live.
import { escapeHtml } from "./escape";
import { cloudCallout } from "../_cloud/cloud";
import { platformSpecs, textLimitLabel, type PlatformSpec } from "./platforms";
import { preflight, type MediaPlan } from "./preflight";
import { renderResults, summary } from "./preflight-view";
import { FACEBOOK_SUBPATH_NOTE, npmPlatformIds, socialSnippet } from "./snippet";
import {
  breadcrumbs,
  codeBlock,
  platformLimits,
  renderToolShell,
  softwareApplication,
  TOOLS_PATH,
  toolPath,
} from "./tools";

export const SAMPLE_POST =
  "We just shipped v2 of our scheduler 🚀 Changelog and migration notes: https://example.com/changelog #buildinpublic";

const sampleMedia: MediaPlan = { kind: "none" };

const limitsStyles = `<style>
      .tool textarea#post-text {
        min-height: 170px;
      }
      .media-modes {
        margin-top: 10px;
      }
      .media-extra {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0 14px;
      }
      .media-extra .field {
        margin-top: 14px;
      }
      .media-extra input[type="number"] {
        width: 100%;
      }
      .media-extra [hidden] {
        display: none;
      }
      .field-error {
        margin-top: 4px;
        color: var(--marker-text);
        font-size: 14px;
        line-height: 1.35;
      }
      .field-error[hidden] {
        display: none;
      }
      .tool input[aria-invalid="true"] {
        border-color: var(--marker-text);
        box-shadow: 0 0 0 1px var(--marker-text);
      }
      .summary {
        margin-top: 6px;
        color: var(--ink-soft);
        font-size: 16px;
      }
      .results {
        list-style: none;
        margin: 12px 0 0;
        padding: 0;
      }
      .result {
        padding: 14px 0;
        border-top: 1.5px dashed var(--rule-soft);
      }
      .result:first-child {
        border-top: 0;
      }
      .result-head {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: 6px 12px;
      }
      .result-head b {
        min-width: 0;
        overflow-wrap: anywhere;
        font-weight: 560;
        font-size: 18px;
      }
      .stamp {
        flex: none;
        padding: 0 10px;
        border: 2px solid var(--ink);
        border-radius: 5px;
        font-family: var(--hand);
        font-size: 21px;
        line-height: 28px;
        transform: rotate(-2deg);
      }
      .stamp.warn {
        border-style: dashed;
        border-color: var(--marker-text);
        color: var(--marker-text);
        transform: rotate(1.5deg);
      }
      .stamp.fail {
        border-color: var(--marker-text);
        background: var(--marker-text);
        color: var(--paper);
      }
      html.dark .stamp.fail {
        color: #131110;
      }
      .meter {
        height: 8px;
        margin-top: 10px;
        border: 1.5px solid var(--ink);
        border-radius: 4px;
        overflow: hidden;
      }
      .meter span {
        display: block;
        height: 100%;
        background: var(--ink);
      }
      .meter.over span {
        background: var(--marker);
      }
      .meter-num {
        margin-top: 4px;
        color: var(--ink-soft);
        font-size: 14px;
      }
      .checks,
      .notes {
        list-style: none;
        margin: 8px 0 0;
        padding: 0;
        font-size: 15px;
        line-height: 1.45;
      }
      .checks li,
      .notes li {
        margin-top: 4px;
      }
      .checks li {
        color: var(--ink-soft);
      }
      .checks li.fail,
      .checks li.warn {
        color: var(--marker-text);
      }
      .checks b {
        font-weight: 560;
      }
      .notes li {
        color: var(--ink-soft);
        padding-left: 14px;
        position: relative;
      }
      .notes li::before {
        content: "~";
        position: absolute;
        left: 0;
        color: var(--marker);
      }
      a.more {
        display: inline-block;
        margin-top: 8px;
        font-size: 15px;
      }
      .filters {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px 14px;
        margin-top: 18px;
      }
      .filters input[type="search"] {
        flex: 1 1 200px;
        min-width: 0;
      }
      .matrix-wrap {
        margin-top: 18px;
        border: 2px solid var(--ink);
        border-radius: 6px;
        overflow-x: auto;
      }
      .matrix {
        width: 100%;
        border-collapse: collapse;
        font-size: 15px;
        line-height: 1.45;
      }
      .matrix th,
      .matrix td {
        padding: 10px 12px;
        border-bottom: 1px solid var(--rule-soft);
        text-align: left;
        vertical-align: top;
      }
      .matrix thead th {
        border-bottom: 2px solid var(--ink);
        color: var(--ink);
        font-weight: 560;
        white-space: nowrap;
      }
      .matrix tbody th {
        font-weight: 560;
        white-space: nowrap;
      }
      .matrix td {
        color: var(--ink-soft);
      }
      .matrix td code {
        font-size: 0.82em;
        overflow-wrap: break-word;
      }
      .scopes {
        display: block;
        margin-top: 4px;
      }
      .matrix .links {
        min-width: 200px;
      }
      .matrix .links > a,
      .matrix .links .source,
      .matrix .links .checked {
        display: block;
      }
      .matrix .links .source {
        margin-top: 4px;
        line-height: 1.3;
      }
      .matrix .links .checked {
        font-size: 13px;
      }
      .matrix tr[hidden] {
        display: none;
      }
      .matrix-empty {
        padding: 16px;
        color: var(--ink-soft);
      }
      @media (max-width: 860px) {
        .matrix thead {
          display: none;
        }
        .matrix,
        .matrix tbody,
        .matrix tr,
        .matrix th,
        .matrix td {
          display: block;
          width: 100%;
        }
        .matrix tr {
          padding: 12px 14px;
          border-bottom: 1.5px dashed var(--rule-soft);
        }
        .matrix tbody th,
        .matrix td {
          padding: 3px 0;
          border: 0;
        }
        .matrix tbody th {
          font-size: 18px;
        }
        .matrix td::before {
          content: attr(data-label) ": ";
          color: var(--ink);
          font-weight: 560;
        }
        .matrix .links > a {
          display: inline;
          margin-right: 12px;
        }
        .matrix .links .checked {
          display: inline;
        }
      }
      @media (max-width: 560px) {
        .media-extra {
          grid-template-columns: minmax(0, 1fr);
        }
      }
    </style>`;

function imageCell(spec: PlatformSpec): string {
  if (spec.image === null) return "Not supported";

  const size = spec.image.size === undefined ? "" : `, ${spec.image.size.label} each`;

  const carousel =
    spec.carousel === null
      ? ""
      : `. Multi-item posts: ${spec.carousel.min} to ${spec.carousel.max}`;

  return escapeHtml(`Up to ${spec.image.maxPerPost} (${spec.image.formats})${size}${carousel}`);
}

function videoCell(spec: PlatformSpec): string {
  const video = spec.video;

  if (video === null) return "Not supported";

  const { min, max } = video.duration;

  const length =
    min !== undefined && max !== undefined
      ? `${min} s to ${max.toLocaleString("en-US")} s`
      : max !== undefined
        ? `up to ${max.toLocaleString("en-US")} s`
        : (video.duration.summary ?? "no published length limit");

  const size = video.size === undefined ? "no published size limit" : `up to ${video.size.label}`;

  return escapeHtml(`One video, ${length}, ${size}. ${video.formats}.`);
}

/**
 * A scope list such as "instagram_business_basic, instagram_business_content_publish",
 * escaped, with break opportunities after "_", ".", and "/" so a narrow cell wraps
 * between the parts of a token instead of at an arbitrary letter.
 */
export function scopesHtml(scopes: string): string {
  return escapeHtml(scopes).replace(/([_./])(?=[A-Za-z0-9])/g, "$1<wbr>");
}

function matrixRow(spec: PlatformSpec): string {
  const guides = spec.guides
    .map((guide) => `<a href="${guide.path}">${escapeHtml(guide.label)} guide</a>`)
    .join("");

  const sources = spec.sources
    .map(
      (source) =>
        `<span class="source"><a href="${escapeHtml(source.url)}">${escapeHtml(source.label)}</a> <span class="checked">checked ${source.checked}</span></span>`,
    )
    .join("");

  return `<tr data-name="${spec.id} ${escapeHtml(spec.name.toLowerCase())}" data-text="${spec.textOnly}" data-carousel="${spec.carousel !== null}" data-video="${spec.video !== null}">
                  <th scope="row"><a href="${spec.docsPath}">${escapeHtml(spec.name)}</a></th>
                  <td data-label="Text">${escapeHtml(textLimitLabel(spec.text))}${spec.textOnly ? "" : ". Needs media"}${spec.tags === undefined ? "" : `. Up to ${spec.tags.hashtags} hashtags and ${spec.tags.mentions} @ tags`}</td>
                  <td data-label="Images">${imageCell(spec)}</td>
                  <td data-label="Video">${videoCell(spec)}</td>
                  <td data-label="Access and review">${escapeHtml(spec.access)} <code class="scopes">${scopesHtml(spec.scopes)}</code></td>
                  <td data-label="Posting limit">${escapeHtml(spec.rateLimit)}</td>
                  <td data-label="Read more" class="links"><a href="${spec.docsPath}">${escapeHtml(spec.name)} docs</a>${guides}${sources}</td>
                </tr>`;
}

function checker(): string {
  const results = preflight(SAMPLE_POST, npmPlatformIds, sampleMedia);

  const platformChips = platformSpecs
    .map(
      (spec) =>
        `<label class="chip"><input type="checkbox" name="platforms" value="${spec.id}"${npmPlatformIds.includes(spec.id) ? " checked" : ""} /><span>${escapeHtml(spec.name)}</span></label>`,
    )
    .join("\n                ");

  const modes = [
    ["none", "None"],
    ["image", "Image"],
    ["carousel", "Carousel"],
    ["video", "Video"],
  ] as const;

  const modeChips = modes
    .map(
      ([value, label]) =>
        `<label class="chip"><input type="radio" name="media" value="${value}"${value === sampleMedia.kind ? " checked" : ""} /><span>${label}</span></label>`,
    )
    .join("");

  return `<div class="tool">
          <form class="panel sticky" id="preflight" aria-labelledby="post-heading">
            <h2 id="post-heading">Your post</h2>
            <div class="field">
              <label for="post-text">Post text</label>
              <p class="hint">Your post text stays in your browser and is never sent to a server (<a href="/privacy">privacy</a>).</p>
              <textarea id="post-text" spellcheck="true">${escapeHtml(SAMPLE_POST)}</textarea>
            </div>
            <fieldset class="field">
              <legend>Platforms</legend>
              <div class="chips">
                ${platformChips}
              </div>
              <p class="hint" id="facebook-note" hidden>Facebook: ${escapeHtml(FACEBOOK_SUBPATH_NOTE)}</p>
            </fieldset>
            <fieldset class="field">
              <legend>Media</legend>
              <div class="chips media-modes">${modeChips}</div>
              <div class="media-extra">
                <div class="field" id="count-field" hidden><label class="field-label" for="media-count">Items</label><input id="media-count" type="number" inputmode="numeric" min="1" max="40" step="1" value="4" aria-describedby="media-count-error" /><p class="field-error" id="media-count-error" hidden></p></div>
                <div class="field" id="seconds-field" hidden><label class="field-label" for="video-seconds">Length (seconds)</label><input id="video-seconds" type="number" inputmode="decimal" min="0" step="any" placeholder="45" aria-describedby="video-seconds-error" /><p class="field-error" id="video-seconds-error" hidden></p></div>
                <div class="field" id="size-field" hidden><label class="field-label" for="media-size">Size per file (MB)</label><input id="media-size" type="number" inputmode="decimal" min="0" step="any" placeholder="12" aria-describedby="media-size-error" /><p class="field-error" id="media-size-error" hidden></p></div>
              </div>
            </fieldset>
          </form>
          <div class="panel" aria-labelledby="verdict-heading">
            <span class="tape" aria-hidden="true"></span>
            <h2 id="verdict-heading">Preflight</h2>
            <p class="summary" id="summary" aria-live="polite">${escapeHtml(summary(results))}</p>
            <ul class="results" id="results">
            ${renderResults(results)}
            </ul>
          </div>
        </div>`;
}

export function renderPlatformLimits(): string {
  const path = toolPath(platformLimits);

  const content = `
        ${checker()}
        <div class="measure">
          <section aria-labelledby="matrix-heading">
            <h2 id="matrix-heading">Platform spec and access matrix</h2>
            <p>
              Text, image, and video limits, what each platform needs before an app can post for
              other people, and the main posting limit. Each row links to the platform's docs
              page, which lists every limit with the provider's source.
            </p>
          </section>
        </div>
        <div class="filters" role="group" aria-label="Filter platforms">
          <input type="search" id="matrix-search" placeholder="Filter by name" aria-label="Filter platforms by name" />
          <label class="chip"><input type="radio" name="matrix-filter" value="all" checked /><span>All</span></label>
          <label class="chip"><input type="radio" name="matrix-filter" value="text" /><span>Text-only posts</span></label>
          <label class="chip"><input type="radio" name="matrix-filter" value="carousel" /><span>Multi-image</span></label>
          <label class="chip"><input type="radio" name="matrix-filter" value="video" /><span>Video</span></label>
        </div>
        <div class="matrix-wrap">
          <table class="matrix" id="matrix">
            <thead>
              <tr><th scope="col">Platform</th><th scope="col">Text</th><th scope="col">Images</th><th scope="col">Video</th><th scope="col">Access and review</th><th scope="col">Posting limit</th><th scope="col">Read more</th></tr>
            </thead>
            <tbody>
                ${platformSpecs.map(matrixRow).join("\n                ")}
            </tbody>
          </table>
          <p class="matrix-empty" id="matrix-empty" hidden>No platform matches that filter.</p>
        </div>
        <div class="measure">
          <section aria-labelledby="code-heading">
            <h2 id="code-heading">Check it in code</h2>
            <p>
              The SDK runs the same checks, and a few this page can't, such as MIME types and
              carousel aspect ratios. <code>social.posts.prepare</code> returns a typed issue
              for every target that breaks a rule, before any request is sent. The sample
              follows the platforms and text above and type-checks against the npm release
              0.5.0; Facebook's subpath isn't in that release yet.
            </p>
            ${codeBlock("snippet", socialSnippet(npmPlatformIds, SAMPLE_POST), "preflight.ts")}
          </section>
          <section aria-labelledby="how-heading">
            <h2 id="how-heading">How the checker counts</h2>
            <ul>
              <li><b>X</b> weighs text: most Latin characters count 1, other characters and emoji 2, and every URL 23, the length of a t.co link, against 280. X Premium long-form posts can hold 25,000. The page runs the SDK's own counter, with X's full list of link domains, so a bare link such as example.education counts as 23 here too.</li>
              <li><b>Bluesky</b> counts graphemes, what a reader sees as one character, so a family emoji is 1. A post must also fit in 3,000 UTF-8 bytes.</li>
              <li><b>Threads</b> counts characters, but each emoji by its UTF-8 bytes: 125 😀 fill the 500.</li>
              <li><b>Instagram, LinkedIn, TikTok, and Facebook</b> are checked by string length, as the SDK checks them (Facebook caps Page post text at 63,206 characters). <b>YouTube</b> measures the description in UTF-8 bytes and rejects &lt; and &gt;. <b>TikTok</b> also needs each video's length, above 0 seconds.</li>
              <li><b>Sizes</b> are in MB (1,000,000 bytes). Where the SDK checks against MiB, the limit says so.</li>
            </ul>
            <p>
              Limits come from each platform's docs page, which cites the provider's own pages and
              the date they were checked. Platforms change them, so check the provider before you
              build a feature on a limit. For each platform's access rules and review steps in more
              depth, read <a href="/guides/social-media-apis">social media APIs compared</a>. To
              estimate what posting costs, use the <a href="${TOOLS_PATH}/api-cost-calculator">API cost calculator</a>.
            </p>
            ${cloudCallout}
          </section>
        </div>`;

  return renderToolShell({
    path,
    wide: true,
    title: platformLimits.title,
    description: platformLimits.description,
    kicker: "check it before you send it",
    heading: platformLimits.heading,
    lede: "Paste a post, pick platforms and media, and see where it fits X, Bluesky, Threads, Instagram, LinkedIn, TikTok, YouTube, and Facebook, and where it breaks a limit. Below it, every platform's text, media, and access rules in one table.",
    structuredData: [
      softwareApplication(platformLimits),
      breadcrumbs([
        { name: "Home", path: "/" },
        { name: "Tools", path: TOOLS_PATH },
        { name: platformLimits.heading, path },
      ]),
    ],
    styles: limitsStyles,
    content,
  });
}
