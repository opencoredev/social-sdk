import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const mode of ["billing", "transient", "rate-limited", "json", "utf8", "oversized"])
  it(`the documented stream loop handles ${mode} without replaying terminal errors`, async () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const page = await readFile(join(root, "apps/docs/docs/platforms/x.mdx"), "utf8");
    const sample = page.match(/```ts\n(import \{ SocialError \}[\s\S]*?)\n```/)?.[1];

    assert.ok(sample);

    const scratch = await mkdtemp(join(tmpdir(), "x-stream-docs-"));
    const script = join(scratch, "billing.mts");
    const core = join(root, "packages/social-sdk/src/index.ts");
    const platform = join(root, "packages/social-sdk/src/platforms/x.ts");

    try {
      await writeFile(
        script,
        `
import assert from "node:assert/strict";
import { connectedAccountRef } from ${JSON.stringify(core)};
import { x } from ${JSON.stringify(platform)};
let calls = 0;
const backoffs = [];
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay >= 60_000) {
    backoffs.push(delay);
    return originalSetTimeout(callback, 0, ...args);
  }
  return originalSetTimeout(callback, delay, ...args);
};
const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "1" });
const native = x({ auth: { userId: "1" }, appBearerToken: "fixture", fetch: async () => {
  calls++;
  if (${JSON.stringify(mode)} === "transient" && calls === 1) throw new Error("Offline dropped connection");
  if (calls > ${mode === "transient" || mode === "rate-limited" ? 2 : 1}) throw new Error("Unexpected reconnect");
  if (${JSON.stringify(mode)} === "rate-limited" && calls === 1) return new Response(null, { status: 429 });
  if (${JSON.stringify(mode)} === "json") return new Response("invalid JSON\\n");
  if (${JSON.stringify(mode)} === "utf8") return new Response(new Uint8Array([255]));
  if (${JSON.stringify(mode)} === "oversized") return new Response("x".repeat(1024 * 1024 + 1));
  return new Response(null, { status: 402 });
} }).native;
async function runSample() {
${sample.replace('import { SocialError } from "@opencoredev/social-sdk";', "")}
}
import { SocialError } from ${JSON.stringify(core)};
await assert.rejects(runSample(), { code: ${JSON.stringify(mode === "billing" || mode === "transient" || mode === "rate-limited" ? "billing_required" : "upstream_failure")} });
assert.equal(calls, ${mode === "transient" || mode === "rate-limited" ? 2 : 1});
if (${JSON.stringify(mode)} === "rate-limited") assert.deepEqual(backoffs, [60_000]);
`,
      );

      const result = spawnSync("node", ["--import", "tsx", script], {
        cwd: resolve(root),
        encoding: "utf8",
        timeout: 5000,
      });

      assert.equal(result.status, 0, result.stderr);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
