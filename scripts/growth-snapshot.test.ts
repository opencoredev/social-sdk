import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const script = fileURLToPath(new URL("growth-snapshot.ts", import.meta.url));

const stub = fileURLToPath(new URL("fixtures/growth-snapshot-fetch.ts", import.meta.url));

interface Run {
  readonly status: number | null;
  readonly output: string;
  readonly starEvents: number;
  readonly events: number;
}

/** Runs the real script as a dry run against the offline fetch stub. */
function snapshot(mode: string, tokens: Readonly<Record<string, string>> = {}): Run {
  // Only what bun needs to start, so tokens from the caller's shell never leak in.
  const env = {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
    GITHUB_ACTIONS: "true",
    GROWTH_STUB: mode,
    ...tokens,
  };

  const result = spawnSync("bun", ["--preload", stub, script, "--dry-run"], {
    encoding: "utf8",
    env,
    timeout: 30_000,
  });

  const lines = result.stdout.split("\n");

  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    starEvents: lines.filter((line) => line.includes('"event":"growth_github_stars"')).length,
    events: lines.filter((line) => line.startsWith("{")).length,
  };
}

it("sends star events when stargazers can be listed", () => {
  const run = snapshot("ok");

  assert.equal(run.status, 0, run.output);
  assert.equal(run.starEvents, 30);
});

for (const mode of ["403", "401", "403-page-2"])
  it(`skips stars with a warning and passes when stargazers answer ${mode}`, () => {
    const run = snapshot(mode);

    assert.equal(run.status, 0, run.output);
    assert.equal(run.starEvents, 0);
    assert.match(run.output, /^::warning::GitHub stars: skipped, stargazers answered 40[13]/m);
    // npm downloads, npm versions and repository totals are still sent.
    assert.equal(run.events, 3);
  });

for (const mode of [
  "403-rate-limit-header",
  "403-secondary-rate-limit",
  "403-abuse-detection",
  "500",
  "malformed",
])
  it(`fails the job when stargazers answer ${mode}`, () => {
    const run = snapshot(mode);

    assert.equal(run.status, 1, run.output);
    assert.equal(run.starEvents, 0);
    assert.match(run.output, /^GitHub stars: failed/m);
    assert.equal(run.events, 3);
  });

it("still fails the job when another section fails", () => {
  const run = snapshot("npm-500");

  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /^npm downloads: failed/m);
  assert.match(run.output, /^::warning::GitHub stars: skipped/m);
});

it("lists stargazers with GROWTH_GITHUB_TOKEN before GITHUB_TOKEN", () => {
  const run = snapshot("growth-token-only", {
    GITHUB_TOKEN: "workflow-token",
    GROWTH_GITHUB_TOKEN: "growth-token",
  });

  assert.equal(run.status, 0, run.output);
  assert.equal(run.starEvents, 30);
});

it("names GITHUB_TOKEN in the warning when it is the only token", () => {
  const run = snapshot("growth-token-only", { GITHUB_TOKEN: "workflow-token" });

  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /stargazers answered 403 to GITHUB_TOKEN;/);
});
