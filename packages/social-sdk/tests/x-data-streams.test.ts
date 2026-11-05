import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, type AdapterOperationContext } from "../src/index.js";
import { x, type XDataStreamEvent } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "11" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "x-data-streams",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

const encoder = new TextEncoder();

function lines(messages: readonly string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const message of messages) controller.enqueue(encoder.encode(message));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function fake(messages: readonly string[], withAppToken = true) {
  const seen: { href: string; authorization: string | null }[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    seen.push({
      href: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });

    return lines(messages);
  };

  const auth = { userId: "11", accessToken: "user" };

  const adapter = withAppToken ? x({ auth, appBearerToken: "app", fetch }) : x({ auth, fetch });

  assert.ok(adapter.native);

  return { native: adapter.native, seen };
}

async function collect(
  events: AsyncIterable<XDataStreamEvent>,
): Promise<readonly XDataStreamEvent[]> {
  const out: XDataStreamEvent[] = [];

  for await (const event of events) out.push(event);

  return out;
}

it("reads the X Activity API stream from /2/activity/stream with recovery options", async () => {
  const event = {
    data: {
      event_type: "post.create",
      filter: { user_id: "11" },
      payload: { id: "1700000000000000000" },
    },
  };

  const { native, seen } = fake([`${JSON.stringify(event)}\r\n`, "\r\n"]);

  const events = await collect(
    native.activityStream({
      account,
      backfillMinutes: 2,
      startTime: "2026-11-04T10:00:00Z",
      endTime: "2026-11-04T11:00:00Z",
      context,
    }),
  );

  assert.deepEqual(events, [{ kind: "data", data: event.data }]);
  assert.deepEqual(seen, [
    {
      href: "https://api.x.com/2/activity/stream?backfill_minutes=2&start_time=2026-11-04T10%3A00%3A00Z&end_time=2026-11-04T11%3A00%3A00Z",
      authorization: "Bearer app",
    },
  ]);
});

it("refuses the activity stream without an app bearer token", async () => {
  const { native, seen } = fake([], false);

  await assert.rejects(collect(native.activityStream({ account, context })), {
    code: "missing_permission",
  });
  assert.equal(seen.length, 0);
});

it("connects to /2/tweets/sample/stream, sample10 and firehose volume streams", async () => {
  const post = { data: { id: "1700000000000000000", text: "hello" } };

  const { native, seen } = fake([`${JSON.stringify(post)}\n`]);

  const events = await collect(
    native.volumeStream({ account, stream: "sample", tweetFields: ["created_at"], context }),
  );

  assert.deepEqual(events, [{ kind: "data", data: post.data }]);
  assert.equal(seen[0]?.href, "https://api.x.com/2/tweets/sample/stream?tweet.fields=created_at");

  await collect(native.volumeStream({ account, stream: "sample10", partition: 2, context }));
  await collect(
    native.volumeStream({
      account,
      stream: "firehose",
      partition: 20,
      backfillMinutes: 5,
      context,
    }),
  );
  await collect(native.volumeStream({ account, stream: "firehose_en", partition: 8, context }));
  await collect(native.volumeStream({ account, stream: "likes_firehose", partition: 1, context }));

  assert.deepEqual(
    seen.slice(1).map((request) => request.href),
    [
      "https://api.x.com/2/tweets/sample10/stream?partition=2",
      "https://api.x.com/2/tweets/firehose/stream?partition=20&backfill_minutes=5",
      "https://api.x.com/2/tweets/firehose/stream/lang/en?partition=8",
      "https://api.x.com/2/likes/firehose/stream?partition=1",
    ],
  );
});

it("validates partitions and windows before connecting to a volume stream", async () => {
  const { native, seen } = fake([]);

  for (const input of [
    { stream: "firehose", partition: 21 },
    { stream: "sample10" },
    { stream: "sample", partition: 1 },
    { stream: "sample", startTime: "2026-11-04T10:00:00Z" },
    { stream: "likes_sample10", partition: 1, expansions: ["author_id"] },
    { stream: "likes_firehose", partition: 1, tweetFields: ["note_post"] },
    { stream: "firehose", partition: 1, expansions: ["liked_tweet_id"] },
  ] as const)
    await assert.rejects(collect(native.volumeStream({ account, ...input, context })), {
      code: "invalid_input",
    });

  assert.equal(seen.length, 0);
});

it("reads compliance streams from compliance/stream and the label stream", async () => {
  const deletion = {
    data: {
      delete: { tweet: { id: "1700000000000000000", author_id: "12" }, event_at: "2026-11-04" },
    },
  };

  const { native, seen } = fake([`${JSON.stringify(deletion)}\n`]);

  const events = await collect(
    native.complianceStream({ account, stream: "posts", partition: 1, context }),
  );

  assert.deepEqual(events, [{ kind: "data", data: deletion.data }]);

  await collect(native.complianceStream({ account, stream: "users", partition: 4, context }));
  await collect(native.complianceStream({ account, stream: "likes", context }));
  await collect(
    native.complianceStream({ account, stream: "labels", backfillMinutes: 1, context }),
  );

  assert.deepEqual(
    seen.map((request) => request.href),
    [
      "https://api.x.com/2/tweets/compliance/stream?partition=1",
      "https://api.x.com/2/users/compliance/stream?partition=4",
      "https://api.x.com/2/likes/compliance/stream",
      "https://api.x.com/2/tweets/label/stream?backfill_minutes=1",
    ],
  );

  await assert.rejects(collect(native.complianceStream({ account, stream: "posts", context })), {
    code: "invalid_input",
  });
});
