import { it } from "node:test";
import assert from "node:assert/strict";
import { bluesky } from "../src/platforms/bluesky.js";
import { tiktok } from "../src/platforms/tiktok.js";
import { SocialError } from "../src/core/errors.js";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";
import { parseJson } from "../src/transport/json.js";
import { object, string } from "../src/transport/validation.js";

const context: AdapterOperationContext = {
  backendInstance: "direct",
  correlationId: "clock",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

it("Bluesky stamps new records with the injected clock", async () => {
  const bodies: string[] = [];

  const adapter = bluesky({
    backend: "direct",
    auth: { service: "https://bsky.example", did: "did:plc:test", accessJwt: "jwt" },
    clock: () => new Date("2020-01-02T03:04:05.000Z"),
    fetch: async (_input, init) => {
      bodies.push(String(init?.body));

      return Response.json({ uri: "at://did:plc:test/app.bsky.feed.post/clock", cid: "cid" });
    },
  });

  const account = connectedAccountRef({
    backend: "direct",
    platform: "bluesky",
    accountId: "did:plc:test",
  });

  const result = await adapter.posts?.publishTarget(
    { targetIndex: 0, targetKey: "clock", account, content: { text: "hello" } },
    context,
  );

  assert.equal(result?.state, "published");
  assert.equal(bodies.length, 1);
  const record = object(object(parseJson(bodies[0] ?? "null"))["record"]);

  assert.equal(string(record["createdAt"]), "2020-01-02T03:04:05.000Z");
});

it("TikTok measures an HTTP-date Retry-After against the injected clock", async () => {
  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    clock: () => new Date("2020-01-02T03:04:05.000Z"),
    fetch: async () =>
      Response.json(
        { error: { code: "rate_limit_exceeded" } },
        { status: 429, headers: { "retry-after": "Thu, 02 Jan 2020 03:04:35 GMT" } },
      ),
  });

  const account = connectedAccountRef({
    backend: "direct",
    platform: "tiktok",
    accountId: "creator1",
  });

  assert.ok(adapter.native);
  await assert.rejects(
    adapter.native.creatorInfo(account, context),
    (error) =>
      error instanceof SocialError &&
      error.code === "rate_limited" &&
      error.retryDisposition.kind === "after-delay" &&
      error.retryDisposition.delayMs === 30_000,
  );
});
