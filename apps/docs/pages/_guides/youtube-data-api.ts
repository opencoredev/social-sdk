// The YouTube Data API guide. Facts cite Google's own YouTube Data API pages,
// read on the date below; every page showed "Last updated 2026-11-03". No
// prices. Both examples type-check against the published npm package and were
// run against a stubbed fetch.
import { escapeHtml } from "../_blog/render";
import type { Guide } from "./guides";

const fetched = "9 November 2026";

const yt = "https://developers.google.com/youtube/v3";

const overview = `${yt}/getting-started`;

const quotaCost = `${yt}/determine_quota_cost`;

const authorization = `${yt}/guides/authentication`;

const pagination = `${yt}/guides/implementation/pagination`;

const errors = `${yt}/docs/errors`;

const searchList = `${yt}/docs/search/list`;

const channelsList = `${yt}/docs/channels/list`;

const commentThreadsList = `${yt}/docs/commentThreads/list`;

const revisionHistory = `${yt}/revision_history`;

const quotaForm = "https://support.google.com/youtube/contact/yt_api_form";

const firstRequest =
  'curl "https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=VIDEO_ID&fields=items(id,snippet/title,statistics/viewCount)&key=YOUR_API_KEY"\n# 200 OK\n# {"items": [{"id": "VIDEO_ID", "snippet": {"title": "..."}, "statistics": {"viewCount": "..."}}]}';

const fetchExample =
  '// Public data only: an API key is enough. Restrict the key in the Cloud console.\nconst apiKey = process.env["YOUTUBE_API_KEY"];\nif (!apiKey) throw new Error("Set YOUTUBE_API_KEY");\n\ntype VideoStats = { id: string; title: string; views: string | undefined };\n\nfunction isRecord(value: unknown): value is Record<string, unknown> {\n  return typeof value === "object" && value !== null;\n}\n\nfunction errorReason(body: unknown): string {\n  if (!isRecord(body) || !isRecord(body["error"])) return "unknown";\n  const errors = body["error"]["errors"];\n  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;\n  return isRecord(first) && typeof first["reason"] === "string" ? first["reason"] : "unknown";\n}\n\nexport async function videoStats({ apiKey, ids }: { apiKey: string; ids: readonly string[] }): Promise<VideoStats[]> {\n  const url = new URL("https://www.googleapis.com/youtube/v3/videos");\n  url.searchParams.set("part", "snippet,statistics"); // videos.list: 1 unit per call\n  url.searchParams.set("id", ids.join(","));\n  url.searchParams.set("fields", "items(id,snippet/title,statistics/viewCount)");\n  url.searchParams.set("key", apiKey);\n\n  const response = await fetch(url);\n  const body: unknown = await response.json().catch(() => undefined);\n  // quotaExceeded (403) lasts until midnight Pacific Time; don\'t retry it.\n  if (!response.ok) throw new Error(`videos.list failed: ${response.status} ${errorReason(body)}`);\n\n  const items = isRecord(body) && Array.isArray(body["items"]) ? body["items"] : [];\n  return items.flatMap((item: unknown) => {\n    if (!isRecord(item) || typeof item["id"] !== "string" || !isRecord(item["snippet"])) return [];\n    const title = item["snippet"]["title"];\n    const stats = item["statistics"];\n    const views = isRecord(stats) && typeof stats["viewCount"] === "string" ? stats["viewCount"] : undefined;\n    return typeof title === "string" ? [{ id: item["id"], title, views }] : [];\n  });\n}\n\nconsole.log(await videoStats({ apiKey, ids: ["dQw4w9WgXcQ"] }));';

