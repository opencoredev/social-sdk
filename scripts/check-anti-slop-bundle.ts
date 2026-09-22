import { readFile } from "node:fs/promises";

const result = await Bun.build({
  entrypoints: ["tools/oxlint/anti-slop/index.ts"],
  format: "esm",
  target: "node",
  external: ["@oxlint/plugins"],
});

if (!result.success) throw new Error("Anti-slop plugin bundle failed to build");

const expected = await readFile("tools/oxlint/anti-slop/index.js");

const actual = Buffer.from(await result.outputs[0].arrayBuffer());

if (!expected.equals(actual))
  throw new Error(
    "tools/oxlint/anti-slop/index.js is out of date; run `bun scripts/build-anti-slop-bundle.ts`",
  );

console.log("Anti-slop plugin bundle is in sync.");
