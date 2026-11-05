/**
 * Every Instagram write is confirmed only by its documented Graph answer. Each row sends one
 * write and gets one answer: the documented one resolves, and every malformed one is
 * `ambiguous_outcome` with `reconcile-first` after exactly one write. Error tests check that
 * no Meta prose, request value or upload URL reaches a `SocialError`. The sweep behind this
 * table is in the SOC-37 write-confirmation notes (sweep C).
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { connectedAccountRef, SocialError } from "../src/index.js";
import type { AdapterOperationContext, JsonValue } from "../src/core/types.js";
import { instagram, type InstagramNative } from "../src/platforms/instagram.js";

const baseContext: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "write-confirmation",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
};

const context = (signal?: AbortSignal): AdapterOperationContext => {
  if (signal === undefined) return baseContext;

  return { ...baseContext, signal };
};

const account = connectedAccountRef({
  backend: "default",
  platform: "instagram",
  accountId: "ig1",
});

function uncertain(error: SocialError): boolean {
  return (
    error instanceof SocialError &&
    error.code === "ambiguous_outcome" &&
    error.retryDisposition.kind === "reconcile-first"
  );
}

function setup(respond: () => Response) {
  let writes = 0;

  const adapter = instagram({
    auth: { accessToken: "fixture-only", accountId: "ig1", flavor: "facebook-login" },
    fetch: async (_input, init) => {
      if ((init?.method ?? "GET") === "GET") throw new Error("Unexpected read");
      writes++;

      return respond();
    },
  });

  const native = adapter.native;

  if (native === undefined) throw new Error("The Instagram adapter has no native surface");

  return { native, writes: () => writes };
}

const notSuccess: readonly JsonValue[] = [null, [], {}, { success: false }, { success: "true" }];

const notCreated: readonly JsonValue[] = [null, [], {}, { id: 7 }, { id: "" }];

interface Write {
  readonly name: string;
  readonly run: (native: InstagramNative) => Promise<object | void>;
  readonly valid: readonly JsonValue[];
  readonly malformed: readonly JsonValue[];
}

const writes: readonly Write[] = [
  {
    name: "moderateComment",
    run: (native) =>
      native.moderateComment({ account, commentId: "c1", hidden: true, context: context() }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "deleteComment",
    run: (native) => native.deleteComment({ account, commentId: "c1", context: context() }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "setCommentsEnabled",
    run: (native) =>
      native.setCommentsEnabled({ account, mediaId: "m1", enabled: false, context: context() }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "deletePost",
    run: (native) => native.deletePost({ account, postId: "m1", context: context() }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "like",
    run: (native) => native.like({ account, mediaId: "17890001", context: context() }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "respondToCollaborationInvite",
    run: (native) =>
      native.respondToCollaborationInvite({
        account,
        mediaId: "9001",
        accept: true,
        context: context(),
      }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "createUpcomingEvent",
    run: (native) =>
      native.createUpcomingEvent({
        account,
        title: "Launch",
        startTime: "2026-12-01T18:00:00Z",
        context: context(),
      }),
    valid: [{ id: "ev1" }],
    malformed: notCreated,
  },
  {
    name: "updateUpcomingEvent",
    run: (native) =>
      native.updateUpcomingEvent({ account, eventId: "ev1", title: "Renamed", context: context() }),
    valid: [{ id: "ev1" }],
    malformed: [...notCreated, { id: "ev2" }],
  },
  {
    name: "createComment",
    run: (native) =>
      native.createComment({ account, mediaId: "m1", text: "Nice", context: context() }),
    valid: [{ id: "c2" }],
    malformed: notCreated,
  },
  {
    name: "replyToMention",
    run: (native) =>
      native.replyToMention({ account, mediaId: "m1", text: "Thanks", context: context() }),
    valid: [{ id: "c3" }],
    malformed: notCreated,
  },
  {
    name: "sendDirectMessage",
    run: (native) =>
      native.sendDirectMessage({
        account,
        recipientId: "igsid1",
        message: { kind: "text", text: "Hi" },
        context: context(),
      }),
    valid: [{ recipient_id: "igsid1", message_id: "mid.1" }, { message_id: "mid.1" }],
    malformed: [
      null,
      [],
      {},
      { message_id: "" },
      { message_id: "mid.1", recipient_id: 7 },
      { message_id: "mid.1", recipient_id: "" },
    ],
  },
  {
    name: "privateReply",
    run: (native) =>
      native.privateReply({ account, commentId: "c1", text: "Hi", context: context() }),
    valid: [{ recipient_id: "igsid1", message_id: "mid.2" }],
    malformed: [null, {}, { message_id: 2 }, { message_id: "mid.2", recipient_id: false }],
  },
  {
    name: "reactToMessage",
    run: (native) =>
      native.reactToMessage({
        account,
        recipientId: "igsid1",
        messageId: "mid.1",
        reaction: "love",
        context: context(),
      }),
    valid: [{ recipient_id: "igsid1" }, {}],
    malformed: [null, [], "ok", { recipient_id: "igsid9" }, { recipient_id: 1 }],
  },
  {
    name: "removeReaction",
    run: (native) =>
      native.removeReaction({
        account,
        recipientId: "igsid1",
        messageId: "mid.1",
        context: context(),
      }),
    valid: [{ recipient_id: "igsid1" }, {}],
    malformed: [null, [], "ok", { recipient_id: "igsid9" }],
  },
  {
    name: "sendSenderAction",
    run: (native) =>
      native.sendSenderAction({
        account,
        recipientId: "igsid1",
        action: "typing_on",
        context: context(),
      }),
    valid: [{ recipient_id: "igsid1" }, {}],
    malformed: [null, [], true, { recipient_id: "igsid9" }],
  },
  {
    name: "setIceBreakers",
    run: (native) =>
      native.setIceBreakers({
        account,
        iceBreakers: [{ questions: [{ question: "Do you ship?", payload: "SHIP" }] }],
        context: context(),
      }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "deletePersistentMenu",
    run: (native) => native.deletePersistentMenu({ account, context: context() }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "subscribeWebhooks",
    run: (native) =>
      native.subscribeWebhooks({ account, fields: ["comments"], context: context() }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "updateProductTags",
    run: (native) =>
      native.updateProductTags({
        account,
        mediaId: "media1",
        tags: [{ productId: "3231775643511089", x: 0.3, y: 0.6 }],
        context: context(),
      }),
    valid: [{ success: true }],
    // Meta documents `{ "success": true }`; a bare boolean is not that answer.
    malformed: [...notSuccess, true],
  },
];

for (const write of writes) {
  for (const answer of write.malformed)
    it(`Instagram ${write.name} keeps ${JSON.stringify(answer)} uncertain after one write`, async () => {
      const { native, writes: sent } = setup(() => Response.json(answer));

      try {
        await assert.rejects(write.run(native), uncertain);
      } finally {
        assert.equal(sent(), 1);
      }
    });

  for (const answer of write.valid)
    it(`Instagram ${write.name} confirms ${JSON.stringify(answer)} after one write`, async () => {
      const { native, writes: sent } = setup(() => Response.json(answer));

      await write.run(native);
      assert.equal(sent(), 1);
    });
}

const uploadUri = "https://rupload.facebook.com/ig-api-upload/v27.0/container9";

it("Instagram uploadVideo cancelled before dispatch is cancelled and sends nothing", async () => {
  const { native, writes: sent } = setup(() => Response.json({ success: true }));
  const controller = new AbortController();

  controller.abort();

  await assert.rejects(
    native.uploadVideo({
      account,
      uploadUri,
      source: { kind: "https-url", url: "https://cdn.example.test/video.mp4" },
      context: context(controller.signal),
    }),
    { code: "cancelled" },
  );
  assert.equal(sent(), 0);
});

it("Instagram upload refusals keep only a machine type, never Meta's prose", async () => {
  const marker = "private-content-marker https://cdn.example.test/v.mp4?signature=fixture";

  for (const [status, debug] of [
    [400, { retriable: false, type: "ProcessingFailedError", message: marker }],
    [200, { retriable: true, type: "not a machine code!", message: marker }],
  ] as const) {
    const { native } = setup(() => Response.json({ debug_info: debug }, { status }));

    await assert.rejects(
      native.uploadVideo({
        account,
        uploadUri,
        source: { kind: "https-url", url: "https://cdn.example.test/video.mp4" },
        context: context(),
      }),
      (error: SocialError) => {
        assert.ok(error instanceof SocialError);
        assert.equal(error.code, "upstream_failure");
        assert.doesNotMatch(
          `${error.message} ${JSON.stringify(error.details ?? {})}`,
          /marker|signature/,
        );
        assert.deepEqual(
          error.details,
          debug.type === "ProcessingFailedError" ? { type: "ProcessingFailedError" } : undefined,
        );

        return true;
      },
    );
  }
});

it("Instagram upload transport failures do not keep a cause that can carry the URL", async () => {
  const { native } = setup(() => {
    throw new TypeError(`fetch failed for ${uploadUri}?signature=fixture`);
  });

  await assert.rejects(
    native.uploadVideo({
      account,
      uploadUri,
      source: { kind: "https-url", url: "https://cdn.example.test/video.mp4" },
      context: context(),
    }),
    (error: SocialError) => {
      assert.ok(uncertain(error));
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, /signature|rupload/);

      return true;
    },
  );
});
