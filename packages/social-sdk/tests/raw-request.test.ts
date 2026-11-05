import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  connectedAccountRef,
  createSocial,
  SocialError,
  type AdapterOperationContext,
  type ConnectedAccountRef,
  type JsonValue,
  type RawProviderRequest,
  type RawProviderResponse,
  type RawRequestBody,
} from "../src/index.js";
import { bluesky } from "../src/platforms/bluesky.js";
import { facebook } from "../src/platforms/facebook.js";
import { instagram } from "../src/platforms/instagram.js";
import { linkedin } from "../src/platforms/linkedin.js";
import { threads } from "../src/platforms/threads.js";
import { tiktok } from "../src/platforms/tiktok.js";
import { x } from "../src/platforms/x.js";
import { youtube } from "../src/platforms/youtube.js";
import { buffer } from "../src/cloud/buffer.js";
import { postfast } from "../src/cloud/postfast.js";
import { postForMe } from "../src/cloud/post-for-me.js";
import { postiz } from "../src/cloud/postiz.js";
import { zernioNative } from "../src/cloud/zernio-native.js";
import { zernio } from "../src/cloud/zernio.js";

// Offline contract tests for `native.request` on every adapter (SOC-39). A recording fake fetch
// stands in for each provider; no request leaves the process.

interface Recorded {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
  readonly redirect: RequestRedirect | undefined;
}

type Responder = (url: URL, request: Request) => Response | Promise<Response>;

const json = (body: JsonValue, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

function recorder(respond: Responder = () => json({ ok: true })) {
  const calls: Recorded[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    calls.push({
      url,
      method: request.method,
      headers: request.headers,
      body: await request.clone().text(),
      redirect: init?.redirect,
    });

    return respond(url, request);
  };

  return { calls, fetch };
}

function context(signal?: AbortSignal): AdapterOperationContext {
  const base: AdapterOperationContext = {
    backendInstance: "default",
    correlationId: "raw-request-test",
    retryBudget: { maxAttempts: 3, maxElapsedMs: 5_000 },
  };

  return signal === undefined ? base : { ...base, signal };
}

function nativeOf<T>(adapter: { readonly native?: T }): T {
  assert.ok(adapter.native);

  return adapter.native;
}

async function rejection(work: Promise<RawProviderResponse>): Promise<SocialError> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof SocialError);

    return error;
  }

  assert.fail("Expected the raw request to reject.");
}

type Probe = Omit<RawProviderRequest, "host">;

interface AdapterCase {
  readonly name: string;
  readonly account: ConnectedAccountRef;
  /** Base URL of the default host; probes append `/probe`. */
  readonly base: string;
  /** Credential header name and expected value. */
  readonly credential: readonly [name: string, value: string];
  /** Direct platforms check the account; managed keys are workspace-scoped. */
  readonly checksAccount: boolean;
  readonly send: (
    fetch: typeof globalThis.fetch,
    input: Probe,
    account: ConnectedAccountRef,
    operationContext: AdapterOperationContext,
  ) => Promise<RawProviderResponse>;
}

const ref = (platform: ConnectedAccountRef["platform"], accountId: string) =>
  connectedAccountRef({ backend: "default", platform, accountId });

