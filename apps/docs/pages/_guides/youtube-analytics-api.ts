// The YouTube Analytics API guide. Facts cite Google's own YouTube Analytics
// and Reporting API pages, read on the date below, each with its "Last updated"
// date in Sources. No prices. Both examples type-check against the published
// npm package and were run against a stubbed fetch.
import { escapeHtml } from "../_blog/render";
import type { Guide } from "./guides";

const fetched = "10 November 2026";

const yt = "https://developers.google.com/youtube";

const overview = `${yt}/analytics`;

const query = `${yt}/analytics/reference/reports/query`;

const channelReports = `${yt}/analytics/channel_reports`;

const metricsDoc = `${yt}/analytics/metrics`;

const dimensionsDoc = `${yt}/analytics/dimensions`;

const dataModel = `${yt}/analytics/data_model`;

const reporting = `${yt}/reporting`;

const revisionHistory = `${yt}/analytics/revision_history`;

const firstRequest =
  'curl -H "Authorization: Bearer $ACCESS_TOKEN" \\\n  "https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=2026-10-01&endDate=2026-10-31&metrics=views,estimatedMinutesWatched&dimensions=day&sort=day"\n# 200 OK\n# {"kind": "youtubeAnalytics#resultTable",\n#  "columnHeaders": [{"name": "day", "columnType": "DIMENSION", "dataType": "STRING"},\n#                    {"name": "views", "columnType": "METRIC", "dataType": "INTEGER"}, ...],\n#  "rows": [["2026-10-01", 120, 340], ["2026-10-02", 80, 200], ...]}';

const fetchExample =
  '// Channel analytics need an OAuth token for the channel\'s owner, with the\n// yt-analytics.readonly and youtube.readonly scopes. API keys don\'t work here.\nconst accessToken = process.env["YOUTUBE_ACCESS_TOKEN"];\nif (!accessToken) throw new Error("Set YOUTUBE_ACCESS_TOKEN");\n\ntype DailyViews = { day: string; views: number; minutesWatched: number };\n\nconst knownReasons = new Set(["forbidden", "insufficientPermissions", "badRequest", "quotaExceeded", "invalid"]);\n\nfunction isRecord(value: unknown): value is Record<string, unknown> {\n  return typeof value === "object" && value !== null;\n}\n\n// Report only reasons we recognize, so nothing else from the response reaches logs.\nfunction errorReason(body: unknown): string {\n  if (!isRecord(body) || !isRecord(body["error"])) return "unknown";\n  const errors = body["error"]["errors"];\n  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;\n  const reason = isRecord(first) ? first["reason"] : undefined;\n  return typeof reason === "string" && knownReasons.has(reason) ? reason : "unknown";\n}\n\nexport async function dailyViews({ token, startDate, endDate }: { token: string; startDate: string; endDate: string }): Promise<DailyViews[]> {\n  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");\n  url.searchParams.set("ids", "channel==MINE");\n  url.searchParams.set("startDate", startDate);\n  url.searchParams.set("endDate", endDate);\n  url.searchParams.set("metrics", "views,estimatedMinutesWatched");\n  url.searchParams.set("dimensions", "day");\n  url.searchParams.set("sort", "day");\n\n  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });\n  const body: unknown = await response.json().catch(() => undefined);\n  if (!response.ok) throw new Error(`reports.query failed: ${response.status} ${errorReason(body)}`);\n  if (!isRecord(body) || !Array.isArray(body["columnHeaders"])) throw new Error("reports.query returned an unexpected response");\n\n  // Find columns by name from the header row; never assume their order.\n  const names = body["columnHeaders"].map((header: unknown) => (isRecord(header) ? header["name"] : undefined));\n  const day = names.indexOf("day");\n  const views = names.indexOf("views");\n  const minutes = names.indexOf("estimatedMinutesWatched");\n  if (day < 0 || views < 0 || minutes < 0) throw new Error("reports.query returned unexpected columns");\n\n  // No rows at all means no data for the period, not an error.\n  const rows: unknown = body["rows"] === undefined ? [] : body["rows"];\n  if (!Array.isArray(rows)) throw new Error("reports.query returned unexpected rows");\n  return rows.flatMap((row: unknown) => {\n    if (!Array.isArray(row)) return [];\n    const [d, v, m]: unknown[] = [row[day], row[views], row[minutes]];\n    return typeof d === "string" && typeof v === "number" && typeof m === "number" ? [{ day: d, views: v, minutesWatched: m }] : [];\n  });\n}\n\nconst days = await dailyViews({ token: accessToken, startDate: "2026-10-01", endDate: "2026-10-31" });\nconsole.log(`${days.length} days, ${days.reduce((sum, d) => sum + d.views, 0)} views`);';

