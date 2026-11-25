// PostHog for every page on the site: the Blume docs layout loads it through
// `analytics: [script(...)]`, and the standalone landing and brand pages inject it
// into their own <head>. One snippet keeps the config identical everywhere.
//
// Captured: pageviews and page leaves (including client-router navigations),
// JavaScript exceptions, and the docs-interest events below, plus events pages
// send through window.siteTrack (the Cloud waitlist signup and the landing
// page's `landing_cta_click`). Autocapture and session recording stay off
// (Databuddy records replays), and query strings are stripped from URLs before
// events leave the browser.
//
// PostHog starts once the page has loaded and the main thread is idle, so its
// bundle doesn't compete with the first paint on slow phones. Its exception
// handler only exists once that bundle runs, so starting later only misses
// errors from the page's first moments.
//
// Databuddy runs beside it on the same pages: blume.config.ts loads
// `databuddyScript` through Blume's `script()` adapter, and `withAnalytics` adds
// it to the standalone pages. It records pageviews, Web Vitals, JavaScript
// errors, clicks on links that leave the site, rage and dead clicks, and session
// replays with page text and inputs masked. Events sent through window.siteTrack
// go to both.
//
// Its scripts and events go through our own domain: vercel.json proxies
// `/_p/s.js` and `/_p/r.js` to cdn.databuddy.cc and `/_p/e/*` to
// basket.databuddy.cc, so tracker blockers that list Databuddy's hosts don't
// drop them. The prefix says nothing about analytics on purpose. The loader
// adds the two tags at runtime because those paths exist only as Vercel
// routes; a static <script src="/_p/..."> fails the docs audit, which checks
// every same-origin script against the build output.

/** Databuddy's website client ID. It's public: it ships in the page. */
const DATABUDDY_CLIENT_ID = "d1d47f02-24fc-452d-820a-18b6855ab053";

/** The event endpoint both scripts post to, proxied to basket.databuddy.cc. */
const DATABUDDY_API_PATH = "/_p/e";

/** The tracker script, proxied to cdn.databuddy.cc/databuddy.js. */
const DATABUDDY_TRACKER_SRC = "/_p/s.js";

const databuddyShared = {
  "data-client-id": DATABUDDY_CLIENT_ID,
  "data-api-url": DATABUDDY_API_PATH,
};

/** Databuddy's tracker and replay recorder, in load order, with their `data-` settings. */
const databuddyTags: [src: string, attributes: Record<string, string>][] = [
  [
    DATABUDDY_TRACKER_SRC,
    {
      ...databuddyShared,
      "data-track-web-vitals": "true",
      "data-track-errors": "true",
      "data-track-outgoing-links": "true",
    },
  ],
  ["/_p/r.js", databuddyShared],
];

/**
 * Inline loader that appends Databuddy's two async tags to <head>.
 *
 * Both scripts skip setup when their tag is no longer in the document as they
 * run, and Astro's client router removes injected tags when it swaps <head>.
 * A navigation that finishes before a script downloads would leave it unset
 * for the rest of the visit, since Astro doesn't run this inline loader again.
 * So the loader also listens for `astro:page-load` and adds a fresh tag for any
 * script that hasn't yet run while attached. A script whose download fails (a
 * blocker, a 404) is settled too, so it isn't requested again on every page.
 *
 * Once the tracker has run, it sends the events window.siteTrack held in
 * `window.databuddyPending` while the tracker was still loading.
 *
 * It also reports the site's conversion clicks to Databuddy, where the goals
 * and funnels for social-sdk.dev count them:
 *
 * - `outbound_click` for a link to the GitHub repository or the npm package,
 *   with `destination` (`github` or `npm`).
 * - `install_command_copy` for the landing page's install Copy button and for
 *   any docs code block that installs `@opencoredev/social-sdk`.
 * - `docs_code_copy` for every docs code block copy, with its `language`.
 *
 * Each carries `surface` (`landing`, `docs` or `site`) and the page path. They
 * never carry the copied text, link query strings, or anything a visitor typed.
 */
