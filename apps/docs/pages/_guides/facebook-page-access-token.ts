// The Facebook Page access token guide. Facts about Meta's tokens, permissions
// and errors cite Meta's own pages with the date each was read. The TypeScript
// example type-checks under strict settings and was run against a stubbed fetch.
// Social SDK's Facebook adapter is on main but not in npm 0.5.0, so the guide
// says so and shows no SDK sample for it.
import { escapeHtml } from "../_blog/render";
import type { Guide } from "./guides";

const fetched = "3 November 2026";

const docs = "https://developers.facebook.com/docs";

const accessTokens = `${docs}/facebook-login/guides/access-tokens`;

const longLived = `${accessTokens}/get-long-lived`;

const debugging = `${docs}/facebook-login/access-tokens/debugging-and-error-handling`;

const debugToken = `${docs}/graph-api/reference/debug_token`;

const pagesOverview = `${docs}/pages-api/overview`;

const pagesStart = `${docs}/pages-api/getting-started`;

const pagesPosts = `${docs}/pages-api/posts`;

const permissions = `${docs}/permissions`;

const errors = `${docs}/graph-api/guides/error-handling`;

const secureRequests = `${docs}/graph-api/guides/secure-requests`;

const exchangeUserToken = `curl -G "https://graph.facebook.com/v26.0/oauth/access_token" \
  -d "grant_type=fb_exchange_token" \
  -d "client_id=<APP_ID>" \
  -d "client_secret=<APP_SECRET>" \
  -d "fb_exchange_token=<SHORT_LIVED_USER_TOKEN>"
# {"access_token": "<LONG_LIVED_USER_TOKEN>", "token_type": "bearer", "expires_in": 5183944}`;

const listPages = `curl -G "https://graph.facebook.com/v26.0/me/accounts" \
  -d "fields=id,name,tasks,access_token" \
  -d "access_token=<LONG_LIVED_USER_TOKEN>"
# {"data": [{"id": "<PAGE_ID>", "name": "...", "tasks": ["CREATE_CONTENT", ...],
#            "access_token": "<PAGE_ACCESS_TOKEN>"}], "paging": {...}}`;

const inspectToken = `curl -G "https://graph.facebook.com/v26.0/debug_token" \
  -d "input_token=<PAGE_ACCESS_TOKEN>" \
  -d "access_token=<APP_ID>|<APP_SECRET>"
# {"data": {"type": "PAGE", "is_valid": true, "expires_at": ..., "scopes": [...]}}`;

const postToPage = `curl -X POST "https://graph.facebook.com/v26.0/<PAGE_ID>/feed" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from the Pages API", "access_token": "<PAGE_ACCESS_TOKEN>"}'
# {"id": "<PAGE_ID>_<POST_ID>"}`;

