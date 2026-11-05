import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { instagram } from "../src/platforms/instagram.js";
import {
  connectedAccountRef,
  SocialError,
  type AdapterOperationContext,
  type JsonValue,
} from "../src/core/index.js";
import { isJsonValue } from "../src/transport/json.js";

interface Call {
  readonly url: URL;
  readonly method: string;
  readonly body: JsonValue | undefined;
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

function parseJson(text: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(text);

    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A fake Graph API that answers each request with the first matching route. */
const fakeGraph = (
  routes: readonly (readonly [(call: Call) => boolean, (call: Call) => JsonValue])[],
) => {
  const calls: Call[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const text =
      init?.body === undefined || init.body === null
        ? undefined
        : await new Response(init.body).text();

    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      body: text === undefined ? undefined : parseJson(text),
    };

    calls.push(call);

    for (const [match, answer] of routes)
      if (match(call)) return new Response(JSON.stringify(answer(call)));

    return new Response(JSON.stringify({ error: { message: "unrouted" } }), { status: 404 });
  };

  return { calls, fetch };
};

const adapterFor = (fetch: typeof globalThis.fetch, flavor = "facebook-login" as const) =>
  instagram({ auth: { accessToken: "t", accountId: "1784", flavor }, fetch });

const instagramLogin = (fetch: typeof globalThis.fetch) =>
  instagram({ auth: { accessToken: "t", accountId: "1784" }, fetch });

const native = (adapter: ReturnType<typeof instagram>) => {
  const module = adapter.native;

  assert.ok(module, "expected the Instagram native module");

  return module;
};

const rejectsWith = async (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error) => error instanceof SocialError && error.code === code);

describe("Instagram likes", () => {
  it("likes media and unlikes a comment through /likes [feature:instagram.engagement.likes]", async () => {
    const graph = fakeGraph([
      [(call) => call.url.pathname === "/v27.0/1784/likes", () => ({ success: true })],
    ]);

    const instagramNative = native(adapterFor(graph.fetch));

    await instagramNative.like({ account, mediaId: "17890001", context: context() });

    await instagramNative.unlike({ account, commentId: "17890002", context: context() });

    assert.equal(graph.calls[0]?.url.origin, "https://graph.facebook.com");

    assert.equal(graph.calls[0]?.method, "POST");

    assert.equal(graph.calls[0]?.url.searchParams.get("media_id"), "17890001");

    assert.equal(graph.calls[0]?.url.searchParams.get("comment_id"), null);

    assert.equal(graph.calls[1]?.method, "DELETE");

    assert.equal(graph.calls[1]?.url.searchParams.get("comment_id"), "17890002");

    assert.equal(graph.calls[1]?.url.searchParams.get("media_id"), null);
  });

  it("reports an unconfirmed like as ambiguous [feature:instagram.engagement.likes]", async () => {
    const graph = fakeGraph([[() => true, () => ({})]]);

    await rejectsWith(
      native(adapterFor(graph.fetch)).like({ account, mediaId: "1", context: context() }),
      "ambiguous_outcome",
    );
  });

  it("needs Facebook Login and a numeric target before sending [feature:instagram.engagement.likes]", async () => {
    const graph = fakeGraph([[() => true, () => ({ success: true })]]);

    await rejectsWith(
      native(instagramLogin(graph.fetch)).like({ account, mediaId: "1", context: context() }),
      "unsupported_capability",
    );

    await rejectsWith(
      native(adapterFor(graph.fetch)).like({ account, mediaId: "abc", context: context() }),
      "invalid_input",
    );

    assert.equal(graph.calls.length, 0);
  });
});