export const databuddyScript = `(() => {
  const tags = ${JSON.stringify(databuddyTags)};
  // Scripts that ran while their tag was attached or failed to download, and
  // the latest tag per script.
  const settled = new Set();
  const latest = new Map();
  let trackerFailed = false;
  const load = () => {
    for (const [src, attributes] of tags) {
      if (settled.has(src) || latest.get(src)?.isConnected) continue;
      const tag = document.createElement("script");
      tag.src = src;
      tag.async = true;
      tag.setAttribute("data-databuddy-injected", "");
      for (const [name, value] of Object.entries(attributes)) tag.setAttribute(name, value);
      tag.onload = () => {
        if (!tag.isConnected) return;
        settled.add(src);
        if (src === ${JSON.stringify(DATABUDDY_TRACKER_SRC)} && window.databuddy) {
          for (const [event, properties] of (window.databuddyPending ?? []).splice(0)) {
            window.databuddy.track(event, properties);
          }
        }
      };
      tag.onerror = () => {
        // A tag that a navigation already replaced or removed says nothing
        // about its replacement, which may still load.
        if (latest.get(src) !== tag || !tag.isConnected) return;
        settled.add(src);
        if (src !== ${JSON.stringify(DATABUDDY_TRACKER_SRC)}) return;
        // The tracker won't load on this page (a blocker, a 404), so queued
        // events have nowhere to go.
        trackerFailed = true;
        window.databuddyPending = [];
      };
      latest.set(src, tag);
      document.head.append(tag);
    }
  };
  load();
  document.addEventListener("astro:page-load", load);

  // The one way events reach Databuddy, window.siteTrack's included: sent once
  // the tracker has run, held in a bounded queue until then, and dropped when
  // the tracker can't load.
  const send = (event, properties) => {
    if (window.databuddy) return window.databuddy.track(event, properties);
    if (trackerFailed) return;
    const pending = (window.databuddyPending ??= []);
    if (pending.length < 50) pending.push([event, properties]);
  };
  window.databuddySend = send;
  const destination = (href) => {
    try {
      const url = new URL(href, location.href);
      if (url.hostname === "github.com" && /^\\/opencoredev\\/social-sdk(\\/|$)/.test(url.pathname))
        return "github";
      if (url.hostname === "www.npmjs.com" && /^\\/package\\/@opencoredev\\/social-sdk(\\/|$)/.test(url.pathname))
        return "npm";
    } catch {
      // An href that isn't a URL isn't a conversion link.
    }
    return null;
  };
  // An install command whose own arguments include the package itself, not a
  // subpath and not a mention in a comment or a later command.
  const installsSdk = (code) =>
    code
      .replace(/\\\\\\n/g, " ")
      .split("\\n")
      .some((line) => {
        const words = line.split("#")[0].trim().split(/\\s+/);
        const at = words.findIndex(
          (word, index) =>
            /^(?:npm|pnpm|yarn|bun|nub|aube)$/.test(word) && /^(?:i|install|add)$/.test(words[index + 1] ?? ""),
        );
        if (at === -1) return false;
        const end = words.findIndex((word, index) => index > at && /^(?:&&|\\|\\||;|\\|)$/.test(word));
        return words
          .slice(at + 2, end === -1 ? undefined : end)
          .some((word) => /^@opencoredev\\/social-sdk(?:@[^\\s/]+)?$/.test(word));
      });
  // Blume adds a copy button inside each code block, or to the tab bar of a
  // tabbed block, where it copies the visible tab's code.
  const copiedBlock = (button) => {
    const own = button.closest("pre");
    if (own) return own;
    const tabs = button.closest("blume-tabs, blume-panel-tabs");
    const panels = Array.from(tabs?.querySelector(":scope > [data-blume-tab-content]")?.children ?? []);
    const visible = panels.find((panel) => !panel.classList.contains("hidden")) ?? panels[0];
    return visible?.matches("pre") ? visible : (visible?.querySelector("pre") ?? null);
  };
  const where = () => {
    const page = location.pathname;
    const surface = page === "/" ? "landing" : page === "/docs" || page.startsWith("/docs/") ? "docs" : "site";
    return { surface, page };
  };
  const outbound = (target) => {
    const to = destination(target.closest("a[href]")?.getAttribute("href") ?? "");
    if (to) send("outbound_click", { destination: to, ...where() });
    return to !== null;
  };
  // A middle click opens a link in a new tab and fires auxclick, not click.
  document.addEventListener(
    "auxclick",
    (event) => {
      if (event.button === 1 && event.target instanceof Element) outbound(event.target);
    },
    { capture: true },
  );
  document.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element) || outbound(event.target)) return;
      const { surface, page } = where();
      if (event.target.closest('[data-cta="install_copy"]'))
        return send("install_command_copy", { surface, page });
      const button = event.target.closest("[data-blume-copy]");
      if (!button) return;
      const block = copiedBlock(button);
      send("docs_code_copy", { surface, page, language: block?.dataset.language ?? "Text" });
      if (installsSdk(block?.textContent ?? "")) send("install_command_copy", { surface, page });
    },
    { capture: true },
  );
})();`;

