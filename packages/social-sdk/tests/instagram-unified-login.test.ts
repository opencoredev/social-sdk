import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { instagram } from "../src/platforms/instagram.js";
import {
  connectedAccountRef,
  type AdapterOperationContext,
  type JsonValue,
} from "../src/core/index.js";
import { instagramOAuth, threadsOAuth } from "../src/server/oauth.js";
import { decodePlatformWebhook } from "../src/server/webhooks.js";

interface Call {
  readonly url: URL;
  readonly method: string;
}

const context = (): AdapterOperationContext => ({
  backendInstance: "instagram",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
});

const account = connectedAccountRef({
  backend: "instagram",
  platform: "instagram",
  accountId: "1784",
});

/** A fake Graph API that answers each request with the first matching route. */
const fakeGraph = (
  routes: readonly (readonly [(call: Call) => boolean, (call: Call) => JsonValue])[],
) => {
  const calls: Call[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call: Call = { url: new URL(String(input)), method: init?.method ?? "GET" };

    calls.push(call);

    for (const [match, answer] of routes)
      if (match(call)) return new Response(JSON.stringify(answer(call)));

    return new Response(JSON.stringify({ error: { message: "unrouted" } }), { status: 404 });
  };

  return { calls, fetch };
};

const native = (adapter: ReturnType<typeof instagram>) => {
  const module = adapter.native;

  assert.ok(module, "expected the Instagram native module");

  return module;
};

describe("Instagram Unified Login onboarding", () => {
  it("reads client_business_id and pages /me/assigned_instagram_accounts", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname === "/v27.0/me" && call.url.searchParams.has("fields"),
        () => ({ client_business_id: "5550001", id: "app-scoped-1" }),
      ],
      [
        (call) =>
          call.url.pathname === "/v27.0/me/assigned_instagram_accounts" &&
          !call.url.searchParams.has("after"),
        () => ({
          data: [
            { id: "1784", username: "roastery" },
            { id: "1785", username: "roastery.cafe" },
          ],
          paging: { cursors: { before: "b1", after: "a1" } },
        }),
      ],
      [
        (call) => call.url.pathname === "/v27.0/me/assigned_instagram_accounts",
        () => ({ data: [] }),
      ],
    ]);

    const adapter = instagram({
      auth: { accessToken: "system-user-token", accountId: "1784", flavor: "facebook-login" },
      fetch: graph.fetch,
    });

    const businessId = await native(adapter).getClientBusinessId({ context: context() });

    assert.equal(businessId, "5550001");

    assert.equal(graph.calls[0]?.url.origin, "https://graph.facebook.com");

    assert.equal(graph.calls[0]?.url.searchParams.get("fields"), "client_business_id");

    const first = await native(adapter).listAssignedAccounts({ limit: 2, context: context() });

    assert.deepEqual(first, {
      items: [
        { id: "1784", username: "roastery" },
        { id: "1785", username: "roastery.cafe" },
      ],
      nextCursor: "a1",
    });

    assert.equal(graph.calls[1]?.url.searchParams.get("fields"), "id,username");

    assert.equal(graph.calls[1]?.url.searchParams.get("limit"), "2");

    const last = await native(adapter).listAssignedAccounts({
      cursor: first.nextCursor,
      context: context(),
    });

    assert.equal(graph.calls[2]?.url.searchParams.get("after"), "a1");

    assert.deepEqual(last, { items: [] });
  });

  it("refuses assigned_instagram_accounts discovery with an Instagram Login token", async () => {
    const graph = fakeGraph([]);

    const adapter = instagram({
      auth: { accessToken: "t", accountId: "1784" },
      fetch: graph.fetch,
    });

    await assert.rejects(native(adapter).listAssignedAccounts({ context: context() }), {
      code: "unsupported_capability",
    });

    assert.equal(graph.calls.length, 0);
  });
});

