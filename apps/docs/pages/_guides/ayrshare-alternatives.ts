// The Ayrshare alternatives guide: what Ayrshare is, the three kinds of
// alternative (another unified API, a self-hosted open-source scheduler with an
// API, an open-source library over the platform APIs), and how Ayrshare's
// concepts map to Social SDK. Ayrshare facts quote Ayrshare's own docs and
// pricing page, read on the date below. No prices, user counts, or rankings.
// Postiz, Zernio, Post for Me, PostFast and Buffer are supported backends and
// partners, and Postiz sponsors Social SDK, so the page says so. The Social SDK
// sample type-checks against the published npm package and was run with a
// stubbed fetch on Node.js 24 and Bun.
import { escapeHtml } from "../_blog/render";
import type { Guide } from "./guides";

const fetched = "2 November 2026";

const ayrshareDocs = "https://www.ayrshare.com/docs";

const ayrshareNetworks = `${ayrshareDocs}/help-center/product/what-social-networks-are-supported`;

const ayrshareAccounts = `${ayrshareDocs}/help-center/product/how-many-social-accounts-can-i-connect`;

const ayrshareQuota = `${ayrshareDocs}/help-center/product/how-many-posts-and-api-calls-can-i-make`;

const ayrsharePost = `${ayrshareDocs}/apis/post/post`;

const ayrshareLinking = `${ayrshareDocs}/apis/profiles/generate-jwt`;

const ayrshareXKeys = `${ayrshareDocs}/dashboard/connect-social-accounts/x-twitter-byo-keys`;

const ayrshareDuplicates = `${ayrshareDocs}/help-center/technical-support/dealing-with-duplicate-posts`;

const ayrsharePackages = `${ayrshareDocs}/help-center/product/do-you-have-sdk-packages-to-make-my-life-easier`;

const ayrsharePricing = "https://www.ayrshare.com/pricing";

const postizRepo = "https://github.com/gitroomhq/postiz-app";

const mixpostRepo = "https://github.com/inovector/mixpost";

const mixpostPricing = "https://mixpost.app/pricing";

const ayrshareExample = `await fetch("https://app.ayrshare.com/api/post", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: \`Bearer \${API_KEY}\`,
    "Profile-Key": PROFILE_KEY, // only when posting for one of your users
    // Required on X requests since 31 March 2026: your own X app's key and secret.
    "X-Twitter-OAuth1-Api-Key": X_API_KEY,
    "X-Twitter-OAuth1-Api-Secret": X_API_SECRET,
  },
  body: JSON.stringify({ post: "Release notes for v2 are up.", platforms: ["twitter", "linkedin"] }),
});`;

const sdkExample = `import { createSocial, connectedAccountRef } from "@opencoredev/social-sdk";
import { linkedin } from "@opencoredev/social-sdk/linkedin";
import { MemoryIdempotencyStore } from "@opencoredev/social-sdk/testing";
import { x } from "@opencoredev/social-sdk/x";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(\`Set \${name}\`);
  return value;
};

type PersonUrn = \`urn:li:person:\${string}\`;
const isPersonUrn = (value: string): value is PersonUrn => /^urn:li:person:[\\w-]+$/.test(value);

const author = env("LINKEDIN_AUTHOR");
if (!isPersonUrn(author)) throw new Error("LINKEDIN_AUTHOR must be urn:li:person:...");

// Your own platform apps and tokens: no intermediary between your server and X or LinkedIn.
const social = createSocial({
  backends: {
    x: x({ auth: { userId: env("X_USER_ID"), accessToken: env("X_ACCESS_TOKEN") } }),
    linkedin: linkedin({
      auth: { accessToken: env("LINKEDIN_ACCESS_TOKEN"), author },
      apiVersion: "202610",
    }),
  },
  // Tests only. In production, implement IdempotencyStore over your database.
  idempotencyStore: new MemoryIdempotencyStore(),
});

const result = await social.posts.publish({
  targets: [
    { account: connectedAccountRef({ backend: "x", platform: "x", accountId: env("X_USER_ID") }) },
    { account: connectedAccountRef({ backend: "linkedin", platform: "linkedin", accountId: author }) },
  ],
  content: { text: "Release notes for v2 are up." },
  // Use your draft's ID: a retry with the same key and content does not post twice.
  idempotencyKey: "draft-2026-11-02-release-notes",
});

for (const outcome of result.outcomes) {
  switch (outcome.state) {
    case "published":
      console.log(outcome.account.platform, "published", outcome.post.postId);
      break;
    case "failed":
      console.log(outcome.account.platform, "failed", outcome.code, outcome.retryDisposition.kind);
      break;
    case "unknown":
      // The request may have landed. Check the account before you send it again.
      console.log(outcome.account.platform, "unknown", outcome.reason);
      break;
    default:
      console.log(outcome.account.platform, outcome.state);
  }
}`;

