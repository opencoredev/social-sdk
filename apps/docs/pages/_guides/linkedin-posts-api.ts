// The LinkedIn Posts API guide. Facts about LinkedIn's API cite LinkedIn's own
// pages on Microsoft Learn, with the date each was read and the date each page
// showed. No prices. The Social SDK example type-checks against the published
// npm package and was run against a stubbed fetch.
import { escapeHtml } from "../_blog/render";
import type { Guide } from "./guides";

const fetched = "31 October 2026";

const learn = "https://learn.microsoft.com/en-us/linkedin";
const postsApi = `${learn}/marketing/community-management/shares/posts-api`;
const imagesApi = `${learn}/marketing/community-management/shares/images-api`;
const littleText = `${learn}/marketing/community-management/shares/little-text-format`;
const versioning = `${learn}/marketing/versioning`;
const rateLimits = `${learn}/shared/api-guide/concepts/rate-limits`;
const increasingAccess = `${learn}/marketing/increasing-access`;
const communityManagement = `${learn}/marketing/community-management/community-management-overview`;
const shareOnLinkedIn = `${learn}/consumer/integrations/self-serve/share-on-linkedin`;
const signIn = `${learn}/consumer/integrations/self-serve/sign-in-with-linkedin-v2`;
const authCodeFlow = `${learn}/shared/authentication/authorization-code-flow`;
const refreshTokens = `${learn}/shared/authentication/programmatic-refresh-tokens`;

const readUserinfo = `curl "https://api.linkedin.com/v2/userinfo" \\
  -H "Authorization: Bearer <ACCESS_TOKEN>"
# {"sub": "abc123", "name": "...", ...}
# The member's author URN is urn:li:person:abc123`;

const createPost = `curl -X POST "https://api.linkedin.com/rest/posts" \\
  -H "Authorization: Bearer <ACCESS_TOKEN>" \\
  -H "Linkedin-Version: 202610" \\
  -H "X-Restli-Protocol-Version: 2.0.0" \\
  -H "Content-Type: application/json" \\
  --data '{
    "author": "urn:li:person:abc123",
    "commentary": "Hello from the LinkedIn Posts API",
    "visibility": "PUBLIC",
    "distribution": {
      "feedDistribution": "MAIN_FEED",
      "targetEntities": [],
      "thirdPartyDistributionChannels": []
    },
    "lifecycleState": "PUBLISHED",
    "isReshareDisabledByAuthor": false
  }'
# HTTP 201, with the new post's URN in the x-restli-id response header:
# x-restli-id: urn:li:share:7100000000000000000`;

const littleExamples = `Plain text, escaped:   Ship it \\(today\\)
Mention a Page:        Thanks @[Devtestco](urn:li:organization:2414183)
Hashtag:               {hashtag|\\#|buildinpublic}`;

const initializeUpload = `curl -X POST "https://api.linkedin.com/rest/images?action=initializeUpload" \\
  -H "Authorization: Bearer <ACCESS_TOKEN>" \\
  -H "Linkedin-Version: 202610" \\
  -H "X-Restli-Protocol-Version: 2.0.0" \\
  -H "Content-Type: application/json" \\
  --data '{"initializeUploadRequest": {"owner": "urn:li:person:abc123"}}'
# {"value": {"uploadUrl": "https://...", "image": "urn:li:image:...", "uploadUrlExpiresAt": ...}}`;

const sdkExample = `import { createSocial, connectedAccountRef } from "@opencoredev/social-sdk";
import { linkedin } from "@opencoredev/social-sdk/linkedin";

type AuthorUrn = \`urn:li:person:\${string}\` | \`urn:li:organization:\${string}\`;
const isAuthorUrn = (value: string): value is AuthorUrn =>
  /^urn:li:(person|organization):[\\w-]+$/.test(value);

const accessToken = process.env["LINKEDIN_ACCESS_TOKEN"];
const author = process.env["LINKEDIN_AUTHOR"]; // urn:li:person:... or urn:li:organization:...
if (!accessToken || !author || !isAuthorUrn(author)) {
  throw new Error("Set LINKEDIN_ACCESS_TOKEN, and LINKEDIN_AUTHOR to a person or organization URN");
}

const social = createSocial({
  backend: linkedin({ auth: { accessToken, author }, apiVersion: "202610" }),
});
const account = connectedAccountRef({ backend: "default", platform: "linkedin", accountId: author });

const result = await social.posts.publish({
  targets: [{ account }],
  content: { text: "Posted to LinkedIn from TypeScript (with Social SDK)" },
});

for (const outcome of result.outcomes) {
  if (outcome.state === "published") {
    console.log("published", \`https://www.linkedin.com/feed/update/\${outcome.post.postId}/\`);
  } else {
    console.log(outcome.state, outcome);
  }
}`;

