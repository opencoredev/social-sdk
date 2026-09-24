/* oxlint-disable anti-slop/require-readable-spacing -- compact mocked transport fixtures. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, createSocial, type AdapterOperationContext } from "../src/index.js";
import { x, type XStreamEvent } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });
const auth = { userId: "u1", accessToken: "user-token" };

function context(signal?: AbortSignal): AdapterOperationContext {
  const base: AdapterOperationContext = {
    backendInstance: "default",
    correlationId: "x-stream-test",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
  };

  if (signal === undefined) return base;
  return { ...base, signal };
}

const encoder = new TextEncoder();

function streamBody(chunks: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** A body that sends the given chunks and then stays open until cancelled. */
function openBody(chunks: readonly string[], onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      onCancel();
    },
  });
}

function native(fetch: typeof globalThis.fetch, withAppToken = true) {
  const social = createSocial({
    backend: withAppToken ? x({ auth, fetch, appBearerToken: "app-token" }) : x({ auth, fetch }),
  });
  return social.native("default", { acknowledgeUnsafe: true });
}

async function collect(events: AsyncIterable<XStreamEvent>): Promise<XStreamEvent[]> {
  const out: XStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

it("X filtered stream yields posts across chunk boundaries and skips keep-alives", async () => {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const post = JSON.stringify({
    data: { id: "1790000000000000001", text: "hello", edit_history_tweet_ids: ["1"] },
    includes: { users: [{ id: "u9", username: "someone" }] },
    matching_rules: [{ id: "1166916266197536768", tag: "coffee" }, { id: "2" }, { tag: "no-id" }],
  });
  const disconnect = JSON.stringify({
    errors: [
      {
        title: "operational-disconnect",
        type: "https://api.x.com/2/problems/operational-disconnect",
      },
    ],
  });
  const api = native(async (input, init) => {
    requests.push({ url: new URL(String(input)), init });
    return new Response(
      streamBody([
        "\r\n",
        post.slice(0, 20),
        `${post.slice(20)}\r\n\r\n`,
        '{"data":{"id":"2","text":"héllo"}}\r\n',
        `${disconnect}\r\n`,
        '{"unknown_message":true}',
      ]),
    );
  });

  const events = await collect(
    api.stream({
      account,
      context: context(),
      tweetFields: ["created_at", "author_id", "created_at"],
      expansions: ["author_id"],
      userFields: ["username"],
    }),
  );

  assert.equal(requests.length, 1, "the adapter never reconnects on its own");
  const request = requests[0];
  assert.equal(request?.url.pathname, "/2/tweets/search/stream");
  assert.equal(request?.url.searchParams.get("tweet.fields"), "created_at,author_id");
  assert.equal(request?.url.searchParams.get("expansions"), "author_id");
  assert.equal(request?.url.searchParams.get("user.fields"), "username");
  assert.equal(request?.url.searchParams.has("backfill_minutes"), false);
  assert.equal(request?.init?.redirect, "error");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer app-token");

  assert.equal(events.length, 4);
  const first = events[0];
  assert.equal(first?.kind, "post");
  if (first?.kind === "post") {
    assert.equal(first.post["id"], "1790000000000000001");
    assert.deepEqual(first.matchingRules, [
      { id: "1166916266197536768", tag: "coffee" },
      { id: "2" },
    ]);
    assert.deepEqual(first.includes, { users: [{ id: "u9", username: "someone" }] });
  }
  const second = events[1];
  assert.equal(second?.kind === "post" ? second.post["text"] : undefined, "héllo");
  assert.equal(events[2]?.kind, "error");
  assert.deepEqual(events[3], { kind: "other", message: { unknown_message: true } });
});

it("X filtered stream closes the connection when the caller stops iterating", async () => {
  let cancelled = false;
  let fetchSignal: AbortSignal | undefined;
  const api = native(async (_input, init) => {
    fetchSignal = init?.signal ?? undefined;
    return new Response(
      openBody(['{"data":{"id":"1","text":"a"}}\r\n'], () => {
        cancelled = true;
      }),
    );
  });

  for await (const event of api.stream({ account, context: context() })) {
    assert.equal(event.kind, "post");
    break;
  }

  assert.equal(cancelled, true);
  assert.equal(fetchSignal?.aborted, true);
});

it("X filtered stream stops with cancelled when the context signal aborts", async () => {
  const controller = new AbortController();
  const api = native(
    async () => new Response(openBody(['{"data":{"id":"1","text":"a"}}\n'], () => undefined)),
  );
  const iterator = api.stream({ account, context: context(controller.signal) });

  assert.equal((await iterator.next()).value?.kind, "post");
  const pending = iterator.next();
  controller.abort();
  await assert.rejects(pending, { name: "SocialError", code: "cancelled" });
});

it("X filtered stream fails with timeout when neither data nor keep-alive arrives", async () => {
  const api = native(async () => new Response(openBody([], () => undefined)));

  await assert.rejects(collect(api.stream({ account, context: context(), stallTimeoutMs: 1000 })), {
    name: "SocialError",
    code: "timeout",
    message: /1000 ms/,
  });
});

it("X filtered stream maps connection failures to structured errors", async () => {
  interface ExpectedError {
    readonly code: string;
    readonly retryDisposition?: { readonly kind: "after-delay"; readonly delayMs: number };
  }
  const cases: readonly [number, Record<string, string>, ExpectedError][] = [
    [401, {}, { code: "reconnect_required" }],
    [403, {}, { code: "missing_permission" }],
    [
      429,
      { "retry-after": "60" },
      { code: "rate_limited", retryDisposition: { kind: "after-delay", delayMs: 60_000 } },
    ],
    [503, {}, { code: "upstream_failure" }],
  ];

  for (const [status, headers, expected] of cases) {
    const api = native(async () => new Response("{}", { status, headers }));
    await assert.rejects(collect(api.stream({ account, context: context() })), {
      name: "SocialError",
      upstreamStatus: status,
      ...expected,
    });
  }
});

it("X filtered stream rejects malformed messages", async () => {
  const api = native(async () => new Response(streamBody(["{not json}\r\n"])));

  await assert.rejects(collect(api.stream({ account, context: context() })), {
    name: "SocialError",
    code: "upstream_failure",
  });
});

it("X filtered stream validates input and credentials before any request", async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    return new Response(streamBody([]));
  };

  await assert.rejects(collect(native(fetch, false).stream({ account, context: context() })), {
    name: "SocialError",
    code: "missing_permission",
  });
  const api = native(fetch);
  await assert.rejects(
    collect(api.stream({ account, context: context(), backfillMinutes: 6 })),
    /backfillMinutes/,
  );
  await assert.rejects(
    collect(
      api.stream({
        account,
        context: context(),
        startTime: "2026-09-24T10:00:00Z",
        endTime: "2026-09-24T09:00:00Z",
      }),
    ),
    /startTime must be earlier/,
  );
  await assert.rejects(
    collect(api.stream({ account, context: context(), stallTimeoutMs: 10 })),
    /stallTimeoutMs/,
  );
  await assert.rejects(
    collect(
      api.stream({
        account: connectedAccountRef({ backend: "default", platform: "x", accountId: "other" }),
        context: context(),
      }),
    ),
    { name: "SocialError", code: "unauthorized" },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collect(api.stream({ account, context: context(controller.signal) })), {
    name: "SocialError",
    code: "cancelled",
  });
  assert.equal(calls, 0);
});