const directCases: readonly AdapterCase[] = [
  {
    name: "x",
    account: ref("x", "x-user"),
    base: "https://api.x.com",
    credential: ["authorization", "Bearer x-user-token"],
    checksAccount: true,
    send: (fetch, input, account, operationContext) =>
      nativeOf(x({ auth: { userId: "x-user", accessToken: "x-user-token" }, fetch })).request(
        { ...input, account },
        operationContext,
      ),
  },
  {
    name: "bluesky",
    account: ref("bluesky", "did:plc:rawtest"),
    base: "https://pds.example.test",
    credential: ["authorization", "Bearer bluesky-jwt"],
    checksAccount: true,
    send: (fetch, input, account, operationContext) =>
      nativeOf(
        bluesky({
          auth: {
            service: "https://pds.example.test",
            did: "did:plc:rawtest",
            accessJwt: "bluesky-jwt",
          },
          fetch,
        }),
      ).request({ ...input, account }, operationContext),
  },
  {
    name: "facebook",
    account: ref("facebook", "page-1"),
    base: "https://graph.facebook.com/v27.0",
    credential: ["authorization", "Bearer page-token"],
    checksAccount: true,
    send: (fetch, input, account, operationContext) =>
      nativeOf(facebook({ auth: { pageId: "page-1", accessToken: "page-token" }, fetch })).request(
        { ...input, account },
        operationContext,
      ),
  },
  {
    name: "instagram",
    account: ref("instagram", "ig-1"),
    base: "https://graph.instagram.com/v27.0",
    credential: ["authorization", "Bearer ig-token"],
    checksAccount: true,
    send: (fetch, input, account, operationContext) =>
      nativeOf(instagram({ auth: { accountId: "ig-1", accessToken: "ig-token" }, fetch })).request(
        { ...input, account },
        operationContext,
      ),
  },
  {
    name: "threads",
    account: ref("threads", "threads-1"),
    base: "https://graph.threads.net/v1.0",
    credential: ["authorization", "Bearer threads-token"],
    checksAccount: true,
    send: (fetch, input, account, operationContext) =>
      nativeOf(
        threads({ auth: { userId: "threads-1", accessToken: "threads-token" }, fetch }),
      ).request({ ...input, account }, operationContext),
  },
  {
    name: "linkedin",
    account: ref("linkedin", "urn:li:person:raw"),
    base: "https://api.linkedin.com",
    credential: ["authorization", "Bearer linkedin-token"],
    checksAccount: true,
    send: (fetch, input, account, operationContext) =>
      nativeOf(
        linkedin({
          auth: { accessToken: "linkedin-token", author: "urn:li:person:raw" },
          apiVersion: "202609",
          fetch,
        }),
      ).request({ ...input, account }, operationContext),
  },
  {
    name: "tiktok",
    account: ref("tiktok", "open-1"),
    base: "https://open.tiktokapis.com",
    credential: ["authorization", "Bearer tiktok-token"],
    checksAccount: true,
    send: (fetch, input, account, operationContext) =>
      nativeOf(
        tiktok({
          auth: { accessToken: "tiktok-token", openId: "open-1" },
          verifiedMediaOrigins: [],
          fetch,
        }),
      ).request({ ...input, account }, operationContext),
  },
  {
    name: "youtube",
    account: ref("youtube", "channel-1"),
    base: "https://www.googleapis.com/youtube/v3",
    credential: ["authorization", "Bearer youtube-token"],
    checksAccount: true,
    send: (fetch, input, account, operationContext) =>
      nativeOf(
        youtube({ auth: { accessToken: "youtube-token", channelId: "channel-1" }, fetch }),
      ).request({ ...input, account }, operationContext),
  },
];

const workspace = ref("x", "workspace-account");

const managedCases: readonly AdapterCase[] = [
  {
    name: "zernio",
    account: workspace,
    base: "https://zernio.com/api",
    credential: ["authorization", "Bearer zernio-key"],
    checksAccount: false,
    send: (fetch, input, _account, operationContext) =>
      zernioNative({ apiKey: "zernio-key", fetch }).request(input, operationContext),
  },
  {
    name: "post-for-me",
    account: workspace,
    base: "https://api.postforme.dev",
    credential: ["authorization", "Bearer pfm-key"],
    checksAccount: false,
    send: (fetch, input, _account, operationContext) =>
      nativeOf(postForMe({ apiKey: "pfm-key", fetch })).request(input, operationContext),
  },
  {
    name: "postfast",
    account: workspace,
    base: "https://api.postfa.st",
    credential: ["pf-api-key", "postfast-key"],
    checksAccount: false,
    send: (fetch, input, _account, operationContext) =>
      nativeOf(postfast({ apiKey: "postfast-key", fetch })).request(input, operationContext),
  },
  {
    name: "postiz",
    account: workspace,
    base: "https://postiz.example.test/api/public/v1",
    credential: ["authorization", "postiz-key"],
    checksAccount: false,
    send: (fetch, input, _account, operationContext) =>
      nativeOf(
        postiz({
          apiKey: "postiz-key",
          baseUrl: "https://postiz.example.test/api/public/v1",
          fetch,
        }),
      ).request(input, operationContext),
  },
  {
    name: "buffer",
    account: workspace,
    base: "https://api.buffer.com",
    credential: ["authorization", "Bearer buffer-key"],
    checksAccount: false,
    send: (fetch, input, _account, operationContext) =>
      nativeOf(buffer({ apiKey: "buffer-key", fetch })).request(input, operationContext),
  },
];