const POSTHOG_KEY = "phc_CdT9A2MqdyY8WhzQkNZRRengT93aQenEbQxeERaog5Bw";

const POSTHOG_HOST = "https://y.social-sdk.dev";

/** Ingestion settings for server-side events, such as `scripts/growth-snapshot.ts`. */
export const analyticsIngestion = { host: POSTHOG_HOST, key: POSTHOG_KEY };

// PostHog's official array.js loader. With a reverse-proxy host it loads
// `${api_host}/static/array.js`, which the proxy forwards to PostHog.
const POSTHOG_LOADER =
  '!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId captureTraceFeedback captureTraceMetric".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);';

export const posthogScript = `(() => {
  const stripQuery = (value) => {
    if (typeof value !== "string") return value;
    try {
      const url = new URL(value);
      return url.origin + url.pathname;
    } catch {
      return value;
    }
  };
  const classify = (rawPath) => {
    const path = rawPath.replace(/\\/+$/, "") || "/";
    const relativePath = path === "/docs" ? "/" : path.startsWith("/docs/") ? path.slice(5) : null;
    if (relativePath === null) return null;
    const platform = relativePath.match(/^\\/platforms\\/([^/]+)/)?.[1];
    const integration = relativePath.match(/^\\/integrations\\/([^/]+)/)?.[1];
    if (platform) return ["sdk_platform_interest", { platform }];
    if (integration) return ["sdk_integration_interest", { integration }];
    if (relativePath === "/getting-started/installation") return ["sdk_install_interest", {}];
    if (relativePath === "/getting-started/mock-quickstart") return ["sdk_quickstart_interest", {}];
    return null;
  };
  const track = (path, url) => {
    const event = classify(path);
    if (!event) return;
    // A queued visit keeps its own URL instead of the page PostHog started on.
    client.capture(event[0], url ? { ...event[1], $current_url: url, $pathname: path } : event[1]);
  };
  // Routes visited before PostHog starts wait here, so a quick hop through the
  // docs still records each page.
  const pending = [];
  // Events a page reports through window.siteTrack before PostHog starts. One
  // reported just before the visitor leaves, such as a click on a landing-page
  // link, is kept in sessionStorage so the next page sends it.
  const carryKey = "siteTrackQueued";
  const takeCarried = () => {
    try {
      const carried = JSON.parse(sessionStorage.getItem(carryKey) ?? "[]");
      sessionStorage.removeItem(carryKey);
      return Array.isArray(carried) ? carried : [];
    } catch {
      return [];
    }
  };
  const queued = takeCarried();
  // The loaded SDK instance. Until it exists, window.posthog is the loader's stub.
  let client = null;
  let started = false;
  // A page restored from the back/forward cache doesn't run this script again,
  // so it picks up what the page the visitor came back from carried.
  addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    for (const [name, properties] of takeCarried()) {
      if (started) client.capture(name, properties, { send_instantly: true });
      else queued.push([name, properties]);
    }
  });
  addEventListener("pagehide", () => {
    if (started || queued.length === 0) return;
    try {
      // Another page of this tab may have carried events since this one loaded,
      // such as a page left before a back/forward cache restore of this one.
      const carried = JSON.parse(sessionStorage.getItem(carryKey) ?? "[]");
      sessionStorage.setItem(carryKey, JSON.stringify([...(Array.isArray(carried) ? carried : []), ...queued]));
      // A page restored from the back/forward cache must not send them again.
      queued.length = 0;
    } catch {
      // Storage is blocked, so the queued events end with this page.
    }
  });
  // Pages report their own events here, such as the Cloud waitlist signup, so
  // only this file talks to the analytics service.
  window.siteTrack = (event, properties) => {
    // The Databuddy loader's send queues an event until its tracker has run, and
    // drops it when the tracker can't load.
    if (window.databuddySend) window.databuddySend(event, properties);
    else (window.databuddyPending ??= []).push([event, properties]);
    if (started) client.capture(event, properties, { send_instantly: true });
    // A queued event keeps the URL of the page that reported it, as queued visits do.
    else {
      const { origin, pathname } = window.location;
      queued.push([event, { ...properties, $current_url: origin + pathname, $pathname: pathname }]);
    }
  };
  const visit = () => {
    const path = window.location.pathname;
    if (started) track(path);
    else if (pending.at(-1)?.[0] !== path) pending.push([path, window.location.origin + path]);
  };
  const start = () => {
    ${POSTHOG_LOADER}
    window.posthog.init(${JSON.stringify(POSTHOG_KEY)}, {
      api_host: ${JSON.stringify(POSTHOG_HOST)},
      ui_host: "https://us.posthog.com",
      person_profiles: "identified_only",
      autocapture: false,
      capture_pageview: "history_change",
      capture_pageleave: true,
      capture_exceptions: true,
      disable_session_recording: true,
      before_send: (event) => {
        if (event?.properties) {
          for (const key of ["$current_url", "$referrer", "$session_entry_url", "$session_entry_referrer"]) {
            if (key in event.properties) event.properties[key] = stripQuery(event.properties[key]);
          }
          for (const exception of event.properties.$exception_list ?? []) {
            for (const frame of exception?.stacktrace?.frames ?? []) {
              if (frame?.filename) frame.filename = stripQuery(frame.filename);
            }
          }
        }
        return event;
      },
      // Until the SDK has loaded, window.posthog is the loader's stub, and an
      // event captured there is lost if the visitor leaves first. So events keep
      // waiting in pending and queued, and pagehide carries queued ones to the next page.
      loaded: (instance) => {
        client = instance;
        started = true;
        pending.splice(0).forEach(([path, url]) => track(path, url));
        queued.splice(0).forEach(([event, properties]) =>
          client.capture(event, properties, { send_instantly: true }),
        );
      },
    });
  };
  // astro:page-load fires on the first load and after every client-router swap.
  visit();
  document.addEventListener("astro:page-load", visit);
  const idle = () =>
    self.requestIdleCallback ? requestIdleCallback(start, { timeout: 4000 }) : setTimeout(start);
  if (document.readyState === "complete") idle();
  else addEventListener("load", idle, { once: true });
})();`;

/** Adds the PostHog snippet and the Databuddy tags to a standalone HTML page in production builds. */
/** Every page's analytics scripts, in the order its <head> runs them. */
export const headScripts = [posthogScript, databuddyScript];

export function withAnalytics(html: string): string {
  if (!import.meta.env.PROD) return html;

  const tags = headScripts.map((content) => `<script>${content}</script>\n  `).join("");

  return html.replace("</head>", `${tags}</head>`);
}