it("X filtered stream passes Enterprise backfill and recovery parameters", async () => {
  let requested: URL | undefined;
  const api = native(async (input) => {
    requested = new URL(String(input));
    return new Response(streamBody([]));
  });

  await collect(
    api.stream({
      account,
      context: context(),
      backfillMinutes: 5,
      startTime: "2026-09-24T09:00:00Z",
      endTime: "2026-09-24T10:00:00Z",
    }),
  );
  assert.equal(requested?.searchParams.get("backfill_minutes"), "5");
  assert.equal(requested?.searchParams.get("start_time"), "2026-09-24T09:00:00Z");
  assert.equal(requested?.searchParams.get("end_time"), "2026-09-24T10:00:00Z");
});

it("X stream rules list, add, and delete with the app-only token", async () => {
  const requests: { url: URL; method: string; auth: string | null; body: string }[] = [];
  const api = native(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      auth: new Headers(init?.headers).get("authorization"),
      body: String(init?.body ?? ""),
    });

    if (method === "GET")
      return Response.json({
        data: [{ id: "1166916266197536768", value: "coffee -is:retweet", tag: "coffee" }],
        meta: { result_count: 1, next_token: "ABCDEFGHIJKLMNOP" },
      });

    const body = JSON.parse(String(init?.body));

    if (body.add)
      return Response.json({
        data: [{ id: "1166916266197536769", value: "tea", tag: "tea" }],
        meta: { sent: "2026-09-24T10:00:00.000Z", summary: { created: 1, not_created: 1 } },
        errors: [
          { value: "coffee -is:retweet", title: "DuplicateRule", id: "1166916266197536768" },
        ],
      });

    return Response.json({
      meta: { sent: "2026-09-24T10:00:00.000Z", summary: { deleted: 1, not_deleted: 0 } },
    });
  });

  const page = await api.listStreamRules({
    account,
    ids: ["1166916266197536768"],
    limit: 10,
    context: context(),
  });
  assert.deepEqual(page.items, [
    { id: "1166916266197536768", value: "coffee -is:retweet", tag: "coffee" },
  ]);
  assert.equal(page.nextCursor, "ABCDEFGHIJKLMNOP");

  const added = await api.addStreamRules({
    account,
    rules: [{ value: "tea", tag: "tea" }, { value: "coffee -is:retweet" }],
    dryRun: true,
    context: context(),
  });
  assert.equal(added.dryRun, true);
  assert.deepEqual(added.rules, [{ id: "1166916266197536769", value: "tea", tag: "tea" }]);
  assert.deepEqual(added.summary, { created: 1, not_created: 1 });
  assert.equal(added.errors[0]?.["title"], "DuplicateRule");

  const deleted = await api.deleteStreamRules({
    account,
    ids: ["1166916266197536768"],
    context: context(),
  });
  assert.deepEqual(deleted.rules, []);
  assert.deepEqual(deleted.errors, []);

  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.url.pathname === "/2/tweets/search/stream/rules"));
  assert.ok(requests.every((request) => request.auth === "Bearer app-token"));
  assert.equal(requests[0]?.url.searchParams.get("ids"), "1166916266197536768");
  assert.equal(requests[0]?.url.searchParams.get("max_results"), "10");
  assert.equal(requests[1]?.method, "POST");
  assert.equal(requests[1]?.url.searchParams.get("dry_run"), "true");
  assert.deepEqual(JSON.parse(requests[1]?.body ?? ""), {
    add: [{ value: "tea", tag: "tea" }, { value: "coffee -is:retweet" }],
  });
  assert.equal(requests[2]?.url.searchParams.has("dry_run"), false);
  assert.deepEqual(JSON.parse(requests[2]?.body ?? ""), {
    delete: { ids: ["1166916266197536768"] },
  });
});

it("X stream rule methods validate input and require the app-only token", async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    return Response.json({});
  };
  const api = native(fetch);

  await assert.rejects(
    api.addStreamRules({ account, rules: [], context: context() }),
    /at least one/,
  );
  await assert.rejects(
    api.addStreamRules({ account, rules: [{ value: "x".repeat(2049) }], context: context() }),
    /1-2048/,
  );
  await assert.rejects(
    api.deleteStreamRules({ account, ids: ["not-a-number"], context: context() }),
    /numeric/,
  );
  await assert.rejects(
    api.listStreamRules({ account, limit: 1001, context: context() }),
    /1 through 1000/,
  );
  await assert.rejects(native(fetch, false).listStreamRules({ account, context: context() }), {
    name: "SocialError",
    code: "missing_permission",
  });
  assert.equal(calls, 0);
});

it("X stream rule mutations report dispatched network failures as ambiguous", async () => {
  const api = native(async () => {
    throw new TypeError("socket closed");
  });

  await assert.rejects(
    api.addStreamRules({ account, rules: [{ value: "tea" }], context: context() }),
    { name: "SocialError", code: "ambiguous_outcome" },
  );
});