const escapes: readonly { readonly label: string; readonly input: Probe }[] = [
  { label: "absolute URL", input: { method: "GET", path: "https://evil.example/probe" } },
  { label: "scheme-relative path", input: { method: "GET", path: "//evil.example/probe" } },
  { label: "relative path", input: { method: "GET", path: "evil.example/probe" } },
  { label: "dot segment", input: { method: "GET", path: "/a/../../probe" } },
  { label: "encoded dot segment", input: { method: "GET", path: "/a/%2e%2E/probe" } },
  { label: "encoded slash", input: { method: "GET", path: "/a%2F..%2Fprobe" } },
  { label: "backslash", input: { method: "GET", path: "/\\evil.example/probe" } },
  { label: "query in path", input: { method: "GET", path: "/probe?access_token=x" } },
  { label: "fragment", input: { method: "GET", path: "/probe#x" } },
  { label: "whitespace", input: { method: "GET", path: "/pro be" } },
  { label: "bad percent escape", input: { method: "GET", path: "/probe%zz" } },
  {
    label: "Authorization header",
    input: { method: "GET", path: "/probe", headers: { Authorization: "Bearer stolen" } },
  },
  { label: "Cookie header", input: { method: "GET", path: "/probe", headers: { cookie: "a=b" } } },
  {
    label: "Content-Type header",
    input: { method: "GET", path: "/probe", headers: { "Content-Type": "text/plain" } },
  },
  {
    label: "header injection",
    input: { method: "GET", path: "/probe", headers: { "X-Extra": "a\r\nAuthorization: x" } },
  },
  {
    label: "GET body",
    input: { method: "GET", path: "/probe", body: { kind: "json", value: { a: 1 } } },
  },
  {
    label: "oversized response cap",
    input: { method: "GET", path: "/probe", maxResponseBytes: 17 * 1024 * 1024 },
  },
  {
    label: "set-cookie response header",
    input: { method: "GET", path: "/probe", responseHeaders: ["Set-Cookie"] },
  },
];

