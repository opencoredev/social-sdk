// The Buffer API guide. Access rules, limits, and behaviour quote Buffer's own
// developer docs and help center with the date they were read, and never promise
// a price. Buffer is a supported Social SDK backend, so the alternatives section
// stays neutral. Both code samples type-check against the published npm package
// and were run against a stubbed fetch or the mock backend.
import { escapeHtml } from "../_blog/render";
import type { Guide } from "./guides";

const fetched = "29 October 2026";

const docs = "https://developers.buffer.com";

const quickStart = `${docs}/guides/getting-started`;

const authentication = `${docs}/guides/authentication`;

const buildingApps = `${docs}/guides/building-apps`;

const limits = `${docs}/guides/api-limits`;

const scheduling = `${docs}/guides/posts-and-scheduling`;

const hostingMedia = `${docs}/guides/hosting-media`;

const migration = `${docs}/guides/rest-migration`;

const helpCenter = "https://support.buffer.com/articles/using-buffers-api-GtIYIQilz5";

const bufferExample = `const apiKey = process.env["BUFFER_API_KEY"];
if (!apiKey) throw new Error("Set BUFFER_API_KEY");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Every Buffer API call is a POST of a GraphQL document to one endpoint.
// The response is checked before use, so it starts as unknown.
async function bufferGraphql(query: string, variables: object = {}): Promise<Record<string, unknown>> {
  const response = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: { Authorization: \`Bearer \${apiKey}\`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (response.status === 429) {
    // Retry-After is in seconds. A 30-day window can be weeks away, so surface it.
    throw new Error(\`Rate limited; retry after \${response.headers.get("retry-after")} s\`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Unexpected response");
  if (Array.isArray(body["errors"]) && body["errors"].length > 0) {
    throw new Error(JSON.stringify(body["errors"]));
  }
  if (!isRecord(body["data"])) throw new Error("No data");
  return body["data"];
}

const { account } = await bufferGraphql(\`{ account { organizations { id name } } }\`);
const organizations = isRecord(account) ? account["organizations"] : undefined;

// A key can reach several organizations; use the first Bluesky channel in any of them.
let channel: Record<string, unknown> | undefined;
for (const organization of Array.isArray(organizations) ? organizations : []) {
  if (!isRecord(organization)) continue;
  const { channels } = await bufferGraphql(
    \`query Channels($organizationId: OrganizationId!) {
      channels(input: { organizationId: $organizationId }) { id service }
    }\`,
    { organizationId: organization["id"] },
  );
  const found = (Array.isArray(channels) ? channels : []).find(
    (item) => isRecord(item) && item["service"] === "bluesky",
  );
  if (isRecord(found)) {
    channel = found;
    break;
  }
}
if (!channel) throw new Error("Connect a Bluesky channel in Buffer first");

const { createPost } = await bufferGraphql(
  \`mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess { post { id status dueAt } }
      ... on MutationError { message }
    }
  }\`,
  {
    input: {
      channelId: channel["id"],
      text: "Release notes for v2 are up.",
      schedulingType: "automatic",
      mode: "customScheduled",
      dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // UTC, an hour from now
    },
  },
);
if (!isRecord(createPost)) throw new Error("Unexpected createPost result");
// Validation problems arrive as a MutationError on HTTP 200, not in \`errors\`.
if (!isRecord(createPost["post"])) throw new Error(String(createPost["message"]));
const post = createPost["post"];
// A channel that requires approval returns a draft (needs_approval), not a scheduled post.
console.log(post["status"], post["id"], post["dueAt"]);`;

const sdkExample = `import { createSocial, connectedAccountRef } from "@opencoredev/social-sdk";
import { mockBackend } from "@opencoredev/social-sdk/testing";

// The mock backend needs no keys and makes no network calls. In production,
// pass a real backend here instead; the publish call below stays the same.
const social = createSocial({ backend: mockBackend({ scenario: "mixed-success-failure" }) });

const account = (platform: "x" | "bluesky", accountId: string) =>
  connectedAccountRef({ backend: "default", platform, accountId });

const result = await social.posts.publish({
  targets: [{ account: account("x", "mock-account-1") }, { account: account("bluesky", "mock-account-2") }],
  content: { text: "Release notes for v2 are up." },
});

// One outcome per destination: a failure on one network doesn't hide a success on another.
for (const outcome of result.outcomes) {
  console.log(outcome.account.platform, outcome.state);
}`;

