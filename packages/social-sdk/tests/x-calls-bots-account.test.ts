import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, type AdapterOperationContext } from "../src/index.js";
import type { JsonValue } from "../src/core/types.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "11" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "x-calls-bots-account",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

interface Seen {
  readonly method: string;
  readonly href: string;
  readonly authorization: string | null;
  readonly body: JsonValue | undefined;
}

function fake(routes: Readonly<Record<string, JsonValue>>) {
  const seen: Seen[] = [];

  const adapter = x({
    auth: { userId: "11", accessToken: "user" },
    appBearerToken: "app",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      seen.push({
        method,
        href: url.href,
        authorization: new Headers(init?.headers).get("authorization"),
        body:
          init?.body === undefined || init.body === null
            ? undefined
            : JSON.parse(String(init.body)),
      });

      const route = routes[`${method} ${url.pathname}`];

      return route === undefined
        ? Response.json({ title: "Not Found" }, { status: 404 })
        : Response.json(route);
    },
  });

  assert.ok(adapter.native);

  return { native: adapter.native, seen };
}

const call = { id: "AbC_123", join_url: "https://x.com/i/calls/AbC_123", join_policy: "closed" };

it("creates, joins and leaves an X call at /2/calls", async () => {
  const { native, seen } = fake({
    "POST /2/calls": { data: call },
    "GET /2/calls/AbC_123": { data: { ...call, participant_count: 1 } },
    "POST /2/calls/AbC_123/join": {
      data: { session_id: "s1", media_url: "wss://media.example", media_token: "secret" },
    },
    "POST /2/calls/AbC_123/leave": { data: { left: true } },
  });

  assert.deepEqual(
    await native.createCall({ account, title: "Standup", joinPolicy: "closed", context }),
    call,
  );
  assert.deepEqual(seen[0]?.body, { title: "Standup", join_policy: "closed" });
  assert.equal(seen[0]?.authorization, "Bearer user");

  assert.equal(
    (await native.getCall({ account, callId: "AbC_123", context }))["participant_count"],
    1,
  );

  const session = await native.joinCall({
    account,
    callId: "AbC_123",
    audio: { sampleRate: 16_000 },
    context,
  });

  assert.equal(session["media_url"], "wss://media.example");
  assert.deepEqual(seen[2]?.body, {
    media: { type: "websocket", audio: { encoding: "pcm16", sample_rate: 16_000 } },
  });

  await native.leaveCall({ account, callId: "AbC_123", context });
  assert.equal(new URL(seen[3]?.href ?? "").pathname, "/2/calls/AbC_123/leave");
});

it("schedules, updates, cancels and answers calls at /2/calls/scheduled", async () => {
  const scheduled = { id: "1900000000000000000", title: "Weekly sync" };

  const { native, seen } = fake({
    "GET /2/calls/scheduled": { data: [scheduled], meta: { result_count: 1 } },
    "POST /2/calls/scheduled": { data: scheduled },
    "GET /2/calls/scheduled/1900000000000000000": { data: scheduled },
    "PUT /2/calls/scheduled/1900000000000000000": { data: { updated: true } },
    "DELETE /2/calls/scheduled/1900000000000000000": { data: { cancelled: true } },
    "POST /2/calls/scheduled/1900000000000000000/rsvp": { data: { response: "accepted" } },
  });

  await native.scheduleCall({
    account,
    call: {
      startTime: "2026-11-09T17:00:00Z",
      title: "Weekly sync",
      durationMinutes: 45,
      inviteeIds: ["12", "13"],
      recurrence: "FREQ=WEEKLY;BYDAY=MO",
      timeZone: "America/Los_Angeles",
    },
    context,
  });

  assert.deepEqual(seen[0]?.body, {
    start_time: "2026-11-09T17:00:00Z",
    title: "Weekly sync",
    duration_minutes: 45,
    invitee_ids: ["12", "13"],
    recurrence: "FREQ=WEEKLY;BYDAY=MO",
    time_zone: "America/Los_Angeles",
  });

  assert.equal(
    (
      await native.scheduledCalls({
        account,
        startTime: "2026-11-01T00:00:00Z",
        limit: 10,
        context,
      })
    ).items.length,
    1,
  );
  await native.getScheduledCall({ account, scheduledCallId: "1900000000000000000", context });
  await native.updateScheduledCall({
    account,
    scheduledCallId: "1900000000000000000",
    update: { title: "Moved", scope: "this", occurrenceStartTime: "2026-11-16T17:00:00Z" },
    context,
  });

  assert.deepEqual(seen[3]?.body, {
    title: "Moved",
    scope: "this",
    occurrence_start_time: "2026-11-16T17:00:00Z",
  });

  await native.cancelScheduledCall({
    account,
    scheduledCallId: "1900000000000000000",
    occurrence: { scope: "all" },
    notifyInvitees: false,
    context,
  });

  const cancelUrl = new URL(seen[4]?.href ?? "");

  assert.equal(cancelUrl.searchParams.get("scope"), "all");
  assert.equal(cancelUrl.searchParams.get("notify_invitees"), "false");

  await native.rsvpScheduledCall({
    account,
    scheduledCallId: "1900000000000000000",
    response: "accepted",
    context,
  });
  assert.deepEqual(seen[5]?.body, { response: "accepted" });

  await assert.rejects(native.scheduleCall({ account, call: { startTime: "tomorrow" }, context }), {
    code: "invalid_input",
  });
});