const sdkExample =
  'import { createSocial } from "@opencoredev/social-sdk";\nimport { youtube } from "@opencoredev/social-sdk/youtube";\n\nconst accessToken = process.env["YOUTUBE_ACCESS_TOKEN"]; // OAuth token with the youtube.readonly scope\nconst channelId = process.env["YOUTUBE_CHANNEL_ID"];\nif (!accessToken || !channelId) throw new Error("Set YOUTUBE_ACCESS_TOKEN and YOUTUBE_CHANNEL_ID");\n\nconst social = createSocial({ backend: youtube({ auth: { accessToken, channelId } }) });\n\n// Native calls bypass client middleware: check your own user\'s access to this channel first.\nconst native = social.native("default", { acknowledgeUnsafe: true });\nif (!native) throw new Error("YouTube native operations are unavailable");\n\nconst context = () => ({\n  backendInstance: "default",\n  correlationId: crypto.randomUUID(),\n  retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 },\n});\n\n// search.list: 1 call from the 100-a-day search bucket.\nconst recent = await native.search({ q: "release notes", channelId, type: "video", order: "date", maxResults: 10, context: context() });\n\n// playlists.list: 1 unit from the shared 10,000-unit bucket.\nconst playlists = await native.playlists({ action: "list", mine: true, maxResults: 50, context: context() });\n\nconsole.log(JSON.stringify({ recent: recent["items"], playlists: playlists["items"] }, null, 2));';

const code = (source: string) => `<pre><code>${escapeHtml(source)}</code></pre>`;

