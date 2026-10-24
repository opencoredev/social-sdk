import { it } from "node:test";
import assert from "node:assert/strict";
import {
  createSocialToolkit,
  defineNativeTool,
  runOpenAIToolCall,
  toAISDKTools,
  toOpenAIChatTools,
  toOpenAIResponsesTools,
  type SocialToolResult,
} from "../src/ai/index.js";
import {
  connectedAccountRef,
  createSocial,
  defineAdapter,
  SocialError,
  type AuthorizationPolicy,
  type JsonObject,
} from "../src/index.js";
import { mockBackend } from "../src/testing/index.js";
import { array, object, string } from "../src/transport/validation.js";

const account = connectedAccountRef({
  backend: "default",
  platform: "x",
  accountId: "mock-account-1",
});

const accountJson = {
  kind: "connected-account",
  version: 1,
  backend: "default",
  platform: "x",
  accountId: "mock-account-1",
};

const secretText = "private draft text";

const publishArgs = {
  request: {
    targets: [{ account: accountJson }],
    content: { text: secretText },
    idempotencyKey: "launch-1",
  },
};

const comment = {
  kind: "comment",
  version: 1,
  backend: "default",
  platform: "x",
  accountId: "mock-account-1",
  postId: "p1",
  commentId: "comment-1",
};

/** Allows only `tenant`, recording each tenant and operation the policy saw. */
function tenantPolicy(
  tenant: string,
  seen: { operation: string; tenantId: string | undefined }[] = [],
): AuthorizationPolicy {
  return {
    async authorizeTargets({ operation, accounts, context }) {
      seen.push({ operation, tenantId: context.authorization?.tenantId });

      return accounts.map((item) => ({
        account: item,
        allowed: context.authorization?.tenantId === tenant,
      }));
    },
  };
}

function data(result: SocialToolResult): JsonObject {
  assert.equal(result.ok, true, JSON.stringify(result));

  if (!result.ok) throw new Error("expected success");

  return object(result.data);
}

it("registers only tools whose operations a configured backend declares available", () => {
  const full = createSocialToolkit(createSocial({ backend: mockBackend() }));
  const names = new Set<string>(full.tools.map((tool) => tool.name));

  for (const name of ["social_capabilities", "social_publish", "social_send_message"])
    assert.ok(names.has(name), name);

  const base = mockBackend();

  assert.ok(base.posts);

  const postsOnly = defineAdapter({
    id: "posts-only",
    posts: base.posts,
    capabilities: {
      ...base.capabilities,
      capabilities: base.capabilities.capabilities.filter(
        (declaration) => declaration.operation === "posts.publish",
      ),
    },
  });

  const limited = new Set<string>(
    createSocialToolkit(createSocial({ backend: postsOnly })).tools.map((tool) => tool.name),
  );

  assert.ok(limited.has("social_publish"));

  for (const hidden of ["social_send_message", "social_list_comments", "social_list_accounts"])
    assert.ok(!limited.has(hidden), hidden);

  const allowlisted = createSocialToolkit(createSocial({ backend: mockBackend() }), {
    tools: ["social_capabilities", "social_validate"],
  });

  assert.deepEqual(
    allowlisted.tools.map((tool) => tool.name),
    ["social_capabilities", "social_validate"],
  );
});

it("every tool schema is a portable object schema with an OpenAI-safe name", () => {
  const toolkit = createSocialToolkit(createSocial({ backend: mockBackend() }));

  for (const tool of toolkit.tools) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(tool.inputSchema["type"], "object");
    assert.ok(!JSON.stringify(tool.inputSchema).includes('"$ref"'));
    assert.equal(tool.annotations.readOnlyHint, tool.access !== "write");

    if (tool.access === "write") assert.ok(object(tool.inputSchema["properties"])["confirmWrite"]);
  }
});

it("publish returns a dry run without confirmWrite and dispatches nothing", async () => {
  const backend = mockBackend();
  const toolkit = createSocialToolkit(createSocial({ backend }));
  const result = await toolkit.call("social_publish", publishArgs);

  assert.equal(result.ok && result.status, "dry-run");
  assert.ok(!JSON.stringify(result).includes(secretText), "previews never echo post text");
  assert.equal(backend.testing.history().length, 0);

  const preparation = object(data(result)["preparation"]);
  assert.equal(preparation["ok"], true);
  assert.equal(object(array(preparation["targets"])[0])["textLength"], secretText.length);
});

it("publish executes only with confirmWrite and an idempotency key", async () => {
  const backend = mockBackend();
  const toolkit = createSocialToolkit(createSocial({ backend }));

  const { idempotencyKey, ...withoutKey } = publishArgs.request;
  assert.equal(idempotencyKey, "launch-1");

  const missingKey = await toolkit.call("social_publish", {
    request: withoutKey,
    confirmWrite: true,
  });

  assert.equal(missingKey.ok, false);
  assert.equal(!missingKey.ok && missingKey.error.code, "invalid_input");
  assert.equal(backend.testing.history().length, 0);

  const executed = await toolkit.call("social_publish", { ...publishArgs, confirmWrite: true });

  assert.equal(executed.ok && executed.status, "completed");
  assert.equal(object(array(data(executed)["outcomes"])[0])["state"], "published");

  assert.deepEqual(
    backend.testing.history().map((entry) => entry.operation),
    ["posts.publishTarget"],
  );
});

