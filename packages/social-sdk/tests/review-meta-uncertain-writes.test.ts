import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";
import { SocialError } from "../src/core/errors.js";
import { definedFields } from "../src/core/fields.js";
import { facebook } from "../src/platforms/facebook.js";
import { instagram } from "../src/platforms/instagram.js";

// Offline regressions for Meta writes whose answer is lost, unreadable or malformed after
// dispatch. Each must surface ambiguous_outcome with reconcile-first, never a silent success,
// a definite failure, or a raw validation error.

const context = (maxElapsedMs = 10_000): AdapterOperationContext => ({
  backendInstance: "default",
  correlationId: "review-offline",
  retryBudget: { maxAttempts: 1, maxElapsedMs },
});

const ig = connectedAccountRef({ backend: "default", platform: "instagram", accountId: "123" });

const fb = connectedAccountRef({ backend: "default", platform: "facebook", accountId: "123" });

const uploadUri = "https://rupload.facebook.com/ig-api-upload/v27.0/789";

const uncertain = (error: SocialError) => {
  assert.ok(error instanceof SocialError);
  assert.equal(error.code, "ambiguous_outcome");
  assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });

  return true;
};

const answering =
  (body: () => Response): typeof globalThis.fetch =>
  async () =>
    body();

const igNative = (fetch: typeof globalThis.fetch, flavor?: "facebook-login") => {
  const adapter = instagram({
    auth: { accessToken: "offline-token", accountId: "123", ...definedFields({ flavor }) },
    fetch,
  });

  assert.ok(adapter.native);

  return adapter.native;
};

const fbNative = (fetch: typeof globalThis.fetch) => {
  const adapter = facebook({ auth: { accessToken: "offline-token", pageId: "123" }, fetch });

  assert.ok(adapter.native);

  return adapter.native;
};

describe("Instagram message sends without a message ID", () => {
  for (const [label, body] of [
    ["an empty object", () => Response.json({})],
    ["an empty message_id", () => Response.json({ recipient_id: "456", message_id: "" })],
    ["a non-object body", () => Response.json(null)],
  ] as const) {
    it(`sendDirectMessage treats ${label} as uncertain`, async () => {
      await assert.rejects(
        igNative(answering(body)).sendDirectMessage({
          account: ig,
          recipientId: "456",
          message: { kind: "text", text: "offline fixture" },
          context: context(),
        }),
        uncertain,
      );
    });
  }

  it("privateReply treats a missing message_id as uncertain", async () => {
    await assert.rejects(
      igNative(answering(() => Response.json({ recipient_id: "456" }))).privateReply({
        account: ig,
        commentId: "c1",
        text: "offline fixture",
        context: context(),
      }),
      uncertain,
    );
  });

  it("still returns the documented recipient_id and message_id", async () => {
    const sent = await igNative(
      answering(() => Response.json({ recipient_id: "456", message_id: "mid.1" })),
    ).sendDirectMessage({
      account: ig,
      recipientId: "456",
      message: { kind: "text", text: "offline fixture" },
      context: context(),
    });

    assert.deepEqual(sent, { recipientId: "456", messageId: "mid.1" });
  });
});

describe("Facebook native writes with malformed answers", () => {
  it("createComment treats a missing id as uncertain", async () => {
    await assert.rejects(
      fbNative(answering(() => Response.json({}))).createComment({
        account: fb,
        objectId: "123_456",
        message: "offline fixture",
        context: context(),
      }),
      uncertain,
    );
  });

  it("sendMessage treats a non-object answer as uncertain", async () => {
    await assert.rejects(
      fbNative(answering(() => Response.json(null))).sendMessage({
        account: fb,
        recipientId: "456",
        messagingType: "RESPONSE",
        text: "offline fixture",
        context: context(),
      }),
      uncertain,
    );
  });

  it("createPersona treats a missing id as uncertain", async () => {
    await assert.rejects(
      fbNative(answering(() => Response.json({}))).createPersona({
        account: fb,
        name: "Support",
        profilePictureUrl: "https://cdn.example/persona.png",
        context: context(),
      }),
      uncertain,
    );
  });

  it("createLiveVideo treats a non-object answer as uncertain", async () => {
    await assert.rejects(
      fbNative(answering(() => Response.json([]))).createLiveVideo({
        account: fb,
        status: "UNPUBLISHED",
        context: context(),
      }),
      uncertain,
    );
  });

  it("createComment still returns the documented id", async () => {
    const created = await fbNative(answering(() => Response.json({ id: "123_789" }))).createComment(
      { account: fb, objectId: "123_456", message: "offline fixture", context: context() },
    );

    assert.deepEqual(created, { id: "123_789" });
  });
});

describe("Instagram resumable upload outcomes", () => {
  const upload = (fetch: typeof globalThis.fetch, ctx = context()) =>
    igNative(fetch, "facebook-login").uploadVideo({
      account: ig,
      uploadUri,
      source: { kind: "blob", blob: new Blob(["offline bytes"]) },
      context: ctx,
    });

  it("treats a 200 answer without success: true as uncertain", async () => {
    await assert.rejects(upload(answering(() => Response.json({}))), uncertain);
  });

  it("treats a lost response body as uncertain", async () => {
    await assert.rejects(
      upload(
        answering(
          () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("offline response body interrupted"));
                },
              }),
            ),
        ),
      ),
      uncertain,
    );
  });

  it("treats a 5xx without debug_info as uncertain", async () => {
    await assert.rejects(
      upload(answering(() => new Response("upstream unavailable", { status: 503 }))),
      uncertain,
    );
  });

  it("keeps a 4xx as a definite failure", async () => {
    await assert.rejects(
      upload(answering(() => Response.json({ error: { message: "bad" } }, { status: 400 }))),
      (error: SocialError) => {
        assert.ok(error instanceof SocialError);
        assert.equal(error.code, "upstream_failure");
        assert.deepEqual(error.retryDisposition, { kind: "never" });

        return true;
      },
    );
  });

  it("does not dispatch once container creation spent the shared budget", async () => {
    let requests = 0;

    const fetch: typeof globalThis.fetch = async () => {
      requests += 1;

      return requests === 1
        ? Response.json({ id: "789", uri: uploadUri })
        : Response.json({ success: true });
    };

    const native = igNative(fetch, "facebook-login");
    const ctx = context(100);

    const created = await native.createResumableUpload({
      account: ig,
      mediaType: "REELS",
      context: ctx,
    });

    await delay(120);

    await assert.rejects(
      native.uploadVideo({
        account: ig,
        uploadUri: created.uploadUri,
        source: { kind: "blob", blob: new Blob(["offline bytes"]) },
        context: ctx,
      }),
      (error: SocialError) => {
        assert.ok(error instanceof SocialError);
        assert.equal(error.code, "timeout");

        return true;
      },
    );
    assert.equal(requests, 1, "no upload is sent after the shared deadline");
  });

  it("aborts an upload that outlasts the budget and reports it as uncertain", async () => {
    let aborted = false;

    const fetch: typeof globalThis.fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("offline upload aborted"));
        });
      });

    await assert.rejects(upload(fetch, context(50)), uncertain);
    assert.equal(aborted, true);
  });
});
