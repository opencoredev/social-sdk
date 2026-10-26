import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocialToolkit, defineNativeTool } from "../src/ai/index.js";
import { runCli } from "../src/cli.js";
import {
  createSocial,
  type AuthorizationPolicy,
  type JsonObject,
  type JsonValue,
} from "../src/index.js";
import {
  createMcpHttpHandler,
  createMcpServer,
  serveMcpStdio,
  supportedProtocolVersions,
} from "../src/mcp/index.js";
import { mockBackend } from "../src/testing/index.js";
import { isJsonValue } from "../src/transport/json.js";
import { array, object, string } from "../src/transport/validation.js";

const accountJson = {
  kind: "connected-account",
  version: 1,
  backend: "default",
  platform: "x",
  accountId: "mock-account-1",
};

function parsed(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  assert.ok(isJsonValue(value));

  return object(value);
}

/** Narrows a single (non-batch) response; throws on a batch or no response. */
function reply(response: JsonValue | undefined): JsonObject {
  return object(response ?? null);
}

function rpc(id: number, method: string, params?: JsonObject): JsonObject {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
}

async function* lines(...messages: readonly string[]): AsyncIterable<string> {
  for (const message of messages) yield message;
}

function tenantPolicy(tenant: string, seen: (string | undefined)[]): AuthorizationPolicy {
  return {
    async authorizeTargets({ accounts, context }) {
      seen.push(context.authorization?.tenantId);

      return accounts.map((account) => ({
        account,
        allowed: context.authorization?.tenantId === tenant,
      }));
    },
  };
}

it("MCP server negotiates the lifecycle and lists the toolkit's tools", async () => {
  const toolkit = createSocialToolkit(createSocial({ backend: mockBackend() }));
  const server = createMcpServer(toolkit, { name: "test", version: "1.2.3" });

  const initialized = object(
    reply(await server.handle(rpc(1, "initialize", { protocolVersion: "2025-03-26" })))["result"] ??
      null,
  );

  assert.equal(initialized["protocolVersion"], "2025-03-26");
  assert.deepEqual(initialized["serverInfo"], { name: "test", version: "1.2.3" });
  assert.deepEqual(initialized["capabilities"], { tools: { listChanged: false } });

  const future = object(
    reply(await server.handle(rpc(2, "initialize", { protocolVersion: "2099-01-01" })))["result"] ??
      null,
  );

  assert.equal(future["protocolVersion"], supportedProtocolVersions[0]);
  assert.equal(
    await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    undefined,
  );
  assert.deepEqual(reply(await server.handle(rpc(3, "ping")))["result"], {});

  const listed = array(
    object(reply(await server.handle(rpc(4, "tools/list")))["result"] ?? null)["tools"],
  );

  assert.deepEqual(
    listed.map((tool) => string(object(tool)["name"])),
    toolkit.tools.map((tool) => tool.name),
  );

  const publish = object(listed.find((tool) => object(tool)["name"] === "social_publish") ?? null);
  assert.equal(object(publish["annotations"])["readOnlyHint"], false);
  assert.equal(object(publish["inputSchema"])["type"], "object");
});