it("preview mode never writes and allow mode writes without confirmation", async () => {
  const previewBackend = mockBackend();

  const preview = createSocialToolkit(createSocial({ backend: previewBackend }), {
    writes: "preview",
  });

  const previewed = await preview.call("social_reply_comment", {
    comment,
    text: "thanks",
    confirmWrite: true,
  });

  assert.equal(previewed.ok && previewed.status, "dry-run");
  assert.equal(previewBackend.testing.history().length, 0);

  const allowBackend = mockBackend();
  const allow = createSocialToolkit(createSocial({ backend: allowBackend }), { writes: "allow" });
  const sent = await allow.call("social_reply_comment", { comment, text: "thanks" });

  assert.equal(sent.ok && sent.status, "completed");

  assert.deepEqual(
    allowBackend.testing.history().map((entry) => entry.operation),
    ["comments.reply"],
  );
});

it("threads the caller's authorization context into the client policy for every call", async () => {
  const seen: { operation: string; tenantId: string | undefined }[] = [];
  const backend = mockBackend();
  const policy = tenantPolicy("tenant-a", seen);
  const social = createSocial({ backend, authorization: policy });

  const toolkit = createSocialToolkit(social, {
    policy,
    authorization: { tenantId: "tenant-b" },
  });

  const denied = await toolkit.call("social_get_account", { account: accountJson });

  assert.equal(denied.ok, false);
  assert.equal(!denied.ok && denied.error.code, "unauthorized");

  const allowed = await toolkit.call(
    "social_get_account",
    { account: accountJson },
    { authorization: { tenantId: "tenant-a" } },
  );

  assert.equal(allowed.ok, true);

  const blockedWrite = await toolkit.call(
    "social_send_message",
    {
      conversation: { ...accountJson, kind: "conversation", conversationId: "c1" },
      text: "hello",
      confirmWrite: true,
    },
    { authorization: { tenantId: "tenant-b" } },
  );

  assert.equal(!blockedWrite.ok && blockedWrite.error.code, "unauthorized");

  assert.deepEqual(
    seen.map((entry) => entry.tenantId),
    ["tenant-b", "tenant-a", "tenant-b"],
  );

  assert.deepEqual(
    backend.testing.history().map((entry) => entry.operation),
    ["accounts.get"],
  );
});

it("plans report capability and tenant decisions without sending anything", async () => {
  const backend = mockBackend();
  const policy = tenantPolicy("tenant-a");
  const social = createSocial({ backend, authorization: policy });
  const toolkit = createSocialToolkit(social, { policy });

  const plan = data(
    await toolkit.call("social_plan_publish", publishArgs, {
      authorization: { tenantId: "tenant-c" },
    }),
  );

  const target = object(array(plan["targets"])[0]);

  assert.equal(target["authorization"], "denied");
  assert.equal(object(target["capability"])["availability"], "available");
  assert.equal(plan["executable"], false);
  assert.equal(plan["requiresConfirmation"], true);
  assert.equal(backend.testing.history().length, 0);
});

it("validate reports adapter issues and rejects malformed arguments by path", async () => {
  const toolkit = createSocialToolkit(createSocial({ backend: mockBackend() }));

  const empty = data(
    await toolkit.call("social_validate", { request: { targets: [], content: {} } }),
  );

  assert.equal(empty["ok"], false);

  assert.deepEqual(
    array(empty["issues"]).map((issue) => string(object(issue)["code"])),
    ["targets.required", "content.required"],
  );

  const malformed = await toolkit.call("social_get_account", {
    account: { ...accountJson, accountId: 42 },
  });

  assert.equal(!malformed.ok && malformed.error.code, "invalid_input");
  assert.match(!malformed.ok ? malformed.error.message : "", /account\.accountId/);

  const unknown = await toolkit.call("social_missing", {});
  assert.equal(!unknown.ok && unknown.error.code, "invalid_input");
});

it("caps agent page sizes and hides unexpected adapter error details", async () => {
  const base = mockBackend();
  const limits: (number | undefined)[] = [];
  const { posts, comments } = base;

  assert.ok(posts && comments);

  const adapter = defineAdapter({
    ...base,
    posts: {
      ...posts,
      async list(_account, input) {
        limits.push(input.limit);

        return { items: [] };
      },
    },
    comments: {
      ...comments,
      async list() {
        throw new Error("token=leaked-secret");
      },
    },
  });

  const toolkit = createSocialToolkit(createSocial({ backend: adapter }), { maxPageSize: 25 });

  data(await toolkit.call("social_list_posts", { account: accountJson, limit: 500 }));
  data(await toolkit.call("social_list_posts", { account: accountJson }));
  data(await toolkit.call("social_list_posts", { account: accountJson, limit: 5 }));
  assert.deepEqual(limits, [25, 25, 5]);

  const failed = await toolkit.call("social_list_comments", {
    post: { ...accountJson, kind: "platform-post", postId: "p1" },
  });

  assert.equal(failed.ok, false);
  assert.ok(!JSON.stringify(failed).includes("leaked-secret"));
});