describe("Instagram caption add-on results", () => {
  it("reads poll vote shares from /poll_attachment", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname === "/v27.0/1790/poll_attachment",
        () => ({
          poll_attachment: {
            option_a: "Espresso",
            option_b: "Cold brew",
            option_c: "Tea",
            option_a_votes_percentage: 0.5,
            option_b_votes_percentage: 0.3,
            option_c_votes_percentage: 0.2,
            total_votes: 421,
            expiration_timestamp: "2026-11-07T10:00:00+0000",
          },
        }),
      ],
      [
        (call) => call.url.pathname === "/v27.0/1791/poll_attachment",
        () => ({ poll_attachment: null }),
      ],
    ]);

    const instagramNative = native(adapterFor(graph.fetch));

    const poll = await instagramNative.getPollResults({
      account,
      mediaId: "1790",
      context: context(),
    });

    assert.deepEqual(poll, {
      options: [
        { text: "Espresso", votesPercentage: 0.5 },
        { text: "Cold brew", votesPercentage: 0.3 },
        { text: "Tea", votesPercentage: 0.2 },
      ],
      totalVotes: 421,
      expiresAt: "2026-11-07T10:00:00+0000",
    });

    assert.equal(graph.calls[0]?.url.searchParams.get("fields"), null);

    const none = await instagramNative.getPollResults({
      account,
      mediaId: "1791",
      context: context(),
    });

    assert.equal(none, undefined);
  });

  it("rejects a poll with an out-of-range share instead of guessing", async () => {
    const graph = fakeGraph([
      [
        () => true,
        () => ({
          poll_attachment: {
            option_a: "A",
            option_b: "B",
            option_a_votes_percentage: 62,
            option_b_votes_percentage: 0.38,
            total_votes: 10,
          },
        }),
      ],
    ]);

    await rejectsWith(
      native(adapterFor(graph.fetch)).getPollResults({
        account,
        mediaId: "1790",
        context: context(),
      }),
      "upstream_failure",
    );
  });

  it("pages comment prompt answers from /prompt_response", async () => {
    const graph = fakeGraph([
      [
        (call) =>
          call.url.pathname === "/v27.0/1790/prompt_response" &&
          call.url.searchParams.get("after") === null,
        () => ({
          data: [],
          paging: {
            cursors: { after: "page2" },
            next: "https://graph.facebook.com/v27.0/1790/prompt_response?after=page2",
          },
        }),
      ],
      [
        (call) => call.url.pathname === "/v27.0/1790/prompt_response",
        () => ({
          data: [
            {
              id: "1787",
              text: "Cold brew, no contest",
              timestamp: "2026-09-12T19:16:02+0000",
              username: "coffee_fan",
            },
          ],
          paging: { cursors: { after: "page3" } },
        }),
      ],
      [(call) => call.url.pathname === "/v27.0/1791/prompt_response", () => ({ data: null })],
    ]);

    const instagramNative = native(adapterFor(graph.fetch));

    const first = await instagramNative.listPromptResponses({
      account,
      mediaId: "1790",
      limit: 10,
      context: context(),
    });

    assert.deepEqual(first, { items: [], nextCursor: "page2", available: true });

    assert.equal(graph.calls[0]?.url.searchParams.get("fields"), "id,text,timestamp,username");

    assert.equal(graph.calls[0]?.url.searchParams.get("limit"), "10");

    const second = await instagramNative.listPromptResponses({
      account,
      mediaId: "1790",
      cursor: first.nextCursor,
      context: context(),
    });

    assert.equal(graph.calls[1]?.url.searchParams.get("after"), "page2");

    assert.deepEqual(second, {
      items: [
        {
          id: "1787",
          text: "Cold brew, no contest",
          timestamp: "2026-09-12T19:16:02+0000",
          username: "coffee_fan",
        },
      ],
      available: true,
    });

    const none = await instagramNative.listPromptResponses({
      account,
      mediaId: "1791",
      context: context(),
    });

    assert.deepEqual(none, { items: [], available: false });
  });

  it("returns caption and add-on warnings from media_publish", async () => {
    const graph = fakeGraph([
      [(call) => call.url.pathname.endsWith("/1784/media"), () => ({ id: "container1" })],
      [
        (call) => call.url.searchParams.get("fields") === "id,status_code,status",
        () => ({ id: "container1", status_code: "FINISHED" }),
      ],
      [
        (call) => call.url.pathname.endsWith("/media_publish"),
        () => ({
          id: "post1",
          config_issue: "CAPTION_NOT_ATTACHED",
          caption_add_on_attachment_status: "POLL_CREATION_FAILURE",
        }),
      ],
    ]);

    const outcome = await adapterFor(graph.fetch).posts?.publishTarget(
      {
        targetIndex: 0,
        targetKey: "instagram",
        account,
        content: {
          text: "Which roast?",
          media: [
            {
              kind: "image",
              mimeType: "image/jpeg",
              width: 1080,
              height: 1080,
              source: { kind: "https-url", url: "https://cdn.example/1.jpg" },
            },
          ],
        },
        options: { poll: { options: ["Light", "Dark"] } },
      },
      context(),
    );

    assert.equal(outcome?.state, "published");

    assert.ok(outcome?.state === "published");

    assert.equal(outcome.post.postId, "post1");

    assert.deepEqual(outcome.issues, [
      {
        code: "CAPTION_NOT_ATTACHED",
        path: "config_issue",
        message: "Instagram published the media without its caption.",
        severity: "warning",
      },
      {
        code: "POLL_CREATION_FAILURE",
        path: "caption_add_on_attachment_status",
        message: "Instagram published the media without its caption poll.",
        severity: "warning",
      },
    ]);
  });
});