describe("Instagram conversation lookup", () => {
  it("finds one person's thread with user_id [feature:instagram.messaging.conversation_by_user]", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.searchParams.get("user_id") === "9001",
        () => ({ data: [{ id: "aWdfZAG06" }] }),
      ],
      [(call) => call.url.searchParams.get("user_id") === "9002", () => ({ data: [] })],
    ]);

    const instagramNative = native(
      instagram({ auth: { accessToken: "t", accountId: "1784" }, fetch: graph.fetch }),
    );

    const found = await instagramNative.findConversation({
      account,
      userId: "9001",
      context: context(),
    });

    assert.equal(graph.calls[0]?.url.origin, "https://graph.instagram.com");

    assert.equal(graph.calls[0]?.url.pathname, "/v27.0/1784/conversations");

    assert.equal(graph.calls[0]?.url.searchParams.get("platform"), "instagram");

    assert.deepEqual(found, {
      kind: "conversation",
      version: 1,
      backend: "instagram",
      platform: "instagram",
      accountId: "1784",
      conversationId: "aWdfZAG06",
    });

    const missing = await instagramNative.findConversation({
      account,
      userId: "9002",
      context: context(),
    });

    assert.equal(missing, undefined);

    await assert.rejects(
      instagramNative.findConversation({ account, userId: "../me", context: context() }),
      { code: "invalid_input" },
    );

    assert.equal(graph.calls.length, 2);
  });
});

describe("Instagram Business Login options", () => {
  const start = (options: Parameters<typeof instagramOAuth>[0]) =>
    instagramOAuth(options).start({
      platforms: ["instagram"],
      capabilities: [],
      redirectUri: "https://app.example/callback",
      state: "state-1",
      codeChallenge: "challenge",
    });

  it("sends force_reauth and enable_fb_login only when set [feature:instagram.auth.business_login_options]", async () => {
    const url = new URL(
      (await start({ clientId: "client", forceReauth: true, enableFacebookLogin: false }))
        .authorizationUrl,
    );

    assert.equal(url.origin + url.pathname, "https://www.instagram.com/oauth/authorize");

    assert.equal(url.searchParams.get("force_reauth"), "true");

    assert.equal(url.searchParams.get("enable_fb_login"), "false");

    const plain = new URL((await start({ clientId: "client" })).authorizationUrl);

    assert.equal(plain.searchParams.has("force_reauth"), false);

    assert.equal(plain.searchParams.has("enable_fb_login"), false);

    assert.throws(() => threadsOAuth({ clientId: "client", forceReauth: true }));
  });
});

describe("Instagram messaging webhook variants", () => {
  const decodeMessaging = (event: JsonValue) =>
    decodePlatformWebhook({
      platform: "instagram",
      backend: "default",
      body: new TextEncoder().encode(
        JSON.stringify({
          object: "instagram",
          entry: [{ id: "1784", time: 1, messaging: [event] }],
        }),
      ),
    });

  const base = { sender: { id: "9001" }, recipient: { id: "1784" }, timestamp: 1 };

  it("tells deleted, self-test, unsupported, handoff and story-reply messages apart", async () => {
    const cases = [
      [{ mid: "m1", is_deleted: true }, "message_deleted", "message.updated"],
      [{ mid: "m2", text: "test", is_self: true }, "message_self", "unknown"],
      [{ mid: "m3", is_unsupported: true }, "message_unsupported", "message.received"],
      [
        { admin_text: "The assistant handed this conversation to you.", handoff_reason: "ASKED" },
        "message_handoff",
        "unknown",
      ],
      [
        {
          mid: "m4",
          text: "Love it",
          reply_to: {
            story: {
              id: "story1",
              url: "https://cdn.example/story.jpg",
              link_sticker_url: "https://shop.example/sale",
            },
          },
        },
        "story_reply",
        "message.received",
      ],
      [{ mid: "m5", text: "hi" }, "messages", "message.received"],
    ] as const;

    for (const [message, originalType, type] of cases) {
      const event = await decodeMessaging({ ...base, message });

      assert.equal(event.originalType, originalType);

      assert.equal(event.type, type);
    }

    const story = await decodeMessaging({ ...base, message: cases[4][0] });

    assert.match(JSON.stringify(story.data), /"link_sticker_url":"https:\/\/shop.example\/sale"/);
  });

  it("types messaging_policy_enforcement and response_feedback", async () => {
    const policy = await decodeMessaging({
      recipient: { id: "1784" },
      timestamp: 1,
      policy_enforcement: { action: "block", reason: "Policy violation" },
    });

    assert.equal(policy.originalType, "messaging_policy_enforcement");

    assert.equal(policy.type, "account.updated");

    const feedback = await decodeMessaging({
      ...base,
      response_feedback: { mid: "m1", feedback: "Good response" },
    });

    assert.equal(feedback.originalType, "response_feedback");

    assert.equal(feedback.type, "message.reaction");
  });
});
