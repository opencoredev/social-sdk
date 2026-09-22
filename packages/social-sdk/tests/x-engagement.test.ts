import { strict as assert } from "node:assert";
import { it } from "node:test";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";
import { xLike, xUnlike } from "../src/platforms/x-engagement.js";

const context: AdapterOperationContext = {
  backendInstance: "direct",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

it("uses typed X like/unlike mutations with ownership and no replay", async () => {
  const calls: RequestInit[] = [];
  const urls: string[] = [];
  const account = connectedAccountRef({ backend: "direct", platform: "x", accountId: "u" });

  const result = await xLike(
    "123",
    account,
    {
      userId: "u",
      accessToken: "token",
      fetch: async (_input, init) => {
        urls.push(String(_input));
        calls.push(init!);

        return new Response(JSON.stringify({ data: { liked: true } }), { status: 200 });
      },
    },
    context,
  );

  assert.equal(result.liked, true);
  assert.equal(calls[0]?.method, "POST");
  await xUnlike(
    "123",
    account,
    {
      userId: "u",
      accessToken: "token",
      fetch: async (_input, init) => {
        urls.push(String(_input));
        calls.push(init!);

        return new Response(JSON.stringify({ data: { liked: false } }), { status: 200 });
      },
    },
    context,
  );
  assert.equal(calls[1]?.method, "DELETE");
  assert.deepEqual(urls, [
    "https://api.x.com/2/users/u/likes",
    "https://api.x.com/2/users/u/likes/123",
  ]);
  assert.deepEqual(JSON.parse(String(calls[0]?.body)), { tweet_id: "123" });
  assert.equal(calls[1]?.body, undefined);
  await assert.rejects(() =>
    xLike(
      "123",
      connectedAccountRef({ backend: "direct", platform: "x", accountId: "other" }),
      { userId: "u", accessToken: "token" },
      context,
    ),
  );
});

it("classifies a lost X mutation response as ambiguous without retry", async () => {
  let calls = 0;
  await assert.rejects(() =>
    xLike(
      "123",
      connectedAccountRef({ backend: "direct", platform: "x", accountId: "u" }),
      {
        userId: "u",
        accessToken: "token",
        fetch: async () => {
          calls++;
          throw new TypeError("connection lost");
        },
      },
      context,
    ),
  );
  assert.equal(calls, 1);
});

it("does not invent confirmation and bounds uncooperative fetch and response reads", async () => {
  const account = connectedAccountRef({ backend: "direct", platform: "x", accountId: "u" });

  for (const data of [{}, { data: { liked: false } }, { errors: [{ detail: "failed" }] }]) {
    await assert.rejects(
      xLike(
        "123",
        account,
        { userId: "u", accessToken: "token", fetch: async () => Response.json(data) },
        { ...context },
      ),
      (error: any) => error.code === "ambiguous_outcome",
    );
  }

  for (const fetch of [
    async () => new Promise<Response>(() => {}),
    async () =>
      new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
        headers: { "content-type": "application/json" },
      }),
  ]) {
    await assert.rejects(
      xLike(
        "123",
        account,
        { userId: "u", accessToken: "token", fetch },
        { ...context, retryBudget: { maxAttempts: 5, maxElapsedMs: 10 } },
      ),
      (error: any) => error.code === "ambiguous_outcome",
    );
  }

  let calls = 0;
  await assert.rejects(
    xLike(
      "123",
      { ...account, backend: "other" },
      {
        userId: "u",
        accessToken: "token",
        fetch: async () => {
          calls++;

          return Response.json({ data: { liked: true } });
        },
      },
      { ...context },
    ),
  );
  assert.equal(calls, 0);
});
