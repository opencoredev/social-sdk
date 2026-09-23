// About, contact, and privacy pages. They share one hand-drawn shell with the
// brand page's look; each page supplies its copy here.
import shell from "./info.html?raw";

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
  title: "About Social SDK, the open-source social platform toolkit",
  description:
    "Social SDK is an MIT-licensed TypeScript library for publishing, reading, and handling comments and webhooks across social platforms from your own server.",
  kicker: "who makes this, and why",
  heading: "About",
  lede: "Social SDK is an open-source TypeScript library for adding social platform features to your own application. You install it from npm, run it on your server, and keep your own credentials.",
  content: `
        <section>
          <h2>What it is</h2>
          <p>
            One typed client covers publishing, reads, analytics, comments, messages, and webhooks
            across Bluesky, Instagram, LinkedIn, Threads, TikTok, X, and YouTube. You can call each
            platform directly, or route work through an optional managed backend such as Zernio or
            Post for Me. Each destination returns its own outcome, so a post that is still
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
            <li><a href="/contact">Contact the maintainers</a></li>
          </ul>
        </section>`,
};

export const contact: InfoPage = {
  path: "/contact",
  title: "Contact Social SDK for bugs, questions, and security",
  description:
    "How to reach the Social SDK maintainers: GitHub issues for bugs and questions, with guidance for security reports and platform access problems.",
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
            the platform (for example X, Meta, TikTok, or Google) or with Zernio or Post for Me.
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
    "What social-sdk.dev records when you visit: pageviews, errors, and masked session replays, with query strings removed. The SDK collects nothing.",
  kicker: "last updated 23 September 2026",
  heading: "Privacy",
  lede: "This page covers the social-sdk.dev website. The Social SDK package you install from npm collects nothing and sends nothing on its own.",
  content: `
        <section>
          <h2>The SDK package</h2>
          <p>
            Importing <code>@opencoredev/social-sdk</code> makes no network request and sends no
            telemetry. Every call to a platform or managed backend is one your application makes
            with its own credentials. We never see your tokens, posts, or account data.
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
          <h2>Your choices</h2>
          <p>
            A tracker blocker, or blocking <code>y.social-sdk.dev</code>, stops the analytics
            without breaking the site. To ask about data tied to your visits or to request its
            deletion, open an issue at
            <a href="${repo}/issues">github.com/opencoredev/social-sdk/issues</a> without including
            personal details, and we'll arrange a private reply. See the
            <a href="/contact">contact page</a> for other routes.
          </p>
        </section>`,
};

/** Fills the shared shell with one page's copy. */
export function renderInfoPage(page: InfoPage): string {
  const fields = new Map([
    ["@title", page.title],
    ["@description", page.description],
    ["@path", page.path],
    ["@kicker", page.kicker],
    ["@heading", page.heading],
    ["@lede", page.lede],
    ["<!-- @content -->", page.content],
  ]);

  return shell.replace(
    /<!-- @content -->|@(?:title|description|path|kicker|heading|lede)\b/g,
    (token) => fields.get(token) ?? token,
  );
}
