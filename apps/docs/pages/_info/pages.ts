// About, contact, and privacy pages. They share one hand-drawn shell with the
// brand page's look; each page supplies its copy here.
import shell from "./info.html?raw";
import { withOpenCoreSites } from "../../opencore-footer";

type InfoPage = {
  path: string;
  title: string;
  description: string;
  kicker: string;
  heading: string;
  lede: string;
  content: string;
};

const repo = "https://github.com/opencoredev/social-sdk";

export const about: InfoPage = {
  path: "/about",
  title: "Social SDK: open-source TypeScript SDK for social posting",
  description:
    "Social SDK is an MIT-licensed TypeScript SDK for posting to X, Bluesky, Threads, LinkedIn, Instagram, TikTok, and YouTube from your own server.",
  kicker: "who makes this, and why",
  heading: "About",
  lede: "Social SDK is an open-source TypeScript library for adding social platform features to your own application. You install it from npm, run it on your server, and keep your own credentials.",
  content: `
        <section>
          <h2>What it is</h2>
          <p>
            One typed client covers publishing, reads, analytics, comments, messages, and webhooks
            across Bluesky, Instagram, LinkedIn, Threads, TikTok, X, and YouTube. You can call each
            platform directly, or route work through an optional managed backend such as Zernio,
            Post for Me, PostFast, Postiz, or Buffer. Each destination returns its own outcome, so a post that is still
            processing or whose result is uncertain is never reported as published.
          </p>
          <p>
            A deterministic mock backend lets you build and test an integration without
            credentials or billable provider calls. The package also ships an offline
            <code>social-sdk</code> CLI for adapter discovery, capability checks, and request
            validation.
          </p>
        </section>
        <section>
          <h2>What it is not</h2>
          <p>
            Social SDK is not a hosted service. It doesn't need a Social SDK account, database,
            queue, or UI framework, and importing it makes no network request and sends no
            telemetry. Your application decides which platform calls happen, and your server holds
            the tokens.
          </p>
        </section>
        <section>
          <h2>Who builds it</h2>
          <p>
            The project is maintained by <a href="https://github.com/opencoredev">OpenCore</a> and
            developed in the open on <a href="${repo}">GitHub</a> under the MIT license. Releases go
            to npm as
            <a href="https://www.npmjs.com/package/@opencoredev/social-sdk"
              ><code>@opencoredev/social-sdk</code></a
            >
            through Changesets, with npm provenance. Contributions are welcome. The
            <a href="/docs/contributing">contributing guide</a> covers the checks each change must
            pass.
          </p>
        </section>
        <section>
          <h2>Where to go next</h2>
          <ul>
            <li><a href="/docs/getting-started/installation">Install the package</a></li>
            <li><a href="/docs/getting-started/mock-quickstart">Run the mock quickstart</a></li>
            <li><a href="/docs/platforms">Compare platforms</a></li>
            <li><a href="/guides">Read the platform API guides</a></li>
            <li><a href="/blog">Read the blog</a></li>
            <li><a href="/contact">Contact the maintainers</a></li>
          </ul>
        </section>`,
};

export const contact: InfoPage = {
  path: "/contact",
  title: "Contact Social SDK: GitHub issues, security, and help",
  description:
    "Reach the Social SDK maintainers on GitHub. Open an issue for bugs, questions, or feature requests, and learn how to report a security problem safely.",
  kicker: "how to reach us",
  heading: "Contact",
  lede: "Social SDK is maintained in the open, so almost every conversation happens on GitHub where others can find the answer later.",
  content: `
        <section>
          <h2>Bugs, questions, and feature requests</h2>
          <p>
            Open an issue at <a href="${repo}/issues">github.com/opencoredev/social-sdk/issues</a>.
            The issue form asks for a summary, the affected area, and a minimal reproduction. A
            reproduction that uses the mock backend gets the fastest answer.
          </p>
          <p>
            Search existing issues first. The <a href="/docs/reference/faq">FAQ</a> and
            <a href="/docs/reference/errors">error reference</a> cover the common ones.
          </p>
        </section>
        <section>
          <h2>Security reports</h2>
          <p>
            Never post access tokens, OAuth codes, webhook secrets, signed URLs, or private account
            data in a public issue. If a report needs private details, open an issue that describes
            the problem without them and ask for a private channel. The
            <a href="/docs/reference/security">security reference</a> explains how the SDK handles
            credentials.
          </p>
        </section>
        <section>
          <h2>Platform and provider problems</h2>
          <p>
            Social SDK doesn't issue platform credentials, approve app reviews, or run the managed
            backends. Questions about API access, rate limits, or account eligibility belong with
            the platform (for example X, Meta, TikTok, or Google) or with Zernio, Post for Me, PostFast, Postiz, or Buffer.
          </p>
        </section>
        <section>
          <h2>Elsewhere</h2>
          <ul>
            <li>Updates on X: <a href="https://x.com/leodev">@leodev</a></li>
            <li>
              Package:
              <a href="https://www.npmjs.com/package/@opencoredev/social-sdk"
                >npmjs.com/package/@opencoredev/social-sdk</a
              >
            </li>
            <li>Source: <a href="${repo}">github.com/opencoredev/social-sdk</a></li>
            <li><a href="/about">About the project</a> and <a href="/privacy">privacy</a></li>
          </ul>
        </section>`,
};

