// The Threads API guide. Facts about Meta's API cite Meta's own pages, with the
// date each was read; the Social SDK example type-checks against the published
// npm package and was run against a stubbed fetch.
import { escapeHtml } from "../_blog/render";
import type { Guide } from "./guides";

const fetched = "28 October 2026";

const meta = "https://developers.facebook.com/docs/threads";

const createContainer = `curl -X POST "https://graph.threads.net/v1.0/<THREADS_USER_ID>/threads" \
  -d "media_type=TEXT" \
  -d "text=Hello from the Threads API" \
  -d "access_token=<ACCESS_TOKEN>"
# {"id": "<CONTAINER_ID>"}`;

const checkContainer = `curl "https://graph.threads.net/v1.0/<CONTAINER_ID>?fields=status,error_message&access_token=<ACCESS_TOKEN>"
# {"status": "FINISHED", "id": "<CONTAINER_ID>"}`;

const publishContainer = `curl -X POST "https://graph.threads.net/v1.0/<THREADS_USER_ID>/threads_publish" \
  -d "creation_id=<CONTAINER_ID>" \
  -d "access_token=<ACCESS_TOKEN>"
# {"id": "<THREADS_MEDIA_ID>"}`;

const checkQuota = `curl "https://graph.threads.net/v1.0/<THREADS_USER_ID>/threads_publishing_limit?fields=quota_usage,config&access_token=<ACCESS_TOKEN>"
# {"data": [{"quota_usage": 4, "config": {"quota_total": 250, "quota_duration": 86400}}]}`;

const sdkExample = `import { createSocial, connectedAccountRef } from "@opencoredev/social-sdk";
import { threads } from "@opencoredev/social-sdk/threads";

const userId = process.env["THREADS_USER_ID"];
const accessToken = process.env["THREADS_ACCESS_TOKEN"];
if (!userId || !accessToken) throw new Error("Set THREADS_USER_ID and THREADS_ACCESS_TOKEN");

const social = createSocial({ backend: threads({ auth: { userId, accessToken } }) });
const account = connectedAccountRef({ backend: "default", platform: "threads", accountId: userId });

const result = await social.posts.publish({
  targets: [{ account }],
  content: { text: "Posted to Threads from TypeScript" },
  idempotencyKey: "draft-42",
});

for (const outcome of result.outcomes) {
  if (outcome.state === "published") console.log("published", outcome.post.postId);
  else if (outcome.state === "processing") console.log("still processing", outcome.backendState);
  else console.log(outcome.state, outcome);
}`;

const code = (source: string) => `<pre><code>${escapeHtml(source)}</code></pre>`;

