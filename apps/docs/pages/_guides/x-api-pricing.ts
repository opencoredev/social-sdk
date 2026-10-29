// The X API pricing guide. Prices, credits, and limits quote X's developer docs
// at docs.x.com with the date they were read, and never promise a price. The
// Social SDK example type-checks against the published npm package and was run
// against a stubbed fetch.
import { escapeHtml } from "../_blog/render";
import type { Guide } from "./guides";

const fetched = "29 October 2026";

const docs = "https://docs.x.com";

const pricing = `${docs}/x-api/getting-started/pricing`;

const freeCredits = `${docs}/x-api/getting-started/free-credits`;

const rateLimits = `${docs}/x-api/fundamentals/rate-limits`;

const usage = `${docs}/x-api/fundamentals/post-cap`;

const changelog = `${docs}/changelog`;

const createPost = `curl -X POST "https://api.x.com/2/tweets" \\
  -H "Authorization: Bearer <USER_ACCESS_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '{"text": "Hello from the X API"}'
# {"data": {"id": "1850000000000000001", "text": "Hello from the X API"}}`;

const usageCall = `curl "https://api.x.com/2/usage/tweets" \\
  -H "Authorization: Bearer <APP_BEARER_TOKEN>"`;

const sdkExample = `import { createSocial, connectedAccountRef } from "@opencoredev/social-sdk";
import { x } from "@opencoredev/social-sdk/x";

const userId = process.env["X_USER_ID"];
const accessToken = process.env["X_ACCESS_TOKEN"];
if (!userId || !accessToken) throw new Error("Set X_USER_ID and X_ACCESS_TOKEN");

// accessToken is an OAuth 2.0 user token with tweet.write; userId is that user's numeric ID.
const social = createSocial({ backend: x({ auth: { userId, accessToken } }) });
const account = connectedAccountRef({ backend: "default", platform: "x", accountId: userId });

// A text-only post is billed as Post: Create. Adding a URL to the text moves it to
// the Post: Create (with URL) rate.
const result = await social.posts.publish({
  targets: [{ account }],
  content: { text: "Shipped a new release today. Notes are pinned on our profile." },
});

for (const outcome of result.outcomes) {
  if (outcome.state === "published") console.log("published", outcome.post.postId);
  // unknown: the request went out but the result is unclear. Check the account's
  // posts before sending again; a blind retry can post (and bill) twice.
  else if (outcome.state === "unknown") console.log("check before retrying", outcome.diagnostic);
  else console.log(outcome.state, outcome);
}`;

const code = (source: string) => `<pre><code>${escapeHtml(source)}</code></pre>`;

