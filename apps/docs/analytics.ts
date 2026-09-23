// PostHog for every page on the site: the Blume docs layout loads it through
// `analytics.scripts`, and the standalone landing and brand pages inject it
// into their own <head>. One snippet keeps the config identical everywhere.
//
// Captured: pageviews and page leaves (including client-router navigations),
// JavaScript exceptions, session replays with every input masked, and the
// docs-interest events below. Autocapture stays off, and query strings are
// stripped from URLs before events leave the browser.
//
// PostHog starts once the page has loaded and the main thread is idle, so its
// bundle doesn't compete with the first paint on slow phones. Its exception
// handler only exists once that bundle runs, so starting later only misses
// errors from the page's first moments.

const POSTHOG_KEY = "phc_CdT9A2MqdyY8WhzQkNZRRengT93aQenEbQxeERaog5Bw";

const POSTHOG_HOST = "https://y.social-sdk.dev";

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
  let started = false;
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
      session_recording: { maskAllInputs: true },
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
  };
  // astro:page-load fires on the first load and after every client-router swap.
  visit();
  document.addEventListener("astro:page-load", visit);
  const idle = () =>
    self.requestIdleCallback ? requestIdleCallback(start, { timeout: 4000 }) : setTimeout(start);
  if (document.readyState === "complete") idle();
  else addEventListener("load", idle, { once: true });
})();`;

/** Adds the PostHog snippet to a standalone HTML page in production builds. */
export function withAnalytics(html: string): string {
  if (!import.meta.env.PROD) return html;

  return html.replace("</head>", `<script>${posthogScript}</script>\n  </head>`);
}
