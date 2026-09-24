/**
 * Fails CI when lint rules are weakened instead of satisfied.
 *
 * Oxlint honours inline disable directives, so a clean `oxlint` run alone
 * proves nothing once someone suppresses a rule. This check rejects every
 * directive, keeps the anti-slop rules at error severity, blocks nested or
 * alternate configs, and rejects copy-pasted SAFETY comments.
 */
import { readFile } from "node:fs/promises";
import type { JsonObject, JsonValue } from "../packages/social-sdk/src/core/types.js";
import {
  isJsonArray,
  isJsonObject,
  isString,
  type JsonField,
} from "../packages/social-sdk/src/transport/validation.js";

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

const REQUIRED_PLUGINS = ["typescript", "unicorn", "oxc"];

const REQUIRED_JS_PLUGINS = ["./tools/oxlint/anti-slop/index.js"];

// Steps in .github/workflows/lint.yml that must stay, so the checks cannot be skipped in CI.
const REQUIRED_WORKFLOW_STEPS = [
  "run: bun run lint",
  "run: bun scripts/check-anti-slop-bundle.ts",
  "run: bun run format:check",
];

const failures: string[] = [];

function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;

  if (typeof value === "number") return Number.isFinite(value);

  if (Array.isArray(value)) return value.every(isJson);

  return typeof value === "object" && Object.values(value).every(isJson);
}

/** Read a tracked JSON file; a file that is not a JSON object fails the policy. */
async function readJsonObject(path: string): Promise<JsonObject> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));

  if (isJson(parsed) && isJsonObject(parsed)) return parsed;

  failures.push(`${path}: must contain a JSON object`);

  return {};
}

function objectField(value: JsonField): JsonObject {
  return isJsonObject(value) ? value : {};
}

function stringList(value: JsonField): string[] {
  return isJsonArray(value) ? value.filter(isString) : [];
}

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

const config = await readJsonObject(".oxlintrc.json");

const rules = objectField(config["rules"]);

const categories = objectField(config["categories"]);

const plugins = stringList(config["plugins"]);

const jsPlugins = stringList(config["jsPlugins"]);

if (config["overrides"] !== undefined) failures.push(".oxlintrc.json: overrides are not allowed");

for (const pattern of isJsonArray(config["ignorePatterns"]) ? config["ignorePatterns"] : []) {
  if (!isString(pattern) || !ALLOWED_IGNORE_PATTERNS.includes(pattern))
    failures.push(`.oxlintrc.json: ignore pattern ${JSON.stringify(pattern)} is not allowed`);
}

for (const plugin of REQUIRED_PLUGINS) {
  if (!plugins.includes(plugin))
    failures.push(`.oxlintrc.json: the ${plugin} plugin must stay enabled`);
}

for (const plugin of REQUIRED_JS_PLUGINS) {
  if (!jsPlugins.includes(plugin))
    failures.push(`.oxlintrc.json: the ${plugin} plugin must stay enabled`);
}

if (categories["correctness"] !== "error")
  failures.push('.oxlintrc.json: the correctness category must be "error"');

for (const [category, severity] of Object.entries(categories)) {
  if (severity !== "error")
    failures.push(`.oxlintrc.json: category "${category}" may only be raised to "error"`);
}

for (const [rule, setting] of Object.entries(rules)) {
  const severity = isJsonArray(setting) ? setting[0] : setting;

  // Oxlint also accepts numeric severities: 0 is off, 1 is warn.
  if (["off", "allow", "warn", "0", "1"].includes(String(severity)))
    failures.push(`.oxlintrc.json: ${rule} may not be turned off or down to a warning`);
}

const workflow = await readFile(".github/workflows/lint.yml", "utf8");

for (const step of REQUIRED_WORKFLOW_STEPS) {
  if (!workflow.includes(step))
    failures.push(`.github/workflows/lint.yml: the "${step}" step must stay`);
}

for (const rule of REQUIRED_RULES) {
  const setting = rules[rule];
  const [severity, options] = isJsonArray(setting) ? setting : [setting, undefined];

  if (severity !== "error") failures.push(`.oxlintrc.json: ${rule} must be "error"`);

  if (options !== undefined && JSON.stringify(options) !== ALLOWED_RULE_OPTIONS.get(rule))
    failures.push(`.oxlintrc.json: ${rule} options may not be changed`);
}

for (const path of tracked.filter((file) => file.endsWith("package.json"))) {
  const scripts = objectField((await readJsonObject(path))["scripts"]);

  for (const [name, command] of Object.entries(scripts)) {
    if (
      isString(command) &&
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