it("MCP tools/call returns structured results and protocol errors for bad calls", async () => {
  const backend = mockBackend();
  const server = createMcpServer(createSocialToolkit(createSocial({ backend })));

  const preview = object(
    reply(
      await server.handle(
        rpc(1, "tools/call", {
          name: "social_publish",
          arguments: {
            request: { targets: [{ account: accountJson }], content: { text: "hello" } },
          },
        }),
      ),
    )["result"] ?? null,
  );

  assert.equal(preview["isError"], false);
  assert.equal(object(preview["structuredContent"])["status"], "dry-run");
  assert.equal(object(array(preview["content"])[0])["type"], "text");
  assert.equal(backend.testing.history().length, 0);

  const failed = object(
    reply(
      await server.handle(
        rpc(2, "tools/call", { name: "social_get_account", arguments: { account: {} } }),
      ),
    )["result"] ?? null,
  );

  assert.equal(failed["isError"], true);

  const unknown = object(
    reply(await server.handle(rpc(3, "tools/call", { name: "nope", arguments: {} })))["error"] ??
      null,
  );

  assert.equal(unknown["code"], -32602);

  const badArgs = object(
    reply(await server.handle(rpc(4, "tools/call", { name: "social_doctor", arguments: [] })))[
      "error"
    ] ?? null,
  );

  assert.equal(badArgs["code"], -32602);

  assert.equal(
    object(reply(await server.handle(rpc(5, "resources/list")))["error"] ?? null)["code"],
    -32601,
  );
  assert.equal(object(reply(await server.handle({ id: 6 }))["error"] ?? null)["code"], -32600);
  assert.equal(object(reply(await server.handle([]))["error"] ?? null)["code"], -32600);
});

it("MCP server answers JSON-RPC batches in order and skips notifications", async () => {
  const server = createMcpServer(createSocialToolkit(createSocial({ backend: mockBackend() })));
  const notification = { jsonrpc: "2.0", method: "notifications/initialized" };

  const batch = await server.handle([
    rpc(1, "ping"),
    notification,
    rpc(2, "nope"),
    [rpc(3, "ping")],
  ]);

  assert.ok(Array.isArray(batch));

  assert.deepEqual(
    batch.map((response) => [response["id"], object(response["error"] ?? {})["code"] ?? "ok"]),
    [
      [1, "ok"],
      [2, -32601],
      [null, -32600],
    ],
  );

  assert.equal(await server.handle([notification]), undefined);
});

it("stdio cancellation reaches a request even when every slot is busy", async () => {
  let started = 0;

  const waitsForAbort = defineNativeTool({
    name: "hold",
    description: "Resolves only when cancelled.",
    backend: "default",
    access: "read",
    async run({ signal }) {
      started += 1;
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));

      return { cancelled: signal?.aborted === true };
    },
  });

  const toolkit = createSocialToolkit(createSocial({ backend: mockBackend() }), {
    nativeTools: [waitsForAbort],
    policy: {
      async authorizeTargets({ accounts }) {
        return accounts.map((account) => ({ account, allowed: true }));
      },
    },
  });

  const output: string[] = [];

  const hold = (id: number) =>
    rpc(id, "tools/call", { name: "social_native_hold", arguments: { account: accountJson } });

  const cancel = (id: number) => ({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: id },
  });

  const session = serveMcpStdio(createMcpServer(toolkit), {
    input: lines(
      ...[hold(1), hold(2), cancel(2), cancel(1), rpc(3, "ping")].map(
        (message) => `${JSON.stringify(message)}\n`,
      ),
    ),
    write: (line) => output.push(line),
    maxInFlight: 1,
  });

  const outcome = await Promise.race([
    session.then(() => "finished"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
  ]);

  assert.equal(outcome, "finished");
  assert.equal(started, 1, "the queued request was cancelled before it started");
  assert.deepEqual(
    output.map((line) => parsed(line)["id"]),
    [3],
  );
});

