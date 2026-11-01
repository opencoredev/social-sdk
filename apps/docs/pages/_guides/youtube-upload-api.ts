// The YouTube upload API guide. Facts about the YouTube Data API cite Google's
// own pages, with the date each was read and the "Last updated" date each page
// showed. No prices. The Social SDK example type-checks against the published
// npm package and was run against a stubbed fetch.
import { escapeHtml } from "../_blog/render";
import type { Guide } from "./guides";

const fetched = "1 November 2026";

const yt = "https://developers.google.com/youtube/v3";

const videosInsert = `${yt}/docs/videos/insert`;

const videosResource = `${yt}/docs/videos`;

const quotaCost = `${yt}/determine_quota_cost`;

const resumable = `${yt}/guides/using_resumable_upload_protocol`;

const uploadGuide = `${yt}/guides/uploading_a_video`;

const revisionHistory = `${yt}/revision_history`;

const serverSideAuth = `${yt}/guides/auth/server-side-web-apps`;

const ytAuth = `${yt}/guides/authentication`;

const oauth = "https://developers.google.com/identity/protocols/oauth2";

const startSession = `curl -i -X POST \\
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status" \\
  -H "Authorization: Bearer <ACCESS_TOKEN>" \\
  -H "Content-Type: application/json; charset=UTF-8" \\
  -H "X-Upload-Content-Length: 20000000" \\
  -H "X-Upload-Content-Type: video/mp4" \\
  --data '{
    "snippet": { "title": "Release notes", "description": "What changed this week." },
    "status": { "privacyStatus": "private", "selfDeclaredMadeForKids": false }
  }'
# HTTP 200. The Location header holds the session URI:
# Location: https://www.googleapis.com/upload/youtube/v3/videos?...&upload_id=...`;

const sendFile = `curl -i -X PUT "<SESSION_URI>" \\
  -H "Authorization: Bearer <ACCESS_TOKEN>" \\
  -H "Content-Type: video/mp4" \\
  --data-binary @video.mp4
# HTTP 201. The body is the new video resource:
# {"id": "...", "status": {"uploadStatus": "uploaded", ...}}`;

const checkStatus = `curl -i -X PUT "<SESSION_URI>" \\
  -H "Authorization: Bearer <ACCESS_TOKEN>" \\
  -H "Content-Length: 0" \\
  -H "Content-Range: bytes */20000000"
# HTTP 308 Resume Incomplete
# Range: bytes=0-8388607
# The first 8,388,608 bytes arrived, so resume at byte 8388608.`;

const resume = `curl -i -X PUT "<SESSION_URI>" \\
  -H "Authorization: Bearer <ACCESS_TOKEN>" \\
  -H "Content-Range: bytes 8388608-19999999/20000000" \\
  --data-binary @rest-of-video.bin`;

const sdkExample = `import { readFile, writeFile } from "node:fs/promises";
import { createSocial, connectedAccountRef } from "@opencoredev/social-sdk";
import { youtube } from "@opencoredev/social-sdk/youtube";

const accessToken = process.env["YOUTUBE_ACCESS_TOKEN"]; // OAuth token with the youtube.upload scope
const channelId = process.env["YOUTUBE_CHANNEL_ID"];
if (!accessToken || !channelId) throw new Error("Set YOUTUBE_ACCESS_TOKEN and YOUTUBE_CHANNEL_ID");

const social = createSocial({
  backend: youtube({
    auth: { accessToken, channelId },
    // The resumable session URL is a secret. Save it before any bytes are sent,
    // so an interrupted upload can be resumed instead of creating a second video.
    saveUploadSession: async (session) => {
      await writeFile("./upload-session.json", JSON.stringify(session), { mode: 0o600 });
    },
  }),
});
const account = connectedAccountRef({ backend: "default", platform: "youtube", accountId: channelId });

const video = new Blob([await readFile("./video.mp4")], { type: "video/mp4" });

const result = await social.posts.publish({
  targets: [{ account, options: { title: "Release notes", visibility: "private", madeForKids: false } }],
  content: {
    text: "What changed this week.",
    media: [
      {
        kind: "video",
        source: { kind: "blob", blob: video, fingerprint: "release-notes-v1" },
        mimeType: "video/mp4",
        byteSize: video.size,
      },
    ],
  },
});

for (const outcome of result.outcomes) {
  if (outcome.state === "published") console.log("published", outcome.url);
  else if (outcome.state === "processing") console.log("uploaded, YouTube is still processing it");
  else console.log(outcome.state, outcome);
}`;

