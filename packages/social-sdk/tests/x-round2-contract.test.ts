import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, type AdapterOperationContext } from "../src/index.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "11" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "x-round2-contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

const expiry = 1_790_000_000_000;

for (const operation of ["create", "rotate"]) {
  it(`preserves integer token_expires_at_ms when bots ${operation} tokens`, async () => {
    const seen: string[] = [];

    const adapter = x({
      auth: { userId: "11", accessToken: "fake-user" },
      appBearerToken: "fake-app",
      fetch: async (input, init) => {
        seen.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);

        return Response.json({
          data: { id: "12", token: "fake-bot", token_expires_at_ms: expiry },
        });
      },
    });

    assert.ok(adapter.native);

    const result =
      operation === "create"
        ? await adapter.native.createBot({ account, handle: "helper_bot", context })
        : await adapter.native.rotateBotToken({ account, botId: "12", context });

    assert.deepEqual(seen, [operation === "create" ? "POST /2/bots" : "POST /2/bots/12/token"]);
    assert.equal(result.token, "fake-bot");
    assert.equal(result.tokenExpiresAtMs, String(expiry));
  });
}

it("stops a Chat media upload when APPEND returns provider errors", async () => {
  const seen: string[] = [];

  const adapter = x({
    auth: { userId: "11", accessToken: "fake-user" },
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;

      seen.push(path);

      if (path.endsWith("/initialize"))
        return Response.json({
          data: { session_id: "123", media_hash_key: "abc123", conversation_id: "g123" },
        });

      if (path.endsWith("/append"))
        return Response.json({
          errors: [
            {
              type: "https://api.x.com/2/problems/invalid-request",
              title: "Invalid Request",
              detail: "The media segment was rejected.",
            },
          ],
        });

      return Response.json({ data: { success: true } });
    },
  });

  assert.ok(adapter.native);

  await assert.rejects(
    adapter.native.uploadChatMedia({
      account,
      conversationId: "g123",
      media: new Blob([new Uint8Array([1, 2, 3])]),
      context,
    }),
  );
  assert.deepEqual(seen, ["/2/chat/media/upload/initialize", "/2/chat/media/upload/123/append"]);
});

for (const stream of ["likes_firehose", "likes_sample10"] satisfies readonly (
  | "likes_firehose"
  | "likes_sample10"
)[]) {
  it(`forwards documented tweet fields and media expansions for ${stream}`, async () => {
    const seen: URL[] = [];

    const adapter = x({
      auth: { userId: "11", accessToken: "fake-user" },
      appBearerToken: "fake-app",
      fetch: async (input) => {
        seen.push(new URL(String(input)));

        return new Response('{"data":{"liked_tweet_id":"21"}}\n', {
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.ok(adapter.native);

    const events = [];

    for await (const event of adapter.native.volumeStream({
      account,
      stream,
      partition: 1,
      tweetFields: ["created_at"],
      expansions: ["attachments.media_keys"],
      mediaFields: ["url"],
      context,
    }))
      events.push(event);

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.searchParams.get("tweet.fields"), "created_at");
    assert.equal(seen[0]?.searchParams.get("expansions"), "attachments.media_keys");
    assert.equal(seen[0]?.searchParams.get("media.fields"), "url");
    assert.deepEqual(events, [{ kind: "data", data: { liked_tweet_id: "21" } }]);
  });
}
