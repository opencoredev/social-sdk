import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createSocial } from "../src/index.js";
import { bluesky } from "../src/platforms/bluesky.js";
import {
  connectedAccountRef,
  type JsonObject,
  type JsonValue,
  type MediaAttachment,
  type MediaRef,
} from "../src/core/index.js";
import { definedFields } from "../src/core/fields.js";
import { isJsonValue } from "../src/transport/json.js";
import { array, object } from "../src/transport/validation.js";

const did = "did:plc:test";

const account = connectedAccountRef({ backend: "default", platform: "bluesky", accountId: did });

const quoted = {
  uri: "at://did:plc:alice/app.bsky.feed.post/3kquoted",
  cid: "bafyreiquotedcid",
};

interface Seen {
  readonly url: URL;
  readonly headers: Headers;
  readonly body?: BodyInit | null;
}

function json(value: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonBody(body: BodyInit | null | undefined): JsonObject {
  const parsed: unknown = JSON.parse(String(body));
  assert.ok(isJsonValue(parsed), "request body must be JSON");

  return object(parsed);
}

function blob(link: string, mimeType: string, size: number): JsonObject {
  return { $type: "blob", ref: { $link: link }, mimeType, size };
}

/** A fake PDS: uploadBlob echoes a blob ref, createRecord and applyWrites succeed. */
function harness() {
  const seen: Seen[] = [];
  const stored = new Map<string, JsonObject>();
  let uploads = 0;

  const adapter = bluesky({
    auth: { service: "https://pds.example", did, accessJwt: "fixture" },
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      seen.push({ url, headers, body: init?.body ?? null });

      if (url.pathname.endsWith("uploadBlob")) {
        uploads++;

        return json({
          blob: blob(`bafkblob${uploads}`, headers.get("content-type") ?? "", uploads),
        });
      }

      if (url.pathname.endsWith("getJobStatus"))
        return json({
          jobStatus: {
            jobId: "job-1",
            did,
            state: "JOB_STATE_COMPLETED",
            blob: blob("bafkvideo", "video/mp4", 2048),
          },
        });

      if (url.pathname.endsWith("getPosts")) {
        const uri = url.searchParams.get("uris") ?? "";

        return json({ posts: [{ uri, cid: `cid-${uri.length}`, record: stored.get(uri) ?? {} }] });
      }

      if (url.pathname.endsWith("applyWrites")) {
        const writes = array(jsonBody(init?.body)["writes"]).map((write) => object(write));

        return json({
          commit: { cid: "bafycommit", rev: "3kcommitrev" },
          results: writes.map((write) => ({
            $type: "com.atproto.repo.applyWrites#createResult",
            uri: `at://${did}/${String(write["collection"])}/${String(write["rkey"])}`,
            cid: `bafy-${String(write["collection"])}`,
            validationStatus: "valid",
          })),
        });
      }

      const uri = `at://${did}/app.bsky.feed.post/3kpost${seen.length}`;
      stored.set(uri, object(jsonBody(init?.body)["record"]));

      return json({ uri, cid: "bafypost" });
    },
  });

  const social = createSocial({ backend: adapter });

  const created = (): JsonObject[] =>
    seen.flatMap((request) =>
      request.url.pathname.endsWith("createRecord")
        ? [object(jsonBody(request.body)["record"])]
        : [],
    );

  return { adapter, social, seen, created };
}

function image(width?: number, height?: number): MediaAttachment {
  return {
    kind: "image",
    source: {
      kind: "blob",
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      fingerprint: "fixture",
    },
    altText: "A chart",
    ...definedFields({ width, height }),
  };
}