const tokenExample = `// Run on your server. The app secret and every token stay there.
import { createHmac } from "node:crypto";

const graph = "https://graph.facebook.com/v26.0";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(\`Set \${name}\`);
  return value;
}

const appId = requireEnv("META_APP_ID");
const appSecret = requireEnv("META_APP_SECRET");
// The short-lived user token your Facebook Login flow returned.
const userToken = requireEnv("FACEBOOK_USER_TOKEN");

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function get(path: string, params: Record<string, string>): Promise<Json> {
  const url = new URL(graph + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  // Errors name the path and status only. Raw errors and bodies can echo tokens.
  let status = 0;
  let body: unknown;
  try {
    const response = await fetch(url);
    status = response.status;
    body = await response.json();
  } catch {
    throw new Error(\`\${path} failed: \${status ? \`HTTP \${status}, body is not JSON\` : "network error"}\`);
  }
  if (!isJson(body)) throw new Error(\`\${path} failed: HTTP \${status}, unexpected response\`);
  const error = body["error"];
  if (status !== 200 || isJson(error)) {
    const detail = isJson(error)
      ? \`code \${String(error["code"])}, subcode \${String(error["error_subcode"])}\`
      : \`HTTP \${status}\`;
    throw new Error(\`\${path} failed: \${detail}\`);
  }
  return body;
}

// appsecret_proof is an HMAC-SHA256 of the token, keyed with the app secret.
const proof = (token: string) => createHmac("sha256", appSecret).update(token).digest("hex");

// 1. Swap the short-lived user token for a long-lived one (about 60 days).
const exchanged = await get("/oauth/access_token", {
  grant_type: "fb_exchange_token",
  client_id: appId,
  client_secret: appSecret,
  fb_exchange_token: userToken,
});
const longLivedUserToken = exchanged["access_token"];
if (typeof longLivedUserToken !== "string") throw new Error("No long-lived user token");

// 2. List the Pages the user granted, each with its own Page access token,
// and 3. keep the first one this user can publish to. The list is paginated.
type Page = { id: string; name: string; accessToken: string };
let page: Page | undefined;
let after: string | undefined;
do {
  const accounts = await get("/me/accounts", {
    fields: "id,name,tasks,access_token",
    access_token: longLivedUserToken,
    appsecret_proof: proof(longLivedUserToken),
    ...(after ? { after } : {}),
  });
  const rows: unknown[] = Array.isArray(accounts["data"]) ? accounts["data"] : [];
  for (const row of rows) {
    if (!isJson(row)) continue;
    const { id, name, access_token: accessToken, tasks } = row;
    const taskList: unknown[] = Array.isArray(tasks) ? tasks : [];
    if (typeof id !== "string" || typeof accessToken !== "string") continue;
    if (!taskList.includes("CREATE_CONTENT")) continue;
    page = { id, name: typeof name === "string" ? name : id, accessToken };
    break;
  }
  const paging = isJson(accounts["paging"]) ? accounts["paging"] : {};
  const cursors = isJson(paging["cursors"]) ? paging["cursors"] : {};
  const next = cursors["after"];
  after = !page && typeof paging["next"] === "string" && typeof next === "string" ? next : undefined;
} while (after);
if (!page) throw new Error("This user can't create content on any Page they granted.");

// 4. Inspect the Page token with an app token (app ID and secret joined by "|").
const debug = await get("/debug_token", {
  input_token: page.accessToken,
  access_token: \`\${appId}|\${appSecret}\`,
});
const info = isJson(debug["data"]) ? debug["data"] : {};
console.log(page.name, page.id, {
  type: info["type"],
  isValid: info["is_valid"],
  expiresAt: info["expires_at"],
  scopes: info["scopes"],
});
// Save page.id and page.accessToken in your secret store. Don't log the token.`;

const code = (source: string) => `<pre><code>${escapeHtml(source)}</code></pre>`;

