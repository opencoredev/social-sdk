import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

type Result = { readonly code: number | null; readonly output: string };

async function run(
  label: string,
  command: string,
  args: readonly string[],
  cwd = root,
): Promise<Result> {
  process.stdout.write(`\n[release-gate] ${label}\n$ ${command} ${args.join(" ")}\n`);

  const child = spawn(command, [...args], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    output += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    output += text;
    process.stderr.write(text);
  });

  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });

  return { code, output };
}

async function required(
  label: string,
  command: string,
  args: readonly string[],
  cwd = root,
): Promise<void> {
  const result = await run(label, command, args, cwd);

  if (result.code !== 0) throw new Error(`${label} failed with exit code ${String(result.code)}`);
}

async function docsAudit(): Promise<void> {
  const result = await run("docs audit (owner deployment warning allowed)", "bun", [
    "run",
    "--cwd",
    "apps/docs",
    "audit",
    "--verbose",
  ]);

  if (result.code === 0) return;
  const summary = result.output.match(/(\d+) errors? · (\d+) warnings?/);
  const warnings = result.output.match(/⚠/g)?.length ?? 0;

  const allowed =
    summary?.[1] === "0" &&
    summary?.[2] === "1" &&
    warnings === 1 &&
    /deployment\.site is not set/.test(result.output) &&
    !/Meta description|Orphan page|broken link/i.test(result.output);

  if (!allowed)
    throw new Error(
      "Docs audit has warnings beyond the owner-dependent deployment.site configuration.",
    );
  console.log("[release-gate] accepted the single owner-dependent deployment.site warning");
}

await required("frozen dependency install", "bun", ["install", "--frozen-lockfile"]);

await required("lint", "bun", ["run", "lint"]);

await required("Anti-slop bundle sync", "bun", ["scripts/check-anti-slop-bundle.ts"]);

await required("format check", "bun", ["run", "format:check"]);

await required("workspace typecheck", "bun", ["run", "check-types"]);

await required("Bun tests", "bun", ["run", "test"]);

await required("Node tests", "bun", ["run", "test:node"]);

const exampleTests = (await readdir(resolve(root, "apps/example/tests")))
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => `apps/example/tests/${name}`);

const recipeTests = (await readdir(resolve(root, "examples/snippets")))
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => `examples/snippets/${name}`);

await required("Node example and OAuth recipe tests", "node", [
  "--import",
  "tsx",
  "--test",
  ...exampleTests,
  ...recipeTests,
]);

if (process.env["SOCIAL_NODE22_BIN"])
  await required("additional Node22 example and recipe tests", process.env["SOCIAL_NODE22_BIN"], [
    "--import",
    "tsx",
    "--test",
    ...exampleTests,
    ...recipeTests,
  ]);

await required("recipes and OAuth snippet typechecks", "bun", ["run", "recipes:check"]);

await required("OAuth snippet typecheck", "tsc", ["-p", "examples/tsconfig.oauth.json"]);

await required("deterministic operations snippets", "bun", [
  "examples/snippets/operations-reads.ts",
]);

await required("deterministic analytics snippet", "bun", [
  "examples/snippets/operations-analytics.ts",
]);

await required("backend setup snippet", "bun", ["examples/snippets/backend-quickstarts.ts"]);

await required("workspace build", "bun", ["run", "build"]);

await required("capability manifest and implementation conformance", "bun", [
  "scripts/generate-capabilities.ts",
  "--check",
]);

await required("rebrand source and built checks", "bun", ["run", "rebrand:check"]);

await required("package tarball and consumers", "bun", ["run", "pack:check"]);

await required("performance and bundle budgets", "bun", ["run", "benchmark"]);

await required("media streaming benchmark and memory budget", "bun", ["run", "benchmark:media"]);

await required("docs strict typecheck", "bun", ["run", "--cwd", "apps/docs", "check-types"]);

await required("docs strict validation", "bun", ["run", "--cwd", "apps/docs", "validate"]);

await required("docs production asset measurement", "bun", ["scripts/benchmark-docs.ts"]);

await docsAudit();

console.log("\n[release-gate] all deterministic release checks passed");