const code = (source: string) => `<pre><code>${escapeHtml(source)}</code></pre>`;

export const youtubeUploadApi: Guide = {
  slug: "youtube-upload-api",
  title: "YouTube Upload API: quota, resumable uploads",
  description:
    "How to upload videos with the YouTube Data API: videos.insert, the youtube.upload scope, resumable uploads, the 100-uploads-a-day quota, and tested TypeScript.",
  summary:
    "Uploading videos through the YouTube Data API: the videos.insert call, OAuth scopes, the resumable protocol step by step, the separate upload quota, processing states, and a TypeScript example.",
  heading: "The YouTube upload API, explained",
  lede: "To upload a video from code, send a <code>POST</code> to <code>/upload/youtube/v3/videos</code> on <code>www.googleapis.com</code> (the YouTube Data API's <code>videos.insert</code> method) with an OAuth access token that has the <code>youtube.upload</code> scope. Use the resumable protocol: one request sends the video's metadata and returns a session URI, and the file goes to that URI in one or more <code>PUT</code> requests. Since June 2026 uploads have their own quota bucket: a project gets 100 <code>videos.insert</code> calls a day by default, and each costs 1 unit.",
  published: "2026-11-01",
  updated: "2026-11-01",
  content: `
          <h2 id="videos-insert">What videos.insert does</h2>
          <p>
            <code>videos.insert</code> is the only Data API method that creates a video. It
            uploads the file and sets the video's metadata in the same operation
            (<a href="${videosInsert}">Videos: insert</a>). The file can be up to 256 GB, with a
            MIME type of <code>video/*</code> or <code>application/octet-stream</code>. The
            request body is a video resource, and these are the fields you can set at upload
            time:
          </p>
          <table>
            <thead><tr><th>Part</th><th>Writable fields</th></tr></thead>
            <tbody>
              <tr><td><code>snippet</code></td><td><code>title</code>, <code>description</code>, <code>tags[]</code>, <code>categoryId</code>, <code>defaultLanguage</code></td></tr>
              <tr><td><code>status</code></td><td><code>privacyStatus</code>, <code>publishAt</code>, <code>selfDeclaredMadeForKids</code>, <code>containsSyntheticMedia</code>, <code>embeddable</code>, <code>license</code>, <code>publicStatsViewable</code></td></tr>
              <tr><td>Other</td><td><code>localizations</code>, <code>recordingDetails.recordingDate</code></td></tr>
            </tbody>
          </table>
          <p>
            The <code>part</code> query parameter names the parts you set, and the same parts
            come back in the response. <code>notifySubscribers</code> defaults to
            <code>true</code>; set it to <code>false</code> when a channel uploads many videos at
            once. There is no Shorts flag: the request is the same for any video.
          </p>
          <p>
            If you leave out <code>privacyStatus</code>, the video is public, although some
            channel settings make uploads private by default. To schedule a release, upload with
            <code>privacyStatus</code> set to <code>private</code> and an ISO 8601
            <code>publishAt</code> time, and YouTube makes the video public at that time.
          </p>

          <h2 id="auth">OAuth scopes and tokens</h2>
          <p>
            Uploads act on a channel, so they need the channel owner's OAuth 2.0 authorization.
            An API key isn't enough, and the Data API supports service accounts only for YouTube
            content owners who manage many channels (<a href="${ytAuth}">authentication</a>).
            <code>videos.insert</code> accepts any of these scopes:
          </p>
          <table>
            <thead><tr><th>Scope</th><th>What else it allows</th></tr></thead>
            <tbody>
              <tr><td><code>youtube.upload</code></td><td>Nothing else: upload only. Ask for this one if uploading is all you do.</td></tr>
              <tr><td><code>youtube</code></td><td>Full management of the channel</td></tr>
              <tr><td><code>youtube.force-ssl</code></td><td>Full management, including comments and captions</td></tr>
              <tr><td><code>youtubepartner</code></td><td>YouTube content partner (CMS) access</td></tr>
            </tbody>
          </table>
          <p>
            All four live under <code>https://www.googleapis.com/auth/</code>. A server that
            uploads later, without the user present, should request offline access to get a
            refresh token (<a href="${serverSideAuth}">OAuth 2.0 for web server apps</a>). One
            catch while you build: an OAuth app with an external user type and a publishing status
            of "Testing" gets refresh tokens that expire after 7 days
            (<a href="${oauth}">Using OAuth 2.0</a>), so expect to reconnect test channels weekly
            until the app is published.
          </p>

          <h2 id="quota">The upload quota</h2>
          <p>
            On 1 June 2026 Google moved <code>videos.insert</code> and <code>search.list</code>
            to their own quota buckets (<a href="${revisionHistory}">revision history</a>). These
            are a project's default daily allowances (<a href="${quotaCost}">quota costs</a>):
          </p>
          <table>
            <thead><tr><th>Bucket</th><th>Default per day</th></tr></thead>
            <tbody>
              <tr><td><code>videos.insert</code></td><td>100 calls, 1 unit each</td></tr>
              <tr><td><code>search.list</code></td><td>100 calls, 1 unit each</td></tr>
              <tr><td>Every other method</td><td>10,000 units combined</td></tr>
              <tr><td><code>videos.batchGetStats</code></td><td>10,000 units in its own bucket (added 3 June 2026)</td></tr>
            </tbody>
          </table>
          <p>
            Quotas reset at midnight Pacific Time, and every request counts, including invalid
            ones. Calls around an upload still come out of the shared 10,000 units:
            <code>videos.list</code> costs 1, <code>videos.update</code> 50, and
            <code>thumbnails.set</code> 50. Many tutorials still say an upload costs about 1,600
            units. Google cut that to about 100 units in December 2025 and to 1 call in its own
            bucket in June 2026. To go past 100 uploads a day, request more through the Quota
            Extension Form, which Google pairs with an API compliance audit.
          </p>
          <p>
            A note on private uploads: in 2020 Google said videos uploaded through
            <code>videos.insert</code> from unverified API projects created after 28 July 2020
            would be locked to private until the project passed an audit
            (<a href="${revisionHistory}">revision history</a>). The current
            <code>videos.insert</code> reference, last updated 15 October 2026, says videos from
            unverified projects are not restricted to private viewing mode. If your public
            uploads come out private, check the project's audit status and the channel's default
            upload settings.
          </p>

          <h2 id="resumable">Resumable uploads, step by step</h2>
          <p>
            Google's resumable protocol lets an upload continue after a dropped connection
            instead of starting over (<a href="${resumable}">resumable uploads</a>). Google's
            client libraries, such as <code>googleapis</code> for Node.js, handle it for you; the
            raw HTTP looks like this.
          </p>
          <p>
            <strong>1. Start a session.</strong> <code>POST</code> the video resource with
            <code>uploadType=resumable</code>, the file's size in
            <code>X-Upload-Content-Length</code>, and its type in
            <code>X-Upload-Content-Type</code>. A <code>200</code> response carries the session
            URI in its <code>Location</code> header.
          </p>
          ${code(startSession)}
          <p>
            <strong>2. Send the file.</strong> <code>PUT</code> the bytes to the session URI. A
            <code>201</code> means the upload finished, and the body is the new video resource with
            its ID.
          </p>
          ${code(sendFile)}
          <p>
            <strong>3. If the connection drops, ask where it stopped.</strong> Send an empty
            <code>PUT</code> with <code>Content-Range: bytes */TOTAL</code>. A <code>308 Resume
            Incomplete</code> response's <code>Range</code> header shows the bytes YouTube has,
            counted from 0. No <code>Range</code> header means nothing arrived yet. If the upload
            already finished, you get the original final response again.
          </p>
          ${code(checkStatus)}
          <p>
            <strong>4. Resume from the next byte.</strong> The first byte you send must be exactly
            one past the end of that range. Overlapping or skipping bytes uploads nothing.
          </p>
          ${code(resume)}
          <p>
            Resume after a lost connection or a <code>500</code>, <code>502</code>,
            <code>503</code>, or <code>504</code>, with exponential backoff, and honor
            <code>Retry-After</code> if the response has one. Other <code>4xx</code> and
            <code>5xx</code> codes are permanent failures. Session URIs expire: an expired one
            returns <code>404</code>, and you have to start a new session and upload from the
            beginning. If you send the file in chunks, every chunk except the last must be a
            multiple of 256 KB and the same size. Google calls chunking rarely necessary, though
            it does let you show progress and limits how much a dropped request costs you.
          </p>
          <p>
            Treat the session URI as a secret and save it before sending bytes. A process that
            crashes mid-upload and starts a fresh session instead of resuming creates a second
            video and spends a second call from the 100-a-day bucket.
          </p>

          <h2 id="processing">After the upload: processing</h2>
          <p>
            A <code>201</code> means YouTube has the file, not that viewers can watch it. Read
            <code>status.uploadStatus</code> on the video resource
            (<a href="${videosResource}">Videos resource</a>): <code>uploaded</code> while it
            processes, then <code>processed</code>, or <code>failed</code> or
            <code>rejected</code> with a <code>failureReason</code> or
            <code>rejectionReason</code> (a codec problem, a duplicate, a claim, and so on). Ask
            for the <code>processingDetails</code> part to see processing progress. Polling with
            <code>videos.list</code> costs 1 unit from the shared bucket per call, so space the
            polls out.
          </p>

          <h2 id="social-sdk">Uploading to YouTube from TypeScript with Social SDK</h2>
          <p>
            <a href="/">Social SDK</a> is an open-source TypeScript library whose YouTube adapter
            runs the resumable protocol above inside one <code>posts.publish</code> call. You pass
            the video, a title, a visibility, and the made-for-kids declaration (the adapter
            requires both explicitly). It starts the session, hands the session to your
            <code>saveUploadSession</code> callback before sending any bytes, uploads in 8 MiB
            chunks, and maps the video's <code>uploadStatus</code> to a typed outcome:
            <code>processing</code> for <code>uploaded</code>, <code>published</code> with the
            watch URL for <code>processed</code>, and <code>failed</code> for
            <code>failed</code> or <code>rejected</code>. An upload that stops partway comes back
            as <code>unknown</code>, so you can query the saved session and resume rather than
            start a second video.
          </p>
          <pre><code>npm install @opencoredev/social-sdk</code></pre>
          ${code(sdkExample)}
          <p>
            We type-checked this example against <code>@opencoredev/social-sdk</code> 0.5.0 from
            npm and ran it on ${fetched} with Node.js 24 and Bun, using a stub <code>fetch</code>
            in place of Google and a 20 MB test file. It sent one <code>POST</code> with
            <code>uploadType=resumable</code>, a <code>private</code> status and
            <code>selfDeclaredMadeForKids: false</code>, saved the session file with mode
            <code>0600</code> before any bytes went out, then sent three <code>PUT</code> chunks.
            It printed the processing line when the stub answered <code>uploaded</code> and the
            watch URL when it answered <code>processed</code>. In 0.5.0 the adapter reads the
            video from a <code>Blob</code> or a replayable stream (it doesn't fetch remote URLs),
            caps titles at 100 characters and descriptions at 5,000 UTF-8 bytes, rejects
            <code>&lt;</code> and <code>&gt;</code> in titles, and doesn't set tags or a category.
            Add a <code>schedule</code> to the target and it uploads the video private with that
            <code>publishAt</code> time.
          </p>
          <p>
            The adapter takes an existing access token and doesn't refresh it. The SDK's
            <code>youtubeOAuth</code> server helper handles Google's authorization code flow and
            channel discovery (<a href="/docs/authentication">authentication guide</a>).
            Resuming a saved session, thumbnails, captions, playlists, comments, and analytics are
            on the <a href="/docs/platforms/youtube">YouTube platform page</a>. To build without a
            Google project at all, start with the
            <a href="/docs/getting-started/mock-quickstart">mock quickstart</a>. The same client
            can post to X, Bluesky, LinkedIn, and the other
            <a href="/docs/platforms">supported platforms</a> in one call.
          </p>

          <h2 id="faq">Common questions</h2>
          <dl class="faq">
            <dt>How many videos can I upload a day with the YouTube API?</dt>
            <dd>
              100 by default. Since June 2026 <code>videos.insert</code> has its own quota bucket
              of 100 calls a day, each costing 1 unit. You can request more through Google's Quota
              Extension Form.
            </dd>
            <dt>Does a video upload still cost 1,600 quota units?</dt>
            <dd>
              No. Google cut it to about 100 units in December 2025, then moved uploads to their
              own bucket in June 2026, where each upload costs 1 unit of a 100-a-day allowance.
            </dd>
            <dt>Can I upload with an API key or a service account?</dt>
            <dd>
              Not for an ordinary channel. Uploading needs the channel owner's OAuth 2.0
              authorization, ideally with only the <code>youtube.upload</code> scope. Service
              accounts work only for YouTube content owners who manage many channels.
            </dd>
            <dt>How do I upload a YouTube Short with the API?</dt>
            <dd>
              With the same <code>videos.insert</code> call. The request has no Shorts field, so
              a Short goes up like any other video.
            </dd>
            <dt>Can I upload a video from a URL?</dt>
            <dd>
              Not directly. The API takes the file's bytes, so your server downloads the video
              first and then uploads it.
            </dd>
            <dt>Can I schedule a YouTube video through the API?</dt>
            <dd>
              Yes. Upload it with <code>privacyStatus</code> set to <code>private</code> and a
              future <code>publishAt</code> time.
            </dd>
          </dl>

          <h2 id="sources">Sources</h2>
          <p>Google's YouTube Data API and identity pages, read on ${fetched}, with the update date each page showed:</p>
          <ul>
            <li><a href="${videosInsert}">Videos: insert</a> (updated 15 October 2026): endpoint, file limits, scopes, writable fields, quota, default privacy</li>
            <li><a href="${quotaCost}">Quota costs</a> (updated 15 October 2026): default allocations, reset time, per-method costs</li>
            <li><a href="${resumable}">Resumable uploads</a> (updated 15 October 2026): session, status check, resume, chunk rules</li>
            <li><a href="${uploadGuide}">Upload a video</a> (updated 15 October 2026): <code>youtube.upload</code> scope, client library sample</li>
            <li><a href="${videosResource}">Videos resource</a> (updated 15 October 2026): <code>uploadStatus</code>, <code>processingDetails</code></li>
            <li><a href="${revisionHistory}">Revision history</a> (updated 15 October 2026): granular quota (1 June 2026), videos.batchGetStats bucket (3 June 2026), upload cost change (4 December 2025), 2020 private-upload note</li>
            <li><a href="${serverSideAuth}">OAuth 2.0 for web server apps</a> (updated 30 October 2026): offline access</li>
            <li><a href="${ytAuth}">Implementing OAuth 2.0 authorization</a> (updated 15 October 2026): service accounts only for content owners</li>
            <li><a href="${oauth}">Using OAuth 2.0 to access Google APIs</a> (updated 29 October 2026): 7-day refresh tokens in Testing</li>
          </ul>`,
};
