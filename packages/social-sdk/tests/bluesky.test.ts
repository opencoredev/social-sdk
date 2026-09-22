/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { bluesky } from "../src/platforms/bluesky.js";
import {
  connectedAccountRef,
  type AdapterOperationContext,
  type PreparedPublishTarget,
} from "../src/core/index.js";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function context(): AdapterOperationContext {
  return {
    backendInstance: "direct",
    correlationId: "test",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
  };
}

describe("Bluesky adapter", () => {
  it("performs typed like and unlike mutations with ownership checks", async () => {
    const requests: Array<{ url: string; body?: string }> = [];

    const adapter = bluesky({
      backend: "direct",
      auth: { service: "https://bsky.example", did: "did:plc:test", accessJwt: "jwt" },
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(init?.body === undefined ? {} : { body: String(init.body) }),
        });

        return response({ uri: "at://did:plc:test/app.bsky.feed.like/r1", cid: "bafy" });
      },
    });

    const account = connectedAccountRef({
      backend: "direct",
      platform: "bluesky",
      accountId: "did:plc:test",
    });

    const like = await adapter.native?.likePost({
      account,
      post: { uri: "at://did:plc:test/app.bsky.feed.post/p1", cid: "cid" },
      context: context(),
    });

    assert.equal(like?.uri, "at://did:plc:test/app.bsky.feed.like/r1");
    assert.match(requests[0]?.url ?? "", /com\.atproto\.repo\.createRecord/);
    assert.match(requests[0]?.body ?? "", /app\.bsky\.feed\.like/);
    await adapter.native?.unlikePost({ account, likeUri: like?.uri ?? "", context: context() });
    assert.match(requests[1]?.url ?? "", /com\.atproto\.repo\.deleteRecord/);
    await assert.rejects(() =>
      adapter.native?.likePost({
        account: connectedAccountRef({
          backend: "direct",
          platform: "bluesky",
          accountId: "did:plc:other",
        }),
        post: { uri: "at://x", cid: "c" },
        context: context(),
      }),
    );
  });
  it("routes OAuthSession requests through fetchHandler without bearer extraction", async () => {
    const requests: RequestInit[] = [];

    const adapter = bluesky({
      backend: "direct",
      auth: { service: "https://bsky.example", did: "did:plc:test" },
      session: {
        did: "did:plc:test",
        fetchHandler: async (pathname, init) => {
          assert.equal(pathname, "/xrpc/com.atproto.repo.createRecord");
          requests.push(init ?? {});

          return response({ uri: "at://did:plc:test/app.bsky.feed.post/session", cid: "cid" });
        },
      },
    });

    const account = connectedAccountRef({
      backend: "direct",
      platform: "bluesky",
      accountId: "did:plc:test",
    });

    const result = await adapter.posts?.publishTarget(
      { targetIndex: 0, targetKey: "session", account, content: { text: "hello" } },
      context(),
    );

    assert.equal(result?.state, "published");
    assert.equal(requests.length, 1);
    const headers = new Headers(requests[0]?.headers);
    assert.equal(headers.has("authorization"), false);
  });

  it("lists only the configured credential-ready account", async () => {
    const adapter = bluesky({
      backend: "direct",
      auth: {
        service: "https://bsky.example",
        did: "did:plc:test",
        handle: "ada.example",
        accessJwt: "jwt",
      },
      fetch: async () => response({ did: "did:plc:test", handle: "ada.example" }),
    });

    const listed = await adapter.accounts?.list({}, context());
    assert.equal(listed?.items[0]?.ref.accountId, "did:plc:test");
    assert.equal(listed?.items[0]?.handle, "ada.example");
  });

  it("creates a text post and encodes link facets using UTF-8 byte offsets", async () => {
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated boundary or fixture contract.
    let requestBody: Record<string, unknown> | undefined;

    const adapter = bluesky({
      backend: "direct",
      auth: { service: "https://bsky.example", did: "did:plc:test", accessJwt: "jwt" },
      fetch: async (_input, init) => {
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
        // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
        // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- validated external boundary or fixture contract.
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

        return response({ uri: "at://did:plc:test/app.bsky.feed.post/one", cid: "bafyreione" });
      },
    });

    const account = connectedAccountRef({
      backend: "direct",
      platform: "bluesky",
      accountId: "did:plc:test",
    });

    const target: PreparedPublishTarget = {
      targetIndex: 0,
      targetKey: "direct:bluesky:did:plc:test",
      account,
      content: { text: "Olá https://example.com" },
    };

    const outcome = await adapter.posts?.publishTarget(target, context());
    assert.equal(outcome?.state, "published");

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
    const record = requestBody?.record as {
      facets?: readonly { index: { byteStart: number; byteEnd: number } }[];
    };

    assert.deepEqual(record.facets?.[0]?.index, { byteStart: 5, byteEnd: 24 });
  });

  it("uploads images and preserves native uri/cid for a strong reply reference", async () => {
    const requests: string[] = [];
    let createCount = 0;

    const adapter = bluesky({
      backend: "direct",
      auth: { service: "https://bsky.example", did: "did:plc:test", accessJwt: "jwt" },
      fetch: async (input, _init) => {
        const url = String(input);
        requests.push(url);

        if (url.includes("uploadBlob"))
          return response({
            blob: { $type: "blob", ref: { $link: "blob" }, mimeType: "image/png", size: 2 },
          });

        if (url.includes("getPosts"))
          return response({
            posts: [
              {
                uri: decodeURIComponent(new URL(url).searchParams.get("uris") ?? ""),
                cid: "bafyroot",
                record: {},
              },
            ],
          });
        createCount++;

        return response({
          uri: `at://did:plc:test/app.bsky.feed.post/${createCount}`,
          cid: "bafychild",
        });
      },
    });

    const account = connectedAccountRef({
      backend: "direct",
      platform: "bluesky",
      accountId: "did:plc:test",
    });

    const first = await adapter.posts?.publishTarget(
      {
        targetIndex: 0,
        targetKey: "root",
        account,
        content: {
          media: [
            {
              kind: "image",
              source: {
                kind: "blob",
                blob: new Blob([new Uint8Array([1, 2])]),
                fingerprint: "img",
              },
            },
          ],
        },
      },
      context(),
    );

    assert.equal(first?.state, "published");
    assert.ok(requests.some((url) => url.includes("uploadBlob")));

    const second = await adapter.posts?.publishTarget(
      {
        targetIndex: 0,
        targetKey: "reply",
        account,
        content: { text: "Reply" },
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(first?.state === "published" ? { replyTo: first.post } : {}),
      },
      context(),
    );

    assert.equal(second?.state, "published");
  });

  it("rejects a credential whose authoritative session changed and enforces text bounds", async () => {
    const adapter = bluesky({
      backend: "direct",
      auth: { service: "https://bsky.example", did: "did:plc:test", accessJwt: "jwt" },
      fetch: async () => response({ did: "did:plc:other", handle: "other.example" }),
    });

    await assert.rejects(() =>
      adapter.accounts?.get(
        connectedAccountRef({ backend: "direct", platform: "bluesky", accountId: "did:plc:test" }),
        context(),
      ),
    );

    const issues = adapter.posts?.prepareTarget({
      targetIndex: 0,
      targetKey: "long",
      account: connectedAccountRef({
        backend: "direct",
        platform: "bluesky",
        accountId: "did:plc:test",
      }),
      content: { text: "🙂".repeat(301) },
    });

    assert.equal(
      issues?.some((issue) => issue.code === "text.too_long"),
      true,
    );
  });
});

