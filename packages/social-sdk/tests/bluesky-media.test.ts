import { test } from "node:test";
import assert from "node:assert/strict";
import { createSocial } from "../src/index.js";
import { bluesky } from "../src/platforms/bluesky.js";

const account = {
  kind: "connected-account" as const,
  version: 1 as const,
  backend: "default",
  platform: "bluesky" as const,
  accountId: "did:plc:test",
};

test("Bluesky caps remote image consumption before buffering the whole response", async () => {
  let produced = 0;
  let xrpcCalls = 0;

  const social = createSocial({
    backend: bluesky({
      auth: { service: "https://bsky.example", did: account.accountId, accessJwt: "fixture" },
      allowMediaHost: (host) => host === "media.example",
      fetch: async (url, init) => {
        if (new URL(String(url)).hostname !== "media.example") {
          xrpcCalls++;
          throw new Error("must not upload");
        }

        assert.equal(new Headers(init?.headers).has("authorization"), false);
        assert.equal(init?.redirect, "error");

        return new Response(
          new ReadableStream({
            pull(controller) {
              produced++;
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
          }),
          { headers: { "content-type": "image/jpeg" } },
        );
      },
    }),
  });

  const result = await social.posts.publish({
    targets: [{ account }],
    content: {
      text: "image",
      media: [
        { kind: "image", source: { kind: "https-url", url: "https://media.example/photo.jpg" } },
      ],
    },
  });

  assert.notEqual(result.outcomes[0]?.state, "published");
  assert.ok(produced <= 13);
  assert.equal(xrpcCalls, 0);
});

test("Bluesky rejects oversized Blob before reading it and bounds uncooperative media fetch", async () => {
  let reads = 0;
  const blob = new Blob([new Uint8Array(11 * 1024 * 1024)], { type: "image/jpeg" });
  blob.stream = () => {
    reads++;
    throw new Error("oversized blob should not be opened");
  };

  const social = createSocial({
    backend: bluesky({
      auth: { service: "https://bsky.example", did: account.accountId, accessJwt: "fixture" },
      allowMediaHost: () => true,
      fetch: async () => new Promise<Response>(() => {}),
    }),
  });

  const first = await social.posts.publish({
    targets: [{ account }],
    content: { media: [{ kind: "image", source: { kind: "blob", blob, fingerprint: "large" } }] },
  });

  assert.notEqual(first.outcomes[0]?.state, "published");
  assert.equal(reads, 0);
  const started = performance.now();

  const second = await social.posts.publish(
    {
      targets: [{ account }],
      content: {
        media: [
          { kind: "image", source: { kind: "https-url", url: "https://media.example/photo.jpg" } },
        ],
      },
    },
    { retryBudget: { maxAttempts: 1, maxElapsedMs: 10 } },
  );

  assert.notEqual(second.outcomes[0]?.state, "published");
  assert.ok(performance.now() - started < 1000);
});