it("manages bot accounts and tokens at /2/bots with the app bearer", async () => {
  const bot = {
    id: "1800000000000000000",
    username: "helper_bot",
    token: "bot-token",
    token_expires_at_ms: 1790000000000,
    scopes: ["dm.read", "dm.write"],
  };

  const { native, seen } = fake({
    "GET /2/bots": { data: [{ id: "1800000000000000000" }], meta: { max_bots: 10 } },
    "POST /2/bots": { data: bot },
    "PUT /2/bots/1800000000000000000": { data: { updated: true } },
    "POST /2/bots/1800000000000000000/token": { data: { ...bot, token: "bot-token-2" } },
    "DELETE /2/bots/1800000000000000000/token": { data: { revoked: true } },
    "DELETE /2/bots/1800000000000000000": { data: { deleted: true } },
  });

  assert.equal((await native.bots({ account, context })).items.length, 1);
  assert.equal(seen[0]?.authorization, "Bearer app");

  const created = await native.createBot({
    account,
    handle: "helper_bot",
    orgOnly: true,
    scopes: ["dm.read", "dm.write"],
    context,
  });

  assert.deepEqual(created, {
    id: "1800000000000000000",
    token: "bot-token",
    username: "helper_bot",
    tokenExpiresAtMs: "1790000000000",
    scopes: ["dm.read", "dm.write"],
  });
  assert.deepEqual(seen[1]?.body, {
    handle: "helper_bot",
    org_only: true,
    scopes: ["dm.read", "dm.write"],
  });

  await native.updateBot({
    account,
    botId: "1800000000000000000",
    dmPermission: "no_one",
    context,
  });
  assert.deepEqual(seen[2]?.body, { dm_permission: "no_one" });

  assert.equal(
    (await native.rotateBotToken({ account, botId: "1800000000000000000", context })).token,
    "bot-token-2",
  );
  await native.revokeBotToken({ account, botId: "1800000000000000000", context });
  await native.deleteBot({ account, botId: "1800000000000000000", context });

  await assert.rejects(native.createBot({ account, handle: "x", context }), {
    code: "invalid_input",
  });
});

it("reads and ensures the developer account at /2/account", async () => {
  const { native, seen } = fake({
    "GET /2/account": { data: { account_id: "acc1", name: "Example" } },
    "POST /2/account": { data: { account_id: "acc1", created: false } },
  });

  assert.equal((await native.developerAccount({ account, context }))["account_id"], "acc1");
  assert.deepEqual(await native.ensureDeveloperAccount({ account, metadata: "pro", context }), {
    accountId: "acc1",
    created: false,
  });
  assert.deepEqual(seen[1]?.body, { metadata: "pro" });
  assert.equal(seen[1]?.authorization, "Bearer user");
});
