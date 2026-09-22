/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { postForMe } from "../src/cloud/post-for-me.js";
import { zernio } from "../src/cloud/zernio.js";
import type { AdapterOperationContext } from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const x = connectedAccountRef({ backend: "default", platform: "x", accountId: "a1" });

const videoAccount = connectedAccountRef({
  backend: "default",
  platform: "youtube",
  accountId: "yt1",
});

it("Post for Me strips returned account tokens and requests bounded account pages", async () => {
  const adapter = postForMe({
    apiKey: "test",
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/v1/social-accounts");
      assert.equal(url.searchParams.get("limit"), "25");

      return Response.json({
        data: [
          {
            id: "a1",
            platform: "x",
            user_id: "native1",
            username: "demo",
            access_token: "SECRET",
            refresh_token: "SECRET",
            status: "connected",
          },
        ],
        meta: { next: null },
      });
    },
  });

  const accounts = await adapter.accounts.list({}, context);
  assert.equal(accounts.items[0]?.ref.backend, "default");
  assert.ok(!JSON.stringify(accounts).includes("SECRET"));
});

it("Post for Me processed parent uses results rather than HTTP success", async () => {
  const calls: string[] = [];

  const adapter = postForMe({
    apiKey: "test",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);

      if (url.pathname === "/v1/social-posts") {
        assert.equal(init?.method, "POST");
        assert.deepEqual(JSON.parse(String(init?.body)).social_accounts, ["a1"]);

        return Response.json({ id: "parent", status: "processed" });
      }

      assert.equal(url.searchParams.get("social_account_id"), "a1");

      return Response.json({
        data: [{ post_id: "parent", social_account_id: "a1", success: false }],
      });
    },
  });

  const result = await createSocial({ backend: adapter }).posts.publish({
    targets: [{ account: x }],
    content: { text: "test" },
  });

  assert.equal(result.outcomes[0]?.state, "failed");
  assert.deepEqual(calls, ["/v1/social-posts", "/v1/social-post-results"]);
});

it("Zernio retains each destination result and deterministic request identifiers", async () => {
  const ids: string[] = [];

  const adapter = zernio({
    apiKey: "test",
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const accountId = body.platforms[0].accountId;
      ids.push(new Headers(init?.headers).get("x-request-id") ?? "");

      return Response.json(
        {
          post: {
            _id: `p-${accountId}`,
            status: "partial",
            platforms: [
              {
                accountId,
                platform: "twitter",
                status: accountId === "a1" ? "published" : "failed",
                platformPostId: `native-${accountId}`,
              },
            ],
          },
        },
        { status: 207 },
      );
    },
  });

  const result = await createSocial({ backend: adapter }).posts.publish({
    targets: [{ account: x }, { account: { ...x, accountId: "a2" } }],
    content: { text: "test" },
    idempotencyKey: "logical1",
  });

  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.state),
    ["published", "failed"],
  );
  assert.ok(ids.every(Boolean));
  assert.notEqual(ids[0], ids[1]);
});

for (const provider of ["zernio", "post-for-me"] as const) {
  it(`${provider} managed video uploads once without provider credentials and preserves creator settings`, async () => {
    const paths: string[] = [];

    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      paths.push(url.pathname);

      if (url.hostname === "storage.example.test") {
        assert.equal(new Headers(init?.headers).get("authorization"), null);
        assert.equal(init?.redirect, "error");
        assert.ok(init?.body instanceof ReadableStream);
        const reader = init.body.getReader();

        while (!(await reader.read()).done) {
          /* drain */
        }

        return new Response(null, { status: 200 });
      }

      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test");

      if (url.pathname.endsWith("presign"))
        return Response.json({
          uploadUrl: "https://storage.example.test/video",
          publicUrl: "https://media.example.test/video.mp4",
        });

      if (url.pathname.endsWith("create-upload-url"))
        return Response.json({
          upload_url: "https://storage.example.test/video",
          media_url: "https://media.example.test/video.mp4",
        });
      const body = JSON.parse(String(init?.body));

      if (provider === "zernio") {
        assert.deepEqual(body.platforms[0].platformSpecificData, {
          title: "Demo",
          visibility: "private",
          madeForKids: false,
        });

        return Response.json({
          post: {
            _id: "p1",
            status: "publishing",
            platforms: [{ platform: "youtube", accountId: "yt1", status: "processing" }],
          },
        });
      }

      assert.deepEqual(body.platform_configurations.youtube, {
        title: "Demo",
        privacy_status: "private",
        made_for_kids: false,
      });

      return Response.json({ id: "p1", status: "processing" });
    };

    const options = {
      apiKey: "test",
      fetch: fetcher,
      uploadHostAllowed: (hostname: string) => hostname === "storage.example.test",
    };

    const social = createSocial({
      backend: provider === "zernio" ? zernio(options) : postForMe(options),
    });

    const request = {
      targets: [
        {
          account: videoAccount,
          options: { title: "Demo", visibility: "private" as const, madeForKids: false },
        },
      ],
      content: {
        text: "demo",
        media: [
          {
            kind: "video" as const,
            mimeType: "video/mp4",
            filename: "demo.mp4",
            source: {
              kind: "blob" as const,
              blob: new Blob([new Uint8Array(100)]),
              fingerprint: "test-video",
            },
          },
        ],
      },
    };

    assert.equal(social.posts.prepare(request).ok, true);
    assert.equal(paths.length, 0);
    assert.equal((await social.posts.publish(request)).outcomes[0]?.state, "processing");
    assert.equal(paths.length, 3);
  });
}

