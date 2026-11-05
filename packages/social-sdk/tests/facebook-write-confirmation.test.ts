/**
 * Every Facebook write is confirmed only by its documented Graph answer. Each row sends its
 * writes and gets one answer per write: the documented one resolves, and every malformed one
 * (a JSON `null`, an array, an empty object, a wrong-type or other ID, a missing `success`) is
 * `ambiguous_outcome` with `reconcile-first` after exactly the expected writes. The sweep behind
 * this table is in the SOC-37 write-confirmation notes (sweep C).
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { connectedAccountRef, createSocial, SocialError } from "../src/index.js";
import type { AdapterOperationContext, JsonValue } from "../src/core/types.js";
import { facebook, type FacebookNative } from "../src/platforms/facebook.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "write-confirmation",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
};

const clock = () => new Date("2026-10-24T12:00:00.000Z");

const page = connectedAccountRef({ backend: "default", platform: "facebook", accountId: "123" });

function uncertain(error: SocialError): boolean {
  return (
    error instanceof SocialError &&
    error.code === "ambiguous_outcome" &&
    error.retryDisposition.kind === "reconcile-first"
  );
}

/** Answers every write in order with `answers`, and counts them. */
function setup(answers: readonly JsonValue[]) {
  let writes = 0;

  const adapter = facebook({
    auth: { pageId: "123", accessToken: "fixture-only" },
    clock,
    fetch: async (_input, init) => {
      const answer = answers[writes++];

      if (answer === undefined || (init?.method ?? "GET") === "GET")
        throw new Error("Unexpected request");

      return Response.json(answer);
    },
  });

  const native = adapter.native;

  if (native === undefined) throw new Error("The Facebook adapter has no native surface");

  return { adapter, native, writes: () => writes };
}

/** Graph answers that are not `{ success: true }`. */
const notSuccess: readonly JsonValue[] = [
  null,
  [],
  {},
  { success: false },
  { success: "true" },
  "ok",
];

/** Graph answers that are not an object with a non-empty string `id`. */
const notCreated: readonly JsonValue[] = [null, [], {}, { id: 7 }, { id: "" }, { success: true }];

interface Write {
  readonly name: string;
  readonly run: (native: FacebookNative) => Promise<object | void>;
  readonly valid: readonly JsonValue[];
  readonly malformed: readonly JsonValue[];
}

const writes: readonly Write[] = [
  {
    name: "deletePost",
    run: (native) => native.deletePost({ account: page, postId: "123_1", context }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "deleteComment",
    run: (native) => native.deleteComment({ account: page, commentId: "c1", context }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "moderateComment",
    run: (native) =>
      native.moderateComment({ account: page, commentId: "c1", hidden: true, context }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "updatePost",
    run: (native) => native.updatePost({ account: page, postId: "123_1", message: "x", context }),
    valid: [{ success: true }],
    malformed: notSuccess,
  },
  {
    name: "inviteReelCollaborator",
    run: (native) =>
      native.inviteReelCollaborator({
        account: page,
        videoId: "r1",
        collaboratorPageId: "456",
        context,
      }),
    valid: [{ success: true }, { success: true, collaborator_id: "c9" }],
    malformed: [
      ...notSuccess,
      { success: true, collaborator_id: 9 },
      { success: true, invitation_link: "" },
    ],
  },
  {
    name: "createLiveVideo",
    run: (native) =>
      native.createLiveVideo({ account: page, status: "LIVE_NOW", title: "Launch", context }),
    valid: [{ id: "lv1" }, { id: "lv1", secure_stream_url: "rtmps://live.example.test/s" }],
    malformed: [...notCreated, { id: "lv1", secure_stream_url: 7 }],
  },
  {
    name: "createComment",
    run: (native) =>
      native.createComment({ account: page, objectId: "123_1", message: "hi", context }),
    valid: [{ id: "c2" }],
    malformed: notCreated,
  },
  {
    name: "blockUser",
    run: (native) => native.blockUser({ account: page, userId: "555", context }),
    valid: [{ "555": true }],
    malformed: [null, [], {}, { "999": true }, { "555": "true" }, { "555": false }],
  },
  {
    name: "sendMessage",
    run: (native) =>
      native.sendMessage({
        account: page,
        recipientId: "555",
        messagingType: "RESPONSE",
        text: "hi",
        context,
      }),
    valid: [{ recipient_id: "555", message_id: "m_1" }, { message_id: "m_1" }],
    malformed: [
      null,
      [],
      {},
      { message_id: "" },
      { message_id: "m_1", recipient_id: 555 },
      { message_id: "m_1", attachment_id: "" },
    ],
  },
  {
    name: "privateReply",
    run: (native) => native.privateReply({ account: page, commentId: "c1", text: "hi", context }),
    valid: [{ recipient_id: "555", message_id: "m_2" }],
    malformed: [null, [], {}, { message_id: 3 }, { message_id: "m_2", recipient_id: "" }],
  },
  {
    name: "sendSenderAction",
    run: (native) =>
      native.sendSenderAction({ account: page, recipientId: "555", action: "typing_on", context }),
    valid: [{ recipient_id: "555" }],
    malformed: [null, [], {}, { recipient_id: "999" }, { recipient_id: 555 }],
  },
  {
    name: "createCustomLabel",
    run: (native) => native.createCustomLabel({ account: page, name: "VIP", context }),
    valid: [{ id: "777" }, { id: 777 }],
    malformed: [null, [], {}, { id: "" }, { id: 0 }, { id: -3 }, { id: 1.5 }, { success: true }],
  },
  {
    name: "createUtilityTemplate",
    run: (native) =>
      native.createUtilityTemplate({
        account: page,
        name: "order_update",
        language: "en",
        components: [{ type: "BODY", text: "Order shipped" }],
        context,
      }),
    valid: [{ id: "t1", status: "PENDING", category: "UTILITY" }, { id: "t1" }],
    malformed: [...notCreated, { id: "t1", status: 7 }, { id: "t1", category: "" }],
  },
];

for (const write of writes) {
  for (const answer of write.malformed)
    it(`Facebook ${write.name} keeps ${JSON.stringify(answer)} uncertain after one write`, async () => {
      const { native, writes: sent } = setup([answer]);

      try {
        await assert.rejects(write.run(native), uncertain);
      } finally {
        assert.equal(sent(), 1);
      }
    });

  for (const answer of write.valid)
    it(`Facebook ${write.name} confirms ${JSON.stringify(answer)} after one write`, async () => {
      const { native, writes: sent } = setup([answer]);

      await write.run(native);
      assert.equal(sent(), 1);
    });
}

it("Facebook native.updatePost reschedules with scheduled_publish_time", async () => {
  const sent: unknown[] = [];

  const adapter = facebook({
    auth: { pageId: "123", accessToken: "fixture-only" },
    clock,
    fetch: async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));

      return Response.json({ success: true });
    },
  });

  await adapter.native?.updatePost({
    account: page,
    postId: "123_1",
    scheduleAt: "2026-10-26T12:00:00.000Z",
    context,
  });

  assert.deepEqual(sent, [{ scheduled_publish_time: "1793016000" }]);

  // Outside Meta's 10-minute to 30-day window, nothing is sent.
  await assert.rejects(
    adapter.native?.updatePost({
      account: page,
      postId: "123_1",
      scheduleAt: "2026-10-24T12:05:00.000Z",
      context,
    }) ?? Promise.resolve(),
    { code: "invalid_input" },
  );
  assert.equal(sent.length, 1);
});

