const result = await Bun.build({
  entrypoints: ["tools/oxlint/anti-slop/index.ts"],
  format: "esm",
  target: "node",
  outfile: "tools/oxlint/anti-slop/index.js",
  external: ["@oxlint/plugins"],
});

if (!result.success) throw new Error("Anti-slop plugin bundle failed to build");