for (const adapter of [...directCases, ...managedCases]) {
  describe(`${adapter.name} native.request`, () => {
    it("sends the query to the default host with the adapter's credentials", async () => {
      const { calls, fetch } = recorder(() =>
        json(
          { id: "9007199254740993", ok: true },
          { headers: { "x-request-id": "req-1", "set-cookie": "s=1", "x-app-usage": "{}" } },
        ),
      );

      const response = await adapter.send(
        fetch,
        {
          method: "GET",
          path: "/probe/a%3Ab",
          query: { fields: "id,name", ids: ["1", "2"] },
          headers: { "X-Trace": "t-1" },
          responseHeaders: ["X-App-Usage"],
        },
        adapter.account,
        context(),
      );

      assert.equal(calls.length, 1);
      const [call] = calls;

      assert.ok(call);
      assert.equal(`${call.url.origin}${call.url.pathname}`, `${adapter.base}/probe/a%3Ab`);
      assert.equal(call.url.searchParams.get("fields"), "id,name");
      assert.deepEqual(call.url.searchParams.getAll("ids"), ["1", "2"]);
      assert.equal(call.headers.get(adapter.credential[0]), adapter.credential[1]);
      assert.equal(call.headers.get("x-trace"), "t-1");
      assert.equal(call.redirect, "manual");
      assert.equal(response.status, 200);
      assert.equal(response.responseType, "json");
      assert.deepEqual(response.body, { id: "9007199254740993", ok: true });
      assert.equal(response.headers["x-request-id"], "req-1");
      assert.equal(response.headers["x-app-usage"], "{}");
      assert.equal(response.headers["set-cookie"], undefined);
    });

    it("encodes a JSON body for a write and returns the status", async () => {
      const { calls, fetch } = recorder(() => json({ created: true }, { status: 201 }));

      const response = await adapter.send(
        fetch,
        { method: "POST", path: "/probe", body: { kind: "json", value: { text: "hi", n: 2 } } },
        adapter.account,
        context(),
      );

      assert.equal(calls[0]?.method, "POST");
      assert.equal(calls[0]?.headers.get("content-type"), "application/json");
      assert.deepEqual(JSON.parse(calls[0]?.body ?? ""), { text: "hi", n: 2 });
      assert.equal(response.status, 201);
    });

    it("rejects host escapes and credential overrides before any request", async () => {
      for (const escape of escapes) {
        const { calls, fetch } = recorder();

        const error = await rejection(
          adapter.send(fetch, escape.input, adapter.account, context()),
        );

        assert.equal(error.code, "invalid_input", escape.label);
        assert.equal(calls.length, 0, escape.label);
      }
    });

    // Managed API keys are workspace-scoped, so only direct platforms check the account.
    if (adapter.checksAccount)
      it("rejects an account from another authorization before any request", async () => {
        const { calls, fetch } = recorder();

        const error = await rejection(
          adapter.send(
            fetch,
            { method: "GET", path: "/probe" },
            { ...adapter.account, accountId: "someone-else" },
            context(),
          ),
        );

        assert.equal(error.code, "unauthorized");
        assert.equal(calls.length, 0);
      });

    it("maps provider rejections and keeps failed writes uncertain", async () => {
      const statuses: readonly [number, string, string][] = [
        [401, "GET", "reconnect_required"],
        [403, "GET", "missing_permission"],
        [404, "GET", "not_found"],
        [500, "GET", "upstream_failure"],
        [500, "POST", "ambiguous_outcome"],
        [400, "POST", "upstream_failure"],
      ];

      for (const [status, method, code] of statuses) {
        const { fetch } = recorder(() => json({ error: { message: "secret prose" } }, { status }));

        const error = await rejection(
          adapter.send(
            fetch,
            method === "GET"
              ? { method: "GET", path: "/probe" }
              : { method: "POST", path: "/probe", body: { kind: "json", value: {} } },
            adapter.account,
            context(),
          ),
        );

        assert.equal(error.code, code, `${method} ${status}`);
        assert.equal(error.upstreamStatus, status);
        assert.ok(!error.message.includes("secret prose"));
      }

      const { calls, fetch } = recorder(() =>
        json({}, { status: 429, headers: { "retry-after": "7" } }),
      );

      const limited = await rejection(
        adapter.send(fetch, { method: "GET", path: "/probe" }, adapter.account, context()),
      );

      assert.equal(limited.code, "rate_limited");
      assert.deepEqual(limited.retryDisposition, { kind: "after-delay", delayMs: 7_000 });
      assert.equal(calls.length, 1, "raw requests never retry");
    });

    it("does not follow redirects", async () => {
      const { calls, fetch } = recorder(
        () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
      );

      const read = await rejection(
        adapter.send(fetch, { method: "GET", path: "/probe" }, adapter.account, context()),
      );

      assert.equal(read.code, "upstream_failure");

      const write = await rejection(
        adapter.send(fetch, { method: "DELETE", path: "/probe" }, adapter.account, context()),
      );

      assert.equal(write.code, "ambiguous_outcome");
      assert.equal(calls.length, 2);
      assert.ok(calls.every((call) => call.url.hostname !== "evil.example"));
    });

    it("honors cancellation before and during the request", async () => {
      const aborted = new AbortController();

      aborted.abort();
      const idle = recorder();

      const before = await rejection(
        adapter.send(
          idle.fetch,
          { method: "GET", path: "/probe" },
          adapter.account,
          context(aborted.signal),
        ),
      );

      assert.equal(before.code, "cancelled");
      assert.equal(idle.calls.length, 0);

      for (const [method, code] of [
        ["GET", "cancelled"],
        ["PUT", "ambiguous_outcome"],
      ] as const) {
        const controller = new AbortController();

        const stalled = recorder(
          (_url, request) =>
            new Promise<Response>((_resolve, reject) => {
              request.signal.addEventListener("abort", () => reject(request.signal.reason), {
                once: true,
              });
              controller.abort();
            }),
        );

        const error = await rejection(
          adapter.send(
            stalled.fetch,
            { method, path: "/probe" },
            adapter.account,
            context(controller.signal),
          ),
        );

        assert.equal(error.code, code, method);
        assert.equal(stalled.calls.length, 1);
      }
    });
  });
}

