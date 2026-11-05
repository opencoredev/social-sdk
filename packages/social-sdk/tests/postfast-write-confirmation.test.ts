/**
 * Every PostFast write is confirmed only by the answer that shows the change: the addressed inbox
 * item or conversation in its new state, the outbound reply item, `postIds` with one usable ID,
 * `deleted: true`, the requested IDs in a bulk delete, or a connect URL. Each row sends exactly
 * one write; every malformed answer is `ambiguous_outcome` with `reconcile-first`.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { postfast } from "../src/cloud/postfast.js";
import { SocialError } from "../src/core/errors.js";
import type { AdapterOperationContext, JsonValue } from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "write-confirmation",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const user = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

function uncertain(error: SocialError): boolean {
  return (
    error instanceof SocialError &&
    error.code === "ambiguous_outcome" &&
    error.retryDisposition.kind === "reconcile-first"
  );
}

function fakePostFast(answer: JsonValue) {
  const writes: string[] = [];

  const adapter = postfast({
    apiKey: "fixture-key",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (method === "GET") return Response.json([]);

      writes.push(`${method} ${url.pathname}`);

      return Response.json(answer);
    },
  });

  return { adapter, writes };
}

type Adapter = ReturnType<typeof fakePostFast>["adapter"];

const unusable: readonly (readonly [string, JsonValue])[] = [
  ["JSON null", null],
  ["array", []],
  ["empty object", {}],
];

const item = (fields: Record<string, JsonValue>) => ({
  id: "item1",
  conversationId: "c1",
  direction: "INBOUND",
  state: "VISIBLE",
  ...fields,
});

const conversation = (fields: Record<string, JsonValue>) => ({
  id: "c1",
  platform: "INSTAGRAM",
  status: "OPEN",
  unreadCount: 0,
  assignedToUserId: null,
  ...fields,
});

interface Write {
  readonly name: string;
  readonly malformed: readonly (readonly [string, JsonValue])[];
  readonly valid: JsonValue;
  readonly send: (adapter: Adapter) => Promise<object | void>;
}

const writes: readonly Write[] = [
  {
    name: "moderateInboxItem",
    malformed: [
      ...unusable,
      ["another item", item({ id: "item2", state: "HIDDEN" })],
      ["unchanged state", item({})],
    ],
    valid: item({ state: "HIDDEN" }),
    send: (adapter) =>
      adapter.native.moderateInboxItem({ itemId: "item1", action: "hide" }, context),
  },
  {
    name: "markInboxRead",
    malformed: [
      ...unusable,
      ["another conversation", conversation({ id: "c2" })],
      ["still unread", conversation({ unreadCount: 3 })],
      ["string count", conversation({ unreadCount: "0" })],
    ],
    valid: conversation({}),
    send: (adapter) => adapter.native.markInboxRead({ conversationId: "c1" }, context),
  },
  {
    name: "setInboxStatus",
    malformed: [
      ...unusable,
      ["another conversation", conversation({ id: "c2", status: "CLOSED" })],
      ["unchanged status", conversation({})],
    ],
    valid: conversation({ status: "CLOSED" }),
    send: (adapter) =>
      adapter.native.setInboxStatus({ conversationId: "c1", status: "CLOSED" }, context),
  },
  {
    name: "assignInboxConversation",
    malformed: [
      ...unusable,
      ["another conversation", conversation({ id: "c2", assignedToUserId: user })],
      ["unassigned", conversation({})],
    ],
    valid: conversation({ assignedToUserId: user }),
    send: (adapter) =>
      adapter.native.assignInboxConversation(
        { conversationId: "c1", assigneeUserId: user },
        context,
      ),
  },
  {
    name: "replyToInboxItem",
    malformed: [
      ...unusable,
      ["inbound item", item({ id: "reply1" })],
      ["blank id", item({ id: " ", direction: "OUTBOUND" })],
      [
        "unknown delivery status",
        item({ id: "reply1", direction: "OUTBOUND", deliveryStatus: "X" }),
      ],
    ],
    valid: item({ id: "reply1", direction: "OUTBOUND", deliveryStatus: "SENT" }),
    send: (adapter) =>
      adapter.native.replyToInboxItem({ itemId: "item1", text: "Thanks" }, context),
  },
  {
    name: "privateReply",
    malformed: [...unusable, ["numeric id", item({ id: 7, direction: "OUTBOUND" })]],
    valid: item({ id: "reply1", direction: "OUTBOUND", deliveryStatus: "PENDING" }),
    send: (adapter) => adapter.native.privateReply({ itemId: "item1", text: "Hi" }, context),
  },
  {
    name: "bulkDelete",
    malformed: [
      ...unusable,
      ["numeric ID", { deletedIds: [1], notFoundIds: [] }],
      ["unrequested ID", { deletedIds: ["p9"], notFoundIds: [] }],
      ["missing notFoundIds", { deletedIds: ["p1"] }],
    ],
    valid: { deletedIds: ["p1"], notFoundIds: ["p2"] },
    send: (adapter) => adapter.native.bulkDelete({ ids: ["p1", "p2"] }, context),
  },
  {
    name: "createConnectLink",
    malformed: [
      ...unusable,
      ["http URL", { connectUrl: "http://app.postfa.st/connect/x" }],
      ["numeric URL", { connectUrl: 7 }],
    ],
    valid: { connectUrl: "https://app.postfa.st/connect/x" },
    send: (adapter) => adapter.native.createConnectLink({}, context),
  },
];

for (const write of writes) {
  for (const [name, answer] of write.malformed)
    it(`PostFast ${write.name}: ${name} is an unconfirmed write`, async () => {
      const { adapter, writes: sent } = fakePostFast(answer);
      await assert.rejects(write.send(adapter), uncertain);
      assert.equal(sent.length, 1);
    });

  it(`PostFast ${write.name}: the documented answer resolves`, async () => {
    const { adapter, writes: sent } = fakePostFast(write.valid);
    await write.send(adapter);
    assert.equal(sent.length, 1);
  });
}