export const threadsApi: Guide = {
  slug: "threads-api",
  title: "Threads API guide: access, tokens, limits, and posting",
  description:
    "How Meta's Threads API works: app setup, permissions, tokens, the two-step publish flow, the 250-post daily limit, and a tested TypeScript example.",
  summary:
    "Meta's Threads API end to end: getting access, token lifetimes, the container and publish flow, the daily publishing limits, and a TypeScript example.",
  heading: "The Threads API, explained",
  lede: "The Threads API is Meta's official REST API for Threads. It lets your app publish text, images, video, and carousels for a Threads user who authorized it, and read their posts, replies, and insights. Publishing takes two calls, a profile can publish 250 posts a day through it, and you need App Review before users outside your app's roles can grant access.",
  published: "2026-10-28",
  updated: "2026-10-28",
  content: `
          <h2 id="what-it-does">What the Threads API does</h2>
          <p>
            Meta opened the Threads API to all developers on
            <a href="https://developers.facebook.com/blog/post/2024/06/18/the-threads-api-is-finally-here/">18 June 2024</a>.
            Meta describes its purpose narrowly: to let people create and publish content on a
            person's behalf, and to show those posts in your app to the person who created them
            (<a href="${meta}/overview">overview</a>). In practice the API covers:
          </p>
          <ul>
            <li>publishing text, image, video, and carousel posts, plus replies and quote posts</li>
            <li>reading a user's own posts, profile, and replies, and hiding or managing replies</li>
            <li>post and profile insights</li>
            <li>deleting posts, and webhooks</li>
          </ul>
          <p>
            Requests go to <code>graph.threads.net</code> or <code>graph.threads.com</code>; Meta
            accepts both. Calls that read a user's data or publish for them need that user's
            Threads user access token.
          </p>

          <h2 id="access">Getting access</h2>
          <p>
            Create a Meta app and pick the Threads use case. The app gets two IDs and two secrets;
            use the Threads app ID and Threads app secret
            (<a href="${meta}/get-started">get started</a>). Users grant permissions through
            Meta's Authorization Window. The ones you will use most:
          </p>
          <table>
            <thead><tr><th>Permission</th><th>What it unlocks</th></tr></thead>
            <tbody>
              <tr><td><code>threads_basic</code></td><td>Required for every endpoint</td></tr>
              <tr><td><code>threads_content_publish</code></td><td>Creating and publishing posts</td></tr>
              <tr><td><code>threads_manage_replies</code></td><td>POST calls to reply endpoints</td></tr>
              <tr><td><code>threads_read_replies</code></td><td>GET calls to reply endpoints</td></tr>
              <tr><td><code>threads_manage_insights</code></td><td>Insights endpoints</td></tr>
              <tr><td><code>threads_delete</code></td><td>Deleting posts</td></tr>
            </tbody>
          </table>
          <p>
            Until your app passes App Review for a permission and is published, only Threads
            testers you invite under App roles can grant it. For
            <code>threads_content_publish</code> that means you can post only for those testers
            (<a href="${meta}/posts">posts</a>). Plan for review time before launch.
          </p>

          <h2 id="tokens">Tokens and how long they last</h2>
          <ol>
            <li>
              The Authorization Window redirects back with an authorization code, valid for one
              hour. Exchange it for a short-lived user token, also valid for one hour.
            </li>
            <li>
              On your server, exchange the short-lived token for a long-lived one with
              <code>GET /access_token?grant_type=th_exchange_token</code> and your Threads app
              secret. Long-lived tokens last 60 days.
            </li>
            <li>
              Refresh a long-lived token with
              <code>GET /refresh_access_token?grant_type=th_refresh_token</code> once it is at
              least 24 hours old and before it expires. A token not refreshed within 60 days
              can't be refreshed again
              (<a href="${meta}/get-started/long-lived-tokens">long-lived tokens</a>).
            </li>
          </ol>
          <p>
            Permission grants are a separate clock. A grant lasts 90 days. Refreshing the token
            extends it for users with public profiles; users with private profiles have to grant
            the permission again (<a href="${meta}/get-started">get started</a>). Keep the app
            secret and every token on the server.
          </p>

          <h2 id="publish">How publishing works</h2>
          <p>
            A post is two calls. First create a media container with
            <code>POST /{threads-user-id}/threads</code>, setting <code>media_type</code> to
            <code>TEXT</code>, <code>IMAGE</code>, or <code>VIDEO</code>. Images and videos are
            passed as public URLs (<code>image_url</code>, <code>video_url</code>), because Meta
            downloads the media itself.
          </p>
          ${code(createContainer)}
          <p>
            Meta recommends waiting about 30 seconds before publishing so it can process the
            media. Rather than sleeping blindly, read the container's status. It moves from
            <code>IN_PROGRESS</code> to <code>FINISHED</code>, or to <code>ERROR</code> with an
            <code>error_message</code> such as <code>FAILED_DOWNLOADING_VIDEO</code>. A container
            not published within 24 hours becomes <code>EXPIRED</code>. Meta suggests checking
            once a minute for at most five minutes
            (<a href="${meta}/troubleshooting">troubleshooting</a>).
          </p>
          ${code(checkContainer)}
          <p>Then publish the finished container:</p>
          ${code(publishContainer)}
          <p>
            Carousels add a step: create one container per item with
            <code>is_carousel_item=true</code>, then a <code>CAROUSEL</code> container listing
            them in <code>children</code>, then publish that. A carousel holds 2 to 20 images or
            videos and counts as one post.
          </p>
          <p>
            One trap: if <code>threads_publish</code> fails or times out, the post may still have
            gone out. Check the container status before retrying. A status of
            <code>PUBLISHED</code> means it did, and creating a new container to try again would
            post twice.
          </p>

          <h2 id="limits">Rate limits and media limits</h2>
          <p>
            Publishing limits apply per Threads profile over a moving 24-hour window
            (<a href="${meta}/overview">overview</a>):
          </p>
          <table>
            <thead><tr><th>Limit</th><th>Value</th></tr></thead>
            <tbody>
              <tr><td>Posts published through the API</td><td>250 per 24 hours (a carousel counts as one)</td></tr>
              <tr><td>Replies</td><td>1,000 per 24 hours</td></tr>
              <tr><td>Deletions</td><td>100 per 24 hours</td></tr>
              <tr><td>Location searches</td><td>500 per 24 hours</td></tr>
              <tr><td>API calls per app and user</td><td>4,800 × the account's impressions in the last 24 hours, counting at least 10 impressions</td></tr>
              <tr><td>Text</td><td>500 characters, with emojis counted by their UTF-8 bytes</td></tr>
              <tr><td>Images</td><td>JPEG or PNG, up to 8 MB; Meta rescales widths outside 320 to 1440 pixels</td></tr>
              <tr><td>Video</td><td>MOV or MP4, up to 5 minutes and 1 GB, 23 to 60 fps</td></tr>
            </tbody>
          </table>
          <p>
            <code>threads_publish</code> enforces the post limit, so a scheduler that queues more
            than 250 posts for one profile will see failures. Read the live usage before a batch
            with <code>threads_publishing_limit</code>; add <code>reply_quota_usage</code> or
            <code>delete_quota_usage</code> to the fields for the other quotas. Meta can also
            limit an app by the total CPU time its calls use per day, which scales with
            impressions the same way.
          </p>
          ${code(checkQuota)}

          <h2 id="social-sdk">Posting to Threads from TypeScript with Social SDK</h2>
          <p>
            <a href="/">Social SDK</a> is an open-source TypeScript library that wraps this flow.
            Its Threads adapter creates the container, checks its status, and publishes it in one
            <code>posts.publish</code> call. It doesn't sleep while Meta processes media: you get
            back <code>published</code> with the post ID, or <code>processing</code> to check again
            later. If a publish call's result can't be confirmed, the outcome is
            <code>unknown</code> and the adapter doesn't replay it, which avoids the double post
            described above.
          </p>
          <pre><code>npm install @opencoredev/social-sdk</code></pre>
          ${code(sdkExample)}
          <p>
            We type-checked this example against <code>@opencoredev/social-sdk</code> 0.5.0 from npm
            and ran it on ${fetched} with a stub <code>fetch</code> standing in for Meta. It made
            the three calls above in order and printed the new post ID. It runs on Node.js 22.12
            or later and Bun. The token comes from your own OAuth flow; the
            <a href="/docs/authentication">authentication guide</a> covers the SDK's
            <code>threadsOAuth</code> and token refresh helpers.
          </p>
          <p>
            Images, videos, carousels, reply controls, and the persistent store that lets a
            <code>processing</code> post resume after a restart are on the
            <a href="/docs/platforms/threads">Threads platform page</a>. To build without a Meta
            app at all, start with the <a href="/docs/getting-started/mock-quickstart">mock quickstart</a>.
            The same client can also post to X, Bluesky, and the other
            <a href="/docs/platforms">supported platforms</a> in the same call.
          </p>

          <h2 id="faq">Common questions</h2>
          <dl class="faq">
            <dt>Is there an official Threads API?</dt>
            <dd>Yes. Meta has run it since June 2024, and it is documented at developers.facebook.com/docs/threads.</dd>
            <dt>Can I schedule Threads posts through the API?</dt>
            <dd>
              Not directly. <code>threads_publish</code> takes only the container ID and publishes
              when you call it, and Meta's overview tells apps that schedule posts to enforce the
              publishing limit themselves. Schedule in your own job runner and publish at the
              chosen time, keeping the 250-post limit in mind.
            </dd>
            <dt>Why does my container stay IN_PROGRESS?</dt>
            <dd>
              Meta is still processing the media. Keep checking the status once a minute for up to
              five minutes. <code>ERROR</code> carries an <code>error_message</code> that names the
              problem, such as an invalid frame rate or a URL Meta couldn't download.
            </dd>
            <dt>Can I post for any Threads user while my app is in development?</dt>
            <dd>No. Only invited Threads testers can grant permissions until the app passes App Review and is published.</dd>
          </dl>

          <h2 id="sources">Sources</h2>
          <p>Meta's pages, read on ${fetched}, with the update date each page showed:</p>
          <ul>
            <li><a href="${meta}/overview">Threads API overview</a> (updated 22 December 2025): purpose, hosts, rate limits, media specifications</li>
            <li><a href="${meta}/posts">Threads posts</a> (updated 13 October 2026): permissions, containers, publishing, carousels</li>
            <li><a href="${meta}/get-started">Get started</a> (updated 30 June 2026): app setup, permissions, testers, grants</li>
            <li><a href="${meta}/get-started/long-lived-tokens">Long-lived access tokens</a> (updated 27 March 2025)</li>
            <li><a href="${meta}/troubleshooting">Troubleshooting</a> (updated 14 July 2025): container statuses and quota checks</li>
          </ul>`,
};
