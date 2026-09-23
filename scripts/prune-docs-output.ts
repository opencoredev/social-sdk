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

// Blume writes the same index to llms.txt and to index.md, which is what the
// homepage serves to agents that ask for Markdown. Both get when-to-use guidance
// under the summary, and the custom Astro routes (landing, about, contact,
// privacy) that Blume's generated index leaves out.
const guidance = `
## When to use Social SDK

Use Social SDK when server-side TypeScript or JavaScript code (Node.js 22.12+ or Bun) needs to:

- Publish text, images, or video to Bluesky, Instagram, LinkedIn, Threads, TikTok, X, or YouTube through one typed client.
- Read posts, post metrics, search results, the social graph, notifications, or analytics reports from those platforms.
- Handle comments, direct messages, and verified platform webhooks.
- Send the same calls through the Zernio or Post for Me managed backends instead of each platform's API.
- Build and test a social feature offline with a deterministic mock backend, without credentials or billable calls.

It is not the right tool for browser-only code (credentials must stay on a server), for a hosted scheduler or dashboard (Social SDK is a library with no hosted service), or for accounts your application is not authorized to act for.

## How an agent should use it

1. Install the package: \`npm install @opencoredev/social-sdk\` or \`bun add @opencoredev/social-sdk\`.
2. Start with \`mockBackend\` from \`@opencoredev/social-sdk/testing\`, following the [Quickstart](https://social-sdk.dev/docs/getting-started/mock-quickstart).
3. Import only the adapters you need from their subpaths, such as \`@opencoredev/social-sdk/x\` or \`@opencoredev/social-sdk/cloud/zernio\`. Check an operation against the [capability matrix](https://social-sdk.dev/docs/reference/capabilities) before calling it.
4. Treat each target's outcome separately. A processing or uncertain outcome is not a published post.
5. Use the offline CLI to discover adapters and validate requests without network calls: \`npx @opencoredev/social-sdk adapters --json\` or \`npx @opencoredev/social-sdk validate --adapter mock --file request.json --json\`. See the [CLI reference](https://social-sdk.dev/docs/reference/cli).
6. Follow [Integrate with an agent](https://social-sdk.dev/docs/agents/integrate-social-sdk) and the [integration checklist](https://social-sdk.dev/docs/agents/integration-checklist) for connections, tenant authorization, and webhooks.

## Packages and source

- [npm package](https://www.npmjs.com/package/@opencoredev/social-sdk): \`@opencoredev/social-sdk\`, including the \`social-sdk\` CLI.
- [Source on GitHub](https://github.com/opencoredev/social-sdk): MIT-licensed source, issues, and changelog.
`;

const site = `
## Site

- [Social SDK home](https://social-sdk.dev/): The landing page for the typed social platform toolkit.
- [About](https://social-sdk.dev/about): What Social SDK is, what it is not, and who maintains it.
- [Contact](https://social-sdk.dev/contact): Where to report bugs, ask questions, and raise security issues.
- [Privacy](https://social-sdk.dev/privacy): What the website records and what the SDK never collects.
`;

for (const name of ["llms.txt", "index.md"]) {
  const path = `${directory}/${name}`;
  const index = await readFile(path, "utf8");

  if (index.includes("## When to use Social SDK")) continue;

  // Insert after the "> summary" line that follows the title.
  const summary = index.match(/^> .*\n/m);

  if (!summary || summary.index === undefined)
    throw new Error(`${name} is missing the summary line the guidance follows.`);

  const end = summary.index + summary[0].length;

  await writeFile(path, `${index.slice(0, end)}${guidance}${index.slice(end).trimEnd()}\n${site}`);
  console.log(`Added agent guidance and site pages to ${name}.`);
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