const sdkExample =
  'import { connectedAccountRef, createSocial } from "@opencoredev/social-sdk";\nimport { youtube } from "@opencoredev/social-sdk/youtube";\n\n// OAuth token for the channel\'s owner, with yt-analytics.readonly and youtube.readonly.\nconst accessToken = process.env["YOUTUBE_ACCESS_TOKEN"];\nconst channelId = process.env["YOUTUBE_CHANNEL_ID"];\nif (!accessToken || !channelId) throw new Error("Set YOUTUBE_ACCESS_TOKEN and YOUTUBE_CHANNEL_ID");\n\nconst social = createSocial({ backend: youtube({ auth: { accessToken, channelId } }) });\nconst account = connectedAccountRef({ backend: "default", platform: "youtube", accountId: channelId });\n\n// Daily views and watch time: one reports.query call.\nconst report = await social.analytics.getReport(account, {\n  from: "2026-10-01",\n  to: "2026-10-31",\n  metrics: ["views", "estimatedMinutesWatched"],\n  dimensions: ["day"],\n});\nconst views = report.rows.reduce((sum, row) => sum + (row.metrics["views"] ?? 0), 0);\n\n// Top videos need sort and maxResults, which getReport doesn\'t send, so use the\n// native call. Native calls bypass client middleware: check your user\'s access first.\nconst native = social.native("default", { acknowledgeUnsafe: true });\nif (!native) throw new Error("YouTube native operations are unavailable");\nconst top = await native.analytics({\n  query: {\n    ids: `channel==${channelId}`,\n    startDate: "2026-10-01",\n    endDate: "2026-10-31",\n    metrics: "views,estimatedMinutesWatched",\n    dimensions: "video",\n    sort: "-views",\n    maxResults: "10",\n  },\n  context: { backendInstance: "default", correlationId: crypto.randomUUID(), retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 } },\n});\nconst topRows = Array.isArray(top["rows"]) ? top["rows"].length : 0;\n\n// Channel analytics are private to the owner: log totals, not rows.\nconsole.log(`${report.rows.length} days, ${views} views; top ${topRows} videos`);';

const code = (source: string) => `<pre><code>${escapeHtml(source)}</code></pre>`;