const code = (source: string) => `<pre><code>${escapeHtml(source)}</code></pre>`;

export const bufferApi: Guide = {
  slug: "buffer-api",
  title: "Buffer API in 2026: keys, OAuth, rate limits",
  description:
    "Buffer's API is open again: a GraphQL API with personal API keys and OAuth apps. Access, posting, scheduling, rate limits, and alternatives.",
  summary:
    "Buffer's current GraphQL API: who can use it, API keys versus OAuth apps, creating and scheduling posts from TypeScript, rate limits per plan, migrating from the old REST API, and the alternatives.",
  heading: "The Buffer API, explained",
  lede: "Yes, Buffer has a public API again. It is a GraphQL API at api.buffer.com, and Buffer's help center, read 29 October 2026, says it is included on every Buffer plan, including Free. A personal API key acts on your own Buffer account; apps that act for other Buffer users register an OAuth client and use the authorization-code flow with PKCE. The old REST API at api.bufferapp.com is the legacy version, and Buffer publishes a guide for moving off it.",
  published: "2026-10-29",
  updated: "2026-10-29",
  content: `
          <p>
            Facts on this page come from Buffer's
            <a href="${docs}">developer documentation</a> and
            <a href="${helpCenter}">help center</a>, read on ${fetched}. Buffer adds to the API
            often, so check its changelog before you build on a detail.
          </p>

          <h2 id="status">Is the Buffer API still available?</h2>
          <p>
            Yes. Many articles still say Buffer shut its API down. Those describe the legacy REST
            API at <code>api.bufferapp.com/1/</code>. The current API is a separate GraphQL API at
            <code>https://api.buffer.com</code>, and Buffer's
            <a href="${migration}">REST migration guide</a> maps the old endpoints to it. Buffer
            describes it as covering the core functionality of the legacy API.
          </p>
          <p>
            Buffer handles publishing to each social network. Your code hands a post to Buffer,
            and Buffer sends it to the connected channel. The help center lists Instagram,
            Threads, LinkedIn, X, Facebook, TikTok, Google Business Profile, Mastodon, YouTube,
            Pinterest, and Bluesky as channels the API can create posts for.
          </p>

          <h2 id="what-it-does">What the API can and can't do</h2>
          <p>From Buffer's help center:</p>
          <ul>
            <li>
              <strong>Can:</strong> create, edit, schedule, and delete posts, including images
              and video from a public link, first comments, and threads on X, Bluesky, Threads,
              and Mastodon; create and list ideas; read organizations, channels, and scheduled
              and sent posts; manage tags (an early preview).
            </li>
            <li>
              <strong>Can't yet:</strong> full analytics (only an experimental set of post
              metrics, readable with a personal key, not by OAuth apps), reading or replying to
              comments, Start Page posts, custom video thumbnails, and direct file uploads.
            </li>
          </ul>
          <p>
            If a channel requires approval, posts created through the API are saved as drafts
            awaiting approval, the same as in the Buffer dashboard.
          </p>

          <h2 id="access">API key or OAuth app</h2>
          <p>Buffer offers two ways in (<a href="${authentication}">authentication</a>):</p>
          <ul>
            <li>
              <strong>Personal API key.</strong> Create one under
              <a href="https://publish.buffer.com/settings/api">Settings → API</a> and send it as
              <code>Authorization: Bearer &lt;key&gt;</code>. It acts for your account only and can
              reach every organization and channel on it; there is no per-organization scoping.
              The help center says only an organization owner can create keys. Use a key for
              your own scripts, automations, and agents.
            </li>
            <li>
              <strong>OAuth app client.</strong> For an app that other Buffer users connect,
              register an app client on the same settings page. Buffer requires the
              authorization-code flow with PKCE for every client. Confidential clients get a
              client secret; public clients (mobile, desktop, single-page apps) use PKCE alone.
              Ask for <code>offline_access</code> to get a refresh token. The
              <a href="${buildingApps}">building apps guide</a> covers redirect URIs, token
              storage, and going to production.
            </li>
          </ul>
          <p>
            Keep keys and tokens on your server. Buffer's own advice is to never commit a key or
            put it in client-side code.
          </p>

          <h2 id="first-post">Scheduling a post from TypeScript</h2>
          <p>
            Every call is a <code>POST</code> of a GraphQL document to
            <code>https://api.buffer.com</code>. To post, you need an organization ID, then a
            channel ID from that organization, then a <code>createPost</code> mutation. A key can
            reach several organizations, so the example checks each one for a channel. This example schedules a Bluesky
            post an hour from now with plain <code>fetch</code>:
          </p>
          ${code(bufferExample)}
          <p>
            We type-checked this against Buffer's
            <a href="${docs}/reference">GraphQL reference</a> types and ran it on ${fetched} with
            a stub <code>fetch</code> standing in for <code>api.buffer.com</code>. With the
            Bluesky channel in the second of two organizations, it made four requests and printed
            <code>scheduled</code> with the post's ID and time. A stubbed
            <code>needs_approval</code> draft printed that status instead, and a stubbed
            <code>MutationError</code> and <code>429</code> each stopped the script with the
            message shown. It runs on Node.js
            22.12 or later and Bun.
          </p>
          <p>Two details catch people out:</p>
          <ul>
            <li>
              <strong>Two kinds of error.</strong> Problems with your input, such as text over a
              channel's limit, come back as a <code>MutationError</code> inside
              <code>data</code> with HTTP 200. Authentication failures, missing records, and rate
              limits come back in <code>errors</code>. On post mutations
              such as <code>createPost</code>, select both <code>PostActionSuccess</code> and
              <code>MutationError</code>; other mutations name their own success and error types
              in the reference.
            </li>
            <li>
              <strong>Media is a URL, not an upload.</strong> There is no upload endpoint.
              Host the file yourself at a public, direct HTTPS URL and pass it in
              <code>assets</code>. Buffer fetches it when the post publishes, which can be days
              later, so signed or expiring URLs fail after <code>createPost</code> succeeded
              (<a href="${hostingMedia}">hosting media</a>).
            </li>
          </ul>

          <h2 id="scheduling">Scheduling modes</h2>
          <p>
            <code>createPost</code> needs a <code>mode</code> and a
            <code>schedulingType</code> (<a href="${scheduling}">posts and scheduling</a>):
          </p>
          <table>
            <thead><tr><th>Value</th><th>What it does</th></tr></thead>
            <tbody>
              <tr><td><code>mode: addToQueue</code></td><td>Next free slot in the channel's posting schedule</td></tr>
              <tr><td><code>mode: shareNext</code></td><td>Front of the queue</td></tr>
              <tr><td><code>mode: shareNow</code></td><td>Publish immediately</td></tr>
              <tr><td><code>mode: customScheduled</code></td><td>At <code>dueAt</code>, an ISO 8601 UTC time</td></tr>
              <tr><td><code>schedulingType: automatic</code></td><td>Buffer's workers publish the post</td></tr>
              <tr><td><code>schedulingType: notification</code></td><td>Buffer reminds someone to publish it by hand</td></tr>
            </tbody>
          </table>
          <p>
            Set <code>saveToDraft: true</code> to create a draft instead. A post's
            <code>status</code> moves through values such as <code>scheduled</code>,
            <code>sending</code>, <code>sent</code>, and <code>error</code>; Buffer's API docs
            describe no webhooks for post status, so poll it.
          </p>

          <h2 id="rate-limits">Rate limits</h2>
          <p>
            Limits depend on your Buffer plan and apply over 15 minutes, 24 hours, and 30 days.
            All of your API keys and MCP connections share one set of limits, so another key
            doesn't add requests (<a href="${limits}">rate limits</a>):
          </p>
          <table>
            <thead><tr><th>Plan</th><th>Keys and request limits</th></tr></thead>
            <tbody>
              <tr><td>Free</td><td>1 key, 1 app client; 150 per 15 min, 600 per 24 h; 1,000 per channel per 30 days, up to 3,000</td></tr>
              <tr><td>Essentials</td><td>3 keys, 3 app clients; 450 per 15 min, 1,800 per 24 h; 3,000 per channel per 30 days, up to 30,000</td></tr>
              <tr><td>Team</td><td>5 keys, 5 app clients; 1,500 per 15 min, 6,000 per 24 h; 10,000 per channel per 30 days, up to 100,000</td></tr>
            </tbody>
          </table>
          <p>
            An OAuth app client has its own limits, separate from your plan's, which grow with
            the number of Buffer users who authorize it (up to 1,000 counted):
          </p>
          <table>
            <thead><tr><th>Window</th><th>Base, plus per authorized user</th></tr></thead>
            <tbody>
              <tr><td>15 minutes</td><td>100, plus 10</td></tr>
              <tr><td>24 hours</td><td>500, plus 25</td></tr>
              <tr><td>30 days</td><td>15,000, plus 100</td></tr>
            </tbody>
          </table>
          <p>
            Every response carries <code>RateLimit</code> and <code>RateLimit-Policy</code>
            headers, one per window, with the requests remaining (<code>r</code>) and seconds
            to reset (<code>t</code>). Going over returns HTTP 429 with a
            <code>Retry-After</code> header in seconds and an error naming the window. Buffer
            says a 429 doesn't use quota. Queries also have their own limits: a complexity cost
            of 175,000 points, depth 25, 30 aliases, 50 directives, and 15,000 tokens.
          </p>
          <p>
            These request limits are separate from each channel's daily posting limits, which
            you read with the <code>dailyPostingLimits</code> query.
          </p>

          <h2 id="migration">Moving off the legacy REST API</h2>
          <p>
            Buffer's <a href="${migration}">migration guide</a> lists the changes: one endpoint
            instead of one URL per resource, always <code>POST</code>, cursor pagination
            (<code>first</code> and <code>after</code>) instead of page and count, typed errors in
            the response body instead of HTTP status codes, and an API key or OAuth with PKCE
            instead of the old OAuth client flow. REST profiles are now channels, and updates are
            posts.
          </p>

          <h2 id="alternatives">Buffer API alternatives</h2>
          <p>
            Buffer's API fits best when you or your users already run social accounts in Buffer:
            Buffer holds the channel connections and the posting schedule, and your code feeds it
            posts. If that doesn't match what you're building, the options fall into three
            groups.
          </p>
          <ul>
            <li>
              <strong>Post directly to each network.</strong> Your own platform apps and tokens,
              no intermediary, and each platform's own review and limits. Our guides cover the
              <a href="/guides/x-api-pricing">X API</a>,
              <a href="/guides/bluesky-api">Bluesky API</a>, and
              <a href="/guides/threads-api">Threads API</a>.
            </li>
            <li>
              <strong>A unified posting API.</strong> A provider holds the platform apps and
              account connections, and you call one API. Their own sites describe
              <a href="https://www.ayrshare.com">Ayrshare</a>,
              <a href="https://www.postforme.dev">Post for Me</a>,
              <a href="https://www.upload-post.com">Upload-Post</a>,
              <a href="https://www.outstand.so">Outstand</a>, and
              <a href="https://bundle.social">bundle.social</a> as unified social media APIs, and
              <a href="https://zernio.com">Zernio</a> (getlate.dev now redirects there) as
              marketing infrastructure behind one API key. Each has its own pricing and
              platform list; compare them on their sites.
            </li>
            <li>
              <strong>Another scheduler with an API.</strong>
              <a href="https://postiz.com">Postiz</a> (open source, which you can self-host) and
              <a href="https://postfa.st">PostFast</a> are schedulers, like Buffer, that also
              expose an API.
            </li>
          </ul>

          <h2 id="social-sdk">Using Buffer with Social SDK</h2>
          <p>
            <a href="/">Social SDK</a> is an open-source TypeScript library that puts direct
            platform adapters and managed backends behind one <code>posts.publish</code> call
            with a typed outcome per destination. Buffer is one of those backends, alongside
            Zernio, Post for Me, PostFast, Postiz, and Upload-Post, so you can start on Buffer
            and switch later without rewriting your posting code. The
            <a href="/docs/backends/buffer">Buffer backend page</a> covers API keys, the OAuth
            PKCE helpers, scheduling, media URLs, and how Buffer statuses map to outcomes.
          </p>
          <p>
            The Buffer adapter is on the main branch and not yet in the 0.5.0 npm release, which
            includes the Zernio, Post for Me, and PostFast backends and the direct adapters. You
            can write and test your posting code today against the mock backend, which needs no
            keys:
          </p>
          <pre><code>npm install @opencoredev/social-sdk</code></pre>
          ${code(sdkExample)}
          <p>
            We type-checked this against <code>@opencoredev/social-sdk</code> 0.5.0 from npm and
            ran it on ${fetched}. It printed <code>x published</code> and
            <code>bluesky failed</code>: the <code>mixed-success-failure</code> scenario fails
            every second target, so you can see how your code handles a partial result. The
            <a href="/docs/getting-started/mock-quickstart">mock quickstart</a> has the other
            scenarios, and the <a href="/docs/backends">managed backends overview</a> compares
            what each provider's adapter supports.
          </p>

          <h2 id="faq">Common questions</h2>
          <dl class="faq">
            <dt>Does Buffer have an API?</dt>
            <dd>
              Yes, a GraphQL API at <code>https://api.buffer.com</code>. Create a key under
              Settings → API, or register an OAuth app client to act for other users.
            </dd>
            <dt>Is the Buffer API free?</dt>
            <dd>
              Buffer's help center says API access is included on every plan, including Free,
              which allows 1 API key and 1,000 requests per connected channel every 30 days, up
              to 3,000. Paid plans allow more keys and requests.
            </dd>
            <dt>Can I upload images or video through the Buffer API?</dt>
            <dd>
              Not as a file upload. Pass a public, stable HTTPS URL in <code>assets</code>, and
              keep it reachable until the post publishes.
            </dd>
            <dt>Can I get analytics from the Buffer API?</dt>
            <dd>
              Only an experimental set of post metrics, readable with a personal API key. Buffer
              says not to rely on it for reporting, and OAuth apps can't read it.
            </dd>
            <dt>Does my old api.bufferapp.com code still work?</dt>
            <dd>
              That is the legacy REST API. Buffer's migration guide maps each endpoint to the
              GraphQL API; plan to move to it.
            </dd>
          </dl>

          <h2 id="sources">Sources</h2>
          <p>Read on ${fetched}:</p>
          <ul>
            <li><a href="${helpCenter}">What is Buffer's API?</a> (help center): plans, supported channels, what is and isn't supported, approval drafts</li>
            <li><a href="${quickStart}">Quick start</a>: endpoint, API key, first request</li>
            <li><a href="${authentication}">Authentication</a>: key scope, OAuth 2.0 with PKCE, scopes</li>
            <li><a href="${buildingApps}">Building apps</a>: app clients, redirect URIs, production</li>
            <li><a href="${scheduling}">Posts and scheduling</a>: modes, <code>dueAt</code>, statuses</li>
            <li><a href="${hostingMedia}">Hosting media</a>: public URL requirements</li>
            <li><a href="${limits}">Rate limits</a>: plan and app client limits, headers, 429 handling, query limits</li>
            <li><a href="${migration}">REST API migration</a>: legacy endpoint mapping</li>
            <li><a href="${docs}/reference">API reference</a>: <code>createPost</code>, <code>ShareMode</code>, <code>SchedulingType</code>, <code>PostStatus</code></li>
          </ul>`,
};
