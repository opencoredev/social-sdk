import { test } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { bluesky } from "../src/platforms/bluesky.js";
import { SocialError } from "../src/core/errors.js";
import { object, array } from "../src/transport/validation.js";
import { parseJson } from "../src/transport/json.js";
import type { AdapterOperationContext, JsonValue, MediaAttachment } from "../src/core/index.js";

const account = connectedAccountRef({
  backend: "default",
  platform: "bluesky",
  accountId: "did:plc:test",
});

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "audit",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10000 },
};

const auth = { service: "https://pds.example", did: account.accountId, accessJwt: "fixture" };

const json = (value: JsonValue, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const body = (init: RequestInit | undefined) => object(parseJson(String(init?.body)));

test("Bluesky exact image byte boundaries hold for Blob, stream and remote inputs", async () => {
  for (const size of [2_000_000, 2_000_001]) {
    for (const kind of ["blob", "stream", "https-url"] as const) {
      let uploads = 0;
      const bytes = new Uint8Array(size);

      const source =
        kind === "blob"
          ? { kind, blob: new Blob([bytes], { type: "image/png" }), fingerprint: "fixture" }
          : kind === "stream"
            ? {
                kind,
                open: () => new Blob([bytes]).stream(),
                fingerprint: "fixture",
                replayable: true,
              }
            : { kind, url: "https://media.example/image" };

      const social = createSocial({
        backend: bluesky({
          auth,
          allowMediaHost: (host) => host === "media.example",
          fetch: async (input) => {
            if (new URL(String(input)).hostname === "media.example")
              return new Response(bytes, { headers: { "content-type": "image/png" } });

            if (String(input).includes("uploadBlob")) {
              uploads++;

              return json({
                blob: { $type: "blob", ref: { $link: "cid" }, mimeType: "image/png", size },
              });
            }

            return json({ uri: "at://did:plc:test/app.bsky.feed.post/p", cid: "cid" });
          },
        }),
      });

      const request = {
        targets: [{ account }],
        content: { media: [{ kind: "image" as const, mimeType: "image/png", source }] },
      };

      if (kind === "blob" && size > 2_000_000) {
        await assert.rejects(social.posts.publish(request));
        assert.equal(uploads, 0);
        continue;
      }

      const result = await social.posts.publish(request);
      assert.equal(
        result.outcomes[0]?.state === "published",
        size === 2_000_000,
        `${kind} ${size}`,
      );
      assert.equal(uploads, size === 2_000_000 ? 1 : 0);
    }
  }
});

test("Bluesky rejects explicit link cards without dispatch", async () => {
  let calls = 0;

  const social = createSocial({
    backend: bluesky({
      auth,
      fetch: async () => {
        calls++;

        return json({ uri: "at://did:plc:test/app.bsky.feed.post/p", cid: "cid" });
      },
    }),
  });

  const prepared = await social.posts.prepare({
    targets: [{ account }],
    content: { text: "link", link: { url: "https://example.com" } },
  });

  assert.ok(prepared.issues.some((issue) => issue.severity === "error"));
  await assert.rejects(
    social.posts.publish({
      targets: [{ account }],
      content: { text: "link", link: { url: "https://example.com" } },
    }),
  );
  assert.equal(calls, 0);
});

test("Bluesky quotes allow empty text, detect balanced URLs, and reject excessive UTF-8 bytes", async () => {
  const records: JsonValue[] = [];

  const adapter = bluesky({
    auth,
    fetch: async (_input, init) => {
      records.push(body(init)["record"] ?? null);

      return json({ uri: "at://did:plc:test/app.bsky.feed.post/p", cid: "cid" });
    },
  });

  assert.ok(adapter.native);
  const post = { uri: "at://did:plc:other/app.bsky.feed.post/p", cid: "cid" };
  await adapter.native.quotePost({ account, post, text: "" });
  const text = "🙂 (https://en.wikipedia.org/wiki/Rust_(programming_language)).";
  await adapter.native.quotePost({ account, post, text });
  const facet = object(array(object(records[1])["facets"])[0]);
  const uri = "https://en.wikipedia.org/wiki/Rust_(programming_language)";
  assert.equal(object(array(facet["features"])[0])["uri"], uri);
  assert.deepEqual(facet["index"], {
    byteStart: 6,
    byteEnd: 6 + new TextEncoder().encode(uri).length,
  });
  await assert.rejects(
    adapter.native.quotePost({ account, post, text: "a" + "\u0301".repeat(1600) }),
    /3,000/,
  );
  assert.equal(records.length, 2);
});

test("Bluesky validates reply text before parent reads or dispatch", async () => {
  let calls = 0;

  const adapter = bluesky({
    auth,
    fetch: async () => {
      calls++;

      return json({ posts: [] });
    },
  });

  assert.ok(adapter.comments);
  await assert.rejects(
    adapter.comments.reply(
      {
        kind: "comment",
        version: 1,
        backend: "default",
        platform: "bluesky",
        accountId: account.accountId,
        commentId: "at://did:plc:test/app.bsky.feed.post/p",
        postId: "at://did:plc:test/app.bsky.feed.post/p",
      },
      { text: "x".repeat(301) },
      context,
    ),
    /300 graphemes/,
  );
  assert.equal(calls, 0);
});

test("Bluesky honors declared image MIME and dimensions and rejects invalid pairs", async () => {
  let record: JsonValue = null;
  let calls = 0;

  const adapter = bluesky({
    auth,
    fetch: async (input, init) => {
      calls++;

      if (String(input).includes("uploadBlob")) {
        assert.equal(new Headers(init?.headers).get("content-type"), "image/png");

        return json({
          blob: { $type: "blob", ref: { $link: "cid" }, mimeType: "image/png", size: 1 },
        });
      }

      record = body(init)["record"] ?? null;

      return json({ uri: "at://did:plc:test/app.bsky.feed.post/p", cid: "cid" });
    },
  });

  const social = createSocial({ backend: adapter });

  const image: MediaAttachment = {
    kind: "image",
    mimeType: "image/png",
    width: 16,
    height: 9,
    source: { kind: "blob", blob: new Blob(["x"]), fingerprint: "fixture" },
  };

  await social.posts.publish({ targets: [{ account }], content: { media: [image] } });
  assert.deepEqual(object(array(object(object(record)["embed"])["images"])[0])["aspectRatio"], {
    width: 16,
    height: 9,
  });
  const { height: _height, ...noHeight } = image;
  const { mimeType: _mime, ...noMime } = image;

  for (const media of [
    noHeight,
    { ...image, width: 0 },
    { ...image, mimeType: "text/plain" },
    noMime,
  ]) {
    const prepared = await social.posts.prepare({
      targets: [{ account }],
      content: { media: [media] },
    });

    assert.ok(prepared.issues.some((issue) => issue.severity === "error"));
  }

  assert.equal(calls, 2);
});

test("Bluesky list updates clear stale facets and compare the fetched CID", async () => {
  let written: JsonValue = null;

  const adapter = bluesky({
    auth,
    fetch: async (input, init) =>
      String(input).includes("getRecord")
        ? json({
            cid: "old-cid",
            value: {
              $type: "app.bsky.graph.list",
              name: "old",
              purpose: "app.bsky.graph.defs#curatelist",
              description: "old",
              descriptionFacets: [{ index: { byteStart: 0, byteEnd: 3 }, features: [] }],
              avatar: { ref: { $link: "blob" } },
            },
          })
        : ((written = body(init)), json({})),
  });

  assert.ok(adapter.native);

  const input = {
    account,
    listUri: "at://did:plc:test/app.bsky.graph.list/l",
    name: "new",
    purpose: "app.bsky.graph.defs#curatelist" as const,
  };

  await adapter.native.updateList({ ...input, description: "new text" });
  assert.equal(object(written)["swapRecord"], "old-cid");
  assert.equal(object(object(written)["record"])["descriptionFacets"], undefined);
  assert.deepEqual(object(object(written)["record"])["avatar"], { ref: { $link: "blob" } });
  await adapter.native.updateList({ ...input, description: "" });
  assert.equal(object(object(written)["record"])["description"], undefined);
  await adapter.native.updateList(input);
  assert.equal(object(object(written)["record"])["description"], "old");
});

test("Bluesky native reads default to one attempt", async () => {
  let calls = 0;

  const adapter = bluesky({
    auth,
    fetch: async () => {
      calls++;

      return json({}, 503);
    },
  });

  assert.ok(adapter.native);
  await assert.rejects(adapter.native.getPost({ uri: "at://post" }));
  await assert.rejects(adapter.native.getPostThread({ uri: "at://post" }));
  await assert.rejects(adapter.native.searchActors({ account, query: "a" }));
  assert.equal(calls, 3);
});

test("Bluesky OAuth connectivity requires an authenticated PDS read", async () => {
  const paths: string[] = [];

  for (const status of [200, 401, 403]) {
    const adapter = bluesky({
      auth: { service: auth.service, did: auth.did },
      session: {
        did: auth.did,
        fetchHandler: async (path) => {
          paths.push(path);

          return json({ activated: true, validDid: true }, status);
        },
      },
    });

    assert.ok(adapter.accounts);

    if (status === 200)
      assert.equal((await adapter.accounts.get(account, context)).status, "connected");
    else
      await assert.rejects(
        adapter.accounts.get(account, context),
        (error) =>
          error instanceof SocialError &&
          error.code === (status === 401 ? "reconnect_required" : "missing_permission"),
      );
  }

  assert.ok(paths.every((path) => path.startsWith("/xrpc/com.atproto.server.checkAccountStatus")));
});

test("Bluesky author feeds preserve validated nested public fields and omit absent fields", async () => {
  const embed = {
    $type: "app.bsky.embed.images",
    images: [
      {
        image: { $type: "blob", ref: { $link: "blob" }, mimeType: "image/png", size: 1 },
        alt: "fixture",
        aspectRatio: { width: 16, height: 9 },
      },
    ],
  };

  const facets = [
    {
      index: { byteStart: 0, byteEnd: 3 },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com" }],
    },
  ];

  const reply = {
    root: { uri: "at://root", cid: "root-cid" },
    parent: { uri: "at://parent", cid: "parent-cid" },
  };

  const by = { did: "did:plc:other", handle: "other.example" };

  const labels = [
    {
      src: "did:plc:labeler",
      uri: "at://post",
      val: "label",
      cts: "2026-10-05T00:00:00Z",
      neg: false,
    },
  ];

  const embedView = {
    $type: "app.bsky.embed.external#view",
    external: {
      uri: "https://example.com",
      title: "fixture",
      description: "public",
      thumb: "https://cdn.example.com/image",
    },
  };

  const adapter = bluesky({
    auth,
    fetch: async () =>
      json({
        feed: [
          {
            post: {
              uri: "at://post",
              cid: "cid",
              labels,
              embed: embedView,
              record: { text: "url", facets, reply, embed, privateField: "omit" },
            },
            reason: {
              $type: "app.bsky.feed.defs#reasonRepost",
              by,
              indexedAt: "2026-10-05T00:00:00Z",
            },
          },
          { post: { uri: "at://empty", cid: "cid" } },
        ],
      }),
  });

  assert.ok(adapter.posts?.list);
  const result = await adapter.posts.list(account, {}, context);
  const first = object(result.items[0]);
  const post = object(first["post"]);
  assert.deepEqual(post["labels"], labels);
  assert.deepEqual(post["embed"], embedView);
  const record = object(post["record"]);
  assert.deepEqual(record["embed"], embed);
  assert.deepEqual(record["facets"], facets);
  assert.deepEqual(record["reply"], reply);
  assert.equal(record["privateField"], undefined);
  assert.deepEqual(object(first["reason"])["by"], by);
  assert.equal(object(object(result.items[1])["post"])["record"], undefined);
});

test("Bluesky author feeds preserve quote-plus-media records and AppViews by type", async () => {
  const media = {
    $type: "app.bsky.embed.images",
    images: [
      {
        image: { $type: "blob", ref: { $link: "blob" }, mimeType: "image/png", size: 1 },
        alt: "fixture",
      },
    ],
  };

  const mediaView = {
    $type: "app.bsky.embed.images#view",
    images: [
      { thumb: "https://cdn.example/thumb", fullsize: "https://cdn.example/full", alt: "fixture" },
    ],
  };

  const quote = { $type: "app.bsky.embed.record", record: { uri: "at://quote", cid: "quote-cid" } };

  const quoteView = {
    $type: "app.bsky.embed.record#view",
    record: {
      $type: "app.bsky.embed.record#viewRecord",
      uri: "at://quote",
      cid: "quote-cid",
      author: { did: "did:plc:other", handle: "other.example" },
      value: { $type: "app.bsky.feed.post", text: "quoted", createdAt: "2026-10-05T00:00:00Z" },
      embeds: [mediaView],
    },
  };

  const embed = { $type: "app.bsky.embed.recordWithMedia", record: quote, media };

  const embedView = {
    $type: "app.bsky.embed.recordWithMedia#view",
    record: quoteView,
    media: mediaView,
  };

  const adapter = bluesky({
    auth,
    fetch: async () =>
      json({
        feed: [
          {
            post: {
              uri: "at://post",
              cid: "cid",
              record: {
                text: "quote",
                embed: {
                  ...embed,
                  privateField: "omit",
                  record: {
                    ...quote,
                    privateField: "omit",
                    record: { ...quote.record, privateField: "omit" },
                  },
                  media: { ...media, privateField: "omit", record: { uri: "at://unexpected" } },
                },
              },
              embed: {
                ...embedView,
                privateField: "omit",
                record: {
                  ...quoteView,
                  privateField: "omit",
                  record: {
                    ...quoteView.record,
                    privateField: "omit",
                    author: { ...quoteView.record.author, privateField: "omit" },
                    value: { ...quoteView.record.value, privateField: "omit" },
                  },
                },
                media: { ...mediaView, privateField: "omit" },
              },
            },
          },
        ],
      }),
  });

  assert.ok(adapter.posts?.list);
  const result = await adapter.posts.list(account, {}, context);
  const post = object(object(result.items[0])["post"]);
  assert.deepEqual(object(post["record"])["embed"], embed);
  assert.deepEqual(post["embed"], embedView);
});

test("Bluesky feed quotes preserve nested quoted records and attached media without private fields", async () => {
  const imageView = {
    $type: "app.bsky.embed.images#view",
    images: [
      { alt: "fixture", thumb: "https://cdn.example/thumb", fullsize: "https://cdn.example/full" },
    ],
  };

  const innerQuote = {
    $type: "app.bsky.embed.record#view",
    record: {
      $type: "app.bsky.embed.record#viewRecord",
      uri: "at://inner",
      cid: "inner-cid",
      author: { did: "did:plc:inner", handle: "inner.example" },
      value: { $type: "app.bsky.feed.post", text: "inner quote" },
      embeds: [imageView],
    },
  };

  for (const nested of [
    innerQuote,
    { $type: "app.bsky.embed.recordWithMedia#view", record: innerQuote, media: imageView },
  ]) {
    const outerQuote = {
      $type: "app.bsky.embed.record#view",
      record: {
        $type: "app.bsky.embed.record#viewRecord",
        uri: "at://outer",
        cid: "outer-cid",
        author: { did: "did:plc:outer", handle: "outer.example" },
        value: { text: "outer quote" },
        embeds: [nested],
      },
    };

    const adapter = bluesky({
      auth,
      fetch: async () =>
        json({
          feed: [
            {
              post: {
                uri: "at://post",
                cid: "post-cid",
                embed: {
                  ...outerQuote,
                  record: {
                    ...outerQuote.record,
                    embeds: [{ ...nested, privateField: "omit" }],
                  },
                },
              },
            },
          ],
        }),
    });

    assert.ok(adapter.posts?.list);
    const result = await adapter.posts.list(account, {}, context);
    assert.deepEqual(object(result.items[0])["post"], {
      uri: "at://post",
      cid: "post-cid",
      embed: outerQuote,
    });
  }
});

test("Bluesky native quote size errors identify the quote operation before dispatch", async () => {
  let calls = 0;

  const adapter = bluesky({
    auth,
    fetch: async () => {
      calls++;

      return json({});
    },
  });

  assert.ok(adapter.native);

  for (const text of ["x".repeat(301), "a" + "\u0301".repeat(1600)])
    await assert.rejects(
      adapter.native.quotePost({ account, post: { uri: "at://quote", cid: "cid" }, text }),
      (error) =>
        error instanceof SocialError &&
        error.code === "invalid_input" &&
        error.operation === "bluesky.quote",
    );

  assert.equal(calls, 0);
});
