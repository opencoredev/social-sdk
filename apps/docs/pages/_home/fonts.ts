// Self-hosted Fraunces and Caveat for the hand-drawn pages. Importing the files
// through Vite gives them hashed /_astro/ URLs, which the host caches as immutable.
//
// Text first paints in system fonts sized to match Fraunces and Caveat, and the
// real fonts load right after that first paint. On a slow phone the page shows
// readable text at once instead of waiting for about 150 KB of fonts, and the late
// swap barely moves the layout. Returning visitors have the fonts cached, so they
// get them from the first paint.
import caveatLatin from "./fonts/caveat-latin.woff2?url";
// no-inline keeps this tiny file out of the HTML, which needs to fit in one round trip.
import frauncesIpa from "./fonts/fraunces-ipa.woff2?url&no-inline";
import frauncesLatin from "./fonts/fraunces-latin.woff2?url";
import { fontLoader } from "./font-loader";

// Matches the Google Fonts latin subset the files were taken from.
const latin =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";

const face = (family: string, weight: string, url: string, range: string) =>
  `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(${url}) format("woff2");unicode-range:${range}}`;

// size-adjust is the width ratio of the page text in each font, measured in
// Chromium. The vertical overrides copy the web font's metrics so line boxes match.
const fallback = (
  family: string,
  locals: string[],
  sizeAdjust: number,
  ascent: number,
  descent: number,
) => {
  const override = (metric: number) => `${((metric / sizeAdjust) * 100).toFixed(2)}%`;
  const src = locals.map((name) => `local("${name}")`).join(",");

  return `@font-face{font-family:"${family}";src:${src};size-adjust:${+(sizeAdjust * 100).toFixed(2)}%;ascent-override:${override(ascent)};descent-override:${override(descent)};line-gap-override:0%}`;
};

const serifFallbacks = `"Fraunces Georgia", "Fraunces Noto", "Fraunces Times", serif`;

const handFallbacks = `"Caveat Arial", "Caveat Roboto", sans-serif`;

// Fraunces ascends 0.978 em and descends 0.255 em; Caveat 0.96 em and 0.3 em.
const styles = [
  face("Fraunces", "100 900", frauncesLatin, latin),
  // Fraunces has no other glyphs from the IPA line under the hero heading.
  face("Fraunces", "100 900", frauncesIpa, "U+0259"),
  face("Caveat", "400 700", caveatLatin, latin),
  fallback("Fraunces Georgia", ["Georgia"], 1.045, 0.978, 0.255),
  fallback("Fraunces Noto", ["Noto Serif Regular", "NotoSerif-Regular"], 0.97, 0.978, 0.255),
  fallback("Fraunces Times", ["Times New Roman", "Liberation Serif"], 1.145, 0.978, 0.255),
  fallback("Caveat Arial", ["Arial", "Helvetica", "Liberation Sans"], 0.74, 0.96, 0.3),
  fallback("Caveat Roboto", ["Roboto"], 0.74, 0.96, 0.3),
  `:root{--font-serif:${serifFallbacks};--font-hand:${handFallbacks}}`,
  `:root.wf{--font-serif:"Fraunces",${serifFallbacks};--font-hand:"Caveat",${handFallbacks}}`,
];

const head = [
  `<style>${styles.join("\n")}</style>`,
  `<script>${fontLoader("wf", ["400 1em Fraunces", "400 1em Caveat"])}</script>`,
].join("\n");

export const withFonts = (html: string) => {
  if (!html.includes("<!-- @fonts -->"))
    throw new Error("Page is missing the <!-- @fonts --> marker.");

  return html.replace("<!-- @fonts -->", head);
};
