import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  blueskyFeedGeneratorMethod,
  blueskyLabelStreamUrl,
  parseBlueskyLabelFrame,
} from "../src/platforms/bluesky.js";
import { array, object } from "../src/transport/validation.js";
import { account, harness, json } from "./bluesky-harness.js";

const invalid = { name: "SocialError", code: "invalid_input" };

// Minimal DAG-CBOR writers, enough to build com.atproto.label.subscribeLabels frames.
function head(major: number, length: number): number[] {
  if (length < 24) return [(major << 5) | length];

  if (length < 256) return [(major << 5) | 24, length];

  return [(major << 5) | 25, length >> 8, length & 0xff];
}

const uint = (value: number) => head(0, value);

const negative = (value: number) => head(1, -1 - value);

const bytes = (value: readonly number[]) => [...head(2, value.length), ...value];

const text = (value: string) => {
  const encoded = [...new TextEncoder().encode(value)];

  return [...head(3, encoded.length), ...encoded];
};

const list = (items: readonly (readonly number[])[]) => [...head(4, items.length), ...items.flat()];

const map = (entries: readonly (readonly [string, readonly number[]])[]) => [
  ...head(5, entries.length),
  ...entries.flatMap(([key, value]) => [...text(key), ...value]),
];

const yes = [0xf5];

const label = map([
  ["ver", uint(1)],
  ["src", text("did:plc:labeler")],
  ["uri", text("at://did:plc:author/app.bsky.feed.post/3kpost")],
  ["val", text("spoiler")],
  ["neg", yes],
  ["cts", text("2026-11-04T00:00:00.000Z")],
  ["sig", bytes([1, 2, 3])],
]);

describe("Bluesky label stream", () => {
  it("builds the com.atproto.label.subscribeLabels URL and decodes label frames", () => {
    const url = blueskyLabelStreamUrl({ service: "https://mod.example", cursor: 42 });
    assert.equal(url.href, "wss://mod.example/xrpc/com.atproto.label.subscribeLabels?cursor=42");
    assert.throws(() => blueskyLabelStreamUrl({ service: "https://mod.example", cursor: -1 }));

    const frame = new Uint8Array([
      ...map([
        ["op", uint(1)],
        ["t", text("#labels")],
      ]),
      ...map([
        ["seq", uint(300)],
        ["labels", list([label])],
      ]),
    ]);

    assert.deepEqual(parseBlueskyLabelFrame(frame), {
      kind: "labels",
      seq: 300,
      labels: [
        {
          src: "did:plc:labeler",
          uri: "at://did:plc:author/app.bsky.feed.post/3kpost",
          val: "spoiler",
          cts: "2026-11-04T00:00:00.000Z",
          neg: true,
          ver: 1,
          sig: new Uint8Array([1, 2, 3]),
        },
      ],
    });
  });

  it("decodes info and error frames and skips unknown message types", () => {
    const info = new Uint8Array([
      ...map([
        ["op", uint(1)],
        ["t", text("#info")],
      ]),
      ...map([["name", text("OutdatedCursor")]]),
    ]);

    assert.deepEqual(parseBlueskyLabelFrame(info), { kind: "info", name: "OutdatedCursor" });

    const error = new Uint8Array([
      ...map([["op", negative(-1)]]),
      ...map([
        ["error", text("FutureCursor")],
        ["message", text("Cursor is ahead")],
      ]),
    ]);

    assert.deepEqual(parseBlueskyLabelFrame(error), {
      kind: "error",
      error: "FutureCursor",
      message: "Cursor is ahead",
    });

    const unknown = new Uint8Array([
      ...map([
        ["op", uint(1)],
        ["t", text("#future")],
      ]),
      ...map([]),
    ]);

    assert.equal(parseBlueskyLabelFrame(unknown), undefined);

    assert.throws(() => parseBlueskyLabelFrame(new Uint8Array([0xbf])), {
      name: "SocialError",
      code: "upstream_failure",
    });
  });
});

describe("Bluesky feed generator routing", () => {
  it("routes app.bsky.feed.describeFeedGenerator and getFeedSkeleton paths", () => {
    assert.equal(
      blueskyFeedGeneratorMethod(
        new URL("https://feeds.example/xrpc/app.bsky.feed.describeFeedGenerator"),
      ),
      "app.bsky.feed.describeFeedGenerator",
    );
    assert.equal(
      blueskyFeedGeneratorMethod(
        new URL("https://feeds.example/xrpc/app.bsky.feed.getFeedSkeleton"),
      ),
      "app.bsky.feed.getFeedSkeleton",
    );
    assert.equal(blueskyFeedGeneratorMethod(new URL("https://feeds.example/health")), undefined);
  });
});

describe("Bluesky draft media", () => {
  it("stores device-local embedImages, embedGallery, and embedVideos", async () => {
    const { native, calls } = harness(() => json({ id: "3kdraftid2345" }));

    await native.createDraft({
      account,
      draft: {
        deviceId: "phone-1",
        posts: [
          { text: "Photos", images: [{ path: "/media/a.jpg", alt: "A cat" }] },
          {
            text: "Gallery",
            gallery: [{ path: "/media/1.jpg" }, { path: "/media/2.jpg", alt: "Two" }],
          },
          {
            text: "Clip",
            video: {
              path: "/media/clip.mp4",
              alt: "A clip",
              captions: [{ lang: "en", content: "WEBVTT\n\n00:00.000 --> 00:01.000\nHi" }],
            },
          },
        ],
      },
    });

    assert.equal(calls[0]?.url.pathname, "/xrpc/app.bsky.draft.createDraft");
    const posts = array(object(calls[0]?.body?.["draft"])["posts"]).map((post) => object(post));
    assert.deepEqual(posts[0]?.["embedImages"], [
      { localRef: { path: "/media/a.jpg" }, alt: "A cat" },
    ]);
    assert.deepEqual(posts[1]?.["embedGallery"], {
      items: [
        { $type: "app.bsky.draft.defs#draftEmbedImage", localRef: { path: "/media/1.jpg" } },
        {
          $type: "app.bsky.draft.defs#draftEmbedImage",
          localRef: { path: "/media/2.jpg" },
          alt: "Two",
        },
      ],
    });
    assert.deepEqual(posts[2]?.["embedVideos"], [
      {
        localRef: { path: "/media/clip.mp4" },
        alt: "A clip",
        captions: [{ lang: "en", content: "WEBVTT\n\n00:00.000 --> 00:01.000\nHi" }],
      },
    ]);

    await assert.rejects(
      native.createDraft({
        account,
        draft: {
          posts: [{ text: "Both", images: [{ path: "/a.jpg" }], video: { path: "/b.mp4" } }],
        },
      }),
      invalid,
    );
    await assert.rejects(
      native.createDraft({
        account,
        draft: {
          posts: [
            {
              text: "Too many",
              images: [1, 2, 3, 4, 5].map((index) => ({ path: `/${index}.jpg` })),
            },
          ],
        },
      }),
      invalid,
    );
    assert.equal(calls.length, 1);
  });
});

it("rejects a label frame nested deeper than any label needs", () => {
  const frame = new Uint8Array(20_001).fill(0x81);
  frame[20_000] = 0x00;

  assert.throws(() => parseBlueskyLabelFrame(frame), { code: "upstream_failure" });
});
