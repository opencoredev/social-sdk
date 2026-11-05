/**
 * Every Zernio write is confirmed only by the answer Zernio's OpenAPI document gives it
 * (https://zernio.com/openapi.yaml, read 2026-11-05). Each row sends one write and gets one
 * answer: the documented one resolves, and every malformed one (a JSON `null`, an array, a
 * missing `success`, a wrong-type or other ID, a malformed documented field) is
 * `ambiguous_outcome` with `reconcile-first` after exactly one write. Writes documented as a
 * bare 200 also check the status. The sweep behind this table is in the SOC-37
 * write-confirmation notes (sweep C).
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { connectedAccountRef, SocialError } from "../src/index.js";
import type {
  AdapterOperationContext,
  CommentRef,
  ConversationRef,
  JsonValue,
  PlatformPostRef,
} from "../src/core/types.js";
import { zernio } from "../src/cloud/zernio.js";
import { zernioNative } from "../src/cloud/zernio-native.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "write-confirmation",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
};

function uncertain(error: SocialError): boolean {
  return (
    error instanceof SocialError &&
    error.code === "ambiguous_outcome" &&
    error.retryDisposition.kind === "reconcile-first"
  );
}

/** An answer with an explicit status, and a body only when `body` is set. */
class StatusAnswer {
  constructor(
    readonly status: number,
    readonly body?: JsonValue,
  ) {}

  toJSON(): JsonValue {
    return { status: this.status, body: this.body ?? "(none)" };
  }
}

type Answer = JsonValue | StatusAnswer;

const withStatus = (status: number, body?: JsonValue): Answer => new StatusAnswer(status, body);

const account = (platform: string, accountId: string) =>
  connectedAccountRef({ backend: "default", platform, accountId });

/** One backend record with a single destination, as `GET /v1/posts/{id}` returns it. */
const record = (status: string, extra: Record<string, JsonValue> = {}): JsonValue => ({
  post: {
    _id: "rec1",
    status,
    scheduledFor: "2099-01-01T00:00:00.000Z",
    platforms: [{ platform: "twitter", accountId: "x1", status, platformPostId: "111", ...extra }],
  },
});

/** Answers every write with `answer` and every read with `read`, counting the writes. */
function setup(answer: Answer, read: JsonValue = {}) {
  let writes = 0;

  const options: Parameters<typeof zernio>[0] = {
    apiKey: "fixture-only",
    clock: () => new Date("2026-11-04T12:00:00Z"),
    fetch: async (_input, init) => {
      if ((init?.method ?? "GET") === "GET") return Response.json(read);
      writes++;

      if (!(answer instanceof StatusAnswer)) return Response.json(answer);

      return answer.body === undefined
        ? new Response(null, { status: answer.status })
        : Response.json(answer.body, { status: answer.status });
    },
  };

  return { native: zernioNative(options), adapter: zernio(options), writes: () => writes };
}

type Native = ReturnType<typeof zernioNative>;

type Adapter = ReturnType<typeof zernio>;

interface Write {
  readonly name: string;
  readonly run: (native: Native, adapter: Adapter) => Promise<object | void>;
  readonly valid: readonly Answer[];
  readonly malformed: readonly Answer[];
  /** The answer to the reads the write makes first, if any. */
  readonly read?: JsonValue;
}

const commentRef = (platform: string, accountId: string): CommentRef => ({
  kind: "comment",
  version: 1,
  backend: "default",
  platform,
  accountId,
  postId: "post1",
  commentId: "comment1",
});

const conversation = (platform: string, accountId: string): ConversationRef => ({
  kind: "conversation",
  version: 1,
  backend: "default",
  platform,
  accountId,
  conversationId: "conv1",
});

const post = (platform: string, accountId: string, postId: string): PlatformPostRef => ({
  kind: "platform-post",
  version: 1,
  backend: "default",
  platform,
  accountId,
  postId,
  native: { backendRecordId: "rec1" },
});

const gbp = { account: account("google-business", "gbp1"), locationId: "locations/1" };

const guild = { account: account("discord", "dc1"), guildId: "999" };

const channel = { account: account("discord", "dc1"), channelId: "111" };