export const xApiPricing: Guide = {
  slug: "x-api-pricing",
  title: "X API pricing in 2026: costs, free credits, limits",
  description:
    "X API pricing on pay-per-use credits: what a post and a read cost, whether a free tier exists, free credits, rate limits, and a TypeScript example.",
  summary:
    "X API pricing on pay-per-use credits: what a post and a read cost, the URL surcharge, free credits for new accounts, spending limits, posting rate limits, and a TypeScript example.",
  heading: "X API pricing, explained",
  lede: "The X API has no subscription tiers for new developers. Since February 2026 it bills pay-per-use: you buy credits in the Developer Console and each request deducts from them. On X's pricing page, read 29 October 2026, creating a post costs $0.015, or $0.20 if the post contains a URL, and reading a post costs $0.005. New accounts can earn up to $70 in free credits, but there is no general free tier. X says Public Utility Apps keep free access.",
  published: "2026-10-29",
  updated: "2026-10-29",
  content: `
          <p>
            Prices on this page are quoted from X's documentation as read on ${fetched}. X says
            its prices are subject to change, and the current rates are always in the
            <a href="https://console.x.com">Developer Console</a>. Check there before you budget.
          </p>

          <h2 id="how-it-works">How X API pricing works</h2>
          <p>
            X describes its pricing as pay-per-usage with no subscriptions, contracts, or minimum
            spend (<a href="${pricing}">pricing</a>). The model has four parts:
          </p>
          <ul>
            <li>
              <strong>Credits.</strong> You buy credits up front in the Developer Console, and
              requests deduct from the balance in real time. When the balance runs out, requests
              fail until you add more. The balance can dip slightly negative, and requests stay
              blocked until it is covered.
            </li>
            <li>
              <strong>Per-resource reads, per-request writes.</strong> Reads are charged for each
              resource returned, so a search that returns 100 posts is 100 post reads. Writes are
              charged per request.
            </li>
            <li>
              <strong>Daily deduplication.</strong> The same resource fetched again within one
              UTC day is charged once. X calls this a soft guarantee that can fail in edge cases
              such as outages.
            </li>
            <li>
              <strong>Only successful requests bill.</strong> X's usage FAQ says failed requests
              are not charged; only successful responses that return data are
              (<a href="${usage}">usage and billing</a>).
            </li>
          </ul>
          <p>
            Pay-per-use accounts are capped at 3 million post reads per monthly billing cycle.
            Above that, X points you to an Enterprise plan with custom pricing.
          </p>

          <h2 id="posting-costs">What posting costs</h2>
          <p>Write prices from X's pricing page, charged per request:</p>
          <table>
            <thead><tr><th>Action</th><th>Price per request</th></tr></thead>
            <tbody>
              <tr><td>Post: Create</td><td>$0.015</td></tr>
              <tr><td>Post: Create (with URL)</td><td>$0.200</td></tr>
              <tr><td>Post: Create (summoned reply)</td><td>$0.010</td></tr>
              <tr><td>Media Metadata (for example, alt text)</td><td>$0.005</td></tr>
              <tr><td>DM Interaction: Create</td><td>$0.015</td></tr>
              <tr><td>User Interaction: Create</td><td>$0.015</td></tr>
              <tr><td>Interaction: Delete</td><td>$0.010</td></tr>
            </tbody>
          </table>
          <p>
            The URL surcharge drives most posting budgets: a post with a link costs over 13
            times a plain post. At these rates, an account that posts 10 times a day for 30 days
            spends $4.50 on 300 plain posts, or $60 if every post carries a link. If links
            matter, put them in fewer posts, or in a reply only when the
            <a href="#replies">reply rules</a> allow it.
          </p>

          <h2 id="read-costs">What reading costs</h2>
          <table>
            <thead><tr><th>Resource</th><th>Price per resource</th></tr></thead>
            <tbody>
              <tr><td>Posts: Read</td><td>$0.005</td></tr>
              <tr><td>User: Read</td><td>$0.010</td></tr>
              <tr><td>Following/Followers: Read</td><td>$0.010</td></tr>
              <tr><td>DM Event: Read</td><td>$0.010</td></tr>
              <tr><td>Like, Mute, or Block: Read</td><td>$0.001</td></tr>
              <tr><td>Owned Reads (your own data)</td><td>$0.001</td></tr>
            </tbody>
          </table>
          <p>
            Owned Reads apply when the developer app's owner reads their own account: their
            posts, mentions, likes, bookmarks, followers, following, and lists, on endpoints such
            as <code>GET /2/users/{id}/tweets</code> where <code>{id}</code> is the
            authenticated owner. That makes a dashboard of your own account five times cheaper
            per post than reading someone else's timeline. Reading posts from other accounts is
            the expensive part of most X apps, and it is where the 3 million cap applies.
          </p>

          <h2 id="free-tier">Is there a free X API tier?</h2>
          <p>
            Not for new developers. X's pricing and getting-access pages describe only
            pay-per-use credits and Enterprise. When X launched pay-per-use on 6 February 2026,
            it gave recently active Legacy Free tier users a one-time $10 voucher, said Public
            Utility Apps keep free access, and said Basic and Pro subscribers could opt in to
            pay-per-use (<a href="${changelog}">changelog</a>). Guides that still describe a
            free tier with a monthly post allowance predate that change.
          </p>
          <p>What new accounts get instead is free credits (<a href="${freeCredits}">free credits</a>):</p>
          <ul>
            <li>
              <strong>$20</strong> once an account with its first eligible credit or debit card
              completes its first credit purchase. Adding a card alone stopped qualifying on 13
              October 2026, and prepaid cards don't qualify.
            </li>
            <li>
              <strong>A match of the first successful auto-recharge, up to $50.</strong> It's
              granted when the recharge actually charges the card, not when you switch it on.
            </li>
          </ul>
          <p>
            Each is once per account and once per physical card. Free credits are spent before
            purchased ones and expire three months after they are granted. X says these
            incentives are still rolling out, so an account may not receive them yet. X also
            gives back xAI API credits on spend: 10% from $200 in a billing cycle, 15% from
            $500, and 20% from $1,000, once you link an xAI team to the developer account.
          </p>

          <h2 id="controls">Keeping the bill under control</h2>
          <ul>
            <li>
              <strong>Spending limit.</strong> Set a maximum spend per billing cycle in the
              Developer Console. Requests are blocked once it's reached, which is safer than an
              open balance while you develop.
            </li>
            <li>
              <strong>Auto-recharge.</strong> Tops up when the balance falls below a threshold.
              It fires at most once per 5 minutes and doesn't run at a zero or negative balance,
              so a burst of traffic can still hit "out of credits" if the recharge amount is
              small.
            </li>
            <li><strong>Usage endpoint.</strong> Read daily post consumption from your code:</li>
          </ul>
          ${code(usageCall)}
          <ul>
            <li>
              <strong>Don't retry writes blindly.</strong> If a create request times out after
              it was sent, the post may exist. Sending it again can publish a duplicate and pay
              for it twice. Check the account's recent posts first.
            </li>
          </ul>

          <h2 id="limits">Posting rate limits</h2>
          <p>
            Billing and rate limits are separate: credits decide what you pay, rate limits decide
            how fast you can go. Limits from X's rate limit tables (<a href="${rateLimits}">rate limits</a>):
          </p>
          <table>
            <thead><tr><th>Endpoint</th><th>Limit</th></tr></thead>
            <tbody>
              <tr><td>Create a post (<code>POST /2/tweets</code>)</td><td>10,000 per 24 hours per app; 100 per 15 minutes per user</td></tr>
              <tr><td>Delete a post (<code>DELETE /2/tweets/:id</code>)</td><td>50 per 15 minutes per user</td></tr>
              <tr><td>Recent search (<code>GET /2/tweets/search/recent</code>)</td><td>450 per 15 minutes per app; 300 per 15 minutes per user</td></tr>
              <tr><td>User's posts (<code>GET /2/users/:id/tweets</code>)</td><td>10,000 per 15 minutes per app; 900 per 15 minutes per user</td></tr>
            </tbody>
          </table>
          <p>
            Requests over a limit get HTTP 429. Read the <code>x-rate-limit-reset</code> header
            to see when the window resets.
          </p>

          <h2 id="replies">Reply, like, and follow rules</h2>
          <p>Two 2026 policy changes limit what pay-per-use apps can automate (<a href="${changelog}">changelog</a>):</p>
          <ul>
            <li>
              Since 23 February 2026, programmatic replies through <code>POST /2/tweets</code>
              are allowed only when the original post's author "summoned" your account, by
              mentioning it or quoting one of its posts. Further restrictions apply to
              programmatic mentions and quotes. Enterprise access is not affected.
            </li>
            <li>
              With the price update effective 20 April 2026, following, likes, and quote posts
              through the API were removed from all self-serve tiers.
            </li>
          </ul>

          <h2 id="example">Making a post</h2>
          <p>
            Posting needs a user-context token. Create an app in the Developer Console, enable
            OAuth 2.0, and get a user access token with the <code>tweet.write</code> scope (plus
            <code>tweet.read</code> and <code>users.read</code>). An app-only bearer token can
            read public data but can't post. One create call:
          </p>
          ${code(createPost)}

          <h2 id="social-sdk">Posting to X from TypeScript with Social SDK</h2>
          <p>
            <a href="/">Social SDK</a> is an open-source TypeScript library with an X adapter.
            It uses your own X app and tokens, so X bills your developer account directly at the
            rates above. The adapter checks X's weighted 280-character count before sending,
            uploads media, and returns a typed outcome for each post. When the result of a
            create request is unclear, the outcome is <code>unknown</code> rather than a retry.
          </p>
          <pre><code>npm install @opencoredev/social-sdk</code></pre>
          ${code(sdkExample)}
          <p>
            We type-checked this example against <code>@opencoredev/social-sdk</code> 0.5.0 from
            npm and ran it on ${fetched} with a stub <code>fetch</code> standing in for
            <code>api.x.com</code>. It made one <code>POST /2/tweets</code> call with the user
            token and printed the new post ID. When the stub returned no post ID, it printed the
            "check before retrying" branch instead. It runs on Node.js 22.12 or later and Bun.
          </p>
          <p>
            The <a href="/docs/platforms/x">X platform page</a> covers the OAuth 2.0 connection
            flow, images, video, replies, search, and the filtered stream. The same client can
            post to X, Bluesky, and Threads in one call; the
            <a href="/docs/platforms">platforms overview</a> shows how. To build and test
            without spending credits, start with the
            <a href="/docs/getting-started/mock-quickstart">mock quickstart</a>, which runs
            against a mock backend.
          </p>

          <h2 id="faq">Common questions</h2>
          <dl class="faq">
            <dt>How much does it cost to post a tweet with the API?</dt>
            <dd>
              $0.015 per post on X's pricing page as read on ${fetched}, or $0.20 if the post
              contains a URL. A summoned reply is $0.010.
            </dd>
            <dt>Is the X API free?</dt>
            <dd>
              Not in general. New developers pay per use with credits. New accounts can earn up to $70 in
              free credits that expire after three months, and X says Public Utility Apps keep
              free access.
            </dd>
            <dt>Do Basic and Pro plans still exist?</dt>
            <dd>
              X's February 2026 launch note said Basic and Pro remained available to existing
              subscribers, who could opt in to pay-per-use. X's current pricing documentation
              describes only pay-per-use and Enterprise.
            </dd>
            <dt>Am I charged for failed requests?</dt>
            <dd>
              X's usage FAQ says no: only successful responses that return data are billed. A
              request that timed out may still have succeeded, though, so check before you
              repeat a write.
            </dd>
            <dt>How do I stop a runaway bill?</dt>
            <dd>
              Set a spending limit per billing cycle in the Developer Console and watch
              <code>/2/usage/tweets</code>. Requests stop when the limit is reached.
            </dd>
          </dl>

          <h2 id="sources">Sources</h2>
          <p>Read on ${fetched}:</p>
          <ul>
            <li><a href="${pricing}">X API pay-per-usage pricing and credits</a>: read and write prices, Owned Reads, deduplication, the 3 million post-read cap, auto-recharge, spending limits, xAI credits</li>
            <li><a href="${freeCredits}">Free credit incentives</a>: the $20 and up-to-$50 credits, eligibility, expiry</li>
            <li><a href="${usage}">Usage and billing</a>: tracked endpoints and the failed-request FAQ</li>
            <li><a href="${rateLimits}">Rate limits</a>: per-app and per-user limits for posting, deleting, search, and timelines</li>
            <li><a href="${docs}/x-api/getting-started/getting-access">Getting access</a>: Developer Console, apps, and credentials</li>
            <li><a href="${changelog}">Changelog</a>: pay-per-use launch (6 February 2026), reply restrictions (23 February 2026), price update and Owned Reads (16 April 2026, effective 20 April), free credits (2 October 2026)</li>
          </ul>`,
};
