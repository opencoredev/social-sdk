// The Bluesky API guide. Facts about Bluesky cite Bluesky's developer docs at
// bsky.network and the AT Protocol lexicons, with the date each was read; the
// Social SDK example type-checks against the published npm package and was run
// against a stubbed fetch.
import { escapeHtml } from "../_blog/render";
import type { Guide } from "./guides";

const fetched = "28 October 2026";

const docs = "https://bsky.network/docs";

const lexicons = "https://github.com/bluesky-social/atproto/blob/main";

const createSession = `curl -X POST "https://bsky.social/xrpc/com.atproto.server.createSession" \\
  -H "Content-Type: application/json" \\
  -d '{"identifier": "alice.bsky.social", "password": "<APP_PASSWORD>"}'
# {"did": "did:plc:...", "handle": "alice.bsky.social", "accessJwt": "...", "refreshJwt": "..."}`;

const createRecord = `curl -X POST "https://bsky.social/xrpc/com.atproto.repo.createRecord" \\
  -H "Authorization: Bearer <ACCESS_JWT>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "repo": "<DID>",
    "collection": "app.bsky.feed.post",
    "record": {
      "$type": "app.bsky.feed.post",
      "text": "Hello from the Bluesky API",
      "createdAt": "2026-10-28T12:00:00.000Z"
    }
  }'
# {"uri": "at://did:plc:.../app.bsky.feed.post/3k...", "cid": "bafyrei..."}`;

const linkFacet = `{
  "$type": "app.bsky.feed.post",
  "text": "Docs at https://social-sdk.dev",
  "createdAt": "2026-10-28T12:00:00.000Z",
  "facets": [
    {
      "index": { "byteStart": 8, "byteEnd": 30 },
      "features": [{ "$type": "app.bsky.richtext.facet#link", "uri": "https://social-sdk.dev" }]
    }
  ]
}`;

const sdkExample = `import { createSocial, connectedAccountRef } from "@opencoredev/social-sdk";
import { bluesky } from "@opencoredev/social-sdk/bluesky";

const identifier = process.env["BLUESKY_HANDLE"];
const password = process.env["BLUESKY_APP_PASSWORD"];
if (!identifier || !password) throw new Error("Set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD");

// Exchange the app password for a session once, then reuse its access token.
const login = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ identifier, password }),
});
if (!login.ok) throw new Error(\`Bluesky login failed with HTTP \${login.status}\`);
const session: unknown = await login.json();
if (
  typeof session !== "object" || session === null ||
  !("did" in session) || typeof session.did !== "string" ||
  !("accessJwt" in session) || typeof session.accessJwt !== "string"
) throw new Error("Unexpected createSession response");

const social = createSocial({
  backend: bluesky({
    auth: { service: "https://bsky.social", did: session.did, accessJwt: session.accessJwt },
  }),
});
const account = connectedAccountRef({ backend: "default", platform: "bluesky", accountId: session.did });

const result = await social.posts.publish({
  targets: [{ account }],
  content: { text: "Posted to Bluesky from TypeScript https://social-sdk.dev" },
});

for (const outcome of result.outcomes) {
  if (outcome.state === "published") console.log("published", outcome.post.native);
  else console.log(outcome.state, outcome);
}`;

const code = (source: string) => `<pre><code>${escapeHtml(source)}</code></pre>`;

