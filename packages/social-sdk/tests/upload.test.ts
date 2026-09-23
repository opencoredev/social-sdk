import { it } from "node:test";
import assert from "node:assert/strict";
import { httpsUrl, upload } from "../src/transport/upload.js";
import { HttpError } from "../src/transport/http.js";

it("uploads incrementally with bounded demand, no auth, no redirect, and no replay", async () => {
  let produced = 0;
  let consumed = 0;
  let opened = 0;
  let largestAhead = 0;

  const result = await upload({
    url: "https://storage.example.test/video?signature=private",
    allowHost: (host) => host === "storage.example.test",
    maxBytes: 1024 * 1024,
    maxChunkBytes: 1024,
    source: {
      mimeType: "video/mp4",
      size: 100 * 1024,
      open: () => {
        opened++;

        return new ReadableStream({
          pull(controller) {
            if (produced === 100) {
              controller.close();

              return;
            }

            produced++;
            largestAhead = Math.max(largestAhead, produced - consumed);
            controller.enqueue(new Uint8Array(1024));
          },
        });
      },
    },
    fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      assert.equal(init?.redirect, "error");
      assert.ok(init?.body instanceof ReadableStream);
      const reader = init.body.getReader();

      while (!(await reader.read()).done) consumed++;

      return new Response(null, { headers: { etag: "test-etag" } });
    },
  });

  assert.equal(opened, 1);
  assert.equal(result.bytes, 100 * 1024);
  assert.ok(largestAhead <= 3, `buffered ${largestAhead} chunks`);
});

it("splits oversized chunks and never reopens a failed stream", async () => {
  let opened = 0;
  await upload({
    url: "https://storage.example.test/video",
    allowHost: () => true,
    maxBytes: 100,
    maxChunkBytes: 10,
    source: {
      mimeType: "video/mp4",
      open: () => {
        opened++;

        return new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(11));
            c.close();
          },
        });
      },
    },
    fetch: async (_url, init) => {
      assert.ok(init?.body instanceof ReadableStream);
      const reader = init.body.getReader();
      assert.equal((await reader.read()).value?.byteLength, 10);
      assert.equal((await reader.read()).value?.byteLength, 1);

      return new Response(null);
    },
  });
  assert.equal(opened, 1);
});

it("uploads large Blobs with Content-Length and without chunked streaming", async () => {
  for (const size of [3 * 1024 * 1024, 20 * 1024 * 1024]) {
    const blob = new Blob([new Uint8Array(size)], { type: "video/mp4" });

    const result = await upload({
      url: "https://storage.example.test/video",
      allowHost: () => true,
      maxBytes: size,
      source: { mimeType: "video/mp4", size, body: blob, open: () => blob.stream() },
      fetch: async (_url, init) => {
        assert.equal(new Headers(init?.headers).get("content-length"), String(size));
        assert.equal(init?.duplex, undefined);
        assert.equal(init?.body, blob);

        return new Response(null);
      },
    });

    assert.equal(result.bytes, size);
  }
});

it("rejects Blob bodies that exceed the limit or their declared size", async () => {
  const blob = new Blob([new Uint8Array(10)], { type: "video/mp4" });
  let calls = 0;

  for (const [size, maxBytes] of [
    [10, 5],
    [8, 20],
  ] as const) {
    await assert.rejects(
      upload({
        url: "https://storage.example.test/video",
        allowHost: () => true,
        maxBytes,
        source: { mimeType: "video/mp4", size, body: blob, open: () => blob.stream() },
        fetch: async () => {
          calls++;

          return new Response(null);
        },
      }),
    );
  }

  assert.equal(calls, 0);
});

it("rejects unsafe upload URLs and untrusted storage origins", async () => {
  for (const url of [
    "http://cdn.example.test/a",
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://localhost/a",
    "https://a.local/a",
    "https://user:pass@cdn.example.test/a",
    "https://cdn.example.test:8080/a",
  ]) {
    assert.throws(() => httpsUrl(url));
  }

  await assert.rejects(
    upload({
      url: "https://attacker.example.test/a",
      allowHost: () => false,
      maxBytes: 10,
      source: {
        mimeType: "video/mp4",
        open: () => {
          throw new Error("must not open");
        },
      },
    }),
  );
});

it("upload cleanup cannot hang on an uncooperative source cancellation hook", async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const task = upload({
    url: "https://storage.example.test/upload",
    allowHost: () => true,
    maxBytes: 100,
    source: {
      mimeType: "video/mp4",
      open: () => new ReadableStream({ cancel: () => new Promise(() => {}) }),
    },
    fetch: async () => {
      throw new Error("network failed");
    },
  });

  try {
    await assert.rejects(
      Promise.race([
        task,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("cleanup hung")), 1000);
        }),
      ]),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
      (error: unknown) => error instanceof HttpError && error.kind === "network",
    );
  } finally {
    clearTimeout(timer);
  }
});
