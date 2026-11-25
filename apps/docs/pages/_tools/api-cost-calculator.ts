// /tools/api-cost-calculator. The markup is rendered with the default scenario
// so the page reads as a worked example without JavaScript; calculator.client.ts
// recomputes it from the controls and keeps the URL in sync.
import { escapeHtml } from "../_blog/render";
import { cloudCallout } from "../_cloud/cloud";
import {
  defaultScenario,
  estimate,
  formatUsd,
  limits,
  profilePresets,
  X_PRICING_URL,
  X_RATES_READ,
  type Estimate,
} from "./cost";
import { platformSpecs } from "./platforms";
import { SNIPPET_TEXT, socialSnippet } from "./snippet";
import {
  breadcrumbs,
  codeBlock,
  costCalculator,
  renderToolShell,
  softwareApplication,
  TOOLS_PATH,
  toolPath,
} from "./tools";

const AYRSHARE_PRICING = "https://www.ayrshare.com/pricing";

const AYRSHARE_X_KEYS =
  "https://www.ayrshare.com/docs/dashboard/connect-social-accounts/x-twitter-byo-keys";

/** When the Ayrshare guide read Ayrshare's pricing and X-app pages. */
const AYRSHARE_READ = "2 November 2026";

const partners = [
  {
    name: "Zernio",
    path: "/docs/backends/zernio",
    note: "Publish now or scheduled, with comments, messages, and HMAC-signed webhooks.",
  },
  {
    name: "Post for Me",
    path: "/docs/backends/post-for-me",
    note: "Publish now or scheduled to nine networks, with post reads and status.",
  },
  {
    name: "PostFast",
    path: "/docs/backends/postfast",
    note: "Scheduled publishing with media upload and post analytics on every platform.",
  },
  {
    name: "Postiz",
    path: "/docs/backends/postiz",
    note: "Open source (AGPL-3.0): use Postiz Cloud, or host it yourself with your own apps.",
  },
  {
    name: "Buffer",
    path: "/docs/backends/buffer",
    note: "Adds posts to each Buffer channel's queue; the API is on every Buffer plan.",
  },
] as const;

const lineItems = (lines: Estimate["direct"]["lines"]) =>
  lines
    .map(
      (line) =>
        `<li><span>${escapeHtml(line.label)}</span><span class="num">${formatUsd(line.amount)}</span></li>`,
    )
    .join("");

function results(initial: Estimate): string {
  return `<div class="panel sticky" aria-labelledby="result-heading">
            <span class="tape" aria-hidden="true"></span>
            <h2 id="result-heading">A month at these numbers</h2>
            <p class="total" id="volume">${initial.platformPosts.toLocaleString("en-US")} platform posts, ${initial.xPosts.toLocaleString("en-US")} of them on X.</p>
            <ul class="bars" aria-live="polite">
              <li>
                <div class="bar-head"><b>Direct APIs with Social SDK</b><span class="num" id="direct-total">${formatUsd(initial.direct.monthly)}</span></div>
                <div class="track"><span class="fill" id="direct-fill" style="width:100%"></span></div>
                <ul class="lines" id="direct-lines">${lineItems(initial.direct.lines)}</ul>
                <p class="bar-note">You register each platform's app, pass its review, and run OAuth callbacks and webhooks yourself.</p>
              </li>
              <li>
                <div class="bar-head"><b>Per-profile unified API</b><span class="num" id="unified-total">Add a rate</span></div>
                <div class="track empty" id="unified-track"><span class="fill marker" id="unified-fill"></span></div>
                <ul class="lines" id="unified-lines"></ul>
                <p class="bar-note" id="unified-note">Enter the per-profile price from the provider's own pricing page to compare.</p>
              </li>
            </ul>
            <p class="verdict-line" id="per-profile">Per profile: <span class="num">${formatUsd(initial.direct.monthly / defaultScenario.profiles)}</span> a month direct.</p>
            <div class="actions">
              <button type="button" class="btn btn-ink" id="share">Copy link to this scenario</button>
              <button type="button" class="btn" id="reset">Reset</button>
            </div>
            <p class="status-note" id="share-status" role="status"></p>
          </div>`;
}

function platformChips(): string {
  return platformSpecs
    .map(
      (spec) =>
        `<label class="chip"><input type="checkbox" name="platforms" value="${spec.id}"${defaultScenario.platforms.includes(spec.id) ? " checked" : ""} /><span>${escapeHtml(spec.name)}</span></label>`,
    )
    .join("\n                ");
}