export const privacy: InfoPage = {
  path: "/privacy",
  title: "Privacy, what social-sdk.dev collects and why",
  description:
    "What social-sdk.dev records, why the npm package collects nothing, and how Social SDK Cloud handles connected accounts, tokens, and deletion requests.",
  kicker: "last updated 29 October 2026",
  heading: "Privacy",
  lede: "This page covers the social-sdk.dev website, the Social SDK package you install from npm, and Social SDK Cloud, our hosted service in early development. The package collects nothing and sends nothing on its own.",
  content: `
        <section>
          <h2>The SDK package</h2>
          <p>
            Importing <code>@opencoredev/social-sdk</code> makes no network request and sends no
            telemetry. Every call to a platform or managed backend is one your application makes
            with its own credentials. When you run the package on your own server, we never see
            your tokens, posts, or account data.
          </p>
        </section>
        <section>
          <h2>What the website records</h2>
          <p>
            The site uses a product analytics service to learn which documentation helps people.
            Requests go through our own address, <code>y.social-sdk.dev</code>, and are stored in
            the service's US cloud. Analytics start after the page has loaded and record:
          </p>
          <ul>
            <li>pages viewed and left, with the referring page</li>
            <li>JavaScript errors that happen on the page</li>
            <li>
              session replays of how the page was used, with every form input masked before it
              leaves your browser
            </li>
            <li>
              which platform, integration, install, and quickstart pages you open, so we know
              which guides to improve
            </li>
          </ul>
          <p>
            Query strings are removed from every URL and referrer before an event is sent. Clicks
            are not captured automatically, and we don't identify visitors, so the analytics service
            keeps no named profile for you. It stores a random visitor ID in a cookie and local storage
            to tie your page views together.
          </p>
        </section>
        <section>
          <h2>Other storage and hosting</h2>
          <p>
            Your light or dark theme choice is saved in local storage as <code>blume-theme</code>.
            The site is hosted on Vercel, which processes standard request data such as your IP
            address and user agent to serve pages. There are no accounts, forms, ads, or
            third-party ad trackers on the site.
          </p>
        </section>
        <section>
          <h2>What we don't do</h2>
          <p>
            We don't sell visitor data, share it with advertisers, or combine it with other
            sources. Analytics are used only to improve the documentation and the site.
          </p>
        </section>
        <section>
          <h2>Social SDK Cloud</h2>
          <p>
            Social SDK Cloud is a hosted version of Social SDK. It is in early development and not
            open for sign-ups. When an app built on it asks you to connect a social account, you
            sign in on the platform's own page and approve an app named Social SDK Cloud. This
            section and the ones after it describe what the service keeps from then on.
          </p>
          <p>For a connected account, Social SDK Cloud stores:</p>
          <ul>
            <li>the access and refresh tokens the platform issues, encrypted at rest</li>
            <li>
              the account's platform ID, username, and display name, so the app can show which
              account is connected
            </li>
            <li>
              the posts, replies, messages, and media the app asks it to send for you, while they
              are being delivered
            </li>
            <li>
              a record of each delivery: the destination, the time, the result, and the platform's
              post ID or link
            </li>
          </ul>
          <p>
            For developers who use the service, it also stores an account email, API key metadata,
            and billing records. Stripe processes payments, and we never see full card numbers.
          </p>
        </section>
        <section>
          <h2>How Social SDK Cloud uses that data</h2>
          <p>
            Only to do what the app you connected asks, on the account you connected, and to show
            you and that app the results. We don't read your account for any other purpose, sell
            the data, use it for advertising, or use it to train AI models.
          </p>
          <ul>
            <li><b>Tokens</b> are kept until you disconnect the account or revoke access on the platform.</li>
            <li><b>Post content and media</b> are deleted once delivery finishes, and within 7 days at most.</li>
            <li><b>Delivery records</b> are kept for 90 days.</li>
            <li><b>Billing records</b> are kept as long as tax law requires.</li>
          </ul>
          <p>
            Cloudflare hosts the service and stores its data. Each platform you post to receives
            the content you send it and handles it under its own privacy policy.
          </p>
        </section>
        <section>
          <h2>Disconnecting and deleting your data</h2>
          <p>
            Disconnect the account in the app you connected it through, or remove Social SDK Cloud
            from the connected apps in the platform's own settings. When an account is disconnected
            or its access is revoked, we delete its tokens and any content still waiting to be
            sent.
          </p>
          <p>
            To have everything tied to an account deleted, email
            <a href="mailto:leo@social-sdk.dev">leo@social-sdk.dev</a> with the platform and the
            username. We confirm by email when it's done, within 30 days.
          </p>
        </section>
        <section>
          <h2>Google and YouTube</h2>
          <p>
            Social SDK Cloud uses YouTube API Services. By connecting a YouTube account, you agree
            to the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>, and Google
            handles your data under the
            <a href="https://policies.google.com/privacy">Google Privacy Policy</a>. You can revoke
            Social SDK Cloud's access at any time in your
            <a href="https://myaccount.google.com/connections">Google account connections</a>.
          </p>
          <p>
            Social SDK Cloud's use and transfer to any other app of information received from
            Google APIs will adhere to the
            <a href="https://developers.google.com/terms/api-services-user-data-policy"
              >Google API Services User Data Policy</a
            >, including the Limited Use requirements.
          </p>
        </section>
        <section>
          <h2>Children</h2>
          <p>
            The site and Social SDK Cloud are not directed at children under 13, and we don't
            knowingly collect their data. If you think a child's data reached us, email us and we
            will delete it.
          </p>
        </section>
        <section>
          <h2>Your choices</h2>
          <p>
            A tracker blocker, or blocking <code>y.social-sdk.dev</code>, stops the analytics
            without breaking the site. To ask about data tied to your visits or to request its
            deletion, email <a href="mailto:leo@social-sdk.dev">leo@social-sdk.dev</a>, or open an
            issue at <a href="${repo}/issues">github.com/opencoredev/social-sdk/issues</a> without
            including personal details and we'll arrange a private reply. The
            <a href="/terms">terms</a> cover how the site, the package, and Social SDK Cloud may be
            used.
          </p>
        </section>`,
};