export const blueskyApi: Guide = {
  slug: "bluesky-api",
  title: "Bluesky API guide: auth, posting, limits, and TypeScript",
  description:
    "How the Bluesky API works: app passwords vs OAuth, creating posts with createRecord, link facets, images, rate limits, and a tested TypeScript example.",
  summary:
    "The Bluesky API end to end: hosts, app passwords and OAuth, posting with createRecord, links and mentions as facets, images and video, rate limits, and a TypeScript example.",
  heading: "The Bluesky API, explained",
  lede: "The Bluesky API is the set of AT Protocol endpoints that Bluesky's servers expose. It needs no developer account or API key: to post, you log in as the account and create an app.bsky.feed.post record in its repository. A post holds up to 300 characters and four images, and an account can create about 1,666 records an hour.",
  published: "2026-10-28",
  updated: "2026-10-28",
  content: `
          <h2 id="what-it-is">What the Bluesky API is</h2>
          <p>
            Bluesky runs on the AT Protocol. Every account has a repository of records on a
            personal data server (PDS), and a post is one of those records. Writing to the API
            means writing records to the account's repository; reading means querying Bluesky's
            app view. There is no separate developer program, app registration, or API key for
            posting. The requests you make are the same ones the Bluesky app makes.
          </p>
          <p>Three hosts matter for most apps (<a href="${docs}/rate-limits">rate limits</a>):</p>
          <table>
            <thead><tr><th>Host</th><th>Use it for</th></tr></thead>
            <tbody>
              <tr><td><code>bsky.social</code></td><td>Logging in and authenticated calls for accounts Bluesky hosts. It forwards requests to the account's own PDS.</td></tr>
              <tr><td><code>public.api.bsky.app</code></td><td>Unauthenticated, cached reads of public profiles, posts, and feeds</td></tr>
              <tr><td>The account's PDS</td><td>Authenticated calls without the extra hop; its address is in the DID document returned at login</td></tr>
            </tbody>
          </table>
          <p>
            Bluesky calls <code>bsky.social</code> the Entryway. It handles sessions for every
            account Bluesky hosts and forwards most other requests to the right PDS
            (<a href="${docs}/entryway">PDS Entryway</a>). Accounts on a self-hosted PDS log in
            to that server instead.
          </p>

          <h2 id="auth">App passwords or OAuth</h2>
          <p>
            Bluesky supports two ways to act as an account. Its docs say apps with their own
            end-user login should implement OAuth, and that single-purpose apps such as bots and
            command-line tools may use app passwords instead
            (<a href="${docs}/oauth-client">OAuth</a>).
          </p>
          <ul>
            <li>
              <strong>App password.</strong> The account owner creates one in the Bluesky app's
              settings. Your code exchanges the handle and app password for a session with
              <code>com.atproto.server.createSession</code>. It suits a bot or a script that
              posts to accounts you own.
            </li>
            <li>
              <strong>OAuth.</strong> The user signs in on their own server and approves your
              app. AT Protocol OAuth requires PKCE, pushed authorization requests, and
              DPoP-bound tokens, and your client ID is the URL of a metadata document you host.
              Use it when other people connect their accounts to your product.
            </li>
          </ul>
          ${code(createSession)}
          <p>
            The session has a short-lived <code>accessJwt</code> for API calls and a
            <code>refreshJwt</code>. When the access token expires, call
            <code>com.atproto.server.refreshSession</code> with the refresh token as the bearer
            token; it returns a new pair and fails with <code>ExpiredToken</code> or
            <code>InvalidToken</code> when the refresh token is no longer good
            (<a href="${lexicons}/lexicons/com/atproto/server/refreshSession.json">refreshSession lexicon</a>).
            Refresh rather than logging in again: <code>createSession</code> is limited to 30
            calls per 5 minutes and 300 per day per account.
          </p>

          <h2 id="post">Creating a post</h2>
          <p>
            A post is a record of type <code>app.bsky.feed.post</code> with two required fields,
            <code>text</code> and <code>createdAt</code>. Create it with
            <code>com.atproto.repo.createRecord</code>, passing the account's DID as the
            <code>repo</code> (<a href="${docs}/bluesky-api/creating-a-post">creating a post</a>):
          </p>
          ${code(createRecord)}
          <p>
            The response holds the post's <code>at://</code> URI and its CID, a hash of the
            record. Keep both: replies, quote posts, likes, and reposts point to a post by that
            pair. Optional fields include <code>langs</code> (up to three language tags),
            <code>reply</code> (the parent and the thread's root), and <code>embed</code> for
            images, video, link cards, or a quoted post.
          </p>

          <h2 id="facets">Links, mentions, and hashtags are facets</h2>
          <p>
            Bluesky doesn't detect links in post text. A URL you send as plain text shows up as
            plain text. Links, mentions, and hashtags are <em>facets</em>: annotations that
            point at a byte range of the text and say what it is
            (<a href="${docs}/about-bluesky-content/post-richtext">links, mentions, and rich text</a>).
          </p>
          ${code(linkFacet)}
          <p>
            The offsets count UTF-8 bytes, not JavaScript string positions. In TypeScript,
            <code>text.indexOf()</code> and <code>.slice()</code> give UTF-16 positions, which
            go wrong as soon as the text contains an emoji or an accented letter. Encode with
            <code>TextEncoder</code> first, or let a library build the facets. A mention facet
            needs the mentioned account's DID, so resolve the handle before posting. Facets
            can't overlap.
          </p>

          <h2 id="media">Images and video</h2>
          <p>
            Media is uploaded first and then referenced. Upload each image with
            <code>com.atproto.repo.uploadBlob</code>, then put the returned blob in an
            <code>app.bsky.embed.images</code> embed with its alt text. A post holds up to four
            images, and each image may be up to 2 MB
            (<a href="${lexicons}/packages/api/lexicons/app/bsky/embed/images.json">images lexicon</a>; the
            limit was 1 MB before). Bluesky recommends stripping image metadata before upload.
          </p>
          <p>
            Video is a different service. Bluesky recommends uploading the MP4 to
            <code>video.bsky.app</code> with a service token, checking the processing job until
            it returns a blob, and only then creating the post. Accounts Bluesky hosts must have
            a verified email to upload video, and there is a daily limit on video posts
            (<a href="${docs}/about-bluesky-content/video">uploading video</a>).
          </p>

          <h2 id="limits">Rate limits</h2>
          <p>
            Bluesky's PDS hosts limit writes per account by points: creating a record costs 3,
            updating 2, and deleting 1, against 5,000 points an hour and 35,000 a day. That
            works out to about 1,666 new records an hour or 11,666 a day, and likes, follows,
            and reposts are records too. Requests over a limit get HTTP 429
            (<a href="${docs}/rate-limits">rate limits</a>).
          </p>
          <table>
            <thead><tr><th>Limit</th><th>Value</th></tr></thead>
            <tbody>
              <tr><td>Post text</td><td>300 graphemes and 3,000 UTF-8 bytes (<a href="${lexicons}/packages/api/lexicons/app/bsky/feed/post.json">post lexicon</a>)</td></tr>
              <tr><td>Images per post</td><td>4, up to 2 MB each</td></tr>
              <tr><td>Record writes per account</td><td>5,000 points an hour, 35,000 a day</td></tr>
              <tr><td>All API requests to a PDS</td><td>3,000 per 5 minutes per IP</td></tr>
              <tr><td><code>createSession</code></td><td>30 per 5 minutes, 300 per day, per account</td></tr>
              <tr><td>Any single blob upload</td><td>50 MB at the PDS</td></tr>
            </tbody>
          </table>
          <p>
            Bluesky says these limits will change over time, and other PDS hosts set their own.
            Its <a href="${docs}/developer-guidelines">developer guidelines</a> also forbid
            automated bulk interactions, such as mass follows, likes, or replies, whatever the
            rate limit allows.
          </p>

          <h2 id="social-sdk">Posting to Bluesky from TypeScript with Social SDK</h2>
          <p>
            <a href="/">Social SDK</a> is an open-source TypeScript library with a Bluesky
            adapter. One <code>posts.publish</code> call checks the 300-grapheme and 3,000-byte
            limits, adds link facets for URLs in the text with correct UTF-8 offsets, uploads
            attached images, and creates the record. You get back a typed outcome with the
            post's URI and CID. If the network fails after the request went out, the outcome is
            <code>unknown</code> and the adapter doesn't retry it, so a flaky connection can't
            post twice.
          </p>
          <pre><code>npm install @opencoredev/social-sdk</code></pre>
          ${code(sdkExample)}
          <p>
            We type-checked this example against <code>@opencoredev/social-sdk</code> 0.5.0 from
            npm and ran it on ${fetched} with a stub <code>fetch</code> standing in for
            <code>bsky.social</code>. It made two calls, <code>createSession</code> and
            <code>createRecord</code>, sent a link facet covering the URL, and printed the new
            post's URI and CID. It runs on Node.js 22.12 or later and Bun. In a long-running
            service, store the session and refresh it instead of logging in on every run.
          </p>
          <p>
            For accounts your users connect, the SDK's <code>blueskyOAuth</code> provider
            implements AT Protocol OAuth with PKCE, PAR, and DPoP. Mentions with DIDs, language
            tags, video uploads, likes, reposts, and search are on the
            <a href="/docs/platforms/bluesky">Bluesky platform page</a>. The same client can post
            to Bluesky, X, and Threads in one call; the
            <a href="/docs/platforms">platforms overview</a> shows how. To try it without an
            account, start with the <a href="/docs/getting-started/mock-quickstart">mock quickstart</a>.
          </p>

          <h2 id="faq">Common questions</h2>
          <dl class="faq">
            <dt>Do I need an API key or developer account for Bluesky?</dt>
            <dd>
              No. You authenticate as a Bluesky account, and the rate limits above apply. Bots
              and scripts log in with the account's handle and an app password. Apps
              where other people sign in use AT Protocol OAuth, where your client ID is the URL
              of your client metadata document.
            </dd>
            <dt>Why isn't my link clickable?</dt>
            <dd>
              Bluesky only links text that has a link facet. Add a facet with the URL's UTF-8
              byte range, or use a library that adds it for you.
            </dd>
            <dt>What does "Token has expired" mean?</dt>
            <dd>
              The <code>accessJwt</code> is short-lived. Call
              <code>com.atproto.server.refreshSession</code> with the <code>refreshJwt</code> to
              get a new one, and only log in again if the refresh token has expired too.
            </dd>
            <dt>Can I schedule Bluesky posts through the API?</dt>
            <dd>
              Not natively. The record's <code>createdAt</code> is a timestamp, not a schedule,
              and the post appears when you create it. Run your own job at the chosen time.
            </dd>
          </dl>

          <h2 id="sources">Sources</h2>
          <p>Read on ${fetched}:</p>
          <ul>
            <li><a href="${docs}/bluesky-api/creating-a-post">Creating a post</a>: record fields, createRecord, languages, replies, quote posts, image embeds</li>
            <li><a href="${docs}/about-bluesky-content/post-richtext">Links, mentions, and rich text</a>: facets and UTF-8 byte offsets</li>
            <li><a href="${docs}/about-bluesky-content/video">Uploading video</a>: the video service, email verification, daily limits</li>
            <li><a href="${docs}/rate-limits">Rate limits</a>: write points, PDS request limits, createSession, blob size, public hosts</li>
            <li><a href="${docs}/oauth-client">OAuth</a> and <a href="${docs}/entryway">PDS Entryway</a>: when to use app passwords, bsky.social</li>
            <li><a href="${docs}/developer-guidelines">Developer guidelines</a>: spam and automation rules</li>
            <li>AT Protocol lexicons on GitHub: <a href="${lexicons}/packages/api/lexicons/app/bsky/feed/post.json">app.bsky.feed.post</a>, <a href="${lexicons}/packages/api/lexicons/app/bsky/embed/images.json">app.bsky.embed.images</a>, <a href="${lexicons}/lexicons/com/atproto/server/refreshSession.json">com.atproto.server.refreshSession</a></li>
          </ul>`,
};