describe("raw request bodies and responses", () => {
  const [first] = directCases;

  assert.ok(first);

  it("encodes text, bytes, URL-encoded and multipart bodies", async () => {
    const { calls, fetch } = recorder(() => new Response(null, { status: 204 }));
    const form = new FormData();

    form.set("field", "value");

    const bodies: readonly [RawRequestBody, string, string][] = [
      [{ kind: "text", value: "plain", contentType: "text/plain" }, "text/plain", "plain"],
      [
        { kind: "bytes", value: new Blob(["raw-bytes"]), contentType: "application/octet-stream" },
        "application/octet-stream",
        "raw-bytes",
      ],
      [
        { kind: "urlencoded", value: { a: "1 2", b: "&" } },
        "application/x-www-form-urlencoded",
        "a=1+2&b=%26",
      ],
    ];

    for (const [body, contentType, text] of bodies) {
      const response = await first.send(
        fetch,
        { method: "POST", path: "/probe", body },
        first.account,
        context(),
      );

      assert.equal(response.status, 204);
      assert.equal(response.body, null);
      assert.equal(calls.at(-1)?.headers.get("content-type"), contentType);
      assert.equal(calls.at(-1)?.body, text);
    }

    await first.send(
      fetch,
      { method: "POST", path: "/probe", body: { kind: "form", value: form } },
      first.account,
      context(),
    );

    assert.match(
      calls.at(-1)?.headers.get("content-type") ?? "",
      /^multipart\/form-data; boundary=/,
    );
    assert.match(calls.at(-1)?.body ?? "", /name="field"\r\n\r\nvalue/);
  });

  it("decodes text and bytes, and bounds the body", async () => {
    const { fetch } = recorder(() => new Response("line one\nline two", { status: 200 }));

    const text = await first.send(
      fetch,
      { method: "GET", path: "/probe", responseType: "text" },
      first.account,
      context(),
    );

    assert.equal(text.responseType, "text");
    assert.equal(text.body, "line one\nline two");

    const bytes = await first.send(
      fetch,
      { method: "GET", path: "/probe", responseType: "bytes" },
      first.account,
      context(),
    );

    assert.equal(bytes.responseType, "bytes");
    assert.ok(bytes.body instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(bytes.body), "line one\nline two");

    const capped = await rejection(
      first.send(
        fetch,
        { method: "GET", path: "/probe", responseType: "text", maxResponseBytes: 4 },
        first.account,
        context(),
      ),
    );

    assert.equal(capped.code, "upstream_failure");

    const notJson = await rejection(
      first.send(fetch, { method: "GET", path: "/probe" }, first.account, context()),
    );

    assert.equal(notJson.code, "upstream_failure");

    const acceptedWrite = await rejection(
      first.send(fetch, { method: "PATCH", path: "/probe" }, first.account, context()),
    );

    assert.equal(acceptedWrite.code, "ambiguous_outcome");
    assert.equal(acceptedWrite.retryDisposition.kind, "reconcile-first");
  });

  it("returns no body for HEAD", async () => {
    const { calls, fetch } = recorder(
      () => new Response(null, { status: 200, headers: { etag: "v1" } }),
    );

    const response = await first.send(
      fetch,
      { method: "HEAD", path: "/probe" },
      first.account,
      context(),
    );

    assert.equal(calls[0]?.method, "HEAD");
    assert.equal(response.body, null);
    assert.equal(response.headers["etag"], "v1");
  });

  it("is reachable through createSocial native access", async () => {
    const { calls, fetch } = recorder();

    const social = createSocial({
      backend: x({ auth: { userId: "x-user", accessToken: "x-user-token" }, fetch }),
    });

    const native = social.native("default", { acknowledgeUnsafe: true });

    assert.ok(native);

    const response = await native.request(
      { account: ref("x", "x-user"), method: "GET", path: "/2/usage/tweets" },
      context(),
    );

    assert.equal(response.status, 200);
    assert.equal(calls[0]?.url.href, "https://api.x.com/2/usage/tweets");
    assert.ok(
      social.capabilities().default.capabilities.some((entry) => entry.operation === "raw.request"),
    );
  });
});