const photo = {
  kind: "image",
  mimeType: "image/jpeg",
  source: { kind: "https-url", url: "https://cdn.example.test/bike.jpg" },
} as const;

for (const { answer, state } of [
  { answer: { id: "p1", post_id: "123_9" }, state: "published" },
  { answer: { id: "p1" }, state: "published" },
  { answer: { id: "p1", post_id: 9 }, state: "unknown" },
  { answer: { id: "p1", post_id: "" }, state: "unknown" },
  { answer: { post_id: "123_9" }, state: "published" },
  { answer: {}, state: "unknown" },
  { answer: null, state: "unknown" },
] as const)
  it(`Facebook single-photo publish reports ${state} for ${JSON.stringify(answer)}`, async () => {
    const { adapter, writes: sent } = setup([answer]);

    const result = await createSocial({ backend: adapter, clock }).posts.publish({
      targets: [{ account: page }],
      content: { text: "Bike", media: [photo] },
    });

    assert.equal(result.outcomes[0]?.state, state);
    assert.equal(sent(), 1);
  });

it("Facebook chunked upload keeps a non-advancing transfer answer uncertain", async () => {
  const { adapter, writes: sent } = setup([
    { video_id: "v3", upload_session_id: "s1", start_offset: "0", end_offset: "4" },
    { start_offset: "0", end_offset: "4" },
  ]);

  const result = await createSocial({ backend: adapter, clock }).posts.publish({
    targets: [{ account: page, options: { chunkedUpload: true } }],
    content: {
      text: "Big file",
      media: [
        {
          kind: "video",
          mimeType: "video/mp4",
          filename: "big.mp4",
          source: {
            kind: "blob",
            blob: new Blob([new Uint8Array(6)], { type: "video/mp4" }),
            fingerprint: "big",
          },
        },
      ],
    },
  });

  const outcome = result.outcomes[0];

  assert.equal(outcome?.state, "unknown");
  assert.equal(outcome?.delivery?.deliveryId, "v3");
  assert.equal(sent(), 2);
});

it("Facebook errors never carry Graph prose, request values or signed URLs", async () => {
  const marker = "private-content-marker";
  const signed = "https://cdn.example.test/media?signature=fixture";

  for (const status of [400, 403, 500]) {
    const adapter = facebook({
      auth: { pageId: "123", accessToken: "fixture-only" },
      clock,
      fetch: async () =>
        Response.json(
          {
            error: {
              message: `Rejected ${marker} ${signed}`,
              error_user_msg: marker,
              type: "OAuthException",
              code: 100,
              fbtrace_id: "trace",
            },
          },
          { status },
        ),
    });

    await assert.rejects(
      adapter.native?.createComment({
        account: page,
        objectId: "123_1",
        message: marker,
        context,
      }) ?? Promise.resolve(),
      (error: SocialError) => {
        assert.ok(error instanceof SocialError, `HTTP ${status}`);

        const exposed = [
          error.message,
          JSON.stringify(error.details ?? {}),
          error.cause instanceof Error ? error.cause.message : String(error.cause ?? ""),
        ].join(" ");

        assert.doesNotMatch(exposed, new RegExp(marker));
        assert.doesNotMatch(exposed, /signature=fixture/);
        assert.doesNotMatch(exposed, /fixture-only/);

        return true;
      },
    );
  }
});