describe("Bluesky publish options", () => {
  it("writes record.tags, self-labels, and hashtag facets [feature:bluesky.publish.tags]", async () => {
    const { social, created } = harness();

    const text = "Launch 🙂 #TypeScript #2026 and ＃bsky! https://example.com/#anchor";

    const result = await social.posts.publish({
      targets: [
        {
          account,
          options: { tags: ["#release", "sdk"], contentLabels: ["graphic-media", "nudity"] },
        },
      ],
      content: { text },
    });

    assert.equal(result.outcomes[0]?.state, "published");

    const record = created()[0];
    assert.ok(record);
    assert.deepEqual(record["tags"], ["release", "sdk"]);
    assert.deepEqual(record["labels"], {
      $type: "com.atproto.label.defs#selfLabels",
      values: [{ val: "graphic-media" }, { val: "nudity" }],
    });

    const bytes = new TextEncoder().encode(text);
    const facets = array(record["facets"]).map((facet) => object(facet));
    const features = facets.map((facet) => object(array(facet["features"])[0]));

    // #2026 is all digits and is not a tag; the URL fragment is part of the link facet.
    assert.deepEqual(
      features.map((feature) => feature["$type"]),
      [
        "app.bsky.richtext.facet#tag",
        "app.bsky.richtext.facet#tag",
        "app.bsky.richtext.facet#link",
      ],
    );
    assert.deepEqual(features[0], { $type: "app.bsky.richtext.facet#tag", tag: "TypeScript" });
    assert.deepEqual(features[1], { $type: "app.bsky.richtext.facet#tag", tag: "bsky" });

    const span = object(facets[1]?.["index"]);
    assert.equal(
      new TextDecoder().decode(bytes.slice(Number(span["byteStart"]), Number(span["byteEnd"]))),
      "＃bsky",
    );
  });

  it("rejects invalid tags and unknown self-label values before any request", async () => {
    const { social, seen } = harness();

    for (const options of [
      { tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] },
      { tags: ["two words"] },
      { contentLabels: ["spoiler"] },
    ]) {
      const prepared = await social.posts.prepare({
        // @ts-expect-error: the unknown label exercises runtime validation.
        targets: [{ account, options }],
        content: { text: "x" },
      });

      assert.ok(prepared.issues.some((issue) => issue.code === "bluesky.richtext"));
    }

    assert.equal(seen.length, 0);
  });

  it("maps five to ten images to app.bsky.embed.gallery with aspect ratios", async () => {
    const { social, created } = harness();

    const result = await social.posts.publish({
      targets: [{ account }],
      content: { text: "gallery", media: Array.from({ length: 6 }, () => image(1200, 800)) },
    });

    assert.equal(result.outcomes[0]?.state, "published");

    const embed = object(created()[0]?.["embed"]);
    assert.equal(embed["$type"], "app.bsky.embed.gallery");

    const items = array(embed["items"]).map((item) => object(item));
    assert.equal(items.length, 6);
    assert.deepEqual(items[0], {
      $type: "app.bsky.embed.gallery#image",
      image: blob("bafkblob1", "image/png", 1),
      alt: "A chart",
      aspectRatio: { width: 1200, height: 800 },
    });

    const missing = await social.posts.prepare({
      targets: [{ account }],
      content: {
        text: "gallery",
        media: [...Array.from({ length: 4 }, () => image(1, 1)), image()],
      },
    });

    assert.ok(missing.issues.some((issue) => issue.code === "media.aspect_ratio_required"));

    const tooMany = await social.posts.prepare({
      targets: [{ account }],
      content: { text: "gallery", media: Array.from({ length: 11 }, () => image(1, 1)) },
    });

    assert.ok(tooMany.issues.some((issue) => issue.code === "media.too_many"));
  });

  it("uploads WebVTT caption tracks and sets the presentation hint [feature:bluesky.publish.video.captions]", async () => {
    const { adapter, social, seen, created } = harness();

    const english = await adapter.native!.uploadBlob({
      account,
      blob: new Blob(["WEBVTT\n\n00:00.000 --> 00:01.000\nHi"]),
      mimeType: "text/vtt",
    });

    const portuguese = await adapter.native!.uploadBlob({
      account,
      blob: new Blob(["WEBVTT\n"], { type: "text/vtt" }),
    });

    const ref: MediaRef = {
      kind: "media",
      version: 1,
      backend: "default",
      platform: "bluesky",
      accountId: did,
      mediaId: "job-1",
    };

    const result = await social.posts.publish({
      targets: [
        {
          account,
          options: {
            videoCaptions: [
              { lang: "en", file: english },
              { lang: "pt-br", file: portuguese },
            ],
            videoPresentation: "gif",
          },
        },
      ],
      content: { text: "clip", media: [{ kind: "video", source: { kind: "media-ref", ref } }] },
    });

    assert.equal(result.outcomes[0]?.state, "published");

    const uploads = seen.filter((request) => request.url.pathname.endsWith("uploadBlob"));
    assert.deepEqual(
      uploads.map((request) => request.headers.get("content-type")),
      ["text/vtt", "text/vtt"],
    );

    assert.deepEqual(created()[0]?.["embed"], {
      $type: "app.bsky.embed.video",
      video: blob("bafkvideo", "video/mp4", 2048),
      captions: [
        { lang: "en", file: blob("bafkblob1", "text/vtt", 1) },
        { lang: "pt-BR", file: blob("bafkblob2", "text/vtt", 2) },
      ],
      presentation: "gif",
    });

    const oversized = await social.posts.prepare({
      targets: [
        {
          account,
          options: { videoCaptions: [{ lang: "en", file: { ...english, size: 20_001 } }] },
        },
      ],
      content: { text: "clip", media: [{ kind: "video", source: { kind: "media-ref", ref } }] },
    });

    assert.ok(oversized.issues.some((issue) => issue.code === "bluesky.richtext"));

    const misplaced = await social.posts.prepare({
      targets: [{ account, options: { videoPresentation: "gif" } }],
      content: { text: "no video" },
    });

    assert.ok(
      misplaced.issues.some((issue) => issue.code === "bluesky.video_options_without_video"),
    );
  });

  it("maps content.link to an external card with an uploaded thumbnail and no page fetch", async () => {
    const { adapter, social, seen, created } = harness();

    const thumbnail = await adapter.native!.uploadBlob({
      account,
      blob: new Blob([new Uint8Array(8)], { type: "image/jpeg" }),
    });

    const result = await social.posts.publish({
      targets: [{ account, options: { linkThumbnail: thumbnail } }],
      content: {
        text: "Read the guide",
        link: { url: "https://example.com/guide", title: "Guide", description: "How it works" },
      },
    });

    assert.equal(result.outcomes[0]?.state, "published");
    assert.equal(
      seen.some((request) => request.url.hostname === "example.com"),
      false,
    );
    assert.deepEqual(created()[0]?.["embed"], {
      $type: "app.bsky.embed.external",
      external: {
        uri: "https://example.com/guide",
        title: "Guide",
        description: "How it works",
        thumb: blob("bafkblob1", "image/jpeg", 1),
      },
    });
  });

  it("quotes a post through options.quote [feature:bluesky.publish.quote]", async () => {
    const { social, created } = harness();

    await social.posts.publish({
      targets: [{ account, options: { quote: quoted, languages: ["en"] } }],
      content: { text: "Worth reading" },
    });

    const record = created()[0];
    assert.deepEqual(record?.["embed"], { $type: "app.bsky.embed.record", record: quoted });
    assert.deepEqual(record?.["langs"], ["en"]);

    const bad = await social.posts.prepare({
      targets: [{ account, options: { quote: { uri: "https://example.com", cid: "x" } } }],
      content: { text: "x" },
    });

    assert.ok(bad.issues.some((issue) => issue.code === "bluesky.richtext"));
  });

  it("combines a quote with images as recordWithMedia [feature:bluesky.publish.recordWithMedia]", async () => {
    const { social, created } = harness();

    await social.posts.publish({
      targets: [{ account, options: { quote: quoted } }],
      content: { text: "With a screenshot", media: [image(4, 3)] },
    });

    assert.deepEqual(created()[0]?.["embed"], {
      $type: "app.bsky.embed.recordWithMedia",
      record: { $type: "app.bsky.embed.record", record: quoted },
      media: {
        $type: "app.bsky.embed.images",
        images: [
          {
            image: blob("bafkblob1", "image/png", 1),
            alt: "A chart",
            aspectRatio: { width: 4, height: 3 },
          },
        ],
      },
    });
  });

  it("writes the post, threadgate, and postgate atomically with com.atproto.repo.applyWrites", async () => {
    const { social, seen } = harness();

    const listUri = "at://did:plc:test/app.bsky.graph.list/3kfriends";

    const result = await social.posts.publish({
      targets: [
        {
          account,
          options: {
            replyControls: [{ kind: "mention" }, { kind: "following" }, { kind: "list", listUri }],
            disableQuotes: true,
          },
        },
      ],
      content: { text: "Gated" },
    });

    const request = seen.find((entry) => entry.url.pathname.endsWith("applyWrites"));
    assert.ok(request);
    assert.equal(request.url.pathname, "/xrpc/com.atproto.repo.applyWrites");
    assert.equal(
      seen.some((entry) => entry.url.pathname.endsWith("createRecord")),
      false,
    );

    const body = jsonBody(request.body);
    assert.equal(body["repo"], did);

    const writes = array(body["writes"]).map((write) => object(write));
    const rkey = String(writes[0]?.["rkey"]);
    assert.match(rkey, /^[234567a-j][234567a-z]{12}$/);
    assert.deepEqual(
      writes.map((write) => [write["$type"], write["collection"], write["rkey"]]),
      [
        ["com.atproto.repo.applyWrites#create", "app.bsky.feed.post", rkey],
        ["com.atproto.repo.applyWrites#create", "app.bsky.feed.threadgate", rkey],
        ["com.atproto.repo.applyWrites#create", "app.bsky.feed.postgate", rkey],
      ],
    );

    const postUri = `at://${did}/app.bsky.feed.post/${rkey}`;
    const threadgate = object(writes[1]?.["value"]);
    assert.equal(threadgate["post"], postUri);
    assert.deepEqual(threadgate["allow"], [
      { $type: "app.bsky.feed.threadgate#mentionRule" },
      { $type: "app.bsky.feed.threadgate#followingRule" },
      { $type: "app.bsky.feed.threadgate#listRule", list: listUri },
    ]);

    const postgate = object(writes[2]?.["value"]);
    assert.equal(postgate["$type"], "app.bsky.feed.postgate");
    assert.equal(postgate["post"], postUri);
    assert.deepEqual(postgate["embeddingRules"], [{ $type: "app.bsky.feed.postgate#disableRule" }]);

    const outcome = result.outcomes[0];
    assert.equal(outcome?.state, "published");
    assert.equal(outcome?.state === "published" ? outcome.post.postId : undefined, postUri);
  });

  it("closes replies with an empty rule list and rejects reply controls on replies", async () => {
    const { social, seen } = harness();

    await social.posts.publish({
      targets: [{ account, options: { replyControls: [] } }],
      content: { text: "Announcement" },
    });

    const writes = array(
      jsonBody(seen.find((entry) => entry.url.pathname.endsWith("applyWrites"))?.body)["writes"],
    ).map((write) => object(write));

    assert.deepEqual(object(writes[1]?.["value"])["allow"], []);

    const reply = await social.posts.prepare({
      targets: [{ account, options: { replyControls: [{ kind: "follower" }] } }],
      content: { text: "reply" },
      replyTo: {
        kind: "platform-post",
        version: 1,
        backend: "default",
        platform: "bluesky",
        accountId: did,
        postId: "at://did:plc:test/app.bsky.feed.post/3kroot",
      },
    });

    assert.ok(reply.issues.some((issue) => issue.code === "bluesky.reply_controls_on_reply"));
  });

  it("publishes a self-thread as a reply chain with publishSequence [feature:bluesky.publish.thread]", async () => {
    const { social, created } = harness();

    const result = await social.posts.publishSequence({
      idempotencyKey: "thread-1",
      replyToPrevious: true,
      items: [
        { targets: [{ account }], content: { text: "1/3" } },
        { targets: [{ account }], content: { text: "2/3" } },
        { targets: [{ account }], content: { text: "3/3" } },
      ],
    });

    assert.equal(result.failures.length, 0);

    const records = created();
    assert.equal(records.length, 3);
    assert.equal(records[0]?.["reply"], undefined);

    const second = object(records[1]?.["reply"]);
    const third = object(records[2]?.["reply"]);
    const rootUri = object(second["root"])["uri"];

    assert.equal(object(second["parent"])["uri"], rootUri);
    // Every reply keeps the first post as root and the previous post as parent.
    assert.equal(object(third["root"])["uri"], rootUri);
    assert.notEqual(object(third["parent"])["uri"], rootUri);
  });
});