describe("direct platform raw request specifics", () => {
  it("X falls back to the app bearer and maps usage caps", async () => {
    const { calls, fetch } = recorder(() =>
      json({ type: "https://api.x.com/2/problems/usage-capped" }, { status: 429 }),
    );

    const adapter = nativeOf(
      x({ auth: { userId: "x-user" }, appBearerToken: "app-bearer", fetch }),
    );

    const error = await rejection(
      adapter.request(
        { account: ref("x", "x-user"), method: "GET", path: "/2/tweets/search/recent" },
        context(),
      ),
    );

    assert.equal(calls[0]?.headers.get("authorization"), "Bearer app-bearer");
    assert.equal(error.code, "billing_required");

    const none = recorder();

    const missing = await rejection(
      nativeOf(x({ auth: { userId: "x-user" }, fetch: none.fetch })).request(
        { account: ref("x", "x-user"), method: "GET", path: "/2/users/me" },
        context(),
      ),
    );

    assert.equal(missing.code, "missing_permission");
    assert.equal(none.calls.length, 0);
  });

  it("Facebook signs with appsecret_proof, selects video and rupload hosts, and maps code 190", async () => {
    const { calls, fetch } = recorder();

    const adapter = nativeOf(
      facebook({
        auth: { pageId: "page-1", accessToken: "page-token" },
        appSecret: "app-secret",
        fetch,
      }),
    );

    const account = ref("facebook", "page-1");

    await adapter.request({ account, method: "GET", path: "/page-1/insights" }, context());
    await adapter.request(
      { account, host: "video", method: "POST", path: "/page-1/videos" },
      context(),
    );

    await adapter.request(
      { account, host: "rupload", method: "POST", path: "/video-upload/v25.0/123" },
      context(),
    );

    assert.match(calls[0]?.url.searchParams.get("appsecret_proof") ?? "", /^[0-9a-f]{64}$/);
    assert.equal(
      calls[1]?.url.href.split("?")[0],
      "https://graph-video.facebook.com/v27.0/page-1/videos",
    );
    assert.match(calls[1]?.url.searchParams.get("appsecret_proof") ?? "", /^[0-9a-f]{64}$/);
    assert.equal(calls[2]?.url.href, "https://rupload.facebook.com/video-upload/v25.0/123");
    assert.equal(calls[2]?.headers.get("authorization"), "OAuth page-token");

    const forged = await rejection(
      adapter.request(
        { account, method: "GET", path: "/me", query: { appsecret_proof: "forged" } },
        context(),
      ),
    );

    assert.equal(forged.code, "invalid_input");

    const expired = recorder(() => json({ error: { code: 190 } }, { status: 400 }));

    const error = await rejection(
      nativeOf(
        facebook({ auth: { pageId: "page-1", accessToken: "page-token" }, fetch: expired.fetch }),
      ).request({ account, method: "GET", path: "/me" }, context()),
    );

    assert.equal(error.code, "reconnect_required");
  });

  it("Instagram uses the login flavor's Graph host and limits rupload to Facebook Login", async () => {
    const { calls, fetch } = recorder();
    const account = ref("instagram", "ig-1");

    const facebookLogin = nativeOf(
      instagram({
        auth: { accountId: "ig-1", accessToken: "ig-token", flavor: "facebook-login" },
        fetch,
      }),
    );

    await facebookLogin.request({ account, method: "GET", path: "/ig-1/insights" }, context());

    await facebookLogin.request(
      { account, host: "rupload", method: "POST", path: "/ig-api-upload/v26.0/17890" },
      context(),
    );

    assert.equal(calls[0]?.url.href, "https://graph.facebook.com/v27.0/ig-1/insights");
    assert.equal(calls[1]?.url.href, "https://rupload.facebook.com/ig-api-upload/v26.0/17890");
    assert.equal(calls[1]?.headers.get("authorization"), "OAuth ig-token");

    const instagramLogin = recorder();

    const error = await rejection(
      nativeOf(
        instagram({
          auth: { accountId: "ig-1", accessToken: "ig-token" },
          fetch: instagramLogin.fetch,
        }),
      ).request(
        { account, host: "rupload", method: "POST", path: "/ig-api-upload/v26.0/17890" },
        context(),
      ),
    );

    assert.equal(error.code, "invalid_input");
    assert.equal(instagramLogin.calls.length, 0);
  });

  it("Threads maps an invalid token to reconnect_required", async () => {
    const { fetch } = recorder(() => json({ error: { code: 190 } }, { status: 400 }));

    const error = await rejection(
      nativeOf(
        threads({ auth: { userId: "threads-1", accessToken: "threads-token" }, fetch }),
      ).request({ account: ref("threads", "threads-1"), method: "GET", path: "/me" }, context()),
    );

    assert.equal(error.code, "reconnect_required");
  });

  it("LinkedIn adds versioned headers to /rest/ paths unless the caller sets them", async () => {
    const { calls, fetch } = recorder();

    const adapter = nativeOf(
      linkedin({
        auth: { accessToken: "linkedin-token", author: "urn:li:person:raw" },
        apiVersion: "202609",
        fetch,
      }),
    );

    const account = ref("linkedin", "urn:li:person:raw");

    await adapter.request(
      { account, method: "GET", path: "/rest/posts/urn%3Ali%3Ashare%3A1" },
      context(),
    );

    await adapter.request(
      { account, method: "GET", path: "/rest/dmaPosts", headers: { "LinkedIn-Version": "202610" } },
      context(),
    );

    await adapter.request({ account, method: "GET", path: "/v2/userinfo" }, context());

    assert.equal(calls[0]?.headers.get("linkedin-version"), "202609");
    assert.equal(calls[0]?.headers.get("x-restli-protocol-version"), "2.0.0");
    assert.equal(calls[1]?.headers.get("linkedin-version"), "202610");
    assert.equal(calls[2]?.headers.get("linkedin-version"), null);
  });

  it("TikTok maps its error envelope", async () => {
    const { fetch } = recorder(() =>
      json({ error: { code: "scope_not_authorized", message: "prose" } }, { status: 403 }),
    );

    const error = await rejection(
      nativeOf(
        tiktok({
          auth: { accessToken: "tiktok-token", openId: "open-1" },
          verifiedMediaOrigins: [],
          fetch,
        }),
      ).request(
        {
          account: ref("tiktok", "open-1"),
          method: "POST",
          path: "/v2/research/video/query/",
          body: { kind: "json", value: {} },
        },
        context(),
      ),
    );

    assert.equal(error.code, "missing_permission");
    assert.equal(error.upstreamCode, "scope_not_authorized");
    assert.equal(error.upstreamStatus, 403);
    assert.equal(error.operation, "native.request");
  });

  it("YouTube selects upload, analytics and reporting hosts and maps quota errors", async () => {
    const { calls, fetch } = recorder();

    const adapter = nativeOf(
      youtube({ auth: { accessToken: "youtube-token", channelId: "channel-1" }, fetch }),
    );

    const account = ref("youtube", "channel-1");

    await adapter.request(
      { account, host: "upload", method: "POST", path: "/videos", query: { uploadType: "media" } },
      context(),
    );
    await adapter.request(
      { account, host: "analytics", method: "GET", path: "/reports" },
      context(),
    );
    await adapter.request({ account, host: "reporting", method: "GET", path: "/jobs" }, context());

    assert.equal(
      calls[0]?.url.href,
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=media",
    );
    assert.equal(calls[1]?.url.href, "https://youtubeanalytics.googleapis.com/v2/reports");
    assert.equal(calls[2]?.url.href, "https://youtubereporting.googleapis.com/v1/jobs");
    assert.ok(calls.every((call) => call.headers.get("authorization") === "Bearer youtube-token"));

    const quota = recorder(() =>
      json({ error: { errors: [{ reason: "quotaExceeded" }] } }, { status: 403 }),
    );

    const error = await rejection(
      nativeOf(
        youtube({
          auth: { accessToken: "youtube-token", channelId: "channel-1" },
          fetch: quota.fetch,
        }),
      ).request({ account, method: "GET", path: "/search" }, context()),
    );

    assert.equal(error.code, "rate_limited");
    assert.equal(error.upstreamCode, "quotaExceeded");
  });

  it("Bluesky proxies chat, mints video service tokens and uses the OAuth session transport", async () => {
    const { calls, fetch } = recorder((url) =>
      url.pathname === "/xrpc/com.atproto.server.getServiceAuth"
        ? json({ token: "service-token" })
        : json({ ok: true }),
    );

    const account = ref("bluesky", "did:plc:rawtest");

    const adapter = nativeOf(
      bluesky({
        auth: {
          service: "https://pds.example.test",
          did: "did:plc:rawtest",
          accessJwt: "bluesky-jwt",
        },
        fetch,
      }),
    );

    await adapter.request(
      { account, method: "GET", path: "/xrpc/chat.bsky.convo.listConvos" },
      context(),
    );

    await adapter.request(
      { account, host: "video", method: "GET", path: "/xrpc/app.bsky.video.getUploadLimits" },
      context(),
    );

    assert.equal(calls[0]?.headers.get("atproto-proxy"), "did:web:api.bsky.chat#bsky_chat");
    assert.equal(calls[1]?.url.pathname, "/xrpc/com.atproto.server.getServiceAuth");
    assert.equal(calls[1]?.url.searchParams.get("aud"), "did:web:video.bsky.app");
    assert.equal(calls[1]?.url.searchParams.get("lxm"), "app.bsky.video.getUploadLimits");
    assert.equal(calls[2]?.url.href, "https://video.bsky.app/xrpc/app.bsky.video.getUploadLimits");
    assert.equal(calls[2]?.headers.get("authorization"), "Bearer service-token");

    const badVideoPath = await rejection(
      adapter.request({ account, host: "video", method: "GET", path: "/upload" }, context()),
    );

    assert.equal(badVideoPath.code, "invalid_input");
    assert.equal(calls.length, 3);

    const handled: string[] = [];

    const session = nativeOf(
      bluesky({
        auth: { service: "https://pds.example.test", did: "did:plc:rawtest" },
        session: {
          did: "did:plc:rawtest",
          fetchHandler: async (pathname, init) => {
            handled.push(pathname);
            assert.equal(new Headers(init?.headers).get("authorization"), null);

            return json({ ok: true });
          },
        },
        fetch,
      }),
    );

    await session.request(
      {
        account,
        method: "GET",
        path: "/xrpc/app.bsky.actor.getProfile",
        query: { actor: "did:plc:rawtest" },
      },
      context(),
    );

    assert.deepEqual(handled, ["/xrpc/app.bsky.actor.getProfile?actor=did%3Aplc%3Arawtest"]);
  });
});

