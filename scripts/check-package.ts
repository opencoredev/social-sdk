import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { JsonObject } from "../packages/social-sdk/src/core/types.js";
import { isJsonValue } from "../packages/social-sdk/src/transport/json.js";
import {
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
} from "../packages/social-sdk/src/transport/validation.js";

const root = resolve(import.meta.dir, "..");

try {
  await stat(join(root, "packages/social-sdk/dist"));
} catch {
  throw new Error("packages/social-sdk/dist is missing; build the package before packing");
}

/** Parses `text` and requires a JSON object; `source` names the input in errors. */
function parseObject(text: string, source: string): JsonObject {
  const value: unknown = JSON.parse(text);

  if (!isJsonValue(value) || !isJsonObject(value))
    throw new Error(`${source} must be a JSON object`);

  return value;
}

/** The fields this check reads from the first entry of `npm pack --json`. */
function decodePack(text: string) {
  const value: unknown = JSON.parse(text);
  const first = isJsonValue(value) && isJsonArray(value) ? value[0] : undefined;

  if (!isJsonObject(first)) throw new Error("npm pack --json must print an array of objects");
  const { filename, size, unpackedSize, files } = first;

  if (
    !isString(filename) ||
    !isFiniteNumber(size) ||
    !isFiniteNumber(unpackedSize) ||
    !isJsonArray(files)
  )
    throw new Error("npm pack --json omitted filename, size, unpackedSize or files");

  const paths = files.map((file) => {
    const path = isJsonObject(file) ? file["path"] : undefined;

    if (!isString(path)) throw new Error("npm pack --json listed a file without a path");

    return path;
  });

  return { filename, size, unpackedSize, paths };
}

const temporary = await mkdtemp(join(tmpdir(), "social-sdk-consumer-"));

async function run(args: string[], cwd: string) {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${stderr}\n${stdout}`);

  return stdout;
}

try {
  const pack = decodePack(
    await run(
      ["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      join(root, "packages/social-sdk"),
    ),
  );

  for (const path of pack.paths) {
    if (
      !/^(dist\/|LICENSE$|README\.md$|package\.json$)/.test(path) ||
      /(^|\/)(\.env|planning|tests|node_modules)(\/|$)/.test(path)
    )
      throw new Error(`Unexpected package content: ${path}`);
  }

  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await run(["npm", "install", "--ignore-scripts", join(temporary, pack.filename)], temporary);

  const manifest = parseObject(
    await readFile(join(root, "packages/social-sdk/package.json"), "utf8"),
    "packages/social-sdk/package.json",
  );

  const { name: packageName, exports: exportMap } = manifest;

  if (!isString(packageName) || !isJsonObject(exportMap))
    throw new Error("packages/social-sdk/package.json must declare a name and an exports object");

  const exports = Object.keys(exportMap)
    .filter((key) => key !== "./package.json")
    .map((key) => packageName + (key === "." ? "" : key.slice(1)));

  await writeFile(
    join(temporary, "consumer.mjs"),
    `
import assert from 'node:assert/strict';
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Unexpected network'); };
for (const name of ${JSON.stringify(exports)}) await import(name);
const { createSocial, connectedAccountRef } = await import('@opencoredev/social-sdk');
const { mockBackend } = await import('@opencoredev/social-sdk/testing');
const social = createSocial({ backend: mockBackend() });
const account = connectedAccountRef({ backend: 'default', platform: 'bluesky', accountId: 'demo' });
const request = { targets: [{ account }], content: { text: 'Packed consumer' } };
assert.equal(social.posts.prepare(request).ok, true);
const result = await social.posts.publish(request);
assert.equal(result.outcomes[0].state, 'published');
assert.equal(networkCalls, 0);
console.log(JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', version: typeof Bun === 'undefined' ? process.version : Bun.version, imports: ${exports.length}, networkCalls, state: result.outcomes[0].state }));
`,
  );

  for (const runtime of [
    "node",
    "bun",
    ...(process.env["SOCIAL_NODE22_BIN"] ? [process.env["SOCIAL_NODE22_BIN"]!] : []),
  ]) {
    console.log((await run([runtime, "consumer.mjs"], temporary)).trim());

    const diagnostic = parseObject(
      await run(
        [runtime, "node_modules/@opencoredev/social-sdk/dist/cli.js", "doctor", "--json"],
        temporary,
      ),
      "Packed CLI doctor output",
    );

    const data = diagnostic["data"];

    if (diagnostic["ok"] !== true || !isJsonObject(data) || data["authenticated"] !== false)
      throw new Error("Packed CLI diagnostic failed");
  }

  console.log(
    `Packed consumer check passed: ${pack.paths.length} files, ${pack.size} compressed bytes, ${pack.unpackedSize} unpacked bytes.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
