import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { zernio, MemoryManagedMediaStore } from "../src/cloud/zernio.js";
import { postForMe } from "../src/cloud/post-for-me.js";

for (const provider of ["zernio", "post-for-me"] as const) {
  it(`${provider} reuses opaque account-bound media across adapter reconstruction`, async () => {
    const store = new MemoryManagedMediaStore();
    const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "a1" });
    const make = provider === "zernio" ? zernio : postForMe;
    let calls = 0;

    const config = {
      apiKey: "test",
      mediaStore: store,
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.equal(
          provider === "zernio" ? body.mediaItems[0].url : body.media[0].url,
          "https://media.example.test/image.jpg",
        );

        return provider === "zernio"
          ? Response.json({
              post: {
                _id: "p1",
                status: "pending",
                platforms: [{ accountId: "a1", platform: "twitter", status: "pending" }],
              },
            })
          : Response.json({ id: "p1", status: "scheduled", social_accounts: ["a1"] });
      },
    };

    const first = createSocial({ backend: make(config) });

    const ref = await first.media.upload(
      {
        kind: "image",
        mimeType: "image/jpeg",
        source: { kind: "https-url", url: "https://media.example.test/image.jpg" },
      },
      account,
    );

    assert.equal(calls, 0);
    assert.ok(!JSON.stringify(ref).includes("https:"));
    const second = createSocial({ backend: make(config) });

    const request = {
      targets: [{ account }],
      content: {
        text: "Image",
        media: [
          {
            kind: "image" as const,
            mimeType: "image/jpeg",
            source: { kind: "media-ref" as const, ref },
          },
        ],
      },
    };

    assert.equal(second.posts.prepare(request).ok, true);
    await second.posts.publish(request);
    assert.equal(calls, 1);
    assert.equal(
      second.posts.prepare({
        ...request,
        targets: [{ account: { ...account, accountId: "other" } }],
      }).ok,
      false,
    );
  });
}

it("managed media expiry and kind mismatches fail before any post request", async () => {
  const store = new MemoryManagedMediaStore();
  const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "a1" });
  const ref = { ...account, kind: "media" as const, mediaId: "expired" };
  await store.put({
    ref,
    publicUrl: "https://media.example.test/image.jpg",
    expiresAt: "2020-01-01T00:00:00Z",
    kind: "image",
    mimeType: "image/jpeg",
  });
  let calls = 0;

  const social = createSocial({
    backend: zernio({
      apiKey: "test",
      mediaStore: store,
      fetch: async () => {
        calls++;
        throw new Error("must not run");
      },
    }),
  });

  const result = await social.posts.publish({
    targets: [{ account }],
    content: {
      text: "expired",
      media: [{ kind: "image", mimeType: "image/jpeg", source: { kind: "media-ref", ref } }],
    },
  });

  assert.equal(result.outcomes[0]?.state, "failed");
  assert.equal(calls, 0);
});