const money = (id: string, value: string, label: string, extra = "") =>
  `<span class="money"><input id="${id}" type="number" inputmode="decimal" min="0" max="${limits.rate.max}" step="any" value="${value}" aria-label="${escapeHtml(label)}"${extra} /></span>`;

function controls(): string {
  const presets = profilePresets
    .map(
      (preset) =>
        `<button type="button" class="chip chip-sm" data-preset="${preset}" aria-pressed="${preset === defaultScenario.profiles}">${preset}</button>`,
    )
    .join("");

  return `<form class="panel" id="calculator" aria-labelledby="inputs-heading">
            <h2 id="inputs-heading">Your numbers</h2>
            <div class="field">
              <label for="profiles">Profiles</label>
              <p class="hint" id="profiles-hint">Customers, brands, or locations, each with its own connected accounts.</p>
              <div class="row">
                <input id="profiles-range" type="range" min="${limits.profiles.min}" max="1000" step="1" value="${defaultScenario.profiles}" aria-label="Profiles" aria-describedby="profiles-hint" />
                <input id="profiles" type="number" inputmode="numeric" min="${limits.profiles.min}" max="${limits.profiles.max}" step="1" value="${defaultScenario.profiles}" aria-describedby="profiles-hint" />
              </div>
              <div class="chips" role="group" aria-label="Profile presets">${presets}</div>
            </div>
            <div class="field">
              <label for="posts">Posts per profile, each month</label>
              <p class="hint">Each post goes to every platform you pick below.</p>
              <div class="row">
                <input id="posts-range" type="range" min="${limits.postsPerProfile.min}" max="300" step="1" value="${defaultScenario.postsPerProfile}" aria-label="Posts per profile" />
                <input id="posts" type="number" inputmode="numeric" min="${limits.postsPerProfile.min}" max="${limits.postsPerProfile.max}" step="1" value="${defaultScenario.postsPerProfile}" />
              </div>
            </div>
            <fieldset class="field">
              <legend>Platforms</legend>
              <div class="chips">
                ${platformChips()}
              </div>
            </fieldset>
            <div class="field">
              <label for="links">Posts with a link (%)</label>
              <p class="hint" id="links-hint">X bills a post that contains a URL at a higher rate.</p>
              <div class="row">
                <input id="links-range" type="range" min="${limits.linkShare.min}" max="${limits.linkShare.max}" step="1" value="${defaultScenario.linkShare}" aria-label="Posts with a link, percent" aria-describedby="links-hint" />
                <input id="links" type="number" inputmode="decimal" min="${limits.linkShare.min}" max="${limits.linkShare.max}" step="any" value="${defaultScenario.linkShare}" aria-describedby="links-hint" />
              </div>
            </div>
            <fieldset class="field">
              <legend>X rates per post</legend>
              <p class="hint">Defaults are X's prices as read on ${X_RATES_READ} (<a href="${X_PRICING_URL}">X pricing</a>). Check the Developer Console for today's.</p>
              <div class="two">
                <div class="field"><label class="field-label" for="x-rate">Plain post</label><div class="row">${money("x-rate", String(defaultScenario.xPostRate), "X price per plain post")}</div></div>
                <div class="field"><label class="field-label" for="x-url-rate">Post with a URL</label><div class="row">${money("x-url-rate", String(defaultScenario.xUrlPostRate), "X price per post with a URL")}</div></div>
              </div>
            </fieldset>
            <fieldset class="field">
              <legend>Running it yourself, per month</legend>
              <div class="two">
                <div class="field"><label class="field-label" for="hosting">Hosting and webhooks</label><div class="row">${money("hosting", "0", "Hosting and webhooks per month")}</div></div>
                <div class="field"><label class="field-label" for="other-fees">Other platform fees</label><div class="row">${money("other-fees", "0", "Other platform fees per month")}</div></div>
              </div>
              <p class="hint">The estimate assumes no API fees on platforms other than X. Check each platform's terms; most gate access through app review and quotas instead.</p>
            </fieldset>
            <fieldset class="field">
              <legend>Per-profile unified API</legend>
              <p class="hint">Unified APIs such as Ayrshare bill per social profile (<a href="${AYRSHARE_PRICING}">Ayrshare pricing</a>, read ${AYRSHARE_READ}). Enter the rate for your plan; this page quotes none.</p>
              <div class="two">
                <div class="field"><label class="field-label" for="profile-rate">Price per profile</label><div class="row">${money("profile-rate", "", "Unified API price per profile per month", ' placeholder="0.00"')}</div></div>
                <div class="field"><label class="field-label" for="base-fee">Monthly platform fee</label><div class="row">${money("base-fee", "0", "Unified API monthly platform fee")}</div></div>
              </div>
              <label class="check-row"><input type="checkbox" id="own-x" checked /><span>It posts to X through my own X app, so X still bills my credits. Ayrshare has required this since 31 March 2026 (<a href="${AYRSHARE_X_KEYS}">Ayrshare X setup</a>).</span></label>
            </fieldset>
          </form>`;
}