export const facebookPageAccessToken: Guide = {
  slug: "facebook-page-access-token",
  title: "Facebook access token guide: Page tokens",
  description:
    "How to get a long-lived Facebook Page access token: user vs Page tokens, the fb_exchange_token and /me/accounts calls, permissions, debug_token, and error 190.",
  summary:
    "Getting a Facebook Page access token that keeps working: token types, the long-lived exchange, /me/accounts, permissions and Page tasks, debug_token, and the errors that mean reconnect.",
  heading: "Facebook Page access tokens, explained",
  lede: "A Facebook Page access token lets your server publish and read as a Page through the Graph API. You can't create one directly: a person with a task on the Page logs in to your app, you exchange their user token for a long-lived one, then call <code>/me/accounts</code>. Page tokens made from a long-lived user token have no expiration date, though Meta can still invalidate them.",
  published: "2026-11-03",
  updated: "2026-11-03",
  content: `
          <h2 id="token-types">Which Facebook access token you need</h2>
          <p>
            Meta issues several kinds of access token, and Graph API calls fail in confusing ways
            when you send the wrong one (<a href="${accessTokens}">access tokens</a>):
          </p>
          <table>
            <thead><tr><th>Token</th><th>What it is for</th></tr></thead>
            <tbody>
              <tr><td>User access token</td><td>Acting for a person who logged in to your app and granted permissions. You need one to get a Page token.</td></tr>
              <tr><td>Page access token</td><td>Reading and writing a Page's data: posts, comments, Insights. Unique to each Page, user, and app combination.</td></tr>
              <tr><td>System user access token</td><td>Automated actions on Pages or ad objects owned by your own business portfolio, without a person logging in.</td></tr>
              <tr><td>App access token</td><td>App settings and server calls such as <code>debug_token</code>. Made from your app ID and secret.</td></tr>
              <tr><td>Client token</td><td>Identifying a native or desktop app. Not secret, and not usable on its own.</td></tr>
            </tbody>
          </table>
          <p>
            To post to a Page, use a Page access token. A user token, even one with
            <code>pages_manage_posts</code>, can't post as the Page.
          </p>

          <h2 id="lifetimes">How long each token lasts</h2>
          <p>
            Short-lived tokens typically last one to two hours and long-lived ones about 60 days.
            Meta warns that these lifetimes can change without notice and that tokens can expire
            early (<a href="${accessTokens}">access tokens</a>). For Pages the rules chain together
            (<a href="${longLived}">long-lived tokens</a>):
          </p>
          <table>
            <thead><tr><th>You start with</th><th>You get</th></tr></thead>
            <tbody>
              <tr><td>Web login</td><td>A short-lived user token</td></tr>
              <tr><td>A short-lived user token</td><td>A short-lived Page token from <code>/me/accounts</code></td></tr>
              <tr><td>A short-lived user token plus your app secret</td><td>A long-lived user token (about 60 days) from <code>fb_exchange_token</code></td></tr>
              <tr><td>A long-lived user token</td><td>A Page token with no expiration date from <code>/me/accounts</code></td></tr>
            </tbody>
          </table>
          <p>
            So the order matters: exchange the user token first, then list Pages. You can't
            exchange a token that has already expired; the person has to log in again. The
            exchanged token is a different string, so replace the old one wherever you store it.
          </p>

          <h2 id="permissions">Permissions and Page tasks</h2>
          <p>
            Two separate checks decide what a Page token can do: the permissions the person
            granted your app, and the tasks that person can perform on the Page.
          </p>
          <table>
            <thead><tr><th>Permission</th><th>What it unlocks</th></tr></thead>
            <tbody>
              <tr><td><code>pages_show_list</code></td><td>The list of Pages a person manages, which is what <code>/me/accounts</code> returns</td></tr>
              <tr><td><code>pages_manage_posts</code></td><td>Creating, editing, and deleting Page posts, photos, and videos. Depends on <code>pages_read_engagement</code> and <code>pages_show_list</code></td></tr>
              <tr><td><code>pages_read_engagement</code></td><td>Reading the Page's content, followers, and metadata</td></tr>
              <tr><td><code>read_insights</code></td><td>Reading Page Insights data. Depends on <code>pages_read_engagement</code> and <code>pages_show_list</code></td></tr>
              <tr><td><code>pages_manage_engagement</code></td><td>Replying to and moderating comments as the Page</td></tr>
              <tr><td><code>publish_video</code></td><td>Publishing video to the Page</td></tr>
            </tbody>
          </table>
          <p>
            Those come from Meta's <a href="${permissions}">permissions reference</a> and
            <a href="${pagesPosts}">posts guide</a>. Meta's
            <a href="${pagesStart}">getting started page</a> also asks for
            <code>pages_manage_metadata</code>. Request the smallest set that covers what you
            build, since App Review asks you to justify each one.
          </p>
          <p>
            Tasks are per person and per Page. Publishing needs <code>CREATE_CONTENT</code>,
            replying to and deleting comments needs <code>MODERATE</code>, Insights needs
            <code>ANALYZE</code>, and a Page admin can do all of them
            (<a href="${pagesOverview}">Pages API overview</a>). Each Page that
            <code>/me/accounts</code> returns lists the person's tasks, so check for
            <code>CREATE_CONTENT</code> before you offer a Page as a posting target.
          </p>
          <p>
            Every Page permission needs App Review before people without a role on your app can
            grant it once the app is live. In development mode, only people with a role on the app
            can. Business apps have no app modes: each permission needs Advanced access before
            someone with neither a role on the app nor a role in the business that claimed it can
            grant it (<a href="${pagesOverview}">Pages API overview</a>).
          </p>

          <h2 id="get-a-token">Get a long-lived Page access token, step by step</h2>
          <ol>
            <li>
              Create a Meta app, add Facebook Login (or Facebook Login for Business, which Meta
              recommends for apps that manage business clients' assets), and request the
              permissions above.
            </li>
            <li>
              Send the person through the login dialog. Your callback gets a short-lived user
              token.
            </li>
            <li>
              On your server, exchange it for a long-lived user token. This call includes your app
              secret, so it never runs in a browser or mobile app
              (<a href="${longLived}">long-lived tokens</a>).
              ${code(exchangeUserToken)}
            </li>
            <li>
              Call <code>/me/accounts</code> with the long-lived user token. Each entry has the
              Page ID, name, the person's tasks, and a Page access token. The list is paginated, and
              only shows Pages the person let your app access.
              ${code(listPages)}
            </li>
            <li>
              Let the person choose a Page, then store that Page's ID and token on the server. Meta
              says token length changes over time, so use a variable-length column with no maximum
              (<a href="${accessTokens}">access tokens</a>).
            </li>
          </ol>
          <p>
            For a quick test without writing a login flow, Meta's
            <a href="https://developers.facebook.com/tools/explorer/">Graph API Explorer</a> can
            request the permissions, call <code>/me/accounts</code>, and switch to a Page token
            from its User or Page menu (<a href="${pagesStart}">getting started</a>). Use it for
            testing; production tokens should come from your own login flow.
          </p>

          <h2 id="typescript">The same flow in TypeScript</h2>
          <p>
            This script runs the exchange, pages through <code>/me/accounts</code> until it finds
            a Page the person can publish to, and inspects that Page's token. It validates every
            response before using it, reports only the path, HTTP status, and Meta's error code
            (never the URL or response body, which can hold tokens), and signs the
            <code>/me/accounts</code> calls with <code>appsecret_proof</code>.
          </p>
          ${code(tokenExample)}
          <p>
            We type-checked it with <code>strict</code> TypeScript and ran it on ${fetched} on
            Node.js 24 and Bun, with a stub <code>fetch</code> standing in for Meta. It skipped an
            analyze-only Page on the first page of results, followed the cursor to the second,
            printed that Page's token type and scopes, and logged no token. A stubbed 502 with a
            token in its body produced an error that contained no token. Bun and Node.js 24 run the
            file as it is; on Node.js 22, use a TypeScript runner such as tsx.
          </p>

          <h2 id="debug">Check a token with debug_token</h2>
          <p>
            <code>GET /debug_token</code> tells you who a token belongs to, whether it is valid,
            when it expires, and which permissions it carries. The caller must use an app token,
            or a developer's user token, for the same app
            (<a href="${debugToken}">debug_token reference</a>).
          </p>
          ${code(inspectToken)}
          <p>
            Useful fields: <code>type</code>, <code>is_valid</code>, <code>expires_at</code>,
            <code>data_access_expires_at</code> (when the app's access to the person's data
            ends), <code>scopes</code>, and <code>granular_scopes</code>. When a permission was
            granted for specific Pages, its <code>granular_scopes</code> entry lists their IDs in
            <code>target_ids</code>; when it applies to all, no targets are shown
            (<a href="${debugToken}">debug_token reference</a>,
            <a href="${debugging}">debugging and error handling</a>). If a Page is missing from
            <code>/me/accounts</code> and <code>target_ids</code> lists other Pages, the person
            didn't give your app access to it. The
            <a href="https://developers.facebook.com/tools/debug/accesstoken/">Access Token Debugger</a>
            shows the same data in a browser.
          </p>

          <h2 id="post">Post to the Page with the token</h2>
          <p>
            A text or link post is one call to <code>/{page-id}/feed</code>
            (<a href="${pagesStart}">getting started</a>). The response is the post ID, and the
            post's URL is <code>https://www.facebook.com/{post-id}</code>.
          </p>
          ${code(postToPage)}
          <p>
            To schedule, set <code>published</code> to <code>false</code> and pass
            <code>scheduled_publish_time</code> between 10 minutes and 30 days ahead. Photos go to
            <code>/{page-id}/photos</code>, and an app can only edit posts it created
            (<a href="${pagesPosts}">posts</a>).
          </p>

          <h2 id="errors">When a Page token stops working</h2>
          <p>
            Meta doesn't tell you when a token becomes invalid; you find out when a call fails
            (<a href="${debugging}">debugging and error handling</a>). Read the error's
            <code>code</code> and <code>error_subcode</code>
            (<a href="${errors}">handling errors</a>):
          </p>
          <table>
            <thead><tr><th>Error</th><th>What to do</th></tr></thead>
            <tbody>
              <tr><td><code>190</code> with subcode <code>463</code> or <code>467</code></td><td>The token expired or is invalid. Send the person through login again.</td></tr>
              <tr><td><code>190</code> with subcode <code>460</code></td><td>The person changed their password or logged out. Ask them to log in again.</td></tr>
              <tr><td><code>190</code> with subcode <code>458</code></td><td>The person removed your app or never authorized it.</td></tr>
              <tr><td>Subcode <code>492</code></td><td>The person behind the Page token no longer has a suitable role on the Page.</td></tr>
              <tr><td><code>10</code> or <code>200</code>–<code>299</code></td><td>A permission is missing or was removed. Request it again.</td></tr>
              <tr><td><code>4</code>, <code>17</code>, or <code>341</code></td><td>Throttling. Wait, retry, and check your call volume in the App Dashboard.</td></tr>
              <tr><td><code>506</code></td><td>Duplicate post. Change the content before trying again.</td></tr>
              <tr><td><code>368</code></td><td>Temporarily blocked for a policy violation.</td></tr>
            </tbody>
          </table>
          <p>
            Only the <code>190</code> rows and subcode <code>492</code> mean the token itself no
            longer works. A Page token made from a long-lived user token has no expiration date,
            but those cases still end it, so build a reconnect path instead of treating the token
            as permanent. Permission errors need a new grant, and throttling, duplicate, and policy
            errors are about the request, not the token: keep the token and retry or change the
            request.
          </p>

          <h2 id="system-users">Tokens for your own Pages: system users</h2>
          <p>
            If you only post to Pages your own business portfolio owns, a system user can replace
            the login flow. In Business settings, add a system user, assign it your app with
            Manage app permission and the Pages it needs, then generate a token with the
            permissions you choose and an expiration preference. System user tokens are made for
            automated actions without a person logging in, and Meta says they can be long-lived
            tokens that don't expire with time, though they can still be invalidated
            (<a href="${accessTokens}">access tokens</a>). Admin system users reach every asset in
            the portfolio; employee system users only the assets you assign, which is the safer
            default.
          </p>

          <h2 id="security">Keeping Page tokens safe</h2>
          <ul>
            <li>Keep the app secret and every user and Page token on your server. Meta's examples pass tokens as query parameters, so keep these URLs out of logs.</li>
            <li>
              Add <code>appsecret_proof</code>, an HMAC-SHA256 of the token keyed with your app
              secret, to server calls, and turn on Require App Secret in the App Dashboard so a
              stolen token can't be used without it (<a href="${secureRequests}">secure requests</a>).
            </li>
            <li>Store only the Page the person picked. Every Page token in the <code>/me/accounts</code> list is a credential.</li>
            <li>In a multi-tenant app, check that the signed-in tenant owns the stored Page before every read and write.</li>
          </ul>

          <h2 id="social-sdk">Facebook Pages in Social SDK</h2>
          <p>
            <a href="/">Social SDK</a> is an open-source TypeScript library for posting to social
            platforms from your own backend. Its Facebook adapter is on the main branch and not in
            the current npm release (0.5.0); the
            <a href="/docs/platforms/facebook">Facebook platform page</a> documents it.
            <code>discoverFacebookPages</code> lists the Pages a user token can manage, with each
            Page token and a <code>canPublish</code> flag set when the person has
            <code>CREATE_CONTENT</code>. The adapter takes one Page ID and token, rejects any other
            Page, and turns error <code>190</code> into a <code>reconnect_required</code> outcome.
          </p>
          <p>
            In 0.5.0 you can already post to Instagram, X, LinkedIn, Bluesky, Threads, TikTok, and
            YouTube (see the <a href="/docs/platforms">supported platforms</a>), or build without
            any credentials using the <a href="/docs/getting-started/mock-quickstart">mock quickstart</a>.
          </p>

          <h2 id="faq">Common questions</h2>
          <dl class="faq">
            <dt>Does a Facebook Page access token expire?</dt>
            <dd>
              One made from a short-lived user token expires within hours. One made from a
              long-lived user token has no expiration date, but it stops working if the person
              changes their password, loses their role on the Page, or removes your app.
            </dd>
            <dt>How do I get a permanent Facebook Page access token?</dt>
            <dd>
              Exchange the user token for a long-lived one with <code>fb_exchange_token</code>,
              then call <code>/me/accounts</code> with it. For Pages your own business owns, a
              system user token is the other option. Neither is guaranteed forever, so handle
              error 190.
            </dd>
            <dt>Why does /me/accounts return an empty list?</dt>
            <dd>
              The token lacks <code>pages_show_list</code>, the person didn't give your app access
              to any Page when they logged in, or they have no task on the Page. Check
              <code>scopes</code> and <code>granular_scopes</code> with <code>debug_token</code>.
            </dd>
            <dt>Can I post as a Page with a user access token?</dt>
            <dd>No. Get the Page access token from <code>/me/accounts</code> and use that for <code>/{page-id}/feed</code>.</dd>
            <dt>Is the Facebook access token the same as the app secret?</dt>
            <dd>
              No. The app secret identifies your app and must stay on your server. An app access
              token can be the app ID and secret joined by <code>|</code>, which is why it is
              server-only too.
            </dd>
          </dl>

          <h2 id="sources">Sources</h2>
          <p>Meta's pages, read on ${fetched}, with the update date each page showed:</p>
          <ul>
            <li><a href="${accessTokens}">Access tokens for Meta technologies</a> (updated 25 November 2025): token types, lifetimes, system users, token length</li>
            <li><a href="${longLived}">Long-lived access tokens</a> (updated 30 June 2026): <code>fb_exchange_token</code>, long-lived Page tokens, Graph API v26.0</li>
            <li><a href="${pagesStart}">Get started with the Pages API</a> (updated 30 June 2026): <code>/me/accounts</code>, posting, Graph API Explorer</li>
            <li><a href="${pagesPosts}">Pages API posts</a> (updated 17 April 2026): permissions, scheduling, photos, updates</li>
            <li><a href="${pagesOverview}">Pages API overview</a> (updated 5 May 2025): tasks, App Review, Facebook Login for Business</li>
            <li><a href="${permissions}">Permissions reference</a> (updated 19 October 2026): <code>pages_manage_posts</code>, <code>pages_read_engagement</code>, <code>pages_show_list</code>, <code>read_insights</code></li>
            <li><a href="${debugToken}">debug_token reference</a> (Graph API v26.0) and <a href="${debugging}">debugging and error handling</a> (no date shown): fields and expired-token errors</li>
            <li><a href="${errors}">Handling errors</a> and <a href="${secureRequests}">secure requests</a> (no date shown): error codes, <code>appsecret_proof</code></li>
          </ul>`,
};
