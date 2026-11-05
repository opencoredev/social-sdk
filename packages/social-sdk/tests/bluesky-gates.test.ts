import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { bluesky } from "../src/platforms/bluesky.js";
import {
  connectedAccountRef,
  SocialError,
  type JsonObject,
  type JsonValue,
} from "../src/core/index.js";
import { definedFields } from "../src/core/fields.js";
import { isJsonValue } from "../src/transport/json.js";
import { object } from "../src/transport/validation.js";

const did = "did:plc:test";

const account = connectedAccountRef({ backend: "default", platform: "bluesky", accountId: did });

const postUri = `at://${did}/app.bsky.feed.post/3kpost`;

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly body?: JsonObject;
}

function json(value: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function decode(body: BodyInit | null | undefined): JsonObject | undefined {
  if (body === undefined || body === null) return undefined;

  const parsed: unknown = JSON.parse(String(body));
  assert.ok(isJsonValue(parsed));

  return object(parsed);
}

function harness(route: (call: Call) => Response) {
  const calls: Call[] = [];

  const adapter = bluesky({
    auth: { service: "https://pds.example", did, accessJwt: "fixture" },
    fetch: async (input, init) => {
      const body = decode(init?.body);

      const call = {
        method: init?.method ?? "GET",
        url: new URL(String(input)),
        ...definedFields({ body }),
      };

      calls.push(call);

      return route(call);
    },
  });

  return { native: adapter.native!, calls };
}

const notFound = () => json({ error: "RecordNotFound", message: "Could not locate record" }, 400);

describe("Bluesky threadgates and postgates", () => {
  it("creates a missing threadgate with app.bsky.feed.threadgate#followerRule rules", async () => {
    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("getRecord")
        ? notFound()
        : json({ uri: `at://${did}/app.bsky.feed.threadgate/3kpost`, cid: "bafygate" }),
    );

    const ref = await native.setThreadgate({
      account,
      postUri,
      allow: [{ kind: "follower" }, { kind: "mention" }],
    });

    assert.deepEqual(ref, { uri: `at://${did}/app.bsky.feed.threadgate/3kpost`, cid: "bafygate" });
    assert.equal(calls[0]?.url.searchParams.get("collection"), "app.bsky.feed.threadgate");
    assert.equal(calls[0]?.url.searchParams.get("rkey"), "3kpost");
    assert.equal(calls[1]?.url.pathname, "/xrpc/com.atproto.repo.createRecord");
    assert.equal(calls[1]?.body?.["rkey"], "3kpost");

    const record = object(calls[1]?.body?.["record"]);
    assert.equal(record["post"], postUri);
    assert.deepEqual(record["allow"], [
      { $type: "app.bsky.feed.threadgate#followerRule" },
      { $type: "app.bsky.feed.threadgate#mentionRule" },
    ]);
  });

  it("replaces an existing threadgate with swapRecord and keeps hiddenReplies", async () => {
    const hidden = [`at://did:plc:troll/app.bsky.feed.post/3kreply`];

    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("getRecord")
        ? json({
            uri: `at://${did}/app.bsky.feed.threadgate/3kpost`,
            cid: "bafyold",
            value: {
              $type: "app.bsky.feed.threadgate",
              post: postUri,
              allow: [],
              hiddenReplies: hidden,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          })
        : json({ uri: `at://${did}/app.bsky.feed.threadgate/3kpost`, cid: "bafynew" }),
    );

    await native.setThreadgate({ account, postUri, allow: null });

    const put = calls[1];
    assert.equal(put?.url.pathname, "/xrpc/com.atproto.repo.putRecord");
    assert.equal(put?.body?.["swapRecord"], "bafyold");
    assert.deepEqual(put?.body?.["record"], {
      $type: "app.bsky.feed.threadgate",
      post: postUri,
      hiddenReplies: hidden,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("rejects a threadgate for another account's post before any request", async () => {
    const { native, calls } = harness(() => json({}));

    await assert.rejects(
      native.setThreadgate({
        account,
        postUri: "at://did:plc:other/app.bsky.feed.post/3kpost",
        allow: [],
      }),
      (error) => error instanceof SocialError && error.code === "invalid_input",
    );
    assert.equal(calls.length, 0);
  });

  it("disables quotes with an app.bsky.feed.postgate#disableRule record", async () => {
    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("getRecord")
        ? notFound()
        : json({ uri: `at://${did}/app.bsky.feed.postgate/3kpost`, cid: "bafypg" }),
    );

    await native.setQuotesDisabled({ account, postUri, disabled: true });

    assert.equal(calls[1]?.body?.["collection"], "app.bsky.feed.postgate");
    assert.deepEqual(object(calls[1]?.body?.["record"])["embeddingRules"], [
      { $type: "app.bsky.feed.postgate#disableRule" },
    ]);
  });

  it("adds and removes detachedEmbeddingUris with compare-and-swap", async () => {
    const quoteUri = "at://did:plc:alice/app.bsky.feed.post/3kquote";

    let stored: JsonObject = {
      $type: "app.bsky.feed.postgate",
      post: postUri,
      embeddingRules: [{ $type: "app.bsky.feed.postgate#disableRule" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const { native, calls } = harness(({ url, body }) => {
      if (url.pathname.endsWith("getRecord"))
        return json({
          uri: `at://${did}/app.bsky.feed.postgate/3kpost`,
          cid: "bafyv1",
          value: stored,
        });

      stored = object(body?.["record"]);

      return json({ uri: `at://${did}/app.bsky.feed.postgate/3kpost`, cid: "bafyv2" });
    });

    await native.detachQuote({ account, postUri, quoteUri, detached: true });

    assert.equal(calls[1]?.body?.["swapRecord"], "bafyv1");
    assert.deepEqual(stored["detachedEmbeddingUris"], [quoteUri]);
    assert.deepEqual(stored["embeddingRules"], [{ $type: "app.bsky.feed.postgate#disableRule" }]);

    await native.detachQuote({ account, postUri, quoteUri, detached: false });
    assert.deepEqual(stored["detachedEmbeddingUris"], []);

    await assert.rejects(
      native.detachQuote({ account, postUri, quoteUri: "https://bsky.app/x", detached: true }),
      (error) => error instanceof SocialError && error.code === "invalid_input",
    );
  });
});

describe("Bluesky hideReply", () => {
  const rootUri = `at://${did}/app.bsky.feed.post/3kroot`;
  const replyUri = "at://did:plc:bob/app.bsky.feed.post/3kreply";

  it("creates a threadgate with hiddenReplies when the root has none", async () => {
    const { native, calls } = harness(({ url }) => {
      if (url.pathname.endsWith("getPosts")) {
        const uri = url.searchParams.get("uris");

        return json({
          posts: [
            uri === replyUri
              ? {
                  uri,
                  cid: "bafyreply",
                  record: {
                    reply: {
                      root: { uri: rootUri, cid: "bafyroot" },
                      parent: { uri: rootUri, cid: "bafyroot" },
                    },
                  },
                }
              : { uri, cid: "bafyroot", record: {} },
          ],
        });
      }

      return json({ uri: `at://${did}/app.bsky.feed.threadgate/3kroot`, cid: "bafygate" });
    });

    const result = await native.hideReply({ account, replyUri, hidden: true });

    assert.equal(result.hidden, true);

    const create = calls.find((call) => call.url.pathname.endsWith("createRecord"));
    assert.equal(create?.body?.["rkey"], "3kroot");

    const record = object(create?.body?.["record"]);
    assert.deepEqual(record["hiddenReplies"], [replyUri]);
    // No allow list: hiding a reply must not close the thread.
    assert.equal(record["allow"], undefined);
  });

  it("updates an existing gate with swapRecord and unhides", async () => {
    const { native, calls } = harness(({ url }) => {
      if (url.pathname.endsWith("getPosts")) {
        const uri = url.searchParams.get("uris");

        return json({
          posts: [
            uri === replyUri
              ? {
                  uri,
                  cid: "bafyreply",
                  record: {
                    reply: {
                      root: { uri: rootUri, cid: "bafyroot" },
                      parent: { uri: rootUri, cid: "bafyroot" },
                    },
                  },
                }
              : {
                  uri,
                  cid: "bafyroot",
                  record: {},
                  threadgate: {
                    uri: `at://${did}/app.bsky.feed.threadgate/3kroot`,
                    cid: "bafyoldgate",
                    record: {
                      $type: "app.bsky.feed.threadgate",
                      post: rootUri,
                      createdAt: "2026-01-01T00:00:00.000Z",
                      hiddenReplies: [replyUri],
                    },
                  },
                },
          ],
        });
      }

      return json({ uri: `at://${did}/app.bsky.feed.threadgate/3kroot`, cid: "bafynewgate" });
    });

    const result = await native.hideReply({ account, replyUri, hidden: false });

    const put = calls.find((call) => call.url.pathname.endsWith("putRecord"));
    assert.equal(put?.body?.["swapRecord"], "bafyoldgate");
    assert.deepEqual(object(put?.body?.["record"])["hiddenReplies"], []);
    assert.deepEqual(result, {
      hidden: false,
      threadgate: { uri: `at://${did}/app.bsky.feed.threadgate/3kroot`, cid: "bafynewgate" },
    });
  });

  it("refuses to hide replies in another account's thread", async () => {
    const foreignRoot = "at://did:plc:other/app.bsky.feed.post/3kroot";

    const { native, calls } = harness(({ url }) =>
      json({
        posts: [
          {
            uri: url.searchParams.get("uris"),
            cid: "bafyreply",
            record: {
              reply: {
                root: { uri: foreignRoot, cid: "bafyroot" },
                parent: { uri: foreignRoot, cid: "bafyroot" },
              },
            },
          },
        ],
      }),
    );

    await assert.rejects(
      native.hideReply({ account, replyUri, hidden: true }),
      (error) => error instanceof SocialError && error.code === "invalid_input",
    );
    assert.equal(
      calls.some((call) => call.method === "POST"),
      false,
    );
  });
});

describe("Bluesky drafts and applyWrites", () => {
  it("creates, lists, updates, and deletes app.bsky.draft. drafts", async () => {
    const { native, calls } = harness(({ url }) => {
      if (url.pathname.endsWith("createDraft")) return json({ id: "3kdraftid2345" });

      if (url.pathname.endsWith("getDrafts"))
        return json({
          drafts: [
            {
              id: "3kdraftid2345",
              draft: { posts: [{ text: "later" }] },
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          cursor: "next",
        });

      return json({});
    });

    const draft = {
      posts: [
        { text: "Thread start", contentLabels: ["graphic-media" as const] },
        {
          text: "Second",
          linkUrl: "https://example.com",
          quote: {
            uri: "at://did:plc:alice/app.bsky.feed.post/3kquote",
            cid: "bafyquotecid",
          },
        },
      ],
      languages: ["en"],
      replyControls: [{ kind: "following" as const }],
      disableQuotes: true,
      deviceName: "server",
    };

    assert.deepEqual(await native.createDraft({ account, draft }), { id: "3kdraftid2345" });

    assert.equal(calls[0]?.url.pathname, "/xrpc/app.bsky.draft.createDraft");
    assert.deepEqual(calls[0]?.body, {
      draft: {
        posts: [
          {
            text: "Thread start",
            labels: {
              $type: "com.atproto.label.defs#selfLabels",
              values: [{ val: "graphic-media" }],
            },
          },
          {
            text: "Second",
            embedExternals: [{ uri: "https://example.com" }],
            embedRecords: [
              {
                record: {
                  uri: "at://did:plc:alice/app.bsky.feed.post/3kquote",
                  cid: "bafyquotecid",
                },
              },
            ],
          },
        ],
        langs: ["en"],
        threadgateAllow: [{ $type: "app.bsky.feed.threadgate#followingRule" }],
        postgateEmbeddingRules: [{ $type: "app.bsky.feed.postgate#disableRule" }],
        deviceName: "server",
      },
    });

    const page = await native.listDrafts({ account, limit: 10 });
    assert.equal(page.cursor, "next");
    assert.equal(page.drafts.length, 1);
    assert.equal(calls[1]?.url.pathname, "/xrpc/app.bsky.draft.getDrafts");
    assert.equal(calls[1]?.url.searchParams.get("limit"), "10");

    await native.updateDraft({ account, id: "3kdraftid2345", draft: { posts: [{ text: "v2" }] } });
    assert.deepEqual(calls[2]?.body, {
      draft: { id: "3kdraftid2345", draft: { posts: [{ text: "v2" }] } },
    });

    await native.deleteDraft({ account, id: "3kdraftid2345" });
    assert.equal(calls[3]?.url.pathname, "/xrpc/app.bsky.draft.deleteDraft");
    assert.deepEqual(calls[3]?.body, { id: "3kdraftid2345" });

    await assert.rejects(native.deleteDraft({ account, id: "not a tid" }));
    await assert.rejects(native.createDraft({ account, draft: { posts: [] } }));
    assert.equal(calls.length, 4);
  });

  it("sends com.atproto.repo.applyWrites and decodes per-write results", async () => {
    const { native, calls } = harness(() =>
      json({
        commit: { cid: "bafycommit", rev: "3krev" },
        results: [
          {
            $type: "com.atproto.repo.applyWrites#createResult",
            uri: `at://${did}/app.bsky.feed.like/3klike`,
            cid: "bafylike",
            validationStatus: "valid",
          },
          { $type: "com.atproto.repo.applyWrites#deleteResult" },
        ],
      }),
    );

    const result = await native.applyWrites({
      account,
      swapCommit: "bafyprev",
      writes: [
        {
          action: "create",
          collection: "app.bsky.feed.like",
          value: {
            $type: "app.bsky.feed.like",
            subject: { uri: postUri, cid: "bafypost" },
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
        { action: "delete", collection: "app.bsky.feed.repost", rkey: "3krepost" },
      ],
    });

    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.repo.applyWrites");
    assert.deepEqual(calls[0]?.body?.["writes"], [
      {
        $type: "com.atproto.repo.applyWrites#create",
        collection: "app.bsky.feed.like",
        value: {
          $type: "app.bsky.feed.like",
          subject: { uri: postUri, cid: "bafypost" },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
      {
        $type: "com.atproto.repo.applyWrites#delete",
        collection: "app.bsky.feed.repost",
        rkey: "3krepost",
      },
    ]);
    assert.equal(calls[0]?.body?.["swapCommit"], "bafyprev");
    assert.deepEqual(result, {
      commit: { cid: "bafycommit", rev: "3krev" },
      results: [
        {
          action: "create",
          uri: `at://${did}/app.bsky.feed.like/3klike`,
          cid: "bafylike",
          validationStatus: "valid",
        },
        { action: "delete" },
      ],
    });

    await assert.rejects(native.applyWrites({ account, writes: [] }));
    await assert.rejects(
      native.applyWrites({
        account,
        writes: [{ action: "create", collection: "app.bsky.feed.like", value: { $type: "other" } }],
      }),
    );
    assert.equal(calls.length, 1);
  });
});

describe("Bluesky blob upload", () => {
  it("posts raw bytes to com.atproto.repo.uploadBlob and decodes the blob ref [feature:bluesky.media.uploadBlob]", async () => {
    const seen: { url: URL; type: string | null; body: unknown }[] = [];

    const adapter = bluesky({
      auth: { service: "https://pds.example", did, accessJwt: "fixture" },
      fetch: async (input, init) => {
        seen.push({
          url: new URL(String(input)),
          type: new Headers(init?.headers).get("content-type"),
          body: init?.body,
        });

        return json({
          blob: { $type: "blob", ref: { $link: "bafkreiavatar" }, mimeType: "image/png", size: 4 },
        });
      },
    });

    const avatar = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

    const ref = await adapter.native!.uploadBlob({ account, blob: avatar });

    assert.equal(seen[0]?.url.pathname, "/xrpc/com.atproto.repo.uploadBlob");
    assert.equal(seen[0]?.type, "image/png");
    assert.equal(seen[0]?.body, avatar);
    assert.deepEqual(ref, {
      $type: "blob",
      ref: { $link: "bafkreiavatar" },
      mimeType: "image/png",
      size: 4,
    });

    await assert.rejects(
      adapter.native!.uploadBlob({ account, blob: new Blob([]), mimeType: "image/png" }),
      (error) => error instanceof SocialError && error.code === "invalid_input",
    );
    await assert.rejects(adapter.native!.uploadBlob({ account, blob: new Blob(["x"]) }));
    assert.equal(seen.length, 1);
  });
});
