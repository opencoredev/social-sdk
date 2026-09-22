import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";

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