it("OAuth account discovery uses the verified session audience and profile DID", async () => {
  const session = {
    did: "did:plc:oauth",
    async fetchHandler(pathname: string) {
      assert.equal(this.did, "did:plc:oauth");
      assert.equal(pathname, "/xrpc/app.bsky.actor.getProfile?actor=did%3Aplc%3Aoauth");

      return Response.json({ did: this.did, handle: "oauth.example" });
    },
  };

  const adapter = bluesky({
    auth: { did: session.did, service: "https://untrusted-configured-service.example" },
    session,
  });

  const page = await adapter.accounts!.list(
    {},
    {
      backendInstance: "default",
      correlationId: "oauth",
      retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
    },
  );

  assert.equal(page.items[0]?.ref.accountId, session.did);
  assert.equal(page.items[0]?.handle, "oauth.example");
});

it("Bluesky reactions validate owned like URIs and never replay ambiguous writes", async () => {
  const account = connectedAccountRef({
    backend: "direct",
    platform: "bluesky",
    accountId: "did:plc:test",
  });

  let calls = 0;

  const adapter = bluesky({
    backend: "direct",
    auth: { service: "https://bsky.example", did: "did:plc:test", accessJwt: "jwt" },
    fetch: async () => {
      calls++;
      throw new TypeError("lost response");
    },
  });

  for (const likeUri of [
    "at://did:plc:other/app.bsky.feed.like/r1",
    "at://did:plc:test/app.bsky.feed.post/r1",
    "at://did:plc:test/app.bsky.feed.like/r1?token=bad",
    "at://did:plc:test/app.bsky.feed.like/..",
  ])
    await assert.rejects(adapter.native!.unlikePost({ account, likeUri, context: context() }));
  await assert.rejects(
    adapter.native!.likePost({
      account,
      post: { uri: "https://wrong.example", cid: "cid" },
      context: context(),
    }),
  );
  assert.equal(calls, 0);
  await assert.rejects(
    adapter.native!.likePost({
      account,
      post: { uri: "at://did:plc:someone/app.bsky.feed.post/r1", cid: "cid" },
      context: { ...context(), retryBudget: { maxAttempts: 5, maxElapsedMs: 1000 } },
    }),
    (error: any) => error.code === "ambiguous_outcome",
  );
  assert.equal(
    calls,
    1,
    "liking another author's post is allowed, but an uncertain write must not repeat",
  );
});