it("enforces call and write budgets", async () => {
  const toolkit = createSocialToolkit(createSocial({ backend: mockBackend() }), {
    writes: "allow",
    limits: { maxCalls: 3, maxWrites: 1 },
  });

  const reply = { comment, text: "thanks" };
  assert.equal((await toolkit.call("social_reply_comment", reply)).ok, true);

  const second = await toolkit.call("social_reply_comment", reply);
  assert.equal(!second.ok && second.error.code, "rate_limited");

  assert.equal((await toolkit.call("social_doctor", {})).ok, true);

  const third = await toolkit.call("social_doctor", {});
  assert.equal(!third.ok && third.error.code, "rate_limited");
});

it("native tools require a policy and pass through authorization, confirmation and limits", async () => {
  const social = createSocial({ backend: mockBackend() });
  let calls = 0;
  let active = 0;
  let maxActive = 0;

  const action = defineNativeTool({
    name: "boost",
    description: "Boost a post natively.",
    backend: "default",
    access: "write",
    async run({ account: target, args }) {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;

      return { accountId: target.accountId, echoed: args["level"] ?? null };
    },
  });

  assert.throws(
    () => createSocialToolkit(social, { nativeTools: [action] }),
    (error: Error) => error instanceof SocialError && error.code === "invalid_config",
  );

  const toolkit = createSocialToolkit(social, {
    nativeTools: [action],
    policy: tenantPolicy("tenant-a"),
    nativeConcurrency: 1,
  });

  assert.ok(toolkit.tools.some((tool) => tool.name === "social_native_boost"));
  const unconfirmed = { account: accountJson, args: { level: 2 } };
  const args = { ...unconfirmed, confirmWrite: true };

  const denied = await toolkit.call("social_native_boost", args, {
    authorization: { tenantId: "tenant-b" },
  });

  assert.equal(!denied.ok && denied.error.code, "unauthorized");

  const preview = await toolkit.call("social_native_boost", unconfirmed, {
    authorization: { tenantId: "tenant-a" },
  });

  assert.equal(preview.ok && preview.status, "dry-run");

  const wrongBackend = await toolkit.call(
    "social_native_boost",
    { ...args, account: { ...accountJson, backend: "other" } },
    { authorization: { tenantId: "tenant-a" } },
  );

  assert.equal(!wrongBackend.ok && wrongBackend.error.code, "invalid_input");
  assert.equal(calls, 0);

  const results = await Promise.all(
    [1, 2].map(() =>
      toolkit.call("social_native_boost", args, { authorization: { tenantId: "tenant-a" } }),
    ),
  );

  assert.ok(results.every((result) => result.ok && result.status === "completed"));
  assert.equal(data(results[0]!)["echoed"], 2);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});

it("OpenAI and AI SDK adapters expose the same tools and route calls through the toolkit", async () => {
  const backend = mockBackend();
  const toolkit = createSocialToolkit(createSocial({ backend }));
  const chat = toOpenAIChatTools(toolkit);
  const responses = toOpenAIResponsesTools(toolkit);

  assert.equal(chat.length, toolkit.tools.length);
  assert.equal(chat[0]?.function.name, toolkit.tools[0]?.name);
  assert.equal(responses[0]?.strict, false);

  const output = JSON.parse(
    await runOpenAIToolCall(toolkit, {
      name: "social_publish",
      arguments: JSON.stringify(publishArgs),
    }),
  );

  assert.equal(output.status, "dry-run");

  const broken = JSON.parse(
    await runOpenAIToolCall(toolkit, { name: "social_publish", arguments: "{not json" }),
  );

  assert.equal(broken.error.code, "invalid_input");

  const tools = toAISDKTools(toolkit, { authorization: { tenantId: "tenant-a" } });
  const publish = tools["social_publish"];

  assert.ok(publish);
  const standard = publish.inputSchema["~standard"];

  assert.equal(standard.version, 1);
  assert.deepEqual(
    standard.jsonSchema.input({ target: "draft-07" }),
    toolkit.tools.find((tool) => tool.name === "social_publish")?.inputSchema,
  );
  assert.ok("value" in standard.validate({ request: {} }));
  assert.ok("issues" in standard.validate("not an object"));

  const aborted = new AbortController();
  aborted.abort();

  const cancelled = await tools["social_get_account"]!.execute(
    { account: accountJson },
    { abortSignal: aborted.signal },
  );

  assert.equal(!cancelled.ok && cancelled.error.code, "cancelled");
  assert.equal(backend.testing.history().length, 0);
  assert.equal(account.accountId, "mock-account-1");
});