export const youtubeDataApi: Guide = {
  slug: "youtube-data-api",
  title: "YouTube Data API v3: keys, OAuth, quota costs",
  description:
    "How the YouTube Data API v3 works: API keys vs OAuth scopes, the 10,000-unit daily quota and what each call costs, pagination, errors, and tested TypeScript.",
  summary:
    "The YouTube Data API v3 from the ground up: getting an API key, when you need OAuth, quota costs per method, parts and fields, pagination, common errors, the 2026 changes, and TypeScript examples.",
  heading: "The YouTube Data API, explained",
  lede: "The YouTube Data API v3 is Google's REST API for YouTube data: videos, channels, playlists, search, comments, captions, and subscriptions, all under <code>https://www.googleapis.com/youtube/v3/</code>. Reading public data needs only an API key from a Google Cloud project with the API enabled. Anything private to a user, and every insert, update, or delete, needs OAuth 2.0. Each project gets a default daily quota of 10,000 units for most methods, where a read usually costs 1 unit and a write 50, plus separate allowances of 100 <code>search.list</code> calls and 100 <code>videos.insert</code> calls.",
  published: "2026-11-09",
  updated: "2026-11-09",
  content: `
          <h2 id="what-it-covers">What the API covers</h2>
          <p>
            The API is organized around resources, and most resources support some of four
            operations: <code>list</code> (GET), <code>insert</code> (POST), <code>update</code>
            (PUT), and <code>delete</code> (DELETE) (<a href="${overview}">YouTube Data API
            overview</a>). The ones most apps use:
          </p>
          <table>
            <thead><tr><th>Resource</th><th>What it is</th></tr></thead>
            <tbody>
              <tr><td><code>videos</code></td><td>A video's metadata, statistics, and status; uploads go through <code>videos.insert</code></td></tr>
              <tr><td><code>channels</code></td><td>A channel's details; <code>forHandle</code> looks a channel up by its @handle</td></tr>
              <tr><td><code>search</code></td><td>Videos, channels, or playlists matching a query; results point to other resources</td></tr>
              <tr><td><code>playlists</code>, <code>playlistItems</code></td><td>Playlists and the videos in them</td></tr>
              <tr><td><code>commentThreads</code>, <code>comments</code></td><td>Top-level comments with their replies, and single comments</td></tr>
              <tr><td><code>captions</code>, <code>thumbnails</code></td><td>Caption tracks and custom thumbnails for a video</td></tr>
              <tr><td><code>subscriptions</code></td><td>A user's channel subscriptions</td></tr>
            </tbody>
          </table>
          <p>
            Every request that returns a resource must say which <code>part</code>s to return,
            such as <code>snippet</code>, <code>statistics</code>, or <code>status</code> for a
            video. The optional <code>fields</code> parameter trims the response further, down to
            single nested properties. Asking only for what you use keeps responses small.
          </p>

          <h2 id="api-key">How to get a YouTube API key</h2>
          <ol>
            <li>Create or select a project in the Google Cloud console.</li>
            <li>Open the API Library and enable <strong>YouTube Data API v3</strong>.</li>
            <li>On the Credentials page, choose <strong>Create credentials &gt; API key</strong>.</li>
            <li>Choose <strong>Restrict key</strong> and add application and API restrictions before you use it in production.</li>
          </ol>
          <p>
            The key identifies your project, and its requests count against that project's quota
            (<a href="${authorization}">implement authorization</a>). Keep it on your server: a key
            shipped in a web page or app can be copied and its quota spent by someone else.
          </p>

          <h2 id="key-or-oauth">API key or OAuth 2.0?</h2>
          <p>
            Google's rule is short. A request that doesn't carry an OAuth 2.0 token must send an
            API key, and a key can only retrieve public data. Inserts, updates, deletes, and reads
            of private data need OAuth 2.0 (<a href="${authorization}">implement
            authorization</a>).
          </p>
          <table>
            <thead><tr><th>You want to</th><th>Credential</th></tr></thead>
            <tbody>
              <tr><td>Read public videos, channels, playlists, search results, or comments</td><td>API key</td></tr>
              <tr><td>Read the signed-in user's own channel, e.g. <code>channels.list</code> with <code>mine=true</code></td><td>OAuth 2.0</td></tr>
              <tr><td>Upload, edit, or delete videos and playlists; post or moderate comments</td><td>OAuth 2.0</td></tr>
            </tbody>
          </table>
          <p>
            For OAuth, create an OAuth client ID on the same Credentials page, send the user to
            Google's consent screen with the scopes you need, and exchange the returned code for an
            access token and a refresh token. Send the access token as
            <code>Authorization: Bearer &lt;ACCESS_TOKEN&gt;</code>. The common YouTube scopes,
            all under <code>https://www.googleapis.com/auth/</code>, are
            <code>youtube.readonly</code> (view the account),
            <code>youtube.upload</code> (upload videos only),
            <code>youtube</code> (manage the account), and
            <code>youtube.force-ssl</code> (manage it, including comments and captions). Ask for
            the narrowest one that covers your calls; the
            <a href="/guides/youtube-upload-api">YouTube upload API guide</a> covers the upload
            scope, offline access, and the 7-day refresh-token limit for apps still in Testing.
          </p>

          <h2 id="quota">Quota: what each call costs</h2>
          <p>
            The API limits use with quota units, not request counts. By default a project gets
            100 <code>search.list</code> calls, 100 <code>videos.insert</code> calls, and 10,000
            units a day combined for every other method. Daily quotas reset at midnight Pacific
            Time, and every request costs at least 1 unit, including invalid ones
            (<a href="${quotaCost}">quota costs</a>). Common costs:
          </p>
          <table>
            <thead><tr><th>Call</th><th>Cost</th></tr></thead>
            <tbody>
              <tr><td><code>videos.list</code>, <code>channels.list</code>, <code>playlists.list</code>, <code>playlistItems.list</code>, <code>commentThreads.list</code>, <code>comments.list</code>, <code>subscriptions.list</code></td><td>1 unit</td></tr>
              <tr><td><code>search.list</code></td><td>1 call from its own bucket of 100 a day</td></tr>
              <tr><td><code>videos.insert</code></td><td>1 call from its own bucket of 100 a day</td></tr>
              <tr><td><code>videos.update</code>, <code>videos.rate</code>, <code>videos.delete</code>, <code>playlists.insert</code>, <code>playlistItems.insert</code>, <code>commentThreads.insert</code>, <code>comments.insert</code>, <code>thumbnails.set</code></td><td>50 units</td></tr>
              <tr><td><code>captions.list</code></td><td>50 units</td></tr>
              <tr><td><code>captions.insert</code>, <code>captions.update</code></td><td>400 and 450 units</td></tr>
            </tbody>
          </table>
          <p>
            Paging costs quota too: each extra page of results is a new request at the full cost.
            With 10,000 units you can make about 10,000 list calls a day, or about 200 writes at 50
            units each, but only 100 searches however much of the main bucket is left. When a
            playlist or a known set of video IDs can answer the question, read it with
            <code>playlistItems.list</code> or <code>videos.list</code> instead of searching. Your
            current usage is on the Quotas page in the Cloud console, and you can ask for more
            through the <a href="${quotaForm}">quota extension request form</a>.
          </p>

          <h2 id="first-request">Your first request</h2>
          <p>
            A <code>videos.list</code> call with an API key, asking for two parts and trimming the
            response with <code>fields</code>. It costs 1 unit:
          </p>
          ${code(firstRequest)}
          <p>
            Pass several video IDs, comma-separated, in <code>id</code> to read them in one call
            for the same 1 unit.
          </p>

          <h2 id="pagination">Pagination</h2>
          <p>
            List methods take <code>maxResults</code> and return <code>nextPageToken</code> (and
            sometimes <code>prevPageToken</code>) when there is more; send the token back as
            <code>pageToken</code> to get the next page (<a href="${pagination}">pagination</a>).
            The page size limit depends on the method: 0 to 50 with a default of 5 for
            <code>search.list</code> and <code>channels.list</code>
            (<a href="${searchList}">search.list</a>, <a href="${channelsList}">channels.list</a>),
            and 1 to 100 for <code>commentThreads.list</code>
            (<a href="${commentThreadsList}">commentThreads.list</a>). Set it explicitly, or you
            get 5 results and pay for a second page sooner than you need to.
          </p>

          <h2 id="typescript">Calling the API from TypeScript</h2>
          <p>
            You don't need a client library for reads. This function reads public video
            statistics with an API key and plain <code>fetch</code>, treats the response as
            untrusted, and reports the error reason without echoing the response body:
          </p>
          ${code(fetchExample)}
          <p>
            We type-checked this example with strict TypeScript and ran it on ${fetched} with
            Node.js 24 and Bun against a stub <code>fetch</code>: it returned the parsed item for a
            normal response, threw <code>videos.list failed: 403 quotaExceeded</code> for a quota
            error, threw <code>502 unknown</code> for an HTML error page, and skipped malformed
            items. Google's own <code>googleapis</code> package for Node.js covers every method if
            you'd rather use a generated client.
          </p>

          <h2 id="errors">Errors you'll see</h2>
          <p>
            Errors come back with an HTTP status and a reason in <code>error.errors[].reason</code>
            (<a href="${errors}">errors</a>):
          </p>
          <table>
            <thead><tr><th>Reason</th><th>What it means</th></tr></thead>
            <tbody>
              <tr><td><code>quotaExceeded</code> (403)</td><td>The project spent its quota for the day. Retrying won't help until midnight Pacific Time.</td></tr>
              <tr><td><code>forbidden</code> (403)</td><td>Access forbidden: the request may not be properly authorized. Check that the token has a scope that covers the call.</td></tr>
              <tr><td><code>commentsDisabled</code> (403)</td><td>From <code>commentThreads.list</code>: the video has comments turned off.</td></tr>
              <tr><td><code>channelNotFound</code> (403)</td><td>The channel in the request can't be found.</td></tr>
            </tbody>
          </table>

          <h2 id="changes-2026">What changed in 2026</h2>
          <p>Older tutorials miss these (<a href="${revisionHistory}">revision history</a>):</p>
          <ul>
            <li><strong>1 June:</strong> <code>search.list</code> and <code>videos.insert</code> moved to their own quota buckets, the start of a more granular quota system. Since 2014 a search had cost 100 units of the shared 10,000.</li>
            <li><strong>3 June:</strong> new <code>videos.batchGetStats</code> method for video statistics, with its own 10,000-unit daily bucket.</li>
            <li><strong>1 September:</strong> <code>videos.getRating</code> accepts the <code>youtube.readonly</code> scope.</li>
            <li><strong>14 September:</strong> custom thumbnails can be up to 50 MB, up from 2 MB.</li>
            <li><strong>2 November:</strong> videos uploaded with <code>videos.insert</code> from unverified API projects are no longer locked to private, reversing the 2020 policy.</li>
            <li><strong>3 November:</strong> <code>thumbnails.set</code> can set custom thumbnails for Shorts once processing is complete.</li>
          </ul>

          <h2 id="social-sdk">Calling the YouTube Data API with Social SDK</h2>
          <p>
            <a href="/">Social SDK</a> is an open-source TypeScript library for posting to and
            reading from social platforms. Its YouTube adapter takes an OAuth access token and a
            channel ID, and besides uploading through <code>posts.publish</code> it exposes the
            Data API's other calls as typed native operations: <code>search</code>,
            <code>playlists</code>, <code>playlistItems</code>, <code>captions</code>,
            <code>subscriptions</code>, <code>updateVideo</code>, <code>setThumbnail</code>,
            comment moderation, ratings, and live broadcasts. This example finds a channel's
            recent videos and lists the signed-in user's playlists:
          </p>
          <pre><code>npm install @opencoredev/social-sdk</code></pre>
          ${code(sdkExample)}
          <p>
            We type-checked this example against <code>@opencoredev/social-sdk</code> 0.5.0 from
            npm and ran it on ${fetched} with Node.js 24 and Bun against a stub
            <code>fetch</code>. It sent two requests, both with the bearer token:
            <code>GET /youtube/v3/search</code> with <code>part=snippet</code>,
            <code>type=video</code>, the channel ID, <code>order=date</code> and
            <code>maxResults=10</code>, then <code>GET /youtube/v3/playlists</code> with
            <code>mine=true</code> and <code>maxResults=50</code>. That run cost 1 search call and
            1 unit. The adapter doesn't take API keys or refresh tokens; the SDK's
            <code>youtubeOAuth</code> server helper handles Google's authorization code flow
            (<a href="/docs/authentication">authentication guide</a>). Native operations skip the
            client's middleware, so check in your own server that the user may act on that channel
            before you call one.
          </p>
          <p>
            Every native operation, with examples, is on the
            <a href="/docs/platforms/youtube">YouTube platform page</a>. Uploads, resumable
            sessions, and processing states are in the
            <a href="/guides/youtube-upload-api">YouTube upload API guide</a>. To build without a
            Google project, start with the
            <a href="/docs/getting-started/mock-quickstart">mock quickstart</a>, and the
            <a href="/guides/social-media-apis">social media APIs guide</a> compares YouTube with
            the other platforms.
          </p>

          <h2 id="faq">Common questions</h2>
          <dl class="faq">
            <dt>How many requests can I make with the YouTube Data API per day?</dt>
            <dd>
              By default, 10,000 quota units a day for most methods, plus 100
              <code>search.list</code> calls and 100 <code>videos.insert</code> calls in their own
              buckets. Most reads cost 1 unit and most writes 50, so the number of requests depends
              on which methods you call.
            </dd>
            <dt>Do I need OAuth to read public YouTube data?</dt>
            <dd>
              No. An API key is enough for public videos, channels, playlists, search results, and
              comments. You need OAuth 2.0 for private data and for anything that changes data.
            </dd>
            <dt>How do I get a channel ID from a handle?</dt>
            <dd>
              Call <code>channels.list</code> with <code>forHandle</code> set to the handle, with or
              without the @. The channel resource in the response has the <code>id</code>.
            </dd>
            <dt>When does the YouTube API quota reset?</dt>
            <dd>At midnight Pacific Time, every day.</dd>
            <dt>How much quota does a search cost?</dt>
            <dd>
              Since 1 June 2026, one call from <code>search.list</code>'s own bucket of 100 calls a
              day. It no longer comes out of the 10,000-unit bucket. Each extra page of results is
              another call.
            </dd>
            <dt>How do I get more YouTube API quota?</dt>
            <dd>
              Fill in Google's <a href="${quotaForm}">quota extension request form</a> for YouTube
              API Services. Check your current usage on the Quotas page in the Cloud console first.
            </dd>
          </dl>

          <h2 id="sources">Sources</h2>
          <p>Google's YouTube Data API pages, read on ${fetched}; each showed "Last updated 3 November 2026":</p>
          <ul>
            <li><a href="${overview}">YouTube Data API overview</a>: resources, operations, default quota, <code>part</code> and <code>fields</code></li>
            <li><a href="${authorization}">Implement authorization</a>: API keys vs OAuth 2.0, project setup, key restrictions</li>
            <li><a href="${quotaCost}">Quota costs</a>: per-method costs, buckets, reset time, paging cost</li>
            <li><a href="${pagination}">Pagination</a>: <code>maxResults</code>, <code>pageToken</code></li>
            <li><a href="${searchList}">search.list</a>, <a href="${channelsList}">channels.list</a>, <a href="${commentThreadsList}">commentThreads.list</a>: parameters and limits</li>
            <li><a href="${errors}">Errors</a>: core and per-method error reasons</li>
            <li><a href="${revisionHistory}">Revision history</a>: the 2026 changes listed above</li>
          </ul>`,
};