it("serializes language tags and explicit DID mentions at UTF-8 boundaries without lookups", async () => {
  const account = connectedAccountRef({
    backend: "direct",
    platform: "bluesky",
    accountId: "did:plc:test",
  });

  const requests: { url: string; body: any }[] = [];

  const adapter = bluesky({
    backend: "direct",
    auth: { service: "https://bsky.example", did: "did:plc:test", accessJwt: "jwt" },
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });

      return response({ uri: "at://did:plc:test/app.bsky.feed.post/result", cid: "cid" });
    },
  });

  const target: PreparedPublishTarget = {
    account,
    targetIndex: 0,
    targetKey: "mention",
    content: { text: "🙂 @alice.example https://example.com" },
    options: {
      languages: ["en-us"],
      mentions: [{ byteStart: 5, byteEnd: 19, did: "did:plc:alice" }],
    },
  };

  assert.deepEqual(adapter.posts!.prepareTarget(target), []);
  assert.equal(requests.length, 0);
  assert.equal((await adapter.posts!.publishTarget(target, context())).state, "published");
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /createRecord$/);
  assert.deepEqual(requests[0]!.body.record.langs, ["en-US"]);
  assert.deepEqual(requests[0]!.body.record.facets[0], {
    index: { byteStart: 5, byteEnd: 19 },
    features: [{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:alice" }],
  });
  assert.equal(
    requests[0]!.body.record.facets[1].features[0].$type,
    "app.bsky.richtext.facet#link",
  );

  for (const options of [
    { languages: ["not a tag"] },
    { languages: ["en", "fr", "de", "es"] },
    { mentions: [{ byteStart: 1, byteEnd: 3, did: "did:plc:alice" }] },
    { mentions: [{ byteStart: 5, byteEnd: 19, did: "alice.example" }] },
    {
      mentions: [
        { byteStart: 5, byteEnd: 19, did: "did:plc:alice" },
        { byteStart: 5, byteEnd: 19, did: "did:plc:other" },
      ],
    },
  ]) {
    const invalid = { ...target, options };
    assert.ok(adapter.posts!.prepareTarget(invalid).length > 0);
    await assert.rejects(adapter.posts!.publishTarget(invalid, context()));
  }

  assert.equal(requests.length, 1);
});