describe("Instagram read fields", () => {
  it("bounds tagged media by posted_after and posted_before", async () => {
    const graph = fakeGraph([[() => true, () => ({ data: [] })]]);

    const instagramNative = native(instagramLogin(graph.fetch));

    await instagramNative.listTaggedMedia({
      account,
      postedAfter: "2026-10-01T00:00:00Z",
      postedBefore: "2026-11-01T00:00:00Z",
      context: context(),
    });

    await instagramNative.mentions({
      account,
      postedAfter: "2026-10-15T09:12:31",
      context: context(),
    });

    const first = graph.calls[0]?.url;

    assert.equal(first?.pathname, "/v27.0/1784/tags");

    assert.equal(first?.searchParams.get("posted_after"), "2026-10-01T00:00:00Z");

    assert.equal(first?.searchParams.get("posted_before"), "2026-11-01T00:00:00Z");

    assert.equal(graph.calls[1]?.url.searchParams.get("posted_after"), "2026-10-15T09:12:31");

    assert.equal(graph.calls[1]?.url.searchParams.get("posted_before"), null);

    await rejectsWith(
      instagramNative.listMentions({
        account,
        postedAfter: "2026-11-01T00:00:00Z",
        postedBefore: "2026-10-01T00:00:00Z",
        context: context(),
      }),
      "invalid_input",
    );

    await rejectsWith(
      instagramNative.listMentions({ account, postedAfter: "yesterday", context: context() }),
      "invalid_input",
    );

    assert.equal(graph.calls.length, 2);
  });

  it("keeps the next cursor when the posted_after window empties a tagged media page", async () => {
    const graph = fakeGraph([
      [() => true, () => ({ data: [], paging: { cursors: { before: "b1", after: "a1" } } })],
    ]);

    const instagramNative = native(instagramLogin(graph.fetch));

    const windowed = await instagramNative.listTaggedMedia({
      account,
      postedAfter: "2026-10-01T00:00:00Z",
      context: context(),
    });

    assert.deepEqual(windowed, { items: [], nextCursor: "a1" });

    const unfiltered = await instagramNative.listMentions({ account, context: context() });

    assert.deepEqual(unfiltered, { items: [] });
  });

  it("requests media_audio_type, Reel feed sharing, comment state and total views", async () => {
    const graph = fakeGraph([
      [
        () => true,
        () => ({
          id: "1790",
          media_type: "VIDEO",
          media_audio_type: "ORIGINAL_SOUND",
          is_shared_to_feed: false,
          is_comment_enabled: true,
          total_views_count: 5120,
        }),
      ],
    ]);

    const postRef = {
      kind: "platform-post" as const,
      version: 1 as const,
      backend: "instagram",
      platform: "instagram",
      accountId: "1784",
      postId: "1790",
    };

    const post = await adapterFor(graph.fetch).posts?.get?.(postRef, context());

    const fields = graph.calls[0]?.url.searchParams.get("fields")?.split(",") ?? [];

    for (const field of [
      "media_audio_type",
      "is_shared_to_feed",
      "is_comment_enabled",
      "total_views_count",
    ])
      assert.ok(fields.includes(field), field);

    assert.deepEqual(post, {
      id: "1790",
      media_type: "VIDEO",
      media_audio_type: "ORIGINAL_SOUND",
      is_shared_to_feed: false,
      is_comment_enabled: true,
      total_views_count: 5120,
    });

    const login = fakeGraph([[() => true, () => ({ data: [] })]]);

    await instagramLogin(login.fetch).posts?.list?.(account, {}, context());

    const listed = login.calls[0]?.url.searchParams.get("fields")?.split(",") ?? [];

    assert.ok(listed.includes("media_audio_type"));

    assert.ok(!listed.includes("total_views_count"), "total_views_count is Facebook Login only");
  });

  it("reads has_profile_pic and is_published on the own profile [feature:instagram.read.own_profile.status_fields]", async () => {
    const graph = fakeGraph([
      [
        () => true,
        () => ({ id: "1784", username: "roastery", has_profile_pic: true, is_published: false }),
      ],
    ]);

    const profile = await adapterFor(graph.fetch).graph?.getProfile?.(account, {}, context());

    const fields = graph.calls[0]?.url.searchParams.get("fields")?.split(",") ?? [];

    assert.ok(fields.includes("has_profile_pic") && fields.includes("is_published"));

    assert.equal(profile?.native?.["has_profile_pic"], true);

    assert.equal(profile?.native?.["is_published"], false);
  });
});