export const youtubeAnalyticsApi: Guide = {
  slug: "youtube-analytics-api",
  title: "YouTube Analytics API: reports, scopes, quota",
  description:
    "How the YouTube Analytics API works: OAuth scopes, reports.query, metrics and dimensions, top-video reports, data delay, revenue access, and tested TypeScript.",
  summary:
    "Reading a channel's views, watch time, and top videos with the YouTube Analytics API: scopes, reports.query parameters, report rules, the 48 to 72 hour delay, revenue access, the Reporting API, and TypeScript examples.",
  heading: "The YouTube Analytics API, explained",
  lede: "The YouTube Analytics API returns a channel's analytics as a table: views, watch time, likes, subscribers gained, and, for monetized channels, estimated revenue, grouped by dimensions such as day, country, or video. Every report comes from one method, <code>reports.query</code>, a GET request to <code>/v2/reports</code> on <code>youtubeanalytics.googleapis.com</code>, and every request needs an OAuth 2.0 token from the channel's owner; API keys don't work. Data typically arrives 48 to 72 hours late, and each request counts as one unit of quota.",
  published: "2026-11-10",
  updated: "2026-11-10",
  content: `
          <h2 id="analytics-or-data-api">Analytics API or Data API?</h2>
          <p>
            YouTube has three APIs that return numbers, and they answer different questions:
          </p>
          <table>
            <thead><tr><th>API</th><th>What it gives you</th></tr></thead>
            <tbody>
              <tr><td>YouTube Analytics API</td><td>Reports for a date range on channels you own: views, watch time, audience, traffic sources, revenue. Built for targeted queries.</td></tr>
              <tr><td>YouTube Reporting API</td><td>Bulk daily reports for the same kinds of data, which you schedule and download. Built for exports and warehouses.</td></tr>
              <tr><td>YouTube Data API</td><td>Current public counters on any video or channel, such as <code>viewCount</code>, through <code>videos.list</code> and <code>channels.list</code>.</td></tr>
            </tbody>
          </table>
          <p>
            Google's data model page says Analytics data is not real-time and points apps that
            need current view, like, or comment counts to the Data API's <code>videos.list</code>
            instead (<a href="${dataModel}">data model</a>). The
            <a href="/guides/youtube-data-api">YouTube Data API guide</a> covers that side: API
            keys, quota costs, and reading public statistics.
          </p>

          <h2 id="authorization">Authorization and scopes</h2>
          <p>
            Every request must carry an OAuth 2.0 token. For a channel report, set
            <code>ids</code> to <code>channel==MINE</code> for the signed-in user's channel, or
            <code>channel==CHANNEL_ID</code>, in which case the user who authorized the request must
            own that channel (<a href="${channelReports}">channel reports</a>). You can't read
            another creator's analytics, only your own users' channels. The scopes, all under
            <code>https://www.googleapis.com/auth/</code>:
          </p>
          <table>
            <thead><tr><th>Scope</th><th>What it unlocks</th></tr></thead>
            <tbody>
              <tr><td><code>yt-analytics.readonly</code></td><td>User activity metrics, like views and ratings</td></tr>
              <tr><td><code>yt-analytics-monetary.readonly</code></td><td>The same, plus estimated revenue and ad performance metrics</td></tr>
              <tr><td><code>youtube.readonly</code></td><td>Required too: <code>reports.query</code> requests must have access to this scope</td></tr>
              <tr><td><code>youtube</code></td><td>Managing Analytics groups and group items as a channel owner</td></tr>
            </tbody>
          </table>
          <p>
            The <code>youtube.readonly</code> requirement trips people up because the analytics
            scopes look sufficient. Google's <code>reports.query</code> reference states it at the
            top, and the revision history dates it to 18 June 2018
            (<a href="${query}">reports.query</a>, <a href="${revisionHistory}">revision
            history</a>). Request it alongside <code>yt-analytics.readonly</code>.
          </p>
          <p>
            Revenue needs more than the monetary scope: the channel must be in the YouTube Partner
            Program, and asking for monetary metrics on a channel that isn't returns
            <code>403 Forbidden</code> (<a href="${channelReports}">channel reports</a>). Content
            owner reports, which add up every channel linked to a content owner, are only for YouTube
            Partner Program content partners.
          </p>

          <h2 id="reports-query">The reports.query request</h2>
          <p>Four parameters are required, and the rest shape the table (<a href="${query}">reports.query</a>):</p>
          <table>
            <thead><tr><th>Parameter</th><th>What it does</th></tr></thead>
            <tbody>
              <tr><td><code>ids</code></td><td>Required. <code>channel==MINE</code>, <code>channel==CHANNEL_ID</code>, or <code>contentOwner==OWNER_NAME</code></td></tr>
              <tr><td><code>startDate</code>, <code>endDate</code></td><td>Required. <code>YYYY-MM-DD</code>; the response stops at the last day for which every requested metric is processed</td></tr>
              <tr><td><code>metrics</code></td><td>Required. Comma-separated, such as <code>views,estimatedMinutesWatched</code></td></tr>
              <tr><td><code>dimensions</code></td><td>How rows are grouped, such as <code>day</code>, <code>country</code>, or <code>video</code></td></tr>
              <tr><td><code>filters</code></td><td>Which data to include, such as <code>video==VIDEO_ID;country==US</code>; join filters with <code>;</code></td></tr>
              <tr><td><code>sort</code>, <code>maxResults</code>, <code>startIndex</code></td><td>Order (<code>-</code> for descending), row limit, and a 1-based offset for paging</td></tr>
              <tr><td><code>currency</code></td><td>ISO 4217 code for revenue metrics; the default is USD</td></tr>
            </tbody>
          </table>
          <p>
            The <code>video</code>, <code>playlist</code>, and <code>channel</code> filters accept
            a comma-separated list of up to 500 IDs, and adding the same name to
            <code>dimensions</code> splits the results per ID. A group, a saved collection of up to
            500 videos, playlists, channels, or assets, can stand in for a long ID list.
          </p>

          <h2 id="first-request">Your first request</h2>
          <p>
            Daily views and minutes watched for October, for the signed-in user's channel. It costs
            1 unit of quota:
          </p>
          ${code(firstRequest)}
          <p>
            The response is a table. <code>columnHeaders</code> lists the dimensions you asked for,
            then the metrics, each with a <code>columnType</code> of <code>DIMENSION</code> or
            <code>METRIC</code>; each entry in <code>rows</code> is one array of values in that
            order. Google's advice is to read column positions from the header row rather than
            assume them, and if there is no data for the period, <code>rows</code> is left out
            entirely (<a href="${dataModel}">data model</a>, <a href="${query}">reports.query</a>).
          </p>

          <h2 id="reports">Reports you can build</h2>
          <p>
            There is no list of report endpoints: a report is a combination of dimensions, metrics,
            and filters that Google's <a href="${channelReports}">channel reports</a> page allows.
            The common ones:
          </p>
          <table>
            <thead><tr><th>Report</th><th>Dimensions and rules</th></tr></thead>
            <tbody>
              <tr><td>Channel totals for the period</td><td>No dimensions; filter by <code>video</code>, <code>group</code>, or a country</td></tr>
              <tr><td>Views over time</td><td>Exactly one of <code>day</code> or <code>month</code></td></tr>
              <tr><td>Top videos</td><td><code>video</code>, with <code>sort</code> required and <code>maxResults</code> of 200 or less</td></tr>
              <tr><td>Traffic sources, playback locations</td><td><code>insightTrafficSourceType</code>, <code>insightPlaybackLocationType</code>; the detail versions allow 25 rows at most and need <code>sort</code></td></tr>
              <tr><td>Geography</td><td><code>country</code>, or <code>province</code> with <code>country==US</code></td></tr>
              <tr><td>Devices</td><td><code>deviceType</code>, <code>operatingSystem</code></td></tr>
              <tr><td>Demographics</td><td><code>ageGroup</code>, <code>gender</code>, with the <code>viewerPercentage</code> metric</td></tr>
              <tr><td>Audience retention</td><td><code>elapsedVideoTimeRatio</code>, filtered to a single video</td></tr>
            </tbody>
          </table>
          <p>
            A combination the page doesn't allow fails with <code>400 badRequest</code> and the
            message "The query is not supported." Metric names are camelCase, such as
            <code>views</code>, <code>engagedViews</code>, <code>estimatedMinutesWatched</code>,
            <code>averageViewDuration</code>, <code>likes</code>, <code>shares</code>,
            <code>subscribersGained</code>, and <code>estimatedRevenue</code>
            (<a href="${metricsDoc}">metrics</a>, <a href="${dimensionsDoc}">dimensions</a>).
          </p>

          <h2 id="delay-and-gaps">Why the numbers lag and don't add up</h2>
          <ul>
            <li><strong>48 to 72 hours late.</strong> Processing typically takes that long, so a report never covers the last few days, and its end date is cut back to the last fully processed day. Numbers can differ from YouTube Studio's real-time view.</li>
            <li><strong>Small numbers are withheld.</strong> When a video, a country, a traffic source, or a demographic falls under an unpublished threshold, its rows are left out. A video's total can be 1,000 views while its by-country report only shows 998.</li>
            <li><strong>Deleted videos stay in totals.</strong> Channel-wide totals include views of videos later deleted, but per-video reports leave those videos out, so the per-video rows can add up to less.</li>
            <li><strong>Views changed meaning in 2026.</strong> Since 27 August, public view counts start when a video begins to play, across long-form, Live, and Shorts. <code>engagedViews</code> keeps the older "past the first frame" sense and is what monetization uses.</li>
          </ul>
          <p>
            Sources: the <a href="${dataModel}">data model</a> page for the first three and the
            <a href="${revisionHistory}">revision history</a> for the last.
          </p>

          <h2 id="quota">Quota</h2>
          <p>
            Each Analytics API request counts as one unit of your project's quota, whatever the
            report. Your limits are on the Quotas panel in the Google Cloud console
            (<a href="${dataModel}">data model</a>). Asking for several metrics and dimensions in one
            request costs the same as asking for one, so fetch a whole dashboard's numbers in as few
            requests as the report rules allow.
          </p>

          <h2 id="reporting-api">When to use the Reporting API instead</h2>
          <p>
            The YouTube Reporting API doesn't answer queries. You create a reporting job for a
            report type, YouTube generates a report for each day, and you download it later, then
            filter and sort it yourself. It has data the Analytics API doesn't, such as subtitle
            and asset reports and some revenue data, and its field names use
            <code>snake_case</code> where the Analytics API uses <code>camelCase</code>
            (<a href="${reporting}">which API is right for you</a>). Thumbnail impressions and
            click-through rate arrived in the Reporting API's reach reports on 15 January 2026
            (<a href="${revisionHistory}">revision history</a>). Use the Analytics API for numbers a
            user asks for on screen, and the Reporting API to keep a full daily history in your own
            database.
          </p>

          <h2 id="typescript">Calling the API from TypeScript</h2>
          <p>
            No client library is needed. This function reads daily views and watch time with
            <code>fetch</code>. It finds columns by name from the header row, treats a missing
            <code>rows</code> as an empty period, reports only error reasons it recognizes, and
            fails on a response that isn't a result table:
          </p>
          ${code(fetchExample)}
          <p>
            We type-checked this example with strict TypeScript and ran it on ${fetched} with
            Node.js 24 and Bun against a stub <code>fetch</code>. It sent one request with the
            bearer token, read rows correctly when the stub put the columns in a different order,
            returned an empty list when <code>rows</code> was missing and threw when it was <code>null</code>, skipped a malformed row,
            threw <code>reports.query failed: 403 forbidden</code> for a permission error and
            <code>502 unknown</code> for an HTML error page, kept an unrecognized reason and the
            error message out of the thrown error, and threw on a <code>200</code> with an HTML
            body, an error body, or a <code>rows</code> value that wasn't an array. The
            <code>googleapis</code> package for Node.js has a generated client if you'd rather use
            one.
          </p>

          <h2 id="social-sdk">YouTube analytics with Social SDK</h2>
          <p>
            <a href="/">Social SDK</a> is an open-source TypeScript library for posting to and
            reading from social platforms. Its YouTube adapter takes an OAuth access token and a
            channel ID. <code>social.analytics.getReport</code> calls <code>reports.query</code>
            for that channel with a date range, metrics, and dimensions, and returns rows of named
            dimensions and numeric metrics, with <code>rows: []</code> for an empty period. It
            doesn't send <code>sort</code>, <code>maxResults</code>, or <code>filters</code>, so a
            top-videos report goes through the adapter's native <code>analytics</code> call, which
            passes your query parameters as they are:
          </p>
          <pre><code>npm install @opencoredev/social-sdk</code></pre>
          ${code(sdkExample)}
          <p>
            We type-checked this example against <code>@opencoredev/social-sdk</code> 0.5.0 from
            npm and ran it on ${fetched} with Node.js 24 and Bun against a stub
            <code>fetch</code>. It sent two <code>GET /v2/reports</code> requests to
            <code>youtubeanalytics.googleapis.com</code>, both with the bearer token and
            <code>ids=channel==</code> the configured channel: one with
            <code>dimensions=day</code>, and one with <code>dimensions=video</code>,
            <code>sort=-views</code> and <code>maxResults=10</code>. It printed only totals, since a
            channel's analytics are private to its owner. The same two requests against Google
            would cost 2 units of quota. A 403
            surfaced as a <code>missing_permission</code> error and an HTML response as
            <code>upstream_failure</code>, without the response body. The adapter also reads
            lifetime counters without the Analytics API: <code>getAccountMetrics</code> returns the
            channel's <code>viewCount</code>, <code>subscriberCount</code> and
            <code>videoCount</code>, and <code>getPostMetrics</code> a video's views, likes, and
            comments, both from the Data API. The adapter doesn't refresh tokens; the SDK's
            <code>youtubeOAuth</code> server helper handles Google's authorization code flow
            (<a href="/docs/authentication">authentication guide</a>). Its default scopes cover
            uploads and <code>youtube.readonly</code> but not analytics, and a <code>scopes</code>
            option replaces the defaults, so pass the full list, including
            <code>yt-analytics.readonly</code> and <code>youtube.readonly</code>. Native calls skip the
            client's middleware, so check in your own server that the user may read that channel
            before you make one.
          </p>
          <p>
            The normalized report shape and every platform's analytics support are on the
            <a href="/docs/reads/reports">analytics reports</a> page, and the YouTube adapter's
            other operations are on the <a href="/docs/platforms/youtube">YouTube platform page</a>.
            Uploading is covered in the <a href="/guides/youtube-upload-api">YouTube upload API
            guide</a>. To try the SDK without a Google project, start with the
            <a href="/docs/getting-started/mock-quickstart">mock quickstart</a>.
          </p>

          <h2 id="faq">Common questions</h2>
          <dl class="faq">
            <dt>Is the YouTube Analytics API free?</dt>
            <dd>
              Google's pages list no price for it. Usage is limited by quota instead: each request
              counts as one unit against your Google Cloud project's limits.
            </dd>
            <dt>Can I get analytics for a channel I don't own?</dt>
            <dd>
              No. The user who authorizes the request must own the channel, or be the content
              owner it's linked to. For another channel's public view, subscriber, and video
              counts, use the Data API's <code>channels.list</code> and <code>videos.list</code>.
            </dd>
            <dt>Can I use an API key with the YouTube Analytics API?</dt>
            <dd>
              No. Every request needs an OAuth 2.0 token with <code>yt-analytics.readonly</code>
              (or <code>yt-analytics-monetary.readonly</code>) and access to
              <code>youtube.readonly</code>.
            </dd>
            <dt>Why doesn't the API show yesterday's views?</dt>
            <dd>
              Processing typically takes 48 to 72 hours, and the response stops at the last day for
              which all requested metrics are ready. For current counts, read
              <code>statistics.viewCount</code> from <code>videos.list</code>.
            </dd>
            <dt>How do I get revenue from the YouTube Analytics API?</dt>
            <dd>
              Authorize with <code>yt-analytics-monetary.readonly</code> and request metrics such as
              <code>estimatedRevenue</code>. The channel must be in the YouTube Partner Program;
              otherwise the request returns 403.
            </dd>
            <dt>How do I get my top videos?</dt>
            <dd>
              Use <code>dimensions=video</code> with <code>sort=-views</code> (or another
              supported metric) and <code>maxResults</code> of 200 or less. Both
              <code>sort</code> and <code>maxResults</code> are required for this report.
            </dd>
          </dl>

          <h2 id="sources">Sources</h2>
          <p>Google's YouTube Analytics and Reporting API pages, read on ${fetched}:</p>
          <ul>
            <li><a href="${overview}">Analytics and Reporting APIs overview</a> (last updated 3 November 2026): targeted queries vs bulk reports, groups</li>
            <li><a href="${query}">reports.query</a> (last updated 15 October 2026): parameters, scopes, the <code>youtube.readonly</code> requirement, response format</li>
            <li><a href="${channelReports}">Channel reports</a> (last updated 15 October 2026): <code>ids</code>, ownership, monetary access, report tables, row limits</li>
            <li><a href="${metricsDoc}">Metrics</a> (last updated 14 September 2026) and <a href="${dimensionsDoc}">dimensions</a> (last updated 9 November 2026)</li>
            <li><a href="${dataModel}">Data model</a> (last updated 5 November 2026): data delay, header rows, deleted items, anonymization, quota</li>
            <li><a href="${reporting}">Which API is right for you</a> (last updated 5 November 2026): Analytics API vs Reporting API</li>
            <li><a href="${revisionHistory}">Revision history</a> (last updated 9 November 2026): the 2018 scope change and the 2026 changes above</li>
          </ul>`,
};