/** Answers that never confirm a `{ success: true }` write. */
const notSuccess: readonly Answer[] = [null, [], {}, { success: false }, { success: "true" }];

/** Answers that never confirm a write documented as a bare 200. */
const notBare200: readonly Answer[] = [
  [],
  "ok",
  { success: false },
  { message: "queued" },
  withStatus(201),
  withStatus(202, {}),
  withStatus(204),
];

const bare200: readonly Answer[] = [withStatus(200), {}, { success: true }];

const writes: readonly Write[] = [
  {
    name: "updateProfile",
    run: (native) => native.updateProfile({ profileId: "p2", name: "Tenant B" }, context),
    valid: [{ message: "ok", profile: { _id: "p2", name: "Tenant B" } }],
    malformed: [null, {}, { profile: {} }, { profile: { _id: "p3" } }, { profile: { _id: 2 } }],
  },
  {
    name: "updateYouTubeMetadata",
    run: (native) =>
      native.updateYouTubeMetadata(
        { post: post("youtube", "yt1", "vid1"), metadata: { title: "New title" } },
        context,
      ),
    valid: [{ success: true, videoId: "vid1", updatedFields: ["title"] }, { success: true }],
    malformed: [
      ...notSuccess,
      { success: true, updatedFields: "title" },
      { success: true, updatedFields: [1] },
      { success: true, videoId: "vid2" },
    ],
  },
  {
    name: "privateReply",
    run: (native) =>
      native.privateReply({ comment: commentRef("instagram", "ig1"), text: "Hi" }, context),
    valid: [{ status: "success", messageId: "dm1" }, { status: "success" }],
    malformed: [null, {}, { status: "failed" }, { status: "success", messageId: 1 }],
  },
  {
    name: "likePost",
    run: (native) => native.likePost({ post: post("linkedin", "li1", "p9") }, context),
    valid: [{ liked: true }, { liked: true, likeUri: "at://like" }],
    malformed: [
      null,
      {},
      { liked: false },
      { liked: true, likeUri: 3 },
      { liked: true, likeUri: "" },
    ],
  },
  {
    name: "likeComment",
    run: (native) => native.likeComment({ comment: commentRef("linkedin", "li1") }, context),
    valid: [{ liked: true, likeUri: "at://like" }],
    malformed: [null, { liked: "true" }, { liked: true, likeUri: [] }],
  },
  {
    name: "markConversationRead",
    run: (native) =>
      native.markConversationRead({ conversation: conversation("x", "x1") }, context),
    valid: [{ success: true, markedCount: 3 }, { success: true }],
    malformed: [
      ...notSuccess,
      { success: true, markedCount: "3" },
      { success: true, markedCount: 1.5 },
    ],
  },
  {
    name: "sendMessage",
    run: (native) =>
      native.sendMessage({ conversation: conversation("x", "x1"), text: "Hi" }, context),
    valid: [{ success: true, data: { messageId: "m1" } }, { success: true }],
    malformed: [
      ...notSuccess,
      { success: true, data: null },
      { success: true, data: [] },
      { success: true, data: { messageId: 7 } },
      { success: true, data: { messageId: "" } },
    ],
  },
  {
    name: "messages.send",
    run: (_native, adapter) =>
      adapter.messages?.send(conversation("x", "x1"), { text: "Hi" }, context) ??
      Promise.reject(new Error("no messages")),
    valid: [
      { success: true, data: { messageId: "m1" } },
      { success: true, data: {} },
    ],
    malformed: [
      ...notSuccess,
      { success: true, data: { messageId: 7 } },
      { success: true, data: { messageId: "" } },
    ],
  },
  {
    name: "replyToReview",
    run: (native) =>
      native.replyToReview(
        { account: account("facebook", "fb1"), reviewId: "rv1", text: "Thanks" },
        context,
      ),
    valid: [{ status: "success", reply: { id: "rp1", text: "Thanks" } }],
    malformed: [null, {}, { reply: null }, { reply: {} }, { reply: { id: 1 } }],
  },
  {
    name: "deleteReviewReply",
    run: (native) =>
      native.deleteReviewReply({ account: account("facebook", "fb1"), reviewId: "rv1" }, context),
    valid: [{ status: "success", message: "Reply deleted", platform: "facebook" }],
    malformed: [null, [], {}, { status: "failed" }, { success: true }],
  },
  {
    name: "updateWebhook",
    run: (native) => native.updateWebhook({ webhookId: "wh1", isActive: false }, context),
    valid: [{ success: true, webhook: { _id: "wh1", isActive: false } }],
    malformed: [
      ...notSuccess,
      { success: true },
      { success: true, webhook: { _id: "wh2" } },
      { success: true, webhook: [] },
    ],
  },
  {
    name: "setDefaultPinterestBoard",
    run: (native) =>
      native.setDefaultPinterestBoard(
        { account: account("pinterest", "pin1"), boardId: "b2" },
        context,
      ),
    valid: [{ message: "ok", account: { _id: "pin1", platform: "pinterest" } }],
    malformed: [
      null,
      {},
      { message: "ok" },
      { message: "ok", account: { _id: "pin2" } },
      { account: { _id: "pin1" } },
    ],
  },
  {
    name: "updateAccountGroup",
    run: (native) => native.updateAccountGroup({ groupId: "g2", name: "Renamed" }, context),
    valid: [{ message: "ok", group: { _id: "g2", name: "Renamed" } }, { group: {} }],
    malformed: [null, {}, { message: "ok" }, { group: { _id: "g3" } }, { group: [] }],
  },
  {
    name: "deleteAccountGroup",
    run: (native) => native.deleteAccountGroup({ groupId: "g2" }, context),
    valid: [{ message: "Group deleted" }],
    malformed: [null, {}, { message: "" }, { message: 1 }],
  },
  {
    name: "updateBlueskySettings",
    run: (native) =>
      native.updateBlueskySettings(
        { account: account("bluesky", "bs1"), defaultLanguages: ["en"] },
        context,
      ),
    valid: bare200,
    malformed: notBare200,
  },
  {
    name: "connectDiscord",
    run: (native) =>
      native.connectDiscord({ guildId: "999", channelIds: ["111"], profileId: "prof1" }, context),
    valid: bare200,
    malformed: notBare200,
  },
  {
    name: "setBotSetting",
    run: (native) =>
      native.setBotSetting(
        {
          account: account("facebook", "fb1"),
          setting: "messenger-menu",
          persistentMenu: [{ locale: "default", call_to_actions: [] }],
        },
        context,
      ),
    valid: bare200,
    malformed: notBare200,
  },
  {
    name: "deleteBotSetting",
    run: (native) =>
      native.deleteBotSetting(
        { account: account("facebook", "fb1"), setting: "messenger-get-started" },
        context,
      ),
    valid: bare200,
    malformed: notBare200,
  },
  {
    name: "updateFacebookPageInfo",
    run: (native) =>
      native.updateFacebookPageInfo(
        { account: account("facebook", "fb1"), about: "Bakery" },
        context,
      ),
    valid: [
      { about: "Bakery", description: null, website: null, phone: null, emails: [], hours: {} },
    ],
    malformed: [
      null,
      {},
      { about: "Bakery" },
      { emails: [], hours: {} },
      { about: "Bakery", description: null, website: null, phone: null, emails: "x", hours: {} },
      { about: "Bakery", description: null, website: null, phone: null, emails: [], hours: [] },
    ],
  },
  {
    name: "updateOAuthApp",
    run: (native) => native.updateOAuthApp({ appId: "app1", label: "Renamed" }, context),
    valid: [{ app: { id: "app1", label: "Renamed" } }],
    malformed: [null, {}, { app: {} }, { app: { id: "app2" } }],
  },
  {
    name: "testOAuthApp",
    run: (native) => native.testOAuthApp({ appId: "app1" }, context),
    valid: [{ app: { id: "app1", status: "ok" } }],
    malformed: [null, [], {}, { app: null }, { app: { id: "app2" } }],
  },
  {
    name: "saveWelcomeScreen",
    run: (native) => native.saveWelcomeScreen({ showByDefault: true, brandName: "Acme" }, context),
    valid: [{ showByDefault: true, brandName: "Acme" }],
    malformed: [
      null,
      {},
      { showByDefault: false },
      { showByDefault: "true" },
      { brandName: "Acme" },
    ],
  },
  {
    name: "bulkUpload",
    run: (native) => native.bulkUpload({ csv: "platform,content\nx,hi\n", dryRun: true }, context),
    valid: [{ total: 1, valid: 1, invalid: 0, results: [] }],
    malformed: [
      null,
      {},
      { total: 1 },
      { total: "1", valid: 1, invalid: 0, results: [] },
      { total: 1, valid: 1, invalid: 0, results: {} },
    ],
  },
  {
    name: "updateGoogleBusinessAttributes",
    run: (native) =>
      native.updateGoogleBusinessAttributes(
        {
          ...gbp,
          attributes: [{ name: "attributes/has_wifi" }],
          attributeMask: "attributes/has_wifi",
        },
        context,
      ),
    valid: [{ success: true, attributes: [] }],
    malformed: [...notSuccess, { attributes: [] }, { success: true, attributes: {} }],
  },
  {
    name: "addGoogleBusinessMedia",
    run: (native) =>
      native.addGoogleBusinessMedia(
        { ...gbp, sourceUrl: "https://cdn.example.test/front.jpg", category: "EXTERIOR" },
        context,
      ),
    valid: [{ success: true, name: "m/2", mediaFormat: "PHOTO" }],
    malformed: [...notSuccess, { name: "m/2" }, { success: true }, { success: true, name: "" }],
  },
  {
    name: "deleteGoogleBusinessMedia",
    run: (native) => native.deleteGoogleBusinessMedia({ ...gbp, mediaId: "m/2" }, context),
    valid: [{ success: true, deleted: true }],
    malformed: [...notSuccess, { deleted: true }, { success: true, deleted: false }],
  },
  {
    name: "startGoogleBusinessVerification",
    run: (native) => native.startGoogleBusinessVerification({ ...gbp, method: "AUTO" }, context),
    valid: [{ success: true, verification: { name: "v/1", state: "PENDING" } }],
    malformed: [
      ...notSuccess,
      { verification: { name: "v/1" } },
      { success: true, verification: {} },
      { success: true, verification: null },
    ],
  },
  {
    name: "updateDiscordRole",
    run: (native) => native.updateDiscordRole({ ...guild, roleId: "r1", name: "Mods" }, context),
    valid: [{ data: { id: "r1", name: "Mods" } }],
    malformed: [null, {}, { data: {} }, { data: { id: "r2" } }],
  },
  {
    name: "updateDiscordEvent",
    run: (native) =>
      native.updateDiscordEvent({ ...guild, eventId: "e1", status: "cancelled" }, context),
    valid: [{ data: { id: "e1", status: 4 } }],
    malformed: [null, {}, { data: { id: "e2" } }, { data: { id: 1 } }],
  },
  {
    name: "crosspostDiscordMessage",
    run: (native) => native.crosspostDiscordMessage({ ...channel, messageId: "m1" }, context),
    valid: [{ data: { id: "m1", channel_id: "111" } }, { data: {} }],
    malformed: [null, {}, { data: null }, { data: { id: 1 } }],
  },
  {
    name: "editComment",
    run: (native) =>
      native.editComment({ comment: commentRef("reddit", "rd1"), text: "Fixed" }, context),
    valid: [{ status: "success", commentId: "comment1", platform: "reddit" }],
    malformed: [null, [], {}, { status: "success" }, { commentId: "comment2" }],
  },
  {
    name: "setConversationStatus",
    run: (native) =>
      native.setConversationStatus(
        { conversation: conversation("facebook", "fb1"), status: "archived" },
        context,
      ),
    valid: [{ success: true, data: { id: "conv1", status: "archived" } }],
    malformed: [
      ...notSuccess,
      { data: { status: "archived" } },
      { success: true, data: { status: "active" } },
      { success: true },
    ],
  },
  {
    name: "deleteConversation",
    run: (native) =>
      native.deleteConversation({ conversation: conversation("facebook", "fb1") }, context),
    valid: [{ success: true, data: { id: "conv1", deletedMessages: 12 } }, { success: true }],
    malformed: [
      ...notSuccess,
      { success: true, data: [] },
      { success: true, data: { deletedMessages: "12" } },
    ],
  },
  {
    name: "acceptMessageRequest",
    run: (native) =>
      native.acceptMessageRequest(
        { conversation: conversation("instagram", "ig1"), text: "Hi" },
        context,
      ),
    valid: [{ success: true, data: { messageId: "m9" } }],
    malformed: [...notSuccess, { data: { messageId: "m9" } }, { success: true, data: {} }],
  },
  {
    name: "threadControl",
    run: (native) =>
      native.threadControl(
        { conversation: conversation("facebook", "fb1"), action: "take" },
        context,
      ),
    valid: [{ success: true, control: { owner: "app" } }, { success: true }],
    malformed: [...notSuccess, { success: true, control: "app" }],
  },
  {
    name: "posts.removeFromPlatform",
    read: record("published"),
    run: (_native, adapter) =>
      adapter.posts?.removeFromPlatform?.(post("x", "x1", "111"), context) ??
      Promise.reject(new Error("no removal")),
    valid: [{ success: true, message: "Unpublished" }],
    malformed: [null, [], "ok", {}, { success: false }],
  },
  {
    name: "posts.deleteBackendRecord",
    read: record("draft"),
    run: (_native, adapter) =>
      adapter.posts?.deleteBackendRecord?.(
        {
          kind: "backend-post",
          version: 1,
          backend: "default",
          platform: "x",
          accountId: "x1",
          recordId: "rec1",
        },
        context,
      ) ?? Promise.reject(new Error("no record delete")),
    valid: [{ message: "Post deleted successfully" }],
    malformed: [null, [], "ok", {}, { message: "queued" }],
  },
];