describe("managed backend raw request specifics", () => {
  it("rejects the PostFast key header and sends no Zernio Idempotency-Key", async () => {
    const postfastCalls = recorder();

    const forged = await rejection(
      nativeOf(postfast({ apiKey: "postfast-key", fetch: postfastCalls.fetch })).request(
        { method: "GET", path: "/social-posts", headers: { "PF-API-KEY": "other" } },
        context(),
      ),
    );

    assert.equal(forged.code, "invalid_input");
    assert.equal(postfastCalls.calls.length, 0);

    const { calls, fetch } = recorder();

    await zernioNative({ apiKey: "zernio-key", fetch }).request(
      { method: "POST", path: "/v1/posts", body: { kind: "json", value: { content: "hi" } } },
      { ...context(), targetIdempotencyKey: "key-1" },
    );

    assert.equal(calls[0]?.headers.get("idempotency-key"), null);
  });

  it("posts Buffer GraphQL to the API root and returns its 200 error body", async () => {
    const { calls, fetch } = recorder(() => json({ errors: [{ message: "x" }], data: null }));

    const response = await nativeOf(buffer({ apiKey: "buffer-key", fetch })).request(
      { method: "POST", path: "/", body: { kind: "json", value: { query: "{ account { id } }" } } },
      context(),
    );

    assert.equal(calls[0]?.url.href, "https://api.buffer.com/");
    assert.deepEqual(response.body, { errors: [{ message: "x" }], data: null });
  });

  it("declares raw.request on every managed backend", () => {
    const fetch = recorder().fetch;

    for (const adapter of [
      zernio({ apiKey: "k", fetch }),
      postForMe({ apiKey: "k", fetch }),
      postfast({ apiKey: "k", fetch }),
      postiz({ apiKey: "k", fetch }),
      buffer({ apiKey: "k", fetch }),
    ])
      assert.ok(
        adapter.capabilities.capabilities.some(
          (entry) =>
            entry.operation === "raw.request" &&
            entry.platform === "*" &&
            "surface" in entry &&
            entry.surface === "native",
        ),
        adapter.id,
      );
  });
});