const code = (source: string) => `<pre><code>${escapeHtml(source)}</code></pre>`;

export const linkedinPostsApi: Guide = {
  slug: "linkedin-posts-api",
  title: "LinkedIn Posts API: post as a member or a Page",
  description:
    "How to create LinkedIn posts with the API: Share on LinkedIn vs Community Management, scopes, author URNs, version headers, rate limits, and tested TypeScript.",
  summary:
    "Posting to LinkedIn through the versioned Posts API: which product and scope you need, author URNs, the request, text escaping, images, rate limits, and a TypeScript example.",
  heading: "The LinkedIn Posts API, explained",
  lede: "To post to LinkedIn from code, send <code>POST https://api.linkedin.com/rest/posts</code> with the author's URN, the post text, and two required headers: <code>Linkedin-Version</code> (a monthly version such as <code>202610</code>) and <code>X-Restli-Protocol-Version: 2.0.0</code>. Posting as a member needs <code>w_member_social</code> from the self-serve Share on LinkedIn product. Posting as a company Page needs <code>w_organization_social</code> from the Community Management API, which LinkedIn reviews, plus a Page role. A created post comes back as a URN in the <code>x-restli-id</code> header.",
  published: "2026-10-31",
  updated: "2026-10-31",
  content: `
          <h2 id="posts-api">What the Posts API is</h2>
          <p>
            The Posts API at <code>/rest/posts</code> is LinkedIn's current endpoint for creating
            and reading posts. It replaces the older <code>ugcPosts</code> API
            (<a href="${postsApi}">Posts API</a>), although LinkedIn's Share on LinkedIn page still
            shows the old <code>POST /v2/ugcPosts</code> request. New code should use
            <code>/rest/posts</code>. Organic posts can carry text, an image, a video, a document,
            an article link, several images (MultiImage), a poll, or a celebration. Carousels are
            for sponsored posts only.
          </p>
          <p>
            Every call needs a <code>Linkedin-Version</code> header in <code>YYYYMM</code> form.
            LinkedIn publishes a new version each month, supports each one for at least a year, and
            expects every call to name one: it doesn't fall back to the latest version
            (<a href="${versioning}">versioning</a>). The latest version on
            ${fetched} was <code>202610</code>. Version <code>202511</code> sunsets on 16 November
            2026, so code pinned to it stops working then.
          </p>

          <h2 id="member-or-page">Posting as a member or as a Page</h2>
          <p>
            The author decides which product and scope you need. LinkedIn grants scopes through
            products you add to your app in the Developer Portal.
          </p>
          <table>
            <thead><tr><th>Post as</th><th>What you need</th></tr></thead>
            <tbody>
              <tr>
                <td>A member (<code>urn:li:person:{id}</code>)</td>
                <td>The <code>w_member_social</code> scope, granted by adding the self-serve
                Share on LinkedIn product to your app (<a href="${shareOnLinkedIn}">Share on LinkedIn</a>)</td>
              </tr>
              <tr>
                <td>A company Page (<code>urn:li:organization:{id}</code>)</td>
                <td>The <code>w_organization_social</code> scope from the Community Management API,
                and the member behind the token must hold the <code>ADMINISTRATOR</code>,
                <code>CONTENT_ADMIN</code>, or <code>DIRECT_SPONSORED_CONTENT_POSTER</code> role on
                that Page (<a href="${postsApi}">Posts API</a>)</td>
              </tr>
            </tbody>
          </table>
          <p>
            Reading a member's own posts back needs <code>r_member_social</code>, which LinkedIn
            lists as closed: it isn't accepting requests for it
            (<a href="${communityManagement}">Community Management overview</a>). Plan to store the
            post URN you get back at creation time instead of listing a member's posts later.
          </p>

          <h2 id="access">Community Management access tiers</h2>
          <p>
            The Community Management API is a vetted product. Every app starts in the Development
            tier, which LinkedIn describes as being for building and testing, with API call limits.
            You have twelve months from approval to finish the integration and apply for the
            Standard tier, which is meant for production and has no such restrictions
            (<a href="${increasingAccess}">increasing access</a>). The Standard tier application
            asks for a screencast showing each use case you applied for
            (<a href="${communityManagement}">Community Management overview</a>).
          </p>
          <table>
            <thead><tr><th>Development tier limit</th><th>Value</th></tr></thead>
            <tbody>
              <tr><td>Calls per app</td><td>500 per day</td></tr>
              <tr><td>Calls per member, per app</td><td>100 per day</td></tr>
            </tbody>
          </table>
          <p>
            Those figures come from the FAQ on LinkedIn's
            <a href="${communityManagement}">Community Management overview</a>. LinkedIn only
            lets you request the Development tier on a new app that has no other API products.
          </p>

          <h2 id="tokens">Tokens and the author URN</h2>
          <p>
            LinkedIn uses the OAuth 2.0 authorization code flow. The member consents to every scope
            you request at once, and the authorization code lasts 30 minutes, so exchange it right
            away (<a href="${authCodeFlow}">authorization code flow</a>). Access tokens last 60 days
            by default. Refresh tokens are offered to approved Marketing Developer Platform
            partners and last a year from the first consent; refreshing gives a new 60-day access
            token but doesn't extend the refresh token
            (<a href="${refreshTokens}">programmatic refresh tokens</a>). Without one, the member
            has to authorize your app again when the access token expires.
          </p>
          <p>
            To post as the member, you need their person URN. Add the Sign In with LinkedIn using
            OpenID Connect product, request the <code>openid</code> and <code>profile</code>
            scopes along with <code>w_member_social</code>, and read the <code>sub</code> field from
            the userinfo endpoint (<a href="${signIn}">Sign In with LinkedIn</a>):
          </p>
          ${code(readUserinfo)}
          <p>
            A Page's URN is <code>urn:li:organization:</code> followed by its numeric ID.
          </p>

          <h2 id="create-post">Creating a text post</h2>
          ${code(createPost)}
          <p>
            A <code>201</code> means LinkedIn created the post. The <code>x-restli-id</code> header
            holds its URN, either <code>urn:li:share:{id}</code> or
            <code>urn:li:ugcPost:{id}</code>. Store it: you need it to read, edit, or delete the
            post later (<code>DELETE /rest/posts/{encoded URN}</code>, which is idempotent).
            <code>lifecycleState</code> is <code>PUBLISHED</code> and the request has no
            publish-time field, so a create call posts right away.
          </p>
          <p>
            To link to the new post, LinkedIn's Posts API page gives the view URL as
            <code>https://www.linkedin.com/feed/update/{post URN}/</code>, for example
            <code>https://www.linkedin.com/feed/update/urn:li:ugcPost:{id}/</code>.
          </p>

          <h2 id="text-format">Post text is in little format</h2>
          <p>
            The <code>commentary</code> field isn't plain text. LinkedIn parses it as
            <a href="${littleText}">little text format</a>, which turns certain characters into
            mentions and hashtags. These characters are reserved and must be escaped with a
            backslash to appear as written, whether or not you use the feature they belong to:
            <code>| { } @ [ ] ( ) &lt; &gt; # \\ * _ ~</code>.
          </p>
          ${code(littleExamples)}
          <p>
            A mention only becomes a link when the text in brackets matches the Page's full name,
            case-sensitively. A member mention can match just one of their names
            (<a href="${postsApi}">Posts API</a>).
          </p>

          <h2 id="images">Posting an image</h2>
          <p>
            Media is uploaded first and attached by URN. For an image, call
            <code>initializeUpload</code> with the author as owner, upload the bytes to the
            returned <code>uploadUrl</code>, then create the post with
            <code>content.media.id</code> set to the <code>urn:li:image:</code> value
            (<a href="${imagesApi}">Images API</a>). The image must be a JPG, GIF, or PNG under
            36,152,320 pixels, and a GIF can have up to 250 frames. Images report
            <code>PROCESSING</code>, <code>AVAILABLE</code>, or <code>PROCESSING_FAILED</code>;
            attach one once it is <code>AVAILABLE</code>. Video and documents work the same way
            through the Videos and Documents APIs.
          </p>
          ${code(initializeUpload)}

          <h2 id="rate-limits">Rate limits</h2>
          <p>
            LinkedIn limits calls per app and per member per app over a day that resets at
            midnight UTC, and returns <code>429</code> when you go over
            (<a href="${rateLimits}">rate limits</a>). It doesn't publish the standard limits.
            Each app's limits appear on its Analytics tab in the Developer Portal, but only for
            endpoints the app has already called at least once. Developer admins get an email
            when an app passes 75% of its quota, usually one to two hours later. Back off on
            <code>429</code> rather than retrying in a loop, and don't retry a create call blindly
            after a timeout: the post may already exist.
          </p>

          <h2 id="social-sdk">Posting to LinkedIn from TypeScript with Social SDK</h2>
          <p>
            <a href="/">Social SDK</a> is an open-source TypeScript library whose LinkedIn adapter
            sends the request above through one <code>posts.publish</code> call. You pass the
            token, the author URN, and the API version to pin; the adapter adds both headers,
            escapes the reserved characters in your text, and returns a typed outcome with the
            post URN. If LinkedIn accepts the request without returning a usable URN, the outcome
            is <code>unknown</code> rather than a guess, and the adapter doesn't send it again.
          </p>
          <pre><code>npm install @opencoredev/social-sdk</code></pre>
          ${code(sdkExample)}
          <p>
            We type-checked this example against <code>@opencoredev/social-sdk</code> 0.5.0 from npm
            and ran it on ${fetched} with Node.js 24 and Bun, using a stub <code>fetch</code> in
            place of LinkedIn. It sent one <code>POST /rest/posts</code> with
            <code>Linkedin-Version: 202610</code> and the parentheses escaped, and printed the post
            URL. Two limits to know in 0.5.0: it escapes every reserved character, so
            <code>#</code> and <code>@</code> come out as plain text rather than hashtags or
            mentions, and it rejects text over 3,000 characters before sending. Running the
            script again creates a second post; to make retries safe, give the client a durable
            <a href="/docs/concepts/idempotency">idempotency store</a> and pass an
            <code>idempotencyKey</code>.
          </p>
          <p>
            The SDK's <code>linkedinOAuth</code> helper requests <code>openid</code>,
            <code>profile</code>, and <code>w_member_social</code>, which covers member posting but
            not Pages (<a href="/docs/authentication">authentication guide</a>). Images, video,
            documents, multi-image posts, comments, and Page analytics are on the
            <a href="/docs/platforms/linkedin">LinkedIn platform page</a>. To build without a
            LinkedIn app at all, start with the
            <a href="/docs/getting-started/mock-quickstart">mock quickstart</a>. The same client
            can post to X, Bluesky, Threads, and the other
            <a href="/docs/platforms">supported platforms</a> in one call.
          </p>

          <h2 id="faq">Common questions</h2>
          <dl class="faq">
            <dt>Can I post to LinkedIn with the API without review?</dt>
            <dd>
              As a member, yes: Share on LinkedIn is a self-serve product that grants
              <code>w_member_social</code>. Posting as a Page needs the Community Management API,
              which LinkedIn approves, starting with the Development tier.
            </dd>
            <dt>Should I use ugcPosts or the Posts API?</dt>
            <dd>The Posts API (<code>/rest/posts</code>). LinkedIn says it replaces ugcPosts, and it is the versioned endpoint.</dd>
            <dt>Can I schedule LinkedIn posts through the API?</dt>
            <dd>
              Not with a publish time. A create call publishes immediately, so schedule in your own
              job runner and make the call at the chosen time.
            </dd>
            <dt>How do I turn a post URN into a URL?</dt>
            <dd>Put it after <code>https://www.linkedin.com/feed/update/</code>, as in LinkedIn's example <code>https://www.linkedin.com/feed/update/urn:li:ugcPost:{id}/</code>.</dd>
            <dt>Why do I get 403 when posting as a Page?</dt>
            <dd>
              Usually the token lacks <code>w_organization_social</code>, or the member who
              authorized it doesn't hold an eligible role on that Page.
            </dd>
            <dt>Do I need to escape characters in LinkedIn post text?</dt>
            <dd>Yes. The text is parsed as little format, so escape reserved characters such as parentheses and <code>#</code> with a backslash, and use the hashtag template for a real hashtag.</dd>
          </dl>

          <h2 id="sources">Sources</h2>
          <p>LinkedIn's pages on Microsoft Learn, read on ${fetched}, with the update date each page showed:</p>
          <ul>
            <li><a href="${postsApi}">Posts API</a> (updated 13 May 2026): permissions, roles, creating and deleting posts, URNs, view URLs, mentions</li>
            <li><a href="${versioning}">Marketing API versioning</a> (updated 14 October 2026): version header, monthly cadence, latest version</li>
            <li><a href="${littleText}">little text format</a> (updated 16 October 2025): reserved characters, mentions, hashtags</li>
            <li><a href="${imagesApi}">Images API</a> (updated 24 June 2026): initializeUpload, formats, statuses</li>
            <li><a href="${increasingAccess}">Increasing access</a> (updated 19 October 2026): Development and Standard tiers</li>
            <li><a href="${communityManagement}">Community Management overview</a> (updated 15 May 2026): use cases, tier limits, closed <code>r_member_social</code></li>
            <li><a href="${rateLimits}">Rate limits</a> (updated 20 August 2025)</li>
            <li><a href="${shareOnLinkedIn}">Share on LinkedIn</a> (updated 14 December 2023): <code>w_member_social</code></li>
            <li><a href="${signIn}">Sign In with LinkedIn using OpenID Connect</a> (updated 8 August 2024): <code>openid</code>, <code>profile</code>, userinfo</li>
            <li><a href="${authCodeFlow}">Authorization code flow</a> (updated 15 May 2026): scopes, code lifetime, token lifetime</li>
            <li><a href="${refreshTokens}">Programmatic refresh tokens</a> (updated 8 October 2025)</li>
          </ul>`,
};
