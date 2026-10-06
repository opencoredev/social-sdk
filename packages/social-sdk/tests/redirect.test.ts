import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHttp, HttpError } from "../src/transport/http.js";
import { fetchWithoutRedirects } from "../src/transport/redirect.js";

const url = "https://api.example.test/posts";

describe("fetchWithoutRedirects", () => {
  it("sends manual redirect mode, which Cloudflare Workers accept", async () => {
    let mode: RequestRedirect | undefined;

    const response = await fetchWithoutRedirects(
      async (_input, init) => {
        mode = init?.redirect;

        return new Response("ok");
      },
      url,
      { method: "GET", redirect: "follow" },
    );

    assert.equal(mode, "manual");
    assert.equal(await response.text(), "ok");
  });

  it("rejects every redirect status with a TypeError and releases the body", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      let cancelled = false;

      await assert.rejects(
        fetchWithoutRedirects(
          async () =>
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
              { status, headers: { location: "https://elsewhere.example.test/" } },
            ),
          url,
          {},
        ),
        TypeError,
      );
      assert.equal(cancelled, true, `body of ${status} is cancelled`);
    }
  });

  it("rejects opaque redirect responses", async () => {
    const opaque = new Response(null);
    Object.defineProperty(opaque, "type", { value: "opaqueredirect" });

    await assert.rejects(
      fetchWithoutRedirects(async () => opaque, url, {}),
      TypeError,
    );
  });

  it("returns other 3xx statuses and explicitly allowed provider statuses", async () => {
    for (const status of [300, 304]) {
      const response = await fetchWithoutRedirects(
        async () => new Response(null, { status }),
        url,
        {},
      );

      assert.equal(response.status, status);
    }

    const resumeIncomplete = await fetchWithoutRedirects(
      async () => new Response(null, { status: 308, headers: { range: "bytes=0-9" } }),
      url,
      {},
      [308],
    );

    assert.equal(resumeIncomplete.status, 308);
  });
});

describe("HTTP transport redirects", () => {
  it("reports a redirected mutation as a dispatched network failure without retrying", async () => {
    let calls = 0;

    const http = createHttp({
      fetch: async () => {
        calls++;

        return new Response(null, {
          status: 307,
          headers: { location: "https://elsewhere.example.test/" },
        });
      },
    });

    await assert.rejects(
      http({ url: new URL(url), method: "POST", body: "{}" }),
      (error: unknown): error is HttpError =>
        error instanceof HttpError && error.kind === "network" && error.dispatched,
    );
    assert.equal(calls, 1);
  });
});