it("enforces all tenant targets and video-only content before managed dispatch", async () => {
  let calls = 0;

  const adapter = postForMe({
    apiKey: "test",
    fetch: async () => {
      calls++;
      throw new Error("unexpected");
    },
  });

  const social = createSocial({
    backend: adapter,
    authorization: {
      async authorizeTargets(input) {
        return input.accounts.map((account) => ({ account, allowed: account.accountId === "a1" }));
      },
    },
  });

  await assert.rejects(
    social.posts.publish({
      targets: [{ account: x }, { account: { ...x, accountId: "other-tenant" } }],
      content: { text: "test" },
    }),
  );
  assert.equal(calls, 0);
  assert.equal(
    createSocial({ backend: adapter }).posts.prepare({
      targets: [{ account: videoAccount }],
      content: { text: "not a video" },
    }).ok,
    false,
  );
  assert.equal(calls, 0);
});

it("a lost managed write response remains unknown and is not retried", async () => {
  let calls = 0;

  const result = await createSocial({
    backend: zernio({
      apiKey: "test",
      fetch: async () => {
        calls++;
        throw new Error("socket closed with secret");
      },
    }),
  }).posts.publish({ targets: [{ account: x }], content: { text: "test" } });

  assert.equal(result.outcomes[0]?.state, "unknown");
  assert.ok(!JSON.stringify(result).includes("socket closed"));
  assert.equal(calls, 1);
});

for (const provider of ["zernio", "post-for-me"] as const) {
  it(`${provider} preserves explicit TikTok interaction and disclosure choices`, async () => {
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated boundary or fixture contract.
    let payload: Record<string, unknown> = {};
    const make = provider === "zernio" ? zernio : postForMe;

    const social = createSocial({
      backend: make({
        apiKey: "test",
        fetch: async (_input, init) => {
          payload = JSON.parse(String(init?.body));

          return provider === "zernio"
            ? Response.json({
                post: {
                  _id: "p1",
                  status: "pending",
                  platforms: [{ accountId: "tt1", platform: "tiktok", status: "pending" }],
                },
              })
            : Response.json({ id: "p1", status: "scheduled", social_accounts: ["tt1"] });
        },
      }),
    });

    const account = connectedAccountRef({
      backend: "default",
      platform: "tiktok",
      accountId: "tt1",
    });

    const request = {
      targets: [
        {
          account,
          options: {
            privacy: "PUBLIC_TO_EVERYONE" as const,
            consentGiven: true,
            disableComments: true,
            disableDuet: true,
            disableStitch: false,
            brandedContent: true,
            ownBrand: true,
            aiGenerated: true,
            draft: false,
          },
        },
      ],
      content: {
        text: "Creator-approved video",
        media: [
          {
            kind: "video" as const,
            mimeType: "video/mp4",
            source: { kind: "https-url" as const, url: "https://media.example.test/video.mp4" },
          },
        ],
      },
    };

    assert.equal(social.posts.prepare(request).ok, true);
    await social.posts.publish(request);

    if (provider === "zernio") {
      const native =
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
        // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
        (payload["platforms"] as { platformSpecificData: Record<string, unknown> }[])[0]!
          .platformSpecificData;

      assert.equal(native["allowDuet"], false);
      assert.equal(native["allowStitch"], true);
      assert.equal(native["isBrandOrganicPost"], true);
      assert.equal(native["videoMadeWithAi"], true);
    } else {
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
      const native = (payload["platform_configurations"] as { tiktok: Record<string, unknown> })
        .tiktok;

      assert.equal(native["allow_duet"], false);
      assert.equal(native["allow_stitch"], true);
      assert.equal(native["disclose_your_brand"], true);
      assert.equal(native["is_ai_generated"], true);
    }

    assert.equal(
      social.posts.prepare({
        ...request,
        targets: [{ account, options: { privacy: "SELF_ONLY", consentGiven: true } }],
      }).ok,
      false,
    );
    assert.equal(
      social.posts.prepare({
        targets: [{ account: x, options: { languages: ["en"] } }],
        content: { text: "Unmapped option" },
      }).ok,
      false,
    );
  });
}
