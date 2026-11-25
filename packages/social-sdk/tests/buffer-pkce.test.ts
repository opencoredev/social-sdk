import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createBufferPkce } from "../src/cloud/buffer.js";

it("createBufferPkce returns an RFC 7636 verifier and its S256 challenge", async () => {
  const pkce = await createBufferPkce();

  // 32 random bytes encode to 43 unpadded base64url characters, the RFC 7636 minimum.
  assert.match(pkce.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    pkce.codeChallenge,
    createHash("sha256").update(pkce.codeVerifier).digest("base64url"),
  );
});

it("createBufferPkce draws a fresh verifier on every call", async () => {
  const verifiers = new Set(
    await Promise.all(
      Array.from({ length: 16 }, async () => (await createBufferPkce()).codeVerifier),
    ),
  );

  assert.equal(verifiers.size, 16);
});

it("no shipped module outside the CLI statically imports a Node.js built-in", async () => {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  // The CLI and its telemetry run only under Node.js or Bun; every adapter and server
  // helper must load on runtimes without Node built-ins. A lazy `import("node:…")` behind an
  // injectable option, such as the Bluesky OAuth DNS default, does not run at load time.
  const nodeOnly = new Set(["cli.ts", "telemetry.ts"]);
  const offenders: string[] = [];

  for (const entry of await readdir(src, { recursive: true })) {
    if (!entry.endsWith(".ts") || nodeOnly.has(entry)) continue;
    const text = await readFile(new URL(entry, new URL("../src/", import.meta.url)), "utf8");

    if (/\bfrom\s+["']node:|^import\s+["']node:|\brequire\(\s*["']node:/m.test(text))
      offenders.push(entry);
  }

  assert.deepEqual(offenders, []);
});
