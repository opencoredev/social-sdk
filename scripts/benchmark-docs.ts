import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dir, "..");

const output = join(root, "apps/docs/dist");

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }

  return result;
}

const assets = await Promise.all(
  (await files(output))
    .filter((path) => /\.(js|css)$/.test(path))
    .map(async (path) => {
      const bytes = await readFile(path);

      return {
        path: path.slice(output.length + 1),
        kind: path.endsWith(".js") ? "js" : "css",
        bytes: bytes.byteLength,
        gzipBytes: gzipSync(bytes).byteLength,
      };
    }),
);

const total = (kind: string) =>
  assets
    .filter((asset) => asset.kind === kind)
    .reduce(
      (sum, asset) => ({
        bytes: sum.bytes + asset.bytes,
        gzipBytes: sum.gzipBytes + asset.gzipBytes,
        files: sum.files + 1,
      }),
      { bytes: 0, gzipBytes: 0, files: 0 },
    );

const routes = await Promise.all(
  ["index.html", "docs/index.html", "docs/platforms/tiktok/index.html"].map(async (route) => {
    const html = await readFile(join(output, route), "utf8");

    const paths = [
      ...new Set(
        [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)].map((match) =>
          match[1]!.replace(/^\//, ""),
        ),
      ),
    ];

    const referenced = assets.filter((asset) => paths.includes(asset.path));

    return {
      route: route.replace(/index.html$/, ""),
      htmlBytes: Buffer.byteLength(html),
      htmlGzipBytes: gzipSync(html).byteLength,
      directlyLinkedAssets: referenced,
    };
  }),
);

const report = {
  recordedAt: new Date().toISOString(),
  runtime: `Bun ${Bun.version}`,
  methodology:
    "Static production build bytes and per-file gzip. Whole-build totals include optional search, diagram and syntax chunks. Route lists are directly linked entries, not browser transfer measurements or a complete lazy-load graph.",
  totals: { js: total("js"), css: total("css") },
  routes,
};

await mkdir(join(root, "planning/evidence"), { recursive: true });

await writeFile(
  join(root, "planning/evidence/docs-assets.json"),
  JSON.stringify(report, null, 2) + "\n",
);

console.log(JSON.stringify(report, null, 2));
