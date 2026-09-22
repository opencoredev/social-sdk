import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { upload } from "../packages/social-sdk/dist/transport/upload.js";

const chunkBytes = 256 * 1024;

const reports = [];

for (const totalBytes of [16, 128, 512].map((mib) => mib * 1024 * 1024)) {
  globalThis.gc?.();
  const before = process.memoryUsage();
  let peakArrayBuffers = before.arrayBuffers;
  let peakRss = before.rss;
  let produced = 0;
  let consumed = 0;
  let maxOutstandingBytes = 0;
  const started = performance.now();

  const result = await upload({
    url: "https://storage.example.test/upload",
    allowHost: (host) => host === "storage.example.test",
    maxBytes: totalBytes,
    source: {
      size: totalBytes,
      mimeType: "video/mp4",
      open: () =>
        new ReadableStream(
          {
            pull(controller) {
              if (produced === totalBytes) {
                controller.close();

                return;
              }

              const chunk = new Uint8Array(Math.min(chunkBytes, totalBytes - produced));
              produced += chunk.byteLength;
              controller.enqueue(chunk);
              maxOutstandingBytes = Math.max(maxOutstandingBytes, produced - consumed);
            },
          },
          { highWaterMark: 1 },
        ),
    },
    fetch: async (_url, init) => {
      assert.equal(new Headers(init.headers).has("authorization"), false);
      const reader = init.body.getReader();

      for (;;) {
        const next = await reader.read();

        if (next.done) break;
        consumed += next.value.byteLength;
        const memory = process.memoryUsage();
        peakArrayBuffers = Math.max(peakArrayBuffers, memory.arrayBuffers);
        peakRss = Math.max(peakRss, memory.rss);
      }

      return new Response(null, { status: 200 });
    },
  });

  assert.equal(result.bytes, totalBytes);
  assert.ok(
    maxOutstandingBytes <= 3 * chunkBytes,
    "Upload backpressure must keep outstanding source chunks bounded",
  );

  const report = {
    totalBytes,
    chunkBytes,
    maxOutstandingBytes,
    peakArrayBufferGrowthBytes: Math.max(0, peakArrayBuffers - before.arrayBuffers),
    peakRssGrowthBytes: Math.max(0, peakRss - before.rss),
    elapsedMs: performance.now() - started,
  };

  reports.push(report);
}

const report = {
  recordedAt: new Date().toISOString(),
  runtime: process.version,
  methodology:
    "Fresh 256 KiB chunks, sequential upload, injected consuming fetch; peak sampled at each consumed chunk. GC only between runs. No provider/network verification.",
  uploads: reports,
};

await mkdir(new URL("../planning/evidence/", import.meta.url), { recursive: true });

await writeFile(
  new URL("../planning/evidence/media-memory.json", import.meta.url),
  JSON.stringify(report, null, 2) + "\n",
);

console.log(JSON.stringify(report, null, 2));
