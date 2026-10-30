// The social media APIs guide: the three ways a developer can post to social
// networks from code. Platform facts quote each platform's own docs, and provider
// descriptions quote each provider's own site, with the date they were read. No
// prices, user counts, or rankings. Zernio, Post for Me, PostFast, Postiz, and
// Buffer are supported backends and partners, so they are listed neutrally. The
// Social SDK sample type-checks against the published npm package and was run
// with a stubbed fetch.
import { escapeHtml } from "../_blog/render";
import type { Guide } from "./guides";

const fetched = "30 October 2026";

const instagramPublishing =
  "https://developers.facebook.com/documentation/instagram-platform/content-publishing";

const linkedinPosts =
  "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api";

const tiktokPosting = "https://developers.tiktok.com/doc/content-posting-api-get-started";

const youtubeQuota = "https://developers.google.com/youtube/v3/determine_quota_cost";

const sdkExample = `import { createSocial, connectedAccountRef } from "@opencoredev/social-sdk";
import { bluesky } from "@opencoredev/social-sdk/bluesky";
import { x } from "@opencoredev/social-sdk/x";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(\`Set \${name}\`);
  return value;
};

// Direct adapters: your own X app token and a Bluesky session, no intermediary.
const social = createSocial({
  backends: {
    x: x({ auth: { userId: env("X_USER_ID"), accessToken: env("X_ACCESS_TOKEN") } }),
    bluesky: bluesky({
      backend: "bluesky",
      auth: {
        service: "https://bsky.social",
        did: env("BLUESKY_DID"),
        accessJwt: env("BLUESKY_ACCESS_JWT"),
      },
    }),
  },
});

const result = await social.posts.publish({
  targets: [
    { account: connectedAccountRef({ backend: "x", platform: "x", accountId: env("X_USER_ID") }) },
    {
      account: connectedAccountRef({
        backend: "bluesky",
        platform: "bluesky",
        accountId: env("BLUESKY_DID"),
      }),
    },
  ],
  content: { text: "Release notes for v2 are up." },
});

// One typed outcome per destination; a failure on one network doesn't hide the other.
for (const outcome of result.outcomes) {
  console.log(outcome.account.platform, outcome.state);
}`;

const code = (source: string) => `<pre><code>${escapeHtml(source)}</code></pre>`;

