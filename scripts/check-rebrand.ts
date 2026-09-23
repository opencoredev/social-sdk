/* oxlint-disable anti-slop/require-readable-spacing -- this scanner intentionally keeps compact control flow. */

import { readdir } from "node:fs/promises";

const decoder = new TextDecoder();

const allowlistedPaths = new Set([
  "LICENSE",
  "planning/START_HERE_AGENT_PROMPT.md",
  "planning/SOCIAL_SDK_MASTER_PLAN.md",
  "planning/landing-page-handoff.md",
  "planning/rebrand-inventory.md",
  // Internal removal report names the retired services; it is not shipped.
  "planning/release-readiness.md",
]);

const ignoredPrefixes = [
  ".git/",
  ".turbo/",
  "node_modules/",
  "dist/",
  "apps/docs/.blume/",
  "planning/sources/",
];

const bannedTerms = [
  ["legacy package", ["@opencoredev/", "email", "-sdk"].join("")],
  ["legacy package shorthand", ["email", "-sdk"].join("")],
  ["legacy product name", ["email", " sdk"].join("")],
  ["legacy documentation framework", ["fuma", "docs"].join("")],
  ["legacy content service", ["no", "tra"].join("")],
  ["legacy analytics service", ["post", "hog"].join("")],
  ["legacy component", ["convex", "-email"].join("")],
  ["legacy product domain", ["email", "-sdk.dev"].join("")],
];

const listed = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
  stdout: "pipe",
  stderr: "pipe",
});

if (listed.exitCode !== 0) {
  console.error(decoder.decode(listed.stderr).trim());
  process.exit(1);
}

const paths = decoder
  .decode(listed.stdout)
  .split("\n")
  .filter(Boolean)
  .filter((path) => !allowlistedPaths.has(path))
  .filter((path) => !ignoredPrefixes.some((prefix) => path.startsWith(prefix)));

// Generated assets are ignored by Git but are part of the user-facing product.
async function addBuiltFiles(directory: string): Promise<void> {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) await addBuiltFiles(path);
    else if (entry.isFile()) paths.push(path);
  }
}

await addBuiltFiles("packages/social-sdk/dist");

await addBuiltFiles("apps/docs/dist");

const findings: string[] = [];

for (const path of paths) {
  const file = Bun.file(path);
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (bytes.includes(0)) continue;

  const content = decoder.decode(bytes).toLowerCase();

  for (const [label, term] of bannedTerms) {
    let checkedContent = content;
    if (label === "legacy analytics service") {
      if (path === "apps/docs/blume.config.ts" || path === "apps/docs/analytics.ts") continue;
      // The analytics snippet is the only script allowed to name the service,
      // and it always points at the first-party proxy.
      if (path.startsWith("apps/docs/dist/") && path.endsWith(".html")) {
        checkedContent = content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (script) =>
          script.includes("https://y.social-sdk.dev") ? "" : script,
        );
      }
    }
    if (checkedContent.includes(term)) findings.push(`${path}: ${label}`);
  }
}

if (findings.length > 0) {
  console.error("Legacy identity check failed:");

  for (const finding of findings) console.error(`- ${finding}`);

  process.exit(1);
}

console.log(`Legacy identity check passed (${paths.length} files scanned).`);