it("stdio batch elements share the in-flight and queue limits", async () => {
  let running = 0;
  let peak = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));

  const held = defineNativeTool({
    name: "held",
    description: "Waits for the test.",
    backend: "default",
    access: "read",
    async run() {
      running += 1;
      peak = Math.max(peak, running);
      await gate;
      running -= 1;

      return { done: true };
    },
  });

  const toolkit = createSocialToolkit(createSocial({ backend: mockBackend() }), {
    nativeTools: [held],
    policy: {
      async authorizeTargets({ accounts }) {
        return accounts.map((account) => ({ account, allowed: true }));
      },
    },
  });

  const call = (id: number) =>
    rpc(id, "tools/call", { name: "social_native_held", arguments: { account: accountJson } });

  const output: JsonValue[] = [];

  const session = serveMcpStdio(createMcpServer(toolkit), {
    input: lines(
      `${JSON.stringify([call(1), call(2), call(3), call(4)])}\n`,
      `${JSON.stringify([call(5)])}\n`,
    ),
    write: (line) => {
      const value: unknown = JSON.parse(line);
      assert.ok(isJsonValue(value));
      output.push(value);

      // The second batch is refused while the first fills both slots and the queue.
      if (output.length === 1) release();
    },
    maxInFlight: 2,
    maxQueued: 2,
  });

  // Without the refusal nothing releases the gate; this keeps a regression from hanging.
  const fallback = setTimeout(release, 2000);
  await session;
  clearTimeout(fallback);

  assert.equal(peak, 2, "no more than maxInFlight batch elements run at once");
  assert.deepEqual(
    output.map((message) => array(message).map((response) => object(response)["id"])),
    [[5], [1, 2, 3, 4]],
  );
  assert.equal(
    object(object(array(output[0] ?? null)[0] ?? null)["error"] ?? null)["code"],
    -32000,
  );
});

it("stdio transport frames split chunks, rejects bad input and drops cancelled responses", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));

  const slow = defineNativeTool({
    name: "slow",
    description: "Waits for the test.",
    backend: "default",
    access: "read",
    async run() {
      await gate;

      return { done: true };
    },
  });

  const toolkit = createSocialToolkit(createSocial({ backend: mockBackend() }), {
    nativeTools: [slow],
    policy: {
      async authorizeTargets({ accounts }) {
        return accounts.map((account) => ({ account, allowed: true }));
      },
    },
  });

  const output: string[] = [];
  const ping = JSON.stringify(rpc(1, "ping"));
  const encoder = new TextEncoder();

  async function* input(): AsyncIterable<Uint8Array | string> {
    yield encoder.encode(ping.slice(0, 10));
    yield `${ping.slice(10)}\n{oops}\n`;
    yield `${"x".repeat(300)}\n`;
    yield `${JSON.stringify(rpc(2, "tools/call", { name: "social_native_slow", arguments: { account: accountJson } }))}\n`;
    yield `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } })}\n`;
    release();
    yield JSON.stringify(rpc(3, "ping"));
  }

  await serveMcpStdio(createMcpServer(toolkit), {
    input: input(),
    write: (line) => output.push(line),
    maxMessageBytes: 256,
  });

  assert.ok(output.every((line) => line.endsWith("\n")));
  const messages = output.map((line) => parsed(line));

  // Requests run concurrently, so compare without assuming completion order.
  assert.deepEqual(messages.map((message) => JSON.stringify(message["id"] ?? null)).sort(), [
    "1",
    "3",
    "null",
    "null",
  ]);

  assert.deepEqual(
    messages
      .flatMap((message) => (message["error"] === undefined ? [] : [object(message["error"])]))
      .map((error) => error["message"])
      .sort(),
    ["Message too large", "Parse error"],
  );
});

