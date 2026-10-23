// "More from OpenCore" links for the footers of the hand-drawn landing, info and
// brand pages. Each page marks the spot with <!-- @opencore-sites -->. The links
// are plain followed links on purpose: they share authority between our sites.
import { otherOpenCoreSites } from "./opencore-sites";

const items = otherOpenCoreSites("https://social-sdk.dev")
  .map((site) => `<li><a href="${site.url}">${site.name} <span>${site.description}</span></a></li>`)
  .join("");

const group = `<style>
      nav.foot-family {
        display: block;
        margin-top: 28px;
        padding: 0;
      }
      .foot-family p {
        margin: 0 0 12px;
        font-family: var(--hand);
        font-size: 21px;
        line-height: 1;
        color: var(--ink);
      }
      .foot-family ul {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
        gap: 14px 24px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .foot-family a {
        display: block;
        color: var(--ink);
        font-size: 15px;
        line-height: 1.3;
        text-decoration: none;
      }
      .foot-family span {
        display: block;
        margin-top: 2px;
        color: var(--ink-soft);
        font-size: 14px;
      }
      .foot-family a:hover {
        text-decoration: underline;
        text-underline-offset: 3px;
      }
      .foot-family a:hover span {
        text-decoration: none;
      }
      @media (max-width: 480px) {
        .foot-family ul {
          grid-template-columns: 1fr 1fr;
        }
      }
    </style>
    <nav class="foot-family" aria-labelledby="foot-family-title">
      <p id="foot-family-title">More from OpenCore</p>
      <ul>${items}</ul>
    </nav>`;

export const withOpenCoreSites = (html: string): string =>
  html.replace("<!-- @opencore-sites -->", group);
