// The Social SDK Cloud early-access page at /cloud, in the info pages'
// hand-drawn shell. The form posts to api/cloud-waitlist.ts; its options come
// from cloud-waitlist.ts so the page and the function can't disagree.
import { accountOptions, limits, platformOptions, trapField } from "../../cloud-waitlist";
import { escapeHtml } from "../_blog/render";
import { renderShell, siteMeta } from "../_info/pages";

export const cloudPage = {
  path: "/cloud",
  title: "Social SDK Cloud: early access to the hosted SDK",
  description:
    "Social SDK Cloud will be the hosted version of the open-source Social SDK, running OAuth apps, token refresh, scheduling and retries for you. Join early access.",
};

/** The one-line pointer to /cloud that the guides share, so the wording stays the same everywhere. */
export const cloudCallout = `<p class="cloud-cta"><b>Rather not run it yourself?</b> Social SDK Cloud, the hosted version, is taking early-access signups. <a href="${cloudPage.path}">Join the list</a>.</p>`;

/** The analytics event a successful signup sends through window.siteTrack (analytics.ts). It carries the answers, never the email. */
export const signupEvent = "cloud_waitlist_signup";

const styles = `<style>
      .handles {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 26px 28px;
        margin-top: 22px;
        padding: 0;
        list-style: none;
      }
      .handles li + li {
        margin-top: 0;
      }
      .handles b {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 18px;
      }
      .handles b::before {
        content: "";
        flex: none;
        width: 16px;
        height: 10px;
        background: url('data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 10"%3E%3Cpath d="M1.5 5.5 L5.5 8.5 L14.5 1.5" stroke="%23e8542f" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/%3E%3C/svg%3E')
          no-repeat center / contain;
      }
      .handles span {
        display: block;
        margin-top: 4px;
        padding-left: 24px;
        color: var(--ink-soft);
        font-size: 16px;
        line-height: 1.5;
      }
      .small-print {
        margin-top: 30px;
        color: var(--ink-soft);
        font-size: 16px;
      }
      @media (max-width: 720px) {
        .handles {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 480px) {
        .handles {
          grid-template-columns: minmax(0, 1fr);
          gap: 18px;
        }
      }
      .join {
        padding-top: 44px;
        scroll-margin-top: 24px;
      }
      .note {
        position: relative;
        padding: 40px 32px 32px;
        border: 2px solid var(--ink);
        border-radius: 6px;
        background: var(--paper);
        box-shadow: 5px 6px 0 var(--ink);
      }
      .note .tape {
        position: absolute;
        top: -15px;
        left: 50%;
        width: 120px;
        height: 30px;
        transform: translateX(-50%) rotate(-2deg);
        background: rgba(232, 84, 47, 0.18);
        border-left: 1px dashed rgba(232, 84, 47, 0.4);
        border-right: 1px dashed rgba(232, 84, 47, 0.4);
      }
      .note > p {
        margin-top: 8px;
        color: var(--ink-soft);
      }
      .note form {
        margin-top: 8px;
      }
      .field {
        margin-top: 28px;
        border: 0;
        min-width: 0;
      }
      .field > label,
      .field > legend {
        display: block;
        padding: 0;
        color: var(--ink);
        font-weight: 560;
        font-size: 18px;
      }
      .field .optional {
        color: var(--ink-soft);
        font-weight: 380;
      }
      .hint {
        margin-top: 2px;
        color: var(--ink-soft);
        font-size: 16px;
      }
      .note input[type="email"],
      .note input[type="text"],
      .note textarea {
        display: block;
        width: 100%;
        margin-top: 10px;
        padding: 11px 14px;
        border: 2px solid var(--ink);
        border-radius: 6px;
        background: var(--paper);
        color: var(--ink);
        font: inherit;
        font-size: 17px;
      }
      .note textarea {
        resize: vertical;
        min-height: 92px;
      }
      .note input:focus-visible,
      .note textarea:focus-visible {
        outline: 3px solid var(--marker);
        outline-offset: 2px;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 12px;
      }
      .chip {
        position: relative;
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        padding: 8px 16px;
        border: 2px solid var(--ink);
        border-radius: 999px;
        background: var(--paper);
        color: var(--ink);
        font-size: 16px;
        cursor: pointer;
        user-select: none;
        transition: background-color 0.15s ease, color 0.15s ease;
      }
      .chip:nth-child(3n + 1) {
        transform: rotate(-0.6deg);
      }
      .chip:nth-child(3n + 2) {
        transform: rotate(0.8deg);
      }
      .chip input {
        position: absolute;
        inset: 0;
        margin: 0;
        opacity: 0;
        cursor: pointer;
      }
      .chip:hover:not(:has(input:checked)) {
        background: rgba(232, 84, 47, 0.1);
      }
      .chip:has(input:checked) {
        background: var(--ink);
        color: var(--paper);
      }
      .chip:has(input:focus-visible) {
        outline: 3px solid var(--marker);
        outline-offset: 3px;
      }
      .other-field {
        display: none;
        margin-top: 16px;
      }
      .other-field label {
        font-size: 16px;
        color: var(--ink-soft);
      }
      .field:has(input[value="other"]:checked) .other-field {
        display: block;
      }
      .trap {
        position: absolute;
        left: -10000px;
        width: 1px;
        height: 1px;
        overflow: hidden;
      }
      .submit-row {
        margin-top: 36px;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 18px 28px;
      }
      .brush-btn {
        position: relative;
        z-index: 0;
        display: inline-block;
        padding: 15px 34px;
        border: 0;
        background: none;
        color: var(--paper);
        font: inherit;
        font-weight: 560;
        font-size: 19px;
        cursor: pointer;
        transform: rotate(-0.8deg);
        transition: transform 0.15s ease;
      }
      .brush-btn svg {
        position: absolute;
        inset: -8px -12px;
        width: calc(100% + 24px);
        height: calc(100% + 16px);
        z-index: -1;
      }
      .brush-btn svg path {
        fill: var(--ink);
      }
      .brush-btn:hover {
        transform: rotate(0.6deg) scale(1.03);
      }
      .brush-btn:active {
        transform: rotate(0.6deg) scale(0.98);
      }
      .brush-btn:focus-visible {
        outline: 3px solid var(--marker);
        outline-offset: 10px;
      }
      .brush-btn[disabled] {
        cursor: progress;
        opacity: 0.75;
      }
      @media (prefers-reduced-motion: reduce) {
        .brush-btn,
        .brush-btn:hover,
        .brush-btn:active {
          transition: none;
          transform: rotate(-0.8deg);
        }
      }
      .status {
        flex: 1 1 220px;
        color: var(--marker-text, #b93c1c);
        font-size: 16px;
      }
      .fine {
        margin-top: 26px;
        color: var(--ink-soft);
        font-size: 15px;
      }
      .done,
      #join-error {
        display: none;
      }
      #join-error:target {
        display: block;
        margin-top: 20px;
        color: var(--marker-text, #b93c1c);
        font-size: 16px;
      }
      .done:focus {
        outline: none;
      }
      .done h2 {
        font-family: var(--hand);
        font-weight: 400;
        font-size: 34px;
        color: var(--marker);
        transform: rotate(-1.2deg);
        display: inline-block;
      }
      .done p {
        margin-top: 10px;
        color: var(--ink-soft);
      }
      .join.is-joined form,
      .join.is-joined .ask,
      .join:has(#joined:target) form,
      .join:has(#joined:target) .ask {
        display: none;
      }
      .join.is-joined .done,
      #joined:target {
        display: block;
      }
      @media (max-width: 560px) {
        .note {
          padding: 34px 20px 24px;
          box-shadow: 4px 5px 0 var(--ink);
        }
        .chip {
          font-size: 15.5px;
          padding: 8px 14px;
        }
      }
      html.dark .status,
      html.dark #join-error:target {
        color: #f08a6c;
      }
      html.dark .chip:hover:not(:has(input:checked)) {
        background: rgba(232, 84, 47, 0.18);
      }
    </style>`;

