import { it } from "node:test";
import assert from "node:assert/strict";
import { createHttp, HttpError } from "../src/transport/http.js";

it("error decoders cannot replace HTTP status on malformed, oversized, or throwing input", async () => {
  for (const text of ["not JSON", JSON.stringify({ detail: "x".repeat(17 * 1024) }), "{}"]) {
    const http = createHttp({ fetch: async () => new Response(text, { status: 409 }) });
    await assert.rejects(
      http({
        url: new URL("https://api.example.test/posts"),
        method: "POST",
        decodeErrorBody: () => {
          throw new Error("private decoder failure");
        },
      }),
      (error: unknown): error is HttpError => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.kind, "http");
        assert.equal(error.status, 409);
        assert.equal(error.data, undefined);
        assert.ok(!String(error).includes("private"));

        return true;
      },
    );
  }
});
