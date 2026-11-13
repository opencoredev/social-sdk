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
 */
export const databuddyScript = `(() => {
  const tags = ${JSON.stringify(databuddyTags)};
  // Scripts that ran while their tag was attached or failed to download, and
  // the latest tag per script.
  const settled = new Set();
  const latest = new Map();
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
      tag.onerror = () => settled.add(src);
      latest.set(src, tag);
      document.head.append(tag);
    }
  };
  load();
  document.addEventListener("astro:page-load", load);
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
    window.posthog.capture(event[0], url ? { ...event[1], $current_url: url } : event[1]);
  };
  // Routes visited before PostHog starts wait here, so a quick hop through the
  // docs still records each page.
  const pending = [];
  // Events a page reports through window.siteTrack before PostHog starts. One
  // reported just before the visitor leaves, such as a click on a landing-page
  // link, is kept in sessionStorage so the next page sends it.
  const carryKey = "siteTrackQueued";
  const queued = (() => {
    try {
      const carried = JSON.parse(sessionStorage.getItem(carryKey) ?? "[]");
      sessionStorage.removeItem(carryKey);
      return Array.isArray(carried) ? carried : [];
    } catch {
      return [];
    }
  })();
  let started = false;
  addEventListener("pagehide", () => {
    if (started || queued.length === 0) return;
    try {
      sessionStorage.setItem(carryKey, JSON.stringify(queued));
    } catch {
      // Storage is blocked, so the queued events end with this page.
    }
  });
  // Pages report their own events here, such as the Cloud waitlist signup, so
  // only this file talks to the analytics service.
  window.siteTrack = (event, properties) => {
    // Databuddy loads on its own schedule, so an event sent before its tracker
    // has run waits in window.databuddyPending until the Databuddy loader sends it.
    if (window.databuddy) window.databuddy.track(event, properties);
    else (window.databuddyPending ??= []).push([event, properties]);
    if (started) window.posthog.capture(event, properties, { send_instantly: true });
    else queued.push([event, properties]);
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
          event.properties.$current_url = stripQuery(event.properties.$current_url);
          event.properties.$referrer = stripQuery(event.properties.$referrer);
        }
        return event;
      },
    });
    started = true;
    pending.forEach(([path, url]) => track(path, url));
    queued.forEach(([event, properties]) =>
      window.posthog.capture(event, properties, { send_instantly: true }),
    );
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
export function withAnalytics(html: string): string {
  if (!import.meta.env.PROD) return html;

  return html.replace(
    "</head>",
    `<script>${posthogScript}</script>\n  <script>${databuddyScript}</script>\n  </head>`,
  );
}