export const socialMediaApis: Guide = {
  slug: "social-media-apis",
  title: "Social media APIs for developers in 2026",
  description:
    "Three ways to post to social networks from code: native platform APIs, unified social media APIs, or open-source libraries. Access rules, limits, sources.",
  summary:
    "Native platform APIs, unified posting APIs, and open-source libraries compared: what each platform requires before you can post, daily limits, the unified API providers, and a tested TypeScript example.",
  heading: "Social media APIs for developers",
  lede: "A social media API lets your code publish, read, or manage posts on a social network. There are three ways to get one: call each platform's own API (X, Bluesky, Threads, Instagram, LinkedIn, TikTok, YouTube) with your own developer app, pay a unified social media API provider that stores the account connections and gives you one endpoint, or use an open-source library that wraps the platform APIs in one interface while you keep your own apps and tokens. This page compares the three, lists what each platform requires before you can post, and ends with a tested example.",
  published: "2026-10-30",
  updated: "2026-10-30",
  content: `
          <p>
            Platform facts below come from each platform's own developer documentation, and
            provider descriptions from each provider's own site, read on ${fetched} unless a
            linked guide says otherwise. We don't list prices: they change often, so check each
            pricing page.
          </p>

          <h2 id="three-options">The three options</h2>
          <table>
            <thead><tr><th>Option</th><th>What it means for you</th></tr></thead>
            <tbody>
              <tr><td>Native platform APIs</td><td>Your own developer app on each network, its own review, tokens, limits, and billing. No intermediary, most control, most work.</td></tr>
              <tr><td>Unified social media API</td><td>One provider, one API key, one request shape. The provider stores account connections and usually the platform apps, and passes on each network's rules.</td></tr>
              <tr><td>Open-source library</td><td>One interface in your code over the native APIs, with your own apps and tokens. Some libraries can also call a unified provider behind the same interface.</td></tr>
            </tbody>
          </table>
          <p>
            Most teams pick on two questions: who should own the platform apps and their review,
            and how many networks do you need on day one. One or two networks you control
            usually means native APIs. Many networks for many customers, fast, usually means a
            unified API.
          </p>

          <h2 id="native">Native platform APIs: what each one requires</h2>
          <p>
            Every network runs its own API with its own access rules. Before your code can post
            for anyone outside your own test accounts, expect some form of app review on most of
            them.
          </p>
          <table>
            <thead><tr><th>Platform</th><th>What you need to post, and the main limit</th></tr></thead>
            <tbody>
              <tr><td><a href="/guides/x-api-pricing">X</a></td><td>A developer app and an OAuth 2.0 user token with <code>tweet.write</code>. Pay-per-use credits; no general free tier.</td></tr>
              <tr><td><a href="/guides/bluesky-api">Bluesky</a></td><td>No developer account or key. Log in as the account (app password or OAuth). About 1,666 new records an hour per account.</td></tr>
              <tr><td><a href="/guides/threads-api">Threads</a></td><td>A Meta app with <code>threads_content_publish</code>, App Review for users outside your app's roles. 250 API posts per profile per 24 hours.</td></tr>
              <tr><td><a href="/docs/platforms/instagram">Instagram</a></td><td>A professional (Business or Creator) account and a Meta app. 100 API-published posts per account in a moving 24 hours; a carousel counts as one.</td></tr>
              <tr><td><a href="/docs/platforms/linkedin">LinkedIn</a></td><td><code>w_member_social</code> to post as a member, or <code>w_organization_social</code> plus an admin or poster role on the Page.</td></tr>
              <tr><td><a href="/docs/platforms/tiktok">TikTok</a></td><td>A TikTok app with <code>video.publish</code>. Until TikTok audits the app, everything it posts is private.</td></tr>
              <tr><td><a href="/docs/platforms/youtube">YouTube</a></td><td>A Google Cloud project and an OAuth token with <code>youtube.upload</code>. 100 <code>videos.insert</code> calls a day by default.</td></tr>
            </tbody>
          </table>
          <p>
            Sources: <a href="${instagramPublishing}">Instagram content publishing</a> (updated
            20 October 2026), <a href="${linkedinPosts}">LinkedIn Posts API</a>,
            <a href="${tiktokPosting}">TikTok Content Posting API</a>, and
            <a href="${youtubeQuota}">YouTube quota costs</a>, read ${fetched}. The X, Bluesky,
            and Threads rows summarise our guides to those APIs, which cite their sources and
            dates.
          </p>
          <p>
            Native APIs also differ in shape. Instagram and Threads publish in two steps (create
            a container, then publish it), TikTok asks the creator to confirm privacy and consent
            first, YouTube uploads are resumable, and Bluesky writes a record to the account's
            repository. That is most of the work a unified API or a library hides.
          </p>

          <h2 id="unified">Unified social media APIs</h2>
          <p>
            A unified API provider stores your users' account connections and, for most
            networks, registers the platform apps and passes their reviews. Some ask you to bring
            your own developer app for certain networks, so check each provider's docs per
            platform. You send one request and the provider fans it out. The trade-off is a
            dependency: the provider's coverage, limits, and pricing become yours. Providers describe
            themselves on their own sites (read ${fetched}) as:
          </p>
          <ul>
            <li><a href="https://www.ayrshare.com">Ayrshare</a>: a unified social media API to post, schedule, and analyze, with an MCP server for AI agents.</li>
            <li><a href="https://www.upload-post.com">Upload-Post</a>: one API call to post on TikTok, Instagram, YouTube, and more, with Python and JavaScript SDKs.</li>
            <li><a href="https://www.outstand.so">Outstand</a>: a unified social media API for AI agents, schedulers, and analytics dashboards.</li>
            <li><a href="https://bundle.social">bundle.social</a>: one API for publishing, analytics, and comments, plus Instagram and Facebook DMs.</li>
            <li><a href="https://zernio.com">Zernio</a>: marketing infrastructure for agents behind one API key, with an MCP server (getlate.dev now redirects there).</li>
            <li><a href="https://www.postforme.dev">Post for Me</a>: a unified developer API to post and schedule content across TikTok, Instagram, Facebook, X, LinkedIn, YouTube, Threads, Pinterest, and Bluesky.</li>
            <li><a href="https://www.blotato.com">Blotato</a>: a social media API and MCP server for AI agents.</li>
          </ul>
          <p>
            Schedulers with an API sit close to this group: your code feeds posts to a tool your
            team also uses by hand. <a href="/guides/buffer-api">Buffer</a> has a GraphQL API,
            <a href="https://postiz.com">Postiz</a> is open source and can be self-hosted,
            and <a href="https://postfa.st">PostFast</a> exposes an API. If you want the whole
            tool on your own server, <a href="https://mixpost.app">Mixpost</a> describes itself
            as open-source, self-hosted social media management. Enterprise suites such as
            Hootsuite and Sprout Social also offer APIs.
          </p>

          <h2 id="libraries">Open-source libraries</h2>
          <p>
            A library keeps you on the native APIs but saves you writing each client. Per-platform
            libraries cover one network well: <code>twitter-api-v2</code> for X,
            <code>@atproto/api</code> for Bluesky, and <code>googleapis</code> for YouTube.
            Meta's Graph API (Instagram, Threads, Facebook) is plain HTTPS, so most teams call it
            with <code>fetch</code>.
          </p>
          <p>
            <a href="/">Social SDK</a> is an open-source (MIT) TypeScript library that puts many
            networks behind one <code>posts.publish</code> call. It has direct adapters for X,
            Bluesky, Threads, Instagram, LinkedIn, TikTok, and YouTube, so the platform apps and
            tokens stay yours, and it can also run the same call through managed backends,
            Zernio, Post for Me, and PostFast in the 0.5.0 npm release. Every call returns one
            typed outcome per destination, including <code>unknown</code> when a write may or
            may not have landed, so your code can check before it retries instead of posting
            twice.
          </p>

          <h2 id="example">Posting to two networks from TypeScript</h2>
          <p>
            This posts the same text to X and Bluesky with Social SDK's direct adapters. A
            managed backend uses the same <code>publish</code> call shape, but its accounts are
            the provider's account references and each provider adds its own requirements (the
            backend pages list them), so moving between them is a mapping step, not a rewrite.
          </p>
          <pre><code>npm install @opencoredev/social-sdk</code></pre>
          ${code(sdkExample)}
          <p>
            We type-checked this against <code>@opencoredev/social-sdk</code> 0.5.0 from npm and
            ran it on ${fetched} on Node.js 24 with a stub <code>fetch</code>. It made one
            <code>POST https://api.x.com/2/tweets</code> and one
            <code>com.atproto.repo.createRecord</code> call to <code>bsky.social</code>, and
            printed <code>x published</code> and <code>bluesky published</code>. To try it with no
            keys at all, use the <a href="/docs/getting-started/mock-quickstart">mock backend</a>.
            The <a href="/docs/platforms">platforms overview</a> adds Threads to the same call,
            and <a href="/docs/backends">managed backends</a> compares the providers.
          </p>

          <h2 id="choose">How to choose</h2>
          <ul>
            <li><strong>One or two networks, your own accounts:</strong> the native API, or a per-platform library.</li>
            <li><strong>Many networks for your customers, shipped this week:</strong> a unified API, after checking its platform list and how account connections work.</li>
            <li><strong>Many networks, but you want to own the apps and tokens:</strong> an open-source multi-platform library.</li>
            <li><strong>Your team already schedules in a tool:</strong> that scheduler's API.</li>
            <li><strong>Not sure yet:</strong> a library that supports both direct adapters and managed backends lets you start on one and move later.</li>
          </ul>

          <h2 id="faq">Common questions</h2>
          <dl class="faq">
            <dt>What is a social media API?</dt>
            <dd>
              An HTTP interface that lets code act on a social network: publish posts, upload
              media, read posts and comments, or fetch analytics, for an account that authorized
              your app.
            </dd>
            <dt>Is there a free social media API?</dt>
            <dd>
              It depends on the network. Bluesky needs no developer account or key. X bills
              pay-per-use and has no general free tier. Meta, LinkedIn, TikTok, and YouTube
              require app review, an audit, or quota limits before you can post publicly for
              other users; check each platform's terms for costs.
            </dd>
            <dt>What is a unified social media API?</dt>
            <dd>
              One API from a provider that posts to many networks for you. The provider stores
              the account connections and, for most networks, the platform apps.
            </dd>
            <dt>Can I post to several networks with one API call?</dt>
            <dd>
              Yes, through a unified API, or with a library such as Social SDK that sends one call
              to each network's own API and returns a result per network.
            </dd>
            <dt>Which social media APIs work with AI agents?</dt>
            <dd>
              Several unified providers ship MCP servers. Social SDK has an
              <a href="/docs/agents/integrate-social-sdk">agent integration guide</a> and returns
              per-destination outcomes an agent can check before it retries.
            </dd>
          </dl>

          <h2 id="sources">Sources</h2>
          <p>Read on ${fetched}:</p>
          <ul>
            <li><a href="${instagramPublishing}">Instagram content publishing</a>: professional accounts, the 100-post 24-hour limit</li>
            <li><a href="${linkedinPosts}">LinkedIn Posts API</a>: <code>w_member_social</code>, <code>w_organization_social</code>, Page roles</li>
            <li><a href="${tiktokPosting}">TikTok Content Posting API: get started</a>: <code>video.publish</code>, private posting until audit</li>
            <li><a href="${youtubeQuota}">YouTube Data API quota costs</a>: the default 100 <code>videos.insert</code> calls a day</li>
            <li>Provider home pages linked in <a href="#unified">Unified social media APIs</a>: how each provider describes its product</li>
            <li>Our <a href="/guides/x-api-pricing">X API pricing</a>, <a href="/guides/bluesky-api">Bluesky API</a>, and <a href="/guides/threads-api">Threads API</a> guides, for those rows</li>
          </ul>`,
};
