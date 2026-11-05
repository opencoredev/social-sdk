import { it } from "node:test";
import assert from "node:assert/strict";
import type { AdapterOperationContext } from "../src/index.js";
import { youtube } from "../src/platforms/youtube.js";
import {
  JsonArrayStreamSplitter,
  type YouTubeLiveChatStreamPage,
} from "../src/platforms/youtube-chat-stream.js";

function context(signal?: AbortSignal): AdapterOperationContext {
  const base: AdapterOperationContext = {
    backendInstance: "default",
    correlationId: "live-chat-stream",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
  };

  return signal === undefined ? base : { ...base, signal };
}

interface Seen {
  readonly url: URL;
  readonly headers: Headers;
}

/** A response whose body delivers `chunks` one read at a time. */
function chunked(chunks: readonly string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();

  let index = 0;

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[index];

      index += 1;

      if (next === undefined) controller.close();
      else controller.enqueue(encoder.encode(next));
    },
  });

  return new Response(body, init);
}

function streamFor(respond: () => Response) {
  const seen: Seen[] = [];

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });

    return respond();
  };

  const adapter = youtube({ auth: { accessToken: "test", channelId: "channel1" }, fetch });

  return { seen, native: adapter.native! };
}

async function collect(
  pages: AsyncIterable<YouTubeLiveChatStreamPage>,
): Promise<YouTubeLiveChatStreamPage[]> {
  const result: YouTubeLiveChatStreamPage[] = [];

  for await (const page of pages) result.push(page);

  return result;
}

const first = {
  kind: "youtube#liveChatMessageListResponse",
  nextPageToken: "tok1",
  pollingIntervalMillis: 0,
  items: [{ id: "m1", snippet: { displayMessage: 'He said "{hi}" \\ ok' } }],
};

const second = {
  kind: "youtube#liveChatMessageListResponse",
  nextPageToken: "tok2",
  offlineAt: "2026-11-04T10:00:00Z",
  items: [{ id: "m2", snippet: { displayMessage: "[bye]" } }],
};

it("streams liveChat/messages/stream pages split across chunks (streamList)", async () => {
  const body = `[${JSON.stringify(first)}\n,\r\n${JSON.stringify(second)}\n]`;

  const cut = [11, 40, 97, body.length - 3];

  const parts = cut.map((end, i) => body.slice(i === 0 ? 0 : cut[i - 1], end));

  parts.push(body.slice(cut.at(-1)));

  const { seen, native } = streamFor(() => chunked(parts));

  const pages = await collect(
    native.liveChatStream({
      liveChatId: "chat1",
      pageToken: "resume",
      hl: "de",
      profileImageSize: 64,
      context: context(),
    }),
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url.origin, "https://www.googleapis.com");
  assert.equal(seen[0]?.url.pathname, "/youtube/v3/liveChat/messages/stream");
  assert.deepEqual(Object.fromEntries(seen[0]?.url.searchParams ?? []), {
    liveChatId: "chat1",
    part: "id,snippet,authorDetails",
    pageToken: "resume",
    hl: "de",
    profileImageSize: "64",
  });
  assert.equal(seen[0]?.headers.get("authorization"), "Bearer test");
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0]?.items, first.items);
  assert.equal(pages[0]?.nextPageToken, "tok1");
  assert.equal(pages[0]?.pollingIntervalMillis, 0);
  assert.equal(pages[1]?.offlineAt, "2026-11-04T10:00:00Z");
  assert.equal(pages[1]?.nextPageToken, "tok2");
});

it("splits a streamed JSON array one element at a time, including a single object body", () => {
  const splitter = new JsonArrayStreamSplitter();

  assert.deepEqual(splitter.push('[{"a":"}"'), []);
  assert.deepEqual(splitter.push(',"b":[1,{"c":2}]}'), ['{"a":"}","b":[1,{"c":2}]}']);
  assert.equal(splitter.finished, false);
  assert.deepEqual(splitter.push(',{"d":"\\""}]'), ['{"d":"\\""}']);
  assert.equal(splitter.finished, true);

  const single = new JsonArrayStreamSplitter();

  assert.deepEqual(single.push('{"items":[]}'), ['{"items":[]}']);
  assert.equal(single.finished, true);
  assert.throws(() => single.push("{"), { code: "upstream_failure" });
  assert.throws(() => new JsonArrayStreamSplitter().push("data: {}"), {
    code: "upstream_failure",
  });
});

it("raises an error element YouTube sends mid-stream", async () => {
  const { native } = streamFor(() =>
    chunked([
      `[${JSON.stringify(first)},`,
      '{"error":{"code":403,"message":"chat ended","status":"PERMISSION_DENIED"}}]',
    ]),
  );

  const received: YouTubeLiveChatStreamPage[] = [];

  await assert.rejects(
    (async () => {
      for await (const page of native.liveChatStream({ liveChatId: "chat1", context: context() }))
        received.push(page);
    })(),
    { code: "upstream_failure", upstreamStatus: 403, upstreamCode: "PERMISSION_DENIED" },
  );
  assert.equal(received.length, 1);
  assert.equal(received[0]?.nextPageToken, "tok1");
});

it("reports a stream that ends before the closing bracket as interrupted", async () => {
  const { native } = streamFor(() => chunked([`[${JSON.stringify(first)}`]));

  await assert.rejects(
    collect(native.liveChatStream({ liveChatId: "chat1", context: context() })),
    {
      code: "upstream_failure",
      upstreamCode: "stream-connection-interrupted",
    },
  );
});

it("maps HTTP failures: quotaExceeded to rate_limited, 404 to not_found, 401 to reconnect", async () => {
  const quota = streamFor(() =>
    Response.json({ error: { code: 403, errors: [{ reason: "quotaExceeded" }] } }, { status: 403 }),
  );

  await assert.rejects(
    collect(quota.native.liveChatStream({ liveChatId: "chat1", context: context() })),
    { code: "rate_limited", upstreamStatus: 403 },
  );

  const missing = streamFor(() => Response.json({ error: { code: 404 } }, { status: 404 }));

  await assert.rejects(
    collect(missing.native.liveChatStream({ liveChatId: "chat1", context: context() })),
    { code: "not_found" },
  );

  const expired = streamFor(() => new Response("", { status: 401 }));

  await assert.rejects(
    collect(expired.native.liveChatStream({ liveChatId: "chat1", context: context() })),
    { code: "reconnect_required" },
  );
});

it("validates input before connecting and stops when the caller aborts", async () => {
  const { seen, native } = streamFor(() => chunked([`[${JSON.stringify(first)},`]));

  await assert.rejects(collect(native.liveChatStream({ liveChatId: " ", context: context() })), {
    code: "invalid_input",
  });
  await assert.rejects(
    collect(
      native.liveChatStream({ liveChatId: "chat1", profileImageSize: 8, context: context() }),
    ),
    { code: "invalid_input" },
  );
  assert.equal(seen.length, 0);

  const controller = new AbortController();

  const received: YouTubeLiveChatStreamPage[] = [];

  await assert.rejects(
    (async () => {
      for await (const page of native.liveChatStream({
        liveChatId: "chat1",
        context: context(controller.signal),
      })) {
        received.push(page);
        controller.abort();
      }
    })(),
    { code: "cancelled" },
  );
  assert.equal(received.length, 1);
});

it("times out a silent stream after stallTimeoutMs", async () => {
  const { native } = streamFor(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("["));
          },
        }),
      ),
  );

  await assert.rejects(
    collect(native.liveChatStream({ liveChatId: "chat1", stallTimeoutMs: 20, context: context() })),
    { code: "timeout" },
  );
});