export const terms: InfoPage = {
  path: "/terms",
  title: "Terms of service for Social SDK and Social SDK Cloud",
  description:
    "The terms for social-sdk.dev, the MIT-licensed Social SDK package, and Social SDK Cloud: platform rules, acceptable use, prepaid billing, and liability.",
  kicker: "last updated 29 October 2026",
  heading: "Terms",
  lede: "These terms cover the social-sdk.dev website, the open-source Social SDK package, and Social SDK Cloud. If anything here is unclear, email leo@social-sdk.dev.",
  content: `
        <section>
          <h2>Who we are</h2>
          <p>
            Social SDK is maintained by <a href="https://github.com/opencoredev">OpenCore</a>. In
            these terms, "we" means the Social SDK maintainers, and "you" means the person or
            organization using the site, the package, or Social SDK Cloud. If you use them for an
            organization, you confirm you can accept these terms on its behalf.
          </p>
        </section>
        <section>
          <h2>The open-source package</h2>
          <p>
            <code>@opencoredev/social-sdk</code> is released under the
            <a href="${repo}/blob/main/LICENSE">MIT license</a>. That license, not these terms,
            governs how you use, copy, and change the code. Running the package on your own server
            doesn't create an account with us or send us any data.
          </p>
        </section>
        <section>
          <h2>Social SDK Cloud</h2>
          <p>
            Social SDK Cloud is a hosted service that connects apps to social platforms through
            OAuth apps we operate under the name Social SDK Cloud. It is in early development and
            not open for sign-ups. Access is by invitation, and its features, platforms, and limits
            can change before it is generally available.
          </p>
          <p>
            You must be at least 13 to use it. Keep your API keys secret: you are responsible for
            everything done with your keys and your account.
          </p>
        </section>
        <section>
          <h2>Each platform's rules apply</h2>
          <p>
            Everything sent through Social SDK Cloud is also subject to the rules of the platform it
            goes to, including the
            <a href="https://developer.x.com/en/developer-terms/agreement-and-policy"
              >X Developer Agreement and Policy</a
            >, the <a href="https://developers.facebook.com/terms/">Meta Platform Terms</a>, the
            <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>, the
            <a href="https://www.tiktok.com/legal/page/global/tik-tok-developer-terms-of-service/en"
              >TikTok Developer Terms</a
            >, the <a href="https://www.linkedin.com/legal/l/api-terms-of-use">LinkedIn API Terms</a
            >, the
            <a href="https://discord.com/developers/docs/policies-and-agreements/developer-terms-of-service"
              >Discord Developer Terms</a
            >, and the
            <a href="https://policy.pinterest.com/en/developer-guidelines"
              >Pinterest Developer Guidelines</a
            >. By connecting a YouTube account, you agree to be bound by the YouTube Terms of
            Service.
          </p>
          <p>
            If an app you build lets other people connect their accounts, you must tell them what
            the app will do with each account and get their consent before it acts.
          </p>
        </section>
        <section>
          <h2>Acceptable use</h2>
          <p>Don't use Social SDK Cloud to:</p>
          <ul>
            <li>send spam or unsolicited bulk messages</li>
            <li>
              inflate engagement artificially, such as fake likes, follows, or coordinated posting
              across accounts
            </li>
            <li>post the same content across many accounts to get around a platform's limits</li>
            <li>scrape, collect, or resell platform data</li>
            <li>act on an account you aren't authorized to use</li>
            <li>post illegal content, harassment, or content that infringes someone else's rights</li>
            <li>probe, overload, or work around the service's own limits</li>
          </ul>
          <p>
            We may suspend or remove access that breaks these rules or puts our platform apps at
            risk. We'll tell you why, unless the law or a platform prevents it.
          </p>
        </section>
        <section>
          <h2>Billing</h2>
          <p>
            Paid use of Social SDK Cloud is prepaid, and you see the price of each kind of action
            before you pay. When a balance reaches zero, requests stop. We never bill you after the
            fact. Unused balance stays on your account while it's open. Stripe processes payments.
            If you think a charge is wrong, email us and we'll look into it.
          </p>
        </section>
        <section>
          <h2>Results and availability</h2>
          <p>
            Platforms decide whether a post is published. We report each destination's result as
            the platform gives it, including results that are still processing or unclear, and we
            can't promise that a platform will accept any post, message, or account. A platform can
            change or withdraw API access at any time, and we may have to change or drop support
            for it.
          </p>
        </section>
        <section>
          <h2>Your content</h2>
          <p>
            You own what you send through the service. You give us permission to store, process,
            and transmit it only as needed to deliver it and report the result. The
            <a href="/privacy">privacy page</a> explains what we keep and for how long.
          </p>
        </section>
        <section>
          <h2>No warranty, limited liability</h2>
          <p>
            The site, the package, and Social SDK Cloud are provided as is, without warranties of
            any kind. To the extent the law allows, we aren't liable for indirect or consequential
            losses, lost profits, or lost data, and our total liability for any claim about Social
            SDK Cloud is limited to what you paid us in the 12 months before the claim.
          </p>
        </section>
        <section>
          <h2>Ending and changes</h2>
          <p>
            You can stop using Social SDK Cloud and ask us to delete your account at any time. We
            may end your access, or the service, with notice. If we shut the service down, we
            refund any unused prepaid balance.
          </p>
          <p>
            We post changes to these terms on this page and update the date at the top. For a
            material change that affects Social SDK Cloud accounts, we email account holders at
            least 14 days before it takes effect.
          </p>
        </section>
        <section>
          <h2>Contact</h2>
          <p>
            Email <a href="mailto:leo@social-sdk.dev">leo@social-sdk.dev</a>, or open an issue at
            <a href="${repo}/issues">github.com/opencoredev/social-sdk/issues</a>. The
            <a href="/contact">contact page</a> lists other routes.
          </p>
        </section>`,
};

