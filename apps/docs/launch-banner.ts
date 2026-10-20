// The gradients.sh launch announcement. Docs pages show it through Blume's
// `banner` config; the hand-drawn landing gets the same bar injected after
// <body>. Both share Blume's dismissal key, so closing it once hides it on
// every page.

// The X launch post for gradients.sh.
export const LAUNCH_POST_URL = "__X_POST_URL__";

export const LAUNCH_BANNER_ID = "gradients-sh-launch";

const STORAGE_KEY = `blume-banner:${LAUNCH_BANNER_ID}`;

// analytics.ts turns this event into a cross_promo_<action> event.
const promo = (action: string) =>
  `document.dispatchEvent(new CustomEvent('cross-promo', { detail: { action: '${action}', project: 'gradients-sh' } }))`;

const bar = `<style>
      .launch-banner {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        height: 40px;
        padding: 0 40px 0 12px;
        border-bottom: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
        font-family: var(--serif);
        font-size: 15px;
        line-height: 1;
      }
      html[data-blume-banner-hidden] .launch-banner {
        display: none;
      }
      .launch-banner a {
        overflow: hidden;
        color: var(--ink-soft);
        text-decoration: none;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .launch-banner a:hover {
        color: var(--ink);
      }
      .launch-banner b {
        color: var(--ink);
        font-weight: 560;
        text-decoration: underline;
        text-underline-offset: 4px;
      }
      .launch-banner button {
        position: absolute;
        right: 6px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 999px;
        background: none;
        color: var(--ink-soft);
        cursor: pointer;
      }
      .launch-banner button:hover {
        color: var(--ink);
        background: color-mix(in srgb, var(--ink) 8%, transparent);
      }
      @media (max-width: 640px) {
        .launch-banner {
          font-size: 13px;
        }
        .launch-banner .wide {
          display: none;
        }
      }
    </style>
    <script>
      try {
        if (localStorage.getItem("${STORAGE_KEY}"))
          document.documentElement.setAttribute("data-blume-banner-hidden", "");
      } catch {}
    </script>
    <div class="launch-banner">
      <a href="${LAUNCH_POST_URL}" target="_blank" rel="noopener" onclick="${promo("clicked")}"
        ><span class="wide">Hey, Leo here 👋 </span>I just launched <b>gradients.sh</b
        ><span class="wide">, animated gradient backgrounds for React</span>. Come check it out →</a
      >
      <button
        type="button"
        aria-label="Close announcement"
        onclick="document.documentElement.setAttribute('data-blume-banner-hidden', '');try{localStorage.setItem('${STORAGE_KEY}', '1')}catch{};${promo("dismissed")}"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>`;

/** Puts the launch banner at the top of a standalone page's body. */
export function withLaunchBanner(html: string): string {
  return html.replace("<body>", `<body>\n    ${bar}`);
}
