import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

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
  const pack = JSON.parse(
    await run(
      ["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      join(root, "packages/social-sdk"),
    ),
  )[0];

  const files: { path: string }[] = pack.files;

  for (const file of files) {
    if (
      !/^(dist\/|LICENSE$|README\.md$|package\.json$)/.test(file.path) ||
      /(^|\/)(\.env|planning|tests|node_modules)(\/|$)/.test(file.path)
    )
      throw new Error(`Unexpected package content: ${file.path}`);
  }

  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await run(["npm", "install", "--ignore-scripts", join(temporary, pack.filename)], temporary);

  const manifest = JSON.parse(
    await readFile(join(root, "packages/social-sdk/package.json"), "utf8"),
  );

  const exports = Object.keys(manifest.exports)
    .filter((key) => key !== "./package.json")
    .map((key) => manifest.name + (key === "." ? "" : key.slice(1)));

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

    const diagnostic = JSON.parse(
      await run(
        [runtime, "node_modules/@opencoredev/social-sdk/dist/cli.js", "doctor", "--json"],
        temporary,
      ),
    );

    if (!diagnostic.ok || diagnostic.data.authenticated !== false)
      throw new Error("Packed CLI diagnostic failed");
  }

  console.log(
    `Packed consumer check passed: ${files.length} files, ${pack.size} compressed bytes, ${pack.unpackedSize} unpacked bytes.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