export function renderCostCalculator(): string {
  const initial = estimate(defaultScenario);

  const path = toolPath(costCalculator);

  const content = `
        <div class="tool">
          ${controls()}
          ${results(initial)}
        </div>
        <div class="measure">
          <section aria-labelledby="partners-heading">
            <h2 id="partners-heading">Already pay for a managed backend?</h2>
            <p>
              Keep it. Social SDK has adapters for these managed backends, so the same
              <code>social.posts.publish</code> call goes through your provider account instead
              of each platform's API, and you can switch routes later without rewriting app code.
              You pay the provider directly under its own plan.
            </p>
            <ul class="partners">
              ${partners.map((partner) => `<li><a href="${partner.path}">${partner.name}</a><span>${escapeHtml(partner.note)}</span></li>`).join("\n              ")}
            </ul>
          </section>
          <section aria-labelledby="code-heading">
            <h2 id="code-heading">The code for these platforms</h2>
            <p>
              One client with a direct adapter per platform you picked. <code>posts.prepare</code>
              lists every limit a target breaks before anything is sent, and each target gets its
              own outcome. Try it first with the <a href="/docs/getting-started/mock-quickstart">mock backend</a>,
              which needs no credentials.
            </p>
            ${codeBlock("snippet", socialSnippet(defaultScenario.platforms, SNIPPET_TEXT), "post.ts")}
          </section>
          <section aria-labelledby="how-heading">
            <h2 id="how-heading">How the estimate works</h2>
            <ul>
              <li><b>Direct APIs.</b> Social SDK is MIT-licensed and free. X bills each post from prepaid credits: profiles × posts × (plain rate, or the URL rate for the share of posts with a link). Hosting and other fees are whatever you enter.</li>
              <li><b>Per-profile unified API.</b> Profiles × your per-profile rate, plus any platform fee, plus X credits when the provider posts through your own X app.</li>
              <li><b>Left out.</b> Reads, replies, media metadata, and analytics calls. X bills those too (a post read was $0.005 when the <a href="/guides/x-api-pricing">X API pricing guide</a> checked), and per-profile plans have their own post quotas.</li>
              <li><b>Not priced.</b> Your time to register platform apps, pass Meta App Review, LinkedIn's Community Management review, and TikTok's audit, and to keep OAuth tokens fresh. That work is the real cost of the direct route.</li>
            </ul>
          </section>
          <section id="sources" aria-labelledby="sources-heading">
            <h2 id="sources-heading">Sources</h2>
            <ul class="sources">
              <li><a href="${X_PRICING_URL}">X API pricing</a>, read ${X_RATES_READ}: $0.015 per post, $0.20 per post with a URL. Prices change; X's Developer Console has the current ones.</li>
              <li><a href="${AYRSHARE_PRICING}">Ayrshare pricing</a> and <a href="${AYRSHARE_X_KEYS}">Ayrshare's X setup</a>, read ${AYRSHARE_READ}: billing per social profile, and your own X app since 31 March 2026.</li>
              <li><a href="/docs/backends">Managed backends</a>: what each supported provider's adapter covers.</li>
            </ul>
            <p>
              More detail: <a href="/guides/x-api-pricing">X API pricing</a>,
              <a href="/guides/ayrshare-alternatives">Ayrshare alternatives</a>, and
              <a href="/guides/social-media-apis">social media APIs compared</a>. To check a post
              against every platform's limits, use the <a href="${TOOLS_PATH}/platform-limits">post limits checker</a>.
            </p>
            ${cloudCallout}
          </section>
        </div>`;

  return renderToolShell({
    path,
    wide: true,
    title: costCalculator.title,
    description: costCalculator.description,
    kicker: "estimate, don't guess",
    heading: costCalculator.heading,
    lede: "Work out what a month of posting costs through each platform's own API, where X bills pay-per-use credits, and compare it with a unified API that bills per profile. Every rate is an input you can change, and the link keeps your numbers.",
    structuredData: [
      softwareApplication(costCalculator),
      breadcrumbs([
        { name: "Home", path: "/" },
        { name: "Tools", path: TOOLS_PATH },
        { name: costCalculator.heading, path },
      ]),
    ],
    content,
  });
}