for (const write of writes) {
  for (const answer of write.malformed)
    it(`Zernio ${write.name} keeps ${JSON.stringify(answer)} uncertain after one write`, async () => {
      const { native, adapter, writes: sent } = setup(answer, write.read);

      try {
        await assert.rejects(write.run(native, adapter), uncertain);
      } finally {
        assert.equal(sent(), 1);
      }
    });

  for (const answer of write.valid)
    it(`Zernio ${write.name} confirms ${JSON.stringify(answer)} after one write`, async () => {
      const { native, adapter, writes: sent } = setup(answer, write.read);

      await write.run(native, adapter);
      assert.equal(sent(), 1);
    });
}

it("Zernio keeps only a documented error category as a failed outcome's code", async () => {
  const marker = "private-content-marker https://cdn.example.test/m.jpg?signature=fixture";

  for (const [errorCategory, code] of [
    ["auth_expired", "auth_expired"],
    [marker, "upstream_failure"],
    [7, "upstream_failure"],
  ] as const) {
    const { adapter } = setup(
      {},
      {
        post: {
          _id: "rec1",
          status: "failed",
          platforms: [
            {
              platform: "twitter",
              accountId: "x1",
              status: "failed",
              errorCategory,
              errorMessage: marker,
            },
          ],
        },
      },
    );

    const outcome = await adapter.posts?.getDelivery?.(
      { backend: "default", platform: "x", accountId: "x1", deliveryId: "rec1" },
      context,
    );

    assert.equal(outcome?.state, "failed");
    assert.equal(outcome?.state === "failed" ? outcome.code : undefined, code);
    assert.doesNotMatch(JSON.stringify(outcome), /marker|signature/);
  }
});

it("Zernio errors never carry provider prose, request values or signed URLs", async () => {
  const marker = "private-content-marker";
  const signed = "https://cdn.example.test/media?signature=fixture";

  for (const status of [400, 403, 409, 500]) {
    const options: Parameters<typeof zernio>[0] = {
      apiKey: "fixture-only",
      fetch: async () =>
        Response.json(
          {
            error: `Rejected ${marker} ${signed}`,
            code: "validation_error",
            details: { url: signed },
          },
          { status },
        ),
    };

    await assert.rejects(
      zernioNative(options).sendMessage(
        { conversation: conversation("x", "x1"), text: marker },
        context,
      ),
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
