import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";

import { fontLoader } from "../apps/docs/pages/_home/font-loader.ts";

const directory = resolve(import.meta.dir, "../apps/docs/dist");

const config = await readFile(resolve(import.meta.dir, "../apps/docs/blume.config.ts"), "utf8");

if (!/\bfeedback:\s*false\b/.test(config))
  throw new Error("Feedback pruning requires feedback:false in the docs configuration.");

async function files(path: string): Promise<string[]> {
  const result: string[] = [];

  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = `${path}/${entry.name}`;

    if (entry.isDirectory()) result.push(...(await files(child)));
    else if (entry.isFile()) result.push(child);
  }

  return result;
}

const entries = await files(directory);

// Blume 1.7.1 emits this unused feedback integration chunk even with feedback:false.
// Remove only unreachable generated chunks; a referenced one is a build error.
const candidates = entries.filter((path) =>
  /^PageFeedback\.astro_astro_type_script_index_0_lang\.[\w-]+\.js$/.test(basename(path)),
);

const texts = new Map<string, string>();

for (const path of entries.filter((path) => /\.(html|js|css|json|txt|xml)$/.test(path)))
  texts.set(path, await readFile(path, "utf8"));

for (const candidate of candidates) {
  for (const [path, content] of texts)
    if (path !== candidate && content.includes(basename(candidate)))
      throw new Error(`Disabled feedback chunk is still referenced by ${path}`);
  await unlink(candidate);
}

console.log(`Removed ${candidates.length} unreachable disabled-feedback chunk(s).`);

// The root landing page is a custom Astro route, so Blume's generated llms.txt
// does not include it. Append it so the index matches the site's indexable routes.
const llmsPath = `${directory}/llms.txt`;

const llms = await readFile(llmsPath, "utf8");

if (!/\]\(\/\)/.test(llms)) {
  const entry =
    "\n## Site\n\n- [Social SDK home](/): The landing page for the typed social platform toolkit.\n";

  await writeFile(llmsPath, llms + entry);
  console.log("Appended the landing page to llms.txt.");
}

// Blume preloads Geist and uses it from the first paint, so on a slow phone the
// fonts hold back the first paint. Docs pages start in metric-matched
// fallbacks instead and switch to Geist after the first paint, the way the
// landing page loads its fonts.
//
// The sidebar's integration icons are images, and all of them load before the
// first paint even inside the closed mobile drawer. Lazy loading defers them
// until they're visible.
const deferredFontClass = "wf-geist";

// Blume's Geist fallback only names local("Arial"), which Android and most Linux
// systems don't have, so their first paint used an unadjusted system font that
// wrapped differently and shifted the page when Geist arrived. These faces cover
// the Arial clones and Roboto. size-adjust is the width of docs text in Geist
// over each font, measured in Chromium; the vertical metrics are Geist's own.
const geistFallbacks = [
  ["Geist Arial", ["Arial", "ArialMT", "Liberation Sans", "Arimo", "Helvetica"], 1.026],
  ["Geist Roboto", ["Roboto", "Roboto-Regular"], 1.029],
] as const;

const geistFallbackFaces = geistFallbacks
  .map(([family, locals, sizeAdjust]) => {
    const override = (metric: number) => `${((metric / sizeAdjust) * 100).toFixed(2)}%`;
    const src = locals.map((name) => `local("${name}")`).join(",");

    return `@font-face{font-family:"${family}";src:${src};size-adjust:${+(sizeAdjust * 100).toFixed(2)}%;ascent-override:${override(1.005)};descent-override:${override(0.295)};line-gap-override:0%}`;
  })
  .join("");

const geistFallbackFamilies = geistFallbacks.map(([family]) => `"${family}"`).join(",");

let deferredPages = 0;

for (const path of entries.filter((path) => path.endsWith(".html"))) {
  const html = await readFile(path, "utf8");

  if (!html.includes("--blume-ff-")) continue;

  const fonts = [
    ...new Set(
      [...html.matchAll(/@font-face\{font-family:("?)([^;"]+)\1;src:url\(/g)].map(
        (match) => match[2],
      ),
    ),
  ];

  let rewritten = 0;

  const deferred = html
    .replace(/<link rel="preload" href="[^"]*" as="font"[^>]*>/g, "")
    .replace(/:root\{(--blume-ff-[\w-]+):([^;}]+);\}/g, (rule, name: string, value: string) => {
      const [first = "", ...fallbacks] = value.split(",");

      if (!fonts.includes(first.replaceAll('"', ""))) return rule;

      rewritten++;

      if (name === "--blume-ff-geist") {
        const matched = [geistFallbackFamilies, ...fallbacks].join(",");

        return `${geistFallbackFaces}:root{${name}:${matched};}:root.${deferredFontClass}{${name}:${first},${matched};}`;
      }

      return `:root{${name}:${fallbacks.join(",")};}:root.${deferredFontClass}{${name}:${value};}`;
    })
    .replace(/<img (?![^>]*\bloading=)([^>]*\bsrc="\/integrations\/)/g, '<img loading="lazy" $1')
    .replace(
      "</head>",
      `<script>${fontLoader(
        deferredFontClass,
        fonts.map((font) => `400 1em "${font}"`),
      )}</script></head>`,
    );

  if (fonts.length === 0 || rewritten !== fonts.length)
    throw new Error(`Couldn't defer the Blume fonts in ${path}; check the generated font CSS.`);

  await writeFile(path, deferred);
  deferredPages++;
}

console.log(`Deferred Geist and lazy-loaded sidebar icons on ${deferredPages} docs page(s).`);