it("HTTP transport authenticates, checks origin and framing, and threads tenant context", async () => {
  const seen: (string | undefined)[] = [];
  const backend = mockBackend();
  const policy = tenantPolicy("tenant-a", seen);
  const toolkit = createSocialToolkit(createSocial({ backend, authorization: policy }), { policy });

  const handler = createMcpHttpHandler(createMcpServer(toolkit), {
    allowedOrigins: ["https://app.example"],
    maxBodyBytes: 4096,
    async authorize(request) {
      const token = request.headers.get("authorization");

      if (token === "Bearer a") return { tenantId: "tenant-a" };

      if (token === "Bearer b") return { tenantId: "tenant-b" };

      return null;
    },
  });

  const post = (body: string, headers: Record<string, string> = {}) =>
    handler(
      new Request("https://mcp.example/mcp", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer a",
          ...headers,
        },
      }),
    );

  const call = JSON.stringify(
    rpc(1, "tools/call", { name: "social_get_account", arguments: { account: accountJson } }),
  );

  const allowed = await post(call);
  assert.equal(allowed.status, 200);
  assert.equal(
    object(object(parsed(await allowed.text())["result"])["structuredContent"])["ok"],
    true,
  );

  const denied = await post(call, { authorization: "Bearer b" });
  const deniedResult = object(parsed(await denied.text())["result"]);
  assert.equal(deniedResult["isError"], true);
  assert.deepEqual(seen, ["tenant-a", "tenant-b"]);

  assert.equal((await post(call, { authorization: "" })).status, 401);
  assert.equal((await post(call, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post(call, { origin: "https://app.example" })).status, 200);
  assert.equal((await post(call, { "content-type": "text/plain" })).status, 415);
  assert.equal((await post(call, { "mcp-protocol-version": "1999-01-01" })).status, 400);
  assert.equal((await post("x".repeat(5000))).status, 413);
  assert.equal((await post("{not json")).status, 400);

  const notification = await post(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );

  assert.equal(notification.status, 202);

  const batch = await post(JSON.stringify([rpc(5, "ping"), rpc(6, "ping")]));
  const batchBody: unknown = JSON.parse(await batch.text());
  assert.ok(Array.isArray(batchBody));
  assert.equal(batchBody.length, 2);

  const streamed = await post(JSON.stringify(rpc(2, "ping")), { accept: "text/event-stream" });
  assert.equal(streamed.headers.get("content-type"), "text/event-stream");
  assert.match(await streamed.text(), /^event: message\ndata: \{.*"id":2.*\}\n\n$/);

  const get = await handler(
    new Request("https://mcp.example/mcp", { headers: { authorization: "Bearer a" } }),
  );

  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");

  assert.deepEqual(
    backend.testing.history().map((entry) => entry.operation),
    ["accounts.get", "accounts.get"],
  );
});

it("social-sdk mcp serves offline diagnostics over stdio without printing values", async () => {
  const output: string[] = [];

  const code = await runCli(["mcp", "--adapter", "zernio"], {
    env: { ZERNIO_API_KEY: "" },
    readInput: async () => "",
    write: (text) => output.push(text),
    version: "9.9.9",
    stdin: lines(
      `${JSON.stringify(rpc(1, "initialize", { protocolVersion: "2025-06-18" }))}\n`,
      `${JSON.stringify(rpc(2, "tools/list"))}\n`,
      `${JSON.stringify(rpc(3, "tools/call", { name: "social_doctor", arguments: {} }))}\n`,
      `${JSON.stringify(rpc(4, "tools/call", { name: "social_publish", arguments: {} }))}\n`,
    ),
  });

  assert.equal(code, 0);

  const byId = new Map(
    output.map((line) => parsed(line)).map((message) => [message["id"], message]),
  );

  const [initialized, listed, doctor, publish] = [1, 2, 3, 4].map((id) => byId.get(id));

  assert.equal(object(object(initialized?.["result"] ?? null)["serverInfo"])["version"], "9.9.9");

  assert.deepEqual(
    array(object(listed?.["result"] ?? null)["tools"]).map((tool) => string(object(tool)["name"])),
    ["social_capabilities", "social_doctor", "social_validate", "social_plan_publish"],
  );

  const report = object(object(object(doctor?.["result"] ?? null)["structuredContent"])["data"]);
  assert.equal(report["writes"], "preview");
  assert.equal(report["ok"], false);
  assert.match(string(object(array(report["checks"])[0])["detail"]), /ZERNIO_API_KEY/);
  assert.equal(object(publish?.["error"] ?? null)["code"], -32602);

  const noStdin = await runCli(["mcp"], {
    env: {},
    readInput: async () => "",
    write: () => undefined,
  });

  assert.equal(noStdin, 2);
});
