import { it } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli.js";

async function run(args: string[], input = "{}", env: Record<string, string> = {}) {
  let output = "";

  const code = await runCli(args, {
    env,
    readInput: async () => input,
    write: (text) => {
      output += text;
    },
  });

  return { code, output, result: JSON.parse(output) };
}

it("CLI doctor checks only selected environment names without printing values or authenticating", async () => {
  const missing = await run(["doctor", "--adapter", "zernio", "--json"]);
  assert.equal(missing.code, 1);
  assert.deepEqual(missing.result.data.missingEnvironmentVariables, ["ZERNIO_API_KEY"]);

  const configured = await run(["doctor", "--adapter", "zernio", "--json"], "{}", {
    ZERNIO_API_KEY: "never-print-me",
  });

  assert.equal(configured.code, 0);
  assert.equal(configured.result.data.authenticated, false);
  assert.ok(!configured.output.includes("never-print-me"));
});

it("CLI capabilities uses each actual adapter manifest without making any network request", async () => {
  const listed = await run(["adapters", "--json"]);

  for (const adapter of listed.result.data.adapters) {
    const result = await run(["capabilities", "--adapter", adapter, "--json"]);
    assert.equal(result.code, 0);
    assert.ok(result.result.data.manifest.capabilities.length > 0);
  }
});

it("CLI validates its own example and reports invalid inputs without echoing content", async () => {
  const example = await run(["examples", "--json"]);

  const valid = await run(
    ["validate", "--file", "request.json", "--json"],
    JSON.stringify(example.result.data.request),
  );

  assert.equal(valid.code, 0);
  assert.ok(!valid.output.includes("Hello from Social SDK"));

  for (const value of ["null", '{"targets":[null]}', '{"targets":[]}', "not JSON"]) {
    const invalid = await run(["validate", "--file", "request.json", "--json"], value);
    assert.notEqual(invalid.code, 0);
  }
});

it("CLI rejects mutation/network commands and malformed options", async () => {
  for (const args of [
    ["publish"],
    ["doctor", "--live"],
    ["validate"],
    ["doctor", "--adapter"],
    ["doctor", "--adapter", "unknown"],
    ["doctor", "--adapter", "x", "--adapter", "mock"],
  ])
    assert.equal((await run(args)).code, 2);
});