/** The parts of the shared shell a page fills. Values are HTML, already escaped. */
export type Shell = {
  meta: string;
  kicker: string;
  heading: string;
  lede: string;
  content: string;
};

/** Fills the shared shell. The shell is scanned once, so inserted values are never re-read. */
export function renderShell(page: Shell): string {
  const fields = new Map([
    ["<!-- @meta -->", page.meta],
    ["@kicker", page.kicker],
    ["@heading", page.heading],
    ["@lede", page.lede],
    ["<!-- @content -->", page.content],
  ]);

  return withOpenCoreSites(
    shell.replace(
      /<!-- @(?:meta|content) -->|@(?:kicker|heading|lede)\b/g,
      (token) => fields.get(token) ?? token,
    ),
  );
}

/** The site's standard head tags for a page at `path`. */
export function siteMeta(page: { path: string; title: string; description: string }): string {
  const url = `https://social-sdk.dev${page.path}`;

  return `<title>${page.title}</title>
    <meta name="description" content="${page.description}" />
    <link rel="canonical" href="${url}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${url}" />
    <meta property="og:site_name" content="Social SDK" />
    <meta property="og:title" content="${page.title}" />
    <meta property="og:description" content="${page.description}" />
    <meta property="og:image" content="https://social-sdk.dev/og-home.png" />
    <meta property="og:video" content="https://social-sdk.dev/og/og-video.mp4" />
    <meta property="og:video:secure_url" content="https://social-sdk.dev/og/og-video.mp4" />
    <meta property="og:video:type" content="video/mp4" />
    <meta property="og:video:width" content="2400" />
    <meta property="og:video:height" content="1260" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:site" content="@leodev" />`;
}

/** Fills the shared shell with one page's copy. */
export function renderInfoPage(page: InfoPage): string {
  return renderShell({ ...page, meta: siteMeta(page) });
}