const code = (source: string) => `<pre><code>${escapeHtml(source)}</code></pre>`;

export const ayrshareAlternatives: Guide = {
  slug: "ayrshare-alternatives",
  title: "Ayrshare alternatives, including open source",
  description:
    "Alternatives to the Ayrshare API: other unified APIs, self-hosted open-source schedulers such as Postiz and Mixpost, and open-source libraries like Social SDK.",
  summary:
    "What Ayrshare does, the three kinds of alternative (another unified API, a self-hosted open-source scheduler, or an open-source library), what each one moves onto your team, and how Ayrshare's profiles and post calls map to Social SDK.",
  heading: "Ayrshare alternatives for developers",
  lede: "Yes, there are open-source alternatives to Ayrshare, and they come in two shapes. Postiz (AGPL-3.0) is a social media scheduler with an API that you host yourself, and Mixpost Lite (MIT) is a simpler self-hosted scheduler. Social SDK (MIT) is a TypeScript library that calls each network's own API from your server. Either way you register your own platform apps and pass their reviews, which is most of the work Ayrshare does for you. If you only want a different hosted provider, other unified APIs work the same way Ayrshare does. This page explains what Ayrshare does, what each alternative moves onto your team, and how Ayrshare's profiles and post calls map to Social SDK.",
  published: "2026-11-02",
  updated: "2026-11-02",
  content: `
          <p>
            Ayrshare facts below come from Ayrshare's own documentation and pricing page, and
            project facts from each project's own site or repository, read on ${fetched}. We don't
            list prices: they change often, so check <a href="${ayrsharePricing}">Ayrshare's pricing
            page</a> and each alternative's. Postiz sponsors Social SDK. Social SDK supports Zernio, Post for
            Me and PostFast as backends in its 0.5.0 npm release; its Postiz and Buffer adapters are
            on the main branch and not yet in npm.
          </p>

          <h2 id="what-ayrshare-is">What Ayrshare is</h2>
          <p>
            Ayrshare is a hosted, unified social media API. You send one request to
            <a href="${ayrsharePost}"><code>POST /api/post</code></a> with the text and a
            <code>platforms</code> list, and Ayrshare posts it through each network's official API.
            Ayrshare runs the platform apps for every network except X, so you don't register a
            developer app with each one.
            The parts that matter when you compare alternatives:
          </p>
          <ul>
            <li><strong>Networks.</strong> <a href="${ayrshareNetworks}">Fourteen</a>: Bluesky, Facebook, Google Business Profile, Instagram, LinkedIn, Pinterest, Reddit, Snapchat, Telegram, Threads, TikTok, WhatsApp, X, and YouTube.</li>
            <li><strong>Profiles.</strong> Your account is a Primary Profile. To post for your own users you create <a href="${ayrshareAccounts}">User Profiles</a>, each with one set of connected accounts (one per network), and send that profile's key in a <code>Profile-Key</code> header.</li>
            <li><strong>Account linking.</strong> A <a href="${ayrshareLinking}">linking URL</a> sends your user to an Ayrshare-hosted page to connect their accounts.</li>
            <li><strong>X needs your own app.</strong> Since 31 March 2026, every Ayrshare account that posts to X <a href="${ayrshareXKeys}">registers its own X developer app</a> and sends its API key and secret on every X request. One app covers all your User Profiles.</li>
            <li><strong>Billing unit.</strong> The <a href="${ayrsharePricing}">pricing page</a> bills by social profile: one customer, brand, or location, with any number of networks. Premium covers one profile, Launch up to 10, and Business more. Only Launch has a 28-day free trial.</li>
            <li><strong>Monthly post quota.</strong> Each profile has its <a href="${ayrshareQuota}">own quota</a>, set by plan, that resets on the 1st at 00:07 UTC. One request counts once however many networks it targets, and failed posts count.</li>
            <li><strong>Duplicate check.</strong> Ayrshare <a href="${ayrshareDuplicates}">blocks repeated content</a> within two days (error code 137), but two identical requests sent at the same moment can both publish.</li>
            <li><strong>Packages.</strong> Official <a href="${ayrsharePackages}">Node.js and Python packages</a>, plus guides for no-code tools, and an MCP server for AI agents.</li>
          </ul>

          <h2 id="why-switch">Why teams look for an alternative</h2>
          <p>
            The reasons we hear, and that the "Ayrshare alternative" results talk about, come down
            to a few trade-offs, not to Ayrshare doing its job badly:
          </p>
          <ul>
            <li><strong>Cost grows with customers.</strong> Billing per profile suits agencies. A product where every customer connects accounts pays for each one.</li>
            <li><strong>You want the source.</strong> Ayrshare is a hosted service; its docs describe no self-hosted version.</li>
            <li><strong>You want your own platform apps.</strong> Posts then come from your app, your users authorize you, and nothing sits between your server and the network.</li>
            <li><strong>You want fewer moving parts.</strong> If you post to one or two networks, a vendor for all fourteen may be more than you need.</li>
          </ul>

          <h2 id="three-kinds">The three kinds of alternative</h2>
          <table>
            <thead><tr><th>Kind</th><th>What changes compared with Ayrshare</th></tr></thead>
            <tbody>
              <tr><td>Another unified API</td><td>Almost nothing: a different vendor holds the platform apps and account connections. You compare coverage, limits, billing unit, and webhooks.</td></tr>
              <tr><td>Self-hosted open-source scheduler</td><td>You run the app (Postiz needs Postgres and Redis; Mixpost is a Laravel app), register each platform app, and pass its review. You get the source and a scheduling UI; check which edition has the API.</td></tr>
              <tr><td>Open-source library</td><td>No extra service at all: your server calls each network's API with your own apps and tokens. You store tokens and run scheduling yourself.</td></tr>
            </tbody>
          </table>

          <h2 id="unified">Other unified APIs</h2>
          <p>
            If what you want is Ayrshare's model from a different vendor, the providers that
            describe themselves as unified social media APIs include
            <a href="https://www.upload-post.com">Upload-Post</a>,
            <a href="https://www.outstand.so">Outstand</a>,
            <a href="https://bundle.social">bundle.social</a>,
            <a href="https://zernio.com">Zernio</a>,
            <a href="https://www.postforme.dev">Post for Me</a>, and
            <a href="https://www.blotato.com">Blotato</a>. Some ask you to bring your own developer
            app for certain networks, so check each provider's docs per platform. Our
            <a href="/guides/social-media-apis">social media APIs guide</a> quotes how each one
            describes itself and lists what every native platform requires.
          </p>

          <h2 id="open-source">Open-source alternatives</h2>
          <p>
            <a href="${postizRepo}">Postiz</a> is an open-source (AGPL-3.0) social media scheduler
            with a public API. You can self-host it or use Postiz Cloud. Self-hosted, you configure
            your own platform apps in your instance. Social SDK's
            <a href="/docs/backends/postiz">Postiz adapter</a> talks to either; it is on the main
            branch and not yet in the 0.5.0 npm release.
          </p>
          <p>
            <a href="https://mixpost.app">Mixpost</a> describes itself as self-hosted social media
            management. Its free <a href="${mixpostRepo}">Lite edition</a> is open source (MIT) and
            posts to Facebook Pages, X, and Mastodon. The API, the MCP server, and the other networks
            come with the paid <a href="${mixpostPricing}">Pro and Enterprise licenses</a>, which
            install the source on your server but don't let you redistribute it.
          </p>
          <p>
            <a href="/">Social SDK</a> is an open-source (MIT) TypeScript library, not a service. It
            has direct adapters for X, Bluesky, Threads, Instagram, LinkedIn, TikTok, and YouTube,
            and can send the same call through Zernio, Post for Me, or PostFast in the 0.5.0 npm
            release. It runs inside your own server on Node.js 22.12+ or Bun and needs no Social SDK
            account. Choose it when you want the integration in your own code. Choose Postiz or
            Mixpost when you also want a scheduling app your team uses by hand.
          </p>

          <h2 id="mapping">From Ayrshare to Social SDK</h2>
          <p>
            Most Ayrshare concepts have a direct counterpart. The difference is who stores what:
            with Social SDK, account connections and tokens live in your database.
          </p>
          <table>
            <thead><tr><th>Ayrshare</th><th>Social SDK</th></tr></thead>
            <tbody>
              <tr><td>API key</td><td>Your own platform app credentials for direct adapters, or a provider API key for a <a href="/docs/backends">managed backend</a>.</td></tr>
              <tr><td>User Profile and <code>Profile-Key</code></td><td>Your tenant record plus a <code>connectedAccountRef</code> per account. An <a href="/docs/concepts/tenant-authorization">authorization policy</a> checks that the tenant may use the account before each call.</td></tr>
              <tr><td>Linking URL</td><td><code>ConnectionManager</code> from <code>@opencoredev/social-sdk/server</code> runs the OAuth flow with your app and saves the grants (<a href="/docs/authentication">connect accounts</a>).</td></tr>
              <tr><td><code>POST /api/post</code> with <code>platforms</code></td><td><code>social.posts.publish</code> with one target per account.</td></tr>
              <tr><td>Per-network <code>errors</code> in the response</td><td>One typed outcome per destination: <code>published</code>, <code>failed</code> with a retry hint, or <code>unknown</code> when a write may have landed.</td></tr>
              <tr><td>Duplicate check (code 137)</td><td>An <code>idempotencyKey</code> with an <a href="/docs/concepts/idempotency">idempotency store</a>: a retry returns the saved outcome instead of posting again.</td></tr>
              <tr><td><code>scheduleDate</code></td><td>Your job runner (<a href="/docs/integrations/inngest">Inngest</a>, <a href="/docs/integrations/trigger-dev">Trigger.dev</a>) for direct adapters, or the provider's schedule on a managed backend.</td></tr>
            </tbody>
          </table>

          <h2 id="example">The same post, both ways</h2>
          <p>
            This is a post to X and LinkedIn through Ayrshare, following its
            <a href="${ayrsharePost}">post endpoint</a> reference:
          </p>
          ${code(ayrshareExample)}
          <p>
            And the same post with Social SDK's direct adapters, an idempotency key, and an outcome
            per network:
          </p>
          <pre><code>npm install @opencoredev/social-sdk</code></pre>
          ${code(sdkExample)}
          <p>
            We type-checked this against <code>@opencoredev/social-sdk</code> 0.5.0 from npm and
            ran it on ${fetched} on Node.js 24 and Bun with a stub <code>fetch</code>. It made one
            <code>POST https://api.x.com/2/tweets</code> and one
            <code>POST https://api.linkedin.com/rest/posts</code>, and printed a
            <code>published</code> line for each. Running <code>publish</code> a second time with
            the same key made no new requests and returned the saved outcomes. The sample posts for
            one account you own. When your customers connect accounts, add an
            <a href="/docs/concepts/tenant-authorization">authorization policy</a> and pass the
            signed-in tenant to <code>publish</code>, as you would scope a Profile-Key. To try it with no
            keys, use the <a href="/docs/getting-started/mock-quickstart">mock backend</a>. The
            <a href="/guides/x-api-pricing">X API pricing</a> and
            <a href="/guides/linkedin-posts-api">LinkedIn Posts API</a> guides cover what each
            token needs.
          </p>

          <h2 id="choose">How to choose</h2>
          <ul>
            <li><strong>You want someone else to own the platform apps and reviews:</strong> stay on Ayrshare or move to another unified API.</li>
            <li><strong>You want the source and a scheduling UI, and can run a server:</strong> self-host Postiz, or Mixpost (the API needs a paid license).</li>
            <li><strong>You want posting inside your own TypeScript code, with your own apps:</strong> an open-source library such as Social SDK.</li>
            <li><strong>You want to start hosted and move later:</strong> Social SDK can call a managed backend now and direct adapters later through the same <code>publish</code> call. Account references change with the backend, so moving is a mapping step.</li>
          </ul>

          <h2 id="faq">Common questions</h2>
          <dl class="faq">
            <dt>Is there an open-source alternative to Ayrshare?</dt>
            <dd>
              Yes. Postiz (AGPL-3.0) is a self-hosted scheduler with an API, and Social SDK (MIT) is a
              TypeScript library that calls each network's own API. Mixpost Lite (MIT) is open source
              too, but its API is in the paid editions. All of them need your own platform apps.
            </dd>
            <dt>Is Ayrshare open source?</dt>
            <dd>
              No. Ayrshare is a hosted API, and its documentation describes no self-hosted version.
              Its Node.js and Python packages are clients for that API.
            </dd>
            <dt>Can I self-host an Ayrshare alternative?</dt>
            <dd>
              Yes. Postiz and Mixpost run on your own server. Social SDK runs inside your existing
              server code, so there is nothing extra to host.
            </dd>
            <dt>Do I need my own developer apps if I leave Ayrshare?</dt>
            <dd>
              With another unified API, usually not, though Ayrshare itself now needs your own X app. With a self-hosted scheduler or a library, yes:
              each network's app, its review, and its limits become yours. Our guides to
              <a href="/guides/threads-api">Threads</a>, <a href="/guides/bluesky-api">Bluesky</a>,
              <a href="/guides/youtube-upload-api">YouTube</a>, and the
              <a href="/guides/social-media-apis">other platforms</a> list what each one requires.
            </dd>
            <dt>Does Social SDK work with AI agents?</dt>
            <dd>
              Yes. It has an <a href="/docs/agents/integrate-social-sdk">agent integration guide</a>,
              and its per-destination outcomes tell an agent whether a post landed before it retries.
            </dd>
          </dl>

          <h2 id="sources">Sources</h2>
          <p>Read on ${fetched}:</p>
          <ul>
            <li><a href="${ayrsharePost}">Ayrshare: Publish a Post API</a>: the request, <code>platforms</code> values, and the <code>Profile-Key</code> header</li>
            <li><a href="${ayrshareNetworks}">Ayrshare: supported social networks</a>: the fourteen networks</li>
            <li><a href="${ayrshareAccounts}">Ayrshare: how many social accounts can I connect</a>: User Profiles and plans</li>
            <li><a href="${ayrshareLinking}">Ayrshare: generate a linking URL</a>: account linking</li>
            <li><a href="${ayrshareXKeys}">Ayrshare: set up your own X API key</a>: the 31 March 2026 X app requirement and headers</li>
            <li><a href="${ayrshareQuota}">Ayrshare: monthly post quota</a>: per-profile quota, reset time, what counts</li>
            <li><a href="${ayrshareDuplicates}">Ayrshare: duplicate posts</a>: code 137 and simultaneous requests</li>
            <li><a href="${ayrsharePackages}">Ayrshare: SDK packages</a>: Node.js and Python</li>
            <li><a href="${ayrsharePricing}">Ayrshare pricing</a>: billing per social profile, plan names, and the Launch trial</li>
            <li><a href="${postizRepo}">gitroomhq/postiz-app</a>: AGPL-3.0 license</li>
            <li><a href="${mixpostRepo}">inovector/mixpost</a> and <a href="${mixpostPricing}">Mixpost pricing</a>: Lite's MIT license and networks, the API and MCP in Pro and Enterprise, source-available paid licenses</li>
          </ul>`,
};
