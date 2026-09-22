import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir, cpus, platform, arch } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createSocial, connectedAccountRef } from "../packages/social-sdk/src/index.js";
import { mockBackend } from "../packages/social-sdk/src/testing/index.js";

const root = resolve(import.meta.dir, "..");

const temporary = await mkdtemp(join(tmpdir(), "social-sdk-benchmark-"));

const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);

  return {
    p50Ms: sorted[Math.floor(sorted.length * 0.5)]!,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)]!,
    samples: sorted.length,
  };
};

try {
  const bundles: Record<string, { minifiedBytes: number; gzipBytes: number }> = {};

  for (const [name, source] of Object.entries({
    core: "export { createSocial } from './packages/social-sdk/src/index.ts';",
    managed:
      "export { createSocial } from './packages/social-sdk/src/index.ts'; export { zernio } from './packages/social-sdk/src/cloud/zernio.ts';",
  })) {
    const entry = join(temporary, `${name}.ts`);
    await writeFile(entry, source.replaceAll("'./packages/", `'${root}/packages/`));
    const build = await Bun.build({ entrypoints: [entry], target: "browser", minify: true });

    if (!build.success || build.outputs.length !== 1) throw new Error("Benchmark bundle failed");
    const bytes = new Uint8Array(await build.outputs[0]!.arrayBuffer());
    bundles[name] = { minifiedBytes: bytes.byteLength, gzipBytes: gzipSync(bytes).byteLength };
  }

  const backend = mockBackend();
  const social = createSocial({ backend });

  const request = {
    content: { text: "Representative local preparation with a link https://example.test/update" },
    targets: Array.from({ length: 20 }, (_, index) => ({
      account: connectedAccountRef({
        backend: "default",
        platform: "bluesky",
        accountId: `account-${index}`,
      }),
    })),
  };

  const coldStart = performance.now();
  social.posts.prepare(request);
  const coldPrepareMs = performance.now() - coldStart;
  const prep: number[] = [];

  for (let index = 0; index < 1100; index++) {
    const started = performance.now();
    const result = social.posts.prepare(request);

    if (!result.ok) throw new Error("Invalid benchmark fixture");

    if (index >= 100) prep.push(performance.now() - started);
  }

  const single = { ...request, targets: request.targets.slice(0, 1) };
  const dispatch: number[] = [];

  for (let index = 0; index < 250; index++) {
    backend.testing.reset();
    const started = performance.now();
    const result = await social.posts.publish(single);

    if (result.outcomes[0]?.state !== "published") throw new Error("Mock dispatch failed");

    if (index >= 50) dispatch.push(performance.now() - started);
  }

  const baseline: number[] = [];

  for (let index = 0; index < 200; index++) {
    const started = performance.now();
    await Promise.resolve({ state: "published" });
    baseline.push(performance.now() - started);
  }

  const report = {
    recordedAt: new Date().toISOString(),
    runner: { platform: platform(), architecture: arch(), cpu: cpus()[0]?.model, bun: Bun.version },
    methodology: {
      prepareTargets: 20,
      prepareWarmup: 100,
      dispatchTargets: 1,
      dispatchWarmup: 50,
      baseline: "One resolved async mock transport; no upstream latency",
      bundles:
        "Bun browser ESM bundle, minified then gzip; all runtime exports of the selected entry retained",
    },
    bundles,
    preparation: { coldMs: coldPrepareMs, ...summary(prep) },
    dispatch: summary(dispatch),
    baseline: summary(baseline),
    dispatchOverheadP95Ms: Math.max(0, summary(dispatch).p95Ms - summary(baseline).p95Ms),
  };

  await mkdir(join(root, "planning/evidence"), { recursive: true });
  await writeFile(
    join(root, "planning/evidence/performance.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));

  if (bundles["core"]!.gzipBytes > 15 * 1024 || bundles["managed"]!.gzipBytes > 40 * 1024)
    throw new Error("Bundle budget exceeded; record and fix the cause without dropping validation");
  let baselineText: string | undefined;

  try {
    baselineText = await readFile(
      join(root, "planning/evidence/performance-baseline.json"),
      "utf8",
    );
  } catch {
    console.log(
      "No local performance baseline (planning/ is untracked); bundle budgets checked, regression comparison skipped.",
    );
  }

  if (baselineText !== undefined) {
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
    const recorded = JSON.parse(baselineText) as {
      preparationP95Ms: number;
      dispatchOverheadP95Ms: number;
      regressionMultiplier: number;
      noiseFloorMs: number;
    };

    for (const [name, current, previous] of [
      ["preparation", report.preparation.p95Ms, recorded.preparationP95Ms],
      ["dispatch", report.dispatchOverheadP95Ms, recorded.dispatchOverheadP95Ms],
    ] as const) {
      const ceiling = Math.max(recorded.noiseFloorMs, previous * recorded.regressionMultiplier);

      if (current > ceiling)
        throw new Error(
          `${name} p95 ${current} ms exceeds baseline regression allowance ${ceiling} ms; investigate before updating the recorded baseline`,
        );
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