function chips(
  name: string,
  type: "checkbox" | "radio",
  options: readonly { id: string; label: string }[],
): string {
  return options
    .map(
      (option) =>
        `<label class="chip"><input type="${type}" name="${name}" value="${escapeHtml(option.id)}" /><span>${escapeHtml(option.label)}</span></label>`,
    )
    .join("\n                ");
}

const content = `
        <section class="join" id="join" aria-labelledby="join-heading">
          <div class="note">
            <span class="tape" aria-hidden="true"></span>
            <h2 id="join-heading" class="ask">Join the early-access list</h2>
            <p class="ask">Only the email is required. The rest tells us which platforms to build first.</p>
            <form id="waitlist" method="post" action="/api/cloud-waitlist">
              <div class="field">
                <label for="email">Email</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autocomplete="email"
                  spellcheck="false"
                  maxlength="${limits.email}"
                />
              </div>
              <fieldset class="field">
                <legend>Which platforms do you need? <span class="optional">(pick any)</span></legend>
                <div class="chips">
                ${chips("platforms", "checkbox", platformOptions)}
                </div>
                <div class="other-field">
                  <label for="otherPlatforms">Which other platforms?</label>
                  <input id="otherPlatforms" name="otherPlatforms" type="text" maxlength="${limits.otherPlatforms}" />
                </div>
              </fieldset>
              <fieldset class="field" aria-describedby="accounts-hint">
                <legend>Roughly how many connected accounts?</legend>
                <p class="hint" id="accounts-hint">The social accounts your app would connect, across all your users.</p>
                <div class="chips">
                ${chips("accounts", "radio", accountOptions)}
                </div>
              </fieldset>
              <div class="field">
                <label for="currentTool">What do you use today?</label>
                <p class="hint" id="currentTool-hint">Your own code, a scheduling tool, an API service, or nothing yet.</p>
                <textarea
                  id="currentTool"
                  name="currentTool"
                  rows="2"
                  maxlength="${limits.currentTool}"
                  aria-describedby="currentTool-hint"
                ></textarea>
              </div>
              <div class="trap" aria-hidden="true">
                <label>Leave this empty <input name="${trapField}" type="text" tabindex="-1" autocomplete="off" /></label>
              </div>
              <p id="join-error">
                That didn't go through. Check the email address and try again, or email
                <a href="mailto:leo@social-sdk.dev">leo@social-sdk.dev</a>.
              </p>
              <div class="submit-row">
                <button class="brush-btn" type="submit">
                  <svg viewBox="0 0 300 72" preserveAspectRatio="none" aria-hidden="true">
                    <path
                      d="M14 22 C60 8, 240 4, 288 18 C298 34, 292 52, 270 60 C200 72, 60 70, 16 58 C4 46, 6 32, 14 22 Z"
                      filter="url(#roughen)"
                    />
                  </svg>
                  <span class="label">Join the list</span>
                </button>
                <p class="status" id="join-status" role="status" aria-live="polite"></p>
              </div>
              <p class="fine">
                We'll use your email only to contact you about Social SDK Cloud. To be removed,
                email <a href="mailto:leo@social-sdk.dev">leo@social-sdk.dev</a>. The
                <a href="/privacy#cloud-waitlist">privacy page</a> lists what we keep.
              </p>
            </form>
            <div class="done" id="joined" tabindex="-1">
              <h2>you're on the list.</h2>
              <p>
                We'll email you when early access opens. Until then, the open-source SDK works
                today: start with the <a href="/docs/getting-started/mock-quickstart">quickstart</a>.
              </p>
            </div>
          </div>
        </section>
        <section aria-labelledby="handles-heading">
          <h2 id="handles-heading">What Cloud will handle</h2>
          <ul class="handles">
            <li><b>Platform apps</b><span>Accounts connect through our OAuth apps, not yours.</span></li>
            <li><b>Tokens</b><span>Stored encrypted and refreshed before they expire.</span></li>
            <li><b>Scheduling</b><span>Queue posts for later without running a worker.</span></li>
            <li><b>Retries</b><span>Unclear writes are reported, never sent twice.</span></li>
            <li><b>Rate limits</b><span>We'll apply for higher quotas in each platform's app review.</span></li>
            <li><b>The same SDK</b><span>Same calls, types and outcomes as the <a href="/docs">docs</a>.</span></li>
          </ul>
          <p class="small-print">
            Cloud is in early development: the first platforms, the limits and the prices aren't
            set, and there's no launch date. The SDK stays free and MIT-licensed, and never needs
            Cloud.
          </p>
        </section>
        <script>
          (() => {
            const section = document.getElementById("join");
            const form = document.getElementById("waitlist");
            const done = document.getElementById("joined");
            if (!section || !form || !done) return;
            const status = form.querySelector(".status");
            const button = form.querySelector("button[type=submit]");
            const label = button.querySelector(".label");
            const messages = {
              email: "Enter a full email address, like you@company.com.",
              "email:no-mail": "That address's domain can't receive email. Check the spelling.",
              "email:throwaway": "Use an address you'll still read when early access opens.",
              "too-fast": "That was quick. Give it a second and press Join again.",
              "rate-limited": "Too many tries from your network. Try again in an hour, or email leo@social-sdk.dev.",
              platforms: "One of the platform choices wasn't recognized. Reload the page and try again.",
              otherPlatforms: "Keep the other platforms to ${limits.otherPlatforms} characters.",
              accounts: "Pick one of the account ranges, or leave it blank.",
              currentTool: "Keep this answer to ${limits.currentTool.toLocaleString("en-US")} characters.",
            };
            const fallback = "That didn't go through. Try again in a minute, or email leo@social-sdk.dev.";
            // The same-site page that linked here, so we can see which pages bring signups.
            const cameFrom = (() => {
              try {
                const from = new URL(document.referrer);
                return from.origin === location.origin && from.pathname !== location.pathname
                  ? from.pathname
                  : null;
              } catch {
                return null;
              }
            })();
            const text = (data, key) => {
              const value = data.get(key);
              return typeof value === "string" ? value : "";
            };
            form.addEventListener("submit", async (event) => {
              event.preventDefault();
              if (!form.reportValidity()) return;
              const data = new FormData(form);
              const platforms = data.getAll("platforms").filter((value) => typeof value === "string");
              const accounts = text(data, "accounts") || null;
              const body = {
                email: text(data, "email"),
                platforms,
                otherPlatforms: text(data, "otherPlatforms"),
                accounts,
                currentTool: text(data, "currentTool"),
                ${trapField}: text(data, "${trapField}"),
                cameFrom,
                elapsedMs: Math.round(performance.now()),
              };
              button.disabled = true;
              label.textContent = "Joining…";
              status.textContent = "";
              const email = form.elements.namedItem("email");
              email.removeAttribute("aria-invalid");
              email.removeAttribute("aria-describedby");
              try {
                const response = await fetch(form.action, {
                  method: "POST",
                  headers: { "content-type": "application/json", accept: "application/json" },
                  body: JSON.stringify(body),
                });
                const result = await response.json().catch(() => null);
                if (response.ok && result && result.ok === true) {
                  section.classList.add("is-joined");
                  done.focus();
                  window.siteTrack?.("${signupEvent}", {
                    platforms,
                    accounts,
                    came_from: cameFrom,
                  });
                  return;
                }
                const field = result && typeof result.field === "string" ? result.field : null;
                const reason = result && typeof result.reason === "string" ? result.reason : null;
                const error = result && typeof result.error === "string" ? result.error : null;
                status.textContent =
                  (field && reason && messages[field + ":" + reason]) ||
                  (field && messages[field]) ||
                  (error && messages[error]) ||
                  fallback;
                if (field === "email") {
                  email.setAttribute("aria-invalid", "true");
                  email.setAttribute("aria-describedby", "join-status");
                  email.focus();
                }
              } catch {
                status.textContent = fallback;
              } finally {
                button.disabled = false;
                label.textContent = "Join the list";
              }
            });
          })();
        </script>`;

export function renderCloudPage(): string {
  return renderShell({
    meta: [siteMeta(cloudPage), styles].join("\n    "),
    kicker: "early access, not open yet",
    heading: "Social SDK Cloud",
    lede: "Social SDK, hosted. For teams who'd rather not run platform apps, token refresh and schedulers themselves. Leave your email and we'll write when early access opens.",
    content,
  });
}
