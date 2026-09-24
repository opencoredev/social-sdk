/**
 * Fails CI when lint rules are weakened instead of satisfied.
 *
 * Oxlint honours inline disable directives, so a clean `oxlint` run alone
 * proves nothing once someone suppresses a rule. This check rejects every
 * directive, keeps the anti-slop rules at error severity, blocks nested or
 * alternate configs, and rejects copy-pasted SAFETY comments.
 */
import { readFile } from "node:fs/promises";

// Assembled so this file does not match its own search.
const DIRECTIVE = new RegExp(`\\b(?:oxlint|eslint)-${"disable"}|\\b(?:oxlint|eslint)-${"enable"}`);

const VENDORED = "tools/oxlint/anti-slop/";

const SOURCE = /\.(?:[cm]?[jt]sx?|astro|vue|svelte)$/;

const MAX_IDENTICAL_SAFETY_COMMENTS = 3;

const REQUIRED_RULES = [
  "oxc/no-accumulating-spread",
  "anti-slop/no-array-filter-map",
  "anti-slop/no-reduce-accumulator-copy",
  "anti-slop/no-chained-type-assertions",
  "anti-slop/no-conditional-empty-object-spread",
  "anti-slop/no-known-value-widening",
  "anti-slop/no-module-mocking",
  "anti-slop/no-object-parameters",
  "anti-slop/no-reflect-apply",
  "anti-slop/no-reflect-get",
  "anti-slop/no-runtime-typeof",
  "anti-slop/no-shape-in-symbol-names",
  "anti-slop/no-unknown-parameters",
  "anti-slop/no-unknown-returns",
  "anti-slop/no-unknown-type-aliases",
  "anti-slop/no-unsafe-dictionary-type",
  "anti-slop/no-widen-then-assert",
  "anti-slop/require-readable-spacing",
  "anti-slop/require-safety-comment-for-type-assertion",
];

// The only rule option allowed: typeof may appear inside `x is T` type guards,
// which is where the rule's own documentation says decoding belongs.
const ALLOWED_RULE_OPTIONS = new Map([
  ["anti-slop/no-runtime-typeof", JSON.stringify({ allowInTypeGuards: true })],
]);

const ALLOWED_IGNORE_PATTERNS = ["tools/oxlint/anti-slop/**"];

const failures: string[] = [];

const tracked = (
  await new Response(Bun.spawn(["git", "ls-files", "-z"], { stdout: "pipe" }).stdout).text()
)
  .split("\0")
  .filter(Boolean);

const safetyComments = new Map<string, string[]>();

for (const path of tracked) {
  if (path === "scripts/check-lint-policy.ts" || path.startsWith(VENDORED)) continue;

  const name = path.split("/").at(-1) ?? "";

  if (
    /^\.?(?:oxlintrc|eslintrc)|^(?:oxlint|eslint)\.config\./.test(name) &&
    path !== ".oxlintrc.json"
  )
    failures.push(`${path}: extra lint config; all rules live in the root .oxlintrc.json`);

  if (!SOURCE.test(path) && !name.endsWith(".json")) continue;

  const text = await readFile(path, "utf8");
  const lines = text.split("\n");

  for (const [index, line] of lines.entries()) {
    if (DIRECTIVE.test(line))
      failures.push(
        `${path}:${index + 1}: lint directive; fix the code instead of disabling the rule`,
      );

    const safety = /\bSAFETY:\s*(.+?)\s*(?:\*\/)?$/.exec(line)?.[1];

    if (safety) {
      const key = safety.toLowerCase().replaceAll(/\s+/g, " ");
      safetyComments.set(key, [...(safetyComments.get(key) ?? []), `${path}:${index + 1}`]);
    }
  }
}

for (const [comment, places] of safetyComments) {
  if (places.length > MAX_IDENTICAL_SAFETY_COMMENTS)
    failures.push(
      `SAFETY comment "${comment}" appears ${places.length} times (${places.slice(0, 3).join(", ")}, ...); ` +
        "state the invariant each assertion relies on",
    );
}

// SAFETY: .oxlintrc.json is validated against oxlint's schema by oxlint itself,
// which runs before this script in `bun run lint`.
const config = JSON.parse(await readFile(".oxlintrc.json", "utf8")) as {
  rules?: Record<string, string | [string, object]>;
  overrides?: object[];
  ignorePatterns?: string[];
  jsPlugins?: string[];
};

if (config.overrides?.length) failures.push(".oxlintrc.json: overrides are not allowed");

for (const pattern of config.ignorePatterns ?? []) {
  if (!ALLOWED_IGNORE_PATTERNS.includes(pattern))
    failures.push(`.oxlintrc.json: ignore pattern "${pattern}" is not allowed`);
}

if (!config.jsPlugins?.includes("./tools/oxlint/anti-slop/index.js"))
  failures.push(".oxlintrc.json: the anti-slop plugin must stay enabled");

for (const rule of REQUIRED_RULES) {
  const setting = config.rules?.[rule];
  const [severity, options] = Array.isArray(setting) ? setting : [setting, undefined];

  if (severity !== "error") failures.push(`.oxlintrc.json: ${rule} must be "error"`);

  if (options !== undefined && JSON.stringify(options) !== ALLOWED_RULE_OPTIONS.get(rule))
    failures.push(`.oxlintrc.json: ${rule} options may not be changed`);
}

for (const path of tracked.filter((file) => file.endsWith("package.json"))) {
  // SAFETY: tracked package.json files are parsed by Bun on install, so they are
  // valid manifests whose optional `scripts` field maps names to commands.
  const scripts = (JSON.parse(await readFile(path, "utf8")) as { scripts?: Record<string, string> })
    .scripts;

  for (const [name, command] of Object.entries(scripts ?? {})) {
    if (
      /\boxlint\b[^&|;]*\s(?:-A|--allow|-W|--warn|-c|--config|--ignore-pattern|--quiet|--disable-\S+)/.test(
        command,
      )
    )
      failures.push(`${path}: script "${name}" weakens oxlint with CLI flags`);
  }
}

if (failures.length) {
  console.error(`Lint policy failed with ${failures.length} problem(s):\n`);

  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log("Lint policy holds: no directives, no weakened rules, no boilerplate SAFETY comments.");
